import type { PluginClient } from "./types"
import { log } from "./log"

/**
 * TICKET-RELEASE-17 — deterministic standby pause + narrow repetition alarm.
 *
 * Field evidence (kael, `ses_e95cf5e26ffenZ5DyprQl6CvdP`, 23/10/2026): 49
 * consecutive `team_standby` calls across 41 model steps in 6m51s. `team_standby`
 * only wrote `execution_status='standby'` and returned a string — ending the turn
 * was left to the model, which kept re-emitting the same tool call. This module
 * gives the runtime the lever the model refused to pull:
 *
 *   1. `scheduleStandbyAbort()` ends the caller's turn AFTER the tool result is
 *      persisted (macrotask tick, never inside the tool executor), marking the
 *      abort as INTENTIONAL so `isAbortError()`/`handleSessionErrorEvent()` can
 *      absorb the host's `MessageAbortedError` without a false lead alarm.
 *   2. `incrementStandbyLoop()` counts CONSECUTIVE `team_standby` calls in the
 *      same session. Any other tool call, or a new turn (message wake), resets
 *      the counter. At the third consecutive call the abort is logged as
 *      `standby:loop-breaker` — a belt-and-suspenders in case the first abort
 *      never landed.
 *
 * Scope is deliberately NARROW: only `team_standby` (and the transmitter side of
 * `team_task_handover`) is affected. Repeated searches, reads, bash or any other
 * legitimate exploration NEVER trip this alarm.
 */

/** How many consecutive `team_standby` calls are tolerated before the breaker fires. */
export const STANDBY_LOOP_LIMIT = 3

/**
 * An intentional-abort mark is honoured for this long. The host emits the
 * `session.error` noise within the same turn, so a short window is enough and
 * prevents a stale mark from swallowing a genuine error minutes later.
 */
export const INTENTIONAL_ABORT_TTL_MS = 30_000

/** sessionID -> consecutive `team_standby` count. */
const standbyLoopCounts = new Map<string, number>()

/** sessionID -> epoch-ms of the last intentional abort. */
const intentionalAborts = new Map<string, number>()

/** Reset the consecutive-standby counter for a session. */
export function resetStandbyLoop(sessionId: string | undefined | null): void {
  if (!sessionId) return
  standbyLoopCounts.delete(sessionId)
}

/**
 * Compute the next consecutive-`team_standby` count for a session and store it.
 * Called by the tool executor itself (V1 and V2 share the executor), so the
 * count exists even when the platform routes tools through Code Mode.
 */
export function incrementStandbyLoop(sessionId: string | undefined | null): number {
  if (!sessionId) return 0
  const next = (standbyLoopCounts.get(sessionId) ?? 0) + 1
  standbyLoopCounts.set(sessionId, next)
  return next
}

/** Current consecutive-`team_standby` count (0 when untracked). */
export function getStandbyLoopCount(sessionId: string | undefined | null): number {
  if (!sessionId) return 0
  return standbyLoopCounts.get(sessionId) ?? 0
}

/**
 * Feed every tool call through here BEFORE execution. Anything that is not
 * `team_standby` breaks the consecutive chain and resets the counter — this is
 * what keeps the alarm strictly scoped to the standby loop.
 */
export function noteToolCall(sessionId: string | undefined | null, tool: string): void {
  if (!sessionId) return
  if (tool === "team_standby") return // counting happens in the executor (single writer)
  standbyLoopCounts.delete(sessionId)
}

/** Mark the next abort of this session as plugin-intentional (no lead alarm). */
export function markIntentionalAbort(sessionId: string): void {
  if (!sessionId) return
  intentionalAborts.set(sessionId, Date.now())
}

/**
 * Consume (one-shot) the intentional-abort mark for a session. Returns true
 * when a fresh mark existed; expired marks are dropped without effect.
 */
export function consumeIntentionalAbort(sessionId: string | undefined | null): boolean {
  if (!sessionId) return false
  const at = intentionalAborts.get(sessionId)
  if (at === undefined) return false
  intentionalAborts.delete(sessionId)
  return Date.now() - at <= INTENTIONAL_ABORT_TTL_MS
}

/** Drop every in-memory trace for a session (shutdown / teardown). */
export function clearStandbyGuard(sessionId: string | undefined | null): void {
  if (!sessionId) return
  standbyLoopCounts.delete(sessionId)
  intentionalAborts.delete(sessionId)
}

/**
 * End the caller's turn deterministically, AFTER the tool result has been
 * written. `setImmediate` (macrotask) is used instead of a microtask on
 * purpose: the runtime persists the tool result between the executor's promise
 * settling and the next macrotask, so aborting in a microtask would race the
 * persistence and could lose the confirmation text.
 *
 * The abort is fire-and-forget: transport failures only log, they never break
 * the tool result nor flip the member to `error`.
 */
export function scheduleStandbyAbort(
  client: PluginClient,
  sessionId: string | undefined | null,
  reason: string,
): void {
  if (!sessionId) return
  markIntentionalAbort(sessionId)
  const fire = (): void => {
    Promise.resolve()
      .then(() => client.session.abort({ sessionID: sessionId }))
      .catch((err) => {
        log(`standby:abort-failed session=${sessionId} reason=${reason} err=${err instanceof Error ? err.message : String(err)}`)
      })
  }
  if (typeof setImmediate === "function") setImmediate(fire)
  else setTimeout(fire, 0)
}
