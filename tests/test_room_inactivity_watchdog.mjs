#!/usr/bin/env node
/**
 * QUALITY GATE DETERMINÍSTICO — Watchdog de Ociosidade da Sala & Despacho da Clara
 * @hueyexe/opencode-ensemble@0.18.2
 *
 * Guardiã: Clara (Quality Gate & Integridade dos Testes).
 * Squad: 'clara-room-lead' (TASK-05 / Otávio).
 *
 * Sob teste (código REAL, sem mocks de decisão):
 *   - Watchdog.checkRoomInactivity() e Watchdog.check() (src/watchdog.ts e dist/index.js).
 *   - lastRoomActivity(db, teamId) (src/config.ts).
 *   - roomInactivityThresholdMs (default 30_000ms / 30s) e roomInactivityCheckMs (5_000ms / 5s).
 *   - Respeito determinístico ao cooldown de 30s de re-despacho sem spam.
 *   - Desativação quando todas as tarefas estão completas ou canceladas.
 *   - Degradação suave (time sem Clara, time não ativo, threshold = 0).
 *
 * CORREÇÃO 4 (qa-role.ts + watchdog.ts) — QA ocupada nunca é acionada:
 *   - (a) Clara com status = 'busy' → watchdog NÃO aciona (zero calls) [4.7].
 *   - (b) Clara com execution_status = 'running' | 'starting' → zero calls
 *         [4.8 / 4.9]; QA de volta a ready/idle restaura o wake exato [4.10],
 *         provando que a supressão vem da ocupação e não do cooldown.
 *   - Fix de contrato legado 4.6: o turno da Clara ('starting' desde o wake
 *     da seção 2) é transicionado para ready/idle antes de esperar o wake —
 *     sob a Correção 4 um QA ainda em turno suprime o wake corretamente.
 *   - (c) Sentinela estática 0.9: query de busyMember unificada presente e
 *     exclusão legada `name != qa.name` AUSENTE em src e dist.
 *
 * PROVA DE MUTAÇÃO (seção 7, dist/src reais via ENSEMBLE_PKG, descartados):
 *   - Controle: suíte completa contra pacote limpo → 100% verde (exit 0).
 *   - M1: reintroduzir a exclusão `name != qa.name` (dist E src) → a suíte
 *     completa FALHA com exit != 0 exatamente na sentinela 0.9.
 *   - M2: reverter guarda + query (pré-Correção 4) → os cenários 4.7/4.8/4.9
 *     FALHAM (corrida de double-prompt detectada) e os fluxos intactos
 *     (2.1/4.3/4.6/4.10/5.1/6.1) permanecem verdes (cirurgia).
 *
 * Regras:
 *   - SEM MOCKS em código de produção ou testes.
 *   - SQLite REAL (node:sqlite) isolado em .test-scratch/.
 *   - Unhandled rejections causam falha imediata.
 *
 * Uso:  node tests/test_room_inactivity_watchdog.mjs
 * Exit: 0 = todos os checks PASS; 1 = há FAIL.
 */

import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";

const REPO = path.resolve(import.meta.dirname, "..");
const PKG = process.env.ENSEMBLE_PKG || REPO;
const DIST = path.join(PKG, "dist/index.js");
const SRC = path.join(PKG, "src");
const TMP = path.join(REPO, ".test-scratch");
mkdirSync(TMP, { recursive: true });

const HARNESS = path.join(TMP, "_room_inactivity_harness.mjs");
const SRC_COPY = path.join(TMP, "ensemble_src_room_inactivity");
const ROOT = path.join(TMP, "room_inactivity_suite");

const results = [];
const check = (name, ok, detail) => {
  results.push([name, ok]);
  console.log(`${ok ? "PASS" : "FAIL"} | ${name}${detail ? " | " + detail : ""}`);
};

const unhandled = [];
process.on("unhandledRejection", (e) => unhandled.push(e));

/* ================================================================== *
 * 0. SINTAXE E SÍMBOLOS EXIGIDOS                                     *
 * ================================================================== */
{
  const r = spawnSync(process.execPath, ["--check", DIST], { encoding: "utf8" });
  check(
    "0.1 node --check dist/index.js → exit 0",
    r.status === 0,
    `status=${r.status}${r.stderr ? " stderr=" + r.stderr.trim().slice(0, 200) : ""}`,
  );
}

const REQUIRED_SYMBOLS = [
  "createDb",
  "MemberRegistry",
  "Watchdog",
  "lastRoomActivity",
  "DEFAULT_CONFIG",
  "MIGRATIONS",
  "resolveStandbyWake",
];

const distRaw = readFileSync(DIST, "utf8");

/** Anexa ao bundle os exports dos símbolos exigidos (ausentes só se faltarem). */
function buildHarnessFile(raw) {
  const existingExport = raw.match(/export\s*\{([^}]*)\}\s*;?\s*$/)?.[1] ?? "";
  const already = new Set(
    existingExport.split(",").map((s) => s.trim().split(/\s+as\s+/).pop()).filter(Boolean),
  );
  const need = REQUIRED_SYMBOLS.filter((s) => !already.has(s));
  return raw + (need.length ? `\nexport { ${need.join(", ")} };\n` : "");
}

{
  const missing = REQUIRED_SYMBOLS.filter(
    (s) => !new RegExp(`(function|class|var|const|let)\\s+${s}\\b`).test(distRaw),
  );
  check(
    "0.2 dist declara todos os símbolos exigidos para o watchdog de ociosidade",
    missing.length === 0,
    missing.join(",") || REQUIRED_SYMBOLS.length + " símbolos presentes",
  );

  writeFileSync(HARNESS, buildHarnessFile(distRaw));
}

function prepareSrcCopy() {
  rmSync(SRC_COPY, { recursive: true, force: true });
  cpSync(SRC, SRC_COPY, { recursive: true });
  let rewritten = 0;
  const walk = (dir) =>
    readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
      e.isDirectory() ? walk(path.join(dir, e.name)) : [path.join(dir, e.name)],
    );
  for (const file of walk(SRC_COPY)) {
    if (!/\.(ts|tsx)$/.test(file)) continue;
    const before = readFileSync(file, "utf8");
    const after = before.replace(/(from\s+["'])(\.\.?\/[^"']+)(["'])/g, (m, a, spec, c) => {
      const base = path.resolve(path.dirname(file), spec);
      for (const ext of [".ts", ".tsx", "/index.ts", "/index.tsx"]) {
        if (existsSync(base + ext) && !spec.endsWith(ext)) {
          rewritten++;
          return a + spec + ext + c;
        }
      }
      return m;
    });
    if (after !== before) writeFileSync(file, after);
  }
  return rewritten;
}
check("0.3 cópia do src preparada para testes", prepareSrcCopy() > 0);

/* Paridade textual de marcadores */
function readSrc(rel) {
  return readFileSync(path.join(SRC, rel), "utf8");
}
const srcWatchdog = readSrc("watchdog.ts");
const srcConfig = readSrc("config.ts");

check(
  "0.4 método checkRoomInactivity implementado (src e dist)",
  srcWatchdog.includes("checkRoomInactivity") && distRaw.includes("checkRoomInactivity"),
);
check(
  "0.5 marcador watchdog:room-inactivity:wake-clara presente (src e dist)",
  srcWatchdog.includes("watchdog:room-inactivity:wake-clara") && distRaw.includes("watchdog:room-inactivity:wake-clara"),
);
check(
  "0.6 roomInactivityThresholdMs default = 30000 presente no config (src e dist)",
  srcConfig.includes("roomInactivityThresholdMs: 30_000") && /roomInactivityThresholdMs:\s*(30_?000|3e4)/.test(distRaw),
);

/* Anti-mock scan */
{
  const FORBIDDEN = [
    /\bMagicMock\b/, /\bjest\.(mock|fn|spyOn)\b/, /\bvi\.(mock|fn|spyOn)\b/,
    /\bsinon\b/, /unittest\.mock/,
  ];
  let violations = 0;
  for (const rx of FORBIDDEN) {
    if (rx.test(distRaw)) violations++;
  }
  check("0.7 zero primitivas de mock no bundle", violations === 0);
}

check(
  "0.8 guarda defensiva de membros ocupados implementada (src e dist)",
  srcWatchdog.includes("status = 'busy' OR execution_status IN ('starting', 'running')") &&
    distRaw.includes("status = 'busy' OR execution_status IN ('starting', 'running')"),
);

/* ================================================================== *
 * 0.9 SENTINELA ESTATICA DA CORRECAO 4                                *
 *   Query de busyMember UNIFICADA (qualquer membro ocupado conta,     *
 *   inclusive a propria QA) e AUSENCIA da exclusao legada             *
 *   `name != qa.name`, que ignorava a QA e reabria a corrida de       *
 *   double-prompt. E o alvo da prova de mutacao M1 (secao 7).         *
 * ================================================================== */
const BUSY_QUERY_LITERAL =
  `"SELECT name FROM team_member WHERE team_id = ? AND (status = 'busy' OR execution_status IN ('starting', 'running')) LIMIT 1"`;
const BUSY_EXCLUSION_MARKER = "name != ? AND (status = 'busy'";
const busyQuerySentinel = (text) =>
  text.includes(BUSY_QUERY_LITERAL) && !text.includes(BUSY_EXCLUSION_MARKER);

check(
  "0.9 sentinela Correção 4: query de busyMember unificada SEM exclusão name != qa.name (src e dist)",
  busyQuerySentinel(srcWatchdog) && busyQuerySentinel(distRaw),
  `src=${busyQuerySentinel(srcWatchdog)} dist=${busyQuerySentinel(distRaw)}`,
);

/* ================================================================== *
 * FIXTURES E TRANSPORTE DE SAÍDA                                     *
 * ================================================================== */
function createTestClient(calls) {
  return {
    session: {
      promptAsync: async (o) => {
        calls.promptAsync.push(o);
        return {};
      },
      abort: async (o) => {
        calls.abort.push(o);
        return {};
      },
    },
    tui: {
      showToast: async (o) => {
        calls.toast.push(o);
      },
    },
    workspace: { remove: async () => {} },
    worktree: { remove: async () => {} },
  };
}

/* ================================================================== *
 * SUÍTE COMPORTAMENTAL (executada em dist e src)                      *
 * Registra cada check num Map devolvido; com emit=true (fase real)    *
 * também imprime/promove via check global — com emit=false (mutantes) *
 * silencia, permitindo inspecionar a sensibilidade por cenário.       *
 * ================================================================== */
async function runRoomInactivityBehavior(label, mods, emit = true) {
  const got = new Map();
  const check = (name, ok, detail) => {
    got.set(name, { ok, detail });
    if (emit) {
      results.push([name, ok]);
      console.log(`${ok ? "PASS" : "FAIL"} | ${name}${detail ? " | " + detail : ""}`);
    }
  };

  const {
    createDb,
    MemberRegistry,
    Watchdog,
    lastRoomActivity,
  } = mods;

  const root = `${ROOT}_${label}`;
  rmSync(root, { recursive: true, force: true });
  mkdirSync(root, { recursive: true });

  const db = createDb(path.join(root, "ensemble.db"));
  const registry = new MemberRegistry();
  const calls = { promptAsync: [], abort: [], toast: [] };
  const client = createTestClient(calls);

  const TEAM = "team_inactive_room";
  const CLARA_SESSION = "ses_clara_watchdog";
  const DEV_SESSION = "ses_dev_watchdog";

  const t0 = Date.now();
  // 45 segundos atrás (mais que 30s de threshold)
  const inactiveTimestamp = t0 - 45_000;

  // Inserir projeto e time com time_created antigo
  db.run("INSERT INTO project (id, name, path, status, time_created, time_updated) VALUES ('default', 'Default', '', 'active', ?, ?) ON CONFLICT DO NOTHING", [inactiveTimestamp, inactiveTimestamp]);
  db.run(
    "INSERT INTO team (id, name, project_id, lead_session_id, status, delegate, time_created, time_updated) VALUES (?,?,?,?,?,?,?,?)",
    [TEAM, "squad-inactivity", "default", "ses_lead_inact", "active", 0, inactiveTimestamp, inactiveTimestamp],
  );

  const insertMember = (teamId, name, sessionId, agent, executionStatus = "idle", spawnContext = null, ts = inactiveTimestamp) => {
    db.run(
      `INSERT INTO team_member (team_id, name, session_id, agent, status, execution_status, spawn_context, time_created, time_updated, reported_to_lead)
       VALUES (?,?,?,?,?,?,?,?,?,?)`,
      [teamId, name, sessionId, agent, "ready", executionStatus, spawnContext, ts, ts, 0],
    );
    registry.register(teamId, name, sessionId);
  };

  const insertTask = (id, teamId, content, status, assignee, ts = inactiveTimestamp) => {
    db.run(
      "INSERT INTO team_task (id, team_id, content, status, priority, assignee, time_created, time_updated) VALUES (?,?,?,?,?,?,?,?)",
      [id, teamId, content, status, "medium", assignee, ts, ts],
    );
  };

  // Clara nasce em standby com contexto de governança
  insertMember(TEAM, "clara", CLARA_SESSION, "clara", "standby", "Diretrizes de Governança Clara Quality Gate", inactiveTimestamp);
  insertMember(TEAM, "dev", DEV_SESSION, "build", "idle", null, inactiveTimestamp);

  // Inserir tarefas inacabadas no board (pending, in_progress, in_review, blocked)
  insertTask("t_pend", TEAM, "Tarefa Pendente", "pending", null, inactiveTimestamp);
  insertTask("t_prog", TEAM, "Tarefa Em Progresso", "in_progress", "dev", inactiveTimestamp);
  insertTask("t_rev", TEAM, "Tarefa Em Revisão", "in_review", "dev", inactiveTimestamp);
  insertTask("t_block", TEAM, "Tarefa Bloqueada", "blocked", null, inactiveTimestamp);

  const wd = new Watchdog({
    db,
    client,
    registry,
    ttlMs: 0, // Desativa staleness genérico
    roomInactivityThresholdMs: 30_000,
    roomInactivityCheckMs: 5_000,
  });

  /* ================================================================ *
   * 1. VERIFICAÇÃO DE PRÉ-CONDIÇÕES & HELPER lastRoomActivity         *
   * ================================================================ */
  const recordedLastActivity = lastRoomActivity(db, TEAM);
  check(
    `[${label}] 1.1 lastRoomActivity reflete o timestamp mais recente de atividade da sala`,
    recordedLastActivity === inactiveTimestamp,
    `ts=${recordedLastActivity} esperado=${inactiveTimestamp}`,
  );
  check(
    `[${label}] 1.2 Inatividade calculada é >= 30s (ex: 45s)`,
    Date.now() - recordedLastActivity >= 30_000,
    `inactiveMs=${Date.now() - recordedLastActivity}`,
  );

  /* ================================================================ *
   * 2. SALA INATIVA >= 30s COM TAREFAS PENDENTES: ACIONA CLARA       *
   * ================================================================ */
  calls.promptAsync.length = 0;
  await wd.checkRoomInactivity();

  const claraCalls = calls.promptAsync.filter((c) => c.sessionID === CLARA_SESSION);
  check(`[${label}] 2.1 Watchdog aciona a Clara com exatamente 1 promptAsync`, claraCalls.length === 1, `calls=${claraCalls.length}`);

  const promptText = claraCalls[0]?.parts?.[0]?.text ?? "";
  check(
    `[${label}] 2.2 Prompt para Clara contém contexto de spawn original (acordou de standby)`,
    promptText.includes("Diretrizes de Governança Clara Quality Gate"),
  );
  check(
    `[${label}] 2.3 Prompt para Clara contém aviso sintético de ociosidade com contagem de tarefas`,
    /\[System: Room has been inactive for \d+s with 4 unfinished task\(s\)\. Inspect the board, unblock, claim, or nudge teammates to drive progress\.\]/.test(promptText),
    promptText,
  );
  check(`[${label}] 2.4 Prompt é sintético (synthetic: true)`, claraCalls[0]?.synthetic === true);

  const claraRowAfterWake = db.query("SELECT execution_status, last_nudged_at FROM team_member WHERE team_id = ? AND name = 'clara'").get(TEAM);
  check(`[${label}] 2.5 Clara transicionou de standby para starting`, claraRowAfterWake.execution_status === "starting", claraRowAfterWake.execution_status);
  check(`[${label}] 2.6 last_nudged_at da Clara foi atualizado no SQLite com timestamp recente`,
    typeof claraRowAfterWake.last_nudged_at === "number" && (Date.now() - claraRowAfterWake.last_nudged_at < 5000),
    `last_nudged_at=${claraRowAfterWake.last_nudged_at}`,
  );

  /* ================================================================ *
   * 3. RESPEITO AO COOLDOWN (30s) — SEGUNDO TICK CONSECUTIVO NÃO DISPARA
   * ================================================================ */
  calls.promptAsync.length = 0;
  await wd.checkRoomInactivity();

  check(
    `[${label}] 3.1 Segundo tick consecutivo respeita cooldown e NÃO dispara novo wake (zero spam)`,
    calls.promptAsync.length === 0,
    `calls=${calls.promptAsync.length}`,
  );

  // Também rodando via check() geral
  await wd.check();
  check(
    `[${label}] 3.2 Execução de wd.check() geral também respeita o cooldown de ociosidade`,
    calls.promptAsync.length === 0,
    `calls=${calls.promptAsync.length}`,
  );

  /* ================================================================ *
   * 4. NOVA ATIVIDADE NA SALA RESETANDO O COOLDOWN                    *
   * ================================================================ */
  // Simular que uma atividade nova acabou de ocorrer na sala (ex: mensagem enviada)
  const recentNow = Date.now();
  db.run(
    "INSERT INTO team_message (id, team_id, from_name, to_name, content, time_created) VALUES ('msg_act', ?, 'dev', 'clara', 'Trabalhando na tarefa', ?)",
    [TEAM, recentNow],
  );

  const newActivityTs = lastRoomActivity(db, TEAM);
  check(`[${label}] 4.1 Nova mensagem atualiza lastRoomActivity para timestamp recente`, newActivityTs === recentNow);

  calls.promptAsync.length = 0;
  await wd.checkRoomInactivity();
  check(`[${label}] 4.2 Sala ativa recentemente (< 30s): watchdog NÃO dispara`, calls.promptAsync.length === 0);

  /* ================================================================ *
   * 4.B MEMBRO ATIVAMENTE OCUPADO NA SALA: SUPRIME WAKE DA CLARA     *
   * ================================================================ */
  // Resetar mensagens para o passado para simular ociosidade da sala (> 30s)
  db.run("UPDATE team_message SET time_created = ? WHERE team_id = ?", [inactiveTimestamp, TEAM]);
  db.run("UPDATE team_member SET last_nudged_at = NULL, time_updated = ? WHERE team_id = ?", [inactiveTimestamp, TEAM]);

  // Cenário 4.3: dev com status = 'busy' (executando tarefa longa)
  db.run("UPDATE team_member SET status = 'busy', execution_status = 'idle', time_updated = ? WHERE team_id = ? AND name = 'dev'", [inactiveTimestamp, TEAM]);
  calls.promptAsync.length = 0;
  await wd.checkRoomInactivity();
  check(
    `[${label}] 4.3 Membro com status = 'busy': watchdog NÃO dispara wake da Clara (zero wake)`,
    calls.promptAsync.length === 0,
    `calls=${calls.promptAsync.length}`,
  );

  // Cenário 4.4: dev com execution_status = 'running'
  db.run("UPDATE team_member SET status = 'ready', execution_status = 'running', time_updated = ? WHERE team_id = ? AND name = 'dev'", [inactiveTimestamp, TEAM]);
  calls.promptAsync.length = 0;
  await wd.checkRoomInactivity();
  check(
    `[${label}] 4.4 Membro com execution_status = 'running': watchdog NÃO dispara wake da Clara (zero wake)`,
    calls.promptAsync.length === 0,
    `calls=${calls.promptAsync.length}`,
  );

  // Cenário 4.5: dev com execution_status = 'starting'
  db.run("UPDATE team_member SET status = 'ready', execution_status = 'starting', time_updated = ? WHERE team_id = ? AND name = 'dev'", [inactiveTimestamp, TEAM]);
  calls.promptAsync.length = 0;
  await wd.checkRoomInactivity();
  check(
    `[${label}] 4.5 Membro com execution_status = 'starting': watchdog NÃO dispara wake da Clara (zero wake)`,
    calls.promptAsync.length === 0,
    `calls=${calls.promptAsync.length}`,
  );

  // Cenário 4.6: dev volta para 'ready' e 'idle' (não ocupado) -> agora a Clara DEVE ser acordada.
  // Contrato pós-Correção 4: o wake da seção 2 deixou a Clara em
  // execution_status='starting' (turno em voo) — em runtime real os eventos
  // devolvem a QA a idle. Modelamos aqui a conclusão do turno dela (PRONTA e
  // IDLE) antes de esperar o wake: com a QA ainda 'starting', a guarda/query
  // unificada suprimiria o wake CORRETAMENTE e o cenário 4.6 falharia.
  db.run("UPDATE team_member SET status = 'ready', execution_status = 'idle', time_updated = ? WHERE team_id = ? AND name = 'clara'", [inactiveTimestamp, TEAM]);
  db.run("UPDATE team_member SET status = 'ready', execution_status = 'idle', time_updated = ? WHERE team_id = ? AND name = 'dev'", [inactiveTimestamp, TEAM]);
  calls.promptAsync.length = 0;
  await wd.checkRoomInactivity();
  check(
    `[${label}] 4.6 Membro em idle/ready (não ocupado, fim de turno da QA modelado): watchdog volta a disparar wake para a Clara`,
    calls.promptAsync.length === 1,
    `calls=${calls.promptAsync.length}`,
  );

  /* ================================================================ *
   * 4.C CORREÇÃO 4 — QA (CLARA) OCUPADA: WATCHDOG NÃO ACIONA          *
   * (a) status='busy' [4.7]; (b) execution_status running/starting    *
   * [4.8/4.9]; recuperação ready/idle → wake exato [4.10].            *
   * Cada cenário zera last_nudged_at para que o zero-wake seja         *
   * atribuído à ocupação da QA e NUNCA ao cooldown de 30s.             *
   * ============================================================== */
  db.run("UPDATE team_message SET time_created = ? WHERE team_id = ?", [inactiveTimestamp, TEAM]);
  db.run("UPDATE team_member SET last_nudged_at = NULL, time_updated = ? WHERE team_id = ?", [inactiveTimestamp, TEAM]);
  db.run("UPDATE team_member SET status = 'ready', execution_status = 'idle', time_updated = ? WHERE team_id = ? AND name = 'dev'", [inactiveTimestamp, TEAM]);

  // 4.7 (a): QA com status = 'busy' → zero calls para a Clara.
  db.run("UPDATE team_member SET status = 'busy', execution_status = 'idle', time_updated = ? WHERE team_id = ? AND name = 'clara'", [inactiveTimestamp, TEAM]);
  db.run("UPDATE team_member SET last_nudged_at = NULL WHERE team_id = ?", [TEAM]);
  calls.promptAsync.length = 0;
  await wd.checkRoomInactivity();
  const claraCalls47 = calls.promptAsync.filter((c) => c.sessionID === CLARA_SESSION);
  check(
    `[${label}] 4.7 Correção 4 — QA (Clara) com status = 'busy': watchdog NÃO aciona (zero calls para a Clara)`,
    claraCalls47.length === 0 && calls.promptAsync.length === 0,
    `claraCalls=${claraCalls47.length} total=${calls.promptAsync.length}`,
  );

  // 4.8 (b1): QA com execution_status = 'running' → zero calls.
  db.run("UPDATE team_member SET status = 'ready', execution_status = 'running', time_updated = ? WHERE team_id = ? AND name = 'clara'", [inactiveTimestamp, TEAM]);
  db.run("UPDATE team_member SET last_nudged_at = NULL WHERE team_id = ?", [TEAM]);
  calls.promptAsync.length = 0;
  await wd.checkRoomInactivity();
  const claraCalls48 = calls.promptAsync.filter((c) => c.sessionID === CLARA_SESSION);
  check(
    `[${label}] 4.8 Correção 4 — QA (Clara) com execution_status = 'running': watchdog NÃO aciona (zero calls)`,
    claraCalls48.length === 0 && calls.promptAsync.length === 0,
    `claraCalls=${claraCalls48.length} total=${calls.promptAsync.length}`,
  );

  // 4.9 (b2): QA com execution_status = 'starting' → zero calls.
  db.run("UPDATE team_member SET status = 'ready', execution_status = 'starting', time_updated = ? WHERE team_id = ? AND name = 'clara'", [inactiveTimestamp, TEAM]);
  db.run("UPDATE team_member SET last_nudged_at = NULL WHERE team_id = ?", [TEAM]);
  calls.promptAsync.length = 0;
  await wd.checkRoomInactivity();
  const claraCalls49 = calls.promptAsync.filter((c) => c.sessionID === CLARA_SESSION);
  check(
    `[${label}] 4.9 Correção 4 — QA (Clara) com execution_status = 'starting': watchdog NÃO aciona (zero calls)`,
    claraCalls49.length === 0 && calls.promptAsync.length === 0,
    `claraCalls=${claraCalls49.length} total=${calls.promptAsync.length}`,
  );

  // 4.10: QA volta a ready/idle → wake restabelecido (1 call exata) — prova
  // que a supressão de 4.7–4.9 vinha da ocupação da QA, não do cooldown.
  db.run("UPDATE team_member SET status = 'ready', execution_status = 'idle', time_updated = ? WHERE team_id = ? AND name = 'clara'", [inactiveTimestamp, TEAM]);
  db.run("UPDATE team_member SET last_nudged_at = NULL WHERE team_id = ?", [TEAM]);
  calls.promptAsync.length = 0;
  await wd.checkRoomInactivity();
  const claraCalls410 = calls.promptAsync.filter((c) => c.sessionID === CLARA_SESSION);
  check(
    `[${label}] 4.10 Correção 4 — QA volta a ready/idle: wake restabelecido (exatamente 1 call para a Clara)`,
    claraCalls410.length === 1 && calls.promptAsync.length === 1,
    `claraCalls=${claraCalls410.length} total=${calls.promptAsync.length}`,
  );

  /* ================================================================ *
   * 5. TODAS AS TAREFAS COMPLETAS/CANCELADAS: NÃO DISPARA             *
   * ================================================================ */
  // Colocar todas as tarefas como completed ou cancelled
  db.run("UPDATE team_task SET status = 'completed', time_updated = ? WHERE team_id = ? AND id IN ('t_pend', 't_prog', 't_rev')", [inactiveTimestamp, TEAM]);
  db.run("UPDATE team_task SET status = 'cancelled', time_updated = ? WHERE team_id = ? AND id = 't_block'", [inactiveTimestamp, TEAM]);

  // Forçar timestamp de atividade antigo em todas as entidades para simular ociosidade
  db.run("UPDATE team_message SET time_created = ? WHERE team_id = ?", [inactiveTimestamp, TEAM]);
  db.run("UPDATE team_member SET last_nudged_at = NULL, time_updated = ? WHERE team_id = ?", [inactiveTimestamp, TEAM]);

  calls.promptAsync.length = 0;
  await wd.checkRoomInactivity();

  check(
    `[${label}] 5.1 Com todas as tarefas completed/cancelled, watchdog NÃO dispara mesmo com sala inativa`,
    calls.promptAsync.length === 0,
    `calls=${calls.promptAsync.length}`,
  );

  /* ================================================================ *
   * 6. BLINDAGENS DE BORDA (threshold=0, time inativo, sem Clara)     *
   * ================================================================ */
  // 6.1 Watchdog com threshold 0 (desativado)
  {
    const wdDisabled = new Watchdog({
      db,
      client,
      registry,
      ttlMs: 0,
      roomInactivityThresholdMs: 0,
    });
    // Adicionar tarefa pendente antiga
    db.run("UPDATE team_task SET status = 'pending', time_updated = ? WHERE id = 't_pend'", [inactiveTimestamp]);
    calls.promptAsync.length = 0;
    await wdDisabled.checkRoomInactivity();
    check(`[${label}] 6.1 roomInactivityThresholdMs=0 desativa completamente a verificação`, calls.promptAsync.length === 0);
  }

  // 6.2 Time com status 'archived' (não ativo)
  {
    db.run("UPDATE team SET status = 'archived' WHERE id = ?", [TEAM]);
    calls.promptAsync.length = 0;
    await wd.checkRoomInactivity();
    check(`[${label}] 6.2 Time não-ativo (status != 'active') é ignorado pelo watchdog`, calls.promptAsync.length === 0);
    db.run("UPDATE team SET status = 'active' WHERE id = ?", [TEAM]);
  }

  // 6.3 Time sem membro Clara
  {
    // Arquivar TEAM principal para isolar a checagem exclusivamente em TEAM_NO_CLARA
    db.run("UPDATE team SET status = 'archived' WHERE id = ?", [TEAM]);

    const TEAM_NO_CLARA = "team_no_clara_wd";
    db.run(
      "INSERT INTO team (id, name, project_id, lead_session_id, status, delegate, time_created, time_updated) VALUES (?,?,?,?,?,?,?,?)",
      [TEAM_NO_CLARA, "squad-no-clara-wd", "default", "ses_lead_ncw", "active", 0, inactiveTimestamp, inactiveTimestamp],
    );
    insertMember(TEAM_NO_CLARA, "solo", "ses_solo_wd", "build", "idle", null, inactiveTimestamp);
    insertTask("t_solo_wd", TEAM_NO_CLARA, "Solo Task", "pending", null, inactiveTimestamp);

    calls.promptAsync.length = 0;
    let noClaraErr = null;
    try {
      await wd.checkRoomInactivity();
    } catch (e) {
      noClaraErr = e;
    }
    check(`[${label}] 6.3 Time sem Clara degrada suavemente sem exceções`, noClaraErr === null, noClaraErr?.message);
    check(`[${label}] 6.4 Nenhum promptAsync disparado para time sem Clara`, calls.promptAsync.length === 0);
  }

  db.close();
  return got;
}

/* ================================================================== *
 * EXECUÇÃO NAS DUAS CAMADAS: dist E src                              *
 * ================================================================== */
console.log("\n========================================================");
console.log("▶ EXECUTANDO CONTRA O BUNDLE COMPILADO (dist/index.js)");
console.log("========================================================");
const distMods = await import(HARNESS);
const realDistResults = await runRoomInactivityBehavior("dist", distMods);

console.log("\n========================================================");
console.log("▶ EXECUTANDO CONTRA O CÓDIGO FONTE REAL (src/**/*.ts)");
console.log("========================================================");
const srcMods = {
  ...(await import(`${SRC_COPY}/watchdog.ts`)),
  ...(await import(`${SRC_COPY}/tools/shared.ts`)),
  ...(await import(`${SRC_COPY}/db.ts`)),
  ...(await import(`${SRC_COPY}/state.ts`)),
  ...(await import(`${SRC_COPY}/config.ts`)),
  MIGRATIONS: (await import(`${SRC_COPY}/schema.ts`)).MIGRATIONS,
};
await runRoomInactivityBehavior("src", srcMods);

/* ================================================================== *
 * 7. PROVA DE MUTAÇÃO — CORREÇÃO 4 (sentinela determinística)        *
 *   Mutantes gerados por patch determinístico sobre os bytes REAIS e  *
 *   DESCARTADOS ao final — src/ e dist/ do repositório nunca são      *
 *   tocados.                                                          *
 *   - Controle: suíte completa contra pacote limpo → 100% verde,      *
 *     provando que o layout temporário em si não causa falha.         *
 *   - M1: reintroduzir a exclusão legada `name != qa.name` (dist e   *
 *     src) → a SUÍTE COMPLETA termina com exit != 0 exatamente na     *
 *     sentinela 0.9. O child é protegido contra recursão pelo flag    *
 *     ROOM_INACTIVITY_NO_MUT_CHILD.                                   *
 *   - M2: reverte guarda + query (pré-Correção 4) in-process → os     *
 *     cenários 4.7/4.8/4.9 FALHAM (corrida de double-prompt) e os     *
 *     fluxos intactos permanecem verdes (cirurgia).                   *
 * ================================================================== */
if (!process.env.ROOM_INACTIVITY_NO_MUT_CHILD) {
  const CHILD_SUITE = path.join(REPO, "tests", "test_room_inactivity_watchdog.mjs");
  const BUSY_QUERY_EXCLUSION_LITERAL =
    `"SELECT name FROM team_member WHERE team_id = ? AND name != ? AND (status = 'busy' OR execution_status IN ('starting', 'running')) LIMIT 1"`;
  const failLines = (out) => String(out ?? "").split("\n").filter((l) => l.startsWith("FAIL | "));
  const resultLine = (out) => String(out ?? "").split("\n").find((l) => l.startsWith("RESULT: ")) ?? "";

  const runSuiteChild = (id, patchDist, patchSrc) => {
    const pkg = path.join(TMP, `_q4_${id}_pkg`);
    rmSync(pkg, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    mkdirSync(path.join(pkg, "dist"), { recursive: true });
    writeFileSync(path.join(pkg, "dist", "index.js"), distRaw);
    cpSync(SRC, path.join(pkg, "src"), { recursive: true });
    if (patchDist) patchDist(pkg);
    if (patchSrc) patchSrc(pkg);
    return spawnSync(process.execPath, [CHILD_SUITE], {
      encoding: "utf8",
      env: { ...process.env, ENSEMBLE_PKG: pkg, ROOM_INACTIVITY_NO_MUT_CHILD: "1" },
      timeout: 180_000,
      cwd: REPO,
    });
  };

  // M1 reintroduz a exclusão EXATAMENTE como no código antigo: forma
  // condicional (qa ? query com name != qa.name : query unificada), para
  // preservar o caminho sem-QA (6.3) — mutante fiel, não um crash sintético.
  const m1DistFrom = `const busyMember = this.db.query(\n        ${BUSY_QUERY_LITERAL}\n      ).get(team.id);`;
  const m1DistTo =
    `const busyMember = qa\n` +
    `        ? this.db.query(\n            ${BUSY_QUERY_EXCLUSION_LITERAL}\n          ).get(team.id, qa.name)\n` +
    `        : this.db.query(\n            ${BUSY_QUERY_LITERAL}\n          ).get(team.id);`;
  const m1SrcFrom = `const busyMember = this.db.query(\n        ${BUSY_QUERY_LITERAL}\n      ).get(team.id) as { name: string } | null`;
  const m1SrcTo =
    `const busyMember = qa\n` +
    `        ? this.db.query(\n            ${BUSY_QUERY_EXCLUSION_LITERAL}\n          ).get(team.id, qa.name) as { name: string } | null\n` +
    `        : this.db.query(\n            ${BUSY_QUERY_LITERAL}\n          ).get(team.id) as { name: string } | null`;
  const m1DistOcc = distRaw.split(m1DistFrom).length - 1;
  const m1SrcOcc = srcWatchdog.split(m1SrcFrom).length - 1;
  check("7.1 M1 patch do dist aplicável (exclusão name != ?: 1 ocorrência exata)", m1DistOcc === 1, `ocorrências=${m1DistOcc}`);
  check("7.2 M1 patch do src aplicável (exclusão name != ?: 1 ocorrência exata)", m1SrcOcc === 1, `ocorrências=${m1SrcOcc}`);

  // 7.3 Controle: pacote limpo (dist e src intactos) → suíte completa verde.
  {
    const r = runSuiteChild("clean", null, null);
    const fl = failLines(r.stdout);
    check(
      "7.3 controle: suíte completa contra pacote limpo → 100% verde (exit 0, zero FAIL)",
      r.status === 0 && fl.length === 0,
      `exit=${r.status} fails=${fl.length} ${resultLine(r.stdout)}`,
    );
  }

  // 7.4 M1-dist: exclusão reintroduzida no bundle → suíte FALHA só na sentinela 0.9.
  if (m1DistOcc === 1) {
    const r = runSuiteChild("m1dist", (pkg) => {
      const f = path.join(pkg, "dist", "index.js");
      writeFileSync(f, readFileSync(f, "utf8").split(m1DistFrom).join(m1DistTo));
    }, null);
    const fl = failLines(r.stdout);
    check(
      "7.4 M1-dist: suíte completa contra dist COM exclusão name != qa.name → FALHA (exit != 0) na sentinela 0.9",
      r.status !== 0 && fl.length === 1 && fl[0].includes("0.9"),
      `exit=${r.status} fails=${fl.map((l) => l.slice(0, 70)).join(" ; ") || "-"} ${resultLine(r.stdout)}`,
    );
  }

  // 7.5 M1-src: exclusão reintroduzida no fonte → suíte FALHA só na sentinela 0.9.
  if (m1SrcOcc === 1) {
    const r = runSuiteChild("m1src", null, (pkg) => {
      const f = path.join(pkg, "src", "watchdog.ts");
      writeFileSync(f, readFileSync(f, "utf8").split(m1SrcFrom).join(m1SrcTo));
    });
    const fl = failLines(r.stdout);
    check(
      "7.5 M1-src: suíte completa contra src COM exclusão name != qa.name → FALHA (exit != 0) na sentinela 0.9",
      r.status !== 0 && fl.length === 1 && fl[0].includes("0.9"),
      `exit=${r.status} fails=${fl.map((l) => l.slice(0, 70)).join(" ; ") || "-"} ${resultLine(r.stdout)}`,
    );
  }

  // 7.6–7.9 M2: reversão completa da Correção 4 (guarda removida + query
  // com exclusão) no dist, executada in-process com emissão silenciosa.
  const m2From =
    `if (qa && (qa.status === "busy" || qa.executionStatus === "starting" || qa.executionStatus === "running")) {\n` +
    `        continue;\n      }\n` +
    `      const busyMember = this.db.query(\n        ${BUSY_QUERY_LITERAL}\n      ).get(team.id);`;
  const m2To =
    `const busyMember = qa\n` +
    `        ? this.db.query(\n            ${BUSY_QUERY_EXCLUSION_LITERAL}\n          ).get(team.id, qa.name)\n` +
    `        : this.db.query(\n            ${BUSY_QUERY_LITERAL}\n          ).get(team.id);`;
  const m2Occ = distRaw.split(m2From).length - 1;
  check("7.6 M2 patch aplicável (guarda + query revertidas: 1 ocorrência exata no dist)", m2Occ === 1, `ocorrências=${m2Occ}`);
  if (m2Occ === 1) {
    const m2File = path.join(TMP, "_q4_m2_guard_revert.mjs");
    writeFileSync(m2File, buildHarnessFile(distRaw.split(m2From).join(m2To)));
    let m2results = null;
    let m2err = null;
    try {
      m2results = await runRoomInactivityBehavior("m2", await import(m2File), false);
    } catch (e) {
      m2err = e;
    }
    check(
      "7.7 M2 mutante executável (fluxo completo, mesmo nº de checks do dist real)",
      m2err === null && m2results?.size === realDistResults.size,
      `err=${m2err ? String(m2err).slice(0, 120) : "-"} checks=${m2results?.size ?? 0}/${realDistResults.size}`,
    );
    const lookup = (tag) => {
      for (const [k, v] of m2results ?? []) if (k.includes(tag)) return v;
      return undefined;
    };
    const detectTags = ["] 4.7 ", "] 4.8 ", "] 4.9 "];
    const missed = detectTags.filter((t) => lookup(t)?.ok !== false);
    check(
      "7.8 M2 sensibilidade: cenários Correção 4 (4.7/4.8/4.9) FALHAM no mutante — double-prompt detectado",
      missed.length === 0,
      missed.length
        ? `não detectaram: ${missed.map((t) => t.trim()).join(", ")}`
        : `${detectTags.length}/${detectTags.length} sentinelas falharam`,
    );
    const keepTags = ["] 2.1 ", "] 4.3 ", "] 4.6 ", "] 4.10 ", "] 5.1 ", "] 6.1 "];
    const broken = keepTags.filter((t) => lookup(t)?.ok !== true);
    check(
      "7.9 M2 cirurgia: fluxos intactos (2.1/4.3/4.6/4.10/5.1/6.1) preservados verdes no mutante",
      broken.length === 0,
      broken.length
        ? `quebrou: ${broken.map((t) => t.trim()).join(", ")}`
        : `${keepTags.length}/${keepTags.length} verdes preservados`,
    );
    rmSync(m2File, { force: true });
  }

  // Descarte determinístico dos pacotes mutantes (controle incluso).
  for (const id of ["clean", "m1dist", "m1src"]) {
    rmSync(path.join(TMP, `_q4_${id}_pkg`), { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
}

/* ================================================================== *
 * RESULTADO                                                          *
 * ================================================================== */
check("Z.1 ZERO unhandledRejection detectado ao longo de toda a suíte", unhandled.length === 0, `unhandled=${unhandled.length}`);

const failed = results.filter(([, ok]) => !ok);
console.log(`\nRESULT: ${results.length - failed.length}/${results.length} checks passed`);
if (failed.length) {
  console.log("FALHAS ENCONTRADAS:");
  for (const [name] of failed) console.log(`  - ${name}`);
}
process.exit(failed.length ? 1 : 0);
