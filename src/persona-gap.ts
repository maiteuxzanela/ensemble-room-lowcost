import { existsSync, readdirSync } from "node:fs"
import os from "node:os"
import path from "node:path"

/**
 * TICKET-HARNESS-77 — Deterministic Persona Gap alert.
 *
 * The LEAD TOPOLOGY & SIZING PROTOCOL (src/system-prompt.ts) requires the Lead
 * to keep the demand moving when a specialist is missing from the catalog by
 * summoning a TEMPORARY GENERIC agent (`build`, `plan`, `general`…) and, in the
 * same turn, attaching a formal hiring/role-spec proposal to the executive
 * report for the founder (checklist item `b`, Persona Gap).
 *
 * That rule used to be purely behavioural (prompt text), so under closing-turn
 * overload the Lead routinely forgot the proposal. This module turns the rule
 * into a deterministic surface: `team_spawn` appends a banner to its textual
 * result, `team_status` and `team_cleanup` append a closing note whenever the
 * room still has generic agents registered in `team_member`.
 */

/**
 * Built-in / non-persona agent types. Summoning any of these (or any agent that
 * is not part of the official specialist catalog) is a Persona Gap and MUST
 * raise the alert — the generic check wins even if somebody adds a config entry
 * or a definition file with the same name.
 */
export const GENERIC_AGENT_TYPES: ReadonlySet<string> = new Set([
  "build",
  "plan",
  "general",
  "explore",
  "code",
  "chat",
])

/**
 * Baseline of formalised personas (Pool Global specialists + orchestrators +
 * historically archived names resolved in the catalog). Kept in-code so the
 * deterministic classification never depends on the operator's home directory:
 * an absent/unreadable `~/.config/opencode/agent` degrades to this baseline
 * instead of false-flagging every official specialist.
 */
export const OFFICIAL_PERSONAS: ReadonlySet<string> = new Set([
  // Pool Global de Especialistas
  "cris",
  "ana",
  "iara",
  "lumi",
  "bia",
  "tulio",
  "silas",
  "kael",
  "maya",
  "morgan-sec",
  "leticia",
  "clara",
  "hugo",
  "otavio",
  "sam",
  "daniela",
  "fernanda",
  "ellis",
  "tales",
  "theo",
  "davi",
  // Quality Manager + orquestradores
  "diana",
  "sol",
  "dante",
  "nora",
  "zelia",
  "alex",
  "cecilia",
  "selene",
  "jade",
  "iris",
  // Personas arquivadas/absorvidas (não geram lacuna: já foram catalogadas)
  "juliana",
  "noa",
  "ariel",
  "carla",
  "rowan",
  "camila",
  "beatriz",
  "isabela",
  "gabriela",
  "erica",
  "valerio",
])

/** Visible, standardised marker both the banner and the closing note carry. */
export const PERSONA_GAP_MARKER = "[PERSONA GAP ALERT]"

export interface PersonaGapOptions {
  /**
   * Extra known names (e.g. `Object.keys(ensemble.json.modelsByAgent)`).
   * Generic agent types are still flagged regardless of being listed here.
   */
  knownPersonas?: Iterable<string>
  /** Override the canonical persona directory (tests). Defaults to ~/.config/opencode/agent. */
  agentDir?: string
}

/**
 * Normalise a persona/agent name for comparison: trim, lowercase and strip
 * diacritics ("Túlio" → "tulio", "Letícia" → "leticia").
 */
export function normalizePersonaName(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
}

/**
 * Resolve the set of formalised personas: in-code baseline + extra config keys
 * + every `<name>.md` definition living in the canonical agent directory.
 * Reading the directory is best-effort enrichment — a missing/unreadable dir
 * never throws and never turns an official specialist into a gap.
 */
export function resolveKnownPersonas(options: PersonaGapOptions = {}): Set<string> {
  const known = new Set<string>(OFFICIAL_PERSONAS)

  for (const candidate of options.knownPersonas ?? []) {
    if (typeof candidate !== "string") continue
    const normalized = normalizePersonaName(candidate)
    if (normalized) known.add(normalized)
  }

  const agentDir = options.agentDir ?? path.join(os.homedir(), ".config", "opencode", "agent")
  try {
    if (existsSync(agentDir)) {
      for (const entry of readdirSync(agentDir)) {
        // Only real persona definitions: `dante.md.bak-*` copies are not personas.
        if (!entry.endsWith(".md")) continue
        const normalized = normalizePersonaName(entry.slice(0, -3))
        if (normalized) known.add(normalized)
      }
    }
  } catch {
    // Enrichment only — the in-code catalog is authoritative.
  }

  return known
}

/**
 * True when the summoned agent is a generic/absent-from-catalog agent, i.e. a
 * Persona Gap that requires the hiring proposal to the founder.
 *
 * Resolution order:
 *   1. generic built-in type → gap (always, even if listed in config);
 *   2. exact official persona → no gap;
 *   3. multi-instance suffix (`otavio-2`/`morgan-sec_1`) → resolve base persona;
 *   4. anything else → gap.
 */
export function isPersonaGap(
  agent: string | null | undefined,
  options: PersonaGapOptions = {},
): boolean {
  const raw = typeof agent === "string" ? normalizePersonaName(agent) : ""
  if (!raw) return true
  if (GENERIC_AGENT_TYPES.has(raw)) return true

  const known = resolveKnownPersonas(options)

  // Multi-instance forms: a persona may carry a numeric suffix separated by
  // `-` or `_` ("otavio-2", "otavio_2") AND some canonical names legitimately
  // contain a hyphen ("morgan-sec"). Candidates are therefore checked from the
  // most specific to the broadest: exact name, underscore base, hyphen base and
  // the name with a trailing numeric suffix stripped.
  const candidates = new Set<string>([raw])
  const underscoreBase = normalizePersonaName(raw.split("_")[0] ?? raw)
  if (underscoreBase) candidates.add(underscoreBase)
  const hyphenBase = normalizePersonaName(raw.split("-")[0] ?? raw)
  if (hyphenBase) candidates.add(hyphenBase)
  const numericSuffixStripped = normalizePersonaName(raw.replace(/[-_]\d+$/, ""))
  if (numericSuffixStripped) candidates.add(numericSuffixStripped)

  for (const candidate of candidates) {
    if (GENERIC_AGENT_TYPES.has(candidate)) return true
    if (known.has(candidate)) return false
  }
  return true
}

/**
 * Banner appended to the `team_spawn` textual result. Returns null when the
 * summoned agent is a formalised persona (no noise for official specialists).
 */
export function personaGapBannerFor(
  agent: string | null | undefined,
  options: PersonaGapOptions = {},
): string | null {
  if (!isPersonaGap(agent, options)) return null
  const label = typeof agent === "string" && agent.trim().length > 0 ? agent.trim() : "(unset)"
  return (
    `${PERSONA_GAP_MARKER} O agente convocado ("${label}") é genérico ou não possui persona formalizada no catálogo. ` +
    "Lembre-se de anexar ao relatório executivo para a Fundadora Maiteux Zanela a especificação de contratação da nova persona " +
    "(função, stack e proposta de template personas/<nome>.md)."
  )
}

/**
 * Closing/status note for a room that still has generic agents registered in
 * `team_member`. Returns null when every member runs a formalised persona.
 */
export function personaGapClosingNote(
  members: ReadonlyArray<{ name: string; agent: string | null | undefined }>,
  options: PersonaGapOptions = {},
): string | null {
  const gaps = members.filter((member) => isPersonaGap(member.agent, options))
  if (gaps.length === 0) return null
  const listed = gaps
    .map((member) => `${member.name} (agent: ${member.agent && member.agent.trim().length > 0 ? member.agent : "(unset)"})`)
    .join(", ")
  return [
    PERSONA_GAP_MARKER,
    `A sala possui ${gaps.length} membro(s) convocado(s) com agente genérico ou sem persona formalizada no catálogo: ${listed}.`,
    "Antes de encerrar, anexe ao relatório executivo para a Fundadora Maiteux Zanela a especificação de contratação da nova persona (função, stack e proposta de template personas/<nome>.md).",
  ].join("\n")
}

/** Config-derived extra known names (`ensemble.json` → `modelsByAgent`). */
export function knownPersonasFromConfig(config?: { modelsByAgent?: Record<string, string> }): string[] {
  return Object.keys(config?.modelsByAgent ?? {})
}
