import type { Database } from "./db"
import type { PluginClient } from "./types"
import { log } from "./log"

/**
 * Canonical resolution + persistence of the LEAD's agent (persona).
 *
 * TICKET-HARNESS-73 / TICKET-RELEASE-09 — the lead's persona must survive
 * end-to-end, from the moment the team is created to every wake the plugin
 * fires on the lead's session.
 *
 * The failure this module exists to prevent:
 *
 *   1. `team_create` never wrote the `lead_agent` column (added by
 *      Migration 5, nullable) — so EVERY team created by the plugin had
 *      `lead_agent = NULL`.
 *   2. The transport choke point (`src/client.ts` → `throwingPromptAsync`)
 *      re-injects an `agent` on `session.promptAsync` whenever the caller
 *      omitted it, resolving it via `resolveAgentForSession`
 *      (`src/member-model.ts`).
 *   3. `resolveAgentForSession` used to answer `lead_agent ?? "dante"` — i.e.
 *      a NULL `lead_agent` produced a HARD-CODED "dante", which SILENTLY
 *      REBOUND the lead session onto Dante's persona (Iris, Nora, Selene…
 *      all became Dante) on the very next prompt.
 *
 * The chain is now: persist the real agent at creation time
 * (`executeTeamCreate`), self-heal legacy rows on demand
 * (`ensureTeamLeadAgent`), and NEVER invent a persona when the truth is
 * unknown (`resolveAgentForSession` returns `undefined`).
 */

/** Structural shape of the fields read off a `session.get()` payload. */
interface SessionAgentPayload {
  agent?: unknown
  data?: { agent?: unknown; data?: { agent?: unknown } }
}

/**
 * Extract the agent (persona) name from a `session.get()` payload.
 *
 * The V2 SDK nests the session under `data`; older/other transports surface
 * it at the top level. Both are accepted, plus the doubly-nested variant.
 * Returns `undefined` when the payload carries no usable agent — NEVER a
 * default persona: an unknown agent must stay unknown so the caller can
 * preserve the session's own binding instead of sequestering it.
 */
export function extractSessionAgent(payload: unknown): string | undefined {
  if (!payload || typeof payload !== "object") return undefined
  const root = payload as SessionAgentPayload
  const candidates: unknown[] = [
    root.agent,
    root.data?.agent,
    root.data?.data?.agent,
  ]
  for (const candidate of candidates) {
    if (typeof candidate === "string" && candidate.trim().length > 0) return candidate.trim()
  }
  return undefined
}

/**
 * Read the agent (persona) bound to a session via the SDK.
 *
 * Never throws — a failed/timed-out session lookup yields `undefined` (the
 * caller then preserves the session's native binding instead of inventing a
 * persona). Safe to call from delivery paths.
 */
export async function resolveSessionAgent(
  client: PluginClient,
  sessionID: string,
): Promise<string | undefined> {
  if (!sessionID) return undefined
  try {
    if (typeof client?.session?.get !== "function") return undefined
    const res = await client.session.get({ sessionID })
    return extractSessionAgent(res)
  } catch (err) {
    log(`lead-agent:session-get:failed session=${sessionID} err=${err instanceof Error ? err.message : String(err)}`)
    return undefined
  }
}

/**
 * Self-heal a LEGACY team whose `lead_agent` is still NULL (created before
 * TICKET-HARNESS-73 persisted it) by asking the SDK which agent the lead
 * session is bound to and persisting that answer atomically.
 *
 * The UPDATE is CONDITIONAL (`lead_agent IS NULL OR lead_agent = ''`), so
 * concurrent callers cannot clobber each other and an already-recorded agent
 * is never overwritten. Returns the effective agent after the attempt
 * (`undefined` when the truth could not be established).
 *
 * Never throws — the self-heal is opportunistic: a failure must degrade to
 * "agent unknown" (preserve native binding), never to "invent a persona".
 */
export async function ensureTeamLeadAgent(
  db: Database,
  client: PluginClient,
  teamId: string,
): Promise<string | undefined> {
  if (!teamId) return undefined
  let row: { lead_agent: string | null; lead_session_id: string | null } | null = null
  try {
    row = db.query("SELECT lead_agent, lead_session_id FROM team WHERE id = ?")
      .get(teamId) as { lead_agent: string | null; lead_session_id: string | null } | null
  } catch (err) {
    log(`lead-agent:read:failed team=${teamId} err=${err instanceof Error ? err.message : String(err)}`)
    return undefined
  }
  if (!row) return undefined
  // Already known — nothing to heal.
  if (row.lead_agent && row.lead_agent.trim().length > 0) return row.lead_agent
  if (!row.lead_session_id) return undefined

  const agent = await resolveSessionAgent(client, row.lead_session_id)
  if (!agent) return undefined

  try {
    db.run(
      "UPDATE team SET lead_agent = ?, time_updated = ? WHERE id = ? AND (lead_agent IS NULL OR lead_agent = '')",
      [agent, Date.now(), teamId],
    )
  } catch (err) {
    log(`lead-agent:update:failed team=${teamId} agent=${agent} err=${err instanceof Error ? err.message : String(err)}`)
    return undefined
  }
  log(`lead-agent:healed team=${teamId} agent=${agent} session=${row.lead_session_id}`)
  return agent
}
