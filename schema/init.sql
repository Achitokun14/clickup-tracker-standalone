-- clickup-tracker (standalone) schema
-- Single-tenant: no auth.organisations FK. organisation_id stays UUID
-- (matches the service's ::uuid casts) but is a plain identifier with
-- no FK; the standalone build defaults it to the all-zeros UUID.

CREATE EXTENSION IF NOT EXISTS pgcrypto;
CREATE SCHEMA IF NOT EXISTS clickup_tracker;

-- A "project" = (organisation, local_repo_path) tracked in ClickUp.
CREATE TABLE IF NOT EXISTS clickup_tracker.projects (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organisation_id     UUID NOT NULL DEFAULT '00000000-0000-0000-0000-000000000000',
  local_path          TEXT NOT NULL,
  display_name        TEXT NOT NULL,
  git_remote_url      TEXT,
  scope_config        JSONB NOT NULL DEFAULT '{"mode":"root"}'::jsonb,
  clickup_team_id     TEXT NOT NULL,
  clickup_space_id    TEXT NOT NULL,
  clickup_folder_id   TEXT NOT NULL,
  list_ids            JSONB NOT NULL,
  custom_field_ids    JSONB NOT NULL DEFAULT '{}'::jsonb,
  task_index          JSONB NOT NULL DEFAULT '{}'::jsonb,
  hook_secret         TEXT NOT NULL,
  status              VARCHAR(20) NOT NULL DEFAULT 'active',
  last_synced_at      TIMESTAMPTZ,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (organisation_id, local_path)
);
CREATE INDEX IF NOT EXISTS idx_cup_tracker_projects_org
  ON clickup_tracker.projects (organisation_id, status);
CREATE INDEX IF NOT EXISTS idx_cup_tracker_projects_remote
  ON clickup_tracker.projects (organisation_id, git_remote_url)
  WHERE git_remote_url IS NOT NULL;

CREATE TABLE IF NOT EXISTS clickup_tracker.git_events (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id          UUID NOT NULL REFERENCES clickup_tracker.projects(id) ON DELETE CASCADE,
  commit_sha          TEXT NOT NULL,
  branch              TEXT,
  author              TEXT,
  committer_email     TEXT,
  committed_at        TIMESTAMPTZ NOT NULL,
  message             TEXT NOT NULL,
  files_changed       JSONB NOT NULL,
  todo_diffs          JSONB NOT NULL DEFAULT '[]'::jsonb,
  resulting_actions   JSONB NOT NULL DEFAULT '[]'::jsonb,
  processed_at        TIMESTAMPTZ,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (project_id, commit_sha)
);
CREATE INDEX IF NOT EXISTS idx_cup_tracker_git_events_project
  ON clickup_tracker.git_events (project_id, committed_at DESC);

CREATE TABLE IF NOT EXISTS clickup_tracker.prompt_events (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id          UUID NOT NULL REFERENCES clickup_tracker.projects(id) ON DELETE CASCADE,
  session_id          TEXT,
  prompt_excerpt      TEXT,
  outcome_summary     TEXT,
  files_touched       JSONB NOT NULL DEFAULT '[]'::jsonb,
  resulting_actions   JSONB NOT NULL DEFAULT '[]'::jsonb,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_cup_tracker_prompt_events_project
  ON clickup_tracker.prompt_events (project_id, created_at DESC);

CREATE TABLE IF NOT EXISTS clickup_tracker.backups (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id      UUID NOT NULL REFERENCES clickup_tracker.projects(id) ON DELETE CASCADE,
  trigger         VARCHAR(20) NOT NULL,
  snapshot        JSONB NOT NULL,
  taken_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_cup_tracker_backups_project
  ON clickup_tracker.backups (project_id, taken_at DESC);

CREATE TABLE IF NOT EXISTS clickup_tracker.processed_events (
  event_id        TEXT PRIMARY KEY,
  kind            VARCHAR(40) NOT NULL,
  processed_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
