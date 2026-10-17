#!/usr/bin/env node
/**
 * QUALITY GATE DETERMINÍSTICO — TICKET-HARNESS-36
 * @maiteuxzanela/ensemble-room-lowcost
 *
 * Engenheiro de Testes (SDET): Hugo. Guardiã do Quality Gate: Clara.
 *
 * Sob teste (src/ e dist/ REAIS, SQLite real via node:sqlite — SEM MOCKS):
 *   A3  src/index.ts    — Watchdog criado/start() SÓ quando !isWorktreeInstance(directory)
 *   A7  src/v2-setup.ts — paridade V2: Watchdog criado/start() só no host principal,
 *                         stop() no dispose()
 *   P3  src/recovery.ts + src/index.ts (wake-peer) — resolveStandbyWake prepende
 *       spawn_context (membro em standby acorda SEM amnésia)
 *   P4  src/tasks.ts    — releaseMemberTasks: in_progress/in_review → pending, assignee NULL;
 *                         blocked → assignee NULL mantendo status
 *   P5  src/tools/team-spawn.ts — falha de pre-claim em tarefa blocked reverte standby e
 *                         despacha o prompt inicial
 *   P6  src/member-model.ts — resolveAgentForSession só resolve times status='active'
 *   P7  src/tools/team-spawn.ts — decision_lead documentada no spawn_context (regular E read-only)
 *
 * Cobertura:
 *   - (A3/A7) comportamento REAL: hosts principais (V1 e V2) despertam via watchdog de
 *     ociosidade da sala (env ROOM_INACTIVITY_*), instâncias worktree NÃO; dispose() para
 *     o watchdog do V2 (nenhum sweep pós-dispose).
 *   - (P3) recovery + wake-peer V1: o texto entregue prepende spawn_context e o membro é
 *     promovido standby→starting com o agent preservado.
 *   - (P4) tabela real de tarefas: libera in_progress e in_review, desassina blocked.
 *   - (P5) spawn real com tarefa blocked já tomada: standby revertido, prompt despachado.
 *   - (P6) time arquivado ignorado (membro e lead).
 *   - (P7) spawn_context de membro regular e read-only cita decision_lead.
 *   - (mutação) 9 mutantes no bundle dist, cada um detectado por sentinelas cirúrgicas.
 *   - (paridade) literais das frentes presentes em src/ E dist/ + anti-mock.
 *
 * Seams: (1) cliente SDK do OpenCode (fronteira externa) reduzido a recorder determinístico
 * de promptAsync/transport — padrão das demais suítes; (2) o contexto do host V2 (event/tool/
 * session/rpc/shell/worktree/permission) é um adaptador estrutural REAL — nada de produção é
 * substituído. SQLite, bundle dist e o estado de cada cenário são reais.
 *
 * Uso: node tests/test_ticket_harness_36.mjs
 * Exit: 0 = todos os checks PASS; 1 = há FAIL.
 */

import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

const REPO = path.resolve(import.meta.dirname, "..");
const PKG = process.env.ENSEMBLE_PKG || REPO;
const DIST = path.join(PKG, "dist/index.js");
const SRC = path.join(REPO, "src");
const TMP = path.join(REPO, ".test-scratch", "h36");
mkdirSync(TMP, { recursive: true });

const results = [];
const check = (name, ok, detail) => {
  results.push([name, ok]);
  console.log(`${ok ? "PASS" : "FAIL"} | ${name}${detail ? " | " + detail : ""}`);
};
const unhandled = [];
process.on("unhandledRejection", (e) => unhandled.push(e));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitFor(pred, timeoutMs = 3000, stepMs = 20) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (pred()) return true;
    await sleep(stepMs);
  }
  return pred();
}

// ---------------------------------------------------------------------------
// 0. Harness: dist real + exportação dos símbolos sob teste (sem mocks).
// ---------------------------------------------------------------------------
const REQUIRED_SYMBOLS = [
  "createDb", "setupEnsemble", "Watchdog", "resolveStandbyWake", "releaseMemberTasks",
  "resolveAgentForSession", "executeTeamSpawn", "executeTeamCreate", "recoverUndeliveredMessages",
  "MemberRegistry", "ProgressTracker", "DEFAULT_CONFIG", "getTeamQAMember", "getTeamSDETMember",
];
const distRaw = readFileSync(DIST, "utf8");

function buildHarnessCode(raw) {
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
    "harness: dist declara todos os símbolos exigidos",
    missing.length === 0,
    missing.join(",") || `${REQUIRED_SYMBOLS.length} símbolos`,
  );
}

const harnessFile = (raw, name) => {
  const file = path.join(TMP, name);
  writeFileSync(file, buildHarnessCode(raw));
  return file;
};
const REAL = await import(harnessFile(distRaw, "_h36_real.mjs"));

// ---------------------------------------------------------------------------
// Helpers de ambiente e seed.
// ---------------------------------------------------------------------------
async function withEnv(vars, fn) {
  const prev = {};
  for (const k of Object.keys(vars)) {
    prev[k] = process.env[k];
    process.env[k] = vars[k];
  }
  try {
    return await fn();
  } finally {
    for (const k of Object.keys(vars)) {
      if (prev[k] === undefined) delete process.env[k];
      else process.env[k] = prev[k];
    }
  }
}

const NOW = () => Date.now();

function seedProjectAndTeam(db, { teamId, lead, leadAgent = "dante", status = "active", project = "default" }) {
  const t = NOW();
  db.run(
    "INSERT OR IGNORE INTO project (id, name, path, status, time_created, time_updated) VALUES (?,?,?,?,?,?)",
    [project, "Default", "", "active", t, t],
  );
  db.run(
    "INSERT INTO team (id, name, project_id, lead_session_id, lead_agent, status, delegate, awaiting_lead_decision, time_created, time_updated) VALUES (?,?,?,?,?,?,?,?,?,?)",
    [teamId, teamId, project, lead, leadAgent, status, 0, 0, t, t],
  );
}

function insertMember(db, { teamId, name, session, agent, status = "ready", exec = "idle", model = null, ctx = null, isQa = 0, role = null, updated = NOW() }) {
  db.run(
    `INSERT INTO team_member (team_id, name, session_id, agent, status, execution_status, model, spawn_context, is_qa, role, reported_to_lead, time_created, time_updated)
     VALUES (?,?,?,?,?,?,?,?,?,?,0,?,?)`,
    [teamId, name, session, agent, status, exec, model, ctx, isQa, role, updated, updated],
  );
}

function insertTask(db, { id, teamId, status, assignee = null, updated = NOW() }) {
  db.run(
    "INSERT INTO team_task (id, team_id, content, status, priority, assignee, time_created, time_updated) VALUES (?,?,?,?,?,?,?,?)",
    [id, teamId, "tarefa", status, "high", assignee, updated, updated],
  );
}

function mkScratch(tag) {
  const base = mkdtempSync(path.join(os.tmpdir(), `ens-h36-${tag}-`));
  return base;
}
function cleanup(base, db) {
  try { db?.close(); } catch { /* já fechado */ }
  try { rmSync(base, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }); } catch { /* best effort */ }
}

// ---------------------------------------------------------------------------
// Seam 1: recorder determinístico do cliente SDK (V1 promptAsync) / transport.
// ---------------------------------------------------------------------------
function makeTransport() {
  const calls = [];
  const ok = (extra = {}) => ({ data: { ok: true, ...extra } });
  const transport = {
    post: async (o) => { calls.push({ m: "post", url: o.url, path: o.path, body: o.body }); return ok(); },
    get: async (o) => { calls.push({ m: "get", url: o.url, path: o.path }); return ok({ id: o.path?.sessionID ?? "x" }); },
    delete: async () => ok(), put: async () => ok(), patch: async () => ok(),
  };
  return { calls, transport };
}
const promptCalls = (calls) => calls.filter((c) => String(c.url).includes("prompt_async"));
const promptText = (c) => String(c?.body?.parts?.[0]?.text ?? "");

// ===========================================================================
// CENÁRIO: releaseMemberTasks (P4)
// ===========================================================================
function scnTasks(mod) {
  const got = new Map();
  const R = (n, ok, d) => got.set(n, { ok: !!ok, detail: d === undefined ? "" : String(d) });
  const base = mkScratch("tasks");
  const db = mod.createDb(path.join(base, "e.db"));
  try {
    seedProjectAndTeam(db, { teamId: "T", lead: "sesL" });
    const t0 = NOW() - 10000;
    insertTask(db, { id: "ip", teamId: "T", status: "in_progress", assignee: "m", updated: t0 });
    insertTask(db, { id: "rev", teamId: "T", status: "in_review", assignee: "m", updated: t0 });
    insertTask(db, { id: "blk", teamId: "T", status: "blocked", assignee: "m", updated: t0 });
    insertTask(db, { id: "done", teamId: "T", status: "completed", assignee: "m", updated: t0 });
    insertTask(db, { id: "other", teamId: "T", status: "in_progress", assignee: "other", updated: t0 });

    const n = mod.releaseMemberTasks(db, "T", "m");
    const row = (id) => db.query("SELECT status, assignee, time_updated FROM team_task WHERE id = ?").get(id);

    R("release.returns-total", n === 3, `n=${n} (esperado 3)`);
    R("release.in-progress-released", row("ip").status === "pending" && row("ip").assignee === null, JSON.stringify(row("ip")));
    R("release.in-review-released", row("rev").status === "pending" && row("rev").assignee === null, JSON.stringify(row("rev")));
    R("release.blocked-status-preserved", row("blk").status === "blocked" && row("blk").assignee === null, JSON.stringify(row("blk")));
    R("release.completed-untouched", row("done").status === "completed" && row("done").assignee === "m", JSON.stringify(row("done")));
    R("release.other-assignee-untouched", row("other").status === "in_progress" && row("other").assignee === "other", JSON.stringify(row("other")));
    R("release.time-updated-bumped", row("ip").time_updated > t0 && row("blk").time_updated > t0, `ip=${row("ip").time_updated} blk=${row("blk").time_updated}`);
  } finally {
    cleanup(base, db);
  }
  return got;
}

// ===========================================================================
// CENÁRIO: resolveAgentForSession (P6)
// ===========================================================================
function scnMemberModel(mod) {
  const got = new Map();
  const R = (n, ok, d) => got.set(n, { ok: !!ok, detail: d === undefined ? "" : String(d) });
  const base = mkScratch("member");
  const db = mod.createDb(path.join(base, "e.db"));
  try {
    seedProjectAndTeam(db, { teamId: "TA", lead: "sesL_A", leadAgent: "dante", status: "active" });
    insertMember(db, { teamId: "TA", name: "m1", session: "ses_m1", agent: "build" });
    insertMember(db, { teamId: "TA", name: "lead_agent_null", session: "ses_m2", agent: "build" });
    db.run("UPDATE team SET lead_agent = NULL WHERE id = 'TA'");

    seedProjectAndTeam(db, { teamId: "TB", lead: "sesL_B", leadAgent: "dante", status: "archived" });
    insertMember(db, { teamId: "TB", name: "m3", session: "ses_m3", agent: "build" });

    // Time ativo com lead_agent definido para o ramo de lead.
    db.run("UPDATE team SET lead_agent = 'dante' WHERE id = 'TA'");

    R("resolve.member-active", mod.resolveAgentForSession(db, "ses_m1") === "build", mod.resolveAgentForSession(db, "ses_m1"));
    R("resolve.member-archived-undefined", mod.resolveAgentForSession(db, "ses_m3") === undefined, String(mod.resolveAgentForSession(db, "ses_m3")));
    R("resolve.lead-active", mod.resolveAgentForSession(db, "sesL_A") === "dante", mod.resolveAgentForSession(db, "sesL_A"));
    R("resolve.lead-archived-undefined", mod.resolveAgentForSession(db, "sesL_B") === undefined, String(mod.resolveAgentForSession(db, "sesL_B")));
    R("resolve.unknown-undefined", mod.resolveAgentForSession(db, "nope") === undefined, String(mod.resolveAgentForSession(db, "nope")));

    db.run("UPDATE team SET lead_agent = NULL WHERE id = 'TA'");
    R("resolve.lead-null-agent-fallback-dante", mod.resolveAgentForSession(db, "sesL_A") === "dante", String(mod.resolveAgentForSession(db, "sesL_A")));
  } finally {
    cleanup(base, db);
  }
  return got;
}

// ===========================================================================
// CENÁRIO: resolveStandbyWake direto
// ===========================================================================
function scnStandbyDirect(mod) {
  const got = new Map();
  const R = (n, ok, d) => got.set(n, { ok: !!ok, detail: d === undefined ? "" : String(d) });
  const base = mkScratch("sbw");
  const db = mod.createDb(path.join(base, "e.db"));
  try {
    seedProjectAndTeam(db, { teamId: "T", lead: "sesL" });
    insertMember(db, { teamId: "T", name: "sb_ctx", session: "s1", agent: "tulio", exec: "standby", ctx: "SPAWNCTX-SBW" });
    insertMember(db, { teamId: "T", name: "sb_noctx", session: "s2", agent: "ana", exec: "standby", ctx: null });
    insertMember(db, { teamId: "T", name: "normal", session: "s3", agent: "build", exec: "idle", ctx: null });

    const a = mod.resolveStandbyWake(db, "T", "sb_ctx", "BASE");
    R("sbw.ctx-prepended", a.woke === true && a.text === "SPAWNCTX-SBW\n\nBASE" && a.agent === "tulio", JSON.stringify(a));
    const b = mod.resolveStandbyWake(db, "T", "sb_noctx", "BASE");
    R("sbw.noctx-base-only", b.woke === true && b.text === "BASE" && b.agent === "ana", JSON.stringify(b));
    const c = mod.resolveStandbyWake(db, "T", "normal", "BASE");
    R("sbw.passthrough-non-standby", c.woke === false && c.text === "BASE" && c.agent === undefined, JSON.stringify(c));
    R("sbw.flip-starting", db.query("SELECT execution_status FROM team_member WHERE name='sb_ctx'").get().execution_status === "starting");
    const d2 = mod.resolveStandbyWake(db, "T", "sb_ctx", "BASE2");
    R("sbw.second-call-passthrough", d2.woke === false && d2.text === "BASE2", JSON.stringify(d2));
    R("sbw.unknown-member-passthrough", mod.resolveStandbyWake(db, "T", "ghost", "BASE").text === "BASE");
  } finally {
    cleanup(base, db);
  }
  return got;
}

// ===========================================================================
// CENÁRIO: recoverUndeliveredMessages acorda standby sem amnésia (P3)
// ===========================================================================
async function scnRecovery(mod) {
  const got = new Map();
  const R = (n, ok, d) => got.set(n, { ok: !!ok, detail: d === undefined ? "" : String(d) });
  const base = mkScratch("recovery");
  const db = mod.createDb(path.join(base, "e.db"));
  try {
    seedProjectAndTeam(db, { teamId: "T", lead: "sesL" });
    insertMember(db, { teamId: "T", name: "tulio", session: "ses_tulio", agent: "tulio", exec: "standby", ctx: "SPAWNCTX-REC: você é tulio", model: "google/antigravity-gemini-3.8-flash#low" });
    insertMember(db, { teamId: "T", name: "ana", session: "ses_ana", agent: "ana", exec: "idle", ctx: null });
    const t0 = NOW();
    db.run("INSERT INTO team_message (id, team_id, from_name, to_name, content, delivered, time_created) VALUES (?,?,?,?,?,0,?)", ["m1", "T", "cris", "tulio", "RECOVERED-TEXT", t0]);
    db.run("INSERT INTO team_message (id, team_id, from_name, to_name, content, delivered, time_created) VALUES (?,?,?,?,?,0,?)", ["m2", "T", "cris", "ana", "ANA-TEXT", t0]);

    const registry = new mod.MemberRegistry();
    registry.register("T", "tulio", "ses_tulio");
    registry.register("T", "ana", "ses_ana");

    const calls = [];
    const client = { session: { promptAsync: async (o) => { calls.push(o); return {}; } } };
    await mod.recoverUndeliveredMessages(db, client, registry);

    const tc = calls.find((c) => c.sessionID === "ses_tulio");
    const ac = calls.find((c) => c.sessionID === "ses_ana");
    R("recovery.standby-prepend", !!tc && String(tc.parts?.[0]?.text).startsWith("SPAWNCTX-REC: você é tulio") && String(tc.parts?.[0]?.text).includes("[Recovered team message from cris]: RECOVERED-TEXT"), JSON.stringify(tc?.parts?.[0]?.text));
    R("recovery.standby-agent", tc?.agent === "tulio", String(tc?.agent));
    R("recovery.standby-model", tc?.model?.providerID === "google" && tc?.model?.modelID === "antigravity-gemini-3.8-flash" && tc?.model?.variant === "low", JSON.stringify(tc?.model));
    R("recovery.standby-flipped-starting", db.query("SELECT execution_status FROM team_member WHERE name='tulio'").get().execution_status === "starting");
    R("recovery.delivered", db.query("SELECT delivered FROM team_message WHERE id='m1'").get().delivered === 1);
    R("recovery.non-standby-no-prepend", !!ac && String(ac.parts?.[0]?.text) === "[Recovered team message from cris]: ANA-TEXT" && ac.agent === undefined, JSON.stringify(ac?.parts?.[0]?.text));
  } finally {
    cleanup(base, db);
  }
  return got;
}

// ===========================================================================
// CENÁRIO: spawn — P5 (revert do standby) + P7 (decision_lead nos contextos)
// ===========================================================================
async function scnSpawn(mod) {
  const got = new Map();
  const R = (n, ok, d) => got.set(n, { ok: !!ok, detail: d === undefined ? "" : String(d) });
  const base = mkScratch("spawn");
  const db = mod.createDb(path.join(base, "e.db"));
  try {
    const prompts = [];
    let n = 0;
    const client = {
      session: {
        create: async () => ({ data: { id: `ses_child_${++n}` } }),
        promptAsync: async (o) => { prompts.push(o); return {}; },
        abort: async () => ({}),
      },
      tui: { showToast: async () => ({}) },
      worktree: { remove: async () => ({}) }, workspace: { remove: async () => ({}) },
    };
    const deps = {
      db,
      directory: path.join(base, "proj"),
      client,
      registry: new mod.MemberRegistry(),
      config: { ...mod.DEFAULT_CONFIG },
      progressTracker: new mod.ProgressTracker(),
    };
    mkdirSync(deps.directory, { recursive: true });

    const lead = "ses_lead_spawn";
    await mod.executeTeamCreate(deps, { name: "h36spawn" }, lead);
    const teamId = db.query("SELECT id FROM team WHERE name='h36spawn'").get().id;

    // Tarefa blocked já tomada por outro membro → pre-claim do spawn falha (changes === 0).
    insertTask(db, { id: "blk_taken", teamId, status: "blocked", assignee: "ghost" });
    // Tarefa blocked livre → pre-claim bem-sucedido (controle).
    insertTask(db, { id: "blk_free", teamId, status: "blocked", assignee: null });

    const memberRow = (name) => db.query("SELECT status, execution_status, spawn_context FROM team_member WHERE team_id=? AND name=?").get(teamId, name);

    // ---- P5: revert ----
    const resRevert = await mod.executeTeamSpawn(deps, { name: "p5a", agent: "build", prompt: "P5 work", worktree: false, claim_task: "blk_taken" }, lead);
    const p5 = memberRow("p5a");
    const p5session = db.query("SELECT session_id FROM team_member WHERE name='p5a'").get().session_id;
    const p5prompt = prompts.find((p) => p.sessionID === p5session);
    R("spawn.revert-status-busy", p5?.status === "busy" && p5?.execution_status === "starting", JSON.stringify(p5));
    R("spawn.revert-no-spawn-context", p5?.spawn_context === null, String(p5?.spawn_context));
    R("spawn.revert-prompt-dispatched", !!p5prompt && String(p5prompt.parts?.[0]?.text).includes("P5 work"), p5prompt ? "ok" : "sem prompt");
    R("spawn.revert-return-text", typeof resRevert === "string" && resRevert.includes("standby reverted"), resRevert?.slice(0, 160));

    // ---- Controle: pre-claim bem-sucedido mantém standby ----
    await mod.executeTeamSpawn(deps, { name: "p5b", agent: "build", prompt: "P5 control", worktree: false, claim_task: "blk_free" }, lead);
    const p5b = memberRow("p5b");
    const p5bsession = db.query("SELECT session_id FROM team_member WHERE name='p5b'").get().session_id;
    R("spawn.control-stays-standby", p5b?.status === "ready" && p5b?.execution_status === "standby", `${p5b?.status}/${p5b?.execution_status}`);
    R("spawn.control-spawn-context-saved", typeof p5b?.spawn_context === "string" && p5b.spawn_context.includes("P5 control"), String(p5b?.spawn_context?.length));
    R("spawn.control-no-prompt", !prompts.some((p) => p.sessionID === p5bsession));

    // ---- P7: decision_lead nos contextos (regular e read-only) ----
    await mod.executeTeamSpawn(deps, { name: "nm", agent: "build", prompt: "N work", worktree: false }, lead);
    const nmSession = db.query("SELECT session_id FROM team_member WHERE name='nm'").get().session_id;
    const nmText = String(prompts.find((p) => p.sessionID === nmSession)?.parts?.[0]?.text ?? "");
    R("spawn.p7-regular-decision-lead", nmText.includes("- decision_lead: escalate an emergency decision to the team lead"), "");
    R("spawn.p7-regular-tools", nmText.includes("- team_tasks_add: add tasks to the shared board"), "");

    await mod.executeTeamSpawn(deps, { name: "ro", agent: "plan", prompt: "RO work", worktree: false }, lead);
    const roSession = db.query("SELECT session_id FROM team_member WHERE name='ro'").get().session_id;
    const roText = String(prompts.find((p) => p.sessionID === roSession)?.parts?.[0]?.text ?? "");
    R("spawn.p7-readonly-decision-lead", roText.includes("- decision_lead: escalate an emergency decision to the team lead"), "");
    R("spawn.p7-readonly-no-claim-tools", roText.includes("- team_standby: yield execution and enter standby mode until unblocked or messaged") && !roText.includes("- team_tasks_add: add tasks to the shared board"), "");
  } finally {
    cleanup(base, db);
  }
  return got;
}

// ===========================================================================
// Seam 2: adaptador estrutural do host V2 (event/tool/session/rpc/...).
// ===========================================================================
function makeV2Ctx(directory, rec, base) {
  let n = 0;
  const hook = async () => ({ dispose: async () => {} });
  const gen = (signal) => (async function* () {
    if (!signal) { await new Promise(() => {}); return; }
    await new Promise((resolve) => signal.addEventListener("abort", resolve, { once: true }));
  })();
  return {
    location: { directory },
    options: {},
    session: {
      hook,
      create: async () => ({ id: `ses_new_${++n}` }),
      switchAgent: async (o) => { rec.switchAgent.push(o); },
      switchModel: async (o) => { rec.switchModel.push(o); },
      synthetic: async (o) => { rec.synthetic.push(o); return {}; },
      prompt: async (o) => { rec.prompt.push(o); return {}; },
      interrupt: async () => ({}),
      active: async () => ({}),
      context: async () => [],
      get: async ({ sessionID }) => ({ id: sessionID }),
    },
    tool: {
      hook,
      transform: async (cb) => { cb({ add: (d) => rec.tools.push(d) }); return { dispose: async () => {} }; },
    },
    shell: { hook },
    rpc: { register: async () => ({ events: { emit: async () => ({}) } }) },
    event: { subscribe: ({ signal } = {}) => gen(signal) },
    worktree: {
      create: async () => ({ directory: path.join(base, "wt") }),
      remove: async () => ({}), list: async () => [], refresh: async () => ({}),
    },
    permission: { rules: async () => ({}) },
  };
}

// ===========================================================================
// CENÁRIO V2: watchdog ativo no host principal + limpo no dispose (A7)
// ===========================================================================
async function scnV2Main(mod) {
  const got = new Map();
  const R = (n, ok, d) => got.set(n, { ok: !!ok, detail: d === undefined ? "" : String(d) });
  const base = mkScratch("v2main");
  const dbPath = path.join(base, "db", "e.db");
  mkdirSync(path.dirname(dbPath), { recursive: true });
  const rec = { synthetic: [], prompt: [], switchAgent: [], switchModel: [], tools: [] };
  let handle;
  try {
    handle = await withEnv(
      { HOME: path.join(base, "home"), ROOM_INACTIVITY_CHECK_MS: "40", ROOM_INACTIVITY_THRESHOLD_MS: "300" },
      () => mod.setupEnsemble(makeV2Ctx(path.join(base, "proj"), rec, base), { dbPath, dashboardPort: 0 }),
    );
    R("v2.tools-registered", rec.tools.length >= 10, `tools=${rec.tools.length}`);

    const old = NOW() - 60000;
    seedProjectAndTeam(handle.db, { teamId: "T1", lead: "sesL1" });
    insertMember(handle.db, { teamId: "T1", name: "clara", session: "sesQA1", agent: "clara", isQa: 1, updated: old });
    insertTask(handle.db, { id: "tk1", teamId: "T1", status: "in_review", assignee: "clara", updated: old });

    const woke = await waitFor(() => rec.synthetic.some((s) => s.sessionID === "sesQA1" && /Room has been inactive/.test(s.text)), 3000);
    R("v2.main-watchdog-wake", woke, JSON.stringify(rec.synthetic.map((s) => s.sessionID)));
    R("v2.main-watchdog-agent", rec.switchAgent.some((s) => s.sessionID === "sesQA1" && s.agent === "clara"), JSON.stringify(rec.switchAgent));

    await handle.dispose();
    rec.synthetic.length = 0;
    rec.switchAgent.length = 0;

    const old2 = NOW() - 60000;
    seedProjectAndTeam(handle.db, { teamId: "T2", lead: "sesL2" });
    insertMember(handle.db, { teamId: "T2", name: "clara", session: "sesQA2", agent: "clara", isQa: 1, updated: old2 });
    insertTask(handle.db, { id: "tk2", teamId: "T2", status: "in_review", assignee: "clara", updated: old2 });
    await sleep(400);
    R("v2.dispose-stops-watchdog", !rec.synthetic.some((s) => s.sessionID === "sesQA2"), JSON.stringify(rec.synthetic.map((s) => s.sessionID)));
  } finally {
    cleanup(base, handle?.db);
  }
  return got;
}

// ===========================================================================
// CENÁRIO V2: instância worktree NÃO inicializa watchdog (A7)
// ===========================================================================
async function scnV2Worktree(mod) {
  const got = new Map();
  const R = (n, ok, d) => got.set(n, { ok: !!ok, detail: d === undefined ? "" : String(d) });
  const base = mkScratch("v2wt");
  const dbPath = path.join(base, "db", "e.db");
  mkdirSync(path.dirname(dbPath), { recursive: true });
  const rec = { synthetic: [], prompt: [], switchAgent: [], switchModel: [], tools: [] };
  const wtDir = path.join(base, "proj", "worktree", "ensemble-x");
  let handle;
  try {
    handle = await withEnv(
      { HOME: path.join(base, "home"), ROOM_INACTIVITY_CHECK_MS: "40", ROOM_INACTIVITY_THRESHOLD_MS: "300" },
      () => mod.setupEnsemble(makeV2Ctx(wtDir, rec, base), { dbPath, dashboardPort: 0 }),
    );
    const old = NOW() - 60000;
    seedProjectAndTeam(handle.db, { teamId: "TW", lead: "sesLW" });
    insertMember(handle.db, { teamId: "TW", name: "clara", session: "sesQAW", agent: "clara", isQa: 1, updated: old });
    insertTask(handle.db, { id: "tkw", teamId: "TW", status: "in_review", assignee: "clara", updated: old });
    await sleep(500);
    R("v2wt.no-watchdog-wake", rec.synthetic.length === 0, `synthetic=${rec.synthetic.length}`);
    R("v2wt.no-switch-agent", rec.switchAgent.length === 0, `switchAgent=${rec.switchAgent.length}`);
    R("v2wt.tools-registered", rec.tools.length >= 10, `tools=${rec.tools.length}`);
    await handle.dispose();
    R("v2wt.dispose-ok", true, "");
  } finally {
    cleanup(base, handle?.db);
  }
  return got;
}

// ===========================================================================
// CENÁRIO V1: watchdog só no host principal, nunca em worktree (A3)
// ===========================================================================
async function scnV1Watchdog(mod) {
  const got = new Map();
  const R = (n, ok, d) => got.set(n, { ok: !!ok, detail: d === undefined ? "" : String(d) });
  const entry = mod.default;

  // ---- Host principal: watchdog DEVE despertar a QA por ociosidade ----
  {
    const base = mkScratch("v1main");
    const home = path.join(base, "home");
    const proj = path.join(base, "proj");
    mkdirSync(path.join(proj, ".opencode"), { recursive: true });
    mkdirSync(path.join(home, ".config", "opencode"), { recursive: true });
    writeFileSync(path.join(proj, ".opencode", "ensemble.json"), JSON.stringify({ dashboardPort: 0 }));
    let db;
    try {
      db = mod.createDb(path.join(home, ".config", "opencode", "ensemble.db"));
      seedProjectAndTeam(db, { teamId: "T", lead: "sesL" });
      insertMember(db, { teamId: "T", name: "clara", session: "sesQA", agent: "clara", isQa: 1, updated: NOW() - 60000 });
      insertTask(db, { id: "tk", teamId: "T", status: "in_review", assignee: "clara", updated: NOW() - 60000 });
      db.close(); db = undefined;

      const { calls, transport } = makeTransport();
      await withEnv(
        { HOME: home, ROOM_INACTIVITY_CHECK_MS: "40", ROOM_INACTIVITY_THRESHOLD_MS: "300" },
        () => entry.server({ client: { _client: transport }, directory: proj }),
      );
      const woke = await waitFor(
        () => promptCalls(calls).some((c) => c.path?.sessionID === "sesQA" && /Room has been inactive/.test(promptText(c))),
        4000,
      );
      R("v1.main-watchdog-wake", woke, `prompts=${promptCalls(calls).length}`);
      R("v1.main-watchdog-agent", promptCalls(calls).some((c) => c.path?.sessionID === "sesQA" && c.body?.agent === "clara"), JSON.stringify(promptCalls(calls).map((c) => c.body?.agent)));
    } finally {
      cleanup(base, db);
    }
  }

  // ---- Instância worktree: watchdog NÃO deve existir ----
  {
    const base = mkScratch("v1wt");
    const home = path.join(base, "home");
    const proj = path.join(base, "proj", "worktree", "ensemble-x");
    mkdirSync(proj, { recursive: true });
    mkdirSync(path.join(home, ".config", "opencode"), { recursive: true });
    let db;
    try {
      db = mod.createDb(path.join(home, ".config", "opencode", "ensemble.db"));
      seedProjectAndTeam(db, { teamId: "TW", lead: "sesLW" });
      insertMember(db, { teamId: "TW", name: "clara", session: "sesQAW", agent: "clara", isQa: 1, updated: NOW() - 60000 });
      insertTask(db, { id: "tkw", teamId: "TW", status: "in_review", assignee: "clara", updated: NOW() - 60000 });
      db.close(); db = undefined;

      const { calls, transport } = makeTransport();
      await withEnv(
        { HOME: home, ROOM_INACTIVITY_CHECK_MS: "40", ROOM_INACTIVITY_THRESHOLD_MS: "300" },
        () => entry.server({ client: { _client: transport }, directory: proj }),
      );
      await sleep(600);
      R("v1.worktree-no-watchdog-wake", promptCalls(calls).length === 0, `prompts=${promptCalls(calls).length}`);
    } finally {
      cleanup(base, db);
    }
  }
  return got;
}

// ===========================================================================
// CENÁRIO V1: wake-peer acorda membro em standby com resolveStandbyWake (P3)
// ===========================================================================
async function scnV1WakePeer(mod) {
  const got = new Map();
  const R = (n, ok, d) => got.set(n, { ok: !!ok, detail: d === undefined ? "" : String(d) });
  const entry = mod.default;
  const base = mkScratch("v1peer");
  const home = path.join(base, "home");
  const proj = path.join(base, "proj");
  mkdirSync(path.join(proj, ".opencode"), { recursive: true });
  mkdirSync(path.join(home, ".config", "opencode"), { recursive: true });
  writeFileSync(path.join(proj, ".opencode", "ensemble.json"), JSON.stringify({ dashboardPort: 0 }));
  let db;
  try {
    const dbFile = path.join(home, ".config", "opencode", "ensemble.db");
    db = mod.createDb(dbFile);
    seedProjectAndTeam(db, { teamId: "T", lead: "sesL" });
    insertMember(db, { teamId: "T", name: "tales", session: "ses_tales", agent: "build", exec: "standby", ctx: "SPAWNCTX-PEER: você é tales", model: "google/antigravity-gemini-3.8-flash#low" });
    db.close(); db = undefined;

    const { calls, transport } = makeTransport();
    let inst;
    await withEnv(
      { HOME: home, ROOM_INACTIVITY_THRESHOLD_MS: "0" },
      async () => { inst = await entry.server({ client: { _client: transport }, directory: proj }); },
    );
    await sleep(150); // recovery do init conclui (sem mensagens ainda)

    db = mod.createDb(dbFile);
    db.run("INSERT INTO team_message (id, team_id, from_name, to_name, content, delivered, time_created) VALUES (?,?,?,?,?,0,?)", ["peer1", "T", "clara", "tales", "peer-text", NOW() - 6000]);
    db.close(); db = undefined;

    await inst.event({ event: { type: "session.status", properties: { sessionID: "ses_tales", status: { type: "idle" } } } });
    const okWake = await waitFor(() => promptCalls(calls).some((c) => c.path?.sessionID === "ses_tales"), 3000);
    const pc = promptCalls(calls).find((c) => c.path?.sessionID === "ses_tales");
    R("peer.wake-fired", okWake, `prompts=${promptCalls(calls).length}`);
    R("peer.wake-prepend-context", !!pc && promptText(pc).startsWith("SPAWNCTX-PEER: você é tales") && promptText(pc).includes("[System: 1 new message(s) from teammates]"), JSON.stringify(promptText(pc).slice(0, 80)));
    R("peer.wake-agent-preserved", pc?.body?.agent === "build", JSON.stringify(pc?.body?.agent));
    R("peer.wake-model-preserved", pc?.body?.model?.providerID === "google", JSON.stringify(pc?.body?.model));
    db = mod.createDb(dbFile);
    R("peer.wake-flipped-starting", db.query("SELECT execution_status FROM team_member WHERE name='tales'").get().execution_status === "starting");
  } finally {
    cleanup(base, db);
  }
  return got;
}

// ===========================================================================
// Fase REAL: todos os cenários contra o dist autêntico devem passar 100%.
// ===========================================================================
const SCENARIOS = {
  tasks: scnTasks,
  memberModel: scnMemberModel,
  standby: scnStandbyDirect,
  recovery: scnRecovery,
  spawn: scnSpawn,
  v2main: scnV2Main,
  v2worktree: scnV2Worktree,
  v1watchdog: scnV1Watchdog,
  v1wakepeer: scnV1WakePeer,
};

const realMaps = {};
for (const [name, fn] of Object.entries(SCENARIOS)) {
  let map;
  try {
    map = await fn(REAL);
  } catch (err) {
    check(`[real] ${name}: cenário executável`, false, err?.stack ?? String(err));
    map = new Map();
  }
  realMaps[name] = map;
  for (const [n, v] of map) check(`[real] ${n}`, v.ok, v.detail);
}

// ---------------------------------------------------------------------------
// Paridade src↔dist + literais de defesa + anti-mock.
// ---------------------------------------------------------------------------
const srcIndex = readFileSync(path.join(SRC, "index.ts"), "utf8");
const srcV2 = readFileSync(path.join(SRC, "v2-setup.ts"), "utf8");
const srcRecovery = readFileSync(path.join(SRC, "recovery.ts"), "utf8");
const srcTasks = readFileSync(path.join(SRC, "tasks.ts"), "utf8");
const srcMember = readFileSync(path.join(SRC, "member-model.ts"), "utf8");
const srcSpawn = readFileSync(path.join(SRC, "tools/team-spawn.ts"), "utf8");

check(
  "paridade A3: V1 só cria watchdog fora de worktree (src E dist) + skip-watchdog",
  srcIndex.includes("if (!isWorktreeInstance(input.directory)) {\n    watchdog = new Watchdog({") &&
    distRaw.includes("if (!isWorktreeInstance(input.directory)) {\n    watchdog = new Watchdog({") &&
    srcIndex.includes("init:skip-watchdog (worktree instance") && distRaw.includes("init:skip-watchdog (worktree instance"),
);
check(
  "paridade A7: V2 só cria watchdog fora de worktree e para no dispose (src E dist)",
  srcV2.includes("if (!isWorktreeInstance(ctx.location.directory)) {\n    watchdog = new Watchdog({") &&
    distRaw.includes("if (!isWorktreeInstance(ctx.location.directory)) {\n    watchdog = new Watchdog({") &&
    srcV2.includes("watchdog?.stop()") && distRaw.includes("watchdog?.stop()"),
);
check(
  "paridade P3: wake-peer usa resolveStandbyWake (src E dist)",
  srcIndex.includes("text: resolveStandbyWake(db, member.team_id, member.name,") &&
    distRaw.includes("text: resolveStandbyWake(db, member.team_id, member.name,") &&
    srcRecovery.includes("const wake = resolveStandbyWake(") && distRaw.includes("const wake = resolveStandbyWake("),
);
check(
  "paridade P4: releaseMemberTasks libera in_progress+in_review e desassina blocked",
  srcTasks.includes("status IN ('in_progress', 'in_review')") && distRaw.includes("status IN ('in_progress', 'in_review')") &&
    srcTasks.includes("status = 'blocked'") && distRaw.includes("SET assignee = NULL, time_updated = ? WHERE team_id = ? AND assignee = ? AND status = 'blocked'"),
);
check(
  "paridade P6: resolveAgentForSession filtra times active (membro e lead, src E dist)",
  srcMember.includes("JOIN team t ON tm.team_id = t.id") && srcMember.includes("AND t.status = 'active'") &&
    srcMember.includes("WHERE lead_session_id = ? AND status = 'active'") &&
    distRaw.includes("JOIN team t ON tm.team_id = t.id") && distRaw.includes("WHERE lead_session_id = ? AND status = 'active'"),
);
check(
  "paridade P5: revert do standby no spawn + marcador de log (src E dist)",
  srcSpawn.includes("if (useStandby && claimedTaskBlocked && !spawnIsQA && !spawnIsSDET && args.standby !== true) {") &&
    distRaw.includes("if (useStandby && claimedTaskBlocked && !spawnIsQA && !spawnIsSDET && args.standby !== true) {") &&
    srcSpawn.includes("spawn:claim-blocked:standby-reverted") && distRaw.includes("spawn:claim-blocked:standby-reverted"),
);
check(
  "paridade P7: decision_lead documentada nos dois contextos (regular e read-only, src E dist)",
  (srcSpawn.match(/- decision_lead: escalate an emergency decision to the team lead/g) ?? []).length === 2 &&
    (distRaw.match(/- decision_lead: escalate an emergency decision to the team lead/g) ?? []).length === 2,
);

{
  const FORBIDDEN = ["je" + "st.mock", "sin" + "on", "vi.mo" + "ck", "mockImple" + "mentation", "Magic" + "Mock"];
  const forbiddenRe = new RegExp(FORBIDDEN.join("|"), "i");
  let srcMocks = 0;
  const walk = (dir) => {
    for (const entry of readdirSync(dir)) {
      const full = path.join(dir, entry);
      if (statSync(full).isDirectory()) walk(full);
      else if (entry.endsWith(".ts") && forbiddenRe.test(readFileSync(full, "utf8"))) srcMocks++;
    }
  };
  walk(SRC);
  check("anti-mock: zero mocks em produção sob src/", srcMocks === 0, `achados=${srcMocks}`);
  check("anti-mock: suíte não contém marcadores proibidos", !forbiddenRe.test(readFileSync(import.meta.filename, "utf8")));
}

// ---------------------------------------------------------------------------
// PROVA DE MUTAÇÃO: patch determinístico no bundle dist + reexecução cirúrgica.
// ---------------------------------------------------------------------------
const MUTATIONS = [
  {
    id: "M1",
    desc: "releaseMemberTasks deixa de liberar in_review",
    from: "SET status = 'pending', assignee = NULL, time_updated = ? WHERE team_id = ? AND assignee = ? AND status IN ('in_progress', 'in_review')",
    to: "SET status = 'pending', assignee = NULL, time_updated = ? WHERE team_id = ? AND assignee = ? AND status IN ('in_progress')",
    scenarios: ["tasks"],
    detect: ["release.in-review-released", "release.returns-total"],
    unaffected: ["release.in-progress-released", "release.blocked-status-preserved", "release.completed-untouched", "release.other-assignee-untouched"],
  },
  {
    id: "M2",
    desc: "releaseMemberTasks promove tarefas blocked a pending (perde o status)",
    from: "\"UPDATE team_task SET assignee = NULL, time_updated = ? WHERE team_id = ? AND assignee = ? AND status = 'blocked'\"",
    to: "\"UPDATE team_task SET status = 'pending', assignee = NULL, time_updated = ? WHERE team_id = ? AND assignee = ? AND status = 'blocked'\"",
    scenarios: ["tasks"],
    detect: ["release.blocked-status-preserved"],
    unaffected: ["release.in-progress-released", "release.in-review-released", "release.completed-untouched", "release.returns-total"],
  },
  {
    id: "M3",
    desc: "resolveAgentForSession ignora o status do time para membros (vaza time arquivado)",
    from: "    JOIN team t ON tm.team_id = t.id\n     WHERE tm.session_id = ? AND t.status = 'active'`",
    to: "    JOIN team t ON tm.team_id = t.id\n     WHERE tm.session_id = ?`",
    scenarios: ["memberModel"],
    detect: ["resolve.member-archived-undefined"],
    unaffected: ["resolve.member-active", "resolve.lead-active", "resolve.lead-archived-undefined", "resolve.unknown-undefined"],
  },
  {
    id: "M4",
    desc: "resolveAgentForSession ignora o status do time para o lead (vaza time arquivado)",
    from: "\"SELECT lead_agent FROM team WHERE lead_session_id = ? AND status = 'active'\"",
    to: "\"SELECT lead_agent FROM team WHERE lead_session_id = ?\"",
    scenarios: ["memberModel"],
    detect: ["resolve.lead-archived-undefined"],
    unaffected: ["resolve.member-active", "resolve.member-archived-undefined", "resolve.lead-active", "resolve.lead-null-agent-fallback-dante"],
  },
  {
    id: "M5",
    desc: "resolveStandbyWake nunca consome a janela de standby (membro acorda com amnésia)",
    from: "if (!row || row.execution_status !== \"standby\") {",
    to: "if (true) {",
    scenarios: ["recovery", "standby"],
    detect: ["recovery.standby-prepend", "recovery.standby-flipped-starting", "recovery.standby-agent", "sbw.ctx-prepended"],
    unaffected: ["recovery.non-standby-no-prepend", "recovery.standby-model", "sbw.passthrough-non-standby", "sbw.unknown-member-passthrough"],
  },
  {
    id: "M6",
    desc: "revert do standby desabilitado no spawn (membro fica preso em standby)",
    from: "if (useStandby && claimedTaskBlocked && !spawnIsQA && !spawnIsSDET && args.standby !== true) {",
    to: "if (false) {",
    scenarios: ["spawn"],
    detect: ["spawn.revert-status-busy", "spawn.revert-prompt-dispatched", "spawn.revert-return-text"],
    unaffected: ["spawn.control-stays-standby", "spawn.p7-regular-decision-lead", "spawn.p7-readonly-decision-lead"],
  },
  {
    id: "M7",
    desc: "V2 sempre instancia o watchdog (inclusive em worktree)",
    from: "if (!isWorktreeInstance(ctx.location.directory)) {\n    watchdog = new Watchdog({",
    to: "if (true) {\n    watchdog = new Watchdog({",
    scenarios: ["v2worktree"],
    detect: ["v2wt.no-watchdog-wake", "v2wt.no-switch-agent"],
    unaffected: ["v2wt.tools-registered", "v2wt.dispose-ok"],
  },
  {
    id: "M8",
    desc: "V1 sempre instancia o watchdog (inclusive em worktree)",
    from: "if (!isWorktreeInstance(input.directory)) {\n    watchdog = new Watchdog({",
    to: "if (true) {\n    watchdog = new Watchdog({",
    scenarios: ["v1watchdog"],
    detect: ["v1.worktree-no-watchdog-wake"],
    unaffected: ["v1.main-watchdog-wake", "v1.main-watchdog-agent"],
  },
  {
    id: "M9",
    desc: "dispose V2 não para o watchdog (timers sobrevivem ao plugin)",
    from: "watchdog?.stop()",
    to: "void 0",
    scenarios: ["v2main"],
    detect: ["v2.dispose-stops-watchdog"],
    unaffected: ["v2.main-watchdog-wake", "v2.main-watchdog-agent"],
  },
];

for (const m of MUTATIONS) {
  const occurrences = distRaw.split(m.from).length - 1;
  check(`${m.id}: patch aplicável (1 ocorrência exata no dist)`, occurrences === 1, `ocorrências=${occurrences}`);
  if (occurrences !== 1) continue;

  let mutated;
  try {
    mutated = await import(harnessFile(distRaw.split(m.from).join(m.to), `_h36_${m.id.toLowerCase()}.mjs`));
  } catch (err) {
    check(`${m.id}: mutante importável`, false, err?.stack ?? String(err));
    continue;
  }

  const agg = new Map();
  let runnable = true;
  for (const scn of m.scenarios) {
    try {
      const map = await SCENARIOS[scn](mutated);
      for (const [n, v] of map) agg.set(n, v);
    } catch (err) {
      runnable = false;
      check(`${m.id}: cenário ${scn} executável sob mutação`, false, err?.stack ?? String(err));
    }
  }
  if (!runnable) continue;

  check(`${m.id}: mutante executável (cenários rodam por completo)`, agg.size >= (realMaps[m.scenarios[0]]?.size ?? 0), `checks=${agg.size}`);

  const missed = m.detect.filter((n) => agg.get(n)?.ok !== false);
  check(`${m.id}: asserções sensíveis — mutação detectada [${m.desc}]`, missed.length === 0, missed.length ? `não detectaram: ${missed.join(", ")}` : `${m.detect.length}/${m.detect.length} sentinelas falharam`);

  const broken = m.unaffected.filter((n) => agg.get(n)?.ok !== true);
  check(`${m.id}: mutação cirúrgica — fluxos intactos preservados`, broken.length === 0, broken.length ? `quebrou: ${broken.join(", ")}` : `${m.unaffected.length}/${m.unaffected.length} verdes preservados`);
}

// ---------------------------------------------------------------------------
// Relatório
// ---------------------------------------------------------------------------
const passed = results.filter(([, ok]) => ok).length;
const total = results.length;
console.log(`\nRESULT: ${passed}/${total} checks passed, ${unhandled.length} unhandled rejections`);
process.exit(passed === total && unhandled.length === 0 ? 0 : 1);
