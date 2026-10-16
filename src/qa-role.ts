import type { Database } from "./db"

/**
 * Local mirror of `resolveBasePersona` (src/tools/team-spawn.ts): the
 * multi-instance convention `<persona>-<suffix>` / `<persona>_<suffix>` →
 * canonical lowercase base persona ("clara-1" / "clara_2" → "clara").
 *
 * Deliberately duplicated as a one-liner instead of imported: importing from
 * `tools/team-spawn` would couple this lower-level module to the tool layer
 * and, once team-spawn starts importing `isQAMember`/`getTeamQAMember` (the
 * agnostic-QA refactor), would form an ESM import cycle
 * (qa-role ⇄ tools/team-spawn). Keep in sync with team-spawn's copy if the
 * naming convention ever changes.
 */
function resolveBasePersona(memberName: string): string {
  return (memberName.split(/[-_]/)[0] ?? memberName).toLowerCase()
}

/**
 * Central, transport-agnostic helpers for identifying the Quality Gate
 * reviewer (Clara) on a team. Every consumer that needs to wake, CC, nudge or
 * watchdog the reviewer MUST go through these helpers instead of hardcoding the
 * string "clara", so that the reviewer can be flagged explicitly (via the
 * `is_qa` column from Migration 14) while remaining fully backward compatible
 * with databases and teams created before that migration.
 *
 * This module also hosts the SDET (deterministic-test engineer, Hugo)
 * counterparts — isSDETMEmber / getTeamSDETMember — following the same
 * explicit-flag-first (Migration 16 `role = 'sdet'`) + retrocompat fallback
 * contract, so the HARNESS-23 submit_review routing (SDET suite first, Quality
 * Gate after) never hardcodes the string "hugo" at call sites.
 */

/** Essential fields a caller needs to wake / CC / watchdog the QA reviewer. */
export interface QAMemberInfo {
  name: string
  sessionId: string
  status: string
  executionStatus: string
  agent: string
  lastNudgedAt: number | null
}

/**
 * Determine whether a team member is the Quality Gate reviewer.
 *
 * Returns true when ANY of the following holds:
 *   1. The member's row has `is_qa = 1` (explicit flag, Migration 14).
 *   2. The member's base persona resolves to "clara" (e.g. "clara", "clara-1",
 *      "clara_reviewer") — retrocompatibility for members spawned before the
 *      flag existed.
 *   3. The member's `agent` column is "clara" — retrocompatibility for members
 *      spawned with the clara agent regardless of their display name.
 *
 * This is a pure read against SQLite; it never throws for unknown members.
 */
export function isQAMember(db: Database, teamId: string, memberName: string): boolean {
  const row = db.query(
    "SELECT is_qa, agent FROM team_member WHERE team_id = ? AND name = ?",
  ).get(teamId, memberName) as { is_qa: number; agent: string } | null
  if (!row) return false
  if (row.is_qa === 1) return true
  if (resolveBasePersona(memberName) === "clara") return true
  if (row.agent === "clara") return true
  return false
}

/**
 * Resolve the Quality Gate reviewer for a team, if one is present.
 *
 * Lookup order:
 *   1. The first active member with `is_qa = 1` (explicit flag).
 *   2. Fallback: the first active member whose base persona or agent is
 *      "clara" (retrocompatibility).
 *
 * "Active" means `status NOT IN ('shutdown', 'error')`. Returns null when the
 * team has no reviewer. The returned fields are exactly what the wake / CC /
 * watchdog paths need — no more, no less.
 */
export function getTeamQAMember(db: Database, teamId: string): QAMemberInfo | null {
  const cols = "name, session_id, status, execution_status, agent, last_nudged_at"

  // 1. Explicit flag (Migration 14).
  const flagged = db.query(
    `SELECT ${cols} FROM team_member
     WHERE team_id = ? AND is_qa = 1 AND status NOT IN ('shutdown', 'error')
     LIMIT 1`,
  ).get(teamId) as { name: string; session_id: string; status: string; execution_status: string; agent: string; last_nudged_at: number | null } | null
  if (flagged) {
    return {
      name: flagged.name,
      sessionId: flagged.session_id,
      status: flagged.status,
      executionStatus: flagged.execution_status,
      agent: flagged.agent,
      lastNudgedAt: flagged.last_nudged_at,
    }
  }

  // 2. Retrocompat fallback: base persona or agent === "clara".
  const candidates = db.query(
    `SELECT ${cols} FROM team_member
     WHERE team_id = ? AND status NOT IN ('shutdown', 'error')`,
  ).all(teamId) as Array<{ name: string; session_id: string; status: string; execution_status: string; agent: string; last_nudged_at: number | null }>
  const match = candidates.find(
    (c) => resolveBasePersona(c.name) === "clara" || c.agent === "clara",
  )
  if (match) {
    return {
      name: match.name,
      sessionId: match.session_id,
      status: match.status,
      executionStatus: match.execution_status,
      agent: match.agent,
      lastNudgedAt: match.last_nudged_at,
    }
  }

  return null
}

/** Essential fields a caller needs to wake / hand off to the SDET reviewer. */
export interface SDETMemberInfo {
  name: string
  sessionId: string
  status: string
  executionStatus: string
  agent: string
  lastNudgedAt: number | null
}

/**
 * Determine whether a team member is the SDET (deterministic-test engineer).
 *
 * Returns true when ANY of the following holds:
 *   1. The member's row has `role = 'sdet'` (explicit flag, Migration 16).
 *   2. The member's `agent` column is "hugo" — the canonical SDET agent type.
 *   3. The member's base persona resolves to "hugo" (e.g. "hugo", "hugo-sdet",
 *      "hugo_2") — retrocompatibility for members spawned before the flag
 *      existed or inserted directly in SQLite.
 *
 * Mirrors isQAMember's rule set (additive flags, no demotion). This is a pure
 * read against SQLite; it never throws for unknown members.
 */
export function isSDETMEmber(db: Database, teamId: string, memberName: string): boolean {
  const row = db.query(
    "SELECT role, agent FROM team_member WHERE team_id = ? AND name = ?",
  ).get(teamId, memberName) as { role: string | null; agent: string } | null
  if (!row) return false
  if (row.role === "sdet") return true
  if (resolveBasePersona(memberName) === "hugo") return true
  if (row.agent === "hugo") return true
  return false
}

/**
 * Resolve the SDET (deterministic-test engineer) for a team, if one is present.
 *
 * Lookup order (mirrors getTeamQAMember):
 *   1. The first active member with `role = 'sdet'` (explicit flag, Migration
 *      16) or `agent = 'hugo'` (canonical SDET agent type) — explicit-flag
 *      rows win over agent-only rows.
 *   2. Fallback: the first active member whose base persona is "hugo"
 *      (retrocompatibility for pre-flag rows and direct SQLite inserts).
 *
 * "Active" means `status NOT IN ('shutdown', 'error')`. Returns null when the
 * team has no SDET. The returned fields are exactly what the submit_review
 * wake / handoff path needs — no more, no less.
 */
export function getTeamSDETMember(db: Database, teamId: string): SDETMemberInfo | null {
  const cols = "name, session_id, status, execution_status, agent, last_nudged_at"

  // 1. Explicit flag (Migration 16) or explicit agent type "hugo".
  const explicit = db.query(
    `SELECT ${cols} FROM team_member
     WHERE team_id = ? AND (role = 'sdet' OR agent = 'hugo') AND status NOT IN ('shutdown', 'error')
     ORDER BY CASE WHEN role = 'sdet' THEN 0 ELSE 1 END
     LIMIT 1`,
  ).get(teamId) as { name: string; session_id: string; status: string; execution_status: string; agent: string; last_nudged_at: number | null } | null
  if (explicit) {
    return {
      name: explicit.name,
      sessionId: explicit.session_id,
      status: explicit.status,
      executionStatus: explicit.execution_status,
      agent: explicit.agent,
      lastNudgedAt: explicit.last_nudged_at,
    }
  }

  // 2. Retrocompat fallback: base persona === "hugo".
  const candidates = db.query(
    `SELECT ${cols} FROM team_member
     WHERE team_id = ? AND status NOT IN ('shutdown', 'error')`,
  ).all(teamId) as Array<{ name: string; session_id: string; status: string; execution_status: string; agent: string; last_nudged_at: number | null }>
  const match = candidates.find(
    (c) => resolveBasePersona(c.name) === "hugo",
  )
  if (match) {
    return {
      name: match.name,
      sessionId: match.session_id,
      status: match.status,
      executionStatus: match.execution_status,
      agent: match.agent,
      lastNudgedAt: match.last_nudged_at,
    }
  }

  return null
}
