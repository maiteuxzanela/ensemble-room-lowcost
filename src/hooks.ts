import type { Database } from "./db"
import type { MemberRegistry, DescendantTracker } from "./state"
import type { PluginClient } from "./types"
import type { EnsembleConfig } from "./config"
import { formatModelSelector, parseModelSelector, resolveFallbackChainForAgent, selectNextFallback } from "./config"
import { abortInflight } from "./v2-session"
import { notifyLead } from "./notify"
import { releaseMemberTasks } from "./tasks"
import { findTeamBySession } from "./types"
import { isQAMember } from "./qa-role"
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
 * the four additive retry_* columns (Fix 2) without changing `status`/
 * `execution_status` at all (Fix 1's non-goal: no FSM change).
 */
export function handleSessionStatusEvent(
  db: Database,
  registry: MemberRegistry,
  sessionId: string,
  status: "idle" | "busy" | "retry",
  retryPayload?: RetryStatusPayload,
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
    if (member.status === "ready" || member.status === "error") {
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
 * True when the member holds at least one assigned task that is still waiting
 * on dependencies — i.e. the task itself is `blocked`, or any id inside its
 * `depends_on` JSON array points at a task that is not `completed`.
 *
 * A member in this state is in *legitimate wait*: they cannot make progress
 * until someone else finishes, so silence on the board is expected and must
 * never be reported as "You completed your work...". Shared by every nudge
 * path (idle-nudge in `shouldNudgeIdleMember`, fast-idle alarm in
 * `shouldAlarmFastIdle`) so the rule lives in exactly one place.
 *
 * Fail-closed by design: malformed `depends_on` JSON, non-array payloads,
 * missing dependency rows and non-completed dependencies all count as
 * unresolved (suppress), because a false nudge is worse than a missed one.
 */
export function hasBlockedAssignedTasks(db: Database, teamId: string, memberName: string): boolean {
  const tasks = db.query(
    "SELECT status, depends_on FROM team_task WHERE team_id = ? AND assignee = ?"
  ).all(teamId, memberName) as Array<{ status: string; depends_on: string | null }>

  for (const task of tasks) {
    if (task.status === "blocked") return true
    if (!task.depends_on) continue

    let depIds: unknown
    try {
      depIds = JSON.parse(task.depends_on)
    } catch {
      return true // corrupted dependency pointer → treat as unresolved
    }
    if (!Array.isArray(depIds)) return true

    for (const depId of depIds) {
      if (typeof depId !== "string") return true
      const dep = db.query("SELECT status FROM team_task WHERE id = ? AND team_id = ?")
        .get(depId, teamId) as { status: string } | null
      // Dependency deleted or not completed yet → the assignee is still waiting.
      if (!dep || dep.status !== "completed") return true
    }
  }
  return false
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
 * (status is pending, in_progress, blocked, or in_review).
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
 * - the member owns tasks blocked on unresolved `depends_on` entries;
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

  // Waiting on the task board: silence is legitimate too.
  if (hasBlockedAssignedTasks(db, teamId, memberName)) return false

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
 * - members with assigned tasks blocked on unresolved dependencies;
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

  // Standby, dependency-blocked or review-waiting members idle immediately on purpose.
  if (member.execution_status === "standby") return false
  if (hasBlockedAssignedTasks(db, teamId, memberName)) return false
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
  if (isAbortError(error)) {
    const abortMsg = error?.data?.message ?? error?.name ?? "aborted"
    log(`session-error:aborted member=${teamInfo.memberName} team=${teamInfo.teamId} err=${abortMsg}`)
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
 * Minimum interval between failover ACTIONS (a model switch or an
 * exhausted-chain decision) for the same member. Retry events for
 * one rate-limit burst arrive attempt-after-attempt (1, 2, 3…) on the SAME
 * in-flight model — advancing the chain per attempt would burn it in
 * seconds, and acting per attempt would flood the lead. One action per
 * member per window keeps the burst silent after the first decision.
 */
export const FAILOVER_COOLDOWN_MS = 10 * 60 * 1000

/**
 * Last failover-action timestamp per `${teamId}:${memberName}`. Module-level
 * like team-spawn's spawnFailures — one decision per member per cooldown
 * window is process-wide in-memory state. Exported so deterministic suites
 * can clear/rewind it without sleeping.
 */
export const failoverCooldown = new Map<string, number>()

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
 *   3. Cooldown (FAILOVER_COOLDOWN_MS) deduplicates one burst's retry
 *      attempts into ONE action; the server keeps retrying the in-flight
 *      request with the old model — the switch arms every SUBSEQUENT
 *      delivery (team_message, standby wake, watchdog re-prompt) with the
 *      fallback, because all delivery paths read team_member.model.
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
  const lastAction = failoverCooldown.get(cooldownKey)
  if (lastAction !== undefined && now - lastAction < FAILOVER_COOLDOWN_MS) {
    log(`failover:suppressed member=${entry.memberName} remaining_ms=${FAILOVER_COOLDOWN_MS - (now - lastAction)}`)
    return { action: "suppressed", memberName: entry.memberName, teamId: entry.teamId, fromModel: member.model }
  }

  // Per-agent chain: the member's agent (team_member.agent, e.g. "diana")
  // selects its `fallbackModelsByAgent` override; agents without an override
  // fall back to the global chain (resolveFallbackChainForAgent delegates).
  const chain = resolveFallbackChainForAgent(config, member.agent)
  const next = selectNextFallback(chain, member.model)
  if (!next) {
    // HARNESS-13 zero-noise: exhaustion does NOT wake the lead — no
    // notifyLead, no team_message. Log + decision only: the wiring layer
    // (index.ts) toasts the user, and the lead re-syncs from the board on
    // its own next turn (update config / respawn is a board-visible act).
    failoverCooldown.set(cooldownKey, now)
    const detail = retryPayload?.action?.message ?? retryPayload?.message ?? "rate limited"
    const chainDesc = chain.map(formatModelSelector).join(" -> ") || "empty"
    log(`failover:exhausted member=${entry.memberName} model=${member.model ?? "default"} chain=[${chainDesc}] detail=${detail}`)
    return { action: "exhausted", memberName: entry.memberName, teamId: entry.teamId, fromModel: member.model }
  }

  const toSelector = formatModelSelector(next)
  db.run(
    "UPDATE team_member SET model = ?, time_updated = ? WHERE team_id = ? AND name = ?",
    [toSelector, now, entry.teamId, entry.memberName],
  )
  failoverCooldown.set(cooldownKey, now)
  log(`failover:switched member=${entry.memberName} from=${member.model ?? "default"} to=${toSelector} (silent — lead not woken)`)

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
            text: `[System: Rate limit encountered on previous model. Switched to ${toSelector}. Resume your assigned task.]`,
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
 *   5. Cooldown reuses FAILOVER_COOLDOWN_MS with the key
 *      `isolated:${sessionId}` — one action per burst, same as members.
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
  const lastAction = failoverCooldown.get(cooldownKey)
  if (lastAction !== undefined && now - lastAction < FAILOVER_COOLDOWN_MS) {
    log(`failover:suppressed ${scope} session=${sessionId} agent=${agent} remaining_ms=${FAILOVER_COOLDOWN_MS - (now - lastAction)}`)
    return { action: "suppressed", memberName: agent, teamId: "", fromModel: currentModel }
  }

  const next = selectNextFallback(chain, currentModel)
  if (!next) {
    // Chain exhausted — surface the decision so the wiring layer can toast.
    // HARNESS-13 zero-noise: the lead is NEVER woken from a failover path.
    failoverCooldown.set(cooldownKey, now)
    const chainDesc = chain.map(formatModelSelector).join(" -> ") || "empty"
    log(`failover:exhausted ${scope} session=${sessionId} agent=${agent} model=${currentModel ?? "default"} chain=[${chainDesc}]`)
    return { action: "exhausted", memberName: agent, teamId: "", fromModel: currentModel }
  }

  const toSelector = formatModelSelector(next)
  failoverCooldown.set(cooldownKey, now)
  log(`failover:switched ${scope} session=${sessionId} agent=${agent} from=${currentModel ?? "default"} to=${toSelector} (silent — lead not woken)`)

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
            text: `[System: Rate limit encountered on previous model. Switched to ${toSelector}. Resume your assigned task.]`,
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

  return { action: "switched", memberName: agent, teamId: "", fromModel: currentModel, toModel: toSelector }
}
