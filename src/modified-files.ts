import type { Database } from "./db"
import type { MemberRegistry } from "./state"
import { findTeamBySession } from "./types"
import path from "node:path"
import { spawnSync } from "node:child_process"
import { statSync } from "node:fs"
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
 *
 * TICKET-RELEASE-05: shell commands (`bash` / `shell`) mutate files WITHOUT
 * naming them in their args. They are captured by a `git status --porcelain`
 * snapshot diff around the call, so generators, `sed -i`, bundlers and
 * `npm install` artifacts enter the very same ledger — keeping the Portão 1
 * commit surgical (`git add -- <files>`) while no longer omitting them.
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
 * TICKET-RELEASE-05 — shell tools that can mutate ANY file in the repository
 * without naming it in their args (`npm install` regenerating package-lock.json,
 * `sed -i`, code generators, bundlers, CLI scaffolding...). The allow-list of
 * direct file tools alone left those artifacts OUT of the ledger, so the Portão
 * 1 auto-commit (strictly ledger-gated) never staged them and the tree ended
 * dirty after a "successful" completion. Shell calls are handled by a
 * before/after snapshot diff (see captureShellBaseline / recordShellDiff).
 */
const SHELL_TOOLS = new Set(["bash", "shell"])

/** Path segments that must never enter the ledger from a shell diff. */
const LEDGER_IGNORED_SEGMENTS = new Set([".git", "node_modules", ".test-scratch"])

/** Hard cap on files recorded per shell call (a runaway generator cannot flood SQLite). */
const MAX_SHELL_LEDGER_FILES = 400

/** Timeout for the read-only git probes (never blocks a tool hook for long). */
const SHELL_GIT_TIMEOUT_MS = 5000

/** A pending baseline older than this is discarded (hook pairing lost / crashed call). */
const SHELL_BASELINE_TTL_MS = 10 * 60 * 1000

/** One `git status --porcelain` view of a repository: path → cheap change signature. */
interface RepoSnapshot {
  root: string
  entries: Map<string, string>
}

interface PendingShellBaseline {
  /** Tool-call id when the runtime provides one (`tool.execute.before`). */
  callId?: string
  at: number
  snapshot: RepoSnapshot | null
}

/** sessionId → FIFO of pending shell baselines (concurrent calls in one session pair in order). */
const pendingShellBaselines = new Map<string, PendingShellBaseline[]>()

/** True when any path segment is on the ledger deny-list. */
function isLedgerIgnoredPath(relPath: string): boolean {
  return relPath
    .split(/[\\/]+/)
    .some((segment) => LEDGER_IGNORED_SEGMENTS.has(segment))
}

/** Cheap change signature for a dirty/untracked path (missing file = deletion). */
function changeSignature(absPath: string): string {
  try {
    const st = statSync(absPath)
    if (!st.isFile()) return st.isDirectory() ? "dir" : "other"
    return `${st.size}:${st.mtimeMs}:${st.ino}`
  } catch {
    return "missing"
  }
}

/**
 * Normalize the value `git status --porcelain -z` uses for a path: dropped
 * quoting (the `-z` form never quotes) and C-escapes are already raw.
 */
function porcelainEntries(root: string, raw: string): Array<[string, string]> {
  const out: Array<[string, string]> = []
  const tokens = raw.split("\u0000")
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i]
    if (!token || token.length < 4) continue
    const status = token.slice(0, 2)
    const rel = token.slice(3)
    // TICKET-RELEASE-06 — rename/copy entries are emitted by `git status
    // --porcelain -z` as TWO consecutive NUL tokens: "XY <new-path>" followed
    // by "<original-path>" (verified against real git). Both paths belong to
    // the surgical ledger:
    //   - the NEW path carries the content that must be committed;
    //   - the ORIGINAL path (absent from the work tree…) must also be staged,
    //     otherwise `git add -- <new>` leaves the removal/move side unstaged
    //     and the tree ends dirty after a "successful" Portão 1 commit.
    // The original token is consumed here so it is never parsed as a status.
    const isRenameOrCopy = status.startsWith("R") || status.startsWith("C")
    const original = isRenameOrCopy ? tokens[i + 1] : undefined
    if (isRenameOrCopy) i += 1
    if (rel && !isLedgerIgnoredPath(rel)) out.push([path.resolve(root, rel), status])
    if (original && original.length > 0 && !isLedgerIgnoredPath(original)) {
      out.push([path.resolve(root, original), status])
    }
  }
  return out
}

/**
 * Read-only snapshot of every dirty/untracked file in the git repository that
 * contains `cwd`. Returns null when `cwd` is not inside a work tree or git is
 * unavailable/too slow — the caller degrades to "record nothing".
 *
 * `-uall` expands untracked DIRECTORIES into individual files (a ledger row must
 * name a file, never a directory), and the pathspec exclusions keep the probe
 * fast and the ledger clean (`node_modules`, `.test-scratch`).
 */
function gitStatusSnapshot(cwd: string): RepoSnapshot | null {
  const top = spawnSync("git", ["rev-parse", "--show-toplevel"], {
    cwd,
    encoding: "utf8",
    timeout: SHELL_GIT_TIMEOUT_MS,
  })
  if (top.error || top.status !== 0) return null
  const root = top.stdout.trim()
  if (!root) return null

  const statusRes = spawnSync(
    "git",
    [
      "status",
      "--porcelain",
      "-z",
      "-uall",
      "--",
      ".",
      ":(exclude)node_modules",
      ":(exclude).test-scratch",
      ":(exclude).git",
    ],
    { cwd: root, encoding: "utf8", timeout: SHELL_GIT_TIMEOUT_MS, maxBuffer: 8 * 1024 * 1024 },
  )
  if (statusRes.error || statusRes.status !== 0) return null

  const entries = new Map<string, string>()
  for (const [abs, status] of porcelainEntries(root, statusRes.stdout ?? "")) {
    entries.set(abs, `${status}:${changeSignature(abs)}`)
  }
  return { root, entries }
}

/** Resolve the working directory a shell command runs in: args.cwd → member worktree → plugin dir. */
function resolveShellCwd(
  db: Database,
  sessionId: string,
  args: unknown,
  workspaceDir: string | undefined,
): string | null {
  if (args && typeof args === "object") {
    // TICKET-RELEASE-06 — `workdir` is the field opencode's native shell tool
    // uses for cross-repo commands (`bash` with `workdir`), while other
    // callers pass `cwd`. Honoring only `cwd` snapshotted the plugin/worktree
    // directory and silently missed every artifact the command produced in the
    // other repository. Precedence: workdir ?? cwd, first non-empty string wins.
    const raw = args as Record<string, unknown>
    for (const key of ["workdir", "cwd"]) {
      const candidate = raw[key]
      if (typeof candidate === "string" && candidate.length > 0) return path.resolve(candidate)
    }
  }
  const row = db.query("SELECT worktree_dir FROM team_member WHERE session_id = ?").get(sessionId) as
    | { worktree_dir: string | null }
    | null
  if (row?.worktree_dir) return row.worktree_dir
  return workspaceDir ? path.resolve(workspaceDir) : null
}

/** Drop expired baselines and bound the per-session queue. */
function prunePendingShellBaselines(now: number): void {
  for (const [sessionId, queue] of pendingShellBaselines) {
    const fresh = queue.filter((entry) => now - entry.at <= SHELL_BASELINE_TTL_MS)
    if (fresh.length === 0) pendingShellBaselines.delete(sessionId)
    else pendingShellBaselines.set(sessionId, fresh)
  }
}

/**
 * `tool.execute.before` half of the shell capture: snapshot the repos the shell
 * call may touch, keyed by session (and call id when the runtime supplies one).
 *
 * Fail-graceful and synchronous: the probe is a read-only `git status` (spawnSync
 * with timeout); a non-git directory or a missing binary yields a null snapshot,
 * which simply means that call records nothing.
 */
export function captureShellBaseline(
  db: Database,
  registry: MemberRegistry,
  sessionId: string,
  tool: string,
  args: unknown,
  workspaceDir?: string,
  callId?: string,
): void {
  try {
    if (!SHELL_TOOLS.has(tool)) return
    const teamInfo = findTeamBySession(db, registry, sessionId)
    if (!teamInfo) return
    const cwd = resolveShellCwd(db, sessionId, args, workspaceDir)
    if (!cwd) return

    const now = Date.now()
    prunePendingShellBaselines(now)
    const queue = pendingShellBaselines.get(sessionId) ?? []
    queue.push({ callId, at: now, snapshot: gitStatusSnapshot(cwd) })
    // Bound the queue: a lost `after` must not grow memory forever.
    while (queue.length > 8) queue.shift()
    pendingShellBaselines.set(sessionId, queue)
  } catch (err) {
    log(`modified-file:shell-baseline-failed tool=${tool} err=${err instanceof Error ? err.message : String(err)}`)
  }
}

/** Pop the baseline that pairs with this shell call (call id match wins, else FIFO). */
export function consumeShellBaseline(
  db: Database,
  registry: MemberRegistry,
  sessionId: string,
  tool: string,
  args: unknown,
  workspaceDir?: string,
  callId?: string,
): { baseline: RepoSnapshot | null; current: RepoSnapshot | null } | null {
  const teamInfo = findTeamBySession(db, registry, sessionId)
  if (!teamInfo) return null
  const cwd = resolveShellCwd(db, sessionId, args, workspaceDir)
  if (!cwd) return null

  const queue = pendingShellBaselines.get(sessionId) ?? []
  let idx = -1
  if (callId) idx = queue.findIndex((entry) => entry.callId === callId)
  if (idx < 0) idx = 0
  const pending = queue.length > 0 ? queue.splice(idx, 1)[0] : undefined
  if (queue.length === 0) pendingShellBaselines.delete(sessionId)
  else pendingShellBaselines.set(sessionId, queue)

  return { baseline: pending?.snapshot ?? null, current: gitStatusSnapshot(cwd) }
}

/**
 * Diff two snapshots and record every file the shell command actually changed.
 *
 * A path is "touched" when it is new (absent from the baseline), changed (its
 * size/mtime/inode signature differs — this catches an ALREADY dirty file that
 * the command rewrote, the package-lock.json incident) or deleted. Files that
 * were already dirty before the command and were not touched again stay out of
 * the ledger, so pre-existing unrelated dirt is never swept into the Portão 1
 * commit.
 */
export function recordShellDiff(
  db: Database,
  teamId: string,
  baseline: RepoSnapshot | null,
  current: RepoSnapshot | null,
): string[] {
  if (!current) return []
  const before = baseline && baseline.root === current.root ? baseline.entries : new Map<string, string>()
  const touched: string[] = []
  for (const [abs, signature] of current.entries) {
    if (before.get(abs) === signature) continue
    touched.push(abs)
  }
  // Deletions performed by the command (present before, gone now).
  for (const abs of before.keys()) {
    if (!current.entries.has(abs)) touched.push(abs)
  }

  const limited = touched.length > MAX_SHELL_LEDGER_FILES ? touched.slice(0, MAX_SHELL_LEDGER_FILES) : touched
  if (touched.length > limited.length) {
    log(
      `modified-file:shell-truncated team=${teamId} touched=${touched.length} recorded=${limited.length} max=${MAX_SHELL_LEDGER_FILES}`,
    )
  }
  for (const abs of limited) recordModifiedFile(db, teamId, abs)
  return limited
}

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
 * Hook-side entry point: record the files a session just mutated.
 *
 * Called from tool.execute.after (V1 index.ts and V2 v2-setup.ts). No-ops
 * when:
 *   - the tool is not file-mutating and not a shell tool (read/grep/team_*
 *     never reach the ledger);
 *   - the args carry no recognizable file path;
 *   - the session is not a registered room member nor a lead (isolated
 *     sessions — e.g. Diana's blind review — never touch a room's ledger).
 *
 * TICKET-RELEASE-05: `bash`/`shell` calls carry no file path — their artifacts
 * come from the before/after snapshot diff (captureShellBaseline →
 * recordShellDiff) and cover `npm install`, `sed -i`, generators and bundlers.
 *
 * `workspaceDir` (the plugin's project directory) is the fallback cwd for a
 * shell call when neither `args.cwd` nor a member worktree is available.
 * `callId` (when the runtime exposes it) pairs a baseline with its exact call.
 *
 * Never throws — safe to call from a promise-chain hook.
 */
export function recordFileFromToolCall(
  db: Database,
  registry: MemberRegistry,
  sessionId: string,
  tool: string,
  args: unknown,
  workspaceDir?: string,
  callId?: string,
): void {
  try {
    // TICKET-RELEASE-05 — shell-generated artifacts. The before hook captured a
    // repo snapshot (captureShellBaseline); here we diff it against the current
    // state and ledger every file the command created, rewrote or deleted. The
    // staging itself stays surgical (`git add -- <ledger files>`), so capturing
    // a broader surface never weakens the "never `git add -A`" invariant.
    if (SHELL_TOOLS.has(tool)) {
      const teamInfo = findTeamBySession(db, registry, sessionId)
      if (!teamInfo) return
      const snapshots = consumeShellBaseline(db, registry, sessionId, tool, args, workspaceDir, callId)
      if (!snapshots) return
      if (!snapshots.baseline) {
        log(`modified-file:shell-baseline-missing team=${teamInfo.teamId} tool=${tool}`)
        return
      }
      const recorded = recordShellDiff(db, teamInfo.teamId, snapshots.baseline, snapshots.current)
      log(
        `modified-file:shell-recorded team=${teamInfo.teamId} tool=${tool} files=${recorded.length}` +
          (recorded.length > 0 ? ` first=${recorded[0]}` : ""),
      )
      return
    }

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
