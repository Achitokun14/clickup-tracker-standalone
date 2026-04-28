-- 02_per_repo_space.sql
-- Phase: per-repo Space rewrite. Idempotent (every statement uses IF NOT EXISTS).
-- Mounted alongside init.sql via docker-entrypoint-initdb.d on first volume init.
-- For existing volumes, apply once with:
--   docker compose exec postgres psql -U cup -d clickup_tracker \
--     -f /docker-entrypoint-initdb.d/02-per-repo-space.sql

ALTER TABLE clickup_tracker.projects
  ADD COLUMN IF NOT EXISTS clickup_doc_id           TEXT,
  ADD COLUMN IF NOT EXISTS sprint_lists             JSONB NOT NULL DEFAULT '{}'::jsonb,
  ADD COLUMN IF NOT EXISTS backfill_state           JSONB NOT NULL DEFAULT '{"status":"pending"}'::jsonb,
  ADD COLUMN IF NOT EXISTS template_status          TEXT  NOT NULL DEFAULT 'inline-fallback',
  ADD COLUMN IF NOT EXISTS git_default_branch       TEXT,
  ADD COLUMN IF NOT EXISTS git_remote_host          TEXT,
  ADD COLUMN IF NOT EXISTS git_remote_owner_repo    TEXT,
  ADD COLUMN IF NOT EXISTS last_seen_status_changes JSONB NOT NULL DEFAULT '[]'::jsonb;

CREATE TABLE IF NOT EXISTS clickup_tracker.workspace_settings (
  clickup_team_id     TEXT PRIMARY KEY,
  custom_field_ids    JSONB NOT NULL DEFAULT '{}'::jsonb,
  status_set          JSONB NOT NULL DEFAULT '[]'::jsonb,
  bug_status_set      JSONB NOT NULL DEFAULT '[]'::jsonb,
  template_status     TEXT  NOT NULL DEFAULT 'inline-fallback',
  webhook_id          TEXT,
  webhook_secret      TEXT,
  members_cache       JSONB NOT NULL DEFAULT '{}'::jsonb,
  members_cached_at   TIMESTAMPTZ,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS clickup_tracker.clickup_inbound_events (
  id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  clickup_team_id    TEXT NOT NULL,
  webhook_event_id   TEXT NOT NULL,
  history_item_id    TEXT,
  event_type         TEXT NOT NULL,
  task_id            TEXT,
  payload            JSONB NOT NULL,
  processed_at       TIMESTAMPTZ,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (clickup_team_id, webhook_event_id, COALESCE(history_item_id, ''))
);

CREATE INDEX IF NOT EXISTS idx_projects_team_space
  ON clickup_tracker.projects (clickup_team_id, clickup_space_id);
CREATE INDEX IF NOT EXISTS idx_projects_default_br
  ON clickup_tracker.projects (git_default_branch)
  WHERE git_default_branch IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_inbound_unprocessed
  ON clickup_tracker.clickup_inbound_events (processed_at)
  WHERE processed_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_backfill_running
  ON clickup_tracker.projects ((backfill_state->>'status'))
  WHERE (backfill_state->>'status') IN ('running','queued','failed');
