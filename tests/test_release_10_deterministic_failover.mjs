#!/usr/bin/env node
/**
 * QUALITY GATE DETERMINÍSTICO — TICKET-RELEASE-10 (Frente F2)
 * @maiteuxzanela/ensemble-room-lowcost
 *
 * Engenheiro de Backend: Davi. SDET: Hugo. Guardiã do Quality Gate: Clara.
 *
 * Frente F2 sob teste (código REAL, sem mocks):
 *   - src/hooks.ts  → isModelResolutionFailure / extractFailedModelSelector
 *                     evaluateDeterministicFailover, handleRetryModelFailover
 *                     (membro e sessão isolada/lead) e o seam NOVO
 *                     handleModelNotFoundSessionError (wired em session.error).
 *   - src/notify.ts → memory de rungs mortas (modelNotFoundWakeSessions) e
 *                     promptModelAwareWake com reason model-not-found.
 *   - src/model-catalog.ts → isModelNotFoundError / extractModelSelectorFromError
 *                     compartilhados com a F1 (fonte única da assinatura).
 *   - dist/index.js → paridade src↔dist do bundle compilado.
 *
 * Contratos provados:
 *   1. ProviderModelNotFound é reconhecido nos shapes de retry (`action.*`) e
 *      de session.error; erro NÃO-modelo (429/transporte/abort) não é sequestrado.
 *   2. A cadeia AVANÇA no erro determinístico mesmo com o cooldown longo de
 *      rate-limit ativo (um modelo inexistente nunca "volta a existir").
 *   3. Anti-loop §5.1: `#default` nunca reinicia em chain[0]; o erro do modelo
 *      recém-aplicado anda DELE (rung n → n+1); exaustão não repete alarme
 *      para o MESMO modelo morto, mas re-caminha para um modelo diferente.
 *   4. Um burst é uma única ação (eco residual suprimido dentro do debounce).
 *   5. Exaustão NÃO acorda o lead (HARNESS-13): zero promptAsync para a sessão
 *      do lead; no máximo mensagem persistida delivered=0 + toast acionável.
 *   6. Mensagem de exaustão é ACIONÁVEL e resolve a cadeia pelo AGENTE
 *      (membro "bia" com agent "diana" reporta a cadeia de diana, não a global).
 *   7. promptModelAwareWake: rejeição determinística desce um degrau, memoriza
 *      a rung morta (TTL) e o PRÓXIMO wake não repete o modelo morto; rung 0
 *      nativo (model omitido) permanece intacto.
 *
 * SEM MOCKS: SQLite REAL (`node:sqlite` via createDb) em `.test-scratch`,
 * bundle REAL (`dist/index.js`) + cópia mecânica do `src/` (só resolução de
 * extensão de import). O único seam é o transporte de saída do SDK
 * (`promptAsync` / `abort` / `session.get` / `showToast`), gravado em arrays de
 * captura — carve-out documentado do repositório. Nenhuma lógica de decisão é
 * substituída.
 *
 * Uso: node tests/test_release_10_deterministic_failover.mjs
 * Exit: 0 = todos os checks PASS; 1 = há FAIL.
 */

import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs"
import path from "node:path"

const REPO = path.resolve(import.meta.dirname, "..")
const PKG = process.env.ENSEMBLE_PKG || REPO
const DIST = path.join(PKG, "dist/index.js")
const SRC = path.join(REPO, "src")
const TMP = path.join(REPO, ".test-scratch")
const ROOT = path.join(TMP, "release10_deterministic_failover")
const HARNESS = path.join(TMP, "_release10_f2_harness.mjs")
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

const flush = () => new Promise((r) => setTimeout(r, 20))

// ---------------------------------------------------------------------------
// 0. Harness DIST — bundle real + apenas cláusulas de export anexadas.
// ---------------------------------------------------------------------------
const REQUIRED_SYMBOLS = [
  "createDb", "MemberRegistry", "DEFAULT_CONFIG",
  "isModelResolutionFailure", "extractFailedModelSelector",
  "evaluateDeterministicFailover", "handleRetryModelFailover",
  "handleModelNotFoundSessionError",
  "failoverCooldown", "failoverActions",
  "FAILOVER_COOLDOWN_MS", "FAILOVER_BURST_DEBOUNCE_MS",
  "promptModelAwareWake", "modelNotFoundWakeSessions", "MODEL_NOT_FOUND_WAKE_TTL_MS",
]

const distRaw = readFileSync(DIST, "utf8")
{
  const missing = REQUIRED_SYMBOLS.filter(
    (s) => !new RegExp(`(async\\s+)?(function|class|var|const|let)\\s+${s}\\b`).test(distRaw),
  )
  check("dist declara todos os símbolos exigidos pela F2", missing.length === 0, missing.join(",") || `${REQUIRED_SYMBOLS.length} símbolos`)
  const existing = distRaw.match(/export\s*\{([^}]*)\}\s*;?\s*$/)?.[1] ?? ""
  const already = new Set(existing.split(",").map((s) => s.trim().split(/\s+as\s+/).pop()).filter(Boolean))
  const need = REQUIRED_SYMBOLS.filter((s) => !already.has(s))
  writeFileSync(HARNESS, distRaw + (need.length ? `\nexport { ${need.join(", ")} };\n` : ""))
  check(
    "dist carrega as âncoras da F2 (reason model-not-found + exaustão acionável)",
    // TICKET-RELEASE-11 (Frente B) realinhou o reason num derivador único
    // `failReason` (paywall ? "paywall" : deterministic ? "model-not-found" :
    // "rate-limit") — os literais "model-not-found"/"rate-limit" continuam
    // alcançáveis byte-a-byte para os caminhos pré-existentes, e o behavioral
    // stack deste arquivo prova os valores nos decisions (linhas ~323+).
    /paywall \? "paywall" : deterministic \? "model-not-found" : "rate-limit"/.test(distRaw)
      && /Fix ensemble\.json and respawn/.test(distRaw)
      && /skip-dead-rungs/.test(distRaw),
  )
}

// ---------------------------------------------------------------------------
// 0b. Harness SRC — cópia fora de node_modules + resolução mecânica de extensão.
// ---------------------------------------------------------------------------
const SRC_COPY = path.join(TMP, "_release10_f2_src_copy")
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
const rewrittenSpecifiers = prepareSrcCopy()
check("cópia do src preparada (só extensão de import, lógica intacta)", rewrittenSpecifiers > 0, `${rewrittenSpecifiers} specifiers`)

async function loadDist() {
  const mod = await import(HARNESS)
  return Object.fromEntries(REQUIRED_SYMBOLS.map((n) => [n, mod[n]]))
}

async function loadSrc() {
  const pick = async (rel, names) => {
    const mod = await import(path.join(SRC_COPY, rel))
    return Object.fromEntries(names.map((n) => [n, mod[n]]))
  }
  return {
    ...(await pick("db.ts", ["createDb"])),
    ...(await pick("state.ts", ["MemberRegistry"])),
    ...(await pick("config.ts", ["DEFAULT_CONFIG"])),
    ...(await pick("hooks.ts", [
      "isModelResolutionFailure", "extractFailedModelSelector",
      "evaluateDeterministicFailover", "handleRetryModelFailover",
      "handleModelNotFoundSessionError",
      "failoverCooldown", "failoverActions",
      "FAILOVER_COOLDOWN_MS", "FAILOVER_BURST_DEBOUNCE_MS",
    ])),
    ...(await pick("notify.ts", ["promptModelAwareWake", "modelNotFoundWakeSessions", "MODEL_NOT_FOUND_WAKE_TTL_MS"])),
  }
}

// ---------------------------------------------------------------------------
// 1. Fixtures reais: SQLite + registry + transport recorder.
// ---------------------------------------------------------------------------
let dbSeq = 0
function makeDb(mod, tag) {
  const file = path.join(ROOT, `f2_${tag}_${process.pid}_${dbSeq++}.sqlite`)
  rmSync(file, { force: true })
  rmSync(`${file}-wal`, { force: true })
  rmSync(`${file}-shm`, { force: true })
  return mod.createDb(file)
}

const LEAD_SESSION = "ses-f2-lead"

function makeClient(sessionInfo) {
  const calls = { promptAsync: [], showToast: [], abort: [], sessionGet: [] }
  return {
    calls,
    session: {
      promptAsync: async (options) => { calls.promptAsync.push(options); return undefined },
      abort: async (options) => { calls.abort.push(options); return undefined },
      create: async () => { throw new Error("unexpected session.create in failover path") },
      ...(sessionInfo !== undefined
        ? {
            get: async (options) => {
              calls.sessionGet.push(options)
              return typeof sessionInfo === "function" ? sessionInfo(options) : sessionInfo
            },
          }
        : {}),
    },
    tui: { showToast: async (options) => { calls.showToast.push(options); return undefined } },
  }
}

function seedMember(mod, db, { teamId, memberName, sessionId, agent = "build", model = "prov/primary", teamStatus = "active", leadAgent = null } = {}) {
  const now = Date.now()
  db.run(
    `INSERT OR IGNORE INTO team (id, name, lead_session_id, lead_agent, status, delegate, time_created, time_updated)
     VALUES (?, ?, ?, ?, ?, 0, ?, ?)`,
    [teamId, `name-${teamId}`, LEAD_SESSION, leadAgent, teamStatus, now, now],
  )
  db.run(
    `INSERT INTO team_member (team_id, name, session_id, agent, status, execution_status, model, prompt, time_created, time_updated)
     VALUES (?, ?, ?, ?, 'busy', 'running', ?, 'do the work', ?, ?)`,
    [teamId, memberName, sessionId, agent, model, now, now],
  )
  const registry = new mod.MemberRegistry()
  registry.register(teamId, memberName, sessionId)
  return { registry, sessionId, memberName, teamId }
}

const getMemberModel = (db, teamId, name) =>
  db.query("SELECT model FROM team_member WHERE team_id = ? AND name = ?").get(teamId, name)?.model

const messagesToLead = (db, teamId) =>
  db.query("SELECT from_name, to_name, content, delivered FROM team_message WHERE team_id = ? AND to_name = 'lead'").all(teamId)

const resetMaps = (mod) => { mod.failoverCooldown.clear(); mod.failoverActions.clear() }

/* ------------------------------------------------------------------ *
 * 2. Predicado e extrator (shapes reais de retry e session.error)     *
 * ------------------------------------------------------------------ */
function probeDetection(mod, tag) {
  const t = (n) => `${tag} | detection: ${n}`
  check(t("session.error ProviderModelNotFoundError é reconhecido"),
    mod.isModelResolutionFailure({ name: "ProviderModelNotFoundError", data: { message: "Model not found: opencode-go/ghost" } }) === true)
  check(t("string 'Model not found: p/m' é reconhecida"),
    mod.isModelResolutionFailure("Model not found: opencode-go/ghost") === true)
  check(t("action.reason do retry status é reconhecido"),
    mod.isModelResolutionFailure({ action: { reason: "ProviderModelNotFound" } }) === true)
  check(t("action.title 'Model not found' é reconhecido"),
    mod.isModelResolutionFailure({ action: { title: "Model not found" } }) === true)
  check(t("429 rate-limit NÃO é sequestrado"),
    mod.isModelResolutionFailure({ action: { reason: "rate-limit", message: "429 Too Many Requests" } }) === false)
  check(t("erro de transporte/comum NÃO é sequestrado"),
    mod.isModelResolutionFailure({ name: "UnknownError", data: { message: "ECONNRESET" } }) === false)
  check(t("null/undefined são inertes"), mod.isModelResolutionFailure(null) === false && mod.isModelResolutionFailure(undefined) === false)

  // O extrator compartilhado entrega provider/model SEM variante (o provedor
  // não conhece o nível de pensamento); a variante é reidratada pela cadeia.
  check(t("extrator devolve o seletor citado (provider/model, variante removida)"),
    mod.extractFailedModelSelector({ name: "ProviderModelNotFoundError", data: { message: "Model not found: prov/ghost#low" } }) === "prov/ghost")
  check(t("extrator normaliza '#default' fora do seletor (§5.1)"),
    mod.extractFailedModelSelector("Model not found: prov/ghost#default") === "prov/ghost")
  check(t("extrator não inventa seletor sem mensagem"),
    mod.extractFailedModelSelector({ name: "ProviderModelNotFoundError" }) === undefined)
}

/* ------------------------------------------------------------------ *
 * 3. Gate determinístico — o cooldown de rate-limit NUNCA congela     *
 * ------------------------------------------------------------------ */
function probeGate(mod, tag) {
  const t = (n) => `${tag} | gate: ${n}`
  const out = new Map()
  const BASE = 1_000_000
  const run = (key, record, failed, elapsed, opts = {}) => {
    resetMaps(mod)
    const at = opts.at ?? BASE
    if (!opts.noEntry) mod.failoverCooldown.set(key, at)
    if (record) mod.failoverActions.set(key, { at, ...record })
    return mod.evaluateDeterministicFailover(key, failed, at + elapsed)
  }
  const SWITCH = { fromModel: "prov/A", toModel: "prov/B", exhausted: false }
  const EXHAUSTED = { fromModel: "prov/A", toModel: null, exhausted: true }

  out.set("no-entry-proceeds", eq(run("g0", null, "prov/X", 10, { noEntry: true }), { verdict: "proceed", walkFrom: "prov/X" }))
  out.set("legacy-rate-limit-cooldown-never-freezes",
    eq(run("g1", null, "prov/X", 10), { verdict: "proceed", walkFrom: "prov/X" }))
  out.set("failed-applied-rung-advances-immediately",
    eq(run("g2", SWITCH, "prov/B", 10), { verdict: "proceed", walkFrom: "prov/B" }))
  out.set("echo-of-aborted-request-suppressed-once", (() => {
    const v = run("g3", SWITCH, "prov/A", 500)
    return v.verdict === "suppressed" && v.remainingMs === mod.FAILOVER_BURST_DEBOUNCE_MS - 500
  })())
  out.set("null-failed-echo-suppressed-once", run("g4", SWITCH, null, 500).verdict === "suppressed")
  out.set("different-failing-model-walks-from-itself",
    eq(run("g5", SWITCH, "prov/Z", 500), { verdict: "proceed", walkFrom: "prov/Z" }))
  out.set("exhausted-same-dead-model-re-suppressed", (() => {
    const v = run("g6", EXHAUSTED, "prov/A", 1_000)
    return v.verdict === "suppressed" && v.remainingMs === mod.FAILOVER_COOLDOWN_MS - 1_000
  })())
  out.set("exhausted-different-model-re-walks-now",
    eq(run("g7", EXHAUSTED, "prov/Z", 1_000), { verdict: "proceed", walkFrom: "prov/Z" }))
  out.set("§5.1 '#default' casa com o modelo aplicado sem variante",
    eq(run("g8", { fromModel: "prov/A", toModel: "prov/B", exhausted: false }, "prov/B#default", 10),
      { verdict: "proceed", walkFrom: "prov/B#default" }))
  out.set("past-debounce-echo-walks-from-applied-rung",
    eq(run("g9", SWITCH, "prov/A", mod.FAILOVER_BURST_DEBOUNCE_MS + 500), { verdict: "proceed", walkFrom: "prov/B" }))

  for (const [name, ok] of out) check(t(name), ok)
  resetMaps(mod)
}

/* ------------------------------------------------------------------ *
 * 4. Integração membro: cadeia avança com cooldown ATIVO, sem loop    *
 * ------------------------------------------------------------------ */
async function scenarioMemberChain(mod, tag) {
  const t = (n) => `${tag} | member: ${n}`
  const db = makeDb(mod, `member_${tag}`)
  const client = makeClient()
  resetMaps(mod)
  const cfg = {
    ...mod.DEFAULT_CONFIG,
    fallbackModels: ["prov/a#low", "prov/b#low", "prov/c#low"],
    fallbackModelsByAgent: {},
  }
  const seed = seedMember(mod, db, {
    teamId: `team-f2-m-${tag}`,
    memberName: "bia",
    sessionId: `sess-f2-m-${tag}`,
    agent: "diana",
    model: "prov/primary",
  })
  const cooldownKey = `${seed.teamId}:${seed.memberName}`
  // Cooldown de rate-limit FRESCO (janela longa): não pode congelar o determinístico.
  mod.failoverCooldown.set(cooldownKey, Date.now())

  const notFound = (selector) => ({ attempt: 1, message: `Model not found: ${selector}`, next: Date.now() })

  const d1 = await mod.handleRetryModelFailover(db, seed.registry, client, cfg, seed.sessionId, notFound("prov/primary"))
  check(t("1º erro determinístico troca para a rung 1 apesar do cooldown longo"),
    d1?.action === "switched" && d1.reason === "model-not-found" && d1.toModel === "prov/a#low" && getMemberModel(db, seed.teamId, "bia") === "prov/a#low",
    `action=${d1?.action} to=${d1?.toModel} db=${getMemberModel(db, seed.teamId, "bia")}`)

  const promptsAfterFirst = client.calls.promptAsync.length
  const abortsAfterFirst = client.calls.abort.length
  check(t("1º switch dispara exatamente 1 promptAsync + 1 abort"), promptsAfterFirst === 1 && abortsAfterFirst === 1,
    `prompts=${promptsAfterFirst} aborts=${abortsAfterFirst}`)

  const d2 = await mod.handleRetryModelFailover(db, seed.registry, client, cfg, seed.sessionId, notFound("prov/primary"))
  check(t("eco residual do mesmo burst é suprimido (1 ação por burst)"),
    d2?.action === "suppressed" && d2.reason === "model-not-found" && client.calls.promptAsync.length === promptsAfterFirst && getMemberModel(db, seed.teamId, "bia") === "prov/a#low")

  const d3 = await mod.handleRetryModelFailover(db, seed.registry, client, cfg, seed.sessionId, notFound("prov/a"))
  check(t("erro do modelo recém-aplicado ANDA DELE (rung 2) — provedor cita o modelo-base sem variante"),
    d3?.action === "switched" && d3.toModel === "prov/b#low" && getMemberModel(db, seed.teamId, "bia") === "prov/b#low",
    `to=${d3?.toModel} db=${getMemberModel(db, seed.teamId, "bia")}`)

  const d4 = await mod.handleRetryModelFailover(db, seed.registry, client, cfg, seed.sessionId, notFound("prov/b"))
  check(t("rung 3 aplicada sem reiniciar em chain[0]"),
    d4?.action === "switched" && d4.toModel === "prov/c#low" && getMemberModel(db, seed.teamId, "bia") === "prov/c#low",
    `to=${d4?.toModel}`)

  const promptsBeforeExhaust = client.calls.promptAsync.length
  const d5 = await mod.handleRetryModelFailover(db, seed.registry, client, cfg, seed.sessionId, notFound("prov/c"))
  check(t("exaustão: decisão explícita e modelo preservado"),
    d5?.action === "exhausted" && d5.reason === "model-not-found" && getMemberModel(db, seed.teamId, "bia") === "prov/c#low")
  check(t("exaustão NÃO dispara promptAsync/abort (lead não é acordado)"),
    client.calls.promptAsync.length === promptsBeforeExhaust && client.calls.abort.length === abortsAfterFirst + 2)

  const models = client.calls.promptAsync.map((c) => c.model && `${c.model.providerID}/${c.model.modelID}#${c.model.variant}`)
  check(t("escada percorrida exatamente primary→a→b→c (sem loop infinito)"),
    eq(models, ["prov/a#low", "prov/b#low", "prov/c#low"]), models.join(" → "))
  check(t("todo promptAsync leva agent explícito 'diana' e a sessão do membro"),
    client.calls.promptAsync.every((c) => c.agent === "diana" && c.sessionID === seed.sessionId && c.synthetic === true))
  check(t("nenhum promptAsync na sessão do lead"), client.calls.promptAsync.every((c) => c.sessionID !== LEAD_SESSION))
}

/* ------------------------------------------------------------------ *
 * 5. Anti-loop §5.1 — '#default' não reinicia em chain[0]             *
 * ------------------------------------------------------------------ */
async function scenarioDefaultVariant(mod, tag) {
  const t = (n) => `${tag} | §5.1: ${n}`
  const db = makeDb(mod, `variant_${tag}`)
  const client = makeClient()
  resetMaps(mod)
  const cfg = {
    ...mod.DEFAULT_CONFIG,
    fallbackModels: ["prov/m", "prov/n#low"],
    fallbackModelsByAgent: {},
  }
  const seed = seedMember(mod, db, {
    teamId: `team-f2-v-${tag}`,
    memberName: "caio",
    sessionId: `sess-f2-v-${tag}`,
    agent: "build",
    model: "prov/m#default",
  })
  const d = await mod.handleRetryModelFailover(db, seed.registry, client, cfg, seed.sessionId, {
    attempt: 1,
    message: "Model not found: prov/m#default",
    next: Date.now(),
  })
  check(t("erro '#default' avança PARA FORA de chain[0] (prov/n#low)"),
    d?.action === "switched" && d.toModel === "prov/n#low" && getMemberModel(db, seed.teamId, "caio") === "prov/n#low",
    `to=${d?.toModel} db=${getMemberModel(db, seed.teamId, "caio")}`)
  check(t("nenhum promptAsync com seletor '#default'"),
    client.calls.promptAsync.every((c) => !c.model || c.model.variant !== "default"))
}

/* ------------------------------------------------------------------ *
 * 5b. Regressão de loop: erro SEM variante sobre rung COM variante     *
 * ------------------------------------------------------------------ */
async function scenarioVariantLoop(mod, tag) {
  const t = (n) => `${tag} | loop-guard: ${n}`
  const db = makeDb(mod, `loop_${tag}`)
  const client = makeClient()
  resetMaps(mod)
  const cfg = {
    ...mod.DEFAULT_CONFIG,
    fallbackModels: ["prov/a#low", "prov/b#low"],
    fallbackModelsByAgent: {},
  }
  const seed = seedMember(mod, db, {
    teamId: `team-f2-l-${tag}`,
    memberName: "died",
    sessionId: `sess-f2-l-${tag}`,
    agent: "build",
    model: "prov/a#low",
  })
  const decisions = []
  for (let i = 0; i < 4; i++) {
    decisions.push(await mod.handleRetryModelFailover(db, seed.registry, client, cfg, seed.sessionId, {
      attempt: 1,
      // O provedor cita o modelo-base (sem variante); a rung aplicada tem #low.
      message: "Model not found: prov/a",
      next: Date.now(),
    }))
  }
  const first = decisions[0]
  check(t("1º evento avança da rung morta com variante para a próxima (a#low → b#low)"),
    first?.action === "switched" && first.toModel === "prov/b#low" && getMemberModel(db, seed.teamId, "died") === "prov/b#low",
    `action=${first?.action} to=${first?.toModel} db=${getMemberModel(db, seed.teamId, "died")}`)
  const applied = client.calls.promptAsync.map((c) => `${c.model?.providerID}/${c.model?.modelID}#${c.model?.variant}`)
  check(t("eventos repetidos NÃO reaplicam o mesmo modelo morto (sem loop infinito)"),
    applied.filter((m) => m === "prov/a#low").length <= 1 && applied.every((m) => m === "prov/b#low" || m === "prov/a#low"),
    applied.join(" → ") || "nenhum prompt")
  check(t("após avançar, eventos do MESMO modelo morto são suprimidos (1 ação por burst)"),
    decisions.slice(1).every((d) => d?.action === "suppressed") && client.calls.promptAsync.length <= 2,
    decisions.map((d) => d?.action).join(","))
}

/* ------------------------------------------------------------------ *
 * 6. handleModelNotFoundSessionError (session.error seam)             *
 * ------------------------------------------------------------------ */
async function scenarioSessionError(mod, tag) {
  const t = (n) => `${tag} | session.error: ${n}`

  // (a) erro comum e abort NÃO são sequestrados (fluxo antigo preservado).
  {
    const db = makeDb(mod, `err_${tag}`)
    const client = makeClient()
    resetMaps(mod)
    const seed = seedMember(mod, db, { teamId: `team-f2-e-${tag}`, memberName: "e1", sessionId: `sess-f2-e-${tag}` })
    const cfg = { ...mod.DEFAULT_CONFIG, fallbackModels: ["prov/a#low"], fallbackModelsByAgent: {} }
    const common = await mod.handleModelNotFoundSessionError(db, seed.registry, client, cfg, seed.sessionId, { name: "UnknownError", data: { message: "boom" } })
    const abort = await mod.handleModelNotFoundSessionError(db, seed.registry, client, cfg, seed.sessionId, { name: "MessageAbortedError", data: { message: "aborted by user" } })
    check(t("erro comum cai no fluxo antigo (undefined, zero side effect)"),
      common === undefined && abort === undefined && client.calls.promptAsync.length === 0 && client.calls.showToast.length === 0)
  }

  // (b) membro com fallback: troca silenciosa, DB persistido, zero toast.
  {
    const db = makeDb(mod, `switch_${tag}`)
    const client = makeClient()
    resetMaps(mod)
    const seed = seedMember(mod, db, {
      teamId: `team-f2-s-${tag}`, memberName: "e2", sessionId: `sess-f2-s-${tag}`, agent: "diana", model: "prov/primary",
    })
    const cfg = { ...mod.DEFAULT_CONFIG, fallbackModels: ["prov/a#low", "prov/b#low"], fallbackModelsByAgent: {} }
    const d = await mod.handleModelNotFoundSessionError(db, seed.registry, client, cfg, seed.sessionId, {
      name: "ProviderModelNotFoundError",
      data: { message: "Model not found: prov/primary" },
    })
    check(t("ProviderModelNotFound troca o modelo e persiste no membro"),
      d?.action === "switched" && d.reason === "model-not-found" && getMemberModel(db, seed.teamId, "e2") === "prov/a#low")
    check(t("troca silenciosa: zero toast, 1 promptAsync com agent diana"),
      client.calls.showToast.length === 0 && client.calls.promptAsync.length === 1 && client.calls.promptAsync[0].agent === "diana")
    check(t("mensagem NÃO é persistida quando há fallback"),
      messagesToLead(db, seed.teamId).length === 0)
  }

  // (c) exaustão ACIONÁVEL sem wake de lead + dedupe de alarme.
  {
    const db = makeDb(mod, `exhaust_${tag}`)
    const client = makeClient()
    resetMaps(mod)
    const seed = seedMember(mod, db, {
      teamId: `team-f2-x-${tag}`, memberName: "e3", sessionId: `sess-f2-x-${tag}`, agent: "build", model: "prov/a#low",
    })
    const cfg = { ...mod.DEFAULT_CONFIG, fallbackModels: ["prov/a#low"], fallbackModelsByAgent: {} }
    const err = { name: "ProviderModelNotFoundError", data: { message: "Model not found: prov/a" } }

    const d = await mod.handleModelNotFoundSessionError(db, seed.registry, client, cfg, seed.sessionId, err)
    check(t("exaustão devolve decisão explícita reason=model-not-found"),
      d?.action === "exhausted" && d.reason === "model-not-found" && d.memberName === "e3")

    const msgs = messagesToLead(db, seed.teamId)
    check(t("mensagem acionável persistida delivered=0 (canal passivo, zero wake)"),
      msgs.length === 1 && msgs[0].delivered === 0 && msgs[0].from_name === "system" && msgs[0].to_name === "lead",
      JSON.stringify(msgs.map((m) => ({ from: m.from_name, delivered: m.delivered }))))
    check(t("mensagem cita modelo ausente, cadeia esgotada e o remédio (ensemble.json + respawn)"),
      msgs.length === 1
        && /prov\/a#low/.test(msgs[0].content)
        && /exhausted/i.test(msgs[0].content)
        && /ensemble\.json/.test(msgs[0].content)
        && /respawn/i.test(msgs[0].content))
    check(t("toast único, variant error e texto acionável"),
      client.calls.showToast.length === 1
        && client.calls.showToast[0].variant === "error"
        && /not found/i.test(client.calls.showToast[0].message)
        && /Fix ensemble\.json and respawn/.test(client.calls.showToast[0].message))
    check(t("ZERO promptAsync/abort na exaustão (lead jamais acordado)"),
      client.calls.promptAsync.length === 0 && client.calls.abort.length === 0)

    const d2 = await mod.handleModelNotFoundSessionError(db, seed.registry, client, cfg, seed.sessionId, err)
    check(t("2º evento do MESMO modelo morto não repete alarme (suppressed)"),
      d2?.action === "suppressed" && messagesToLead(db, seed.teamId).length === 1 && client.calls.showToast.length === 1,
      `action=${d2?.action} msgs=${messagesToLead(db, seed.teamId).length} toasts=${client.calls.showToast.length}`)
  }

  // (d) cadeia resolvida pelo AGENTE, não pelo nome do membro (bug real corrigido).
  {
    const db = makeDb(mod, `agentchain_${tag}`)
    const client = makeClient()
    resetMaps(mod)
    const seed = seedMember(mod, db, {
      teamId: `team-f2-a-${tag}`, memberName: "bia", sessionId: `sess-f2-a-${tag}`, agent: "diana", model: "diana/one#low",
    })
    const cfg = {
      ...mod.DEFAULT_CONFIG,
      fallbackModels: ["global/one#low"],
      fallbackModelsByAgent: { diana: ["diana/one#low"] },
    }
    const d = await mod.handleModelNotFoundSessionError(db, seed.registry, client, cfg, seed.sessionId, {
      name: "ProviderModelNotFoundError",
      data: { message: "Model not found: diana/one" },
    })
    const msgs = messagesToLead(db, seed.teamId)
    check(t("exaustão de 'bia' reporta a cadeia do AGENTE diana"),
      d?.action === "exhausted"
        && msgs.length === 1
        && /diana\/one#low/.test(msgs[0].content)
        && !/global\/one#low/.test(msgs[0].content),
      msgs[0]?.content ?? "sem mensagem")
  }
}

/* ------------------------------------------------------------------ *
 * 7. Sessão isolada/lead: zero escrita em team_member, agent explícito*
 * ------------------------------------------------------------------ */
async function scenarioIsolated(mod, tag) {
  const t = (n) => `${tag} | isolated: ${n}`
  const db = makeDb(mod, `iso_${tag}`)
  resetMaps(mod)
  const sessionId = `sess-f2-iso-${tag}`
  const client = makeClient({ data: { agent: "diana", model: { providerID: "prov", id: "primary" } } })
  const cfg = {
    ...mod.DEFAULT_CONFIG,
    fallbackModels: ["global/one#low"],
    fallbackModelsByAgent: { diana: ["prov/i1#low", "prov/i2#low"] },
  }
  const d = await mod.handleRetryModelFailover(db, new mod.MemberRegistry(), client, cfg, sessionId, {
    attempt: 1, agent: "diana", message: "Model not found: prov/primary", next: Date.now(),
  })
  check(t("cadeia explícita do agente avança (rung 1) sem linha de membro"),
    d?.action === "switched" && d.reason === "model-not-found" && d.toModel === "prov/i1#low",
    `action=${d?.action} to=${d?.toModel}`)
  check(t("promptAsync de retomada leva agent explícito e nenhuma escrita em team_member"),
    client.calls.promptAsync.length === 1
      && client.calls.promptAsync[0].agent === "diana"
      && client.calls.promptAsync[0].sessionID === sessionId
      && db.query("SELECT COUNT(*) AS n FROM team_member").get().n === 0)

  // Sessão sem cadeia explícita: a global NUNCA sequestra.
  const client2 = makeClient({ data: { agent: "unknown-persona", model: { providerID: "prov", id: "primary" } } })
  const d2 = await mod.handleRetryModelFailover(db, new mod.MemberRegistry(), client2, cfg, `sess-f2-other-${tag}`, {
    attempt: 1, message: "Model not found: prov/primary", next: Date.now(),
  })
  check(t("sessão isolada sem cadeia própria é no-op (global não sequestra)"),
    d2 === undefined && client2.calls.promptAsync.length === 0)
}

/* ------------------------------------------------------------------ *
 * 8. promptModelAwareWake: degrau + memória de rung morta (TTL)       *
 * ------------------------------------------------------------------ */
async function scenarioWake(mod, tag) {
  const t = (n) => `${tag} | wake: ${n}`
  const cfg = { ...mod.DEFAULT_CONFIG, fallbackModels: ["prov/a#low", "prov/b#low"], fallbackModelsByAgent: {} }

  function wakeClient(rejections) {
    const calls = []
    return {
      calls,
      client: {
        session: {
          promptAsync: (options) => {
            calls.push(options)
            const rejection = rejections[calls.length - 1]
            return rejection ? Promise.reject(rejection) : Promise.resolve()
          },
        },
      },
    }
  }

  const SID = `sess-f2-wake-${tag}`
  mod.modelNotFoundWakeSessions.clear()

  // 1ª wake: rung 0 nativo rejeitado por model-not-found → degrau 1 na MESMA chamada.
  const a = wakeClient([new Error("Model not found: prov/native"), undefined])
  mod.promptModelAwareWake(a.client, { sessionID: SID, text: "wake", logTag: `f2wake:${tag}`, agent: "diana", config: cfg })
  await flush()
  check(t("rung 0 nativo (model omitido) preservado e rejeição desce para a rung 1"),
    a.calls.length === 2 && a.calls[0].model === undefined && a.calls[1].model?.modelID === "a",
    a.calls.map((c) => c.model?.modelID ?? "native").join(" → "))
  const rec = mod.modelNotFoundWakeSessions.get(SID)
  check(t("rung morta memorizada (failedRung=session-native, nextIndex=1)"),
    rec?.nextIndex === 1 && rec?.failedRung === "session-native", JSON.stringify(rec ?? null))

  // 2ª wake: começa na rung 1, NUNCA repete o modelo nativo morto.
  const b = wakeClient([])
  mod.promptModelAwareWake(b.client, { sessionID: SID, text: "wake2", logTag: `f2wake:${tag}`, agent: "diana", config: cfg })
  await flush()
  check(t("wake seguinte não repete a rung morta (começa em prov/a#low)"),
    b.calls.length === 1 && b.calls[0].model?.modelID === "a",
    b.calls.map((c) => c.model?.modelID ?? "native").join(" → "))

  // TTL: record vencido → volta à rung 0 nativa e limpa a memória.
  mod.modelNotFoundWakeSessions.set(SID, {
    at: Date.now() - mod.MODEL_NOT_FOUND_WAKE_TTL_MS,
    failedRung: "session-native",
    nextIndex: 1,
  })
  const c = wakeClient([])
  mod.promptModelAwareWake(c.client, { sessionID: SID, text: "wake3", logTag: `f2wake:${tag}`, agent: "diana", config: cfg })
  await flush()
  check(t("após o TTL a wake volta à rung 0 nativa e limpa a memória"),
    c.calls.length === 1 && c.calls[0].model === undefined && !mod.modelNotFoundWakeSessions.has(SID))

  // Rejeição de transporte NÃO é memorizada (só determinística é rung morta).
  const SID2 = `sess-f2-wake-transport-${tag}`
  const d = wakeClient([new Error("ECONNRESET socket hang up"), undefined])
  mod.promptModelAwareWake(d.client, { sessionID: SID2, text: "wake4", logTag: `f2wake:${tag}`, agent: "diana", config: cfg })
  await flush()
  check(t("transporte rejeitado desce degrau mas NÃO memoriza modelo morto"),
    d.calls.length === 2 && d.calls[1].model?.modelID === "a" && !mod.modelNotFoundWakeSessions.has(SID2))

  // primaryModel explícito continua sendo rung 0 (contrato TICKET-32B).
  const SID3 = `sess-f2-wake-primary-${tag}`
  const e = wakeClient([])
  mod.promptModelAwareWake(e.client, {
    sessionID: SID3, text: "wake5", logTag: `f2wake:${tag}`, agent: "diana", config: cfg, primaryModel: "prov/p#low",
  })
  await flush()
  check(t("primaryModel explícito é respeitado como rung 0"),
    e.calls.length === 1 && e.calls[0].model?.modelID === "p" && e.calls[0].model?.variant === "low")

  mod.modelNotFoundWakeSessions.clear()
}

/* ------------------------------------------------------------------ *
 * 9. Paridade src↔dist das decisões puras.
 * ------------------------------------------------------------------ */
function pureProbe(mod) {
  const BASE = 5_000_000
  const key = "parity"
  resetMaps(mod)
  mod.failoverCooldown.set(key, BASE)
  mod.failoverActions.set(key, { at: BASE, fromModel: "prov/A", toModel: "prov/B", exhausted: false })
  const gate = [
    mod.evaluateDeterministicFailover(key, "prov/B", BASE + 10),
    mod.evaluateDeterministicFailover(key, "prov/A", BASE + 10),
    mod.evaluateDeterministicFailover(key, "prov/Z", 6_000_000),
  ]
  resetMaps(mod)
  return {
    detection: [
      mod.isModelResolutionFailure({ name: "ProviderModelNotFoundError", data: { message: "Model not found: p/m" } }),
      mod.isModelResolutionFailure({ action: { reason: "rate-limit" } }),
    ],
    extraction: [
      mod.extractFailedModelSelector("Model not found: p/m#default"),
      mod.extractFailedModelSelector("Model not found: p/m#low"),
    ],
    gate,
  }
}

/* ------------------------------------------------------------------ *
 * 10. Anti-mock estático (produção permanece limpa).
 * ------------------------------------------------------------------ */
function antiMock() {
  const FORBIDDEN = ["je" + "st.mock", "sin" + "on", "vi.mo" + "ck", "mockImple" + "mentation", "Magic" + "Mock"]
  let offenders = 0
  const walk = (dir) =>
    readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
      e.isDirectory() ? walk(path.join(dir, e.name)) : [path.join(dir, e.name)],
    )
  for (const file of walk(SRC)) {
    if (!/\.ts$/.test(file)) continue
    const text = readFileSync(file, "utf8")
    const code = text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "")
    if (FORBIDDEN.some((marker) => code.includes(marker))) offenders++
  }
  check("anti-mock: zero primitivas de mock em produção sob src/", offenders === 0, `achados=${offenders}`)
  const self = readFileSync(import.meta.filename, "utf8")
  check("anti-mock: a própria suíte não contém marcadores proibidos", !FORBIDDEN.some((m) => self.includes(m)))
  check("anti-mock: terminologia de teste é 'captura de transporte', não dublê de decisão",
    /transport recorder|captura/i.test(self))
}

/* ------------------------------------------------------------------ *
 * 11. Execução nas duas camadas + veredito.
 * ------------------------------------------------------------------ */
for (const [tag, loader] of [["dist", loadDist], ["src", loadSrc]]) {
  const mod = await loader()
  const loaded = REQUIRED_SYMBOLS.filter((s) => {
    const value = mod[s]
    return typeof value === "function" || typeof value === "number"
      || typeof value === "string" || (value && typeof value === "object")
  })
  check(`${tag} | módulos reais carregados (${REQUIRED_SYMBOLS.length} símbolos)`, loaded.length === REQUIRED_SYMBOLS.length,
    REQUIRED_SYMBOLS.filter((s) => !loaded.includes(s)).join(",") || "ok")

  probeDetection(mod, tag)
  probeGate(mod, tag)
  await scenarioMemberChain(mod, tag)
  await scenarioDefaultVariant(mod, tag)
  await scenarioVariantLoop(mod, tag)
  await scenarioSessionError(mod, tag)
  await scenarioIsolated(mod, tag)
  await scenarioWake(mod, tag)
}

{
  const distMod = await loadDist()
  const srcMod = await loadSrc()
  check("paridade src↔dist das decisões puras (detecção/extrator/gate)", eq(pureProbe(distMod), pureProbe(srcMod)))
}

antiMock()

check("zero unhandledRejection durante a suíte", unhandled.length === 0, unhandled.map(String).join(";"))

const failed = results.filter(([, ok]) => !ok)
console.log(`\nRESULT: ${results.length - failed.length}/${results.length} checks passed`)
if (failed.length > 0) {
  console.log("FAILED CHECKS:")
  for (const [name] of failed) console.log(`  - ${name}`)
  process.exit(1)
}
