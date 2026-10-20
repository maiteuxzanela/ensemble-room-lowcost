#!/usr/bin/env node
/**
 * QUALITY GATE DETERMINÍSTICO — TICKET-HARNESS-38
 * @maiteuxzanela/ensemble-room-lowcost
 *
 * Engenheiro de Testes (SDET): Hugo. Guardiã do Quality Gate: Clara.
 *
 * Escopo (src/ e dist/ REAIS, SQLite real via node:sqlite — SEM MOCKS no
 * código de produção):
 *   M9  src/watchdog.ts — os dois timers do Watchdog ganham `unref()` (nunca
 *       seguram o event loop) e o tick async é envolto em `.catch()` (uma
 *       rejeição em check() não escapa como unhandledRejection); `dispose()`
 *       limpa ambos os timers de forma IDEMPOTENTE (legacy `stop()` delega).
 *   M10 src/progress.ts + src/v2-tools.ts — o report "chatty" é re-armado no
 *       progresso legítimo: mensagem para o lead (`toLead`) e conclusão de
 *       tarefa limpam `chattyReported`; mensagem entre pares NÃO.
 *   M11 src/index.ts + src/v2-setup.ts — `nudgedMembers` (set de supressão de
 *       nudge de idle/fast-idle) é PODADO no shutdown do membro e LIMPO no
 *       shutdown da sala (team_shutdown wildcard / team_cleanup), escopado por
 *       team_id (nunca um clear global que atinja outra sala).
 *   M12 src/config.ts — defaults endurecidos (stallThresholdMs 300000,
 *       stallMinSteps 5, stallTokenThreshold 200).
 *   Limpeza — resíduos de raiz removidos (find_port.*, fix.cjs, patch_*.cjs,
 *       test_post.js, _qa_2ZTuTm/) e `package.json.files` sem "tests".
 *   README  — higienização open source: zero personas privadas, zero caminhos
 *       locais, zero repositórios proprietários, zero IDs de ticket.
 *
 * Seam (sem mocks): dist/src REAIS; SQLite real; o ÚNICO ponto de emenda é o
 * transporte HTTP do SDK (fronteira externa) reduzido a um recorder
 * determinístico que grava o payload efetivamente enviado — nenhuma lógica de
 * decisão é substituída. O `logger` do Watchdog é observado pelo `initLog`
 * real (transporte `app.log`), provando que a rejeição foi de fato capturada.
 *
 * Prova de mutação: mutantes cirúrgicos no bundle dist, cada um detectado por
 * sentinelas (asserções que FALHAM sob a mutação).
 *
 * Uso: node tests/test_ticket_harness_38.mjs
 * Exit: 0 = todos os checks PASS; 1 = há FAIL.
 */

import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

const REPO = path.resolve(import.meta.dirname, "..");
const PKG = process.env.ENSEMBLE_PKG || REPO;
const DIST = path.join(PKG, "dist/index.js");
const SRC = path.join(PKG, "src");
const TMP = path.join(REPO, ".test-scratch", "h38");
mkdirSync(TMP, { recursive: true });

const results = [];
const check = (name, ok, detail) => {
  results.push([name, ok]);
  console.log(`${ok ? "PASS" : "FAIL"} | ${name}${detail ? " | " + detail : ""}`);
};
const unhandled = [];
process.on("unhandledRejection", (e) => unhandled.push(e));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const tick = async (n = 8) => { for (let i = 0; i < n; i++) await new Promise((r) => setImmediate(r)); };
const countOf = (hay, needle) => hay.split(needle).length - 1;
const NOW = () => Date.now();
const mkScratch = (tag) => mkdtempSync(path.join(os.tmpdir(), `ens-h38-${tag}-`));
const cleanupDir = (base) => { try { rmSync(base, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }); } catch { /* best effort */ } };
const cleanup = (base, db) => { try { db?.close(); } catch { /* já fechado */ } cleanupDir(base); };

// ===========================================================================
// 0. Sintaxe do artefato distribuível.
// ===========================================================================
{
  const r = spawnSync(process.execPath, ["--check", DIST], { encoding: "utf8" });
  check("0) node --check dist/index.js → exit 0", r.status === 0, `status=${r.status}`);
}

// ===========================================================================
// 1. Leituras estáticas (src autorais + bundle dist).
// ===========================================================================
const distRaw = readFileSync(DIST, "utf8");
const srcIndex = readFileSync(path.join(SRC, "index.ts"), "utf8");
const srcV2Setup = readFileSync(path.join(SRC, "v2-setup.ts"), "utf8");
const srcV2Tools = readFileSync(path.join(SRC, "v2-tools.ts"), "utf8");
const srcProgress = readFileSync(path.join(SRC, "progress.ts"), "utf8");
const srcWatchdog = readFileSync(path.join(SRC, "watchdog.ts"), "utf8");
const srcConfig = readFileSync(path.join(SRC, "config.ts"), "utf8");

/* ---- M9 — Watchdog timers (unref + catch + dispose idempotente) ---- */
check("1.M9 src e dist: tick async envolto em .catch() (tolerância a rejeição)",
  countOf(srcWatchdog, "this.check().catch((err) => {") === 1 && countOf(distRaw, "this.check().catch((err) => {") === 1,
  `src=${countOf(srcWatchdog, "this.check().catch((err) => {")} dist=${countOf(distRaw, "this.check().catch((err) => {")}`);
check("1.M9 src e dist: room-inactivity tick também envolto em .catch()",
  countOf(srcWatchdog, "this.checkRoomInactivity().catch((err) => {") === 1 && countOf(distRaw, "this.checkRoomInactivity().catch((err) => {") === 1);
check("1.M9 src e dist: unref() no timer principal e no room-inactivity",
  countOf(srcWatchdog, "this.timer?.unref?.()") === 1 && countOf(distRaw, "this.timer?.unref?.()") === 1 &&
    countOf(srcWatchdog, "this.roomInactivityTimer?.unref?.()") === 1 && countOf(distRaw, "this.roomInactivityTimer?.unref?.()") === 1);
check("1.M9 src e dist: dispose() canônico + stop() delegando (alias legado)",
  srcWatchdog.includes("dispose(): void {") && srcWatchdog.includes("stop(): void {") && srcWatchdog.includes("this.dispose()") &&
    distRaw.includes("dispose() {") && distRaw.includes("stop() {") && distRaw.includes("this.dispose();"));
check("1.M9 src e dist: dispose() limpa AMBOS os timers",
  countOf(srcWatchdog, "clearInterval(this.timer)") === 1 && countOf(srcWatchdog, "clearInterval(this.roomInactivityTimer)") === 1 &&
    countOf(distRaw, "clearInterval(this.timer)") === 1 && countOf(distRaw, "clearInterval(this.roomInactivityTimer)") === 1 &&
    srcWatchdog.includes("this.timer = undefined") && srcWatchdog.includes("this.roomInactivityTimer = undefined") &&
    distRaw.includes("this.timer = void 0;") && distRaw.includes("this.roomInactivityTimer = void 0;"));

/* ---- M10 — chatty reset no progresso legítimo ---- */
check("1.M10 src e dist: recordMessage aceita o 2º parâmetro toLead (default false)",
  srcProgress.includes("recordMessage(sessionId: string, toLead = false): void") &&
    distRaw.includes("recordMessage(sessionId, toLead = false) {"));
check("1.M10 src e dist: mensagem ao lead re-arma o report chatty",
  countOf(srcProgress, "if (toLead) this.clearChattyReport(sessionId)") === 1 &&
    countOf(distRaw, "if (toLead) this.clearChattyReport(sessionId);") === 1);
check("1.M10 src e dist: recordTaskComplete também re-arma o chatty",
  countOf(srcProgress, "this.clearChattyReport(sessionId)") === 2 && countOf(distRaw, "this.clearChattyReport(sessionId);") === 2,
  `src=${countOf(srcProgress, "this.clearChattyReport(sessionId)")} dist=${countOf(distRaw, "this.clearChattyReport(sessionId);")}`);
check("1.M10 src e dist: call site V2 roteia toLead (to === 'lead')",
  countOf(srcV2Tools, 'recordMessage(sessionID, to === "lead")') === 1 &&
    countOf(distRaw, 'deps.progressTracker.recordMessage(sessionID, to === "lead");') === 1);

/* ---- M11 — nudgedMembers: poda/limpeza escopada por team_id ---- */
check("1.M11 src e dist: nudgedMembers declarado nas DUAS camadas (V1 index + V2 setup)",
  countOf(srcIndex, "const nudgedMembers = new Set<string>()") === 1 &&
    countOf(srcV2Setup, "const nudgedMembers = new Set<string>()") === 1 &&
    countOf(distRaw, "const nudgedMembers = /* @__PURE__ */ new Set()") === 2);
check("1.M11 src e dist: clearMemberNudges remove as DUAS chaves do membro",
  countOf(srcIndex, "nudgedMembers.delete(`${teamId}:${memberName}`)") === 1 &&
    countOf(srcIndex, "nudgedMembers.delete(`fastidle:${teamId}:${memberName}`)") === 1 &&
    countOf(distRaw, "nudgedMembers.delete(`${teamId}:${memberName}`);") === 1 &&
    countOf(distRaw, "nudgedMembers.delete(`fastidle:${teamId}:${memberName}`);") === 1);
check("1.M11 src e dist: clearTeamNudges usa PREFIXOS escopados por team_id (delete não-global)",
  srcIndex.includes("const idlePrefix = `${teamId}:`") && srcIndex.includes("const fastIdlePrefix = `fastidle:${teamId}:`") &&
    srcIndex.includes("if (key.startsWith(idlePrefix) || key.startsWith(fastIdlePrefix)) nudgedMembers.delete(key)") &&
    distRaw.includes("const idlePrefix = `${teamId}:`;") && distRaw.includes("const fastIdlePrefix = `fastidle:${teamId}:`;") &&
    distRaw.includes("if (key.startsWith(idlePrefix) || key.startsWith(fastIdlePrefix)) nudgedMembers.delete(key);"));
check("1.M11 src e dist: poda no shutdown do membro (evento de status) + nos 2 caminhos do tool",
  countOf(srcIndex, "clearMemberNudges(transition.teamId, transition.memberName)") === 1 &&
    countOf(distRaw, "clearMemberNudges(transition.teamId, transition.memberName);") === 1 &&
    countOf(srcIndex, "clearTeamNudges(callerTeam.teamId)") === 1 &&
    countOf(distRaw, "clearTeamNudges(callerTeam.teamId);") === 1 &&
    countOf(srcIndex, "clearMemberNudges(callerTeam.teamId, memberArg)") === 1 &&
    countOf(distRaw, "clearMemberNudges(callerTeam.teamId, memberArg);") === 1 &&
    countOf(srcIndex, "clearTeamNudges(teamInfoForCleanup.teamId)") === 1 &&
    countOf(distRaw, "clearTeamNudges(teamInfoForCleanup.teamId);") === 1);
check("1.M11 src e dist: V2 poda no shutdown de membro e limpa no teardown do handle",
  countOf(srcV2Setup, 'if (transition && transition.to === "shutdown")') === 1 &&
    countOf(distRaw, 'if (transition && transition.to === "shutdown") {') === 1 &&
    countOf(srcV2Setup, "nudgedMembers.clear()") === 1 && countOf(distRaw, "nudgedMembers.clear();") === 1);
// DEFEITO (HARNESS-38 / M11): no team_shutdown o callerTeam é resolvido DEPOIS
// de executeTeamShutdown. Numa sala arquivada findTeamBySession() devolve
// undefined e TODO o bloco de limpeza (incl. clearTeamNudges) fica inalcançável
// — o set de supressão da sala nunca é limpo. O alias team_cleanup captura
// ANTES e por isso funciona; o wildcard canônico não. A correção espelha o
// alias: resolver o teamId ANTES de executar o shutdown.
{
  const anchor = srcIndex.indexOf("team_shutdown: tool({");
  const resultIdx = srcIndex.indexOf("const result = await executeTeamShutdown", anchor);
  const callerIdx = srcIndex.indexOf("const callerTeam = findTeamBySession(db, registry, ctx.sessionID)", anchor);
  check("1.M11 (DEFEITO) team_shutdown resolve o callerTeam ANTES de executeTeamShutdown (limpeza alcançável)",
    callerIdx > -1 && resultIdx > -1 && callerIdx < resultIdx,
    `callerTeam@${callerIdx} result@${resultIdx} (esperado caller < result)`);
}

/* ---- M12 — defaults endurecidos ---- */
check("1.M12 src e dist: DEFAULT_CONFIG endurecido (300s / 5 steps / 200 tokens)",
  srcConfig.includes("stallThresholdMs: 300_000") && srcConfig.includes("stallMinSteps: 5") && srcConfig.includes("stallTokenThreshold: 200") &&
    distRaw.includes("stallThresholdMs: 3e5") && distRaw.includes("stallMinSteps: 5") && distRaw.includes("stallTokenThreshold: 200"));

/* ---- package.json: files sem "tests" + exports íntegros ---- */
const pkg = JSON.parse(readFileSync(path.join(PKG, "package.json"), "utf8"));
const EXPECTED_FILES = ["dist", "src", "tsconfig.json", "LICENSE", "README.md", "CHANGELOG.md", "SECURITY.md", "social-preview.png"];
check("1.pkg package.json.files não contém 'tests'",
  Array.isArray(pkg.files) && !pkg.files.includes("tests"), JSON.stringify(pkg.files));
check("1.pkg package.json.files = conjunto exato esperado (nada a mais, nada a menos)",
  Array.isArray(pkg.files) && [...pkg.files].sort().join(",") === [...EXPECTED_FILES].sort().join(","),
  JSON.stringify(pkg.files));
check("1.pkg exports apontam para arquivos existentes no disco",
  Object.entries(pkg.exports ?? {}).every(([, rel]) => existsSync(path.join(PKG, rel))),
  JSON.stringify(pkg.exports));

// ===========================================================================
// 2. Harness do bundle dist + cópia do src (type-stripping rejeita node_modules).
// ===========================================================================
const REQUIRED_SYMBOLS = ["createDb", "Watchdog", "ProgressTracker", "initLog", "MemberRegistry", "setupEnsemble", "DEFAULT_CONFIG", "MIGRATIONS"];
const SRC_COPY = path.join(TMP, "ensemble_src_h38");
function buildHarnessCode(raw) {
  const existing = raw.match(/export\s*\{([^}]*)\}\s*;?\s*$/)?.[1] ?? "";
  const already = new Set(existing.split(",").map((s) => s.trim().split(/\s+as\s+/).pop()).filter(Boolean));
  const need = REQUIRED_SYMBOLS.filter((s) => !already.has(s));
  return raw + (need.length ? `\nexport { ${need.join(", ")} };\n` : "");
}
const harnessFile = (raw, name) => {
  const file = path.join(TMP, `${name}.mjs`);
  writeFileSync(file, buildHarnessCode(raw));
  return file;
};
{
  const missing = REQUIRED_SYMBOLS.filter((s) => !new RegExp(`(function|class|var|const|let)\\s+${s}\\b`).test(distRaw));
  check("2.harness dist declara todos os símbolos exigidos", missing.length === 0, missing.join(",") || `${REQUIRED_SYMBOLS.length} símbolos`);
}
const DIST_MOD = await import(harnessFile(distRaw, "_h38_dist"));

function prepareSrcCopy() {
  rmSync(SRC_COPY, { recursive: true, force: true });
  cpSync(SRC, SRC_COPY, { recursive: true });
  let rewritten = 0;
  const walk = (dir) => readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory() ? walk(path.join(dir, e.name)) : [path.join(dir, e.name)]);
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
const rewrittenSpecifiers = prepareSrcCopy();
check("2.src cópia preparada (só extensão de import; lógica intacta)", rewrittenSpecifiers > 0, `${rewrittenSpecifiers} specifiers`);

// ===========================================================================
// 3. Helpers de seed (SQLite real) reutilizados pelos cenários.
// ===========================================================================
function seedProjectAndTeam(db, { teamId, lead, leadAgent = "dante", status = "active" }) {
  const t = NOW();
  db.run("INSERT OR IGNORE INTO project (id, name, path, status, time_created, time_updated) VALUES (?,?,?,?,?,?)", ["default", "Default", "", "active", t, t]);
  db.run(
    "INSERT INTO team (id, name, project_id, lead_session_id, lead_agent, status, delegate, awaiting_lead_decision, time_created, time_updated) VALUES (?,?,?,?,?,?,?,?,?,?)",
    [teamId, teamId, "default", lead, leadAgent, status, 0, 0, t, t]);
}
function insertMember(db, { teamId, name, session, agent, status = "ready", exec = "idle", isQa = 0, role = null, updated = NOW() }) {
  db.run(
    "INSERT INTO team_member (team_id, name, session_id, agent, status, execution_status, model, spawn_context, is_qa, role, reported_to_lead, time_created, time_updated) VALUES (?,?,?,?,?,?,?,?,?,?,0,?,?)",
    [teamId, name, session, agent, status, exec, null, null, isQa, role, updated, updated]);
}
function makeWdClient(calls) {
  const c = calls ?? { abort: [], prompt: [], toast: [] };
  const client = {
    session: {
      abort: async (a) => { c.abort.push(a); return {}; },
      promptAsync: async (a) => { c.prompt.push(a); return {}; },
    },
    tui: { showToast: async (a) => { c.toast.push(a); return {}; } },
    workspace: { remove: async () => ({}) },
    worktree: { remove: async () => ({}) },
  };
  return { calls: c, client };
}

// ===========================================================================
// 4. CENÁRIO WATCHDOG (M9) — dist e src, comportamento real dos timers.
// ===========================================================================
async function scnWatchdog(mod, label) {
  const base = mkScratch(`wd-${label}`);
  const db = mod.createDb(path.join(base, "e.db"));
  const got = new Map();
  const R = (n, ok, d) => got.set(`${label}.${n}`, { ok: !!ok, detail: d === undefined ? "" : String(d) });
  try {
    const wd = new mod.Watchdog({
      db, client: makeWdClient().client, registry: {}, ttlMs: 0, checkIntervalMs: 20,
      progressTracker: new mod.ProgressTracker(), stallThresholdMs: 0, peerMessageLimit: 0,
      roomInactivityThresholdMs: 1000, roomInactivityCheckMs: 20,
    });
    wd.start();
    R("wd.timer-created", !!wd.timer && !!wd.roomInactivityTimer, `main=${!!wd.timer} room=${!!wd.roomInactivityTimer}`);
    R("wd.main-timer-unref", typeof wd.timer?.hasRef === "function" && wd.timer.hasRef() === false, `hasRef=${wd.timer?.hasRef?.()}`);
    R("wd.room-timer-unref", typeof wd.roomInactivityTimer?.hasRef === "function" && wd.roomInactivityTimer.hasRef() === false, `hasRef=${wd.roomInactivityTimer?.hasRef?.()}`);
    R("wd.running-before-dispose", wd.isRunning() === true);
    wd.dispose();
    R("wd.disposed-not-running", wd.isRunning() === false);
    R("wd.dispose-clears-timer-field", wd.timer === undefined && wd.roomInactivityTimer === undefined,
      `main=${String(wd.timer)} room=${String(wd.roomInactivityTimer)}`);
    let idempotent = true;
    try { wd.dispose(); wd.stop(); } catch { idempotent = false; }
    R("wd.dispose-idempotent", idempotent && wd.isRunning() === false);
    R("wd.stop-alias-idempotent", idempotent && wd.isRunning() === false);

    // .catch(): tick async contra um db FECHADO → rejeita; o wrapper deve
    // engolir a rejeição E registrar via o logger real (initLog recorder).
    const logs = [];
    mod.initLog({ app: { log: async (p) => { logs.push(p); return {}; } } });
    const u0 = unhandled.length;
    const db2 = mod.createDb(path.join(base, "b.db"));
    const wd2 = new mod.Watchdog({
      db: db2, client: makeWdClient().client, registry: {}, ttlMs: 0, checkIntervalMs: 15,
      progressTracker: new mod.ProgressTracker(), stallThresholdMs: 0, peerMessageLimit: 0,
      roomInactivityThresholdMs: 0, roomInactivityCheckMs: 0,
    });
    wd2.start();
    db2.close();
    await sleep(90);
    R("wd.catch-swallows", unhandled.length === u0, `unhandled+${unhandled.length - u0}`);
    R("wd.catch-logs", logs.some((l) => String(l.message).startsWith("watchdog:check:err")),
      JSON.stringify(logs.map((l) => l.message).slice(0, 2)));
    wd2.dispose();

    // dispose() antes do primeiro tick: nenhum check roda, membro stale intacto.
    seedProjectAndTeam(db, { teamId: "TW", lead: "ses_lw" });
    insertMember(db, { teamId: "TW", name: "m", session: "ses_m", agent: "build", status: "busy", exec: "running", updated: NOW() - 120_000 });
    const wd3calls = { abort: [], prompt: [], toast: [] };
    const wd3 = new mod.Watchdog({
      db, client: makeWdClient(wd3calls).client, registry: {}, ttlMs: 60_000, checkIntervalMs: 15,
      progressTracker: new mod.ProgressTracker(), stallThresholdMs: 0, peerMessageLimit: 0,
      roomInactivityThresholdMs: 0, roomInactivityCheckMs: 0,
    });
    wd3.start();
    wd3.dispose();
    await sleep(90);
    const row = db.query("SELECT status FROM team_member WHERE team_id = 'TW' AND name = 'm'").get();
    R("wd.no-tick-after-dispose", row?.status === "busy" && wd3calls.abort.length === 0,
      `status=${row?.status} aborts=${wd3calls.abort.length}`);
  } catch (err) {
    R("wd.scenario-executable", false, err?.stack ?? String(err));
  } finally {
    cleanup(base, db);
  }
  return got;
}

// ===========================================================================
// 5. CENÁRIO PROGRESSTRACKER (M10) — re-arme do report chatty.
// ===========================================================================
function scnProgress(mod, label) {
  const got = new Map();
  const R = (n, ok, d) => got.set(`${label}.${n}`, { ok: !!ok, detail: d === undefined ? "" : String(d) });
  const pt = new mod.ProgressTracker();
  const s = "ses_pt";
  for (let i = 0; i < 3; i++) pt.recordPeerMessage(s);
  R("pt.chatty-true", pt.isChatty(s, 3, 60_000) === true);
  pt.markChattyReported(s);
  pt.markReported(s);
  R("pt.mark-chatty-reported", pt.isChattyReported(s) === true && pt.isReported(s) === true);

  // Mensagem entre pares NÃO re-arma o chatty (só limpa o report de stall).
  pt.recordMessage(s);
  R("pt.nonlead-message-keeps-chatty", pt.isChattyReported(s) === true);
  R("pt.nonlead-message-clears-stall", pt.isReported(s) === false);

  // Mensagem ao lead RE-ARMA o chatty.
  pt.markChattyReported(s);
  pt.recordMessage(s, true);
  R("pt.lead-message-clears-chatty", pt.isChattyReported(s) === false);

  // Conclusão de tarefa também re-arma.
  pt.markChattyReported(s);
  pt.recordTaskComplete(s);
  R("pt.taskcomplete-clears-chatty", pt.isChattyReported(s) === false && pt.isReported(s) === false);

  // remove() limpa tudo.
  pt.recordPeerMessage(s);
  pt.markChattyReported(s);
  pt.remove(s);
  R("pt.remove-clears", pt.isChattyReported(s) === false && pt.isChatty(s, 3, 60_000) === false);
  return got;
}

// ===========================================================================
// 6. CENÁRIO PLUGIN (M11) — nudgedMembers podado/limpo no shutdown, com o
//    plugin V1 REAL dirigido pelo event hook e pelo team_shutdown tool.
// ===========================================================================
async function scnPlugin(mod, label) {
  const got = new Map();
  const R = (n, ok, d) => got.set(`${label}.${n}`, { ok: !!ok, detail: d === undefined ? "" : String(d) });
  const base = mkScratch(`plugin-${label}`);
  const HOME = path.join(base, "home");
  const PDIR = path.join(base, "proj");
  mkdirSync(path.join(HOME, ".config", "opencode"), { recursive: true });
  mkdirSync(path.join(PDIR, ".opencode"), { recursive: true });
  writeFileSync(path.join(PDIR, ".opencode", "ensemble.json"), JSON.stringify({ dashboardPort: 0, silentLead: false }));
  const DB = path.join(HOME, ".config", "opencode", "ensemble.db");
  let sql;
  try {
    {
      const db = mod.createDb(DB);
      seedProjectAndTeam(db, { teamId: "TA", lead: "ses_lead_a" });
      seedProjectAndTeam(db, { teamId: "TB", lead: "ses_lead_b" });
      insertMember(db, { teamId: "TA", name: "m1", session: "ses_a1", agent: "build" });
      insertMember(db, { teamId: "TB", name: "m1", session: "ses_b1", agent: "build" });
      db.close();
    }
    const posts = [];
    const ok = (x = {}) => ({ data: { ok: true, ...x } });
    const transport = {
      post: async (o) => { posts.push({ url: o.url, path: o.path, body: o.body }); return ok(); },
      get: async (o) => ok({ id: o.path?.sessionID ?? "x" }),
      delete: async () => ok(), put: async () => ok(), patch: async () => ok(),
    };
    const entry = mod.default;
    R("plugin.server-exposed", typeof entry?.server === "function");
    const prevHome = process.env.HOME;
    process.env.HOME = HOME;
    let inst;
    try { inst = await entry.server({ client: { _client: transport }, directory: PDIR }); }
    finally { process.env.HOME = prevHome; }
    await tick();
    sql = new DatabaseSync(DB);
    const ev = (s, t) => inst.event({ event: { type: "session.status", properties: { sessionID: s, status: { type: t } } } });
    const idleNudge = (s) => posts.filter((p) => String(p.url).includes("prompt_async") && p.path?.sessionID === s &&
      String(p.body?.parts?.[0]?.text ?? "").includes("did not report results")).length;
    const statusOf = (t) => sql.prepare("SELECT status FROM team WHERE id = ?").get(t)?.status;
    const memberStatus = (t) => sql.prepare("SELECT status FROM team_member WHERE team_id = ? AND name = 'm1'").get(t)?.status;
    const reactivate = (t) => sql.prepare("UPDATE team_member SET status = 'ready', execution_status = 'idle', reported_to_lead = 0, time_created = ?, time_updated = ? WHERE team_id = ? AND name = 'm1'").run(NOW(), NOW(), t);

    // Nudge de idle dispara 1x por membro.
    await ev("ses_a1", "busy"); await ev("ses_a1", "idle");
    await ev("ses_b1", "busy"); await ev("ses_b1", "idle");
    await tick(12);
    R("plugin.idle-nudge-A-one", idleNudge("ses_a1") === 1, `n=${idleNudge("ses_a1")}`);
    R("plugin.idle-nudge-B-one", idleNudge("ses_b1") === 1, `n=${idleNudge("ses_b1")}`);

    // 2ª transição: supressão ativa (set populado) → SEM novo nudge.
    await ev("ses_a1", "busy"); await ev("ses_a1", "idle");
    await ev("ses_b1", "busy"); await ev("ses_b1", "idle");
    await tick(12);
    R("plugin.idle-suppressed-A", idleNudge("ses_a1") === 1, `n=${idleNudge("ses_a1")}`);
    R("plugin.idle-suppressed-B", idleNudge("ses_b1") === 1, `n=${idleNudge("ses_b1")}`);

    // Poda no SHUTDOWN DE MEMBRO via evento de status → re-spawn volta a nudgar.
    sql.prepare("UPDATE team_member SET status = 'shutdown_requested' WHERE team_id = 'TA' AND name = 'm1'").run();
    await ev("ses_a1", "idle");
    await tick(8);
    R("plugin.prune-event-shutdown-status", memberStatus("TA") === "shutdown", `status=${memberStatus("TA")}`);
    reactivate("TA");
    await ev("ses_a1", "busy"); await ev("ses_a1", "idle");
    await tick(12);
    R("plugin.prune-event-re-nudges", idleNudge("ses_a1") === 2, `n=${idleNudge("ses_a1")}`);

    // Poda no caminho do TOOL team_shutdown(member) → re-nudge volta a disparar.
    const r1 = await inst.tool.team_shutdown.execute({ member: "m1", force: true }, { sessionID: "ses_lead_a", metadata() {} });
    await tick(6);
    R("plugin.prune-tool-single-shutdown", String(r1).includes("has been shut down"), String(r1).slice(0, 80));
    reactivate("TA");
    await ev("ses_a1", "busy"); await ev("ses_a1", "idle");
    await tick(12);
    R("plugin.prune-tool-re-nudges", idleNudge("ses_a1") === 3, `n=${idleNudge("ses_a1")}`);

    // LIMPEZA DE SALA (wildcard) — escopada: TA limpo, TB intacto (não emudecido).
    const r2 = await inst.tool.team_shutdown.execute({ member: "*", force: true, acknowledge_uncommitted: true }, { sessionID: "ses_lead_a", metadata() {} });
    await tick(8);
    R("plugin.room-wildcard-cleanup", String(r2).includes("cleaned up"), String(r2).slice(0, 100));
    R("plugin.room-A-archived", statusOf("TA") === "archived", `TA=${statusOf("TA")}`);
    R("plugin.room-B-active", statusOf("TB") === "active", `TB=${statusOf("TB")}`);
    const bBefore = idleNudge("ses_b1");
    await ev("ses_b1", "busy"); await ev("ses_b1", "idle");
    await tick(12);
    R("plugin.room-clear-scoped-B-survives", bBefore === 1 && idleNudge("ses_b1") === 1, `before=${bBefore} after=${idleNudge("ses_b1")}`);
  } catch (err) {
    R("plugin.scenario-executable", false, err?.stack ?? String(err));
  } finally {
    try { sql?.close(); } catch { /* já fechado */ }
    cleanupDir(base);
  }
  return got;
}

const SCENARIOS = {
  wd: scnWatchdog,
  pt: scnProgress,
  plugin: scnPlugin,
};

// ===========================================================================
// 7. Fase REAL — todas as suítes contra dist autêntico e src autêntico.
// ===========================================================================
const srcIndexMod = await import(`${SRC_COPY}/index.ts`);
const SRC_MOD = {
  createDb: (await import(`${SRC_COPY}/db.ts`)).createDb,
  Watchdog: (await import(`${SRC_COPY}/watchdog.ts`)).Watchdog,
  ProgressTracker: (await import(`${SRC_COPY}/progress.ts`)).ProgressTracker,
  initLog: (await import(`${SRC_COPY}/log.ts`)).initLog,
  MemberRegistry: (await import(`${SRC_COPY}/state.ts`)).MemberRegistry,
  MIGRATIONS: (await import(`${SRC_COPY}/schema.ts`)).MIGRATIONS,
  DEFAULT_CONFIG: (await import(`${SRC_COPY}/config.ts`)).DEFAULT_CONFIG,
  default: srcIndexMod.default,
};

for (const [label, mod] of [["dist", DIST_MOD], ["src", SRC_MOD]]) {
  for (const [name, fn] of Object.entries(SCENARIOS)) {
    let map;
    try { map = await fn(mod, label); }
    catch (err) { check(`[real] ${label}/${name}: cenário executável`, false, err?.stack ?? String(err)); map = new Map(); }
    for (const [n, v] of map) check(`[real] ${n}`, v.ok, v.detail);
  }
}
const realUnhandled = unhandled.length;
check("[real] zero unhandledRejection nas suítes reais (dist+src)", realUnhandled === 0, `unhandled=${realUnhandled}`);

// ===========================================================================
// 8. SCANNERS determinísticos de higienização (README, resíduos, package.json).
// ===========================================================================
const FORBIDDEN_README = [
  { id: "persona-privada", re: /\b(dante|diana|silas)\b/i },
  { id: "caminho-home", re: /\/home\/[^\s`)"'\]]+/i },
  { id: "caminho-mnt", re: /\/mnt\/[^\s`)"'\]]+/i },
  { id: "repo-proprietario", re: /\b(JEV|JEZ|Panela|PanelaBuild|Faturamento|Predictera)\b/ },
  { id: "ticket-id", re: /TICKET-[A-Z0-9]+-\d+/ },
];
function scanReadme(file) {
  const text = readFileSync(file, "utf8");
  const findings = [];
  for (const { id, re } of FORBIDDEN_README) {
    const m = text.match(re);
    if (m) findings.push({ id, match: String(m[0]).slice(0, 40) });
  }
  return findings;
}
const README_REQUIRED = ["Native Standby", "Silent Lead", "Resilient Watchdog", "model fallback", "intra-card handover", "Deterministic tests", "no mocks"];

const RESIDUALS = ["find_port.js", "find_port.mjs", "fix.cjs", "patch_core.cjs", "patch_events.cjs", "patch_html.cjs", "patch_render.cjs", "test_post.js", "_qa_2ZTuTm"];
function scanResiduals(dir) {
  const found = [];
  for (const n of RESIDUALS) if (existsSync(path.join(dir, n))) found.push(n);
  for (const n of readdirSync(dir)) if (/^patch_.*\.cjs$/.test(n) && !found.includes(n)) found.push(n);
  return found;
}
function scanPackageFiles(pkgPath) {
  const p = JSON.parse(readFileSync(pkgPath, "utf8"));
  return { hasTests: Array.isArray(p.files) && p.files.includes("tests"), files: p.files };
}

const README_FILE = path.join(PKG, "README.md");
check("8.readme README.md sem personas privadas / caminhos / repos / tickets",
  scanReadme(README_FILE).length === 0, JSON.stringify(scanReadme(README_FILE)));
check("8.readme README.md cobre os tópicos canônicos do runtime",
  (() => { const t = readFileSync(README_FILE, "utf8"); return README_REQUIRED.every((m) => t.includes(m)); })(),
  README_REQUIRED.join(" | "));
check("8.residual raiz sem find_port.*/fix.cjs/patch_*.cjs/test_post.js/_qa_2ZTuTm",
  scanResiduals(PKG).length === 0, JSON.stringify(scanResiduals(PKG)));
check("8.pkg (scan real) package.json.files sem 'tests'",
  scanPackageFiles(path.join(PKG, "package.json")).hasTests === false);

// Prova de sensibilidade dos scanners (fixtures em diretório temporário real).
{
  const dir = mkScratch("scan");
  try {
    const dirtyReadme = path.join(dir, "README.dirty.md");
    writeFileSync(dirtyReadme, "# Projeto\n\nOperado por Dante em /home/maiteuxzanela/repo (JEV) — TICKET-HARNESS-38.\n");
    check("8.scan-sensitivity README sujo → persona+caminho+repo+ticket detectados",
      scanReadme(dirtyReadme).length >= 4, JSON.stringify(scanReadme(dirtyReadme)));
    const cleanReadme = path.join(dir, "README.clean.md");
    writeFileSync(cleanReadme, "# Limpo\n\nRuntime multi-agente sem mocks.\n");
    check("8.scan-sensitivity README limpo → zero achados", scanReadme(cleanReadme).length === 0);

    mkdirSync(path.join(dir, "_qa_2ZTuTm"));
    writeFileSync(path.join(dir, "find_port.js"), "");
    writeFileSync(path.join(dir, "patch_render.cjs"), "");
    const found = scanResiduals(dir).sort();
    check("8.scan-sensitivity resíduos injetados → detectados (find_port.js, patch_render.cjs, _qa_2ZTuTm)",
      ["_qa_2ZTuTm", "find_port.js", "patch_render.cjs"].every((n) => found.includes(n)), JSON.stringify(found));

    const dirtyPkg = path.join(dir, "package.dirty.json");
    writeFileSync(dirtyPkg, JSON.stringify({ files: ["dist", "tests"] }));
    check("8.scan-sensitivity package.json com 'tests' → detectado", scanPackageFiles(dirtyPkg).hasTests === true);
  } finally {
    cleanupDir(dir);
  }
}

// ===========================================================================
// 9. PROVA DE MUTAÇÃO — patch determinístico no bundle dist + reexecução.
// ===========================================================================
const removeTaskCompleteChattyClear = (raw) => {
  const i = raw.indexOf("recordTaskComplete(sessionId) {");
  if (i < 0) return raw;
  const needle = "this.clearChattyReport(sessionId);";
  const j = raw.indexOf(needle, i);
  if (j < 0) return raw;
  return raw.slice(0, j) + "void 0;" + raw.slice(j + needle.length);
};
const globalizeTeamClear = (raw) =>
  raw.replace(
    "if (key.startsWith(idlePrefix) || key.startsWith(fastIdlePrefix)) nudgedMembers.delete(key);",
    "if (true) nudgedMembers.delete(key);",
  );

const MUTATIONS = [
  {
    id: "H38-1", desc: "M9: unref() removido do timer principal (segura o event loop)",
    from: "this.timer?.unref?.();", to: "void 0;",
    scenarios: ["wd"], detect: ["wd.main-timer-unref"], unaffected: ["wd.timer-created", "wd.running-before-dispose"],
  },
  {
    id: "H38-2", desc: "M9: .catch() removido do tick async (rejeição escapa como unhandled)",
    mutate: (raw) => raw.replace(
      "this.check().catch((err) => {\n          log(`watchdog:check:err err=${err instanceof Error ? err.message : String(err)}`);\n        });",
      "this.check();",
    ),
    scenarios: ["wd"], detect: ["wd.catch-logs", "wd.catch-swallows"], unaffected: ["wd.timer-created", "wd.main-timer-unref"],
  },
  {
    id: "H38-3", desc: "M9: dispose() não zera o campo do room-timer (não idempotente)",
    from: "this.roomInactivityTimer = void 0;", to: "/* kept */;",
    scenarios: ["wd"], detect: ["wd.dispose-clears-timer-field", "wd.disposed-not-running"], unaffected: ["wd.main-timer-unref", "wd.timer-created"],
  },
  {
    id: "H38-4", desc: "M10: mensagem ao lead deixa de re-armar o chatty",
    from: "if (toLead) this.clearChattyReport(sessionId);", to: "if (toLead) void sessionId;",
    scenarios: ["pt"], detect: ["pt.lead-message-clears-chatty"], unaffected: ["pt.nonlead-message-keeps-chatty", "pt.taskcomplete-clears-chatty"],
  },
  {
    id: "H38-5", desc: "M10: recordTaskComplete deixa de re-armar o chatty",
    mutate: removeTaskCompleteChattyClear,
    scenarios: ["pt"], detect: ["pt.taskcomplete-clears-chatty"], unaffected: ["pt.lead-message-clears-chatty", "pt.nonlead-message-keeps-chatty"],
  },
  {
    id: "H38-6", desc: "M11: poda do membro no shutdown removida (re-spawn fica emudecido)",
    from: "clearMemberNudges(transition.teamId, transition.memberName);", to: "void 0;",
    scenarios: ["plugin"], detect: ["plugin.prune-event-re-nudges"], unaffected: ["plugin.prune-event-shutdown-status", "plugin.room-A-archived"],
  },
  {
    id: "H38-7", desc: "M11: clearTeamNudges vira clear GLOBAL (emudece outra sala)",
    mutate: globalizeTeamClear,
    scenarios: ["plugin"], detect: ["plugin.room-clear-scoped-B-survives"], unaffected: ["plugin.room-A-archived", "plugin.room-B-active"],
  },
];

for (const m of MUTATIONS) {
  let mutatedRaw;
  if (m.mutate) {
    mutatedRaw = m.mutate(distRaw);
    check(`${m.id}: patch aplicável (bundle alterado)`, mutatedRaw !== distRaw, m.desc);
  } else {
    const occ = countOf(distRaw, m.from);
    check(`${m.id}: patch aplicável (1 ocorrência exata no dist)`, occ === 1, `ocorrências=${occ}`);
    if (occ !== 1) continue;
    mutatedRaw = distRaw.split(m.from).join(m.to);
  }
  if (mutatedRaw === distRaw) continue;

  let mutated;
  try {
    mutated = await import(harnessFile(mutatedRaw, `_h38_${m.id.toLowerCase().replace(/-/g, "_")}`));
  } catch (err) {
    check(`${m.id}: mutante importável`, false, err?.stack ?? String(err));
    continue;
  }

  const agg = new Map();
  let runnable = true;
  for (const scn of m.scenarios) {
    try {
      const map = await SCENARIOS[scn](mutated, "mut");
      for (const [n, v] of map) agg.set(n, v);
    } catch (err) {
      runnable = false;
      check(`${m.id}: cenário ${scn} executável sob mutação`, false, err?.stack ?? String(err));
    }
  }
  if (!runnable) continue;

  const missed = m.detect.filter((n) => agg.get(`mut.${n}`)?.ok !== false);
  check(`${m.id}: asserções sensíveis — mutação detectada [${m.desc}]`, missed.length === 0,
    missed.length ? `não detectaram: ${missed.join(", ")}` : `${m.detect.length}/${m.detect.length} sentinelas falharam`);
  const broken = m.unaffected.filter((n) => agg.get(`mut.${n}`)?.ok !== true);
  check(`${m.id}: mutação cirúrgica — fluxos intactos preservados`, broken.length === 0,
    broken.length ? `quebrou: ${broken.join(", ")}` : `${m.unaffected.length}/${m.unaffected.length} verdes preservados`);
}

// Mutação estática: prova que a asserção de teardown do V2 é sensível.
{
  const from = "nudgedMembers.clear();";
  const occ = countOf(distRaw, from);
  const mutated = distRaw.split(from).join("void 0;");
  check("H38-8: patch aplicável (1 ocorrência exata no dist)", occ === 1, `ocorrências=${occ}`);
  check("H38-8: asserção estática sensível — clear do teardown V2 detectado",
    distRaw.includes(from) && !mutated.includes(from), "remove nudgedMembers.clear()");
}

// ===========================================================================
// 10. Relatório.
// ===========================================================================
const passed = results.filter(([, ok]) => ok).length;
const total = results.length;
console.log(`\nRESULT: ${passed}/${total} checks passed`);
if (passed !== total) {
  console.log("FALHAS:");
  for (const [name] of results.filter(([, ok]) => !ok)) console.log(`  - ${name}`);
}
process.exit(passed === total ? 0 : 1);
