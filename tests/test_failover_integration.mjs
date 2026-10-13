#!/usr/bin/env node
/**
 * QUALITY GATE DETERMINÍSTICO — Integração do failover automático
 * transparente (Subtarefa 4) do @maiteuxzanela/ensemble-room-lowcost.
 *
 * Sob teste (código REAL, não simulado):
 *   - src/hooks.ts       → handleRetryModelFailover: comuta team_member.model
 *                           no SQLite para o fallback e registra log silencioso.
 *   - src/config.ts      → parseModelSelector/resolveFallbackChain.
 *   - src/member-model.ts→ getMemberModel propaga `variant`.
 *   - src/v2-client.ts   → createV2Client: o switchModel V2 recebe
 *                           ModelRef COM variant (thinking level "low"),
 *                           que antes era descartado — a lacuna desta tarefa.
 *
 * Prova end-to-end: um rate limit real (retry) no modelo primário faz o
 * failover persistir "google/antigravity-gemini-3.8-flash#low", e a entrega
 * seguinte ao V2 envia {providerID:"google", id:"antigravity-gemini-3.8-flash",
 * variant:"low"} no switchModel — com zero wake-ups ao Lead (zero-noise).
 *
 * Transporte: client V2 REAL gravando as chamadas de switchModel/prompt
 * (registro determinístico, sem mock library). SQLite real (node:sqlite).
 *
 * Uso:  node tests/test_failover_integration.mjs
 * Exit: 0 = todos os checks PASS; 1 = há FAIL.
 */

import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";

const REPO = path.resolve(import.meta.dirname, "..");
const PKG = process.env.ENSEMBLE_PKG || REPO;
const DIST = path.join(PKG, "dist/index.js");
const TMP = path.join(REPO, ".test-scratch");
mkdirSync(TMP, { recursive: true });
const HARNESS = path.join(TMP, "_failover_integration_harness.mjs");
const ROOT = path.join(TMP, "failover_integration_suite");

const TEAM_ID = "team_foi";
const MEMBER_NAME = "membro";
const MEMBER_SESSION = "ses_member";
const PRIMARY_MODEL = "opencode/zen-sonnet-4-6";
const FALLBACK_MODEL = "google/antigravity-gemini-3.8-flash#low";

const results = [];
const check = (name, ok, detail) => {
  results.push([name, ok]);
  console.log(`${ok ? "PASS" : "FAIL"} | ${name}${detail ? " | " + detail : ""}`);
};

const unhandled = [];
process.on("unhandledRejection", (e) => unhandled.push(e));

/* ------------------------------------------------------------------ *
 * 1. Harness do dist: bundle real + apenas cláusulas de export
 * ------------------------------------------------------------------ */
const REQUIRED_SYMBOLS = [
  "createDb", "MemberRegistry", "ProgressTracker", "DEFAULT_CONFIG",
  "handleRetryModelFailover", "getMemberModel", "createV2Client",
  "parseModelSelector", "resolveFallbackChain",
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
  check(
    "harness do dist é o bundle real + apenas cláusulas de export anexadas",
    readFileSync(HARNESS, "utf8") === distRaw + append,
    `${need.join(",")}`,
  );
}

const {
  createDb, MemberRegistry, ProgressTracker, DEFAULT_CONFIG,
  handleRetryModelFailover, getMemberModel, createV2Client,
} = await import(HARNESS);

/** Client V2 REAL gravando switchModel/prompt — prova o payload entregue. */
function makeV2Ctx(calls) {
  return {
    session: {
      create: async (i) => { calls.create.push(i); return { id: "ses_new" }; },
      prompt: async (i) => { calls.prompt.push(i); return {}; },
      switchAgent: async (i) => { calls.switchAgent.push(i); return {}; },
      switchModel: async (i) => { calls.switchModel.push(i); return {}; },
      interrupt: async (i) => { calls.interrupt.push(i); return {}; },
      get: async () => ({}),
      context: async () => [],
      active: async () => ({}),
      synthetic: async (i) => { calls.synthetic.push(i); return {}; },
    },
    worktree: {
      create: async () => ({ directory: "/tmp/x" }),
      remove: async () => ({}),
      list: async () => [],
      refresh: async () => ({}),
    },
    permission: { rules: async () => ({}) },
  };
}

async function runSuite() {
  rmSync(ROOT, { recursive: true, force: true });
  mkdirSync(ROOT, { recursive: true });
  const db = createDb(path.join(ROOT, "ensemble.db"));

  db.query(
    "INSERT INTO project (id, name, path, status, time_created, time_updated) VALUES ('default','Default Project','','active',0,0) ON CONFLICT DO NOTHING",
  ).run();
  db.query(
    "INSERT INTO team (id, name, project_id, lead_session_id, status, delegate, time_created, time_updated, lead_agent) VALUES ('team_foi','tfoi','default','ses_lead','active',0,0,0,'build')",
  ).run();
  db.query(
    "INSERT INTO team_member (team_id, name, session_id, agent, status, execution_status, model, time_created, time_updated) VALUES ('team_foi','membro','ses_member','build','busy','running','opencode/zen-sonnet-4-6',0,0)",
  ).run();

  const registry = new MemberRegistry();
  registry.register(TEAM_ID, MEMBER_NAME, MEMBER_SESSION);
  const calls = {
    create: [], prompt: [], switchAgent: [], switchModel: [],
    interrupt: [], synthetic: [],
  };
  const leadWakes = [];
  const client = {
    // notifyLead acorda o Lead via promptAsync; gravamos para provar zero-noise.
    session: { promptAsync: async (o) => { leadWakes.push(o); return {}; } },
    tui: { showToast: async () => ({}) },
  };
  const config = { ...DEFAULT_CONFIG, fallbackModels: [FALLBACK_MODEL] };

  /* ---------------- 2. Cenário: rate limit no modelo primário ---------------- */
  const decision = handleRetryModelFailover(
    db, registry, client, config, MEMBER_SESSION, { message: "429 rate limited" },
  );

  check("failover decide 'switched'", decision?.action === "switched",
    `action=${decision?.action}`);
  check("failover persiste o fallback no SQLite",
    decision?.toModel === FALLBACK_MODEL, `toModel=${decision?.toModel}`);

  const row = db.query(
    "SELECT model FROM team_member WHERE team_id=? AND name=?",
  ).get(TEAM_ID, MEMBER_NAME);
  check("team_member.model atualizado para o fallback com #variant",
    row?.model === FALLBACK_MODEL, `model=${row?.model}`);

  check("zero-noise: Lead NÃO foi acordado no switch", leadWakes.length === 0,
    `wakes=${leadWakes.length}`);

  /* ---------------- 3. getMemberModel propaga a variant ---------------- */
  const parsed = getMemberModel(db, TEAM_ID, MEMBER_NAME);
  check("getMemberModel devolve providerID/modelID limpos",
    parsed?.providerID === "google" && parsed?.modelID === "antigravity-gemini-3.8-flash",
    JSON.stringify(parsed));
  check("getMemberModel propaga variant='low' (thinking level)",
    parsed?.variant === "low", `variant=${parsed?.variant}`);

  /* ---------------- 4. v2-client: switchModel recebe a variant ---------------- */
  const v2 = createV2Client(makeV2Ctx(calls), {});
  await v2.session.promptAsync({
    sessionID: MEMBER_SESSION,
    parts: [{ type: "text", text: "entrega após failover" }],
    model: parsed,
  });

  check("v2-client disparou switchModel", calls.switchModel.length === 1,
    `calls=${calls.switchModel.length}`);
  const sm = calls.switchModel[0];
  check("switchModel envia providerID='google'", sm?.model?.providerID === "google",
    `providerID=${sm?.model?.providerID}`);
  check("switchModel envia id='antigravity-gemini-3.8-flash' (sem sufixo)",
    sm?.model?.id === "antigravity-gemini-3.8-flash", `id=${sm?.model?.id}`);
  check("switchModel envia variant='low' (ModelRef.variant) — LACUNA CORRIGIDA",
    sm?.model?.variant === "low", `variant=${sm?.model?.variant}`);
  check("variant NUNCA contamina o id/modelID",
    !String(sm?.model?.id).includes("#") && !String(sm?.model?.id).includes("low"),
    `id=${sm?.model?.id}`);

  check("prompt entregue após o switch", calls.prompt.length === 1,
    `prompt=${calls.prompt.length}`);

  /* ---------------- 5. Regressão: modelo SEM variant não quebra ---------------- */
  const ctx2 = { create: [], prompt: [], switchAgent: [], switchModel: [], interrupt: [], synthetic: [] };
  const v2bare = createV2Client(makeV2Ctx(ctx2), {});
  await v2bare.session.promptAsync({
    sessionID: MEMBER_SESSION,
    parts: [{ type: "text", text: "sem variant" }],
    model: { providerID: "opencode", modelID: "zen-sonnet-4-6" },
  });
  check("modelo sem variant: switchModel omite a chave variant",
    ctx2.switchModel[0]?.model?.variant === undefined,
    `variant=${ctx2.switchModel[0]?.model?.variant}`);
  check("modelo sem variant: providerID/id preservados",
    ctx2.switchModel[0]?.model?.providerID === "opencode" &&
      ctx2.switchModel[0]?.model?.id === "zen-sonnet-4-6",
    JSON.stringify(ctx2.switchModel[0]?.model));
}

await runSuite();

const passed = results.filter(([, ok]) => ok).length;
const total = results.length;
console.log(`\nRESULT: ${passed}/${total} checks passed, ${unhandled.length} unhandled rejections`);
process.exit(passed === total && unhandled.length === 0 ? 0 : 1);
