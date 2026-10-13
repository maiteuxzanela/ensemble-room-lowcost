#!/usr/bin/env node
/**
 * QUALITY GATE DETERMINÍSTICO — Roteamento e Auto-Wake da Guardiã Clara
 * @hueyexe/opencode-ensemble@0.18.2
 *
 * Guardiã: Clara (Quality Gate & Integridade dos Testes).
 * Squad: 'clara-room-lead' (TASK-05 / Otávio).
 *
 * Sob teste (código REAL, sem mocks de decisão):
 *   - Auto-wake da Clara em submit_review (team-tasks-complete.ts).
 *   - CC da Clara em mensagens para o Lead sob silentLead: true (team-message.ts).
 *   - Blindagens anti-loop:
 *       (a) Clara falando com Lead não gera CC/wake para si mesma;
 *       (b) Clara submetendo review não gera auto-wake;
 *       (c) Lead falando com subagente não gera CC;
 *       (d) Time sem Clara degrada suavemente sem exceções.
 *   - Paridade e execução determinística em dist/ e src/.
 *
 * Regras:
 *   - SEM MOCKS em código de produção ou testes.
 *   - SQLite REAL (node:sqlite) isolado em .test-scratch/.
 *   - Unhandled rejections causam falha imediata.
 *
 * Uso:  node tests/test_clara_lead_routing.mjs
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

const HARNESS = path.join(TMP, "_clara_routing_harness.mjs");
const SRC_COPY = path.join(TMP, "ensemble_src_clara_routing");
const ROOT = path.join(TMP, "clara_routing_suite");

const results = [];
const check = (name, ok, detail) => {
  results.push([name, ok]);
  console.log(`${ok ? "PASS" : "FAIL"} | ${name}${detail ? " | " + detail : ""}`);
};

const unhandled = [];
process.on("unhandledRejection", (e) => unhandled.push(e));

/* ================================================================== *
 * 0. SINTAXE E PARIDADE TEXTUAL                                      *
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
  "executeTeamMessage",
  "executeTeamTasksComplete",
  "DEFAULT_CONFIG",
  "MIGRATIONS",
  "resolveStandbyWake",
  "lastRoomActivity",
];

const distRaw = readFileSync(DIST, "utf8");
{
  const missing = REQUIRED_SYMBOLS.filter(
    (s) => !new RegExp(`(function|class|var|const|let)\\s+${s}\\b`).test(distRaw),
  );
  check(
    "0.2 dist declara todos os símbolos exigidos para o roteamento da Clara",
    missing.length === 0,
    missing.join(",") || REQUIRED_SYMBOLS.length + " símbolos presentes",
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

/* Paridade textual de marcadores */
function readSrc(rel) {
  return readFileSync(path.join(SRC, rel), "utf8");
}
const srcMsg = readSrc("tools/team-message.ts");
const srcComplete = readSrc("tools/team-tasks-complete.ts");

check(
  "0.4 marcador wake-clara presente em submit_review (src e dist)",
  srcComplete.includes("tasks-complete:wake-clara") && distRaw.includes("tasks-complete:wake-clara"),
);
check(
  "0.5 marcador cc-clara presente em team_message sob silentLead (src e dist)",
  srcMsg.includes("team_message:lead-silenced:cc-clara") && distRaw.includes("team_message:lead-silenced:cc-clara"),
);
check(
  "0.6 prefixo [CC Lead] gravado em team_message (src e dist)",
  srcMsg.includes("[CC Lead]") && distRaw.includes("[CC Lead]"),
);

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
  check("0.7 zero primitivas de mock no bundle de produção", violations === 0);
}

/* ================================================================== *
 * FIXTURES E TRANSPORTE DE SAÍDA                                     *
 * ================================================================== */
function createTestClient(calls, failSessionIds = new Set()) {
  return {
    session: {
      create: async (o) => {
        calls.sessionCreate.push(o);
        return { data: { id: `ses_child_${calls.sessionCreate.length}` } };
      },
      promptAsync: async (o) => {
        calls.promptAsync.push(o);
        if (failSessionIds.has(o.sessionID)) {
          throw new Error(`Injected transport failure for session ${o.sessionID}`);
        }
        return {};
      },
      abort: async (o) => {
        calls.abort.push(o);
        return {};
      },
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
 * SUÍTE COMPORTAMENTAL (executada em dist e src)                      *
 * ================================================================== */
async function runClaraRoutingBehavior(label, mods) {
  const {
    createDb,
    MemberRegistry,
    executeTeamMessage,
    executeTeamTasksComplete,
    DEFAULT_CONFIG,
  } = mods;

  const root = `${ROOT}_${label}`;
  rmSync(root, { recursive: true, force: true });
  mkdirSync(root, { recursive: true });

  const db = createDb(path.join(root, "ensemble.db"));
  const registry = new MemberRegistry();
  const calls = { sessionCreate: [], promptAsync: [], abort: [], toast: [] };
  const failSessions = new Set();
  const client = createTestClient(calls, failSessions);

  const deps = (config = DEFAULT_CONFIG) => ({
    db,
    registry,
    tracker: {},
    purgeApprovals: {},
    client,
    directory: root,
    config,
    progressTracker: { recordTaskComplete: () => {} },
  });

  const TEAM = "team_clara_route";
  const LEAD_SESSION = "ses_lead_r";
  const CLARA_SESSION = "ses_clara_r";
  const TULIO_SESSION = "ses_tulio_r";
  const MAYA_SESSION = "ses_maya_r";

  const now = Date.now();

  // Inserir projeto e time principal com Clara
  db.run("INSERT INTO project (id, name, path, status, time_created, time_updated) VALUES ('default', 'Default', '', 'active', ?, ?) ON CONFLICT DO NOTHING", [now, now]);
  db.run(
    "INSERT INTO team (id, name, project_id, lead_session_id, status, delegate, time_created, time_updated) VALUES (?,?,?,?,?,?,?,?)",
    [TEAM, "squad-routing", "default", LEAD_SESSION, "active", 0, now, now],
  );

  const insertMember = (teamId, name, sessionId, agent, executionStatus = "idle", spawnContext = null) => {
    db.run(
      `INSERT INTO team_member (team_id, name, session_id, agent, status, execution_status, spawn_context, time_created, time_updated, reported_to_lead)
       VALUES (?,?,?,?,?,?,?,?,?,?)`,
      [teamId, name, sessionId, agent, "ready", executionStatus, spawnContext, now, now, 0],
    );
    registry.register(teamId, name, sessionId);
  };

  const insertTask = (id, teamId, content, status, assignee) => {
    db.run(
      "INSERT INTO team_task (id, team_id, content, status, priority, assignee, time_created, time_updated) VALUES (?,?,?,?,?,?,?,?)",
      [id, teamId, content, status, "medium", assignee, now, now],
    );
  };

  // Clara nasce em 'standby' com spawn_context definido
  insertMember(TEAM, "clara", CLARA_SESSION, "clara", "standby", "Diretrizes de Auditoria da Guardiã Clara");
  insertMember(TEAM, "tulio", TULIO_SESSION, "build", "idle");
  insertMember(TEAM, "maya", MAYA_SESSION, "explore", "idle");

  insertTask("task_1", TEAM, "Implementar Contrato A", "in_progress", "tulio");
  insertTask("task_2", TEAM, "Implementar Contrato B", "in_progress", "tulio");
  insertTask("task_3", TEAM, "Auditar AST", "in_progress", "maya");

  /* ================================================================ *
   * 1. AUTO-WAKE DA CLARA EM SUBMIT_REVIEW (Clara em standby)        *
   * ================================================================ */
  {
    calls.promptAsync.length = 0;
    const resSubmit1 = await executeTeamTasksComplete(
      deps(),
      {
        task_id: "task_1",
        action: "submit_review",
        notes: "PR pronto com testes reais determinísticos",
      },
      TULIO_SESSION,
    );

    check(`[${label}] 1.1 submit_review retorna confirmação e indica notificação à Clara`,
      resSubmit1.includes("Submitted task for review:") && resSubmit1.includes("(notified clara for review)"),
      resSubmit1,
    );

    const taskRow = db.query("SELECT status, review_notes FROM team_task WHERE id = 'task_1'").get();
    check(`[${label}] 1.2 tarefa transicionou para in_review no SQLite`, taskRow.status === "in_review");
    check(`[${label}] 1.3 review_notes gravado`, taskRow.review_notes === "PR pronto com testes reais determinísticos");

    const claraRow = db.query("SELECT execution_status FROM team_member WHERE team_id = ? AND name = 'clara'").get(TEAM);
    check(`[${label}] 1.4 Clara transicionou de standby para starting`, claraRow.execution_status === "starting", claraRow.execution_status);

    const promptClara = calls.promptAsync.filter((c) => c.sessionID === CLARA_SESSION);
    check(`[${label}] 1.5 Clara recebeu exatamente 1 promptAsync`, promptClara.length === 1, `count=${promptClara.length}`);
    check(
      `[${label}] 1.6 Prompt da Clara contém spawn_context original prepended`,
      promptClara[0]?.parts?.[0]?.text?.includes("Diretrizes de Auditoria da Guardiã Clara"),
    );
    check(
      `[${label}] 1.7 Prompt da Clara contém aviso sintético de submit_review com notas`,
      promptClara[0]?.parts?.[0]?.text?.includes('[System: Task "task_1" was submitted for review by tulio (notes: PR pronto com testes reais determinísticos)]'),
    );
    check(`[${label}] 1.8 Prompt da Clara tem synthetic: true`, promptClara[0]?.synthetic === true);

    const promptLead = calls.promptAsync.filter((c) => c.sessionID === LEAD_SESSION);
    check(`[${label}] 1.9 Lead em silêncio absoluto no submit_review (zero promptAsync)`, promptLead.length === 0, `leadPrompts=${promptLead.length}`);
  }

  /* ================================================================ *
   * 2. AUTO-WAKE DA CLARA EM SUBMIT_REVIEW (Clara já em ready/idle)   *
   * ================================================================ */
  {
    // Simular que Clara concluiu seu primeiro turno e está agora em ready/idle
    db.run("UPDATE team_member SET execution_status = 'idle' WHERE team_id = ? AND name = 'clara'", [TEAM]);

    calls.promptAsync.length = 0;
    const resSubmit2 = await executeTeamTasksComplete(
      deps(),
      {
        task_id: "task_2",
        action: "submit_review",
        notes: "Contrato B pronto",
      },
      TULIO_SESSION,
    );

    check(`[${label}] 2.1 submit_review com Clara em idle notifica Clara`, resSubmit2.includes("(notified clara for review)"));

    const promptClara = calls.promptAsync.filter((c) => c.sessionID === CLARA_SESSION);
    check(`[${label}] 2.2 Clara em idle recebe promptAsync direto (sem duplicar spawn_context)`, promptClara.length === 1);
    check(
      `[${label}] 2.3 Prompt direto contém aviso sintético`,
      promptClara[0]?.parts?.[0]?.text === '[System: Task "task_2" was submitted for review by tulio (notes: Contrato B pronto)]',
    );
    check(`[${label}] 2.4 Lead permanece em silêncio absoluto`, !calls.promptAsync.some((c) => c.sessionID === LEAD_SESSION));
  }

  /* ================================================================ *
   * 3. ROLLBACK DE STANDBY EM FALHA DE TRANSPORTE (submit_review)     *
   * ================================================================ */
  {
    // Resetar Clara para standby
    db.run("UPDATE team_member SET execution_status = 'standby' WHERE team_id = ? AND name = 'clara'", [TEAM]);
    insertTask("task_fail", TEAM, "Task com Falha de Rede", "in_progress", "tulio");

    failSessions.add(CLARA_SESSION);
    calls.promptAsync.length = 0;

    await executeTeamTasksComplete(
      deps(),
      {
        task_id: "task_fail",
        action: "submit_review",
        notes: "Tentativa com transporte offline",
      },
      TULIO_SESSION,
    );

    // Dar tempo para o .catch fire-and-forget executar
    await new Promise((r) => setTimeout(r, 60));

    const claraRow = db.query("SELECT execution_status FROM team_member WHERE team_id = ? AND name = 'clara'").get(TEAM);
    check(`[${label}] 3.1 Falha de transporte reverte Clara de volta para standby`, claraRow.execution_status === "standby", claraRow.execution_status);

    failSessions.delete(CLARA_SESSION);
  }

  /* ================================================================ *
   * 4. CC DA CLARA AO ENVIAR MENSAGEM AO LEAD (silentLead: true)      *
   * ================================================================ */
  {
    // Resetar Clara para standby com contexto
    db.run(
      "UPDATE team_member SET execution_status = 'standby', spawn_context = 'Contexto Clara CC' WHERE team_id = ? AND name = 'clara'",
      [TEAM],
    );

    calls.promptAsync.length = 0;
    const msgText = "Lead, concluí a análise de AST e estou aguardando próximas orientações.";
    const retMsg = await executeTeamMessage(
      deps(),
      { to: "lead", text: msgText },
      MAYA_SESSION,
    );

    check(`[${label}] 4.1 Retorno para o chamador é o padrão byte-a-byte 'Message sent to lead.'`, retMsg === "Message sent to lead.");

    // (a) Mensagem persistida para o lead
    const leadMsgs = db.query("SELECT * FROM team_message WHERE team_id = ? AND to_name = 'lead' AND from_name = 'maya'").all(TEAM);
    check(`[${label}] 4.2 Mensagem original gravada no SQLite com to='lead'`, leadMsgs.length === 1 && leadMsgs[0].content === msgText);

    // (b) Mensagem CC persistida para a Clara
    const claraMsgs = db.query("SELECT * FROM team_message WHERE team_id = ? AND to_name = 'clara' AND from_name = 'maya'").all(TEAM);
    check(`[${label}] 4.3 Mensagem CC gravada no SQLite com to='clara' e prefixo [CC Lead]`,
      claraMsgs.length === 1 && claraMsgs[0].content === `[CC Lead] ${msgText}`,
      claraMsgs[0]?.content,
    );

    // (c) Lead não recebe nenhum promptAsync
    check(`[${label}] 4.4 Lead NÃO recebe promptAsync (silentLead preservado)`, !calls.promptAsync.some((c) => c.sessionID === LEAD_SESSION));

    // (d) Clara recebe promptAsync e acorda do standby
    const claraPrompts = calls.promptAsync.filter((c) => c.sessionID === CLARA_SESSION);
    check(`[${label}] 4.5 Clara recebeu promptAsync de CC`, claraPrompts.length === 1);
    check(`[${label}] 4.6 Prompt da Clara contém o texto sintético de CC do Lead`,
      claraPrompts[0]?.parts?.[0]?.text?.includes(`[System: Message from maya to lead: ${msgText}]`),
      claraPrompts[0]?.parts?.[0]?.text,
    );
    check(`[${label}] 4.7 Prompt da Clara prependeu o spawn_context (acordou de standby)`,
      claraPrompts[0]?.parts?.[0]?.text?.includes("Contexto Clara CC"),
    );

    const claraRow = db.query("SELECT execution_status FROM team_member WHERE team_id = ? AND name = 'clara'").get(TEAM);
    check(`[${label}] 4.8 Clara transicionou para starting`, claraRow.execution_status === "starting");
  }

  /* ================================================================ *
   * 5. BLINDAGENS ANTI-LOOP                                          *
   * ================================================================ */
  {
    // 5.1 Clara falando com o Lead: NÃO deve disparar CC para si mesma
    calls.promptAsync.length = 0;
    const retClaraToLead = await executeTeamMessage(
      deps(),
      { to: "lead", text: "Relatório de Quality Gate emitido pela Clara." },
      CLARA_SESSION,
    );
    check(`[${label}] 5.1 Retorno de Clara para Lead é normal`, retClaraToLead === "Message sent to lead.");

    const claraSelfCalls = calls.promptAsync.filter((c) => c.sessionID === CLARA_SESSION);
    check(`[${label}] 5.2 Clara enviando mensagem ao Lead NÃO dispara promptAsync para si mesma (anti-loop)`, claraSelfCalls.length === 0, `calls=${claraSelfCalls.length}`);

    const selfCC = db.query("SELECT * FROM team_message WHERE team_id = ? AND from_name = 'clara' AND to_name = 'clara'").all(TEAM);
    check(`[${label}] 5.3 Nenhuma mensagem de auto-CC gerada em team_message`, selfCC.length === 0);

    // 5.2 Clara submetendo review: NÃO deve disparar wake para si mesma
    insertTask("task_clara", TEAM, "Revisão Interna", "in_progress", "clara");
    calls.promptAsync.length = 0;
    const resClaraSubmit = await executeTeamTasksComplete(
      deps(),
      { task_id: "task_clara", action: "submit_review", notes: "Clara revisando" },
      CLARA_SESSION,
    );
    check(`[${label}] 5.4 Clara submetendo review não avisa a si mesma no retorno`, !resClaraSubmit.includes("(notified clara for review)"));
    check(`[${label}] 5.5 Clara submetendo review NÃO dispara promptAsync para si mesma`, !calls.promptAsync.some((c) => c.sessionID === CLARA_SESSION));

    // 5.3 Lead falando com subagente: NÃO dispara CC para Clara
    calls.promptAsync.length = 0;
    // Mock simples de session do lead chamando team_message
    const retLeadToTulio = await executeTeamMessage(
      deps(),
      { to: "tulio", text: "Instruções do Lead para Túlio" },
      LEAD_SESSION,
    );
    check(`[${label}] 5.6 Lead enviando mensagem para subagente sucede`, retLeadToTulio.includes("Message sent to tulio"));
    check(`[${label}] 5.7 Mensagem do Lead para subagente NÃO gera CC para a Clara`, !calls.promptAsync.some((c) => c.sessionID === CLARA_SESSION));
  }

  /* ================================================================ *
   * 6. TIME SEM CLARA (DEGRADAÇÃO SUAVE SEM EXCEÇÕES)                 *
   * ================================================================ */
  {
    const TEAM_NOCLARA = "team_no_clara";
    const LEAD_NC = "ses_lead_nc";
    const PEER_NC = "ses_peer_nc";

    db.run(
      "INSERT INTO team (id, name, project_id, lead_session_id, status, delegate, time_created, time_updated) VALUES (?,?,?,?,?,?,?,?)",
      [TEAM_NOCLARA, "squad-no-clara", "default", LEAD_NC, "active", 0, now, now],
    );
    insertMember(TEAM_NOCLARA, "solo-dev", PEER_NC, "build", "idle");
    insertTask("task_nc", TEAM_NOCLARA, "Task Solo", "in_progress", "solo-dev");

    // Submeter review em time sem Clara
    calls.promptAsync.length = 0;
    let submitErr = null;
    let submitRes = null;
    try {
      submitRes = await executeTeamTasksComplete(
        deps(),
        { task_id: "task_nc", action: "submit_review", notes: "Sem Clara" },
        PEER_NC,
      );
    } catch (e) {
      submitErr = e;
    }

    check(`[${label}] 6.1 submit_review em time sem Clara não lança exceção`, submitErr === null, submitErr?.message);
    check(`[${label}] 6.2 retorno do submit_review sem Clara é limpo`, submitRes?.includes("Submitted task for review:"));
    check(`[${label}] 6.3 nenhum promptAsync disparado no submit_review sem Clara`, calls.promptAsync.length === 0);

    // Mensagem ao Lead em time sem Clara
    let msgErr = null;
    let msgRes = null;
    try {
      msgRes = await executeTeamMessage(
        deps(),
        { to: "lead", text: "Mensagem em time sem Clara" },
        PEER_NC,
      );
    } catch (e) {
      msgErr = e;
    }

    check(`[${label}] 6.4 Mensagem ao Lead em time sem Clara não lança exceção`, msgErr === null, msgErr?.message);
    check(`[${label}] 6.5 Retorno é normal 'Message sent to lead.'`, msgRes === "Message sent to lead.");
    check(`[${label}] 6.6 Nenhum promptAsync disparado (lead segue em silêncio)`, calls.promptAsync.length === 0);
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
await runClaraRoutingBehavior("dist", distMods);

console.log("\n========================================================");
console.log("▶ EXECUTANDO CONTRA O CÓDIGO FONTE REAL (src/**/*.ts)");
console.log("========================================================");
const srcMods = {
  ...(await import(`${SRC_COPY}/tools/team-message.ts`)),
  ...(await import(`${SRC_COPY}/tools/team-tasks-complete.ts`)),
  ...(await import(`${SRC_COPY}/tools/shared.ts`)),
  ...(await import(`${SRC_COPY}/db.ts`)),
  ...(await import(`${SRC_COPY}/state.ts`)),
  ...(await import(`${SRC_COPY}/config.ts`)),
  MIGRATIONS: (await import(`${SRC_COPY}/schema.ts`)).MIGRATIONS,
};
await runClaraRoutingBehavior("src", srcMods);

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
