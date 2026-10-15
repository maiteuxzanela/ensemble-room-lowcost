#!/usr/bin/env node
/**
 * QUALITY GATE DETERMINÍSTICO — Fallback de modelo POR-AGENTE
 * (fallbackModelsByAgent) do @maiteuxzanela/ensemble-room-lowcost —
 * TICKET-HARNESS-12 / T3.
 *
 * Sob teste (código REAL, não simulado):
 *   - src/config.ts       → resolveFallbackChainForAgent (precedência do
 *                           override por agente > cadeia global), a cadeia
 *                           RIGOROSA chainFromSelectors (parse, descarte de
 *                           malformadas, dedup), resolveFallbackChain,
 *                           selectNextFallback (caminhamento para frente até
 *                           a EXAUSTÃO, sem wrap-around), readConfigFile via
 *                           loadConfig (leitura real de ensemble.json em HOME
 *                           temporário isolado — aceita válido / descarta
 *                           inválido).
 *   - src/hooks.ts        → handleRetryModelFailover (seam MEMbro ×
 *                           NÃO-MEMBRO): cadeia por agente do membro
 *                           (team_member.agent), persistência do switch em
 *                           team_member.model, HARNESS-13: a exaustão NÃO
 *                           acorda o lead (zero promptAsync/zero mensagem);
 *                           handleIsolatedSessionFailover para sessões
 *                           ISOLADAS (ex.: Diana blind-review fora do
 *                           team_spawn): descoberta via retryPayload.agent /
 *                           session.get, cadeia EXPLícITA obrigatória,
 *                           abort+promptAsync synthetic, cooldown
 *                           "isolated:<sessionId>", zero toque no board.
 *   - src/db.ts/schema    → SQLite REAL (node:sqlite) com TODAS as migrations.
 *   - src/state.ts        → MemberRegistry real.
 *   - dist/index.js       → paridade byte-funcional do bundle real (mesmas
 *                           asserções centrais no harness do dist).
 *
 * Único ponto de emenda do dist: cláusulas de export anexadas à cópia do
 * bundle (mesmo padrão homologado em test_fallback_models.mjs). O único
 * "client" injetado é o TRANSPORT RECORDER homologado (promptAsync / abort /
 * showToast capturados; session.get devolve payload V2 real-shaped para a
 * descoberta da sessão isolada) — nenhum mock library, nenhum stub de banco,
 * nenhuma fixture falsa de parser. Bancos são SQLite REAIS; ensemble.json é
 * JSON REAL em disco.
 *
 * Invariantes verificadas (mandato do ticket):
 *   (a) fallbackModelsByAgent prevalece sobre fallbackModels (mesmo rigor
 *       de parse/dedup das duas cadeias);
 *   (b) agente SEM cadeia própria → cadeia global (nunca chain vazia);
 *   (c) readConfigFile aceita fallbackModelsByAgent válido e DESCARTA o
 *       campo inteiro quando qualquer entrada é inválida;
 *   (d) cadeia da Diana (argon-contributor → gpt-6-luna → antigravity#high)
 *       caminha para frente ATÉ A EXAUSTÃO (membro: decisão 'exhausted' SEM
 *       wake/HARNESS-13; isolada: decisão sem wake);
 *   (e) sessão isolada da Diana (não-membro) recebe switch (abort +
 *       promptAsync) sem tocar o board de membros;
 *   (f) paridade src ↔ dist.
 *
 * Uso:  node tests/test_per_agent_fallback.mjs
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

/* ------------------------------------------------------------------ *
 * 1. Harness do dist: cópia byte-a-byte + apenas cláusulas de export  *
 * ------------------------------------------------------------------ */
const HARNESS = path.join(TMP, "_per_agent_fallback_harness.mjs");
const DIST_EXPORTS = [
  "resolveFallbackChainForAgent", "resolveFallbackChain", "selectNextFallback",
  "formatModelSelector", "parseModelSelector", "DEFAULT_CONFIG", "loadConfig",
  "handleRetryModelFailover", "MemberRegistry", "createDb",
  "failoverCooldown", "FAILOVER_COOLDOWN_MS",
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
const SRC_COPY = path.join(TMP, "ensemble_src_per_agent");
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
const stateMod = await import(`${SRC_COPY}/state.ts`);
const dbMod = await import(`${SRC_COPY}/db.ts`);
const distMod = await import(HARNESS);
check(
  "módulos reais carregados (config, hooks, state, db, dist)",
  typeof configMod.resolveFallbackChainForAgent === "function"
    && typeof hooks.handleRetryModelFailover === "function"
    && typeof distMod.resolveFallbackChainForAgent === "function",
);

const {
  resolveFallbackChainForAgent, resolveFallbackChain, selectNextFallback,
  formatModelSelector, DEFAULT_CONFIG, loadConfig,
} = configMod;
const { handleRetryModelFailover, failoverCooldown, FAILOVER_COOLDOWN_MS } = hooks;
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

/* ------------------------------------------------------------------ *
 * 5. (a) Precedência: fallbackModelsByAgent > fallbackModels          *
 * ------------------------------------------------------------------ */
check(
  "a1: cadeia da Diana (override) é a cadena deduplicada de 3 entradas",
  eq(resolveFallbackChainForAgent(CFG, "diana"), DIANA_REFS),
  JSON.stringify(resolveFallbackChainForAgent(CFG, "diana")),
);
check(
  "a2: override prevalece sobre a cadeia global (resultado ≠ resolveFallbackChain)",
  !eq(resolveFallbackChainForAgent(CFG, "diana"), resolveFallbackChain(CFG)),
);
check(
  "a3: rigor idêntico ao global — malformadas descartadas, dedup por seletor",
  eq(
    resolveFallbackChainForAgent(
      { fallbackModelsByAgent: { diana: ["opencode-go/gpt-6-luna", "malformada-sem-barra", "opencode-go/gpt-6-luna", "google/antigravity-gemini-3.8-flash#high"] } },
      "diana",
    ),
    [{ model: "opencode-go/gpt-6-luna" }, { model: "google/antigravity-gemini-3.8-flash", variant: "high" }],
  ),
);

/* ------------------------------------------------------------------ *
 * 6. (b) Agente sem cadeia própria → cadeia global (nunca vazia)      *
 * ------------------------------------------------------------------ */
check(
  "b1: agente sem override (cris) delega para a cadeia global",
  eq(resolveFallbackChainForAgent(CFG, "cris"), GLOBAL_REFS),
  JSON.stringify(resolveFallbackChainForAgent(CFG, "cris")),
);
check(
  "b2: agent null/undefined → cadeia global",
  eq(resolveFallbackChainForAgent(CFG, null), GLOBAL_REFS)
    && eq(resolveFallbackChainForAgent(CFG, undefined), GLOBAL_REFS),
);
check(
  "b3: chave existente com lista VAZIA → cadeia global (failover nunca vazio)",
  eq(
    resolveFallbackChainForAgent({ ...CFG, fallbackModelsByAgent: { ...CFG.fallbackModelsByAgent, noa: [] } }, "noa"),
    GLOBAL_REFS,
  ),
);
check(
  "b4: chave existente só com malformadas → cadeia global (chain parseada vazia delega)",
  eq(
    resolveFallbackChainForAgent({ ...CFG, fallbackModelsByAgent: { ...CFG.fallbackModelsByAgent, noa: ["sem-barra", "/x", "p/"] } }, "noa"),
    GLOBAL_REFS,
  ),
);
check(
  "b5: config totalmente vazio + agente desconhecido → DEFAULT_MODEL_FALLBACK",
  eq(resolveFallbackChainForAgent({}, "diana"), [{ model: "google/antigravity-gemini-3.8-flash", variant: "low" }]),
);

/* ------------------------------------------------------------------ *
 * 7. (c) readConfigFile (via loadConfig) — JSON REAL em HOME isolado  *
 * ------------------------------------------------------------------ */
const FAKE_HOME = mkdtempSync(path.join(TMP, "home_pa_"));
const CFG_DIR = path.join(FAKE_HOME, ".config", "opencode");
mkdirSync(CFG_DIR, { recursive: true });
const prevHome = process.env.HOME;
try {
  const writeCfg = (obj) =>
    writeFileSync(path.join(CFG_DIR, "ensemble.json"), typeof obj === "string" ? obj : JSON.stringify(obj));

  writeCfg({
    fallbackModels: ["prov/global-1#low"],
    fallbackModelsByAgent: { diana: DIANA_CHAIN, cris: ["prov/cris-a", "prov/cris-b#high"] },
  });
  process.env.HOME = FAKE_HOME;
  const valid = loadConfig(path.join(TMP, "no_project_pa"));
  check(
    "c1: fallbackModelsByAgent VÁLIDO é aceito e preservado por agente",
    eq(valid.fallbackModelsByAgent, { diana: DIANA_CHAIN, cris: ["prov/cris-a", "prov/cris-b#high"] })
      && eq(valid.fallbackModels, ["prov/global-1#low"]),
    JSON.stringify(valid.fallbackModelsByAgent),
  );

  writeCfg({ fallbackModelsByAgent: { diana: "não é array" } });
  check(
    "c2: valor não-array para o agente → campo inteiro descartado (default {})",
    eq(loadConfig(path.join(TMP, "no_project_pa")).fallbackModelsByAgent, {}),
  );

  writeCfg({ fallbackModelsByAgent: { diana: ["prov/ok", ""] } });
  check(
    "c3: entrada com string VAZIA → campo inteiro descartado",
    eq(loadConfig(path.join(TMP, "no_project_pa")).fallbackModelsByAgent, {}),
  );

  writeCfg({ fallbackModelsByAgent: { diana: ["prov/ok", 42] } });
  check(
    "c4: entrada não-string (number) → campo inteiro descartado",
    eq(loadConfig(path.join(TMP, "no_project_pa")).fallbackModelsByAgent, {}),
  );

  writeCfg({ fallbackModelsByAgent: ["prov/a", "prov/b"] });
  check(
    "c5: fallbackModelsByAgent como array (não objeto) → descartado",
    eq(loadConfig(path.join(TMP, "no_project_pa")).fallbackModelsByAgent, {}),
  );

  writeCfg({ fallbackModelsByAgent: { diana: DIANA_CHAIN, noa: ["ok", ""] } });
  check(
    "c6: UMA entrada inválida entre válidas derruba o CAMPO INTERO (entries.every)",
    eq(loadConfig(path.join(TMP, "no_project_pa")).fallbackModelsByAgent, {}),
  );

  writeCfg({ fallbackModels: ["prov/keep-a", "prov/keep-b"], fallbackModelsByAgent: { diana: ["prov/d"] } });
  const independent = loadConfig(path.join(TMP, "no_project_pa"));
  check(
    "c7: campos independentes — fallbackModels e fallbackModelsByAgent coexistem",
    eq(independent.fallbackModels, ["prov/keep-a", "prov/keep-b"])
      && eq(independent.fallbackModelsByAgent, { diana: ["prov/d"] }),
  );

  writeCfg("{ json inválido");
  const broken = loadConfig(path.join(TMP, "no_project_pa"));
  check(
    "c8: JSON inválido → defaults (fallbackModelsByAgent = {}) sem lançar",
    eq(broken.fallbackModelsByAgent, {}) && eq(broken.fallbackModels, []),
  );
} finally {
  if (prevHome === undefined) delete process.env.HOME; else process.env.HOME = prevHome;
}

/* ------------------------------------------------------------------ *
 * 8. (d) Cadeia da Diana — caminhamento forward ATÉ A EXAUSTÃO        *
 * ------------------------------------------------------------------ */
const dianaChain = resolveFallbackChainForAgent(CFG, "diana");
check(
  "d1: cadeia da Diana exposta na ordem exata do mandato global",
  dianaChain.length === 3
    && dianaChain.map(formatModelSelector).join(" -> ") === DIANA_CHAIN.join(" -> "),
  dianaChain.map(formatModelSelector).join(" -> "),
);
check(
  "d2: argon-contributor → gpt-6-luna",
  eq(selectNextFallback(dianaChain, "opencode-go/gemini-4-argon-contributor"), { model: "opencode-go/gpt-6-luna" }),
  JSON.stringify(selectNextFallback(dianaChain, "opencode-go/gemini-4-argon-contributor")),
);
check(
  "d3: gpt-6-luna → antigravity-gemini-3.8-flash#high (variant preservada)",
  eq(selectNextFallback(dianaChain, "opencode-go/gpt-6-luna"), { model: "google/antigravity-gemini-3.8-flash", variant: "high" }),
);
check(
  "d4: antigravity#high (última) → undefined — EXAUSTÃO, sem wrap-around",
  selectNextFallback(dianaChain, "google/antigravity-gemini-3.8-flash#high") === undefined,
);

/* ------------------------------------------------------------------ *
 * 9. Fixtures reais: SQLite + registry + transport recorder           *
 * ------------------------------------------------------------------ */
let dbSeq = 0;
function makeDb() {
  const file = path.join(TMP, `per_agent_${process.pid}_${dbSeq++}.sqlite`);
  rmSync(file, { force: true });
  rmSync(`${file}-wal`, { force: true });
  rmSync(`${file}-shm`, { force: true });
  return createDb(file);
}

/**
 * Transport recorder — mesmo seam homologado em test_rate_limit_failover.mjs.
 * `sessionInfo` (opcional) devolve o payload V2 real-shaped lido pela
 * descoberta da sessão isolada (handleIsolatedSessionFailover chama
 * client.session.get); ausente → o client não expõe session.get (caminho de
 * hint via retryPayload.agent).
 */
function makeClient(sessionInfo) {
  const calls = { promptAsync: [], showToast: [], abort: [], sessionGet: [] };
  return {
    calls,
    session: {
      promptAsync: async (options) => { calls.promptAsync.push(options); return undefined; },
      abort: async (options) => { calls.abort.push(options); return undefined; },
      create: async () => { throw new Error("unexpected session.create in failover path"); },
      ...(sessionInfo !== undefined
        ? {
            get: async (options) => {
              calls.sessionGet.push(options);
              return typeof sessionInfo === "function" ? sessionInfo(options) : sessionInfo;
            },
          }
        : {}),
    },
    tui: {
      showToast: async (options) => { calls.showToast.push(options); return undefined; },
    },
  };
}

const LEAD_SESSION = "lead-session-pa-1";

/** Insert a real active team + one member row (real schema, real migrations). */
function seedMember(db, { teamId, memberName, sessionId, agent = "build", model = "prov/primary", status = "busy", teamStatus = "active", leadSession = LEAD_SESSION } = {}) {
  const now = Date.now();
  db.run(
    `INSERT OR IGNORE INTO team (id, name, lead_session_id, status, delegate, time_created, time_updated)
     VALUES (?, ?, ?, ?, 0, ?, ?)`,
    [teamId, `name-${teamId}`, leadSession, teamStatus, now, now],
  );
  if (teamStatus !== "active") {
    db.run("UPDATE team SET status = ? WHERE id = ?", [teamStatus, teamId]);
  }
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
const leadMessages = (db, teamId) =>
  db.query("SELECT from_name, to_name, content FROM team_message WHERE team_id = ? AND from_name = 'system' AND to_name = 'lead'").all(teamId);
const totalMessages = (db) => db.query("SELECT COUNT(*) AS n FROM team_message").get().n;

/* ------------------------------------------------------------------ *
 * 10. (d)+(b) Caminhamento MEMBRO — cadeia da Diana até a EXAUSTÃO    *
 * ------------------------------------------------------------------ */
{
  const db = makeDb();
  const client = makeClient();
  const seed = seedMember(db, {
    teamId: "team-diana-walk", memberName: "diana", sessionId: "sess-diana-walk",
    agent: "diana", model: "opencode-go/gemini-4-argon-contributor",
  });

  const first = await handleRetryModelFailover(db, seed.registry, client, CFG, seed.sessionId, { attempt: 1, message: "429", next: Date.now() + 30_000 });
  check(
    "m1: membro diana — argon-contributor → gpt-6-luna (switch silencioso + persistido)",
    first?.action === "switched" && first.toModel === "opencode-go/gpt-6-luna"
      && getMember(db, seed.teamId, "diana").model === "opencode-go/gpt-6-luna",
    JSON.stringify(first),
  );
  check(
    "m2: FAILOVER ATIVO no caminho por-agente — abort + promptAsync synthetic na sessão do membro (zero wake do lead)",
    client.calls.abort.some((c) => c.sessionID === seed.sessionId)
      && client.calls.promptAsync.some((c) => c.sessionID === seed.sessionId && c.synthetic === true && c.model?.modelID === "gpt-6-luna")
      && !client.calls.promptAsync.some((c) => c.sessionID === LEAD_SESSION)
      && leadMessages(db, seed.teamId).length === 0,
    `abort=${client.calls.abort.length} promptAsync=${client.calls.promptAsync.length}`,
  );

  // Cooldown do burst contornado (determinístico — sem sleep).
  failoverCooldown.set(`${seed.teamId}:${seed.memberName}`, Date.now() - FAILOVER_COOLDOWN_MS - 1_000);
  const second = await handleRetryModelFailover(db, seed.registry, client, CFG, seed.sessionId, { attempt: 1, message: "429", next: Date.now() });
  check(
    "m3: gpt-6-luna → antigravity-gemini-3.8-flash#high (2º salto lê o modelo persistido no SQLite)",
    second?.action === "switched" && second.toModel === "google/antigravity-gemini-3.8-flash#high"
      && getMember(db, seed.teamId, "diana").model === "google/antigravity-gemini-3.8-flash#high",
    JSON.stringify(second),
  );

  failoverCooldown.set(`${seed.teamId}:${seed.memberName}`, Date.now() - FAILOVER_COOLDOWN_MS - 1_000);
  const third = await handleRetryModelFailover(db, seed.registry, client, CFG, seed.sessionId, { attempt: 1, message: "429 exceeded quota", next: Date.now() });
  check(
    "m4: antigravity#high (última) → EXAUSTÃO — HARNESS-13: 0 wake do lead, 0 team_message, modelo intacto",
    third?.action === "exhausted" && third.toModel === undefined
      && client.calls.promptAsync.filter((c) => c.sessionID === LEAD_SESSION).length === 0
      && client.calls.promptAsync.every((c) => c.sessionID === seed.sessionId)
      && leadMessages(db, seed.teamId).length === 0
      && getMember(db, seed.teamId, "diana").model === "google/antigravity-gemini-3.8-flash#high",
    JSON.stringify(third),
  );
  check(
    "m5: nenhuma team_message citando a cadeia esgotada foi persistida (zero-noise fim a fim)",
    totalMessages(db) === 0
      && !db.query("SELECT content FROM team_message").all().some((m) => String(m.content).includes("fallback chain is exhausted")),
    `msgs=${totalMessages(db)}`,
  );

  // (b) em runtime: membro SEM override caminha pela cadeia GLOBAL.
  const cris = seedMember(db, {
    teamId: "team-cris-global", memberName: "cris", sessionId: "sess-cris-pa",
    agent: "cris", model: "prov/global-1#low",
  });
  const crisDecision = await handleRetryModelFailover(db, cris.registry, client, CFG, cris.sessionId, { attempt: 1, message: "429", next: Date.now() });
  check(
    "m6: membro cris (sem override) → cadeia GLOBAL (prov/global-2), precedência respeitada em runtime",
    crisDecision?.action === "switched" && crisDecision.toModel === "prov/global-2"
      && getMember(db, cris.teamId, "cris").model === "prov/global-2",
    JSON.stringify(crisDecision),
  );

  db.close();
  failoverCooldown.clear();
}

/* ------------------------------------------------------------------ *
 * 11. (e) Sessão ISOLADA da Diana (não-membro) — switch sem tocar     *
 *       o board de membros                                            *
 * ------------------------------------------------------------------ */
{
  const db = makeDb();
  // Board de membros REAL pré-existente — não pode ser tocado pelo isolado.
  const board = seedMember(db, {
    teamId: "team-board-other", memberName: "cris", sessionId: "sess-board-other",
    agent: "cris", model: "prov/global-1#low",
  });
  const client = makeClient({
    data: { agent: "diana", model: { providerID: "opencode-go", id: "gemini-4-argon-contributor" } },
  });
  const isolatedSession = "sess-diana-isolated-1";

  const decision = await handleRetryModelFailover(db, new MemberRegistry(), client, CFG, isolatedSession, {
    attempt: 1, message: "429", next: Date.now() + 30_000,
  });
  check(
    "e1: sessão isolada diana — descoberta via session.get + switch para gpt-6-luna (teamId='', memberName=diana)",
    decision?.action === "switched" && decision.toModel === "opencode-go/gpt-6-luna"
      && decision.memberName === "diana" && decision.teamId === ""
      && decision.fromModel === "opencode-go/gemini-4-argon-contributor",
    JSON.stringify(decision),
  );
  check(
    "e2: ciclo ativo completo — abort + promptAsync synthetic na sessão ISOLADA com model gpt-6-luna",
    client.calls.abort.some((c) => c.sessionID === isolatedSession)
      && client.calls.promptAsync.some((c) => c.sessionID === isolatedSession && c.synthetic === true && c.model?.providerID === "opencode-go" && c.model?.modelID === "gpt-6-luna"),
    `abort=${client.calls.abort.length} promptAsync=${client.calls.promptAsync.length}`,
  );
  check(
    "e3: BOARD INTACTO — zero wake do lead, zero team_message, modelo do membro alheio não alterado",
    !client.calls.promptAsync.some((c) => c.sessionID === LEAD_SESSION)
      && totalMessages(db) === 0
      && getMember(db, board.teamId, "cris").model === "prov/global-1#low",
    `leadWakes=${client.calls.promptAsync.filter((c) => c.sessionID === LEAD_SESSION).length} msgs=${totalMessages(db)}`,
  );

  // Hint retryPayload.agent — client SEM session.get (round-trip dispensado).
  const hintClient = makeClient();
  const hintDecisionReal = await handleRetryModelFailover(db, new MemberRegistry(), hintClient, CFG, "sess-diana-isolated-2", {
    attempt: 1, message: "429", next: Date.now(), agent: "diana",
  });
  check(
    "e4: hint retryPayload.agent descobre a Diana sem session.get → switch para a CABEÇA da cadeia (atual desconhecido)",
    hintDecisionReal?.action === "switched" && hintDecisionReal.toModel === "opencode-go/gemini-4-argon-contributor"
      && hintDecisionReal.memberName === "diana" && hintDecisionReal.teamId === ""
      && hintClient.calls.abort.some((c) => c.sessionID === "sess-diana-isolated-2")
      && hintClient.calls.promptAsync.some((c) => c.sessionID === "sess-diana-isolated-2" && c.model?.modelID === "gemini-4-argon-contributor"),
    JSON.stringify(hintDecisionReal),
  );

  // Exaustão da cadeia da Diana no caminho isolado — decisão SEM wake/toast.
  const exDb = makeDb();
  seedMember(exDb, { teamId: "team-board-ex", memberName: "ana", sessionId: "sess-board-ex", model: "prov/primary" });
  const exClient = makeClient({
    data: { agent: "diana", model: { providerID: "google", id: "antigravity-gemini-3.8-flash", variant: "high" } },
  });
  const exDecision = await handleRetryModelFailover(exDb, new MemberRegistry(), exClient, CFG, "sess-diana-isolated-ex", { attempt: 1, message: "429", next: Date.now() });
  check(
    "e5: isolada na ÚLTIMA entrada → 'exhausted' como decisão, ZERO promptAsync/abort (lead nunca é acordado)",
    exDecision?.action === "exhausted" && exDecision.teamId === "" && exDecision.toModel === undefined
      && exClient.calls.promptAsync.length === 0 && exClient.calls.abort.length === 0
      && totalMessages(exDb) === 0,
    JSON.stringify(exDecision),
  );

  // Agente isolado SEM cadeia explícita → no-op (a cadeia global NUNCA sequestra).
  const noChainClient = makeClient({
    data: { agent: "cris", model: { providerID: "prov", id: "global-1", variant: "low" } },
  });
  const noChainDecision = await handleRetryModelFailover(db, new MemberRegistry(), noChainClient, CFG, "sess-cris-isolated", { attempt: 1, message: "429", next: Date.now() });
  check(
    "e6: isolado sem fallbackModelsByAgent[agent] → undefined, zero ação (cadeia global nunca sequestra sessão alheia)",
    noChainDecision === undefined
      && noChainClient.calls.promptAsync.length === 0 && noChainClient.calls.abort.length === 0
      && getMember(db, board.teamId, "cris").model === "prov/global-1#low",
  );

  // Cooldown do isolado: um segundo retry no mesmo burst → "suppressed".
  const cdClient = makeClient({
    data: { agent: "diana", model: { providerID: "opencode-go", id: "gemini-4-argon-contributor" } },
  });
  const cdFirst = await handleRetryModelFailover(db, new MemberRegistry(), cdClient, CFG, "sess-diana-isolated-cd", { attempt: 1, message: "429", next: Date.now() });
  const cdSecond = await handleRetryModelFailover(db, new MemberRegistry(), cdClient, CFG, "sess-diana-isolated-cd", { attempt: 2, message: "429", next: Date.now() });
  check(
    "e7: cooldown isolado (isolated:<sessionId>) — 1º 'switched', 2º 'suppressed', um único abort+promptAsync",
    cdFirst?.action === "switched" && cdSecond?.action === "suppressed"
      && cdClient.calls.abort.length === 1 && cdClient.calls.promptAsync.length === 1,
    `first=${cdFirst?.action} second=${cdSecond?.action} abort=${cdClient.calls.abort.length} promptAsync=${cdClient.calls.promptAsync.length}`,
  );

  // HARNESS-15 A: a sessão que É lead_session_id failovera SOMENTE com
  // cadeia EXPLícITA em fallbackModelsByAgent[agent] — e nunca toca o board.
  seedMember(db, { teamId: "team-lead-guard-pa", memberName: "ghost", sessionId: "sess-ghost-pa", agent: "build", model: "prov/primary", leadSession: "sess-lead-guard-pa" });
  const ghostBefore = eq(getMember(db, "team-lead-guard-pa", "ghost"), { model: "prov/primary", status: "busy", agent: "build" });
  const leadClient = makeClient();
  const leadDecision = await handleRetryModelFailover(db, new MemberRegistry(), leadClient, CFG, "sess-lead-guard-pa", { attempt: 1, message: "429", next: Date.now(), agent: "diana" });
  check(
    "e8: lead com cadeia EXPLícITA (fallbackModelsByAgent.diana) → 'switched' na própria sessão do lead (teamId='')",
    leadDecision?.action === "switched" && leadDecision.teamId === "" && leadDecision.memberName === "diana"
      && leadDecision.toModel === "opencode-go/gemini-4-argon-contributor",
    JSON.stringify(leadDecision),
  );
  check(
    "e8b: promptAsync do lead carrega agent EXPLÍCITO 'diana' (nunca omitido) + abort na sessão do lead",
    leadClient.calls.promptAsync.length === 1
      && leadClient.calls.promptAsync[0].sessionID === "sess-lead-guard-pa"
      && leadClient.calls.promptAsync[0].agent === "diana"
      && leadClient.calls.promptAsync[0].synthetic === true
      && leadClient.calls.abort.some((c) => c.sessionID === "sess-lead-guard-pa"),
    JSON.stringify(leadClient.calls.promptAsync),
  );
  check(
    "e8c: BOARD DE MEMBROS INTACTO — zero escrita em team_member e zero team_message no failover do lead",
    ghostBefore && eq(getMember(db, "team-lead-guard-pa", "ghost"), { model: "prov/primary", status: "busy", agent: "build" })
      && totalMessages(db) === 0
      && db.query("SELECT model FROM team_member WHERE team_id = 'team-lead-guard-pa' AND name <> 'ghost'").all().length === 0,
    `msgs=${totalMessages(db)}`,
  );

  // Lead SEM cadeia explícita → no-op: a cadeia global NUNCA sequestra o lead.
  seedMember(db, { teamId: "team-lead-nochain-pa", memberName: "ghost2", sessionId: "sess-ghost2-pa", agent: "build", model: "prov/primary", leadSession: "sess-lead-nochain-pa" });
  const noChainLeadClient = makeClient();
  const noChainLeadDecision = await handleRetryModelFailover(db, new MemberRegistry(), noChainLeadClient, CFG, "sess-lead-nochain-pa", { attempt: 1, message: "429", next: Date.now(), agent: "cris" });
  check(
    "e9: lead sem fallbackModelsByAgent[agent] → undefined, zero abort/promptAsync (a global não sequestra)",
    noChainLeadDecision === undefined
      && noChainLeadClient.calls.promptAsync.length === 0 && noChainLeadClient.calls.abort.length === 0
      && getMember(db, "team-lead-nochain-pa", "ghost2").model === "prov/primary",
    JSON.stringify(noChainLeadDecision),
  );

  // Descoberta do agent do lead via team.lead_agent (Migration 5) quando não
  // há hint nem session.get — a cadeia explícita da Diana é honrada.
  const nowLead = Date.now();
  db.run(
    `INSERT INTO team (id, name, lead_session_id, status, delegate, time_created, time_updated, lead_agent)
     VALUES ('team-lead-agent-pa', 'lead-agent-pa', 'sess-lead-agent-pa', 'active', 0, ?, ?, 'diana')`,
    [nowLead, nowLead],
  );
  db.run(
    `INSERT INTO team_member (team_id, name, session_id, agent, status, execution_status, model, prompt, time_created, time_updated)
     VALUES ('team-lead-agent-pa', 'ghost3', 'sess-ghost3-pa', 'build', 'busy', 'running', 'prov/primary', 'x', ?, ?)`,
    [nowLead, nowLead],
  );
  const leadAgentClient = makeClient();
  const leadAgentDecision = await handleRetryModelFailover(db, new MemberRegistry(), leadAgentClient, CFG, "sess-lead-agent-pa", { attempt: 1, message: "429", next: Date.now() });
  check(
    "e10: descoberta via team.lead_agent ('diana') → 'switched' com agent explícito no promptAsync do lead",
    leadAgentDecision?.action === "switched" && leadAgentDecision.memberName === "diana"
      && leadAgentClient.calls.promptAsync.length === 1
      && leadAgentClient.calls.promptAsync[0].agent === "diana"
      && leadAgentClient.calls.promptAsync[0].sessionID === "sess-lead-agent-pa",
    JSON.stringify({ decision: leadAgentDecision, calls: leadAgentClient.calls.promptAsync }),
  );
  check(
    "e11: failover do lead preserva o board — team_member/team_message intocados",
    getMember(db, "team-lead-agent-pa", "ghost3").model === "prov/primary" && totalMessages(db) === 0,
  );

  db.close();
  exDb.close();
  failoverCooldown.clear();
}

/* ------------------------------------------------------------------ *
 * 12. (f) Paridade dist × src — bundle real sob as mesmas leis        *
 * ------------------------------------------------------------------ */
check(
  "f1: resolveFallbackChainForAgent(diana) idêntico no dist (precedência + rigor)",
  eq(distMod.resolveFallbackChainForAgent(CFG, "diana"), resolveFallbackChainForAgent(CFG, "diana"))
    && eq(distMod.resolveFallbackChainForAgent(CFG, "diana"), DIANA_REFS),
  JSON.stringify(distMod.resolveFallbackChainForAgent(CFG, "diana")),
);
check(
  "f2: resolveFallbackChainForAgent(cris) idêntico no dist (delegação global)",
  eq(distMod.resolveFallbackChainForAgent(CFG, "cris"), resolveFallbackChainForAgent(CFG, "cris"))
    && eq(distMod.resolveFallbackChainForAgent(CFG, "cris"), GLOBAL_REFS),
);

{
  const db = makeDb();
  const client = makeClient();
  const now = Date.now();
  db.run(
    `INSERT INTO team (id, name, lead_session_id, status, delegate, time_created, time_updated)
     VALUES ('team-dist-pa', 'dist-pa', ?, 'active', 0, ?, ?)`,
    [LEAD_SESSION, now, now],
  );
  db.run(
    `INSERT INTO team_member (team_id, name, session_id, agent, status, execution_status, model, prompt, time_created, time_updated)
     VALUES ('team-dist-pa', 'diana', 'sess-dist-diana', 'diana', 'busy', 'running', 'opencode-go/gemini-4-argon-contributor', 'x', ?, ?)`,
    [now, now],
  );
  const registry = new distMod.MemberRegistry();
  registry.register("team-dist-pa", "diana", "sess-dist-diana");

  const memberDecision = await distMod.handleRetryModelFailover(db, registry, client, CFG, "sess-dist-diana", { attempt: 1, message: "429", next: now });
  const stored = db.query("SELECT model FROM team_member WHERE team_id = 'team-dist-pa' AND name = 'diana'").get();
  check(
    "f3: dist — membro diana caminha a cadeia por-agente (switch gpt-6-luna persistido, zero wake)",
    memberDecision?.action === "switched" && memberDecision.toModel === "opencode-go/gpt-6-luna"
      && stored.model === "opencode-go/gpt-6-luna"
      && !client.calls.promptAsync.some((c) => c.sessionID === LEAD_SESSION),
    JSON.stringify({ memberDecision, stored }),
  );

  const isoClient = makeClient({
    data: { agent: "diana", model: { providerID: "opencode-go", id: "gemini-4-argon-contributor" } },
  });
  const isoDecision = await distMod.handleRetryModelFailover(db, new distMod.MemberRegistry(), isoClient, CFG, "sess-dist-iso", { attempt: 1, message: "429", next: now });
  check(
    "f4: dist — sessão isolada diana recebe o MESMO switch (abort+promptAsync, board intacto)",
    isoDecision?.action === "switched" && isoDecision.toModel === "opencode-go/gpt-6-luna" && isoDecision.teamId === ""
      && isoClient.calls.abort.some((c) => c.sessionID === "sess-dist-iso")
      && isoClient.calls.promptAsync.some((c) => c.sessionID === "sess-dist-iso" && c.synthetic === true)
      && db.query("SELECT COUNT(*) AS n FROM team_message").get().n === 0,
    JSON.stringify(isoDecision),
  );

  db.close();
  distMod.failoverCooldown.clear();
}

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
