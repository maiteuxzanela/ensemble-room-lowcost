#!/usr/bin/env node
/**
 * QUALITY GATE DETERMINÍSTICO — TICKET-HARNESS-57
 * Refinamento do cooldown de failover (bypass model-aware) + amarração do
 * AbortController no prompt inicial do team-spawn.
 *
 * Sob teste (código REAL, sem mocks):
 *   - src/hooks.ts            → evaluateFailoverCooldown / recordFailoverAction
 *                               (gate model-aware do debounce) e o caminho
 *                               integrado handleRetryModelFailover.
 *   - src/tools/team-spawn.ts → trackPrompt/endTracked + signal no promptAsync
 *                               de nascimento do membro e o ramo de abort
 *                               intencional que NÃO faz rollback destrutivo.
 *   - src/v2-session.ts       → registry real de AbortControllers em voo.
 *   - dist/index.js           → paridade src↔dist do bundle compilado.
 *
 * Contratos provados (TICKET-HARNESS-57):
 *   1. `evaluateFailoverCooldown` SUPRIME o eco residual do modelo abortado
 *      (`currentModel === null` ou `=== record.fromModel`) dentro de
 *      FAILOVER_BURST_DEBOUNCE_MS (ex.: 500ms).
 *   2. O MESMO gate CONCEDE bypass imediato (`proceed`) quando o erro já vem
 *      de um modelo DIFERENTE (`currentModel === record.toModel` ou outro
 *      não-nulo) mesmo em 500ms, caminhando de `currentModel` (fallback
 *      `record.toModel`) — sem sleep nativo de horas.
 *   3. Integração de failover rápido consecutivo: A -> B em 500ms -> C sem
 *      supressão (membro e sessão isolada), com um abort/prompt por salto.
 *   4. Após o spawn com prompt inicial, `abortInflight(childSessionId)`
 *      retorna true e cancela a requisição em voo; o abort intencional NÃO
 *      executa o rollback destrutivo (membro/registry sobrevivem). Um erro
 *      de transporte genuíno AINDA faz rollback (controle de sensibilidade).
 *   5. Prova de mutação: as três âncoras novas (debounce cego, walkFrom sem
 *      leitura defasada, ramo de abort do spawn) são detectadas.
 *
 * Sem mocks: SQLite real (node:sqlite via src/db.ts), registry real,
 * transport recorder (seam legítimo de I/O já homologado no repo) e relógio
 * controlado apenas por REWIND do timestamp exportado (sem sleep de espera).
 *
 * Uso:  node tests/test_ticket_harness_57_failover_refinement.mjs
 * Exit: 0 = todos os checks PASS; 1 = há FAIL.
 */

import { cpSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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

const unhandled = [];
process.on("unhandledRejection", (e) => unhandled.push(e));

/* ------------------------------------------------------------------ *
 * 1. Harness do dist: bundle real + apenas cláusulas de export       *
 * ------------------------------------------------------------------ */
const DIST_EXPORTS = [
  "createDb", "MemberRegistry", "DEFAULT_CONFIG", "ProgressTracker",
  "handleRetryModelFailover", "evaluateFailoverCooldown",
  "failoverCooldown", "failoverActions",
  "FAILOVER_COOLDOWN_MS", "FAILOVER_BURST_DEBOUNCE_MS",
  "executeTeamSpawn", "trackPrompt", "abortInflight", "endTracked",
];

const distRaw = readFileSync(DIST, "utf8");
const buildHarness = (raw) => {
  const existing = raw.match(/export\s*\{([^}]*)\}\s*;?\s*$/)?.[1] ?? "";
  const already = new Set(existing.split(",").map((s) => s.trim().split(/\s+as\s+/).pop()).filter(Boolean));
  const need = DIST_EXPORTS.filter((s) => !already.has(s));
  return raw + (need.length ? `\nexport { ${need.join(", ")} };\n` : "");
};
const HARNESS = path.join(TMP, "_h57_failover_harness.mjs");
writeFileSync(HARNESS, buildHarness(distRaw));
check(
  "harness do dist é o bundle real + apenas cláusulas de export anexadas",
  readFileSync(HARNESS, "utf8") === buildHarness(distRaw),
  `${distRaw.length} bytes de bundle`,
);
check(
  "dist contém as âncoras novas do H57 (debounce model-aware + trackPrompt no spawn)",
  /const echoOfAborted = currentModel === null \|\| currentModel === record\.fromModel/.test(distRaw)
    && /if \(echoOfAborted && elapsed < FAILOVER_BURST_DEBOUNCE_MS\) \{/.test(distRaw)
    && /const walkFrom = echoOfAborted \? record\.toModel : currentModel/.test(distRaw)
    && /const controller = trackPrompt\(childSessionId\)/.test(distRaw)
    && /if \(controller\.signal\.aborted\) \{/.test(distRaw),
);

/* ------------------------------------------------------------------ *
 * 2. Harness do src: cópia fora de node_modules + extensão .ts       *
 * ------------------------------------------------------------------ */
const SRC_COPY = path.join(TMP, "ensemble_src_h57");
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
const v2src = await import(`${SRC_COPY}/v2-session.ts`);
const spawnSrc = await import(`${SRC_COPY}/tools/team-spawn.ts`);
const progressMod = await import(`${SRC_COPY}/progress.ts`);
const distMod = await import(HARNESS);

const srcMod = {
  ...hooks,
  createDb: dbMod.createDb,
  MemberRegistry: stateMod.MemberRegistry,
  ProgressTracker: progressMod.ProgressTracker,
  DEFAULT_CONFIG: configMod.DEFAULT_CONFIG,
  executeTeamSpawn: spawnSrc.executeTeamSpawn,
  trackPrompt: v2src.trackPrompt,
  abortInflight: v2src.abortInflight,
  endTracked: v2src.endTracked,
};

check(
  "módulos reais carregados (hooks/tools/v2-session/db/state + dist)",
  typeof srcMod.evaluateFailoverCooldown === "function"
    && typeof srcMod.handleRetryModelFailover === "function"
    && typeof srcMod.executeTeamSpawn === "function"
    && typeof distMod.executeTeamSpawn === "function"
    && typeof distMod.evaluateFailoverCooldown === "function",
);

/* ------------------------------------------------------------------ *
 * 3. Fixtures reais: SQLite + registry + transport recorder          *
 * ------------------------------------------------------------------ */
let dbSeq = 0;
function makeDb(mod, tag = "x") {
  const file = path.join(TMP, `h57_${tag}_${process.pid}_${dbSeq++}.sqlite`);
  rmSync(file, { force: true });
  rmSync(`${file}-wal`, { force: true });
  rmSync(`${file}-shm`, { force: true });
  return mod.createDb(file);
}

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

const LEAD_SESSION = "ses-h57-lead";

function seedMember(db, { teamId, memberName, sessionId, agent = "build", model = "prov/primary", teamStatus = "active" } = {}) {
  const now = Date.now();
  db.run(
    `INSERT OR IGNORE INTO team (id, name, lead_session_id, status, delegate, time_created, time_updated)
     VALUES (?, ?, ?, ?, 0, ?, ?)`,
    [teamId, `name-${teamId}`, LEAD_SESSION, teamStatus, now, now],
  );
  db.run(
    `INSERT INTO team_member (team_id, name, session_id, agent, status, execution_status, model, prompt, time_created, time_updated)
     VALUES (?, ?, ?, ?, 'busy', 'running', ?, 'do the work', ?, ?)`,
    [teamId, memberName, sessionId, agent, model, now, now],
  );
  const registry = new stateMod.MemberRegistry();
  registry.register(teamId, memberName, sessionId);
  return { registry, sessionId, memberName, teamId };
}

const getMemberModel = (db, teamId, name) =>
  db.query("SELECT model FROM team_member WHERE team_id = ? AND name = ?").get(teamId, name)?.model;

/** Rewind DETERMINÍSTICO (sem sleep): congela o evento a ~500ms do anterior. */
function rewind500(mod, key) {
  mod.failoverCooldown.set(key, Date.now() - 500);
}

/* ------------------------------------------------------------------ *
 * 4. Probes unitários de evaluateFailoverCooldown                    *
 * ------------------------------------------------------------------ */
const UNIT_BASE = 1_000_000;
function probeUnit(mod) {
  const out = new Map();
  const run = (key, record, currentModel, elapsed, opts = {}) => {
    mod.failoverCooldown.clear();
    mod.failoverActions.clear();
    const at = opts.at ?? UNIT_BASE;
    if (!opts.noEntry) mod.failoverCooldown.set(key, at);
    if (record) mod.failoverActions.set(key, { at, ...record });
    return mod.evaluateFailoverCooldown(key, currentModel, at + elapsed);
  };
  const SWITCH = { fromModel: "prov/A", toModel: "prov/B", exhausted: false };
  const EXHAUSTED = { fromModel: "prov/A", toModel: null, exhausted: true };

  out.set("unit.no-entry-proceeds-from-current",
    eq(run("k0", null, "prov/X", 10, { noEntry: true }), { verdict: "proceed", walkFrom: "prov/X" }));

  out.set("unit.legacy-meta-suppressed-within-cooldown", (() => {
    const v = run("k1", null, "prov/X", 1_000);
    return v.verdict === "suppressed" && v.remainingMs === mod.FAILOVER_COOLDOWN_MS - 1_000;
  })());

  out.set("unit.legacy-meta-proceeds-after-cooldown",
    eq(run("k2", null, "prov/X", mod.FAILOVER_COOLDOWN_MS), { verdict: "proceed", walkFrom: "prov/X" }));

  out.set("unit.exhausted-suppressed-within-cooldown", (() => {
    const v = run("k3", EXHAUSTED, "prov/B", 500);
    return v.verdict === "suppressed" && v.remainingMs === mod.FAILOVER_COOLDOWN_MS - 500;
  })());

  out.set("unit.exhausted-proceeds-after-cooldown",
    eq(run("k4", EXHAUSTED, "prov/B", mod.FAILOVER_COOLDOWN_MS), { verdict: "proceed", walkFrom: "prov/B" }));

  out.set("unit.echo-null-under-debounce-suppressed", (() => {
    const v = run("k5", SWITCH, null, 500);
    return v.verdict === "suppressed" && v.remainingMs === mod.FAILOVER_BURST_DEBOUNCE_MS - 500;
  })());

  out.set("unit.echo-frommodel-under-debounce-suppressed",
    run("k6", SWITCH, "prov/A", 500).verdict === "suppressed");

  out.set("unit.tomodel-under-debounce-bypasses",
    eq(run("k7", SWITCH, "prov/B", 500), { verdict: "proceed", walkFrom: "prov/B" }));

  out.set("unit.other-model-under-debounce-bypasses",
    eq(run("k8", SWITCH, "prov/X", 500), { verdict: "proceed", walkFrom: "prov/X" }));

  out.set("unit.tomodel-near-boundary-bypasses",
    eq(run("k9", SWITCH, "prov/B", mod.FAILOVER_BURST_DEBOUNCE_MS - 1), { verdict: "proceed", walkFrom: "prov/B" }));

  out.set("unit.echo-at-boundary-proceeds-walks-from-target",
    eq(run("k10", SWITCH, null, mod.FAILOVER_BURST_DEBOUNCE_MS), { verdict: "proceed", walkFrom: "prov/B" }));

  out.set("unit.echo-past-debounce-walks-from-target",
    eq(run("k11", SWITCH, "prov/A", mod.FAILOVER_BURST_DEBOUNCE_MS + 500), { verdict: "proceed", walkFrom: "prov/B" }));

  out.set("unit.tomodel-past-debounce-walks-from-itself",
    eq(run("k12", SWITCH, "prov/B", mod.FAILOVER_BURST_DEBOUNCE_MS + 500), { verdict: "proceed", walkFrom: "prov/B" }));

  mod.failoverCooldown.clear();
  mod.failoverActions.clear();
  return out;
}

/* ------------------------------------------------------------------ *
 * 5. Integração — membro: A -> B em 500ms -> C sem supressão         *
 * ------------------------------------------------------------------ */
const MEMBER_CHAIN = ["prov/fb1#low", "prov/fb2#low", "prov/fb3#low"];
const MEMBER_CFG = () => ({ ...configMod.DEFAULT_CONFIG, fallbackModels: MEMBER_CHAIN, fallbackModelsByAgent: {} });
const README_RETRY = { attempt: 1, message: "429 rate limit exceeded", next: Date.now() + 4 * 60 * 60 * 1000 };

async function scenarioMemberFast(mod, tag) {
  const out = new Map();
  const db = makeDb(mod, `member_${tag}`);
  const client = makeClient();
  mod.failoverCooldown.clear();
  mod.failoverActions.clear();
  const seed = seedMember(db, {
    teamId: `team-h57-m-${tag}`,
    memberName: "bruno",
    sessionId: `sess-h57-m-${tag}`,
    model: "prov/primary",
  });
  const key = `${seed.teamId}:${seed.memberName}`;
  const cfg = MEMBER_CFG();

  const r1 = await mod.handleRetryModelFailover(db, seed.registry, client, cfg, seed.sessionId, { ...README_RETRY });
  out.set("member.step1-switch-A", r1?.action === "switched" && r1.toModel === "prov/fb1#low");

  rewind500(mod, key);
  const r2 = await mod.handleRetryModelFailover(db, seed.registry, client, cfg, seed.sessionId, { ...README_RETRY });
  out.set("member.fast-500ms-switch-B",
    r2?.action === "switched" && r2.fromModel === "prov/fb1#low" && r2.toModel === "prov/fb2#low");
  out.set("member.fast-500ms-not-suppressed", r2?.action !== "suppressed");

  rewind500(mod, key);
  const r3 = await mod.handleRetryModelFailover(db, seed.registry, client, cfg, seed.sessionId, { ...README_RETRY });
  out.set("member.fast-consecutive-switch-C",
    r3?.action === "switched" && r3.fromModel === "prov/fb2#low" && r3.toModel === "prov/fb3#low");
  out.set("member.fast-consecutive-not-suppressed", r3?.action !== "suppressed");
  out.set("member.chain-burned-A-B-C",
    eq(client.calls.promptAsync.map((c) => c.model?.modelID), ["fb1", "fb2", "fb3"])
    && mod.failoverActions.get(key)?.toModel === "prov/fb3#low");
  out.set("member.abort-per-switch", client.calls.abort.length === 3 && client.calls.promptAsync.length === 3);

  // Eco residual REAL: leitura defasada do banco (ainda no fromModel do último
  // salto) dentro de 500ms → suprimido, sem queimar um 4º degrau.
  db.run("UPDATE team_member SET model = ? WHERE team_id = ? AND name = ?", ["prov/fb2#low", seed.teamId, seed.memberName]);
  rewind500(mod, key);
  const rStale = await mod.handleRetryModelFailover(db, seed.registry, client, cfg, seed.sessionId, { ...README_RETRY });
  out.set("member.residual-echo-stale-read-suppressed", rStale?.action === "suppressed");
  out.set("member.residual-echo-no-extra-transport",
    client.calls.abort.length === 3 && client.calls.promptAsync.length === 3);

  db.close();
  mod.failoverCooldown.clear();
  mod.failoverActions.clear();
  return out;
}

/* ------------------------------------------------------------------ *
 * 6. Integração — sessão isolada: A -> B em 500ms -> C sem supressão *
 * ------------------------------------------------------------------ */
const ISO_CHAIN = ["prov/iso-a", "prov/iso-b", "prov/iso-c"];
const ISO_CFG = () => ({
  ...configMod.DEFAULT_CONFIG,
  fallbackModels: ["prov/global-x"],
  fallbackModelsByAgent: { diana: ISO_CHAIN },
});

async function scenarioIsolatedFast(mod, tag) {
  const out = new Map();
  const db = makeDb(mod, `iso_${tag}`);
  mod.failoverCooldown.clear();
  mod.failoverActions.clear();
  const sessionId = `sess-h57-iso-${tag}`;
  let bound = { providerID: "prov", id: "fb-initial" };
  const client = makeClient(() => ({ data: { agent: "diana", model: bound } }));
  const cfg = ISO_CFG();
  const reg = () => new stateMod.MemberRegistry();

  const r1 = await mod.handleRetryModelFailover(db, reg(), client, cfg, sessionId, { ...README_RETRY });
  out.set("iso.step1-switch-A", r1?.action === "switched" && r1.toModel === "prov/iso-a");

  bound = { providerID: "prov", id: "iso-a" };
  rewind500(mod, `isolated:${sessionId}`);
  const r2 = await mod.handleRetryModelFailover(db, reg(), client, cfg, sessionId, { ...README_RETRY });
  out.set("iso.fast-500ms-switch-B",
    r2?.action === "switched" && r2.fromModel === "prov/iso-a" && r2.toModel === "prov/iso-b");
  out.set("iso.fast-500ms-not-suppressed", r2?.action !== "suppressed");

  bound = { providerID: "prov", id: "iso-b" };
  rewind500(mod, `isolated:${sessionId}`);
  const r3 = await mod.handleRetryModelFailover(db, reg(), client, cfg, sessionId, { ...README_RETRY });
  out.set("iso.fast-consecutive-switch-C",
    r3?.action === "switched" && r3.fromModel === "prov/iso-b" && r3.toModel === "prov/iso-c");
  out.set("iso.fast-consecutive-not-suppressed", r3?.action !== "suppressed");
  out.set("iso.chain-burned-A-B-C",
    eq(client.calls.promptAsync.map((c) => c.model?.modelID), ["iso-a", "iso-b", "iso-c"]));

  // Eco residual: o servidor volta a reportar o fromModel do último salto.
  bound = { providerID: "prov", id: "iso-b" };
  rewind500(mod, `isolated:${sessionId}`);
  const rStale = await mod.handleRetryModelFailover(db, reg(), client, cfg, sessionId, { ...README_RETRY });
  out.set("iso.residual-echo-stale-read-suppressed", rStale?.action === "suppressed");

  db.close();
  mod.failoverCooldown.clear();
  mod.failoverActions.clear();
  return out;
}

/* ------------------------------------------------------------------ *
 * 7. team-spawn: AbortController do prompt inicial + não-rollback     *
 * ------------------------------------------------------------------ */
const CHILD_ID = "ses-h57-child";

function makeSpawnClient(mode) {
  const calls = { promptAsync: [], abort: [], create: [], toast: [] };
  const client = {
    session: {
      create: async (options) => { calls.create.push(options); return { data: { id: CHILD_ID } }; },
      promptAsync: (options) => {
        calls.promptAsync.push(options);
        if (mode === "abortable") {
          // HTTP REAL pendurado: só rejeita quando o AbortSignal dispara.
          return new Promise((_, reject) => {
            if (options.signal?.aborted) {
              reject(new DOMException("The operation was aborted.", "AbortError"));
              return;
            }
            options.signal?.addEventListener("abort", () =>
              reject(new DOMException("The operation was aborted.", "AbortError")));
          });
        }
        return Promise.reject(new Error("transport down: connection reset"));
      },
      abort: async (options) => { calls.abort.push(options); return {}; },
    },
    tui: { showToast: async (options) => { calls.toast.push(options); return {}; } },
  };
  return { client, calls };
}

function seedTeamRow(mod, db, teamId) {
  const now = Date.now();
  db.run(
    `INSERT OR IGNORE INTO team (id, name, lead_session_id, status, delegate, time_created, time_updated)
     VALUES (?, ?, ?, 'active', 0, ?, ?)`,
    [teamId, `name-${teamId}`, LEAD_SESSION, now, now],
  );
}

const tick = (ms = 10) => new Promise((r) => setTimeout(r, ms));

async function scenarioSpawnAbort(mod, tag) {
  const out = new Map();
  const db = makeDb(mod, `spawn_${tag}`);
  const teamId = `team-h57-spawn-${tag}`;
  seedTeamRow(mod, db, teamId);
  const { client, calls } = makeSpawnClient("abortable");
  const registry = new mod.MemberRegistry();
  const deps = {
    db, registry, client, config: mod.DEFAULT_CONFIG, directory: REPO,
    progressTracker: new mod.ProgressTracker(),
  };

  const res = await mod.executeTeamSpawn(deps, {
    name: "bruno", agent: "build", prompt: "execute the deterministic work", worktree: false,
  }, LEAD_SESSION);
  out.set("spawn.returns-success-string", typeof res === "string" && res.includes('Teammate "bruno" spawned'));

  const rowAfterSpawn = db.query("SELECT session_id, model FROM team_member WHERE team_id = ? AND name = ?").get(teamId, "bruno");
  out.set("spawn.member-row-created", rowAfterSpawn?.session_id === CHILD_ID);
  out.set("spawn.prompt-fired-with-signal",
    calls.promptAsync.length === 1
    && calls.promptAsync[0].signal instanceof AbortSignal
    && calls.promptAsync[0].signal.aborted === false
    && calls.promptAsync[0].sessionID === CHILD_ID);
  out.set("spawn.registry-registered", registry.getBySession(CHILD_ID)?.memberName === "bruno");

  const cancelled = mod.abortInflight(CHILD_ID);
  await tick();
  out.set("spawn.abortInflight-returns-true", cancelled === true);
  out.set("spawn.signal-aborted", calls.promptAsync[0].signal.aborted === true);
  out.set("spawn.abort-keeps-member",
    db.query("SELECT session_id FROM team_member WHERE team_id = ? AND name = ?").get(teamId, "bruno")?.session_id === CHILD_ID);
  out.set("spawn.abort-keeps-registry", registry.getBySession(CHILD_ID)?.memberName === "bruno");
  out.set("spawn.abort-no-destructive-side-effects",
    calls.toast.length === 0
    && calls.abort.length === 0
    && db.query("SELECT COUNT(*) AS c FROM team_task WHERE team_id = ?").get(teamId).c === 0);
  out.set("spawn.abort-endTracked-cleans-entry", mod.abortInflight(CHILD_ID) === false);

  db.close();
  return out;
}

async function scenarioSpawnTransportError(mod, tag) {
  const out = new Map();
  const db = makeDb(mod, `spawnerr_${tag}`);
  const teamId = `team-h57-spawnerr-${tag}`;
  seedTeamRow(mod, db, teamId);
  const { client, calls } = makeSpawnClient("reject");
  const registry = new mod.MemberRegistry();
  const deps = {
    db, registry, client, config: mod.DEFAULT_CONFIG, directory: REPO,
    progressTracker: new mod.ProgressTracker(),
  };

  const res = await mod.executeTeamSpawn(deps, {
    name: "carla", agent: "build", prompt: "will fail", worktree: false,
  }, LEAD_SESSION);
  out.set("spawn.transport-error-still-spawns-session", typeof res === "string");
  await tick(20);
  out.set("spawn.transport-error-rolls-back-member",
    db.query("SELECT session_id FROM team_member WHERE team_id = ? AND name = ?").get(teamId, "carla") === undefined);
  out.set("spawn.transport-error-unregisters", registry.getBySession(CHILD_ID) === undefined);
  out.set("spawn.transport-error-toasts", calls.toast.some((t) => t.variant === "error"));

  db.close();
  return out;
}

/* ------------------------------------------------------------------ *
 * 8. Execução src (principal) + dist (paridade)                      *
 * ------------------------------------------------------------------ */
const SRC_UNIT = probeUnit(srcMod);
for (const [name, ok] of SRC_UNIT) check(`2.x [src/unit] ${name}`, ok);
const SRC_MEMBER = await scenarioMemberFast(srcMod, "src");
for (const [name, ok] of SRC_MEMBER) check(`2.x [src/member] ${name}`, ok);
const SRC_ISO = await scenarioIsolatedFast(srcMod, "src");
for (const [name, ok] of SRC_ISO) check(`2.x [src/iso] ${name}`, ok);
const SRC_SPAWN = await scenarioSpawnAbort(srcMod, "src");
for (const [name, ok] of SRC_SPAWN) check(`2.x [src/spawn] ${name}`, ok);
const SRC_SPAWN_ERR = await scenarioSpawnTransportError(srcMod, "src");
for (const [name, ok] of SRC_SPAWN_ERR) check(`2.x [src/spawn-err] ${name}`, ok);

const DIST_UNIT = probeUnit(distMod);
for (const [name, ok] of DIST_UNIT) check(`3.x [dist/unit] ${name}`, ok);
const DIST_MEMBER = await scenarioMemberFast(distMod, "dist");
for (const [name, ok] of DIST_MEMBER) check(`3.x [dist/member] ${name}`, ok);
const DIST_ISO = await scenarioIsolatedFast(distMod, "dist");
for (const [name, ok] of DIST_ISO) check(`3.x [dist/iso] ${name}`, ok);
const DIST_SPAWN = await scenarioSpawnAbort(distMod, "dist");
for (const [name, ok] of DIST_SPAWN) check(`3.x [dist/spawn] ${name}`, ok);
const DIST_SPAWN_ERR = await scenarioSpawnTransportError(distMod, "dist");
for (const [name, ok] of DIST_SPAWN_ERR) check(`3.x [dist/spawn-err] ${name}`, ok);

{
  const pairs = [
    ["unit", SRC_UNIT, DIST_UNIT],
    ["member", SRC_MEMBER, DIST_MEMBER],
    ["iso", SRC_ISO, DIST_ISO],
    ["spawn", SRC_SPAWN, DIST_SPAWN],
    ["spawn-err", SRC_SPAWN_ERR, DIST_SPAWN_ERR],
  ];
  const divergences = [];
  for (const [label, a, b] of pairs) {
    for (const [name, value] of a) {
      if (b.get(name) !== value) divergences.push(`${label}.${name}`);
    }
  }
  check("4.1: nenhuma divergência de comportamento src↔dist", divergences.length === 0, divergences.join(",") || `${pairs.reduce((n, [, a]) => n + a.size, 0)} observações`);
}

/* ------------------------------------------------------------------ *
 * 9. PROVA DE MUTAÇÃO — âncoras novas do H57                         *
 * ------------------------------------------------------------------ */
const MUTATIONS = [
  {
    id: "M1",
    desc: "debounce volta a ser CEGO (ignora o modelo atual) — bypass do novo modelo desaparece",
    from: "if (echoOfAborted && elapsed < FAILOVER_BURST_DEBOUNCE_MS) {",
    to: "if (elapsed < FAILOVER_BURST_DEBOUNCE_MS) {",
    run: (mod) => probeUnit(mod),
    detect: ["unit.tomodel-under-debounce-bypasses", "unit.other-model-under-debounce-bypasses"],
    unaffected: ["unit.echo-null-under-debounce-suppressed", "unit.echo-frommodel-under-debounce-suppressed"],
  },
  {
    id: "M2",
    desc: "walkFrom ignora a leitura defasada (repite o degrau / reinicia a cadeia)",
    from: "const walkFrom = echoOfAborted ? record.toModel : currentModel",
    to: "const walkFrom = currentModel",
    run: (mod) => probeUnit(mod),
    detect: ["unit.echo-at-boundary-proceeds-walks-from-target", "unit.echo-past-debounce-walks-from-target"],
    unaffected: ["unit.tomodel-under-debounce-bypasses", "unit.other-model-under-debounce-bypasses"],
  },
  {
    id: "M3",
    desc: "abort intencional tratado como falha de transporte — rollback destrutivo do membro",
    from: "      endTracked(childSessionId, controller);\n      if (controller.signal.aborted) {",
    to: "      endTracked(childSessionId, controller);\n      if (false) {",
    run: (mod) => scenarioSpawnAbort(mod, "mutM3"),
    detect: ["spawn.abort-keeps-member", "spawn.abort-keeps-registry"],
    unaffected: ["spawn.returns-success-string", "spawn.prompt-fired-with-signal"],
  },
];

const countOf = (haystack, needle) => haystack.split(needle).length - 1;
let mutationFailures = 0;
for (const m of MUTATIONS) {
  const occ = countOf(distRaw, m.from);
  check(`${m.id}: patch aplicável (1 ocorrência exata no dist)`, occ === 1, `ocorrências=${occ} | ${m.desc}`);
  if (occ !== 1) { mutationFailures++; continue; }

  const mutatedRaw = distRaw.split(m.from).join(m.to);
  check(`${m.id}: bundle mutado difere do original`, mutatedRaw !== distRaw);
  const file = path.join(TMP, `_h57_mut_${m.id.toLowerCase()}.mjs`);
  writeFileSync(file, buildHarness(mutatedRaw));

  let mutated;
  try {
    mutated = await import(file);
    check(`${m.id}: mutante importável`, true);
  } catch (err) {
    check(`${m.id}: mutante importável`, false, err?.stack ?? String(err));
    mutationFailures++;
    continue;
  }

  let agg;
  try {
    agg = await m.run(mutated);
  } catch (err) {
    check(`${m.id}: cenário executável sob mutação`, false, err?.stack ?? String(err));
    mutationFailures++;
    continue;
  }

  for (const probe of m.detect) {
    const detected = agg.get(probe) === false;
    check(`${m.id}: DETECTADO por ${probe}`, detected, `valor=${agg.get(probe)}`);
    if (!detected) mutationFailures++;
  }
  for (const probe of m.unaffected) {
    const intact = agg.get(probe) === true;
    check(`${m.id}: cenário-controle ${probe} permanece íntegro`, intact, `valor=${agg.get(probe)}`);
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
