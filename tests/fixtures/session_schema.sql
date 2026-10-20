-- tests/fixtures/session_schema.sql
--
-- TICKET-RELEASE-01 — Fixture determinística do store de sessões do OpenCode.
--
-- Este arquivo é a ÚNICA fonte de schema usada pelas suítes que precisam do
-- store `session` (test_watchdog_heartbeat.mjs e test_agent_identity_nudges.mjs).
-- Ele substitui a leitura read-only do `opencode.db` de produção em
-- ~/.local/share/opencode/, removendo o acoplamento com o caminho local do host
-- e tornando a suíte hermética: qualquer máquina/container reproduz o schema.
--
-- Origem: DDL extraído de sqlite_master (type IN ('table','index')) do store real
-- do OpenCode, colunas e constraints preservadas byte-a-byte. A tabela `project`
-- entra junto porque `session` tem FK `fk_session_project_id_project_id_fk`
-- (project_id → project.id ON DELETE CASCADE); omiti-la quebraria o INSERT e o
-- PRAGMA foreign_keys do SQLite.
--
-- Notas de contrato (o que o runtime do plugin realmente consulta):
--   * a chave primária da sessão é a coluna `id` (não existe `session_id` no
--     store do host; o plugin guarda o valor em team_member.session_id);
--   * `time_compacting` é nullable: NULL/0 = sem compactação, > 0 = compactando
--     (base da imunidade do watchdog — ver src/watchdog.ts isSessionCompacting);
--   * `agent` é o campo que o servidor OpenCode usa para resolver a persona.
--
-- Aplicação (sem mocks, SQLite real via node:sqlite):
--   const ddl = readFileSync(FIXTURE, "utf8");
--   const store = new DatabaseSync(".../.local/share/opencode/opencode.db");
--   store.exec(ddl);

CREATE TABLE `project` (
          `id` text PRIMARY KEY,
          `worktree` text NOT NULL,
          `vcs` text,
          `name` text,
          `icon_url` text,
          `icon_url_override` text,
          `icon_color` text,
          `time_created` integer NOT NULL,
          `time_updated` integer NOT NULL,
          `time_initialized` integer,
          `sandboxes` text NOT NULL,
          `commands` text
        , `time_active` integer DEFAULT 0 NOT NULL);

CREATE TABLE `session` (
          `id` text PRIMARY KEY,
          `project_id` text NOT NULL,
          `workspace_id` text,
          `parent_id` text,
          `slug` text NOT NULL,
          `directory` text NOT NULL,
          `path` text,
          `title` text NOT NULL,
          `version` text NOT NULL,
          `share_url` text,
          `summary_additions` integer,
          `summary_deletions` integer,
          `summary_files` integer,
          `summary_diffs` text,
          `metadata` text,
          `cost` real DEFAULT 0 NOT NULL,
          `tokens_input` integer DEFAULT 0 NOT NULL,
          `tokens_output` integer DEFAULT 0 NOT NULL,
          `tokens_reasoning` integer DEFAULT 0 NOT NULL,
          `tokens_cache_read` integer DEFAULT 0 NOT NULL,
          `tokens_cache_write` integer DEFAULT 0 NOT NULL,
          `revert` text,
          `permission` text,
          `agent` text,
          `model` text,
          `time_created` integer NOT NULL,
          `time_updated` integer NOT NULL,
          `time_compacting` integer,
          `time_archived` integer,
          CONSTRAINT `fk_session_project_id_project_id_fk` FOREIGN KEY (`project_id`) REFERENCES `project`(`id`) ON DELETE CASCADE
        );

CREATE INDEX `session_project_idx` ON `session` (`project_id`);
CREATE INDEX `session_workspace_idx` ON `session` (`workspace_id`);
CREATE INDEX `session_parent_idx` ON `session` (`parent_id`);
