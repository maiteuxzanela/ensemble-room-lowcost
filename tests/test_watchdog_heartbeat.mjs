#!/usr/bin/env node
/**
 * Validação determinística (SEM MOCKS) do watchdog PÓS TICKET-RELEASE-17.
 *
 * Histórico: esta suíte nasceu como "Heartbeat Ativo + Imunidade a Compaction"
 * (Blindagem 4), provando que o watchdog antigo não abortava membros em
 * compactação. O TICKET-RELEASE-17 removeu INTEGRALMENTE o caminho de abort por
 * TEMPO (TTL/`timed_out` + sweep de stall), porque ele media tempo desde a
 * última escrita em `team_member` — não progresso real — e matava trabalho
 * longo legítimo (evidência: membro abortado 19s após iniciar uma espera
 * deliberada de 8,5 min). A suíte foi realinhada ao contrato novo; a
 * nomenclatura do arquivo é mantida para não quebrar as suítes que a invocam.
 *
 * Contrato verificado (src E dist, código real):
 *   F3.1  nenhum membro `busy` é abortado por tempo, não importa quão velho
 *         esteja seu `time_updated` (2h/10h);
 *   F3.2  card `in_progress` NÃO é devolvido ao pool;
 *   F3.3  nenhuma mensagem "timed out"/toast/wake de timeout ao lead;
 *   F3.4  `checkStalled` não existe mais no watchdog;
 *   F3.5  `isSessionCompacting` (probe read-only) continua íntegro e defensivo;
 *   F3.6  `checkRoomInactivity()` (alerta à Clara) PERMANECE INTACTO e dispara
 *         exatamente 1x na sala ociosa com tarefa aberta;
 *   F3.7  `checkChatty()` (não é inatividade) permanece no tick.
 *
 * Único ponto de emenda: transporte de saída (abort/promptAsync/showToast)
 * gravado num array para provar O QUE foi chamado. Bancos são SQLite reais em
 * diretório isolado; o store `session` usa o DDL versionado da fixture
 * determinística tests/fixtures/session_schema.sql (zero leitura do host).
 */

import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

const REPO = path.resolve(import.meta.dirname, "..");
const PKG = process.env.ENSEMBLE_PKG || REPO;
const DIST = path.join(PKG, "dist/index.js");
const SRC = path.join(PKG, "src");
const TMP = path.join(REPO, ".test-scratch");
mkdirSync(TMP, { recursive: true });
const SESSION_SCHEMA = path.join(REPO, "tests", "fixtures", "session_schema.sql");

const results = [];
const check = (name, ok, detail) => {
  results.push([name, ok]);
  console.log(`${ok ? "PASS" : "FAIL"} | ${name}${detail ? " | " + detail : ""}`);
};

/* ------------------------------------------------------------------ *
 * 1. Harness do dist: cópia byte-a-byte + cláusulas de export        *
 * ------------------------------------------------------------------ */
const HARNESS = path.join(TMP, "_watchdog_harness.mjs");
const distRaw = readFileSync(DIST, "utf8");
let EXPECTED_MIGRATIONS = 0;
{
  const existing = distRaw.match(/export\s*\{([^}]*)\}\s*;?\s*$/)?.[1] ?? "";
  const already = new Set(existing.split(",").map((s) => s.trim().split(/\s+as\s+/).pop()).filter(Boolean));
  const need = ["Watchdog", "ProgressTracker", "createDb", "isSessionCompacting", "MIGRATIONS", "DEFAULT_CONFIG"].filter((s) => !already.has(s));
  const append = need.length ? `\nexport { ${need.join(", ")} };\n` : "";
  writeFileSync(HARNESS, distRaw + append);
  check(
    "harness do dist é o bundle real + apenas as cláusulas de export anexadas",
    readFileSync(HARNESS, "utf8") === distRaw + append,
    `${distRaw.length} bytes de bundle; anexados=[${need.join(",")}]`,
  );
}

/* ------------------------------------------------------------------ *
 * 2. Harness do src: cópia fora de node_modules + extensão .ts       *
 * ------------------------------------------------------------------ */
const SRC_COPY = path.join(TMP, "ensemble_src");
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
const rewrittenSpecifiers = prepareSrcCopy();
check("cópia do src preparada (só extensão de import, lógica intacta)", rewrittenSpecifiers > 0, `${rewrittenSpecifiers} specifiers`);

/* ------------------------------------------------------------------ *
 * 3. Paridade estática: o caminho de tempo was removed; o resto ficou *
 * ------------------------------------------------------------------ */
const srcWd = readFileSync(path.join(SRC, "watchdog.ts"), "utf8");
// Marcadores de CÓDIGO (não de comentário): o UPDATE que marcava timed_out, a
// definição do sweep de stall e o campo ttlMs do watchdog. `ttlMs` aparece em
// state.ts (PendingPurgeApprovals) e `'timed_out'` no CHECK do schema — por isso
// o probe é a forma exata, não a palavra solta.
for (const forbidden of [
  "execution_status = 'timed_out'",
  "async checkStalled(",
  "opts.ttlMs",
  "stallThresholdMs",
  "stallMinSteps",
  "stallTokenThreshold",
]) {
  check(
    `RELEASE-17: '${forbidden}' ausente de src/watchdog.ts E do bundle`,
    !srcWd.includes(forbidden) && !distRaw.includes(forbidden),
  );
}
for (const kept of ["checkRoomInactivity", "checkChatty", "cleanupStaleWorktrees", "isSessionCompacting"]) {
  check(`RELEASE-17: '${kept}' preservado em src E dist`, srcWd.includes(kept) && distRaw.includes(kept));
}

/* ------------------------------------------------------------------ *
 * 4. Store de sessões real (schema da fixture determinística)        *
 * ------------------------------------------------------------------ */
const SESSION_SCHEMA_SQL = readFileSync(SESSION_SCHEMA, "utf8");
function buildSessionStore(storePath) {
  rmSync(storePath, { force: true });
  const store = new DatabaseSync(storePath);
  store.exec(SESSION_SCHEMA_SQL);
  const ddlNames = store
    .prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name IN ('project','session') ORDER BY name`)
    .all()
    .map((d) => d.name);
  if (ddlNames.join(",") !== "project,session") {
    store.close();
    throw new Error(`fixture incompleta (${SESSION_SCHEMA}): ${ddlNames.join(",")}`);
  }
  const now = Date.now();
  store
    .prepare(
      `INSERT INTO project (id, worktree, vcs, name, sandboxes, time_created, time_updated, time_active)
       VALUES (?,?,?,?,?,?,?,?)`,
    )
    .run("proj_watchdog", "", null, "Watchdog Suite", "[]", now, now, 0);
  const ins = store.prepare(
    `INSERT INTO session (id, project_id, slug, directory, title, version, time_created, time_updated, time_compacting)
     VALUES (?,?,?,?,?,?,?,?,?)`,
  );
  const S = (id, compacting) => ins.run(id, "proj_watchdog", id, "/tmp", id, "1", now, now, compacting);
  S("ses_active", null);
  S("ses_compacting", Date.now());
  S("ses_compaction_zero", 0);
  store.close();
  return { ddlNames: ddlNames.join(",") };
}

function recorder() {
  const calls = { abort: [], prompt: [], toast: [] };
  return {
    calls,
    client: {
      session: {
        abort: async (a) => { calls.abort.push(a); return {}; },
        promptAsync: async (a) => { calls.prompt.push(a); return {}; },
      },
      tui: { showToast: async (a) => { calls.toast.push(a); return {}; } },
    },
  };
}

const withHome = async (root, fn) => {
  const prev = process.env.HOME;
  process.env.HOME = root;
  try { return await fn(); } finally { process.env.HOME = prev; }
};

/* ------------------------------------------------------------------ *
 * 5. Suíte de comportamento — roda contra src E dist                 *
 * ------------------------------------------------------------------ */
async function runSuite(label, mods) {
  const { Watchdog, ProgressTracker, createDb, isSessionCompacting, DEFAULT_CONFIG } = mods;
  const root = path.join(TMP, `watchdog_suite_${label}`);
  rmSync(root, { recursive: true, force: true });
  const dataDir = path.join(root, ".local", "share", "opencode");
  mkdirSync(dataDir, { recursive: true });
  buildSessionStore(path.join(dataDir, "opencode.db"));

  const db = createDb(path.join(root, "ensemble.db"));
  const version = db.query("PRAGMA user_version").get().user_version;
  check(`[${label}] ensemble.db migra até user_version = MIGRATIONS.length (${EXPECTED_MIGRATIONS})`, version === EXPECTED_MIGRATIONS, `user_version=${version}`);

  const now = Date.now();
  db.run(
    `INSERT INTO team (id, name, project_id, lead_session_id, status, time_created, time_updated)
     VALUES (?,?,?,?,?,?,?)`,
    ["team_hd", "reaper-removal-suite", "default", "ses_lead", "active", now - 20 * 3600_000, now - 20 * 3600_000],
  );

  // Membros busy com carimbos MUITO antigos (2h e 10h) e cards em andamento:
  // exatamente o conjunto que o TTL antigo varreria e abortaria.
  const members = [
    { name: "two-hours", session: "ses_active", age: 2 * 3600_000 },
    { name: "ten-hours", session: "ses_compacting", age: 10 * 3600_000 },
    { name: "compaction-zero", session: "ses_compaction_zero", age: 4 * 3600_000 },
  ];
  for (const m of members) {
    const ts = now - m.age;
    db.run(
      `INSERT INTO team_member (team_id, name, session_id, agent, status, execution_status, time_created, time_updated)
       VALUES (?,?,?,?,?,?,?,?)`,
      ["team_hd", m.name, m.session, "build", "busy", "running", ts, ts],
    );
    db.run(
      `INSERT INTO team_task (id, team_id, content, status, priority, assignee, rejection_count, time_created, time_updated)
       VALUES (?,?,?,?,'high',?,0,?,?)`,
      [`t_${m.name}`, "team_hd", `work of ${m.name}`, "in_progress", m.name, ts, ts],
    );
  }

  // Atividade real no tracker (o heartbeat antigo a usaria; agora é só um
  // sinal inofensivo — não pode reabilitar abort nenhum).
  const tracker = new ProgressTracker();
  tracker.recordMessage("ses_active");

  const { calls, client } = recorder();
  const wd = new Watchdog({
    db,
    client,
    registry: {},
    progressTracker: tracker,
    peerMessageLimit: 0,
    roomInactivityThresholdMs: 0, // isola a suíte do alerta da Clara
    // silentLead:false: se ALGUM wake de timeout existisse, ele apareceria no
    // recorder — o gate silencioso não pode mascarar a regressão.
    config: { ...DEFAULT_CONFIG, silentLead: false },
  });

  // Sonda do isSessionCompacting (probe read-only preservado).
  const probeEnv = { HOME: root };
  check(`[${label}] sonda: ses_compacting > 0 → true`, isSessionCompacting("ses_compacting", probeEnv) === true);
  check(`[${label}] sonda: ses_active NULL → false`, isSessionCompacting("ses_active", probeEnv) === false);
  check(`[${label}] sonda: ses_compaction_zero (0) → false`, isSessionCompacting("ses_compaction_zero", probeEnv) === false);
  let resilient = null;
  try {
    resilient = isSessionCompacting("ses_active", { HOME: path.join(TMP, `nao_existe_${process.pid}`) });
  } catch (err) {
    resilient = `THREW:${err.message}`;
  }
  check(`[${label}] sonda defensiva: store ausente → false sem exceção`, resilient === false, String(resilient));

  check(`[${label}] checkStalled não existe mais`, typeof wd.checkStalled === "undefined");

  await withHome(root, () => wd.check());
  await new Promise((r) => setTimeout(r, 20));

  const rows = Object.fromEntries(
    db.query("SELECT name, status, execution_status, time_updated FROM team_member WHERE team_id = ?")
      .all("team_hd")
      .map((r) => [r.name, r]),
  );
  for (const m of members) {
    check(
      `[${label}] ${m.name}: busY há ${Math.round(m.age / 3600_000)}h permanece busy/running (sem abort por tempo)`,
      rows[m.name]?.status === "busy" && rows[m.name]?.execution_status === "running",
      `${rows[m.name]?.status}/${rows[m.name]?.execution_status}`,
    );
    check(
      `[${label}] ${m.name}: time_updated intocado (nenhum heartbeat artificial necessário)`,
      rows[m.name]?.time_updated === now - m.age,
      `time_updated=${rows[m.name]?.time_updated}`,
    );
    const t = db.query("SELECT status FROM team_task WHERE id = ?").get(`t_${m.name}`);
    check(`[${label}] ${m.name}: card segue in_progress (não devolvido ao pool)`, t?.status === "in_progress", String(t?.status));
  }

  check(`[${label}] ZERO session.abort no tick`, calls.abort.length === 0, `abort=${calls.abort.map((a) => a.sessionID).join(",")}`);
  const sys = db.query("SELECT content FROM team_message WHERE team_id = 'team_hd' AND from_name = 'system'").all();
  check(`[${label}] ZERO mensagem de timeout ao lead`, sys.length === 0, `rows=${sys.length}`);
  check(`[${label}] ZERO toast no tick`, calls.toast.length === 0, `toast=${calls.toast.length}`);
  check(`[${label}] ZERO wake (lead/membros) no tick`, calls.prompt.length === 0, `prompts=${calls.prompt.length}`);

  // 2º tick: idempotência.
  await withHome(root, () => wd.check());
  await new Promise((r) => setTimeout(r, 20));
  const rows2 = Object.fromEntries(
    db.query("SELECT name, status FROM team_member WHERE team_id = ?").all("team_hd").map((r) => [r.name, r]),
  );
  check(
    `[${label}] 2º tick: todos seguem busy e nenhum abort acumulado`,
    members.every((m) => rows2[m.name]?.status === "busy") && calls.abort.length === 0,
    `abort=${calls.abort.length}`,
  );
  db.close();

  /* --- Alerta da Clara (checkRoomInactivity) INTACTO -------------------- */
  {
    const root2 = path.join(TMP, `watchdog_room_${label}`);
    rmSync(root2, { recursive: true, force: true });
    mkdirSync(root2, { recursive: true });
    const db2 = createDb(path.join(root2, "ensemble.db"));
    const old = Date.now() - 120_000;
    db2.run(
      `INSERT INTO team (id, name, project_id, lead_session_id, status, time_created, time_updated)
       VALUES (?,?,?,?,?,?,?)`,
      ["team_room", "idle-room", "default", "ses_lead_room", "active", old, old],
    );
    db2.run(
      `INSERT INTO team_member (team_id, name, session_id, agent, status, execution_status, time_created, time_updated)
       VALUES (?,?,?,?,?,?,?,?)`,
      ["team_room", "clara", "ses_clara_room", "clara", "ready", "standby", old, old],
    );
    db2.run("UPDATE team_member SET is_qa = 1, role = 'qa' WHERE team_id = 'team_room' AND name = 'clara'");
    db2.run(
      `INSERT INTO team_task (id, team_id, content, status, priority, assignee, rejection_count, time_created, time_updated)
       VALUES (?,?,?,?,'high',?,0,?,?)`,
      ["t_room", "team_room", "open card", "pending", null, old, old],
    );
    const r2 = recorder();
    const wd2 = new Watchdog({
      db: db2,
      client: r2.client,
      registry: {},
      peerMessageLimit: 0,
      roomInactivityThresholdMs: 30_000,
    });
    await wd2.checkRoomInactivity();
    await new Promise((r) => setTimeout(r, 20));
    const wake = r2.calls.prompt.find((p) => p.sessionID === "ses_clara_room");
    check(
      `[${label}] Clara: sala ociosa + card aberto → wake EXATAMENTE 1x (preservado)`,
      r2.calls.prompt.filter((p) => p.sessionID === "ses_clara_room").length === 1,
      `prompts=${r2.calls.prompt.length}`,
    );
    check(
      `[${label}] Clara: texto de inatividade correto`,
      String(wake?.parts?.[0]?.text ?? "").includes("Room has been inactive"),
      String(wake?.parts?.[0]?.text ?? "(vazio)"),
    );
    db2.close();
  }
}

/* ------------------------------------------------------------------ *
 * 6. Execução                                                        *
 * ------------------------------------------------------------------ */
check("fixture de schema presente (fonte única do DDL)", existsSync(SESSION_SCHEMA), SESSION_SCHEMA);
{
  const sqlOnly = SESSION_SCHEMA_SQL.split("\n").filter((l) => !/^\s*--/.test(l)).join("\n");
  check(
    "DDL da fixture não referencia caminhos do host (~/.local/share/opencode)",
    !/\.local\/share\/opencode|opencode\.db/.test(sqlOnly),
  );
  const probe = new DatabaseSync(":memory:");
  probe.exec(SESSION_SCHEMA_SQL);
  const cols = new Set(probe.prepare("PRAGMA table_info(session)").all().map((c) => c.name));
  probe.close();
  const required = ["id", "project_id", "title", "version", "agent", "time_created", "time_updated", "time_compacting"];
  const missing = required.filter((c) => !cols.has(c));
  check("fixture reproduz as colunas de contrato da tabela session", missing.length === 0, missing.join(",") || `${required.length}/${cols.size} colunas`);
}

const distMods = await import(HARNESS);
EXPECTED_MIGRATIONS = distMods.MIGRATIONS.length;
check("dist expõe Watchdog/ProgressTracker/createDb/isSessionCompacting", typeof distMods.Watchdog === "function" && typeof distMods.isSessionCompacting === "function");
check(`MIGRATIONS extraído do bundle = ${EXPECTED_MIGRATIONS}`, EXPECTED_MIGRATIONS >= 11);
await runSuite("dist", distMods);

const srcMods = {
  ...(await import(`${SRC_COPY}/watchdog.ts`)),
  ...(await import(`${SRC_COPY}/progress.ts`)),
  ...(await import(`${SRC_COPY}/db.ts`)),
  DEFAULT_CONFIG: (await import(`${SRC_COPY}/config.ts`)).DEFAULT_CONFIG,
};
check("src carrega Watchdog/ProgressTracker/createDb/isSessionCompacting", typeof srcMods.Watchdog === "function" && typeof srcMods.isSessionCompacting === "function");
await runSuite("src", srcMods);

const failed = results.filter(([, ok]) => !ok);
console.log(`\nRESULT: ${results.length - failed.length}/${results.length} checks passed`);
if (failed.length) {
  console.log("FALHAS:");
  for (const [name] of failed) console.log(`  - ${name}`);
}
process.exit(failed.length ? 1 : 0);
