#!/usr/bin/env node
/**
 * QUALITY GATE DETERMINÍSTICO — TICKET-HARNESS-10
 * Failover Ativo de Modelo em Rate Limit (HTTP 429/retry)
 * do @maiteuxzanela/ensemble-room-lowcost.
 *
 * Sob teste (código REAL, sem mocks na lógica):
 *   - src/hooks.ts       → handleRetryModelFailover (async, abortInflight,
 *                          client.session.abort, promptAsync com fallback model
 *                          e synthetic: true, zero-noise no Lead).
 *   - src/v2-session.ts  → abortInflight, trackPrompt (cancelamento de requisição HTTP pendente).
 *   - src/v2-client.ts   → promptAsync V2 executando switchModel (com variant)
 *                          mesmo quando synthetic: true.
 *   - dist/index.js      → Paridade total do bundle compilado.
 *
 * Uso:  node tests/test_retry_failover_active.mjs
 * Exit: 0 = todos os checks PASS; 1 = há FAIL.
 */

import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";

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

/* ------------------------------------------------------------------ *
 * 1. Harness do dist: bundle real + apenas cláusulas de export      *
 * ------------------------------------------------------------------ */
const HARNESS = path.join(TMP, "_active_failover_harness.mjs");
const REQUIRED_SYMBOLS = [
  "createDb", "MemberRegistry", "DEFAULT_CONFIG", "handleRetryModelFailover",
  "failoverCooldown", "FAILOVER_COOLDOWN_MS", "trackPrompt", "abortInflight",
  "endTracked", "createV2Client", "parseModelSelector", "resolveFallbackChain",
  "formatModelSelector",
];

const distRaw = readFileSync(DIST, "utf8");
{
  const missing = REQUIRED_SYMBOLS.filter(
    (s) => !new RegExp(`(function|class|var|const|let)\\s+${s}\\b`).test(distRaw),
  );
  check(
    "dist declara todos os símbolos exigidos",
    missing.length === 0,
    missing.join(",") || `${REQUIRED_SYMBOLS.length} símbolos`,
  );

  const existing = distRaw.match(/export\s*\{([^}]*)\}\s*;?\s*$/)?.[1] ?? "";
  const already = new Set(existing.split(",").map((s) => s.trim().split(/\s+as\s+/).pop()).filter(Boolean));
  const need = REQUIRED_SYMBOLS.filter((s) => !already.has(s));
  const append = need.length ? `\nexport { ${need.join(", ")} };\n` : "";
  writeFileSync(HARNESS, distRaw + append);
}

const {
  createDb, MemberRegistry, DEFAULT_CONFIG, handleRetryModelFailover,
  failoverCooldown, FAILOVER_COOLDOWN_MS, trackPrompt, abortInflight,
  createV2Client,
} = await import(HARNESS);

let dbSeq = 0;
function makeDb() {
  const file = path.join(TMP, `failover_active_${process.pid}_${dbSeq++}.sqlite`);
  rmSync(file, { force: true });
  rmSync(`${file}-wal`, { force: true });
  rmSync(`${file}-shm`, { force: true });
  return createDb(file);
}

const LEAD_SESSION = "lead_session_active";
const TEAM_ID = "team_active_failover";

function seedMember(db, {
  teamId = TEAM_ID,
  memberName = "dante_peer",
  sessionId = "sess_active_1",
  model = "opencode/mimo-v2.6-flash-free",
  status = "busy",
  teamStatus = "active",
} = {}) {
  const now = Date.now();
  db.run(
    `INSERT OR IGNORE INTO team (id, name, lead_session_id, status, delegate, time_created, time_updated)
     VALUES (?, ?, ?, ?, 0, ?, ?)`,
    [teamId, `team-${teamId}`, LEAD_SESSION, teamStatus, now, now],
  );
  if (teamStatus !== "active") {
    db.run("UPDATE team SET status = ? WHERE id = ?", [teamStatus, teamId]);
  }
  db.run(
    `INSERT INTO team_member (team_id, name, session_id, agent, status, execution_status, model, prompt, time_created, time_updated)
     VALUES (?, ?, ?, 'build', ?, 'running', ?, 'run task', ?, ?)`,
    [teamId, memberName, sessionId, status, model, now, now],
  );
  const registry = new MemberRegistry();
  registry.register(teamId, memberName, sessionId);
  return { registry, sessionId, memberName, teamId };
}

/* ------------------------------------------------------------------ *
 * 2. Teste: Cancelamento Ativo de In-Flight Request                   *
 * ------------------------------------------------------------------ */
{
  const db = makeDb();
  const seed = seedMember(db, { sessionId: "sess_inflight_test" });
  const controller = trackPrompt("sess_inflight_test");

  check(
    "In-flight request inicialmente ativa",
    controller.signal.aborted === false,
  );

  const calls = { abort: [], promptAsync: [] };
  const client = {
    session: {
      abort: async (opts) => { calls.abort.push(opts); return {}; },
      promptAsync: async (opts) => { calls.promptAsync.push(opts); return {}; },
    },
    tui: { showToast: async () => ({}) },
  };

  const decision = await handleRetryModelFailover(
    db, seed.registry, client, { ...DEFAULT_CONFIG }, seed.sessionId,
    { attempt: 1, message: "429 rate limit" },
  );

  check(
    "abortInflight cancelou o controller em voo",
    controller.signal.aborted === true,
  );
  check(
    "client.session.abort foi chamado com a sessionID do membro",
    calls.abort.length === 1 && calls.abort[0].sessionID === seed.sessionId,
    JSON.stringify(calls.abort),
  );
  check(
    "client.session.promptAsync relançou o turno com synthetic: true e novo modelo",
    calls.promptAsync.length === 1
      && calls.promptAsync[0].sessionID === seed.sessionId
      && calls.promptAsync[0].synthetic === true
      && calls.promptAsync[0].model?.providerID === "google"
      && calls.promptAsync[0].model?.modelID === "antigravity-gemini-3.8-flash"
      && calls.promptAsync[0].model?.variant === "low",
    JSON.stringify(calls.promptAsync[0]),
  );
  check(
    "promptAsync inclui aviso de rate limit e retomada de tarefa",
    calls.promptAsync[0].parts[0].text.includes("Rate limit encountered on previous model")
      && calls.promptAsync[0].parts[0].text.includes("google/antigravity-gemini-3.8-flash#low"),
  );

  db.close();
  failoverCooldown.clear();
}

/* ------------------------------------------------------------------ *
 * 3. Teste: Zero-Noise no Lead durante failover bem-sucedido          *
 * ------------------------------------------------------------------ */
{
  const db = makeDb();
  const seed = seedMember(db, { sessionId: "sess_zero_noise" });
  const leadWakes = [];
  const memberPrompts = [];
  const abortCalls = [];

  const client = {
    session: {
      abort: async (opts) => { abortCalls.push(opts); return {}; },
      promptAsync: async (opts) => {
        if (opts.sessionID === LEAD_SESSION) leadWakes.push(opts);
        else memberPrompts.push(opts);
        return {};
      },
    },
    tui: { showToast: async () => ({}) },
  };

  const decision = await handleRetryModelFailover(
    db, seed.registry, client, { ...DEFAULT_CONFIG }, seed.sessionId,
    { attempt: 1, message: "429 rate limit" },
  );

  check(
    "Decision retornou 'switched'",
    decision?.action === "switched" && decision.toModel === "google/antigravity-gemini-3.8-flash#low",
    JSON.stringify(decision),
  );
  check(
    "ZERO-NOISE: Lead NÃO foi acordado via promptAsync",
    leadWakes.length === 0,
    `leadWakes=${leadWakes.length}`,
  );
  check(
    "Membro recebeu exatamente 1 promptAsync de re-ativação",
    memberPrompts.length === 1 && memberPrompts[0].sessionID === seed.sessionId,
  );

  const memberRow = db.query("SELECT model FROM team_member WHERE session_id = ?").get(seed.sessionId);
  check(
    "team_member.model atualizado no SQLite",
    memberRow.model === "google/antigravity-gemini-3.8-flash#low",
  );

  db.close();
  failoverCooldown.clear();
}

/* ------------------------------------------------------------------ *
 * 4. Teste: Integração com Cliente V2 Nativo (switchModel + synthetic)*
 * ------------------------------------------------------------------ */
{
  const db = makeDb();
  const seed = seedMember(db, { sessionId: "sess_v2_native" });

  const nativeCalls = {
    interrupt: [],
    switchModel: [],
    synthetic: [],
    prompt: [],
  };

  const mockV2Ctx = {
    session: {
      create: async () => ({ id: "ses_created" }),
      prompt: async (i) => { nativeCalls.prompt.push(i); return {}; },
      switchAgent: async () => ({}),
      switchModel: async (i) => { nativeCalls.switchModel.push(i); return {}; },
      interrupt: async (i) => { nativeCalls.interrupt.push(i); return {}; },
      synthetic: async (i) => { nativeCalls.synthetic.push(i); return {}; },
      get: async () => ({}),
      context: async () => [],
      active: async () => ({}),
    },
    worktree: { create: async () => ({ directory: "/tmp" }) },
    permission: { rules: async () => ({}) },
  };

  const v2Client = createV2Client(mockV2Ctx);

  const decision = await handleRetryModelFailover(
    db, seed.registry, v2Client, { ...DEFAULT_CONFIG }, seed.sessionId,
    { attempt: 1, message: "429 limit" },
  );

  check(
    "V2: interrupt (abort nativo) chamado para a sessão",
    nativeCalls.interrupt.length === 1 && nativeCalls.interrupt[0].sessionID === seed.sessionId,
    JSON.stringify(nativeCalls.interrupt),
  );
  check(
    "V2: switchModel chamado com variant='low' antes da mensagem sintética",
    nativeCalls.switchModel.length === 1
      && nativeCalls.switchModel[0].sessionID === seed.sessionId
      && nativeCalls.switchModel[0].model.providerID === "google"
      && nativeCalls.switchModel[0].model.id === "antigravity-gemini-3.8-flash"
      && nativeCalls.switchModel[0].model.variant === "low",
    JSON.stringify(nativeCalls.switchModel),
  );
  check(
    "V2: synthetic chamado com delivery='queue' para registrar no transcript",
    nativeCalls.synthetic.length === 1
      && nativeCalls.synthetic[0].sessionID === seed.sessionId
      && nativeCalls.synthetic[0].delivery === "queue"
      && nativeCalls.synthetic[0].text.includes("Switched to google/antigravity-gemini-3.8-flash#low"),
    JSON.stringify(nativeCalls.synthetic),
  );

  db.close();
  failoverCooldown.clear();
}

/* ------------------------------------------------------------------ *
 * 5. Teste: Esgotamento da Cadeia (HARNESS-13 — NÃO acorda o Lead)    *
 * ------------------------------------------------------------------ */
{
  const db = makeDb();
  // Membro já operando no último modelo da cadeia de fallback
  const seed = seedMember(db, {
    sessionId: "sess_exhausted",
    model: "google/antigravity-gemini-3.8-flash#low",
  });

  const calls = { abort: [], promptAsync: [] };
  const client = {
    session: {
      abort: async (opts) => { calls.abort.push(opts); return {}; },
      promptAsync: async (opts) => { calls.promptAsync.push(opts); return {}; },
    },
    tui: { showToast: async () => ({}) },
  };

  const decision = await handleRetryModelFailover(
    db, seed.registry, client, { ...DEFAULT_CONFIG }, seed.sessionId,
    { attempt: 1, message: "429 quota exhausted" },
  );

  check(
    "Esgotamento da cadeia retorna action 'exhausted'",
    decision?.action === "exhausted",
    JSON.stringify(decision),
  );
  check(
    "HARNESS-13 — lead NÃO acordado na exaustão (ZERO promptAsync, exceção de ruído removida)",
    calls.promptAsync.length === 0,
    JSON.stringify(calls.promptAsync),
  );
  check(
    "Nenhum abort chamado para o subagente quando a cadeia se esgota",
    calls.abort.length === 0,
  );

  const leadMsgs = db.query(
    "SELECT content FROM team_message WHERE team_id = ? AND to_name = 'lead'",
  ).all(seed.teamId);
  check(
    "HARNESS-13 — NENHUMA mensagem explicativa gravada para o Lead (zero team_message)",
    leadMsgs.length === 0
      && !leadMsgs.some((m) => String(m.content).includes("fallback chain is exhausted")),
    `leadMsgs=${leadMsgs.length}`,
  );

  db.close();
  failoverCooldown.clear();
}

/* ------------------------------------------------------------------ *
 * 6. Teste: Cooldown / Supressão de Burst                             *
 * ------------------------------------------------------------------ */
{
  const db = makeDb();
  const seed = seedMember(db, { sessionId: "sess_cooldown_test" });
  const calls = { abort: [], promptAsync: [] };
  const client = {
    session: {
      abort: async (opts) => { calls.abort.push(opts); return {}; },
      promptAsync: async (opts) => { calls.promptAsync.push(opts); return {}; },
    },
    tui: { showToast: async () => ({}) },
  };

  const first = await handleRetryModelFailover(
    db, seed.registry, client, { ...DEFAULT_CONFIG }, seed.sessionId,
    { attempt: 1, message: "429 first" },
  );
  const second = await handleRetryModelFailover(
    db, seed.registry, client, { ...DEFAULT_CONFIG }, seed.sessionId,
    { attempt: 2, message: "429 second" },
  );

  check(
    "1ª chamada do burst executa 'switched'",
    first?.action === "switched",
  );
  check(
    "2ª chamada no mesmo cooldown retorna 'suppressed'",
    second?.action === "suppressed",
  );
  check(
    "Apenas 1 abort e 1 promptAsync disparados no burst inteiro",
    calls.abort.length === 1 && calls.promptAsync.length === 1,
    `abort=${calls.abort.length} promptAsync=${calls.promptAsync.length}`,
  );

  db.close();
  failoverCooldown.clear();
}

/* ------------------------------------------------------------------ *
 * 7. Teste: Resiliência contra Falhas de Transporte                   *
 * ------------------------------------------------------------------ */
{
  const db = makeDb();
  const seed = seedMember(db, { sessionId: "sess_transport_fail" });
  const client = {
    session: {
      abort: async () => { throw new Error("Socket disconnected unexpectedly"); },
      promptAsync: async () => { throw new Error("Timeout awaiting SDK response"); },
    },
    tui: { showToast: async () => ({}) },
  };

  const decision = await handleRetryModelFailover(
    db, seed.registry, client, { ...DEFAULT_CONFIG }, seed.sessionId,
    { attempt: 1, message: "429 error" },
  );

  check(
    "Failover não lança exceção em falha de transporte e retorna 'switched'",
    decision?.action === "switched",
  );
  const memberRow = db.query("SELECT model FROM team_member WHERE session_id = ?").get(seed.sessionId);
  check(
    "Modelo foi atualizado no SQLite mesmo com falha no transporte",
    memberRow.model === "google/antigravity-gemini-3.8-flash#low",
  );

  db.close();
  failoverCooldown.clear();
}

/* ------------------------------------------------------------------ *
 * Relatório Final da Suíte                                            *
 * ------------------------------------------------------------------ */
const passed = results.filter(([, ok]) => ok).length;
const total = results.length;
const fails = results.filter(([, ok]) => !ok).map(([name]) => name);
console.log("-".repeat(78));
console.log(`CHECKS: ${passed}/${total} passaram, ${unhandled.length} unhandled rejections`);
if (fails.length > 0) {
  for (const f of fails) console.log(`FAIL | ${f}`);
}
console.log(`RESULT: ${passed === total && unhandled.length === 0 ? "all checks passed" : "SUITE FAILURE"} (${passed}/${total})`);
process.exit(passed === total && unhandled.length === 0 ? 0 : 1);
