import type { ToolDeps } from "../types"
import { requireTeamMember, resolveStandbyWake } from "./shared"
import { getMemberModel } from "../member-model"
import { setMemberStandby } from "./team-standby"
import { scheduleStandbyAbort } from "../standby-guard"
import { log } from "../log"

export interface TeamTaskHandoverArgs {
  task_id: string
  to: string
  notes?: string
}

/**
 * TICKET-HARNESS-48 — Intra-Card Cooperative Handover (`team_task_handover`).
 *
 * Cooperative baton pass on a SINGLE card: a specialist who owns an
 * `in_progress` task and reaches the boundary of their specialty (or simply
 * fills their context window) hands the SAME card to a complementary
 * specialist instead of grinding through work outside their expertise. This is
 * the "Parceria de Bancada Sequencial Intra-Card": specialists are born
 * together, pact interfaces, then take turns on the same card with clean
 * context windows and ZERO write contention (only one assignee at a time).
 *
 * Contract (fail-fast, no partial side effects):
 *   1. The caller must be a team member; the card must exist and be
 *      `in_progress`.
 *   2. Only the current assignee (or the team lead) may hand the card over.
 *   3. `to` must be an existing, available member of the SAME room, and must
 *      not be the caller.
 *   4. `assignee` is reassigned atomically (single UPDATE guarded by
 *      `status = 'in_progress'`); the handover notes are persisted on the card
 *      (`review_notes`) as transition context.
 *   5. The receiver is woken through `promptAsync` with their OWN agent and
 *      bound model; if the receiver is in standby, its `spawn_context` window
 *      is consumed via `resolveStandbyWake` (standby -> starting, reverted in
 *      the catch on transport failure) exactly like every other wake path.
 *   6. The transmitter (a teammate, never the lead) voluntarily enters standby
 *      via `setMemberStandby` so their context window is released.
 *
 * Returns a human-readable confirmation of the baton pass.
 */
export async function executeTeamTaskHandover(
  deps: ToolDeps,
  args: TeamTaskHandoverArgs,
  sessionId: string,
): Promise<string> {
  const teamInfo = requireTeamMember(deps, sessionId)
  const caller = teamInfo.role === "lead" ? "lead" : (teamInfo.memberName ?? "unknown")

  const taskId = args.task_id?.trim()
  if (!taskId) throw new Error("task_id is required")
  const to = args.to?.trim()
  if (!to) throw new Error("A handover target member ('to') is required")

  const task = deps.db.query(
    "SELECT id, content, status, assignee FROM team_task WHERE id = ? AND team_id = ?",
  ).get(taskId, teamInfo.teamId) as { id: string; content: string; status: string; assignee: string | null } | null
  if (!task) throw new Error(`Task "${taskId}" not found`)

  if (task.status !== "in_progress") {
    throw new Error(`Task "${taskId}" cannot be handed over (status: ${task.status}); handover requires an in_progress card`)
  }

  if (teamInfo.role !== "lead" && task.assignee !== caller) {
    throw new Error(`Only the current assignee of task "${taskId}" (${task.assignee ?? "unassigned"}) or the team lead can hand it over`)
  }

  if (to === caller) {
    throw new Error(`Cannot hand over task "${taskId}" to yourself ("${caller}")`)
  }

  const target = deps.db.query(
    "SELECT name, session_id, agent, status, execution_status FROM team_member WHERE team_id = ? AND name = ?",
  ).get(teamInfo.teamId, to) as { name: string; session_id: string; agent: string; status: string; execution_status: string } | null
  if (!target) throw new Error(`Member "${to}" not found in the room`)
  if (target.status === "shutdown" || target.status === "error") {
    throw new Error(`Member "${to}" is not available for a handover (status: ${target.status})`)
  }

  const notes = args.notes?.trim() || null
  const now = Date.now()

  // Atomic baton pass: reassign only while the card is still in_progress. The
  // guard doubles as a lost-race detector against a concurrent claim/complete.
  // COALESCE keeps any pre-existing review context (e.g. a prior rejection note)
  // when the handover carries no notes of its own.
  const updated = deps.db.run(
    "UPDATE team_task SET assignee = ?, review_notes = COALESCE(?, review_notes), time_updated = ? WHERE id = ? AND team_id = ? AND status = 'in_progress'",
    [to, notes, now, taskId, teamInfo.teamId],
  )
  if (updated.changes === 0) {
    throw new Error(`Task "${taskId}" could not be handed over (its status changed concurrently)`)
  }

  // Wake the receiver — their own persona + bound model travel on the wire, and
  // a standby receiver consumes its spawn_context window (standby -> starting).
  let notified = false
  if (target.session_id) {
    deps.db.run(
      "UPDATE team_member SET reported_to_lead = 0, time_updated = ? WHERE team_id = ? AND name = ?",
      [now, teamInfo.teamId, to],
    )

    const baseText = `[System: Task "${taskId}" was handed over to you by ${caller}${notes ? ` (notes: ${notes})` : ""} — you are now the assignee; continue the work on this card.]`
    let promptText = baseText
    let promptAgent: string | undefined = target.agent
    if (target.execution_status === "standby") {
      const wake = resolveStandbyWake(deps.db, teamInfo.teamId, to, baseText)
      if (wake.woke) {
        promptText = wake.text
        promptAgent = wake.agent ?? target.agent
      }
    }

    const model = getMemberModel(deps.db, teamInfo.teamId, to)
    deps.client.session.promptAsync({
      sessionID: target.session_id,
      parts: [{ type: "text", text: promptText }],
      agent: promptAgent,
      synthetic: true,
      ...(model ? { model } : {}),
    }).catch((err) => {
      if (target.execution_status === "standby") {
        deps.db.run(
          "UPDATE team_member SET execution_status = 'standby', time_updated = ? WHERE team_id = ? AND name = ? AND execution_status = 'starting'",
          [Date.now(), teamInfo.teamId, to],
        )
      }
      log(`task-handover:wake-failed task=${taskId} to=${to} err=${String(err)}`)
    })
    notified = true
    log(`task-handover:wake-ok task=${taskId} from=${caller} to=${to} sessionID=${target.session_id}`)
  } else {
    log(`task-handover:wake-skipped task=${taskId} to=${to} reason=no-session`)
  }

  // Voluntary standby for the transmitter: the lead never sleeps, teammates
  // release their context window until the baton returns.
  let standbySuffix = ""
  if (teamInfo.role !== "lead" && teamInfo.memberName) {
    setMemberStandby(deps.db, teamInfo.teamId, teamInfo.memberName, `handover of ${taskId} to ${to}`)
    // TICKET-RELEASE-17 (F1.3): the transmitter side gets the same deterministic
    // pause as team_standby — the runtime aborts the caller's turn after the
    // tool result is persisted, instead of trusting the model to stop. The abort
    // is marked intentional so hooks.ts absorbs the MessageAbortedError noise.
    scheduleStandbyAbort(deps.client, sessionId, `task-handover ${taskId} to ${to}`)
    standbySuffix = " You have entered standby (execution suspended) with a clean context window until the baton returns."
  }

  log(`task-handover:ok task=${taskId} from=${caller} to=${to} notified=${notified}`)
  const notifiedSuffix = notified
    ? ` (notified ${to})`
    : ` (${to} has no active session — the baton is recorded on the board)`
  return `Handed over task "${taskId}" to ${to}${notifiedSuffix}.${standbySuffix}`
}
