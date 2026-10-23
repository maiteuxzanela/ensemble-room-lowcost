#!/usr/bin/env node
/**
 * QUALITY GATE DETERMINÍSTICO — TICKET-HARNESS-22
 * decision_lead (escalada emergencial ao Lead), pausa do autoawake da Clara no
 * watchdog durante decisão pendente e anti-redundância (clone [CC Lead]
 * extirpado). Paridade estrita V1↔V2 e anti-mock.
 *
 * SDET: Hugo. Guardiã do Quality Gate: Clara.
 *
 * Sob teste (código REAL, sem mocks):
 *   - executeDecisionLead / mark|clear|hasAwaitingLeadDecision -> src/tools/decision-lead.ts
 *   - checkRoomInactivity (pausa por awaiting_lead_decision)    -> src/watchdog.ts
 *   - executeTeamMessage (sem clone [CC Lead])                 -> src/tools/team-message.ts
 *   - executeTeamTasksComplete (submit_review)                 -> src/tools/team-tasks-complete.ts
 *   - Migration 15 (team.awaiting_lead_decision)               -> src/schema.ts
 *   - Registro V1 (src/index.ts) ↔ V2 (src/v2-tools.ts)
 *
 * SEM MOCKS: roda contra dist/index.js REAL (bundle esbuild) e o código-fonte
 * real sob src/ (cópia com imports reescritos), SQLite real via node:sqlite. O
 * único seam é o cliente SDK do OpenCode (boundary externo) — session.create/
 * promptAsync/abort e tui.showToast — idêntico às demais suítes do repo.
 *
 * Uso:  node tests/test_decision_lead_anti_redundancy.mjs
 * Exit: 0 = todos os checks PASS; 1 = há FAIL.
 */

import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import path from "node:path";

const REPO = path.resolve(import.meta.dirname, "..");
const PKG = process.env.ENSEMBLE_PKG || REPO;
const DIST = path.join(PKG, "dist/index.js");
const SRC = path.join(REPO, "src");
const TMP = path.join(REPO, ".test-scratch");
mkdirSync(TMP, { recursive: true });

const HARNESS = path.join(TMP, "_decision_lead_harness.mjs");
const SRC_COPY = path.join(TMP, "ensemble_src_decision_lead");
const ROOT = path.join(TMP, "decision_lead_suite");

const results = [];
const check = (name, ok, detail) => {
  results.push([name, ok]);
  console.log(`${ok ? "PASS" : "FAIL"} | ${name}${detail ? " | " + detail : ""}`);
};

const unhandled = [];
process.on("unhandledRejection", (e) => unhandled.push(e));

/* ================================================================== *
 * 0. SINTAXE, MARCADORES E PARIDADE TEXTUAL                          *
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
  "DEFAULT_CONFIG",
  "executeDecisionLead",
  "markAwaitingLeadDecision",
  "clearAwaitingLeadDecision",
  "hasAwaitingLeadDecision",
  "executeTeamMessage",
  "executeTeamTasksComplete",
  "Watchdog",
  "registerV2Tools",
  "resolveFallbackChainForAgent",
  "formatModelSelector",
  "lastRoomActivity",
  "MIGRATIONS",
];

const distRaw = readFileSync(DIST, "utf8");
{
  const missing = REQUIRED_SYMBOLS.filter(
    (s) => !new RegExp(`(function|class|var|const|let)\\s+${s}\\b`).test(distRaw),
  );
  check(
    "0.2 dist declara todos os símbolos exigidos para o decision_lead",
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

const indexRaw = readFileSync(path.join(SRC, "index.ts"), "utf8");
const v2Raw = readFileSync(path.join(SRC, "v2-tools.ts"), "utf8");
const msgRaw = readFileSync(path.join(SRC, "tools/team-message.ts"), "utf8");

check("0.4 V1 registra decision_lead (src/index.ts)", indexRaw.includes("decision_lead: tool({"));
check("0.5 V2 registra decision_lead (src/v2-tools.ts)", v2Raw.includes('name: "decision_lead"'));
check(
  "0.6 dist registra decision_lead nas DUAS camadas (V1+V2)",
  distRaw.includes("decision_lead: tool({") && distRaw.includes('name: "decision_lead"'),
);
check(
  "0.7 dist contém o payload de emergência [System: EMERGENCY DECISION REQUIRED from ...]",
  distRaw.includes("[System: EMERGENCY DECISION REQUIRED from "),
);
check(
  "0.8 HARNESS-22: clone [CC Lead] ausente em src/tools/team-message.ts e no dist",
  !msgRaw.includes("[CC Lead]") && !distRaw.includes("[CC Lead]"),
);
check(
  "0.9 HARNESS-22: log team_message:lead-silenced preservado (src e dist)",
  msgRaw.includes("team_message:lead-silenced") && distRaw.includes("team_message:lead-silenced"),
);
check(
  "0.10 dist contém a pausa do watchdog (watchdog:room-inactivity:paused + awaiting-lead-decision)",
  distRaw.includes("watchdog:room-inactivity:paused") && distRaw.includes("awaiting-lead-decision"),
);

/* Paridade textual V1 ↔ V2 do schema decision_lead */
const sliceBetween = (src, start, end) => {
  const i = src.indexOf(start);
  if (i < 0) return null;
  const j = end ? src.indexOf(end, i + start.length) : -1;
  return src.slice(i, j < 0 ? src.length : j);
};
const v1DecisionSrc = sliceBetween(indexRaw, "decision_lead: tool({", null);
const v2DecisionSrc = sliceBetween(v2Raw, 'name: "decision_lead"', null);
check("0.11 blocos V1 e V2 de decision_lead localizados no src", !!v1DecisionSrc && !!v2DecisionSrc);

const v1Keys = [...(v1DecisionSrc?.matchAll(/^ {10}([a-z_]+): tool\.schema/gm) ?? [])].map((m) => m[1]).sort();
const v2Keys = [...(v2DecisionSrc?.matchAll(/^ {10}([a-z_]+): /gm) ?? [])].map((m) => m[1]).sort();
check(
  "0.12 paridade V1↔V2 de props do decision_lead [context, options, question]",
  JSON.stringify(v1Keys) === JSON.stringify(v2Keys) &&
    JSON.stringify(v1Keys) === JSON.stringify(["context", "options", "question"]),
  `v1=${JSON.stringify(v1Keys)} v2=${JSON.stringify(v2Keys)}`,
);
check(
  "0.13 V2 decision_lead required [question, context] + additionalProperties:false",
  !!v2DecisionSrc &&
    v2DecisionSrc.includes('required: ["question", "context"]') &&
    v2DecisionSrc.includes("additionalProperties: false"),
);
check(
  "0.14 V1: question/context obrigatórios e options opcional",
  /question:\s*tool\.schema\.string\(\)\.describe/.test(v1DecisionSrc ?? "") &&
    /context:\s*tool\.schema\.string\(\)\.describe/.test(v1DecisionSrc ?? "") &&
    /options:\s*tool\.schema\.array\(tool\.schema\.string\(\)\)\.optional\(\)/.test(v1DecisionSrc ?? ""),
);

/* Anti-mock: primitivas proibidas em produção */
const FORBIDDEN = [
  /\bMagicMock\b/,
  /\bjest\.(mock|fn|spyOn)\b/,
  /\bvi\.(mock|fn|spyOn)\b/,
  /\bsinon\b/,
  /unittest\.mock/,
];
{
  let srcMocks = 0;
  const offenders = [];
  const walk = (dir) => {
    for (const entry of readdirSync(dir)) {
      const full = path.join(dir, entry);
      if (statSync(full).isDirectory()) walk(full);
      else if (full.endsWith(".ts")) {
        const text = readFileSync(full, "utf8");
        if (FORBIDDEN.some((rx) => rx.test(text))) {
          srcMocks++;
          offenders.push(path.relative(SRC, full));
        }
      }
    }
  };
  walk(SRC);
  check("0.15 zero primitivas de mock em produção sob src/", srcMocks === 0, offenders.join(",") || "0 achados");

  const distMocks = FORBIDDEN.filter((rx) => rx.test(distRaw)).length;
  check("0.16 zero primitivas de mock no bundle de produção", distMocks === 0, `achados=${distMocks}`);
  check(
    "0.17 a própria suíte determinística não usa mocks proibidos",
    !FORBIDDEN.some((rx) => rx.test(readFileSync(import.meta.filename, "utf8"))),
  );
}

/* ================================================================== *
 * SEAM MÍNIMO DO CLIENTE SDK (boundary externo — sem mocks de src/)  *
 * ================================================================== */
function createTestClient(calls) {
  return {
    session: {
      create: async (o) => {
        calls.sessionCreate.push(o);
        return { data: { id: `ses_child_${calls.sessionCreate.length}` } };
      },
      promptAsync: async (o) => {
        calls.promptAsync.push(o);
        return {};
      },
      abort: async (o) => {
        calls.abort.push(o);
        return {};
      },
      // TICKET-RELEASE-15: seam de LEITURA da sessão. O server reporta
      // variant "default" para modelo sem variante — o wake deve normalizar
      // para AUSÊNCIA e enviar o modelo bound explicitamente.
      get: async ({ sessionID }) => ({
        data: {
          id: sessionID,
          model: { providerID: "opencode-go", id: "deepseek-v4.1-flash", variant: "default" },
        },
      }),
    },
    tui: {
      showToast: async (o) => {
        calls.toast.push(o);
      },
      selectSession: async () => ({}),
    },
  };
}

/* ================================================================== *
 * SUÍTE COMPORTAMENTAL (executada em dist E src)                     *
 * ================================================================== */
async function runBehavior(label, mods) {
  const {
    createDb,
    MemberRegistry,
    DEFAULT_CONFIG,
    executeDecisionLead,
    clearAwaitingLeadDecision,
    hasAwaitingLeadDecision,
    executeTeamMessage,
    executeTeamTasksComplete,
    Watchdog,
    registerV2Tools,
    resolveFallbackChainForAgent,
    formatModelSelector,
  } = mods;

  const root = `${ROOT}_${label}`;
  rmSync(root, { recursive: true, force: true });
  mkdirSync(root, { recursive: true });

  const db = createDb(path.join(root, "ensemble.db"));
  const registry = new MemberRegistry();
  const calls = { sessionCreate: [], promptAsync: [], abort: [], toast: [] };
  const client = createTestClient(calls);
  const deps = {
    db,
    registry,
    tracker: {},
    purgeApprovals: {},
    client,
    directory: root,
    config: { ...DEFAULT_CONFIG },
    progressTracker: { recordTaskComplete: () => {} },
  };

  const TEAM = `team_dl_${label}`;
  const LEAD_SESSION = `ses_lead_dl_${label}`;
  const LEAD_AGENT = "dante";
  const TULIO_SESSION = `ses_tulio_dl_${label}`;
  const CLARA_SESSION = `ses_clara_dl_${label}`;
  const MAYA_SESSION = `ses_maya_dl_${label}`;
  const now = Date.now();

  db.run(
    "INSERT INTO project (id, name, path, status, time_created, time_updated) VALUES ('default','Default','','active',?,?) ON CONFLICT DO NOTHING",
    [now, now],
  );
  db.run(
    "INSERT INTO team (id, name, project_id, lead_session_id, status, delegate, time_created, time_updated, lead_agent) VALUES (?,?,?,?,?,?,?,?,?)",
    [TEAM, "squad-dl", "default", LEAD_SESSION, "active", 0, now, now, LEAD_AGENT],
  );

  const insertMember = (name, sessionId, agent, executionStatus, isQa = 0, spawnContext = null) => {
    db.run(
      `INSERT INTO team_member (team_id, name, session_id, agent, status, execution_status, spawn_context, time_created, time_updated, reported_to_lead, is_qa)
       VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
      [TEAM, name, sessionId, agent, "ready", executionStatus, spawnContext, now, now, 0, isQa],
    );
    registry.register(TEAM, name, sessionId);
  };
  const insertTask = (id, content, status, assignee) => {
    db.run(
      "INSERT INTO team_task (id, team_id, content, status, priority, assignee, time_created, time_updated) VALUES (?,?,?,?,?,?,?,?)",
      [id, TEAM, content, status, "high", assignee, now, now],
    );
  };

  insertMember("tulio", TULIO_SESSION, "build", "running");
  insertMember("clara", CLARA_SESSION, "clara", "idle", 1);
  insertMember("maya", MAYA_SESSION, "explore", "idle");
  insertTask("task_dl_main", "Frente principal", "in_progress", "tulio");

  /* ================================================================ *
   * 1. decision_lead ACORDA O LEAD SOB silentLead E SUSPENDE EMISSOR  *
   * ================================================================ */
  {
    calls.promptAsync.length = 0;
    calls.toast.length = 0;
    const question = "Precisamos decidir o formato de entrega";
    const contextText = "Dois caminhos possíveis com trade-offs distintos";
    const res = await executeDecisionLead(
      deps,
      { question, context: contextText, options: ["Caminho A", "Caminho B"] },
      TULIO_SESSION,
    );
    check(
      `[${label}] 1.1 decision_lead retorna confirmação de standby`,
      typeof res === "string" && res.includes("Emergency decision requested from the lead") && res.includes("standby"),
      res,
    );
    // TICKET-RELEASE-15: o wake resolve o modelo bound via session.get (async)
    // antes de disparar — drena as microtasks para a captura de transporte.
    await new Promise((r) => setImmediate(r));

    const teamRow = db
      .query("SELECT awaiting_lead_decision, awaiting_decision_member, awaiting_decision_at FROM team WHERE id = ?")
      .get(TEAM);
    check(`[${label}] 1.2 team marcado awaiting_lead_decision=1`, teamRow.awaiting_lead_decision === 1, `flag=${teamRow.awaiting_lead_decision}`);
    check(`[${label}] 1.3 awaiting_decision_member = 'tulio'`, teamRow.awaiting_decision_member === "tulio", String(teamRow.awaiting_decision_member));
    check(
      `[${label}] 1.4 awaiting_decision_at é timestamp`,
      typeof teamRow.awaiting_decision_at === "number" && teamRow.awaiting_decision_at > 0,
    );
    check(`[${label}] 1.5 hasAwaitingLeadDecision=true`, hasAwaitingLeadDecision(db, TEAM) === true);

    const tulio = db
      .query("SELECT execution_status, status, spawn_context FROM team_member WHERE team_id = ? AND name = 'tulio'")
      .get(TEAM);
    check(`[${label}] 1.6 emissor tulio transicionado para standby`, tulio.execution_status === "standby", tulio.execution_status);
    check(
      `[${label}] 1.7 emissor tulio status ready e spawn_context limpo (runtime standby)`,
      tulio.status === "ready" && (tulio.spawn_context === null || tulio.spawn_context === undefined),
      `status=${tulio.status}`,
    );

    const leadPrompts = calls.promptAsync.filter((c) => c.sessionID === LEAD_SESSION);
    check(
      `[${label}] 1.8 Lead acordado com 1 promptAsync mesmo sob silentLead:true`,
      leadPrompts.length === 1 && deps.config.silentLead === true,
      `count=${leadPrompts.length} silentLead=${deps.config.silentLead}`,
    );
    const p = leadPrompts[0];
    const payload = p?.parts?.[0]?.text;
    check(
      `[${label}] 1.9 payload = [System: EMERGENCY DECISION REQUIRED from tulio]: question\\ncontext`,
      typeof payload === "string" &&
        payload.startsWith(`[System: EMERGENCY DECISION REQUIRED from tulio]: ${question}\n${contextText}`),
      payload?.slice(0, 130),
    );
    check(
      `[${label}] 1.10 payload inclui bloco Options numerado`,
      typeof payload === "string" &&
        payload.includes("Options:") &&
        payload.includes("1. Caminho A") &&
        payload.includes("2. Caminho B"),
    );
    check(`[${label}] 1.11 wake usa o agent do lead (team.lead_agent='dante')`, p?.agent === LEAD_AGENT, String(p?.agent));
    // TICKET-RELEASE-15 (substitui a premissa falsa "modelless = nativo"):
    // rung 0 é o MODELO BOUND da sessão do lead, enviado EXPLICITAMENTE via
    // session.get; o sentinel `variant: "default"` é normalizado para AUSÊNCIA
    // (nunca #default). A cadeia só é caminhada reativamente, após rejeição.
    check(
      `[${label}] 1.12 rung 0 = modelo BOUND da sessão, explícito e sem #default`,
      p !== undefined &&
        p.model?.providerID === "opencode-go" &&
        p.model?.modelID === "deepseek-v4.1-flash" &&
        !("variant" in (p.model ?? {})),
      JSON.stringify(p?.model),
    );
    const chainHead = formatModelSelector(resolveFallbackChainForAgent(deps.config, LEAD_AGENT)[0]);
    check(
      `[${label}] 1.13 chain head do agente coincide com o default resiliente`,
      chainHead === "google/antigravity-gemini-3.8-flash#low",
      chainHead,
    );
    check(`[${label}] 1.14 wake é synthetic:true`, p?.synthetic === true);
    check(
      `[${label}] 1.15 toast de alta prioridade (warning) disparado`,
      calls.toast.some((t) => t.title === "Decision required" && t.variant === "warning"),
      JSON.stringify(calls.toast.map((t) => t.title)),
    );
  }

  /* ================================================================ *
   * 2. WATCHDOG: PAUSA DO AUTOawake DA CLARA COM DECISÃO PENDENTE    *
   * ================================================================ */
  {
    // A flag = 1 foi deixada pelo decision_lead acima. Ninguém busy; atividade antiga.
    db.run("UPDATE team_member SET time_updated = ? WHERE team_id = ?", [now - 120_000, TEAM]);
    db.run("UPDATE team_task SET time_updated = ? WHERE team_id = ?", [now - 120_000, TEAM]);
    // HARNESS-22: decision_lead agora também persiste a pergunta em team_message
    // (delivered=0). lastRoomActivity() inclui MAX(team_message.time_created), então
    // essa linha nova precisa envelhecer junto das demais fontes — sem isso o
    // watchdog enxergaria a sala como "ativa" e não retomaria o autoawake da Clara.
    db.run("UPDATE team_message SET time_created = ? WHERE team_id = ?", [now - 120_000, TEAM]);
    db.run("UPDATE team_member SET execution_status = 'idle', status = 'ready' WHERE team_id = ? AND name = 'clara'", [TEAM]);
    db.run("UPDATE team_member SET last_nudged_at = NULL WHERE team_id = ? AND name = 'clara'", [TEAM]);

    check(`[${label}] 2.0 pré-condição: decisão pendente ativa`, hasAwaitingLeadDecision(db, TEAM) === true);

    calls.promptAsync.length = 0;
    const wd = new Watchdog({
      db,
      client,
      registry,
      ttlMs: 0,
      roomInactivityThresholdMs: 30_000,
      roomInactivityCheckMs: 5_000,
      config: { ...DEFAULT_CONFIG },
    });

    await wd.checkRoomInactivity();
    const paused = calls.promptAsync.filter((c) => c.sessionID === CLARA_SESSION);
    check(
      `[${label}] 2.1 autoawake da Clara PAUSADO com decisão pendente (zero promptAsync)`,
      paused.length === 0,
      `count=${paused.length}`,
    );
    const claraPaused = db
      .query("SELECT execution_status, last_nudged_at FROM team_member WHERE team_id = ? AND name = 'clara'")
      .get(TEAM);
    check(
      `[${label}] 2.2 Clara permanece idle e sem nudge durante a pausa`,
      claraPaused.execution_status === "idle" &&
        (claraPaused.last_nudged_at === null || claraPaused.last_nudged_at === undefined),
      `es=${claraPaused.execution_status}`,
    );

    // O Lead delibera (team_message do lead) -> clear -> watchdog retoma.
    clearAwaitingLeadDecision(db, TEAM);
    check(`[${label}] 2.3 clearAwaitingLeadDecision zera a flag`, hasAwaitingLeadDecision(db, TEAM) === false);
    const cleared = db
      .query("SELECT awaiting_lead_decision, awaiting_decision_member, awaiting_decision_at FROM team WHERE id = ?")
      .get(TEAM);
    check(
      `[${label}] 2.4 clear zera member/at (observabilidade)`,
      cleared.awaiting_lead_decision === 0 && cleared.awaiting_decision_member === null && cleared.awaiting_decision_at === null,
    );

    calls.promptAsync.length = 0;
    await wd.checkRoomInactivity();
    const resumed = calls.promptAsync.filter((c) => c.sessionID === CLARA_SESSION);
    check(
      `[${label}] 2.5 após deliberação, watchdog RETOMA o autoawake da Clara (1 promptAsync)`,
      resumed.length === 1,
      `count=${resumed.length}`,
    );
    check(
      `[${label}] 2.6 wake da Clara é o sintético de inatividade`,
      resumed[0]?.parts?.[0]?.text?.includes("[System: Room has been inactive") && resumed[0]?.synthetic === true,
      resumed[0]?.parts?.[0]?.text?.slice(0, 90),
    );
    const claraResumed = db
      .query("SELECT last_nudged_at FROM team_member WHERE team_id = ? AND name = 'clara'")
      .get(TEAM);
    check(
      `[${label}] 2.7 last_nudged_at gravado na retomada`,
      typeof claraResumed.last_nudged_at === "number" && claraResumed.last_nudged_at > 0,
    );
    wd.stop();
  }

  /* ================================================================ *
   * 3. NEGATIVAS DO decision_lead                                     *
   * ================================================================ */
  {
    const tryErr = async (fn) => {
      try {
        await fn();
        return null;
      } catch (e) {
        return e instanceof Error ? e.message : String(e);
      }
    };
    const leadErr = await tryErr(() => executeDecisionLead(deps, { question: "q", context: "c" }, LEAD_SESSION));
    check(
      `[${label}] 3.1 lead NÃO pode chamar decision_lead`,
      leadErr === "Only teammates can request an emergency decision from the lead.",
      String(leadErr),
    );
    const qErr = await tryErr(() => executeDecisionLead(deps, { question: "   ", context: "c" }, TULIO_SESSION));
    check(`[${label}] 3.2 question vazia rejeitada`, qErr === "decision_lead requires a non-empty 'question'.", String(qErr));
    const cErr = await tryErr(() => executeDecisionLead(deps, { question: "q", context: "" }, TULIO_SESSION));
    check(`[${label}] 3.3 context vazio rejeitado`, cErr === "decision_lead requires a non-empty 'context'.", String(cErr));
    check(`[${label}] 3.4 negativas não marcaram decisão pendente`, hasAwaitingLeadDecision(db, TEAM) === false);
  }

  /* ================================================================ *
   * 4. ANTI-REDUNDÂNCIA: ZERO CLONE [CC Lead] NO SQLITE               *
   * ================================================================ */
  {
    calls.promptAsync.length = 0;
    const msgText = "Relatório parcial: AST validado, sem bloqueios.";
    const ret = await executeTeamMessage(deps, { to: "lead", text: msgText }, MAYA_SESSION);
    check(`[${label}] 4.1 team_message ao lead retorna padrão sob silentLead`, ret === "Message sent to lead.", String(ret));

    const ccRows = db.query("SELECT * FROM team_message WHERE team_id = ? AND content LIKE '%[CC Lead]%'").all(TEAM);
    check(`[${label}] 4.2 ZERO mensagens clonadas [CC Lead] após team_message`, ccRows.length === 0, `rows=${ccRows.length}`);

    const claraMsgs = db
      .query("SELECT * FROM team_message WHERE team_id = ? AND to_name = 'clara' AND from_name = 'maya'")
      .all(TEAM);
    check(`[${label}] 4.3 nenhuma cópia gravada para a Clara`, claraMsgs.length === 0);

    const leadMsgs = db
      .query("SELECT * FROM team_message WHERE team_id = ? AND to_name = 'lead' AND from_name = 'maya'")
      .all(TEAM);
    check(`[${label}] 4.4 mensagem original persistida para o lead`, leadMsgs.length === 1 && leadMsgs[0].content === msgText);
    check(
      `[${label}] 4.5 lead NÃO recebe promptAsync (silentLead preservado)`,
      !calls.promptAsync.some((c) => c.sessionID === LEAD_SESSION),
    );

    insertTask("task_dl_review", "Frente revisável", "in_progress", "tulio");
    db.run("UPDATE team_member SET execution_status = 'running', status = 'ready' WHERE team_id = ? AND name = 'tulio'", [TEAM]);
    calls.promptAsync.length = 0;
    const resSub = await executeTeamTasksComplete(
      deps,
      { task_id: "task_dl_review", action: "submit_review", notes: "Pronto para auditoria" },
      TULIO_SESSION,
    );
    check(
      `[${label}] 4.6 submit_review conclui`,
      typeof resSub === "string" && resSub.includes("Submitted task for review:"),
      resSub,
    );
    const ccAfterSubmit = db.query("SELECT * FROM team_message WHERE team_id = ? AND content LIKE '%CC Lead%'").all(TEAM);
    check(`[${label}] 4.7 ZERO clone [CC Lead] após submit_review`, ccAfterSubmit.length === 0, `rows=${ccAfterSubmit.length}`);
    const totalCc = db
      .query(
        "SELECT COUNT(*) AS c FROM team_message WHERE team_id = ? AND (content LIKE '%[CC Lead]%' OR content LIKE '%CC-Lead%' OR content LIKE '%CC Lead%')",
      )
      .get(TEAM).c;
    check(`[${label}] 4.8 nenhuma variante de CC Lead em todo o board`, totalCc === 0, `count=${totalCc}`);
  }

  /* ================================================================ *
   * 5. PARIDADE V1↔V2 EM RUNTIME (registerV2Tools)                    *
   * ================================================================ */
  {
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
    const v2 = captured.find((t) => t.name === "decision_lead");
    check(`[${label}] 5.1 registerV2Tools registra decision_lead`, !!v2);
    const keys = v2 ? Object.keys(v2.input.properties).sort() : [];
    check(
      `[${label}] 5.2 V2 decision_lead props exatas [context, options, question]`,
      JSON.stringify(keys) === JSON.stringify(["context", "options", "question"]),
      JSON.stringify(keys),
    );
    check(
      `[${label}] 5.3 V2 required [question, context]`,
      JSON.stringify(v2?.input.required) === JSON.stringify(["question", "context"]),
      JSON.stringify(v2?.input.required),
    );
    check(`[${label}] 5.4 V2 additionalProperties:false`, v2?.input.additionalProperties === false);
    check(
      `[${label}] 5.5 V2 options é array<string>`,
      v2?.input.properties.options?.type === "array" && v2?.input.properties.options?.items?.type === "string",
    );
    check(`[${label}] 5.6 descrição V2 menciona silentLead`, v2?.description?.includes("silentLead") === true);
  }

  /* ================================================================ *
   * 6. HARNESS-22 — clearAwaitingLeadDecision SÓ APÓS PERSISTÊNCIA    *
   *    E PERSISTÊNCIA DURÁVEL DA PERGUNTA (team_message, delivered=0) *
   * ================================================================ */
  {
    const tryErr = async (fn) => {
      try {
        await fn();
        return null;
      } catch (e) {
        return e instanceof Error ? e.message : String(e);
      }
    };
    const flagNow = () =>
      db.query("SELECT awaiting_lead_decision FROM team WHERE id = ?").get(TEAM).awaiting_lead_decision;

    /* --- B. decision_lead persiste a pergunta em team_message -------- */
    const question = "Autorizas a publicação do bundle final?";
    const contextText = "O Quality Gate ainda não emitiu veredito sobre o dist.";
    calls.promptAsync.length = 0;
    const leadMsgsBefore = db
      .query("SELECT COUNT(*) AS c FROM team_message WHERE team_id = ? AND from_name = 'tulio' AND to_name = 'lead'")
      .get(TEAM).c;
    const retDL = await executeDecisionLead(deps, { question, context: contextText }, TULIO_SESSION);
    check(
      `[${label}] 6.1 decision_lead retorna confirmação de standby`,
      typeof retDL === "string" && retDL.includes("Emergency decision requested from the lead"),
      retDL,
    );
    const persisted = db
      .query(
        "SELECT from_name, to_name, content, delivered FROM team_message WHERE team_id = ? AND from_name = 'tulio' AND to_name = 'lead' ORDER BY time_created DESC, rowid DESC",
      )
      .all(TEAM);
    check(
      `[${label}] 6.2 decision_lead persistiu exatamente 1 linha nova em team_message`,
      persisted.length === leadMsgsBefore + 1,
      `antes=${leadMsgsBefore} depois=${persisted.length}`,
    );
    const row = persisted[0];
    check(
      `[${label}] 6.3 linha persistida com from='tulio' e to='lead'`,
      !!row && row.from_name === "tulio" && row.to_name === "lead",
      JSON.stringify({ from: row?.from_name, to: row?.to_name }),
    );
    check(
      `[${label}] 6.4 corpo (content) contém a pergunta e o contexto`,
      !!row && row.content.includes(question) && row.content.includes(contextText),
      row?.content?.slice(0, 140),
    );
    check(`[${label}] 6.5 delivered=0 (entrega passiva ao lead)`, !!row && row.delivered === 0, `delivered=${row?.delivered}`);
    check(`[${label}] 6.6 pré-condição para as negativas: awaiting_lead_decision=1`, flagNow() === 1, `flag=${flagNow()}`);

    /* --- A. falha de validação no team_message do lead NÃO zera a flag */
    const badModelErr = await tryErr(() =>
      executeTeamMessage(deps, { to: "clara", text: "deliberação", model: "invalidmodel" }, LEAD_SESSION),
    );
    check(
      `[${label}] 6.7 \`team_message\` do lead com model inválido lança exceção`,
      typeof badModelErr === "string" && /Invalid model/.test(badModelErr),
      String(badModelErr),
    );
    check(
      `[${label}] 6.8 após model inválido, awaiting_lead_decision PERMANECE 1`,
      flagNow() === 1,
      `flag=${flagNow()}`,
    );

    const badRecipientErr = await tryErr(() =>
      executeTeamMessage(deps, { to: "ghost", text: "para fantasma", model: "opencode/mimo-v2.6-flash-free" }, LEAD_SESSION),
    );
    check(
      `[${label}] 6.9 \`team_message\` do lead para destinatário inexistente lança exceção`,
      typeof badRecipientErr === "string" && /not found in team/.test(badRecipientErr),
      String(badRecipientErr),
    );
    check(
      `[${label}] 6.10 após destinatário inexistente, awaiting_lead_decision PERMANECE 1`,
      flagNow() === 1,
      `flag=${flagNow()}`,
    );

    const noPayloadErr = await tryErr(() => executeTeamMessage(deps, { to: "clara" }, LEAD_SESSION));
    check(
      `[${label}] 6.11 \`team_message\` do lead sem 'text' nem 'model' lança exceção`,
      typeof noPayloadErr === "string" && /requires either 'text' or 'model'/.test(noPayloadErr),
      String(noPayloadErr),
    );
    check(
      `[${label}] 6.12 após payload vazio, awaiting_lead_decision PERMANECE 1`,
      flagNow() === 1,
      `flag=${flagNow()}`,
    );

    /* --- A. mensagem VÁLIDA e persistida do lead LIMPA a flag --------- */
    calls.promptAsync.length = 0;
    const validText = "Veredito: autorizado — siga com a publicação.";
    const retValid = await executeTeamMessage(deps, { to: "clara", text: validText }, LEAD_SESSION);
    check(`[${label}] 6.13 \`team_message\` válido do lead retorna sucesso`, retValid === "Message sent to clara.", String(retValid));
    const validRow = db
      .query(
        "SELECT from_name, to_name, content, delivered FROM team_message WHERE team_id = ? AND from_name = 'lead' AND to_name = 'clara' ORDER BY time_created DESC, rowid DESC",
      )
      .get(TEAM);
    check(
      `[${label}] 6.14 deliberação do lead persistida (from='lead', to='clara')`,
      !!validRow && validRow.from_name === "lead" && validRow.to_name === "clara" && validRow.content === validText,
      JSON.stringify(validRow),
    );
    check(
      `[${label}] 6.15 mensagem válida e persistida LIMPA awaiting_lead_decision (=0)`,
      flagNow() === 0 && hasAwaitingLeadDecision(db, TEAM) === false,
      `flag=${flagNow()}`,
    );
  }

  db.close();
}

/* ================================================================== *
 * EXECUÇÃO NAS DUAS CAMADAS: dist E src                              *
 * ================================================================== */
console.log("\n========================================================");
console.log("▶ EXECUTANDO CONTRA O BUNDLE COMPILADO (dist/index.js)");
console.log("========================================================");
const distMods = await import(HARNESS);
await runBehavior("dist", distMods);

console.log("\n========================================================");
console.log("▶ EXECUTANDO CONTRA O CÓDIGO FONTE REAL (src/**/*.ts)");
console.log("========================================================");
const srcMods = {
  ...(await import(`${SRC_COPY}/tools/decision-lead.ts`)),
  ...(await import(`${SRC_COPY}/tools/team-message.ts`)),
  ...(await import(`${SRC_COPY}/tools/team-tasks-complete.ts`)),
  ...(await import(`${SRC_COPY}/watchdog.ts`)),
  ...(await import(`${SRC_COPY}/db.ts`)),
  ...(await import(`${SRC_COPY}/state.ts`)),
  ...(await import(`${SRC_COPY}/config.ts`)),
  ...(await import(`${SRC_COPY}/v2-tools.ts`)),
  MIGRATIONS: (await import(`${SRC_COPY}/schema.ts`)).MIGRATIONS,
};
await runBehavior("src", srcMods);

/* ================================================================== *
 * RESULTADO                                                          *
 * ================================================================== */
check("Z.1 ZERO unhandledRejection detectado ao longo de toda a suíte", unhandled.length === 0, `unhandled=${unhandled.length}`);

const failed = results.filter(([, ok]) => !ok);
console.log(`\nRESULT: ${results.length - failed.length}/${results.length} checks passed`);
if (failed.length) {
  console.log("FALHAS ENCONTRADAS:");
  for (const [name] of failed) console.log(`  - ${name}`);
}
process.exit(failed.length ? 1 : 0);
