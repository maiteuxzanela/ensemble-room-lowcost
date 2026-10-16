import type { ToolDeps, PermissionRule } from "../types"
import { validateMemberName } from "../util"
import { requireLead } from "./shared"
import { claimTask } from "./team-claim"
import { notifyLead } from "../notify"
import { releaseMemberTasks } from "../tasks"
import {
  formatModelSelector,
  parseModelSelector,
  resolveFallbackChainForAgent,
  selectFallbackModel,
} from "../config"
import { log } from "../log"
import { getTeamQAMember, getTeamSDETMember } from "../qa-role"
import type { EnsembleConfig } from "../config"
import { getTeamResourceParts, teamWorktreeName } from "./merge-helper"
import { existsSync, readFileSync } from "node:fs"
import os from "node:os"
import path from "node:path"

/** Tracks consecutive spawn failures per team for circuit breaker. */
export const spawnFailures = new Map<string, { count: number; lastError: string }>()

/**
 * Multi-instance convention `<persona>-<suffix>` / `<persona>_<suffix>`.
 * Returns the canonical lowercase base persona of a member name:
 * "cris-1", "cris_2" and "cris" all resolve to "cris".
 */
export function resolveBasePersona(memberName: string): string {
  return (memberName.split(/[-_]/)[0] ?? memberName).toLowerCase()
}

/** Maximum chars of a canonical persona file inlined into spawn context (anti-dumping). */
const MAX_PERSONA_CONTEXT_CHARS = 2400

/**
 * Read the canonical persona definition (`~/.config/opencode/agent/<base>.md`)
 * for a base persona. Returns null when the persona does not exist or reading
 * fails — never throws (persona context is enrichment, not a hard dependency).
 */
export function readBasePersonaFile(basePersonaName: string): string | null {
  try {
    const file = path.join(os.homedir(), ".config", "opencode", "agent", `${basePersonaName}.md`)
    if (!existsSync(file)) return null
    const body = readFileSync(file, "utf-8").trim()
    if (!body) return null
    return body.length > MAX_PERSONA_CONTEXT_CHARS
      ? `${body.slice(0, MAX_PERSONA_CONTEXT_CHARS)}\n... (truncated)`
      : body
  } catch {
    return null
  }
}

/**
 * Resolve which model to use for a spawned agent.
 * Priority: explicit arg > modelsByAgent[memberName] > modelsByAgent[basePersona] >
 * modelsByAgent[agentType] > rotation/random > defaultModel > undefined.
 *
 * The memberName lookup makes multi-instance members (`cris-1`) inherit the
 * model bound to their canonical persona (`cris`) without config changes.
 */
export function resolveModel(
  explicitModel: string | undefined,
  agentType: string,
  teamMemberCount: number,
  config: Required<EnsembleConfig>,
  memberName?: string,
): string | undefined {
  if (explicitModel) return explicitModel
  const lookupKeys: string[] = []
  if (memberName) {
    lookupKeys.push(memberName)
    const basePersonaName = resolveBasePersona(memberName)
    if (basePersonaName !== memberName) lookupKeys.push(basePersonaName)
  }
  lookupKeys.push(agentType)
  for (const key of lookupKeys) {
    const model = config.modelsByAgent[key]
    if (model) return model
  }
  if (config.modelAssignment === "rotate" && config.modelPool.length > 0) {
    return config.modelPool[teamMemberCount % config.modelPool.length]
  }
  if (config.modelAssignment === "random" && config.modelPool.length > 0) {
    return config.modelPool[Math.floor(Math.random() * config.modelPool.length)]
  }
  if (config.defaultModel) return config.defaultModel
  return undefined
}

/** Timeout for worktree.create and session.create to prevent hanging on git lock contention. */
function getSpawnTimeout(): number {
  return Number(process.env.SPAWN_TIMEOUT_MS) || 120_000
}

/** Returns true if the directory is already inside an OpenCode worktree. */
function isWorktreeDirectory(dir: string): boolean {
  return dir.includes("/opencode/worktree/")
}

/** Race a promise against a timeout. Throws if the timeout fires first. Cleans up timer on resolution. */
function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout>
  return Promise.race([
    promise.finally(() => clearTimeout(timer)),
    new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms)
    }),
  ])
}

/**
 * Execute the team_spawn tool. Creates a child session and starts a teammate.
 * By default, each teammate gets their own git worktree for file isolation.
 * Pass worktree: false for read-only agents that don't need isolation.
 * Pass plan_approval: true to require the teammate to send a plan before writing.
 * Pass standby: true to register the member WITHOUT sending its init prompt
 * (zero tokens at birth) — the prompt is stored in spawn_context and replayed,
 * prepended, by the first team_message/team_broadcast that reaches it.
 */
export async function executeTeamSpawn(
  deps: ToolDeps,
  args: { name: string; agent?: string | null; prompt: string; model?: string; claim_task?: string; worktree?: boolean; plan_approval?: boolean; standby?: boolean; role?: "qa" | "member" | "sdet"; is_qa?: boolean },
  sessionId: string,
): Promise<string> {
  // Normalize agent: the tool schema defaults to "build", but Zod's .default()
  // only fires on undefined — an explicit null slips through and would violate
  // the team_member.agent NOT NULL constraint (issue #28).
  const agent = args.agent ?? "build"

  const nameError = validateMemberName(args.name)
  if (nameError) throw new Error(nameError)

  const teamInfo = requireLead(deps, sessionId)

  // Circuit breaker — stop retrying after 3 consecutive failures
  const failures = spawnFailures.get(teamInfo.teamId)
  if (failures && failures.count >= 3) {
    throw new Error(`Spawn circuit breaker tripped for team "${teamInfo.teamName}": 3 consecutive failures. Last error: ${failures.lastError}. Investigate before retrying — the circuit breaker resets on the next successful spawn.`)
  }

  // Check duplicate name
  const existing = deps.db.query("SELECT name FROM team_member WHERE team_id = ? AND name = ?")
    .get(teamInfo.teamId, args.name)
  if (existing) throw new Error(`Teammate "${args.name}" already exists in team "${teamInfo.teamName}"`)

  // Multi-instance normalization: "cris-1"/"cris_1" → base persona "cris".
  const basePersonaName = resolveBasePersona(args.name)

  // SDET / Test Engineering role detection (agnostic): the canonical test-
  // engineering persona is "hugo" — matched either as the explicit agent type
  // or via the base persona of a multi-instance name ("hugo-sdet" → "hugo").
  // An explicit `role: "sdet"` arg (direct API; V1/V2 tool schemas keep the
  // ["qa","member"] enum) also marks the member as SDET and is persisted in
  // team_member.role (Migration 16) so qa-role.ts can resolve it back.
  const isHugo = basePersonaName === "hugo" || agent === "hugo"
  const spawnIsSDET = isHugo || args.role === "sdet"

  // Quality Gate role detection (agnostic): explicit `role: "qa"` / `is_qa: true`
  // args OR the retrocompat signals (agent "clara", base persona "clara"). The
  // retrocompat signals are never demoted — mirrors isQAMember's rule set in
  // qa-role.ts (additive flags, no demotion path).
  const spawnIsQA = args.role === "qa" || args.is_qa === true || agent === "clara" || basePersonaName === "clara"

  // Quality Gate uniqueness lock: audit roles are exclusive. While another
  // ACTIVE Quality Gate reviewer (is_qa flag or clara retrocompat family) exists
  // in the team, no second reviewer may spawn. Deterministic, fail-fast
  // (before any worktree/session side effect).
  //
  // Message shape (runtime-asserted by test_multi_instance_spawn and
  // test_auto_standby_seq for the retrocompat QA 'clara'; the dist structural
  // marker asserts the interpolated template "Quality Gate '${existingQA.name}' j"):
  //   Guardiã do Quality Gate '<qa.name>' já está ativa na equipe '<team>'
  //   (instância ativa: '<qa.name>'). Papéis de auditoria do Quality Gate são
  //   exclusivos e não admitem instâncias concorrentes.
  // Both name slots resolve the actual reviewer via getTeamQAMember — no
  // hardcoded literal (see qa-role.ts contract).
  if (spawnIsQA) {
    const existingQA = getTeamQAMember(deps.db, teamInfo.teamId)
    if (existingQA) {
      throw new Error(
        `Guardiã do Quality Gate '${existingQA.name}' já está ativa na equipe '${teamInfo.teamName}' (instância ativa: '${existingQA.name}'). Papéis de auditoria do Quality Gate são exclusivos e não admitem instâncias concorrentes.`,
      )
    }
  }

  // SDET / Test Engineering uniqueness lock: engineering-audit roles are
  // exclusive. While another ACTIVE SDET exists in the team (qa-role.ts:
  // role='sdet' flag, agent type "hugo", or base persona of a multi-instance
  // name such as "hugo-sdet"), no second SDET may spawn. Deterministic,
  // fail-fast (before any worktree/session side effect).
  //
  // Message shape (runtime-asserted by test_hugo_sdet_integration — keep the
  // template byte-stable):
  //   Engenheiro de Testes 'hugo' já está ativo na equipe '<team>'.
  //   Papéis de engenharia de testes são exclusivos e não admitem
  //   instâncias concorrentes.
  if (spawnIsSDET) {
    const existingSDET = getTeamSDETMember(deps.db, teamInfo.teamId)
    if (existingSDET) {
      throw new Error(
        `Engenheiro de Testes 'hugo' já está ativo na equipe '${teamInfo.teamName}'. Papéis de engenharia de testes são exclusivos e não admitem instâncias concorrentes.`,
      )
    }
  }

  // Room's existing Quality Gate reviewer resolved BEFORE this member's INSERT,
  // so a first-time QA spawn doesn't address itself in its own peer-to-peer
  // template below (subsequent spawns will see it once inserted).
  const roomQa = getTeamQAMember(deps.db, teamInfo.teamId)

  // Room's existing SDET resolved BEFORE this member's INSERT — same rationale
  // as roomQa. Consumed by the SDET-first delivery templates below (TASK-02):
  // implementers hand the baton to the SDET; the Quality Gate waits for the
  // deterministic suite (see team-tasks-complete submit_review routing).
  const roomSdet = spawnIsSDET ? null : getTeamSDETMember(deps.db, teamInfo.teamId)

  const isReadOnly = agent === "plan" || agent === "explore"
  const useWorktree = args.worktree !== false && !isReadOnly && !isWorktreeDirectory(deps.directory)
  const usePlanApproval = args.plan_approval === true

  // Auto-standby check: if claim_task is provided and the task is blocked
  let autoStandby = false
  let autoStandbyReason = ""
  let claimedTaskBlocked = false
  if (args.claim_task) {
    const task = deps.db.query("SELECT status FROM team_task WHERE id = ? AND team_id = ?")
      .get(args.claim_task, teamInfo.teamId) as { status: string } | null
    if (task && task.status === "blocked") {
      autoStandby = true
      claimedTaskBlocked = true
      autoStandbyReason = `claimed task ${args.claim_task} is blocked`
      log(`spawn:auto-standby member=${args.name} task=${args.claim_task} reason=task_blocked`)
    }
  }

  // Semantic Auto-Standby for Quality Gate Guardian:
  // If this spawn carries the QA role (explicit role/is_qa or clara retrocompat)
  // and the team has other active members or pending tasks on the board, the
  // guardian must be born in standby unless args.standby === false is
  // explicitly passed.
  if (!autoStandby && spawnIsQA && args.standby !== false) {
    const otherMembersCount = (deps.db.query(
      "SELECT COUNT(*) as c FROM team_member WHERE team_id = ? AND name != ? AND status NOT IN ('shutdown', 'error')"
    ).get(teamInfo.teamId, args.name) as { c: number }).c

    const pendingTasksCount = (deps.db.query(
      "SELECT COUNT(*) as c FROM team_task WHERE team_id = ? AND status != 'completed'"
    ).get(teamInfo.teamId) as { c: number }).c

    if (otherMembersCount > 0 || pendingTasksCount > 0) {
      autoStandby = true
      autoStandbyReason = "quality gate guardian with active team or board"
      log(`spawn:auto-standby member=${args.name} agent=${agent} reason=quality_gate_active_team`)
    }
  }

  // Semantic Auto-Standby for the SDET / Test Engineering persona ("hugo"):
  // unlike the Quality Gate guardian, Hugo is born in standby BY DEFAULT —
  // regardless of the room's membership or board state — because its role is
  // reactive (design and validate deliveries) and it must not burn tokens
  // speculating before work lands. Only an explicit `standby: false` overrides
  // this default. Also covers explicit `role: "sdet"` members (direct API).
  // NOTE: the reason string is runtime-asserted by test_hugo_sdet_integration —
  // keep it byte-stable.
  if (!autoStandby && spawnIsSDET && args.standby !== false) {
    autoStandby = true
    autoStandbyReason = "hugo sdet default standby"
    log(`spawn:auto-standby member=${args.name} agent=${agent} reason=hugo_sdet_default`)
  }

  // Standby mode: the member is registered and its session is created, but no
  // prompt is sent at birth (zero tokens). The full init prompt is persisted in
  // spawn_context and prepended by the first team_message/team_broadcast.
  const useStandby = (args.standby === true || autoStandby) && args.standby !== false

  log(`spawn:start name=${args.name} agent=${agent} worktree=${useWorktree}${useStandby ? " standby=true" : ""}`)

  // Create worktree if enabled
  let worktreeDir: string | null = null
  let worktreeBranch: string | null = null

  if (useWorktree) {
    const resource = getTeamResourceParts(deps.db, teamInfo.teamId)
    const worktreeName = teamWorktreeName(resource.projectName, resource.teamName, resource.teamId, args.name)
    try {
      log(`spawn:worktree:start name=${args.name}`)
      const result = await withTimeout(
        deps.client.worktree.create({ worktreeCreateInput: { name: worktreeName } }),
        getSpawnTimeout(), `worktree.create for "${args.name}"`
      )
      if (result.data) {
        worktreeDir = result.data.directory
        worktreeBranch = result.data.branch
      }
      log(`spawn:worktree:done name=${args.name} dir=${worktreeDir}`)
    } catch (err) {
      log(`spawn:worktree:failed name=${args.name} err=${err instanceof Error ? err.message : String(err)}`)
      try {
        await deps.client.tui.showToast({
          title: "Team",
          message: `Worktree creation failed for ${args.name}, using shared directory`,
          variant: "warning",
          duration: 4000,
        })
      } catch { /* TUI may not be available */ }
    }
  }

  // Create workspace from worktree branch — links session to worktree directory.
  // OQ-workspace: assumes workspace.create({ branch }) auto-links to the worktree at that branch.
  let workspaceId: string | null = null
  if (worktreeDir && worktreeBranch) {
    try {
      log(`spawn:workspace:start name=${args.name}`)
      const wsResult = await withTimeout(
        deps.client.workspace.create({ branch: worktreeBranch }),
        getSpawnTimeout(), `workspace.create for "${args.name}"`
      )
      if (wsResult.data) {
        workspaceId = wsResult.data.id
      }
      log(`spawn:workspace:done name=${args.name} id=${workspaceId}`)
    } catch (err) {
      log(`spawn:workspace:failed name=${args.name} err=${err instanceof Error ? err.message : String(err)}`)
      // Non-fatal — prompt-based CWD instruction is the fallback
    }
  }

  // Permission rules on session.create are the hard gate (server-enforced).
  // For read-only agents, deny write tools and explicitly allow team tools.
  // For all agents with worktrees, allowlist the worktree path for edit/bash.
  // The member-accessible tools: the worker tools plus the inspection tools
  // (team_results/team_status/team_view — any member) and decision_lead
  // (HARNESS-22 — any member may escalate a blocking ruling to the lead).
  // Caught live 2026-09-15: teammates could not read each other's messages
  // because team_results was missing from this list.
  const TEAM_TOOLS = [
    "team_message",
    "team_broadcast",
    "team_tasks_list",
    "team_tasks_add",
    "team_tasks_complete",
    "team_claim",
    "team_standby",
    "team_results",
    "team_status",
    "team_view",
    "decision_lead",
  ] as const
  const permission: PermissionRule[] = []

  if (worktreeDir) {
    permission.push(
      { permission: "edit", pattern: `${worktreeDir}/**`, action: "allow" },
    )
    if (!isReadOnly) {
      permission.push({ permission: "bash", pattern: "*", action: "allow" })
    }
  }

  if (isReadOnly) {
    permission.push(
      { permission: "edit", pattern: "*", action: "deny" },
      { permission: "bash", pattern: "*", action: "deny" },
    )
  }

  permission.push(
    ...TEAM_TOOLS.map(t => ({ permission: t, pattern: "*", action: "allow" as const })),
  )

  // Deny lead-only and out-of-scope tools for teammates to eliminate tool schema bloat.
  // Base list: plugin-integrity essentials only (team lifecycle + task-board
  // side-channel tools). Ecosystem-specific tools (e.g. openchamber,
  // needle_verify_delivery) are NOT hardcoded here — operators add them via
  // the `deniedTools` config key (ensemble.json), merged below.
  const DENIED_TEAMMATE_TOOLS = [
    "team_create",
    "team_cleanup",
    "team_merge",
    "team_shutdown",
    "task",
    "todowrite",
  ] as const
  const deniedTools = [...new Set([...DENIED_TEAMMATE_TOOLS, ...(deps.config.deniedTools ?? [])])]
  permission.push(
    ...deniedTools.map(t => ({ permission: t, pattern: "*", action: "deny" as const })),
  )

  // Code Mode is the invocation path for plugin tools on V2 — without this,
  // read-only agents (deny-all policies like explore's) cannot reach any
  // team tool. Safe: nested calls inside execute still enforce their own
  // permissions, so explore stays read-only.
  permission.push({ permission: "execute", pattern: "*", action: "allow" })

  // Create child session — bind to workspace if available (server-enforced CWD isolation).
  // Falls back to no workspace binding if workspace.create failed.
  let childSessionId: string | undefined
  try {
    log(`spawn:session:start name=${args.name}`)
    const createResult = await withTimeout(
      deps.client.session.create({
        parentID: sessionId,
        title: `${args.name} (@${agent} teammate)`,
        permission,
        ...(workspaceId ? { workspaceID: workspaceId } : {}),
      }),
      getSpawnTimeout(), `session.create for "${args.name}"`
    )
    childSessionId = createResult.data?.id
    log(`spawn:session:done name=${args.name} sessionId=${childSessionId}`)
  } catch (err) {
    log(`spawn:session:failed name=${args.name} err=${err instanceof Error ? err.message : String(err)}`)
    // Track failure for circuit breaker
    const errMsg = err instanceof Error ? err.message : String(err)
    const prev = spawnFailures.get(teamInfo.teamId)
    spawnFailures.set(teamInfo.teamId, { count: (prev?.count ?? 0) + 1, lastError: errMsg })
    // Rollback workspace and worktree if session creation failed
    if (workspaceId) {
      try { await deps.client.workspace.remove({ id: workspaceId }) } catch { /* best effort */ }
    }
    if (worktreeDir) {
      try { await deps.client.worktree.remove({ worktreeRemoveInput: { directory: worktreeDir } }) } catch { /* best effort */ }
    }
    throw new Error(`Failed to create session for teammate "${args.name}": ${err instanceof Error ? err.message : String(err)}`)
  }

  if (!childSessionId) {
    if (workspaceId) {
      try { await deps.client.workspace.remove({ id: workspaceId }) } catch { /* best effort */ }
    }
    if (worktreeDir) {
      try { await deps.client.worktree.remove({ worktreeRemoveInput: { directory: worktreeDir } }) } catch { /* best effort */ }
    }
    throw new Error("Failed to create teammate session")
  }

  // Register in DB
  const planApproval = usePlanApproval ? "pending" : "none"
  const now = Date.now()
  // Resolve model before DB insert so the stored value matches what promptAsync uses
  const memberCount = (deps.db.query("SELECT COUNT(*) as c FROM team_member WHERE team_id = ?").get(teamInfo.teamId) as { c: number }).c
  const resolvedModel = resolveModel(args.model, agent, memberCount, deps.config, args.name)
  if (resolvedModel) log(`spawn:model name=${args.name} model=${resolvedModel}`)

  // Resolve the rate-limit fallback chain for THIS agent (per-agent override
  // `fallbackModelsByAgent[agent]` → global fallbackModels/modelFallback →
  // DEFAULT_MODEL_FALLBACK). The agent key is already the canonical persona
  // ("diana"), so a multi-instance member name ("diana-2") inherits its base
  // persona's chain for free; a suffixed AGENT type ("diana-x") is tolerated
  // by also trying resolveBasePersona(agent). Persisted nowhere: the chain is
  // config-derived, so every delivery path recomputes the same result. The
  // first entry differing from the primary is the one silent failover uses.
  const agentBasePersona = resolveBasePersona(agent)
  const agentFallbackChain = agentBasePersona !== agent && deps.config.fallbackModelsByAgent?.[agentBasePersona]?.length
    ? resolveFallbackChainForAgent(deps.config, agentBasePersona)
    : resolveFallbackChainForAgent(deps.config, agent)
  const fallbackModel = selectFallbackModel(agentFallbackChain, resolvedModel)
  if (fallbackModel) log(`spawn:fallback name=${args.name} agent=${agent} fallback=${formatModelSelector(fallbackModel)}`)

  deps.db.run(
    `INSERT INTO team_member (team_id, name, session_id, agent, status, execution_status, model, prompt, worktree_dir, worktree_branch, workspace_id, plan_approval, is_qa, role, time_created, time_updated)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      teamInfo.teamId, args.name, childSessionId, agent,
      // Standby members are born 'ready'/'standby', not 'busy'/'starting':
      // they have never run a step, so putting them in 'busy' would make the
      // watchdog's TTL/stall scan treat a member that was never started as a
      // member that stalled.
      useStandby ? "ready" : "busy",
      useStandby ? "standby" : "starting",
      resolvedModel ?? null, args.prompt, worktreeDir, worktreeBranch, workspaceId, planApproval,
      spawnIsQA ? 1 : 0,
      // Explicit role designation (Migration 16): only 'sdet' is persisted here
      // — the Quality Gate reviewer is already flagged by is_qa (Migration 14),
      // so writing 'qa' as well would duplicate sources of truth.
      spawnIsSDET ? "sdet" : null,
      now, now,
    ]
  )

  // Row is inserted as 'busy' directly -- there is no ready->busy status-event
  // transition for a fresh spawn, so the watchdog's usual hook point never fires.
  // Record the baseline here instead, or a member stalled on its first action
  // is invisible to checkStalled() until its first step-finish event lands.
  // Standby members are the exception: they are born 'ready', so they DO get the
  // ready->busy transition later and record their own baseline then (index.ts).
  if (!useStandby) deps.progressTracker.recordBusyStart(childSessionId)

  // Register in memory
  deps.registry.register(teamInfo.teamId, args.name, childSessionId)

  // Auto-claim a task for this teammate when claim_task is provided (issue #27).
  // Claims atomically so a task is never double-assigned when the lead hands out
  // more tasks than there are teammates. Read-only agents cannot claim tasks.
  let claimedTaskContent: string | null = null
  let claimWarning: string | null = null
  if (args.claim_task && !isReadOnly) {
    if (claimedTaskBlocked) {
      // Pre-assign the blocked task atomically
      const updateResult = deps.db.run(
        "UPDATE team_task SET assignee = ?, time_updated = ? WHERE id = ? AND team_id = ? AND assignee IS NULL",
        [args.name, Date.now(), args.claim_task, teamInfo.teamId]
      )
      if (updateResult.changes === 0) {
        claimWarning = `Task "${args.claim_task}" is already claimed or missing`
        log(`spawn:claim-blocked:failed name=${args.name} task=${args.claim_task} err=${claimWarning}`)
      } else {
        const taskRow = deps.db.query("SELECT content FROM team_task WHERE id = ? AND team_id = ?")
          .get(args.claim_task, teamInfo.teamId) as { content: string } | null
        claimedTaskContent = taskRow?.content ?? null
        log(`spawn:claim-blocked:ok name=${args.name} task=${args.claim_task}`)
      }
    } else {
      try {
        const claimResult = claimTask(deps.db, teamInfo.teamId, args.claim_task, args.name)
        claimedTaskContent = claimResult.content
        log(`spawn:claim:ok name=${args.name} task=${args.claim_task}`)
      } catch (err) {
        claimWarning = err instanceof Error ? err.message : String(err)
        log(`spawn:claim:failed name=${args.name} task=${args.claim_task} err=${claimWarning}`)
      }
    }
  }

  // Build teammate context message
  const context = [
    `You are "${args.name}", a teammate in team "${teamInfo.teamName}".`,
    `Your agent type is "${agent}".`,
  ]

  // Multi-instance inheritance: a child instance ("cris-1"/"cris_1") receives
  // the base persona context whenever the canonical persona exists — either as
  // the persona definition file (~/.config/opencode/agent/<base>.md) or as an
  // active canonical member of this team.
  if (basePersonaName !== args.name.toLowerCase()) {
    const personaFile = readBasePersonaFile(basePersonaName)
    const canonicalMember = deps.db.query(
      "SELECT name FROM team_member WHERE team_id = ? AND name = ? AND status NOT IN ('shutdown', 'error')"
    ).get(teamInfo.teamId, basePersonaName) as { name: string } | null
    if (personaFile || canonicalMember) {
      context.push(
        "",
        `Multi-instance persona: "${args.name}" is an instance of the canonical base persona "${basePersonaName}" (convention <persona>-<suffix>). Inherit its persona rules; keep one shared persona identity across instances.`,
      )
      if (canonicalMember) {
        context.push(`Canonical persona member "${canonicalMember.name}" is active in this team — coordinate with it as the same persona.`)
      }
      if (personaFile) {
        context.push("", `Base persona context (${basePersonaName}.md):`, personaFile)
      }
    }
  }

  // Show other teammates so this agent knows who to message
  const otherMembers = deps.db.query(
    "SELECT name FROM team_member WHERE team_id = ? AND name != ? AND status NOT IN ('shutdown', 'error')"
  ).all(teamInfo.teamId, args.name) as Array<{ name: string }>
  if (otherMembers.length > 0) {
    context.push(`Other teammates: ${otherMembers.map(m => m.name).join(", ")}`)
  }

  if (worktreeBranch && worktreeDir && !workspaceId) {
    // Workspace binding failed — fallback to prompt-based CWD instruction
    context.push(
      `You are working on branch "${worktreeBranch}" in your own worktree at: ${worktreeDir}`,
      `Your changes are isolated from other teammates.`,
      `IMPORTANT: All file operations and shell commands MUST target your worktree directory.`,
      `Before running shell commands, cd to: ${worktreeDir}`,
    )
  } else if (worktreeBranch && worktreeDir) {
    // Workspace binding active — server handles CWD
    context.push(
      `You are working on branch "${worktreeBranch}" in your own isolated worktree.`,
      `Your changes are isolated from other teammates.`,
    )
  } else if (worktreeBranch) {
    context.push(`You are working on branch "${worktreeBranch}". Your changes are isolated from other teammates.`)
  }

  // Plan approval mode — teammate must send plan before writing
  if (usePlanApproval) {
    context.push(
      "",
      "IMPORTANT: You are in PLAN MODE.",
      "Read and explore the codebase, then send your implementation plan to the lead via team_message.",
      "Do NOT write or modify any files until the lead approves your plan.",
      "Wait for the lead's approval message before proceeding with implementation.",
    )
  }

  if (isReadOnly) {
    context.push(
      "", "Tools available to you:",
      "- team_message: send a message to the lead or another teammate",
      "- team_broadcast: send a message to all team members",
      "- team_tasks_list: view the shared team task board",
      "- team_standby: yield execution and enter standby mode until unblocked or messaged",
    )
  } else {
    context.push(
      "", "Tools available to you:",
      "- team_message: send a message to the lead or another teammate",
      "- team_broadcast: send a message to all team members",
      "- team_tasks_list: view the shared team task board",
      "- team_tasks_add: add tasks to the shared board",
      "- team_tasks_complete: mark a task complete on the shared board",
      "- team_claim: claim a pending task from the shared board",
      "- team_standby: yield execution and enter standby mode until unblocked or messaged",
    )
  }

  // Collaboration guidance for peer-to-peer communication
  if (otherMembers.length > 0) {
    context.push(
      "",
      "Collaboration:",
      "- Check team_tasks_list to see what other teammates are working on.",
      "- If you need information another teammate has, message them directly via team_message.",
      "- If you discover something relevant to another teammate's task, share it with them.",
      "- Use team_broadcast for updates that affect the whole team.",
      "- Keep peer messages focused and actionable — coordinate, don't chat.",
    )
  }

  // HARNESS-23 (TASK-02) delivery-flow peers, resolved pre-INSERT:
  //   1. This member IS the SDET → submit_review wakes the Quality Gate by
  //      itself (team-tasks-complete SDET-first routing) — no peer message.
  //   2. The room has an SDET (and this member is not it) → the baton goes
  //      EXCLUSIVELY to the SDET for the deterministic test suite; the Quality
  //      Gate is not cited in implementer prompts at all — it only enters after
  //      the SDET verdict, via the automatic wake.
  //   3. No SDET in the room → legacy QA peer-to-peer clause (retrocompat —
  //      byte-stable, runtime-asserted by test_agnostic_qa_role A.10).
  //   4. Nobody to review → generic fallback (no dangling member references).
  const qaPeerName = roomQa?.name
  const sdetPeerName = roomSdet?.name ?? null
  const finishStep2 = (claimScope: "a task" | "a standalone task"): string => {
    const tail = claimScope === "a standalone task"
      ? "Otherwise, if you claimed a standalone task not requiring review, mark it complete using team_tasks_complete."
      : "Otherwise, if you claimed a task, mark it complete using team_tasks_complete."
    if (spawnIsSDET) {
      return `2. If your task requires review, submit it using team_tasks_complete with action: 'submit_review' (plus review notes) — the Quality Gate reviewer is woken automatically after your deterministic suite is submitted. Intermediate/partial work during development happens exclusively via team_message(to: '<colleague>'); submit_review is reserved for the final consolidation of the functionality. ${tail}`
    }
    if (sdetPeerName) {
      return `2. If your task requires review, submit it using team_tasks_complete with action: 'submit_review' (plus review notes), then pass the baton exclusively to the SDET ${sdetPeerName} via team_message(to: '${sdetPeerName}') for the deterministic test suite. Intermediate/partial work during development happens exclusively via team_message(to: '<colleague>'); submit_review is reserved for the final consolidation of the functionality. ${tail}`
    }
    if (qaPeerName) {
      return claimScope === "a standalone task"
        ? `2. If your task requires Quality Gate review, submit it using team_tasks_complete with action: 'submit_review' (plus review notes) so ${qaPeerName} can validate and approve. Coordinate peer-to-peer with ${qaPeerName} via team_message(to: '${qaPeerName}'). Intermediate/partial work during development happens exclusively via team_message(to: '<colleague>'); submit_review is reserved for the final consolidation of the functionality. Otherwise, if you claimed a standalone task not requiring review, mark it complete using team_tasks_complete.`
        : `2. If your task requires Quality Gate review, submit it using team_tasks_complete with action: 'submit_review' (plus review notes) and coordinate peer-to-peer with ${qaPeerName} via team_message(to: '${qaPeerName}'). Intermediate/partial work during development happens exclusively via team_message(to: '<colleague>'); submit_review is reserved for the final consolidation of the functionality. Otherwise, if you claimed a task, mark it complete using team_tasks_complete.`
    }
    return claimScope === "a standalone task"
      ? `2. If your task requires Quality Gate review, submit it using team_tasks_complete with action: 'submit_review' (plus review notes). Intermediate/partial work during development happens exclusively via team_message(to: '<colleague>'); submit_review is reserved for the final consolidation of the functionality. Otherwise, if you claimed a standalone task not requiring review, mark it complete using team_tasks_complete.`
      : `2. If your task requires Quality Gate review, submit it using team_tasks_complete with action: 'submit_review' (plus review notes). Intermediate/partial work during development happens exclusively via team_message(to: '<colleague>'); submit_review is reserved for the final consolidation of the functionality. Otherwise, if you claimed a task, mark it complete using team_tasks_complete.`
  }

  // Role-specific delivery orientation (TASK-02): the SDET runs real
  // deterministic suites and never self-audits; the Quality Gate guardian
  // waits for the SDET verdict before auditing. A guardian spawned BEFORE the
  // SDET still receives the wait-order via the per-turn system prompt
  // (buildTeammateSystemPrompt), so coverage does not depend on spawn order.
  if (spawnIsSDET) {
    context.push(
      "",
      "SDET ORIENTATION:",
      "You are the deterministic-test engineer (SDET). Design and run REAL deterministic test suites (never mocks). After you submit a task via submit_review, the Quality Gate reviewer is woken automatically — do not audit your own delivery.",
      "When you have verified a delivery in 'in_review' with a REAL deterministic suite that is 100% green, record the verdict with team_tasks_complete(action: 'sdet_pass', notes: '...') — it hands the baton to the Quality Gate reviewer automatically (never approve the card yourself via action: 'complete').",
    )
  } else if (spawnIsQA && sdetPeerName) {
    context.push(
      "",
      "QUALITY GATE ORIENTATION:",
      `Wait for the SDET's (${sdetPeerName}) deterministic test suite before auditing: implementers pass the baton to the SDET after submit_review, and only then is the review routed to you. Do not audit deliveries that skipped the deterministic suite.`,
    )
  }

  context.push("", "When you finish your task:")
  if (!isReadOnly && worktreeBranch) {
    context.push(`1. Commit your changes: git add -A && git commit -m "your summary"`)
    context.push(finishStep2("a task"))
    context.push(
      "3. ONLY when your task is fully complete, send ONE message to the lead using team_message with this format:",
    )
  } else if (!isReadOnly) {
    context.push(
      "1. In shared workspace mode (worktree: false), do NOT commit git changes directly (keep changes unstaged for inspection and anti-early-commit governance). The runtime commits the shared workspace LOCALLY and automatically the moment the Quality Gate reviewer (Clara) approves your card via team_tasks_complete(action: 'complete') — no manual git commit is needed. Pushing stays reserved for the pre-push batch gate.",
    )
    context.push(finishStep2("a standalone task"))
    context.push(
      "3. ONLY when your task is fully complete, send ONE message to the lead using team_message with this format:",
    )
  } else {
    context.push(
      sdetPeerName && !spawnIsSDET
        ? `1. If your task requires review or peer feedback, pass the baton to the SDET ${sdetPeerName} via team_message(to: '${sdetPeerName}') for the deterministic test suite. If you claimed a task, mark it complete using team_tasks_complete.`
        : qaPeerName
          ? `1. If your task requires Quality Gate review or peer feedback, coordinate peer-to-peer with ${qaPeerName} via team_message(to: '${qaPeerName}'). If you claimed a task, mark it complete using team_tasks_complete.`
          : `1. If your task requires Quality Gate review or peer feedback, coordinate with the team lead via team_message. If you claimed a task, mark it complete using team_tasks_complete.`,
    )
    context.push(
      "2. ONLY when your task is fully complete, send ONE message to the lead using team_message with this format:",
    )
  }
  context.push(
    "<task-result>",
    "<status>completed or failed</status>",
    "<summary>One-line summary of what you did</summary>",
    "<details>Full findings or changes made</details>",
  )
  if (worktreeBranch) {
    context.push(`<branch>${worktreeBranch}</branch>`)
  }
  context.push("</task-result>")
  const lastStep = !isReadOnly ? "4" : "3"
  context.push(
    `${lastStep}. STOP. Do not send follow-up confirmations, status updates, or 'standing by' messages.`,
    "",
    "If you are blocked:",
    "- Send ONE message to the lead via team_message describing the specific blocker.",
    "- Do NOT attempt workarounds or make assumptions. Wait for the lead's response.",
    "",
    "ANTI-DUMPING DIRECTIVE: Never run open grep or broad shell scans across codebases. Use targeted search tools (e.g. qmd_search, ripgrep) or targeted read/edit. Keep command outputs concise — never dump files >300 lines.",
    "",
    "MANDATORY CLOSING RULE: Approval without tools does not exist. It is strictly forbidden to finish your response with only plain text or Markdown. When concluding any task or audit/review, you MUST execute:",
    "1. team_tasks_complete(task_id: '...', action: 'complete' | 'reject') (or action: 'submit_review' ONLY for the final consolidation of the functionality — intermediate/partial work is coordinated via team_message)",
    "2. team_message(to: 'lead', text: '<task-result>...') — ONLY on final completion. Do NOT duplicate a partial/in-progress report via team_message(to: 'lead').",
    "",
    "Your plain text output is NOT visible to the team. You MUST use team_message to communicate.",
  )

  context.push(
    "",
    "Your task:",
    args.prompt,
  )

  if (claimedTaskContent) {
    context.push("", `You have been assigned task ${args.claim_task}. Mark it complete when done.`)
  }

  const contextStr = context.join("\n")

  // Standby: persist the full init prompt into spawn_context (Migration 11).
  // This is an UPDATE after the INSERT because contextStr does not exist yet
  // when the row is written. Normal spawns never touch the column, so it stays
  // NULL — a non-NULL spawn_context is the marker that this member's first
  // delivery carries a context to prepend.
  if (useStandby) {
    deps.db.run(
      "UPDATE team_member SET spawn_context = ?, time_updated = ? WHERE team_id = ? AND name = ?",
      [contextStr, Date.now(), teamInfo.teamId, args.name],
    )
    log(`spawn:standby:context-saved name=${args.name} chars=${contextStr.length}`)
  }

  // Model was already resolved before DB insert — just parse for promptAsync.
  // parseModelSelector strips an optional "#variant" suffix so selectors like
  // "google/antigravity-gemini-3.8-flash#low" reach the server as
  // { providerID, modelID, variant: "low" } instead of a corrupted modelID.
  const modelParam = resolvedModel ? parseModelSelector(resolvedModel) : undefined
  if (resolvedModel && !modelParam) {
    log(`spawn:model:invalid name=${args.name} model=${resolvedModel} — expected "provider/model" format, falling back to default`)
  }

  if (useStandby) {
    // Standby birth: NO session.promptAsync at all (zero tokens), and therefore
    // no rollback catch armed either — the member is resumed by its first
    // team_message/team_broadcast through resolveStandbyWake().
    log(`spawn:standby:no-prompt name=${args.name} sessionId=${childSessionId}`)
  } else {
    // Fire-and-forget: send prompt to teammate session.
    log(`spawn:promptAsync:fire name=${args.name} sessionId=${childSessionId}`)
    deps.client.session.promptAsync({
      sessionID: childSessionId,
      parts: [{ type: "text", text: contextStr }],
      agent,
      ...(modelParam ? { model: modelParam } : {}),
    }).catch((err) => {
      const errMsg = err instanceof Error ? err.message : String(err)
      log(`spawn:promptAsync:failed name=${args.name} err=${errMsg} — rolling back`)
      try {
        deps.db.run("DELETE FROM team_member WHERE team_id = ? AND session_id = ?", [teamInfo.teamId, childSessionId])
        deps.registry.unregister(childSessionId)
        // Release any task auto-claimed for this teammate so it returns to the pool.
        if (claimedTaskContent) {
          deps.db.run(
            "UPDATE team_task SET status = 'pending', assignee = NULL, time_updated = ? WHERE id = ? AND assignee = ? AND status = 'in_progress'",
            [Date.now(), args.claim_task, args.name]
          )
        }
        deps.client.session.abort({ sessionID: childSessionId }).catch(() => { /* best effort */ })
        if (workspaceId) {
          deps.client.workspace.remove({ id: workspaceId }).catch(() => { /* best effort */ })
        }
        if (worktreeDir) {
          deps.client.worktree.remove({ worktreeRemoveInput: { directory: worktreeDir } }).catch(() => { /* best effort */ })
        }
        const modelInfo = resolvedModel ? ` (model: ${resolvedModel})` : ""
        deps.client.tui.showToast({
          title: "Team",
          message: `Teammate "${args.name}" failed to start${modelInfo}: ${errMsg}`,
          variant: "error",
          duration: 8000,
        }).catch(() => { /* TUI may not be available */ })
        notifyLead(
          deps.client,
          deps.db,
          teamInfo.teamId,
          `Teammate "${args.name}" failed to start and was removed${modelInfo}. Error: ${errMsg}. You may retry the spawn.`,
          // F2: model-aware wake — agent from team.lead_agent + fallback-chain
          // ladder with step-down (HARNESS-15 B), same as notifyLead elsewhere.
          { config: deps.config },
        )
      } catch { /* rollback failed — watchdog will clean up stale member */ }
    })
  }

  const branchInfo = worktreeBranch ? ` (branch: ${worktreeBranch})` : ""
  const standbyInfo = autoStandby 
    ? ` (auto-standby: ${claimedTaskBlocked ? `claimed task ${args.claim_task} is blocked` : autoStandbyReason})` 
    : useStandby ? " [standby — no prompt sent; wakes on first team_message]" : ""
  const planInfo = usePlanApproval ? " [plan mode — will send plan for approval]" : ""
  const claimInfo = claimedTaskContent
    ? ` (claimed task: ${args.claim_task})`
    : claimWarning ? ` (could not claim task: ${claimWarning})` : ""
  // Reset circuit breaker on success
  spawnFailures.delete(teamInfo.teamId)
  log(`spawn:done name=${args.name} sessionId=${childSessionId}`)
  return `Teammate "${args.name}" spawned (agent: ${agent})${branchInfo}${standbyInfo}${planInfo}${claimInfo}. They are working on: ${args.prompt.slice(0, 120)}${args.prompt.length > 120 ? "..." : ""}`
}
