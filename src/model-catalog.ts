import { formatModelSelector, parseModelSelector, type ModelFallbackRef } from "./config"
import type { PluginClient, ModelCatalogEntry } from "./types"

export type { ModelCatalogEntry } from "./types"

/**
 * TICKET-RELEASE-10 (Frente F1) — server-truth model validation.
 *
 * Live bug (2026-10-22): `ensemble.json` pointed `defaultModel`,
 * `modelsByAgent` and `fallbackModels[0]` at `opencode-go/longcat-2.5-preview-free`,
 * a model that does not exist in the server catalog. `team_spawn` created the
 * session and only then fired `promptAsync`, which died asynchronously with
 * ProviderModelNotFoundError — and the NATIVE failover never advanced because
 * it only reacts to quota/rate-limit retries. The result: every spawn of every
 * member burned a worktree + session and then vanished.
 *
 * The fix is to validate the EFFECTIVE spawn model against the live catalog
 * BEFORE any side effect (worktree/workspace/session.create) and, when the
 * configured selector is absent, walk the configured fallback chain to the
 * first entry that the server actually serves. This module holds the pure
 * decisions so they are testable without a server; the single transport seam
 * (`client.modelCatalog.list`) lives in src/client.ts / src/v2-client.ts.
 */

/** Error text extraction tolerant to Error, string, HeyAPI and event payloads. */
function errorText(err: unknown): string {
  if (typeof err === "string") return err
  if (!err || typeof err !== "object") return String(err ?? "")
  const e = err as Record<string, unknown>
  const parts: string[] = []
  for (const key of ["name", "message"]) {
    const value = e[key]
    if (typeof value === "string" && value.length > 0) parts.push(value)
  }
  const data = e["data"]
  if (data && typeof data === "object") {
    for (const key of ["name", "message"]) {
      const value = (data as Record<string, unknown>)[key]
      if (typeof value === "string" && value.length > 0) parts.push(value)
    }
  }
  const nested = e["error"]
  if (typeof nested === "string") parts.push(nested)
  else if (nested instanceof Error) parts.push(nested.message)
  return parts.join(" | ")
}

/**
 * True when the error is the deterministic "this model does not exist" class
 * (ProviderModelNotFoundError / "Model not found"), as opposed to a transient
 * rate-limit/quota error. F2 uses the same predicate to let the failover seam
 * advance WITHOUT the rate-limit cooldown.
 */
export function isModelNotFoundError(err: unknown): boolean {
  const text = errorText(err)
  if (!text) return false
  if (/ProviderModelNotFound(Error)?/i.test(text)) return true
  if (/provider\s+model\s+not\s+found/i.test(text)) return true
  if (/\bmodel\s+not\s+found\b/i.test(text)) return true
  if (/\bmodelnotfound(error)?\b/i.test(text)) return true
  return false
}

/**
 * Normalize a selector to its comparable "provider/model" key: the `#variant`
 * suffix (including the server's `#default` absence sentinel, see
 * VARIANT_ABSENT_SENTINEL in config.ts) is dropped. Undefined for malformed
 * selectors — callers must never invent a model from a bad string.
 */
export function catalogKey(selector: string): string | undefined {
  if (typeof selector !== "string") return undefined
  const parsed = parseModelSelector(selector.trim())
  return parsed ? `${parsed.providerID}/${parsed.modelID}` : undefined
}

/**
 * True when the selector is served by the live catalog. Comparison is on
 * providerID+modelID only (variant is a server-side overlay, not an identity),
 * and entries the server reports as `enabled: false` do not resolve.
 */
export function isSelectorAvailable(
  catalog: readonly ModelCatalogEntry[],
  selector: string,
): boolean {
  const parsed = parseModelSelector(typeof selector === "string" ? selector.trim() : "")
  if (!parsed) return false
  return catalog.some(
    (entry) =>
      entry.providerID === parsed.providerID &&
      entry.modelID === parsed.modelID &&
      entry.enabled !== false,
  )
}

/** Levenshtein distance — small, allocation-light, deterministic. */
function editDistance(a: string, b: string): number {
  if (a === b) return 0
  if (a.length === 0) return b.length
  if (b.length === 0) return a.length
  let previous = Array.from({ length: b.length + 1 }, (_, i) => i)
  for (let i = 1; i <= a.length; i++) {
    const current = [i]
    for (let j = 1; j <= b.length; j++) {
      const cost = a.charCodeAt(i - 1) === b.charCodeAt(j - 1) ? 0 : 1
      current[j] = Math.min(
        (previous[j] ?? 0) + 1,
        (current[j - 1] ?? 0) + 1,
        (previous[j - 1] ?? 0) + cost,
      )
    }
    previous = current
  }
  return previous[b.length] ?? Math.max(a.length, b.length)
}

/**
 * "Did you mean" suggestions derived from the SERVER catalog (never a
 * hardcoded list). When the configured provider exists, the nearest models of
 * that provider are offered (the live-bug case: provider valid, model id
 * wrong). Otherwise the nearest full selectors within a conservative distance
 * threshold are offered. Always deterministic: distance, then lexical order.
 */
export function suggestModelSelectors(
  catalog: readonly ModelCatalogEntry[],
  selector: string,
  limit = 3,
): string[] {
  const parsed = parseModelSelector(typeof selector === "string" ? selector.trim() : "")
  if (!parsed || catalog.length === 0 || limit <= 0) return []
  const available = catalog.filter((entry) => entry.enabled !== false && entry.providerID && entry.modelID)
  if (available.length === 0) return []
  const sameProvider = available.filter((entry) => entry.providerID === parsed.providerID)
  const key = `${parsed.providerID}/${parsed.modelID}`
  const scored = (sameProvider.length > 0 ? sameProvider : available)
    .map((entry) => {
      const full = `${entry.providerID}/${entry.modelID}`
      return {
        full,
        distance: sameProvider.length > 0
          ? editDistance(entry.modelID, parsed.modelID)
          : editDistance(full, key),
      }
    })
    .sort((a, b) => a.distance - b.distance || a.full.localeCompare(b.full))
  const filtered = sameProvider.length > 0
    ? scored
    : scored.filter((entry) => entry.distance <= Math.max(4, Math.floor(key.length / 3)))
  const suggestions: string[] = []
  for (const entry of filtered) {
    if (entry.full === key || suggestions.includes(entry.full)) continue
    suggestions.push(entry.full)
    if (suggestions.length >= limit) break
  }
  return suggestions
}

/** Best-effort selector extraction from a ProviderModelNotFound error payload. */
export function extractModelSelectorFromError(err: unknown): string | undefined {
  const text = errorText(err)
  const match = text.match(/([A-Za-z0-9][A-Za-z0-9._-]*)\/([A-Za-z0-9][A-Za-z0-9._/-]*)/)
  if (!match) return undefined
  return `${match[1]}/${match[2]}`.replace(/#.*$/, "")
}

/**
 * One-line actionable description of a model-not-found failure, enriched with
 * catalog-derived suggestions. Shared with F2 (failover exhaust messages) so
 * both fronts speak the same language and never wake the lead with useless
 * noise. `catalog` is optional: absent catalog degrades to "no suggestion".
 */
export function describeModelNotFound(
  err: unknown,
  catalog: readonly ModelCatalogEntry[] = [],
): string {
  const selector = extractModelSelectorFromError(err)
  const suggestions = selector ? suggestModelSelectors(catalog, selector) : []
  const label = selector
    ? `Model not found: ${selector}.`
    : `Model not found: ${errorText(err) || "unknown model"}.`
  return suggestions.length > 0
    ? `${label} Did you mean: ${suggestions.join(", ")}?`
    : `${label} No catalog suggestion available.`
}

/** Outcome of validating the effective spawn model against the live catalog. */
export interface SpawnModelDecision {
  /** Model the spawn must use (undefined = leave the server default alone). */
  model: string | undefined
  /** Model the configuration asked for (explicit arg / modelsByAgent / defaultModel). */
  configured: string | undefined
  /** True when the configured model was absent and a chain entry took its place. */
  substituted: boolean
  /** True when neither the configured model nor any chain entry resolves. */
  exhausted: boolean
  /** Catalog-derived "Did you mean" suggestions for the configured model. */
  suggestions: string[]
}

/**
 * Decide which model a spawn must use, given the live catalog, the configured
 * (effective) model and the agent's ordered fallback chain.
 *
 * Contract:
 *   - no configured model → undefined (server default; nothing to validate);
 *   - catalog unavailable/empty → configured model verbatim (fail-open: a host
 *     without a catalog API must not lose the ability to spawn);
 *   - configured model resolves → use it (variant untouched);
 *   - configured model absent → first chain entry that resolves (skipping the
 *     configured one, which is already known-bad);
 *   - nothing resolves → `exhausted` (the caller must fail BEFORE creating any
 *     worktree/session and surface an actionable message).
 */
export function resolveSpawnModelFromCatalog(
  catalog: readonly ModelCatalogEntry[] | undefined,
  requested: string | undefined,
  chain: readonly ModelFallbackRef[] = [],
): SpawnModelDecision {
  const configured = requested
  const base = { configured, substituted: false, exhausted: false, suggestions: [] as string[] }
  if (!requested) return { model: undefined, ...base }
  if (!catalog || catalog.length === 0) return { model: requested, ...base }
  if (isSelectorAvailable(catalog, requested)) return { model: requested, ...base }

  const suggestions = suggestModelSelectors(catalog, requested)
  const requestedKey = catalogKey(requested)
  for (const entry of chain) {
    const selector = formatModelSelector(entry)
    if (catalogKey(selector) === requestedKey) continue
    if (isSelectorAvailable(catalog, selector)) {
      return { model: selector, configured, substituted: true, exhausted: false, suggestions }
    }
  }
  return { model: undefined, configured, substituted: false, exhausted: true, suggestions }
}

/**
 * Fetch the live model catalog through the single transport seam. Returns
 * undefined when the host exposes no catalog capability, when the call fails,
 * or when the server reports an empty catalog — in every case the caller
 * fails open (spawn keeps the configured model) instead of blocking work on a
 * best-effort enrichment.
 */
export async function fetchModelCatalog(
  client: PluginClient,
  directory?: string,
): Promise<ModelCatalogEntry[] | undefined> {
  const list = client.modelCatalog?.list
  if (!list) return undefined
  try {
    const result = await list(directory ? { directory } : undefined)
    const entries = result?.data
    return Array.isArray(entries) && entries.length > 0 ? entries : undefined
  } catch {
    return undefined
  }
}
