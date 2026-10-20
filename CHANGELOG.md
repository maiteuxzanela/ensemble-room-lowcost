# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

_Nothing yet._

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
  chain exhaustion produces exactly one lead notification.
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

- 46 deterministic suites, thousands of assertions, zero mocks, executed against both the real bundle
  (`dist/index.js`) and the `.ts` sources of `src/`.

## [0.18.0] - upstream baseline

Initial baseline derived from `@hueyexe/opencode-ensemble@0.18.0` (MIT). Provides the multi-agent room,
the SQLite-backed task board, `team_*` tools, worktree isolation and the base watchdog.

[Unreleased]: https://github.com/maiteuxzanela/ensemble-room-lowcost/compare/v0.18.1...HEAD
[0.18.1]: https://github.com/maiteuxzanela/ensemble-room-lowcost/releases/tag/v0.18.1
[0.18.0]: https://github.com/hueyexe/opencode-ensemble/releases/tag/v0.18.0
