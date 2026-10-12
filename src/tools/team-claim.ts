import type { Database } from "../db"
import type { ToolDeps } from "../types"
import { requireTeamMember } from "./shared"

export interface ClaimTaskResult {
  content: string
  status: "in_progress" | "blocked"
  isBlocked: boolean
  alreadyInProgress?: boolean
}

/**
 * Atomically claim a pending or blocked task for an assignee.
 * - If the task is 'pending', sets status to 'in_progress' and records assignee.
 * - If the task is 'blocked', sets assignee with atomic pre-claim lock while
 *   keeping status 'blocked'.
 * - If caller is already the assignee, handles idempotency gracefully:
 *   * status 'blocked' -> returns standby directive
 *   * status 'pending' -> updates to 'in_progress' atomically and returns success
 *   * status 'in_progress' -> returns success (already under their responsibility)
 * Throws if the task is missing, claimed by someone else, or neither pending nor blocked.
 */
export function claimTask(db: Database, teamId: string, taskId: string, assignee: string): ClaimTaskResult {
  const task = db.query("SELECT content, status, assignee FROM team_task WHERE id = ? AND team_id = ?")
    .get(taskId, teamId) as { content: string; status: string; assignee: string | null } | null
  if (!task) throw new Error(`Task "${taskId}" not found`)

  // Idempotency: when the task is already assigned to the caller
  if (task.assignee === assignee) {
    if (task.status === "blocked") {
      return { content: task.content, status: "blocked", isBlocked: true }
    }
    if (task.status === "pending") {
      const result = db.run(
        "UPDATE team_task SET status = 'in_progress', time_updated = ? WHERE id = ? AND team_id = ? AND status = 'pending' AND assignee = ?",
        [Date.now(), taskId, teamId, assignee]
      )
      if (result.changes === 0) {
        const current = db.query("SELECT status FROM team_task WHERE id = ? AND team_id = ?")
          .get(taskId, teamId) as { status: string } | null
        if (current?.status === "in_progress") {
          return { content: task.content, status: "in_progress", isBlocked: false, alreadyInProgress: true }
        }
        throw new Error(`Task "${taskId}" could not be claimed (status: ${current?.status ?? "unknown"})`)
      }
      return { content: task.content, status: "in_progress", isBlocked: false }
    }
    if (task.status === "in_progress") {
      return { content: task.content, status: "in_progress", isBlocked: false, alreadyInProgress: true }
    }
    throw new Error(`Task "${taskId}" cannot be claimed (status: ${task.status})`)
  }

  if (task.assignee) throw new Error(`Task "${taskId}" is already claimed by ${task.assignee}`)

  if (task.status === "blocked") {
    // Atomic pre-claim lock for blocked task: keep status 'blocked', record assignee
    const result = db.run(
      "UPDATE team_task SET assignee = ?, time_updated = ? WHERE id = ? AND team_id = ? AND status = 'blocked' AND assignee IS NULL",
      [assignee, Date.now(), taskId, teamId]
    )
    if (result.changes === 0) {
      throw new Error(`Task "${taskId}" is already claimed (race condition)`)
    }
    return { content: task.content, status: "blocked", isBlocked: true }
  }

  if (task.status !== "pending") throw new Error(`Task "${taskId}" is not pending (status: ${task.status})`)

  // Atomic claim: UPDATE only if still pending and unassigned
  const result = db.run(
    "UPDATE team_task SET status = 'in_progress', assignee = ?, time_updated = ? WHERE id = ? AND team_id = ? AND status = 'pending' AND assignee IS NULL",
    [assignee, Date.now(), taskId, teamId]
  )

  if (result.changes === 0) {
    throw new Error(`Task "${taskId}" is already claimed (race condition)`)
  }

  return { content: task.content, status: "in_progress", isBlocked: false }
}

/**
 * Execute the team_claim tool. Atomically claims a pending or blocked task.
 * For blocked tasks, pre-claims with atomic lock and returns an instructional
 * yield/standby directive instead of throwing a raw exception.
 */
export async function executeTeamClaim(
  deps: ToolDeps,
  args: { task_id: string },
  sessionId: string,
): Promise<string> {
  const teamInfo = requireTeamMember(deps, sessionId)

  const claimerName = teamInfo.role === "lead" ? "lead" : (teamInfo.memberName ?? "unknown")
  const result = claimTask(deps.db, teamInfo.teamId, args.task_id, claimerName)

  if (result.isBlocked) {
    return `Pre-claimed blocked task "${args.task_id}": "${result.content}". This task is blocked by unresolved dependencies. Stop execution and enter standby (yield) via team_standby — the runtime will automatically wake you when dependencies resolve.`
  }

  if (result.alreadyInProgress) {
    return `Task "${args.task_id}" is already in progress and assigned to you: "${result.content}".`
  }

  return `Claimed task: ${result.content}`
}
