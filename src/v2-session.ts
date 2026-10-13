/** V2 session adapter (issue #36). Wraps the `ctx.session` subset Ensemble uses. */

/** A V2 permission rule: ordered, last match wins. Child sessions inherit. */
export interface V2PermissionRule {
  action: string
  resource: string
  effect: "allow" | "deny" | "ask"
}

/** Minimal structural subset of the V2 `ctx.session` domain. */
export interface V2SessionPort {
  create(input: {
    title?: string
    agent?: string
    parentID?: string
    permissions?: V2PermissionRule[]
  }): Promise<{ id: string }>
  prompt(input: { sessionID: string; text: string; delivery?: "steer" | "queue" }): Promise<unknown>
  interrupt(input: { sessionID: string }): Promise<unknown>
}

/** Input for spawning a teammate session on V2. */
export interface CreateTeammateInput {
  title: string
  agent: string
  parentID?: string
  permissions?: V2PermissionRule[]
}

/** Create a teammate session. Returns the child session ID. */
export async function createTeammateSession(
  port: V2SessionPort,
  input: CreateTeammateInput,
): Promise<string> {
  const created = await port.create({
    title: input.title,
    agent: input.agent,
    ...(input.parentID ? { parentID: input.parentID } : {}),
    ...(input.permissions ? { permissions: input.permissions } : {}),
  })
  return created.id
}

/** Deliver a system text to a session. Uses queue delivery (spike-verified). */
export async function deliverPrompt(
  port: V2SessionPort,
  sessionID: string,
  text: string,
): Promise<unknown> {
  return port.prompt({ sessionID, text, delivery: "queue" })
}

/** Interrupt a teammate session (V2 replacement for abort). Best-effort. */
export async function interruptTeammate(port: V2SessionPort, sessionID: string): Promise<unknown> {
  return port.interrupt({ sessionID })
}

/* ------------------------------------------------------------------ *
 * In-flight prompt delivery tracking (forced model switch, #27).
 *
 * A `team_message` with `model` + `force: true` must interrupt an HTTP
 * request that is stuck awaiting a response before the turn is restarted on
 * the new model. Each delivery registers its AbortController here so a later
 * forced switch can cancel it. The controller's signal reaches the SDK's
 * fetch (RequestInit.signal), so aborting tears down the pending request.
 *
 * Keyed by sessionID: one session has at most one live delivery at a time —
 * a newer delivery supersedes and aborts the previous one.
 * ------------------------------------------------------------------ */

/** Live prompt deliveries, keyed by sessionID. */
const inflight = new Map<string, AbortController>()

/**
 * Register an AbortController for a new delivery to `sessionID`, aborting any
 * prior in-flight delivery for the same session (it is superseded). Returns
 * the controller — pass `controller.signal` to `session.promptAsync`.
 */
export function trackPrompt(sessionID: string): AbortController {
  const prior = inflight.get(sessionID)
  if (prior && !prior.signal.aborted) prior.abort()
  const controller = new AbortController()
  inflight.set(sessionID, controller)
  return controller
}

/**
 * Abort the in-flight delivery for `sessionID`, if any. Used by the forced
 * model switch to tear down a stuck HTTP request before restarting the turn.
 * Returns true when a live (non-aborted) request was actually cancelled.
 */
export function abortInflight(sessionID: string): boolean {
  const controller = inflight.get(sessionID)
  if (!controller) return false
  inflight.delete(sessionID)
  if (controller.signal.aborted) return false
  controller.abort()
  return true
}

/**
 * Stop tracking a delivery once it settled (success, failure, or abort).
 * Only clears the map entry if it still points at this controller, so a
 * newer delivery's controller is never dropped by a stale settle.
 */
export function endTracked(sessionID: string, controller: AbortController): void {
  if (inflight.get(sessionID) === controller) inflight.delete(sessionID)
}
