import type { ToolDeps } from "../types"
import { requireTeamMember } from "./shared"
import { parseTaskResult, formatTaskResult } from "../result-parser"

/** Row shape for unread messages query. */
interface UnreadMessageRow {
  id: string
  from_name: string
  content: string
  time_created: number
}

/**
 * Retrieve unread messages from the team message store.
 * Optionally filter by sender name. Marks returned messages as read.
 */
export async function executeTeamResults(
  deps: ToolDeps,
  args: { from?: string },
  sessionId: string,
): Promise<string> {
  const team = requireTeamMember(deps, sessionId)

  // Recipient isolation (TICKET-HARNESS-33B): without a `to_name` predicate the
  // query leaked every unread DM in the room (including private peer-to-peer
  // threads and messages addressed exclusively to the lead) and flipped
  // `read = 1` for all of them, denying those messages to their real owners.
  // The caller is resolved from their session: the lead reads rows addressed to
  // 'lead'; a teammate reads rows addressed to its own member name. Broadcast
  // rows (to_name IS NULL) are team-wide and visible to every member.
  const callerName = team.role === "lead" ? "lead" : (team.memberName ?? "")

  const rows = args.from
    ? (deps.db
        .query(
          "SELECT id, from_name, content, time_created FROM team_message WHERE team_id = ? AND read = 0 AND (to_name = ? OR to_name IS NULL) AND from_name = ? ORDER BY time_created ASC",
        )
        .all(team.teamId, callerName, args.from) as UnreadMessageRow[])
    : (deps.db
        .query(
          "SELECT id, from_name, content, time_created FROM team_message WHERE team_id = ? AND read = 0 AND (to_name = ? OR to_name IS NULL) ORDER BY time_created ASC",
        )
        .all(team.teamId, callerName) as UnreadMessageRow[])

  if (rows.length === 0) return "No unread messages."

  // Mark ONLY the messages returned in this call as read — other recipients'
  // DMs stay unread for them.
  const ids = rows.map((r) => r.id)
  const placeholders = ids.map(() => "?").join(", ")
  deps.db.run(`UPDATE team_message SET read = 1 WHERE id IN (${placeholders})`, ids)

  // Format output — parse structured task results when present
  return rows.map((r) => {
    const parsed = parseTaskResult(r.content)
    if (parsed) return formatTaskResult(r.from_name, parsed)
    return `[Message from ${r.from_name}]:\n${r.content}`
  }).join("\n\n")
}
