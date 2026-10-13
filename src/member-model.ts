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
