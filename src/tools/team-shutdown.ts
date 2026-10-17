import type { ToolDeps } from "../types"
import { requireLead, checkWorktreeDirty, countBranchCommits } from "./shared"
import type { IsDirtyFn, CommitCountFn } from "./shared"
import { getTeamResourceParts, preserveBranch, preservedBranchName } from "./merge-helper"
import type { PreserveBranchFn, MergeBranchFn, DeleteBranchFn, OverlapCheckFn } from "./merge-helper"
import { releaseMemberTasks } from "../tasks"
import { executeTeamCleanup } from "./team-cleanup"
import { log } from "../log"

/**
 * Arguments for the unified team_shutdown lifecycle tool.
 *
 * `member` is optional: a specific name keeps the legacy single-teammate
 * shutdown, while omitting it (or passing "*"/"all") shuts down/aborts every
 * active teammate in parallel and then runs the full room cleanup — the
 * responsibilities formerly split across team_shutdown + team_cleanup.
 */
export interface TeamShutdownArgs {
  /** Specific teammate to shut down. Omit — or pass "*"/"all" — to shut down and clean up the whole team. */
  member?: string
  /** Force immediate abort instead of waiting for current work to finish. */
  force?: boolean
  /** Acknowledge uncommitted worktree changes and proceed with full-team shutdown/cleanup. */
  acknowledge_uncommitted?: boolean
  /** Archived team names to permanently delete, or ["*"] for all archived teams (admin purge). */
  purge?: string[]
  /** Set true only after the user explicitly approves the purge preview. */
  confirm_purge?: boolean
  /** Confirmation token from the purge preview. */
  confirm_token?: string
}

/** Column shape of the team_member rows the lifecycle routines read. */
interface MemberRow {
  name: string
  session_id: string
  status: string
  worktree_dir: string | null
  worktree_branch: string | null
  workspace_id: string | null
}

/** Sentinel member values that mean "the entire room". */
const WILDCARD_MEMBERS = new Set(["*", "all"])

/**
 * Execute the unified team_shutdown tool — the canonical lifecycle contact point.
 *
 * - `member` is a specific name → legacy single-teammate shutdown.
 * - `member` omitted or "*"/"all" → shut down/abort every active/standby member
 *   in parallel (Promise.allSettled), then run the full room cleanup (merge
 *   safety net, worktree/workspace teardown, archive in SQLite).
 * - `purge` given → administrative purge of archived teams (delegated to the
 *   cleanup routine's purge path, which still requires explicit approval).
 *
 * Before aborting any teammate, the worktree branch is preserved to a safe ref
 * so session.abort() cannot destroy the agent's committed work.
 */
export async function executeTeamShutdown(
  deps: ToolDeps,
  args: TeamShutdownArgs,
  sessionId: string,
  isDirty: IsDirtyFn = checkWorktreeDirty,
  preserve: PreserveBranchFn = preserveBranch,
  commitCount: CommitCountFn = countBranchCommits,
  merge: MergeBranchFn | undefined = undefined,
  delBranch: DeleteBranchFn | undefined = undefined,
  mergeOnCleanup = true,
  overlapCheck: OverlapCheckFn | undefined = undefined,
): Promise<string> {
  // Administrative purge of archived teams — delegate to the cleanup core, which
  // enforces the archived-target + human-approval rules.
  if (args.purge && args.purge.length > 0) {
    return executeTeamCleanup(
      deps,
      {
        force: args.force ?? false,
        acknowledge_uncommitted: args.acknowledge_uncommitted,
        purge: args.purge,
        confirm_purge: args.confirm_purge,
        confirm_token: args.confirm_token,
      },
      sessionId,
    )
  }

  const teamInfo = requireLead(deps, sessionId)

  const requested = args.member?.trim() ?? ""
  if (requested === "" || WILDCARD_MEMBERS.has(requested.toLowerCase())) {
    return shutdownWholeTeam(deps, teamInfo, args, sessionId, isDirty, preserve, merge, delBranch, mergeOnCleanup, overlapCheck)
  }

  // ---- Legacy single-member shutdown ----
  const member = deps.db.query("SELECT session_id, status, worktree_branch, worktree_dir FROM team_member WHERE team_id = ? AND name = ?")
    .get(teamInfo.teamId, requested) as { session_id: string; status: string; worktree_branch: string | null; worktree_dir: string | null } | null
  if (!member) throw new Error(`Teammate "${requested}" not found in team "${teamInfo.teamName}"`)
  if (member.status === "shutdown") throw new Error(`Teammate "${requested}" is already shut down`)

  const force = args.force ?? false

  // Second call on an already-requested member → force abort
  if (member.status === "shutdown_requested") {
    await preserveAndAbort(deps, teamInfo.teamId, requested, member.session_id, member.worktree_branch, preserve)
    const status = await getBranchStatus(deps, teamInfo.teamId, requested, member.worktree_dir, isDirty, commitCount)
    return `Force shut down "${requested}".${status}`
  }

  // Determine if member is idle or busy
  let isIdle = false
  try {
    const statuses = await deps.client.session.status()
    const sessionStatus = statuses.data?.[member.session_id]
    isIdle = !sessionStatus || sessionStatus.type === "idle"
  } catch {
    // Status poll failed — assume busy, fall through to graceful path
  }

  if (isIdle || force) {
    await preserveAndAbort(deps, teamInfo.teamId, requested, member.session_id, member.worktree_branch, preserve)
    const status = await getBranchStatus(deps, teamInfo.teamId, requested, member.worktree_dir, isDirty, commitCount)
    return `Teammate "${requested}" has been shut down.${status}`
  }

  // Busy + not force → graceful: preserve branch first, then send shutdown message
  // Branch must be preserved NOW — if the session crashes during shutdown_requested,
  // the worktree and branch could be lost before force-abort ever runs.
  if (member.worktree_branch) {
    const resource = getTeamResourceParts(deps.db, teamInfo.teamId)
    const safeBranch = preservedBranchName(resource.projectName, resource.teamName, resource.teamId, requested)
    const ok = await preserve(member.worktree_branch, safeBranch, deps.directory)
    if (ok) {
      deps.db.run(
        "UPDATE team_member SET worktree_branch = ? WHERE team_id = ? AND name = ?",
        [safeBranch, teamInfo.teamId, requested],
      )
      log(`shutdown:branch:preserved-graceful src=${member.worktree_branch} target=${safeBranch}`)
    }
  }

  try {
    deps.client.session.promptAsync({
      sessionID: member.session_id,
      parts: [{
        type: "text",
        text: `[Shutdown requested]: The lead has requested you shut down. Finish your current task, send your final findings to the lead via team_message, then stop.`,
      }],
    }).catch(() => { /* fire-and-forget */ })
  } catch {
    // promptAsync failed — best effort
  }

  deps.db.run(
    "UPDATE team_member SET status = 'shutdown_requested', time_updated = ? WHERE team_id = ? AND name = ?",
    [Date.now(), teamInfo.teamId, requested],
  )

  return `Shutdown requested for ${requested}. They will finish current work and shut down. Call team_shutdown with force: true to abort immediately.`
}

/**
 * Shut down/abort every active member of the room in parallel, then run the
 * full cleanup (absorbing team_cleanup): merge safety net, worktree/workspace
 * teardown and archive in SQLite.
 */
async function shutdownWholeTeam(
  deps: ToolDeps,
  teamInfo: { teamId: string; teamName: string },
  args: TeamShutdownArgs,
  sessionId: string,
  isDirty: IsDirtyFn,
  preserve: PreserveBranchFn,
  merge: MergeBranchFn | undefined,
  delBranch: DeleteBranchFn | undefined,
  mergeOnCleanup: boolean,
  overlapCheck: OverlapCheckFn | undefined,
): Promise<string> {
  const members = deps.db.query(
    "SELECT name, session_id, status, worktree_dir, worktree_branch, workspace_id FROM team_member WHERE team_id = ?",
  ).all(teamInfo.teamId) as MemberRow[]

  const active = members.filter(m => m.status !== "shutdown" && m.status !== "error")

  // Safety: refuse to wipe uncommitted worktree work unless the lead acknowledges it.
  if (!args.acknowledge_uncommitted && active.length > 0) {
    const dirty: Array<{ name: string; branch: string }> = []
    for (const member of active) {
      if (!member.worktree_dir) continue
      try {
        if (await isDirty(member.worktree_dir)) dirty.push({ name: member.name, branch: member.worktree_branch ?? "unknown" })
      } catch {
        log(`shutdown-all:dirty-check:failed name=${member.name}`)
      }
    }
    if (dirty.length > 0) {
      const warnings = dirty.map(d => `  - ${d.name} (branch: ${d.branch})`).join("\n")
      return `Warning: ${dirty.length} teammate(s) have uncommitted changes in their worktrees:\n${warnings}\n\nCommit or merge their work first, then call team_shutdown with acknowledge_uncommitted: true to shut down and clean up the whole team.`
    }
  }

  // Shut down and abort every active member in parallel — one failure never
  // blocks the others.
  const settled = await Promise.allSettled(
    active.map(member => preserveAndAbort(deps, teamInfo.teamId, member.name, member.session_id, member.worktree_branch, preserve)),
  )
  const failed = settled
    .map((result, i) => result.status === "rejected"
      ? `${active[i]!.name}: ${result.reason instanceof Error ? result.reason.message : String(result.reason)}`
      : null)
    .filter((value): value is string => value !== null)

  // Every member is shut down now — run the full cleanup (merge safety net,
  // worktree/workspace teardown, archive). Uncommitted work was guarded above.
  const cleanupResult = await executeTeamCleanup(
    deps,
    { force: false, acknowledge_uncommitted: true },
    sessionId,
    isDirty,
    merge,
    delBranch,
    mergeOnCleanup,
    overlapCheck,
  )

  const parts: string[] = []
  if (active.length > 0) {
    parts.push(`Shut down ${active.length} teammate(s): ${active.map(m => m.name).join(", ")}.`)
  } else {
    parts.push("No active teammates to shut down.")
  }
  if (failed.length > 0) parts.push(`Failed to shut down: ${failed.join("; ")}.`)
  parts.push(cleanupResult)
  return parts.join("\n")
}

/**
 * Preserve the worktree branch, then abort the session and mark shutdown.
 * The branch is copied to ensemble/preserved/{team_id}/{name} BEFORE abort,
 * so session.abort() cannot destroy the agent's committed work.
 */
async function preserveAndAbort(
  deps: ToolDeps,
  teamId: string,
  memberName: string,
  sessionId: string,
  worktreeBranch: string | null,
  preserve: PreserveBranchFn,
): Promise<void> {
  // Preserve the branch BEFORE aborting — session.abort() may delete the worktree + branch
  if (worktreeBranch && !worktreeBranch.startsWith("ensemble/preserved/")) {
    const resource = getTeamResourceParts(deps.db, teamId)
    const safeBranch = preservedBranchName(resource.projectName, resource.teamName, resource.teamId, memberName)
    const ok = await preserve(worktreeBranch, safeBranch, deps.directory)
    if (ok) {
      deps.db.run(
        "UPDATE team_member SET worktree_branch = ? WHERE team_id = ? AND name = ?",
        [safeBranch, teamId, memberName],
      )
      log(`shutdown:branch:preserved src=${worktreeBranch} target=${safeBranch}`)
    } else {
      log(`shutdown:branch:preserve-failed src=${worktreeBranch} target=${safeBranch}`)
    }
  }

  // Now safe to abort — the branch is preserved
  try {
    await deps.client.session.abort({ sessionID: sessionId })
  } catch {
    // Abort failed — session may already be gone
  }

  deps.db.run(
    "UPDATE team_member SET status = 'shutdown', execution_status = 'idle', time_updated = ? WHERE team_id = ? AND name = ?",
    [Date.now(), teamId, memberName],
  )

  // Release any tasks this member was working — they are gone now, so their
  // in_progress work must return to the pool for another teammate (issue #27).
  const released = releaseMemberTasks(deps.db, teamId, memberName)
  if (released > 0) log(`shutdown:tasks:released name=${memberName} count=${released}`)
}

/** Build a status line describing the teammate's work: commit count, dirty state, next step. */
async function getBranchStatus(
  deps: ToolDeps,
  teamId: string,
  memberName: string,
  worktreeDir: string | null,
  isDirty: IsDirtyFn,
  commitCount: CommitCountFn,
): Promise<string> {
  const row = deps.db.query("SELECT worktree_branch FROM team_member WHERE team_id = ? AND name = ?")
    .get(teamId, memberName) as { worktree_branch: string | null } | null
  if (!row?.worktree_branch) return ""

  const branch = row.worktree_branch
  const parts: string[] = []

  const commits = await commitCount(branch, deps.directory)
  // Best-effort dirty check — worktree may already be deleted by session.abort() race
  const dirty = worktreeDir ? await isDirty(worktreeDir).catch(() => false) : false

  if (commits > 0 && dirty) {
    parts.push(`${memberName} committed ${commits} change${commits !== 1 ? "s" : ""} and has uncommitted work.`)
  } else if (commits > 0) {
    parts.push(`${memberName} committed ${commits} change${commits !== 1 ? "s" : ""}. Ready to merge.`)
  } else if (dirty) {
    parts.push(`${memberName} has uncommitted changes only — their work may be incomplete.`)
  } else if (commits < 0) {
    parts.push(`Could not determine ${memberName}'s commit status. Merge to check their work.`)
  } else {
    parts.push(`${memberName} made no changes.`)
  }

  parts.push(`Branch: ${branch}`)
  parts.push("Use team_merge to merge their work.")
  return `\n${parts.join("\n")}`
}
