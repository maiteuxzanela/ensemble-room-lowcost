# Ensemble Room — Low-Cost Multi-Agent Runtime for OpenCode

[![npm version](https://img.shields.io/npm/v/ensemble-room-lowcost.svg?color=cb3837&style=flat-square)](https://www.npmjs.com/package/ensemble-room-lowcost)
[![npm downloads](https://img.shields.io/npm/dm/ensemble-room-lowcost.svg?style=flat-square)](https://www.npmjs.com/package/ensemble-room-lowcost)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg?style=flat-square)](https://opensource.org/licenses/MIT)
[![Node](https://img.shields.io/badge/node-%3E%3D22.22-339933.svg?style=flat-square)](https://nodejs.org)

**A hardened, token-efficient multi-agent orchestration runtime for [OpenCode](https://opencode.ai).**

`ensemble-room-lowcost` gives you a shared team room — an orchestrator (lead), specialists, an SDET and a
quality-gate reviewer — running on top of OpenCode, with a SQLite-backed task board, per-agent model
fallback and a deterministic test suite. It is derived from `@hueyexe/opencode-ensemble@0.18.0` and
hardened in the `0.18.x` line around one single objective: **do the same orchestration while burning far
fewer tokens**.

The two structural wins:

- **Teammates are born in standby** — spawning a worker costs **zero tokens**; the first real message is
  what wakes it, exactly once.
- **The lead rests in absolute silence** — lead-bound messages accumulate in SQLite (`delivered = 0`) and
  are injected on the lead's next legitimate turn. The only automatic wake is a **single deterministic
  event: total board closure**.

| | |
|---|---|
| Package | `ensemble-room-lowcost` |
| Version | `0.18.2` (upstream base: `@hueyexe/opencode-ensemble@0.18.0`) |
| Runtime entrypoint | `dist/index.js` — self-contained ESM bundle (`exports["."]`, `main`) |
| Types entrypoint | `src/index.ts` — TypeScript consumers only (`exports["."].types`) |
| Repository | `github.com/maiteuxzanela/ensemble-room-lowcost` (branch `main`) |
| License | MIT |
| Test suite | 48 deterministic suites, zero mocks, offline-capable |

---

## Table of contents

1. [Why this runtime](#1-why-this-runtime)
2. [Architecture](#2-architecture)
3. [The five hardening layers](#3-the-five-hardening-layers)
4. [Additional capabilities](#4-additional-capabilities)
5. [Installation](#5-installation)
6. [`ensemble.json` configuration reference](#6-ensemblejson-configuration-reference)
7. [Deterministic tests](#7-deterministic-tests-48-suites-no-mocks)
8. [Troubleshooting](#8-troubleshooting)
9. [Security](#9-security)
10. [Provenance and license](#10-provenance-and-license)

---

## 1. Why this runtime

Multi-agent systems are expensive for a structural reason: **every coordination event is a model turn**.
A naive room wakes the orchestrator on every teammate message, wakes teammates the moment they are
created, and mistakes a compacting session for a dead one. Tokens are spent on plumbing instead of on
work.

This runtime removes the plumbing cost at its source:

| Cost driver | Naive behaviour | This runtime |
|---|---|---|
| Spawning a teammate | init prompt is sent immediately | `standby: true` → session registered, **prompt deferred**, 0 tokens |
| Teammate wake-up | any message, any time | first message is the wake, guarded by an **idempotent single-consumer transition** |
| Lead wake-up | one `promptAsync` per `team_message` | messages persist in SQLite; lead is woken **only** by board closure |
| Long/compacting sessions | aborted as stale by the TTL watchdog | **compaction immunity** + active progress heartbeat |
| Rate-limited model | every request retries the same model | per-agent **fallback chain** with burst de-duplication |
| Schema drift | `CHECK` constraint rejects new states | **idempotent rebuild migrations** carrying every column |

The design rule behind all of it: **state lives in the schema, not in conventions.** A lifecycle
transition is a guarded `UPDATE … WHERE execution_status = …`, so two concurrent actors can never both
consume the same wake.

---

## 2. Architecture

```text
┌──────────────────────────────────────────────────────────────────────────────┐
│ OpenCode host — loads dist/index.js through opencode.json → "plugin"         │
└───────────────────────────────┬──────────────────────────────────────────────┘
                                │ plugin hooks (tool.execute, chat.message, …)
┌───────────────────────────────▼──────────────────────────────────────────────┐
│ src/index.ts — orchestration wiring, hooks, timers, V1/V2 transport          │
│                                                                              │
│  src/tools/*          team_* tools                                           │
│                       create · spawn · message · broadcast · claim ·         │
│                       tasks_* · view · results · standby · handover ·        │
│                       shutdown · cleanup                                     │
│  src/hooks.ts         shouldNudgeIdleMember · shouldAlarmFastIdle ·          │
│                       hasBlockedAssignedTasks · failover seams               │
│  src/system-prompt.ts buildLeadSystemPrompt · buildTeammateSystemPrompt ·    │
│                       leadReportDirective (conditional coercion)             │
│  src/watchdog.ts      Watchdog.check · isSessionCompacting                   │
│  src/progress.ts      ProgressTracker (real-progress heartbeat)              │
│  src/schema.ts        createDb · MIGRATIONS (PRAGMA user_version)            │
│  src/messaging.ts     team_message queue (delivered 0 → 1)                   │
│  src/config.ts        ensemble.json resolution + fallback chain selection    │
│  src/recovery.ts      restart rehydration · undelivered messages · orphans   │
│  src/dashboard*.ts    HTTP dashboard (default port 4747)                     │
└───────────────────────────────┬──────────────────────────────────────────────┘
                                │ real SQLite (node:sqlite)
┌───────────────────────────────▼──────────────────────────────────────────────┐
│ ensemble.db                                                                  │
│   team                 room identity, lead session, awaiting_decision queue  │
│   team_member          execution_status CHECK, model, spawn_context, retry_* │
│   team_task            pending · in_progress · in_review · completed · …     │
│   team_message         durable peer messages (delivered flag)                │
│   team_modified_file   per-team file ledger (auto-commit scope)              │
│                                                                              │
│ host session store (opencode.db) — READ-ONLY                                  │
│   session.time_compacting     → compaction immunity                          │
└──────────────────────────────────────────────────────────────────────────────┘
```

### 2.1 Data flow of a wake

```text
producer                    SQLite                       consumer
────────                    ──────                       ────────
team_message(to: B) ──▶ team_message row (delivered=0)
                           │
                           ├─ B.execution_status == 'standby'
                           │     └─ UPDATE … WHERE execution_status='standby'
                           │            → 'starting'
                           │            → promptAsync( spawn_context + text )
                           │
                           └─ B.execution_status != 'standby'
                                 └─ promptAsync( text )

team_message(to: lead) ──▶ team_message row (delivered=0)
                           └─ silentLead=true → NO promptAsync
                                 lead's next legal turn:
                                 buildLeadSystemPrompt() injects backlog
                                 → delivered = 1

team_tasks_complete ─────▶ completed === total
                           └─ exactly 1× promptAsync to lead
                              [System: All team tasks completed on board by <who>]
```

### 2.2 Event model

1. **One wake channel per role.** For teammates, `promptAsync` is the transport. For the lead under
   `silentLead: true`, the **SQLite row is the delivery** and the system prompt is the renderer.
2. **Guarded transitions.** Every lifecycle change is an `UPDATE … WHERE` on the previous state, which
   makes the wake idempotent by construction.
3. **No polling loops.** The lead wake is strictly event-driven (board closure). The watchdog is a
   single TTL-guarded tick, not an agent-driven scan.
4. **Roles are enforced by the schema.** The SDET executes deterministic tests but cannot approve a
   card; only the quality-gate reviewer (or the lead) can complete it.

---

## 3. The five hardening layers

Each layer below is a fix for a concrete failure mode, shipped with its own deterministic suite.

### 3.1 Native Standby — zero tokens at spawn, idempotent wake

**Failure mode.** In the upstream model, `team_spawn` sends the init prompt when the session is created.
Every teammate burns tokens the instant it is born, before any work exists for it.

**Implementation** (`src/tools/team-spawn.ts`, `team-message.ts`, `team-broadcast.ts`):

- `standby: true` registers the member **without** sending any prompt. The session is created with
  `execution_status = 'standby'` and the full prompt is persisted in `team_member.spawn_context`
  (Migration 11).
- The **first** `team_message` / `team_broadcast` addressed to that member is the waker: the delivered
  text has `spawn_context` **prepended**, and the transition `standby → starting` happens through
  `UPDATE … WHERE execution_status = 'standby'`. That predicate is the **one-consumer guard**: two
  simultaneous messages cannot both deliver the init.
- **Fail-safe.** If the wake `promptAsync` throws, the hook restores `execution_status = 'standby'` so a
  retry — or the undelivered-message recovery pass — replays the full `spawn_context` instead of an
  empty prompt.
- **No lost messages.** Messages that arrive before the wake stay queued and join the same turn.

**Guarantee:** `tests/test_standby_lifecycle.mjs` — born in standby with no prompt, wake exactly once,
revert on transport failure, `retry_until` attempts completing `standby → starting`.

### 3.2 Migration 12 — schema rebuild with the `standby` literal

**Failure mode.** `team_member.execution_status` is a SQLite `CHECK` constraint with fixed literals.
SQLite **cannot `ALTER` a `CHECK`**. A database created from scratch would reject the standby `INSERT`
with a constraint error, while a long-lived database only worked because it predated the constraint.

**Implementation** (`src/schema.ts`, Migration 12):

- Rebuild in the pattern already consolidated by Migrations 8 and 13:
  `RENAME → CREATE → INSERT … SELECT → DROP`, then **recreate both indexes** that die with the old
  table (`team_member_session_idx`, `team_member_status_idx`).
- The new table carries **every** column added between Migrations 3 and 11 — `worktree_dir`,
  `worktree_branch`, `plan_approval`, `workspace_id`, `reported_to_lead`, `last_nudged_at`,
  `retry_until`, `retry_attempt`, `retry_provider`, `retry_message`, `spawn_context` — so the rebuild is
  lossless.
- The new `CHECK` accepts `standby` alongside the pre-existing literals
  (`idle, starting, running, cancel_requested, cancelling, cancelled, completing, completed, failed,
  timed_out, standby`).
- `applyMigrations()` runs each migration inside `BEGIN IMMEDIATE … COMMIT` under
  `PRAGMA user_version`, with `foreign_keys` saved and restored. The upgrade path is therefore
  **atomic and idempotent**: a legacy database and a fresh bootstrap converge on the same schema.
- If the stored version is newer than the bundle supports, the runtime throws an explicit
  "upgrade the plugin" error instead of corrupting data.

**Guarantee:** the suites apply the real `MIGRATIONS` array to a real SQLite database — both fresh and
upgrade-from-legacy — and assert `src ↔ dist` parity.

### 3.3 Hook Shielding — no false alarms, no spurious nudges

**Failure mode.** Two independent triggers were blind to standby and to legitimately blocked work:

1. the idle **nudge** would send a prompt to a freshly created member that should never have received one;
2. the `fast-idle` **alarm** would announce "the agent died" for someone legitimately parked.

**Implementation** (`src/hooks.ts`, exported through `src/index.ts`):

- `shouldNudgeIdleMember(db, teamId, member)` returns `false` when `execution_status === 'standby'`
  (in addition to the already-covered blocked states), and still honours the `last_nudged_at` window.
- `shouldAlarmFastIdle(...)` returns `false` for `standby`, preserving the alarm only for genuine idle.
  The predicate was extracted from the bundle's inline block into a testable seam **without changing the
  decision**.
- `hasBlockedAssignedTasks(...)` keeps legitimately blocked work visible to the team nudge without
  producing an alarm.

**Guarantee:** `tests/test_standby_lifecycle.mjs` asserts **zero false `fast-idle` alarms** across the
whole suite (check `D12`) and exercises nudge and wake concurrently.

### 3.4 Resilient Watchdog — active heartbeat and compaction immunity

**Failure mode.** The watchdog tears sessions down on a TTL (`stallThresholdMs`, default 300 s). A
session in **context compaction** does not advance `time_updated`, so it was aborted as "stale" — an
undue timeout that destroyed context and forced expensive rework.

**Implementation** (`src/watchdog.ts`, `src/progress.ts`):

- **Active heartbeat.** On each check, a stale member whose session shows real progress
  (`ProgressTracker`: new steps / output tokens above `stallTokenThreshold` after `stallMinSteps`) gets
  `time_updated` **renewed** and keeps running (`watchdog:heartbeat:renewed`).
- **Compaction immunity.** `isSessionCompacting(sessionId)` reads `session.time_compacting` from the
  host session store **read-only**. When the value is `> 0`, the session is not aborted on this tick and
  is re-evaluated on the next (`watchdog:heartbeat:compacting`).
- A compaction value of `0` does **not** buy immunity — the race is decided correctly. Genuinely idle
  sessions still transition to `error / timed_out`, with a lead warning, a toast and worktree cleanup.
- `stallThresholdMs = 0` disables the TTL while keeping worktree GC. A missing or corrupted store
  returns `false` without throwing.
- `start()` wraps `check()` in a logged `.catch` and `unref()`s both timers; `dispose()` is idempotent
  and `stop()` remains a legacy alias.

**Guarantee:** `tests/test_watchdog_heartbeat.mjs` — four scenarios (active, compacting, idle,
compaction = 0) executed **against both `dist` and `src`**, materializing the `session` store from the
versioned DDL in `tests/fixtures/session_schema.sql` (no dependency on the host database).

### 3.5 Silent Lead and Systematic Board Wake

**Failure mode.** Every lead-bound `team_message` fired a `promptAsync` on the lead session. The
orchestrator woke dozens of times per turn, multiplying tokens and violating the "no polling / silent
lead" rule.

**Implementation** (`src/tools/team-message.ts`, `team-tasks-complete.ts`, `src/system-prompt.ts`,
`src/config.ts`):

- **`silentLead` (default `true`).** Lead-bound messages are **persisted** (`delivered = 0`) and **no**
  `promptAsync` is fired. The real delivery channel is `buildLeadSystemPrompt`, which injects the
  accumulated backlog on the lead's **next** legitimate turn and marks `delivered = 1`. Wake tokens
  while the lead rests: **zero**.
- **`silentLead: false` (legacy).** Byte-for-byte original behaviour: a single `promptAsync` with
  `[System: New team message from <sender>]` and `synthetic: true`.
- **Conditional directive coercion.** With `silentLead` active, the aggressive prompt line
  `"You MUST send your results to the lead via team_message before stopping."` is replaced by
  `"Collaborate with teammates using team_message and complete assigned tasks on the board."`
  (`leadReportDirective`). In legacy mode the text is preserved verbatim.
- **Systematic board waker.** In `team_tasks_complete`, when `total > 0 && completed === total`, the
  lead receives **exactly one** `[System: All team tasks completed on board by <who>]` with
  `synthetic: true`. This is the **only** automatic lead-wake event — waking is 100 % systematic and
  never driven by message content.
- **Fail-safe.** A wake transport failure is absorbed by `.catch` (zero `unhandledRejection`), and a
  task without an `assignee` is atomically assigned to its author so the board never lies.

**Guarantee:** `tests/test_silent_lead_board_wake.mjs` — `delivered = 0` queue with no wake, single
wake at board closure, conditional coercion, byte-for-byte legacy parity, zero regressions on the
earlier suites.

---

## 4. Additional capabilities

### 4.1 Reactive model fallback on 429 / retry

A provider rate limit (HTTP 429) or a retry storm would otherwise stall the room, with every request
hitting the same exhausted model.

- **Configurable chain** via `ensemble.json`: `fallbackModels` (ordered selectors
  `"provider/model"` or `"provider/model#variant"`) and `fallbackModelsByAgent` (per-agent override).
- **Precedence:** `fallbackModelsByAgent[agent]` → `fallbackModelsByAgent[basePersona]` →
  `fallbackModels` → legacy `modelFallback` → built-in default. The chain is never empty, malformed
  entries are discarded, duplicates collapse, and a fallback is never equal to the primary model.
- **Multi-instance symmetry:** `reviewer-x` / `reviewer_2` inherit the chain declared for `reviewer`.
- **`#default` sentinel normalization:** the server reports `model.variant === "default"` to mean
  *no variant*. The parser strips it, so round-tripping never produces an unmatchable key like
  `"provider/model#default"` and the failover never loops on itself.
- **Burst de-duplication:** `FAILOVER_COOLDOWN_MS` (10 minutes, per `teamId:memberName`) collapses the
  repeated attempts of a single 429 burst — otherwise advancing the chain once per attempt would burn
  the whole chain in seconds.
- **Zero-noise:** "switched" / "suppressed" only log and update `team_member.model`; chain
  **exhaustion** is silent too — it logs the decision and applies the cooldown without waking the lead.
  The lead has exactly one automatic wake: the systematic full-board closure event.
- **Three seams:** member sessions (persisted switch), isolated sessions (explicit per-agent chain only),
  and the lead session (explicit per-agent chain only — the global chain never hijacks it).

### 4.2 Task board, dependencies and intra-card handover

- Strict lifecycle: `pending → in_progress` (claim) `→ in_review` (submit) `→ completed` (reviewer
  verdict); `reject` returns the card to `in_progress`.
- **Cooperative development.** Teammates exchange partial work exclusively through `team_message`;
  `submit_review` is reserved for the final consolidation of a functionality.
- **Intra-card handover** — `team_task_handover(task_id, to, notes?)`: the current assignee passes an
  `in_progress` card to a complementary specialist. The runtime reassigns the `assignee` atomically,
  wakes the receiver with the notes (plus its `spawn_context` if it was in standby) and puts the sender
  into standby with a clean context window. Only the current assignee or the lead may pass the baton.
- **Dependency unlocking.** When a card is submitted or completed, downstream validation cards
  (`sdet` / `qa`) move to `in_progress` and their assignee is woken with a deterministic system prompt;
  regular downstream cards are simply unblocked.

### 4.3 HTTP dashboard

A local dashboard exposes `/`, `/api/state`, `/api/health`, `/api/session/:id/activity` and
`/api/chat/send` on `dashboardPort` (default `4747`). It binds to `127.0.0.1` and enforces a
Host/Origin gate on both `GET` and `POST` (DNS-rebinding protection). Set `dashboardPort: 0` to disable.

---

## 5. Installation

### 5.1 Requirements

- Node.js **>= 22.22.2** (native `node:sqlite`, type stripping)
- An OpenCode installation (`npm i -g opencode-ai`, or your preferred channel)
- Bun **>= 1.0** only if you use the TUI helper (`exports["./tui"]`)

### 5.2 Install from npm

```bash
npm install ensemble-room-lowcost
```

If you vendor the repository instead:

```bash
git clone https://github.com/maiteuxzanela/ensemble-room-lowcost.git
cd ensemble-room-lowcost
npm ci
npm run check
npm test
```

### 5.3 Register the plugin

Add the package to the `plugin` array of your `opencode.json` (either global, in the OpenCode config
directory, or project-local at `<project>/opencode.json`):

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "plugin": ["ensemble-room-lowcost"]
}
```

Restart OpenCode afterwards. The plugin is loaded at runtime boot; editing `dist/index.js` does not
affect sessions that are already alive.

### 5.4 Optional: runtime configuration

Configuration is optional. When you need it, create `ensemble.json` in **one** of two places:

- **Global:** `$XDG_CONFIG_HOME/opencode/ensemble.json` (falls back to the platform default below the
  user's home directory).
- **Project:** `<project>/.opencode/ensemble.json`.

The two are deep-merged as `DEFAULT → global → project`, with two additive exceptions:

- `deniedTools` — **unioned**. Deny lists accumulate across scopes and are deduplicated.
- `fallbackModelsByAgent` — **merged per agent key**. A partial project file overrides only the agents it
  declares and never wipes sibling global entries.

### 5.5 First run

```text
team_create({ name: "core", lead_session_id: "<current session id>" })
team_tasks_add({ tasks: [{ content: "Implement X", priority: "high" }] })
team_spawn({ name: "worker-a", agent: "build", prompt: "Implement X", claim_task: "<task id>", standby: true })
team_message({ to: "worker-a", text: "Start with the storage layer." })   // ← this is the wake
team_task_handover({ task_id: "<task id>", to: "reviewer", notes: "implementation done" })
```

---

## 6. `ensemble.json` configuration reference

Every key is optional. Defaults come from `DEFAULT_CONFIG` in `src/config.ts`.

| Key | Type | Default | Purpose |
|---|---|---|---|
| `silentLead` | boolean | `true` | Suppresses lead `promptAsync` on `team_message`; delivery happens through the system prompt on the lead's next turn. The lead is woken only by total board closure. Set `false` for legacy per-message wake. |
| `stallThresholdMs` | number | `300000` | Watchdog TTL in ms (5 min). `0` disables the TTL while keeping worktree GC. |
| `stallMinSteps` | number | `5` | Minimum number of steps before the token-based stall heuristic applies. |
| `stallTokenThreshold` | number | `200` | Output-token delta that counts as real progress for the heartbeat. |
| `timeoutMs` | number | `1800000` | Hard timeout for busy members (30 min). `0` disables. |
| `rateLimitCapacity` | number | `10` | Peer-message rate limit capacity per window. `0` disables. |
| `peerMessageLimit` | number | `5` | Max peer messages per agent per window before a nudge. `0` disables. |
| `peerMessageWindowMs` | number | `300000` | Window for the peer-message rate limit (5 min). |
| `dashboardPort` | number | `4747` | HTTP dashboard port. `0` disables the dashboard. |
| `roomInactivityThresholdMs` | number | `30000` | No-activity threshold (30 s) after which the room watchdog inspects unfinished board work. |
| `roomInactivityCheckMs` | number | `5000` | Cadence of the room-inactivity sweep (5 s), independent of the threshold. |
| `mergeOnCleanup` | boolean | `true` | Auto-merge worktree branches during cleanup. |
| `defaultModel` | string | `""` | Default model selector for all spawned agents, e.g. `"provider/model"`. |
| `modelPool` | string[] | `[]` | Pool of selectors used by rotation/random assignment. |
| `modelsByAgent` | object | `{}` | Map of agent type → model selector, e.g. `{"build": "provider/model#low"}`. |
| `modelAssignment` | `"default" \| "rotate" \| "random"` | `"default"` | Strategy used to assign models from the pool. |
| `promptForModels` | boolean | `false` | Ask the user about model preferences before spawning. |
| `fallbackModels` | string[] | `[]` | Ordered fallback chain. Entries are `"provider/model"` or `"provider/model#variant"`; malformed entries are discarded, duplicates collapse. Empty resolves to `modelFallback`. |
| `fallbackModelsByAgent` | object | `{}` | Per-agent chain override. Resolution: exact agent key → base-persona key (`reviewer-2` inherits `reviewer`) → global chain. Merged per key across scopes. |
| `modelFallback` | `{ model, variant? }` | built-in cheap default (variant `low`) | Legacy single-entry fallback used only when `fallbackModels` is empty. |
| `deniedTools` | string[] | `[]` | Extra tools denied to spawned teammates, on top of the built-in integrity deny-list. Unioned across global and project scopes. |

### 6.1 Failover behaviour constants

| Constant | Value | Where | Meaning |
|---|---|---|---|
| `FAILOVER_COOLDOWN_MS` | `600000` (10 min) | `src/hooks.ts` | Per-`teamId:memberName` de-duplication window for a 429 burst. One burst = one chain advance. |
| `VARIANT_ABSENT_SENTINEL` | `"default"` | `src/config.ts` | The server's marker for "no variant". Never emitted, never matched, never forwarded. |
| `DEFAULT_MODEL_FALLBACK` | cheap model, variant `low` | `src/config.ts` | Last resort when no chain is configured. |

### 6.2 Example

```jsonc
{
  "silentLead": true,
  "stallThresholdMs": 300000,
  "stallMinSteps": 5,
  "stallTokenThreshold": 200,
  "dashboardPort": 4747,
  "roomInactivityThresholdMs": 30000,
  "roomInactivityCheckMs": 5000,
  "fallbackModels": ["provider-a/model-x#low", "provider-b/model-y#low"],
  "fallbackModelsByAgent": {
    "reviewer": ["provider-c/model-z#high"],
    "sdet": ["provider-a/model-x#low"]
  },
  "deniedTools": ["some_ecosystem_tool"]
}
```

### 6.3 Selector syntax

```text
provider/model            → no variant
provider/model#low        → variant "low"
provider/model#medium     → variant "medium"
provider/model#high       → variant "high"
provider/model#default    → INVALID intent; normalized to "provider/model"
```

A missing `provider/` prefix is treated as malformed for chain entries (the fallback chain is skipped at
that entry, never at the cost of emptying it).

---

## 7. Deterministic tests (48 suites, no mocks)

The runner executes the real artifacts — no mocks, no stubs, no fake fixtures.

```bash
npm run check      # node --check dist/index.js   → syntax gate
npm test           # node tests/run_all.mjs       → 48 suites, exit 0 only if all pass
npm run typecheck  # tsc --noEmit
npm run build      # esbuild → dist/index.js
```

Properties of the suite:

- **48 suites** executed in strict sequence (fail-report, no early abort); the consolidated exit code is
  `0` only when every suite exits `0` and emits no `FAIL` line.
- **Zero mocks.** The only seam is the **output transport** (`session.create`, `promptAsync`,
  `session.abort`, `showToast`), recorded into an array so assertions prove *what was called*. No
  decision logic is replaced.
- **Real code under test.** Both `dist/index.js` (the real bundle) and the `.ts` sources of `src/`
  (copied outside `node_modules` with mechanical import-extension resolution only — logic intact), so
  `src ↔ dist` parity is continuously proven.
- **Real SQLite.** `node:sqlite` databases created under `.test-scratch/` (gitignored, recreated per run).
- **Hermetic.** The `session` / `project` store schema is versioned in-repo as
  `tests/fixtures/session_schema.sql`; suites apply that DDL to a throwaway database instead of reading
  the host store. `ENSEMBLE_PKG=/path/to/checkout node tests/…` targets another tree without editing
  any file — useful for auditing a published package.

Representative coverage:

| Area | Suites | What they prove |
|---|---|---|
| Watchdog heartbeat & compaction immunity | 1 | 4 scenarios on `src` and `dist`, `time_compacting` semantics |
| Standby lifecycle & hook shielding | 1 | wake exactly once, revert on failure, zero false alarms |
| Silent lead & board wake | 1 | `delivered` queue, single closure wake, prompt coercion, legacy parity |
| Model fallback & rate-limit failover | 7 | precedence, per-agent resolution, cooldown, abort + re-prompt, `#default` normalization |
| Task board, dependencies & intra-card handover | 9 | atomic reassignment, SDET/QA unlocking, cyclic graphs, shutdown |
| Governance roles (SDET / Quality Gate) | 4 | role exclusivity, anti-bypass, review flow |
| Local auto-commit on approval | 3 | git real in sandbox, multi-repo ledger, shell-artifact ledger (before/after snapshot), clean-tree and non-repo cases |
| Dashboard | 3 | endpoints, renderer, Host/Origin gate, CSRF/cross-origin hardening |
| Messaging, discovery & lifecycle regressions | 19 | action strictness, schema parity, recovery, pause kill-switch |
| **Total** | **48** | thousands of assertions, mutation-tested |

Runner report shape:

```text
PASS | test_watchdog_heartbeat.mjs        | exit=0 |   … ms | RESULT: 55/55 checks passed
PASS | test_standby_lifecycle.mjs         | exit=0 |   … ms | RESULT: 130/130 checks passed
PASS | test_silent_lead_board_wake.mjs    | exit=0 |   … ms | RESULT: 151/151 checks passed
…
SUÍTES: 48/48 passaram
RESULT_ALL: ALL SUITES PASSED
```

---

## 8. Troubleshooting

### The lead never wakes up

Expected when `silentLead: true` (the default): lead-bound messages only appear in the lead's **next**
turn, and the single automatic wake is total board closure. Check the board state:

```text
team_tasks_list()
```

If `completed < total`, no wake will fire by design. Team status and task state are also visible in the
dashboard (`http://127.0.0.1:4747`). To restore per-message wakes, set `"silentLead": false`.

### A teammate spawns but never does anything

That is **native standby working**. The session is created with `execution_status = 'standby'` and the
prompt is stored in `spawn_context` (zero tokens spent). Send the first `team_message` — it is the
waker. If the wake transport fails, the runtime reverts the member to `standby`, so simply retry.

### `SQLite constraint failed: CHECK constraint failed: team_member`

The database predates Migration 12 and was not rebuilt. OpenCode must boot the current bundle **once**
against that database; `applyMigrations()` performs the `RENAME → CREATE → COPY → DROP` rebuild
atomically. Verify the bundle is the one actually loaded (`dist/index.js` mtime) and restart OpenCode.

### `Database schema version N is newer than this plugin supports (M)`

The database was written by a newer plugin version. Upgrade the package; do not downgrade by hand, and do
not edit `PRAGMA user_version` — the column set would no longer match the `CHECK` constraints.

### A long session is killed after five minutes

- Confirm `stallThresholdMs` (default `300000`). Set `0` to disable the TTL entirely (worktree GC stays
  active).
- Compaction immunity only applies while the host store reports `session.time_compacting > 0`. A
  corrupted or missing store intentionally returns `false` (fail-fast) instead of masking a real stall.
- Sessions that show real progress are renewed by the heartbeat; a session making no steps and no tokens
  is genuinely stalled.

### Failover does not switch models

Check, in order:

1. **Format.** Chain entries must be `provider/model` or `provider/model#variant`. `#default` is the
   server's absence marker and is normalized away — it will never match a chain entry.
2. **Scope.** The member's agent key must exist in `fallbackModelsByAgent`, or the global
   `fallbackModels` / `modelFallback` applies. The global chain **never** hijacks isolated or lead
   sessions; those require an explicit per-agent chain.
3. **Cooldown.** `FAILOVER_COOLDOWN_MS` (10 min per `teamId:memberName`) intentionally collapses a burst
   into one advance. A second distinct 429 inside the window is suppressed.
4. **Exhaustion.** If the current model is already the last chain entry, the decision is `exhausted`:
   only a log entry and the cooldown are produced, with no lead notification and no further switches.
   The lead is woken exclusively by the systematic full-board closure event — failover never wakes it.

### Dashboard port is busy, or the dashboard does not answer

`dashboardPort` defaults to `4747`. Set another port, or `0` to disable. The server binds `127.0.0.1`
only and rejects requests whose `Host`/`Origin` do not match — behind a reverse proxy, preserve the
original `Host` header. Verify the runtime is live with `curl http://127.0.0.1:4747/api/health`.

### `npm test` fails immediately with `ERR_MODULE_NOT_FOUND`

Dependencies are not installed. Run `npm ci` (or `npm install`) in the repository root first. The
suites import real packages by design — there are no stubs to fall back on.

### Type errors during `npm run typecheck`

The compiler settings live in `tsconfig.json`; `typescript` is a devDependency. Run `npm ci` to
restore the exact locked version. The published runtime is the pre-built `dist/index.js`, so a local
type error never affects a consumer — but it does gate contributions.

### `npm run build` produces a bundle the host rejects

Build with the pinned command:

```bash
npm run build   # esbuild src/index.ts --bundle --platform=node --format=esm --packages=external
```

`--packages=external` keeps `@opencode-ai/*`, `solid-js`, `@opentui/*` out of the bundle;
`--format=esm` preserves `"type": "module"`. After building, `npm run check` must pass and `npm test`
must stay green. Restart OpenCode to load the new bundle into memory.

---

## 9. Security

See [SECURITY.md](./SECURITY.md) for the formal responsible-disclosure policy, supported versions,
response targets and the **package lineage** register.

### Package lineage (`@opencode/plugin` vs `@opencode-ai/plugin`)

Both packages are legitimate and are used for different SDK generations. `@opencode-ai/plugin` (and
`@opencode-ai/sdk`) are the official v1 namespace; `@opencode/plugin` is the v2 plugin SDK maintained by
**Dax Raad (`thdxr`)**, the creator and architect of OpenCode. The runtime imports `Plugin` from
`@opencode/plugin` and keeps the v1 `server()` export for dual compatibility. `@opencode/plugin` is
pinned to an exact version (`2.0.16`) and `package-lock.json` carries its registry URL and `sha512`
integrity hash, so `npm ci` is byte-identical. Verify with:

```bash
npm ls @opencode/plugin @opencode-ai/plugin @opencode-ai/sdk
npm view @opencode/plugin version maintainers   # → thdxr <d@ironbay.co>
npm audit --omit=dev   # 0 vulnerabilities
```

The coexistence of the two scopes is therefore not typosquatting: it is the documented v1/v2 plugin
surface, all installed from the public npm registry.

Operational defaults that matter:

- The dashboard binds to loopback (`127.0.0.1`) and enforces a Host/Origin gate against DNS rebinding.
- State lives in a local SQLite database; the host session store is opened **read-only**.
- Credentials are never stored by the runtime — model access uses the host's own provider configuration.
- Teammates are spawned with an integrity deny-list of tools (`team_create`, `team_cleanup`, `team_merge`,
  `team_shutdown`, `task`, `todowrite`), extendable through `deniedTools`.

---

## 10. Provenance and license

- Derived from `@hueyexe/opencode-ensemble@0.18.0` (MIT): `src/`, `dist/`, `LICENSE` and the social
  preview image originate there.
- `package.json` was rewritten only in `name`, `version`, `description`, `repository`, `keywords`,
  `files`, `scripts` (`test`, `check`, `typecheck`, `build`) and the `exports`/`types` map. Since `0.18.2`
  the package root resolves through `exports["."]` to the compiled `dist/index.js` (with
  `exports["."].types` → `src/index.ts`), so plain Node consumers no longer hit TypeScript syntax. The
  optional `./rpc` and `./tui` companion subpaths still point at their TypeScript sources and require
  Bun/Node type-stripping.
- `@opencode/plugin` (`2.0.16`) is pinned by exact version in `dependencies`, ahead of the upstream
  `@opencode/plugin@2.0.3`; its runtime/tooling dependencies are pinned through `package-lock.json`.
- The published upstream tarball omitted `tsconfig.json`; the file versioned here was recovered from the
  upstream repository with unchanged compiler settings.

MIT © [maiteuxzanela](https://github.com/maiteuxzanela) — derived from `@hueyexe/opencode-ensemble` (MIT).
See [LICENSE](./LICENSE).
