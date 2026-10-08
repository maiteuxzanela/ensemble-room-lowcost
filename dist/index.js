var __defProp = Object.defineProperty;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __esm = (fn, res, err) => function __init() {
  if (err) throw err[0];
  try {
    return fn && (res = (0, fn[__getOwnPropNames(fn)[0]])(fn = 0)), res;
  } catch (e) {
    throw err = [e], e;
  }
};
var __export = (target, all) => {
  for (var name in all)
    __defProp(target, name, { get: all[name], enumerable: true });
};

// src/log.ts
function initLog(client) {
  _client = client;
}
function log(msg) {
  if (!_client) return;
  _client.app.log({ service: "ensemble", level: "info", message: msg }).catch(() => {
  });
}
function vlog(msg) {
  console.log(`[ensemble] ${msg}`);
}
var _client;
var init_log = __esm({
  "src/log.ts"() {
    "use strict";
    _client = null;
  }
});

// src/process.ts
import { Buffer as Buffer2 } from "node:buffer";
import { spawn } from "node:child_process";
function collect(stream, chunks) {
  stream?.on("data", (chunk) => {
    chunks.push(Buffer2.isBuffer(chunk) ? chunk : Buffer2.from(chunk));
  });
}
function runCommand(args, options = {}) {
  const [command, ...commandArgs] = args;
  if (!command) return Promise.resolve({ exitCode: 1, stdout: "", stderr: "No command provided" });
  return new Promise((resolve) => {
    const stdout = [];
    const stderr = [];
    let settled = false;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      resolve(result);
    };
    const child = spawn(command, commandArgs, {
      cwd: options.cwd,
      stdio: ["ignore", "pipe", "pipe"]
    });
    collect(child.stdout, stdout);
    collect(child.stderr, stderr);
    child.on("error", (error) => {
      finish({ exitCode: 1, stdout: Buffer2.concat(stdout).toString("utf8"), stderr: error.message });
    });
    child.on("close", (code) => {
      finish({
        exitCode: code ?? 1,
        stdout: Buffer2.concat(stdout).toString("utf8"),
        stderr: Buffer2.concat(stderr).toString("utf8")
      });
    });
  });
}
var init_process = __esm({
  "src/process.ts"() {
    "use strict";
  }
});

// src/tools/merge-helper.ts
var merge_helper_exports = {};
__export(merge_helper_exports, {
  deleteBranch: () => deleteBranch,
  getOverlappingFiles: () => getOverlappingFiles,
  getTeamResourceParts: () => getTeamResourceParts,
  gitReset: () => gitReset,
  mergeBranch: () => mergeBranch,
  mergeBranchRaw: () => mergeBranchRaw,
  preserveBranch: () => preserveBranch,
  preservedBranchName: () => preservedBranchName,
  teamResourceSegment: () => teamResourceSegment,
  teamResourceSlug: () => teamResourceSlug,
  teamWorktreeName: () => teamWorktreeName
});
function shortTeamId(teamId) {
  return (teamId.split("_").at(-1) || teamId).slice(0, 6);
}
function resourcePart(value) {
  const part = value.toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/^-+|-+$/g, "");
  return part || "unnamed";
}
function getTeamResourceParts(db, teamId) {
  const row = db.query(
    `SELECT t.id as team_id, t.name as team_name, p.name as project_name
     FROM team t
     JOIN project p ON t.project_id = p.id
     WHERE t.id = ?`
  ).get(teamId);
  if (!row) throw new Error(`Team not found: ${teamId}`);
  return { projectName: row.project_name, teamName: row.team_name, teamId: row.team_id };
}
function teamResourceSlug(projectName, teamName, teamId) {
  return `${resourcePart(projectName)}-${resourcePart(teamName)}#${shortTeamId(teamId)}`;
}
function teamResourceSegment(teamName, teamId) {
  return `${resourcePart(teamName)}#${shortTeamId(teamId)}`;
}
function teamWorktreeName(projectName, teamName, teamId, memberName) {
  return `ensemble-${teamResourceSlug(projectName, teamName, teamId)}-${memberName}`;
}
async function preserveBranch(sourceBranch, targetBranch, cwd) {
  const result = await runCommand(["git", "branch", targetBranch, sourceBranch], { cwd });
  if (result.exitCode !== 0) {
    log(`merge-helper:preserve:failed src=${sourceBranch} target=${targetBranch} err=${result.stderr.trim()}`);
    return false;
  }
  return true;
}
async function deleteBranch(branch, cwd) {
  const result = await runCommand(["git", "branch", "-D", branch], { cwd });
  if (result.exitCode !== 0) {
    log(`merge-helper:delete:failed branch=${branch}`);
    return false;
  }
  return true;
}
async function mergeBranchRaw(branch, cwd) {
  const result = await runCommand(["git", "merge", "--squash", branch], { cwd });
  if (result.exitCode !== 0) {
    const stderr = result.stderr.trim();
    log(`merge-helper:merge:conflict branch=${branch} err=${stderr}`);
    await runCommand(["git", "merge", "--abort"], { cwd });
    return { ok: false, error: stderr || `merge exited with code ${result.exitCode}` };
  }
  return { ok: true };
}
async function gitReset(cwd) {
  await runCommand(["git", "reset", "HEAD"], { cwd });
}
async function mergeBranch(branch, cwd) {
  const result = await mergeBranchRaw(branch, cwd);
  if (!result.ok) return result;
  await gitReset(cwd);
  return { ok: true };
}
async function getOverlappingFiles(branch, cwd) {
  const run = async (args) => {
    const result = await runCommand(["git", ...args], { cwd });
    if (result.exitCode !== 0) throw new Error(`git ${args.join(" ")} failed with exit code ${result.exitCode}`);
    return result.stdout.split("\n").filter(Boolean);
  };
  const agentFiles = new Set(await run(["diff", "--name-only", "HEAD", branch]));
  const localChanged = await run(["diff", "--name-only", "HEAD"]);
  const localUntracked = await run(["ls-files", "--others", "--exclude-standard"]);
  const localFiles = [.../* @__PURE__ */ new Set([...localChanged, ...localUntracked])];
  return localFiles.filter((f) => agentFiles.has(f));
}
function preservedBranchName(projectName, teamName, teamId, memberName) {
  return `ensemble/preserved/${resourcePart(projectName)}/${teamResourceSegment(teamName, teamId)}/${resourcePart(memberName)}`;
}
var init_merge_helper = __esm({
  "src/tools/merge-helper.ts"() {
    "use strict";
    init_log();
    init_process();
  }
});

// src/index.ts
import { Plugin as PluginV2 } from "@opencode/plugin";

// src/db.ts
import { createRequire } from "node:module";
import path from "node:path";

// src/schema.ts
var MIGRATIONS = [
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
   CREATE INDEX IF NOT EXISTS team_member_status_idx ON team_member(team_id, status);`
];
function applyMigrations(db) {
  const { user_version: current } = db.query("PRAGMA user_version").get();
  if (current > MIGRATIONS.length) {
    throw new Error(`Database schema version ${current} is newer than this plugin supports (${MIGRATIONS.length}). Upgrade opencode-ensemble before continuing.`);
  }
  for (let i = current; i < MIGRATIONS.length; i++) {
    const migration = MIGRATIONS[i];
    const { foreign_keys: foreignKeys } = db.query("PRAGMA foreign_keys").get();
    db.exec("PRAGMA foreign_keys = OFF");
    db.exec("BEGIN IMMEDIATE");
    try {
      if (migration) db.exec(migration);
      db.exec(`PRAGMA user_version = ${i + 1}`);
      db.exec("COMMIT");
    } catch (err) {
      db.exec("ROLLBACK");
      throw err;
    } finally {
      db.exec(`PRAGMA foreign_keys = ${foreignKeys ? "ON" : "OFF"}`);
    }
  }
}

// src/db.ts
var requireRuntimeModule = createRequire(import.meta.url);
var instance;
var NodeSqliteAdapter = class {
  db;
  constructor(filename) {
    const sqlite = requireRuntimeModule(["node", "sqlite"].join(":"));
    this.db = new sqlite.DatabaseSync(filename);
  }
  exec(sql) {
    this.db.exec(sql);
  }
  query(sql) {
    return this.db.prepare(sql);
  }
  run(sql, ...params) {
    const bindings = params.length === 1 && Array.isArray(params[0]) ? params[0] : params;
    return this.db.prepare(sql).run(...bindings);
  }
  transaction(fn) {
    return (...args) => {
      this.exec("BEGIN");
      try {
        const result = fn(...args);
        this.exec("COMMIT");
        return result;
      } catch (err) {
        this.exec("ROLLBACK");
        throw err;
      }
    };
  }
  close() {
    this.db.close();
  }
};
function openDatabase(filename) {
  if (typeof process.versions.bun === "string") {
    const sqlite = requireRuntimeModule(["bun", "sqlite"].join(":"));
    return new sqlite.Database(filename);
  }
  return new NodeSqliteAdapter(filename);
}
function getDbPath(env = process.env) {
  const home = env.HOME ?? env.USERPROFILE ?? "~";
  return path.join(home, ".config", "opencode", "ensemble.db");
}
function createDb(path5) {
  const db = openDatabase(path5);
  db.exec("PRAGMA journal_mode=WAL");
  db.exec("PRAGMA foreign_keys=ON");
  applyMigrations(db);
  instance = db;
  return db;
}

// src/state.ts
import { randomUUID } from "node:crypto";
var MemberRegistry = class {
  bySession = /* @__PURE__ */ new Map();
  byTeamName = /* @__PURE__ */ new Map();
  /** Register a member. */
  register(teamId, name, sessionId) {
    const entry = { teamId, memberName: name, sessionId };
    this.bySession.set(sessionId, entry);
    this.byTeamName.set(`${teamId}:${name}`, entry);
  }
  /** Look up a member by session ID. */
  getBySession(sessionId) {
    return this.bySession.get(sessionId);
  }
  /** Look up a member by team ID and name. */
  getByName(teamId, name) {
    return this.byTeamName.get(`${teamId}:${name}`);
  }
  /** List all members for a team. */
  listByTeam(teamId) {
    const result = [];
    for (const entry of this.bySession.values()) {
      if (entry.teamId === teamId) result.push(entry);
    }
    return result;
  }
  /** Remove a member by session ID. */
  unregister(sessionId) {
    const entry = this.bySession.get(sessionId);
    if (!entry) return;
    this.bySession.delete(sessionId);
    this.byTeamName.delete(`${entry.teamId}:${entry.memberName}`);
  }
  /** Remove all members for a team. */
  unregisterTeam(teamId) {
    for (const entry of this.listByTeam(teamId)) {
      this.bySession.delete(entry.sessionId);
      this.byTeamName.delete(`${teamId}:${entry.memberName}`);
    }
  }
  /** Check if a session ID belongs to a registered team member. */
  isTeamSession(sessionId) {
    return this.bySession.has(sessionId);
  }
  /** Get all registered session IDs. */
  allSessionIds() {
    return new Set(this.bySession.keys());
  }
};
var DEFAULT_MAX_DEPTH = 10;
var DEFAULT_PURGE_APPROVAL_TTL_MS = 10 * 60 * 1e3;
function canonicalPurgeKey(purge) {
  if (purge.includes("*")) return JSON.stringify(["*"]);
  return JSON.stringify([...new Set(purge)].sort());
}
function outputSelectedAnswer(output, label) {
  const quoted = JSON.stringify(label);
  return output.includes(`=${quoted}`) || output.includes(`=[${quoted}]`);
}
function optionLabels(args) {
  if (!args || typeof args !== "object") return [];
  const questions = args.questions;
  if (!Array.isArray(questions)) return [];
  return questions.flatMap((question) => {
    if (!question || typeof question !== "object") return [];
    const options = question.options;
    if (!Array.isArray(options)) return [];
    return options.flatMap((option) => {
      if (!option || typeof option !== "object") return [];
      const label = option.label;
      return typeof label === "string" ? [label] : [];
    });
  });
}
var DescendantTracker = class {
  parents = /* @__PURE__ */ new Map();
  /** Record that childId's parent is parentId. */
  track(childId, parentId) {
    this.parents.set(childId, parentId);
  }
  /** Get the parent of a session. */
  getParent(sessionId) {
    return this.parents.get(sessionId);
  }
  /**
   * Walk the parent chain from sessionId. Returns true if any ancestor
   * (up to maxDepth) is in the given set of session IDs.
   */
  isDescendantOf(sessionId, ancestors, maxDepth = DEFAULT_MAX_DEPTH) {
    let current = sessionId;
    for (let i = 0; i < maxDepth; i++) {
      const parent = this.parents.get(current);
      if (!parent) return false;
      if (ancestors.has(parent)) return true;
      current = parent;
    }
    return false;
  }
  /** Remove a session from tracking. */
  remove(sessionId) {
    this.parents.delete(sessionId);
  }
};
var PendingPurgeApprovals = class {
  pending = /* @__PURE__ */ new Map();
  ttlMs;
  now;
  createToken;
  constructor(ttlMs = DEFAULT_PURGE_APPROVAL_TTL_MS, now = () => Date.now(), createToken = randomUUID) {
    this.ttlMs = ttlMs;
    this.now = now;
    this.createToken = createToken;
  }
  /** Create a confirmation token for a purge preview. */
  create(sessionId, purge) {
    this.pruneExpired();
    const token = this.createToken();
    this.pending.set(token, {
      sessionId,
      purgeKey: canonicalPurgeKey(purge),
      approved: false,
      timeCreated: this.now()
    });
    return token;
  }
  /** Return the exact user-facing answer label that approves a confirmation token. */
  approvalLabel(token) {
    return `Approve purge ${token.slice(0, 8)}`;
  }
  /** Return the exact user-facing answer label that denies a confirmation token. */
  denialLabel(token) {
    return `Deny purge ${token.slice(0, 8)}`;
  }
  /** Record a question tool answer and approve only tokens whose exact approval label was selected. */
  recordQuestionAnswer(sessionId, output, args) {
    this.pruneExpired();
    const labels = new Set(optionLabels(args));
    for (const [token, approval] of this.pending.entries()) {
      const approvalLabel = this.approvalLabel(token);
      const denialLabel = this.denialLabel(token);
      const hasRequiredOptions = labels.has(approvalLabel) && labels.has(denialLabel);
      if (approval.sessionId === sessionId && hasRequiredOptions && outputSelectedAnswer(output, approvalLabel)) {
        approval.approved = true;
      }
    }
  }
  /** Consume a confirmation token once it is safe to execute the matching purge. */
  consume(sessionId, token, purge) {
    this.pruneExpired();
    const approval = this.pending.get(token);
    if (!approval || approval.sessionId !== sessionId || approval.purgeKey !== canonicalPurgeKey(purge)) {
      throw new Error("Purge confirmation token is invalid or expired.");
    }
    if (!approval.approved) {
      throw new Error("Purge was not approved by the user. Use the question tool with the exact approval option from the preview before confirming.");
    }
    this.pending.delete(token);
  }
  pruneExpired() {
    const cutoff = this.now() - this.ttlMs;
    for (const [token, approval] of this.pending.entries()) {
      if (approval.timeCreated < cutoff) this.pending.delete(token);
    }
  }
};

// src/util.ts
var NAME_PATTERN = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/;
var counter = 0;
function generateId(prefix) {
  const time = Date.now().toString(36);
  const count = (counter++).toString(36).padStart(4, "0");
  const rand = Math.random().toString(36).slice(2, 8);
  return `${prefix}_${time}_${count}_${rand}`;
}
function validateTeamName(name) {
  if (name.length < 1 || name.length > 64) return "Team name must be 1-64 characters";
  if (!NAME_PATTERN.test(name)) return "Team name must be lowercase alphanumeric with hyphens only";
  return void 0;
}
var PROJECT_ADJECTIVES = ["amber", "brave", "calm", "copper", "crisp", "dark", "ember", "frost", "quiet", "silver", "steady", "swift"];
var PROJECT_NOUNS = ["atlas", "beacon", "comet", "harbor", "lab", "orbit", "river", "signal", "sparrow", "summit", "vector", "voyage"];
function generateProjectName() {
  const adjective = PROJECT_ADJECTIVES[Math.floor(Math.random() * PROJECT_ADJECTIVES.length)] ?? "quiet";
  const noun = PROJECT_NOUNS[Math.floor(Math.random() * PROJECT_NOUNS.length)] ?? "project";
  return `${adjective}-${noun}`;
}
function validateProjectName(name) {
  if (name.length < 1 || name.length > 64) return "Project name must be 1-64 characters";
  if (!NAME_PATTERN.test(name)) return "Project name must be lowercase alphanumeric with hyphens only";
  return void 0;
}
function isWorktreeInstance(directory) {
  return directory.includes("/worktree/") && directory.includes("/ensemble-");
}
function validateMemberName(name) {
  if (name.toLowerCase() === "lead") return `Name "lead" is reserved`;
  if (name.length < 1 || name.length > 64) return "Member name must be 1-64 characters";
  if (!NAME_PATTERN.test(name)) return "Member name must be lowercase alphanumeric with hyphens only";
  return void 0;
}

// src/messaging.ts
var MAX_CONTENT_BYTES = 10 * 1024;
function sendMessage(db, input) {
  if (new TextEncoder().encode(input.content).length > MAX_CONTENT_BYTES) {
    throw new Error("Message content exceeds 10KB limit");
  }
  const id = generateId("msg");
  db.run(
    "INSERT INTO team_message (id, team_id, from_name, to_name, content, delivered, time_created) VALUES (?, ?, ?, ?, ?, 0, ?)",
    [id, input.teamId, input.from, input.to, input.content, Date.now()]
  );
  return id;
}
function broadcastMessage(db, input) {
  if (new TextEncoder().encode(input.content).length > MAX_CONTENT_BYTES) {
    throw new Error("Message content exceeds 10KB limit");
  }
  const id = generateId("msg");
  db.run(
    "INSERT INTO team_message (id, team_id, from_name, to_name, content, delivered, time_created) VALUES (?, ?, ?, NULL, ?, 0, ?)",
    [id, input.teamId, input.from, input.content, Date.now()]
  );
  return id;
}
function getUndeliveredMessages(db, teamId) {
  return db.query(
    "SELECT * FROM team_message WHERE team_id = ? AND delivered = 0 ORDER BY time_created ASC"
  ).all(teamId);
}
function markDelivered(db, messageId) {
  db.run("UPDATE team_message SET delivered = 1 WHERE id = ?", [messageId]);
}
function hasReportedCompletion(db, teamId, memberName) {
  const row = db.query(
    "SELECT reported_to_lead FROM team_member WHERE team_id = ? AND name = ?"
  ).get(teamId, memberName);
  return row?.reported_to_lead === 1;
}

// src/notify.ts
init_log();
var TOAST_CONFIG = {
  spawn: { variant: "success", duration: 3e3 },
  message: { variant: "info", duration: 3e3 },
  completed: { variant: "info", duration: 4e3 },
  error: { variant: "error", duration: 5e3 },
  shutdown: { variant: "info", duration: 3e3 }
};
function formatMessage(type, data) {
  switch (type) {
    case "spawn":
      return `Teammate ${data.memberName} spawned (${data.agent})`;
    case "message":
      return `Message from ${data.from}`;
    case "completed":
      return `${data.memberName} finished work`;
    case "error":
      return `${data.memberName} encountered an error`;
    case "shutdown":
      return `${data.memberName} shut down`;
  }
}
async function notifyTeamEvent(client, type, data) {
  const config = TOAST_CONFIG[type];
  try {
    await client.tui.showToast({
      title: "Team",
      message: formatMessage(type, data),
      variant: config.variant,
      duration: config.duration
    });
  } catch {
  }
}
async function notifyWorkingProgress(client, db, teamId) {
  const members = db.query(
    "SELECT name, status FROM team_member WHERE team_id = ? ORDER BY time_created ASC"
  ).all(teamId);
  if (members.length === 0) return;
  const busy = members.filter((m) => m.status === "busy");
  try {
    if (busy.length === 0) {
      await client.tui.showToast({
        title: "Team",
        message: "All teammates finished",
        variant: "success",
        duration: 4e3
      });
    } else {
      const names = busy.map((m) => m.name).join(", ");
      await client.tui.showToast({
        title: "Team",
        message: `Working: ${names} (${busy.length}/${members.length})`,
        variant: "info",
        duration: 5e3
      });
    }
  } catch {
  }
}
function notifyLead(client, db, teamId, content) {
  const id = sendMessage(db, { teamId, from: "system", to: "lead", content });
  const team = db.query("SELECT lead_session_id FROM team WHERE id = ?").get(teamId);
  if (!team?.lead_session_id) return id;
  client.session.promptAsync({
    sessionID: team.lead_session_id,
    parts: [{ type: "text", text: "[System: New team message from system]" }],
    synthetic: true
  }).catch((err) => {
    log(`notifyLead:wake:failed team=${teamId} err=${err instanceof Error ? err.message : String(err)}`);
  });
  return id;
}

// src/tasks.ts
function releaseMemberTasks(db, teamId, memberName) {
  const result = db.run(
    "UPDATE team_task SET status = 'pending', assignee = NULL, time_updated = ? WHERE team_id = ? AND assignee = ? AND status = 'in_progress'",
    [Date.now(), teamId, memberName]
  );
  return result.changes;
}

// src/types.ts
function findTeamBySession(db, registry, sessionId) {
  const entry = registry.getBySession(sessionId);
  if (entry) {
    const team = db.query("SELECT name FROM team WHERE id = ? AND status = 'active'").get(entry.teamId);
    if (team) return { teamId: entry.teamId, teamName: team.name, role: "member", memberName: entry.memberName };
  }
  if (!entry) {
    const memberRow = db.query(
      `SELECT tm.team_id, tm.name as member_name, t.name as team_name
       FROM team_member tm
       JOIN team t ON tm.team_id = t.id
       WHERE tm.session_id = ?
         AND t.status = 'active'
         AND tm.status NOT IN ('shutdown', 'error')`
    ).get(sessionId);
    if (memberRow) {
      registry.register(memberRow.team_id, memberRow.member_name, sessionId);
      return { teamId: memberRow.team_id, teamName: memberRow.team_name, role: "member", memberName: memberRow.member_name };
    }
  }
  const leadTeam = db.query("SELECT id, name FROM team WHERE lead_session_id = ? AND status = 'active'").get(sessionId);
  if (leadTeam) return { teamId: leadTeam.id, teamName: leadTeam.name, role: "lead" };
  return void 0;
}
function resolveRecipientSession(db, registry, teamId, recipientName) {
  if (recipientName === "lead") {
    const team = db.query("SELECT lead_session_id FROM team WHERE id = ?").get(teamId);
    return team?.lead_session_id;
  }
  const entry = registry.getByName(teamId, recipientName);
  if (entry) return entry.sessionId;
  const memberRow = db.query(
    `SELECT session_id FROM team_member
     WHERE team_id = ? AND name = ? AND status NOT IN ('shutdown', 'error')`
  ).get(teamId, recipientName);
  if (!memberRow) return void 0;
  registry.register(teamId, recipientName, memberRow.session_id);
  return memberRow.session_id;
}

// src/hooks.ts
var TEAM_TOOL_PREFIX = "team_";
function handleSessionStatusEvent(db, registry, sessionId, status, retryPayload) {
  const entry = registry.getBySession(sessionId);
  if (!entry) return void 0;
  const team = db.query("SELECT status FROM team WHERE id = ?").get(entry.teamId);
  if (!team || team.status === "archived") return void 0;
  const member = db.query("SELECT status, execution_status FROM team_member WHERE team_id = ? AND name = ?").get(entry.teamId, entry.memberName);
  if (!member) return void 0;
  if (status === "idle") {
    const newStatus = member.status === "shutdown_requested" ? "shutdown" : "ready";
    if (member.status === newStatus) return void 0;
    db.run(
      "UPDATE team_member SET status = ?, execution_status = 'idle', time_updated = ? WHERE team_id = ? AND name = ?",
      [newStatus, Date.now(), entry.teamId, entry.memberName]
    );
    if (newStatus === "shutdown") {
      releaseMemberTasks(db, entry.teamId, entry.memberName);
    }
    if (member.status === "busy" && newStatus === "ready") {
      const leadMsgCount = db.query(
        "SELECT COUNT(*) as c FROM team_message WHERE team_id = ? AND from_name = ? AND to_name = 'lead'"
      ).get(entry.teamId, entry.memberName).c;
      if (leadMsgCount > 0) {
        db.run(
          "UPDATE team_member SET reported_to_lead = 1 WHERE team_id = ? AND name = ?",
          [entry.teamId, entry.memberName]
        );
      }
    }
    return { memberName: entry.memberName, teamId: entry.teamId, from: member.status, to: newStatus };
  } else if (status === "busy") {
    if (member.status === "ready" || member.status === "error") {
      db.run(
        "UPDATE team_member SET status = 'busy', execution_status = 'running', reported_to_lead = 0, time_updated = ? WHERE team_id = ? AND name = ?",
        [Date.now(), entry.teamId, entry.memberName]
      );
      return { memberName: entry.memberName, teamId: entry.teamId, from: member.status, to: "busy" };
    }
    if (member.status === "busy" && member.execution_status === "starting") {
      db.run(
        "UPDATE team_member SET execution_status = 'running', time_updated = ? WHERE team_id = ? AND name = ?",
        [Date.now(), entry.teamId, entry.memberName]
      );
      return { memberName: entry.memberName, teamId: entry.teamId, from: member.status, to: "busy" };
    }
    if (member.status === "shutdown_requested") {
      return { memberName: entry.memberName, teamId: entry.teamId, from: "shutdown_requested", to: "busy_while_shutdown" };
    }
  } else if (status === "retry") {
    if (retryPayload) {
      const next = typeof retryPayload.next === "number" && Number.isFinite(retryPayload.next) ? retryPayload.next : null;
      const attempt = typeof retryPayload.attempt === "number" && Number.isFinite(retryPayload.attempt) ? retryPayload.attempt : null;
      db.run(
        "UPDATE team_member SET retry_until = ?, retry_attempt = ?, retry_provider = ?, retry_message = ? WHERE team_id = ? AND name = ?",
        [
          next,
          attempt,
          retryPayload.action?.provider ?? null,
          retryPayload.action?.message ?? retryPayload.message ?? null,
          entry.teamId,
          entry.memberName
        ]
      );
    }
    return { memberName: entry.memberName, teamId: entry.teamId, from: member.status, to: "retry" };
  }
  return void 0;
}
function handleSessionCreatedEvent(tracker, sessionId, parentId) {
  if (parentId) {
    tracker.track(sessionId, parentId);
  }
}
function checkToolIsolation(registry, tracker, toolName, sessionId, db) {
  if (!toolName.startsWith(TEAM_TOOL_PREFIX)) return;
  if (registry.isTeamSession(sessionId)) return;
  const teammateSessionIds = new Set(registry.allSessionIds());
  if (db) {
    const dbRows = db.query(
      `SELECT tm.session_id FROM team_member tm
       JOIN team t ON tm.team_id = t.id
       WHERE t.status = 'active' AND tm.status NOT IN ('shutdown', 'error')`
    ).all();
    for (const row of dbRows) teammateSessionIds.add(row.session_id);
  }
  if (teammateSessionIds.has(sessionId)) return;
  if (teammateSessionIds.size > 0 && tracker.isDescendantOf(sessionId, teammateSessionIds)) {
    throw new Error("Team tools are not available to sub-agents. Report findings to your parent teammate via your normal output.");
  }
}
function hasBlockedAssignedTasks(db, teamId, memberName) {
  const tasks = db.query(
    "SELECT status, depends_on FROM team_task WHERE team_id = ? AND assignee = ?"
  ).all(teamId, memberName);
  for (const task of tasks) {
    if (task.status === "blocked") return true;
    if (!task.depends_on) continue;
    let depIds;
    try {
      depIds = JSON.parse(task.depends_on);
    } catch {
      return true;
    }
    if (!Array.isArray(depIds)) return true;
    for (const depId of depIds) {
      if (typeof depId !== "string") return true;
      const dep = db.query("SELECT status FROM team_task WHERE id = ? AND team_id = ?").get(depId, teamId);
      if (!dep || dep.status !== "completed") return true;
    }
  }
  return false;
}
function shouldNudgeIdleMember(db, teamId, memberName) {
  const member = db.query("SELECT status, execution_status FROM team_member WHERE team_id = ? AND name = ?").get(teamId, memberName);
  if (!member || member.status !== "ready") return false;
  if (member.execution_status === "standby") return false;
  if (hasBlockedAssignedTasks(db, teamId, memberName)) return false;
  const msg = db.query("SELECT id FROM team_message WHERE team_id = ? AND from_name = ? AND (to_name = 'lead' OR to_name IS NULL) LIMIT 1").get(teamId, memberName);
  return !msg;
}
function shouldAlarmFastIdle(db, teamId, memberName, now = Date.now()) {
  const member = db.query("SELECT time_created, execution_status FROM team_member WHERE team_id = ? AND name = ?").get(teamId, memberName);
  if (!member) return false;
  if (member.execution_status === "standby") return false;
  if (hasBlockedAssignedTasks(db, teamId, memberName)) return false;
  if (now - member.time_created >= 15e3) return false;
  const msgCount = db.query("SELECT COUNT(*) as c FROM team_message WHERE team_id = ? AND from_name = ?").get(teamId, memberName).c;
  return msgCount === 0;
}
function handleSessionErrorEvent(db, registry, client, sessionId, error) {
  if (!sessionId) return;
  const teamInfo = findTeamBySession(db, registry, sessionId);
  if (!teamInfo || teamInfo.role !== "member" || !teamInfo.memberName) return;
  const errMsg = error?.data?.message ?? error?.name ?? "unknown error";
  notifyLead(
    client,
    db,
    teamInfo.teamId,
    `Teammate "${teamInfo.memberName}" had a session error: ${errMsg}. Check their session for details. They may be stuck and need investigation or shutdown.`
  );
}

// src/v2-events.ts
function dispatchV2Event(db, registry, tracker, event) {
  const data = event.data ?? {};
  switch (event.type) {
    case "session.status": {
      const raw = data.status;
      const status = typeof raw === "string" ? raw : raw?.type;
      if (status === "idle" || status === "busy") {
        return handleSessionStatusEvent(db, registry, data.sessionID ?? "", status);
      }
      if (status === "retry") {
        return handleSessionStatusEvent(db, registry, data.sessionID ?? "", "retry");
      }
      return void 0;
    }
    case "session.idle":
      if (!data.sessionID) return void 0;
      return handleSessionStatusEvent(db, registry, data.sessionID, "idle");
    case "session.execution.started":
      if (!data.sessionID) return void 0;
      return handleSessionStatusEvent(db, registry, data.sessionID, "busy");
    case "session.execution.succeeded":
    case "session.execution.failed":
      if (!data.sessionID) return void 0;
      return handleSessionStatusEvent(db, registry, data.sessionID, "idle");
    case "session.created":
      handleSessionCreatedEvent(tracker, data.sessionID ?? "", data.parentID);
      return void 0;
    case "session.retry.scheduled": {
      if (!data.sessionID) return void 0;
      const attempt = typeof data.attempt === "number" ? data.attempt : 0;
      const next = typeof data.at === "number" ? data.at : Date.now();
      return handleSessionStatusEvent(db, registry, data.sessionID, "retry", {
        attempt,
        message: data.error?.message ?? "rate limited",
        next
      });
    }
    default:
      return void 0;
  }
}

// src/v2-session.ts
async function deliverPrompt(port, sessionID, text) {
  return port.prompt({ sessionID, text, delivery: "queue" });
}

// src/v2-client.ts
init_process();
var DIR_WORKSPACE_PREFIX = "v2dir:";
async function gitBranchDefault(directory) {
  try {
    const result = await runCommand(["git", "branch", "--show-current"], { cwd: directory });
    const branch = result.stdout.trim();
    return result.exitCode === 0 && branch ? branch : null;
  } catch {
    return null;
  }
}
function joinParts(parts) {
  return parts.filter((part) => part.type === "text").map((part) => part.text).join("\n");
}
function createV2Client(ctx, deps = {}) {
  const gitBranch = deps.gitBranch ?? gitBranchDefault;
  return {
    session: {
      create: async (options) => {
        const input = { title: options.title };
        if (options.parentID) input["parentID"] = options.parentID;
        const V1_ACTION_MAP = { bash: "shell" };
        const permissions = options.permission?.map((rule) => ({
          action: V1_ACTION_MAP[rule.permission] ?? rule.permission,
          resource: rule.pattern,
          effect: rule.action
        }));
        if (permissions) input["permissions"] = permissions;
        if (options.workspaceID ?? options.directory) {
          if (options.workspaceID?.startsWith(DIR_WORKSPACE_PREFIX)) {
            input["location"] = {
              directory: options.workspaceID.slice(DIR_WORKSPACE_PREFIX.length)
            };
          } else {
            input["location"] = {
              ...options.directory ? { directory: options.directory } : {},
              ...options.workspaceID ? { workspaceID: options.workspaceID } : {}
            };
          }
        }
        const created = await ctx.session.create(input);
        if (permissions) {
          await ctx.permission.rules({ sessionID: created.id, permissions });
        }
        return { data: { id: created.id } };
      },
      promptAsync: async (options) => {
        if (options.synthetic) {
          return ctx.session.synthetic({ sessionID: options.sessionID, text: joinParts(options.parts), delivery: "queue" });
        }
        if (options.agent) {
          await ctx.session.switchAgent({ sessionID: options.sessionID, agent: options.agent });
        }
        if (options.model) {
          await ctx.session.switchModel({
            sessionID: options.sessionID,
            model: { providerID: options.model.providerID, id: options.model.modelID }
          });
        }
        const text = joinParts(options.parts);
        return ctx.session.prompt({ sessionID: options.sessionID, text, delivery: "queue" });
      },
      abort: async (options) => ctx.session.interrupt({ sessionID: options.sessionID }),
      status: async () => {
        const active = await ctx.session.active();
        const data = {};
        for (const sessionID of Object.keys(active)) data[sessionID] = { type: "busy" };
        return { data };
      },
      messages: async (options) => {
        const messages = await ctx.session.context({ sessionID: options.sessionID });
        return { data: messages };
      },
      get: async (options) => {
        const data = await ctx.session.get({ sessionID: options.sessionID });
        return { data };
      }
    },
    tui: {
      showToast: async () => void 0,
      selectSession: async (options) => {
        if (deps.rpcEmitter) {
          await deps.rpcEmitter.events.emit("view", { sessionID: options.sessionID }).catch(() => {
          });
        }
        return void 0;
      }
    },
    worktree: {
      create: async (options) => {
        const name = options.worktreeCreateInput?.name ?? "ensemble-worktree";
        const created = await ctx.worktree.create({ name });
        const branch = await gitBranch(created.directory) ?? name;
        return { data: { name, branch, directory: created.directory } };
      },
      remove: async (options) => {
        const directory = options.worktreeRemoveInput.directory;
        return ctx.worktree.remove({ directory, force: false });
      },
      list: async () => {
        const entries = await ctx.worktree.list();
        return {
          data: entries.map((entry) => ({
            name: entry.directory.split("/").pop() ?? entry.directory,
            branch: "",
            directory: entry.directory
          }))
        };
      },
      reset: async () => ctx.worktree.refresh()
    },
    workspace: {
      create: async (options) => {
        const branch = options.branch ?? "";
        const directory = await deps.gitDir?.(branch);
        if (!directory) throw new Error(`V2 workspace bridge: no worktree found on branch "${branch}"`);
        return {
          data: {
            id: `${DIR_WORKSPACE_PREFIX}${directory}`,
            type: "local",
            branch,
            directory,
            projectID: ""
          }
        };
      },
      remove: async () => void 0,
      list: async () => ({
        data: []
      })
    }
  };
}

// src/member-model.ts
function parseModelId(model) {
  const slash = model.indexOf("/");
  if (slash <= 0 || slash === model.length - 1) return void 0;
  return { providerID: model.slice(0, slash), modelID: model.slice(slash + 1) };
}
function getMemberModel(db, teamId, memberName) {
  const row = db.query("SELECT model FROM team_member WHERE team_id = ? AND name = ?").get(teamId, memberName);
  if (!row?.model) return void 0;
  return parseModelId(row.model);
}

// src/recovery.ts
init_merge_helper();
init_log();
init_process();
async function isSessionAlive(client, sessionId, timeoutMs = 5e3) {
  try {
    await Promise.race([
      client.session.get({ sessionID: sessionId }),
      new Promise((_, reject) => setTimeout(() => reject(new Error("isSessionAlive timed out")), timeoutMs))
    ]);
    return true;
  } catch (err) {
    if (err instanceof Error && err.message === "isSessionAlive timed out") {
      log(`recovery:team:liveness-check-timeout session=${sessionId}`);
      return true;
    }
    return false;
  }
}
async function recoverOrphanedTeams(db, client, cwd, registry) {
  const active = db.query(
    `SELECT id, lead_session_id FROM team
     WHERE status = 'active' AND (? IS NULL OR project_id = ? OR project_id = 'default')`
  ).all(cwd ?? null, cwd ?? null);
  let archived = 0;
  for (const team of active) {
    if (await isSessionAlive(client, team.lead_session_id)) continue;
    db.run("UPDATE team SET status = 'archived', time_updated = ? WHERE id = ?", [Date.now(), team.id]);
    registry?.unregisterTeam(team.id);
    archived++;
    log(`recovery:team:orphaned team_id=${team.id} lead_session=${team.lead_session_id}`);
  }
  return { archived };
}
async function recoverStaleMembers(db, client, cwd, abortTimeoutMs = 5e3) {
  const stale = db.query(
    `SELECT tm.session_id, tm.worktree_branch, tm.name, tm.team_id, t.name as team_name, p.name as project_name
      FROM team_member tm
      JOIN team t ON tm.team_id = t.id
      JOIN project p ON t.project_id = p.id
      WHERE tm.status = 'busy' AND t.status = 'active'
        AND (? IS NULL OR t.project_id = ? OR t.project_id = 'default')`
  ).all(cwd ?? null, cwd ?? null);
  const result = db.run(
    `UPDATE team_member SET status = 'error', execution_status = 'idle', time_updated = ?
      WHERE status = 'busy'
        AND team_id IN (SELECT id FROM team WHERE status = 'active' AND (? IS NULL OR project_id = ? OR project_id = 'default'))`,
    [Date.now(), cwd ?? null, cwd ?? null]
  );
  for (const member of stale) {
    const released = releaseMemberTasks(db, member.team_id, member.name);
    if (released > 0) log(`recovery:tasks:released name=${member.name} count=${released}`);
  }
  if (client) {
    for (const member of stale) {
      if (cwd && member.worktree_branch && !member.worktree_branch.startsWith("ensemble/preserved/")) {
        const safeBranch = preservedBranchName(member.project_name, member.team_name, member.team_id, member.name);
        const ok = await preserveBranch(member.worktree_branch, safeBranch, cwd);
        if (ok) {
          db.run(
            "UPDATE team_member SET worktree_branch = ? WHERE team_id = ? AND name = ?",
            [safeBranch, member.team_id, member.name]
          );
          log(`recovery:branch:preserved src=${member.worktree_branch} target=${safeBranch}`);
        }
      }
      try {
        await Promise.race([
          client.session.abort({ sessionID: member.session_id }),
          new Promise((_, reject) => setTimeout(() => reject(new Error("session.abort timed out")), abortTimeoutMs))
        ]);
      } catch (err) {
        if (err instanceof Error && err.message === "session.abort timed out") {
          log(`recovery:stale-members:abort-timeout session=${member.session_id}`);
        }
      }
    }
  }
  return { interrupted: result.changes };
}
async function recoverOrphanedWorktrees(db, client) {
  let removed = 0;
  try {
    const worktrees = await client.worktree.list();
    if (!worktrees.data) return { removed: 0 };
    const activeWorktrees = new Set(
      db.query(
        `SELECT tm.worktree_dir FROM team_member tm
         JOIN team t ON tm.team_id = t.id
         WHERE tm.worktree_dir IS NOT NULL AND t.status = 'active'`
      ).all().map((r) => r.worktree_dir)
    );
    for (const wt of worktrees.data) {
      if (!wt.name.startsWith("ensemble-")) continue;
      if (activeWorktrees.has(wt.directory)) continue;
      try {
        await client.worktree.remove({ worktreeRemoveInput: { directory: wt.directory } });
        removed++;
      } catch {
      }
    }
  } catch {
  }
  return { removed };
}
async function recoverUndeliveredMessages(db, client, registry) {
  const teams = db.query("SELECT id, lead_session_id FROM team WHERE status = 'active'").all();
  let redelivered = 0;
  for (const team of teams) {
    const messages = getUndeliveredMessages(db, team.id);
    for (const msg of messages) {
      let recipientSessionId;
      if (msg.to_name === "lead") {
        continue;
      } else if (msg.to_name) {
        const entry = registry.getByName(team.id, msg.to_name);
        recipientSessionId = entry?.sessionId;
      } else {
        continue;
      }
      if (!recipientSessionId) continue;
      if (hasReportedCompletion(db, team.id, msg.to_name)) {
        markDelivered(db, msg.id);
        continue;
      }
      try {
        const recipientModel = getMemberModel(db, team.id, msg.to_name);
        await client.session.promptAsync({
          sessionID: recipientSessionId,
          parts: [{ type: "text", text: `[Recovered team message from ${msg.from_name}]: ${msg.content}` }],
          ...recipientModel ? { model: recipientModel } : {}
        });
        markDelivered(db, msg.id);
        redelivered++;
      } catch {
      }
    }
  }
  return { redelivered };
}
function rehydrateRegistry(db, registry) {
  const members = db.query(
    `SELECT tm.team_id, tm.name, tm.session_id
     FROM team_member tm
     JOIN team t ON tm.team_id = t.id
     WHERE t.status = 'active' AND tm.status NOT IN ('shutdown', 'error')`
  ).all();
  for (const m of members) {
    registry.register(m.team_id, m.name, m.session_id);
  }
  return members.length;
}
async function recoverOrphanedBranches(db, cwd) {
  let removed = 0;
  const archivedTeams = db.query(
    `SELECT t.id, t.name, p.name as project_name FROM team t
     JOIN project p ON t.project_id = p.id
     WHERE t.status = 'archived'
      AND t.project_id = ?
     AND NOT EXISTS (
        SELECT 1 FROM team_member tm
        WHERE tm.team_id = t.id AND tm.status NOT IN ('shutdown', 'error')
      )`
  ).all(cwd);
  if (archivedTeams.length === 0) return { removed: 0 };
  const archivedPrefixes = archivedTeams.flatMap((t) => [
    `ensemble/preserved/${t.project_name}/${teamResourceSegment(t.name, t.id)}/`,
    `ensemble/preserved/${t.name}/`
  ]);
  const result = await runCommand(["git", "branch", "--list", "ensemble/preserved/*"], { cwd });
  const branches = result.stdout.split("\n").map((b) => b.trim().replace(/^\* /, "")).filter(Boolean);
  for (const branch of branches) {
    if (!archivedPrefixes.some((prefix) => branch.startsWith(prefix))) continue;
    try {
      const deleteResult = await runCommand(["git", "branch", "-D", branch], { cwd });
      if (deleteResult.exitCode === 0) {
        removed++;
        log(`recovery:branch:deleted branch=${branch}`);
      }
    } catch {
    }
  }
  return { removed };
}

// src/tools/team-create.ts
async function executeTeamCreate(deps, args, sessionId) {
  const nameError = validateTeamName(args.name);
  if (nameError) throw new Error(nameError);
  if (args.project_name) {
    const projectNameError = validateProjectName(args.project_name);
    if (projectNameError) throw new Error(projectNameError);
  }
  const projectId = deps.directory;
  const existing = deps.db.query("SELECT id, lead_session_id FROM team WHERE name = ? AND project_id = ? AND status = 'active'").get(args.name, projectId);
  if (existing) {
    if (await isSessionAlive(deps.client, existing.lead_session_id)) {
      throw new Error(`Team "${args.name}" already exists`);
    }
    deps.db.run("UPDATE team SET status = 'archived', time_updated = ? WHERE id = ?", [Date.now(), existing.id]);
    deps.registry.unregisterTeam(existing.id);
  }
  const lead = findTeamBySession(deps.db, deps.registry, sessionId);
  if (lead) throw new Error(`This session already belongs to team "${lead.teamName}"`);
  const id = generateId("team");
  const now = Date.now();
  const projectName = args.project_name ?? generateProjectName();
  deps.db.run(
    `INSERT INTO project (id, name, path, status, time_created, time_updated)
     VALUES (?, ?, ?, 'active', ?, ?)
     ON CONFLICT(id) DO UPDATE SET time_updated = excluded.time_updated`,
    [projectId, projectName, projectId, now, now]
  );
  deps.db.run(
    "INSERT INTO team (id, name, project_id, lead_session_id, status, delegate, time_created, time_updated) VALUES (?, ?, ?, ?, 'active', 0, ?, ?)",
    [id, args.name, projectId, sessionId, now, now]
  );
  return `Team "${args.name}" created. You are the lead. Use team_spawn to add teammates.`;
}

// src/tools/shared.ts
init_process();
init_log();
function resolveStandbyWake(db, teamId, memberName, baseText) {
  const row = db.query(
    "SELECT agent, execution_status, spawn_context FROM team_member WHERE team_id = ? AND name = ?"
  ).get(teamId, memberName);
  if (!row || row.execution_status !== "standby") {
    return { text: baseText, woke: false };
  }
  const result = db.run(
    "UPDATE team_member SET execution_status = 'starting', time_updated = ? WHERE team_id = ? AND name = ? AND execution_status = 'standby'",
    [Date.now(), teamId, memberName]
  );
  if (!result.changes) {
    log(`standby:wake:lost-race member=${memberName} team=${teamId} \u2014 delivering without prepend`);
    return { text: baseText, woke: false };
  }
  const context = row.spawn_context?.trim();
  log(`standby:wake member=${memberName} team=${teamId} context=${context ? `${context.length} chars` : "none"}`);
  return {
    text: context ? `${context}

${baseText}` : baseText,
    woke: true,
    agent: row.agent
  };
}
async function countBranchCommits(branch, cwd) {
  try {
    const result = await runCommand(["git", "rev-list", "--count", `HEAD..${branch}`], { cwd });
    if (result.exitCode !== 0) return -1;
    const n = Number.parseInt(result.stdout.trim(), 10);
    return Number.isNaN(n) ? -1 : n;
  } catch {
    return -1;
  }
}
async function checkWorktreeDirty(dir) {
  try {
    const result = await runCommand(["git", "-C", dir, "status", "--porcelain"]);
    if (result.exitCode !== 0) return false;
    return result.stdout.trim().length > 0;
  } catch {
    return false;
  }
}
function requireLead(deps, sessionId) {
  const teamInfo = findTeamBySession(deps.db, deps.registry, sessionId);
  if (!teamInfo) throw new Error("This session is not in a team. Use team_create first.");
  if (teamInfo.role !== "lead") throw new Error("Only the team lead can use this tool.");
  return { teamId: teamInfo.teamId, teamName: teamInfo.teamName };
}
function requireTeamMember(deps, sessionId) {
  const teamInfo = findTeamBySession(deps.db, deps.registry, sessionId);
  if (!teamInfo) throw new Error("This session is not in a team.");
  return teamInfo;
}
function requireCanPurgeArchivedTeams(deps, sessionId) {
  const activeMembers = deps.db.query(
    `SELECT tm.session_id
     FROM team_member tm
     JOIN team t ON tm.team_id = t.id
     WHERE t.status = 'active'`
  ).all();
  if (activeMembers.some((member) => member.session_id === sessionId)) {
    throw new Error("Team members cannot purge archived teams");
  }
  const activeLeads = deps.db.query("SELECT lead_session_id FROM team WHERE status = 'active'").all();
  if (deps.tracker.getParent(sessionId)) {
    throw new Error("Sub-agents cannot purge archived teams");
  }
  if (activeLeads.some((team) => team.lead_session_id === sessionId)) return;
  const activeTeamSessions = /* @__PURE__ */ new Set([
    ...activeMembers.map((member) => member.session_id),
    ...activeLeads.map((team) => team.lead_session_id)
  ]);
  if (deps.tracker.isDescendantOf(sessionId, activeTeamSessions)) {
    throw new Error("Sub-agents cannot purge archived teams");
  }
}

// src/tools/team-claim.ts
function claimTask(db, teamId, taskId, assignee) {
  const task = db.query("SELECT content, status, assignee FROM team_task WHERE id = ? AND team_id = ?").get(taskId, teamId);
  if (!task) throw new Error(`Task "${taskId}" not found`);
  if (task.status === "blocked") throw new Error(`Task "${taskId}" is blocked by unresolved dependencies`);
  if (task.status !== "pending") throw new Error(`Task "${taskId}" is not pending (status: ${task.status})`);
  if (task.assignee) throw new Error(`Task "${taskId}" is already claimed by ${task.assignee}`);
  const result = db.run(
    "UPDATE team_task SET status = 'in_progress', assignee = ?, time_updated = ? WHERE id = ? AND status = 'pending' AND assignee IS NULL",
    [assignee, Date.now(), taskId]
  );
  if (result.changes === 0) {
    throw new Error(`Task "${taskId}" is already claimed (race condition)`);
  }
  return task.content;
}
async function executeTeamClaim(deps, args, sessionId) {
  const teamInfo = requireTeamMember(deps, sessionId);
  const claimerName = teamInfo.role === "lead" ? "lead" : teamInfo.memberName ?? "unknown";
  const content = claimTask(deps.db, teamInfo.teamId, args.task_id, claimerName);
  return `Claimed task: ${content}`;
}

// src/tools/team-spawn.ts
init_log();
init_merge_helper();
var spawnFailures = /* @__PURE__ */ new Map();
function resolveModel(explicitModel, agentType, teamMemberCount, config) {
  if (explicitModel) return explicitModel;
  if (config.modelsByAgent[agentType]) return config.modelsByAgent[agentType];
  if (config.modelAssignment === "rotate" && config.modelPool.length > 0) {
    return config.modelPool[teamMemberCount % config.modelPool.length];
  }
  if (config.modelAssignment === "random" && config.modelPool.length > 0) {
    return config.modelPool[Math.floor(Math.random() * config.modelPool.length)];
  }
  if (config.defaultModel) return config.defaultModel;
  return void 0;
}
function getSpawnTimeout() {
  return Number(process.env.SPAWN_TIMEOUT_MS) || 12e4;
}
function isWorktreeDirectory(dir) {
  return dir.includes("/opencode/worktree/");
}
function withTimeout(promise, ms, label) {
  let timer;
  return Promise.race([
    promise.finally(() => clearTimeout(timer)),
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
    })
  ]);
}
async function executeTeamSpawn(deps, args, sessionId) {
  const agent = args.agent ?? "build";
  const nameError = validateMemberName(args.name);
  if (nameError) throw new Error(nameError);
  const teamInfo = requireLead(deps, sessionId);
  const failures = spawnFailures.get(teamInfo.teamId);
  if (failures && failures.count >= 3) {
    throw new Error(`Spawn circuit breaker tripped for team "${teamInfo.teamName}": 3 consecutive failures. Last error: ${failures.lastError}. Investigate before retrying \u2014 the circuit breaker resets on the next successful spawn.`);
  }
  const existing = deps.db.query("SELECT name FROM team_member WHERE team_id = ? AND name = ?").get(teamInfo.teamId, args.name);
  if (existing) throw new Error(`Teammate "${args.name}" already exists in team "${teamInfo.teamName}"`);
  const isReadOnly = agent === "plan" || agent === "explore";
  const useWorktree = args.worktree !== false && !isReadOnly && !isWorktreeDirectory(deps.directory);
  const usePlanApproval = args.plan_approval === true;
  let autoStandby = false;
  let claimedTaskBlocked = false;
  if (args.claim_task) {
    const task = deps.db.query("SELECT status FROM team_task WHERE id = ? AND team_id = ?").get(args.claim_task, teamInfo.teamId);
    if (task && task.status === "blocked") {
      autoStandby = true;
      claimedTaskBlocked = true;
      log(`spawn:auto-standby member=${args.name} task=${args.claim_task} reason=task_blocked`);
    }
  }
  const useStandby = args.standby === true || autoStandby;
  log(`spawn:start name=${args.name} agent=${agent} worktree=${useWorktree}${useStandby ? " standby=true" : ""}`);
  let worktreeDir = null;
  let worktreeBranch = null;
  if (useWorktree) {
    const resource = getTeamResourceParts(deps.db, teamInfo.teamId);
    const worktreeName = teamWorktreeName(resource.projectName, resource.teamName, resource.teamId, args.name);
    try {
      log(`spawn:worktree:start name=${args.name}`);
      const result = await withTimeout(
        deps.client.worktree.create({ worktreeCreateInput: { name: worktreeName } }),
        getSpawnTimeout(),
        `worktree.create for "${args.name}"`
      );
      if (result.data) {
        worktreeDir = result.data.directory;
        worktreeBranch = result.data.branch;
      }
      log(`spawn:worktree:done name=${args.name} dir=${worktreeDir}`);
    } catch (err) {
      log(`spawn:worktree:failed name=${args.name} err=${err instanceof Error ? err.message : String(err)}`);
      try {
        await deps.client.tui.showToast({
          title: "Team",
          message: `Worktree creation failed for ${args.name}, using shared directory`,
          variant: "warning",
          duration: 4e3
        });
      } catch {
      }
    }
  }
  let workspaceId = null;
  if (worktreeDir && worktreeBranch) {
    try {
      log(`spawn:workspace:start name=${args.name}`);
      const wsResult = await withTimeout(
        deps.client.workspace.create({ branch: worktreeBranch }),
        getSpawnTimeout(),
        `workspace.create for "${args.name}"`
      );
      if (wsResult.data) {
        workspaceId = wsResult.data.id;
      }
      log(`spawn:workspace:done name=${args.name} id=${workspaceId}`);
    } catch (err) {
      log(`spawn:workspace:failed name=${args.name} err=${err instanceof Error ? err.message : String(err)}`);
    }
  }
  const TEAM_TOOLS = [
    "team_message",
    "team_broadcast",
    "team_tasks_list",
    "team_tasks_add",
    "team_tasks_complete",
    "team_claim",
    "team_results",
    "team_status",
    "team_view"
  ];
  const permission = [];
  if (worktreeDir) {
    permission.push(
      { permission: "edit", pattern: `${worktreeDir}/**`, action: "allow" }
    );
    if (!isReadOnly) {
      permission.push({ permission: "bash", pattern: "*", action: "allow" });
    }
  }
  if (isReadOnly) {
    permission.push(
      { permission: "edit", pattern: "*", action: "deny" },
      { permission: "bash", pattern: "*", action: "deny" }
    );
  }
  permission.push(
    ...TEAM_TOOLS.map((t) => ({ permission: t, pattern: "*", action: "allow" }))
  );
  permission.push({ permission: "execute", pattern: "*", action: "allow" });
  let childSessionId;
  try {
    log(`spawn:session:start name=${args.name}`);
    const createResult = await withTimeout(
      deps.client.session.create({
        parentID: sessionId,
        title: `${args.name} (@${agent} teammate)`,
        permission,
        ...workspaceId ? { workspaceID: workspaceId } : {}
      }),
      getSpawnTimeout(),
      `session.create for "${args.name}"`
    );
    childSessionId = createResult.data?.id;
    log(`spawn:session:done name=${args.name} sessionId=${childSessionId}`);
  } catch (err) {
    log(`spawn:session:failed name=${args.name} err=${err instanceof Error ? err.message : String(err)}`);
    const errMsg = err instanceof Error ? err.message : String(err);
    const prev = spawnFailures.get(teamInfo.teamId);
    spawnFailures.set(teamInfo.teamId, { count: (prev?.count ?? 0) + 1, lastError: errMsg });
    if (workspaceId) {
      try {
        await deps.client.workspace.remove({ id: workspaceId });
      } catch {
      }
    }
    if (worktreeDir) {
      try {
        await deps.client.worktree.remove({ worktreeRemoveInput: { directory: worktreeDir } });
      } catch {
      }
    }
    throw new Error(`Failed to create session for teammate "${args.name}": ${err instanceof Error ? err.message : String(err)}`);
  }
  if (!childSessionId) {
    if (workspaceId) {
      try {
        await deps.client.workspace.remove({ id: workspaceId });
      } catch {
      }
    }
    if (worktreeDir) {
      try {
        await deps.client.worktree.remove({ worktreeRemoveInput: { directory: worktreeDir } });
      } catch {
      }
    }
    throw new Error("Failed to create teammate session");
  }
  const planApproval = usePlanApproval ? "pending" : "none";
  const now = Date.now();
  const memberCount = deps.db.query("SELECT COUNT(*) as c FROM team_member WHERE team_id = ?").get(teamInfo.teamId).c;
  const resolvedModel = resolveModel(args.model, agent, memberCount, deps.config);
  if (resolvedModel) log(`spawn:model name=${args.name} model=${resolvedModel}`);
  deps.db.run(
    `INSERT INTO team_member (team_id, name, session_id, agent, status, execution_status, model, prompt, worktree_dir, worktree_branch, workspace_id, plan_approval, time_created, time_updated)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      teamInfo.teamId,
      args.name,
      childSessionId,
      agent,
      // Standby members are born 'ready'/'standby', not 'busy'/'starting':
      // they have never run a step, so putting them in 'busy' would make the
      // watchdog's TTL/stall scan treat a member that was never started as a
      // member that stalled.
      useStandby ? "ready" : "busy",
      useStandby ? "standby" : "starting",
      resolvedModel ?? null,
      args.prompt,
      worktreeDir,
      worktreeBranch,
      workspaceId,
      planApproval,
      now,
      now
    ]
  );
  if (!useStandby) deps.progressTracker.recordBusyStart(childSessionId);
  deps.registry.register(teamInfo.teamId, args.name, childSessionId);
  let claimedTaskContent = null;
  let claimWarning = null;
  if (args.claim_task && !isReadOnly) {
    if (claimedTaskBlocked) {
      const updateResult = deps.db.run(
        "UPDATE team_task SET assignee = ?, time_updated = ? WHERE id = ? AND team_id = ? AND assignee IS NULL",
        [args.name, Date.now(), args.claim_task, teamInfo.teamId]
      );
      if (updateResult.changes === 0) {
        claimWarning = `Task "${args.claim_task}" is already claimed or missing`;
        log(`spawn:claim-blocked:failed name=${args.name} task=${args.claim_task} err=${claimWarning}`);
      } else {
        const taskRow = deps.db.query("SELECT content FROM team_task WHERE id = ? AND team_id = ?").get(args.claim_task, teamInfo.teamId);
        claimedTaskContent = taskRow?.content ?? null;
        log(`spawn:claim-blocked:ok name=${args.name} task=${args.claim_task}`);
      }
    } else {
      try {
        claimedTaskContent = claimTask(deps.db, teamInfo.teamId, args.claim_task, args.name);
        log(`spawn:claim:ok name=${args.name} task=${args.claim_task}`);
      } catch (err) {
        claimWarning = err instanceof Error ? err.message : String(err);
        log(`spawn:claim:failed name=${args.name} task=${args.claim_task} err=${claimWarning}`);
      }
    }
  }
  const context = [
    `You are "${args.name}", a teammate in team "${teamInfo.teamName}".`,
    `Your agent type is "${agent}".`
  ];
  const otherMembers = deps.db.query(
    "SELECT name FROM team_member WHERE team_id = ? AND name != ? AND status NOT IN ('shutdown', 'error')"
  ).all(teamInfo.teamId, args.name);
  if (otherMembers.length > 0) {
    context.push(`Other teammates: ${otherMembers.map((m) => m.name).join(", ")}`);
  }
  if (worktreeBranch && worktreeDir && !workspaceId) {
    context.push(
      `You are working on branch "${worktreeBranch}" in your own worktree at: ${worktreeDir}`,
      `Your changes are isolated from other teammates.`,
      `IMPORTANT: All file operations and shell commands MUST target your worktree directory.`,
      `Before running shell commands, cd to: ${worktreeDir}`
    );
  } else if (worktreeBranch && worktreeDir) {
    context.push(
      `You are working on branch "${worktreeBranch}" in your own isolated worktree.`,
      `Your changes are isolated from other teammates.`
    );
  } else if (worktreeBranch) {
    context.push(`You are working on branch "${worktreeBranch}". Your changes are isolated from other teammates.`);
  }
  if (usePlanApproval) {
    context.push(
      "",
      "IMPORTANT: You are in PLAN MODE.",
      "Read and explore the codebase, then send your implementation plan to the lead via team_message.",
      "Do NOT write or modify any files until the lead approves your plan.",
      "Wait for the lead's approval message before proceeding with implementation."
    );
  }
  if (isReadOnly) {
    context.push(
      "",
      "Tools available to you:",
      "- team_message: send a message to the lead or another teammate",
      "- team_broadcast: send a message to all team members",
      "- team_tasks_list: view the shared team task board"
    );
  } else {
    context.push(
      "",
      "Tools available to you:",
      "- team_message: send a message to the lead or another teammate",
      "- team_broadcast: send a message to all team members",
      "- team_tasks_list: view the shared team task board",
      "- team_tasks_add: add tasks to the shared board",
      "- team_tasks_complete: mark a task complete on the shared board",
      "- team_claim: claim a pending task from the shared board"
    );
  }
  if (otherMembers.length > 0) {
    context.push(
      "",
      "Collaboration:",
      "- Check team_tasks_list to see what other teammates are working on.",
      "- If you need information another teammate has, message them directly via team_message.",
      "- If you discover something relevant to another teammate's task, share it with them.",
      "- Use team_broadcast for updates that affect the whole team.",
      "- Keep peer messages focused and actionable \u2014 coordinate, don't chat."
    );
  }
  context.push("", "When you finish your task:");
  if (!isReadOnly && worktreeBranch) {
    context.push(`1. Commit your changes: git add -A && git commit -m "your summary"`);
    context.push("2. If you claimed a task, mark it complete using team_tasks_complete.");
    context.push(
      "3. Send ONE message to the lead using team_message with this format:"
    );
  } else if (!isReadOnly) {
    context.push("1. If you claimed a task, mark it complete using team_tasks_complete.");
    context.push(
      "2. Send ONE message to the lead using team_message with this format:"
    );
  } else {
    context.push(
      "1. Send ONE message to the lead using team_message with this format:"
    );
  }
  context.push(
    "<task-result>",
    "<status>completed or failed</status>",
    "<summary>One-line summary of what you did</summary>",
    "<details>Full findings or changes made</details>"
  );
  if (worktreeBranch) {
    context.push(`<branch>${worktreeBranch}</branch>`);
  }
  context.push("</task-result>");
  const lastStep = !isReadOnly && worktreeBranch ? "4" : !isReadOnly ? "3" : "2";
  context.push(
    `${lastStep}. STOP. Do not send follow-up confirmations, status updates, or 'standing by' messages.`,
    "",
    "If you are blocked:",
    "- Send ONE message to the lead via team_message describing the specific blocker.",
    "- Do NOT attempt workarounds or make assumptions. Wait for the lead's response.",
    "",
    "Your plain text output is NOT visible to the team. You MUST use team_message to communicate."
  );
  context.push(
    "",
    "Your task:",
    args.prompt
  );
  if (claimedTaskContent) {
    context.push("", `You have been assigned task ${args.claim_task}. Mark it complete when done.`);
  }
  const contextStr = context.join("\n");
  if (useStandby) {
    deps.db.run(
      "UPDATE team_member SET spawn_context = ?, time_updated = ? WHERE team_id = ? AND name = ?",
      [contextStr, Date.now(), teamInfo.teamId, args.name]
    );
    log(`spawn:standby:context-saved name=${args.name} chars=${contextStr.length}`);
  }
  const modelParam = resolvedModel ? parseModelId(resolvedModel) : void 0;
  if (resolvedModel && !modelParam) {
    log(`spawn:model:invalid name=${args.name} model=${resolvedModel} \u2014 expected "provider/model" format, falling back to default`);
  }
  if (useStandby) {
    log(`spawn:standby:no-prompt name=${args.name} sessionId=${childSessionId}`);
  } else {
    log(`spawn:promptAsync:fire name=${args.name} sessionId=${childSessionId}`);
    deps.client.session.promptAsync({
      sessionID: childSessionId,
      parts: [{ type: "text", text: contextStr }],
      agent,
      ...modelParam ? { model: modelParam } : {}
    }).catch((err) => {
      const errMsg = err instanceof Error ? err.message : String(err);
      log(`spawn:promptAsync:failed name=${args.name} err=${errMsg} \u2014 rolling back`);
      try {
        deps.db.run("DELETE FROM team_member WHERE team_id = ? AND session_id = ?", [teamInfo.teamId, childSessionId]);
        deps.registry.unregister(childSessionId);
        if (claimedTaskContent) {
          deps.db.run(
            "UPDATE team_task SET status = 'pending', assignee = NULL, time_updated = ? WHERE id = ? AND assignee = ? AND status = 'in_progress'",
            [Date.now(), args.claim_task, args.name]
          );
        }
        deps.client.session.abort({ sessionID: childSessionId }).catch(() => {
        });
        if (workspaceId) {
          deps.client.workspace.remove({ id: workspaceId }).catch(() => {
          });
        }
        if (worktreeDir) {
          deps.client.worktree.remove({ worktreeRemoveInput: { directory: worktreeDir } }).catch(() => {
          });
        }
        const modelInfo = resolvedModel ? ` (model: ${resolvedModel})` : "";
        deps.client.tui.showToast({
          title: "Team",
          message: `Teammate "${args.name}" failed to start${modelInfo}: ${errMsg}`,
          variant: "error",
          duration: 8e3
        }).catch(() => {
        });
        notifyLead(
          deps.client,
          deps.db,
          teamInfo.teamId,
          `Teammate "${args.name}" failed to start and was removed${modelInfo}. Error: ${errMsg}. You may retry the spawn.`
        );
      } catch {
      }
    });
  }
  const branchInfo = worktreeBranch ? ` (branch: ${worktreeBranch})` : "";
  const standbyInfo = autoStandby ? ` (auto-standby: claimed task ${args.claim_task} is blocked)` : useStandby ? " [standby \u2014 no prompt sent; wakes on first team_message]" : "";
  const planInfo = usePlanApproval ? " [plan mode \u2014 will send plan for approval]" : "";
  const claimInfo = claimedTaskContent ? ` (claimed task: ${args.claim_task})` : claimWarning ? ` (could not claim task: ${claimWarning})` : "";
  spawnFailures.delete(teamInfo.teamId);
  log(`spawn:done name=${args.name} sessionId=${childSessionId}`);
  return `Teammate "${args.name}" spawned (agent: ${agent})${branchInfo}${standbyInfo}${planInfo}${claimInfo}. They are working on: ${args.prompt.slice(0, 120)}${args.prompt.length > 120 ? "..." : ""}`;
}

// src/tools/team-message.ts
init_log();
async function executeTeamMessage(deps, args, sessionId) {
  const teamInfo = requireTeamMember(deps, sessionId);
  if (args.force && teamInfo.role !== "lead") {
    throw new Error("Only the lead can force-deliver a message to a completed teammate.");
  }
  const senderName = teamInfo.role === "lead" ? "lead" : teamInfo.memberName ?? "unknown";
  if (args.model !== void 0) {
    if (teamInfo.role !== "lead") throw new Error("Only the lead can update a teammate's model.");
    const parsed = parseModelId(args.model);
    if (!parsed) throw new Error(`Invalid model "${args.model}" \u2014 expected "provider/model" format (e.g. "anthropic/claude-sonnet").`);
    const member = deps.db.query("SELECT status FROM team_member WHERE team_id = ? AND name = ?").get(teamInfo.teamId, args.to);
    if (!member) throw new Error(`Teammate "${args.to}" not found in team "${teamInfo.teamName}".`);
    if (member.status === "shutdown" || member.status === "error") {
      throw new Error(`Teammate "${args.to}" is shut down \u2014 spawn a new teammate instead of updating the model.`);
    }
    deps.db.run(
      "UPDATE team_member SET model = ?, time_updated = ? WHERE team_id = ? AND name = ?",
      [args.model, Date.now(), teamInfo.teamId, args.to]
    );
    log(`team_message:model-update to=${args.to} model=${args.model}`);
    if (!args.text) {
      return `Updated ${args.to}'s model to ${args.model}. It applies on their next turn.`;
    }
  }
  if (args.text === void 0) {
    throw new Error("team_message requires either 'text' or 'model'.");
  }
  const text = args.text;
  const recipientSessionId = resolveRecipientSession(deps.db, deps.registry, teamInfo.teamId, args.to);
  if (!recipientSessionId && args.to !== "lead") {
    if (args.approve || args.reject) {
      throw new Error(`Cannot approve/reject plan for "${args.to}" \u2014 they haven't been spawned yet.`);
    }
    sendMessage(deps.db, {
      teamId: teamInfo.teamId,
      from: senderName,
      to: args.to,
      content: text
    });
    log(`team_message:queued from=${senderName} to=${args.to} (recipient not yet spawned)`);
    return `Message queued for ${args.to} \u2014 they haven't been spawned yet. It will be delivered when they join the team.`;
  }
  if (!recipientSessionId) throw new Error(`Recipient "${args.to}" not found in team "${teamInfo.teamName}"`);
  let messageText = text;
  if (args.approve || args.reject) {
    if (args.approve && args.reject) {
      throw new Error("Cannot both approve and reject a plan.");
    }
    if (teamInfo.role !== "lead") {
      throw new Error("Only the lead can approve or reject plans.");
    }
    const recipient = deps.db.query(
      "SELECT plan_approval FROM team_member WHERE team_id = ? AND name = ?"
    ).get(teamInfo.teamId, args.to);
    if (!recipient || recipient.plan_approval !== "pending") {
      throw new Error(`Recipient "${args.to}" is not in plan approval mode (plan_approval is not pending).`);
    }
    if (args.approve) {
      deps.db.run(
        "UPDATE team_member SET plan_approval = 'approved', time_updated = ? WHERE team_id = ? AND name = ?",
        [Date.now(), teamInfo.teamId, args.to]
      );
      messageText = `[Plan Approved] ${args.text}`;
    } else {
      deps.db.run(
        "UPDATE team_member SET plan_approval = 'rejected', time_updated = ? WHERE team_id = ? AND name = ?",
        [Date.now(), teamInfo.teamId, args.to]
      );
      messageText = `[Plan Rejected: ${args.reject}] ${args.text}`;
    }
  }
  const msgId = sendMessage(deps.db, {
    teamId: teamInfo.teamId,
    from: senderName,
    to: args.to,
    content: messageText
  });
  const isToLead = args.to === "lead";
  if (isToLead) {
    if (deps.config?.silentLead) {
      log(`team_message:lead-silenced from=${senderName}`);
      return `Message sent to ${args.to}.`;
    }
    log(`team_message:wake-lead from=${senderName} recipientSession=${recipientSessionId}`);
    deps.client.session.promptAsync({
      sessionID: recipientSessionId,
      parts: [{ type: "text", text: `[System: New team message from ${senderName}]` }],
      synthetic: true
    }).catch((err) => {
      log(`team_message:wake-lead:failed from=${senderName} err=${err instanceof Error ? err.message : String(err)}`);
    });
    return `Message sent to ${args.to}.`;
  }
  if (hasReportedCompletion(deps.db, teamInfo.teamId, args.to) && !args.force) {
    return `Message stored for ${args.to} (teammate has completed their task \u2014 message will not wake them). Pass force:true to re-activate them.`;
  }
  const wake = resolveStandbyWake(
    deps.db,
    teamInfo.teamId,
    args.to,
    `[Team message from ${senderName}]: ${messageText}`
  );
  const recipientModel = getMemberModel(deps.db, teamInfo.teamId, args.to);
  deps.client.session.promptAsync({
    sessionID: recipientSessionId,
    parts: [{ type: "text", text: wake.text }],
    ...wake.agent ? { agent: wake.agent } : {},
    ...recipientModel ? { model: recipientModel } : {}
  }).then(() => {
    markDelivered(deps.db, msgId);
  }).catch((err) => {
    log(`team_message:deliver:failed to=${args.to} err=${err instanceof Error ? err.message : String(err)}`);
    if (wake.woke) {
      deps.db.run(
        "UPDATE team_member SET execution_status = 'standby', time_updated = ? WHERE team_id = ? AND name = ? AND execution_status = 'starting'",
        [Date.now(), teamInfo.teamId, args.to]
      );
      log(`team_message:wake:reverted to=standby name=${args.to} (promptAsync failed)`);
    }
  });
  return wake.woke ? `Message sent to ${args.to} (woke from standby \u2014 original spawn context prepended).` : `Message sent to ${args.to}.`;
}

// src/tools/team-broadcast.ts
init_log();
async function executeTeamBroadcast(deps, args, sessionId) {
  const teamInfo = requireTeamMember(deps, sessionId);
  const senderName = teamInfo.role === "lead" ? "lead" : teamInfo.memberName ?? "unknown";
  const msgId = broadcastMessage(deps.db, {
    teamId: teamInfo.teamId,
    from: senderName,
    content: args.text
  });
  const recipients = [];
  if (teamInfo.role !== "lead") {
    const leadSession = deps.db.query("SELECT lead_session_id FROM team WHERE id = ?").get(teamInfo.teamId);
    if (leadSession) recipients.push({ name: "lead", sessionId: leadSession.lead_session_id });
  }
  const members = deps.registry.listByTeam(teamInfo.teamId);
  for (const member of members) {
    if (member.sessionId !== sessionId) {
      recipients.push({ name: member.memberName, sessionId: member.sessionId });
    }
  }
  const baseText = `[Team broadcast from ${senderName}]: ${args.text}`;
  let delivered = 0;
  let skipped = 0;
  for (const recipient of recipients) {
    if (recipient.name !== "lead" && hasReportedCompletion(deps.db, teamInfo.teamId, recipient.name)) {
      skipped++;
      continue;
    }
    const wake = recipient.name !== "lead" ? resolveStandbyWake(deps.db, teamInfo.teamId, recipient.name, baseText) : { text: baseText, woke: false };
    deps.client.session.promptAsync({
      sessionID: recipient.sessionId,
      parts: [{ type: "text", text: wake.text }],
      ...wake.agent ? { agent: wake.agent } : {}
    }).then(() => {
      delivered++;
      if (delivered === 1) markDelivered(deps.db, msgId);
    }).catch((err) => {
      log(`team_broadcast:deliver:failed to=${recipient.name} err=${err instanceof Error ? err.message : String(err)}`);
      if (wake.woke) {
        deps.db.run(
          "UPDATE team_member SET execution_status = 'standby', time_updated = ? WHERE team_id = ? AND name = ? AND execution_status = 'starting'",
          [Date.now(), teamInfo.teamId, recipient.name]
        );
        log(`team_broadcast:wake:reverted to=standby name=${recipient.name} (promptAsync failed)`);
      }
    });
  }
  const sent = recipients.length - skipped;
  return `Broadcast sent to ${sent} recipient${sent !== 1 ? "s" : ""}.`;
}

// src/tools/team-tasks-list.ts
async function executeTeamTasksList(deps, sessionId) {
  const teamInfo = requireTeamMember(deps, sessionId);
  const tasks = deps.db.query(
    "SELECT * FROM team_task WHERE team_id = ? ORDER BY time_created ASC"
  ).all(teamInfo.teamId);
  if (tasks.length === 0) return "No tasks on the board.";
  return tasks.map(
    (t) => `[${t.status}] ${t.content} (${t.id})${t.assignee ? ` \u2192 ${t.assignee}` : ""}${t.priority !== "medium" ? ` [${t.priority}]` : ""}`
  ).join("\n");
}

// src/tools/team-tasks-add.ts
async function executeTeamTasksAdd(deps, args, sessionId) {
  const teamInfo = requireTeamMember(deps, sessionId);
  const ids = [];
  const now = Date.now();
  const hasExplicitDependencies = args.tasks.some((t) => t.depends_on && t.depends_on.length > 0);
  const isSequential = args.sequential === true || args.tasks.length > 1 && !hasExplicitDependencies;
  for (let i = 0; i < args.tasks.length; i++) {
    const task = args.tasks[i];
    if (!task) continue;
    const id = generateId("task");
    ids.push(id);
    if (isSequential && i > 0) {
      if (!task.depends_on) task.depends_on = [];
      const prevId = ids[i - 1];
      if (prevId && !task.depends_on.includes(prevId)) {
        task.depends_on.push(prevId);
      }
    }
    const depsJson = task.depends_on?.length ? JSON.stringify(task.depends_on) : null;
    let status = "pending";
    if (task.depends_on?.length) {
      const resolved = task.depends_on.every((depId) => {
        if (ids.includes(depId)) return false;
        const dep = deps.db.query("SELECT status FROM team_task WHERE id = ? AND team_id = ?").get(depId, teamInfo.teamId);
        return dep && (dep.status === "completed" || dep.status === "cancelled");
      });
      if (!resolved) status = "blocked";
    }
    deps.db.run(
      "INSERT INTO team_task (id, team_id, content, status, priority, depends_on, time_created, time_updated) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
      [id, teamInfo.teamId, task.content, status, task.priority, depsJson, now, now]
    );
  }
  return `Added ${ids.length} task${ids.length !== 1 ? "s" : ""}: ${ids.join(", ")}`;
}

// src/tools/team-tasks-complete.ts
init_log();
async function executeTeamTasksComplete(deps, args, sessionId) {
  const teamInfo = requireTeamMember(deps, sessionId);
  const caller = teamInfo.role === "lead" ? "lead" : teamInfo.memberName ?? "unknown";
  const task = deps.db.query("SELECT id, content, status, assignee FROM team_task WHERE id = ? AND team_id = ?").get(args.task_id, teamInfo.teamId);
  if (!task) throw new Error(`Task "${args.task_id}" not found`);
  if (task.status === "completed") throw new Error(`Task "${args.task_id}" is already completed`);
  if (task.status === "cancelled") throw new Error(`Task "${args.task_id}" was cancelled`);
  if (task.status === "blocked") throw new Error(`Task "${args.task_id}" is blocked by unresolved dependencies`);
  if (task.status === "in_progress" && task.assignee && teamInfo.role !== "lead" && caller !== task.assignee) {
    throw new Error(`Task "${args.task_id}" is claimed by ${task.assignee}`);
  }
  const now = Date.now();
  if (task.assignee) {
    deps.db.run("UPDATE team_task SET status = 'completed', time_updated = ? WHERE id = ?", [now, args.task_id]);
  } else {
    const result = deps.db.run(
      "UPDATE team_task SET status = 'completed', assignee = ?, time_updated = ? WHERE id = ? AND assignee IS NULL",
      [caller, now, args.task_id]
    );
    if (result.changes === 0) {
      throw new Error(`Task "${args.task_id}" was just completed by another teammate`);
    }
  }
  const allTasks = deps.db.query("SELECT id, depends_on, status, assignee FROM team_task WHERE team_id = ?").all(teamInfo.teamId);
  let unblocked = 0;
  let wokeMembers = 0;
  for (const t of allTasks) {
    if (t.status !== "blocked" || !t.depends_on) continue;
    const depIds = JSON.parse(t.depends_on);
    if (!depIds.includes(args.task_id)) continue;
    const allResolved = depIds.every((depId) => {
      if (depId === args.task_id) return true;
      const dep = allTasks.find((d) => d.id === depId);
      return dep && (dep.status === "completed" || dep.status === "cancelled");
    });
    if (allResolved) {
      deps.db.run("UPDATE team_task SET status = 'pending', time_updated = ? WHERE id = ?", [now, t.id]);
      unblocked++;
      if (t.assignee) {
        const memberRow = deps.db.query("SELECT session_id FROM team_member WHERE team_id = ? AND name = ?").get(teamInfo.teamId, t.assignee);
        const memberSessionId = memberRow?.session_id;
        if (memberSessionId) {
          const wake = resolveStandbyWake(deps.db, teamInfo.teamId, t.assignee, `[System: Task "${t.id}" was unblocked and is ready for you to start]`);
          if (wake.woke) {
            deps.client.session.promptAsync({
              sessionID: memberSessionId,
              parts: [{ type: "text", text: wake.text }],
              agent: wake.agent,
              synthetic: true
            }).catch((err) => log(`tasks-complete:wake-member:failed err=${String(err)}`));
            log(`tasks-complete:wake-member:ok member=${t.assignee} task=${t.id}`);
            wokeMembers++;
          }
        }
      }
    }
  }
  const counts = deps.db.query(
    "SELECT status, COUNT(*) as c FROM team_task WHERE team_id = ? GROUP BY status"
  ).all(teamInfo.teamId);
  const completed = counts.find((r) => r.status === "completed")?.c ?? 0;
  const total = counts.reduce((sum, r) => sum + r.c, 0);
  const who = teamInfo.memberName ?? "teammate";
  try {
    deps.client.tui.showToast({
      title: "Team",
      message: `${who}: ${completed}/${total} tasks complete`,
      variant: "info",
      duration: 3e3
    }).catch(() => {
    });
  } catch {
    log(`tasks-complete:toast:failed`);
  }
  if (total > 0 && completed === total) {
    const lead = deps.db.query("SELECT lead_session_id FROM team WHERE id = ?").get(teamInfo.teamId);
    if (lead?.lead_session_id) {
      deps.client.session.promptAsync({
        sessionID: lead.lead_session_id,
        parts: [{ type: "text", text: `[System: All team tasks completed on board by ${who}]` }],
        synthetic: true
      }).catch((err) => {
        log(`tasks-complete:wake-lead:failed err=${String(err)}`);
      });
      log(`tasks-complete:wake-lead:sent leadSession=${lead.lead_session_id} by=${who}`);
    }
  }
  let unblockedMsg = "";
  if (unblocked > 0) {
    unblockedMsg = ` (unblocked ${unblocked} task${unblocked !== 1 ? "s" : ""}`;
    if (wokeMembers > 0) {
      unblockedMsg += `, woke ${wokeMembers} member${wokeMembers !== 1 ? "s" : ""}`;
    }
    unblockedMsg += ")";
  }
  return `Completed task: ${task.content}${unblockedMsg}`;
}

// src/result-parser.ts
function parseTaskResult(content) {
  const match = content.match(/<task-result>([\s\S]*?)<\/task-result>/);
  if (!match) return null;
  const inner = match[1];
  const status = inner.match(/<status>([\s\S]*?)<\/status>/)?.[1]?.trim();
  const summary = inner.match(/<summary>([\s\S]*?)<\/summary>/)?.[1]?.trim();
  const details = inner.match(/<details>([\s\S]*?)<\/details>/)?.[1]?.trim();
  const branch = inner.match(/<branch>([\s\S]*?)<\/branch>/)?.[1]?.trim();
  if (!status || !summary || !details) return null;
  return { status, summary, details, branch: branch || void 0 };
}
function formatTaskResult(from, result) {
  const lines = [
    `[Result from ${from}]:`,
    `  Status: ${result.status}`,
    `  Summary: ${result.summary}`,
    `  Details: ${result.details}`
  ];
  if (result.branch) lines.push(`  Branch: ${result.branch}`);
  return lines.join("\n");
}

// src/tools/team-results.ts
async function executeTeamResults(deps, args, sessionId) {
  const team = requireTeamMember(deps, sessionId);
  const rows = args.from ? deps.db.query(
    "SELECT id, from_name, content, time_created FROM team_message WHERE team_id = ? AND read = 0 AND from_name = ? ORDER BY time_created ASC"
  ).all(team.teamId, args.from) : deps.db.query(
    "SELECT id, from_name, content, time_created FROM team_message WHERE team_id = ? AND read = 0 ORDER BY time_created ASC"
  ).all(team.teamId);
  if (rows.length === 0) return "No unread messages.";
  const ids = rows.map((r) => r.id);
  const placeholders = ids.map(() => "?").join(", ");
  deps.db.run(`UPDATE team_message SET read = 1 WHERE id IN (${placeholders})`, ids);
  return rows.map((r) => {
    const parsed = parseTaskResult(r.content);
    if (parsed) return formatTaskResult(r.from_name, parsed);
    return `[Message from ${r.from_name}]:
${r.content}`;
  }).join("\n\n");
}

// src/tools/team-shutdown.ts
init_merge_helper();
init_log();
async function executeTeamShutdown(deps, args, sessionId, isDirty = checkWorktreeDirty, preserve = preserveBranch, commitCount = countBranchCommits) {
  const teamInfo = requireLead(deps, sessionId);
  const member = deps.db.query("SELECT session_id, status, worktree_branch, worktree_dir FROM team_member WHERE team_id = ? AND name = ?").get(teamInfo.teamId, args.member);
  if (!member) throw new Error(`Teammate "${args.member}" not found in team "${teamInfo.teamName}"`);
  if (member.status === "shutdown") throw new Error(`Teammate "${args.member}" is already shut down`);
  const force = args.force ?? false;
  if (member.status === "shutdown_requested") {
    await preserveAndAbort(deps, teamInfo.teamId, args.member, member.session_id, member.worktree_branch, preserve);
    const status = await getBranchStatus(deps, teamInfo.teamId, args.member, member.worktree_dir, isDirty, commitCount);
    return `Force shut down "${args.member}".${status}`;
  }
  let isIdle = false;
  try {
    const statuses = await deps.client.session.status();
    const sessionStatus = statuses.data?.[member.session_id];
    isIdle = !sessionStatus || sessionStatus.type === "idle";
  } catch {
  }
  if (isIdle || force) {
    await preserveAndAbort(deps, teamInfo.teamId, args.member, member.session_id, member.worktree_branch, preserve);
    const status = await getBranchStatus(deps, teamInfo.teamId, args.member, member.worktree_dir, isDirty, commitCount);
    return `Teammate "${args.member}" has been shut down.${status}`;
  }
  if (member.worktree_branch) {
    const resource = getTeamResourceParts(deps.db, teamInfo.teamId);
    const safeBranch = preservedBranchName(resource.projectName, resource.teamName, resource.teamId, args.member);
    const ok = await preserve(member.worktree_branch, safeBranch, deps.directory);
    if (ok) {
      deps.db.run(
        "UPDATE team_member SET worktree_branch = ? WHERE team_id = ? AND name = ?",
        [safeBranch, teamInfo.teamId, args.member]
      );
      log(`shutdown:branch:preserved-graceful src=${member.worktree_branch} target=${safeBranch}`);
    }
  }
  try {
    deps.client.session.promptAsync({
      sessionID: member.session_id,
      parts: [{
        type: "text",
        text: `[Shutdown requested]: The lead has requested you shut down. Finish your current task, send your final findings to the lead via team_message, then stop.`
      }]
    }).catch(() => {
    });
  } catch {
  }
  deps.db.run(
    "UPDATE team_member SET status = 'shutdown_requested', time_updated = ? WHERE team_id = ? AND name = ?",
    [Date.now(), teamInfo.teamId, args.member]
  );
  return `Shutdown requested for ${args.member}. They will finish current work and shut down. Call team_shutdown with force: true to abort immediately.`;
}
async function preserveAndAbort(deps, teamId, memberName, sessionId, worktreeBranch, preserve) {
  if (worktreeBranch && !worktreeBranch.startsWith("ensemble/preserved/")) {
    const resource = getTeamResourceParts(deps.db, teamId);
    const safeBranch = preservedBranchName(resource.projectName, resource.teamName, resource.teamId, memberName);
    const ok = await preserve(worktreeBranch, safeBranch, deps.directory);
    if (ok) {
      deps.db.run(
        "UPDATE team_member SET worktree_branch = ? WHERE team_id = ? AND name = ?",
        [safeBranch, teamId, memberName]
      );
      log(`shutdown:branch:preserved src=${worktreeBranch} target=${safeBranch}`);
    } else {
      log(`shutdown:branch:preserve-failed src=${worktreeBranch} target=${safeBranch}`);
    }
  }
  try {
    await deps.client.session.abort({ sessionID: sessionId });
  } catch {
  }
  deps.db.run(
    "UPDATE team_member SET status = 'shutdown', execution_status = 'idle', time_updated = ? WHERE team_id = ? AND name = ?",
    [Date.now(), teamId, memberName]
  );
  const released = releaseMemberTasks(deps.db, teamId, memberName);
  if (released > 0) log(`shutdown:tasks:released name=${memberName} count=${released}`);
}
async function getBranchStatus(deps, teamId, memberName, worktreeDir, isDirty, commitCount) {
  const row = deps.db.query("SELECT worktree_branch FROM team_member WHERE team_id = ? AND name = ?").get(teamId, memberName);
  if (!row?.worktree_branch) return "";
  const branch = row.worktree_branch;
  const parts = [];
  const commits = await commitCount(branch, deps.directory);
  const dirty = worktreeDir ? await isDirty(worktreeDir).catch(() => false) : false;
  if (commits > 0 && dirty) {
    parts.push(`${memberName} committed ${commits} change${commits !== 1 ? "s" : ""} and has uncommitted work.`);
  } else if (commits > 0) {
    parts.push(`${memberName} committed ${commits} change${commits !== 1 ? "s" : ""}. Ready to merge.`);
  } else if (dirty) {
    parts.push(`${memberName} has uncommitted changes only \u2014 their work may be incomplete.`);
  } else if (commits < 0) {
    parts.push(`Could not determine ${memberName}'s commit status. Merge to check their work.`);
  } else {
    parts.push(`${memberName} made no changes.`);
  }
  parts.push(`Branch: ${branch}`);
  parts.push("Use team_merge to merge their work.");
  return `
${parts.join("\n")}`;
}

// src/tools/team-cleanup.ts
init_merge_helper();
init_log();
init_process();
async function listPreservedBranches(teamName, cwd) {
  try {
    const result = await runCommand(["git", "branch", "--list", `ensemble/preserved/${teamName}/*`, "--format", "%(refname:short)"], { cwd });
    if (result.exitCode !== 0) throw new Error(result.stderr.trim() || `git branch exited with code ${result.exitCode}`);
    return result.stdout.split("\n").map((branch) => branch.trim()).filter(Boolean);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (message.includes("not a git repository")) return [];
    throw new Error(`Failed to list preserved branches for ${teamName}: ${err instanceof Error ? err.message : String(err)}`);
  }
}
async function branchExists(branch, cwd) {
  try {
    const result = await runCommand(["git", "branch", "--list", branch, "--format", "%(refname:short)"], { cwd });
    if (result.exitCode !== 0) {
      if (result.stderr.includes("not a git repository")) return false;
      throw new Error(result.stderr.trim() || `git branch exited with code ${result.exitCode}`);
    }
    return result.stdout.split("\n").map((item) => item.trim()).includes(branch);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (message.includes("not a git repository")) return false;
    throw new Error(`Failed to check stale Ensemble branch ${branch}: ${message}`);
  }
}
function normalizeBranchName(branch) {
  return branch.trim().replace(/^\*\s*/, "");
}
function resolvePurgeTargets(deps, purge) {
  if (purge.length === 0) throw new Error("Pass at least one archived team name to purge, or ['*'] for all archived teams.");
  if (purge.includes("*") && purge.length !== 1) {
    throw new Error("Wildcard purge cannot be combined with explicit team names. Use purge: ['*'] by itself.");
  }
  if (purge.includes("*")) {
    return deps.db.query("SELECT t.id, t.name, t.project_id, p.name as project_name, t.time_updated FROM team t JOIN project p ON t.project_id = p.id WHERE t.status = 'archived' AND t.project_id = ? ORDER BY t.time_updated DESC, t.name ASC").all(deps.directory);
  }
  const uniqueNames = [...new Set(purge)];
  const rows = uniqueNames.map((name) => ({
    name,
    teams: deps.db.query("SELECT t.id, t.name, t.project_id, p.name as project_name, t.status, t.time_updated FROM team t JOIN project p ON t.project_id = p.id WHERE t.name = ? AND t.project_id = ? ORDER BY t.time_updated DESC").all(name, deps.directory)
  }));
  const missing = rows.filter((row) => row.teams.length === 0).map((row) => row.name);
  if (missing.length > 0) throw new Error(`Team not found: ${missing.join(", ")}`);
  const active = rows.filter((row) => row.teams.some((team) => team.status === "active")).map((row) => row.name);
  if (active.length > 0) throw new Error(`Cannot purge active team: ${active.join(", ")}`);
  return rows.map((row) => row.teams[0]).sort((a, b) => b.time_updated - a.time_updated || a.name.localeCompare(b.name));
}
function deleteArchivedTeams(deps, targets) {
  const transaction = deps.db.transaction((teams) => {
    teams.forEach((team) => {
      const row = deps.db.query("SELECT status FROM team WHERE id = ?").get(team.id);
      if (!row) throw new Error(`Team not found: ${team.name}`);
      if (row.status === "active") throw new Error(`Cannot purge active team: ${team.name}`);
    });
    validatePurgeResources(deps, teams);
    teams.forEach((team) => {
      deps.db.run("DELETE FROM team WHERE id = ? AND status = 'archived'", [team.id]);
    });
  });
  transaction(targets);
  targets.forEach((team) => {
    deps.registry.unregisterTeam(team.id);
    spawnFailures.delete(team.id);
  });
}
function getPurgeMemberResources(deps, targets) {
  return targets.flatMap((target) => deps.db.query(
    `SELECT t.name as team_name,
            p.name as project_name,
            tm.team_id,
            tm.name as member_name,
            tm.worktree_dir,
            tm.workspace_id,
            tm.worktree_branch
     FROM team_member tm
     JOIN team t ON tm.team_id = t.id
     JOIN project p ON t.project_id = p.id
     WHERE tm.team_id = ?`
  ).all(target.id));
}
function preservedBranchPrefix(resource) {
  return `ensemble/preserved/${resource.project_name}/${teamResourceSegment(resource.team_name, resource.team_id)}/`;
}
function legacyPreservedBranchPrefix(resource) {
  return `ensemble/preserved/${resource.team_name}/`;
}
function staleEnsembleBranchNames(resource) {
  return [
    `ensemble-${resource.team_id}-${resource.member_name}`,
    `ensemble-${resource.team_name}-${resource.member_name}`,
    `opencode/ensemble-${resource.team_name}-${resource.member_name}`
  ];
}
function isPreservedBranch(resource) {
  return resource.worktree_branch !== null && (resource.worktree_branch.startsWith(preservedBranchPrefix(resource)) || resource.worktree_branch.startsWith(legacyPreservedBranchPrefix(resource)));
}
function isStaleEnsembleBranch(resource) {
  return resource.worktree_branch !== null && staleEnsembleBranchNames(resource).includes(resource.worktree_branch);
}
function validatePurgeResources(deps, targets) {
  const resources = getPurgeMemberResources(deps, targets);
  const nonPreserved = resources.filter(
    (resource) => resource.worktree_branch !== null && !isPreservedBranch(resource) && !isStaleEnsembleBranch(resource)
  );
  if (nonPreserved.length > 0) {
    const details = nonPreserved.map((resource) => `${resource.team_name}/${resource.member_name} (${resource.worktree_branch})`).join(", ");
    throw new Error(`Cannot purge archived teams: ${details} has a non-preserved worktree branch or a branch outside its preserved namespace.`);
  }
  const activeResourceRefs = resources.flatMap((resource) => {
    const worktreeRefs = resource.worktree_dir ? deps.db.query(
      `SELECT t.name as team_name, tm.name as member_name
         FROM team_member tm
         JOIN team t ON tm.team_id = t.id
         WHERE t.status = 'active' AND tm.worktree_dir = ?`
    ).all(resource.worktree_dir) : [];
    const workspaceRefs = resource.workspace_id ? deps.db.query(
      `SELECT t.name as team_name, tm.name as member_name
         FROM team_member tm
         JOIN team t ON tm.team_id = t.id
         WHERE t.status = 'active' AND tm.workspace_id = ?`
    ).all(resource.workspace_id) : [];
    return [
      ...worktreeRefs.map((ref) => `${resource.team_name}/${resource.member_name} worktree is also referenced by active team ${ref.team_name}/${ref.member_name}`),
      ...workspaceRefs.map((ref) => `${resource.team_name}/${resource.member_name} workspace is also referenced by active team ${ref.team_name}/${ref.member_name}`)
    ];
  });
  if (activeResourceRefs.length > 0) {
    throw new Error(`Cannot purge archived teams: ${[...new Set(activeResourceRefs)].join(", ")}.`);
  }
}
function collectStaleEnsembleBranches(deps, targets) {
  return [...new Set(
    getPurgeMemberResources(deps, targets).filter(isStaleEnsembleBranch).map((resource) => resource.worktree_branch)
  )];
}
function countStaleResourceRefs(deps, target) {
  return getPurgeMemberResources(deps, [target]).reduce(
    (count, resource) => count + (resource.worktree_dir ? 1 : 0) + (resource.workspace_id ? 1 : 0),
    0
  );
}
function countStaleBranchRefs(deps, target) {
  return collectStaleEnsembleBranches(deps, [target]).length;
}
async function existingWorktreeDirs(deps, resources) {
  if (!resources.some((resource) => resource.worktree_dir)) return /* @__PURE__ */ new Set();
  try {
    const result = await deps.client.worktree.list();
    return new Set((result.data ?? []).map((worktree) => worktree.directory));
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(`Cannot purge archived teams: failed to list worktrees before stale resource cleanup: ${message}`);
  }
}
async function existingWorkspaceIds(deps, resources) {
  if (!resources.some((resource) => resource.workspace_id)) return /* @__PURE__ */ new Set();
  try {
    const result = await deps.client.workspace.list();
    return new Set((result.data ?? []).map((workspace) => workspace.id));
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(`Cannot purge archived teams: failed to list workspaces before stale resource cleanup: ${message}`);
  }
}
async function cleanupStalePurgeResources(deps, targets, isDirty) {
  const resources = getPurgeMemberResources(deps, targets).filter((resource) => resource.worktree_dir || resource.workspace_id);
  if (resources.length === 0) return;
  const worktreeDirs = await existingWorktreeDirs(deps, resources);
  const workspaceIds = await existingWorkspaceIds(deps, resources);
  for (const resource of resources) {
    if (resource.workspace_id) {
      if (workspaceIds.has(resource.workspace_id)) {
        try {
          await deps.client.workspace.remove({ id: resource.workspace_id });
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          throw new Error(`Failed to remove stale workspace for ${resource.team_name}/${resource.member_name}: ${message}`);
        }
      }
      deps.db.run("UPDATE team_member SET workspace_id = NULL WHERE team_id = ? AND name = ?", [resource.team_id, resource.member_name]);
    }
    if (resource.worktree_dir) {
      if (worktreeDirs.has(resource.worktree_dir)) {
        let dirty;
        try {
          dirty = await isDirty(resource.worktree_dir);
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          throw new Error(`Cannot purge archived teams: failed to check archived worktree for uncommitted changes at ${resource.worktree_dir}: ${message}`);
        }
        if (dirty) {
          throw new Error(`Cannot purge archived teams: ${resource.team_name}/${resource.member_name} has uncommitted changes in archived worktree ${resource.worktree_dir}.`);
        }
        try {
          await deps.client.worktree.remove({ worktreeRemoveInput: { directory: resource.worktree_dir } });
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          throw new Error(`Failed to remove stale worktree for ${resource.team_name}/${resource.member_name}: ${message}`);
        }
      }
      deps.db.run("UPDATE team_member SET worktree_dir = NULL WHERE team_id = ? AND name = ?", [resource.team_id, resource.member_name]);
    }
  }
}
async function deleteStaleEnsembleBranches(branches, cwd, delBranch, exists) {
  for (const branch of branches) {
    if (!await exists(branch, cwd)) continue;
    const ok = await delBranch(branch, cwd);
    if (!ok) throw new Error(`Failed to delete stale Ensemble branch: ${branch}`);
  }
}
function validatePurgeTargetsStillArchived(deps, targets) {
  const missing = [];
  const active = [];
  targets.forEach((target) => {
    const row = deps.db.query("SELECT status FROM team WHERE id = ?").get(target.id);
    if (!row) missing.push(target.name);
    else if (row.status === "active") active.push(target.name);
  });
  if (missing.length > 0) throw new Error(`Team not found: ${missing.join(", ")}`);
  if (active.length > 0) throw new Error(`Cannot purge active team: ${active.join(", ")}`);
}
async function collectPreservedBranches(targets, cwd, listBranches) {
  const entries = await Promise.all(targets.map(async (target) => {
    const prefixes = [`ensemble/preserved/${target.project_name}/${teamResourceSegment(target.name, target.id)}/`, `ensemble/preserved/${target.name}/`];
    let listed;
    try {
      listed = [...await listBranches(target.project_name, cwd), ...await listBranches(target.name, cwd)];
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (message.includes("not a git repository")) listed = [];
      else throw new Error(`Failed to list preserved branches for ${target.id}: ${message}`);
    }
    const branches = listed.map(normalizeBranchName).filter((branch) => prefixes.some((prefix) => branch.startsWith(prefix)));
    return [target.id, [...new Set(branches)]];
  }));
  return new Map(entries);
}
async function deletePreservedBranches(branchesByTeam, cwd, delBranch) {
  const branches = [...branchesByTeam.values()].flat();
  for (const branch of branches) {
    const ok = await delBranch(branch, cwd);
    if (!ok) throw new Error(`Failed to delete preserved branch: ${branch}`);
  }
}
function formatCount(count, noun, plural = `${noun}s`) {
  return `${count} ${count === 1 ? noun : plural}`;
}
function buildPurgePreview(deps, targets, branchesByTeam) {
  const rows = targets.map((target) => {
    const members = deps.db.query("SELECT COUNT(*) as c FROM team_member WHERE team_id = ?").get(target.id).c;
    const tasks = deps.db.query("SELECT COUNT(*) as c FROM team_task WHERE team_id = ?").get(target.id).c;
    const messages = deps.db.query("SELECT COUNT(*) as c FROM team_message WHERE team_id = ?").get(target.id).c;
    const branches = branchesByTeam.get(target.id)?.length ?? 0;
    const staleResources = countStaleResourceRefs(deps, target);
    const staleBranches = countStaleBranchRefs(deps, target);
    return { ...target, members, tasks, messages, branches, staleResources, staleBranches };
  });
  const totals = rows.reduce(
    (acc, row) => ({
      members: acc.members + row.members,
      tasks: acc.tasks + row.tasks,
      messages: acc.messages + row.messages,
      branches: acc.branches + row.branches,
      staleResources: acc.staleResources + row.staleResources,
      staleBranches: acc.staleBranches + row.staleBranches
    }),
    { members: 0, tasks: 0, messages: 0, branches: 0, staleResources: 0, staleBranches: 0 }
  );
  const details = rows.slice(0, 10).map(
    (row) => `- ${row.name}: ${formatCount(row.members, "member")}, ${formatCount(row.tasks, "task")}, ${formatCount(row.messages, "message")}, ${formatCount(row.branches, "preserved branch", "preserved branches")}, ${formatCount(row.staleResources, "stale resource")}, ${formatCount(row.staleBranches, "stale branch", "stale branches")}`
  );
  const hidden = rows.length > 10 ? [`...and ${rows.length - 10} more archived team${rows.length - 10 === 1 ? "" : "s"}`] : [];
  return [
    "Permanently delete archived teams?",
    "This will delete archived team records and cascade-delete their members, tasks, and messages.",
    "",
    ...details,
    ...hidden,
    "",
    `Total: ${formatCount(rows.length, "team")}, ${formatCount(totals.members, "member")}, ${formatCount(totals.tasks, "task")}, ${formatCount(totals.messages, "message")}, ${formatCount(totals.branches, "preserved branch", "preserved branches")}, ${formatCount(totals.staleResources, "stale resource")}, ${formatCount(totals.staleBranches, "stale branch", "stale branches")}`
  ].join("\n");
}
function buildPurgeConfirmationInstructions(preview, confirmToken) {
  const approvalLabel = `Approve purge ${confirmToken.slice(0, 8)}`;
  const denialLabel = `Deny purge ${confirmToken.slice(0, 8)}`;
  return [
    "Purge preview only \u2014 no teams were deleted.",
    "",
    preview,
    "",
    "Use the question tool to ask the user whether to permanently delete these archived teams.",
    `The approval option label must be exactly: ${approvalLabel}`,
    `The denial option label must be exactly: ${denialLabel}`,
    `Confirmation token: ${confirmToken}`,
    `Only if the user selects "${approvalLabel}", call team_cleanup again with the same purge value, confirm_purge: true, and confirm_token set to this token.`
  ].join("\n");
}
async function executeTeamCleanup(deps, args, sessionId, isDirty = checkWorktreeDirty, merge = mergeBranch, delBranch = deleteBranch, mergeOnCleanup = true, overlapCheck = getOverlappingFiles, _approvePurge, _listBranches, _branchExists) {
  if (args.purge && args.purge.length > 0) {
    requireCanPurgeArchivedTeams(deps, sessionId);
    const targets = resolvePurgeTargets(deps, args.purge);
    if (targets.length === 0) return "No archived teams to purge.";
    validatePurgeTargetsStillArchived(deps, targets);
    validatePurgeResources(deps, targets);
    const branchesByTeam = await collectPreservedBranches(targets, deps.directory, _listBranches ?? listPreservedBranches);
    const preview = buildPurgePreview(deps, targets, branchesByTeam);
    if (!args.confirm_purge) {
      const confirmToken = deps.purgeApprovals.create(sessionId, targets.map((target) => target.id));
      return buildPurgeConfirmationInstructions(preview, confirmToken);
    }
    if (!args.confirm_token) {
      throw new Error("A purge confirmation token is required. First call team_cleanup without confirm_purge, then use the question tool before confirming.");
    }
    deps.purgeApprovals.consume(sessionId, args.confirm_token, targets.map((target) => target.id));
    validatePurgeTargetsStillArchived(deps, targets);
    validatePurgeResources(deps, targets);
    await cleanupStalePurgeResources(deps, targets, isDirty);
    validatePurgeResources(deps, targets);
    await deleteStaleEnsembleBranches(collectStaleEnsembleBranches(deps, targets), deps.directory, delBranch, _branchExists ?? branchExists);
    const finalBranchesByTeam = await collectPreservedBranches(targets, deps.directory, _listBranches ?? listPreservedBranches);
    await deletePreservedBranches(finalBranchesByTeam, deps.directory, delBranch);
    deleteArchivedTeams(deps, targets);
    const noun = targets.length === 1 ? "archived team" : "archived teams";
    return `Permanently deleted ${targets.length} ${noun}: ${targets.map((target) => target.name).join(", ")}.`;
  }
  const teamInfo = requireLead(deps, sessionId);
  const members = deps.db.query("SELECT name, session_id, status, worktree_dir, worktree_branch, workspace_id FROM team_member WHERE team_id = ?").all(teamInfo.teamId);
  const active = members.filter((m) => m.status !== "shutdown" && m.status !== "shutdown_requested" && m.status !== "error");
  if (active.length > 0 && !args.force) {
    const names = active.map((m) => m.name).join(", ");
    throw new Error(`Cannot clean up team "${teamInfo.teamName}": ${active.length} member(s) still active: ${names}. Use team_shutdown on each member first, or call team_cleanup with force: true to abort them immediately.`);
  }
  if (!args.acknowledge_uncommitted) {
    const dirty = [];
    for (const member of members) {
      if (member.worktree_dir) {
        try {
          if (await isDirty(member.worktree_dir)) {
            dirty.push({ name: member.name, branch: member.worktree_branch ?? "unknown" });
          }
        } catch {
          log(`cleanup:dirty-check:failed name=${member.name}`);
        }
      }
    }
    if (dirty.length > 0) {
      const warnings = dirty.map((d) => `  - ${d.name} (branch: ${d.branch})`).join("\n");
      return `Warning: ${dirty.length} teammate(s) have uncommitted changes in their worktrees:
${warnings}

Commit or merge their work first, then call team_cleanup with acknowledge_uncommitted: true to proceed.`;
    }
  }
  if (args.force) {
    for (const member of active) {
      if (member.worktree_branch && !member.worktree_branch.startsWith("ensemble/preserved/")) {
        const resource = getTeamResourceParts(deps.db, teamInfo.teamId);
        const safeBranch = preservedBranchName(resource.projectName, resource.teamName, resource.teamId, member.name);
        const ok = await preserveBranch(member.worktree_branch, safeBranch, deps.directory);
        if (ok) {
          deps.db.run(
            "UPDATE team_member SET worktree_branch = ? WHERE team_id = ? AND name = ?",
            [safeBranch, teamInfo.teamId, member.name]
          );
          member.worktree_branch = safeBranch;
        }
      }
      try {
        await deps.client.session.abort({ sessionID: member.session_id });
      } catch {
      }
    }
  }
  const unmerged = members.filter((m) => m.worktree_branch !== null);
  const merged = [];
  const conflicted = [];
  const overlapWarnings = [];
  if (unmerged.length > 0 && mergeOnCleanup) {
    for (const member of unmerged) {
      const branch = member.worktree_branch;
      try {
        const overlap = await overlapCheck(branch, deps.directory);
        if (overlap.length > 0) {
          overlapWarnings.push(`${member.name}: ${overlap.join(", ")}`);
        }
      } catch {
      }
      const result = await merge(branch, deps.directory);
      if (result.ok) {
        await delBranch(branch, deps.directory);
        deps.db.run("UPDATE team_member SET worktree_branch = NULL WHERE team_id = ? AND name = ?", [teamInfo.teamId, member.name]);
        merged.push(`${member.name} (${branch})`);
      } else {
        log(`cleanup:merge:conflict member=${member.name} branch=${branch} err=${result.error}`);
        conflicted.push(`${member.name} (${branch})`);
      }
    }
  }
  for (const member of members) {
    if (member.workspace_id) {
      try {
        await deps.client.workspace.remove({ id: member.workspace_id });
        deps.db.run("UPDATE team_member SET workspace_id = NULL WHERE team_id = ? AND name = ?", [teamInfo.teamId, member.name]);
      } catch {
      }
    }
    if (member.worktree_dir) {
      try {
        await deps.client.worktree.remove({ worktreeRemoveInput: { directory: member.worktree_dir } });
        deps.db.run("UPDATE team_member SET worktree_dir = NULL WHERE team_id = ? AND name = ?", [teamInfo.teamId, member.name]);
      } catch {
      }
    }
  }
  deps.db.run("UPDATE team SET status = 'archived', time_updated = ? WHERE id = ?", [Date.now(), teamInfo.teamId]);
  deps.registry.unregisterTeam(teamInfo.teamId);
  spawnFailures.delete(teamInfo.teamId);
  const parts = [`Team "${teamInfo.teamName}" cleaned up.`];
  if (merged.length > 0) {
    parts.push(`Safety-net merged ${merged.length} unmerged branch(es): ${merged.join(", ")}. Review with: git diff`);
  }
  if (conflicted.length > 0) {
    parts.push(`Could not auto-merge: ${conflicted.join(", ")}. Merge manually.`);
  }
  if (overlapWarnings.length > 0) {
    parts.push(`Warning: safety-net merge overwrote local changes to overlapping files:
${overlapWarnings.map((w) => `  - ${w}`).join("\n")}
Review with: git diff`);
  }
  return parts.join("\n");
}

// src/tools/team-merge.ts
init_merge_helper();
init_log();
async function executeTeamMerge(deps, args, sessionId, merge = mergeBranch, delBranch = deleteBranch, overlapCheck = getOverlappingFiles, commitCount = countBranchCommits, isDirty = checkWorktreeDirty) {
  const teamInfo = requireLead(deps, sessionId);
  const member = deps.db.query("SELECT status, worktree_branch, worktree_dir FROM team_member WHERE team_id = ? AND name = ?").get(teamInfo.teamId, args.member);
  if (!member) throw new Error(`Teammate "${args.member}" not found in team "${teamInfo.teamName}"`);
  if (member.status !== "shutdown" && member.status !== "error") {
    throw new Error(`Teammate "${args.member}" is still active (status: ${member.status}). Shut them down first with team_shutdown.`);
  }
  if (!member.worktree_branch) {
    throw new Error(`No branch to merge for "${args.member}". They may not have a worktree, or their work was already merged.`);
  }
  const branch = member.worktree_branch;
  log(`merge:start member=${args.member} branch=${branch}`);
  const commits = await commitCount(branch, deps.directory);
  if (commits === 0) {
    const dirty = member.worktree_dir ? await isDirty(member.worktree_dir).catch(() => false) : false;
    if (dirty) {
      return [
        `Nothing to merge for "${args.member}" \u2014 their branch (${branch}) has no commits.`,
        `Their worktree still has uncommitted changes that were never captured on the branch.`,
        `This work will be permanently lost if the worktree is removed (e.g. via team_cleanup).`,
        member.worktree_dir ? `Worktree: ${member.worktree_dir}` : ``,
        `Recover manually (copy files out of the worktree) before shutting down/cleaning up, or re-spawn and instruct them to commit their changes before reporting done.`
      ].filter(Boolean).join("\n");
    }
    return `Nothing to merge for "${args.member}" \u2014 their branch (${branch}) has no commits and no uncommitted changes. They made no changes.`;
  }
  try {
    const overlap = await overlapCheck(branch, deps.directory);
    if (overlap.length > 0) {
      const files = overlap.map((f) => `  - ${f}`).join("\n");
      return [
        `Cannot merge ${args.member} \u2014 you have local changes to the same files:`,
        files,
        ``,
        `Commit or stash your changes first, then retry team_merge.`,
        `Branch preserved: ${branch}`
      ].join("\n");
    }
  } catch {
    log(`merge:overlap-check:failed member=${args.member} branch=${branch}`);
  }
  const result = await merge(branch, deps.directory);
  if (!result.ok) {
    return [
      `Merge conflict merging ${args.member}'s branch (${branch}).`,
      `Resolve manually:`,
      `  git merge --squash ${branch}`,
      `  git reset HEAD`,
      ``,
      `Error: ${result.error}`
    ].join("\n");
  }
  await delBranch(branch, deps.directory);
  deps.db.run(
    "UPDATE team_member SET worktree_branch = NULL WHERE team_id = ? AND name = ?",
    [teamInfo.teamId, args.member]
  );
  log(`merge:done member=${args.member} branch=${branch}`);
  return `Merged ${args.member}'s changes into your working directory (unstaged). Review with: git diff`;
}

// src/tools/team-status.ts
var lastCallTime = /* @__PURE__ */ new Map();
var lastKnownState = /* @__PURE__ */ new Map();
var RATE_LIMIT_MS = 3e4;
function computeStateMarker(deps, teamId) {
  const row = deps.db.query(
    `SELECT MAX(x) as marker FROM (
       SELECT MAX(time_updated) as x FROM team_member WHERE team_id = ?
       UNION SELECT MAX(time_updated) FROM team_task WHERE team_id = ?
       UNION SELECT MAX(time_created) FROM team_message WHERE team_id = ?
     )`
  ).get(teamId, teamId, teamId);
  return row?.marker ?? 0;
}
function formatDuration(ms) {
  if (ms < 6e4) return `${Math.floor(ms / 1e3)}s`;
  if (ms < 36e5) return `${Math.floor(ms / 6e4)}m`;
  return `${Math.floor(ms / 36e5)}h`;
}
async function executeTeamStatus(deps, sessionId) {
  const teamInfo = requireTeamMember(deps, sessionId);
  const now = Date.now();
  const last = lastCallTime.get(teamInfo.teamId);
  const currentMarker = computeStateMarker(deps, teamInfo.teamId);
  if (last !== void 0 && now - last < RATE_LIMIT_MS && lastKnownState.get(teamInfo.teamId) === currentMarker) {
    return "No changes since last check.";
  }
  lastCallTime.set(teamInfo.teamId, now);
  lastKnownState.set(teamInfo.teamId, currentMarker);
  const members = deps.db.query(
    "SELECT name, session_id, agent, status, execution_status, worktree_branch, worktree_dir, plan_approval, time_updated, last_nudged_at, retry_until, retry_attempt FROM team_member WHERE team_id = ? ORDER BY time_created ASC"
  ).all(teamInfo.teamId);
  const tasks = deps.db.query(
    "SELECT status FROM team_task WHERE team_id = ?"
  ).all(teamInfo.teamId);
  const lines = [];
  lines.push(`Team: ${teamInfo.teamName} (you are the ${teamInfo.role})`);
  lines.push("");
  if (members.length === 0) {
    lines.push("No teammates spawned yet.");
  } else {
    lines.push("Members:");
    for (const m of members) {
      const statusIcon = m.status === "busy" ? "working" : m.status === "ready" ? "idle" : m.status;
      const duration = formatDuration(now - m.time_updated);
      const branch = m.worktree_branch ? `  branch: ${m.worktree_branch}` : "";
      const plan = m.plan_approval !== "none" ? `, plan: ${m.plan_approval}` : "";
      const nudged = m.last_nudged_at ? `, nudged ${formatDuration(now - m.last_nudged_at)} ago` : "";
      const isRetrying = m.retry_until !== null && m.retry_until > now;
      const retrying = isRetrying ? `, retrying (attempt ${m.retry_attempt}, ~${formatDuration(m.retry_until - now)})` : "";
      const lastMsg = deps.db.query("SELECT MAX(time_created) as last_msg FROM team_message WHERE team_id = ? AND from_name = ?").get(teamInfo.teamId, m.name);
      const msgInfo = lastMsg?.last_msg ? `last msg: ${formatDuration(now - lastMsg.last_msg)} ago` : "no messages yet";
      lines.push(`  ${m.name}  [${statusIcon} ${duration}, ${msgInfo}${plan}${nudged}${retrying}]  agent: ${m.agent}${branch}`);
      const task = deps.db.query("SELECT content FROM team_task WHERE team_id = ? AND assignee = ? AND status = 'in_progress' LIMIT 1").get(teamInfo.teamId, m.name);
      if (task) {
        const truncated = task.content.length > 80 ? `${task.content.slice(0, 80)}...` : task.content;
        lines.push(`    task: ${truncated}`);
      }
      if (m.worktree_dir) {
        lines.push(`    worktree: ${m.worktree_dir}`);
      }
    }
  }
  if (tasks.length > 0) {
    const byStatus = /* @__PURE__ */ new Map();
    for (const t of tasks) {
      byStatus.set(t.status, (byStatus.get(t.status) ?? 0) + 1);
    }
    const parts = Array.from(byStatus.entries()).map(([s, n]) => `${n} ${s}`);
    lines.push("");
    lines.push(`Tasks: ${tasks.length} total (${parts.join(", ")})`);
  }
  if (members.length > 0) {
    const memberParts = members.map((m) => {
      const label = m.status === "busy" ? "working" : m.status === "ready" ? "idle" : m.status;
      return `${m.name} [${label}]`;
    });
    let toastMsg = memberParts.join(", ");
    if (tasks.length > 0) {
      const completed = tasks.filter((t) => t.status === "completed").length;
      toastMsg += ` | Tasks: ${completed}/${tasks.length} done`;
    }
    try {
      await deps.client.tui.showToast({
        title: "Team",
        message: toastMsg,
        variant: "info",
        duration: 4e3
      });
    } catch {
    }
  }
  return lines.join("\n");
}

// src/tools/team-view.ts
async function executeTeamView(deps, args, sessionId) {
  const teamInfo = requireTeamMember(deps, sessionId);
  const member = deps.db.query("SELECT session_id, status, agent FROM team_member WHERE team_id = ? AND name = ?").get(teamInfo.teamId, args.member);
  if (!member) throw new Error(`Teammate "${args.member}" not found in team "${teamInfo.teamName}"`);
  if (args.navigate !== true) {
    return `${args.member}'s session: ${member.session_id} (status: ${member.status}, agent: ${member.agent}). Open it from the session picker (ctrl+p) \u2014 or ask to view it and I'll switch for you.`;
  }
  try {
    await deps.client.tui.selectSession({ sessionID: member.session_id });
    return `Switched to ${args.member}'s session. Use the session picker (ctrl+p) to return.`;
  } catch {
    return `Could not switch to ${args.member}'s session (${member.session_id}). The session may not be accessible from the TUI.`;
  }
}

// src/v2-tools.ts
function str(description) {
  return { type: "string", description };
}
function bool(description, fallback) {
  return { type: "boolean", description, default: fallback };
}
var TASK_PRIORITIES = ["high", "medium", "low"];
function priority() {
  return { type: "string", description: "Task priority", enum: [...TASK_PRIORITIES], default: "medium" };
}
function normalizePriority(value) {
  if (value === void 0) return "medium";
  if (TASK_PRIORITIES.includes(value)) return value;
  throw new Error(`Invalid priority "${value}" \u2014 expected one of: high, medium, low.`);
}
async function registerV2Tools(domain, deps) {
  const run = (fn, track) => async (input, context) => {
    const args = input;
    track?.(context.sessionID, args);
    return { content: await fn(deps, args, context.sessionID) };
  };
  const runSession = (fn) => async (_input, context) => ({ content: await fn(deps, context.sessionID) });
  await domain.transform((editor) => {
    editor.add({
      name: "team_create",
      description: "Create a new agent team. You become the team lead. Use this before spawning teammates.",
      input: {
        type: "object",
        properties: {
          name: str("Team name (lowercase alphanumeric with hyphens, 1-64 chars)"),
          project_name: str("Project display name for first use of this working directory.")
        },
        required: ["name"],
        additionalProperties: false
      },
      execute: run(executeTeamCreate)
    });
    editor.add({
      name: "team_spawn",
      description: "Spawn a new teammate that works in parallel. The teammate starts immediately with the given prompt. Each teammate gets their own git worktree for file isolation. Teammates work asynchronously and will message you when done. Do not poll for their status.",
      input: {
        type: "object",
        properties: {
          name: str("Teammate name (lowercase alphanumeric with hyphens)"),
          agent: str("Agent type (e.g. 'build', 'plan', 'explore')"),
          prompt: str("Task instructions for the teammate"),
          model: str("Model in provider/model format (optional, uses default)"),
          claim_task: str("Task ID to auto-claim for this teammate (optional)"),
          worktree: bool("Create a git worktree for file isolation (default: true, set false for read-only agents)", true),
          plan_approval: bool("Require teammate to send a plan for approval before writing files (default: false)", false),
          standby: bool("Register the teammate WITHOUT sending its init prompt (zero tokens at birth). Stored as ready/standby with the full prompt in spawn_context; woken with the context prepended by the first team_message/team_broadcast (default: false)", false)
        },
        required: ["name", "prompt"],
        additionalProperties: false
      },
      execute: run(executeTeamSpawn)
    });
    editor.add({
      name: "team_message",
      description: "Send a message to a specific teammate or to the lead. Use 'lead' to message the team lead. Lead only: pass 'model' (provider/model) to update a teammate's model in-place.",
      input: {
        type: "object",
        properties: {
          to: str("Recipient name ('lead' or teammate name)"),
          text: str("Message content (max 10KB). Optional only when 'model' is provided."),
          approve: bool("Approve a teammate's plan (only when recipient has plan_approval='pending')", false),
          reject: str("Reject a teammate's plan with reason (only when recipient has plan_approval='pending')"),
          force: bool("Lead only. Re-activate a teammate who already reported task completion.", false),
          model: str("Lead only: update the recipient teammate's model in-place, in 'provider/model' format.")
        },
        required: ["to"],
        additionalProperties: false
      },
      execute: run(executeTeamMessage, (sessionID, args) => {
        const to = args.to ?? "";
        deps.progressTracker.recordMessage(sessionID);
        if (to !== "lead") deps.progressTracker.recordPeerMessage(sessionID);
      })
    });
    editor.add({
      name: "team_broadcast",
      description: "Send a message to all teammates and the lead (excluding yourself).",
      input: {
        type: "object",
        properties: { text: str("Message content (max 10KB)") },
        required: ["text"],
        additionalProperties: false
      },
      execute: run(
        executeTeamBroadcast,
        (sessionID) => {
          deps.progressTracker.recordMessage(sessionID);
          deps.progressTracker.recordPeerMessage(sessionID);
        }
      )
    });
    editor.add({
      name: "team_tasks_list",
      description: "View the shared team task board. Use this to check task status, not to wait for teammates. Teammates will message you when done.",
      input: { type: "object", properties: {}, additionalProperties: false },
      execute: runSession(executeTeamTasksList)
    });
    editor.add({
      name: "team_tasks_add",
      description: "Add tasks to the shared team task board so teammates can see what work is available and claim it.",
      input: {
        type: "object",
        properties: {
          tasks: {
            type: "array",
            description: "Tasks to add",
            items: {
              type: "object",
              properties: {
                content: str("Task description"),
                priority: priority(),
                depends_on: {
                  type: "array",
                  items: { type: "string" },
                  description: "Task IDs this depends on"
                }
              },
              required: ["content"],
              additionalProperties: false
            }
          },
          sequential: bool("If true, or if tasks.length > 1 and no depends_on is provided in any task, tasks are added in sequence where each task depends on the previous one", false)
        },
        required: ["tasks"],
        additionalProperties: false
      },
      execute: async (input, context) => {
        const args = input;
        const content = await executeTeamTasksAdd(
          deps,
          {
            tasks: args.tasks.map((task) => ({
              content: task.content,
              priority: normalizePriority(task.priority),
              ...task.depends_on ? { depends_on: task.depends_on } : {}
            })),
            sequential: args.sequential
          },
          context.sessionID
        );
        return { content };
      }
    });
    editor.add({
      name: "team_tasks_complete",
      description: "Mark a task as completed on the shared board. This unblocks any tasks that depend on it.",
      input: {
        type: "object",
        properties: { task_id: str("ID of the task to mark complete") },
        required: ["task_id"],
        additionalProperties: false
      },
      execute: run(
        executeTeamTasksComplete,
        (sessionID) => deps.progressTracker.recordTaskComplete(sessionID)
      )
    });
    editor.add({
      name: "team_claim",
      description: "Claim a pending task from the shared task list. Only unclaimed, unblocked tasks can be claimed.",
      input: {
        type: "object",
        properties: { task_id: str("ID of the task to claim") },
        required: ["task_id"],
        additionalProperties: false
      },
      execute: run(executeTeamClaim)
    });
    editor.add({
      name: "team_results",
      description: "Retrieve full message content from teammates. Returns unread messages and marks them as read. Use this after receiving a truncated message notification.",
      input: {
        type: "object",
        properties: { from: str("Filter messages by sender name (optional, returns all if omitted)") },
        additionalProperties: false
      },
      execute: run(executeTeamResults)
    });
    editor.add({
      name: "team_shutdown",
      description: "Request a teammate to shut down. The teammate finishes current work then stops. Pass force: true to abort immediately without waiting.",
      input: {
        type: "object",
        properties: {
          member: str("Teammate name to shut down"),
          force: bool("Force immediate abort without waiting for current work to finish", false)
        },
        required: ["member"],
        additionalProperties: false
      },
      execute: run(executeTeamShutdown)
    });
    editor.add({
      name: "team_cleanup",
      description: "Clean up the current team, or purge archived teams after human approval. Omit purge for normal cleanup.",
      input: {
        type: "object",
        properties: {
          force: bool("Force cleanup even if members are active (will abort them)", false),
          acknowledge_uncommitted: bool("Acknowledge uncommitted changes", false),
          purge: {
            type: "array",
            items: { type: "string" },
            description: "Archived team names to permanently delete, or ['*'] for all archived teams."
          },
          confirm_purge: bool("Set true only after the user explicitly approves the purge preview.", false),
          confirm_token: str("Confirmation token from the purge preview.")
        },
        additionalProperties: false
      },
      execute: async (input, context) => {
        const args = input;
        const content = await executeTeamCleanup(
          deps,
          {
            force: args.force ?? false,
            acknowledge_uncommitted: args.acknowledge_uncommitted,
            purge: args.purge,
            confirm_purge: args.confirm_purge,
            confirm_token: args.confirm_token
          },
          context.sessionID
        );
        return { content };
      }
    });
    editor.add({
      name: "team_merge",
      description: "Merge a shutdown teammate's branch into the working directory as unstaged changes. Use this after team_shutdown to review and integrate a teammate's work. The teammate must be shut down first.",
      input: {
        type: "object",
        properties: { member: str("Teammate name whose branch to merge") },
        required: ["member"],
        additionalProperties: false
      },
      execute: run(executeTeamMerge)
    });
    editor.add({
      name: "team_status",
      description: "View team members with their current status, agent type, and session IDs. Use this to check who is working, idle, or shut down. Includes a task summary.",
      input: { type: "object", properties: {}, additionalProperties: false },
      execute: runSession(executeTeamStatus)
    });
    editor.add({
      name: "team_view",
      description: "Resolve a teammate's session so the user can inspect it. Default reports the session ID + status without switching. navigate: true switches the user's client \u2014 ONLY when the user explicitly asked to view the teammate's session.",
      input: {
        type: "object",
        properties: {
          member: str("Teammate name to view"),
          navigate: bool("Switch the user's client to this session. Only when the user explicitly asked.", false)
        },
        required: ["member"],
        additionalProperties: false
      },
      execute: run(executeTeamView)
    });
  });
}

// src/progress.ts
var ProgressTracker = class {
  steps = /* @__PURE__ */ new Map();
  lastMessageAt = /* @__PURE__ */ new Map();
  lastTaskAt = /* @__PURE__ */ new Map();
  busySince = /* @__PURE__ */ new Map();
  peerMessages = /* @__PURE__ */ new Map();
  reported = /* @__PURE__ */ new Set();
  chattyReported = /* @__PURE__ */ new Set();
  maxSteps;
  constructor(maxSteps = 10) {
    this.maxSteps = maxSteps;
  }
  /** Record a model step completion with output token count. Keeps last `maxSteps` entries. */
  recordStep(sessionId, outputTokens) {
    const records = this.steps.get(sessionId) ?? [];
    records.push({ outputTokens, timestamp: Date.now() });
    if (records.length > this.maxSteps) records.shift();
    this.steps.set(sessionId, records);
  }
  /** Record a peer message (not to lead). Used for chatty detection. */
  recordPeerMessage(sessionId) {
    const timestamps = this.peerMessages.get(sessionId) ?? [];
    timestamps.push(Date.now());
    this.peerMessages.set(sessionId, timestamps);
  }
  /** Check if agent is chatty: more than `limit` peer messages within `windowMs`. */
  isChatty(sessionId, limit, windowMs) {
    if (limit === 0) return false;
    const timestamps = this.peerMessages.get(sessionId);
    if (!timestamps) return false;
    const cutoff = Date.now() - windowMs;
    const recent = timestamps.filter((t) => t >= cutoff);
    this.peerMessages.set(sessionId, recent);
    return recent.length >= limit;
  }
  /** Mark chatty as reported (avoid spam). */
  markChattyReported(sessionId) {
    this.chattyReported.add(sessionId);
  }
  /** Check if chatty already reported. */
  isChattyReported(sessionId) {
    return this.chattyReported.has(sessionId);
  }
  /** Clear chatty report (e.g., when agent sends result to lead). */
  clearChattyReport(sessionId) {
    this.chattyReported.delete(sessionId);
  }
  /** Record that this member sent a team_message. Clears stall report. */
  recordMessage(sessionId) {
    this.lastMessageAt.set(sessionId, Date.now());
    this.clearReport(sessionId);
  }
  /** Record that this member completed a task. Clears stall report. */
  recordTaskComplete(sessionId) {
    this.lastTaskAt.set(sessionId, Date.now());
    this.clearReport(sessionId);
  }
  /** Token-based stall: last `minSteps` steps all produced < `threshold` output tokens. */
  isTokenStalled(sessionId, minSteps, threshold) {
    const records = this.steps.get(sessionId);
    if (!records || records.length < minSteps) return false;
    const recent = records.slice(-minSteps);
    return recent.every((r) => r.outputTokens < threshold);
  }
  /**
   * Record that this member transitioned to busy. Gives isTimeStalled a baseline
   * independent of step records, so a member whose first (or only) action is one
   * long-running tool call is still subject to time-based stall detection before
   * any step-finish event has landed.
   */
  recordBusyStart(sessionId) {
    this.busySince.set(sessionId, Date.now());
  }
  /** Latest activity timestamp across all tracked signals (0 when nothing recorded). */
  lastActivityAt(sessionId) {
    const records = this.steps.get(sessionId);
    const lastStepAt = records && records.length > 0 ? records[records.length - 1].timestamp : 0;
    return Math.max(
      this.lastMessageAt.get(sessionId) ?? 0,
      this.lastTaskAt.get(sessionId) ?? 0,
      lastStepAt,
      this.busySince.get(sessionId) ?? 0
    );
  }
  /** Time-based stall: no message, task completion, step, or busy-transition within `thresholdMs` of now. */
  isTimeStalled(sessionId, thresholdMs) {
    const baseline = this.lastActivityAt(sessionId);
    if (baseline === 0) return false;
    return Date.now() - baseline >= thresholdMs;
  }
  /** Mark this session as reported-stalled (avoid spam). */
  markReported(sessionId) {
    this.reported.add(sessionId);
  }
  /** Check if already reported. */
  isReported(sessionId) {
    return this.reported.has(sessionId);
  }
  /** Clear stall report (called on new activity). */
  clearReport(sessionId) {
    this.reported.delete(sessionId);
  }
  /** Remove all tracking for a session (on shutdown). */
  remove(sessionId) {
    this.steps.delete(sessionId);
    this.lastMessageAt.delete(sessionId);
    this.lastTaskAt.delete(sessionId);
    this.busySince.delete(sessionId);
    this.peerMessages.delete(sessionId);
    this.reported.delete(sessionId);
    this.chattyReported.delete(sessionId);
  }
};

// src/config.ts
import { readFileSync } from "node:fs";
import path2 from "node:path";
var DEFAULT_CONFIG = {
  mergeOnCleanup: true,
  stallThresholdMs: 3e5,
  stallMinSteps: 5,
  stallTokenThreshold: 200,
  timeoutMs: 30 * 60 * 1e3,
  rateLimitCapacity: 10,
  dashboardPort: 4747,
  peerMessageLimit: 5,
  peerMessageWindowMs: 3e5,
  defaultModel: "",
  modelPool: [],
  modelsByAgent: {},
  modelAssignment: "default",
  promptForModels: false,
  silentLead: true
};
function readConfigFile(filePath) {
  try {
    const text = readFileSync(filePath, "utf-8");
    const raw = JSON.parse(text);
    const result = {};
    if (typeof raw.mergeOnCleanup === "boolean") result.mergeOnCleanup = raw.mergeOnCleanup;
    if (typeof raw.stallThresholdMs === "number") result.stallThresholdMs = raw.stallThresholdMs;
    if (typeof raw.stallMinSteps === "number") result.stallMinSteps = raw.stallMinSteps;
    if (typeof raw.stallTokenThreshold === "number") result.stallTokenThreshold = raw.stallTokenThreshold;
    if (typeof raw.timeoutMs === "number") result.timeoutMs = raw.timeoutMs;
    if (typeof raw.rateLimitCapacity === "number") result.rateLimitCapacity = raw.rateLimitCapacity;
    if (typeof raw.dashboardPort === "number") result.dashboardPort = raw.dashboardPort;
    if (typeof raw.peerMessageLimit === "number") result.peerMessageLimit = raw.peerMessageLimit;
    if (typeof raw.peerMessageWindowMs === "number") result.peerMessageWindowMs = raw.peerMessageWindowMs;
    if (typeof raw.defaultModel === "string") result.defaultModel = raw.defaultModel;
    if (Array.isArray(raw.modelPool) && raw.modelPool.every((m) => typeof m === "string")) result.modelPool = raw.modelPool;
    if (typeof raw.modelsByAgent === "object" && raw.modelsByAgent !== null && !Array.isArray(raw.modelsByAgent)) {
      const valid = Object.entries(raw.modelsByAgent).every(([, v]) => typeof v === "string");
      if (valid) result.modelsByAgent = raw.modelsByAgent;
    }
    if (typeof raw.modelAssignment === "string" && ["default", "rotate", "random"].includes(raw.modelAssignment)) result.modelAssignment = raw.modelAssignment;
    if (typeof raw.promptForModels === "boolean") result.promptForModels = raw.promptForModels;
    if (typeof raw.silentLead === "boolean") result.silentLead = raw.silentLead;
    return result;
  } catch (err) {
    if (err && typeof err === "object" && "code" in err && err.code === "ENOENT") return {};
    console.warn(`[ensemble] Invalid config at ${filePath}, using defaults`);
    return {};
  }
}
function loadConfig(projectDir) {
  const homeDir = process.env.HOME ?? process.env.USERPROFILE ?? "";
  const globalPath = path2.join(homeDir, ".config", "opencode", "ensemble.json");
  const projectPath = path2.join(projectDir, ".opencode", "ensemble.json");
  const global = readConfigFile(globalPath);
  const project = readConfigFile(projectPath);
  const merged = { ...DEFAULT_CONFIG, ...global, ...project };
  const timeout = process.env.OPENCODE_ENSEMBLE_TIMEOUT;
  if (timeout !== void 0) merged.timeoutMs = timeout === "0" ? 0 : parseInt(timeout, 10) || merged.timeoutMs;
  const rateLimit = process.env.OPENCODE_ENSEMBLE_RATE_LIMIT;
  if (rateLimit !== void 0) merged.rateLimitCapacity = rateLimit === "0" ? 0 : parseInt(rateLimit, 10) || merged.rateLimitCapacity;
  const stall = process.env.STALL_THRESHOLD_MS;
  if (stall !== void 0) merged.stallThresholdMs = stall === "0" ? 0 : parseInt(stall, 10) || merged.stallThresholdMs;
  return merged;
}

// src/rate-limit.ts
var TokenBucket = class {
  tokens;
  capacity;
  refillRate;
  refillIntervalMs;
  lastRefill;
  disabled;
  constructor(opts) {
    this.disabled = opts.capacity === 0;
    this.capacity = opts.capacity;
    this.tokens = opts.capacity;
    this.refillRate = opts.refillRate;
    this.refillIntervalMs = opts.refillIntervalMs;
    this.lastRefill = Date.now();
  }
  /** Refill tokens based on elapsed time. */
  refill() {
    if (this.disabled) return;
    const now = Date.now();
    const elapsed = now - this.lastRefill;
    if (elapsed < this.refillIntervalMs) return;
    const intervals = Math.floor(elapsed / this.refillIntervalMs);
    this.tokens = Math.min(this.capacity, this.tokens + intervals * this.refillRate);
    this.lastRefill += intervals * this.refillIntervalMs;
  }
  /**
   * Try to consume one token. Returns true if a token was available,
   * false if the bucket is empty. Disabled buckets always return true.
   */
  tryConsume() {
    if (this.disabled) return true;
    this.refill();
    if (this.tokens > 0) {
      this.tokens--;
      return true;
    }
    return false;
  }
  /**
   * Wait until a token is available, then consume it.
   * Respects an optional AbortSignal.
   */
  async waitForToken(signal) {
    if (this.disabled) return;
    if (this.tryConsume()) return;
    return new Promise((resolve, reject) => {
      const checkInterval = Math.max(10, Math.floor(this.refillIntervalMs / 2));
      const timer = setInterval(() => {
        if (signal?.aborted) {
          clearInterval(timer);
          reject(new Error("Rate limit wait aborted"));
          return;
        }
        if (this.tryConsume()) {
          clearInterval(timer);
          resolve();
        }
      }, checkInterval);
      signal?.addEventListener("abort", () => {
        clearInterval(timer);
        reject(new Error("Rate limit wait aborted"));
      }, { once: true });
    });
  }
};

// src/activity.ts
var ActivityBuffer = class {
  buffers = /* @__PURE__ */ new Map();
  maxPerSession;
  /**
   * @param options Optional configuration. `maxPerSession` defaults to 100.
   */
  constructor(options) {
    this.maxPerSession = options?.maxPerSession ?? 100;
  }
  /**
   * Add an activity entry to the session's buffer.
   * When the buffer exceeds `maxPerSession`, the oldest entries are dropped.
   * @param sessionID The session to record activity for.
   * @param entry The activity event to store.
   */
  record(sessionID, entry) {
    const entries = this.buffers.get(sessionID) ?? [];
    entries.push(entry);
    if (entries.length > this.maxPerSession) {
      entries.splice(0, entries.length - this.maxPerSession);
    }
    this.buffers.set(sessionID, entries);
  }
  /**
   * Retrieve activity entries for a session in chronological order (oldest first).
   * @param sessionID The session to query.
   * @param limit If provided, return only the N most recent entries.
   * @returns Array of entries (empty if session has no recorded activity).
   */
  getActivity(sessionID, limit) {
    const entries = this.buffers.get(sessionID);
    if (!entries) return [];
    if (limit !== void 0) return entries.slice(-limit);
    return [...entries];
  }
  /**
   * Remove all entries for a session.
   * @param sessionID The session to clear.
   */
  remove(sessionID) {
    this.buffers.delete(sessionID);
  }
  /**
   * Check whether any entries exist for a session.
   * @param sessionID The session to check.
   * @returns `true` if at least one entry exists, `false` otherwise.
   */
  has(sessionID) {
    const entries = this.buffers.get(sessionID);
    return entries !== void 0 && entries.length > 0;
  }
};
function recordFromV2Event(event, registry, buffer) {
  const props = event.properties;
  if (!props?.sessionID || !registry.getBySession(props.sessionID)) return;
  if (event.type === "session.next.shell.started") {
    buffer.record(props.sessionID, { type: "shell_command", command: props.command, timestamp: Date.now() });
  } else if (event.type === "session.next.shell.ended") {
    buffer.record(props.sessionID, { type: "shell_command", exitCode: props.exitCode, timestamp: Date.now() });
  } else if (event.type === "session.next.step.ended") {
    buffer.record(props.sessionID, {
      type: "step",
      cost: props.cost,
      tokensIn: props.tokens?.input,
      tokensOut: props.tokens?.output,
      timestamp: Date.now()
    });
  }
}
function recordFromToolBefore(input, registry, buffer) {
  if (!registry.getBySession(input.sessionID)) return;
  buffer.record(input.sessionID, { type: "tool_call", tool: input.tool, timestamp: Date.now() });
}
function recordFromToolAfter(input, output, registry, buffer) {
  if (!registry.getBySession(input.sessionID)) return;
  buffer.record(input.sessionID, {
    type: "tool_result",
    tool: input.tool,
    title: output.title,
    output: output.output,
    timestamp: Date.now()
  });
}

// src/system-prompt.ts
function truncate(s, maxLen) {
  return s.length > maxLen ? `${s.slice(0, maxLen)}...` : s;
}
var STATUS_DISPLAY = {
  busy: "working",
  ready: "idle",
  shutdown_requested: "shutting down",
  shutdown: "shut down",
  error: "error"
};
function leadReportDirective(config) {
  return config?.silentLead === false ? "You MUST send your results to the lead via team_message before stopping." : "Collaborate with teammates using team_message and complete assigned tasks on the board.";
}
function buildLeadSystemPrompt(db, teamId, config) {
  const team = db.query("SELECT name FROM team WHERE id = ?").get(teamId);
  if (!team) return "";
  const members = db.query("SELECT name, status FROM team_member WHERE team_id = ?").all(teamId);
  const taskCounts = db.query(
    "SELECT status, COUNT(*) as count FROM team_task WHERE team_id = ? GROUP BY status"
  ).all(teamId);
  const countMap = {};
  for (const row of taskCounts) {
    countMap[row.status] = row.count;
  }
  const completed = countMap.completed ?? 0;
  const inProgress = countMap.in_progress ?? 0;
  const pending = countMap.pending ?? 0;
  const memberList = members.map((m) => `${m.name} [${STATUS_DISPLAY[m.status] ?? m.status}]`).join(", ");
  const teammateLine = members.length > 0 ? `Teammates: ${memberList}` : "Teammates: none";
  const pendingMessages = db.query(
    "SELECT id, from_name, content FROM team_message WHERE team_id = ? AND to_name = 'lead' AND delivered = 0 ORDER BY time_created ASC"
  ).all(teamId);
  const lines = [
    `You are leading team "${team.name}" with ${members.length} active teammates.`,
    teammateLine,
    `Tasks: ${completed} completed, ${inProgress} in progress, ${pending} pending`
  ];
  const activeTasks = db.query(
    "SELECT content, assignee FROM team_task WHERE team_id = ? AND status = 'in_progress' ORDER BY time_updated DESC LIMIT 5"
  ).all(teamId);
  const recentCompleted = db.query(
    "SELECT content, assignee FROM team_task WHERE team_id = ? AND status = 'completed' ORDER BY time_updated DESC LIMIT 3"
  ).all(teamId);
  if (activeTasks.length > 0) {
    lines.push("Active tasks:");
    for (const t of activeTasks) {
      lines.push(`  [in_progress] ${truncate(t.content, 120)}${t.assignee ? ` \u2192 ${t.assignee}` : ""}`);
    }
  }
  if (recentCompleted.length > 0) {
    lines.push("Recently completed:");
    for (const t of recentCompleted) {
      lines.push(`  [completed] ${truncate(t.content, 120)}${t.assignee ? ` \u2192 ${t.assignee}` : ""}`);
    }
  }
  if (pendingMessages.length > 0) {
    lines.push("", "--- Team Messages ---");
    const MAX_MSG = 500;
    for (const msg of pendingMessages) {
      const parsed = parseTaskResult(msg.content);
      if (parsed) {
        const truncatedResult = { ...parsed, details: truncate(parsed.details, 500) };
        lines.push(formatTaskResult(msg.from_name, truncatedResult));
      } else if (msg.content.length > MAX_MSG) {
        lines.push(`[From ${msg.from_name}]: ${msg.content.slice(0, MAX_MSG)}... (use team_results to read full message)`);
      } else {
        lines.push(`[From ${msg.from_name}]: ${msg.content}`);
      }
      markDelivered(db, msg.id);
    }
    lines.push("--- End Messages ---");
  }
  if (config?.promptForModels) {
    const poolOptions = config.modelPool && config.modelPool.length > 0 ? config.modelPool.map((m) => `      { label: "${m}", description: "" }`).join(",\n") : "";
    lines.push(
      "",
      "MODEL SELECTION:",
      "Before spawning teammates, use the question tool to ask the user about model preferences.",
      "Do NOT spawn any agents until the user confirms their model preference.",
      "Keep descriptions simple and clear \u2014 explain what each option means in plain language.",
      "Example question tool call:",
      '  question({ questions: [{ question: "Which AI models should your team agents use?", header: "Agent models", options: [',
      `    { label: "Same as me (Recommended)", description: "Every agent uses the same model I'm running on. Simplest option \u2014 no extra setup needed." },`,
      '    { label: "Mix of models", description: "Each agent gets a different model from your configured pool. Useful for getting diverse perspectives on the same problem." },',
      `    { label: "I'll choose per agent", description: "You pick the exact model for each agent as I spawn them. Most control, but requires a choice per agent." }`,
      "  ]}]})"
    );
    if (poolOptions) {
      lines.push(
        'If user picks "Mix of models", ask which models with multiple: true:',
        '  question({ questions: [{ question: "Which models should agents rotate through? Pick all that apply.", header: "Model pool", multiple: true, options: [',
        poolOptions,
        "  ]}]})"
      );
    }
    lines.push(
      `If user picks "I'll choose per agent", ask for each agent's model individually before each team_spawn call.`,
      "Pass the chosen model via the model parameter on each team_spawn call."
    );
  }
  lines.push(
    "",
    "Spawn teammates ONE AT A TIME. Wait for each tool result before spawning the next.",
    "This avoids git worktree contention. Once all are spawned, wait for their messages.",
    "Read-only agents (explore, plan) automatically skip worktree creation.",
    "For other agents that only need to read, pass worktree: false to avoid unnecessary isolation.",
    "",
    "Teammates work asynchronously and message you when done.",
    "Do NOT poll team_status or team_tasks_list repeatedly \u2014 wait for messages.",
    "After spawning all teammates, tell the user what you've set up and wait.",
    "When all teammates finish, summarize results and suggest next steps.",
    "",
    "MERGE WORKFLOW:",
    "After a teammate finishes and you shut them down, use team_merge to merge their branch.",
    "Do NOT tell teammates to commit \u2014 they handle that themselves.",
    "Do NOT run git merge manually \u2014 use team_merge which squash-merges and unstages for you.",
    "team_cleanup will safety-net merge any branches you forgot, but prefer explicit team_merge.",
    "",
    "Before calling team_cleanup, verify teammates have committed their work.",
    "team_shutdown will warn you if a teammate has uncommitted changes.",
    "team_cleanup will block if any worktree has uncommitted changes \u2014 merge or commit first.",
    'To permanently delete archived teams, call team_cleanup with purge: ["team-name"] or purge: ["*"] for all archived teams.',
    "The first purge call is preview-only and deletes nothing.",
    "Use the question tool to ask the user for visible human approval before deleting archived team records or preserved Ensemble branches.",
    "The question must include the exact approval and denial option labels shown in the preview.",
    "Only if the user selects that exact approval option, call team_cleanup again with the same purge value, confirm_purge: true, and the confirm_token from the preview."
  );
  return lines.join("\n");
}
function buildTeammateSystemPrompt(db, teamId, memberName, config) {
  const team = db.query("SELECT name FROM team WHERE id = ?").get(teamId);
  if (!team) return "";
  const lines = [
    `You are "${memberName}", a teammate in team "${team.name}". Use team_message to communicate. ${leadReportDirective(config)}`
  ];
  const pendingMessages = db.query(
    "SELECT id, from_name, content FROM team_message WHERE team_id = ? AND to_name = ? AND delivered = 0 ORDER BY time_created ASC"
  ).all(teamId, memberName);
  if (pendingMessages.length > 0) {
    lines.push("", "--- Messages for you ---");
    const MAX_MSG = 500;
    for (const msg of pendingMessages) {
      const parsed = parseTaskResult(msg.content);
      if (parsed) {
        lines.push(formatTaskResult(msg.from_name, { ...parsed, details: truncate(parsed.details, MAX_MSG) }));
      } else if (msg.content.length > MAX_MSG) {
        lines.push(`[From ${msg.from_name}]: ${msg.content.slice(0, MAX_MSG)}... (truncated)`);
      } else {
        lines.push(`[From ${msg.from_name}]: ${msg.content}`);
      }
      markDelivered(db, msg.id);
    }
    lines.push("--- End Messages ---");
  }
  return lines.join("\n");
}
function buildTeamCompactionContext(db, teamId, role, memberName, config) {
  const team = db.query("SELECT name FROM team WHERE id = ?").get(teamId);
  if (!team) return "";
  const members = db.query("SELECT name, status FROM team_member WHERE team_id = ?").all(teamId);
  const taskCounts = db.query(
    "SELECT status, COUNT(*) as count FROM team_task WHERE team_id = ? GROUP BY status"
  ).all(teamId);
  const countMap = {};
  for (const row of taskCounts) {
    countMap[row.status] = row.count;
  }
  const completed = countMap.completed ?? 0;
  const inProgress = countMap.in_progress ?? 0;
  const pending = countMap.pending ?? 0;
  const roleLine = role === "lead" ? `[Team Context] You are the lead of team "${team.name}".` : `[Team Context] You are a teammate named "${memberName}" in team "${team.name}".`;
  const memberList = members.map((m) => `${m.name} (${STATUS_DISPLAY[m.status] ?? m.status})`).join(", ");
  const membersLine = members.length > 0 ? `Members: ${memberList}` : "Members: none";
  const lines = [
    roleLine,
    membersLine,
    `Tasks: ${completed} completed, ${inProgress} in progress, ${pending} pending`
  ];
  if (role === "member" && memberName) {
    lines.push(`IMPORTANT: ${leadReportDirective(config)}`);
    const member = db.query("SELECT prompt FROM team_member WHERE team_id = ? AND name = ?").get(teamId, memberName);
    if (member?.prompt) {
      lines.push(`Your original task: ${truncate(member.prompt, 300)}`);
    }
    const recentMsgs = db.query(
      "SELECT from_name, content FROM team_message WHERE team_id = ? AND (from_name = ? OR to_name = ?) ORDER BY time_created DESC LIMIT 3"
    ).all(teamId, memberName, memberName);
    if (recentMsgs.length > 0) {
      lines.push("Recent context:");
      for (const msg of recentMsgs) {
        lines.push(`  [${msg.from_name}]: ${truncate(msg.content, 200)}`);
      }
    }
  } else if (role === "member") {
    lines.push(`IMPORTANT: ${leadReportDirective(config)}`);
  }
  if (role === "lead") {
    const completedTasks = db.query(
      "SELECT content, assignee FROM team_task WHERE team_id = ? AND status = 'completed' ORDER BY time_updated DESC LIMIT 5"
    ).all(teamId);
    if (completedTasks.length > 0) {
      lines.push("Recently completed:");
      for (const t of completedTasks) {
        lines.push(`  [completed] ${truncate(t.content, 120)}${t.assignee ? ` (by ${t.assignee})` : ""}`);
      }
    }
  }
  return lines.join("\n");
}

// src/dashboard.ts
import { createServer } from "node:http";

// src/dashboard-html.ts
var DASHBOARD_HEAD = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1.0">
<title>Ensemble</title>
<link rel="icon" href="data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 16 16'><circle cx='8' cy='8' r='6' fill='%2322c55e'/></svg>">
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600&family=JetBrains+Mono:wght@400;600&display=swap" rel="stylesheet">
<script src="https://cdn.tailwindcss.com"></script>
<script>tailwind.config={theme:{extend:{colors:{base:{950:'#0c0e14',900:'#141822',850:'#1a1f2e',800:'#1e2433',700:'#2a3144',600:'#3a4358'},txt:{100:'#e2e8f0',200:'#c1c9d9',300:'#aab4c6',400:'#8a96aa',500:'#7b879b'}},fontFamily:{sans:['Inter','system-ui','sans-serif'],mono:['JetBrains Mono','monospace']}}}}</script>
<style>
@media(prefers-reduced-motion:no-preference){
@keyframes pulse{0%,100%{opacity:1}50%{opacity:.3}}
@keyframes fadein{from{opacity:0;transform:translateY(3px)}to{opacity:1;transform:none}}
@keyframes hl{from{background:rgba(59,130,246,.1)}to{background:transparent}}
@keyframes shimmer{0%{background-position:-200% 0}100%{background-position:200% 0}}
.pulse{animation:pulse 2s ease-in-out infinite}
.fadein{animation:fadein .25s ease-out}
.hl{animation:hl 1.5s ease-out}
.shimmer{background:linear-gradient(90deg,#22c55e 0%,#4ade80 50%,#22c55e 100%)!important;background-size:200% 100%;animation:shimmer 1.5s ease-in-out}
}
@media(prefers-reduced-motion:reduce){*,::before,::after{animation-duration:.01ms!important;animation-iteration-count:1!important;scroll-behavior:auto!important;transition-duration:.01ms!important}}
.scroll::-webkit-scrollbar{width:5px}.scroll::-webkit-scrollbar-track{background:transparent}.scroll::-webkit-scrollbar-thumb{background:#2a3144;border-radius:3px}
details summary::-webkit-details-marker{display:none}details summary{list-style:none}
:focus-visible{outline:2px solid rgba(96,165,250,.85);outline-offset:2px}
select{-webkit-appearance:none;appearance:none;background-image:url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='10' height='10' viewBox='0 0 24 24' fill='none' stroke='%235e6a82' stroke-width='2.5'%3E%3Cpath d='M6 9l6 6 6-6'/%3E%3C/svg%3E");background-repeat:no-repeat;background-position:right 8px center;padding-right:22px}
.project-link[aria-current="true"]{color:#e2e8f0}
.team-link[aria-current="true"]{color:#e2e8f0;border-left-color:#22c55e;background:rgba(34,197,94,.06)}
#content.nav-collapsed{grid-template-columns:2rem minmax(0,1fr)}
#projects[hidden]{display:none!important}
#project-rail[hidden]{display:none!important}
.xp{max-height:0;overflow:hidden;transition:max-height .3s ease-out}.xp-open{max-height:3000px;transition:max-height .5s ease-in}
.card-sel{outline:2px solid rgba(59,130,246,.4);outline-offset:1px}
.md pre{background:#1a1f2e;border:1px solid #1e2433;border-radius:6px;padding:8px 12px;overflow-x:auto;margin:6px 0;font-size:12px;line-height:1.5}
.md code{background:#1a1f2e;padding:1px 5px;border-radius:3px;font-size:12px}.md pre code{background:none;padding:0}
.md strong{color:#e2e8f0;font-weight:600}.md em{color:#c1c9d9;font-style:italic}
.md ul,.md ol{padding-left:18px;margin:4px 0}.md li{margin:2px 0}
.md h1,.md h2,.md h3{color:#e2e8f0;font-weight:600;margin:8px 0 4px}.md h1{font-size:15px}.md h2{font-size:14px}.md h3{font-size:13px}
.md a{color:#60a5fa;text-decoration:underline}.md p{margin:4px 0}
#sco{display:none;position:fixed;inset:0;background:rgba(12,14,20,.85);backdrop-filter:blur(8px);z-index:100;align-items:center;justify-content:center}
#sco.show{display:flex}
#drawer{position:fixed;top:0;right:0;bottom:0;width:min(480px,85vw);background:#141822;border-left:1px solid #1e2433;z-index:90;transform:translateX(100%);transition:transform .25s ease-out;overflow-y:auto}
#drawer.open{transform:translateX(0)}
#drawer-bg{position:fixed;inset:0;background:rgba(12,14,20,.5);z-index:89;display:none}
#drawer-bg.open{display:block}
</style>
</head>
<body class="bg-base-950 text-txt-100 min-h-screen antialiased font-sans">
<header class="fixed top-0 inset-x-0 h-11 bg-base-950/95 backdrop-blur border-b border-base-800 flex items-center justify-between px-3 sm:px-4 z-50">
<div class="flex items-center gap-2 sm:gap-3 min-w-0 flex-1">
<span class="font-mono font-semibold text-[13px] tracking-[.08em] text-txt-200">ensemble</span>
<span id="crumb" class="text-[11px] text-txt-500 font-mono truncate"></span>
</div>
<div class="flex items-center gap-2 sm:gap-4 shrink-0">
<div id="hring" class="w-6 h-6 rounded-full" title="Team health"></div>
<div class="flex items-center gap-2">
<span id="clk" class="text-[11px] text-txt-400 font-mono"></span>
<span class="text-base-700">\xB7</span>
<span id="cd" class="w-[7px] h-[7px] rounded-full bg-emerald-500 pulse"></span>
<span id="ct" class="text-[11px] text-txt-400 font-mono">...</span>
</div>
</div>
</header>
<div id="sum" class="fixed top-11 inset-x-0 h-8 bg-base-900/80 backdrop-blur border-b border-base-800/50 flex items-center px-3 sm:px-4 gap-3 sm:gap-4 text-[11px] text-txt-300 z-40 overflow-x-auto scroll whitespace-nowrap"></div>
<main class="pt-[76px] px-4 pb-16">
<div id="empty" class="hidden flex-col items-center justify-center h-[70vh] gap-3">
<div class="w-12 h-12 rounded-full border-2 border-base-700 flex items-center justify-center mb-2"><svg class="w-5 h-5 text-txt-500" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M12 4.5v15m7.5-7.5h-15"/></svg></div>
<div class="text-txt-400 text-sm">Waiting for a team</div>
<div class="text-txt-500 text-[11px]">Run <code class="px-1.5 py-0.5 bg-base-900 rounded text-txt-300 font-mono text-[11px]">team_create</code> in OpenCode to get started</div>
</div>
<div id="content" class="hidden max-w-[1720px] mx-auto grid grid-cols-1 lg:grid-cols-[260px_minmax(0,1fr)] gap-4 items-start">
<div id="project-rail" hidden class="lg:sticky lg:top-[88px]"><button id="nav-expand" type="button" aria-label="Show project navigation" aria-controls="projects" aria-expanded="false" class="h-8 w-8 rounded border border-base-800 text-txt-500 hover:text-txt-200 hover:border-base-700 transition-colors">&gt;</button></div>
<aside id="projects" aria-label="Project navigation" class="bg-base-950/60 border-r border-base-800/70 pr-3 lg:sticky lg:top-[88px]"></aside>
<div class="min-w-0">
<section id="attention" aria-label="Team attention" class="mb-3"></section>
<div class="grid grid-cols-1 xl:grid-cols-[minmax(360px,1.35fr)_minmax(320px,.8fr)] gap-4 items-start">
<section aria-label="Agent roster"><div id="agents" class="grid gap-2" style="grid-template-columns:repeat(auto-fill,minmax(300px,1fr))"></div></section>
<div class="grid grid-cols-1 gap-4">
<section aria-label="Task board"><div id="tasks" class="bg-base-900 rounded-lg p-3 border border-base-800/50"></div></section>
<section aria-label="Activity feed"><div id="activity" class="bg-base-900 rounded-lg p-3 border border-base-800/50"></div></section>
</div>
</div>
</div>
</div>
</main>
<div id="tl" aria-label="Event timeline" class="fixed bottom-0 inset-x-0 h-10 bg-base-900/90 backdrop-blur border-t border-base-800 px-4 flex items-center z-40 overflow-x-auto scroll hidden"></div>

<div id="chat-bar" class="fixed bottom-0 inset-x-0 bg-base-900/95 backdrop-blur border-t border-base-800 p-2 sm:p-3 flex items-end gap-2 z-50">
  <div class="relative shrink-0">
    <button id="chat-recipient-btn" class="h-9 px-3 rounded-md bg-base-800 hover:bg-base-700 border border-base-700 text-txt-200 text-sm font-medium transition-colors flex items-center gap-1.5 focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-500">
      <span id="chat-recipient-label">\u{1F4E2} Todos</span>
      <svg class="w-3.5 h-3.5 text-txt-400" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M6 9l6 6 6-6"/></svg>
    </button>
  </div>
  <div class="flex-1 relative">
    <textarea id="chat-input" rows="1" class="w-full bg-base-950 border border-base-700 rounded-md py-2 px-3 text-sm text-txt-100 placeholder-txt-500 focus:outline-none focus:border-blue-500 focus:ring-1 focus:ring-blue-500 resize-none max-h-32 scrollbar-thin transition-all" placeholder="Enviar mensagem para a sala ou digite @agente..."></textarea>
    <div id="chat-mentions" class="hidden absolute bottom-full left-0 mb-1 w-48 bg-base-800 border border-base-700 rounded-md shadow-lg overflow-hidden z-50">
      <ul id="chat-mentions-list" class="max-h-40 overflow-y-auto py-1 scroll text-sm text-txt-200"></ul>
    </div>
  </div>
  <button id="chat-send-btn" class="shrink-0 h-9 px-4 rounded-md bg-blue-600 hover:bg-blue-500 text-white text-sm font-medium transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-400 disabled:opacity-50 disabled:cursor-not-allowed">
    Enviar
  </button>
</div>

<div id="sco" role="dialog" aria-modal="true" aria-hidden="true" aria-labelledby="shortcuts-title" tabindex="-1" onclick="closeShortcuts()">
<div class="bg-base-900 border border-base-800 rounded-lg p-6 max-w-sm" onclick="event.stopPropagation()">
<div id="shortcuts-title" class="text-txt-200 font-semibold text-sm mb-4">Keyboard Shortcuts</div>
<div class="grid grid-cols-2 gap-y-2 gap-x-6 text-[12px]">
<div><kbd class="px-1.5 py-0.5 bg-base-800 rounded font-mono text-txt-300 text-[11px]">j</kbd> <span class="text-txt-400">Next agent</span></div>
<div><kbd class="px-1.5 py-0.5 bg-base-800 rounded font-mono text-txt-300 text-[11px]">k</kbd> <span class="text-txt-400">Prev agent</span></div>
<div><kbd class="px-1.5 py-0.5 bg-base-800 rounded font-mono text-txt-300 text-[11px]">Enter</kbd> <span class="text-txt-400">Expand agent</span></div>
<div><kbd class="px-1.5 py-0.5 bg-base-800 rounded font-mono text-txt-300 text-[11px]">Esc</kbd> <span class="text-txt-400">Collapse all</span></div>
<div><kbd class="px-1.5 py-0.5 bg-base-800 rounded font-mono text-txt-300 text-[11px]">v</kbd> <span class="text-txt-400">Toggle verbose</span></div>
<div><kbd class="px-1.5 py-0.5 bg-base-800 rounded font-mono text-txt-300 text-[11px]">1-9</kbd> <span class="text-txt-400">Switch team</span></div>
<div><kbd class="px-1.5 py-0.5 bg-base-800 rounded font-mono text-txt-300 text-[11px]">?</kbd> <span class="text-txt-400">This help</span></div>
</div>
</div>
</div>
<div id="drawer-bg" onclick="closeDrawer()"></div>
<div id="drawer" class="scroll p-4" tabindex="-1" inert role="dialog" aria-modal="true" aria-labelledby="drawer-title" aria-hidden="true"><h2 id="drawer-title" class="sr-only">Agent detail</h2></div>`;

// src/dashboard-js-core.ts
var DASHBOARD_JS_CORE = `

async function sendChatMessage(text, target) {
  const input = document.getElementById('chat-input');
  if (input) input.disabled = true;
  const btn = document.getElementById('chat-send-btn');
  if (btn) btn.disabled = true;

  try {
    const t = cur();
    const teamId = t ? t.id : '';
    const res = await fetch('/api/chat/send', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ teamId, text, to: target })
    });
    if (!res.ok) throw new Error('Chat send failed: ' + res.statusText);
    
    // clear input
    if (input) {
      input.value = '';
      input.style.height = 'auto'; // reset textarea height if auto-resizing
    }
  } catch (err) {
    console.error(err);
    alert('Erro ao enviar mensagem: ' + err.message);
  } finally {
    if (input) {
      input.disabled = false;
      input.focus();
    }
    if (btn) btn.disabled = false;
  }
}

let S=null,selId=null,selProjectId=null,fails=0,pollT=Date.now(),prevMC=0,selCard=-1,navCollapsed=false,verbose=(function(){try{return localStorage.getItem('ensemble-verbose')==='1'}catch(e){return false}})(),drawerActivity=null,drawerSession=null;
const expCards=new Set(),expMsgs=new Set();
const E=s=>s?String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;'):'';
const D=ms=>{const s=Math.floor(Math.abs(ms)/1000);return s<60?s+'s':s<3600?Math.floor(s/60)+'m':Math.floor(s/3600)+'h'};
const T=e=>new Date(e).toLocaleTimeString('en-GB',{hour:'2-digit',minute:'2-digit',second:'2-digit'});
function relT(ep){const ms=Date.now()-ep;if(ms<60000)return Math.floor(ms/1000)+'s ago';if(ms<3600000)return Math.floor(ms/60000)+'m ago';if(ms<86400000)return Math.floor(ms/3600000)+'h ago';return T(ep)}

// Chip: small readable badge with background tint
function chip(text,color){
  var colors={
    blue:'bg-blue-500/15 text-blue-400 border-blue-500/20',
    green:'bg-emerald-500/15 text-emerald-400 border-emerald-500/20',
    amber:'bg-amber-500/15 text-amber-400 border-amber-500/20',
    red:'bg-red-500/15 text-red-400 border-red-500/20',
    violet:'bg-violet-500/15 text-violet-400 border-violet-500/20',
    gray:'bg-base-700/40 text-txt-300 border-base-700/30',
    muted:'bg-base-800/60 text-txt-400 border-base-700/20',
  };
  var c=colors[color]||colors.muted;
  return '<span class="inline-flex items-center px-1.5 py-[1px] rounded text-[10px] font-medium border '+c+'">'+text+'</span>';
}

function md(s){
  let h=E(s);
  h=h.replace(/\`\`\`(\\w*)\\n([\\s\\S]*?)\`\`\`/g,function(_,l,c){return '<pre><code>'+c.trim()+'</code></pre>'});
  h=h.replace(/\`([^\`]+)\`/g,'<code>$1</code>');
  h=h.replace(/^### (.+)$/gm,'<h3>$1</h3>');
  h=h.replace(/^## (.+)$/gm,'<h2>$1</h2>');
  h=h.replace(/^# (.+)$/gm,'<h1>$1</h1>');
  h=h.replace(/\\*\\*(.+?)\\*\\*/g,'<strong>$1</strong>');
  h=h.replace(/\\*(.+?)\\*/g,'<em>$1</em>');
  h=h.replace(/\\[([^\\]]+)\\]\\(([^)]+)\\)/g,'<a href="$2" target="_blank" rel="noopener">$1</a>');
  h=h.replace(/^- (.+)$/gm,'<li>$1</li>');
  h=h.replace(/(<li>.*<\\/li>\\n?)+/g,'<ul>$&</ul>');
  h=h.replace(/^\\d+\\. (.+)$/gm,'<li>$1</li>');
  h=h.replace(/\\n\\n/g,'</p><p>');
  h=h.replace(/\\n/g,'<br>');
  return '<p>'+h+'</p>';
}

function saveD(el){const s={};el.querySelectorAll('details').forEach((d,i)=>{s[i]=d.open});return s}
function restD(el,s){if(!s)return;el.querySelectorAll('details').forEach((d,i)=>{if(i in s)d.open=s[i]})}
function saveSc(el){const s=el.querySelector('.scroll');return s?s.scrollTop:0}
function restSc(el,p){const s=el.querySelector('.scroll');if(s)s.scrollTop=p}
function patch(el,h){if(el.innerHTML!==h)el.innerHTML=h}

const ST={
  busy:{c:'border-blue-500 bg-blue-500/[0.04]',d:'bg-blue-500',t:'text-blue-400',l:'working',dim:false},
  standby:{c:'border-violet-500 bg-violet-500/[0.04]',d:'bg-violet-500',t:'text-violet-400',l:'standby',dim:true},
  ready:{c:'border-base-700 bg-base-950/50',d:'bg-txt-400',t:'text-txt-400',l:'idle',dim:true},
  shutdown_requested:{c:'border-amber-500/50 bg-amber-500/[0.04]',d:'bg-amber-500',t:'text-amber-400',l:'stopping',dim:false},
  shutdown:{c:'border-base-800 bg-base-950/30',d:'bg-base-700',t:'text-txt-500',l:'done',dim:true},
  error:{c:'border-red-500/50 bg-red-500/[0.04]',d:'bg-red-500',t:'text-red-400',l:'error',dim:false},
};
// Resolve a member's visual state: 'standby' wins whenever it appears as the
// member status or as the execution_status (paused spawn awaiting its wake),
// otherwise fall back to the status key with the 'ready' styling as default.
const si=(s,es)=>((s==='standby'||es==='standby')?ST.standby:(ST[s]||ST.ready));
// Chip colour for the status/execution_status badge (keep in sync with si()).
const sx=(m)=>((m.status==='standby'||m.executionStatus==='standby')?'violet':(m.status==='busy'?'blue':m.status==='error'?'red':'muted'));
const PR={high:'text-red-400 bg-red-500/10 border border-red-500/20',medium:'text-amber-400 bg-amber-500/10 border border-amber-500/20',low:'text-txt-400 bg-base-800 border border-base-700'};

function parseR(c){const m=c.match(/<task-result>([\\s\\S]*?)<\\/task-result>/);if(!m)return null;const i=m[1],s=(i.match(/<status>([\\s\\S]*?)<\\/status>/)||[])[1]?.trim(),u=(i.match(/<summary>([\\s\\S]*?)<\\/summary>/)||[])[1]?.trim(),d=(i.match(/<details>([\\s\\S]*?)<\\/details>/)||[])[1]?.trim();return s&&u?{status:s,summary:u,details:d||''}:null}

function allTeams(){
  if(!S?.teams)return{active:[],archived:[]};
  const active=[...S.teams.filter(t=>t.status==='active')].sort((a,b)=>b.timeUpdated-a.timeUpdated);
  const archived=[...S.teams.filter(t=>t.status!=='active')].sort((a,b)=>b.timeUpdated-a.timeUpdated);
  return{active,archived};
}
function allProjects(){return S?.projects?[...S.projects].sort((a,b)=>b.timeUpdated-a.timeUpdated):[]}
function projectLabel(p){return p?(p.name||p.path||p.id):''}
function curProject(){const ps=allProjects();if(!ps.length)return null;if(selProjectId){const p=ps.find(p=>p.id===selProjectId);if(p)return p}var t=cur();return t?ps.find(p=>p.id===t.projectId)||ps[0]:ps[0]}
function cur(){const{active,archived}=allTeams(),all=[...active,...archived];if(!all.length)return null;if(selId){const t=all.find(t=>t.id===selId);if(t){selProjectId=t.projectId;return t}}const p=selProjectId&&S?.projects?.find(p=>p.id===selProjectId);const pt=p?[...(p.teams||[])].filter(t=>t.status==='active'):[ ];const t=pt.sort((a,b)=>b.timeUpdated-a.timeUpdated)[0]||active[0]||all[0];if(t){selId=t.id;selProjectId=t.projectId}return t}

function deriveHealth(t){
  const mm=t.members||[];if(!mm.length)return{w:0,i:0,e:0,d:0,total:0};
  return{w:mm.filter(m=>m.status==='busy').length,i:mm.filter(m=>m.status==='ready').length,e:mm.filter(m=>m.status==='error').length,d:mm.filter(m=>m.status==='shutdown'||m.status==='shutdown_requested').length,total:mm.length};
}

function coarseTeamStatus(t){const h=deriveHealth(t),blocked=(t.tasks||[]).filter(x=>x.status==='blocked').length;if(h.e)return{label:'error',color:'red',dot:'bg-red-500'};if(blocked)return{label:'blocked',color:'amber',dot:'bg-amber-500'};if(h.w)return{label:'working',color:'blue',dot:'bg-blue-500'};if(h.i)return{label:'idle',color:'muted',dot:'bg-txt-500'};return{label:t.status==='active'?'empty':t.status,color:'muted',dot:'bg-base-600'}}
function projectStatus(p){const teams=p.teams||[],counts={working:0,blocked:0,error:0,idle:0,done:0};teams.forEach(t=>{const s=coarseTeamStatus(t).label;if(s==='working')counts.working++;else if(s==='blocked')counts.blocked++;else if(s==='error')counts.error++;else if(s==='idle'||s==='empty')counts.idle++;else counts.done++});if(counts.error)return{label:'error',color:'red',dot:'bg-red-500',counts};if(counts.blocked)return{label:'blocked',color:'amber',dot:'bg-amber-500',counts};if(counts.working)return{label:'working',color:'blue',dot:'bg-blue-500',counts};return{label:'idle',color:'muted',dot:'bg-txt-500',counts}}
function statusTitleProject(p){const s=projectStatus(p),teams=p.teams||[];return projectLabel(p)+'\\nStatus: '+s.label+'\\nTeams: '+teams.length+'\\nWorking: '+s.counts.working+' \xB7 Blocked: '+s.counts.blocked+' \xB7 Error: '+s.counts.error+' \xB7 Idle: '+s.counts.idle}
function statusTitleTeam(t){const h=deriveHealth(t),tasks=t.tasks||[],blocked=tasks.filter(x=>x.status==='blocked').length,active=tasks.filter(x=>x.status==='in_progress').length,pending=tasks.filter(x=>x.status==='pending').length,done=tasks.filter(x=>x.status==='completed').length;return t.name+'\\nStatus: '+coarseTeamStatus(t).label+'\\nAgents: '+h.total+' total, '+h.w+' working, '+h.i+' idle, '+h.e+' error\\nTasks: '+active+' active, '+blocked+' blocked, '+pending+' pending, '+done+' done'}

function lastMessageFor(name,msgs){return msgs.filter(m=>m.fromName===name||m.toName===name).sort((a,b)=>b.timeCreated-a.timeCreated)[0]||null}
function activeTaskFor(name,tasks){return tasks.find(x=>x.assignee===name&&x.status==='in_progress')||tasks.find(x=>x.assignee===name&&x.status==='blocked')||null}
function blockedTaskFor(name,tasks){return tasks.find(x=>x.assignee===name&&x.status==='blocked')||null}

function rankAgent(a,b,t){
  const tasks=t?.tasks||[],msgs=t?.messages||[];
  const score=m=>{
    const lm=lastMessageFor(m.name,msgs),bt=blockedTaskFor(m.name,tasks);
    let s=0;
    if(m.status==='error')s-=1000;
    if(bt)s-=800;
    if(m.status==='shutdown_requested')s-=650;
    if(m.status==='busy')s-=500;
    if(m.status==='ready'&&activeTaskFor(m.name,tasks))s-=350;
    if(lm)s-=Math.max(0,200-Math.floor((Date.now()-lm.timeCreated)/60000));
    if(m.status==='shutdown')s+=700;
    return s;
  };
  const d=score(a)-score(b);return d||String(a.name).localeCompare(String(b.name));
}

function deriveAttention(t){
  const tasks=t.tasks||[],msgs=t.messages||[];
  const blocked=tasks.filter(x=>x.status==='blocked'),running=tasks.filter(x=>x.status==='in_progress');
  const errored=(t.members||[]).filter(m=>m.status==='error');
  const stopping=(t.members||[]).filter(m=>m.status==='shutdown_requested');
  const latest=msgs[0]||null;
  const items=[];
  errored.forEach(m=>items.push({kind:'Agent error',label:m.name,detail:m.executionStatus||m.status,color:'red'}));
  blocked.forEach(x=>items.push({kind:'Blocked task',label:x.assignee||'unassigned',detail:x.content,color:'amber'}));
  stopping.forEach(m=>items.push({kind:'Stopping',label:m.name,detail:'shutdown requested',color:'amber'}));
  return{items,running,latest,blocked,errored};
}

function deriveSparkline(name,msgs){
  const mine=msgs.filter(m=>m.fromName===name).map(m=>m.timeCreated).sort();
  if(mine.length<2)return '';
  const min=mine[0],max=mine[mine.length-1],range=max-min||1;
  const buckets=new Array(12).fill(0);
  mine.forEach(t=>{const idx=Math.min(11,Math.floor((t-min)/range*12));buckets[idx]++});
  const mx=Math.max(...buckets)||1;
  const bars=buckets.map((v,i)=>{const h=Math.max(1,Math.round(v/mx*14));return '<rect x="'+(i*5)+'" y="'+(14-h)+'" width="3.5" height="'+h+'" rx="0.5" fill="currentColor" opacity="'+(0.3+v/mx*0.7)+'"/>'}).join('');
  return '<svg class="inline-block text-blue-500/60" width="60" height="14" viewBox="0 0 60 14">'+bars+'</svg>';
}

function deriveTimeline(t){
  const ev=[];
  (t.members||[]).forEach(m=>{ev.push({t:m.timeCreated,type:'spawn',label:E(m.name)+' spawned',c:'bg-blue-400'});if(m.status==='shutdown')ev.push({t:m.timeUpdated,type:'off',label:E(m.name)+' shut down',c:'bg-txt-500'});if(m.status==='error')ev.push({t:m.timeUpdated,type:'err',label:E(m.name)+' error',c:'bg-red-500'})});
  (t.messages||[]).forEach(m=>{const p=parseR(m.content);ev.push({t:m.timeCreated,type:'msg',label:E(m.fromName)+' \\u2192 '+(E(m.toName)||'all'),c:p?'bg-emerald-500':'bg-blue-400'})});
  (t.tasks||[]).filter(x=>x.status==='completed').forEach(x=>{ev.push({t:x.timeUpdated,type:'done',label:'Task done',c:'bg-emerald-500'})});
  return ev.sort((a,b)=>a.t-b.t).slice(-50);
}

function deriveThreads(msgs){
  const threads={};
  msgs.forEach(m=>{const k=m.fromName;if(!threads[k])threads[k]={from:m.fromName,msgs:[]};threads[k].msgs.push(m)});
  return Object.values(threads).sort((a,b)=>b.msgs[0].timeCreated-a.msgs[0].timeCreated);
}
`;

// src/dashboard-js-events.ts
var DASHBOARD_JS_EVENTS = `
function toggleMsg(id){if(expMsgs.has(id))expMsgs.delete(id);else expMsgs.add(id);render()}

function toggleVerbose(){
  verbose=!verbose;
  try{localStorage.setItem('ensemble-verbose',verbose?'1':'0')}catch(e){}
  var btn=document.getElementById('verbose-toggle');
  if(btn){
    btn.textContent='verbose: '+(verbose?'on':'off');
    btn.setAttribute('aria-pressed',verbose?'true':'false');
    btn.className='text-[10px] '+(verbose?'text-blue-400 border-blue-500/40 bg-blue-500/10':'text-txt-500 hover:text-txt-200 border-base-800')+' rounded px-1.5 py-[2px] transition-colors';
  }
  rDrawerActivityUpdate();
}

var fetchActivityGen=0;
async function fetchActivity(sessionId){
  var gen=++fetchActivityGen;
  try{
    var res=await fetch('api/session/'+encodeURIComponent(sessionId)+'/activity');
    var data=await res.json();
    if(gen!==fetchActivityGen)return;
    drawerActivity=data.activity||[];
    drawerSession=data.session||null;
    rDrawerActivityUpdate();
  }catch{if(gen!==fetchActivityGen)return;drawerActivity=[];drawerSession=null;rDrawerActivityUpdate()}
}

function applyNavCollapse(){
  const content=document.getElementById('content'),projects=document.getElementById('projects'),rail=document.getElementById('project-rail'),toggle=document.getElementById('nav-toggle'),expand=document.getElementById('nav-expand');
  content.classList.toggle('nav-collapsed',navCollapsed);
  projects.hidden=navCollapsed;
  projects.setAttribute('aria-hidden',String(navCollapsed));
  rail.hidden=!navCollapsed;
  if(toggle)toggle.setAttribute('aria-expanded',String(!navCollapsed));
  expand.setAttribute('aria-expanded',String(!navCollapsed));
  if(document.activeElement===toggle&&navCollapsed)expand.focus();
  if(document.activeElement===expand&&!navCollapsed&&toggle)toggle.focus();
}

function render(){
  rSel();const t=cur();
  const empty=document.getElementById('empty'),content=document.getElementById('content');
  if(!t){empty.classList.remove('hidden');empty.classList.add('flex');content.classList.add('hidden');document.getElementById('tl').classList.add('hidden');return}
  empty.classList.add('hidden');empty.classList.remove('flex');content.classList.remove('hidden');
  applyNavCollapse();
  const p=curProject();document.getElementById('crumb').textContent=p?' / '+projectLabel(p)+' / '+t.name:'';
  rHealth(t);rSum(t);rAttention(t);rAgents(t);rTasks(t);rActivity(t);rTimeline(t);
}

function selectProject(id){selProjectId=id;const p=S?.projects?.find(p=>p.id===id);const t=(p?.teams||[]).filter(t=>t.status==='active').sort((a,b)=>b.timeUpdated-a.timeUpdated)[0]||(p?.teams||[])[0];if(t)selId=t.id;selCard=-1;render()}
function selectTeam(id){selId=id;selCard=-1;render()}

function conn(ok){
  document.getElementById('cd').className='w-[7px] h-[7px] rounded-full '+(ok?'bg-emerald-500 pulse':'bg-red-500');
  document.getElementById('ct').textContent=ok?D(Date.now()-pollT)+' ago':'reconnecting to dashboard state';
}

async function poll(){try{S=await(await fetch('api/state')).json();fails=0;pollT=Date.now();conn(true);render()}catch{if(++fails>=3)conn(false)}}

function setBackgroundInert(locked){
  document.querySelectorAll('header,main,#sum,#tl').forEach(function(el){
    el.inert=locked;
    if(locked)el.setAttribute('aria-hidden','true');
    else el.removeAttribute('aria-hidden');
  });
}

function modalOpen(){return document.getElementById('sco').classList.contains('show')||document.getElementById('drawer').classList.contains('open')}

function trapFocus(root,e){
  const nodes=[...root.querySelectorAll('button,[href],input,select,textarea,[tabindex]:not([tabindex="-1"])')].filter(function(el){return !el.disabled&&!el.inert&&el.offsetParent!==null});
  if(!nodes.length){e.preventDefault();root.focus();return}
  const first=nodes[0],last=nodes[nodes.length-1];
  if(e.shiftKey&&document.activeElement===first){e.preventDefault();last.focus();return}
  if(!e.shiftKey&&document.activeElement===last){e.preventDefault();first.focus();return}
}

function openShortcuts(){
  const el=document.getElementById('sco');
  setBackgroundInert(true);
  el.classList.add('show');
  el.setAttribute('aria-hidden','false');
  document.getElementById('sco').focus();
}

function closeShortcuts(){
  const el=document.getElementById('sco');
  el.classList.remove('show');
  el.setAttribute('aria-hidden','true');
  if(!modalOpen())setBackgroundInert(false);
}

// Clock update every second
setInterval(function(){var t=cur();if(t)rClock(t);if(fails<3)conn(true)},1000);

// Poll every 2.5s
setInterval(poll,2500);

document.addEventListener('click',function(e){
  const id=e.target&&e.target.id;
  if(id!=='nav-toggle'&&id!=='nav-expand')return;
  navCollapsed=id==='nav-toggle';
  applyNavCollapse();
});

// Keyboard shortcuts
document.addEventListener('keydown',function(e){
  const shortcutsOpen=document.getElementById('sco').classList.contains('show');
  if(shortcutsOpen&&e.key==='Tab'){trapFocus(document.getElementById('sco'),e);return}
  if(shortcutsOpen&&e.key==='Escape'){e.preventDefault();closeShortcuts();return}
  const drawerOpen=document.getElementById('drawer').classList.contains('open');
  if(drawerOpen&&e.key==='Tab'){trapFocus(document.getElementById('drawer'),e);return}
  if(drawerOpen&&e.key==='Escape'){e.preventDefault();closeDrawer();return}
  if(drawerOpen&&e.key==='?'){e.preventDefault();return}
  if(e.target.tagName==='INPUT'||e.target.tagName==='SELECT'||e.target.tagName==='TEXTAREA')return;
  var t=cur();if(!t)return;
  var mm=[...(t.members||[])].sort((a,b)=>rankAgent(a,b,t));
  if(e.key==='?'){e.preventDefault();shortcutsOpen?closeShortcuts():openShortcuts();return}
  if(e.key==='Escape'){closeDrawer();expMsgs.clear();selCard=-1;closeShortcuts();render();return}
  if(e.key==='j'&&mm.length){e.preventDefault();selCard=Math.min(selCard+1,mm.length-1);render();return}
  if(e.key==='k'&&mm.length){e.preventDefault();selCard=Math.max(selCard-1,0);render();return}
  if(e.key==='v'&&!e.ctrlKey&&!e.metaKey&&!e.altKey){e.preventDefault();toggleVerbose();return}
  if(e.key==='Enter'&&selCard>=0&&selCard<mm.length){e.preventDefault();openDrawer(mm[selCard].name);return}
  if(e.key>='1'&&e.key<='9'){
    var teams=allTeams(),all=[...teams.active,...teams.archived];
    var idx=parseInt(e.key)-1;
    if(idx<all.length){selId=all[idx].id;render()}
  }
});

// Initial poll
poll();


// Chat Interaction
let chatRecipient = 'all';
let mentionsOpen = false;

function getActiveMembersForChat() {
  const t = cur();
  if(!t) return [];
  return (t.members || []).filter(m => m.status !== 'shut down').map(m => m.name);
}

function rChatMentions(query) {
  const list = document.getElementById('chat-mentions-list');
  const container = document.getElementById('chat-mentions');
  if (!list || !container) return;
  const activeMembersForChat = getActiveMembersForChat();
  const matches = activeMembersForChat.filter(m => m.toLowerCase().startsWith(query.toLowerCase()));
  if (matches.length === 0) {
    container.classList.add('hidden');
    mentionsOpen = false;
    return;
  }
  list.innerHTML = matches.map(m => '<li class="px-3 py-1.5 hover:bg-base-700 cursor-pointer mention-item" data-name="' + m + '">@' + m + '</li>').join('');
  container.classList.remove('hidden');
  mentionsOpen = true;
  
  // click handlers for mention items
  list.querySelectorAll('.mention-item').forEach(el => {
    el.addEventListener('click', function() {
      applyMention(this.getAttribute('data-name'));
    });
  });
}

function applyMention(name) {
  const input = document.getElementById('chat-input');
  if(!input) return;
  const val = input.value;
  const atIdx = val.lastIndexOf('@');
  if(atIdx >= 0) {
    input.value = val.substring(0, atIdx) + '@' + name + ' ';
  }
  document.getElementById('chat-mentions').classList.add('hidden');
  mentionsOpen = false;
  input.focus();
}

document.addEventListener('click', function(e) {
  if(e.target.id === 'chat-recipient-btn' || e.target.closest('#chat-recipient-btn')) {
    const members = getActiveMembersForChat();
    const opts = ['all', ...members];
    let idx = opts.indexOf(chatRecipient);
    chatRecipient = opts[(idx + 1) % opts.length];
    document.getElementById('chat-recipient-label').textContent = chatRecipient === 'all' ? '\u{1F4E2} Todos' : '@' + chatRecipient;
  } else if (!e.target.closest('#chat-mentions') && document.getElementById('chat-mentions') && !document.getElementById('chat-mentions').classList.contains('hidden')) {
     document.getElementById('chat-mentions').classList.add('hidden');
     mentionsOpen = false;
  }
});

document.addEventListener('input', function(e) {
  if(e.target.id === 'chat-input') {
    const val = e.target.value;
    const atIdx = val.lastIndexOf('@');
    if(atIdx >= 0 && !val.includes(' ', atIdx)) {
      rChatMentions(val.substring(atIdx + 1));
    } else {
      const container = document.getElementById('chat-mentions');
      if (container) {
        container.classList.add('hidden');
        mentionsOpen = false;
      }
    }
  }
});

document.addEventListener('keydown', function(e) {
  if(e.target.id === 'chat-input') {
    if(e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      const text = e.target.value.trim();
      if(text) {
        if(typeof sendChatMessage === 'function') {
          sendChatMessage(text, chatRecipient === 'all' ? undefined : chatRecipient);
        }
      }
    }
  }
});

document.addEventListener('click', function(e) {
  if(e.target.id === 'chat-send-btn' || e.target.closest('#chat-send-btn')) {
    const input = document.getElementById('chat-input');
    const text = input ? input.value.trim() : '';
    if(text) {
      if(typeof sendChatMessage === 'function') {
        sendChatMessage(text, chatRecipient === 'all' ? undefined : chatRecipient);
      }
    }
  }
});

console.log('%c Ensemble Mission Control','font-size:14px;font-weight:bold;color:#22c55e');
`;

// src/dashboard-js-render.ts
var DASHBOARD_JS_RENDER = `
function rSel(){
  const el=document.getElementById('projects'),ps=allProjects(),c=cur(),cp=curProject();
  const head=renderProjectNavHeader();
  if(!ps.length){patch(el,head+'<div class="text-center text-txt-500 text-[12px] py-6">No projects yet</div>');return}
  let h='<nav class="text-[12px]" aria-label="Projects">'+head+'<div class="space-y-4">';
  ps.forEach(function(p){h+=renderProjectSection(p,cp,c)});
  h+='</div></nav>';
  patch(el,h);
}

function renderProjectNavHeader(){return '<div class="flex items-center justify-between gap-2 mb-3"><div class="text-[10px] uppercase tracking-[.18em] text-txt-500">Projects</div><button id="nav-toggle" type="button" aria-label="Hide project navigation" aria-controls="projects" aria-expanded="true" class="text-[10px] text-txt-500 border border-base-800 rounded px-1.5 py-[2px] hover:text-txt-200 hover:border-base-700 transition-colors">hide</button></div>'}
function renderProjectSection(p,cp,c){const teams=p.teams||[];return '<section>'+renderProjectButton(p,cp)+'<div class="mt-2 ml-[7px] border-l border-base-800/80">'+[...teams].sort((a,b)=>b.timeUpdated-a.timeUpdated).map(t=>renderTeamLink(t,c)).join('')+'</div></section>'}
function renderProjectButton(p,cp){const teams=p.teams||[],active=teams.filter(t=>t.status==='active').length,sel=cp&&cp.id===p.id,pss=projectStatus(p);return '<button type="button" aria-current="'+(sel?'true':'false')+'" title="'+E(statusTitleProject(p))+'" class="project-link group w-full text-left text-txt-300 hover:text-txt-100 transition-colors" data-project="'+E(p.id)+'" onclick="selectProject(this.dataset.project)"><div class="flex items-center gap-2 min-w-0"><span class="w-[5px] h-[5px] rounded-full '+pss.dot+(pss.label==='working'?' pulse':'')+' shrink-0"></span><span class="font-mono font-semibold truncate">'+E(projectLabel(p))+'</span>'+chip(pss.label,pss.color)+'</div><div class="mt-1 ml-3 text-[10px] text-txt-500">'+active+' team'+(active!==1?'s':'')+'</div></button>'}
function renderTeamLink(t,c){const ss=coarseTeamStatus(t),tsel=c&&c.id===t.id;return '<button type="button" title="'+E(statusTitleTeam(t))+'" class="team-link block w-full text-left border-l-2 border-transparent -ml-px py-1.5 pl-3 pr-2 text-[11px] text-txt-500 hover:text-txt-200 hover:bg-base-900/70 transition-colors" aria-current="'+(tsel?'true':'false')+'" data-team="'+E(t.id)+'" onclick="selectTeam(this.dataset.team)"><div class="flex items-center gap-2 min-w-0"><span class="w-[5px] h-[5px] rounded-full '+ss.dot+(ss.label==='working'?' pulse':'')+' shrink-0"></span><span class="truncate font-mono">'+E(t.name)+'</span><span class="ml-auto text-[9px] uppercase tracking-wide text-txt-500">'+E(ss.label)+'</span></div></button>'}

function rHealth(t){
  const el=document.getElementById('hring'),h=deriveHealth(t);
  if(!h.total){el.style.background='conic-gradient(#2a3144 0deg,#2a3144 360deg)';return}
  const total=h.total,segs=[];let deg=0;
  if(h.w){const d=h.w/total*360;segs.push('#3b82f6 '+deg+'deg '+(deg+d)+'deg');deg+=d}
  if(h.i){const d=h.i/total*360;segs.push('#5e6a82 '+deg+'deg '+(deg+d)+'deg');deg+=d}
  if(h.e){const d=h.e/total*360;segs.push('#ef4444 '+deg+'deg '+(deg+d)+'deg');deg+=d}
  if(h.d){const d=h.d/total*360;segs.push('#2a3144 '+deg+'deg '+(deg+d)+'deg');deg+=d}
  el.style.background='conic-gradient('+segs.join(',')+')';
  el.style.mask='radial-gradient(circle at center,transparent 7px,black 8px)';
  el.style.webkitMask=el.style.mask;
}

function rClock(t){
  const el=document.getElementById('clk');
  const now=new Date();
  const hh=String(now.getHours()).padStart(2,'0'),mm=String(now.getMinutes()).padStart(2,'0'),ss=String(now.getSeconds()).padStart(2,'0');
  const uptime=t?D(Date.now()-t.timeCreated):'';
  el.textContent=hh+':'+mm+':'+ss+(uptime?' \\u00B7 '+uptime:'');
}

function rSum(t){
  const el=document.getElementById('sum'),mm=t.members||[],tk=t.tasks||[],msgs=t.messages||[];
  const h=deriveHealth(t),tc=tk.filter(x=>x.status==='completed').length;
  patch(el,
    '<span class="w-[6px] h-[6px] rounded-full '+(t.status==='active'?'bg-emerald-500':'bg-txt-500')+'"></span>'+
    '<span class="font-mono font-semibold text-txt-200">'+E(t.name)+'</span>'+
    (mm.length?chip(mm.length+' agent'+(mm.length!==1?'s':''),'gray'):'')+
    (h.w?chip(h.w+' working','blue'):'')+
    (h.i?chip(h.i+' idle','muted'):'')+
    (h.d?chip(h.d+' done','muted'):'')+
    (h.e?chip(h.e+' error','red'):'')+
    (tk.length?chip(tc+'/'+tk.length+' tasks','green'):'')+
    (msgs.length?chip(msgs.length+' msgs','muted'):'')
  );
}

function rAttention(t){
  const el=document.getElementById('attention'),a=deriveAttention(t),h=deriveHealth(t),tk=t.tasks||[];
  const tone=a.items.length?'border-amber-500/30 bg-amber-500/[0.05]':'border-emerald-500/20 bg-emerald-500/[0.035]';
  const lead=a.items.length?'Needs attention':'No blockers detected';
  const chips=[chip(h.w+' working','blue'),chip(a.running.length+' active tasks','green'),chip(a.blocked.length+' blocked',a.blocked.length?'amber':'muted'),chip(tk.filter(x=>x.status==='pending').length+' pending','muted')];
  let html='<div class="rounded-lg border '+tone+' px-3 py-2 flex flex-col md:flex-row md:items-center gap-2 md:gap-4">';
  html+='<div class="min-w-[180px]"><div class="text-[10px] uppercase tracking-[.16em] text-txt-500">Team attention</div><div class="text-[14px] font-semibold text-txt-100">'+lead+'</div></div>';
  html+='<div class="flex flex-wrap gap-1.5">'+chips.join('')+'</div>';
  if(a.items.length){html+='<div class="flex-1 grid gap-1 md:grid-cols-2">'+a.items.slice(0,4).map(x=>'<div class="text-[12px] text-txt-200 truncate">'+chip(E(x.kind),x.color)+' <span class="font-mono">'+E(x.label)+'</span> <span class="text-txt-400">'+E(x.detail)+'</span></div>').join('')+'</div>'}
  else if(a.latest){html+='<div class="text-[12px] text-txt-400 truncate md:ml-auto">Latest: <span class="text-txt-200">'+E(a.latest.fromName)+'</span> '+relT(a.latest.timeCreated)+'</div>'}
  html+='</div>';
  patch(el,html);
}

function rAgents(t){
  const el=document.getElementById('agents'),mm=t.members||[];
  if(!mm.length){patch(el,'<div class="col-span-full text-center py-12"><div class="text-txt-400 text-sm mb-1">No agents yet</div><div class="text-txt-500 text-[11px]">Spawn teammates with <code class="px-1 py-0.5 bg-base-900 rounded font-mono text-[10px]">team_spawn</code></div></div>');return}
  const n=Date.now(),msgs=t.messages||[],sorted=[...mm].sort((a,b)=>rankAgent(a,b,t));
  const html=sorted.map((m,idx)=>{
    const s=si(m.status,m.executionStatus),task=activeTaskFor(m.name,t.tasks||[]),msg=lastMessageFor(m.name,msgs),blocked=blockedTaskFor(m.name,t.tasks||[]);
    const d=D(n-m.timeUpdated),mi=msg?relT(msg.timeCreated):'\\u2014';
    const tt=task?.content,tr=tt&&tt.length>90?tt.slice(0,90)+'\\u2026':tt;
    const mp=msg?(msg.content.length>90?msg.content.slice(0,90)+'\\u2026':msg.content):'';
    const spark=deriveSparkline(m.name,msgs);
    const isSel=selCard===idx;
    return '<button type="button" class="text-left rounded-lg border '+s.c+' p-3 transition-all duration-300 cursor-pointer hover:border-base-600 focus-visible:border-blue-400'+(isSel?' card-sel':'')+'" data-card="'+E(m.name)+'" onclick="openDrawer(this.dataset.card)" onkeydown="if(event.key===\\'Enter\\'||event.key===\\' \\'){event.preventDefault();openDrawer(this.dataset.card)}">'+
      '<div class="flex items-center gap-2">'+
        '<span class="w-[8px] h-[8px] rounded-full '+s.d+(m.status==='busy'?' pulse':'')+' shrink-0"></span>'+
        '<span class="font-mono font-semibold text-[14px] truncate">'+E(m.name)+'</span>'+
        '<span class="text-[10px] px-1.5 py-[1px] rounded '+s.t+' bg-base-800/80 shrink-0">'+s.l+(m.lastNudgedAt?', nudged '+relT(m.lastNudgedAt):'')+'</span>'+
        spark+
        '<span class="text-[10px] text-txt-500 ml-auto shrink-0">'+E(m.agent)+'</span>'+
        (m.model?chip(E(m.model),'muted'):'')+
      '</div>'+
      (tr?'<div class="mt-2 text-[13px] text-txt-200 leading-snug truncate">'+(blocked?'<span class="text-amber-400">Blocked: </span>':'Current task: ')+E(tr)+'</div>':'<div class="mt-2 text-[13px] text-txt-500 leading-snug">No active task</div>')+
      (mp?'<div class="mt-1 text-[12px] text-txt-400 truncate">Latest: '+E(mp)+'</div>':'')+
      '<div class="mt-2 flex items-center gap-1.5 flex-wrap">'+
        chip('status '+d,'muted')+chip('msg '+mi,'muted')+chip(E(m.executionStatus||m.status),sx(m))+
        (m.isRetrying?chip('retrying'+(m.retryAttempt!=null?' (attempt '+m.retryAttempt+')':''),'amber'):'')+
        (m.worktreeBranch?chip(E(m.worktreeBranch),'muted'):'')+
      '</div></button>';
  }).join('');
  patch(el,html);
}

function openDrawer(name){
  var t=cur();if(!t)return;
  var m=(t.members||[]).find(x=>x.name===name);if(!m)return;
  var s=si(m.status,m.executionStatus),msgs=(t.messages||[]).filter(x=>x.fromName===name);
  var h='';
  // Header
  h+='<div class="flex items-center justify-between mb-4">';
  h+='<div class="flex items-center gap-2"><span class="w-[10px] h-[10px] rounded-full '+s.d+(m.status==='busy'?' pulse':'')+'"></span><h2 id="drawer-title" class="font-mono font-semibold text-[16px]">'+E(m.name)+'</h2><span class="text-[11px] px-2 py-[2px] rounded '+s.t+' bg-base-800/80">'+s.l+'</span></div>';
  h+='<button id="drawer-close" aria-label="Close agent detail" onclick="closeDrawer()" class="text-txt-500 hover:text-txt-200 transition-colors p-1"><svg class="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M18 6L6 18M6 6l12 12"/></svg></button>';
  h+='</div>';
  // Meta chips
  var meta=[];
  meta.push(chip(E(m.agent),'gray'));
  if(m.model)meta.push(chip(E(m.model),'gray'));
  meta.push(chip(E(m.executionStatus||m.status),sx(m)));
  if(m.planApproval&&m.planApproval!=='none')meta.push(chip(E(m.planApproval),m.planApproval==='approved'?'green':m.planApproval==='rejected'?'red':'amber'));
  meta.push(chip('spawned '+relT(m.timeCreated),'muted'));
  if(m.lastNudgedAt)meta.push(chip('nudged '+relT(m.lastNudgedAt),'amber'));
  if(m.isRetrying)meta.push(chip('retrying'+(m.retryAttempt!=null?' (attempt '+m.retryAttempt+')':'')+(m.retryMessage?': '+E(m.retryMessage):''),'amber'));
  if(m.worktreeBranch)meta.push(chip(E(m.worktreeBranch),'muted'));
  h+='<div class="flex flex-wrap gap-1.5 mb-4 pb-4 border-b border-base-800/50">'+meta.join('')+'</div>';
  // Prompt
  if(m.prompt){
    h+='<div class="mb-4"><div class="text-txt-400 text-[10px] uppercase tracking-wider mb-2">Original Prompt</div>';
    h+='<div class="text-[13px] text-txt-200 md bg-base-800/20 rounded-lg p-3 border border-base-800/30">'+md(m.prompt)+'</div></div>';
  }
  // Chat log
  h+='<div class="text-txt-400 text-[10px] uppercase tracking-wider mb-3">Conversation</div>';
  if(!msgs.length){h+='<div class="text-txt-500 text-[12px]">No messages yet</div>'}
  else{
    // Get all messages involving this agent (sent or received)
    var allMsgs=(t.messages||[]).filter(function(x){return x.fromName===name||x.toName===name});
    allMsgs.sort(function(a,b){return a.timeCreated-b.timeCreated});
    allMsgs.forEach(function(am){
      var isAgent=am.fromName===name;
      var p=parseR(am.content);
      var deliv=am.delivered?(am.read?'\\u2713\\u2713':'\\u2713'):'';
      var align=isAgent?'mr-8':'ml-8';
      var bubbleBg=isAgent?'bg-blue-500/[0.07] border-blue-500/20':'bg-base-800/40 border-base-700/30';
      var sender=isAgent?E(am.fromName):'lead';
      h+='<div class="mb-2 '+align+'">';
      h+='<div class="rounded-xl border '+bubbleBg+' p-3">';
      h+='<div class="flex items-center gap-2 mb-1.5">';
      h+='<span class="text-[10px] font-medium '+(isAgent?'text-blue-400':'text-txt-300')+'">'+sender+'</span>';
      h+=chip(relT(am.timeCreated),'muted');
      if(am.toName)h+=chip('\\u2192 '+E(am.toName),'muted');
      if(deliv)h+='<span class="text-txt-500 text-[10px] ml-auto">'+deliv+'</span>';
      h+='</div>';
      if(p){
        h+='<div class="mb-1">'+chip(E(p.status),p.status==='completed'?'green':'red')+' <span class="text-[13px] text-txt-200 font-medium">'+E(p.summary)+'</span></div>';
        if(p.details)h+='<div class="text-[12px] text-txt-300 md mt-2">'+md(p.details)+'</div>';
      }else{
        h+='<div class="text-[12px] text-txt-300 md">'+md(am.content)+'</div>';
      }
      h+='</div></div>';
    });
  }
  // Activity timeline
  h+='<div class="mt-4 pt-4 border-t border-base-800/50">';
  h+='<div class="flex items-center justify-between mb-3">';
  h+='<span class="text-txt-400 text-[10px] uppercase tracking-wider">Activity</span>';
  h+='<button type="button" id="verbose-toggle" onclick="toggleVerbose()" aria-pressed="'+(verbose?'true':'false')+'" class="text-[10px] '+(verbose?'text-blue-400 border-blue-500/40 bg-blue-500/10':'text-txt-500 hover:text-txt-200 border-base-800')+' rounded px-1.5 py-[2px] transition-colors">verbose: '+(verbose?'on':'off')+'</button>';
  h+='</div>';
  h+='<div id="drawer-activity-list"><div class="text-txt-500 text-[12px]">Loading activity...</div></div>';
  h+='</div>';
  var drawer=document.getElementById('drawer');
  drawer.innerHTML=h;
  drawer.classList.add('open');
  drawer.setAttribute('aria-hidden','false');
  drawer.inert=false;
  setBackgroundInert(true);
  drawer.focus();
  document.getElementById('drawer-bg').classList.add('open');
  // Fetch activity for this agent's session
  drawerActivity=null;drawerSession=null;
  if(m.sessionId)fetchActivity(m.sessionId);
  else rDrawerActivityUpdate();
}

function rDrawerActivityUpdate(){
  var el=document.getElementById('drawer-activity-list');
  if(!el)return;
  if(!drawerActivity||!drawerActivity.length){
    el.innerHTML='<div class="text-txt-500 text-[12px]">No activity recorded</div>';
    return;
  }
  var html=drawerActivity.slice().reverse().map(function(a){
    var icon='\\u25CF',color='text-txt-500',label=a.type;
    if(a.type==='tool_call'){icon='\\u25B8';color='text-blue-400';label=a.tool||'tool'}
    if(a.type==='tool_result'){icon='\\u25B8';color=a.error?'text-red-400':'text-emerald-400';label=a.tool||'tool'}
    if(a.type==='shell_command'){icon='$';color='text-amber-400';label='shell'}
    if(a.type==='step'){icon='\\u2261';color='text-violet-400';label='step'}
    if(a.type==='reasoning'){icon='\\u2726';color='text-violet-400';label='reasoning'}
    if(a.type==='file'){icon='\\u25A3';color='text-cyan-400';label=a.filePath?a.filePath.split('/').pop():'file'}
    if(a.type==='text'){icon='\\u00BB';color=a.role==='user'?'text-emerald-400':'text-blue-400';label=a.role==='user'?'prompt':'response'}
    var ts=relT(a.timestamp);
    if(!verbose){
      return '<div class="flex items-center gap-2 py-1 border-b border-base-800/30">'+
        '<span class="'+color+' text-[11px] shrink-0 font-mono">'+icon+'</span>'+
        '<span class="text-[12px] text-txt-400 truncate flex-1">'+E(label)+'</span>'+
        '<span class="text-[10px] text-txt-500 shrink-0">'+ts+'</span>'+
        '</div>';
    }
    if(a.type==='reasoning'){
      return '<details open class="py-2 border-b border-base-800/30">'+
        '<summary class="flex items-center gap-2 cursor-pointer select-none hover:text-txt-100 transition-colors">'+
        '<span class="'+color+' text-[11px] shrink-0 font-mono">'+icon+'</span>'+
        '<span class="text-[12px] text-violet-300 font-medium">Reasoning</span>'+
        '<span class="text-[10px] text-txt-500 ml-auto shrink-0">'+ts+'</span>'+
        '</summary>'+
        '<div class="mt-1.5 ml-5 text-[11px] text-violet-200/60 bg-violet-950/20 rounded-md p-2 border border-violet-800/30 overflow-x-auto whitespace-pre-wrap font-mono max-h-[200px] overflow-y-auto">'+E(a.reasoning||'')+'</div>'+
        '</details>';
    }
    if(a.type==='file'){
      var fname=a.filePath?a.filePath.split('/').pop():'file';
      var fcontent=a.fileDiff||a.fileContent||'';
      return '<details open class="py-2 border-b border-base-800/30">'+
        '<summary class="flex items-center gap-2 cursor-pointer select-none hover:text-txt-100 transition-colors">'+
        '<span class="'+color+' text-[11px] shrink-0 font-mono">'+icon+'</span>'+
        '<span class="text-[12px] text-cyan-300 font-medium truncate flex-1">'+E(a.filePath||fname)+'</span>'+
        '<span class="text-[10px] text-txt-500 shrink-0">'+ts+'</span>'+
        '</summary>'+
        (fcontent?'<div class="mt-1.5 ml-5 text-[11px] text-cyan-200/70 bg-cyan-950/20 rounded-md p-2 border border-cyan-800/30 overflow-x-auto whitespace-pre font-mono max-h-[300px] overflow-y-auto">'+E(fcontent)+'</div>':'')+
        '</details>';
    }
    if(a.type==='text'){
      return '<div class="py-2 border-b border-base-800/30">'+
        '<div class="flex items-start gap-2">'+
        '<span class="'+color+' text-[11px] mt-[1px] shrink-0 font-mono">'+icon+'</span>'+
        '<div class="flex-1 min-w-0">'+
        '<div class="text-[12px] '+(a.role==='user'?'text-emerald-300':'text-blue-300')+' font-medium">'+E(label)+'</div>'+
        '<div class="text-[11px] text-txt-300 mt-1 md">'+md(a.text||'')+'</div>'+
        '</div>'+
        '<span class="text-[10px] text-txt-500 shrink-0">'+ts+'</span>'+
        '</div></div>';
    }
    var title=a.title||a.tool||a.command||label;
    var row='<div class="py-2 border-b border-base-800/30">';
    row+='<div class="flex items-start gap-2">';
    row+='<span class="'+color+' text-[11px] mt-[1px] shrink-0 font-mono">'+icon+'</span>';
    row+='<div class="flex-1 min-w-0">';
    row+='<div class="text-[12px] text-txt-200 font-medium">'+E(title)+'</div>';
    if(a.input){row+='<div class="text-[11px] text-txt-300 mt-1.5 bg-base-900/60 rounded-md p-2 border border-base-700/40 overflow-x-auto font-mono whitespace-pre max-h-[200px] overflow-y-auto">'+E(a.input)+'</div>'}
    if(a.output){row+='<div class="text-[11px] text-emerald-300/80 mt-1.5 bg-emerald-950/20 rounded-md p-2 border border-emerald-800/30 overflow-x-auto whitespace-pre max-h-[200px] overflow-y-auto">'+E(a.output)+'</div>'}
    if(a.error){row+='<div class="text-[11px] text-red-400 mt-1.5 bg-red-950/20 rounded-md p-2 border border-red-800/30 overflow-x-auto">'+E(a.error)+'</div>'}
    if(a.command){row+='<div class="text-[11px] text-amber-300 mt-1.5 bg-amber-950/20 rounded-md p-2 border border-amber-800/30 overflow-x-auto font-mono whitespace-pre">'+E(a.command)+'</div>'}
    if(a.exitCode!==undefined||a.cost||a.tokensIn||a.tokensOut){
      row+='<div class="flex flex-wrap gap-1.5 mt-1.5">';
      if(a.exitCode!==undefined){row+=chip('exit: '+a.exitCode,'muted')}
      if(a.cost){row+=chip('$'+a.cost.toFixed(4),'gray')}
      if(a.tokensIn||a.tokensOut){row+=chip((a.tokensIn||0)+' in / '+(a.tokensOut||0)+' out','muted')}
      row+='</div>';
    }
    row+='</div>';
    row+='<span class="text-[10px] text-txt-500 shrink-0">'+ts+'</span>';
    row+='</div></div>';
    return row;
  }).join('');
  el.innerHTML=html;
}

function closeDrawer(){
  var drawer=document.getElementById('drawer');
  drawer.classList.remove('open');
  drawer.setAttribute('aria-hidden','true');
  drawer.inert=true;
  if(!modalOpen())setBackgroundInert(false);
  document.getElementById('drawer-bg').classList.remove('open');
}

function rTasks(t){
  const el=document.getElementById('tasks'),tk=t.tasks||[];
  if(!tk.length){patch(el,'<div class="text-txt-500 text-sm py-6 text-center">No tasks yet</div>');return}
  const c=tk.filter(x=>x.status==='completed').length,pct=Math.max(Math.round(c/tk.length*100),tk.length>0?2:0);
  const allDone=c===tk.length&&tk.length>0;
  const g={in_progress:[],pending:[],completed:[],blocked:[],cancelled:[]};for(const x of tk)(g[x.status]||(g[x.status]=[])).push(x);
  const ds=saveD(el);
  const taskMap={};tk.forEach(x=>{taskMap[x.id]=x});
  function grp(label,items,dc,defOpen){
    if(!items.length)return'';
    const rows=items.map(x=>{
      const ic=x.status==='completed'?'\\u2713':x.status==='in_progress'?'\\u25CF':'\\u25CB';
      const icl=x.status==='completed'?'text-emerald-500':x.status==='in_progress'?'text-blue-400':'text-txt-500';
      const p=PR[x.priority]||PR.low,cn=x.content.length>55?x.content.slice(0,55)+'\\u2026':x.content;
      let dep='';
      const depIds=Array.isArray(x.dependsOn)?x.dependsOn:(x.dependsOn?[String(x.dependsOn)]:[]);
      if(depIds.length){const labels=depIds.map(id=>{const parent=taskMap[id];return parent?parent.content.slice(0,42):id}).join(', ');dep='<div class="text-[10px] text-txt-500 mt-0.5">blocked by: '+E(labels)+'</div>'}
      return '<div class="flex items-start gap-2 py-1.5 px-1 rounded hover:bg-base-800/40 transition-colors">'+
        '<span class="'+icl+' text-[11px] mt-[2px] shrink-0">'+ic+'</span>'+
        '<div class="flex-1 min-w-0"><div class="text-[13px] text-txt-200 truncate">'+E(cn)+'</div>'+
        '<div class="flex gap-2 mt-1 text-[10px]"><span class="rounded px-1.5 py-[0px] '+p+'">'+E(x.priority)+'</span>'+
        '<span class="text-txt-500">'+(E(x.assignee)||'unassigned')+'</span></div>'+dep+'</div></div>';
    }).join('');
    return '<details '+(defOpen?'open':'')+'><summary class="flex items-center gap-2 text-[11px] text-txt-300 cursor-pointer py-1.5 hover:text-txt-200 transition-colors select-none">'+
      '<svg class="w-3 h-3 transition-transform [details[open]>summary>&]:rotate-90" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M9 18l6-6-6-6"/></svg>'+
      '<span class="w-[6px] h-[6px] rounded-full '+dc+'"></span>'+label+' <span class="text-txt-500">('+items.length+')</span></summary>'+
      '<div class="ml-5 mt-1">'+rows+'</div></details>';
  }
  el.innerHTML='<div class="flex items-center gap-3 mb-3">'+
    '<span class="text-[11px] text-txt-300 font-semibold uppercase tracking-wider">Tasks</span>'+
    '<div class="flex-1 bg-base-800 rounded-full h-[5px]"><div class="'+(allDone?'shimmer':'bg-emerald-500')+' h-[5px] rounded-full transition-all duration-500" style="width:'+pct+'%"></div></div>'+
    '<span class="text-[11px] text-txt-400 font-mono">'+c+'/'+tk.length+'</span>'+
    (allDone?'<span class="text-emerald-400 text-[10px] font-medium">All complete</span>':'')+
  '</div>'+
  grp('In Progress',g.in_progress,'bg-blue-500',true)+grp('Pending',g.pending,'bg-txt-500',true)+grp('Blocked',g.blocked||[],'bg-amber-500',true)+grp('Completed',g.completed,'bg-emerald-500',false);
  restD(el,ds);
}

function rActivity(t){
  const el=document.getElementById('activity'),msgs=t.messages||[];
  if(!msgs.length){patch(el,'<div class="text-txt-500 text-sm py-6 text-center">Waiting for agent messages...</div>');return}
  const sp=saveSc(el);
  const newCount=msgs.length,hasNew=newCount>prevMC&&prevMC>0;
  let html='<div class="flex items-center gap-2 mb-3"><span class="text-[11px] text-txt-300 font-semibold uppercase tracking-wider">Activity feed</span>'+chip(msgs.length+' msgs','muted')+'</div>';
  html+='<div class="max-h-[50vh] overflow-y-auto scroll space-y-2">';
  msgs.slice(0,30).forEach(function(m,mi){
    const isNew=hasNew&&mi<(newCount-prevMC);
    const isExp=expMsgs.has(m.id);
    const p=parseR(m.content);
    const deliv=m.delivered?(m.read?'\\u2713\\u2713':'\\u2713'):'';
    const isFromAgent=m.fromName!=='lead'&&m.fromName!=='system'&&m.fromName!=='human';
    const isHuman=m.fromName==='human';
    const isBroadcast=!m.toName||m.toName==='all';
    const isPeer=(isFromAgent||isHuman)&&!isBroadcast&&m.toName!=='lead';
    const align=isHuman?'ml-12':isFromAgent?'mr-6':'ml-6';
    const bubbleBg=isHuman?'bg-emerald-500/[0.1] border-emerald-500/30':isPeer?'bg-violet-500/[0.06] border-violet-500/15':isFromAgent?'bg-blue-500/[0.06] border-blue-500/15':'bg-base-800/40 border-base-700/30';
    const initial=m.fromName.charAt(0).toUpperCase();
    const avatarColor=m.fromName==='system'?'bg-amber-500/20 text-amber-400':isHuman?'bg-emerald-500/30 text-emerald-300':isPeer?'bg-violet-500/20 text-violet-400':isFromAgent?'bg-blue-500/20 text-blue-400':'bg-emerald-500/20 text-emerald-400';
    html+='<div class="'+align+(isNew?' hl':'')+' cursor-pointer" role="button" tabindex="0" aria-expanded="'+(isExp?'true':'false')+'" data-msg="'+E(m.id)+'" onclick="toggleMsg(this.dataset.msg)" onkeydown="if(event.key===\\'Enter\\'||event.key===\\' \\'){event.preventDefault();toggleMsg(this.dataset.msg)}">';
    html+='<div class="flex items-start gap-2">';
    html+='<span class="w-5 h-5 rounded-full '+avatarColor+' flex items-center justify-center text-[9px] font-semibold shrink-0 mt-0.5">'+E(initial)+'</span>';
    html+='<div class="flex-1 min-w-0 rounded-xl border '+bubbleBg+' px-3 py-2">';
    html+='<div class="flex items-center gap-1.5 mb-1">';
    html+='<span class="text-[11px] font-medium '+(isHuman?'text-emerald-400':isPeer?'text-violet-400':isFromAgent?'text-blue-400':'text-txt-300')+'">'+(isHuman?chip('VOC\xCA','green'):E(m.fromName))+'</span>';
    if(m.toName)html+=chip('\\u2192 '+E(m.toName),'muted');
    html+=chip(relT(m.timeCreated),'muted');
    if(deliv)html+='<span class="text-txt-500 text-[10px] ml-auto">'+deliv+'</span>';
    html+='</div>';
    if(p){
      html+='<div>'+chip(E(p.status),p.status==='completed'?'green':'red')+' <span class="text-[13px] text-txt-200">'+E(p.summary)+'</span></div>';
      if(isExp&&p.details)html+='<div class="mt-2 text-[12px] text-txt-300 md">'+md(p.details)+'</div>';
      if(!isExp&&p.details)html+='<div class="mt-1 text-[10px] text-txt-500">Click to expand details</div>';
    }else{
      if(isExp){html+='<div class="text-[12px] text-txt-300 md">'+md(m.content)+'</div>'}
      else{const preview=m.content.length>120?m.content.slice(0,120)+'\\u2026':m.content;html+='<div class="text-[13px] text-txt-300 truncate">'+E(preview)+'</div>'}
    }
    html+='</div></div></div>';
  });
  if(msgs.length>30)html+='<div class="text-center text-[10px] text-txt-500 py-2">+'+(msgs.length-30)+' older messages</div>';
  html+='</div>';
  prevMC=newCount;
  el.innerHTML=html;
  restSc(el,sp);
}

function rTimeline(t){
  const el=document.getElementById('tl'),evs=deriveTimeline(t);
  if(!evs.length){el.classList.add('hidden');return}
  el.classList.remove('hidden');
  const html=evs.map(ev=>{
    return '<div class="flex flex-col items-center mx-1 shrink-0 group" title="'+E(ev.label)+' \\u00B7 '+relT(ev.t)+'"><div class="w-[6px] h-[6px] rounded-full '+ev.c+' group-hover:scale-150 transition-transform"></div><div class="text-[8px] text-txt-500 mt-0.5 hidden group-hover:block whitespace-nowrap">'+E(ev.label)+'</div></div>';
  }).join('<div class="w-3 h-px bg-base-700 shrink-0 self-center"></div>');
  patch(el,'<span class="text-[9px] text-txt-500 uppercase tracking-wider mr-3 shrink-0">Timeline</span>'+html);
}
`;

// src/dashboard.ts
init_log();
var DASHBOARD_HTML = DASHBOARD_HEAD + "\n<script>" + DASHBOARD_JS_CORE + DASHBOARD_JS_RENDER + DASHBOARD_JS_EVENTS + "</script>\n</body></html>";
function parseDependsOn(value) {
  if (!value) return [];
  try {
    const parsed = JSON.parse(value);
    if (Array.isArray(parsed)) return parsed.filter((item) => typeof item === "string");
    if (typeof parsed === "string") return [parsed];
  } catch {
    return [value];
  }
  return [];
}
var ENSEMBLE_STATE_VERSION = 1;
function buildState(db) {
  const projects = db.query("SELECT id, name, path, status, time_created, time_updated FROM project ORDER BY time_updated DESC").all();
  const teams = db.query("SELECT id, name, project_id, lead_session_id, status, lead_agent, time_created, time_updated FROM team ORDER BY time_created DESC").all();
  const memberStmt = db.query("SELECT name, agent, status, execution_status, session_id, worktree_branch, prompt, model, plan_approval, time_created, time_updated, last_nudged_at, retry_until, retry_attempt, retry_provider, retry_message FROM team_member WHERE team_id = ?");
  const taskStmt = db.query("SELECT id, content, status, priority, assignee, depends_on, time_created, time_updated FROM team_task WHERE team_id = ?");
  const msgStmt = db.query("SELECT id, from_name, to_name, content, delivered, read, time_created FROM team_message WHERE team_id = ? ORDER BY time_created DESC LIMIT 50");
  const mappedTeams = teams.map((t) => {
    const members = memberStmt.all(t.id).map((m) => ({
      name: m.name,
      agent: m.agent,
      status: m.status,
      executionStatus: m.execution_status,
      sessionId: m.session_id,
      worktreeBranch: m.worktree_branch,
      prompt: m.prompt,
      model: m.model,
      planApproval: m.plan_approval,
      timeCreated: m.time_created,
      timeUpdated: m.time_updated,
      lastNudgedAt: m.last_nudged_at,
      // Fix 4: derived, read-time TTL boolean (Fix 3) — never a stored enum.
      // Additive fields; existing consumers that don't know about them simply
      // don't render them.
      isRetrying: m.retry_until !== null && m.retry_until > Date.now(),
      retryUntil: m.retry_until,
      retryAttempt: m.retry_attempt,
      retryProvider: m.retry_provider,
      retryMessage: m.retry_message
    }));
    return {
      id: t.id,
      name: t.name,
      projectId: t.project_id,
      leadSessionId: t.lead_session_id,
      status: t.status,
      leadAgent: t.lead_agent,
      timeCreated: t.time_created,
      timeUpdated: t.time_updated,
      members,
      tasks: taskStmt.all(t.id).map((tk) => ({
        id: tk.id,
        content: tk.content,
        status: tk.status,
        priority: tk.priority,
        assignee: tk.assignee,
        dependsOn: parseDependsOn(tk.depends_on),
        timeCreated: tk.time_created,
        timeUpdated: tk.time_updated
      })),
      messages: msgStmt.all(t.id).map((msg) => ({
        id: msg.id,
        fromName: msg.from_name,
        toName: msg.to_name,
        content: msg.content,
        delivered: msg.delivered === 1,
        read: msg.read === 1,
        timeCreated: msg.time_created
      }))
    };
  });
  const teamsByProject = /* @__PURE__ */ new Map();
  mappedTeams.forEach((team) => {
    const projectId = team.projectId;
    teamsByProject.set(projectId, [...teamsByProject.get(projectId) ?? [], team]);
  });
  return {
    version: ENSEMBLE_STATE_VERSION,
    projects: projects.flatMap((project) => {
      const projectTeams = teamsByProject.get(project.id) ?? [];
      if (projectTeams.length === 0) return [];
      return {
        id: project.id,
        name: project.name,
        path: project.path,
        status: project.status,
        timeCreated: project.time_created,
        timeUpdated: project.time_updated,
        activeTeams: projectTeams.filter((team) => team.status === "active").length,
        workingAgents: projectTeams.reduce((count, team) => {
          const members = team.members;
          return count + members.filter((member) => member.status === "busy").length;
        }, 0),
        teams: projectTeams
      };
    }),
    teams: mappedTeams
  };
}
function sendJson(res, data, status = 200) {
  res.writeHead(status, {
    "Content-Type": "application/json",
    "Access-Control-Allow-Origin": "*"
  });
  res.end(JSON.stringify(data));
}
function parseMessageTime(time) {
  if (typeof time === "object" && time !== null) {
    const created = time.created;
    if (typeof created === "number" && Number.isFinite(created)) return created;
  }
  if (typeof time === "number" && Number.isFinite(time)) return time;
  if (typeof time === "string") {
    const ms = new Date(time).getTime();
    if (!Number.isNaN(ms)) return ms;
  }
  return Date.now();
}
function parseMessageParts(parts, msgInfo) {
  const entries = [];
  const info = msgInfo ?? {};
  const timestamp = parseMessageTime(info.time);
  for (const part of parts) {
    if (typeof part !== "object" || part === null) continue;
    const p = part;
    if (p.type === "tool" && p.tool) {
      const state = p.state ?? {};
      const inputStr = typeof state.input === "string" ? state.input : state.input != null ? JSON.stringify(state.input, null, 2) : void 0;
      const outputStr = typeof state.output === "string" ? state.output : state.output != null ? JSON.stringify(state.output, null, 2) : void 0;
      entries.push({
        type: state.status === "completed" ? "tool_result" : "tool_call",
        tool: p.tool,
        title: state.title,
        input: inputStr,
        output: outputStr,
        error: state.error,
        timestamp
      });
    } else if (p.type === "reasoning" && p.text) {
      entries.push({ type: "reasoning", reasoning: p.text, timestamp });
    } else if (p.type === "file" && (p.path || p.content || p.diff)) {
      entries.push({
        type: "file",
        filePath: p.path,
        fileContent: p.content,
        fileDiff: p.diff,
        timestamp
      });
    } else if (p.type === "text" && p.text) {
      entries.push({ type: "text", text: p.text, role: info.role, timestamp });
    } else if (p.type === "step-start") {
      entries.push({ type: "step", title: p.label ?? p.step ?? "step", timestamp });
    } else if (p.type === "step-finish") {
      entries.push({ type: "step", title: p.label ?? p.step ?? "step complete", timestamp });
    }
  }
  return entries;
}
async function handleActivityRoute(sessionId, options, res) {
  const buffer = options?.activityBuffer;
  const client = options?.client;
  const buffered = buffer?.getActivity(sessionId) ?? [];
  let sessionData = null;
  let fallbackActivity = [];
  if (client) {
    try {
      const [msgResult, getResult] = await Promise.all([
        client.session.messages({ sessionID: sessionId, limit: 100 }),
        client.session.get({ sessionID: sessionId })
      ]);
      const messages = msgResult.data ?? [];
      for (const msg of messages) {
        const parts = msg.parts ?? [];
        fallbackActivity.push(...parseMessageParts(parts, msg.info));
      }
      sessionData = getResult.data ?? null;
    } catch {
    }
  }
  const combined = [...buffered, ...fallbackActivity].sort((a, b) => a.timestamp - b.timestamp);
  sendJson(res, { activity: combined, session: sessionData });
}
function handleDashboardRequest(db, port, req, res, options) {
  const url = new URL(req.url ?? "/", `http://${req.headers.host ?? `localhost:${port}`}`);
  if (url.pathname === "/api/health") {
    sendJson(res, { ensemble: true, pid: process.pid });
    return;
  }
  if (url.pathname === "/api/state") {
    sendJson(res, buildState(db));
    return;
  }
  if (req.method === "POST" && url.pathname === "/api/chat/send") {
    let body = "";
    req.on("data", (chunk) => {
      body += chunk;
    });
    req.on("end", () => {
      try {
        const payload = JSON.parse(body);
        let text = String(payload.text || "");
        let to = payload.to ? String(payload.to) : "";
        if (!text.trim()) {
          sendJson(res, { ok: false, error: "Empty message" }, 400);
          return;
        }
        const mentionMatch = text.match(/^@([a-zA-Z0-9_-]+)\s+/);
        if (mentionMatch) {
          to = mentionMatch[1];
          text = text.slice(mentionMatch[0].length);
        }
        const activeTeam = db.query("SELECT id FROM team WHERE status = 'active' ORDER BY time_updated DESC LIMIT 1").get();
        if (!activeTeam) {
          sendJson(res, { ok: false, error: "No active team found" }, 400);
          return;
        }
        const teamId = activeTeam.id;
        const isBroadcast = !to || ["all", "todos", "broadcast"].includes(to.toLowerCase());
        const recipients = [];
        let messageId;
        if (isBroadcast) {
          messageId = broadcastMessage(db, { teamId, from: "human", content: text });
          const members = db.query("SELECT session_id, name FROM team_member WHERE team_id = ? AND status NOT IN ('shutdown', 'error')").all(teamId);
          for (const m of members) {
            if (hasReportedCompletion(db, teamId, m.name)) continue;
            recipients.push(m.name);
            if (options?.client) {
              options.client.session.promptAsync({
                sessionID: m.session_id,
                parts: [{ type: "text", text: `[Team broadcast from human]: ${text}` }],
                synthetic: true
              }).catch((err) => log(`dashboard:chat broadcast failed to ${m.name} err=${err}`));
            }
          }
        } else {
          const member = db.query("SELECT session_id FROM team_member WHERE team_id = ? AND name = ? AND status NOT IN ('shutdown', 'error')").get(teamId, to);
          if (!member) {
            sendJson(res, { ok: false, error: `Member '${to}' not found in active team` }, 404);
            return;
          }
          messageId = sendMessage(db, { teamId, from: "human", to, content: text });
          recipients.push(to);
          if (options?.client) {
            options.client.session.promptAsync({
              sessionID: member.session_id,
              parts: [{ type: "text", text: `[Direct message from human]: ${text}` }],
              synthetic: true
            }).catch((err) => log(`dashboard:chat direct msg failed to ${to} err=${err}`));
          }
        }
        sendJson(res, { ok: true, messageId, recipients }, 200);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        sendJson(res, { ok: false, error: msg }, 500);
      }
    });
    return;
  }
  const activityMatch = url.pathname?.match(/^\/api\/session\/([^/]+)\/activity$/);
  if (activityMatch) {
    const sessionId = decodeURIComponent(activityMatch[1]);
    handleActivityRoute(sessionId, options, res).catch(() => {
      if (!res.headersSent) {
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Failed to fetch activity" }));
      }
    });
    return;
  }
  if (url.pathname === "/") {
    res.writeHead(200, { "Content-Type": "text/html" });
    res.end(DASHBOARD_HTML);
    return;
  }
  res.writeHead(404, { "Content-Type": "text/plain" });
  res.end("Not Found");
}
function toDashboardServer(server) {
  return {
    stop(force) {
      server.close();
      if (force) {
        const closeAll = server.closeAllConnections;
        if (typeof closeAll === "function") closeAll.call(server);
      }
    }
  };
}
async function startDashboard(db, port, options) {
  return new Promise((resolve) => {
    const server = createServer((req, res) => handleDashboardRequest(db, port, req, res, options));
    server.once("error", async (err) => {
      if (err.code === "EADDRINUSE") {
        try {
          const res = await fetch(`http://localhost:${port}/api/health`);
          const data = await res.json();
          if (data.ensemble && data.pid) {
            let alive = false;
            try {
              process.kill(data.pid, 0);
              alive = true;
            } catch {
            }
            if (alive && data.pid !== process.pid) {
              log(`dashboard:already-running port=${port} pid=${data.pid}`);
              resolve(null);
              return;
            }
            log(`dashboard:stale-server port=${port} stale-pid=${data.pid} \u2014 run: kill -9 ${data.pid} || lsof -ti:${port} | xargs kill -9`);
            resolve(null);
            return;
          }
        } catch {
        }
        log(`dashboard:port-in-use port=${port} (not an ensemble instance)`);
        resolve(null);
        return;
      }
      log(`dashboard:failed err=${err.message}`);
      resolve(null);
    });
    server.listen(port, () => {
      log(`dashboard:started port=${port} url=http://localhost:${port}`);
      resolve(toDashboardServer(server));
    });
  });
}

// src/rpc.ts
import { Rpc } from "@opencode/plugin/rpc";
var EnsembleRpc = Rpc.define({
  id: "ensemble",
  methods: {
    summary: {
      input: {
        type: "object",
        properties: { team: { type: "string" } },
        required: ["team"],
        additionalProperties: false
      },
      output: {
        type: "object",
        properties: { text: { type: "string" } },
        required: ["text"],
        additionalProperties: false
      }
    },
    teamContext: {
      input: {
        type: "object",
        properties: { sessionID: { type: "string" } },
        required: ["sessionID"],
        additionalProperties: false
      },
      output: {
        type: "object",
        properties: {
          team: { type: ["string", "null"] },
          members: {
            type: "array",
            items: {
              type: "object",
              properties: { name: { type: "string" }, status: { type: "string" } },
              required: ["name", "status"],
              additionalProperties: false
            }
          },
          tasks: {
            type: "object",
            properties: {
              pending: { type: "number" },
              done: { type: "number" }
            },
            required: ["pending", "done"],
            additionalProperties: false
          }
        },
        required: ["team", "members", "tasks"],
        additionalProperties: false
      }
    }
  },
  events: {
    member: {
      schema: {
        type: "object",
        properties: {
          memberName: { type: "string" },
          teamId: { type: "string" },
          from: { type: "string" },
          to: { type: "string" }
        },
        required: ["memberName", "teamId", "from", "to"],
        additionalProperties: false
      }
    },
    notice: {
      schema: {
        type: "object",
        properties: {
          title: { type: "string" },
          message: { type: "string" },
          variant: { type: "string" }
        },
        required: ["message"],
        additionalProperties: false
      }
    },
    view: {
      schema: {
        type: "object",
        properties: {
          sessionID: { type: "string" },
          memberName: { type: "string" }
        },
        required: ["sessionID"],
        additionalProperties: false
      }
    }
  }
});

// src/v2-rpc.ts
async function emitMemberEvent(registration, data) {
  await registration.events.emit("member", data);
}
async function emitNoticeEvent(registration, data) {
  await registration.events.emit("notice", data);
}

// src/v2-setup.ts
init_log();
function extractQuestionOutput(result) {
  const content = result?.content;
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content.filter((part) => part.type === "text").map((part) => part.text ?? "").join("\n");
  }
  return "";
}
async function setupEnsemble(ctx, options = {}) {
  const db = createDb(options.dbPath ?? getDbPath());
  const config = loadConfig(ctx.location.directory);
  const registry = new MemberRegistry();
  const tracker = new DescendantTracker();
  const purgeApprovals = new PendingPurgeApprovals();
  const activityBuffer = new ActivityBuffer();
  const progressTracker = new ProgressTracker();
  const nudgedMembers = /* @__PURE__ */ new Set();
  const rehydrated = rehydrateRegistry(db, registry);
  if (rehydrated > 0) vlog(`init:registry:rehydrated members=${rehydrated}`);
  const nudgeMember = (teamId, memberName, sessionId) => {
    const nudgeKey = `${teamId}:${memberName}`;
    if (nudgedMembers.has(nudgeKey)) return;
    if (!shouldNudgeIdleMember(db, teamId, memberName)) return;
    if (hasReportedCompletion(db, teamId, memberName)) return;
    nudgedMembers.add(nudgeKey);
    db.run("UPDATE team_member SET last_nudged_at = ? WHERE team_id = ? AND name = ?", [
      Date.now(),
      teamId,
      memberName
    ]);
    vlog(`nudge:idle-without-report name=${memberName}`);
    void deliverPrompt(
      ctx.session,
      sessionId,
      "[System]: You completed your work but did not report results. Send your findings to the lead via team_message now."
    ).catch((err) => {
      vlog(`nudge:idle-without-report:failed name=${memberName} err=${err instanceof Error ? err.message : String(err)}`);
    });
  };
  const nudgeCutoff = Date.now() - 60 * 60 * 1e3;
  const silent = db.query(
    `SELECT tm.team_id, tm.name, tm.session_id FROM team_member tm
     JOIN team t ON tm.team_id = t.id
     WHERE t.status = 'active' AND tm.status = 'ready'
       AND tm.execution_status != 'standby'
       AND (tm.last_nudged_at IS NULL OR tm.last_nudged_at < ?)`
  ).all(nudgeCutoff);
  for (const member of silent) nudgeMember(member.team_id, member.name, member.session_id);
  const rateLimiter = new TokenBucket({
    capacity: config.rateLimitCapacity,
    refillRate: 2,
    refillIntervalMs: 1e3
  });
  const controller = new AbortController();
  const dispatch = async (event) => {
    const transition = dispatchV2Event(db, registry, tracker, event);
    if (transition && transition.to === "ready" && transition.from === "busy") {
      const entry = registry.getByName(transition.teamId, transition.memberName);
      if (entry) nudgeMember(transition.teamId, transition.memberName, entry.sessionId);
    }
    if (transition && rpc) {
      await emitMemberEvent(rpc, transition).catch(() => {
      });
      if (transition.to === "ready" && transition.from === "busy") {
        await emitNoticeEvent(rpc, {
          title: "Team",
          message: `${transition.memberName} finished`,
          variant: "success"
        }).catch(() => void 0);
      } else if (transition.to === "error") {
        await emitNoticeEvent(rpc, {
          title: "Team",
          message: `${transition.memberName} errored`,
          variant: "error"
        }).catch(() => void 0);
      }
    }
  };
  let rpc = null;
  try {
    rpc = await ctx.rpc.register(EnsembleRpc, {
      summary: async (input) => {
        const team = input.team ?? "";
        const row = db.query("SELECT status FROM team WHERE name = ?").get(team);
        if (!row) return { text: `No team "${team}".` };
        const members = db.query("SELECT name, status FROM team_member WHERE team_id IN (SELECT id FROM team WHERE name = ?)").all(team);
        const summary = members.map((m) => `${m.name}: ${m.status}`).join(", ");
        return { text: `Team "${team}" (${row.status}): ${summary || "no members"}` };
      },
      teamContext: async (input) => {
        const sessionID = input.sessionID ?? "";
        const teamInfo = findTeamBySession(db, registry, sessionID);
        if (!teamInfo) return { team: null, members: [], tasks: { pending: 0, done: 0 } };
        const members = db.query("SELECT name, status FROM team_member WHERE team_id = ?").all(
          teamInfo.teamId
        );
        const pending = db.query("SELECT COUNT(*) as c FROM team_task WHERE team_id = ? AND status != 'completed'").get(
          teamInfo.teamId
        ).c;
        const done = db.query("SELECT COUNT(*) as c FROM team_task WHERE team_id = ? AND status = 'completed'").get(
          teamInfo.teamId
        ).c;
        return { team: teamInfo.teamName, members, tasks: { pending, done } };
      }
    });
  } catch (err) {
    vlog(`init:rpc:failed err=${err instanceof Error ? err.message : String(err)}`);
  }
  void (async () => {
    try {
      for await (const event of ctx.event.subscribe({ signal: controller.signal })) {
        await dispatch(event);
      }
    } catch {
    }
  })();
  await ctx.tool.hook("execute.before", (raw) => {
    const input = raw;
    checkToolIsolation(registry, tracker, input.tool, input.sessionID, db);
    if (input.tool.startsWith("team_")) {
      if (!rateLimiter.tryConsume()) {
        return rateLimiter.waitForToken().then(() => void 0);
      }
    }
    recordFromToolBefore({ sessionID: input.sessionID, tool: input.tool }, registry, activityBuffer);
  });
  await ctx.tool.hook("execute.after", (raw) => {
    const event = raw;
    if (event.tool === "question") {
      purgeApprovals.recordQuestionAnswer(
        event.sessionID,
        extractQuestionOutput(event.result),
        event.input
      );
    }
    recordFromToolAfter(
      { sessionID: event.sessionID, tool: event.tool },
      {},
      registry,
      activityBuffer
    );
  });
  await ctx.session.hook("context", (raw) => {
    const event = raw;
    if (!event.sessionID) return;
    const teamInfo = findTeamBySession(db, registry, event.sessionID);
    if (!teamInfo) return;
    const prompt = teamInfo.role === "lead" ? buildLeadSystemPrompt(db, teamInfo.teamId, config) : buildTeammateSystemPrompt(db, teamInfo.teamId, teamInfo.memberName ?? "unknown", config);
    vlog(`system-prompt:injected role=${teamInfo.role} len=${prompt.length}`);
    event.system.push({ type: "text", text: prompt });
    if (teamInfo.role === "member") {
      event.system.push({
        type: "text",
        text: 'Ensemble tools on this platform are called through the execute tool, e.g. tools.team_message({ to: "lead", text: "..." }). Do not call them directly.'
      });
    }
  });
  await ctx.session.hook("compaction", (raw) => {
    const event = raw;
    if (!event.sessionID) return;
    const teamInfo = findTeamBySession(db, registry, event.sessionID);
    if (!teamInfo) return;
    const context = buildTeamCompactionContext(db, teamInfo.teamId, teamInfo.role, teamInfo.memberName, config);
    event.system.push({ type: "text", text: context });
  });
  await ctx.shell.hook("create.before", () => void 0);
  const client = createV2Client(ctx, rpc ? { rpcEmitter: rpc } : {});
  const deps = {
    db,
    registry,
    tracker,
    purgeApprovals,
    client,
    directory: ctx.location.directory,
    config,
    progressTracker
  };
  await registerV2Tools(ctx.tool, deps);
  let dashboard = null;
  const dashboardPort = options.dashboardPort ?? config.dashboardPort;
  if (dashboardPort !== 0 && !isWorktreeInstance(ctx.location.directory)) {
    dashboard = await startDashboard(db, dashboardPort, { activityBuffer, client }).catch((err) => {
      vlog(`init:dashboard:failed err=${err instanceof Error ? err.message : String(err)}`);
      return null;
    });
  }
  return {
    db,
    registry,
    tracker,
    dispatch,
    dispose: async () => {
      controller.abort();
      dashboard?.stop();
    }
  };
}

// src/index.ts
import { tool } from "@opencode-ai/plugin";
import { OpencodeClient } from "@opencode-ai/sdk/v2";
import path4 from "node:path";
import { mkdirSync } from "node:fs";

// src/client.ts
function extractError(err) {
  if (err && typeof err === "object" && "message" in err) return String(err.message);
  return String(err);
}
function throwing(fn) {
  return async (...args) => {
    const result = await fn(...args);
    if (result && typeof result === "object" && "error" in result && result.error !== void 0) {
      throw new Error(extractError(result.error));
    }
    return result;
  };
}
function wrapThrowingClient(raw) {
  const r = raw;
  return {
    session: {
      create: throwing(r.session.create.bind(r.session)),
      promptAsync: throwing(r.session.promptAsync.bind(r.session)),
      abort: throwing(r.session.abort.bind(r.session)),
      status: throwing(r.session.status.bind(r.session)),
      messages: throwing(r.session.messages.bind(r.session)),
      get: throwing(r.session.get.bind(r.session))
    },
    tui: {
      showToast: throwing(r.tui.showToast.bind(r.tui)),
      selectSession: throwing(r.tui.selectSession.bind(r.tui))
    },
    worktree: {
      create: throwing(r.worktree.create.bind(r.worktree)),
      remove: throwing(r.worktree.remove.bind(r.worktree)),
      list: throwing(r.worktree.list.bind(r.worktree)),
      reset: throwing(r.worktree.reset.bind(r.worktree))
    },
    workspace: {
      create: throwing(r.experimental.workspace.create.bind(r.experimental.workspace)),
      remove: throwing(r.experimental.workspace.remove.bind(r.experimental.workspace)),
      list: throwing(r.experimental.workspace.list.bind(r.experimental.workspace))
    }
  };
}

// src/index.ts
init_log();

// src/watchdog.ts
init_merge_helper();
import { createRequire as createRequire2 } from "node:module";
import path3 from "node:path";
init_log();
var requireSessionModule = createRequire2(import.meta.url);
function sessionStorePath(env = process.env) {
  const home = env.HOME ?? env.USERPROFILE ?? "~";
  return path3.join(home, ".local", "share", "opencode", "opencode.db");
}
function openSessionStore(dbPath) {
  if (typeof process.versions.bun === "string") {
    const { Database } = requireSessionModule("bun:sqlite");
    const db2 = new Database(dbPath, { readonly: true });
    return { get: (sql, ...params) => db2.query(sql).get(...params), close: () => db2.close() };
  }
  const { DatabaseSync } = requireSessionModule("node:sqlite");
  const db = new DatabaseSync(dbPath, { readOnly: true });
  return { get: (sql, ...params) => db.prepare(sql).get(...params), close: () => db.close() };
}
function isSessionCompacting(sessionId, env = process.env) {
  if (!sessionId) return false;
  let handle;
  try {
    handle = openSessionStore(sessionStorePath(env));
    const row = handle.get("SELECT time_compacting FROM session WHERE id = ?", sessionId);
    return typeof row?.time_compacting === "number" && row.time_compacting > 0;
  } catch (err) {
    log(`watchdog:compact:probe-failed session=${sessionId} err=${err instanceof Error ? err.message : String(err)}`);
    return false;
  } finally {
    if (handle) {
      try {
        handle.close();
      } catch {
      }
    }
  }
}
var Watchdog = class _Watchdog {
  db;
  client;
  registry;
  ttlMs;
  checkIntervalMs;
  progressTracker;
  stallThresholdMs;
  stallMinSteps;
  stallTokenThreshold;
  cwd;
  peerMessageLimit;
  peerMessageWindowMs;
  timer;
  constructor(opts) {
    this.db = opts.db;
    this.client = opts.client;
    this.registry = opts.registry;
    this.ttlMs = opts.ttlMs;
    this.checkIntervalMs = opts.checkIntervalMs ?? 6e4;
    this.progressTracker = opts.progressTracker;
    this.stallThresholdMs = opts.stallThresholdMs ?? 0;
    this.stallMinSteps = opts.stallMinSteps ?? 3;
    this.stallTokenThreshold = opts.stallTokenThreshold ?? 500;
    this.cwd = opts.cwd;
    this.peerMessageLimit = opts.peerMessageLimit ?? 0;
    this.peerMessageWindowMs = opts.peerMessageWindowMs ?? 3e5;
  }
  static STALE_THRESHOLD_MS = Number(process.env.STALE_WORKTREE_THRESHOLD_MS) || 3e5;
  /** Clean up worktrees and workspaces for shutdown/error members past the stale threshold. */
  async cleanupStaleWorktrees() {
    const cutoff = Date.now() - _Watchdog.STALE_THRESHOLD_MS;
    const stale = this.db.query(
      `SELECT tm.team_id, tm.name, tm.worktree_dir, tm.workspace_id
       FROM team_member tm
       JOIN team t ON tm.team_id = t.id
       WHERE t.status = 'active'
         AND tm.status IN ('shutdown', 'error')
         AND tm.worktree_dir IS NOT NULL
         AND tm.time_updated < ?`
    ).all(cutoff);
    for (const m of stale) {
      try {
        if (m.workspace_id) {
          await this.client.workspace.remove({ id: m.workspace_id });
        }
        await this.client.worktree.remove({ worktreeRemoveInput: { directory: m.worktree_dir } });
        this.db.run(
          "UPDATE team_member SET worktree_dir = NULL, worktree_branch = NULL, workspace_id = NULL WHERE team_id = ? AND name = ?",
          [m.team_id, m.name]
        );
      } catch {
      }
    }
  }
  /** Check for stalled busy members and escalate to lead + nudge teammate. */
  async checkStalled() {
    if (!this.progressTracker || this.stallThresholdMs === 0) return;
    const busy = this.db.query(
      `SELECT tm.team_id, tm.name, tm.session_id
       FROM team_member tm
       JOIN team t ON tm.team_id = t.id
       WHERE t.status = 'active' AND tm.status = 'busy'`
    ).all();
    for (const member of busy) {
      if (this.progressTracker.isReported(member.session_id)) continue;
      const tokenStalled = this.progressTracker.isTokenStalled(member.session_id, this.stallMinSteps, this.stallTokenThreshold);
      const timeStalled = this.progressTracker.isTimeStalled(member.session_id, this.stallThresholdMs);
      if (!tokenStalled && !timeStalled) continue;
      if (hasReportedCompletion(this.db, member.team_id, member.name)) {
        log(`watchdog:stall:skip member=${member.name} team=${member.team_id} reason=already-reported-completion`);
        continue;
      }
      const reason = tokenStalled ? "low output tokens" : "no communication";
      const recentNudgeRow = this.db.query(
        "SELECT last_nudged_at FROM team_member WHERE team_id = ? AND name = ?"
      ).get(member.team_id, member.name);
      if (recentNudgeRow?.last_nudged_at) {
        const nudgedAt = recentNudgeRow.last_nudged_at;
        const activeSinceNudge = (this.progressTracker?.lastActivityAt(member.session_id) ?? 0) >= nudgedAt;
        if (!activeSinceNudge && Date.now() - nudgedAt < this.stallThresholdMs) {
          log(`watchdog:stall:skip member=${member.name} team=${member.team_id} reason=recently-nudged`);
          continue;
        }
      }
      this.db.run(
        "UPDATE team_member SET last_nudged_at = ? WHERE team_id = ? AND name = ?",
        [Date.now(), member.team_id, member.name]
      );
      const stallModel = getMemberModel(this.db, member.team_id, member.name);
      this.client.session.promptAsync({
        sessionID: member.session_id,
        parts: [{ type: "text", text: "[System]: You appear stalled \u2014 no progress detected. Report your current status to the lead via team_message, or wrap up your work." }],
        ...stallModel ? { model: stallModel } : {}
      }).then(() => {
        this.progressTracker.markReported(member.session_id);
      }).catch((err) => {
        log(`watchdog:stall:nudge-failed member=${member.name} team=${member.team_id} session=${member.session_id} err=${err instanceof Error ? err.message : String(err)}`);
      });
      notifyLead(
        this.client,
        this.db,
        member.team_id,
        `Teammate "${member.name}" appears stalled (${reason}). Consider checking on them via team_message or shutting them down.`
      );
      try {
        await this.client.tui.showToast({
          title: "Team",
          message: `${member.name} appears stalled`,
          variant: "warning",
          duration: 5e3
        });
      } catch {
      }
    }
  }
  /** Check for chatty agents sending too many peer messages. */
  async checkChatty() {
    if (!this.progressTracker || this.peerMessageLimit === 0) return;
    const busy = this.db.query(
      `SELECT tm.team_id, tm.name, tm.session_id
       FROM team_member tm
       JOIN team t ON tm.team_id = t.id
       WHERE t.status = 'active' AND tm.status = 'busy'`
    ).all();
    for (const member of busy) {
      if (this.progressTracker.isChattyReported(member.session_id)) continue;
      if (!this.progressTracker.isChatty(member.session_id, this.peerMessageLimit, this.peerMessageWindowMs)) continue;
      if (hasReportedCompletion(this.db, member.team_id, member.name)) {
        log(`watchdog:chatty:skip member=${member.name} team=${member.team_id} reason=already-reported-completion`);
        continue;
      }
      this.progressTracker.markChattyReported(member.session_id);
      const chattyModel = getMemberModel(this.db, member.team_id, member.name);
      this.client.session.promptAsync({
        sessionID: member.session_id,
        parts: [{ type: "text", text: "[System]: You've sent several messages to teammates. Focus on completing your task and send your results to the lead via team_message." }],
        ...chattyModel ? { model: chattyModel } : {}
      }).catch((err) => {
        log(`watchdog:chatty:nudge-failed member=${member.name} team=${member.team_id} session=${member.session_id} err=${err instanceof Error ? err.message : String(err)}`);
      });
      notifyLead(
        this.client,
        this.db,
        member.team_id,
        `Agent "${member.name}" is sending many peer messages and may be over-coordinating. Consider checking on them.`
      );
      log(`watchdog:chatty member=${member.name} limit=${this.peerMessageLimit}`);
    }
  }
  /** Run a single check for stale busy members. */
  async check() {
    await this.cleanupStaleWorktrees();
    await this.checkStalled();
    await this.checkChatty();
    if (this.ttlMs === 0) return;
    const cutoff = Date.now() - this.ttlMs;
    const stale = this.db.query(
      `SELECT tm.team_id, tm.name, tm.session_id, tm.worktree_branch, t.name as team_name, p.name as project_name
       FROM team_member tm
       JOIN team t ON tm.team_id = t.id
       JOIN project p ON t.project_id = p.id
       WHERE t.status = 'active'
         AND tm.status = 'busy'
         AND tm.time_updated < ?`
    ).all(cutoff);
    for (const member of stale) {
      const lastActive = this.progressTracker?.lastActivityAt(member.session_id) ?? 0;
      if (lastActive > cutoff) {
        this.db.run(
          "UPDATE team_member SET time_updated = ? WHERE team_id = ? AND name = ?",
          [lastActive, member.team_id, member.name]
        );
        log(`watchdog:heartbeat:renewed member=${member.name} team=${member.team_id} lastActive=${lastActive}`);
        continue;
      }
      if (isSessionCompacting(member.session_id)) {
        log(`watchdog:heartbeat:compacting member=${member.name} team=${member.team_id} session=${member.session_id}`);
        continue;
      }
      if (this.cwd && member.worktree_branch && !member.worktree_branch.startsWith("ensemble/preserved/")) {
        const safeBranch = preservedBranchName(member.project_name, member.team_name, member.team_id, member.name);
        const ok = await preserveBranch(member.worktree_branch, safeBranch, this.cwd);
        if (ok) {
          this.db.run(
            "UPDATE team_member SET worktree_branch = ? WHERE team_id = ? AND name = ?",
            [safeBranch, member.team_id, member.name]
          );
          log(`watchdog:branch:preserved src=${member.worktree_branch} target=${safeBranch}`);
        }
      }
      this.db.run(
        "UPDATE team_member SET status = 'error', execution_status = 'timed_out', time_updated = ? WHERE team_id = ? AND name = ?",
        [Date.now(), member.team_id, member.name]
      );
      const released = releaseMemberTasks(this.db, member.team_id, member.name);
      if (released > 0) log(`watchdog:tasks:released name=${member.name} count=${released}`);
      notifyLead(
        this.client,
        this.db,
        member.team_id,
        `Teammate "${member.name}" timed out after exceeding the busy time limit and was aborted. Their in-progress work has been released. Review their session, then re-spawn or reassign the task if needed.`
      );
      try {
        await this.client.session.abort({ sessionID: member.session_id });
      } catch {
      }
      try {
        await this.client.tui.showToast({
          title: "Team",
          message: `${member.name} timed out`,
          variant: "warning",
          duration: 5e3
        });
      } catch {
      }
    }
  }
  /** Start the periodic check. Runs stale worktree GC regardless of TTL setting. */
  start() {
    if (this.timer) return;
    this.timer = setInterval(() => this.check(), this.checkIntervalMs);
  }
  /** Stop the periodic check. */
  stop() {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = void 0;
    }
  }
  /** Whether the watchdog is currently running. */
  isRunning() {
    return this.timer !== void 0;
  }
};

// src/index.ts
var DEFAULT_RATE_LIMIT_REFILL = 2;
var DEFAULT_RATE_LIMIT_INTERVAL_MS = 1e3;
var DEFAULT_WATCHDOG_CHECK_MS = 60 * 1e3;
var plugin = async (input) => {
  const dbPath = getDbPath();
  mkdirSync(path4.dirname(dbPath), { recursive: true });
  const db = createDb(dbPath);
  const config = loadConfig(input.directory);
  const registry = new MemberRegistry();
  const tracker = new DescendantTracker();
  const purgeApprovals = new PendingPurgeApprovals();
  const nudgedMembers = /* @__PURE__ */ new Set();
  const progressTracker = new ProgressTracker();
  const activityBuffer = new ActivityBuffer();
  const wakeLeadTimestamps = /* @__PURE__ */ new Map();
  const WAKE_LEAD_COOLDOWN_MS = 5e3;
  const pluginTransport = input.client._client;
  const rawClient = new OpencodeClient({ client: pluginTransport });
  initLog(rawClient);
  const client = wrapThrowingClient(rawClient);
  const deps = { db, registry, tracker, purgeApprovals, client, directory: input.directory, config, progressTracker };
  if (!isWorktreeInstance(input.directory)) {
    log("init:recovery:start (main instance)");
    recoverOrphanedTeams(db, client, input.directory, registry).then((result) => {
      if (result.archived > 0) log(`init:recovery:orphaned-teams-archived=${result.archived}`);
    }).catch((err) => {
      log(`init:recover-orphaned-teams:failed err=${err instanceof Error ? err.message : String(err)}`);
    });
    const recovery = await recoverStaleMembers(db, client, input.directory);
    if (recovery.interrupted > 0) {
      log(`init:recovery:interrupted=${recovery.interrupted}`);
    }
    const rehydrated = rehydrateRegistry(db, registry);
    if (rehydrated > 0) log(`init:registry:rehydrated members=${rehydrated}`);
    recoverUndeliveredMessages(db, client, registry).catch((err) => {
      log(`init:recover-messages:failed err=${err instanceof Error ? err.message : String(err)}`);
    });
    recoverOrphanedWorktrees(db, client).catch((err) => {
      log(`init:recover-worktrees:failed err=${err instanceof Error ? err.message : String(err)}`);
    });
    recoverOrphanedBranches(db, input.directory).catch((err) => {
      log(`init:recover-branches:failed err=${err instanceof Error ? err.message : String(err)}`);
    });
    log("init:recovery:done");
    if (config.dashboardPort !== 0) {
      startDashboard(db, config.dashboardPort, { activityBuffer, client }).catch((err) => {
        log(`init:dashboard:failed err=${err instanceof Error ? err.message : String(err)}`);
      });
    }
  } else {
    log(`init:skip-recovery (worktree instance: ${input.directory})`);
  }
  const rateLimiter = new TokenBucket({
    capacity: config.rateLimitCapacity,
    refillRate: DEFAULT_RATE_LIMIT_REFILL,
    refillIntervalMs: DEFAULT_RATE_LIMIT_INTERVAL_MS
  });
  const watchdog = new Watchdog({
    db,
    client,
    registry,
    ttlMs: config.timeoutMs,
    checkIntervalMs: DEFAULT_WATCHDOG_CHECK_MS,
    progressTracker,
    stallThresholdMs: config.stallThresholdMs,
    stallMinSteps: config.stallMinSteps,
    stallTokenThreshold: config.stallTokenThreshold,
    cwd: input.directory,
    peerMessageLimit: config.peerMessageLimit,
    peerMessageWindowMs: config.peerMessageWindowMs
  });
  watchdog.start();
  return {
    // Event hook — drives state machine transitions + descendant tracking + toasts
    async event({ event }) {
      if (event.type === "session.status") {
        const { sessionID, status } = event.properties;
        const statusType = status.type;
        const retryPayload = statusType === "retry" ? status : void 0;
        const transition = handleSessionStatusEvent(db, registry, sessionID, statusType, retryPayload);
        if (transition) {
          if (transition.to === "shutdown") {
            notifyTeamEvent(client, "shutdown", { memberName: transition.memberName });
          } else if (transition.to === "ready" && transition.from === "busy") {
            notifyTeamEvent(client, "completed", { memberName: transition.memberName });
            const fastIdleKey = `fastidle:${transition.teamId}:${transition.memberName}`;
            if (!nudgedMembers.has(fastIdleKey) && shouldAlarmFastIdle(db, transition.teamId, transition.memberName)) {
              nudgedMembers.add(fastIdleKey);
              const memberInfo = db.query(
                "SELECT time_created, model FROM team_member WHERE team_id = ? AND name = ?"
              ).get(transition.teamId, transition.memberName);
              const spawnAge = memberInfo ? Date.now() - memberInfo.time_created : 0;
              const modelInfo = memberInfo?.model ? ` (model: ${memberInfo.model})` : "";
              log(`fast-idle: ${transition.memberName} went idle ${Math.round(spawnAge / 1e3)}s after spawn with 0 messages${modelInfo}`);
              notifyLead(
                client,
                db,
                transition.teamId,
                `Warning: Teammate "${transition.memberName}" went idle immediately after spawning with no output${modelInfo}. This usually means the model failed to start (authentication error, invalid model, or provider issue). Check your API key and model configuration, then retry the spawn.`
              );
              client.tui.showToast({
                title: "Team",
                message: `${transition.memberName} failed to produce output${modelInfo}`,
                variant: "warning",
                duration: 8e3
              }).catch(() => {
              });
            }
            const nudgeKey = `${transition.teamId}:${transition.memberName}`;
            if (!nudgedMembers.has(nudgeKey) && shouldNudgeIdleMember(db, transition.teamId, transition.memberName) && !hasReportedCompletion(db, transition.teamId, transition.memberName)) {
              nudgedMembers.add(nudgeKey);
              log(`nudge:idle-without-report name=${transition.memberName}`);
              const nudgeModel = getMemberModel(db, transition.teamId, transition.memberName);
              client.session.promptAsync({
                sessionID,
                parts: [{ type: "text", text: "[System]: You completed your work but did not report results. Send your findings to the lead via team_message now." }],
                ...nudgeModel ? { model: nudgeModel } : {}
              }).catch((err) => {
                log(`nudge:idle-without-report:failed name=${transition.memberName} team=${transition.teamId} err=${err instanceof Error ? err.message : String(err)}`);
              });
            }
          } else if (transition.to === "error") {
            notifyTeamEvent(client, "error", { memberName: transition.memberName });
          } else if (transition.to === "busy") {
            progressTracker.recordBusyStart(sessionID);
          } else if (transition.to === "retry") {
            try {
              await client.tui.showToast({
                title: "Team",
                message: `${transition.memberName} is being rate-limited`,
                variant: "warning",
                duration: 3e3
              });
            } catch {
            }
          } else if (transition.to === "busy_while_shutdown") {
            const member = deps.db.query(
              "SELECT worktree_branch, name, team_id FROM team_member WHERE session_id = ?"
            ).get(sessionID);
            if (member?.worktree_branch && !member.worktree_branch.startsWith("ensemble/preserved/")) {
              const { getTeamResourceParts: getTeamResourceParts2, preserveBranch: preserve, preservedBranchName: branchName } = await Promise.resolve().then(() => (init_merge_helper(), merge_helper_exports));
              const resource = getTeamResourceParts2(deps.db, member.team_id);
              const safeBranch = branchName(resource.projectName, resource.teamName, resource.teamId, member.name);
              const ok = await preserve(member.worktree_branch, safeBranch, deps.directory);
              if (ok) {
                deps.db.run(
                  "UPDATE team_member SET worktree_branch = ? WHERE team_id = ? AND name = ?",
                  [safeBranch, member.team_id, member.name]
                );
                log(`busy_while_shutdown:branch:preserved src=${member.worktree_branch} target=${safeBranch}`);
              }
            }
            try {
              await client.session.abort({ sessionID });
            } catch {
            }
          }
          await notifyWorkingProgress(client, db, transition.teamId);
        }
        if (statusType === "idle") {
          const team = db.query("SELECT id FROM team WHERE lead_session_id = ? AND status = 'active'").get(sessionID);
          if (team) {
            const pending = db.query("SELECT COUNT(*) as c FROM team_message WHERE team_id = ? AND to_name = 'lead' AND delivered = 0").get(team.id);
            const allDone = db.query(
              "SELECT COUNT(*) as c FROM team_member WHERE team_id = ? AND status NOT IN ('ready', 'shutdown', 'error')"
            ).get(team.id).c === 0;
            const lastWake = wakeLeadTimestamps.get(team.id) ?? 0;
            if (pending.c > 0 && !allDone && Date.now() - lastWake > WAKE_LEAD_COOLDOWN_MS) {
              wakeLeadTimestamps.set(team.id, Date.now());
              log(`wake-lead: ${pending.c} pending messages, sending promptAsync`);
              client.session.promptAsync({
                sessionID,
                parts: [{ type: "text", text: `[System: ${pending.c} new team message(s) available]` }]
              }).catch((err) => {
                log(`wake-lead:failed err=${err instanceof Error ? err.message : String(err)}`);
              });
            }
          }
          const member = db.query(
            `SELECT tm.team_id, tm.name FROM team_member tm
             JOIN team t ON tm.team_id = t.id
             WHERE tm.session_id = ? AND t.status = 'active'`
          ).get(sessionID);
          if (member && !hasReportedCompletion(db, member.team_id, member.name)) {
            const staleThreshold = Date.now() - 5e3;
            const peerMsgs = db.query(
              "SELECT COUNT(*) as c FROM team_message WHERE team_id = ? AND to_name = ? AND delivered = 0 AND time_created < ?"
            ).get(member.team_id, member.name, staleThreshold);
            if (peerMsgs.c > 0) {
              log(`wake-peer: ${member.name} has ${peerMsgs.c} pending peer messages`);
              const peerModel = getMemberModel(db, member.team_id, member.name);
              client.session.promptAsync({
                sessionID,
                parts: [{ type: "text", text: `[System: ${peerMsgs.c} new message(s) from teammates]` }],
                ...peerModel ? { model: peerModel } : {}
              }).catch((err) => {
                log(`wake-peer:failed err=${err instanceof Error ? err.message : String(err)}`);
              });
            }
          }
        }
      }
      if (event.type === "session.created") {
        const info = event.properties.info;
        if (info.parentID) {
          handleSessionCreatedEvent(tracker, info.id, info.parentID);
        }
      }
      if (event.type === "session.error") {
        const props = event.properties;
        handleSessionErrorEvent(db, registry, client, props.sessionID, props.error);
      }
      if (event.type === "message.part.updated") {
        const part = event.properties.part;
        if (part?.type === "step-finish" && part.sessionID && part.tokens?.output !== void 0) {
          if (registry.getBySession(part.sessionID)) {
            progressTracker.recordStep(part.sessionID, part.tokens.output);
          }
        }
      }
      recordFromV2Event(
        event,
        registry,
        activityBuffer
      );
    },
    // Sub-agent isolation + rate limiting hook
    "tool.execute.before": async (input2, _output) => {
      checkToolIsolation(registry, tracker, input2.tool, input2.sessionID, db);
      if (input2.tool.startsWith("team_")) {
        if (!rateLimiter.tryConsume()) {
          await rateLimiter.waitForToken();
        }
      }
      recordFromToolBefore(input2, registry, activityBuffer);
    },
    "tool.execute.after": async (input2, output) => {
      if (input2.tool === "question") {
        purgeApprovals.recordQuestionAnswer(input2.sessionID, output.output, input2.args);
      }
      recordFromToolAfter(input2, output, registry, activityBuffer);
    },
    // System prompt injection — keeps lead aware of team state, reminds teammates of role
    "experimental.chat.system.transform": async (input2, output) => {
      if (!input2.sessionID) return;
      const teamInfo = findTeamBySession(db, registry, input2.sessionID);
      if (!teamInfo) return;
      log(`system-prompt:transform role=${teamInfo.role} session=${input2.sessionID}`);
      const prompt = teamInfo.role === "lead" ? buildLeadSystemPrompt(db, teamInfo.teamId, config) : buildTeammateSystemPrompt(db, teamInfo.teamId, teamInfo.memberName ?? "unknown", config);
      log(`system-prompt:injected role=${teamInfo.role} len=${prompt.length}`);
      output.system.push(prompt);
    },
    // Compaction safety — preserves team context when sessions get long
    "experimental.session.compacting": async (input2, output) => {
      const teamInfo = findTeamBySession(db, registry, input2.sessionID);
      if (!teamInfo) return;
      const context = buildTeamCompactionContext(db, teamInfo.teamId, teamInfo.role, teamInfo.memberName, config);
      output.context.push(context);
    },
    // Team-aware shell environment for scripts and hooks
    "shell.env": async (input2, output) => {
      if (!input2.sessionID) return;
      const teamInfo = findTeamBySession(db, registry, input2.sessionID);
      if (!teamInfo) return;
      output.env.ENSEMBLE_TEAM = teamInfo.teamName;
      output.env.ENSEMBLE_ROLE = teamInfo.role;
      if (teamInfo.memberName) {
        output.env.ENSEMBLE_MEMBER = teamInfo.memberName;
        const member = db.query("SELECT worktree_branch, worktree_dir FROM team_member WHERE team_id = ? AND name = ?").get(teamInfo.teamId, teamInfo.memberName);
        if (member?.worktree_branch) {
          output.env.ENSEMBLE_BRANCH = member.worktree_branch;
        }
        if (member?.worktree_dir) {
          output.env.ENSEMBLE_WORKTREE_DIR = member.worktree_dir;
        }
      }
    },
    // Register all team tools
    tool: {
      team_create: tool({
        description: "Create a new agent team. You become the team lead. Use this before spawning teammates.",
        args: {
          name: tool.schema.string().describe("Team name (lowercase alphanumeric with hyphens, 1-64 chars)"),
          project_name: tool.schema.string().optional().describe("Project display name for first use of this working directory. If omitted, a short random name is generated.")
        },
        async execute(args, ctx) {
          const result = await executeTeamCreate(deps, args, ctx.sessionID);
          ctx.metadata({ title: `Created team: ${args.name}` });
          return result;
        }
      }),
      team_spawn: tool({
        description: "Spawn a new teammate that works in parallel. The teammate starts immediately with the given prompt. Each teammate gets their own git worktree for file isolation. Teammates work asynchronously and will message you when done. Do not poll for their status.",
        args: {
          name: tool.schema.string().describe("Teammate name (lowercase alphanumeric with hyphens)"),
          agent: tool.schema.string().default("build").describe("Agent type (e.g. 'build', 'plan', 'explore')"),
          prompt: tool.schema.string().describe("Task instructions for the teammate"),
          model: tool.schema.string().optional().describe("Model in provider/model format (optional, uses default)"),
          claim_task: tool.schema.string().optional().describe("Task ID to auto-claim for this teammate (optional)"),
          worktree: tool.schema.boolean().default(true).describe("Create a git worktree for file isolation (default: true, set false for read-only agents)"),
          plan_approval: tool.schema.boolean().default(false).describe("Require teammate to send a plan for approval before writing files (default: false)"),
          standby: tool.schema.boolean().default(false).describe("Register the teammate WITHOUT sending its init prompt (zero tokens at birth). Stored as ready/standby with the full prompt in spawn_context; woken with the context prepended by the first team_message/team_broadcast (default: false)")
        },
        async execute(args, ctx) {
          const result = await executeTeamSpawn(deps, args, ctx.sessionID);
          ctx.metadata({ title: `Spawned ${args.name} (${args.agent})` });
          return result;
        }
      }),
      team_message: tool({
        description: "Send a message to a specific teammate or to the lead. Use 'lead' to message the team lead. Lead only: pass 'model' (provider/model) to update a teammate's model in-place \u2014 it applies on their next turn. When updating a model, 'text' is optional; omit it to change the model without sending a message.",
        args: {
          to: tool.schema.string().describe("Recipient name ('lead' or teammate name)"),
          text: tool.schema.string().optional().describe("Message content (max 10KB). Optional only when 'model' is provided."),
          approve: tool.schema.boolean().optional().describe("Approve a teammate's plan (only when recipient has plan_approval='pending')"),
          reject: tool.schema.string().optional().describe("Reject a teammate's plan with reason (only when recipient has plan_approval='pending')"),
          force: tool.schema.boolean().optional().describe("Lead only. Re-activate a teammate who already reported task completion (normally their session won't be woken again). Use for legitimate follow-on work \u2014 e.g. the next round of a multi-round debate \u2014 not for courtesy replies."),
          model: tool.schema.string().optional().describe("Lead only: update the recipient teammate's model in-place, in 'provider/model' format (e.g. 'anthropic/claude-sonnet').")
        },
        async execute(args, ctx) {
          const result = await executeTeamMessage(deps, args, ctx.sessionID);
          progressTracker.recordMessage(ctx.sessionID);
          if (args.to !== "lead") progressTracker.recordPeerMessage(ctx.sessionID);
          ctx.metadata({ title: args.model ? `Set ${args.to} model \u2192 ${args.model}` : `Message \u2192 ${args.to}` });
          return result;
        }
      }),
      team_broadcast: tool({
        description: "Send a message to all teammates and the lead (excluding yourself).",
        args: {
          text: tool.schema.string().describe("Message content (max 10KB)")
        },
        async execute(args, ctx) {
          const result = await executeTeamBroadcast(deps, args, ctx.sessionID);
          progressTracker.recordMessage(ctx.sessionID);
          progressTracker.recordPeerMessage(ctx.sessionID);
          ctx.metadata({ title: "Broadcast to team" });
          return result;
        }
      }),
      team_tasks_list: tool({
        description: "View the shared team task board. Use this to check task status, not to wait for teammates. Teammates will message you when done.",
        args: {},
        async execute(_args, ctx) {
          const result = await executeTeamTasksList(deps, ctx.sessionID);
          const count = result === "No tasks on the board." ? 0 : result.split("\n").length;
          ctx.metadata({ title: count > 0 ? `Task board (${count} tasks)` : "Task board (empty)" });
          return result;
        }
      }),
      team_tasks_add: tool({
        description: "Add tasks to the shared team task board so teammates can see what work is available and claim it.",
        args: {
          tasks: tool.schema.array(tool.schema.object({
            content: tool.schema.string().describe("Task description"),
            priority: tool.schema.enum(["high", "medium", "low"]).default("medium").describe("Task priority"),
            depends_on: tool.schema.array(tool.schema.string()).optional().describe("Task IDs this depends on")
          })).describe("Tasks to add"),
          sequential: tool.schema.boolean().optional().describe("If true, or if tasks.length > 1 and no depends_on is provided in any task, tasks are added in sequence where each task depends on the previous one")
        },
        async execute(args, ctx) {
          const result = await executeTeamTasksAdd(deps, args, ctx.sessionID);
          ctx.metadata({ title: `Added ${args.tasks.length} task${args.tasks.length !== 1 ? "s" : ""}` });
          return result;
        }
      }),
      team_tasks_complete: tool({
        description: "Mark a task as completed on the shared board. This unblocks any tasks that depend on it.",
        args: {
          task_id: tool.schema.string().describe("ID of the task to mark complete")
        },
        async execute(args, ctx) {
          const result = await executeTeamTasksComplete(deps, args, ctx.sessionID);
          progressTracker.recordTaskComplete(ctx.sessionID);
          ctx.metadata({ title: `Completed task` });
          return result;
        }
      }),
      team_claim: tool({
        description: "Claim a pending task from the shared task list. Only unclaimed, unblocked tasks can be claimed.",
        args: {
          task_id: tool.schema.string().describe("ID of the task to claim")
        },
        async execute(args, ctx) {
          const result = await executeTeamClaim(deps, args, ctx.sessionID);
          ctx.metadata({ title: `Claimed task` });
          return result;
        }
      }),
      team_results: tool({
        description: "Retrieve full message content from teammates. Returns unread messages and marks them as read. Use this after receiving a truncated message notification.",
        args: {
          from: tool.schema.string().optional().describe("Filter messages by sender name (optional, returns all if omitted)")
        },
        async execute(args, ctx) {
          const result = await executeTeamResults(deps, args, ctx.sessionID);
          ctx.metadata({ title: `Results${args.from ? ` from ${args.from}` : ""}` });
          return result;
        }
      }),
      team_shutdown: tool({
        description: "Request a teammate to shut down. The teammate finishes current work then stops. Pass force: true to abort immediately without waiting.",
        args: {
          member: tool.schema.string().describe("Teammate name to shut down"),
          force: tool.schema.boolean().default(false).describe("Force immediate abort without waiting for current work to finish")
        },
        async execute(args, ctx) {
          const result = await executeTeamShutdown(deps, args, ctx.sessionID);
          const member = deps.db.query("SELECT session_id FROM team_member WHERE name = ? AND status IN ('shutdown', 'shutdown_requested')").get(args.member);
          if (member) {
            progressTracker.remove(member.session_id);
            activityBuffer.remove(member.session_id);
          }
          const hasWarning = result.includes("uncommitted");
          ctx.metadata({ title: hasWarning ? `${args.member} shut down \u2014 uncommitted changes` : `${args.member} shut down` });
          return result;
        }
      }),
      team_cleanup: tool({
        description: "Clean up the current team, or purge archived teams after human approval. Omit purge for normal cleanup. Pass purge with archived team names, or ['*'] for all archived teams. First purge call returns a preview, exact approval and denial options, and confirmation token only. Archived worktree/workspace references and stale Ensemble-owned branches are shown in the preview and cleaned during confirmed purge. Use the question tool with those exact options, then call again with confirm_purge: true and confirm_token only if the user selected the exact approval option.",
        args: {
          force: tool.schema.boolean().default(false).describe("Force cleanup even if members are active (will abort them)"),
          acknowledge_uncommitted: tool.schema.boolean().default(false),
          purge: tool.schema.array(tool.schema.string()).optional().describe("Archived team names to permanently delete, or ['*'] for all archived teams. Requires human approval."),
          confirm_purge: tool.schema.boolean().default(false).describe("Set true only after the user explicitly selects the exact approval option from the purge preview via the question tool."),
          confirm_token: tool.schema.string().optional().describe("Confirmation token from the purge preview. Valid only after the matching exact approval answer is selected in this session.")
        },
        async execute(args, ctx) {
          const approvePurge = args.purge && args.purge.length > 0 && args.confirm_purge ? async (preview) => {
            await ctx.ask({
              permission: "team_cleanup.purge",
              patterns: args.purge ?? [],
              always: [],
              metadata: {
                title: "Purge archived teams",
                preview
              }
            });
          } : void 0;
          const teamInfoForCleanup = findTeamBySession(db, registry, ctx.sessionID);
          const memberSessions = teamInfoForCleanup ? db.query("SELECT session_id FROM team_member WHERE team_id = ?").all(teamInfoForCleanup.teamId).map((m) => m.session_id) : [];
          const result = await executeTeamCleanup(deps, args, ctx.sessionID, void 0, void 0, void 0, config.mergeOnCleanup, void 0, approvePurge);
          if (!result.includes("uncommitted") && !args.purge) {
            for (const sid of memberSessions) activityBuffer.remove(sid);
          }
          const blocked = result.includes("uncommitted");
          const title = args.purge ? result.startsWith("No archived teams") ? "No archived teams to purge" : result.startsWith("Purge preview") ? "Purge confirmation required" : "Archived teams purged" : blocked ? "Cleanup blocked \u2014 uncommitted changes" : "Team cleaned up";
          ctx.metadata({ title });
          return result;
        }
      }),
      team_merge: tool({
        description: "Merge a shutdown teammate's branch into the working directory as unstaged changes. Use this after team_shutdown to review and integrate a teammate's work. The teammate must be shut down first.",
        args: {
          member: tool.schema.string().describe("Teammate name whose branch to merge")
        },
        async execute(args, ctx) {
          const result = await executeTeamMerge(deps, args, ctx.sessionID);
          const conflict = result.includes("conflict");
          ctx.metadata({ title: conflict ? `Merge conflict: ${args.member}` : `Merged ${args.member}` });
          return result;
        }
      }),
      team_status: tool({
        description: "View team members with their current status, agent type, and session IDs. Use this to check who is working, idle, or shut down. Includes a task summary.",
        args: {},
        async execute(_args, ctx) {
          const result = await executeTeamStatus(deps, ctx.sessionID);
          const statusMap = { busy: "working", ready: "idle", shutdown_requested: "stopping", shutdown: "done", error: "error" };
          const members = deps.db.query("SELECT name, status FROM team_member WHERE team_id IN (SELECT id FROM team WHERE lead_session_id = ? OR id IN (SELECT team_id FROM team_member WHERE session_id = ?))").all(ctx.sessionID, ctx.sessionID);
          const summary = members.map((m) => `${m.name}: ${statusMap[m.status] ?? m.status}`).join(", ");
          ctx.metadata({ title: summary || "No teammates" });
          return result;
        }
      }),
      team_view: tool({
        description: "Resolve a teammate's session so the user can inspect it. Default reports the session ID + status without switching. Pass navigate: true ONLY when the user explicitly asked to view the teammate's session \u2014 it switches their client to it. Return via the session picker (ctrl+p).",
        args: {
          member: tool.schema.string().describe("Teammate name to view"),
          navigate: tool.schema.boolean().default(false).describe("Switch the user's client to this session. Only when the user explicitly asked.")
        },
        async execute(args, ctx) {
          const result = await executeTeamView(deps, args, ctx.sessionID);
          ctx.metadata({ title: `Viewing ${args.member}` });
          return result;
        }
      })
    }
  };
};
var index_default = {
  ...PluginV2.define({
    id: "ensemble",
    async setup(ctx) {
      const handle = await setupEnsemble(ctx);
      return () => {
        void handle.dispose();
      };
    }
  }),
  server: plugin
};
export {
  index_default as default,
  hasBlockedAssignedTasks,
  shouldAlarmFastIdle,
  shouldNudgeIdleMember
};
