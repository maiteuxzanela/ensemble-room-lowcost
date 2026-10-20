#!/usr/bin/env node
/**
 * TICKET-RELEASE-05 — Ledger de arquivos modificados CAPTURA artefatos gerados
 * por shell/npm (auto-commit do Portão 1 não os omite mais).
 *
 * Defeito original: o ledger `team_modified_file` só era alimentado por tools de
 * mutação direta (edit/write/patch/multiedit/...). Artefatos produzidos por
 * `bash` — `npm install` regenerando package-lock.json, `sed -i`, geradores,
 * bundlers — nunca entravam no ledger; como o Portão 1 é estritamente
 * ledger-gated e cirúrgico (`git add -- <arquivos>`, NUNCA `git add -A`), esses
 * arquivos ficavam fora do commit e a árvore terminava suja (incidente
 * TICKET-RELEASE-01).
 *
 * Solução sob teste (src/ e dist/ REAIS, git REAL, SQLite REAL — SEM MOCKS):
 *   SL1  `bash` cria artefato novo → entra no ledger.
 *   SL2  `bash` reescreve arquivo JÁ SUJO (package-lock.json) → entra no ledger
 *        (a assinatura tamanho/mtime/inode muda; um diff de status sozinho
 *        perderia o caso, que é exatamente o incidente original).
 *   SL3  `bash` DELETA arquivo rastreado → entra no ledger (staging da deleção).
 *   SL4  Arquivo já sujo ANTES e intocado pelo comando NÃO entra no ledger.
 *   SL5  node_modules / .test-scratch / .git nunca entram no ledger.
 *   SL6  `bash` sem baseline (before hook perdido) não grava nada (fail-safe:
 *        nunca varre sujeira pré-existente às cegas).
 *   SL7  Sessão fora da sala não grava; read não grava; edit/write continuam
 *        gravando (retrocompatibilidade do hook TICKET-32A).
 *   SL8  `args.cwd` explícito é respeitado (baseline/diff no diretório do comando).
 *   SL9  Teto de 400 arquivos por chamada de shell (gerador descontrolado não
 *        inunda o SQLite) com log `modified-file:shell-truncated`.
 *   SL10 Portão 1 de ponta a ponta: QA completa o card e o commit cirúrgico
 *        inclui package-lock.json + artefato novo + deleção, mantendo fora a
 *        sujeira pré-existente (stray.txt segue `??`) — árvore limpa exceto ela.
 *   SL11 Diretório não-git: `bash` não lança e não grava nada (fail-graceful).
 *   SL12 Portão 1 fail-safe com HEAD vermelho (pre-commit rejeita): sem
 *        falso-sucesso e HEAD não avança.
 *   Estáticos: literais src↔dist, wiring V1 (`index.ts`) e V2 (`v2-setup.ts`),
 *        `git add -A` ausente no caminho de auto-commit, anti-mock.
 *
 * PROVA DE MUTAÇÃO:
 *   M1 desliga o branch de shell do ledger no bundle dist
 *      (`if (SHELL_TOOLS.has(tool2))` → `if (false)`) → SL1/SL2/SL3/SL10
 *      falham (ledger vazio / commit sem os artefatos), enquanto SL4/SL5/SL6
 *      permanecem verdes — prova que a asserção observa o comportamento novo.
 *
 * Uso: node tests/test_release05_shell_ledger.mjs
 * Exit: 0 = todos os checks PASS; 1 = há FAIL.
 */

import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

const REPO = path.resolve(import.meta.dirname, "..");
const DIST = path.join(REPO, "dist/index.js");
const SRC = path.join(REPO, "src");
const SRC_MF = path.join(SRC, "modified-files.ts");
const SRC_TC = path.join(SRC, "tools/team-tasks-complete.ts");
const SRC_IDX = path.join(SRC, "index.ts");
const SRC_V2 = path.join(SRC, "v2-setup.ts");
const TMP = path.join(REPO, ".test-scratch", "release05");
mkdirSync(TMP, { recursive: true });

const results = [];
const check = (name, ok, detail) => {
  results.push([name, ok]);
  console.log(`${ok ? "PASS" : "FAIL"} | ${name}${detail ? " | " + detail : ""}`);
};

const unhandled = [];
process.on("unhandledRejection", (e) => unhandled.push(e));

const distRaw = readFileSync(DIST, "utf8");
const srcMfRaw = readFileSync(SRC_MF, "utf8");
const srcTcRaw = readFileSync(SRC_TC, "utf8");
const srcIdxRaw = readFileSync(SRC_IDX, "utf8");
const srcV2Raw = readFileSync(SRC_V2, "utf8");

// ---------------------------------------------------------------------------
// 0. Harness: bundle real + exportação dos símbolos sob teste.
// ---------------------------------------------------------------------------
const REQUIRED_SYMBOLS = [
  "createDb",
  "MemberRegistry",
  "ProgressTracker",
  "executeTeamTasksComplete",
  "DEFAULT_CONFIG",
  "captureShellBaseline",
  "recordModifiedFile",
  "recordFileFromToolCall",
  "listModifiedFiles",
];

const buildHarnessCode = (raw) => {
  const existingExport = raw.match(/export\s*\{([^}]*)\}\s*;?\s*$/)?.[1] ?? "";
  const already = new Set(existingExport.split(",").map((s) => s.trim().split(/\s+as\s+/).pop()).filter(Boolean));
  const need = REQUIRED_SYMBOLS.filter((s) => !already.has(s));
  return raw + (need.length ? `\nexport { ${need.join(", ")} };\n` : "");
};

{
  const missing = REQUIRED_SYMBOLS.filter((s) => !new RegExp(`(function|class|var|const|let)\\s+${s}\\b`).test(distRaw));
  check("harness: dist declara todos os símbolos exigidos", missing.length === 0, missing.join(",") || `${REQUIRED_SYMBOLS.length} símbolos`);
  writeFileSync(path.join(TMP, "_release05_real.mjs"), buildHarnessCode(distRaw));
}
const REAL = await import(path.join(TMP, "_release05_real.mjs"));

// ---------------------------------------------------------------------------
// 1. Infra determinística: git REAL + SQLite REAL em sandbox mkdtempSync.
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
const porcelain = (d) => git(d, ["status", "--porcelain"]).out.split("\n").filter(Boolean);
const lastCommitFiles = (d) =>
  git(d, ["show", "--name-only", "--pretty=format:", "HEAD"]).out.split("\n").filter(Boolean).sort();

/** Real git repo with a deterministic baseline commit. */
function makeRepo(base, { name = "repo", dirty = [], tracked = ["package-lock.json", "keep.txt"] } = {}) {
  const repo = path.join(base, name);
  mkdirSync(repo, { recursive: true });
  git(repo, ["init", "-q"]);
  git(repo, ["config", "user.email", "hugo.sdet@test.local"]);
  git(repo, ["config", "user.name", "Hugo SDET"]);
  writeFileSync(path.join(repo, "README.md"), "baseline\n");
  const files = {
    "package-lock.json": '{"version": 1}\n',
    "keep.txt": "keep me\n",
  };
  for (const f of tracked) writeFileSync(path.join(repo, f), files[f] ?? `${f}\n`);
  git(repo, ["add", "README.md", ...tracked]);
  git(repo, ["commit", "-q", "-m", "chore: baseline"]);
  for (const [file, content] of dirty) writeFileSync(path.join(repo, file), content);
  return repo;
}

/** Real shell subprocess (the transport under test is a real bash call). */
function sh(cwd, command) {
  return execFileSync("bash", ["-c", command], { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
}

/** Fresh env: SQLite real + registry real + room (tales member, clara QA). */
function newEnv(mod, { repo, name = "room" } = {}) {
  const base = mkdtempSync(path.join(TMP, "sandbox-"));
  const dir = repo ?? makeRepo(base, { name });
  const db = mod.createDb(path.join(base, "ensemble.db"));
  const registry = new mod.MemberRegistry();
  const progressTracker = new mod.ProgressTracker(db);
  const calls = [];
  const client = {
    session: { create: async () => ({ data: { id: "ses_unused" } }), promptAsync: async (o) => { calls.push(o); return {}; }, abort: async () => ({}) },
    tui: { showToast: async () => ({}), selectSession: async () => ({}) },
    worktree: { create: async () => ({ data: {} }), remove: async () => ({}), list: async () => ({ data: [] }), reset: async () => ({}) },
    workspace: { create: async () => ({ data: {} }), remove: async () => ({}), list: async () => ({ data: [] }) },
  };
  const deps = { db, registry, tracker: {}, purgeApprovals: {}, client, directory: dir, config: mod.DEFAULT_CONFIG, progressTracker };
  const now = Date.now();
  db.run("INSERT INTO project (id,name,path,status,time_created,time_updated) VALUES ('default','Default','','active',?,?) ON CONFLICT DO NOTHING", [now, now]);
  db.run("INSERT INTO team (id,name,project_id,lead_session_id,status,delegate,time_created,time_updated) VALUES (?,?,'default',?,'active',0,?,?)", [name, `team-${name}`, `ses_lead_${name}`, now, now]);
  const addMember = (member, ses, agent, opts = {}) => {
    db.run(
      `INSERT INTO team_member (team_id, name, session_id, agent, status, execution_status, is_qa, role, time_created, time_updated, reported_to_lead, worktree_dir)
       VALUES (?,?,?,?,'ready','idle',?,?,?,?,0,?)`,
      [name, member, ses, agent, opts.isQa ?? 0, opts.role ?? null, now, now, opts.worktree ?? dir],
    );
    registry.register(name, member, ses);
  };
  addMember("tales", `ses_tales_${name}`, "build");
  addMember("clara", `ses_clara_${name}`, "clara", { isQa: 1, role: "qa" });
  const addTask = (id, status, content, assignee = "tales") => {
    db.run(
      "INSERT INTO team_task (id,team_id,content,status,priority,assignee,rejection_count,time_created,time_updated) VALUES (?,?,?,?,'high',?,0,?,?)",
      [id, name, content, status, assignee, now, now],
    );
  };
  const ledger = () => mod.listModifiedFiles(db, name);
  const cleanup = () => {
    try { db.close(); } catch { /* já fechado */ }
    rmSync(base, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  };
  return { base, dir, db, registry, deps, ledger, addTask, cleanup, calls, teamId: name, tales: `ses_tales_${name}`, qa: `ses_clara_${name}` };
}

/** Run one bash call through the REAL hook pair (before → real shell → after). */
function shellCall(mod, env, ses, args, command, callId) {
  mod.captureShellBaseline(env.db, env.registry, ses, "bash", args, env.dir, callId);
  const out = sh(env.dir, command);
  mod.recordFileFromToolCall(env.db, env.registry, ses, "bash", args, env.dir, callId);
  return out;
}

// ---------------------------------------------------------------------------
// 2. SL1–SL5: captura de artefatos de shell (repo real).
// ---------------------------------------------------------------------------
{
  const mod = REAL;
  const env = newEnv(mod, { name: "sl1" });
  const repo = env.dir;
  // Sujeira pré-existente REAL: já suja ANTES do baseline e intocada pelo comando.
  writeFileSync(path.join(repo, "stray.txt"), "preexisting dirt\n");

  mod.captureShellBaseline(env.db, env.registry, env.tales, "bash", { command: "npm install" }, repo, "call-sl1");
  sh(repo, "echo '{\"version\": 2, \"lockfileVersion\": 3}' > package-lock.json"); // SL2: já-dirty reescrito
  sh(repo, "echo generated > dist-bundle.js");                                     // SL1: artefato novo
  sh(repo, "rm keep.txt");                                                          // SL3: deleção
  sh(repo, "mkdir -p node_modules/x .test-scratch && echo a > node_modules/x/a.js && echo b > .test-scratch/s.js");
  mod.recordFileFromToolCall(env.db, env.registry, env.tales, "bash", { command: "npm install" }, repo, "call-sl1");

  const rows = env.ledger();
  const has = (rel) => rows.includes(path.join(repo, rel));
  check("SL1 shell: artefato NOVO entra no ledger", has("dist-bundle.js"), JSON.stringify(rows));
  check("SL2 shell: arquivo JÁ SUJO reescrito entra no ledger (regressão package-lock)", has("package-lock.json"));
  check("SL3 shell: arquivo DELETADO entra no ledger (staging da deleção)", has("keep.txt"));
  check("SL4 sujeira pré-existente está realmente suja e intocada (não-vacuidade)", porcelain(repo).some((l) => l.endsWith("stray.txt")) && readFileSync(path.join(repo, "stray.txt"), "utf8") === "preexisting dirt\n", porcelain(repo).join("|"));
  check("SL4 shell: sujeira pré-existente intocada fica FORA do ledger", !has("stray.txt"));
  const relRows = rows.map((p) => path.relative(repo, p));
  check("SL5 shell: node_modules / .test-scratch / .git nunca entram no ledger",
    !relRows.some((p) => p.split(path.sep).some((s) => s === "node_modules" || s === ".test-scratch" || s === ".git")),
    JSON.stringify(relRows));
  check("SL5b shell: todo caminho do ledger é absoluto", rows.every((p) => path.isAbsolute(p)));

  // SL7: read não grava, edit grava (retrocompat TICKET-32A)
  const beforeEdit = env.ledger().length;
  mod.recordFileFromToolCall(env.db, env.registry, env.tales, "read", { filePath: path.join(repo, "README.md") }, repo);
  check("SL7 read NÃO grava no ledger", env.ledger().length === beforeEdit);
  writeFileSync(path.join(repo, "edited.ts"), "export {}\n");
  mod.recordFileFromToolCall(env.db, env.registry, env.tales, "edit", { filePath: path.join(repo, "edited.ts") }, repo);
  check("SL7 edit continua gravando (retrocompat)", env.ledger().includes(path.join(repo, "edited.ts")));

  // sessão desconhecida não grava
  const beforeUnknown = env.ledger().length;
  mod.captureShellBaseline(env.db, env.registry, "ses_desconhecida", "bash", { command: "x" }, repo, "call-x");
  writeFileSync(path.join(repo, "unknown.txt"), "x\n");
  mod.recordFileFromToolCall(env.db, env.registry, "ses_desconhecida", "bash", { command: "x" }, repo, "call-x");
  check("SL7b sessão fora da sala NÃO grava no ledger", env.ledger().length === beforeUnknown);

  env.cleanup();
}

// ---------------------------------------------------------------------------
// 3. SL6: bash sem baseline é fail-safe (não varre sujeira pré-existente).
// ---------------------------------------------------------------------------
{
  const mod = REAL;
  const env = newEnv(mod, { name: "sl6" });
  writeFileSync(path.join(env.dir, "pre-existing.txt"), "dirt from before\n");
  const before = env.ledger().length;
  sh(env.dir, "echo nope > orphan.txt");
  mod.recordFileFromToolCall(env.db, env.registry, env.tales, "bash", { command: "echo nope" }, env.dir, "call-sem-baseline");
  check("SL6 bash sem baseline não grava nada (fail-safe)", env.ledger().length === before, `ledger=${JSON.stringify(env.ledger())}`);

  // baseline de um repo e diff em outro repo → não herda sujeira alheia
  mod.captureShellBaseline(env.db, env.registry, env.tales, "bash", { command: "x" }, env.dir, "call-cross");
  mod.recordFileFromToolCall(env.db, env.registry, env.tales, "bash", { command: "x" }, env.dir, "call-outro-id");
  check("SL6b callId ausente cai no FIFO e não vaza sujeira", env.ledger().length === before);
  env.cleanup();
}

// ---------------------------------------------------------------------------
// 4. SL8: args.cwd explícito manda no baseline/diff.
// ---------------------------------------------------------------------------
{
  const mod = REAL;
  const env = newEnv(mod, { name: "sl8" });
  const other = path.join(env.base, "other-repo");
  mkdirSync(other, { recursive: true });
  git(other, ["init", "-q"]);
  git(other, ["config", "user.email", "t@t.local"]);
  git(other, ["config", "user.name", "T"]);
  writeFileSync(path.join(other, "base.txt"), "b\n");
  git(other, ["add", "-A"]);
  git(other, ["commit", "-q", "-m", "chore: base"]);

  mod.captureShellBaseline(env.db, env.registry, env.tales, "bash", { command: "gen", cwd: other }, env.dir, "call-cwd");
  sh(other, "echo artifact > artifact.txt");
  mod.recordFileFromToolCall(env.db, env.registry, env.tales, "bash", { command: "gen", cwd: other }, env.dir, "call-cwd");
  check("SL8 args.cwd explícito: artefato do repo apontado entra no ledger", env.ledger().includes(path.join(other, "artifact.txt")), JSON.stringify(env.ledger()));
  check("SL8b args.cwd explícito: nada do repo da sala entra por engano", !env.ledger().some((p) => p.startsWith(`${env.dir}${path.sep}`)));
  env.cleanup();
}

// ---------------------------------------------------------------------------
// 5. SL9: teto de 400 arquivos por chamada de shell.
// ---------------------------------------------------------------------------
{
  const mod = REAL;
  const env = newEnv(mod, { name: "sl9" });
  mod.captureShellBaseline(env.db, env.registry, env.tales, "bash", { command: "gen 420" }, env.dir, "call-cap");
  sh(env.dir, "mkdir -p gen && for i in $(seq 1 420); do echo x > gen/f$i.txt; done");
  mod.recordFileFromToolCall(env.db, env.registry, env.tales, "bash", { command: "gen 420" }, env.dir, "call-cap");
  const gen = env.ledger().filter((p) => p.includes(`${path.sep}gen${path.sep}`));
  check("SL9 teto duro de 400 arquivos por chamada de shell", gen.length === 400, `gen=${gen.length}`);
  env.cleanup();
}

// ---------------------------------------------------------------------------
// 6. SL10: Portão 1 de ponta a ponta — commit cirúrgico com artefatos de shell.
// ---------------------------------------------------------------------------
{
  const mod = REAL;
  const base = mkdtempSync(path.join(TMP, "e2e-"));
  const repo = makeRepo(base, { name: "e2e", dirty: [["stray.txt", "preexisting dirt\n"]] });
  const env = newEnv(mod, { name: "sl10", repo });
  env.addTask("T1", "in_review", "release 05 shell ledger");

  shellCall(mod, env, env.tales, { command: "npm install" }, "", "call-e2e-1");
  // uma única chamada de shell gerando os três tipos de artefato
  mod.captureShellBaseline(env.db, env.registry, env.tales, "bash", { command: "npm install" }, repo, "call-e2e-2");
  sh(repo, "echo '{\"version\": 2}' > package-lock.json && echo bundle > dist-bundle.js && rm keep.txt");
  mod.recordFileFromToolCall(env.db, env.registry, env.tales, "bash", { command: "npm install" }, repo, "call-e2e-2");

  check("SL10 ledger contém os 3 artefatos de shell", ["package-lock.json", "dist-bundle.js", "keep.txt"].every((f) => env.ledger().includes(path.join(repo, f))), JSON.stringify(env.ledger()));
  check("SL10 ledger NÃO contém a sujeira pré-existente", !env.ledger().includes(path.join(repo, "stray.txt")));

  const h0 = headHash(repo);
  const n0 = headCount(repo);
  const res = await mod.executeTeamTasksComplete(env.deps, { task_id: "T1", action: "complete" }, env.qa);
  const h1 = headHash(repo);
  check("SL10 Portão 1: commit criado (HEAD avançou, +1 commit)", h1 !== h0 && headCount(repo) === n0 + 1, `${h0.slice(0, 7)} → ${h1.slice(0, 7)}`);
  check("SL10 Portão 1: sufixo de commit na mensagem", res.includes("Task completed and locally committed"), res);
  const committed = lastCommitFiles(repo);
  check("SL10 Portão 1: package-lock.json comitado", committed.includes("package-lock.json"), committed.join(","));
  check("SL10 Portão 1: artefato gerado comitado", committed.includes("dist-bundle.js"));
  check("SL10 Portão 1: deleção comitada", committed.includes("keep.txt"));
  check("SL10 Portão 1: sujeira fora do ledger NÃO comitada", !committed.includes("stray.txt"));
  const dirty = porcelain(repo);
  check("SL10 Portão 1: stray.txt segue sujo (cirúrgico, nunca git add -A)", dirty.some((l) => l.endsWith("stray.txt")), dirty.join("|"));
  check("SL10 Portão 1: todo o resto da árvore está limpo", dirty.filter((l) => !l.endsWith("stray.txt")).length === 0, dirty.join("|"));
  env.cleanup();
  rmSync(base, { recursive: true, force: true });
}

// ---------------------------------------------------------------------------
// 7. SL11: diretório não-git — fail-graceful.
// ---------------------------------------------------------------------------
{
  const mod = REAL;
  const base = mkdtempSync(path.join(TMP, "plain-"));
  const plain = path.join(base, "not-a-repo");
  mkdirSync(plain, { recursive: true });
  const env = newEnv(mod, { name: "sl11", repo: plain });
  let threw = null;
  try {
    mod.captureShellBaseline(env.db, env.registry, env.tales, "bash", { command: "x" }, plain, "call-plain");
    sh(plain, "echo x > plain.txt");
    mod.recordFileFromToolCall(env.db, env.registry, env.tales, "bash", { command: "x" }, plain, "call-plain");
  } catch (e) {
    threw = e instanceof Error ? e.message : String(e);
  }
  check("SL11 dir não-git: nenhuma exceção", threw === null, String(threw));
  check("SL11 dir não-git: nada gravado no ledger", env.ledger().length === 0, JSON.stringify(env.ledger()));
  env.cleanup();
  rmSync(base, { recursive: true, force: true });
}

// ---------------------------------------------------------------------------
// 8. SL12: Portão 1 fail-safe quando o commit falha (HEAD "vermelho" — hook
//    pre-commit rejeita): nada de sufixo de falso-sucesso, HEAD não avança.
// ---------------------------------------------------------------------------
{
  const mod = REAL;
  const base = mkdtempSync(path.join(TMP, "redhead-"));
  const repo = makeRepo(base, { name: "redhead" });
  const hook = path.join(repo, ".git/hooks/pre-commit");
  writeFileSync(hook, "#!/bin/sh\necho 'pre-commit rejected' >&2\nexit 1\n");
  execFileSync("chmod", ["+x", hook]);
  const env = newEnv(mod, { name: "sl12", repo });
  env.addTask("T1", "in_review", "release 05 head red fail-safe");

  writeFileSync(path.join(repo, "artifact.txt"), "generated\n");
  mod.recordFileFromToolCall(env.db, env.registry, env.tales, "write", { filePath: path.join(repo, "artifact.txt") }, repo);
  check("SL12 ledger contém o artefato antes do Portão 1", env.ledger().includes(path.join(repo, "artifact.txt")));

  const h0 = headHash(repo);
  const res = await mod.executeTeamTasksComplete(env.deps, { task_id: "T1", action: "complete" }, env.qa);
  check("SL12 HEAD vermelho: HEAD NÃO avança (commit falhou)", headHash(repo) === h0, `${h0.slice(0, 7)} → ${headHash(repo).slice(0, 7)}`);
  check("SL12 HEAD vermelho: nenhum falso-sucesso 'locally committed'", !res.includes("Task completed and locally committed"), res);
  check("SL12 HEAD vermelho: o arquivo NÃO foi commitado (segue fora de HEAD)", !lastCommitFiles(repo).includes("artifact.txt"));
  env.cleanup();
  rmSync(base, { recursive: true, force: true });
}

// ---------------------------------------------------------------------------
// 9. Estáticos: literais src↔dist, wiring V1/V2, invariante cirúrgico, anti-mock.
// ---------------------------------------------------------------------------
const NEW_LITERALS = [
  "captureShellBaseline",
  "recordShellDiff",
  "SHELL_TOOLS",
  "modified-file:shell-recorded",
  "modified-file:shell-baseline-missing",
  "modified-file:shell-truncated",
  "tasks-complete:autocommit:ledger-gap",
];
for (const lit of NEW_LITERALS) {
  const inSrc = srcMfRaw.includes(lit) || srcTcRaw.includes(lit);
  check(`paridade src↔dist: "${lit}"`, inSrc && distRaw.includes(lit));
}
for (const lit of ["captureShellBaseline", "recordFileFromToolCall"]) {
  check(`wiring V1 (index.ts) chama ${lit}`, srcIdxRaw.includes(lit) && distRaw.includes(lit));
  check(`wiring V2 (v2-setup.ts) chama ${lit}`, srcV2Raw.includes(lit));
}
check("hooks V1/V2 passam o diretório do workspace", srcIdxRaw.includes("deps.directory") && srcV2Raw.includes("ctx.location.directory"));
// O invariante é sobre o CAMINHO DE AUTO-COMMIT (não sobre o texto de prompt do
// team_spawn, que ensina o humano/agente a comitar manualmente).
const distAutocommit = (() => {
  const start = distRaw.indexOf("async function autoCommitApprovedTask");
  const end = distRaw.indexOf("async function executeTeamTasksComplete");
  return start >= 0 && end > start ? distRaw.slice(start, end) : "";
})();
check("invariante: region de auto-commit localizada no bundle", distAutocommit.length > 1000, `len=${distAutocommit.length}`);
check("invariante: auto-commit NUNCA usa git add -A (argv `-A` ausente no fonte e no bundle)",
  !/["']add["']\s*,\s*["']-A["']/.test(srcTcRaw) && distAutocommit.length > 0 && !/["']add["']\s*,\s*["']-A["']/.test(distAutocommit));
check("invariante: staging continua argv cirúrgico `git add -- <paths>`", srcTcRaw.includes('"add", "--", ...addList'));
check("gate: ledger vazio segue fail-closed (nenhum commit)", srcTcRaw.includes("if (ledger.length === 0) return"));
check("fail-safe: audit de lacuna roda sobre os repos tocados", srcTcRaw.includes("auditRepos") && srcTcRaw.includes("--porcelain\", \"-uall\""));
const MOCK_PATTERNS = [/\bjest\.mock\b/, /\bvi\.mock\b/, /\bunittest\.mock\b/, /\bMagicMock\b/, /\bsinon\.stub\b/];
check("anti-mock: nenhuma dependência de mock no fonte novo", !MOCK_PATTERNS.some((re) => re.test(srcMfRaw) || re.test(srcTcRaw)));

// ---------------------------------------------------------------------------
// 10. PROVA DE MUTAÇÃO — desliga o branch de shell no bundle.
// ---------------------------------------------------------------------------
{
  const mutated = distRaw.replace("if (SHELL_TOOLS.has(tool2)) {", "if (false) {");
  check("mutação M1 aplicada ao bundle (branch de shell desligado)", mutated !== distRaw);
  writeFileSync(path.join(TMP, "_release05_m1.mjs"), buildHarnessCode(mutated));
  const MUT = await import(path.join(TMP, "_release05_m1.mjs"));

  const env = newEnv(MUT, { name: "m1" });
  const repo = env.dir;
  MUT.captureShellBaseline(env.db, env.registry, env.tales, "bash", { command: "npm install" }, repo, "m1");
  sh(repo, "echo '{\"v\":2}' > package-lock.json && echo g > generated.js && rm keep.txt");
  MUT.recordFileFromToolCall(env.db, env.registry, env.tales, "bash", { command: "npm install" }, repo, "m1");
  const rows = env.ledger();
  check("M1 mutante: artefato de shell NÃO é capturado (SL1 quebra)", !rows.includes(path.join(repo, "generated.js")), JSON.stringify(rows));
  check("M1 mutante: package-lock reescrito NÃO é capturado (SL2 quebra)", !rows.includes(path.join(repo, "package-lock.json")));
  check("M1 mutante: deleção NÃO é capturada (SL3 quebra)", !rows.includes(path.join(repo, "keep.txt")));

  // e o fluxo de edição direta segue intacto no mutante (isolamento do defeito)
  writeFileSync(path.join(repo, "edited.ts"), "x\n");
  MUT.recordFileFromToolCall(env.db, env.registry, env.tales, "edit", { filePath: path.join(repo, "edited.ts") }, repo);
  check("M1 mutante: edit continua gravando (prova de que só o branch de shell morreu)", env.ledger().includes(path.join(repo, "edited.ts")));
  env.cleanup();
}

// ---------------------------------------------------------------------------
// Resultado.
// ---------------------------------------------------------------------------
const failed = results.filter(([, ok]) => !ok);
check("zero unhandledRejection", unhandled.length === 0, unhandled.map((e) => String(e)).join(" | "));
console.log("-".repeat(78));
console.log(`${results.filter(([, ok]) => ok).length}/${results.length} checks passed`);
if (failed.length > 0) {
  console.log(`RESULT: ${failed.length} FAILURE(S)`);
  process.exit(1);
}
console.log("RESULT: all checks passed");
process.exit(0);
