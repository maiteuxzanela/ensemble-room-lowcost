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
import { lastRoomActivity, type EnsembleConfig } from "./config"
import { getTeamQAMember } from "./qa-role"
import { resolveStandbyWake } from "./tools/shared"

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
  /** Room inactivity threshold in ms (default: 30000 = 30s, 0 disables). */
  roomInactivityThresholdMs?: number
  /** Room inactivity polling interval in ms (default: 5000 = 5s). */
  roomInactivityCheckMs?: number
  /**
   * Plugin config — threaded into notifyLead's `{ config }` so every
   * watchdog wake (stall/chatty/timeout) uses the model-aware ladder
   * (HARNESS-15 B / F2): agent from team.lead_agent + fallback chain with
   * step-down, instead of a modelless wake riding the rate-limited primary.
   */
  config?: Required<EnsembleConfig>
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
 * Row shape produced by the busy-member scans in checkStalled/checkChatty —
 * the identity columns every nudge needs to address `promptAsync` with an
 * explicit `agent` (HARNESS-17).
 */
interface NudgeTargetRow {
  session_id: string
  /** `team_member.agent` — TEXT NOT NULL, the member's own persona type. */
  agent: string
  /** `team.lead_agent` (Migration 5) — NULL on legacy teams. */
  lead_agent: string | null
  /** `team.lead_session_id` — to detect a busy row that IS the lead session. */
  lead_session_id: string
}

/**
 * Resolve the explicit `agent` for a watchdog nudge targeted at a busy member
 * (HARNESS-17).
 *
 * `session.promptAsync` WITHOUT `agent` makes the OpenCode server assume the
 * default agent of the installation (usually `dante`) and OVERWRITE the
 * `agent` column of the `session` table — the nudged member would lose its own
 * persona and its exclusive tool permissions (same mechanism as HARNESS-12(b),
 * already fixed on the failover/wake paths).
 *
 * Rule: the member's own `team_member.agent` wins; when the busy row's session
 * IS the team's lead session (`team.lead_session_id`), the lead's identity
 * (`team.lead_agent`) wins instead. Legacy teams with `lead_agent = NULL`
 * keep the member's agent — `agent` is NEVER omitted from the payload.
 */
function resolveWatchdogNudgeAgent(row: NudgeTargetRow): string {
  return row.lead_session_id === row.session_id && row.lead_agent ? row.lead_agent : row.agent
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
  private readonly roomInactivityThresholdMs: number
  private readonly roomInactivityCheckMs: number
  private readonly config?: Required<EnsembleConfig>
  private timer: ReturnType<typeof setInterval> | undefined
  private roomInactivityTimer: ReturnType<typeof setInterval> | undefined

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
    this.roomInactivityThresholdMs = opts.roomInactivityThresholdMs ?? 30_000
    this.roomInactivityCheckMs = opts.roomInactivityCheckMs ?? 5_000
    this.config = opts.config
  }

  /**
   * notifyLead wrapper (F2): threads `{ config }` so the wake runs the
   * model-aware ladder (agent from team.lead_agent + fallback chain with
   * step-down). Without a config (legacy construction / test harnesses) it
   * degrades to the exact legacy wake — signature-safe.
   *
   * TICKET-HARNESS-34 (A1): `forceWake` is true ONLY for the timeout path — a
   * member aborted by the watchdog is an unrecoverable failure the lead must
   * act on. Stall/chatty nudges are non-fatal noise: their message row is
   * persisted and the proactive wake stays suppressed under `silentLead`.
   */
  private notifyLead(teamId: string, message: string, forceWake = false): void {
    notifyLead(this.client, this.db, teamId, message, {
      ...(this.config ? { config: this.config } : {}),
      ...(forceWake ? { forceWake: true } : {}),
    })
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

    // Identity columns ride along the scan so the nudge below can address
    // promptAsync with an explicit `agent` (HARNESS-17) — see
    // resolveWatchdogNudgeAgent.
    const busy = this.db.query(
      `SELECT tm.team_id, tm.name, tm.session_id, tm.agent, t.lead_agent, t.lead_session_id
       FROM team_member tm
       JOIN team t ON tm.team_id = t.id
       WHERE t.status = 'active' AND tm.status = 'busy'`
    ).all() as Array<{ team_id: string; name: string; session_id: string; agent: string; lead_agent: string | null; lead_session_id: string }>

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
      // HARNESS-17: `agent` is NEVER omitted — without it the server assumes
      // the default agent (dante) and overwrites session.agent, stripping the
      // member's persona and tool permissions (HARNESS-12(b) mechanism).
      const stallAgent = resolveWatchdogNudgeAgent(member)
      this.client.session.promptAsync({
        sessionID: member.session_id,
        // M1 (TICKET-HARNESS-37): under silentLead (config.silentLead !== false)
        // the nudge steers to the task / board instead of demanding a lead-bound
        // report; the legacy phrasing is preserved for silentLead: false.
        parts: [{ type: "text", text: this.config?.silentLead !== false
          ? "[System]: You appear stalled — no progress detected. Refocus on your current task and drive it forward; record progress on the shared board and coordinate with peers via team_message, or wrap up your work."
          : "[System]: You appear stalled — no progress detected. Report your current status to the lead via team_message, or wrap up your work." }],
        agent: stallAgent,
        ...(stallModel ? { model: stallModel } : {}),
      }).then(() => {
        // Type guard: progressTracker is optional (constructed without one in
        // legacy/test harnesses) — optional chaining keeps the nudge-ack from
        // throwing into the .catch below when no tracker was threaded.
        this.progressTracker?.markReported(member.session_id)
      }).catch((err) => {
        log(`watchdog:stall:nudge-failed member=${member.name} team=${member.team_id} session=${member.session_id} err=${err instanceof Error ? err.message : String(err)}`)
      })

      // Notify the lead — model-aware wake when config is threaded (F2).
      this.notifyLead(
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

    // Identity columns for the explicit-`agent` nudge below (HARNESS-17) —
    // same resolution rule as checkStalled.
    const busy = this.db.query(
      `SELECT tm.team_id, tm.name, tm.session_id, tm.agent, t.lead_agent, t.lead_session_id
       FROM team_member tm
       JOIN team t ON tm.team_id = t.id
       WHERE t.status = 'active' AND tm.status = 'busy'`
    ).all() as Array<{ team_id: string; name: string; session_id: string; agent: string; lead_agent: string | null; lead_session_id: string }>

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
      // HARNESS-17: explicit `agent` — never omitted (persona sequester
      // defence, see resolveWatchdogNudgeAgent / checkStalled above).
      const chattyAgent = resolveWatchdogNudgeAgent(member)
      this.client.session.promptAsync({
        sessionID: member.session_id,
        // M1 (TICKET-HARNESS-37): silentLead-aware chatty nudge (legacy phrasing
        // kept for silentLead: false).
        parts: [{ type: "text", text: this.config?.silentLead !== false
          ? "[System]: You've sent several messages to teammates. Focus on completing your current task and advancing it on the shared board rather than over-coordinating."
          : "[System]: You've sent several messages to teammates. Focus on completing your task and send your results to the lead via team_message." }],
        agent: chattyAgent,
        ...(chattyModel ? { model: chattyModel } : {}),
      }).catch((err) => {
        log(`watchdog:chatty:nudge-failed member=${member.name} team=${member.team_id} session=${member.session_id} err=${err instanceof Error ? err.message : String(err)}`)
      })

      // Notify the lead — model-aware wake when config is threaded (F2).
      this.notifyLead(
        member.team_id,
        `Agent "${member.name}" is sending many peer messages and may be over-coordinating. Consider checking on them.`,
      )

      log(`watchdog:chatty member=${member.name} limit=${this.peerMessageLimit}`)
    }
  }

  /** Check for room inactivity and wake the Quality Gate reviewer to inspect and drive progress. */
  async checkRoomInactivity(): Promise<void> {
    if (this.roomInactivityThresholdMs === 0) return

    const activeTeams = this.db.query(
      "SELECT id, name FROM team WHERE status = 'active'"
    ).all() as Array<{ id: string; name: string }>

    const now = Date.now()

    for (const team of activeTeams) {
      // HARNESS-22 — pending-lead-decision pause. When a member raised an
      // emergency decision via the `decision_lead` tool (team.awaiting_lead_decision,
      // Migration 15) the LEAD was already woken directly. Waking Clara on top of
      // that would race the lead's deliberation and burn tokens, so the reviewer
      // autoawake is PAUSED until the lead deliberates (a lead-authored
      // team_message clears the flag — see clearAwaitingLeadDecision).
      const decisionRow = this.db.query(
        "SELECT awaiting_lead_decision FROM team WHERE id = ?"
      ).get(team.id) as { awaiting_lead_decision: number } | null
      if (decisionRow?.awaiting_lead_decision === 1) {
        log(`watchdog:room-inactivity:paused team=${team.id} reason=awaiting-lead-decision`)
        continue
      }

      // Check unfinished tasks on the board
      const taskCountRow = this.db.query(
        "SELECT COUNT(*) as count FROM team_task WHERE team_id = ? AND status IN ('pending', 'in_progress', 'in_review')"
      ).get(team.id) as { count: number } | null
      const unfinishedCount = taskCountRow?.count ?? 0
      if (unfinishedCount === 0) continue

      // Quality Gate reviewer lookup (agnostic: is_qa flag / clara retrocompat).
      const qa = getTeamQAMember(this.db, team.id)

      // HARNESS Correção 4 — never wake a QA that is itself working. Without
      // this guard a busy/running reviewer got a synthetic inactivity wake on
      // top of its in-flight turn (double-prompt race).
      if (qa && (qa.status === 'busy' || qa.executionStatus === 'starting' || qa.executionStatus === 'running')) {
        continue
      }

      // Any busy member (QA included) means the room is NOT inactive — the
      // previous `name != ?` exclusion wrongly woke the reviewer while it was
      // mid-task whenever the QA row itself was the only busy one.
      const busyMember = this.db.query(
        "SELECT name FROM team_member WHERE team_id = ? AND (status = 'busy' OR execution_status IN ('starting', 'running')) LIMIT 1"
      ).get(team.id) as { name: string } | null
      if (busyMember) continue

      const lastActivity = lastRoomActivity(this.db, team.id)
      if (lastActivity <= 0) continue

      const inactiveMs = now - lastActivity
      if (inactiveMs < this.roomInactivityThresholdMs) continue

      if (!qa?.sessionId) continue

      // Cooldown / Re-wake suppression:
      // If the QA reviewer was already nudged/woken for inactivity, and no activity occurred since then,
      // don't re-wake within roomInactivityThresholdMs.
      if (qa.lastNudgedAt) {
        const activeSinceNudge = lastActivity > qa.lastNudgedAt
        if (!activeSinceNudge && (now - qa.lastNudgedAt < this.roomInactivityThresholdMs)) {
          continue
        }
      }

      // Update last_nudged_at and reset reported_to_lead
      this.db.run(
        "UPDATE team_member SET last_nudged_at = ?, reported_to_lead = 0, time_updated = ? WHERE team_id = ? AND name = ?",
        [now, now, team.id, qa.name],
      )

      const wakeText = `[System: Room has been inactive for ${Math.round(inactiveMs / 1000)}s with ${unfinishedCount} unfinished task(s). Inspect the board, unblock, claim, or nudge teammates to drive progress.]`
      let promptText = wakeText
      let promptAgent: string | undefined = qa.agent

      if (qa.executionStatus === "standby") {
        const wake = resolveStandbyWake(this.db, team.id, qa.name, wakeText)
        if (wake.woke) {
          promptText = wake.text
          promptAgent = wake.agent ?? qa.agent
        }
      }

      const qaModel = getMemberModel(this.db, team.id, qa.name)
      this.client.session.promptAsync({
        sessionID: qa.sessionId,
        parts: [{ type: "text", text: promptText }],
        agent: promptAgent,
        synthetic: true,
        ...(qaModel ? { model: qaModel } : {}),
      }).catch((err) => {
        if (qa.executionStatus === "standby") {
          this.db.run(
            "UPDATE team_member SET execution_status = 'standby', time_updated = ? WHERE team_id = ? AND name = ? AND execution_status = 'starting'",
            [Date.now(), team.id, qa.name],
          )
        }
        log(`watchdog:room-inactivity:wake-clara:failed team=${team.id} err=${err instanceof Error ? err.message : String(err)}`)
      })

      log(`watchdog:room-inactivity:wake-clara team=${team.id} inactiveMs=${inactiveMs}`)
    }
  }

  /** Run a single check for stale busy members. */
  async check(): Promise<void> {
    await this.cleanupStaleWorktrees()
    await this.checkStalled()
    await this.checkChatty()
    await this.checkRoomInactivity()
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
      // TICKET-HARNESS-34 (A1): unrecoverable failure → forceWake punches
      // through silentLead (the member was just aborted; the lead must know).
      // (stall/chatty above deliberately omit it — non-fatal noise.)
      this.notifyLead(
        member.team_id,
        `Teammate "${member.name}" timed out after exceeding the busy time limit and was aborted. Their in-progress work has been released. Review their session, then re-spawn or reassign the task if needed.`,
        true,
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
    if (!this.timer) {
      // HARNESS-38 (M9): the tick body is async — an unhandled rejection inside
      // check() would otherwise escape the interval callback and crash the
      // process (Node's unhandledRejection). Swallow-and-log keeps the sweep
      // alive for the next tick, exactly like the room-inactivity timer below.
      this.timer = setInterval(() => {
        this.check().catch((err) => {
          log(`watchdog:check:err err=${err instanceof Error ? err.message : String(err)}`)
        })
      }, this.checkIntervalMs)
      // HARNESS-38 (M9): do not hold the event loop open. A periodic watchdog
      // must never be the reason the host process refuses to exit on shutdown;
      // unref() lets Node/Bun terminate while the timer stays armed for as long
      // as the process lives. Optional call keeps browser-like shims safe.
      this.timer?.unref?.()
    }
    if (!this.roomInactivityTimer && this.roomInactivityCheckMs > 0 && this.roomInactivityThresholdMs > 0) {
      this.roomInactivityTimer = setInterval(() => {
        this.checkRoomInactivity().catch((err) => {
          log(`watchdog:room-inactivity:err err=${err instanceof Error ? err.message : String(err)}`)
        })
      }, this.roomInactivityCheckMs)
      this.roomInactivityTimer?.unref?.()
    }
  }

  /**
   * HARNESS-38 (M9): idempotent teardown — clears every timer exactly once.
   * Safe to call repeatedly and from any lifecycle path (plugin dispose, room
   * shutdown, test harness). Kept as the canonical implementation; `stop()` is
   * the legacy name and simply delegates here.
   */
  dispose(): void {
    if (this.timer) {
      clearInterval(this.timer)
      this.timer = undefined
    }
    if (this.roomInactivityTimer) {
      clearInterval(this.roomInactivityTimer)
      this.roomInactivityTimer = undefined
    }
  }

  /** Stop the periodic check (legacy alias of {@link dispose}). Idempotent. */
  stop(): void {
    this.dispose()
  }

  /** Whether the watchdog is currently running. */
  isRunning(): boolean {
    return this.timer !== undefined || this.roomInactivityTimer !== undefined
  }
}
