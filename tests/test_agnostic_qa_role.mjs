#!/usr/bin/env node
/**
 * QUALITY GATE DETERMINÍSTICO — Suíte de Papel Agnóstico do Quality Gate (Migration 14)
 * @maiteuxzanela/ensemble-room-lowcost (TICKET-HARNESS-11 / Task 5)
 *
 * Guardiã: Clara (Quality Gate & Integridade dos Testes).
 *
 * Sob teste (src/ e dist/ REAIS, SQLite real via node:sqlite, SEM MOCKS):
 *   a) Registro de membro QA agnóstico com outro nome (ex: "bob" com role: "qa" ou is_qa: true);
 *   b) Bloqueio de segundo membro com papel de QA (trava de unicidade agnóstica de QA);
 *   c) Submissão de review por implementador acordando o QA agnóstico (não 'clara')
 *      e transicionando de standby para starting com spawn_context prepended;
 *   d) Aprovação e rejeição de tarefa in_review pelo QA agnóstico
 *      (e bloqueio de implementadores/terceiros não-QA);
 *   e) Desvio de mensagem ao lead silenciado com CC para o QA agnóstico;
 *   f) Watchdog de ociosidade acordando o QA agnóstico após 30s de inatividade com tarefas inacabadas;
 *   g) Retrocompatibilidade: garantir que se o membro for nomeado 'clara' sem flag role/is_qa explícita,
 *      continue funcionando 100% como QA por auto-detecção.
 *   h) Paridade de schema V1⇄V2: o registro V2 de team_spawn (src/v2-tools.ts e dist) declara
 *      as propriedades `role` (enum ["qa","member"]) e `is_qa` (boolean) já presentes no V1,
 *      preservando additionalProperties:false e required — anti-regressão do TICKET-HARNESS-11.
 *
 * Uso:  node tests/test_agnostic_qa_role.mjs
 * Exit: 0 = todos os checks PASS; 1 = há FAIL.
 */

import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";

const REPO = path.resolve(import.meta.dirname, "..");
const PKG = process.env.ENSEMBLE_PKG || REPO;
const DIST = path.join(PKG, "dist/index.js");
const SRC = path.join(PKG, "src");
const TMP = path.join(REPO, ".test-scratch");
mkdirSync(TMP, { recursive: true });

const HARNESS = path.join(TMP, "_agnostic_qa_harness.mjs");
const SRC_COPY = path.join(TMP, "ensemble_src_agnostic_qa");
const ROOT = path.join(TMP, "agnostic_qa_suite");

const results = [];
const check = (name, ok, detail) => {
  results.push([name, ok]);
  console.log(`${ok ? "PASS" : "FAIL"} | ${name}${detail ? " | " + detail : ""}`);
};

const unhandled = [];
process.on("unhandledRejection", (e) => unhandled.push(e));

/* ================================================================== *
 * 0. SINTAXE E SÍMBOLOS EXIGIDOS NO DIST                             *
 * ================================================================== */
{
  const r = spawnSync(process.execPath, ["--check", DIST], { encoding: "utf8" });
  check(
    "0.1 node --check dist/index.js → exit 0",
    r.status === 0,
    `status=${r.status}${r.stderr ? " stderr=" + r.stderr.trim().slice(0, 200) : ""}`,
  );
}

const REQUIRED_SYMBOLS = [
  "createDb",
  "MemberRegistry",
  "ProgressTracker",
  "Watchdog",
  "lastRoomActivity",
  "DEFAULT_CONFIG",
  "MIGRATIONS",
  "resolveStandbyWake",
  "executeTeamSpawn",
  "executeTeamMessage",
  "executeTeamTasksComplete",
  "isQAMember",
  "getTeamQAMember",
  "registerV2Tools",
];

const distRaw = readFileSync(DIST, "utf8");
{
  const missing = REQUIRED_SYMBOLS.filter(
    (s) => !new RegExp(`(function|class|var|const|let)\\s+${s}\\b`).test(distRaw),
  );
  check(
    "0.2 dist declara todos os símbolos exigidos para o papel agnóstico de QA",
    missing.length === 0,
    missing.join(",") || `${REQUIRED_SYMBOLS.length} símbolos presentes`,
  );

  const existingExport = distRaw.match(/export\s*\{([^}]*)\}\s*;?\s*$/)?.[1] ?? "";
  const already = new Set(
    existingExport.split(",").map((s) => s.trim().split(/\s+as\s+/).pop()).filter(Boolean),
  );
  const need = REQUIRED_SYMBOLS.filter((s) => !already.has(s));
  const EXPORT_APPEND = need.length ? `\nexport { ${need.join(", ")} };\n` : "";
  writeFileSync(HARNESS, distRaw + EXPORT_APPEND);
}

function prepareSrcCopy() {
  rmSync(SRC_COPY, { recursive: true, force: true });
  cpSync(SRC, SRC_COPY, { recursive: true });
  let rewritten = 0;
  const walk = (dir) =>
    readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
      e.isDirectory() ? walk(path.join(dir, e.name)) : [path.join(dir, e.name)],
    );
  for (const file of walk(SRC_COPY)) {
    if (!/\.(ts|tsx)$/.test(file)) continue;
    const before = readFileSync(file, "utf8");
    const after = before.replace(/(from\s+["'])(\.\.?\/[^"']+)(["'])/g, (m, a, spec, c) => {
      const base = path.resolve(path.dirname(file), spec);
      for (const ext of [".ts", ".tsx", "/index.ts", "/index.tsx"]) {
        if (existsSync(base + ext) && !spec.endsWith(ext)) {
          rewritten++;
          return a + spec + ext + c;
        }
      }
      return m;
    });
    if (after !== before) writeFileSync(file, after);
  }
  return rewritten;
}
check("0.3 cópia do src preparada para testes", prepareSrcCopy() > 0);

/* Anti-mock scan */
{
  const FORBIDDEN = [
    /\bMagicMock\b/, /\bjest\.(mock|fn|spyOn)\b/, /\bvi\.(mock|fn|spyOn)\b/,
    /\bsinon\b/, /unittest\.mock/,
  ];
  let violations = 0;
  for (const rx of FORBIDDEN) {
    if (rx.test(distRaw)) violations++;
  }
  check("0.4 zero primitivas de mock no bundle de produção", violations === 0);
}

/* ================================================================== *
 * 0.5 PARIDADE DE SCHEMA V1 ⇄ V2 — team_spawn: role / is_qa          *
 * (anti-regressão do TICKET-HARNESS-11: o V2 rejeitava role/is_qa     *
 *  porque additionalProperties:false sem declarar as propriedades)    *
 * ================================================================== */

/** Valida um argumento contra um JSON Schema como faria o OpenCode Core:
 *  type + enum + additionalProperties:false. Retorna null quando aceito. */
function validateLikeCore(schema, value) {
  if (!schema || typeof schema !== "object") return "schema ausente";
  if (schema.type === "object" && (value === null || typeof value !== "object" || Array.isArray(value))) {
    return "argumento não é object";
  }
  const props = schema.properties ?? {};
  if (schema.additionalProperties === false) {
    const extra = Object.keys(value).filter((k) => !(k in props));
    if (extra.length) return `propriedade(s) desconhecida(s): ${extra.join(",")}`;
  }
  for (const [key, raw] of Object.entries(value)) {
    const p = props[key];
    if (!p) continue;
    if (p.type === "string" && typeof raw !== "string") return `${key}: esperado string`;
    if (p.type === "boolean" && typeof raw !== "boolean") return `${key}: esperado boolean`;
    if (Array.isArray(p.enum) && !p.enum.includes(raw)) return `${key}: "${raw}" fora do enum [${p.enum.join(",")}]`;
  }
  return null;
}

/** Captura o schema realmente registrado por registerV2Tools (V2). */
async function captureV2TeamSpawn(registerV2Tools) {
  const captured = [];
  const domain = {
    transform: async (cb) => {
      cb({ add: (def) => captured.push(def) });
      return { dispose: async () => {} };
    },
  };
  // deps não é dereferenciado durante o registro (apenas fechado em execute);
  // nenhum comportamento é asserido a partir dele aqui.
  await registerV2Tools(domain, {});
  return captured.find((d) => d?.name === "team_spawn");
}

const v2SrcRaw = readFileSync(path.join(SRC, "v2-tools.ts"), "utf8");
const v2Start = v2SrcRaw.indexOf('name: "team_spawn"');
const v2End = v2SrcRaw.indexOf('name: "team_message"', v2Start);
const v2Block = v2Start >= 0 && v2End > v2Start ? v2SrcRaw.slice(v2Start, v2End) : "";
{
  check("0.5.1 src/v2-tools.ts declara a propriedade 'role' no schema de team_spawn", /\n\s{10}role:\s*\{/.test(v2Block));
  check("0.5.2 'role' usa enum [\"sdet\", \"qa\", \"member\"] (paridade com o enum V1)", /enum:\s*\[\s*"sdet"\s*,\s*"qa"\s*,\s*"member"\s*\]/.test(v2Block));
  check("0.5.3 src/v2-tools.ts declara a propriedade 'is_qa' booleana via helper bool(...)", /\n\s{10}is_qa:\s*bool\(/.test(v2Block));
  check(
    "0.5.4 required [name,prompt] e additionalProperties:false preservados no team_spawn V2",
    /required:\s*\[\s*"name"\s*,\s*"prompt"\s*\]/.test(v2Block) && /additionalProperties:\s*false/.test(v2Block),
  );
}

/* Referência V1 (src/index.ts) — paridade semântica exigida */
const v1SrcRaw = readFileSync(path.join(SRC, "index.ts"), "utf8");
const v1Start = v1SrcRaw.indexOf("team_spawn: tool({");
const v1End = v1SrcRaw.indexOf("team_message: tool({", v1Start);
const v1Block = v1Start >= 0 && v1End > v1Start ? v1SrcRaw.slice(v1Start, v1End) : "";
{
  check(
    "0.5.5 V1 (src/index.ts) declara role: enum [\"sdet\", \"qa\", \"member\"] no team_spawn",
    /role:\s*tool\.schema\.enum\(\s*\[\s*"sdet"\s*,\s*"qa"\s*,\s*"member"\s*\]/.test(v1Block),
  );
  check("0.5.6 V1 (src/index.ts) declara is_qa: tool.schema.boolean() no team_spawn", /is_qa:\s*tool\.schema\.boolean\(\)/.test(v1Block));
}

/* Registro real no runtime V2 (dist) + validador estilo OpenCode Core */
let spawnDist = null;
{
  const { registerV2Tools } = await import(HARNESS);
  spawnDist = await captureV2TeamSpawn(registerV2Tools);
  check("0.6.1 registerV2Tools (dist) registra a tool team_spawn no V2", Boolean(spawnDist));
  const props = spawnDist?.input?.properties ?? {};
  check(
    "0.6.2 schema V2 registrado expõe properties.role com type=string e enum [sdet, qa, member]",
    props.role?.type === "string" && JSON.stringify(props.role?.enum) === JSON.stringify(["sdet", "qa", "member"]),
    `role=${JSON.stringify(props.role)}`,
  );
  check("0.6.3 schema V2 registrado expõe properties.is_qa com type=boolean", props.is_qa?.type === "boolean", `is_qa=${JSON.stringify(props.is_qa)}`);
  check(
    "0.6.4 registro V2 preserva additionalProperties=false e required=[name,prompt]",
    spawnDist?.input?.additionalProperties === false && JSON.stringify(spawnDist?.input?.required) === JSON.stringify(["name", "prompt"]),
    `required=${JSON.stringify(spawnDist?.input?.required)} addProps=${String(spawnDist?.input?.additionalProperties)}`,
  );
  check(
    "0.6.5 invocação V2 com role:'qa' + is_qa:true é ACEITA pelo validador (bug do TICKET-HARNESS-11 corrigido)",
    validateLikeCore(spawnDist?.input, { name: "bob", prompt: "QA", role: "qa", is_qa: true }) === null,
    validateLikeCore(spawnDist?.input, { name: "bob", prompt: "QA", role: "qa", is_qa: true }) ?? "aceito",
  );
  check(
    "0.6.6 role inválido ('auditor') segue REJEITADO pelo enum do schema",
    validateLikeCore(spawnDist?.input, { name: "bob", prompt: "QA", role: "auditor" }) !== null,
    String(validateLikeCore(spawnDist?.input, { name: "bob", prompt: "QA", role: "auditor" })),
  );
}

/* Paridade dist ⇄ src: o mesmo schema em src/v2-tools.ts compilado */
{
  const srcModule = await import(`${SRC_COPY}/v2-tools.ts`);
  const spawnSrc = await captureV2TeamSpawn(srcModule.registerV2Tools);
  check("0.7.1 src/v2-tools.ts registra team_spawn no V2 (registro idêntico ao dist)", Boolean(spawnSrc));
  check(
    "0.7.2 schema de team_spawn em src e dist são byte-a-byte equivalentes (JSON)",
    JSON.stringify(spawnSrc?.input) === JSON.stringify(spawnDist?.input),
    `srcLen=${JSON.stringify(spawnSrc?.input).length} distLen=${JSON.stringify(spawnDist?.input).length}`,
  );
}

/* ================================================================== *
 * CLIENTE DE TESTE REAL (SEM MOCKS DE DECISÃO)                       *
 * ================================================================== */
function createTestClient() {
  const calls = { create: [], promptAsync: [], abort: [] };
  let seq = 0;
  return {
    calls,
    client: {
      session: {
        create: async (o) => {
          calls.create.push(o);
          seq += 1;
          const label = typeof o.title === "string" ? o.title.split(" ")[0].replace(/[^a-zA-Z0-9_-]/g, "") : `s${seq}`;
          return { data: { id: `ses_${label}_${seq}` } };
        },
        promptAsync: async (o) => {
          calls.promptAsync.push(o);
          return {};
        },
        abort: async (o) => {
          calls.abort.push(o);
          return {};
        },
      },
      tui: {
        showToast: async () => ({}),
        selectSession: async () => ({}),
      },
    },
  };
}

/* ================================================================== *
 * SUÍTE COMPORTAMENTAL DE PAPEL AGNÓSTICO DE QA                      *
 * ================================================================== */
async function runAgnosticQASuite(label, mods) {
  const {
    createDb,
    MemberRegistry,
    ProgressTracker,
    Watchdog,
    lastRoomActivity,
    DEFAULT_CONFIG,
    executeTeamSpawn,
    executeTeamMessage,
    executeTeamTasksComplete,
    isQAMember,
    getTeamQAMember,
  } = mods;

  const root = path.join(ROOT, label);
  rmSync(root, { recursive: true, force: true });
  mkdirSync(root, { recursive: true });

  const db = createDb(path.join(root, "ensemble.db"));
  const registry = new MemberRegistry();
  const tc = createTestClient();
  const calls = tc.calls;

  const deps = (config = DEFAULT_CONFIG) => ({
    db,
    directory: root,
    client: tc.client,
    registry,
    config,
    progressTracker: new ProgressTracker(),
  });

  const now = Date.now();
  const TEAM = "team_agnostic_qa";
  const LEAD_SESSION = "ses_lead_agnostic";

  // Inserir projeto e time inicial
  db.run("INSERT INTO project (id, name, path, status, time_created, time_updated) VALUES ('default', 'Default', '', 'active', ?, ?) ON CONFLICT DO NOTHING", [now, now]);
  db.run(
    "INSERT INTO team (id, name, project_id, lead_session_id, status, delegate, time_created, time_updated, lead_agent) VALUES (?,?,?,?,?,?,?,?,?)",
    [TEAM, "squad-agnostic", "default", LEAD_SESSION, "active", 0, now, now, "build"],
  );
  registry.register(LEAD_SESSION, "lead", TEAM);

  // Inserir uma tarefa inicial para acionar auto-standby semântico em QA que nasce na sala
  db.run(
    "INSERT INTO team_task (id, team_id, content, status, priority, time_created, time_updated) VALUES ('init_task', ?, 'Setup Inicial', 'in_progress', 'low', ?, ?)",
    [TEAM, now, now],
  );

  /* ------------------------------------------------------------------ *
   * Item A: Registro de membro QA agnóstico com outro nome ("bob")     *
   * ------------------------------------------------------------------ */
  const spawnBobRes = await executeTeamSpawn(
    deps(),
    {
      name: "bob",
      agent: "build",
      role: "qa",
      prompt: "Diretrizes de QA Agnóstico do Bob",
      worktree: false,
    },
    LEAD_SESSION,
  );
  check(`[${label}] A.1 executeTeamSpawn com role: 'qa' para 'bob' conclui com sucesso`, typeof spawnBobRes === "string");

  const bobRow = db.query("SELECT * FROM team_member WHERE team_id = ? AND name = 'bob'").get(TEAM);
  check(`[${label}] A.2 'bob' registrado no SQLite com is_qa = 1`, bobRow?.is_qa === 1, `is_qa=${bobRow?.is_qa}`);
  check(`[${label}] A.3 'bob' nasce em standby semântico (auto-standby de QA com board ativo)`, bobRow?.execution_status === "standby", `execution_status=${bobRow?.execution_status}`);
  check(`[${label}] A.4 'bob' tem spawn_context persistido`, typeof bobRow?.spawn_context === "string" && bobRow.spawn_context.includes("Diretrizes de QA Agnóstico do Bob"));
  check(`[${label}] A.5 isQAMember reconhece 'bob' como membro de QA`, isQAMember(db, TEAM, "bob") === true);

  const currentQA = getTeamQAMember(db, TEAM);
  check(`[${label}] A.6 getTeamQAMember resolve 'bob'`, currentQA?.name === "bob" && currentQA?.sessionId === bobRow?.session_id);

  // Também testar spawn de desenvolvedor comum após o QA existir
  const spawnDevRes = await executeTeamSpawn(
    deps(),
    {
      name: "alice",
      agent: "build",
      role: "member",
      prompt: "Implementador Alice",
      worktree: false,
    },
    LEAD_SESSION,
  );
  check(`[${label}] A.7 Spawn de membro regular 'alice' com role: 'member' registrado`, typeof spawnDevRes === "string");
  const aliceRow = db.query("SELECT * FROM team_member WHERE team_id = ? AND name = 'alice'").get(TEAM);
  check(`[${label}] A.8 'alice' tem is_qa = 0`, aliceRow?.is_qa === 0, `is_qa=${aliceRow?.is_qa}`);
  check(`[${label}] A.9 isQAMember retorna false para 'alice'`, isQAMember(db, TEAM, "alice") === false);

  // Verificar template peer-to-peer dinâmico entregue a alice
  const alicePromptCall = calls.promptAsync.find((c) => c.sessionID === aliceRow?.session_id);
  const alicePromptText = alicePromptCall?.parts?.[0]?.text ?? "";
  check(
    `[${label}] A.10 Template de spawn da 'alice' instrui coordenação com 'bob' via team_message(to: 'bob')`,
    alicePromptText.includes("Coordinate peer-to-peer with bob via team_message(to: 'bob')"),
    `snippet=${alicePromptText.slice(0, 300)}`,
  );

  /* ------------------------------------------------------------------ *
   * Item B: Bloqueio de segundo membro QA (trava de unicidade)          *
   * ------------------------------------------------------------------ */
  let errorSecondQA = null;
  try {
    await executeTeamSpawn(
      deps(),
      {
        name: "robert",
        agent: "build",
        role: "qa",
        prompt: "Segundo QA não autorizado",
        worktree: false,
      },
      LEAD_SESSION,
    );
  } catch (err) {
    errorSecondQA = err;
  }
  check(`[${label}] B.1 Segundo spawn com role: 'qa' é rejeitado determinísticamente`, errorSecondQA !== null);
  check(
    `[${label}] B.2 Mensagem de erro da trava declara exclusividade e interpola 'bob'`,
    errorSecondQA?.message?.includes("Guardiã do Quality Gate 'bob' já está ativa na equipe 'squad-agnostic' (instância ativa: 'bob')"),
    errorSecondQA?.message,
  );

  let errorClaraQA = null;
  try {
    await executeTeamSpawn(
      deps(),
      {
        name: "clara",
        agent: "clara",
        prompt: "Clara concorrente",
        worktree: false,
      },
      LEAD_SESSION,
    );
  } catch (err) {
    errorClaraQA = err;
  }
  check(`[${label}] B.3 Spawn de 'clara' bloqueado pela trava de unicidade enquanto 'bob' estiver ativo`, errorClaraQA !== null);
  check(
    `[${label}] B.4 Mensagem de rejeição da 'clara' cita instância ativa 'bob'`,
    errorClaraQA?.message?.includes("instância ativa: 'bob'"),
    errorClaraQA?.message,
  );

  /* ------------------------------------------------------------------ *
   * Item C: Submit_review acordando o QA agnóstico ('bob')             *
   * ------------------------------------------------------------------ */
  const task1Id = "task_agnostic_1";
  db.run(
    "INSERT INTO team_task (id, team_id, content, status, priority, assignee, time_created, time_updated) VALUES (?,?,?,?,?,?,?,?)",
    [task1Id, TEAM, "Feature do Dev Alice", "in_progress", "high", "alice", now, now],
  );

  calls.promptAsync.length = 0;
  const submitRes = await executeTeamTasksComplete(
    deps(),
    {
      task_id: task1Id,
      action: "submit_review",
      notes: "Feature pronta para o Bob auditar",
    },
    aliceRow.session_id,
  );

  check(
    `[${label}] C.1 submit_review indica notificação dinâmica ao QA 'bob'`,
    submitRes.includes("(notified bob for review)"),
    submitRes,
  );

  const bobRowAfterSubmit = db.query("SELECT execution_status FROM team_member WHERE team_id = ? AND name = 'bob'").get(TEAM);
  check(`[${label}] C.2 'bob' transicionou de standby para starting`, bobRowAfterSubmit.execution_status === "starting", bobRowAfterSubmit.execution_status);

  const promptBob = calls.promptAsync.filter((c) => c.sessionID === bobRow.session_id);
  check(`[${label}] C.3 'bob' recebeu exatamente 1 promptAsync`, promptBob.length === 1, `count=${promptBob.length}`);
  check(
    `[${label}] C.4 Prompt do 'bob' contém o spawn_context prepended`,
    promptBob[0]?.parts?.[0]?.text?.includes("Diretrizes de QA Agnóstico do Bob"),
  );
  check(
    `[${label}] C.5 Prompt do 'bob' contém aviso sintético de submit_review com notas da Alice`,
    promptBob[0]?.parts?.[0]?.text?.includes('[System: Task "task_agnostic_1" was submitted for review by alice (notes: Feature pronta para o Bob auditar)]'),
  );

  /* ------------------------------------------------------------------ *
   * Item D: Aprovação e rejeição de tarefa in_review pelo QA agnóstico  *
   *         e bloqueio de implementadores / terceiros não-QA           *
   * ------------------------------------------------------------------ */
  // 1. Terceiro não-QA (Alice) tenta rejeitar a revisão -> Bloqueado
  let aliceRejectErr = null;
  try {
    await executeTeamTasksComplete(
      deps(),
      {
        task_id: task1Id,
        action: "reject",
        notes: "Alice tentando auto-rejeitar",
      },
      aliceRow.session_id,
    );
  } catch (err) {
    aliceRejectErr = err;
  }
  check(`[${label}] D.1 Alice (não-QA) é bloqueada ao tentar rejeitar review`, aliceRejectErr !== null);
  check(
    `[${label}] D.2 Mensagem de bloqueio do reject interpola o nome do QA 'bob'`,
    aliceRejectErr?.message?.includes("Only bob or the team lead can reject tasks in review"),
    aliceRejectErr?.message,
  );

  // 2. Terceiro não-QA (Alice) tenta aprovar/completar a revisão -> Bloqueado
  let aliceCompleteErr = null;
  try {
    await executeTeamTasksComplete(
      deps(),
      {
        task_id: task1Id,
        action: "complete",
        notes: "Alice tentando auto-aprovar",
      },
      aliceRow.session_id,
    );
  } catch (err) {
    aliceCompleteErr = err;
  }
  check(`[${label}] D.3 Alice (não-QA) é bloqueada ao tentar completar tarefa in_review`, aliceCompleteErr !== null);
  check(
    `[${label}] D.4 Mensagem de bloqueio do complete interpola o nome do QA 'bob'`,
    aliceCompleteErr?.message?.includes("only bob or the team lead can complete it"),
    aliceCompleteErr?.message,
  );

  // 3. Bob (QA legítimo) rejeita a revisão -> Transiciona in_review -> in_progress
  const bobRejectRes = await executeTeamTasksComplete(
    deps(),
    {
      task_id: task1Id,
      action: "reject",
      notes: "Falta teste de regressão",
    },
    bobRow.session_id,
  );
  check(`[${label}] D.5 Bob rejeita a revisão com sucesso`, typeof bobRejectRes === "string");
  const taskAfterReject = db.query("SELECT status, rejection_count FROM team_task WHERE id = ?").get(task1Id);
  check(`[${label}] D.6 Tarefa retornou para status in_progress com rejection_count = 1`, taskAfterReject.status === "in_progress" && taskAfterReject.rejection_count === 1);

  // Re-submeter para teste de aprovação
  await executeTeamTasksComplete(
    deps(),
    {
      task_id: task1Id,
      action: "submit_review",
      notes: "Testes adicionados",
    },
    aliceRow.session_id,
  );

  // 4. Bob (QA legítimo) aprova a revisão -> Transiciona in_review -> completed
  const bobApproveRes = await executeTeamTasksComplete(
    deps(),
    {
      task_id: task1Id,
      action: "complete",
      notes: "Aprovado pelo QA Bob",
    },
    bobRow.session_id,
  );
  check(`[${label}] D.7 Bob aprova a revisão com sucesso`, typeof bobApproveRes === "string");
  const taskAfterApprove = db.query("SELECT status FROM team_task WHERE id = ?").get(task1Id);
  check(`[${label}] D.8 Tarefa transicionou para completed no SQLite`, taskAfterApprove.status === "completed");

  /* ------------------------------------------------------------------ *
   * Item E: HARNESS-22 — mensagem ao lead silenciado SEM CC para o QA  *
   *         (o clone automático [CC Lead] foi extirpado)               *
   * ------------------------------------------------------------------ */
  // Bob volta para idle; NÃO deve ser acordado por CC.
  db.run("UPDATE team_member SET execution_status = 'idle' WHERE team_id = ? AND name = 'bob'", [TEAM]);
  calls.promptAsync.length = 0;

  const msgRes = await executeTeamMessage(
    deps({ ...DEFAULT_CONFIG, silentLead: true }),
    {
      to: "lead",
      text: "Lead, finalizei minha parte da feature",
    },
    aliceRow.session_id,
  );

  check(`[${label}] E.1 Envio de mensagem ao Lead sob silentLead concluído`, typeof msgRes === "string");

  // Sem clone [CC Lead]: nenhuma cópia gravada para o QA.
  const ccMsg = db.query("SELECT * FROM team_message WHERE team_id = ? AND to_name = 'bob' ORDER BY time_created DESC LIMIT 1").get(TEAM);
  check(`[${label}] E.2 NENHUMA cópia [CC Lead] gravada para 'bob' (clone extirpado)`, ccMsg === undefined || ccMsg === null);

  const bobCCPrompts = calls.promptAsync.filter((c) => c.sessionID === bobRow.session_id);
  check(`[${label}] E.3 'bob' NÃO recebeu auto-wake de CC`, bobCCPrompts.length === 0, `count=${bobCCPrompts.length}`);
  check(`[${label}] E.4 Lead permanece em silêncio absoluto (nenhum promptAsync)`, !calls.promptAsync.some((c) => c.sessionID === LEAD_SESSION));

  // Anti-loop: Bob enviando mensagem ao lead NÃO gera CC para si mesmo
  calls.promptAsync.length = 0;
  await executeTeamMessage(
    deps({ ...DEFAULT_CONFIG, silentLead: true }),
    {
      to: "lead",
      text: "Relatório final do QA",
    },
    bobRow.session_id,
  );
  const bobSelfCC = calls.promptAsync.filter((c) => c.sessionID === bobRow.session_id);
  check(`[${label}] E.5 Anti-loop: Bob enviando mensagem ao lead NÃO gera CC/wake para si mesmo`, bobSelfCC.length === 0);

  /* ------------------------------------------------------------------ *
   * Item F: Watchdog de ociosidade acordando o QA agnóstico após 30s   *
   * ------------------------------------------------------------------ */
  // Inserir tarefa inacabada e simular inatividade da sala de 45 segundos
  const inactiveTs = Date.now() - 45_000;
  db.run("DELETE FROM team_message WHERE team_id = ?", [TEAM]);
  db.run("DELETE FROM team_task WHERE team_id = ?", [TEAM]);
  db.run(
    "INSERT INTO team_task (id, team_id, content, status, priority, assignee, time_created, time_updated) VALUES ('task_inact', ?, 'Tarefa Pendente Ociosa', 'in_progress', 'medium', 'alice', ?, ?)",
    [TEAM, inactiveTs, inactiveTs],
  );
  db.run("UPDATE team_member SET time_updated = ?, status = 'ready', execution_status = 'idle' WHERE team_id = ?", [inactiveTs, TEAM]);
  db.run("UPDATE team_member SET execution_status = 'standby', last_nudged_at = NULL WHERE team_id = ? AND name = 'bob'", [TEAM]);
  db.run("UPDATE team SET time_created = ?, time_updated = ? WHERE id = ?", [inactiveTs, inactiveTs, TEAM]);

  const wd = new Watchdog({
    db,
    client: tc.client,
    registry,
    ttlMs: 0,
    roomInactivityThresholdMs: 30_000,
    roomInactivityCheckMs: 5_000,
  });

  calls.promptAsync.length = 0;
  await wd.checkRoomInactivity();

  const bobWatchdogCalls = calls.promptAsync.filter((c) => c.sessionID === bobRow.session_id);
  check(`[${label}] F.1 Watchdog aciona o QA 'bob' após 30s de inatividade com tarefas pendentes`, bobWatchdogCalls.length === 1, `count=${bobWatchdogCalls.length}`);
  check(
    `[${label}] F.2 Prompt do Watchdog contém aviso de ociosidade da sala`,
    bobWatchdogCalls[0]?.parts?.[0]?.text?.includes("Inspect the board, unblock, claim, or nudge teammates"),
  );
  const bobRowAfterWD = db.query("SELECT execution_status, last_nudged_at FROM team_member WHERE team_id = ? AND name = 'bob'").get(TEAM);
  check(`[${label}] F.3 'bob' transicionou de standby para starting pelo Watchdog`, bobRowAfterWD.execution_status === "starting");
  check(`[${label}] F.4 last_nudged_at de 'bob' atualizado recentemente`, typeof bobRowAfterWD.last_nudged_at === "number" && (Date.now() - bobRowAfterWD.last_nudged_at < 5000));

  /* ------------------------------------------------------------------ *
   * Item G: Retrocompatibilidade 100% para membro nomeado 'clara'      *
   *         sem flag role/is_qa explícita                              *
   * ------------------------------------------------------------------ */
  const RETRO_TEAM = "team_retrocompat";
  const RETRO_LEAD = "ses_lead_retro";
  db.run(
    "INSERT INTO team (id, name, project_id, lead_session_id, status, delegate, time_created, time_updated, lead_agent) VALUES (?,?,?,?,?,?,?,?,?)",
    [RETRO_TEAM, "squad-retro", "default", RETRO_LEAD, "active", 0, now, now, "build"],
  );
  registry.register(RETRO_LEAD, "lead", RETRO_TEAM);

  // Inserir tarefa para acionar auto-standby semântico
  db.run(
    "INSERT INTO team_task (id, team_id, content, status, priority, time_created, time_updated) VALUES ('retro_task', ?, 'Setup Retro', 'in_progress', 'low', ?, ?)",
    [RETRO_TEAM, now, now],
  );

  // Spawn de 'clara' sem passar role nem is_qa
  const spawnClaraRes = await executeTeamSpawn(
    deps(),
    {
      name: "clara",
      agent: "mimo", // agent comum, nome clara
      prompt: "Guardiã Clara Clássica",
      worktree: false,
    },
    RETRO_LEAD,
  );
  check(`[${label}] G.1 Spawn da 'clara' sem flag explícita concluído com sucesso`, typeof spawnClaraRes === "string");

  const claraRow = db.query("SELECT * FROM team_member WHERE team_id = ? AND name = 'clara'").get(RETRO_TEAM);
  check(`[${label}] G.2 'clara' auto-detectada como QA: persistida com is_qa = 1`, claraRow?.is_qa === 1, `is_qa=${claraRow?.is_qa}`);
  check(`[${label}] G.3 'clara' nasce em standby semântico por auto-detecção`, claraRow?.execution_status === "standby");
  check(`[${label}] G.4 isQAMember('clara') retorna true`, isQAMember(db, RETRO_TEAM, "clara") === true);

  const retroQA = getTeamQAMember(db, RETRO_TEAM);
  check(`[${label}] G.5 getTeamQAMember na sala retrocompat resolve 'clara'`, retroQA?.name === "clara");

  // Inserir membro legado diretamente no SQLite com is_qa = 0 para simular banco legado
  db.run(
    "INSERT INTO team_member (team_id, name, session_id, agent, status, execution_status, is_qa, time_created, time_updated, reported_to_lead) VALUES (?,?,?,?,?,?,?,?,?,?)",
    [RETRO_TEAM, "clara-legacy", "ses_clara_legacy", "build", "ready", "idle", 0, now, now, 0],
  );
  check(`[${label}] G.6 Membro 'clara-legacy' com is_qa = 0 é reconhecido por basePersona via isQAMember`, isQAMember(db, RETRO_TEAM, "clara-legacy") === true);
}

/* ================================================================== *
 * 2. EXECUÇÃO EM DIST E SRC                                          *
 * ================================================================== */
console.log("=".repeat(78));
console.log("Executando test_agnostic_qa_role contra dist/index.js...");
console.log("=".repeat(78));

const distMods = await import(HARNESS);
await runAgnosticQASuite("dist", distMods);

console.log("=".repeat(78));
console.log("Executando test_agnostic_qa_role contra src/...");
console.log("=".repeat(78));

const srcCreateDb = await import(`${SRC_COPY}/db.ts`);
const srcState = await import(`${SRC_COPY}/state.ts`);
const srcTracker = await import(`${SRC_COPY}/progress.ts`);
const srcWatchdog = await import(`${SRC_COPY}/watchdog.ts`);
const srcConfig = await import(`${SRC_COPY}/config.ts`);
const srcSchema = await import(`${SRC_COPY}/schema.ts`);
const srcShared = await import(`${SRC_COPY}/tools/shared.ts`);
const srcSpawn = await import(`${SRC_COPY}/tools/team-spawn.ts`);
const srcMsg = await import(`${SRC_COPY}/tools/team-message.ts`);
const srcComplete = await import(`${SRC_COPY}/tools/team-tasks-complete.ts`);
const srcQARole = await import(`${SRC_COPY}/qa-role.ts`);

const srcMods = {
  createDb: srcCreateDb.createDb,
  MemberRegistry: srcState.MemberRegistry,
  ProgressTracker: srcTracker.ProgressTracker,
  Watchdog: srcWatchdog.Watchdog,
  lastRoomActivity: srcConfig.lastRoomActivity,
  DEFAULT_CONFIG: srcConfig.DEFAULT_CONFIG,
  MIGRATIONS: srcSchema.MIGRATIONS,
  resolveStandbyWake: srcShared.resolveStandbyWake,
  executeTeamSpawn: srcSpawn.executeTeamSpawn,
  executeTeamMessage: srcMsg.executeTeamMessage,
  executeTeamTasksComplete: srcComplete.executeTeamTasksComplete,
  isQAMember: srcQARole.isQAMember,
  getTeamQAMember: srcQARole.getTeamQAMember,
};

await runAgnosticQASuite("src", srcMods);

/* ================================================================== *
 * RELATÓRIO CONSOLIDADO                                              *
 * ================================================================== */
const failed = results.filter(([, ok]) => !ok);
console.log("=".repeat(78));
console.log(`test_agnostic_qa_role: ${results.length - failed.length}/${results.length} checks passed`);
if (unhandled.length > 0) {
  console.error(`Unhandled rejections: ${unhandled.length}`);
  for (const err of unhandled) console.error(err);
  process.exit(1);
}
if (failed.length > 0) {
  console.error("FALHAS ENCONTRADAS:");
  for (const [name, , detail] of failed) {
    console.error(`- ${name}${detail ? ": " + detail : ""}`);
  }
  process.exit(1);
}
console.log("RESULT: all checks passed");
process.exit(0);
