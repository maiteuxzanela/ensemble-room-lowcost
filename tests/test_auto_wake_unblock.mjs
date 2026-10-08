#!/usr/bin/env node
/**
 * QUALITY GATE DETERMINÍSTICO — Auto-Wake de subagentes
 * @hueyexe/opencode-ensemble@0.18.0
 *
 * Guardiã: Clara (Quality Gate).
 *
 * Sob teste:
 *   - executeTeamTasksComplete -> src/tools/team-tasks-complete.ts
 */

import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

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

const REQUIRED_SYMBOLS = ["createDb", "executeTeamTasksAdd", "executeTeamTasksComplete", "executeTeamSpawn", "MemberRegistry", "DEFAULT_CONFIG"];
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
const { createDb, executeTeamTasksAdd, executeTeamTasksComplete, executeTeamSpawn, MemberRegistry, DEFAULT_CONFIG } = mods;

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
  const deps = {
    db,
    directory: ROOT,
    client: mc.client,
    registry,
    config: DEFAULT_CONFIG
  };

  // 1. Validar team_tasks_add sequencial automático
  await executeTeamTasksAdd(deps, {
    tasks: [
      { content: "Task 1", priority: "medium" },
      { content: "Task 2", priority: "medium" }
    ]
  }, LEAD_SESSION);
  
  const tasks = db.query("SELECT * FROM team_task WHERE team_id = ? ORDER BY time_created ASC").all(TEAM_ID);
  const t1 = tasks[0];
  const t2 = tasks[1];
  
  check("Task 1 inicia com status pending", t1.status === "pending");
  check("Task 2 inicia com status blocked", t2.status === "blocked");
  
  // 2. Criar subagente worker2 atribuído à Task 2, em standby automático (já validado no outro teste, mas faremos de novo)
  await executeTeamSpawn(deps, {
    name: "worker2",
    agent: "build",
    claim_task: t2.id,
    prompt: "Faca a task 2"
  }, LEAD_SESSION);
  registry.register("ses_worker2", "worker2", TEAM_ID);
  // Manualmente definir a sessão do membro no banco
  db.run("UPDATE team_member SET session_id = 'ses_worker2' WHERE name = 'worker2'");

  const worker_before = db.query("SELECT * FROM team_member WHERE team_id = ? AND name = 'worker2'").get(TEAM_ID);
  check("Worker2 nasce em standby", worker_before.execution_status === "standby");
  check("Worker2 possui spawn_context", worker_before.spawn_context !== null);

  const t2_updated = db.query("SELECT * FROM team_task WHERE id = ?").get(t2.id);
  check("Task 2 pré-atribuída ao worker2", t2_updated.assignee === "worker2");

  // Resetar mockClient para avaliar o promptAsync
  mc.calls.promptAsync = [];

  // 3. Concluir a Task 1 (que bloqueava a Task 2)
  const completeMsg = await executeTeamTasksComplete(deps, { task_id: t1.id }, LEAD_SESSION);
  
  check("Mensagem de complete reflete unblock e wake", completeMsg.includes("unblocked 1 task") && completeMsg.includes("woke 1 member"));

  // 4. Validar se a Task 2 ficou pending
  const t2_final = db.query("SELECT * FROM team_task WHERE id = ?").get(t2.id);
  check("Task 2 foi desbloqueada para pending", t2_final.status === "pending");

  // 5. Validar se o Worker2 foi acordado
  const worker_final = db.query("SELECT * FROM team_member WHERE team_id = ? AND name = 'worker2'").get(TEAM_ID);
  check("Worker2 execution_status mudou para starting", worker_final.execution_status === "starting");
  
  // Validar se o promptAsync disparou
  const wakes = mc.calls.promptAsync.filter(c => c.sessionID === "ses_worker2" && c.synthetic === true);
  check("promptAsync disparado para worker2", wakes.length === 1);
  const wakePrompt = wakes[0].parts[0].text;
  check("promptAsync inclui spawn_context", wakePrompt.includes("Faca a task 2"));
  check("promptAsync inclui system note de unblock", wakePrompt.includes("was unblocked and is ready"));
}

await runSuite();

const passed = results.filter(([, ok]) => ok).length;
const total = results.length;
console.log(`\nRESULT: ${passed}/${total} checks passed, ${unhandled.length} unhandled rejections`);
process.exit(passed === total && unhandled.length === 0 ? 0 : 1);
