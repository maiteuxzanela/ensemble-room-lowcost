#!/usr/bin/env node
/**
 * QUALITY GATE DETERMINÍSTICO — TICKET-HARNESS-34
 * @maiteuxzanela/ensemble-room-lowcost
 *
 * Engenheiro de Testes (SDET): Hugo. Guardiã do Quality Gate: Clara.
 *
 * Sob teste (src/ e dist/ REAIS, SQLite real via node:sqlite — SEM MOCKS):
 *   - executeTeamTasksComplete  -> src/tools/team-tasks-complete.ts (Flow 3 complete)
 *     Frente 1 / A6: trava anti-bypass do Quality Gate — implementador NÃO pode
 *     fechar um card 'in_progress'/'pending' direto quando a sala tem QA ativo.
 *   - handleSessionErrorEvent / isAbortError -> src/hooks.ts (Frente 2 / A2):
 *     MessageAbortedError e abort limpo (failover/watchdog) NÃO geram alarme falso.
 *   - notifyLead / promptModelAwareWake -> src/notify.ts (Frente 2 / A1):
 *     `silentLead` suprime o wake proativo mas PRESERVA a mensagem no banco;
 *     `forceWake` (falha irrecuperável) e `silentLead:false` (legado) furam o gate.
 *
 * Cobertura:
 *   (A6) trava anti-bypass: implementador bloqueado em in_progress E pending,
 *        status byte-estável, dependente continua 'blocked', zero wake/auto-commit;
 *        SDET NÃO é isento; QA e Lead são isentos; sala SEM QA preserva o legado;
 *        retrocompat do label do QA (base persona 'clara-legacy' e agent 'clara');
 *        submit_review continua o caminho legítimo e só QA/Lead fecham in_review.
 *   (A2) filtro de abort: isAbortError por name e por message (wording canônica +
 *        variantes de mecanismo), abort não persiste nada / não acorda ninguém,
 *        erro GENUÍNO persiste e força o wake.
 *   (A1) coerência do silentLead: wake suprimido com o default, forceWake fura,
 *        silentLead:false legado acorda, config ausente resolve para o default.
 *   (git) prova REAL de que complete bloqueado não gera commit e o fechamento da
 *        QA dispara o Portão 1 (git real em sandbox).
 *   (mutação) 5 mutantes no bundle dist — cada um detectado pelas sentinelas do
 *        cenário-alvo e cirúrgico nos fluxos intactos.
 *   (paridade) literais das duas frentes presentes em src/ E dist/ + anti-mock.
 *
 * Único seam: cliente SDK do OpenCode (fronteira externa), reduzido a um recorder
 * determinístico de promptAsync — mesmo padrão das demais suítes do repo. Nenhum
 * componente de produção é substituído: SQLite, bundle dist e schemas DDL reais.
 *
 * Uso: node tests/test_ticket_harness_34_quality_gate_and_silent_lead.mjs
 * Exit: 0 = todos os checks PASS; 1 = há FAIL.
 */

import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import os from "node:os";
import path from "node:path";

const REPO = path.resolve(import.meta.dirname, "..");
const PKG = process.env.ENSEMBLE_PKG || REPO;
const DIST = path.join(PKG, "dist/index.js");
const SRC = path.join(REPO, "src");
const TMP = path.join(REPO, ".test-scratch", "h34");
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
  "createDb", "executeTeamTasksComplete", "DEFAULT_CONFIG", "MemberRegistry",
  "ProgressTracker", "getTeamQAMember", "isQAMember", "isSDETMEmber",
  "getTeamSDETMember", "handleSessionErrorEvent", "isAbortError",
  "notifyLead", "promptModelAwareWake", "sendMessage",
  "recordModifiedFile", "listModifiedFiles",
];
const distRaw = readFileSync(DIST, "utf8");

const buildHarnessCode = (raw) => {
  const existingExport = raw.match(/export\s*\{([^}]*)\}\s*;?\s*$/)?.[1] ?? "";
  const already = new Set(
    existingExport.split(",").map((s) => s.trim().split(/\s+as\s+/).pop()).filter(Boolean),
  );
  const need = REQUIRED_SYMBOLS.filter((s) => !already.has(s));
  return raw + (need.length ? `\nexport { ${need.join(", ")} };\n` : "");
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
  writeFileSync(path.join(TMP, "_h34_harness.mjs"), buildHarnessCode(distRaw));
}
const REAL = await import(path.join(TMP, "_h34_harness.mjs"));

const flush = () => new Promise((r) => setTimeout(r, 0));

// ---------------------------------------------------------------------------
// 1. RunFlow: TODOS os cenários A6/A2/A1 contra um módulo harness dado.
//    Cada execução usa SQLite NOVO em scratch isolado. Nunca lança: toda
//    exceção vira resultado de check (necessário para a fase de mutação).
// ---------------------------------------------------------------------------
let flowSeq = 0;
async function runFlow(mod) {
  const {
    createDb, executeTeamTasksComplete, DEFAULT_CONFIG, MemberRegistry, ProgressTracker,
    handleSessionErrorEvent, notifyLead, isAbortError,
  } = mod;

  const base = mkdtempSync(path.join(os.tmpdir(), `ensemble-h34-${process.pid}-${flowSeq++}-`));
  const dir = path.join(base, "room");
  mkdirSync(dir, { recursive: true });
  mkdirSync(path.join(base, "db"), { recursive: true });
  const db = createDb(path.join(base, "db", "ensemble.db"));
  const registry = new MemberRegistry();
  const progressTracker = new ProgressTracker(db);

  // Único seam (fronteira de transporte): recorder determinístico de promptAsync.
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
  const R = (name, ok, detail) => got.set(name, { ok: !!ok, detail: detail === undefined ? "" : String(detail) });

  const now = Date.now();
  const seedTeam = (id, name, lead, leadAgent = null) => {
    db.run("INSERT INTO project (id, name, path, status, time_created, time_updated) VALUES ('default','Default','','active',?,?) ON CONFLICT DO NOTHING", [now, now]);
    db.run("INSERT INTO team (id, name, project_id, lead_session_id, lead_agent, status, delegate, time_created, time_updated) VALUES (?,?,'default',?,?,'active',0,?,?)", [id, name, lead, leadAgent, now, now]);
  };
  const member = (teamId, name, ses, agent, opts = {}) => {
    db.run(
      `INSERT INTO team_member (team_id, name, session_id, agent, status, execution_status, is_qa, role, spawn_context, time_created, time_updated, reported_to_lead)
       VALUES (?,?,?,?, 'ready', ?, ?, ?, ?, ?, ?, 0)`,
      [teamId, name, ses, agent, opts.exec ?? "idle", opts.isQa ?? 0, opts.role ?? null, opts.ctx ?? null, now, now],
    );
    registry.register(teamId, name, ses);
  };
  // TICKET-HARNESS-51: no depends_on column anymore — the legacy 6th argument
  // is accepted and ignored; the board is a flat, fully-parallel pool.
  const task = (id, teamId, assignee, status = "in_progress", content = null, _dependsOn = null) => {
    db.run(
      "INSERT INTO team_task (id, team_id, content, status, priority, assignee, rejection_count, time_created, time_updated) VALUES (?,?,?,?,'high',?,0,?,?)",
      [id, teamId, content ?? `Task ${id}`, status, assignee, now, now],
    );
  };
  const doComplete = async (ses, args) => {
    try { return { res: await executeTeamTasksComplete(deps, args, ses), err: null }; }
    catch (e) { return { res: "", err: e instanceof Error ? e.message : String(e) }; }
  };
  const statusOf = (id) => db.query("SELECT status FROM team_task WHERE id = ?").get(id)?.status;
  const leadRows = (teamId) => db.query(
    "SELECT COUNT(*) c FROM team_message WHERE team_id = ? AND from_name = 'system' AND to_name = 'lead'",
  ).get(teamId).c;
  const wakesTo = (ses) => calls.filter((c) => c.sessionID === ses);
  const textOf = (c) => c?.parts?.[0]?.text ?? "";
  const A6_MSG = (id, qa) =>
    `Task "${id}" cannot be completed directly by an implementer; only ${qa} or the team lead can complete it after review submission via submit_review`;

  // ======================= (A6) SALA COM QA — bloqueios ===================
  // q1: QA (Clara) + SDET (Hugo) + implementador (Tulio). O card-sentinela a9
  // nunca é tocado, então o board nunca fecha (board-close wake não polui).
  seedTeam("q1", "squad-with-qa", "ses_lead_q1");
  member("q1", "tulio", "ses_tulio_q1", "build");
  member("q1", "hugo", "ses_hugo_q1", "hugo");
  member("q1", "clara", "ses_clara_q1", "clara", { isQa: 1, role: "qa" });
  task("a1", "q1", "tulio", "in_progress");
  task("a1dep", "q1", "hugo", "in_review", "Downstream validation");
  task("a2", "q1", null, "pending");
  task("a3", "q1", "tulio", "in_progress");
  task("a9", "q1", null, "pending"); // sentinela: mantém o board aberto

  R("A6.qa-resolves-clara", mod.getTeamQAMember(db, "q1")?.name === "clara");

  // A6.1 — implementador (o próprio assignee) fechando in_progress: bloqueado.
  calls.length = 0;
  const r1 = await doComplete("ses_tulio_q1", { task_id: "a1", action: "complete" });
  R("A6.1 implementer-blocked-in-progress", r1.err === A6_MSG("a1", "clara"), r1.err ?? r1.res);
  R("A6.2 in-progress-status-unchanged", statusOf("a1") === "in_progress", statusOf("a1"));
  R("A6.3 sibling-stays-in_review", statusOf("a1dep") === "in_review", statusOf("a1dep"));
  R("A6.4 zero-wake-on-blocked-complete", calls.length === 0, `wakes=${calls.length}`);
  R(
    "A6.5 not-legacy-in-review-message",
    r1.err !== 'Task "a1" is in review; only clara or the team lead can complete it',
    r1.err ?? "",
  );

  // A6.6 — implementador fechando um card 'pending': bloqueado, status intacto.
  const r6 = await doComplete("ses_tulio_q1", { task_id: "a2", action: "complete" });
  R("A6.6 implementer-blocked-pending", r6.err === A6_MSG("a2", "clara"), r6.err ?? r6.res);
  R("A6.7 pending-status-unchanged", statusOf("a2") === "pending", statusOf("a2"));

  // A6.8 — o SDET NÃO é isento: a trava vale para ele também.
  const r8 = await doComplete("ses_hugo_q1", { task_id: "a3", action: "complete" });
  R("A6.8 sdet-not-exempt-in-progress", r8.err === A6_MSG("a3", "clara"), r8.err ?? r8.res);
  R("A6.9 sdet-blocked-status-unchanged", statusOf("a3") === "in_progress", statusOf("a3"));

  // A6.10 — o QA É isento: pode fechar um card pending não reclamado.
  const r10 = await doComplete("ses_clara_q1", { task_id: "a2", action: "complete" });
  R(
    "A6.10 qa-exempt-completes-pending",
    r10.err === null && r10.res.includes("Completed task: Task a2") && statusOf("a2") === "completed",
    r10.err ?? r10.res,
  );

  // ======================= (A6) SALA SEM QA — legado ======================
  seedTeam("q3", "squad-no-qa", "ses_lead_q3");
  member("q3", "tulio", "ses_tulio_q3", "build");
  task("g1", "q3", "tulio", "in_progress");
  task("g9", "q3", null, "pending");
  R("A6.11 no-qa-room-has-no-reviewer", mod.getTeamQAMember(db, "q3") === null);
  const r11 = await doComplete("ses_tulio_q3", { task_id: "g1", action: "complete" });
  R(
    "A6.12 no-qa-room-legacy-complete",
    r11.err === null && r11.res.includes("Completed task: Task g1") && statusOf("g1") === "completed",
    r11.err ?? r11.res,
  );

  // ================ (A6) RETROCOMPAT DO LABEL DO QA =======================
  // q4: QA por BASE PERSONA ("clara-legacy") sem flag is_qa.
  seedTeam("q4", "squad-qa-retro-persona", "ses_lead_q4");
  member("q4", "tulio", "ses_tulio_q4", "build");
  member("q4", "clara-legacy", "ses_clara_legacy", "build");
  task("r1", "q4", "tulio", "in_progress");
  task("r9", "q4", null, "pending");
  const r12 = await doComplete("ses_tulio_q4", { task_id: "r1", action: "complete" });
  R("A6.13 qa-retrocompat-persona-label", r12.err === A6_MSG("r1", "clara-legacy"), r12.err ?? r12.res);

  // q5: QA por AGENT ("gatekeeper" com agent 'clara') sem flag is_qa.
  seedTeam("q5", "squad-qa-retro-agent", "ses_lead_q5");
  member("q5", "tulio", "ses_tulio_q5", "build");
  member("q5", "gatekeeper", "ses_gatekeeper", "clara");
  task("r2", "q5", "tulio", "in_progress");
  task("r8", "q5", null, "pending");
  const r13 = await doComplete("ses_tulio_q5", { task_id: "r2", action: "complete" });
  R("A6.14 qa-retrocompat-agent-label", r13.err === A6_MSG("r2", "gatekeeper"), r13.err ?? r13.res);

  // ======================= (A6) LEAD É ISENTO =============================
  seedTeam("q6", "squad-lead-override", "ses_lead_q6");
  member("q6", "tulio", "ses_tulio_q6", "build");
  member("q6", "clara", "ses_clara_q6", "clara", { isQa: 1, role: "qa" });
  task("e1", "q6", "tulio", "in_progress");
  task("e9", "q6", null, "pending");
  const r14 = await doComplete("ses_lead_q6", { task_id: "e1", action: "complete" });
  R(
    "A6.15 lead-exempt-completes-in-progress",
    r14.err === null && r14.res.includes("Completed task: Task e1") && statusOf("e1") === "completed",
    r14.err ?? r14.res,
  );

  // ======================= (LC) CICLO LEGÍTIMO ============================
  // q2: uma única tarefa funcional. submit_review -> SDET; depois só QA fecha.
  seedTeam("q2", "squad-lifecycle", "ses_lead_q2");
  member("q2", "tulio", "ses_tulio_q2", "build");
  member("q2", "hugo", "ses_hugo_q2", "hugo");
  member("q2", "clara", "ses_clara_q2", "clara", { isQa: 1, role: "qa" });
  task("a4", "q2", "tulio", "in_progress", "Task a4");

  calls.length = 0;
  const s1 = await doComplete("ses_tulio_q2", { task_id: "a4", action: "submit_review", notes: "PR pronto" });
  R(
    "LC.1 submit-review-wakes-sdet",
    s1.err === null && wakesTo("ses_hugo_q2").length === 1 && wakesTo("ses_clara_q2").length === 0 &&
      textOf(wakesTo("ses_hugo_q2")[0]).includes("SDET handover"),
    s1.err ?? `hugo=${wakesTo("ses_hugo_q2").length} clara=${wakesTo("ses_clara_q2").length}`,
  );
  R("LC.2 submit-review-status-in-review", statusOf("a4") === "in_review", statusOf("a4"));
  R(
    "LC.2b submit-review-persists-notes",
    db.query("SELECT review_notes FROM team_task WHERE id = 'a4'").get()?.review_notes === "PR pronto",
  );

  const s3 = await doComplete("ses_tulio_q2", { task_id: "a4", action: "complete" });
  R(
    "LC.3 implementer-cannot-close-in-review",
    s3.err === 'Task "a4" is in review; only clara or the team lead can complete it',
    s3.err ?? s3.res,
  );

  const s4 = await doComplete("ses_hugo_q2", { task_id: "a4", action: "complete" });
  R(
    "LC.4 sdet-cannot-approve-in-review",
    s4.err === 'Task "a4" is in review; the SDET runs the deterministic suite but cannot approve \u2014 only clara or the team lead can complete it',
    s4.err ?? s4.res,
  );

  const s5 = await doComplete("ses_clara_q2", { task_id: "a4", action: "complete" });
  R(
    "LC.5 qa-completes-in-review",
    s5.err === null && s5.res.includes("Completed task: Task a4") && statusOf("a4") === "completed",
    s5.err ?? s5.res,
  );

  // ======================= (A2) FILTRO DE ABORT ===========================
  // isAbortError — tabela pura de decisão.
  R("A2.1 isAbort-name-MessageAbortedError", isAbortError({ name: "MessageAbortedError" }) === true);
  R(
    "A2.2 isAbort-name-abort-interrupt",
    isAbortError({ name: "AbortError" }) === true && isAbortError({ name: "InterruptedError" }) === true,
  );
  R(
    "A2.3 isAbort-message-canonical",
    isAbortError({ data: { message: "The running turn was stopped before OpenCode could send the next message." } }) === true,
  );
  R(
    "A2.4 isAbort-message-mechanism-variants",
    isAbortError({ data: { message: "failover-abort" } }) === true &&
      isAbortError({ data: { message: "forced shutdown" } }) === true &&
      isAbortError({ data: { message: "The turn was intentionally interrupted by the watchdog" } }) === true,
  );
  R(
    "A2.5 isAbort-genuine-failures-false",
    isAbortError({ name: "APIError", data: { message: "provider unavailable (503)" } }) === false &&
      isAbortError({ name: "MessageOutputLengthError", data: { message: "The model produced too much output" } }) === false &&
      isAbortError({ data: { message: "connection reset by peer" } }) === false &&
      isAbortError({ data: { message: "tool execution failed" } }) === false,
  );
  R("A2.6 isAbort-undefined-false", isAbortError(undefined) === false);

  // handleSessionErrorEvent — abort real não persiste nada nem acorda ninguém.
  seedTeam("ab1", "squad-abort", "ses_lead_ab1");
  member("ab1", "tales", "ses_ab_tales", "build");

  calls.length = 0;
  const rowsBefore = leadRows("ab1");
  handleSessionErrorEvent(db, registry, client, "ses_ab_tales", { name: "MessageAbortedError" }, DEFAULT_CONFIG);
  await flush();
  R("A2.7 abort-event-persists-nothing", leadRows("ab1") === rowsBefore, `rows=${leadRows("ab1") - rowsBefore}`);
  R("A2.8 abort-event-zero-wake", calls.length === 0, `wakes=${calls.length}`);

  // Abort via MESSAGE apenas (sem name): também filtrado.
  calls.length = 0;
  const rowsBeforeMsg = leadRows("ab1");
  handleSessionErrorEvent(
    db, registry, client, "ses_ab_tales",
    { data: { message: "The running turn was stopped before OpenCode could send the next message." } },
    DEFAULT_CONFIG,
  );
  await flush();
  R(
    "A2.9 abort-message-only-filtered",
    leadRows("ab1") === rowsBeforeMsg && calls.length === 0,
    `rows=${leadRows("ab1") - rowsBeforeMsg} wakes=${calls.length}`,
  );

  // Erro GENUÍNO: persiste a mensagem E força o wake mesmo sob silentLead.
  calls.length = 0;
  const rowsBeforeReal = leadRows("ab1");
  handleSessionErrorEvent(
    db, registry, client, "ses_ab_tales",
    { name: "APIError", data: { message: "provider unavailable (503)" } },
    DEFAULT_CONFIG,
  );
  await flush();
  const realRow = db.query(
    "SELECT content FROM team_message WHERE team_id = 'ab1' AND to_name = 'lead' ORDER BY time_created DESC LIMIT 1",
  ).get();
  R(
    "A2.10 genuine-error-persists-row",
    leadRows("ab1") === rowsBeforeReal + 1 && (realRow?.content ?? "").includes('Teammate "tales" had a session error'),
    realRow?.content ?? "(sem linha)",
  );
  R("A2.11 genuine-error-force-wakes-through-silent", wakesTo("ses_lead_ab1").length === 1, `wakes=${wakesTo("ses_lead_ab1").length}`);

  // Sem config (legado): o erro genuíno também fura (forceWake implícito).
  calls.length = 0;
  handleSessionErrorEvent(db, registry, client, "ses_ab_tales", { name: "APIError", data: { message: "boom" } }, undefined);
  await flush();
  R("A2.12 genuine-error-legacy-no-config-wakes", wakesTo("ses_lead_ab1").length === 1, `wakes=${wakesTo("ses_lead_ab1").length}`);

  // ======================= (A1) COERÊNCIA DO silentLead ===================
  seedTeam("al1", "squad-silent", "ses_lead_al1");
  member("al1", "tales", "ses_al_tales", "build");

  // A1.1 — default silencioso: mensagem persistida, ZERO wake.
  calls.length = 0;
  const before1 = leadRows("al1");
  const id1 = notifyLead(client, db, "al1", "ruído não-fatal: stall", { config: DEFAULT_CONFIG });
  await flush();
  R(
    "A1.1 silent-suppresses-wake-persists-row",
    typeof id1 === "string" && leadRows("al1") === before1 + 1 && calls.length === 0,
    `rows=${leadRows("al1") - before1} wakes=${calls.length}`,
  );

  // A1.2 — forceWake (falha irrecuperável) fura o gate silencioso.
  calls.length = 0;
  const before2 = leadRows("al1");
  notifyLead(client, db, "al1", "watchdog timeout: teammate aborted", { config: DEFAULT_CONFIG, forceWake: true });
  await flush();
  const w2 = wakesTo("ses_lead_al1");
  R(
    "A1.2 forceWake-punches-through",
    leadRows("al1") === before2 + 1 && w2.length === 1 && w2[0].synthetic === true &&
      textOf(w2[0]) === "[System: New team message from system]",
    `rows=${leadRows("al1") - before2} wakes=${w2.length}`,
  );
  R("A1.3 wake-payload-native-rung-no-model", w2.length === 1 && !("model" in w2[0]), JSON.stringify(w2[0]?.model));

  // A1.4 — silentLead: false (sala legada) volta a acordar.
  calls.length = 0;
  notifyLead(client, db, "al1", "legado agressivo", { config: { ...DEFAULT_CONFIG, silentLead: false } });
  await flush();
  R("A1.4 silentLead-false-legacy-wakes", wakesTo("ses_lead_al1").length === 1, `wakes=${wakesTo("ses_lead_al1").length}`);

  // A1.5 — config AUSENTE degrada para o wake legado (retrocompat de callers
  // sem configuração threadada). A mensagem continua sendo persistida.
  calls.length = 0;
  const before5 = leadRows("al1");
  notifyLead(client, db, "al1", "sem config", undefined);
  await flush();
  R(
    "A1.5 missing-config-legacy-wake",
    leadRows("al1") === before5 + 1 && wakesTo("ses_lead_al1").length === 1,
    `rows=${leadRows("al1") - before5} wakes=${wakesTo("ses_lead_al1").length}`,
  );

  // A1.6 — config PRESENTE com silentLead true (default de produto) suprime,
  // distinguindo "sem config" (legado) de "config padrão" (silencioso).
  calls.length = 0;
  const before6b = leadRows("al1");
  notifyLead(client, db, "al1", "config default", { config: { ...DEFAULT_CONFIG, silentLead: true } });
  await flush();
  R(
    "A1.6 explicit-silent-config-suppresses",
    leadRows("al1") === before6b + 1 && wakesTo("ses_lead_al1").length === 0,
    `rows=${leadRows("al1") - before6b} wakes=${wakesTo("ses_lead_al1").length}`,
  );

  // A1.6 — agent do lead é encaminhado explicitamente no wake (anti-sequester).
  seedTeam("al2", "squad-agent", "ses_lead_al2", "dante");
  calls.length = 0;
  notifyLead(client, db, "al2", "fatal", { config: { ...DEFAULT_CONFIG, silentLead: false } });
  await flush();
  R("A1.7 wake-carries-lead-agent", wakesTo("ses_lead_al2")[0]?.agent === "dante", JSON.stringify(wakesTo("ses_lead_al2")[0]?.agent));

  try { db.close(); } catch { /* já fechado */ }
  rmSync(base, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  return got;
}

// ---------------------------------------------------------------------------
// 2. Fase REAL: todos os cenários contra o dist autêntico devem passar 100%.
// ---------------------------------------------------------------------------
const realFlow = await runFlow(REAL);
for (const [name, { ok, detail }] of realFlow) check(`[real] ${name}`, ok, detail);

// ---------------------------------------------------------------------------
// 3. Prova REAL de git: complete bloqueado não gera commit; QA fecha o Portão 1.
// ---------------------------------------------------------------------------
function git(cwd, args) {
  try {
    return { ok: true, out: execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim() };
  } catch (e) {
    return { ok: false, out: (e.stdout ?? "").toString().trim(), err: (e.stderr ?? "").toString().trim() };
  }
}

{
  const base = mkdtempSync(path.join(os.tmpdir(), "ensemble-h34-git-"));
  const repo = path.join(base, "repo");
  mkdirSync(repo, { recursive: true });
  git(repo, ["init", "-q"]);
  git(repo, ["config", "user.email", "hugo.sdet@test.local"]);
  git(repo, ["config", "user.name", "Hugo SDET"]);
  writeFileSync(path.join(repo, "README.md"), "baseline\n");
  git(repo, ["add", "-A"]);
  git(repo, ["commit", "-q", "-m", "chore: baseline"]);
  writeFileSync(path.join(repo, "feature.txt"), "uncommitted work\n");

  mkdirSync(path.join(base, "db"), { recursive: true });
  const db = REAL.createDb(path.join(base, "db", "ensemble.db"));
  const registry = new REAL.MemberRegistry();
  const progressTracker = new REAL.ProgressTracker(db);
  const calls = [];
  const client = {
    session: { create: async () => ({ data: { id: "ses_x" } }), promptAsync: async (o) => { calls.push(o); return {}; }, abort: async () => ({}) },
    tui: { showToast: async () => ({}), selectSession: async () => ({}) },
    worktree: { create: async () => ({ data: {} }), remove: async () => ({}), list: async () => ({ data: [] }), reset: async () => ({}) },
    workspace: { create: async () => ({ data: {} }), remove: async () => ({}), list: async () => ({ data: [] }) },
  };
  const deps = { db, registry, tracker: {}, purgeApprovals: {}, client, directory: repo, config: REAL.DEFAULT_CONFIG, progressTracker };
  const now = Date.now();
  db.run("INSERT INTO project (id, name, path, status, time_created, time_updated) VALUES ('default','Default','','active',?,?) ON CONFLICT DO NOTHING", [now, now]);
  db.run("INSERT INTO team (id, name, project_id, lead_session_id, status, delegate, time_created, time_updated) VALUES ('gc1','squad-git','default','ses_lead_gc1','active',0,?,?)", [now, now]);
  db.run(
    "INSERT INTO team_member (team_id, name, session_id, agent, status, execution_status, is_qa, role, spawn_context, time_created, time_updated, reported_to_lead) VALUES ('gc1','tulio','ses_tulio_gc1','build','ready','idle',0,NULL,NULL,?,?,0)",
    [now, now],
  );
  db.run(
    "INSERT INTO team_member (team_id, name, session_id, agent, status, execution_status, is_qa, role, spawn_context, time_created, time_updated, reported_to_lead) VALUES ('gc1','clara','ses_clara_gc1','clara','ready','idle',1,'qa',NULL,?,?,0)",
    [now, now],
  );
  registry.register("gc1", "tulio", "ses_tulio_gc1");
  registry.register("gc1", "clara", "ses_clara_gc1");
  db.run(
    "INSERT INTO team_task (id, team_id, content, status, priority, assignee, rejection_count, time_created, time_updated) VALUES ('c1','gc1','Feat H34 gate','in_progress','high','tulio',0,?,?)",
    [now, now],
  );
  REAL.recordModifiedFile(db, "gc1", path.join(repo, "feature.txt"));

  const beforeCount = Number(git(repo, ["rev-list", "--count", "HEAD"]).out);
  const beforeHash = git(repo, ["rev-parse", "HEAD"]).out;
  let blockedErr = null;
  try { await REAL.executeTeamTasksComplete(deps, { task_id: "c1", action: "complete" }, "ses_tulio_gc1"); }
  catch (e) { blockedErr = e instanceof Error ? e.message : String(e); }
  const afterBlockedCount = Number(git(repo, ["rev-list", "--count", "HEAD"]).out);
  check(
    "A6.git.1 blocked implementer raises A6 error",
    blockedErr === 'Task "c1" cannot be completed directly by an implementer; only clara or the team lead can complete it after review submission via submit_review',
    blockedErr ?? "(sem erro)",
  );
  check(
    "A6.git.2 blocked complete creates ZERO commit",
    afterBlockedCount === beforeCount && git(repo, ["rev-parse", "HEAD"]).out === beforeHash && existsSync(path.join(repo, "feature.txt")),
    `count ${beforeCount}->${afterBlockedCount}`,
  );

  // Caminho legítimo: submit_review -> QA complete -> Portão 1 (commit local).
  await REAL.executeTeamTasksComplete(deps, { task_id: "c1", action: "submit_review", notes: "só via QA" }, "ses_tulio_gc1");
  const qaRes = await REAL.executeTeamTasksComplete(deps, { task_id: "c1", action: "complete" }, "ses_clara_gc1");
  const afterQaCount = Number(git(repo, ["rev-list", "--count", "HEAD"]).out);
  check(
    "A6.git.3 QA complete commits (Portão 1)",
    qaRes.includes("Completed task: Feat H34 gate") && qaRes.includes("locally committed") && afterQaCount === beforeCount + 1,
    `count ${beforeCount}->${afterQaCount} | ${qaRes}`,
  );
  check(
    "A6.git.4 commit message canonical",
    git(repo, ["log", "-1", "--format=%s"]).out === "feat(runtime): Feat H34 gate",
    git(repo, ["log", "-1", "--format=%s"]).out,
  );
  check("A6.git.5 tree clean after QA commit", git(repo, ["status", "--porcelain"]).out === "", git(repo, ["status", "--porcelain"]).out);

  try { db.close(); } catch { /* já fechado */ }
  rmSync(base, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
}

// ---------------------------------------------------------------------------
// 4. Paridade src↔dist (build compilou as duas frentes) + anti-mock.
// ---------------------------------------------------------------------------
const srcHooks = readFileSync(path.join(SRC, "hooks.ts"), "utf8");
const srcNotify = readFileSync(path.join(SRC, "notify.ts"), "utf8");
const srcWatchdog = readFileSync(path.join(SRC, "watchdog.ts"), "utf8");
const srcSpawn = readFileSync(path.join(SRC, "tools", "team-spawn.ts"), "utf8");
const srcComplete = readFileSync(path.join(SRC, "tools", "team-tasks-complete.ts"), "utf8");

check(
  "paridade A6: mensagem da trava anti-bypass em src E dist",
  srcComplete.includes("cannot be completed directly by an implementer") &&
    distRaw.includes("cannot be completed directly by an implementer"),
);
check(
  "paridade A6: exige submit_review na mensagem (src E dist)",
  srcComplete.includes("after review submission via submit_review") &&
    distRaw.includes("after review submission via submit_review"),
);
check(
  "paridade A2: isAbortError + regex + log em src E dist",
  srcHooks.includes("export function isAbortError") && srcHooks.includes("ABORT_ERROR_MESSAGE") &&
    srcHooks.includes("session-error:aborted") &&
    distRaw.includes("function isAbortError") && distRaw.includes("ABORT_ERROR_MESSAGE") && distRaw.includes("session-error:aborted"),
);
check(
  "paridade A2: filtro invoca isAbortError antes do notify (src E dist)",
  // TICKET-RELEASE-17: o gate aceita também o marcador de abort INTENCIONAL
  // (team_standby / team_task_handover encerram o turno pelo runtime).
  /if \(isAbortError\(error\) \|\| intentionalAbort\)/.test(srcHooks) &&
    /if \(isAbortError\(error\) \|\| intentionalAbort\)/.test(distRaw),
);
check(
  "paridade A1: gate silencioso notifyLead:silent em src E dist",
  srcNotify.includes("notifyLead:silent") && distRaw.includes("notifyLead:silent") &&
    /silentLead && !options\?\.forceWake/.test(srcNotify) && /silentLead && !options\?\.forceWake/.test(distRaw),
);
check(
  "paridade A1: semântica do gate (config ausente = legado; config presente obedece silentLead) em src E dist",
  /options\?\.config !== (?:undefined|void 0) && options\.config\.silentLead !== false/.test(srcNotify) &&
    /options\?\.config !== (?:undefined|void 0) && options\.config\.silentLead !== false/.test(distRaw),
  srcNotify.match(/options\?\.config !== (?:undefined|void 0)[^\n]*/)?.[0] ?? "(ausente)",
);
check(
  // TICKET-RELEASE-17: o watchdog deixou de forçar wake (timeout removido);
  // forceWake segue vivo apenas nas falhas irrecuperáveis (session.error e
  // rollback de spawn).
  "paridade A1: forceWake presente em hooks/notify/team-spawn E dist (não no watchdog)",
  [srcHooks, srcNotify, srcSpawn].every((s) => s.includes("forceWake")) &&
    !srcWatchdog.includes("forceWake") && distRaw.includes("forceWake"),
);
check(
  "TICKET-RELEASE-17: wrapper do watchdog SEM forceWake (caminho de timeout removido)",
  !/forceWake/.test(srcWatchdog) &&
    !/notifyLead\([^)]*forceWake = false\)/.test(distRaw) &&
    /private notifyLead\(teamId: string, message: string\): void/.test(srcWatchdog),
);
check(
  "paridade A2/A1: session.error genuíno repassa { config, forceWake: true } (src E dist)",
  /config \? \{ config, forceWake: true \} : \{ forceWake: true \}/.test(srcHooks) &&
    /config \? \{ config, forceWake: true \} : \{ forceWake: true \}/.test(distRaw),
);

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
  check(
    "anti-mock: suíte não contém marcadores proibidos",
    !forbiddenRe.test(readFileSync(import.meta.filename, "utf8")),
  );
}

// ---------------------------------------------------------------------------
// 5. PROVA DE MUTAÇÃO: patch determinístico no bundle dist + reexecução dos
//    mesmos cenários. Cada mutante FALHA nas sentinelas do alvo (sensibilidade)
//    e PERMANECE VERDE nos fluxos intactos (cirurgia).
// ---------------------------------------------------------------------------
const MUTATIONS = [
  {
    id: "M1",
    desc: "trava anti-bypass do QA desabilitada (implementador fecha in_progress/pending)",
    from: 'if (qaMember && teamInfo.role !== "lead" && !isQAMember(deps.db, teamInfo.teamId, caller)) {',
    to: "if (false) {",
    detect: ["A6.1 implementer-blocked-in-progress", "A6.2 in-progress-status-unchanged", "A6.6 implementer-blocked-pending", "A6.8 sdet-not-exempt-in-progress", "A6.13 qa-retrocompat-persona-label", "A6.14 qa-retrocompat-agent-label"],
    // A6.3 (sibling-stays-in_review) is a FLAT-POOL invariant: completing one
    // card never mutates a sibling, so it stays GREEN under M1 and is asserted
    // as a surgical (unaffected) sentinel — not a sensitivity probe.
    unaffected: ["A6.3 sibling-stays-in_review", "A6.12 no-qa-room-legacy-complete", "A6.15 lead-exempt-completes-in-progress", "LC.1 submit-review-wakes-sdet", "LC.3 implementer-cannot-close-in-review", "LC.5 qa-completes-in-review", "A1.1 silent-suppresses-wake-persists-row", "A2.10 genuine-error-persists-row"],
  },
  {
    id: "M2",
    desc: "texto da mensagem anti-bypass adulterado",
    from: "cannot be completed directly by an implementer; only ",
    to: "cannot be completed directly; only ",
    detect: ["A6.1 implementer-blocked-in-progress", "A6.6 implementer-blocked-pending", "A6.8 sdet-not-exempt-in-progress", "A6.13 qa-retrocompat-persona-label", "A6.14 qa-retrocompat-agent-label"],
    unaffected: ["A6.2 in-progress-status-unchanged", "A6.3 sibling-stays-in_review", "A6.5 not-legacy-in-review-message", "A6.12 no-qa-room-legacy-complete", "LC.5 qa-completes-in-review", "A1.1 silent-suppresses-wake-persists-row", "A2.7 abort-event-persists-nothing"],
  },
  {
    id: "M3",
    desc: "gate silencioso do notifyLead removido (todo ruído acorda o lead)",
    from: "if (silentLead && !options?.forceWake) {",
    to: "if (false) {",
    detect: ["A1.1 silent-suppresses-wake-persists-row", "A1.6 explicit-silent-config-suppresses"],
    unaffected: ["A1.2 forceWake-punches-through", "A1.4 silentLead-false-legacy-wakes", "A1.5 missing-config-legacy-wake", "A1.7 wake-carries-lead-agent", "A2.7 abort-event-persists-nothing", "A2.10 genuine-error-persists-row", "A6.1 implementer-blocked-in-progress"],
  },
  {
    id: "M4",
    desc: "filtro de abort do session.error removido (abort vira alarme falso)",
    // TICKET-RELEASE-17: o gate carrega também o marcador de abort intencional.
    from: "if (isAbortError(error) || intentionalAbort) {",
    to: "if (false) {",
    detect: ["A2.7 abort-event-persists-nothing", "A2.8 abort-event-zero-wake", "A2.9 abort-message-only-filtered"],
    unaffected: ["A2.10 genuine-error-persists-row", "A2.11 genuine-error-force-wakes-through-silent", "A1.1 silent-suppresses-wake-persists-row", "A6.1 implementer-blocked-in-progress"],
  },
  {
    id: "M5",
    desc: "session.error genuíno deixa de furar o silentLead (forceWake removido)",
    from: 'config ? { config, forceWake: true } : { forceWake: true }',
    to: 'config ? { config } : void 0',
    detect: ["A2.11 genuine-error-force-wakes-through-silent"],
    unaffected: ["A2.7 abort-event-persists-nothing", "A2.10 genuine-error-persists-row", "A2.12 genuine-error-legacy-no-config-wakes", "A1.1 silent-suppresses-wake-persists-row", "A1.4 silentLead-false-legacy-wakes", "A6.1 implementer-blocked-in-progress"],
  },
];

for (const m of MUTATIONS) {
  const occurrences = distRaw.split(m.from).length - 1;
  check(`${m.id}: patch aplicável (1 ocorrência exata no dist)`, occurrences === 1, `ocorrências=${occurrences}`);
  if (occurrences !== 1) continue;

  const mutantFile = path.join(TMP, `_h34_${m.id.toLowerCase()}.mjs`);
  writeFileSync(mutantFile, buildHarnessCode(distRaw.split(m.from).join(m.to)));
  let mutatedFlow;
  try {
    const mutantMod = await import(mutantFile);
    mutatedFlow = await runFlow(mutantMod);
  } catch (err) {
    check(`${m.id}: mutante executável (fluxo roda por completo)`, false, String(err));
    continue;
  }
  check(`${m.id}: mutante executável (fluxo roda por completo)`, mutatedFlow.size === realFlow.size, `checks=${mutatedFlow.size}/${realFlow.size}`);

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
