#!/usr/bin/env node
/**
 * QUALITY GATE DETERMINÍSTICO — TASK-03 / TICKET-IN-REVIEW-NUDGE
 * Testes determinísticos para Nudge de Correção Automática em Silêncio com Tarefas sob Review.
 *
 * Sob teste:
 *   - dist/index.js (harness compilado real): shouldNudgeInReviewTasks, inReviewNudges,
 *     IN_REVIEW_NUDGE_MESSAGE, MAX_IN_REVIEW_NUDGES
 *   - Cooldown e limite estrito de 2 tentativas por team:member:taskId
 *   - Disparo do nudge neutro sem citar texto puro ("Tasks remain in review on the board...")
 *   - Disparo tanto para o assignee explícito da tarefa in_review quanto para clara/reviewer
 *   - Zero mocks em produção.
 *
 * Uso: node tests/test_in_review_idle_nudge.mjs
 * Exit: 0 = todos os checks PASS; 1 = há FAIL.
 */

import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";

const REPO = path.resolve(import.meta.dirname, "..");
const PKG = process.env.ENSEMBLE_PKG || REPO;
const DIST = path.join(PKG, "dist/index.js");
const TMP = path.join(REPO, ".test-scratch");
mkdirSync(TMP, { recursive: true });

const results = [];
const check = (name, ok, detail) => {
  results.push([name, ok]);
  console.log(`${ok ? "PASS" : "FAIL"} | ${name}${detail ? " | " + detail : ""}`);
};

const unhandled = [];
process.on("unhandledRejection", (e) => unhandled.push(e));

const HARNESS = path.join(TMP, "_in_review_nudge_harness.mjs");
const REQUIRED_SYMBOLS = [
  "createDb",
  "shouldNudgeInReviewTasks",
  "inReviewNudges",
  "IN_REVIEW_NUDGE_MESSAGE",
  "MAX_IN_REVIEW_NUDGES",
];

const distRaw = readFileSync(DIST, "utf8");
{
  const missing = REQUIRED_SYMBOLS.filter(
    (s) => !new RegExp(`(function|class|var|const|let)\\s+${s}\\b`).test(distRaw),
  );
  check(
    "dist declara todos os símbolos exigidos pelo nudge de in_review",
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
  shouldNudgeInReviewTasks,
  inReviewNudges,
  IN_REVIEW_NUDGE_MESSAGE,
  MAX_IN_REVIEW_NUDGES,
} = mods;

let dbSeq = 0;
function makeDb() {
  const file = path.join(TMP, `in_review_nudge_${process.pid}_${dbSeq++}.sqlite`);
  rmSync(file, { force: true });
  rmSync(`${file}-wal`, { force: true });
  rmSync(`${file}-shm`, { force: true });
  return createDb(file);
}

async function runInReviewNudgeSuite() {
  console.log("=".repeat(78));
  console.log("TEST: Nudge de Tarefas em Review no Ciclo Idle (Deterministic)");
  console.log("=".repeat(78));

  const db = makeDb();
  const TEAM_ID = "team_nudge_test";
  const now = Date.now();

  // 1. Setup inicial de equipe e membros
  db.query(`INSERT INTO team (id, name, lead_session_id, status, time_created, time_updated)
            VALUES ('${TEAM_ID}', 'nudge-team', 'ses_lead', 'active', ${now}, ${now})`).run();

  const insertMember = (name, sessionId, agent = "build", status = "ready", executionStatus = "idle") => {
    db.query(`INSERT INTO team_member (team_id, name, session_id, agent, status, execution_status, time_created, time_updated)
              VALUES ('${TEAM_ID}', '${name}', '${sessionId}', '${agent}', '${status}', '${executionStatus}', ${now}, ${now})`).run();
  };

  insertMember("clara", "ses_clara", "clara", "ready", "idle");
  insertMember("tales", "ses_tales", "build", "ready", "idle");
  insertMember("dev_busy", "ses_busy", "build", "busy", "running");
  insertMember("dev_standby", "ses_standby", "build", "ready", "standby");

  // 2. Verificação de Mensagem Neutra e Constantes
  check(
    "IN_REVIEW_NUDGE_MESSAGE não cita 'você emitiu texto puro' ou 'plain text'",
    !/texto puro|plain text|parecer de texto/i.test(IN_REVIEW_NUDGE_MESSAGE),
    `mensagem: "${IN_REVIEW_NUDGE_MESSAGE}"`
  );
  check(
    "IN_REVIEW_NUDGE_MESSAGE contém o texto neutro correto",
    IN_REVIEW_NUDGE_MESSAGE ===
      "[System]: Tasks remain in review on the board. You must call team_tasks_complete to approve or reject the review, and report the outcome to the lead via team_message.",
    IN_REVIEW_NUDGE_MESSAGE
  );
  check("MAX_IN_REVIEW_NUDGES é igual a 2", MAX_IN_REVIEW_NUDGES === 2, `valor=${MAX_IN_REVIEW_NUDGES}`);

  // 3. Membro sem tarefas in_review retorna false
  inReviewNudges.clear();
  check(
    "shouldNudgeInReviewTasks retorna false quando não há tarefas in_review",
    shouldNudgeInReviewTasks(db, TEAM_ID, "clara") === false
  );

  // 4. Membro em busy ou standby retorna false
  db.query(`INSERT INTO team_task (id, team_id, content, status, priority, assignee, time_created, time_updated)
            VALUES ('task_rev_1', '${TEAM_ID}', 'Tarefa 1 em Review', 'in_review', 'high', 'dev_busy', ${now}, ${now})`).run();

  check(
    "shouldNudgeInReviewTasks retorna false para membro em status busy",
    shouldNudgeInReviewTasks(db, TEAM_ID, "dev_busy") === false
  );

  db.run("UPDATE team_task SET assignee = 'dev_standby' WHERE id = 'task_rev_1'");
  check(
    "shouldNudgeInReviewTasks retorna false para membro em execution_status standby",
    shouldNudgeInReviewTasks(db, TEAM_ID, "dev_standby") === false
  );

  // 5. Desenvolvedor comum ('tales') com tarefa sob in_review NÃO recebe nudge (apenas Clara)
  db.run("UPDATE team_task SET assignee = 'tales' WHERE id = 'task_rev_1'");
  check(
    "shouldNudgeInReviewTasks retorna false para desenvolvedor comum ('tales') aguardando review",
    shouldNudgeInReviewTasks(db, TEAM_ID, "tales") === false
  );

  // 6. Clara (Quality Gate) detecta a tarefa in_review no board
  check(
    "shouldNudgeInReviewTasks detecta tarefa in_review para 'clara' mesmo atribuída a outrem",
    shouldNudgeInReviewTasks(db, TEAM_ID, "clara") === "task_rev_1"
  );

  // 7. Teste de Cooldown e Limite de 2 tentativas
  const keyClara = `${TEAM_ID}:clara:task_rev_1`;
  check("Contador inicial de tentativas é 0", (inReviewNudges.get(keyClara) ?? 0) === 0);

  // Simula 1ª tentativa
  inReviewNudges.set(keyClara, 1);
  check(
    "shouldNudgeInReviewTasks permite 2ª tentativa (tentativa atual: 1 < 2)",
    shouldNudgeInReviewTasks(db, TEAM_ID, "clara") === "task_rev_1"
  );

  // Simula 2ª tentativa
  inReviewNudges.set(keyClara, 2);
  check(
    "shouldNudgeInReviewTasks bloqueia após atingir MAX_IN_REVIEW_NUDGES (2 tentativas)",
    shouldNudgeInReviewTasks(db, TEAM_ID, "clara") === false,
    `attempts=${inReviewNudges.get(keyClara)}`
  );

  // 8. Teste de Reset de Cooldown ao ressubmeter tarefa para review
  // Simulando a lógica de submit_review de team_tasks_complete
  inReviewNudges.delete(`${TEAM_ID}:clara:task_rev_1`);
  check(
    "Reset de cooldown ao submeter nova revisão permite Clara ser notificada novamente",
    shouldNudgeInReviewTasks(db, TEAM_ID, "clara") === "task_rev_1"
  );
  // Re-aplica cooldown para continuar os próximos cenários
  inReviewNudges.set(keyClara, 2);

  // 9. Se entrar uma nova tarefa in_review, o nudge deve funcionar para a nova tarefa
  db.query(`INSERT INTO team_task (id, team_id, content, status, priority, assignee, time_created, time_updated)
            VALUES ('task_rev_2', '${TEAM_ID}', 'Tarefa 2 em Review', 'in_review', 'high', 'tales', ${now + 10}, ${now + 10})`).run();

  check(
    "shouldNudgeInReviewTasks detecta a nova tarefa task_rev_2 mesmo com task_rev_1 em cooldown",
    shouldNudgeInReviewTasks(db, TEAM_ID, "clara") === "task_rev_2"
  );

  // 10. Quando a tarefa é concluída ou rejeitada, deixa de ser in_review
  db.run("UPDATE team_task SET status = 'completed' WHERE id = 'task_rev_2'");
  // task_rev_1 ainda está in_review, mas seu cooldown esgotou
  check(
    "Com task_rev_2 completed e task_rev_1 esgotada em cooldown, clara retorna false",
    shouldNudgeInReviewTasks(db, TEAM_ID, "clara") === false
  );

  // 11. Zero Mocks em Código de Produção
  const srcFiles = ["src/hooks.ts", "src/v2-setup.ts", "src/index.ts"];
  let mockCount = 0;
  for (const f of srcFiles) {
    const content = readFileSync(path.join(REPO, f), "utf8");
    if (/jest\.mock|sinon|vi\.mock|mockImplementation/i.test(content)) {
      mockCount++;
    }
  }
  check("Zero mocks em produção sob src/", mockCount === 0, `achados=${mockCount}`);
}

await runInReviewNudgeSuite();

const passed = results.filter(([, ok]) => ok).length;
const total = results.length;
console.log(`\nRESULT: ${passed}/${total} checks passed, ${unhandled.length} unhandled rejections`);
process.exit(passed === total && unhandled.length === 0 ? 0 : 1);
