import type { Database } from "./db"

/** A parsed provider/model pair, as accepted by session.promptAsync. */
export interface ParsedModel {
  providerID: string
  modelID: string
  /**
   * Thinking-level variant from an OpenCode selector suffix (e.g. "#low" in
   * "google/antigravity-gemini-3.8-flash#low"). It is never folded into
   * `modelID` — it rides along in the prompt body as `model.variant` so the
   * server can resolve variant overlays at request time.
   */
  variant?: string
}

/**
 * Parse a "provider/model" string into { providerID, modelID } for the SDK.
 * Returns undefined if the string is not in "provider/model" form (empty
 * provider or empty model). The model portion may itself contain slashes.
 * An optional "#variant" suffix (OpenCode selector format, e.g.
 * "google/antigravity-gemini-3.8-flash#low") is stripped here — variants
 * travel via promptAsync's model.variant, never inside modelID.
 */
export function parseModelId(model: string): ParsedModel | undefined {
  const hash = model.indexOf("#")
  const variant = hash >= 0 ? model.slice(hash + 1) : undefined
  const base = hash >= 0 ? model.slice(0, hash) : model
  const slash = base.indexOf("/")
  if (slash <= 0 || slash === base.length - 1) return undefined
  const parsed: ParsedModel = { providerID: base.slice(0, slash), modelID: base.slice(slash + 1) }
  if (variant) parsed.variant = variant
  return parsed
}

/**
 * Read a team member's stored model and parse it for session.promptAsync.
 * Returns undefined when the member is unknown, has no model set, or the
 * stored value is malformed. Never throws — safe to call from delivery paths.
 */
export function getMemberModel(db: Database, teamId: string, memberName: string): ParsedModel | undefined {
  const row = db.query("SELECT model FROM team_member WHERE team_id = ? AND name = ?")
    .get(teamId, memberName) as { model: string | null } | null
  if (!row?.model) return undefined
  return parseModelId(row.model)
}

/**
 * Resolve the agent (persona) a session must run as, straight from the
 * canonical SQLite tables. Consumed by the client choke point
 * (wrapThrowingClient) to re-inject the `agent` field on
 * `session.promptAsync` calls whose caller omitted it.
 *
 * Resolution order (deterministic, fail-safe):
 *   1. `team_member.session_id = ?` → the member's own `agent` (when non-empty).
 *   2. `team.lead_session_id = ?` → the team's `lead_agent`, or the safe
 *      fallback `"dante"` when a legacy team has `lead_agent = NULL`
 *      (Migration 5 adds the column nullable).
 *   3. No row matches in either table → `undefined`. Callers MUST NOT invent
 *      a fallback: an unknown session (e.g. a sub-agent or an isolated
 *      reviewer session) must be delivered verbatim, not resequenced into an
 *      arbitrary persona.
 *
 * Never throws — a missing/invalid `sessionID` yields `undefined`.
 */
export function resolveAgentForSession(db: Database, sessionID: string): string | undefined {
  if (!sessionID) return undefined

  const member = db.query("SELECT agent FROM team_member WHERE session_id = ?")
    .get(sessionID) as { agent: string | null } | null
  if (member?.agent) return member.agent

  const lead = db.query("SELECT lead_agent FROM team WHERE lead_session_id = ?")
    .get(sessionID) as { lead_agent: string | null } | null
  if (lead) return lead.lead_agent ?? "dante"

  return undefined
}
