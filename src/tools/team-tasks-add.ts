import type { ToolDeps } from "../types"
import { requireTeamMember } from "./shared"
import { generateId } from "../util"

interface TaskInput {
  content: string
  priority: string
  depends_on?: string[]
}

/**
 * Execute the team_tasks_add tool. Adds tasks to the shared board.
 * Tasks with unresolved dependencies are marked as 'blocked'.
 */
export async function executeTeamTasksAdd(
  deps: ToolDeps,
  args: { tasks: TaskInput[]; sequential?: boolean },
  sessionId: string,
): Promise<string> {
  const teamInfo = requireTeamMember(deps, sessionId)

  const ids: string[] = []
  const now = Date.now()

  // Determine if automatic sequential chaining is needed
  const hasExplicitDependencies = args.tasks.some(t => t.depends_on && t.depends_on.length > 0)
  const isSequential = args.sequential === true || (args.tasks.length > 1 && !hasExplicitDependencies)

  for (let i = 0; i < args.tasks.length; i++) {
    const task = args.tasks[i]
    if (!task) continue
    const id = generateId("task")
    ids.push(id)

    // Apply sequential dependencies if required
    if (isSequential && i > 0) {
      if (!task.depends_on) task.depends_on = []
      const prevId = ids[i - 1]
      if (prevId && !task.depends_on.includes(prevId)) {
        task.depends_on.push(prevId)
      }
    }

    const depsJson = task.depends_on?.length ? JSON.stringify(task.depends_on) : null

    // Determine initial status — blocked if has unresolved dependencies
    let status = "pending"
    if (task.depends_on?.length) {
      const resolved = task.depends_on.every(depId => {
        if (ids.includes(depId)) return false // Created in this batch, obviously not completed yet
        const dep = deps.db.query("SELECT status FROM team_task WHERE id = ? AND team_id = ?")
          .get(depId, teamInfo.teamId) as { status: string } | null
        return dep && (dep.status === "completed" || dep.status === "cancelled")
      })
      if (!resolved) status = "blocked"
    }

    deps.db.run(
      "INSERT INTO team_task (id, team_id, content, status, priority, depends_on, time_created, time_updated) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
      [id, teamInfo.teamId, task.content, status, task.priority, depsJson, now, now]
    )
  }

  return `Added ${ids.length} task${ids.length !== 1 ? "s" : ""}: ${ids.join(", ")}`
}
