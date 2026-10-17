#!/usr/bin/env node
/**
 * QUALITY GATE DETERMINÍSTICO — Runtime Standby & Pool Plano
 * @maiteuxzanela/ensemble-room-lowcost
 *
 * Guardiã: Clara (Quality Gate & Integridade dos Testes).
 *
 * TICKET-HARNESS-51 — o board é um pool plano, totalmente paralelo (sem
 * `depends_on`, sem 'blocked', sem desbloqueio de dependentes).
 *
 * Sob teste:
 *   - team_claim defensivo no pool plano (pending -> in_progress, lock atômico,
 *     concorrência rejeitada, idempotência)
 *   - team_standby nativo (suspensão voluntária com execution_status='standby',
 *     status='ready', spawn_context=null a 0 tokens)
 *   - team-tasks-complete: concluir uma tarefa NÃO desbloqueia nem acorda
 *     ninguém; o único auto-wake por board é o fechamento total (board-close)
 *   - wake de review do SDET com consumo da janela de standby + rollback
 *     fail-safe em falha de transporte
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
  let failSession = null;

  return {
    calls,
    failFor: (ses) => { failSession = ses; },
    client: {
      session: {
        create: async (o) => {
          calls.create.push(o);
          return { data: { id: `ses_${o.name}` } };
        },
        promptAsync: async (o) => {
          calls.promptAsync.push(o);
          if (failSession && o.sessionID === failSession) {
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
  check("Migration 19 (pool plano) aplicada com sucesso", userVersion === MIGRATIONS.length && userVersion >= 19, `user_version=${userVersion}`);

  // Setup de projeto e equipe
  db.query("INSERT INTO project (id, name, path, status, time_created, time_updated) VALUES ('default', 'Default Project', '', 'active', 0, 0) ON CONFLICT DO NOTHING").run();
  db.query(`INSERT INTO team (id, name, project_id, lead_session_id, status, delegate, time_created, time_updated, lead_agent)
            VALUES ('${TEAM_ID}', 'runtime-standby-team', 'default', '${LEAD_SESSION}', 'active', 0, 0, 0, 'build')
            ON CONFLICT DO NOTHING`).run();

  // NOTE: the lead is deliberately NOT registered as a team_member — it is
  // resolved from team.lead_session_id (SQLite fallback), so team_standby can
  // prove the lead is rejected. Registering it as a member would mask the
  // role and fall through to a "member not found" error instead.
  const registry = new MemberRegistry();
  registry.register(TEAM_ID, "bob", BOB_SESSION);
  registry.register(TEAM_ID, "alice", ALICE_SESSION);

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

  const tc = createTestClient();
  const deps = {
    db,
    directory: ROOT,
    client: tc.client,
    registry,
    config: DEFAULT_CONFIG,
  };

  /* ------------------------------------------------------------------ *
   * CENÁRIO 1: team_claim no pool plano (sem 'blocked'/'depends_on')
   * ------------------------------------------------------------------ */
  console.log("\n--- CENÁRIO 1: team_claim no pool plano ---");

  // TICKET-HARNESS-51: `sequential: true` é inerte — ambas nascem pending.
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

  check("Task 1 nasce pending", task1.status === "pending");
  check("Task 2 nasce pending (sequential não encadeia)", task2.status === "pending", `status=${task2.status}`);
  check("Task 2 não possui depends_on (coluna expurgada)", task2.depends_on === undefined);
  check("Nenhuma tarefa nasce 'blocked'", task1.status !== "blocked" && task2.status !== "blocked");

  // Bob reivindica a Task 2 — pending -> in_progress atômico.
  const bobClaimResult = await executeTeamClaim(deps, { task_id: task2.id }, BOB_SESSION);
  check("executeTeamClaim reivindica a tarefa pending", bobClaimResult.includes("Claimed task:"), bobClaimResult);

  const task2AfterBob = db.query("SELECT * FROM team_task WHERE id = ?").get(task2.id);
  check("Task 2 transiciona para 'in_progress'", task2AfterBob.status === "in_progress", `status=${task2AfterBob.status}`);
  check("Task 2 registra o assignee 'bob'", task2AfterBob.assignee === "bob", `assignee=${task2AfterBob.assignee}`);

  // Alice tenta reivindicar a mesma Task 2 já reivindicada
  let aliceClaimThrew = false;
  let aliceClaimError = "";
  try {
    await executeTeamClaim(deps, { task_id: task2.id }, ALICE_SESSION);
  } catch (err) {
    aliceClaimThrew = true;
    aliceClaimError = err instanceof Error ? err.message : String(err);
  }
  check(
    "executeTeamClaim rejeita concorrência na mesma tarefa",
    aliceClaimThrew && aliceClaimError.includes("already claimed by bob"),
    aliceClaimError,
  );

  // Bob re-reivindica de forma idempotente.
  const bobReclaim = await executeTeamClaim(deps, { task_id: task2.id }, BOB_SESSION);
  check(
    "team_claim idempotente informa que a tarefa já está sob responsabilidade do Bob",
    bobReclaim.includes("already in progress and assigned to you"),
    bobReclaim,
  );

  // Verificação direta de claimTask API
  let claimTaskThrewNotFound = false;
  try {
    claimTask(db, TEAM_ID, "task_inexistente", "bob");
  } catch {
    claimTaskThrewNotFound = true;
  }
  check("claimTask lança erro se tarefa não existe", claimTaskThrewNotFound);

  /* ------------------------------------------------------------------ *
   * CENÁRIO 2: Pool plano — concluir uma tarefa não desbloqueia/acorda
   * ------------------------------------------------------------------ */
  console.log("\n--- CENÁRIO 2: conclusão no pool plano (sem desbloqueio) ---");

  tc.calls.promptAsync = [];

  // Alice conclui a Task 1 (independente da Task 2).
  const completeResult = await executeTeamTasksComplete(deps, { task_id: task1.id }, ALICE_SESSION);
  check("Mensagem de complete confirma a conclusão", completeResult.includes("Completed task"), completeResult);
  check(
    "Mensagem de complete NÃO menciona desbloqueio/wake",
    !completeResult.includes("unblocked") && !completeResult.includes("woke"),
    completeResult,
  );

  const task2AfterComplete = db.query("SELECT * FROM team_task WHERE id = ?").get(task2.id);
  check("Task 2 permanece 'in_progress' (independente)", task2AfterComplete.status === "in_progress", `status=${task2AfterComplete.status}`);
  check("Task 2 preserva o assignee 'bob'", task2AfterComplete.assignee === "bob", `assignee=${task2AfterComplete.assignee}`);
  check("ZERO promptAsync ao concluir 1 de 2 tarefas", tc.calls.promptAsync.length === 0, `chamadas=${tc.calls.promptAsync.length}`);

  // Bob conclui a Task 2 -> board fecha -> board-close wake do lead.
  const completeMsg2 = await executeTeamTasksComplete(deps, { task_id: task2.id }, BOB_SESSION);
  check("Task 2 concluída pelo Bob", completeMsg2.includes("Completed task"), completeMsg2);

  const leadWakes = tc.calls.promptAsync.filter((c) => c.sessionID === LEAD_SESSION);
  check("board-close: EXATAMENTE 1 promptAsync para o lead", leadWakes.length === 1, `chamadas=${leadWakes.length}`);
  check(
    "board-close: texto canônico do wake do lead",
    leadWakes[0]?.synthetic === true && leadWakes[0]?.parts?.[0]?.text === "[System: All team tasks completed on board by bob]",
    leadWakes[0]?.parts?.[0]?.text,
  );

  /* ------------------------------------------------------------------ *
   * CENÁRIO 3: Invocação de team_standby e suspensão voluntária a 0 tokens
   * ------------------------------------------------------------------ */
  console.log("\n--- CENÁRIO 3: Invocação voluntária de team_standby a 0 tokens ---");

  tc.calls.promptAsync = [];

  const standbyResult = await executeTeamStandby(
    deps,
    { reason: "Aguardando novas mensagens da sala" },
    BOB_SESSION,
  );

  check(
    "executeTeamStandby retorna confirmação de suspensão",
    standbyResult.includes("Entered standby mode") && standbyResult.includes("Execution suspended until a new message arrives"),
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
  } catch {
    setStandbyThrew = true;
  }
  check("setMemberStandby lança erro para membro inexistente", setStandbyThrew);

  /* ------------------------------------------------------------------ *
   * CENÁRIO 4: Wake de review do SDET + consumo de standby + rollback
   * ------------------------------------------------------------------ */
  console.log("\n--- CENÁRIO 4: wake do SDET, consumo de standby e rollback ---");

  const seedTeam = (id, name, lead) =>
    db.run(
      "INSERT INTO team (id, name, project_id, lead_session_id, status, delegate, time_created, time_updated, lead_agent) VALUES (?, ?, 'default', ?, 'active', 0, ?, ?, 'build')",
      [id, name, lead, now, now],
    );
  const seedMember = (teamId, name, ses, agent, exec = "idle", ctx = null) => {
    db.run(
      `INSERT INTO team_member (team_id, name, session_id, agent, status, execution_status, spawn_context, time_created, time_updated, reported_to_lead)
       VALUES (?, ?, ?, ?, 'ready', ?, ?, ?, ?, 0)`,
      [teamId, name, ses, agent, exec, ctx, now, now],
    );
    registry.register(teamId, name, ses);
  };

  // 4a. Wake do SDET consumindo a janela de standby (prepend de spawn_context).
  const A = "team_standby_wake";
  seedTeam(A, "standby-wake-team", "ses_lead_a");
  seedMember(A, "tulio", "ses_tulio_a", "build");
  seedMember(A, "hugo", "ses_hugo_a", "hugo", "standby", "SDET_BIRTH_CTX");
  const addA = await executeTeamTasksAdd(deps, { tasks: [{ content: "TASK-A", priority: "high" }] }, "ses_lead_a");
  const tA = addA.match(/Added \d+ tasks?: (.+)/)?.[1]?.trim();
  await executeTeamClaim(deps, { task_id: tA }, "ses_tulio_a");
  tc.calls.promptAsync = [];
  const subA = await executeTeamTasksComplete(deps, { task_id: tA, action: "submit_review", notes: "PR pronto" }, "ses_tulio_a");
  check("4a submit_review notifica o SDET", subA.includes("(notified hugo for deterministic tests)"), subA);
  const hugoWakes = tc.calls.promptAsync.filter((c) => c.sessionID === "ses_hugo_a");
  check("4a SDET woken (1 wake)", hugoWakes.length === 1, `chamadas=${hugoWakes.length}`);
  check(
    "4a wake do SDET = spawn_context prepend + handover",
    hugoWakes[0]?.synthetic === true
      && hugoWakes[0]?.agent === "hugo"
      && String(hugoWakes[0]?.parts?.[0]?.text).startsWith("SDET_BIRTH_CTX\n\n[System: Task")
      && String(hugoWakes[0]?.parts?.[0]?.text).includes("SDET handover"),
    hugoWakes[0]?.parts?.[0]?.text,
  );
  const hugoA = db.query("SELECT execution_status FROM team_member WHERE team_id = ? AND name = 'hugo'").get(A);
  check("4a SDET transiciona standby -> starting", hugoA.execution_status === "starting", `exec=${hugoA.execution_status}`);

  // 4b. Rollback fail-safe: falha de transporte reverte o standby.
  const B = "team_standby_rollback";
  seedTeam(B, "standby-rollback-team", "ses_lead_b");
  seedMember(B, "tulio", "ses_tulio_b", "build");
  seedMember(B, "hugo", "ses_hugo_b", "hugo", "standby", "ROLLBACK_CTX");
  const addB = await executeTeamTasksAdd(deps, { tasks: [{ content: "TASK-B", priority: "high" }] }, "ses_lead_b");
  const tB = addB.match(/Added \d+ tasks?: (.+)/)?.[1]?.trim();
  await executeTeamClaim(deps, { task_id: tB }, "ses_tulio_b");
  tc.failFor("ses_hugo_b");
  await executeTeamTasksComplete(deps, { task_id: tB, action: "submit_review", notes: "rollback" }, "ses_tulio_b");
  await new Promise((resolve) => setTimeout(resolve, 60));
  const hugoB = db.query("SELECT execution_status FROM team_member WHERE team_id = ? AND name = 'hugo'").get(B);
  check("4b rollback fail-safe: SDET revertido para 'standby'", hugoB.execution_status === "standby", `exec=${hugoB.execution_status}`);
  tc.failFor(null);

  /* ------------------------------------------------------------------ *
   * CENÁRIO 5: Contrato do Teammate System Prompt (pool plano)
   * ------------------------------------------------------------------ */
  console.log("\n--- CENÁRIO 5: Contrato do Teammate System Prompt ---");

  const promptText = buildTeammateSystemPrompt(db, TEAM_ID, "bob", DEFAULT_CONFIG);
  check("Prompt contém seção ANTI-POLLING & EVENT-DRIVEN CONTRACT", promptText.includes("ANTI-POLLING & EVENT-DRIVEN CONTRACT:"));
  check("Prompt proíbe polling em loops no board", promptText.includes("Do NOT poll team_tasks_list or team_status in loops"));
  check("Prompt declara o pool plano (tarefa independente reivindicável)", promptText.includes("every board task is independent and ready to claim with team_claim"));
  check("Prompt declara a ausência de DAG/bloqueio", promptText.includes("there is no task-blocking or DAG sequencing"));
  check("Prompt garante auto-wake pelo runtime", promptText.includes("The runtime automatically wakes you with a synthetic system prompt"));

  // resolveStandbyWake é exportado e resolve o prepend do spawn_context.
  check("resolveStandbyWake é uma função exportada", typeof resolveStandbyWake === "function");
}

await runSuite();

const passed = results.filter(([, ok]) => ok).length;
const total = results.length;
console.log(`\nRESULT: ${passed}/${total} checks passed, ${unhandled.length} unhandled rejections`);
process.exit(passed === total && unhandled.length === 0 ? 0 : 1);
