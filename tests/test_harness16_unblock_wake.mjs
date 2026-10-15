#!/usr/bin/env node
/**
 * QUALITY GATE DETERMINÍSTICO — HARNESS-16 (T11): Wake Incondicional do
 * Assignee no Desbloqueio + Watchdog de Inatividade da Sala
 * @maiteuxzanela/ensemble-room-lowcost
 *
 * Sob teste (código REAL, sem mocks de decisão):
 *   - src/tools/team-tasks-complete.ts — ao resolver `depends_on`, o
 *     assignee PRÉ-ATRIBUÍDO é acordado INCONDICIONALMENTE (não importa
 *     ready / idle / busy): o bug original só dispara para standby
 *     (resolveStandbyWake) e o dono dormia com o status já avançado
 *     (deadlock silencioso). Os 3 estados são cobertos aqui:
 *       (a) ready/idle  → 1 promptAsync ao assignee, com agent + model;
 *       (b) busy        → 1 promptAsync (mesmo caminho incondicional);
 *       (c) standby     → 1 promptAsync com PREPEND de spawn_context
 *                         (caminho standby byte-compatível, transição
 *                         execution_status → 'starting').
 *   - src/watchdog.ts checkRoomInactivity — (d) roomInactivityThresholdMs
 *     > 0 + sala inativa + tarefas pendentes → 1 wake à QA (is_qa,
 *     Migration 14); threshold = 0 → 0 wakes (gate de desativação);
 *     re-chamada dentro do threshold → 0 wakes (cooldown).
 *   - src/tools/shared.ts resolveStandbyWake — janela atômica
 *     standby → starting + prepend de spawn_context.
 *
 * Único ponto de emenda do dist: cláusulas de export anexadas à cópia do
 * bundle (padrão homologado). Único "client": TRANSPORT RECORDER
 * (promptAsync / abort / session.create / showToast capturados). Bancos
 * são SQLite REAIS (node:sqlite) com TODAS as migrations.
 *
 * Uso:  node tests/test_harness16_unblock_wake.mjs
 * Exit: 0 = todos os checks PASS; 1 = há FAIL.
 */

import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";

// Pacote sob teste: a raiz deste repositório (src/ + dist/ locais).
const REPO = path.resolve(import.meta.dirname, "..");
const PKG = process.env.ENSEMBLE_PKG || REPO;
const DIST = path.join(PKG, "dist/index.js");
const SRC = path.join(PKG, "src");
// Scratch isolado, recriado a cada execução e coberto pelo .gitignore.
const TMP = path.join(REPO, ".test-scratch");
mkdirSync(TMP, { recursive: true });

const HARNESS = path.join(TMP, "_harness16_harness.mjs");
const SRC_COPY = path.join(TMP, "ensemble_src_harness16");
const ROOT = path.join(TMP, "h16_suite");

const results = [];
const check = (name, ok, detail) => {
  results.push([name, ok]);
  console.log(`${ok ? "PASS" : "FAIL"} | ${name}${detail ? " | " + detail : ""}`);
};
const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);

// Rejeições não tratadas são falha de homologação: todos os wakes desta
// suíte têm fail-safe .catch obrigatório.
const unhandled = [];
process.on("unhandledRejection", (e) => unhandled.push(e));

/** Flush de microtasks + macrotasks — os wakes são fire-and-forget. */
const tick = async (n = 5) => {
  for (let i = 0; i < n; i++) await new Promise((r) => setImmediate(r));
};

/* ================================================================== *
 * 0. SINTAXE — node --check dist/index.js (exit 0)                   *
 * ================================================================== */
{
  const r = spawnSync(process.execPath, ["--check", DIST], { encoding: "utf8" });
  check(
    "F) node --check dist/index.js → exit 0",
    r.status === 0,
    `status=${r.status}${r.stderr ? " stderr=" + r.stderr.trim().slice(0, 200) : ""}`,
  );
}

/* ================================================================== *
 * 1. HARNESS DO DIST — bundle real + cláusulas de export anexadas    *
 * ================================================================== */
const REQUIRED_SYMBOLS = [
  "executeTeamTasksComplete", "Watchdog", "ProgressTracker",
  "createDb", "MemberRegistry", "DEFAULT_CONFIG", "MIGRATIONS",
];
const distRaw = readFileSync(DIST, "utf8");
{
  const missing = REQUIRED_SYMBOLS.filter(
    (s) => !new RegExp(`(function|class|var|const|let)\\s+${s}\\b`).test(distRaw),
  );
  check(
    "dist declara todos os símbolos exigidos pela suíte",
    missing.length === 0,
    missing.join(",") || REQUIRED_SYMBOLS.length + " símbolos",
  );

  const existingExport = distRaw.match(/export\s*\{([^}]*)\}\s*;?\s*$/)?.[1] ?? "";
  const already = new Set(
    existingExport.split(",").map((s) => s.trim().split(/\s+as\s+/).pop()).filter(Boolean),
  );
  const need = REQUIRED_SYMBOLS.filter((s) => !already.has(s));
  const EXPORT_APPEND = need.length ? `\nexport { ${need.join(", ")} };\n` : "";
  writeFileSync(HARNESS, distRaw + EXPORT_APPEND);
  check(
    "harness do dist = bundle byte-a-byte + apenas cláusulas de export anexadas (sem duplicatas)",
    readFileSync(HARNESS, "utf8") === distRaw + EXPORT_APPEND,
    `${distRaw.length} bytes; anexados=[${need.join(",")}]`,
  );
}

/* ================================================================== *
 * 2. CÓPIA DO SRC (type-stripping do Node recusa node_modules)       *
 * ================================================================== */
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
check("cópia do src preparada (só resolução de extensão de import, lógica intacta)", prepareSrcCopy() > 0);

/* ================================================================== *
 * 3. PARIDADE src ↔ dist dos marcadores HARNESS-16                   *
 * ================================================================== */
function readSrc(rel) {
  return readFileSync(path.join(SRC, rel), "utf8");
}
const srcComplete = readSrc("tools/team-tasks-complete.ts");
const srcWatchdog = readSrc("watchdog.ts");
const srcShared = readSrc("tools/shared.ts");

// (a/b/c) O wake incondicional do assignee: ramo `wakeTarget === t.assignee`
// chamando promptModelAwareWake com logTag tasks-complete:wake-member.
{
  const proximidade = /promptModelAwareWake\(deps\.client,[\s\S]{0,500}tasks-complete:wake-member/;
  check("paridade (src): wake incondicional usa promptModelAwareWake + logTag wake-member", proximidade.test(srcComplete), srcComplete.match(proximidade)?.[0]?.slice(0, 120) ?? "ausente");
  check("paridade (dist): wake incondicional usa promptModelAwareWake + logTag wake-member", proximidade.test(distRaw), distRaw.match(proximidade)?.[0]?.slice(0, 120) ?? "ausente");
  check(
    "paridade src↔dist: ramo incondicional `wakeTarget === t.assignee`",
    srcComplete.includes("wakeTarget === t.assignee") && distRaw.includes("wakeTarget === t.assignee"),
  );
  check(
    "paridade src↔dist: marcador de log unconditional=true (T10/T11)",
    srcComplete.includes("unconditional=true") && distRaw.includes("unconditional=true"),
  );
  check(
    "paridade src↔dist: texto de desbloqueio do assignee",
    srcComplete.includes("was unblocked and is ready for you to start")
      && distRaw.includes("was unblocked and is ready for you to start"),
  );
  check(
    "paridade src↔dist: standby via resolveStandbyWake no unblock (prepend de spawn_context)",
    srcComplete.includes("resolveStandbyWake(deps.db, teamInfo.teamId, wakeTarget")
      && distRaw.includes("resolveStandbyWake(deps.db, teamInfo.teamId, wakeTarget"),
  );
  check(
    "paridade (src): comentário HARNESS-16 UNCONDITIONAL documenta o fix",
    srcComplete.includes("HARNESS-16 UNCONDITIONAL"),
  );
}

// (d) Watchdog de inatividade: gate threshold === 0 + wake da QA.
{
  check(
    "paridade src↔dist: gate `roomInactivityThresholdMs === 0` desativa checkRoomInactivity",
    srcWatchdog.includes("this.roomInactivityThresholdMs === 0")
      && distRaw.includes("this.roomInactivityThresholdMs === 0"),
  );
  check(
    "paridade src↔dist: marcador watchdog:room-inactivity:wake-clara",
    srcWatchdog.includes("watchdog:room-inactivity:wake-clara")
      && distRaw.includes("watchdog:room-inactivity:wake-clara"),
  );
  check(
    "paridade src↔dist: texto do wake de inatividade",
    srcWatchdog.includes("Room has been inactive for") && distRaw.includes("Room has been inactive for"),
  );
  check(
    "paridade src↔dist: resolveStandbyWake no wake da QA (caminho standby da sala)",
    srcWatchdog.includes("resolveStandbyWake(this.db, team.id, qa.name")
      && distRaw.includes("resolveStandbyWake(this.db, team.id, qa.name"),
  );
  check(
    "paridade (src): resolveStandbyWake faz prepend de spawn_context em texto",
    srcShared.includes("`${context}\\n\\n${baseText}`"),
  );
}

/* ================================================================== *
 * 4. ANTI-MOCK (fail-fast) — src copiado + bundle                     *
 * ================================================================== */
{
  const FORBIDDEN = [
    /\bMagicMock\b/, /\bjest\.(mock|fn|spyOn)\b/, /\bvi\.(mock|fn|spyOn)\b/,
    /\bsinon\b/, /unittest\.mock/, /mock\.patch\(/, /\bt\.mock\b/,
    /from\s+["'](sinon|testdouble|mock-fs|mockjs)["']/, /require\(["'](sinon|testdouble|mock-fs)["']\)/,
    /\bmockMethod\(/, /\bspyOn\(/,
  ];
  const walk = (dir) =>
    readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
      e.isDirectory() ? walk(path.join(dir, e.name)) : [path.join(dir, e.name)],
    );
  const offenders = [];
  for (const file of walk(SRC_COPY)) {
    if (!/\.tsx?$/.test(file)) continue;
    const text = readFileSync(file, "utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
    for (const rx of FORBIDDEN) {
      if (rx.test(text)) offenders.push(`${path.relative(SRC_COPY, file)} :: ${rx}`);
    }
  }
  check("F) zero mocks/stubs/spies em produção (src/**/*.ts, comentários desconsiderados)", offenders.length === 0, offenders.join(" | "));
  check("F) zero primitivas de mock no bundle", !/MagicMock|jest\.mock|sinon\.|vi\.mock/.test(distRaw));
}

/* ================================================================== *
 * 5. FIXTURES — SQLite REAL, transport recorder, cenários             *
 * ================================================================== */

/**
 * Transport recorder — mesmo seam homologado nas suítes T4/T8
 * (promptAsync / abort / session.create / showToast capturados; nenhuma
 * lógica de decisão substituída).
 */
function makeClient(calls) {
  return {
    session: {
      create: async (o) => {
        calls.sessionCreate.push(o);
        return { data: { id: `ses_child_${calls.sessionCreate.length}` } };
      },
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
        return {};
      },
      selectSession: async () => ({}),
    },
  };
}
const newCalls = () => ({ sessionCreate: [], promptAsync: [], abort: [], toast: [] });

// Modelo do assignee: rung primário da escada (primaryModel no wake).
const MEMBER_MODEL = { providerID: "prov", modelID: "mm", variant: "low" };

async function runBehavior(label, mods) {
  const {
    executeTeamTasksComplete, Watchdog, ProgressTracker,
    createDb, MemberRegistry, DEFAULT_CONFIG, MIGRATIONS,
  } = mods;

  check(
    `[${label}] API comportamental carregada (tasks-complete, watchdog, tracker, db, config)`,
    [executeTeamTasksComplete, Watchdog, ProgressTracker, createDb, MemberRegistry, DEFAULT_CONFIG]
      .every((x) => x !== undefined),
  );
  const migrationsLen = MIGRATIONS?.length ?? 0;
  check(`[${label}] MIGRATIONS extraído (${migrationsLen} migrations)`, migrationsLen >= 11, `len=${migrationsLen}`);
  check(`[${label}] Migration 14 presente (coluna is_qa para a QA agnóstica)`, migrationsLen >= 14, `len=${migrationsLen}`);

  /* --- Bundles de cenário: DB + registry + recorder + deps isolados --- */
  function scenario(name) {
    const root = path.join(ROOT, `${label}_${name}`);
    rmSync(root, { recursive: true, force: true });
    mkdirSync(root, { recursive: true });
    const db = createDb(path.join(root, "ensemble.db"));
    const registry = new MemberRegistry();
    const calls = newCalls();
    const client = makeClient(calls);
    const progressTracker = new ProgressTracker();
    const deps = (config) => ({
      db, registry, tracker: {}, purgeApprovals: {}, client,
      directory: root, config, progressTracker,
    });
    const toSession = (sess, from = 0) =>
      calls.promptAsync.slice(from).filter((c) => c.sessionID === sess);
    return { root, db, registry, calls, client, progressTracker, deps, toSession, close: () => db.close() };
  }

  const seedTeam = (db, id, leadSession, { leadAgent = "dante", time = Date.now() } = {}) =>
    db.run(
      "INSERT INTO team (id, name, project_id, lead_session_id, status, delegate, time_created, time_updated, lead_agent) VALUES (?,?,?,?,?,?,?,?,?)",
      [id, `name-${id}`, "default", leadSession, "active", 0, time, time, leadAgent],
    );
  const seedMember = (db, team, name, sess, { agent = "build", status = "ready", exec = "idle", time = Date.now(), model = null, isQa = 0, spawnContext = null, lastNudgedAt = null } = {}) =>
    db.run(
      `INSERT INTO team_member (team_id, name, session_id, agent, status, execution_status, model, spawn_context, is_qa, last_nudged_at, prompt, time_created, time_updated)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      [team, name, sess, agent, status, exec, model, spawnContext, isQa, lastNudgedAt, "do the work", time, time],
    );
  const seedTask = (db, id, team, status, assignee, dependsOn = null, time = Date.now()) =>
    db.run(
      "INSERT INTO team_task (id, team_id, content, status, priority, assignee, depends_on, time_created, time_updated) VALUES (?,?,?,?,?,?,?,?,?)",
      [id, team, `task ${id}`, status, "medium", assignee, dependsOn, time, time],
    );

  /**
   * Cenário base de DESBLOQUEIO (a/b/c): t1 (pending, assignee C) bloqueia
   * t2 (blocked, assignee M). Concluir t1 desbloqueia t2 e acorda M.
   * `mExec`/`mStatus`/`mSpawnContext` variam o ESTADO do assignee M.
   */
  function unblockFixture(name, { mExec = "idle", mStatus = "ready", mSpawnContext = null } = {}) {
    const f = scenario(name);
    const LEAD = `ses_${name}_lead`;
    const C = "completer";
    const C_SESSION = `ses_${name}_c`;
    const M = "assignee-m";
    const M_SESSION = `ses_${name}_m`;
    seedTeam(f.db, `team_${name}`, LEAD, { leadAgent: "dante" });
    seedMember(f.db, `team_${name}`, C, C_SESSION, { status: "ready", exec: "idle" });
    seedMember(f.db, `team_${name}`, M, M_SESSION, {
      agent: "build", status: mStatus, exec: mExec,
      model: "prov/mm#low", spawnContext: mSpawnContext,
    });
    f.registry.register(`team_${name}`, C, C_SESSION);
    f.registry.register(`team_${name}`, M, M_SESSION);
    seedTask(f.db, `t${name}_1`, `team_${name}`, "pending", C);
    seedTask(f.db, `t${name}_2`, `team_${name}`, "blocked", M, JSON.stringify([`t${name}_1`]));
    return { ...f, LEAD, C, C_SESSION, M, M_SESSION, t1: `t${name}_1`, t2: `t${name}_2`, teamId: `team_${name}` };
  }

  /* ================================================================ *
   * A) Assignee READY/IDLE → 1 wake incondicional com agent + model   *
   * ================================================================ */
  {
    const f = unblockFixture("h16a", { mExec: "idle", mStatus: "ready" });
    const base = f.calls.promptAsync.length;
    const ret = await executeTeamTasksComplete(f.deps(DEFAULT_CONFIG), { task_id: f.t1 }, f.C_SESSION);
    await tick();

    check(
      `[${label}] A1 retorno reflete desbloqueio + wake ("unblocked 1 task", "woke 1 member")`,
      ret.includes("unblocked 1 task") && ret.includes("woke 1 member"),
      ret.slice(0, 120),
    );
    const t2 = f.db.query("SELECT status, assignee FROM team_task WHERE id=?").get(f.t2);
    check(`[${label}] A2 t2 desbloqueada para in_progress (pré-atribuída)`, t2?.status === "in_progress" && t2?.assignee === f.M, `${t2?.status}/${t2?.assignee}`);

    const delta = f.calls.promptAsync.length - base;
    check(`[${label}] A3 EXATAMENTE 1 promptAsync no desbloqueio (não 0, não 2)`, delta === 1, `delta=${delta}`);
    const wakes = f.toSession(f.M_SESSION, base);
    check(`[${label}] A4 o promptAsync é endereçado ao assignee M (ready/idle)`, wakes.length === 1, `wakes=${wakes.length}`);
    check(`[${label}] A5 wake carrega agent 'build' explícito`, wakes[0]?.agent === "build", String(wakes[0]?.agent));
    check(`[${label}] A6 wake carrega model do membro (prov/mm#low)`, eq(wakes[0]?.model, MEMBER_MODEL), JSON.stringify(wakes[0]?.model));
    check(
      `[${label}] A7 texto de desbloqueio + synthetic:true`,
      wakes[0]?.synthetic === true && String(wakes[0]?.parts?.[0]?.text).includes("was unblocked and is ready for you to start"),
      JSON.stringify(wakes[0]?.parts?.[0]?.text?.slice(0, 100)),
    );
    const mRow = f.db.query("SELECT execution_status FROM team_member WHERE team_id=? AND name=?").get(f.teamId, f.M);
    check(`[${label}] A8 ramo NÃO-standby mantém execution_status intacto (idle)`, mRow?.execution_status === "idle", mRow?.execution_status);
    f.close();
  }

  /* ================================================================ *
   * B) Assignee BUSY → 1 wake incondicional (mesmo caminho)           *
   * ================================================================ */
  {
    const f = unblockFixture("h16b", { mExec: "running", mStatus: "busy" });
    const base = f.calls.promptAsync.length;
    const ret = await executeTeamTasksComplete(f.deps(DEFAULT_CONFIG), { task_id: f.t1 }, f.C_SESSION);
    await tick();

    check(`[${label}] B1 retorno reflete "woke 1 member" com assignee busy`, ret.includes("woke 1 member"), ret.slice(0, 120));
    const delta = f.calls.promptAsync.length - base;
    check(`[${label}] B2 EXATAMENTE 1 promptAsync com assignee busy (não 0)`, delta === 1, `delta=${delta}`);
    const wakes = f.toSession(f.M_SESSION, base);
    check(
      `[${label}] B3 wake com agent 'build' + model prov/mm#low (mesmo caminho incondicional)`,
      wakes.length === 1 && wakes[0]?.agent === "build" && eq(wakes[0]?.model, MEMBER_MODEL),
      JSON.stringify({ n: wakes.length, agent: wakes[0]?.agent, model: wakes[0]?.model }),
    );
    const mRow = f.db.query("SELECT execution_status FROM team_member WHERE team_id=? AND name=?").get(f.teamId, f.M);
    check(`[${label}] B4 busy não é revertido (execution_status segue 'running')`, mRow?.execution_status === "running", mRow?.execution_status);
    const t2 = f.db.query("SELECT status FROM team_task WHERE id=?").get(f.t2);
    check(`[${label}] B5 t2 desbloqueada para in_progress`, t2?.status === "in_progress", t2?.status);
    f.close();
  }

  /* ================================================================ *
   * C) Assignee STANDBY → 1 wake com PREPEND de spawn_context         *
   * ================================================================ */
  {
    const SPAWN_CTX = "INIT PROMPT CONTEXT — teammates: cris, ana; lead: dante.";
    const f = unblockFixture("h16c", { mExec: "standby", mStatus: "ready", mSpawnContext: SPAWN_CTX });
    const base = f.calls.promptAsync.length;
    const ret = await executeTeamTasksComplete(f.deps(DEFAULT_CONFIG), { task_id: f.t1 }, f.C_SESSION);
    await tick();

    check(`[${label}] C1 retorno reflete "woke 1 member" com assignee em standby`, ret.includes("woke 1 member"), ret.slice(0, 120));
    const delta = f.calls.promptAsync.length - base;
    check(`[${label}] C2 EXATAMENTE 1 promptAsync com assignee standby`, delta === 1, `delta=${delta}`);
    const wakes = f.toSession(f.M_SESSION, base);
    check(`[${label}] C3 wake endereçado ao assignee standby`, wakes.length === 1, `wakes=${wakes.length}`);
    const text = String(wakes[0]?.parts?.[0]?.text ?? "");
    check(
      `[${label}] C4 texto com PREPEND integral de spawn_context + desbloqueio`,
      text.startsWith(SPAWN_CTX) && text.includes("was unblocked and is ready for you to start"),
      JSON.stringify(text.slice(0, 140)),
    );
    check(
      `[${label}] C5 wake com agent 'build' + model prov/mm#low`,
      wakes[0]?.agent === "build" && eq(wakes[0]?.model, MEMBER_MODEL),
      JSON.stringify({ agent: wakes[0]?.agent, model: wakes[0]?.model }),
    );
    const mRow = f.db.query("SELECT execution_status, spawn_context FROM team_member WHERE team_id=? AND name=?").get(f.teamId, f.M);
    check(
      `[${label}] C6 standby → starting (janela consumida) com spawn_context preservado`,
      mRow?.execution_status === "starting" && mRow?.spawn_context === SPAWN_CTX,
      `${mRow?.execution_status} ctx=${mRow?.spawn_context ? "ok" : "null"}`,
    );
    f.close();
  }

  /* ================================================================ *
   * D) Watchdog de inatividade: threshold 0 → 0 wakes; > 0 → 1 wake à QA *
   * ================================================================ */
  {
    const f = scenario("h16d");
    const LEAD = "ses_h16d_lead";
    const QA = "qa-gate";
    const QA_SESSION = "ses_h16d_qa";
    const OLD = Date.now() - 120_000; // sala inativa há 120s
    seedTeam(f.db, "team_h16d", LEAD, { leadAgent: "dante", time: OLD });
    seedMember(f.db, "team_h16d", QA, QA_SESSION, {
      agent: "build", status: "ready", exec: "idle", time: OLD, isQa: 1,
    });
    seedTask(f.db, "t_h16d_p", "team_h16d", "pending", null, null, OLD); // tarefa não terminada
    // Sem mensagens, membros/tasks com timestamps antigos → inatividade real.

    const mkWatchdog = (thresholdMs) =>
      new Watchdog({
        db: f.db, client: f.client, registry: f.registry,
        ttlMs: 0, progressTracker: f.progressTracker,
        stallThresholdMs: 0, peerMessageLimit: 0,
        roomInactivityThresholdMs: thresholdMs,
      });

    // D1: threshold = 0 → gate de desativação → NENHUM wake, mesmo com
    // sala inativa e tarefas pendentes (a condição que acordaria a QA).
    let base = f.calls.promptAsync.length;
    await mkWatchdog(0).checkRoomInactivity();
    await tick();
    check(
      `[${label}] D1 threshold=0: ZEROS wakes à QA (gate de desativação)`,
      f.calls.promptAsync.length === base,
      `delta=${f.calls.promptAsync.length - base}`,
    );

    // D2: threshold > 0 + sala inativa + tarefas pendentes → 1 wake à QA.
    base = f.calls.promptAsync.length;
    await mkWatchdog(30_000).checkRoomInactivity();
    await tick();
    const qaWakes = f.toSession(QA_SESSION, base);
    check(`[${label}] D2 threshold>0: EXATAMENTE 1 wake à QA`, qaWakes.length === 1, `delta=${qaWakes.length}`);
    check(
      `[${label}] D3 wake da QA: texto de inatividade + agent + synthetic`,
      qaWakes[0]?.agent === "build"
        && qaWakes[0]?.synthetic === true
        && String(qaWakes[0]?.parts?.[0]?.text).startsWith("[System: Room has been inactive for"),
      JSON.stringify(qaWakes[0]?.parts?.[0]?.text?.slice(0, 90)),
    );
    const qaRow = f.db.query("SELECT last_nudged_at, reported_to_lead FROM team_member WHERE team_id=? AND name=?").get("team_h16d", QA);
    check(
      `[${label}] D4 last_nudged_at persistido + reported_to_lead resetado`,
      typeof qaRow?.last_nudged_at === "number" && qaRow.last_nudged_at > 0 && qaRow.reported_to_lead === 0,
      `nudged=${qaRow?.last_nudged_at} reported=${qaRow?.reported_to_lead}`,
    );

    // D5: re-chamada dentro do threshold sem nova atividade → cooldown → 0.
    base = f.calls.promptAsync.length;
    await mkWatchdog(30_000).checkRoomInactivity();
    await tick();
    check(
      `[${label}] D5 idempotência: re-chamada no cooldown NÃO re-acorda a QA (0 wakes)`,
      f.calls.promptAsync.length === base,
      `delta=${f.calls.promptAsync.length - base}`,
    );
    f.close();
  }
}

/* ================================================================== *
 * 6. EXECUÇÃO — dist (artefato real) e src (fonte real)              *
 * ================================================================== */
const distMods = await import(HARNESS);
check(
  "dist expõe a API comportamental necessária",
  REQUIRED_SYMBOLS.every((s) => distMods[s] !== undefined),
  REQUIRED_SYMBOLS.filter((s) => distMods[s] === undefined).join(",") || "ok",
);
await runBehavior("dist", distMods);

const srcMods = {
  ...(await import(`${SRC_COPY}/tools/team-tasks-complete.ts`)),
  ...(await import(`${SRC_COPY}/watchdog.ts`)),
  ...(await import(`${SRC_COPY}/progress.ts`)),
  ...(await import(`${SRC_COPY}/db.ts`)),
  ...(await import(`${SRC_COPY}/state.ts`)),
  ...(await import(`${SRC_COPY}/config.ts`)),
  MIGRATIONS: (await import(`${SRC_COPY}/schema.ts`)).MIGRATIONS,
};
check(
  "src carrega a API comportamental necessária",
  ["executeTeamTasksComplete", "Watchdog", "ProgressTracker", "createDb", "MemberRegistry", "DEFAULT_CONFIG"]
    .every((s) => srcMods[s] !== undefined),
  ["executeTeamTasksComplete", "Watchdog", "ProgressTracker", "createDb", "MemberRegistry", "DEFAULT_CONFIG"]
    .filter((s) => srcMods[s] === undefined).join(",") || "ok",
);
await runBehavior("src", srcMods);

check("f) ZERO unhandledRejection ao longo de toda a suíte", unhandled.length === 0, `${unhandled.length}`);

/* ================================================================== *
 * 7. VEREDITO                                                        *
 * ================================================================== */
const failed = results.filter(([, ok]) => !ok);
console.log(`\nRESULT: ${results.length - failed.length}/${results.length} checks passed`);
if (failed.length) {
  console.log("FALHAS:");
  for (const [name] of failed) console.log(`  - ${name}`);
}
process.exit(failed.length ? 1 : 0);
