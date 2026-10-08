#!/usr/bin/env node
/**
 * QUALITY GATE DETERMINÍSTICO — Auto-Sequenciamento e Auto-Standby
 * @hueyexe/opencode-ensemble@0.18.0
 *
 * Guardiã: Clara (Quality Gate).
 *
 * Sob teste:
 *   - executeTeamTasksAdd -> src/tools/team-tasks-add.ts
 *   - executeTeamSpawn    -> src/tools/team-spawn.ts
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
const HARNESS = path.join(TMP, "_auto_standby_harness.mjs");
const ROOT = path.join(TMP, "auto_standby_suite");

const TEAM_ID = "team_auto";
const LEAD_SESSION = "ses_lead";

const results = [];
const check = (name, ok, detail) => {
  results.push([name, ok]);
  console.log(`${ok ? "PASS" : "FAIL"} | ${name}${detail ? " | " + detail : ""}`);
};

const unhandled = [];
process.on("unhandledRejection", (e) => unhandled.push(e));

const REQUIRED_SYMBOLS = ["createDb", "executeTeamTasksAdd", "executeTeamSpawn", "MemberRegistry", "DEFAULT_CONFIG"];
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
const { createDb, executeTeamTasksAdd, executeTeamSpawn, MemberRegistry, DEFAULT_CONFIG } = mods;

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
  const resTasks = await executeTeamTasksAdd(deps, {
    tasks: [
      { content: "Task 0", priority: "medium" },
      { content: "Task 1", priority: "medium" }
    ] // Sem depends_on explicitos, deve encadear automaticamente
  }, LEAD_SESSION);

  check("team_tasks_add rodou sem erro", typeof resTasks === "string");
  
  const tasks = db.query("SELECT * FROM team_task WHERE team_id = ? ORDER BY time_created ASC").all(TEAM_ID);
  check("Duas tasks foram criadas no SQLite", tasks.length === 2);
  
  const t0 = tasks[0];
  const t1 = tasks[1];
  
  check("Task 0 inicia com status pending", t0.status === "pending");
  check("Task 1 inicia com status blocked", t1.status === "blocked", `status=${t1.status}`);
  
  const t1_depends = JSON.parse(t1.depends_on);
  check("Task 1 tem depends_on apontando para Task 0", Array.isArray(t1_depends) && t1_depends.includes(t0.id));

  // 2. Validar auto-standby no spawn para task bloqueada
  const resSpawn = await executeTeamSpawn(deps, {
    name: "membro1",
    agent: "build",
    claim_task: t1.id,
    prompt: "Faca a task 1" // standby foi omitido! (falso por padrão)
  }, LEAD_SESSION);

  check("team_spawn rodou sem erro", typeof resSpawn === "string");
  
  // Validar status no DB do membro
  const member = db.query("SELECT * FROM team_member WHERE team_id = ? AND name = 'membro1'").get(TEAM_ID);
  check("Membro existe e está ready", member && member.status === "ready");
  check("Membro teve execution_status forçado para standby", member && member.execution_status === "standby", `execution_status=${member ? member.execution_status : 'N/A'}`);
  check("Membro teve spawn_context gravado", member && member.spawn_context !== null && member.spawn_context.includes("Faca a task 1"));
  
  // Validar task
  const t1_updated = db.query("SELECT * FROM team_task WHERE id = ?").get(t1.id);
  check("Task 1 continua blocked", t1_updated.status === "blocked");
  check("Task 1 foi pré-atribuída ao membro", t1_updated.assignee === "membro1", `assignee=${t1_updated.assignee}`);

  // Validar promptAsync (zero calls)
  check("ZERO chamadas promptAsync realizadas durante o spawn", mc.calls.promptAsync.length === 0, `chamadas=${mc.calls.promptAsync.length}`);
}

await runSuite();

const passed = results.filter(([, ok]) => ok).length;
const total = results.length;
console.log(`\nRESULT: ${passed}/${total} checks passed, ${unhandled.length} unhandled rejections`);
process.exit(passed === total && unhandled.length === 0 ? 0 : 1);
