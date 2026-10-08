#!/usr/bin/env node
/**
 * QUALITY GATE DETERMINÍSTICO — Silenciamento do Lead (silentLead) +
 * Despertar Sistemático por Fechamento de Board
 * @hueyexe/opencode-ensemble@0.18.0
 *
 * Guardiã: Clara (Quality Gate). Time "silent-lead-board-wake".
 *
 * Sob teste (código REAL, não simulado):
 *   - executeTeamMessage        → src/tools/team-message.ts  e dist/index.js (src + dist).
 *   - executeTeamTasksComplete  → src/tools/team-tasks-complete.ts.
 *   - leadReportDirective/      → src/system-prompt.ts (coerção condicional).
 *     buildTeammateSystemPrompt /
 *     buildTeamCompactionContext /
 *     buildLeadSystemPrompt
 *   - DEFAULT_CONFIG/loadConfig → src/config.ts (flag silentLead, default true).
 *   - createDb/MIGRATIONS       → todas as migrations reais num SQLite real (node:sqlite).
 *
 * Comprova:
 *   (a) team_message → lead com silentLead:true (default): linha persistida no
 *       SQLite, NENHUM promptAsync na sessão do lead; canal de entrega real é
 *       o buildLeadSystemPrompt (marca delivered=1).
 *   (b) silentLead:false (legado): promptAsync dispara exatamente 1x com
 *       "[System: New team message from <remetente>]" e synthetic:true.
 *   (c) sem coerção obrigatória no system-prompt no modo default; legado
 *       preserva o texto byte-a-byte.
 *   (d) última tarefa do board concluída (completed === total) → promptAsync do
 *       lead disparado EXATAMENTE 1x com
 *       "[System: All team tasks completed on board by <who>]" (synthetic:true).
 *   (e) zero regressões: Standby (122 checks) e Watchdog (53 checks).
 *   (f) node --check dist/index.js → exit 0.
 *
 * Único ponto de emenda: o TRANSPORTE DE SAÍDA (promptAsync / showToast) é
 * gravado num array para que a asserção prove O QUE foi chamado — mesmo padrão
 * já homologado em test_standby_lifecycle.mjs e test_watchdog_heartbeat.mjs.
 * Nenhuma lógica de decisão é substituída: sem mock library, sem stub de banco,
 * sem fixture falsa. Os bancos são SQLite REAIS criados isoladamente.
 *
 * Uso:  node tests/test_silent_lead_board_wake.mjs
 * Exit: 0 = todos os checks PASS; 1 = há FAIL.
 */

import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";

// Pacote sob teste: a raiz deste repositório (src/ + dist/ locais).
// ENSEMBLE_PKG permite apontar a suíte para outro checkout sem editar o arquivo.
const REPO = path.resolve(import.meta.dirname, "..");
const PKG = process.env.ENSEMBLE_PKG || REPO;
const DIST = path.join(PKG, "dist/index.js");
const SRC = path.join(PKG, "src");
// Scratch isolado, recriado a cada execução e coberto pelo .gitignore.
const TMP = path.join(REPO, ".test-scratch");
mkdirSync(TMP, { recursive: true });
const HARNESS = path.join(TMP, "_slbw_harness.mjs");
const SRC_COPY = path.join(TMP, "ensemble_src_slbw");
const ROOT = path.join(TMP, "slbw_suite");
const STANDBY_SUITE = path.join(import.meta.dirname, "test_standby_lifecycle.mjs");
const WATCHDOG_SUITE = path.join(import.meta.dirname, "test_watchdog_heartbeat.mjs");

const LEGACY_COERCION = "You MUST send your results to the lead via team_message before stopping.";
const SILENT_DIRECTIVE = "Collaborate with teammates using team_message and complete assigned tasks on the board.";

const results = [];
const check = (name, ok, detail) => {
  results.push([name, ok]);
  console.log(`${ok ? "PASS" : "FAIL"} | ${name}${detail ? " | " + detail : ""}`);
};

// Rejeições não tratadas são falha de homologação (o fail-safe .catch do
// desperto precisa absorver a falha de transporte).
const unhandled = [];
process.on("unhandledRejection", (e) => unhandled.push(e));

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
  "executeTeamMessage", "executeTeamTasksComplete", "createDb", "MemberRegistry",
  "DEFAULT_CONFIG", "loadConfig", "buildTeammateSystemPrompt",
  "buildTeamCompactionContext", "buildLeadSystemPrompt", "MIGRATIONS",
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
    `${distRaw.length} bytes; exports já no bundle=[${[...already].join(",")}]; anexados=[${need.join(",")}]`,
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
 * 3. PARIDADE src ↔ dist dos marcadores da feature                   *
 * ================================================================== */
function readSrc(rel) {
  return readFileSync(path.join(SRC, rel), "utf8");
}
const srcConfig = readSrc("config.ts");
const srcMsg = readSrc("tools/team-message.ts");
const srcComplete = readSrc("tools/team-tasks-complete.ts");
const srcPrompt = readSrc("system-prompt.ts");

function marker(label, srcText, needle) {
  const srcHit = needle instanceof RegExp ? needle.test(srcText) : srcText.includes(needle);
  const distHit = needle instanceof RegExp ? needle.test(distRaw) : distRaw.includes(needle);
  check(`paridade src↔dist: ${label}`, srcHit && distHit, `src=${srcHit} dist=${distHit}`);
}

// (c) — config flag
{
  // Tipos são erasados no bundle (esbuild): a declaração `silentLead?: boolean`
  // só existe em src; o artefato runtime é provado pelo DEFAULT_CONFIG abaixo.
  check("paridade: flag silentLead declarada no EnsembleConfig (src)", srcConfig.includes("silentLead?: boolean"));
  marker("DEFAULT_CONFIG.silentLead = true", srcConfig, /silentLead:\s*true/);
  marker("DEFAULT_CONFIG.silentLead = true (bundle)", distRaw, /silentLead:\s*true/);
  // Identificadores podem ser renomeados no bundle (ex.: total → total2);
  // a paridade é semântica, não literal.
  marker("validação de tipo de silentLead no readConfigFile", srcConfig, "typeof raw.silentLead === \"boolean\"");
  marker("validação de tipo de silentLead no bundle", distRaw, "typeof raw.silentLead === \"boolean\"");
}

// (a)/(b) — supressão condicional no team-message
marker("team-message: guarda deps.config?.silentLead", srcMsg, "deps.config?.silentLead");
marker("team-message: guarda deps.config?.silentLead (bundle)", distRaw, "deps.config?.silentLead");
marker("team-message: ramo silenciado loga team_message:lead-silenced", srcMsg, "team_message:lead-silenced");
marker("team-message: ramo legado mantém promptAsync [System: New team message from ...]", distRaw, "[System: New team message from ");

// (c) — coerção condicional no system-prompt
marker("system-prompt: leadReportDirective condicionado a silentLead === false", srcPrompt, "config?.silentLead === false");
marker("system-prompt: leadReportDirective condicionado (bundle)", distRaw, "config?.silentLead === false");
marker("system-prompt: diretriz substituta no modo default", srcPrompt, SILENT_DIRECTIVE);
marker("system-prompt: diretriz substituta no modo default (bundle)", distRaw, SILENT_DIRECTIVE);

// (d) — wake por fechamento de board
{
  // Paridade semântica: o bundle pode renomear identificadores (total → total2),
  // então o src é checado literalmente e o dist com regex tolerante a rename.
  check("paridade src: guarda total > 0 && completed === total", /total > 0 && completed === total/.test(srcComplete));
  check("paridade dist: guarda total > 0 && completed === total (ids renomeáveis)", /total\d* > 0 && completed === total\d*/.test(distRaw),
    distRaw.match(/total\d* > 0 && completed === total\d*/)?.[0] ?? "ausente");
}
marker("tasks-complete: texto sintético do wake", srcComplete, "[System: All team tasks completed on board by ${who}]");
marker("tasks-complete: texto sintético do wake (bundle)", distRaw, "[System: All team tasks completed on board by ${who}]");
marker("tasks-complete: fail-safe .catch no wake", srcComplete, "tasks-complete:wake-lead:failed");
marker("tasks-complete: fail-safe .catch no wake (bundle)", distRaw, "tasks-complete:wake-lead:failed");
marker("tasks-complete: wake endereça team.lead_session_id (não team_member)", srcComplete, "SELECT lead_session_id FROM team WHERE id = ?");

// Coerção: exatamente UMA ocorrência no código inteiro (o ramo legado),
// em nenhuma outra call site.
{
  const walk = (dir) =>
    readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
      e.isDirectory() ? walk(path.join(dir, e.name)) : [path.join(dir, e.name)],
    );
  let srcHits = 0;
  const files = [];
  for (const f of walk(SRC)) {
    if (!/\.tsx?$/.test(f)) continue;
    const text = readFileSync(f, "utf8");
    const n = text.split(LEGACY_COERCION).length - 1;
    if (n > 0) {
      srcHits += n;
      files.push(`${path.relative(SRC, f)}×${n}`);
    }
  }
  const distHits = distRaw.split(LEGACY_COERCION).length - 1;
  check(
    "c) coerção legada existe em exatamente 1 lugar (ramo silentLead===false) em src",
    srcHits === 1,
    `ocorrências=${srcHits} em [${files.join(", ")}]`,
  );
  check("c) coerção legada existe em exatamente 1 lugar no bundle", distHits === 1, `ocorrências=${distHits}`);
}

// Config threading: todo call site passa `config` (senão a flag seria ignorada).
{
  const expect = 'buildTeammateSystemPrompt(db, teamInfo.teamId, teamInfo.memberName ?? "unknown", config)';
  const idx = readSrc("index.ts");
  const v2 = readSrc("v2-setup.ts");
  check("c) index.ts repassa config para buildTeammateSystemPrompt", idx.includes(expect));
  check("c) v2-setup.ts repassa config para buildTeammateSystemPrompt", v2.includes(expect));
  check("c) bundle repassa config nos call sites do system-prompt", distRaw.includes(expect));
  check(
    "c) compaction context recebe config nos call sites (index + v2-setup)",
    /buildTeamCompactionContext\(db, teamInfo\.teamId, teamInfo\.role, teamInfo\.memberName, config\)/.test(idx) &&
      /buildTeamCompactionContext\(db, teamInfo\.teamId, teamInfo\.role, teamInfo\.memberName, config\)/.test(v2),
  );
}

/* ================================================================== *
 * 4. ANTI-MOCK (Fail-Fast) — varredura determinística em produção    *
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
 * 5. FIXTURES — SQLite REAL (node:sqlite), DB temporário isolado     *
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
  };
}
const newCalls = () => ({ sessionCreate: [], promptAsync: [], abort: [], toast: [] });

async function runBehavior(label, mods) {
  const {
    executeTeamMessage, executeTeamTasksComplete, createDb, MemberRegistry,
    DEFAULT_CONFIG, loadConfig, buildTeammateSystemPrompt,
    buildTeamCompactionContext, buildLeadSystemPrompt,
  } = mods;

  const root = `${ROOT}_${label}`;
  rmSync(root, { recursive: true, force: true });
  mkdirSync(root, { recursive: true });
  const db = createDb(path.join(root, "ensemble.db"));

  /* --- 5.1 schema real: migrations + integridade --- */
  const migrationsLen = mods.MIGRATIONS?.length ?? 0;
  check(`[${label}] MIGRATIONS extraído (${migrationsLen} migrations)`, migrationsLen >= 11, `len=${migrationsLen}`);
  const version = db.query("PRAGMA user_version").get().user_version;
  check(`[${label}] ensemble.db migra até user_version = MIGRATIONS.length`, version === migrationsLen, `user_version=${version}`);

  const now = Date.now();
  const insertTeam = (id, name, leadSession) =>
    db.run(
      "INSERT INTO team (id, name, project_id, lead_session_id, status, delegate, time_created, time_updated) VALUES (?,?,?,?,?,?,?,?)",
      [id, name, "default", leadSession, "active", 0, now, now],
    );
  const insertMember = (teamId, name, sessionId) =>
    db.run(
      `INSERT INTO team_member (team_id, name, session_id, agent, status, execution_status, time_created, time_updated)
       VALUES (?,?,?,?,?,?,?,?)`,
      [teamId, name, sessionId, "build", "ready", "idle", now, now],
    );
  const insertTask = (id, teamId, status, assignee, dependsOn) =>
    db.run(
      "INSERT INTO team_task (id, team_id, content, status, priority, assignee, depends_on, time_created, time_updated) VALUES (?,?,?,?,?,?,?,?,?)",
      [id, teamId, `task ${id}`, status, "medium", assignee, dependsOn, now, now],
    );
  const leadRows = (teamId) =>
    db.query("SELECT from_name, to_name, content, delivered FROM team_message WHERE team_id = ? AND to_name = 'lead' ORDER BY time_created ASC").all(teamId);

  /* Fixture do time principal (QA) */
  const TEAM = "team_slbw";
  const LEAD = "ses_slbw_lead";
  const MEMBER = "qa-member";
  const MEMBER_SESSION = "ses_qa_member";
  const PEER = "peer-1";
  const PEER_SESSION = "ses_peer_1";

  insertTeam(TEAM, "silent-lead-board-wake", LEAD);
  insertMember(TEAM, MEMBER, MEMBER_SESSION);
  insertMember(TEAM, PEER, PEER_SESSION);

  const registry = new MemberRegistry();
  registry.register(TEAM, MEMBER, MEMBER_SESSION);
  registry.register(TEAM, PEER, PEER_SESSION);

  const calls = newCalls();
  const failFor = new Set();
  const client = makeClient(calls, failFor);
  const deps = (config) => ({
    db, registry, tracker: {}, purgeApprovals: {}, client,
    directory: root, config, progressTracker: mods.ProgressTracker ? new mods.ProgressTracker() : {},
  });

  /* ================================================================ *
   * A) silentLead: true (DEFAULT_CONFIG) — silêncio absoluto do lead  *
   * ================================================================ */
  check(`[${label}] A1 DEFAULT_CONFIG.silentLead === true (default do produto)`, DEFAULT_CONFIG.silentLead === true, String(DEFAULT_CONFIG.silentLead));

  const silentPayload = "Silent delivery payload alpha.";
  const retA = await executeTeamMessage(deps(DEFAULT_CONFIG), { to: "lead", text: silentPayload }, MEMBER_SESSION);
  check(`[${label}] A2 retorno amigável sem exceção`, retA === "Message sent to lead.", JSON.stringify(retA));

  const rowsA = leadRows(TEAM);
  check(`[${label}] A3a linha persistida no SQLite (to_name='lead')`, rowsA.length === 1, `rows=${rowsA.length}`);
  check(
    `[${label}] A3b linha com remetente/conteúdo íntegros`,
    rowsA[0]?.from_name === MEMBER && rowsA[0]?.content === silentPayload,
    `${rowsA[0]?.from_name} :: ${JSON.stringify(rowsA[0]?.content)}`,
  );
  check(`[${label}] A4 NENHUM promptAsync disparado (lead em silêncio absoluto)`, calls.promptAsync.length === 0, `promptAsync=${calls.promptAsync.length}`);
  check(`[${label}] A4b sessão do lead intacta (nenhuma chamada para ${LEAD})`, !calls.promptAsync.some((c) => c.sessionID === LEAD));

  // Canal de entrega real: o buildLeadSystemPrompt do próximo turno natural.
  const leadPrompt = buildLeadSystemPrompt(db, TEAM, DEFAULT_CONFIG);
  check(`[${label}] A5a mensagem ao lead superficia no prompt do lead (entrega sem wake)`, leadPrompt.includes(`[From ${MEMBER}]: ${silentPayload}`), JSON.stringify(silentPayload));
  check(`[${label}] A5b delivered=1 após o transform consumir a fila`, leadRows(TEAM)[0]?.delivered === 1, String(leadRows(TEAM)[0]?.delivered));

  // 2ª mensagem: silêncio continua absoluto.
  await executeTeamMessage(deps(DEFAULT_CONFIG), { to: "lead", text: "Silent payload beta." }, MEMBER_SESSION);
  check(`[${label}] A6 segunda mensagem ao lead também silenciada`, calls.promptAsync.length === 0, `promptAsync=${calls.promptAsync.length}`);

  // Controle: a supressão é ESPECÍFICA do lead — entrega a pares continua.
  const pPeer = calls.promptAsync.length;
  const retPeer = await executeTeamMessage(deps(DEFAULT_CONFIG), { to: PEER, text: "peer ping" }, MEMBER_SESSION);
  const peerCall = calls.promptAsync[calls.promptAsync.length - 1];
  check(
    `[${label}] A7 CONTROLE: mensagem a par ainda dispara promptAsync (não é supressão global)`,
    calls.promptAsync.length === pPeer + 1 && peerCall?.sessionID === PEER_SESSION,
    `delta=${calls.promptAsync.length - pPeer} sessionID=${peerCall?.sessionID}`,
  );
  check(`[${label}] A7b entrega ao par leva a etiqueta de origem`, (peerCall?.parts?.[0]?.text ?? "").includes(`[Team message from ${MEMBER}]: peer ping`), JSON.stringify((peerCall?.parts?.[0]?.text ?? "").slice(0, 80)));
  check(`[${label}] A7c retorno ao chamador`, retPeer === "Message sent to peer-1.", JSON.stringify(retPeer));

  // Guarda de autenticação real permanece intacta.
  let threwAuth = false;
  try {
    await executeTeamMessage(deps(DEFAULT_CONFIG), { to: "lead", text: "x" }, "ses_unknown");
  } catch (e) {
    threwAuth = /not in a team/.test(String(e?.message ?? e));
  }
  check(`[${label}] A8 requireTeamMember ainda rejeita sessão fora de time`, threwAuth);

  /* ================================================================ *
   * B) silentLead: false (legado) — promptAsync restaurado           *
   * ================================================================ */
  const legacy = { ...DEFAULT_CONFIG, silentLead: false };
  const pLegacy = calls.promptAsync.length;
  const legacyPayload = "Legacy wake payload.";
  const retB = await executeTeamMessage(deps(legacy), { to: "lead", text: legacyPayload }, MEMBER_SESSION);
  const legacyCalls = calls.promptAsync.slice(pLegacy);
  check(`[${label}] B1 legado: promptAsync dispara exatamente 1x para a sessão do lead`, legacyCalls.length === 1 && legacyCalls[0].sessionID === LEAD, `delta=${legacyCalls.length} sessionID=${legacyCalls[0]?.sessionID}`);
  check(
    `[${label}] B2 legado: payload "[System: New team message from <remetente>]"`
    , legacyCalls[0]?.parts?.[0]?.text === `[System: New team message from ${MEMBER}]`,
    JSON.stringify(legacyCalls[0]?.parts?.[0]?.text),
  );
  check(`[${label}] B2b legado: synthetic:true`, legacyCalls[0]?.synthetic === true, String(legacyCalls[0]?.synthetic));
  const rowsB = leadRows(TEAM);
  check(`[${label}] B3 legado: linha também persistida no SQLite`, rowsB.length === 3 && rowsB.some((r) => r.content === legacyPayload), `rows=${rowsB.length}`);
  check(`[${label}] B4 legado: retorno idêntico`, retB === "Message sent to lead.", JSON.stringify(retB));

  // loadConfig: parsing/merge/type-validation reais.
  {
    let globalSilent;
    try {
      const g = JSON.parse(readFileSync(path.join(process.env.HOME ?? "", ".config", "opencode", "ensemble.json"), "utf8"));
      if (typeof g.silentLead === "boolean") globalSilent = g.silentLead;
    } catch { /* sem config global legível → default */ }
    const expectedNoKey = typeof globalSilent === "boolean" ? globalSilent : DEFAULT_CONFIG.silentLead;

    const cfgDir = (name, json) => {
      const dir = path.join(root, name);
      mkdirSync(path.join(dir, ".opencode"), { recursive: true });
      if (json !== undefined) writeFileSync(path.join(dir, ".opencode", "ensemble.json"), json);
      return dir;
    };
    check(`[${label}] B5a loadConfig sem chave usa o default/legado coerente`, loadConfig(cfgDir("cfg_none")).silentLead === expectedNoKey, `esperado=${expectedNoKey}`);
    check(`[${label}] B5b loadConfig aceita silentLead:false (projetos legados)`, loadConfig(cfgDir("cfg_false", '{"silentLead": false}')).silentLead === false, "false");
    check(`[${label}] B5c loadConfig aceita silentLead:true`, loadConfig(cfgDir("cfg_true", '{"silentLead": true}')).silentLead === true, "true");
    check(`[${label}] B5d valor não-booleano é REJEITADO pela validação de tipo`, loadConfig(cfgDir("cfg_bad", '{"silentLead": 1}')).silentLead === expectedNoKey, `esperado=${expectedNoKey}`);
    check(`[${label}] B5e JSON inválido cai no default (fail-safe)`, loadConfig(cfgDir("cfg_broken", "{not json")).silentLead === expectedNoKey, `esperado=${expectedNoKey}`);
  }

  /* ================================================================ *
   * C) system-prompt: coerção condicional (item c)                   *
   * ================================================================ */
  const teammateDefault = buildTeammateSystemPrompt(db, TEAM, MEMBER, DEFAULT_CONFIG);
  check(`[${label}] C1 default: prompt do subagente NÃO contém a coerção obrigatória`, !teammateDefault.includes(LEGACY_COERCION));
  check(`[${label}] C2 default: traz a diretriz colaborativa de board`, teammateDefault.includes(SILENT_DIRECTIVE), JSON.stringify(teammateDefault.split("\n")[0]?.slice(0, 140)));

  const teammateLegacy = buildTeammateSystemPrompt(db, TEAM, MEMBER, legacy);
  check(`[${label}] C3 legado: coerção original preservada byte-a-byte`, teammateLegacy.includes(LEGACY_COERCION));

  const compactionDefault = buildTeamCompactionContext(db, TEAM, "member", MEMBER, DEFAULT_CONFIG);
  check(`[${label}] C4 compaction default: sem coerção obrigatória`, !compactionDefault.includes(LEGACY_COERCION));
  check(`[${label}] C5 compaction default: diretriz colaborativa presente`, compactionDefault.includes(`IMPORTANT: ${SILENT_DIRECTIVE}`));

  const compactionLegacy = buildTeamCompactionContext(db, TEAM, "member", MEMBER, legacy);
  check(`[${label}] C6 compaction legado: coerção preservada`, compactionLegacy.includes(`IMPORTANT: ${LEGACY_COERCION}`));

  check(`[${label}] C7 prompt do lead nunca carrega coerção de subagente`, !buildLeadSystemPrompt(db, TEAM, DEFAULT_CONFIG).includes(LEGACY_COERCION));
  check(`[${label}] C8 prompt do lead (legado) também não`, !buildLeadSystemPrompt(db, TEAM, legacy).includes(LEGACY_COERCION));

  /* ================================================================ *
   * D) DESPERTAR EXCLUSIVO POR FECHAMENTO DE BOARD (item d)          *
   * ================================================================ */
  const expectWake = (who) => `[System: All team tasks completed on board by ${who}]`;

  // D0: 2 tarefas no board do time QA (já existem mensagens/ativas acima).
  insertTask("t_1", TEAM, "pending", MEMBER, null);
  insertTask("t_2", TEAM, "pending", MEMBER, null);

  let base = calls.promptAsync.length;
  const retD1 = await executeTeamTasksComplete(deps(DEFAULT_CONFIG), { task_id: "t_1" }, MEMBER_SESSION);
  check(`[${label}] D1 board incompleto (1/2): NENHUM wake do lead`, calls.promptAsync.length === base, `delta=${calls.promptAsync.length - base}`);
  check(`[${label}] D1b retorno da conclusão intacto`, /^Completed task: task t_1/.test(retD1), JSON.stringify(retD1.slice(0, 60)));
  check(`[${label}] D1c tarefa marcada completed no SQLite`, db.query("SELECT status FROM team_task WHERE id = 't_1'").get()?.status === "completed");

  base = calls.promptAsync.length;
  const retD2 = await executeTeamTasksComplete(deps(DEFAULT_CONFIG), { task_id: "t_2" }, MEMBER_SESSION);
  const wakes = calls.promptAsync.slice(base);
  check(`[${label}] D2 board fechado (2/2): promptAsync do lead disparado EXATAMENTE 1x`, wakes.length === 1, `delta=${wakes.length}`);
  check(`[${label}] D3 wake endereçado à sessão do lead (${LEAD})`, wakes[0]?.sessionID === LEAD, String(wakes[0]?.sessionID));
  check(`[${label}] D4 texto exato "[System: All team tasks completed on board by ${MEMBER}]"`, wakes[0]?.parts?.[0]?.text === expectWake(MEMBER), JSON.stringify(wakes[0]?.parts?.[0]?.text));
  check(`[${label}] D4b wake é synthetic:true`, wakes[0]?.synthetic === true, String(wakes[0]?.synthetic));
  check(`[${label}] D4c toast de progresso continua disparando (comportamento pré-existente)`, calls.toast.length > 0, `toast=${calls.toast.length}`);
  check(`[${label}] D4d 1/2 tarefas completas`, (() => {
    const c = db.query("SELECT status, COUNT(*) c FROM team_task WHERE team_id = ? GROUP BY status").all(TEAM);
    const map = Object.fromEntries(c.map((r) => [r.status, r.c]));
    return (map.completed ?? 0) === 2 && (map.completed ?? 0) === c.reduce((s, r) => s + r.c, 0);
  })());

  // D5: completar de novo é rejeitado e NÃO re-dispara o wake.
  base = calls.promptAsync.length;
  let threwAgain = false;
  try {
    await executeTeamTasksComplete(deps(DEFAULT_CONFIG), { task_id: "t_2" }, MEMBER_SESSION);
  } catch (e) {
    threwAgain = /already completed/.test(String(e?.message ?? e));
  }
  check(`[${label}] D5 re-completar é rejeitado (guarda de acurácia do board)`, threwAgain);
  check(`[${label}] D5b re-completar NÃO dispara wake duplicado`, calls.promptAsync.length === base, `delta=${calls.promptAsync.length - base}`);

  // D6: fluxo com dependência — wake SÓ na última tarefa.
  {
    const T6 = "team_dep";
    const L6 = "ses_lead_dep";
    const M6 = "dep-member";
    const S6 = "ses_dep_member";
    insertTeam(T6, "dep-team", L6);
    insertMember(T6, M6, S6);
    registry.register(T6, M6, S6);
    insertTask("tA", T6, "pending", M6, null);
    insertTask("tB", T6, "blocked", M6, JSON.stringify(["tA"]));

    base = calls.promptAsync.length;
    await executeTeamTasksComplete(deps(DEFAULT_CONFIG), { task_id: "tA" }, S6);
    const unblocked = db.query("SELECT status FROM team_task WHERE id = 'tB'").get()?.status;
    check(`[${label}] D6a concluir tA desbloqueia tB (status → pending)`, unblocked === "pending", String(unblocked));
    check(`[${label}] D6b board ainda incompleto (1/2): sem wake`, calls.promptAsync.length === base, `delta=${calls.promptAsync.length - base}`);

    base = calls.promptAsync.length;
    await executeTeamTasksComplete(deps(DEFAULT_CONFIG), { task_id: "tB" }, S6);
    const w = calls.promptAsync.slice(base);
    check(`[${label}] D6c última tarefa concluída: wake exatamente 1x para ${L6}`, w.length === 1 && w[0]?.sessionID === L6, `delta=${w.length} sessionID=${w[0]?.sessionID}`);
    check(`[${label}] D6d who = autor da conclusão`, w[0]?.parts?.[0]?.text === expectWake(M6), JSON.stringify(w[0]?.parts?.[0]?.text));
  }

  // D7: fail-safe — time sem lead_session_id preenchido: sem wake, sem crash.
  {
    const T7 = "team_nolead";
    const M7 = "nolead-member";
    const S7 = "ses_nolead_member";
    insertTeam(T7, "no-lead-team", ""); // guard `lead?.lead_session_id` falsy
    insertMember(T7, M7, S7);
    registry.register(T7, M7, S7);
    insertTask("tN1", T7, "pending", M7, null);

    base = calls.promptAsync.length;
    let err7 = "";
    try {
      await executeTeamTasksComplete(deps(DEFAULT_CONFIG), { task_id: "tN1" }, S7);
    } catch (e) {
      err7 = String(e?.message ?? e);
    }
    check(`[${label}] D7 lead_session_id vazio → não lança exceção`, err7 === "", err7);
    check(`[${label}] D7b lead_session_id vazio → nenhum promptAsync emitido`, calls.promptAsync.length === base, `delta=${calls.promptAsync.length - base}`);
  }

  // D8: falha de transporte no wake → fail-safe .catch absorve (sem unhandledRejection).
  {
    const T8 = "team_failwake";
    const L8 = "ses_lead_failwake";
    const M8 = "fail-member";
    const S8 = "ses_fail_member";
    insertTeam(T8, "fail-wake-team", L8);
    insertMember(T8, M8, S8);
    registry.register(T8, M8, S8);
    insertTask("tF1", T8, "pending", M8, null);

    failFor.add(L8);
    const uBefore = unhandled.length;
    base = calls.promptAsync.length;
    let ret8 = "";
    let err8 = "";
    try {
      ret8 = await executeTeamTasksComplete(deps(DEFAULT_CONFIG), { task_id: "tF1" }, S8);
    } catch (e) {
      err8 = String(e?.message ?? e);
    }
    await new Promise((r) => setTimeout(r, 80)); // deixa o .catch do fire-and-forget rodar
    const attempted = calls.promptAsync.slice(base);
    check(`[${label}] D8 tentativa de wake registrada (transporte real foi chamado)`, attempted.length === 1 && attempted[0]?.sessionID === L8, `delta=${attempted.length}`);
    check(`[${label}] D8b falha de transporte NÃO propaga exceção ao chamador`, err8 === "" && /^Completed task:/.test(ret8), err8 || JSON.stringify(ret8.slice(0, 50)));
    check(`[${label}] D8c ZERO unhandledRejection (fail-safe .catch absorveu)`, unhandled.length === uBefore, `unhandled=${unhandled.length}`);
    failFor.delete(L8);
  }

  // D9: tarefa sem assignee → atribuída ao autor e `who` correto no wake.
  {
    const T9 = "team_unclaimed";
    const L9 = "ses_lead_unclaimed";
    const M9 = "unclaimed-member";
    const S9 = "ses_unclaimed_member";
    insertTeam(T9, "unclaimed-team", L9);
    insertMember(T9, M9, S9);
    registry.register(T9, M9, S9);
    insertTask("tU1", T9, "pending", null, null);

    base = calls.promptAsync.length;
    await executeTeamTasksComplete(deps(DEFAULT_CONFIG), { task_id: "tU1" }, S9);
    const w = calls.promptAsync.slice(base);
    const assigned = db.query("SELECT assignee FROM team_task WHERE id = 'tU1'").get()?.assignee;
    check(`[${label}] D9a tarefa sem assignee é atribuída atomicamente ao autor`, assigned === M9, String(assigned));
    check(`[${label}] D9b wake usa o autor como "who"`, w.length === 1 && w[0]?.parts?.[0]?.text === expectWake(M9), JSON.stringify(w[0]?.parts?.[0]?.text));
  }

  // D10: silêncio do lead não é quebrado por mensagens durante a execução.
  // (recapitulação do contrato: texto só via board; mensagens ficam na fila)
  {
    base = calls.promptAsync.length;
    await executeTeamMessage(deps(DEFAULT_CONFIG), { to: "lead", text: "fila durante execução" }, MEMBER_SESSION);
    const queued = db.query("SELECT COUNT(*) c FROM team_message WHERE team_id = ? AND to_name = 'lead' AND delivered = 0").get(TEAM).c;
    check(`[${label}] D10 mensagens ao lead acumulam na fila (delivered=0) sem wake`, calls.promptAsync.length === base && queued >= 1, `delta=${calls.promptAsync.length - base} fila=${queued}`);
  }

  db.close();
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
  ...(await import(`${SRC_COPY}/tools/team-message.ts`)),
  ...(await import(`${SRC_COPY}/tools/team-tasks-complete.ts`)),
  ...(await import(`${SRC_COPY}/db.ts`)),
  ...(await import(`${SRC_COPY}/state.ts`)),
  ...(await import(`${SRC_COPY}/config.ts`)),
  ...(await import(`${SRC_COPY}/system-prompt.ts`)),
  MIGRATIONS: (await import(`${SRC_COPY}/schema.ts`)).MIGRATIONS,
};
check(
  "src carrega a API comportamental necessária",
  ["executeTeamMessage", "executeTeamTasksComplete", "createDb", "MemberRegistry", "DEFAULT_CONFIG", "loadConfig", "buildTeammateSystemPrompt", "buildTeamCompactionContext", "buildLeadSystemPrompt"]
    .every((s) => srcMods[s] !== undefined),
  ["executeTeamMessage", "executeTeamTasksComplete", "createDb", "MemberRegistry", "DEFAULT_CONFIG", "loadConfig", "buildTeammateSystemPrompt", "buildTeamCompactionContext", "buildLeadSystemPrompt"]
    .filter((s) => srcMods[s] === undefined).join(",") || "ok",
);
await runBehavior("src", srcMods);

/* ================================================================== *
 * 7. REGRESSÃO — suítes anteriores (item e)                          *
 * ================================================================== */
function runSuite(file, expectedLine) {
  check(`suite pré-existe: ${path.basename(file)}`, existsSync(file), file);
  if (!existsSync(file)) return;
  const r = spawnSync(process.execPath, [file], { encoding: "utf8", timeout: 300_000 });
  const resultLine = (r.stdout ?? "").trim().split("\n").find((l) => l.startsWith("RESULT:")) ?? "(sem RESULT)";
  check(
    `e) zero regressões em ${path.basename(file)} (${expectedLine})`,
    r.status === 0 && resultLine.includes(expectedLine),
    `status=${r.status} ${resultLine}`,
  );
}
runSuite(STANDBY_SUITE, "122/122 checks passed");
runSuite(WATCHDOG_SUITE, "53/53 checks passed");

check("f) ZERO unhandledRejection ao longo de toda a suíte", unhandled.length === 0, `${unhandled.length}`);

/* ================================================================== *
 * 8. VEREDITO                                                        *
 * ================================================================== */
const failed = results.filter(([, ok]) => !ok);
console.log(`\nRESULT: ${results.length - failed.length}/${results.length} checks passed`);
if (failed.length) {
  console.log("FALHAS:");
  for (const [name] of failed) console.log(`  - ${name}`);
}
process.exit(failed.length ? 1 : 0);
