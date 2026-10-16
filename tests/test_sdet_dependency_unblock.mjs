#!/usr/bin/env node
/**
 * QUALITY GATE DETERMINÍSTICO — Desrepresamento de Dependências no submit_review
 * (TICKET-HARNESS-24 / TASK-02) — @maiteuxzanela/ensemble-room-lowcost
 *
 * Engenheiro de Testes (SDET): Hugo. Guardiã do Quality Gate: Clara.
 *
 * Sob teste (src/ e dist/ REAIS, SQLite real via node:sqlite — SEM MOCKS):
 *   - executeTeamTasksAdd      -> src/tools/team-tasks-add.ts  (criação real com depends_on)
 *   - executeTeamClaim         -> src/tools/team-claim.ts      (pré-atribuição em blocked)
 *   - executeTeamTasksComplete -> src/tools/team-tasks-complete.ts
 *       Flow 1 (submit_review) + helper unblockDependents / isValidationProfileTask /
 *       formatUnblockedSuffix (HARNESS-24)
 *
 * Cobertura (card TASK-02):
 *   (a) TASK-01 (implementador) -> TASK-02 (SDET/Hugo) em 'blocked' com assignee:
 *       ao executar team_tasks_complete(action='submit_review') na TASK-01, a
 *       TASK-02 sai de 'blocked' para 'in_progress' (pré-atribuída) e o
 *       team_claim do Hugo responde "already in progress and assigned to you"
 *       (não mais o diretivo blocked/standby). Inclui sentinelas de contrato
 *       estrito: dependentes SEM assignee ou com assignee regular permanecem
 *       'blocked' no submit_review (relaxamento exclusivo do perfil de validação).
 *   (b) TASK-02 (SDET) -> TASK-03 (Clara/QA) em 'blocked' com assignee:
 *       ao SDET executar submit_review na TASK-02, a TASK-03 desbloqueia para o
 *       Quality Gate (via isQAMember) e o claim da Clara responde sucesso.
 *   (c) PROVA DE MUTAÇÃO: 2 mutantes gerados por patch determinístico no bundle
 *       dist — M1 anula a chamada de unblockDependents NO Flow 1 (a TASK-02
 *       permanece 'blocked' e o claim do SDET cai no diretivo blocked) e M2
 *       força a transição 'pending' (anula o pré-atribuído 'in_progress').
 *       Cada mutante FALHA nas sentinelas-alvo e PERMANECER VERDE nos fluxos
 *       intactos (cirurgia) — inclusive no Flow 3 (complete), intocado por M1.
 *   (d) A suíte inteira roda no npm test (tests/run_all.mjs) — verdes, sem mocks.
 *
 * Extras: variante standby (wake do desrepresamento consome a janela com
 *         prepend de spawn_context), paridade src↔dist dos literais do helper,
 *         anti-mock estático em src/ e na própria suíte.
 *
 * Único seam: cliente SDK do OpenCode (fronteira externa), reduzido a um
 * recorder determinístico de promptAsync — mesmo padrão das demais suítes.
 * Nenhum componente de produção é substituído: SQLite, bundle dist, DDL das
 * migrações e as tools reais (add/claim/complete) rodam autênticos.
 *
 * Uso: node tests/test_sdet_dependency_unblock.mjs
 * Exit: 0 = todos os checks PASS; 1 = há FAIL.
 */

import { mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";

const REPO = path.resolve(import.meta.dirname, "..");
const PKG = process.env.ENSEMBLE_PKG || REPO;
const DIST = path.join(PKG, "dist/index.js");
const SRC = path.join(REPO, "src");
const TMP = path.join(REPO, ".test-scratch");
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
  "createDb", "executeTeamTasksComplete", "executeTeamTasksAdd", "executeTeamClaim",
  "DEFAULT_CONFIG", "MemberRegistry", "ProgressTracker",
  "getTeamSDETMember", "isSDETMEmber", "getTeamQAMember", "isQAMember", "resolveStandbyWake",
];
const distRaw = readFileSync(DIST, "utf8");

const buildHarnessCode = (raw) => {
  const existingExport = raw.match(/export\s*\{([^}]*)\}\s*;?\s*$/)?.[1] ?? "";
  const already = new Set(
    existingExport.split(",").map((s) => s.trim().split(/\s+as\s+/).pop()).filter(Boolean),
  );
  const need = REQUIRED_SYMBOLS.filter((s) => !already.has(s));
  return { code: raw + (need.length ? `\nexport { ${need.join(", ")} };\n` : ""), need };
};

{
  const missing = REQUIRED_SYMBOLS.filter(
    (s) => !new RegExp(`(function|class|var|const|let)\\s+${s}\\b`).test(distRaw),
  );
  check(
    "harness: dist declara todos os símbolos exigidos",
    missing.length === 0,
    missing.join(",") || `${REQUIRED_SYMBOLS.length} símbolos`,
  );
  writeFileSync(path.join(TMP, "_sdet_unblock_harness.mjs"), buildHarnessCode(distRaw).code);
}
const REAL = await import(path.join(TMP, "_sdet_unblock_harness.mjs"));

// ---------------------------------------------------------------------------
// 1. RunFlow: cenários (a)/(b)/(c) contra um módulo harness dado.
//    Cada execução cria um SQLite NOVO em scratch isolado e o remove ao final.
//    Retorna Map<checkName, {ok, detail}> — a fase real promove cada entrada a
//    check global; a fase de mutação só promove as meta-checks de detecção.
// ---------------------------------------------------------------------------
let flowSeq = 0;
async function runFlow(mod) {
  const {
    createDb, executeTeamTasksComplete, executeTeamTasksAdd, executeTeamClaim,
    DEFAULT_CONFIG, MemberRegistry, ProgressTracker, isSDETMEmber, isQAMember,
  } = mod;

  const dir = path.join(TMP, `sdet_unblock_${process.pid}_${flowSeq++}`);
  mkdirSync(dir, { recursive: true });
  const db = createDb(path.join(dir, "ensemble.db"));
  const registry = new MemberRegistry();
  const progressTracker = new ProgressTracker(db);

  // Recorder da fronteira de transporte (único seam desta suíte).
  const calls = [];
  const client = {
    session: {
      create: async () => ({ data: { id: "ses_unused" } }),
      promptAsync: async (o) => { calls.push(o); return {}; },
      abort: async () => ({}),
    },
    tui: { showToast: async () => ({}), selectSession: async () => ({}) },
    worktree: { create: async () => ({ data: {} }), remove: async () => ({}), list: async () => ({ data: [] }), reset: async () => ({}) },
    workspace: { create: async () => ({ data: {} }), remove: async () => ({}), list: async () => ({ data: [] }) },
  };
  const deps = { db, registry, tracker: {}, purgeApprovals: {}, client, directory: dir, config: DEFAULT_CONFIG, progressTracker };

  const got = new Map();
  const R = (name, ok, detail) => got.set(name, { ok: !!ok, detail: detail ?? "" });

  const now = Date.now();
  const seedTeam = (id, name, lead) => {
    db.run("INSERT INTO project (id, name, path, status, time_created, time_updated) VALUES ('default','Default','','active',?,?) ON CONFLICT DO NOTHING", [now, now]);
    db.run("INSERT INTO team (id, name, project_id, lead_session_id, status, delegate, time_created, time_updated) VALUES (?,?,'default',?,'active',0,?,?)", [id, name, lead, now, now]);
  };
  const member = (teamId, name, ses, agent, isQa = 0, role = null, exec = "idle", ctx = null) => {
    db.run(
      `INSERT INTO team_member (team_id, name, session_id, agent, status, execution_status, is_qa, role, spawn_context, time_created, time_updated, reported_to_lead)
       VALUES (?,?,?,?, 'ready', ?, ?, ?, ?, ?, ?, 0)`,
      [teamId, name, ses, agent, exec, isQa, role, ctx, now, now],
    );
    registry.register(teamId, name, ses);
  };

  // Ferramentas REAIS do board (add/claim/complete/submit) — nada de inserts
  // manuais nos cenários principais: o ciclo add -> claim -> submit reproduz
  // exatamente o board da sala HARNESS-24. Os wrappers capturam exceções como
  // marcador '<<THREW>>' para que a fase de mutação registre TODAS as sentinelas
  // mesmo quando um mutante derruba um passo no meio do fluxo.
  const addTask = async (sessionId, tasks) => {
    try {
      const res = await executeTeamTasksAdd(deps, { tasks }, sessionId);
      const ids = res.match(/Added \d+ tasks?: (.+)/)?.[1]?.split(",")?.map((s) => s.trim()) ?? [];
      return { res, ids };
    } catch (e) {
      return { res: `<<THREW>> ${String(e)}`, ids: [] };
    }
  };
  const claim = async (sessionId, taskId) => {
    try {
      return await executeTeamClaim(deps, { task_id: taskId }, sessionId);
    } catch (e) {
      return `<<THREW>> ${String(e)}`;
    }
  };
  const submit = async (sessionId, taskId, notes) => {
    calls.length = 0;
    const args = { task_id: taskId, action: "submit_review" };
    if (notes !== undefined) args.notes = notes;
    try {
      return await executeTeamTasksComplete(deps, args, sessionId);
    } catch (e) {
      return `<<THREW>> ${String(e)}`;
    }
  };
  const complete = async (sessionId, taskId) => {
    calls.length = 0;
    try {
      return await executeTeamTasksComplete(deps, { task_id: taskId, action: "complete" }, sessionId);
    } catch (e) {
      return `<<THREW>> ${String(e)}`;
    }
  };
  const wakes = (ses) => calls.filter((c) => c.sessionID === ses);
  const textOf = (c) => c?.parts?.[0]?.text ?? "";
  const taskRow = (id) => {
    if (id == null) return {};
    return db.query("SELECT status, assignee, depends_on, review_notes FROM team_task WHERE id = ?").get(id) ?? {};
  };
  const execOf = (teamId, name) =>
    db.query("SELECT execution_status FROM team_member WHERE team_id = ? AND name = ?").get(teamId, name)?.execution_status;

  // ================= SETUP (board real, pré-condições) ======================
  seedTeam("s1", "squad-harness24", "ses_lead_s1");
  member("s1", "tulio", "ses_tulio_s1", "build");
  member("s1", "hugo", "ses_hugo_s1", "hugo");
  member("s1", "clara", "ses_clara_s1", "clara", 1);

  // Premissas de perfil (isValidationProfileTask depende delas).
  R("Pre.profile-sdet-hugo", isSDETMEmber(db, "s1", "hugo") === true);
  R("Pre.profile-qa-clara", isQAMember(db, "s1", "clara") === true && isSDETMEmber(db, "s1", "clara") === false);
  R("Pre.profile-regular-tulio", isSDETMEmber(db, "s1", "tulio") === false && isQAMember(db, "s1", "tulio") === false);

  // TASK-01 (implementador): pending -> claimed in_progress.
  const t1 = (await addTask("ses_tulio_s1", [{ content: "TASK-01 implementador", priority: "high" }])).ids[0];
  R("Pre.t1-created", !!t1 && taskRow(t1).status === "pending", `id=${t1} status=${taskRow(t1).status}`);
  const c1 = await claim("ses_tulio_s1", t1);
  R("Pre.t1-claimed-in-progress", c1.includes("Claimed task:") && taskRow(t1).status === "in_progress" && taskRow(t1).assignee === "tulio", c1);

  // TASK-02 (SDET/Hugo): dependente de TASK-01 nasce 'blocked'; Hugo faz o
  // pre-claim (pré-atribui mas mantém 'blocked') — exatamente o estado do board
  // real antes do wake de handover.
  const t2 = (await addTask("ses_tulio_s1", [{ content: "TASK-02 suíte SDET", priority: "high", depends_on: [t1] }])).ids[0];
  R("Pre.t2-created-blocked", taskRow(t2).status === "blocked" && taskRow(t2).depends_on === JSON.stringify([t1]), JSON.stringify(taskRow(t2)));
  const c2 = await claim("ses_hugo_s1", t2);
  R(
    "Pre.t2-preclaim-directive",
    c2.includes(`Pre-claimed blocked task "${t2}"`) && c2.includes("enter standby (yield) via team_standby"),
    c2,
  );
  R("Pre.t2-preclaim-assignee-hugo", taskRow(t2).status === "blocked" && taskRow(t2).assignee === "hugo", JSON.stringify(taskRow(t2)));

  // TASK-03 (Clara/QA): dependente de TASK-02 nasce 'blocked' + pre-claim da Clara.
  const t3 = (await addTask("ses_tulio_s1", [{ content: "TASK-03 auditoria QA", priority: "high", depends_on: [t2] }])).ids[0];
  R("Pre.t3-created-blocked", taskRow(t3).status === "blocked", `status=${taskRow(t3).status}`);
  await claim("ses_clara_s1", t3);
  R("Pre.t3-preclaim-assignee-clara", taskRow(t3).status === "blocked" && taskRow(t3).assignee === "clara", JSON.stringify(taskRow(t3)));

  // Sentinelas de contrato ESTRITO (relaxamento exclusivo do perfil de validação):
  // dependentes da TASK-01 sem assignee e com assignee regular.
  const tRegU = (await addTask("ses_tulio_s1", [{ content: "downstream regular sem assignee", priority: "medium", depends_on: [t1] }])).ids[0];
  const tRegC = (await addTask("ses_tulio_s1", [{ content: "downstream regular tulio", priority: "medium", depends_on: [t1] }])).ids[0];
  await claim("ses_tulio_s1", tRegC);
  R(
    "Pre.strict-pair-blocked",
    taskRow(tRegU).status === "blocked" && !taskRow(tRegU).assignee && taskRow(tRegC).status === "blocked" && taskRow(tRegC).assignee === "tulio",
    JSON.stringify([taskRow(tRegU), taskRow(tRegC)]),
  );

  // ==================== (a) submit_review do implementador ==================
  const res1 = await submit("ses_tulio_s1", t1, "PR pronto");
  const hugo1 = wakes("ses_hugo_s1");
  const clara1 = wakes("ses_clara_s1");
  const row1 = taskRow(t1);
  const row2 = taskRow(t2);
  R("A.submit-t1-notifies-sdet", res1.includes("(notified hugo for deterministic tests)"), res1);
  R("A.submit-t1-unblock-suffix", res1.includes("(unblocked 1 task, woke 1 member)"), res1);
  R("A.t1-in-review-with-notes", row1.status === "in_review" && row1.review_notes === "PR pronto", JSON.stringify(row1));
  R("A.t2-in-progress-after-submit", row2.status === "in_progress", `status=${row2.status}`);
  R("A.t2-assignee-preserved", row2.assignee === "hugo", `assignee=${row2.assignee}`);
  const c2b = await claim("ses_hugo_s1", t2);
  R(
    "A.t2-claim-already-in-progress",
    c2b.includes(`Task "${t2}" is already in progress and assigned to you`),
    c2b,
  );
  R("A.t-reg-unassigned-stays-blocked", taskRow(tRegU).status === "blocked", `status=${taskRow(tRegU).status}`);
  R("A.t-reg-claimed-stays-blocked", taskRow(tRegC).status === "blocked", `status=${taskRow(tRegC).status}`);
  R("A.t3-not-triggered-stays-blocked", taskRow(t3).status === "blocked", `status=${taskRow(t3).status}`);
  const handover1 = hugo1.filter((c) => textOf(c).includes("SDET handover"));
  const unblock1 = hugo1.filter((c) => textOf(c).includes("was unblocked and is ready for you to start"));
  R("A.hugo-total-2-wakes", hugo1.length === 2, `count=${hugo1.length}`);
  R(
    "A.hugo-handover-wake-exact",
    handover1.length === 1 &&
      textOf(handover1[0]) ===
        `[System: Task "${t1}" was submitted for review by tulio (notes: PR pronto) — SDET handover: run the deterministic test suite for this delivery before the Quality Gate audits.]`,
    handover1.map(textOf).join(" || "),
  );
  R(
    "A.hugo-unblock-wake-exact",
    unblock1.length === 1 && textOf(unblock1[0]) === `[System: Task "${t2}" was unblocked and is ready for you to start]`,
    unblock1.map(textOf).join(" || ") || "(nenhum)",
  );
  R("A.hugo-unblock-wake-synthetic", unblock1[0]?.synthetic === true, `synthetic=${unblock1[0]?.synthetic}`);
  R("A.clara-suppressed", clara1.length === 0, `count=${clara1.length}`);

  // ============ Variante standby: wake consome a janela com prepend =========
  seedTeam("s2b", "squad-standby-unblock", "ses_lead_s2b");
  member("s2b", "tulio", "ses_tulio_s2b", "build");
  member("s2b", "hugo", "ses_hugo_s2b", "hugo");
  member("s2b", "xena", "ses_xena_s2b", "build", 1, null, "standby", "CTX_QA_BIRTH");
  const t1x = (await addTask("ses_tulio_s2b", [{ content: "TASK-01X", priority: "high" }])).ids[0];
  await claim("ses_tulio_s2b", t1x);
  const t2x = (await addTask("ses_tulio_s2b", [{ content: "TASK-02X QA standby", priority: "high", depends_on: [t1x] }])).ids[0];
  await claim("ses_xena_s2b", t2x);
  R("SB.t2x-preclaim-blocked", taskRow(t2x).status === "blocked" && taskRow(t2x).assignee === "xena", JSON.stringify(taskRow(t2x)));
  const resx = await submit("ses_tulio_s2b", t1x, "standby");
  const hugox = wakes("ses_hugo_s2b");
  const xenax = wakes("ses_xena_s2b");
  R("SB.submit-unblock-suffix", resx.includes("(unblocked 1 task, woke 1 member)"), resx);
  R("SB.t2x-in-progress", taskRow(t2x).status === "in_progress", `status=${taskRow(t2x).status}`);
  R("SB.xena-exec-starting", execOf("s2b", "xena") === "starting", `exec=${execOf("s2b", "xena")}`);
  R("SB.hugo-handover-only", hugox.length === 1 && textOf(hugox[0]).includes("SDET handover"), `count=${hugox.length}`);
  R(
    "SB.unblock-wake-standby-consume",
    xenax.length === 1 &&
      textOf(xenax[0]) === `CTX_QA_BIRTH\n\n[System: Task "${t2x}" was unblocked and is ready for you to start]`,
    xenax.map(textOf).join(" || ") || "(nenhum)",
  );

  // ==================== (b) submit_review do SDET ===========================
  const res2 = await submit("ses_hugo_s1", t2, "suite verde");
  const clara2 = wakes("ses_clara_s1");
  const hugo2 = wakes("ses_hugo_s1");
  const row3 = taskRow(t3);
  R("B.submit-t2-notifies-clara", res2.includes("(notified clara for review)"), res2);
  R("B.submit-t2-unblock-suffix", res2.includes("(unblocked 1 task, woke 1 member)"), res2);
  R("B.t2-in-review", taskRow(t2).status === "in_review", `status=${taskRow(t2).status}`);
  R("B.t3-in-progress-after-sdet-submit", row3.status === "in_progress", `status=${row3.status}`);
  R("B.t3-assignee-clara", row3.assignee === "clara", `assignee=${row3.assignee}`);
  const c3b = await claim("ses_clara_s1", t3);
  R(
    "B.t3-claim-already-in-progress",
    c3b.includes(`Task "${t3}" is already in progress and assigned to you`),
    c3b,
  );
  const legacy2 = clara2.filter((c) => textOf(c).includes("was submitted for review by"));
  const unblock2 = clara2.filter((c) => textOf(c).includes("was unblocked and is ready for you to start"));
  R("B.clara-total-2-wakes", clara2.length === 2, `count=${clara2.length}`);
  R(
    "B.clara-legacy-wake-exact",
    legacy2.length === 1 && textOf(legacy2[0]) === `[System: Task "${t2}" was submitted for review by hugo (notes: suite verde)]`,
    legacy2.map(textOf).join(" || ") || "(nenhum)",
  );
  R(
    "B.clara-unblock-wake-exact",
    unblock2.length === 1 && textOf(unblock2[0]) === `[System: Task "${t3}" was unblocked and is ready for you to start]`,
    unblock2.map(textOf).join(" || ") || "(nenhum)",
  );
  R("B.hugo-zero-self-wake", hugo2.length === 0, `count=${hugo2.length}`);

  // ============ (c) regressão do Flow 3 (complete) — cirurgia do M1 =========
  seedTeam("s2", "squad-flow3", "ses_lead_s2");
  member("s2", "tulio", "ses_tulio_s2", "build");
  const t9 = (await addTask("ses_tulio_s2", [{ content: "TASK-09 upstream", priority: "high" }])).ids[0];
  await claim("ses_tulio_s2", t9);
  const t10 = (await addTask("ses_tulio_s2", [{ content: "TASK-10 downstream regular", priority: "high", depends_on: [t9] }])).ids[0];
  R("C.t10-created-blocked", taskRow(t10).status === "blocked", `status=${taskRow(t10).status}`);
  const c10 = await claim("ses_tulio_s2", t10);
  R("C.t10-preclaim-directive", c10.includes("Pre-claimed blocked task"), c10);
  const res3 = await complete("ses_tulio_s2", t9);
  const tulio3 = wakes("ses_tulio_s2");
  const lead3 = wakes("ses_lead_s2");
  R("C.complete-t9-unblock-suffix", res3.includes("Completed task:") && res3.includes("(unblocked 1 task, woke 1 member)"), res3);
  R("C.t10-in-progress-after-complete", taskRow(t10).status === "in_progress", `status=${taskRow(t10).status}`);
  R(
    "C.tulio-unblock-wake-exact",
    tulio3.length === 1 && textOf(tulio3[0]) === `[System: Task "${t10}" was unblocked and is ready for you to start]`,
    tulio3.map(textOf).join(" || ") || "(nenhum)",
  );
  R("C.no-lead-board-wake", lead3.length === 0, `count=${lead3.length}`);

  // Fecha o SQLite (WAL) antes de remover o scratch: sem isso o checkpoint
  // recria -wal/-shm durante o rmSync e o diretório sai ENOTEMPTY.
  try { db.close(); } catch { /* já fechado */ }
  rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  return got;
}

// ---------------------------------------------------------------------------
// 2. Fase REAL: todos os cenarios contra o dist autêntico devem passar 100%.
// ---------------------------------------------------------------------------
const realFlow = await runFlow(REAL);
for (const [name, { ok, detail }] of realFlow) check(`[real] ${name}`, ok, detail);

// ---------------------------------------------------------------------------
// 3. Paridade src↔dist (literais do helper HARNESS-24) + anti-mock estático.
// ---------------------------------------------------------------------------
const srcTc = readFileSync(path.join(SRC, "tools", "team-tasks-complete.ts"), "utf8");
const PARITY = [
  ["function unblockDependents", srcTc],
  ["function isValidationProfileTask", srcTc],
  ["function formatUnblockedSuffix", srcTc],
  ["unblockDependents(deps, teamInfo, args.task_id, now)", srcTc],
  ["formatUnblockedSuffix(submittedUnblock.unblocked, submittedUnblock.wokeMembers)", srcTc],
  ["was unblocked and is ready for you to start", srcTc],
  ['if (dep.status === "in_review" && downstreamIsValidation) return true', srcTc],
  [" (unblocked ", srcTc],
  ["unblocked ${unblocked} task", srcTc],
];
for (const [lit, src] of PARITY) {
  check(`paridade src↔dist: literal "${lit.slice(0, 60)}"`, src.includes(lit) && distRaw.includes(lit));
}
const srcClaim = readFileSync(path.join(SRC, "tools", "team-claim.ts"), "utf8");
for (const lit of ['Pre-claimed blocked task', "is already in progress and assigned to you", "enter standby (yield) via team_standby"]) {
  check(`paridade src↔dist (team-claim): "${lit}"`, srcClaim.includes(lit) && distRaw.includes(lit));
}

{
  const FORBIDDEN = ["je" + "st.mock", "sin" + "on", "vi.mo" + "ck", "mockImple" + "mentation"];
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
// 4. PROVA DE MUTAÇÃO: patch determinístico no bundle dist + reexecução dos
//    mesmos cenarios. Cada mutante precisa FALHAR nas sentinelas do cenário
//    alvo (sensibilidade) e PERMANECER VERDE nos fluxos intactos (cirurgia).
// ---------------------------------------------------------------------------
const MUTATIONS = [
  {
    id: "M1",
    desc: "unblock do Flow 1 (submit_review) anulado — TASK-02 permanece 'blocked'",
    from: "const submittedUnblock = unblockDependents(deps, teamInfo, args.task_id, now)",
    to: "const submittedUnblock = { unblocked: 0, wokeMembers: 0 }",
    detect: [
      "A.submit-t1-unblock-suffix", "A.t2-in-progress-after-submit",
      "A.t2-claim-already-in-progress", "A.hugo-total-2-wakes", "A.hugo-unblock-wake-exact",
      "A.hugo-unblock-wake-synthetic",
      "SB.submit-unblock-suffix", "SB.t2x-in-progress", "SB.xena-exec-starting", "SB.unblock-wake-standby-consume",
      "B.submit-t2-notifies-clara", "B.submit-t2-unblock-suffix", "B.t2-in-review",
      "B.t3-in-progress-after-sdet-submit", "B.t3-claim-already-in-progress",
      "B.clara-total-2-wakes", "B.clara-legacy-wake-exact", "B.clara-unblock-wake-exact",
    ],
    unaffected: [
      "Pre.t1-claimed-in-progress", "Pre.t2-created-blocked", "Pre.t2-preclaim-directive",
      "Pre.t2-preclaim-assignee-hugo", "Pre.t3-created-blocked", "Pre.t3-preclaim-assignee-clara",
      "Pre.strict-pair-blocked", "Pre.profile-sdet-hugo", "Pre.profile-qa-clara", "Pre.profile-regular-tulio",
      "A.submit-t1-notifies-sdet", "A.t1-in-review-with-notes", "A.t2-assignee-preserved",
      "A.t-reg-unassigned-stays-blocked", "A.t-reg-claimed-stays-blocked",
      "A.t3-not-triggered-stays-blocked",
      "A.hugo-handover-wake-exact", "A.clara-suppressed",
      "SB.t2x-preclaim-blocked", "SB.hugo-handover-only",
      "B.t3-assignee-clara", "B.hugo-zero-self-wake",
      "C.t10-created-blocked", "C.t10-preclaim-directive", "C.complete-t9-unblock-suffix",
      "C.t10-in-progress-after-complete", "C.tulio-unblock-wake-exact", "C.no-lead-board-wake",
    ],
  },
  {
    id: "M2",
    desc: "transição pré-atribuída anulada (unblock vai para 'pending' em vez de 'in_progress')",
    from: 'const nextStatus = t.assignee ? "in_progress" : "pending"',
    to: 'const nextStatus = "pending"',
    detect: [
      "A.t2-in-progress-after-submit", "A.t2-claim-already-in-progress",
      "SB.t2x-in-progress",
      "B.t3-in-progress-after-sdet-submit", "B.t3-claim-already-in-progress",
      "C.t10-in-progress-after-complete",
    ],
    unaffected: [
      "Pre.t1-claimed-in-progress", "Pre.t2-created-blocked", "Pre.t2-preclaim-directive",
      "Pre.t2-preclaim-assignee-hugo", "Pre.t3-created-blocked", "Pre.t3-preclaim-assignee-clara",
      "Pre.strict-pair-blocked", "Pre.profile-sdet-hugo", "Pre.profile-qa-clara", "Pre.profile-regular-tulio",
      "A.submit-t1-notifies-sdet", "A.submit-t1-unblock-suffix", "A.t1-in-review-with-notes",
      "A.t2-assignee-preserved", "A.t-reg-unassigned-stays-blocked", "A.t-reg-claimed-stays-blocked",
      "A.t3-not-triggered-stays-blocked", "A.hugo-handover-wake-exact", "A.hugo-unblock-wake-exact",
      "A.hugo-unblock-wake-synthetic", "A.hugo-total-2-wakes", "A.clara-suppressed",
      "SB.t2x-preclaim-blocked", "SB.submit-unblock-suffix", "SB.hugo-handover-only",
      "SB.unblock-wake-standby-consume", "SB.xena-exec-starting",
      "B.submit-t2-notifies-clara", "B.submit-t2-unblock-suffix", "B.t2-in-review",
      "B.t3-assignee-clara",
      "B.clara-total-2-wakes", "B.clara-legacy-wake-exact", "B.clara-unblock-wake-exact",
      "B.hugo-zero-self-wake",
      "C.t10-created-blocked", "C.t10-preclaim-directive", "C.complete-t9-unblock-suffix",
      "C.tulio-unblock-wake-exact", "C.no-lead-board-wake",
    ],
  },
];

for (const m of MUTATIONS) {
  const occurrences = distRaw.split(m.from).length - 1;
  check(`${m.id}: patch aplicável (1 ocorrência exata no dist)`, occurrences === 1, `ocorrências=${occurrences}`);
  if (occurrences !== 1) continue;

  const mutantFile = path.join(TMP, `_sdet_unblock_${m.id.toLowerCase()}.mjs`);
  writeFileSync(mutantFile, buildHarnessCode(distRaw.split(m.from).join(m.to)).code);
  let mutatedFlow;
  try {
    const mutantMod = await import(mutantFile);
    mutatedFlow = await runFlow(mutantMod);
  } catch (err) {
    check(`${m.id}: mutante executável (fluxo roda por completo)`, false, String(err));
    continue;
  }
  check(
    `${m.id}: mutante executável (fluxo roda por completo)`,
    mutatedFlow.size === realFlow.size,
    `checks=${mutatedFlow.size}/${realFlow.size}`,
  );

  const missed = m.detect.filter((n) => mutatedFlow.get(n)?.ok !== false);
  check(
    `${m.id}: asserções sensíveis — mutação detectada [${m.desc}]`,
    missed.length === 0,
    missed.length
      ? `não detectaram: ${missed.join(", ")}`
      : `${m.detect.length}/${m.detect.length} sentinelas falharam`,
  );

  const broken = m.unaffected.filter((n) => mutatedFlow.get(n)?.ok !== true);
  check(
    `${m.id}: mutação cirúrgica — fluxos intactos preservados`,
    broken.length === 0,
    broken.length
      ? `quebrou: ${broken.join(", ")}`
      : `${m.unaffected.length}/${m.unaffected.length} verdes preservados`,
  );
}

// ---------------------------------------------------------------------------
// Relatório
// ---------------------------------------------------------------------------
const passed = results.filter(([, ok]) => ok).length;
const total = results.length;
console.log(`\nRESULT: ${passed}/${total} checks passed, ${unhandled.length} unhandled rejections`);
process.exit(passed === total && unhandled.length === 0 ? 0 : 1);
