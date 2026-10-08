import type { Database } from "./db"
import type { MemberRegistry, DescendantTracker } from "./state"
import type { PluginClient } from "./types"
import { notifyLead } from "./notify"
import { releaseMemberTasks } from "./tasks"
import { findTeamBySession } from "./types"

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
 * Check if a member went idle without ever sending a message to the lead.
 * Returns true if the member is idle/ready and has no outbound messages.
 *
 * Returns false (nudge suppressed) when the silence is legitimate:
 * - `execution_status === 'standby'` — spawned paused, woken only by the first
 *   inbound `team_message` (standby spawn lifecycle);
 * - the member owns tasks blocked on unresolved `depends_on` entries.
 */
export function shouldNudgeIdleMember(db: Database, teamId: string, memberName: string): boolean {
  const member = db.query("SELECT status, execution_status FROM team_member WHERE team_id = ? AND name = ?")
    .get(teamId, memberName) as { status: string; execution_status: string } | null
  if (!member || member.status !== "ready") return false

  // Standby: silence until wake is by design, never a missed report.
  if (member.execution_status === "standby") return false

  // Waiting on the task board: silence is legitimate too.
  if (hasBlockedAssignedTasks(db, teamId, memberName)) return false

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

  // Standby or dependency-blocked members idle immediately on purpose.
  if (member.execution_status === "standby") return false
  if (hasBlockedAssignedTasks(db, teamId, memberName)) return false

  if (now - member.time_created >= 15_000) return false

  const msgCount = (db.query("SELECT COUNT(*) as c FROM team_message WHERE team_id = ? AND from_name = ?")
    .get(teamId, memberName) as { c: number }).c
  return msgCount === 0
}

/** Shape of an error attached to a session.error event. Subset of the SDK's union. */
export interface SessionErrorPayload {
  name?: string
  data?: { message?: string }
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
 */
export function handleSessionErrorEvent(
  db: Database,
  registry: MemberRegistry,
  client: PluginClient,
  sessionId: string | undefined,
  error: SessionErrorPayload | undefined,
): void {
  if (!sessionId) return
  // Use findTeamBySession so the SQLite fallback fires when this Plugin
  // instance's in-memory registry doesn't have the teammate (multi-instance
  // scenario — see findTeamBySession in src/types.ts).
  const teamInfo = findTeamBySession(db, registry, sessionId)
  if (!teamInfo || teamInfo.role !== "member" || !teamInfo.memberName) return

  const errMsg = error?.data?.message ?? error?.name ?? "unknown error"
  notifyLead(
    client,
    db,
    teamInfo.teamId,
    `Teammate "${teamInfo.memberName}" had a session error: ${errMsg}. Check their session for details. They may be stuck and need investigation or shutdown.`,
  )
}
