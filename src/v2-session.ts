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
  /**
   * Bind the persona a session runs as (`SessionSwitchAgentInput` on the
   * server). This is the ONLY way to re-assert identity on V2: `ctx.session
   * .prompt` carries no `agent` field — its input is `{ sessionID, text,
   * files?, agents?, skills?, metadata?, delivery?, resume? }` (see
   * `@opencode/client` `SessionPromptInput`), so an `agent` key on `prompt`
   * would be silently stripped by the Effect schema and the server would
   * rebind the session to the installation default (`dante`). Optional in this
   * port so read-only fakes that never deliver a persona degrade to verbatim
   * delivery instead of throwing.
   */
  switchAgent?(input: { sessionID: string; agent: string }): Promise<unknown>
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

/**
 * Deliver a system text to a session. Uses queue delivery (spike-verified).
 *
 * Identity hardening (HARNESS-21, V2 family): when `agent` is provided the
 * persona is re-asserted via `switchAgent` BEFORE the prompt — the V2 analogue
 * of the `agent` field the V1 choke point (`wrapThrowingClient`) injects on
 * `promptAsync`. This closes the V2 gap where a nudge/wake omitted `agent` and
 * the server silently rebound the session to the default (`dante`), stealing
 * the member's persona and exclusive tool permissions.
 *
 * `agent` is injected only when truthy: an unknown/omitted resolver result
 * (sub-agent or isolated reviewer session) is delivered verbatim — never
 * resequenced into an arbitrary persona. If the port lacks `switchAgent`
 * (structural fake), the text is still delivered, just without a persona bind.
 */
export async function deliverPrompt(
  port: V2SessionPort,
  sessionID: string,
  text: string,
  agent?: string,
): Promise<unknown> {
  if (agent) await port.switchAgent?.({ sessionID, agent })
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
