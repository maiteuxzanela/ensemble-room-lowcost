#!/usr/bin/env node
/**
 * QUALITY GATE DETERMINÍSTICO — TICKET-RELEASE-09 (Persona Sequester Fix)
 * @maiteuxzanela/ensemble-room-lowcost
 *
 * Engenheiro de Backend: Davi. SDET: Hugo. Guardiã do Quality Gate: Clara.
 *
 * Bug sob teste (três elos, todos fechados nesta suíte):
 *   1. `team_create` NUNCA gravava `team.lead_agent` (NULL em 100% das salas);
 *   2. `resolveAgentForSession` cobria o NULL com o fallback hardcoded "dante";
 *   3. o choke point (`wrapThrowingClient`) re-injetava esse "dante" no
 *      `session.promptAsync` → o servidor rebindava a sessão do lead para a
 *      persona de Dante (Iris, Nora, Selene… todas viravam Dante).
 *
 * Cobertura:
 *   A. `executeTeamCreate` persiste `lead_agent` da persona real da sessão
 *      criadora (nora / iris / custom-orchestrator) via session.get.
 *   B. `resolveAgentForSession` devolve `undefined` para lead_agent NULL/vazio
 *      (nunca "dante"); membro → seu agent; time arquivado → undefined.
 *   C. Auto-cura (`ensureTeamLeadAgent`): sala ativa com lead_agent NULL é
 *      reconciliada a partir de session.get, com UPDATE condicional idempotente;
 *      `decision_lead` cura ANTES do wake e usa a persona real.
 *   D. Wake (`decision_lead` / `notifyLead`) NÃO muta a persona: o payload leva
 *      o agente original, nunca "dante", e o vínculo da sessão é preservado.
 *   E. Lead desconhecido (NULL + session.get sem agent): NENHUM `agent`
 *      hardcoded entra no payload — o campo fica ausente e o vínculo nativo
 *      da sessão sobrevive.
 *   F. Rota do dashboard (POST /api/chat/send com to="lead"), que também
 *      acorda o lead: sala NULL → auto-cura/omissão da chave `agent` (nunca
 *      "dante"); sala 'iris' → `agent='iris'` com vínculo preservado; sala
 *      curada → persona real descoberta via session.get e persistida.
 *
 * SEM MOCKS: SQLite REAL (node:sqlite via createDb) em .test-scratch e o bundle
 * REAL (dist) + cópia mecânica do src (só resolução de extensão de import).
 * O único seam é o transporte de saída do SDK do OpenCode (session.create /
 * session.get / promptAsync / showToast), gravado em arrays de captura —
 * exatamente o carve-out documentado do repositório. Nenhuma lógica de decisão
 * é substituída.
 *
 * Uso: node tests/test_release_09_persona_sequester.mjs
 * Exit: 0 = todos os checks PASS; 1 = há FAIL.
 */

import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync, cpSync } from "node:fs";
import net from "node:net";
import path from "node:path";

const REPO = path.resolve(import.meta.dirname, "..");
const PKG = process.env.ENSEMBLE_PKG || REPO;
const DIST = path.join(PKG, "dist/index.js");
const SRC = path.join(REPO, "src");
const TMP = path.join(REPO, ".test-scratch");
const ROOT = path.join(TMP, "release09_persona_sequester");
const HARNESS = path.join(TMP, "_release09_persona_harness.mjs");
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
// 0. Harness DIST — bundle real + exports ausentes anexados (sem mocks).
// ---------------------------------------------------------------------------
const REQUIRED_SYMBOLS = [
  "createDb",
  "executeTeamCreate",
  "executeDecisionLead",
  "notifyLead",
  "ensureTeamLeadAgent",
  "resolveAgentForSession",
  "resolveLeadWakeContext",
  "wrapThrowingClient",
  "MemberRegistry",
  "DEFAULT_CONFIG",
  "startDashboard",
];
const distRaw = readFileSync(DIST, "utf8");
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
  writeFileSync(HARNESS, distRaw + (need.length ? `\nexport { ${need.join(", ")} };\n` : ""));
}

// ---------------------------------------------------------------------------
// 0b. Harness SRC — cópia fora de node_modules + resolução mecânica de extensão.
// ---------------------------------------------------------------------------
const SRC_COPY = path.join(TMP, "_release09_src_copy");
function prepareSrcCopy() {
  rmSync(SRC_COPY, { recursive: true, force: true });
  cpSync(SRC, SRC_COPY, { recursive: true });
  let rewritten = 0;
  const walk = (dir) =>
    readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
      e.isDirectory() ? walk(path.join(dir, e.name)) : [path.join(dir, e.name)],
    );
  for (const file of walk(SRC_COPY)) {
    if (!/\.(ts|tsx)$/.test(file)) continue;
    const before = readFileSync(file, "utf8");
    const after = before.replace(/(from\s+["'])(\.\.?\/[^"']+)(["'])/g, (m, a, spec, c) => {
      const base = path.resolve(path.dirname(file), spec);
      for (const ext of [".ts", ".tsx", "/index.ts", "/index.tsx"]) {
        if (existsSync(base + ext) && !spec.endsWith(ext)) {
          rewritten++;
          return a + spec + ext + c;
        }
      }
      return m;
    });
    if (after !== before) writeFileSync(file, after);
  }
  return rewritten;
}
const rewrittenSpecifiers = prepareSrcCopy();
check("cópia do src preparada (só extensão de import, lógica intacta)", rewrittenSpecifiers > 0, `${rewrittenSpecifiers} specifiers`);

async function loadDist() {
  return import(HARNESS);
}
async function loadSrc() {
  const pick = async (rel, names) => {
    const mod = await import(path.join(SRC_COPY, rel));
    return Object.fromEntries(names.map((n) => [n, mod[n]]));
  };
  return {
    ...(await pick("db.ts", ["createDb"])),
    ...(await pick("tools/team-create.ts", ["executeTeamCreate"])),
    ...(await pick("tools/decision-lead.ts", ["executeDecisionLead"])),
    ...(await pick("notify.ts", ["notifyLead", "resolveLeadWakeContext"])),
    ...(await pick("lead-agent.ts", ["ensureTeamLeadAgent", "resolveSessionAgent"])),
    ...(await pick("member-model.ts", ["resolveAgentForSession"])),
    ...(await pick("client.ts", ["wrapThrowingClient"])),
    ...(await pick("state.ts", ["MemberRegistry"])),
    ...(await pick("config.ts", ["DEFAULT_CONFIG"])),
    ...(await pick("dashboard.ts", ["startDashboard"])),
  };
}

function getFreePort() {
  return new Promise((resolve) => {
    const srv = net.createServer();
    srv.listen(0, "127.0.0.1", () => {
      const port = srv.address().port;
      srv.close(() => resolve(port));
    });
  });
}

async function waitFor(predicate, timeoutMs = 3000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (predicate()) return true;
    await new Promise((r) => setTimeout(r, 10));
  }
  return predicate();
}

// ---------------------------------------------------------------------------
// 1. Suíte comportamental (roda em dist E src).
// ---------------------------------------------------------------------------
const TS = Date.now();

function seedTeam(db, { id, name, leadSession, leadAgent }) {
  db.run(
    `INSERT INTO project (id, name, path, status, time_created, time_updated)
     VALUES ('default', 'Default', '', 'active', ?, ?) ON CONFLICT DO NOTHING`,
    [TS, TS],
  );
  db.run(
    `INSERT INTO team (id, name, project_id, lead_session_id, status, delegate, time_created, time_updated, lead_agent)
     VALUES (?, ?, 'default', ?, 'active', 0, ?, ?, ?)`,
    [id, name, leadSession, TS, TS, leadAgent ?? null],
  );
}

function seedMember(db, { teamId, name, session, agent }) {
  db.run(
    `INSERT INTO team_member (team_id, name, session_id, agent, status, execution_status, time_created, time_updated)
     VALUES (?, ?, ?, ?, 'ready', 'idle', ?, ?)`,
    [teamId, name, session, agent, TS, TS],
  );
}

async function runBehavior(label, mods) {
  const {
    createDb, executeTeamCreate, executeDecisionLead, notifyLead,
    ensureTeamLeadAgent, resolveAgentForSession, resolveLeadWakeContext,
    wrapThrowingClient, MemberRegistry, DEFAULT_CONFIG, startDashboard,
  } = mods;

  const root = path.join(ROOT, label);
  rmSync(root, { recursive: true, force: true });
  mkdirSync(root, { recursive: true });
  const db = createDb(path.join(root, "ensemble.db"));

  // Seam mínimo de transporte: grava o que o SDK receberia e simula a regra
  // do servidor (agent explícito rebinda a sessão; ausência preserva).
  const calls = { promptAsync: [], toast: [], sessionGet: [] };
  const sessionAgents = new Map();
  const agentlessSession = new Set();
  const raw = {
    session: {
      create: async () => ({ data: { id: `ses_created_${calls.sessionGet.length}` } }),
      get: async ({ sessionID }) => {
        calls.sessionGet.push(sessionID);
        if (agentlessSession.has(sessionID)) return { data: { id: sessionID } };
        const agent = sessionAgents.get(sessionID);
        return { data: agent ? { id: sessionID, agent } : { id: sessionID } };
      },
      promptAsync: async (params) => {
        calls.promptAsync.push(params);
        if (typeof params.agent === "string" && params.agent.length > 0) {
          sessionAgents.set(params.sessionID, params.agent);
        }
        return {};
      },
      abort: async () => ({}),
      status: async () => ({ data: {} }),
      messages: async () => ({ data: [] }),
    },
    tui: {
      showToast: async (toast) => { calls.toast.push(toast); return {}; },
      selectSession: async () => ({}),
    },
    worktree: {
      create: async () => ({ data: { name: "wt", branch: "b", directory: root } }),
      remove: async () => ({}),
      list: async () => ({ data: [] }),
      reset: async () => ({}),
    },
    experimental: {
      workspace: {
        create: async () => ({ data: { id: "w", type: "t", branch: null, directory: null, projectID: "p" } }),
        remove: async () => ({}),
        list: async () => ({ data: [] }),
      },
    },
  };
  // Choke point REAL de produção: quando o payload omite `agent`, ele consulta
  // o resolver canônico do SQLite (o mesmo que respondia "dante" no bug).
  const client = wrapThrowingClient(raw, (sid) => resolveAgentForSession(db, sid));
  const deps = {
    db,
    registry: new MemberRegistry(),
    tracker: {},
    purgeApprovals: {},
    client,
    directory: root,
    config: { ...DEFAULT_CONFIG },
    progressTracker: { recordTaskComplete: () => {} },
  };

  /* ------------------------------------------------------------------ *
   * A. team_create persiste a persona REAL da sessão criadora.          *
   * ------------------------------------------------------------------ */
  const personas = [
    ["nora", "ses_creator_nora"],
    ["iris", "ses_creator_iris"],
    ["custom-orchestrator", "ses_creator_custom"],
  ];
  for (const [persona, sessionID] of personas) {
    sessionAgents.set(sessionID, persona);
    await executeTeamCreate(deps, { name: `room-${persona}` }, sessionID);
    const row = db.query("SELECT lead_agent, lead_session_id FROM team WHERE name = ?")
      .get(`room-${persona}`);
    check(
      `[${label}] A: sala criada por '${persona}' persiste lead_agent = '${persona}'`,
      row?.lead_agent === persona && row?.lead_session_id === sessionID,
      `lead_agent=${row?.lead_agent} session=${row?.lead_session_id}`,
    );
    check(
      `[${label}] A: resolveAgentForSession(${sessionID}) === '${persona}'`,
      resolveAgentForSession(db, sessionID) === persona,
      String(resolveAgentForSession(db, sessionID)),
    );
  }

  // Sessão criadora cujo session.get não informa agent → coluna NULL, jamais
  // uma persona inventada no ato de criação.
  agentlessSession.add("ses_creator_unknown");
  await executeTeamCreate(deps, { name: "room-unknown-creator" }, "ses_creator_unknown");
  const unknownCreated = db.query("SELECT id, lead_agent FROM team WHERE name = 'room-unknown-creator'").get();
  check(
    `[${label}] A: criador sem agent no SDK → lead_agent NULL (nada inventado)`,
    unknownCreated?.lead_agent === null,
    String(unknownCreated?.lead_agent),
  );
  check(
    `[${label}] A: resolveAgentForSession(criador desconhecido) === undefined`,
    resolveAgentForSession(db, "ses_creator_unknown") === undefined,
  );

  /* ------------------------------------------------------------------ *
   * B. resolveAgentForSession: membro / lead / NULL / arquivado.        *
   * ------------------------------------------------------------------ */
  seedTeam(db, { id: "team_b", name: "room-b", leadSession: "ses_lead_b", leadAgent: "nora" });
  seedMember(db, { teamId: "team_b", name: "tulio", session: "ses_member_b", agent: "build" });
  check(
    `[${label}] B: membro resolve para seu próprio agent ('build')`,
    resolveAgentForSession(db, "ses_member_b") === "build",
  );
  check(
    `[${label}] B: lead com lead_agent='nora' resolve 'nora' (não 'dante')`,
    resolveAgentForSession(db, "ses_lead_b") === "nora",
  );
  seedTeam(db, { id: "team_b_null", name: "room-b-null", leadSession: "ses_lead_b_null", leadAgent: null });
  check(
    `[${label}] B: lead com lead_agent NULL resolve undefined (SEM 'dante')`,
    resolveAgentForSession(db, "ses_lead_b_null") === undefined,
    String(resolveAgentForSession(db, "ses_lead_b_null")),
  );
  seedTeam(db, { id: "team_b_arch", name: "room-b-arch", leadSession: "ses_lead_b_arch", leadAgent: "iris" });
  db.run("UPDATE team SET status = 'archived' WHERE id = 'team_b_arch'");
  check(
    `[${label}] B: lead de time arquivado resolve undefined`,
    resolveAgentForSession(db, "ses_lead_b_arch") === undefined,
  );
  check(
    `[${label}] B: sessão desconhecida resolve undefined`,
    resolveAgentForSession(db, "ses_ghost_release09") === undefined,
  );

  /* ------------------------------------------------------------------ *
   * C. Auto-cura de sala ativa com lead_agent NULL.                     *
   * ------------------------------------------------------------------ */
  seedTeam(db, { id: "team_heal", name: "room-heal", leadSession: "ses_lead_heal", leadAgent: null });
  sessionAgents.set("ses_lead_heal", "iris");
  const healed = await ensureTeamLeadAgent(db, client, "team_heal");
  const healRow = db.query("SELECT lead_agent FROM team WHERE id = 'team_heal'").get();
  check(
    `[${label}] C: ensureTeamLeadAgent descobre 'iris' e persiste (NULL → 'iris')`,
    healed === "iris" && healRow?.lead_agent === "iris",
    `ret=${healed} db=${healRow?.lead_agent}`,
  );
  const getsBefore = calls.sessionGet.filter((s) => s === "ses_lead_heal").length;
  const healedAgain = await ensureTeamLeadAgent(db, client, "team_heal");
  const getsAfter = calls.sessionGet.filter((s) => s === "ses_lead_heal").length;
  check(
    `[${label}] C: auto-cura idempotente — valor conhecido não é re-consultado nem sobrescrito`,
    healedAgain === "iris" && healRow?.lead_agent === "iris" && getsAfter === getsBefore,
    `gets=${getsBefore}->${getsAfter}`,
  );

  // decision_lead cura ANTES do wake: sala legada NULL, sessão realmente 'nora'.
  seedTeam(db, { id: "team_heal_wake", name: "room-heal-wake", leadSession: "ses_lead_heal_wake", leadAgent: null });
  seedMember(db, { teamId: "team_heal_wake", name: "maya", session: "ses_maya_heal_wake", agent: "explore" });
  sessionAgents.set("ses_lead_heal_wake", "nora");
  calls.promptAsync.length = 0;
  await executeDecisionLead(deps, { question: "Qual o caminho?", context: "Contexto da cura" }, "ses_maya_heal_wake");
  const healWake = calls.promptAsync.find((p) => p.sessionID === "ses_lead_heal_wake");
  const healWakeRow = db.query("SELECT lead_agent FROM team WHERE id = 'team_heal_wake'").get();
  check(
    `[${label}] C: decision_lead cura a sala NULL ANTES do wake e usa 'nora'`,
    healWakeRow?.lead_agent === "nora" && healWake?.agent === "nora",
    `db=${healWakeRow?.lead_agent} wake=${healWake?.agent}`,
  );
  check(
    `[${label}] C: wake de sala curada NUNCA carrega 'dante'`,
    healWake?.agent !== "dante",
    String(healWake?.agent),
  );

  /* ------------------------------------------------------------------ *
   * D. Wake não muta a persona original (nora/iris).                    *
   * ------------------------------------------------------------------ */
  seedTeam(db, { id: "team_d", name: "room-d", leadSession: "ses_lead_d", leadAgent: "nora" });
  seedMember(db, { teamId: "team_d", name: "tulio", session: "ses_member_d", agent: "build" });
  sessionAgents.set("ses_lead_d", "nora");
  calls.promptAsync.length = 0;
  await executeDecisionLead(deps, { question: "Decisão D", context: "Contexto D" }, "ses_member_d");
  const dlWake = calls.promptAsync.find((p) => p.sessionID === "ses_lead_d");
  const dlRow = db.query("SELECT lead_agent FROM team WHERE id = 'team_d'").get();
  check(
    `[${label}] D: decision_lead envia agent='nora' (nunca 'dante')`,
    dlWake?.agent === "nora" && dlWake?.agent !== "dante",
    String(dlWake?.agent),
  );
  check(
    `[${label}] D: decision_lead NÃO muta team.lead_agent`,
    dlRow?.lead_agent === "nora",
    String(dlRow?.lead_agent),
  );
  check(
    `[${label}] D: vínculo da sessão do lead permanece 'nora' após o wake`,
    sessionAgents.get("ses_lead_d") === "nora",
    String(sessionAgents.get("ses_lead_d")),
  );

  seedTeam(db, { id: "team_d2", name: "room-d2", leadSession: "ses_lead_d2", leadAgent: "iris" });
  sessionAgents.set("ses_lead_d2", "iris");
  calls.promptAsync.length = 0;
  notifyLead(client, db, "team_d2", "falha irrecuperável de teste", {
    config: { ...DEFAULT_CONFIG, silentLead: true },
    forceWake: true,
  });
  const nlWake = calls.promptAsync.find((p) => p.sessionID === "ses_lead_d2");
  check(
    `[${label}] D: notifyLead(forceWake) envia agent='iris' e preserva o vínculo`,
    nlWake?.agent === "iris" && sessionAgents.get("ses_lead_d2") === "iris",
    `wake=${nlWake?.agent} session=${sessionAgents.get("ses_lead_d2")}`,
  );
  const ctx = resolveLeadWakeContext(db, "team_d2");
  check(
    `[${label}] D: resolveLeadWakeContext devolve a persona real ('iris')`,
    ctx?.leadAgent === "iris" && ctx?.leadSessionId === "ses_lead_d2",
    JSON.stringify(ctx),
  );

  /* ------------------------------------------------------------------ *
   * E. Lead desconhecido → NENHUM agent hardcoded no payload.           *
   * ------------------------------------------------------------------ */
  seedTeam(db, { id: "team_e", name: "room-e", leadSession: "ses_lead_e", leadAgent: null });
  seedMember(db, { teamId: "team_e", name: "selene", session: "ses_member_e", agent: "build" });
  agentlessSession.add("ses_lead_e");
  calls.promptAsync.length = 0;
  await executeDecisionLead(deps, { question: "Decisão E", context: "Contexto E" }, "ses_member_e");
  const eWake = calls.promptAsync.find((p) => p.sessionID === "ses_lead_e");
  check(
    `[${label}] E: decision_lead com lead desconhecido omite 'agent' do payload`,
    eWake !== undefined && !("agent" in eWake) && eWake.agent === undefined,
    JSON.stringify({ agent: eWake?.agent, keys: eWake ? Object.keys(eWake) : null }),
  );
  check(
    `[${label}] E: payload de lead desconhecido NUNCA contém 'dante'`,
    eWake?.agent !== "dante",
    String(eWake?.agent),
  );
  check(
    `[${label}] E: lead_agent NULL permanece NULL após a tentativa de cura`,
    db.query("SELECT lead_agent FROM team WHERE id = 'team_e'").get()?.lead_agent === null,
  );

  seedTeam(db, { id: "team_e2", name: "room-e2", leadSession: "ses_lead_e2", leadAgent: null });
  agentlessSession.add("ses_lead_e2");
  calls.promptAsync.length = 0;
  notifyLead(client, db, "team_e2", "erro sem persona conhecida", {
    config: { ...DEFAULT_CONFIG, silentLead: false },
    forceWake: true,
  });
  const e2Wake = calls.promptAsync.find((p) => p.sessionID === "ses_lead_e2");
  check(
    `[${label}] E: notifyLead com lead desconhecido omite 'agent' (nada hardcoded)`,
    e2Wake !== undefined && !("agent" in e2Wake),
    JSON.stringify({ agent: e2Wake?.agent, keys: e2Wake ? Object.keys(e2Wake) : null }),
  );
  check(
    `[${label}] E: vínculo da sessão desconhecida não é reescrito (permanece ausente)`,
    !sessionAgents.has("ses_lead_e2"),
  );

  /* ------------------------------------------------------------------ *
   * F. Dashboard POST /api/chat/send (to="lead") — MESMA invariante.    *
   *    Rota real de DM humana que também acorda o lead: com lead_agent  *
   *    NULL o código antigo injetava `agent: "dante"` e sequestrava a   *
   *    persona. Agora: auto-cura + persona conhecida explícita +        *
   *    omissão da chave quando desconhecida.                            *
   * ------------------------------------------------------------------ */
  {
    const port = await getFreePort();
    let server = null;
    try {
      server = await startDashboard(db, port, { client });
      check(`[${label}] F: dashboard iniciou (127.0.0.1:${port})`, server !== null, `port=${port}`);

      const tokenRes = await fetch(`http://127.0.0.1:${port}/api/session-token`).catch(() => null);
      const tokenJson = tokenRes ? await tokenRes.json().catch(() => null) : null;
      const token = tokenJson?.token ?? "";
      check(
        `[${label}] F: session token do dashboard obtido`,
        tokenRes?.status === 200 && /^[0-9a-f]{48}$/.test(token),
        `status=${tokenRes?.status ?? 0}`,
      );

      const post = async (payload) => {
        try {
          const res = await fetch(`http://127.0.0.1:${port}/api/chat/send`, {
            method: "POST",
            headers: { "Content-Type": "application/json", "x-ensemble-token": token },
            body: JSON.stringify(payload),
          });
          return { status: res.status, json: await res.json().catch(() => null) };
        } catch (err) {
          return { status: 0, json: null, err: String(err) };
        }
      };

      // F1: sala com lead_agent NULL e sessão SEM agent informado pelo SDK.
      calls.promptAsync.length = 0;
      const unknownDm = await post({ teamId: "team_e", to: "lead", text: "dm-sem-persona" });
      const unknownArrived = await waitFor(() =>
        calls.promptAsync.some((p) => p.sessionID === "ses_lead_e"));
      const unknownWake = calls.promptAsync.find((p) => p.sessionID === "ses_lead_e");
      check(
        `[${label}] F: DM ao lead de sala NULL responde 200`,
        unknownDm.status === 200 && unknownDm.json?.ok === true,
        `status=${unknownDm.status} json=${JSON.stringify(unknownDm.json)}`,
      );
      check(
        `[${label}] F: DM ao lead desconhecido → payload SEM chave 'agent' e nunca 'dante'`,
        unknownArrived && unknownWake !== undefined && !("agent" in unknownWake) && unknownWake.agent !== "dante",
        JSON.stringify({ sent: unknownArrived, agent: unknownWake?.agent, keys: unknownWake ? Object.keys(unknownWake) : null }),
      );

      // F2: sala com lead_agent='iris' → persona explícita, vínculo intacto.
      calls.promptAsync.length = 0;
      const irisDm = await post({ teamId: "team_d2", to: "lead", text: "dm-persona-iris" });
      const irisArrived = await waitFor(() =>
        calls.promptAsync.some((p) => p.sessionID === "ses_lead_d2"));
      const irisWake = calls.promptAsync.find((p) => p.sessionID === "ses_lead_d2");
      check(
        `[${label}] F: DM ao lead com lead_agent='iris' envia agent='iris'`,
        irisDm.status === 200 && irisArrived && irisWake?.agent === "iris",
        `status=${irisDm.status} agent=${irisWake?.agent}`,
      );
      check(
        `[${label}] F: vínculo da sessão 'iris' preservado após DM do dashboard`,
        sessionAgents.get("ses_lead_d2") === "iris",
        String(sessionAgents.get("ses_lead_d2")),
      );

      // F3: auto-cura TAMBÉM nesta rota (sala NULL, sessão realmente 'selene').
      seedTeam(db, { id: "team_f", name: "room-f", leadSession: "ses_lead_f", leadAgent: null });
      sessionAgents.set("ses_lead_f", "selene");
      calls.promptAsync.length = 0;
      const healDm = await post({ teamId: "team_f", to: "lead", text: "dm-auto-cura" });
      const healArrived = await waitFor(() =>
        calls.promptAsync.some((p) => p.sessionID === "ses_lead_f"));
      const healWake = calls.promptAsync.find((p) => p.sessionID === "ses_lead_f");
      const healDbAgent = db.query("SELECT lead_agent FROM team WHERE id = 'team_f'").get()?.lead_agent;
      check(
        `[${label}] F: DM ao lead cura sala NULL e envia a persona real ('selene')`,
        healDm.status === 200 && healArrived && healWake?.agent === "selene" && healDbAgent === "selene",
        `status=${healDm.status} agent=${healWake?.agent} db=${healDbAgent}`,
      );
    } finally {
      server?.stop?.(true);
    }
  }

  db.close?.();
}

// ---------------------------------------------------------------------------
// 2. Execução dist + src.
// ---------------------------------------------------------------------------
for (const [label, loader] of [["dist", loadDist], ["src", loadSrc]]) {
  console.log(`\n--- ${label} ---`);
  await runBehavior(label, await loader());
}

// ---------------------------------------------------------------------------
// 3. Paridade estática: o fallback hardcoded não voltou; docs coerentes.
// ---------------------------------------------------------------------------
{
  const memberSrc = readFileSync(path.join(SRC, "member-model.ts"), "utf8");
  const leadAgentSrc = readFileSync(path.join(SRC, "lead-agent.ts"), "utf8");
  const teamCreateSrc = readFileSync(path.join(SRC, "tools", "team-create.ts"), "utf8");
  check(
    "src/member-model.ts não executa mais o fallback hardcoded (código, não comentário)",
    !/return\s+lead\.lead_agent\s*\?\?\s*["']dante["']/.test(memberSrc) &&
      /return\s+lead\.lead_agent\s*\|\|\s*undefined/.test(memberSrc),
  );
  check(
    "src/tools/team-create.ts grava a coluna lead_agent no INSERT",
    /INSERT INTO team \([^)]*lead_agent[^)]*\)/.test(teamCreateSrc),
  );
  check(
    "src/lead-agent.ts implementa auto-cura condicional (lead_agent IS NULL)",
    /lead_agent IS NULL/.test(leadAgentSrc),
  );
  check(
    "dist contém a auto-cura e o resolver canônico (paridade com src)",
    distRaw.includes("ensureTeamLeadAgent") && distRaw.includes("resolveSessionAgent"),
  );
  const dashboardSrc = readFileSync(path.join(SRC, "dashboard.ts"), "utf8");
  check(
    "src/dashboard.ts não injeta mais a persona hardcoded 'dante' no lead (código)",
    !/^\s*agent:\s*team\.lead_agent\s*\?\?\s*["']dante["']/m.test(dashboardSrc) &&
      /ensureTeamLeadAgent\(db, client, teamId\)/.test(dashboardSrc),
  );
  check(
    "dist não contém o fallback hardcoded do dashboard para o lead (código)",
    !/^\s*agent:\s*team\.lead_agent\s*\?\?\s*["']dante["']/m.test(distRaw),
  );

  const FORBIDDEN = ["je" + "st.mock", "sin" + "on", "vi.mo" + "ck", "mockImple" + "mentation"];
  const forbiddenRe = new RegExp(FORBIDDEN.join("|"), "i");
  let srcMocks = 0;
  const walk = (dir) => {
    for (const entry of readdirSync(dir)) {
      const full = path.join(dir, entry);
      if (statSync(full).isDirectory()) walk(full);
      else if (entry.endsWith(".ts") && forbiddenRe.test(readFileSync(full, "utf8"))) srcMocks++;
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
