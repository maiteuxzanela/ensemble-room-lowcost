import type { Database } from "../db"
import type { ToolDeps } from "../types"
import { requireTeamMember } from "./shared"
import { setMemberStandby } from "./team-standby"
import { sendMessage } from "../messaging"
import { resolveLeadWakeContext, promptModelAwareWake } from "../notify"
import { formatModelSelector, resolveFallbackChainForAgent } from "../config"
import { log } from "../log"

export interface DecisionLeadArgs {
  question: string
  context: string
  options?: string[]
}

/**
 * Mark a team as awaiting an emergency decision from the lead (Migration 15,
 * HARNESS-22). Idempotent: re-raising simply refreshes the requester/timestamp.
 * The room-inactivity watchdog reads `awaiting_lead_decision` and PAUSES Clara's
 * autoawake while it is set.
 */
export function markAwaitingLeadDecision(db: Database, teamId: string, memberName: string): void {
  const now = Date.now()
  db.run(
    "UPDATE team SET awaiting_lead_decision = 1, awaiting_decision_member = ?, awaiting_decision_at = ?, time_updated = ? WHERE id = ?",
    [memberName, now, now, teamId],
  )
  log(`decision-lead:raised team=${teamId} member=${memberName}`)
}

/**
 * Lift the pending-decision pause. Called when the lead deliberates — i.e. a
 * lead-authored `team_message` — so the room-inactivity watchdog resumes its
 * normal Clara autoawake. Guarded on `awaiting_lead_decision = 1` so a no-op
 * never bumps `time_updated` (which would look like room activity).
 */
export function clearAwaitingLeadDecision(db: Database, teamId: string): void {
  const result = db.run(
    "UPDATE team SET awaiting_lead_decision = 0, awaiting_decision_member = NULL, awaiting_decision_at = NULL, time_updated = ? WHERE id = ? AND awaiting_lead_decision = 1",
    [Date.now(), teamId],
  )
  if (result.changes > 0) log(`decision-lead:cleared team=${teamId}`)
}

/** True when the team has a pending lead decision (watchdog pause signal). */
export function hasAwaitingLeadDecision(db: Database, teamId: string): boolean {
  const row = db.query("SELECT awaiting_lead_decision FROM team WHERE id = ?")
    .get(teamId) as { awaiting_lead_decision: number } | null
  return row?.awaiting_lead_decision === 1
}

/**
 * Execute the decision_lead tool (HARNESS-22).
 *
 * A teammate that needs an out-of-band ruling from the lead calls this instead
 * of a best-effort `team_message(to: 'lead')` that would sit silenced under
 * `silentLead: true`. The tool:
 *   1. marks the team as awaiting a lead decision (SQLite flag, Migration 15);
 *   2. transitions the emitting member to `execution_status = 'standby'`;
 *   3. durably persists the question to the lead in `team_message` (delivered=0)
 *      BEFORE any wake, so a rate-limited/failed lead wake can never lose it —
 *      the row is read passively on the lead's next turn;
 *   4. wakes the lead DIRECTLY — punching through silentLead — on the lead's
 *      agent (`team.lead_agent`) and its resilient model chain
 *      (`resolveFallbackChainForAgent`, delivered via the shared model-aware
 *      wake ladder);
 *   5. fires a high-priority toast so the human lead sees the request.
 *
 * The decision pause is lifted when the lead replies (a lead-authored
 * `team_message` calls clearAwaitingLeadDecision).
 */
export async function executeDecisionLead(
  deps: ToolDeps,
  args: DecisionLeadArgs,
  sessionId: string,
): Promise<string> {
  const teamInfo = requireTeamMember(deps, sessionId)
  if (teamInfo.role === "lead") {
    throw new Error("Only teammates can request an emergency decision from the lead.")
  }
  const memberName = teamInfo.memberName
  if (!memberName) {
    throw new Error("Unknown member name for session")
  }

  const question = args.question?.trim()
  if (!question) {
    throw new Error("decision_lead requires a non-empty 'question'.")
  }
  const context = args.context?.trim()
  if (!context) {
    throw new Error("decision_lead requires a non-empty 'context'.")
  }
  const options = (args.options ?? [])
    .map((o) => (typeof o === "string" ? o.trim() : ""))
    .filter((o) => o.length > 0)

  const optionsBlock = options.length > 0
    ? `\nOptions:\n${options.map((o, i) => `  ${i + 1}. ${o}`).join("\n")}`
    : ""
  const payload = `[System: EMERGENCY DECISION REQUIRED from ${memberName}]: ${question}\n${context}${optionsBlock}`

  // 1. Record the pending decision BEFORE waking the lead, so the watchdog
  //    pause is observable the instant the lead is asked.
  markAwaitingLeadDecision(deps.db, teamInfo.teamId, memberName)

  // 2. Suspend the emitting member immediately — it must not burn tokens while
  //    it waits for the ruling. Runtime standby (spawn_context cleared) so the
  //    lead's reply wakes it with a bare message, not a replayed birth prompt.
  setMemberStandby(deps.db, teamInfo.teamId, memberName, "awaiting lead decision")

  // 3. Durably persist the question in the message history BEFORE any wake is
  //    attempted. If the lead's model chain is rate-limited or the wake itself
  //    fails, the row survives with delivered = 0 and is read passively by the
  //    lead on its next turn (system-prompt transform) — the emergency question
  //    is never lost to a failed promptAsync.
  sendMessage(deps.db, {
    teamId: teamInfo.teamId,
    from: memberName,
    to: "lead",
    content: payload,
  })

  // 4. Wake the lead, punching through silentLead, on the lead's agent and its
  //    resilient fallback chain (resolveFallbackChainForAgent). The shared
  //    model-aware wake builds the retry ladder from that chain.
  const ctx = resolveLeadWakeContext(deps.db, teamInfo.teamId)
  if (ctx) {
    const chain = resolveFallbackChainForAgent(deps.config, ctx.leadAgent)
    const primaryModel = chain.length > 0 ? formatModelSelector(chain[0]!) : undefined
    promptModelAwareWake(deps.client, {
      sessionID: ctx.leadSessionId,
      text: payload,
      logTag: `decision-lead:wake team=${teamInfo.teamId} member=${memberName}`,
      agent: ctx.leadAgent,
      config: deps.config,
      primaryModel,
    })
  } else {
    log(`decision-lead:no-lead team=${teamInfo.teamId} member=${memberName} — decision recorded but lead could not be resolved`)
  }

  // 5. High-priority surface for the human lead.
  try {
    await deps.client.tui.showToast({
      title: "Decision required",
      message: `Lead decision required from ${memberName}`,
      variant: "warning",
      duration: 8000,
    })
  } catch {
    // TUI may not be available — silently ignore
  }

  return `Emergency decision requested from the lead. You are now in standby until the lead responds.`
}
