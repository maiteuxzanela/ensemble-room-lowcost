#!/usr/bin/env node
/**
 * QUALITY GATE DETERMINÍSTICO — TICKET-RELEASE-11
 * Ciclo de vida do Standby/Wake: paywall throttled + ledger de rungs mortos +
 * guarda mecânica de um-escritor em checkout compartilhado.
 *
 * Sob teste (código REAL, não simulado — dist/ e src/, SQLite real via
 * node:sqlite em .test-scratch/, transporte de saída capturado):
 *
 *   Frente A — handleSessionStatusEvent(status='retry'):
 *     - Migration 20: 'throttled' no CHECK de team_member.status (fresh E
 *       upgrade v19→v20 com preservação de linhas);
 *     - retry de horizonte longo (> paywallRetryThresholdMs) → status
 *       'throttled' + EXATAMENTE 1 notificação ao lead (idempotente no burst);
 *     - retry curto → transient (retry_* persistidos, status intocado);
 *     - busy/idle posteriores liberam 'throttled' → 'busy'/'ready';
 *     - nudges suprimidos (status ≠ 'ready') e caller legado sem client/config
 *       degrada sem erro.
 *
 *   Frente B — ledger de rungs mortos por paywall:
 *     - isPaywallFailure detecta "Subscribe to OpenCode Go"/paywall/quota e
 *       NÃO confunde com 429 genérico nem "Model not found";
 *     - failover de membro com paywall: ledger por SALA (teamId), switch
 *       nunca persiste o rung morto em team_member.model, reason="paywall",
 *       segunda passada NUNCA re-seleciona o rung morto, exaustão explícita;
 *     - escopo ISOLADO: ledger por SESSÃO (isolated:${sessionId}).
 *
 *   Frente C — invariante de um-escritor (worktree:false):
 *     - resolveStandbyWake recusa wake (blocked) quando outro membro do
 *       MESMO checkout está busy/running; mantém 'standby' intacto;
 *     - membros COM worktree não bloqueiam nem são bloqueados;
 *     - executeTeamMessage/Broadcast deixam a fila delivered=0 e NÃO
 *       disparam promptAsync (nunca wake amnésico);
 *     - deliverDeferredStandbyWakes reproduz a fila no release do bastão
 *       (writer → idle) com spawn_context e delivered=1.
 *
 * Único ponto de emenda: o TRANSPORTE DE SAÍDA (promptAsync / abort /
 * showToast / session.get) é gravado num array para provar O QUE foi
 * chamado. Nenhuma lógica de decisão é substituída: sem mock library, sem
 * stub de banco, sem fixture falsa.
 *
 * Uso:  node tests/test_release_11_standby_lifecycle.mjs
 * Exit: 0 = todos os checks PASS; 1 = há FAIL.
 */

import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";

const REPO = path.resolve(import.meta.dirname, "..");
const PKG = process.env.ENSEMBLE_PKG || REPO;
const DIST = path.join(PKG, "dist/index.js");
const SRC = path.join(PKG, "src");
const TMP = path.join(REPO, ".test-scratch");
mkdirSync(TMP, { recursive: true });
const HARNESS = path.join(TMP, "_release11_harness.mjs");
const SRC_COPY = path.join(TMP, "ensemble_src-release11");
const ROOT = path.join(TMP, "release11_suite");

const results = [];
const check = (name, ok, detail) => {
  results.push([name, ok]);
  console.log(`${ok ? "PASS" : "FAIL"} | ${name}${detail ? " | " + detail : ""}`);
};

/* ================================================================== *
 * 0. SINTAXE — node --check dist/index.js (exit 0)
 * ================================================================== */
{
  const r = spawnSync(process.execPath, ["--check", DIST], { encoding: "utf8" });
  check("E) node --check dist/index.js → exit 0", r.status === 0, `status=${r.status}${r.stderr ? " stderr=" + r.stderr.trim().slice(0, 200) : ""}`);
}

/* ================================================================== *
 * 1. HARNESS DO DIST — bundle real + cláusulas de export anexadas
 * ================================================================== */
const REQUIRED_SYMBOLS = [
  "handleSessionStatusEvent", "handleRetryModelFailover", "isPaywallFailure",
  "paywallDeadRungs", "recordPaywallDeadRung", "getPaywallDeadRungs",
  "resolveStandbyWake", "deliverDeferredStandbyWakes", "recoverUndeliveredMessages",
  "executeTeamMessage", "executeTeamBroadcast",
  "shouldNudgeIdleMember", "failoverCooldown", "failoverActions",
  "FAILOVER_COOLDOWN_MS", "FAILOVER_BURST_DEBOUNCE_MS",
  "createDb", "MemberRegistry", "ProgressTracker", "DEFAULT_CONFIG", "MIGRATIONS",
];
const distRaw = readFileSync(DIST, "utf8");
{
  const missing = REQUIRED_SYMBOLS.filter(
    (s) => !new RegExp(`(async\\s+)?(function|class|var|const|let)\\s+${s}\\b`).test(distRaw),
  );
  check("dist declara todos os símbolos exigidos pela suíte", missing.length === 0, missing.join(",") || `${REQUIRED_SYMBOLS.length} símbolos`);

  const existingExport = distRaw.match(/export\s*\{([^}]*)\}\s*;?\s*$/)?.[1] ?? "";
  const already = new Set(existingExport.split(",").map((s) => s.trim().split(/\s+as\s+/).pop()).filter(Boolean));
  const need = REQUIRED_SYMBOLS.filter((s) => !already.has(s));
  const EXPORT_APPEND = need.length ? `\nexport { ${need.join(", ")} };\n` : "";
  writeFileSync(HARNESS, distRaw + EXPORT_APPEND);
  check(
    "harness do dist = bundle byte-a-byte + apenas cláusulas de export anexadas",
    readFileSync(HARNESS, "utf8") === distRaw + EXPORT_APPEND,
    `${distRaw.length} bytes; anexados=[${need.join(",")}]`,
  );
}

/* ================================================================== *
 * 2. CÓPIA DO SRC (type-stripping do Node recusa node_modules)
 * ================================================================== */
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
        if (existsSync(base + ext) && !spec.endsWith(ext)) { rewritten++; return a + spec + ext + c; }
      }
      return m;
    });
    if (after !== before) writeFileSync(file, after);
  }
  return rewritten;
}
check("cópia do src preparada (só resolução de extensão de import, lógica intacta)", prepareSrcCopy() > 0);

/* ================================================================== *
 * 3. PARIDADE src ↔ dist dos marcadores estruturais
 * ================================================================== */
function readSrc(rel) { return readFileSync(path.join(SRC, rel), "utf8"); }
const srcSchema = readSrc("schema.ts");
const srcHooks = readSrc("hooks.ts");
const srcShared = readSrc("tools/shared.ts");
const srcRecovery = readSrc("recovery.ts");

function marker(label, srcText, needle) {
  const srcHit = needle instanceof RegExp ? needle.test(srcText) : srcText.includes(needle);
  const distHit = needle instanceof RegExp ? needle.test(distRaw) : distRaw.includes(needle);
  check(`paridade src↔dist: ${label}`, srcHit && distHit, `src=${srcHit} dist=${distHit}`);
}
{
  const checks = distRaw.match(/CHECK\(status IN \([^)]*\)\)/g) ?? [];
  const mig20Dist = checks.some((c) => c.includes("'throttled'"));
  const mig20Src = /Migration 20/.test(srcSchema) && /'throttled'/.test(srcSchema);
  check(
    "Migration 20 estende o CHECK de status com 'throttled' (rebuild da tabela)",
    mig20Src && mig20Dist,
    `src=${mig20Src} dist=${mig20Dist} (${checks.length} CHECKs de status no bundle)`,
  );
}
marker("'throttled' no derivador failReason (hooks.ts)", srcHooks, /paywall \? "paywall" : deterministic \? "model-not-found" : "rate-limit"/);
marker("ledger paywallDeadRungs declarado (hooks.ts)", srcHooks, "paywallDeadRungs");
marker("guarda blocked-shared-checkout (tools/shared.ts)", srcShared, "blocked-shared-checkout");
marker("flush baton-release-flush (recovery.ts)", srcRecovery, "baton-release-flush");
marker("wake.blocked honorado no team_message", readSrc("tools/team-message.ts"), "wake.blocked");
marker("wake.blocked honorado no team_broadcast", readSrc("tools/team-broadcast.ts"), "wake.blocked");
marker("throttled liberado no busy branch (hooks.ts)", srcHooks, /member\.status === "throttled"/);

/* ================================================================== *
 * 4. ANTI-MOCK (Fail-Fast) — varredura determinística em produção
 * ================================================================== */
{
  const FORBIDDEN = [
    /\bMagicMock\b/, /\bjest\.(mock|fn|spyOn)\b/, /\bvi\.(mock|fn|spyOn)\b/,
    /\bsinon\b/, /unittest\.mock/, /mock\.patch\(/, /\bt\.mock\b/,
    /from\s+["'](sinon|testdouble|mock-fs|mockjs)["']/, /require\(["'](sinon|testdouble|mock-fs)["']\)/,
    /\bmockMethod\(/, /\bspyOn\(/,
  ];
  const walk = (dir) =>
    readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
      e.isDirectory() ? walk(path.join(dir, e.name)) : [path.join(dir, e.name)],
    );
  const offenders = [];
  for (const file of walk(SRC_COPY)) {
    if (!/\.tsx?$/.test(file)) continue;
    const text = readFileSync(file, "utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
    for (const rx of FORBIDDEN) {
      if (rx.test(text)) offenders.push(`${path.relative(SRC_COPY, file)} :: ${rx}`);
    }
  }
  check("F) zero mocks/stubs/spies em produção (src/**/*.ts, comentários desconsiderados)", offenders.length === 0, offenders.join(" | "));
}

/* ================================================================== *
 * 5. FIXTURES — SQLite REAL, transporte capturado
 * ================================================================== */
function makeClient(calls, opts = {}) {
  return {
    session: {
      create: async (o) => { calls.sessionCreate.push(o); return { data: { id: `ses_child_${calls.sessionCreate.length}` } }; },
      promptAsync: async (o) => { calls.promptAsync.push(o); return {}; },
      abort: async (o) => { calls.abort.push(o); return {}; },
      get: async (o) => { calls.sessionGet.push(o); return opts.getSessionResponse ?? { data: {} }; },
    },
    tui: {
      showToast: async (o) => { calls.toast.push(o); return {}; },
      selectSession: async () => ({}),
    },
    worktree: { create: async (o) => { calls.worktreeCreate.push(o); return { data: { name: "w", branch: "b", directory: "/tmp/w" } }; }, remove: async () => ({}) },
    workspace: { create: async (o) => { calls.workspaceCreate.push(o); return { data: { id: "ws_1" } }; }, remove: async () => ({}) },
  };
}
const newCalls = () => ({ sessionCreate: [], promptAsync: [], abort: [], toast: [], worktreeCreate: [], workspaceCreate: [], sessionGet: [] });

const HOUR = 60 * 60 * 1000;

function seedRoom(db, teamId, now) {
  db.run(
    "INSERT INTO team (id, name, lead_session_id, status, delegate, time_created, time_updated) VALUES (?,?,?,?,?,?,?)",
    [teamId, `room-${teamId}`, `ses_lead_${teamId}`, "active", 0, now, now],
  );
}
function seedMember(db, teamId, m, now) {
  db.run(
    `INSERT INTO team_member (team_id, name, session_id, agent, status, execution_status, model, time_created, time_updated, worktree_dir, spawn_context)
     VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
    [teamId, m.name, m.sessionId, m.agent ?? "build", m.status ?? "ready", m.executionStatus ?? "idle", m.model ?? null, now, now, m.worktreeDir ?? null, m.spawnContext ?? null],
  );
}
function memberRow(db, teamId, name) {
  return db.query("SELECT status, execution_status, model, retry_until FROM team_member WHERE team_id = ? AND name = ?").get(teamId, name);
}
function leadMessages(db, teamId) {
  return db.query("SELECT id, content FROM team_message WHERE team_id = ? AND to_name = 'lead' AND from_name = 'system'").all(teamId);
}
function undeliveredCount(db, teamId, toName) {
  return db.query("SELECT COUNT(*) AS c FROM team_message WHERE team_id = ? AND to_name = ? AND delivered = 0").get(teamId, toName).c;
}

async function runBehavior(label, mods) {
  const {
    handleSessionStatusEvent, handleRetryModelFailover, isPaywallFailure,
    paywallDeadRungs, recordPaywallDeadRung, getPaywallDeadRungs,
    resolveStandbyWake, deliverDeferredStandbyWakes,
    executeTeamMessage, executeTeamBroadcast,
    shouldNudgeIdleMember, failoverCooldown, failoverActions,
    createDb, MemberRegistry, ProgressTracker, DEFAULT_CONFIG,
  } = mods;

  const root = `${ROOT}_${label}`;
  rmSync(root, { recursive: true, force: true });
  mkdirSync(root, { recursive: true });
  const db = createDb(path.join(root, "ensemble.db"));
  const migrationsLen = mods.MIGRATIONS.length;

  /* --- 5.1 Migration 20: fresh --- */
  {
    const version = db.query("PRAGMA user_version").get().user_version;
    check(`[${label}] ensemble.db migra até user_version = ${migrationsLen}`, version === migrationsLen, `user_version=${version}`);
    const tableSql = (db.query("SELECT sql FROM sqlite_master WHERE type='table' AND name='team_member'").get()?.sql ?? "").replace(/\s+/g, " ");
    check(
      `[${label}] Migration 20: CHECK de status aceita 'throttled'`,
      /CHECK\(status IN \([^)]*'throttled'/.test(tableSql),
      tableSql.match(/CHECK\(status IN \([^)]*\)\)/)?.[0]?.slice(0, 160) ?? "CHECK ausente",
    );
    const info = db.query("PRAGMA table_info(team_member)").all().map((c) => c.name);
    const pk = db.query("PRAGMA table_info(team_member)").all().filter((c) => c.pk > 0).map((c) => c.name).sort().join(",");
    const idx = db.query("PRAGMA index_list(team_member)").all().map((i) => i.name).sort();
    const preserved = ["worktree_dir", "worktree_branch", "plan_approval", "workspace_id", "reported_to_lead", "last_nudged_at", "retry_until", "retry_attempt", "retry_provider", "retry_message", "spawn_context", "is_qa", "role"];
    const missing = preserved.filter((c) => !info.includes(c));
    check(`[${label}] rebuild da Migration 20 preservou todas as colunas`, missing.length === 0, missing.join(",") || `${info.length} colunas`);
    check(`[${label}] rebuild manteve PK (team_id,name)`, pk === "name,team_id", `pk=${pk}`);
    check(
      `[${label}] rebuild recriou os índices de team_member`,
      idx.includes("team_member_session_idx") && idx.includes("team_member_status_idx"),
      idx.join(","),
    );
    // INSERT real com o novo literal num banco recém-migrado.
    seedRoom(db, "team_m20", Date.now());
    let insertErr = "";
    try {
      seedMember(db, "team_m20", { name: "throttle-probe", sessionId: "ses_probe", status: "throttled" }, Date.now());
    } catch (e) {
      insertErr = e instanceof Error ? e.message : String(e);
    }
    check(`[${label}] INSERT status='throttled' aceito no schema fresh`, insertErr === "", insertErr || "ok");
  }

  /* --- 5.2 UPGRADE v19 → v20 (fixture legada real) --- */
  {
    // A fixture legada é o schema ANTERIOR à Migration 20 (o CHECK sem
    // 'throttled'), ou seja, user_version = 19 — NÃO "migrationsLen - 1".
    // Fixar em 19 mantém a semântica do cenário quando migrations posteriores
    // (ex.: Migration 21 do TICKET-HARNESS-82) são acrescentadas ao fim do array.
    const LEGACY_USER_VERSION = 19;
    const tmp = path.join(root, "legacy_v19.db");
    rmSync(tmp, { force: true, maxRetries: 5, retryDelay: 50 });
    const SEED_NOW = 1_700_000_000_000;
    const { DatabaseSync } = await import("node:sqlite");
    const legacy = new DatabaseSync(tmp);
    for (const sql of mods.MIGRATIONS.slice(0, LEGACY_USER_VERSION)) legacy.exec(sql);
    legacy.exec(`PRAGMA user_version = ${LEGACY_USER_VERSION}`);
    legacy.prepare("INSERT INTO team (id, name, project_id, lead_session_id, status, delegate, time_created, time_updated) VALUES (?,?,?,?,?,?,?,?)")
      .run("team_leg11", "legacy-r11", "default", "ses_lead_leg11", "active", 0, SEED_NOW, SEED_NOW);
    for (const [name, session] of [["leg-a", "ses_leg_a"], ["leg-b", "ses_leg_b"]]) {
      legacy.prepare("INSERT INTO team_member (team_id, name, session_id, agent, status, execution_status, time_created, time_updated) VALUES (?,?,?,?,?,?,?,?)")
        .run("team_leg11", name, session, "build", "ready", "idle", SEED_NOW, SEED_NOW);
    }
    legacy.close();

    const before = (() => {
      const ro = new DatabaseSync(tmp, { readOnly: true });
      const v = ro.prepare("PRAGMA user_version").get().user_version;
      const c = ro.prepare("SELECT COUNT(*) AS c FROM team_member").get().c;
      const sql = ro.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='team_member'").get().sql.replace(/\s+/g, " ");
      ro.close();
      return { v, c, hasThrottled: /'throttled'/.test(sql) };
    })();

    let afterVersion = -1, afterCount = -1, upErr = "", afterHasThrottled = false, insertErr = "";
    try {
      const up = createDb(tmp);
      afterVersion = up.query("PRAGMA user_version").get().user_version;
      afterCount = up.query("SELECT COUNT(*) AS c FROM team_member").get().c;
      const sql = (up.query("SELECT sql FROM sqlite_master WHERE type='table' AND name='team_member'").get()?.sql ?? "").replace(/\s+/g, " ");
      afterHasThrottled = /CHECK\(status IN \([^)]*'throttled'/.test(sql);
      try {
        up.run("UPDATE team_member SET status = 'throttled', time_updated = ? WHERE team_id = ? AND name = ?", [Date.now(), "team_leg11", "leg-a"]);
      } catch (e) {
        insertErr = e instanceof Error ? e.message : String(e);
      }
      const promoted = up.query("SELECT status FROM team_member WHERE team_id = ? AND name = ?").get("team_leg11", "leg-a");
      up.close();
      var promotedStatus = promoted?.status;
    } catch (e) {
      upErr = e instanceof Error ? e.message : String(e);
    }
    check(
      `[${label}] fixture v${LEGACY_USER_VERSION} pré-existe SEM 'throttled' e migra para v${migrationsLen}`,
      before.v === LEGACY_USER_VERSION && !before.hasThrottled && !upErr && afterVersion === migrationsLen,
      upErr || `v${before.v}→${afterVersion}`,
    );
    check(
      `[${label}] upgrade preservou as linhas e o CHECK novo aceita 'throttled'`,
      afterCount === before.c && afterHasThrottled && insertErr === "" && promotedStatus === "throttled",
      `rows ${before.c}→${afterCount}; insertErr=${insertErr || "none"}; status=${promotedStatus}`,
    );
  }

  /* ================================================================== *
   * FREnte A — throttled por paywall de longo horizonte
   * ================================================================== */
  {
    const teamId = "team_A";
    const now = Date.now();
    seedRoom(db, teamId, now);
    seedMember(db, teamId, { name: "alpha", sessionId: "ses_A_alpha", status: "busy", executionStatus: "running", model: "prov/a#low" }, now);
    const registry = new MemberRegistry();
    registry.register(teamId, "alpha", "ses_A_alpha");
    const calls = newCalls();
    const client = makeClient(calls);
    const config = { ...DEFAULT_CONFIG };
    mods.failoverCooldown.clear?.();
    paywallDeadRungs.clear();

    // A3: retry de horizonte longo → 'throttled' + 1 aviso ao lead.
    const t1 = handleSessionStatusEvent(db, registry, "ses_A_alpha", "retry", {
      attempt: 1, message: "rate limited", next: Date.now() + 2 * HOUR,
    }, client, config);
    const afterLong = memberRow(db, teamId, "alpha");
    check(`[${label}] A3: retry longo (>1h) → transição to='throttled'`, t1?.to === "throttled" && t1?.from === "busy", JSON.stringify(t1));
    check(`[${label}] A3: status persistido 'throttled' + retry_until gravado`, afterLong?.status === "throttled" && typeof afterLong?.retry_until === "number", `status=${afterLong?.status} retry_until=${afterLong?.retry_until}`);
    const leadRows1 = leadMessages(db, teamId);
    check(`[${label}] A3: EXATAMENTE 1 notificação de sistema ao lead`, leadRows1.length === 1 && /THROTTLED by a paywall/.test(leadRows1[0]?.content ?? ""), `count=${leadRows1.length}`);

    // A4: burst idempotente — segundo retry NÃO duplica o aviso.
    const t2 = handleSessionStatusEvent(db, registry, "ses_A_alpha", "retry", {
      attempt: 2, message: "rate limited", next: Date.now() + 2 * HOUR,
    }, client, config);
    check(`[${label}] A4: retry repetido com status já 'throttled' → to='retry' (sem nova transição)`, t2?.to === "retry", JSON.stringify(t2));
    check(`[${label}] A4: aviso ao lead continua sendo 1 (idempotente)`, leadMessages(db, teamId).length === 1, `count=${leadMessages(db, teamId).length}`);

    // A6: busy libera 'throttled' → 'busy'.
    const tBusy = handleSessionStatusEvent(db, registry, "ses_A_alpha", "busy");
    const afterBusy = memberRow(db, teamId, "alpha");
    check(`[${label}] A6: busy libera 'throttled' → status busy/running`, tBusy?.to === "busy" && afterBusy?.status === "busy" && afterBusy?.execution_status === "running", JSON.stringify({ t: tBusy, s: afterBusy?.status, e: afterBusy?.execution_status }));

    // A7: throttled → idle libera para 'ready'.
    db.run("UPDATE team_member SET status = 'throttled' WHERE team_id = ? AND name = ?", [teamId, "alpha"]);
    const tIdle = handleSessionStatusEvent(db, registry, "ses_A_alpha", "idle");
    check(`[${label}] A7: idle libera 'throttled' → 'ready'`, tIdle?.to === "ready" && memberRow(db, teamId, "alpha")?.status === "ready", JSON.stringify(tIdle));

    // A9: nudge suprimido para 'throttled' (o gate de status 'ready' basta).
    db.run("UPDATE team_member SET status = 'throttled' WHERE team_id = ? AND name = ?", [teamId, "alpha"]);
    check(
      `[${label}] A9: shouldNudgeIdleMember=false para 'throttled' mesmo com silentLead:false`,
      shouldNudgeIdleMember(db, teamId, "alpha", { ...DEFAULT_CONFIG, silentLead: false }) === false,
    );

    // A5: retry CURTO permanece transient (não throtla).
    seedMember(db, teamId, { name: "beta", sessionId: "ses_A_beta", status: "busy", executionStatus: "running" }, now);
    registry.register(teamId, "beta", "ses_A_beta");
    const tShort = handleSessionStatusEvent(db, registry, "ses_A_beta", "retry", {
      attempt: 1, message: "rate limited", next: Date.now() + 5 * 60 * 1000,
    }, client, config);
    const afterShort = memberRow(db, teamId, "beta");
    check(
      `[${label}] A5: retry curto (5min) NÃO throtla — status intocado, retry_* persistidos`,
      tShort?.to === "retry" && afterShort?.status === "busy" && typeof afterShort?.retry_until === "number",
      JSON.stringify({ t: tShort?.to, s: afterShort?.status }),
    );

    // A8: caller legado (sem client/config) — a FSM continua verdadeira
    // (throttled decidido pelo horizonte, default 1h), mas NENHUMA notificação
    // ao lead é emitida (sem client → sem notifyLead) e nada quebra.
    seedMember(db, teamId, { name: "gamma", sessionId: "ses_A_gamma", status: "busy", executionStatus: "running" }, now);
    registry.register(teamId, "gamma", "ses_A_gamma");
    const leadRowsBeforeA8 = leadMessages(db, teamId).length;
    const tLegacy = handleSessionStatusEvent(db, registry, "ses_A_gamma", "retry", {
      attempt: 1, message: "rate limited", next: Date.now() + 5 * HOUR,
    });
    const afterLegacy = memberRow(db, teamId, "gamma");
    check(
      `[${label}] A8: caller sem client/config throtla pelo horizonte (default 1h) e persiste retry_*`,
      tLegacy?.to === "throttled" && afterLegacy?.status === "throttled" && typeof afterLegacy?.retry_until === "number",
      JSON.stringify({ t: tLegacy?.to, s: afterLegacy?.status }),
    );
    check(
      `[${label}] A8: SEM client → zero notificação nova ao lead (notifyLead pulado)`,
      leadMessages(db, teamId).length === leadRowsBeforeA8,
      `count=${leadMessages(db, teamId).length}`,
    );
  }

  /* ================================================================== *
   * FRENTE B — ledger de rungs mortos por paywall
   * ================================================================== */
  {
    // B1: detector.
    check(`[${label}] B1: isPaywallFailure detecta "Subscribe to OpenCode Go"`, isPaywallFailure({ message: "Subscribe to OpenCode Go to continue" }) === true);
    check(`[${label}] B1: detecta "paywall"/"out of quota"/"quota exceeded"`, isPaywallFailure("paywall hit") && isPaywallFailure({ data: { message: "out of quota" } }) && isPaywallFailure("quota exceeded, upgrade your plan"));
    check(`[${label}] B1: NÃO confunde 429 genérico nem "Model not found"`, isPaywallFailure({ message: "429 Too Many Requests — retry in 60s" }) === false && isPaywallFailure({ name: "ProviderModelNotFoundError", message: "Model not found: prov/x" }) === false);
    check(`[${label}] B1: payload vazio/nulo → false`, isPaywallFailure(null) === false && isPaywallFailure(undefined) === false && isPaywallFailure("") === false);

    const teamId = "team_B";
    const now = Date.now();
    seedRoom(db, teamId, now);
    seedMember(db, teamId, { name: "bia", sessionId: "ses_B_bia", status: "busy", executionStatus: "running", model: "prov/a#low" }, now);
    const registry = new MemberRegistry();
    registry.register(teamId, "bia", "ses_B_bia");
    const calls = newCalls();
    const client = makeClient(calls);
    const config = {
      ...DEFAULT_CONFIG,
      fallbackModels: ["prov/a#low", "prov/b#low", "prov/c#low"],
      fallbackModelsByAgent: { build: ["prov/a#low", "prov/b#low", "prov/c#low"] },
    };
    failoverCooldown.clear();
    failoverActions.clear();
    paywallDeadRungs.clear();

    // B2: paywall de membro → ledger de SALA + switch nunca persiste o morto.
    const d1 = await handleRetryModelFailover(db, registry, client, config, "ses_B_bia", {
      attempt: 1, message: "Subscribe to OpenCode Go", next: Date.now() + 3 * HOUR,
    });
    const dead1 = getPaywallDeadRungs(teamId);
    check(
      `[${label}] B2: paywall de membro → switch adiante reason='paywall' toModel='prov/b#low'`,
      d1?.action === "switched" && d1?.reason === "paywall" && d1?.toModel === "prov/b#low",
      JSON.stringify(d1),
    );
    check(`[${label}] B2: rung morto 'prov/a' ledgerado no escopo da SALA`, dead1.includes("prov/a"), dead1.join(","));
    check(`[${label}] B2: team_member.model NOVO rung (nunca o morto)`, memberRow(db, teamId, "bia")?.model === "prov/b#low", memberRow(db, teamId, "bia")?.model);

    // B3: segunda passada — rung morto NUNCA é re-selecionado.
    db.run("UPDATE team_member SET model = 'prov/a#low' WHERE team_id = ? AND name = ?", [teamId, "bia"]);
    failoverCooldown.set(`${teamId}:bia`, Date.now() - 10_000); // além do debounce
    const d2 = await handleRetryModelFailover(db, registry, client, config, "ses_B_bia", {
      attempt: 1, message: "Subscribe to OpenCode Go", next: Date.now() + 3 * HOUR,
    });
    check(
      `[${label}] B3: segunda passada pula o rung morto → toModel='prov/c#low' (nunca re-seleciona 'prov/a')`,
      d2?.action === "switched" && d2?.toModel === "prov/c#low" && memberRow(db, teamId, "bia")?.model === "prov/c#low",
      JSON.stringify(d2),
    );

    // B4: ledger também corta o caminho do RATE-LIMIT walk (selectNextFallback).
    recordPaywallDeadRung(teamId, "prov/b#low");
    db.run("UPDATE team_member SET model = 'prov/b#low' WHERE team_id = ? AND name = ?", [teamId, "bia"]);
    failoverCooldown.clear();
    failoverActions.clear();
    const d3 = await handleRetryModelFailover(db, registry, client, config, "ses_B_bia", {
      attempt: 1, message: "429 Too Many Requests — retry in 30s", next: Date.now() + 30_000,
    });
    check(
      `[${label}] B4: rung morto ledgerado é pulado até no walk de rate-limit (→ 'prov/c#low')`,
      d3?.action === "switched" && d3?.toModel === "prov/c#low" && d3?.reason === "rate-limit",
      JSON.stringify(d3),
    );

    // B5: exaustão — todo rung morto → decisão explícita, SEM persistir morto.
    const teamId5 = "team_B5";
    seedRoom(db, teamId5, now);
    seedMember(db, teamId5, { name: "be", sessionId: "ses_B5", status: "busy", executionStatus: "running", model: "prov/a#low" }, now);
    registry.register(teamId5, "be", "ses_B5");
    failoverCooldown.clear();
    failoverActions.clear();
    paywallDeadRungs.clear();
    const promptsBefore5 = calls.promptAsync.length;
    const d5 = await handleRetryModelFailover(db, registry, client, { ...config, fallbackModels: ["prov/a#low"], fallbackModelsByAgent: { build: ["prov/a#low"] } }, "ses_B5", {
      attempt: 1, message: "Subscribe to OpenCode Go", next: Date.now() + 3 * HOUR,
    });
    check(
      `[${label}] B5: cadeia toda morta → exhausted reason='paywall', sem switch`,
      d5?.action === "exhausted" && d5?.reason === "paywall" && calls.promptAsync.length === promptsBefore5,
      JSON.stringify(d5),
    );

    // B7 (SDET): o LEDGER é load-bearing no restart da cadeia. Um membro da
    // sala parado FORA da cadeia faz o walk reiniciar em chain[0]; se o rung
    // morto por paywall continuar na cadeia, ele é re-selecionado e persistido
    // — exatamente o invariante "NUNCA re-selecionar" da Frente B. Cobre o
    // efeito entre PARES (o ledger é de SALA, não do membro que falhou).
    const teamId7 = "team_B7";
    seedRoom(db, teamId7, now);
    seedMember(db, teamId7, { name: "caio", sessionId: "ses_B7", status: "busy", executionStatus: "running", model: "prov/z#low" }, now);
    registry.register(teamId7, "caio", "ses_B7");
    failoverCooldown.clear();
    failoverActions.clear();
    paywallDeadRungs.clear();
    recordPaywallDeadRung(teamId7, "prov/a#low"); // rung morto por paywall de OUTRO membro
    const d7 = await handleRetryModelFailover(db, registry, client, config, "ses_B7", {
      attempt: 1, message: "429 Too Many Requests — retry in 30s", next: Date.now() + 30_000,
    });
    check(
      `[${label}] B7: restart da cadeia (modelo fora dela) NUNCA re-seleciona rung morto → 'prov/b#low'`,
      d7?.action === "switched" && d7?.toModel === "prov/b#low" && memberRow(db, teamId7, "caio")?.model === "prov/b#low",
      JSON.stringify(d7),
    );

    // B6: escopo ISOLADO — ledger por SESSÃO, never por team.
    const callsI = newCalls();
    const clientI = makeClient(callsI, {
      getSessionResponse: { data: { agent: "diana", model: { providerID: "prov", id: "x", variant: "low" } } },
    });
    failoverCooldown.clear();
    failoverActions.clear();
    paywallDeadRungs.clear();
    const configI = {
      ...DEFAULT_CONFIG,
      fallbackModelsByAgent: { diana: ["prov/x#low", "prov/y#low"] },
    };
    const dI = await handleRetryModelFailover(db, registry, clientI, configI, "ses_isolated_B", {
      attempt: 1, message: "Subscribe to OpenCode Go", next: Date.now() + 3 * HOUR, agent: "diana",
    });
    check(
      `[${label}] B6: isolado → switch reason='paywall' toModel='prov/y#low' (zero escrita em team_member)`,
      dI?.action === "switched" && dI?.reason === "paywall" && dI?.toModel === "prov/y#low" && dI?.teamId === "",
      JSON.stringify(dI),
    );
    check(
      `[${label}] B6: ledger no escopo isolated:${"ses_isolated_B"} (não numa sala)`,
      getPaywallDeadRungs("isolated:ses_isolated_B").includes("prov/x") && getPaywallDeadRungs(teamId).length === 0,
      `isolated=[${getPaywallDeadRungs("isolated:ses_isolated_B")}] team=[${getPaywallDeadRungs(teamId)}]`,
    );
  }

  /* ================================================================== *
   * FRENTE C — gate OPT-IN de um-escritor (sharedCheckoutSingleWriter),
   * batão FORMAL persistido (assignee de card in_progress), nunca
   * inferido de status='busy'. Default OFF = wakes nunca bloqueados.
   * ================================================================== */
  {
    const teamId = "team_C";
    const now = Date.now();
    const GATE_ON = { ...DEFAULT_CONFIG, sharedCheckoutSingleWriter: true };
    seedRoom(db, teamId, now);
    // writer: shared checkout + card in_progress = OUTRO batão formal.
    seedMember(db, teamId, { name: "writer", sessionId: "ses_C_writer", status: "busy", executionStatus: "running" }, now);
    db.run(
      "INSERT INTO team_task (id, team_id, content, status, priority, assignee, time_created, time_updated) VALUES (?,?,?,?,?,?,?,?)",
      ["task_C_writer", teamId, "Frente do writer (batão formal)", "in_progress", "high", "writer", now, now],
    );
    // standby COM card in_progress: segundo stakeholder de escrita.
    seedMember(db, teamId, { name: "sleeper", sessionId: "ses_C_sleeper", status: "ready", executionStatus: "standby", spawnContext: "SPAWN_CONTEXT_R11" }, now);
    db.run(
      "INSERT INTO team_task (id, team_id, content, status, priority, assignee, time_created, time_updated) VALUES (?,?,?,?,?,?,?,?)",
      ["task_C_sleeper", teamId, "Frente compartilhada do sleeper", "in_progress", "high", "sleeper", now, now],
    );
    // standby SEM card: wake de coordenação — NUNCA bloqueado.
    seedMember(db, teamId, { name: "coordinator", sessionId: "ses_C_coord", status: "ready", executionStatus: "standby", spawnContext: "COORD_CTX" }, now);
    const registry = new MemberRegistry();
    registry.register(teamId, "writer", "ses_C_writer");
    registry.register(teamId, "sleeper", "ses_C_sleeper");
    registry.register(teamId, "coordinator", "ses_C_coord");

    // C0: wake de coordenação (SEM card) nunca é bloqueado, nem com o gate ON.
    const wCoord = resolveStandbyWake(db, teamId, "coordinator", "coord wake", true);
    check(
      `[${label}] C0: wake de coordenação (membro SEM card) nunca é bloqueado — wakes paralelos legítimos preservados`,
      wCoord.blocked !== true && wCoord.woke === true && String(wCoord.text).startsWith("COORD_CTX"),
      JSON.stringify(wCoord),
    );

    // C0b: gate OFF (default) — a MESMA contención formal NÃO bloquea (opt-in).
    const wOff = resolveStandbyWake(db, teamId, "sleeper", "gate-off wake");
    check(
      `[${label}] C0b: gate OFF (default) — duplo card-holder NÃO bloqueia wake (opt-in preservado, legado byte-a-byte)`,
      wOff.blocked !== true && wOff.woke === true && String(wOff.text).startsWith("SPAWN_CONTEXT_R11"),
      JSON.stringify(wOff),
    );
    db.run("UPDATE team_member SET execution_status = 'standby' WHERE team_id = ? AND name = ?", [teamId, "sleeper"]);

    // C1: gate ON — contención formal (dois batões no mesmo checkout) bloqueia.
    const w1 = resolveStandbyWake(db, teamId, "sleeper", "base text", true);
    check(
      `[${label}] C1: gate ON bloqueia (blocked=true, woke=false) — alvo E outro membro ambos com card in_progress no mesmo checkout`,
      w1.blocked === true && w1.woke === false && w1.text === "base text",
      JSON.stringify(w1),
    );
    check(`[${label}] C1: execution_status permanece 'standby' (janela intacta)`, memberRow(db, teamId, "sleeper")?.execution_status === "standby", memberRow(db, teamId, "sleeper")?.execution_status);

    // C1b: NUNCA inferir batão de status='busy' — writer busy mas SEM card
    // (outro membro qualquer ocupado) não bloqueia nem com o gate ON.
    const teamIdNb = "team_Cnb";
    seedRoom(db, teamIdNb, now);
    seedMember(db, teamIdNb, { name: "busy-nocard", sessionId: "ses_Cnb_w", status: "busy", executionStatus: "running" }, now);
    seedMember(db, teamIdNb, { name: "card-sleeper", sessionId: "ses_Cnb_s", status: "ready", executionStatus: "standby", spawnContext: "NB_CTX" }, now);
    db.run(
      "INSERT INTO team_task (id, team_id, content, status, priority, assignee, time_created, time_updated) VALUES (?,?,?,?,?,?,?,?)",
      ["task_Cnb_s", teamIdNb, "Card do card-sleeper", "in_progress", "high", "card-sleeper", now, now],
    );
    const wNb = resolveStandbyWake(db, teamIdNb, "card-sleeper", "busy-without-card", true);
    check(
      `[${label}] C1b: membro busy SEM card nunca bloqueia (batão é assignee formal, não status='busy')`,
      wNb.blocked !== true && wNb.woke === true,
      JSON.stringify(wNb),
    );

    // C2: executeTeamMessage (gate ON no config) — fila delivered=0, NENHUM promptAsync.
    const callsC = newCalls();
    const clientC = makeClient(callsC);
    const progressTracker = new ProgressTracker();
    const deps = { db, registry, tracker: {}, purgeApprovals: {}, client: clientC, directory: root, config: GATE_ON, progressTracker };
    const retMsg = await executeTeamMessage(deps, { to: "sleeper", text: "write something" }, "ses_C_writer");
    check(`[${label}] C2: team_message devolve fila deferida (gate opt-in)`, /deferred by the shared-checkout single-writer gate/i.test(retMsg), retMsg);
    check(`[${label}] C2: NENHUM promptAsync disparado (nunca wake amnésico)`, callsC.promptAsync.length === 0, `promptAsync=${callsC.promptAsync.length}`);
    check(`[${label}] C2: mensagem persistida delivered=0 (replayável)`, undeliveredCount(db, teamId, "sleeper") === 1, `undelivered=${undeliveredCount(db, teamId, "sleeper")}`);

    // C2b: coordenação (sem card) entrega de imediato, mesmo com gate ON.
    const retCoord = await executeTeamMessage(deps, { to: "coordinator", text: "coord ping" }, "ses_C_writer");
    check(
      `[${label}] C2b: team_message de coordenação ao membro SEM card entrega de imediato`,
      /Message sent to coordinator/.test(retCoord) && callsC.promptAsync.some((p) => p.sessionID === "ses_C_coord" && String(p.parts?.[0]?.text ?? "").includes("coord ping")),
      retCoord,
    );

    // C3: broadcast — card-holder deferido; coord (sem card) entregue.
    const promptsBeforeBc = callsC.promptAsync.length;
    const retBc = await executeTeamBroadcast(deps, { text: "broadcast geral" }, "ses_C_writer");
    check(`[${label}] C3: broadcast sinaliza o destinatário deferido`, /deferred by the shared-checkout single-writer gate/i.test(retBc), retBc);
    check(
      `[${label}] C3: broadcast entregou só ao coordenador (sem card) e deixou o sleeper na fila`,
      callsC.promptAsync.length === promptsBeforeBc + 1
        && callsC.promptAsync.at(-1)?.sessionID === "ses_C_coord"
        && undeliveredCount(db, teamId, "sleeper") === 2,
      `promptAsync+=${callsC.promptAsync.length - promptsBeforeBc}; undelivered(sleeper)=${undeliveredCount(db, teamId, "sleeper")}`,
    );

    // C4a: release FORMAL do bastão do writer (card → completed) e flush
    // EXPLÍCITO determinístico: as 2 linhas deferidas são reproduzidas —
    // spawn_context só na primeira (a 2ª é pass-through pós-consumo da janela).
    db.run("UPDATE team_task SET status = 'completed', time_updated = ? WHERE id = ?", [Date.now(), "task_C_writer"]);
    const flush = await deliverDeferredStandbyWakes(db, clientC, registry, teamId, true);
    const sleeperPrompts = callsC.promptAsync.filter((p) => p.sessionID === "ses_C_sleeper");
    check(
      `[${label}] C4a: release formal do batão + flush reproduz a fila com spawn_context na 1ª entrega`,
      flush.redelivered === 2 && flush.blocked === 0
        && String(sleeperPrompts[0]?.parts?.[0]?.text ?? "").startsWith("SPAWN_CONTEXT_R11")
        && /Recovered team message from writer/.test(String(sleeperPrompts[0]?.parts?.[0]?.text ?? "")),
      JSON.stringify({ flush, first: String(sleeperPrompts[0]?.parts?.[0]?.text ?? "").slice(0, 48) }),
    );
    check(
      `[${label}] C4a: 2ª linha (broadcast) entregue em pass-through (prefixo Recovered, sem prepend)`,
      /Recovered team message from writer\]: broadcast geral/.test(String(sleeperPrompts[1]?.parts?.[0]?.text ?? ""))
        && !String(sleeperPrompts[1]?.parts?.[0]?.text ?? "").startsWith("SPAWN_CONTEXT_R11"),
      String(sleeperPrompts[1]?.parts?.[0]?.text ?? "").slice(0, 60),
    );
    check(
      `[${label}] C4a: fila consumida (delivered=1) e membro em 'starting'`,
      undeliveredCount(db, teamId, "sleeper") === 0 && memberRow(db, teamId, "sleeper")?.execution_status === "starting",
      memberRow(db, teamId, "sleeper")?.execution_status,
    );

    // C4b: WIRING — o idle branch COM client+config(gate ON) dispara o flush
    // do hook (fire-and-forget); prova comportamental com polling limitado.
    db.run("UPDATE team_member SET status = 'busy', execution_status = 'running' WHERE team_id = ? AND name = ?", [teamId, "writer"]);
    db.run("UPDATE team_task SET status = 'in_progress', time_updated = ? WHERE id = ?", [Date.now(), "task_C_writer"]);
    db.run("UPDATE team_member SET execution_status = 'standby' WHERE team_id = ? AND name = ?", [teamId, "sleeper"]);
    db.run(
      "INSERT INTO team_message (id, team_id, from_name, to_name, content, delivered, time_created) VALUES (?,?,?,?,?,0,?)",
      ["msg_C4b", teamId, "writer", "sleeper", "wired flush payload", Date.now()],
    );
    // Gate ainda ON (duplo card-holder) → primeiramente prova que o flush do
    // hook NÃO entrega enquanto o batão formal persiste...
    handleSessionStatusEvent(db, registry, "ses_C_writer", "idle", undefined, clientC, GATE_ON);
    await new Promise((r) => setTimeout(r, 100));
    check(
      `[${label}] C4b: com batão formal ainda ativo, o flush do hook re-mantém a fila (defer formal, não status)`,
      undeliveredCount(db, teamId, "sleeper") >= 1,
      `undelivered=${undeliveredCount(db, teamId, "sleeper")}`,
    );
    // ...e após o release formal (card completed) o flush entrega.
    db.run("UPDATE team_task SET status = 'completed', time_updated = ? WHERE id = ?", [Date.now(), "task_C_writer"]);
    await deliverDeferredStandbyWakes(db, clientC, registry, teamId, true);
    check(
      `[${label}] C4b: release formal do batão → flush entrega (delivered=1, spawn_context prependado)`,
      undeliveredCount(db, teamId, "sleeper") === 0
        && callsC.promptAsync.some((p) => p.sessionID === "ses_C_sleeper" && String(p.parts?.[0]?.text ?? "").startsWith("SPAWN_CONTEXT_R11")),
      `undelivered=${undeliveredCount(db, teamId, "sleeper")}`,
    );

    // C5: flush sem standby → no-op barato.
    const promptsBeforeFlush = callsC.promptAsync.length;
    const flush2 = await deliverDeferredStandbyWakes(db, clientC, registry, teamId, true);
    check(`[${label}] C5: flush sem membros em standby é no-op`, flush2.redelivered === 0 && flush2.blocked === 0 && callsC.promptAsync.length === promptsBeforeFlush, JSON.stringify(flush2));

    // C6: worktree ISOLA — o gate não bloqueia nem é bloqueado por eles.
    const teamIdW = "team_Cw";
    seedRoom(db, teamIdW, now);
    seedMember(db, teamIdW, { name: "wt-writer", sessionId: "ses_Cw_w", status: "busy", executionStatus: "running", worktreeDir: "/tmp/wt-w" }, now);
    seedMember(db, teamIdW, { name: "wt-sleeper", sessionId: "ses_Cw_s", status: "ready", executionStatus: "standby", worktreeDir: "/tmp/wt-s", spawnContext: "WT_CTX" }, now);
    for (const [id, assignee] of [["task_Cw_w", "wt-writer"], ["task_Cw_s", "wt-sleeper"]]) {
      db.run(
        "INSERT INTO team_task (id, team_id, content, status, priority, assignee, time_created, time_updated) VALUES (?,?,?,?,?,?,?,?)",
        [id, teamIdW, `card ${assignee}`, "in_progress", "medium", assignee, now, now],
      );
    }
    const wWt = resolveStandbyWake(db, teamIdW, "wt-sleeper", "isolated wake", true);
    check(
      `[${label}] C6: standby COM worktree nunca é bloqueado (checkout isolado)`,
      wWt.blocked !== true && wWt.woke === true,
      JSON.stringify(wWt),
    );
    // Outro batão-holder EM worktree não bloqueia um shared-sleeper.
    const teamIdW2 = "team_Cw2";
    seedRoom(db, teamIdW2, now);
    seedMember(db, teamIdW2, { name: "busy-wt", sessionId: "ses_Cw2_w", status: "busy", executionStatus: "running", worktreeDir: "/tmp/busy-wt" }, now);
    seedMember(db, teamIdW2, { name: "shared-sleeper", sessionId: "ses_Cw2_s", status: "ready", executionStatus: "standby", spawnContext: "SH_CTX" }, now);
    for (const [id, assignee] of [["task_Cw2_w", "busy-wt"], ["task_Cw2_s", "shared-sleeper"]]) {
      db.run(
        "INSERT INTO team_task (id, team_id, content, status, priority, assignee, time_created, time_updated) VALUES (?,?,?,?,?,?,?,?)",
        [id, teamIdW2, `card ${assignee}`, "in_progress", "medium", assignee, now, now],
      );
    }
    const wMix = resolveStandbyWake(db, teamIdW2, "shared-sleeper", "mixed wake", true);
    check(
      `[${label}] C6: batão-holder EM worktree não bloqueia wake de membro shared (checkouts distintos)`,
      wMix.blocked !== true && wMix.woke === true,
      JSON.stringify(wMix),
    );

    // C7: REPLAY NUNCA DEPENDE SÓ DO IDLE — o re-envio re-avalia o gate.
    db.run("UPDATE team_member SET status = 'busy', execution_status = 'running' WHERE team_id = ? AND name = ?", [teamId, "writer"]);
    db.run("UPDATE team_task SET status = 'in_progress', time_updated = ? WHERE id = ?", [Date.now(), "task_C_writer"]);
    db.run("UPDATE team_member SET execution_status = 'standby' WHERE team_id = ? AND name = ?", [teamId, "sleeper"]);
    const retDeferred = await executeTeamMessage(deps, { to: "sleeper", text: "queued while baton held" }, "ses_C_writer");
    check(`[${label}] C7: re-envio com batão formal ativo permanece deferido`, /deferred by the shared-checkout single-writer gate/i.test(retDeferred), retDeferred);
    // Release formal do batão SEM nenhum evento idle.
    db.run("UPDATE team_task SET status = 'completed', time_updated = ? WHERE id = ?", [Date.now(), "task_C_writer"]);
    const promptsBeforeResend = callsC.promptAsync.length;
    const retResend = await executeTeamMessage(deps, { to: "sleeper", text: "delivered after formal release" }, "ses_C_writer");
    check(
      `[${label}] C7: re-envio pós-release formal entrega NA HORA (replay sem depender do idle)`,
      /Message sent to sleeper \(woke from standby/.test(retResend)
        && callsC.promptAsync.length === promptsBeforeResend + 1
        && String(callsC.promptAsync.at(-1)?.parts?.[0]?.text ?? "").startsWith("SPAWN_CONTEXT_R11"),
      retResend,
    );
  }

  db.close();
}

/* ================================================================== *
 * 6. EXECUÇÃO — dist (artefato real) e src (fonte real)
 * ================================================================== */
const distMods = await import(HARNESS);
check("dist expõe a API comportamental necessária", REQUIRED_SYMBOLS.every((s) => distMods[s] !== undefined));
await runBehavior("dist", distMods);

const srcMods = {
  ...(await import(`${SRC_COPY}/hooks.ts`)),
  ...(await import(`${SRC_COPY}/tools/team-message.ts`)),
  ...(await import(`${SRC_COPY}/tools/team-broadcast.ts`)),
  ...(await import(`${SRC_COPY}/tools/shared.ts`)),
  ...(await import(`${SRC_COPY}/recovery.ts`)),
  ...(await import(`${SRC_COPY}/db.ts`)),
  ...(await import(`${SRC_COPY}/state.ts`)),
  ...(await import(`${SRC_COPY}/progress.ts`)),
  ...(await import(`${SRC_COPY}/config.ts`)),
  MIGRATIONS: (await import(`${SRC_COPY}/schema.ts`)).MIGRATIONS,
};
check("src carrega a API comportamental necessária", REQUIRED_SYMBOLS.every((s) => srcMods[s] !== undefined));
await runBehavior("src", srcMods);

/* ================================================================== *
 * 7. VEREDITO
 * ================================================================== */
const failed = results.filter(([, ok]) => !ok);
console.log(`\nRESULT: ${results.length - failed.length}/${results.length} checks passed`);
if (failed.length) {
  console.log("FALHAS:");
  for (const [name] of failed) console.log(`  - ${name}`);
}
process.exit(failed.length ? 1 : 0);
