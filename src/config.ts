import { readFileSync } from "node:fs"
import path from "node:path"

/**
 * Structured fallback model reference (config-level).
 * `model` is a "provider/model" selector WITHOUT variant suffix;
 * `variant` (e.g. "low") is carried separately so it can be forwarded to
 * `session.promptAsync` as `model.variant`.
 */
export interface ModelFallbackRef {
  model: string
  variant?: string
}

/** Canonical default fallback: cheap, always-available model with thinking level low. */
export const DEFAULT_MODEL_FALLBACK: Readonly<ModelFallbackRef> = Object.freeze({
  model: "google/antigravity-gemini-3.8-flash",
  variant: "low",
})

/** Parsed OpenCode model selector: "provider/model" + optional "#variant". */
export interface ParsedModelSelector {
  providerID: string
  modelID: string
  variant?: string
}

/**
 * Parse an OpenCode model selector into its parts.
 * Format: `provider/model` (model may contain additional slashes) with an
 * optional `#variant` suffix, e.g. "google/antigravity-gemini-3.8-flash#low".
 * Returns undefined when provider or model is empty (malformed selector).
 * Never throws — safe for config/delivery paths.
 */
export function parseModelSelector(selector: string): ParsedModelSelector | undefined {
  let base = selector
  let variant: string | undefined
  const hash = selector.indexOf("#")
  if (hash >= 0) {
    base = selector.slice(0, hash)
    const v = selector.slice(hash + 1).trim()
    if (v) variant = v
  }
  const slash = base.indexOf("/")
  if (slash <= 0 || slash === base.length - 1) return undefined
  const providerID = base.slice(0, slash)
  const modelID = base.slice(slash + 1)
  if (!providerID || !modelID) return undefined
  return variant ? { providerID, modelID, variant } : { providerID, modelID }
}

/** Format a fallback entry back into selector form: "provider/model[#variant]". */
export function formatModelSelector(entry: ModelFallbackRef): string {
  return entry.variant ? `${entry.model}#${entry.variant}` : entry.model
}

/**
 * Resolve the ordered fallback chain used when the primary model is
 * rate-limited (429/retry). Order:
 *   1. `fallbackModels` (if non-empty) — each entry parsed via parseModelSelector,
 *      malformed entries skipped, duplicates collapsed.
 *   2. `modelFallback` (if it carries a model) — tolerates a "#variant" suffix
 *      inside `model` as well as a separate `variant` field.
 *   3. `DEFAULT_MODEL_FALLBACK` (google/antigravity-gemini-3.8-flash, variant low) —
 *      guarantees the chain is never empty.
 */
export function resolveFallbackChain(config: EnsembleConfig): ModelFallbackRef[] {
  const chain: ModelFallbackRef[] = []
  const seen = new Set<string>()

  for (const selector of config.fallbackModels ?? []) {
    const parsed = parseModelSelector(selector)
    if (!parsed) continue
    const entry: ModelFallbackRef = {
      model: `${parsed.providerID}/${parsed.modelID}`,
      ...(parsed.variant ? { variant: parsed.variant } : {}),
    }
    const key = formatModelSelector(entry)
    if (seen.has(key)) continue
    seen.add(key)
    chain.push(entry)
  }
  if (chain.length > 0) return chain

  const mf = config.modelFallback
  if (mf?.model) {
    const parsed = parseModelSelector(mf.model)
    const model = parsed ? `${parsed.providerID}/${parsed.modelID}` : mf.model
    const variant = mf.variant || parsed?.variant
    return [variant ? { model, variant } : { model }]
  }

  return [{ model: DEFAULT_MODEL_FALLBACK.model, variant: DEFAULT_MODEL_FALLBACK.variant }]
}

/**
 * Pick the first chain entry whose selector differs from the primary model —
 * a fallback equal to the primary would fail over into itself. With no
 * primary, returns the head of the chain.
 */
export function selectFallbackModel(
  chain: readonly ModelFallbackRef[],
  primary?: string,
): ModelFallbackRef | undefined {
  if (chain.length === 0) return undefined
  if (!primary) return chain[0]
  const parsed = parseModelSelector(primary)
  const primaryKey = parsed
    ? formatModelSelector({ model: `${parsed.providerID}/${parsed.modelID}`, ...(parsed.variant ? { variant: parsed.variant } : {}) })
    : primary
  return chain.find((entry) => formatModelSelector(entry) !== primaryKey)
}

/**
 * Walk the fallback chain FORWARD from the member's CURRENT model — the
 * retry/rate-limit failover semantics (unlike selectFallbackModel, used at
 * spawn time):
 *   - current matches a chain entry → the NEXT entry; undefined when the
 *     current model is already the LAST entry — "chain exhausted", which is
 *     the only signal that authorizes waking the lead;
 *   - current is outside the chain → the first entry that differs from it;
 *   - no current model → the head of the chain.
 * Never wraps around to the head: exhausting the chain must stay observable.
 */
export function selectNextFallback(
  chain: readonly ModelFallbackRef[],
  current?: string | null,
): ModelFallbackRef | undefined {
  if (chain.length === 0) return undefined
  if (!current) return chain[0]
  const parsed = parseModelSelector(current)
  const key = parsed
    ? formatModelSelector({ model: `${parsed.providerID}/${parsed.modelID}`, ...(parsed.variant ? { variant: parsed.variant } : {}) })
    : current
  const idx = chain.findIndex((entry) => formatModelSelector(entry) === key)
  if (idx >= 0) return chain[idx + 1]
  return chain.find((entry) => formatModelSelector(entry) !== key)
}

/** Plugin configuration shape. All fields optional — defaults applied. */
export interface EnsembleConfig {
  /** Auto-merge worktree branches on cleanup (default: true) */
  mergeOnCleanup?: boolean
  /** Stall detection threshold in ms (default: 180000 = 3 min, 0 to disable) */
  stallThresholdMs?: number
  /** Min steps before token-based stall check (default: 3) */
  stallMinSteps?: number
  /** Output token threshold for stall detection (default: 500) */
  stallTokenThreshold?: number
  /** Hard timeout for busy members in ms (default: 1800000 = 30 min, 0 to disable) */
  timeoutMs?: number
  /** Rate limit capacity (default: 10, 0 to disable) */
  rateLimitCapacity?: number
  /** Dashboard server port (default: 4747, 0 to disable) */
  dashboardPort?: number
  /** Max peer messages per agent per window before nudge (default: 5, 0 to disable) */
  peerMessageLimit?: number
  /** Time window for peer message rate limiting in ms (default: 300000 = 5 min) */
  peerMessageWindowMs?: number
  /** Default model for all agents (e.g. "opencode/zen-sonnet-4-6") */
  defaultModel?: string
  /** Pool of models for rotation/random assignment */
  modelPool?: string[]
  /** Map agent type to specific model e.g. {"build": "anthropic/claude-opus-4-6"} */
  modelsByAgent?: Record<string, string>
  /** How to assign models: "default" | "rotate" | "random" (default: "default") */
  modelAssignment?: "default" | "rotate" | "random"
  /** Lead asks user about model preferences before spawning (default: false) */
  promptForModels?: boolean
  /**
   * Ordered chain of fallback model selectors tried when the primary model is
   * rate-limited (429/retry). Each entry uses the OpenCode selector format
   * "provider/model" with an optional "#variant" suffix, e.g.
   * "google/antigravity-gemini-3.8-flash#low".
   * Empty (default) resolves to `modelFallback`; see resolveFallbackChain().
   */
  fallbackModels?: string[]
  /**
   * Structured default fallback entry (model + variant) used when
   * `fallbackModels` is empty. Default: google/antigravity-gemini-3.8-flash
   * with variant "low" (see DEFAULT_MODEL_FALLBACK).
   */
  modelFallback?: ModelFallbackRef
  /**
   * Silence lead wake-ups coming from team_message (default: true).
   * When active, lead-bound messages are persisted in SQLite only — the
   * `promptAsync` wake is suppressed and the lead is woken exclusively by the
   * systematic board-complete event. Set to false to restore the legacy wake.
   */
  silentLead?: boolean
}

/** Default configuration values. */
export const DEFAULT_CONFIG: Required<EnsembleConfig> = {
  mergeOnCleanup: true,
  stallThresholdMs: 300_000,
  stallMinSteps: 5,
  stallTokenThreshold: 200,
  timeoutMs: 30 * 60 * 1000,
  rateLimitCapacity: 10,
  dashboardPort: 4747,
  peerMessageLimit: 5,
  peerMessageWindowMs: 300_000,
  defaultModel: "",
  modelPool: [],
  modelsByAgent: {},
  modelAssignment: "default",
  promptForModels: false,
  fallbackModels: [],
  modelFallback: { model: DEFAULT_MODEL_FALLBACK.model, variant: DEFAULT_MODEL_FALLBACK.variant },
  silentLead: true,
}

/** Read a JSON config file, returning an empty object on missing/invalid. */
function readConfigFile(filePath: string): Partial<EnsembleConfig> {
  try {
    const text = readFileSync(filePath, "utf-8")
    const raw = JSON.parse(text) as Record<string, unknown>
    // Validate types — only accept numbers for numeric fields, booleans for boolean fields
    const result: Partial<EnsembleConfig> = {}
    if (typeof raw.mergeOnCleanup === "boolean") result.mergeOnCleanup = raw.mergeOnCleanup
    if (typeof raw.stallThresholdMs === "number") result.stallThresholdMs = raw.stallThresholdMs
    if (typeof raw.stallMinSteps === "number") result.stallMinSteps = raw.stallMinSteps
    if (typeof raw.stallTokenThreshold === "number") result.stallTokenThreshold = raw.stallTokenThreshold
    if (typeof raw.timeoutMs === "number") result.timeoutMs = raw.timeoutMs
    if (typeof raw.rateLimitCapacity === "number") result.rateLimitCapacity = raw.rateLimitCapacity
    if (typeof raw.dashboardPort === "number") result.dashboardPort = raw.dashboardPort
    if (typeof raw.peerMessageLimit === "number") result.peerMessageLimit = raw.peerMessageLimit
    if (typeof raw.peerMessageWindowMs === "number") result.peerMessageWindowMs = raw.peerMessageWindowMs
    if (typeof raw.defaultModel === "string") result.defaultModel = raw.defaultModel
    if (Array.isArray(raw.modelPool) && raw.modelPool.every((m: unknown) => typeof m === "string")) result.modelPool = raw.modelPool as string[]
    if (typeof raw.modelsByAgent === "object" && raw.modelsByAgent !== null && !Array.isArray(raw.modelsByAgent)) {
      const valid = Object.entries(raw.modelsByAgent as Record<string, unknown>).every(([, v]) => typeof v === "string")
      if (valid) result.modelsByAgent = raw.modelsByAgent as Record<string, string>
    }
    if (typeof raw.modelAssignment === "string" && ["default", "rotate", "random"].includes(raw.modelAssignment)) result.modelAssignment = raw.modelAssignment as "default" | "rotate" | "random"
    if (typeof raw.promptForModels === "boolean") result.promptForModels = raw.promptForModels
    if (
      Array.isArray(raw.fallbackModels)
      && raw.fallbackModels.every((m: unknown) => typeof m === "string" && m.trim().length > 0)
    ) {
      result.fallbackModels = raw.fallbackModels as string[]
    }
    if (typeof raw.modelFallback === "object" && raw.modelFallback !== null && !Array.isArray(raw.modelFallback)) {
      const mf = raw.modelFallback as Record<string, unknown>
      if (typeof mf.model === "string" && mf.model.trim().length > 0) {
        result.modelFallback = typeof mf.variant === "string" && mf.variant.trim().length > 0
          ? { model: mf.model, variant: mf.variant }
          : { model: mf.model }
      }
    }
    if (typeof raw.silentLead === "boolean") result.silentLead = raw.silentLead
    return result
  } catch (err) {
    if (err && typeof err === "object" && "code" in err && err.code === "ENOENT") return {}
    console.warn(`[ensemble] Invalid config at ${filePath}, using defaults`)
    return {}
  }
}

/**
 * Load plugin configuration. Merges global → project → env vars.
 * Missing files are silently skipped. Invalid JSON logs a warning.
 */
export function loadConfig(projectDir: string): Required<EnsembleConfig> {
  const homeDir = process.env.HOME ?? process.env.USERPROFILE ?? ""
  const globalPath = path.join(homeDir, ".config", "opencode", "ensemble.json")
  const projectPath = path.join(projectDir, ".opencode", "ensemble.json")

  const global = readConfigFile(globalPath)
  const project = readConfigFile(projectPath)
  const merged = { ...DEFAULT_CONFIG, ...global, ...project }

  // Env vars override everything
  const timeout = process.env.OPENCODE_ENSEMBLE_TIMEOUT
  if (timeout !== undefined) merged.timeoutMs = timeout === "0" ? 0 : (parseInt(timeout, 10) || merged.timeoutMs)

  const rateLimit = process.env.OPENCODE_ENSEMBLE_RATE_LIMIT
  if (rateLimit !== undefined) merged.rateLimitCapacity = rateLimit === "0" ? 0 : (parseInt(rateLimit, 10) || merged.rateLimitCapacity)

  const stall = process.env.STALL_THRESHOLD_MS
  if (stall !== undefined) merged.stallThresholdMs = stall === "0" ? 0 : (parseInt(stall, 10) || merged.stallThresholdMs)

  return merged
}
