#!/usr/bin/env node
/**
 * QUALITY GATE DETERMINÍSTICO — Fluxo de Handover SDET (TICKET-HARNESS-23)
 * @maiteuxzanela/ensemble-room-lowcost
 *
 * Engenheiro de Testes (SDET): Hugo. Guardiã do Quality Gate: Clara.
 *
 * Sob teste (src/ e dist/ REAIS, SQLite real via node:sqlite — SEM MOCKS):
 *   - executeTeamTasksComplete   -> src/tools/team-tasks-complete.ts (submit_review)
 *   - isSDETMEmber / getTeamSDETMember -> src/qa-role.ts (3 sinais: role='sdet',
 *     agent='hugo', basePersona 'hugo' — prioridade role > agent)
 *   - buildTeammateSystemPrompt  -> src/system-prompt.ts (seções per-turn)
 *   - MIGRATIONS (Migration 16: team_member.role)
 *
 * Cobertura (card TASK-03):
 *   (a) Sala COM SDET: submit_review do implementador acorda EXATAMENTE 1x o
 *       Hugo (wake "SDET handover", synthetic, notas preservadas) e NÃO acorda
 *       a Clara (zero promptAsync para a sessão dela). Cobre: resolução por
 *       agent 'hugo', variante SDET em standby (spawn_context prepend +
 *       standby→starting), sinal explícito role='sdet' (Migration 16) e o
 *       guarda "SDET sem session_id → Clara SUPRIMIDA, board segue in_review".
 *   (b) O PRÓPRIO Hugo submete → 1 wake byte-compatível legado na Clara,
 *       ZERO self-wake no SDET, retorno "(notified clara for review)".
 *   (c) Sala SEM SDET → wake legado da Clara intacto (retrocompatibilidade),
 *       incluindo a variante SEM notas; seção SDET HANDOVER ausente no prompt.
 *   (d) PROVA DE MUTAÇÃO: 4 mutantes gerados por patch determinístico no bundle
 *       dist (roteamento desabilitado, autor-SDET anulado, texto SDET
 *       adulterado, texto legado adulterado). Cada mutante precisa FALHAR nas
 *       sentinelas do cenário alvo e PERMANECER VERDE nos fluxos intactos —
 *       prova de que as asserções são sensíveis e cirúrgicas.
 *   Extras: paridade src↔dist dos literais de log (tasks-complete:wake-clara/
 *           wake-sdet), Migration 16 (coluna role + user_version) e anti-mock
 *           estático em src/ e na própria suíte.
 *
 * Único seam: cliente SDK do OpenCode (fronteira externa), reduzido a um
 * recorder determinístico de promptAsync — mesmo padrão das demais suítes do
 * repo. Nenhum componente de produção é substituído: SQLite, bundle dist e
 * schemas DDL rodam reais.
 *
 * Uso: node tests/test_sdet_handover_flow.mjs
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
  "createDb", "executeTeamTasksComplete", "DEFAULT_CONFIG", "MemberRegistry",
  "ProgressTracker", "MIGRATIONS", "getTeamSDETMember", "isSDETMEmber",
  "getTeamQAMember", "isQAMember", "buildTeammateSystemPrompt", "resolveStandbyWake",
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
  writeFileSync(path.join(TMP, "_sdet_handover_harness.mjs"), buildHarnessCode(distRaw).code);
}
const REAL = await import(path.join(TMP, "_sdet_handover_harness.mjs"));

// ---------------------------------------------------------------------------
// 1. RunFlow: cenarios (a)/(b)/(c) contra um módulo harness dado.
//    Cada execução cria um SQLite NOVO em scratch isolado e o remove ao final.
//    Retorna Map<checkName, {ok, detail}> — a fase real promove cada entrada a
//    check global; a fase de mutação só promove as meta-checks de detecção.
// ---------------------------------------------------------------------------
let flowSeq = 0;
async function runFlow(mod) {
  const {
    createDb, executeTeamTasksComplete, DEFAULT_CONFIG, MemberRegistry,
    ProgressTracker, getTeamSDETMember, isSDETMEmber, buildTeammateSystemPrompt,
  } = mod;

  const dir = path.join(TMP, `sdet_flow_${process.pid}_${flowSeq++}`);
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
    worktree: { create: async () => ({ data: {} }), remove: async () => ({}), list: async () => ({ data: [] }), reset: async () => ({}) },
    workspace: { create: async () => ({ data: {} }), remove: async () => ({}), list: async () => ({ data: [] }) },
  };
  const deps = { db, registry, tracker: {}, purgeApprovals: {}, client, directory: dir, config: DEFAULT_CONFIG, progressTracker };

  const got = new Map();
  const R = (name, ok, detail) => got.set(name, { ok: !!ok, detail: detail ?? "" });

  const now = Date.now();
  const seedTeam = (id, name, lead) => {
    db.run("INSERT INTO project (id, name, path, status, time_created, time_updated) VALUES ('default','Default','','active',?,?) ON CONFLICT DO NOTHING", [now, now]);
    db.run("INSERT INTO team (id, name, project_id, lead_session_id, status, delegate, time_created, time_updated) VALUES (?,?,'default',?,'active',0,?,?)", [id, name, lead, now, now]);
  };
  const member = (teamId, name, ses, agent, isQa = 0, role = null, exec = "idle", ctx = null) => {
    db.run(
      `INSERT INTO team_member (team_id, name, session_id, agent, status, execution_status, is_qa, role, spawn_context, time_created, time_updated, reported_to_lead)
       VALUES (?,?,?,?, 'ready', ?, ?, ?, ?, ?, ?, 0)`,
      [teamId, name, ses, agent, exec, isQa, role, ctx, now, now],
    );
    registry.register(teamId, name, ses);
  };
  const task = (id, teamId, assignee) => {
    db.run(
      "INSERT INTO team_task (id, team_id, content, status, priority, assignee, time_created, time_updated) VALUES (?,?,?,'in_progress','high',?,?,?)",
      [id, teamId, `Task ${id}`, assignee, now, now],
    );
  };
  const submit = async (sessionId, taskId, notes) => {
    calls.length = 0;
    const args = { task_id: taskId, action: "submit_review" };
    if (notes !== undefined) args.notes = notes;
    return await executeTeamTasksComplete(deps, args, sessionId);
  };
  const wakes = (ses) => calls.filter((c) => c.sessionID === ses);
  const textOf = (c) => c?.parts?.[0]?.text ?? "";

  // ======================= (a) Sala COM SDET ==============================
  seedTeam("s1", "squad-sdet-handover", "ses_lead_s1");
  member("s1", "tulio", "ses_tulio_s1", "build");
  member("s1", "hugo", "ses_hugo_s1", "hugo");
  member("s1", "clara", "ses_clara_s1", "clara", 1);
  task("t1", "s1", "tulio");

  const sdet1 = getTeamSDETMember(db, "s1");
  R("S1.sdet-resolves-hugo", sdet1?.name === "hugo" && sdet1?.sessionId === "ses_hugo_s1", JSON.stringify(sdet1));
  R(
    "S1.author-routing-signals",
    isSDETMEmber(db, "s1", "hugo") === true && isSDETMEmber(db, "s1", "tulio") === false,
  );

  const res1 = await submit("ses_tulio_s1", "t1", "PR pronto");
  const hugo1 = wakes("ses_hugo_s1");
  const clara1 = wakes("ses_clara_s1");
  R("S1.return-notifies-sdet", res1.includes("(notified hugo for deterministic tests)"), res1);
  R("S1.exactly-one-sdet-wake", hugo1.length === 1, `count=${hugo1.length}`);
  R("S1.clara-suppressed", clara1.length === 0, `count=${clara1.length}`);
  R(
    "S1.wake-text-exact",
    textOf(hugo1[0]) ===
      '[System: Task "t1" was submitted for review by tulio (notes: PR pronto) — SDET handover: run the deterministic test suite for this delivery before the Quality Gate audits.]',
    textOf(hugo1[0]),
  );
  R("S1.wake-synthetic", hugo1[0]?.synthetic === true, `synthetic=${hugo1[0]?.synthetic}`);
  const t1row = db.query("SELECT status, review_notes, assignee FROM team_task WHERE id = 't1'").get();
  R(
    "S1.task-in-review-with-notes",
    t1row.status === "in_review" && t1row.review_notes === "PR pronto" && t1row.assignee === "tulio",
    JSON.stringify(t1row),
  );

  // (a-2) Variante standby: SDET nasceu em standby com spawn_context.
  seedTeam("s1b", "squad-sdet-standby", "ses_lead_s1b");
  member("s1b", "tulio", "ses_tulio_s1b", "build");
  member("s1b", "hugo", "ses_hugo_s1b", "hugo", 0, null, "standby", "CTX_SDET_BIRTH");
  member("s1b", "clara", "ses_clara_s1b", "clara", 1);
  task("t1b", "s1b", "tulio");
  const res1b = await submit("ses_tulio_s1b", "t1b", "suite pronta");
  const hugo1b = wakes("ses_hugo_s1b");
  const clara1b = wakes("ses_clara_s1b");
  const base1b =
    '[System: Task "t1b" was submitted for review by tulio (notes: suite pronta) — SDET handover: run the deterministic test suite for this delivery before the Quality Gate audits.]';
  R("S1b.standby-wake-reaches-sdet-only", hugo1b.length === 1 && clara1b.length === 0, `hugo=${hugo1b.length} clara=${clara1b.length}`);
  R(
    "S1b.standby-wake-prepends-spawn-context",
    textOf(hugo1b[0]).startsWith("CTX_SDET_BIRTH\n\n") && textOf(hugo1b[0]).endsWith(base1b),
    textOf(hugo1b[0]),
  );
  const st1b = db.query("SELECT execution_status FROM team_member WHERE team_id = 's1b' AND name = 'hugo'").get();
  R("S1b.standby-transitioned-to-starting", st1b.execution_status === "starting", st1b.execution_status);
  R("S1b.return-notifies-sdet", res1b.includes("(notified hugo for deterministic tests)"), res1b);

  // (a-3) SDET sem session_id: Clara SUPRIMIDA mesmo assim; board segue.
  seedTeam("s5", "squad-sdet-no-session", "ses_lead_s5");
  member("s5", "hugo", "", "hugo");
  member("s5", "tulio", "ses_tulio_s5", "build");
  member("s5", "clara", "ses_clara_s5", "clara", 1);
  task("t5", "s5", "tulio");
  const sdet5 = getTeamSDETMember(db, "s5");
  R("S5.sdet-found-without-session", sdet5?.name === "hugo" && !sdet5?.sessionId, JSON.stringify(sdet5));
  const res5 = await submit("ses_tulio_s5", "t5", "sem sessao");
  R("S5.zero-wakes", calls.length === 0, `total=${calls.length}`);
  R("S5.clara-still-suppressed", wakes("ses_clara_s5").length === 0, `count=${wakes("ses_clara_s5").length}`);
  R("S5.no-notified-label", !res5.includes("(notified"), res5);
  R("S5.task-still-in-review", db.query("SELECT status FROM team_task WHERE id = 't5'").get().status === "in_review");

  // ======================= (b) O próprio SDET submete =====================
  task("t2", "s1", "hugo");
  const res2 = await submit("ses_hugo_s1", "t2", "Suite verde");
  const clara2 = wakes("ses_clara_s1");
  const hugo2 = wakes("ses_hugo_s1");
  R("S2.return-notifies-clara", res2.includes("(notified clara for review)"), res2);
  R("S2.no-sdet-label", !res2.includes("deterministic tests"), res2);
  R("S2.exactly-one-clara-wake", clara2.length === 1, `count=${clara2.length}`);
  R("S2.zero-self-wake", hugo2.length === 0, `count=${hugo2.length}`);
  R(
    "S2.legacy-wake-text-exact",
    textOf(clara2[0]) === '[System: Task "t2" was submitted for review by hugo (notes: Suite verde)]',
    textOf(clara2[0]),
  );
  R("S2.wake-synthetic", clara2[0]?.synthetic === true, `synthetic=${clara2[0]?.synthetic}`);

  // ======================= (c) Sala SEM SDET (retrocompat) ================
  seedTeam("s3", "squad-no-sdet", "ses_lead_s3");
  member("s3", "tulio", "ses_tulio_s3", "build");
  member("s3", "clara", "ses_clara_s3", "clara", 1);
  task("t3", "s3", "tulio");
  R("S3.no-sdet-member", getTeamSDETMember(db, "s3") === null);
  const res3 = await submit("ses_tulio_s3", "t3");
  const clara3 = wakes("ses_clara_s3");
  R("S3.return-notifies-clara", res3.includes("(notified clara for review)"), res3);
  R("S3.exactly-one-clara-wake", clara3.length === 1, `count=${clara3.length}`);
  R(
    "S3.legacy-wake-text-exact-no-notes",
    textOf(clara3[0]) === '[System: Task "t3" was submitted for review by tulio]',
    textOf(clara3[0]),
  );
  R("S3.total-one-wake", calls.length === 1, `total=${calls.length}`);

  // (extra) Sinal explícito role='sdet' (Migration 16): membro NÃO-hugo.
  seedTeam("s4", "squad-role-flag", "ses_lead_s4");
  member("s4", "qa-eyes", "ses_sdet_role", "build", 0, "sdet");
  member("s4", "tulio", "ses_tulio_s4", "build");
  member("s4", "clara", "ses_clara_s4", "clara", 1);
  task("t4", "s4", "tulio");
  const sdet4 = getTeamSDETMember(db, "s4");
  R(
    "S4.role-flag-resolves-non-hugo",
    sdet4?.name === "qa-eyes" && sdet4?.sessionId === "ses_sdet_role" && isSDETMEmber(db, "s4", "qa-eyes") === true,
    JSON.stringify(sdet4),
  );
  const res4 = await submit("ses_tulio_s4", "t4", "m16");
  const sdet4w = wakes("ses_sdet_role");
  const clara4 = wakes("ses_clara_s4");
  R("S4.return-notifies-role-sdet", res4.includes("(notified qa-eyes for deterministic tests)"), res4);
  R("S4.exactly-one-role-sdet-wake", sdet4w.length === 1, `count=${sdet4w.length}`);
  R("S4.wake-text-has-handover", textOf(sdet4w[0]).includes("SDET handover"), textOf(sdet4w[0]));
  R("S4.clara-suppressed", clara4.length === 0, `count=${clara4.length}`);

  // ======================= system-prompt per-turn =========================
  const pTulio = buildTeammateSystemPrompt(db, "s1", "tulio", DEFAULT_CONFIG);
  const pClara = buildTeammateSystemPrompt(db, "s1", "clara", DEFAULT_CONFIG);
  const pHugo = buildTeammateSystemPrompt(db, "s1", "hugo", DEFAULT_CONFIG);
  R(
    // TICKET-HARNESS-37 (M2): o implementador NÃO faz mais handoff manual. O
    // runtime acorda o SDET automaticamente no submit_review (wake retido para
    // batching pelo HARNESS-25), então o handover deve instruir a submissão —
    // e NÃO deve mandar o implementador enviar team_message ao SDET.
    "S6.implementer-submits-review-no-manual-handoff",
    pTulio.includes("SDET HANDOVER:") &&
      pTulio.includes("the runtime wakes the SDET automatically") &&
      !pTulio.includes("team_message(to: 'hugo')"),
    "",
  );
  R("S6.implementer-gate-not-direct-peer", pTulio.includes("The Quality Gate is NOT a direct peer for you"));
  R(
    "S6.clara-waits-for-sdet-suite",
    pClara.includes("QUALITY GATE ORDER:") && pClara.includes("Wait for the SDET's (hugo) deterministic test suite"),
    "",
  );
  R("S6.sdet-no-self-audit", pHugo.includes("SDET HANDOVER:") && pHugo.includes("do not audit your own delivery"));
  const pNoSdet = buildTeammateSystemPrompt(db, "s3", "tulio", DEFAULT_CONFIG);
  R("S6.no-sdet-room-has-no-handover-section", !pNoSdet.includes("SDET HANDOVER:"));

  // Fecha o SQLite (WAL) antes de remover o scratch: sem isso o checkpoint
  // recria -wal/-shm durante o rmSync e o diretório sai ENOTEMPTY.
  try { db.close(); } catch { /* já fechado */ }
  rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  return got;
}

// ---------------------------------------------------------------------------
// 2. Fase REAL: todos os cenarios contra o dist autêntico devem passar 100%.
// ---------------------------------------------------------------------------
const realFlow = await runFlow(REAL);
for (const [name, { ok, detail }] of realFlow) check(`[real] ${name}`, ok, detail);

// ---------------------------------------------------------------------------
// 3. Paridade src↔dist (literais de log/texto contíguos) + Migration 16 + anti-mock.
// ---------------------------------------------------------------------------
const srcTc = readFileSync(path.join(SRC, "tools", "team-tasks-complete.ts"), "utf8");
const LOG_LITERALS = [
  "tasks-complete:wake-clara:ok",
  "tasks-complete:wake-sdet:ok",
  "tasks-complete:wake-clara:failed",
  "tasks-complete:wake-sdet:failed",
];
for (const lit of LOG_LITERALS) {
  check(`paridade src↔dist: literal "${lit}"`, srcTc.includes(lit) && distRaw.includes(lit));
}
check(
  "paridade src↔dist: texto do wake SDET",
  srcTc.includes("SDET handover: run the deterministic test suite") &&
    distRaw.includes("SDET handover: run the deterministic test suite"),
);
check(
  "paridade src↔dist: texto legado do wake da Clara",
  srcTc.includes("was submitted for review by") && distRaw.includes("was submitted for review by"),
);

{
  const migFile = path.join(TMP, "_sdet_handover_mig.db");
  rmSync(migFile, { force: true });
  const migDb = REAL.createDb(migFile);
  const cols = migDb.query("PRAGMA table_info(team_member)").all().map((c) => c.name);
  check("Migration 16: coluna role aplicada em team_member", cols.includes("role"), cols.join(","));
  const uv = migDb.query("PRAGMA user_version").get().user_version;
  check(
    "Migration 16: user_version === MIGRATIONS.length",
    uv === REAL.MIGRATIONS.length,
    `user_version=${uv} len=${REAL.MIGRATIONS.length}`,
  );
  try { migDb.close(); } catch { /* já fechado */ }
  rmSync(migFile, { force: true });
  rmSync(`${migFile}-wal`, { force: true });
  rmSync(`${migFile}-shm`, { force: true });
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
// 4. PROVA DE MUTAÇÃO: patch determinístico no bundle dist + reexecução dos
//    mesmos cenarios. Cada mutante precisa FALHAR nas sentinelas do cenário
//    alvo (sensibilidade) e PERMANECER VERDE nos fluxos intactos (cirurgia).
// ---------------------------------------------------------------------------
const MUTATIONS = [
  {
    id: "M1",
    desc: "roteamento SDET-first desabilitado (Clara volta a ser acordada)",
    from: "if (sdetMember && !callerIsSDET)",
    to: "if (false)",
    detect: ["S1.return-notifies-sdet", "S1.exactly-one-sdet-wake", "S1.clara-suppressed", "S5.zero-wakes"],
    unaffected: ["S2.return-notifies-clara", "S2.exactly-one-clara-wake", "S3.return-notifies-clara", "S3.legacy-wake-text-exact-no-notes"],
  },
  {
    id: "M2",
    desc: "detecção de autor-SDET anulada (SDET submetendo acorda a si mesmo)",
    from: "const callerIsSDET = isSDETMEmber(deps.db, teamInfo.teamId, caller)",
    to: "const callerIsSDET = false",
    detect: ["S2.return-notifies-clara", "S2.exactly-one-clara-wake", "S2.zero-self-wake", "S2.legacy-wake-text-exact"],
    unaffected: ["S1.return-notifies-sdet", "S1.exactly-one-sdet-wake", "S3.return-notifies-clara", "S3.legacy-wake-text-exact-no-notes"],
  },
  {
    id: "M3",
    desc: "texto do wake SDET adulterado (contrato 'SDET handover' perdido)",
    from: "SDET handover: run the deterministic test suite for this delivery before the Quality Gate audits.]",
    to: "SDET handover: run tests.]",
    detect: ["S1.wake-text-exact"],
    unaffected: ["S1.return-notifies-sdet", "S1.exactly-one-sdet-wake", "S1.clara-suppressed", "S2.legacy-wake-text-exact", "S3.legacy-wake-text-exact-no-notes"],
  },
  {
    id: "M4",
    desc: "wake legado da Clara adulterado (retrocompat byte-compat quebrada)",
    from: ': ""}]',
    to: ': ""} ]',
    detect: ["S2.legacy-wake-text-exact", "S3.legacy-wake-text-exact-no-notes"],
    unaffected: ["S1.wake-text-exact", "S1.return-notifies-sdet", "S1.exactly-one-sdet-wake"],
  },
];

for (const m of MUTATIONS) {
  const occurrences = distRaw.split(m.from).length - 1;
  check(`${m.id}: patch aplicável (1 ocorrência exata no dist)`, occurrences === 1, `ocorrências=${occurrences}`);
  if (occurrences !== 1) continue;

  const mutantFile = path.join(TMP, `_sdet_handover_${m.id.toLowerCase()}.mjs`);
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
