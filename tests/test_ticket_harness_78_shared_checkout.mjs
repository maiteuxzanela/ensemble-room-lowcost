#!/usr/bin/env node
/**
 * QUALITY GATE DETERMINÍSTICO — TICKET-HARNESS-78
 * @maiteuxzanela/ensemble-room-lowcost
 *
 * Expurgar worktrees individuais e consolidar checkout coletivo compartilhado.
 *
 * Sob teste (src/ e dist/ REAIS, SQLite real via node:sqlite — SEM MOCKS no
 * código de produção; a fronteira SDK é um recorder determinístico, o mesmo
 * seam de transporte usado por todo o parque de testes):
 *   M1  src/tools/team-spawn.ts — spawn NUNCA chama worktree.create nem
 *       workspace.create, mesmo com `worktree: true` explícito (flag
 *       deprecada e ignorada). Colunas worktree_dir/worktree_branch/workspace_id
 *       permanecem NULL no SQLite (retrocompat, nullable).
 *   M2  src/tools/team-spawn.ts — spawn com a flag OMITIDA (default) também
 *       opera em checkout compartilhado (nenhuma chamada worktree/workspace).
 *   M3  src/tools/team-spawn.ts — prompt do teammate declara o diretório
 *       compartilhado e orienta coordenação via team_message/team_task_handover.
 *   M4  src/tools/team-spawn.ts — retorno do spawn cita "shared-checkout".
 *   M5  src/index.ts (V1) + src/v2-tools.ts (V2) — schema das DUAS camadas
 *       mantém a propriedade `worktree` (retrocompat, additionalProperties:false
 *       não quebra callers antigos) com descrição [DEPRECATED - IGNORED].
 *   M6  src/tools/team-spawn.ts — helper legado isWorktreeDirectory removido;
 *       nenhum call site de worktree.create no arquivo de spawn (paridade
 *       src↔dist).
 *   M7  Leitores (explore/plan) também nascem sem worktree; permissões de
 *       read-only (deny edit/bash) preservadas.
 *
 * Cobertura:
 *   - (M1/M2/M3/M7) spawns reais em SQLite real: worktree:true explícito, flag
 *     omitida, prompt não-standby e read-only explore — zero
 *     worktree.create/workspace.create; colunas NULL; prompt declara
 *     checkout compartilhado + handover e NÃO contém commit manual.
 *   - (M5) schema V2 registrado em runtime (registerV2Tools) + bloco V1 no src.
 *   - (M6) marcadores estruturais src↔dist.
 *   - (M8) integridade das SKILL.md atualizadas (board-handover/orchestration):
 *     worktree individual descontinuado, Buffer de Complete canônico amparado
 *     pelo ledger HARNESS-82 e ausência da receita morta `worktree: true|false`.
 *   - (mutação) 4 mutantes cirúrgicos executados contra um dist MUTADO real,
 *     cada um detectado por sentinelas (as mesmas checks do baseline devem
 *     FALHAR no mutante).
 *
 * Uso: node tests/test_ticket_harness_78_shared_checkout.mjs
 * Exit: 0 = todos os checks PASS; 1 = há FAIL.
 */

import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

const REPO = path.resolve(import.meta.dirname, "..");
const DIST = path.join(REPO, "dist/index.js");
const SRC = path.join(REPO, "src");
const TMP = path.join(REPO, ".test-scratch", "h78");
mkdirSync(TMP, { recursive: true });

const results = [];
const check = (name, ok, detail) => {
  results.push([name, ok]);
  console.log(`${ok ? "PASS" : "FAIL"} | ${name}${detail ? " | " + detail : ""}`);
};
const unhandled = [];
process.on("unhandledRejection", (e) => unhandled.push(e));
const NOW = () => Date.now();

// ---------------------------------------------------------------------------
// 0. Harness: dist real + exportação dos símbolos sob teste (sem mocks).
// ---------------------------------------------------------------------------
const REQUIRED_SYMBOLS = [
  "createDb", "DEFAULT_CONFIG", "MemberRegistry", "ProgressTracker",
  "DescendantTracker", "PendingPurgeApprovals", "executeTeamCreate",
  "executeTeamSpawn", "registerV2Tools",
];
const distRaw = readFileSync(DIST, "utf8");
const srcSpawn = readFileSync(path.join(SRC, "tools/team-spawn.ts"), "utf8");
const srcIndex = readFileSync(path.join(SRC, "index.ts"), "utf8");
const srcV2 = readFileSync(path.join(SRC, "v2-tools.ts"), "utf8");

function buildHarnessCode(raw) {
  const existingExport = raw.match(/export\s*\{([^}]*)\}\s*;?\s*$/)?.[1] ?? "";
  const already = new Set(existingExport.split(",").map((s) => s.trim().split(/\s+as\s+/).pop()).filter(Boolean));
  const need = REQUIRED_SYMBOLS.filter((s) => !already.has(s));
  return raw + (need.length ? `\nexport { ${need.join(", ")} };\n` : "");
}
{
  const missing = REQUIRED_SYMBOLS.filter((s) => !new RegExp(`(function|class|var|const|let)\\s+${s}\\b`).test(distRaw));
  check("harness: dist declara todos os símbolos exigidos", missing.length === 0, missing.join(",") || `${REQUIRED_SYMBOLS.length} símbolos`);
}
const harnessFile = path.join(TMP, "_h78_real.mjs");
writeFileSync(harnessFile, buildHarnessCode(distRaw));
const REAL = await import(harnessFile);

// ---------------------------------------------------------------------------
// Helpers: seed SQLite real + recorder determinístico da fronteira SDK.
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
function mkScratch(tag) { return mkdtempSync(path.join(os.tmpdir(), `ens-h78-${tag}-`)); }
function cleanup(base, db) {
  try { db?.close(); } catch { /* já fechado */ }
  try { rmSync(base, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }); } catch { /* best effort */ }
}
/**
 * Recorder determinístico da fronteira SDK (worktree/workspace/session).
 * Nenhuma lógica de produção é substituída — é o mesmo seam de transporte
 * usado por todo o parque (test_standby_lifecycle, test_ticket_harness_37).
 * Se o runtime chamar worktree.create/workspace.create, o call fica gravado
 * e devolve um diretório/branch sintéticos — a asserção é "zero calls".
 */
function makeClient() {
  const calls = { sessionCreate: [], promptAsync: [], worktreeCreate: [], workspaceCreate: [], toast: [] };
  const client = {
    session: {
      create: async (o) => { calls.sessionCreate.push(o); return { data: { id: `ses_child_${calls.sessionCreate.length}` } }; },
      promptAsync: async (o) => { calls.promptAsync.push(o); return {}; },
      abort: async () => ({}),
    },
    tui: { showToast: async (o) => { calls.toast.push(o); return {}; }, selectSession: async () => ({}) },
    worktree: {
      create: async (o) => { calls.worktreeCreate.push(o); return { data: { name: "w", branch: "b", directory: "/tmp/w" } }; },
      remove: async () => ({}),
    },
    workspace: {
      create: async (o) => { calls.workspaceCreate.push(o); return { data: { id: "ws_1" } }; },
      remove: async () => ({}),
    },
  };
  return { calls, client };
}
function makeDeps(mod, { db, directory, client, registry }) {
  return {
    db,
    registry: registry ?? new mod.MemberRegistry(),
    tracker: new mod.DescendantTracker(),
    purgeApprovals: new mod.PendingPurgeApprovals(),
    client,
    directory,
    config: { ...mod.DEFAULT_CONFIG },
    progressTracker: new mod.ProgressTracker(),
  };
}
const memberRow = (db, teamId, name) =>
  db.query(
    "SELECT worktree_dir, worktree_branch, workspace_id, status, execution_status FROM team_member WHERE team_id = ? AND name = ?",
  ).get(teamId, name);

/**
 * Roda TODOS os cenários de spawn contra o módulo `mod` (real ou mutante) e
 * devolve um Map<checkName, {ok, detail}> — a mesma estrutura do
 * test_sdet_handover_flow.mjs, permitindo que os mutantes sejam executados de
 * verdade e as sentinelas devem FALHAR no mutante.
 */
async function runScenarios(mod) {
  const got = new Map();
  const R = (n, ok, d) => got.set(n, { ok: !!ok, detail: d === undefined ? "" : String(d) });

  // M1 — spawn com worktree: true EXPLÍCITO nunca cria worktree (flag ignorada)
  {
    const base = mkScratch("m1");
    const db = mod.createDb(path.join(base, "e.db"));
    const { calls, client } = makeClient();
    const deps = makeDeps(mod, { db, directory: base, client });
    const TEAM = "T78M1", LEAD = "ses_lead_78m1";
    try {
      seedProjectAndTeam(db, { teamId: TEAM, lead: LEAD });
      const res = await mod.executeTeamSpawn(
        deps,
        { name: "tales", agent: "build", prompt: "implementar o HARNESS-78", worktree: true },
        LEAD,
      );
      R("M1.worktree-create-zero", calls.worktreeCreate.length === 0, `calls=${calls.worktreeCreate.length}`);
      R("M1.workspace-create-zero", calls.workspaceCreate.length === 0, `calls=${calls.workspaceCreate.length}`);
      const row = memberRow(db, TEAM, "tales");
      R("M1.worktree-dir-null", row?.worktree_dir === null, String(row?.worktree_dir));
      R("M1.worktree-branch-null", row?.worktree_branch === null, String(row?.worktree_branch));
      R("M1.workspace-id-null", row?.workspace_id === null, String(row?.workspace_id));
      R("M1.retorno-cita-shared-checkout", typeof res === "string" && res.includes("shared-checkout"), String(res).slice(0, 160));
    } catch (e) {
      R("M1.cenario-executavel", false, e?.stack ?? String(e));
    } finally {
      cleanup(base, db);
    }
  }

  // M2 — spawn com a flag OMITIDA (default) também opera em checkout compartilhado
  {
    const base = mkScratch("m2");
    const db = mod.createDb(path.join(base, "e.db"));
    const { calls, client } = makeClient();
    const deps = makeDeps(mod, { db, directory: base, client });
    const TEAM = "T78M2", LEAD = "ses_lead_78m2";
    try {
      seedProjectAndTeam(db, { teamId: TEAM, lead: LEAD });
      await mod.executeTeamSpawn(
        deps,
        { name: "davi", agent: "build", prompt: "ledger particionado", standby: true },
        LEAD,
      );
      R("M2.worktree-create-zero", calls.worktreeCreate.length === 0, `calls=${calls.worktreeCreate.length}`);
      R("M2.workspace-create-zero", calls.workspaceCreate.length === 0, `calls=${calls.workspaceCreate.length}`);
      const row = memberRow(db, TEAM, "davi");
      R("M2.worktree-dir-null", row?.worktree_dir === null, String(row?.worktree_dir));
      R("M2.worktree-branch-null", row?.worktree_branch === null, String(row?.worktree_branch));
      const ctx = db.query("SELECT spawn_context FROM team_member WHERE team_id = ? AND name = ?").get(TEAM, "davi")?.spawn_context ?? "";
      R("M2.ctx-declara-shared-checkout", ctx.includes("SHARED checkout directory"), ctx.slice(0, 120));
      R("M2.ctx-orienta-handover", ctx.includes("Coordinate via team_message and team_task_handover before touching the same files"), "");
      R("M2.ctx-sem-branch-isolada", !ctx.includes("own worktree") && !ctx.includes("isolated worktree") && !ctx.includes("Your changes are isolated"), "");
    } catch (e) {
      R("M2.cenario-executavel", false, e?.stack ?? String(e));
    } finally {
      cleanup(base, db);
    }
  }

  // M3 — prompt real de promptAsync declara diretório compartilhado (não-standby)
  {
    const base = mkScratch("m3");
    const db = mod.createDb(path.join(base, "e.db"));
    const { calls, client } = makeClient();
    const deps = makeDeps(mod, { db, directory: base, client });
    const TEAM = "T78M3", LEAD = "ses_lead_78m3";
    try {
      seedProjectAndTeam(db, { teamId: TEAM, lead: LEAD });
      await mod.executeTeamSpawn(
        deps,
        { name: "impl", agent: "build", prompt: "escrever o teste do HARNESS-78", worktree: true, standby: false },
        LEAD,
      );
      await new Promise((r) => setImmediate(r));
      R("M3.promptAsync-disparado", calls.promptAsync.length === 1, `prompts=${calls.promptAsync.length}`);
      const text = calls.promptAsync[0]?.parts?.map((p) => p.text).join("\n") ?? "";
      R("M3.prompt-declara-shared-checkout", text.includes("SHARED checkout directory"), text.slice(0, 160));
      R("M3.prompt-orienta-handover", text.includes("Coordinate via team_message and team_task_handover before touching the same files"), "");
      R("M3.prompt-sem-worktree-isolada", !text.includes("own worktree") && !text.includes("isolated worktree") && !text.includes("Your changes are isolated"), "");
      R("M3.prompt-sem-commit-manual", !text.includes('Commit your changes: git add -A && git commit'), "");
      R("M3.prompt-anti-early-commit", text.includes("do NOT commit git changes directly"), "");
    } catch (e) {
      R("M3.cenario-executavel", false, e?.stack ?? String(e));
    } finally {
      cleanup(base, db);
    }
  }

  // M7 — read-only (explore) também nasce sem worktree; permissões deny preservadas
  {
    const base = mkScratch("m7");
    const db = mod.createDb(path.join(base, "e.db"));
    const { calls, client } = makeClient();
    const deps = makeDeps(mod, { db, directory: base, client });
    const TEAM = "T78M7", LEAD = "ses_lead_78m7";
    try {
      seedProjectAndTeam(db, { teamId: TEAM, lead: LEAD });
      await mod.executeTeamSpawn(
        deps,
        { name: "explorer", agent: "explore", prompt: "mapear o spawn", worktree: true, standby: true },
        LEAD,
      );
      R("M7.worktree-create-zero", calls.worktreeCreate.length === 0, `calls=${calls.worktreeCreate.length}`);
      R("M7.workspace-create-zero", calls.workspaceCreate.length === 0, `calls=${calls.workspaceCreate.length}`);
      const row = memberRow(db, TEAM, "explorer");
      R("M7.worktree-dir-null", row?.worktree_dir === null, String(row?.worktree_dir));
      const perm = calls.sessionCreate[0]?.permission ?? [];
      const denyEdit = perm.some((p) => p.permission === "edit" && p.action === "deny");
      const denyBash = perm.some((p) => p.permission === "bash" && p.action === "deny");
      R("M7.read-only-deny-edit-bash", denyEdit && denyBash, JSON.stringify(perm.filter((p) => p.action === "deny")));
      const worktreeAllow = perm.some((p) => typeof p.pattern === "string" && p.pattern.includes("/opencode/worktree/"));
      R("M7.sem-allow-worktree-path", !worktreeAllow, "");
    } catch (e) {
      R("M7.cenario-executavel", false, e?.stack ?? String(e));
    } finally {
      cleanup(base, db);
    }
  }

  // M5 — schema V1 (src/index.ts) e V2 (src/v2-tools.ts + runtime): worktree
  //      mantido para retrocompat com descrição [DEPRECATED - IGNORED].
  //      NOTA: M5/M6 dependem do SRC/DIST estático, não do módulo `mod` —
  //      são sempre assertados contra o baseline real (o mutante não altera src).
  {
    const spawn = await (async () => {
      const captured = [];
      const domain = { transform: async (cb) => { cb({ add: (def) => captured.push(def) }); return { dispose: async () => {} }; } };
      await mod.registerV2Tools(domain, {});
      return captured.find((d) => d?.name === "team_spawn");
    })();
    R("M5.v2-spawn-registrado", !!spawn, "");
    const wt = spawn?.input?.properties?.worktree;
    R("M5.v2-worktree-prop-presente", !!wt && wt.type === "boolean", JSON.stringify(wt?.type));
    R("M5.v2-worktree-default-true", wt?.default === true, String(wt?.default));
    R("M5.v2-worktree-desc-deprecated", typeof wt?.description === "string" && wt.description.includes("DEPRECATED - IGNORED"), wt?.description?.slice(0, 80));
    R("M5.v2-additionalProperties-false", spawn?.input?.additionalProperties === false, String(spawn?.input?.additionalProperties));
    R("M5.v2-required-name-prompt", JSON.stringify(spawn?.input?.required) === JSON.stringify(["name", "prompt"]), JSON.stringify(spawn?.input?.required));
  }

  return got;
}

// --- Baseline: roda os cenários contra o dist REAL e materializa os checks ---
const baseline = await runScenarios(REAL);
for (const [name, { ok, detail }] of baseline) check(name, ok, detail);

// ===========================================================================
// M6 — marcadores estruturais src↔dist: helper legado removido, nenhum
//      call site de worktree.create no arquivo de spawn, colunas preservadas.
//      (Assertados direto contra src/dist — independentes do módulo.)
// ===========================================================================
{
  check("M6.src-sem-isWorktreeDirectory", !srcSpawn.includes("isWorktreeDirectory"), "");
  check("M6.src-sem-worktree-create", !srcSpawn.includes("worktree.create"), "");
  check("M6.src-sem-workspace-create", !srcSpawn.includes("workspace.create"), "");
  check("M6.src-hardcodes-null", srcSpawn.includes("const worktreeDir: string | null = null") && srcSpawn.includes("const worktreeBranch: string | null = null"), "");
  check("M6.src-colunas-preservadas-no-insert", srcSpawn.includes("worktree_dir, worktree_branch, workspace_id"), "");
  check("M6.src-v1-bloco-spawn-localizado", srcIndex.includes("team_spawn: tool({"), "");
  check("M6.dist-sem-worktree-create-spawn", !distRaw.includes("worktree.create for"), "");
  check("M6.dist-cita-shared-checkout", distRaw.includes("shared-checkout"), "");
  check("M6.dist-cita-harness-78", distRaw.includes("TICKET-HARNESS-78"), "");
  check("M6.dist-mantem-marcador-deprecated", distRaw.includes("DEPRECATED - IGNORED"), "");
  check("M6.schema-colunas-mantidas", /worktree_dir/.test(srcIndex) || /worktree_dir/.test(distRaw), "");
}

// ===========================================================================
// M5 extra — bloco V1 no src/index.ts (paridade textual com V2)
// ===========================================================================
{
  const v1Start = srcIndex.indexOf("team_spawn: tool({");
  const v1End = srcIndex.indexOf("team_message: tool({", v1Start);
  const v1Block = v1Start >= 0 && v1End > v1Start ? srcIndex.slice(v1Start, v1End) : "";
  check("M5.v1-worktree-prop-presente", /worktree:\s*tool\.schema\.boolean\(\)\.default\(true\)/.test(v1Block), "");
  check("M5.v1-worktree-desc-deprecated", v1Block.includes("[DEPRECATED - IGNORED]"), "");
  check("M5.v1-desc-cita-harness-78", v1Block.includes("TICKET-HARNESS-78"), "");
  check("M5.v2-bloco-spawn-localizado", srcV2.includes('name: "team_spawn"'), "");
}

// ===========================================================================
// M8 — Integridade das SKILLS atualizadas pelo ticket (TICKET-HARNESS-78).
// As skills vivem em ~/.config/opencode/skills (fora do repo). O bloco é
// APLICÁVEL quando o diretório existe e assere o contrato entregue:
//   - board-handover: worktrees individuais descontinuadas, Buffer de Complete
//     canônico do checkout compartilhado amparado pelo ledger particionado
//     (TICKET-HARNESS-82);
//   - orchestration: flag `worktree` deprecada/ignorada, checkout único;
//   - nenhuma das duas recomenda `worktree: true|false` (receita morta).
// Sem o diretório de config (CI limpo), o bloco é declarado N/A — nunca um
// falso verde silencioso.
// ===========================================================================
{
  const skillsDir = path.join(os.homedir(), ".config", "opencode", "skills");
  const handoverSkill = path.join(skillsDir, "ensemble-board-handover", "SKILL.md");
  const orchestrationSkill = path.join(skillsDir, "ensemble-orchestration", "SKILL.md");
  if (!existsSync(handoverSkill) || !existsSync(orchestrationSkill)) {
    check("M8.skills-n/a-ambiente-sem-config-opencode", true, skillsDir);
  } else {
    const handover = readFileSync(handoverSkill, "utf8");
    const orchestration = readFileSync(orchestrationSkill, "utf8");
    check(
      "M8.handover-descontinua-worktrees",
      /worktrees individuais por especialista foram descontinuad/i.test(handover),
      "",
    );
    check("M8.handover-sem-paragrafo-worktrees-isoladas", !/Em Worktrees Isoladas/i.test(handover), "");
    check(
      "M8.handover-buffer-de-complete-canonico",
      handover.includes("Buffer de Complete") && handover.includes("checkout compartilhado"),
      "",
    );
    check(
      "M8.handover-amparado-pelo-ledger-82",
      handover.includes("TICKET-HARNESS-82") && handover.includes("autoCommitApprovedTask"),
      "",
    );
    check("M8.orchestration-declara-harness-78", orchestration.includes("TICKET-HARNESS-78"), "");
    check(
      "M8.orchestration-flag-worktree-deprecada",
      /flag `worktree`[^\n]{0,40}deprecad/i.test(orchestration),
      "",
    );
    check(
      "M8.skills-sem-receita-de-worktree",
      !/worktree:\s*(true|false)/.test(`${handover}\n${orchestration}`),
      "",
    );
  }
}

// ===========================================================================
// MUTAÇÃO — 4 mutantes cirúrgicos EXECUTADOS contra um dist MUTADO real.
// Cada mutante deve FALHAR as sentinelas listadas em `detect`.
// ===========================================================================
const MUTATIONS = [
  {
    id: "mut1",
    desc: "restaurar worktreeDir não-nulo no spawn (colapsar shared-checkout)",
    from: "const worktreeDir = null",
    to: 'const worktreeDir = "/tmp/rogue"',
    detect: ["M1.worktree-dir-null", "M2.worktree-dir-null", "M7.worktree-dir-null"],
  },
  {
    id: "mut2",
    desc: "remover a orientação de handover do prompt",
    from: "All teammates edit the same working tree. Coordinate via team_message and team_task_handover before touching the same files.",
    to: "All teammates edit the same working tree.",
    detect: ["M2.ctx-orienta-handover", "M3.prompt-orienta-handover"],
  },
  {
    id: "mut3",
    desc: "reverter a mensagem de fechamento para commit manual em worktree",
    // No dist o em-dash é serializado como a sequência literal de 6 caracteres (escape JS de U+2014).
    from: "1. In shared checkout mode (TICKET-HARNESS-78 \\u2014 the only mode), do NOT commit git changes directly (keep changes unstaged for inspection and anti-early-commit governance). The runtime commits the shared workspace LOCALLY and automatically the moment the Quality Gate reviewer approves your card via team_tasks_complete(action: 'complete') \\u2014 no manual git commit is needed. Pushing stays reserved for the pre-push batch gate.",
    to: "1. Commit your changes: git add -A && git commit -m 'your summary'",
    detect: ["M3.prompt-sem-commit-manual", "M3.prompt-anti-early-commit"],
  },
  {
    id: "mut4",
    desc: "reverter o marcador deprecado para o antigo texto de worktree isolation",
    from: "[DEPRECATED - IGNORED] Individual git worktrees per specialist are discontinued (TICKET-HARNESS-78). Every teammate operates in the shared checkout directory. Kept for backward compatibility only.",
    to: "Create a git worktree for file isolation (default: true, set false for read-only agents)",
    // split().join() substitui TODAS as ocorrências (V1 + V2) — comportamento desejado.
    multi: true,
    detect: ["M5.v2-worktree-desc-deprecated"],
  },
];

for (const m of MUTATIONS) {
  const occurrences = distRaw.split(m.from).length - 1;
  const minOk = m.multi ? occurrences >= 1 : occurrences === 1;
  check(`mut.${m.id}.patch-aplicavel`, minOk, `ocorrências=${occurrences}${m.multi ? " (multi)" : ""}`);
  if (!minOk) continue;

  const mutantFile = path.join(TMP, `_h78_${m.id}.mjs`);
  writeFileSync(mutantFile, buildHarnessCode(distRaw.split(m.from).join(m.to)));
  let mutatedFlow;
  try {
    const mutantMod = await import(mutantFile);
    mutatedFlow = await runScenarios(mutantMod);
  } catch (err) {
    check(`mut.${m.id}.mutante-executavel`, false, String(err));
    continue;
  }
  check(`mut.${m.id}.mutante-executavel`, mutatedFlow.size > 0, `checks=${mutatedFlow.size}`);

  const missed = m.detect.filter((n) => mutatedFlow.get(n)?.ok !== false);
  check(
    `mut.${m.id}.deteccao [${m.desc}]`,
    missed.length === 0,
    missed.length ? `NÃO detectaram: ${missed.join(", ")}` : `${m.detect.length}/${m.detect.length} sentinelas falharam no mutante`,
  );

  // Cirurgia: os checks NÃO listados em `detect` devem permanecer verdes no mutante.
  const unaffectedNames = [...mutatedFlow.keys()].filter((n) => !m.detect.includes(n));
  const broken = unaffectedNames.filter((n) => mutatedFlow.get(n)?.ok !== baseline.get(n)?.ok);
  check(
    `mut.${m.id}.cirurgico-fluxos-intactos`,
    broken.length === 0,
    broken.length ? `quebrou: ${broken.join(", ")}` : `${unaffectedNames.length}/${unaffectedNames.length} verdes preservados`,
  );
}

// ===========================================================================
// Veredito
// ===========================================================================
const passed = results.filter(([, ok]) => ok).length;
const failed = results.filter(([, ok]) => !ok).length;
console.log("------------------------------------------------------------------------------");
console.log(`RESULT: ${passed}/${results.length} checks passed${failed ? `, ${failed} FAILED` : ""}`);
if (unhandled.length) {
  console.log(`UNHANDLED REJECTIONS: ${unhandled.length}`);
  for (const e of unhandled) console.log(`  - ${e?.message ?? e}`);
}
process.exit(failed === 0 && unhandled.length === 0 ? 0 : 1);
