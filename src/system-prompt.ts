import type { Database } from "./db"
import { markDelivered } from "./messaging"
import { parseTaskResult, formatTaskResult } from "./result-parser"
import { getTeamSDETMember, isSDETMEmber, isQAMember } from "./qa-role"
import type { EnsembleConfig } from "./config"

/** Truncate a string to maxLen chars, appending "..." if truncated. */
function truncate(s: string, maxLen: number): string {
  return s.length > maxLen ? `${s.slice(0, maxLen)}...` : s
}

/** Status display mapping from DB status to human-readable label. */
const STATUS_DISPLAY: Record<string, string> = {
  busy: "working",
  ready: "idle",
  shutdown_requested: "shutting down",
  shutdown: "shut down",
  error: "error",
}

/**
 * Directive injected into teammate prompts about reporting to the lead.
 *
 * With `silentLead` active (the default) the aggressive coercion is dropped —
 * lead-bound messages are persisted and surfaced without waking the lead, so
 * demanding a report "before stopping" only manufactures spurious lead wakes
 * and board churn. The replacement points the teammate at the real contract:
 * talk to peers via team_message and close work on the shared board.
 * Legacy `silentLead: false` keeps the original wording byte-for-byte.
 */
function leadReportDirective(config?: Required<EnsembleConfig>): string {
  return config?.silentLead === false
    ? "You MUST send your results to the lead via team_message before stopping."
    : "Collaborate with teammates using team_message, submit completed work for review or mark assigned tasks on the board."
}

/**
 * Build the system prompt injected into the lead's session.
 * Includes team name, member statuses, task counts, and anti-polling guidance.
 */
export function buildLeadSystemPrompt(db: Database, teamId: string, config?: Required<EnsembleConfig>): string {
  const team = db.query("SELECT name FROM team WHERE id = ?").get(teamId) as { name: string } | null
  if (!team) return ""

  const members = db.query("SELECT name, status FROM team_member WHERE team_id = ?").all(teamId) as Array<{ name: string; status: string }>

  const taskCounts = db.query(
    "SELECT status, COUNT(*) as count FROM team_task WHERE team_id = ? GROUP BY status",
  ).all(teamId) as Array<{ status: string; count: number }>

  const countMap: Record<string, number> = {}
  for (const row of taskCounts) {
    countMap[row.status] = row.count
  }

  const completed = countMap.completed ?? 0
  const inProgress = countMap.in_progress ?? 0
  const inReview = countMap.in_review ?? 0
  const pending = countMap.pending ?? 0

  const memberList = members
    .map((m) => `${m.name} [${STATUS_DISPLAY[m.status] ?? m.status}]`)
    .join(", ")

  const teammateLine = members.length > 0
    ? `Teammates: ${memberList}`
    : "Teammates: none"

  const pendingMessages = db.query(
    "SELECT id, from_name, content FROM team_message WHERE team_id = ? AND to_name = 'lead' AND delivered = 0 ORDER BY time_created ASC"
  ).all(teamId) as Array<{ id: string; from_name: string; content: string }>

  const lines = [
    `You are leading team "${team.name}" with ${members.length} active teammates.`,
    teammateLine,
    `Tasks: ${completed} completed, ${inProgress} in progress${inReview ? `, ${inReview} in review` : ""}, ${pending} pending`,
  ]

  // Inline active and recently completed tasks
  const activeTasks = db.query(
    "SELECT content, assignee, status FROM team_task WHERE team_id = ? AND status IN ('in_progress', 'in_review') ORDER BY time_updated DESC LIMIT 5"
  ).all(teamId) as Array<{ content: string; assignee: string | null; status: string }>

  const recentCompleted = db.query(
    "SELECT content, assignee FROM team_task WHERE team_id = ? AND status = 'completed' ORDER BY time_updated DESC LIMIT 3"
  ).all(teamId) as Array<{ content: string; assignee: string | null }>

  if (activeTasks.length > 0) {
    lines.push("Active tasks:")
    for (const t of activeTasks) {
      lines.push(`  [${t.status}] ${truncate(t.content, 120)}${t.assignee ? ` → ${t.assignee}` : ""}`)
    }
  }
  if (recentCompleted.length > 0) {
    lines.push("Recently completed:")
    for (const t of recentCompleted) {
      lines.push(`  [completed] ${truncate(t.content, 120)}${t.assignee ? ` → ${t.assignee}` : ""}`)
    }
  }

  if (pendingMessages.length > 0) {
    lines.push("", "--- Team Messages ---")
    const MAX_MSG = 500
    for (const msg of pendingMessages) {
      const parsed = parseTaskResult(msg.content)
      if (parsed) {
        // Truncate details for system prompt — full content available via team_results
        const truncatedResult = { ...parsed, details: truncate(parsed.details, 500) }
        lines.push(formatTaskResult(msg.from_name, truncatedResult))
      } else if (msg.content.length > MAX_MSG) {
        lines.push(`[From ${msg.from_name}]: ${msg.content.slice(0, MAX_MSG)}... (use team_results to read full message)`)
      } else {
        lines.push(`[From ${msg.from_name}]: ${msg.content}`)
      }
      markDelivered(db, msg.id)
    }
    lines.push("--- End Messages ---")
  }

  // Model selection guidance (only when promptForModels is enabled)
  if (config?.promptForModels) {
    const poolOptions = (config.modelPool && config.modelPool.length > 0)
      ? config.modelPool.map(m => `      { label: "${m}", description: "" }`).join(",\n")
      : ""
    lines.push(
      "",
      "MODEL SELECTION:",
      "Before spawning teammates, use the question tool to ask the user about model preferences.",
      "Do NOT spawn any agents until the user confirms their model preference.",
      "Keep descriptions simple and clear — explain what each option means in plain language.",
      "Example question tool call:",
      '  question({ questions: [{ question: "Which AI models should your team agents use?", header: "Agent models", options: [',
      '    { label: "Same as me (Recommended)", description: "Every agent uses the same model I\'m running on. Simplest option — no extra setup needed." },',
      '    { label: "Mix of models", description: "Each agent gets a different model from your configured pool. Useful for getting diverse perspectives on the same problem." },',
      '    { label: "I\'ll choose per agent", description: "You pick the exact model for each agent as I spawn them. Most control, but requires a choice per agent." }',
      "  ]}]})",
    )
    if (poolOptions) {
      lines.push(
        'If user picks "Mix of models", ask which models with multiple: true:',
        "  question({ questions: [{ question: \"Which models should agents rotate through? Pick all that apply.\", header: \"Model pool\", multiple: true, options: [",
        poolOptions,
        "  ]}]})",
      )
    }
    lines.push(
      'If user picks "I\'ll choose per agent", ask for each agent\'s model individually before each team_spawn call.',
      "Pass the chosen model via the model parameter on each team_spawn call.",
    )
  }

  lines.push(
    "",
    "Spawn teammates ONE AT A TIME. Wait for each tool result before spawning the next.",
    "This avoids git worktree contention. Once all are spawned, wait for their messages.",
    "Read-only agents (explore, plan) automatically skip worktree creation.",
    "For other agents that only need to read, pass worktree: false to avoid unnecessary isolation.",
    "",
    "Teammates work asynchronously and message you when done.",
    "Do NOT poll team_status or team_tasks_list repeatedly — wait for messages.",
    "After spawning all teammates, tell the user what you've set up and wait.",
    "When all teammates finish, summarize results and suggest next steps.",
    "",
    "MERGE WORKFLOW:",
    "When teammates use isolated worktrees (worktree: true), use team_merge to merge their branch after they finish and you shut them down.",
    "In shared workspace mode (worktree: false), all teammates work in the same checkout directly — no branch merging is needed.",
    "Do NOT tell teammates to commit — in isolated worktrees they handle that themselves, and in shared workspaces commits follow the quality gate / delivery workflow.",
    "Do NOT run git merge manually — use team_merge which squash-merges and unstages for you.",
    "team_cleanup will safety-net merge any branches you forgot, but prefer explicit team_merge.",
    "",
    "Before calling team_cleanup, verify teammates using isolated worktrees have committed their work.",
    "team_shutdown will warn you if a teammate has uncommitted changes in their worktree.",
    "team_cleanup will block if any worktree has uncommitted changes — merge or commit first.",
    "To permanently delete archived teams, call team_cleanup with purge: [\"team-name\"] or purge: [\"*\"] for all archived teams.",
    "The first purge call is preview-only and deletes nothing.",
    "Use the question tool to ask the user for visible human approval before deleting archived team records or preserved Ensemble branches.",
    "The question must include the exact approval and denial option labels shown in the preview.",
    "Only if the user selects that exact approval option, call team_cleanup again with the same purge value, confirm_purge: true, and the confirm_token from the preview.",
  )

  return lines.join("\n")
}

/**
 * Build the system prompt injected into a teammate's session.
 * Includes role reminder and delivers any pending peer messages.
 */
export function buildTeammateSystemPrompt(db: Database, teamId: string, memberName: string, config?: Required<EnsembleConfig>): string {
  const team = db.query("SELECT name FROM team WHERE id = ?").get(teamId) as { name: string } | null
  if (!team) return ""

  const lines = [
    `You are "${memberName}", a teammate in team "${team.name}". Use team_message to communicate. ${leadReportDirective(config)}`,
    "",
    "ANTI-POLLING & EVENT-DRIVEN CONTRACT:",
    "Do NOT poll team_tasks_list or team_status in loops waiting for task unblocking or peer work.",
    "Operate purely event-driven: claim tasks using team_claim. If a task is blocked, claiming it pre-assigns and locks it to you; then stop and enter standby via team_standby.",
    "The runtime automatically wakes you with a synthetic system prompt when dependent tasks are unblocked or peer messages arrive.",
    "",
    "ANTI-DUMPING & CODE EXPLORATION CONTRACT:",
    "Do NOT use bash grep, find, or broad shell scans across codebases.",
    "Use targeted search tools (e.g. qmd_search, ripgrep) or targeted read/edit on specific files. Never dump files >300 lines or raw command outputs into context.",
    "",
    "DELIVERY CONTRACT:",
    "Intermediate interactions and partial/in-progress deliveries during development happen EXCLUSIVELY via team_message(to: '<colleague>') — coordinate peer-to-peer; never open a review for partial work.",
    "submit_review is the SINGLE channel for the FINAL consolidation of the functionality: it moves the card in_progress -> in_review and wakes the reviewer. Use it ONLY when the deliverable is complete.",
    "Do NOT send a redundant team_message(to: 'lead') for partial work — report to the lead only when the task is fully complete.",
    "If a genuinely blocking decision requires the lead, escalate with decision_lead instead of a best-effort message.",
  ]

  // HARNESS-23 (TASK-02): SDET-first delivery order, resolved against the LIVE
  // room membership every turn (spawn-order independent):
  //   - Implementers with an SDET in the room hand the baton EXCLUSIVELY to the
  //     SDET after submit_review; the Quality Gate is not a direct peer for them.
  //   - The Quality Gate guardian waits for the SDET's deterministic suite before
  //     auditing — the wake only reaches it after the SDET verdict.
  //   - The SDET itself is reminded never to self-audit (auto-review is banned).
  const roomSdet = getTeamSDETMember(db, teamId)
  if (roomSdet && isSDETMEmber(db, teamId, memberName) && memberName === roomSdet.name) {
    lines.push(
      "",
      "SDET HANDOVER:",
      "You are the deterministic-test engineer (SDET) for this room. After you submit a task via submit_review, the Quality Gate reviewer is woken automatically — do not audit your own delivery and do not message the reviewer directly to hand off.",
      "Once your REAL deterministic suite for a delivery in 'in_review' is 100% green, record the verdict with team_tasks_complete(action: 'sdet_pass', notes: '...') — the Quality Gate reviewer is woken automatically to audit (never approve the card yourself via action: 'complete').",
    )
  } else if (roomSdet && !isQAMember(db, teamId, memberName)) {
    lines.push(
      "",
      "SDET HANDOVER:",
      `After submitting a task via submit_review, pass the baton exclusively to the SDET (${roomSdet.name}) via team_message(to: '${roomSdet.name}') for the deterministic test suite. The Quality Gate is NOT a direct peer for you — it only enters after the SDET verdict.`,
    )
  } else if (roomSdet) {
    lines.push(
      "",
      "QUALITY GATE ORDER:",
      `Wait for the SDET's (${roomSdet.name}) deterministic test suite before auditing: implementers pass the baton to the SDET after submit_review, and only then is the review routed to you. Do not audit deliveries that skipped the deterministic suite.`,
    )
  }

  // Deliver pending peer messages addressed to this teammate
  const pendingMessages = db.query(
    "SELECT id, from_name, content FROM team_message WHERE team_id = ? AND to_name = ? AND delivered = 0 ORDER BY time_created ASC"
  ).all(teamId, memberName) as Array<{ id: string; from_name: string; content: string }>

  if (pendingMessages.length > 0) {
    lines.push("", "--- Messages for you ---")
    const MAX_MSG = 500
    for (const msg of pendingMessages) {
      const parsed = parseTaskResult(msg.content)
      if (parsed) {
        lines.push(formatTaskResult(msg.from_name, { ...parsed, details: truncate(parsed.details, MAX_MSG) }))
      } else if (msg.content.length > MAX_MSG) {
        lines.push(`[From ${msg.from_name}]: ${msg.content.slice(0, MAX_MSG)}... (truncated)`)
      } else {
        lines.push(`[From ${msg.from_name}]: ${msg.content}`)
      }
      markDelivered(db, msg.id)
    }
    lines.push("--- End Messages ---")
  }

  return lines.join("\n")
}

/**
 * Build a concise context string for compaction.
 * Includes team name, member statuses, task progress, and role statement.
 */
export function buildTeamCompactionContext(
  db: Database,
  teamId: string,
  role: "lead" | "member",
  memberName?: string,
  config?: Required<EnsembleConfig>,
): string {
  const team = db.query("SELECT name FROM team WHERE id = ?").get(teamId) as { name: string } | null
  if (!team) return ""

  const members = db.query("SELECT name, status FROM team_member WHERE team_id = ?").all(teamId) as Array<{ name: string; status: string }>

  const taskCounts = db.query(
    "SELECT status, COUNT(*) as count FROM team_task WHERE team_id = ? GROUP BY status",
  ).all(teamId) as Array<{ status: string; count: number }>

  const countMap: Record<string, number> = {}
  for (const row of taskCounts) {
    countMap[row.status] = row.count
  }

  const completed = countMap.completed ?? 0
  const inProgress = countMap.in_progress ?? 0
  const inReview = countMap.in_review ?? 0
  const pending = countMap.pending ?? 0

  const roleLine = role === "lead"
    ? `[Team Context] You are the lead of team "${team.name}".`
    : `[Team Context] You are a teammate named "${memberName}" in team "${team.name}".`

  const memberList = members
    .map((m) => `${m.name} (${STATUS_DISPLAY[m.status] ?? m.status})`)
    .join(", ")

  const membersLine = members.length > 0
    ? `Members: ${memberList}`
    : "Members: none"

  const lines = [
    roleLine,
    membersLine,
    `Tasks: ${completed} completed, ${inProgress} in progress${inReview ? `, ${inReview} in review` : ""}, ${pending} pending`,
  ]

  if (role === "member" && memberName) {
    lines.push(`IMPORTANT: ${leadReportDirective(config)}`)

    // Include original task prompt
    const member = db.query("SELECT prompt FROM team_member WHERE team_id = ? AND name = ?")
      .get(teamId, memberName) as { prompt: string | null } | null
    if (member?.prompt) {
      lines.push(`Your original task: ${truncate(member.prompt, 300)}`)
    }

    // Include recent messages involving this member
    const recentMsgs = db.query(
      "SELECT from_name, content FROM team_message WHERE team_id = ? AND (from_name = ? OR to_name = ?) ORDER BY time_created DESC LIMIT 3"
    ).all(teamId, memberName, memberName) as Array<{ from_name: string; content: string }>
    if (recentMsgs.length > 0) {
      lines.push("Recent context:")
      for (const msg of recentMsgs) {
        lines.push(`  [${msg.from_name}]: ${truncate(msg.content, 200)}`)
      }
    }
  } else if (role === "member") {
    lines.push(`IMPORTANT: ${leadReportDirective(config)}`)
  }

  if (role === "lead") {
    // Include recently completed tasks
    const completedTasks = db.query(
      "SELECT content, assignee FROM team_task WHERE team_id = ? AND status = 'completed' ORDER BY time_updated DESC LIMIT 5"
    ).all(teamId) as Array<{ content: string; assignee: string | null }>
    if (completedTasks.length > 0) {
      lines.push("Recently completed:")
      for (const t of completedTasks) {
        lines.push(`  [completed] ${truncate(t.content, 120)}${t.assignee ? ` (by ${t.assignee})` : ""}`)
      }
    }
  }

  return lines.join("\n")
}
