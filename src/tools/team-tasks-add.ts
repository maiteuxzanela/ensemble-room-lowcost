import type { ToolDeps } from "../types"
import { requireTeamMember } from "./shared"
import { generateId } from "../util"

interface TaskInput {
  content: string
  priority: string
}

/**
 * Execute the team_tasks_add tool. Adds tasks to the shared board.
 *
 * TICKET-HARNESS-51 — every task is born directly in `'pending'`: the board is
 * a flat, fully-parallel pool. There is no chaining parameter and no
 * `'blocked'` state — coordination between fronts happens through
 * `team_message` (disjoint fronts) or `team_task_handover` (sequential baton pass
 * on the SAME card), never through an artificial DAG.
 */
export async function executeTeamTasksAdd(
  deps: ToolDeps,
  args: { tasks: TaskInput[] },
  sessionId: string,
): Promise<string> {
  const teamInfo = requireTeamMember(deps, sessionId)

  const ids: string[] = []
  const now = Date.now()

  for (const task of args.tasks) {
    if (!task) continue
    const id = generateId("task")
    ids.push(id)

    deps.db.run(
      "INSERT INTO team_task (id, team_id, content, status, priority, time_created, time_updated) VALUES (?, ?, ?, 'pending', ?, ?, ?)",
      [id, teamInfo.teamId, task.content, task.priority, now, now]
    )
  }

  return `Added ${ids.length} task${ids.length !== 1 ? "s" : ""}: ${ids.join(", ")}`
}
