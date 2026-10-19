#!/usr/bin/env node
/**
 * SUÍTE DETERMINÍSTICA — TICKET-HARNESS-55 (Camada C: Auto-Dimensionamento Nativo)
 * @maiteuxzanela/ensemble-room-lowcost
 *
 * Sob teste (dist/ REAL reconstruído do src/ REAL, SQLite real via node:sqlite — SEM MOCKS):
 *   - src/system-prompt.ts      -> LEAD_TOPOLOGY_PROTOCOL, leadTopologySizingReminder,
 *                                  buildLeadSystemPrompt, buildTeamCompactionContext
 *   - src/tools/team-create.ts  -> executeTeamCreate (retorno pedagógico enriquecido)
 *   - src/tools/team-tasks-add.ts / team-tasks-complete.ts (saneamento do depends_on)
 *
 * Cobertura:
 *   (C1) Paridade src↔dist do protocolo e do reminder (fonte única, sem duplicação).
 *   (C2) buildLeadSystemPrompt injeta o bloco pedagógico ANTES das instruções de spawn,
 *        com os 4 sub-blocos (a/b/c/d) e exatamente 1 ocorrência por prompt.
 *        Vale tanto para silentLead default quanto para o modo legado.
 *   (C3) buildTeamCompactionContext(role='lead') preserva o protocolo após compactação;
 *        role='member' NÃO recebe o protocolo (sem vazamento de scaffold de Lead).
 *   (C4) executeTeamCreate retorna o reminder pedagógico (mesma fonte única, sem
 *        duplicação de texto) e a equipe é realmente persistida no SQLite real.
 *   (C5) Ausência de menções ATIVAS a depends_on: src/*.ts (exceto o histórico
 *        append-only de schema.ts) = 0; dist só contém o SQL histórico da Migrations
 *        1/8/13/19; o prompt do Lead e o retorno de team_create não o mencionam.
 *   (C6) PROVA DE MUTAÇÃO (3 mutantes independentes):
 *        M1 remove a injeção no prompt do Lead -> só C2 falha;
 *        M2 remove o append no team_create      -> só C4 falha;
 *        M3 remove a injeção na compaction      -> só C3 falha.
 *
 * Uso: node tests/test_ticket_harness_55_auto_sizing.mjs
 * Exit: 0 = todos os checks PASS; 1 = há FAIL.
 */

import { mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";

const REPO = path.resolve(import.meta.dirname, "..");
const PKG = process.env.ENSEMBLE_PKG || REPO;
const DIST = path.join(PKG, "dist/index.js");
const SRC = path.join(REPO, "src");
const TMP = path.join(REPO, ".test-scratch");
mkdirSync(TMP, { recursive: true });

const PROTOCOL_HEADER = "LEAD TOPOLOGY & SIZING PROTOCOL (AUTO-DIMENSIONAMENTO NATIVO):";
const REMINDER_HEADER = "LEAD TOPOLOGY & SIZING PROTOCOL — dimensione o time ANTES de convocar:";
const REMINDER_MARKER = "LEAD TOPOLOGY & SIZING PROTOCOL";
const SPAWN_MARKER = "Spawn teammates ONE AT A TIME. Wait for each tool result before spawning the next.";
const SUB_BLOCKS = [
  "a) DOMAIN COVERAGE",
  "b) SPECIALIST HIRING REPORT (PERSONA GAP)",
  "c) OVERLOAD PREVENTION (>2 COMPLEX STEPS)",
  "d) HYBRID TOPOLOGY",
];

const results = [];
const check = (name, ok, detail) => {
  results.push([name, ok]);
  console.log(`${ok ? "PASS" : "FAIL"} | ${name}${detail ? " | " + detail : ""}`);
};
const countOf = (hay, needle) => hay.split(needle).length - 1;

const distRaw = readFileSync(DIST, "utf8");
const srcPrompt = readFileSync(path.join(SRC, "system-prompt.ts"), "utf8");
const srcCreate = readFileSync(path.join(SRC, "tools/team-create.ts"), "utf8");

// ---------------------------------------------------------------------------
// 1. Harness: dist real + exportação dos símbolos sob teste (sem mocks).
// ---------------------------------------------------------------------------
const REQUIRED_SYMBOLS = [
  "createDb",
  "buildLeadSystemPrompt",
  "buildTeamCompactionContext",
  "leadTopologySizingReminder",
  "executeTeamCreate",
  "DEFAULT_CONFIG",
  "MemberRegistry",
  "ProgressTracker",
];

const buildHarness = (raw, outFile) => {
  const existingExport = raw.match(/export\s*\{([^}]*)\}\s*;?\s*$/)?.[1] ?? "";
  const already = new Set(
    existingExport.split(",").map((s) => s.trim().split(/\s+as\s+/).pop()).filter(Boolean),
  );
  const need = REQUIRED_SYMBOLS.filter((s) => !already.has(s));
  writeFileSync(outFile, raw + (need.length ? `\nexport { ${need.join(", ")} };\n` : ""));
};

const uniqueHarness = (suffix) => path.join(TMP, `_h55_${suffix}_${process.pid}.mjs`);
const REAL_HARNESS = uniqueHarness("real");

// Mutantes construídos a partir do bundle REAL (mutações cirúrgicas e isoladas).
const M1_INJECTION_OLD = `  lines.push(\n    "",\n    ...LEAD_TOPOLOGY_PROTOCOL,\n    "",\n    "${SPAWN_MARKER.slice(0, 24)}`;
const M1_INJECTION_NEW = `  lines.push(\n    "",\n    "${SPAWN_MARKER.slice(0, 24)}`;
const M2_APPEND_OLD = "\n\n${leadTopologySizingReminder()}";
const M2_APPEND_NEW = "";
const M3_COMPACTION_OLD = `lines.push("", ...LEAD_TOPOLOGY_PROTOCOL);`;
const M3_COMPACTION_NEW = `lines.push("");`;

const MUTANTS = [
  {
    id: "M1",
    label: "sem injeção no prompt do Lead",
    raw: distRaw.replace(M1_INJECTION_OLD, M1_INJECTION_NEW),
    changed: distRaw.includes(M1_INJECTION_OLD),
  },
  {
    id: "M2",
    label: "sem append do reminder em team_create",
    raw: distRaw.replace(M2_APPEND_OLD, M2_APPEND_NEW),
    changed: distRaw.includes(M2_APPEND_OLD),
  },
  {
    id: "M3",
    label: "sem injeção na compaction do Lead",
    raw: distRaw.replace(M3_COMPACTION_OLD, M3_COMPACTION_NEW),
    changed: distRaw.includes(M3_COMPACTION_OLD),
  },
];

{
  const missing = REQUIRED_SYMBOLS.filter(
    (s) => !new RegExp(`(function|class|var|const|let)\\s+${s}\\b`).test(distRaw),
  );
  check("dist declara todos os símbolos exigidos", missing.length === 0, missing.join(",") || `${REQUIRED_SYMBOLS.length} símbolos`);
  for (const m of MUTANTS) {
    check(`${m.id} mutação cirúrgica aplicável no dist`, m.changed);
  }
}

// ---------------------------------------------------------------------------
// 2. Paridade src↔dist (fonte única, sem duplicação).
// ---------------------------------------------------------------------------
{
  check("src: LEAD_TOPOLOGY_PROTOCOL declarado e exportado", /export const LEAD_TOPOLOGY_PROTOCOL\b/.test(srcPrompt));
  check("src: leadTopologySizingReminder declarado e exportado", /export function leadTopologySizingReminder\b/.test(srcPrompt));
  check(
    "src: exatamente 2 menções ao cabeçalho (const + reminder)",
    countOf(srcPrompt, REMINDER_MARKER) === 2,
    `count=${countOf(srcPrompt, REMINDER_MARKER)}`,
  );
  check(
    "dist: exatamente 2 menções ao cabeçalho (paridade)",
    countOf(distRaw, REMINDER_MARKER) === 2,
    `count=${countOf(distRaw, REMINDER_MARKER)}`,
  );
  check("dist: leadTopologySizingReminder declarado", /function leadTopologySizingReminder\s*\(/.test(distRaw));
  check("src: team_create usa a MESMA fonte única", /import\s*\{\s*leadTopologySizingReminder\s*\}\s*from\s*"\.\.\/system-prompt"/.test(srcCreate));
  check(
    "src: injeção do protocolo ocorre ANTES das instruções de spawn",
    srcPrompt.indexOf("...LEAD_TOPOLOGY_PROTOCOL") !== -1 &&
      srcPrompt.indexOf("...LEAD_TOPOLOGY_PROTOCOL") < srcPrompt.indexOf(SPAWN_MARKER),
  );
}

// ---------------------------------------------------------------------------
// 3. Cenários reais contra SQLite real.
// ---------------------------------------------------------------------------
buildHarness(distRaw, REAL_HARNESS);
const REAL = await import(REAL_HARNESS);
const MUT = {};
for (const m of MUTANTS) {
  const file = uniqueHarness(m.id.toLowerCase());
  buildHarness(m.raw, file);
  MUT[m.id] = await import(file);
}

let seq = 0;
const seedTeam = (mod, { tasks = ["in_progress"], silentLead = true } = {}) => {
  const dir = path.join(TMP, `h55_${process.pid}_${seq++}`);
  mkdirSync(dir, { recursive: true });
  const db = mod.createDb(path.join(dir, "ensemble.db"));
  const now = Date.now();
  const teamId = "team_h55";
  db.run(
    "INSERT OR IGNORE INTO project (id, name, path, status, time_created, time_updated) VALUES ('default','Default','','active',?,?)",
    [now, now],
  );
  db.run(
    "INSERT INTO team (id, name, project_id, lead_session_id, status, delegate, time_created, time_updated) VALUES (?,?,'default',?,'active',0,?,?)",
    [teamId, "h55", "ses_lead", now, now],
  );
  db.run(
    `INSERT INTO team_member (team_id, name, session_id, agent, status, execution_status, is_qa, spawn_context, time_created, time_updated, reported_to_lead)
     VALUES (?,?,?,?, 'ready', 'idle', 0, NULL, ?, ?, 0)`,
    [teamId, "tales", "ses_tales", "tales", now, now],
  );
  tasks.forEach((status, index) => {
    db.run(
      "INSERT INTO team_task (id, team_id, content, status, priority, assignee, review_notes, time_created, time_updated) VALUES (?,?,?,?,'high',?,NULL,?,?)",
      [`task_${index}`, teamId, `Task ${index}`, status, "tales", now, now],
    );
  });
  const config = { ...mod.DEFAULT_CONFIG, silentLead };
  return { db, teamId, config, dir };
};

const promptScenario = (mod, opts) => {
  const { db, teamId, config } = seedTeam(mod, opts);
  const prompt = mod.buildLeadSystemPrompt(db, teamId, config);
  db.close?.();
  return prompt;
};

const compactionScenario = (mod, role) => {
  const { db, teamId, config } = seedTeam(mod);
  const ctx = mod.buildTeamCompactionContext(db, teamId, role, role === "member" ? "tales" : undefined, config);
  db.close?.();
  return ctx;
};

const createScenario = async (mod, teamName) => {
  const dir = path.join(TMP, `h55_create_${process.pid}_${seq++}`);
  mkdirSync(dir, { recursive: true });
  const db = mod.createDb(path.join(dir, "ensemble.db"));
  const deps = {
    db,
    directory: dir,
    client: {
      session: {
        create: async () => ({ data: { id: "ses_child" } }),
        promptAsync: async () => ({}),
        abort: async () => ({}),
      },
      tui: { showToast: async () => ({}) },
    },
    registry: new mod.MemberRegistry(),
    config: { ...mod.DEFAULT_CONFIG },
    progressTracker: new mod.ProgressTracker(),
  };
  const out = await mod.executeTeamCreate(deps, { name: teamName }, "ses_new_lead");
  const row = db.query("SELECT id, name, lead_session_id, status FROM team WHERE name = ?").get(teamName);
  db.close?.();
  return { out, row };
};

// --- C2: prompt do Lead -----------------------------------------------------
{
  const prompt = promptScenario(REAL, { tasks: ["in_progress"], silentLead: true });
  check("C2 prompt do Lead contém o cabeçalho do protocolo", prompt.includes(PROTOCOL_HEADER));
  check(
    "C2 prompt do Lead contém exatamente 1 protocolo (sem duplicação)",
    countOf(prompt, REMINDER_MARKER) === 1,
    `count=${countOf(prompt, REMINDER_MARKER)}`,
  );
  const missingBlocks = SUB_BLOCKS.filter((b) => !prompt.includes(b));
  check("C2 os 4 sub-blocos (a/b/c/d) estão presentes", missingBlocks.length === 0, missingBlocks.join(" | ") || "4/4");
  check(
    "C2 protocolo posicionado ANTES das instruções de spawn",
    prompt.indexOf(PROTOCOL_HEADER) !== -1 &&
      prompt.indexOf(PROTOCOL_HEADER) < prompt.indexOf(SPAWN_MARKER),
  );
  check(
    "C2 protocolo orienta handover intra-card para arquivos concorrentes",
    prompt.includes("team_task_handover") && prompt.includes("persona>-1/<persona>-2"),
  );
  check(
    "C2 protocolo orienta relatar persona gap sem travar a demanda",
    prompt.includes("personas/<name>.md") && /do NOT stall the demand/i.test(prompt),
  );
  check("C2 prompt do Lead não menciona depends_on", !/depends_on|dependsOn/.test(prompt));

  const legacy = promptScenario(REAL, { tasks: ["in_progress"], silentLead: false });
  check("C2 protocolo presente também no modo legado (silentLead:false)", legacy.includes(PROTOCOL_HEADER));

  const closed = promptScenario(REAL, { tasks: ["completed"], silentLead: true });
  check("C2 protocolo presente com board fechado (independe do estado do board)", closed.includes(PROTOCOL_HEADER));
}

// --- C3: compaction ---------------------------------------------------------
{
  const leadCtx = compactionScenario(REAL, "lead");
  check("C3 compaction(lead) preserva o protocolo", leadCtx.includes(PROTOCOL_HEADER));
  check("C3 compaction(lead) preserva os 4 sub-blocos", SUB_BLOCKS.every((b) => leadCtx.includes(b)));
  check(
    "C3 compaction(lead) contém exatamente 1 protocolo",
    countOf(leadCtx, REMINDER_MARKER) === 1,
    `count=${countOf(leadCtx, REMINDER_MARKER)}`,
  );
  const memberCtx = compactionScenario(REAL, "member");
  check("C3 compaction(member) NÃO recebe o scaffold de Lead", !memberCtx.includes(REMINDER_MARKER));
  check("C3 compaction(member) permanece contextual (teammate line)", memberCtx.includes("You are a teammate named"));
}

// --- C4: team_create --------------------------------------------------------
{
  const { out, row } = await createScenario(REAL, "h55-created");
  check("C4 team_create persiste a equipe no SQLite real", !!row && row.status === "active" && row.lead_session_id === "ses_new_lead");
  check("C4 retorno mantém a orientação canônica de squad", out.includes("convoque o squad canônico via team_spawn"));
  check("C4 retorno anexa o reminder pedagógico", out.includes(REAL.leadTopologySizingReminder()));
  check(
    "C4 retorno contém exatamente 1 reminder (sem duplicação de texto)",
    countOf(out, REMINDER_MARKER) === 1,
    `count=${countOf(out, REMINDER_MARKER)}`,
  );
  check("C4 retorno cobre domínio/persona gap/sobrecarga/topologia híbrida", ["(a) Domínios", "(b) Persona Gap", "(c) Sobrecarga", "(d) Topologia híbrida"].every((s) => out.includes(s)));
  check("C4 retorno não menciona depends_on", !/depends_on|dependsOn/.test(out));
  const reminder = REAL.leadTopologySizingReminder();
  check("C4 reminder é exatamente o sufixo do retorno (fonte única)", out.endsWith(`\n\n${reminder}`));
}

// --- C5: saneamento do depends_on ------------------------------------------
{
  const walk = (dir) =>
    readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
      e.isDirectory() ? walk(path.join(dir, e.name)) : [path.join(dir, e.name)],
    );
  const srcFiles = walk(SRC).filter((f) => f.endsWith(".ts"));
  check("C5 src possui arquivos .ts para escanear", srcFiles.length > 0, `${srcFiles.length} arquivos`);

  const offenders = [];
  for (const file of srcFiles) {
    const rel = path.relative(SRC, file);
    // schema.ts é histórico append-only de migrations: intocado por invariante.
    if (rel === "schema.ts") continue;
    const raw = readFileSync(file, "utf8");
    if (/depends_on|dependsOn/.test(raw)) offenders.push(rel);
  }
  check("C5 src/*.ts fora de schema.ts: 0 menções a depends_on/dependsOn", offenders.length === 0, offenders.join(","));

  // dist: as únicas ocorrências remanescentes são o SQL histórico das migrations.
  const distLines = distRaw.split("\n");
  const occurrences = distLines.filter((l) => /depends_on|dependsOn/.test(l));
  const historical = /(depends_on\s+TEXT|INSERT INTO team_task\b.*depends_on|SELECT id, team_id.*depends_on|drops the `depends_on` column)/;
  const nonHistorical = occurrences.filter((l) => !historical.test(l));
  check(
    "C5 dist: apenas SQL histórico de migrations menciona depends_on",
    nonHistorical.length === 0,
    nonHistorical.map((l) => l.trim().slice(0, 80)).join(" || ") || `${occurrences.length} ocorrências históricas`,
  );
  check("C5 dist: nenhuma menção camelCase dependsOn", !/dependsOn/.test(distRaw));
  check("C5 descrição de team_tasks_add saneada", !/depends_on|dependsOn/.test(readFileSync(path.join(SRC, "tools/team-tasks-add.ts"), "utf8")));
  check("C5 descrição de team_tasks_complete saneada", !/depends_on|dependsOn/.test(readFileSync(path.join(SRC, "tools/team-tasks-complete.ts"), "utf8")));
}

// ---------------------------------------------------------------------------
// 4. PROVA DE MUTAÇÃO — cada mutante derruba APENAS o check alvo.
// ---------------------------------------------------------------------------
{
  const m1Prompt = promptScenario(MUT.M1, { tasks: ["in_progress"], silentLead: true });
  check("M1 mutante FALHA C2 (protocolo ausente no prompt)", !m1Prompt.includes(REMINDER_MARKER));
  check("M1 mutante PRESERVA C3 (compaction(lead))", compactionScenario(MUT.M1, "lead").includes(PROTOCOL_HEADER));
  check("M1 mutante PRESERVA C4 (team_create)", (await createScenario(MUT.M1, "h55-m1")).out.includes(REMINDER_MARKER));

  const m2Create = (await createScenario(MUT.M2, "h55-m2")).out;
  check("M2 mutante FALHA C4 (reminder ausente no team_create)", !m2Create.includes(REMINDER_MARKER));
  check("M2 mutante PRESERVA C2 (prompt do Lead)", promptScenario(MUT.M2, { tasks: ["in_progress"], silentLead: true }).includes(REMINDER_MARKER));
  check("M2 mutante PRESERVA C3 (compaction(lead))", compactionScenario(MUT.M2, "lead").includes(PROTOCOL_HEADER));

  const m3Lead = compactionScenario(MUT.M3, "lead");
  check("M3 mutante FALHA C3 (protocolo ausente na compaction)", !m3Lead.includes(REMINDER_MARKER));
  check("M3 mutante PRESERVA C2 (prompt do Lead)", promptScenario(MUT.M3, { tasks: ["in_progress"], silentLead: true }).includes(REMINDER_MARKER));
  check("M3 mutante PRESERVA C4 (team_create)", (await createScenario(MUT.M3, "h55-m3")).out.includes(REMINDER_MARKER));
}

console.log("-".repeat(78));
const failed = results.filter(([, ok]) => !ok);
console.log(`RESULT: ${results.length - failed.length}/${results.length} checks passed`);
console.log(`[HARNESS-55] ${results.length - failed.length}/${results.length} checks PASS`);
try {
  rmSync(REAL_HARNESS, { force: true });
  for (const m of MUTANTS) rmSync(uniqueHarness(m.id.toLowerCase()), { force: true });
} catch {}
process.exit(failed.length === 0 ? 0 : 1);
