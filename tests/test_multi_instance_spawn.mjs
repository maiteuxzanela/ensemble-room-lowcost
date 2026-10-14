#!/usr/bin/env node
/**
 * QUALITY GATE DETERMINÍSTICO — Instâncias Múltiplas de Persona e Trava da Guardiã
 * @maiteuxzanela/ensemble-room-lowcost (TICKET-HARNESS-08 / TASK-03)
 *
 * Guardiã: Clara (Quality Gate).
 *
 * Sob teste (src/ e dist/ REAIS, SQLite real via node:sqlite):
 *   - resolveBasePersona / resolveModel / executeTeamSpawn -> src/tools/team-spawn.ts
 *   - validateMemberName -> src/util.ts (convenção `<persona>_<sufixo>`)
 *
 * Cenários:
 *   1. Spawn simultâneo (Promise.all) de instâncias disjuntas cris-1 e cris-2:
 *      registro real em SQLite + herança de basePersona no modelo
 *      (modelsByAgent[memberName] > modelsByAgent[basePersona] > modelsByAgent[agent]).
 *   2. Herança de contexto da persona base: instância filha recebe o bloco
 *      multi-instance quando a persona canônica existe (membro canônico ativo).
 *   3. Convenção com "_": "lumi_1" normaliza para base "lumi" e herda o modelo.
 *   4. Trava de unicidade da Guardiã: clara-2, segunda "clara" e candidato
 *      configurado como Quality Gate (agent "clara") são bloqueados com erro
 *      determinístico, SEM registro em SQLite e SEM session.create.
 *   5. Guardiã liberada: com a clara original em 'shutdown', a sucessora nasce.
 *   6. Zero mocks em produção sob src/.
 *
 * Uso: node tests/test_multi_instance_spawn.mjs
 * Exit: 0 = todos os checks PASS; 1 = há FAIL.
 */

import { mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";

const REPO = path.resolve(import.meta.dirname, "..");
const PKG = process.env.ENSEMBLE_PKG || REPO;
const DIST = path.join(PKG, "dist/index.js");
const TMP = path.join(REPO, ".test-scratch");
mkdirSync(TMP, { recursive: true });
const HARNESS = path.join(TMP, "_multi_instance_harness.mjs");
const ROOT = path.join(TMP, "multi_instance_suite");
const SRC = path.join(REPO, "src");

const TEAM_ID = "team_multi";
const TEAM_NAME = "tmulti";
const LEAD_SESSION = "ses_lead";

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
  "createDb", "executeTeamSpawn", "MemberRegistry", "ProgressTracker",
  "DEFAULT_CONFIG", "resolveBasePersona", "resolveModel", "validateMemberName",
];
const distRaw = readFileSync(DIST, "utf8");
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

const mods = await import(HARNESS);
const {
  createDb, executeTeamSpawn, MemberRegistry, ProgressTracker,
  DEFAULT_CONFIG, resolveBasePersona, validateMemberName,
} = mods;

// Marcadores estruturais de regressão no dist (trava + normalização).
// O bundle esbuild escapa não-ASCII (\xE3), então inspecionamos trechos ASCII.
check("dist contém a trava de unicidade da Guardiã", distRaw.includes("Quality Gate 'clara' j") && distRaw.includes("admitem inst"));
check("dist normaliza base persona via split(/[-_]/)", /split\(\/\[-_\]\/\)/.test(distRaw));

// ---------------------------------------------------------------------------
// 1. Unitários da normalização de persona base (sem banco).
// ---------------------------------------------------------------------------
check('resolveBasePersona("cris-1") === "cris"', resolveBasePersona("cris-1") === "cris");
check('resolveBasePersona("cris_1") === "cris"', resolveBasePersona("cris_1") === "cris");
check('resolveBasePersona("cris") === "cris"', resolveBasePersona("cris") === "cris");
check('resolveBasePersona("a-b-c") === "a"', resolveBasePersona("a-b-c") === "a");
check('validateMemberName("cris_1") aceita "_"', validateMemberName("cris_1") === undefined);
check('validateMemberName("cris-1") aceita hífen', validateMemberName("cris-1") === undefined);
check('validateMemberName("Cris") rejeita maiúscula', typeof validateMemberName("Cris") === "string");

// ---------------------------------------------------------------------------
// 2. Cliente de sessão de teste (dublê do servidor OpenCode — código de
//    produção sob src/ permanece 100% sem mocks).
// ---------------------------------------------------------------------------
function testClient() {
  const calls = { create: [], promptAsync: [] };
  let seq = 0;
  return {
    calls,
    client: {
      session: {
        create: async (o) => {
          calls.create.push(o);
          seq += 1;
          const label = typeof o.title === "string" ? o.title.split(" ")[0] : `s${seq}`;
          return { data: { id: `ses_${label}_${seq}` } };
        },
        promptAsync: async (o) => {
          calls.promptAsync.push(o);
          return {};
        },
        abort: async () => ({}),
      },
      tui: {
        showToast: async () => ({}),
      },
    },
  };
}

async function runSuite() {
  rmSync(ROOT, { recursive: true, force: true });
  mkdirSync(ROOT, { recursive: true });
  const db = createDb(path.join(ROOT, "ensemble.db"));

  db.query("INSERT INTO project (id, name, path, status, time_created, time_updated) VALUES ('default', 'Default Project', '', 'active', 0, 0) ON CONFLICT DO NOTHING").run();
  db.run("INSERT INTO team (id, name, project_id, lead_session_id, status, delegate, time_created, time_updated, lead_agent) VALUES (?, ?, 'default', ?, 'active', 0, 0, 0, 'build') ON CONFLICT DO NOTHING", [TEAM_ID, TEAM_NAME, LEAD_SESSION]);

  const registry = new MemberRegistry();
  registry.register(LEAD_SESSION, "lead", TEAM_ID);

  const tc = testClient();
  const config = {
    ...DEFAULT_CONFIG,
    modelsByAgent: {
      build: "test/build-model",
      cris: "test/cris-model",
      "cris-2": "test/cris2-specific",
      lumi: "test/lumi-model",
    },
  };
  const deps = {
    db,
    directory: ROOT,
    client: tc.client,
    registry,
    config,
    progressTracker: new ProgressTracker(),
  };

  const member = (name) =>
    db.query("SELECT * FROM team_member WHERE team_id = ? AND name = ?").get(TEAM_ID, name);

  // -------------------------------------------------------------------------
  // 3. Persona canônica ativa na equipe (pré-requisito de herança de contexto)
  // -------------------------------------------------------------------------
  const resCanonical = await executeTeamSpawn(deps, {
    name: "cris", agent: "build", prompt: "Persona canônica da Cris", worktree: false,
  }, LEAD_SESSION);
  check("Spawn da persona canônica 'cris' sem erro", typeof resCanonical === "string");
  const canonical = member("cris");
  check("Persona canônica registrada no SQLite", !!canonical);
  check(
    "Persona canônica usa modelsByAgent[\"cris\"]",
    canonical?.model === "test/cris-model",
    `model=${canonical?.model}`,
  );

  // -------------------------------------------------------------------------
  // 4. Spawn SIMULTÂNEO de instâncias disjuntas cris-1 e cris-2
  // -------------------------------------------------------------------------
  const createCallsBefore = tc.calls.create.length;
  const [res1, res2] = await Promise.all([
    executeTeamSpawn(deps, {
      name: "cris-1", agent: "build", prompt: "Frente A da Cris",
      worktree: false, standby: true,
    }, LEAD_SESSION),
    executeTeamSpawn(deps, {
      name: "cris-2", agent: "build", prompt: "Frente B da Cris",
      worktree: false, standby: true,
    }, LEAD_SESSION),
  ]);
  check("Spawn simultâneo das duas instâncias não lançou erro", typeof res1 === "string" && typeof res2 === "string");
  check(
    "Spawn simultâneo criou exatamente 2 sessões",
    tc.calls.create.length === createCallsBefore + 2,
    `delta=${tc.calls.create.length - createCallsBefore}`,
  );

  const i1 = member("cris-1");
  const i2 = member("cris-2");
  check("Instância cris-1 registrada no SQLite", !!i1);
  check("Instância cris-2 registrada no SQLite", !!i2);
  check(
    "Instâncias disjuntas têm session_id distintos",
    !!i1 && !!i2 && i1.session_id !== i2.session_id,
    `s1=${i1?.session_id} s2=${i2?.session_id}`,
  );
  check(
    "Herança de basePersona: cris-1 recebe modelsByAgent[\"cris\"]",
    i1?.model === "test/cris-model",
    `model=${i1?.model}`,
  );
  check(
    "Prioridade memberName: cris-2 recebe modelsByAgent[\"cris-2\"] (não o da base)",
    i2?.model === "test/cris2-specific",
    `model=${i2?.model}`,
  );
  check(
    "Instâncias nasceram em standby (zero tokens no nascimento)",
    i1?.execution_status === "standby" && i2?.execution_status === "standby",
    `e1=${i1?.execution_status} e2=${i2?.execution_status}`,
  );

  // Herança de contexto da persona base (persona canônica ativa no time)
  const ctx1 = i1?.spawn_context ?? "";
  const ctx2 = i2?.spawn_context ?? "";
  check(
    "cris-1 recebe bloco multi-instance apontando a base \"cris\"",
    ctx1.includes('Multi-instance persona: "cris-1" is an instance of the canonical base persona "cris"'),
  );
  check(
    "cris-1 referencia o membro canônico ativo",
    ctx1.includes('Canonical persona member "cris" is active in this team'),
  );
  check(
    "cris-2 também herda o contexto da persona base",
    ctx2.includes('canonical base persona "cris"') && ctx2.includes('Canonical persona member "cris"'),
  );
  check(
    "Persona canônica NÃO recebe bloco multi-instance (não é instância)",
    !String(canonical?.prompt ?? "").includes("Multi-instance persona")
      && (canonical?.spawn_context ?? null) === null,
  );
  check(
    "Instâncias standby não dispararam promptAsync",
    tc.calls.promptAsync.length === 1,
    `promptAsync=${tc.calls.promptAsync.length}`,
  );

  // -------------------------------------------------------------------------
  // 5. Convenção com "_": lumi_1 -> base "lumi"
  // -------------------------------------------------------------------------
  const resLumi = await executeTeamSpawn(deps, {
    name: "lumi_1", agent: "build", prompt: "Instância sublinhada", worktree: false, standby: true,
  }, LEAD_SESSION);
  check("Spawn de instância com '_' (lumi_1) aceito pela validação", typeof resLumi === "string");
  const lumi = member("lumi_1");
  check("Instância lumi_1 registrada no SQLite", !!lumi);
  check(
    "lumi_1 herda modelsByAgent[\"lumi\"] via normalização de base",
    lumi?.model === "test/lumi-model",
    `model=${lumi?.model}`,
  );
  // Contexto da persona base vem de (a) membro canônico ativo no time ou
  // (b) arquivo canônico ~/.config/opencode/agent/<base>.md — validamos a
  // variante (b) de forma determinística conforme a presença do arquivo.
  let lumiPersonaFileExists = false;
  try {
    lumiPersonaFileExists = statSync(path.join(process.env.HOME ?? "", ".config/opencode/agent/lumi.md")).size > 0;
  } catch { /* arquivo ausente => variante (b) indisponível */ }
  const lumiCtx = String(lumi?.spawn_context ?? "");
  check(
    lumiPersonaFileExists
      ? "lumi_1 herda contexto do arquivo canônico lumi.md (persona canônica existe)"
      : "lumi_1 sem persona canônica => sem bloco multi-instance",
    lumiPersonaFileExists
      ? lumiCtx.includes("Base persona context (lumi.md):")
      : !lumiCtx.includes("Multi-instance persona"),
    `arquivo=${lumiPersonaFileExists}`,
  );

  // Fallback legado: modelsByAgent por tipo de agente continua funcionando
  const resSolo = await executeTeamSpawn(deps, {
    name: "solo-agent", agent: "build", prompt: "Fallback por agent type", worktree: false, standby: true,
  }, LEAD_SESSION);
  check("Spawn de membro sem persona canônica sem erro", typeof resSolo === "string");
  check(
    "Fallback modelsByAgent[agent] preservado para membros sem persona base",
    member("solo-agent")?.model === "test/build-model",
    `model=${member("solo-agent")?.model}`,
  );

  // -------------------------------------------------------------------------
  // 6. Trava de unicidade da Guardiã (Quality Gate)
  // -------------------------------------------------------------------------
  const resClara = await executeTeamSpawn(deps, {
    name: "clara", agent: "clara", prompt: "Guardiã do Quality Gate", worktree: false,
  }, LEAD_SESSION);
  check("Spawn da Guardiã 'clara' sem erro", typeof resClara === "string");
  check("Guardiã registrada e ativa no SQLite", !!member("clara") && member("clara").status !== "shutdown");

  const sessionsBefore = tc.calls.create.length;
  const promptsBefore = tc.calls.promptAsync.length;

  // 6a. Instância concorrente clara-2
  let errClara2 = null;
  try {
    await executeTeamSpawn(deps, {
      name: "clara-2", agent: "build", prompt: "Segunda Guardiã", worktree: false,
    }, LEAD_SESSION);
  } catch (e) {
    errClara2 = e instanceof Error ? e.message : String(e);
  }
  check(
    "clara-2 bloqueada pela trava de unicidade",
    errClara2 !== null && errClara2.includes(`Guardiã do Quality Gate 'clara' já está ativa na equipe '${TEAM_NAME}'`),
    errClara2 ?? "sem erro",
  );
  check(
    "Mensagem da trava declara exclusividade do Quality Gate",
    errClara2 !== null && errClara2.includes("não admitem instâncias concorrentes"),
  );

  // 6b. Segunda "clara" exata
  let errClaraDup = null;
  try {
    await executeTeamSpawn(deps, {
      name: "clara", agent: "clara", prompt: "Duplicata", worktree: false,
    }, LEAD_SESSION);
  } catch (e) {
    errClaraDup = e instanceof Error ? e.message : String(e);
  }
  check(
    "Segunda 'clara' exata bloqueada (nome duplicado)",
    errClaraDup !== null && errClaraDup.includes('already exists'),
    errClaraDup ?? "sem erro",
  );

  // 6c. Nome neutro porém configurado como Quality Gate (agent "clara")
  let errAgentGate = null;
  try {
    await executeTeamSpawn(deps, {
      name: "gate-auditor", agent: "clara", prompt: "Guardiã em nome neutro", worktree: false,
    }, LEAD_SESSION);
  } catch (e) {
    errAgentGate = e instanceof Error ? e.message : String(e);
  }
  check(
    "Candidato com agent \"clara\" bloqueado pela trava",
    errAgentGate !== null && errAgentGate.includes(`Guardiã do Quality Gate 'clara' já está ativa na equipe '${TEAM_NAME}'`),
    errAgentGate ?? "sem erro",
  );

  check(
    "Spawns bloqueados NÃO registraram linha no SQLite",
    !member("clara-2") && !member("gate-auditor"),
  );
  check(
    "Spawns bloqueados NÃO criaram sessão (fail-fast antes de session.create)",
    tc.calls.create.length === sessionsBefore,
    `delta=${tc.calls.create.length - sessionsBefore}`,
  );
  check(
    "Spawns bloqueados NÃO dispararam promptAsync",
    tc.calls.promptAsync.length === promptsBefore,
    `delta=${tc.calls.promptAsync.length - promptsBefore}`,
  );

  // 6d. Circuit breaker intacto: spawn legítimo continua funcionando após bloqueios
  const resAfter = await executeTeamSpawn(deps, {
    name: "worker-pos-bloqueio", agent: "build", prompt: "Spawn pós-trava", worktree: false, standby: true,
  }, LEAD_SESSION);
  check(
    "Spawn legítimo após bloqueios segue operacional (sem trip do circuit breaker)",
    typeof resAfter === "string" && !!member("worker-pos-bloqueio"),
  );

  // -------------------------------------------------------------------------
  // 7. Guardiã liberada: clara original aposentada => sucessora nasce
  // -------------------------------------------------------------------------
  db.run(
    "UPDATE team_member SET status = 'shutdown', time_updated = ? WHERE team_id = ? AND name = 'clara'",
    [Date.now(), TEAM_ID],
  );
  const resRelief = await executeTeamSpawn(deps, {
    name: "clara-2", agent: "clara", prompt: "Guardiã sucessora", worktree: false,
  }, LEAD_SESSION);
  check(
    "Com a Guardiã original em 'shutdown', a sucessora nasce sem erro",
    typeof resRelief === "string",
  );
  check(
    "Guardiã sucessora registrada no SQLite",
    !!member("clara-2") && member("clara-2").status !== "shutdown",
  );

  // -------------------------------------------------------------------------
  // 8. Anti-mock: zero mocks em produção sob src/
  // -------------------------------------------------------------------------
  let mockCount = 0;
  const walk = (dir) => {
    for (const entry of readdirSync(dir)) {
      const full = path.join(dir, entry);
      if (statSync(full).isDirectory()) walk(full);
      else if (entry.endsWith(".ts")) {
        const content = readFileSync(full, "utf8");
        if (/jest\.mock|sinon|vi\.mock|mockImplementation/i.test(content)) mockCount++;
      }
    }
  };
  walk(SRC);
  check("Zero mocks em produção sob src/", mockCount === 0, `achados=${mockCount}`);
}

await runSuite();

const passed = results.filter(([, ok]) => ok).length;
const total = results.length;
console.log(`\nRESULT: ${passed}/${total} checks passed, ${unhandled.length} unhandled rejections`);
process.exit(passed === total && unhandled.length === 0 ? 0 : 1);
