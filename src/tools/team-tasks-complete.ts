import type { ToolDeps } from "../types"
import { requireTeamMember, resolveStandbyWake } from "./shared"
import { getMemberModel } from "../member-model"
import { inReviewNudges } from "../hooks"
import { isQAMember, getTeamQAMember, isSDETMEmber, getTeamSDETMember, type QAMemberInfo } from "../qa-role"
import { promptModelAwareWake } from "../notify"
import { runCommand } from "../process"
import { log } from "../log"
import path from "node:path"
import { existsSync, readdirSync, statSync } from "node:fs"

export interface TeamTasksCompleteArgs {
  task_id: string
  action?: "complete" | "submit_review" | "reject" | "sdet_pass" | string
  status?: string
  notes?: string
  review_notes?: string
}

/**
 * Auto-wake a review target (SDET or Quality Gate) for a submitted task.
 *
 * Byte-compatible with the historical submit_review QA wake: standby members
 * consume their spawn_context via resolveStandbyWake (standby → starting,
 * reverted in the catch on transport failure), non-standby members receive a
 * bare synthetic system prompt. The `kind` selects the wake text (the SDET
 * text additionally asks for the deterministic test suite) and the log tag —
 * "clara" keeps the legacy `tasks-complete:wake-clara` marker (asserted by the
 * deterministic suites), "sdet" introduces the HARNESS-23 counterpart.
 *
 * Returns true when a promptAsync was actually dispatched (session present).
 */
function wakeReviewTarget(
  deps: ToolDeps,
  teamId: string,
  taskId: string,
  caller: string,
  target: QAMemberInfo,
  notes: string | null,
  kind: "sdet" | "clara",
): boolean {
  if (!target.sessionId) return false
  const now = Date.now()
  deps.db.run(
    "UPDATE team_member SET reported_to_lead = 0, time_updated = ? WHERE team_id = ? AND name = ?",
    [now, teamId, target.name],
  )

  const baseWakeText = kind === "sdet"
    ? `[System: Task "${taskId}" was submitted for review by ${caller}${notes ? ` (notes: ${notes})` : ""} — SDET handover: run the deterministic test suite for this delivery before the Quality Gate audits.]`
    : `[System: Task "${taskId}" was submitted for review by ${caller}${notes ? ` (notes: ${notes})` : ""}]`
  let promptText = baseWakeText
  let promptAgent: string | undefined = target.agent

  if (target.executionStatus === "standby") {
    const wake = resolveStandbyWake(deps.db, teamId, target.name, baseWakeText)
    if (wake.woke) {
      promptText = wake.text
      promptAgent = wake.agent ?? target.agent
    }
  }

  const model = getMemberModel(deps.db, teamId, target.name)
  deps.client.session.promptAsync({
    sessionID: target.sessionId,
    parts: [{ type: "text", text: promptText }],
    agent: promptAgent,
    synthetic: true,
    ...(model ? { model } : {}),
  }).catch((err) => {
    if (target.executionStatus === "standby") {
      deps.db.run(
        "UPDATE team_member SET execution_status = 'standby', time_updated = ? WHERE team_id = ? AND name = ? AND execution_status = 'starting'",
        [Date.now(), teamId, target.name],
      )
    }
    if (kind === "sdet") {
      log(`tasks-complete:wake-sdet:failed err=${String(err)}`)
    } else {
      log(`tasks-complete:wake-clara:failed err=${String(err)}`)
    }
  })
  if (kind === "sdet") {
    log(`tasks-complete:wake-sdet:ok task=${taskId} sessionID=${target.sessionId}`)
  } else {
    log(`tasks-complete:wake-clara:ok task=${taskId} sessionID=${target.sessionId}`)
  }
  return true
}

/**
 * HARNESS-27B — native SDET → Quality Gate handover wake.
 *
 * Fired when the SDET (Hugo) records that the REAL deterministic suite for a
 * delivery is 100% green via `team_tasks_complete(action: 'sdet_pass')`. Wakes
 * the Quality Gate reviewer (Clara — `getTeamQAMember`) with the canonical
 * handover text so the adversarial audit only starts AFTER the suite passed.
 *
 * The wake passes the REVIEWER'S OWN `agent` (A2 — `qa.agent || "clara"`,
 * dynamic so a custom Quality Gate persona flagged `is_qa=1` is never
 * sequestered by a hardcoded "clara"; the literal is only the retrocompat
 * fallback for legacy rows whose agent column is empty) and the reviewer's
 * bound model EXPLICITLY (omitting the agent lets the OpenCode server
 * rebind the session to its default persona). Byte-compatible with the other
 * review-target wakes: a STANDBY reviewer consumes its spawn_context window
 * (resolveStandbyWake — standby → starting, reverted in the catch on transport
 * failure), any other reviewer receives the bare synthetic system prompt.
 *
 * Returns true when a promptAsync was actually dispatched (session present).
 */
function wakeQualityGateForSdetPass(
  deps: ToolDeps,
  teamId: string,
  taskId: string,
  notes: string | null,
  qa: QAMemberInfo,
): boolean {
  if (!qa.sessionId) return false
  const now = Date.now()
  deps.db.run(
    "UPDATE team_member SET reported_to_lead = 0, time_updated = ? WHERE team_id = ? AND name = ?",
    [now, teamId, qa.name],
  )

  const baseWakeText = `[System: SDET (Hugo) has verified task with passing deterministic test suite. Notes: "${notes ?? ""}". Ready for Quality Gate audit.]`
  let promptText = baseWakeText
  if (qa.executionStatus === "standby") {
    const wake = resolveStandbyWake(deps.db, teamId, qa.name, baseWakeText)
    if (wake.woke) promptText = wake.text
  }

  // Persona-sequester immunity (A2): the REVIEWER'S OWN agent + the bound
  // model travel on the wire; never let the server pick a default. `qa.agent`
  // is dynamic so a custom Quality Gate reviewer (is_qa=1, non-"clara" agent)
  // keeps its persona; "clara" is only the retrocompat fallback for empty agent.
  const model = getMemberModel(deps.db, teamId, qa.name)
  deps.client.session.promptAsync({
    sessionID: qa.sessionId,
    parts: [{ type: "text", text: promptText }],
    agent: qa.agent || "clara",
    synthetic: true,
    ...(model ? { model } : {}),
  }).catch((err) => {
    if (qa.executionStatus === "standby") {
      deps.db.run(
        "UPDATE team_member SET execution_status = 'standby', time_updated = ? WHERE team_id = ? AND name = ? AND execution_status = 'starting'",
        [Date.now(), teamId, qa.name],
      )
    }
    log(`tasks-complete:sdet-pass:wake-clara:failed task=${taskId} err=${String(err)}`)
  })
  log(`tasks-complete:sdet-pass:wake-clara:ok task=${taskId} sessionID=${qa.sessionId}`)
  return true
}

/**
 * Wake the ORIGINAL implementer of a card a review guardian bounced back
 * (HARNESS-25). Fired when the SDET rejects a third-party card after the
 * deterministic suite fails, or when the Quality Gate reviewer rejects it after
 * an audit failure: the implementer must learn that the card returned to
 * 'in_progress' and read the rejection/test-error notes. Standby members
 * consume their spawn_context window (resolveStandbyWake — standby → starting,
 * reverted on transport failure) exactly like the review-target wake; any other
 * member receives a bare synthetic system prompt. Returns true when a
 * promptAsync was actually dispatched (session present).
 */
function notifyRejectedImplementer(
  deps: ToolDeps,
  teamId: string,
  taskId: string,
  reviewer: string,
  implementer: string,
  notes: string | null,
  reviewerIsSDET: boolean,
): boolean {
  const row = deps.db.query(
    "SELECT session_id, agent, execution_status FROM team_member WHERE team_id = ? AND name = ?",
  ).get(teamId, implementer) as { session_id: string; agent: string; execution_status: string } | null
  const sessionId = row?.session_id
  if (!sessionId) return false

  const reviewerLabel = reviewerIsSDET ? "the SDET" : "the Quality Gate reviewer"
  const baseText = `[System: Task "${taskId}" was rejected by ${reviewer} (${reviewerLabel})${notes ? ` (notes: ${notes})` : ""} — the card is back in 'in_progress'; address the findings and resubmit.]`
  let promptText = baseText
  let promptAgent: string | undefined = row?.agent || undefined

  if (row?.execution_status === "standby") {
    const wake = resolveStandbyWake(deps.db, teamId, implementer, baseText)
    if (wake.woke) {
      promptText = wake.text
      promptAgent = wake.agent ?? row.agent
    }
  }

  const model = getMemberModel(deps.db, teamId, implementer)
  deps.client.session.promptAsync({
    sessionID: sessionId,
    parts: [{ type: "text", text: promptText }],
    agent: promptAgent,
    synthetic: true,
    ...(model ? { model } : {}),
  }).catch((err) => {
    if (row?.execution_status === "standby") {
      deps.db.run(
        "UPDATE team_member SET execution_status = 'standby', time_updated = ? WHERE team_id = ? AND name = ? AND execution_status = 'starting'",
        [Date.now(), teamId, implementer],
      )
    }
    log(`tasks-complete:reject-notify:failed member=${implementer} err=${String(err)}`)
  })
  log(`tasks-complete:reject-notify:ok member=${implementer} task=${taskId} reviewer=${reviewer}`)
  return true
}

/** Minimal team context the unblock pass needs (structural subset of requireTeamMember). */
type TeamCtx = { teamId: string }

/**
 * True when a downstream task belongs to the room's validation profile: its
 * assignee is the SDET (Hugo — qa-role.ts `isSDETMEmber`) or the Quality Gate
 * reviewer (Clara — `isQAMember`).
 *
 * Validation tasks are the ONLY downstream tasks allowed to treat an upstream
 * dependency in status `in_review` as resolved: the deterministic suite and
 * the adversarial audit ARE the review of that delivery, so they must start
 * the moment the delivery is submitted (HARNESS-24 — SDET handover). Every
 * other downstream task keeps the strict contract and waits for
 * `completed` / `cancelled`, so a rejected upstream never leaks rework into
 * regular work.
 *
 * Unassigned downstream tasks are deliberately NOT relaxed: without an
 * assignee there is no validation profile to verify, so they keep the strict
 * contract and unblock on `completed` (or on the first claim after that).
 */
function isValidationProfileTask(
  deps: ToolDeps,
  teamInfo: TeamCtx,
  task: { assignee: string | null },
): boolean {
  if (!task.assignee) return false
  return isSDETMEmber(deps.db, teamInfo.teamId, task.assignee)
    || isQAMember(deps.db, teamInfo.teamId, task.assignee)
}

/**
 * Count the room's OTHER open functional development tasks — status 'pending'
 * or 'in_progress' and NOT a validation-profile task (SDET/QA assignee).
 *
 * Feeds the HARNESS-25 consolidated-batch guard: an implementer's submit_review
 * must NOT wake the SDET while siblings of the same functional batch are still
 * being written, otherwise the deterministic suite would run against a
 * half-finished delivery. Unassigned tasks count as development (no validation
 * profile yet), mirroring isValidationProfileTask. The just-submitted task is
 * excluded explicitly (defense in depth: it is already 'in_review', which the
 * SQL status filter also rejects).
 */
function countPendingDevelopmentTasks(
  deps: ToolDeps,
  teamInfo: TeamCtx,
  excludeTaskId: string,
): number {
  const rows = deps.db.query(
    "SELECT assignee FROM team_task WHERE team_id = ? AND status IN ('pending', 'in_progress') AND id != ?",
  ).all(teamInfo.teamId, excludeTaskId) as Array<{ assignee: string | null }>
  return rows.filter((r) => !isValidationProfileTask(deps, teamInfo, r)).length
}

/**
 * Unblock every `blocked` task whose `depends_on` points at `triggerTaskId`
 * once ALL of its dependencies are resolved, transitioning
 * `blocked → in_progress` (pre-assigned) or `blocked → pending` and firing the
 * member wake via resolveStandbyWake (standby consume) or the HARNESS-16
 * unconditional wake for pre-assigned owners.
 *
 * Shared by BOTH flows of executeTeamTasksComplete:
 *   - Flow 1 (submit_review): the trigger is now `in_review`. Validation
 *     downstream tasks (SDET/QA assignee) unblock IMMEDIATELY so the SDET can
 *     run the deterministic suite while the Quality Gate sleeps — without
 *     this pass, team_claim on the SDET test task bounced back to the
 *     yield/standby directive because the task never left `blocked`
 *     (HARNESS-24). Non-validation downstream tasks stay `blocked`.
 *   - Flow 3 (complete): the trigger is `completed`; a sibling dependency
 *     still `in_review` relaxes ONLY for validation downstream, so the final
 *     audit can close a delivery's chain without orphaning tasks that wait on
 *     an in_review sibling of the same delivery.
 *
 * Dependency evaluation is status-driven (no trigger short-circuit): the
 * trigger row is re-read AFTER the caller's UPDATE, so `in_review` relaxes
 * exactly and only for validation downstream.
 *
 * Returns the unblock/wake counters for the caller's result message.
 */
function unblockDependents(
  deps: ToolDeps,
  teamInfo: TeamCtx,
  triggerTaskId: string,
  now: number,
): { unblocked: number; wokeMembers: number } {
  const allTasks = deps.db.query("SELECT id, depends_on, status, assignee FROM team_task WHERE team_id = ?")
    .all(teamInfo.teamId) as Array<{ id: string; depends_on: string | null; status: string; assignee: string | null }>

  let unblocked = 0
  let wokeMembers = 0
  for (const t of allTasks) {
    if (t.status !== "blocked" || !t.depends_on) continue
    const depIds: string[] = JSON.parse(t.depends_on)
    if (!depIds.includes(triggerTaskId)) continue

    const downstreamIsValidation = isValidationProfileTask(deps, teamInfo, t)
    const allResolved = depIds.every(depId => {
      const dep = allTasks.find(d => d.id === depId)
      if (!dep) return false
      if (dep.status === "completed" || dep.status === "cancelled") return true
      // HARNESS-24: an upstream still under review satisfies ONLY validation
      // downstream (SDET/QA assignee); regular dependents keep waiting for
      // final approval before starting.
      if (dep.status === "in_review" && downstreamIsValidation) return true
      return false
    })

    if (allResolved) {
      const nextStatus = t.assignee ? "in_progress" : "pending"
      deps.db.run("UPDATE team_task SET status = ?, time_updated = ? WHERE id = ?", [nextStatus, now, t.id])
      unblocked++

      // Wake target: the pre-assigned assignee or an unassigned standby teammate
      let wakeTarget = t.assignee
      if (!wakeTarget) {
        const standbyCandidate = deps.db.query(`
          SELECT name FROM team_member
          WHERE team_id = ? AND execution_status = 'standby'
          AND name NOT IN (
            SELECT assignee FROM team_task
            WHERE team_id = ? AND assignee IS NOT NULL AND status IN ('in_progress', 'in_review', 'blocked')
          )
          ORDER BY time_updated ASC LIMIT 1
        `).get(teamInfo.teamId, teamInfo.teamId) as { name: string } | null
        if (standbyCandidate) {
          wakeTarget = standbyCandidate.name
        }
      }

      if (wakeTarget) {
        // HARNESS-16: one snapshot BEFORE resolveStandbyWake — session delivery
        // target, explicit agent for non-standby wakes, and the pre-consumption
        // execution_status for observability (agent is immutable per member).
        const memberRow = deps.db.query("SELECT session_id, agent, execution_status FROM team_member WHERE team_id = ? AND name = ?")
          .get(teamInfo.teamId, wakeTarget) as { session_id: string; agent: string; execution_status: string } | null
        const memberSessionId = memberRow?.session_id

        if (memberSessionId) {
          const baseText = `[System: Task "${t.id}" was unblocked and is ready for you to start]`
          const wake = resolveStandbyWake(deps.db, teamInfo.teamId, wakeTarget, baseText)

          if (wake.woke) {
            // Standby consumed: spawn_context prepend + standby → starting
            // transition (existing path, byte-compatible payload).
            const memberModel = getMemberModel(deps.db, teamInfo.teamId, wakeTarget)
            deps.client.session.promptAsync({
              sessionID: memberSessionId,
              parts: [{ type: "text", text: wake.text }],
              agent: wake.agent,
              synthetic: true,
              ...(memberModel ? { model: memberModel } : {})
            }).catch(err => {
              deps.db.run(
                "UPDATE team_member SET execution_status = 'standby', time_updated = ? WHERE team_id = ? AND name = ? AND execution_status = 'starting'",
                [Date.now(), teamInfo.teamId, wakeTarget]
              )
              log(`tasks-complete:wake-member:failed member=${wakeTarget} err=${String(err)}`)
            })
            log(`tasks-complete:wake-member:ok member=${wakeTarget} task=${t.id}`)
            wokeMembers++
          } else if (wakeTarget === t.assignee) {
            // HARNESS-16 UNCONDITIONAL: the board advanced (blocked → in_progress)
            // but a PRE-ASSIGNED owner that is ready/idle/busy was never woken —
            // resolveStandbyWake only reports woke for the standby consume, so
            // the owner slept while its status flipped → silent deadlock (T8).
            // Wake ALWAYS: explicit agent + member model first rung on the T6
            // model-aware ladder (step-down on rejection), synthetic system
            // prompt. No standby revert here: this branch never consumed the
            // standby window (a lost race means another delivery is already
            // in flight with the spawn_context prepend).
            try {
              const memberModel = getMemberModel(deps.db, teamInfo.teamId, wakeTarget)
              const primaryModel = memberModel
                ? `${memberModel.providerID}/${memberModel.modelID}${memberModel.variant ? `#${memberModel.variant}` : ""}`
                : undefined
              promptModelAwareWake(deps.client, {
                sessionID: memberSessionId,
                text: baseText,
                logTag: `tasks-complete:wake-member team=${teamInfo.teamId} member=${wakeTarget}`,
                agent: memberRow.agent || undefined,
                config: deps.config,
                ...(primaryModel ? { primaryModel } : {}),
              })
              log(`tasks-complete:wake-member:ok member=${wakeTarget} task=${t.id} state=${memberRow.execution_status} unconditional=true`)
              wokeMembers++
            } catch (err) {
              log(`tasks-complete:wake-member:failed member=${wakeTarget} err=${err instanceof Error ? err.message : String(err)}`)
            }
          }
          // else: standby-candidate fallback WITHOUT pre-assignment keeps the
          // legacy gate — silent unless resolveStandbyWake consumed the window.
        }
      }
    }
  }
  return { unblocked, wokeMembers }
}

/**
 * Result suffix shared by Flow 1 (submit_review) and Flow 3 (complete):
 * ` (unblocked N task(s)[, woke M member(s)])` — byte-identical format on both
 * paths so deterministic suites can assert one single string shape.
 */
function formatUnblockedSuffix(unblocked: number, wokeMembers: number): string {
  if (unblocked <= 0) return ""
  let msg = ` (unblocked ${unblocked} task${unblocked !== 1 ? "s" : ""}`
  if (wokeMembers > 0) {
    msg += `, woke ${wokeMembers} member${wokeMembers !== 1 ? "s" : ""}`
  }
  return `${msg})`
}

/** Normalize a directory path for comparison (strip trailing separators). */
function normalizeDir(dir: string): string {
  return dir.replace(/\/+$/, "")
}

/**
 * HARNESS-26A / HARNESS-27A — native post-QA auto-commit (Portão 1), multi-repo.
 *
 * When the Quality Gate reviewer (Clara — `isQAMember`) or the team lead
 * approves a functional card via `team_tasks_complete(action: 'complete')`, the
 * runtime commits EVERY affected repository LOCALLY so no manual `git add`/
 * `git commit` is ever required from the terminal. Commits are strictly local —
 * pushing stays reserved for the pre-push batch gate (Portão 2 / Diana).
 *
 * Affected repositories (HARNESS-27A) are discovered dynamically around the
 * room directory (`deps.directory`), never hardcoded:
 *   1. The room directory itself — committed ONLY when it IS the git toplevel;
 *      a path nested inside a larger repository is deliberately left untouched
 *      (26A safety: the runtime never commits an ancestor's tree).
 *   2. Nested repositories living INSIDE the room directory (bounded scan),
 *      e.g. submodules or sibling repos mounted in the workspace.
 *   3. Known ecosystem sibling repositories (directories next to the room dir)
 *      that are dirty AND touched during the room/task cycle (mtime >= the
 *      cycle's birth — earlier of team/task `time_created`, see
 *      `resolveFreshnessSince`). This window keeps unrelated working trees from
 *      other projects under the same parent out of the commit while never
 *      orphaning legitimate edits on long-running demands. Set
 *      `ENSEMBLE_AUTOCOMMIT_REPOS` (colon/comma/semicolon separated list of
 *      extra repo roots) to force-include repos regardless of freshness.
 *
 * Each affected repo with a non-empty `git status --porcelain` is committed
 * atomically via `sh -c 'git -C "$1" add -A && git -C "$1" commit -m "$2"'` —
 * `$1` (repo path) and `$2` (message) travel positionally, so task content with
 * quotes, backticks or `$()` is never interpreted by the shell.
 *
 * Returns the suffix appended to the completion message:
 *   - " Task completed and locally committed: <repo> (<hash>), <repo2> (<hash2>)"
 *   - " Task completed; working tree already clean (no commit needed)"
 *   - "" when no repository is affected, or when git failed (fail-graceful).
 * Every per-repo git failure is caught and logged; the SQLite board transition
 * has already happened and must never be rolled back by a git error.
 */

/** Max directory depth scanned for nested repositories inside the room dir. */
const NESTED_REPO_SCAN_DEPTH = 2

/**
 * Reference instant (epoch ms) bounding the freshness window for sibling
 * repositories: the birth of the current room/task cycle — the EARLIER of the
 * room and the task `time_created`.
 *
 * The former static one-hour clock (`Date.now() - 60*60*1000`) orphaned every
 * legitimate edit whenever a task ran longer than 1h between the first file
 * edit and the Quality Gate approval: the sibling repos' mtimes fell behind the
 * moving threshold and were never committed. Binding the window to the cycle's
 * own birth makes "fresh" mean "touched at any point during the life of the
 * demand" — 10 minutes, 2 hours or all day — while files dirtied BEFORE the room
 * was born stay safely excluded (no committing of unrelated trees).
 *
 * Defensive only: the schema marks both `team.time_created` and
 * `team_task.time_created` as NOT NULL, so the fallback is unreachable in
 * practice. If no finite reference exists, it accepts nothing rather than
 * everything, so an unknown cycle can never sweep an unrelated working tree.
 */
function resolveFreshnessSince(deps: ToolDeps, teamId: string, taskTimeCreated: number): number {
  const row = deps.db.query("SELECT time_created FROM team WHERE id = ?").get(teamId) as
    | { time_created?: number }
    | null
  const stamps = [row?.time_created, taskTimeCreated].filter(
    (v): v is number => typeof v === "number" && Number.isFinite(v),
  )
  if (stamps.length === 0) return Number.POSITIVE_INFINITY
  return Math.min(...stamps)
}

interface CommitTarget {
  path: string
  name: string
}

/** Resolve the git toplevel of `cwd`, normalized — or null when not in a repo. */
async function gitToplevel(cwd: string): Promise<string | null> {
  const res = await runCommand(["git", "rev-parse", "--show-toplevel"], { cwd })
  if (res.exitCode !== 0) return null
  const top = res.stdout.trim()
  return top.length > 0 ? normalizeDir(top) : null
}

/** True when `dir` is a git repository root (owns a `.git` entry, dir or file). */
function isRepoRoot(dir: string): boolean {
  return existsSync(path.join(dir, ".git"))
}

/** Enumerate git-repo roots nested inside `root` (bounded depth, no descent into a claimed repo). */
function findNestedRepoRoots(root: string, maxDepth: number): string[] {
  const found: string[] = []
  const walk = (dir: string, depth: number): void => {
    if (depth > maxDepth) return
    let entries: string[]
    try {
      entries = readdirSync(dir).sort()
    } catch {
      return
    }
    for (const entry of entries) {
      if (entry.startsWith(".") || entry === "node_modules") continue
      const child = path.join(dir, entry)
      let isDir = false
      try {
        isDir = statSync(child).isDirectory()
      } catch {
        continue
      }
      if (!isDir) continue
      if (isRepoRoot(child)) {
        found.push(normalizeDir(child))
        continue // never descend into a repo already claimed
      }
      walk(child, depth + 1)
    }
  }
  walk(root, 1)
  return found
}

/** Enumerate git-repo siblings of the room dir (immediate children of its parent). */
function findSiblingRepoRoots(dir: string): string[] {
  const normalized = normalizeDir(dir)
  const parent = path.dirname(normalized)
  const self = path.basename(normalized)
  const found: string[] = []
  let entries: string[]
  try {
    entries = readdirSync(parent).sort()
  } catch {
    return found
  }
  for (const entry of entries) {
    if (entry === self || entry.startsWith(".")) continue
    const child = path.join(parent, entry)
    try {
      if (!statSync(child).isDirectory()) continue
    } catch {
      continue
    }
    if (isRepoRoot(child)) found.push(normalizeDir(child))
  }
  return found
}

/** True when `repo` has dirty entries AND at least one was modified at/after `sinceMs`. */
async function hasFreshDirt(repo: string, sinceMs: number): Promise<boolean> {
  const status = await runCommand(["git", "status", "--porcelain"], { cwd: repo })
  if (status.exitCode !== 0) return false
  const lines = status.stdout.split("\n").map((l) => l.replace(/\s+$/, "")).filter((l) => l.length > 0)
  if (lines.length === 0) return false
  const threshold = sinceMs
  for (const line of lines) {
    // Porcelain v1: "XY <path>" or "XY <old> -> <new>". Strip the status field
    // and any rename arrow, then honor git's C-style quoting for exotic names.
    let rel = line.slice(3)
    const arrow = rel.indexOf(" -> ")
    if (arrow !== -1) rel = rel.slice(arrow + 4)
    rel = rel.replace(/^"|"$/g, "").trim()
    if (rel.length === 0) continue
    try {
      if (statSync(path.join(repo, rel)).mtimeMs >= threshold) return true
    } catch {
      // Deleted/renamed target: no stat — treat the intentional deletion as
      // activity so it still gets committed.
      return true
    }
  }
  return false
}

/** Parse the optional `ENSEMBLE_AUTOCOMMIT_REPOS` force-include override. */
function extraRepoRoots(): string[] {
  const raw = process.env.ENSEMBLE_AUTOCOMMIT_REPOS
  if (!raw) return []
  return raw
    .split(/[\n,;:]+/)
    .map((p) => p.trim())
    .filter((p) => p.length > 0)
}

/** Discover every repository affected by the demand, in commit order, deduped. */
async function resolveCommitTargets(dir: string, sinceMs: number): Promise<CommitTarget[]> {
  const targets: CommitTarget[] = []
  const seen = new Set<string>()
  const add = (rawPath: string) => {
    const p = normalizeDir(rawPath)
    if (seen.has(p)) return
    seen.add(p)
    targets.push({ path: p, name: path.basename(p) })
  }

  // 1) Room dir — only when it IS the git toplevel (26A nested-tree guard).
  const primary = await gitToplevel(dir)
  if (primary && primary === normalizeDir(dir)) {
    add(primary)
  } else if (primary) {
    log(`tasks-complete:autocommit:skip-non-root dir=${dir}`)
  }

  // 2) Nested repositories inside the room dir.
  for (const nested of findNestedRepoRoots(dir, NESTED_REPO_SCAN_DEPTH)) {
    if (nested !== normalizeDir(dir)) add(nested)
  }

  // 3) Known ecosystem siblings: dirty + touched during the room/task cycle.
  for (const sibling of findSiblingRepoRoots(dir)) {
    if (await hasFreshDirt(sibling, sinceMs)) add(sibling)
  }

  // 4) Explicit overrides — force-included regardless of freshness.
  for (const extra of extraRepoRoots()) {
    if (extra !== normalizeDir(dir) && isRepoRoot(extra)) add(extra)
  }

  // Deepest paths commit FIRST so that when a nested repo lives inside the room
  // repo, the outer `git add -A` records the nested repo's FINAL HEAD (gitlink)
  // and the outer tree ends clean. Stable sort keeps the discovery order as the
  // tie-breaker (siblings and the room dir share depth).
  const depth = (p: string) => p.split(path.sep).filter(Boolean).length
  targets.sort((a, b) => depth(b.path) - depth(a.path))

  return targets
}

async function autoCommitApprovedTask(deps: ToolDeps, taskContent: string, sinceMs: number): Promise<string> {
  const dir = deps.directory
  try {
    const targets = await resolveCommitTargets(dir, sinceMs)
    if (targets.length === 0) return "" // no affected repository — nothing to commit

    const message = `feat(runtime): ${taskContent}`
    const committed: Array<{ name: string; hash: string; path: string }> = []
    let sawDirty = false

    for (const target of targets) {
      try {
        const status = await runCommand(["git", "status", "--porcelain"], { cwd: target.path })
        if (status.exitCode !== 0) {
          log(`tasks-complete:autocommit:status-failed dir=${target.path} err=${status.stderr.trim()}`)
          continue
        }
        if (status.stdout.trim().length === 0) continue
        sawDirty = true

        // Atomic add + commit in one shell so a partial `git add` never lands
        // without its commit. $1 (repo path) and $2 (message) are positional —
        // never interpolated — so task content containing quotes, backticks or
        // `$()` is inert.
        const commit = await runCommand(
          ["sh", "-c", 'git -C "$1" add -A && git -C "$1" commit -m "$2"', "ensemble-autocommit", target.path, message],
          { cwd: target.path },
        )
        if (commit.exitCode !== 0) {
          log(`tasks-complete:autocommit:commit-failed dir=${target.path} err=${commit.stderr.trim()}`)
          continue
        }
        const rev = await runCommand(["git", "rev-parse", "--short", "HEAD"], { cwd: target.path })
        const hash = rev.exitCode === 0 ? rev.stdout.trim() : ""
        committed.push({ name: target.name, hash, path: target.path })
        log(`tasks-complete:autocommit:committed dir=${target.path} repo=${target.name} hash=${hash || "?"} task="${taskContent}"`)
      } catch (err) {
        // Fail-graceful per repo: one bad repo never aborts the others.
        log(`tasks-complete:autocommit:error dir=${target.path} err=${err instanceof Error ? err.message : String(err)}`)
      }
    }

    if (committed.length === 0) {
      // Dirty but every commit failed → no false-success suffix (fail-graceful).
      return sawDirty ? "" : " Task completed; working tree already clean (no commit needed)"
    }

    // Report the room repo first for readability (commits still ran deepest-first).
    const roomDir = normalizeDir(dir)
    const ordered = [...committed].sort((a, b) => Number(b.path === roomDir) - Number(a.path === roomDir))
    const evidence = ordered
      .map((c) => (c.hash ? `${c.name} (${c.hash})` : c.name))
      .join(", ")
    return ` Task completed and locally committed: ${evidence}`
  } catch (err) {
    // Graceful: the git hook must never break the SQLite task transition.
    log(`tasks-complete:autocommit:error dir=${dir} err=${err instanceof Error ? err.message : String(err)}`)
    return ""
  }
}

/**
 * Execute the team_tasks_complete tool. Marks a task as completed
 * and unblocks any dependent tasks.
 *
 * Supports cyclic review transitions:
 * - action='submit_review' (or status='in_review'): in_progress -> in_review
 *   * Also runs the dependent-unblock pass: downstream VALIDATION tasks
 *     (assignee is the SDET or the Quality Gate reviewer) whose depends_on
 *     points at the submitted task leave 'blocked' immediately —
 *     blocked -> in_progress (pre-assigned) / pending, with the owner woken
 *     (HARNESS-24 / SDET handover). Regular downstream tasks keep waiting
 *     for 'completed'.
 * - action='reject' (or status='in_progress' when in_review): in_review -> in_progress (QA reviewer/lead only)
 * - action='complete' (default): completed
 *   * If task is 'in_review', ONLY the Quality Gate reviewer (qa-role.ts) or 'lead' can complete it
 *     — this is what lets the final audit close upstream tasks of the same
 *     delivery that are still 'in_review' without orphaning the board.
 *   * Runs the same dependent-unblock pass against the now-'completed' trigger.
 *
 * Enforces task-board accuracy:
 * - Rejects completing an already-completed or cancelled task.
 * - Rejects completing a blocked task (dependencies must resolve first).
 * - Only the assignee (or the lead) may complete a claimed task.
 * - Completing an unclaimed task attributes it to the caller atomically.
 */
export async function executeTeamTasksComplete(
  deps: ToolDeps,
  args: TeamTasksCompleteArgs,
  sessionId: string,
): Promise<string> {
  const teamInfo = requireTeamMember(deps, sessionId)
  const caller = teamInfo.role === "lead" ? "lead" : (teamInfo.memberName ?? "unknown")

  const task = deps.db.query("SELECT id, content, status, assignee, rejection_count, review_notes, time_created FROM team_task WHERE id = ? AND team_id = ?")
    .get(args.task_id, teamInfo.teamId) as { id: string; content: string; status: string; assignee: string | null; rejection_count: number; review_notes: string | null; time_created: number } | null
  if (!task) throw new Error(`Task "${args.task_id}" not found`)

  const now = Date.now()
  const notes = args.review_notes ?? args.notes ?? null

  // Quality Gate reviewer (agnostic: is_qa flag / clara retrocompat) — resolved
  // once and reused by the submit/reject/complete paths below instead of
  // hardcoding the literal "clara" (see qa-role.ts contract).
  const qaMember = getTeamQAMember(deps.db, teamInfo.teamId)
  const qaLabel = qaMember?.name ?? "the Quality Gate reviewer"

  // Flow 0: SDET pass — record the deterministic-suite verdict on an in_review
  // card and hand the baton to the Quality Gate (HARNESS-27B). Strictly
  // SDET-exclusive: the deterministic-test engineer (isSDETMEmber — role='sdet'
  // flag / agent 'hugo' / base persona 'hugo') is the ONLY member allowed to
  // declare the suite green. The card STAYS in 'in_review' (only the Quality
  // Gate closes it); the verdict is persisted as review_notes + timestamp and
  // Clara is woken natively so the audit enters event-driven.
  if (args.action === "sdet_pass") {
    if (!isSDETMEmber(deps.db, teamInfo.teamId, caller)) {
      throw new Error("Only SDET can invoke sdet_pass")
    }
    if (task.status !== "in_review") {
      throw new Error("Task must be in review to record sdet_pass")
    }
    deps.db.run(
      "UPDATE team_task SET review_notes = ?, time_updated = ? WHERE id = ?",
      [notes, now, args.task_id],
    )
    if (qaMember) {
      wakeQualityGateForSdetPass(deps, teamInfo.teamId, args.task_id, notes, qaMember)
    }
    return `Task ${args.task_id} SDET verification recorded: ${notes ?? ""}. Quality Gate guardian notified.`
  }

  // Flow 1: Submit to review (in_progress -> in_review)
  const isSubmitReview = args.action === "submit_review" || args.action === "in_review" || args.status === "in_review"
  if (isSubmitReview) {
    if (task.status === "completed") throw new Error(`Task "${args.task_id}" is already completed`)
    if (task.status === "cancelled") throw new Error(`Task "${args.task_id}" was cancelled`)
    if (task.status === "blocked") throw new Error(`Task "${args.task_id}" is blocked by unresolved dependencies`)
    if (task.status === "in_review") throw new Error(`Task "${args.task_id}" is already in review`)
    if (task.assignee && teamInfo.role !== "lead" && caller !== task.assignee) {
      throw new Error(`Task "${args.task_id}" is claimed by ${task.assignee}`)
    }
    const assignee = task.assignee ?? caller
    deps.db.run(
      "UPDATE team_task SET status = 'in_review', assignee = ?, review_notes = ?, time_updated = ? WHERE id = ?",
      [assignee, notes ?? task.review_notes ?? null, now, args.task_id],
    )

    // Reset in-review nudge cooldown for the QA reviewer when a task is submitted or resubmitted for review
    if (qaMember) inReviewNudges.delete(`${teamInfo.teamId}:${qaMember.name}:${args.task_id}`)

    // HARNESS-23 (TASK-01): SDET-first review routing. When the room has an
    // SDET (qa-role.ts: role='sdet' flag / hugo agent / base persona) and the
    // submitter is NOT the SDET, the auto-wake targets the SDET for the
    // deterministic test suite and the Quality Gate (Clara) stays asleep — the
    // gate only enters after the SDET verdict. The SDET submitting its own
    // review, or rooms without an SDET, keep the original QA wake unchanged
    // (retrocompatibility).
    const sdetMember = getTeamSDETMember(deps.db, teamInfo.teamId)
    const callerIsSDET = isSDETMEmber(deps.db, teamInfo.teamId, caller)
    let sdetNotified = false
    let sdetWakeHeld = false
    let qaNotified = false
    if (sdetMember && !callerIsSDET) {
      // SDET present and submitter is not the SDET: wake the SDET for the
      // deterministic suite. HARNESS-25 consolidated-batch guard: hold the wake
      // back while the room still has functional development tasks
      // pending/in_progress — the suite only makes sense once the whole
      // functional batch is submitted. The LAST (or only) functional
      // submission releases the wake immediately.
      const pendingDev = countPendingDevelopmentTasks(deps, teamInfo, args.task_id)
      if (pendingDev > 0) {
        sdetWakeHeld = true
        log(`tasks-complete:sdet-wake:held team=${teamInfo.teamId} task=${args.task_id} pendingDev=${pendingDev}`)
      } else {
        // Never wake Clara at this moment (even when the SDET has no session,
        // the QA wake stays suppressed — the suite comes first by contract).
        sdetNotified = wakeReviewTarget(deps, teamInfo.teamId, args.task_id, caller, sdetMember, notes, "sdet")
      }
    } else if (qaMember && !isQAMember(deps.db, teamInfo.teamId, caller)) {
      // SDET submitting its own review, or no SDET in the room: original
      // Quality Gate wake (in_review nudge cooldown already reset above).
      qaNotified = wakeReviewTarget(deps, teamInfo.teamId, args.task_id, caller, qaMember, notes, "clara")
    }

    const notifiedLabel = sdetNotified && sdetMember
      ? ` (notified ${sdetMember.name} for deterministic tests)`
      : qaNotified && qaMember
        ? ` (notified ${qaMember.name} for review)`
        : ""
    const batchHeldLabel = sdetWakeHeld && sdetMember
      ? ` (SDET wake held until the functional batch is consolidated)`
      : ""

    // HARNESS-24 (TASK-01): Flow 1 historically returned HERE without ever
    // evaluating `depends_on`, so downstream validation tasks stayed 'blocked'
    // until FULL approval and team_claim on the SDET test task bounced back to
    // the yield/standby directive. The shared pass unblocks them the moment
    // the upstream delivery enters 'in_review' (validation profile only —
    // see unblockDependents/isValidationProfileTask).
    const submittedUnblock = unblockDependents(deps, teamInfo, args.task_id, now)

    return `Submitted task for review: ${task.content}${notes ? ` (notes: ${notes})` : ""}${notifiedLabel}${batchHeldLabel}${formatUnblockedSuffix(submittedUnblock.unblocked, submittedUnblock.wokeMembers)}`
  }

  // Flow 2: Reject review (in_review -> in_progress)
  const isReject = args.action === "reject" || args.action === "reject_review" || (task.status === "in_review" && (args.action === "in_progress" || args.status === "in_progress"))
  if (isReject) {
    if (task.status !== "in_review") {
      throw new Error(`Task "${args.task_id}" is not in review (current status: ${task.status})`)
    }
    // HARNESS-25 — review guardians. The Quality Gate reviewer (isQAMember)
    // and the SDET (isSDETMEmber) may both reject a THIRD-PARTY card sitting in
    // 'in_review': the QA reject closes a failed audit, the SDET reject is the
    // deterministic-test failure path. The legacy error string is preserved for
    // rooms without an SDET (byte-stable with the pre-HARNESS-25 suites).
    const rejecterIsQA = isQAMember(deps.db, teamInfo.teamId, caller)
    const rejecterIsSDET = isSDETMEmber(deps.db, teamInfo.teamId, caller)
    if (teamInfo.role !== "lead" && !rejecterIsQA && !rejecterIsSDET) {
      const rejecters = getTeamSDETMember(deps.db, teamInfo.teamId)
        ? `${qaLabel}, the SDET, or the team lead`
        : `${qaLabel} or the team lead`
      throw new Error(`Only ${rejecters} can reject tasks in review`)
    }
    // Auto-review is forbidden: no guardian may reject a card assigned to
    // itself (the SDET rejects third-party deliveries, never its own suite).
    if (rejecterIsQA || rejecterIsSDET) {
      if (task.assignee && caller === task.assignee) {
        throw new Error(`Task "${args.task_id}" is assigned to you; you cannot reject your own review (auto-review is forbidden)`)
      }
    }
    const newRejectionCount = (task.rejection_count ?? 0) + 1
    deps.db.run(
      "UPDATE team_task SET status = 'in_progress', rejection_count = ?, review_notes = ?, time_updated = ? WHERE id = ?",
      [newRejectionCount, notes, now, args.task_id],
    )
    // Notify the ORIGINAL implementer that the card bounced back with the
    // rejection/test-error notes (HARNESS-25), so rework is event-driven.
    let notifiedAssignee = ""
    if (task.assignee && task.assignee !== caller) {
      const notified = notifyRejectedImplementer(
        deps, teamInfo.teamId, args.task_id, caller, task.assignee, notes, rejecterIsSDET && !rejecterIsQA,
      )
      if (notified) notifiedAssignee = ` (notified ${task.assignee})`
    }
    return `Rejected task: ${task.content} (rejection #${newRejectionCount})${notes ? ` - ${notes}` : ""}${notifiedAssignee}`
  }

  // Flow 3: Complete task (-> completed)
  if (task.status === "completed") throw new Error(`Task "${args.task_id}" is already completed`)
  if (task.status === "cancelled") throw new Error(`Task "${args.task_id}" was cancelled`)
  if (task.status === "blocked") throw new Error(`Task "${args.task_id}" is blocked by unresolved dependencies`)

  // Guardiã lock: if task is in_review, only the QA reviewer or Lead can approve and complete
  if (task.status === "in_review") {
    // HARNESS-25 hardened: the Quality Gate reviewer (isQAMember) approves
    // third-party cards; the SDET runs the deterministic suite but can NEVER
    // complete (QA-exclusive role); the original implementer cannot approve its
    // own card. The team lead retains sovereign authority.
    if (teamInfo.role !== "lead" && !isQAMember(deps.db, teamInfo.teamId, caller)) {
      if (isSDETMEmber(deps.db, teamInfo.teamId, caller)) {
        throw new Error(`Task "${args.task_id}" is in review; the SDET runs the deterministic suite but cannot approve — only ${qaLabel} or the team lead can complete it`)
      }
      throw new Error(`Task "${args.task_id}" is in review; only ${qaLabel} or the team lead can complete it`)
    }
  } else if (task.status === "in_progress" && task.assignee && teamInfo.role !== "lead" && caller !== task.assignee) {
    throw new Error(`Task "${args.task_id}" is claimed by ${task.assignee}`)
  }

  if (task.assignee) {
    deps.db.run("UPDATE team_task SET status = 'completed', time_updated = ? WHERE id = ?", [now, args.task_id])
  } else {
    // Attribute an unclaimed task to the caller so the board reflects who did it.
    const result = deps.db.run(
      "UPDATE team_task SET status = 'completed', assignee = ?, time_updated = ? WHERE id = ? AND assignee IS NULL",
      [caller, now, args.task_id]
    )
    if (result.changes === 0) {
      throw new Error(`Task "${args.task_id}" was just completed by another teammate`)
    }
  }

  // Unblock dependent tasks — SHARED pass (extracted from this flow so
  // Flow 1/submit_review runs the exact same evaluation). The trigger is now
  // 'completed'; the validation-profile rule also relaxes sibling deps still
  // in 'in_review', so a delivery's audit chain closes without orphaning the
  // board (see unblockDependents).
  const { unblocked, wokeMembers } = unblockDependents(deps, teamInfo, args.task_id, now)

  // Fire progress toast so the lead has visibility
  const counts = deps.db.query(
    "SELECT status, COUNT(*) as c FROM team_task WHERE team_id = ? GROUP BY status"
  ).all(teamInfo.teamId) as Array<{ status: string; c: number }>
  const completed = counts.find(r => r.status === "completed")?.c ?? 0
  // DEF-2 (deadlock do board wake): `total` conta apenas tarefas não canceladas.
  // Com `cancelled` dentro do denominador, `completed === total` fica inalcançável
  // e o lead nunca é acordado — o board trava em silêncio permanente.
  const total = counts.reduce((sum, r) => (r.status === "cancelled" ? sum : sum + r.c), 0)
  // Tarefas ainda ativas = pending | in_progress | in_review | blocked. Com o total acima
  // restrito a esses mesmos status + completed, `activeRemaining === 0` é
  // equivalente a `completed === total` (defesa em profundidade explícita).
  const activeRemaining = counts.reduce(
    (sum, r) => (r.status === "pending" || r.status === "in_progress" || r.status === "in_review" || r.status === "blocked" ? sum + r.c : sum),
    0,
  )
  const who = teamInfo.memberName ?? "teammate"
  try {
    deps.client.tui.showToast({
      title: "Team",
      message: `${who}: ${completed}/${total} tasks complete`,
      variant: "info",
      duration: 3000,
    }).catch(() => { /* TUI may not be available */ })
  } catch { log(`tasks-complete:toast:failed`) }

  // Systematic board wake (silent-lead design): when the last active task on the
  // board flips to completed, wake the lead session with a synthetic system prompt.
  // While silentLead is active the lead receives no text-message prompts, so
  // board closure is the one event that must reach them.
  // DEF-2: cancelled tasks no longer block this — `total` excludes them and
  // `activeRemaining === 0` guarantees no pending/in_progress/blocked work is left.
  if (total > 0 && completed === total && activeRemaining === 0) {
    // NOTE: team_member has no `role` column (see schema.ts) — the lead's
    // session id lives on team.lead_session_id, the same canonical source
    // team_broadcast uses to address the lead (never a team_member session).
    const leadRow = deps.db.query("SELECT lead_session_id FROM team WHERE id = ?")
      .get(teamInfo.teamId) as { lead_session_id?: string | null } | null
    const leadSessionId = leadRow?.lead_session_id
    if (leadSessionId) {
      // Board closure wake: neutral notification to lead session.
      // Deliberately modelless and agentless: preserving lead sovereignty.
      // Subagents must never dictate which model or agent the lead session runs.
      try {
        deps.client.session.promptAsync({
          sessionID: leadSessionId,
          parts: [{ type: "text", text: `[System: All team tasks completed on board by ${who}]` }],
          synthetic: true,
        }).catch((err) => {
          log(`tasks-complete:wake-lead:failed team=${teamInfo.teamId} err=${err instanceof Error ? err.message : String(err)}`)
        })
        log(`tasks-complete:wake-lead:sent leadSession=${leadSessionId} by=${who}`)
      } catch (err) {
        log(`tasks-complete:wake-lead:failed team=${teamInfo.teamId} err=${err instanceof Error ? err.message : String(err)}`)
      }
    }
  }

  // HARNESS-26A — native post-QA auto-commit (Portão 1). When the Quality Gate
  // reviewer (Clara — isQAMember) or the team lead approves the card here, the
  // runtime commits the shared workspace LOCALLY and atomically so no manual
  // `git add`/`git commit` is needed. Local only: pushing stays reserved for the
  // pre-push batch gate (Portão 2 / Diana). Git failures are swallowed — the
  // board transition above already happened.
  let commitSuffix = ""
  if (teamInfo.role === "lead" || isQAMember(deps.db, teamInfo.teamId, caller)) {
    // TICKET freshness-window: bind the sibling-repo freshness window to the
    // birth of the room/task cycle (earlier of the two), never a static clock.
    const sinceMs = resolveFreshnessSince(deps, teamInfo.teamId, task.time_created)
    commitSuffix = await autoCommitApprovedTask(deps, task.content, sinceMs)
  }

  return `Completed task: ${task.content}${formatUnblockedSuffix(unblocked, wokeMembers)}${commitSuffix}`
}

export async function executeTeamTasksReview(
  deps: ToolDeps,
  args: { task_id: string; notes?: string; review_notes?: string },
  sessionId: string,
): Promise<string> {
  return executeTeamTasksComplete(deps, { ...args, action: "submit_review" }, sessionId)
}

export async function executeTeamTasksReject(
  deps: ToolDeps,
  args: { task_id: string; notes?: string; review_notes?: string },
  sessionId: string,
): Promise<string> {
  return executeTeamTasksComplete(deps, { ...args, action: "reject" }, sessionId)
}
