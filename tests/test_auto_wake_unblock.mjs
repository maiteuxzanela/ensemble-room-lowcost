#!/usr/bin/env node
/**
 * QUALITY GATE DETERMINÍSTICO — Auto-Wake no fechamento do board (pool plano)
 * @maiteuxzanela/ensemble-room-lowcost
 *
 * Guardiã: Clara (Quality Gate).
 *
 * TICKET-HARNESS-51 — o board é um pool plano, totalmente paralelo:
 *   - executeTeamTasksAdd      -> src/tools/team-tasks-add.ts: TODA tarefa nasce
 *     'pending' (a flag legada `sequential` é inerte; sem `depends_on`/`blocked`).
 *   - executeTeamSpawn         -> src/tools/team-spawn.ts: reivindicar uma tarefa
 *     pending NÃO força standby.
 *   - executeTeamTasksComplete -> src/tools/team-tasks-complete.ts: concluir uma
 *     tarefa NÃO desbloqueia dependentes nem acorda ninguém. O ÚNICO auto-wake
 *     por board é o fechamento total (board-close) do lead.
 */

import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";

const REPO = path.resolve(import.meta.dirname, "..");
const PKG = process.env.ENSEMBLE_PKG || REPO;
const DIST = path.join(PKG, "dist/index.js");
const TMP = path.join(REPO, ".test-scratch");
mkdirSync(TMP, { recursive: true });
const HARNESS = path.join(TMP, "_auto_wake_harness.mjs");
const ROOT = path.join(TMP, "auto_wake_suite");

const TEAM_ID = "team_auto";
const LEAD_SESSION = "ses_lead";

const results = [];
const check = (name, ok, detail) => {
  results.push([name, ok]);
  console.log(`${ok ? "PASS" : "FAIL"} | ${name}${detail ? " | " + detail : ""}`);
};

const unhandled = [];
process.on("unhandledRejection", (e) => unhandled.push(e));

const REQUIRED_SYMBOLS = ["createDb", "executeTeamTasksAdd", "executeTeamTasksComplete", "executeTeamSpawn", "MemberRegistry", "ProgressTracker", "DEFAULT_CONFIG"];
const distRaw = readFileSync(DIST, "utf8");
{
  const missing = REQUIRED_SYMBOLS.filter(
    (s) => !new RegExp(`(function|class|var|const|let)\\s+${s}\\b`).test(distRaw),
  );
  check(
    "dist declara todos os símbolos exigidos",
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
const { createDb, executeTeamTasksAdd, executeTeamTasksComplete, executeTeamSpawn, MemberRegistry, ProgressTracker, DEFAULT_CONFIG } = mods;

function mockClient() {
  const calls = { create: [], promptAsync: [] };
  return {
    calls,
    client: {
      session: {
        create: async (o) => {
          calls.create.push(o);
          return { data: { id: `ses_${o.name}` } };
        },
        promptAsync: async (o) => {
          calls.promptAsync.push(o);
          return {};
        }
      },
      tui: {
        showToast: async () => {}
      }
    }
  };
}

async function runSuite() {
  rmSync(ROOT, { recursive: true, force: true });
  mkdirSync(ROOT, { recursive: true });
  const db = createDb(path.join(ROOT, "ensemble.db"));

  db.query("INSERT INTO project (id, name, path, status, time_created, time_updated) VALUES ('default', 'Default Project', '', 'active', 0, 0) ON CONFLICT DO NOTHING").run();
  db.query("INSERT INTO team (id, name, project_id, lead_session_id, status, delegate, time_created, time_updated, lead_agent) VALUES ('team_auto', 'tauto', 'default', 'ses_lead', 'active', 0, 0, 0, 'build') ON CONFLICT DO NOTHING").run();

  const registry = new MemberRegistry();
  registry.register(LEAD_SESSION, "lead", "team_auto");

  const mc = mockClient();
  const progressTracker = new ProgressTracker();
  const deps = {
    db,
    directory: ROOT,
    client: mc.client,
    registry,
    config: DEFAULT_CONFIG,
    progressTracker
  };

  // 1. Pool plano: `sequential: true` é inerte — ambas nascem pending, sem DAG.
  await executeTeamTasksAdd(deps, {
    tasks: [
      { content: "Task 1", priority: "medium" },
      { content: "Task 2", priority: "medium" }
    ],
    sequential: true
  }, LEAD_SESSION);

  const tasks = db.query("SELECT * FROM team_task WHERE team_id = ? ORDER BY time_created ASC").all(TEAM_ID);
  const t1 = tasks[0];
  const t2 = tasks[1];

  check("Task 1 nasce pending", t1.status === "pending");
  check("Task 2 nasce pending (sequential não encadeia)", t2.status === "pending", `status=${t2.status}`);
  check("Nenhuma tarefa tem depends_on (coluna expurgada)", t1.depends_on === undefined && t2.depends_on === undefined);
  check("Nenhuma tarefa nasce 'blocked'", t1.status !== "blocked" && t2.status !== "blocked");

  // 2. Worker2 reivindica a Task 2 no spawn (pending -> in_progress), SEM standby.
  await executeTeamSpawn(deps, {
    name: "worker2",
    agent: "build",
    claim_task: t2.id,
    prompt: "Faca a task 2"
  }, LEAD_SESSION);
  registry.register("ses_worker2", "worker2", TEAM_ID);
  db.run("UPDATE team_member SET session_id = 'ses_worker2' WHERE name = 'worker2'");

  const worker_before = db.query("SELECT * FROM team_member WHERE team_id = ? AND name = 'worker2'").get(TEAM_ID);
  check("Worker2 nasce busy/starting (não standby)", worker_before.status === "busy" && worker_before.execution_status === "starting", `${worker_before.status}/${worker_before.execution_status}`);
  check("Worker2 NÃO possui spawn_context", worker_before.spawn_context === null);

  const t2_updated = db.query("SELECT * FROM team_task WHERE id = ?").get(t2.id);
  check("Task 2 reivindicada no spawn passa a in_progress", t2_updated.status === "in_progress" && t2_updated.assignee === "worker2", `${t2_updated.status}/${t2_updated.assignee}`);

  // Resetar mockClient para avaliar o auto-wake por board.
  mc.calls.promptAsync = [];

  // 3. Concluir a Task 1 NÃO desbloqueia dependentes nem acorda ninguém.
  const completeMsg = await executeTeamTasksComplete(deps, { task_id: t1.id }, LEAD_SESSION);
  check("Mensagem de complete NÃO menciona desbloqueio/wake", !completeMsg.includes("unblocked") && !completeMsg.includes("woke"), completeMsg);
  check("Mensagem de complete confirma a conclusão", completeMsg.includes("Completed task"), completeMsg);

  // 4. Task 2 permanece in_progress intocada (pool plano: sem dependência).
  const t2_final = db.query("SELECT * FROM team_task WHERE id = ?").get(t2.id);
  check("Task 2 permanece in_progress e atribuída ao worker2", t2_final.status === "in_progress" && t2_final.assignee === "worker2", `${t2_final.status}/${t2_final.assignee}`);

  // 5. Nenhum wake disparado ao concluir 1 de 2 tarefas (board ainda aberto).
  check("ZERO promptAsync ao concluir 1 de 2 tarefas", mc.calls.promptAsync.length === 0, `chamadas=${mc.calls.promptAsync.length}`);

  // 6. Fechar a Task 2 (worker2) esvazia o board -> board-close wake do lead.
  const completeMsg2 = await executeTeamTasksComplete(deps, { task_id: t2.id }, "ses_worker2");
  check("Task 2 concluída pelo worker2", completeMsg2.includes("Completed task"), completeMsg2);

  const leadWakes = mc.calls.promptAsync.filter(c => c.sessionID === LEAD_SESSION);
  check("board-close: EXATAMENTE 1 promptAsync para o lead", leadWakes.length === 1, `chamadas=${leadWakes.length}`);
  check(
    "board-close: texto canônico do wake do lead",
    leadWakes[0]?.synthetic === true && leadWakes[0]?.parts?.[0]?.text === "[System: All team tasks completed on board by worker2]",
    leadWakes[0]?.parts?.[0]?.text,
  );
}

await runSuite();

const passed = results.filter(([, ok]) => ok).length;
const total = results.length;
console.log(`\nRESULT: ${passed}/${total} checks passed, ${unhandled.length} unhandled rejections`);
process.exit(passed === total && unhandled.length === 0 ? 0 : 1);
