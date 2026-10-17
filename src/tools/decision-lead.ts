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
 * One member waiting on a lead ruling. Persisted (JSON) in
 * `team.awaiting_decision_members` (Migration 18, TICKET-HARNESS-37 / M4).
 * `payload` is the exact text that was injected into the lead's channel — it
 * lets an idempotent re-raise detect that it would be re-injecting the SAME
 * payload and skip the duplicate send/wake.
 */
export interface PendingLeadDecision {
  member: string
  at: number
  payload: string
}

/**
 * Read the per-member pending-decision queue (Migration 18). Tolerates a
 * missing column (pre-Migration-18 database opened read-only) and any malformed
 * JSON — degrades to an empty queue rather than throwing.
 */
function readPendingDecisions(db: Database, teamId: string): PendingLeadDecision[] {
  let raw: string | null = null
  try {
    const row = db.query("SELECT awaiting_decision_members FROM team WHERE id = ?")
      .get(teamId) as { awaiting_decision_members: string | null } | null
    raw = row?.awaiting_decision_members ?? null
  } catch {
    return []
  }
  if (!raw) return []
  try {
    const parsed = JSON.parse(raw)
    if (!Array.isArray(parsed)) return []
    return parsed
      .filter((e): e is Record<string, unknown> => !!e && typeof e === "object")
      .filter((e) => typeof e.member === "string")
      .map((e) => ({
        member: String(e.member),
        at: typeof e.at === "number" ? e.at : 0,
        payload: typeof e.payload === "string" ? e.payload : "",
      }))
  } catch {
    return []
  }
}

/**
 * Persist the queue and keep the aggregate flag + legacy observability columns
 * coherent: `awaiting_lead_decision` is 1 iff the queue is non-empty (the sole
 * watchdog pause signal), while `awaiting_decision_member` / `_at` mirror the
 * latest raise (backward compatibility with the Migration 15 contract).
 */
function writePendingDecisions(db: Database, teamId: string, entries: PendingLeadDecision[]): void {
  const now = Date.now()
  if (entries.length === 0) {
    db.run(
      "UPDATE team SET awaiting_lead_decision = 0, awaiting_decision_members = NULL, awaiting_decision_member = NULL, awaiting_decision_at = NULL, time_updated = ? WHERE id = ?",
      [now, teamId],
    )
    return
  }
  const latest = entries[entries.length - 1]!
  db.run(
    "UPDATE team SET awaiting_lead_decision = 1, awaiting_decision_members = ?, awaiting_decision_member = ?, awaiting_decision_at = ?, time_updated = ? WHERE id = ?",
    [JSON.stringify(entries), latest.member, latest.at, now, teamId],
  )
}

/**
 * Mark that `memberName` is awaiting an emergency decision from the lead
 * (Migration 15 + Migration 18, HARNESS-22 / TICKET-HARNESS-37-M4). Multiple
 * members may be pending at once; the pause is lifted only when the LAST one is
 * cleared. Idempotent per member: re-raising refreshes the timestamp (and, when
 * the caller passes a `payload`, the stored payload) instead of appending a
 * duplicate queue entry. Returns `duplicate: true` when the SAME payload was
 * already pending for this member — the caller uses it to avoid re-injecting a
 * duplicate payload into the lead's channel.
 */
export function markAwaitingLeadDecision(
  db: Database,
  teamId: string,
  memberName: string,
  payload?: string,
): { duplicate: boolean; members: string[] } {
  const now = Date.now()
  const entries = readPendingDecisions(db, teamId)
  const idx = entries.findIndex((e) => e.member === memberName)
  const incomingPayload = payload ?? ""
  let duplicate = false
  if (idx >= 0) {
    const existing = entries[idx]!
    duplicate = incomingPayload.length > 0 && existing.payload === incomingPayload
    entries[idx] = { member: memberName, at: now, payload: incomingPayload || existing.payload }
  } else {
    entries.push({ member: memberName, at: now, payload: incomingPayload })
  }
  writePendingDecisions(db, teamId, entries)
  log(`decision-lead:raised team=${teamId} member=${memberName} pending=${entries.length} duplicate=${duplicate}`)
  return { duplicate, members: entries.map((e) => e.member) }
}

/**
 * Lift the pending-decision pause — individually or wholesale.
 *
 * - `memberName` given AND that member is pending → removes ONLY that member
 *   from the queue; the pause survives while any other member is still waiting
 *   (M4: answering one member must not unlock nor silence another).
 * - `memberName` given but NOT pending (e.g. the lead replies to a third party)
 *   → a general deliberation clears the whole queue (backward-compatible with
 *   the pre-M4 contract: any lead-authored message lifted the pause).
 * - `memberName` omitted → clears the whole queue.
 *
 * The watchdog pause (`awaiting_lead_decision`) is 0 only when the queue is
 * empty. No-op writes are skipped so `time_updated` is never bumped without a
 * real state change (which the watchdog would read as room activity).
 */
export function clearAwaitingLeadDecision(db: Database, teamId: string, memberName?: string): void {
  const entries = readPendingDecisions(db, teamId)
  const hadFlag = hasAwaitingLeadDecision(db, teamId)
  let remaining: PendingLeadDecision[]
  if (memberName) {
    const isPending = entries.some((e) => e.member === memberName)
    remaining = isPending ? entries.filter((e) => e.member !== memberName) : []
  } else {
    remaining = []
  }
  if (remaining.length === entries.length && !hadFlag) return
  writePendingDecisions(db, teamId, remaining)
  if (remaining.length === 0) log(`decision-lead:cleared team=${teamId}`)
  else log(`decision-lead:partial-clear team=${teamId} member=${memberName} pending=${remaining.length}`)
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
 *   1. enqueues the emitting member as awaiting a lead decision (SQLite queue,
 *      Migration 18; aggregate flag Migration 15) — one entry per member, so
 *      several teammates can wait at once and the pause survives until the last
 *      is answered;
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
 * An exact re-raise (same member, same payload) is short-circuited: the member
 * is (re)suspended but no duplicate payload is persisted or injected.
 *
 * The decision pause is lifted per member when the lead replies — a lead-authored
 * `team_message` calls `clearAwaitingLeadDecision(..., recipient)` — and only
 * fully when no member is left pending.
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
  //    pause is observable the instant the lead is asked. The queue tracks one
  //    entry PER MEMBER (Migration 18): several teammates may wait on the lead
  //    simultaneously and the pause survives until the last one is answered.
  const mark = markAwaitingLeadDecision(deps.db, teamInfo.teamId, memberName, payload)

  // 2. Suspend the emitting member immediately — it must not burn tokens while
  //    it waits for the ruling. Runtime standby (spawn_context cleared) so the
  //    lead's reply wakes it with a bare message, not a replayed birth prompt.
  setMemberStandby(deps.db, teamInfo.teamId, memberName, "awaiting lead decision")

  // Anti-redundancy (M4): if this EXACT payload is already pending for this
  // member, do not re-send the durable message nor re-wake the lead — that
  // would just re-inject a duplicate payload into the lead's channel. The
  // member is already suspended; the original raise owns the delivery.
  if (mark.duplicate) {
    log(`decision-lead:duplicate team=${teamInfo.teamId} member=${memberName} — payload already pending; no re-send/re-wake`)
    return `Emergency decision already pending with the lead for ${memberName}. You are now in standby until the lead responds.`
  }

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
