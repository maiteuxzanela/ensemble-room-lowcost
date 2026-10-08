const NAME_PATTERN = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/

let counter = 0

/**
 * Generate a time-sortable unique ID with the given prefix.
 * Format: `{prefix}_{timestamp_hex}_{counter_hex}_{random_hex}`
 */
export function generateId(prefix: string): string {
  const time = Date.now().toString(36)
  const count = (counter++).toString(36).padStart(4, "0")
  const rand = Math.random().toString(36).slice(2, 8)
  return `${prefix}_${time}_${count}_${rand}`
}

/**
 * Validate a team name. Returns an error message string if invalid, undefined if valid.
 * Rules: 1-64 chars, lowercase alphanumeric with hyphens, no leading/trailing hyphens.
 */
export function validateTeamName(name: string): string | undefined {
  if (name.length < 1 || name.length > 64) return "Team name must be 1-64 characters"
  if (!NAME_PATTERN.test(name)) return "Team name must be lowercase alphanumeric with hyphens only"
  return undefined
}

const PROJECT_ADJECTIVES = ["amber", "brave", "calm", "copper", "crisp", "dark", "ember", "frost", "quiet", "silver", "steady", "swift"]
const PROJECT_NOUNS = ["atlas", "beacon", "comet", "harbor", "lab", "orbit", "river", "signal", "sparrow", "summit", "vector", "voyage"]

/** Generate a short human-readable project name for implicit project creation. */
export function generateProjectName(): string {
  const adjective = PROJECT_ADJECTIVES[Math.floor(Math.random() * PROJECT_ADJECTIVES.length)] ?? "quiet"
  const noun = PROJECT_NOUNS[Math.floor(Math.random() * PROJECT_NOUNS.length)] ?? "project"
  return `${adjective}-${noun}`
}

/** Validate a project display name. Returns an error if invalid. */
export function validateProjectName(name: string): string | undefined {
  if (name.length < 1 || name.length > 64) return "Project name must be 1-64 characters"
  if (!NAME_PATTERN.test(name)) return "Project name must be lowercase alphanumeric with hyphens only"
  return undefined
}

/**
 * Detect if the plugin is loading inside a teammate's worktree instance.
 * Worktree instances should skip recovery to avoid deadlocking the server.
 */
export function isWorktreeInstance(directory: string): boolean {
  return directory.includes("/worktree/") && directory.includes("/ensemble-")
}

/**
 * Validate a member name. Same rules as team name, plus "lead" is reserved.
 * Returns an error message string if invalid, undefined if valid.
 */
export function validateMemberName(name: string): string | undefined {
  if (name.toLowerCase() === "lead") return `Name "lead" is reserved`
  if (name.length < 1 || name.length > 64) return "Member name must be 1-64 characters"
  if (!NAME_PATTERN.test(name)) return "Member name must be lowercase alphanumeric with hyphens only"
  return undefined
}
