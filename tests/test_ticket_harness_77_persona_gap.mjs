#!/usr/bin/env node
/**
 * QUALITY GATE DETERMINÍSTICO — TICKET-HARNESS-77
 * @maiteuxzanela/ensemble-room-lowcost
 *
 * Hook determinístico de alerta de contratação ao convocar agentes genéricos
 * (build / plan / general) — a regra de "Persona Gap" do LEAD TOPOLOGY &
 * SIZING PROTOCOL deixa de ser puramente comportamental e passa a ser
 * verificável no retorno das tools.
 *
 * Sob teste (src/ e dist/ REAIS, SQLite real via node:sqlite — SEM MOCKS no
 * código de produção; a fronteira SDK é um recorder determinístico, o mesmo
 * seam de transporte usado por todo o parque):
 *   PG1 src/persona-gap.ts — classificador determinístico: tipos genéricos
 *       (build, plan, general, explore, code, chat) SEMPRE disparam; personas
 *       oficiais do catálogo (otavio, cris, davi, hugo, clara, kael, maya,
 *       tulio, sam, lumi…) NUNCA disparam; desconhecidos disparam.
 *   PG2  normalização de instância múltipla ("otavio-2"/"morgan-sec_1" → base).
 *   PG3  `team_spawn` anexa o banner [PERSONA GAP ALERT] ao retorno textual
 *        com a cobrança da especificação de vaga (função, stack,
 *        personas/<nome>.md) para a Fundadora Maiteux Zanela.
 *   PG4  persona oficial não polui o retorno do spawn (sem banner).
 *   PG5  `team_status` inclui nota orientadora quando há membros genéricos
 *        registrados em team_member, e NÃO inclui quando só há personas.
 *   PG6  `team_cleanup` (fechamento da sala) inclui a mesma nota orientadora.
 *   PG7  classificação independente do HOME: com agentDir inexistente o
 *        baseline in-code continua reconhecendo as personas oficiais.
 *   PG8  paridade src↔dist + V1/V2 delegando ao MESMO executeTeamSpawn.
 *   PG9  prova de mutação: neutralizar (a) a checagem de tipo genérico e
 *        (b) a anexação do banner no spawn REPROVA as sentinelas.
 *
 * Uso: node tests/test_ticket_harness_77_persona_gap.mjs
 * Exit: 0 = todos os checks PASS; 1 = há FAIL.
 */

import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

const REPO = path.resolve(import.meta.dirname, "..");
const DIST = path.join(REPO, "dist/index.js");
const SRC = path.join(REPO, "src");
const TMP = path.join(REPO, ".test-scratch", "h77");
mkdirSync(TMP, { recursive: true });

const results = [];
const check = (name, ok, detail) => {
  results.push([name, ok]);
  console.log(`${ok ? "PASS" : "FAIL"} | ${name}${detail !== undefined ? " | " + detail : ""}`);
};
const NOW = () => Date.now();

// ---------------------------------------------------------------------------
// 0. Harness: dist REAL + exportação dos símbolos sob teste (sem mocks).
// ---------------------------------------------------------------------------
const REQUIRED_SYMBOLS = [
  "createDb",
  "DEFAULT_CONFIG",
  "MemberRegistry",
  "DescendantTracker",
  "PendingPurgeApprovals",
  "ProgressTracker",
  "executeTeamSpawn",
  "executeTeamStatus",
  "executeTeamCleanup",
  "isPersonaGap",
  "resolveKnownPersonas",
  "personaGapBannerFor",
  "personaGapClosingNote",
  "GENERIC_AGENT_TYPES",
  "OFFICIAL_PERSONAS",
  "PERSONA_GAP_MARKER",
];

const distRaw = readFileSync(DIST, "utf8");
const srcPersonaGap = readFileSync(path.join(SRC, "persona-gap.ts"), "utf8");
const srcSpawn = readFileSync(path.join(SRC, "tools/team-spawn.ts"), "utf8");
const srcStatus = readFileSync(path.join(SRC, "tools/team-status.ts"), "utf8");
const srcCleanup = readFileSync(path.join(SRC, "tools/team-cleanup.ts"), "utf8");
const srcV2 = readFileSync(path.join(SRC, "v2-tools.ts"), "utf8");
const srcV1 = readFileSync(path.join(SRC, "index.ts"), "utf8");

function buildHarnessCode(raw) {
  const existingExport = raw.match(/export\s*\{([^}]*)\}\s*;?\s*$/)?.[1] ?? "";
  const already = new Set(existingExport.split(",").map((s) => s.trim().split(/\s+as\s+/).pop()).filter(Boolean));
  const need = REQUIRED_SYMBOLS.filter((s) => !already.has(s));
  return raw + (need.length ? `\nexport { ${need.join(", ")} };\n` : "");
}

{
  const missing = REQUIRED_SYMBOLS.filter((s) => !new RegExp(`(function|class|var|const|let)\\s+${s}\\b`).test(distRaw));
  check("PG0 harness: dist declara todos os símbolos exigidos", missing.length === 0, missing.join(",") || `${REQUIRED_SYMBOLS.length} símbolos`);
}
const harnessFile = path.join(TMP, "_h77_real.mjs");
writeFileSync(harnessFile, buildHarnessCode(distRaw));
const REAL = await import(harnessFile);

// ---------------------------------------------------------------------------
// Helpers: SQLite real + recorder determinístico da fronteira SDK.
// ---------------------------------------------------------------------------
function seedProjectAndTeam(db, { teamId, lead, leadAgent = "dante" }) {
  const t = NOW();
  db.run(
    "INSERT OR IGNORE INTO project (id, name, path, status, time_created, time_updated) VALUES (?,?,?,?,?,?)",
    ["default", "Default", "", "active", t, t],
  );
  db.run(
    "INSERT INTO team (id, name, project_id, lead_session_id, lead_agent, status, delegate, awaiting_lead_decision, time_created, time_updated) VALUES (?,?,?,?,?,?,?,?,?,?)",
    [teamId, teamId, "default", lead, leadAgent, "active", 0, 0, t, t],
  );
}

function seedMember(db, teamId, { name, sessionId, agent, status = "ready" }) {
  const t = NOW();
  db.run(
    `INSERT INTO team_member (team_id, name, session_id, agent, status, execution_status, time_created, time_updated)
     VALUES (?,?,?,?,?,?,?,?)`,
    [teamId, name, sessionId, agent, status, "idle", t, t],
  );
}

function mkScratch(tag) {
  return mkdtempSync(path.join(os.tmpdir(), `ens-h77-${tag}-`));
}

function cleanup(base, db) {
  try { db?.close(); } catch { /* já fechado */ }
  try { rmSync(base, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }); } catch { /* best effort */ }
}

function makeClient() {
  const calls = { sessionCreate: [], promptAsync: [], abort: [], toast: [] };
  const client = {
    session: {
      create: async (o) => { calls.sessionCreate.push(o); return { data: { id: `ses_child_${calls.sessionCreate.length}` } }; },
      promptAsync: async (o) => { calls.promptAsync.push(o); return {}; },
      abort: async (o) => { calls.abort.push(o); return {}; },
    },
    tui: { showToast: async (o) => { calls.toast.push(o); return {}; }, selectSession: async () => ({}) },
  };
  return { calls, client };
}

function makeDeps(mod, { db, directory, client }) {
  return {
    db,
    registry: new mod.MemberRegistry(),
    tracker: new mod.DescendantTracker(),
    purgeApprovals: new mod.PendingPurgeApprovals(),
    client,
    directory,
    config: { ...mod.DEFAULT_CONFIG },
    progressTracker: new mod.ProgressTracker(),
  };
}

/** Executa um spawn real isolado e devolve o retorno textual da tool. */
async function spawnOnce(mod, { tag, agent, name = "worker", config }) {
  const base = mkScratch(tag);
  const db = mod.createDb(path.join(base, "e.db"));
  const { calls, client } = makeClient();
  const deps = makeDeps(mod, { db, directory: base, client });
  if (config) deps.config = { ...deps.config, ...config };
  const TEAM = `T77_${tag}`;
  const LEAD = `ses_lead_${tag}`;
  try {
    seedProjectAndTeam(db, { teamId: TEAM, lead: LEAD });
    const result = await mod.executeTeamSpawn(
      deps,
      { name, ...(agent === undefined ? {} : { agent }), prompt: "executar a frente técnica do card", worktree: false },
      LEAD,
    );
    return { result, calls, deps, db, base, TEAM };
  } finally {
    // db/base are closed by the caller when it needs to inspect rows; here the
    // spawn result is the only artifact, so clean up immediately.
    cleanup(base, db);
  }
}

// ---------------------------------------------------------------------------
// PG1/PG2/PG7 — classificador determinístico (independente do HOME).
// ---------------------------------------------------------------------------
{
  const noHome = { agentDir: path.join(TMP, "no-such-agent-dir"), knownPersonas: [] };
  const genericCases = ["build", "plan", "general", "explore", "code", "chat", "BUILD", " Plan "];
  const missingGeneric = genericCases.filter((a) => REAL.isPersonaGap(a, noHome) !== true);
  check("PG1 tipos genéricos sempre disparam (build/plan/general/explore/code/chat, case-insensitive)", missingGeneric.length === 0, missingGeneric.join(",") || `${genericCases.length} tipos`);

  const officialCases = ["otavio", "cris", "davi", "hugo", "clara", "kael", "maya", "tulio", "sam", "lumi", "fernanda", "diana", "sol", "dante", "nora"];
  const falsePositives = officialCases.filter((a) => REAL.isPersonaGap(a, noHome) !== false);
  check("PG1 personas oficiais do catálogo NÃO disparam (baseline in-code, agentDir inexistente)", falsePositives.length === 0, falsePositives.join(",") || `${officialCases.length} personas`);

  check("PG1 agente ausente do catálogo dispara (wizard-ops)", REAL.isPersonaGap("wizard-ops", noHome) === true);
  check("PG1 agente nulo/vazio dispara (nunca é persona formalizada)", REAL.isPersonaGap(null, noHome) === true && REAL.isPersonaGap("   ", noHome) === true);

  check("PG2 instância múltipla de persona oficial herda a base (otavio-2 / morgan-sec_1)", REAL.isPersonaGap("otavio-2", noHome) === false && REAL.isPersonaGap("morgan-sec_1", noHome) === false, "sufixo -/_ resolvido");
  check("PG2 hífen interno do nome canônico não degrada (morgan-sec exato)", REAL.isPersonaGap("morgan-sec", noHome) === false);
  check("PG2 normalização de acentos (Túlio / Letícia)", REAL.isPersonaGap("Túlio", noHome) === false && REAL.isPersonaGap("Letícia", noHome) === false);

  // Cobertura INTEGRAL dos dois conjuntos declarados (não só amostras): nenhum
  // tipo genérico pode escapar e nenhuma persona oficial pode virar falso positivo.
  const allGeneric = [...REAL.GENERIC_AGENT_TYPES];
  const escapedGeneric = allGeneric.filter((a) => REAL.isPersonaGap(a, noHome) !== true);
  check("PG1 [conjunto completo] todo GENERIC_AGENT_TYPES dispara", escapedGeneric.length === 0, escapedGeneric.join(",") || `${allGeneric.length} tipos`);
  const allOfficial = [...REAL.OFFICIAL_PERSONAS];
  const flaggedOfficial = allOfficial.filter((a) => REAL.isPersonaGap(a, noHome) !== false);
  check("PG1 [conjunto completo] nenhuma OFFICIAL_PERSONAS dispara", flaggedOfficial.length === 0, flaggedOfficial.join(",") || `${allOfficial.length} personas`);

  // knownPersonas extra (modelsByAgent) não deve transformar genérico em persona
  check("PG1 config listando 'build' NÃO silencia o alerta", REAL.isPersonaGap("build", { agentDir: path.join(TMP, "no-such"), knownPersonas: ["build", "explore"] }) === true);

  // Troca de contexto: o mesmo diretório canônico é lido como enriquecimento
  const withDir = REAL.resolveKnownPersonas({ agentDir: path.join(TMP, "no-such-agent-dir") });
  check("PG7 baseline in-code carrega o catálogo oficial", withDir.has("otavio") && withDir.has("cris") && withDir.has("clara"), [...withDir].slice(0, 5).join(","));
}

// ---------------------------------------------------------------------------
// PG3/PG4 — banner no retorno textual de team_spawn (spawns REAIS).
// ---------------------------------------------------------------------------
{
  const generic = [
    { tag: "build", agent: "build", label: "build" },
    { tag: "plan", agent: "plan", label: "plan" },
    { tag: "general", agent: "general", label: "general" },
    { tag: "unknown", agent: "wizard-ops", label: "wizard-ops" },
    { tag: "default", agent: undefined, label: "build (default do schema)" },
  ];
  const failures = [];
  for (const c of generic) {
    const { result } = await spawnOnce(REAL, { tag: c.tag, agent: c.agent, name: "worker" });
    const ok = typeof result === "string"
      && result.includes(REAL.PERSONA_GAP_MARKER)
      && result.includes("é genérico ou não possui persona formalizada no catálogo")
      && result.includes("Fundadora Maiteux Zanela")
      && result.includes("personas/<nome>.md")
      && result.includes("função, stack");
    if (!ok) failures.push(`${c.label} => ${String(result).slice(0, 180)}`);
  }
  check("PG3 banner [PERSONA GAP ALERT] + cobrança de vaga no retorno do spawn (build/plan/general/desconhecido/default)", failures.length === 0, failures.join(" || ") || `${generic.length} cenários`);

  const buildRun = await spawnOnce(REAL, { tag: "banner-agent", agent: "build", name: "zeta" });
  check("PG3 banner nomeia o agente convocado", buildRun.result.includes('("build")'), String(buildRun.result).slice(0, 140));

  // `modelsByAgent` do ensemble.json listando "build" não pode silenciar o
  // alerta no caminho REAL do spawn (o tipo genérico vence o enriquecimento).
  const cfgRun = await spawnOnce(REAL, { tag: "banner-cfg", agent: "build", name: "worker", config: { modelsByAgent: { build: "some/model" } } });
  check("PG3 modelsByAgent listando 'build' NÃO silencia o banner no spawn", cfgRun.result.includes(REAL.PERSONA_GAP_MARKER), String(cfgRun.result).slice(0, 140));

  const multiRun = await spawnOnce(REAL, { tag: "banner-plan2", agent: "plan-2", name: "worker" });
  check("PG3 instância genérica com sufixo (plan-2) recebe banner", multiRun.result.includes(REAL.PERSONA_GAP_MARKER), String(multiRun.result).slice(0, 140));

  const official = [
    { tag: "otavio", agent: "otavio" },
    { tag: "cris", agent: "cris" },
    { tag: "kael", agent: "kael" },
    { tag: "suffix", agent: "otavio-2" },
  ];
  const leaked = [];
  for (const c of official) {
    const { result } = await spawnOnce(REAL, { tag: c.tag, agent: c.agent, name: "worker" });
    if (typeof result !== "string" || result.includes(REAL.PERSONA_GAP_MARKER)) leaked.push(`${c.agent} => ${String(result).slice(0, 140)}`);
  }
  check("PG4 persona oficial NÃO recebe banner (otavio/cris/kael/otavio-2)", leaked.length === 0, leaked.join(" || ") || `${official.length} cenários`);
}

// ---------------------------------------------------------------------------
// PG5 — team_status: nota orientadora com membros genéricos.
// ---------------------------------------------------------------------------
{
  const base = mkScratch("status");
  const db = REAL.createDb(path.join(base, "e.db"));
  const { client } = makeClient();
  const deps = makeDeps(REAL, { db, directory: base, client });
  const TEAM = "T77_STATUS";
  const LEAD = "ses_lead_status";
  try {
    seedProjectAndTeam(db, { teamId: TEAM, lead: LEAD });
    seedMember(db, TEAM, { name: "zeta", sessionId: "ses_zeta", agent: "build" });
    seedMember(db, TEAM, { name: "otavio", sessionId: "ses_otavio", agent: "otavio" });
    const status = await REAL.executeTeamStatus(deps, LEAD);
    check("PG5 team_status inclui nota [PERSONA GAP ALERT] com membro genérico", status.includes(REAL.PERSONA_GAP_MARKER), String(status).slice(-220));
    check("PG5 nota nomeia o membro genérico e cobra a especificação da vaga", status.includes("zeta") && status.includes("Fundadora Maiteux Zanela") && status.includes("personas/<nome>.md"));
    check("PG5 nota NÃO acusa a persona oficial (otavio)", !/otavio \(agent: otavio\)/.test(status), "sem falso positivo");
  } finally {
    cleanup(base, db);
  }

  const base2 = mkScratch("status-clean");
  const db2 = REAL.createDb(path.join(base2, "e.db"));
  const { client: client2 } = makeClient();
  const deps2 = makeDeps(REAL, { db: db2, directory: base2, client: client2 });
  const TEAM2 = "T77_STATUS_CLEAN";
  const LEAD2 = "ses_lead_status_clean";
  try {
    seedProjectAndTeam(db2, { teamId: TEAM2, lead: LEAD2 });
    seedMember(db2, TEAM2, { name: "otavio", sessionId: "ses_otavio2", agent: "otavio" });
    seedMember(db2, TEAM2, { name: "cris", sessionId: "ses_cris2", agent: "cris" });
    const status = await REAL.executeTeamStatus(deps2, LEAD2);
    check("PG5 team_status SEM nota quando todos os membros são personas oficiais", !status.includes(REAL.PERSONA_GAP_MARKER), String(status).slice(0, 160));
  } finally {
    cleanup(base2, db2);
  }
}

// ---------------------------------------------------------------------------
// PG6 — team_cleanup: nota orientadora no fechamento da sala.
// ---------------------------------------------------------------------------
{
  const base = mkScratch("cleanup");
  const db = REAL.createDb(path.join(base, "e.db"));
  const { client } = makeClient();
  const deps = makeDeps(REAL, { db, directory: base, client });
  const TEAM = "T77_CLEANUP";
  const LEAD = "ses_lead_cleanup";
  try {
    seedProjectAndTeam(db, { teamId: TEAM, lead: LEAD });
    seedMember(db, TEAM, { name: "zeta", sessionId: "ses_zeta_c", agent: "build" });
    seedMember(db, TEAM, { name: "otavio", sessionId: "ses_otavio_c", agent: "otavio" });
    const out = await REAL.executeTeamCleanup(deps, { force: true, acknowledge_uncommitted: true }, LEAD);
    check("PG6 team_cleanup anexa nota [PERSONA GAP ALERT] no fechamento", out.includes(REAL.PERSONA_GAP_MARKER) && out.includes("zeta") && out.includes("Maiteux Zanela"), String(out).slice(-220));
  } finally {
    cleanup(base, db);
  }

  const base2 = mkScratch("cleanup-clean");
  const db2 = REAL.createDb(path.join(base2, "e.db"));
  const { client: client2 } = makeClient();
  const deps2 = makeDeps(REAL, { db: db2, directory: base2, client: client2 });
  const TEAM2 = "T77_CLEANUP_CLEAN";
  const LEAD2 = "ses_lead_cleanup_clean";
  try {
    seedProjectAndTeam(db2, { teamId: TEAM2, lead: LEAD2 });
    seedMember(db2, TEAM2, { name: "otavio", sessionId: "ses_otavio_cc", agent: "otavio" });
    const out = await REAL.executeTeamCleanup(deps2, { force: true, acknowledge_uncommitted: true }, LEAD2);
    check("PG6 team_cleanup SEM nota quando só há personas oficiais", !out.includes(REAL.PERSONA_GAP_MARKER), String(out).slice(0, 160));
  } finally {
    cleanup(base2, db2);
  }
}

// ---------------------------------------------------------------------------
// PG8 — paridade src↔dist + V1/V2 no MESMO caminho de execução.
// ---------------------------------------------------------------------------
{
  check(
    "PG8 src/persona-gap.ts existe e dist embute o marcador + classificador",
    /PERSONA_GAP_MARKER\s*=\s*"\[PERSONA GAP ALERT\]"/.test(srcPersonaGap)
      && distRaw.includes("[PERSONA GAP ALERT]")
      && /GENERIC_AGENT_TYPES/.test(distRaw),
  );
  check(
    "PG8 team-spawn.ts anexa o banner ao retorno (src) e dist contém a mesma instrução",
    /personaGapBannerFor\(agent/.test(srcSpawn)
      && /return personaGapBanner \?/.test(srcSpawn)
      && distRaw.includes("personaGapBannerFor(agent"),
  );
  check(
    "PG8 team-status.ts e team-cleanup.ts consomem personaGapClosingNote (src)",
    /personaGapClosingNote\(/.test(srcStatus) && /personaGapClosingNote\(/.test(srcCleanup),
  );
  check(
    "PG8 V1 e V2 delegam ao MESMO executeTeamSpawn (banner vale nas duas camadas)",
    /executeTeamSpawn\(deps, args/.test(srcV1) && /execute: run\(executeTeamSpawn\)/.test(srcV2),
  );
  check(
    "PG8 anti-mock: nenhuma dependência simulada no módulo de produção",
    !/\bmock\b|MagicMock|unittest\.mock|jest\.mock/i.test(srcPersonaGap),
  );
}

// ---------------------------------------------------------------------------
// PG9 — prova de mutação: os sentinelas REPROVAM mutantes cirúrgicos.
// ---------------------------------------------------------------------------
{
  // MUT1 — neutraliza as duas checagens de tipo genérico (nome exato + base).
  const mut1Raw = distRaw
    .replace("if (GENERIC_AGENT_TYPES.has(raw)) return true;", "if (false) return true;")
    .replace("if (GENERIC_AGENT_TYPES.has(candidate)) return true;", "if (false) return true;");
  check("PG9 MUT1 aplicado (checagem de genérico neutralizada)", mut1Raw !== distRaw);
  const mut1File = path.join(TMP, "_h77_mut1.mjs");
  writeFileSync(mut1File, buildHarnessCode(mut1Raw));
  const MUT1 = await import(mut1File);
  check(
    "PG9 MUT1 detectado: build deixa de disparar quando listado na config",
    MUT1.isPersonaGap("build", { agentDir: path.join(TMP, "no-such"), knownPersonas: ["build"] }) === false,
  );
  check(
    "PG9 MUT1 não silencia o desconhecido (escopo cirúrgico)",
    MUT1.isPersonaGap("wizard-ops", { agentDir: path.join(TMP, "no-such"), knownPersonas: [] }) === true,
  );

  // MUT2 — remove a anexação do banner no retorno do spawn.
  const mut2Raw = distRaw.replace(
    /return personaGapBanner \? `\$\{spawnLine\}[\s\S]*?\$\{personaGapBanner\}` : spawnLine;/,
    "return spawnLine;",
  );
  check("PG9 MUT2 aplicado (banner desconectado do retorno)", mut2Raw !== distRaw);
  const mut2File = path.join(TMP, "_h77_mut2.mjs");
  writeFileSync(mut2File, buildHarnessCode(mut2Raw));
  const MUT2 = await import(mut2File);
  const mutRun = await spawnOnce(MUT2, { tag: "mut2", agent: "build", name: "worker" });
  check(
    "PG9 MUT2 detectado: spawn genérico perde o banner no mutante",
    typeof mutRun.result === "string" && !mutRun.result.includes("[PERSONA GAP ALERT]"),
    String(mutRun.result).slice(0, 160),
  );

  // Sentinela de controle: o baseline REAL mantém o banner no mesmo cenário.
  const realRun = await spawnOnce(REAL, { tag: "mut2-control", agent: "build", name: "worker" });
  check(
    "PG9 controle: baseline REAL mantém o banner (mutação é a única diferença)",
    realRun.result.includes("[PERSONA GAP ALERT]"),
    String(realRun.result).slice(0, 120),
  );

  // MUT3 — neutraliza a nota de fechamento (team_status/team_cleanup). Prova
  // que a verificação no board/status é SENSÍVEL: sem a nota, PG5/PG6 caem.
  const mut3Raw = distRaw.replace(
    "function personaGapClosingNote(members, options = {}) {\n  const gaps =",
    "function personaGapClosingNote(members, options = {}) {\n  return null;\n  const gaps =",
  );
  check("PG9 MUT3 aplicado (nota de fechamento neutralizada)", mut3Raw !== distRaw);
  const mut3File = path.join(TMP, "_h77_mut3.mjs");
  writeFileSync(mut3File, buildHarnessCode(mut3Raw));
  const MUT3 = await import(mut3File);
  {
    const base = mkScratch("mut3");
    const db = MUT3.createDb(path.join(base, "e.db"));
    const { client } = makeClient();
    const deps = makeDeps(MUT3, { db, directory: base, client });
    const TEAM = "T77_MUT3";
    const LEAD = "ses_lead_mut3";
    try {
      seedProjectAndTeam(db, { teamId: TEAM, lead: LEAD });
      seedMember(db, TEAM, { name: "zeta", sessionId: "ses_zeta_m3", agent: "build" });
      const status = await MUT3.executeTeamStatus(deps, LEAD);
      check(
        "PG9 MUT3 detectado: team_status perde a nota no mutante (verificação de status é sensível)",
        !status.includes(MUT3.PERSONA_GAP_MARKER),
        String(status).slice(0, 140),
      );
    } finally {
      cleanup(base, db);
    }
  }
  // Escopo cirúrgico: MUT3 não derruba o banner do spawn (módulos independentes).
  const mut3Spawn = await spawnOnce(MUT3, { tag: "mut3-scope", agent: "build", name: "worker" });
  check(
    "PG9 MUT3 escopo cirúrgico: banner do spawn permanece no mutante",
    mut3Spawn.result.includes(MUT3.PERSONA_GAP_MARKER),
    String(mut3Spawn.result).slice(0, 120),
  );
}

// ---------------------------------------------------------------------------
// Resultado
// ---------------------------------------------------------------------------
const failed = results.filter(([, ok]) => !ok);
console.log("-".repeat(78));
console.log(`${results.length - failed.length}/${results.length} checks passed`);
if (failed.length > 0) {
  console.log(`RESULT: ${failed.length} FAILURE(S)`);
  process.exit(1);
}
console.log("RESULT: all checks passed");
process.exit(0);
