#!/usr/bin/env node
/**
 * QUALITY GATE DETERMINÍSTICO — Roteamento SDET/QA no Pool Plano
 * (TICKET-HARNESS-51) — @maiteuxzanela/ensemble-room-lowcost
 *
 * Engenheiro de Testes (SDET): Hugo. Guardiã do Quality Gate: Clara.
 *
 * TICKET-HARNESS-51 — o board é um pool plano, totalmente paralelo. O mecanismo
 * legado de DAG (`depends_on`/`blocked`/`unblockDependents` do HARNESS-24) foi
 * DEFINITIVAMENTE expurgado: nenhuma tarefa bloqueia outra, nenhum submit_review
 * "desbloqueia" dependentes, e toda tarefa nasce 'pending' e reivindicável.
 *
 * Sob teste (src/ e dist/ REAIS, SQLite real via node:sqlite — SEM MOCKS):
 *   - executeTeamTasksAdd      -> src/tools/team-tasks-add.ts  (toda tarefa pending)
 *   - executeTeamClaim         -> src/tools/team-claim.ts      (claim direto no pool)
 *   - executeTeamTasksComplete -> src/tools/team-tasks-complete.ts
 *       submit_review (roteamento SDET-first / QA), sdet_pass, guarda de lote
 *
 * Cobertura:
 *   (a) Implementador submete: o SDET é acordado (handover), a QA fica dormindo,
 *       e NENHUM irmão do board é movido (pool plano — sem dependências).
 *   (b) SDET submete a própria entrega: a QA é acordada (legado), o SDET não
 *       se auto-acorda, e o irmão permanece intocado.
 *   (c) sdet_pass: o veredito verde fica no card 'in_review' e acorda a QA.
 *   (s3) Guarda de lote consolidado: um irmão funcional pendente segura o wake
 *       do SDET — provando que o submit NÃO move nem acorda o irmão.
 *   (s2b) Variante standby: o wake da QA consome a janela com prepend de
 *       spawn_context.
 *   (c-mut) PROVA DE MUTAÇÃO: 2 mutantes por patch determinístico no bundle dist
 *       — M1 desliga o roteamento SDET-first; M2 adultera o texto do handover.
 *
 * Único seam: cliente SDK do OpenCode (fronteira externa), reduzido a um
 * recorder determinístico de promptAsync. Nenhum componente de produção é
 * substituído: SQLite, bundle dist, DDL das migrações e as tools reais rodam.
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
  "MIGRATIONS",
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
// 1. RunFlow: cenários contra um módulo harness dado.
//    Cada execução cria um SQLite NOVO em scratch isolado e o remove ao final.
//    Retorna Map<checkName, {ok, detail}> — a fase real promove cada entrada a
//    check global; a fase de mutação só promove as meta-checks de detecção.
// ---------------------------------------------------------------------------
let flowSeq = 0;
async function runFlow(mod) {
  const {
    createDb, executeTeamTasksComplete, executeTeamTasksAdd, executeTeamClaim,
    DEFAULT_CONFIG, MemberRegistry, ProgressTracker, isSDETMEmber, isQAMember, MIGRATIONS,
  } = mod;

  const dir = path.join(TMP, `sdet_unblock_${process.pid}_${flowSeq++}`);
  mkdirSync(dir, { recursive: true });
  const db = createDb(path.join(dir, "ensemble.db"));
  const registry = new MemberRegistry();
  const progressTracker = new ProgressTracker();

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
  // manuais nos cenários principais. Os wrappers capturam exceções como marcador
  // '<<THREW>>' para que a fase de mutação registre TODAS as sentinelas mesmo
  // quando um mutante derruba um passo no meio do fluxo.
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
  const sdetPass = async (sessionId, taskId, notes) => {
    calls.length = 0;
    try {
      return await executeTeamTasksComplete(deps, { task_id: taskId, action: "sdet_pass", notes }, sessionId);
    } catch (e) {
      return `<<THREW>> ${String(e)}`;
    }
  };
  const wakes = (ses) => calls.filter((c) => c.sessionID === ses);
  const textOf = (c) => c?.parts?.[0]?.text ?? "";
  const taskRow = (id) => {
    if (id == null) return {};
    return db.query("SELECT status, assignee, review_notes FROM team_task WHERE id = ?").get(id) ?? {};
  };
  const execOf = (teamId, name) =>
    db.query("SELECT execution_status FROM team_member WHERE team_id = ? AND name = ?").get(teamId, name)?.execution_status;

  // ================= SETUP (board real, pré-condições) ======================
  // Flat pool (TICKET-HARNESS-51): a coluna depends_on foi expurgada na
  // Migration 19 e 'blocked' saiu do CHECK constraint.
  const cols = db.query("PRAGMA table_info(team_task)").all().map((c) => c.name);
  R("Pre.schema-no-depends_on", !cols.includes("depends_on"), cols.join(","));
  R("Pre.migration-19-flat-pool", MIGRATIONS.length >= 19, `len=${MIGRATIONS.length}`);

  seedTeam("s1", "squad-harness51", "ses_lead_s1");
  member("s1", "tulio", "ses_tulio_s1", "build");
  member("s1", "hugo", "ses_hugo_s1", "hugo");
  member("s1", "clara", "ses_clara_s1", "clara", 1);

  // Premissas de perfil (isValidationProfileTask depende delas).
  R("Pre.profile-sdet-hugo", isSDETMEmber(db, "s1", "hugo") === true);
  R("Pre.profile-qa-clara", isQAMember(db, "s1", "clara") === true && isSDETMEmber(db, "s1", "clara") === false);
  R("Pre.profile-regular-tulio", isSDETMEmber(db, "s1", "tulio") === false && isQAMember(db, "s1", "tulio") === false);

  // Três tarefas INDEPENDENTES (pool plano): todas nascem pending.
  const t1 = (await addTask("ses_lead_s1", [{ content: "TASK-01 implementador", priority: "high" }])).ids[0];
  const t2 = (await addTask("ses_lead_s1", [{ content: "TASK-02 suíte SDET", priority: "high" }])).ids[0];
  const t3 = (await addTask("ses_lead_s1", [{ content: "TASK-03 auditoria QA", priority: "high" }])).ids[0];
  R(
    "Pre.all-tasks-born-pending",
    [t1, t2, t3].every((id) => taskRow(id).status === "pending") && [t1, t2, t3].every((id) => !!id),
    JSON.stringify([taskRow(t1).status, taskRow(t2).status, taskRow(t3).status]),
  );

  // Cada card é reivindicado diretamente no pool (sem pré-atribuição bloqueada).
  R("Pre.t1-claimed-tulio", (await claim("ses_tulio_s1", t1)).includes("Claimed task:") && taskRow(t1).status === "in_progress");
  R("Pre.t2-claimed-hugo", (await claim("ses_hugo_s1", t2)).includes("Claimed task:") && taskRow(t2).assignee === "hugo");
  R("Pre.t3-claimed-clara", (await claim("ses_clara_s1", t3)).includes("Claimed task:") && taskRow(t3).assignee === "clara");

  // ==================== (a) submit_review do implementador ==================
  const res1 = await submit("ses_tulio_s1", t1, "PR pronto");
  const hugo1 = wakes("ses_hugo_s1");
  const clara1 = wakes("ses_clara_s1");
  const row1 = taskRow(t1);
  const row2 = taskRow(t2);
  const row3 = taskRow(t3);
  R("A.submit-t1-notifies-sdet", res1.includes("(notified hugo for deterministic tests)"), res1);
  R("A.submit-t1-no-unblock", !res1.includes("unblocked") && !res1.includes("woke"), res1);
  R("A.t1-in-review-with-notes", row1.status === "in_review" && row1.review_notes === "PR pronto", JSON.stringify(row1));
  R("A.t2-unchanged-flat-pool", row2.status === "in_progress" && row2.assignee === "hugo", JSON.stringify(row2));
  R("A.t3-unchanged-flat-pool", row3.status === "in_progress" && row3.assignee === "clara", JSON.stringify(row3));
  const handover1 = hugo1.filter((c) => textOf(c).includes("SDET handover"));
  R("A.hugo-one-wake", hugo1.length === 1, `count=${hugo1.length}`);
  R(
    "A.hugo-handover-wake-exact",
    handover1.length === 1 &&
      textOf(handover1[0]) ===
        `[System: Task "${t1}" was submitted for review by tulio (notes: PR pronto) — SDET handover: run the deterministic test suite for this delivery before the Quality Gate audits.]`,
    handover1.map(textOf).join(" || "),
  );
  R("A.hugo-handover-wake-synthetic", handover1[0]?.synthetic === true, `synthetic=${handover1[0]?.synthetic}`);
  R("A.clara-suppressed", clara1.length === 0, `count=${clara1.length}`);

  // ==================== (b) submit_review do SDET ===========================
  const res2 = await submit("ses_hugo_s1", t2, "suite verde");
  const clara2 = wakes("ses_clara_s1");
  const hugo2 = wakes("ses_hugo_s1");
  R("B.submit-t2-notifies-clara", res2.includes("(notified clara for review)"), res2);
  R("B.submit-t2-no-unblock", !res2.includes("unblocked") && !res2.includes("woke"), res2);
  R("B.t2-in-review", taskRow(t2).status === "in_review", `status=${taskRow(t2).status}`);
  R("B.t3-unchanged-flat-pool", taskRow(t3).status === "in_progress" && taskRow(t3).assignee === "clara", JSON.stringify(taskRow(t3)));
  const legacy2 = clara2.filter((c) => textOf(c).includes("was submitted for review by"));
  R("B.clara-one-wake", clara2.length === 1, `count=${clara2.length}`);
  R(
    "B.clara-legacy-wake-exact",
    legacy2.length === 1 && textOf(legacy2[0]) === `[System: Task "${t2}" was submitted for review by hugo (notes: suite verde)]`,
    legacy2.map(textOf).join(" || ") || "(nenhum)",
  );
  R("B.hugo-zero-self-wake", hugo2.length === 0, `count=${hugo2.length}`);

  // ==================== (c) sdet_pass -> handover à QA ======================
  const res3 = await sdetPass("ses_hugo_s1", t1, "suite verde");
  const clara3 = wakes("ses_clara_s1");
  R("C.sdet-pass-recorded", res3.includes("SDET verification recorded") && res3.includes("notified"), res3);
  R("C.t1-stays-in-review", taskRow(t1).status === "in_review", `status=${taskRow(t1).status}`);
  R("C.clara-woken-one", clara3.length === 1, `count=${clara3.length}`);
  R(
    "C.sdet-pass-wake-text",
    textOf(clara3[0]).includes("SDET (Hugo) has verified") && textOf(clara3[0]).includes("Ready for Quality Gate audit"),
    textOf(clara3[0]),
  );

  // ============ (s3) Guarda de lote consolidado + pool plano ================
  // Um irmão funcional pendente NÃO é movido nem acordado por um submit; ele
  // apenas segura o wake do SDET até o lote funcional ser consolidado.
  seedTeam("s3", "squad-batch", "ses_lead_s3");
  member("s3", "tulio", "ses_tulio_s3", "build");
  member("s3", "hugo", "ses_hugo_s3", "hugo");
  const tA = (await addTask("ses_lead_s3", [{ content: "TASK-A", priority: "high" }])).ids[0];
  const tB = (await addTask("ses_lead_s3", [{ content: "TASK-B irmã pendente", priority: "high" }])).ids[0];
  await claim("ses_tulio_s3", tA);
  const resS3 = await submit("ses_tulio_s3", tA, "lote");
  R("S3.submit-held", resS3.includes("SDET wake held until the functional batch is consolidated"), resS3);
  R("S3.sibling-stays-pending", taskRow(tB).status === "pending" && taskRow(tB).assignee === null, JSON.stringify(taskRow(tB)));
  R("S3.zero-wake", wakes("ses_hugo_s3").length === 0, `count=${wakes("ses_hugo_s3").length}`);

  // ============ Variante standby: wake consome a janela com prepend =========
  seedTeam("s2b", "squad-standby", "ses_lead_s2b");
  member("s2b", "tulio", "ses_tulio_s2b", "build");
  member("s2b", "xena", "ses_xena_s2b", "build", 1, null, "standby", "CTX_QA_BIRTH");
  const tX = (await addTask("ses_lead_s2b", [{ content: "TASK-X", priority: "high" }])).ids[0];
  await claim("ses_tulio_s2b", tX);
  const resX = await submit("ses_tulio_s2b", tX, "standby");
  const xenaX = wakes("ses_xena_s2b");
  R("SB.submit-notifies-qa", resX.includes("(notified xena for review)"), resX);
  R("SB.xena-exec-starting", execOf("s2b", "xena") === "starting", `exec=${execOf("s2b", "xena")}`);
  R(
    "SB.standby-wake-consume",
    xenaX.length === 1 &&
      textOf(xenaX[0]) === `CTX_QA_BIRTH\n\n[System: Task "${tX}" was submitted for review by tulio (notes: standby)]`,
    xenaX.map(textOf).join(" || ") || "(nenhum)",
  );

  // Fecha o SQLite (WAL) antes de remover o scratch.
  try { db.close(); } catch { /* já fechado */ }
  rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  return got;
}

// ---------------------------------------------------------------------------
// 2. Fase REAL: todos os cenários contra o dist autêntico devem passar 100%.
// ---------------------------------------------------------------------------
const realFlow = await runFlow(REAL);
for (const [name, { ok, detail }] of realFlow) check(`[real] ${name}`, ok, detail);

// ---------------------------------------------------------------------------
// 3. Paridade src↔dist (marcadores do pool plano) + anti-mock estático.
// ---------------------------------------------------------------------------
const srcTc = readFileSync(path.join(SRC, "tools", "team-tasks-complete.ts"), "utf8");
const srcAdd = readFileSync(path.join(SRC, "tools", "team-tasks-add.ts"), "utf8");
const srcClaim = readFileSync(path.join(SRC, "tools", "team-claim.ts"), "utf8");

// (a) O mecanismo DAG do HARNESS-24 não existe mais — nem no src nem no dist.
check("flat-pool: sem 'unblockDependents' (src E dist)", !srcTc.includes("unblockDependents") && !distRaw.includes("unblockDependents"));
check("flat-pool: sem 'was unblocked and is ready' (src E dist)", !srcTc.includes("was unblocked and is ready") && !distRaw.includes("was unblocked and is ready"));
check("flat-pool: sem 'blocked by unresolved dependencies' (src E dist)", !srcTc.includes("blocked by unresolved dependencies") && !distRaw.includes("blocked by unresolved dependencies"));
check("flat-pool: sem 'Pre-claimed blocked task' (src E dist)", !srcClaim.includes("Pre-claimed blocked task") && !distRaw.includes("Pre-claimed blocked task"));

// (b) team-tasks-add: toda tarefa nasce 'pending', sem depends_on/sequential.
//     Comments are stripped first — the docstring legitimately names the legacy
//     concepts it purged; only the executable code must be free of them.
const srcAddCode = srcAdd.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
check("flat-pool: team-tasks-add insere 'pending'", srcAddCode.includes("'pending'"));
check("flat-pool: team-tasks-add sem depends_on", !srcAddCode.includes("depends_on"));
check("flat-pool: team-tasks-add sem sequential", !srcAddCode.includes("sequential"));

// (c) Roteamento SDET/QA preservado (paridade src↔dist).
check("paridade: roteamento SDET-first", srcTc.includes("if (sdetMember && !callerIsSDET) {") && distRaw.includes("if (sdetMember && !callerIsSDET) {"));
check("paridade: claim idempotente", srcClaim.includes("is already in progress and assigned to you") && distRaw.includes("is already in progress and assigned to you"));

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
// 4. PROVA DE MUTAÇÃO: patch determinístico no bundle dist + reexecução.
// ---------------------------------------------------------------------------
const MUTATIONS = [
  {
    id: "M1",
    desc: "roteamento SDET-first desligado (submit_review acorda a QA em vez do SDET)",
    from: "if (sdetMember && !callerIsSDET) {",
    to: "if (false) {",
    detect: [
      "A.submit-t1-notifies-sdet", "A.hugo-one-wake", "A.hugo-handover-wake-exact",
      "A.hugo-handover-wake-synthetic", "A.clara-suppressed",
      "S3.submit-held",
    ],
    unaffected: [
      "Pre.schema-no-depends_on", "Pre.migration-19-flat-pool", "Pre.profile-sdet-hugo",
      "Pre.profile-qa-clara", "Pre.profile-regular-tulio", "Pre.all-tasks-born-pending",
      "Pre.t1-claimed-tulio", "Pre.t2-claimed-hugo", "Pre.t3-claimed-clara",
      "A.submit-t1-no-unblock", "A.t1-in-review-with-notes", "A.t2-unchanged-flat-pool",
      "A.t3-unchanged-flat-pool",
      "B.submit-t2-notifies-clara", "B.submit-t2-no-unblock", "B.t2-in-review",
      "B.t3-unchanged-flat-pool", "B.clara-one-wake", "B.clara-legacy-wake-exact", "B.hugo-zero-self-wake",
      "C.sdet-pass-recorded", "C.t1-stays-in-review", "C.clara-woken-one", "C.sdet-pass-wake-text",
      "S3.sibling-stays-pending", "S3.zero-wake",
      "SB.submit-notifies-qa", "SB.xena-exec-starting", "SB.standby-wake-consume",
    ],
  },
  {
    id: "M2",
    desc: "texto do handover do SDET adulterado (sufixo removido)",
    from: " \\u2014 SDET handover: run the deterministic test suite for this delivery before the Quality Gate audits.]",
    to: "]",
    detect: ["A.hugo-handover-wake-exact", "A.hugo-handover-wake-synthetic"],
    unaffected: [
      "Pre.schema-no-depends_on", "Pre.migration-19-flat-pool", "Pre.profile-sdet-hugo",
      "Pre.profile-qa-clara", "Pre.profile-regular-tulio", "Pre.all-tasks-born-pending",
      "Pre.t1-claimed-tulio", "Pre.t2-claimed-hugo", "Pre.t3-claimed-clara",
      "A.submit-t1-notifies-sdet", "A.submit-t1-no-unblock", "A.t1-in-review-with-notes",
      "A.t2-unchanged-flat-pool", "A.t3-unchanged-flat-pool", "A.hugo-one-wake",
      "A.clara-suppressed",
      "B.submit-t2-notifies-clara", "B.submit-t2-no-unblock", "B.t2-in-review",
      "B.t3-unchanged-flat-pool", "B.clara-one-wake", "B.clara-legacy-wake-exact", "B.hugo-zero-self-wake",
      "C.sdet-pass-recorded", "C.t1-stays-in-review", "C.clara-woken-one", "C.sdet-pass-wake-text",
      "S3.submit-held", "S3.sibling-stays-pending", "S3.zero-wake",
      "SB.submit-notifies-qa", "SB.xena-exec-starting", "SB.standby-wake-consume",
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
    missed.length ? `não detectaram: ${missed.join(", ")}` : `${m.detect.length}/${m.detect.length} sentinelas falharam`,
  );

  const broken = m.unaffected.filter((n) => mutatedFlow.get(n)?.ok !== true);
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
