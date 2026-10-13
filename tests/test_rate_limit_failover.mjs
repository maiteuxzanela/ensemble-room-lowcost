#!/usr/bin/env node
/**
 * QUALITY GATE DETERMINÍSTICO — Failover silencioso de modelo em rate limit
 * (429/retry) do @maiteuxzanela/ensemble-room-lowcost — política ZERO-NOISE.
 *
 * Sob teste (código REAL, não simulado):
 *   - src/hooks.ts       → handleRetryModelFailover (decisão + troca de modelo),
 *                          failoverCooldown/FAILOVER_COOLDOWN_MS (dedupe de
 *                          burst), handleSessionStatusEvent (persistência
 *                          retry_*).
 *   - src/v2-events.ts   → dispatchV2Event: session.retry.scheduled e
 *                          session.status{type:"retry"} disparam o failover e
 *                          ENCAMPHAM o payload retry (bug legado de drop).
 *   - src/config.ts      → selectNextFallback (caminhamento da cadeia),
 *                          resolveFallbackChain/formatModelSelector.
 *   - src/db.ts/schema   → SQLite REAL (node:sqlite) com TODAS as migrations.
 *   - src/state.ts       → MemberRegistry real.
 *   - dist/index.js      → paridade do bundle real (mesmas asserções centrais).
 *
 * Único ponto de emenda: o TRANSPORTE DE SAÍDA (promptAsync/showToast) é
 * gravado num array para provar O QUE foi chamado — mesmo padrão homologado em
 * test_watchdog_heartbeat.mjs. Nenhuma lógica de decisão é substituída: sem
 * mock library, sem stub de banco, sem fixture falsa. Bancos são SQLite REAIS.
 *
 * Invariantes verificadas (mandato da Maiteux):
 *   (a) fallback disponível  → troca SILENCIOSA: zero promptAsync no lead,
 *       zero team_message, apenas log + UPDATE do modelo;
 *   (b) retry repetido no mesmo burst → "suppressed" (cooldown), zero ruído;
 *   (c) cadeia esgotada      → EXATAMENTE 1 wake do lead + 1 mensagem
 *       persistida (a única exceção de ruído autorizada);
 *   (d) sessão não-membro / time arquivado / membro em shutdown → no-op.
 *
 * Uso:  node tests/test_rate_limit_failover.mjs
 * Exit: 0 = todos os checks PASS; 1 = há FAIL.
 */

import { cpSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
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
const HARNESS = path.join(TMP, "_failover_harness.mjs");
const DIST_EXPORTS = [
  "handleRetryModelFailover", "failoverCooldown", "FAILOVER_COOLDOWN_MS",
  "dispatchV2Event", "handleSessionStatusEvent",
  "MemberRegistry", "DescendantTracker", "createDb",
  "DEFAULT_CONFIG", "resolveFallbackChain", "selectNextFallback",
  "formatModelSelector", "parseModelSelector",
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
const SRC_COPY = path.join(TMP, "ensemble_src_failover");
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
const hooks = await import(`${SRC_COPY}/hooks.ts`);
const configMod = await import(`${SRC_COPY}/config.ts`);
const v2Events = await import(`${SRC_COPY}/v2-events.ts`);
const stateMod = await import(`${SRC_COPY}/state.ts`);
const dbMod = await import(`${SRC_COPY}/db.ts`);
const distMod = await import(HARNESS);
check(
  "módulos reais carregados (hooks, config, v2-events, state, db, dist)",
  typeof hooks.handleRetryModelFailover === "function"
    && typeof v2Events.dispatchV2Event === "function"
    && typeof distMod.handleRetryModelFailover === "function",
);

const { handleRetryModelFailover, failoverCooldown, FAILOVER_COOLDOWN_MS } = hooks;
const { MemberRegistry, DescendantTracker } = stateMod;
const { createDb } = dbMod;
const { DEFAULT_CONFIG, selectNextFallback, resolveFallbackChain, formatModelSelector } = configMod;

/* ------------------------------------------------------------------ *
 * 4. selectNextFallback — caminhamento para frente da cadeia          *
 * ------------------------------------------------------------------ */
const chain2 = resolveFallbackChain({ fallbackModels: ["prov/a#low", "prov/b"] });
check(
  "selectNextFallback: current na 1ª posição → 2ª entrada",
  eq(selectNextFallback(chain2, "prov/a#low"), { model: "prov/b" }),
  JSON.stringify(selectNextFallback(chain2, "prov/a#low")),
);
check(
  "selectNextFallback: current na ÚLTIMA posição → undefined (esgotado, sem wrap-around)",
  selectNextFallback(chain2, "prov/b") === undefined,
);
check(
  "selectNextFallback: current fora da chain → primeira entrada que difere",
  eq(selectNextFallback(chain2, "prov/z#high"), { model: "prov/a", variant: "low" }),
);
check(
  "selectNextFallback: sem current → cabeça da chain",
  eq(selectNextFallback(chain2, null), { model: "prov/a", variant: "low" })
    && eq(selectNextFallback(chain2, undefined), { model: "prov/a", variant: "low" }),
);
check(
  "selectNextFallback: chain vazia → undefined",
  selectNextFallback([], "prov/a") === undefined,
);
check(
  "selectNextFallback: default chain (gemini-3.8-flash#low) com primário sem variant → failover barato",
  eq(selectNextFallback(resolveFallbackChain({}), "google/antigravity-gemini-3.8-flash"),
    { model: "google/antigravity-gemini-3.8-flash", variant: "low" }),
);

/* ------------------------------------------------------------------ *
 * 5. Fixtures reais: SQLite + registry + client com transporte gravado*
 * ------------------------------------------------------------------ */
let dbSeq = 0;
function makeDb() {
  const file = path.join(TMP, `failover_${process.pid}_${dbSeq++}.sqlite`);
  rmSync(file, { force: true });
  rmSync(`${file}-wal`, { force: true });
  rmSync(`${file}-shm`, { force: true });
  return createDb(file);
}

/** Transport recorder — same seam homologado nas suítes existentes. */
function makeClient() {
  const calls = { promptAsync: [], showToast: [] };
  return {
    calls,
    session: {
      promptAsync: async (options) => { calls.promptAsync.push(options); return undefined; },
      abort: async () => { throw new Error("unexpected session.abort in failover path"); },
      create: async () => { throw new Error("unexpected session.create in failover path"); },
    },
    tui: {
      showToast: async (options) => { calls.showToast.push(options); return undefined; },
    },
  };
}

const TEAM_ID = "team-fail-1";
const LEAD_SESSION = "lead-session-1";

/** Insert a real active team + one member row (real schema, real migrations). */
function seedMember(db, { teamId = TEAM_ID, memberName = "ana", sessionId = "sess-ana", model = "google/antigravity-gemini-3.8-flash", status = "busy", teamStatus = "active" } = {}) {
  const now = Date.now();
  db.run(
    `INSERT OR IGNORE INTO team (id, name, lead_session_id, status, delegate, time_created, time_updated)
     VALUES (?, ?, ?, ?, 0, ?, ?)`,
    [teamId, `name-${teamId}`, LEAD_SESSION, teamStatus, now, now],
  );
  if (teamStatus !== "active") {
    db.run("UPDATE team SET status = ? WHERE id = ?", [teamStatus, teamId]);
  }
  db.run(
    `INSERT INTO team_member (team_id, name, session_id, agent, status, execution_status, model, prompt, time_created, time_updated)
     VALUES (?, ?, ?, 'build', ?, 'running', ?, 'do the work', ?, ?)`,
    [teamId, memberName, sessionId, status, model, now, now],
  );
  const registry = new MemberRegistry();
  registry.register(teamId, memberName, sessionId);
  return { registry, sessionId, memberName, teamId };
}

const getMember = (db, teamId, name) =>
  db.query("SELECT model, status FROM team_member WHERE team_id = ? AND name = ?").get(teamId, name);
const leadMessages = (db, teamId) =>
  db.query("SELECT from_name, to_name, content FROM team_message WHERE team_id = ? AND from_name = 'system' AND to_name = 'lead'").all(teamId);

/* ------------------------------------------------------------------ *
 * 6. Cenário A — fallback disponível → troca SILENCIOSA (zero-noise)  *
 * ------------------------------------------------------------------ */
{
  const db = makeDb();
  const client = makeClient();
  const seed = seedMember(db, {});
  const cfg = { ...DEFAULT_CONFIG };

  // Persist retry signal first (parity with production ordering: the status
  // handler persists retry_* before the failover evaluation runs).
  hooks.handleSessionStatusEvent(db, seed.registry, seed.sessionId, "retry", {
    attempt: 1, message: "429 rate limited", next: Date.now() + 30_000,
  });

  const decision = handleRetryModelFailover(db, seed.registry, client, cfg, seed.sessionId, {
    attempt: 1, message: "429 rate limited", next: Date.now() + 30_000,
  });

  check(
    "A1: fallback disponível → action 'switched' com o default gemini-3.8-flash#low",
    decision?.action === "switched" && decision.toModel === "google/antigravity-gemini-3.8-flash#low",
    JSON.stringify(decision),
  );
  check(
    "A2: modelo persistido no SQLite real (UPDATE em team_member.model)",
    getMember(db, seed.teamId, seed.memberName).model === "google/antigravity-gemini-3.8-flash#low",
  );
  check(
    "A3: ZERO-NOISE — nenhum promptAsync (lead não acordado) e nenhum toast",
    client.calls.promptAsync.length === 0 && client.calls.showToast.length === 0,
    `promptAsync=${client.calls.promptAsync.length} showToast=${client.calls.showToast.length}`,
  );
  check(
    "A4: ZERO-NOISE — nenhuma team_message persistida",
    leadMessages(db, seed.teamId).length === 0,
  );
  check(
    "A5: cooldown registrado para a chave do membro",
    failoverCooldown.has(`${seed.teamId}:${seed.memberName}`),
  );
  db.close();
  failoverCooldown.clear();
}

/* ------------------------------------------------------------------ *
 * 7. Cenário B — retry repetido no mesmo burst → "suppressed"         *
 * ------------------------------------------------------------------ */
{
  const db = makeDb();
  const client = makeClient();
  const seed = seedMember(db, { memberName: "bia", sessionId: "sess-bia" });
  const cfg = { ...DEFAULT_CONFIG };

  const first = handleRetryModelFailover(db, seed.registry, client, cfg, seed.sessionId, { attempt: 1, message: "429", next: Date.now() });
  const second = handleRetryModelFailover(db, seed.registry, client, cfg, seed.sessionId, { attempt: 2, message: "429", next: Date.now() });
  const third = handleRetryModelFailover(db, seed.registry, client, cfg, seed.sessionId, { attempt: 3, message: "429", next: Date.now() });

  check(
    "B1: 1º retry → 'switched'; 2º e 3º (mesmo burst) → 'suppressed'",
    first?.action === "switched" && second?.action === "suppressed" && third?.action === "suppressed",
    `first=${first?.action} second=${second?.action} third=${third?.action}`,
  );
  check(
    "B2: modelo NÃO avança mais de uma entrada por burst (não queima a cadeia)",
    getMember(db, seed.teamId, seed.memberName).model === "google/antigravity-gemini-3.8-flash#low",
  );
  check(
    "B3: suppressed mantém zero-noise total",
    client.calls.promptAsync.length === 0 && leadMessages(db, seed.teamId).length === 0,
  );
  db.close();
  failoverCooldown.clear();
}

/* ------------------------------------------------------------------ *
 * 8. Cenário C — cadeia esgotada → EXATAMENTE 1 wake do lead          *
 * ------------------------------------------------------------------ */
{
  const db = makeDb();
  const client = makeClient();
  // Chain de 1 entrada; primário já É a última entrada → esgotado de saída.
  const seed = seedMember(db, {
    memberName: "cris", sessionId: "sess-cris",
    model: "google/antigravity-gemini-3.8-flash#low",
  });
  const cfg = { ...DEFAULT_CONFIG };

  const decision = handleRetryModelFailover(db, seed.registry, client, cfg, seed.sessionId, {
    attempt: 1, message: "429 exceeded quota", next: Date.now() + 60_000,
  });

  check(
    "C1: fallback também falhou (chain esgotada) → action 'exhausted'",
    decision?.action === "exhausted" && decision.toModel === undefined,
    JSON.stringify(decision),
  );
  check(
    "C2: EXATAMENTE 1 wake do lead (promptAsync synthetic na sessão do lead)",
    client.calls.promptAsync.length === 1
      && client.calls.promptAsync[0].sessionID === LEAD_SESSION
      && client.calls.promptAsync[0].synthetic === true,
    `wakes=${client.calls.promptAsync.length}`,
  );
  check(
    "C3: EXATAMENTE 1 team_message persistida system→lead (única exceção de ruído)",
    leadMessages(db, seed.teamId).length === 1,
  );
  check(
    "C4: mensagem cita o modelo primário esgotado e a chain",
    String(leadMessages(db, seed.teamId)[0]?.content).includes("fallback chain is exhausted"),
  );
  check(
    "C5: modelo NÃO foi alterado (sem alternativa disponível)",
    getMember(db, seed.teamId, seed.memberName).model === "google/antigravity-gemini-3.8-flash#low",
  );

  // Retry repetido no mesmo burst NÃO spama o lead (cooldown após a ação).
  const again = handleRetryModelFailover(db, seed.registry, client, cfg, seed.sessionId, { attempt: 2, message: "429", next: Date.now() });
  check(
    "C6: retry seguinte no burst → 'suppressed', lead NÃO é acordado de novo",
    again?.action === "suppressed" && client.calls.promptAsync.length === 1 && leadMessages(db, seed.teamId).length === 1,
  );
  db.close();
  failoverCooldown.clear();
}

/* ------------------------------------------------------------------ *
 * 9. Cenário D — cadeia multipla caminha para frente após cooldown    *
 * ------------------------------------------------------------------ */
{
  const db = makeDb();
  const client = makeClient();
  const seed = seedMember(db, {
    teamId: "team-fail-2", memberName: "dani", sessionId: "sess-dani",
    model: "prov/primary",
  });
  const cfg = { ...DEFAULT_CONFIG, fallbackModels: ["prov/fb1#low", "prov/fb2"] };

  const first = handleRetryModelFailover(db, seed.registry, client, cfg, seed.sessionId, { attempt: 1, message: "429", next: Date.now() });
  // Simula término do cooldown (determinístico — sem sleep).
  failoverCooldown.set(`${seed.teamId}:${seed.memberName}`, Date.now() - FAILOVER_COOLDOWN_MS - 1_000);
  const second = handleRetryModelFailover(db, seed.registry, client, cfg, seed.sessionId, { attempt: 1, message: "429", next: Date.now() });
  failoverCooldown.set(`${seed.teamId}:${seed.memberName}`, Date.now() - FAILOVER_COOLDOWN_MS - 1_000);
  const third = handleRetryModelFailover(db, seed.registry, client, cfg, seed.sessionId, { attempt: 1, message: "429", next: Date.now() });

  check(
    "D1: primary → fb1#low → fb2 → esgotado (caminhamento progressivo)",
    first?.action === "switched" && first.toModel === "prov/fb1#low"
      && second?.action === "switched" && second.toModel === "prov/fb2"
      && third?.action === "exhausted",
    `first=${first?.toModel} second=${second?.toModel} third=${third?.action}`,
  );
  check(
    "D2: apenas o esgotamento acorda o lead (1 wake, 1 mensagem)",
    client.calls.promptAsync.length === 1 && leadMessages(db, seed.teamId).length === 1,
    `wakes=${client.calls.promptAsync.length} msgs=${leadMessages(db, seed.teamId).length}`,
  );
  db.close();
  failoverCooldown.clear();
}

/* ------------------------------------------------------------------ *
 * 10. Cenário E — guardas: não-membro, arquivado, shutdown            *
 * ------------------------------------------------------------------ */
{
  const db = makeDb();
  const client = makeClient();
  const cfg = { ...DEFAULT_CONFIG };

  check(
    "E1: sessão não registrada → undefined, zero ação",
    handleRetryModelFailover(db, new MemberRegistry(), client, cfg, "ghost-session") === undefined
      && client.calls.promptAsync.length === 0,
  );

  const archived = seedMember(db, { teamId: "team-arch", memberName: "eva", sessionId: "sess-eva", teamStatus: "archived" });
  check(
    "E2: time arquivado → undefined, zero ação",
    handleRetryModelFailover(db, archived.registry, client, cfg, archived.sessionId) === undefined
      && getMember(db, "team-arch", "eva").model === "google/antigravity-gemini-3.8-flash",
  );

  const shutting = seedMember(db, { teamId: "team-shut", memberName: "fab", sessionId: "sess-fab", status: "shutdown_requested" });
  check(
    "E3: membro em shutdown_requested → undefined (não vale a pena fallover)",
    handleRetryModelFailover(db, shutting.registry, client, cfg, shutting.sessionId) === undefined
      && getMember(db, "team-shut", "fab").model === "google/antigravity-gemini-3.8-flash",
  );
  db.close();
  failoverCooldown.clear();
}

/* ------------------------------------------------------------------ *
 * 11. Cenário F — integração dispatchV2Event (caminho V2 de produção) *
 * ------------------------------------------------------------------ */
{
  const db = makeDb();
  const client = makeClient();
  const seed = seedMember(db, { memberName: "gil", sessionId: "sess-gil" });
  const tracker = new DescendantTracker();
  const cfg = { ...DEFAULT_CONFIG };
  const ctx = { client, config: cfg };
  const nextAt = Date.now() + 45_000;

  // F1: session.retry.scheduled → persiste retry_* E troca o modelo.
  const t1 = v2Events.dispatchV2Event(db, seed.registry, tracker, {
    type: "session.retry.scheduled",
    data: { sessionID: seed.sessionId, attempt: 2, at: nextAt, error: { message: "429 slow down" } },
  }, ctx);
  const m1 = db.query("SELECT retry_until, retry_attempt, retry_message, model FROM team_member WHERE team_id = ? AND name = ?")
    .get(seed.teamId, seed.memberName);
  check(
    "F1: session.retry.scheduled → transition retry + retry_* persistidos + modelo trocado",
    t1?.to === "retry" && m1.retry_until === nextAt && m1.retry_attempt === 2
      && m1.retry_message === "429 slow down" && m1.model === "google/antigravity-gemini-3.8-flash#low",
    JSON.stringify(m1),
  );

  // F2: session.status {type:"retry"} → payload NÃO é mais dropped (bug fix)
  // e o failover roda também por este caminho.
  const db2 = makeDb();
  const seed2 = seedMember(db2, { teamId: "team-fail-3", memberName: "hugo", sessionId: "sess-hugo" });
  const next2 = Date.now() + 60_000;
  v2Events.dispatchV2Event(db2, seed2.registry, new DescendantTracker(), {
    type: "session.status",
    data: { sessionID: seed2.sessionId, status: { type: "retry", attempt: 3, message: "quota", next: next2 } },
  }, ctx);
  const m2 = db2.query("SELECT retry_until, retry_attempt, retry_message, model FROM team_member WHERE team_id = ? AND name = ?")
    .get(seed2.teamId, seed2.memberName);
  check(
    "F2: session.status retry → payload persistido (attempt/next/message) + switch silencioso",
    m2.retry_until === next2 && m2.retry_attempt === 3 && m2.retry_message === "quota"
      && m2.model === "google/antigravity-gemini-3.8-flash#low",
    JSON.stringify(m2),
  );

  // F3: sem failoverCtx → comportamento legado persist-only, sem troca.
  const db3 = makeDb();
  const seed3 = seedMember(db3, { teamId: "team-fail-4", memberName: "ida", sessionId: "sess-ida" });
  v2Events.dispatchV2Event(db3, seed3.registry, new DescendantTracker(), {
    type: "session.retry.scheduled",
    data: { sessionID: seed3.sessionId, attempt: 1, at: Date.now() + 10_000 },
  });
  const m3 = db3.query("SELECT retry_attempt, model FROM team_member WHERE team_id = ? AND name = ?")
    .get(seed3.teamId, seed3.memberName);
  check(
    "F3: dispatch sem ctx → persist-only (retry_attempt gravado, modelo intacto)",
    m3.retry_attempt === 1 && m3.model === "google/antigravity-gemini-3.8-flash",
    JSON.stringify(m3),
  );

  // F4: zero-noise fim a fim pelo dispatch — nenhum wake do lead no switch.
  check(
    "F4: dispatch switched → zero promptAsync do lead (zero-noise fim a fim)",
    client.calls.promptAsync.length === 0,
    `wakes=${client.calls.promptAsync.length}`,
  );

  db.close(); db2.close(); db3.close();
  failoverCooldown.clear();
}

/* ------------------------------------------------------------------ *
 * 12. Paridade dist × src (bundle real submetido às mesmas leis)      *
 * ------------------------------------------------------------------ */
{
  const db = makeDb();
  const client = makeClient();
  const now = Date.now();
  db.run(
    `INSERT INTO team (id, name, lead_session_id, status, delegate, time_created, time_updated)
     VALUES ('team-dist', 'dist-team', ?, 'active', 0, ?, ?)`,
    [LEAD_SESSION, now, now],
  );
  db.run(
    `INSERT INTO team_member (team_id, name, session_id, agent, status, execution_status, model, prompt, time_created, time_updated)
     VALUES ('team-dist', 'zoe', 'sess-zoe', 'build', 'busy', 'running', 'google/antigravity-gemini-3.8-flash', 'x', ?, ?)`,
    [now, now],
  );
  const registry = new distMod.MemberRegistry();
  registry.register("team-dist", "zoe", "sess-zoe");

  const decision = distMod.handleRetryModelFailover(db, registry, client, { ...distMod.DEFAULT_CONFIG }, "sess-zoe", { attempt: 1, message: "429", next: now });
  const stored = db.query("SELECT model FROM team_member WHERE team_id = 'team-dist' AND name = 'zoe'").get();
  check(
    "dist: switched silencioso idêntico ao src (default gemini-3.8-flash#low, zero wake)",
    decision?.action === "switched" && decision.toModel === "google/antigravity-gemini-3.8-flash#low"
      && stored.model === "google/antigravity-gemini-3.8-flash#low"
      && client.calls.promptAsync.length === 0,
    JSON.stringify({ decision, stored }),
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
