import { createRequire } from "node:module"
import path from "node:path"
import type { Database } from "./db"
import type { PluginClient } from "./types"
import type { MemberRegistry } from "./state"
import type { ProgressTracker } from "./progress"
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
  /** How often to run the check. Defaults to 60s. */
  checkIntervalMs?: number
  /** Progress tracker for peer-message (chatty) rate detection. */
  progressTracker?: ProgressTracker
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
   * watchdog wake (chatty) uses the model-aware ladder (HARNESS-15 B / F2):
   * agent from team.lead_agent + fallback chain with step-down, instead of a
   * modelless wake riding the rate-limited primary.
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
 * Row shape produced by the busy-member scan in checkChatty — the identity
 * columns the nudge needs to address `promptAsync` with an explicit `agent`
 * (HARNESS-17).
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
 * Periodic watchdog for room supervision.
 *
 * TICKET-RELEASE-17 (F3): the TIME-BASED inactivity path is gone. There is no
 * more TTL/`timed_out` sweep (`busy` + `time_updated < cutoff` → abort, release
 * tasks, notifyLead) and no stall sweep (`checkStalled`): both counted time
 * since the last `team_member` write — not real progress — and killed members
 * doing legitimate long-running work (field evidence: a member aborted 19s into
 * a deliberate 8.5-minute measurement wait). What remains is:
 *
 *   - `cleanupStaleWorktrees()` — GC for shutdown/error worktrees;
 *   - `checkChatty()` — peer-message flood nudge (NOT inactivity);
 *   - `checkRoomInactivity()` — the Clara alert for an idle room with open
 *     tasks. Deliberately untouched.
 */
export class Watchdog {
  private readonly db: Database
  private readonly client: PluginClient
  private readonly registry: MemberRegistry
  private readonly checkIntervalMs: number
  private readonly progressTracker?: ProgressTracker
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
    this.checkIntervalMs = opts.checkIntervalMs ?? 60_000
    this.progressTracker = opts.progressTracker
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
   * TICKET-RELEASE-17: the only remaining caller is `checkChatty` — a
   * non-fatal over-coordination nudge whose message row is persisted and whose
   * proactive wake stays suppressed under `silentLead`. The old timeout path
   * (which punched through with a forced wake) is gone with the TTL sweep.
   */
  private notifyLead(teamId: string, message: string): void {
    notifyLead(this.client, this.db, teamId, message, {
      ...(this.config ? { config: this.config } : {}),
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

  /** Check for chatty agents sending too many peer messages. */
  async checkChatty(): Promise<void> {
    if (!this.progressTracker || this.peerMessageLimit === 0) return

    // Identity columns for the explicit-`agent` nudge below (HARNESS-17).
    const busy = this.db.query(
      `SELECT tm.team_id, tm.name, tm.session_id, tm.agent, t.lead_agent, t.lead_session_id
       FROM team_member tm
       JOIN team t ON tm.team_id = t.id
       WHERE t.status = 'active' AND tm.status = 'busy'`
    ).all() as Array<{ team_id: string; name: string; session_id: string; agent: string; lead_agent: string | null; lead_session_id: string }>

    for (const member of busy) {
      if (this.progressTracker.isChattyReported(member.session_id)) continue
      if (!this.progressTracker.isChatty(member.session_id, this.peerMessageLimit, this.peerMessageWindowMs)) continue

      // hasReportedCompletion() guard — the documented invariant every
      // promptAsync delivery path must honor (see hooks.ts:63): never nudge a
      // member that already reported completion.
      if (hasReportedCompletion(this.db, member.team_id, member.name)) {
        log(`watchdog:chatty:skip member=${member.name} team=${member.team_id} reason=already-reported-completion`)
        continue
      }

      this.progressTracker.markChattyReported(member.session_id)

      // Nudge the agent
      const chattyModel = getMemberModel(this.db, member.team_id, member.name)
      // HARNESS-17: explicit `agent` — never omitted (persona sequester
      // defence, see resolveWatchdogNudgeAgent above).
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

  /**
   * Run a single supervision tick.
   *
   * TICKET-RELEASE-17: NO time-based abort exists anymore. A member that stays
   * `busy` for hours (legitimate long task, instrumented wait, compaction) is
   * never swept: its card is never released and the lead is never woken by a
   * timeout that never happened. Room inactivity (Clara) and the chatty nudge
   * are preserved exactly as before.
   */
  async check(): Promise<void> {
    await this.cleanupStaleWorktrees()
    await this.checkChatty()
    await this.checkRoomInactivity()
  }

  /** Start the periodic check. Stale-worktree GC runs on every tick. */
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
