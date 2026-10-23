import type { Database } from "./db"
import type { PluginClient } from "./types"
import { parseModelSelector, VARIANT_ABSENT_SENTINEL, type ParsedModelSelector } from "./config"
import { log } from "./log"

/** A parsed provider/model pair, as accepted by session.promptAsync. */
export type ParsedModel = ParsedModelSelector

/**
 * Parse a "provider/model" string into { providerID, modelID } for the SDK.
 * Returns undefined if the string is not in "provider/model" form (empty
 * provider or empty model). The model portion may itself contain slashes.
 * An optional "#variant" suffix (OpenCode selector format, e.g.
 * "google/antigravity-gemini-3.8-flash#low") is stripped here — variants
 * travel via promptAsync's model.variant, never inside modelID.
 *
 * Delegates to parseModelSelector to ensure server sentinels like `#default`
 * are normalized away into absence of variant.
 */
export function parseModelId(model: string): ParsedModel | undefined {
  return parseModelSelector(model)
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
 * TICKET-RELEASE-15 — format a parsed bound model back into OpenCode selector
 * form (`provider/model[#variant]`). The `#default` absence sentinel is NEVER
 * emitted (config.ts §5.1 / VARIANT_ABSENT_SENTINEL): a bound model with no
 * real variant formats exactly like `provider/model`.
 */
export function formatParsedModelSelector(model: ParsedModel): string {
  return model.variant ? `${model.providerID}/${model.modelID}#${model.variant}` : `${model.providerID}/${model.modelID}`
}

/** Structural shape of the `model` field carried by a `session.get()` payload. */
interface SessionModelRecord {
  providerID?: unknown
  id?: unknown
  modelID?: unknown
  variant?: unknown
}

/** Structural shape of the session fields read here (V2 nests under `data`). */
interface SessionModelPayload {
  model?: unknown
  data?: { model?: unknown; data?: { model?: unknown } }
}

/**
 * Parse the `model` record of a `session.get()` payload into a ParsedModel.
 * Accepts both the V2 field name (`id`) and the older `modelID`, and requires
 * a non-empty provider + model. Returns undefined for anything malformed.
 *
 * `variant: "default"` is the server's ABSENCE marker (config.ts §5.1): it is
 * normalized to `undefined` so the selector never round-trips as `#default`
 * and the promptAsync payload carries no bogus thinking level.
 */
export function extractSessionBoundModel(payload: unknown): ParsedModel | undefined {
  if (!payload || typeof payload !== "object") return undefined
  const root = payload as SessionModelPayload
  const candidates: unknown[] = [root.model, root.data?.model, root.data?.data?.model]
  for (const candidate of candidates) {
    if (!candidate || typeof candidate !== "object") continue
    const record = candidate as SessionModelRecord
    const providerID = typeof record.providerID === "string" ? record.providerID.trim() : ""
    const rawModelID = typeof record.id === "string" && record.id.trim().length > 0
      ? record.id.trim()
      : typeof record.modelID === "string" ? record.modelID.trim() : ""
    if (!providerID || !rawModelID) continue
    const rawVariant = typeof record.variant === "string" ? record.variant.trim() : ""
    const variant = rawVariant && rawVariant !== VARIANT_ABSENT_SENTINEL ? rawVariant : undefined
    return variant ? { providerID, modelID: rawModelID, variant } : { providerID, modelID: rawModelID }
  }
  return undefined
}

/**
 * TICKET-RELEASE-15 — resolve the model a session is CURRENTLY BOUND to via
 * `client.session.get({sessionID})` → `data.model`.
 *
 * WHY THIS EXISTS (incident 23/10, session ses_e95bdc982ffe4Kl5ZgFPrkWxFe):
 * omitting the `model` key from `session.promptAsync` does NOT preserve the
 * session's bound model. The OpenCode server resolves it from the AGENT
 * DEFINITION (`agent/<persona>.md`) — the lead `nora` had
 * `session.model = opencode-go/deepseek-v4.1-flash` but a modelless wake ran
 * `google/antigravity-gemini-3.8-flash#medium` (exactly what `agent/nora.md`
 * declares) and died on an exhausted Antigravity pool, leaving the lead mute.
 * The pre-TICKET-RELEASE-15 premise "modelless = native model" was FALSE.
 *
 * Never throws. A missing session.get, a failed round-trip or a payload with
 * no usable model all yield `undefined` AFTER logging
 * `wake:model-resolution-failed` — the caller then degrades to a model-less
 * wake explicitly, never silently.
 */
export async function resolveSessionBoundModel(
  client: PluginClient,
  sessionID: string,
): Promise<ParsedModel | undefined> {
  if (!sessionID) return undefined
  try {
    if (typeof client?.session?.get !== "function") {
      log(`wake:model-resolution-failed session=${sessionID} reason=no-session-get`)
      return undefined
    }
    const res = await client.session.get({ sessionID })
    const model = extractSessionBoundModel(res)
    if (!model) {
      log(`wake:model-resolution-failed session=${sessionID} reason=no-bound-model`)
      return undefined
    }
    return model
  } catch (err) {
    log(`wake:model-resolution-failed session=${sessionID} reason=session-get-error err=${err instanceof Error ? err.message : String(err)}`)
    return undefined
  }
}

/**
 * Resolve the agent (persona) a session must run as, straight from the
 * canonical SQLite tables. Consumed by the client choke point
 * (wrapThrowingClient) to re-inject the `agent` field on
 * `session.promptAsync` calls whose caller omitted it.
 *
 * Resolution order (deterministic, fail-safe):
 *   1. `team_member.session_id = ?` → the member's own `agent` (when non-empty).
 *   2. `team.lead_session_id = ?` → the team's `lead_agent` (when non-empty).
 *   3. No row matches in either table → `undefined`. Callers MUST NOT invent
 *      a fallback: an unknown session (e.g. a sub-agent or an isolated
 *      reviewer session) must be delivered verbatim, not resequenced into an
 *      arbitrary persona.
 *
 * TICKET-HARNESS-73 / TICKET-RELEASE-09 — step 2 NO LONGER falls back to
 * the hard-coded `"dante"`. `team.lead_agent` is nullable (Migration 5) and
 * was NEVER written by `team_create`, so the old `lead_agent ?? "dante"`
 * answered "dante" for EVERY lead — and because the transport choke point
 * (`src/client.ts` → `throwingPromptAsync`) re-injects `agent` whenever the
 * caller omitted it, that invented value SILENTLY REBOUND the lead session
 * onto Dante's persona (Iris, Nora, Selene… all became Dante).
 *
 * A NULL/empty `lead_agent` now yields `undefined`: the session keeps its
 * OWN binding and no persona is sequestered. The truthful value is
 * persisted at creation time (`executeTeamCreate`) and legacy rows are
 * self-healed on demand (`ensureTeamLeadAgent`, src/lead-agent.ts).
 *
 * Never throws — a missing/invalid `sessionID` yields `undefined`.
 */
export function resolveAgentForSession(db: Database, sessionID: string): string | undefined {
  if (!sessionID) return undefined

  const member = db.query(
    `SELECT tm.agent AS agent
     FROM team_member tm
     JOIN team t ON tm.team_id = t.id
     WHERE tm.session_id = ? AND t.status = 'active'`
  ).get(sessionID) as { agent: string | null } | null
  if (member?.agent) return member.agent

  const lead = db.query("SELECT lead_agent FROM team WHERE lead_session_id = ? AND status = 'active'")
    .get(sessionID) as { lead_agent: string | null } | null
  // Unknown lead agent → undefined (preserve the session's native binding).
  // NEVER invent a persona here.
  if (lead) return lead.lead_agent || undefined

  return undefined
}
