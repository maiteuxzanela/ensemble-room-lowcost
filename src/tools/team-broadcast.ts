import type { ToolDeps } from "../types"
import { requireTeamMember, resolveStandbyWake } from "./shared"
import { getMemberModel } from "../member-model"
import { broadcastMessageFanout, markDelivered, hasReportedCompletion } from "../messaging"
import { log } from "../log"

/**
 * Execute the team_broadcast tool. Sends a message to all team members + lead (excluding sender).
 *
 * TICKET-HARNESS-33B — resilient per-recipient delivery: the broadcast is
 * persisted as ONE row per recipient (fan-out) instead of a single shared
 * `to_name = NULL` row. The shared row could not track delivery per recipient
 * (the `delivered` flag is per-row), so stamping it after the first successful
 * `promptAsync` marked the whole broadcast delivered and silently lost it for
 * every recipient whose transport failed afterwards. With per-recipient rows a
 * partial failure leaves only the failed recipient's row pending — recoverable
 * by the recovery sweep (members) or the system prompt (the silent lead).
 *
 * Under `silentLead` the lead's row is persisted but never woken here: it is
 * delivered passively by the lead's system prompt.
 */
export async function executeTeamBroadcast(
  deps: ToolDeps,
  args: { text: string },
  sessionId: string,
): Promise<string> {
  const teamInfo = requireTeamMember(deps, sessionId)

  const senderName = teamInfo.role === "lead" ? "lead" : (teamInfo.memberName ?? "unknown")

  // Recipients that must receive a persisted row (excluding sender). `prompt`
  // distinguishes active transport delivery from passive (silent lead) delivery.
  const recipients: Array<{ name: string; sessionId: string; prompt: boolean }> = []

  // Lead: under silentLead the row is persisted for the lead's system prompt but
  // no wake is issued (passive SQLite accumulation).
  if (teamInfo.role !== "lead") {
    const leadSession = deps.db.query("SELECT lead_session_id FROM team WHERE id = ?")
      .get(teamInfo.teamId) as { lead_session_id: string } | null
    if (leadSession?.lead_session_id) {
      const prompt = !deps.config?.silentLead
      recipients.push({ name: "lead", sessionId: leadSession.lead_session_id, prompt })
      if (!prompt) log(`team_broadcast:lead-silenced from=${senderName}`)
    }
  }

  // All members except the sender. Skip teammates who already reported
  // completion to prevent re-waking them (issue #3).
  const members = deps.registry.listByTeam(teamInfo.teamId)
  for (const member of members) {
    if (member.sessionId === sessionId) continue
    if (hasReportedCompletion(deps.db, teamInfo.teamId, member.memberName)) continue
    recipients.push({ name: member.memberName, sessionId: member.sessionId, prompt: true })
  }

  if (recipients.length === 0) return "Broadcast sent to 0 recipients."

  // Fan-out: one persisted row per recipient, each carrying its own `delivered` flag.
  const rows = broadcastMessageFanout(deps.db, {
    teamId: teamInfo.teamId,
    from: senderName,
    content: args.text,
    recipients: recipients.map((r) => r.name),
  })
  const idByRecipient = new Map(rows.map((r) => [r.recipient, r.id]))

  const baseText = `[Team broadcast from ${senderName}]: ${args.text}`
  let skipped = 0
  for (const recipient of recipients) {
    if (!recipient.prompt) {
      // silentLead: the lead's row waits in SQLite for its next system prompt.
      skipped++
      continue
    }
    // Standby wake (see resolveStandbyWake): a member spawned with standby:true
    // has never been prompted, so its first delivery replays spawn_context and
    // transitions execution_status 'standby' -> 'starting'. The lead and every
    // non-standby member get the payload untouched; the wake carries the
    // member's `agent`, which spawn normally passes on the first promptAsync.
    const wake: { text: string; woke: boolean; agent?: string } = recipient.name !== "lead"
      ? resolveStandbyWake(deps.db, teamInfo.teamId, recipient.name, baseText)
      : { text: baseText, woke: false }

    const memberModel = recipient.name !== "lead"
      ? getMemberModel(deps.db, teamInfo.teamId, recipient.name)
      : undefined
    const msgId = idByRecipient.get(recipient.name)

    deps.client.session.promptAsync({
      sessionID: recipient.sessionId,
      parts: [{ type: "text", text: wake.text }],
      ...(wake.agent ? { agent: wake.agent } : {}),
      ...(memberModel ? { model: memberModel } : {})
    }).then(() => {
      // Mark ONLY this recipient's row delivered — peers keep their own state.
      if (msgId) markDelivered(deps.db, msgId)
    }).catch((err) => {
      log(`team_broadcast:deliver:failed to=${recipient.name} err=${err instanceof Error ? err.message : String(err)}`)
      // Fail-safe: restore the standby window if the wake prompt never landed,
      // so a retry replays spawn_context (guarded — never demotes a member that
      // already went busy). The recipient's row stays delivered=0 for recovery.
      if (wake.woke) {
        deps.db.run(
          "UPDATE team_member SET execution_status = 'standby', time_updated = ? WHERE team_id = ? AND name = ? AND execution_status = 'starting'",
          [Date.now(), teamInfo.teamId, recipient.name],
        )
        log(`team_broadcast:wake:reverted to=standby name=${recipient.name} (promptAsync failed)`)
      }
    })
  }

  const sent = recipients.length - skipped
  return `Broadcast sent to ${sent} recipient${sent !== 1 ? "s" : ""}.`
}
