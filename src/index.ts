import type { Plugin } from "@opencode-ai/plugin"
import { Plugin as PluginV2 } from "@opencode/plugin"
import { setupEnsemble, type V2SetupContext } from "./v2-setup"
import { tool } from "@opencode-ai/plugin"
import { OpencodeClient } from "@opencode-ai/sdk/v2"
import path from "node:path"
import { mkdirSync } from "node:fs"
import { createDb, getDbPath } from "./db"
import { wrapThrowingClient } from "./client"
import { recoverStaleMembers, recoverUndeliveredMessages, recoverOrphanedWorktrees, recoverOrphanedBranches, recoverOrphanedTeams, rehydrateRegistry } from "./recovery"
import { MemberRegistry, DescendantTracker, PendingPurgeApprovals } from "./state"
import { isWorktreeInstance } from "./util"
import { handleSessionStatusEvent, handleSessionCreatedEvent, checkToolIsolation, shouldNudgeIdleMember, shouldAlarmFastIdle, shouldNudgeInReviewTasks, inReviewNudges, IN_REVIEW_NUDGE_MESSAGE, handleSessionErrorEvent, handleRetryModelFailover, hasBlockedAssignedTasks, hasInReviewAssignedTasks, hasActivePeerDialogue, hasPendingBoardTasks, hasOtherActiveMembers } from "./hooks"
// Re-exported so test harnesses (and the dist bundle) can exercise the nudge /
// fast-idle decisions against a real SQLite database without reimplementing them.
export { shouldNudgeIdleMember, shouldAlarmFastIdle, shouldNudgeInReviewTasks, inReviewNudges, IN_REVIEW_NUDGE_MESSAGE, hasBlockedAssignedTasks, hasInReviewAssignedTasks, hasActivePeerDialogue, hasPendingBoardTasks, hasOtherActiveMembers } from "./hooks"
// Silent rate-limit failover (zero-noise) — exported for the deterministic
// suites to drive and inspect the cooldown map without wall-clock sleeps.
export { handleRetryModelFailover, failoverCooldown, FAILOVER_COOLDOWN_MS } from "./hooks"
export { trackPrompt, abortInflight, endTracked } from "./v2-session"
export { executeTeamTasksReview, executeTeamTasksReject } from "./tools/team-tasks-complete"
export { executeTeamStandby, setMemberStandby } from "./tools/team-standby"
export { executeTeamClaim, claimTask } from "./tools/team-claim"
// HARNESS-48 — intra-card cooperative handover (Parceria de Bancada Sequencial).
export { executeTeamTaskHandover } from "./tools/team-task-handover"
// HARNESS-22 — emergency lead-decision escalation + the pending-decision helpers
// (mark/clear/has) the watchdog and message paths share.
export { executeDecisionLead, markAwaitingLeadDecision, clearAwaitingLeadDecision, hasAwaitingLeadDecision } from "./tools/decision-lead"
// Central QA-reviewer helpers (Migration 14) — exported so wake/CC/watchdog
// consumers and deterministic test harnesses can resolve the reviewer without
// hardcoding the string "clara". See src/qa-role.ts for the lookup contract.
export { isQAMember, getTeamQAMember, isSDETMEmber, getTeamSDETMember, type QAMemberInfo, type SDETMemberInfo } from "./qa-role"
export { buildTeammateSystemPrompt, buildLeadSystemPrompt } from "./system-prompt"
export { lastRoomActivity } from "./config"
export { Watchdog } from "./watchdog"
import { notifyTeamEvent, notifyWorkingProgress, notifyLead } from "./notify"
import { hasReportedCompletion } from "./messaging"
import { getMemberModel, resolveAgentForSession } from "./member-model"
import { buildLeadSystemPrompt, buildTeammateSystemPrompt, buildTeamCompactionContext } from "./system-prompt"
import { log, initLog } from "./log"
import { findTeamBySession } from "./types"
import { loadConfig } from "./config"
import { ProgressTracker } from "./progress"
import { ActivityBuffer, recordFromV2Event, recordFromToolBefore, recordFromToolAfter } from "./activity"
import { recordFileFromToolCall } from "./modified-files"
import { startDashboard } from "./dashboard"
import { executeTeamCreate } from "./tools/team-create"
import { executeTeamSpawn } from "./tools/team-spawn"
import { executeTeamMessage } from "./tools/team-message"
import { executeTeamBroadcast } from "./tools/team-broadcast"
import { executeTeamShutdown } from "./tools/team-shutdown"
import { executeTeamCleanup } from "./tools/team-cleanup"
import { executeTeamMerge } from "./tools/team-merge"
import { executeTeamTasksList } from "./tools/team-tasks-list"
import { executeTeamTasksAdd } from "./tools/team-tasks-add"
import { executeTeamTasksComplete } from "./tools/team-tasks-complete"
import { executeTeamClaim } from "./tools/team-claim"
import { executeTeamStandby } from "./tools/team-standby"
import { executeTeamTaskHandover } from "./tools/team-task-handover"
import { executeTeamResults } from "./tools/team-results"
import { executeTeamStatus } from "./tools/team-status"
import { executeTeamView } from "./tools/team-view"
import { executeDecisionLead } from "./tools/decision-lead"
import { resolveStandbyWake } from "./tools/shared"
import type { ToolDeps, } from "./types"
import { TokenBucket } from "./rate-limit"
import { Watchdog } from "./watchdog"

const DEFAULT_RATE_LIMIT_REFILL = 2
const DEFAULT_RATE_LIMIT_INTERVAL_MS = 1000
const DEFAULT_WATCHDOG_CHECK_MS = 60 * 1000 // 60 seconds

/**
 * opencode-ensemble plugin entry point.
 * Enables agent teams: multiple agents running in parallel with
 * peer-to-peer communication, shared task management, and coordinated execution.
 */
const plugin: Plugin = async (input) => {
  // Initialize SQLite database in the global OpenCode config directory.
  const dbPath = getDbPath()
  mkdirSync(path.dirname(dbPath), { recursive: true })
  const db = createDb(dbPath)

  // Load plugin configuration (global → project → env vars)
  const config = loadConfig(input.directory)

  // Initialize in-memory state
  const registry = new MemberRegistry()
  const tracker = new DescendantTracker()
  const purgeApprovals = new PendingPurgeApprovals()
  const nudgedMembers = new Set<string>()
  const progressTracker = new ProgressTracker()
  const activityBuffer = new ActivityBuffer()
  const wakeLeadTimestamps = new Map<string, number>()
  const WAKE_LEAD_COOLDOWN_MS = 5000

  // Extract the working HeyAPI transport from the plugin-provided v1 client and pass it
  // to the v2 OpencodeClient. The plugin framework provides a v1 client which stores its
  // HeyAPI transport as `_client` (underscore). The v2 constructor accepts it as `client`.
  type V2Transport = ConstructorParameters<typeof OpencodeClient>[0] extends { client?: infer C } ? C : never
  const pluginTransport = (input.client as unknown as { _client: V2Transport })._client
  const rawClient = new OpencodeClient({ client: pluginTransport })
  initLog(rawClient)
  // HARNESS-21: wire the persona resolver into the single client choke point.
  // Every `client.session.promptAsync` the plugin makes now gets the resolved
  // `agent` injected when the caller omitted it — by construction, not by
  // per-call-site discipline. This closes the legacy gaps (idle-without-report,
  // wake-lead) and any future path without touching their call sites.
  const client = wrapThrowingClient(rawClient, (sessionID) => resolveAgentForSession(db, sessionID))
  const deps: ToolDeps = { db, registry, tracker, purgeApprovals, client, directory: input.directory, config, progressTracker }

  // Recovery only runs for the main project instance — NOT for teammate worktree instances.
  // Worktree instances are created during session.create. Running recovery there makes HTTP
  // calls back to the server, which deadlocks because the server is still handling session.create.
  if (!isWorktreeInstance(input.directory)) {
    log("init:recovery:start (main instance)")

    // Reconciles teams whose lead session was deleted externally (not via
    // team_cleanup) -- otherwise they stay 'active' forever, blocking
    // team_create/team_cleanup for that name across restarts. See
    // recoverOrphanedTeams' own doc comment for the full mechanism.
    //
    // Fire-and-forget, NOT awaited: isSessionAlive() calls client.session.get(),
    // an HTTP call back to this same server. Awaiting it synchronously here --
    // before the server has finished bootstrapping -- reproduced a real,
    // confirmed deadlock (server never responds to ANY request, including
    // unrelated ones like /config) when a stale team from a prior run exists
    // for this project. Matches the existing pattern for the other three
    // non-critical recovery passes below, and the documented reason
    // recoverStaleMembers is skipped entirely for worktree instances two lines
    // up ("makes HTTP calls back to the server, which deadlocks"). isSessionAlive
    // itself also carries a bounded timeout as defense in depth.
    recoverOrphanedTeams(db, client, input.directory, registry).then((result) => {
      if (result.archived > 0) log(`init:recovery:orphaned-teams-archived=${result.archived}`)
    }).catch((err) => {
      log(`init:recover-orphaned-teams:failed err=${err instanceof Error ? err.message : String(err)}`)
    })

    const recovery = await recoverStaleMembers(db, client, input.directory)
    if (recovery.interrupted > 0) {
      log(`init:recovery:interrupted=${recovery.interrupted}`)
    }

    // Always rehydrate the in-memory registry from SQLite. The registry is
    // in-memory only and is wiped on every plugin restart. Without this,
    // teammates from a previous lifetime become invisible — every team_*
    // tool call from them throws "This session is not in a team." This is
    // the bug that surfaced on Desktop, where the Electron sidecar restarts
    // far more often than the CLI.
    const rehydrated = rehydrateRegistry(db, registry)
    if (rehydrated > 0) log(`init:registry:rehydrated members=${rehydrated}`)

    recoverUndeliveredMessages(db, client, registry).catch((err) => {
      log(`init:recover-messages:failed err=${err instanceof Error ? err.message : String(err)}`)
    })
    recoverOrphanedWorktrees(db, client).catch((err) => {
      log(`init:recover-worktrees:failed err=${err instanceof Error ? err.message : String(err)}`)
    })
    recoverOrphanedBranches(db, input.directory).catch((err) => {
      log(`init:recover-branches:failed err=${err instanceof Error ? err.message : String(err)}`)
    })
    log("init:recovery:done")

    // Start dashboard server (main instance only, not worktree instances)
    if (config.dashboardPort !== 0) {
      startDashboard(db, config.dashboardPort, { activityBuffer, client }).catch((err) => {
        log(`init:dashboard:failed err=${err instanceof Error ? err.message : String(err)}`)
      })
    }
  } else {
    log(`init:skip-recovery (worktree instance: ${input.directory})`)
  }

  // Initialize rate limiter — config value already accounts for env var override
  const rateLimiter = new TokenBucket({
    capacity: config.rateLimitCapacity,
    refillRate: DEFAULT_RATE_LIMIT_REFILL,
    refillIntervalMs: DEFAULT_RATE_LIMIT_INTERVAL_MS,
  })

  // Initialize watchdog — config value already accounts for env var override.
  // TICKET-HARNESS-36 (A3): the Watchdog is created and started ONLY on the main
  // project instance. Teammate worktree instances share the same global SQLite
  // database; a concurrent watchdog there would run duplicate TTL/stall/chatty
  // sweeps against the same rows (double aborts, double board releases). The
  // same isWorktreeInstance guard already skips recovery/dashboard above.
  let watchdog: Watchdog | undefined
  if (!isWorktreeInstance(input.directory)) {
    watchdog = new Watchdog({
      db, client, registry,
      ttlMs: config.timeoutMs,
      checkIntervalMs: DEFAULT_WATCHDOG_CHECK_MS,
      progressTracker,
      stallThresholdMs: config.stallThresholdMs,
      stallMinSteps: config.stallMinSteps,
      stallTokenThreshold: config.stallTokenThreshold,
      cwd: input.directory,
      peerMessageLimit: config.peerMessageLimit,
      peerMessageWindowMs: config.peerMessageWindowMs,
      roomInactivityThresholdMs: config.roomInactivityThresholdMs,
      roomInactivityCheckMs: config.roomInactivityCheckMs,
      // F2: thread config so watchdog notifyLead wakes use the model-aware
      // ladder (agent + fallback chain step-down) instead of a modelless wake.
      config,
    })
    watchdog.start()
  } else {
    log(`init:skip-watchdog (worktree instance: ${input.directory})`)
  }

  return {
    // Event hook — drives state machine transitions + descendant tracking + toasts
    async event({ event }) {
      if (event.type === "session.status") {
        const { sessionID, status } = event.properties
        const statusType = status.type as "idle" | "busy" | "retry"
        const retryPayload = statusType === "retry"
          ? (status as { attempt: number; message: string; action?: { reason: string; provider: string; title: string; message: string; label: string; link?: string }; next: number })
          : undefined
        const transition = handleSessionStatusEvent(db, registry, sessionID, statusType, retryPayload)

        // Fire toast notifications for meaningful transitions
        if (transition) {
          if (transition.to === "shutdown") {
            notifyTeamEvent(client, "shutdown", { memberName: transition.memberName })
          } else if (transition.to === "ready" && transition.from === "busy") {
            notifyTeamEvent(client, "completed", { memberName: transition.memberName })

            // Fast-idle detection: if agent went idle within 15s of spawn with zero messages,
            // the model likely failed silently (auth error, invalid model, etc.)
            // The whole verdict lives in shouldAlarmFastIdle() (src/hooks.ts): it returns
            // false for members in execution_status 'standby' and for members holding
            // tasks blocked on unresolved dependencies, so their early silence never
            // wakes the lead nor raises a false "failed to spawn" alarm.
            const fastIdleKey = `fastidle:${transition.teamId}:${transition.memberName}`
            if (!nudgedMembers.has(fastIdleKey) && shouldAlarmFastIdle(db, transition.teamId, transition.memberName)) {
              nudgedMembers.add(fastIdleKey)
              const memberInfo = db.query(
                "SELECT time_created, model FROM team_member WHERE team_id = ? AND name = ?"
              ).get(transition.teamId, transition.memberName) as { time_created: number; model: string | null } | null
              const spawnAge = memberInfo ? Date.now() - memberInfo.time_created : 0
              const modelInfo = memberInfo?.model ? ` (model: ${memberInfo.model})` : ""
              log(`fast-idle: ${transition.memberName} went idle ${Math.round(spawnAge / 1000)}s after spawn with 0 messages${modelInfo}`)
              notifyLead(
                client,
                db,
                transition.teamId,
                `Warning: Teammate "${transition.memberName}" went idle immediately after spawning with no output${modelInfo}. This usually means the model failed to start (authentication error, invalid model, or provider issue). Check your API key and model configuration, then retry the spawn.`,
                // HARNESS-15 B: model-aware wake — the agent resolves from
                // options/team.lead_agent and the model ladder from the
                // config's fallback chain (primary → next).
                { config },
              )
              client.tui.showToast({
                title: "Team",
                message: `${transition.memberName} failed to produce output${modelInfo}`,
                variant: "warning",
                duration: 8000,
              }).catch(() => { /* TUI may not be available */ })
            }

            // Nudge teammate if they went idle without reporting to the lead (once only)
            // Skip if they already reported completion (issue #3 — prevents re-waking completed teammates)
            const nudgeKey = `${transition.teamId}:${transition.memberName}`
            if (!nudgedMembers.has(nudgeKey) && shouldNudgeIdleMember(db, transition.teamId, transition.memberName, config) && !hasReportedCompletion(db, transition.teamId, transition.memberName)) {
              nudgedMembers.add(nudgeKey)
              log(`nudge:idle-without-report name=${transition.memberName}`)
              const nudgeModel = getMemberModel(db, transition.teamId, transition.memberName)
              client.session.promptAsync({
                sessionID,
                parts: [{ type: "text", text: "[System]: You completed your work but did not report results. Send your findings to the lead via team_message now." }],
                ...(nudgeModel ? { model: nudgeModel } : {}),
              }).catch((err) => {
                log(`nudge:idle-without-report:failed name=${transition.memberName} team=${transition.teamId} err=${err instanceof Error ? err.message : String(err)}`)
              })
            }

            // In-review tasks nudge: if tasks remain in review and member went idle without completing/rejecting
            const reviewTaskId = shouldNudgeInReviewTasks(db, transition.teamId, transition.memberName)
            if (reviewTaskId) {
              const reviewNudgeKey = `${transition.teamId}:${transition.memberName}:${reviewTaskId}`
              const currentCount = inReviewNudges.get(reviewNudgeKey) ?? 0
              inReviewNudges.set(reviewNudgeKey, currentCount + 1)
              log(`nudge:in-review-tasks name=${transition.memberName} task=${reviewTaskId} attempt=${currentCount + 1}`)
              const nudgeModel = getMemberModel(db, transition.teamId, transition.memberName)
              // HARNESS-17 (Diana dívida #2): agent EXPLÍCITO do membro-alvo.
              // Omitir `agent` faz o servidor OpenCode assumir o agente default
              // ("dante") e SOBRESCREVER session.agent — sequestro da persona e
              // perda das permissões de ferramentas exclusivas. Fonte: coluna
              // team_member.agent; se a sessão alvo for a do lead vale
              // team.lead_agent. Nunca omitir o campo.
              const nudgeTarget = db.query(
                `SELECT tm.agent AS agent, t.lead_session_id AS lead_session_id, t.lead_agent AS lead_agent
                 FROM team_member tm JOIN team t ON tm.team_id = t.id
                 WHERE tm.team_id = ? AND tm.name = ?`
              ).get(transition.teamId, transition.memberName) as { agent: string | null; lead_session_id: string | null; lead_agent: string | null } | null
              const nudgeAgent = nudgeTarget
                ? (sessionID === nudgeTarget.lead_session_id ? nudgeTarget.lead_agent : nudgeTarget.agent)
                : null
              client.session.promptAsync({
                sessionID,
                parts: [{ type: "text", text: IN_REVIEW_NUDGE_MESSAGE }],
                ...(nudgeAgent ? { agent: nudgeAgent } : {}),
                ...(nudgeModel ? { model: nudgeModel } : {}),
                synthetic: true,
              }).catch((err) => {
                log(`nudge:in-review-tasks:failed name=${transition.memberName} team=${transition.teamId} err=${err instanceof Error ? err.message : String(err)}`)
              })
            }
          } else if (transition.to === "error") {
            notifyTeamEvent(client, "error", { memberName: transition.memberName })
          } else if (transition.to === "busy") {
            // Fresh busy period (ready/error -> busy) — give checkStalled a baseline
            // that doesn't depend on a step-finish event having landed yet. Without
            // this, a member whose first action is one long-running tool call is
            // never detected as stalled until that call itself returns.
            progressTracker.recordBusyStart(sessionID)
          } else if (transition.to === "retry") {
            // Teammate is being rate-limited — evaluate SILENT model failover
            // FIRST (zero-noise per HARNESS-13: "switched"/"suppressed"/
            // "exhausted" never wake the lead; exhaustion only toasts).
            const failover = await handleRetryModelFailover(
              db,
              registry,
              client,
              config,
              sessionID,
              retryPayload,
            ).catch((err) => {
              log(`failover:event:failed session=${sessionID} err=${err instanceof Error ? err.message : String(err)}`)
              return undefined
            })
            const failoverInfo = failover?.action === "switched"
              ? ` — switched to ${failover.toModel}`
              : failover?.action === "exhausted"
                ? " — no fallback model left"
                : ""
            try {
              await client.tui.showToast({
                title: "Team",
                message: `${transition.memberName} is being rate-limited${failoverInfo}`,
                variant: "warning",
                duration: 3000,
              })
            } catch { /* TUI may not be available */ }
          } else if (transition.to === "busy_while_shutdown") {
            // Session went busy after shutdown was requested — re-issue abort
            // Branch should already be preserved by the graceful shutdown path,
            // but verify and re-preserve if needed
            const member = deps.db.query(
              "SELECT worktree_branch, name, team_id FROM team_member WHERE session_id = ?"
            ).get(sessionID) as { worktree_branch: string | null; name: string; team_id: string } | null
            if (member?.worktree_branch && !member.worktree_branch.startsWith("ensemble/preserved/")) {
              const { getTeamResourceParts, preserveBranch: preserve, preservedBranchName: branchName } = await import("./tools/merge-helper")
              const resource = getTeamResourceParts(deps.db, member.team_id)
              const safeBranch = branchName(resource.projectName, resource.teamName, resource.teamId, member.name)
              const ok = await preserve(member.worktree_branch, safeBranch, deps.directory)
              if (ok) {
                deps.db.run("UPDATE team_member SET worktree_branch = ? WHERE team_id = ? AND name = ?",
                  [safeBranch, member.team_id, member.name])
                log(`busy_while_shutdown:branch:preserved src=${member.worktree_branch} target=${safeBranch}`)
              }
            }
            try {
              await client.session.abort({ sessionID })
            } catch { /* best effort */ }
          }

          // Show working progress after every transition so the user sees who's still active
          await notifyWorkingProgress(client, db, transition.teamId)
        }

        // SEAM wiring (V1): non-member sessions — e.g. the Diana isolated
        // blind-review session — and LEAD sessions (HARNESS-15 A: rate-
        // limited lead with an explicit fallbackModelsByAgent chain) produce
        // NO transition (handleSessionStatusEvent bails on the registry
        // lookup). Evaluate the isolated failover path for their retries: it
        // applies the per-agent chain from fallbackModelsByAgent when one
        // exists for the session's agent, and no-ops otherwise (the global
        // chain NEVER hijacks — for the lead it never sequesters). Zero-noise
        // preserved (HARNESS-13): toasts fire only when the failover ACTED
        // ("switched"/"exhausted"); "suppressed" stays silent; the lead is
        // never woken from a failover path. The member path above
        // (transition.to === "retry") is untouched.
        if (!transition && statusType === "retry") {
          const isolatedFailover = await handleRetryModelFailover(
            db,
            registry,
            client,
            config,
            sessionID,
            retryPayload,
          ).catch((err) => {
            log(`failover:event:failed session=${sessionID} err=${err instanceof Error ? err.message : String(err)}`)
            return undefined
          })
          if (isolatedFailover && isolatedFailover.action !== "suppressed") {
            const isolatedInfo = isolatedFailover.action === "switched"
              ? ` switched to ${isolatedFailover.toModel}`
              : " chain exhausted"
            try {
              await client.tui.showToast({
                title: "Team",
                message: `Session "${isolatedFailover.memberName}" is rate-limited —${isolatedInfo}`,
                variant: "warning",
                duration: 3000,
              })
            } catch { /* TUI may not be available */ }
          }
        }

        // Wake the lead when it goes idle and has pending messages.
        // The system prompt transform delivers the actual message content.
        // DEF-3 (vazamento do Silent Lead): while silentLead is on, the SQLite row
        // written by team_message IS the delivery channel and board closure is the
        // only legitimate wake. Without this guard the idle hook re-fires every 5s
        // (WAKE_LEAD_COOLDOWN_MS) and silently breaks "Lead Silencioso".
        if (statusType === "idle") {
          const team = db.query("SELECT id FROM team WHERE lead_session_id = ? AND status = 'active'").get(sessionID) as { id: string } | null
          if (team) {
            const pending = db.query("SELECT COUNT(*) as c FROM team_message WHERE team_id = ? AND to_name = 'lead' AND delivered = 0").get(team.id) as { c: number }
            // Skip wake if all teammates are done or if we woke recently (issue #3 — breaks completion loop)
            const allDone = (db.query(
              "SELECT COUNT(*) as c FROM team_member WHERE team_id = ? AND status NOT IN ('ready', 'shutdown', 'error')"
            ).get(team.id) as { c: number }).c === 0
            const lastWake = wakeLeadTimestamps.get(team.id) ?? 0
            if (pending.c > 0 && !allDone && !config.silentLead && Date.now() - lastWake > WAKE_LEAD_COOLDOWN_MS) {
              wakeLeadTimestamps.set(team.id, Date.now())
              log(`wake-lead: ${pending.c} pending messages, sending promptAsync`)
              client.session.promptAsync({
                sessionID,
                parts: [{ type: "text", text: `[System: ${pending.c} new team message(s) available]` }],
              }).catch((err) => {
                log(`wake-lead:failed err=${err instanceof Error ? err.message : String(err)}`)
              })
            }
          }

          // Also flush peer messages for teammates that just went idle
          // Only flush messages older than 5s to avoid double-delivery with the direct promptAsync path
          const member = db.query(
            `SELECT tm.team_id, tm.name, tm.agent AS member_agent, t.lead_session_id AS lead_session_id, t.lead_agent AS lead_agent
             FROM team_member tm
             JOIN team t ON tm.team_id = t.id
             WHERE tm.session_id = ? AND t.status = 'active'`
          ).get(sessionID) as { team_id: string; name: string; member_agent: string | null; lead_session_id: string | null; lead_agent: string | null } | null
          if (member && !hasReportedCompletion(db, member.team_id, member.name)) {
            const staleThreshold = Date.now() - 5000
            const peerMsgs = db.query(
              "SELECT COUNT(*) as c FROM team_message WHERE team_id = ? AND to_name = ? AND delivered = 0 AND time_created < ?"
            ).get(member.team_id, member.name, staleThreshold) as { c: number }
            if (peerMsgs.c > 0) {
              log(`wake-peer: ${member.name} has ${peerMsgs.c} pending peer messages`)
              const peerModel = getMemberModel(db, member.team_id, member.name)
              // HARNESS-17 (Diana dívida #2): agent EXPLÍCITO — omitir `agent`
              // faz o servidor OpenCode assumir o default ("dante") e
              // SOBRESCREVER session.agent, sequestrando a persona do membro.
              // Fonte: team_member.agent; sessão do lead → team.lead_agent.
              const peerAgent = sessionID === member.lead_session_id ? member.lead_agent : member.member_agent
              // TICKET-HARNESS-36 (P3): a peer wake must be able to revive a
              // member that is in standby WITHOUT amnesia. resolveStandbyWake
              // prepends the member's spawn_context and flips execution_status
              // 'standby' -> 'starting'. For a non-standby member it is a
              // byte-identical pass-through, so the explicit agent below still
              // re-asserts the member's persona (HARNESS-17).
              client.session.promptAsync({
                sessionID,
                parts: [{ type: "text", text: resolveStandbyWake(db, member.team_id, member.name, `[System: ${peerMsgs.c} new message(s) from teammates]`).text }],
                ...(peerAgent ? { agent: peerAgent } : {}),
                ...(peerModel ? { model: peerModel } : {}),
              }).catch((err) => {
                log(`wake-peer:failed err=${err instanceof Error ? err.message : String(err)}`)
              })
            }
          }
        }
      }

      if (event.type === "session.created") {
        const info = event.properties.info
        if (info.parentID) {
          handleSessionCreatedEvent(tracker, info.id, info.parentID)
        }
      }

      // Surface teammate session errors as system messages to the lead.
      // Without this, errors during a teammate's prompt loop (auth failure,
      // tool failure, model error, etc.) are invisible to the lead — the
      // teammate just appears stuck.
      if (event.type === "session.error") {
        const props = event.properties as { sessionID?: string; error?: { name?: string; data?: { message?: string } } }
        // HARNESS-15 B: thread the config so the notifyLead wake inside is
        // model-aware (agent + fallback-chain ladder).
        handleSessionErrorEvent(db, registry, client, props.sessionID, props.error, config)
      }

      // Track per-step output tokens for stall detection
      if (event.type === "message.part.updated") {
        const part = (event.properties as { part?: { type?: string; sessionID?: string; tokens?: { output?: number } } }).part
        if (part?.type === "step-finish" && part.sessionID && part.tokens?.output !== undefined) {
          if (registry.getBySession(part.sessionID)) {
            progressTracker.recordStep(part.sessionID, part.tokens.output)
          }
        }
      }

      // Capture activity for dashboard verbose view (best-effort, v2 event types)
      // Only shell and step events are recorded here — tool calls/results are
      // recorded via tool.execute.before/after to avoid duplicate entries.
      recordFromV2Event(
        event as unknown as { type: string; properties: { sessionID?: string; tool?: string; input?: string; content?: string; title?: string; error?: string; command?: string; exitCode?: number; cost?: number; tokens?: { input?: number; output?: number } } },
        registry,
        activityBuffer,
      )
    },

    // Sub-agent isolation + rate limiting hook
    "tool.execute.before": async (input, _output) => {
      checkToolIsolation(registry, tracker, input.tool, input.sessionID, db)
      // Rate limit team tools that trigger LLM inference
      if (input.tool.startsWith("team_")) {
        if (!rateLimiter.tryConsume()) {
          await rateLimiter.waitForToken()
        }
      }
      // Record tool call activity for team member sessions
      recordFromToolBefore(input, registry, activityBuffer)
    },

    "tool.execute.after": async (input, output) => {
      if (input.tool === "question") {
        purgeApprovals.recordQuestionAnswer(input.sessionID, output.output, input.args)
      }
      // TICKET-32A: ledger every file this room's session mutates
      // (edit/write/patch/...) so the Portão 1 auto-commit can commit a repo
      // strictly with the room-touched files — never a blind `git add -A`.
      recordFileFromToolCall(db, registry, input.sessionID, input.tool, input.args)
      // Record tool result activity for team member sessions
      recordFromToolAfter(input, output, registry, activityBuffer)
    },

    // System prompt injection — keeps lead aware of team state, reminds teammates of role
    "experimental.chat.system.transform": async (input, output) => {
      if (!input.sessionID) return
      const teamInfo = findTeamBySession(db, registry, input.sessionID)
      if (!teamInfo) return
      log(`system-prompt:transform role=${teamInfo.role} session=${input.sessionID}`)
      const prompt = teamInfo.role === "lead"
        ? buildLeadSystemPrompt(db, teamInfo.teamId, config)
        : buildTeammateSystemPrompt(db, teamInfo.teamId, teamInfo.memberName ?? "unknown", config)
      log(`system-prompt:injected role=${teamInfo.role} len=${prompt.length}`)
      output.system.push(prompt)
    },

    // Compaction safety — preserves team context when sessions get long
    "experimental.session.compacting": async (input, output) => {
      const teamInfo = findTeamBySession(db, registry, input.sessionID)
      if (!teamInfo) return
      const context = buildTeamCompactionContext(db, teamInfo.teamId, teamInfo.role, teamInfo.memberName, config)
      output.context.push(context)
    },

    // Team-aware shell environment for scripts and hooks
    "shell.env": async (input, output) => {
      if (!input.sessionID) return
      const teamInfo = findTeamBySession(db, registry, input.sessionID)
      if (!teamInfo) return
      output.env.ENSEMBLE_TEAM = teamInfo.teamName
      output.env.ENSEMBLE_ROLE = teamInfo.role
      if (teamInfo.memberName) {
        output.env.ENSEMBLE_MEMBER = teamInfo.memberName
        const member = db.query("SELECT worktree_branch, worktree_dir FROM team_member WHERE team_id = ? AND name = ?")
          .get(teamInfo.teamId, teamInfo.memberName) as { worktree_branch: string | null; worktree_dir: string | null } | null
        if (member?.worktree_branch) {
          output.env.ENSEMBLE_BRANCH = member.worktree_branch
        }
        if (member?.worktree_dir) {
          output.env.ENSEMBLE_WORKTREE_DIR = member.worktree_dir
        }
      }
    },

    // Register all team tools
    tool: {
      team_create: tool({
        description: "Create a new agent team. You become the team lead. Use this before spawning teammates. " +
          "For engineering demands, convoke the canonical squad via team_spawn: Implementador, Hugo (deterministic tests) and Clara (Quality Gate).",
        args: {
          name: tool.schema.string().describe("Team name (lowercase alphanumeric with hyphens, 1-64 chars)"),
          project_name: tool.schema.string().optional().describe("Project display name for first use of this working directory. If omitted, a short random name is generated."),
        },
        async execute(args, ctx) {
          const result = await executeTeamCreate(deps, args, ctx.sessionID)
          ctx.metadata({ title: `Created team: ${args.name}` })
          return result
        },
      }),

      team_spawn: tool({
        description: "Spawn a new teammate that works in parallel. With standby: false it starts immediately on the given prompt; with standby: true it is registered without sending its init prompt (woken later by the first team_message/broadcast). " +
          "Each teammate gets their own git worktree for file isolation. " +
          "Teammates work asynchronously; under silentLead they do not wake you on each completion, so track progress on the board. " +
          "Dispatch Hugo for deterministic tests (born in standby by default) and Clara for the Quality Gate.",
        args: {
          name: tool.schema.string().describe("Teammate name (lowercase alphanumeric with hyphens)"),
          agent: tool.schema.string().default("build").describe("Agent type (e.g. 'build', 'plan', 'explore')"),
          prompt: tool.schema.string().describe("Task instructions for the teammate"),
          model: tool.schema.string().optional().describe("Model in provider/model format (optional, uses default)"),
          claim_task: tool.schema.string().optional().describe("Task ID to auto-claim for this teammate (optional)"),
          worktree: tool.schema.boolean().default(true).describe("Create a git worktree for file isolation (default: true, set false for read-only agents)"),
          plan_approval: tool.schema.boolean().default(false).describe("Require teammate to send a plan for approval before writing files (default: false)"),
          standby: tool.schema.boolean().default(false).describe("Register the teammate WITHOUT sending its init prompt (zero tokens at birth). Stored as ready/standby with the full prompt in spawn_context; woken with the context prepended by the first team_message/team_broadcast (default: false)"),
          role: tool.schema.enum(["sdet", "qa", "member"]).optional().describe("Teammate role: 'sdet' marks the deterministic-test engineer (exclusive per room, persists role='sdet'; also auto-detected for agent 'hugo'), 'qa' marks the Quality Gate reviewer (exclusive per room, persists is_qa=1), 'member' is a regular teammate (default: auto-detect from agent/persona)"),
          is_qa: tool.schema.boolean().optional().describe("Explicitly flag this teammate as the Quality Gate reviewer (stored in team_member.is_qa). Omitted = auto-detect (agent 'clara' or base persona 'clara' → QA)"),
        },
        async execute(args, ctx) {
          const result = await executeTeamSpawn(deps, args, ctx.sessionID)
          ctx.metadata({ title: `Spawned ${args.name} (${args.agent})` })
          return result
        },
      }),

      team_message: tool({
        description: "Send a message to a specific teammate or to the lead. Use 'lead' to message the team lead. " +
          "Lead only: pass 'model' (provider/model) to update a teammate's model in-place — it applies on their next turn. " +
          "When updating a model, 'text' is optional; omit it to change the model without sending a message.",
        args: {
          to: tool.schema.string().describe("Recipient name ('lead' or teammate name)"),
          text: tool.schema.string().optional().describe("Message content (max 10KB). Optional only when 'model' is provided."),
          approve: tool.schema.boolean().optional().describe("Approve a teammate's plan (only when recipient has plan_approval='pending')"),
          reject: tool.schema.string().optional().describe("Reject a teammate's plan with reason (only when recipient has plan_approval='pending')"),
          force: tool.schema.boolean().optional().describe("Lead only. Re-activate a teammate who already reported task completion (normally their session won't be woken again). Use for legitimate follow-on work — e.g. the next round of a multi-round debate — not for courtesy replies."),
          model: tool.schema.string().optional().describe("Lead only: update the recipient teammate's model in-place, in 'provider/model' format (e.g. 'anthropic/claude-sonnet')."),
        },
        async execute(args, ctx) {
          const result = await executeTeamMessage(deps, args, ctx.sessionID)
          // Track message activity for stall detection
          progressTracker.recordMessage(ctx.sessionID)
          // Track peer messages for chatty detection
          if (args.to !== "lead") progressTracker.recordPeerMessage(ctx.sessionID)
          ctx.metadata({ title: args.model ? `Set ${args.to} model → ${args.model}` : `Message → ${args.to}` })
          return result
        },
      }),

      team_broadcast: tool({
        description: "Send a message to all teammates and the lead (excluding yourself).",
        args: {
          text: tool.schema.string().describe("Message content (max 10KB)"),
        },
        async execute(args, ctx) {
          const result = await executeTeamBroadcast(deps, args, ctx.sessionID)
          // Track broadcast activity for stall detection AND chatty detection --
          // a broadcast reaches every teammate at once, arguably the most
          // "chatty" action possible, and was previously invisible to
          // checkChatty()'s peer-message rate limit (recordPeerMessage was never
          // called here, only recordMessage).
          progressTracker.recordMessage(ctx.sessionID)
          progressTracker.recordPeerMessage(ctx.sessionID)
          ctx.metadata({ title: "Broadcast to team" })
          return result
        },
      }),

      team_tasks_list: tool({
        description: "View the shared team task board. Use this to check task status, not to wait for teammates. Under silentLead you are not woken for each individual completion — rely on the board and team_results.",
        args: {},
        async execute(_args, ctx) {
          const result = await executeTeamTasksList(deps, ctx.sessionID)
          const count = result === "No tasks on the board." ? 0 : result.split("\n").length
          ctx.metadata({ title: count > 0 ? `Task board (${count} tasks)` : "Task board (empty)" })
          return result
        },
      }),

      team_tasks_add: tool({
        description: "Add tasks to the shared team task board so teammates can see what work is available and claim it.",
        args: {
          tasks: tool.schema.array(tool.schema.object({
            content: tool.schema.string().describe("Task description"),
            priority: tool.schema.enum(["high", "medium", "low"]).default("medium").describe("Task priority"),
            depends_on: tool.schema.array(tool.schema.string()).optional().describe("Task IDs this depends on"),
          })).describe("Tasks to add"),
          sequential: tool.schema.boolean().optional().describe("If true, tasks are added in sequence where each task depends on the previous one. Defaults to false (tasks are independent/parallel unless depends_on is explicitly specified)."),
        },
        async execute(args, ctx) {
          const result = await executeTeamTasksAdd(deps, args, ctx.sessionID)
          ctx.metadata({ title: `Added ${args.tasks.length} task${args.tasks.length !== 1 ? "s" : ""}` })
          return result
        },
      }),

      team_tasks_complete: tool({
        description: "Mark a task as completed on the shared board, or submit/reject a review. This unblocks any tasks that depend on it.",
        args: {
          task_id: tool.schema.string().describe("ID of the task to mark complete, submit for review, or reject"),
          action: tool.schema.enum(["complete", "submit_review", "reject", "sdet_pass"]).optional().describe("Action to take: 'complete' (default), 'submit_review' (in_progress -> in_review), 'reject' (in_review -> in_progress), or 'sdet_pass' (SDET-only: record a green deterministic suite and wake the Quality Gate). Any other value is rejected with INVALID_ACTION."),
          notes: tool.schema.string().optional().describe("Review notes or rejection reason"),
        },
        async execute(args, ctx) {
          const result = await executeTeamTasksComplete(deps, args, ctx.sessionID)
          // Track task completion for stall detection
          progressTracker.recordTaskComplete(ctx.sessionID)
          ctx.metadata({ title: `Completed task` })
          return result
        },
      }),

      team_claim: tool({
        description: "Claim a pending task from the shared task list. Only unclaimed, unblocked tasks can be claimed.",
        args: {
          task_id: tool.schema.string().describe("ID of the task to claim"),
        },
        async execute(args, ctx) {
          const result = await executeTeamClaim(deps, args, ctx.sessionID)
          ctx.metadata({ title: `Claimed task` })
          return result
        },
      }),

      team_standby: tool({
        description: "Suspend active execution and enter standby mode voluntarily until unblocked or awakened by new messages or task dependencies.",
        args: {
          reason: tool.schema.string().optional().describe("Reason for entering standby"),
        },
        async execute(args, ctx) {
          const result = await executeTeamStandby(deps, args, ctx.sessionID)
          ctx.metadata({ title: "Entered standby" })
          return result
        },
      }),

      team_task_handover: tool({
        description: "Hand over an in_progress task you own to another teammate (cooperative intra-card baton pass). " +
          "The card's assignee becomes 'to', the runtime wakes them with your notes, and you enter standby with a clean context window. " +
          "Use it to work sequentially on the SAME card without write contention instead of working outside your specialty.",
        args: {
          task_id: tool.schema.string().describe("ID of the in_progress task to hand over"),
          to: tool.schema.string().describe("Teammate name to receive the baton (must be in the room, not yourself)"),
          notes: tool.schema.string().optional().describe("Context/notes passed to the receiver (stored on the card)"),
        },
        async execute(args, ctx) {
          const result = await executeTeamTaskHandover(deps, args, ctx.sessionID)
          ctx.metadata({ title: `Handed over to ${args.to}` })
          return result
        },
      }),

      team_results: tool({
        description: "Retrieve full message content from teammates. Returns unread messages and marks them as read. Use this after receiving a truncated message notification.",
        args: {
          from: tool.schema.string().optional().describe("Filter messages by sender name (optional, returns all if omitted)"),
        },
        async execute(args, ctx) {
          const result = await executeTeamResults(deps, args, ctx.sessionID)
          ctx.metadata({ title: `Results${args.from ? ` from ${args.from}` : ""}` })
          return result
        },
      }),

      team_shutdown: tool({
        description: "Request a teammate to shut down. The teammate finishes current work then stops. " +
          "Pass force: true to abort immediately without waiting.",
        args: {
          member: tool.schema.string().describe("Teammate name to shut down"),
          force: tool.schema.boolean().default(false).describe("Force immediate abort without waiting for current work to finish"),
        },
        async execute(args, ctx) {
          const result = await executeTeamShutdown(deps, args, ctx.sessionID)
          // Clean up progress tracking for the shut-down member.
          // M5 (TICKET-HARNESS-37): scope the lookup to the CALLER's team. A bare
          // `name = ?` matched same-named members in OTHER active teams, so the
          // cleanup could evict the wrong session's tracker/buffer while the real
          // shut-down member's entries leaked. The teamId is resolved from the
          // current session via findTeamBySession.
          const callerTeam = findTeamBySession(db, registry, ctx.sessionID)
          if (callerTeam) {
            const member = deps.db.query(
              "SELECT session_id FROM team_member WHERE team_id = ? AND name = ? AND status IN ('shutdown', 'shutdown_requested')"
            ).get(callerTeam.teamId, args.member) as { session_id: string } | null
            if (member) {
              progressTracker.remove(member.session_id)
              activityBuffer.remove(member.session_id)
            }
          }
          const hasWarning = result.includes("uncommitted")
          ctx.metadata({ title: hasWarning ? `${args.member} shut down — uncommitted changes` : `${args.member} shut down` })
          return result
        },
      }),

      team_cleanup: tool({
        description: "Clean up the current team, or purge archived teams after human approval. " +
          "Omit purge for normal cleanup. Pass purge with archived team names, or ['*'] for all archived teams. " +
          "First purge call returns a preview, exact approval and denial options, and confirmation token only. " +
          "Archived worktree/workspace references and stale Ensemble-owned branches are shown in the preview and cleaned during confirmed purge. " +
          "Use the question tool with those exact options, then call again with confirm_purge: true and confirm_token only if the user selected the exact approval option.",
        args: {
          force: tool.schema.boolean().default(false).describe("Force cleanup even if members are active (will abort them)"),
          acknowledge_uncommitted: tool.schema.boolean().default(false),
          purge: tool.schema.array(tool.schema.string()).optional().describe("Archived team names to permanently delete, or ['*'] for all archived teams. Requires human approval."),
          confirm_purge: tool.schema.boolean().default(false).describe("Set true only after the user explicitly selects the exact approval option from the purge preview via the question tool."),
          confirm_token: tool.schema.string().optional().describe("Confirmation token from the purge preview. Valid only after the matching exact approval answer is selected in this session."),
        },
        async execute(args, ctx) {
          const approvePurge = args.purge && args.purge.length > 0 && args.confirm_purge
            ? async (preview: string) => {
              await ctx.ask({
                permission: "team_cleanup.purge",
                patterns: args.purge ?? [],
                always: [],
                metadata: {
                  title: "Purge archived teams",
                  preview,
                },
              })
            }
            : undefined
          // Collect member session IDs before cleanup so we can clean up activity buffers after
          const teamInfoForCleanup = findTeamBySession(db, registry, ctx.sessionID)
          const memberSessions = teamInfoForCleanup
            ? (db.query("SELECT session_id FROM team_member WHERE team_id = ?").all(teamInfoForCleanup.teamId) as Array<{ session_id: string }>).map(m => m.session_id)
            : []
          const result = await executeTeamCleanup(deps, args, ctx.sessionID, undefined, undefined, undefined, config.mergeOnCleanup, undefined, approvePurge)
          // Clean up activity buffers for team members after successful cleanup
          if (!result.includes("uncommitted") && !args.purge) {
            for (const sid of memberSessions) activityBuffer.remove(sid)
          }
          const blocked = result.includes("uncommitted")
          const title = args.purge
            ? result.startsWith("No archived teams") ? "No archived teams to purge" : result.startsWith("Purge preview") ? "Purge confirmation required" : "Archived teams purged"
            : blocked ? "Cleanup blocked — uncommitted changes" : "Team cleaned up"
          ctx.metadata({ title })
          return result
        },
      }),

      team_merge: tool({
        description: "Merge a shutdown teammate's branch into the working directory as unstaged changes. " +
          "Use this after team_shutdown to review and integrate a teammate's work. " +
          "The teammate must be shut down first.",
        args: {
          member: tool.schema.string().describe("Teammate name whose branch to merge"),
        },
        async execute(args, ctx) {
          const result = await executeTeamMerge(deps, args, ctx.sessionID)
          const conflict = result.includes("conflict")
          ctx.metadata({ title: conflict ? `Merge conflict: ${args.member}` : `Merged ${args.member}` })
          return result
        },
      }),

      team_status: tool({
        description: "View team members with their current status, agent type, and session IDs. " +
          "Use this to check who is working, idle, or shut down. Includes a task summary.",
        args: {},
        async execute(_args, ctx) {
          const result = await executeTeamStatus(deps, ctx.sessionID)
          const statusMap: Record<string, string> = { busy: "working", ready: "idle", shutdown_requested: "stopping", shutdown: "done", error: "error" }
          const members = deps.db.query("SELECT name, status FROM team_member WHERE team_id IN (SELECT id FROM team WHERE lead_session_id = ? OR id IN (SELECT team_id FROM team_member WHERE session_id = ?))").all(ctx.sessionID, ctx.sessionID) as Array<{ name: string; status: string }>
          const summary = members.map(m => `${m.name}: ${statusMap[m.status] ?? m.status}`).join(", ")
          ctx.metadata({ title: summary || "No teammates" })
          return result
        },
      }),

      team_view: tool({
        description: "Resolve a teammate's session so the user can inspect it. Default reports the session ID + status without switching. " +
          "Pass navigate: true ONLY when the user explicitly asked to view the teammate's session — it switches their client to it. Return via the session picker (ctrl+p).",
        args: {
          member: tool.schema.string().describe("Teammate name to view"),
          navigate: tool.schema.boolean().default(false).describe("Switch the user's client to this session. Only when the user explicitly asked."),
        },
        async execute(args, ctx) {
          const result = await executeTeamView(deps, args, ctx.sessionID)
          ctx.metadata({ title: `Viewing ${args.member}` })
          return result
        },
      }),

      decision_lead: tool({
        description: "Escalate an emergency decision to the team lead and pause until they deliberate. " +
          "Use this instead of a best-effort team_message to the lead when a ruling is genuinely blocking you: " +
          "it wakes the lead directly (punching through silentLead), suspends you to standby, pauses the " +
          "reviewer autoawake, and raises a high-priority toast.",
        args: {
          question: tool.schema.string().describe("The decision you need the lead to make (required)"),
          context: tool.schema.string().describe("Full context the lead needs to make the decision (required)"),
          options: tool.schema.array(tool.schema.string()).optional().describe("Optional candidate options for the lead to choose from"),
        },
        async execute(args, ctx) {
          const result = await executeDecisionLead(deps, args, ctx.sessionID)
          ctx.metadata({ title: `Decision requested from lead` })
          return result
        },
      }),
    },
  }
}

/**
 * Dual V1/V2 export (issue #36).
 * - V2 reads `id` + `setup()` and ignores `server()`.
 * - V1 (>=1.18.29) calls `server()` and ignores the V2 fields.
 * The V2 setup body lands in later phases; the V1 implementation below is
 * unchanged so current users keep working during the port.
 */
export default {
  ...PluginV2.define({
    id: "ensemble",
    async setup(ctx) {
      // Dual support (issue #36): V2 initializes here; the V1 server()
      // below keeps serving V1 hosts. Tool registration lands next slice.
      const handle = await setupEnsemble(ctx as unknown as V2SetupContext)
      return () => {
        void handle.dispose()
      }
    },
  }),
  server: plugin,
}
