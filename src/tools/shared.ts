import type { ToolDeps } from "../types"
import { findTeamBySession } from "../types"
import { runCommand } from "../process"
import type { Database } from "../db"
import { log } from "../log"

/**
 * Consume the standby window of a member in standby mode.
 *
 * Supports both:
 * 1. Birth Standby (`team_spawn` with `standby: true`):
 *    The member was never prompted at birth — the complete initialization
 *    prompt lives in `team_member.spawn_context` (Migration 11). The first
 *    delivery prepends this context so the teammate knows its role and peers.
 * 2. Runtime Standby (`team_standby`):
 *    The member voluntarily suspended execution at runtime. `spawn_context` is
 *    NULL so the wake delivery sends the bare unblock/message text directly.
 *
 * TICKET-RELEASE-11 (Frente C) — SHARED-CHECKOUT SINGLE-WRITER GATE
 * (OPT-IN, `config.sharedCheckoutSingleWriter`, default FALSE):
 *
 * The standby wake is a BLINDADA invariant (Blindagem 1 / AGENTS.md §2):
 * a message is NEVER authorization-of-write, so the wake is NEVER blocked by
 * another member being busy/running — that inference was vetoed by the
 * Quality Gate (Clara) after it regressed three historical suites and could
 * deadlock production wakes behind a lead that stays busy.
 *
 * With the OPT-IN flag ON, the gate defers ONLY on REAL, FORMAL write
 * contention, measured exclusively by the persisted baton — the `assignee`
 * of an `in_progress` card — never by `status='busy'`:
 *   - the wake target must HOLD at least one `in_progress` card (a write
 *     stakeholder: waking them means effective write is coming);
 *   - AND another member of the SAME shared checkout (`worktree_dir IS NULL`)
 *     must also HOLD `in_progress` card(s) — their baton was not released
 *     (not completed, not handed over via team_task_handover, not returned
 *     to the pool).
 * When the gate trips, the wake is refused (`blocked: true`, no window
 * consumption, no spawn_context prepend): the row stays `delivered=0` and is
 * replayed by the MULTI-TRIGGER sweep (re-send of team_message/broadcast,
 * the writer's idle event, card completion via team_tasks_complete, and the
 * init recovery pass) — never dependent on the idle event alone.
 * Members WITH a worktree and cardless (coordination) wakes bypass entirely.
 *
 * Returns:
 * - `text`: `spawn_context` prepended to `baseText` when present, otherwise `baseText`;
 * - `woke`: true only for the atomic transition `standby` -> `starting`;
 * - `agent`: the member's agent type;
 * - `blocked`: true only when the OPT-IN gate refused the wake (callers MUST
 *   skip `promptAsync` entirely and leave the row `delivered=0` — waking with
 *   bare `baseText` would be an amnesia wake).
 */
export function resolveStandbyWake(
  db: Database,
  teamId: string,
  memberName: string,
  baseText: string,
  singleWriterGate = false,
): { text: string; woke: boolean; agent?: string; blocked?: boolean } {
  const row = db.query(
    "SELECT agent, execution_status, spawn_context, worktree_dir FROM team_member WHERE team_id = ? AND name = ?"
  ).get(teamId, memberName) as { agent: string; execution_status: string; spawn_context: string | null; worktree_dir: string | null } | null

  if (!row || row.execution_status !== "standby") {
    // Pass-through: no agent either, so callers keep their existing delivery
    // payload byte-identical for members that were spawned the normal way.
    return { text: baseText, woke: false }
  }

  // Frente C (OPT-IN): formal-baton contention — checked BEFORE the atomic
  // window consumption so a refused wake leaves execution_status untouched.
  // The baton is the persisted `assignee` of an `in_progress` card; member
  // status is NEVER consulted (a busy member without a card never blocks).
  if (singleWriterGate && row.worktree_dir === null) {
    const targetHoldsCard = db.query(
      "SELECT id FROM team_task WHERE team_id = ? AND assignee = ? AND status = 'in_progress' LIMIT 1"
    ).get(teamId, memberName)
    if (targetHoldsCard) {
      const otherBatonHolder = db.query(
        `SELECT tm.name FROM team_member tm
         WHERE tm.team_id = ? AND tm.name != ?
           AND tm.worktree_dir IS NULL
           AND EXISTS (
             SELECT 1 FROM team_task tt
             WHERE tt.team_id = tm.team_id AND tt.assignee = tm.name AND tt.status = 'in_progress'
           )
         LIMIT 1`
      ).get(teamId, memberName) as { name: string } | null
      if (otherBatonHolder) {
        log(`standby:wake:blocked-shared-checkout member=${memberName} team=${teamId} other_baton=${otherBatonHolder.name} — dual card-holder wake deferred (formal baton, opt-in gate)`)
        return { text: baseText, woke: false, blocked: true }
      }
    }
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
  log(`standby:wake member=${memberName} team=${teamId} context=${context ? `${context.length} chars` : "none"} runtime=${!context}`)
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
