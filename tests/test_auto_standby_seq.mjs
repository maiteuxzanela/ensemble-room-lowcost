#!/usr/bin/env node
/**
 * QUALITY GATE DETERMINÍSTICO — Pool plano do board + Auto-Standby semântico
 * @maiteuxzanela/ensemble-room-lowcost
 *
 * Guardiã: Clara (Quality Gate).
 *
 * TICKET-HARNESS-51 — o board é um pool plano, totalmente paralelo:
 *   - executeTeamTasksAdd -> src/tools/team-tasks-add.ts: TODA tarefa nasce
 *     'pending'; a flag legada `sequential` é inerte (sem encadeamento, sem
 *     `depends_on`, sem 'blocked').
 *   - executeTeamSpawn    -> src/tools/team-spawn.ts: reivindicar uma tarefa
 *     pending não força standby (não há dependência bloqueante); o auto-standby
 *     semântico remanescente é o da Guardiã do Quality Gate.
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

const REQUIRED_SYMBOLS = ["createDb", "executeTeamTasksAdd", "executeTeamSpawn", "MemberRegistry", "ProgressTracker", "DEFAULT_CONFIG"];
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
const { createDb, executeTeamTasksAdd, executeTeamSpawn, MemberRegistry, ProgressTracker, DEFAULT_CONFIG } = mods;

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
  const progressTracker = new ProgressTracker();
  const deps = {
    db,
    directory: ROOT,
    client: mc.client,
    registry,
    config: DEFAULT_CONFIG,
    progressTracker,
  };

  // 1. TICKET-HARNESS-51: o board é um pool plano, totalmente paralelo. A flag
  //    legada `sequential` é INERTE — ambas as tarefas nascem 'pending' e NÃO
  //    existe mais coluna `depends_on` (expurgada na Migration 19) nem estado
  //    'blocked' (removido do CHECK constraint).
  const resTasks = await executeTeamTasksAdd(deps, {
    tasks: [
      { content: "Task 0", priority: "medium" },
      { content: "Task 1", priority: "medium" }
    ],
    sequential: true
  }, LEAD_SESSION);

  check("team_tasks_add rodou sem erro", typeof resTasks === "string");
  check("team_tasks_add reporta 2 tarefas", resTasks.includes("Added 2 tasks"), resTasks);

  const tasks = db.query("SELECT * FROM team_task WHERE team_id = ? ORDER BY time_created ASC").all(TEAM_ID);
  check("Duas tasks foram criadas no SQLite", tasks.length === 2);

  const t0 = tasks[0];
  const t1 = tasks[1];

  check("Task 0 nasce pending (pool plano)", t0.status === "pending");
  check("Task 1 nasce pending (sequential não encadeia)", t1.status === "pending", `status=${t1.status}`);
  check(
    "Nenhuma tarefa possui a coluna depends_on (expurgada na Migration 19)",
    t0.depends_on === undefined && t1.depends_on === undefined,
  );
  check("Nenhuma tarefa nasce 'blocked'", t0.status !== "blocked" && t1.status !== "blocked");

  // 2. Spawn com claim_task de uma tarefa pending: reivindica atomicamente
  //    (pending -> in_progress) e NÃO força standby — não há mais 'blocked'.
  const resSpawn = await executeTeamSpawn(deps, {
    name: "membro1",
    agent: "build",
    claim_task: t1.id,
    prompt: "Faca a task 1" // standby omitido (default = false)
  }, LEAD_SESSION);

  check("team_spawn rodou sem erro", typeof resSpawn === "string");
  check("Spawn reporta a reivindicação da tarefa", resSpawn.includes("claimed task"), resSpawn);

  // Validar status no DB do membro — pool plano: nasce busy/starting, não standby.
  const member = db.query("SELECT * FROM team_member WHERE team_id = ? AND name = 'membro1'").get(TEAM_ID);
  check("Membro existe e está busy", member && member.status === "busy", `status=${member ? member.status : "N/A"}`);
  check(
    "Membro NÃO foi forçado a standby (não há tarefa bloqueada)",
    member && member.execution_status === "starting",
    `execution_status=${member ? member.execution_status : "N/A"}`,
  );
  check("Membro NÃO tem spawn_context (nascimento normal, não standby)", member && member.spawn_context === null);

  // Validar task
  const t1_updated = db.query("SELECT * FROM team_task WHERE id = ?").get(t1.id);
  check("Task 1 reivindicada passa a in_progress", t1_updated.status === "in_progress", `status=${t1_updated.status}`);
  check("Task 1 foi atribuída ao membro", t1_updated.assignee === "membro1", `assignee=${t1_updated.assignee}`);

  // Validar promptAsync: o spawn normal dispara exatamente 1 prompt (sem standby).
  check("UMA chamada promptAsync no spawn normal", mc.calls.promptAsync.length === 1, `chamadas=${mc.calls.promptAsync.length}`);

  // 3. Validar auto-standby semântico para a Guardiã do Quality Gate (clara)
  // Quando há tarefas pendentes ou outros membros ativos na equipe, Clara nasce em standby
  mc.calls.promptAsync = [];
  const resClara = await executeTeamSpawn(deps, {
    name: "clara",
    agent: "clara",
    prompt: "Auditar Quality Gate e integridade determinística"
    // standby omitido!
  }, LEAD_SESSION);

  check("team_spawn da Clara rodou sem erro", typeof resClara === "string");
  check("team_spawn da Clara reporta auto-standby semântico", resClara.includes("auto-standby: quality gate guardian with active team or board"));

  const memberClara = db.query("SELECT * FROM team_member WHERE team_id = ? AND name = 'clara'").get(TEAM_ID);
  check("Clara existe e está ready", memberClara && memberClara.status === "ready");
  check("Clara teve execution_status forçado para standby", memberClara && memberClara.execution_status === "standby", `execution_status=${memberClara?.execution_status}`);
  check("Clara teve spawn_context gravado com prompt", memberClara && memberClara.spawn_context !== null && memberClara.spawn_context.includes("Auditar Quality Gate"));
  check("Clara consumiu ZERO tokens ao nascer (zero promptAsync)", mc.calls.promptAsync.length === 0, `chamadas=${mc.calls.promptAsync.length}`);

  // 4. Trava de unicidade da Guardiã (Quality Gate): segunda instância
  // clara-family ("clara-override", agent "clara") é rejeitada de forma
  // determinística enquanto a Guardiã original estiver ativa.
  const promptBeforeOverride = mc.calls.promptAsync.length;
  let guardianLockError = null;
  try {
    await executeTeamSpawn(deps, {
      name: "clara-override",
      agent: "clara",
      prompt: "Auditar imediatamente sem standby",
      standby: false
    }, LEAD_SESSION);
  } catch (err) {
    guardianLockError = err instanceof Error ? err.message : String(err);
  }
  check(
    "Segunda Guardiã bloqueada pela trava de unicidade",
    guardianLockError !== null && guardianLockError.includes("Guardiã do Quality Gate 'clara' já está ativa na equipe 'tauto'"),
    guardianLockError ?? "sem erro"
  );
  check(
    "Mensagem determinística explicita a exclusividade do Quality Gate",
    guardianLockError !== null && guardianLockError.includes("não admitem instâncias concorrentes")
  );
  const blockedMember = db.query("SELECT * FROM team_member WHERE team_id = ? AND name = 'clara-override'").get(TEAM_ID);
  check("Guardiã bloqueada não registrou membro no SQLite", !blockedMember);
  check("Guardiã bloqueada não disparou promptAsync", mc.calls.promptAsync.length === promptBeforeOverride, `delta=${mc.calls.promptAsync.length - promptBeforeOverride}`);

  // 4b. Override standby: false segue válido quando NÃO há Guardiã concorrente
  // ativa (a original foi aposentada para 'shutdown' — estado não-ativo).
  db.run("UPDATE team_member SET status = 'shutdown', time_updated = ? WHERE team_id = ? AND name = 'clara'", [Date.now(), TEAM_ID]);
  const promptBeforeOverride2 = mc.calls.promptAsync.length;
  const resClaraOverride = await executeTeamSpawn(deps, {
    name: "clara-override",
    agent: "clara",
    prompt: "Auditar imediatamente sem standby",
    standby: false
  }, LEAD_SESSION);

  check("team_spawn da Clara com standby: false rodou sem erro", typeof resClaraOverride === "string");
  const memberClaraOverride = db.query("SELECT * FROM team_member WHERE team_id = ? AND name = 'clara-override'").get(TEAM_ID);
  check("Clara com standby: false NÃO está em standby", memberClaraOverride && memberClaraOverride.execution_status !== "standby", `execution_status=${memberClaraOverride?.execution_status}`);
  check("Clara com standby: false NÃO tem spawn_context", memberClaraOverride && (memberClaraOverride.spawn_context === null || memberClaraOverride.spawn_context === undefined));
  check("Clara com standby: false disparou promptAsync imediatamente", mc.calls.promptAsync.length === promptBeforeOverride2 + 1, `delta=${mc.calls.promptAsync.length - promptBeforeOverride2}`);
}

await runSuite();

const passed = results.filter(([, ok]) => ok).length;
const total = results.length;
console.log(`\nRESULT: ${passed}/${total} checks passed, ${unhandled.length} unhandled rejections`);
process.exit(passed === total && unhandled.length === 0 ? 0 : 1);
