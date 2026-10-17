#!/usr/bin/env node
/**
 * QUALITY GATE DETERMINÍSTICO — Integração do SDET/Hugo, Standby por Default,
 * Trava de Exclusividade SDET e Paridade Estrita de Schemas V1↔V2
 * @maiteuxzanela/ensemble-room-lowcost (TICKET-HARNESS / TASK Hugo-SDET)
 *
 * Engenheiro de Testes (SDET): Hugo. Guardiã do Quality Gate: Clara.
 *
 * Sob teste (src/ e dist/ REAIS, SQLite real via node:sqlite — SEM MOCKS):
 *   - executeTeamSpawn  -> src/tools/team-spawn.ts
 *   - executeTeamCreate -> src/tools/team-create.ts
 *   - registerV2Tools   -> src/v2-tools.ts
 *   - resolveBasePersona / validateMemberName -> src/util.ts
 *
 * Cobertura (card T3):
 *   (1) Spawn do Hugo SEM `standby: false` -> nasce em standby
 *       (status 'ready' / execution_status 'standby'), zero promptAsync. Cobre
 *       detecção por nome base ("hugo"), por nome multi-instância
 *       ("hugo-sdet" -> base "hugo") e por agent type explícito ("hugo").
 *   (2) Spawn do Hugo COM `standby: false` -> nasce ativo
 *       (status 'busy' / execution_status 'starting'), promptAsync disparado.
 *   (3) Trava de exclusividade SDET fail-fast: um 2º SDET (por nome base,
 *       nome multi-instância OU agent type) é rejeitado com a mensagem EXATA,
 *       sem sessão e sem linha no SQLite; liberada quando o original vai para
 *       'shutdown'. Controle negativo: não-SDET default NÃO é auto-standby.
 *   (4) Retorno orientador de executeTeamCreate menciona o squad canônico
 *       (Implementador, Hugo e Clara).
 *   (5) Schemas V2 de team_create/team_spawn: descrições atualizadas +
 *       additionalProperties:false + propriedades/required exatos.
 *   (6) Paridade estrita V1 (src/index.ts Zod / bundle) ↔ V2
 *       (src/v2-tools.ts JSON Schema / registerV2Tools runtime).
 *   (7) Anti-mock: zero mocks em produção sob src/ e zero mocks proibidos na suíte.
 *
 * SEM MOCKS estruturais: roda contra dist/index.js REAL (bundle esbuild) e SQLite
 * real. O único seam é o cliente SDK do OpenCode (boundary externo), reduzido ao
 * mínimo (session.create/promptAsync/abort) — idêntico às demais suítes do repo.
 *
 * Uso: node tests/test_hugo_sdet_integration.mjs
 * Exit: 0 = todos os checks PASS; 1 = há FAIL.
 */

import { mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";

const REPO = path.resolve(import.meta.dirname, "..");
const PKG = process.env.ENSEMBLE_PKG || REPO;
const DIST = path.join(PKG, "dist/index.js");
const TMP = path.join(REPO, ".test-scratch");
mkdirSync(TMP, { recursive: true });
const HARNESS = path.join(TMP, "_hugo_sdet_harness.mjs");
const ROOT = path.join(TMP, "hugo_sdet_suite");
const SRC = path.join(REPO, "src");
const INDEX_SRC = path.join(SRC, "index.ts");
const V2_SRC = path.join(SRC, "v2-tools.ts");

const TEAM_A = { name: "thsquad", lead: "ses_lead_hugo_a" };
const TEAM_B = { name: "thactive", lead: "ses_lead_hugo_b" };
const TEAM_C = { name: "thmulti", lead: "ses_lead_hugo_c" };

const SQUAD_MARKER = "Implementador, Hugo (deterministic tests) and Clara (Quality Gate)";
const DISPATCH_MARKER =
  "Dispatch Hugo for deterministic tests (born in standby by default) and Clara for the Quality Gate.";
const SDET_MSG = (team, name = "hugo") =>
  `Engenheiro de Testes '${name}' já está ativo na equipe '${team}'. Papéis de engenharia de testes são exclusivos e não admitem instâncias concorrentes.`;

const V2_SPAWN_KEYS = [
  "agent", "claim_task", "is_qa", "model", "name", "plan_approval",
  "prompt", "role", "standby", "worktree",
];

const results = [];
const check = (name, ok, detail) => {
  results.push([name, ok]);
  console.log(`${ok ? "PASS" : "FAIL"} | ${name}${detail ? " | " + detail : ""}`);
};
const countOf = (hay, needle) => hay.split(needle).length - 1;

const unhandled = [];
process.on("unhandledRejection", (e) => unhandled.push(e));

// ---------------------------------------------------------------------------
// 0. Harness: dist real + exportação dos símbolos sob teste (sem mocks).
// ---------------------------------------------------------------------------
const REQUIRED_SYMBOLS = [
  "createDb", "executeTeamCreate", "executeTeamSpawn", "registerV2Tools",
  "resolveBasePersona", "validateMemberName", "DEFAULT_CONFIG",
  "MemberRegistry", "ProgressTracker",
];
const distRaw = readFileSync(DIST, "utf8");
const indexRaw = readFileSync(INDEX_SRC, "utf8");
const v2Raw = readFileSync(V2_SRC, "utf8");

{
  const missing = REQUIRED_SYMBOLS.filter(
    (s) => !new RegExp(`(function|class|var|const|let)\\s+${s}\\b`).test(distRaw),
  );
  check(
    "dist declara todos os símbolos exigidos",
    missing.length === 0,
    missing.join(",") || `${REQUIRED_SYMBOLS.length} símbolos`,
  );
  const existingExport = distRaw.match(/export\s*\{([^}]*)\}\s*;?\s*$/)?.[1] ?? "";
  const already = new Set(
    existingExport.split(",").map((s) => s.trim().split(/\s+as\s+/).pop()).filter(Boolean),
  );
  const need = REQUIRED_SYMBOLS.filter((s) => !already.has(s));
  const EXPORT_APPEND = need.length ? `\nexport { ${need.join(", ")} };\n` : "";
  writeFileSync(HARNESS, distRaw + EXPORT_APPEND);
}

const {
  createDb, executeTeamCreate, executeTeamSpawn, registerV2Tools,
  DEFAULT_CONFIG, resolveBasePersona, MemberRegistry, ProgressTracker,
} = await import(HARNESS);

// ---------------------------------------------------------------------------
// 1. Marcadores estruturais no dist (bundle esbuild escapa não-ASCII).
// ---------------------------------------------------------------------------
check(
  "dist contém a trava de exclusividade SDET do Hugo",
  distRaw.includes("Engenheiro de Testes '${existingSDET.name}' j") &&
    distRaw.includes("testes s\\xE3o exclusivos"),
  "template interpolado presente",
);
check(
  "dist interpola o nome real da equipe na trava SDET",
  distRaw.includes(`'${"${teamInfo.teamName}"}'. Pap`),
);
check(
  "dist contém o auto-standby default do Hugo (log hugo_sdet_default)",
  distRaw.includes("hugo sdet default standby") && distRaw.includes("hugo_sdet_default"),
);
check("dist normaliza base persona via split(/[-_]/)", /split\(\/\[-_\]\/\)/.test(distRaw));
check(
  "dist contém as descrições canônicas do squad nas DUAS camadas (V1+V2)",
  countOf(distRaw, SQUAD_MARKER) === 2 && countOf(distRaw, DISPATCH_MARKER) === 2,
  `squad=${countOf(distRaw, SQUAD_MARKER)} dispatch=${countOf(distRaw, DISPATCH_MARKER)}`,
);
check(
  "dist preserva additionalProperties: false nos JSON Schemas V2",
  distRaw.includes("additionalProperties: false"),
);

// ---------------------------------------------------------------------------
// 2. Seam mínimo do cliente SDK do OpenCode (boundary externo — sem mocks de
//    produção; código sob src/ permanece 100% livre de mocks).
// ---------------------------------------------------------------------------
function stubClient() {
  const calls = { create: [], promptAsync: [] };
  let n = 0;
  return {
    calls,
    client: {
      session: {
        create: async (o) => {
          calls.create.push(o);
          return { data: { id: `ses_child_${++n}` } };
        },
        promptAsync: async (o) => {
          calls.promptAsync.push(o);
          return {};
        },
        abort: async () => ({}),
      },
      tui: { showToast: async () => ({}) },
    },
  };
}

const spawnArgs = (over) => ({ name: "x", agent: "build", prompt: "Trabalhar.", worktree: false, ...over });
async function trySpawn(deps, lead, args) {
  try {
    return { ok: true, res: await executeTeamSpawn(deps, args, lead), err: null };
  } catch (e) {
    return { ok: false, res: null, err: e instanceof Error ? e.message : String(e) };
  }
}

async function runSuite() {
  rmSync(ROOT, { recursive: true, force: true });
  mkdirSync(ROOT, { recursive: true });
  const db = createDb(path.join(ROOT, "ensemble.db"));
  const registry = new MemberRegistry();
  const mc = stubClient();
  const deps = {
    db,
    directory: ROOT,
    client: mc.client,
    registry,
    config: { ...DEFAULT_CONFIG },
    progressTracker: new ProgressTracker(),
  };

  const member = (teamId, name) =>
    db.query("SELECT * FROM team_member WHERE team_id = ? AND name = ?").get(teamId, name);

  // -------------------------------------------------------------------------
  // 3. Contrato unitário do resolvedor de persona base
  // -------------------------------------------------------------------------
  check('resolveBasePersona("hugo") === "hugo"', resolveBasePersona("hugo") === "hugo");
  check('resolveBasePersona("hugo-sdet") === "hugo"', resolveBasePersona("hugo-sdet") === "hugo");
  check('resolveBasePersona("hugo_sdet") === "hugo"', resolveBasePersona("hugo_sdet") === "hugo");
  check('resolveBasePersona("hugo_2") === "hugo"', resolveBasePersona("hugo_2") === "hugo");

  // -------------------------------------------------------------------------
  // 4. Criação das equipes via executeTeamCreate + retorno orientador (squad)
  // -------------------------------------------------------------------------
  const createdA = await executeTeamCreate(deps, { name: TEAM_A.name }, TEAM_A.lead);
  const createdB = await executeTeamCreate(deps, { name: TEAM_B.name }, TEAM_B.lead);
  const createdC = await executeTeamCreate(deps, { name: TEAM_C.name }, TEAM_C.lead);
  const teamA = db.query("SELECT id FROM team WHERE name = ? AND status = 'active'").get(TEAM_A.name);
  const teamB = db.query("SELECT id FROM team WHERE name = ? AND status = 'active'").get(TEAM_B.name);
  const teamC = db.query("SELECT id FROM team WHERE name = ? AND status = 'active'").get(TEAM_C.name);
  check(
    "executeTeamCreate registra as 3 equipes ativas no SQLite",
    !!teamA && !!teamB && !!teamC &&
      typeof createdA === "string" && typeof createdB === "string" && typeof createdC === "string",
  );
  const A = teamA.id;
  const B = teamB.id;
  const C = teamC.id;
  check(
    "Retorno de team_create menciona o squad canônico (Implementador, Hugo, Clara)",
    createdC.includes("Implementador") && createdC.includes("Hugo") && createdC.includes("Clara"),
    createdC.slice(0, 80) + "…",
  );
  check(
    "Retorno de team_create orienta o squad via team_spawn",
    createdC.includes("squad can") && createdC.includes("via team_spawn"),
  );

  // =====================================================================
  // (1) Hugo SEM standby:false -> nasce em standby (equipe A)
  // =====================================================================
  const pBeforeA1 = mc.calls.promptAsync.length;
  const sBeforeA1 = mc.calls.create.length;
  const a1 = await trySpawn(deps, TEAM_A.lead, spawnArgs({ name: "hugo", prompt: "Desenhar suíte determinística." }));
  check("(1) spawn de 'hugo' sem standby:false conclui", a1.ok && typeof a1.res === "string", a1.err ?? "");
  check(
    "(1) retorno declara auto-standby 'hugo sdet default standby'",
    a1.ok && a1.res.includes("(auto-standby: hugo sdet default standby)"),
    a1.res ?? a1.err,
  );
  const mHugoA = member(A, "hugo");
  check(
    "(1) 'hugo' nasce ready/standby",
    !!mHugoA && mHugoA.status === "ready" && mHugoA.execution_status === "standby",
    mHugoA ? `${mHugoA.status}/${mHugoA.execution_status}` : "ausente",
  );
  check(
    "(1) 'hugo' criou a sessão e persistiu spawn_context com o prompt",
    mc.calls.create.length === sBeforeA1 + 1 &&
      typeof mHugoA?.spawn_context === "string" &&
      mHugoA.spawn_context.includes("Desenhar suíte determinística."),
  );
  check(
    "(1) 'hugo' consome ZERO tokens ao nascer (zero promptAsync)",
    mc.calls.promptAsync.length === pBeforeA1,
    `delta=${mc.calls.promptAsync.length - pBeforeA1}`,
  );
  check("(1) 'hugo' recebe is_qa = 0 (não é Quality Gate)", mHugoA?.is_qa === 0, `is_qa=${mHugoA?.is_qa}`);

  // =====================================================================
  // (3) Trava de exclusividade SDET enquanto o Hugo está ATIVO (equipe A)
  // =====================================================================
  const pBeforeLock = mc.calls.promptAsync.length;
  const sBeforeLock = mc.calls.create.length;

  const a2 = await trySpawn(deps, TEAM_A.lead, spawnArgs({ name: "hugo-2", prompt: "Segundo SDET." }));
  check(
    "(3) 2º SDET por nome multi-instância ('hugo-2') rejeitado com mensagem EXATA",
    !a2.ok && a2.err === SDET_MSG(TEAM_A.name),
    a2.err ?? "sem erro",
  );
  const a3 = await trySpawn(deps, TEAM_A.lead, spawnArgs({ name: "sdet-x", agent: "hugo" }));
  check(
    "(3) 2º SDET por agent type ('hugo') rejeitado com mensagem EXATA",
    !a3.ok && a3.err === SDET_MSG(TEAM_A.name),
    a3.err ?? "sem erro",
  );
  check(
    "(3) mensagens explicitam a exclusividade do papel de testes",
    (a2.err ?? "").includes("não admitem instâncias concorrentes") &&
      (a3.err ?? "").includes("não admitem instâncias concorrentes"),
  );
  const ghost = db
    .query("SELECT name FROM team_member WHERE team_id = ? AND name IN ('hugo-2','sdet-x')")
    .all(A);
  check("(3) SDETs bloqueados não registram membro no SQLite", ghost.length === 0);
  check(
    "(3) SDETs bloqueados não criam sessão (fail-fast antes de session.create)",
    mc.calls.create.length === sBeforeLock,
    `delta=${mc.calls.create.length - sBeforeLock}`,
  );
  check(
    "(3) SDETs bloqueados não disparam promptAsync",
    mc.calls.promptAsync.length === pBeforeLock,
    `delta=${mc.calls.promptAsync.length - pBeforeLock}`,
  );

  // Circuit breaker intacto após os bloqueios
  const worker = await trySpawn(deps, TEAM_A.lead, spawnArgs({ name: "worker", prompt: "Frente de implementação.", standby: true }));
  check(
    "(3) spawn legítimo após bloqueios segue operacional (sem trip do circuit breaker)",
    worker.ok && !!member(A, "worker"),
  );

  // Liberação da trava: original em 'shutdown' -> sucessor nasce (standby default)
  db.run("UPDATE team_member SET status = 'shutdown', time_updated = ? WHERE team_id = ? AND name = 'hugo'", [Date.now(), A]);
  const a4 = await trySpawn(deps, TEAM_A.lead, spawnArgs({ name: "hugo-2", prompt: "SDET sucessor." }));
  check(
    "(3) com o Hugo original em 'shutdown', o sucessor nasce sem erro",
    a4.ok && !!member(A, "hugo-2"),
  );
  check(
    "(1) sucessor multi-instância 'hugo-2' também nasce ready/standby por default",
    member(A, "hugo-2")?.execution_status === "standby" && member(A, "hugo-2")?.status === "ready",
    member(A, "hugo-2") ? `${member(A, "hugo-2").status}/${member(A, "hugo-2").execution_status}` : "ausente",
  );

  // =====================================================================
  // (2) Hugo COM standby:false -> nasce ativo (equipe B, isolada)
  // =====================================================================
  const pBeforeB = mc.calls.promptAsync.length;
  const b5 = await trySpawn(deps, TEAM_B.lead, spawnArgs({ name: "hugo", prompt: "Começar imediatamente.", standby: false }));
  const mB5 = member(B, "hugo");
  check("(2) spawn de 'hugo' com standby:false conclui", b5.ok, b5.err ?? "");
  check(
    "(2) retorno não declara auto-standby/standby",
    b5.ok && !b5.res.includes("auto-standby") && !b5.res.includes("[standby"),
    b5.res ?? b5.err,
  );
  check(
    "(2) 'hugo' com standby:false nasce busy/starting",
    !!mB5 && mB5.status === "busy" && mB5.execution_status === "starting",
    mB5 ? `${mB5.status}/${mB5.execution_status}` : "ausente",
  );
  check(
    "(2) 'hugo' com standby:false NÃO grava spawn_context",
    !!mB5 && (mB5.spawn_context === null || mB5.spawn_context === undefined),
  );
  check(
    "(2) 'hugo' com standby:false dispara promptAsync imediatamente",
    mc.calls.promptAsync.length === pBeforeB + 1,
    `delta=${mc.calls.promptAsync.length - pBeforeB}`,
  );

  // =====================================================================
  // (1) + controle negativo (equipe C)
  // =====================================================================
  // Detecção por nome base multi-instância ("hugo-sdet" -> "hugo")
  const c1 = await trySpawn(deps, TEAM_C.lead, spawnArgs({ name: "hugo-sdet", prompt: "Suíte multi-instância." }));
  check(
    "(1) 'hugo-sdet' (multi-instância) nasce standby por default",
    c1.ok && c1.res.includes("(auto-standby: hugo sdet default standby)"),
    c1.res ?? c1.err,
  );
  const mSdet = member(C, "hugo-sdet");
  check(
    "(1) 'hugo-sdet' nasce ready/standby com spawn_context",
    !!mSdet && mSdet.status === "ready" && mSdet.execution_status === "standby" &&
      typeof mSdet.spawn_context === "string",
    mSdet ? `${mSdet.status}/${mSdet.execution_status}` : "ausente",
  );
  const c2 = await trySpawn(deps, TEAM_C.lead, spawnArgs({ name: "sdet-runner2", agent: "hugo" }));
  check(
    "(3) existente 'hugo-sdet' (agent build) bloqueia entrante por base persona",
    !c2.ok && c2.err === SDET_MSG(TEAM_C.name, "hugo-sdet"),
    c2.err ?? "sem erro",
  );

  // Controle negativo: não-SDET default NÃO herda o auto-standby
  const pBeforeImpl = mc.calls.promptAsync.length;
  const impl = await trySpawn(deps, TEAM_C.lead, spawnArgs({ name: "impl", prompt: "Implementar." }));
  const mImpl = member(C, "impl");
  check(
    "(3) controle: não-SDET default NÃO é auto-standby (busy/starting)",
    impl.ok && !!mImpl && mImpl.status === "busy" && mImpl.execution_status === "starting" &&
      !impl.res.includes("auto-standby"),
    mImpl ? `${mImpl.status}/${mImpl.execution_status}` : "ausente",
  );
  check(
    "(3) controle: não-SDET dispara promptAsync imediatamente",
    mc.calls.promptAsync.length === pBeforeImpl + 1,
    `delta=${mc.calls.promptAsync.length - pBeforeImpl}`,
  );

  // Detecção positiva por agent type explícito ('hugo'), após liberar a trava
  db.run("UPDATE team_member SET status = 'shutdown', time_updated = ? WHERE team_id = ? AND name = 'hugo-sdet'", [Date.now(), C]);
  const c3 = await trySpawn(deps, TEAM_C.lead, spawnArgs({ name: "sdet-runner3", agent: "hugo", prompt: "Suíte por agent type." }));
  check(
    "(1) SDET por agent type explícito ('hugo') nasce standby por default",
    c3.ok && c3.res.includes("(auto-standby: hugo sdet default standby)"),
    c3.res ?? c3.err,
  );
  check(
    "(1) SDET por agent type nasce ready/standby",
    member(C, "sdet-runner3")?.execution_status === "standby" && member(C, "sdet-runner3")?.status === "ready",
    member(C, "sdet-runner3") ? `${member(C, "sdet-runner3").status}/${member(C, "sdet-runner3").execution_status}` : "ausente",
  );

  // =====================================================================
  // (5) Schemas V2 em runtime (registerV2Tools)
  // =====================================================================
  const captured = [];
  await registerV2Tools(
    {
      transform: async (cb) => {
        cb({ add: (d) => captured.push(d) });
        return { dispose: async () => ({}) };
      },
    },
    deps,
  );
  const v2Create = captured.find((t) => t.name === "team_create");
  const v2Spawn = captured.find((t) => t.name === "team_spawn");
  check("(5) registerV2Tools registra team_create e team_spawn (V2)", !!v2Create && !!v2Spawn);
  check("(5) V2 team_create.description convoca o squad canônico", v2Create?.description.includes(SQUAD_MARKER));
  check("(5) V2 team_spawn.description despacha Hugo (standby default) e Clara", v2Spawn?.description.includes(DISPATCH_MARKER));
  const keysOf = (def) => Object.keys(def.input.properties).sort();
  check(
    "(5) V2 team_create: additionalProperties:false, required [name], props [name, project_name]",
    v2Create?.input.additionalProperties === false &&
      JSON.stringify(v2Create.input.required) === JSON.stringify(["name"]) &&
      JSON.stringify(keysOf(v2Create)) === JSON.stringify(["name", "project_name"]),
    JSON.stringify(v2Create?.input.required),
  );
  check(
    "(5) V2 team_spawn: additionalProperties:false, required [name,prompt], props exatas",
    v2Spawn?.input.additionalProperties === false &&
      JSON.stringify(v2Spawn.input.required) === JSON.stringify(["name", "prompt"]) &&
      JSON.stringify(keysOf(v2Spawn)) === JSON.stringify(V2_SPAWN_KEYS),
    JSON.stringify(keysOf(v2Spawn)),
  );
  check(
    "(5) V2 team_spawn.standby documenta o nascimento em standby (zero tokens)",
    v2Spawn?.input.properties.standby?.description?.includes("zero tokens at birth") === true,
  );
  check("(5) V2 team_create NÃO expõe a propriedade standby", v2Create?.input.properties.standby === undefined);

  // =====================================================================
  // (6) Paridade estrita V1 (src/index.ts / bundle) ↔ V2 (src/v2-tools.ts)
  // =====================================================================
  const sliceBetween = (src, start, end) => {
    const i = src.indexOf(start);
    if (i < 0) return null;
    const j = src.indexOf(end, i + start.length);
    return src.slice(i, j < 0 ? src.length : j);
  };
  const v1CreateSrc = sliceBetween(indexRaw, "team_create: tool({", "team_spawn: tool({");
  const v1SpawnSrc = sliceBetween(indexRaw, "team_spawn: tool({", "team_message: tool({");
  const v2CreateSrc = sliceBetween(v2Raw, 'name: "team_create"', 'name: "team_spawn"');
  const v2SpawnSrc = sliceBetween(v2Raw, 'name: "team_spawn"', 'name: "team_message"');
  check(
    "(6) blocos V1 e V2 de team_create/team_spawn localizados no src",
    !!v1CreateSrc && !!v1SpawnSrc && !!v2CreateSrc && !!v2SpawnSrc,
  );
  const v1Keys = (blk) => [...blk.matchAll(/^ {10}([a-z_]+): tool\.schema/gm)].map((m) => m[1]).sort();
  const v2SrcKeys = (blk) => [...blk.matchAll(/^ {10}([a-z_]+): /gm)].map((m) => m[1]).sort();
  check(
    "(6) paridade V1↔V2 (props) de team_create",
    JSON.stringify(v1Keys(v1CreateSrc)) === JSON.stringify(v2SrcKeys(v2CreateSrc)),
    `v1=${JSON.stringify(v1Keys(v1CreateSrc))} v2=${JSON.stringify(v2SrcKeys(v2CreateSrc))}`,
  );
  check(
    "(6) paridade V1↔V2 (props) de team_spawn",
    JSON.stringify(v1Keys(v1SpawnSrc)) === JSON.stringify(v2SrcKeys(v2SpawnSrc)) &&
      JSON.stringify(v1Keys(v1SpawnSrc)) === JSON.stringify(V2_SPAWN_KEYS),
    `v1=${JSON.stringify(v1Keys(v1SpawnSrc))}`,
  );
  check(
    "(6) runtime dist mantém props de team_spawn idênticas ao src V2",
    JSON.stringify(keysOf(v2Spawn)) === JSON.stringify(v2SrcKeys(v2SpawnSrc)),
    JSON.stringify(keysOf(v2Spawn)),
  );

  // Descrições byte-idênticas V1 (bundle) ↔ V2 (runtime)
  const extractV1Desc = (toolName) => {
    const re = new RegExp(`${toolName}\\s*:\\s*tool\\(\\{\\s*description\\s*:\\s*"((?:[^"\\\\]|\\\\.)*)"`);
    const m = distRaw.match(re);
    return m ? JSON.parse(`"${m[1]}"`) : null;
  };
  const v1CreateDesc = extractV1Desc("team_create");
  const v1SpawnDesc = extractV1Desc("team_spawn");
  check("(6) descrição V1 (bundle) de team_create extraída", typeof v1CreateDesc === "string" && v1CreateDesc.length > 0);
  check("(6) descrição V1 (bundle) de team_spawn extraída", typeof v1SpawnDesc === "string" && v1SpawnDesc.length > 0);
  check(
    "(6) descrição V1/V2 de team_create byte-idêntica",
    !!v2Create && v2Create.description === v1CreateDesc,
  );
  check(
    "(6) descrição V1/V2 de team_spawn byte-idêntica",
    !!v2Spawn && v2Spawn.description === v1SpawnDesc,
  );
  check(
    "(6) fontes V1 e V2 citam squad + dispatch (paridade textual)",
    v1CreateSrc.includes(SQUAD_MARKER) && v2CreateSrc.includes(SQUAD_MARKER) &&
      v1SpawnSrc.includes(DISPATCH_MARKER) && v2SpawnSrc.includes(DISPATCH_MARKER),
  );

  // =====================================================================
  // (7) Anti-mock: src/ e a própria suíte
  // =====================================================================
  const FORBIDDEN = ["je" + "st.mock", "sin" + "on", "vi.mo" + "ck", "mockImple" + "mentation"];
  const forbiddenRe = new RegExp(FORBIDDEN.join("|"), "i");
  let srcMocks = 0;
  const walk = (dir) => {
    for (const entry of readdirSync(dir)) {
      const full = path.join(dir, entry);
      if (statSync(full).isDirectory()) walk(full);
      else if (entry.endsWith(".ts")) {
        if (forbiddenRe.test(readFileSync(full, "utf8"))) srcMocks++;
      }
    }
  };
  walk(SRC);
  check("(7) zero mocks em produção sob src/", srcMocks === 0, `achados=${srcMocks}`);
  check(
    "(7) suíte determinística não contém mocks proibidos",
    !forbiddenRe.test(readFileSync(import.meta.filename, "utf8")),
  );
}

await runSuite();

const passed = results.filter(([, ok]) => ok).length;
const total = results.length;
console.log(`\nRESULT: ${passed}/${total} checks passed, ${unhandled.length} unhandled rejections`);
process.exit(passed === total && unhandled.length === 0 ? 0 : 1);
