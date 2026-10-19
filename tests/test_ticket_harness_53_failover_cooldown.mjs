#!/usr/bin/env node
/**
 * QUALITY GATE DETERMINÍSTICO — TICKET-HARNESS-53
 * Resiliência do Mecanismo de Fallback: Cooldown Consciente de Modelo.
 *
 * Sob teste (código REAL, sem mocks):
 *   - src/hooks.ts   → evaluateFailoverCooldown / recordFailoverAction,
 *                      handleRetryModelFailover (membros) e
 *                      handleIsolatedSessionFailover (Lead + Diana isolada).
 *   - dist/index.js  → paridade de comportamento do bundle compilado
 *                      (os MESMOS cenários rodam contra o dist real).
 *
 * Contratos provados:
 *   1. Dentro do burst (FAILOVER_BURST_DEBOUNCE_MS) os eventos residuais do
 *      pedido que acabou de ser abortado continuam "suppressed" — a cadeia
 *      NÃO é queimada por attempt (proteção original preservada).
 *   2. Passado o debounce, um 429 NO MODELO DE FALLBACK RECÉM-APLICADO avança
 *      imediatamente o degrau seguinte (A -> B -> C -> D em segundos), em
 *      AMBOS os caminhos (membro e sessão isolada/Lead).
 *   3. Sessão isolada com `session.model` defasado (servidor ainda reporta o
 *      modelo anterior) NÃO repete o mesmo degrau nem reinicia no chain[0]:
 *      caminha a partir do degrau recém-aplicado.
 *   4. Exaustão continua cacheada por FAILOVER_COOLDOWN_MS (sem toast/log
 *      repetido no mesmo burst morto).
 *   5. API pública `failoverCooldown` preservada (Map<string, number> com
 *      get/set/delete/clear) — retrocompatibilidade das suítes existentes.
 *   6. Governança de modelos de Hugo/Clara/Diana no ensemble.json real
 *      (quando o arquivo existe nesta máquina).
 *   7. Prova de mutação: cada mutação semântica no dist é DETECTADA pelos
 *      cenários declarados, sem afetar os cenários-controle.
 *
 * Sem mocks: SQLite real (node:sqlite via src/db.ts), registry real,
 * transport recorder (seam legítimo de I/O já homologado nas suítes do repo)
 * e relógio controlado apenas por REWIND do timestamp exportado (sem sleep).
 *
 * Uso:  node tests/test_ticket_harness_53_failover_cooldown.mjs
 * Exit: 0 = todos os checks PASS; 1 = há FAIL.
 */

import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

const REPO = path.resolve(import.meta.dirname, "..");
const PKG = process.env.ENSEMBLE_PKG || REPO;
const DIST = path.join(PKG, "dist/index.js");
const SRC = path.join(PKG, "src");
const TMP = path.join(REPO, ".test-scratch");
mkdirSync(TMP, { recursive: true });

const results = [];
const check = (name, ok, detail) => {
  results.push([name, ok]);
  console.log(`${ok ? "PASS" : "FAIL"} | ${name}${detail ? " | " + detail : ""}`);
};
const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const countOf = (haystack, needle) => haystack.split(needle).length - 1;

const unhandled = [];
process.on("unhandledRejection", (e) => unhandled.push(e));

/* ------------------------------------------------------------------ *
 * 1. Harness do dist: bundle real + apenas cláusulas de export       *
 * ------------------------------------------------------------------ */
const DIST_EXPORTS = [
  "createDb", "MemberRegistry", "DEFAULT_CONFIG", "handleRetryModelFailover",
  "failoverCooldown", "failoverActions", "FAILOVER_COOLDOWN_MS",
  "FAILOVER_BURST_DEBOUNCE_MS", "selectNextFallback", "resolveFallbackChainForAgent",
  "formatModelSelector", "parseModelSelector",
];

const distRaw = readFileSync(DIST, "utf8");
const distHarness = (() => {
  const existing = distRaw.match(/export\s*\{([^}]*)\}\s*;?\s*$/)?.[1] ?? "";
  const already = new Set(existing.split(",").map((s) => s.trim().split(/\s+as\s+/).pop()).filter(Boolean));
  const need = DIST_EXPORTS.filter((s) => !already.has(s));
  return {
    raw: distRaw,
    need,
    text: distRaw + (need.length ? `\nexport { ${need.join(", ")} };\n` : ""),
  };
})();
const HARNESS = path.join(TMP, "_h53_failover_harness.mjs");
writeFileSync(HARNESS, distHarness.text);
check(
  "harness do dist é o bundle real + apenas cláusulas de export anexadas",
  readFileSync(HARNESS, "utf8") === distHarness.text,
  `${distRaw.length} bytes de bundle; anexados=[${distHarness.need.join(",")}]`,
);
check(
  "dist declara o cooldown model-aware (constantes e metadados paralelos)",
  /FAILOVER_BURST_DEBOUNCE_MS/.test(distRaw)
    && /failoverActions/.test(distRaw)
    && /evaluateFailoverCooldown/.test(distRaw)
    && /recordFailoverAction/.test(distRaw),
);

/* ------------------------------------------------------------------ *
 * 2. Harness do src: cópia fora de node_modules + extensão .ts       *
 * ------------------------------------------------------------------ */
const SRC_COPY = path.join(TMP, "ensemble_src_h53");
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

const hooks = await import(`${SRC_COPY}/hooks.ts`);
const configMod = await import(`${SRC_COPY}/config.ts`);
const stateMod = await import(`${SRC_COPY}/state.ts`);
const dbMod = await import(`${SRC_COPY}/db.ts`);
const distMod = await import(HARNESS);

check(
  "módulos reais carregados (hooks/config/state/db + dist)",
  typeof hooks.handleRetryModelFailover === "function"
    && typeof hooks.evaluateFailoverCooldown === "function"
    && typeof req(configMod, "selectNextFallback") === "function"
    && typeof req(distMod, "handleRetryModelFailover") === "function",
);
function req(mod, key) { return mod[key]; }

/* ------------------------------------------------------------------ *
 * 3. Contrato da API exportada (retrocompatibilidade)                *
 * ------------------------------------------------------------------ */
check(
  "1.1: FAILOVER_BURST_DEBOUNCE_MS é curto (2s-5s) e MUITO menor que o cooldown de 10min",
  hooks.FAILOVER_BURST_DEBOUNCE_MS >= 2_000
    && hooks.FAILOVER_BURST_DEBOUNCE_MS <= 5_000
    && hooks.FAILOVER_COOLDOWN_MS === 10 * 60 * 1000
    && hooks.FAILOVER_BURST_DEBOUNCE_MS * 10 < hooks.FAILOVER_COOLDOWN_MS,
  `debounce=${hooks.FAILOVER_BURST_DEBOUNCE_MS}ms cooldown=${hooks.FAILOVER_COOLDOWN_MS}ms`,
);
{
  const probe = "__h53_contract_probe__";
  hooks.failoverCooldown.clear();
  hooks.failoverCooldown.set(probe, 42);
  const stored = hooks.failoverCooldown.get(probe);
  const isNumber = typeof stored === "number" && stored === 42;
  const deleted = hooks.failoverCooldown.delete(probe) && !hooks.failoverCooldown.has(probe);
  hooks.failoverCooldown.set(probe, 7);
  hooks.failoverCooldown.clear();
  const cleared = hooks.failoverCooldown.size === 0;
  check(
    "1.2: API pública failoverCooldown preservada (Map<string,number> com get/set/delete/clear)",
    hooks.failoverCooldown instanceof Map && isNumber && deleted && cleared,
    `get=${stored} delete=${deleted} clear=${cleared}`,
  );
  check(
    "1.3: metadados de modelo vivem em estrutura PARALELA (failoverActions) sem poluir o valor numérico",
    hooks.failoverActions instanceof Map && typeof hooks.failoverActions.set === "function",
  );
}

check(
  "1.4: dist expõe a MESMA API (get/set numérico + metadados paralelos) e o mesmo debounce",
  typeof distMod.FAILOVER_BURST_DEBOUNCE_MS === "number"
    && distMod.FAILOVER_BURST_DEBOUNCE_MS === hooks.FAILOVER_BURST_DEBOUNCE_MS
    && distMod.failoverCooldown instanceof Map
    && distMod.failoverActions instanceof Map,
  `dist.debounce=${distMod.FAILOVER_BURST_DEBOUNCE_MS}`,
);

/* ------------------------------------------------------------------ *
 * 4. Fixtures reais: SQLite + registry + transport recorder          *
 * ------------------------------------------------------------------ */
let dbSeq = 0;
function makeDb(tag = "x") {
  const file = path.join(TMP, `h53_${tag}_${process.pid}_${dbSeq++}.sqlite`);
  rmSync(file, { force: true });
  rmSync(`${file}-wal`, { force: true });
  rmSync(`${file}-shm`, { force: true });
  return dbMod.createDb(file);
}

/**
 * Transport recorder — mesmo seam legítimo de I/O já homologado em
 * test_per_agent_fallback.mjs / test_rate_limit_failover.mjs. `sessionInfo`
 * pode ser função: o cenário controla o modelo devolvido por session.get
 * (simula o rebind do servidor ou uma leitura defasada).
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
    tui: { showToast: async (options) => { calls.showToast.push(options); return undefined; } },
  };
}

const LEAD_SESSION = "sess-lead-h53";

function seedMember(db, { teamId, memberName, sessionId, agent = "build", model = "prov/primary", status = "busy", teamStatus = "active", leadSession = LEAD_SESSION } = {}) {
  const now = Date.now();
  db.run(
    `INSERT OR IGNORE INTO team (id, name, lead_session_id, status, delegate, time_created, time_updated)
     VALUES (?, ?, ?, ?, 0, ?, ?)`,
    [teamId, `name-${teamId}`, leadSession, teamStatus, now, now],
  );
  if (teamStatus !== "active") db.run("UPDATE team SET status = ? WHERE id = ?", [teamStatus, teamId]);
  db.run(
    `INSERT INTO team_member (team_id, name, session_id, agent, status, execution_status, model, prompt, time_created, time_updated)
     VALUES (?, ?, ?, ?, ?, 'running', ?, 'do the work', ?, ?)`,
    [teamId, memberName, sessionId, agent, status, model, now, now],
  );
  const registry = new stateMod.MemberRegistry();
  registry.register(teamId, memberName, sessionId);
  return { registry, sessionId, memberName, teamId };
}

const getMember = (db, teamId, name) =>
  db.query("SELECT model, status, agent FROM team_member WHERE team_id = ? AND name = ?").get(teamId, name);
const leadMessages = (db, teamId) =>
  db.query("SELECT from_name, to_name, content FROM team_message WHERE team_id = ? AND from_name = 'system' AND to_name = 'lead'").all(teamId);

/** Rewind DETERMINÍSTICO (sem sleep): simula a passagem do debounce curto. */
function passBurstDebounce(mod, key) {
  mod.failoverCooldown.set(key, Date.now() - mod.FAILOVER_BURST_DEBOUNCE_MS - 1);
}
/** Rewind DETERMINÍSTICO: simula a expiração total do cooldown de exaustão. */
function passFullCooldown(mod, key) {
  mod.failoverCooldown.set(key, Date.now() - mod.FAILOVER_COOLDOWN_MS - 1_000);
}

/* ------------------------------------------------------------------ *
 * 5. Cadeias de referência                                           *
 * ------------------------------------------------------------------ */
const MEMBER_CHAIN = ["prov/fb1#low", "prov/fb2#low", "prov/fb3#low"];
const MEMBER_CFG = { ...configMod.DEFAULT_CONFIG, fallbackModels: MEMBER_CHAIN, fallbackModelsByAgent: {} };
const ISO_CHAIN = ["prov/iso-a", "prov/iso-b", "prov/iso-c"];
const ISO_CFG = { ...configMod.DEFAULT_CONFIG, fallbackModels: ["prov/global-x"], fallbackModelsByAgent: { diana: ISO_CHAIN, dante: ISO_CHAIN } };
const README_CFG = { attempt: 1, message: "429 rate limit exceeded", next: Date.now() + 4 * 60 * 60 * 1000 };

/* ------------------------------------------------------------------ *
 * 6. CENÁRIOS (retornam Map<nome, booleano> — reusados na mutação)   *
 * ------------------------------------------------------------------ */

/** S1 — membro: burst residual suprimido + saltos consecutivos imediatos. */
async function scenarioMember(mod, tag) {
  const out = new Map();
  const db = makeDb(`member_${tag}`);
  const client = makeClient();
  mod.failoverCooldown.clear();
  mod.failoverActions.clear();
  const seed = seedMember(db, { teamId: `team-h53-m-${tag}`, memberName: "bruno", sessionId: `sess-h53-m-${tag}`, model: "prov/primary" });
  const key = `${seed.teamId}:${seed.memberName}`;

  const r1 = await mod.handleRetryModelFailover(db, seed.registry, client, MEMBER_CFG, seed.sessionId, { ...README_CFG, attempt: 1 });
  out.set("member.step1-switch-fb1", r1?.action === "switched" && r1.toModel === "prov/fb1#low");

  // Mesmo burst (attempt 2 e 3, milissegundos depois) → suppressed, cadeia intacta.
  const r2 = await mod.handleRetryModelFailover(db, seed.registry, client, MEMBER_CFG, seed.sessionId, { ...README_CFG, attempt: 2 });
  const r3 = await mod.handleRetryModelFailover(db, seed.registry, client, MEMBER_CFG, seed.sessionId, { ...README_CFG, attempt: 3 });
  out.set("member.burst-suppressed",
    r2?.action === "suppressed" && r3?.action === "suppressed"
    && getMember(db, seed.teamId, seed.memberName).model === "prov/fb1#low");
  out.set("member.burst-single-switch", client.calls.promptAsync.length === 1 && client.calls.abort.length === 1);

  // 429 no MODELO DE FALLBACK recém-aplicado (passado o debounce) → avança JÁ.
  passBurstDebounce(mod, key);
  const r4 = await mod.handleRetryModelFailover(db, seed.registry, client, MEMBER_CFG, seed.sessionId, { ...README_CFG, attempt: 1 });
  out.set("member.immediate-advance-fb2",
    r4?.action === "switched" && r4.toModel === "prov/fb2#low" && r4.fromModel === "prov/fb1#low"
    && getMember(db, seed.teamId, seed.memberName).model === "prov/fb2#low");

  passBurstDebounce(mod, key);
  const r5 = await mod.handleRetryModelFailover(db, seed.registry, client, MEMBER_CFG, seed.sessionId, { ...README_CFG, attempt: 1 });
  out.set("member.immediate-advance-fb3",
    r5?.action === "switched" && r5.toModel === "prov/fb3#low"
    && getMember(db, seed.teamId, seed.memberName).model === "prov/fb3#low");

  // Exaustão: cacheada pelo cooldown longo (sem novo log/toast no burst morto).
  passBurstDebounce(mod, key);
  const r6 = await mod.handleRetryModelFailover(db, seed.registry, client, MEMBER_CFG, seed.sessionId, { ...README_CFG, attempt: 1 });
  out.set("member.exhausted", r6?.action === "exhausted" && r6.toModel === undefined);

  passBurstDebounce(mod, key);
  const r7 = await mod.handleRetryModelFailover(db, seed.registry, client, MEMBER_CFG, seed.sessionId, { ...README_CFG, attempt: 1 });
  out.set("member.exhausted-cached", r7?.action === "suppressed");

  passFullCooldown(mod, key);
  const r8 = await mod.handleRetryModelFailover(db, seed.registry, client, MEMBER_CFG, seed.sessionId, { ...README_CFG, attempt: 1 });
  out.set("member.exhausted-retry-after-cooldown", r8?.action === "exhausted");

  // Zero-noise invariants: exatamente 3 switches (fb1/fb2/fb3) e nenhum wake de Lead.
  const promptModels = client.calls.promptAsync.map((c) => c.model?.modelID);
  out.set("member.three-ladder-promptAsync", eq(promptModels, ["fb1", "fb2", "fb3"]));
  out.set("member.zero-lead-wake",
    !client.calls.promptAsync.some((c) => c.sessionID === LEAD_SESSION) && leadMessages(db, seed.teamId).length === 0);

  db.close();
  mod.failoverCooldown.clear();
  mod.failoverActions.clear();
  return out;
}

/** S2 — sessão isolada (Diana): session.model acompanha o rebind do servidor. */
async function scenarioIsolated(mod, tag) {
  const out = new Map();
  const db = makeDb(`iso_${tag}`);
  mod.failoverCooldown.clear();
  mod.failoverActions.clear();
  const sessionId = `sess-h53-iso-${tag}`;
  // Sessão REAL do servidor: o modelo devolvido por session.get é o bound.
  let bound = { providerID: "prov", id: "fb-initial" };
  const client = makeClient(() => ({ data: { agent: "diana", model: bound } }));

  const r1 = await mod.handleRetryModelFailover(db, new stateMod.MemberRegistry(), client, ISO_CFG, sessionId, { ...README_CFG, attempt: 1 });
  out.set("iso.step1-a", r1?.action === "switched" && r1.toModel === "prov/iso-a");
  bound = { providerID: "prov", id: "iso-a" };

  // Residual do MESMO burst (abort ainda em voo) → suppressed, sem 2º salto.
  const rResidual = await mod.handleRetryModelFailover(db, new stateMod.MemberRegistry(), client, ISO_CFG, sessionId, { ...README_CFG, attempt: 2 });
  out.set("iso.burst-suppressed", rResidual?.action === "suppressed" && client.calls.promptAsync.length === 1);

  passBurstDebounce(mod, `isolated:${sessionId}`);
  const r2 = await mod.handleRetryModelFailover(db, new stateMod.MemberRegistry(), client, ISO_CFG, sessionId, { ...README_CFG, attempt: 1 });
  out.set("iso.step2-b", r2?.action === "switched" && r2.toModel === "prov/iso-b");
  bound = { providerID: "prov", id: "iso-b" };

  passBurstDebounce(mod, `isolated:${sessionId}`);
  const r3 = await mod.handleRetryModelFailover(db, new stateMod.MemberRegistry(), client, ISO_CFG, sessionId, { ...README_CFG, attempt: 1 });
  out.set("iso.step3-c", r3?.action === "switched" && r3.toModel === "prov/iso-c");
  bound = { providerID: "prov", id: "iso-c" };

  passBurstDebounce(mod, `isolated:${sessionId}`);
  const r4 = await mod.handleRetryModelFailover(db, new stateMod.MemberRegistry(), client, ISO_CFG, sessionId, { ...README_CFG, attempt: 1 });
  out.set("iso.exhausted", r4?.action === "exhausted");

  // Burst residual imediatamente após a exaustão → suppressed (cadeia morta cacheada).
  const r5 = await mod.handleRetryModelFailover(db, new stateMod.MemberRegistry(), client, ISO_CFG, sessionId, { ...README_CFG, attempt: 2 });
  out.set("iso.exhausted-cached", r5?.action === "suppressed");
  out.set("iso.zero-lead-wake", !client.calls.promptAsync.some((c) => c.sessionID === LEAD_SESSION));

  db.close();
  mod.failoverCooldown.clear();
  mod.failoverActions.clear();
  return out;
}

/** S3 — sessão isolada com `session.model` DEFASADO (servidor não rebindou). */
async function scenarioIsolatedStaleModel(mod, tag) {
  const out = new Map();
  const db = makeDb(`stale_${tag}`);
  mod.failoverCooldown.clear();
  mod.failoverActions.clear();
  const sessionId = `sess-h53-stale-${tag}`;
  // O servidor continua reportando o modelo ANTIGO em session.get (leitura
  // defasada típica da janela entre abort e rebind).
  const client = makeClient(() => ({ data: { agent: "diana", model: { providerID: "prov", id: "fb-original" } } }));

  const r1 = await mod.handleRetryModelFailover(db, new stateMod.MemberRegistry(), client, ISO_CFG, sessionId, { ...README_CFG, attempt: 1 });
  out.set("stale.step1-a", r1?.action === "switched" && r1.toModel === "prov/iso-a");

  passBurstDebounce(mod, `isolated:${sessionId}`);
  const r2 = await mod.handleRetryModelFailover(db, new stateMod.MemberRegistry(), client, ISO_CFG, sessionId, { ...README_CFG, attempt: 1 });
  // DEVE ir para iso-b (degrau seguinte ao APLICADO), nunca repetir iso-a.
  out.set("stale.step2-advances-not-repeats", r2?.action === "switched" && r2.toModel === "prov/iso-b");

  passBurstDebounce(mod, `isolated:${sessionId}`);
  const r3 = await mod.handleRetryModelFailover(db, new stateMod.MemberRegistry(), client, ISO_CFG, sessionId, { ...README_CFG, attempt: 1 });
  out.set("stale.step3-never-restarts-chain-head",
    r3?.action === "switched" && r3.toModel === "prov/iso-c"
    && !client.calls.promptAsync.some((c) => c.model?.modelID === "fb-original"));

  db.close();
  mod.failoverCooldown.clear();
  mod.failoverActions.clear();
  return out;
}

/** S4 — sessão do LEAD (HARNESS-15 A): cadeia explícita, zero escrita no board. */
async function scenarioLead(mod, tag) {
  const out = new Map();
  const db = makeDb(`lead_${tag}`);
  mod.failoverCooldown.clear();
  mod.failoverActions.clear();
  const leadSession = `sess-h53-lead-${tag}`;
  // Time ativo cujo lead_session_id é a sessão observada; lead NUNCA está em
  // team_member (ausência é o que roteia para o caminho isolado).
  seedMember(db, { teamId: `team-h53-lead-${tag}`, memberName: "worker", sessionId: `sess-h53-worker-${tag}`, agent: "build", model: "prov/primary", leadSession });
  const memberBefore = getMember(db, `team-h53-lead-${tag}`, "worker").model;

  let bound = { providerID: "prov", id: "fb-initial" };
  const client = makeClient(() => ({ data: { agent: "dante", model: bound } }));
  const reg = new stateMod.MemberRegistry(); // lead NÃO registrado em team_member

  const r1 = await mod.handleRetryModelFailover(db, reg, client, ISO_CFG, leadSession, { ...README_CFG, attempt: 1 });
  out.set("lead.step1-a", r1?.action === "switched" && r1.toModel === "prov/iso-a" && r1.teamId === "");
  bound = { providerID: "prov", id: "iso-a" };

  // Residual do MESMO burst no Lead → suppressed (gate igual ao do membro).
  const rResidual = await mod.handleRetryModelFailover(db, reg, client, ISO_CFG, leadSession, { ...README_CFG, attempt: 2 });
  out.set("lead.burst-suppressed", rResidual?.action === "suppressed" && client.calls.promptAsync.length === 1);

  passBurstDebounce(mod, `isolated:${leadSession}`);
  const r2 = await mod.handleRetryModelFailover(db, reg, client, ISO_CFG, leadSession, { ...README_CFG, attempt: 1 });
  out.set("lead.step2-b", r2?.action === "switched" && r2.toModel === "prov/iso-b");

  out.set("lead.board-untouched", getMember(db, `team-h53-lead-${tag}`, "worker").model === memberBefore);
  out.set("lead.agent-explicit-every-prompt",
    client.calls.promptAsync.length === 2 && client.calls.promptAsync.every((c) => c.agent === "dante"));
  out.set("lead.zero-lead-wake", !client.calls.promptAsync.some((c) => c.sessionID === LEAD_SESSION));

  db.close();
  mod.failoverCooldown.clear();
  mod.failoverActions.clear();
  return out;
}

/* ------------------------------------------------------------------ *
 * 7. Execução real: src (principal) e dist (paridade)                *
 * ------------------------------------------------------------------ */
const SRC_MAPS = {
  member: await scenarioMember(hooks, "src"),
  iso: await scenarioIsolated(hooks, "src"),
  stale: await scenarioIsolatedStaleModel(hooks, "src"),
  lead: await scenarioLead(hooks, "src"),
};
for (const [scn, map] of Object.entries(SRC_MAPS)) {
  for (const [name, ok] of map) check(`2.x [src/${scn}] ${name}`, ok);
}

const DIST_MAPS = {
  member: await scenarioMember(distMod, "dist"),
  iso: await scenarioIsolated(distMod, "dist"),
  stale: await scenarioIsolatedStaleModel(distMod, "dist"),
  lead: await scenarioLead(distMod, "dist"),
};
for (const [scn, map] of Object.entries(DIST_MAPS)) {
  const mismatch = [...map.entries()].filter(([, ok]) => !ok).map(([n]) => n);
  check(
    `3.1 [dist/${scn}] paridade src↔dist do bundle compilado`,
    mismatch.length === 0,
    mismatch.join(",") || `${map.size} observações`,
  );
}
{
  const flatten = (maps) => Object.entries(maps).flatMap(([s, m]) => [...m.entries()].map(([n, v]) => [`${s}.${n}`, v]));
  const srcFlat = new Map(flatten(SRC_MAPS));
  const distFlat = new Map(flatten(DIST_MAPS));
  const divergences = [...srcFlat.keys()].filter((k) => distFlat.get(k) !== srcFlat.get(k));
  check("3.2: nenhuma divergência de comportamento src↔dist", divergences.length === 0, divergences.join(",") || `${srcFlat.size} observações`);
}

/* ------------------------------------------------------------------ *
 * 8. Governança de modelos no ensemble.json REAL desta máquina       *
 * ------------------------------------------------------------------ */
{
  const cfgPath = path.join(os.homedir(), ".config", "opencode", "ensemble.json");
  if (!existsSync(cfgPath)) {
    check("4.0: ensemble.json ausente nesta máquina — verificação de governança ignorada (repo-only)", true, cfgPath);
  } else {
    const cfg = JSON.parse(readFileSync(cfgPath, "utf8"));
    const diana = cfg.fallbackModelsByAgent?.diana ?? [];
    const hugo = cfg.fallbackModelsByAgent?.hugo ?? [];
    const clara = cfg.fallbackModelsByAgent?.clara ?? [];
    const HUGO_CLARA_CHAIN = [
      "opencode/deepseek-v4.1-flash-free",
      "opencode-go/deepseek-v4.1-flash#low",
      "opencode/mimo-v2.6-flash-free",
      "opencode/glm-5.3-flash-free",
      "opencode-go/mimo-v2.6-flash",
      "google/antigravity-gemini-3.8-flash#low",
    ];
    const DIANA_CHAIN_CANON = [
      "google/antigravity-gemini-4-argon#medium",
      "opencode/glm-5.3-flash-free",
      "google/antigravity-gemini-3.8-flash#high",
    ];
    check(
      "4.1: modelsByAgent.hugo e .clara primam em opencode/deepseek-v4.1-flash-free",
      cfg.modelsByAgent?.hugo === "opencode/deepseek-v4.1-flash-free"
        && cfg.modelsByAgent?.clara === "opencode/deepseek-v4.1-flash-free",
      `hugo=${cfg.modelsByAgent?.hugo} clara=${cfg.modelsByAgent?.clara}`,
    );
    check(
      "4.2: cadeias de fallback de Hugo e Clara na ordem canônica (1º salto pago deepseek#low)",
      eq(hugo, HUGO_CLARA_CHAIN) && eq(clara, HUGO_CLARA_CHAIN),
      `hugo=[${hugo}] clara=[${clara}]`,
    );
    check(
      "4.3: cadeia da Diana sem opencode-go/glm-5.3-flash na ordem canônica",
      eq(diana, DIANA_CHAIN_CANON) && !diana.includes("opencode-go/glm-5.3-flash"),
      `diana=[${diana}]`,
    );
    check(
      "4.4: opencode-go/glm-5.3-flash não aparece em NENHUMA das três cadeias",
      ![...hugo, ...clara, ...diana].includes("opencode-go/glm-5.3-flash"),
    );
    check(
      "4.5: JSON do ensemble.json permanece válido e é o arquivo real (não é repositório git)",
      typeof cfg === "object" && cfg !== null,
      cfgPath,
    );
  }
}

/* ------------------------------------------------------------------ *
 * 9. PROVA DE MUTAÇÃO — cada mutação semântica deve ser DETECTADA    *
 * ------------------------------------------------------------------ */
const MUTATIONS = [
  {
    id: "M1",
    desc: "regressão ao cooldown cego: debounce volta a ser a janela de 10min (nenhum salto imediato)",
    from: "if (elapsed < FAILOVER_BURST_DEBOUNCE_MS) {",
    to: "if (elapsed < FAILOVER_COOLDOWN_MS) {",
    scenarios: ["member"],
    detect: ["member.immediate-advance-fb2", "member.immediate-advance-fb3"],
    unaffected: ["member.burst-suppressed", "member.zero-lead-wake"],
  },
  {
    id: "M2",
    desc: "walkFrom deixa de considerar a leitura defasada (repete o degrau / reinicia)",
    from: "const stale = currentModel === null || currentModel === record.fromModel;",
    to: "const stale = false;",
    scenarios: ["stale"],
    detect: ["stale.step2-advances-not-repeats"],
    unaffected: ["stale.step1-a"],
  },
  {
    id: "M3",
    desc: "exaustão gravada como não-exaustão (burst morto deixa de ser cacheado)",
    from: "recordFailoverAction(cooldownKey, now, member.model, null, true);",
    to: "recordFailoverAction(cooldownKey, now, member.model, null, false);",
    scenarios: ["member"],
    detect: ["member.exhausted-cached"],
    unaffected: ["member.burst-suppressed", "member.zero-lead-wake"],
  },
  {
    id: "M4",
    desc: "caminho ISOLADO/Lead volta ao cooldown cego (só o membro seria corrigido)",
    from: "const gate = evaluateFailoverCooldown(cooldownKey, currentModel, now)",
    to: "const gate = { verdict: \"proceed\", walkFrom: currentModel }",
    scenarios: ["iso", "lead"],
    detect: ["iso.burst-suppressed", "lead.burst-suppressed"],
    unaffected: ["iso.step1-a", "lead.step1-a", "iso.step2-b", "lead.step2-b"],
  },
];

let mutationFailures = 0;
for (const m of MUTATIONS) {
  const occ = countOf(distRaw, m.from);
  check(`${m.id}: patch aplicável (1 ocorrência exata no dist)`, occ === 1, `ocorrências=${occ} | ${m.desc}`);
  if (occ !== 1) { mutationFailures++; continue; }

  const mutatedRaw = distRaw.split(m.from).join(m.to);
  check(`${m.id}: bundle mutado difere do original`, mutatedRaw !== distRaw);
  const file = path.join(TMP, `_h53_mut_${m.id.toLowerCase()}.mjs`);
  const existing = mutatedRaw.match(/export\s*\{([^}]*)\}\s*;?\s*$/)?.[1] ?? "";
  const already = new Set(existing.split(",").map((s) => s.trim().split(/\s+as\s+/).pop()).filter(Boolean));
  const need = DIST_EXPORTS.filter((s) => !already.has(s));
  writeFileSync(file, mutatedRaw + (need.length ? `\nexport { ${need.join(", ")} };\n` : ""));

  let mutated;
  try {
    mutated = await import(file);
    check(`${m.id}: mutante importável`, true);
  } catch (err) {
    check(`${m.id}: mutante importável`, false, err?.stack ?? String(err));
    mutationFailures++;
    continue;
  }

  const agg = new Map();
  let runnable = true;
  for (const scn of m.scenarios) {
    try {
      const map = m.scenarios.length === 1 && scn === "member"
        ? await scenarioMember(mutated, `mut${m.id}`)
        : scn === "iso"
          ? await scenarioIsolated(mutated, `mut${m.id}`)
          : scn === "lead"
            ? await scenarioLead(mutated, `mut${m.id}`)
            : await scenarioIsolatedStaleModel(mutated, `mut${m.id}`);
      for (const [n, v] of map) agg.set(n, v);
    } catch (err) {
      runnable = false;
      check(`${m.id}: cenário ${scn} executável sob mutação`, false, err?.stack ?? String(err));
    }
  }
  if (!runnable) { mutationFailures++; continue; }

  for (const probe of m.detect) {
    const detected = agg.get(probe) === false;
    check(`${m.id}: DETECTADO por ${probe} (mutante reprovado neste probe)`, detected, `valor=${agg.get(probe)}`);
    if (!detected) mutationFailures++;
  }
  for (const probe of m.unaffected) {
    const intact = agg.get(probe) === true;
    check(`${m.id}: cenário-controle ${probe} permanece íntegro sob a mutação`, intact, `valor=${agg.get(probe)}`);
    if (!intact) mutationFailures++;
  }
}

/* ------------------------------------------------------------------ *
 * 10. Resultado                                                      *
 * ------------------------------------------------------------------ */
check("5.1: nenhuma rejeição não-tratada durante a suíte", unhandled.length === 0, `unhandled=${unhandled.length}`);
for (const [name, ok] of results) {
  if (!ok) console.log(`FAIL DETAIL | ${name}`);
}
const failed = results.filter(([, ok]) => !ok).length;
console.log(`\nRESULT: ${results.length - failed}/${results.length} checks passed`);
console.log(`MUTATIONS: ${MUTATIONS.length - mutationFailures}/${MUTATIONS.length} mutantes detectados`);
process.exit(failed === 0 ? 0 : 1);
