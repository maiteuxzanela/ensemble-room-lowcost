import type { Database } from "./db"
import type { MemberRegistry, DescendantTracker } from "./state"
import {
  handleSessionCreatedEvent,
  handleSessionStatusEvent,
  type StatusTransition,
} from "./hooks"

/** Minimal structural shape of a V2 server event. */
export interface V2EventLike {
  type: string
  data?: {
    sessionID?: string
    parentID?: string
    status?: string | { type?: string }
    attempt?: number
    at?: number
    error?: { message?: string }
  }
}

/**
 * Dispatch a V2 server event to the shared member state machine in hooks.ts.
 * Returns the status transition when one occurred (for notifications).
 */
export function dispatchV2Event(
  db: Database,
  registry: MemberRegistry,
  tracker: DescendantTracker,
  event: V2EventLike,
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
        return handleSessionStatusEvent(db, registry, data.sessionID ?? "", "retry")
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
      return handleSessionStatusEvent(db, registry, data.sessionID, "retry", {
        attempt,
        message: data.error?.message ?? "rate limited",
        next,
      })
    }
    default:
      return undefined
  }
}
