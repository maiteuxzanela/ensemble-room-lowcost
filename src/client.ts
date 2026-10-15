import type { PluginClient } from "./types"

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
  } as PluginClient
}
