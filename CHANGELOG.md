# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

_Nothing yet._

## [0.18.3] - 2026-10-27

Runtime hardening batch on top of `0.18.2`: hiring hygiene at spawn time, a partitioned auto-commit
ledger, published exports that never leak TypeScript, and a CI matrix pinned to Node versions that can
actually run the deterministic suite. The runtime entrypoints (`dist/index.js`, `dist/rpc.js`,
`dist/tui.js`) are rebuilt from `src/` and validated against the **60** deterministic suites, zero mocks.

### Added

- **Deterministic Persona Gap hook in `team_spawn`** (TICKET-HARNESS-77). Spawning an agent whose
  `build` / `plan` / `general` / unknown type does not match an official persona now yields a
  `[PERSONA GAP ALERT]` banner in the `team_spawn` return demanding an explicit vacancy specification,
  plus orienting notes in `team_status` and `team_cleanup`. The baseline classification lives in-code
  (independent of `HOME`), so a missing user config cannot silence the alert.
- **Per-card auto-commit ledger** (TICKET-HARNESS-82). Migration 21 adds a nullable `task_id` to
  `team_modified_file`; `recordModifiedFile` / `listModifiedFiles(taskId)` filter strictly by card and
  the completion hook commits surgically with a lean message (≤100 chars). Legacy v20 databases upgrade
  in place, and files recorded without a card keep the previous safe fallback.
- **Regression coverage for the batch**: `tests/test_ticket_harness_77_persona_gap.mjs`,
  `tests/test_ticket_harness_82_ledger_partition.mjs`,
  `tests/test_ticket_harness_87_exports.mjs` and `tests/test_ticket_harness_89_node_pins.mjs`,
  bringing the runner (`tests/run_all.mjs`) to **60 suites**.

### Changed

- **Published `exports` sanitized** (TICKET-HARNESS-87). The root entry resolves to `dist/index.js`
  through a real `import.meta.resolve` probe, and the `./rpc` / `./tui` subpaths now resolve to
  `dist/rpc.js` / `dist/tui.js` instead of raw TypeScript. No runtime condition exposes `.ts`/`.tsx`;
  `node --check` passes for all three bundles and the `files` allowlist ships exactly the compiled
  runtime targets.
- **Robust `HOME` fallback** (TICKET-HARNESS-87, `ensemble.ts`). `isUsableHome` now rejects relative and
  empty candidates — including the literal `"~"` / `"~/sub"` — and accepts absolute paths only, so a
  subprocess without `HOME`/`USERPROFILE` never resolves data under `./~`.
- **Node pins hardened in CI** (TICKET-HARNESS-89). `ci.yml` pins the matrix to `22.23.4` and `24.22.1`
  with `check-latest`, `publish.yml` runs on `22.23.4`, and the composite `setup-bun` action pins
  `24.22.1` instead of a floating tag. A real `Bun.YAML` verifier plus a mutation proof (floating pin /
  vulnerable version) guards the contract.
- **Package version** bumped to `0.18.3`, with `package-lock.json` kept in lockstep at the root and
  package entries.

### Fixed

- **Hermetic CI runner for the SDET block** (`tests/test_bloco_c_sdet_harness_87_89.mjs`). The suite now
  degrades gracefully to `SKIP` when the sibling `opencode_repo` checkout or the `bun` binary is absent,
  instead of failing the whole run for environment reasons; the deterministic checks still execute
  whenever both are available.

## [0.18.2] - 2026-10-20

Release-governance patch on top of `0.18.1`: the runtime code is unchanged, but the **published
artifact** is now correct for plain Node consumers, the dependency tree is audited and the package
lineage is documented. Everything shipped by TICKET-RELEASE-01 through TICKET-RELEASE-06 is recorded
here, because those changes landed after the `0.18.1` tag.

### Added

- **Conditional `exports` map with a compiled runtime target.** `exports["."]` now resolves through
  `"types": "./src/index.ts"` and `"default": "./dist/index.js"`, so a regular Node consumer importing
  `ensemble-room-lowcost` loads the ESM bundle instead of failing with a TypeScript syntax error. The
  top-level `"types"` field was added for editors that do not read conditional exports, and the legacy
  `"module"` field now points at the same compiled bundle so bundlers that ignore `exports` no longer
  receive TypeScript either.
- **`./package.json` subpath export**, so tooling (npm, bundlers, SBOM scanners) can read package
  metadata without bypassing the `exports` gate.
- **Hermetic test fixtures** (TICKET-RELEASE-01): the `session`/`project` DDL lives in
  `tests/fixtures/session_schema.sql` and is replayed into a throwaway database under `.test-scratch/`;
  the suite no longer reads `~/.local/share/opencode/opencode.db`.
- **Continuous integration workflow** (TICKET-RELEASE-01): `.github/workflows/ci.yml` runs `npm ci`,
  `npm run build`, `npm run check`, `npm run typecheck` and `npm test` on Node 22 and 24 for pushes and
  pull requests to `main`; `publish.yml` gates `npm publish --provenance` behind the same steps.
- **Regression suites** added during the batch: `tests/test_release_03_dashboard_csrf.mjs` (dashboard
  CSRF/Host-Origin contracts) and `tests/test_release05_shell_ledger.mjs` (shell ledger capture,
  `workdir` resolution, `git mv` renames), bringing the deterministic suite to **48 files**.
- **Release gates in CI** (TICKET-RELEASE-07): `ci.yml` now runs `npx biome check src` (static gate
  first), `git diff --exit-code dist/` (the committed bundle must be byte-identical to a fresh build)
  and `npm pack --dry-run` (packaging smoke test) before the deterministic suite, on Node 22 and 24.

### Changed

- **Package version** bumped to `0.18.2`, with `package-lock.json` regenerated so the root entry matches.
- **`peerDependenciesMeta`** now marks `typescript` optional, alongside `@opentui/core`, `@opentui/solid`
  and `solid-js`. A headless server-only install pulls neither the compiler nor any TUI runtime; the
  peers are declared only so that TUI/companion users get a compatible range.
- **Dependency hygiene** (TICKET-RELEASE-02): `solid-js` raised to `1.9.12` in both dev and peer ranges,
  `@babel/core` pinned to `7.29.7` via `overrides`, `seroval`/`seroval-plugins` pinned to `1.6.11`,
  `typescript` aligned to `~5.8.3` and `@types/bun` frozen instead of `latest`.
- **Code quality** (TICKET-RELEASE-03): Biome adopted as the repository linter/formatter; `as any`
  assertions and empty `catch` blocks in `hooks.ts`, `team-status.ts`, `types.ts` and `v2-*` removed or
  replaced with typed guards; comments referring to mocks were purged.
- **Documentation sync** (TICKET-RELEASE-06): every document now states **48** deterministic suites and
  describes failover exhaustion as a silent, zero-noise outcome — matching HARNESS-13 behaviour instead
  of the older "wake the lead" wording.

### Fixed

- **`exports` served TypeScript to Node.** `import "ensemble-room-lowcost"` no longer depends on a
  TypeScript-capable loader; Node resolves `dist/index.js` through the `default` condition. The
  `./rpc` and `./tui` companion subpaths remain TypeScript entrypoints and are documented as requiring
  Bun or Node's native type stripping.
- **Gate 1 auto-commit dropped shell artifacts** (TICKET-RELEASE-05). The modified-file ledger now
  captures files produced by shell commands and `npm install` (diffing repository state around the
  command), so a regenerated `package-lock.json` or a `sed`/generator output is committed instead of
  being left dirty. The `git add -A` ban and per-card ledger scope are unchanged, and a fail-safe warns
  the Quality Gate when card-scoped files are still dirty at completion.
- **Shell `cwd` vs `workdir`** (TICKET-RELEASE-06): `resolveShellCwd` accepts `args.workdir` as well as
  `args.cwd`, so calls targeting a sibling repository capture their diff in the right tree.
- **`git mv` / copy entries** (TICKET-RELEASE-06): porcelain `R`/`C` records now register **both** the
  source and destination paths, so renames no longer leave the origin out of the ledger.

### Security

- **`npm audit --omit=dev` reports 0 vulnerabilities** (TICKET-RELEASE-02) for the runtime tree.
- **Dashboard hardening** (TICKET-RELEASE-03): the `:4747` loopback server validates `Host`/`Origin` on
  every mutating route (`/api/chat/send`, `/api/emergency/*`) and rejects cross-origin requests, closing
  the CSRF/DNS-rebinding gap; contract tests assert the rejections.
- **Package lineage documented** (TICKET-RELEASE-07): `SECURITY.md` and `README.md` now record that
  `@opencode/plugin` (v2 plugin SDK, maintained by Dax Raad / `thdxr`, creator and architect of OpenCode)
  and `@opencode-ai/plugin` (v1 SDK namespace) are both first-party and serve different SDK generations.
  `@opencode/plugin` is pinned to the exact version `2.0.16` with a lockfile `sha512` integrity hash, so
  the coexistence is not typosquatting.
- **Packaging gate**: `npm pack --dry-run` ships 65 files — `dist/index.js`, `src/`, `tsconfig.json`,
  `LICENSE`, `README.md`, `CHANGELOG.md`, `SECURITY.md`, `social-preview.png` and `package.json` — and
  excludes `tests/`, `.github/`, `node_modules/`, `.test-scratch/` and the local `kanban.json`.

### Tests

- 48 deterministic suites, zero mocks, executed against both the real bundle (`dist/index.js`) and the
  `.ts` sources of `src/`. Verified in this release: `npm run build` → `npm run check` → `npm test`
  (48/48 green) plus a real `node` resolution probe of the published entrypoint (`import` resolves to
  `dist/index.js`).
- The `package.json` contract test (`test_ticket_harness_38`) now flattens conditional export objects and
  asserts the root entrypoint explicitly (`default` → `dist/index.js`, `types` → `src/index.ts`), so a
  future regression of the packaging map fails the suite instead of only checking file existence.

## [0.18.1] - 2026-10-20

Hardening release over the upstream base `@hueyexe/opencode-ensemble@0.18.0`. The theme is
**token-efficient orchestration without behavioural regressions**: teammates are born idle, the lead
sleeps, and the schema survives the upgrade.

### Added

- **Native standby spawn.** `team_spawn` accepts `standby: true`, registering the member without sending
  an init prompt. The full prompt is persisted in `team_member.spawn_context` and delivered by the first
  `team_message` / `team_broadcast` addressed to that member. Spawning costs zero tokens.
- **Idempotent wake guard.** The `standby → starting` transition is a guarded
  `UPDATE … WHERE execution_status = 'standby'`, so concurrent messages cannot duplicate the init prompt.
  On transport failure the member is reverted to `standby` and the stored context is replayed on retry.
- **`silentLead` configuration flag** (default `true`). Lead-bound messages are persisted in SQLite
  (`delivered = 0`) instead of firing `promptAsync`; `buildLeadSystemPrompt` injects the backlog on the
  lead's next legitimate turn and marks it delivered. Set to `false` to restore the legacy per-message wake.
- **Systematic board waker.** `team_tasks_complete` wakes the lead exactly once when
  `total > 0 && completed === total` with a synthetic `[System: All team tasks completed on board]`
  message. This is the single automatic lead-wake event.
- **Per-agent model fallback chains** (`fallbackModelsByAgent`) with base-persona symmetry, so
  multi-instance agents inherit the chain declared for their base role.
- **Primary/secondary compaction awareness.** `isSessionCompacting()` exposes
  `session.time_compacting > 0` as the immunity signal used by the watchdog.
- **`deniedTools` configuration key** to extend the built-in teammate tool deny-list per ecosystem,
  unioned additively across global and project scopes.
- **`roomInactivityThresholdMs` and `roomInactivityCheckMs`** configuration keys, decoupling the
  inactivity threshold from the sweep cadence.
- **Dashboard HTTP API:** `/`, `/api/state`, `/api/health`, `/api/session/:id/activity` and
  `/api/chat/send`, bound to `127.0.0.1` with a Host/Origin gate against DNS rebinding.
- **Intra-card handover** (`team_task_handover`) for sequential bench partnerships on the same card:
  atomic reassignment, wake with handover notes, and automatic standby for the sender.
- **Public documentation:** this changelog, `SECURITY.md`, and a sanitized `README.md` covering
  architecture, the five hardening layers, the full configuration catalog and troubleshooting.

### Changed

- **Hook shielding.** `shouldNudgeIdleMember` no longer nudges members in `standby`, and
  `shouldAlarmFastIdle` no longer raises a false "agent died" alarm for them. The predicates are exported
  seams without decision changes.
- **Watchdog heartbeat.** Stale members that show real progress (`ProgressTracker`: steps and output
  tokens above `stallTokenThreshold`) have `time_updated` renewed instead of being aborted.
- **Migration 12.** `team_member` is rebuilt with an updated `CHECK` constraint that accepts `standby`,
  carrying every column added by Migrations 3–11 and recreating both indexes. The migration runs inside a
  single `BEGIN IMMEDIATE` transaction tracked by `PRAGMA user_version`, making it atomic and idempotent.
- **`#default` variant sentinel.** `model.variant === "default"` is normalized away at parse and format
  time, preventing an unmatchable `provider/model#default` key that used to restart the fallback chain on
  every retry.
- **Fallback precedence** is explicit: exact agent key → base-persona key → global chain → legacy
  `modelFallback` → built-in default. Chains are never empty; malformed entries are discarded and
  duplicates collapse.
- **Failover de-duplication.** A per-`teamId:memberName` cooldown (`FAILOVER_COOLDOWN_MS`, 10 minutes)
  collapses a 429 burst into a single chain advance.
- **Zero-noise failover.** Switched and suppressed decisions only log and update `team_member.model`;
  chain exhaustion is silent as well (log + cooldown, no lead notification). The single automatic lead
  wake is the systematic full-board closure event.
- **Conditional prompt coercion.** With `silentLead` active, the mandatory "report to the lead before
  stopping" directive is replaced by a collaboration directive. Legacy text is preserved verbatim when the
  flag is off.
- **Hermetic tests.** The host session store is no longer a prerequisite; the `session` DDL is versioned
  in `tests/fixtures/session_schema.sql` and applied to a throwaway database under `.test-scratch/`.
- **`package.json` `files`** now publishes `CHANGELOG.md` and `SECURITY.md` alongside `dist`, `src`,
  `tsconfig.json`, `LICENSE`, `README.md` and the social preview image.

### Fixed

- Standby members no longer receive idle nudges or fast-idle alarms.
- Sessions in context compaction are no longer aborted as stale after the TTL.
- The runtime propagates the explicit `agent` on every `promptAsync` relaunch (member, isolated session and
  lead), so the host cannot reset `session.agent` to its default.
- Task without an `assignee` is atomically assigned to its author on completion, keeping the board honest.
- Wake transport failures are absorbed by `.catch` — zero `unhandledRejection`.

### Deprecated

- `modelFallback` remains supported for backward compatibility but is superseded by `fallbackModels` and
  `fallbackModelsByAgent`.
- `Watchdog.stop()` is retained as a legacy alias of `dispose()`.

### Security

- Dashboard binds to `127.0.0.1` and validates `Host`/`Origin` on both `GET` and `POST`.
- The host session store is opened read-only; the runtime never writes to it.
- See [SECURITY.md](./SECURITY.md) for the disclosure policy.

### Tests

- 48 deterministic suites, thousands of assertions, zero mocks, executed against both the real bundle
  (`dist/index.js`) and the `.ts` sources of `src/`.

## [0.18.0] - upstream baseline

Initial baseline derived from `@hueyexe/opencode-ensemble@0.18.0` (MIT). Provides the multi-agent room,
the SQLite-backed task board, `team_*` tools, worktree isolation and the base watchdog.

[Unreleased]: https://github.com/maiteuxzanela/ensemble-room-lowcost/compare/v0.18.3...HEAD
[0.18.3]: https://github.com/maiteuxzanela/ensemble-room-lowcost/compare/v0.18.2...v0.18.3
[0.18.2]: https://github.com/maiteuxzanela/ensemble-room-lowcost/compare/v0.18.1...v0.18.2
[0.18.1]: https://github.com/maiteuxzanela/ensemble-room-lowcost/releases/tag/v0.18.1
[0.18.0]: https://github.com/hueyexe/opencode-ensemble/releases/tag/v0.18.0
