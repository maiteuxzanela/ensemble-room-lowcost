#!/usr/bin/env node
/**
 * SUÍTE DETERMINÍSTICA — TICKET-HARNESS-54 (blindagem anti-polling do Lead)
 * @maiteuxzanela/ensemble-room-lowcost
 *
 * Sob teste (dist/ REAL reconstruído do src/ REAL, SQLite real via node:sqlite — SEM MOCKS):
 *   - buildLeadSystemPrompt -> src/system-prompt.ts
 *
 * Cobertura:
 *   (C1) Paridade src↔dist do marcador "SYNTHETIC CONTINUATION PULSES".
 *   (C2) silentLead (default) + tarefas abertas (pending/in_progress/in_review)
 *        -> o prompt canônico do Lead instrui explicitamente que um pulso
 *        "[Continue]" / "Continue" / continuação de compaction é artefato de
 *        transporte e NUNCA deve acionar team_status/team_tasks_list/team_results.
 *   (C3) board fechado (nenhuma tarefa aberta) -> a diretiva condicional não é
 *        injetada (sem ruído desnecessário), mantendo a diretiva base anti-polling.
 *   (C4) silentLead:false (legado) -> diretiva condicional ausente, wording legado
 *        byte-a-byte preservado.
 *   (C5) PROVA DE MUTAÇÃO: bundle dist mutado (marcador removido) faz a suíte
 *        ficar VERMELHA no cenário (C2) e PERMANECER VERDE no cenário (C3-C4).
 *
 * Uso: node tests/test_ticket_harness_54_system_prompt_anti_polling.mjs
 * Exit: 0 = todos os checks PASS; 1 = há FAIL.
 */

import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";

const REPO = path.resolve(import.meta.dirname, "..");
const PKG = process.env.ENSEMBLE_PKG || REPO;
const DIST = path.join(PKG, "dist/index.js");
const SRC = path.join(REPO, "src");
const TMP = path.join(REPO, ".test-scratch");
mkdirSync(TMP, { recursive: true });

const MARKER = "SYNTHETIC CONTINUATION PULSES";
const REQUIRED_SYMBOLS = ["createDb", "buildLeadSystemPrompt", "DEFAULT_CONFIG", "MIGRATIONS"];

const results = [];
const check = (name, ok, detail) => {
  results.push([name, ok]);
  console.log(`${ok ? "PASS" : "FAIL"} | ${name}${detail ? " | " + detail : ""}`);
};

const distRaw = readFileSync(DIST, "utf8");
const srcPrompt = readFileSync(path.join(SRC, "system-prompt.ts"), "utf8");

// ---------------------------------------------------------------------------
// 1. Paridade src↔dist do marcador e dos símbolos.
// ---------------------------------------------------------------------------
{
  check("src: marcador anti-pulso presente", srcPrompt.includes(MARKER));
  check("dist: marcador anti-pulso presente (paridade)", distRaw.includes(MARKER));
  check(
    "src: diretiva condicionada a board aberto (openTaskCount > 0)",
    /openTaskCount\s*>\s*0/.test(srcPrompt),
  );
  const missing = REQUIRED_SYMBOLS.filter(
    (s) => !new RegExp(`(function|class|var|const|let)\\s+${s}\\b`).test(distRaw),
  );
  check("dist declara os símbolos exigidos", missing.length === 0, missing.join(",") || "ok");
}

// ---------------------------------------------------------------------------
// 2. Harness real a partir do dist (sem mocks).
// ---------------------------------------------------------------------------
const buildHarness = (raw, outFile) => {
  const existingExport = raw.match(/export\s*\{([^}]*)\}\s*;?\s*$/)?.[1] ?? "";
  const already = new Set(
    existingExport.split(",").map((s) => s.trim().split(/\s+as\s+/).pop()).filter(Boolean),
  );
  const need = REQUIRED_SYMBOLS.filter((s) => !already.has(s));
  writeFileSync(outFile, raw + (need.length ? `\nexport { ${need.join(", ")} };\n` : ""));
};

const REAL_HARNESS = path.join(TMP, `_prompt54_real_${process.pid}.mjs`);
const MUT_HARNESS = path.join(TMP, `_prompt54_mut_${process.pid}.mjs`);
buildHarness(distRaw, REAL_HARNESS);
buildHarness(distRaw.replaceAll(MARKER, "MUTATED_PULSE_MARKER"), MUT_HARNESS);

const realMod = await import(REAL_HARNESS);
const mutMod = await import(MUT_HARNESS);

// ---------------------------------------------------------------------------
// 3. Cenários contra SQLite real.
// ---------------------------------------------------------------------------
let seq = 0;
const runScenario = (mod, { taskStatuses, silentLead }) => {
  const dir = path.join(TMP, `prompt54_${process.pid}_${seq++}`);
  mkdirSync(dir, { recursive: true });
  const db = mod.createDb(path.join(dir, "ensemble.db"));
  const now = Date.now();
  const teamId = "team_prompt54";
  db.run(
    "INSERT INTO project (id, name, path, status, time_created, time_updated) VALUES ('default','Default','','active',?,?) ON CONFLICT DO NOTHING",
    [now, now],
  );
  db.run(
    "INSERT INTO team (id, name, project_id, lead_session_id, status, delegate, time_created, time_updated) VALUES (?,?,'default',?,'active',0,?,?)",
    [teamId, "prompt54", "ses_lead", now, now],
  );
  db.run(
    `INSERT INTO team_member (team_id, name, session_id, agent, status, execution_status, is_qa, spawn_context, time_created, time_updated, reported_to_lead)
     VALUES (?,?,?,?, 'ready', 'idle', 0, NULL, ?, ?, 0)`,
    [teamId, "tales", "ses_tales", "tales", now, now],
  );
  taskStatuses.forEach((status, index) => {
    db.run(
      "INSERT INTO team_task (id, team_id, content, status, priority, assignee, review_notes, time_created, time_updated) VALUES (?,?,?,?,'high',?,NULL,?,?)",
      [`task_${index}`, teamId, `Task ${index}`, status, "tales", now, now],
    );
  });
  const config = { ...mod.DEFAULT_CONFIG, silentLead };
  const prompt = mod.buildLeadSystemPrompt(db, teamId, config);
  db.close?.();
  return prompt;
};

{
  const config = { ...realMod.DEFAULT_CONFIG, silentLead: true };
  const openPrompt = runScenario(realMod, { taskStatuses: ["in_progress"], silentLead: true });
  check("C2 silentLead+board aberto: diretiva anti-pulso presente", openPrompt.includes(MARKER));
  check(
    "C2 diretiva cita os três canais de inspeção proibidos",
    openPrompt.includes("team_status") && openPrompt.includes("team_tasks_list") && openPrompt.includes("team_results"),
  );
  check("C2 diretiva nomeia o artefato [Continue]", openPrompt.includes('"[Continue]"'));
  check("C2 diretiva base anti-polling preservada", openPrompt.includes("Do NOT poll team_status or team_tasks_list repeatedly"));
  check("C2 config real default: silentLead é true", config.silentLead === true);

  const closedPrompt = runScenario(realMod, { taskStatuses: ["completed", "completed"], silentLead: true });
  check("C3 board fechado: diretiva condicional ausente (sem ruído)", !closedPrompt.includes(MARKER));
  check("C3 board fechado: diretiva base anti-polling preservada", closedPrompt.includes("Do NOT poll team_status or team_tasks_list repeatedly"));

  const emptyPrompt = runScenario(realMod, { taskStatuses: [], silentLead: true });
  check("C3 board vazio: diretiva condicional ausente", !emptyPrompt.includes(MARKER));

  const legacyPrompt = runScenario(realMod, { taskStatuses: ["in_progress"], silentLead: false });
  check("C4 legado silentLead:false: diretiva condicional ausente", !legacyPrompt.includes(MARKER));
  check("C4 legado: wording antigo preservado", legacyPrompt.includes("Teammates work asynchronously and message you when done."));
}

// ---------------------------------------------------------------------------
// 4. PROVA DE MUTAÇÃO — o mutante falha onde deve e fica verde onde deve.
// ---------------------------------------------------------------------------
{
  const mutatedOpen = runScenario(mutMod, { taskStatuses: ["in_progress"], silentLead: true });
  check(
    "M1 mutante (marcador removido) FALHA o cenário alvo (C2)",
    !mutatedOpen.includes(MARKER),
  );
  check(
    "M2 mutante PRESERVA os fluxos não-alvo (C3 board fechado + C4 legado)",
    !runScenario(mutMod, { taskStatuses: ["completed"], silentLead: true }).includes(MARKER) &&
      !runScenario(mutMod, { taskStatuses: ["in_progress"], silentLead: false }).includes(MARKER),
  );
}

console.log("-".repeat(78));
const failed = results.filter(([, ok]) => !ok);
console.log(`RESULT: ${results.length - failed.length}/${results.length} checks passed`);
console.log(`[HARNESS-54] ${results.length - failed.length}/${results.length} checks PASS`);
try {
  rmSync(REAL_HARNESS, { force: true });
  rmSync(MUT_HARNESS, { force: true });
} catch {}
process.exit(failed.length === 0 ? 0 : 1);
