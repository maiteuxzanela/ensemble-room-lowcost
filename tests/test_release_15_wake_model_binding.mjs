#!/usr/bin/env node
/**
 * QUALITY GATE DETERMINÍSTICO — TICKET-RELEASE-15
 * Wake de lead: modelo BOUND explícito (nunca o modelo do agent/<persona>.md)
 * @maiteuxzanela/ensemble-room-lowcost
 *
 * Engenheiro de Backend: Davi. SDET: Hugo. Guardiã do Quality Gate: Clara.
 *
 * DEFEITO SOB TESTE (incidente 23/10, ses_e95bdc982ffe4Kl5ZgFPrkWxFe): o wake
 * do lead omitia a chave `model` no session.promptAsync. O OpenCode NÃO
 * preserva o modelo bound da sessão nesse caso — ele resolve o modelo pelo
 * arquivo do agente (`agent/<persona>.md`). O lead `nora` estava bound em
 * `opencode-go/deepseek-v4.1-flash`, mas o wake rodou
 * `google/antigravity-gemini-3.8-flash#medium` (o declarado em nora.md) e a
 * cota Antigravity derrubou o turno, deixando o lead mudo.
 *
 * CONTRATOS PROVADOS (código REAL, sem mocks):
 *   A. `src/member-model.ts` — extractSessionBoundModel lê o modelo da sessão
 *      (V2 `data.model`, `id` e o legado `modelID`), normaliza o sentinel
 *      `variant: "default"` para AUSÊNCIA (§5.1) e devolve undefined para
 *      payload malformado; formatParsedModelSelector nunca emite `#default`
 *      a partir de um modelo normalizado.
 *   B. `resolveSessionBoundModel` — resolve via `client.session.get`, nunca
 *      lança; sem get / get com erro / payload sem modelo → undefined + log
 *      explícito `wake:model-resolution-failed` (degradação visível).
 *   C. Wake de fechamento de board (`team-tasks-complete`) — persiste a
 *      team_message durável (from=system, to=lead, delivered=0) ANTES de
 *      acordar e envia `agent` + `model` (bound) EXPLÍCITOS. Prova do cenário
 *      do incidente: sessão deepseek + persona nora cujo .md declara
 *      gemini/antigravity → payload sai deepseek, sem variante, sem #default.
 *   D. `decision_lead` — herda o mesmo wake: agent do lead + modelo bound
 *      explícitos, mesmo com persona cujo .md declara outro modelo; mensagem
 *      durável e toast preservados.
 *   E. Fail-safe — promptAsync do wake de board rejeitado deixa a mensagem
 *      durável (delivered=0) e o system prompt do lead a consome no turno
 *      seguinte (inclui o texto e marca delivered=1; não repete depois).
 *   F. `promptModelAwareWake` — rung 0 = modelo bound resolvido (ou
 *      `boundModel` pré-resolvido); `primaryModel` explícito tem prioridade;
 *      `boundModel: null` dispara síncrono sem modelo; chain[0] NUNCA é rung 0
 *      (só entra após rejeição do rung 0).
 *   G. PROVA DE MUTAÇÃO no bundle dist: reintroduzir a omissão de `model`
 *      (global ou só no board) e a omissão de `agent` deixa sentinelas
 *      VERMELHAS; mutações cirúrgicas preservam os caminhos intactos.
 *
 * SEM MOCKS: SQLite REAL (`node:sqlite` via createDb) em `.test-scratch`,
 * bundle REAL (`dist/index.js`) + cópia mecânica do `src/` (só resolução de
 * extensão de import). O único seam é o TRANSPORTE do SDK (`promptAsync`,
 * `session.get`, `abort`, `showToast`, `app.log`) gravado em arrays de captura
 * — carve-out documentado do repositório. Nenhuma lógica de decisão é
 * substituída.
 *
 * Todas as provas comportamentais rodam contra dist E src.
 *
 * Uso: node tests/test_release_15_wake_model_binding.mjs
 * Exit: 0 = todos os checks PASS; 1 = há FAIL.
 */

import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs"
import path from "node:path"

const REPO = path.resolve(import.meta.dirname, "..")
const PKG = process.env.ENSEMBLE_PKG || REPO
const DIST = path.join(PKG, "dist/index.js")
const SRC = path.join(REPO, "src")
const TMP = path.join(REPO, ".test-scratch")
const ROOT = path.join(TMP, "release15_wake_model_binding")
const HARNESS = path.join(TMP, "_release15_harness.mjs")
mkdirSync(TMP, { recursive: true })
rmSync(ROOT, { recursive: true, force: true })
mkdirSync(ROOT, { recursive: true })

const results = []
const check = (name, ok, detail) => {
  results.push([name, ok])
  console.log(`${ok ? "PASS" : "FAIL"} | ${name}${detail ? " | " + detail : ""}`)
}
const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b)

const unhandled = []
process.on("unhandledRejection", (e) => unhandled.push(e))

/** Flush de microtasks + macrotasks — wakes são fire-and-forget. */
const tick = async (n = 6) => {
  for (let i = 0; i < n; i++) await new Promise((r) => setImmediate(r))
}

/* ================================================================== *
 * 0. SINTAXE — node --check dist/index.js                            *
 * ================================================================== */
{
  const { spawnSync } = await import("node:child_process")
  const r = spawnSync(process.execPath, ["--check", DIST], { encoding: "utf8" })
  check("node --check dist/index.js → exit 0", r.status === 0, `status=${r.status} ${String(r.stderr ?? "").trim().slice(0, 160)}`)
}

/* ================================================================== *
 * 1. HARNESS DO DIST — bundle real + cláusulas de export anexadas    *
 * ================================================================== */
const REQUIRED_SYMBOLS = [
  "createDb", "MemberRegistry", "DEFAULT_CONFIG", "MIGRATIONS",
  "executeTeamTasksComplete", "executeDecisionLead",
  "promptModelAwareWake", "resolveSessionBoundModel", "extractSessionBoundModel",
  "formatParsedModelSelector", "buildLeadSystemPrompt", "initLog",
  "resolveFallbackChainForAgent", "resolveSessionAgent",
]
const distRaw = readFileSync(DIST, "utf8")
let EXPORT_APPEND = ""
{
  const missing = REQUIRED_SYMBOLS.filter(
    (s) => !new RegExp(`(async\\s+)?(function|class|var|const|let)\\s+${s}\\b`).test(distRaw),
  )
  check("dist declara todos os símbolos exigidos pela RELEASE-15", missing.length === 0, missing.join(",") || `${REQUIRED_SYMBOLS.length} símbolos`)
  const existing = distRaw.match(/export\s*\{([^}]*)\}\s*;?\s*$/)?.[1] ?? ""
  const already = new Set(existing.split(",").map((s) => s.trim().split(/\s+as\s+/).pop()).filter(Boolean))
  const need = REQUIRED_SYMBOLS.filter((s) => !already.has(s))
  EXPORT_APPEND = need.length ? `\nexport { ${need.join(", ")} };\n` : ""
  writeFileSync(HARNESS, distRaw + EXPORT_APPEND)
  check(
    "harness do dist = bundle byte-a-byte + apenas cláusulas de export anexadas",
    readFileSync(HARNESS, "utf8") === distRaw + EXPORT_APPEND,
    `${distRaw.length} bytes; anexados=[${need.join(",")}]`,
  )
}

/* ================================================================== *
 * 2. HARNESS DO SRC — cópia mecânica (só extensão de import)          *
 * ================================================================== */
const SRC_COPY = path.join(TMP, "_release15_src_copy")
function prepareSrcCopy() {
  rmSync(SRC_COPY, { recursive: true, force: true })
  cpSync(SRC, SRC_COPY, { recursive: true })
  let rewritten = 0
  const walk = (dir) =>
    readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
      e.isDirectory() ? walk(path.join(dir, e.name)) : [path.join(dir, e.name)],
    )
  for (const file of walk(SRC_COPY)) {
    if (!/\.(ts|tsx)$/.test(file)) continue
    const before = readFileSync(file, "utf8")
    const after = before.replace(/(from\s+["'])(\.\.?\/[^"']+)(["'])/g, (m, a, spec, c) => {
      const base = path.resolve(path.dirname(file), spec)
      for (const ext of [".ts", ".tsx", "/index.ts", "/index.tsx"]) {
        if (existsSync(base + ext) && !spec.endsWith(ext)) {
          rewritten++
          return a + spec + ext + c
        }
      }
      return m
    })
    if (after !== before) writeFileSync(file, after)
  }
  return rewritten
}
check("cópia do src preparada (só resolução de extensão de import, lógica intacta)", prepareSrcCopy() > 0)

async function loadDist() {
  const mod = await import(HARNESS)
  return mod
}

async function loadSrc() {
  const pick = async (rel, names) => {
    const mod = await import(path.join(SRC_COPY, rel))
    return Object.fromEntries(names.map((n) => [n, mod[n]]))
  }
  return {
    ...(await pick("db.ts", ["createDb"])),
    ...(await pick("state.ts", ["MemberRegistry"])),
    ...(await pick("config.ts", ["DEFAULT_CONFIG", "resolveFallbackChainForAgent"])),
    ...(await pick("schema.ts", ["MIGRATIONS"])),
    ...(await pick("member-model.ts", ["extractSessionBoundModel", "formatParsedModelSelector", "resolveSessionBoundModel"])),
    ...(await pick("notify.ts", ["promptModelAwareWake"])),
    ...(await pick("tools/team-tasks-complete.ts", ["executeTeamTasksComplete"])),
    ...(await pick("tools/decision-lead.ts", ["executeDecisionLead"])),
    ...(await pick("system-prompt.ts", ["buildLeadSystemPrompt"])),
    ...(await pick("log.ts", ["initLog"])),
    ...(await pick("lead-agent.ts", ["resolveSessionAgent"])),
  }
}

/* ================================================================== *
 * 3. PARIDADE ESTÁTICA src ↔ dist                                    *
 * ================================================================== */
const markerChecks = [
  {
    label: "member-model normaliza o sentinel 'default' na leitura da sessão",
    needle: /rawVariant !== VARIANT_ABSENT_SENTINEL/,
  },
  {
    label: "formatParsedModelSelector só emite variante quando ela é real",
    needle: /model\.variant \? `\$\{model\.providerID\}\/\$\{model\.modelID\}#\$\{model\.variant\}` : `\$\{model\.providerID\}\/\$\{model\.modelID\}`/,
  },
  {
    label: "resolveSessionBoundModel lê client.session.get (nunca o .md do agente)",
    needle: /const res = await client\.session\.get\(\{ sessionID \}\)/,
  },
  {
    label: "falha de resolução é logada (nunca omissão silenciosa)",
    needle: /wake:model-resolution-failed/,
  },
  {
    label: "board wake persiste a mensagem durável antes do wake",
    needle: /from: "system",\s*to: "lead",\s*content: wakeText/,
  },
  {
    label: "board wake entrega boundModel pré-resolvido ao wake model-aware",
    needle: /boundModel: boundModel \?\? null/,
  },
  {
    label: "promptModelAwareWake tem caminho FRIO de resolução do modelo bound",
    needle: /resolveSessionBoundModel\(client, sessionID\)/,
  },
  {
    label: "rung 0 do dispatch usa o primary resolvido (nunca chain[0])",
    needle: /const ladder(:\s*[^=]+)?\s*=\s*\[primary \|\| (undefined|void 0)\]/,
  },
]
const srcMarkerText = ["member-model.ts", "notify.ts", "tools/team-tasks-complete.ts"]
  .map((rel) => readFileSync(path.join(SRC, rel), "utf8"))
  .join("\n")
for (const { label, needle } of markerChecks) {
  // RegExp com flag `g` não é usado aqui: uma instância por verificação.
  const inSrc = new RegExp(needle.source, needle.flags).test(srcMarkerText)
  const inDist = new RegExp(needle.source, needle.flags).test(distRaw)
  check(`paridade src↔dist: ${label}`, inSrc && inDist, `src=${inSrc} dist=${inDist}`)
}

/* ================================================================== *
 * 4. ANTI-MOCK (fail-fast) — src e bundle                             *
 * ================================================================== */
{
  const FORBIDDEN = [
    /\bMagicMock\b/, /\bjest\.(mock|fn|spyOn)\b/, /\bvi\.(mock|fn|spyOn)\b/,
    /\bsinon\b/, /unittest\.mock/, /mock\.patch\(/, /\bt\.mock\b/,
    /from\s+["'](sinon|testdouble|mock-fs|mockjs)["']/, /require\(["'](sinon|testdouble|mock-fs)["']\)/,
    /\bmockMethod\(/, /\bspyOn\(/,
  ]
  const walk = (dir) =>
    readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
      e.isDirectory() ? walk(path.join(dir, e.name)) : [path.join(dir, e.name)],
    )
  const offenders = []
  for (const file of walk(SRC_COPY)) {
    if (!/\.tsx?$/.test(file)) continue
    const text = readFileSync(file, "utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "")
    for (const rx of FORBIDDEN) if (rx.test(text)) offenders.push(`${path.relative(SRC_COPY, file)} :: ${rx}`)
  }
  check("zero mocks/stubs/spies em produção (src/**/*.ts, comentários desconsiderados)", offenders.length === 0, offenders.join(" | "))
  check("zero primitivas de mock no bundle", !/MagicMock|jest\.mock|sinon\.|vi\.mock/.test(distRaw))
}

/* ================================================================== *
 * 5. FIXTURES REAIS — SQLite, transport recorder, cenários            *
 * ================================================================== */
const DEEPSEEK = { providerID: "opencode-go", id: "deepseek-v4.1-flash", variant: "default" }
const DEEPSEEK_EXPECTED = { providerID: "opencode-go", modelID: "deepseek-v4.1-flash" }
// O que `agent/nora.md` DECLARA no incidente — o wake NÃO pode usar isto.
const NORA_MD_DECLARED = { providerID: "google", modelID: "antigravity-gemini-3.8-flash", variant: "medium" }

let dbSeq = 0
function makeDb(mod, tag) {
  const file = path.join(ROOT, `r15_${tag}_${process.pid}_${dbSeq++}.sqlite`)
  rmSync(file, { force: true })
  rmSync(`${file}-wal`, { force: true })
  rmSync(`${file}-shm`, { force: true })
  return mod.createDb(file)
}

/**
 * Transport recorder. `session.get` é o seam de LEITURA da sessão (o plugin
 * pergunta ao server qual o modelo bound); `promptAsync` é o transporte de
 * SAÍDA. `onPrompt` roda NO INSTANTE da chamada para provar ordenação
 * (ex.: mensagem durável já existe quando o wake sai).
 */
function makeClient(calls, cfg = {}) {
  const failOnce = cfg.failOnce ?? new Set()
  return {
    session: {
      create: async (o) => {
        calls.sessionCreate.push(o)
        return { data: { id: `ses_child_${calls.sessionCreate.length}` } }
      },
      promptAsync: async (payload) => {
        calls.promptAsync.push(payload)
        if (cfg.onPrompt) cfg.onPrompt(payload)
        if (failOnce.delete(payload.sessionID)) throw new Error("injected transport failure (fail-once)")
        return {}
      },
      abort: async (o) => {
        calls.abort.push(o)
        return {}
      },
      ...(cfg.noGet
        ? {}
        : {
            get: async ({ sessionID }) => {
              calls.sessionGet.push({ sessionID })
              if (cfg.getThrows) throw new Error("session.get unavailable")
              return { data: { agent: cfg.sessionAgent, model: cfg.sessionModel } }
            },
          }),
    },
    tui: {
      showToast: async (o) => {
        calls.toast.push(o)
        return {}
      },
      selectSession: async () => ({}),
    },
    app: {
      log: async (p) => {
        calls.logs.push(p.message)
        return {}
      },
    },
  }
}
const newCalls = () => ({ sessionCreate: [], promptAsync: [], sessionGet: [], abort: [], toast: [], logs: [], durableAtWake: [] })

async function withHome(root, fn) {
  const prev = process.env.HOME
  process.env.HOME = root
  try {
    return await fn()
  } finally {
    process.env.HOME = prev
  }
}

function writeAgentMd(homeRoot, agent, declared) {
  const dir = path.join(homeRoot, ".config", "opencode", "agent")
  mkdirSync(dir, { recursive: true })
  const file = path.join(dir, `${agent}.md`)
  writeFileSync(
    file,
    `---\nmodel: ${declared.providerID}/${declared.modelID}#${declared.variant}\n---\nPersona ${agent} — fixture versionada da suíte.\n`,
  )
  return file
}

function seedTeam(mod, db, { teamId, leadSession, leadAgent = null }) {
  db.run(
    "INSERT INTO team (id, name, project_id, lead_session_id, status, delegate, time_created, time_updated, lead_agent) VALUES (?,?,?,?,?,?,?,?,?)",
    [teamId, `name-${teamId}`, "default", leadSession, "active", 0, Date.now(), Date.now(), leadAgent],
  )
}
function seedMember(mod, db, registry, { teamId, memberName, sessionId }) {
  db.run(
    `INSERT INTO team_member (team_id, name, session_id, agent, status, execution_status, time_created, time_updated)
     VALUES (?,?,?,?,?,?,?,?)`,
    [teamId, memberName, sessionId, "build", "ready", "idle", Date.now(), Date.now()],
  )
  registry.register(teamId, memberName, sessionId)
}
function seedTask(db, id, teamId, assignee) {
  db.run(
    "INSERT INTO team_task (id, team_id, content, status, priority, assignee, time_created, time_updated) VALUES (?,?,?,?,?,?,?,?)",
    [id, teamId, `task ${id}`, "pending", "medium", assignee, Date.now(), Date.now()],
  )
}

/**
 * Fecha o board de uma sala real (2 tarefas) e devolve o wake do lead.
 * `armMd` liga o fixture do `agent/<persona>.md` no HOME isolado: o arquivo
 * declara o modelo do incidente (gemini/antigravity) enquanto a SESSÃO está
 * bound em deepseek — o payload do wake precisa sair deepseek.
 */
async function boardProbe(mod, tag, opts = {}) {
  const {
    leadAgent = "nora",
    sessionAgent = "nora",
    sessionModel = DEEPSEEK,
    failLead = false,
    getThrows = false,
    noGet = false,
    armMd = false,
    memberName = "m1",
  } = opts
  const db = makeDb(mod, `board_${tag}`)
  const registry = new mod.MemberRegistry()
  const calls = newCalls()
  const failOnce = new Set()
  const teamId = `team_${tag}`
  const lead = `ses_lead_${tag}`
  const memberSession = `ses_member_${tag}`

  seedTeam(mod, db, { teamId, leadSession: lead, leadAgent })
  seedMember(mod, db, registry, { teamId, memberName, sessionId: memberSession })
  seedTask(db, `${tag}_t1`, teamId, memberName)
  seedTask(db, `${tag}_t2`, teamId, memberName)

  const durableCount = () =>
    db.query("SELECT COUNT(*) c FROM team_message WHERE team_id=? AND from_name='system' AND to_name='lead'").get(teamId).c

  const client = makeClient(calls, {
    sessionModel,
    sessionAgent,
    failOnce,
    getThrows,
    noGet,
    onPrompt: (payload) => {
      if (payload.sessionID === lead) calls.durableAtWake.push(durableCount())
    },
  })
  if (failLead) failOnce.add(lead)
  mod.initLog(client)

  const deps = {
    db, registry, tracker: {}, purgeApprovals: {}, client,
    directory: ROOT, config: mod.DEFAULT_CONFIG, progressTracker: {},
  }
  const run = async () => {
    await mod.executeTeamTasksComplete(deps, { task_id: `${tag}_t1` }, memberSession)
    await mod.executeTeamTasksComplete(deps, { task_id: `${tag}_t2` }, memberSession)
  }
  const homeRoot = path.join(ROOT, `home_${tag}`)
  let mdFile = null
  if (armMd) mdFile = writeAgentMd(homeRoot, leadAgent, NORA_MD_DECLARED)
  if (armMd) await withHome(homeRoot, run)
  else await run()
  await tick()

  const wakes = calls.promptAsync.filter((p) => p.sessionID === lead)
  const durable = db.query("SELECT id, from_name, content, delivered FROM team_message WHERE team_id=? ORDER BY time_created ASC").all(teamId)
  const boardWakeText = `[System: All team tasks completed on board by ${memberName}]`
  const result = {
    db, calls, teamId, lead, memberName, wakes, wake: wakes[0], durable, boardWakeText, mdFile,
    close: () => db.close(),
  }
  return result
}

/** Chamada direta de promptModelAwareWake (sem DB) — prova o rung 0/frio. */
async function coldProbe(mod, tag, opts = {}) {
  const {
    sessionID = `ses_cold_${tag}`,
    sessionModel = DEEPSEEK,
    sessionAgent = undefined,
    primaryModel = undefined,
    boundModel = undefined,
    cfg = undefined,
    agent = undefined,
    failOnce = false,
    noGet = false,
    getThrows = false,
  } = opts
  const calls = newCalls()
  const failSet = failOnce ? new Set([sessionID]) : new Set()
  const client = makeClient(calls, { sessionModel, sessionAgent, noGet, getThrows, failOnce: failSet })
  mod.initLog(client)
  mod.promptModelAwareWake(client, {
    sessionID,
    text: `[System: cold probe ${tag}]`,
    logTag: `probe:${tag}`,
    ...(agent ? { agent } : {}),
    ...(cfg ? { config: cfg } : {}),
    ...(primaryModel !== undefined ? { primaryModel } : {}),
    ...(boundModel !== undefined ? { boundModel } : {}),
  })
  const sync = calls.promptAsync.length
  await tick()
  return { sync, calls, attempts: calls.promptAsync }
}

/* ================================================================== *
 * 6. COMPORTAMENTO — dist e src                                       *
 * ================================================================== */
async function runBehavior(label, mod) {
  const t = (s) => `[${label}] ${s}`
  check(
    t("API comportamental carregada"),
    REQUIRED_SYMBOLS.every((s) => mod[s] !== undefined),
    REQUIRED_SYMBOLS.filter((s) => mod[s] === undefined).join(",") || "ok",
  )

  /* ---------------------------------------------------------------- *
   * A. Helpers puros: extractSessionBoundModel / formatSelector       *
   * ---------------------------------------------------------------- */
  {
    check(t("A1 extractSessionBoundModel lê V2 data.model e normaliza variant 'default' para ausência"),
      eq(mod.extractSessionBoundModel({ data: { model: { providerID: "opencode-go", id: "deepseek-v4.1-flash", variant: "default" } } }), DEEPSEEK_EXPECTED),
      JSON.stringify(mod.extractSessionBoundModel({ data: { model: { providerID: "opencode-go", id: "deepseek-v4.1-flash", variant: "default" } } })))
    check(t("A2 extractSessionBoundModel aceita variante real ('low')"),
      eq(mod.extractSessionBoundModel({ model: { providerID: "p", id: "m", variant: "low" } }), { providerID: "p", modelID: "m", variant: "low" }))
    check(t("A3 extractSessionBoundModel aceita o legado modelID e o aninhamento data.data.model"),
      eq(mod.extractSessionBoundModel({ data: { data: { model: { providerID: "p", modelID: "legacy" } } } }), { providerID: "p", modelID: "legacy" }))
    check(t("A4 extractSessionBoundModel devolve undefined para payload malformado/ausente"),
      mod.extractSessionBoundModel(null) === undefined &&
        mod.extractSessionBoundModel({}) === undefined &&
        mod.extractSessionBoundModel({ model: { providerID: "p", id: "   " } }) === undefined &&
        mod.extractSessionBoundModel({ model: { id: "m" } }) === undefined)
    check(t("A5 formatParsedModelSelector: sem variante = provider/model; com variante = provider/model#variant"),
      mod.formatParsedModelSelector({ providerID: "p", modelID: "m" }) === "p/m" &&
        mod.formatParsedModelSelector({ providerID: "p", modelID: "m", variant: "low" }) === "p/m#low")
    const normalized = mod.extractSessionBoundModel({ data: { model: DEEPSEEK } })
    check(t("A6 modelo normalizado do server NUNCA formata '#default'"),
      mod.formatParsedModelSelector(normalized) === "opencode-go/deepseek-v4.1-flash" &&
        !mod.formatParsedModelSelector(normalized).includes("#default"),
      mod.formatParsedModelSelector(normalized))
  }

  /* ---------------------------------------------------------------- *
   * B. resolveSessionBoundModel: degradação visível, nunca exceção    *
   * ---------------------------------------------------------------- */
  {
    const okClient = makeClient(newCalls(), { sessionModel: DEEPSEEK, sessionAgent: "nora" })
    check(t("B1 resolveSessionBoundModel devolve o modelo bound da sessão"),
      eq(await mod.resolveSessionBoundModel(okClient, "ses_b1"), DEEPSEEK_EXPECTED),
      JSON.stringify(await mod.resolveSessionBoundModel(okClient, "ses_b1")))

    const callsNoGet = newCalls()
    const noGetClient = makeClient(callsNoGet, { noGet: true })
    mod.initLog(noGetClient)
    const rNoGet = await mod.resolveSessionBoundModel(noGetClient, "ses_b2")
    check(t("B2 sem client.session.get → undefined + log reason=no-session-get"),
      rNoGet === undefined && callsNoGet.logs.some((m) => m.includes("wake:model-resolution-failed") && m.includes("reason=no-session-get")),
      JSON.stringify(callsNoGet.logs))

    const callsThrow = newCalls()
    const throwClient = makeClient(callsThrow, { getThrows: true })
    mod.initLog(throwClient)
    const rThrow = await mod.resolveSessionBoundModel(throwClient, "ses_b3")
    check(t("B3 session.get que lança → undefined + log reason=session-get-error"),
      rThrow === undefined && callsThrow.logs.some((m) => m.includes("reason=session-get-error")),
      JSON.stringify(callsThrow.logs))

    const callsNoModel = newCalls()
    const noModelClient = makeClient(callsNoModel, { sessionModel: null })
    mod.initLog(noModelClient)
    const rNoModel = await mod.resolveSessionBoundModel(noModelClient, "ses_b4")
    check(t("B4 payload sem modelo → undefined + log reason=no-bound-model"),
      rNoModel === undefined && callsNoModel.logs.some((m) => m.includes("reason=no-bound-model")),
      JSON.stringify(callsNoModel.logs))

    const callsEmpty = newCalls()
    const emptyClient = makeClient(callsEmpty, { sessionModel: DEEPSEEK })
    check(t("B5 sessionID vazio → undefined sem round-trip"),
      (await mod.resolveSessionBoundModel(emptyClient, "")) === undefined && callsEmpty.sessionGet.length === 0)
  }

  /* ---------------------------------------------------------------- *
   * C. Board wake: agent+model bound explícitos (cenário do incidente) *
   * ---------------------------------------------------------------- */
  {
    const p = await boardProbe(mod, `${label}_board`, { armMd: true })
    const w = p.wake
    check(t("C1 board fechado: wake do lead EXATAMENTE 1x"), p.wakes.length === 1, `wakes=${p.wakes.length}`)
    check(t("C2 wake envia 'model' EXPLÍCITO = modelo bound da sessão (deepseek)"),
      eq(w?.model, DEEPSEEK_EXPECTED), JSON.stringify(w?.model))
    check(t("C3 variante 'default' do server NÃO vaza como #default/variant no payload"),
      w !== undefined && w.model !== undefined && !("variant" in w.model) && !JSON.stringify(w).includes("#default") && !JSON.stringify(w).includes('"variant":"default"'),
      JSON.stringify(w?.model))
    check(t("C4 wake envia 'agent' EXPLÍCITO = persona real da sala (nora)"),
      w?.agent === "nora", String(w?.agent))
    check(t("C5 payload INDEPENDE do modelo declarado em agent/nora.md (gemini/antigravity)"),
      p.mdFile !== null &&
        readFileSync(p.mdFile, "utf8").includes("google/antigravity-gemini-3.8-flash#medium") &&
        JSON.stringify(w?.model) === JSON.stringify(DEEPSEEK_EXPECTED) &&
        !JSON.stringify(w).includes("antigravity") &&
        !JSON.stringify(w).includes(NORA_MD_DECLARED.modelID),
      `${JSON.stringify(w?.model)} vs .md=${NORA_MD_DECLARED.providerID}/${NORA_MD_DECLARED.modelID}`)
    check(t("C6 mensagem durável (from=system, to=lead, delivered=0) já existe QUANDO o wake sai"),
      p.calls.durableAtWake.length === 1 && p.calls.durableAtWake[0] === 1,
      `durableAtWake=${JSON.stringify(p.calls.durableAtWake)}`)
    const row = p.durable.find((m) => m.from_name === "system" && m.content === p.boardWakeText)
    check(t("C7 mensagem durável persiste com o texto exato do fechamento e delivered=0"),
      row !== undefined && row.delivered === 0 && row.content === p.boardWakeText,
      JSON.stringify(row))
    check(t("C8 wake é synthetic:true com o texto do board"),
      w?.synthetic === true && w?.parts?.[0]?.text === p.boardWakeText, JSON.stringify(w?.parts?.[0]?.text))
    p.close()
  }

  /* ---------------------------------------------------------------- *
   * D. Agent fallback via session.get (nunca persona hardcoded)       *
   * ---------------------------------------------------------------- */
  {
    const p = await boardProbe(mod, `${label}_agent_fallback`, { leadAgent: null, sessionAgent: "iris" })
    check(t("D1 lead_agent NULL → agent resolvido via session.get (iris)"),
      p.wake?.agent === "iris", String(p.wake?.agent))
    check(t("D2 modelo bound continua explícito no fallback de agent"),
      eq(p.wake?.model, DEEPSEEK_EXPECTED), JSON.stringify(p.wake?.model))
    p.close()
  }
  {
    const p = await boardProbe(mod, `${label}_agent_unknown`, { leadAgent: null, sessionAgent: null })
    check(t("D3 agent desconhecido → chave 'agent' OMITIDA (nada hardcoded)"),
      p.wake !== undefined && !("agent" in p.wake), p.wake ? `${Object.keys(p.wake).join(",")} agent=${JSON.stringify(p.wake.agent)} gets=${JSON.stringify(p.calls.sessionGet)} logs=${JSON.stringify(p.calls.logs.slice(0, 4))}` : "sem wake")
    check(t("D4 sem agent a sessão ainda recebe o modelo bound explícito"),
      eq(p.wake?.model, DEEPSEEK_EXPECTED), JSON.stringify(p.wake?.model))
    p.close()
  }

  /* ---------------------------------------------------------------- *
   * E. Fail-safe: wake rejeitado deixa a mensagem durável consumível  *
   * ---------------------------------------------------------------- */
  {
    const p = await boardProbe(mod, `${label}_board_fail`, { failLead: true })
    check(t("E1 wake do board foi tentado e rejeitado pelo transporte"), p.wakes.length === 1)
    const before = p.db.query("SELECT id, from_name, content, delivered FROM team_message WHERE team_id=? AND from_name='system' AND to_name='lead'").all(p.teamId)
    check(t("E2 mensagem durável sobrevive à falha do promptAsync (delivered=0)"),
      before.length === 1 && before[0].delivered === 0 && before[0].content === p.boardWakeText,
      JSON.stringify(before))
    const prompt1 = mod.buildLeadSystemPrompt(p.db, p.teamId, mod.DEFAULT_CONFIG)
    check(t("E3 system prompt do lead consome a mensagem no turno seguinte"),
      prompt1.includes(p.boardWakeText) && prompt1.includes("--- Team Messages ---"),
      prompt1.includes(p.boardWakeText) ? "incluída" : "AUSENTE")
    const after = p.db.query("SELECT delivered FROM team_message WHERE id=?").get(before[0].id)
    check(t("E4 consumo marca delivered=1 (sem reentrega eterna)"), after?.delivered === 1, String(after?.delivered))
    const prompt2 = mod.buildLeadSystemPrompt(p.db, p.teamId, mod.DEFAULT_CONFIG)
    check(t("E5 turno seguinte não repete a mensagem já consumida"), !prompt2.includes(p.boardWakeText))
    p.close()
  }

  /* ---------------------------------------------------------------- *
   * F. decision_lead: mesmo contrato (model bound + agent explícitos) *
   * ---------------------------------------------------------------- */
  {
    const db = makeDb(mod, `decision_${label}`)
    const registry = new mod.MemberRegistry()
    const calls = newCalls()
    const teamId = `team_decision_${label}`
    const lead = `ses_decision_lead_${label}`
    const memberName = "d1"
    const memberSession = `ses_decision_member_${label}`
    seedTeam(mod, db, { teamId, leadSession: lead, leadAgent: "nora" })
    seedMember(mod, db, registry, { teamId, memberName, sessionId: memberSession })

    const durableCount = () =>
      db.query("SELECT COUNT(*) c FROM team_message WHERE team_id=? AND from_name=? AND to_name='lead'").get(teamId, memberName).c
    const client = makeClient(calls, {
      sessionModel: DEEPSEEK,
      sessionAgent: "nora",
      onPrompt: (payload) => {
        if (payload.sessionID === lead) calls.durableAtWake.push(durableCount())
      },
    })
    mod.initLog(client)
    const deps = { db, registry, tracker: {}, purgeApprovals: {}, client, directory: ROOT, config: mod.DEFAULT_CONFIG, progressTracker: {} }
    const ret = await mod.executeDecisionLead(
      deps,
      { question: "Publicar a release?", context: "Todos os testes verdes.", options: ["Sim", "Não"] },
      memberSession,
    )
    await tick()
    const wakes = calls.promptAsync.filter((p) => p.sessionID === lead)
    const w = wakes[0]
    check(t("F1 decision_lead acorda o lead 1x (punch-through do silentLead)"), wakes.length === 1 && /standby/.test(ret), `wakes=${wakes.length}`)
    check(t("F2 decision_lead envia 'model' bound explícito (deepseek, sem #default)"),
      eq(w?.model, DEEPSEEK_EXPECTED), JSON.stringify(w?.model))
    check(t("F3 decision_lead envia o agent do lead explícito (nora, não o .md declarado)"),
      w?.agent === "nora" && !JSON.stringify(w).includes("antigravity"), String(w?.agent))
    check(t("F4 pergunta durável já existe quando o wake sai"), calls.durableAtWake.length === 1 && calls.durableAtWake[0] === 1, JSON.stringify(calls.durableAtWake))
    check(t("F5 toast de decisão de emergência disparado"), calls.toast.some((x) => String(x.message).includes("Lead decision required")), `toasts=${calls.toast.length}`)
    db.close()
  }

  /* ---------------------------------------------------------------- *
   * G. promptModelAwareWake: rung 0 bound, prioridade e ladder        *
   * ---------------------------------------------------------------- */
  {
    const cold = await coldProbe(mod, `${label}_cold`)
    check(t("G1 caminho FRIO resolve o modello bound via session.get (1 round-trip antes do wake)"),
      cold.sync === 0 && cold.attempts.length === 1 && cold.calls.sessionGet.length === 1,
      `sync=${cold.sync} attempts=${cold.attempts.length} gets=${cold.calls.sessionGet.length}`)
    check(t("G2 rung 0 do caminho frio = modelo bound explícito, sem variante"),
      cold.attempts.length === 1 && eq(cold.attempts[0].model, DEEPSEEK_EXPECTED),
      JSON.stringify(cold.attempts[0]?.model))
  }
  {
    const cold = await coldProbe(mod, `${label}_bound_null`, { boundModel: null, noGet: true })
    check(t("G3 boundModel:null (resolução tentada sem modelo) dispara SÍNCRONO e sem 'model'"),
      cold.sync === 1 && cold.attempts.length === 1 && !("model" in cold.attempts[0]) && cold.calls.sessionGet.length === 0,
      `sync=${cold.sync} keys=${Object.keys(cold.attempts[0] ?? {}).join(",")}`)
  }
  {
    const cold = await coldProbe(mod, `${label}_primary_wins`, {
      primaryModel: "prov/explicit#high",
      boundModel: { providerID: "prov", modelID: "bound" },
      noGet: true,
    })
    check(t("G4 primaryModel explícito tem prioridade sobre boundModel (rung 0 síncrono)"),
      cold.sync === 1 && cold.attempts.length === 1 && eq(cold.attempts[0].model, { providerID: "prov", modelID: "explicit", variant: "high" }),
      JSON.stringify(cold.attempts[0]?.model))
  }
  {
    const cfg = { ...mod.DEFAULT_CONFIG, fallbackModels: ["prov/chain-1#low"], fallbackModelsByAgent: {} }
    const cold = await coldProbe(mod, `${label}_ladder`, { cfg, failOnce: true })
    check(t("G5 rejeição do rung 0 bound caminha a cadeia reativa (2 tentativas)"),
      cold.attempts.length === 2, `attempts=${cold.attempts.length}`)
    check(t("G6 rung 0 = bound; chain[0] só entra como rung 1 (nunca como degrau 0)"),
      eq(cold.attempts[0]?.model, DEEPSEEK_EXPECTED) &&
        eq(cold.attempts[1]?.model, { providerID: "prov", modelID: "chain-1", variant: "low" }),
      JSON.stringify(cold.attempts.map((a) => a.model)))
  }
  {
    const cold = await coldProbe(mod, `${label}_no_bound`, { sessionModel: null })
    check(t("G7 sessão sem modelo bound → 1 tentativa modelless (degradação) + log explícito"),
      cold.attempts.length === 1 && !("model" in cold.attempts[0]) &&
        cold.calls.logs.some((m) => m.includes("wake:model-resolution-failed")),
      `attempts=${cold.attempts.length} logs=${JSON.stringify(cold.calls.logs.slice(0, 3))}`)
  }
  {
    const cold = await coldProbe(mod, `${label}_get_throws`, { getThrows: true })
    check(t("G8 session.get com erro → wake ainda sai (modelless) sem unhandledRejection"),
      cold.attempts.length === 1 && !("model" in cold.attempts[0]) &&
        cold.calls.logs.some((m) => m.includes("reason=session-get-error")),
      JSON.stringify(cold.calls.logs.slice(0, 3)))
  }
}

/* ================================================================== *
 * 7. PROVA DE MUTAÇÃO — sobre o bundle dist                          *
 * ================================================================== */
async function runMutations() {
  const MUTATIONS = [
    {
      id: "M1",
      desc: "omissão de `model` reintroduzida no promptAsync (o defeito do incidente)",
      from: "        ...parsed ? { model: parsed } : {},\n",
      to: "",
      // Mesmo cenário real do incidente: sessão deepseek + persona nora.
      verify: async (mut) => {
        const board = await boardProbe(mut, "mut_m1_board", { armMd: true })
        const cold = await coldProbe(mut, "mut_m1_cold")
        const boardDetected = board.wake !== undefined && !("model" in board.wake)
        const coldDetected = cold.attempts.length === 1 && !("model" in cold.attempts[0])
        board.close()
        return {
          detected: boardDetected && coldDetected,
          detail: `boardKeys=${Object.keys(board.wake ?? {}).join(",")} coldModel=${JSON.stringify(cold.attempts[0]?.model)}`,
        }
      },
    },
    {
      id: "M2",
      desc: "board wake volta a passar boundModel:null (fechamento de board modelless)",
      from: "        boundModel: boundModel ?? null\n",
      to: "        boundModel: null\n",
      verify: async (mut) => {
        const board = await boardProbe(mut, "mut_m2_board", { armMd: true })
        const cold = await coldProbe(mut, "mut_m2_cold")
        const boardDetected = board.wake !== undefined && !("model" in board.wake)
        // Mutação CIRÚRGICA: o caminho frio do promptModelAwareWake segue intacto.
        const coldUnaffected = cold.attempts.length === 1 && eq(cold.attempts[0]?.model, DEEPSEEK_EXPECTED)
        board.close()
        return {
          detected: boardDetected && coldUnaffected,
          detail: `boardKeys=${Object.keys(board.wake ?? {}).join(",")} coldModel=${JSON.stringify(cold.attempts[0]?.model)}`,
        }
      },
    },
    {
      id: "M3",
      desc: "board wake volta a omitir `agent` (persona sequestrável pelo default do server)",
      from: "        agent: leadAgent,\n",
      to: "",
      verify: async (mut) => {
        const board = await boardProbe(mut, "mut_m3_board", { armMd: true })
        const cold = await coldProbe(mut, "mut_m3_cold")
        const boardDetected = board.wake !== undefined && !("agent" in board.wake) && eq(board.wake.model, DEEPSEEK_EXPECTED)
        const coldUnaffected = cold.attempts.length === 1 && eq(cold.attempts[0]?.model, DEEPSEEK_EXPECTED)
        board.close()
        return {
          detected: boardDetected && coldUnaffected,
          detail: `boardKeys=${Object.keys(board.wake ?? {}).join(",")} agent=${JSON.stringify(board.wake?.agent)}`,
        }
      },
    },
  ]

  for (const m of MUTATIONS) {
    const occurrences = distRaw.split(m.from).length - 1
    check(`${m.id}: patch cirúrgico aplicável (1 ocorrência exata no dist)`, occurrences === 1, `ocorrências=${occurrences}`)
    if (occurrences !== 1) continue

    const mutantFile = path.join(TMP, `_release15_mutant_${m.id}.mjs`)
    writeFileSync(mutantFile, distRaw.split(m.from).join(m.to) + EXPORT_APPEND)
    let outcome
    try {
      const mutant = await import(mutantFile)
      outcome = await m.verify(mutant)
    } catch (err) {
      check(`${m.id}: mutante executável (fluxo roda por completo)`, false, (err && err.stack) || String(err))
      continue
    }
    check(`${m.id}: mutante executável (fluxo roda por completo)`, outcome !== undefined)
    check(
      `${m.id}: suíte SENSÍVEL — mutação detectada [${m.desc}]`,
      outcome?.detected === true,
      outcome?.detail,
    )
  }
}

/* ================================================================== *
 * 8. EXECUÇÃO — dist (artefato real) e src (fonte real)              *
 * ================================================================== */
const distMods = await loadDist()
await runBehavior("dist", distMods)

const srcMods = await loadSrc()
await runBehavior("src", srcMods)

await runMutations()

check("ZERO unhandledRejection ao longo de toda a suíte", unhandled.length === 0, `${unhandled.length}`)

/* ================================================================== *
 * 9. VEREDITO                                                        *
 * ================================================================== */
const failed = results.filter(([, ok]) => !ok)
console.log(`\nRESULT: ${results.length - failed.length}/${results.length} checks passed`)
if (failed.length) {
  console.log("FALHAS:")
  for (const [name] of failed) console.log(`  - ${name}`)
}
process.exit(failed.length ? 1 : 0)
