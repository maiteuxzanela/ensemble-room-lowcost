import type { Database } from "./db"
import type { MemberRegistry, DescendantTracker } from "./state"
import type { PluginClient } from "./types"
import type { EnsembleConfig } from "./config"
import { log } from "./log"
import {
  handleRetryModelFailover,
  handleSessionCreatedEvent,
  handleSessionStatusEvent,
  type RetryStatusPayload,
  type StatusTransition,
} from "./hooks"

/** Minimal structural shape of a V2 server event. */
export interface V2EventLike {
  type: string
  data?: {
    sessionID?: string
    parentID?: string
    status?: string | {
      type?: string
      attempt?: number
      message?: string
      next?: number
      action?: { reason?: string; provider?: string; title?: string; message?: string; label?: string; link?: string }
    }
    attempt?: number
    at?: number
    error?: { message?: string }
  }
}

/**
 * Context for the silent rate-limit failover (zero-noise policy). Omitting it
 * disables failover entirely — dispatch keeps its legacy persist-only retry
 * behavior, so existing callers/tests stay valid.
 */
export interface V2FailoverCtx {
  client: PluginClient
  config: Required<EnsembleConfig>
}

/**
 * Coerce whatever the server sent on a retry status into the retry payload
 * shape. Older/partial payloads are tolerated (undefined fields, same
 * coercion rule as handleSessionStatusEvent's bindings).
 */
function coerceRetryPayload(raw: NonNullable<V2EventLike["data"]>["status"]): RetryStatusPayload | undefined {
  if (typeof raw !== "object" || raw === null || raw.type !== "retry") return undefined
  return {
    attempt: typeof raw.attempt === "number" ? raw.attempt : 0,
    message: typeof raw.message === "string" ? raw.message : "rate limited",
    next: typeof raw.next === "number" ? raw.next : Date.now(),
    ...(raw.action ? { action: raw.action as RetryStatusPayload["action"] } : {}),
  }
}

/**
 * Dispatch a V2 server event to the shared member state machine in hooks.ts.
 * Returns the status transition when one occurred (for notifications).
 *
 * On retry events (rate limit), the member's model is failed over SILENTLY
 * via handleRetryModelFailover when `failoverCtx` is provided: the lead is
 * woken only when the fallback chain is exhausted (zero-noise mandate).
 */
export function dispatchV2Event(
  db: Database,
  registry: MemberRegistry,
  tracker: DescendantTracker,
  event: V2EventLike,
  failoverCtx?: V2FailoverCtx,
): StatusTransition | undefined {
  const data = event.data ?? {}
  switch (event.type) {
    case "session.status": {
      const raw = data.status
      const status = typeof raw === "string" ? raw : raw?.type
      if (status === "idle" || status === "busy") {
        return handleSessionStatusEvent(db, registry, data.sessionID ?? "", status)
      }
      if (status === "retry") {
        // Legacy Fix-2 bug: the payload was dropped here, so retry_* columns
        // never persisted for session.status-delivered retries. Coerce and
        // forward it now.
        const payload = coerceRetryPayload(raw)
        const transition = handleSessionStatusEvent(db, registry, data.sessionID ?? "", "retry", payload)
        if (failoverCtx) {
          handleRetryModelFailover(
            db,
            registry,
            failoverCtx.client,
            failoverCtx.config,
            data.sessionID ?? "",
            payload,
          ).catch((err) => {
            log(`v2:failover:failed session=${data.sessionID} err=${err instanceof Error ? err.message : String(err)}`)
          })
        }
        return transition
      }
      return undefined
    }
    case "session.idle":
      if (!data.sessionID) return undefined
      return handleSessionStatusEvent(db, registry, data.sessionID, "idle")
    case "session.execution.started":
      if (!data.sessionID) return undefined
      return handleSessionStatusEvent(db, registry, data.sessionID, "busy")
    case "session.execution.succeeded":
    case "session.execution.failed":
      // Ended means idle even on failure — the idle-without-report nudge then
      // prompts the teammate to report, which surfaces the failure to the lead.
      if (!data.sessionID) return undefined
      return handleSessionStatusEvent(db, registry, data.sessionID, "idle")
    case "session.created":
      handleSessionCreatedEvent(tracker, data.sessionID ?? "", data.parentID)
      return undefined
    case "session.retry.scheduled": {
      if (!data.sessionID) return undefined
      const attempt = typeof data.attempt === "number" ? data.attempt : 0
      const next = typeof data.at === "number" ? data.at : Date.now()
      const payload: RetryStatusPayload = {
        attempt,
        message: data.error?.message ?? "rate limited",
        next,
      }
      const transition = handleSessionStatusEvent(db, registry, data.sessionID, "retry", payload)
      if (failoverCtx) {
        handleRetryModelFailover(
          db,
          registry,
          failoverCtx.client,
          failoverCtx.config,
          data.sessionID,
          payload,
        ).catch((err) => {
          log(`v2:failover:failed session=${data.sessionID} err=${err instanceof Error ? err.message : String(err)}`)
        })
      }
      return transition
    }
    default:
      return undefined
  }
}
