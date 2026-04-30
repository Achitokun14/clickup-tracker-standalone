-- 03_collab_and_scrum.sql
-- Phase B (multi-developer adoption) + Phase C (autonomous SCRUM operator)
-- pre-work. Idempotent; mounted alongside init.sql + 02 via
-- docker-entrypoint-initdb.d on first volume init. For existing volumes:
--   docker compose exec postgres psql -U cup -d clickup_tracker \
--     -f /docker-entrypoint-initdb.d/03-collab-and-scrum.sql

-- ── B.4 — git_events team-level uniqueness ──────────────────────────────
-- The legacy UNIQUE on (project_id, commit_sha) lets two developers' rows
-- both insert the same SHA because each daemon has its own project_id.
-- This is wrong for shared workspaces: the same commit ends up duplicated
-- as N tasks (one per dev). Move uniqueness to the team level.

ALTER TABLE clickup_tracker.git_events
  ADD COLUMN IF NOT EXISTS clickup_team_id TEXT;

-- Backfill from project join (idempotent — only fills NULLs).
UPDATE clickup_tracker.git_events g
   SET clickup_team_id = p.clickup_team_id
  FROM clickup_tracker.projects p
 WHERE g.project_id = p.id
   AND g.clickup_team_id IS NULL
   AND p.clickup_team_id IS NOT NULL;

-- Partial UNIQUE: only enforced once team_id is set. Legacy rows with
-- NULL team_id keep the old (project_id, commit_sha) constraint via the
-- table definition in init.sql; new inserts always set team_id and
-- dedupe at the team level.
CREATE UNIQUE INDEX IF NOT EXISTS git_events_team_sha_uniq
  ON clickup_tracker.git_events (clickup_team_id, commit_sha)
  WHERE clickup_team_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS git_events_team_created
  ON clickup_tracker.git_events (clickup_team_id, created_at DESC)
  WHERE clickup_team_id IS NOT NULL;

-- ── B.2/B.3 — adoption hydration extras ────────────────────────────────
-- When adopting an existing Space, we may discover Folders/Lists that
-- don't match our scaffold. We persist them so the daemon never touches
-- them but the operator can see what's there.
ALTER TABLE clickup_tracker.projects
  ADD COLUMN IF NOT EXISTS extra_lists   JSONB NOT NULL DEFAULT '[]'::jsonb,
  ADD COLUMN IF NOT EXISTS extra_folders JSONB NOT NULL DEFAULT '[]'::jsonb;

-- ── C.0 — SCRUM audit log (ships with PR-3a) ───────────────────────────
-- Every autonomous action emits a row here. Browseable via
-- GET /projects/:id/scrum/audit. Created here so PR-2 migrations can
-- reference the table during local dev without a second migration step.
CREATE TABLE IF NOT EXISTS clickup_tracker.scrum_audit (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id   UUID NOT NULL REFERENCES clickup_tracker.projects(id) ON DELETE CASCADE,
  at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  kind         TEXT NOT NULL,
  target       TEXT,
  before       JSONB,
  after        JSONB,
  reason       TEXT,
  dry_run      BOOLEAN NOT NULL DEFAULT false
);
CREATE INDEX IF NOT EXISTS scrum_audit_project_at
  ON clickup_tracker.scrum_audit (project_id, at DESC);
CREATE INDEX IF NOT EXISTS scrum_audit_kind
  ON clickup_tracker.scrum_audit (kind, at DESC);

-- ── C.1+C.2+C.4 — SCRUM operator state (ships with PR-3a) ──────────────
ALTER TABLE clickup_tracker.projects
  ADD COLUMN IF NOT EXISTS velocity_window     JSONB NOT NULL DEFAULT '[]'::jsonb,
  ADD COLUMN IF NOT EXISTS last_sprint_plan_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS last_groom_at       TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS last_standup_at     TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS last_retro_at       TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS scrum_config        JSONB NOT NULL DEFAULT '{}'::jsonb;
