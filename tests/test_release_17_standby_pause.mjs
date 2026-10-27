#!/usr/bin/env node
/**
 * QUALITY GATE DETERMINÍSTICO — TICKET-RELEASE-17
 * Standby que não pausa: pausa determinística + loop-breaker estreito +
 * remoção do watchdog de inatividade por tempo.
 *
 * Sob teste (código REAL, não simulado — dist/ e src/, SQLite real via
 * node:sqlite em .test-scratch/, transporte de saída capturado):
 *
 *   F1 — pausa determinística:
 *     - `executeTeamStandby` NÃO aborta dentro do executor: o `session.abort`
 *       só acontece no macrotask seguinte (resultado da tool já persistido);
 *     - abort é disparado exatamente 1× com o sessionID do CALLER;
 *     - `team_task_handover` aplica a mesma pausa no transmissor SEM perder o
 *       wake do receptor (promptAsync 1× com a persona dele);
 *     - falha de transporte do abort é fire-and-forget (tool devolve texto,
 *       membro continua em standby, nenhuma exceção escapa).
 *
 *   F1.2 — absorção do abort intencional:
 *     - `handleSessionErrorEvent` consome a marca intencional e NÃO alarma o
 *       lead nem flipa o membro para erro, mesmo com payload de erro que não
 *       casa com a assinatura textual de abort (wording-agnostic);
 *     - erro GENUÍNO (sem marca, payload não-abort) continua alarmando o lead
 *       — a marca é o que muda o destino, não o silêncio global.
 *
 *   F2 — loop-breaker estreito:
 *     - 3º `team_standby` consecutivo devolve o aviso de breaker e re-arma o
 *       contador (4ª chamada recomeça em 1);
 *     - `noteToolCall` com QUALQUER outra tool zera a cadeia: nunca dispara o
 *       breaker em exploração legítima (bash/read/grep).
 *
 *   F3 — watchdog sem inatividade por tempo, Clara intacta:
 *     - `checkStalled` não existe mais (método ausente no objeto real);
 *     - `checkRoomInactivity` continua existindo e preserva o texto do alerta
 *       da Clara ("Room has been inactive");
 *     - nenhum literal de sweep por tempo (`timed_out`, `stallThresholdMs`)
 *       sobrevive no watchdog (comentários desconsiderados).
 *
 * Único ponto de emenda: o TRANSPORTE DE SAÍDA (promptAsync / abort / get /
 * showToast) é gravado num array para provar O QUE foi chamado. Nenhuma
 * lógica de decisão é substituída: sem mock library, sem stub de banco.
 *
 * Uso:  node tests/test_release_17_standby_pause.mjs
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
const HARNESS = path.join(TMP, "_release17_harness.mjs");
const SRC_COPY = path.join(TMP, "ensemble_src-release17");
const ROOT = path.join(TMP, "release17_suite");

const results = [];
const check = (name, ok, detail) => {
  results.push([name, ok]);
  console.log(`${ok ? "PASS" : "FAIL"} | ${name}${detail ? " | " + detail : ""}`);
};

/* ================================================================== *
 * 0. SINTAXE — node --check dist/index.js (exit 0)
 * ================================================================== */
{
  const r = spawnSync(process.execPath, ["--check", DIST], { encoding: "utf8" });
  check("node --check dist/index.js → exit 0", r.status === 0, `status=${r.status}${r.stderr ? " stderr=" + r.stderr.trim().slice(0, 200) : ""}`);
}

/* ================================================================== *
 * 1. HARNESS DO DIST — bundle real + cláusulas de export anexadas
 * ================================================================== */
const REQUIRED_SYMBOLS = [
  "executeTeamStandby", "setMemberStandby", "executeTeamTaskHandover",
  "handleSessionErrorEvent", "isAbortError",
  "scheduleStandbyAbort", "incrementStandbyLoop",
  "noteToolCall", "resetStandbyLoop", "consumeIntentionalAbort",
  "markIntentionalAbort", "STANDBY_LOOP_LIMIT",
  "Watchdog", "createDb", "MemberRegistry", "ProgressTracker",
  "DEFAULT_CONFIG", "MIGRATIONS",
];
const distRaw = readFileSync(DIST, "utf8");
{
  const missing = REQUIRED_SYMBOLS.filter(
    (s) => !new RegExp(`(async\\s+)?(function|class|var|const|let)\\s+${s}\\b`).test(distRaw),
  );
  check("dist declara todos os símbolos exigidos pela suíte", missing.length === 0, missing.join(",") || `${REQUIRED_SYMBOLS.length} símbolos`);

  const existingExport = distRaw.match(/export\s*\{([^}]*)\}\s*;?\s*$/)?.[1] ?? "";
  const already = new Set(existingExport.split(",").map((s) => s.trim().split(/\s+as\s+/).pop()).filter(Boolean));
  const need = REQUIRED_SYMBOLS.filter((s) => !already.has(s));
  const EXPORT_APPEND = need.length ? `\nexport { ${need.join(", ")} };\n` : "";
  writeFileSync(HARNESS, distRaw + EXPORT_APPEND);
  check(
    "harness do dist = bundle byte-a-byte + apenas cláusulas de export anexadas",
    readFileSync(HARNESS, "utf8") === distRaw + EXPORT_APPEND,
    `${distRaw.length} bytes; anexados=[${need.join(",")}]`,
  );
}

/* ================================================================== *
 * 2. CÓPIA DO SRC (type-stripping do Node recusa node_modules)
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
        if (existsSync(base + ext) && !spec.endsWith(ext)) { rewritten++; return a + spec + ext + c; }
      }
      return m;
    });
    if (after !== before) writeFileSync(file, after);
  }
  return rewritten;
}
check("cópia do src preparada (só resolução de extensão de import, lógica intacta)", prepareSrcCopy() > 0);

/* ================================================================== *
 * 3. PARIDADE src ↔ dist + contrato estrutural do watchdog
 * ================================================================== */
function readSrc(rel) { return readFileSync(path.join(SRC, rel), "utf8"); }
const stripComments = (text) => text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
const srcGuard = readSrc("standby-guard.ts");
const srcStandby = readSrc("tools/team-standby.ts");
const srcHandover = readSrc("tools/team-task-handover.ts");
const srcHooks = readSrc("hooks.ts");
const srcWatchdog = readSrc("watchdog.ts");
const srcConfig = readSrc("config.ts");

function marker(label, srcText, needle) {
  const srcHit = needle instanceof RegExp ? needle.test(srcText) : srcText.includes(needle);
  const distHit = needle instanceof RegExp ? needle.test(distRaw) : distRaw.includes(needle);
  check(`paridade src↔dist: ${label}`, srcHit && distHit, `src=${srcHit} dist=${distHit}`);
}
marker("scheduleStandbyAbort declarado (standby-guard.ts)", srcGuard, "scheduleStandbyAbort");
marker("marca de abort intencional (standby-guard.ts)", srcGuard, "markIntentionalAbort");
marker("limite do breaker = 3 (standby-guard.ts)", srcGuard, /STANDBY_LOOP_LIMIT = 3/);
marker("team_standby agenda a pausa (tools/team-standby.ts)", srcStandby, "scheduleStandbyAbort");
marker("team_standby emite standby:loop-breaker", srcStandby, "standby:loop-breaker");
marker("handover agenda a pausa do transmissor", srcHandover, "scheduleStandbyAbort");
marker("hooks consome a marca intencional", srcHooks, /consumeIntentionalAbort\(sessionId\)/);
marker("watchdog preserva o alerta da Clara", srcWatchdog, "Room has been inactive");

{
  const wd = stripComments(srcWatchdog);
  check("watchdog: checkStalled removido (sem sweep de stall)", !/checkStalled/.test(wd), wd.match(/checkStalled/g)?.join(",") ?? "ausente");
  check("watchdog: nenhum sweep por tempo (timed_out / stallThresholdMs)", !/timed_out|stallThresholdMs/.test(wd));
  check("watchdog: checkRoomInactivity preservado (função real)", /async checkRoomInactivity\s*\(/.test(wd));
  const distWd = stripComments(distRaw);
  check("dist: checkStalled não existe no bundle", !/checkStalled/.test(distWd), distWd.match(/checkStalled/g)?.join(",") ?? "ausente");
  const cfg = stripComments(srcConfig);
  check("config: timeoutMs/stallThresholdMs/stallMinSteps/stallTokenThreshold removidos", !/timeoutMs|stallThresholdMs|stallMinSteps|stallTokenThreshold/.test(cfg));
}

/* ================================================================== *
 * 4. ANTI-MOCK (Fail-Fast) — varredura determinística em produção
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
    const text = stripComments(readFileSync(file, "utf8"));
    for (const rx of FORBIDDEN) {
      if (rx.test(text)) offenders.push(`${path.relative(SRC_COPY, file)} :: ${rx}`);
    }
  }
  check("zero mocks/stubs/spies em produção (src/**/*.ts)", offenders.length === 0, offenders.join(" | "));
}

/* ================================================================== *
 * 5. FIXTURES — SQLite REAL, transporte capturado
 * ================================================================== */
const newCalls = () => ({ promptAsync: [], abort: [], sessionCreate: [], toast: [], sessionGet: [] });

function makeClient(calls, opts = {}) {
  return {
    session: {
      create: async (o) => { calls.sessionCreate.push(o); return { data: { id: `ses_child_${calls.sessionCreate.length}` } }; },
      promptAsync: async (o) => { calls.promptAsync.push(o); return {}; },
      abort: async (o) => {
        calls.abort.push(o);
        if (opts.abortFails) throw new Error("injected abort transport failure");
        return {};
      },
      get: async (o) => { calls.sessionGet.push(o); return opts.getSessionResponse ?? { data: {} }; },
    },
    tui: { showToast: async (o) => { calls.toast.push(o); return {}; }, selectSession: async () => ({}) },
    worktree: { create: async () => ({ data: { name: "w", branch: "b", directory: "/tmp/w" } }), remove: async () => ({}) },
    workspace: { create: async () => ({ data: { id: "ws_1" } }), remove: async () => ({}) },
  };
}

const TEAM_ID = "team_r17";
const LEAD_SESSION = "ses_r17_lead";
const flushMacrotask = () => new Promise((r) => setImmediate(r));

async function runBehavior(label, mods) {
  const {
    executeTeamStandby, executeTeamTaskHandover, handleSessionErrorEvent,
    getStandbyLoopCount, noteToolCall, clearStandbyGuard,
    Watchdog, createDb, MemberRegistry, ProgressTracker, DEFAULT_CONFIG,
  } = mods;
  // getStandbyLoopCount/clearStandbyGuard are tree-shaken from the bundle when
  // unused by index.ts; when absent the suite proves the SAME contract through
  // the observable breaker text instead of internal counters.
  const countOf = typeof getStandbyLoopCount === "function" ? getStandbyLoopCount : () => null;
  const clearGuard = typeof clearStandbyGuard === "function" ? clearStandbyGuard : () => {};

  const root = `${ROOT}_${label}`;
  rmSync(root, { recursive: true, force: true });
  mkdirSync(root, { recursive: true });
  const db = createDb(path.join(root, "ensemble.db"));
  const now = Date.now();

  db.run(
    "INSERT INTO team (id, name, project_id, lead_session_id, status, delegate, time_created, time_updated) VALUES (?,?,?,?,?,?,?,?)",
    [TEAM_ID, "release17-suite", "default", LEAD_SESSION, "active", 0, now, now],
  );
  const seedMember = (name, sessionId, extra = {}) => {
    db.run(
      `INSERT INTO team_member (team_id, name, session_id, agent, status, execution_status, model, time_created, time_updated, worktree_dir, spawn_context)
       VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
      [TEAM_ID, name, sessionId, extra.agent ?? "build", extra.status ?? "busy", extra.executionStatus ?? "running",
        extra.model ?? "prov/m#low", now, now, extra.worktreeDir ?? null, extra.spawnContext ?? null],
    );
  };
  const registry = new MemberRegistry();
  const progressTracker = new ProgressTracker();
  const calls = newCalls();
  const client = makeClient(calls);
  const deps = { db, registry, tracker: {}, purgeApprovals: {}, client, directory: root, config: DEFAULT_CONFIG, progressTracker };
  const member = (name) => db.query("SELECT * FROM team_member WHERE team_id = ? AND name = ?").get(TEAM_ID, name);
  const systemMsgs = () => db.query("SELECT content FROM team_message WHERE team_id = ? AND from_name = 'system'").all(TEAM_ID);

  for (const [name, session] of [["p1", "ses_r17_p1"], ["p2", "ses_r17_p2"], ["p3", "ses_r17_p3"], ["p4", "ses_r17_p4"], ["tx", "ses_r17_tx"], ["rx", "ses_r17_rx"]]) {
    seedMember(name, session);
    registry.register(TEAM_ID, name, session);
    clearGuard(session);
  }

  /* ---------------------------------------------------------------- *
   * F1 — pausa determinística do team_standby
   * ---------------------------------------------------------------- */
  {
    const before = calls.abort.length;
    const ret = await executeTeamStandby(deps, { reason: "waiting for review" }, "ses_r17_p1");
    check(
      `[${label}] F1a: executor NÃO aborta dentro da tool (pausa é pós-resultado)`,
      calls.abort.length === before,
      `abort=${calls.abort.length - before} imediatamente após await`,
    );
    check(`[${label}] F1a: team_standby devolve confirmação e entra em standby`, /Entered standby mode/.test(ret) && member("p1")?.execution_status === "standby", `status=${member("p1")?.execution_status}`);
    check(`[${label}] F1a: standby mantém status='ready' (janela de wake intacta)`, member("p1")?.status === "ready", member("p1")?.status);

    await flushMacrotask();
    await flushMacrotask();
    const aborts = calls.abort.slice(before);
    check(
      `[${label}] F1b: abort disparado 1× no macrotask seguinte, no caller`,
      aborts.length === 1 && aborts[0]?.sessionID === "ses_r17_p1",
      `abort=${aborts.length} ids=${aborts.map((a) => a.sessionID).join(",")}`,
    );

    /* F1.2 — abort intencional absorvido (wording-agnostic) */
    const beforeMsgs = systemMsgs().length;
    handleSessionErrorEvent(db, registry, client, "ses_r17_p1", { name: "ProviderError", data: { message: "internal boom after pause" } });
    check(
      `[${label}] F1.2a: erro com marca intencional NÃO alarma o lead (payload não-abort)`,
      systemMsgs().length === beforeMsgs,
      `system=${systemMsgs().length - beforeMsgs}`,
    );
    check(`[${label}] F1.2b: membro pausado NÃO é flipado para erro`, member("p1")?.status === "ready", member("p1")?.status);

    /* Controle: sem marca, o mesmo payload é um erro genuíno → alerta */
    const beforeGenuine = systemMsgs().length;
    handleSessionErrorEvent(db, registry, client, "ses_r17_p2", { name: "ProviderError", data: { message: "genuine crash" } });
    check(
      `[${label}] F1.2c: erro GENUÍNO (sem marca) continua alarmando o lead`,
      systemMsgs().length === beforeGenuine + 1 && /genuine crash/.test(systemMsgs().at(-1)?.content ?? ""),
      `system=${systemMsgs().length - beforeGenuine}`,
    );
  }

  /* ---------------------------------------------------------------- *
   * F1.3 — handover: transmissor pausa, receptor acorda
   * ---------------------------------------------------------------- */
  {
    db.run(
      "INSERT INTO team_task (id, team_id, content, status, priority, assignee, time_created, time_updated) VALUES (?,?,?,?,?,?,?,?)",
      ["task_r17_h", TEAM_ID, "handover card", "in_progress", "high", "tx", now, now],
    );
    db.run("UPDATE team_member SET execution_status = 'idle', status = 'ready' WHERE team_id = ? AND name = ?", [TEAM_ID, "rx"]);
    const abortBefore = calls.abort.length;
    const promptsBefore = calls.promptAsync.length;
    const ret = await executeTeamTaskHandover(deps, { task_id: "task_r17_h", to: "rx", notes: "baton to you" }, "ses_r17_tx");
    check(`[${label}] F1.3a: handover devolve confirmação`, /Handed over task "task_r17_h" to rx/.test(ret), ret.slice(0, 120));
    check(`[${label}] F1.3b: card reatribuído ao receptor`, db.query("SELECT assignee FROM team_task WHERE id = ?").get("task_r17_h")?.assignee === "rx");
    check(`[${label}] F1.3c: transmissor entra em standby`, member("tx")?.execution_status === "standby", member("tx")?.execution_status);
    check(
      `[${label}] F1.3d: wake do receptor preservado (promptAsync 1×, persona dele)`,
      calls.promptAsync.length === promptsBefore + 1 && calls.promptAsync.at(-1)?.sessionID === "ses_r17_rx" && calls.promptAsync.at(-1)?.agent === "build",
      `prompts=${calls.promptAsync.length - promptsBefore} agent=${calls.promptAsync.at(-1)?.agent}`,
    );
    await flushMacrotask();
    await flushMacrotask();
    const aborts = calls.abort.slice(abortBefore);
    check(
      `[${label}] F1.3e: pausa do transmissor disparada 1× no caller`,
      aborts.length === 1 && aborts[0]?.sessionID === "ses_r17_tx",
      `abort=${aborts.length} ids=${aborts.map((a) => a.sessionID).join(",")}`,
    );
  }

  /* ---------------------------------------------------------------- *
   * F2 — loop-breaker estreito (3 consecutivas) + reset por outra tool
   * ---------------------------------------------------------------- */
  {
    const ret1 = await executeTeamStandby(deps, {}, "ses_r17_p3");
    await flushMacrotask();
    const ret2 = await executeTeamStandby(deps, {}, "ses_r17_p3");
    await flushMacrotask();
    check(
      `[${label}] F2a: 1ª e 2ª standby NÃO disparam o breaker`,
      !/Repetition breaker/.test(ret1) && !/Repetition breaker/.test(ret2) && [null, 2].includes(countOf("ses_r17_p3")),
      `count=${countOf("ses_r17_p3")}`,
    );
    const ret3 = await executeTeamStandby(deps, {}, "ses_r17_p3");
    await flushMacrotask();
    check(
      `[${label}] F2b: 3ª standby consecutiva dispara o breaker (count=3)`,
      /Repetition breaker fired after 3 consecutive team_standby/.test(ret3),
      ret3.slice(0, 140),
    );
    check(`[${label}] F2c: breaker re-arma o contador`, [null, 0].includes(countOf("ses_r17_p3")), `count=${countOf("ses_r17_p3")}`);
    const ret4 = await executeTeamStandby(deps, {}, "ses_r17_p3");
    await flushMacrotask();
    check(
      `[${label}] F2d: 4ª standby é tratada como 1ª (sem breaker)`,
      !/Repetition breaker/.test(ret4) && [null, 1].includes(countOf("ses_r17_p3")),
      `count=${countOf("ses_r17_p3")}`,
    );

    /* Exploração legítima nunca dispara o breaker */
    clearGuard("ses_r17_p4");
    await executeTeamStandby(deps, {}, "ses_r17_p4");
    await flushMacrotask();
    await executeTeamStandby(deps, {}, "ses_r17_p4");
    await flushMacrotask();
    noteToolCall("ses_r17_p4", "bash");
    check(`[${label}] F2e: outra tool zera a cadeia (bash após 2 standbys)`, [null, 0].includes(countOf("ses_r17_p4")), `count=${countOf("ses_r17_p4")}`);
    const afterTool = await executeTeamStandby(deps, {}, "ses_r17_p4");
    await flushMacrotask();
    check(
      `[${label}] F2f: após exploração legítima o standby recomeça em 1 (sem falso alarme)`,
      !/Repetition breaker/.test(afterTool) && [null, 1].includes(countOf("ses_r17_p4")),
      `count=${countOf("ses_r17_p4")}`,
    );
  }

  /* ---------------------------------------------------------------- *
   * F3 — abort fire-and-forget em falha de transporte
   * ---------------------------------------------------------------- */
  {
    const callsFail = newCalls();
    const clientFail = makeClient(callsFail, { abortFails: true });
    const depsFail = { ...deps, client: clientFail };
    const errBefore = systemMsgs().filter((m) => /session error/.test(m.content)).length;
    let thrown = "";
    let ret = "";
    try {
      ret = await executeTeamStandby(depsFail, { reason: "transport down" }, "ses_r17_p2");
      await flushMacrotask();
      await flushMacrotask();
    } catch (e) {
      thrown = e instanceof Error ? e.message : String(e);
    }
    check(
      `[${label}] F3a: falha do abort não escapa da tool (fire-and-forget)`,
      thrown === "" && /Entered standby mode/.test(ret) && callsFail.abort.length === 1,
      thrown || `abort=${callsFail.abort.length}`,
    );
    check(`[${label}] F3b: standby persistido mesmo com abort falhando`, member("p2")?.execution_status === "standby", member("p2")?.execution_status);
    check(
      `[${label}] F3c: sem alarme falso ao lead por falha de transporte do abort`,
      systemMsgs().filter((m) => /session error/.test(m.content)).length === errBefore,
      `novos=${systemMsgs().filter((m) => /session error/.test(m.content)).length - errBefore}`,
    );
  }

  /* ---------------------------------------------------------------- *
   * F4 — watchdog real: sem sweep de stall, Clara intacta
   * ---------------------------------------------------------------- */
  {
    const wd = new Watchdog({
      db,
      client,
      registry,
      progressTracker,
      config: DEFAULT_CONFIG,
      directory: root,
    });
    check(`[${label}] F4a: Watchdog real NÃO expõe checkStalled`, typeof wd.checkStalled === "undefined");
    check(
      `[${label}] F4b: Watchdog real preserva checkRoomInactivity e checkChatty`,
      typeof wd.checkRoomInactivity === "function" && typeof wd.checkChatty === "function",
      `room=${typeof wd.checkRoomInactivity} chatty=${typeof wd.checkChatty}`,
    );
    check(`[${label}] F4c: Watchdog real preserva cleanupStaleWorktrees`, typeof wd.cleanupStaleWorktrees === "function");
    wd.dispose?.();
  }

  db.close();
}

/* ================================================================== *
 * 6. EXECUÇÃO — dist (artefato real) e src (fonte real)
 * ================================================================== */
const distMods = await import(HARNESS);
check("dist expõe a API comportamental necessária", REQUIRED_SYMBOLS.every((s) => distMods[s] !== undefined), REQUIRED_SYMBOLS.filter((s) => distMods[s] === undefined).join(","));
await runBehavior("dist", distMods);

const srcMods = {
  ...(await import(`${SRC_COPY}/standby-guard.ts`)),
  ...(await import(`${SRC_COPY}/tools/team-standby.ts`)),
  ...(await import(`${SRC_COPY}/tools/team-task-handover.ts`)),
  ...(await import(`${SRC_COPY}/hooks.ts`)),
  ...(await import(`${SRC_COPY}/watchdog.ts`)),
  ...(await import(`${SRC_COPY}/db.ts`)),
  ...(await import(`${SRC_COPY}/state.ts`)),
  ...(await import(`${SRC_COPY}/progress.ts`)),
  ...(await import(`${SRC_COPY}/config.ts`)),
  MIGRATIONS: (await import(`${SRC_COPY}/schema.ts`)).MIGRATIONS,
};
check("src carrega a API comportamental necessária", REQUIRED_SYMBOLS.every((s) => srcMods[s] !== undefined), REQUIRED_SYMBOLS.filter((s) => srcMods[s] === undefined).join(","));
await runBehavior("src", srcMods);

/* ================================================================== *
 * 7. VEREDITO
 * ================================================================== */
const failed = results.filter(([, ok]) => !ok);
console.log(`\nRESULT: ${results.length - failed.length}/${results.length} checks passed`);
if (failed.length) {
  console.log("FALHAS:");
  for (const [name] of failed) console.log(`  - ${name}`);
}
process.exit(failed.length ? 1 : 0);
