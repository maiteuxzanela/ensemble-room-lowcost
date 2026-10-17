import type { Database } from "./db"
import type { MemberRegistry } from "./state"
import { findTeamBySession } from "./types"
import path from "node:path"
import { log } from "./log"

/**
 * TICKET-HARNESS-32A — atomic per-room modified-file ledger.
 *
 * Every file a room touches through a file-mutating tool (edit / write /
 * patch / multiedit / apply_patch / notebookEdit / insert) is recorded here,
 * normalized to an absolute path, keyed by the owning team. The ledger is the
 * source of truth consumed by the Portão 1 auto-commit
 * (team-tasks-complete.ts) so a repository is committed ONLY with the exact
 * files the room registered under it — never a blind `git add -A` sweep.
 *
 * Recording is fail-graceful: it must never break a tool call, never throw
 * into the caller's promise chain. A ledger failure is logged and swallowed —
 * the worst case is a file the room touched that does not get auto-committed
 * (the human can still `git add` it manually).
 */

/**
 * File-mutating OpenCode tool names that must be recorded. The set is a fast
 * allow-list; `filePath` is also defensively extracted for any tool in it.
 * Read-only tools (read/grep/glob) and team_* tools are intentionally absent.
 */
const FILE_MUTATING_TOOLS = new Set([
  "edit",
  "write",
  "patch",
  "multiedit",
  "apply_patch",
  "notebookEdit",
  "insert",
])

/**
 * Normalize a file path for the ledger: absolute, resolved against the CWD,
 * separators unified by path.resolve, trailing separators stripped. Two
 * spellings of the same file (`./a.ts`, `a.ts`, `/abs/a.ts`) collapse to one
 * row thanks to the PRIMARY KEY (team_id, file_path).
 */
export function normalizeModifiedPath(filePath: string): string {
  return path.resolve(filePath)
}

/**
 * Record one modified file for a team (INSERT ... ON CONFLICT DO UPDATE so a
 * re-edit refreshes time_created without duplicating the row).
 *
 * Exported for deterministic tests (the SDET suite drives the REAL dist
 * bundle and calls this directly to seed the ledger before exercising the
 * auto-commit). Production callers reach it via recordFileFromToolCall.
 */
export function recordModifiedFile(db: Database, teamId: string, filePath: string): void {
  const normalized = normalizeModifiedPath(filePath)
  db.run(
    `INSERT INTO team_modified_file (team_id, file_path, time_created) VALUES (?, ?, ?)
     ON CONFLICT(team_id, file_path) DO UPDATE SET time_created = excluded.time_created`,
    [teamId, normalized, Date.now()],
  )
}

/**
 * Extract the absolute file path from a file-mutating tool's args. Different
 * tools spell the field differently (filePath / file_path / path / filename /
 * notes[].path for notebookEdit); all are accepted. Returns null when the
 * tool carries no recognizable single file path.
 */
function extractFilePath(tool: string, args: unknown): string | null {
  if (!args || typeof args !== "object") return null
  const a = args as Record<string, unknown>

  for (const key of ["filePath", "file_path", "path", "filename"]) {
    const v = a[key]
    if (typeof v === "string" && v.length > 0) return v
  }

  // notebookEdit carries an array of cells, each with its own path.
  if (tool === "notebookEdit" && Array.isArray(a.notes)) {
    for (const note of a.notes) {
      if (note && typeof note === "object") {
        const p = (note as Record<string, unknown>).path
        if (typeof p === "string" && p.length > 0) return p
      }
    }
  }
  return null
}

/**
 * Hook-side entry point: record the file a session just mutated.
 *
 * Called from tool.execute.after (V1 index.ts and V2 v2-setup.ts). No-ops
 * when:
 *   - the tool is not file-mutating (read/grep/team_* never reach the ledger);
 *   - the args carry no recognizable file path;
 *   - the session is not a registered room member nor a lead (isolated
 *     sessions — e.g. Diana's blind review — never touch a room's ledger).
 *
 * Never throws — safe to call from a promise-chain hook.
 */
export function recordFileFromToolCall(
  db: Database,
  registry: MemberRegistry,
  sessionId: string,
  tool: string,
  args: unknown,
): void {
  try {
    if (!FILE_MUTATING_TOOLS.has(tool)) return
    const filePath = extractFilePath(tool, args)
    if (!filePath) return

    const teamInfo = findTeamBySession(db, registry, sessionId)
    if (!teamInfo) return

    recordModifiedFile(db, teamInfo.teamId, filePath)
    log(`modified-file:recorded team=${teamInfo.teamId} tool=${tool} file=${normalizeModifiedPath(filePath)}`)
  } catch (err) {
    // Fail-graceful: a ledger error must never break the tool call.
    log(`modified-file:record-failed tool=${tool} err=${err instanceof Error ? err.message : String(err)}`)
  }
}

/**
 * List every file a room touched, normalized absolute paths, newest first.
 * Exported for the auto-commit filter and for deterministic tests.
 */
export function listModifiedFiles(db: Database, teamId: string): string[] {
  const rows = db.query(
    "SELECT file_path FROM team_modified_file WHERE team_id = ? ORDER BY time_created DESC",
  ).all(teamId) as Array<{ file_path: string }>
  return rows.map((r) => r.file_path)
}

/**
 * Filter a room's ledger down to the files that live under `repoRoot`.
 *
 * A file "belongs to" a repo when its normalized absolute path is either the
 * repo root itself (never — a repo root is a dir) or sits under it. The
 * comparison is separator-safe: `path.relative` is used instead of a naive
 * prefix match so `/repo-evil/x.ts` is NOT attributed to `/repo`.
 *
 * Returns the matching absolute paths (deduped, stable order).
 */
export function modifiedFilesUnderRepo(ledger: string[], repoRoot: string): string[] {
  const root = normalizeModifiedPath(repoRoot)
  const out: string[] = []
  const seen = new Set<string>()
  for (const file of ledger) {
    const abs = normalizeModifiedPath(file)
    if (seen.has(abs)) continue
    const rel = path.relative(root, abs)
    // Under the repo when rel is non-empty, not escaping upward, and not an
    // absolute path (which path.relative returns across drives on Windows).
    if (rel.length > 0 && !rel.startsWith("..") && !path.isAbsolute(rel)) {
      seen.add(abs)
      out.push(abs)
    }
  }
  return out
}
