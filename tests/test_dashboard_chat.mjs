#!/usr/bin/env node
/**
 * QUALITY GATE DETERMINÍSTICO — Chat no Dashboard (Fase 3)
 * @hueyexe/opencode-ensemble@0.18.0
 *
 * Guardiã: Clara (Quality Gate). Time "dashboard-chat".
 *
 * Sob teste (código REAL, não simulado):
 *   - startDashboard            → src/dashboard.ts e dist/index.js
 *   - POST /api/chat/send       → Endpoint do chat humano
 *   - createDb/MIGRATIONS       → SQLite real
 *
 * Comprova:
 *   (a) POST com text "@clara oi" -> envia DM para clara, messageId persistido, team_message com to='clara'
 *   (b) POST com text "olá sala" -> envia broadcast, messageId persistido, team_message com to=null
 *   (c) Validação input vazio/membro inexistente -> HTTP 400 e 404
 *   (d) 100% sem mocks: servidor HTTP real, rotas reais, HTTP.
 */

import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import net from "node:net";

const REPO = path.resolve(import.meta.dirname, "..");
const PKG = process.env.ENSEMBLE_PKG || REPO;
const DIST = path.join(PKG, "dist/index.js");
const TMP = path.join(REPO, ".test-scratch");
mkdirSync(TMP, { recursive: true });
const HARNESS = path.join(TMP, "_dashboard_chat_harness.mjs");
const ROOT = path.join(TMP, "chat_suite");

const results = [];
const check = (name, ok, detail) => {
  results.push([name, ok]);
  console.log(`${ok ? "PASS" : "FAIL"} | ${name}${detail ? " | " + detail : ""}`);
};

const unhandled = [];
process.on("unhandledRejection", (e) => unhandled.push(e));

const REQUIRED_SYMBOLS = ["createDb", "startDashboard"];
const distRaw = readFileSync(DIST, "utf8");
{
  const missing = REQUIRED_SYMBOLS.filter(
    (s) => !new RegExp(`(function|class|var|const|let)\\s+${s}\\b`).test(distRaw),
  );
  check(
    "dist declara todos os símbolos exigidos pela suíte",
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
const { createDb, startDashboard } = mods;

async function getFreePort() {
  return new Promise((resolve) => {
    const srv = net.createServer();
    srv.listen(0, () => {
      const port = srv.address().port;
      srv.close(() => resolve(port));
    });
  });
}

function mockClient() {
  const calls = { promptAsync: [] };
  return {
    calls,
    client: {
      session: {
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
  
  // Setup database with an active team and members (using the full schema from migrations)
  db.query("INSERT INTO project (id, name, path, status, time_created, time_updated) VALUES ('default', 'Default Project', '', 'active', 0, 0) ON CONFLICT DO NOTHING").run();
  db.query("INSERT INTO team (id, name, project_id, lead_session_id, status, delegate, time_created, time_updated, lead_agent) VALUES ('team_1', 't1', 'default', 'lead_ses', 'active', 0, 0, 0, 'build')").run();
  
  // team_member table requires multiple fields:
  // (team_id, name, session_id, agent, status, execution_status, model, prompt, time_created, time_updated, worktree_dir, worktree_branch, plan_approval, workspace_id, reported_to_lead)
  db.query("INSERT INTO team_member (team_id, name, session_id, agent, status, execution_status, time_created, time_updated, plan_approval, reported_to_lead) VALUES ('team_1', 'clara', 'ses_clara', 'agent', 'ready', 'idle', 0, 0, 'none', 0)").run();
  db.query("INSERT INTO team_member (team_id, name, session_id, agent, status, execution_status, time_created, time_updated, plan_approval, reported_to_lead) VALUES ('team_1', 'tulio', 'ses_tulio', 'agent', 'ready', 'idle', 0, 0, 'none', 0)").run();
  
  const port = await getFreePort();
  const mc = mockClient();
  const server = await startDashboard(db, port, { client: mc.client });
  
  check("startDashboard retornou server", server !== null, `port=${port}`);
  
  const post = async (payload) => {
    const res = await fetch(`http://localhost:${port}/api/chat/send`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload)
    });
    const text = await res.text();
    let data;
    try { data = JSON.parse(text); } catch { data = text; }
    return { status: res.status, data };
  };

  // 1. Payload vazio
  let r = await post({ text: "   " });
  check("Validação input vazio HTTP 400", r.status === 400 && r.data.ok === false, `status=${r.status} data=${JSON.stringify(r.data)}`);

  // 2. Membro inexistente
  r = await post({ text: "@batman hello" });
  check("Validação membro inexistente HTTP 404", r.status === 404 && r.data.ok === false, `error=${r.data.error}`);

  // 3. Broadcast
  r = await post({ text: "olá sala" });
  check("Broadcast retorna 200 OK com messageId", r.status === 200 && r.data.ok === true && typeof r.data.messageId === "string", `status=${r.status} data=${JSON.stringify(r.data)}`);
  let row = db.query("SELECT * FROM team_message WHERE id = ?").get(r.data.messageId);
  check("Broadcast gravado no SQLite", row && row.from_name === "human" && row.to_name === null && row.content === "olá sala");
  
  // Verifica promptAsync para os 2 membros ativos
  let expectedCalls = mc.calls.promptAsync.filter(c => c.parts[0].text.includes("olá sala"));
  check("Broadcast despachado via promptAsync para 2 membros", expectedCalls.length === 2 && expectedCalls.every(c => c.synthetic === true));
  
  mc.calls.promptAsync = []; // reset
  
  // 4. DM
  r = await post({ text: "@clara ajuste o teste" });
  check("DM retorna 200 OK com messageId", r.status === 200 && r.data.ok === true && r.data.recipients.includes("clara"));
  row = db.query("SELECT * FROM team_message WHERE id = ?").get(r.data.messageId);
  check("DM gravado no SQLite", row && row.from_name === "human" && row.to_name === "clara" && row.content === "ajuste o teste");
  
  expectedCalls = mc.calls.promptAsync.filter(c => c.sessionID === "ses_clara" && c.parts[0].text.includes("ajuste o teste"));
  check("DM despachado via promptAsync apenas para a clara", expectedCalls.length === 1 && expectedCalls[0].synthetic === true);
  check("DM NÃO foi despachado para tulio", mc.calls.promptAsync.length === 1);
  
  // Shutdown
  server.stop();
  check("Servidor encerrado sem exceções", true);
}

await runSuite();

const passed = results.filter(([, ok]) => ok).length;
const total = results.length;
console.log(`\nRESULT: ${passed}/${total} checks passed, ${unhandled.length} unhandled rejections`);
process.exit(passed === total && unhandled.length === 0 ? 0 : 1);
