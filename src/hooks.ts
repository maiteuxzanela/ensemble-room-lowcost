import type { Database } from "./db"
import type { MemberRegistry, DescendantTracker } from "./state"
import type { PluginClient } from "./types"
import type { EnsembleConfig } from "./config"
import { formatModelSelector, parseModelSelector, resolveFallbackChainForAgent, selectNextFallback, type ModelFallbackRef } from "./config"
import { catalogKey, describeModelNotFound, extractModelSelectorFromError, isModelNotFoundError } from "./model-catalog"
import { abortInflight } from "./v2-session"
import { notifyLead } from "./notify"
import { sendMessage } from "./messaging"
import { releaseMemberTasks } from "./tasks"
import { deliverDeferredStandbyWakes } from "./recovery"
import { findTeamBySession } from "./types"
import { isQAMember } from "./qa-role"
import { consumeIntentionalAbort } from "./standby-guard"
import { log } from "./log"

const TEAM_TOOL_PREFIX = "team_"

/**
 * Retry-specific payload carried by a `session.status` event when
 * `status === "retry"`. Mirrors the SDK's `SessionStatus` retry variant.
 * `action` is optional and free-form (not rate-limit-specific) — see Fix 2
 * in the retry-observability spec.
 */
export interface RetryStatusPayload {
  attempt: number
  message: string
  action?: {
    reason: string
    provider: string
    title: string
    message: string
    label: string
    link?: string
  }
  /**
   * Absolute epoch-ms timestamp of the next retry attempt — NOT a relative
   * delta. Confirmed against the opencode server/TUI source (session.retry.scheduled
   * emits `{attempt, at, error}` mapped straight onto `next`, and the built-in
   * TUI computes remaining seconds as `Math.round((next - Date.now()) / 1000)`).
   */
  next: number
  /**
   * Caller-supplied agent hint for NON-MEMBER (isolated) sessions — e.g.
   * "diana". When present, the isolated failover path (see the member vs.
   * non-member SEAM in handleRetryModelFailover) skips the
   * `client.session.get()` round-trip for agent discovery. Member sessions
   * ignore this field: their agent lives in `team_member.agent`.
   */
  agent?: string
}

/** Result of a session status event — tells the caller what transition happened. */
export interface StatusTransition {
  memberName: string
  teamId: string
  from: string
  to: string
}

/**
 * Handle a session.status event. Updates member status and execution_status
 * in SQLite based on the new session status.
 * Ignores events for unknown sessions or archived teams.
 * Returns the transition if one occurred, for toast notifications.
 *
 * `retryPayload` is only consulted when `status === "retry"` — it persists
 * the four additive retry_* columns (Fix 2). TICKET-RELEASE-11 (Frente A)
 * extends the retry branch: a retry whose SCHEDULED NEXT ATTEMPT lies beyond
 * `config.paywallRetryThresholdMs` (default 1 h) is a paywall/out-of-quota
 * stall, not a transient rate limit — the member flips to the VISIBLE
 * 'throttled' state (Migration 20), nudges/checkChatty stay suppressed (they
 * key on status='busy'/'ready'), and the lead receives EXACTLY ONE system
 * notification (fired only on the transition INTO 'throttled', persisted
 * passively under silentLead). When the provider unblocks, the next busy
 * event releases 'throttled' → 'busy' (see the busy branch below) and the
 * next idle event releases 'throttled' → 'ready' (the idle ternary already
 * covers every non-shutdown status).
 *
 * `client`/`config` are OPTIONAL (retrocompatible): the HORIZON decision
 * degrades to the documented 1 h default without config, so the FSM state
 * stays truthful on every caller — but the lead notification (which needs a
 * client) is skipped when absent, and no error is thrown either way.
 */
export function handleSessionStatusEvent(
  db: Database,
  registry: MemberRegistry,
  sessionId: string,
  status: "idle" | "busy" | "retry",
  retryPayload?: RetryStatusPayload,
  client?: PluginClient,
  config?: Required<EnsembleConfig>,
): StatusTransition | undefined {
  const entry = registry.getBySession(sessionId)
  if (!entry) return undefined

  // Check if team is archived — if so, silently ignore
  const team = db.query("SELECT status FROM team WHERE id = ?").get(entry.teamId) as { status: string } | null
  if (!team || team.status === "archived") return undefined

  const member = db.query("SELECT status, execution_status FROM team_member WHERE team_id = ? AND name = ?")
    .get(entry.teamId, entry.memberName) as { status: string; execution_status: string } | null
  if (!member) return undefined

  if (status === "idle") {
    const newStatus = member.status === "shutdown_requested" ? "shutdown" : "ready"
    if (member.status === newStatus) return undefined
    db.run(
      "UPDATE team_member SET status = ?, execution_status = 'idle', time_updated = ? WHERE team_id = ? AND name = ?",
      [newStatus, Date.now(), entry.teamId, entry.memberName]
    )
    // A gracefully shut-down member has actually stopped now — release any
    // tasks they left in_progress back to the pool so nothing is stranded (issue #27).
    if (newStatus === "shutdown") {
      releaseMemberTasks(db, entry.teamId, entry.memberName)
    }
    // TICKET-RELEASE-11 (Frente C) — BATON RELEASE (one of the FOUR replay
    // triggers, OPT-IN sharedCheckoutSingleWriter): this member just went
    // idle, so their baton may have been released. Replay the standby wakes
    // the formal-baton gate deferred (fire-and-forget — the flush only
    // prompts members still in standby with queued delivered=0 rows; the
    // gate re-evaluates per recipient and re-defers if another card-holder
    // remains). With the default flag OFF this is a cheap no-op.
    if (client) {
      void deliverDeferredStandbyWakes(db, client, registry, entry.teamId, config?.sharedCheckoutSingleWriter === true).catch((err) => {
        log(`status:baton-release-flush:failed team=${entry.teamId} err=${err instanceof Error ? err.message : String(err)}`)
      })
    }
    // Mark teammate as having reported if they sent at least one message to lead (issue #3).
    // Set on busy→ready transition so Q&A messages during work don't prematurely block delivery.
    if (member.status === "busy" && newStatus === "ready") {
      const leadMsgCount = (db.query(
        "SELECT COUNT(*) as c FROM team_message WHERE team_id = ? AND from_name = ? AND to_name = 'lead'"
      ).get(entry.teamId, entry.memberName) as { c: number }).c
      if (leadMsgCount > 0) {
        db.run(
          "UPDATE team_member SET reported_to_lead = 1 WHERE team_id = ? AND name = ?",
          [entry.teamId, entry.memberName]
        )
      }
    }
    return { memberName: entry.memberName, teamId: entry.teamId, from: member.status, to: newStatus }
  } else if (status === "busy") {
    // TICKET-RELEASE-11 (Frente A): 'throttled' joins ready/error as a valid
    // SOURCE of the busy transition — a paywall-blocked member whose provider
    // unblocked (retry succeeded / new turn started) must be released back to
    // 'busy' instead of being frozen until an idle event.
    if (member.status === "ready" || member.status === "error" || member.status === "throttled") {
      // Reset reported_to_lead so re-activated teammates can receive messages again (issue #3).
      // INVARIANT: every promptAsync delivery path must check hasReportedCompletion() to prevent loops.
      db.run(
        "UPDATE team_member SET status = 'busy', execution_status = 'running', reported_to_lead = 0, time_updated = ? WHERE team_id = ? AND name = ?",
        [Date.now(), entry.teamId, entry.memberName]
      )
      return { memberName: entry.memberName, teamId: entry.teamId, from: member.status, to: "busy" }
    }
    // Freshly-spawned member: inserted as busy/starting before the session's
    // first busy event. Advance execution_status to running and refresh
    // time_updated so the dashboard shows accurate progress instead of a
    // frozen "starting" state (do NOT reset reported_to_lead — status is
    // already busy, so this is not a re-activation).
    if (member.status === "busy" && member.execution_status === "starting") {
      db.run(
        "UPDATE team_member SET execution_status = 'running', time_updated = ? WHERE team_id = ? AND name = ?",
        [Date.now(), entry.teamId, entry.memberName]
      )
      return { memberName: entry.memberName, teamId: entry.teamId, from: member.status, to: "busy" }
    }
    // Session went busy while shutdown was requested — signal for re-abort
    if (member.status === "shutdown_requested") {
      return { memberName: entry.memberName, teamId: entry.teamId, from: "shutdown_requested", to: "busy_while_shutdown" }
    }
  } else if (status === "retry") {
    // Session is being rate-limited — signal for toast but don't change state.
    // Persist the retry_* columns so the signal survives past the toast (Fix 2)
    // — status/execution_status are untouched, and there is no "provider
    // throttled" language baked in here: the SDK's retry status is generic,
    // so we surface whatever action.message/status.message actually says.
    //
    // TICKET-RELEASE-11 (Frente A): on TOP of the retry_* persistence, a
    // retry whose scheduled next attempt (`retryPayload.next`, absolute
    // epoch-ms) lies BEYOND `config.paywallRetryThresholdMs` (default 1 h)
    // is a paywall/out-of-quota stall — the provider is not going to let the
    // session through for a long horizon. The member is flipped to the
    // VISIBLE 'throttled' state (Migration 20) so nudges/checkChatty stay
    // suppressed and the dashboard shows the real cause, and the lead
    // receives EXACTLY ONE system notification — fired only on the
    // transition INTO 'throttled' (idempotent across the retry burst).
    if (retryPayload) {
      // Coerce before binding: older server versions may emit a partial retry
      // payload, and an undefined bind throws synchronously inside this event
      // handler, discarding the event's remaining processing.
      const next = typeof retryPayload.next === "number" && Number.isFinite(retryPayload.next) ? retryPayload.next : null
      const attempt = typeof retryPayload.attempt === "number" && Number.isFinite(retryPayload.attempt) ? retryPayload.attempt : null
      db.run(
        "UPDATE team_member SET retry_until = ?, retry_attempt = ?, retry_provider = ?, retry_message = ? WHERE team_id = ? AND name = ?",
        [
          next,
          attempt,
          retryPayload.action?.provider ?? null,
          retryPayload.action?.message ?? retryPayload.message ?? null,
          entry.teamId,
          entry.memberName,
        ]
      )

      // Paywall horizon: a finite `next` beyond the configured threshold is a
      // long-retry (paywall) stall. Without config (legacy caller) the
      // threshold degrades to the documented 1 h default; without a finite
      // `next` there is no horizon to reason about, so the transient path
      // (retry_* only, no FSM change) is kept.
      const thresholdMs = config?.paywallRetryThresholdMs ?? 60 * 60 * 1000
      const longHorizon = next !== null && next - Date.now() > thresholdMs
      if (longHorizon && member.status !== "throttled") {
        db.run(
          "UPDATE team_member SET status = 'throttled', time_updated = ? WHERE team_id = ? AND name = ?",
          [Date.now(), entry.teamId, entry.memberName]
        )
        // ONE unique lead notification per throttle episode (dedup: this block
        // only runs on the transition INTO 'throttled'). Persisted passively —
        // under silentLead (default) the SQLite row IS the delivery channel and
        // surfaces on the lead's next turn; the proactive wake stays suppressed
        // (a paywall block is recoverable, not an unrecoverable failure).
        if (client) {
          const resumeAt = new Date(next).toISOString()
          const detail = retryPayload.action?.message ?? retryPayload.message ?? "provider retry scheduled"
          notifyLead(
            client,
            db,
            entry.teamId,
            `Teammate "${entry.memberName}" is THROTTLED by a paywall/long rate-limit — next retry not before ${resumeAt} (${detail}). ` +
            "Nudges and delivery are suspended until the provider unblocks; the member resumes automatically on the next successful turn.",
            config ? { config } : undefined,
          )
        }
        log(`status:throttled member=${entry.memberName} team=${entry.teamId} next_retry_in_ms=${next - Date.now()} threshold_ms=${thresholdMs}`)
        return { memberName: entry.memberName, teamId: entry.teamId, from: member.status, to: "throttled" }
      }
    }
    return { memberName: entry.memberName, teamId: entry.teamId, from: member.status, to: "retry" }
  }
  return undefined
}

/**
 * Handle a session.created event. Tracks the parent-child relationship
 * in the DescendantTracker for sub-agent isolation.
 */
export function handleSessionCreatedEvent(
  tracker: DescendantTracker,
  sessionId: string,
  parentId: string | undefined,
): void {
  if (parentId) {
    tracker.track(sessionId, parentId)
  }
}

/**
 * Check whether a tool call should be blocked for sub-agent isolation.
 * Throws if the tool is a team tool and the session is a descendant of a team member.
 * OQ-11: confirmed — throwing inside tool.execute.before fails the tool call gracefully (verified in live testing).
 *
 * The optional `db` parameter enables a SQLite fallback so the check works
 * across multi-Plugin-instance scenarios where the in-memory registry may
 * not have the parent teammate's session. SQLite is the canonical source.
 *
 * Order:
 *   1. Registry fast-path: if the caller is itself a registered teammate, allow.
 *   2. Otherwise enumerate active teammate session IDs from registry + SQLite.
 *   3. If the caller is among them, allow.
 *   4. If the caller is a descendant of any teammate, block.
 *
 * The fast-path skips the SQL query entirely when the registry already
 * has the caller. Lead sessions are NOT in the MemberRegistry by design
 * (only teammates are), so a lead's team_* call always misses the
 * fast-path and does the SQLite enumeration. That's acceptable — the
 * scan is bounded by total active members and runs once per tool call.
 */
export function checkToolIsolation(
  registry: MemberRegistry,
  tracker: DescendantTracker,
  toolName: string,
  sessionId: string,
  db?: Database,
): void {
  if (!toolName.startsWith(TEAM_TOOL_PREFIX)) return

  // Fast path: registry hit on the caller — skip SQL altogether.
  if (registry.isTeamSession(sessionId)) return

  // Collect every session ID that is a teammate, from the registry first
  // (fast path) and SQLite second (covers multi-instance / cross-plugin state).
  const teammateSessionIds = new Set(registry.allSessionIds())
  if (db) {
    const dbRows = db.query(
      `SELECT tm.session_id FROM team_member tm
       JOIN team t ON tm.team_id = t.id
       WHERE t.status = 'active' AND tm.status NOT IN ('shutdown', 'error')`
    ).all() as Array<{ session_id: string }>
    for (const row of dbRows) teammateSessionIds.add(row.session_id)
  }

  // The caller may be a teammate registered in another Plugin instance — allow.
  if (teammateSessionIds.has(sessionId)) return

  if (teammateSessionIds.size > 0 && tracker.isDescendantOf(sessionId, teammateSessionIds)) {
    throw new Error("Team tools are not available to sub-agents. Report findings to your parent teammate via your normal output.")
  }
}

/**
 * True when the member holds at least one assigned task in status 'in_review'.
 * A member waiting on review feedback from Clara/reviewer is in legitimate wait.
 */
export function hasInReviewAssignedTasks(db: Database, teamId: string, memberName: string): boolean {
  const row = db.query(
    "SELECT id FROM team_task WHERE team_id = ? AND assignee = ? AND status = 'in_review' LIMIT 1"
  ).get(teamId, memberName)
  return !!row
}

/**
 * True when the member is in active peer dialogue (sent or received messages
 * to/from teammates other than lead).
 */
export function hasActivePeerDialogue(db: Database, teamId: string, memberName: string): boolean {
  const row = db.query(
    "SELECT id FROM team_message WHERE team_id = ? AND ((from_name = ? AND to_name != 'lead' AND to_name IS NOT NULL) OR (to_name = ? AND from_name != 'lead')) LIMIT 1"
  ).get(teamId, memberName, memberName)
  return !!row
}

/**
 * True when the team has any uncompleted tasks remaining on the board
 * (status is pending, in_progress, or in_review).
 */
export function hasPendingBoardTasks(db: Database, teamId: string): boolean {
  const row = db.query(
    "SELECT id FROM team_task WHERE team_id = ? AND status != 'completed' LIMIT 1"
  ).get(teamId)
  return !!row
}

/**
 * True when the team has other active members (status not shutdown or error).
 */
export function hasOtherActiveMembers(db: Database, teamId: string, memberName: string): boolean {
  const row = db.query(
    "SELECT name FROM team_member WHERE team_id = ? AND name != ? AND status NOT IN ('shutdown', 'error') LIMIT 1"
  ).get(teamId, memberName)
  return !!row
}

/**
 * Check if a member went idle without ever sending a message to the lead.
 * Returns true if the member is idle/ready and has no outbound messages.
 *
 * Returns false (nudge suppressed) when:
 * - `silentLead: true` (default economic mode) is active — coercive report nudges
 *   are completely suppressed to conserve tokens and prevent unnecessary wakes;
 * - `execution_status === 'standby'` — spawned paused, woken only by the first
 *   inbound `team_message` (standby spawn lifecycle);
 * - the member owns tasks in status 'in_review' (waiting on reviewer feedback);
 * - the member is in active peer dialogue (collaborating with teammates).
 *
 * For backwards compatibility, passing config with `{ silentLead: false }`
 * re-enables the legacy idle-without-report nudge flow.
 */
export function shouldNudgeIdleMember(
  db: Database,
  teamId: string,
  memberName: string,
  config?: EnsembleConfig,
): boolean {
  const isSilentLead = config?.silentLead ?? true
  if (isSilentLead) return false

  const member = db.query("SELECT status, execution_status FROM team_member WHERE team_id = ? AND name = ?")
    .get(teamId, memberName) as { status: string; execution_status: string } | null
  if (!member || member.status !== "ready") return false

  // Standby: silence until wake is by design, never a missed report.
  if (member.execution_status === "standby") return false

  // Member has tasks under review — waiting on reviewer/Clara is legitimate.
  if (hasInReviewAssignedTasks(db, teamId, memberName)) return false

  // Member in active dialogue with peers — collaborating directly.
  if (hasActivePeerDialogue(db, teamId, memberName)) return false

  const msg = db.query("SELECT id FROM team_message WHERE team_id = ? AND from_name = ? AND (to_name = 'lead' OR to_name IS NULL) LIMIT 1")
    .get(teamId, memberName) as { id: string } | null
  return !msg
}

/**
 * Decide whether the fast-idle alarm must fire for a member that just went
 * idle (`busy → ready`).
 *
 * The alarm means "the model failed to start" and wakes the lead with a
 * warning, so it must stay silent for members whose early idle is expected:
 * - `execution_status === 'standby'` (spawned paused — prompt is suppressed
 *   until the wake path delivers `spawn_context`);
 * - members with assigned tasks in review;
 * - teams with pending tasks remaining on the board or other active members;
 * - members older than 15s, or that already produced at least one message.
 *
 * Extracted from the inline `fast-idle` block of `src/index.ts` so the decision
 * is unit-testable against a real SQLite database without reimplementing it.
 * `now` is injectable for deterministic tests; production callers omit it.
 */
export function shouldAlarmFastIdle(
  db: Database,
  teamId: string,
  memberName: string,
  now: number = Date.now(),
): boolean {
  const member = db.query("SELECT time_created, execution_status FROM team_member WHERE team_id = ? AND name = ?")
    .get(teamId, memberName) as { time_created: number; execution_status: string } | null
  if (!member) return false

  // Standby or review-waiting members idle immediately on purpose.
  if (member.execution_status === "standby") return false
  if (hasInReviewAssignedTasks(db, teamId, memberName)) return false

  // Suppress alarm if there are pending tasks on the board or other active members in the team.
  if (hasPendingBoardTasks(db, teamId)) return false
  if (hasOtherActiveMembers(db, teamId, memberName)) return false

  if (now - member.time_created >= 15_000) return false

  const msgCount = (db.query("SELECT COUNT(*) as c FROM team_message WHERE team_id = ? AND from_name = ?")
    .get(teamId, memberName) as { c: number }).c
  return msgCount === 0
}

/** Neutral correction message when tasks remain under review. */
export const IN_REVIEW_NUDGE_MESSAGE =
  "[System]: Tasks remain in review on the board. You must call team_tasks_complete to approve or reject the review, and report the outcome to the lead via team_message."

/** Maximum nudge attempts per team:member:taskId before cooldown permanently stops. */
export const MAX_IN_REVIEW_NUDGES = 2

/** In-memory tracking of in-review nudges for dedup and cooldown: Map<`${teamId}:${memberName}:${taskId}`, count> */
export const inReviewNudges = new Map<string, number>()

/**
 * Check if an idle/ready member should be nudged regarding tasks currently under review.
 * - Developers/submitters must NOT be nudged: they wait passively for review.
 * - Only the Quality Gate reviewer (qa-role.ts: is_qa flag / clara retrocompat)
 *   is nudged for tasks in 'in_review'.
 * - Returns the taskId to nudge for, or false if suppressed/no eligible tasks.
 * - Applies a cooldown/dedup limit (default MAX_IN_REVIEW_NUDGES = 2 attempts per team:member:taskId).
 */
export function shouldNudgeInReviewTasks(
  db: Database,
  teamId: string,
  memberName: string,
): string | false {
  // Only the Quality Gate reviewer should be nudged about in_review tasks.
  // Standard developers waiting passively for review must not receive in_review nudges.
  if (!isQAMember(db, teamId, memberName)) return false

  const member = db.query("SELECT status, execution_status FROM team_member WHERE team_id = ? AND name = ?")
    .get(teamId, memberName) as { status: string; execution_status: string } | null
  if (!member || member.status !== "ready") return false
  if (member.execution_status === "standby") return false

  // For the QA reviewer, check all tasks with status 'in_review' on the board
  const candidateTasks = db.query(
    "SELECT id FROM team_task WHERE team_id = ? AND status = 'in_review' ORDER BY time_updated ASC"
  ).all(teamId) as Array<{ id: string }>

  if (candidateTasks.length === 0) return false

  for (const t of candidateTasks) {
    const key = `${teamId}:${memberName}:${t.id}`
    const attempts = inReviewNudges.get(key) ?? 0
    if (attempts < MAX_IN_REVIEW_NUDGES) {
      return t.id
    }
  }

  return false
}

/** Shape of an error attached to a session.error event. Subset of the SDK's union. */
export interface SessionErrorPayload {
  name?: string
  data?: { message?: string }
}

/**
 * Error NAMES that mean the turn was stopped ON PURPOSE (TICKET-HARNESS-34 A2).
 * OpenCode's session.abort() surfaces `MessageAbortedError`; other SDK layers
 * use `AbortError`/`InterruptedError`.
 */
const ABORT_ERROR_NAME = /abort|interrupt/i

/**
 * Error MESSAGE signatures of an intentional abort — the host's canonical
 * wording is "The running turn was stopped before OpenCode could send the next
 * message.", but failover/timeout/forced-shutdown paths may surface a variant
 * that names the mechanism explicitly. Generic words like "error" or "failed"
 * are deliberately NOT matched: a real model/tool failure must stay visible.
 */
const ABORT_ERROR_MESSAGE =
  /\babort(?:ed|ing|s)?\b|\bstopped before opencode\b|\bwas (?:intentionally )?(?:stopped|interrupted|cancell?ed)\b|\bforce(?:d)?[ -]shutdown\b|\b(?:failover|timeout)[ -]?abort\b/i

/**
 * True when a `session.error` payload is an INTENTIONAL abort — the noise
 * emitted after `session.abort()` from a rate-limit failover, a watchdog
 * timeout or a forced shutdown.
 *
 * TICKET-HARNESS-34 (A2): the host fires `session.error` with
 * `MessageAbortedError` on every abort, including the ones the plugin itself
 * triggers on purpose. Notifying the lead there produced a false "teammate had
 * a session error" alarm — and, with silentLead off, a spurious wake — on a
 * turn that was stopped by design. Filtered events only log.
 */
export function isAbortError(error: SessionErrorPayload | undefined): boolean {
  if (!error) return false
  if (error.name && ABORT_ERROR_NAME.test(error.name)) return true
  const message = error.data?.message ?? ""
  return message.length > 0 && ABORT_ERROR_MESSAGE.test(message)
}

/**
 * Handle a session.error event. Surfaces tool/model failures from a teammate
 * as a system message to the lead, so otherwise-silent failures are visible.
 *
 * The lead is actively woken via notifyLead so the message is delivered even
 * when the errored teammate was the last busy member (the "all done" gate in
 * the passive wake path would otherwise strand the message). The teammate
 * itself is NOT auto-resumed — recovery is left to the lead's judgement.
 *
 * Ignored when:
 * - sessionID is undefined
 * - the session is not a registered teammate (leads are not in the registry)
 * - the error is an INTENTIONAL abort (TICKET-HARNESS-34 A2 — failover,
 *   watchdog timeout or forced shutdown call session.abort(), and the host's
 *   MessageAbortedError for that turn must not raise a false lead alarm).
 */
export function handleSessionErrorEvent(
  db: Database,
  registry: MemberRegistry,
  client: PluginClient,
  sessionId: string | undefined,
  error: SessionErrorPayload | undefined,
  config?: Required<EnsembleConfig>,
): void {
  if (!sessionId) return
  // Use findTeamBySession so the SQLite fallback fires when this Plugin
  // instance's in-memory registry doesn't have the teammate (multi-instance
  // scenario — see findTeamBySession in src/types.ts).
  const teamInfo = findTeamBySession(db, registry, sessionId)
  if (!teamInfo || teamInfo.role !== "member" || !teamInfo.memberName) return

  // TICKET-HARNESS-34 (A2) — abort/failover noise filter, BEFORE any notify.
  // The turn was stopped on purpose (failover, timeout, force shutdown):
  // persist nothing, wake nobody, only log the decision.
  //
  // TICKET-RELEASE-17: `team_standby` / `team_task_handover` now end the
  // caller's turn through `scheduleStandbyAbort()`, which marks the abort as
  // plugin-intentional. The mark is consumed here as a second, wording-agnostic
  // line of defence: even if the host surfaces the abort with a payload that
  // does not match ABORT_ERROR_MESSAGE, a deliberate standby pause must never
  // become a "teammate had a session error" alarm nor wake the lead.
  const intentionalAbort = consumeIntentionalAbort(sessionId)
  if (isAbortError(error) || intentionalAbort) {
    const abortMsg = error?.data?.message ?? error?.name ?? "aborted"
    const origin = intentionalAbort ? "intentional" : "error-signature"
    log(`session-error:aborted member=${teamInfo.memberName} team=${teamInfo.teamId} origin=${origin} err=${abortMsg}`)
    return
  }

  const errMsg = error?.data?.message ?? error?.name ?? "unknown error"
  notifyLead(
    client,
    db,
    teamInfo.teamId,
    `Teammate "${teamInfo.memberName}" had a session error: ${errMsg}. Check their session for details. They may be stuck and need investigation or shutdown.`,
    // HARNESS-15 B: when the caller threads the config through, the wake is
    // model-aware (agent + fallback-chain ladder inside notifyLead). Omitting
    // it keeps the legacy wake — retrocompatible for callers without config.
    // TICKET-HARNESS-34 (A1): a GENUINE (non-abort) session error is an
    // unrecoverable failure — it must punch through `silentLead`.
    config ? { config, forceWake: true } : { forceWake: true },
  )
}

/* ------------------------------------------------------------------ *
 * Silent model failover on rate limit (429/retry) — zero-noise policy *
 * ------------------------------------------------------------------ */

/**
 * Long cooldown window (TICKET-HARNESS-53): how long an EXHAUSTED-chain
 * decision stays cached for the same member/session. It is NOT the window
 * between consecutive model switches anymore — see
 * FAILOVER_BURST_DEBOUNCE_MS. Keeping the exhausted decision cached this long
 * avoids re-logging/re-toasting "no fallback left" on every residual retry
 * event of the same dead burst.
 */
export const FAILOVER_COOLDOWN_MS = 10 * 60 * 1000

/**
 * Short debounce (TICKET-HARNESS-53): retry events for ONE rate-limit burst
 * arrive attempt-after-attempt (1, 2, 3…) on the SAME in-flight model, and
 * those residual events may still land in the milliseconds right after the
 * abort. Inside this window every event after an action is `failover:suppressed`
 * — the abort is in flight and the chain must not be burned per attempt.
 *
 * Beyond this window the event can only come from the model that was JUST
 * applied: if that fallback also answers 429, the chain must advance
 * IMMEDIATELY (A -> B -> C -> D in seconds) instead of freezing the session
 * for FAILOVER_COOLDOWN_MS in the native ~4h backoff trap.
 */
export const FAILOVER_BURST_DEBOUNCE_MS = 2_500

/**
 * Last failover-action timestamp per cooldown key (`${teamId}:${memberName}`
 * for members, `isolated:${sessionId}` for isolated/lead sessions).
 * Module-level like team-spawn's spawnFailures — one decision per key is
 * process-wide in-memory state. Exported so deterministic suites can
 * clear/rewind it without sleeping.
 *
 * NOTE: this map is intentionally kept as `Map<string, number>` — the public
 * get/set/delete/clear contract used by every existing suite. Model metadata
 * lives in the parallel `failoverActions` map below.
 */
export const failoverCooldown = new Map<string, number>()

/**
 * Model metadata for the last failover action of each cooldown key.
 * Parallel to `failoverCooldown` (never a replacement) so the exported
 * timestamp map keeps its `number` value type.
 *
 * `exhausted` records let the gate re-suppress the same dead burst for the
 * whole FAILOVER_COOLDOWN_MS; live records let it tell "residual event of the
 * burst I just aborted" (suppress) from "the fallback model I just applied
 * also died" (advance now).
 */
export interface FailoverActionRecord {
  /** Timestamp of the action (mirrors the `failoverCooldown` value). */
  at: number
  /** Model the session was on when the action fired (null = server default). */
  fromModel: string | null
  /** Model the session was switched TO (null when the chain was exhausted). */
  toModel: string | null
  /** True when the decision was `exhausted` (nothing left to switch to). */
  exhausted: boolean
}

/** @see FailoverActionRecord */
export const failoverActions = new Map<string, FailoverActionRecord>()

type FailoverCooldownVerdict =
  | { verdict: "proceed"; walkFrom: string | null }
  | { verdict: "suppressed"; remainingMs: number }

/**
 * Model-aware failover gate (TICKET-HARNESS-53).
 *
 * The clock is ALWAYS the exported `failoverCooldown` timestamp, so existing
 * suites that rewind/clear it keep working unchanged.
 *
 * Cases:
 *   1. No timestamp for the key → proceed from `currentModel`.
 *   2. Timestamp without metadata (legacy/seeded entry) → historical rule:
 *      suppress inside FAILOVER_COOLDOWN_MS, proceed after it.
 *   3. Last action was `exhausted` → suppress the dead burst for
 *      FAILOVER_COOLDOWN_MS (no repeated toast/log), then retry.
 *   4. Last action was a switch. The debounce is MODEL-AWARE (HARNESS-57):
 *      it only shields residual retry events of the request that was just
 *      aborted (`currentModel === null` or `currentModel === record.fromModel`).
 *      a. residual echo inside FAILOVER_BURST_DEBOUNCE_MS → SUPPRESS;
 *      b. residual echo beyond the debounce → PROCEED from `record.toModel`
 *         (the caller still sees the PREVIOUS model: the server has not
 *         rebound `session.model` yet, or the member row was not read back),
 *         so the ladder never re-picks the same rung (A -> B -> B loop) nor
 *         restarts at chain[0];
 *      c. a DIFFERENT model already reporting the error (typically
 *         `currentModel === record.toModel` dying in under the debounce)
 *         → PROCEED IMMEDIATELY, bypassing the debounce, walking from
 *         `currentModel` (falling back to `record.toModel`). Without this
 *         bypass the freshly applied fallback's fast 429 was swallowed and
 *         the CLI slept through its native hours-long backoff.
 */
export function evaluateFailoverCooldown(
  key: string,
  currentModel: string | null,
  now: number,
): FailoverCooldownVerdict {
  const last = failoverCooldown.get(key)
  if (last === undefined) return { verdict: "proceed", walkFrom: currentModel }

  const elapsed = now - last
  const record = failoverActions.get(key)
  if (!record) {
    // Legacy/seeded entry: no model metadata to reason about — keep the
    // pre-HARNESS-53 semantics byte-for-byte.
    if (elapsed < FAILOVER_COOLDOWN_MS) {
      return { verdict: "suppressed", remainingMs: FAILOVER_COOLDOWN_MS - elapsed }
    }
    return { verdict: "proceed", walkFrom: currentModel }
  }

  if (record.exhausted) {
    if (elapsed < FAILOVER_COOLDOWN_MS) {
      return { verdict: "suppressed", remainingMs: FAILOVER_COOLDOWN_MS - elapsed }
    }
    return { verdict: "proceed", walkFrom: currentModel }
  }

  // TICKET-HARNESS-57 — the debounce only shields residual echoes of the model
  // that was JUST aborted. If the error already comes from a DIFFERENT model
  // (e.g. the freshly applied `record.toModel` answering 429 in under 2.5s),
  // this is a NEW burst and must advance immediately; suppressing it froze the
  // session in the CLI's native hours-long backoff.
  const echoOfAborted = currentModel === null || currentModel === record.fromModel
  if (echoOfAborted && elapsed < FAILOVER_BURST_DEBOUNCE_MS) {
    return { verdict: "suppressed", remainingMs: FAILOVER_BURST_DEBOUNCE_MS - elapsed }
  }

  // Residual echo beyond the debounce walks from the model the last switch
  // applied; a different model advances from itself.
  const walkFrom = echoOfAborted ? record.toModel : currentModel
  return { verdict: "proceed", walkFrom: walkFrom ?? currentModel }
}

/**
 * Record a failover action in BOTH maps atomically (timestamp first — it is
 * the authoritative clock read by evaluateFailoverCooldown).
 */
function recordFailoverAction(
  key: string,
  at: number,
  fromModel: string | null,
  toModel: string | null,
  exhausted: boolean,
): void {
  failoverCooldown.set(key, at)
  failoverActions.set(key, { at, fromModel, toModel, exhausted })
}

/* ------------------------------------------------------------------ *
 * Deterministic model-resolution failures (ProviderModelNotFound)     *
 * ------------------------------------------------------------------ */

/**
 * Texts a retry/session error can carry the failure detail in. Collecting
 * every field keeps the detection tolerant to the SDK's union shapes
 * (`name` + `data.message` for session.error, `message`/`action.*` for
 * session.status retry payloads).
 */
function modelErrorTexts(payload: unknown): string[] {
  if (!payload) return []
  if (typeof payload === "string") return [payload]
  if (typeof payload !== "object") return []
  const e = payload as {
    name?: unknown
    message?: unknown
    data?: { message?: unknown }
    action?: { reason?: unknown; message?: unknown; title?: unknown }
  }
  const out: string[] = []
  for (const value of [
    e.name,
    e.message,
    e.data?.message,
    e.action?.reason,
    e.action?.message,
    e.action?.title,
  ]) {
    if (typeof value === "string" && value) out.push(value)
  }
  return out
}

/**
 * True when the payload describes a DETERMINISTIC model-resolution failure
 * (`ProviderModelNotFoundError` / "Model not found: ...") instead of a
 * transient rate limit.
 *
 * Detection delegates to `isModelNotFoundError` (src/model-catalog.ts, F1).
 * That helper already normalizes Error, string and `{name,message,data}`
 * shapes; the extra pass over THIS module's retry-payload fields covers the
 * `action.reason/message/title` strings the retry status carries and the
 * catalog helper never sees. There is no second, divergent signature regex.
 */
export function isModelResolutionFailure(payload: unknown): boolean {
  if (!payload) return false
  if (isModelNotFoundError(payload)) return true
  return modelErrorTexts(payload).some((text) => isModelNotFoundError(text))
}

/**
 * Selector candidates inside an error message. Anchored on the wording
 * providers actually emit ("Model not found: provider/model", "model `p/m`
 * does not exist"); used as a fallback when the shared catalog helper
 * (`extractModelSelectorFromError`, F1) finds nothing.
 */
const MODEL_AFTER_NOT_FOUND =
  /(?:model|provider)[^\n]{0,40}?(?:not\s*found|does\s*not\s*exist|not\s*available|unknown|invalid)[^A-Za-z0-9#]{0,4}([A-Za-z0-9][\w.-]*\/[A-Za-z0-9][\w./-]*(?:#[\w.-]+)?)/i

/**
 * Extract the model selector named by a model-resolution error, normalized via
 * `parseModelSelector` (§5.1: `#default` never survives). Delegates to the
 * shared helper from src/model-catalog.ts first so F1 and F2 speak the same
 * language; returns undefined when neither finds a usable selector — callers
 * then fall back to the member/current model instead of guessing.
 */
export function extractFailedModelSelector(payload: unknown): string | undefined {
  const candidate = extractModelSelectorFromError(payload)
    ?? modelErrorTexts(payload).map((text) => MODEL_AFTER_NOT_FOUND.exec(text)?.[1]).find((value) => !!value)
  if (!candidate) return undefined
  const parsed = parseModelSelector(candidate)
  if (!parsed) return undefined
  return formatModelSelector({
    model: `${parsed.providerID}/${parsed.modelID}`,
    ...(parsed.variant ? { variant: parsed.variant } : {}),
  })
}

/**
 * Canonical comparison key for a selector — the SAME normalization used by
 * `selectNextFallback` (config.ts §5.1). Without it, "p/m#default" would look
 * different from "p/m" and a deterministic error would restart at chain[0] on
 * every event: the infinite failover loop the VARIANT_ABSENT_SENTINEL contract
 * exists to prevent.
 */
function canonicalModelKey(selector: string | null | undefined): string | null {
  if (!selector) return null
  const trimmed = selector.trim()
  if (!trimmed) return null
  const parsed = parseModelSelector(trimmed)
  if (!parsed) return trimmed
  return formatModelSelector({
    model: `${parsed.providerID}/${parsed.modelID}`,
    ...(parsed.variant ? { variant: parsed.variant } : {}),
  })
}

/** True when two selectors name the same provider/model#variant (§5.1). */
function sameModel(a: string | null | undefined, b: string | null | undefined): boolean {
  const keyA = canonicalModelKey(a)
  const keyB = canonicalModelKey(b)
  return keyA !== null && keyA === keyB
}

/**
 * Variant-INDEPENDENT identity of a selector: "provider/model". This is the
 * model identity a DETERMINISTIC "Model not found" names — `ProviderModelNotFound`
 * is raised for the MODEL, not for one of its thinking levels, which is exactly
 * why the shared catalog extractor (src/model-catalog.ts `extractModelSelectorFromError`)
 * strips `#variant` on purpose and why `catalogKey` compares on provider+model
 * only (variant is a server-side overlay, never an identity).
 *
 * BUG (SDET Hugo, TICKET-RELEASE-10): a member on "prov/a#low" receiving
 * "Model not found: prov/a" was matched by the variant-CARRYING canonical key,
 * so the ladder failed to locate the dead rung, fell into the
 * "current outside the chain" branch and REAPPLIED "prov/a#low" forever — the
 * infinite loop §5.1 exists to prevent, in a shape §5.1 alone does not cover.
 */
function modelIdentity(selector: string | null | undefined): string | null {
  if (!selector) return null
  const trimmed = selector.trim()
  if (!trimmed) return null
  return catalogKey(trimmed) ?? null
}

/**
 * True when a cited selector names the same MODEL as an applied rung, either
 * exactly (§5.1 normalization) or ignoring the variant (identity match).
 */
function namesSameModel(cited: string | null, applied: string | null | undefined): boolean {
  if (cited === null || !applied) return false
  if (sameModel(cited, applied)) return true
  const citedIdentity = modelIdentity(cited)
  return citedIdentity !== null && citedIdentity === modelIdentity(applied)
}

type DeterministicFailoverVerdict =
  | { verdict: "proceed"; walkFrom: string | null }
  | { verdict: "suppressed"; remainingMs: number }

/**
 * Gate for a DETERMINISTIC model-resolution failure. Unlike the rate-limit
 * gate (`evaluateFailoverCooldown`), the long cooldown must NEVER freeze the
 * chain: a model that does not exist will not start existing on the next
 * attempt, so the only useful reaction is advancing to the next rung.
 *
 * Matching is by MODEL IDENTITY, not by the variant-carrying key: providers
 * cite the base model ("Model not found: prov/a") while the applied rung
 * usually carries a variant ("prov/a#low"). Comparing the two literally was
 * the infinite-reapplication bug found by the SDET.
 *
 * Cases:
 *   - no action yet → proceed from the cited model;
 *   - a legacy/seeded cooldown entry (no metadata) → proceed: a deterministic
 *     failure is never a burst echo, so the rate-limit window cannot freeze it;
 *   - the error names the rung ALREADY APPLIED by the last switch → advance
 *     immediately, ignoring the debounce (that rung is dead, walking from it
 *     moves forward; §5.1 keeps `#default` equivalent to the variant-less key);
 *   - an exhausted chain re-suppresses ONLY the same dead model for
 *     FAILOVER_COOLDOWN_MS (no repeated actionable alarm); a DIFFERENT failing
 *     model (e.g. config changed) is re-walked at once;
 *   - a residual echo of the request that was just aborted (the error still
 *     names the ABORTED model — the server has not rebound the session yet) is
 *     suppressed once inside FAILOVER_BURST_DEBOUNCE_MS; past that window it
 *     must walk from `record.toModel` — the rung actually applied — NEVER from
 *     the abandoned one, or the ladder replays a no-op (SDET Hugo BUG 2, the
 *     same rule `evaluateFailoverCooldown` implements for 429s).
 */
export function evaluateDeterministicFailover(
  key: string,
  failedModel: string | null,
  now: number,
): DeterministicFailoverVerdict {
  const last = failoverCooldown.get(key)
  if (last === undefined) return { verdict: "proceed", walkFrom: failedModel }

  const elapsed = now - last
  const record = failoverActions.get(key)
  if (!record) {
    // Legacy/seeded entry: a deterministic failure is not a burst echo, so it
    // always proceeds (the rate-limit cooldown never blocks it).
    return { verdict: "proceed", walkFrom: failedModel }
  }

  const namesAppliedRung = namesSameModel(failedModel, record.toModel)
  const namesAbortedModel = failedModel === null || namesSameModel(failedModel, record.fromModel)

  if (record.exhausted) {
    if (elapsed < FAILOVER_COOLDOWN_MS && (namesAbortedModel || failedModel === null)) {
      return { verdict: "suppressed", remainingMs: FAILOVER_COOLDOWN_MS - elapsed }
    }
    return { verdict: "proceed", walkFrom: failedModel ?? record.fromModel }
  }

  // The model we just applied is the one failing → advance NOW, regardless of
  // the debounce (a nonexistent rung will never recover).
  if (namesAppliedRung) {
    return { verdict: "proceed", walkFrom: failedModel }
  }

  if (namesAbortedModel) {
    if (elapsed < FAILOVER_BURST_DEBOUNCE_MS) {
      return { verdict: "suppressed", remainingMs: FAILOVER_BURST_DEBOUNCE_MS - elapsed }
    }
    // BUG 2: past the debounce the burst is over and the server's report is
    // simply stale — walk from the rung ACTUALLY APPLIED, never from the
    // abandoned one.
    return { verdict: "proceed", walkFrom: record.toModel ?? failedModel }
  }

  // A genuinely different model failing: walk from itself.
  return { verdict: "proceed", walkFrom: failedModel ?? record.toModel }
}

/**
 * Deterministic chain walk — the forward-only ladder for a
 * `ProviderModelNotFound` failure.
 *
 * `selectNextFallback` (config.ts) is the rate-limit walk and matches the
 * variant-CARRYING key; that is correct for a 429 (the same model at another
 * thinking level can genuinely recover) but wrong for a nonexistent model,
 * where the provider cites the base selector while the applied rung carries a
 * variant. Falling into its "current outside the chain" branch re-picks
 * `chain[0]` — the dead rung — forever (the loop the SDET reproduced).
 *
 * This walk is strictly forward and never returns a known-dead model:
 *   1. `resumeAt` = the highest chain index named by ANY dead/known selector
 *      (exact §5.1 key first, then model identity), so the ladder can neither
 *      restart at chain[0] nor step backwards;
 *   2. every rung whose MODEL IDENTITY (provider/model, variant ignored) is in
 *      the dead set is skipped — "prov/a#low" and "prov/a#high" are the same
 *      dead model, not two rungs;
 *   3. the first surviving rung after `resumeAt` wins; nothing left →
 *      undefined, i.e. the observable "exhausted" decision (HARNESS-13: log +
 *      actionable persistence, never a lead wake).
 */
export function selectDeterministicNextFallback(
  chain: readonly ModelFallbackRef[],
  deadSelectors: readonly (string | null | undefined)[],
): ModelFallbackRef | undefined {
  if (chain.length === 0) return undefined

  const deadIdentities = new Set<string>()
  let resumeAt = -1
  for (const raw of deadSelectors) {
    const fullKey = canonicalModelKey(raw)
    const identity = modelIdentity(raw)
    if (identity) deadIdentities.add(identity)
    if (!fullKey) continue
    for (let index = 0; index < chain.length; index++) {
      const entry = chain[index]
      if (!entry) continue
      if (formatModelSelector(entry) === fullKey && index > resumeAt) resumeAt = index
    }
  }

  // Nothing matched by the exact key: fall back to identity matching so a
  // variant-less citation ("prov/a") still locates its rung ("prov/a#low").
  if (resumeAt === -1 && deadIdentities.size > 0) {
    for (const identity of deadIdentities) {
      for (let index = 0; index < chain.length; index++) {
        const entry = chain[index]
        if (!entry) continue
        if (catalogKey(entry.model) === identity && index > resumeAt) resumeAt = index
      }
    }
  }

  for (let index = resumeAt + 1; index < chain.length; index++) {
    const entry = chain[index]
    if (!entry) continue
    const identity = catalogKey(entry.model)
    if (identity && deadIdentities.has(identity)) continue
    return entry
  }
  return undefined
}

/**
 * Dead selectors a deterministic walk must never return to: the model named by
 * the error, the model currently bound to the session/member, and the last rung
 * applied by this same seam (so a stale server report cannot replay it).
 */
function collectDeadSelectors(
  failedModel: string | null,
  boundModel: string | null,
  gateWalkFrom: string | null,
  lastApplied: string | null,
): string[] {
  const out: string[] = []
  for (const value of [failedModel, boundModel, gateWalkFrom, lastApplied]) {
    if (typeof value === "string" && value.trim()) out.push(value.trim())
  }
  return out
}

/* ------------------------------------------------------------------ *
 * TICKET-RELEASE-11 (Frente B) — paywall / unusability ledger          *
 * ------------------------------------------------------------------ */

/**
 * Deterministic PAYWALL / out-of-quota signatures. A rung that answers with
 * one of these is not transiently rate-limited — it is UNUSABLE for this
 * billing window ("Subscribe to OpenCode Go" is the field wording) and must
 * be ledgered as dead: never persisted as the effective model again and never
 * re-selected by any subsequent failover pass of the session or the room.
 *
 * Kept conservative on purpose: generic words like "error"/"limit" alone do
 * not qualify — every pattern names the paywall/quota mechanism explicitly,
 * so a transient 429 ("rate limit exceeded, retry in Ns") never lands here.
 */
const PAYWALL_SIGNATURES: readonly RegExp[] = [
  /subscribe to opencode go/i,
  /\bpaywall\b/i,
  /out of (?:quota|credits|capacity)/i,
  /quota exceeded/i,
  /insufficient (?:credit|quota)/i,
  /upgrade (?:your|the) plan/i,
  /plan (?:limit|exceeded|expired)/i,
  /billing (?:required|issue|hold)/i,
]

/**
 * True when the payload describes a DETERMINISTIC paywall / out-of-quota
 * failure instead of a transient rate limit. Scans every text field the
 * retry/session-error payload can carry the detail in (same coverage as
 * `modelErrorTexts`). Never throws.
 */
export function isPaywallFailure(payload: unknown): boolean {
  if (!payload) return false
  const texts = modelErrorTexts(payload)
  if (texts.length === 0 && typeof payload === "string") texts.push(payload)
  return texts.some((text) => PAYWALL_SIGNATURES.some((rx) => rx.test(text)))
}

/**
 * Persistent ledger of rungs proven dead by a paywall/unusability failure.
 * Keyed by SCOPE: `${teamId}` for member sessions (ROOM scope — one billing
 * quota is shared by the whole room, so every member's failover avoids the
 * dead rung) and `isolated:${sessionId}` for isolated/lead sessions (SESSION
 * scope — no team row exists to share a ledger across). Value: the set of
 * MODEL IDENTITIES ("provider/model", variant ignored — a paywall names the
 * model, not one thinking level, exactly like ProviderModelNotFound).
 *
 * Process-wide in-memory state, like `failoverCooldown`/`failoverActions` —
 * exported so deterministic suites can inspect/clear it without sleeping.
 * Entries never expire: a paywall is deterministic unutilizability, and the
 * ledger is cleared only by an explicit config/respawn action (or test reset).
 */
export const paywallDeadRungs = new Map<string, Set<string>>()

/** Ledger a selector as dead-for-this-scope. Idempotent per identity. */
export function recordPaywallDeadRung(scopeKey: string, selector: string | null | undefined): void {
  const identity = modelIdentity(selector)
  if (!identity) return
  let set = paywallDeadRungs.get(scopeKey)
  if (!set) {
    set = new Set()
    paywallDeadRungs.set(scopeKey, set)
  }
  if (!set.has(identity)) {
    set.add(identity)
    log(`paywall:dead-rung:recorded scope=${scopeKey} model=${identity}`)
  }
}

/** Dead rung identities ledgered for a scope (empty array when none). */
export function getPaywallDeadRungs(scopeKey: string): string[] {
  const set = paywallDeadRungs.get(scopeKey)
  return set ? [...set] : []
}

/**
 * Drop every chain entry whose MODEL IDENTITY is ledgered dead for the scope.
 * The failover walk then runs over the USABLE chain only, so the switch can
 * never select — and therefore never persist into `team_member.model` — a rung
 * the paywall already proved unusable (the "NUNCA persistir / NUNCA
 * re-selecionar" invariant of Frente B).
 */
function filterChainAgainstPaywallLedger(
  chain: readonly ModelFallbackRef[],
  deadIdentities: readonly string[],
): ModelFallbackRef[] {
  if (deadIdentities.length === 0) return [...chain]
  const dead = new Set(deadIdentities)
  return chain.filter((entry) => {
    const identity = catalogKey(entry.model)
    return !identity || !dead.has(identity)
  })
}

/** Outcome of a rate-limit failover evaluation (see handleRetryModelFailover). */
export interface ModelFailoverDecision {
  /**
   * - "switched":  model swapped to the next fallback — silent, log-only.
   * - "suppressed": a failover action already happened within the cooldown
   *                 window (same burst) — nothing else to do, stay silent.
   * - "exhausted": no fallback remains (chain empty, current model is the
   *                 last entry, or fallback equals current) — surfaced to
   *                 the wiring layer (toast). The lead is NOT woken
   *                 (HARNESS-13 zero-noise).
   */
  action: "switched" | "suppressed" | "exhausted"
  memberName: string
  /**
   * Team the member belongs to. For NON-MEMBER (isolated) sessions — see the
   * member vs. non-member SEAM below — this is `""`: there is no team_member
   * row and no team to attribute the decision to. `memberName` carries the
   * session's agent name (e.g. "diana") in that case.
   */
  teamId: string
  /** Selector stored before this decision (null when the server default was in use). */
  fromModel: string | null
  /** New selector persisted — only on "switched". */
  toModel?: string
  /**
   * Why the seam acted. "rate-limit" is the historical 429/retry path;
   * "model-not-found" is the DETERMINISTIC ProviderModelNotFound path, which
   * bypasses the long cooldown (a nonexistent model never recovers);
   * "paywall" (TICKET-RELEASE-11 F2) is the DETERMINISTIC out-of-quota /
   * "Subscribe to OpenCode Go" path — also cooldown-bypassing, also ledgered
   * as a dead rung so it is never re-selected by the room or the session.
   */
  reason?: "rate-limit" | "model-not-found" | "paywall"
}

/**
 * Silent model failover for a rate-limited (429/retry) teammate session.
 *
 * ZERO-NOISE MANDATE (HARNESS-13): the lead is NEVER woken from this path —
 * not on switch, not on suppression, and NOT on chain exhaustion. A switch is
 * a DB update plus a log line; exhaustion returns the "exhausted" decision so
 * the wiring layer (index.ts) toasts the user. The lead re-syncs from the
 * board/system-prompt on its own next turn — a wake per exhausted member
 * flooded the lead exactly when its attention was already needed elsewhere.
 *
 * MEMBER vs. NON-MEMBER/LEAD SEAM:
 *   - MEMBER sessions (registry hit): the chain comes from
 *     `resolveFallbackChainForAgent(config, team_member.agent)` — the
 *     agent's `fallbackModelsByAgent` override, else the global chain. The
 *     switch persists to `team_member.model`, so every subsequent delivery
 *     path (team_message, watchdog, standby wake) picks up the fallback.
 *   - NON-MEMBER sessions (registry miss) — e.g. the Diana isolated
 *     blind-review session, convoked outside team_spawn and never present in
 *     team_member — and LEAD sessions (HARNESS-15 A: `lead_session_id` of an
 *     active team, which is likewise absent from team_member) go through
 *     handleIsolatedSessionFailover: they fail over ONLY when
 *     `fallbackModelsByAgent` carries an explicit chain for the session's
 *     agent (the global chain NEVER hijacks unrelated sessions — for the
 *     lead it never sequesters). No DB row exists to persist to (and a lead
 *     switch must NEVER write team_member/team), so the advanced model is
 *     re-discovered from `session.model` on the next retry, and the cooldown
 *     is keyed `isolated:${sessionId}`. The lead is never woken from this
 *     path; "exhausted" is returned as a decision so the wiring layer can
 *     toast the user.
 *
 * Mechanics:
 *   1. Registry lookup decides the SEAM — non-members and lead sessions fall
 *      through to the isolated path instead of a hard no-op.
 *   2. Shutdown-bound members never fail over (they are leaving anyway).
 *   3. Cooldown (FAILOVER_BURST_DEBOUNCE_MS) deduplicates one burst's retry
 *      attempts into ONE action; the server keeps retrying the in-flight
 *      request with the old model — the switch arms every SUBSEQUENT
 *      delivery (team_message, standby wake, watchdog re-prompt) with the
 *      fallback, because all delivery paths read team_member.model.
 *      TICKET-HARNESS-53: past that short debounce the decision is
 *      MODEL-AWARE (evaluateFailoverCooldown) — a 429 on the freshly applied
 *      fallback advances the ladder immediately; only an exhausted chain is
 *      re-suppressed for the full FAILOVER_COOLDOWN_MS.
 *   4. selectNextFallback walks the config chain forward; landing on
 *      undefined means exhaustion — log + decision only, the lead is not
 *      woken (HARNESS-13).
 *
 * Never throws — safe to call from event handlers.
 */
export async function handleRetryModelFailover(
  db: Database,
  registry: MemberRegistry,
  client: PluginClient,
  config: Required<EnsembleConfig>,
  sessionId: string,
  retryPayload?: RetryStatusPayload,
): Promise<ModelFailoverDecision | undefined> {
  const entry = registry.getBySession(sessionId)
  if (!entry) {
    // SEAM: non-member (isolated) session — e.g. Diana's blind-review session.
    return handleIsolatedSessionFailover(db, client, config, sessionId, retryPayload)
  }

  const team = db.query("SELECT status FROM team WHERE id = ?").get(entry.teamId) as { status: string } | null
  if (!team || team.status !== "active") return undefined

  const member = db.query("SELECT model, status, agent FROM team_member WHERE team_id = ? AND name = ?")
    .get(entry.teamId, entry.memberName) as { model: string | null; status: string; agent: string | null } | null
  if (!member) return undefined
  if (member.status === "shutdown" || member.status === "shutdown_requested" || member.status === "error") {
    return undefined
  }

  const cooldownKey = `${entry.teamId}:${entry.memberName}`
  const now = Date.now()
  // TICKET-RELEASE-10 (F2): a DETERMINISTIC model-resolution failure
  // (ProviderModelNotFound / "Model not found: ...") is not a burst echo that
  // can recover on retry — it must advance the chain even while the rate-limit
  // cooldown would otherwise suppress. The dedicated gate still dedupes one
  // burst and never restarts at chain[0] (§5.1 loop guard).
  // TICKET-RELEASE-11 (Frente B): a PAYWALL / out-of-quota failure
  // ("Subscribe to OpenCode Go") is likewise deterministic unutilizability —
  // same cooldown-bypass, PLUS the rung is ledgered dead for the ROOM so no
  // subsequent failover pass (this member's or any peer's) can select it.
  const paywall = isPaywallFailure(retryPayload)
  const deterministic = isModelResolutionFailure(retryPayload) || paywall
  const failReason = paywall ? "paywall" : deterministic ? "model-not-found" : "rate-limit"
  const failedModel = deterministic
    ? (extractFailedModelSelector(retryPayload) ?? member.model)
    : member.model
  // Frente B: ledger the dead rung BEFORE the walk (room scope = teamId — one
  // billing quota is shared by the whole room). The switch below runs over the
  // filtered chain, so the dead rung is never selected and never persisted into
  // team_member.model again ("NUNCA persistir / NUNCA re-selecionar").
  if (paywall) {
    recordPaywallDeadRung(entry.teamId, failedModel ?? member.model)
  }
  // TICKET-HARNESS-53: model-aware gate. A residual retry event of the burst
  // that was just aborted is suppressed (FAILOVER_BURST_DEBOUNCE_MS), but a
  // 429 on the fallback model that was JUST applied advances the ladder
  // immediately instead of freezing the member for FAILOVER_COOLDOWN_MS.
  const gate = deterministic
    ? evaluateDeterministicFailover(cooldownKey, failedModel, now)
    : evaluateFailoverCooldown(cooldownKey, member.model, now)
  if (gate.verdict === "suppressed") {
    log(`failover:suppressed member=${entry.memberName} remaining_ms=${gate.remainingMs} reason=${failReason}`)
    return {
      action: "suppressed",
      memberName: entry.memberName,
      teamId: entry.teamId,
      fromModel: member.model,
      reason: failReason,
    }
  }

  // Per-agent chain: the member's agent (team_member.agent, e.g. "diana")
  // selects its `fallbackModelsByAgent` override; agents without an override
  // fall back to the global chain (resolveFallbackChainForAgent delegates).
  const chain = resolveFallbackChainForAgent(config, member.agent)
  // Frente B: the walk runs over the USABLE chain only — every rung whose
  // model identity is ledgered dead for this room is dropped up front, so the
  // ladder can neither restart at a dead rung nor land on one mid-walk.
  const usableChain = filterChainAgainstPaywallLedger(chain, getPaywallDeadRungs(entry.teamId))
  // Deterministic failures use the strictly-forward, identity-aware walk: the
  // provider cites the base model while the applied rung carries a variant, so
  // the rate-limit walk (variant-carrying key) would re-pick the dead rung.
  const next = deterministic
    ? selectDeterministicNextFallback(
      usableChain,
      collectDeadSelectors(failedModel, member.model, gate.walkFrom, failoverActions.get(cooldownKey)?.toModel ?? null),
    )
    : selectNextFallback(usableChain, gate.walkFrom)
  if (!next) {
    // HARNESS-13 zero-noise: exhaustion does NOT wake the lead — no
    // notifyLead, no team_message. Log + decision only: the wiring layer
    // (index.ts) toasts the user, and the lead re-syncs from the board on
    // its own next turn (update config / respawn is a board-visible act).
    recordFailoverAction(cooldownKey, now, member.model, null, true)
    const detail = retryPayload?.action?.message ?? retryPayload?.message ?? "rate limited"
    const chainDesc = chain.map(formatModelSelector).join(" -> ") || "empty"
    log(`failover:exhausted member=${entry.memberName} model=${member.model ?? "default"} chain=[${chainDesc}] reason=${failReason} detail=${detail}`)
    return {
      action: "exhausted",
      memberName: entry.memberName,
      teamId: entry.teamId,
      fromModel: member.model,
      reason: failReason,
    }
  }

  // `next` comes from `usableChain` (ledger-filtered) — the switch below can
  // therefore NEVER persist a paywall-dead rung into team_member.model
  // (Frente B invariant), regardless of which walk selected it.
  const toSelector = formatModelSelector(next)
  db.run(
    "UPDATE team_member SET model = ?, time_updated = ? WHERE team_id = ? AND name = ?",
    [toSelector, now, entry.teamId, entry.memberName],
  )
  recordFailoverAction(cooldownKey, now, member.model, toSelector, false)
  log(`failover:switched member=${entry.memberName} from=${member.model ?? "default"} to=${toSelector} reason=${failReason} (silent — lead not woken)`)

  // 1. Cancel in-flight HTTP request controller
  const cancelled = abortInflight(sessionId)
  log(`failover:abort-inflight member=${entry.memberName} session=${sessionId} cancelled=${cancelled}`)

  // 2. Actively abort the native OpenCode HTTP retry backoff loop
  if (typeof client.session?.abort === "function") {
    try {
      await client.session.abort({ sessionID: sessionId })
    } catch (err) {
      log(`failover:abort:failed member=${entry.memberName} session=${sessionId} err=${err instanceof Error ? err.message : String(err)}`)
    }
  }

  // 3. Promptly resume the teammate's turn with the new fallback model
  const parsedModel = parseModelSelector(toSelector)
  if (typeof client.session?.promptAsync === "function") {
    try {
      await client.session.promptAsync({
        sessionID: sessionId,
        parts: [
          {
            type: "text",
            text: paywall
              ? `[System: Provider paywall/out-of-quota blocked "${failedModel ?? member.model ?? "the current model"}". Switched to ${toSelector}. Resume your assigned task.]`
              : deterministic
                ? `[System: Model "${failedModel ?? "unknown"}" was not found by the provider. Switched to ${toSelector}. Resume your assigned task.]`
                : `[System: Rate limit encountered on previous model. Switched to ${toSelector}. Resume your assigned task.]`,
          },
        ],
        // Agent EXPLICIT (Diana achado 2 — BLOCKING): omitting `agent` makes
        // the OpenCode server assume its default agent ("dante") and
        // OVERWRITE session.agent — a persona sequester that corrupted
        // tales-tests/tales/tulio/clara sessions live. team_member.agent is
        // NOT NULL (issue #28); the truthiness guard is defence in depth for
        // legacy rows only.
        ...(member.agent ? { agent: member.agent } : {}),
        ...(parsedModel ? { model: parsedModel } : {}),
        synthetic: true,
      })
    } catch (err) {
      log(`failover:promptAsync:failed member=${entry.memberName} session=${sessionId} err=${err instanceof Error ? err.message : String(err)}`)
    }
  }

  return {
    action: "switched",
    memberName: entry.memberName,
    teamId: entry.teamId,
    fromModel: member.model,
    toModel: toSelector,
    reason: failReason,
  }
}

/** Structural shape of the fields this path reads off a session.get() payload. */
interface IsolatedSessionInfo {
  agent?: unknown
  model?: { providerID?: unknown; id?: unknown; variant?: unknown }
}

/**
 * Failover for a NON-MEMBER (isolated) or LEAD session — the other side of
 * the member vs. non-member SEAM documented on handleRetryModelFailover.
 *   - Isolated non-members: e.g. the Diana isolated blind-review session,
 *     convoked outside team_spawn, never present in team_member, so
 *     `registry.getBySession` misses and there is no DB row to persist a
 *     model switch into.
 *   - LEAD sessions (HARNESS-15 A): the `lead_session_id` of an active team
 *     is likewise absent from team_member. A rate-limited lead gets the same
 *     rescue under STRICTER rules (see 1a-1d below).
 *
 * Rules:
 *   1. Lead sessions (HARNESS-15 A) participate — under stricter rules:
 *      a. ONLY when `fallbackModelsByAgent[agent]` carries an EXPLICIT
 *         chain — the global chain NEVER sequesters the lead;
 *      b. the lead's agent is preserved on the relaunch promptAsync
 *         (Diana achado 2 — never omitted, or the server rebinds the
 *         session to its default agent);
 *      c. ZERO board writes — no team_member/team row is touched; the
 *         switch is ephemeral and re-discovered from session.model on the
 *         next retry;
 *      d. if agent discovery fails entirely, the plugin's known lead agent
 *         (`team.lead_agent`, Migration 5) is used; still unresolved →
 *         no-op.
 *   2. Agent discovery: `retryPayload.agent` (caller hint, no round-trip)
 *      first, then `client.session.get({sessionID}).data.agent` (V2 Session
 *      field), then — LEAD sessions only — `team.lead_agent`. The same
 *      session.get call yields `data.model` (the session's currently bound
 *      model), which feeds selectNextFallback so the chain walks FORWARD
 *      across bursts. Missing session.get or agent → no-op.
 *   3. An EXPLICIT non-empty `fallbackModelsByAgent[agent]` chain is
 *      REQUIRED. The global fallback chain never applies here — hijacking an
 *      unrelated session's model (or the lead's) would be a side effect
 *      nobody configured. Absent chain → no-op (zero-noise preserved).
 *   4. The SAME active cycle as members: selectNextFallback over the current
 *      model → abortInflight + client.session.abort → promptAsync with the
 *      next model AND the explicit agent (synthetic). Zero-noise: the lead
 *      is NEVER woken (HARNESS-13); "exhausted" is returned as a decision so
 *      the wiring layer (index.ts) can toast the user.
 *   5. Cooldown reuses the model-aware gate of the member path with the key
 *      `isolated:${sessionId}` — one action per burst (FAILOVER_BURST_DEBOUNCE_MS),
 *      then immediate ladder advancement on a 429 of the applied fallback
 *      (TICKET-HARNESS-53).
 *
 * Never throws — safe to call from event handlers.
 */
async function handleIsolatedSessionFailover(
  db: Database,
  client: PluginClient,
  config: Required<EnsembleConfig>,
  sessionId: string,
  retryPayload?: RetryStatusPayload,
): Promise<ModelFailoverDecision | undefined> {
  // Lead-session detection (HARNESS-15 A): a lead owning an active team is
  // NOT an isolated subagent, but it may still fail over through this
  // board-free path — ONLY with an explicit fallbackModelsByAgent chain
  // (checked below; the global chain NEVER sequesters the lead).
  const leadTeam = db.query("SELECT id, lead_agent FROM team WHERE lead_session_id = ? AND status = 'active'")
    .get(sessionId) as { id: string; lead_agent: string | null } | null
  const scope = leadTeam ? "lead" : "isolated"

  // Agent discovery: caller hint first, then session.get (V2 Session.agent),
  // then — LEAD sessions only — the agent the plugin already knows for the
  // lead (team.lead_agent, Migration 5). session.get is also the source of
  // the CURRENT bound model even when the agent hint already resolved —
  // selectNextFallback needs it to walk the chain forward across bursts.
  // Without it (V1 client / failed get), the chain head is used
  // (selectNextFallback(chain, null)).
  let agent = typeof retryPayload?.agent === "string" && retryPayload.agent ? retryPayload.agent : undefined
  let currentModel: string | null = null
  if (typeof client.session?.get === "function") {
    try {
      const res = await client.session.get({ sessionID: sessionId })
      const info = (res as { data?: IsolatedSessionInfo } | undefined)?.data
      if (!agent && typeof info?.agent === "string" && info.agent) agent = info.agent
      if (
        currentModel === null
        && info?.model && typeof info.model.providerID === "string" && typeof info.model.id === "string"
      ) {
        // Defence in depth (Diana achado 1): the server reports variant
        // "default" for a model with NO variant — never build a selector
        // ending in "#default", or the chain walk restarts at chain[0] on
        // every retry (config.ts VARIANT_ABSENT_SENTINEL contract).
        const rawVariant = typeof info.model.variant === "string" ? info.model.variant.trim() : ""
        const variant = rawVariant && rawVariant !== "default" ? rawVariant : undefined
        currentModel = variant ? `${info.model.providerID}/${info.model.id}#${variant}` : `${info.model.providerID}/${info.model.id}`
      }
    } catch (err) {
      log(`failover:${scope}:session-get:failed session=${sessionId} err=${err instanceof Error ? err.message : String(err)}`)
    }
  }
  // Lead last resort (HARNESS-15 A rule 1d): the plugin's known lead agent.
  if (!agent && leadTeam?.lead_agent) agent = leadTeam.lead_agent
  if (!agent) return undefined

  // Explicit per-agent chain REQUIRED — the global chain never applies here
  // (for a lead this is the HARNESS-15 A anti-hijack guarantee).
  const selectors = config.fallbackModelsByAgent?.[agent]
  if (!Array.isArray(selectors) || selectors.length === 0) {
    log(`failover:${scope}:skipped session=${sessionId} agent=${agent} (no fallbackModelsByAgent chain)`)
    return undefined
  }
  const chain = resolveFallbackChainForAgent(config, agent)
  if (chain.length === 0) return undefined

  const cooldownKey = `isolated:${sessionId}`
  const now = Date.now()
  // TICKET-RELEASE-10 (F2): deterministic model-resolution failures advance
  // the ladder through the dedicated gate (the rate-limit cooldown must never
  // freeze them). A lead/isolated session still requires the EXPLICIT
  // per-agent chain checked above — the global chain never sequesters it.
  // TICKET-RELEASE-11 (Frente B): a PAYWALL / out-of-quota failure is likewise
  // deterministic, and the dead rung is ledgered for the SESSION scope
  // (`isolated:${sessionId}` — no team row exists to share a room ledger).
  const paywall = isPaywallFailure(retryPayload)
  const deterministic = isModelResolutionFailure(retryPayload) || paywall
  const failReason = paywall ? "paywall" : deterministic ? "model-not-found" : "rate-limit"
  const failedModel = deterministic
    ? (extractFailedModelSelector(retryPayload) ?? currentModel)
    : currentModel
  if (paywall) {
    recordPaywallDeadRung(cooldownKey, failedModel ?? currentModel)
  }
  // TICKET-HARNESS-53: same model-aware gate as the member path (this one
  // covers the Lead and Diana's isolated blind-review session — fixing only
  // the member path would leave both stuck on the second 429).
  const gate = evaluateFailoverCooldown(cooldownKey, currentModel, now)
  // F2: the deterministic gate REPLACES the rate-limit verdict for a
  // model-resolution failure; it never disables the gate above for 429s.
  const effectiveGate = deterministic
    ? evaluateDeterministicFailover(cooldownKey, failedModel, now)
    : gate
  if (effectiveGate.verdict === "suppressed") {
    log(`failover:suppressed ${scope} session=${sessionId} agent=${agent} remaining_ms=${effectiveGate.remainingMs} reason=${failReason}`)
    return {
      action: "suppressed",
      memberName: agent,
      teamId: "",
      fromModel: currentModel,
      reason: failReason,
    }
  }

  // Frente B: the walk runs over the USABLE chain only — ledgered dead rungs
  // are dropped up front, so the isolated/lead ladder can never re-select a
  // rung the paywall already proved unusable for this session.
  const usableChain = filterChainAgainstPaywallLedger(chain, getPaywallDeadRungs(cooldownKey))
  const next = deterministic
    ? selectDeterministicNextFallback(
      usableChain,
      collectDeadSelectors(failedModel, currentModel, effectiveGate.walkFrom, failoverActions.get(cooldownKey)?.toModel ?? null),
    )
    : selectNextFallback(usableChain, effectiveGate.walkFrom)
  if (!next) {
    // Chain exhausted — surface the decision so the wiring layer can toast.
    // HARNESS-13 zero-noise: the lead is NEVER woken from a failover path.
    recordFailoverAction(cooldownKey, now, currentModel, null, true)
    const chainDesc = chain.map(formatModelSelector).join(" -> ") || "empty"
    log(`failover:exhausted ${scope} session=${sessionId} agent=${agent} model=${currentModel ?? "default"} chain=[${chainDesc}] reason=${failReason}`)
    return {
      action: "exhausted",
      memberName: agent,
      teamId: "",
      fromModel: currentModel,
      reason: failReason,
    }
  }

  // `next` comes from `usableChain` (ledger-filtered) — never a paywall-dead
  // rung (Frente B invariant).
  const toSelector = formatModelSelector(next)
  recordFailoverAction(cooldownKey, now, currentModel, toSelector, false)
  log(`failover:switched ${scope} session=${sessionId} agent=${agent} from=${currentModel ?? "default"} to=${toSelector} reason=${failReason} (silent — lead not woken)`)

  // Same active cycle as the member path: cancel in-flight, abort the native
  // retry backoff, then relaunch the turn on the next model.
  const cancelled = abortInflight(sessionId)
  log(`failover:abort-inflight ${scope} session=${sessionId} cancelled=${cancelled}`)

  if (typeof client.session?.abort === "function") {
    try {
      await client.session.abort({ sessionID: sessionId })
    } catch (err) {
      log(`failover:abort:failed ${scope} session=${sessionId} err=${err instanceof Error ? err.message : String(err)}`)
    }
  }

  const parsedModel = parseModelSelector(toSelector)
  if (typeof client.session?.promptAsync === "function") {
    try {
      await client.session.promptAsync({
        sessionID: sessionId,
        parts: [
          {
            type: "text",
            text: paywall
              ? `[System: Provider paywall/out-of-quota blocked "${failedModel ?? currentModel ?? "the current model"}". Switched to ${toSelector}. Resume your assigned task.]`
              : deterministic
                ? `[System: Model "${failedModel ?? "unknown"}" was not found by the provider. Switched to ${toSelector}. Resume your assigned task.]`
                : `[System: Rate limit encountered on previous model. Switched to ${toSelector}. Resume your assigned task.]`,
          },
        ],
        // Agent EXPLICIT (Diana achado 2 — BLOCKING, HARNESS-15 A rule 1b):
        // omitting `agent` makes the server assume its default agent
        // ("dante") and OVERWRITE session.agent — persona sequester. `agent`
        // is guaranteed non-empty here (discovery guard above returned
        // otherwise).
        agent,
        ...(parsedModel ? { model: parsedModel } : {}),
        synthetic: true,
      })
    } catch (err) {
      log(`failover:promptAsync:failed ${scope} session=${sessionId} err=${err instanceof Error ? err.message : String(err)}`)
    }
  }

  return {
    action: "switched",
    memberName: agent,
    teamId: "",
    fromModel: currentModel,
    toModel: toSelector,
    reason: failReason,
  }
}

/**
 * TICKET-RELEASE-10 (F2) — REACTIVE failover for a DETERMINISTIC
 * model-resolution failure (`ProviderModelNotFoundError` / "Model not found:
 * ...") surfaced as a `session.error` event.
 *
 * Why this seam exists: `session.error` used to only notify the lead ("had a
 * session error"), so a member spawned on a model the provider does not serve
 * died on its first turn while the fallback chain — which the config already
 * carries — was never walked. Rate limits go through the `retry` status path;
 * a nonexistent model does not retry, so it needs this entry point.
 *
 * Mechanics:
 *   1. Only deterministic model-resolution errors are intercepted; every
 *      other error returns undefined and the caller keeps the generic alarm.
 *   2. The member/isolated split is delegated to handleRetryModelFailover with
 *      a synthetic retry payload carrying the deterministic signature. That
 *      reuses the exact same chain resolution, §5.1 normalization (no
 *      chain[0] restart loop), member-only `team_member.model` persistence,
 *      abort + resume cycle, and HARNESS-13 zero-noise policy.
 *   3. EXHAUSTION is ACTIONABLE but NEVER wakes the lead: the message is
 *      persisted via sendMessage (delivered=0, passive channel — NOT
 *      notifyLead/forceWake) plus a user-visible toast that names the failed
 *      model and the chain, so the fix (edit ensemble.json / respawn) is
 *      obvious without interrupting the orchestrator.
 *
 * Never throws — safe to await from an event handler.
 */
export async function handleModelNotFoundSessionError(
  db: Database,
  registry: MemberRegistry,
  client: PluginClient,
  config: Required<EnsembleConfig>,
  sessionId: string | undefined,
  error: SessionErrorPayload | undefined,
): Promise<ModelFailoverDecision | undefined> {
  if (!sessionId || !error) return undefined
  if (isAbortError(error)) return undefined
  if (!isModelResolutionFailure(error)) return undefined

  const failedModel = extractFailedModelSelector(error) ?? null
  const decision = await handleRetryModelFailover(db, registry, client, config, sessionId, {
    attempt: 0,
    // Join every text field so the detection in the retry seam sees the same
    // signature (name "ProviderModelNotFoundError" AND the "Model not found"
    // message), whichever one the helper keys on.
    message: modelErrorTexts(error).join(" | ") || "Model not found",
    next: Date.now(),
  })

  if (decision?.action !== "exhausted") return decision

  // ACTIONABLE exhaustion. HARNESS-13: the lead is NEVER woken from a failover
  // path — persist passively (delivered=0) and toast the user.
  const teamInfo = findTeamBySession(db, registry, sessionId)
  // The chain belongs to the AGENT, not to the member name: member "bia" with
  // agent "diana" must report diana's per-agent chain, never the global one.
  // Isolated/lead decisions already carry the agent in `memberName`.
  const chainAgent = teamInfo?.memberName
    ? (db.query("SELECT agent FROM team_member WHERE team_id = ? AND name = ?")
      .get(teamInfo.teamId, teamInfo.memberName) as { agent: string | null } | null)?.agent ?? decision.memberName
    : decision.memberName
  const chain = resolveFallbackChainForAgent(config, chainAgent)
  const chainDesc = chain.map(formatModelSelector).join(" -> ") || "empty"
  const failedLabel = failedModel ?? decision.fromModel ?? "the configured model"
  // Human-readable diagnosis only — the persistence below is the parameterized
  // INSERT inside sendMessage (src/messaging.ts), never a composed statement.
  // The remedy sentence is pre-computed and deliberately uses "Fix", so no
  // prose token ever sits next to a template interpolation.
  const chainLabel = chainDesc
  const remedy = "Fix ensemble.json (modelsByAgent / defaultModel / fallbackModels) to a model the provider actually serves, then respawn the teammate."
  const text =
    `${describeModelNotFound(error)} Fallback chain for "${decision.memberName}" is exhausted ` +
    `[${chainLabel}]. ${remedy}`

  if (teamInfo) {
    try {
      sendMessage(db, { teamId: teamInfo.teamId, from: "system", to: "lead", content: text })
    } catch (err) {
      log(`failover:model-not-found:persist:failed session=${sessionId} err=${err instanceof Error ? err.message : String(err)}`)
    }
  }
  log(`failover:model-not-found:exhausted session=${sessionId} member=${decision.memberName} model=${failedLabel} chain=[${chainDesc}]`)
  try {
    await client.tui.showToast({
      title: "Team",
      message: `Model "${failedLabel}" not found — no fallback left for ${decision.memberName}. Fix ensemble.json and respawn.`,
      variant: "error",
      duration: 8000,
    })
  } catch (err) {
    // NOT silent: a host without a TUI must not block the failover, but the
    // suppressed notification stays observable in the log.
    log(`failover:model-not-found:toast:failed session=${sessionId} err=${err instanceof Error ? err.message : String(err)}`)
  }

  return decision
}
