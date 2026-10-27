import type { Database } from "./db"

/** Migration SQL statements, applied in order. Version = index + 1. */
export const MIGRATIONS: string[] = [
  // Migration 1: Initial schema — 4 tables
  `
  CREATE TABLE IF NOT EXISTS team (
    id              TEXT PRIMARY KEY,
    name            TEXT NOT NULL UNIQUE,
    lead_session_id TEXT NOT NULL,
    status          TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active', 'archived')),
    delegate        INTEGER NOT NULL DEFAULT 0,
    time_created    INTEGER NOT NULL,
    time_updated    INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS team_lead_idx ON team(lead_session_id);
  CREATE INDEX IF NOT EXISTS team_status_idx ON team(status);

  CREATE TABLE IF NOT EXISTS team_member (
    team_id          TEXT NOT NULL REFERENCES team(id) ON DELETE CASCADE,
    name             TEXT NOT NULL,
    session_id       TEXT NOT NULL,
    agent            TEXT NOT NULL,
    status           TEXT NOT NULL DEFAULT 'ready'
                       CHECK(status IN ('ready', 'busy', 'shutdown_requested', 'shutdown', 'error')),
    execution_status TEXT NOT NULL DEFAULT 'idle'
                       CHECK(execution_status IN ('idle', 'starting', 'running',
                         'cancel_requested', 'cancelling', 'cancelled',
                         'completing', 'completed', 'failed', 'timed_out')),
    model            TEXT,
    prompt           TEXT,
    time_created     INTEGER NOT NULL,
    time_updated     INTEGER NOT NULL,
    PRIMARY KEY (team_id, name)
  );
  CREATE INDEX IF NOT EXISTS team_member_session_idx ON team_member(session_id);
  CREATE INDEX IF NOT EXISTS team_member_status_idx ON team_member(team_id, status);

  CREATE TABLE IF NOT EXISTS team_task (
    id            TEXT PRIMARY KEY,
    team_id       TEXT NOT NULL REFERENCES team(id) ON DELETE CASCADE,
    content       TEXT NOT NULL,
    status        TEXT NOT NULL DEFAULT 'pending'
                    CHECK(status IN ('pending', 'in_progress', 'completed', 'cancelled', 'blocked')),
    priority      TEXT NOT NULL DEFAULT 'medium'
                    CHECK(priority IN ('high', 'medium', 'low')),
    assignee      TEXT,
    depends_on    TEXT,
    time_created  INTEGER NOT NULL,
    time_updated  INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS team_task_team_idx ON team_task(team_id);
  CREATE INDEX IF NOT EXISTS team_task_assignee_idx ON team_task(assignee);
  CREATE INDEX IF NOT EXISTS team_task_status_idx ON team_task(team_id, status);

  CREATE TABLE IF NOT EXISTS team_message (
    id            TEXT PRIMARY KEY,
    team_id       TEXT NOT NULL REFERENCES team(id) ON DELETE CASCADE,
    from_name     TEXT NOT NULL,
    to_name       TEXT,
    content       TEXT NOT NULL,
    delivered     INTEGER NOT NULL DEFAULT 0,
    time_created  INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS team_message_team_idx ON team_message(team_id);
  CREATE INDEX IF NOT EXISTS team_message_to_idx ON team_message(to_name);
  CREATE INDEX IF NOT EXISTS team_message_undelivered_idx ON team_message(team_id, delivered)
    WHERE delivered = 0;
  `,
  // Migration 2: Add read column to team_message for team_results tracking
  `ALTER TABLE team_message ADD COLUMN read INTEGER NOT NULL DEFAULT 0;
   CREATE INDEX IF NOT EXISTS team_message_unread_idx ON team_message(team_id, read) WHERE read = 0;`,
  // Migration 3: Add worktree columns to team_member for git worktree isolation
  `ALTER TABLE team_member ADD COLUMN worktree_dir TEXT;
   ALTER TABLE team_member ADD COLUMN worktree_branch TEXT;`,
  // Migration 4: Add plan_approval column to team_member for plan-before-build workflow
  `ALTER TABLE team_member ADD COLUMN plan_approval TEXT NOT NULL DEFAULT 'none'
     CHECK(plan_approval IN ('none', 'pending', 'approved', 'rejected'));`,
  // Migration 5: Track lead's agent mode so message delivery preserves it
  `ALTER TABLE team ADD COLUMN lead_agent TEXT;`,
  // Migration 6: Track workspace ID for worktree-session binding
  `ALTER TABLE team_member ADD COLUMN workspace_id TEXT;`,
  // Migration 7: Track whether teammate has reported to lead (completion loop prevention, issue #3)
  `ALTER TABLE team_member ADD COLUMN reported_to_lead INTEGER NOT NULL DEFAULT 0;`,
  // Migration 8: Add project as the dashboard grouping level. For this initial
  // project-first step, project_id is the team lead's working directory.
  `PRAGMA foreign_keys=OFF;
   ALTER TABLE team RENAME TO team_old_m8;
   CREATE TABLE IF NOT EXISTS project (
     id              TEXT PRIMARY KEY,
     name            TEXT NOT NULL,
     path            TEXT NOT NULL,
     status          TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active', 'archived')),
     time_created    INTEGER NOT NULL,
     time_updated    INTEGER NOT NULL
   );
   INSERT OR IGNORE INTO project (id, name, path, status, time_created, time_updated)
     VALUES ('default', 'Default Project', '', 'active', strftime('%s','now') * 1000, strftime('%s','now') * 1000);
   CREATE TABLE team (
     id              TEXT PRIMARY KEY,
     name            TEXT NOT NULL,
     project_id      TEXT NOT NULL DEFAULT 'default' REFERENCES project(id) ON DELETE CASCADE,
     lead_session_id TEXT NOT NULL,
     status          TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active', 'archived')),
     delegate        INTEGER NOT NULL DEFAULT 0,
     time_created    INTEGER NOT NULL,
     time_updated    INTEGER NOT NULL,
     lead_agent      TEXT
   );
   INSERT INTO team (id, name, project_id, lead_session_id, status, delegate, time_created, time_updated, lead_agent)
     SELECT id, name, 'default', lead_session_id, status, delegate, time_created, time_updated, lead_agent FROM team_old_m8;
   DROP TABLE team_old_m8;

   ALTER TABLE team_member RENAME TO team_member_old_m8;
   CREATE TABLE team_member (
     team_id          TEXT NOT NULL REFERENCES team(id) ON DELETE CASCADE,
     name             TEXT NOT NULL,
     session_id       TEXT NOT NULL,
     agent            TEXT NOT NULL,
     status           TEXT NOT NULL DEFAULT 'ready'
                        CHECK(status IN ('ready', 'busy', 'shutdown_requested', 'shutdown', 'error')),
     execution_status TEXT NOT NULL DEFAULT 'idle'
                        CHECK(execution_status IN ('idle', 'starting', 'running',
                          'cancel_requested', 'cancelling', 'cancelled',
                          'completing', 'completed', 'failed', 'timed_out')),
     model            TEXT,
     prompt           TEXT,
     time_created     INTEGER NOT NULL,
     time_updated     INTEGER NOT NULL,
     worktree_dir     TEXT,
     worktree_branch  TEXT,
     plan_approval    TEXT NOT NULL DEFAULT 'none'
                        CHECK(plan_approval IN ('none', 'pending', 'approved', 'rejected')),
     workspace_id     TEXT,
     reported_to_lead INTEGER NOT NULL DEFAULT 0,
     PRIMARY KEY (team_id, name)
   );
   INSERT INTO team_member (team_id, name, session_id, agent, status, execution_status, model, prompt, time_created, time_updated, worktree_dir, worktree_branch, plan_approval, workspace_id, reported_to_lead)
     SELECT team_id, name, session_id, agent, status, execution_status, model, prompt, time_created, time_updated, worktree_dir, worktree_branch, plan_approval, workspace_id, reported_to_lead FROM team_member_old_m8;
   DROP TABLE team_member_old_m8;

   ALTER TABLE team_task RENAME TO team_task_old_m8;
   CREATE TABLE team_task (
     id            TEXT PRIMARY KEY,
     team_id       TEXT NOT NULL REFERENCES team(id) ON DELETE CASCADE,
     content       TEXT NOT NULL,
     status        TEXT NOT NULL DEFAULT 'pending'
                     CHECK(status IN ('pending', 'in_progress', 'completed', 'cancelled', 'blocked')),
     priority      TEXT NOT NULL DEFAULT 'medium'
                     CHECK(priority IN ('high', 'medium', 'low')),
     assignee      TEXT,
     depends_on    TEXT,
     time_created  INTEGER NOT NULL,
     time_updated  INTEGER NOT NULL
   );
   INSERT INTO team_task (id, team_id, content, status, priority, assignee, depends_on, time_created, time_updated)
     SELECT id, team_id, content, status, priority, assignee, depends_on, time_created, time_updated FROM team_task_old_m8;
   DROP TABLE team_task_old_m8;

   ALTER TABLE team_message RENAME TO team_message_old_m8;
   CREATE TABLE team_message (
     id            TEXT PRIMARY KEY,
     team_id       TEXT NOT NULL REFERENCES team(id) ON DELETE CASCADE,
     from_name     TEXT NOT NULL,
     to_name       TEXT,
     content       TEXT NOT NULL,
     delivered     INTEGER NOT NULL DEFAULT 0,
     time_created  INTEGER NOT NULL,
     read          INTEGER NOT NULL DEFAULT 0
   );
   INSERT INTO team_message (id, team_id, from_name, to_name, content, delivered, time_created, read)
     SELECT id, team_id, from_name, to_name, content, delivered, time_created, read FROM team_message_old_m8;
   DROP TABLE team_message_old_m8;

   CREATE INDEX IF NOT EXISTS team_lead_idx ON team(lead_session_id);
   CREATE INDEX IF NOT EXISTS team_status_idx ON team(status);
   CREATE INDEX IF NOT EXISTS team_project_idx ON team(project_id, status);
   CREATE UNIQUE INDEX IF NOT EXISTS team_active_project_name_idx ON team(project_id, name) WHERE status = 'active';
   CREATE INDEX IF NOT EXISTS team_member_session_idx ON team_member(session_id);
   CREATE INDEX IF NOT EXISTS team_member_status_idx ON team_member(team_id, status);
   CREATE INDEX IF NOT EXISTS team_task_team_idx ON team_task(team_id);
   CREATE INDEX IF NOT EXISTS team_task_assignee_idx ON team_task(assignee);
   CREATE INDEX IF NOT EXISTS team_task_status_idx ON team_task(team_id, status);
   CREATE INDEX IF NOT EXISTS team_message_team_idx ON team_message(team_id);
   CREATE INDEX IF NOT EXISTS team_message_to_idx ON team_message(to_name);
   CREATE INDEX IF NOT EXISTS team_message_undelivered_idx ON team_message(team_id, delivered) WHERE delivered = 0;
   CREATE INDEX IF NOT EXISTS team_message_unread_idx ON team_message(team_id, read) WHERE read = 0;
   PRAGMA foreign_keys=ON;`,
  // Migration 9: Add last_nudged_at to team_member — additive-only display-staleness
  // signal for the watchdog's soft stall-nudge path. Deliberately NOT a new status
  // enum value (see checkStalled() in watchdog.ts for the rationale): a 6th CHECK
  // constraint literal would require a table-rebuild migration and touch every
  // consumer that switches on the 5 known status strings. This column is additive —
  // existing consumers that don't know about it simply don't render it.
  `ALTER TABLE team_member ADD COLUMN last_nudged_at INTEGER;`,
  // Migration 10: Add retry_* columns to team_member — additive-only provider-retry
  // display signal (see hooks.ts's "retry" branch). Same non-negotiable as Migration
  // 9: no 6th status/execution_status literal, no table rebuild. retry_until is a
  // TTL, not a stored enum — "currently retrying" is derived at read time
  // (retry_until > Date.now()), so there is no explicit clear-write anywhere in this
  // fix; it simply becomes stale and gets superseded by real activity or by time
  // elapsing.
  `ALTER TABLE team_member ADD COLUMN retry_until INTEGER;
   ALTER TABLE team_member ADD COLUMN retry_attempt INTEGER;
   ALTER TABLE team_member ADD COLUMN retry_provider TEXT;
   ALTER TABLE team_member ADD COLUMN retry_message TEXT;`,
  // Migration 11: Add spawn_context column to team_member for standby agents
  `ALTER TABLE team_member ADD COLUMN spawn_context TEXT;`,
  // Migration 12: add the 'standby' literal to team_member.execution_status's
  // CHECK constraint. SQLite cannot ALTER a CHECK in place, so this rebuilds the
  // table exactly the way Migration 8 did (rename → create → copy → drop),
  // carrying over every column added by Migrations 3-11 (worktree_*,
  // plan_approval, workspace_id, reported_to_lead, last_nudged_at, retry_*,
  // spawn_context) and recreating the two indexes that die with the old table.
  // Without this, a database built fresh from Migrations 1-11 rejects the
  // standby INSERT with a CHECK constraint error (the live DB predates this
  // migration and already carries the literal out-of-band).
  `ALTER TABLE team_member RENAME TO team_member_old_m12;
   CREATE TABLE IF NOT EXISTS team_member (
     team_id          TEXT NOT NULL REFERENCES team(id) ON DELETE CASCADE,
     name             TEXT NOT NULL,
     session_id       TEXT NOT NULL,
     agent            TEXT NOT NULL,
     status           TEXT NOT NULL DEFAULT 'ready'
                        CHECK(status IN ('ready', 'busy', 'shutdown_requested', 'shutdown', 'error')),
     execution_status TEXT NOT NULL DEFAULT 'idle'
                        CHECK(execution_status IN ('idle', 'starting', 'running',
                          'cancel_requested', 'cancelling', 'cancelled',
                          'completing', 'completed', 'failed', 'timed_out',
                          'standby')),
     model            TEXT,
     prompt           TEXT,
     time_created     INTEGER NOT NULL,
     time_updated     INTEGER NOT NULL,
     worktree_dir     TEXT,
     worktree_branch  TEXT,
     plan_approval    TEXT NOT NULL DEFAULT 'none'
                        CHECK(plan_approval IN ('none', 'pending', 'approved', 'rejected')),
     workspace_id     TEXT,
     reported_to_lead INTEGER NOT NULL DEFAULT 0,
     last_nudged_at   INTEGER,
     retry_until      INTEGER,
     retry_attempt    INTEGER,
     retry_provider   TEXT,
     retry_message    TEXT,
     spawn_context    TEXT,
     PRIMARY KEY (team_id, name)
   );
   INSERT INTO team_member (team_id, name, session_id, agent, status, execution_status, model, prompt, time_created, time_updated, worktree_dir, worktree_branch, plan_approval, workspace_id, reported_to_lead, last_nudged_at, retry_until, retry_attempt, retry_provider, retry_message, spawn_context)
     SELECT team_id, name, session_id, agent, status, execution_status, model, prompt, time_created, time_updated, worktree_dir, worktree_branch, plan_approval, workspace_id, reported_to_lead, last_nudged_at, retry_until, retry_attempt, retry_provider, retry_message, spawn_context FROM team_member_old_m12;
   DROP TABLE team_member_old_m12;
   CREATE INDEX IF NOT EXISTS team_member_session_idx ON team_member(session_id);
   CREATE INDEX IF NOT EXISTS team_member_status_idx ON team_member(team_id, status);`,
  // Migration 13: add 'in_review' to team_task status CHECK constraint and
  // add rejection_count and review_notes columns. Rebuilds team_task exactly
  // like Migrations 8 and 12 (rename → create → copy → drop) to update the CHECK
  // constraint in SQLite, carrying over all existing rows and recreating the
  // three indexes.
  `ALTER TABLE team_task RENAME TO team_task_old_m13;
   CREATE TABLE IF NOT EXISTS team_task (
     id              TEXT PRIMARY KEY,
     team_id         TEXT NOT NULL REFERENCES team(id) ON DELETE CASCADE,
     content         TEXT NOT NULL,
     status          TEXT NOT NULL DEFAULT 'pending'
                       CHECK(status IN ('pending', 'in_progress', 'in_review', 'completed', 'cancelled', 'blocked')),
     priority        TEXT NOT NULL DEFAULT 'medium'
                       CHECK(priority IN ('high', 'medium', 'low')),
     assignee        TEXT,
     depends_on      TEXT,
     time_created    INTEGER NOT NULL,
     time_updated    INTEGER NOT NULL,
     rejection_count INTEGER NOT NULL DEFAULT 0,
     review_notes    TEXT
   );
   INSERT INTO team_task (id, team_id, content, status, priority, assignee, depends_on, time_created, time_updated, rejection_count, review_notes)
     SELECT id, team_id, content, status, priority, assignee, depends_on, time_created, time_updated, 0, NULL FROM team_task_old_m13;
   DROP TABLE team_task_old_m13;
   CREATE INDEX IF NOT EXISTS team_task_team_idx ON team_task(team_id);
   CREATE INDEX IF NOT EXISTS team_task_assignee_idx ON team_task(assignee);
   CREATE INDEX IF NOT EXISTS team_task_status_idx ON team_task(team_id, status);`,
  // Migration 14: add is_qa flag to team_member — marks the Quality Gate
  // reviewer (Clara) explicitly. Additive-only (same non-negotiable as Migrations
  // 9-11): no CHECK constraint, no table rebuild. The central helpers in
  // src/qa-role.ts (isQAMember / getTeamQAMember) read this column first and
  // fall back to the legacy base-persona/agent === 'clara' detection, so
  // existing databases and consumers keep working unchanged.
  `ALTER TABLE team_member ADD COLUMN is_qa INTEGER NOT NULL DEFAULT 0;`,
  // Migration 15 (HARNESS-22): pending-lead-decision state on the team. A member
  // raises an emergency decision via the `decision_lead` tool; the flag is set so
  // the room-inactivity watchdog PAUSES Clara's autoawake until the lead
  // deliberates (team_message from the lead clears it). Additive-only — the same
  // non-negotiable as Migrations 9-11/14: no CHECK constraint, no table rebuild.
  // `awaiting_decision_member` records WHO is waiting on the decision and
  // `awaiting_decision_at` the raise timestamp, purely for observability.
  `ALTER TABLE team ADD COLUMN awaiting_lead_decision INTEGER NOT NULL DEFAULT 0;
   ALTER TABLE team ADD COLUMN awaiting_decision_member TEXT;
   ALTER TABLE team ADD COLUMN awaiting_decision_at INTEGER;`,
  // Migration 16 (TICKET-HARNESS-23): explicit role designation on team_member.
  // 'sdet' marks the deterministic-test engineer (Hugo) — the Quality Gate
  // reviewer remains covered exclusively by is_qa (Migration 14). Additive-only
  // (same non-negotiable as Migrations 9-11/14/15): nullable TEXT, no CHECK
  // constraint, no table rebuild. The central helpers in src/qa-role.ts
  // (isSDETMEmber / getTeamSDETMember) read this column first and fall back to
  // agent / base-persona === 'hugo' detection, so existing databases and rows
  // created before this migration keep working unchanged.
  `ALTER TABLE team_member ADD COLUMN role TEXT;`,
  // Migration 17 (TICKET-HARNESS-32A): atomic per-room modified-file ledger.
  //
  // Each row is one file the room (any member session, or the lead session)
  // touched via a file-mutating tool (edit/write/patch/multiedit/...). The
  // ledger is the source of truth that replaces the old blind `git add -A`
  // in the Portão 1 auto-commit: on QA/lead `complete`, the runtime commits a
  // repository ONLY with the exact files this room registered under it —
  // never a repo-wide sweep. A sibling repo with zero registered files is
  // NEVER committed, so unrelated working trees living next to the room dir
  // stay untouched (the Maiteux/lead directive: do not block sibling repos,
  // but never commit what the room did not touch).
  //
  // PRIMARY KEY (team_id, file_path) makes the ledger idempotent: re-editing
  // the same file UPDATEs time_created in place (see recordModifiedFile).
  // file_path stores the NORMALIZED ABSOLUTE path (path.resolve + separators
  // unified) so the commit filter can prefix-match against each discovered
  // repo root without ambiguity. FK cascade: deleting a team purges its ledger.
  //
  // Additive-only (same non-negotiable as Migrations 9-11/14/15/16): brand-new
  // table, no CHECK constraint, no rebuild of existing tables.
  `CREATE TABLE IF NOT EXISTS team_modified_file (
     team_id      TEXT NOT NULL REFERENCES team(id) ON DELETE CASCADE,
     file_path    TEXT NOT NULL,
     time_created INTEGER NOT NULL,
     PRIMARY KEY (team_id, file_path)
   );
   CREATE INDEX IF NOT EXISTS team_modified_file_team_idx ON team_modified_file(team_id);`,
  // Migration 18 (TICKET-HARNESS-37 / M4): per-member lead-decision queue.
  //
  // Migration 15 tracked at most ONE waiting member per team: every new
  // decision_lead overwrote `awaiting_decision_member`, and the lead's reply
  // cleared the whole flag — so with two members waiting on the lead, replying
  // to one silently unpaused the watchdog AND dropped the other's pending
  // decision. `awaiting_decision_members` holds a JSON array of
  // `{ member, at, payload }` entries (one per waiting member) so the pause is
  // lifted ONLY when no member is left pending. The legacy
  // `awaiting_decision_member` / `awaiting_decision_at` columns stay in sync
  // (latest raise) for observability and backward compatibility. Additive-only
  // (same non-negotiable as Migrations 9-11/14/15/16/17): nullable TEXT, no
  // CHECK constraint, no table rebuild.
  `ALTER TABLE team ADD COLUMN awaiting_decision_members TEXT;`,
  // Migration 19 (TICKET-HARNESS-51): definitive purge of the dependency/DAG
  // mechanism from the task board. SQLite cannot drop a column nor ALTER a
  // CHECK constraint in place, so this rebuilds team_task exactly like
  // Migrations 8/12/13 (rename → create → copy → drop):
  //   - drops the `depends_on` column entirely;
  //   - removes 'blocked' from the status CHECK constraint;
  //   - maps any legacy 'blocked' row to 'pending' (assignee preserved) so a
  //     pre-existing database never violates the new constraint and the
  //     migration transaction never rolls back.
  // Recreates the three indexes that die with the old table. The board is now a
  // flat, fully-parallel pool: every task is born 'pending' and claimable.
  `ALTER TABLE team_task RENAME TO team_task_old_m19;
   CREATE TABLE IF NOT EXISTS team_task (
     id              TEXT PRIMARY KEY,
     team_id         TEXT NOT NULL REFERENCES team(id) ON DELETE CASCADE,
     content         TEXT NOT NULL,
     status          TEXT NOT NULL DEFAULT 'pending'
                       CHECK(status IN ('pending', 'in_progress', 'in_review', 'completed', 'cancelled')),
     priority        TEXT NOT NULL DEFAULT 'medium'
                       CHECK(priority IN ('high', 'medium', 'low')),
     assignee        TEXT,
     time_created    INTEGER NOT NULL,
     time_updated    INTEGER NOT NULL,
     rejection_count INTEGER NOT NULL DEFAULT 0,
     review_notes    TEXT
   );
   INSERT INTO team_task (id, team_id, content, status, priority, assignee, time_created, time_updated, rejection_count, review_notes)
     SELECT id, team_id, content,
            CASE WHEN status = 'blocked' THEN 'pending' ELSE status END,
            priority, assignee, time_created, time_updated, rejection_count, review_notes
     FROM team_task_old_m19;
    DROP TABLE team_task_old_m19;
   CREATE INDEX IF NOT EXISTS team_task_team_idx ON team_task(team_id);
   CREATE INDEX IF NOT EXISTS team_task_assignee_idx ON team_task(assignee);
   CREATE INDEX IF NOT EXISTS team_task_status_idx ON team_task(team_id, status);`,
  // Migration 20 (TICKET-RELEASE-11, Frente A): add the 'throttled' literal to
  // team_member.status's CHECK constraint — the visible "blocked by paywall /
  // long rate-limit" state. SQLite cannot ALTER a CHECK in place, so this
  // rebuilds the table exactly the way Migrations 8/12/13/19 did (rename →
  // create → copy → drop), carrying over every column added by Migrations
  // 3-16 (worktree_*, plan_approval, workspace_id, reported_to_lead,
  // last_nudged_at, retry_*, spawn_context, is_qa, role) and recreating the
  // two indexes that die with the old table. Nudges already key on
  // `status = 'ready'`, so a throttled member is naturally suppressed from
  // shouldNudgeIdleMember / shouldNudgeInReviewTasks; the busy branch of
  // handleSessionStatusEvent learns to release 'throttled' when the provider
  // unblocks (a successful retry turns the session busy again).
  `ALTER TABLE team_member RENAME TO team_member_old_m20;
   CREATE TABLE IF NOT EXISTS team_member (
     team_id          TEXT NOT NULL REFERENCES team(id) ON DELETE CASCADE,
     name             TEXT NOT NULL,
     session_id       TEXT NOT NULL,
     agent            TEXT NOT NULL,
     status           TEXT NOT NULL DEFAULT 'ready'
                        CHECK(status IN ('ready', 'busy', 'shutdown_requested', 'shutdown', 'error', 'throttled')),
     execution_status TEXT NOT NULL DEFAULT 'idle'
                        CHECK(execution_status IN ('idle', 'starting', 'running',
                          'cancel_requested', 'cancelling', 'cancelled',
                          'completing', 'completed', 'failed', 'timed_out',
                          'standby')),
     model            TEXT,
     prompt           TEXT,
     time_created     INTEGER NOT NULL,
     time_updated     INTEGER NOT NULL,
     worktree_dir     TEXT,
     worktree_branch  TEXT,
     plan_approval    TEXT NOT NULL DEFAULT 'none'
                        CHECK(plan_approval IN ('none', 'pending', 'approved', 'rejected')),
     workspace_id     TEXT,
     reported_to_lead INTEGER NOT NULL DEFAULT 0,
     last_nudged_at   INTEGER,
     retry_until      INTEGER,
     retry_attempt    INTEGER,
     retry_provider   TEXT,
     retry_message    TEXT,
     spawn_context    TEXT,
     is_qa            INTEGER NOT NULL DEFAULT 0,
     role             TEXT,
     PRIMARY KEY (team_id, name)
   );
   INSERT INTO team_member (team_id, name, session_id, agent, status, execution_status, model, prompt, time_created, time_updated, worktree_dir, worktree_branch, plan_approval, workspace_id, reported_to_lead, last_nudged_at, retry_until, retry_attempt, retry_provider, retry_message, spawn_context, is_qa, role)
     SELECT team_id, name, session_id, agent, status, execution_status, model, prompt, time_created, time_updated, worktree_dir, worktree_branch, plan_approval, workspace_id, reported_to_lead, last_nudged_at, retry_until, retry_attempt, retry_provider, retry_message, spawn_context, is_qa, role FROM team_member_old_m20;
   DROP TABLE team_member_old_m20;
    CREATE INDEX IF NOT EXISTS team_member_session_idx ON team_member(session_id);
    CREATE INDEX IF NOT EXISTS team_member_status_idx ON team_member(team_id, status);`,
  // Migration 21 (TICKET-HARNESS-82 / TICKET-HARNESS-87 Item 3): partition the
  // room's modified-file ledger PER CARD. `task_id` binds a recorded file to the
  // card that was being worked on when the edit happened, so the Portão 1
  // auto-commit of one approved card no longer sweeps the files of sibling
  // cards that are still in progress.
  //
  // NULLABILITY IS INTENTIONAL (retrocompatibilidade): existing rows and every
  // edit made with no unambiguous task context (lead edits, tool calls outside
  // a card) keep `task_id = NULL`. `autoCommitApprovedTask` treats those rows as
  // the safe fallback when the completed card has no file of its own, so a
  // legitimate edit is never orphaned.
  //
  // Additive-only (same non-negotiable as Migrations 9-11/14/15/16/17/18):
  // nullable TEXT column on the existing table, no CHECK constraint, no rebuild
  // of team_modified_file (its PRIMARY KEY (team_id, file_path) is preserved —
  // re-editing the same file refreshes the row in place and the latest
  // non-NULL task binding wins, see recordModifiedFile).
  `ALTER TABLE team_modified_file ADD COLUMN task_id TEXT;
   CREATE INDEX IF NOT EXISTS team_modified_file_task_idx ON team_modified_file(team_id, task_id);`,
]

/**
 * Apply pending migrations to the database.
 * Uses PRAGMA user_version to track which migrations have been applied.
 */
export function applyMigrations(db: Database): void {
  const { user_version: current } = db.query("PRAGMA user_version").get() as { user_version: number }

  if (current > MIGRATIONS.length) {
    throw new Error(`Database schema version ${current} is newer than this plugin supports (${MIGRATIONS.length}). Upgrade opencode-ensemble before continuing.`)
  }

  for (let i = current; i < MIGRATIONS.length; i++) {
    const migration = MIGRATIONS[i]
    const { foreign_keys: foreignKeys } = db.query("PRAGMA foreign_keys").get() as { foreign_keys: number }

    db.exec("PRAGMA foreign_keys = OFF")
    db.exec("BEGIN IMMEDIATE")
    try {
      if (migration) db.exec(migration)
      db.exec(`PRAGMA user_version = ${i + 1}`)
      db.exec("COMMIT")
    } catch (err) {
      db.exec("ROLLBACK")
      throw err
    } finally {
      db.exec(`PRAGMA foreign_keys = ${foreignKeys ? "ON" : "OFF"}`)
    }
  }
}
