#!/usr/bin/env node
/**
 * QUALITY GATE DETERMINÍSTICO — Handover Intra-Card (TICKET-HARNESS-48)
 * @maiteuxzanela/ensemble-room-lowcost
 *
 * Sob teste (src/ e dist/ REAIS, SQLite real via node:sqlite — SEM MOCKS):
 *   - executeTeamTaskHandover       -> src/tools/team-task-handover.ts
 *   - setMemberStandby              -> src/tools/team-standby.ts (transmitter standby)
 *   - resolveStandbyWake            -> src/tools/shared.ts (receiver spawn_context)
 *   - buildTeammateSystemPrompt     -> src/system-prompt.ts (Parceria de Bancada)
 *   - V1/V2 schemas                 -> src/index.ts + src/v2-tools.ts
 *   - TEAM_TOOLS allowlist          -> src/tools/team-spawn.ts
 *
 * Cobertura (card TICKET-HARNESS-48 — Parceria de Bancada Sequencial Intra-Card):
 *   (H1) Handover feliz membro->membro: assignee reatribuído atomicamente,
 *        notas persistidas em review_notes, EXATAMENTE 1 wake sintético no
 *        receptor (persona/agent preservado), transmissor voluntariamente em
 *        standby (status='ready', spawn_context limpo).
 *   (H2) Receptor em standby: spawn_context prepend + standby->starting.
 *   (H3) Receptor sem session_id: sem wake, bastão registrado no board.
 *   (H4) Fail-fast (zero side effects): task inexistente, status != in_progress,
 *        caller não é o assignee, alvo === caller, alvo inexistente, alvo
 *        shutdown — cada um rejeita SEM mutar o card.
 *   (H5) Lead como transmissor: pode passar o bastão e NÃO entra em standby.
 *   (H6) Paridade V1↔V2 + allowlist TEAM_TOOLS + system-prompt + src↔dist.
 *   (H7) PROVA DE MUTAÇÃO: 4 mutantes por patch determinístico no bundle dist
 *        (texto do wake, standby do transmissor desabilitado, wake desabilitado,
 *        guarda anti-self removida). Cada mutante precisa FALHAR nas sentinelas
 *        do cenário alvo e PERMANECER VERDE nos fluxos intactos.
 *
 * Único seam: cliente SDK do OpenCode (fronteira externa), reduzido a um
 * recorder determinístico de promptAsync — mesmo padrão das demais suítes.
 * Nenhum componente de produção é substituído: SQLite, bundle dist e schemas
 * DDL rodam reais.
 *
 * Uso: node tests/test_ticket_harness_48_handover.mjs
 * Exit: 0 = todos os checks PASS; 1 = há FAIL.
 */

import { mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
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
  "createDb", "executeTeamTaskHandover", "DEFAULT_CONFIG", "MemberRegistry",
  "ProgressTracker", "resolveStandbyWake", "setMemberStandby", "MIGRATIONS",
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
  writeFileSync(path.join(TMP, "_handover_harness.mjs"), buildHarnessCode(distRaw).code);
}
const REAL = await import(path.join(TMP, "_handover_harness.mjs"));

// ---------------------------------------------------------------------------
// 1. runFlow: cenários (H1)-(H5) contra um módulo harness dado.
// ---------------------------------------------------------------------------
let flowSeq = 0;
async function runFlow(mod) {
  const { createDb, executeTeamTaskHandover, DEFAULT_CONFIG, MemberRegistry, ProgressTracker } = mod;

  const dir = path.join(TMP, `handover_${process.pid}_${flowSeq++}`);
  mkdirSync(dir, { recursive: true });
  const db = createDb(path.join(dir, "ensemble.db"));
  const registry = new MemberRegistry();
  const progressTracker = new ProgressTracker(db);

  // Recorder da fronteira de transporte (único seam desta suíte).
  const calls = [];
  const client = {
    session: {
      create: async () => ({ data: { id: "ses_unused" } }),
      promptAsync: async (o) => { calls.push(o); return {}; },
      abort: async () => ({}),
    },
    tui: { showToast: async () => ({}), selectSession: async () => ({}) },
  };
  const deps = { db, registry, tracker: {}, purgeApprovals: {}, client, directory: dir, config: DEFAULT_CONFIG, progressTracker };

  const got = new Map();
  const R = (name, ok, detail) => got.set(name, { ok: !!ok, detail: detail ?? "" });

  const now = Date.now();
  const seedTeam = (id, name, lead) => {
    db.run("INSERT INTO project (id, name, path, status, time_created, time_updated) VALUES ('default','Default','','active',?,?) ON CONFLICT DO NOTHING", [now, now]);
    db.run("INSERT INTO team (id, name, project_id, lead_session_id, status, delegate, time_created, time_updated) VALUES (?,?,'default',?,'active',0,?,?)", [id, name, lead, now, now]);
  };
  const member = (teamId, name, ses, agent, isQa = 0, exec = "idle", ctx = null, status = "ready") => {
    db.run(
      `INSERT INTO team_member (team_id, name, session_id, agent, status, execution_status, is_qa, spawn_context, time_created, time_updated, reported_to_lead)
       VALUES (?,?,?,?, ?, ?, ?, ?, ?, ?, 0)`,
      [teamId, name, ses, agent, status, exec, isQa, ctx, now, now],
    );
    if (ses) registry.register(teamId, name, ses);
  };
  const task = (id, teamId, assignee, status = "in_progress", reviewNotes = null) => {
    db.run(
      "INSERT INTO team_task (id, team_id, content, status, priority, assignee, review_notes, time_created, time_updated) VALUES (?,?,?,?,'high',?,?,?,?)",
      [id, teamId, `Task ${id}`, status, assignee, reviewNotes, now, now],
    );
  };
  const attempt = async (sessionId, args) => {
    calls.length = 0;
    try {
      return { ok: true, value: await executeTeamTaskHandover(deps, args, sessionId) };
    } catch (e) {
      return { ok: false, error: String((e && e.message) || e) };
    }
  };
  const wakes = (ses) => calls.filter((c) => c.sessionID === ses);
  const textOf = (c) => c?.parts?.[0]?.text ?? "";
  const memberRow = (teamId, name) => db.query("SELECT status, execution_status, spawn_context FROM team_member WHERE team_id = ? AND name = ?").get(teamId, name);
  const taskRow = (teamId, id) => db.query("SELECT status, assignee, review_notes FROM team_task WHERE team_id = ? AND id = ?").get(teamId, id);

  // ======================= (H1) Handover feliz ============================
  seedTeam("s1", "bench-one", "ses_lead1");
  member("s1", "tulio", "ses_tulio1", "build", 0, "idle", "CTX-TULIO");
  member("s1", "maya", "ses_maya1", "maya");
  member("s1", "clara", "ses_clara1", "clara", 1);
  task("t1", "s1", "tulio");

  const h1 = await attempt("ses_tulio1", { task_id: "t1", to: "maya", notes: "context" });
  const h1w = wakes("ses_maya1");
  R("H1.return-ok", h1.ok && h1.value.includes('Handed over task "t1" to maya'), h1.ok ? h1.value : h1.error);
  R("H1.return-notified", h1.ok && h1.value.includes("(notified maya)"));
  R("H1.return-standby", h1.ok && h1.value.includes("entered standby"));
  const h1task = taskRow("s1", "t1");
  R("H1.assignee-updated", h1task?.assignee === "maya" && h1task?.status === "in_progress", JSON.stringify(h1task));
  R("H1.notes-persisted", h1task?.review_notes === "context", String(h1task?.review_notes));
  R("H1.one-wake", h1w.length === 1, `count=${h1w.length}`);
  R("H1.zero-wake-others", wakes("ses_tulio1").length === 0 && wakes("ses_clara1").length === 0);
  R(
    "H1.wake-text-exact",
    textOf(h1w[0]) === `[System: Task "t1" was handed over to you by tulio (notes: context) — you are now the assignee; continue the work on this card.]`,
    textOf(h1w[0]),
  );
  R("H1.wake-synthetic-agent", h1w[0]?.synthetic === true && h1w[0]?.agent === "maya", `agent=${h1w[0]?.agent}`);
  const h1tulio = memberRow("s1", "tulio");
  R("H1.transmitter-standby", h1tulio?.execution_status === "standby" && h1tulio?.status === "ready", JSON.stringify(h1tulio));
  R("H1.spawn-context-cleared", h1tulio?.spawn_context === null, String(h1tulio?.spawn_context));

  // ============ (H2) Receptor em standby: spawn_context prepend ============
  seedTeam("s2", "bench-two", "ses_lead2");
  member("s2", "tulio", "ses_tulio2", "build");
  member("s2", "maya", "ses_maya2", "maya", 0, "standby", "CTX-MAYA");
  task("t2", "s2", "tulio", "in_progress", "PRE-EXISTING");

  const h2 = await attempt("ses_tulio2", { task_id: "t2", to: "maya" });
  const h2w = wakes("ses_maya2");
  R("H2.return-notified", h2.ok && h2.value.includes("(notified maya)"), h2.ok ? h2.value : h2.error);
  R(
    "H2.wake-text-prepends-context",
    textOf(h2w[0]) === `CTX-MAYA\n\n[System: Task "t2" was handed over to you by tulio — you are now the assignee; continue the work on this card.]`,
    textOf(h2w[0]),
  );
  const h2maya = memberRow("s2", "maya");
  R("H2.receiver-started", h2maya?.execution_status === "starting", String(h2maya?.execution_status));
  R("H2.agent-preserved", h2w[0]?.agent === "maya", `agent=${h2w[0]?.agent}`);
  R("H2.existing-notes-preserved", taskRow("s2", "t2")?.review_notes === "PRE-EXISTING", String(taskRow("s2", "t2")?.review_notes));

  // ============ (H3) Receptor sem session_id: sem wake ====================
  seedTeam("s3", "bench-three", "ses_lead3");
  member("s3", "tulio", "ses_tulio3", "build");
  member("s3", "ghost", "", "build");
  task("t3", "s3", "tulio");
  const h3 = await attempt("ses_tulio3", { task_id: "t3", to: "ghost" });
  R("H3.return-board-recorded", h3.ok && h3.value.includes("has no active session"), h3.ok ? h3.value : h3.error);
  R("H3.assignee-updated", taskRow("s3", "t3")?.assignee === "ghost");
  R("H3.zero-wakes", calls.length === 0, `count=${calls.length}`);

  // ============ (H4) Fail-fast sem side effects ===========================
  seedTeam("s4", "bench-four", "ses_lead4");
  member("s4", "tulio", "ses_tulio4", "build");
  member("s4", "maya", "ses_maya4", "maya");
  member("s4", "zombie", "ses_zombie4", "build", 0, "idle", null, "shutdown");
  task("t4a", "s4", "maya");
  task("t4s", "s4", "tulio");
  task("t4r", "s4", "tulio", "in_review");
  task("t4z", "s4", "tulio");

  const e1 = await attempt("ses_tulio4", { task_id: "nope", to: "maya" });
  R("H4.not-found", !e1.ok && /not found/.test(e1.error), e1.error);
  const e2 = await attempt("ses_tulio4", { task_id: "t4r", to: "maya" });
  R("H4.not-in-progress", !e2.ok && /requires an in_progress card/.test(e2.error), e2.error);
  const e3 = await attempt("ses_tulio4", { task_id: "t4a", to: "maya" });
  R("H4.only-assignee", !e3.ok && /Only the current assignee/.test(e3.error), e3.error);
  const e4 = await attempt("ses_tulio4", { task_id: "t4s", to: "tulio" });
  R("H4.self-rejected", !e4.ok && /to yourself/.test(e4.error), e4.error);
  const e5 = await attempt("ses_tulio4", { task_id: "t4s", to: "nobody" });
  R("H4.target-missing", !e5.ok && /not found in the room/.test(e5.error), e5.error);
  const e6 = await attempt("ses_tulio4", { task_id: "t4z", to: "zombie" });
  R("H4.target-shutdown", !e6.ok && /not available for a handover/.test(e6.error), e6.error);
  R("H4.no-side-effects", taskRow("s4", "t4a")?.assignee === "maya" && taskRow("s4", "t4s")?.assignee === "tulio" && taskRow("s4", "t4r")?.status === "in_review", JSON.stringify([taskRow("s4", "t4a"), taskRow("s4", "t4s")]));
  R("H4.zero-wakes", calls.length === 0, `count=${calls.length}`);

  // ============ (H5) Lead como transmissor: não entra em standby ==========
  seedTeam("s5", "bench-five", "ses_lead5");
  member("s5", "tulio", "ses_tulio5", "build");
  member("s5", "maya", "ses_maya5", "maya");
  task("t5", "s5", "tulio");
  const h5 = await attempt("ses_lead5", { task_id: "t5", to: "maya" });
  R("H5.return-ok", h5.ok && h5.value.includes('Handed over task "t5" to maya'), h5.ok ? h5.value : h5.error);
  R("H5.assignee-maya", taskRow("s5", "t5")?.assignee === "maya");
  R("H5.lead-no-standby", h5.ok && !h5.value.includes("standby"), h5.ok ? h5.value : h5.error);

  try { db.close(); } catch { /* já fechado */ }
  rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  return got;
}

// ---------------------------------------------------------------------------
// 2. Fase REAL: cenários contra o dist autêntico devem passar 100%.
// ---------------------------------------------------------------------------
const realFlow = await runFlow(REAL);
for (const [name, { ok, detail }] of realFlow) check(`[real] ${name}`, ok, detail);

// ---------------------------------------------------------------------------
// 3. Paridade V1↔V2, allowlist, system-prompt, src↔dist e anti-mock.
// ---------------------------------------------------------------------------
const srcIndex = readFileSync(path.join(SRC, "index.ts"), "utf8");
const srcV2 = readFileSync(path.join(SRC, "v2-tools.ts"), "utf8");
const srcSpawn = readFileSync(path.join(SRC, "tools", "team-spawn.ts"), "utf8");
const srcHandover = readFileSync(path.join(SRC, "tools", "team-task-handover.ts"), "utf8");
const srcPrompt = readFileSync(path.join(SRC, "system-prompt.ts"), "utf8");

check("V1 schema: team_task_handover registrada", srcIndex.includes("team_task_handover: tool({") && srcIndex.includes("executeTeamTaskHandover"));
check("V2 schema: team_task_handover registrada (paridade)", srcV2.includes('name: "team_task_handover"') && srcV2.includes("executeTeamTaskHandover"));
check("V1↔V2: required task_id/to presentes", srcV2.includes('required: ["task_id", "to"]') && srcIndex.includes("ID of the in_progress task to hand over") && srcV2.includes("ID of the in_progress task to hand over"));
check("TEAM_TOOLS allowlist: team_task_handover incluída", srcSpawn.includes('"team_task_handover"'));
check("system-prompt: Parceria de Bancada Sequencial Intra-Card", srcPrompt.includes("SEQUENTIAL BENCH PARTNERSHIP") && srcPrompt.includes("team_task_handover"));
check("system-prompt: diretriz literal (especialista dentro da especialidade)", srcPrompt.includes("avoid any specialist working outside their own expertise"));
for (const lit of ["task-handover:ok", "task-handover:wake-ok", "task-handover:wake-failed"]) {
  check(`paridade src↔dist: literal "${lit}"`, srcHandover.includes(lit) && distRaw.includes(lit));
}
check("dist: executeTeamTaskHandover declarada", /function\s+executeTeamTaskHandover\b/.test(distRaw));
check("dist: system-prompt Parceria de Bancada", distRaw.includes("SEQUENTIAL BENCH PARTNERSHIP") && distRaw.includes("team_task_handover"));

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
const MUTATIONS = [
  {
    id: "M1",
    desc: "texto do wake do receptor adulterado",
    from: 'was handed over to you by ${caller}',
    to: 'was handed over by ${caller}',
    detect: ["H1.wake-text-exact", "H2.wake-text-prepends-context"],
    unaffected: ["H1.return-ok", "H1.assignee-updated", "H1.transmitter-standby", "H4.self-rejected", "H5.return-ok"],
  },
  {
    id: "M2",
    desc: "standby do transmissor desabilitado",
    from: "setMemberStandby(deps.db, teamInfo.teamId, teamInfo.memberName, `handover of ${taskId} to ${to}`);",
    to: "void 0;",
    detect: ["H1.transmitter-standby", "H1.spawn-context-cleared"],
    unaffected: ["H1.return-ok", "H1.return-standby", "H4.self-rejected", "H5.lead-no-standby"],
  },
  {
    id: "M3",
    desc: "wake do receptor desabilitado",
    from: "if (target.session_id) {",
    to: "if (false) {",
    detect: ["H1.one-wake", "H1.wake-text-exact", "H1.return-notified", "H2.wake-text-prepends-context"],
    unaffected: ["H3.zero-wakes", "H4.self-rejected", "H5.assignee-maya"],
  },
  {
    id: "M4",
    desc: "guarda anti-self removida (handover para si mesmo permitido)",
    from: "if (to === caller) {",
    to: "if (false) {",
    detect: ["H4.self-rejected"],
    unaffected: ["H1.return-ok", "H1.assignee-updated", "H4.only-assignee", "H5.return-ok"],
  },
];

for (const m of MUTATIONS) {
  const occurrences = distRaw.split(m.from).length - 1;
  check(`${m.id}: patch aplicável (1 ocorrência exata no dist)`, occurrences === 1, `ocorrências=${occurrences}`);
  if (occurrences !== 1) continue;

  const mutantFile = path.join(TMP, `_handover_${m.id.toLowerCase()}.mjs`);
  writeFileSync(mutantFile, buildHarnessCode(distRaw.split(m.from).join(m.to)).code);
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
