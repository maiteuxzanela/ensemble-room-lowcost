#!/usr/bin/env node
/**
 * TICKET-HARNESS-49 (Frente 2) — Unificação do ciclo de vida team_shutdown.
 *
 * Cobre o novo `executeTeamShutdown` canônico contra SQLite REAL e o bundle dist
 * REAL (sem mocks):
 *   LS1  member "*" → desliga/aborta TODOS os ativos EM PARALELO, libera as
 *        tarefas dos membros, preserva branches, remove worktree/workspace,
 *        arquiva a equipe (status 'archived') e limpa o registry.
 *   LS2  member OMITIDO → mesmo caminho wildcard.
 *   LS3  "*"/"all"/"ALL" (e com espaços) → mesmo caminho wildcard.
 *   LS4  Retrocompat: member "tales" → desliga SÓ tales; os demais seguem ready
 *        e a equipe permanece 'active' (sem cleanup).
 *   LS5  Retrocompat: 2ª chamada em membro já 'shutdown_requested' → force abort
 *        só daquele membro.
 *   LS6  Chamador não-lead → erro de autorização, zero side effects.
 *   LS7  Guarda de trabalho não-commitado: wildcard sem acknowledge_uncommitted
 *        BLOQUEIA (Warning, nenhum abort); com acknowledge_uncommitted: true
 *        prossegue.
 *   LS8  Alias `team_cleanup` (V2) delega ao rotina unificada: desliga ativos +
 *        limpa a sala; schema V1/V2 sem `required` no team_shutdown.
 *
 * PROVA DE MUTAÇÃO:
 *   M1 remove a absorção do cleanup no wildcard (shutdownWholeTeam não mais
 *      chama executeTeamCleanup) → LS1/LS2/LS3/LS8 perdem o arquivamento.
 *   M2 remove o roteamento wildcard do member omitido → LS2/LS3 roteiam errado.
 *
 * Único seam: cliente SDK do OpenCode (fronteira externa), reduzido a um
 * recorder determinístico de abort/promptAsync — mesmo padrão das demais suítes
 * do repo. Nenhum componente de produção é substituído: SQLite e bundle dist
 * rodam reais, em mkdtempSync FORA da árvore do repositório.
 *
 * Uso: node tests/test_ticket_harness_49_lifecycle.mjs
 * Exit: 0 = todos os checks PASS; 1 = há FAIL.
 */

import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

const REPO = path.resolve(import.meta.dirname, "..");
const DIST = path.join(REPO, "dist/index.js");
const SRC = path.join(REPO, "src");
const SRC_INDEX = path.join(SRC, "index.ts");
const TMP = path.join(REPO, ".test-scratch", "h49");
mkdirSync(TMP, { recursive: true });

const results = [];
const check = (name, ok, detail) => {
  results.push([name, ok]);
  console.log(`${ok ? "PASS" : "FAIL"} | ${name}${detail ? " | " + detail : ""}`);
};
const unhandled = [];
process.on("unhandledRejection", (e) => unhandled.push(e));

// ---------------------------------------------------------------------------
// 0. Harness: dist real + exportação dos símbolos sob teste (sem mocks).
// ---------------------------------------------------------------------------
const REQUIRED_SYMBOLS = [
  "createDb", "DEFAULT_CONFIG", "MemberRegistry", "ProgressTracker", "DescendantTracker",
  "PendingPurgeApprovals", "executeTeamShutdown", "executeTeamCleanup", "registerV2Tools",
];
const distRaw = readFileSync(DIST, "utf8");
const srcIndexRaw = readFileSync(SRC_INDEX, "utf8");

const buildHarnessCode = (raw) => {
  const existingExport = raw.match(/export\s*\{([^}]*)\}\s*;?\s*$/)?.[1] ?? "";
  const already = new Set(existingExport.split(",").map((s) => s.trim().split(/\s+as\s+/).pop()).filter(Boolean));
  const need = REQUIRED_SYMBOLS.filter((s) => !already.has(s));
  return raw + (need.length ? `\nexport { ${need.join(", ")} };\n` : "");
};
{
  const missing = REQUIRED_SYMBOLS.filter((s) => !new RegExp(`(function|class|var|const|let)\\s+${s}\\b`).test(distRaw));
  check("harness: dist declara todos os símbolos exigidos", missing.length === 0, missing.join(",") || `${REQUIRED_SYMBOLS.length} símbolos`);
  writeFileSync(path.join(TMP, "_h49_real.mjs"), buildHarnessCode(distRaw));
}
const REAL = await import(path.join(TMP, "_h49_real.mjs"));

const NOW = () => Date.now();
function mkScratch(tag) { return mkdtempSync(path.join(os.tmpdir(), `ens-h49-${tag}-`)); }
function cleanup(base, db) {
  try { db?.close(); } catch { /* já fechado */ }
  try { rmSync(base, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }); } catch { /* best effort */ }
}

function seedProjectAndTeam(db, { teamId, teamName, lead }) {
  const t = NOW();
  db.run("INSERT OR IGNORE INTO project (id, name, path, status, time_created, time_updated) VALUES (?,?,?,?,?,?)", ["default", "Default", "", "active", t, t]);
  db.run(
    "INSERT INTO team (id, name, project_id, lead_session_id, lead_agent, status, delegate, awaiting_lead_decision, time_created, time_updated) VALUES (?,?,?,?,?,?,?,?,?,?)",
    [teamId, teamName, "default", lead, "dante", "active", 0, 0, t, t],
  );
}
function insertMember(db, { teamId, name, session, agent, status = "ready", exec = "idle", isQa = 0, role = null, worktreeDir = null, worktreeBranch = null, workspaceId = null }) {
  db.run(
    `INSERT INTO team_member (team_id, name, session_id, agent, status, execution_status, is_qa, role, spawn_context, worktree_dir, worktree_branch, workspace_id, reported_to_lead, time_created, time_updated)
     VALUES (?,?,?,?,?,?,?,?,NULL,?,?,?,0,?,?)`,
    [teamId, name, session, agent, status, exec, isQa, role, worktreeDir, worktreeBranch, workspaceId, NOW(), NOW()],
  );
}
function insertTask(db, { id, teamId, content = "tarefa", status, assignee = null }) {
  db.run(
    "INSERT INTO team_task (id, team_id, content, status, priority, assignee, time_created, time_updated) VALUES (?,?,?,?,?,?,?,?)",
    [id, teamId, content, status, "high", assignee, NOW(), NOW()],
  );
}

/** Recorder determinístico da fronteira SDK (abort/promptAsync/worktree/workspace). */
function makeClient() {
  const calls = { abort: [], promptAsync: [], worktreeRemove: [], workspaceRemove: [] };
  let inFlight = 0;
  let maxInFlight = 0;
  const client = {
    session: {
      create: async () => ({ data: { id: "ses_unused" } }),
      promptAsync: async (o) => { calls.promptAsync.push(o); return {}; },
      abort: async (o) => { calls.abort.push(o.sessionID); inFlight++; maxInFlight = Math.max(maxInFlight, inFlight); await new Promise((r) => setImmediate(r)); inFlight--; return {}; },
      status: async () => ({ data: {} }),
    },
    tui: { showToast: async () => ({}), selectSession: async () => ({}) },
    worktree: { remove: async (o) => { calls.worktreeRemove.push(o); return {}; }, list: async () => ({ data: [] }), create: async () => ({ data: {} }), reset: async () => ({}) },
    workspace: { remove: async (o) => { calls.workspaceRemove.push(o); return {}; }, list: async () => ({ data: [] }), create: async () => ({ data: {} }) },
  };
  return { calls, client, maxInFlight: () => maxInFlight };
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

/** Invoca executeTeamShutdown com injetáveis determinísticos (sem tocar git real). */
async function shutdown(mod, deps, args, ses, opts = {}) {
  try {
    const res = await mod.executeTeamShutdown(
      deps, args, ses,
      opts.isDirty ?? (async () => false),
      opts.preserve ?? (async () => true),
      opts.commitCount ?? (async () => 0),
      opts.merge ?? (async () => ({ ok: true })),
      opts.delBranch ?? (async () => true),
      opts.mergeOnCleanup ?? false,
      opts.overlapCheck ?? (async () => []),
    );
    return { res, err: null };
  } catch (e) {
    return { res: "", err: e instanceof Error ? e.message : String(e) };
  }
}

const statusOf = (db, teamId) => db.query("SELECT status FROM team WHERE id = ?").get(teamId)?.status;
const memberRow = (db, teamId, name) => db.query("SELECT status, execution_status, worktree_branch, worktree_dir, workspace_id FROM team_member WHERE team_id = ? AND name = ?").get(teamId, name);

const runScenario = async (fn) => { try { await fn(); } catch (e) { check("cenário executável", false, e?.stack ?? String(e)); } };

// ===========================================================================
// LS1 — wildcard desliga 3 membros em paralelo + cleanup completo.
// ===========================================================================
await runScenario(async () => {
  const base = mkScratch("ls1");
  const db = REAL.createDb(path.join(base, "e.db"));
  const { calls, client, maxInFlight } = makeClient();
  const registry = new REAL.MemberRegistry();
  const deps = makeDeps(REAL, { db, directory: base, client, registry });
  const TEAM = "TLS1", LEAD = "ses_lead_ls1";
  try {
    seedProjectAndTeam(db, { teamId: TEAM, teamName: "ls1-squad", lead: LEAD });
    insertMember(db, { teamId: TEAM, name: "tales", session: "ses_tales_ls1", agent: "build", worktreeDir: path.join(base, "wt-tales"), worktreeBranch: "ensemble-ls1-tales", workspaceId: "ws-tales" });
    insertMember(db, { teamId: TEAM, name: "tulio", session: "ses_tulio_ls1", agent: "build" });
    insertMember(db, { teamId: TEAM, name: "clara", session: "ses_clara_ls1", agent: "clara", isQa: 1, role: "qa" });
    registry.register(TEAM, "tales", "ses_tales_ls1");
    registry.register(TEAM, "tulio", "ses_tulio_ls1");
    registry.register(TEAM, "clara", "ses_clara_ls1");
    insertTask(db, { id: "ts1a", teamId: TEAM, status: "in_progress", assignee: "tales" });
    insertTask(db, { id: "ts1b", teamId: TEAM, status: "in_progress", assignee: "tulio" });

    const { res, err } = await shutdown(REAL, deps, { member: "*" }, LEAD);

    check("LS1.no-error", err === null, err);
    check("LS1.three-aborts", calls.abort.length === 3, `aborts=${calls.abort.length}`);
    check("LS1.aborts-parallel", maxInFlight() === 3, `maxInFlight=${maxInFlight()}`);
    check("LS1.all-sessions-aborted", ["ses_tales_ls1", "ses_tulio_ls1", "ses_clara_ls1"].every((s) => calls.abort.includes(s)), calls.abort.join(","));
    check("LS1.all-shutdown", ["tales", "tulio", "clara"].every((n) => memberRow(db, TEAM, n)?.status === "shutdown"), ["tales", "tulio", "clara"].map((n) => memberRow(db, TEAM, n)?.status).join(","));
    check("LS1.all-idle", ["tales", "tulio", "clara"].every((n) => memberRow(db, TEAM, n)?.execution_status === "idle"));
    check("LS1.response-count", res.includes("Shut down 3 teammate(s):"), res);
    check("LS1.response-names", ["tales", "tulio", "clara"].every((n) => res.includes(n)), res);
    check("LS1.response-cleanup", res.includes('Team "ls1-squad" cleaned up.'), res);
    check("LS1.team-archived", statusOf(db, TEAM) === "archived", String(statusOf(db, TEAM)));
    check("LS1.tasks-released", db.query("SELECT status, assignee FROM team_task WHERE team_id = ?").all(TEAM).every((t) => t.status === "pending" && t.assignee === null), JSON.stringify(db.query("SELECT id, status, assignee FROM team_task WHERE team_id = ?").all(TEAM)));
    check("LS1.registry-cleared", registry.listByTeam(TEAM).length === 0, `len=${registry.listByTeam(TEAM).length}`);
    const talesRow = memberRow(db, TEAM, "tales");
    check("LS1.branch-preserved", typeof talesRow?.worktree_branch === "string" && talesRow.worktree_branch.startsWith("ensemble/preserved/"), String(talesRow?.worktree_branch));
    check("LS1.workspace-removed", calls.workspaceRemove.length === 1 && talesRow?.workspace_id === null, `calls=${calls.workspaceRemove.length}`);
    check("LS1.worktree-removed", calls.worktreeRemove.length === 1 && talesRow?.worktree_dir === null, `calls=${calls.worktreeRemove.length}`);
  } finally { cleanup(base, db); }
});

// ===========================================================================
// LS2 — member OMITIDO → mesmo caminho wildcard.
// ===========================================================================
await runScenario(async () => {
  const base = mkScratch("ls2");
  const db = REAL.createDb(path.join(base, "e.db"));
  const { calls, client } = makeClient();
  const deps = makeDeps(REAL, { db, directory: base, client });
  const TEAM = "TLS2", LEAD = "ses_lead_ls2";
  try {
    seedProjectAndTeam(db, { teamId: TEAM, teamName: "ls2-squad", lead: LEAD });
    insertMember(db, { teamId: TEAM, name: "tales", session: "ses_tales_ls2", agent: "build" });
    insertMember(db, { teamId: TEAM, name: "tulio", session: "ses_tulio_ls2", agent: "build" });

    const { res, err } = await shutdown(REAL, deps, {}, LEAD);
    check("LS2.no-error", err === null, err);
    check("LS2.two-aborts", calls.abort.length === 2, `aborts=${calls.abort.length}`);
    check("LS2.response-count", res.includes("Shut down 2 teammate(s):"), res);
    check("LS2.team-archived", statusOf(db, TEAM) === "archived", String(statusOf(db, TEAM)));
  } finally { cleanup(base, db); }
});

// ===========================================================================
// LS3 — "*" / "all" / "ALL" / espaços → wildcard (case-insensitive + trim).
// ===========================================================================
await runScenario(async () => {
  for (const [idx, sentinel] of ["*", "all", "ALL", "  *  "].entries()) {
    const base = mkScratch(`ls3-${idx}`);
    const db = REAL.createDb(path.join(base, "e.db"));
    const { calls, client } = makeClient();
    const deps = makeDeps(REAL, { db, directory: base, client });
    const TEAM = `TLS3_${idx}`, LEAD = `ses_lead_ls3_${idx}`;
    try {
      seedProjectAndTeam(db, { teamId: TEAM, teamName: `ls3-${idx}`, lead: LEAD });
      insertMember(db, { teamId: TEAM, name: "tales", session: `ses_tales_ls3_${idx}`, agent: "build" });
      const { err } = await shutdown(REAL, deps, { member: sentinel }, LEAD);
      check(`LS3.${JSON.stringify(sentinel)}-no-error`, err === null, err);
      check(`LS3.${JSON.stringify(sentinel)}-wildcard`, statusOf(db, TEAM) === "archived" && calls.abort.length === 1, `status=${statusOf(db, TEAM)} aborts=${calls.abort.length}`);
    } finally { cleanup(base, db); }
  }
});

// ===========================================================================
// LS4 — retrocompat: member específico desliga SÓ ele, sem cleanup.
// ===========================================================================
await runScenario(async () => {
  const base = mkScratch("ls4");
  const db = REAL.createDb(path.join(base, "e.db"));
  const { calls, client } = makeClient();
  const deps = makeDeps(REAL, { db, directory: base, client });
  const TEAM = "TLS4", LEAD = "ses_lead_ls4";
  try {
    seedProjectAndTeam(db, { teamId: TEAM, teamName: "ls4-squad", lead: LEAD });
    insertMember(db, { teamId: TEAM, name: "tales", session: "ses_tales_ls4", agent: "build" });
    insertMember(db, { teamId: TEAM, name: "tulio", session: "ses_tulio_ls4", agent: "build" });
    insertMember(db, { teamId: TEAM, name: "clara", session: "ses_clara_ls4", agent: "clara", isQa: 1, role: "qa" });

    const { res, err } = await shutdown(REAL, deps, { member: "tales" }, LEAD);
    check("LS4.no-error", err === null, err);
    check("LS4.one-abort", calls.abort.length === 1 && calls.abort[0] === "ses_tales_ls4", calls.abort.join(","));
    check("LS4.tales-shutdown", memberRow(db, TEAM, "tales")?.status === "shutdown", String(memberRow(db, TEAM, "tales")?.status));
    check("LS4.others-untouched", memberRow(db, TEAM, "tulio")?.status === "ready" && memberRow(db, TEAM, "clara")?.status === "ready", `${memberRow(db, TEAM, "tulio")?.status}/${memberRow(db, TEAM, "clara")?.status}`);
    check("LS4.no-archive", statusOf(db, TEAM) === "active", String(statusOf(db, TEAM)));
    check("LS4.response-legacy", /Teammate "tales" has been shut down\./.test(res), res);
  } finally { cleanup(base, db); }
});

// ===========================================================================
// LS5 — retrocompat: 2ª chamada em 'shutdown_requested' → force abort só dele.
// ===========================================================================
await runScenario(async () => {
  const base = mkScratch("ls5");
  const db = REAL.createDb(path.join(base, "e.db"));
  const { calls, client } = makeClient();
  const deps = makeDeps(REAL, { db, directory: base, client });
  const TEAM = "TLS5", LEAD = "ses_lead_ls5";
  try {
    seedProjectAndTeam(db, { teamId: TEAM, teamName: "ls5-squad", lead: LEAD });
    insertMember(db, { teamId: TEAM, name: "tulio", session: "ses_tulio_ls5", agent: "build", status: "shutdown_requested" });
    insertMember(db, { teamId: TEAM, name: "clara", session: "ses_clara_ls5", agent: "clara", isQa: 1, role: "qa" });

    const { res, err } = await shutdown(REAL, deps, { member: "tulio" }, LEAD);
    check("LS5.no-error", err === null, err);
    check("LS5.one-abort", calls.abort.length === 1 && calls.abort[0] === "ses_tulio_ls5", calls.abort.join(","));
    check("LS5.force-shut-down", memberRow(db, TEAM, "tulio")?.status === "shutdown", String(memberRow(db, TEAM, "tulio")?.status));
    check("LS5.other-untouched", memberRow(db, TEAM, "clara")?.status === "ready", String(memberRow(db, TEAM, "clara")?.status));
    check("LS5.response-force", /Force shut down "tulio"\./.test(res), res);
    check("LS5.no-archive", statusOf(db, TEAM) === "active", String(statusOf(db, TEAM)));
  } finally { cleanup(base, db); }
});

// ===========================================================================
// LS6 — chamador não-lead → erro de autorização, zero efeitos.
// ===========================================================================
await runScenario(async () => {
  const base = mkScratch("ls6");
  const db = REAL.createDb(path.join(base, "e.db"));
  const { calls, client } = makeClient();
  const registry = new REAL.MemberRegistry();
  const deps = makeDeps(REAL, { db, directory: base, client, registry });
  const TEAM = "TLS6", LEAD = "ses_lead_ls6", MEMBER = "ses_tales_ls6";
  try {
    seedProjectAndTeam(db, { teamId: TEAM, teamName: "ls6-squad", lead: LEAD });
    insertMember(db, { teamId: TEAM, name: "tales", session: MEMBER, agent: "build" });
    registry.register(TEAM, "tales", MEMBER);

    const { res, err } = await shutdown(REAL, deps, { member: "*" }, MEMBER);
    check("LS6.authorization-error", err === "Only the team lead can use this tool.", err);
    check("LS6.zero-aborts", calls.abort.length === 0, `aborts=${calls.abort.length}`);
    check("LS6.team-still-active", statusOf(db, TEAM) === "active", String(statusOf(db, TEAM)));
    check("LS6.member-still-ready", memberRow(db, TEAM, "tales")?.status === "ready", String(memberRow(db, TEAM, "tales")?.status));
    check("LS6.no-response", res === "", res);
  } finally { cleanup(base, db); }
});

// ===========================================================================
// LS7 — guarda de trabalho não-commitado bloqueia o wildcard.
// ===========================================================================
await runScenario(async () => {
  const base = mkScratch("ls7");
  const db = REAL.createDb(path.join(base, "e.db"));
  const { calls, client } = makeClient();
  const deps = makeDeps(REAL, { db, directory: base, client });
  const TEAM = "TLS7", LEAD = "ses_lead_ls7";
  try {
    seedProjectAndTeam(db, { teamId: TEAM, teamName: "ls7-squad", lead: LEAD });
    insertMember(db, { teamId: TEAM, name: "tales", session: "ses_tales_ls7", agent: "build", worktreeDir: path.join(base, "wt"), worktreeBranch: "ensemble-ls7-tales" });
    insertMember(db, { teamId: TEAM, name: "clara", session: "ses_clara_ls7", agent: "clara", isQa: 1, role: "qa" });

    const blocked = await shutdown(REAL, deps, { member: "*" }, LEAD, { isDirty: async () => true });
    check("LS7.blocked-no-error", blocked.err === null, blocked.err);
    check("LS7.blocked-warning", /Warning: 1 teammate\(s\) have uncommitted changes/.test(blocked.res), blocked.res);
    check("LS7.blocked-zero-aborts", calls.abort.length === 0, `aborts=${calls.abort.length}`);
    check("LS7.blocked-team-active", statusOf(db, TEAM) === "active", String(statusOf(db, TEAM)));

    const acked = await shutdown(REAL, deps, { member: "*", acknowledge_uncommitted: true }, LEAD, { isDirty: async () => true });
    check("LS7.acked-no-error", acked.err === null, acked.err);
    check("LS7.acked-proceeds", calls.abort.length === 2 && statusOf(db, TEAM) === "archived", `aborts=${calls.abort.length} status=${statusOf(db, TEAM)}`);
    check("LS7.acked-response-cleanup", acked.res.includes('Team "ls7-squad" cleaned up.'), acked.res);
  } finally { cleanup(base, db); }
});

// ===========================================================================
// LS8 — alias team_cleanup (V2) delega à rotina unificada.
// ===========================================================================
async function captureV2Tool(registerV2Tools, deps, name) {
  const captured = [];
  const domain = { transform: async (cb) => { cb({ add: (def) => captured.push(def) }); return { dispose: async () => {} }; } };
  await registerV2Tools(domain, deps);
  return captured.find((d) => d?.name === name);
}

await runScenario(async () => {
  const base = mkScratch("ls8");
  const db = REAL.createDb(path.join(base, "e.db"));
  const { calls, client } = makeClient();
  const deps = makeDeps(REAL, { db, directory: base, client });
  const TEAM = "TLS8", LEAD = "ses_lead_ls8";
  try {
    seedProjectAndTeam(db, { teamId: TEAM, teamName: "ls8-squad", lead: LEAD });
    insertMember(db, { teamId: TEAM, name: "tales", session: "ses_tales_ls8", agent: "build" });
    insertMember(db, { teamId: TEAM, name: "clara", session: "ses_clara_ls8", agent: "clara", isQa: 1, role: "qa" });

    const shutdownTool = await captureV2Tool(REAL.registerV2Tools, deps, "team_shutdown");
    const cleanupTool = await captureV2Tool(REAL.registerV2Tools, deps, "team_cleanup");
    check("LS8.v2-both-registered", !!shutdownTool && !!cleanupTool);
    check("LS8.v2-shutdown-member-optional", shutdownTool?.input?.required === undefined && shutdownTool?.input?.properties?.member?.type === "string", JSON.stringify(shutdownTool?.input?.required));
    check("LS8.v2-cleanup-no-member-prop", cleanupTool && !("member" in (cleanupTool?.input?.properties ?? {})), JSON.stringify(Object.keys(cleanupTool?.input?.properties ?? {})));

    const out = await cleanupTool.execute({ force: false, acknowledge_uncommitted: true }, { sessionID: LEAD });
    const content = typeof out === "string" ? out : out?.content ?? "";
    check("LS8.alias-no-error", typeof content === "string" && content.length > 0, content);
    check("LS8.alias-shutdown-active", content.includes("Shut down 2 teammate(s):"), content);
    check("LS8.alias-cleanup", content.includes('Team "ls8-squad" cleaned up.'), content);
    check("LS8.alias-archived", statusOf(db, TEAM) === "archived", String(statusOf(db, TEAM)));
    check("LS8.alias-aborts", calls.abort.length === 2, `aborts=${calls.abort.length}`);
  } finally { cleanup(base, db); }
});

// ---------------------------------------------------------------------------
// Verificações estáticas: paridade src↔dist da delegação do alias + anti-mock.
// ---------------------------------------------------------------------------
check(
  "paridade src↔dist: team_cleanup delega a executeTeamShutdown com member '*'",
  srcIndexRaw.includes('executeTeamShutdown(deps, { ...args, member: "*" }') && distRaw.includes('{ ...args, member: "*" }'),
);
check(
  "paridade src↔dist: wildcard detection cobre member omitido e '*\\''*'/all",
  /const requested = args\.member\?\.trim\(\) \?\? ""/.test(readFileSync(path.join(SRC, "tools/team-shutdown.ts"), "utf8")) &&
    distRaw.includes('return shutdownWholeTeam(deps, teamInfo, args'),
);
{
  const FORBIDDEN = ["je" + "st.mock", "sin" + "on", "vi.mo" + "ck", "mockImple" + "mentation"];
  const forbiddenRe = new RegExp(FORBIDDEN.join("|"), "i");
  check("anti-mock: suíte não contém marcadores proibidos", !forbiddenRe.test(readFileSync(import.meta.filename, "utf8")));

  let srcMocks = 0;
  const { readdirSync, statSync } = await import("node:fs");
  const walk = (dir) => {
    for (const entry of readdirSync(dir)) {
      const full = path.join(dir, entry);
      if (statSync(full).isDirectory()) walk(full);
      else if (entry.endsWith(".ts") && forbiddenRe.test(readFileSync(full, "utf8"))) srcMocks++;
    }
  };
  walk(SRC);
  check("anti-mock: zero mocks em produção sob src/", srcMocks === 0, `achados=${srcMocks}`);
}

// ---------------------------------------------------------------------------
// PROVA DE MUTAÇÃO: patch determinístico no bundle dist + reexecução.
// ---------------------------------------------------------------------------
async function runScenarios(mod) {
  const got = new Map();
  const R = (n, ok) => got.set(n, { ok: !!ok });

  // Cenário reduzido: wildcard de 2 membros + omitido + legado.
  for (const [label, args, expect] of [
    ["wildcard-star", { member: "*" }, { archived: true, aborts: 2 }],
    ["wildcard-omitted", {}, { archived: true, aborts: 2 }],
    ["legacy-single", { member: "tales" }, { archived: false, aborts: 1 }],
  ]) {
    const base = mkScratch(`mut-${label}`);
    const db = mod.createDb(path.join(base, "e.db"));
    const { calls, client } = makeClient();
    const deps = makeDeps(mod, { db, directory: base, client });
    const TEAM = "TMUT", LEAD = "ses_lead_mut";
    try {
      seedProjectAndTeam(db, { teamId: TEAM, teamName: "mut-squad", lead: LEAD });
      insertMember(db, { teamId: TEAM, name: "tales", session: "ses_tales_mut", agent: "build" });
      insertMember(db, { teamId: TEAM, name: "tulio", session: "ses_tulio_mut", agent: "build" });
      const r = await shutdown(mod, deps, args, LEAD);
      const archived = statusOf(db, TEAM) === "archived";
      R(`${label}.no-error`, r.err === null);
      R(`${label}.archived`, archived === expect.archived);
      R(`${label}.aborts`, calls.abort.length === expect.aborts);
    } catch (e) {
      R(`${label}.no-error`, false);
    } finally { cleanup(base, db); }
  }
  return got;
}

const realFlow = await runScenarios(REAL);

const MUTATIONS = [
  {
    id: "M1",
    desc: "wildcard não absorve mais o cleanup (executeTeamCleanup não é chamado)",
    from: "const cleanupResult = await executeTeamCleanup(",
    to: "const cleanupResult = await (async () => \"\")(",
    detect: ["wildcard-star.archived", "wildcard-omitted.archived"],
    unaffected: ["legacy-single.archived", "legacy-single.aborts", "wildcard-star.aborts"],
  },
  {
    id: "M2",
    desc: "roteamento wildcard do member omitido removido ('' não roteia para shutdownWholeTeam)",
    from: 'if (requested === "" || WILDCARD_MEMBERS.has(requested.toLowerCase())) {',
    to: 'if (false) {',
    detect: ["wildcard-omitted.archived", "wildcard-omitted.no-error"],
    unaffected: ["legacy-single.archived", "legacy-single.aborts"],
  },
];

const countOcc = (hay, needle) => hay.split(needle).length - 1;
for (const m of MUTATIONS) {
  const occurrences = countOcc(distRaw, m.from);
  check(`${m.id}: patch aplicável (1 ocorrência exata no dist)`, occurrences === 1, `ocorrências=${occurrences}`);
  if (occurrences !== 1) continue;

  const mutantFile = path.join(TMP, `_h49_${m.id.toLowerCase()}.mjs`);
  writeFileSync(mutantFile, buildHarnessCode(distRaw.split(m.from).join(m.to)));

  let mutantFlow;
  try {
    const mutantMod = await import(mutantFile);
    mutantFlow = await runScenarios(mutantMod);
  } catch (err) {
    check(`${m.id}: mutante executável (fluxos rodam por completo)`, false, String(err));
    continue;
  }
  check(`${m.id}: mutante executável (fluxos rodam por completo)`, mutantFlow.size === realFlow.size, `checks=${mutantFlow.size}/${realFlow.size}`);

  const missed = m.detect.filter((n) => mutantFlow.get(n)?.ok !== false);
  check(
    `${m.id}: asserções sensíveis — mutação detectada [${m.desc}]`,
    missed.length === 0,
    missed.length ? `não detectaram: ${missed.join(", ")}` : `${m.detect.length}/${m.detect.length} sentinelas falharam`,
  );

  const broken = m.unaffected.filter((n) => mutantFlow.get(n)?.ok !== true);
  check(
    `${m.id}: mutação cirúrgica — fluxos intactos preservados`,
    broken.length === 0,
    broken.length ? `quebrou: ${broken.join(", ")}` : `${m.unaffected.length}/${m.unaffected.length} verdes preservados`,
  );
}

// ---------------------------------------------------------------------------
// Relatório
// ---------------------------------------------------------------------------
const passed = results.filter(([, ok]) => ok).length;
const total = results.length;
console.log(`\nRESULT: ${passed}/${total} checks passed, ${unhandled.length} unhandled rejections`);
process.exit(passed === total && unhandled.length === 0 ? 0 : 1);
