import type { ToolDeps } from "../types"
import { requireTeamMember, resolveStandbyWake } from "./shared"
import { getMemberModel } from "../member-model"
import { log } from "../log"

export interface TeamTasksCompleteArgs {
  task_id: string
  action?: "complete" | "submit_review" | "reject" | string
  status?: string
  notes?: string
  review_notes?: string
}

/**
 * Execute the team_tasks_complete tool. Marks a task as completed
 * and unblocks any dependent tasks.
 *
 * Supports cyclic review transitions:
 * - action='submit_review' (or status='in_review'): in_progress -> in_review
 * - action='reject' (or status='in_progress' when in_review): in_review -> in_progress (Clara/lead only)
 * - action='complete' (default): completed
 *   * If task is 'in_review', ONLY 'clara' or 'lead' can complete it (Guardiã Clara lock).
 *
 * Enforces task-board accuracy:
 * - Rejects completing an already-completed or cancelled task.
 * - Rejects completing a blocked task (dependencies must resolve first).
 * - Only the assignee (or the lead) may complete a claimed task.
 * - Completing an unclaimed task attributes it to the caller atomically.
 */
export async function executeTeamTasksComplete(
  deps: ToolDeps,
  args: TeamTasksCompleteArgs,
  sessionId: string,
): Promise<string> {
  const teamInfo = requireTeamMember(deps, sessionId)
  const caller = teamInfo.role === "lead" ? "lead" : (teamInfo.memberName ?? "unknown")

  const task = deps.db.query("SELECT id, content, status, assignee, rejection_count, review_notes FROM team_task WHERE id = ? AND team_id = ?")
    .get(args.task_id, teamInfo.teamId) as { id: string; content: string; status: string; assignee: string | null; rejection_count: number; review_notes: string | null } | null
  if (!task) throw new Error(`Task "${args.task_id}" not found`)

  const now = Date.now()
  const notes = args.review_notes ?? args.notes ?? null

  // Flow 1: Submit to review (in_progress -> in_review)
  const isSubmitReview = args.action === "submit_review" || args.action === "in_review" || args.status === "in_review"
  if (isSubmitReview) {
    if (task.status === "completed") throw new Error(`Task "${args.task_id}" is already completed`)
    if (task.status === "cancelled") throw new Error(`Task "${args.task_id}" was cancelled`)
    if (task.status === "blocked") throw new Error(`Task "${args.task_id}" is blocked by unresolved dependencies`)
    if (task.status === "in_review") throw new Error(`Task "${args.task_id}" is already in review`)
    if (task.assignee && teamInfo.role !== "lead" && caller !== task.assignee) {
      throw new Error(`Task "${args.task_id}" is claimed by ${task.assignee}`)
    }
    const assignee = task.assignee ?? caller
    deps.db.run(
      "UPDATE team_task SET status = 'in_review', assignee = ?, review_notes = ?, time_updated = ? WHERE id = ?",
      [assignee, notes ?? task.review_notes ?? null, now, args.task_id],
    )
    return `Submitted task for review: ${task.content}${notes ? ` (notes: ${notes})` : ""}`
  }

  // Flow 2: Reject review (in_review -> in_progress)
  const isReject = args.action === "reject" || args.action === "reject_review" || (task.status === "in_review" && (args.action === "in_progress" || args.status === "in_progress"))
  if (isReject) {
    if (task.status !== "in_review") {
      throw new Error(`Task "${args.task_id}" is not in review (current status: ${task.status})`)
    }
    if (teamInfo.role !== "lead" && caller !== "clara") {
      throw new Error(`Only clara or the team lead can reject tasks in review`)
    }
    const newRejectionCount = (task.rejection_count ?? 0) + 1
    deps.db.run(
      "UPDATE team_task SET status = 'in_progress', rejection_count = ?, review_notes = ?, time_updated = ? WHERE id = ?",
      [newRejectionCount, notes, now, args.task_id],
    )
    return `Rejected task: ${task.content} (rejection #${newRejectionCount})${notes ? ` - ${notes}` : ""}`
  }

  // Flow 3: Complete task (-> completed)
  if (task.status === "completed") throw new Error(`Task "${args.task_id}" is already completed`)
  if (task.status === "cancelled") throw new Error(`Task "${args.task_id}" was cancelled`)
  if (task.status === "blocked") throw new Error(`Task "${args.task_id}" is blocked by unresolved dependencies`)

  // Guardiã Clara lock: if task is in_review, only Clara or Lead can approve and complete
  if (task.status === "in_review") {
    if (teamInfo.role !== "lead" && caller !== "clara") {
      throw new Error(`Task "${args.task_id}" is in review; only clara or the team lead can complete it`)
    }
  } else if (task.status === "in_progress" && task.assignee && teamInfo.role !== "lead" && caller !== task.assignee) {
    throw new Error(`Task "${args.task_id}" is claimed by ${task.assignee}`)
  }

  if (task.assignee) {
    deps.db.run("UPDATE team_task SET status = 'completed', time_updated = ? WHERE id = ?", [now, args.task_id])
  } else {
    // Attribute an unclaimed task to the caller so the board reflects who did it.
    const result = deps.db.run(
      "UPDATE team_task SET status = 'completed', assignee = ?, time_updated = ? WHERE id = ? AND assignee IS NULL",
      [caller, now, args.task_id]
    )
    if (result.changes === 0) {
      throw new Error(`Task "${args.task_id}" was just completed by another teammate`)
    }
  }

  // Unblock dependent tasks
  const allTasks = deps.db.query("SELECT id, depends_on, status, assignee FROM team_task WHERE team_id = ?")
    .all(teamInfo.teamId) as Array<{ id: string; depends_on: string | null; status: string; assignee: string | null }>

  let unblocked = 0
  let wokeMembers = 0
  for (const t of allTasks) {
    if (t.status !== "blocked" || !t.depends_on) continue
    const depIds: string[] = JSON.parse(t.depends_on)
    if (!depIds.includes(args.task_id)) continue

    const allResolved = depIds.every(depId => {
      if (depId === args.task_id) return true
      const dep = allTasks.find(d => d.id === depId)
      return dep && (dep.status === "completed" || dep.status === "cancelled")
    })

    if (allResolved) {
      const nextStatus = t.assignee ? "in_progress" : "pending"
      deps.db.run("UPDATE team_task SET status = ?, time_updated = ? WHERE id = ?", [nextStatus, now, t.id])
      unblocked++

      // Wake target: the pre-assigned assignee or an unassigned standby teammate
      let wakeTarget = t.assignee
      if (!wakeTarget) {
        const standbyCandidate = deps.db.query(`
          SELECT name FROM team_member
          WHERE team_id = ? AND execution_status = 'standby'
          AND name NOT IN (
            SELECT assignee FROM team_task
            WHERE team_id = ? AND assignee IS NOT NULL AND status IN ('in_progress', 'in_review', 'blocked')
          )
          ORDER BY time_updated ASC LIMIT 1
        `).get(teamInfo.teamId, teamInfo.teamId) as { name: string } | null
        if (standbyCandidate) {
          wakeTarget = standbyCandidate.name
        }
      }

      if (wakeTarget) {
        const memberRow = deps.db.query("SELECT session_id FROM team_member WHERE team_id = ? AND name = ?")
          .get(teamInfo.teamId, wakeTarget) as { session_id: string } | null
        const memberSessionId = memberRow?.session_id

        if (memberSessionId) {
          const wake = resolveStandbyWake(deps.db, teamInfo.teamId, wakeTarget, `[System: Task "${t.id}" was unblocked and is ready for you to start]`)
          if (wake.woke) {
            const memberModel = getMemberModel(deps.db, teamInfo.teamId, wakeTarget)
            deps.client.session.promptAsync({
              sessionID: memberSessionId,
              parts: [{ type: "text", text: wake.text }],
              agent: wake.agent,
              synthetic: true,
              ...(memberModel ? { model: memberModel } : {})
            }).catch(err => {
              deps.db.run(
                "UPDATE team_member SET execution_status = 'standby', time_updated = ? WHERE team_id = ? AND name = ? AND execution_status = 'starting'",
                [Date.now(), teamInfo.teamId, wakeTarget]
              )
              log(`tasks-complete:wake-member:failed member=${wakeTarget} err=${String(err)}`)
            })
            log(`tasks-complete:wake-member:ok member=${wakeTarget} task=${t.id}`)
            wokeMembers++
          }
        }
      }
    }
  }

  // Fire progress toast so the lead has visibility
  const counts = deps.db.query(
    "SELECT status, COUNT(*) as c FROM team_task WHERE team_id = ? GROUP BY status"
  ).all(teamInfo.teamId) as Array<{ status: string; c: number }>
  const completed = counts.find(r => r.status === "completed")?.c ?? 0
  // DEF-2 (deadlock do board wake): `total` conta apenas tarefas não canceladas.
  // Com `cancelled` dentro do denominador, `completed === total` fica inalcançável
  // e o lead nunca é acordado — o board trava em silêncio permanente.
  const total = counts.reduce((sum, r) => (r.status === "cancelled" ? sum : sum + r.c), 0)
  // Tarefas ainda ativas = pending | in_progress | in_review | blocked. Com o total acima
  // restrito a esses mesmos status + completed, `activeRemaining === 0` é
  // equivalente a `completed === total` (defesa em profundidade explícita).
  const activeRemaining = counts.reduce(
    (sum, r) => (r.status === "pending" || r.status === "in_progress" || r.status === "in_review" || r.status === "blocked" ? sum + r.c : sum),
    0,
  )
  const who = teamInfo.memberName ?? "teammate"
  try {
    deps.client.tui.showToast({
      title: "Team",
      message: `${who}: ${completed}/${total} tasks complete`,
      variant: "info",
      duration: 3000,
    }).catch(() => { /* TUI may not be available */ })
  } catch { log(`tasks-complete:toast:failed`) }

  // Systematic board wake (silent-lead design): when the last active task on the
  // board flips to completed, wake the lead session with a synthetic system prompt.
  // While silentLead is active the lead receives no text-message prompts, so
  // board closure is the one event that must reach them.
  // DEF-2: cancelled tasks no longer block this — `total` excludes them and
  // `activeRemaining === 0` guarantees no pending/in_progress/blocked work is left.
  if (total > 0 && completed === total && activeRemaining === 0) {
    // NOTE: team_member has no `role` column (see schema.ts) — the lead's
    // session id lives on team.lead_session_id, the same canonical source
    // team_broadcast uses to address the lead.
    const lead = deps.db.query("SELECT lead_session_id FROM team WHERE id = ?")
      .get(teamInfo.teamId) as { lead_session_id: string } | null
    if (lead?.lead_session_id) {
      deps.client.session.promptAsync({
        sessionID: lead.lead_session_id,
        parts: [{ type: "text", text: `[System: All team tasks completed on board by ${who}]` }],
        synthetic: true,
      }).catch(err => { log(`tasks-complete:wake-lead:failed err=${String(err)}`) })
      log(`tasks-complete:wake-lead:sent leadSession=${lead.lead_session_id} by=${who}`)
    }
  }

  let unblockedMsg = ""
  if (unblocked > 0) {
    unblockedMsg = ` (unblocked ${unblocked} task${unblocked !== 1 ? "s" : ""}`
    if (wokeMembers > 0) {
      unblockedMsg += `, woke ${wokeMembers} member${wokeMembers !== 1 ? "s" : ""}`
    }
    unblockedMsg += ")"
  }
  return `Completed task: ${task.content}${unblockedMsg}`
}

export async function executeTeamTasksReview(
  deps: ToolDeps,
  args: { task_id: string; notes?: string; review_notes?: string },
  sessionId: string,
): Promise<string> {
  return executeTeamTasksComplete(deps, { ...args, action: "submit_review" }, sessionId)
}

export async function executeTeamTasksReject(
  deps: ToolDeps,
  args: { task_id: string; notes?: string; review_notes?: string },
  sessionId: string,
): Promise<string> {
  return executeTeamTasksComplete(deps, { ...args, action: "reject" }, sessionId)
}
