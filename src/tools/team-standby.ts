import type { Database } from "../db"
import type { ToolDeps } from "../types"
import { requireTeamMember } from "./shared"
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

  setMemberStandby(deps.db, teamInfo.teamId, memberName, args.reason)

  const reasonStr = args.reason ? ` (reason: ${args.reason})` : ""
  return `Entered standby mode${reasonStr}. Execution suspended until a new message arrives.`
}
