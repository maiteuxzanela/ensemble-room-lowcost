#!/usr/bin/env node
/**
 * QUALITY GATE DETERMINÍSTICO — TICKET-HARNESS-37
 * @maiteuxzanela/ensemble-room-lowcost
 *
 * Engenheiro de Testes (SDET): Hugo. Guardiã do Quality Gate: Clara.
 *
 * Sob teste (src/ e dist/ REAIS, SQLite real via node:sqlite, git real em
 * sandbox — SEM MOCKS no código de produção):
 *   M1  src/system-prompt.ts + src/watchdog.ts — prompts do lead coerentes com
 *       silentLead e nudges de watchdog (stall/chatty) orientados à tarefa/board.
 *   M2  src/system-prompt.ts + src/tools/team-spawn.ts — implementador só usa
 *       submit_review (sem handoff manual ao SDET), preservando o batching do
 *       HARNESS-25 (wake do SDET retido até a consolidação do lote).
 *   M3  src/index.ts (V1) + src/v2-tools.ts (V2) + src/tools/team-spawn.ts —
 *       role enum ["sdet","qa","member"] nas DUAS camadas; template dinâmico de
 *       exclusividade SDET interpolando `existingSDET.name`.
 *   M4  src/tools/decision-lead.ts + src/tools/team-message.ts — fila por membro
 *       (Migration 18, awaiting_decision_members); limpar um membro NÃO destranca
 *       nem silencia outro; pausa do watchdog só cessa quando a fila esvazia.
 *   M5  src/index.ts — cleanup do team_shutdown escopado por team_id AND name.
 *   M6  src/system-prompt.ts — flush de delivered só no fim (resiliência) e
 *       ponteiro canônico para team_results em mensagens truncadas.
 *   M7  src/tools/team-tasks-complete.ts — auto-commit do Portão 1 resolvido
 *       ANTES do wake de fechamento do board (git real + ordem observável).
 *   M8  src/tools/team-tasks-complete.ts — concatenação de review_notes
 *       ([Implementador]/[SDET]), sem "recorded: ." e QA report fidedigno.
 *
 * Cobertura:
 *   - (M1) prompts do lead silentLead vs. legado byte-estável; nudges reais.
 *   - (M2) prompt de implementador/QA reais + spawn real + descrições V1/V2.
 *   - (M3) enum estático V1/V2 + schema V2 registrado em runtime + spawn real de
 *     SDET com nome arbitrário e trava de exclusividade com o nome REAL.
 *   - (M4) fila real em SQLite; partial-clear, duplicate-raise, watchdog pausado.
 *   - (M5) SQL escopado executado em SQLite real com homônimos cross-team.
 *   - (M6) delivered=1, notices de truncamento, structural flush-only-at-end.
 *   - (M7) git real: árvore limpa + HEAD commitado no INSTANTE do wake.
 *   - (M8) notes concat/enquadramento, notas vazias e QA ausente.
 *   - (mutação) 11 mutantes cirúrgicos, cada um detectado por sentinelas.
 *
 * Seams: (1) cliente SDK do OpenCode reduzido a recorder determinístico de
 * promptAsync/transport (fronteira externa) — nada da produção é substituído;
 * (2) git real em sandbox. SQLite, bundle dist e o estado de cada cenário são
 * reais.
 *
 * Uso: node tests/test_ticket_harness_37.mjs
 * Exit: 0 = todos os checks PASS; 1 = há FAIL.
 */

import { execSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

const REPO = path.resolve(import.meta.dirname, "..");
const DIST = path.join(REPO, "dist/index.js");
const SRC = path.join(REPO, "src");
const TMP = path.join(REPO, ".test-scratch", "h37");
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

// ---------------------------------------------------------------------------
// 0. Harness: dist real + exportação dos símbolos sob teste (sem mocks).
// ---------------------------------------------------------------------------
const REQUIRED_SYMBOLS = [
  "createDb", "DEFAULT_CONFIG", "MemberRegistry", "ProgressTracker", "DescendantTracker",
  "PendingPurgeApprovals", "Watchdog", "buildLeadSystemPrompt", "buildTeammateSystemPrompt",
  "markAwaitingLeadDecision", "clearAwaitingLeadDecision", "hasAwaitingLeadDecision",
  "executeDecisionLead", "executeTeamMessage", "executeTeamCreate", "executeTeamSpawn",
  "executeTeamTasksComplete", "registerV2Tools", "getTeamSDETMember", "getTeamQAMember",
  "findTeamBySession",
];
const distRaw = readFileSync(DIST, "utf8");
const srcIndex = readFileSync(path.join(SRC, "index.ts"), "utf8");
const srcV2 = readFileSync(path.join(SRC, "v2-tools.ts"), "utf8");
const srcSystemPrompt = readFileSync(path.join(SRC, "system-prompt.ts"), "utf8");
const srcWatchdog = readFileSync(path.join(SRC, "watchdog.ts"), "utf8");
const srcSpawn = readFileSync(path.join(SRC, "tools/team-spawn.ts"), "utf8");
const srcTasksComplete = readFileSync(path.join(SRC, "tools/team-tasks-complete.ts"), "utf8");

function buildHarnessCode(raw) {
  const existingExport = raw.match(/export\s*\{([^}]*)\}\s*;?\s*$/)?.[1] ?? "";
  const already = new Set(existingExport.split(",").map((s) => s.trim().split(/\s+as\s+/).pop()).filter(Boolean));
  const need = REQUIRED_SYMBOLS.filter((s) => !already.has(s));
  return raw + (need.length ? `\nexport { ${need.join(", ")} };\n` : "");
}
{
  const missing = REQUIRED_SYMBOLS.filter((s) => !new RegExp(`(function|class|var|const|let)\\s+${s}\\b`).test(distRaw));
  check("harness: dist declara todos os símbolos exigidos", missing.length === 0, missing.join(",") || `${REQUIRED_SYMBOLS.length} símbolos`);
}
const harnessFile = (raw, name) => {
  const file = path.join(TMP, name);
  writeFileSync(file, buildHarnessCode(raw));
  return file;
};
const REAL = await import(harnessFile(distRaw, "_h37_real.mjs"));

// ---------------------------------------------------------------------------
// Helpers de ambiente e seed.
// ---------------------------------------------------------------------------
function seedProjectAndTeam(db, { teamId, lead, leadAgent = "dante", status = "active" }) {
  const t = NOW();
  db.run("INSERT OR IGNORE INTO project (id, name, path, status, time_created, time_updated) VALUES (?,?,?,?,?,?)", ["default", "Default", "", "active", t, t]);
  db.run(
    "INSERT INTO team (id, name, project_id, lead_session_id, lead_agent, status, delegate, awaiting_lead_decision, time_created, time_updated) VALUES (?,?,?,?,?,?,?,?,?,?)",
    [teamId, teamId, "default", lead, leadAgent, status, 0, 0, t, t],
  );
}
function insertMember(db, { teamId, name, session, agent, status = "ready", exec = "idle", model = null, ctx = null, isQa = 0, role = null, updated = NOW() }) {
  db.run(
    `INSERT INTO team_member (team_id, name, session_id, agent, status, execution_status, model, spawn_context, is_qa, role, reported_to_lead, time_created, time_updated)
     VALUES (?,?,?,?,?,?,?,?,?,?,0,?,?)`,
    [teamId, name, session, agent, status, exec, model, ctx, isQa, role, updated, updated],
  );
}
function insertTask(db, { id, teamId, content = "tarefa", status, assignee = null, notes = null, updated = NOW() }) {
  db.run(
    "INSERT INTO team_task (id, team_id, content, status, priority, assignee, review_notes, time_created, time_updated) VALUES (?,?,?,?,?,?,?,?,?)",
    [id, teamId, content, status, "high", assignee, notes, updated, updated],
  );
}
function mkScratch(tag) { return mkdtempSync(path.join(os.tmpdir(), `ens-h37-${tag}-`)); }
function cleanup(base, db) {
  try { db?.close(); } catch { /* já fechado */ }
  try { rmSync(base, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }); } catch { /* best effort */ }
}
function makeClient() {
  const calls = { promptAsync: [], create: [], abort: [], toast: [] };
  const client = {
    session: {
      create: async (o) => { calls.create.push(o); return { data: { id: `ses_child_${calls.create.length}` } }; },
      promptAsync: async (o) => { calls.promptAsync.push(o); return {}; },
      abort: async (o) => { calls.abort.push(o); return {}; },
      status: async () => ({ data: {} }),
    },
    tui: { showToast: async (o) => { calls.toast.push(o); }, selectSession: async () => ({}) },
    worktree: { remove: async () => ({}) },
    workspace: { remove: async () => ({}) },
  };
  return { calls, client };
}
function makeDeps(mod, { db, directory, client, registry }) {
  return {
    db,
    registry: registry ?? new mod.MemberRegistry(),
    tracker: new mod.DescendantTracker(),
    purgeApprovals: new mod.PendingPurgeApprovals(),
    client,
    directory,
    config: { ...mod.DEFAULT_CONFIG },
    progressTracker: new mod.ProgressTracker(),
  };
}

const run = (fn) => { try { return fn(); } catch (e) { return { __err: e instanceof Error ? e.message : String(e) }; } };

// ===========================================================================
// CENÁRIO M1 — prompts do lead (silentLead) + nudges de watchdog.
// ===========================================================================
function nudgeText(mod, silentLead) {
  const base = mkScratch(`nudge-chatty-${silentLead ? "on" : "off"}`);
  const db = mod.createDb(path.join(base, "e.db"));
  try {
    seedProjectAndTeam(db, { teamId: "TN", lead: "sesLeadN", leadAgent: "dante" });
    const sess = `ses_nudge_chatty_${silentLead ? "on" : "off"}`;
    const stale = NOW() - 120_000;
    insertMember(db, { teamId: "TN", name: "tales", session: sess, agent: "build", status: "busy", exec: "running", updated: stale });
    const { calls, client } = makeClient();
    const tracker = new mod.ProgressTracker();
    // TICKET-RELEASE-17: stall sweep deleted — only the chatty nudge survives.
    const opts = {
      db, client, registry: new mod.MemberRegistry(), progressTracker: tracker,
      roomInactivityThresholdMs: 0, config: { ...mod.DEFAULT_CONFIG, silentLead },
    };
    tracker.recordPeerMessage(sess);
    tracker.recordPeerMessage(sess);
    const wd = new mod.Watchdog({ ...opts, peerMessageLimit: 2, peerMessageWindowMs: 300_000 });
    return wd.checkChatty().then(async () => {
      await tick();
      return String(calls.promptAsync.find((c) => c.sessionID === sess && String(c.parts?.[0]?.text).includes("several messages"))?.parts?.[0]?.text ?? "");
    });
  } finally {
    cleanup(base, db);
  }
}

async function scnM1(mod) {
  const got = new Map();
  const R = (n, ok, d) => got.set(n, { ok: !!ok, detail: d === undefined ? "" : String(d) });
  const base = mkScratch("m1");
  const db = mod.createDb(path.join(base, "e.db"));
  try {
    seedProjectAndTeam(db, { teamId: "T", lead: "sesL" });
    const pSilent = mod.buildLeadSystemPrompt(db, "T", { ...mod.DEFAULT_CONFIG });
    R("m1.lead-prompt-silent-wording", pSilent.includes("under silentLead you are NOT woken for each individual completion."));
    R("m1.lead-prompt-board-first", pSilent.includes("Progress lives on the shared board and in team_results"));
    R("m1.lead-prompt-rest-until-board-close", pSilent.includes("Rest until the board closes (all tasks completed)"));
    R("m1.lead-prompt-no-message-you-when-done", !pSilent.includes("Teammates work asynchronously and message you when done."));
    const pLegacy = mod.buildLeadSystemPrompt(db, "T", { ...mod.DEFAULT_CONFIG, silentLead: false });
    R("m1.lead-prompt-legacy-byte-stable", pLegacy.includes("Teammates work asynchronously and message you when done."));
    R("m1.lead-prompt-legacy-no-silent-line", !pLegacy.includes("under silentLead you are NOT woken"));
  } finally {
    cleanup(base, db);
  }
  // TICKET-RELEASE-17: the stall sweep (and its silentLead-aware nudge) was
  // removed with the time-based watchdog. Only chatty remains.
  R("m1.stall-sweep-removed", typeof mod.Watchdog.prototype.checkStalled === "undefined");
  const chattySilent = await nudgeText(mod, true);
  R("m1.chatty-nudge-silent-board", chattySilent.includes("advancing it on the shared board rather than over-coordinating"));
  R("m1.chatty-nudge-silent-no-lead-dm", !chattySilent.includes("send your results to the lead"));
  const chattyLegacy = await nudgeText(mod, false);
  R("m1.chatty-nudge-legacy-byte-stable", chattyLegacy.includes("Focus on completing your task and send your results to the lead via team_message."));
  return got;
}

// ===========================================================================
// CENÁRIO M2 — implementador/QA sem handoff manual ao SDET (batching HARNESS-25)
// ===========================================================================
async function scnM2(mod) {
  const got = new Map();
  const R = (n, ok, d) => got.set(n, { ok: !!ok, detail: d === undefined ? "" : String(d) });
  const base = mkScratch("m2");
  const db = mod.createDb(path.join(base, "e.db"));
  try {
    seedProjectAndTeam(db, { teamId: "T", lead: "sesL" });
    insertMember(db, { teamId: "T", name: "hugo", session: "ses_hugo", agent: "hugo", exec: "standby" });
    insertMember(db, { teamId: "T", name: "clara", session: "ses_clara", agent: "clara", isQa: 1 });
    insertMember(db, { teamId: "T", name: "tulio", session: "ses_tulio", agent: "build" });

    const pImpl = mod.buildTeammateSystemPrompt(db, "T", "tulio", { ...mod.DEFAULT_CONFIG });
    R("m2.implementer-submits-review", pImpl.includes("submit it via submit_review"));
    R("m2.implementer-runtime-wakes-sdet", pImpl.includes("the runtime wakes the SDET automatically"));
    R("m2.implementer-batch-held", pImpl.includes("the wake is held until the functional batch is consolidated"));
    R("m2.implementer-no-manual-handoff", pImpl.includes("Do NOT message the SDET to hand off"));
    R("m2.implementer-no-baton", !pImpl.includes("pass the baton"));
    R("m2.implementer-no-team-message-sdet", !pImpl.includes("team_message(to: 'hugo')"));
    R("m2.implementer-gate-not-peer", pImpl.includes("The Quality Gate is NOT a direct peer for you"));
    const pQa = mod.buildTeammateSystemPrompt(db, "T", "clara", { ...mod.DEFAULT_CONFIG });
    R("m2.qa-runtime-routes-first", pQa.includes("the runtime routes the card to the SDET first"));
    R("m2.qa-no-implementer-baton", !pQa.includes("implementers pass the baton"));
    const pSdet = mod.buildTeammateSystemPrompt(db, "T", "hugo", { ...mod.DEFAULT_CONFIG });
    R("m2.sdet-no-self-audit", pSdet.includes("do not audit your own delivery"));
  } finally {
    cleanup(base, db);
  }

  // Spawn real: implementador e QA com SDET na sala.
  const sbase = mkScratch("m2spawn");
  const sdb = mod.createDb(path.join(sbase, "e.db"));
  const dir = path.join(sbase, "proj");
  mkdirSync(dir, { recursive: true });
  const { calls, client } = makeClient();
  const deps = makeDeps(mod, { db: sdb, directory: dir, client });
  const lead = "ses_lead_m2_spawn";
  try {
    await mod.executeTeamCreate(deps, { name: "h37m2" }, lead);
    const teamId = sdb.query("SELECT id FROM team WHERE name = 'h37m2'").get().id;
    await mod.executeTeamSpawn(deps, { name: "hugo", agent: "hugo", prompt: "suíte", worktree: false }, lead);
    await mod.executeTeamSpawn(deps, { name: "impl", agent: "build", prompt: "implementar", worktree: false }, lead);
    const implSess = sdb.query("SELECT session_id FROM team_member WHERE team_id=? AND name='impl'").get(teamId).session_id;
    const implText = String(calls.promptAsync.find((p) => p.sessionID === implSess)?.parts?.[0]?.text ?? "");
    R("m2.spawn-implementer-auto-route", implText.includes("the runtime routes the card to the SDET hugo automatically"));
    R("m2.spawn-implementer-batch-held", implText.includes("held until the functional batch is consolidated"));
    R("m2.spawn-implementer-no-manual-handoff", implText.includes("do NOT message the SDET to hand off") && !implText.includes("pass the baton"));
    await mod.executeTeamSpawn(deps, { name: "clara", agent: "clara", prompt: "auditar", worktree: false, standby: false }, lead);
    const qaSess = sdb.query("SELECT session_id FROM team_member WHERE team_id=? AND name='clara'").get(teamId).session_id;
    const qaText = String(calls.promptAsync.find((p) => p.sessionID === qaSess)?.parts?.[0]?.text ?? "");
    R("m2.spawn-qa-routes-first", qaText.includes("the runtime routes the card to the SDET first"), `qaSess=${qaSess} prompts=${JSON.stringify(calls.promptAsync.map((p) => p.sessionID))}`);  } catch (err) {
    R("m2.spawn-scenario-executable", false, err?.stack ?? String(err));
  } finally {
    cleanup(sbase, sdb);
  }
  return got;
}

// ===========================================================================
// CENÁRIO M3 — role SDET oficial (schema V1/V2) + spawn com nome arbitrário.
// ===========================================================================
async function captureV2TeamSpawn(registerV2Tools) {
  const captured = [];
  const domain = { transform: async (cb) => { cb({ add: (def) => captured.push(def) }); return { dispose: async () => {} }; } };
  await registerV2Tools(domain, {});
  return captured.find((d) => d?.name === "team_spawn");
}

async function scnM3(mod) {
  const got = new Map();
  const R = (n, ok, d) => got.set(n, { ok: !!ok, detail: d === undefined ? "" : String(d) });

  const spawn = await captureV2TeamSpawn(mod.registerV2Tools);
  R("m3.v2-registered", !!spawn);
  const roleSchema = spawn?.input?.properties?.role;
  R("m3.v2-role-enum", JSON.stringify(roleSchema?.enum) === JSON.stringify(["sdet", "qa", "member"]), JSON.stringify(roleSchema?.enum));

  const sbase = mkScratch("m3spawn");
  const sdb = mod.createDb(path.join(sbase, "e.db"));
  const dir = path.join(sbase, "proj");
  mkdirSync(dir, { recursive: true });
  const { client } = makeClient();
  const deps = makeDeps(mod, { db: sdb, directory: dir, client });
  const lead = "ses_lead_m3_spawn";
  try {
    await mod.executeTeamCreate(deps, { name: "h37m3" }, lead);
    const teamId = sdb.query("SELECT id FROM team WHERE name = 'h37m3'").get().id;
    const res = await mod.executeTeamSpawn(deps, { name: "verity-sdet", agent: "build", role: "sdet", prompt: "suíte arbitraria", worktree: false }, lead);
    const m = sdb.query("SELECT role, status, execution_status FROM team_member WHERE team_id=? AND name='verity-sdet'").get(teamId);
    R("m3.custom-sdet-role-persisted", m?.role === "sdet", JSON.stringify(m));
    R("m3.custom-sdet-auto-standby", typeof res === "string" && res.includes("auto-standby") && m?.status === "ready" && m?.execution_status === "standby", JSON.stringify(m));
    R("m3.resolve-sdet-by-role", mod.getTeamSDETMember(sdb, teamId)?.name === "verity-sdet", String(mod.getTeamSDETMember(sdb, teamId)?.name));
    let err = "";
    try {
      await mod.executeTeamSpawn(deps, { name: "alt-sdet", agent: "build", role: "sdet", prompt: "outro", worktree: false }, lead);
    } catch (e) { err = e instanceof Error ? e.message : String(e); }
    R("m3.sdet-exclusivity-actual-name", err === "Engenheiro de Testes 'verity-sdet' já está ativo na equipe 'h37m3'. Papéis de engenharia de testes são exclusivos e não admitem instâncias concorrentes.", err);
  } catch (err) {
    R("m3.spawn-scenario-executable", false, err?.stack ?? String(err));
  } finally {
    cleanup(sbase, sdb);
  }
  return got;
}

// ===========================================================================
// CENÁRIO M4 — fila por membro em decision_lead + pausa do watchdog.
// ===========================================================================
async function scnM4(mod) {
  const got = new Map();
  const R = (n, ok, d) => got.set(n, { ok: !!ok, detail: d === undefined ? "" : String(d) });
  const base = mkScratch("m4");
  const db = mod.createDb(path.join(base, "e.db"));
  const TEAM = "TM4";
  const LEAD = "ses_lead_m4";
  const A = "ses_tulio_m4";
  const B = "ses_cris_m4";
  const QA = "ses_clara_m4";
  const registry = new mod.MemberRegistry();
  const { calls, client } = makeClient();
  const deps = makeDeps(mod, { db, directory: base, client, registry });
  const queue = () => {
    const raw = db.query("SELECT awaiting_decision_members, awaiting_lead_decision, awaiting_decision_member FROM team WHERE id = ?").get(TEAM);
    let members = [];
    try { members = JSON.parse(raw.awaiting_decision_members ?? "[]"); } catch { members = []; }
    return { members: members.map((e) => e.member), flag: raw.awaiting_lead_decision, legacy: raw.awaiting_decision_member };
  };
  const leadRows = () => db.query("SELECT COUNT(*) AS c FROM team_message WHERE team_id = ? AND to_name = 'lead'").get(TEAM).c;
  const leadWakes = () => calls.promptAsync.filter((c) => c.sessionID === LEAD).length;
  try {
    seedProjectAndTeam(db, { teamId: TEAM, lead: LEAD });
    insertMember(db, { teamId: TEAM, name: "tulio", session: A, agent: "build" });
    insertMember(db, { teamId: TEAM, name: "cris", session: B, agent: "build" });
    insertMember(db, { teamId: TEAM, name: "clara", session: QA, agent: "clara", isQa: 1 });
    registry.register(TEAM, "tulio", A);
    registry.register(TEAM, "cris", B);
    registry.register(TEAM, "clara", QA);
    insertTask(db, { id: "tm4", teamId: TEAM, content: "trabalho pendente", status: "pending" });

    await mod.executeDecisionLead(deps, { question: "Q_A", context: "C_A" }, A);
    await mod.executeDecisionLead(deps, { question: "Q_B", context: "C_B" }, B);
    await tick();
    let q = queue();
    R("m4.both-member-queued", q.members.length === 2 && q.members.includes("tulio") && q.members.includes("cris"), JSON.stringify(q));
    R("m4.pause-active", q.flag === 1 && mod.hasAwaitingLeadDecision(db, TEAM) === true);
    R("m4.legacy-latest-member", q.legacy === "cris", String(q.legacy));
    R("m4.two-durable-messages", leadRows() === 2, `rows=${leadRows()}`);
    R("m4.two-lead-wakes", leadWakes() === 2, `wakes=${leadWakes()}`);

    const rowsBefore = leadRows();
    const wakesBefore = leadWakes();
    const retDup = await mod.executeDecisionLead(deps, { question: "Q_A", context: "C_A" }, A);
    await tick();
    R("m4.re-raise-duplicate-return", typeof retDup === "string" && retDup.includes("already pending"), retDup);
    R("m4.re-raise-no-new-message", leadRows() === rowsBefore, `rows=${leadRows()}`);
    R("m4.re-raise-no-new-wake", leadWakes() === wakesBefore, `wakes=${leadWakes()}`);
    R("m4.re-raise-still-two-queued", queue().members.length === 2, JSON.stringify(queue()));

    mod.clearAwaitingLeadDecision(db, TEAM, "tulio");
    q = queue();
    R("m4.partial-clear-keeps-other", q.members.length === 1 && q.members[0] === "cris", JSON.stringify(q));
    R("m4.partial-clear-keeps-pause", q.flag === 1 && mod.hasAwaitingLeadDecision(db, TEAM) === true, `flag=${q.flag}`);

    // Watchdog ainda pausado enquanto cris espera.
    const stale = NOW() - 120_000;
    db.run("UPDATE team_member SET time_updated = ?, execution_status = 'idle', status = 'ready' WHERE team_id = ?", [stale, TEAM]);
    db.run("UPDATE team_task SET time_updated = ? WHERE team_id = ?", [stale, TEAM]);
    db.run("UPDATE team_message SET time_created = ? WHERE team_id = ?", [stale, TEAM]);
    db.run("UPDATE team_member SET last_nudged_at = NULL WHERE team_id = ? AND name = 'clara'", [TEAM]);
    const wd = new mod.Watchdog({ db, client, registry, ttlMs: 0, roomInactivityThresholdMs: 30_000, roomInactivityCheckMs: 5_000, config: { ...mod.DEFAULT_CONFIG } });
    calls.promptAsync.length = 0;
    await wd.checkRoomInactivity();
    R("m4.watchdog-paused-while-pending", calls.promptAsync.filter((c) => c.sessionID === QA).length === 0, `wakes=${calls.promptAsync.filter((c) => c.sessionID === QA).length}`);

    mod.clearAwaitingLeadDecision(db, TEAM, "cris");
    q = queue();
    R("m4.full-clear-empty-queue", q.members.length === 0 && q.flag === 0 && mod.hasAwaitingLeadDecision(db, TEAM) === false, JSON.stringify(q));
    calls.promptAsync.length = 0;
    await wd.checkRoomInactivity();
    R("m4.watchdog-resumes-after-last-clear", calls.promptAsync.filter((c) => c.sessionID === QA).length === 1, `wakes=${calls.promptAsync.filter((c) => c.sessionID === QA).length}`);
    wd.stop();

    // Limpeza via team_message do lead é por destinatário; destinatário não-pendente
    // é deliberação geral (contrato pré-M4).
    await mod.executeDecisionLead(deps, { question: "Q_A2", context: "C_A2" }, A);
    await mod.executeDecisionLead(deps, { question: "Q_B2", context: "C_B2" }, B);
    await tick();
    await mod.executeTeamMessage(deps, { to: "tulio", text: "siga" }, LEAD);
    q = queue();
    R("m4.lead-message-clears-only-recipient", q.members.length === 1 && q.members[0] === "cris", JSON.stringify(q));
    await mod.executeTeamMessage(deps, { to: "clara", text: "deliberação geral" }, LEAD);
    q = queue();
    R("m4.lead-message-non-pending-clears-all", q.members.length === 0 && q.flag === 0, JSON.stringify(q));
  } catch (err) {
    R("m4.scenario-executable", false, err?.stack ?? String(err));
  } finally {
    cleanup(base, db);
  }
  return got;
}

// ===========================================================================
// CENÁRIO M5 — cleanup do shutdown escopado por team_id (homônimos cross-team).
// ===========================================================================
function scnM5(mod, raw) {
  const got = new Map();
  const R = (n, ok, d) => got.set(n, { ok: !!ok, detail: d === undefined ? "" : String(d) });
  const scoped = "\"SELECT session_id FROM team_member WHERE team_id = ? AND name = ? AND status IN ('shutdown', 'shutdown_requested')\"";
  const m = raw.includes(scoped) ? scoped : null;
  R("m5.scoped-query-present", m !== null, m ? "escopado" : "query escopada ausente");
  const base = mkScratch("m5");
  const db = mod.createDb(path.join(base, "e.db"));
  try {
    seedProjectAndTeam(db, { teamId: "T1", lead: "sesL1" });
    seedProjectAndTeam(db, { teamId: "T2", lead: "sesL2" });
    insertMember(db, { teamId: "T2", name: "hugo", session: "ses_hugo_T2", agent: "hugo", status: "shutdown" });
    insertMember(db, { teamId: "T1", name: "hugo", session: "ses_hugo_T1", agent: "hugo", status: "shutdown" });
    const sql = m ? m.slice(1, -1) : "SELECT session_id FROM team_member WHERE name = ?";
    const params = m ? ["T1", "hugo"] : ["hugo"];
    const row = db.query(sql).get(...params);
    R("m5.scoped-query-correct", row?.session_id === "ses_hugo_T1", JSON.stringify(row));
  } catch (err) {
    R("m5.scoped-query-correct", false, String(err));
  } finally {
    cleanup(base, db);
  }
  return got;
}

// ===========================================================================
// CENÁRIO M6 — resiliência de entrega + ponteiro canônico p/ team_results.
// ===========================================================================
function scnM6(mod) {
  const got = new Map();
  const R = (n, ok, d) => got.set(n, { ok: !!ok, detail: d === undefined ? "" : String(d) });
  const base = mkScratch("m6");
  const db = mod.createDb(path.join(base, "e.db"));
  try {
    seedProjectAndTeam(db, { teamId: "T", lead: "sesL" });
    insertMember(db, { teamId: "T", name: "tulio", session: "ses_tulio", agent: "build" });

    const longPlain = `PLAINSTART ${"X".repeat(700)} PLAINEND`;
    db.run("INSERT INTO team_message (id, team_id, from_name, to_name, content, delivered, time_created) VALUES (?,?,?,?,?,0,?)", ["p1", "T", "clara", "tulio", longPlain, NOW()]);
    const longDetails = `DETAILSTART ${"Y".repeat(700)} DETAILEND`;
    db.run("INSERT INTO team_message (id, team_id, from_name, to_name, content, delivered, time_created) VALUES (?,?,?,?,?,0,?)", ["p2", "T", "cris", "tulio", `<task-result><status>done</status><summary>s</summary><details>${longDetails}</details></task-result>`, NOW() + 1]);
    db.run("INSERT INTO team_message (id, team_id, from_name, to_name, content, delivered, time_created) VALUES (?,?,?,?,?,0,?)", ["p3", "T", "ana", "tulio", "SHORT-VERBATIM", NOW() + 2]);

    const p = mod.buildTeammateSystemPrompt(db, "T", "tulio", { ...mod.DEFAULT_CONFIG });
    R("m6.plain-truncation-notice", p.includes("use team_results to read the full message"), "");
    R("m6.structured-truncation-notice", p.includes("(use team_results to read the full message)"));
    R("m6.short-verbatim", p.includes("SHORT-VERBATIM"));
    const delivered = db.query("SELECT COUNT(*) AS c FROM team_message WHERE team_id = ? AND delivered = 1").get("T").c;
    R("m6.three-delivered-after-flush", delivered === 3, `delivered=${delivered}`);

    db.run("INSERT INTO team_message (id, team_id, from_name, to_name, content, delivered, time_created) VALUES (?,?,?,?,?,0,?)", ["l1", "T", "tulio", "lead", `LEADSTART ${"Z".repeat(700)}`, NOW() + 3]);
    const pl = mod.buildLeadSystemPrompt(db, "T", { ...mod.DEFAULT_CONFIG });
    R("m6.lead-truncation-pointer", pl.includes("use team_results to read full message"));
    R("m6.lead-delivered", db.query("SELECT delivered FROM team_message WHERE id = 'l1'").get().delivered === 1);
  } finally {
    cleanup(base, db);
  }
  return got;
}

// ===========================================================================
// CENÁRIO M7 — auto-commit resolvido ANTES do wake de fechamento do board.
// ===========================================================================
async function scnM7(mod) {
  const got = new Map();
  const R = (n, ok, d) => got.set(n, { ok: !!ok, detail: d === undefined ? "" : String(d) });
  const base = mkScratch("m7");
  const repoDir = path.join(base, "room");
  mkdirSync(repoDir, { recursive: true });
  const content = "Fechar frente M7";
  const committed = `feat(runtime): ${content}`;
  const git = (args) => execSync(`git ${args}`, { cwd: repoDir, encoding: "utf8" }).trim();
  try {
    git("init -q");
    git("config user.email h37@test.local");
    git("config user.name h37");
    writeFileSync(path.join(repoDir, "a.txt"), "conteudo\n");
  } catch { /* git init falhou — cenário reporta abaixo */ }

  const db = mod.createDb(path.join(base, "e.db"));
  const TEAM = "TM7";
  const LEAD = "ses_lead_m7";
  const QA = "ses_clara_m7";
  const registry = new mod.MemberRegistry();
  const wakeSnaps = [];
  const calls = { promptAsync: [] };
  const client = {
    session: {
      create: async () => ({ data: { id: "ses_child_m7" } }),
      promptAsync: async (o) => {
        calls.promptAsync.push(o);
        if (o.sessionID === LEAD) {
          let clean = false;
          let head = "(no-commit)";
          try {
            clean = execSync("git status --porcelain", { cwd: repoDir, encoding: "utf8" }).trim() === "";
            head = execSync("git log -1 --format=%s", { cwd: repoDir, encoding: "utf8" }).trim();
          } catch { head = "(no-commit)"; }
          wakeSnaps.push({ clean, head });
        }
        return {};
      },
      abort: async () => ({}),
    },
    tui: { showToast: async () => ({}) },
  };
  const deps = makeDeps(mod, { db, directory: repoDir, client, registry });
  try {
    seedProjectAndTeam(db, { teamId: TEAM, lead: LEAD });
    insertMember(db, { teamId: TEAM, name: "clara", session: QA, agent: "clara", isQa: 1 });
    insertMember(db, { teamId: TEAM, name: "impl", session: "ses_impl_m7", agent: "build" });
    registry.register(TEAM, "clara", QA);
    insertTask(db, { id: "t7", teamId: TEAM, content, status: "in_review", assignee: "impl" });
    db.run("INSERT INTO team_modified_file (team_id, file_path, time_created) VALUES (?,?,?)", [TEAM, path.join(repoDir, "a.txt"), NOW()]);

    const res = await mod.executeTeamTasksComplete(deps, { task_id: "t7", action: "complete" }, QA);
    R("m7.task-completed", db.query("SELECT status FROM team_task WHERE id = 't7'").get().status === "completed");
    R("m7.commit-suffix", typeof res === "string" && res.includes("Task completed and locally committed:"), res);
    let head = ""; let porcelain = "";
    try { head = git("log -1 --format=%s"); porcelain = git("status --porcelain"); } catch (e) { head = String(e); }
    R("m7.head-message", head === committed, head);
    R("m7.tree-clean-after", porcelain === "", porcelain);
    R("m7.wake-fired", wakeSnaps.length >= 1, `wakes=${wakeSnaps.length}`);
    R("m7.wake-tree-clean", wakeSnaps[0]?.clean === true, JSON.stringify(wakeSnaps[0]));
    R("m7.wake-head-committed", wakeSnaps[0]?.head === committed, JSON.stringify(wakeSnaps[0]));
  } catch (err) {
    R("m7.scenario-executable", false, err?.stack ?? String(err));
  } finally {
    cleanup(base, db);
  }
  return got;
}

// ===========================================================================
// CENÁRIO M8 — preservação/concatenação de review_notes no sdet_pass.
// ===========================================================================
async function scnM8(mod) {
  const got = new Map();
  const R = (n, ok, d) => got.set(n, { ok: !!ok, detail: d === undefined ? "" : String(d) });
  const base = mkScratch("m8");
  const db = mod.createDb(path.join(base, "e.db"));
  const registry = new mod.MemberRegistry();
  const { calls, client } = makeClient();
  const deps = makeDeps(mod, { db, directory: base, client, registry });
  try {
    const seedTeam = (id, withQa) => {
      seedProjectAndTeam(db, { teamId: id, lead: `ses_lead_${id}` });
      insertMember(db, { teamId: id, name: "hugo", session: `ses_hugo_${id}`, agent: "hugo", role: "sdet", exec: "idle" });
      insertMember(db, { teamId: id, name: "impl", session: `ses_impl_${id}`, agent: "build" });
      if (withQa) insertMember(db, { teamId: id, name: "clara", session: `ses_clara_${id}`, agent: "clara", isQa: 1 });
      registry.register(id, "hugo", `ses_hugo_${id}`);
      registry.register(id, "impl", `ses_impl_${id}`);
      if (withQa) registry.register(id, "clara", `ses_clara_${id}`);
    };
    seedTeam("TA", true); seedTeam("TB", true); seedTeam("TC", true); seedTeam("TD", false);
    insertTask(db, { id: "ta", teamId: "TA", status: "in_review", assignee: "impl", notes: "implementer note" });
    insertTask(db, { id: "tb", teamId: "TB", status: "in_review", assignee: "impl", notes: "nota do implementador B" });
    insertTask(db, { id: "tc", teamId: "TC", status: "in_review", assignee: "impl" });
    insertTask(db, { id: "td", teamId: "TD", status: "in_review", assignee: "impl" });

    const retA = await mod.executeTeamTasksComplete(deps, { task_id: "ta", action: "sdet_pass", notes: "suite verde" }, "ses_hugo_TA");
    const notesA = db.query("SELECT review_notes, status FROM team_task WHERE id = 'ta'").get();
    R("m8.merge-with-existing", notesA.review_notes === "[Implementador]: implementer note\n[SDET]: suite verde", JSON.stringify(notesA.review_notes));
    R("m8.card-stays-in-review", notesA.status === "in_review", notesA.status);
    R("m8.qa-notified-label", typeof retA === "string" && retA.includes("Quality Gate guardian (clara) notified."), retA);
    await tick();
    const wakeA = calls.promptAsync.find((c) => c.sessionID === "ses_clara_TA");
    R("m8.wake-carries-merged-notes", !!wakeA && String(wakeA.parts?.[0]?.text).includes("[Implementador]: implementer note") && String(wakeA.parts?.[0]?.text).includes("[SDET]: suite verde"), String(wakeA?.parts?.[0]?.text));

    const retC = await mod.executeTeamTasksComplete(deps, { task_id: "tc", action: "sdet_pass", notes: "apenas sdet" }, "ses_hugo_TC");
    const notesC = db.query("SELECT review_notes FROM team_task WHERE id = 'tc'").get();
    R("m8.no-existing-verbatim", notesC.review_notes === "apenas sdet", JSON.stringify(notesC.review_notes));
    R("m8.verbatim-return", typeof retC === "string" && retC.includes("SDET verification recorded: apenas sdet."), retC);

    const retB = await mod.executeTeamTasksComplete(deps, { task_id: "tb", action: "sdet_pass" }, "ses_hugo_TB");
    const notesB = db.query("SELECT review_notes FROM team_task WHERE id = 'tb'").get();
    R("m8.no-new-note-preserves", notesB.review_notes === "nota do implementador B", JSON.stringify(notesB.review_notes));
    R("m8.no-orphan-recorded-dot", typeof retB === "string" && !retB.includes("recorded: .") && retB.includes("SDET verification recorded"), retB);

    const retD = await mod.executeTeamTasksComplete(deps, { task_id: "td", action: "sdet_pass", notes: "sem QA" }, "ses_hugo_TD");
    R("m8.no-qa-explicit", typeof retD === "string" && retD.includes("No Quality Gate guardian present in the room"), retD);
    R("m8.no-qa-no-false-notified", typeof retD === "string" && !retD.includes("notified"), retD);
  } catch (err) {
    R("m8.scenario-executable", false, err?.stack ?? String(err));
  } finally {
    cleanup(base, db);
  }
  return got;
}

// ===========================================================================
// Fase REAL: todos os cenários contra o dist autêntico devem passar 100%.
// ===========================================================================
const SCENARIOS = { m1: scnM1, m2: scnM2, m3: scnM3, m4: scnM4, m5: scnM5, m6: scnM6, m7: scnM7, m8: scnM8 };
const realMaps = {};
for (const [name, fn] of Object.entries(SCENARIOS)) {
  let map;
  try { map = await fn(REAL, distRaw); } catch (err) { check(`[real] ${name}: cenário executável`, false, err?.stack ?? String(err)); map = new Map(); }
  realMaps[name] = map;
  for (const [n, v] of map) check(`[real] ${n}`, v.ok, v.detail);
}

// ---------------------------------------------------------------------------
// Paridade src↔dist + literais de defesa + anti-mock.
// ---------------------------------------------------------------------------
check(
  "paridade M3: enum role ['sdet','qa','member'] nas DUAS camadas (src e dist)",
  countOf(srcIndex, '["sdet", "qa", "member"]') === 1 && countOf(srcV2, '["sdet", "qa", "member"]') === 1 &&
    countOf(distRaw, '["sdet", "qa", "member"]') === 2,
  `srcV1=${countOf(srcIndex, '["sdet", "qa", "member"]')} srcV2=${countOf(srcV2, '["sdet", "qa", "member"]')} dist=${countOf(distRaw, '["sdet", "qa", "member"]')}`,
);
check(
  "paridade M3: trava SDET interpola existingSDET.name (src e dist)",
  srcSpawn.includes("Engenheiro de Testes '${existingSDET.name}' já está ativo") &&
    distRaw.includes("Engenheiro de Testes '${existingSDET.name}' j"),
  "",
);
check(
  "paridade M2: implementador sem handoff manual (src e dist)",
  srcSystemPrompt.includes("the runtime wakes the SDET automatically") && distRaw.includes("the runtime wakes the SDET automatically") &&
    !srcSystemPrompt.includes("pass the baton exclusively to the SDET") && !distRaw.includes("pass the baton exclusively to the SDET"),
  "",
);
check(
  "paridade M2: descrições V1/V2 alinhadas ao silentLead (src e dist)",
  countOf(srcIndex, "under silentLead they do not wake you on each completion") === 1 &&
    countOf(srcV2, "under silentLead they do not wake you on each completion") === 1 &&
    countOf(distRaw, "under silentLead they do not wake you on each completion") === 2 &&
    countOf(distRaw, "Under silentLead you are not woken for each individual completion") === 2,
  `dist=${countOf(distRaw, "under silentLead they do not wake you on each completion")}`,
);
check(
  // TICKET-RELEASE-17: stall nudge wording removed with checkStalled; the
  // silentLead-aware chatty nudge and the lead prompt remain intact.
  "paridade M1: prompt do lead + nudge chatty silentLead-aware (src e dist)",
  srcSystemPrompt.includes("under silentLead you are NOT woken for each individual completion.") &&
    srcSystemPrompt.includes("Progress lives on the shared board and in team_results") &&
    !srcWatchdog.includes("Refocus on your current task and drive it forward") &&
    srcWatchdog.includes("advancing it on the shared board rather than over-coordinating") &&
    distRaw.includes("under silentLead you are NOT woken for each individual completion.") &&
    !distRaw.includes("Refocus on your current task and drive it forward") &&
    distRaw.includes("advancing it on the shared board rather than over-coordinating"),
  "",
);
check(
  "paridade M5: cleanup do shutdown escopado por team_id (src e dist) e query antiga ausente",
  srcIndex.includes("findTeamBySession(db, registry, ctx.sessionID)") &&
    distRaw.includes("findTeamBySession(db, registry, ctx.sessionID)") &&
    srcIndex.includes("WHERE team_id = ? AND name = ? AND status IN ('shutdown', 'shutdown_requested')") &&
    distRaw.includes("WHERE team_id = ? AND name = ? AND status IN ('shutdown', 'shutdown_requested')") &&
    !distRaw.includes("FROM team_member WHERE name = ? AND status IN ('shutdown', 'shutdown_requested')"),
  "",
);
check(
  "paridade M6: markDelivered só no flush final (src e dist)",
  !srcSystemPrompt.includes("markDelivered(db, msg.id)") &&
    countOf(srcSystemPrompt, "deliveredMessageIds.push(msg.id)") === 2 &&
    countOf(srcSystemPrompt, "for (const id of deliveredMessageIds) {") === 2 &&
    countOf(distRaw, "deliveredMessageIds.push(msg.id)") === 2 &&
    countOf(distRaw, "for (const id of deliveredMessageIds) {") === 2,
  `srcPush=${countOf(srcSystemPrompt, "deliveredMessageIds.push(msg.id)")} srcFlush=${countOf(srcSystemPrompt, "for (const id of deliveredMessageIds) {")}`,
);
check(
  "paridade M7: auto-commit aparece ANTES do bloco de wake do board (src e dist)",
  srcTasksComplete.indexOf("autoCommitApprovedTask(deps, teamInfo.teamId, task.content, task.id)") <
    srcTasksComplete.indexOf("tasks-complete:wake-lead:sent") &&
    distRaw.indexOf("autoCommitApprovedTask(deps, teamInfo.teamId, task.content, task.id)") <
    distRaw.indexOf("tasks-complete:wake-lead:sent"),
  "",
);
check(
  "paridade M8: concatenação [Implementador]/[SDET] + QA fidedigno (src e dist)",
  srcTasksComplete.includes("[Implementador]: ${existingNotes}\\n[SDET]: ${sdetNotes}") &&
    distRaw.includes("[Implementador]: ${existingNotes}") &&
    srcTasksComplete.includes("No Quality Gate guardian present in the room") &&
    distRaw.includes("No Quality Gate guardian present in the room"),
  "",
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
const moveCommitAfterWake = (raw) => {
  const block = '\n  let commitSuffix = "";\n  if (teamInfo.role === "lead" || isQAMember(deps.db, teamInfo.teamId, caller)) {\n    commitSuffix = await autoCommitApprovedTask(deps, teamInfo.teamId, task.content, task.id);\n  }\n';
  const i = raw.indexOf(block);
  if (i < 0) return raw;
  const without = raw.slice(0, i) + raw.slice(i + block.length);
  const j = without.lastIndexOf("\n  return `Completed task:");
  if (j < 0) return raw;
  return without.slice(0, j) + block + without.slice(j);
};

const MUTATIONS = [
  {
    id: "H37-1",
    desc: "M1: prompt do lead ignora silentLead (coerção de DM ao lead)",
    from: "const silentLead = config?.silentLead !== false;",
    to: "const silentLead = false;",
    scenarios: ["m1"],
    detect: ["m1.lead-prompt-silent-wording", "m1.lead-prompt-board-first", "m1.lead-prompt-no-message-you-when-done"],
    unaffected: ["m1.lead-prompt-legacy-byte-stable", "m1.lead-prompt-legacy-no-silent-line"],
  },
  // H37-2 (nudge de stall) foi removido junto com checkStalled no
  // TICKET-RELEASE-17 — não há mais caminho de produção a mutar.
  {
    id: "H37-3",
    desc: "M2: implementador volta a fazer handoff manual ao SDET",
    from: "the runtime wakes the SDET automatically",
    to: "pass the baton exclusively to the SDET",
    scenarios: ["m2"],
    detect: ["m2.implementer-runtime-wakes-sdet", "m2.implementer-no-baton"],
    unaffected: ["m2.implementer-batch-held", "m2.implementer-gate-not-peer"],
  },
  {
    id: "H37-4",
    desc: "M3: enum V2 volta a ['qa','member'] (SDET deixa de ser oficial)",
    from: 'enum: ["sdet", "qa", "member"]',
    to: 'enum: ["qa", "member"]',
    scenarios: ["m3"],
    detect: ["m3.v2-role-enum"],
    unaffected: ["m3.custom-sdet-role-persisted", "m3.custom-sdet-auto-standby"],
  },
  {
    id: "H37-5",
    desc: "M3: trava SDET volta ao literal 'hugo' (nome real não interpolado)",
    from: "Engenheiro de Testes '${existingSDET.name}' j",
    to: "Engenheiro de Testes 'hugo' j",
    scenarios: ["m3"],
    detect: ["m3.sdet-exclusivity-actual-name"],
    unaffected: ["m3.custom-sdet-role-persisted", "m3.v2-role-enum"],
  },
  {
    id: "H37-6",
    desc: "M4: clear por membro limpa a fila inteira (destranca outro)",
    from: "    const isPending = entries.some((e) => e.member === memberName);\n    remaining = isPending ? entries.filter((e) => e.member !== memberName) : [];",
    to: "    remaining = [];",
    scenarios: ["m4"],
    detect: ["m4.partial-clear-keeps-other", "m4.partial-clear-keeps-pause", "m4.watchdog-paused-while-pending"],
    unaffected: ["m4.both-member-queued", "m4.two-durable-messages", "m4.full-clear-empty-queue"],
  },
  {
    id: "H37-7",
    desc: "M4: re-raise idêntico volta a duplicar mensagem e wake",
    from: "if (mark.duplicate) {",
    to: "if (false) {",
    scenarios: ["m4"],
    detect: ["m4.re-raise-no-new-message", "m4.re-raise-no-new-wake", "m4.re-raise-duplicate-return"],
    unaffected: ["m4.both-member-queued", "m4.two-lead-wakes", "m4.partial-clear-keeps-other"],
  },
  {
    id: "H37-8",
    desc: "M5: lookup do shutdown perde o escopo team_id (colisão cross-team)",
    from: "WHERE team_id = ? AND name = ? AND status IN ('shutdown', 'shutdown_requested')",
    to: "WHERE name = ? AND status IN ('shutdown', 'shutdown_requested')",
    scenarios: ["m5"],
    detect: ["m5.scoped-query-present", "m5.scoped-query-correct"],
    unaffected: [],
  },
  {
    id: "H37-9",
    desc: "M6: flush de delivered removido (mensagem é perdida silenciosamente)",
    mutate: (raw) => {
      const needle = "for (const id of deliveredMessageIds) {";
      const i = raw.indexOf(needle);
      if (i < 0) return raw;
      return raw.slice(0, i) + "for (const id of deliveredMessageIds.slice(0, 0)) {" + raw.slice(i + needle.length);
    },
    scenarios: ["m6"],
    detect: ["m6.lead-delivered"],
    unaffected: ["m6.plain-truncation-notice", "m6.short-verbatim"],
  },
  {
    id: "H37-10",
    desc: "M7: auto-commit movido para DEPOIS do wake do board (wake vê árvore suja)",
    mutate: moveCommitAfterWake,
    scenarios: ["m7"],
    detect: ["m7.wake-tree-clean", "m7.wake-head-committed"],
    unaffected: ["m7.task-completed", "m7.commit-suffix", "m7.head-message", "m7.tree-clean-after"],
  },
  {
    id: "H37-11",
    desc: "M8: concatenação perde as notas do implementador",
    from: "`[Implementador]: ${existingNotes}\n[SDET]: ${sdetNotes}`",
    to: "`[SDET]: ${sdetNotes}`",
    scenarios: ["m8"],
    detect: ["m8.merge-with-existing", "m8.wake-carries-merged-notes"],
    unaffected: ["m8.no-existing-verbatim", "m8.no-orphan-recorded-dot"],
  },
  {
    id: "H37-12",
    desc: "M8: sala sem QA declara falsamente 'guardian notified'",
    from: '"No Quality Gate guardian present in the room \\u2014 the verdict was recorded on the board."',
    to: '"Quality Gate guardian notified."',
    scenarios: ["m8"],
    detect: ["m8.no-qa-explicit", "m8.no-qa-no-false-notified"],
    unaffected: ["m8.merge-with-existing", "m8.qa-notified-label"],
  },
];

for (const m of MUTATIONS) {
  let mutatedRaw;
  if (m.mutate) {
    mutatedRaw = m.mutate(distRaw);
    check(`${m.id}: patch aplicável (bundle alterado)`, mutatedRaw !== distRaw, m.desc);
  } else {
    const occurrences = distRaw.split(m.from).length - 1;
    check(`${m.id}: patch aplicável (1 ocorrência exata no dist)`, occurrences === 1, `ocorrências=${occurrences}`);
    if (occurrences !== 1) continue;
    mutatedRaw = distRaw.split(m.from).join(m.to);
  }
  if (mutatedRaw === distRaw) continue;

  let mutated;
  try {
    mutated = await import(harnessFile(mutatedRaw, `_h37_${m.id.toLowerCase().replace(/-/g, "_")}.mjs`));
  } catch (err) {
    check(`${m.id}: mutante importável`, false, err?.stack ?? String(err));
    continue;
  }

  const agg = new Map();
  let runnable = true;
  for (const scn of m.scenarios) {
    try {
      const map = await SCENARIOS[scn](mutated, mutatedRaw);
      for (const [n, v] of map) agg.set(n, v);
    } catch (err) {
      runnable = false;
      check(`${m.id}: cenário ${scn} executável sob mutação`, false, err?.stack ?? String(err));
    }
  }
  if (!runnable) continue;

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
