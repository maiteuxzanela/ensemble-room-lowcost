#!/usr/bin/env node
/**
 * QUALITY GATE DETERMINÍSTICO — [TICKET-33A] + [TICKET-33B]
 * @maiteuxzanela/ensemble-room-lowcost
 *
 * Engenheiro de Testes (SDET): Hugo.
 *
 * Sob teste (src/ e dist/ REAIS, SQLite real via node:sqlite, git real — SEM MOCKS):
 *
 *   [TICKET-33A] Validação estrita de `action` em team_tasks_complete
 *     - executeTeamTasksComplete -> src/tools/team-tasks-complete.ts (guard
 *       fail-fast `TEAM_TASK_ACTIONS` + throw INVALID_ACTION ANTES de qualquer
 *       UPDATE/hook);
 *     - Schema V1 (Zod enum) em src/index.ts e V2 (JSON Schema enum) em
 *       src/v2-tools.ts; action opcional (fora de `required`).
 *
 *   [TICKET-33B] Blindagem de team_results + resiliência de team_broadcast
 *     - executeTeamResults -> src/tools/team-results.ts (isolamento de
 *       destinatário por callerName/lead; marca read=1 SOMENTE o que consumiu);
 *     - broadcastMessageFanout / executeTeamBroadcast -> src/messaging.ts +
 *       src/tools/team-broadcast.ts (fan-out 1 linha por destinatário, entrega
 *       parcial resiliente, silentLead passivo);
 *     - buildLeadSystemPrompt / buildTeammateSystemPrompt -> src/system-prompt.ts
 *       (injeção de broadcasts para o lead silencioso e para os teammates).
 *
 * Cobertura:
 *   A. Ações inválidas ('approve','review','submit','rejected','in_progress',
 *      'done','foo','bar','COMPLETE','submit_review ') → throw INVALID_ACTION com
 *      mensagem byte-exata; status do card inalterado; ZERO promptAsync; ZERO
 *      auto-commit (git real em sandbox, HEAD intacto, árvore ainda suja mesmo
 *      com ledger presente e caller=lead — o cenário mais adversarial).
 *      action undefined/null → default 'complete' (não lança).
 *      Ações válidas preservadas: complete, submit_review, reject, sdet_pass.
 *      Paridade de schema V1↔V2 (enum com exatamente os 4 valores; action opcional).
 *      Paridade src↔dist dos literais INVALID_ACTION / Allowed actions.
 *   B. team_results: membro A NÃO vê DM privada de B nem a do lead; lead NÃO vê
 *      DM de membro; broadcasts (to_name NULL) visíveis; SOMENTE as mensagens
 *      consumidas viram read=1; filtro `from` respeita o isolamento.
 *   C. team_broadcast: fan-out 1 linha/destinatário com ids distintos; entrega
 *      ativa (lead + membros) e contagem de wakes correta; falha parcial de
 *      transporte deixa APENAS o destinatário falho undelivered (resiliente);
 *      silentLead persiste a linha do lead sem wake e a injeção no system prompt
 *      do lead a entrega e marca delivered; injeção no prompt do teammate para a
 *      linha undelivered (recovery); pulo de membro que já reportou; zero
 *      destinatários; limite de 10KB validado antes de qualquer insert.
 *
 * PROVA DE MUTAÇÃO (patch determinístico no bundle dist + reexecução dos mesmos
 * cenários): cada mutante precisa FALHAR nas sentinelas do cenário alvo
 * (sensibilidade) e PERMANECER VERDE nos fluxos não relacionados (cirurgia).
 *
 * Único seam: cliente SDK do OpenCode (fronteira externa), reduzido a um recorder
 * determinístico de promptAsync. SQLite, bundle dist, schemas DDL e git são reais.
 *
 * Uso: node tests/test_ticket_harness_33_board_and_messaging.mjs
 * Exit: 0 = todos os checks PASS; 1 = há FAIL.
 */

import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";

const REPO = path.resolve(import.meta.dirname, "..");
const DIST = path.join(REPO, "dist/index.js");
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

const EXPECTED_ACTIONS = ["complete", "submit_review", "reject", "sdet_pass"];

// ---------------------------------------------------------------------------
// 0. Harness: dist real + exportação dos símbolos sob teste (sem mocks).
// ---------------------------------------------------------------------------
const REQUIRED_SYMBOLS = [
  "createDb",
  "executeTeamTasksComplete",
  "executeTeamBroadcast",
  "executeTeamResults",
  "broadcastMessageFanout",
  "sendMessage",
  "markDelivered",
  "getUndeliveredMessages",
  "MemberRegistry",
  "DEFAULT_CONFIG",
  "MIGRATIONS",
  "TEAM_TASK_ACTIONS",
];
const distRaw = readFileSync(DIST, "utf8");

const buildHarnessCode = (raw) => {
  const existingExport = raw.match(/export\s*\{([^}]*)\}\s*;?\s*$/)?.[1] ?? "";
  const already = new Set(
    existingExport.split(",").map((s) => s.trim().split(/\s+as\s+/).pop()).filter(Boolean),
  );
  const need = REQUIRED_SYMBOLS.filter((s) => !already.has(s));
  return { code: raw + (need.length ? `\nexport { ${need.join(", ")} };\n` : ""), need };
};

{
  const missing = REQUIRED_SYMBOLS.filter(
    (s) => !new RegExp(`(function|class|var|const|let)\\s+${s}\\b`).test(distRaw),
  );
  check(
    "harness: dist declara todos os símbolos exigidos",
    missing.length === 0,
    missing.join(",") || `${REQUIRED_SYMBOLS.length} símbolos`,
  );
  writeFileSync(path.join(TMP, "_h33_harness.mjs"), buildHarnessCode(distRaw).code);
}
const REAL = await import(path.join(TMP, "_h33_harness.mjs"));

// ---------------------------------------------------------------------------
// 1. runFlow: TODOS os cenários contra um módulo harness dado. Cada execução cria
//    SQLite NOVO + git repo real em scratch isolado, removidos ao final. Retorna
//    Map<checkName, {ok, detail}>. NUNCA lança: cada passo é encapsulado em
//    tryCall, garantindo que um mutante que quebre um fluxo ainda rode por inteiro
//    (sensibilidade sem aborte antecipado).
// ---------------------------------------------------------------------------
let flowSeq = 0;
const flush = async () => {
  await new Promise((r) => setImmediate(r));
  await new Promise((r) => setImmediate(r));
};

async function runFlow(mod) {
  const { createDb, executeTeamTasksComplete, executeTeamBroadcast, executeTeamResults, getUndeliveredMessages } = mod;

  const dir = path.join(TMP, `h33_flow_${process.pid}_${flowSeq++}`);
  const gitRepo = path.join(dir, "roomrepo");
  mkdirSync(gitRepo, { recursive: true });
  // git real determinístico (evidência de auto-commit / não-commit).
  execFileSync("git", ["init", "-q"], { cwd: gitRepo });
  execFileSync("git", ["config", "user.email", "hugo@test.local"], { cwd: gitRepo });
  execFileSync("git", ["config", "user.name", "Hugo SDET"], { cwd: gitRepo });
  writeFileSync(path.join(gitRepo, "ledger.txt"), "v1\n");
  execFileSync("git", ["add", "ledger.txt"], { cwd: gitRepo });
  execFileSync("git", ["commit", "-q", "-m", "init"], { cwd: gitRepo });
  writeFileSync(path.join(gitRepo, "ledger.txt"), "v2-dirty\n"); // árvore suja
  const head = () => execFileSync("git", ["rev-parse", "HEAD"], { cwd: gitRepo }).toString().trim();
  const porcelain = () => execFileSync("git", ["status", "--porcelain"], { cwd: gitRepo }).toString();

  const db = createDb(path.join(dir, "ensemble.db"));
  const registry = new mod.MemberRegistry();
  const calls = [];
  const failSessions = new Set();
  const client = {
    session: {
      create: async () => ({ data: { id: "ses_unused" } }),
      promptAsync: async (o) => {
        calls.push(o);
        if (failSessions.has(o.sessionID)) throw new Error(`transport down: ${o.sessionID}`);
        return {};
      },
      abort: async () => ({}),
    },
    tui: { showToast: async () => ({}), selectSession: async () => ({}) },
    worktree: { create: async () => ({ data: {} }), remove: async () => ({}), list: async () => ({ data: [] }), reset: async () => ({}) },
    workspace: { create: async () => ({ data: {} }), remove: async () => ({}), list: async () => ({ data: [] }) },
  };
  let activeConfig = { ...mod.DEFAULT_CONFIG, silentLead: false };
  const progressTracker = {}; // não usado pelos alvos desta suíte
  const deps = { db, registry, tracker: {}, purgeApprovals: {}, client, directory: gitRepo, config: activeConfig, progressTracker };

  const got = new Map();
  const R = (name, ok, detail) => got.set(name, { ok: !!ok, detail: detail ?? "" });
  const tryCall = async (fn) => {
    try {
      return { ok: true, value: await fn() };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  };

  const now = Date.now();
  let seq = 0;
  const seedTeam = (id, name, lead) => {
    db.run("INSERT INTO project (id, name, path, status, time_created, time_updated) VALUES ('default','Default','','active',?,?) ON CONFLICT DO NOTHING", [now, now]);
    db.run("INSERT INTO team (id, name, project_id, lead_session_id, status, delegate, time_created, time_updated) VALUES (?,?,'default',?,'active',0,?,?)", [id, name, lead, now, now]);
  };
  const member = (teamId, name, ses, agent, isQa = 0, exec = "idle", ctx = null, reported = 0) => {
    db.run(
      `INSERT INTO team_member (team_id, name, session_id, agent, status, execution_status, is_qa, role, spawn_context, reported_to_lead, time_created, time_updated)
       VALUES (?,?,?,?, 'ready', ?, ?, NULL, ?, ?, ?, ?)`,
      [teamId, name, ses, agent, exec, isQa, ctx, reported, now, now],
    );
    registry.register(teamId, name, ses);
  };
  const task = (id, teamId, status, assignee) => {
    db.run(
      "INSERT INTO team_task (id, team_id, content, status, priority, assignee, time_created, time_updated) VALUES (?,?,?,?, 'high',?,?,?)",
      [id, teamId, `Card ${id}`, status, assignee, now, now],
    );
  };
  const seedMsg = (teamId, from, to, content, { delivered = 0, read = 0 } = {}) => {
    const id = `m_${process.pid}_${flowSeq}_${seq++}`;
    db.run(
      "INSERT INTO team_message (id, team_id, from_name, to_name, content, delivered, read, time_created) VALUES (?,?,?,?,?,?,?,?)",
      [id, teamId, from, to, content, delivered, read, now + seq],
    );
    return id;
  };
  const status = (id) => db.query("SELECT status FROM team_task WHERE id = ?").get(id)?.status;
  const readFlag = (id) => (id ? db.query("SELECT read, delivered, to_name FROM team_message WHERE id = ?").get(id) : null);
  const rowsFor = (teamId, content) =>
    db.query("SELECT id, to_name, from_name, delivered FROM team_message WHERE team_id = ? AND content = ? ORDER BY to_name ASC").all(teamId, content);

  // ======================= (A) team_tasks_complete ========================
  // Sala adversarial: lead caller, card em in_review, ledger presente e árvore suja.
  seedTeam("ta", "squad-a", "ses_lead_a");
  member("ta", "tulio", "ses_tulio_a", "build");
  member("ta", "clara", "ses_clara_a", "clara", 1);
  member("ta", "hugo", "ses_hugo_a", "hugo");
  task("t_a1", "ta", "in_review", "tulio");
  db.run("INSERT INTO team_modified_file (team_id, file_path, time_created) VALUES ('ta', ?, ?)", [path.join(gitRepo, "ledger.txt"), now]);

  const headBefore = head();
  calls.length = 0;
  const invalidActions = ["approve", "review", "submit", "rejected", "in_progress", "done", "foo", "bar", "COMPLETE", "submit_review "];
  let allRejected = true;
  let msgMismatch = null;
  let statusDrift = null;
  for (const a of invalidActions) {
    const r = await tryCall(() => executeTeamTasksComplete(deps, { task_id: "t_a1", action: a }, "ses_lead_a"));
    const expected = `INVALID_ACTION: Unknown action "${a}". Allowed actions: complete, submit_review, reject, sdet_pass.`;
    if (r.ok) { allRejected = false; msgMismatch = `não lançou para "${a}"`; break; }
    if (r.error !== expected) { allRejected = false; msgMismatch = `"${a}": ${r.error}`; break; }
    if (status("t_a1") !== "in_review") { statusDrift = `status virou ${status("t_a1")} em "${a}"`; break; }
  }
  R("A1.throws-invalid-action", allRejected, msgMismatch ?? `${invalidActions.length} ações rejeitadas`);
  R("A1.error-message-exact", msgMismatch === null, msgMismatch ?? "mensagem byte-exata");
  R("A1.task-status-unchanged", statusDrift === null && status("t_a1") === "in_review", statusDrift ?? "in_review");
  R("A1.zero-wakes", calls.length === 0, `promptAsync=${calls.length}`);
  const headAfter = head();
  R("A1.no-auto-commit", headAfter === headBefore, `before=${headBefore.slice(0, 8)} after=${headAfter.slice(0, 8)}`);
  R("A1.repo-still-dirty", porcelain().includes("ledger.txt"), porcelain().trim().replace(/\n/g, ";"));

  // A2 — action undefined / null seguem o default 'complete' (não lançam).
  seedTeam("ta2", "squad-a2", "ses_lead_a2");
  member("ta2", "tulio", "ses_tulio_a2", "build");
  task("t_a2u", "ta2", "in_progress", "tulio");
  calls.length = 0;
  const rUndef = await tryCall(() => executeTeamTasksComplete(deps, { task_id: "t_a2u" }, "ses_tulio_a2"));
  R("A2.undefined-defaults-complete", rUndef.ok && /^Completed task:/.test(rUndef.value ?? ""), rUndef.error ?? rUndef.value);
  task("t_a2n", "ta2", "in_progress", "tulio");
  const rNull = await tryCall(() => executeTeamTasksComplete(deps, { task_id: "t_a2n", action: null }, "ses_tulio_a2"));
  R("A2.null-defaults-complete", rNull.ok && /^Completed task:/.test(rNull.value ?? ""), rNull.error ?? rNull.value);

  // A3 — ações válidas preservadas (o guard não as bloqueia).
  seedTeam("ta3", "squad-a3", "ses_lead_a3");
  member("ta3", "tulio", "ses_tulio_a3", "build");
  member("ta3", "clara", "ses_clara_a3", "clara", 1);
  member("ta3", "hugo", "ses_hugo_a3", "hugo");
  task("t_a3s", "ta3", "in_progress", "tulio");
  calls.length = 0;
  const rSub = await tryCall(() => executeTeamTasksComplete(deps, { task_id: "t_a3s", action: "submit_review" }, "ses_tulio_a3"));
  R("A3.submit-review-valid", rSub.ok && status("t_a3s") === "in_review", rSub.error ?? `status=${status("t_a3s")}`);

  task("t_a3r", "ta3", "in_review", "tulio");
  calls.length = 0;
  const rRej = await tryCall(() => executeTeamTasksComplete(deps, { task_id: "t_a3r", action: "reject", notes: "reprova" }, "ses_clara_a3"));
  R("A3.reject-valid", rRej.ok && status("t_a3r") === "in_progress", rRej.error ?? `status=${status("t_a3r")}`);

  task("t_a3p", "ta3", "in_review", "tulio");
  calls.length = 0;
  const rSdet = await tryCall(() => executeTeamTasksComplete(deps, { task_id: "t_a3p", action: "sdet_pass", notes: "suite verde" }, "ses_hugo_a3"));
  R("A3.sdet-pass-valid", rSdet.ok && status("t_a3p") === "in_review" && /SDET verification recorded/.test(rSdet.value ?? ""), rSdet.error ?? rSdet.value);

  // ======================= (B) team_results isolamento =====================
  seedTeam("tb", "squad-b", "ses_lead_b");
  member("tb", "alice", "ses_alice_b", "build");
  member("tb", "bob", "ses_bob_b", "build");
  member("tb", "cara", "ses_cara_b", "build");

  const bM1 = seedMsg("tb", "alice", "bob", "DM-ALICE-TO-BOB");
  const bM2 = seedMsg("tb", "alice", "lead", "DM-ALICE-TO-LEAD");
  const bM3 = seedMsg("tb", "lead", "alice", "DM-LEAD-TO-ALICE");
  const bM4 = seedMsg("tb", "alice", null, "BCAST-LEGACY-NULL");
  const bM5 = seedMsg("tb", "alice", "bob", "BCAST-BOB");
  const bM6 = seedMsg("tb", "bob", "cara", "DM-BOB-TO-CARA");

  const outBob = await tryCall(() => executeTeamResults(deps, {}, "ses_bob_b"));
  const bob = outBob.value ?? "";
  R("B1.bob-sees-own-and-broadcast", outBob.ok && bob.includes("DM-ALICE-TO-BOB") && bob.includes("BCAST-LEGACY-NULL") && bob.includes("BCAST-BOB"), outBob.error ?? "");
  R("B1.bob-excludes-lead-dm", !bob.includes("DM-ALICE-TO-LEAD") && !bob.includes("DM-LEAD-TO-ALICE"), "leak de DM do lead");
  R("B1.bob-excludes-cara-dm", !bob.includes("DM-BOB-TO-CARA"), "vazou DM cara");
  R(
    "B1.others-stay-unread",
    readFlag(bM1).read === 1 && readFlag(bM4).read === 1 && readFlag(bM5).read === 1 &&
      readFlag(bM2).read === 0 && readFlag(bM3).read === 0 && readFlag(bM6).read === 0,
    `m1=${readFlag(bM1).read} m2=${readFlag(bM2).read} m3=${readFlag(bM3).read} m6=${readFlag(bM6).read}`,
  );

  const outAlice = await tryCall(() => executeTeamResults(deps, {}, "ses_alice_b"));
  const alice = outAlice.value ?? "";
  R("B2.alice-sees-lead-dm", outAlice.ok && alice.includes("DM-LEAD-TO-ALICE"), outAlice.error ?? "");
  R("B2.alice-excludes-bob-dm", !alice.includes("DM-ALICE-TO-BOB") && !alice.includes("BCAST-BOB") && !alice.includes("DM-ALICE-TO-LEAD") && !alice.includes("DM-BOB-TO-CARA"), "alice viu DM alheia");
  R("B2.alice-consumed-marked", readFlag(bM3).read === 1 && readFlag(bM1).read === 1, `m3=${readFlag(bM3).read} m1=${readFlag(bM1).read}`);

  const outLead = await tryCall(() => executeTeamResults(deps, {}, "ses_lead_b"));
  const lead = outLead.value ?? "";
  R("B3.lead-sees-own", outLead.ok && lead.includes("DM-ALICE-TO-LEAD"), outLead.error ?? "");
  R("B3.lead-excludes-member-dm", !lead.includes("DM-ALICE-TO-BOB") && !lead.includes("DM-LEAD-TO-ALICE") && !lead.includes("DM-BOB-TO-CARA"), "lead viu DM de membro");
  R("B3.lead-consumed-marked", readFlag(bM2).read === 1, `m2=${readFlag(bM2).read}`);

  const outCara = await tryCall(() => executeTeamResults(deps, {}, "ses_cara_b"));
  const cara = outCara.value ?? "";
  R("B4.cara-sees-own", outCara.ok && cara.includes("DM-BOB-TO-CARA") && !cara.includes("DM-ALICE-TO-BOB"), outCara.error ?? "");

  // B5 — filtro `from` respeita isolamento.
  const bM7 = seedMsg("tb", "alice", "bob", "FR-ALICE-TO-BOB");
  const bM8 = seedMsg("tb", "lead", "bob", "FR-LEAD-TO-BOB");
  const outFrom = await tryCall(() => executeTeamResults(deps, { from: "alice" }, "ses_bob_b"));
  const fromOut = outFrom.value ?? "";
  R("B5.from-filter-isolated", outFrom.ok && fromOut.includes("FR-ALICE-TO-BOB") && !fromOut.includes("FR-LEAD-TO-BOB"), outFrom.error ?? "");
  R("B5.from-filter-only-consumed-read", readFlag(bM7).read === 1 && readFlag(bM8).read === 0, `m7=${readFlag(bM7).read} m8=${readFlag(bM8).read}`);

  const outResidual = await tryCall(() => executeTeamResults(deps, {}, "ses_bob_b"));
  const residual = outResidual.value ?? "";
  R("B6.residual-then-empty", outResidual.ok && residual.includes("FR-LEAD-TO-BOB") && !residual.includes("FR-ALICE-TO-BOB"), outResidual.error ?? residual);
  const outEmpty = await tryCall(() => executeTeamResults(deps, {}, "ses_bob_b"));
  R("B7.no-unread-second-call", outEmpty.ok && outEmpty.value === "No unread messages.", outEmpty.value ?? outEmpty.error);

  // ======================= (C) team_broadcast =============================
  // C1 — entrega ativa (silentLead=false), fan-out 1 linha/destinatário.
  seedTeam("tc1", "squad-c1", "ses_lead_c1");
  member("tc1", "alice", "ses_alice_c1", "build");
  member("tc1", "bob", "ses_bob_c1", "build");
  member("tc1", "cara", "ses_cara_c1", "build");
  activeConfig.silentLead = false;
  calls.length = 0;
  const c1 = await tryCall(() => executeTeamBroadcast(deps, { text: "HELLO-ALL" }, "ses_alice_c1"));
  await flush();
  const c1rows = rowsFor("tc1", "HELLO-ALL");
  const c1names = c1rows.map((r) => r.to_name).sort();
  R("C1.rows-per-recipient", c1.ok && c1rows.length === 3 && JSON.stringify(c1names) === JSON.stringify(["bob", "cara", "lead"]), c1.error ?? JSON.stringify(c1names));
  R("C1.recipient-count", c1.ok && c1.value === "Broadcast sent to 3 recipients.", c1.value ?? c1.error);
  R("C1.distinct-ids", new Set(c1rows.map((r) => r.id)).size === c1rows.length, `ids=${c1rows.length}`);
  const wakeSessions = calls.map((c) => c.sessionID).sort();
  R(
    "C1.wakes-per-recipient",
    JSON.stringify(wakeSessions) === JSON.stringify(["ses_bob_c1", "ses_cara_c1", "ses_lead_c1"]),
    JSON.stringify(wakeSessions),
  );
  R("C1.sender-excluded", !calls.some((c) => c.sessionID === "ses_alice_c1") && !c1rows.some((r) => r.to_name === "alice"), "sender recebeu");
  R("C1.delivered-after-success", c1rows.every((r) => r.delivered === 1), c1rows.map((r) => `${r.to_name}=${r.delivered}`).join(","));

  // C2 — falha parcial de transporte: SOMENTE o destinatário falho fica undelivered.
  seedTeam("tc2", "squad-c2", "ses_lead_c2");
  member("tc2", "alice", "ses_alice_c2", "build");
  member("tc2", "bob", "ses_bob_c2", "build", 0, "standby", "CTX_BOB");
  member("tc2", "cara", "ses_cara_c2", "build");
  calls.length = 0;
  failSessions.clear();
  failSessions.add("ses_bob_c2");
  const c2 = await tryCall(() => executeTeamBroadcast(deps, { text: "FAIL-TEXT" }, "ses_alice_c2"));
  await flush();
  const c2bob = rowsFor("tc2", "FAIL-TEXT").find((r) => r.to_name === "bob");
  const c2others = rowsFor("tc2", "FAIL-TEXT").filter((r) => r.to_name !== "bob");
  R("C2.failed-recipient-undelivered", c2.ok && c2bob && c2bob.delivered === 0, c2.error ?? JSON.stringify(c2bob));
  R("C2.succeeded-recipients-delivered", c2others.length === 2 && c2others.every((r) => r.delivered === 1), c2others.map((r) => `${r.to_name}=${r.delivered}`).join(","));
  const bobExec = db.query("SELECT execution_status FROM team_member WHERE team_id = 'tc2' AND name = 'bob'").get();
  R("C2.standby-reverted", bobExec.execution_status === "standby", bobExec.execution_status);
  failSessions.clear();

  // C3 — silentLead: linha do lead persistida sem wake; injeção no prompt a entrega.
  seedTeam("tc3", "squad-c3", "ses_lead_c3");
  member("tc3", "alice", "ses_alice_c3", "build");
  member("tc3", "bob", "ses_bob_c3", "build");
  activeConfig.silentLead = true;
  calls.length = 0;
  const c3 = await tryCall(() => executeTeamBroadcast(deps, { text: "SILENT-LEAD-MSG" }, "ses_alice_c3"));
  await flush();
  const c3lead = rowsFor("tc3", "SILENT-LEAD-MSG").find((r) => r.to_name === "lead");
  const c3bob = rowsFor("tc3", "SILENT-LEAD-MSG").find((r) => r.to_name === "bob");
  R("C3.lead-row-persisted-undelivered", c3.ok && c3lead && c3lead.delivered === 0, c3.error ?? JSON.stringify(c3lead));
  R("C3.lead-not-prompted", !calls.some((c) => c.sessionID === "ses_lead_c3"), JSON.stringify(calls.map((c) => c.sessionID)));
  R("C3.member-prompted", calls.some((c) => c.sessionID === "ses_bob_c3") && c3bob?.delivered === 1, JSON.stringify(c3bob));
  R("C3.return-count-silent", c3.value === "Broadcast sent to 1 recipient.", c3.value ?? c3.error);
  // Injeção no prompt do lead (mesmo em silentLead) entrega e marca delivered.
  const leadPrompt = mod.buildLeadSystemPrompt(db, "tc3", activeConfig);
  R("C3.lead-injection-silent", leadPrompt.includes("SILENT-LEAD-MSG") && leadPrompt.includes("[From alice]"), leadPrompt.includes("SILENT-LEAD-MSG") ? "contém" : "ausente");
  const c3leadAfter = readFlag(c3lead?.id);
  R("C3.lead-injection-marks-delivered", c3leadAfter?.delivered === 1, `delivered=${c3leadAfter?.delivered}`);
  activeConfig.silentLead = false;
  // Injeção no prompt do teammate para linha undelivered (recovery da falha C2).
  const bobPrompt = mod.buildTeammateSystemPrompt(db, "tc2", "bob", activeConfig);
  R("C3.team-injection-failed-delivery", bobPrompt.includes("FAIL-TEXT") && bobPrompt.includes("[From alice]"), bobPrompt.includes("FAIL-TEXT") ? "contém" : "ausente");
  const c2bobAfter = readFlag(c2bob?.id);
  R("C3.team-injection-marks-delivered", c2bobAfter?.delivered === 1, `delivered=${c2bobAfter?.delivered}`);

  // C4 — membro que já reportou conclusão é pulado (não re-acordado).
  seedTeam("tc4", "squad-c4", "ses_lead_c4");
  member("tc4", "alice", "ses_alice_c4", "build");
  member("tc4", "bob", "ses_bob_c4", "build", 0, "idle", null, 1);
  member("tc4", "cara", "ses_cara_c4", "build");
  calls.length = 0;
  const c4 = await tryCall(() => executeTeamBroadcast(deps, { text: "SKIP-DONE" }, "ses_alice_c4"));
  await flush();
  const c4names = rowsFor("tc4", "SKIP-DONE").map((r) => r.to_name).sort();
  R("C4.skip-completed-member", !c4names.includes("bob") && JSON.stringify(c4names) === JSON.stringify(["cara", "lead"]), JSON.stringify(c4names));
  R("C4.return-count-skip", c4.value === "Broadcast sent to 2 recipients.", c4.value ?? c4.error);

  // C5 — zero destinatários (sender = lead, sala só com o lead).
  seedTeam("tc5", "squad-c5", "ses_lead_c5");
  calls.length = 0;
  const c5 = await tryCall(() => executeTeamBroadcast(deps, { text: "NOBODY" }, "ses_lead_c5"));
  const c5rows = db.query("SELECT COUNT(*) AS c FROM team_message WHERE team_id = 'tc5'").get();
  R("C5.zero-recipients", c5.ok && c5.value === "Broadcast sent to 0 recipients." && c5rows.c === 0, c5.error ?? c5.value);

  // C6 — limite de 10KB validado ANTES de qualquer insert.
  seedTeam("tc6", "squad-c6", "ses_lead_c6");
  member("tc6", "alice", "ses_alice_c6", "build");
  member("tc6", "bob", "ses_bob_c6", "build");
  const big = "x".repeat(11 * 1024);
  let oversizeThrew = false;
  const rBig = await tryCall(() => executeTeamBroadcast(deps, { text: big }, "ses_alice_c6"));
  oversizeThrew = !rBig.ok && /10KB/.test(rBig.error ?? "");
  const bigRows = db.query("SELECT COUNT(*) AS c FROM team_message WHERE team_id = 'tc6'").get();
  R("C6.rejects-oversize", oversizeThrew, rBig.error ?? "não lançou");
  R("C6.no-rows-on-oversize", bigRows.c === 0, `rows=${bigRows.c}`);

  // getUndeliveredMessages sanity (linha do lead silencioso segue pendente em c3).
  const undeliv = getUndeliveredMessages(db, "tc3");
  R("C7.undelivered-query-sees-pending", Array.isArray(undeliv), "shape");

  // Fecha o SQLite (WAL) antes de remover o scratch.
  try { db.close(); } catch { /* já fechado */ }
  rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  return got;
}

// ---------------------------------------------------------------------------
// 2. Fase REAL: todos os cenários contra o dist autêntico devem passar 100%.
// ---------------------------------------------------------------------------
let realFlow;
try {
  realFlow = await runFlow(REAL);
  for (const [name, { ok, detail }] of realFlow) check(`[real] ${name}`, ok, detail);
} catch (err) {
  check("[real] fluxo executável por completo", false, String(err?.stack ?? err));
  realFlow = new Map();
}

// ---------------------------------------------------------------------------
// 3. Paridade src↔dist + schema V1↔V2 + anti-mock.
// ---------------------------------------------------------------------------
{
  const srcIndex = readFileSync(path.join(SRC, "index.ts"), "utf8");
  const srcV2 = readFileSync(path.join(SRC, "v2-tools.ts"), "utf8");
  const srcTc = readFileSync(path.join(SRC, "tools", "team-tasks-complete.ts"), "utf8");

  const v1 = srcIndex.match(/action:\s*tool\.schema\.enum\(\[([^\]]*)\]\)/)?.[1];
  const v1vals = v1 ? v1.split(",").map((s) => s.trim().replace(/^["']|["']$/g, "")).filter(Boolean) : null;
  check("schema V1: enum exatamente as 4 ações", JSON.stringify(v1vals) === JSON.stringify(EXPECTED_ACTIONS), JSON.stringify(v1vals));

  const v2enum = srcV2.match(/action:\s*\{[\s\S]*?enum:\s*\[([^\]]*)\]/)?.[1];
  const v2vals = v2enum ? v2enum.split(",").map((s) => s.trim().replace(/^["']|["']$/g, "")).filter(Boolean) : null;
  check("schema V2: enum exatamente as 4 ações", JSON.stringify(v2vals) === JSON.stringify(EXPECTED_ACTIONS), JSON.stringify(v2vals));
  check("schema V2: action fora de required", /required:\s*\[\s*["']task_id["']\s*\]/.test(srcV2), "");
  check("schema V1: action opcional (.optional())", /action:\s*tool\.schema\.enum\(\[[^\]]*\]\)\.optional\(\)/.test(srcIndex), "");

  check(
    "runtime: TEAM_TASK_ACTIONS equivale às 4 ações canônicas",
    JSON.stringify([...REAL.TEAM_TASK_ACTIONS]) === JSON.stringify(EXPECTED_ACTIONS),
    JSON.stringify([...(REAL.TEAM_TASK_ACTIONS ?? [])]),
  );

  const LITERALS = ["INVALID_ACTION: Unknown action", "Allowed actions: complete, submit_review, reject, sdet_pass."];
  for (const lit of LITERALS) {
    check(`paridade src↔dist: literal "${lit}"`, srcTc.includes(lit) && distRaw.includes(lit));
  }
  check(
    "paridade src↔dist: enum V1 no bundle",
    distRaw.includes('tool.schema.enum(["complete", "submit_review", "reject", "sdet_pass"])'),
  );
  check(
    "paridade src↔dist: enum V2 no bundle",
    distRaw.includes('enum: ["complete", "submit_review", "reject", "sdet_pass"]'),
  );
  check(
    "paridade src↔dist: broadcastMessageFanout exportado no bundle",
    /function\s+broadcastMessageFanout\b/.test(distRaw),
  );
}

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
// 4. PROVA DE MUTAÇÃO: patch determinístico no bundle dist + reexecução.
// ---------------------------------------------------------------------------
const M1_FROM =
  '  const action = args.action;\n' +
  '  if (action !== void 0 && action !== null && !TEAM_TASK_ACTIONS.includes(action)) {\n' +
  '    throw new Error(`INVALID_ACTION: Unknown action "${action}". Allowed actions: complete, submit_review, reject, sdet_pass.`);\n' +
  '  }\n';

const M3_FROM =
  '  return input.recipients.map((recipient) => {\n' +
  '    const id = generateId("msg");\n' +
  '    db.run(\n' +
  '      "INSERT INTO team_message (id, team_id, from_name, to_name, content, delivered, time_created) VALUES (?, ?, ?, ?, ?, 0, ?)",\n' +
  '      [id, input.teamId, input.from, recipient, input.content, now]\n' +
  '    );\n' +
  '    return { recipient, id };\n' +
  '  });\n';
const M3_TO =
  '  const sharedId = generateId("msg");\n' +
  '  return input.recipients.map((recipient) => {\n' +
  '    const id = sharedId;\n' +
  '    if (recipient === input.recipients[0]) {\n' +
  '      db.run(\n' +
  '        "INSERT INTO team_message (id, team_id, from_name, to_name, content, delivered, time_created) VALUES (?, ?, ?, ?, ?, 0, ?)",\n' +
  '        [id, input.teamId, input.from, null, input.content, now]\n' +
  '      );\n' +
  '    }\n' +
  '    return { recipient, id };\n' +
  '  });\n';

const MUTATIONS = [
  {
    id: "M1",
    desc: "guard INVALID_ACTION removido (ação desconhecida cai no Flow 3 complete)",
    patches: [{ from: M1_FROM, to: "  const action = args.action;\n" }],
    detect: ["A1.throws-invalid-action", "A1.task-status-unchanged", "A1.no-auto-commit", "A1.zero-wakes"],
    unaffected: ["A2.undefined-defaults-complete", "A3.submit-review-valid", "A3.reject-valid", "C1.recipient-count"],
  },
  {
    id: "M2",
    desc: "isolamento de destinatário em team_results removido (to_name ignorado)",
    patches: [
      {
        from: '"SELECT id, from_name, content, time_created FROM team_message WHERE team_id = ? AND read = 0 AND (to_name = ? OR to_name IS NULL) ORDER BY time_created ASC"',
        to: '"SELECT id, from_name, content, time_created FROM team_message WHERE team_id = ? AND read = 0 AND ? IS NOT NULL ORDER BY time_created ASC"',
      },
      {
        from: '"SELECT id, from_name, content, time_created FROM team_message WHERE team_id = ? AND read = 0 AND (to_name = ? OR to_name IS NULL) AND from_name = ? ORDER BY time_created ASC"',
        to: '"SELECT id, from_name, content, time_created FROM team_message WHERE team_id = ? AND read = 0 AND ? IS NOT NULL AND from_name = ? ORDER BY time_created ASC"',
      },
    ],
    detect: ["B1.bob-excludes-lead-dm", "B1.others-stay-unread", "B2.alice-sees-lead-dm", "B3.lead-sees-own"],
    unaffected: ["A1.throws-invalid-action", "C1.recipient-count", "C1.delivered-after-success"],
  },
  {
    id: "M3",
    desc: "fan-out colapsado em 1 linha compartilhada (bug original de resiliência)",
    patches: [{ from: M3_FROM, to: M3_TO }],
    detect: ["C1.rows-per-recipient", "C2.failed-recipient-undelivered"],
    unaffected: ["A1.throws-invalid-action", "C1.recipient-count"],
  },
  {
    id: "M4",
    desc: "injeção do broadcast no prompt do lead restrita a to_name IS NULL (perde a linha do lead)",
    patches: [
      {
        from: '"SELECT id, from_name, content FROM team_message WHERE team_id = ? AND (to_name = \'lead\' OR to_name IS NULL) AND delivered = 0 ORDER BY time_created ASC"',
        to: '"SELECT id, from_name, content FROM team_message WHERE team_id = ? AND to_name IS NULL AND delivered = 0 ORDER BY time_created ASC"',
      },
    ],
    detect: ["C3.lead-injection-silent"],
    unaffected: ["C3.team-injection-failed-delivery", "A1.throws-invalid-action"],
  },
  {
    id: "M5",
    desc: "injeção do broadcast no prompt do teammate restrita a to_name IS NULL (perde a linha fan-out)",
    patches: [
      {
        from: '"SELECT id, from_name, content FROM team_message WHERE team_id = ? AND (to_name = ? OR to_name IS NULL) AND delivered = 0 ORDER BY time_created ASC"',
        to: '"SELECT id, from_name, content FROM team_message WHERE team_id = ? AND to_name IS NULL AND ? IS NOT NULL AND delivered = 0 ORDER BY time_created ASC"',
      },
    ],
    detect: ["C3.team-injection-failed-delivery"],
    unaffected: ["C3.lead-injection-silent", "A1.throws-invalid-action"],
  },
];

for (const m of MUTATIONS) {
  let mutated = distRaw;
  let patchOk = true;
  for (const p of m.patches) {
    const occurrences = mutated.split(p.from).length - 1;
    check(`${m.id}: patch aplicável (1 ocorrência exata no dist)`, occurrences === 1, `ocorrências=${occurrences}`);
    if (occurrences !== 1) { patchOk = false; break; }
    mutated = mutated.split(p.from).join(p.to);
  }
  if (!patchOk) continue;

  const mutantFile = path.join(TMP, `_h33_${m.id.toLowerCase()}.mjs`);
  writeFileSync(mutantFile, buildHarnessCode(mutated).code);
  let mutatedFlow;
  try {
    const mutantMod = await import(mutantFile);
    mutatedFlow = await runFlow(mutantMod);
  } catch (err) {
    check(`${m.id}: mutante executável (fluxo roda por completo)`, false, String(err));
    continue;
  }
  check(`${m.id}: mutante executável (fluxo roda por completo)`, mutatedFlow.size === realFlow.size, `checks=${mutatedFlow.size}/${realFlow.size}`);

  const missed = m.detect.filter((n) => mutatedFlow.get(n)?.ok !== false);
  check(
    `${m.id}: asserções sensíveis — mutação detectada [${m.desc}]`,
    missed.length === 0,
    missed.length ? `não detectaram: ${missed.join(", ")}` : `${m.detect.length}/${m.detect.length} sentinelas falharam`,
  );

  const broken = m.unaffected.filter((n) => mutatedFlow.get(n)?.ok !== true);
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
