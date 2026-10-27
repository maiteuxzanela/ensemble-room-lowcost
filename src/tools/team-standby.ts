import type { Database } from "../db"
import type { ToolDeps } from "../types"
import { requireTeamMember } from "./shared"
import { incrementStandbyLoop, resetStandbyLoop, scheduleStandbyAbort, STANDBY_LOOP_LIMIT } from "../standby-guard"
import { log } from "../log"

export interface TeamStandbyArgs {
  reason?: string
}

/**
 * Suspend a teammate's execution voluntarily into standby mode.
 * Transitions execution_status to 'standby' and status to 'ready'.
 * Clears spawn_context to ensure clean runtime wake without replaying birth prompts.
 */
export function setMemberStandby(
  db: Database,
  teamId: string,
  memberName: string,
  reason?: string,
): void {
  const result = db.run(
    "UPDATE team_member SET execution_status = 'standby', status = 'ready', spawn_context = NULL, time_updated = ? WHERE team_id = ? AND name = ?",
    [Date.now(), teamId, memberName]
  )
  if (result.changes === 0) {
    throw new Error(`Member "${memberName}" not found in team`)
  }
  log(`member:standby name=${memberName} team=${teamId}${reason ? ` reason=${reason}` : ""}`)
}

/**
 * Execute the team_standby tool.
 * Allows an active teammate to suspend their execution voluntarily.
 * Rejects if called by team lead or outside of a team.
 */
export async function executeTeamStandby(
  deps: ToolDeps,
  args: TeamStandbyArgs,
  sessionId: string,
): Promise<string> {
  const teamInfo = requireTeamMember(deps, sessionId)
  if (teamInfo.role === "lead") {
    throw new Error("Only teammates can enter standby mode")
  }
  const memberName = teamInfo.memberName
  if (!memberName) {
    throw new Error("Unknown member name for session")
  }

  // TICKET-RELEASE-17 (F2): consecutive-call alarm, strictly scoped to
  // team_standby. Every other tool call (and every new turn) resets this count
  // via noteToolCall()/resetStandbyLoop() — see src/standby-guard.ts.
  const consecutive = incrementStandbyLoop(sessionId)
  const loopBroken = consecutive >= STANDBY_LOOP_LIMIT

  setMemberStandby(deps.db, teamInfo.teamId, memberName, args.reason)

  if (loopBroken) {
    log(`standby:loop-breaker member=${memberName} team=${teamInfo.teamId} count=${consecutive}`)
    // Re-arm: the next legitimate wake starts a fresh chain (and the aborted
    // session must not be killed again on its very next call).
    resetStandbyLoop(sessionId)
  }

  // TICKET-RELEASE-17 (F1): the runtime — not the model — ends the caller's
  // turn. Deferred to the next macrotask so the tool result is already
  // persisted; the abort is marked intentional and absorbed by the
  // anti-abort filter in hooks.ts (member stays ready/standby, never error).
  scheduleStandbyAbort(
    deps.client,
    sessionId,
    loopBroken ? `loop-breaker count=${consecutive}` : "team_standby",
  )

  const reasonStr = args.reason ? ` (reason: ${args.reason})` : ""
  if (loopBroken) {
    return `Entered standby mode${reasonStr}. Repetition breaker fired after ${consecutive} consecutive team_standby calls — the runtime has aborted this turn.`
  }
  return `Entered standby mode${reasonStr}. Execution suspended until a new message arrives.`
}
