# @maiteuxzanela/ensemble-room-lowcost

**OpenCode Ensemble Hardened — Low-cost multi-agent runtime with native standby, silent lead, and deterministic board wake.**

Runtime de times multi-agente para o [OpenCode](https://opencode.ai) derivado do `@hueyexe/opencode-ensemble@0.18.0`, endurecido (`0.18.1`) para operação de baixo custo em tokens: colegas nascem em **standby** (zero tokens ao nascer), o **lead permanece em repouso passivo absoluto** e só acorda por um único evento determinístico — o **fechamento total do board** (`completed === total`).

| | |
|---|---|
| Pacote | `@maiteuxzanela/ensemble-room-lowcost` |
| Versão | `0.18.1` (base upstream: `@hueyexe/opencode-ensemble@0.18.0`) |
| Entrypoint runtime | `dist/index.js` (bundle autocontido) |
| Entrypoint fonte | `src/index.ts` (`exports["."]`) |
| Remote | `git@github.com:maiteuxzanela/ensemble-room-lowcost.git` (branch `main`) |
| Licença | MIT |
| Suítes | `node tests/run_all.mjs` → **326 checks determinísticos, sem mocks** |

---

## 1. Arquitetura

```text
┌──────────────────────────────────────────────────────────────────────┐
│ OpenCode (host) — carrega dist/index.js via opencode.json "plugin"   │
└───────────────────────────────┬──────────────────────────────────────┘
                                │  plugin hooks (tool.execute / chat.message …)
┌───────────────────────────────▼──────────────────────────────────────┐
│ src/index.ts  — orquestração V1/V2, wiring de tools, hooks e timers  │
│   ├── src/tools/*          15 tools team_* (create/spawn/message/    │
│   │                        broadcast/claim/tasks/view/results/…)     │
│   ├── src/hooks.ts         shouldNudgeIdleMember,                    │
│   │                        shouldAlarmFastIdle,                      │
│   │                        hasBlockedAssignedTasks                   │
│   ├── src/system-prompt.ts buildLeadSystemPrompt /                   │
│   │                        buildTeammateSystemPrompt +               │
│   │                        leadReportDirective (coerção condicional) │
│   ├── src/watchdog.ts      Watchdog.check + isSessionCompacting       │
│   ├── src/progress.ts      ProgressTracker (heartbeat de progresso)  │
│   ├── src/schema.ts        createDb + MIGRATIONS (12 migrações)      │
│   ├── src/messaging.ts     fila team_message (delivered 0/1)         │
│   ├── src/config.ts        ensemble.json (silentLead, stall*, dash)  │
│   ├── src/recovery.ts      reidratação pós-restart / mensagens não   │
│   │                        entregues / worktrees órfãos              │
│   └── src/dashboard*.ts    dashboard HTTP em :4747                   │
└───────────────────────────────┬──────────────────────────────────────┘
                                │ SQLite real (node:sqlite)
┌───────────────────────────────▼──────────────────────────────────────┐
│ ensemble.db — team, team_member (execution_status), team_task,       │
│               team_message (delivered), team_member_message …        │
│ ~/.local/share/opencode/opencode.db — store de sessões (read-only,   │
│               fonte do schema `session` e de session.time_compacting)│
└──────────────────────────────────────────────────────────────────────┘
```

**Princípios de transporte**

1. **Um único canal de wakeup por papel.** Para colegas, `promptAsync` é o transporte; para o lead com `silentLead: true`, a **linha SQLite é a entrega** e o system prompt é o renderizador (`buildLeadSystemPrompt` marca `delivered = 1`).
2. **Estado é schema, não convenção.** Ciclo de vida (`idle → standby → starting → running → …`) vive no `CHECK` de `team_member.execution_status`; transições são `UPDATE` guardados (`WHERE execution_status = …`), garantindo um único consumidor.
3. **Nada de polling.** Wake do lead é exclusivamente event-driven (fechamento de board); watchdog é um tick único com TTL, não um loop de varredura.

---

## 2. As 5 grandes melhorias sobre o pacote original

### 2.1 Spawn em Standby — zero tokens ao nascer, guarda idempotente de despertar

**Problema.** Em `team_spawn`, o prompt de init era enviado na criação da sessão: cada colega nascia queimando tokens antes de qualquer trabalho real — impeditivo para mesas de baixo custo.

**Solução** (`src/tools/team-spawn.ts`, `src/tools/team-message.ts`, `src/tools/team-broadcast.ts`):

- `standby: true` registra o membro **sem** enviar prompt. A sessão nasce em `execution_status = 'standby'` e o prompt completo é persistido em `team_member.spawn_context` (**Migration 11**).
- O **primeiro** `team_message`/`team_broadcast` destinado ao membro é o acordador: o texto de entrega recebe o `spawn_context` **prependado** e a transição `standby → starting` acontece via `UPDATE … WHERE execution_status = 'standby'` — **guarda idempotente de um-só-consumidor**: duas mensagens simultâneas não duplicam o init.
- **Fail-safe**: se o `promptAsync` do wake falhar, o hook devolve a janela (`execution_status` volta a `'standby'`) para que uma retentativa ou a passada de recuperação de mensagens não entregues replayer o `spawn_context` em vez de um prompt vazio.
- Nenhuma mensagem perdida: mensagens que chegam antes do wake ficam na fila e entram no mesmo turno.

**Garantia:** `tests/test_standby_lifecycle.mjs` (122 checks) — nascer em standby sem prompt, wake exatamente 1×, revert em falha de transporte, retentativas `retry_until` concluindo `standby → starting`.

### 2.2 Migration 12 — `standby` formal no CHECK constraint via rebuild seguro

**Problema.** `team_member.execution_status` é um `CHECK` com literais fixos. SQLite **não permite `ALTER` de CHECK**: um banco montado do zero rejeitaria o `INSERT` em standby com erro de constraint (o banco vivo só funcionava porque carregava o literal fora de banda).

**Solução** (`src/schema.ts`, Migration 12):

- Rebuild no padrão já consolidado pela Migration 8: `RENAME → CREATE → copiar → DROP`, carregando **todas** as colunas adicionadas pelas Migrations 3–11 (`worktree_*`, `plan_approval`, `workspace_id`, `reported_to_lead`, `last_nudged_at`, `retry_*`, `spawn_context`) e **recriando os dois índices** que morrem junto com a tabela antiga.
- O novo `CHECK` passa a aceitar `'standby'` entre os literais (`idle, starting, running, cancel_requested, cancelling, cancelled, completing, completed, failed, timed_out, standby`).
- Executa em transação única no fluxo de `createDb`, portanto é **idempotente e atômica**: upgrade de banco legado e bootstrap limpo convergem para o mesmo schema.

**Garantia:** as três suítes aplicam o `MIGRATIONS` real num SQLite real (fresh e upgrade de banco de produção) e verificam contagem/paridade `src ↔ dist`.

### 2.3 Blindagem de Hooks — fim dos falsos nudges e do alarme fast-idle em standby/bloqueio

**Problema.** Dois gatilhos não sabiam nada do standby e do trabalho bloqueado:

1. o nudge de idle mandava prompt para colega recém-criado que **não deveria ter recebido prompt algum** (queimando tokens e poluindo a sessão);
2. o alarme `fast-idle` gritava "agente caiu" para quem estava legitimamente parado (standby ou com task bloqueada por dependência).

**Solução** (`src/hooks.ts`, exportada por `src/index.ts`):

- `shouldNudgeIdleMember(db, teamId, member)` → `false` quando `execution_status === 'standby'` (e demais estados de bloqueio já cobertos), além da janela clássica de `last_nudged_at`.
- `shouldAlarmFastIdle(...)` → `false` para `standby`, preservando o alarme apenas para idle genuíno. A lógica foi **extraída do bloco inline do bundle** para seam testável sem tocar em decisão.
- `hasBlockedAssignedTasks(...)` mantém o bloqueio legítimo visível para o nudge de equipe, sem alarme falso.

**Garantia:** `test_standby_lifecycle.mjs` conta **zero alarmes fast-idle falsos** ao longo da suíte inteira (check `D12`) e exercita nudge em paralelo com wake.

### 2.4 Watchdog Heartbeat & Compaction Immunity — sem timeout indevido durante compactação

**Problema.** O watchdog derruba sessões por TTL (`stallThresholdMs`, default 300 s). Sessões em **compactação** (contexto longo) não progridem em `time_updated` e eram abortadas como "stale" — timeout indevido, perda de contexto e retrabalho caro.

**Solução** (`src/watchdog.ts`, `src/progress.ts`):

- **Heartbeat ativo:** na checagem, membro stale cuja sessão mostra progresso real (`ProgressTracker`) tem `time_updated` **renovado** — continua "busy" sem abortar (`watchdog:heartbeat:renewed`).
- **Imunidade a compaction:** `isSessionCompacting(sessionId)` lê `session.time_compacting` do store do OpenCode **read-only**; se `> 0`, a sessão não é abortada neste tick e é reavaliada no próximo (`watchdog:heartbeat:compacting`).
- Compaction com valor `0` **não** goza da imunidade (corrida decidida corretamente); sessões genuinamente idle continuam transicionando para `error/timed_out` com aviso ao lead, toast e limpeza de worktree.
- `ttlMs = 0` desliga o TTL mantendo o GC de worktrees; resiliência a store ausente/corrompido retorna `false` sem exceção.

**Garantia:** `tests/test_watchdog_heartbeat.mjs` (53 checks) — 4 cenários (active, compacting, idle, compaction=0) rodados **tanto contra `dist` quanto contra `src`**, com store `session` real extraído do `opencode.db` de produção.

### 2.5 Silent Lead & Despertador Sistemático por Board — repouso passivo absoluto do lead

**Problema.** Cada `team_message` destinada ao lead disparava `promptAsync` na sessão do lead: o orquestrador acordava dezenas de vezes por turno, multiplicando tokens e quebrando a regra de "polling proibido / lead mudo".

**Solução** (`src/tools/team-message.ts`, `src/tools/team-tasks-complete.ts`, `src/system-prompt.ts`, `src/config.ts`):

- **`silentLead` (default `true`)**: mensagens ao lead são **persistidas** (`delivered = 0`) e **nenhum** `promptAsync` é disparado. O canal de entrega real passa a ser `buildLeadSystemPrompt`, que injeta o acúmulo na **próxima** chamada legítima do lead e marca `delivered = 1`. Resultado: tokens de wake = **zero** enquanto o lead está em repouso.
- **`silentLead: false` (legado)**: comportamento original byte-a-byte — um único `promptAsync` com `[System: New team message from <remetente>]` e `synthetic: true`.
- **Coerção condicional no system prompt**: com `silentLead` ativo a directiva agressiva
  `"You MUST send your results to the lead via team_message before stopping."` é substituída por
  `"Collaborate with teammates using team_message and complete assigned tasks on the board."`
  (`leadReportDirective`); no legado, o texto é preservado integralmente.
- **Despertador sistemático por board** (`team_tasks_complete`): quando `total > 0 && completed === total`, o lead recebe **exatamente 1×** `[System: All team tasks completed on board by <who>]` com `synthetic: true`. Esse é o **único** evento de wake automático do lead — ou seja, o despertar é 100 % sistemático, nunca por conteúdo textual.
- Fail-safe: falha de transporte no wake é absorvida por `.catch` (zero `unhandledRejection`), e task sem `assignee` é atribuída atomicamente ao autor para o board não mentir.

**Garantia:** `tests/test_silent_lead_board_wake.mjs` (151 checks) — fila `delivered=0` sem wake, wake único no fechamento do board, coerção condicional, legado byte-a-byte, regressão zero das suítes 1 e 2.

---

## 3. Suítes determinísticas (anti-mock, fail-fast)

| Suíte | Escopo | Checks |
|---|---|---|
| `tests/test_watchdog_heartbeat.mjs` | Heartbeat + imunidade a compaction (dist e src) | 53 |
| `tests/test_standby_lifecycle.mjs` | Standby lifecycle + blindagem de nudge/fast-idle (dist e src) + regressão watchdog | 122 |
| `tests/test_silent_lead_board_wake.mjs` | Silent lead + board wake + regressão das duas suítes acima | 151 |
| **Total (somatório top-level)** | **`node tests/run_all.mjs`** | **326** |

```bash
node --check dist/index.js     # ou: npm run check   → exit 0
node tests/run_all.mjs         # ou: npm test        → exit 0 / RESULT_ALL: ALL SUITES PASSED
```

Relatório consolidado do runner:

```text
PASS | test_watchdog_heartbeat.mjs        | exit=0 |   377 ms | RESULT: 53/53 checks passed
PASS | test_standby_lifecycle.mjs         | exit=0 |  1012 ms | RESULT: 122/122 checks passed
PASS | test_silent_lead_board_wake.mjs    | exit=0 |  2169 ms | RESULT: 151/151 checks passed
SUÍTES: 3/3 passaram
RESULT_ALL: ALL SUITES PASSED
```

**Regras das suítes**

- **Zero mocks / stubs / fixtures falsas.** O único ponto de emenda é o **transporte de saída** (`session.create`, `promptAsync`, `session.abort`, `showToast`), gravado num array para que a asserção prove *o que foi chamado*. Nenhuma lógica de decisão é substituída.
- Código sob teste é o **real** deste repositório: `dist/index.js` (bundle) e os `.ts` de `src/` copiados para fora de `node_modules` (o *type-stripping* do Node recusa imports a partir de `node_modules`) apenas com resolução mecânica de extensão de import — lógica intacta.
- Bancos **SQLite reais** (`node:sqlite`) criados isoladamente em `.test-scratch/` (gitignore, recriado a cada execução).
- `test_watchdog_heartbeat.mjs` usa o schema da tabela `session` extraído **read-only** de `~/.local/share/opencode/opencode.db` — **pré-requisito de ambiente** (falha explícita e visível se ausente; nenhum stub é usado no lugar).
- `ENSEMBLE_PKG=/caminho/para/outro/checkout node tests/…` aponta as suítes para outra árvore sem editar arquivo (útil para auditar o pacote publicado em `~/.cache/opencode/packages/`).

---

## 4. Instalação e configuração

```bash
git clone git@github.com:maiteuxzanela/ensemble-room-lowcost.git
cd ensemble-room-lowcost
npm run check && npm test
```

Referência no `~/.config/opencode/opencode.json`:

```jsonc
{
  "plugin": ["/mnt/94CCB337CCB3130A/ensemble-room-lowcost/dist/index.js"]
}
```

Flags relevantes em `~/.config/opencode/ensemble.json` (`src/config.ts`):

| Flag | Default | Efeito |
|---|---|---|
| `silentLead` | `true` | Lead em repouso: entregas via SQLite/system prompt, sem `promptAsync`; wake só no fechamento do board |
| `stallThresholdMs` | `300000` | TTL do watchdog; `0` desliga o TTL (GC de worktree continua) |
| `stallMinSteps` | `5` | Mínimo de passos antes de considerar stall |
| `dashboardPort` | `4747` | Dashboard HTTP (`0` desliga) |

Spawn em standby:

```text
team_spawn({ name: "clara", agent: "build", prompt: "…", claim_task: "<id>", standby: true })
```

---

## 5. Notas de proveniência

- Fonte base: `~/.cache/opencode/packages/@hueyexe/opencode-ensemble@0.18.0/node_modules/@hueyexe/opencode-ensemble/` (`src/`, `dist/`, `package.json`, `LICENSE`, `social-preview.png`), já com as 5 melhorias homologadas.
- O tarball npm publicado **não** continha `tsconfig.json`; o arquivo versionado aqui foi recuperado do repositório upstream `github.com/hueyexe/opencode-ensemble` (`tsconfig.json`, sem alterações de compilador).
- `package.json` foi reescrito apenas em `name`, `version`, `description`, `repository`, `keywords`, `files` e `scripts` (`test`, `check`, `typecheck`, `build`); dependências e `exports` permanecem equivalentes ao upstream.
- Dívida conhecida: `engines.node >= 24` foi herdado do upstream e as suítes são executadas neste ambiente com Node `v22.23.2` (type-stripping nativo) — sem impacto sobre o runtime do plugin, que é o bundle `dist/index.js`.

---

## 6. Governança

- **Proibição estrita de mocks** em produção e testes (fail-fast): dependência indisponível vira bloqueio reportado, nunca stub.
- **Sem polling**: wake do lead é exclusivamente event-driven (board closure); monitoramento passivo via dashboard/task board.
- **Homologação**: toda entrega passa por `node --check dist/index.js` + `node tests/run_all.mjs` antes de qualquer commit.

MIT © [maiteuxzanela](https://github.com/maiteuxzanela) — derivado de `@hueyexe/opencode-ensemble` (MIT).
