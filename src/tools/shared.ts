import type { ToolDeps } from "../types"
import { findTeamBySession } from "../types"
import { runCommand } from "../process"
import type { Database } from "../db"
import { log } from "../log"

/**
 * Consume the standby window of a member spawned with `standby: true`.
 *
 * A standby member exists in SQLite (`status='ready'`,
 * `execution_status='standby'`) but was never prompted at birth — the complete
 * initialization prompt lives in `team_member.spawn_context` (Migration 11).
 * The FIRST delivery to that member must re-attach it, or the teammate wakes
 * with no idea which team it belongs to, who its peers are, or what its task is.
 *
 * Returns:
 * - `text`: `spawn_context` prepended to `baseText` when THIS call consumes the
 *   standby window, otherwise `baseText` untouched;
 * - `woke`: true only for the call that performed the transition;
 * - `agent`: the member's agent, present only on wake — spawn normally passes
 *   `agent` on the first `promptAsync`, and a standby member never received
 *   one, so the wake prompt has to carry it.
 *
 * Fail-safe by construction:
 * - unknown member or not in standby → pass-through, no write;
 * - the transition is a guarded UPDATE (`... AND execution_status='standby'`),
 *   so exactly one delivery can ever consume the window — a concurrent second
 *   message sees `changes === 0` and delivers bare text instead of prepending
 *   the context twice;
 * - a NULL/blank `spawn_context` still transitions the member and just delivers
 *   the bare message rather than throwing on a missing prepend.
 */
export function resolveStandbyWake(
  db: Database,
  teamId: string,
  memberName: string,
  baseText: string,
): { text: string; woke: boolean; agent?: string } {
  const row = db.query(
    "SELECT agent, execution_status, spawn_context FROM team_member WHERE team_id = ? AND name = ?"
  ).get(teamId, memberName) as { agent: string; execution_status: string; spawn_context: string | null } | null

  if (!row || row.execution_status !== "standby") {
    // Pass-through: no agent either, so callers keep their existing delivery
    // payload byte-identical for members that were spawned the normal way.
    return { text: baseText, woke: false }
  }

  const result = db.run(
    "UPDATE team_member SET execution_status = 'starting', time_updated = ? WHERE team_id = ? AND name = ? AND execution_status = 'standby'",
    [Date.now(), teamId, memberName]
  )
  if (!result.changes) {
    // Another delivery consumed the window between the read and this write.
    log(`standby:wake:lost-race member=${memberName} team=${teamId} — delivering without prepend`)
    return { text: baseText, woke: false }
  }

  const context = row.spawn_context?.trim()
  log(`standby:wake member=${memberName} team=${teamId} context=${context ? `${context.length} chars` : "none"}`)
  return {
    text: context ? `${context}\n\n${baseText}` : baseText,
    woke: true,
    agent: row.agent,
  }
}

/** Function type for dirty worktree check — injectable for testing. */
export type IsDirtyFn = (dir: string) => Promise<boolean>

/** Function type for counting commits on a branch — injectable for testing. */
export type CommitCountFn = (branch: string, cwd: string) => Promise<number>

/** Count commits a branch has ahead of HEAD. Approximate — may include base divergence. Returns -1 if check fails. */
export async function countBranchCommits(branch: string, cwd: string): Promise<number> {
  try {
    const result = await runCommand(["git", "rev-list", "--count", `HEAD..${branch}`], { cwd })
    if (result.exitCode !== 0) return -1
    const n = Number.parseInt(result.stdout.trim(), 10)
    return Number.isNaN(n) ? -1 : n
  } catch { return -1 }
}

/** Check if a worktree directory has uncommitted changes via git status. */
export async function checkWorktreeDirty(dir: string): Promise<boolean> {
  try {
    const result = await runCommand(["git", "-C", dir, "status", "--porcelain"])
    if (result.exitCode !== 0) return false // git failed — assume clean
    return result.stdout.trim().length > 0
  } catch {
    return false // can't check — assume clean
  }
}

/** Validate that the session belongs to the team lead. Throws if not. */
export function requireLead(
  deps: Pick<ToolDeps, "db" | "registry">,
  sessionId: string,
): { teamId: string; teamName: string } {
  const teamInfo = findTeamBySession(deps.db, deps.registry, sessionId)
  if (!teamInfo) throw new Error("This session is not in a team. Use team_create first.")
  if (teamInfo.role !== "lead") throw new Error("Only the team lead can use this tool.")
  return { teamId: teamInfo.teamId, teamName: teamInfo.teamName }
}

/** Validate that the session belongs to any team member (lead or teammate). Throws if not. */
export function requireTeamMember(
  deps: Pick<ToolDeps, "db" | "registry">,
  sessionId: string,
): { teamId: string; teamName: string; role: "lead" | "member"; memberName?: string } {
  const teamInfo = findTeamBySession(deps.db, deps.registry, sessionId)
  if (!teamInfo) throw new Error("This session is not in a team.")
  return teamInfo
}

/** Validate that a session can purge archived teams. Throws if not allowed. */
export function requireCanPurgeArchivedTeams(
  deps: Pick<ToolDeps, "db" | "registry" | "tracker">,
  sessionId: string,
): void {
  const activeMembers = deps.db.query(
    `SELECT tm.session_id
     FROM team_member tm
     JOIN team t ON tm.team_id = t.id
     WHERE t.status = 'active'`
  ).all() as Array<{ session_id: string }>

  if (activeMembers.some(member => member.session_id === sessionId)) {
    throw new Error("Team members cannot purge archived teams")
  }

  const activeLeads = deps.db.query("SELECT lead_session_id FROM team WHERE status = 'active'")
    .all() as Array<{ lead_session_id: string }>

  if (deps.tracker.getParent(sessionId)) {
    throw new Error("Sub-agents cannot purge archived teams")
  }

  if (activeLeads.some(team => team.lead_session_id === sessionId)) return

  const activeTeamSessions = new Set([
    ...activeMembers.map(member => member.session_id),
    ...activeLeads.map(team => team.lead_session_id),
  ])

  if (deps.tracker.isDescendantOf(sessionId, activeTeamSessions)) {
    throw new Error("Sub-agents cannot purge archived teams")
  }
}
