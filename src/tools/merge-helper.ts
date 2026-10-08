import type { Database } from "../db"
import { log } from "../log"
import { runCommand } from "../process"

/** Result of merging a single branch. */
export interface MergeResult {
  ok: boolean
  error?: string
}

/** Injectable function for testing. */
export type MergeBranchFn = (branch: string, cwd: string) => Promise<MergeResult>

/** Injectable function for overlap detection before merge. */
export type OverlapCheckFn = (branch: string, cwd: string) => Promise<string[]>

/** Injectable function for preserving a branch before worktree deletion. */
export type PreserveBranchFn = (sourceBranch: string, targetBranch: string, cwd: string) => Promise<boolean>

/** Injectable function for deleting a branch. */
export type DeleteBranchFn = (branch: string, cwd: string) => Promise<boolean>

/** Human-readable resource identity for a team. */
export interface TeamResourceParts {
  projectName: string
  teamName: string
  teamId: string
}

function shortTeamId(teamId: string): string {
  return (teamId.split("_").at(-1) || teamId).slice(0, 6)
}

function resourcePart(value: string): string {
  const part = value.toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/^-+|-+$/g, "")
  return part || "unnamed"
}

/** Load the human-readable pieces used to build team resource names. */
export function getTeamResourceParts(db: Database, teamId: string): TeamResourceParts {
  const row = db.query(
    `SELECT t.id as team_id, t.name as team_name, p.name as project_name
     FROM team t
     JOIN project p ON t.project_id = p.id
     WHERE t.id = ?`
  ).get(teamId) as { team_id: string; team_name: string; project_name: string } | null
  if (!row) throw new Error(`Team not found: ${teamId}`)
  return { projectName: row.project_name, teamName: row.team_name, teamId: row.team_id }
}

/** Build the readable namespace used for team-owned resources. */
export function teamResourceSlug(projectName: string, teamName: string, teamId: string): string {
  return `${resourcePart(projectName)}-${resourcePart(teamName)}#${shortTeamId(teamId)}`
}

/** Build the team-only resource segment used under project-scoped namespaces. */
export function teamResourceSegment(teamName: string, teamId: string): string {
  return `${resourcePart(teamName)}#${shortTeamId(teamId)}`
}

/** Build an OpenCode worktree name for a team member. */
export function teamWorktreeName(projectName: string, teamName: string, teamId: string, memberName: string): string {
  return `ensemble-${teamResourceSlug(projectName, teamName, teamId)}-${memberName}`
}

/**
 * Copy a git branch to a new ref. Used to preserve worktree branches
 * before session.abort() which may delete the worktree and its branch.
 * Returns true if the branch was successfully copied.
 */
export async function preserveBranch(sourceBranch: string, targetBranch: string, cwd: string): Promise<boolean> {
  const result = await runCommand(["git", "branch", targetBranch, sourceBranch], { cwd })
  if (result.exitCode !== 0) {
    log(`merge-helper:preserve:failed src=${sourceBranch} target=${targetBranch} err=${result.stderr.trim()}`)
    return false
  }
  return true
}

/**
 * Delete a git branch. Returns true if successful.
 */
export async function deleteBranch(branch: string, cwd: string): Promise<boolean> {
  const result = await runCommand(["git", "branch", "-D", branch], { cwd })
  if (result.exitCode !== 0) {
    log(`merge-helper:delete:failed branch=${branch}`)
    return false
  }
  return true
}

/**
 * Raw squash merge of a single branch. No stash/pop — caller handles that.
 * Used by mergeBranch (single) and mergeMultipleBranches (batch).
 */
export async function mergeBranchRaw(branch: string, cwd: string): Promise<MergeResult> {
  const result = await runCommand(["git", "merge", "--squash", branch], { cwd })

  if (result.exitCode !== 0) {
    const stderr = result.stderr.trim()
    log(`merge-helper:merge:conflict branch=${branch} err=${stderr}`)
    await runCommand(["git", "merge", "--abort"], { cwd })
    return { ok: false, error: stderr || `merge exited with code ${result.exitCode}` }
  }

  return { ok: true }
}

/** Unstage all changes so merge results appear as unstaged. */
export async function gitReset(cwd: string): Promise<void> {
  await runCommand(["git", "reset", "HEAD"], { cwd })
}

/**
 * Squash merge a branch into the working directory as unstaged changes.
 * No stashing — existing unstaged changes from previous merges are preserved.
 * If the merge conflicts, the lead resolves it with git.
 */
export async function mergeBranch(branch: string, cwd: string): Promise<MergeResult> {
  const result = await mergeBranchRaw(branch, cwd)
  if (!result.ok) return result
  await gitReset(cwd)
  return { ok: true }
}

/**
 * Detect files that both the lead (local changes) and the agent (branch) modified.
 * Returns the list of overlapping file paths, or empty if safe to merge.
 */
export async function getOverlappingFiles(branch: string, cwd: string): Promise<string[]> {
  const run = async (args: string[]) => {
    const result = await runCommand(["git", ...args], { cwd })
    if (result.exitCode !== 0) throw new Error(`git ${args.join(" ")} failed with exit code ${result.exitCode}`)
    return result.stdout.split("\n").filter(Boolean)
  }
  const agentFiles = new Set(await run(["diff", "--name-only", "HEAD", branch]))
  const localChanged = await run(["diff", "--name-only", "HEAD"])
  const localUntracked = await run(["ls-files", "--others", "--exclude-standard"])
  const localFiles = [...new Set([...localChanged, ...localUntracked])]
  return localFiles.filter(f => agentFiles.has(f))
}

/**
 * Build the preserved branch name for a team member.
 */
export function preservedBranchName(projectName: string, teamName: string, teamId: string, memberName: string): string {
  return `ensemble/preserved/${resourcePart(projectName)}/${teamResourceSegment(teamName, teamId)}/${resourcePart(memberName)}`
}
