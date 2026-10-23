import type { ToolDeps } from "../types"
import { generateId, generateProjectName, validateProjectName, validateTeamName } from "../util"
import { findTeamBySession } from "../types"
import { isSessionAlive } from "../recovery"
import { leadTopologySizingReminder } from "../system-prompt"
import { resolveSessionAgent } from "../lead-agent"

/**
 * Execute the team_create tool. Creates a new team with the caller as lead.
 */
export async function executeTeamCreate(
  deps: ToolDeps,
  args: { name: string; project_name?: string },
  sessionId: string,
): Promise<string> {
  const nameError = validateTeamName(args.name)
  if (nameError) throw new Error(nameError)
  if (args.project_name) {
    const projectNameError = validateProjectName(args.project_name)
    if (projectNameError) throw new Error(projectNameError)
  }

  // Check if team name already exists
  const projectId = deps.directory
  const existing = deps.db.query("SELECT id, lead_session_id FROM team WHERE name = ? AND project_id = ? AND status = 'active'")
    .get(args.name, projectId) as { id: string; lead_session_id: string } | undefined
  if (existing) {
    // The existing team's lead session may have been deleted externally (via
    // OpenCode's own session UI/API, not team_cleanup) rather than genuinely
    // still being in use. Reconcile on demand rather than block this call on a
    // team nobody can ever be lead of again -- don't wait for the next plugin
    // restart's periodic recoverOrphanedTeams pass to notice.
    if (await isSessionAlive(deps.client, existing.lead_session_id)) {
      throw new Error(`Team "${args.name}" already exists`)
    }
    deps.db.run("UPDATE team SET status = 'archived', time_updated = ? WHERE id = ?", [Date.now(), existing.id])
    deps.registry.unregisterTeam(existing.id)
  }

  // Check if session already leads a team
  const lead = findTeamBySession(deps.db, deps.registry, sessionId)
  if (lead) throw new Error(`This session already belongs to team "${lead.teamName}"`)

  const id = generateId("team")
  const now = Date.now()
  const projectName = args.project_name ?? generateProjectName()

  // TICKET-HARNESS-73 / TICKET-RELEASE-09 — persist the lead's AGENT
  // (persona) at creation time.
  //
  // `team.lead_agent` (Migration 5) was NEVER written by team_create, so
  // every team the plugin created carried `lead_agent = NULL`. Downstream
  // that NULL was papered over with a hard-coded "dante" by
  // `resolveAgentForSession` — which SILENTLY REBOUND the lead session onto
  // Dante's persona (Iris, Nora, Selene… all became Dante) on the next
  // prompt, because the transport choke point re-injects `agent` whenever
  // the caller omitted it.
  //
  // The agent is read from the SDK (the session's own binding) and stored
  // verbatim. When the lookup fails the column stays NULL — which the
  // resolver now treats as "unknown" (preserve native binding) instead of
  // "invent a persona".
  const leadAgent = await resolveSessionAgent(deps.client, sessionId)

  deps.db.run(
    `INSERT INTO project (id, name, path, status, time_created, time_updated)
     VALUES (?, ?, ?, 'active', ?, ?)
     ON CONFLICT(id) DO UPDATE SET time_updated = excluded.time_updated`,
    [projectId, projectName, projectId, now, now]
  )
  deps.db.run(
    "INSERT INTO team (id, name, project_id, lead_session_id, status, delegate, time_created, time_updated, lead_agent) VALUES (?, ?, ?, ?, 'active', 0, ?, ?, ?)",
    [id, args.name, projectId, sessionId, now, now, leadAgent ?? null]
  )

  // TICKET-HARNESS-55 (Camada C): the tool result is the lead's first post-create
  // read, so it carries a direct reminder of the SAME sizing scaffold injected in
  // the system prompt (single source of truth: leadTopologySizingReminder).
  return `Team "${args.name}" created. You are the lead. Para demandas de engenharia, convoque o squad canônico via team_spawn: implementadores especializados, engenheiro de testes determinísticos (SDET) e revisor de Quality Gate. Use team_tasks_add para planejar as frentes.\n\n${leadTopologySizingReminder()}`
}
