#!/usr/bin/env node
/**
 * QUALITY GATE DETERMINÍSTICO — TICKET-RELEASE-10 (Frente F1)
 * @maiteuxzanela/ensemble-room-lowcost
 *
 * Engenheiro de Backend: Davi. SDET: Hugo. Guardiã do Quality Gate: Clara.
 *
 * Bug vivo sob teste (evidência 22/10/2026):
 *   `~/.config/opencode/ensemble.json` apontava `defaultModel`, `modelsByAgent`
 *   e `fallbackModels[0]` para `opencode-go/longcat-2.5-preview-free`, um modelo
 *   que NÃO existe no catálogo do servidor. `team_spawn` criava worktree +
 *   sessão e só então disparava `promptAsync`, que morria de forma assíncrona
 *   com ProviderModelNotFoundError. O failover nativo nunca avançava (só reage
 *   a cota/rate-limit) — todo spawn de todo membro queimava uma sessão.
 *
 * Correção sob teste (F1 — validação PRÉ-spawn):
 *   - o modelo efetivo (explícito > modelsByAgent > defaultModel) é resolvido
 *     ANTES de qualquer efeito colateral (worktree/workspace/session.create);
 *   - é validado contra o catálogo VIVO do servidor (`client.modelCatalog` →
 *     SDK `model.list()`, com fallback `config.providers()`);
 *   - se o configurado não existe, a cadeia `fallbackModels` avança até o
 *     PRIMEIRO modelo que o servidor realmente serve;
 *   - se nada resolve, o spawn falha ANTES de criar qualquer coisa, com
 *     mensagem acionável (modelo configurado + cadeia + sugestões);
 *   - ao substituir, log/toast citam o modelo ausente + "Did you mean"
 *     derivado do catálogo real;
 *   - catálogo indisponível → fail-open (nunca bloqueia spawn por enriquecimento).
 *
 * SEM MOCKS: SQLite REAL (`node:sqlite` via createDb) em `.test-scratch`,
 * bundle REAL (`dist/index.js`) + cópia mecânica do `src/` (só resolução de
 * extensão de import). O único seam é o transporte de saída do SDK
 * (worktree.create / session.create / session.get / promptAsync / showToast),
 * gravado em arrays de captura — carve-out documentado do repositório.
 * Nenhuma lógica de decisão é substituída.
 *
 * Uso: node tests/test_release_10_pre_spawn_model_validation.mjs
 * Exit: 0 = todos os checks PASS; 1 = há FAIL.
 */

import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs"
import path from "node:path"

const REPO = path.resolve(import.meta.dirname, "..")
const PKG = process.env.ENSEMBLE_PKG || REPO
const DIST = path.join(PKG, "dist/index.js")
const SRC = path.join(REPO, "src")
const TMP = path.join(REPO, ".test-scratch")
const ROOT = path.join(TMP, "release10_pre_spawn_model")
const HARNESS = path.join(TMP, "_release10_model_harness.mjs")
mkdirSync(TMP, { recursive: true })
rmSync(ROOT, { recursive: true, force: true })
mkdirSync(ROOT, { recursive: true })

const results = []
const check = (name, ok, detail) => {
  results.push([name, ok])
  console.log(`${ok ? "PASS" : "FAIL"} | ${name}${detail ? " | " + detail : ""}`)
}

const unhandled = []
process.on("unhandledRejection", (e) => unhandled.push(e))

// ---------------------------------------------------------------------------
// 0. Harness DIST — bundle real + exports ausentes anexados (sem mocks).
// ---------------------------------------------------------------------------
const REQUIRED_SYMBOLS = [
  "createDb", "executeTeamSpawn", "unavailableSpawnModelError", "resolveModel",
  "wrapThrowingClient", "createV2Client", "MemberRegistry", "ProgressTracker",
  "DEFAULT_CONFIG", "isModelNotFoundError", "describeModelNotFound", "catalogKey",
  "isSelectorAvailable", "suggestModelSelectors", "extractModelSelectorFromError",
  "resolveSpawnModelFromCatalog", "fetchModelCatalog",
]
const distRaw = readFileSync(DIST, "utf8")
{
  const missing = REQUIRED_SYMBOLS.filter(
    (s) => !new RegExp(`(async\\s+)?(function|class|var|const|let)\\s+${s}\\b`).test(distRaw),
  )
  check(
    "dist declara todos os símbolos exigidos",
    missing.length === 0,
    missing.join(",") || `${REQUIRED_SYMBOLS.length} símbolos`,
  )
  const existingExport = distRaw.match(/export\s*\{([^}]*)\}\s*;?\s*$/)?.[1] ?? ""
  const already = new Set(
    existingExport.split(",").map((s) => s.trim().split(/\s+as\s+/).pop()).filter(Boolean),
  )
  const need = REQUIRED_SYMBOLS.filter((s) => !already.has(s))
  writeFileSync(HARNESS, distRaw + (need.length ? `\nexport { ${need.join(", ")} };\n` : ""))
}

// ---------------------------------------------------------------------------
// 0b. Harness SRC — cópia fora de node_modules + resolução mecânica de extensão.
// ---------------------------------------------------------------------------
const SRC_COPY = path.join(TMP, "_release10_src_copy")
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
  return import(HARNESS)
}

async function loadSrc() {
  const pick = async (rel, names) => {
    const mod = await import(path.join(SRC_COPY, rel))
    return Object.fromEntries(names.map((n) => [n, mod[n]]))
  }
  return {
    ...(await pick("db.ts", ["createDb"])),
    ...(await pick("tools/team-spawn.ts", ["executeTeamSpawn", "unavailableSpawnModelError", "resolveModel"])),
    ...(await pick("client.ts", ["wrapThrowingClient"])),
    ...(await pick("v2-client.ts", ["createV2Client"])),
    ...(await pick("state.ts", ["MemberRegistry"])),
    ...(await pick("progress.ts", ["ProgressTracker"])),
    ...(await pick("config.ts", ["DEFAULT_CONFIG"])),
    ...(await pick("model-catalog.ts", [
      "isModelNotFoundError", "describeModelNotFound", "catalogKey", "isSelectorAvailable",
      "suggestModelSelectors", "extractModelSelectorFromError", "resolveSpawnModelFromCatalog",
      "fetchModelCatalog",
    ])),
  }
}

// ---------------------------------------------------------------------------
// Catálogo vivo de referência (o que o "servidor" realmente serve).
// ---------------------------------------------------------------------------
const CATALOG_MODELS = [
  { id: "deepseek-v4.1-flash", modelID: "deepseek-v4.1-flash", providerID: "opencode-go", enabled: true },
  { id: "mimo-v2.6-flash", modelID: "mimo-v2.6-flash", providerID: "opencode-go", enabled: true },
  { id: "antigravity-gemini-3.8-flash", modelID: "antigravity-gemini-3.8-flash", providerID: "google", enabled: true },
]
const MISSING_MODEL = "opencode-go/longcat-2.5-preview-free"

const TS = Date.now()
const TEAM_ID = "team_release10"
const TEAM_NAME = "release10"
const LEAD_SESSION = "ses_lead_r10"

function seedTeam(db) {
  db.run(
    `INSERT INTO project (id, name, path, status, time_created, time_updated)
     VALUES ('default', 'Default', '', 'active', ?, ?) ON CONFLICT DO NOTHING`,
    [TS, TS],
  )
  db.run(
    `INSERT INTO team (id, name, project_id, lead_session_id, status, delegate, time_created, time_updated, lead_agent)
     VALUES (?, ?, 'default', ?, 'active', 0, ?, ?, 'build')`,
    [TEAM_ID, TEAM_NAME, LEAD_SESSION, TS, TS],
  )
}

/**
 * Seam de transporte: um "servidor" mínimo que registra o que a produção
 * enviaria. `catalog` controla o que a API de catálogo devolve.
 */
function rawTransport({ catalog = CATALOG_MODELS, catalogShape = "model-list", catalogError = false } = {}) {
  const calls = { worktree: [], workspace: [], sessionCreate: [], promptAsync: [], toast: [], catalog: [], sessionGet: [] }
  let seq = 0
  const raw = {
    session: {
      create: async (options) => {
        calls.sessionCreate.push(options)
        seq += 1
        return { data: { id: `ses_r10_${seq}` } }
      },
      get: async ({ sessionID }) => {
        calls.sessionGet.push(sessionID)
        return { data: { id: sessionID, agent: "build" } }
      },
      promptAsync: async (params) => {
        calls.promptAsync.push(params)
        return {}
      },
      abort: async () => ({}),
      status: async () => ({ data: {} }),
      messages: async () => ({ data: [] }),
    },
    tui: {
      showToast: async (toast) => {
        calls.toast.push(toast)
        return {}
      },
      selectSession: async () => ({}),
    },
    worktree: {
      create: async (options) => {
        calls.worktree.push(options)
        return { data: { name: "wt-release10", branch: "ensemble-r10", directory: path.join(ROOT, "wt") } }
      },
      remove: async () => ({}),
      list: async () => ({ data: [] }),
      reset: async () => ({}),
    },
    experimental: {
      workspace: {
        create: async (options) => {
          calls.workspace.push(options)
          return { data: { id: "ws_r10", type: "local", branch: options?.branch ?? null, directory: null, projectID: "p" } }
        },
        remove: async () => ({}),
        list: async () => ({ data: [] }),
      },
    },
  }
  if (catalogShape === "model-list") {
    raw.model = {
      list: async (input) => {
        calls.catalog.push(input)
        if (catalogError) return { data: undefined, error: { message: "catalog unavailable" } }
        return { data: { location: { directory: ROOT }, data: catalog } }
      },
    }
  } else if (catalogShape === "config-providers") {
    raw.config = {
      providers: async (input) => {
        calls.catalog.push(input)
        const providers = []
        for (const m of catalog) {
          let provider = providers.find((p) => p.id === m.providerID)
          if (!provider) {
            provider = { id: m.providerID, name: m.providerID, source: "api", env: [], options: {}, models: {} }
            providers.push(provider)
          }
          provider.models[m.modelID] = { id: m.modelID, name: m.modelID }
        }
        return { data: { providers, default: {} } }
      },
    }
  }
  return { raw, calls }
}

async function waitFor(predicate, timeoutMs = 2000) {
  const started = Date.now()
  while (Date.now() - started < timeoutMs) {
    if (predicate()) return true
    await new Promise((r) => setTimeout(r, 10))
  }
  return predicate()
}

// ---------------------------------------------------------------------------
// 1. Suíte comportamental — roda em dist E src.
// ---------------------------------------------------------------------------
async function runBehavior(label, mods) {
  const {
    createDb, executeTeamSpawn, wrapThrowingClient, createV2Client,
    MemberRegistry, ProgressTracker, DEFAULT_CONFIG,
    isModelNotFoundError, describeModelNotFound, catalogKey, isSelectorAvailable,
    suggestModelSelectors, extractModelSelectorFromError, resolveSpawnModelFromCatalog,
    fetchModelCatalog,
  } = mods
  const tag = (name) => `[${label}] ${name}`

  // -------------------------------------------------------------------------
  // A. Helpers puros (server-truth, VARIANT_ABSENT_SENTINEL, Did you mean)
  // -------------------------------------------------------------------------
  check(
    tag("catalogKey normaliza variant e o sentinela #default"),
    catalogKey("opencode-go/deepseek-v4.1-flash#low") === "opencode-go/deepseek-v4.1-flash"
      && catalogKey("opencode-go/deepseek-v4.1-flash#default") === "opencode-go/deepseek-v4.1-flash"
      && catalogKey("opencode-go/deepseek-v4.1-flash") === "opencode-go/deepseek-v4.1-flash",
  )
  check(tag("catalogKey rejeita seletor malformado"), catalogKey("sem-barra") === undefined && catalogKey("") === undefined)
  check(
    tag("isSelectorAvailable ignora variant mas respeita enabled:false"),
    isSelectorAvailable(CATALOG_MODELS, "opencode-go/deepseek-v4.1-flash#high") === true
      && isSelectorAvailable(CATALOG_MODELS, "opencode-go/inexistente") === false
      && isSelectorAvailable([{ providerID: "p", modelID: "m", enabled: false }], "p/m") === false,
  )
  check(
    tag("suggestModelSelectors prioriza o MESMO provider (Did you mean)"),
    suggestModelSelectors(CATALOG_MODELS, MISSING_MODEL).every((s) => s.startsWith("opencode-go/"))
      && suggestModelSelectors(CATALOG_MODELS, MISSING_MODEL).length > 0,
    suggestModelSelectors(CATALOG_MODELS, MISSING_MODEL).join(","),
  )
  check(
    tag("suggestModelSelectors determinístico (mesma entrada, mesma saída)"),
    JSON.stringify(suggestModelSelectors(CATALOG_MODELS, MISSING_MODEL))
      === JSON.stringify(suggestModelSelectors(CATALOG_MODELS, MISSING_MODEL)),
  )

  // Detecção do erro determinístico (contrato compartilhado com F2)
  const notFoundA = { name: "ProviderModelNotFoundError", data: { message: "Model not found: opencode-go/longcat-2.5-preview-free" } }
  const notFoundB = new Error("Model not found: opencode-go/longcat-2.5-preview-free")
  const rateLimit = { name: "RateLimitError", data: { message: "429 rate limit exceeded, retry in 30s" } }
  check(
    tag("isModelNotFoundError reconhece ProviderModelNotFoundError e 'Model not found'"),
    isModelNotFoundError(notFoundA) === true && isModelNotFoundError(notFoundB) === true,
  )
  check(tag("isModelNotFoundError NÃO confunde rate-limit com modelo inexistente"), isModelNotFoundError(rateLimit) === false)
  check(
    tag("extractModelSelectorFromError extrai o seletor do payload"),
    extractModelSelectorFromError(notFoundA) === MISSING_MODEL,
    String(extractModelSelectorFromError(notFoundA)),
  )
  const described = describeModelNotFound(notFoundA, CATALOG_MODELS)
  check(
    tag("describeModelNotFound produz linha acionável com Did you mean do catálogo"),
    described.includes(MISSING_MODEL) && described.includes("Did you mean:") && described.includes("opencode-go/"),
    described,
  )
  check(
    tag("describeModelNotFound degrada sem catálogo (no catalog suggestion available)"),
    describeModelNotFound(new Error("Model not found: p/x"), []).includes("No catalog suggestion available"),
  )

  // Decisão pura de spawn
  const validDecision = resolveSpawnModelFromCatalog(CATALOG_MODELS, "opencode-go/mimo-v2.6-flash#low", [])
  check(
    tag("decisão: modelo válido passa intacto (variant preservado)"),
    validDecision.model === "opencode-go/mimo-v2.6-flash#low" && validDecision.substituted === false && validDecision.exhausted === false,
  )
  const failOpen = resolveSpawnModelFromCatalog(undefined, MISSING_MODEL, [])
  check(
    tag("decisão: catálogo ausente = fail-open (mantém o configurado)"),
    failOpen.model === MISSING_MODEL && failOpen.substituted === false && failOpen.exhausted === false,
  )
  const substituted = resolveSpawnModelFromCatalog(CATALOG_MODELS, MISSING_MODEL, [
    { model: MISSING_MODEL },
    { model: "opencode-go/deepseek-v4.1-flash", variant: "low" },
  ])
  check(
    tag("decisão: configurado ausente avança a cadeia até o primeiro que resolve"),
    substituted.model === "opencode-go/deepseek-v4.1-flash#low" && substituted.substituted === true
      && substituted.exhausted === false && substituted.suggestions.length > 0,
    substituted.model,
  )
  const exhaustedDecision = resolveSpawnModelFromCatalog(CATALOG_MODELS, MISSING_MODEL, [
    { model: MISSING_MODEL },
    { model: "opencode-go/tambem-inexistente" },
  ])
  check(
    tag("decisão: cadeia inteira ausente = exhausted"),
    exhaustedDecision.exhausted === true && exhaustedDecision.model === undefined,
  )
  check(
    tag("decisão: sem modelo configurado não força a cadeia (default do servidor)"),
    resolveSpawnModelFromCatalog(CATALOG_MODELS, undefined, [{ model: "opencode-go/mimo-v2.6-flash" }]).model === undefined,
  )

  // -------------------------------------------------------------------------
  // B. Choke point client: catalog capability (v2 model.list + fallback providers)
  // -------------------------------------------------------------------------
  {
    const { raw, calls } = rawTransport({})
    const client = wrapThrowingClient(raw)
    const catalog = await fetchModelCatalog(client, "/tmp/projeto")
    check(
      tag("wrapThrowingClient expõe modelCatalog a partir de model.list"),
      Array.isArray(catalog) && catalog.length === 3 && catalog.some((m) => m.modelID === "deepseek-v4.1-flash"),
      `entries=${catalog?.length}`,
    )
    check(
      tag("model.list recebe location.directory (escopo do catálogo)"),
      JSON.stringify(calls.catalog[0]) === JSON.stringify({ location: { directory: "/tmp/projeto" } }),
      JSON.stringify(calls.catalog[0]),
    )
    check(
      tag("isSelectorAvailable aceita o catálogo REAL normalizado do SDK"),
      isSelectorAvailable(catalog, "opencode-go/deepseek-v4.1-flash#low"),
    )
  }
  {
    const { raw } = rawTransport({ catalogShape: "config-providers" })
    const client = wrapThrowingClient(raw)
    const catalog = await fetchModelCatalog(client)
    check(
      tag("fallback config.providers() normaliza o mapa de modelos"),
      Array.isArray(catalog) && catalog.some((m) => m.providerID === "opencode-go" && m.modelID === "mimo-v2.6-flash"),
      `entries=${catalog?.length}`,
    )
  }
  {
    const raw = {
      session: { create: async () => ({ data: { id: "s" } }), promptAsync: async () => ({}), abort: async () => ({}), status: async () => ({ data: {} }), messages: async () => ({ data: [] }), get: async () => ({ data: {} }) },
      tui: { showToast: async () => ({}), selectSession: async () => ({}) },
      worktree: { create: async () => ({ data: { name: "n", branch: "b", directory: "/d" } }), remove: async () => ({}), list: async () => ({ data: [] }), reset: async () => ({}) },
      experimental: { workspace: { create: async () => ({ data: { id: "w", type: "t", branch: null, directory: null, projectID: "p" } }), remove: async () => ({}), list: async () => ({ data: [] }) } },
    }
    const client = wrapThrowingClient(raw)
    check(tag("host sem API de catálogo → capability ausente (fail-open)"), client.modelCatalog === undefined)
    check(tag("fetchModelCatalog sem capability → undefined"), (await fetchModelCatalog(client)) === undefined)
  }
  {
    const { raw } = rawTransport({ catalogError: true })
    const client = wrapThrowingClient(raw)
    check(tag("erro no catálogo → fetchModelCatalog degrada para undefined"), (await fetchModelCatalog(client)) === undefined)
  }
  {
    // V2: ctx.catalog.model.list devolve ModelInfo[] e é exposto no adapter.
    const v2 = createV2Client({
      session: {
        create: async () => ({ id: "s" }), prompt: async () => ({}), switchAgent: async () => ({}),
        switchModel: async () => ({}), interrupt: async () => ({}), get: async () => ({}),
        context: async () => [], active: async () => ({}), synthetic: async () => ({}),
      },
      worktree: { create: async () => ({ directory: "/d" }), remove: async () => ({}), list: async () => [], refresh: async () => ({}) },
      permission: { rules: async () => ({}) },
      catalog: { model: { list: async () => ({ location: {}, data: CATALOG_MODELS }) } },
    })
    const catalog = await fetchModelCatalog(v2)
    check(
      tag("createV2Client expõe o catálogo nativo do ctx (V2)"),
      Array.isArray(catalog) && isSelectorAvailable(catalog, "opencode-go/mimo-v2.6-flash"),
      `entries=${catalog?.length}`,
    )
  }

  // -------------------------------------------------------------------------
  // C. executeTeamSpawn — validação ANTES de qualquer efeito colateral
  // -------------------------------------------------------------------------
  const spawnOnce = async (name, { configOverrides = {}, args = {}, transport = {}, teamSuffix = name } = {}) => {
    const root = path.join(ROOT, label, teamSuffix)
    rmSync(root, { recursive: true, force: true })
    mkdirSync(root, { recursive: true })
    const db = createDb(path.join(root, "ensemble.db"))
    seedTeam(db)
    const registry = new MemberRegistry()
    registry.register(LEAD_SESSION, "lead", TEAM_ID)
    const { raw, calls } = rawTransport(transport)
    const client = wrapThrowingClient(raw)
    const config = {
      ...DEFAULT_CONFIG,
      ...configOverrides,
    }
    const deps = { db, directory: root, client, registry, config, progressTracker: new ProgressTracker() }
    let error
    let result
    try {
      result = await executeTeamSpawn(deps, { name, prompt: `tarefa de ${name}`, ...args }, LEAD_SESSION)
    } catch (err) {
      error = err
    }
    await new Promise((r) => setTimeout(r, 25))
    const memberRow = db.query("SELECT * FROM team_member WHERE team_id = ? AND name = ?").get(TEAM_ID, name)
    return { db, calls, client, error, result, memberRow }
  }

  // C1. Bug vivo: configurado + fallbackModels[0] inexistentes, 2º degrau válido.
  {
    const out = await spawnOnce("ana", {
      configOverrides: {
        defaultModel: MISSING_MODEL,
        modelsByAgent: { build: MISSING_MODEL },
        fallbackModels: [MISSING_MODEL, "opencode-go/deepseek-v4.1-flash#low", "opencode-go/mimo-v2.6-flash"],
      },
      args: { agent: "build", worktree: false },
      teamSuffix: "live-bug",
    })
    check(tag("bug vivo: spawn NÃO morre e registra o membro"), !out.error && !!out.memberRow, out.error?.message)
    check(
      tag("bug vivo: modelo efetivo = primeiro da cadeia que o servidor serve"),
      out.memberRow?.model === "opencode-go/deepseek-v4.1-flash#low",
      `model=${out.memberRow?.model}`,
    )
    const prompt = out.calls.promptAsync[0]
    check(
      tag("bug vivo: promptAsync recebe provider/model/variant validados"),
      prompt?.model?.providerID === "opencode-go" && prompt?.model?.modelID === "deepseek-v4.1-flash" && prompt?.model?.variant === "low",
      JSON.stringify(prompt?.model),
    )
    const toast = out.calls.toast.find((t) => String(t?.message ?? "").includes(MISSING_MODEL))
    check(
      tag("bug vivo: toast acionável cita o modelo configurado ausente"),
      !!toast && String(toast.message).includes(MISSING_MODEL),
      String(toast?.message),
    )
    check(
      tag("bug vivo: toast traz Did you mean derivado do catálogo real"),
      !!toast && String(toast.message).includes("Did you mean:") && String(toast.message).includes("opencode-go/"),
      String(toast?.message),
    )
    check(tag("bug vivo: um único session.create (sem retry destrutivo)"), out.calls.sessionCreate.length === 1)
  }

  // C2. Cadeia inteira inexistente: erro ANTES de qualquer side effect.
  {
    const out = await spawnOnce("beto", {
      configOverrides: {
        defaultModel: MISSING_MODEL,
        modelsByAgent: { build: MISSING_MODEL },
        fallbackModels: [MISSING_MODEL, "opencode-go/outro-inexistente"],
      },
      args: { agent: "build" }, // worktree default = true (prova o não-efeito)
      teamSuffix: "exhausted",
    })
    check(tag("exaustão: spawn lança erro determinístico"), !!out.error)
    const msg = String(out.error?.message ?? "")
    check(
      tag("exaustão: mensagem cita modelo configurado + cadeia + Did you mean"),
      msg.includes(MISSING_MODEL) && msg.includes("opencode-go/outro-inexistente") && msg.includes("Did you mean:"),
      msg,
    )
    check(
      tag("exaustão: ZERO worktree.create / workspace.create / session.create"),
      out.calls.worktree.length === 0 && out.calls.workspace.length === 0 && out.calls.sessionCreate.length === 0,
      `wt=${out.calls.worktree.length} ws=${out.calls.workspace.length} ses=${out.calls.sessionCreate.length}`,
    )
    check(tag("exaustão: nenhum membro registrado no SQLite"), !out.memberRow)
    check(tag("exaustão: nenhum promptAsync disparado"), out.calls.promptAsync.length === 0)
  }

  // C3. Modelo válido: intocado, sem toast de substituição.
  {
    const out = await spawnOnce("carla", {
      configOverrides: {
        modelsByAgent: { build: "opencode-go/mimo-v2.6-flash#low" },
        fallbackModels: ["opencode-go/deepseek-v4.1-flash"],
      },
      args: { agent: "build", worktree: false },
      teamSuffix: "valid",
    })
    check(tag("válido: membro nasce com o modelo configurado"), !out.error && out.memberRow?.model === "opencode-go/mimo-v2.6-flash#low")
    check(tag("válido: nenhum toast de substituição"), out.calls.toast.length === 0, JSON.stringify(out.calls.toast))
    check(
      tag("válido: promptAsync leva o modelo exato (variant low)"),
      out.calls.promptAsync[0]?.model?.modelID === "mimo-v2.6-flash" && out.calls.promptAsync[0]?.model?.variant === "low",
    )
  }

  // C4. Catálogo indisponível: fail-open (comportamento legado preservado).
  {
    const out = await spawnOnce("dora", {
      configOverrides: {
        modelsByAgent: { build: MISSING_MODEL },
        fallbackModels: ["opencode-go/deepseek-v4.1-flash"],
      },
      args: { agent: "build", worktree: false },
      transport: { catalogShape: "none" },
      teamSuffix: "no-catalog",
    })
    check(tag("fail-open: spawn continua com o modelo configurado"), !out.error && out.memberRow?.model === MISSING_MODEL, out.error?.message)
    check(tag("fail-open: nenhum toast (não há catálogo para sugerir)"), out.calls.toast.length === 0)
    check(
      tag("fail-open: promptAsync mantém o seletor configurado"),
      out.calls.promptAsync[0]?.model?.providerID === "opencode-go"
        && out.calls.promptAsync[0]?.model?.modelID === "longcat-2.5-preview-free",
    )
  }

  // C5. enabled:false não resolve (modelo descontinuado no catálogo).
  {
    const out = await spawnOnce("egeu", {
      configOverrides: {
        modelsByAgent: { build: "opencode-go/retired-model" },
        fallbackModels: ["opencode-go/mimo-v2.6-flash"],
      },
      args: { agent: "build", worktree: false },
      transport: {
        catalog: [
          { id: "retired-model", modelID: "retired-model", providerID: "opencode-go", enabled: false },
          ...CATALOG_MODELS,
        ],
      },
      teamSuffix: "disabled",
    })
    check(
      tag("enabled:false é tratado como ausente e cai na cadeia"),
      !out.error && out.memberRow?.model === "opencode-go/mimo-v2.6-flash",
      `model=${out.memberRow?.model}`,
    )
  }

  // C6. Modelo explícito tem prioridade e também é validado.
  {
    const out = await spawnOnce("flora", {
      configOverrides: {
        modelsByAgent: { build: "opencode-go/mimo-v2.6-flash" },
        fallbackModels: ["opencode-go/deepseek-v4.1-flash"],
      },
      args: { agent: "build", worktree: false, model: MISSING_MODEL },
      teamSuffix: "explicit",
    })
    check(
      tag("explícito ausente: prioridade respeitada e substituído pela cadeia"),
      !out.error && out.memberRow?.model === "opencode-go/deepseek-v4.1-flash",
      `model=${out.memberRow?.model}`,
    )
  }

  // C7. Standby: valida no nascimento mesmo sem promptAsync.
  {
    const out = await spawnOnce("gaia", {
      configOverrides: {
        modelsByAgent: { build: MISSING_MODEL },
        fallbackModels: ["opencode-go/mimo-v2.6-flash#low"],
      },
      args: { agent: "build", worktree: false, standby: true },
      teamSuffix: "standby",
    })
    check(
      tag("standby: modelo validado/substituído no nascimento (zero promptAsync)"),
      !out.error && out.memberRow?.model === "opencode-go/mimo-v2.6-flash#low"
        && out.memberRow?.execution_status === "standby" && out.calls.promptAsync.length === 0,
      `model=${out.memberRow?.model} exec=${out.memberRow?.execution_status} prompts=${out.calls.promptAsync.length}`,
    )
  }

  // C8. Seletor malformado no config: cadeia resolve e o membro nasce válido.
  {
    const out = await spawnOnce("hugo-test", {
      configOverrides: {
        modelsByAgent: { build: "modelo-sem-provider" },
        fallbackModels: ["opencode-go/mimo-v2.6-flash"],
      },
      args: { agent: "build", worktree: false },
      teamSuffix: "malformed",
    })
    check(
      tag("malformado: cai na cadeia em vez de enviar lixo ao servidor"),
      !out.error && out.memberRow?.model === "opencode-go/mimo-v2.6-flash",
      `model=${out.memberRow?.model}`,
    )
  }

  // C9. Sem defaultModel e sem modelsByAgent: nada a validar (não força cadeia).
  {
    const out = await spawnOnce("iris", {
      configOverrides: { modelsByAgent: {}, fallbackModels: ["opencode-go/mimo-v2.6-flash"] },
      args: { agent: "build", worktree: false },
      teamSuffix: "no-model",
    })
    check(
      tag("sem modelo configurado: membro nasce sem model (default do servidor)"),
      !out.error && out.memberRow?.model == null && out.calls.promptAsync[0]?.model === undefined,
      `model=${out.memberRow?.model}`,
    )
  }

  check(tag("zero unhandledRejection durante a suíte"), unhandled.length === 0, unhandled.map(String).join(";"))
}

// ---------------------------------------------------------------------------
// 2. Execução nas duas camadas + veredito.
// ---------------------------------------------------------------------------
const distMods = await loadDist()
await runBehavior("dist", distMods)

const srcMods = await loadSrc()
await runBehavior("src", srcMods)

// Paridade estrutural mínima entre as camadas (mesmas decisões puras).
{
  const { resolveSpawnModelFromCatalog: distResolve } = distMods
  const { resolveSpawnModelFromCatalog: srcResolve } = srcMods
  const inputs = [
    [CATALOG_MODELS, MISSING_MODEL, [{ model: MISSING_MODEL }, { model: "opencode-go/deepseek-v4.1-flash#low" }]],
    [CATALOG_MODELS, "opencode-go/mimo-v2.6-flash", []],
    [undefined, MISSING_MODEL, []],
  ]
  const same = inputs.every(
    ([catalog, requested, chain]) =>
      JSON.stringify(distResolve(catalog, requested, chain)) === JSON.stringify(srcResolve(catalog, requested, chain)),
  )
  check("paridade src↔dist da decisão de spawn (mesma entrada, mesma saída)", same)
}

const failed = results.filter(([, ok]) => !ok)
console.log(`\nRESULT: ${results.length - failed.length}/${results.length} checks passed`)
if (failed.length > 0) {
  console.log("FAILED CHECKS:")
  for (const [name] of failed) console.log(`  - ${name}`)
  process.exit(1)
}
process.exit(0)
