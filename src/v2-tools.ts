import type { ToolDeps } from "./types"
import { executeTeamCreate } from "./tools/team-create"
import { executeTeamSpawn } from "./tools/team-spawn"
import { executeTeamMessage } from "./tools/team-message"
import { executeTeamBroadcast } from "./tools/team-broadcast"
import { executeTeamTasksList } from "./tools/team-tasks-list"
import { executeTeamTasksAdd } from "./tools/team-tasks-add"
import { executeTeamTasksComplete } from "./tools/team-tasks-complete"
import { executeTeamClaim } from "./tools/team-claim"
import { executeTeamResults } from "./tools/team-results"
import { executeTeamShutdown } from "./tools/team-shutdown"
import { executeTeamCleanup } from "./tools/team-cleanup"
import { executeTeamMerge } from "./tools/team-merge"
import { executeTeamStatus } from "./tools/team-status"
import { executeTeamView } from "./tools/team-view"

/** V2 tool definition (JSON Schema input, structured content output). */
export interface V2ToolDef {
  name: string
  description: string
  input: Record<string, unknown>
  execute(input: unknown, context: { sessionID: string }): Promise<{ content: string }>
}

/** Minimal structural subset of the V2 tool domain. */
export interface V2ToolDomain {
  transform(cb: (editor: { add(def: V2ToolDef): void }) => void): Promise<{ dispose(): Promise<void> }>
}

/** JSON Schema string property. */
function str(description: string): Record<string, unknown> {
  return { type: "string", description }
}

/** JSON Schema boolean property with default. */
function bool(description: string, fallback: boolean): Record<string, unknown> {
  return { type: "boolean", description, default: fallback }
}

/** Task priority enum shared by the schema and the runtime validator. */
const TASK_PRIORITIES = ["high", "medium", "low"] as const
type TaskPriority = (typeof TASK_PRIORITIES)[number]

/** JSON Schema enum property for task priority. */
function priority(): Record<string, unknown> {
  return { type: "string", description: "Task priority", enum: [...TASK_PRIORITIES], default: "medium" }
}

/** Throw on unknown priority — fail fast instead of writing garbage to SQLite. */
export function normalizePriority(value: string | undefined): TaskPriority {
  if (value === undefined) return "medium"
  if ((TASK_PRIORITIES as readonly string[]).includes(value)) return value as TaskPriority
  throw new Error(`Invalid priority "${value}" — expected one of: high, medium, low.`)
}

/**
 * Register all 14 team tools on a V2 context. Each execute delegates to the
 * same implementation V1 uses (DRY) — only arg transport changes from Zod to
 * JSON Schema. V1 applied schema defaults before execute; V2 may not, so
 * priority is normalized here (team_tasks_add writes it straight to SQLite).
 *
 * Purge approval (team_cleanup) has no approver on V2 yet — the question-tool
 * flow it used is TUI-side. Preview works; confirmed purge needs the forms
 * slice. team_view resolves without navigating (no server-side TUI select).
 */
export async function registerV2Tools(domain: V2ToolDomain, deps: ToolDeps): Promise<void> {
  const run = <A>(
    fn: (deps: ToolDeps, args: A, sessionID: string) => Promise<string>,
    track?: (sessionID: string, args: A) => void,
  ) => async (input: unknown, context: { sessionID: string }) => {
    const args = input as A
    track?.(context.sessionID, args)
    return { content: await fn(deps, args, context.sessionID) }
  }
  const runSession = (fn: (deps: ToolDeps, sessionID: string) => Promise<string>) => async (
    _input: unknown,
    context: { sessionID: string },
  ) => ({ content: await fn(deps, context.sessionID) })

  await domain.transform((editor) => {
    editor.add({
      name: "team_create",
      description: "Create a new agent team. You become the team lead. Use this before spawning teammates.",
      input: {
        type: "object",
        properties: {
          name: str("Team name (lowercase alphanumeric with hyphens, 1-64 chars)"),
          project_name: str("Project display name for first use of this working directory."),
        },
        required: ["name"],
        additionalProperties: false,
      },
      execute: run(executeTeamCreate),
    })

    editor.add({
      name: "team_spawn",
      description:
        "Spawn a new teammate that works in parallel. The teammate starts immediately with the given prompt. " +
        "Each teammate gets their own git worktree for file isolation. " +
        "Teammates work asynchronously and will message you when done. Do not poll for their status.",
      input: {
        type: "object",
        properties: {
          name: str("Teammate name (lowercase alphanumeric with hyphens)"),
          agent: str("Agent type (e.g. 'build', 'plan', 'explore')"),
          prompt: str("Task instructions for the teammate"),
          model: str("Model in provider/model format (optional, uses default)"),
          claim_task: str("Task ID to auto-claim for this teammate (optional)"),
          worktree: bool("Create a git worktree for file isolation (default: true, set false for read-only agents)", true),
          plan_approval: bool("Require teammate to send a plan for approval before writing files (default: false)", false),
          standby: bool("Register the teammate WITHOUT sending its init prompt (zero tokens at birth). Stored as ready/standby with the full prompt in spawn_context; woken with the context prepended by the first team_message/team_broadcast (default: false)", false),
        },
        required: ["name", "prompt"],
        additionalProperties: false,
      },
      execute: run(executeTeamSpawn),
    })

    editor.add({
      name: "team_message",
      description:
        "Send a message to a specific teammate or to the lead. Use 'lead' to message the team lead. " +
        "Lead only: pass 'model' (provider/model) to update a teammate's model in-place.",
      input: {
        type: "object",
        properties: {
          to: str("Recipient name ('lead' or teammate name)"),
          text: str("Message content (max 10KB). Optional only when 'model' is provided."),
          approve: bool("Approve a teammate's plan (only when recipient has plan_approval='pending')", false),
          reject: str("Reject a teammate's plan with reason (only when recipient has plan_approval='pending')"),
          force: bool("Lead only. Re-activate a teammate who already reported task completion.", false),
          model: str("Lead only: update the recipient teammate's model in-place, in 'provider/model' format."),
        },
        required: ["to"],
        additionalProperties: false,
      },
      execute: run(executeTeamMessage, (sessionID, args) => {
        const to = args.to ?? ""
        deps.progressTracker.recordMessage(sessionID)
        if (to !== "lead") deps.progressTracker.recordPeerMessage(sessionID)
      }),
    })

    editor.add({
      name: "team_broadcast",
      description: "Send a message to all teammates and the lead (excluding yourself).",
      input: {
        type: "object",
        properties: { text: str("Message content (max 10KB)") },
        required: ["text"],
        additionalProperties: false,
      },
      execute: run(executeTeamBroadcast, (sessionID) => {
          deps.progressTracker.recordMessage(sessionID)
          deps.progressTracker.recordPeerMessage(sessionID)
        },
      ),
    })

    editor.add({
      name: "team_tasks_list",
      description:
        "View the shared team task board. Use this to check task status, not to wait for teammates. Teammates will message you when done.",
      input: { type: "object", properties: {}, additionalProperties: false },
      execute: runSession(executeTeamTasksList),
    })

    editor.add({
      name: "team_tasks_add",
      description: "Add tasks to the shared team task board so teammates can see what work is available and claim it.",
      input: {
        type: "object",
        properties: {
          tasks: {
            type: "array",
            description: "Tasks to add",
            items: {
              type: "object",
              properties: {
                content: str("Task description"),
                priority: priority(),
                depends_on: {
                  type: "array",
                  items: { type: "string" },
                  description: "Task IDs this depends on",
                },
              },
              required: ["content"],
              additionalProperties: false,
            },
          },
          sequential: bool("If true, or if tasks.length > 1 and no depends_on is provided in any task, tasks are added in sequence where each task depends on the previous one", false),
        },
        required: ["tasks"],
        additionalProperties: false,
      },
      execute: async (input: unknown, context: { sessionID: string }) => {
        const args = input as {
          tasks: Array<{ content: string; priority?: string; depends_on?: string[] }>
          sequential?: boolean
        }
        const content = await executeTeamTasksAdd(
          deps,
          {
            tasks: args.tasks.map((task) => ({
              content: task.content,
              priority: normalizePriority(task.priority),
              ...(task.depends_on ? { depends_on: task.depends_on } : {}),
            })),
            sequential: args.sequential,
          },
          context.sessionID,
        )
        return { content }
      },
    })

    editor.add({
      name: "team_tasks_complete",
      description: "Mark a task as completed on the shared board. This unblocks any tasks that depend on it.",
      input: {
        type: "object",
        properties: { task_id: str("ID of the task to mark complete") },
        required: ["task_id"],
        additionalProperties: false,
      },
      execute: run(executeTeamTasksComplete, (sessionID) =>
        deps.progressTracker.recordTaskComplete(sessionID),
      ),
    })

    editor.add({
      name: "team_claim",
      description: "Claim a pending task from the shared task list. Only unclaimed, unblocked tasks can be claimed.",
      input: {
        type: "object",
        properties: { task_id: str("ID of the task to claim") },
        required: ["task_id"],
        additionalProperties: false,
      },
      execute: run(executeTeamClaim),
    })

    editor.add({
      name: "team_results",
      description:
        "Retrieve full message content from teammates. Returns unread messages and marks them as read. Use this after receiving a truncated message notification.",
      input: {
        type: "object",
        properties: { from: str("Filter messages by sender name (optional, returns all if omitted)") },
        additionalProperties: false,
      },
      execute: run(executeTeamResults),
    })

    editor.add({
      name: "team_shutdown",
      description:
        "Request a teammate to shut down. The teammate finishes current work then stops. Pass force: true to abort immediately without waiting.",
      input: {
        type: "object",
        properties: {
          member: str("Teammate name to shut down"),
          force: bool("Force immediate abort without waiting for current work to finish", false),
        },
        required: ["member"],
        additionalProperties: false,
      },
      execute: run(executeTeamShutdown),
    })

    editor.add({
      name: "team_cleanup",
      description:
        "Clean up the current team, or purge archived teams after human approval. Omit purge for normal cleanup.",
      input: {
        type: "object",
        properties: {
          force: bool("Force cleanup even if members are active (will abort them)", false),
          acknowledge_uncommitted: bool("Acknowledge uncommitted changes", false),
          purge: {
            type: "array",
            items: { type: "string" },
            description: "Archived team names to permanently delete, or ['*'] for all archived teams.",
          },
          confirm_purge: bool("Set true only after the user explicitly approves the purge preview.", false),
          confirm_token: str("Confirmation token from the purge preview."),
        },
        additionalProperties: false,
      },
      execute: async (input: unknown, context: { sessionID: string }) => {
        const args = input as {
          force?: boolean
          acknowledge_uncommitted?: boolean
          purge?: string[]
          confirm_purge?: boolean
          confirm_token?: string
        }
        const content = await executeTeamCleanup(
          deps,
          {
            force: args.force ?? false,
            acknowledge_uncommitted: args.acknowledge_uncommitted,
            purge: args.purge,
            confirm_purge: args.confirm_purge,
            confirm_token: args.confirm_token,
          },
          context.sessionID,
        )
        return { content }
      },
    })

    editor.add({
      name: "team_merge",
      description:
        "Merge a shutdown teammate's branch into the working directory as unstaged changes. Use this after team_shutdown to review and integrate a teammate's work. The teammate must be shut down first.",
      input: {
        type: "object",
        properties: { member: str("Teammate name whose branch to merge") },
        required: ["member"],
        additionalProperties: false,
      },
      execute: run(executeTeamMerge),
    })

    editor.add({
      name: "team_status",
      description:
        "View team members with their current status, agent type, and session IDs. Use this to check who is working, idle, or shut down. Includes a task summary.",
      input: { type: "object", properties: {}, additionalProperties: false },
      execute: runSession(executeTeamStatus),
    })

    editor.add({
      name: "team_view",
      description:
        "Resolve a teammate's session so the user can inspect it. Default reports the session ID + status without switching. " +
        "navigate: true switches the user's client — ONLY when the user explicitly asked to view the teammate's session.",
      input: {
        type: "object",
        properties: {
          member: str("Teammate name to view"),
          navigate: bool("Switch the user's client to this session. Only when the user explicitly asked.", false),
        },
        required: ["member"],
        additionalProperties: false,
      },
      execute: run(executeTeamView),
    })
  })
}
