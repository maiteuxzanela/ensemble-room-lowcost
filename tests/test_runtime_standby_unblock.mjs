#!/usr/bin/env node
/**
 * QUALITY GATE DETERMINÍSTICO — Runtime Standby & Auto-Wake Unblock
 * @hueyexe/opencode-ensemble@0.18.1
 *
 * Guardiã: Clara (Quality Gate & Integridade dos Testes).
 *
 * Sob teste:
 *   - team_claim defensivo em status 'blocked' (lock atômico de pré-atribuição e retorno yield/standby)
 *   - team_standby nativo (suspensão voluntária com execution_status='standby', status='ready', spawn_context=null a 0 tokens)
 *   - auto-wake reativo em team-tasks-complete (desbloqueio de tarefas dependentes acordando o membro em standby)
 *   - fallback de auto-wake para membro livre em standby
 *   - rollback fail-safe de status em falha de transporte no despertar
 *   - contrato anti-polling em buildTeammateSystemPrompt
 *
 * Regras:
 *   - SEM MOCKS em código de produção src/
 *   - SQLite real (node:sqlite DatabaseSync)
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
const HARNESS = path.join(TMP, "_runtime_standby_harness.mjs");
const ROOT = path.join(TMP, "runtime_standby_suite");

const TEAM_ID = "team_runtime_standby";
const LEAD_SESSION = "ses_lead";
const BOB_SESSION = "ses_bob";
const ALICE_SESSION = "ses_alice";
const CHARLIE_SESSION = "ses_charlie";
const DAVE_SESSION = "ses_dave";

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
  "claimTask",
  "executeTeamStandby",
  "setMemberStandby",
  "executeTeamSpawn",
  "resolveStandbyWake",
  "buildTeammateSystemPrompt",
  "MemberRegistry",
  "DEFAULT_CONFIG",
  "MIGRATIONS",
];

const distRaw = readFileSync(DIST, "utf8");
{
  const missing = REQUIRED_SYMBOLS.filter(
    (s) => !new RegExp(`(function|class|var|const|let)\\s+${s}\\b`).test(distRaw),
  );
  check(
    "dist declara todos os símbolos exigidos pela suíte de runtime standby",
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
  claimTask,
  executeTeamStandby,
  setMemberStandby,
  resolveStandbyWake,
  buildTeammateSystemPrompt,
  MemberRegistry,
  DEFAULT_CONFIG,
  MIGRATIONS,
} = mods;

/* ================================================================== *
 * 1. ZERO MOCKS EM PRODUÇÃO
 * ================================================================== */
{
  const grep = spawnSync("git", ["grep", "-n", "-E", "(jest\\.mock|sinon|unittest\\.mock|vitest|createMock|fakeStub)", "src/"], {
    cwd: REPO,
    encoding: "utf8",
  });
  check("Zero mocks ou spies em código de produção", grep.stdout.trim() === "", `achados=${grep.stdout.trim().split("\n").filter(Boolean).length}`);
}

/* ================================================================== *
 * 2. CLIENTE DETERMINÍSTICO (COMMUNICATION ADAPTER)
 * ================================================================== */
function createTestClient() {
  const calls = {
    create: [],
    promptAsync: [],
    toasts: [],
  };
  let shouldFailPromptAsync = false;

  return {
    calls,
    setShouldFailPromptAsync: (fail) => {
      shouldFailPromptAsync = fail;
    },
    client: {
      session: {
        create: async (o) => {
          calls.create.push(o);
          return { data: { id: `ses_${o.name}` } };
        },
        promptAsync: async (o) => {
          calls.promptAsync.push(o);
          if (shouldFailPromptAsync && o.sessionID === DAVE_SESSION) {
            throw new Error("Simulated network transport failure during wake");
          }
          return {};
        },
      },
      tui: {
        showToast: async (t) => {
          calls.toasts.push(t);
        },
      },
    },
  };
}

/* ================================================================== *
 * 3. EXECUÇÃO INTEGRADA DOS CENÁRIOS
 * ================================================================== */
async function runSuite() {
  rmSync(ROOT, { recursive: true, force: true });
  mkdirSync(ROOT, { recursive: true });

  const dbPath = path.join(ROOT, "ensemble.db");
  const db = createDb(dbPath);

  const userVersion = db.query("PRAGMA user_version").get().user_version;
  check("Migration 13 aplicada com sucesso", userVersion === MIGRATIONS.length, `user_version=${userVersion}`);

  // Setup de projeto e equipe
  db.query("INSERT INTO project (id, name, path, status, time_created, time_updated) VALUES ('default', 'Default Project', '', 'active', 0, 0) ON CONFLICT DO NOTHING").run();
  db.query(`INSERT INTO team (id, name, project_id, lead_session_id, status, delegate, time_created, time_updated, lead_agent)
            VALUES ('${TEAM_ID}', 'runtime-standby-team', 'default', '${LEAD_SESSION}', 'active', 0, 0, 0, 'build')
            ON CONFLICT DO NOTHING`).run();

  const registry = new MemberRegistry();
  registry.register(LEAD_SESSION, "lead", TEAM_ID);
  registry.register(BOB_SESSION, "bob", TEAM_ID);
  registry.register(ALICE_SESSION, "alice", TEAM_ID);
  registry.register(CHARLIE_SESSION, "charlie", TEAM_ID);
  registry.register(DAVE_SESSION, "dave", TEAM_ID);

  const now = Date.now();
  // Registrar membros na tabela team_member
  const insertMember = (name, sessionId, agent = "build") => {
    db.run(
      `INSERT INTO team_member (team_id, name, session_id, agent, status, execution_status, time_created, time_updated, reported_to_lead)
       VALUES (?, ?, ?, ?, 'busy', 'running', ?, ?, 0)`,
      [TEAM_ID, name, sessionId, agent, now, now],
    );
  };

  insertMember("bob", BOB_SESSION);
  insertMember("alice", ALICE_SESSION);
  insertMember("charlie", CHARLIE_SESSION);
  insertMember("dave", DAVE_SESSION);

  const tc = createTestClient();
  const deps = {
    db,
    directory: ROOT,
    client: tc.client,
    registry,
    config: DEFAULT_CONFIG,
  };

  /* ------------------------------------------------------------------ *
   * CENÁRIO 1: team_claim defensivo em tarefas bloqueadas ('blocked')
   * ------------------------------------------------------------------ */
  console.log("\n--- CENÁRIO 1: team_claim defensivo em tarefas com status 'blocked' ---");

  // Adicionar duas tarefas com dependência sequencial
  await executeTeamTasksAdd(
    deps,
    {
      tasks: [
        { content: "Tarefa 1: Implementar Contrato", priority: "high" },
        { content: "Tarefa 2: Validar Standby em Runtime", priority: "high" },
      ],
      sequential: true,
    },
    LEAD_SESSION,
  );

  const tasksC1 = db.query("SELECT * FROM team_task WHERE team_id = ? ORDER BY time_created ASC").all(TEAM_ID);
  const task1 = tasksC1[0];
  const task2 = tasksC1[1];

  check("Task 1 inicia como pending", task1.status === "pending");
  check("Task 2 inicia como blocked", task2.status === "blocked");
  check("Task 2 depende de Task 1", task2.depends_on.includes(task1.id));

  // Bob tenta reivindicar a Task 2 (que está blocked)
  const bobClaimResult = await executeTeamClaim(deps, { task_id: task2.id }, BOB_SESSION);

  check(
    "executeTeamClaim em blocked retorna aviso instrutivo sem lançar exceção",
    bobClaimResult.includes("Pre-claimed blocked task") &&
      bobClaimResult.includes("team_standby") &&
      bobClaimResult.includes("automatically wake you"),
    bobClaimResult,
  );

  const task2AfterBob = db.query("SELECT * FROM team_task WHERE id = ?").get(task2.id);
  check("Task 2 mantém status 'blocked' após pre-claim", task2AfterBob.status === "blocked");
  check("Task 2 recebe lock atômico de pré-atribuição para 'bob'", task2AfterBob.assignee === "bob");

  // Alice tenta reivindicar a mesma Task 2 já pré-atribuída
  let aliceClaimThrew = false;
  let aliceClaimError = "";
  try {
    await executeTeamClaim(deps, { task_id: task2.id }, ALICE_SESSION);
  } catch (err) {
    aliceClaimThrew = true;
    aliceClaimError = err instanceof Error ? err.message : String(err);
  }
  check(
    "executeTeamClaim rejeita concorrência na mesma tarefa pré-reivindicada",
    aliceClaimThrew && aliceClaimError.includes("already claimed by bob"),
    aliceClaimError,
  );

  // Verificação direta de claimTask API
  let claimTaskThrewNotFound = false;
  try {
    claimTask(db, TEAM_ID, "task_inexistente", "bob");
  } catch (err) {
    claimTaskThrewNotFound = true;
  }
  check("claimTask lança erro se tarefa não existe", claimTaskThrewNotFound);

  /* ------------------------------------------------------------------ *
   * CENÁRIO 2: Invocação de team_standby e suspensão voluntária a 0 tokens
   * ------------------------------------------------------------------ */
  console.log("\n--- CENÁRIO 2: Invocação voluntária de team_standby a 0 tokens ---");

  tc.calls.promptAsync = [];

  // Bob entra voluntariamente em standby seguindo a instrução
  const standbyResult = await executeTeamStandby(
    deps,
    { reason: "Aguardando conclusão da Tarefa 1 para iniciar a Tarefa 2" },
    BOB_SESSION,
  );

  check(
    "executeTeamStandby retorna confirmação de suspensão",
    standbyResult.includes("Entered standby mode") && standbyResult.includes("Execution suspended until dependencies are unblocked"),
    standbyResult,
  );

  const bobAfterStandby = db.query("SELECT * FROM team_member WHERE team_id = ? AND name = 'bob'").get(TEAM_ID);
  check("Bob transiciona execution_status para 'standby'", bobAfterStandby.execution_status === "standby");
  check("Bob transiciona status para 'ready'", bobAfterStandby.status === "ready");
  check("Bob tem spawn_context nulo (runtime standby limpo)", bobAfterStandby.spawn_context === null);
  check("Bob consome ZERO tokens na suspensão (zero chamadas promptAsync)", tc.calls.promptAsync.length === 0);

  // Lead tentando entrar em standby deve ser bloqueado
  let leadStandbyThrew = false;
  let leadStandbyError = "";
  try {
    await executeTeamStandby(deps, {}, LEAD_SESSION);
  } catch (err) {
    leadStandbyThrew = true;
    leadStandbyError = err instanceof Error ? err.message : String(err);
  }
  check(
    "executeTeamStandby proíbe lead de entrar em standby",
    leadStandbyThrew && leadStandbyError.includes("Only teammates can enter standby mode"),
    leadStandbyError,
  );

  // Sessão desconhecida fora do time deve ser bloqueada
  let unknownStandbyThrew = false;
  try {
    await executeTeamStandby(deps, {}, "ses_alien");
  } catch {
    unknownStandbyThrew = true;
  }
  check("executeTeamStandby proíbe sessão fora do time", unknownStandbyThrew);

  // setMemberStandby lança erro para membro inexistente
  let setStandbyThrew = false;
  try {
    setMemberStandby(db, TEAM_ID, "membro_fantasma", "teste");
  } catch (err) {
    setStandbyThrew = true;
  }
  check("setMemberStandby lança erro para membro inexistente", setStandbyThrew);

  /* ------------------------------------------------------------------ *
   * CENÁRIO 3: Auto-wake reativo quando a dependência é concluída
   * ------------------------------------------------------------------ */
  console.log("\n--- CENÁRIO 3: Auto-wake reativo no team-tasks-complete ---");

  tc.calls.promptAsync = [];

  // Alice completa a Tarefa 1 (desbloqueando a Tarefa 2)
  const completeResult = await executeTeamTasksComplete(
    deps,
    { task_id: task1.id },
    ALICE_SESSION,
  );

  check(
    "Mensagem de complete reflete desbloqueio e auto-wake de 1 membro",
    completeResult.includes("unblocked 1 task") && completeResult.includes("woke 1 member"),
    completeResult,
  );

  const task2AfterComplete = db.query("SELECT * FROM team_task WHERE id = ?").get(task2.id);
  check("Task 2 é desbloqueada diretamente para 'in_progress'", task2AfterComplete.status === "in_progress");
  check("Task 2 preserva a pré-atribuição para 'bob'", task2AfterComplete.assignee === "bob");

  const bobAfterWake = db.query("SELECT * FROM team_member WHERE team_id = ? AND name = 'bob'").get(TEAM_ID);
  check("Bob transiciona execution_status para 'starting'", bobAfterWake.execution_status === "starting");

  // Validar envio do promptAsync de despertar para Bob
  const bobPrompts = tc.calls.promptAsync.filter((c) => c.sessionID === BOB_SESSION);
  check("promptAsync foi despachado para Bob", bobPrompts.length === 1);
  const wakePrompt = bobPrompts[0]?.parts?.[0]?.text ?? "";
  check("promptAsync para Bob possui synthetic: true", bobPrompts[0]?.synthetic === true);
  check(
    "promptAsync de Bob contém notificação de unblock limpa",
    wakePrompt.includes(`[System: Task "${task2.id}" was unblocked and is ready for you to start]`),
    wakePrompt,
  );
  check(
    "promptAsync de Bob NÃO contém contexto residual de nascimento",
    !wakePrompt.includes("You are \"bob\"") && !wakePrompt.includes("birth"),
  );

  // Bob acorda e chama executeTeamClaim de forma idempotente sem exceção de tarefa já atribuída
  let bobPostWakeThrew = false;
  let bobPostWakeResult = "";
  try {
    bobPostWakeResult = await executeTeamClaim(deps, { task_id: task2.id }, BOB_SESSION);
  } catch (err) {
    bobPostWakeThrew = true;
    bobPostWakeResult = err?.message ?? String(err);
  }
  check("Bob acordado executa team_claim pós-wake de forma idempotente sem erro", !bobPostWakeThrew, bobPostWakeResult);
  check(
    "team_claim pós-wake informa que a tarefa já está in_progress sob responsabilidade do Bob",
    bobPostWakeResult.includes("already in progress and assigned to you"),
    bobPostWakeResult,
  );

  const task2AfterBobClaim = db.query("SELECT * FROM team_task WHERE id = ?").get(task2.id);
  check("Task 2 permanece 'in_progress' com assignee 'bob' após claim idempotente", task2AfterBobClaim.status === "in_progress" && task2AfterBobClaim.assignee === "bob");

  /* ------------------------------------------------------------------ *
   * CENÁRIO 4: Fallback de auto-wake para membro livre em standby
   * ------------------------------------------------------------------ */
  console.log("\n--- CENÁRIO 4: Fallback de auto-wake para membro livre em standby ---");

  // Criar tarefas 3 e 4: Tarefa 4 sem assignee bloqueada por Tarefa 3
  await executeTeamTasksAdd(
    deps,
    {
      tasks: [
        { content: "Tarefa 3: Preparar Dados", priority: "medium" },
        { content: "Tarefa 4: Processar Pipeline", priority: "medium" },
      ],
      sequential: true,
    },
    LEAD_SESSION,
  );

  const tasksC4 = db.query("SELECT * FROM team_task WHERE team_id = ? AND content LIKE 'Tarefa %' ORDER BY time_created ASC").all(TEAM_ID);
  const task3 = tasksC4[2];
  const task4 = tasksC4[3];

  check("Task 4 não tem assignee inicialmente", task4.assignee === null);
  check("Task 4 está bloqueada", task4.status === "blocked");

  // Colocar Charlie em standby
  setMemberStandby(db, TEAM_ID, "charlie", "Livre aguardando tarefas");
  const charlieStandby = db.query("SELECT execution_status FROM team_member WHERE team_id = ? AND name = 'charlie'").get(TEAM_ID);
  check("Charlie está em standby", charlieStandby.execution_status === "standby");

  tc.calls.promptAsync = [];

  // Concluir Tarefa 3
  const completeT3 = await executeTeamTasksComplete(deps, { task_id: task3.id }, LEAD_SESSION);
  check("Conclusão da Tarefa 3 desbloqueou tarefa e acordou membro", completeT3.includes("unblocked 1 task") && completeT3.includes("woke 1 member"));

  const charlieWoken = db.query("SELECT execution_status FROM team_member WHERE team_id = ? AND name = 'charlie'").get(TEAM_ID);
  check("Charlie foi acordado pelo fallback de membro livre", charlieWoken.execution_status === "starting");

  const charliePrompts = tc.calls.promptAsync.filter((c) => c.sessionID === CHARLIE_SESSION);
  check("promptAsync disparado para Charlie via fallback", charliePrompts.length === 1);
  check(
    "promptAsync de Charlie aponta para o desbloqueio da Task 4",
    charliePrompts[0]?.parts?.[0]?.text?.includes(`[System: Task "${task4.id}" was unblocked and is ready for you to start]`),
  );

  /* ------------------------------------------------------------------ *
   * CENÁRIO 5: Rollback fail-safe em falha de transporte no despertar
   * ------------------------------------------------------------------ */
  console.log("\n--- CENÁRIO 5: Rollback fail-safe em falha de transporte ---");

  // Criar tarefas 5 e 6 com dependência
  await executeTeamTasksAdd(
    deps,
    {
      tasks: [
        { content: "Tarefa 5: Upstream Fail-Safe", priority: "low" },
        { content: "Tarefa 6: Downstream com falha de rede simulada", priority: "low" },
      ],
      sequential: true,
    },
    LEAD_SESSION,
  );

  const tasksC5 = db.query("SELECT * FROM team_task WHERE team_id = ? AND content LIKE 'Tarefa %' ORDER BY time_created ASC").all(TEAM_ID);
  const task5 = tasksC5[4];
  const task6 = tasksC5[5];

  // Dave pré-reivindica a Task 6 e entra em standby
  await executeTeamClaim(deps, { task_id: task6.id }, DAVE_SESSION);
  await executeTeamStandby(deps, { reason: "Aguardando Task 5" }, DAVE_SESSION);

  const daveBefore = db.query("SELECT execution_status FROM team_member WHERE team_id = ? AND name = 'dave'").get(TEAM_ID);
  check("Dave está em standby antes da falha", daveBefore.execution_status === "standby");

  // Armar falha de transporte em promptAsync para Dave
  tc.setShouldFailPromptAsync(true);

  // Concluir Tarefa 5
  const completeT5 = await executeTeamTasksComplete(deps, { task_id: task5.id }, LEAD_SESSION);
  check("Conclusão de Tarefa 5 executada com sucesso apesar do erro de transporte do par", completeT5.includes("Completed task"));

  // Aguardar microtask/tick para o catch assíncrono executar o rollback
  await new Promise((resolve) => setTimeout(resolve, 50));

  const daveAfterFail = db.query("SELECT execution_status FROM team_member WHERE team_id = ? AND name = 'dave'").get(TEAM_ID);
  check("Dave teve execution_status revertido para 'standby' via rollback fail-safe", daveAfterFail.execution_status === "standby");

  /* ------------------------------------------------------------------ *
   * CENÁRIO 6: Contrato do Teammate System Prompt
   * ------------------------------------------------------------------ */
  console.log("\n--- CENÁRIO 6: Contrato do Teammate System Prompt ---");

  const promptText = buildTeammateSystemPrompt(db, TEAM_ID, "bob", DEFAULT_CONFIG);
  check("Prompt contém seção ANTI-POLLING & EVENT-DRIVEN CONTRACT", promptText.includes("ANTI-POLLING & EVENT-DRIVEN CONTRACT:"));
  check("Prompt proíbe polling em loops no board", promptText.includes("Do NOT poll team_tasks_list or team_status in loops"));
  check("Prompt instrui suspensão via team_standby", promptText.includes("enter standby via team_standby"));
  check("Prompt garante auto-wake pelo runtime", promptText.includes("The runtime automatically wakes you with a synthetic system prompt"));
}

await runSuite();

const passed = results.filter(([, ok]) => ok).length;
const total = results.length;
console.log(`\nRESULT: ${passed}/${total} checks passed, ${unhandled.length} unhandled rejections`);
process.exit(passed === total && unhandled.length === 0 ? 0 : 1);
