#!/usr/bin/env node
/**
 * QUALITY GATE DETERMINÍSTICO — Guardiões em in_review (TICKET-HARNESS-25)
 * @maiteuxzanela/ensemble-room-lowcost
 *
 * Engenheiro de Testes (SDET): Hugo. Guardiã do Quality Gate: Clara.
 *
 * Sob teste (src/ e dist/ REAIS, SQLite real via node:sqlite — SEM MOCKS):
 *   - executeTeamTasksComplete -> src/tools/team-tasks-complete.ts
 *       Flow 2 (reject): SDET OU QA rejeitam cards 'in_review' DE TERCEIROS;
 *                        auto-review proibido; rejection_count++; volta a
 *                        'in_progress'; notifica o implementador original.
 *       Flow 3 (complete): só QA/lead aprovam; SDET recebe erro explícito;
 *                          implementador não aprova o próprio card.
 *       Flow 1 (submit_review): guarda de lote consolidado — o wake do SDET é
 *                        SEGURADO enquanto houver tasks funcionais de dev
 *                        pending/in_progress (perfil de validação NÃO conta).
 *   - isSDETMEmber / getTeamSDETMember / isQAMember / getTeamQAMember -> src/qa-role.ts
 *   - buildTeammateSystemPrompt -> src/system-prompt.ts (contrato de entrega per-turn)
 *   - MIGRATIONS (Migration 16: team_member.role)
 *
 * Cobertura:
 *   (A) SDET reject: Hugo rejeita card de terceiro (in_review -> in_progress),
 *       rejection_count=1, review_notes gravadas, notificação sintética ao
 *       implementador (label "the SDET"), zero wake à Clara. Variante standby
 *       (spawn_context prepend + standby->starting). Auto-review bloqueado.
 *       Implementador (não-guardião) não rejeita; mensagem legada preservada em
 *       sala SEM SDET.
 *   (B) QA reject (label "the Quality Gate reviewer") e QA complete (terceiro).
 *   (C) Complete: SDET recebe erro explícito ("runs the deterministic suite but
 *       cannot approve"); implementador não completa o próprio card in_review.
 *   (D) Guarda de lote consolidado: 1ª de 2 submissões SEGURA o wake
 *       ("SDET wake held until the functional batch is consolidated", zero
 *       wakes); a última LIBERA (1 wake SDET handover). Task de perfil de
 *       validação (assignee SDET) NÃO segura o lote; task SEM assignee conta
 *       como dev e segura.
 *   (E) EXPURGO TEXTUAL: as frases obsoletas de submit_review parcial
 *       ("For partial or in-progress work, use team_tasks_complete...",
 *        "For partial or in-progress deliveries, submit_review is the SINGLE
 *         channel...", "Do NOT also send a redundant team_message(to: 'lead')
 *         for partial work", "as the SINGLE delivery channel") estão
 *       AUSENTES de src/system-prompt.ts, src/tools/team-spawn.ts e do dist; a
 *       diretriz canônica §4.2 (consolidação FINAL / intermediárias via
 *       team_message) está presente e com paridade src↔dist.
 *   (F) PROVA DE MUTAÇÃO: 5 mutantes determinísticos patcheados no bundle dist
 *       (guarda de lote desabilitada, reject-SDET anulado, erro-SDET afrouxado,
 *        contrato textual adulterado, notificação ao implementador desligada).
 *       Cada mutante FALHA nas sentinelas do cenário alvo e PERMANECE VERDE nos
 *       fluxos intactos — prova de sensibilidade e cirurgia.
 *   Extras: Migration 16 (coluna role + user_version), paridade src↔dist dos
 *           literais de log e anti-mock estático em src/ e na própria suíte.
 *
 * Único seam: cliente SDK do OpenCode (fronteira externa), reduzido a um
 * recorder determinístico de promptAsync — mesmo padrão das demais suítes do
 * repo. Nenhum componente de produção é substituído: SQLite, bundle dist e
 * schemas DDL rodam reais.
 *
 * Uso: node tests/test_harness25_guardians.mjs
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
  "createDb", "executeTeamTasksComplete", "DEFAULT_CONFIG", "MemberRegistry",
  "ProgressTracker", "MIGRATIONS", "getTeamSDETMember", "isSDETMEmber",
  "getTeamQAMember", "isQAMember", "buildTeammateSystemPrompt",
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
  writeFileSync(path.join(TMP, "_harness25_harness.mjs"), buildHarnessCode(distRaw).code);
}
const REAL = await import(path.join(TMP, "_harness25_harness.mjs"));

// ---------------------------------------------------------------------------
// Helpers de asserção.
// ---------------------------------------------------------------------------
const expectThrow = async (fn) => {
  try {
    const res = await fn();
    return { threw: false, res };
  } catch (e) {
    return { threw: true, msg: e instanceof Error ? e.message : String(e) };
  }
};

// ---------------------------------------------------------------------------
// 1. runBehavior: cenários (A)-(D) contra um módulo harness dado.
//    Cada execução cria um SQLite NOVO em scratch isolado e o remove ao final.
//    Retorna Map<checkName, {ok, detail}>. A fase real promove cada entrada a
//    check global; a fase de mutação só promove as meta-checks de detecção.
// ---------------------------------------------------------------------------
let flowSeq = 0;
async function runBehavior(mod) {
  const {
    createDb, executeTeamTasksComplete, DEFAULT_CONFIG, MemberRegistry,
    ProgressTracker, buildTeammateSystemPrompt,
  } = mod;

  const dir = path.join(TMP, `harness25_flow_${process.pid}_${flowSeq++}`);
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
  const member = (teamId, name, ses, agent, opts = {}) => {
    db.run(
      `INSERT INTO team_member (team_id, name, session_id, agent, status, execution_status, is_qa, role, spawn_context, time_created, time_updated, reported_to_lead)
       VALUES (?,?,?,?, ?, ?, ?, ?, ?, ?, ?, 0)`,
      [teamId, name, ses, agent, opts.status ?? "ready", opts.exec ?? "idle", opts.isQa ?? 0, opts.role ?? null, opts.ctx ?? null, now, now],
    );
    registry.register(teamId, name, ses);
  };
  const task = (id, teamId, assignee, status = "in_progress", rejectionCount = 0) => {
    db.run(
      "INSERT INTO team_task (id, team_id, content, status, priority, assignee, rejection_count, time_created, time_updated) VALUES (?,?,?,?,'high',?,?,?,?)",
      [id, teamId, `Task ${id}`, status, assignee, rejectionCount, now, now],
    );
  };
  const taskRow = (id) => db.query("SELECT status, assignee, rejection_count, review_notes FROM team_task WHERE id = ?").get(id);
  const memberRow = (teamId, name) => db.query("SELECT execution_status FROM team_member WHERE team_id = ? AND name = ?").get(teamId, name);

  const run = async (ses, args) => { calls.length = 0; return await executeTeamTasksComplete(deps, args, ses); };
  // Happy-path runner that never throws: a mutation may turn an expected
  // success into a thrown error — we must still record a verdict for the
  // scenario instead of aborting the whole flow (mutation executability).
  const tryRun = async (ses, args) => {
    calls.length = 0;
    try { return { res: await executeTeamTasksComplete(deps, args, ses), err: null }; }
    catch (e) { return { res: "", err: e instanceof Error ? e.message : String(e) }; }
  };
  const wakes = (ses) => calls.filter((c) => c.sessionID === ses);
  const textOf = (c) => c?.parts?.[0]?.text ?? "";

  // ======================= (A) SDET reject ================================
  seedTeam("ra", "squad-sdet-reject", "ses_lead_ra");
  member("ra", "tulio", "ses_tulio_ra", "build");
  member("ra", "hugo", "ses_hugo_ra", "hugo");
  member("ra", "clara", "ses_clara_ra", "clara", { isQa: 1 });
  task("tA", "ra", "tulio", "in_review");

  const a = await tryRun("ses_hugo_ra", { task_id: "tA", action: "reject", notes: "suite FAIL: assertion X" });
  const rejectA = a.res;
  const rowA = taskRow("tA");
  const notifyA = wakes("ses_tulio_ra");
  R("A.sdet-reject-return", a.err === null && rejectA.includes("Rejected task: Task tA") && rejectA.includes("(rejection #1)") && rejectA.includes("- suite FAIL: assertion X") && rejectA.includes("(notified tulio)"), a.err ?? rejectA);
  R("A.sdet-reject-back-to-in-progress", rowA.status === "in_progress", JSON.stringify(rowA));
  R("A.sdet-reject-count-incremented", rowA.rejection_count === 1, `rejection_count=${rowA.rejection_count}`);
  R("A.sdet-reject-notes-persisted", rowA.review_notes === "suite FAIL: assertion X", String(rowA.review_notes));
  R("A.sdet-reject-notifies-implementer-once", notifyA.length === 1, `count=${notifyA.length}`);
  R(
    "A.sdet-reject-notify-text-exact",
    textOf(notifyA[0]) ===
      '[System: Task "tA" was rejected by hugo (the SDET) (notes: suite FAIL: assertion X) — the card is back in \'in_progress\'; address the findings and resubmit.]',
    textOf(notifyA[0]),
  );
  R("A.sdet-reject-notify-synthetic", notifyA[0]?.synthetic === true, `synthetic=${notifyA[0]?.synthetic}`);
  R("A.sdet-reject-zero-clara-wake", wakes("ses_clara_ra").length === 0, `count=${wakes("ses_clara_ra").length}`);
  R("A.sdet-reject-not-qa-labeled-sdet", rejectA.includes("Rejected") && !rejectA.includes("Quality Gate reviewer"), rejectA);

  // (A-2) implementador em standby: spawn_context prepend + standby->starting.
  seedTeam("ra2", "squad-sdet-reject-standby", "ses_lead_ra2");
  member("ra2", "tulio", "ses_tulio_ra2", "build", { exec: "standby", ctx: "CTX_IMPL_BIRTH" });
  member("ra2", "hugo", "ses_hugo_ra2", "hugo");
  member("ra2", "clara", "ses_clara_ra2", "clara", { isQa: 1 });
  task("tA2", "ra2", "tulio", "in_review");
  const a2 = await tryRun("ses_hugo_ra2", { task_id: "tA2", action: "reject", notes: "borda" });
  const notifyA2 = wakes("ses_tulio_ra2");
  const baseA2 =
    '[System: Task "tA2" was rejected by hugo (the SDET) (notes: borda) — the card is back in \'in_progress\'; address the findings and resubmit.]';
  R("A2.standby-notify-prepends-spawn-context", a2.err === null && notifyA2.length === 1 && textOf(notifyA2[0]).startsWith("CTX_IMPL_BIRTH\n\n") && textOf(notifyA2[0]).endsWith(baseA2), a2.err ?? textOf(notifyA2[0]));
  R("A2.standby-transitioned-to-starting", memberRow("ra2", "tulio").execution_status === "starting", memberRow("ra2", "tulio").execution_status);
  R("A2.return-notifies-implementer", a2.err === null && a2.res.includes("(notified tulio)"), a2.err ?? a2.res);

  // (A-3) auto-review proibido: SDET rejeitando o próprio card.
  seedTeam("ra3", "squad-sdet-auto-review", "ses_lead_ra3");
  member("ra3", "hugo", "ses_hugo_ra3", "hugo");
  member("ra3", "clara", "ses_clara_ra3", "clara", { isQa: 1 });
  task("tA3", "ra3", "hugo", "in_review");
  const autoRev = await expectThrow(() => executeTeamTasksComplete(deps, { task_id: "tA3", action: "reject", notes: "x" }, "ses_hugo_ra3"));
  R("A3.sdet-cannot-reject-own-card", autoRev.threw && /auto-review is forbidden/.test(autoRev.msg), autoRev.msg);
  R("A3.own-card-state-unchanged", taskRow("tA3").status === "in_review" && taskRow("tA3").rejection_count === 0, JSON.stringify(taskRow("tA3")));

  // (A-4) implementador não-guardião NÃO pode rejeitar (sala COM SDET).
  seedTeam("ra4", "squad-non-guardian-reject", "ses_lead_ra4");
  member("ra4", "tulio", "ses_tulio_ra4", "build");
  member("ra4", "cris", "ses_cris_ra4", "build");
  member("ra4", "hugo", "ses_hugo_ra4", "hugo");
  member("ra4", "clara", "ses_clara_ra4", "clara", { isQa: 1 });
  task("tA4", "ra4", "cris", "in_review");
  const nonGuard = await expectThrow(() => executeTeamTasksComplete(deps, { task_id: "tA4", action: "reject", notes: "x" }, "ses_tulio_ra4"));
  R(
    "A4.non-guardian-reject-blocked",
    nonGuard.threw && nonGuard.msg === "Only clara, the SDET, or the team lead can reject tasks in review",
    nonGuard.msg,
  );

  // (A-5) sala SEM SDET: mensagem legada byte-estável.
  seedTeam("ra5", "squad-no-sdet-reject", "ses_lead_ra5");
  member("ra5", "tulio", "ses_tulio_ra5", "build");
  member("ra5", "cris", "ses_cris_ra5", "build");
  member("ra5", "clara", "ses_clara_ra5", "clara", { isQa: 1 });
  task("tA5", "ra5", "cris", "in_review");
  const nonGuardLegacy = await expectThrow(() => executeTeamTasksComplete(deps, { task_id: "tA5", action: "reject", notes: "x" }, "ses_tulio_ra5"));
  R(
    "A5.legacy-reject-message-preserved",
    nonGuardLegacy.threw && nonGuardLegacy.msg === "Only clara or the team lead can reject tasks in review",
    nonGuardLegacy.msg,
  );

  // ======================= (B) QA reject / QA complete ====================
  seedTeam("rb", "squad-qa-guardian", "ses_lead_rb");
  member("rb", "tulio", "ses_tulio_rb", "build");
  member("rb", "hugo", "ses_hugo_rb", "hugo");
  member("rb", "clara", "ses_clara_rb", "clara", { isQa: 1 });
  task("tBq", "rb", "tulio", "in_review");
  const rejectB = await run("ses_clara_rb", { task_id: "tBq", action: "reject", notes: "audit failed" });
  const notifyB = wakes("ses_tulio_rb");
  R("B.qa-reject-return", rejectB.includes("Rejected task: Task tBq") && rejectB.includes("(rejection #1)") && rejectB.includes("(notified tulio)"), rejectB);
  R("B.qa-reject-back-to-in-progress", taskRow("tBq").status === "in_progress" && taskRow("tBq").rejection_count === 1, JSON.stringify(taskRow("tBq")));
  R(
    "B.qa-reject-label-quality-gate",
    textOf(notifyB[0]) ===
      '[System: Task "tBq" was rejected by clara (the Quality Gate reviewer) (notes: audit failed) — the card is back in \'in_progress\'; address the findings and resubmit.]',
    textOf(notifyB[0]),
  );

  task("tBc", "rb", "tulio", "in_review");
  const completeB = await run("ses_clara_rb", { task_id: "tBc", action: "complete" });
  R("B.qa-completes-third-party", completeB.includes("Completed task: Task tBc") && taskRow("tBc").status === "completed", completeB);

  // ======================= (C) Complete guards ============================
  seedTeam("rc", "squad-complete-guards", "ses_lead_rc");
  member("rc", "tulio", "ses_tulio_rc", "build");
  member("rc", "hugo", "ses_hugo_rc", "hugo");
  member("rc", "clara", "ses_clara_rc", "clara", { isQa: 1 });
  task("tCsdet", "rc", "tulio", "in_review");
  const sdetComplete = await expectThrow(() => executeTeamTasksComplete(deps, { task_id: "tCsdet", action: "complete" }, "ses_hugo_rc"));
  R(
    "C.sdet-cannot-complete-specific-error",
    sdetComplete.threw &&
      sdetComplete.msg === 'Task "tCsdet" is in review; the SDET runs the deterministic suite but cannot approve — only clara or the team lead can complete it',
    sdetComplete.msg,
  );
  R("C.sdet-complete-state-unchanged", taskRow("tCsdet").status === "in_review", JSON.stringify(taskRow("tCsdet")));

  task("tCimpl", "rc", "tulio", "in_review");
  const implComplete = await expectThrow(() => executeTeamTasksComplete(deps, { task_id: "tCimpl", action: "complete" }, "ses_tulio_rc"));
  R(
    "C.implementer-cannot-approve-own-card",
    implComplete.threw &&
      implComplete.msg === 'Task "tCimpl" is in review; only clara or the team lead can complete it',
    implComplete.msg,
  );

  // ======================= (D) Guarda de lote consolidado =================
  // D-1: 2 dev tasks abertas -> 1ª submissão SEGURA; última LIBERA.
  seedTeam("rd", "squad-batch", "ses_lead_rd");
  member("rd", "tulio", "ses_tulio_rd", "build");
  member("rd", "cris", "ses_cris_rd", "build");
  member("rd", "hugo", "ses_hugo_rd", "hugo");
  member("rd", "clara", "ses_clara_rd", "clara", { isQa: 1 });
  task("tC1", "rd", "tulio", "in_progress");
  task("tC2", "rd", "cris", "in_progress");

  const sub1 = await run("ses_tulio_rd", { task_id: "tC1", action: "submit_review", notes: "part 1" });
  R("D.first-submit-holds-wake", sub1.includes("(SDET wake held until the functional batch is consolidated)") && !sub1.includes("(notified hugo"), sub1);
  R("D.first-submit-zero-wakes", calls.length === 0, `total=${calls.length}`);
  R("D.first-submit-in-review", taskRow("tC1").status === "in_review", JSON.stringify(taskRow("tC1")));

  const sub2 = await run("ses_cris_rd", { task_id: "tC2", action: "submit_review", notes: "part 2" });
  const hugoR = wakes("ses_hugo_rd");
  R("D.last-submit-releases-wake", sub2.includes("(notified hugo for deterministic tests)"), sub2);
  R("D.last-submit-exactly-one-sdet-wake", hugoR.length === 1, `count=${hugoR.length}`);
  R(
    "D.last-submit-wake-text-exact",
    textOf(hugoR[0]) ===
      '[System: Task "tC2" was submitted for review by cris (notes: part 2) — SDET handover: run the deterministic test suite for this delivery before the Quality Gate audits.]',
    textOf(hugoR[0]),
  );
  R("D.last-submit-zero-clara-wake", wakes("ses_clara_rd").length === 0, `count=${wakes("ses_clara_rd").length}`);

  // D-2: task de perfil de VALIDAÇÃO (assignee SDET) NÃO segura o lote.
  seedTeam("rdv", "squad-batch-validation", "ses_lead_rdv");
  member("rdv", "tulio", "ses_tulio_rdv", "build");
  member("rdv", "hugo", "ses_hugo_rdv", "hugo");
  member("rdv", "clara", "ses_clara_rdv", "clara", { isQa: 1 });
  task("tVal", "rdv", "hugo", "pending");
  task("tDev", "rdv", "tulio", "in_progress");
  const subVal = await run("ses_tulio_rdv", { task_id: "tDev", action: "submit_review", notes: "dev" });
  R("D.validation-task-does-not-hold", subVal.includes("(notified hugo for deterministic tests)") && wakes("ses_hugo_rdv").length === 1, subVal);

  // D-3: task SEM assignee conta como dev e SEGURA o lote.
  seedTeam("rdu", "squad-batch-unassigned", "ses_lead_rdu");
  member("rdu", "tulio", "ses_tulio_rdu", "build");
  member("rdu", "hugo", "ses_hugo_rdu", "hugo");
  member("rdu", "clara", "ses_clara_rdu", "clara", { isQa: 1 });
  task("tUnassigned", "rdu", null, "pending");
  task("tDev2", "rdu", "tulio", "in_progress");
  const subU = await run("ses_tulio_rdu", { task_id: "tDev2", action: "submit_review", notes: "dev" });
  R("D.unassigned-counts-as-dev-holds", subU.includes("(SDET wake held until the functional batch is consolidated)") && calls.length === 0, subU);

  // ======================= (E) system-prompt per-turn =====================
  const pTulio = buildTeammateSystemPrompt(db, "rd", "tulio", DEFAULT_CONFIG);
  R(
    "E.prompt-canonical-contract",
    pTulio.includes("Intermediate interactions and partial/in-progress deliveries during development happen EXCLUSIVELY via team_message(to: '<colleague>')") &&
      pTulio.includes("submit_review is the SINGLE channel for the FINAL consolidation of the functionality"),
    "",
  );
  R(
    "E.prompt-no-obsolete-partial-directive",
    !pTulio.includes("For partial or in-progress work, use team_tasks_complete") &&
      !pTulio.includes("For partial or in-progress deliveries, submit_review is the SINGLE channel"),
    "",
  );

  // Fecha o SQLite (WAL) antes de remover o scratch: sem isso o checkpoint
  // recria -wal/-shm durante o rmSync e o diretório sai ENOTEMPTY.
  try { db.close(); } catch { /* já fechado */ }
  rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  return got;
}

// ---------------------------------------------------------------------------
// 2. Fase REAL: todos os cenários contra o dist autêntico devem passar 100%.
// ---------------------------------------------------------------------------
const realFlow = await runBehavior(REAL);
for (const [name, { ok, detail }] of realFlow) check(`[real] ${name}`, ok, detail);

// ---------------------------------------------------------------------------
// 3. Textual: expurgo do submit_review parcial + diretriz canônica + paridade.
//    Função pura sobre (srcSystem, srcSpawn, distText) para servir de sentinela
//    mutável na prova de mutação (M4).
// ---------------------------------------------------------------------------
const SRC_SYSTEM = readFileSync(path.join(SRC, "system-prompt.ts"), "utf8");
const SRC_SPAWN = readFileSync(path.join(SRC, "tools", "team-spawn.ts"), "utf8");

const OBSOLETE_MARKERS = [
  "For partial or in-progress work, use team_tasks_complete",
  "For partial or in-progress deliveries, submit_review is the SINGLE channel",
  "Do NOT also send a redundant team_message(to: 'lead') for partial work",
  "as the SINGLE delivery channel",
];
const CANONICAL_SYSTEM = "submit_review is the SINGLE channel for the FINAL consolidation of the functionality";
const CANONICAL_SPAWN =
  "Intermediate/partial work during development happens exclusively via team_message(to: '<colleague>'); submit_review is reserved for the final consolidation of the functionality";

function textualChecks(distText) {
  const got = new Map();
  const T = (name, ok, detail) => got.set(name, { ok: !!ok, detail: detail ?? "" });

  for (const marker of OBSOLETE_MARKERS) {
    T(`textual.obsolete-system-absent:${marker.slice(0, 32)}`, !SRC_SYSTEM.includes(marker), "");
    T(`textual.obsolete-spawn-absent:${marker.slice(0, 32)}`, !SRC_SPAWN.includes(marker), "");
    T(`textual.obsolete-dist-absent:${marker.slice(0, 32)}`, !distText.includes(marker), "");
  }
  T("textual.canonical-system-present", SRC_SYSTEM.includes(CANONICAL_SYSTEM), "");
  T("textual.canonical-spawn-present", SRC_SPAWN.includes(CANONICAL_SPAWN), "");
  T("textual.canonical-in-dist", distText.includes(CANONICAL_SYSTEM) && distText.includes("Intermediate/partial work during development happens exclusively via team_message"), "");
  T("textual.parity-canonical-src-dist", distText.includes(CANONICAL_SYSTEM) && SRC_SYSTEM.includes(CANONICAL_SYSTEM), "");
  return got;
}

const realTextual = textualChecks(distRaw);
for (const [name, { ok, detail }] of realTextual) check(`[textual] ${name}`, ok, detail);

// Índice dos checks reais — valida que toda sentinela de mutação aponta para um
// nome existente (um typo no nome jamais deve passar silenciosamente como
// "detectado"/"preservado").
const realCombined = new Map([...realFlow, ...realTextual]);

// Paridade src↔dist dos literais de log do HARNESS-25.
const LOG_LITERALS = [
  "tasks-complete:sdet-wake:held",
  "tasks-complete:reject-notify:ok",
  "tasks-complete:reject-notify:failed",
];
const srcTc = readFileSync(path.join(SRC, "tools", "team-tasks-complete.ts"), "utf8");
for (const lit of LOG_LITERALS) {
  check(`paridade src↔dist: literal "${lit}"`, srcTc.includes(lit) && distRaw.includes(lit));
}

// Migration 16: coluna role + user_version.
{
  const migFile = path.join(TMP, "_harness25_mig.db");
  rmSync(migFile, { force: true });
  const migDb = REAL.createDb(migFile);
  const cols = migDb.query("PRAGMA table_info(team_member)").all().map((c) => c.name);
  check("Migration 16: coluna role aplicada em team_member", cols.includes("role"), cols.join(","));
  const uv = migDb.query("PRAGMA user_version").get().user_version;
  check("Migration 16: user_version === MIGRATIONS.length", uv === REAL.MIGRATIONS.length, `user_version=${uv} len=${REAL.MIGRATIONS.length}`);
  try { migDb.close(); } catch { /* já fechado */ }
  rmSync(migFile, { force: true });
  rmSync(`${migFile}-wal`, { force: true });
  rmSync(`${migFile}-shm`, { force: true });
}

// Anti-mock estático.
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
//    mesmos cenários. Cada mutante precisa FALHAR nas sentinelas do cenário
//    alvo (sensibilidade) e PERMANECER VERDE nos fluxos intactos (cirurgia).
//    Literais escolhidos por existirem EXATAMENTE 1x no dist (colisão → skip).
// ---------------------------------------------------------------------------
const MUTATIONS = [
  {
    id: "M1",
    desc: "guarda de lote consolidado desabilitada (wake do SDET nunca é segurado)",
    from: "if (pendingDev > 0) {",
    to: "if (false) {",
    detect: ["D.first-submit-holds-wake", "D.first-submit-zero-wakes", "D.unassigned-counts-as-dev-holds"],
    unaffected: ["D.last-submit-releases-wake", "D.validation-task-does-not-hold", "A.sdet-reject-back-to-in-progress", "B.qa-completes-third-party"],
  },
  {
    id: "M2",
    desc: "detecção de rejecter-SDET anulada (Hugo deixa de poder rejeitar cards de terceiros)",
    from: "const rejecterIsSDET = isSDETMEmber(deps.db, teamInfo.teamId, caller)",
    to: "const rejecterIsSDET = false",
    detect: ["A.sdet-reject-return", "A.sdet-reject-back-to-in-progress", "A3.sdet-cannot-reject-own-card"],
    unaffected: ["B.qa-reject-back-to-in-progress", "B.qa-completes-third-party", "C.sdet-cannot-complete-specific-error", "A5.legacy-reject-message-preserved"],
  },
  {
    id: "M3",
    desc: "erro explícito do SDET-complete afrouxado (branch SDET suprimido)",
    from: "if (isSDETMEmber(deps.db, teamInfo.teamId, caller)) {",
    to: "if (false) {",
    detect: ["C.sdet-cannot-complete-specific-error"],
    unaffected: ["B.qa-completes-third-party", "C.implementer-cannot-approve-own-card", "A.sdet-reject-back-to-in-progress"],
  },
  {
    id: "M4",
    desc: "diretriz textual canônica adulterada no dist (submit_review FINAL perdido)",
    from: "submit_review is the SINGLE channel for the FINAL consolidation",
    to: "submit_review is the SINGLE channel",
    detect: ["textual.canonical-in-dist", "E.prompt-canonical-contract"],
    unaffected: ["A.sdet-reject-back-to-in-progress", "B.qa-completes-third-party", "D.first-submit-holds-wake"],
  },
  {
    id: "M5",
    desc: "notificação ao implementador rejeitado desligada",
    from: "const notified = notifyRejectedImplementer(",
    to: "const notified = false && notifyRejectedImplementer(",
    detect: ["A.sdet-reject-notifies-implementer-once", "A.sdet-reject-return", "A2.return-notifies-implementer"],
    unaffected: ["A.sdet-reject-back-to-in-progress", "A.sdet-reject-count-incremented", "B.qa-completes-third-party"],
  },
];

for (const m of MUTATIONS) {
  for (const n of [...m.detect, ...m.unaffected]) {
    check(`${m.id}: sentinela "${n}" existe nos checks reais`, realCombined.has(n), "");
  }
  const occurrences = distRaw.split(m.from).length - 1;
  check(`${m.id}: patch aplicável (1 ocorrência exata no dist)`, occurrences === 1, `ocorrências=${occurrences}`);
  if (occurrences !== 1) continue;

  const mutantDist = distRaw.split(m.from).join(m.to);
  const mutantFile = path.join(TMP, `_harness25_${m.id.toLowerCase()}.mjs`);
  writeFileSync(mutantFile, buildHarnessCode(mutantDist).code);

  let combined;
  try {
    const mutantMod = await import(mutantFile);
    const behavior = await runBehavior(mutantMod);
    const textual = textualChecks(mutantDist);
    combined = new Map([...behavior, ...textual]);
    check(`${m.id}: mutante executável (fluxo roda por completo)`, behavior.size === realFlow.size, `checks=${behavior.size}/${realFlow.size}`);
  } catch (err) {
    check(`${m.id}: mutante executável (fluxo roda por completo)`, false, String(err));
    continue;
  }

  const missed = m.detect.filter((n) => combined.get(n)?.ok !== false);
  check(
    `${m.id}: asserções sensíveis — mutação detectada [${m.desc}]`,
    missed.length === 0,
    missed.length ? `não detectaram: ${missed.join(", ")}` : `${m.detect.length}/${m.detect.length} sentinelas falharam`,
  );

  const broken = m.unaffected.filter((n) => combined.get(n)?.ok !== true);
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
