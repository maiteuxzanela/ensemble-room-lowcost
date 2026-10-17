#!/usr/bin/env node
/**
 * QUALITY GATE DETERMINÍSTICO — FALLBACK HARDENING (TICKET-HARNESS-13/15
 * + achados Diana 1/2) do @maiteuxzanela/ensemble-room-lowcost — T4.
 *
 * Sob teste (código REAL, não simulado):
 *   - src/config.ts    → parseModelSelector/formatModelSelector (contrato
 *                        VARIANT_ABSENT_SENTINEL "default"), selectNextFallback
 *                        (normalização ANTES do casar com a cadeia — nunca
 *                        reinicia em chain[0]), resolveFallbackChainForAgent
 *                        (precedência por-agente + simetria resolveBasePersona),
 *                        loadConfig (merge PROFUNDO de fallbackModelsByAgent
 *                        DEFAULT → global → projeto).
 *   - src/hooks.ts     → handleRetryModelFailover: caminho MEMBRO (agent
 *                        explícito = team_member.agent) × caminho ISOLADO/LEAD
 *                        (agent descoberto; cadeia EXPLícITA obrigatória;
 *                        HARNESS-13: exaustão NÃO acorda o lead).
 *   - src/notify.ts    → notifyLead (HARNESS-15 B): wake ciente do modelo —
 *                        agent explícito + degrau de retry da cadeia;
 *                        assinatura retrocompatível (opções opcionais).
 *   - src/db.ts/schema → SQLite REAL (node:sqlite) com TODAS as migrations.
 *   - src/state.ts     → MemberRegistry real.
 *   - dist/index.js    → paridade byte-funcional do bundle real.
 *
 * Único ponto de emenda do dist: cláusulas de export anexadas à cópia do
 * bundle (mesmo padrão homologado em test_fallback_models.mjs). O único
 * "client" injetado é o TRANSPORT RECORDER homologado (promptAsync / abort /
 * session.get capturados; falha de transporte injetável apenas no wake do
 * notifyLead) — nenhum mock library, nenhum stub de banco, nenhuma fixture
 * falsa de parser. Bancos são SQLite REAIS; ensemble.json é JSON REAL em
 * disco (HOME isolado em mkdtemp).
 *
 * Invariantes verificadas (mandato do ticket T4):
 *   (a) variante "default": a cadeia isolada da Diana caminha
 *       argon-contributor (variant "default") → gpt-6-luna ("default") →
 *       antigravity#high → exhausted SEM loop no chain[0];
 *   (b) promptAsync recebe o 'agent' correto (membro: member.agent;
 *       isolado/lead: agente descoberto) — nunca omitido nem "dante" indevido;
 *   (c) failover da sessão de LEAD com cadeia EXPLícITA em
 *       fallbackModelsByAgent; SEM cadeia → no-op; board de membros intocado;
 *   (d) HARNESS-13: exaustão do membro NÃO dispara wake ao lead
 *       (0 promptAsync ao lead, 0 team_message);
 *   (e) merge profundo de fallbackModelsByAgent (projeto parcial não apaga a
 *       chave global);
 *   (f) simetria resolveBasePersona em resolveFallbackChainForAgent.
 *
 * Uso:  node tests/test_fallback_hardening.mjs
 * Exit: 0 = todos os checks PASS; 1 = há FAIL.
 */

import { cpSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync, mkdtempSync } from "node:fs";
import path from "node:path";

// Pacote sob teste: a raiz deste repositório (src/ + dist/ locais).
const REPO = path.resolve(import.meta.dirname, "..");
const PKG = process.env.ENSEMBLE_PKG || REPO;
const DIST = path.join(PKG, "dist/index.js");
const SRC = path.join(PKG, "src");
// Scratch isolado, recriado a cada execução e coberto pelo .gitignore.
const TMP = path.join(REPO, ".test-scratch");
mkdirSync(TMP, { recursive: true });

const results = [];
const check = (name, ok, detail) => {
  results.push([name, ok]);
  console.log(`${ok ? "PASS" : "FAIL"} | ${name}${detail ? " | " + detail : ""}`);
};
const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);

const unhandled = [];
process.on("unhandledRejection", (e) => unhandled.push(e));

/* ------------------------------------------------------------------ *
 * 1. Harness do dist: cópia byte-a-byte + apenas cláusulas de export  *
 * ------------------------------------------------------------------ */
const HARNESS = path.join(TMP, "_fallback_hardening_harness.mjs");
const DIST_EXPORTS = [
  "parseModelSelector", "formatModelSelector", "selectNextFallback",
  "resolveFallbackChainForAgent", "resolveFallbackChain", "loadConfig",
  "DEFAULT_CONFIG", "handleRetryModelFailover", "notifyLead",
  "failoverCooldown", "FAILOVER_COOLDOWN_MS", "MemberRegistry", "createDb",
];
{
  const distRaw = readFileSync(DIST, "utf8");
  const existing = distRaw.match(/export\s*\{([^}]*)\}\s*;?\s*$/)?.[1] ?? "";
  const already = new Set(existing.split(",").map((s) => s.trim().split(/\s+as\s+/).pop()).filter(Boolean));
  const need = DIST_EXPORTS.filter((s) => !already.has(s));
  const append = need.length ? `\nexport { ${need.join(", ")} };\n` : "";
  writeFileSync(HARNESS, distRaw + append);
  check(
    "harness do dist é o bundle real + apenas cláusulas de export anexadas",
    readFileSync(HARNESS, "utf8") === distRaw + append,
    `${distRaw.length} bytes de bundle; anexados=[${need.join(",")}]`,
  );
}

/* ------------------------------------------------------------------ *
 * 2. Harness do src: cópia fora de node_modules + extensão .ts        *
 * ------------------------------------------------------------------ */
const SRC_COPY = path.join(TMP, "ensemble_src_hardening");
{
  rmSync(SRC_COPY, { recursive: true, force: true });
  cpSync(SRC, SRC_COPY, { recursive: true });
  let rewritten = 0;
  const walk = (dir) =>
    readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
      e.isDirectory() ? walk(path.join(dir, e.name)) : [path.join(dir, e.name)],
    );
  for (const file of walk(SRC_COPY)) {
    if (!/\.(ts|tsx)$/.test(file)) continue;
    const text = readFileSync(file, "utf8");
    const next = text.replace(/(from\s+["'])(\.{1,2}\/[^"']+)(["'])/g, (m, a, spec, c) => {
      for (const ext of [".ts", ".tsx", "/index.ts", "/index.tsx"]) {
        try {
          readFileSync(path.resolve(path.dirname(file), spec + ext));
          rewritten++;
          return a + spec + ext + c;
        } catch { /* tenta próximo */ }
      }
      return m;
    });
    if (next !== text) writeFileSync(file, next);
  }
  check("cópia do src preparada (só extensão de import, lógica intacta)", rewritten > 0, `${rewritten} specifiers`);
}

/* ------------------------------------------------------------------ *
 * 3. Imports dos módulos reais                                        *
 * ------------------------------------------------------------------ */
const configMod = await import(`${SRC_COPY}/config.ts`);
const hooks = await import(`${SRC_COPY}/hooks.ts`);
const notifyMod = await import(`${SRC_COPY}/notify.ts`);
const stateMod = await import(`${SRC_COPY}/state.ts`);
const dbMod = await import(`${SRC_COPY}/db.ts`);
const distMod = await import(HARNESS);
check(
  "módulos reais carregados (config, hooks, notify, state, db, dist)",
  typeof configMod.selectNextFallback === "function"
    && typeof hooks.handleRetryModelFailover === "function"
    && typeof notifyMod.notifyLead === "function"
    && typeof distMod.resolveFallbackChainForAgent === "function",
);

const {
  parseModelSelector, formatModelSelector, selectNextFallback,
  resolveFallbackChainForAgent, resolveFallbackChain, loadConfig, DEFAULT_CONFIG,
} = configMod;
const { handleRetryModelFailover, failoverCooldown, FAILOVER_COOLDOWN_MS } = hooks;
const { notifyLead } = notifyMod;
const { MemberRegistry } = stateMod;
const { createDb } = dbMod;

/* ------------------------------------------------------------------ *
 * 4. Cadeias de referência (mandato global: Diana dedicada)           *
 * ------------------------------------------------------------------ */
const GLOBAL_CHAIN = ["prov/global-1#low", "prov/global-2"];
const DIANA_CHAIN = [
  "opencode-go/gemini-4-argon-contributor",
  "opencode-go/gpt-6-luna",
  "google/antigravity-gemini-3.8-flash#high",
];
const DIANA_REFS = [
  { model: "opencode-go/gemini-4-argon-contributor" },
  { model: "opencode-go/gpt-6-luna" },
  { model: "google/antigravity-gemini-3.8-flash", variant: "high" },
];
const GLOBAL_REFS = [
  { model: "prov/global-1", variant: "low" },
  { model: "prov/global-2" },
];
const CFG = { ...DEFAULT_CONFIG, fallbackModels: GLOBAL_CHAIN, fallbackModelsByAgent: { diana: DIANA_CHAIN } };
const dianaChain = resolveFallbackChainForAgent(CFG, "diana");

/* ------------------------------------------------------------------ *
 * 5. Fixtures reais: SQLite + registry + transport recorder           *
 * ------------------------------------------------------------------ */
let dbSeq = 0;
function makeDb() {
  const file = path.join(TMP, `hardening_${process.pid}_${dbSeq++}.sqlite`);
  rmSync(file, { force: true });
  rmSync(`${file}-wal`, { force: true });
  rmSync(`${file}-shm`, { force: true });
  return createDb(file);
}

/**
 * Transport recorder — mesmo seam homologado em test_per_agent_fallback.mjs.
 * `sessionInfo` (opcional, objeto ou função) devolve o payload V2 real-shaped
 * lido pela descoberta da sessão isolada/lead (client.session.get).
 */
function makeClient(sessionInfo) {
  const calls = { promptAsync: [], showToast: [], abort: [], sessionGet: [] };
  return {
    calls,
    session: {
      promptAsync: async (options) => { calls.promptAsync.push(options); return undefined; },
      abort: async (options) => { calls.abort.push(options); return undefined; },
      ...(sessionInfo !== undefined
        ? {
            get: async (options) => {
              calls.sessionGet.push(options);
              return typeof sessionInfo === "function" ? sessionInfo(options) : sessionInfo;
            },
          }
        : {}),
    },
    tui: { showToast: async (options) => { calls.showToast.push(options); return undefined; } },
  };
}

const LEAD_SESSION = "lead-hard-1";

/** Insert a real active team + one member row (real schema, real migrations). */
function seedMember(db, { teamId, memberName, sessionId, agent = "build", model = "prov/primary", status = "busy", teamStatus = "active", leadSession = LEAD_SESSION, leadAgent = null } = {}) {
  const now = Date.now();
  db.run(
    `INSERT OR IGNORE INTO team (id, name, lead_session_id, status, delegate, time_created, time_updated, lead_agent)
     VALUES (?, ?, ?, ?, 0, ?, ?, ?)`,
    [teamId, `name-${teamId}`, leadSession, teamStatus, now, now, leadAgent],
  );
  if (teamStatus !== "active") db.run("UPDATE team SET status = ? WHERE id = ?", [teamStatus, teamId]);
  db.run(
    `INSERT INTO team_member (team_id, name, session_id, agent, status, execution_status, model, prompt, time_created, time_updated)
     VALUES (?, ?, ?, ?, ?, 'running', ?, 'do the work', ?, ?)`,
    [teamId, memberName, sessionId, agent, status, model, now, now],
  );
  const registry = new MemberRegistry();
  registry.register(teamId, memberName, sessionId);
  return { registry, sessionId, memberName, teamId };
}

const getMember = (db, teamId, name) =>
  db.query("SELECT model, status, agent FROM team_member WHERE team_id = ? AND name = ?").get(teamId, name);
const totalMessages = (db) => db.query("SELECT COUNT(*) AS n FROM team_message").get().n;
const leadWakes = (client, sessionId) => client.calls.promptAsync.filter((c) => c.sessionID === sessionId).length;
/** Every captured promptAsync must carry a non-empty explicit agent. */
const agentsExplicit = (client) => client.calls.promptAsync.every((c) => typeof c.agent === "string" && c.agent.length > 0);
const clearCooldown = () => failoverCooldown.clear();
/** Deterministic cooldown expiry — sem sleep. */
const expireCooldown = (key) => failoverCooldown.set(key, Date.now() - FAILOVER_COOLDOWN_MS - 1_000);

/* ------------------------------------------------------------------ *
 * 6. (a) Variante "default" — contrato VARIANT_ABSENT_SENTINEL       *
 * ------------------------------------------------------------------ */
check(
  "a1: parseModelSelector('p/m#default') descarta a variante sentinela",
  eq(parseModelSelector("opencode-go/gpt-6-luna#default"), { providerID: "opencode-go", modelID: "gpt-6-luna" })
    && parseModelSelector("opencode-go/gpt-6-luna#default").variant === undefined,
  JSON.stringify(parseModelSelector("opencode-go/gpt-6-luna#default")),
);
check(
  "a2: formatModelSelector NUNCA emite '#default'",
  formatModelSelector({ model: "opencode-go/gpt-6-luna", variant: "default" }) === "opencode-go/gpt-6-luna"
    && !formatModelSelector({ model: "opencode-go/gpt-6-luna", variant: "default" }).includes("#"),
);
check(
  "a3: selectNextFallback normaliza '#default' ANTES de casar — argon#default → gpt-6-luna (NÃO chain[0])",
  eq(selectNextFallback(dianaChain, "opencode-go/gemini-4-argon-contributor#default"), { model: "opencode-go/gpt-6-luna" }),
  JSON.stringify(selectNextFallback(dianaChain, "opencode-go/gemini-4-argon-contributor#default")),
);
check(
  "a4: gpt-6-luna#default → antigravity#high (progressão segue, sem reinício)",
  eq(selectNextFallback(dianaChain, "opencode-go/gpt-6-luna#default"), { model: "google/antigravity-gemini-3.8-flash", variant: "high" }),
);

// (a) em runtime — progressão ISOLADA completa com o servidor reportando
// variant "default" em cada rodada: argon → gpt-6-luna → antigravity#high →
// exhausted, SEM loop no chain[0].
{
  const db = makeDb();
  // Board real pré-existente — intocado pelo caminho isolado.
  const board = seedMember(db, { teamId: "team-a-board", memberName: "cris", sessionId: "sess-a-board", model: "prov/global-1#low" });
  const isoSession = "sess-a-isolated-default";
  let sessionInfo = {
    data: { agent: "diana", model: { providerID: "opencode-go", id: "gemini-4-argon-contributor", variant: "default" } },
  };
  const client = makeClient(() => sessionInfo);
  const payload = { attempt: 1, message: "429", next: Date.now() + 30_000 };

  const r1 = await handleRetryModelFailover(db, new MemberRegistry(), client, CFG, isoSession, payload);
  expireCooldown(`isolated:${isoSession}`);
  sessionInfo = { data: { agent: "diana", model: { providerID: "opencode-go", id: "gpt-6-luna", variant: "default" } } };
  const r2 = await handleRetryModelFailover(db, new MemberRegistry(), client, CFG, isoSession, payload);
  expireCooldown(`isolated:${isoSession}`);
  sessionInfo = { data: { agent: "diana", model: { providerID: "google", id: "antigravity-gemini-3.8-flash", variant: "high" } } };
  const r3 = await handleRetryModelFailover(db, new MemberRegistry(), client, CFG, isoSession, payload);

  check(
    "a5: isolada com variant 'default' → 1º salto argon (default) → gpt-6-luna",
    r1?.action === "switched" && r1.toModel === "opencode-go/gpt-6-luna" && r1.fromModel === "opencode-go/gemini-4-argon-contributor",
    JSON.stringify(r1),
  );
  check(
    "a6: 2º salto gpt-6-luna (default) → antigravity#high — NÃO reinicia no chain[0] (sem loop)",
    r2?.action === "switched" && r2.toModel === "google/antigravity-gemini-3.8-flash#high"
      && client.calls.promptAsync.every((c) => c.model?.modelID !== "gemini-4-argon-contributor"),
    JSON.stringify(r2),
  );
  check(
    "a7: 3º ciclo na última entrada → 'exhausted' (cadeia completa percorrida)",
    r3?.action === "exhausted" && r3.toModel === undefined,
    JSON.stringify(r3),
  );
  check(
    "a8: sequência de prompts exata [gpt-6-luna, antigravity] + nenhum seletor '#default' emitido",
    eq(client.calls.promptAsync.map((c) => c.model?.modelID), ["gpt-6-luna", "antigravity-gemini-3.8-flash"])
      && client.calls.promptAsync.every((c) => c.model?.variant === undefined || c.model.variant === "high")
      && !JSON.stringify(client.calls.promptAsync).includes("#default"),
    JSON.stringify(client.calls.promptAsync.map((c) => c.model)),
  );
  check(
    "a9: board de membros intocado durante a progressão isolada",
    getMember(db, board.teamId, "cris").model === "prov/global-1#low" && totalMessages(db) === 0,
  );

  // (a) no caminho MEMBRO: model persistido com sufixo '#default' também caminha.
  const mem = seedMember(db, {
    teamId: "team-a-member", memberName: "diana", sessionId: "sess-a-member",
    agent: "diana", model: "opencode-go/gpt-6-luna#default",
  });
  const memClient = makeClient();
  const memDecision = await handleRetryModelFailover(db, mem.registry, memClient, CFG, mem.sessionId, payload);
  check(
    "a10: membro com model '#default' no SQLite → antigravity#high (normalização impede restart no chain[0])",
    memDecision?.action === "switched" && memDecision.toModel === "google/antigravity-gemini-3.8-flash#high"
      && getMember(db, mem.teamId, "diana").model === "google/antigravity-gemini-3.8-flash#high",
    JSON.stringify(memDecision),
  );

  db.close();
  clearCooldown();
}

/* ------------------------------------------------------------------ *
 * 7. (b) promptAsync recebe o 'agent' correto — nunca "dante" indevido *
 * ------------------------------------------------------------------ */
{
  const db = makeDb();
  const payload = { attempt: 1, message: "429", next: Date.now() };

  // Membro: agent explícito = team_member.agent.
  const mem = seedMember(db, {
    teamId: "team-b-member", memberName: "tales-tests", sessionId: "sess-b-member",
    agent: "tales-tests", model: "prov/global-1#low",
  });
  const memClient = makeClient();
  await handleRetryModelFailover(db, mem.registry, memClient, CFG, mem.sessionId, payload);
  check(
    "b1: membro — promptAsync carrega agent EXPLÍCITO igual a team_member.agent ('tales-tests')",
    memClient.calls.promptAsync.length === 1
      && memClient.calls.promptAsync[0].agent === "tales-tests"
      && memClient.calls.promptAsync[0].synthetic === true,
    JSON.stringify(memClient.calls.promptAsync.map((c) => c.agent)),
  );

  // Isolado: agent descoberto via session.get.
  const isoClient = makeClient({ data: { agent: "diana", model: { providerID: "opencode-go", id: "gemini-4-argon-contributor" } } });
  await handleRetryModelFailover(db, new MemberRegistry(), isoClient, CFG, "sess-b-isolated", payload);
  check(
    "b2: isolada — promptAsync carrega o agent DESCOBERTO ('diana'), nunca omitido",
    isoClient.calls.promptAsync.length === 1 && isoClient.calls.promptAsync[0].agent === "diana",
    JSON.stringify(isoClient.calls.promptAsync.map((c) => c.agent)),
  );

  const all = [...memClient.calls.promptAsync, ...isoClient.calls.promptAsync];
  check(
    "b3: NENHUMA chamada sem agent e nenhuma com 'dante' indevido (invariante global da seção)",
    all.length === 2 && agentsExplicit({ calls: { promptAsync: all } }) && all.every((c) => c.agent !== "dante"),
    JSON.stringify(all.map((c) => c.agent)),
  );

  db.close();
  clearCooldown();
}

/* ------------------------------------------------------------------ *
 * 8. (c) Failover da sessão de LEAD — cadeia explícita × no-op        *
 * ------------------------------------------------------------------ */
{
  const db = makeDb();
  const board = seedMember(db, { teamId: "team-c-board", memberName: "cris", sessionId: "sess-c-board", agent: "cris", model: "prov/global-1#low" });
  const boardSnapshot = JSON.stringify(
    db.query("SELECT team_id, name, session_id, agent, status, execution_status, model FROM team_member WHERE team_id = 'team-c-board' ORDER BY name").all(),
  );
  const teamSnapshot = JSON.stringify(
    db.query("SELECT id, lead_session_id, status, lead_agent FROM team WHERE id = 'team-c-board'").get(),
  );
  const payload = { attempt: 1, message: "429", next: Date.now() };

  // c1: lead COM cadeia explícita (fallbackModelsByAgent.diana) → switched.
  const leadClient = makeClient({ data: { agent: "diana", model: { providerID: "opencode-go", id: "gemini-4-argon-contributor" } } });
  const leadDecision = await handleRetryModelFailover(db, new MemberRegistry(), leadClient, CFG, LEAD_SESSION, payload);
  check(
    "c1: lead com cadeia EXPLícITA → 'switched' na própria sessão do lead (teamId='', agent='diana')",
    leadDecision?.action === "switched" && leadDecision.teamId === "" && leadDecision.memberName === "diana"
      && leadDecision.toModel === "opencode-go/gpt-6-luna",
    JSON.stringify(leadDecision),
  );
  check(
    "c2: promptAsync do lead com agent explícito + abort no ciclo ativo",
    leadWakes(leadClient, LEAD_SESSION) === 1
      && leadClient.calls.promptAsync[0].agent === "diana"
      && leadClient.calls.promptAsync[0].model?.modelID === "gpt-6-luna"
      && leadClient.calls.abort.some((c) => c.sessionID === LEAD_SESSION),
    JSON.stringify(leadClient.calls.promptAsync),
  );
  check(
    "c3: BOARD DE MEMBROS INTACTO — team_member, team e team_message sem nenhuma escrita",
    JSON.stringify(db.query("SELECT team_id, name, session_id, agent, status, execution_status, model FROM team_member WHERE team_id = 'team-c-board' ORDER BY name").all()) === boardSnapshot
      && JSON.stringify(db.query("SELECT id, lead_session_id, status, lead_agent FROM team WHERE id = 'team-c-board'").get()) === teamSnapshot
      && totalMessages(db) === 0,
    `msgs=${totalMessages(db)}`,
  );
  const leadSecond = await handleRetryModelFailover(db, new MemberRegistry(), leadClient, CFG, LEAD_SESSION, { ...payload, attempt: 2 });
  check(
    "c4: retry no mesmo burst → 'suppressed' (cooldown isolado:<sessionId>)",
    leadSecond?.action === "suppressed" && leadWakes(leadClient, LEAD_SESSION) === 1 && leadClient.calls.abort.length === 1,
    JSON.stringify(leadSecond),
  );

  // c5: lead SEM cadeia explícita → no-op absoluto (a global nunca sequestra).
  seedMember(db, { teamId: "team-c-nochain", memberName: "ghost", sessionId: "sess-c-ghost", agent: "build", model: "prov/primary", leadSession: "lead-hard-nochain" });
  const noChainClient = makeClient({ data: { agent: "cris", model: { providerID: "prov", id: "global-1", variant: "low" } } });
  const noChainDecision = await handleRetryModelFailover(db, new MemberRegistry(), noChainClient, CFG, "lead-hard-nochain", payload);
  check(
    "c5: lead sem fallbackModelsByAgent[agent] → undefined, ZERO abort/promptAsync (a cadeia global não age)",
    noChainDecision === undefined && noChainClient.calls.promptAsync.length === 0 && noChainClient.calls.abort.length === 0,
    JSON.stringify(noChainDecision),
  );

  // c6: exaustão da cadeia do LEAD → decisão sem wake (HARNESS-13 no lead).
  seedMember(db, { teamId: "team-c-exhaust", memberName: "ghost2", sessionId: "sess-c-ghost2", agent: "build", model: "prov/primary", leadSession: "lead-hard-exhaust" });
  const exClient = makeClient({ data: { agent: "diana", model: { providerID: "google", id: "antigravity-gemini-3.8-flash", variant: "high" } } });
  const exDecision = await handleRetryModelFailover(db, new MemberRegistry(), exClient, CFG, "lead-hard-exhaust", payload);
  check(
    "c6: lead na ÚLTIMA entrada da cadeia explícita → 'exhausted' com ZERO promptAsync (HARNESS-13)",
    exDecision?.action === "exhausted" && exDecision.teamId === ""
      && exClient.calls.promptAsync.length === 0 && exClient.calls.abort.length === 0
      && totalMessages(db) === 0,
    JSON.stringify(exDecision),
  );
  check(
    "c7: board segue intocado após TODOS os ciclos de lead desta seção",
    JSON.stringify(db.query("SELECT team_id, name, session_id, agent, status, execution_status, model FROM team_member WHERE team_id = 'team-c-board' ORDER BY name").all()) === boardSnapshot
      && getMember(db, board.teamId, "cris").model === "prov/global-1#low"
      && totalMessages(db) === 0,
  );

  db.close();
  clearCooldown();
}

/* ------------------------------------------------------------------ *
 * 9. (d) HARNESS-13 — exaustão do membro NÃO dispara wake ao lead     *
 * ------------------------------------------------------------------ */
{
  const db = makeDb();
  // Chain de 1 entrada (default); membro já É a última → exaustão de saída.
  const seed = seedMember(db, {
    teamId: "team-d-ex", memberName: "ana", sessionId: "sess-d-ex",
    agent: "build", model: "google/antigravity-gemini-3.8-flash#low",
  });
  const client = makeClient();
  const cfg = { ...DEFAULT_CONFIG };

  const decision = await handleRetryModelFailover(db, seed.registry, client, cfg, seed.sessionId, {
    attempt: 1, message: "429 exceeded quota", next: Date.now() + 60_000,
  });
  check(
    "d1: membro na última entrada → action 'exhausted' com fromModel preservado",
    decision?.action === "exhausted" && decision.toModel === undefined
      && decision.fromModel === "google/antigravity-gemini-3.8-flash#low",
    JSON.stringify(decision),
  );
  check(
    "d2: 0 promptAsync na sessão do LEAD (leadSession do time) — wake suprimido",
    leadWakes(client, LEAD_SESSION) === 0,
    `leadWakes=${leadWakes(client, LEAD_SESSION)}`,
  );
  check(
    "d3: 0 promptAsync em QUALQUER sessão e 0 abort (nem relanço do próprio membro)",
    client.calls.promptAsync.length === 0 && client.calls.abort.length === 0,
    `promptAsync=${client.calls.promptAsync.length} abort=${client.calls.abort.length}`,
  );
  check(
    "d4: 0 team_message persistida (nenhuma mensagem system→lead de exaustão)",
    totalMessages(db) === 0,
    `msgs=${totalMessages(db)}`,
  );
  const second = await handleRetryModelFailover(db, seed.registry, client, cfg, seed.sessionId, { attempt: 2, message: "429", next: Date.now() });
  check(
    "d5: retry seguinte → 'suppressed' e o placar segue 0/0 (zero-noise absoluto)",
    second?.action === "suppressed" && client.calls.promptAsync.length === 0 && totalMessages(db) === 0,
    JSON.stringify(second),
  );
  check(
    "d6: cooldown do membro registrado na exaustão (burst seguinte respeita a janela)",
    failoverCooldown.has(`${seed.teamId}:${seed.memberName}`),
  );
  check(
    "d7: modelo do membro permanece na última entrada (exaustão não altera board)",
    getMember(db, seed.teamId, seed.memberName).model === "google/antigravity-gemini-3.8-flash#low",
  );

  db.close();
  clearCooldown();
}

/* ------------------------------------------------------------------ *
 * 10. (e) Merge profundo de fallbackModelsByAgent — HOME + projeto    *
 *        REAIS em disco (loadConfig do src E do dist)                 *
 * ------------------------------------------------------------------ */
{
  const FAKE_HOME = mkdtempSync(path.join(TMP, "home_hardening_"));
  const CFG_DIR = path.join(FAKE_HOME, ".config", "opencode");
  const PROJECT = path.join(TMP, "project_hardening");
  const PROJECT_CFG_DIR = path.join(PROJECT, ".opencode");
  mkdirSync(CFG_DIR, { recursive: true });
  mkdirSync(PROJECT_CFG_DIR, { recursive: true });
  const prevHome = process.env.HOME;
  try {
    const writeGlobal = (obj) => writeFileSync(path.join(CFG_DIR, "ensemble.json"), JSON.stringify(obj));
    const writeProject = (obj) => writeFileSync(path.join(PROJECT_CFG_DIR, "ensemble.json"), JSON.stringify(obj));
    process.env.HOME = FAKE_HOME;

    // e1: projeto PARCIAL (só "build") não apaga as chaves globais.
    writeGlobal({ fallbackModels: ["prov/ga", "prov/gb"], fallbackModelsByAgent: { diana: ["prov/d1"], cris: ["prov/c1"] } });
    writeProject({ fallbackModelsByAgent: { build: ["prov/b1"] } });
    const partial = loadConfig(PROJECT);
    check(
      "e1: projeto parcial preserva as chaves globais (diana + cris) e soma a própria (build)",
      eq(partial.fallbackModelsByAgent, { diana: ["prov/d1"], cris: ["prov/c1"], build: ["prov/b1"] })
        && eq(partial.fallbackModels, ["prov/ga", "prov/gb"]),
      JSON.stringify(partial.fallbackModelsByAgent),
    );

    // e2: redeclaração explícita no projeto sobrescreve SÓ aquela chave.
    writeProject({ fallbackModelsByAgent: { diana: ["prov/d2"] } });
    const redeclared = loadConfig(PROJECT);
    check(
      "e2: projeto redeclara 'diana' → valor do projeto; 'cris' global SOBREVIVE",
      eq(redeclared.fallbackModelsByAgent, { diana: ["prov/d2"], cris: ["prov/c1"] }),
      JSON.stringify(redeclared.fallbackModelsByAgent),
    );

    // e3: mapa de projeto INVÁLIDO é descartado pelo readConfigFile — as
    // chaves globais não são reféns do spread de topo.
    writeProject({ fallbackModelsByAgent: { diana: ["prov/ok", 42] } });
    const invalidProject = loadConfig(PROJECT);
    check(
      "e3: projeto inválido → merge mantém o mapa GLOBAL íntegro (diana + cris)",
      eq(invalidProject.fallbackModelsByAgent, { diana: ["prov/d1"], cris: ["prov/c1"] }),
      JSON.stringify(invalidProject.fallbackModelsByAgent),
    );

    // e4: campos independentes — fallbackModels global sobrevive ao projeto
    // parcial; fallbackModelsByAgent vazio no projeto não zera o global.
    writeProject({});
    const noProjectMap = loadConfig(PROJECT);
    check(
      "e4: projeto sem o campo → global preservado (fallbackModels + por-agente)",
      eq(noProjectMap.fallbackModels, ["prov/ga", "prov/gb"])
        && eq(noProjectMap.fallbackModelsByAgent, { diana: ["prov/d1"], cris: ["prov/c1"] }),
    );

    // e5: paridade src × dist — o bundle aplica o MESMO merge profundo.
    writeProject({ fallbackModelsByAgent: { build: ["prov/b1"] } });
    const distLoaded = distMod.loadConfig(PROJECT);
    check(
      "e5: dist loadConfig idêntico ao src (merge por-chave, paridade byte-funcional)",
      eq(distLoaded.fallbackModelsByAgent, loadConfig(PROJECT).fallbackModelsByAgent)
        && eq(distLoaded.fallbackModelsByAgent, { diana: ["prov/d1"], cris: ["prov/c1"], build: ["prov/b1"] }),
      JSON.stringify(distLoaded.fallbackModelsByAgent),
    );
  } finally {
    if (prevHome === undefined) delete process.env.HOME; else process.env.HOME = prevHome;
  }
}

/* ------------------------------------------------------------------ *
 * 11. (f) Simetria resolveBasePersona em resolveFallbackChainForAgent *
 * ------------------------------------------------------------------ */
check(
  "f1: 'diana-x' (instância multi-persona) herda a cadeia da Diana",
  eq(resolveFallbackChainForAgent(CFG, "diana-x"), DIANA_REFS),
  JSON.stringify(resolveFallbackChainForAgent(CFG, "diana-x")),
);
check(
  "f2: 'diana_2' (sufixo underscore) também herda a cadeia da Diana",
  eq(resolveFallbackChainForAgent(CFG, "diana_2"), DIANA_REFS),
);
check(
  "f3: chave EXATA prevalece sobre a base-persona ('diana-x' declarada → retorno dela)",
  eq(
    resolveFallbackChainForAgent({ ...CFG, fallbackModelsByAgent: { diana: DIANA_CHAIN, "diana-x": ["prov/instance-x"] } }, "diana-x"),
    [{ model: "prov/instance-x" }],
  ),
);
check(
  "f4: caixa alta ('Diana-X') normaliza para a base 'diana'",
  eq(resolveFallbackChainForAgent(CFG, "Diana-X"), DIANA_REFS),
);
check(
  "f5: agente sem sufixo desconhecido ('dianaa') NÃO herda nada falsamente → cadeia global",
  eq(resolveFallbackChainForAgent(CFG, "dianaa"), GLOBAL_REFS),
);
{
  const db = makeDb();
  const mem = seedMember(db, {
    teamId: "team-f-base", memberName: "diana-x", sessionId: "sess-f-base",
    agent: "diana-x", model: "opencode-go/gemini-4-argon-contributor",
  });
  const client = makeClient();
  const decision = await handleRetryModelFailover(db, mem.registry, client, CFG, mem.sessionId, { attempt: 1, message: "429", next: Date.now() });
  check(
    "f6: runtime — membro com agent 'diana-x' caminha a cadeia da Diana (gpt-6-luna) e persiste",
    decision?.action === "switched" && decision.toModel === "opencode-go/gpt-6-luna"
      && getMember(db, mem.teamId, "diana-x").model === "opencode-go/gpt-6-luna"
      && client.calls.promptAsync[0]?.agent === "diana-x",
    JSON.stringify(decision),
  );
  db.close();
  clearCooldown();
}
check(
  "f7: dist resolveFallbackChainForAgent idêntico ao src para sufixos ('diana-x', 'diana_2')",
  eq(distMod.resolveFallbackChainForAgent(CFG, "diana-x"), resolveFallbackChainForAgent(CFG, "diana-x"))
    && eq(distMod.resolveFallbackChainForAgent(CFG, "diana_2"), DIANA_REFS),
);

/* ------------------------------------------------------------------ *
 * 12. (extra) HARNESS-15 B + TICKET-32B — notifyLead ciente do modelo      *
 *     (degrau 0 nativo, primaryModel explícito respeitado, cadeia só       *
 *     após rejeição) + retrocompat                                        *
 * ------------------------------------------------------------------ */
{
  const db = makeDb();
  const now = Date.now();
  const seedLead = (teamId, leadSession, leadAgent) => {
    db.run(
      `INSERT INTO team (id, name, lead_session_id, status, delegate, time_created, time_updated, lead_agent)
       VALUES (?, ?, ?, 'active', 0, ?, ?, ?)`,
      [teamId, `name-${teamId}`, leadSession, now, now, leadAgent],
    );
  };
  const tick = async () => { await new Promise((r) => setImmediate(r)); await new Promise((r) => setImmediate(r)); };

  // g1: chamada legada SEM opções → wake retrocompatível (sem agent/model).
  seedLead("team-g-legacy", "lead-g-legacy", null);
  const legacyClient = makeClient();
  const legacyId = notifyLead(legacyClient, db, "team-g-legacy", "mensagem legada");
  await tick();
  const legacyMsgs = db.query("SELECT id, content, to_name FROM team_message WHERE team_id = 'team-g-legacy'").all();
  check(
    "g1: notifyLead retrocompatível — sem opções: mensagem persistida + wake SEM agent/model",
    typeof legacyId === "string" && legacyMsgs.length === 1
      && legacyClient.calls.promptAsync.length === 1
      && !("agent" in legacyClient.calls.promptAsync[0])
      && !("model" in legacyClient.calls.promptAsync[0])
      && legacyClient.calls.promptAsync[0].sessionID === "lead-g-legacy"
      && legacyClient.calls.promptAsync[0].synthetic === true,
    JSON.stringify(legacyClient.calls.promptAsync),
  );

  // g2: opções com agent + config → ladder com degrau de retry.
  // TICKET-HARNESS-34 (A1): com config silentLead:true (default) o wake só
  // ocorre com forceWake:true — é o caminho de falha irrecuperável que usa a
  // escada de modelo. O objeto abaixo isola a ESCADA.
  seedLead("team-g-ladder", "lead-g-ladder", null);
  const ladderCalls = [];
  const ladderClient = {
    session: {
      promptAsync: async (opts) => {
        ladderCalls.push(opts);
        if (ladderCalls.length === 1) throw new Error("429 rate limited on primary");
        return undefined;
      },
    },
    tui: { showToast: async () => undefined },
  };
  notifyLead(ladderClient, db, "team-g-ladder", "wake ciente do modelo", {
    agent: "cris", config: CFG, primaryModel: "prov/primary#low", forceWake: true,
  });
  await tick();
  check(
    "g2: 1º promptAsync falha → degrau para a próxima entrada da cadeia (primary → global-1#low), agent 'cris' explícito",
    ladderCalls.length === 2
      && ladderCalls[0].model?.modelID === "primary" && ladderCalls[0].model?.variant === "low"
      && ladderCalls[1].model?.modelID === "global-1" && ladderCalls[1].model?.variant === "low"
      && ladderCalls.every((c) => c.agent === "cris" && c.sessionID === "lead-g-ladder"),
    JSON.stringify(ladderCalls.map((c) => ({ model: c.model, agent: c.agent }))),
  );
  check(
    "g3: mensagem persistida ANTES do wake — row única e íntegra na tabela",
    db.query("SELECT content FROM team_message WHERE team_id = 'team-g-ladder'").all().length === 1,
  );

  // g4: TODOS os degraus falham → mensagem continua persistida (backstop).
  // TICKET-32B: sem primaryModel explícito o degrau 0 é o MODELO NATIVO da
  // sessão (payload SEM `model`) e a cadeia global só entra como retry.
  // TICKET-HARNESS-34 (A1): forceWake:true (falha irrecuperável) mantém o
  // teste focado na ESCADA sob o default silentLead:true.
  seedLead("team-g-allfail", "lead-g-allfail", null);
  const failCalls = [];
  const failClient = {
    session: { promptAsync: async (opts) => { failCalls.push(opts); throw new Error("429 always"); } },
    tui: { showToast: async () => undefined },
  };
  notifyLead(failClient, db, "team-g-allfail", "nunca entregue", { agent: "cris", config: CFG, forceWake: true });
  await tick();
  check(
    "g4: ladder inteiro rejeitado → 3 tentativas (nativo → global-1#low → global-2) + mensagem ainda persistida",
    failCalls.length === 3
      && !("model" in failCalls[0])
      && failCalls[1].model?.modelID === "global-1" && failCalls[1].model?.variant === "low"
      && failCalls[2].model?.modelID === "global-2"
      && failCalls.every((c) => c.agent === "cris" && c.sessionID === "lead-g-allfail")
      && db.query("SELECT content FROM team_message WHERE team_id = 'team-g-allfail'").all().length === 1,
    `attempts=${failCalls.length} models=${JSON.stringify(failCalls.map((c) => c.model ?? "(nativo)"))}`,
  );

  // g5: MESMA rejeição SEM config → degrau único nativo (threading de
  // options.config é o que habilita o fallback reativo — TICKET-32B item 2).
  seedLead("team-g-nocfg", "lead-g-nocfg", null);
  const nocfgCalls = [];
  const nocfgClient = {
    session: { promptAsync: async (opts) => { nocfgCalls.push(opts); throw new Error("429 always"); } },
    tui: { showToast: async () => undefined },
  };
  notifyLead(nocfgClient, db, "team-g-nocfg", "sem config", { agent: "cris" });
  await tick();
  check(
    "g5: SEM config a escada não existe → 1 tentativa nativa (sem chave 'model')",
    nocfgCalls.length === 1
      && !("model" in nocfgCalls[0])
      && nocfgCalls[0]?.agent === "cris"
      && db.query("SELECT content FROM team_message WHERE team_id = 'team-g-nocfg'").all().length === 1,
    `attempts=${nocfgCalls.length}`,
  );

  db.close();
}

check(
  "x1: ZERO unhandled rejections ao longo de toda a suíte",
  unhandled.length === 0,
  unhandled.map((e) => String(e)).join(" | "),
);

/* ------------------------------------------------------------------ *
 * Relatório                                                            *
 * ------------------------------------------------------------------ */
const passed = results.filter(([, ok]) => ok).length;
const total = results.length;
const fails = results.filter(([, ok]) => !ok).map(([name]) => name);
console.log("-".repeat(78));
console.log(`CHECKS: ${passed}/${total} passaram`);
if (fails.length > 0) for (const f of fails) console.log(`FAIL | ${f}`);
console.log(`RESULT: ${passed === total ? "all checks passed" : "SUITE FAILURE"} (${passed}/${total})`);
process.exit(passed === total ? 0 : 1);
