#!/usr/bin/env node
/**
 * QUALITY GATE DETERMINÍSTICO — AbortController no cancelamento de
 * requisições travadas (troca forçada de modelo) do
 * @maiteuxzanela/ensemble-room-lowcost.
 *
 * Sob teste (código REAL, não simulado):
 *   - src/v2-session.ts         → trackPrompt, abortInflight, endTracked
 *                                 (registry de AbortControllers em voo).
 *   - src/tools/team-message.ts → executeTeamMessage: aborta a requisição
 *                                 pendente ao receber `model` + `force:true`
 *                                 e reinicia o turno no modelo novo.
 *   - src/types.ts              → PluginClient.promptAsync aceita `signal`
 *                                 (chega ao fetch como RequestInit.signal).
 *
 * Transporte: um client REAL cujo promptAsync honra o AbortSignal de
 * verdade (rejeita quando o signal aborta e nunca resolve sozinho), para
 * provar que o cancelamento propaga — sem mock library, sem stub de banco.
 * SQLite real (node:sqlite) em scratch isolado.
 *
 * Uso:  node tests/test_force_model_abort.mjs
 * Exit: 0 = todos os checks PASS; 1 = há FAIL.
 */

import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

const REPO = path.resolve(import.meta.dirname, "..");
const PKG = process.env.ENSEMBLE_PKG || REPO;
const DIST = path.join(PKG, "dist/index.js");
const TMP = path.join(REPO, ".test-scratch");
mkdirSync(TMP, { recursive: true });
const HARNESS = path.join(TMP, "_force_model_abort_harness.mjs");
const ROOT = path.join(TMP, "force_model_abort_suite");

const TEAM_ID = "team_abort";
const LEAD_SESSION = "ses_lead";
const MEMBER_SESSION = "ses_member";
const NEW_MODEL = "google/antigravity-gemini-3.8-flash#low";

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
  "createDb", "executeTeamMessage", "MemberRegistry", "ProgressTracker",
  "DEFAULT_CONFIG", "trackPrompt", "abortInflight", "endTracked",
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
  createDb, executeTeamMessage, MemberRegistry, ProgressTracker, DEFAULT_CONFIG,
  trackPrompt, abortInflight, endTracked,
} = await import(HARNESS);

/* ------------------------------------------------------------------ *
 * 2. Client REAL: promptAsync honra AbortSignal (pendente até abortar)
 * ------------------------------------------------------------------ */
function makeClient(calls) {
  return {
    session: {
      // Nunca resolve sozinho: só rejeita quando o signal aborta. É o
      // comportamento de um HTTP pendurado que o AbortController cancela.
      promptAsync: (o) => {
        calls.promptAsync.push(o);
        return new Promise((_, reject) => {
          if (o.signal?.aborted) {
            reject(new DOMException("The operation was aborted.", "AbortError"));
            return;
          }
          o.signal?.addEventListener("abort", () =>
            reject(new DOMException("The operation was aborted.", "AbortError")));
        });
      },
      abort: async (o) => { calls.abort.push(o); return {}; },
    },
    tui: { showToast: async () => ({}) },
  };
}

/**
 * Client REAL cujo promptAsync RESOLVE imediatamente (registra o options e
 * cumpre a promise). Usado nos blocos de gate para isolar a semântica
 * `model && force` sem deixar entradas penduradas no registry que o
 * trackPrompt supersedearia na chamada seguinte.
 */
function makeResolvedClient(calls) {
  return {
    session: {
      promptAsync: (o) => { calls.push(o); return Promise.resolve({ data: {} }); },
      abort: async () => ({}),
    },
    tui: { showToast: async () => ({}) },
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
    "INSERT INTO team (id, name, project_id, lead_session_id, status, delegate, time_created, time_updated, lead_agent) VALUES ('team_abort','tabort','default','ses_lead','active',0,0,0,'build')",
  ).run();
  // Lead NÃO vai ao registry — é resolvido via lead_session_id.
  db.query(
    "INSERT INTO team_member (team_id, name, session_id, agent, status, execution_status, time_created, time_updated) VALUES ('team_abort','membro','ses_member','build','busy','running',0,0)",
  ).run();

  const registry = new MemberRegistry();
  registry.register(TEAM_ID, "membro", MEMBER_SESSION);
  const calls = { promptAsync: [], abort: [] };
  const deps = {
    db,
    directory: ROOT,
    client: makeClient(calls),
    registry,
    config: DEFAULT_CONFIG,
    progressTracker: new ProgressTracker(),
  };

  /* ---------------- 3. Unitário: registry de AbortControllers ---------------- */
  {
    const c1 = trackPrompt("ses_x");
    check("trackPrompt devolve AbortController vivo", c1 instanceof AbortController && !c1.signal.aborted);
    check("abortInflight cancela o controller rastreado", abortInflight("ses_x") === true && c1.signal.aborted);
    check("abortInflight sem entrada retorna false", abortInflight("ses_y") === false);

    const c2 = trackPrompt("ses_z");
    const c3 = trackPrompt("ses_z"); // supersede
    check("trackPrompt supersede aborta o controller anterior", c2.signal.aborted && !c3.signal.aborted);
    check("abortInflight cancela apenas o corrente", abortInflight("ses_z") === true && c3.signal.aborted);

    const c4 = trackPrompt("ses_w");
    endTracked("ses_w", c4);
    check("endTracked limpa a entrada (abort posterior é false)", abortInflight("ses_w") === false && !c4.signal.aborted);

    const c5 = trackPrompt("ses_v");
    const c6 = trackPrompt("ses_v"); // c6 supersede c5
    endTracked("ses_v", c5); // settle velho: c5 !== corrente, então NÃO limpa
    // Preservação: a entrada de c6 permanece viva, logo abortInflight a
    // cancela (true) e c6 fica aborted.
    check("endTracked velho preserva a entrada do controller novo", abortInflight("ses_v") === true && c6.signal.aborted);
  }

  /* ---------------- 4. Entrega rastreia o signal ---------------- */
  {
    const before = calls.promptAsync.length;
    await executeTeamMessage(deps, { to: "membro", text: "primeira entrega" }, LEAD_SESSION);
    check("entrega dispara promptAsync", calls.promptAsync.length === before + 1);
    const first = calls.promptAsync[calls.promptAsync.length - 1];
    check("promptAsync recebeu AbortSignal", first.signal instanceof AbortSignal);
    check("signal inicialmente NÃO abortado", !first.signal.aborted);

    // O signal propaga: abortar o controller rastreado rejeita o request.
    const aborted = abortInflight(MEMBER_SESSION);
    check("abortInflight cancela a entrega em voo", aborted === true);
    await new Promise((r) => setTimeout(r, 0)); // deixa o catch rodar
    check("signal da entrega ficou abortado", first.signal.aborted);
  }

  /* ---------------- 5. Troca forçada aborta a pendente ---------------- */
  {
    // Entrega pendurada (client nunca resolve).
    await executeTeamMessage(deps, { to: "membro", text: "travada" }, LEAD_SESSION);
    const stuck = calls.promptAsync[calls.promptAsync.length - 1];
    check("segunda entrega fica pendurada (não abortada)", !stuck.signal.aborted);

    // Troca forçada: model + force. Deve abortar a pendente e reiniciar.
    const res = await executeTeamMessage(
      deps,
      { to: "membro", text: "reiniciar no modelo novo", model: NEW_MODEL, force: true },
      LEAD_SESSION,
    );
    check("troca forçada retorna string de sucesso", typeof res === "string" && res.includes("Message sent"));
    check("a requisição travada foi abortada", stuck.signal.aborted);

    // Reiniciou o turno: uma nova entrega saiu, no modelo novo.
    const restarted = calls.promptAsync[calls.promptAsync.length - 1];
    check("turno reiniciado com nova entrega", restarted !== stuck && !restarted.signal.aborted);
    check(
      "nova entrega usa o modelo novo (variant low)",
      restarted.model?.providerID === "google" &&
        restarted.model?.modelID === "antigravity-gemini-3.8-flash" &&
        restarted.model?.variant === "low",
      JSON.stringify(restarted.model),
    );
    const row = db.query("SELECT model FROM team_member WHERE team_id=? AND name='membro'").get(TEAM_ID);
    check("modelo persistido no banco", row?.model === NEW_MODEL, `model=${row?.model}`);
  }

  /* ---------------- 6. Gate: force SEM model não aborta ---------------- */
  {
    // Transport que resolve: isola o gate `model && force` sem deixar
    // entradas penduradas que o trackPrompt supersedearia na chamada seguinte.
    const resolvedCalls = [];
    deps.client = makeResolvedClient(resolvedCalls);
    await executeTeamMessage(deps, { to: "membro", text: "pendurada sem model" }, LEAD_SESSION);
    const stuck2 = resolvedCalls[resolvedCalls.length - 1];
    await executeTeamMessage(deps, { to: "membro", text: "force puro", force: true }, LEAD_SESSION);
    check("force SEM model NÃO aborta a pendente", !stuck2.signal.aborted);
  }

  /* ---------------- 7. model SEM force não aborta ---------------- */
  {
    const resolvedCalls = [];
    deps.client = makeResolvedClient(resolvedCalls);
    await executeTeamMessage(deps, { to: "membro", text: "pendurada sem force" }, LEAD_SESSION);
    const stuck3 = resolvedCalls[resolvedCalls.length - 1];
    await executeTeamMessage(
      deps,
      { to: "membro", text: "model puro", model: "anthropic/claude-sonnet-4", force: false },
      LEAD_SESSION,
    );
    check("model SEM force NÃO aborta a pendente", !stuck3.signal.aborted);
  }
}

await runSuite();

const passed = results.filter(([, ok]) => ok).length;
const total = results.length;
console.log(`\nRESULT: ${passed}/${total} checks passed, ${unhandled.length} unhandled rejections`);
process.exit(passed === total && unhandled.length === 0 ? 0 : 1);
