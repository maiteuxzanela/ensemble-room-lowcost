#!/usr/bin/env node
/**
 * QUALITY GATE DETERMINÍSTICO — Grafos Cíclicos e Trava da Guardiã Clara
 * @hueyexe/opencode-ensemble@0.18.1
 *
 * Guardiã: Clara (Quality Gate & Integridade dos Testes).
 *
 * Sob teste:
 *   - Migration 13 & schema team_task (status in_review, rejection_count, review_notes)
 *   - executeTeamTasksAdd -> src/tools/team-tasks-add.ts (DAG paralelo desarmado por padrão)
 *   - executeTeamTasksComplete -> src/tools/team-tasks-complete.ts (ciclo submit_review/reject/complete e trava de Clara)
 *   - executeTeamMessage -> src/tools/team-message.ts (reativação peer-to-peer e reset de reported_to_lead)
 *   - hooks -> src/hooks.ts (shouldNudgeIdleMember, shouldAlarmFastIdle, hasInReviewAssignedTasks, hasActivePeerDialogue)
 *   - board wake -> defesa activeRemaining com in_review
 *
 * Regras:
 *   - SEM MOCKS em src/ e dist/
 *   - SQLite real (node:sqlite)
 *   - Scratch isolado em .test-scratch/
 */

import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";

const REPO = path.resolve(import.meta.dirname, "..");
const PKG = process.env.ENSEMBLE_PKG || REPO;
const DIST = path.join(PKG, "dist/index.js");
const TMP = path.join(REPO, ".test-scratch");
mkdirSync(TMP, { recursive: true });
const HARNESS = path.join(TMP, "_cyclic_graph_harness.mjs");
const ROOT = path.join(TMP, "cyclic_graph_suite");

const TEAM_ID = "team_cyclic";
const LEAD_SESSION = "ses_lead";
const CLARA_SESSION = "ses_clara";
const TULIO_SESSION = "ses_tulio";
const MAYA_SESSION = "ses_maya";

const results = [];
const check = (name, ok, detail) => {
  results.push([name, ok]);
  console.log(`${ok ? "PASS" : "FAIL"} | ${name}${detail ? " | " + detail : ""}`);
};

const unhandled = [];
process.on("unhandledRejection", (e) => unhandled.push(e));

/* ================================================================== *
 * 0. SINTAXE E SÍMBOLOS EXIGIDOS
 * ================================================================== */
{
  const r = spawnSync(process.execPath, ["--check", DIST], { encoding: "utf8" });
  check(
    "node --check dist/index.js → exit 0",
    r.status === 0,
    `status=${r.status}${r.stderr ? " stderr=" + r.stderr.trim().slice(0, 200) : ""}`,
  );
}

const REQUIRED_SYMBOLS = [
  "createDb",
  "executeTeamTasksAdd",
  "executeTeamTasksComplete",
  "executeTeamClaim",
  "executeTeamMessage",
  "executeTeamSpawn",
  "MemberRegistry",
  "DEFAULT_CONFIG",
  "hasReportedCompletion",
  "shouldNudgeIdleMember",
  "shouldAlarmFastIdle",
  "hasInReviewAssignedTasks",
  "hasActivePeerDialogue",
  "executeTeamTasksReview",
  "executeTeamTasksReject",
  "MIGRATIONS",
];

const distRaw = readFileSync(DIST, "utf8");
{
  const missing = REQUIRED_SYMBOLS.filter(
    (s) => !new RegExp(`(function|class|var|const|let)\\s+${s}\\b`).test(distRaw),
  );
  check(
    "dist declara todos os símbolos exigidos pela suíte cíclica",
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
}

const mods = await import(HARNESS);
const {
  createDb,
  executeTeamTasksAdd,
  executeTeamTasksComplete,
  executeTeamClaim,
  executeTeamMessage,
  MemberRegistry,
  DEFAULT_CONFIG,
  hasReportedCompletion,
  shouldNudgeIdleMember,
  shouldAlarmFastIdle,
  hasInReviewAssignedTasks,
  hasActivePeerDialogue,
  executeTeamTasksReview,
  executeTeamTasksReject,
  MIGRATIONS,
} = mods;

function createTestClient() {
  const calls = { promptAsync: [], showToast: [] };
  return {
    calls,
    client: {
      session: {
        promptAsync: async (o) => {
          calls.promptAsync.push(o);
          return {};
        },
      },
      tui: {
        showToast: async (o) => {
          calls.showToast.push(o);
        },
      },
    },
  };
}

async function runCyclicGraphSuite() {
  rmSync(ROOT, { recursive: true, force: true });
  mkdirSync(ROOT, { recursive: true });

  const db = createDb(path.join(ROOT, "ensemble.db"));
  const tc = createTestClient();
  const registry = new MemberRegistry();

  const deps = {
    db,
    directory: ROOT,
    client: tc.client,
    registry,
    config: DEFAULT_CONFIG,
    progressTracker: { recordTaskComplete: () => {} },
  };

  /* ================================================================== *
   * 1. SCHEMA & MIGRATION 13
   * ================================================================== */
  const userVer = db.query("PRAGMA user_version").get().user_version;
  check("Migration 13 aplicada com sucesso", userVer === 13, `user_version=${userVer}`);

  const taskColumns = db.query("PRAGMA table_info(team_task)").all();
  const colNames = taskColumns.map((c) => c.name);
  check("team_task possui coluna rejection_count", colNames.includes("rejection_count"));
  check("team_task possui coluna review_notes", colNames.includes("review_notes"));

  // Inicializar projeto e time
  db.query("INSERT INTO project (id, name, path, status, time_created, time_updated) VALUES ('default', 'Default Project', '', 'active', 0, 0) ON CONFLICT DO NOTHING").run();
  db.query(`INSERT INTO team (id, name, project_id, lead_session_id, status, delegate, time_created, time_updated, lead_agent)
            VALUES ('${TEAM_ID}', 'cyclic-team', 'default', '${LEAD_SESSION}', 'active', 0, 0, 0, 'build') ON CONFLICT DO NOTHING`).run();

  // Inserir membros no SQLite
  const now = Date.now();
  const insertMember = (name, sessionId, agent) => {
    db.query(`INSERT INTO team_member (team_id, name, session_id, agent, status, execution_status, time_created, time_updated, reported_to_lead)
              VALUES ('${TEAM_ID}', '${name}', '${sessionId}', '${agent}', 'ready', 'idle', ${now}, ${now}, 0)`).run();
    registry.register(TEAM_ID, name, sessionId);
  };

  insertMember("clara", CLARA_SESSION, "clara");
  insertMember("tulio", TULIO_SESSION, "tulio");
  insertMember("maya", MAYA_SESSION, "maya");

  /* ================================================================== *
   * 2. PARALELISMO REAL (SEM SEQUENTIAL FORÇADO)
   * ================================================================== */
  // Criação de 3 tarefas sem a flag sequential (devem ser todas paralelas / pending)
  const parallelAddRes = await executeTeamTasksAdd(
    deps,
    {
      tasks: [
        { content: "Tarefa Paralela 1", priority: "high" },
        { content: "Tarefa Paralela 2", priority: "medium" },
        { content: "Tarefa Paralela 3", priority: "low" },
      ],
    },
    LEAD_SESSION,
  );
  check("executeTeamTasksAdd sem sequential executou", typeof parallelAddRes === "string");

  const parallelTasks = db.query(
    "SELECT * FROM team_task WHERE content LIKE 'Tarefa Paralela%' ORDER BY time_created ASC",
  ).all();
  check("3 tarefas paralelas registradas no SQLite", parallelTasks.length === 3);
  check("Tarefa Paralela 1 inicia como pending", parallelTasks[0].status === "pending");
  check("Tarefa Paralela 2 inicia como pending (não bloqueada)", parallelTasks[1].status === "pending");
  check("Tarefa Paralela 3 inicia como pending (não bloqueada)", parallelTasks[2].status === "pending");
  check("Tarefa Paralela 2 não possui depends_on forçado", parallelTasks[1].depends_on === null);
  check("Tarefa Paralela 3 não possui depends_on forçado", parallelTasks[2].depends_on === null);

  // CONTROLE: Criação com sequential: true (deve manter o encadeamento DAG)
  await executeTeamTasksAdd(
    deps,
    {
      tasks: [
        { content: "Seq 1", priority: "medium" },
        { content: "Seq 2", priority: "medium" },
      ],
      sequential: true,
    },
    LEAD_SESSION,
  );
  const seqTasks = db.query(
    "SELECT * FROM team_task WHERE content LIKE 'Seq %' ORDER BY time_created ASC",
  ).all();
  check("Seq 1 inicia como pending", seqTasks[0].status === "pending");
  check("Seq 2 inicia como blocked", seqTasks[1].status === "blocked");
  check("Seq 2 depende de Seq 1", seqTasks[1].depends_on.includes(seqTasks[0].id));

  // Limpar tarefas de teste de paralelismo para isolar os próximos testes
  db.run("DELETE FROM team_task WHERE team_id = ?", TEAM_ID);

  /* ================================================================== *
   * 3. CICLO COMPLETO DO GRAFO CÍCLICO
   *    in_progress -> in_review -> reject (Clara) -> in_progress ->
   *    novo envio (submit_review) -> approve (Clara) -> completed
   * ================================================================== */
  await executeTeamTasksAdd(
    deps,
    {
      tasks: [{ content: "Feature Cíclica X", priority: "high" }],
    },
    LEAD_SESSION,
  );
  const [taskX] = db.query("SELECT * FROM team_task WHERE content = 'Feature Cíclica X'").all();
  check("Tarefa X criada com status pending", taskX.status === "pending");

  // A. Túlio reivindica a tarefa
  const claimRes = await executeTeamClaim(deps, { task_id: taskX.id }, TULIO_SESSION);
  check("Túlio reivindicou a Tarefa X", claimRes.includes("Claimed task"));
  let currentTask = db.query("SELECT * FROM team_task WHERE id = ?").get(taskX.id);
  check("Tarefa X transicionou para in_progress", currentTask.status === "in_progress");
  check("Tarefa X atribuída a tulio", currentTask.assignee === "tulio");

  // B. Túlio submete para revisão com notas
  tc.calls.promptAsync.length = 0; // zera contador de chamadas
  const submitRes = await executeTeamTasksComplete(
    deps,
    {
      task_id: taskX.id,
      action: "submit_review",
      notes: "PR inicial implementado com testes básicos",
    },
    TULIO_SESSION,
  );
  check("Túlio submeteu para review", submitRes.includes("Submitted task for review"));
  currentTask = db.query("SELECT * FROM team_task WHERE id = ?").get(taskX.id);
  check("Tarefa X transicionou para in_review", currentTask.status === "in_review");
  check("review_notes gravado no SQLite", currentTask.review_notes === "PR inicial implementado com testes básicos");
  check("rejection_count inicial é 0", currentTask.rejection_count === 0);
  check("Lead NÃO foi acordado prematuramente com tarefa in_review", tc.calls.promptAsync.length === 0);

  // C. Clara rejeita a entrega com apontamentos de qualidade
  const rejectRes = await executeTeamTasksComplete(
    deps,
    {
      task_id: taskX.id,
      action: "reject",
      notes: "Reprovado: cobertura insuficiente, adicionar teste de edge case",
    },
    CLARA_SESSION,
  );
  check("Clara rejeitou a tarefa", rejectRes.includes("Rejected task") && rejectRes.includes("rejection #1"));
  currentTask = db.query("SELECT * FROM team_task WHERE id = ?").get(taskX.id);
  check("Tarefa X voltou para in_progress após reject", currentTask.status === "in_progress");
  check("rejection_count incrementado para 1", currentTask.rejection_count === 1);
  check("review_notes atualizado com motivo do reject", currentTask.review_notes === "Reprovado: cobertura insuficiente, adicionar teste de edge case");
  check("assignee permanece tulio", currentTask.assignee === "tulio");

  // D. Túlio ajusta o código e submete novamente
  const resubmitRes = await executeTeamTasksComplete(
    deps,
    {
      task_id: taskX.id,
      action: "submit_review",
      notes: "Edge case corrigido com testes determinísticos reais",
    },
    TULIO_SESSION,
  );
  check("Túlio reenviou para review", resubmitRes.includes("Submitted task for review"));
  currentTask = db.query("SELECT * FROM team_task WHERE id = ?").get(taskX.id);
  check("Tarefa X retornou para in_review", currentTask.status === "in_review");
  check("rejection_count preservou o histórico (1)", currentTask.rejection_count === 1);
  check("review_notes atualizado no reenvio", currentTask.review_notes === "Edge case corrigido com testes determinísticos reais");

  // E. Clara aprova e completa a tarefa
  tc.calls.promptAsync.length = 0;
  const approveRes = await executeTeamTasksComplete(
    deps,
    {
      task_id: taskX.id,
      action: "complete",
    },
    CLARA_SESSION,
  );
  check("Clara completou e aprovou a tarefa", approveRes.includes("Completed task"));
  currentTask = db.query("SELECT * FROM team_task WHERE id = ?").get(taskX.id);
  check("Tarefa X concluída com status completed", currentTask.status === "completed");
  check("Board wake disparou para o lead ao fechar o board", tc.calls.promptAsync.length === 1);
  check(
    "Board wake continha identificação da Clara",
    tc.calls.promptAsync[0]?.parts?.[0]?.text?.includes("completed on board by clara"),
    JSON.stringify(tc.calls.promptAsync[0]?.parts?.[0]?.text),
  );

  /* ================================================================== *
   * 4. TRAVA DA GUARDIÃ CLARA (SEGURANÇA DETERMINÍSTICA)
   * ================================================================== */
  await executeTeamTasksAdd(
    deps,
    {
      tasks: [{ content: "Feature Travada Y", priority: "high" }],
    },
    LEAD_SESSION,
  );
  const [taskY] = db.query("SELECT * FROM team_task WHERE content = 'Feature Travada Y'").all();
  await executeTeamClaim(deps, { task_id: taskY.id }, TULIO_SESSION);
  await executeTeamTasksComplete(
    deps,
    { task_id: taskY.id, action: "submit_review", notes: "Submissão para teste de trava" },
    TULIO_SESSION,
  );

  // A. Túlio tenta completar tarefa in_review diretamente (deve ser rejeitado)
  let tulioCompleteError = null;
  try {
    await executeTeamTasksComplete(deps, { task_id: taskY.id, action: "complete" }, TULIO_SESSION);
  } catch (err) {
    tulioCompleteError = err.message;
  }
  check(
    "Implementador (tulio) é bloqueado de completar tarefa in_review",
    tulioCompleteError?.includes("only clara or the team lead can complete it"),
    tulioCompleteError,
  );

  // B. Maya (parceira terceira) tenta completar tarefa in_review (deve ser rejeitada)
  let mayaCompleteError = null;
  try {
    await executeTeamTasksComplete(deps, { task_id: taskY.id, action: "complete" }, MAYA_SESSION);
  } catch (err) {
    mayaCompleteError = err.message;
  }
  check(
    "Outro agente (maya) é bloqueado de completar tarefa in_review",
    mayaCompleteError?.includes("only clara or the team lead can complete it"),
    mayaCompleteError,
  );

  // C. Maya tenta rejeitar tarefa in_review (deve ser rejeitada)
  let mayaRejectError = null;
  try {
    await executeTeamTasksComplete(deps, { task_id: taskY.id, action: "reject" }, MAYA_SESSION);
  } catch (err) {
    mayaRejectError = err.message;
  }
  check(
    "Outro agente (maya) é bloqueado de rejeitar tarefa in_review",
    mayaRejectError?.includes("Only clara or the team lead can reject tasks in review"),
    mayaRejectError,
  );

  // D. Túlio tenta rejeitar sua própria tarefa em review
  let tulioRejectError = null;
  try {
    await executeTeamTasksComplete(deps, { task_id: taskY.id, action: "reject" }, TULIO_SESSION);
  } catch (err) {
    tulioRejectError = err.message;
  }
  check(
    "Implementador é bloqueado de auto-rejeitar tarefa in_review",
    tulioRejectError?.includes("Only clara or the team lead can reject tasks in review"),
  );

  // E. Lead possui autoridade soberana e pode rejeitar ou aprovar
  const leadRejectRes = await executeTeamTasksComplete(
    deps,
    { task_id: taskY.id, action: "reject", notes: "Lead solicitou refatoração" },
    LEAD_SESSION,
  );
  check("Lead tem permissão para rejeitar tarefa em review", leadRejectRes.includes("Rejected task"));

  // Reenviar para review
  await executeTeamTasksComplete(deps, { task_id: taskY.id, action: "submit_review" }, TULIO_SESSION);

  // Lead tem permissão para completar
  const leadCompleteRes = await executeTeamTasksComplete(
    deps,
    { task_id: taskY.id, action: "complete" },
    LEAD_SESSION,
  );
  check("Lead tem permissão para aprovar e completar tarefa em review", leadCompleteRes.includes("Completed task"));

  // F. Helpers executeTeamTasksReview e executeTeamTasksReject
  await executeTeamTasksAdd(
    deps,
    { tasks: [{ content: "Feature Helper Z", priority: "low" }] },
    LEAD_SESSION,
  );
  const [taskZ] = db.query("SELECT * FROM team_task WHERE content = 'Feature Helper Z'").all();
  await executeTeamClaim(deps, { task_id: taskZ.id }, TULIO_SESSION);

  const helperReviewRes = await executeTeamTasksReview(
    deps,
    { task_id: taskZ.id, notes: "Via helper review" },
    TULIO_SESSION,
  );
  check("executeTeamTasksReview coloca em in_review", helperReviewRes.includes("Submitted task for review"));

  const helperRejectRes = await executeTeamTasksReject(
    deps,
    { task_id: taskZ.id, notes: "Via helper reject" },
    CLARA_SESSION,
  );
  check("executeTeamTasksReject coloca em in_progress", helperRejectRes.includes("Rejected task"));

  // Clara completa taskZ via executeTeamTasksReview + complete
  await executeTeamTasksReview(deps, { task_id: taskZ.id }, TULIO_SESSION);
  await executeTeamTasksComplete(deps, { task_id: taskZ.id, action: "complete" }, CLARA_SESSION);

  /* ================================================================== *
   * 5. REATIVAÇÃO ENTRE PARES (PEER-TO-PEER CYCLIC LOOPS)
   * ================================================================== */
  // Simular que Túlio reportou conclusão anteriormente
  db.run("UPDATE team_member SET reported_to_lead = 1 WHERE team_id = ? AND name = 'tulio'", TEAM_ID);
  check("Túlio está com reported_to_lead = 1", hasReportedCompletion(db, TEAM_ID, "tulio") === true);

  // A. Mensagem do Lead sem force: true NÃO deve acordar Túlio
  tc.calls.promptAsync.length = 0;
  const leadMsgRes = await executeTeamMessage(
    deps,
    { to: "tulio", text: "Mensagem do lead para quem já completou" },
    LEAD_SESSION,
  );
  check("Mensagem do lead é armazenada sem acordar", leadMsgRes.includes("will not wake them"));
  check("Nenhum promptAsync disparado pelo lead sem force", tc.calls.promptAsync.length === 0);
  check("reported_to_lead permanece 1 para tulio", hasReportedCompletion(db, TEAM_ID, "tulio") === true);

  // B. Mensagem de Par (Clara -> Túlio): DEVE acordar Túlio e resetar reported_to_lead
  const peerMsgRes = await executeTeamMessage(
    deps,
    { to: "tulio", text: "Oi Túlio, por favor revise o módulo X para a nova sprint" },
    CLARA_SESSION,
  );
  check("Mensagem entre pares enviada com sucesso", peerMsgRes === "Message sent to tulio.");
  check("promptAsync disparado para a sessão do Túlio", tc.calls.promptAsync.length === 1);
  check("Destino do promptAsync foi ses_tulio", tc.calls.promptAsync[0]?.sessionID === TULIO_SESSION, `sessionID=${tc.calls.promptAsync[0]?.sessionID}`);
  check(
    "reported_to_lead foi resetado para 0 no destinatário",
    hasReportedCompletion(db, TEAM_ID, "tulio") === false,
  );

  // C. Mensagem de Par (Maya -> Clara): Maya também pode acordar Clara se ela tiver reportado
  db.run("UPDATE team_member SET reported_to_lead = 1 WHERE team_id = ? AND name = 'clara'", TEAM_ID);
  check("Clara está com reported_to_lead = 1", hasReportedCompletion(db, TEAM_ID, "clara") === true);

  tc.calls.promptAsync.length = 0;
  const mayaMsgRes = await executeTeamMessage(
    deps,
    { to: "clara", text: "Clara, prontas as alterações do AST" },
    MAYA_SESSION,
  );
  check("Mensagem Maya -> Clara enviada", mayaMsgRes === "Message sent to clara.");
  check("promptAsync disparado para a sessão de Clara", tc.calls.promptAsync.length === 1);
  check("Destino do promptAsync foi ses_clara", tc.calls.promptAsync[0]?.sessionID === CLARA_SESSION, `sessionID=${tc.calls.promptAsync[0]?.sessionID}`);
  check("reported_to_lead da Clara resetado para 0", hasReportedCompletion(db, TEAM_ID, "clara") === false);

  /* ================================================================== *
   * 6. HOOKS: SUPRESSÃO DE NUDGE E FAST-IDLE
   * ================================================================== */
  // Criar tarefa atribuída a Túlio com status in_review
  db.run("DELETE FROM team_task WHERE team_id = ?", TEAM_ID);
  db.query(`INSERT INTO team_task (id, team_id, content, status, priority, assignee, time_created, time_updated, rejection_count)
            VALUES ('task_rev_1', '${TEAM_ID}', 'Tarefa Sob Revisão', 'in_review', 'high', 'tulio', ${now}, ${now}, 0)`).run();

  check("hasInReviewAssignedTasks detecta tarefa in_review para tulio", hasInReviewAssignedTasks(db, TEAM_ID, "tulio") === true);
  check("shouldNudgeIdleMember suprime nudge para tulio esperando review", shouldNudgeIdleMember(db, TEAM_ID, "tulio") === false);
  check("shouldAlarmFastIdle suprime alarme para tulio esperando review", shouldAlarmFastIdle(db, TEAM_ID, "tulio", now) === false);

  // Remover tarefa in_review e testar diálogo ativo entre pares
  db.run("DELETE FROM team_task WHERE team_id = ?", TEAM_ID);
  check("hasInReviewAssignedTasks retorna false sem tarefas in_review", hasInReviewAssignedTasks(db, TEAM_ID, "tulio") === false);

  // Como Túlio recebeu mensagem de Clara anteriormente, hasActivePeerDialogue deve ser true
  check("hasActivePeerDialogue detecta mensagens trocadas entre pares", hasActivePeerDialogue(db, TEAM_ID, "tulio") === true);
  check("shouldNudgeIdleMember suprime nudge por diálogo ativo com par", shouldNudgeIdleMember(db, TEAM_ID, "tulio") === false);

  // CONTROLE: Membro sem tarefas e sem mensagens sofre nudge normalmente
  insertMember("novo_agente", "ses_novo", "build");
  check(
    "CONTROLE: novo agente idle sem tarefas nem diálogo recebe nudge",
    shouldNudgeIdleMember(db, TEAM_ID, "novo_agente") === true,
  );

  /* ================================================================== *
   * 7. ZERO MOCKS EM PRODUÇÃO
   * ================================================================== */
  const srcFiles = ["src/schema.ts", "src/tools/team-tasks-add.ts", "src/tools/team-tasks-complete.ts", "src/tools/team-message.ts", "src/hooks.ts"];
  let mockFindings = 0;
  for (const f of srcFiles) {
    const content = readFileSync(path.join(REPO, f), "utf8");
    if (/jest\.mock|sinon|vi\.mock|mockImplementation/i.test(content)) {
      mockFindings++;
    }
  }
  check("Zero mocks ou spies em código de produção", mockFindings === 0, `achados=${mockFindings}`);
}

await runCyclicGraphSuite();

const passed = results.filter(([, ok]) => ok).length;
const total = results.length;
console.log(`\nRESULT: ${passed}/${total} checks passed, ${unhandled.length} unhandled rejections`);
process.exit(passed === total && unhandled.length === 0 ? 0 : 1);
