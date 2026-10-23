import type { PluginClient, ModelCatalogEntry } from "./types"

/** Extract error message from a HeyAPI error response. */
function extractError(err: unknown): string {
  if (err && typeof err === "object" && "message" in err) return String((err as { message: string }).message)
  return String(err)
}

/** Generic async SDK method type. Actual type safety enforced by PluginClient interface. */
type SdkMethod = (...args: unknown[]) => Promise<unknown>

/** Wrap a single async SDK method to throw on { error } responses. */
function throwing(fn: SdkMethod): SdkMethod {
  return async (...args: unknown[]) => {
    const result = await fn(...args)
    if (result && typeof result === "object" && "error" in result && result.error !== undefined) {
      throw new Error(extractError(result.error))
    }
    return result
  }
}

/** Resolve the agent (persona) a session must run as. `undefined` = unknown. */
export type AgentResolver = (sessionID: string) => string | undefined

/**
 * Like `throwing`, but for `session.promptAsync`: when a caller omits `agent`,
 * the resolved persona for `params.sessionID` is injected so the OpenCode
 * server does not silently rebind the session to the installation default
 * (usually `dante`) and clobber `session.agent`.
 *
 * Injection contract (only when an `agentResolver` is provided):
 *   - `params.agent` absent (undefined/null/empty string) → resolve via
 *     `sessionID`; on a hit, the raw call receives a SHALLOW COPY with the
 *     resolved `agent` set (the caller's params object is never mutated, so
 *     explicit retries/aborts built from the same object stay intact);
 *   - `params.agent` already explicit → NEVER overwritten;
 *   - resolver returns `undefined` (unknown session) or `sessionID` is
 *     missing → params pass through verbatim (no invented fallback).
 */
function throwingPromptAsync(fn: SdkMethod, agentResolver?: AgentResolver): SdkMethod {
  return async (...args: unknown[]) => {
    const [params, ...rest] = args
    let effectiveParams = params
    if (agentResolver && params && typeof params === "object") {
      const injected = params as { agent?: unknown; sessionID?: unknown }
      const agent = injected.agent
      const hasExplicitAgent = agent !== undefined && agent !== null && !(typeof agent === "string" && agent.length === 0)
      if (!hasExplicitAgent && typeof injected.sessionID === "string" && injected.sessionID.length > 0) {
        const resolved = agentResolver(injected.sessionID)
        if (resolved) effectiveParams = { ...(params as Record<string, unknown>), agent: resolved }
      }
    }
    const result = await fn(effectiveParams, ...rest)
    if (result && typeof result === "object" && "error" in result && result.error !== undefined) {
      throw new Error(extractError(result.error))
    }
    return result
  }
}

/** Shape of the raw v2 SDK client — just the methods we wrap. */
interface RawClient {
  session: { create: SdkMethod; promptAsync: SdkMethod; abort: SdkMethod; status: SdkMethod; messages: SdkMethod; get: SdkMethod }
  tui: { showToast: SdkMethod; selectSession: SdkMethod }
  worktree: { create: SdkMethod; remove: SdkMethod; list: SdkMethod; reset: SdkMethod }
  experimental: { workspace: { create: SdkMethod; remove: SdkMethod; list: SdkMethod } }
  /** Optional catalog domains (present on the real host client). */
  model?: { list?: SdkMethod }
  config?: { providers?: SdkMethod }
}

/** Extract `{ error }` from a HeyAPI result, if any. */
function resultError(result: unknown): unknown {
  if (!result || typeof result !== "object" || !("error" in result)) return undefined
  const error = (result as { error?: unknown }).error
  return error === undefined ? undefined : error
}

/** Map raw model records (v2 `model.list` entries) into catalog entries. */
function toCatalogEntries(models: unknown): ModelCatalogEntry[] {
  if (!Array.isArray(models)) return []
  const entries: ModelCatalogEntry[] = []
  for (const raw of models) {
    if (!raw || typeof raw !== "object") continue
    const record = raw as { id?: unknown; modelID?: unknown; providerID?: unknown; enabled?: unknown }
    const modelID = typeof record.modelID === "string" && record.modelID.length > 0
      ? record.modelID
      : typeof record.id === "string" && record.id.length > 0 ? record.id : undefined
    if (typeof record.providerID !== "string" || record.providerID.length === 0 || !modelID) continue
    entries.push({
      providerID: record.providerID,
      modelID,
      ...(typeof record.enabled === "boolean" ? { enabled: record.enabled } : {}),
    })
  }
  return entries
}

/** v2 SDK `model.list()` → { data: { location, data: ModelInfo[] } }. */
function catalogFromModelList(result: unknown): ModelCatalogEntry[] | undefined {
  const payload = (result as { data?: unknown } | null | undefined)?.data
  if (!payload || typeof payload !== "object") return undefined
  const models = (payload as { data?: unknown }).data
  return Array.isArray(models) ? toCatalogEntries(models) : undefined
}

/** v2 SDK `config.providers()` → { data: { providers, default } }. */
function catalogFromConfigProviders(result: unknown): ModelCatalogEntry[] | undefined {
  const payload = (result as { data?: unknown } | null | undefined)?.data
  if (!payload || typeof payload !== "object") return undefined
  const providers = (payload as { providers?: unknown }).providers
  if (!Array.isArray(providers)) return undefined
  const entries: ModelCatalogEntry[] = []
  for (const raw of providers) {
    if (!raw || typeof raw !== "object") continue
    const provider = raw as { id?: unknown; models?: unknown }
    if (typeof provider.id !== "string" || provider.id.length === 0) continue
    const models = provider.models
    if (Array.isArray(models)) {
      for (const entry of toCatalogEntries(models)) {
        entries.push({ ...entry, providerID: provider.id })
      }
      continue
    }
    if (!models || typeof models !== "object") continue
    for (const [modelID, value] of Object.entries(models)) {
      if (!modelID) continue
      const enabled = value && typeof value === "object"
        ? (value as { enabled?: unknown }).enabled
        : undefined
      entries.push({
        providerID: provider.id,
        modelID,
        ...(typeof enabled === "boolean" ? { enabled } : {}),
      })
    }
  }
  return entries
}

/**
 * Build the optional live-catalog capability from whatever the host client
 * offers. Preference order:
 *   1. `model.list()` — flat served-model list (v2 transport), includes
 *      `enabled`, so disabled models do not resolve;
 *   2. `config.providers()` — provider map fallback (classic transport).
 * A host with neither leaves the capability undefined: spawns fail open.
 */
function buildModelCatalog(raw: RawClient): PluginClient["modelCatalog"] | undefined {
  const modelList = raw.model?.list
  const providers = raw.config?.providers
  if (!modelList && !providers) return undefined
  return {
    list: async (options) => {
      const directory = options?.directory
      if (modelList) {
        try {
          const result = await modelList(directory ? { location: { directory } } : undefined)
          const error = resultError(result)
          if (error !== undefined) throw new Error(extractError(error))
          const entries = catalogFromModelList(result)
          if (entries && entries.length > 0) return { data: entries }
        } catch (err) {
          // Fall through to the provider map; when there is none, report empty
          // (caller fails open) instead of breaking the spawn.
          if (!providers) return {}
          void err
        }
      }
      if (!providers) return {}
      try {
        const result = await providers(directory ? { directory } : undefined)
        const error = resultError(result)
        if (error !== undefined) throw new Error(extractError(error))
        const entries = catalogFromConfigProviders(result)
        return entries && entries.length > 0 ? { data: entries } : {}
      } catch {
        return {}
      }
    },
  }
}

/**
 * Wraps a raw v2 SDK client so that methods throw on error responses
 * instead of returning { error }. This makes existing try/catch blocks work.
 *
 * When `agentResolver` is provided, `session.promptAsync` transparently
 * injects the resolved `agent` for the target session whenever the caller
 * omitted it (see `throwingPromptAsync`). Omitting the resolver preserves the
 * legacy pass-through behavior.
 */
export function wrapThrowingClient(raw: unknown, agentResolver?: AgentResolver): PluginClient {
  const r = raw as RawClient
  const modelCatalog = buildModelCatalog(r)
  return {
    session: {
      create: throwing(r.session.create.bind(r.session)),
      promptAsync: throwingPromptAsync(r.session.promptAsync.bind(r.session), agentResolver),
      abort: throwing(r.session.abort.bind(r.session)),
      status: throwing(r.session.status.bind(r.session)),
      messages: throwing(r.session.messages.bind(r.session)),
      get: throwing(r.session.get.bind(r.session)),
    },
    tui: {
      showToast: throwing(r.tui.showToast.bind(r.tui)),
      selectSession: throwing(r.tui.selectSession.bind(r.tui)),
    },
    worktree: {
      create: throwing(r.worktree.create.bind(r.worktree)),
      remove: throwing(r.worktree.remove.bind(r.worktree)),
      list: throwing(r.worktree.list.bind(r.worktree)),
      reset: throwing(r.worktree.reset.bind(r.worktree)),
    },
    workspace: {
      create: throwing(r.experimental.workspace.create.bind(r.experimental.workspace)),
      remove: throwing(r.experimental.workspace.remove.bind(r.experimental.workspace)),
      list: throwing(r.experimental.workspace.list.bind(r.experimental.workspace)),
    },
    // TICKET-RELEASE-10 (F1): live catalog capability, only when the host
    // transport exposes one. Never required — absence means fail-open.
    ...(modelCatalog ? { modelCatalog } : {}),
  } as PluginClient
}
