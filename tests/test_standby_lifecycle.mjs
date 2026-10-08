#!/usr/bin/env node
/**
 * QUALITY GATE DETERMINÍSTICO — Standby & Blindagem de Nudge/Fast-Idle
 * @hueyexe/opencode-ensemble@0.18.0
 *
 * Guardiã: Clara (Quality Gate). Time "fix-standby-nudge".
 *
 * Sob teste (código REAL, não simulado):
 *   - executeTeamSpawn      → src/tools/team-spawn.ts  e dist/index.js (src + dist).
 *   - executeTeamMessage    → src/tools/team-message.ts.
 *   - executeTeamBroadcast  → src/tools/team-broadcast.ts.
 *   - shouldNudgeIdleMember → src/hooks.ts.
 *   - fast-idle             → seam exportado (preferred) OU bloco extraído do bundle.
 *   - createDb/MIGRATIONS   → todas as migrations reais num SQLite real (node:sqlite).
 *
 * Único ponto de emenda: o TRANSPORTE DE SAÍDA (session.create / promptAsync /
 * abort / showToast) é gravado num array para que a asserção prove O QUE foi
 * chamado — exatamente o mesmo padrão já homologado em
 * tests/test_watchdog_heartbeat.mjs. Nenhuma lógica de decisão é
 * substituída: não há mock library, não há stub de banco, não há fixture falsa.
 * Os bancos são SQLite REAIS criados isoladamente em .test-scratch/.
 *
 * Uso:  node tests/test_standby_lifecycle.mjs
 * Exit: 0 = todos os checks PASS; 1 = há FAIL.
 */

import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

// Pacote sob teste: a raiz deste repositório (src/ + dist/ locais).
// ENSEMBLE_PKG permite apontar a suíte para outro checkout (ex.: o pacote
// publicado em ~/.cache/opencode/packages/...) sem editar o arquivo.
const REPO = path.resolve(import.meta.dirname, "..");
const PKG = process.env.ENSEMBLE_PKG || REPO;
const DIST = path.join(PKG, "dist/index.js");
const SRC = path.join(PKG, "src");
// Scratch isolado, recriado a cada execução e coberto pelo .gitignore.
const TMP = path.join(REPO, ".test-scratch");
mkdirSync(TMP, { recursive: true });
const HARNESS = path.join(TMP, "_standby_harness.mjs");
const SRC_COPY = path.join(TMP, "ensemble_src-standby");
const WATCHDOG_SUITE = path.join(import.meta.dirname, "test_watchdog_heartbeat.mjs");

const TEAM_ID = "team_sb";
const LEAD_SESSION = "ses_lead";
const ROOT = path.join(TMP, "standby_suite");

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
  check(
    "E) node --check dist/index.js → exit 0",
    r.status === 0,
    `status=${r.status}${r.stderr ? " stderr=" + r.stderr.trim().slice(0, 200) : ""}`,
  );
}

/* ================================================================== *
 * 1. HARNESS DO DIST — bundle real + cláusulas de export anexadas
 * ================================================================== */
const REQUIRED_SYMBOLS = [
  "executeTeamSpawn", "executeTeamMessage", "executeTeamBroadcast",
  "shouldNudgeIdleMember", "createDb", "MemberRegistry", "ProgressTracker",
  "DEFAULT_CONFIG", "notifyLead", "hasReportedCompletion", "handleSessionStatusEvent",
  "MIGRATIONS",
];
const distRaw = readFileSync(DIST, "utf8");
{
  const missing = REQUIRED_SYMBOLS.filter((s) => !new RegExp(`(function|class|var|const|let)\\s+${s}\\b`).test(distRaw));
  check("dist declara todos os símbolos exigidos pela suíte", missing.length === 0, missing.join(",") || REQUIRED_SYMBOLS.length + " símbolos");

  // O bundle pode já trazer uma cláusula de export anexada pelo próprio plugin
  // (ex.: shouldNudgeIdleMember/shouldAlarmFastIdle). Deduplicamos para não
  // gerar "Duplicate export".
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
    `${distRaw.length} bytes; exports já no bundle=[${[...already].join(",")}]; anexados=[${need.join(",")}]`,
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

const srcSpawn = readSrc("tools/team-spawn.ts");
const srcMsg = readSrc("tools/team-message.ts");
const srcBc = readSrc("tools/team-broadcast.ts");
const srcShared = readSrc("tools/shared.ts");
const srcHooks = readSrc("hooks.ts");
const srcIndex = readSrc("index.ts");
const srcSchema = readSrc("schema.ts");
const srcV2Tools = readSrc("v2-tools.ts");

const srcBundleAll = [srcSpawn, srcMsg, srcBc, srcShared, srcHooks, srcIndex, srcSchema, srcV2Tools].join("\n");
function marker(label, srcText, needle) {
  const srcHit = needle instanceof RegExp ? needle.test(srcText) : srcText.includes(needle);
  const distHit = needle instanceof RegExp ? needle.test(distRaw) : distRaw.includes(needle);
  check(`paridade src↔dist: ${label}`, srcHit && distHit, `src=${srcHit} dist=${distHit}`);
}
marker("literal 'standby' no spawn", srcSpawn, /['"`]standby['"`]/);
marker("coluna spawn_context escrita no spawn", srcSpawn, "spawn_context");
marker("'standby' na blindagem de nudge (hooks.ts)", srcHooks, /['"`]standby['"`]/);
marker("'standby' no gatilho fast-idle (index.ts)", srcIndex, /['"`]standby['"`]/);
{
  const wakeSrc = srcBundleAll.match(/execution_status\s*=\s*['"]starting['"]/)?.[0];
  const wakeDist = distRaw.match(/execution_status\s*=\s*['"]starting['"]/)?.[0];
  check(
    "paridade src↔dist: UPDATE execution_status='starting' no despertar",
    !!wakeSrc && !!wakeDist && wakeSrc.replace(/"/g, "'") === wakeDist.replace(/"/g, "'"),
    `${wakeSrc ?? "src:ausente"} / ${wakeDist ?? "dist:ausente"}`,
  );
}
{
  const schemaTool = /standby/.test(srcIndex) && /standby/.test(srcV2Tools);
  check("paridade src↔dist: schema da tool team_spawn expõe `standby` (index.ts + v2-tools.ts)", schemaTool && /standby/.test(distRaw));
}
check(
  "Migration 11 (spawn_context) preservada em src E dist",
  srcSchema.includes("ADD COLUMN spawn_context") && distRaw.includes("ADD COLUMN spawn_context"),
);
{
  const core = readSrc("dashboard-js-core.ts");
  const render = readSrc("dashboard-js-render.ts");
  check(
    "paridade src↔dist: badge violeta 'standby' no dashboard (dashboard-js-core)",
    /standby/.test(core) && /violet/i.test(core) && /standby/.test(distRaw) && /violet/i.test(distRaw),
  );
  // O render delega a resolução para si()/sx() do core (não hardcodeia 'standby').
  const siCallSites = (render.match(/si\(m\.status\s*,\s*m\.executionStatus\)/g) ?? []).length;
  const sxCallSites = (render.match(/sx\(m\)/g) ?? []).length;
  check(
    "paridade src↔dist: render passa status+executionStatus para si() (2 call sites)",
    siCallSites >= 2,
    `siCallSites=${siCallSites}`,
  );
  check(
    "paridade src↔dist: render usa sx(m) para a cor do chip (2 call sites)",
    sxCallSites >= 2,
    `sxCallSites=${sxCallSites}`,
  );
  check(
    "paridade src↔dist: si()/sx() definidos no core e presentes no bundle",
    /constsi=\(s,es\)/.test(core.replace(/\s+/g, "")) && /constsx=\(m\)/.test(core.replace(/\s+/g, "")) && /const si=/.test(distRaw) && /const sx=/.test(distRaw),
  );
}
{
  const mig12Src = /Migration\s*12/i.test(srcSchema) && /'standby'/.test(srcSchema);
  const checks = distRaw.match(/CHECK\(execution_status IN \([^)]*\)\)/g) ?? [];
  const mig12Dist = checks.some((c) => c.includes("'standby'"));
  check(
    "Migration 12 estende o CHECK de execution_status com 'standby' (rebuild da tabela)",
    mig12Src && mig12Dist,
    `src=${mig12Src} dist=${mig12Dist} (${checks.length} CHECKs no bundle)`,
  );
}

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
  check(
    "F) zero primitivas de mock na área standby/nudge do bundle",
    !/MagicMock|jest\.mock|sinon\.|vi\.mock/.test(distRaw),
  );
}

/* ================================================================== *
 * 5. FIXTURES — SQLite REAL (node:sqlite), DB temporário isolado
 * ================================================================== */
function makeClient(calls, failFor = new Set()) {
  // Transporte de saída gravado. Nenhuma lógica de decisão é substituída.
  // `failFor` injeta FALHA de transporte (rejected promise) para os sessionIDs
  // listados — é o caminho de erro real, não um stub de lógica.
  return {
    session: {
      create: async (o) => { calls.sessionCreate.push(o); return { data: { id: `ses_child_${calls.sessionCreate.length}` } }; },
      promptAsync: async (o) => {
        calls.promptAsync.push(o);
        if (failFor.has(o.sessionID)) throw new Error("injected transport failure");
        return {};
      },
      abort: async (o) => { calls.abort.push(o); return {}; },
    },
    tui: {
      showToast: async (o) => { calls.toast.push(o); return {}; },
      selectSession: async () => ({}),
    },
    worktree: {
      create: async (o) => { calls.worktreeCreate.push(o); return { data: { name: "w", branch: "b", directory: "/tmp/w" } }; },
      remove: async () => ({}),
    },
    workspace: {
      create: async (o) => { calls.workspaceCreate.push(o); return { data: { id: "ws_1" } }; },
      remove: async () => ({}),
    },
  };
}
const newCalls = () => ({ sessionCreate: [], promptAsync: [], abort: [], toast: [], worktreeCreate: [], workspaceCreate: [] });

async function runBehavior(label, mods) {
  const { executeTeamSpawn, executeTeamMessage, executeTeamBroadcast, shouldNudgeIdleMember, createDb, MemberRegistry, ProgressTracker, DEFAULT_CONFIG } = mods;

  const root = `${ROOT}_${label}`;
  rmSync(root, { recursive: true, force: true });
  mkdirSync(root, { recursive: true });
  const db = createDb(path.join(root, "ensemble.db"));

  /* --- 5.1 schema real: migrations + integridade estrutural --- */
  const migrationsLen = mods.MIGRATIONS?.length ?? countMigrations(distRaw);
  check(`[${label}] MIGRATIONS extraído (${migrationsLen} migrations)`, migrationsLen >= 11, `len=${migrationsLen}`);
  const version = db.query("PRAGMA user_version").get().user_version;
  check(`[${label}] ensemble.db migra até user_version = MIGRATIONS.length (${migrationsLen})`, version === migrationsLen, `user_version=${version}`);

  const tableSql = db.query("SELECT sql FROM sqlite_master WHERE type='table' AND name='team_member'").get()?.sql ?? "";
  check(`[${label}] Migration 11: coluna spawn_context existe no schema real`, /spawn_context/i.test(tableSql));
  check(
    `[${label}] Migration 12: CHECK de execution_status aceita 'standby'`,
    /CHECK\(execution_status IN[\s\S]*'standby'/.test(tableSql.replace(/\s+/g, " ")),
    tableSql.replace(/\s+/g, " ").match(/CHECK\(execution_status IN \([^)]*\)\)/)?.[0]?.slice(0, 160) ?? "CHECK ausente",
  );
  {
    const info = db.query("PRAGMA table_info(team_member)").all().map((c) => c.name);
    const pk = db.query("PRAGMA table_info(team_member)").all().filter((c) => c.pk > 0).map((c) => c.name).sort().join(",");
    const idx = db.query("PRAGMA index_list(team_member)").all().map((i) => i.name).sort();
    const preserved = ["worktree_dir", "worktree_branch", "plan_approval", "workspace_id", "reported_to_lead", "last_nudged_at", "retry_until", "retry_attempt", "retry_provider", "retry_message", "spawn_context"];
    const missing = preserved.filter((c) => !info.includes(c));
    check(`[${label}] rebuild da Migration 12 preservou todas as colunas`, missing.length === 0, missing.join(",") || `${info.length} colunas`);
    check(`[${label}] rebuild manteve PK (team_id,name)`, pk === "name,team_id", `pk=${pk}`);
    check(
      `[${label}] rebuild recriou os índices de team_member`,
      idx.includes("team_member_session_idx") && idx.includes("team_member_status_idx"),
      idx.join(","),
    );
  }

  const now = Date.now();

  /* --- 5.2 UPGRADE DO DB DE PRODUÇÃO (cópia isolada) — v(N-1) → N --- *
   * A Migration 12 reconstrói team_member. Este check prova que aplicá-la
   * sobre uma CÓPIA do ensemble.db real (com dados de produção) não perde
   * nenhuma linha e resulta no mesmo schema de um DB criado do zero.      */
  {
    const PROD = path.join(process.env.HOME ?? "", ".config", "opencode", "ensemble.db");
    check(`[${label}] produção legível (fonte do teste de upgrade)`, existsSync(PROD), PROD);
    if (existsSync(PROD)) {
      const prodRo = new DatabaseSync(PROD, { readOnly: true });
      const COUNT_TABLES = ["team", "team_member", "team_task", "team_message"];
      const before = Object.fromEntries(COUNT_TABLES.map((t) => [t, prodRo.prepare(`SELECT COUNT(*) AS c FROM ${t}`).get().c]));
      const beforeVersion = prodRo.prepare("PRAGMA user_version").get().user_version;
      prodRo.close();

      const tmp = path.join(root, "prod_upgrade.db");
      rmSync(tmp, { force: true });
      cpSync(PROD, tmp);
      for (const side of ["-wal", "-shm"]) {
        if (existsSync(PROD + side)) cpSync(PROD + side, tmp + side, { force: true });
      }

      let afterVersion = -1;
      let after = {};
      let sqlAfter = "";
      let upErr = "";
      try {
        const up = createDb(tmp); // aplica as migrations pendantes de verdade
        afterVersion = up.query("PRAGMA user_version").get().user_version;
        after = Object.fromEntries(COUNT_TABLES.map((t) => [t, up.query(`SELECT COUNT(*) AS c FROM ${t}`).get().c]));
        sqlAfter = (up.query("SELECT sql FROM sqlite_master WHERE type='table' AND name='team_member'").get()?.sql ?? "").replace(/\s+/g, " ");
        up.close();
      } catch (e) {
        upErr = e instanceof Error ? e.message : String(e);
      }

      check(
        `[${label}] upgrade do DB de produção v${beforeVersion} → v${migrationsLen} sem erro`,
        !upErr && afterVersion === migrationsLen,
        upErr || `v${beforeVersion}→${afterVersion}`,
      );
      const lost = COUNT_TABLES.filter((t) => after[t] !== before[t]);
      check(
        `[${label}] upgrade preservou 100% das linhas reais (team/member/task/message)`,
        lost.length === 0,
        lost.length ? lost.map((t) => `${t}:${before[t]}→${after[t]}`).join(",") : `${before.team}/${before.team_member}/${before.team_task}/${before.team_message}`,
      );
      check(`[${label}] após o upgrade o CHECK de execution_status aceita 'standby'`, /CHECK\(execution_status IN \([^)]*'standby'/.test(sqlAfter));
      const idxAfter = (() => {
        const p2 = new DatabaseSync(tmp, { readOnly: true });
        const names = p2.prepare("PRAGMA index_list(team_member)").all().map((i) => i.name);
        p2.close();
        return names;
      })();
      check(
        `[${label}] após o upgrade os índices de team_member estão presentes`,
        idxAfter.includes("team_member_session_idx") && idxAfter.includes("team_member_status_idx"),
        idxAfter.join(","),
      );
    }
  }

  db.run(
    "INSERT INTO team (id, name, project_id, lead_session_id, status, delegate, time_created, time_updated) VALUES (?,?,?,?,?,?,?,?)",
    [TEAM_ID, "standby-suite", "default", LEAD_SESSION, "active", 0, now, now],
  );

  const registry = new MemberRegistry();
  const progressTracker = new ProgressTracker();
  const calls = newCalls();
  const failFor = new Set();
  const client = makeClient(calls, failFor);
  const deps = { db, registry, tracker: {}, purgeApprovals: {}, client, directory: root, config: DEFAULT_CONFIG, progressTracker };

  const member = (name) => db.query("SELECT * FROM team_member WHERE team_id = ? AND name = ?").get(TEAM_ID, name);
  const systemMsgs = () => db.query("SELECT content FROM team_message WHERE team_id = ? AND from_name = 'system'").all(TEAM_ID).map((r) => r.content);

  /* ================================================================ *
   * A) SPAWN COM standby: true
   * ================================================================ */
  const PROMPT_A = "Implementar o engine de standby e mecanismo de despertar no plugin ensemble.";
  await executeTeamSpawn(deps, { name: "g-standby", agent: "build", prompt: PROMPT_A, worktree: false, standby: true }, LEAD_SESSION);
  const a = member("g-standby");
  check(`[${label}] A1 spawn standby: status='ready'`, a?.status === "ready", `status=${a?.status}`);
  check(`[${label}] A2 spawn standby: execution_status='standby'`, a?.execution_status === "standby", `execution_status=${a?.execution_status}`);
  check(
    `[${label}] A3 spawn standby: spawn_context persistido e contém o prompt integral`,
    typeof a?.spawn_context === "string" && a.spawn_context.length > 0 && a.spawn_context.includes(PROMPT_A),
    `len=${a?.spawn_context?.length ?? 0}`,
  );
  check(`[${label}] A4 spawn standby: NENHUMA invocação de promptAsync`, calls.promptAsync.length === 0, `promptAsync=${calls.promptAsync.length}`);
  check(`[${label}] A5 spawn standby: rollback NÃO armado (session.abort nunca chamado)`, calls.abort.length === 0, `abort=${calls.abort.length}`);
  check(`[${label}] A6 spawn standby: sessão filha criada e registrada`, !!a?.session_id && registry.getBySession(a.session_id)?.memberName === "g-standby", a?.session_id);
  check(`[${label}] A7 spawn standby: nenhum alerta de falha ao lead`, systemMsgs().length === 0, `system=${systemMsgs().length}`);
  const standbyContext = a?.spawn_context;

  /* --- A-control: spawn NORMAL inalterado --- */
  const beforeNormal = calls.promptAsync.length;
  await executeTeamSpawn(deps, { name: "g-active", agent: "build", prompt: "Tarefa normal sem standby.", worktree: false }, LEAD_SESSION);
  const n = member("g-active");
  check(`[${label}] A8 controle normal: status='busy' e execution_status='starting'`, n?.status === "busy" && n?.execution_status === "starting", `${n?.status}/${n?.execution_status}`);
  check(`[${label}] A9 controle normal: spawn_context permanece NULL`, n?.spawn_context === null || n?.spawn_context === undefined, String(n?.spawn_context));
  check(`[${label}] A10 controle normal: promptAsync disparado exatamente 1x`, calls.promptAsync.length - beforeNormal === 1, `delta=${calls.promptAsync.length - beforeNormal}`);

  /* ================================================================ *
   * B) BLINDAGEM DO NUDGE — shouldNudgeIdleMember
   * ================================================================ */
  const insertMember = (name, status, executionStatus, createdOffsetMs = 0) => {
    db.run(
      `INSERT INTO team_member (team_id, name, session_id, agent, status, execution_status, time_created, time_updated)
       VALUES (?,?,?,?,?,?,?,?)`,
      [TEAM_ID, name, `ses_${name}`, "build", status, executionStatus, now - createdOffsetMs, now - createdOffsetMs],
    );
  };
  const insertTask = (id, status, assignee, dependsOn) => {
    db.run(
      "INSERT INTO team_task (id, team_id, content, status, priority, assignee, depends_on, time_created, time_updated) VALUES (?,?,?,?,?,?,?,?,?)",
      [id, TEAM_ID, `task ${id}`, status, "medium", assignee, dependsOn, now, now],
    );
  };

  insertMember("b-standby", "ready", "standby");
  insertTask("t_dep", "pending", null, null);
  insertTask("t_blocked", "blocked", "b-blocked", JSON.stringify(["t_dep"]));
  insertMember("b-blocked", "ready", "idle");
  insertMember("b-control", "ready", "idle");
  insertTask("t_ctrl", "pending", "b-control", null);
  insertMember("b-reported", "ready", "idle");
  db.run(
    "INSERT INTO team_message (id, team_id, from_name, to_name, content, delivered, time_created) VALUES (?,?,?,?,?,?,?)",
    ["msg_reported", TEAM_ID, "b-reported", "lead", "<task-result>done</task-result>", 0, now],
  );

  check(`[${label}] B1 nudge: false para membro em standby`, shouldNudgeIdleMember(db, TEAM_ID, "b-standby") === false, String(shouldNudgeIdleMember(db, TEAM_ID, "b-standby")));
  check(`[${label}] B2 nudge: false para membro com tarefa bloqueada por dependência não resolvida`, shouldNudgeIdleMember(db, TEAM_ID, "b-blocked") === false, String(shouldNudgeIdleMember(db, TEAM_ID, "b-blocked")));
  check(`[${label}] B3 CONTROLE: true para membro ready/idle sem bloqueio (não é supressão cega)`, shouldNudgeIdleMember(db, TEAM_ID, "b-control") === true, String(shouldNudgeIdleMember(db, TEAM_ID, "b-control")));
  check(`[${label}] B4 CONTROLE: false quando já reportou ao lead`, shouldNudgeIdleMember(db, TEAM_ID, "b-reported") === false);
  check(`[${label}] B5 nudge: false para membro inexistente`, shouldNudgeIdleMember(db, TEAM_ID, "nope") === false);

  /* ================================================================ *
   * C) BLINDAGEM DO FAST-IDLE
   * ================================================================ */
  const fastIdleSeam = Object.keys(mods).find((k) => /fastidle/i.test(k) && typeof mods[k] === "function");
  if (fastIdleSeam) {
    const fn = mods[fastIdleSeam];
    const cases = [
      ["c-standby", "ready", "standby", 1_000, false, "standby → sem alarme"],
      ["c-blocked", "ready", "idle", 1_000, false, "tarefa bloqueada → sem alarme"],
      ["c-normal", "ready", "idle", 1_000, true, "caso legítimo → alarme"],
      ["c-old", "ready", "idle", 60_000, false, "spawnAge >= 15s → sem alarme"],
    ];
    for (const [name, status, exec, age, expected, why] of cases) {
      insertMember(name, status, exec, age);
      if (name === "c-blocked") insertTask("t_cblock", "blocked", name, JSON.stringify(["t_missing"]));
      const got = fn(db, TEAM_ID, name);
      check(`[${label}] C fast-idle(${fastIdleSeam}) ${name}: ${why}`, got === expected, `got=${got}`);
    }
  } else {
    // Fallback: extrai o bloco REAL do fast-idle e o executa com as closures reais.
    const block = extractFastIdleBlock(distRaw) ?? extractFastIdleBlock(srcIndex);
    if (!block) {
      check(`[${label}] C fast-idle: seam exportada OU bloco extraível encontrado`, false, "NENHUMA forma de exercitar o fast-idle sem reimplementar a lógica");
    } else {
      const runner = new Function(
        "db", "transition", "client", "client3", "nudgedMembers", "log", "log2", "notifyLead",
        block + "\n",
      );
      const runFastIdle = (name, status, exec, age) => {
        insertMember(name, status, exec, age);
        if (name === "c-blocked") insertTask("t_cblock", "blocked", name, JSON.stringify(["t_missing"]));
        const before = systemMsgs().length;
        const beforeToast = calls.toast.length;
        const nudged = new Set();
        runner(db, { to: "ready", from: "busy", teamId: TEAM_ID, memberName: name }, client, client, nudged, () => {}, () => {}, notifyLead);
        return systemMsgs().length - before > 0 || calls.toast.length - beforeToast > 0;
      };
      check(`[${label}] C fast-idle(inline) c-standby: standby → NÃO dispara notifyLead`, runFastIdle("c-standby", "ready", "standby", 1_000) === false);
      check(`[${label}] C fast-idle(inline) c-blocked: bloqueado → NÃO dispara notifyLead`, runFastIdle("c-blocked", "ready", "idle", 1_000) === false);
      check(`[${label}] C fast-idle(inline) c-normal: caso legítimo AINDA dispara notifyLead`, runFastIdle("c-normal", "ready", "idle", 1_000) === true);
      check(`[${label}] C fast-idle(inline) c-old: spawnAge >= 15s → não dispara`, runFastIdle("c-old", "ready", "idle", 60_000) === false);
    }
  }

  /* ================================================================ *
   * D) DESPERTAR ÍNTEGRO — team_message
   * ================================================================ */
  const pBefore = calls.promptAsync.length;
  await executeTeamMessage(deps, { to: "g-standby", text: "wake-1" }, LEAD_SESSION);
  const wake1 = calls.promptAsync[calls.promptAsync.length - 1];
  check(
    `[${label}] D1 despertar: promptAsync disparado para a sessão do standby`,
    calls.promptAsync.length === pBefore + 1 && wake1?.sessionID === a.session_id,
    `sessionID=${wake1?.sessionID}`,
  );
  const wtext = wake1?.parts?.[0]?.text ?? "";
  check(
    `[${label}] D2 despertar: spawn_context é PREPENDADO na entrega`,
    typeof standbyContext === "string" && wtext.startsWith(standbyContext),
    `prefixo=${JSON.stringify(wtext.slice(0, 60))}`,
  );
  check(`[${label}] D3 despertar: a mensagem original acompanha o spawn_context`, wtext.includes("wake-1"));
  check(`[${label}] D4 despertar: identificação de origem da mensagem preservada`, /Team message from lead/.test(wtext), JSON.stringify(wtext.slice(-60)));
  check(`[${label}] D5 despertar: agent propagado no promptAsync`, !!wake1?.agent, String(wake1?.agent));
  check(`[${label}] D6 despertar: execution_status transiciona standby → starting`, member("g-standby")?.execution_status === "starting", `execution_status=${member("g-standby")?.execution_status}`);

  const pBefore2 = calls.promptAsync.length;
  await executeTeamMessage(deps, { to: "g-standby", text: "wake-2" }, LEAD_SESSION);
  const wake2 = calls.promptAsync[calls.promptAsync.length - 1];
  const w2text = wake2?.parts?.[0]?.text ?? "";
  check(
    `[${label}] D7 idempotência: 2ª mensagem NÃO re-prependa o spawn_context`,
    calls.promptAsync.length === pBefore2 + 1 && !w2text.includes(PROMPT_A) && w2text.includes("wake-2"),
    JSON.stringify(w2text.slice(0, 80)),
  );

  // Spawn de um segundo standby só para o broadcast.
  await executeTeamSpawn(deps, { name: "g-bc", agent: "build", prompt: "Contexto de broadcast.", worktree: false, standby: true }, LEAD_SESSION);
  const bcRow = member("g-bc");
  check(`[${label}] D8 broadcast-prep: g-bc nascido em standby`, bcRow?.execution_status === "standby" && typeof bcRow?.spawn_context === "string");

  const pBeforeBc = calls.promptAsync.length;
  await executeTeamBroadcast(deps, { text: "bc-1" }, LEAD_SESSION);
  const bcCalls = calls.promptAsync.slice(pBeforeBc);
  const bcStandby = bcCalls.find((c) => c.sessionID === bcRow.session_id);
  const bcActive = bcCalls.find((c) => c.sessionID === n.session_id);
  check(
    `[${label}] D9 broadcast: membro em standby recebe prepend do spawn_context`,
    !!bcStandby && (bcStandby.parts?.[0]?.text ?? "").startsWith(bcRow.spawn_context) && (bcStandby.parts?.[0]?.text ?? "").includes("bc-1"),
    JSON.stringify((bcStandby?.parts?.[0]?.text ?? "").slice(0, 60)),
  );
  check(
    `[${label}] D10 broadcast: membro ativo NÃO recebe spawn_context (entrega normal)`,
    !!bcActive && !(bcActive.parts?.[0]?.text ?? "").includes("Contexto de broadcast."),
    JSON.stringify((bcActive?.parts?.[0]?.text ?? "").slice(0, 80)),
  );
  check(`[${label}] D11 broadcast: standby transiciona para starting`, member("g-bc")?.execution_status === "starting", `execution_status=${member("g-bc")?.execution_status}`);

  /* ================================================================ *
   * E) FAIL-SAFE DO DESPERTAR — transporte rejeita → janela devolvida
   * ================================================================ */
  {
    const FAIL_PROMPT = "Contexto que não pode se perder no transporte.";
    await executeTeamSpawn(deps, { name: "g-fail", agent: "build", prompt: FAIL_PROMPT, worktree: false, standby: true }, LEAD_SESSION);
    const failRow = member("g-fail");
    check(`[${label}] E0 prep: g-fail nasceu em standby`, failRow?.execution_status === "standby");
    const failSession = failRow?.session_id;
    failFor.add(failSession);

    const pBeforeFail = calls.promptAsync.length;
    const ret = await executeTeamMessage(deps, { to: "g-fail", text: "lost-wake" }, LEAD_SESSION);
    await new Promise((r) => setTimeout(r, 50)); // deixa o .catch do fire-and-forget rodar
    const failAfter = member("g-fail");

    check(`[${label}] E1 transporte do despertar rejeitou de propósito (rejected promise)`, calls.promptAsync.length === pBeforeFail + 1);
    check(
      `[${label}] E2 janela standby é DEVOLVIDA (execution_status volta a 'standby')`,
      failAfter?.execution_status === "standby",
      `execution_status=${failAfter?.execution_status}`,
    );
    check(
      `[${label}] E3 spawn_context preservado para o retry re-prependar`,
      typeof failAfter?.spawn_context === "string" && failAfter.spawn_context.includes(FAIL_PROMPT),
      `len=${failAfter?.spawn_context?.length ?? 0}`,
    );
    check(`[${label}] E4 retorno informa o wake (mensagem persistida para o recovery)`, /woke from standby/.test(ret), JSON.stringify(ret.slice(0, 70)));

    // Transporte saudável de novo: o retry precisa re-prependar o contexto.
    failFor.delete(failSession);
    const pRetry = calls.promptAsync.length;
    await executeTeamMessage(deps, { to: "g-fail", text: "retry-wake" }, LEAD_SESSION);
    const retry = calls.promptAsync[calls.promptAsync.length - 1];
    const rtext = retry?.parts?.[0]?.text ?? "";
    check(
      `[${label}] E5 retry re-prependa o spawn_context (zero perda de contexto)`,
      calls.promptAsync.length === pRetry + 1 && rtext.startsWith(failAfter.spawn_context) && rtext.includes("retry-wake"),
      JSON.stringify(rtext.slice(0, 50)),
    );
    check(`[${label}] E6 retry conclui a transição standby → starting`, member("g-fail")?.execution_status === "starting", `execution_status=${member("g-fail")?.execution_status}`);
    failFor.clear();
  }

  /* --- regressão de largura: nenhum alarme falso de fast-idle durante a suíte --- */
  check(
    `[${label}] D12 nenhum alarme fast-idle falso emitido ao longo de toda a suíte`,
    !systemMsgs().some((m) => m.includes("went idle immediately")),
    systemMsgs().filter((m) => m.includes("went idle")).length + " alarme(s)",
  );

  db.close();
}

function countMigrations(text) {
  const m = text.match(/var MIGRATIONS = \[([\s\S]*?)\n\];/);
  if (!m) return 0;
  return (m[1].match(/^\s*`/gm) ?? []).length || (m[1].match(/Migration \d+/g) ?? []).length;
}

function extractFastIdleBlock(text) {
  const a = text.indexOf("const fastIdleKey =");
  if (a < 0) return null;
  const b = text.indexOf("const nudgeKey =", a);
  if (b < 0) return null;
  const block = text.slice(a, b);
  const open = (block.match(/\{/g) ?? []).length;
  const close = (block.match(/\}/g) ?? []).length;
  return open === close && open > 0 ? block : null;
}

/* ================================================================== *
 * 6. EXECUÇÃO — dist (artefato real) e src (fonte real)
 * ================================================================== */
const distMods = await import(HARNESS);
check("dist expõe a API comportamental necessária", REQUIRED_SYMBOLS.every((s) => distMods[s] !== undefined));
await runBehavior("dist", distMods);

const srcMods = {
  ...(await import(`${SRC_COPY}/tools/team-spawn.ts`)),
  ...(await import(`${SRC_COPY}/tools/team-message.ts`)),
  ...(await import(`${SRC_COPY}/tools/team-broadcast.ts`)),
  ...(await import(`${SRC_COPY}/hooks.ts`)),
  ...(await import(`${SRC_COPY}/db.ts`)),
  ...(await import(`${SRC_COPY}/state.ts`)),
  ...(await import(`${SRC_COPY}/progress.ts`)),
  ...(await import(`${SRC_COPY}/config.ts`)),
  ...(await import(`${SRC_COPY}/notify.ts`)),
  MIGRATIONS: (await import(`${SRC_COPY}/schema.ts`)).MIGRATIONS,
};
const fastSeamSrc = Object.keys(srcMods).find((k) => /fastidle/i.test(k));
check("src carrega a API comportamental necessária", ["executeTeamSpawn", "executeTeamMessage", "executeTeamBroadcast", "shouldNudgeIdleMember", "createDb", "MemberRegistry", "ProgressTracker", "DEFAULT_CONFIG"].every((s) => typeof srcMods[s] === "function" || typeof srcMods[s] === "object"));
await runBehavior("src", srcMods);

/* ================================================================== *
 * 7. REGRESSÃO — Watchdog de Heartbeat / Compaction (suíte independente)
 * ================================================================== */
{
  check("suite do watchdog pré-existe", existsSync(WATCHDOG_SUITE), WATCHDOG_SUITE);
  if (existsSync(WATCHDOG_SUITE)) {
    const r = spawnSync(process.execPath, [WATCHDOG_SUITE], { encoding: "utf8", timeout: 120_000 });
    const tail = (r.stdout ?? "").trim().split("\n").filter((l) => l.startsWith("FAIL") || l.startsWith("RESULT")).join(" | ");
    check("F) zero regressões no Watchdog de Heartbeat / Compaction", r.status === 0, `status=${r.status} ${tail}`);
  }
}

/* ================================================================== *
 * 8. VEREDITO
 * ================================================================== */
const failed = results.filter(([, ok]) => !ok);
console.log(`\nRESULT: ${results.length - failed.length}/${results.length} checks passed`);
if (failed.length) {
  console.log("FALHAS:");
  for (const [name] of failed) console.log(`  - ${name}`);
}
process.exit(failed.length ? 1 : 0);
