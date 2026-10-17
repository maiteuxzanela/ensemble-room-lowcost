#!/usr/bin/env node
/**
 * QUALITY GATE DETERMINÍSTICO — Auto-commit local nativo pós-QA, GATEADO PELO
 * LEDGER e CIRÚRGICO (TICKET-HARNESS-26A + TICKET-32A)
 * @maiteuxzanela/ensemble-room-lowcost
 *
 * Engenheiro de Testes (SDET): Hugo. Guardiã do Quality Gate: Clara.
 *
 * Sob teste (src/ e dist/ REAIS, SQLite real via node:sqlite, git REAL em
 * sandbox — SEM MOCKS):
 *   - src/modified-files.ts: ledger `team_modified_file` por sala, gravado no
 *     hook `tool.execute.after` (recordFileFromToolCall, V1 index.ts + V2
 *     v2-setup.ts) para tools de escrita (edit/write/patch/multiedit/...).
 *     `recordModifiedFile`/`listModifiedFiles`/`modifiedFilesUnderRepo` são
 *     exportados do dist e dirigidos diretamente pelos testes (seed do ledger
 *     = simulação determinística do hook — seams reais, zero mocks).
 *   - executeTeamTasksComplete -> src/tools/team-tasks-complete.ts
 *       Flow 3 (complete): quando o Quality Gate reviewer (isQAMember) ou o
 *       team lead aprova o card, o hook `autoCommitApprovedTask` comita o
 *       workspace LOCALMENTE (Portão 1) — e SOMENTE o que o ledger da sala
 *       registrou:
 *         • ledger VAZIO → NENHUM commit (fail-closed, retorna "");
 *         • staging `git add -- <arquivo1> <arquivo2> ...` (argv, sem shell)
 *           — NUNCA `git add -A`;
 *         • cada arquivo atribuído ao repo MAIS FUNDO que o contém;
 *         • gitlink aninhado preservado (os dois status terminam limpos);
 *         • sujo FORA do ledger NUNCA entra no commit (cirúrgico).
 *       Mensagem posicional `feat(runtime): <task.content>`, nunca push.
 *       Contratos: guarda "o dir precisa SER o toplevel do repo" (caminho
 *       aninhado é pulado), árvore limpa → "already clean", qualquer falha de
 *       git é engolida (nunca quebra a transição SQLite), gating estrito a
 *       QA/lead.
 *
 * Cobertura:
 *   AC1  Clara (is_qa) aprova card in_review em repo SUJO com feature.txt NO
 *        ledger → commit criado, hash no sufixo casa com HEAD, mensagem
 *        exata, árvore limpa, +1 commit.
 *   AC2  Ledger não-vazio com arquivo JÁ commitado (árvore limpa) → mensagem
 *        "already clean (no commit needed)", HEAD e contagem inalterados.
 *   AC3  Membro NÃO autorizado (implementador) tentando completar card
 *        in_review → erro, board permanece in_review, zero commit (mesmo com
 *        ledger populado: a autorização precede o hook).
 *   AC4  Implementador completa o PRÓPRIO card in_progress (permitido) com
 *        ledger populado → o gate QA/lead NÃO dispara (sem sufixo, sem
 *        commit), árvore segue suja.
 *   AC5  Lead completa card in_review (ledger populado) → hook dispara.
 *   AC6  Diretório não-repo com ledger populado → sem throw, board completa,
 *        sem sufixo (sem candidato a repo → nada a comitar).
 *   AC7  Sala rodando de um subdiretório NÃO-repo dentro de um repo maior SUJO,
 *        com o ledger apontando para o repo pai. HARNESS-48: a descoberta
 *        derivada do ledger resolve o toplevel e comita CIRURGICAMENTE só o
 *        arquivo registrado (HEAD do pai avança 1, árvore fica limpa).
 *   AC8  git commit falha (sem identidade user.email/user.name) → sem throw,
 *        board completa, sem sufixo (fail-graceful).
 *   AC9  Injeção de shell no task.content (`$(...)`, backticks, aspas, `&`) →
 *        mensagem exata via argumento posicional, ZERO efeito colateral.
 *   AC10 Promessa de governança: `action: "reject"` volta o card a in_progress
 *        e NÃO comita (o commit é exclusivo do complete QA/lead).
 *   AC11 NOVO (TICKET-32A): ledger VAZIO → fail-closed: NENHUM commit e NENHUM
 *        sufixo (nem "already clean"), árvore segue suja.
 *   AC12 NOVO (TICKET-32A): arquivo sujo FORA do ledger NÃO é comitado — o
 *        commit contém SÓ o arquivo registrado; stray.txt permanece `??`.
 *   AC13 NOVO (TICKET-32A): hook de produção recordFileFromToolCall — edit
 *        grava, read não grava, sessão desconhecida não grava, args inválidos
 *        não lançam, paths relativos colapsam no absoluto (PK normalizada).
 *   Estáticos: paridade src↔dist dos literais NOVOS do ledger cirúrgico,
 *        wiring dos hooks V1/V2, tabela team_modified_file, remoção comprovada
 *        do literal `add -A` e da janela de frescor + gate único + anti-mock.
 *   PROVA DE MUTAÇÃO: 6 mutantes determinísticos patcheados no bundle dist
 *        (M6 reintroduz o staging cego `git add -A` e é capturado por AC12).
 *
 * Único seam: cliente SDK do OpenCode (fronteira externa), reduzido a um
 * recorder determinístico de promptAsync — mesmo padrão das demais suítes do
 * repo. Nenhum componente de produção é substituído: SQLite, git, bundle dist e
 * schemas DDL rodam reais. O SQLite de scratch vive FORA da árvore do repo para
 * não sujá-la.
 *
 * Uso: node tests/test_auto_commit_on_complete.mjs
 * Exit: 0 = todos os checks PASS; 1 = há FAIL.
 */

import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
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
const REQUIRED_SYMBOLS = ["createDb", "executeTeamTasksComplete", "DEFAULT_CONFIG", "MemberRegistry", "ProgressTracker", "recordModifiedFile", "recordFileFromToolCall", "listModifiedFiles"];
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
  writeFileSync(path.join(TMP, "_ac_harness.mjs"), buildHarnessCode(distRaw));
}
const REAL = await import(path.join(TMP, "_ac_harness.mjs"));

// ---------------------------------------------------------------------------
// 1. Infra de teste: git REAL + SQLite REAL em sandbox isolado.
// ---------------------------------------------------------------------------
function git(cwd, args) {
  try {
    return { ok: true, out: execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim(), code: 0 };
  } catch (e) {
    return { ok: false, out: (e.stdout ?? "").toString().trim(), err: (e.stderr ?? "").toString().trim(), code: e.status ?? -1 };
  }
}

function makeGitRepo(base, { dirty = false, dropIdentityAfterBaseline = false } = {}) {
  const repoDir = path.join(base, "repo");
  mkdirSync(repoDir, { recursive: true });
  git(repoDir, ["init", "-q"]);
  git(repoDir, ["config", "user.email", "hugo.sdet@test.local"]);
  git(repoDir, ["config", "user.name", "Hugo SDET"]);
  writeFileSync(path.join(repoDir, "README.md"), "baseline\n");
  git(repoDir, ["add", "-A"]);
  git(repoDir, ["commit", "-q", "-m", "chore: baseline"]);
  if (dropIdentityAfterBaseline) {
    git(repoDir, ["config", "--unset", "user.email"]);
    git(repoDir, ["config", "--unset", "user.name"]);
  }
  if (dirty) writeFileSync(path.join(repoDir, "feature.txt"), "uncommitted work\n");
  return repoDir;
}

// build(base) -> repo/dir to use as deps.directory (null → plain non-git dir).
function newEnv(mod, build) {
  const base = mkdtempSync(path.join(os.tmpdir(), "ensemble-ac-"));
  const built = build(base);
  const dir = built ?? path.join(base, "plain");
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  const dbDir = path.join(base, "db");
  mkdirSync(dbDir, { recursive: true });

  const db = mod.createDb(path.join(dbDir, "ensemble.db"));
  const registry = new mod.MemberRegistry();
  const progressTracker = new mod.ProgressTracker(db);

  // Único seam (fronteira de transporte): recorder determinístico de promptAsync.
  const calls = [];
  const client = {
    session: { create: async () => ({ data: { id: "ses_unused" } }), promptAsync: async (o) => { calls.push(o); return {}; }, abort: async () => ({}) },
    tui: { showToast: async () => ({}), selectSession: async () => ({}) },
    worktree: { create: async () => ({ data: {} }), remove: async () => ({}), list: async () => ({ data: [] }), reset: async () => ({}) },
    workspace: { create: async () => ({ data: {} }), remove: async () => ({}), list: async () => ({ data: [] }) },
  };
  const deps = { db, registry, tracker: {}, purgeApprovals: {}, client, directory: dir, config: mod.DEFAULT_CONFIG, progressTracker };

  const doComplete = async (ses, args) => {
    try { return { res: await mod.executeTeamTasksComplete(deps, args, ses), err: null }; }
    catch (e) { return { res: "", err: e instanceof Error ? e.message : String(e) }; }
  };
  const cleanup = () => {
    try { db.close(); } catch { /* já fechado */ }
    rmSync(base, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  };
  return { base, dir, db, registry, deps, calls, doComplete, cleanup };
}

function seedTeam(db, teamId, leadSes) {
  const now = Date.now();
  db.run("INSERT INTO project (id, name, path, status, time_created, time_updated) VALUES ('default','Default','','active',?,?) ON CONFLICT DO NOTHING", [now, now]);
  db.run("INSERT INTO team (id, name, project_id, lead_session_id, status, delegate, time_created, time_updated) VALUES (?,?,'default',?,'active',0,?,?)", [teamId, `team-${teamId}`, leadSes, now, now]);
}
function addMember(db, registry, teamId, name, ses, agent, opts = {}) {
  const now = Date.now();
  db.run(
    `INSERT INTO team_member (team_id, name, session_id, agent, status, execution_status, is_qa, role, spawn_context, time_created, time_updated, reported_to_lead)
     VALUES (?,?,?,?, ?, ?, ?, ?, ?, ?, ?, 0)`,
    [teamId, name, ses, agent, opts.status ?? "ready", opts.exec ?? "idle", opts.isQa ?? 0, opts.role ?? null, opts.ctx ?? null, now, now],
  );
  registry.register(teamId, name, ses);
}
function addTask(db, teamId, id, assignee, status, content) {
  const now = Date.now();
  db.run(
    "INSERT INTO team_task (id, team_id, content, status, priority, assignee, rejection_count, time_created, time_updated) VALUES (?,?,?,?,'high',?,0,?,?)",
    [id, teamId, content, status, assignee, now, now],
  );
}
const taskStatus = (db, id) => db.query("SELECT status FROM team_task WHERE id = ?").get(id)?.status;
const headCount = (dir) => Number(git(dir, ["rev-list", "--count", "HEAD"]).out);
const headHash = (dir) => git(dir, ["rev-parse", "HEAD"]).out;

// ---------------------------------------------------------------------------
// 2. runBehavior: cenários AC1–AC9 contra um módulo harness dado.
// ---------------------------------------------------------------------------
async function runBehavior(mod) {
  const got = new Map();
  const R = (name, ok, detail) => got.set(name, { ok: !!ok, detail: detail === undefined ? "" : String(detail) });

  // ======================= AC1: Clara (is_qa) + repo sujo ==================
  {
    const env = newEnv(mod, (base) => makeGitRepo(base, { dirty: true }));
    seedTeam(env.db, "ac1", "ses_lead_ac1");
    addMember(env.db, env.registry, "ac1", "tales", "ses_tales_ac1", "build");
    addMember(env.db, env.registry, "ac1", "clara", "ses_clara_ac1", "clara", { isQa: 1, role: "qa" });
    const content = "Feat N26A auto-commit";
    addTask(env.db, "ac1", "T1", "tales", "in_review", content);
    // Seed do ledger = o hook tool.execute.after teria gravado feature.txt.
    mod.recordModifiedFile(env.db, "ac1", path.join(env.dir, "feature.txt"));
    const before = headHash(env.dir);
    const beforeCount = headCount(env.dir);
    const { res, err } = await env.doComplete("ses_clara_ac1", { task_id: "T1", action: "complete" });
    const after = headHash(env.dir);
    const afterCount = headCount(env.dir);
    const msg = git(env.dir, ["log", "-1", "--format=%s"]).out;
    const status = git(env.dir, ["status", "--porcelain"]).out;
    const m = res.match(/\(([0-9a-f]{7,})\)\s*$/);
    R("AC1.no-error", err === null, err);
    R("AC1.commit-suffix-hash-matches-head", !!m && after.startsWith(m[1]) && after !== before, `res="${res}"`);
    R("AC1.commit-message-exact", msg === `feat(runtime): ${content}`, `msg="${msg}"`);
    R("AC1.tree-clean-after", status === "", `status="${status}"`);
    R("AC1.exactly-one-new-commit", afterCount === beforeCount + 1, `${beforeCount}->${afterCount}`);
    env.cleanup();
  }

  // ======================= AC2: árvore limpa (sem commit falso) ============
  {
    const env = newEnv(mod, (base) => makeGitRepo(base, { dirty: false }));
    seedTeam(env.db, "ac2", "ses_lead_ac2");
    addMember(env.db, env.registry, "ac2", "clara", "ses_clara_ac2", "clara", { isQa: 1 });
    const content = "Feat tree already clean";
    addTask(env.db, "ac2", "T2", "tales", "in_review", content);
    // Ledger não-vazio apontando para arquivo JÁ commitado → status limpo →
    // "already clean" (ledger vazio retornaria "" — coberto por AC11).
    mod.recordModifiedFile(env.db, "ac2", path.join(env.dir, "README.md"));
    const before = headHash(env.dir);
    const beforeCount = headCount(env.dir);
    const { res, err } = await env.doComplete("ses_clara_ac2", { task_id: "T2", action: "complete" });
    const after = headHash(env.dir);
    const afterCount = headCount(env.dir);
    R("AC2.no-error", err === null, err);
    R("AC2.already-clean-message", res.includes("Task completed; working tree already clean (no commit needed)"), res);
    R("AC2.no-new-commit", afterCount === beforeCount, `${beforeCount}->${afterCount}`);
    R("AC2.head-unchanged", after === before);
    env.cleanup();
  }

  // ======================= AC3: membro não autorizado (rejeição) ===========
  {
    const env = newEnv(mod, (base) => makeGitRepo(base, { dirty: true }));
    seedTeam(env.db, "ac3", "ses_lead_ac3");
    addMember(env.db, env.registry, "ac3", "tales", "ses_tales_ac3", "build");
    addMember(env.db, env.registry, "ac3", "clara", "ses_clara_ac3", "clara", { isQa: 1 });
    addTask(env.db, "ac3", "T3", "tales", "in_review", "Feat unauthorized complete");
    // Ledger populado de propósito: a autorização deve bloquear ANTES do hook.
    mod.recordModifiedFile(env.db, "ac3", path.join(env.dir, "feature.txt"));
    const before = headHash(env.dir);
    const beforeCount = headCount(env.dir);
    const { res, err } = await env.doComplete("ses_tales_ac3", { task_id: "T3", action: "complete" });
    R("AC3.throw-unauthorized", err !== null && /only clara or the team lead can complete it/.test(err), `err="${err}" res="${res}"`);
    R("AC3.status-still-in-review", taskStatus(env.db, "T3") === "in_review");
    R("AC3.no-commit", headCount(env.dir) === beforeCount && headHash(env.dir) === before, `count=${headCount(env.dir)}`);
    R("AC3.tree-still-dirty", git(env.dir, ["status", "--porcelain"]).out !== "");
    env.cleanup();
  }

  // ======================= AC4: implementador não dispara o hook ===========
  {
    const env = newEnv(mod, (base) => makeGitRepo(base, { dirty: true }));
    seedTeam(env.db, "ac4", "ses_lead_ac4");
    addMember(env.db, env.registry, "ac4", "tales", "ses_tales_ac4", "build");
    addTask(env.db, "ac4", "T4", "tales", "in_progress", "Feat owned by implementer");
    // Ledger populado de propósito: só o gate QA/lead (nunca o ledger) deve
    // impedir o commit — se o gate cair, o commit acontece e o teste falha.
    mod.recordModifiedFile(env.db, "ac4", path.join(env.dir, "feature.txt"));
    const beforeCount = headCount(env.dir);
    const { res, err } = await env.doComplete("ses_tales_ac4", { task_id: "T4", action: "complete" });
    R("AC4.no-error", err === null, err);
    R("AC4.status-completed", taskStatus(env.db, "T4") === "completed", taskStatus(env.db, "T4"));
    R("AC4.implementer-no-commit-suffix", !/locally committed|already clean/.test(res), res);
    R("AC4.no-new-commit", headCount(env.dir) === beforeCount, `count=${headCount(env.dir)}`);
    R("AC4.tree-still-dirty", git(env.dir, ["status", "--porcelain"]).out !== "");
    env.cleanup();
  }

  // ======================= AC5: lead dispara o hook ========================
  {
    const env = newEnv(mod, (base) => makeGitRepo(base, { dirty: true }));
    seedTeam(env.db, "ac5", "ses_lead_ac5");
    addMember(env.db, env.registry, "ac5", "tales", "ses_tales_ac5", "build");
    const content = "Feat approved by lead";
    addTask(env.db, "ac5", "T5", "tales", "in_review", content);
    mod.recordModifiedFile(env.db, "ac5", path.join(env.dir, "feature.txt"));
    const { res, err } = await env.doComplete("ses_lead_ac5", { task_id: "T5", action: "complete" });
    const msg = git(env.dir, ["log", "-1", "--format=%s"]).out;
    const status = git(env.dir, ["status", "--porcelain"]).out;
    R("AC5.no-error", err === null, err);
    R("AC5.lead-commit-created", /Task completed and locally committed: .*\([0-9a-f]{7,}\)/.test(res), res);
    R("AC5.lead-commit-message", msg === `feat(runtime): ${content}`, `msg="${msg}"`);
    R("AC5.lead-tree-clean", status === "");
    env.cleanup();
  }

  // ======================= AC6: diretório não-repo =========================
  {
    const env = newEnv(mod, () => null);
    seedTeam(env.db, "ac6", "ses_lead_ac6");
    addMember(env.db, env.registry, "ac6", "clara", "ses_clara_ac6", "clara", { isQa: 1 });
    addTask(env.db, "ac6", "T6", "tales", "in_review", "Feat outside a repo");
    // Ledger populado, mas o diretório não é repo → zero candidatos → "".
    writeFileSync(path.join(env.dir, "scratch.txt"), "fora de repo\n");
    mod.recordModifiedFile(env.db, "ac6", path.join(env.dir, "scratch.txt"));
    const { res, err } = await env.doComplete("ses_clara_ac6", { task_id: "T6", action: "complete" });
    R("AC6.no-error", err === null, err);
    R("AC6.board-completed", taskStatus(env.db, "T6") === "completed");
    R("AC6.no-commit-suffix", !/locally committed|already clean/.test(res), res);
    env.cleanup();
  }

  // ====== AC7: sala em subdir não-repo + repo pai no ledger (HARNESS-48) ======
  {
    const env = newEnv(mod, (base) => {
      const outer = path.join(base, "outer");
      mkdirSync(outer, { recursive: true });
      git(outer, ["init", "-q"]);
      git(outer, ["config", "user.email", "hugo.sdet@test.local"]);
      git(outer, ["config", "user.name", "Hugo SDET"]);
      writeFileSync(path.join(outer, "README.md"), "outer baseline\n");
      git(outer, ["add", "-A"]);
      git(outer, ["commit", "-q", "-m", "chore: outer baseline"]);
      writeFileSync(path.join(outer, "outer-dirty.txt"), "dirty outer tree\n");
      const inner = path.join(outer, "nested", "inner");
      mkdirSync(inner, { recursive: true });
      return inner;
    });
    const outer = path.join(env.base, "outer");
    seedTeam(env.db, "ac7", "ses_lead_ac7");
    addMember(env.db, env.registry, "ac7", "clara", "ses_clara_ac7", "clara", { isQa: 1 });
    addTask(env.db, "ac7", "T7", "tales", "in_review", "Feat nested dir");
    // Ledger aponta para o repo PAI: HARNESS-48 resolve o toplevel pelo ledger
    // (o dir interno não É o toplevel) e comita SÓ o arquivo registrado.
    mod.recordModifiedFile(env.db, "ac7", path.join(outer, "outer-dirty.txt"));
    const outerBefore = headHash(outer);
    const outerCountBefore = headCount(outer);
    const { res, err } = await env.doComplete("ses_clara_ac7", { task_id: "T7", action: "complete" });
    const names = git(outer, ["diff-tree", "--no-commit-id", "--name-only", "-r", "HEAD"]).out.split("\n").filter(Boolean).sort();
    R("AC7.no-error", err === null, err);
    R("AC7.board-completed", taskStatus(env.db, "T7") === "completed");
    R("AC7.ledger-derived-commit", /Task completed and locally committed: outer \([0-9a-f]{7,}\)/.test(res), res);
    R("AC7.parent-head-advances-one", headHash(outer) !== outerBefore && headCount(outer) === outerCountBefore + 1, `${outerCountBefore}->${headCount(outer)}`);
    R("AC7.parent-tree-clean", git(outer, ["status", "--porcelain"]).out === "", `status="${git(outer, ["status", "--porcelain"]).out}"`);
    R("AC7.commit-file-set", names.length === 1 && names[0] === "outer-dirty.txt", `names=${names.join(",")}`);
    env.cleanup();
  }

  // ============ AC8: git commit falha (sem identidade) → fail-graceful =====
  {
    const env = newEnv(mod, (base) => makeGitRepo(base, { dirty: true, dropIdentityAfterBaseline: true }));
    seedTeam(env.db, "ac8", "ses_lead_ac8");
    addMember(env.db, env.registry, "ac8", "clara", "ses_clara_ac8", "clara", { isQa: 1 });
    addTask(env.db, "ac8", "T8", "tales", "in_review", "Feat commit must fail");
    mod.recordModifiedFile(env.db, "ac8", path.join(env.dir, "feature.txt"));
    const emptyHome = path.join(env.base, "emptyhome");
    mkdirSync(emptyHome, { recursive: true });
    const KEYS = ["HOME", "GIT_CONFIG_GLOBAL", "GIT_CONFIG_NOSYSTEM", "GIT_CONFIG_SYSTEM"];
    const saved = {};
    for (const k of KEYS) saved[k] = process.env[k];
    let r;
    try {
      process.env.HOME = emptyHome;
      process.env.GIT_CONFIG_GLOBAL = "/dev/null";
      process.env.GIT_CONFIG_NOSYSTEM = "1";
      delete process.env.GIT_CONFIG_SYSTEM;
      r = await env.doComplete("ses_clara_ac8", { task_id: "T8", action: "complete" });
    } finally {
      for (const k of KEYS) {
        if (saved[k] === undefined) delete process.env[k];
        else process.env[k] = saved[k];
      }
    }
    R("AC8.no-error", r.err === null, r.err);
    R("AC8.board-completed", taskStatus(env.db, "T8") === "completed");
    R("AC8.commit-failed-no-suffix", !/locally committed|already clean/.test(r.res), r.res);
    env.cleanup();
  }

  // ============ AC9: injeção de shell no content → sem efeito colateral ====
  {
    const env = newEnv(mod, (base) => makeGitRepo(base, { dirty: true }));
    seedTeam(env.db, "ac9", "ses_lead_ac9");
    addMember(env.db, env.registry, "ac9", "clara", "ses_clara_ac9", "clara", { isQa: 1 });
    const content = 'Injeta "$(touch PWNED)" & `id` aspas';
    addTask(env.db, "ac9", "T9", "tales", "in_review", content);
    mod.recordModifiedFile(env.db, "ac9", path.join(env.dir, "feature.txt"));
    const { err } = await env.doComplete("ses_clara_ac9", { task_id: "T9", action: "complete" });
    const msg = git(env.dir, ["log", "-1", "--format=%s"]).out;
    const sideEffect = existsSync(path.join(env.dir, "PWNED")) || existsSync(path.join(TMP, "PWNED")) || existsSync(path.join(REPO, "PWNED"));
    R("AC9.no-error", err === null, err);
    R("AC9.injection-message-exact", msg === `feat(runtime): ${content}`, `msg="${msg}"`);
    R("AC9.injection-no-side-effect", !sideEffect);
    env.cleanup();
  }

  // ============ AC10: reject NÃO comita (o commit é exclusivo do complete) ==
  {
    const env = newEnv(mod, (base) => makeGitRepo(base, { dirty: true }));
    seedTeam(env.db, "ac10", "ses_lead_ac10");
    addMember(env.db, env.registry, "ac10", "tales", "ses_tales_ac10", "build");
    addMember(env.db, env.registry, "ac10", "clara", "ses_clara_ac10", "clara", { isQa: 1 });
    addTask(env.db, "ac10", "T10", "tales", "in_review", "Feat rejected by QA");
    // Ledger populado: mesmo assim o reject NÃO pode comitar.
    mod.recordModifiedFile(env.db, "ac10", path.join(env.dir, "feature.txt"));
    const beforeCount = headCount(env.dir);
    const { res, err } = await env.doComplete("ses_clara_ac10", { task_id: "T10", action: "reject", notes: "suite falhou" });
    R("AC10.no-error", err === null, err);
    R("AC10.status-in-progress", taskStatus(env.db, "T10") === "in_progress", taskStatus(env.db, "T10"));
    R("AC10.reject-no-commit", headCount(env.dir) === beforeCount && git(env.dir, ["status", "--porcelain"]).out !== "", `count=${headCount(env.dir)}`);
    env.cleanup();
  }

  // ==== AC11: ledger VAZIO → fail-closed: NENHUM commit (TICKET-32A) ======
  {
    const env = newEnv(mod, (base) => makeGitRepo(base, { dirty: true }));
    seedTeam(env.db, "ac11", "ses_lead_ac11");
    addMember(env.db, env.registry, "ac11", "clara", "ses_clara_ac11", "clara", { isQa: 1 });
    addTask(env.db, "ac11", "T11", "tales", "in_review", "Feat touched nothing");
    // Ledger deliberadamente VAZIO: a sala não registrou nenhuma escrita.
    const beforeCount = headCount(env.dir);
    const beforeHash = headHash(env.dir);
    const { res, err } = await env.doComplete("ses_clara_ac11", { task_id: "T11", action: "complete" });
    R("AC11.no-error", err === null, err);
    R("AC11.board-completed", taskStatus(env.db, "T11") === "completed", taskStatus(env.db, "T11"));
    R("AC11.no-commit-suffix", !/locally committed|already clean/.test(res), res);
    R("AC11.no-new-commit", headCount(env.dir) === beforeCount && headHash(env.dir) === beforeHash, `${beforeCount}->${headCount(env.dir)}`);
    R("AC11.tree-still-dirty", git(env.dir, ["status", "--porcelain"]).out !== "", `status="${git(env.dir, ["status", "--porcelain"]).out}"`);
    env.cleanup();
  }

  // ==== AC12: cirurgia — sujo FORA do ledger NÃO é comitado (TICKET-32A) ===
  {
    const env = newEnv(mod, (base) => makeGitRepo(base, { dirty: true })); // feature.txt sujo
    writeFileSync(path.join(env.dir, "stray.txt"), "sujo e nao registrado no ledger\n");
    seedTeam(env.db, "ac12", "ses_lead_ac12");
    addMember(env.db, env.registry, "ac12", "clara", "ses_clara_ac12", "clara", { isQa: 1 });
    const content = "Feat surgical staging";
    addTask(env.db, "ac12", "T12", "tales", "in_review", content);
    // Ledger registra SÓ feature.txt — stray.txt é sujo alheio à sala.
    mod.recordModifiedFile(env.db, "ac12", path.join(env.dir, "feature.txt"));
    const beforeCount = headCount(env.dir);
    const { res, err } = await env.doComplete("ses_clara_ac12", { task_id: "T12", action: "complete" });
    const names = git(env.dir, ["diff-tree", "--no-commit-id", "--name-only", "-r", "HEAD"]).out.split("\n").filter(Boolean).sort();
    const status = git(env.dir, ["status", "--porcelain"]).out;
    R("AC12.no-error", err === null, err);
    R("AC12.commit-suffix-present", /Task completed and locally committed: .*\([0-9a-f]{7,}\)/.test(res), res);
    R("AC12.commit-message-exact", git(env.dir, ["log", "-1", "--format=%s"]).out === `feat(runtime): ${content}`, `msg="${git(env.dir, ["log", "-1", "--format=%s"]).out}"`);
    R("AC12.commit-only-ledger-file", names.length === 1 && names[0] === "feature.txt", `names=${names.join(",")}`);
    R("AC12.stray-still-untracked", status.includes("?? stray.txt"), `status="${status}"`);
    R("AC12.tree-not-clean", status !== "", `status="${status}"`);
    R("AC12.exactly-one-new-commit", headCount(env.dir) === beforeCount + 1, `${beforeCount}->${headCount(env.dir)}`);
    env.cleanup();
  }

  return got;
}

// ---------------------------------------------------------------------------
// 3. Fase REAL: cenários contra o dist autêntico devem passar 100%.
// ---------------------------------------------------------------------------
const realFlow = await runBehavior(REAL);
for (const [name, { ok, detail }] of realFlow) check(`[real] ${name}`, ok, detail);

// ---------------------------------------------------------------------------
// 3b. AC13 — hook de produção do ledger (tool.execute.after → recordFileFromToolCall).
//     Diretamente contra o dist real: SQLite + registry reais, zero mocks.
// ---------------------------------------------------------------------------
{
  const env = newEnv(REAL, () => null);
  seedTeam(env.db, "ac13", "ses_lead_ac13");
  addMember(env.db, env.registry, "ac13", "tales", "ses_tales_ac13", "build");
  const abs = path.join(env.dir, "hooked.ts");
  writeFileSync(abs, "export {};\n");
  const rows = () => REAL.listModifiedFiles(env.db, "ac13");

  REAL.recordFileFromToolCall(env.db, env.registry, "ses_tales_ac13", "edit", { filePath: abs });
  check("AC13.edit-registra-ledger", rows().length === 1 && rows()[0] === abs, JSON.stringify(rows()));

  // Grafia redundante (/. ) do MESMO arquivo → PK normalizada, sem duplicata.
  REAL.recordFileFromToolCall(env.db, env.registry, "ses_tales_ac13", "write", { filePath: `${env.dir}/./hooked.ts` });
  check("AC13.normalizacao-sem-duplicata", rows().length === 1 && rows()[0] === abs, JSON.stringify(rows()));

  REAL.recordFileFromToolCall(env.db, env.registry, "ses_tales_ac13", "read", { filePath: abs });
  check("AC13.read-nao-registra", rows().length === 1, `rows=${rows().length}`);

  REAL.recordFileFromToolCall(env.db, env.registry, "ses_desconhecida", "edit", { filePath: abs });
  check("AC13.sessao-desconhecida-nao-registra", rows().length === 1, `rows=${rows().length}`);

  let threw = null;
  try {
    REAL.recordFileFromToolCall(env.db, env.registry, "ses_tales_ac13", "edit", { nota: "sem filePath" });
    REAL.recordFileFromToolCall(env.db, env.registry, "ses_tales_ac13", "multiedit", { edits: [] });
    REAL.recordFileFromToolCall(env.db, env.registry, "ses_tales_ac13", "edit", null);
    REAL.recordFileFromToolCall(env.db, env.registry, "ses_tales_ac13", "team_tasks_complete", { task_id: "X", filePath: abs });
  } catch (e) {
    threw = e instanceof Error ? e.message : String(e);
  }
  check("AC13.args-invalidos-e-team-tools-nao-lancam-nao-registram", threw === null && rows().length === 1, `threw=${threw} rows=${rows().length}`);

  // Fluxo reverso: team não ativo → findTeamBySession não resolve → não grava.
  env.db.run("UPDATE team SET status = 'archived' WHERE id = 'ac13'");
  REAL.recordFileFromToolCall(env.db, env.registry, "ses_tales_ac13", "edit", { filePath: abs });
  check("AC13-time-archived-nao-registra", rows().length === 1, `rows=${rows().length}`);
  env.cleanup();
}

// ---------------------------------------------------------------------------
// 4. Estáticos: paridade src↔dist (ledger cirúrgico TICKET-32A) + remoções
//    comprovadas + wiring do hook + gate único + anti-mock.
// ---------------------------------------------------------------------------
const SRC_TC = readFileSync(path.join(SRC, "tools", "team-tasks-complete.ts"), "utf8");
const SRC_MF = readFileSync(path.join(SRC, "modified-files.ts"), "utf8");
const SRC_IDX = readFileSync(path.join(SRC, "index.ts"), "utf8");
const SRC_V2 = readFileSync(path.join(SRC, "v2-setup.ts"), "utf8");
const SRC_SCHEMA = readFileSync(path.join(SRC, "schema.ts"), "utf8");
const GUARD = 'if (teamInfo.role === "lead" || isQAMember(deps.db, teamInfo.teamId, caller)) {';
const STATIC_LITERALS = [
  "autoCommitApprovedTask",
  "tasks-complete:autocommit:committed",
  "tasks-complete:autocommit:skip-non-root",
  "tasks-complete:autocommit:commit-failed",
  "tasks-complete:autocommit:error",
  "Task completed; working tree already clean (no commit needed)",
  "Task completed and locally committed",
  "feat(runtime): ",
];
const countOcc = (hay, needle) => hay.split(needle).length - 1;
for (const lit of STATIC_LITERALS) {
  check(`paridade src↔dist: literal "${lit.slice(0, 42)}"`, SRC_TC.includes(lit) && distRaw.includes(lit));
}

// Literais NOVOS do contrato TICKET-32A (ledger + staging cirúrgico). A fonte
// src pode viver em team-tasks-complete.ts OU em modified-files.ts.
const LEDGER_LITERALS = [
  "recordModifiedFile",
  "recordFileFromToolCall",
  "listModifiedFiles",
  "modifiedFilesUnderRepo",
  '"add", "--"',
  "team_modified_file",
];
for (const lit of LEDGER_LITERALS) {
  check(
    `paridade src↔dist (ledger cirúrgico): literal "${lit.slice(0, 46)}"`,
    distRaw.includes(lit) && (SRC_TC.includes(lit) || SRC_MF.includes(lit)),
  );
}

// Remoções comprovadas do contrato antigo (add -A cego + janela de mtime).
check(
  "remoção: literal sh -c 'add -A && commit' AUSENTE de src e dist",
  !SRC_TC.includes('git -C "$1" add -A') && !distRaw.includes('git -C "$1" add -A'),
);
check(
  "remoção: janela de frescor por mtime (resolveFreshnessSince/hasFreshDirt) AUSENTE de src e dist",
  !SRC_TC.includes("resolveFreshnessSince") && !distRaw.includes("resolveFreshnessSince") && !SRC_TC.includes("hasFreshDirt") && !distRaw.includes("hasFreshDirt"),
);
check(
  "staging cirúrgico: o comando executável usa argv ['add', '--', ...] em src e dist",
  SRC_TC.includes('["git", "-C", target.path, "add", "--", ...addList]') && distRaw.includes('["git", "-C", target.path, "add", "--", ...addList]'),
);

// Wiring do hook de produção: tool.execute.after popula o ledger (V1 + V2).
check(
  "hook de ledger: recordFileFromToolCall ligado em index.ts (V1) e v2-setup.ts (V2) e presente no dist",
  SRC_IDX.includes("recordFileFromToolCall") && SRC_V2.includes("recordFileFromToolCall") && distRaw.includes("recordFileFromToolCall"),
);
check(
  "schema: tabela team_modified_file em src/schema.ts e no dist",
  SRC_SCHEMA.includes("team_modified_file") && distRaw.includes("team_modified_file"),
);

check("gate único em src (QA/lead)", countOcc(SRC_TC, GUARD) === 1, `n=${countOcc(SRC_TC, GUARD)}`);
check("gate único em dist (QA/lead)", countOcc(distRaw, GUARD) === 1, `n=${countOcc(distRaw, GUARD)}`);
check("guarda de toplevel presente em src e dist", SRC_TC.includes("if (primary && primary === normalizeDir(dir)) {") && distRaw.includes("if (primary && primary === normalizeDir(dir)) {"));

{
  const FORBIDDEN = ["je" + "st.mock", "sin" + "on", "vi.mo" + "ck", "mockImple" + "mentation"];
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
  check("anti-mock: zero mocks em produção sob src/", srcMocks === 0, `achados=${srcMocks}`);
  check("anti-mock: suíte não contém marcadores proibidos", !forbiddenRe.test(readFileSync(import.meta.filename, "utf8")));
}

// ---------------------------------------------------------------------------
// 5. PROVA DE MUTAÇÃO: patch no bundle dist + reexecução dos mesmos cenários.
// ---------------------------------------------------------------------------
const MUTATIONS = [
  {
    id: "M1",
    desc: "hook desabilitado por completo (gate QA/lead nunca dispara)",
    from: GUARD,
    to: "if (false) {",
    detect: ["AC1.commit-suffix-hash-matches-head", "AC1.commit-message-exact", "AC1.tree-clean-after", "AC5.lead-commit-created"],
    unaffected: ["AC3.throw-unauthorized", "AC3.no-commit", "AC4.implementer-no-commit-suffix", "AC6.no-commit-suffix"],
  },
  {
    id: "M2",
    desc: "gate ampliado: hook dispara para qualquer chamador (implementador incluído)",
    from: GUARD,
    to: "if (true) {",
    detect: ["AC4.implementer-no-commit-suffix", "AC4.no-new-commit", "AC4.tree-still-dirty"],
    unaffected: ["AC1.commit-message-exact", "AC5.lead-commit-created", "AC3.throw-unauthorized", "AC6.no-commit-suffix"],
  },
  {
    id: "M3",
    desc: "curto-circuito de árvore limpa removido (cria commit vazio / perde o aviso)",
    from: "if (status.stdout.trim().length === 0) continue",
    to: "if (false) continue",
    detect: ["AC2.already-clean-message"],
    unaffected: ["AC1.commit-message-exact", "AC5.lead-commit-created", "AC2.no-new-commit", "AC2.head-unchanged"],
  },
  {
    id: "M4",
    desc: "descoberta derivada do ledger desabilitada (repo pai fora da árvore não comita)",
    // A guarda de toplevel do caminho 1 ficou NÃO-observável após o HARNESS-48:
    // qualquer repo cujo arquivo esteja no ledger é redescoberto por este loop,
    // então o mutante honesto para AC7 é desabilitar a própria descoberta.
    from: "for (const rawPath of ledger) {",
    to: "for (const rawPath of []) {",
    detect: ["AC7.ledger-derived-commit", "AC7.parent-head-advances-one", "AC7.parent-tree-clean", "AC7.commit-file-set"],
    unaffected: ["AC1.commit-message-exact", "AC6.no-commit-suffix", "AC3.throw-unauthorized"],
  },
  {
    id: "M5",
    desc: "mensagem de commit adulterada (conteúdo do card perdido)",
    from: "const message = `feat(runtime): ${taskContent}`;",
    to: "const message = `feat(runtime): TAMPERED`;",
    detect: ["AC1.commit-message-exact", "AC5.lead-commit-message", "AC9.injection-message-exact"],
    unaffected: ["AC1.commit-suffix-hash-matches-head", "AC2.already-clean-message", "AC4.implementer-no-commit-suffix", "AC6.no-commit-suffix"],
  },
  {
    id: "M6",
    desc: "staging cego 'git add -A' reintroduzido no lugar do staging cirúrgico do ledger (TICKET-32A)",
    from: '["git", "-C", target.path, "add", "--", ...addList]',
    to: '["git", "-C", target.path, "add", "-A"]',
    detect: ["AC12.commit-only-ledger-file", "AC12.stray-still-untracked", "AC12.tree-not-clean"],
    unaffected: ["AC1.commit-message-exact", "AC5.lead-commit-created", "AC2.already-clean-message", "AC11.no-commit-suffix"],
  },
];

for (const m of MUTATIONS) {
  for (const n of [...m.detect, ...m.unaffected]) {
    check(`${m.id}: sentinela "${n}" existe nos checks reais`, realFlow.has(n), "");
  }
  const occurrences = countOcc(distRaw, m.from);
  check(`${m.id}: patch aplicável (1 ocorrência exata no dist)`, occurrences === 1, `ocorrências=${occurrences}`);
  if (occurrences !== 1) continue;

  const mutantDist = distRaw.split(m.from).join(m.to);
  const mutantFile = path.join(TMP, `_ac_${m.id.toLowerCase()}.mjs`);
  writeFileSync(mutantFile, buildHarnessCode(mutantDist));

  let combined;
  try {
    const mutantMod = await import(mutantFile);
    combined = await runBehavior(mutantMod);
    check(`${m.id}: mutante executável (fluxo roda por completo)`, combined.size === realFlow.size, `checks=${combined.size}/${realFlow.size}`);
  } catch (err) {
    check(`${m.id}: mutante executável (fluxo roda por completo)`, false, String(err));
    continue;
  }

  const missed = m.detect.filter((n) => combined.get(n)?.ok !== false);
  check(
    `${m.id}: asserções sensíveis — mutação detectada [${m.desc}]`,
    missed.length === 0,
    missed.length ? `não detectaram: ${missed.join(", ")}` : `${m.detect.length}/${m.detect.length} sentinelas falharam`,
  );

  const broken = m.unaffected.filter((n) => combined.get(n)?.ok !== true);
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
