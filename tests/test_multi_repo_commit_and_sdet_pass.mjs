#!/usr/bin/env node
/**
 * QUALITY GATE DETERMINÍSTICO — Auto-commit Multi-Repo (27A) + Ação nativa
 * `sdet_pass` (27B). TICKET-HARNESS-27A / TICKET-HARNESS-27B.
 * @maiteuxzanela/ensemble-room-lowcost
 *
 * Engenheiro de Testes (SDET): Hugo. Guardiã do Quality Gate: Clara.
 *
 * Sob teste (src/ e dist/ REAIS, SQLite real via node:sqlite, git REAL em
 * sandbox — SEM MOCKS):
 *   - src/tools/team-tasks-complete.ts
 *       • Flow 3 (complete): `autoCommitApprovedTask` -> `resolveCommitTargets`
 *         descobre N repositórios (room dir quando É o toplevel, repos ANINHADOS
 *         dentro dele com scan bounded, IRMÃOS sujos E recentemente tocados com
 *         SIBLING_FRESHNESS_MS, override por ENSEMBLE_AUTOCOMMIT_REPOS) e comita
 *         cada um ATOMICAMENTE via `sh -c 'git -C "$1" add -A && git -C "$1"
 *         commit -m "$2"'` (path + mensagem posicionais → shell-inert). Ordenação
 *         deepest-first: o repo aninhado comita ANTES do pai para o `git add -A`
 *         do pai registrar o HEAD final (gitlink) e a árvore do pai ficar limpa.
 *       • Flow 0 (`action: 'sdet_pass'`): SDET-exclusivo (isSDETMEmber). Só roda
 *         em card `in_review`; grava review_notes + timestamp, o card PERMANECE
 *         em in_review (só o Quality Gate o fecha) e acorda a Clara nativamente
 *         (wakeQualityGateForSdetPass) com texto canônico, `agent: qa.agent ||
 *         "clara"` explícito e DINÂMICO (imunidade ao sequestro de persona A2,
 *         sem hardcode "clara"; a literal é só o fallback retrocompat) e
 *         `synthetic: true`.
 *
 * Cobertura:
 *   MR1  Room (toplevel git) + repo ANINHADO, ambos sujos → complete da Clara
 *        comita AMBOS atomicamente, hashes DISTINTOS no sufixo, árvore limpa em
 *        ambos, mensagem exata, +1 commit por repo (prova da ordem deepest-first
 *        pelo pai terminar limpo).
 *   MR2  Room sujo + irmão sujo ANTES do nascimento da sala (mtime < sinceMs) →
 *        só o room comita; o irmão NÃO é comitado e segue sujo (guarda de frescor
 *        protege árvores alheias anteriores ao ciclo).
 *   MR3/MR4  Regressão HARNESS-27C (janela vinculada ao ciclo): sala/tarefa nascida
 *        há 3h (MR3) ou 5h (MR4) e um irmão tocado DURANTE a vida da sala mas já
 *        há > 1h (90min / 2h) → irmão DEVE ser comitado (o relógio estático de 1h
 *        o deixava órfão); contraprova: irmão tocado ANTES do nascimento
 *        (mtime < sinceMs) permanece excluído e sujo.
 *   SP1  Implementador chama `sdet_pass` → "Only SDET can invoke sdet_pass";
 *        board intacto; ZERO wake.
 *   SP2  Hugo chama `sdet_pass` em card `in_progress` → erro de estado; ZERO wake.
 *   SP3  Hugo chama `sdet_pass` em card `completed` → erro de estado; ZERO wake.
 *   SP4  Hugo chama `sdet_pass` em card `in_review` → card PERMANECE in_review,
 *        review_notes gravadas, EXATAMENTE 1 wake para a sessão da Clara com
 *        texto canônico + agent explícito dinâmico (qa.agent da revisora) +
 *        synthetic; NENHUM commit (Portão 1 é exclusivo do complete do Quality
 *        Gate).
 *   SP5  Sala sem Quality Gate → `sdet_pass` não lança, notas gravadas, ZERO wake.
 *   SP6  Quality Gate CUSTOM (is_qa=1, agent != "clara", ex.: 'gate-custom') →
 *        o wake do sdet_pass DEVE carregar `agent === 'gate-custom'` (A2: persona
 *        dinâmica da revisora; nunca "clara" hardcoded).
 *   SP7  Quality Gate LEGADO com `agent` VAZIO (is_qa=1) → fallback "clara";
 *        SP7b retrocompat por NOME (is_qa=0, nome "clara", agent vazio) → "clara".
 *   Estáticos: paridade src↔dist dos literais 27A/27B/27C + anti-mock.
 *   PROVA DE MUTAÇÃO: 9 mutantes determinísticos patcheados no bundle dist
 *        (M8 re-endurece o agent hardcoded "clara"; M9 adultera o fallback de
 *        agent vazio). A guarda A1 anti-auto-review foi revertida por decisão de
 *        produto (Maiteux/lead) — o card tem escopo exclusivamente A2.
 *
 * Único seam: cliente SDK do OpenCode (fronteira externa), reduzido a um
 * recorder determinístico de promptAsync — mesmo padrão das demais suítes do
 * repo. Nenhum componente de produção é substituído: SQLite, git, bundle dist e
 * schemas DDL rodam reais. O SQLite + os repos git vivem em mkdtempSync FORA da
 * árvore do repo para não sujá-la.
 *
 * Uso: node tests/test_multi_repo_commit_and_sdet_pass.mjs
 * Exit: 0 = todos os checks PASS; 1 = há FAIL.
 */

import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
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
const REQUIRED_SYMBOLS = ["createDb", "executeTeamTasksComplete", "DEFAULT_CONFIG", "MemberRegistry", "ProgressTracker"];
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
  writeFileSync(path.join(TMP, "_mr_sdet_harness.mjs"), buildHarnessCode(distRaw));
}
const REAL = await import(path.join(TMP, "_mr_sdet_harness.mjs"));

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
const headHash = (dir) => git(dir, ["rev-parse", "HEAD"]).out;
const headCount = (dir) => Number(git(dir, ["rev-list", "--count", "HEAD"]).out);
const lastMsg = (dir) => git(dir, ["log", "-1", "--format=%s"]).out;
const porcelain = (dir) => git(dir, ["status", "--porcelain"]).out;

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
// 2. runFlow: cenários (MR1/MR2/SP1–SP5) contra um módulo harness dado.
//    Cada execução cria um SQLite NOVO + repos git em mkdtempSync e limpa ao
//    final. Retorna Map<checkName, {ok, detail}> — a fase real promove cada
//    entrada a check global; a fase de mutação promove só as meta-checks.
// ---------------------------------------------------------------------------
let flowSeq = 0;
async function runFlow(mod) {
  const { createDb, executeTeamTasksComplete, DEFAULT_CONFIG, MemberRegistry, ProgressTracker } = mod;

  const sandbox = mkdtempSync(path.join(os.tmpdir(), "ensemble-mrsdet-"));
  const db = createDb(path.join(sandbox, "ensemble.db"));
  const registry = new MemberRegistry();
  const progressTracker = new ProgressTracker(db);

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
  const MINUTE = 60 * 1000;
  const HOUR = 60 * MINUTE;

  const seedTeam = (id, name, lead, timeCreated = now) => {
    db.run("INSERT INTO project (id, name, path, status, time_created, time_updated) VALUES ('default','Default','','active',?,?) ON CONFLICT DO NOTHING", [now, now]);
    db.run("INSERT INTO team (id, name, project_id, lead_session_id, status, delegate, time_created, time_updated) VALUES (?,?,'default',?,'active',0,?,?)", [id, name, lead, timeCreated, timeCreated]);
  };
  const member = (teamId, name, ses, agent, isQa = 0, role = null, exec = "idle") => {
    db.run(
      `INSERT INTO team_member (team_id, name, session_id, agent, status, execution_status, is_qa, role, spawn_context, time_created, time_updated, reported_to_lead)
       VALUES (?,?,?,?, 'ready', ?, ?, ?, NULL, ?, ?, 0)`,
      [teamId, name, ses, agent, exec, isQa, role, now, now],
    );
    registry.register(teamId, name, ses);
  };
  const task = (teamId, id, assignee, status, content, timeCreated = now) => {
    db.run(
      "INSERT INTO team_task (id, team_id, content, status, priority, assignee, rejection_count, time_created, time_updated) VALUES (?,?,?,?,'high',?,0,?,?)",
      [id, teamId, content, status, assignee, timeCreated, timeCreated],
    );
  };
  const execute = async (deps, ses, args) => {
    try { return { res: await executeTeamTasksComplete(deps, args, ses), err: null }; }
    catch (e) { return { res: "", err: e instanceof Error ? e.message : String(e) }; }
  };
  const taskStatus = (id) => db.query("SELECT status FROM team_task WHERE id = ?").get(id)?.status;
  const taskNotes = (id) => db.query("SELECT review_notes FROM team_task WHERE id = ?").get(id)?.review_notes;
  const suffixOf = (res) => (res.includes("locally committed: ") ? res.slice(res.indexOf("locally committed: ") + "locally committed: ".length) : "");
  const hashesOf = (res) => [...suffixOf(res).matchAll(/\(([0-9a-f]{7,})\)/g)].map((m) => m[1]);

  // ======================= MR1: room + aninhado (2 repos) =================
  {
    const base = path.join(sandbox, "mr1");
    const room = path.join(base, "room");
    const nested = path.join(room, "nested");
    makeRepo(room);
    makeRepo(nested); // nasce DENTRO do room, depois do baseline do room
    writeFileSync(path.join(room, "feature.txt"), "room dirty\n");
    writeFileSync(path.join(nested, "feature.txt"), "nested dirty\n");

    seedTeam("mr1", "squad-multirepo", "ses_lead_mr1");
    member("mr1", "tales", "ses_tales_mr1", "build");
    member("mr1", "clara", "ses_clara_mr1", "clara", 1, "qa");
    const content = "Feat multi-repo";
    task("mr1", "TMR1", "tales", "in_review", content);

    const roomBefore = headHash(room), roomCountBefore = headCount(room);
    const nestedBefore = headHash(nested), nestedCountBefore = headCount(nested);
    calls.length = 0;
    const r = await execute(depsFor(room), "ses_clara_mr1", { task_id: "TMR1", action: "complete" });

    const roomAfter = headHash(room), nestedAfter = headHash(nested);
    const hashes = hashesOf(r.res);

    R("MR1.no-error", r.err === null, r.err);
    R("MR1.suffix-lists-two-repos", hashes.length === 2 && /Task completed and locally committed: \S+ \([0-9a-f]{7,}\), \S+ \([0-9a-f]{7,}\)/.test(r.res), `res="${r.res}"`);
    R("MR1.two-distinct-hashes", new Set(hashes).size === 2, hashes.join(","));
    R("MR1.room-head-in-suffix", hashes.some((h) => roomAfter.startsWith(h)) && roomAfter !== roomBefore, roomAfter);
    R("MR1.nested-head-in-suffix", hashes.some((h) => nestedAfter.startsWith(h)) && nestedAfter !== nestedBefore, nestedAfter);
    R("MR1.room-advances-one-commit", headCount(room) === roomCountBefore + 1, `${roomCountBefore}->${headCount(room)}`);
    R("MR1.nested-advances-one-commit", headCount(nested) === nestedCountBefore + 1, `${nestedCountBefore}->${headCount(nested)}`);
    R("MR1.room-tree-clean", porcelain(room) === "", `status="${porcelain(room)}"`);
    R("MR1.nested-tree-clean", porcelain(nested) === "", `status="${porcelain(nested)}"`);
    R("MR1.room-message-exact", lastMsg(room) === `feat(runtime): ${content}`, `msg="${lastMsg(room)}"`);
    R("MR1.nested-message-exact", lastMsg(nested) === `feat(runtime): ${content}`, `msg="${lastMsg(nested)}"`);
    R("MR1.board-completed", taskStatus("TMR1") === "completed", taskStatus("TMR1"));
  }

  // === MR2: irmão sujo ANTES do nascimento da sala (mtime < sinceMs) → excluído =
  {
    const base = path.join(sandbox, "mr2");
    const room = path.join(base, "room");
    const sibling = path.join(base, "sibling");
    makeRepo(room);
    makeRepo(sibling);
    writeFileSync(path.join(room, "feature.txt"), "room dirty\n");
    const sibDirty = path.join(sibling, "feature.txt");
    writeFileSync(sibDirty, "sibling stale dirty\n");
    // Sala/tarefa nascem agora (seedTeam/task default now); o arquivo irmão tem
    // mtime 2h no PASSADO → anterior ao nascimento → precisa ficar excluído.
    const old = new Date(Date.now() - 2 * 60 * 60 * 1000);
    utimesSync(sibDirty, old, old);

    seedTeam("mr2", "squad-stale-sibling", "ses_lead_mr2");
    member("mr2", "tales", "ses_tales_mr2", "build");
    member("mr2", "clara", "ses_clara_mr2", "clara", 1, "qa");
    task("mr2", "TMR2", "tales", "in_review", "Feat room only");

    const sibBefore = headHash(sibling), sibCountBefore = headCount(sibling);
    const hashes = hashesOf((await execute(depsFor(room), "ses_clara_mr2", { task_id: "TMR2", action: "complete" })).res);

    R("MR2.no-error", taskStatus("TMR2") === "completed", taskStatus("TMR2"));
    R("MR2.only-room-committed", hashes.length === 1, `hashes=${hashes.join(",")}`);
    R("MR2.stale-sibling-not-committed", headHash(sibling) === sibBefore && headCount(sibling) === sibCountBefore, `${sibCountBefore}->${headCount(sibling)}`);
    R("MR2.stale-sibling-still-dirty", porcelain(sibling) !== "", `status="${porcelain(sibling)}"`);
    R("MR2.room-tree-clean", porcelain(room) === "", `status="${porcelain(room)}"`);
  }

  // ====== MR3/MR4: janela de frescor VINCULADA ao ciclo da sala/tarefa ======
  //   Regressão do ticket HARNESS-27C: a sala/tarefa nasce > 1h atrás; um arquivo
  //   irmão tocado DURANTE a vida da sala mas já há > 1h (mtime pós-nascimento)
  //   DEVE ser comitado — o antigo relógio estático de 1h o deixava órfão.
  //   Contraprova: arquivo tocado ANTES do nascimento (mtime < sinceMs) fica
  //   excluído e segue sujo.
  const freshnessScenario = async (tag, bornAgoMs, freshFileAgeMs) => {
    const base = path.join(sandbox, tag);
    const room = path.join(base, "room");
    const freshSibling = path.join(base, "fresh-sibling");
    const staleSibling = path.join(base, "stale-sibling");
    makeRepo(room);
    makeRepo(freshSibling);
    makeRepo(staleSibling);
    writeFileSync(path.join(room, "feature.txt"), `${tag} room dirty\n`);

    // Irmão "fresco": tocado DURANTE o ciclo (mtime >= sinceMs), embora já faça
    // mais de 1h em relação a agora (freshFileAgeMs > 1h) → DEVE ser comitado.
    const freshFile = path.join(freshSibling, "feature.txt");
    writeFileSync(freshFile, `${tag} fresh sibling dirty\n`);
    const freshDate = new Date(now - freshFileAgeMs);
    utimesSync(freshFile, freshDate, freshDate);

    // Irmão "estragado": tocado ANTES do nascimento (mtime < sinceMs) → excluído.
    const staleFile = path.join(staleSibling, "feature.txt");
    writeFileSync(staleFile, `${tag} stale sibling dirty\n`);
    const staleDate = new Date(now - (bornAgoMs + HOUR));
    utimesSync(staleFile, staleDate, staleDate);

    const born = now - bornAgoMs;
    const taskId = `T${tag.toUpperCase()}`;
    seedTeam(tag, `squad-${tag}`, `ses_lead_${tag}`, born);
    member(tag, "tales", `ses_tales_${tag}`, "build");
    member(tag, "clara", `ses_clara_${tag}`, "clara", 1, "qa");
    const content = `Feat ${tag}`;
    task(tag, taskId, "tales", "in_review", content, born);

    const freshBefore = headHash(freshSibling), freshCountBefore = headCount(freshSibling);
    const staleBefore = headHash(staleSibling), staleCountBefore = headCount(staleSibling);
    const res = (await execute(depsFor(room), `ses_clara_${tag}`, { task_id: taskId, action: "complete" })).res;
    return { room, freshSibling, staleSibling, content, hashes: hashesOf(res), freshBefore, freshCountBefore, staleBefore, staleCountBefore };
  };

  const freshnessRegression = async (tag, bornAgoMs, freshFileAgeMs) => {
    const P = tag.toUpperCase();
    const s = await freshnessScenario(tag, bornAgoMs, freshFileAgeMs);
    R(`${P}.fresh-sibling-committed`, headHash(s.freshSibling) !== s.freshBefore && headCount(s.freshSibling) === s.freshCountBefore + 1, `${s.freshCountBefore}->${headCount(s.freshSibling)}`);
    R(`${P}.fresh-sibling-tree-clean`, porcelain(s.freshSibling) === "", `status="${porcelain(s.freshSibling)}"`);
    R(`${P}.fresh-sibling-message-exact`, lastMsg(s.freshSibling) === `feat(runtime): ${s.content}`, `msg="${lastMsg(s.freshSibling)}"`);
    R(`${P}.stale-sibling-not-committed`, headHash(s.staleSibling) === s.staleBefore && headCount(s.staleSibling) === s.staleCountBefore, `${s.staleCountBefore}->${headCount(s.staleSibling)}`);
    R(`${P}.stale-sibling-still-dirty`, porcelain(s.staleSibling) !== "", `status="${porcelain(s.staleSibling)}"`);
    R(`${P}.room-tree-clean`, porcelain(s.room) === "", `status="${porcelain(s.room)}"`);
    R(`${P}.two-repos-committed`, s.hashes.length === 2, `hashes=${s.hashes.join(",")}`);
  };

  await freshnessRegression("mr3", 3 * HOUR, 90 * MINUTE); // sala 3h; irmão tocado há 90min → comitado
  await freshnessRegression("mr4", 5 * HOUR, 2 * HOUR);    // sala 5h; irmão tocado há 2h → comitado

  // =================== SP: ação nativa 'sdet_pass' (27B) ===================
  const spRoom = path.join(sandbox, "sp");
  makeRepo(spRoom);
  writeFileSync(path.join(spRoom, "feature.txt"), "sp dirty\n");
  const depsSP = depsFor(spRoom);

  // -------- SP1: implementador (não-SDET) → erro de autorização -----------
  {
    seedTeam("sp1", "squad-sdet-authz", "ses_lead_sp1");
    member("sp1", "tales", "ses_tales_sp1", "build");
    member("sp1", "hugo", "ses_hugo_sp1", "hugo");
    member("sp1", "clara", "ses_clara_sp1", "clara", 1, "qa");
    task("sp1", "TSP1", "tales", "in_review", "Feat unauthorized sdet_pass");
    calls.length = 0;
    const r = await execute(depsSP, "ses_tales_sp1", { task_id: "TSP1", action: "sdet_pass", notes: "sou implementador" });
    R("SP1.authorization-error", r.err === "Only SDET can invoke sdet_pass", `err="${r.err}" res="${r.res}"`);
    R("SP1.status-unchanged", taskStatus("TSP1") === "in_review", taskStatus("TSP1"));
    R("SP1.notes-unchanged", taskNotes("TSP1") === null, String(taskNotes("TSP1")));
    R("SP1.zero-wakes", calls.length === 0, `calls=${calls.length}`);
  }

  // -------- SP2: Hugo em card in_progress → erro de estado ----------------
  {
    seedTeam("sp2", "squad-sdet-state", "ses_lead_sp2");
    member("sp2", "tales", "ses_tales_sp2", "build");
    member("sp2", "hugo", "ses_hugo_sp2", "hugo");
    member("sp2", "clara", "ses_clara_sp2", "clara", 1, "qa");
    task("sp2", "TSP2", "tales", "in_progress", "Feat still in progress");
    calls.length = 0;
    const r = await execute(depsSP, "ses_hugo_sp2", { task_id: "TSP2", action: "sdet_pass", notes: "cedo demais" });
    R("SP2.state-error-in-progress", r.err === "Task must be in review to record sdet_pass", `err="${r.err}"`);
    R("SP2.status-unchanged", taskStatus("TSP2") === "in_progress", taskStatus("TSP2"));
    R("SP2.zero-wakes", calls.length === 0, `calls=${calls.length}`);
  }

  // -------- SP3: Hugo em card completed → erro de estado ------------------
  {
    seedTeam("sp3", "squad-sdet-done", "ses_lead_sp3");
    member("sp3", "tales", "ses_tales_sp3", "build");
    member("sp3", "hugo", "ses_hugo_sp3", "hugo");
    member("sp3", "clara", "ses_clara_sp3", "clara", 1, "qa");
    task("sp3", "TSP3", "tales", "completed", "Feat already closed");
    calls.length = 0;
    const r = await execute(depsSP, "ses_hugo_sp3", { task_id: "TSP3", action: "sdet_pass", notes: "tarde demais" });
    R("SP3.state-error-completed", r.err === "Task must be in review to record sdet_pass", `err="${r.err}"`);
    R("SP3.zero-wakes", calls.length === 0, `calls=${calls.length}`);
  }

  // -------- SP4: Hugo em card in_review → card permanece + wake da Clara --
  {
    seedTeam("sp4", "squad-sdet-pass", "ses_lead_sp4");
    member("sp4", "tales", "ses_tales_sp4", "build");
    member("sp4", "hugo", "ses_hugo_sp4", "hugo");
    member("sp4", "clara", "ses_clara_sp4", "clara", 1, "qa");
    task("sp4", "TSP4", "tales", "in_review", "Feat ready for QA after SDET");
    const note = "Suíte determinística verde: 44/44 checks (multi-repo + sdet_pass)";
    const spCountBefore = headCount(spRoom);
    calls.length = 0;
    const r = await execute(depsSP, "ses_hugo_sp4", { task_id: "TSP4", action: "sdet_pass", notes: note });
    const claraWakes = calls.filter((c) => c.sessionID === "ses_clara_sp4");
    const canonical = `[System: SDET (Hugo) has verified task with passing deterministic test suite. Notes: "${note}". Ready for Quality Gate audit.]`;

    R("SP4.no-error", r.err === null, r.err);
    R("SP4.status-stays-in-review", taskStatus("TSP4") === "in_review", taskStatus("TSP4"));
    R("SP4.notes-recorded", taskNotes("TSP4") === note, String(taskNotes("TSP4")));
    R("SP4.exactly-one-clara-wake", claraWakes.length === 1, `count=${claraWakes.length}`);
    R("SP4.wake-agent-clara", claraWakes[0]?.agent === "clara", `agent=${claraWakes[0]?.agent}`);
    R("SP4.wake-synthetic", claraWakes[0]?.synthetic === true, `synthetic=${claraWakes[0]?.synthetic}`);
    R("SP4.wake-text-canonical", claraWakes[0]?.parts?.[0]?.text === canonical, claraWakes[0]?.parts?.[0]?.text ?? "(sem texto)");
    R("SP4.zero-extra-wakes", calls.length === 1, `calls=${calls.length}`);
    R(
      "SP4.no-commit-on-sdet-pass",
      headCount(spRoom) === spCountBefore && porcelain(spRoom) !== "",
      `count=${headCount(spRoom)} status="${porcelain(spRoom)}"`,
    );
    R("SP4.return-message", r.res.includes("SDET verification recorded") && r.res.includes(note), r.res);
  }

  // -------- SP5: sala sem Quality Gate → sem throw, notas gravadas --------
  {
    seedTeam("sp5", "squad-no-qa", "ses_lead_sp5");
    member("sp5", "tales", "ses_tales_sp5", "build");
    member("sp5", "hugo", "ses_hugo_sp5", "hugo");
    task("sp5", "TSP5", "tales", "in_review", "Feat sem QA");
    calls.length = 0;
    const r = await execute(depsSP, "ses_hugo_sp5", { task_id: "TSP5", action: "sdet_pass", notes: "sem QA na sala" });
    R("SP5.no-error", r.err === null, r.err);
    R("SP5.status-stays-in-review", taskStatus("TSP5") === "in_review", taskStatus("TSP5"));
    R("SP5.notes-recorded", taskNotes("TSP5") === "sem QA na sala", String(taskNotes("TSP5")));
    R("SP5.zero-wakes", calls.length === 0, `calls=${calls.length}`);
  }

  // -------- SP6: Quality Gate CUSTOM (is_qa=1, agent != "clara") → A2 -----
  //   A2: o wake do sdet_pass deve carregar o agent da PRÓPRIA revisora
  //   (dinâmico), nunca "clara" hardcoded — senão a persona do Quality Gate
  //   custom (ex.: 'gate-custom') é sequestrada pela persona default do server.
  {
    seedTeam("sp6", "squad-sdet-custom-qa", "ses_lead_sp6");
    member("sp6", "tales", "ses_tales_sp6", "build");
    member("sp6", "hugo", "ses_hugo_sp6", "hugo");
    member("sp6", "gate-custom", "ses_gate_sp6", "gate-custom", 1, "qa");
    task("sp6", "TSP6", "tales", "in_review", "Feat custom quality gate");
    const note = "Suíte verde: gate custom";
    calls.length = 0;
    const r = await execute(depsSP, "ses_hugo_sp6", { task_id: "TSP6", action: "sdet_pass", notes: note });
    const gateWakes = calls.filter((c) => c.sessionID === "ses_gate_sp6");
    const canonical = `[System: SDET (Hugo) has verified task with passing deterministic test suite. Notes: "${note}". Ready for Quality Gate audit.]`;
    R("SP6.no-error", r.err === null, r.err);
    R("SP6.status-stays-in-review", taskStatus("TSP6") === "in_review", taskStatus("TSP6"));
    R("SP6.exactly-one-wake", gateWakes.length === 1 && calls.length === 1, `calls=${calls.length}`);
    R("SP6.custom-agent-wake", gateWakes[0]?.agent === "gate-custom", `agent=${gateWakes[0]?.agent}`);
    R("SP6.custom-agent-not-clara", gateWakes[0]?.agent !== "clara", `agent=${gateWakes[0]?.agent}`);
    R("SP6.wake-text-canonical", gateWakes[0]?.parts?.[0]?.text === canonical, gateWakes[0]?.parts?.[0]?.text ?? "(sem texto)");
    R("SP6.wake-synthetic", gateWakes[0]?.synthetic === true, `synthetic=${gateWakes[0]?.synthetic}`);
  }

  // -------- SP7: Quality Gate LEGADO com agent VAZIO → fallback "clara" ----
  //   Retrocompat de agent vazio (linha migrada): `qa.agent || "clara"` precisa
  //   cair na persona canônica "clara" em vez de mandar `undefined` no fio.
  {
    seedTeam("sp7", "squad-sdet-legacy-qa", "ses_lead_sp7");
    member("sp7", "tales", "ses_tales_sp7", "build");
    member("sp7", "hugo", "ses_hugo_sp7", "hugo");
    member("sp7", "legacy-gate", "ses_legacy_sp7", "", 1, "qa");
    task("sp7", "TSP7", "tales", "in_review", "Feat legacy empty agent");
    calls.length = 0;
    const r = await execute(depsSP, "ses_hugo_sp7", { task_id: "TSP7", action: "sdet_pass", notes: "legado vazio" });
    const legacyWakes = calls.filter((c) => c.sessionID === "ses_legacy_sp7");
    R("SP7.no-error", r.err === null, r.err);
    R("SP7.exactly-one-wake", legacyWakes.length === 1 && calls.length === 1, `calls=${calls.length}`);
    R("SP7.fallback-clara", legacyWakes[0]?.agent === "clara", `agent=${legacyWakes[0]?.agent}`);
  }

  // SP7b: retrocompat por NOME (is_qa=0, nome "clara") + agent vazio → "clara".
  {
    seedTeam("sp7b", "squad-sdet-retro-qa", "ses_lead_sp7b");
    member("sp7b", "tales", "ses_tales_sp7b", "build");
    member("sp7b", "hugo", "ses_hugo_sp7b", "hugo");
    member("sp7b", "clara", "ses_clara_sp7b", "", 0, null);
    task("sp7b", "TSP7B", "tales", "in_review", "Feat retrocompat name");
    calls.length = 0;
    const rb = await execute(depsSP, "ses_hugo_sp7b", { task_id: "TSP7B", action: "sdet_pass", notes: "retro" });
    const retroWakes = calls.filter((c) => c.sessionID === "ses_clara_sp7b");
    R("SP7b.no-error", rb.err === null, rb.err);
    R("SP7b.exactly-one-wake", retroWakes.length === 1 && calls.length === 1, `calls=${calls.length}`);
    R("SP7b.fallback-clara", retroWakes[0]?.agent === "clara", `agent=${retroWakes[0]?.agent}`);
  }

  // -------- SP8 removido: a guarda A1 anti-auto-review foi revertida por -----
  // decisão de produto (Maiteux/lead): o sdet_pass apenas declara a suíte verde
  // e passa o bastão à Clara, que de fato audita/fecha; travar por assignee
  // quebraria recuperações de crash onde o Hugo herda o card. O escopo do card
  // é exclusivamente A2.

  try { db.close(); } catch { /* já fechado */ }
  rmSync(sandbox, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  return got;
}

// ---------------------------------------------------------------------------
// 3. Fase REAL: todos os cenários contra o dist autêntico devem passar 100%.
// ---------------------------------------------------------------------------
const realFlow = await runFlow(REAL);
for (const [name, { ok, detail }] of realFlow) check(`[real] ${name}`, ok, detail);

// ---------------------------------------------------------------------------
// 4. Estáticos: paridade src↔dist (27A/27B) + anti-mock.
// ---------------------------------------------------------------------------
const SRC_TC = readFileSync(path.join(SRC, "tools", "team-tasks-complete.ts"), "utf8");
const STATIC_LITERALS = [
  "resolveCommitTargets",
  "findNestedRepoRoots",
  "findSiblingRepoRoots",
  "resolveFreshnessSince",
  "hasFreshDirt(sibling, sinceMs)",
  "ENSEMBLE_AUTOCOMMIT_REPOS",
  "Task completed and locally committed: ",
  "Task completed; working tree already clean (no commit needed)",
  'git -C "$1" add -A && git -C "$1" commit -m "$2"',
  "tasks-complete:autocommit:committed",
  "tasks-complete:autocommit:skip-non-root",
  "Only SDET can invoke sdet_pass",
  "Task must be in review to record sdet_pass",
  "SDET verification recorded",
  "tasks-complete:sdet-pass:wake-clara:ok",
  "SDET (Hugo) has verified task with passing deterministic test suite",
];
for (const lit of STATIC_LITERALS) {
  check(`paridade src↔dist: literal "${lit.slice(0, 46)}"`, SRC_TC.includes(lit) && distRaw.includes(lit));
}
check(
  "guarda anti-árvore-de-terceiro presente em src e dist (toplevel === dir)",
  SRC_TC.includes("if (primary && primary === normalizeDir(dir)) {") && distRaw.includes("if (primary && primary === normalizeDir(dir)) {"),
);
check(
  "persona-sequester immunity: wake do Quality Gate usa agent EXPLÍCITO dinâmico da revisora (qa.agent || \"clara\") em src e dist",
  SRC_TC.includes('agent: qa.agent || "clara",') && distRaw.includes('agent: qa.agent || "clara",'),
);
check(
  "A2: literal 'agent: \"clara\"' hardcoded AUSENTE do src (wake usa a persona dinâmica da revisora)",
  !SRC_TC.includes('agent: "clara"'),
);

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
// 5. PROVA DE MUTAÇÃO: patch determinístico no bundle dist + reexecução.
//    Cada mutante precisa FALHAR nas sentinelas do cenário alvo (sensibilidade)
//    e PERMANECER VERDE nos fluxos intactos (cirurgia).
// ---------------------------------------------------------------------------
const MUTATIONS = [
  {
    id: "M1",
    desc: "descoberta de repo aninhado desabilitada (só o room comita)",
    from: "for (const nested of findNestedRepoRoots(dir, NESTED_REPO_SCAN_DEPTH)) {",
    to: "for (const nested of []) {",
    detect: ["MR1.suffix-lists-two-repos", "MR1.two-distinct-hashes", "MR1.nested-head-in-suffix", "MR1.nested-advances-one-commit", "MR1.nested-tree-clean", "MR1.nested-message-exact", "MR1.room-tree-clean"],
    unaffected: ["MR1.room-message-exact", "SP4.status-stays-in-review", "SP4.notes-recorded"],
  },
  {
    id: "M2",
    desc: "check de autorização SDET removido (não-SDET pode invocar sdet_pass)",
    from: "if (!isSDETMEmber(deps.db, teamInfo.teamId, caller)) {",
    to: "if (false) {",
    detect: ["SP1.authorization-error", "SP1.notes-unchanged", "SP1.zero-wakes"],
    unaffected: ["SP4.status-stays-in-review", "SP4.exactly-one-clara-wake", "SP1.status-unchanged"],
  },
  {
    id: "M3",
    desc: "contrato de estado do sdet_pass adulterado (mensagem trocada)",
    from: '"Task must be in review to record sdet_pass"',
    to: '"MUTATED-STATE-GATE"',
    detect: ["SP2.state-error-in-progress", "SP3.state-error-completed"],
    unaffected: ["SP1.authorization-error", "SP4.status-stays-in-review", "SP4.wake-text-canonical"],
  },
  {
    id: "M4",
    desc: "agent explícito dinâmico da revisora removido no wake de sdet_pass (persona sequestrável)",
    from: 'agent: qa.agent || "clara",',
    to: "agent: undefined,",
    detect: ["SP4.wake-agent-clara"],
    unaffected: ["SP4.wake-text-canonical", "SP4.exactly-one-clara-wake", "SP4.status-stays-in-review"],
  },
  {
    id: "M5",
    desc: "texto canônico do wake de sdet_pass adulterado",
    from: "SDET (Hugo) has verified task with passing deterministic test suite",
    to: "SDET verified something",
    detect: ["SP4.wake-text-canonical"],
    unaffected: ["SP4.wake-agent-clara", "SP4.exactly-one-clara-wake", "SP4.notes-recorded"],
  },
  {
    id: "M6",
    desc: "janela de frescor dos irmãos desabilitada (comita árvore alheia antiga)",
    from: "if (await hasFreshDirt(sibling, sinceMs)) add(sibling)",
    to: "add(sibling)",
    detect: ["MR2.only-room-committed", "MR2.stale-sibling-not-committed", "MR2.stale-sibling-still-dirty", "MR3.stale-sibling-not-committed", "MR3.stale-sibling-still-dirty"],
    unaffected: ["MR1.room-tree-clean", "MR1.room-message-exact", "SP4.wake-text-canonical"],
  },
  {
    id: "M7",
    desc: "relógio estático de 1h reintroduzido no lugar da janela vinculada ao ciclo (regressão HARNESS-27C)",
    from: "const threshold = sinceMs",
    to: "const threshold = Date.now() - 60 * 60 * 1000",
    detect: ["MR3.fresh-sibling-committed", "MR4.fresh-sibling-committed"],
    unaffected: ["MR3.stale-sibling-not-committed", "MR4.stale-sibling-not-committed", "MR2.stale-sibling-not-committed", "SP4.wake-text-canonical"],
  },
  {
    id: "M8",
    desc: "A2 regressão: agent hardcoded 'clara' no wake do sdet_pass (persona custom sequestrada)",
    from: 'agent: qa.agent || "clara",',
    to: 'agent: "clara",',
    detect: ["SP6.custom-agent-wake", "SP6.custom-agent-not-clara"],
    unaffected: ["SP4.wake-agent-clara", "SP7.fallback-clara", "SP7b.fallback-clara"],
  },
  {
    id: "M9",
    desc: "A2 fallback retrocompat adulterado (agent vazio não cai mais em 'clara')",
    from: 'agent: qa.agent || "clara",',
    to: 'agent: qa.agent || "MUTATED-FALLBACK",',
    detect: ["SP7.fallback-clara", "SP7b.fallback-clara"],
    unaffected: ["SP6.custom-agent-wake", "SP4.wake-agent-clara"],
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

  const mutantFile = path.join(TMP, `_mr_sdet_${m.id.toLowerCase()}.mjs`);
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
