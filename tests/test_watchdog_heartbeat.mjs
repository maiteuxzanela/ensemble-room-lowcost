#!/usr/bin/env node
/**
 * Validação determinística (SEM MOCKS) do Heartbeat Ativo + Imunidade a
 * Compaction no Watchdog do @hueyexe/opencode-ensemble@0.18.0.
 *
 * Sob teste (código real, não simulado):
 *   - Watchdog.check()     → src/watchdog.ts e dist/index.js (paridade).
 *   - ProgressTracker      → classe real (src/progress.ts / bundle).
 *   - createDb/MIGRATIONS  → 11 migrações reais aplicadas num SQLite real.
 *   - session store        → SQLite real com o schema `session` extraído,
 *                            read-only, do opencode.db de produção.
 *
 * Único ponto de emenda: o transporte de saída (session.abort / promptAsync /
 * showToast) é gravado num array para que a asserção prove O QUE foi chamado.
 * Nenhuma lógica de decisão é substituída: não há mock library, nem stub de
 * banco, nem fixture falsa — os bancos são SQLite reais em diretório isolado.
 */

import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

// Pacote sob teste: a raiz deste repositório (src/ + dist/ locais).
// ENSEMBLE_PKG permite apontar a suíte para outro checkout sem editar o arquivo.
const REPO = path.resolve(import.meta.dirname, "..");
const PKG = process.env.ENSEMBLE_PKG || REPO;
const DIST = path.join(PKG, "dist/index.js");
const SRC = path.join(PKG, "src");
// Scratch isolado, recriado a cada execução e coberto pelo .gitignore.
const TMP = path.join(REPO, ".test-scratch");
mkdirSync(TMP, { recursive: true });
const PROD_SESSION_DB = path.join(process.env.HOME, ".local", "share", "opencode", "opencode.db");

const TTL_MS = 60_000;            // ttlMs do watchdog no teste (1 min)
const STALE_OFFSET_MS = 120_000;  // > TTL → membro selecionado como stale

const results = [];
const check = (name, ok, detail) => {
  results.push([name, ok]);
  console.log(`${ok ? "PASS" : "FAIL"} | ${name}${detail ? " | " + detail : ""}`);
};

/* ------------------------------------------------------------------ *
 * 1. Harness do dist: cópia byte-a-byte + apenas cláusulas de export  *
 * ------------------------------------------------------------------ */
const HARNESS = path.join(TMP, "_watchdog_harness.mjs");
const EXPORT_APPEND = "\nexport { Watchdog, ProgressTracker, createDb, isSessionCompacting };\n";
const distRaw = readFileSync(DIST, "utf8");
// Migrations count is taken from the bundle's own MIGRATIONS array at runtime
// (a hardcoded 11 became a false regression once the standby feature added
// Migration 12). Assigned right after the harness import below.
let EXPECTED_MIGRATIONS = 0;
{
  const existing = distRaw.match(/export\s*\{([^}]*)\}\s*;?\s*$/)?.[1] ?? "";
  const already = new Set(existing.split(",").map((s) => s.trim().split(/\s+as\s+/).pop()).filter(Boolean));
  const need = ["Watchdog", "ProgressTracker", "createDb", "isSessionCompacting", "MIGRATIONS"].filter((s) => !already.has(s));
  const append = need.length ? `\nexport { ${need.join(", ")} };\n` : "";
  writeFileSync(HARNESS, distRaw + append);
  check(
    "harness do dist é o bundle real + apenas as cláusulas de export anexadas",
    readFileSync(HARNESS, "utf8") === distRaw + append,
    `${distRaw.length} bytes de bundle; anexados=[${need.join(",")}]`,
  );
}

/* ------------------------------------------------------------------ *
 * 2. Harness do src: cópia fora de node_modules (type-stripping do     *
 *    Node recusa node_modules) + resolução mecânica de extensão .ts    *
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
 * 3. Paridade textual src ↔ dist dos dois guards dentro de check()     *
 * ------------------------------------------------------------------ */
function extractGuardBlock(text, startAnchor, endAnchor) {
  const a = text.indexOf(startAnchor);
  if (a < 0) return null;
  const b = text.indexOf(endAnchor, a);
  if (b < 0) return null;
  return text.slice(a, b); // exclusivo: a âncora final não faz parte do bloco
}
function normalizeGuard(block) {
  return block
    .split("\n")
    .filter((l) => !/^\s*\/\//.test(l)) // remove comentários de linha
    .join("\n")
    .replace(/log2\(/g, "log(")         // rename de bundler
    .replace(/;/g, "")
    .replace(/\s+/g, "");
}
const srcWd = readFileSync(path.join(SRC, "watchdog.ts"), "utf8");
// bloco dos DOIS guards: do firstActivityAt até antes da preservação de branch
const srcGuard = extractGuardBlock(srcWd, "const lastActive = this.progressTracker", "      // Preserve branch BEFORE abort");
const distGuard = extractGuardBlock(distRaw, "const lastActive = this.progressTracker", "      if (this.cwd && member.worktree_branch");
check(
  "paridade src↔dist dos guards de heartbeat/compaction (normalizado)",
  srcGuard !== null && distGuard !== null && normalizeGuard(srcGuard) === normalizeGuard(distGuard),
  srcGuard && distGuard ? `${normalizeGuard(srcGuard).length} chars normalizados` : "bloco não encontrado",
);
for (const marker of [
  "watchdog:heartbeat:renewed",
  "watchdog:heartbeat:compacting",
  "isSessionCompacting(member.session_id)",
  "SELECT time_compacting FROM session WHERE id = ?",
]) {
  check(`marker presente em src E dist: ${marker}`, srcWd.includes(marker) && distRaw.includes(marker));
}

/* ------------------------------------------------------------------ *
 * 4. Store de sessões real (schema extraído read-only do produção)     *
 * ------------------------------------------------------------------ */
function buildSessionStore(storePath) {
  const prod = new DatabaseSync(PROD_SESSION_DB, { readOnly: true });
  const ddl = prod
    .prepare(
      `SELECT name, sql FROM sqlite_master WHERE type='table' AND name IN ('project','session')
       ORDER BY CASE name WHEN 'project' THEN 0 ELSE 1 END`,
    )
    .all();
  prod.close();
  if (ddl.length !== 2) throw new Error(`schema real incompleto: ${ddl.map((d) => d.name).join(",")}`);

  rmSync(storePath, { force: true });
  const store = new DatabaseSync(storePath);
  for (const { sql } of ddl) store.exec(sql);

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
  S("ses_active", null);              // caso 1: heartbeat ativo
  S("ses_compacting", Date.now());    // caso 2: time_compacting > 0
  S("ses_idle", null);                // caso 3: genuinamente inativo
  S("ses_compaction_zero", 0);        // caso 4: time_compacting = 0 → não é compaction
  store.close();
  return { ddlNames: ddl.map((d) => d.name).sort().join(",") };
}

/* ------------------------------------------------------------------ *
 * 5. Suíte de comportamento — roda contra src E dist                   *
 * ------------------------------------------------------------------ */
async function runSuite(label, mods) {
  const { Watchdog, ProgressTracker, createDb, isSessionCompacting } = mods;
  const root = path.join(TMP, `watchdog_suite_${label}`);
  rmSync(root, { recursive: true, force: true });
  const dataDir = path.join(root, ".local", "share", "opencode");
  mkdirSync(dataDir, { recursive: true });
  const storePath = path.join(dataDir, "opencode.db");
  const { ddlNames } = buildSessionStore(storePath);

  const db = createDb(path.join(root, "ensemble.db")); // 11 migrações reais
  const version = db.query("PRAGMA user_version").get().user_version;
  check(`[${label}] ensemble.db migra até user_version = MIGRATIONS.length (${EXPECTED_MIGRATIONS})`, version === EXPECTED_MIGRATIONS, `user_version=${version}`);

  const now = Date.now();
  db.run(
    `INSERT INTO team (id, name, project_id, lead_session_id, status, time_created, time_updated)
     VALUES (?,?,?,?,?,?,?)`,
    ["team_hd", "heartbeat-suite", "default", "ses_lead", "active", now, now],
  );

  const staleAt = now - STALE_OFFSET_MS;
  const members = [
    { name: "active", session: "ses_active" },
    { name: "compacting", session: "ses_compacting" },
    { name: "idle", session: "ses_idle" },
    { name: "compaction-zero", session: "ses_compaction_zero" },
  ];
  for (const m of members) {
    db.run(
      `INSERT INTO team_member (team_id, name, session_id, agent, status, execution_status, time_created, time_updated)
       VALUES (?,?,?,?,?,?,?,?)`,
      ["team_hd", m.name, m.session, "build", "busy", "idle", staleAt, staleAt],
    );
  }

  // Linha real do watchdog: todos os 4 são stale → sem os guards, os 4 abortariam.
  const staleBefore = db
    .query(
      `SELECT tm.name FROM team_member tm
       JOIN team t ON tm.team_id = t.id
       WHERE t.status = 'active' AND tm.status = 'busy' AND tm.time_updated < ?`,
    )
    .all(now - TTL_MS);
  check(
    `[${label}] pré-condição: os 4 membros entram no conjunto stale do check()`,
    staleBefore.length === 4,
    staleBefore.map((r) => r.name).join(","),
  );

  // Atividade real registrada no ProgressTracker real (após o time_updated congelar).
  const tracker = new ProgressTracker();
  tracker.recordMessage("ses_active");
  const lastActive = tracker.lastActivityAt("ses_active");
  check(`[${label}] heartbeat: lastActivityAt(ses_active) > cutoff`, lastActive > now - TTL_MS, `lastActive=${lastActive}`);

  // Transporte de saída gravado (nenhuma lógica substituída).
  const calls = { abort: [], prompt: [], toast: [] };
  const client = {
    session: {
      abort: async (a) => { calls.abort.push(a); return {}; },
      promptAsync: async (a) => { calls.prompt.push(a); return {}; },
    },
    tui: { showToast: async (a) => { calls.toast.push(a); return {}; } },
  };

  const watchdog = new Watchdog({
    db,
    client,
    registry: {},
    ttlMs: TTL_MS,
    progressTracker: tracker,
    stallThresholdMs: 0,     // desliga checkStalled (fora do escopo deste teste)
    peerMessageLimit: 0,     // desliga checkChatty
    // cwd omitido → preserveBranch não entra em jogo (nenhum worktree no fixture)
  });

  // Sonda unitária antes do tick — env explícito aponta para o store isolado
  const probeEnv = { HOME: root };
  check(`[${label}] sonda: ses_compacting > 0 → true`, isSessionCompacting("ses_compacting", probeEnv) === true);
  check(`[${label}] sonda: ses_active NULL → false`, isSessionCompacting("ses_active", probeEnv) === false);
  check(`[${label}] sonda: ses_compaction_zero (0) → false`, isSessionCompacting("ses_compaction_zero", probeEnv) === false);
  let resilient = null;
  try {
    resilient = isSessionCompacting("ses_idle", { HOME: path.join(TMP, `nao_existe_ardb_${process.pid}`) });
  } catch (err) {
    resilient = `THREW:${err.message}`;
  }
  check(`[${label}] sonda defensiva: store ausente → false sem exceção`, resilient === false, String(resilient));

  const prevHome = process.env.HOME;
  process.env.HOME = root; // sessionStorePath resolve o store isolado
  try {
    await watchdog.check();

    const rows = Object.fromEntries(
      db.query("SELECT name, status, execution_status, time_updated FROM team_member WHERE team_id = ?")
        .all("team_hd")
        .map((r) => [r.name, r]),
    );
    const aborted = calls.abort.map((a) => a.sessionID);

    // Caso 1 — heartbeat ativo: NÃO abortado, time_updated renovado.
    check(`[${label}] CASO1 active: permanece busy (não abortado)`, rows.active.status === "busy" && rows.active.execution_status === "idle", `status=${rows.active.status}/${rows.active.execution_status}`);
    check(`[${label}] CASO1 active: time_updated renovado para lastActive`, rows.active.time_updated === lastActive, `time_updated=${rows.active.time_updated} lastActive=${lastActive}`);
    check(`[${label}] CASO1 active: session.abort NÃO chamado`, !aborted.includes("ses_active"), `abort=[${aborted.join(",")}]`);

    // Caso 2 — compaction: NÃO abortado enquanto time_compacting > 0.
    check(`[${label}] CASO2 compacting: permanece busy (imunidade)`, rows.compacting.status === "busy" && rows.compacting.execution_status === "idle", `status=${rows.compacting.status}/${rows.compacting.execution_status}`);
    check(`[${label}] CASO2 compacting: session.abort NÃO chamado`, !aborted.includes("ses_compacting"), `abort=[${aborted.join(",")}]`);
    check(`[${label}] CASO2 compacting: time_updated intocado (reavaliado no próximo tick)`, rows.compacting.time_updated === staleAt, `time_updated=${rows.compacting.time_updated}`);

    // Caso 3 — genuinamente inativo: abortado normalmente.
    check(`[${label}] CASO3 idle: transiciona para error/timed_out`, rows.idle.status === "error" && rows.idle.execution_status === "timed_out", `status=${rows.idle.status}/${rows.idle.execution_status}`);
    check(`[${label}] CASO3 idle: session.abort chamado exatamente 1x`, aborted.filter((s) => s === "ses_idle").length === 1, `abort=[${aborted.join(",")}]`);

    // Caso 4 — time_compacting = 0 não é compaction → aborta.
    check(`[${label}] CASO4 compaction=0: não goza imunidade (abortado)`, rows["compaction-zero"].status === "error" && aborted.includes("ses_compaction_zero"), `status=${rows["compaction-zero"].status}`);

    // Efeito secundário do abort real: aviso ao lead + toast.
    const leadMsgs = db.query("SELECT content FROM team_message WHERE from_name = 'system'").all();
    check(
      `[${label}] aborts reais notificaram o lead (${leadMsgs.length} msg)`,
      leadMsgs.length === 2 && leadMsgs.every((m) => m.content.includes("timed out")),
      leadMsgs.map((m) => m.content.slice(0, 40)).join(" | "),
    );
    check(`[${label}] toasts disparados apenas para os abortados`, calls.toast.length === 2, `toast=${calls.toast.length}`);

    // 2º tick: idempotência — heartbeat e imunidade continuam protegidos.
    await watchdog.check();
    const rows2 = Object.fromEntries(
      db.query("SELECT name, status FROM team_member WHERE team_id = ?").all("team_hd").map((r) => [r.name, r]),
    );
    const aborted2 = calls.abort.map((a) => a.sessionID);
    check(`[${label}] 2º tick: active segue busy`, rows2.active.status === "busy", `status=${rows2.active.status}`);
    check(`[${label}] 2º tick: compacting segue busy`, rows2.compacting.status === "busy", `status=${rows2.compacting.status}`);
    check(
      `[${label}] 2º tick: total de aborts segue 2 (idle + compaction-zero)`,
      aborted2.filter((s) => s === "ses_idle").length === 1 && aborted2.filter((s) => s === "ses_compaction_zero").length === 1 && aborted2.length === 2,
      `abort=[${aborted2.join(",")}]`,
    );
  } finally {
    process.env.HOME = prevHome;
    db.close();
  }
  console.log(`  schema do store usado: ${ddlNames}`);
}

/* ------------------------------------------------------------------ *
 * 6. Execução                                                        *
 * ------------------------------------------------------------------ */
check("store de produção legível (fonte do schema)", existsSync(PROD_SESSION_DB), PROD_SESSION_DB);

const distMods = await import(HARNESS);
EXPECTED_MIGRATIONS = distMods.MIGRATIONS.length;
check("dist expõe Watchdog/ProgressTracker/createDb/isSessionCompacting", typeof distMods.Watchdog === "function" && typeof distMods.isSessionCompacting === "function");
check(`MIGRATIONS extraído do bundle = ${EXPECTED_MIGRATIONS}`, EXPECTED_MIGRATIONS >= 11);
await runSuite("dist", distMods);

const srcMods = {
  ...(await import(`${SRC_COPY}/watchdog.ts`)),
  ...(await import(`${SRC_COPY}/progress.ts`)),
  ...(await import(`${SRC_COPY}/db.ts`)),
};
check("src carrega Watchdog/ProgressTracker/createDb/isSessionCompacting", typeof srcMods.Watchdog === "function" && typeof srcMods.isSessionCompacting === "function");
await runSuite("src", srcMods);

const failed = results.filter(([, ok]) => !ok);
console.log(`\nRESULT: ${results.length - failed.length}/${results.length} checks passed`);
process.exit(failed.length ? 1 : 0);
