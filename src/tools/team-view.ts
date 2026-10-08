import type { ToolDeps } from "../types"
import { requireTeamMember } from "./shared"

/**
 * Execute the team_view tool. Resolves a teammate's session; navigates the
 * TUI to it ONLY when navigate: true is passed — an agent must never hijack
 * the user's client unprompted. Default behavior reports where the session
 * is so the user can open it themselves (ctrl+p).
 */
export async function executeTeamView(
  deps: ToolDeps,
  args: { member: string; navigate?: boolean },
  sessionId: string,
): Promise<string> {
  const teamInfo = requireTeamMember(deps, sessionId)

  const member = deps.db.query("SELECT session_id, status, agent FROM team_member WHERE team_id = ? AND name = ?")
    .get(teamInfo.teamId, args.member) as { session_id: string; status: string; agent: string } | null
  if (!member) throw new Error(`Teammate "${args.member}" not found in team "${teamInfo.teamName}"`)

  if (args.navigate !== true) {
    return `${args.member}'s session: ${member.session_id} (status: ${member.status}, agent: ${member.agent}). Open it from the session picker (ctrl+p) — or ask to view it and I'll switch for you.`
  }

  try {
    await deps.client.tui.selectSession({ sessionID: member.session_id })
    return `Switched to ${args.member}'s session. Use the session picker (ctrl+p) to return.`
  } catch {
    return `Could not switch to ${args.member}'s session (${member.session_id}). The session may not be accessible from the TUI.`
  }
}
