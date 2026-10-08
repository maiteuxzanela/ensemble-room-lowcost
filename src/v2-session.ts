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
