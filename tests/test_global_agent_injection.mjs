#!/usr/bin/env node
/**
 * QUALITY GATE DETERMINÍSTICO — Injeção Global de Persona (HARNESS-21)
 * @maiteuxzanela/ensemble-room-lowcost (card [T3] / SDET Hugo)
 *
 * Engenheiro de Testes (SDET): Hugo. Guardiã do Quality Gate: Clara.
 *
 * Sob teste (dist/index.js REAL — bundle esbuild, SQLite real via node:sqlite):
 *   - resolveAgentForSession  -> src/member-model.ts
 *   - wrapThrowingClient      -> src/client.ts (choke point V1 / promptAsync)
 *   - deliverPrompt           -> src/v2-session.ts (transporte V2 / switchAgent)
 *
 * Cobertura (5 cenários do card + integração + anti-mock):
 *   (1) Sessão de membro (agent='hugo') SEM `agent` -> choke point injeta
 *       `agent:'hugo'` nos args repassados ao raw client.
 *   (2) Sessão do lead (team.lead_session_id) SEM `agent` -> injeta `lead_agent`
 *       ('dante'); lead legado com lead_agent NULL -> SEM persona inventada
 *       (TICKET-RELEASE-09: verbatim, o vínculo nativo da sessão é preservado).
 *   (3) `agent` explícito -> NUNCA sobrescrito; string vazia tratada como ausente.
 *   (4) Sessão desconhecida -> repassa VERBATIM, sem erro e sem persona inventada;
 *       sessionID ausente idem.
 *   (5) Transporte V2: deliverPrompt chama switchAgent ANTES de prompt (queue),
 *       com `agent` no switchAgent e prompt SEM `agent`; sem switchAgent degrada
 *       para entrega verbatim; agent falsy não chama switchAgent.
 *   (+) Integração: resolver real do DB alimenta wrapThrowingClient E deliverPrompt.
 *   (+) Paridade src↔dist e anti-mock (src/ limpo; suíte sem mocks proibidos).
 *
 * SEM MOCKS: roda contra o bundle REAL e SQLite real. O único seam é o cliente
 * SDK do OpenCode (boundary externo de I/O) e o V2SessionPort (seam de
 * transporte), reduzidos ao mínimo de gravação de chamadas — idêntico às demais
 * suítes do repo. Nenhum mock de lógica de negócio.
 *
 * Uso: node tests/test_global_agent_injection.mjs
 * Exit: 0 = todos os checks PASS; 1 = há FAIL.
 */

import { mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";

const REPO = path.resolve(import.meta.dirname, "..");
const PKG = process.env.ENSEMBLE_PKG || REPO;
const DIST = path.join(PKG, "dist/index.js");
const SRC = path.join(REPO, "src");
const TMP = path.join(REPO, ".test-scratch");
const ROOT = path.join(TMP, "global_agent_injection_suite");
const HARNESS = path.join(TMP, "_global_agent_injection_harness.mjs");
mkdirSync(TMP, { recursive: true });
rmSync(ROOT, { recursive: true, force: true });
mkdirSync(ROOT, { recursive: true });

const results = [];
const check = (name, ok, detail) => {
  results.push([name, ok]);
  console.log(`${ok ? "PASS" : "FAIL"} | ${name}${detail ? " | " + detail : ""}`);
};

const unhandled = [];
process.on("unhandledRejection", (e) => unhandled.push(e));

// ---------------------------------------------------------------------------
// 0. Harness: dist real + exportação dos símbolos sob teste (sem mocks).
// ---------------------------------------------------------------------------
const REQUIRED_SYMBOLS = ["createDb", "resolveAgentForSession", "wrapThrowingClient", "deliverPrompt"];
const distRaw = readFileSync(DIST, "utf8");
const clientSrc = readFileSync(path.join(SRC, "client.ts"), "utf8");
const v2Src = readFileSync(path.join(SRC, "v2-session.ts"), "utf8");
const memberSrc = readFileSync(path.join(SRC, "member-model.ts"), "utf8");

{
  const missing = REQUIRED_SYMBOLS.filter(
    (s) => !new RegExp(`(async\\s+)?(function|class|var|const|let)\\s+${s}\\b`).test(distRaw),
  );
  check(
    "dist declara todos os símbolos exigidos",
    missing.length === 0,
    missing.join(",") || `${REQUIRED_SYMBOLS.length} símbolos`,
  );
  const existingExport = distRaw.match(/export\s*\{([^}]*)\}\s*;?\s*$/)?.[1] ?? "";
  const already = new Set(
    existingExport
      .split(",")
      .map((s) => s.trim().split(/\s+as\s+/).pop())
      .filter(Boolean),
  );
  const need = REQUIRED_SYMBOLS.filter((s) => !already.has(s));
  const EXPORT_APPEND = need.length ? `\nexport { ${need.join(", ")} };\n` : "";
  writeFileSync(HARNESS, distRaw + EXPORT_APPEND);
}

const { createDb, resolveAgentForSession, wrapThrowingClient, deliverPrompt } = await import(HARNESS);

// ---------------------------------------------------------------------------
// 1. Fixtures de SQLite real (node:sqlite DatabaseSync via createDb).
// ---------------------------------------------------------------------------
const TS = Date.now();
const MEM_SES = "ses_member_hugo_01";
const LEAD_SES = "ses_lead_dante_01";
const LEGACY_LEAD_SES = "ses_lead_legacy_02";
const UNKNOWN_SES = "ses_ghost_99";

const db = createDb(path.join(ROOT, "ensemble.db"));
db.run(
  "INSERT INTO team (id, name, project_id, lead_session_id, status, delegate, time_created, time_updated, lead_agent) VALUES (?,?,?,?,?,?,?,?,?)",
  ["t_member", "room21", "default", LEAD_SES, "active", 0, TS, TS, "dante"],
);
db.run(
  "INSERT INTO team (id, name, project_id, lead_session_id, status, delegate, time_created, time_updated, lead_agent) VALUES (?,?,?,?,?,?,?,?,?)",
  ["t_legacy", "legacy", "default", LEGACY_LEAD_SES, "active", 0, TS, TS, null],
);
db.run(
  "INSERT INTO team_member (team_id, name, session_id, agent, status, execution_status, time_created, time_updated) VALUES (?,?,?,?,?,?,?,?)",
  ["t_member", "hugo", MEM_SES, "hugo", "ready", "idle", TS, TS],
);
// Sessão de membro com agent vazio -> deve cair para a resolução de lead (ou undefined).
const EMPTY_AGENT_SES = "ses_member_empty_agent_03";
db.run(
  "INSERT INTO team_member (team_id, name, session_id, agent, status, execution_status, time_created, time_updated) VALUES (?,?,?,?,?,?,?,?)",
  ["t_member", "ghosty", EMPTY_AGENT_SES, "", "ready", "idle", TS, TS],
);

// ---------------------------------------------------------------------------
// 2. Seam mínimo do cliente SDK do OpenCode (boundary externo de I/O).
//    `promptAsync` grava os args efetivamente recebidos pelo raw client.
// ---------------------------------------------------------------------------
function makeRaw() {
  const calls = { promptAsync: [] };
  const noop = async () => ({});
  const raw = {
    session: {
      create: noop,
      promptAsync: async (params) => {
        calls.promptAsync.push(params);
        return {};
      },
      abort: noop,
      status: noop,
      messages: noop,
      get: noop,
    },
    tui: { showToast: noop, selectSession: noop },
    worktree: { create: noop, remove: noop, list: noop, reset: noop },
    experimental: { workspace: { create: noop, remove: noop, list: noop } },
  };
  return { calls, raw };
}

const resolver = (sessionID) => resolveAgentForSession(db, sessionID);
const hasKey = (o, k) => Object.prototype.hasOwnProperty.call(o, k);

// ---------------------------------------------------------------------------
// 3. Choke point V1 — wrapThrowingClient(raw, agentResolver)
// ---------------------------------------------------------------------------
{
  const { calls, raw } = makeRaw();
  const client = wrapThrowingClient(raw, resolver);

  // --- Cenário 1: membro sem `agent` -> injeta 'hugo' ---
  const memberParams = { sessionID: MEM_SES, text: "Nudge de membro." };
  await client.session.promptAsync(memberParams);
  const c1 = calls.promptAsync.at(-1);
  check(
    "(1) membro sem agent -> choke point injeta agent:'hugo'",
    c1?.agent === "hugo" && c1?.sessionID === MEM_SES && c1?.text === "Nudge de membro.",
    JSON.stringify(c1),
  );
  check(
    "(1) injeta via SHALLOW COPY: objeto do caller NÃO é mutado",
    !hasKey(memberParams, "agent") && memberParams.sessionID === MEM_SES,
    `keys=${Object.keys(memberParams).join(",")}`,
  );
  check(
    "(1) resolveAgentForSession(db, memSes) === 'hugo'",
    resolveAgentForSession(db, MEM_SES) === "hugo",
  );

  // --- Cenário 2: lead sem `agent` -> injeta lead_agent 'dante' ---
  await client.session.promptAsync({ sessionID: LEAD_SES, text: "Wake do lead." });
  const c2 = calls.promptAsync.at(-1);
  check(
    "(2) lead sem agent -> injeta lead_agent:'dante'",
    c2?.agent === "dante" && c2?.sessionID === LEAD_SES,
    JSON.stringify(c2),
  );
  check(
    "(2) resolveAgentForSession(db, leadSes) === 'dante'",
    resolveAgentForSession(db, LEAD_SES) === "dante",
  );

  // --- Cenário 2b: lead legado (lead_agent NULL) -> agente DESCONHECIDO ---
  // TICKET-RELEASE-09: `lead_agent = NULL` significa "não sei qual é a
  // persona" — NUNCA "dante". O choke point repassa o payload VERBATIM (sem
  // `agent`) para o servidor preservar o vínculo nativo da sessão; o fallback
  // hardcoded é exatamente o sequestrador que este ticket elimina.
  await client.session.promptAsync({ sessionID: LEGACY_LEAD_SES, text: "Legacy wake." });
  const c2b = calls.promptAsync.at(-1);
  check(
    "(2) lead legado (lead_agent NULL) -> verbatim, SEM persona inventada",
    c2b?.agent === undefined && c2b?.sessionID === LEGACY_LEAD_SES && c2b?.text === "Legacy wake.",
    JSON.stringify(c2b),
  );
  check(
    "(2) resolveAgentForSession(db, leadLegacyNull) === undefined",
    resolveAgentForSession(db, LEGACY_LEAD_SES) === undefined,
    String(resolveAgentForSession(db, LEGACY_LEAD_SES)),
  );

  // --- Cenário 3: agent explícito NUNCA é sobrescrito ---
  await client.session.promptAsync({ sessionID: MEM_SES, text: "Explícito.", agent: "custom-agent" });
  const c3 = calls.promptAsync.at(-1);
  check(
    "(3) agent explícito preservado ('custom-agent', não 'hugo')",
    c3?.agent === "custom-agent" && c3?.text === "Explícito.",
    JSON.stringify(c3),
  );
  // string vazia é tratada como ausente -> resolve o membro
  await client.session.promptAsync({ sessionID: MEM_SES, text: "Vazio.", agent: "" });
  const c3b = calls.promptAsync.at(-1);
  check(
    "(3) agent string vazia tratada como ausente -> injeta 'hugo'",
    c3b?.agent === "hugo",
    JSON.stringify(c3b),
  );
  // agent null idem
  await client.session.promptAsync({ sessionID: LEAD_SES, text: "Null.", agent: null });
  const c3c = calls.promptAsync.at(-1);
  check("(3) agent null tratado como ausente -> injeta 'dante'", c3c?.agent === "dante", JSON.stringify(c3c));

  // --- Cenário 4: sessão desconhecida -> verbatim, sem erro ---
  let threw = null;
  try {
    await client.session.promptAsync({ sessionID: UNKNOWN_SES, text: "Desconhecido." });
  } catch (e) {
    threw = e instanceof Error ? e.message : String(e);
  }
  const c4 = calls.promptAsync.at(-1);
  check(
    "(4) sessão desconhecida -> repassa VERBATIM (sem agent, sem erro)",
    threw === null && !hasKey(c4, "agent") && c4?.text === "Desconhecido.",
    `err=${threw ?? "none"} rec=${JSON.stringify(c4)}`,
  );
  check("(4) resolveAgentForSession(db, unknown) === undefined", resolveAgentForSession(db, UNKNOWN_SES) === undefined);
  check("(4) resolveAgentForSession(db, '') === undefined", resolveAgentForSession(db, "") === undefined);

  // sessionID ausente -> verbatim (nunca inventa persona)
  await client.session.promptAsync({ text: "Sem sessão." });
  const c4b = calls.promptAsync.at(-1);
  check("(4) sessionID ausente -> verbatim (sem agent)", !hasKey(c4b, "agent"), JSON.stringify(c4b));

  // --- (3b) membro com agent '' no DB -> cai para undefined, nunca inventa ---
  await client.session.promptAsync({ sessionID: EMPTY_AGENT_SES, text: "Agent vazio no DB." });
  const c3d = calls.promptAsync.at(-1);
  check(
    "(3b) membro com agent '' no DB -> verbatim (sem persona inventada)",
    !hasKey(c3d, "agent"),
    JSON.stringify(c3d),
  );

  // --- Regressão: sem resolver, o wrapper preserva o pass-through legado ---
  const legacy = makeRaw();
  const legacyClient = wrapThrowingClient(legacy.raw);
  await legacyClient.session.promptAsync({ sessionID: MEM_SES, text: "Legado." });
  check(
    "(regressão) wrapThrowingClient SEM resolver -> pass-through verbatim",
    !hasKey(legacy.calls.promptAsync.at(-1), "agent"),
    JSON.stringify(legacy.calls.promptAsync.at(-1)),
  );

  // --- Regressão: erro do raw client continua virando throw (throwing wrapper) ---
  const errRaw = makeRaw();
  errRaw.raw.session.promptAsync = async () => ({ error: { message: "boom" } });
  const errClient = wrapThrowingClient(errRaw.raw, resolver);
  let caught = null;
  try {
    await errClient.session.promptAsync({ sessionID: MEM_SES, text: "x" });
  } catch (e) {
    caught = e instanceof Error ? e.message : String(e);
  }
  check("(regressão) resposta {error} do raw -> throw preservado", caught === "boom", caught ?? "sem throw");

  // Total de chamadas registradas (sanidade do seam)
  check(
    "seam registrou todas as chamadas promptAsync do choke point",
    calls.promptAsync.length === 9,
    `n=${calls.promptAsync.length}`,
  );
}

// ---------------------------------------------------------------------------
// 4. Transporte V2 — deliverPrompt(port, sessionID, text, agent)
// ---------------------------------------------------------------------------
{
  const order = [];
  const port = {
    switchAgent: async (input) => {
      order.push(["switchAgent", input]);
      return {};
    },
    prompt: async (input) => {
      order.push(["prompt", input]);
      return {};
    },
  };

  // --- Cenário 5: agent informado -> switchAgent ANTES do prompt ---
  await deliverPrompt(port, MEM_SES, "Nudge V2.", "hugo");
  check(
    "(5) V2: switchAgent chamado ANTES do prompt",
    order.length === 2 && order[0][0] === "switchAgent" && order[1][0] === "prompt",
    order.map(([k]) => k).join("->"),
  );
  check(
    "(5) V2: switchAgent recebe { sessionID, agent:'hugo' }",
    order[0][1].sessionID === MEM_SES && order[0][1].agent === "hugo",
    JSON.stringify(order[0][1]),
  );
  check(
    "(5) V2: prompt recebe { sessionID, text, delivery:'queue' } SEM agent",
    JSON.stringify(order[1][1]) === JSON.stringify({ sessionID: MEM_SES, text: "Nudge V2.", delivery: "queue" }),
    JSON.stringify(order[1][1]),
  );

  // --- Cenário 5b: agent undefined -> nenhum switchAgent, prompt verbatim ---
  order.length = 0;
  await deliverPrompt(port, UNKNOWN_SES, "Desconhecido V2.", undefined);
  check(
    "(5) V2: agent undefined -> SOMENTE prompt (sem switchAgent)",
    order.length === 1 && order[0][0] === "prompt" && order[0][1].sessionID === UNKNOWN_SES,
    order.map(([k]) => k).join("->") || "(vazio)",
  );

  // --- Cenário 5c: port sem switchAgent -> degrada para verbatim sem lançar ---
  const noSwitchOrder = [];
  const portNoSwitch = {
    prompt: async (input) => {
      noSwitchOrder.push(input);
      return {};
    },
  };
  let v2Threw = null;
  try {
    await deliverPrompt(portNoSwitch, MEM_SES, "Sem switchAgent.", "hugo");
  } catch (e) {
    v2Threw = e instanceof Error ? e.message : String(e);
  }
  check(
    "(5) V2: port sem switchAgent degrada para entrega verbatim (sem throw)",
    v2Threw === null && noSwitchOrder.length === 1 && noSwitchOrder[0].sessionID === MEM_SES,
    `err=${v2Threw ?? "none"}`,
  );

  // --- Integração: resolver real do DB alimenta deliverPrompt ---
  const integOrder = [];
  const integPort = {
    switchAgent: async (i) => {
      integOrder.push(["switchAgent", i]);
      return {};
    },
    prompt: async (i) => {
      integOrder.push(["prompt", i]);
      return {};
    },
  };
  const leadAgent = resolveAgentForSession(db, LEAD_SES);
  await deliverPrompt(integPort, LEAD_SES, "Wake integrado.", leadAgent);
  check(
    "(5+) integração DB->deliverPrompt: lead session reafirma persona 'dante'",
    integOrder.length === 2 && integOrder[0][1].agent === "dante" && integOrder[1][0] === "prompt",
    integOrder.map(([k, v]) => (k === "switchAgent" ? `${k}:${v.agent}` : k)).join("->"),
  );
}

// ---------------------------------------------------------------------------
// 5. Paridade src↔dist e anti-mock.
// ---------------------------------------------------------------------------
{
  check(
    "src/client.ts contém o choke point throwingPromptAsync (injeção V1)",
    clientSrc.includes("throwingPromptAsync") && clientSrc.includes("agentResolver"),
  );
  check(
    "src/v2-session.ts reafirma persona via switchAgent ANTES do prompt",
    /if\s*\(agent\)\s*await\s*port\.switchAgent/.test(v2Src),
  );
  check(
    "src/member-model.ts documenta a resolução fail-safe (sem fallback inventado)",
    memberSrc.includes("resolveAgentForSession") && memberSrc.includes("undefined"),
  );
  check(
    "dist contém o choke point de injeção (paridade com src)",
    distRaw.includes("throwingPromptAsync") && distRaw.includes("switchAgent"),
  );

  const FORBIDDEN = ["je" + "st.mock", "sin" + "on", "vi.mo" + "ck", "mockImple" + "mentation"];
  const forbiddenRe = new RegExp(FORBIDDEN.join("|"), "i");
  let srcMocks = 0;
  const walk = (dir) => {
    for (const entry of readdirSync(dir)) {
      const full = path.join(dir, entry);
      if (statSync(full).isDirectory()) walk(full);
      else if (entry.endsWith(".ts")) {
        if (forbiddenRe.test(readFileSync(full, "utf8"))) srcMocks++;
      }
    }
  };
  walk(SRC);
  check("(anti-mock) zero mocks proibidos em produção sob src/", srcMocks === 0, `achados=${srcMocks}`);
  check(
    "(anti-mock) a própria suíte não contém mocks proibidos",
    !forbiddenRe.test(readFileSync(import.meta.filename, "utf8")),
  );
}

const passed = results.filter(([, ok]) => ok).length;
const total = results.length;
console.log(`\nRESULT: ${passed}/${total} checks passed, ${unhandled.length} unhandled rejections`);
process.exit(passed === total && unhandled.length === 0 ? 0 : 1);
