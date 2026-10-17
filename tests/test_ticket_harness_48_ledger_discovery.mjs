#!/usr/bin/env node
/**
 * TICKET-HARNESS-48 (Frente 1) — Auto-commit multi-repo UNIVERSAL via ledger.
 *
 * Cobre o caminho 5 de `discoverCandidateRepos`: repositórios derivados do LEDGER
 * que estão FORA da árvore do diretório da sala (nem aninhados dentro dela, nem
 * irmãos na pasta-pai) — o cenário real de uma sala que roda de um mount point
 * (/mnt/...) mas toca arquivos em outro mount (/home/...). Antes do HARNESS-48
 * esses repos eram silenciosamente descartados e o Portão 1 não cometia nada.
 *
 * Cenários (todos com SQLite REAL, git REAL e o bundle dist REAL — sem mocks):
 *   LD1  Sala (repo) + repo fora da árvore (out-of-tree, nem nested nem irmão)
 *        só no ledger → o Portão 1 comita EXATAMENTE no repo externo: +1 commit,
 *        árvore limpa, mensagem exata, file-set cirúrgico; a sala permanece
 *        intocada (head estável) e seu arquivo sujo NÃO é varrido.
 *   LD2  Dois repos em mounts distintos (sala + out-of-tree) ambos no ledger →
 *        AMBOS commitam atomicamente, com hashes DISTINTOS.
 *   LD3  Ledger aponta para um diretório que NÃO é repo git → ignorado sem erro
 *        (fail-graceful), nenhum commit, board concluído.
 *   LD4  Ledger aponta para um arquivo JÁ LIMPO num repo out-of-tree → nenhum
 *        commit falso ("already clean"); head do repo externo inalterado.
 *
 * PROVA DE MUTAÇÃO:
 *   M-LD1 desabilita o loop de descoberta derivada do ledger → LD1/LD2/LD4
 *         deixam de comitar o repo externo (asserções falham) e os fluxos
 *         intactos (LD3, sala sem commit) permanecem verdes.
 *
 * Único seam: cliente SDK do OpenCode (fronteira externa), reduzido a um
 * recorder determinístico de promptAsync — mesmo padrão das demais suítes do
 * repo. Nenhum componente de produção é substituído: SQLite, git e bundle dist
 * rodam reais, em mkdtempSync FORA da árvore do repositório.
 *
 * Uso: node tests/test_ticket_harness_48_ledger_discovery.mjs
 * Exit: 0 = todos os checks PASS; 1 = há FAIL.
 */

import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

const REPO = path.resolve(import.meta.dirname, "..");
const DIST = path.join(REPO, "dist/index.js");
const SRC = path.join(REPO, "src");
const SRC_TC = path.join(SRC, "tools/team-tasks-complete.ts");
const TMP = path.join(REPO, ".test-scratch", "h48ledger");
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
const REQUIRED_SYMBOLS = ["createDb", "executeTeamTasksComplete", "DEFAULT_CONFIG", "MemberRegistry", "ProgressTracker", "recordModifiedFile", "listModifiedFiles"];
const distRaw = readFileSync(DIST, "utf8");
const srcTcRaw = readFileSync(SRC_TC, "utf8");

const buildHarnessCode = (raw) => {
  const existingExport = raw.match(/export\s*\{([^}]*)\}\s*;?\s*$/)?.[1] ?? "";
  const already = new Set(existingExport.split(",").map((s) => s.trim().split(/\s+as\s+/).pop()).filter(Boolean));
  const need = REQUIRED_SYMBOLS.filter((s) => !already.has(s));
  return raw + (need.length ? `\nexport { ${need.join(", ")} };\n` : "");
};

{
  const missing = REQUIRED_SYMBOLS.filter((s) => !new RegExp(`(function|class|var|const|let)\\s+${s}\\b`).test(distRaw));
  check("harness: dist declara todos os símbolos exigidos", missing.length === 0, missing.join(",") || `${REQUIRED_SYMBOLS.length} símbolos`);
  writeFileSync(path.join(TMP, "_h48ledger_real.mjs"), buildHarnessCode(distRaw));
}
const REAL = await import(path.join(TMP, "_h48ledger_real.mjs"));

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
const headHash = (d) => git(d, ["rev-parse", "HEAD"]).out;
const headCount = (d) => Number(git(d, ["rev-list", "--count", "HEAD"]).out);
const lastMsg = (d) => git(d, ["log", "-1", "--format=%s"]).out;
const porcelain = (d) => git(d, ["status", "--porcelain"]).out;
const nameOnly = (d) => git(d, ["diff-tree", "--no-commit-id", "--name-only", "-r", "HEAD"]).out.split("\n").filter(Boolean).sort();

/** git init + identidade local + commit baseline determinístico. */
function makeRepo(dir) {
  mkdirSync(dir, { recursive: true });
  git(dir, ["init", "-q"]);
  git(dir, ["config", "user.email", "hugo.sdet@test.local"]);
  git(dir, ["config", "user.name", "Hugo SDET"]);
  writeFileSync(path.join(dir, "README.md"), `baseline ${path.basename(dir)}\n`);
  git(dir, ["add", "-A"]);
  git(dir, ["commit", "-q", "-m", "chore: baseline"]);
}

// ---------------------------------------------------------------------------
// 2. runFlow: cenários LD1–LD4 contra um módulo harness dado.
// ---------------------------------------------------------------------------
let flowSeq = 0;
async function runFlow(mod) {
  const { createDb, executeTeamTasksComplete, DEFAULT_CONFIG, MemberRegistry, ProgressTracker, recordModifiedFile } = mod;

  const sandbox = mkdtempSync(path.join(os.tmpdir(), `ensemble-h48ld-${flowSeq++}-`));
  const db = createDb(path.join(sandbox, "ensemble.db"));
  const registry = new MemberRegistry();
  const progressTracker = new ProgressTracker();

  // Único seam (fronteira de transporte): recorder determinístico de promptAsync.
  const calls = [];
  const client = {
    session: { create: async () => ({ data: { id: "ses_unused" } }), promptAsync: async (o) => { calls.push(o); return {}; }, abort: async () => ({}) },
    tui: { showToast: async () => ({}), selectSession: async () => ({}) },
    worktree: { create: async () => ({ data: {} }), remove: async () => ({}), list: async () => ({ data: [] }), reset: async () => ({}) },
    workspace: { create: async () => ({ data: {} }), remove: async () => ({}), list: async () => ({ data: [] }) },
  };
  const depsFor = (directory) => ({ db, registry, tracker: {}, purgeApprovals: {}, client, directory, config: DEFAULT_CONFIG, progressTracker });

  const got = new Map();
  const R = (name, ok, detail) => got.set(name, { ok: !!ok, detail: detail === undefined ? "" : String(detail) });
  const now = Date.now();

  const seedTeam = (id, lead) => {
    db.run("INSERT INTO project (id, name, path, status, time_created, time_updated) VALUES ('default','Default','','active',?,?) ON CONFLICT DO NOTHING", [now, now]);
    db.run("INSERT INTO team (id, name, project_id, lead_session_id, status, delegate, time_created, time_updated) VALUES (?,?,'default',?,'active',0,?,?)", [id, id, lead, now, now]);
  };
  const member = (teamId, name, ses, agent, isQa = 0, role = null) => {
    db.run(
      `INSERT INTO team_member (team_id, name, session_id, agent, status, execution_status, is_qa, role, spawn_context, time_created, time_updated, reported_to_lead)
       VALUES (?,?,?,?, 'ready', 'idle', ?, ?, NULL, ?, ?, 0)`,
      [teamId, name, ses, agent, isQa, role, now, now],
    );
    registry.register(teamId, name, ses);
  };
  const task = (teamId, id, assignee, status, content) => {
    db.run(
      "INSERT INTO team_task (id, team_id, content, status, priority, assignee, rejection_count, time_created, time_updated) VALUES (?,?,?,?,'high',?,0,?,?)",
      [id, teamId, content, status, assignee, now, now],
    );
  };
  const execute = async (deps, ses, args) => {
    try { return { res: await executeTeamTasksComplete(deps, args, ses), err: null }; }
    catch (e) { return { res: "", err: e instanceof Error ? e.message : String(e) }; }
  };
  const taskStatus = (id) => db.query("SELECT status FROM team_task WHERE id = ?").get(id)?.status;
  const suffixOf = (res) => (res.includes("locally committed: ") ? res.slice(res.indexOf("locally committed: ") + "locally committed: ".length) : "");
  const hashesOf = (res) => [...suffixOf(res).matchAll(/\(([0-9a-f]{7,})\)/g)].map((m) => m[1]);

  // ================= LD1: repo FORA da árvore da sala (só via ledger) ========
  {
    const base = path.join(sandbox, "ld1");
    const room = path.join(base, "room");
    const outrepo = path.join(base, "outside", "outrepo"); // NÃO nested, NÃO irmão
    makeRepo(room);
    makeRepo(outrepo);
    writeFileSync(path.join(room, "room-dirty.txt"), "untracked in room\n");
    writeFileSync(path.join(outrepo, "feature.txt"), "out-of-tree dirty\n");

    seedTeam("ld1", "ses_lead_ld1");
    member("ld1", "tales", "ses_tales_ld1", "build");
    member("ld1", "clara", "ses_clara_ld1", "clara", 1, "qa");
    const content = "Feat ledger out-of-tree";
    task("ld1", "TLD1", "tales", "in_review", content);
    recordModifiedFile(db, "ld1", path.join(outrepo, "feature.txt")); // SÓ o repo externo

    const roomBefore = headHash(room), roomCountBefore = headCount(room);
    const outCountBefore = headCount(outrepo);
    const r = await execute(depsFor(room), "ses_clara_ld1", { task_id: "TLD1", action: "complete" });
    const hashes = hashesOf(r.res);

    R("LD1.no-error", r.err === null, r.err);
    R("LD1.board-completed", taskStatus("TLD1") === "completed", taskStatus("TLD1"));
    R("LD1.suffix-lists-outrepo", hashes.length === 1 && r.res.includes("locally committed: outrepo ("), `res="${r.res}"`);
    R("LD1.outrepo-head-advances-one", headCount(outrepo) === outCountBefore + 1, `${outCountBefore}->${headCount(outrepo)}`);
    R("LD1.outrepo-tree-clean", porcelain(outrepo) === "", `status="${porcelain(outrepo)}"`);
    R("LD1.outrepo-message-exact", lastMsg(outrepo) === `feat(runtime): ${content}`, `msg="${lastMsg(outrepo)}"`);
    R("LD1.outrepo-commit-file-set", nameOnly(outrepo).join(",") === "feature.txt", nameOnly(outrepo).join(","));
    R("LD1.room-head-unchanged", headHash(room) === roomBefore && headCount(room) === roomCountBefore, `${roomCountBefore}->${headCount(room)}`);
    R("LD1.room-uncommitted-untouched", porcelain(room).includes("room-dirty.txt"), `status="${porcelain(room)}"`);
  }

  // ========= LD2: dois repos em mounts distintos, ambos no ledger ============
  {
    const base = path.join(sandbox, "ld2");
    const room = path.join(base, "room");
    const outrepo = path.join(base, "far", "outrepo");
    makeRepo(room);
    makeRepo(outrepo);
    writeFileSync(path.join(room, "feature.txt"), "room dirty\n");
    writeFileSync(path.join(outrepo, "feature.txt"), "out dirty\n");

    seedTeam("ld2", "ses_lead_ld2");
    member("ld2", "tales", "ses_tales_ld2", "build");
    member("ld2", "clara", "ses_clara_ld2", "clara", 1, "qa");
    const content = "Feat two mounts";
    task("ld2", "TLD2", "tales", "in_review", content);
    recordModifiedFile(db, "ld2", path.join(room, "feature.txt"));
    recordModifiedFile(db, "ld2", path.join(outrepo, "feature.txt"));

    const roomCountBefore = headCount(room);
    const outCountBefore = headCount(outrepo);
    const r = await execute(depsFor(room), "ses_clara_ld2", { task_id: "TLD2", action: "complete" });
    const hashes = hashesOf(r.res);

    R("LD2.no-error", r.err === null, r.err);
    R("LD2.two-repos-committed", hashes.length === 2, `res="${r.res}"`);
    R("LD2.two-distinct-hashes", new Set(hashes).size === 2, hashes.join(","));
    R("LD2.room-advances-one", headCount(room) === roomCountBefore + 1, `${roomCountBefore}->${headCount(room)}`);
    R("LD2.outrepo-advances-one", headCount(outrepo) === outCountBefore + 1, `${outCountBefore}->${headCount(outrepo)}`);
    R("LD2.both-clean", porcelain(room) === "" && porcelain(outrepo) === "", `room="${porcelain(room)}" out="${porcelain(outrepo)}"`);
  }

  // ============ LD3: ledger aponta para diretório NÃO-git → ignorado =========
  {
    const base = path.join(sandbox, "ld3");
    const room = path.join(base, "room");
    makeRepo(room);
    const nogit = path.join(base, "nogit");
    mkdirSync(nogit, { recursive: true });
    writeFileSync(path.join(nogit, "loose.txt"), "not in a repo\n");

    seedTeam("ld3", "ses_lead_ld3");
    member("ld3", "clara", "ses_clara_ld3", "clara", 1, "qa");
    task("ld3", "TLD3", "tales", "in_review", "Feat non-git path");
    recordModifiedFile(db, "ld3", path.join(nogit, "loose.txt"));

    const r = await execute(depsFor(room), "ses_clara_ld3", { task_id: "TLD3", action: "complete" });

    R("LD3.no-error", r.err === null, r.err);
    R("LD3.board-completed", taskStatus("TLD3") === "completed", taskStatus("TLD3"));
    R("LD3.no-suffix", !/locally committed|already clean/.test(r.res), `res="${r.res}"`);
  }

  // ==== LD4: repo out-of-tree mas arquivo do ledger JÁ LIMPO → sem commit ====
  {
    const base = path.join(sandbox, "ld4");
    const room = path.join(base, "room");
    const outrepo = path.join(base, "far", "outrepo");
    makeRepo(room);
    makeRepo(outrepo);

    seedTeam("ld4", "ses_lead_ld4");
    member("ld4", "clara", "ses_clara_ld4", "clara", 1, "qa");
    task("ld4", "TLD4", "tales", "in_review", "Feat clean repo");
    recordModifiedFile(db, "ld4", path.join(outrepo, "README.md")); // arquivo commitado, limpo

    const outBefore = headHash(outrepo), outCountBefore = headCount(outrepo);
    const r = await execute(depsFor(room), "ses_clara_ld4", { task_id: "TLD4", action: "complete" });

    R("LD4.no-error", r.err === null, r.err);
    R("LD4.already-clean-no-commit", /working tree already clean/.test(r.res), `res="${r.res}"`);
    R("LD4.outrepo-head-unchanged", headHash(outrepo) === outBefore && headCount(outrepo) === outCountBefore, `${outCountBefore}->${headCount(outrepo)}`);
  }

  try { db.close(); } catch { /* já fechado */ }
  try { rmSync(sandbox, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }); } catch { /* best effort */ }
  return got;
}

// ---------------------------------------------------------------------------
// 3. Fase REAL: cada check do fluxo é promovido a check global.
// ---------------------------------------------------------------------------
const realFlow = await runFlow(REAL);
for (const [n, v] of realFlow) check(`[real] ${n}`, v.ok, v.detail);

// ---------------------------------------------------------------------------
// 4. Verificações estáticas: paridade src↔dist do caminho 5 + anti-mock.
// ---------------------------------------------------------------------------
const LEDGER_LOOP = "for (const rawPath of ledger) {";
check("paridade src↔dist: loop de descoberta derivada do ledger presente em ambos", srcTcRaw.includes(LEDGER_LOOP) && distRaw.includes(LEDGER_LOOP));
check(
  "paridade src↔dist: discoverCandidateRepos recebe o ledger (assinatura com default)",
  srcTcRaw.includes("async function discoverCandidateRepos(dir: string, ledger: string[] = []): Promise<string[]>") &&
    distRaw.includes("rawPath of ledger"),
);
check(
  "paridade src↔dist: autoCommitApprovedTask passa o ledger à descoberta",
  srcTcRaw.includes("discoverCandidateRepos(dir, ledger)") && distRaw.includes("discoverCandidateRepos(dir, ledger)"),
);
check("resolução de toplevel por arquivo do ledger presente em src e dist", srcTcRaw.includes("gitToplevel(path.dirname(abs))") && distRaw.includes("gitToplevel(path"));

{
  const FORBIDDEN = ["je" + "st.mock", "sin" + "on", "vi.mo" + "ck", "mockImple" + "mentation"];
  const forbiddenRe = new RegExp(FORBIDDEN.join("|"), "i");
  check("anti-mock: suíte não contém marcadores proibidos", !forbiddenRe.test(readFileSync(import.meta.filename, "utf8")));
}

// ---------------------------------------------------------------------------
// 5. PROVA DE MUTAÇÃO: patch determinístico no bundle dist + reexecução.
// ---------------------------------------------------------------------------
const MUTATIONS = [
  {
    id: "M-LD1",
    desc: "descoberta de repos derivados do ledger desabilitada (repos fora da árvore da sala não comitam)",
    from: "for (const rawPath of ledger) {",
    to: "for (const rawPath of []) {",
    detect: [
      "LD1.suffix-lists-outrepo",
      "LD1.outrepo-head-advances-one",
      "LD1.outrepo-tree-clean",
      "LD1.outrepo-message-exact",
      "LD1.outrepo-commit-file-set",
      "LD2.two-repos-committed",
      "LD2.outrepo-advances-one",
      "LD4.already-clean-no-commit",
    ],
    unaffected: ["LD1.room-head-unchanged", "LD2.room-advances-one", "LD3.no-suffix", "LD1.board-completed"],
  },
];

const countOcc = (hay, needle) => hay.split(needle).length - 1;
for (const m of MUTATIONS) {
  for (const n of [...m.detect, ...m.unaffected]) {
    check(`${m.id}: sentinela "${n}" existe nos checks reais`, realFlow.has(n), "");
  }
  const occurrences = countOcc(distRaw, m.from);
  check(`${m.id}: patch aplicável (1 ocorrência exata no dist)`, occurrences === 1, `ocorrências=${occurrences}`);
  if (occurrences !== 1) continue;

  const mutantFile = path.join(TMP, `_h48ledger_${m.id.toLowerCase()}.mjs`);
  writeFileSync(mutantFile, buildHarnessCode(distRaw.split(m.from).join(m.to)));

  let mutantFlow;
  try {
    const mutantMod = await import(mutantFile);
    mutantFlow = await runFlow(mutantMod);
  } catch (err) {
    check(`${m.id}: mutante executável (fluxo roda por completo)`, false, String(err));
    continue;
  }
  check(`${m.id}: mutante executável (fluxo roda por completo)`, mutantFlow.size === realFlow.size, `checks=${mutantFlow.size}/${realFlow.size}`);

  const missed = m.detect.filter((n) => mutantFlow.get(n)?.ok !== false);
  check(
    `${m.id}: asserções sensíveis — mutação detectada [${m.desc}]`,
    missed.length === 0,
    missed.length ? `não detectaram: ${missed.join(", ")}` : `${m.detect.length}/${m.detect.length} sentinelas falharam`,
  );

  const broken = m.unaffected.filter((n) => mutantFlow.get(n)?.ok !== true);
  check(
    `${m.id}: mutação cirúrgica — fluxos intactos preservados`,
    broken.length === 0,
    broken.length ? `quebrou: ${broken.join(", ")}` : `${m.unaffected.length}/${m.unaffected.length} verdes preservados`,
  );
}

// ---------------------------------------------------------------------------
// Relatório
// ---------------------------------------------------------------------------
const passed = results.filter(([, ok]) => ok).length;
const total = results.length;
console.log(`\nRESULT: ${passed}/${total} checks passed, ${unhandled.length} unhandled rejections`);
process.exit(passed === total && unhandled.length === 0 ? 0 : 1);
