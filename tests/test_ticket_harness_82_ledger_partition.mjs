#!/usr/bin/env node
/**
 * QUALITY GATE DETERMINÍSTICO — Ledger de auto-commit PARTICIONADO POR CARD
 * (TICKET-HARNESS-82 + TICKET-HARNESS-87, Item 3)
 * @maiteuxzanela/ensemble-room-lowcost
 *
 * Engenheiro de Testes (SDET): Hugo. Guardiã do Quality Gate: Clara.
 *
 * Sob teste (src/ e dist/ REAIS, SQLite real via node:sqlite, git REAL em
 * sandbox — SEM MOCKS):
 *   - src/schema.ts: Migration 21 declarativa (PRAGMA user_version) adiciona
 *     `task_id TEXT` NULLABLE a `team_modified_file` + índice
 *     `team_modified_file_task_idx`; um banco legado v20 é migrado para v21
 *     preservando as linhas antigas com `task_id = NULL`.
 *   - src/modified-files.ts: recordModifiedFile(db, team, path, taskId?),
 *     listModifiedFiles(db, team, taskId?) (filtro ESTRITO por card) e a
 *     atribuição automática de task_id no hook recordFileFromToolCall
 *     (card próprio in_progress > único in_progress da sala > único in_review).
 *   - src/tools/team-tasks-complete.ts: autoCommitApprovedTask(taskId) comita
 *     SOMENTE os arquivos do card aprovado, com fallback seguro para o ledger
 *     inteiro da sala quando o card não tem arquivo próprio; a mensagem vira
 *     `feat(runtime): <título enxuto>` (primeira linha ≤ 100 chars) + corpo
 *     estruturado opcional (`Card:` / `Files:`), sem despejar o prompt cru.
 *
 * Cobertura:
 *   A1  Migration 21 é declarativa, nullable e indexada.
 *   A2  Banco novo: user_version === MIGRATIONS.length; task_id TEXT nullable.
 *   A3  Banco legado v20 → v21: coluna criada, linha antiga preservada com NULL.
 *   A4  applyMigrations é idempotente (segunda chamada não reaplica).
 *   B1  listModifiedFiles(taskId) filtra ESTRITAMENTE por card.
 *   B2  Re-edição com task_id atualiza a partição sem duplicar linha.
 *   B3  Re-edição SEM task_id preserva o vínculo anterior (COALESCE).
 *   B4  Hook atribui a edição ao card próprio in_progress do membro.
 *   B5  Contexto ambíguo (2 cards ativos, membro sem card) → task_id NULL.
 *   B6  Único card in_review da sala recebe a edição (suíte SDET / rework).
 *   C1  Aprovar o card A comita SÓ o arquivo de A; o arquivo de B fica intocado.
 *   C2  Corpo estruturado: `Card: <id>` + `Files: <n>`.
 *   C3  Aprovar o card B comita SÓ o arquivo de B.
 *   C4  Fallback seguro: card sem arquivo próprio usa o ledger da sala.
 *   C5  Título longo (~1k chars) → subject ≤ 100 chars, 1 linha, com elipse,
 *       e o prompt cru NUNCA aparece no corpo do commit.
 *   Estáticos: paridade src↔dist (Migration 21, helpers de mensagem, fallback)
 *       + ausência do despejo `feat(runtime): ${taskContent}` + anti-mock.
 *
 * Único seam: cliente SDK do OpenCode (fronteira externa) reduzido a um
 * recorder determinístico de promptAsync — mesmo padrão das demais suítes.
 * SQLite e git rodam REAIS; o SQLite de scratch vive FORA da árvore do repo.
 *
 * Uso: node tests/test_ticket_harness_82_ledger_partition.mjs
 * Exit: 0 = todos os checks PASS; 1 = há FAIL.
 */

import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

const REPO = path.resolve(import.meta.dirname, "..");
const PKG = process.env.ENSEMBLE_PKG || REPO;
const DIST = path.join(PKG, "dist/index.js");
const SRC = path.join(REPO, "src");
const TMP = path.join(REPO, ".test-scratch");
mkdirSync(TMP, { recursive: true });

const results = [];
const check = (name, ok, detail) => {
  results.push([name, ok]);
  console.log(`${ok ? "PASS" : "FAIL"} | ${name}${detail ? " | " + detail : ""}`);
};

const unhandled = [];
process.on("unhandledRejection", (e) => unhandled.push(e));

// ---------------------------------------------------------------------------
// 0. Harness: dist real + exportação dos símbolos sob teste (sem mocks).
// ---------------------------------------------------------------------------
const REQUIRED_SYMBOLS = [
  "createDb",
  "executeTeamTasksComplete",
  "DEFAULT_CONFIG",
  "MemberRegistry",
  "ProgressTracker",
  "applyMigrations",
  "MIGRATIONS",
  "recordModifiedFile",
  "recordFileFromToolCall",
  "listModifiedFiles",
  "summarizeCommitTitle",
  "formatCardCommitMessage",
];
const distRaw = readFileSync(DIST, "utf8");

const buildHarnessCode = (raw) => {
  const existingExport = raw.match(/export\s*\{([^}]*)\}\s*;?\s*$/)?.[1] ?? "";
  const already = new Set(existingExport.split(",").map((s) => s.trim().split(/\s+as\s+/).pop()).filter(Boolean));
  const need = REQUIRED_SYMBOLS.filter((s) => !already.has(s));
  return raw + (need.length ? `\nexport { ${need.join(", ")} };\n` : "");
};

{
  const missing = REQUIRED_SYMBOLS.filter((s) => !new RegExp(`(function|class|var|const|let)\\s+${s}\\b`).test(distRaw));
  check("harness: dist declara todos os símbolos exigidos", missing.length === 0, missing.join(",") || `${REQUIRED_SYMBOLS.length} símbolos`);
  writeFileSync(path.join(TMP, "_p82_harness.mjs"), buildHarnessCode(distRaw));
}
const REAL = await import(path.join(TMP, "_p82_harness.mjs"));

// ---------------------------------------------------------------------------
// 1. Infra: git REAL + SQLite REAL em sandbox mkdtempSync isolado.
// ---------------------------------------------------------------------------
function git(cwd, args) {
  try {
    return { ok: true, out: execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim(), code: 0 };
  } catch (e) {
    return { ok: false, out: (e.stdout ?? "").toString().trim(), err: (e.stderr ?? "").toString().trim(), code: e.status ?? -1 };
  }
}
const headCount = (dir) => Number(git(dir, ["rev-list", "--count", "HEAD"]).out);
const subject = (dir) => git(dir, ["log", "-1", "--format=%s"]).out;
const body = (dir) => git(dir, ["log", "-1", "--format=%B"]).out;
const porcelain = (dir) => git(dir, ["status", "--porcelain"]).out;
const committedNames = (dir) => git(dir, ["diff-tree", "--no-commit-id", "--name-only", "-r", "HEAD"]).out.split("\n").filter(Boolean).sort();

function makeRepo(dir) {
  mkdirSync(dir, { recursive: true });
  git(dir, ["init", "-q"]);
  git(dir, ["config", "user.email", "hugo.sdet@test.local"]);
  git(dir, ["config", "user.name", "Hugo SDET"]);
  writeFileSync(path.join(dir, "README.md"), `baseline ${path.basename(dir)}\n`);
  git(dir, ["add", "-A"]);
  git(dir, ["commit", "-q", "-m", "chore: baseline"]);
}

const sandbox = mkdtempSync(path.join(os.tmpdir(), "ensemble-p82-"));
const dbPath = path.join(sandbox, "ensemble.db");
const db = REAL.createDb(dbPath);
const registry = new REAL.MemberRegistry();
const progressTracker = new REAL.ProgressTracker(db);
const calls = [];
const client = {
  session: {
    create: async () => ({ data: { id: "ses_unused" } }),
    promptAsync: async (o) => {
      calls.push(o);
      return {};
    },
    abort: async () => ({}),
  },
  tui: { showToast: async () => ({}), selectSession: async () => ({}) },
  worktree: { create: async () => ({ data: {} }), remove: async () => ({}), list: async () => ({ data: [] }), reset: async () => ({}) },
  workspace: { create: async () => ({ data: {} }), remove: async () => ({}), list: async () => ({ data: [] }) },
};
const depsFor = (directory) => ({ db, registry, tracker: {}, purgeApprovals: {}, client, directory, config: REAL.DEFAULT_CONFIG, progressTracker });

const now = Date.now();
const seedTeam = (id, lead) => {
  db.run("INSERT INTO project (id, name, path, status, time_created, time_updated) VALUES ('default','Default','','active',?,?) ON CONFLICT DO NOTHING", [now, now]);
  db.run("INSERT INTO team (id, name, project_id, lead_session_id, status, delegate, time_created, time_updated) VALUES (?,?,'default',?,'active',0,?,?)", [id, id, lead, now, now]);
};
const addMember = (teamId, name, ses, agent, isQa = 0, role = null) => {
  db.run(
    `INSERT INTO team_member (team_id, name, session_id, agent, status, execution_status, is_qa, role, spawn_context, time_created, time_updated, reported_to_lead)
     VALUES (?,?,?,?, 'ready', 'idle', ?, ?, NULL, ?, ?, 0)`,
    [teamId, name, ses, agent, isQa, role, now, now],
  );
  registry.register(teamId, name, ses);
};
const addTask = (teamId, id, assignee, status, content, assigneeTime = now) => {
  db.run(
    "INSERT INTO team_task (id, team_id, content, status, priority, assignee, rejection_count, time_created, time_updated) VALUES (?,?,?,?,'high',?,0,?,?)",
    [id, teamId, content, status, assignee, assigneeTime, assigneeTime],
  );
};
const complete = async (directory, ses, taskId) => {
  try {
    return { res: await REAL.executeTeamTasksComplete(depsFor(directory), { task_id: taskId, action: "complete" }, ses), err: null };
  } catch (e) {
    return { res: "", err: e instanceof Error ? e.message : String(e) };
  }
};

// ---------------------------------------------------------------------------
// 2. A — Migration 21 declarativa (PRAGMA user_version) + retrocompatibilidade.
// ---------------------------------------------------------------------------
{
  const sql = REAL.MIGRATIONS?.[20] ?? "";
  check(
    "A1.migration-21-declarativa-nullable-indexada",
    sql.includes("ALTER TABLE team_modified_file ADD COLUMN task_id TEXT") &&
      sql.includes("team_modified_file_task_idx") &&
      !/NOT NULL/i.test(sql),
    sql.slice(0, 120),
  );

  const version = db.query("PRAGMA user_version").get().user_version;
  check("A2.user_version-atual-eh-o-total-de-migrations", version === REAL.MIGRATIONS.length, `${version}/${REAL.MIGRATIONS.length}`);

  const cols = db.query("PRAGMA table_info(team_modified_file)").all();
  const taskCol = cols.find((c) => c.name === "task_id");
  check("A2.coluna-task_id-TEXT-nullable", !!taskCol && String(taskCol.type).toUpperCase() === "TEXT" && Number(taskCol.notnull) === 0, JSON.stringify(taskCol));
  const idx = db.query("PRAGMA index_list(team_modified_file)").all().map((i) => i.name);
  check("A2.indice-por-card-presente", idx.includes("team_modified_file_task_idx"), idx.join(","));
}
{
  // Banco LEGADO v20: cria no schema atual, remove a coluna/índice da Migration
  // 21 e volta o user_version para 20 — exatamente o estado de um banco real
  // anterior ao ticket. applyMigrations deve reconstruir só o delta.
  const legacyPath = path.join(sandbox, "legacy-v20.db");
  const legacy = REAL.createDb(legacyPath);
  legacy.exec("DROP INDEX IF EXISTS team_modified_file_task_idx");
  legacy.exec("ALTER TABLE team_modified_file DROP COLUMN task_id");
  legacy.exec("PRAGMA user_version = 20");
  const legacyNow = Date.now();
  legacy.run("INSERT INTO project (id, name, path, status, time_created, time_updated) VALUES ('default','Default','','active',?,?) ON CONFLICT DO NOTHING", [legacyNow, legacyNow]);
  legacy.run(
    "INSERT INTO team (id, name, project_id, lead_session_id, status, delegate, time_created, time_updated) VALUES ('legacy','legacy','default','ses_legacy','active',0,?,?)",
    [legacyNow, legacyNow],
  );
  legacy.run("INSERT INTO team_modified_file (team_id, file_path, time_created) VALUES ('legacy', '/tmp/legacy-row.ts', ?)", [legacyNow]);
  const beforeCols = legacy.query("PRAGMA table_info(team_modified_file)").all().map((c) => c.name);
  check("A3.pre-condicao-banco-legado-sem-task_id", !beforeCols.includes("task_id"), beforeCols.join(","));
  legacy.close();

  const upgraded = REAL.createDb(legacyPath);
  const v = upgraded.query("PRAGMA user_version").get().user_version;
  const rows = upgraded.query("SELECT team_id, file_path, task_id FROM team_modified_file").all();
  check("A3.banco-legado-migrado-para-21", v === REAL.MIGRATIONS.length, String(v));
  check(
    "A3.linha-legada-preservada-com-task_id-NULL",
    rows.length === 1 && rows[0].file_path === "/tmp/legacy-row.ts" && rows[0].task_id === null,
    JSON.stringify(rows),
  );

  REAL.applyMigrations(upgraded);
  const v2 = upgraded.query("PRAGMA user_version").get().user_version;
  check("A4.applyMigrations-idempotente", v2 === REAL.MIGRATIONS.length, String(v2));
  upgraded.close();
}

// ---------------------------------------------------------------------------
// 3. B — API do ledger particionado (filtro estrito + atribuição pelo hook).
// ---------------------------------------------------------------------------
{
  seedTeam("p82-b", "ses_lead_p82_b");
  const fileA = path.join(sandbox, "b", "a.ts");
  const fileB = path.join(sandbox, "b", "b.ts");
  const fileC = path.join(sandbox, "b", "c.ts");

  REAL.recordModifiedFile(db, "p82-b", fileA, "TA");
  REAL.recordModifiedFile(db, "p82-b", fileB, "TB");
  REAL.recordModifiedFile(db, "p82-b", fileC);

  const all = REAL.listModifiedFiles(db, "p82-b");
  const onlyA = REAL.listModifiedFiles(db, "p82-b", "TA");
  const onlyB = REAL.listModifiedFiles(db, "p82-b", "TB");
  const unknown = REAL.listModifiedFiles(db, "p82-b", "TZ");
  check("B1.ledger-inteiro-tem-3-arquivos", all.length === 3, JSON.stringify(all));
  check("B1.filtro-estrito-TA", onlyA.length === 1 && onlyA[0] === fileA, JSON.stringify(onlyA));
  check("B1.filtro-estrito-TB", onlyB.length === 1 && onlyB[0] === fileB, JSON.stringify(onlyB));
  check("B1.card-sem-arquivos-retorna-vazio", unknown.length === 0, JSON.stringify(unknown));

  // B2 — re-edição do MESMO arquivo por outro card: partição muda, sem duplicar.
  REAL.recordModifiedFile(db, "p82-b", fileC, "TA");
  const taAfter = REAL.listModifiedFiles(db, "p82-b", "TA").sort();
  const allAfter = REAL.listModifiedFiles(db, "p82-b");
  check(
    "B2.re-edicao-migra-a-particao-sem-duplicar",
    taAfter.length === 2 && taAfter.includes(fileA) && taAfter.includes(fileC) && allAfter.length === 3,
    `ta=${JSON.stringify(taAfter)} all=${allAfter.length}`,
  );

  // B3 — edição SEM task_id não apaga o vínculo anterior (COALESCE).
  REAL.recordModifiedFile(db, "p82-b", fileA);
  const taFinal = REAL.listModifiedFiles(db, "p82-b", "TA").sort();
  check(
    "B3.edicao-sem-task_id-preserva-vinculo",
    taFinal.includes(fileA) && taFinal.includes(fileC),
    JSON.stringify(taFinal),
  );
}
{
  // B4/B5/B6 — atribuição automática no hook recordFileFromToolCall.
  seedTeam("p82-h", "ses_lead_p82_h");
  addMember("p82-h", "tales", "ses_tales_p82_h", "build");
  addMember("p82-h", "hugo", "ses_hugo_p82_h", "hugo");
  addMember("p82-h", "clara", "ses_clara_p82_h", "clara", 1, "qa");
  addTask("p82-h", "TH1", "tales", "in_progress", "Card do Tales", now + 10);
  addTask("p82-h", "TH2", "clara", "in_progress", "Card paralelo da Clara", now + 20);

  const own = path.join(sandbox, "h", "own.ts");
  REAL.recordFileFromToolCall(db, registry, "ses_tales_p82_h", "edit", { filePath: own });
  const ownBind = db.query("SELECT task_id FROM team_modified_file WHERE team_id = ? AND file_path = ?").get("p82-h", own);
  check("B4.hook-atribui-ao-card-proprio-in_progress", ownBind?.task_id === "TH1", JSON.stringify(ownBind));

  // Membro sem card próprio + 2 in_progress → ambíguo → NULL.
  const ambiguous = path.join(sandbox, "h", "ambiguous.ts");
  REAL.recordFileFromToolCall(db, registry, "ses_hugo_p82_h", "edit", { filePath: ambiguous });
  const ambBind = db.query("SELECT task_id FROM team_modified_file WHERE team_id = ? AND file_path = ?").get("p82-h", ambiguous);
  check("B5.contexto-ambiguo-fica-NULL", ambBind?.task_id === null, JSON.stringify(ambBind));

  // tool que não muta arquivo nunca entra no ledger.
  REAL.recordFileFromToolCall(db, registry, "ses_hugo_p82_h", "read", { filePath: path.join(sandbox, "h", "read.ts") });
  const readRows = db.query("SELECT COUNT(*) AS c FROM team_modified_file WHERE team_id = ? AND file_path LIKE '%read.ts'").get("p82-h");
  check("B5.tool-de-leitura-nao-registra", Number(readRows.c) === 0, JSON.stringify(readRows));

  // B6 — apenas UM card in_review na sala → a edição do SDET pertence a ele.
  db.run("UPDATE team_task SET status = 'completed' WHERE id IN ('TH1','TH2')");
  addTask("p82-h", "TH3", "tales", "in_review", "Card sob revisão", now + 30);
  const reviewFile = path.join(sandbox, "h", "sdet-test.mjs");
  REAL.recordFileFromToolCall(db, registry, "ses_hugo_p82_h", "write", { filePath: reviewFile });
  const revBind = db.query("SELECT task_id FROM team_modified_file WHERE team_id = ? AND file_path = ?").get("p82-h", reviewFile);
  check("B6.unico-in_review-recebe-edicao-do-SDET", revBind?.task_id === "TH3", JSON.stringify(revBind));
}

// ---------------------------------------------------------------------------
// 4. C — auto-commit PARTICIONADO por card em repo git REAL.
// ---------------------------------------------------------------------------
{
  const dir = path.join(sandbox, "c", "repo");
  makeRepo(dir);
  const fileA = path.join(dir, "card-a.txt");
  const fileB = path.join(dir, "card-b.txt");
  const fileC = path.join(dir, "card-c.txt");
  writeFileSync(fileA, "card a\n");
  writeFileSync(fileB, "card b\n");
  writeFileSync(fileC, "card c (sem task binding)\n");

  seedTeam("p82-c", "ses_lead_p82_c");
  addMember("p82-c", "tales", "ses_tales_p82_c", "build");
  addMember("p82-c", "clara", "ses_clara_p82_c", "clara", 1, "qa");
  const contentA = "Feat card A enxuto";
  const contentB = "Feat card B enxuto";
  const contentC = "Feat card C fallback";
  addTask("p82-c", "TA", "tales", "in_review", contentA);
  addTask("p82-c", "TB", "tales", "in_review", contentB);
  addTask("p82-c", "TC", "tales", "in_review", contentC);
  REAL.recordModifiedFile(db, "p82-c", fileA, "TA");
  REAL.recordModifiedFile(db, "p82-c", fileB, "TB");
  REAL.recordModifiedFile(db, "p82-c", fileC); // sem task → fallback

  const countBefore = headCount(dir);
  const rA = await complete(dir, "ses_clara_p82_c", "TA");
  check("C1.aprovacao-card-A-sem-erro", rA.err === null, rA.err);
  check("C1.card-A-comitado", /Task completed and locally committed: .*\([0-9a-f]{7,}\)/.test(rA.res), rA.res);
  check("C1.card-A-avanca-um-commit", headCount(dir) === countBefore + 1, `${countBefore}->${headCount(dir)}`);
  check(
    "C1.card-A-comita-SO-o-proprio-arquivo",
    committedNames(dir).join(",") === "card-a.txt",
    committedNames(dir).join(","),
  );
  check("C1.arquivo-do-card-B-permanece-intocado", porcelain(dir).includes("?? card-b.txt"), porcelain(dir));
  check("C2.subject-enxuto-do-card-A", subject(dir) === `feat(runtime): ${contentA}`, subject(dir));
  const bodyA = body(dir);
  const bodyARest = bodyA.split("\n").slice(1).join("\n").trim();
  check("C2.corpo-estruturado-Card-e-Files", bodyARest === "Card: TA\nFiles: 1", bodyARest);
  check("C2.corpo-sem-prompt-cru", !bodyARest.includes(contentA), bodyARest);

  const rB = await complete(dir, "ses_clara_p82_c", "TB");
  check("C3.aprovacao-card-B-sem-erro", rB.err === null, rB.err);
  check("C3.card-B-comita-SO-o-proprio-arquivo", committedNames(dir).join(",") === "card-b.txt", committedNames(dir).join(","));
  check("C3.subject-do-card-B", subject(dir) === `feat(runtime): ${contentB}`, subject(dir));
  check("C3.card-A-nao-vaza-para-o-B", !body(dir).includes("Card: TA"), body(dir));

  const rC = await complete(dir, "ses_clara_p82_c", "TC");
  check("C4.fallback-card-sem-arquivos-sem-erro", rC.err === null, rC.err);
  check("C4.fallback-comita-ledger-da-sala", committedNames(dir).join(",") === "card-c.txt", committedNames(dir).join(","));
  check("C4.subject-do-fallback", subject(dir) === `feat(runtime): ${contentC}`, subject(dir));
  check("C4.corpo-do-fallback", body(dir).includes("Card: TC"), body(dir));
  check("C4.arvore-limpa-ao-final", porcelain(dir) === "", porcelain(dir));
}
{
  // C5 — card com prompt longo (~1k chars): primeira linha ≤ 100, sem despejo.
  const dir = path.join(sandbox, "c", "long-repo");
  makeRepo(dir);
  const fileL = path.join(dir, "long.txt");
  writeFileSync(fileL, "long card\n");

  seedTeam("p82-l", "ses_lead_p82_l");
  addMember("p82-l", "tales", "ses_tales_p82_l", "build");
  addMember("p82-l", "clara", "ses_clara_p82_l", "clara", 1, "qa");
  const longContent =
    "TICKET-HARNESS-87 (Item 3): Partição do ledger e mensagem de commit enxuta no Portão 1. " +
    "Este é o prompt cru do orquestrador que NUNCA deve ser despejado no git log. ".repeat(12);
  addTask("p82-l", "LONG", "tales", "in_review", longContent);
  REAL.recordModifiedFile(db, "p82-l", fileL, "LONG");

  const countBefore = headCount(dir);
  const r = await complete(dir, "ses_clara_p82_l", "LONG");
  const subj = subject(dir);
  const bodyL = body(dir);
  check("C5.aprovacao-card-longo-sem-erro", r.err === null, r.err);
  check("C5.commit-criado", headCount(dir) === countBefore + 1, `${countBefore}->${headCount(dir)}`);
  check("C5.subject-primeira-linha-ate-100", subj.length > 0 && subj.length <= 100 && !subj.includes("\n"), `len=${subj.length} subj="${subj}"`);
  check("C5.subject-comeca-com-prefixo-e-ticket", subj.startsWith("feat(runtime): TICKET-HARNESS-87 (Item 3):"), subj);
  check("C5.subject-truncado-com-elipse", subj.endsWith("…"), subj);
  check("C5.corpo-curto-e-estruturado", bodyL.includes("Card: LONG") && bodyL.length < 200, `len=${bodyL.length}`);
  check(
    "C5.prompt-cru-ausente-do-commit",
    !bodyL.includes("Este é o prompt cru do orquestrador") && !bodyL.includes(longContent.slice(400, 520)),
    `len=${bodyL.length}`,
  );
  check("C5.arvore-limpa", porcelain(dir) === "", porcelain(dir));
}

// ---------------------------------------------------------------------------
// 5. Estáticos: paridade src↔dist + remoção do despejo + anti-mock.
// ---------------------------------------------------------------------------
const SRC_SCHEMA = readFileSync(path.join(SRC, "schema.ts"), "utf8");
const SRC_MF = readFileSync(path.join(SRC, "modified-files.ts"), "utf8");
const SRC_TC = readFileSync(path.join(SRC, "tools", "team-tasks-complete.ts"), "utf8");

check(
  "E1.paridade-schema-Migration-21-src-dist",
  SRC_SCHEMA.includes("ALTER TABLE team_modified_file ADD COLUMN task_id TEXT") &&
    distRaw.includes("ALTER TABLE team_modified_file ADD COLUMN task_id TEXT") &&
    SRC_SCHEMA.includes("team_modified_file_task_idx") &&
    distRaw.includes("team_modified_file_task_idx"),
  "",
);
check(
  "E2.paridade-listModifiedFiles-filtro-por-card",
  SRC_MF.includes('WHERE team_id = ? AND task_id = ?') && distRaw.includes("WHERE team_id = ? AND task_id = ?"),
  "",
);
check(
  "E3.paridade-preservacao-de-vinculo-COALESCE",
  SRC_MF.includes("COALESCE(excluded.task_id, team_modified_file.task_id)") &&
    distRaw.includes("COALESCE(excluded.task_id, team_modified_file.task_id)"),
  "",
);
check(
  "E4.paridade-helpers-de-mensagem-src-dist",
  ["summarizeCommitTitle", "formatCardCommitMessage", "COMMIT_FIRST_LINE_MAX = 100", "ledger-fallback"].every(
    (lit) => (SRC_TC.includes(lit) || SRC_MF.includes(lit)) && distRaw.includes(lit),
  ),
  "",
);
check(
  "E5.despejo-do-prompt-cru-removido",
  !SRC_TC.includes("feat(runtime): ${taskContent}") && !distRaw.includes("feat(runtime): ${taskContent}"),
  "",
);
check(
  "E6.autoCommit-recebe-o-task_id-do-card",
  SRC_TC.includes("autoCommitApprovedTask(deps, teamInfo.teamId, task.content, task.id)") &&
    distRaw.includes("autoCommitApprovedTask(deps, teamInfo.teamId, task.content, task.id)"),
  "",
);

{
  const FORBIDDEN = ["je" + "st.mock", "sin" + "on", "vi.mo" + "ck", "mockImple" + "mentation", "Magic" + "Mock"];
  const forbiddenRe = new RegExp(FORBIDDEN.join("|"), "i");
  let srcMocks = 0;
  const walk = (dir) => {
    for (const entry of readdirSync(dir)) {
      const full = path.join(dir, entry);
      if (statSync(full).isDirectory()) walk(full);
      else if (entry.endsWith(".ts") && forbiddenRe.test(readFileSync(full, "utf8"))) srcMocks++;
    }
  };
  walk(SRC);
  check("E7.anti-mock-zero-mocks-em-src", srcMocks === 0, `achados=${srcMocks}`);
  check("E7.anti-mock-suite-limpa", !forbiddenRe.test(readFileSync(import.meta.filename, "utf8")), "");
}

// ---------------------------------------------------------------------------
// 6. Cleanup + relatório.
// ---------------------------------------------------------------------------
try {
  REAL.applyMigrations(db);
  db.close();
} catch {}
try {
  rmSync(sandbox, { recursive: true, force: true });
} catch {}

const failed = results.filter(([, ok]) => !ok);
console.log(`\nRESULT: ${results.length - failed.length}/${results.length} checks passed, ${unhandled.length} unhandled rejections`);
process.exit(failed.length === 0 && unhandled.length === 0 ? 0 : 1);
