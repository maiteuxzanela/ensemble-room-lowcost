#!/usr/bin/env node
/**
 * QUALITY GATE DETERMINÍSTICO — WAKE CIENTE DE MODELO (T8: fixes F1 + F2)
 * @maiteuxzanela/ensemble-room-lowcost
 *
 * Sob teste (código REAL, sem mocks de decisão):
 *   - [F1] src/tools/team-tasks-complete.ts — o wake 'board-complete' (sob
 *     silentLead:true é o ÚNICO caminho que acorda o lead) agora é
 *     model-aware: `promptModelAwareWake` com agent explícito de
 *     `team.lead_agent` + escada `resolveFallbackChainForAgent(config,
 *     leadAgent)` com STEP-DOWN em rejeição. Prova de causalidade: com
 *     config → payload COM `model`; sem config (contraste legado) → payload
 *     SEM `model` (assinatura retrocompatível, nunca quebrada).
 *   - [F2] src/watchdog.ts — o wrapper `notifyLead` repassa `{ config }`
 *     (stall / chatty / timeout acordam o lead na escada model-aware);
 *     Watchdog construído SEM config degrada para o wake legado modelless.
 *   - [F2] src/tools/team-spawn.ts — o rollback de spawn falho chama
 *     `notifyLead(..., { config: deps.config })`.
 *   - src/notify.ts — `promptModelAwareWake` (escada deduplicada +
 *     step-down) e `notifyLead` (persistência prévia + agent de
 *     team.lead_agent).
 *
 * Único ponto de emenda do dist: cláusulas de export anexadas à cópia do
 * bundle (padrão homologado em test_silent_lead_board_wake.mjs). O único
 * "client" injetado é o TRANSPORT RECORDER (promptAsync / abort /
 * session.create / showToast capturados; falha de transporte injetável
 * via fail-once por sessionID — caminho de erro real, não stub de lógica).
 * Bancos são SQLite REAIS (node:sqlite) com TODAS as migrations; o config é
 * DEFAULT_CONFIG espelhado em disco em memória (nenhum arquivo lido).
 *
 * Cobertura do ticket T8:
 *   (a) wake 'board-complete' recebe `agent` do lead + `model` da cadeia
 *       (fallbackModelsByAgent.dante) com step-down — NÃO é mais modelless;
 *   (b) call sites notifyLead de watchdog.ts e team-spawn.ts passam
 *       `config` (escada ativa) — paridade estática src↔dist + provas
 *       comportamentais com e sem config.
 *
 * Uso:  node tests/test_model_aware_wakes.mjs
 * Exit: 0 = todos os checks PASS; 1 = há FAIL.
 */

import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";

// Pacote sob teste: a raiz deste repositório (src/ + dist/ locais).
const REPO = path.resolve(import.meta.dirname, "..");
const PKG = process.env.ENSEMBLE_PKG || REPO;
const DIST = path.join(PKG, "dist/index.js");
const SRC = path.join(PKG, "src");
// Scratch isolado, recriado a cada execução e coberto pelo .gitignore.
const TMP = path.join(REPO, ".test-scratch");
mkdirSync(TMP, { recursive: true });

const HARNESS = path.join(TMP, "_model_aware_wakes_harness.mjs");
const SRC_COPY = path.join(TMP, "ensemble_src_model_aware_wakes");
const ROOT = path.join(TMP, "maw_suite");

const results = [];
const check = (name, ok, detail) => {
  results.push([name, ok]);
  console.log(`${ok ? "PASS" : "FAIL"} | ${name}${detail ? " | " + detail : ""}`);
};
const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);

// Rejeições não tratadas são falha de homologação: todos os wakes e
// rollbacks desta suíte têm fail-safe .catch obrigatório.
const unhandled = [];
process.on("unhandledRejection", (e) => unhandled.push(e));

/** Flush de microtasks + macrotasks — os wakes são fire-and-forget. */
const tick = async (n = 5) => {
  for (let i = 0; i < n; i++) await new Promise((r) => setImmediate(r));
};

/** Roda `fn` com HOME isolado (a sonda de compaction lê o store real). */
async function withHome(root, fn) {
  const prev = process.env.HOME;
  process.env.HOME = root;
  try {
    return await fn();
  } finally {
    process.env.HOME = prev;
  }
}

/* ================================================================== *
 * 0. SINTAXE — node --check dist/index.js (exit 0)                   *
 * ================================================================== */
{
  const r = spawnSync(process.execPath, ["--check", DIST], { encoding: "utf8" });
  check(
    "F) node --check dist/index.js → exit 0",
    r.status === 0,
    `status=${r.status}${r.stderr ? " stderr=" + r.stderr.trim().slice(0, 200) : ""}`,
  );
}

/* ================================================================== *
 * 1. HARNESS DO DIST — bundle real + cláusulas de export anexadas    *
 * ================================================================== */
const REQUIRED_SYMBOLS = [
  "executeTeamTasksComplete", "executeTeamSpawn", "Watchdog", "ProgressTracker",
  "createDb", "MemberRegistry", "DEFAULT_CONFIG", "MIGRATIONS",
  "resolveFallbackChainForAgent",
];
const distRaw = readFileSync(DIST, "utf8");
{
  const missing = REQUIRED_SYMBOLS.filter(
    (s) => !new RegExp(`(function|class|var|const|let)\\s+${s}\\b`).test(distRaw),
  );
  check(
    "dist declara todos os símbolos exigidos pela suíte",
    missing.length === 0,
    missing.join(",") || REQUIRED_SYMBOLS.length + " símbolos",
  );

  const existingExport = distRaw.match(/export\s*\{([^}]*)\}\s*;?\s*$/)?.[1] ?? "";
  const already = new Set(
    existingExport.split(",").map((s) => s.trim().split(/\s+as\s+/).pop()).filter(Boolean),
  );
  const need = REQUIRED_SYMBOLS.filter((s) => !already.has(s));
  const EXPORT_APPEND = need.length ? `\nexport { ${need.join(", ")} };\n` : "";
  writeFileSync(HARNESS, distRaw + EXPORT_APPEND);
  check(
    "harness do dist = bundle byte-a-byte + apenas cláusulas de export anexadas (sem duplicatas)",
    readFileSync(HARNESS, "utf8") === distRaw + EXPORT_APPEND,
    `${distRaw.length} bytes; anexados=[${need.join(",")}]`,
  );
}

/* ================================================================== *
 * 2. CÓPIA DO SRC (type-stripping do Node recusa node_modules)       *
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
check("cópia do src preparada (só resolução de extensão de import, lógica intacta)", prepareSrcCopy() > 0);

/* ================================================================== *
 * 3. PARIDADE src ↔ dist dos marcadores F1/F2                        *
 * ================================================================== */
function readSrc(rel) {
  return readFileSync(path.join(SRC, rel), "utf8");
}
const srcComplete = readSrc("tools/team-tasks-complete.ts");
const srcWatchdog = readSrc("watchdog.ts");
const srcSpawn = readSrc("tools/team-spawn.ts");
const srcNotify = readSrc("notify.ts");

function marker(label, needle, { src = true, dist = true } = {}) {
  const hit = (text) => (needle instanceof RegExp ? needle.test(text) : text.includes(needle));
  const srcHit = src ? hit(srcAll()) : true;
  const distHit = dist ? hit(distRaw) : true;
  check(`paridade src↔dist: ${label}`, srcHit && distHit, `src=${srcHit} dist=${distHit}`);
}
// Concatenação dos 4 arquivos-fonte do escopo para marcadores que podem
// aparecer em qualquer um deles (evita falsos negativos por arquivo).
const srcAll = () => [srcComplete, srcWatchdog, srcSpawn, srcNotify].join("\n");

/* --- F1: wake 'board-complete' soberano (modelless e agentless) --- */
{
  // O wake do board dispara promptAsync neutro direto para a sessão do lead,
  // sem forçar model ou agent (preserva o modelo soberano da sessão do Dante).
  const f1Wake = /deps\.client\.session\.promptAsync\(\{[\s\S]{0,150}sessionID: leadSessionId,[\s\S]{0,150}synthetic: true/;
  check("paridade F1 (src): wake do board dispara promptAsync neutro para leadSessionId", f1Wake.test(srcComplete), srcComplete.match(f1Wake)?.[0]?.slice(0, 120) ?? "ausente");
  check("paridade F1 (dist): wake do board dispara promptAsync neutro para leadSessionId", f1Wake.test(distRaw), distRaw.match(f1Wake)?.[0]?.slice(0, 120) ?? "ausente");
  marker("F1: guard do fechamento de board (total > 0 && completed === total)", /total\d* > 0 && completed === total\d*/);
  marker("F1: texto sintético do wake do board", "[System: All team tasks completed on board by ${who}]");

  // O helper compartilhado constrói a escada por-agente.
  marker("notify: promptModelAwareWake usa resolveFallbackChainForAgent(config, agent)", "resolveFallbackChainForAgent(config, agent)");
  marker("notify: notifyLead lê agent de team.lead_agent (resolveLeadWakeContext)", "SELECT lead_session_id, lead_agent FROM team WHERE id = ?");
  marker("notify: texto de wake do notifyLead", "[System: New team message from system]");
}

/* --- F2: watchdog.ts threads config no wrapper --- */
{
  check(
    "paridade F2 (src): WatchdogOpts declara config?: Required<EnsembleConfig>",
    srcWatchdog.includes("config?: Required<EnsembleConfig>"),
  );
  marker("F2: construtor do Watchdog persiste opts.config", "this.config = opts.config");
  check(
    "paridade F2 (src): wrapper notifyLead repassa { config } condicionalmente",
    /this\.config \? \{ config: this\.config \} : undefined/.test(srcWatchdog),
  );
  check(
    "paridade F2 (dist): wrapper notifyLead repassa { config } condicionalmente",
    /this\.config \? \{ config: this\.config \} : void 0/.test(distRaw),
  );
  const countCalls = (text) => (text.match(/this\.notifyLead\(/g) ?? []).length;
  check(
    "paridade F2: exatamente 3 call sites this.notifyLead( (stall, chatty, timeout)",
    countCalls(srcWatchdog) === 3 && countCalls(distRaw) === 3,
    `src=${countCalls(srcWatchdog)} dist=${countCalls(distRaw)}`,
  );
}

/* --- F2: team-spawn.ts threads config no rollback --- */
{
  const spawnCfg = /failed to start and was removed[\s\S]{0,600}\{ config: deps\.config \}/;
  check("paridade F2 (src): rollback de spawn repassa { config: deps.config }", spawnCfg.test(srcSpawn), srcSpawn.match(spawnCfg)?.[0]?.slice(0, 100) ?? "ausente");
  check("paridade F2 (dist): rollback de spawn repassa { config: deps.config }", spawnCfg.test(distRaw), distRaw.match(spawnCfg)?.[0]?.slice(0, 100) ?? "ausente");
}

/* ================================================================== *
 * 4. ANTI-MOCK (fail-fast) — src copiado + bundle                     *
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
  check("F) zero primitivas de mock no bundle", !/MagicMock|jest\.mock|sinon\.|vi\.mock/.test(distRaw));
}

/* ================================================================== *
 * 5. FIXTURES — SQLite REAL, transport recorder, cenários             *
 * ================================================================== */

/**
 * Transport recorder — mesmo seam homologado em test_silent_lead_board_wake.mjs,
 * com fail-once por sessionID: a PRIMEIRA chamada para a sessão listada em
 * `failOnce` rejeita (caminho de erro real de transporte) e as seguintes
 * entregam — é o que permite provar o STEP-DOWN da escada (1º degrau
 * rejeitado → 2º degrau entregue) sem mockar lógica nenhuma.
 */
function makeClient(calls, failOnce = new Set()) {
  return {
    session: {
      create: async (o) => {
        calls.sessionCreate.push(o);
        return { data: { id: `ses_child_${calls.sessionCreate.length}` } };
      },
      promptAsync: async (o) => {
        calls.promptAsync.push(o);
        if (failOnce.delete(o.sessionID)) throw new Error("injected transport failure (fail-once)");
        return {};
      },
      abort: async (o) => {
        calls.abort.push(o);
        return {};
      },
    },
    tui: {
      showToast: async (o) => {
        calls.toast.push(o);
        return {};
      },
      selectSession: async () => ({}),
    },
  };
}
const newCalls = () => ({ sessionCreate: [], promptAsync: [], abort: [], toast: [] });

// Cadeias de referência do cenário (fixture em memória, nunca lida de disco).
const DANTE1 = { providerID: "prov", modelID: "dante-1", variant: "low" };
const DANTE2 = { providerID: "prov", modelID: "dante-2" };
const GLOBAL1 = { providerID: "prov", modelID: "global-1", variant: "low" };

async function runBehavior(label, mods) {
  const {
    executeTeamTasksComplete, executeTeamSpawn, Watchdog, ProgressTracker,
    createDb, MemberRegistry, DEFAULT_CONFIG, MIGRATIONS, resolveFallbackChainForAgent,
  } = mods;

  check(
    `[${label}] API comportamental carregada (tasks-complete, spawn, watchdog, tracker, db, config)`,
    [executeTeamTasksComplete, executeTeamSpawn, Watchdog, ProgressTracker, createDb, MemberRegistry, DEFAULT_CONFIG, resolveFallbackChainForAgent]
      .every((x) => x !== undefined),
  );
  const migrationsLen = MIGRATIONS?.length ?? 0;
  check(`[${label}] MIGRATIONS extraído (${migrationsLen} migrations)`, migrationsLen >= 11, `len=${migrationsLen}`);

  // Config fixture: cadeia POR-AGENTE para o lead 'dante' + cadeia global.
  const CFG = {
    ...DEFAULT_CONFIG,
    fallbackModels: ["prov/global-1#low"],
    fallbackModelsByAgent: { dante: ["prov/dante-1#low", "prov/dante-2"] },
  };
  check(
    `[${label}] sanity: resolveFallbackChainForAgent(CFG,'dante') = [dante-1#low, dante-2]`,
    eq(resolveFallbackChainForAgent(CFG, "dante"), [{ model: "prov/dante-1", variant: "low" }, { model: "prov/dante-2" }]),
    JSON.stringify(resolveFallbackChainForAgent(CFG, "dante")),
  );
  check(
    `[${label}] sanity: cadeia global = [global-1#low]`,
    eq(resolveFallbackChainForAgent(CFG, undefined), [{ model: "prov/global-1", variant: "low" }]),
    JSON.stringify(resolveFallbackChainForAgent(CFG, undefined)),
  );
  check(
    `[${label}] invariante: DEFAULT_CONFIG nunca resolve cadeia vazia (modelFallback)`,
    (resolveFallbackChainForAgent(DEFAULT_CONFIG, "dante") ?? []).length > 0,
    JSON.stringify(resolveFallbackChainForAgent(DEFAULT_CONFIG, "dante")),
  );

  /* --- Bundles de cenário: DB + registry + recorder + deps isolados --- */
  function scenario(name) {
    const root = path.join(ROOT, `${label}_${name}`);
    rmSync(root, { recursive: true, force: true });
    mkdirSync(root, { recursive: true });
    const db = createDb(path.join(root, "ensemble.db"));
    const registry = new MemberRegistry();
    const calls = newCalls();
    const failOnce = new Set();
    const client = makeClient(calls, failOnce);
    const progressTracker = new ProgressTracker();
    const deps = (config) => ({
      db, registry, tracker: {}, purgeApprovals: {}, client,
      directory: root, config, progressTracker,
    });
    const leadWakes = (lead, from = 0) =>
      calls.promptAsync.slice(from).filter((c) => c.sessionID === lead);
    return { root, db, registry, calls, failOnce, client, progressTracker, deps, leadWakes, close: () => db.close() };
  }

  const seedTeam = (db, id, leadSession, leadAgent = "dante") =>
    db.run(
      "INSERT INTO team (id, name, project_id, lead_session_id, status, delegate, time_created, time_updated, lead_agent) VALUES (?,?,?,?,?,?,?,?,?)",
      [id, `name-${id}`, "default", leadSession, "active", 0, Date.now(), Date.now(), leadAgent],
    );
  const seedMember = (db, team, name, sess, { agent = "build", status = "ready", exec = "idle", time = Date.now() } = {}) =>
    db.run(
      `INSERT INTO team_member (team_id, name, session_id, agent, status, execution_status, time_created, time_updated)
       VALUES (?,?,?,?,?,?,?,?)`,
      [team, name, sess, agent, status, exec, time, time],
    );
  const seedTask = (db, id, team, status, assignee, dependsOn = null) =>
    db.run(
      "INSERT INTO team_task (id, team_id, content, status, priority, assignee, depends_on, time_created, time_updated) VALUES (?,?,?,?,?,?,?,?,?)",
      [id, team, `task ${id}`, status, "medium", assignee, dependsOn, Date.now(), Date.now()],
    );
  const expectWake = (who) => `[System: All team tasks completed on board by ${who}]`;

  /* ================================================================ *
   * A) [F1] Wake 'board-complete' soberano (modelless e agentless)     *
   * ================================================================ */
  const A = scenario("f1_board");
  {
    const LEAD = "ses_f1a_lead";
    const M1 = "f1-member";
    const MS = "ses_f1a_member";
    seedTeam(A.db, "team_f1a", LEAD, "dante");
    seedMember(A.db, "team_f1a", M1, MS);
    A.registry.register("team_f1a", M1, MS);
    seedTask(A.db, "t_f1a_1", "team_f1a", "pending", M1);
    seedTask(A.db, "t_f1a_2", "team_f1a", "pending", M1);

    let base = A.calls.promptAsync.length;
    await executeTeamTasksComplete(A.deps(CFG), { task_id: "t_f1a_1" }, MS);
    await tick();
    const pre = A.leadWakes(LEAD, base);
    check(
      `[${label}] A1 board incompleto (1/2): NENHUM wake do lead`,
      pre.length === 0,
      `leadWakes=${pre.length} total=${A.calls.promptAsync.length - base}`,
    );

    base = A.calls.promptAsync.length;
    await executeTeamTasksComplete(A.deps(CFG), { task_id: "t_f1a_2" }, MS);
    await tick();
    const wakes = A.leadWakes(LEAD, base);
    check(`[${label}] A2 board fechado (2/2): wake do lead EXATAMENTE 1x`, wakes.length === 1, `delta=${wakes.length}`);
    const w = wakes[0];
    check(`[${label}] A3 wake soberano: sem chave 'model' (modelless)`, w !== undefined && !("model" in w), w ? Object.keys(w).join(",") : "sem wake");
    check(`[${label}] A4 wake soberano: sem chave 'agent' (agentless)`, w !== undefined && !("agent" in w), w ? Object.keys(w).join(",") : "sem wake");
    check(
      `[${label}] A5 wake é synthetic:true com texto exato do board`,
      w?.synthetic === true && w?.parts?.[0]?.text === expectWake(M1),
      JSON.stringify(w?.parts?.[0]?.text),
    );
    check(
      `[${label}] A6 toast de progresso do board dispara "2/2 tasks complete"`,
      A.calls.toast.some((t) => String(t.message).includes("2/2 tasks complete")),
      JSON.stringify(A.calls.toast.map((t) => t.message)),
    );
  }
  A.close();

  /* ================================================================ *
   * B) [F2] watchdog.ts — wrapper notifyLead com config               *
   * ================================================================ */

  /* --- B1: timeout COM config → escada ativa --- */
  {
    const f = scenario("f2_wd_timeout_cfg");
    const LEAD = "ses_wd1_lead";
    seedTeam(f.db, "team_wd1", LEAD, "dante");
    seedMember(f.db, "team_wd1", "wd1", "ses_wd1_m1", { status: "busy", exec: "running", time: Date.now() - 600_000 });

    const wd = new Watchdog({
      db: f.db, client: f.client, registry: f.registry,
      ttlMs: 60_000, progressTracker: f.progressTracker,
      stallThresholdMs: 0, peerMessageLimit: 0, roomInactivityThresholdMs: 0,
      config: CFG,
      // cwd omitido → preserveBranch fora de jogo (nenhum worktree no fixture)
    });
    const base = f.calls.promptAsync.length;
    await withHome(f.root, () => wd.check());
    await tick();
    const wakes = f.leadWakes(LEAD, base);
    check(`[${label}] B1 timeout COM config: wake do lead EXATAMENTE 1x`, wakes.length === 1, `delta=${wakes.length}`);
    check(`[${label}] B2 timeout: agent 'dante' explícito`, wakes[0]?.agent === "dante", String(wakes[0]?.agent));
    check(`[${label}] B3 timeout: model da cadeia dante (escada ativa)`, eq(wakes[0]?.model, DANTE1), JSON.stringify(wakes[0]?.model));
    check(
      `[${label}] B4 timeout: texto de wake do notifyLead + synthetic`,
      wakes[0]?.parts?.[0]?.text === "[System: New team message from system]" && wakes[0]?.synthetic === true,
      JSON.stringify(wakes[0]?.parts?.[0]?.text),
    );
    const row = f.db.query("SELECT status, execution_status FROM team_member WHERE team_id=? AND name=?").get("team_wd1", "wd1");
    check(
      `[${label}] B5 membro transiciona error/timed_out`,
      row?.status === "error" && row?.execution_status === "timed_out",
      `${row?.status}/${row?.execution_status}`,
    );
    check(`[${label}] B6 session.abort disparado contra o membro`, f.calls.abort.some((a) => a.sessionID === "ses_wd1_m1"), JSON.stringify(f.calls.abort.map((a) => a.sessionID)));
    const sys = f.db.query("SELECT content FROM team_message WHERE team_id=? AND from_name='system'").all("team_wd1");
    check(`[${label}] B7 mensagem 'timed out' persistida para o lead`, sys.some((m) => m.content.includes("timed out")), sys[0]?.content.slice(0, 60) ?? "(vazia)");
    check(`[${label}] B8 toast de timeout disparado`, f.calls.toast.some((t) => String(t.message).includes("timed out")), `toast=${f.calls.toast.length}`);
    f.close();
  }

  /* --- B2: timeout SEM config → wake legado modelless (contraste) --- */
  {
    const f = scenario("f2_wd_timeout_nocfg");
    const LEAD = "ses_wd2_lead";
    seedTeam(f.db, "team_wd2", LEAD, "dante");
    seedMember(f.db, "team_wd2", "wd2", "ses_wd2_m1", { status: "busy", exec: "running", time: Date.now() - 600_000 });

    const wd = new Watchdog({
      db: f.db, client: f.client, registry: f.registry,
      ttlMs: 60_000, progressTracker: f.progressTracker,
      stallThresholdMs: 0, peerMessageLimit: 0, roomInactivityThresholdMs: 0,
      // config OMITIDO — degrada para o wake legado (assinatura retrocompatível)
    });
    const base = f.calls.promptAsync.length;
    await withHome(f.root, () => wd.check());
    await tick();
    const wakes = f.leadWakes(LEAD, base);
    check(`[${label}] B9 timeout SEM config: wake do lead 1x`, wakes.length === 1, `delta=${wakes.length}`);
    check(
      `[${label}] B10 contraste: SEM config o wake é modelless (sem chave 'model'), agent segue explícito`,
      wakes.length === 1 && !("model" in wakes[0]) && wakes[0]?.agent === "dante",
      wakes[0] ? JSON.stringify({ model: "model" in wakes[0] ? wakes[0].model : "(ausente)", agent: wakes[0].agent }) : "sem wake",
    );
    f.close();
  }

  /* --- B3: stall COM config → notifyLead model-aware + nudge ao membro --- */
  {
    const f = scenario("f2_stall_cfg");
    const LEAD = "ses_st1_lead";
    seedTeam(f.db, "team_st1", LEAD, "dante");
    seedMember(f.db, "team_st1", "st1", "ses_st1_m1", { status: "busy", exec: "running" });
    for (let i = 0; i < 3; i++) f.progressTracker.recordStep("ses_st1_m1", 0); // 3 steps < 500 tokens

    const wd = new Watchdog({
      db: f.db, client: f.client, registry: f.registry,
      ttlMs: 0, progressTracker: f.progressTracker,
      stallThresholdMs: 300_000, stallMinSteps: 3, stallTokenThreshold: 500,
      peerMessageLimit: 0, roomInactivityThresholdMs: 0,
      config: CFG,
    });
    const base = f.calls.promptAsync.length;
    await wd.checkStalled();
    await tick();
    const wakes = f.leadWakes(LEAD, base);
    check(`[${label}] B11 stall COM config: wake do lead 1x`, wakes.length === 1, `delta=${wakes.length}`);
    check(`[${label}] B12 stall: agent 'dante' + model dante-1#low no wake`, wakes[0]?.agent === "dante" && eq(wakes[0]?.model, DANTE1), JSON.stringify({ agent: wakes[0]?.agent, model: wakes[0]?.model }));
    const nudges = f.calls.promptAsync.slice(base).filter((c) => c.sessionID === "ses_st1_m1");
    check(`[${label}] B13 stall: nudge ao membro disparado 1x`, nudges.length === 1, `nudges=${nudges.length}`);
    const nudged = f.db.query("SELECT last_nudged_at FROM team_member WHERE team_id=? AND name=?").get("team_st1", "st1");
    check(`[${label}] B14 stall: last_nudged_at persistido`, typeof nudged?.last_nudged_at === "number" && nudged.last_nudged_at > 0, String(nudged?.last_nudged_at));
    const sys = f.db.query("SELECT content FROM team_message WHERE team_id=? AND from_name='system'").all("team_st1");
    check(`[${label}] B15 stall: mensagem 'appears stalled' persistida`, sys.some((m) => m.content.includes("appears stalled")), sys[0]?.content.slice(0, 60) ?? "(vazia)");
    f.close();
  }

  /* --- B4: chatty COM config → notifyLead model-aware + nudge --- */
  {
    const f = scenario("f2_chatty_cfg");
    const LEAD = "ses_ct1_lead";
    seedTeam(f.db, "team_ct1", LEAD, "dante");
    seedMember(f.db, "team_ct1", "ct1", "ses_ct1_m1", { status: "busy", exec: "running" });
    f.progressTracker.recordPeerMessage("ses_ct1_m1");
    f.progressTracker.recordPeerMessage("ses_ct1_m1");

    const wd = new Watchdog({
      db: f.db, client: f.client, registry: f.registry,
      ttlMs: 0, progressTracker: f.progressTracker,
      stallThresholdMs: 0, peerMessageLimit: 2, peerMessageWindowMs: 300_000,
      roomInactivityThresholdMs: 0,
      config: CFG,
    });
    const base = f.calls.promptAsync.length;
    await wd.checkChatty();
    await tick();
    const wakes = f.leadWakes(LEAD, base);
    check(`[${label}] B16 chatty COM config: wake do lead 1x`, wakes.length === 1, `delta=${wakes.length}`);
    check(`[${label}] B17 chatty: agent 'dante' + model dante-1#low no wake`, wakes[0]?.agent === "dante" && eq(wakes[0]?.model, DANTE1), JSON.stringify({ agent: wakes[0]?.agent, model: wakes[0]?.model }));
    const nudges = f.calls.promptAsync.slice(base).filter((c) => c.sessionID === "ses_ct1_m1");
    check(`[${label}] B18 chatty: nudge ao membro disparado 1x`, nudges.length === 1, `nudges=${nudges.length}`);
    const sys = f.db.query("SELECT content FROM team_message WHERE team_id=? AND from_name='system'").all("team_ct1");
    check(`[${label}] B19 chatty: mensagem 'many peer messages' persistida`, sys.some((m) => m.content.includes("many peer messages")), sys[0]?.content.slice(0, 60) ?? "(vazia)");
    // Idempotência: markChattyReported já consumiu a janela → 2ª passada não re-fire.
    const before2 = f.calls.promptAsync.length;
    await wd.checkChatty();
    await tick();
    check(`[${label}] B20 chatty idempotente: 2ª passada sem novos prompts`, f.calls.promptAsync.length === before2, `delta=${f.calls.promptAsync.length - before2}`);
    f.close();
  }

  /* ================================================================ *
   * C) [F2] team-spawn.ts — rollback com config → wake model-aware    *
   * ================================================================ */
  {
    const f = scenario("f2_spawn");
    const LEAD = "ses_sp1_lead";
    seedTeam(f.db, "team_sp1", LEAD, "dante");
    f.failOnce.add("ses_child_1"); // 1ª promptAsync da sessão filha rejeita → rollback

    const base = f.calls.promptAsync.length;
    const baseSys = f.db.query("SELECT COUNT(*) c FROM team_message WHERE team_id=? AND from_name='system'").get("team_sp1").c;
    const ret = await executeTeamSpawn(
      f.deps(CFG),
      { name: "sp1", agent: "build", prompt: "trabalhar no fix T8", worktree: false },
      LEAD,
    );
    await tick();

    check(`[${label}] C1 spawn retorna 'spawned' (fire-and-forget armado)`, /spawned/.test(ret), ret.slice(0, 80));
    const row = f.db.query("SELECT * FROM team_member WHERE team_id=? AND name=?").get("team_sp1", "sp1");
    check(`[${label}] C2 rollback: membro REMOVIDO do SQLite`, row === undefined || row === null, row ? `status=${row.status}` : "removido");
    check(
      `[${label}] C3 rollback: registry sem resíduo da sessão filha`,
      f.registry.getBySession("ses_child_1") === undefined,
      String(f.registry.getBySession("ses_child_1")?.memberName),
    );
    const wakes = f.leadWakes(LEAD, base);
    check(`[${label}] C4 rollback COM config: wake model-aware do lead 1x`, wakes.length === 1, `delta=${wakes.length}`);
    check(
      `[${label}] C5 wake com agent 'dante' + model dante-1#low (escada ativa)`,
      wakes[0]?.agent === "dante" && eq(wakes[0]?.model, DANTE1),
      JSON.stringify({ agent: wakes[0]?.agent, model: wakes[0]?.model }),
    );
    const sys = f.db.query("SELECT content FROM team_message WHERE team_id=? AND from_name='system'").all("team_sp1");
    check(
      `[${label}] C6 mensagem 'failed to start and was removed' persistida para o lead`,
      sys.length > baseSys && sys.some((m) => m.content.includes("failed to start and was removed")),
      sys[0]?.content.slice(0, 80) ?? "(vazia)",
    );
    check(
      `[${label}] C7 toast de erro 'failed to start' disparado`,
      f.calls.toast.some((t) => String(t.message).includes("failed to start")),
      `toast=${f.calls.toast.length}`,
    );
    check(
      `[${label}] C8 sessão filha criada E abortada no rollback`,
      f.calls.sessionCreate.length === 1 && f.calls.abort.some((a) => a.sessionID === "ses_child_1"),
      `create=${f.calls.sessionCreate.length} aborts=${JSON.stringify(f.calls.abort.map((a) => a.sessionID))}`,
    );
    f.close();
  }
}

/* ================================================================== *
 * 6. EXECUÇÃO — dist (artefato real) e src (fonte real)              *
 * ================================================================== */
const distMods = await import(HARNESS);
check(
  "dist expõe a API comportamental necessária",
  REQUIRED_SYMBOLS.every((s) => distMods[s] !== undefined),
  REQUIRED_SYMBOLS.filter((s) => distMods[s] === undefined).join(",") || "ok",
);
await runBehavior("dist", distMods);

const srcMods = {
  ...(await import(`${SRC_COPY}/tools/team-tasks-complete.ts`)),
  ...(await import(`${SRC_COPY}/tools/team-spawn.ts`)),
  ...(await import(`${SRC_COPY}/watchdog.ts`)),
  ...(await import(`${SRC_COPY}/progress.ts`)),
  ...(await import(`${SRC_COPY}/db.ts`)),
  ...(await import(`${SRC_COPY}/state.ts`)),
  ...(await import(`${SRC_COPY}/config.ts`)),
  MIGRATIONS: (await import(`${SRC_COPY}/schema.ts`)).MIGRATIONS,
};
check(
  "src carrega a API comportamental necessária",
  ["executeTeamTasksComplete", "executeTeamSpawn", "Watchdog", "ProgressTracker", "createDb", "MemberRegistry", "DEFAULT_CONFIG", "resolveFallbackChainForAgent"]
    .every((s) => srcMods[s] !== undefined),
  ["executeTeamTasksComplete", "executeTeamSpawn", "Watchdog", "ProgressTracker", "createDb", "MemberRegistry", "DEFAULT_CONFIG", "resolveFallbackChainForAgent"]
    .filter((s) => srcMods[s] === undefined).join(",") || "ok",
);
await runBehavior("src", srcMods);

check("f) ZERO unhandledRejection ao longo de toda a suíte", unhandled.length === 0, `${unhandled.length}`);

/* ================================================================== *
 * 7. VEREDITO                                                        *
 * ================================================================== */
const failed = results.filter(([, ok]) => !ok);
console.log(`\nRESULT: ${results.length - failed.length}/${results.length} checks passed`);
if (failed.length) {
  console.log("FALHAS:");
  for (const [name] of failed) console.log(`  - ${name}`);
}
process.exit(failed.length ? 1 : 0);
