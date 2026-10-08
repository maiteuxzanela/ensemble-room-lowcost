# AGENTS.md — OpenCode Ensemble Hardened (`ensemble-room-lowcost`)

> **Repositório:** `/mnt/94CCB337CCB3130A/ensemble-room-lowcost`
> **Pacote:** `@maiteuxzanela/ensemble-room-lowcost` v`0.18.1`
> **Base upstream:** `@hueyexe/opencode-ensemble@0.18.0` (derivado, endurecido — MIT)
> **Runtime entrypoint:** `dist/index.js` (bundle autocontido)

---

## 1. Papel deste Repositório — Fonte da Verdade Oficial

Este repositório é a **fonte da verdade oficial** (single source of truth) do plugin **Ensemble Hardened** para o OpenCode. Toda a lógica de orquestração multi-agente (tools `team_*`, hooks, watchdog, schema SQLite, mensageria, dashboard) que opera em produção neste ambiente deriva **exclusivamente** do código versionado aqui — em `src/` (TypeScript fonte) e `dist/index.js` (bundle compilado carregado pelo runtime do OpenCode).

Nenhuma alteração deve ser feita em cópias fora deste repositório (ex.: diretórios sob `~/.cache/opencode/packages`). Cópias são **espelhos descartáveis**; o código vivo é o que está aqui.

### 1.1 Por que este repositório foi criado — imunidade contra o cache volátil

O OpenCode resolve plugins npm referenciados como `@hueyexe/opencode-ensemble@0.18.0` instalando-os em um **diretório de cache volátil**:

```text
~/.cache/opencode/packages/@hueyexe/opencode-ensemble@0.18.0/
  └── node_modules/@hueyexe/opencode-ensemble/
```

Esse diretório de cache é **descartável e não confiável como fonte de verdade**:

- O cache pode ser **limpo, rebaixado ou sobrescrito** por atualizações do OpenCode, reinstalações ou limpezas de disco — sem qualquer aviso prévio.
- O bundle `dist/index.js` do upstream (`@hueyexe/opencode-ensemble@0.18.0`) **não contém** as 5 blindagens implementadas neste fork (standby nativo, migration 12, hooks cientes de standby, imunidade do watchdog a compactação, silent lead + board wake).
- Se o cache fosse recriado a partir do tarball npm original, **todas as blindagens seriam perdidas silenciosamente** e a operação de baixo custo de tokens voltaria a queimar tokens em spawns, falsos alarmes e wakes desnecessários.

Por isso, este repositório em `/mnt/94CCB337CCB3130A/ensemble-room-lowcost` existe como **âncora permanente**: sobrevive a limpezas de cache, é versionado no git, é auditável e é o único lugar de onde as alterações são propagadas. O cache em `~/.cache/opencode/packages` é mantido apenas como **espelho defensivo** (symlink) para compatibilidade com resolvers que ainda esperem o caminho do pacote npm — nunca como origem de mudanças.

---

## 2. As 5 Blindagens Implementadas (sobre o upstream 0.18.0)

O upstream `@hueyexe/opencode-ensemble@0.18.0` é funcional, mas **não foi projetado para operação de baixo custo de tokens**. As 5 melhorias abaixo foram implementadas em `src/` e homologadas com `326 checks determinísticos sem mocks` (`npm test`).

### Blindagem 1 — Standby Nativo (`standby: true`, spawn_context, zero tokens no spawn, despertar atômico)

- **Problema.** Em `team_spawn`, o upstream enviava o prompt de init na criação da sessão: **cada colega nascia queimando tokens** antes de qualquer trabalho real — impeditivo para mesas de baixo custo.
- **Solução** (`src/tools/team-spawn.ts`, `src/tools/team-message.ts`, `src/tools/team-broadcast.ts`):
  - `standby: true` registra o membro **sem** enviar prompt. A sessão nasce em `execution_status = 'standby'` e o prompt completo é persistido em `team_member.spawn_context` (**Migration 11**).
  - O **primeiro** `team_message`/`team_broadcast` destinado ao membro é o acordador: o texto de entrega recebe o `spawn_context` **prependado** e a transição `standby → starting` acontece via `UPDATE … WHERE execution_status = 'standby'` — **guarda idempotente de um-só-consumidor**: duas mensagens simultâneas não duplicam o init.
  - **Fail-safe**: se o `promptAsync` do wake falhar, o hook devolve a janela (`execution_status` volta a `'standby'`) para que uma retentativa ou a passada de recuperação de mensagens não entregues replayer o `spawn_context` em vez de um prompt vazio.
  - Nenhuma mensagem perdida: mensagens que chegam antes do wake ficam na fila e entram no mesmo turno.
- **Garantia:** `tests/test_standby_lifecycle.mjs` (122 checks) — nascer em standby sem prompt, wake exatamente 1×, revert em falha de transporte, retentativas `retry_until` concluindo `standby → starting`.

### Blindagem 2 — Migration 12 (rebuild idempotente de schema com CHECK aceitando `'standby'`)

- **Problema.** `team_member.execution_status` é um `CHECK` com literais fixos. SQLite **não permite `ALTER` de CHECK**: um banco montado do zero rejeitaria o `INSERT` em standby com erro de constraint (o banco vivo só funcionava porque carregava o literal fora de banda).
- **Solução** (`src/schema.ts`, Migration 12):
  - Rebuild no padrão consolidado pela Migration 8: `RENAME → CREATE → copiar → DROP`, carregando **todas** as colunas adicionadas pelas Migrations 3–11 (`worktree_*`, `plan_approval`, `workspace_id`, `reported_to_lead`, `last_nudged_at`, `retry_*`, `spawn_context`) e **recriando os dois índices** que morrem junto com a tabela antiga.
  - O novo `CHECK` passa a aceitar `'standby'` entre os literais (`idle, starting, running, cancel_requested, cancelling, cancelled, completing, completed, failed, timed_out, standby`).
  - Executa em transação única no fluxo de `createDb`, portanto é **idempotente e atômica**: upgrade de banco legado e bootstrap limpo convergem para o mesmo schema.
- **Garantia:** as três suítes aplicam o `MIGRATIONS` real num SQLite real (fresh e upgrade de banco de produção) e verificam contagem/paridade `src ↔ dist`.

### Blindagem 3 — Blindagem de Hooks (`shouldNudgeIdleMember` e `shouldAlarmFastIdle` suprimindo falsos alarmes para standby ou tarefas bloqueadas)

- **Problema.** Dois gatilhos não sabiam nada do standby e do trabalho bloqueado:
  1. o nudge de idle mandava prompt para colega recém-criado que **não deveria ter recebido prompt algum** (queimando tokens e poluindo a sessão);
  2. o alarme `fast-idle` gritava "agente caiu" para quem estava legitimamente parado (standby ou com task bloqueada por dependência).
- **Solução** (`src/hooks.ts`, exportada por `src/index.ts`):
  - `shouldNudgeIdleMember(db, teamId, member)` → `false` quando `execution_status === 'standby'` (e demais estados de bloqueio já cobertos), além da janela clássica de `last_nudged_at`.
  - `shouldAlarmFastIdle(...)` → `false` para `standby`, preservando o alarme apenas para idle genuíno. A lógica foi **extraída do bloco inline do bundle** para seam testável sem tocar em decisão.
  - `hasBlockedAssignedTasks(...)` mantém o bloqueio legítimo visível para o nudge de equipe, sem alarme falso.
- **Garantia:** `test_standby_lifecycle.mjs` conta **zero alarmes fast-idle falsos** ao longo da suíte inteira (check `D12`) e exercita nudge em paralelo com wake.

### Blindagem 4 — Watchdog Heartbeat & Compaction (leitura de `time_compacting > 0` da tabela `session`, evitando timeouts durante compactação)

- **Problema.** O watchdog derruba sessões por TTL (`stallThresholdMs`, default 300 s). Sessões em **compactação** (contexto longo) não progridem em `time_updated` e eram abortadas como "stale" — timeout indevido, perda de contexto e retrabalho caro.
- **Solução** (`src/watchdog.ts`, `src/progress.ts`):
  - **Heartbeat ativo:** na checagem, membro stale cuja sessão mostra progresso real (`ProgressTracker`) tem `time_updated` **renovado** — continua "busy" sem abortar (`watchdog:heartbeat:renewed`).
  - **Imunidade a compaction:** `isSessionCompacting(sessionId)` lê `session.time_compacting` do store do OpenCode **read-only**; se `> 0`, a sessão não é abortada neste tick e é reavaliada no próximo (`watchdog:heartbeat:compacting`).
  - Compaction com valor `0` **não** goza da imunidade (corrida decidida corretamente); sessões genuinamente idle continuam transicionando para `error/timed_out` com aviso ao lead, toast e limpeza de worktree.
  - `ttlMs = 0` desliga o TTL mantendo o GC de worktrees; resiliência a store ausente/corrompido retorna `false` sem exceção.
- **Garantia:** `tests/test_watchdog_heartbeat.mjs` (53 checks) — 4 cenários (active, compacting, idle, compaction=0) rodados **tanto contra `dist` quanto contra `src`**, com store `session` real extraído do `opencode.db` de produção.

### Blindagem 5 — Silent Lead & Board Wake (`silentLead` default `true`, acúmulo passivo em SQLite `delivered=0`, supressão de `promptAsync` intermediário, despertar único sistemático quando `completed === total`)

- **Problema.** Cada `team_message` destinada ao lead disparava `promptAsync` na sessão do lead: o orquestrador acordava dezenas de vezes por turno, multiplicando tokens e quebrando a regra de "polling proibido / lead mudo".
- **Solução** (`src/tools/team-message.ts`, `src/tools/team-tasks-complete.ts`, `src/system-prompt.ts`, `src/config.ts`):
  - **`silentLead` (default `true`)**: mensagens ao lead são **persistidas** (`delivered = 0`) e **nenhum** `promptAsync` é disparado. O canal de entrega real passa a ser `buildLeadSystemPrompt`, que injeta o acúmulo na **próxima** chamada legítima do lead e marca `delivered = 1`. Resultado: tokens de wake = **zero** enquanto o lead está em repouso.
  - **`silentLead: false` (legado)**: comportamento original byte-a-byte — um único `promptAsync` com `[System: New team message from <remetente>]` e `synthetic: true`.
  - **Coerção condicional no system prompt**: com `silentLead` ativo a directiva agressiva
    `"You MUST send your results to the lead via team_message before stopping."` é substituída por
    `"Collaborate with teammates using team_message and complete assigned tasks on the board."`
    (`leadReportDirective`); no legado, o texto é preservado integralmente.
  - **Despertador sistemático por board** (`team_tasks_complete`): quando `total > 0 && completed === total`, o lead recebe **exatamente 1×** `[System: All team tasks completed on board by <who>]` com `synthetic: true`. Esse é o **único** evento de wake automático do lead — ou seja, o despertar é 100% sistemático, nunca por conteúdo textual.
  - Fail-safe: falha de transporte no wake é absorvida por `.catch` (zero `unhandledRejection`), e task sem `assignee` é atribuída atomicamente ao autor para o board não mentir.
- **Garantia:** `tests/test_silent_lead_board_wake.mjs` (151 checks) — fila `delivered=0` sem wake, wake único no fechamento do board, coerção condicional, legado byte-a-byte, regressão zero das suítes 1 e 2.

---

## 3. Ciclo de Desenvolvimento Obrigatório

Toda alteração neste repositório segue **obrigatoriamente** o ciclo abaixo, nesta ordem:

1. **Editar apenas em `src/`.**
   Nunca editar `dist/` manualmente — `dist/index.js` é gerado. A fonte da verdade do comportamento é `src/*.ts`.

2. **Build:**
   ```bash
   npm run build
   ```
   Gera `dist/index.js` (bundle via `bun build src/index.ts --outdir dist --target node`).

3. **Testes determinísticos (sem mocks):**
   ```bash
   npm run check   # node --check dist/index.js
   npm test        # node tests/run_all.mjs → 326 checks
   ```
   Ambos devem sair com exit 0. Nenhum commit é permitido com teste falhando.

4. **Git commit + push para `origin main`:**
   ```bash
   git add -A
   git commit -m "<mensagem descritiva>"
   git push origin main
   ```

5. **Reiniciar o daemon do OpenCode** para carregar o novo bundle na RAM.
   O plugin é carregado na inicialização do runtime; alterações em `dist/index.js` **não** são aplicadas em sessões já vivas. Sem esse passo, o daemon continua executando o bundle antigo.

---

## 4. Política Estrita de Testes Sem Mocks (Fail-Fast)

- **Proibição absoluta de mocks, stubs ou fixtures falsas** em produção e testes. Dependência indisponível vira **bloqueio reportado**, nunca substituta simulada.
- O único ponto de "emenda" aceito nas suítes é o **transporte de saída** (`session.create`, `promptAsync`, `session.abort`, `showToast`), gravado num array de captura para que a asserção prove *o que foi chamado*. Nenhuma lógica de decisão é substituída por mock.
- Bancos usados nos testes são **SQLite reais** (`node:sqlite`), criados isoladamente em `.test-scratch/` (gitignore, recriado a cada execução).
- `test_watchdog_heartbeat.mjs` usa o schema da tabela `session` extraído **read-only** de `~/.local/share/opencode/opencode.db` — **pré-requisito de ambiente** (falha explícita e visível se ausente; nenhum stub é usado no lugar).
- Suítes rodam contra **ambos** `dist/index.js` e os `.ts` de `src/` (copiados para fora de `node_modules` apenas com resolução mecânica de extensão de import — lógica intacta), garantindo paridade fonte/bundle.

---

## 5. Governança

- **Homologação obrigatória:** toda entrega passa por `node --check dist/index.js` + `node tests/run_all.mjs` antes de qualquer commit.
- **Sem polling:** wake do lead é exclusivamente event-driven (fechamento de board); monitoramento passivo via dashboard (`:4747`) / task board.
- **Proibição de commit antecipado:** `git status` não pode ser limpo antes da homologação determinística.
- **MIT © maiteuxzanela** — derivado de `@hueyexe/opencode-ensemble` (MIT).
