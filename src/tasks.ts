import type { Database } from "./db"

/**
 * Release all unfinished tasks assigned to a departing member back to the
 * shared pool so another teammate can pick them up. Completed and cancelled
 * tasks are left untouched. Returns the total number of tasks affected.
 *
 * TICKET-HARNESS-36 (P4/P5) — the two-part release closes the orphan/stuck-card
 * gap for a member that reaches a terminal state (shutdown, timeout, crash
 * recovery, or spawn rollback):
 *
 *   1. `in_progress` AND `in_review` cards assigned to the member are set back
 *      to `pending` with `assignee = NULL`: an `in_review` card whose reviewer
 *      died is just as stuck as an `in_progress` one (only the `complete`/`lead`
 *      verdict would otherwise move it, and the dead member can no longer act).
 *   2. `blocked` cards assigned to the member keep their `blocked` status (the
 *      dependency is still unresolved) but drop the dead assignee, so the
 *      pre-assigned slot does not leak to a ghost member forever.
 */
export function releaseMemberTasks(db: Database, teamId: string, memberName: string): number {
  const released = db.run(
    "UPDATE team_task SET status = 'pending', assignee = NULL, time_updated = ? WHERE team_id = ? AND assignee = ? AND status IN ('in_progress', 'in_review')",
    [Date.now(), teamId, memberName],
  )
  const unassigned = db.run(
    "UPDATE team_task SET assignee = NULL, time_updated = ? WHERE team_id = ? AND assignee = ? AND status = 'blocked'",
    [Date.now(), teamId, memberName],
  )
  return released.changes + unassigned.changes
}
