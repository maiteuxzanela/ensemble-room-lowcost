import type { Database } from "./db"
import type { PluginClient } from "./types"
import type { EnsembleConfig } from "./config"
import { formatModelSelector, parseModelSelector, resolveFallbackChainForAgent } from "./config"
import { sendMessage } from "./messaging"
import { log } from "./log"

type TeamEventType = "spawn" | "message" | "completed" | "error" | "shutdown"

const TOAST_CONFIG: Record<TeamEventType, { variant: "info" | "success" | "warning" | "error"; duration: number }> = {
  spawn: { variant: "success", duration: 3000 },
  message: { variant: "info", duration: 3000 },
  completed: { variant: "info", duration: 4000 },
  error: { variant: "error", duration: 5000 },
  shutdown: { variant: "info", duration: 3000 },
}

function formatMessage(type: TeamEventType, data: Record<string, string>): string {
  switch (type) {
    case "spawn": return `Teammate ${data.memberName} spawned (${data.agent})`
    case "message": return `Message from ${data.from}`
    case "completed": return `${data.memberName} finished work`
    case "error": return `${data.memberName} encountered an error`
    case "shutdown": return `${data.memberName} shut down`
  }
}

/**
 * Fire a toast notification for a team event.
 * Silently swallows errors — TUI may not be available.
 */
export async function notifyTeamEvent(
  client: PluginClient,
  type: TeamEventType,
  data: Record<string, string>,
): Promise<void> {
  const config = TOAST_CONFIG[type]
  try {
    await client.tui.showToast({
      title: "Team",
      message: formatMessage(type, data),
      variant: config.variant,
      duration: config.duration,
    })
  } catch {
    // TUI may not be available — silently ignore
  }
}

/**
 * Fire a toast showing which teammates are still working.
 * Called on every session.status transition so the user sees live progress.
 * Does nothing if the team has no members.
 */
export async function notifyWorkingProgress(
  client: PluginClient,
  db: Database,
  teamId: string,
): Promise<void> {
  const members = db.query(
    "SELECT name, status FROM team_member WHERE team_id = ? ORDER BY time_created ASC"
  ).all(teamId) as Array<{ name: string; status: string }>

  if (members.length === 0) return

  const busy = members.filter(m => m.status === "busy")

  try {
    if (busy.length === 0) {
      await client.tui.showToast({
        title: "Team",
        message: "All teammates finished",
        variant: "success",
        duration: 4000,
      })
    } else {
      const names = busy.map(m => m.name).join(", ")
      await client.tui.showToast({
        title: "Team",
        message: `Working: ${names} (${busy.length}/${members.length})`,
        variant: "info",
        duration: 5000,
      })
    }
  } catch {
    // TUI may not be available — silently ignore
  }
}

/**
 * Optional, RETROCOMPATIBLE wake options for notifyLead (HARNESS-15 B).
 * Callers that omit them keep the legacy wake (no agent, no model) — every
 * pre-existing call site stays valid.
 */
export interface NotifyLeadWakeOptions {
  /**
   * The lead's agent (e.g. "dante"). Passed EXPLICITLY to promptAsync so the
   * OpenCode server never rebinds the session to its default agent (persona
   * sequester — Diana achado 2). When omitted, notifyLead falls back to the
   * plugin's known lead agent (`team.lead_agent`, Migration 5).
   */
  agent?: string
  /**
   * Plugin config. Together with the resolved lead agent it turns the wake
   * model-aware: the model ladder is built from
   * `resolveFallbackChainForAgent(config, leadAgent)` so a rate-limited
   * primary never strands the message at delivered=0 (the 2026-10 incident:
   * a modelless wake landed on the rate-limited gemini primary and the
   * system message was never delivered).
   */
  config?: Required<EnsembleConfig>
  /**
   * Optional PRIMARY model selector for the FIRST wake attempt (e.g. the
   * lead's currently bound model). Defaults to the head of the resolved
   * fallback chain. Never carries the "#default" sentinel — parseModelSelector
   * normalizes it away.
   */
  primaryModel?: string
}

/** Lead wake context resolved from a team row: session id + known agent. */
export interface LeadWakeContext {
  leadSessionId: string
  /** `team.lead_agent` (Migration 5) — the plugin's known lead agent, if recorded. */
  leadAgent?: string
}

/**
 * Resolve WHERE to wake a team's lead: the canonical `lead_session_id` plus
 * the plugin's recorded lead agent (`team.lead_agent`, Migration 5 — "agente
 * de lead conhecido do plugin"). Returns undefined for a missing team or a
 * lead-less team. Read-only: never writes the team row.
 */
export function resolveLeadWakeContext(db: Database, teamId: string): LeadWakeContext | undefined {
  const team = db.query("SELECT lead_session_id, lead_agent FROM team WHERE id = ?")
    .get(teamId) as { lead_session_id: string; lead_agent: string | null } | null
  if (!team?.lead_session_id) return undefined
  return { leadSessionId: team.lead_session_id, leadAgent: team.lead_agent || undefined }
}

/**
 * Fire a MODEL-AWARE wake (HARNESS-15 B / F1) — the shared step-down ladder
 * behind every lead wake that carries a config:
 *
 *   - `agent` (when known) goes EXPLICITLY on every attempt — omitting it
 *     lets the server rebind the session to its default agent (persona
 *     sequester);
 *   - the model LADDER is `primaryModel?` first, then each distinct entry of
 *     `resolveFallbackChainForAgent(config, agent)` (agent optional: without
 *     one the resolver returns the global chain, which still beats a
 *     modelless wake under rate-limit);
 *   - each rejected attempt steps to the next rung; the ladder exhausted →
 *     log only. The caller must persist any message BEFORE calling: the wake
 *     is fire-and-forget (never awaited, per the promptAsync invariant).
 *
 * Shared by notifyLead (system messages) and the board-complete wake in
 * team-tasks-complete — the ONLY lead wake under silentLead:true.
 */
export function promptModelAwareWake(
  client: PluginClient,
  params: {
    sessionID: string
    text: string
    /** Log tag prefix, e.g. `notifyLead:wake team=t1`. */
    logTag: string
    /** Lead's agent — explicit when known (persona-sequester defence). */
    agent?: string
    /** Enables the model ladder via resolveFallbackChainForAgent(config, agent). */
    config?: Required<EnsembleConfig>
    /** First-attempt model selector; defaults to the chain head. */
    primaryModel?: string
    /** Synthetic system entry (default: true). */
    synthetic?: boolean
  },
): void {
  const { sessionID, text, logTag, agent, config, primaryModel, synthetic = true } = params

  // Ladder: optional primary first, then each DISTINCT chain entry, deduped
  // by formatted selector. "#default" never survives parse/format (config.ts).
  const ladder: string[] = []
  const seen = new Set<string>()
  const pushSelector = (selector: string): void => {
    if (selector && !seen.has(selector)) {
      seen.add(selector)
      ladder.push(selector)
    }
  }
  if (primaryModel) pushSelector(primaryModel)
  if (config) {
    for (const entry of resolveFallbackChainForAgent(config, agent)) {
      pushSelector(formatModelSelector(entry))
    }
  }

  const attempt = (index: number): void => {
    const selector = ladder[index]
    const parsed = selector ? parseModelSelector(selector) : undefined
    client.session.promptAsync({
      sessionID,
      parts: [{ type: "text", text }],
      ...(agent ? { agent } : {}),
      ...(parsed ? { model: parsed } : {}),
      ...(synthetic ? { synthetic: true } : {}),
    }).then(() => {
      if (selector) log(`${logTag}:delivered session=${sessionID} agent=${agent} model=${selector}`)
    }).catch((err) => {
      const errMsg = err instanceof Error ? err.message : String(err)
      const next = ladder[index + 1]
      if (next) {
        log(`${logTag}:retry session=${sessionID} from=${selector ?? "session-default"} to=${next} err=${errMsg}`)
        attempt(index + 1)
      } else {
        log(`${logTag}:failed session=${sessionID} model=${selector ?? "session-default"} err=${errMsg}`)
      }
    })
  }
  attempt(0)
}

/**
 * Persist a system-generated message to the lead AND actively wake the lead
 * so the message is delivered on the lead's next turn.
 *
 * This is the delivery path for system events (teammate errors, timeouts,
 * stalls, spawn failures). Unlike the passive wake-lead path in the event
 * hook, this ALWAYS fires a promptAsync regardless of whether teammates are
 * still busy — an errored/aborted teammate is precisely the case where the
 * "all teammates done" gate would otherwise suppress the wake and strand the
 * message in the DB with delivered=0.
 *
 * HARNESS-15 B — MODEL-AWARE WAKE: when wake options carry the config (and
 * an agent resolves — options.agent, else team.lead_agent), the wake becomes
 * a RETRY LADDER delegated to promptModelAwareWake: the primary model first,
 * then each distinct entry of the agent's fallback chain, in order. Each
 * failed attempt (rejected promptAsync) steps to the next rung; the message
 * row is persisted up front so a fully failed ladder still leaves the passive
 * backstop / recovery paths available.
 *
 * The message is persisted first; the promptAsync wake is fire-and-forget
 * (never awaited, per the plugin's promptAsync invariant). Returns the
 * persisted message id.
 */
export function notifyLead(
  client: PluginClient,
  db: Database,
  teamId: string,
  content: string,
  options?: NotifyLeadWakeOptions,
): string {
  const id = sendMessage(db, { teamId, from: "system", to: "lead", content })

  const ctx = resolveLeadWakeContext(db, teamId)
  if (!ctx) return id

  // Lead agent: explicit option first, then the plugin's stored lead agent
  // (team.lead_agent). Absent → wake without the agent param (legacy shape).
  const leadAgent = options?.agent ?? ctx.leadAgent

  promptModelAwareWake(client, {
    sessionID: ctx.leadSessionId,
    text: "[System: New team message from system]",
    logTag: `notifyLead:wake team=${teamId}`,
    agent: leadAgent,
    config: options?.config,
    primaryModel: options?.primaryModel,
  })

  return id
}
