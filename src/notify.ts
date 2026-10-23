import type { Database } from "./db"
import type { PluginClient } from "./types"
import type { EnsembleConfig } from "./config"
import { formatModelSelector, parseModelSelector, resolveFallbackChainForAgent } from "./config"
import { sendMessage } from "./messaging"
import { isModelNotFoundError } from "./model-catalog"
import { formatParsedModelSelector, resolveSessionBoundModel, type ParsedModel } from "./member-model"
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
   * model-aware: when the FIRST attempt is rejected (e.g. HTTP 429 on the
   * lead's own model), the retry ladder walks
   * `resolveFallbackChainForAgent(config, leadAgent)` rung by rung so a
   * rate-limited primary never strands the message at delivered=0 (the
   * 2026-10 incident: a modelless wake landed on the rate-limited gemini
   * primary and the system message was never delivered). The chain is the
   * REACTIVE fallback — rung 0 is always the model the session is BOUND to
   * (resolved via session.get, TICKET-RELEASE-15), never a chain entry.
   */
  config?: Required<EnsembleConfig>
  /**
   * Optional EXPLICIT model selector for the FIRST wake attempt. TICKET-
   * RELEASE-15: when omitted, the wake resolves the model the lead session is
   * CURRENTLY BOUND to (`client.session.get`) and sends it explicitly — the
   * OpenCode server would otherwise fall back to the agent `.md` model, not
   * to the session's bound model. Never carries the "#default" sentinel —
   * parseModelSelector normalizes it away.
   */
  primaryModel?: string
  /**
   * TICKET-HARNESS-34 (A1) — punches through `silentLead`.
   *
   * Under the economic default (`silentLead: true`) the SQLite row written by
   * notifyLead IS the delivery channel: the lead drains it through the
   * system-prompt transform on its next turn. The proactive promptAsync wake
   * is therefore reserved for events the lead CANNOT recover from passively:
   *   - unrecoverable failures (watchdog timeout + session.abort, spawn
   *     rollback, a genuine non-abort session error);
   *   - explicit emergencies (decision_lead, board closure) — those paths do
   *     not go through notifyLead's silent gate, but set it for completeness.
   * Non-fatal system noise (fast-idle, stall, chatty) MUST NOT set it: the row
   * is persisted and the wake stays suppressed to protect the Silent Lead.
   */
  forceWake?: boolean
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
 * TICKET-RELEASE-10 (F2) — memory of wake ladders that hit a DETERMINISTIC
 * model-resolution failure (`ProviderModelNotFound` / "Model not found").
 *
 * A rejected `promptAsync` already steps the ladder inside ONE call, but the
 * server can accept the wake and fail the turn afterwards; the next system
 * wake would then start again at the dead native model. Remembering the rung
 * that failed lets every SUBSEQUENT wake start on the next usable rung instead
 * of replaying the same broken model — the same forward-walk principle the
 * retry failover applies to members.
 *
 * Expiration uses the rate-limit cooldown window (10 min) imported as a plain
 * number to avoid a notify ⇄ hooks import cycle; entries are process-wide like
 * the failover cooldown maps. Exported so deterministic suites can inspect /
 * clear it without sleeping.
 */
export const MODEL_NOT_FOUND_WAKE_TTL_MS = 10 * 60 * 1000

export interface ModelNotFoundWakeRecord {
  /** Timestamp of the failed attempt (clock for the TTL). */
  at: number
  /** Rung that failed ("session-native" when the model key was omitted). */
  failedRung: string
  /** Absolute index of the first rung worth trying on the next wake. */
  nextIndex: number
}

/** Keyed by sessionID. @see ModelNotFoundWakeRecord */
export const modelNotFoundWakeSessions = new Map<string, ModelNotFoundWakeRecord>()

/**
 * True when a rejected wake attempt is a deterministic model-resolution
 * failure. Delegates to `isModelNotFoundError` (src/model-catalog.ts) probing
 * both the error object and its message, so the contract holds whichever
 * shape the helper prefers. Never throws.
 */
export function isModelNotFoundWakeError(err: unknown): boolean {
  if (isModelNotFoundError(err)) return true
  const message = err instanceof Error ? err.message : typeof err === "string" ? err : ""
  return message.length > 0 && isModelNotFoundError(message)
}

/**
 * Fire a MODEL-AWARE wake (HARNESS-15 B / F1 / TICKET-32B / TICKET-RELEASE-15)
 * — the shared step-down ladder behind every lead wake that carries a config:
 *
 *   - `agent` (when known) goes EXPLICITLY on every attempt — omitting it
 *     lets the server rebind the session to its default agent (persona
 *     sequester);
 *   - rung 0 is the MODEL THE SESSION IS CURRENTLY BOUND TO. TICKET-RELEASE-15
 *     corrected the old premise: omitting the `model` key does NOT preserve
 *     the bound model — the server falls back to the AGENT DEFINITION
 *     (`agent/<persona>.md`). The incident of 23/10 woke lead `nora`
 *     (session bound to `opencode-go/deepseek-v4.1-flash`) on
 *     `google/antigravity-gemini-3.8-flash#medium` (what `agent/nora.md`
 *     declares) and the exhausted Antigravity pool swallowed the turn. So the
 *     bound model is RESOLVED via `client.session.get` and sent EXPLICITLY
 *     (variant "default" normalized away, §5.1). An explicit `primaryModel`
 *     from the caller still wins; a caller that already resolved the model
 *     hands it over as `boundModel` (`null` = resolution attempted, nothing
 *     usable) and the wake is dispatched SYNCHRONOUSLY. Only a cold caller
 *     (no primaryModel, no boundModel) pays the session.get round-trip, and
 *     the wake is then dispatched right after it (fire-and-forget preserved);
 *   - resolution failure degrades to a model-less attempt with an explicit
 *     `wake:model-resolution-failed` log — never silently;
 *   - rungs 1..n are each distinct entry of
 *     `resolveFallbackChainForAgent(config, agent)` (agent optional: without
 *     one the resolver returns the global chain), walked ONLY after a
 *     rejected attempt (e.g. rate-limit 429) — the reactive fallback that
 *     still beats a stranded `delivered=0` message. `chain[0]` is NEVER used
 *     as rung 0 (the premature-downgrade regression of HARNESS-73);
 *   - each rejected attempt steps to the next rung; the ladder exhausted →
 *     log only. The caller must persist any message BEFORE calling: the wake
 *     is fire-and-forget (never awaited, per the promptAsync invariant).
 *
 * Shared by notifyLead (system messages), the watchdog/spawn wake wrappers
 * (indirect, via notifyLead), decision_lead and the board-close wake in
 * team-tasks-complete.
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
    /**
     * Explicit first-attempt selector. PRESENT → respected as rung 0 and
     * dispatched synchronously; ABSENT → the session's bound model is resolved
     * (see `boundModel`).
     */
    primaryModel?: string
    /**
     * TICKET-RELEASE-15 — a bound model the CALLER already resolved through
     * `resolveSessionBoundModel` (e.g. the board-close wake, which is async).
     * `null` means "resolution was attempted and the session exposes no usable
     * model": rung 0 then goes out WITHOUT a model key, still synchronously.
     * When omitted, this function resolves it itself before dispatching.
     */
    boundModel?: ParsedModel | null
    /** Synthetic system entry (default: true). */
    synthetic?: boolean
  },
): void {
  const { sessionID, text, logTag, agent, config, primaryModel, boundModel, synthetic = true } = params

  /**
   * Build the ladder from an already-known rung 0 and fire attempt(startIndex).
   * Kept as a closure (not a separate async step) so a caller-provided model
   * wakes the lead in the SAME tick — the deterministic suites assert the
   * transport payload right after the calling tool returns.
   */
  const dispatch = (primary: string | undefined): void => {
    // Rung 0 = the effective primary (explicit caller selector or the resolved
    // bound model). Rungs 1..n = each DISTINCT chain entry, deduped by
    // formatted selector, pushed ONLY for the reactive fallback walk.
    // "#default" never survives parse/format (config.ts §5.1).
    const ladder: Array<string | undefined> = [primary || undefined]
    const seen = new Set<string>(primary ? [primary] : [])
    if (config) {
      for (const entry of resolveFallbackChainForAgent(config, agent)) {
        const selector = formatModelSelector(entry)
        if (selector && !seen.has(selector)) {
          seen.add(selector)
          ladder.push(selector)
        }
      }
    }

    // TICKET-RELEASE-10 (F2): skip rungs already proven dead by a deterministic
    // model-not-found within the TTL. The ladder still starts at rung 0 on a
    // fresh session / after expiry (see modelNotFoundWakeSessions).
    let startIndex = 0
    const remembered = modelNotFoundWakeSessions.get(sessionID)
    if (remembered) {
      if (Date.now() - remembered.at >= MODEL_NOT_FOUND_WAKE_TTL_MS) {
        modelNotFoundWakeSessions.delete(sessionID)
      } else if (remembered.failedRung !== "session-native" && primary && remembered.failedRung !== primary) {
        // TICKET-RELEASE-15: the recorded rung was a CONCRETE bound model and
        // the session now reports a DIFFERENT one (it was rebound after a
        // failover). nextIndex indexes the OLD ladder — drop it instead of
        // skipping the freshly bound model.
        modelNotFoundWakeSessions.delete(sessionID)
      } else if (remembered.nextIndex > 0 && ladder.length > 0) {
        startIndex = Math.min(remembered.nextIndex, ladder.length - 1)
        log(`${logTag}:skip-dead-rungs session=${sessionID} failed=${remembered.failedRung} start=${startIndex}`)
      }
    }

    const attempt = (index: number): void => {
      const selector = ladder[index]
      // Log label only — a model-less rung is never parsed as a selector.
      const rung = selector ?? "session-native"
      const parsed = selector ? parseModelSelector(selector) : undefined
      client.session.promptAsync({
        sessionID,
        parts: [{ type: "text", text }],
        ...(agent ? { agent } : {}),
        ...(parsed ? { model: parsed } : {}),
        ...(synthetic ? { synthetic: true } : {}),
      }).then(() => {
        log(`${logTag}:delivered session=${sessionID} agent=${agent} model=${rung}`)
      }).catch((err) => {
        const errMsg = err instanceof Error ? err.message : String(err)
        // TICKET-RELEASE-10 (F2): a deterministic model-resolution failure is
        // NOT a transient transport error — remember the dead rung so the next
        // wake does not replay it, and step forward immediately.
        const deterministic = isModelNotFoundWakeError(err)
        if (deterministic) {
          modelNotFoundWakeSessions.set(sessionID, {
            at: Date.now(),
            failedRung: rung,
            nextIndex: index + 1 < ladder.length ? index + 1 : ladder.length,
          })
        }
        const next = index + 1 < ladder.length ? ladder[index + 1] : undefined
        if (next) {
          log(`${logTag}:retry session=${sessionID} from=${rung} to=${next} reason=${deterministic ? "model-not-found" : "transport"} err=${errMsg}`)
          attempt(index + 1)
        } else {
          log(`${logTag}:${deterministic ? "model-not-found:exhausted" : "failed"} session=${sessionID} model=${rung} err=${errMsg}`)
        }
      })
    }
    attempt(startIndex)
  }

  // An explicit caller selector wins, and a pre-resolved boundModel (including
  // the `null` sentinel) dispatches in the SAME tick. Only a cold caller needs
  // the async round-trip below.
  if (primaryModel || boundModel !== undefined) {
    const primary = primaryModel || (boundModel ? formatParsedModelSelector(boundModel) : undefined)
    dispatch(primary)
    return
  }

  // Cold path (TICKET-RELEASE-15): resolve the session's BOUND model before the
  // first attempt — omitting `model` makes the server use the agent `.md`.
  // Fire-and-forget is preserved: the outer signature stays `void`.
  void resolveSessionBoundModel(client, sessionID).then((model) => {
    dispatch(model ? formatParsedModelSelector(model) : undefined)
  }).catch((err) => {
    log(`${logTag}:wake:model-resolution-failed session=${sessionID} err=${err instanceof Error ? err.message : String(err)}`)
    dispatch(undefined)
  })
}

/**
 * Persist a system-generated message to the lead AND actively wake the lead
 * so the message is delivered on the lead's next turn.
 *
 * This is the delivery path for system events (teammate errors, timeouts,
 * stalls, spawn failures). Unlike the passive wake-lead path in the event
 * hook, this wakes the lead even when teammates are still busy — an
 * errored/aborted teammate is precisely the case where the "all teammates
 * done" gate would otherwise suppress the wake and strand the message with
 * delivered=0.
 *
 * TICKET-HARNESS-34 (A1) — SILENT-LEAD COHERENCE: the message row is ALWAYS
 * persisted, but the proactive wake obeys `silentLead` (default: true). Only
 * `forceWake: true` (unrecoverable failures) or `silentLead: false` (legacy)
 * reach promptModelAwareWake; every other system event is delivered passively
 * through the lead's system prompt.
 *
 * HARNESS-15 B / TICKET-32B / TICKET-RELEASE-15 — MODEL-AWARE WAKE: when wake
 * options carry the config (and an agent resolves — options.agent, else
 * team.lead_agent), the wake becomes a RETRY LADDER delegated to
 * promptModelAwareWake: the model the lead session is CURRENTLY BOUND to is
 * resolved via `client.session.get` and sent EXPLICITLY first (or the explicit
 * options.primaryModel, when given) — omitting `model` would make the server
 * use the agent `.md` model — then each distinct entry of the agent's fallback
 * chain, in order. Each failed attempt (rejected promptAsync) steps to the
 * next rung; the message row is persisted up front so a fully failed ladder
 * still leaves the passive backstop / recovery paths available.
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

  // TICKET-HARNESS-34 (A1) — silentLead coherence.
  //
  // `silentLead: true` is the product default (src/config.ts DEFAULT_CONFIG).
  // In that mode the SQLite row written above IS the delivery channel: the
  // lead's next turn drains it via the system-prompt transform. The proactive
  // promptAsync wake is a token-expensive interruption, so it is emitted ONLY
  // when one of these holds:
  //   - `forceWake: true` — unrecoverable failure (watchdog timeout/abort,
  //     spawn rollback, genuine non-abort session error);
  //   - the threaded config has `silentLead: false` — legacy room that asked
  //     for aggressive wakes;
  //   - NO config is threaded at all — the pre-existing RETROCOMPATIBLE
  //     contract: a caller without config has no silentLead setting to honour
  //     and degrades to the legacy wake (watchdog-only-in-memory/test
  //     constructions). Production call sites ALWAYS thread config.
  // Non-fatal system noise (fast-idle, stall, chatty) is persisted silently
  // when a config is present with the default `silentLead: true`.
  const silentLead = options?.config !== undefined && options.config.silentLead !== false
  if (silentLead && !options?.forceWake) {
    log(`notifyLead:silent team=${teamId} wake=suppressed`)
    return id
  }

  const ctx = resolveLeadWakeContext(db, teamId)
  if (!ctx) return id

  // Lead agent: explicit option first, then the plugin's stored lead agent
  // (team.lead_agent). Absent → wake without the agent param (legacy shape).
  const leadAgent = options?.agent ?? ctx.leadAgent

  // options.config (and options.primaryModel) are threaded VERBATIM into the
  // shared ladder — every call site MUST hand its config through here
  // (hooks.ts, index.ts fast-idle, watchdog.ts wrapper, team-spawn rollback)
  // or the wake degrades to a single native attempt with no reactive
  // fallback on rate-limit (TICKET-32B invariant, locked by the parity
  // markers in tests/test_model_aware_wakes.mjs).
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
