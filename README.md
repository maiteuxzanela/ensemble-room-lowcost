# ⚡ Ensemble Room (Low-Cost Multi-Agent Runtime)

[![npm version](https://img.shields.io/npm/v/ensemble-room-lowcost.svg?color=cb3837&style=flat-square)](https://www.npmjs.com/package/ensemble-room-lowcost)
[![npm downloads](https://img.shields.io/npm/dm/ensemble-room-lowcost.svg?style=flat-square)](https://www.npmjs.com/package/ensemble-room-lowcost)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg?style=flat-square)](https://opensource.org/licenses/MIT)

**OpenCode Ensemble Hardened — a low-cost multi-agent runtime with native standby, silent lead, and deterministic board wake.**

A multi-agent team runtime for [OpenCode](https://opencode.ai), derived from `@hueyexe/opencode-ensemble@0.18.0` and hardened (`0.18.1`) for **token-efficient** operation: teammates are born in **standby** (zero tokens at spawn time), the **lead stays in absolute passive rest** and only wakes on a single deterministic event — **total board closure** (`completed === total`).

| | |
|---|---|
| Package | `ensemble-room-lowcost` |
| Version | `0.18.1` (upstream base: `@hueyexe/opencode-ensemble@0.18.0`) |
| Runtime entrypoint | `dist/index.js` (self-contained bundle) |
| Source entrypoint | `src/index.ts` (`exports["."]`) |
| Repository | `github.com/maiteuxzanela/ensemble-room-lowcost` (branch `main`) |
| License | MIT |
| Suites | `node tests/run_all.mjs` → **39 deterministic suites, ~2.7k checks, zero mocks** |

---

## 1. Architecture

```text
┌──────────────────────────────────────────────────────────────────────┐
│ OpenCode (host) — loads dist/index.js via opencode.json "plugin"     │
└───────────────────────────────┬──────────────────────────────────────┘
                                │  plugin hooks (tool.execute / chat.message …)
┌───────────────────────────────▼──────────────────────────────────────┐
│ src/index.ts  — V1/V2 orchestration, tool wiring, hooks and timers   │
│   ├── src/tools/*          team_* tools (create/spawn/message/       │
│   │                        broadcast/claim/tasks/view/results/       │
│   │                        standby/handover/shutdown/…)              │
│   ├── src/hooks.ts         shouldNudgeIdleMember,                    │
│   │                        shouldAlarmFastIdle,                      │
│   │                        hasBlockedAssignedTasks                   │
│   ├── src/system-prompt.ts buildLeadSystemPrompt /                   │
│   │                        buildTeammateSystemPrompt +               │
│   │                        leadReportDirective (conditional coercion)│
│   ├── src/watchdog.ts      Watchdog.check + isSessionCompacting      │
│   ├── src/progress.ts      ProgressTracker (progress heartbeat)      │
│   ├── src/schema.ts        createDb + MIGRATIONS                     │
│   ├── src/messaging.ts     team_message queue (delivered 0/1)        │
│   ├── src/config.ts        ensemble.json (silentLead, stall*, …)     │
│   ├── src/recovery.ts      post-restart rehydration / undelivered    │
│   │                        messages / orphan worktrees               │
│   └── src/dashboard*.ts    HTTP dashboard on :4747                   │
└───────────────────────────────┬──────────────────────────────────────┘
                                │ real SQLite (node:sqlite)
┌───────────────────────────────▼──────────────────────────────────────┐
│ ensemble.db — team, team_member (execution_status), team_task,       │
│               team_message (delivered), team_member_message …        │
│ Host session store (opencode.db) — read-only source of the `session` │
│               schema and of session.time_compacting                  │
└──────────────────────────────────────────────────────────────────────┘
```

**Transport principles**

1. **One wakeup channel per role.** For teammates, `promptAsync` is the transport; for the lead under `silentLead: true`, the **SQLite row is the delivery** and the system prompt is the renderer (`buildLeadSystemPrompt` marks `delivered = 1`).
2. **State is schema, not convention.** The lifecycle (`idle → standby → starting → running → …`) lives in the `CHECK` constraint of `team_member.execution_status`; transitions are guarded `UPDATE`s (`WHERE execution_status = …`), guaranteeing a single consumer.
3. **No polling.** The lead wake is strictly event-driven (board closure); the watchdog is a single TTL-guarded tick, not a scan loop.

---

## 2. Features

### 2.1 Native Standby — zero tokens at spawn, idempotent wake guard

**Problem.** In `team_spawn`, the init prompt used to be sent when the session was created: every teammate burned tokens the moment it was born, before any real work — a non-starter for low-cost setups.

**Solution** (`src/tools/team-spawn.ts`, `src/tools/team-message.ts`, `src/tools/team-broadcast.ts`):

- `standby: true` registers the member **without** sending a prompt. The session is born with `execution_status = 'standby'` and the full prompt is persisted in `team_member.spawn_context` (Migration 11).
- The **first** `team_message`/`team_broadcast` addressed to the member is the waker: the delivery text has `spawn_context` **prepended** and the transition `standby → starting` happens via `UPDATE … WHERE execution_status = 'standby'` — an **idempotent one-consumer guard**: two simultaneous messages never duplicate the init.
- **Fail-safe**: if the wake `promptAsync` fails, the hook restores the window (`execution_status` back to `'standby'`) so a retry or the undelivered-message recovery pass replays the `spawn_context` instead of an empty prompt.
- No lost messages: messages arriving before the wake stay queued and join the same turn.

**Guarantee:** `tests/test_standby_lifecycle.mjs` (130 checks) — born in standby without a prompt, wake exactly once, revert on transport failure, `retry_until` attempts completing `standby → starting`.

### 2.2 Silent Lead — absolute passive rest, SQLite delivery, single board wake

**Problem.** Every `team_message` addressed to the lead used to trigger `promptAsync` on the lead session: the orchestrator woke dozens of times per turn, multiplying tokens and breaking the "no polling / silent lead" rule.

**Solution** (`src/tools/team-message.ts`, `src/tools/team-tasks-complete.ts`, `src/system-prompt.ts`, `src/config.ts`):

- **`silentLead` (default `true`)**: messages to the lead are **persisted** (`delivered = 0`) and **no** `promptAsync` is fired. The real delivery channel becomes `buildLeadSystemPrompt`, which injects the backlog on the lead's **next** legitimate call and marks `delivered = 1`. Result: wake tokens = **zero** while the lead rests.
- **`silentLead: false` (legacy)**: original byte-for-byte behavior — a single `promptAsync` with `[System: New team message from <sender>]` and `synthetic: true`.
- **Conditional coercion in the system prompt**: with `silentLead` active, the aggressive directive
  `"You MUST send your results to the lead via team_message before stopping."` is replaced by
  `"Collaborate with teammates using team_message and complete assigned tasks on the board."`
  (`leadReportDirective`); in legacy mode the text is preserved verbatim.
- **Systematic board waker** (`team_tasks_complete`): when `total > 0 && completed === total`, the lead receives **exactly 1×** `[System: All team tasks completed on board by <who>]` with `synthetic: true`. This is the **only** automatic lead-wake event — i.e., waking is 100% systematic, never driven by message content.
- Fail-safe: a wake transport failure is absorbed by `.catch` (zero `unhandledRejection`), and a task without an `assignee` is atomically assigned to its author so the board never lies.

**Guarantee:** `tests/test_silent_lead_board_wake.mjs` (151 checks) — `delivered=0` queue without wake, single wake at board closure, conditional coercion, byte-for-byte legacy, zero regressions against the other suites.

### 2.3 Resilient Watchdog — context-compaction immunity

**Problem.** The watchdog tears sessions down on a TTL (`stallThresholdMs`, default 300 s). Sessions in **context compaction** (long context) do not advance `time_updated` and were aborted as "stale" — an undue timeout causing context loss and costly rework.

**Solution** (`src/watchdog.ts`, `src/progress.ts`):

- **Active heartbeat:** on each check, a stale member whose session shows real progress (`ProgressTracker`) gets `time_updated` **renewed** — it stays "busy" without aborting (`watchdog:heartbeat:renewed`).
- **Compaction immunity:** `isSessionCompacting(sessionId)` reads `session.time_compacting` from the host session store **read-only**; if `> 0`, the session is not aborted on this tick and is re-evaluated on the next (`watchdog:heartbeat:compacting`).
- A compaction value of `0` does **not** enjoy immunity (the race is decided correctly); genuinely idle sessions still transition to `error/timed_out` with a lead warning, a toast, and worktree cleanup.
- `ttlMs = 0` disables the TTL while keeping worktree GC; resilience to a missing/corrupted store returns `false` without throwing.
- `start()` wraps `check()` in a logged `.catch` and `unref()`s both timers; `dispose()` is idempotent (clears both timers) and `stop()` remains a legacy alias.

**Guarantee:** `tests/test_watchdog_heartbeat.mjs` (55 checks) — 4 scenarios (active, compacting, idle, compaction=0) run **against both `dist` and `src`**, materializing the `session` store from the versioned schema fixture `tests/fixtures/session_schema.sql` (no dependency on the host `opencode.db`).

### 2.4 Reactive, dynamic model fallback on 429 / retry

**Problem.** A provider rate limit (HTTP 429) or a retry storm would otherwise stall the room: every request kept hitting the same exhausted model.

**Solution** (`src/config.ts`, `src/hooks.ts`, `src/rate-limit.ts`):

- **Configurable chain** via `ensemble.json`:
  - `fallbackModels: string[]` — ordered selectors `"provider/model"` or `"provider/model#variant"` (e.g. `"provider-a/model-x#low"`); malformed entries are discarded and duplicates removed.
  - `fallbackModelsByAgent: Record<string, string[]>` — per-agent override, resolved with base-persona symmetry.
  - **Precedence:** `fallbackModelsByAgent[agent]` → `fallbackModelsByAgent[basePersona]` → `fallbackModels` → legacy `modelFallback` → built-in default. A fallback entry is never equal to the primary model (failover cannot be to itself).
- **Reactive switching on rate limit:** the failover hook selects the next chain entry and arms **subsequent deliveries** (`team_message`/wake/watchdog) — every delivery path reads `team_member.model`, so the switch takes effect immediately.
- **Burst de-duplication:** a 10-minute cooldown per `teamId:memberName` collapses the repeated attempts of a single 429 burst (advancing the chain once per retry would burn the whole chain in seconds).
- **Zero-noise policy:** a "switched"/"suppressed" failover only logs and updates `team_member.model`; the **only** authorized lead notification is chain **exhaustion**, and it fires exactly once.
- **`#default` sentinel normalization:** the server reports `model.variant === "default"` to mean "no variant"; the parser normalizes it away so round-tripping never produces an unmatchable key like `"p/m#default"` and the failover never loops on itself.

**Guarantee:** `tests/test_fallback_models.mjs`, `test_rate_limit_failover.mjs`, `test_per_agent_fallback.mjs`, `test_fallback_hardening.mjs`, `test_failover_integration.mjs`, `test_retry_failover_active.mjs`, `test_force_model_abort.mjs` — chain precedence, per-agent resolution, cooldown de-duplication, abort + re-prompt, and variant forwarding on the V2 switch path.

### 2.5 Task board — cooperation and intra-card handover

**Problem.** When several specialties must work on the **same card** (or the same files), parallel writes collide, and forcing a single teammate to grind through work outside its domain pressures its context window.

**Solution** (`src/tools/team-task-handover.ts`, `src/tasks.ts`, `src/tools/team-tasks-complete.ts`):

- A single, event-driven cyclical **task board** with a strict lifecycle:
  `pending → in_progress` (claim) `→ in_review` (submit for review) `→ completed` (reviewer verdict)`; `reject` returns the card to `in_progress`.
- **Cooperative development:** teammates iterate and exchange files **only via `team_message`**; `submit_review` is reserved for the final consolidation, never for partial steps.
- **Intra-card handover (`team_task_handover(task_id, to, notes?)`)** — a *sequential bench partnership*: the current assignee hands the baton of an `in_progress` card to a complementary specialist. The runtime **atomically reassigns** the `assignee`, wakes the receiver with the handover notes (and the receiver's `spawn_context` when it was in standby), and puts the sender into standby with a clean context window. Only the current assignee (or the lead) may pass the baton, and the card must be `in_progress`.
- **Dependency unlocking:** when a card is submitted/completed, downstream cards of **validation profiles** (`sdet`/`qa`) transition to `in_progress` and their assignee is woken with a deterministic system prompt; regular downstream cards are simply unblocked.
- **Role separation is enforced by the schema, not by convention:** the SDET runs the deterministic suite but **cannot approve**; only the Quality Gate reviewer (or the lead) can `complete` a card. Auto-review is forbidden.

**Guarantee:** dedicated suites cover the handover, the SDET review flow, dependency unlocking, cyclic dependency graphs, guardian reviews and runtime auto-standby — atomic reassignment, wake with persona/spawn_context, transmitter standby, fail-fast without side effects, V1↔V2 parity, and mutation testing proving the assertions are sensitive.

### 2.6 Deterministic tests — no mocks

The whole runtime is covered by an offline-capable, fixture-free suite that runs the **real** code:

- **Zero mocks / stubs / fake fixtures.** The only seam is the **output transport** (`session.create`, `promptAsync`, `session.abort`, `showToast`), recorded into an array so assertions prove *what was called*. No decision logic is replaced.
- Code under test is the **real** artifact of this repository: `dist/index.js` (bundle) and the `.ts` sources of `src/` copied out of `node_modules` (Node's type-stripping refuses imports from `node_modules`) with mechanical import-extension resolution only — logic intact.
- **Real SQLite databases** (`node:sqlite`) created in isolation under `.test-scratch/` (gitignored, recreated on every run).
- The `session`/`project` store schema is **versioned in-repo** as `tests/fixtures/session_schema.sql` (DDL extracted from the real store, columns and constraints preserved). Suites apply it to a throwaway SQLite database under `.test-scratch/`, so the test run is hermetic — the host `opencode.db` is **not** an environment prerequisite anymore.
- `ENSEMBLE_PKG=/path/to/another/checkout node tests/…` points the suites at another tree without editing any file (handy for auditing a published package).

---

## 3. Deterministic suites (anti-mock, fail-fast)

```bash
node --check dist/index.js     # or: npm run check   → exit 0
node tests/run_all.mjs         # or: npm test        → exit 0 / RESULT_ALL: ALL SUITES PASSED
```

The runner executes **39 suites in strict sequence** (fail-report, no early abort) and only exits `0` when every suite returns exit `0` and no `FAIL` line was emitted. Representative coverage:

| Area | Suites | Checks |
|---|---|---|
| Watchdog heartbeat & compaction immunity | 1 | 53 |
| Standby lifecycle & hook shielding | 1 | 130 |
| Silent lead & board wake | 1 | 151 |
| Model fallback & rate-limit failover | 7 | 220 |
| Task board, dependencies & intra-card handover | 8 | 454 |
| Governance roles (SDET / Quality Gate) | 4 | 283 |
| Local auto-commit on approval | 2 | 345 |
| Dashboard chat | 1 | 15 |
| Discovery, lifecycle & messaging regressions | 14 | 1090 |
| **Total** | **39** | **2741** |

Consolidated runner report (shape):

```text
PASS | test_watchdog_heartbeat.mjs        | exit=0 |   … ms | RESULT: 53/53 checks passed
PASS | test_standby_lifecycle.mjs         | exit=0 |   … ms | RESULT: 130/130 checks passed
PASS | test_silent_lead_board_wake.mjs    | exit=0 |   … ms | RESULT: 151/151 checks passed
…
SUÍTES: 39/39 passaram
RESULT_ALL: ALL SUITES PASSED
```

---

## 4. Installation and configuration

```bash
git clone git@github.com:maiteuxzanela/ensemble-room-lowcost.git
cd ensemble-room-lowcost
npm run check && npm test
```

Reference it from your OpenCode config:

```jsonc
{
  "plugin": ["@maiteuxzanela/ensemble-room-lowcost"]
}
```

### `ensemble.json` flags (`src/config.ts`)

| Flag | Default | Effect |
|---|---|---|
| `silentLead` | `true` | Lead at rest: delivery via SQLite/system prompt, no `promptAsync`; wake only on board closure |
| `stallThresholdMs` | `300000` | Watchdog TTL; `0` disables the TTL (worktree GC continues) |
| `stallMinSteps` | `5` | Minimum number of steps before a stall is considered |
| `stallTokenThreshold` | `200` | Token-progress threshold used by the stall heuristic |
| `dashboardPort` | `4747` | HTTP dashboard (`0` disables) |
| `fallbackModels` | `[]` | Ordered fallback chain; empty falls back to the built-in cheap default |
| `fallbackModelsByAgent` | `{}` | Per-agent override of the fallback chain (base-persona symmetry) |
| `modelFallback` | — | Legacy single-entry fallback (`{ model, variant? }`) |

Example — a two-step fallback chain:

```jsonc
{
  "silentLead": true,
  "fallbackModels": ["provider-a/model-x#low", "provider-b/model-y#low"],
  "fallbackModelsByAgent": {
    "reviewer": ["provider-c/model-z#low"]
  }
}
```

Spawn a teammate in standby (no init prompt, zero tokens):

```text
team_spawn({ name: "worker-a", agent: "build", prompt: "…", claim_task: "<id>", standby: true })
```

Hand over an in-progress card to a complementary specialist (sequential bench partnership):

```text
team_task_handover({ task_id: "<id>", to: "specialist-b", notes: "frontend done; backend left" })
```

---

## 5. Provenance

- Base source: the upstream `@hueyexe/opencode-ensemble@0.18.0` package (`src/`, `dist/`, `package.json`, `LICENSE`, `social-preview.png`), already carrying the hardened improvements.
- The published npm tarball did **not** include `tsconfig.json`; the file versioned here was recovered from the upstream repository `github.com/hueyexe/opencode-ensemble` (unchanged compiler settings).
- `package.json` was rewritten only in `name`, `version`, `description`, `repository`, `keywords`, `files` and `scripts` (`test`, `check`, `typecheck`, `build`); dependencies and `exports` remain equivalent to upstream.
- Known debt: `engines.node >= 24` was inherited from upstream, while the suites run with the host Node (native type-stripping) — no impact on the plugin runtime, which is the `dist/index.js` bundle.

---

## 6. Governance

- **Strict prohibition of mocks** in production and tests (fail-fast): an unavailable dependency becomes a reported blocker, never a stub.
- **No polling**: the lead wake is strictly event-driven (board closure); monitoring is passive via the dashboard and task board.
- **Homologation**: every delivery passes through `node --check dist/index.js` + `node tests/run_all.mjs` before any commit.
- **Local commits only**: commits are created locally and atomically by the runtime on a reviewer/admin verdict; pushing to the remote is a separate, deliberately gated step.

MIT © [maiteuxzanela](https://github.com/maiteuxzanela) — derived from `@hueyexe/opencode-ensemble` (MIT).
