import { createRequire } from "node:module"
import path from "node:path"
import type { Database } from "./db"
import type { PluginClient } from "./types"
import type { MemberRegistry } from "./state"
import type { ProgressTracker } from "./progress"
import { preserveBranch, preservedBranchName } from "./tools/merge-helper"
import { releaseMemberTasks } from "./tasks"
import { hasReportedCompletion } from "./messaging"
import { getMemberModel } from "./member-model"
import { notifyLead } from "./notify"
import { log } from "./log"

interface WatchdogOpts {
  db: Database
  client: PluginClient
  registry: MemberRegistry
  /** Maximum time a member can stay busy before being timed out. 0 disables. */
  ttlMs: number
  /** How often to run the check. Defaults to 60s. */
  checkIntervalMs?: number
  /** Progress tracker for stall detection. */
  progressTracker?: ProgressTracker
  /** Stall detection threshold in ms. 0 disables. */
  stallThresholdMs?: number
  /** Min steps before token-based stall check. */
  stallMinSteps?: number
  /** Output token threshold for stall detection. */
  stallTokenThreshold?: number
  /** Project directory for git operations. */
  cwd?: string
  /** Max peer messages per agent per window before nudge. 0 disables. */
  peerMessageLimit?: number
  /** Time window for peer message rate limiting in ms. */
  peerMessageWindowMs?: number
}

const requireSessionModule = createRequire(import.meta.url)

/** Path of opencode's session store — the table that owns `session.time_compacting`. */
function sessionStorePath(env: Record<string, string | undefined> = process.env): string {
  const home = env.HOME ?? env.USERPROFILE ?? "~"
  return path.join(home, ".local", "share", "opencode", "opencode.db")
}

/** Minimal read-only handle over opencode's session store. */
interface SessionStoreHandle {
  get(sql: string, ...params: unknown[]): unknown
  close(): void
}

/**
 * Open opencode's session store READ-ONLY. Runtime aware: `bun:sqlite` when the
 * host is Bun, `node:sqlite` otherwise — mirroring db.ts so the probe works under
 * both the CLI and the server. Opened per probe and closed immediately after:
 * the watchdog must never hold a long-lived read transaction on the host's
 * primary database (it would stall WAL checkpoints).
 */
function openSessionStore(dbPath: string): SessionStoreHandle {
  if (typeof process.versions.bun === "string") {
    const { Database } = requireSessionModule("bun:sqlite") as {
      Database: new (file: string, opts: { readonly: boolean }) => {
        query(sql: string): { get(...params: unknown[]): unknown }
        close(): void
      }
    }
    const db = new Database(dbPath, { readonly: true })
    return { get: (sql, ...params) => db.query(sql).get(...params), close: () => db.close() }
  }

  const { DatabaseSync } = requireSessionModule("node:sqlite") as {
    DatabaseSync: new (file: string, opts: { readOnly: boolean }) => {
      prepare(sql: string): { get(...params: unknown[]): unknown }
      close(): void
    }
  }
  const db = new DatabaseSync(dbPath, { readOnly: true })
  return { get: (sql, ...params) => db.prepare(sql).get(...params), close: () => db.close() }
}

/**
 * True while opencode is mid context-compaction for this session
 * (`session.time_compacting > 0`), false otherwise.
 *
 * Never throws: a locked, absent or rotated store degrades to `false` (no
 * immunity), which is exactly the pre-probe behaviour — a defensive read must
 * not be able to break the watchdog tick. Compaction immunity matters because
 * `session.abort()` fired while opencode is rewriting the context is what
 * surfaces `MessageAbortedError` ("The running turn was stopped before OpenCode
 * could send the next message.") on a turn that is actually still alive.
 */
export function isSessionCompacting(sessionId: string, env: Record<string, string | undefined> = process.env): boolean {
  if (!sessionId) return false
  let handle: SessionStoreHandle | undefined
  try {
    handle = openSessionStore(sessionStorePath(env))
    const row = handle.get("SELECT time_compacting FROM session WHERE id = ?", sessionId) as
      | { time_compacting?: number | null }
      | null
      | undefined
    return typeof row?.time_compacting === "number" && row.time_compacting > 0
  } catch (err) {
    log(`watchdog:compact:probe-failed session=${sessionId} err=${err instanceof Error ? err.message : String(err)}`)
    return false
  } finally {
    if (handle) {
      try { handle.close() } catch { /* best effort */ }
    }
  }
}

/**
 * Periodic watchdog that times out teammates stuck in busy state.
 * Transitions them to error/timed_out, aborts their session, and fires a toast.
 */
export class Watchdog {
  private readonly db: Database
  private readonly client: PluginClient
  private readonly registry: MemberRegistry
  private readonly ttlMs: number
  private readonly checkIntervalMs: number
  private readonly progressTracker?: ProgressTracker
  private readonly stallThresholdMs: number
  private readonly stallMinSteps: number
  private readonly stallTokenThreshold: number
  private readonly cwd?: string
  private readonly peerMessageLimit: number
  private readonly peerMessageWindowMs: number
  private timer: ReturnType<typeof setInterval> | undefined

  constructor(opts: WatchdogOpts) {
    this.db = opts.db
    this.client = opts.client
    this.registry = opts.registry
    this.ttlMs = opts.ttlMs
    this.checkIntervalMs = opts.checkIntervalMs ?? 60_000
    this.progressTracker = opts.progressTracker
    this.stallThresholdMs = opts.stallThresholdMs ?? 0
    this.stallMinSteps = opts.stallMinSteps ?? 3
    this.stallTokenThreshold = opts.stallTokenThreshold ?? 500
    this.cwd = opts.cwd
    this.peerMessageLimit = opts.peerMessageLimit ?? 0
    this.peerMessageWindowMs = opts.peerMessageWindowMs ?? 300_000
  }

  private static STALE_THRESHOLD_MS = Number(process.env.STALE_WORKTREE_THRESHOLD_MS) || 300_000

  /** Clean up worktrees and workspaces for shutdown/error members past the stale threshold. */
  async cleanupStaleWorktrees(): Promise<void> {
    const cutoff = Date.now() - Watchdog.STALE_THRESHOLD_MS
    const stale = this.db.query(
      `SELECT tm.team_id, tm.name, tm.worktree_dir, tm.workspace_id
       FROM team_member tm
       JOIN team t ON tm.team_id = t.id
       WHERE t.status = 'active'
         AND tm.status IN ('shutdown', 'error')
         AND tm.worktree_dir IS NOT NULL
         AND tm.time_updated < ?`
    ).all(cutoff) as Array<{ team_id: string; name: string; worktree_dir: string; workspace_id: string | null }>

    for (const m of stale) {
      try {
        if (m.workspace_id) {
          await this.client.workspace.remove({ id: m.workspace_id })
        }
        await this.client.worktree.remove({ worktreeRemoveInput: { directory: m.worktree_dir } })
        this.db.run(
          "UPDATE team_member SET worktree_dir = NULL, worktree_branch = NULL, workspace_id = NULL WHERE team_id = ? AND name = ?",
          [m.team_id, m.name]
        )
      } catch { /* best effort */ }
    }
  }

  /** Check for stalled busy members and escalate to lead + nudge teammate. */
  async checkStalled(): Promise<void> {
    if (!this.progressTracker || this.stallThresholdMs === 0) return

    const busy = this.db.query(
      `SELECT tm.team_id, tm.name, tm.session_id
       FROM team_member tm
       JOIN team t ON tm.team_id = t.id
       WHERE t.status = 'active' AND tm.status = 'busy'`
    ).all() as Array<{ team_id: string; name: string; session_id: string }>

    for (const member of busy) {
      if (this.progressTracker.isReported(member.session_id)) continue

      const tokenStalled = this.progressTracker.isTokenStalled(member.session_id, this.stallMinSteps, this.stallTokenThreshold)
      const timeStalled = this.progressTracker.isTimeStalled(member.session_id, this.stallThresholdMs)

      if (!tokenStalled && !timeStalled) continue

      // hasReportedCompletion() is the documented invariant every promptAsync delivery
      // path must honor (see hooks.ts:63). The in-memory isReported() check above only
      // catches this watchdog's own prior nudges — it doesn't know if the member reported
      // completion by some other path while still transiently 'busy' in the DB.
      if (hasReportedCompletion(this.db, member.team_id, member.name)) {
        log(`watchdog:stall:skip member=${member.name} team=${member.team_id} reason=already-reported-completion`)
        continue
      }

      const reason = tokenStalled ? "low output tokens" : "no communication"

      // Re-nudge suppression: markReported is deferred until promptAsync delivery
      // succeeds, so a persistently failing nudge (session deleted mid-run while the
      // DB row stays busy, bad stored model) would otherwise re-fire this whole
      // block on every tick — a fresh last_nudged_at write, lead wake, and toast
      // forever. Skip while the previous nudge is recent AND the member has shown
      // no activity since it; genuine activity after a nudge makes them eligible
      // for a fresh evaluation (and a fresh stall verdict) immediately.
      const recentNudgeRow = this.db.query(
        "SELECT last_nudged_at FROM team_member WHERE team_id = ? AND name = ?"
      ).get(member.team_id, member.name) as { last_nudged_at: number | null } | null
      if (recentNudgeRow?.last_nudged_at) {
        const nudgedAt = recentNudgeRow.last_nudged_at
        // >= because Date.now() has ms resolution: activity recorded in the same
        // tick as the nudge write must count as post-nudge, or a member that went
        // idle, worked, and stalled again would stay suppressed forever.
        const activeSinceNudge = (this.progressTracker?.lastActivityAt(member.session_id) ?? 0) >= nudgedAt
        if (!activeSinceNudge && Date.now() - nudgedAt < this.stallThresholdMs) {
          log(`watchdog:stall:skip member=${member.name} team=${member.team_id} reason=recently-nudged`)
          continue
        }
      }

      // Additive display-staleness signal (does not change team_member.status) — lets
      // the dashboard/team_status annotate "busy, nudged Xs ago" so a soft nudge is
      // visible without inventing a new status value.
      this.db.run(
        "UPDATE team_member SET last_nudged_at = ? WHERE team_id = ? AND name = ?",
        [Date.now(), member.team_id, member.name]
      )

      // Nudge the teammate directly. markReported() only fires once delivery is
      // confirmed — marking it before delivery is known would permanently and silently
      // orphan the stall state if promptAsync throws (aborted session, invalid ID),
      // since ProgressTracker.reported is in-memory and only cleared by new activity.
      const stallModel = getMemberModel(this.db, member.team_id, member.name)
      this.client.session.promptAsync({
        sessionID: member.session_id,
        parts: [{ type: "text", text: "[System]: You appear stalled — no progress detected. Report your current status to the lead via team_message, or wrap up your work." }],
        ...(stallModel ? { model: stallModel } : {}),
      }).then(() => {
        this.progressTracker!.markReported(member.session_id)
      }).catch((err) => {
        log(`watchdog:stall:nudge-failed member=${member.name} team=${member.team_id} session=${member.session_id} err=${err instanceof Error ? err.message : String(err)}`)
      })

      // Notify the lead
      notifyLead(
        this.client,
        this.db,
        member.team_id,
        `Teammate "${member.name}" appears stalled (${reason}). Consider checking on them via team_message or shutting them down.`,
      )

      // Toast for the user
      try {
        await this.client.tui.showToast({
          title: "Team",
          message: `${member.name} appears stalled`,
          variant: "warning",
          duration: 5000,
        })
      } catch { /* TUI may not be available */ }
    }
  }

  /** Check for chatty agents sending too many peer messages. */
  async checkChatty(): Promise<void> {
    if (!this.progressTracker || this.peerMessageLimit === 0) return

    const busy = this.db.query(
      `SELECT tm.team_id, tm.name, tm.session_id
       FROM team_member tm
       JOIN team t ON tm.team_id = t.id
       WHERE t.status = 'active' AND tm.status = 'busy'`
    ).all() as Array<{ team_id: string; name: string; session_id: string }>

    for (const member of busy) {
      if (this.progressTracker.isChattyReported(member.session_id)) continue
      if (!this.progressTracker.isChatty(member.session_id, this.peerMessageLimit, this.peerMessageWindowMs)) continue

      // hasReportedCompletion() guard — same invariant/rationale as checkStalled() above.
      if (hasReportedCompletion(this.db, member.team_id, member.name)) {
        log(`watchdog:chatty:skip member=${member.name} team=${member.team_id} reason=already-reported-completion`)
        continue
      }

      this.progressTracker.markChattyReported(member.session_id)

      // Nudge the agent
      const chattyModel = getMemberModel(this.db, member.team_id, member.name)
      this.client.session.promptAsync({
        sessionID: member.session_id,
        parts: [{ type: "text", text: "[System]: You've sent several messages to teammates. Focus on completing your task and send your results to the lead via team_message." }],
        ...(chattyModel ? { model: chattyModel } : {}),
      }).catch((err) => {
        log(`watchdog:chatty:nudge-failed member=${member.name} team=${member.team_id} session=${member.session_id} err=${err instanceof Error ? err.message : String(err)}`)
      })

      // Notify the lead
      notifyLead(
        this.client,
        this.db,
        member.team_id,
        `Agent "${member.name}" is sending many peer messages and may be over-coordinating. Consider checking on them.`,
      )

      log(`watchdog:chatty member=${member.name} limit=${this.peerMessageLimit}`)
    }
  }

  /** Run a single check for stale busy members. */
  async check(): Promise<void> {
    await this.cleanupStaleWorktrees()
    await this.checkStalled()
    await this.checkChatty()
    if (this.ttlMs === 0) return

    const cutoff = Date.now() - this.ttlMs
    const stale = this.db.query(
      `SELECT tm.team_id, tm.name, tm.session_id, tm.worktree_branch, t.name as team_name, p.name as project_name
       FROM team_member tm
       JOIN team t ON tm.team_id = t.id
       JOIN project p ON t.project_id = p.id
       WHERE t.status = 'active'
         AND tm.status = 'busy'
         AND tm.time_updated < ?`
    ).all(cutoff) as Array<{ team_id: string; name: string; session_id: string; worktree_branch: string | null; team_name: string; project_name: string }>

    for (const member of stale) {
      // Active heartbeat: the team_member row went stale, but the progress
      // tracker saw real work (message / task / step / busy-transition) after
      // the cutoff. Renew the row from the tracker and skip this tick instead of
      // aborting — a member inside a long tool call legitimately has an old
      // time_updated, and aborting it mid-turn is what surfaces
      // MessageAbortedError ("The running turn was stopped before OpenCode
      // could send the next message.").
      const lastActive = this.progressTracker?.lastActivityAt(member.session_id) ?? 0
      if (lastActive > cutoff) {
        this.db.run(
          "UPDATE team_member SET time_updated = ? WHERE team_id = ? AND name = ?",
          [lastActive, member.team_id, member.name]
        )
        log(`watchdog:heartbeat:renewed member=${member.name} team=${member.team_id} lastActive=${lastActive}`)
        continue
      }

      // Compaction immunity: opencode is rewriting this session's context.
      // The turn is alive — only the store is being reduced — so aborting here
      // would race the compaction and kill the running turn. Grant immunity for
      // this tick; the row stays stale and is re-evaluated on the next check.
      if (isSessionCompacting(member.session_id)) {
        log(`watchdog:heartbeat:compacting member=${member.name} team=${member.team_id} session=${member.session_id}`)
        continue
      }

      // Preserve branch BEFORE abort — session.abort() may destroy the worktree + branch
      if (this.cwd && member.worktree_branch && !member.worktree_branch.startsWith("ensemble/preserved/")) {
        const safeBranch = preservedBranchName(member.project_name, member.team_name, member.team_id, member.name)
        const ok = await preserveBranch(member.worktree_branch, safeBranch, this.cwd)
        if (ok) {
          this.db.run("UPDATE team_member SET worktree_branch = ? WHERE team_id = ? AND name = ?",
            [safeBranch, member.team_id, member.name])
          log(`watchdog:branch:preserved src=${member.worktree_branch} target=${safeBranch}`)
        }
      }

      // Mark as timed out
      this.db.run(
        "UPDATE team_member SET status = 'error', execution_status = 'timed_out', time_updated = ? WHERE team_id = ? AND name = ?",
        [Date.now(), member.team_id, member.name]
      )

      // Release the timed-out member's in_progress tasks back to the pool (issue #27)
      const released = releaseMemberTasks(this.db, member.team_id, member.name)
      if (released > 0) log(`watchdog:tasks:released name=${member.name} count=${released}`)

      // Notify AND wake the lead — a timed-out teammate is otherwise a silent
      // failure. This is the "leave recovery to the lead" path: we surface the
      // timeout, we do not auto-resume the teammate.
      notifyLead(
        this.client,
        this.db,
        member.team_id,
        `Teammate "${member.name}" timed out after exceeding the busy time limit and was aborted. Their in-progress work has been released. Review their session, then re-spawn or reassign the task if needed.`,
      )

      // Abort session (best effort)
      try {
        await this.client.session.abort({ sessionID: member.session_id })
      } catch { /* best effort */ }

      // Notify
      try {
        await this.client.tui.showToast({
          title: "Team",
          message: `${member.name} timed out`,
          variant: "warning",
          duration: 5000,
        })
      } catch { /* TUI may not be available */ }
    }
  }

  /** Start the periodic check. Runs stale worktree GC regardless of TTL setting. */
  start(): void {
    if (this.timer) return
    this.timer = setInterval(() => this.check(), this.checkIntervalMs)
  }

  /** Stop the periodic check. */
  stop(): void {
    if (this.timer) {
      clearInterval(this.timer)
      this.timer = undefined
    }
  }

  /** Whether the watchdog is currently running. */
  isRunning(): boolean {
    return this.timer !== undefined
  }
}
