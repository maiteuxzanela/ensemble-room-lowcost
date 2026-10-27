#!/usr/bin/env node
/**
 * QUALITY GATE DETERMINÍSTICO — TICKET HARNESS-17 (identidade do `agent` nos nudges)
 *
 * Escopo EXATO (4 call sites deste ticket; os demais vãos — idle-without-report,
 * wake-lead e a família V2 via deliverPrompt — são TICKET-HARNESS-21 e NÃO são
 * varridos nem reprovados aqui):
 *   S1  src/index.ts  nudge `in-review-tasks`   → `...(nudgeAgent ? { agent: nudgeAgent } : {})`
 *   S2  src/index.ts  `wake-peer`               → `...(peerAgent ? { agent: peerAgent } : {})`
 *   S3  src/watchdog.ts `checkStalled`          → `agent: stallAgent`
 *   S4  src/watchdog.ts `checkChatty`           → `agent: chattyAgent`
 *
 * Provas:
 *   (a) cada nudge dispara promptAsync com `agent` PRESENTE e igual ao
 *       `team_member.agent` do alvo; quando o alvo é a sessão do lead
 *       (`session_id === team.lead_session_id`) o `agent` é `team.lead_agent`;
 *   (b) a coluna `session.agent` (store real, schema da fixture determinística
 *       tests/fixtures/session_schema.sql — TICKET-RELEASE-01, zero dependência
 *       do opencode.db do host) NÃO é reescrita após os nudges. Honestidade:
 *       a sobrescrita para o default ("dante") ocorre no SERVIDOR OpenCode quando
 *       o payload não traz `agent`; esta suíte não roda o servidor. O que é
 *       provado é (i) toda requisição dos 4 nudges carrega `agent` não vazio —
 *       a pré-condição que impede o default de engajar — e (ii) o pipeline do
 *       plugin/watchdog nunca escreve em `session.agent`;
 *   (c) varredura estática src ↔ dist: cada um dos 4 call sites tem exatamente
 *       1 promptAsync e o `agent` dentro dele (0 ocorrências sem agent).
 *
 * Seam (sem mocks de decisão): dist/src REAIS, SQLite real (node:sqlite),
 *   - plugin: `default.server(input)` com `input.client._client` = transport
 *     recorder (fronteira HTTP do SDK; o SDK v2 real serializa o payload e a
 *     suíte captura o body efetivamente enviado — `agent` é mapeado pelo SDK);
 *   - watchdog: classe Watchdog real com client recorder (mesmo seam homologado
 *     em test_model_aware_wakes.mjs), capturando o argumento de promptAsync.
 *
 * Uso:  node tests/test_agent_identity_nudges.mjs
 * Exit: 0 = todos os checks PASS; 1 = há FAIL.
 */

import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

const REPO = path.resolve(import.meta.dirname, "..");
const PKG = process.env.ENSEMBLE_PKG || REPO;
const DIST = path.join(PKG, "dist/index.js");
const SRC = path.join(PKG, "src");
const TMP = path.join(REPO, ".test-scratch");
mkdirSync(TMP, { recursive: true });
const HARNESS = path.join(TMP, "_agent_identity_harness.mjs");
const SRC_COPY = path.join(TMP, "ensemble_src_agent_identity");
const ROOT = path.join(TMP, "agent_identity_suite");
// Fixture determinística do store de sessões (TICKET-RELEASE-01): nenhum
// caminho do host é lido, o DDL vive versionado junto da suíte.
const SESSION_SCHEMA = path.join(REPO, "tests", "fixtures", "session_schema.sql");
const SESSION_SCHEMA_SQL = readFileSync(SESSION_SCHEMA, "utf8");

const results = [];
const check = (name, ok, detail) => {
  results.push([name, ok]);
  console.log(`${ok ? "PASS" : "FAIL"} | ${name}${detail ? " | " + detail : ""}`);
};
const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);
/** Mapa id→agent em ordem canônica (comparação independe da ordem de inserção). */
const sortMap = (m) => Object.fromEntries(Object.entries(m).sort(([x], [y]) => (x < y ? -1 : x > y ? 1 : 0)));
const unhandled = [];
process.on("unhandledRejection", (e) => unhandled.push(e));
const tick = async (n = 8) => { for (let i = 0; i < n; i++) await new Promise((r) => setImmediate(r)); };
const count = (text, s) => text.split(s).length - 1;

/* ================================================================== *
 * 0. SINTAXE                                                         *
 * ================================================================== */
{
  const r = spawnSync(process.execPath, ["--check", DIST], { encoding: "utf8" });
  check("0) node --check dist/index.js → exit 0", r.status === 0, `status=${r.status}`);
}

/* ================================================================== *
 * 1. VARREDURA ESTÁTICA src ↔ dist DOS 4 CALL SITES (escopo do ticket) *
 *    Âncora = marcador do próprio call site (único no arquivo). A      *
 *    cópia V2 via deliverPrompt compartilha o log de âncora e é        *
 *    deliberadamente NÃO varrida (TICKET-HARNESS-21).                  *
 * ================================================================== */
const srcIndex = readFileSync(path.join(SRC, "index.ts"), "utf8");
const srcWatchdog = readFileSync(path.join(SRC, "watchdog.ts"), "utf8");
const distRaw = readFileSync(DIST, "utf8");
const SITES = [
  { id: "S1 in-review-tasks", marker: "nudgeAgent ? { agent: nudgeAgent }", token: "IN_REVIEW_NUDGE_MESSAGE" },
  { id: "S2 wake-peer", marker: "peerAgent ? { agent: peerAgent }", token: "new message(s) from teammates" },
  // TICKET-RELEASE-17: S3 (checkStalled) foi removido com o watchdog de tempo.
  { id: "S4 checkChatty", marker: "agent: chattyAgent", token: "several messages" },
];

/** Bloco do promptAsync que contém o marcador do call site (marker-first). */
function siteBlock(text, marker) {
  const mc = count(text, marker);
  if (mc !== 1) return { err: `marcador ocorre ${mc}x (esperado 1)` };
  const m = text.indexOf(marker);
  const p = text.lastIndexOf("promptAsync", m);
  if (p < 0 || m - p > 800) return { err: "promptAsync não encontrado antes do marcador" };
  const ends = [text.indexOf(".catch(", m), text.indexOf(".then(", m)].filter((x) => x > m);
  if (!ends.length) return { err: "fim do call não encontrado" };
  return { block: text.slice(p, Math.min(...ends)) };
}

for (const site of SITES) {
  for (const [label, text] of [
    ["src", site.id.startsWith("S4") ? srcWatchdog : srcIndex],
    ["dist", distRaw],
  ]) {
    const { block, err } = siteBlock(text, site.marker);
    const promptCount = block ? count(block, "promptAsync") : 0;
    const noAgentOcc = block && promptCount === 1 && !/\bagent\b/.test(block) ? 1 : 0;
    check(
      `1.${site.id} [${label}] marcador de agent único no call site`,
      !err,
      err ?? `promptAsync=${promptCount}`,
    );
    check(
      `1.${site.id} [${label}] 0 promptAsync sem agent (bloco = 1 call com agent)`,
      !err && noAgentOcc === 0 && promptCount === 1,
      `ocorrencias_sem_agent=${noAgentOcc}`,
    );
    check(
      `1.${site.id} [${label}] payload do call carrega o texto do nudge`,
      !err && block.includes(site.token),
      site.token,
    );
  }
}

/* ================================================================== *
 * 2. HARNESS DO DIST + CÓPIA DO SRC (type-stripping recusa node_modules) *
 * ================================================================== */
const REQUIRED = ["createDb", "ProgressTracker", "MemberRegistry", "MIGRATIONS", "Watchdog", "IN_REVIEW_NUDGE_MESSAGE", "inReviewNudges"];
{
  const missing = REQUIRED.filter((s) => !new RegExp(`(function|class|var|const|let)\\s+${s}\\b`).test(distRaw));
  check("2.1 dist declara os símbolos exigidos", missing.length === 0, missing.join(",") || `${REQUIRED.length} símbolos`);
  const existing = distRaw.match(/export\s*\{([^}]*)\}\s*;?\s*$/)?.[1] ?? "";
  const already = new Set(existing.split(",").map((s) => s.trim().split(/\s+as\s+/).pop()).filter(Boolean));
  const need = REQUIRED.filter((s) => !already.has(s));
  const append = need.length ? `\nexport { ${need.join(", ")} };\n` : "";
  writeFileSync(HARNESS, distRaw + append);
  check("2.2 harness do dist = bundle + apenas cláusulas de export", readFileSync(HARNESS, "utf8") === distRaw + append, `anexados=[${need.join(",")}]`);
}

function prepareSrcCopy() {
  rmSync(SRC_COPY, { recursive: true, force: true });
  cpSync(SRC, SRC_COPY, { recursive: true });
  let rewritten = 0;
  const walk = (dir) => readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(path.join(dir, e.name)) : [path.join(dir, e.name)]));
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
check("2.3 cópia do src preparada (só resolução de extensão)", prepareSrcCopy() > 0);

/* ================================================================== *
 * 3. ANTI-MOCK (fail-fast) em src copiado e bundle                    *
 * ================================================================== */
{
  const FORBIDDEN = [/\bMagicMock\b/, /\bjest\.(mock|fn|spyOn)\b/, /\bvi\.(mock|fn|spyOn)\b/, /\bsinon\b/, /unittest\.mock/, /\bspyOn\(/, /\bmockMethod\(/];
  const walk = (dir) => readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(path.join(dir, e.name)) : [path.join(dir, e.name)]));
  const offenders = [];
  for (const file of walk(SRC_COPY)) {
    if (!/\.tsx?$/.test(file)) continue;
    const text = readFileSync(file, "utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
    for (const rx of FORBIDDEN) if (rx.test(text)) offenders.push(`${path.relative(SRC_COPY, file)} :: ${rx}`);
  }
  check("3) zero mocks/stubs/spies em src/**/*.ts", offenders.length === 0, offenders.join(" | "));
  check("3) zero primitivas de mock no bundle", !/MagicMock|jest\.mock|sinon\.|vi\.mock/.test(distRaw));
}

/* ================================================================== *
 * 4. FIXTURES — session store real + bancos SQLite reais              *
 * ================================================================== */
{
  const sqlOnly = SESSION_SCHEMA_SQL.split("\n").filter((l) => !/^\s*--/.test(l)).join("\n");
  const probe = new DatabaseSync(":memory:");
  probe.exec(sqlOnly);
  const cols = new Set(probe.prepare("PRAGMA table_info(session)").all().map((c) => c.name));
  probe.close();
  check("4.0 fixture de schema presente (fonte única do DDL)", existsSync(SESSION_SCHEMA), SESSION_SCHEMA);
  check(
    "4.0 DDL hermético: sem caminho do host e com as colunas de contrato",
    !/\.local\/share\/opencode|opencode\.db/.test(sqlOnly) && ["id", "agent", "time_updated"].every((c) => cols.has(c)),
    `colunas=${cols.size}`,
  );
}
/** Store `session`/`project` com o schema da fixture determinística. */
function buildSessionStore(home, rows) {
  const storePath = path.join(home, ".local", "share", "opencode", "opencode.db");
  mkdirSync(path.dirname(storePath), { recursive: true });
  rmSync(storePath, { force: true });
  const store = new DatabaseSync(storePath);
  store.exec(SESSION_SCHEMA_SQL);
  // Falha explícita se a fixture regredir (a FK de session exige project).
  const names = store
    .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name IN ('project','session') ORDER BY name")
    .all()
    .map((d) => d.name)
    .join(",");
  if (names !== "project,session") throw new Error(`fixture incompleta (${SESSION_SCHEMA}): ${names}`);
  const now = Date.now();
  store.prepare(`INSERT INTO project (id, worktree, vcs, name, sandboxes, time_created, time_updated, time_active) VALUES (?,?,?,?,?,?,?,?)`)
    .run("proj_aid", "", null, "agent-identity", "[]", now, now, 0);
  const ins = store.prepare(`INSERT INTO session (id, project_id, slug, directory, title, version, agent, time_created, time_updated) VALUES (?,?,?,?,?,?,?,?,?)`);
  for (const [id, agent] of rows) ins.run(id, "proj_aid", id, "/tmp", id, "1", agent, now, now);
  store.close();
  return storePath;
}
/** Estado atual da coluna session.agent (read-only). */
function sessionAgents(home) {
  const s = new DatabaseSync(path.join(home, ".local", "share", "opencode", "opencode.db"), { readOnly: true });
  const out = Object.fromEntries(s.prepare("SELECT id, agent FROM session ORDER BY id").all().map((r) => [r.id, r.agent]));
  s.close();
  return out;
}
/** Recorder do watchdog (mesmo seam de test_model_aware_wakes.mjs). */
function makeWatchdogClient(calls) {
  return {
    session: {
      promptAsync: async (o) => { calls.push(o); return {}; },
      abort: async () => ({}),
    },
    tui: { showToast: async () => ({}), selectSession: async () => ({}) },
  };
}

/* ================================================================== *
 * 5. COMPORTAMENTO — roda contra dist E src                           *
 * ================================================================== */
async function runBehavior(label, mods) {
  const { createDb, Watchdog, ProgressTracker, MemberRegistry, MIGRATIONS, default: entry, IN_REVIEW_NUDGE_MESSAGE, inReviewNudges } = mods;
  check(`[${label}] API carregada (createDb, Watchdog, ProgressTracker, plugin default.server)`,
    [createDb, Watchdog, ProgressTracker, MemberRegistry, entry?.server].every((x) => x !== undefined));
  check(`[${label}] migrations reais aplicadas (${MIGRATIONS?.length ?? 0} ≥ 11)`, (MIGRATIONS?.length ?? 0) >= 11);

  const now = Date.now();
  const STALE = now - 120_000;
  const WAKE_PEER_TEXT = "[System: 1 new message(s) from teammates]";

  /* ---------- 5A) WATCHDOG (checkChatty) ---------- */

  // TICKET-RELEASE-17: checkStalled was removed with the time-based watchdog.
  // A3: checkChatty normal; A4: checkChatty alvo == lead_session_id.
  const WD = [
    { id: "chatty_n", kind: "chatty", lead: "ses_wd_chatty_n_lead", leadAgent: "dante", member: "ses_wd_chatty_n_m", agent: "build", expectAgent: "build" },
    { id: "chatty_l", kind: "chatty", lead: "ses_wd_chatty_l_m", leadAgent: "dante", member: "ses_wd_chatty_l_m", agent: "build", expectAgent: "dante" },
  ];

  const wdAgents = {};
  for (const sc of WD) {
    const home = path.join(ROOT, `${label}_${sc.id}`);
    rmSync(home, { recursive: true, force: true });
    mkdirSync(home, { recursive: true });
    // Sessão do lead == sessão do membro (stall_l/chatty_l): uma linha só, com o agent do lead.
    const storeRows = sc.lead === sc.member
      ? [[sc.member, sc.leadAgent]]
      : [[sc.member, sc.agent], [sc.lead, sc.leadAgent]];
    buildSessionStore(home, storeRows);
    mkdirSync(path.join(home, ".config", "opencode"), { recursive: true });
    const db2 = createDb(path.join(home, ".config", "opencode", "ensemble.db"));
    const tnow = Date.now();
    db2.run("INSERT INTO team (id, name, project_id, lead_session_id, status, delegate, time_created, time_updated, lead_agent) VALUES (?,?,?,?,?,?,?,?,?)",
      [`team_${sc.id}`, sc.id, "default", sc.lead, "active", 0, tnow, tnow, sc.leadAgent]);
    db2.run("INSERT INTO team_member (team_id, name, session_id, agent, status, execution_status, time_created, time_updated) VALUES (?,?,?,?,?,?,?,?)",
      [`team_${sc.id}`, `m_${sc.id}`, sc.member, sc.agent, "busy", "running", STALE, STALE]);
    const calls = [];
    const tracker = new ProgressTracker();
    const opts = {
      db: db2, client: makeWatchdogClient(calls), registry: new MemberRegistry(),
      ttlMs: 0, progressTracker: tracker, roomInactivityThresholdMs: 0,
    };
    tracker.recordPeerMessage(sc.member);
    tracker.recordPeerMessage(sc.member);
    const wd = new Watchdog({ ...opts, peerMessageLimit: 2, peerMessageWindowMs: 300_000 });
    await wd.checkChatty();
    await tick();
    const textMatch = "several messages";
    const nudges = calls.filter((c) => c.sessionID === sc.member && String(c.parts?.[0]?.text).includes(textMatch));
    wdAgents[sc.id] = nudges;
    check(`[${label}] ${sc.id}: nudge disparado 1x ao alvo`, nudges.length === 1, `nudges=${nudges.length}`);
    check(
      `[${label}] ${sc.id}: agent PRESENTE e = ${sc.expectAgent} (${sc.expectAgent === "dante" ? "team.lead_agent, alvo é o lead" : "team_member.agent do alvo"})`,
      nudges.length === 1 && typeof nudges[0].agent === "string" && nudges[0].agent === sc.expectAgent,
      JSON.stringify(nudges[0]?.agent),
    );
    const agentsAfter = sessionAgents(home);
    const expectedStore = Object.fromEntries(storeRows);
    check(
      `[${label}] ${sc.id} (b): session.agent intacto após o nudge (sem sobrescrita para dante)`,
      eq(sortMap(agentsAfter), sortMap(expectedStore)),
      JSON.stringify(agentsAfter),
    );
    db2.close();
  }

  /* ---------- 5B) PLUGIN (in-review-tasks / wake-peer) — uma instância, 2 times ---------- */
  inReviewNudges.clear();
  const pHome = path.join(ROOT, `${label}_plugin`);
  rmSync(pHome, { recursive: true, force: true });
  mkdirSync(pHome, { recursive: true });
  const SESS = {
    qa: "ses_p_qa1", tales: "ses_p_tales1", leadLead: "ses_p_lead_n", leadQa: "ses_p_leadqa",
  };
  const storeAgents = { [SESS.qa]: "clara", [SESS.tales]: "build", [SESS.leadLead]: "dante", [SESS.leadQa]: "dante" };
  buildSessionStore(pHome, Object.entries(storeAgents));

  // Projeto sem dashboard (porta 4747 não pode ser aberta pelo teste) e não-worktree.
  const PDIR = path.join(pHome, "projdir");
  mkdirSync(path.join(PDIR, ".opencode"), { recursive: true });
  writeFileSync(path.join(PDIR, ".opencode", "ensemble.json"), JSON.stringify({ dashboardPort: 0 }));

  const posts = [];
  const ok = (extra = {}) => ({ data: { ok: true, ...extra } });
  const transport = {
    post: async (o) => { posts.push({ m: "post", url: o.url, path: o.path, body: o.body }); return ok(); },
    get: async (o) => { posts.push({ m: "get", url: o.url, path: o.path }); return ok({ id: o.path?.sessionID ?? "x" }); },
    delete: async () => ok(), put: async () => ok(), patch: async () => ok(),
  };

  // Seed PRÉ-init: times, membros READY (recovery não toca em ready), task in_review.
  const ensembleFile = path.join(pHome, ".config", "opencode", "ensemble.db");
  mkdirSync(path.dirname(ensembleFile), { recursive: true });
  {
    const seed = createDb(ensembleFile);
    const t0 = Date.now();
    const team = (id, lead, leadAgent) => seed.run(
      "INSERT INTO team (id, name, project_id, lead_session_id, status, delegate, time_created, time_updated, lead_agent) VALUES (?,?,?,?,?,?,?,?,?)",
      [id, id, "default", lead, "active", 0, t0, t0, leadAgent]);
    const member = (team_id, name, session, agent) => seed.run(
      "INSERT INTO team_member (team_id, name, session_id, agent, status, execution_status, time_created, time_updated) VALUES (?,?,?,?,?,?,?,?)",
      [team_id, name, session, agent, "ready", "idle", t0 - 60_000, t0]);
    team("team_pn", SESS.leadLead, "dante");
    member("team_pn", "qa-1", SESS.qa, "clara");          // QA por agent='clara'
    member("team_pn", "tales1", SESS.tales, "build");     // membro comum
    seed.run("INSERT INTO team_task (id, team_id, content, status, priority, assignee, time_created, time_updated) VALUES (?,?,?,?,?,?,?,?)",
      ["task_pn_rev", "team_pn", "revisar", "in_review", "high", "qa-1", t0, t0]);
    team("team_pl", SESS.leadQa, "dante");                 // alvo QA É a sessão do lead
    member("team_pl", "leadqa", SESS.leadQa, "clara");
    seed.run("INSERT INTO team_task (id, team_id, content, status, priority, assignee, time_created, time_updated) VALUES (?,?,?,?,?,?,?,?)",
      ["task_pl_rev", "team_pl", "revisar lead", "in_review", "high", "leadqa", t0, t0]);
    seed.close();
  }

  let inst;
  const prevHome = process.env.HOME;
  process.env.HOME = pHome;
  try {
    inst = await entry.server({ client: { _client: transport }, directory: PDIR });
  } finally {
    process.env.HOME = prevHome;
  }
  await tick();

  // Mensagens peer ANTIGAS (>5s) inseridas PÓS-init: recovery já passou e não as consome.
  {
    const db = new DatabaseSync(ensembleFile);
    const old = Date.now() - 6000;
    const put = db.prepare("INSERT INTO team_message (id, team_id, from_name, to_name, content, delivered, time_created) VALUES (?,?,?,?,?,?,?)");
    put.run("msg_pn_qa", "team_pn", "tales1", "qa-1", "para qa", 0, old);
    put.run("msg_pn_tales", "team_pn", "qa-1", "tales1", "para tales", 0, old);
    put.run("msg_pl_leadqa", "team_pl", "tales1", "leadqa", "para lead-qa", 0, old);
    db.close();
  }
  await tick();
  const baseIdx = posts.length;

  const ev = (sessionID, type) => inst.event({ event: { type: "session.status", properties: { sessionID, status: { type } } } });
  // busy → idle dispara in-review (QA) + wake-peer (qualquer membro com msg antiga)
  await ev(SESS.qa, "busy");
  await ev(SESS.qa, "idle");
  await tick();
  await ev(SESS.tales, "busy");
  await ev(SESS.tales, "idle");
  await tick();
  await ev(SESS.leadQa, "busy");
  await ev(SESS.leadQa, "idle");
  await tick();

  const pAsync = posts.slice(baseIdx).filter((p) => String(p.url).includes("prompt_async"));
  const toSess = (s) => pAsync.filter((p) => p.path?.sessionID === s);
  const txt = (p) => String(p.body?.parts?.[0]?.text ?? "");

  const qaIn = toSess(SESS.qa).filter((p) => txt(p) === IN_REVIEW_NUDGE_MESSAGE);
  const qaWp = toSess(SESS.qa).filter((p) => txt(p) === WAKE_PEER_TEXT);
  check(`[${label}] P1 in-review-tasks (qa-1) disparado 1x`, qaIn.length === 1, `n=${qaIn.length}`);
  check(`[${label}] P1 in-review-tasks (qa-1): agent = 'clara' (team_member.agent)`, qaIn[0]?.body?.agent === "clara", JSON.stringify(qaIn[0]?.body?.agent));
  check(`[${label}] P2 wake-peer (qa-1) disparado 1x`, qaWp.length === 1, `n=${qaWp.length}`);
  check(`[${label}] P2 wake-peer (qa-1): agent = 'clara'`, qaWp[0]?.body?.agent === "clara", JSON.stringify(qaWp[0]?.body?.agent));

  const tlWp = toSess(SESS.tales).filter((p) => txt(p) === WAKE_PEER_TEXT);
  const tlIn = toSess(SESS.tales).filter((p) => txt(p) === IN_REVIEW_NUDGE_MESSAGE);
  check(`[${label}] P3 wake-peer (tales1) disparado 1x com agent = 'build'`, tlWp.length === 1 && tlWp[0].body?.agent === "build", JSON.stringify(tlWp.map((p) => p.body?.agent)));
  check(`[${label}] P3 in-review NÃO vaza para membro não-QA (tales1)`, tlIn.length === 0, `n=${tlIn.length}`);

  const lqIn = toSess(SESS.leadQa).filter((p) => txt(p) === IN_REVIEW_NUDGE_MESSAGE);
  const lqWp = toSess(SESS.leadQa).filter((p) => txt(p) === WAKE_PEER_TEXT);
  check(`[${label}] P4 in-review (alvo = sessão do lead) agent = team.lead_agent 'dante'`, lqIn.length === 1 && lqIn[0].body?.agent === "dante", JSON.stringify(lqIn.map((p) => p.body?.agent)));
  check(`[${label}] P5 wake-peer (alvo = sessão do lead) agent = team.lead_agent 'dante'`, lqWp.length === 1 && lqWp[0].body?.agent === "dante", JSON.stringify(lqWp.map((p) => p.body?.agent)));

  const expectedTotal = 5; // qa: in-review+wake-peer; tales: wake-peer; leadqa: in-review+wake-peer
  check(`[${label}] P6 volume exato: 5 prompt_async (nenhum agentless/stray)`, pAsync.length === expectedTotal, `total=${pAsync.length}`);
  check(`[${label}] P7 TODO prompt_async do plugin carrega agent não vazio (pré-condição anti-default)`,
    pAsync.length > 0 && pAsync.every((p) => typeof p.body?.agent === "string" && p.body.agent.length > 0),
    JSON.stringify(pAsync.map((p) => p.body?.agent)));

  const after = sessionAgents(pHome);
  check(`[${label}] P8 (b): session.agent dos alvos intacto após nudges (sem sobrescrita para dante)`,
    eq(sortMap(Object.fromEntries(Object.entries(after).filter(([k]) => k in storeAgents))), sortMap(storeAgents)),
    JSON.stringify(after));

  /* ---------- 5C) (b) cross-check dos watchdog: todas as requisições de nudge com agent ---------- */
  const wdAll = Object.values(wdAgents).flat();
  check(`[${label}] W-union: todos os nudges de watchdog carregam agent não vazio`,
    wdAll.length === WD.length && wdAll.every((c) => typeof c.agent === "string" && c.agent.length > 0),
    JSON.stringify(wdAll.map((c) => c.agent)));
}

const distMods = await import(HARNESS);
await runBehavior("dist", distMods);

const srcIndexMod = await import(`${SRC_COPY}/index.ts`);
const srcMods = {
  default: srcIndexMod.default,
  IN_REVIEW_NUDGE_MESSAGE: srcIndexMod.IN_REVIEW_NUDGE_MESSAGE,
  inReviewNudges: srcIndexMod.inReviewNudges,
  createDb: (await import(`${SRC_COPY}/db.ts`)).createDb,
  Watchdog: (await import(`${SRC_COPY}/watchdog.ts`)).Watchdog,
  ProgressTracker: (await import(`${SRC_COPY}/progress.ts`)).ProgressTracker,
  MemberRegistry: (await import(`${SRC_COPY}/state.ts`)).MemberRegistry,
  MIGRATIONS: (await import(`${SRC_COPY}/schema.ts`)).MIGRATIONS,
};
await runBehavior("src", srcMods);

check("4) zero unhandledRejection ao longo da suíte", unhandled.length === 0, `${unhandled.length}`);

/* ================================================================== *
 * 6. VEREDITO                                                         *
 * ================================================================== */
const failed = results.filter(([, ok]) => !ok);
console.log(`\nRESULT: ${results.length - failed.length}/${results.length} checks passed`);
if (failed.length) {
  console.log("FALHAS:");
  for (const [name] of failed) console.log(`  - ${name}`);
}
process.exit(failed.length ? 1 : 0);
