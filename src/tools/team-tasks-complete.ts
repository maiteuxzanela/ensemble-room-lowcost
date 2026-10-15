import type { ToolDeps } from "../types"
import { requireTeamMember, resolveStandbyWake } from "./shared"
import { getMemberModel } from "../member-model"
import { inReviewNudges } from "../hooks"
import { isQAMember, getTeamQAMember } from "../qa-role"
import { promptModelAwareWake } from "../notify"
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
 * - action='reject' (or status='in_progress' when in_review): in_review -> in_progress (QA reviewer/lead only)
 * - action='complete' (default): completed
 *   * If task is 'in_review', ONLY the Quality Gate reviewer (qa-role.ts) or 'lead' can complete it.
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

  // Quality Gate reviewer (agnostic: is_qa flag / clara retrocompat) — resolved
  // once and reused by the submit/reject/complete paths below instead of
  // hardcoding the literal "clara" (see qa-role.ts contract).
  const qaMember = getTeamQAMember(deps.db, teamInfo.teamId)
  const qaLabel = qaMember?.name ?? "the Quality Gate reviewer"

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

    // Reset in-review nudge cooldown for the QA reviewer when a task is submitted or resubmitted for review
    if (qaMember) inReviewNudges.delete(`${teamInfo.teamId}:${qaMember.name}:${args.task_id}`)

    // Auto-wake the Quality Gate reviewer for review if present in team and not caller
    let qaNotified = false
    if (qaMember && !isQAMember(deps.db, teamInfo.teamId, caller)) {
      if (qaMember.sessionId) {
        deps.db.run(
          "UPDATE team_member SET reported_to_lead = 0, time_updated = ? WHERE team_id = ? AND name = ?",
          [now, teamInfo.teamId, qaMember.name],
        )

        const baseWakeText = `[System: Task "${args.task_id}" was submitted for review by ${caller}${notes ? ` (notes: ${notes})` : ""}]`
        let promptText = baseWakeText
        let promptAgent: string | undefined = qaMember.agent

        if (qaMember.executionStatus === "standby") {
          const wake = resolveStandbyWake(deps.db, teamInfo.teamId, qaMember.name, baseWakeText)
          if (wake.woke) {
            promptText = wake.text
            promptAgent = wake.agent ?? qaMember.agent
          }
        }

        const qaModel = getMemberModel(deps.db, teamInfo.teamId, qaMember.name)
        deps.client.session.promptAsync({
          sessionID: qaMember.sessionId,
          parts: [{ type: "text", text: promptText }],
          agent: promptAgent,
          synthetic: true,
          ...(qaModel ? { model: qaModel } : {}),
        }).catch((err) => {
          if (qaMember.executionStatus === "standby") {
            deps.db.run(
              "UPDATE team_member SET execution_status = 'standby', time_updated = ? WHERE team_id = ? AND name = ? AND execution_status = 'starting'",
              [Date.now(), teamInfo.teamId, qaMember.name],
            )
          }
          log(`tasks-complete:wake-clara:failed err=${String(err)}`)
        })
        log(`tasks-complete:wake-clara:ok task=${args.task_id} sessionID=${qaMember.sessionId}`)
        qaNotified = true
      }
    }

    return `Submitted task for review: ${task.content}${notes ? ` (notes: ${notes})` : ""}${qaNotified ? ` (notified ${qaMember?.name} for review)` : ""}`
  }

  // Flow 2: Reject review (in_review -> in_progress)
  const isReject = args.action === "reject" || args.action === "reject_review" || (task.status === "in_review" && (args.action === "in_progress" || args.status === "in_progress"))
  if (isReject) {
    if (task.status !== "in_review") {
      throw new Error(`Task "${args.task_id}" is not in review (current status: ${task.status})`)
    }
    if (teamInfo.role !== "lead" && !isQAMember(deps.db, teamInfo.teamId, caller)) {
      throw new Error(`Only ${qaLabel} or the team lead can reject tasks in review`)
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

  // Guardiã lock: if task is in_review, only the QA reviewer or Lead can approve and complete
  if (task.status === "in_review") {
    if (teamInfo.role !== "lead" && !isQAMember(deps.db, teamInfo.teamId, caller)) {
      throw new Error(`Task "${args.task_id}" is in review; only ${qaLabel} or the team lead can complete it`)
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
        // HARNESS-16: one snapshot BEFORE resolveStandbyWake — session delivery
        // target, explicit agent for non-standby wakes, and the pre-consumption
        // execution_status for observability (agent is immutable per member).
        const memberRow = deps.db.query("SELECT session_id, agent, execution_status FROM team_member WHERE team_id = ? AND name = ?")
          .get(teamInfo.teamId, wakeTarget) as { session_id: string; agent: string; execution_status: string } | null
        const memberSessionId = memberRow?.session_id

        if (memberSessionId) {
          const baseText = `[System: Task "${t.id}" was unblocked and is ready for you to start]`
          const wake = resolveStandbyWake(deps.db, teamInfo.teamId, wakeTarget, baseText)

          if (wake.woke) {
            // Standby consumed: spawn_context prepend + standby → starting
            // transition (existing path, byte-compatible payload).
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
          } else if (wakeTarget === t.assignee) {
            // HARNESS-16 UNCONDITIONAL: the board advanced (blocked → in_progress)
            // but a PRE-ASSIGNED owner that is ready/idle/busy was never woken —
            // resolveStandbyWake only reports woke for the standby consume, so
            // the owner slept while its status flipped → silent deadlock (T8).
            // Wake ALWAYS: explicit agent + member model first rung on the T6
            // model-aware ladder (step-down on rejection), synthetic system
            // prompt. No standby revert here: this branch never consumed the
            // standby window (a lost race means another delivery is already
            // in flight with the spawn_context prepend).
            try {
              const memberModel = getMemberModel(deps.db, teamInfo.teamId, wakeTarget)
              const primaryModel = memberModel
                ? `${memberModel.providerID}/${memberModel.modelID}${memberModel.variant ? `#${memberModel.variant}` : ""}`
                : undefined
              promptModelAwareWake(deps.client, {
                sessionID: memberSessionId,
                text: baseText,
                logTag: `tasks-complete:wake-member team=${teamInfo.teamId} member=${wakeTarget}`,
                agent: memberRow.agent || undefined,
                config: deps.config,
                ...(primaryModel ? { primaryModel } : {}),
              })
              log(`tasks-complete:wake-member:ok member=${wakeTarget} task=${t.id} state=${memberRow.execution_status} unconditional=true`)
              wokeMembers++
            } catch (err) {
              log(`tasks-complete:wake-member:failed member=${wakeTarget} err=${err instanceof Error ? err.message : String(err)}`)
            }
          }
          // else: standby-candidate fallback WITHOUT pre-assignment keeps the
          // legacy gate — silent unless resolveStandbyWake consumed the window.
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
    // team_broadcast uses to address the lead (never a team_member session).
    const leadRow = deps.db.query("SELECT lead_session_id FROM team WHERE id = ?")
      .get(teamInfo.teamId) as { lead_session_id?: string | null } | null
    const leadSessionId = leadRow?.lead_session_id
    if (leadSessionId) {
      // F1 / HARNESS-15 B: under silentLead:true this is the ONLY wake that
      // reaches the lead — a modelless promptAsync rides the session's
      // primary (the rate-limited gemini) and board closure was stranded at
      // delivered=0. Model-aware via the shared ladder: explicit agent from
      // team.lead_agent + resolveFallbackChainForAgent(config, leadAgent)
      // with step-down on rejection (same logic as notifyLead).
      const agentRow = deps.db.query("SELECT lead_agent FROM team WHERE id = ?")
        .get(teamInfo.teamId) as { lead_agent?: string | null } | null
      try {
        promptModelAwareWake(deps.client, {
          sessionID: leadSessionId,
          text: `[System: All team tasks completed on board by ${who}]`,
          logTag: `tasks-complete:wake-lead team=${teamInfo.teamId}`,
          agent: agentRow?.lead_agent || undefined,
          config: deps.config,
        })
        log(`tasks-complete:wake-lead:sent leadSession=${leadSessionId} by=${who}`)
      } catch (err) {
        // Fail-safe: a synchronous ladder/parse defect must never fail the
        // board-complete tool call itself — log and continue.
        log(`tasks-complete:wake-lead:failed team=${teamInfo.teamId} err=${err instanceof Error ? err.message : String(err)}`)
      }
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
