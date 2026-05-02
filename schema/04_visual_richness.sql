-- 04_visual_richness.sql
-- v0.4.0 Phase E + Phase F prep. Idempotent; safe to re-apply.
-- For existing volumes:
--   docker compose exec -T postgres psql -U cup -d clickup_tracker \
--     -f /docker-entrypoint-initdb.d/04-visual-richness.sql
--
-- E.1 — custom_field_ids already exists in schema/init.sql; no-op here.
-- E.3 — view IDs persisted per List.
-- E.4 — Sprint Goal IDs persisted per ISO week.
-- F.1 — GitHub identity cache, keyed by author email.

ALTER TABLE clickup_tracker.projects
  ADD COLUMN IF NOT EXISTS scrum_goals JSONB NOT NULL DEFAULT '{}'::jsonb,
  ADD COLUMN IF NOT EXISTS view_ids    JSONB NOT NULL DEFAULT '{}'::jsonb;

CREATE TABLE IF NOT EXISTS clickup_tracker.github_identities (
  email          TEXT PRIMARY KEY,
  github_login   TEXT,
  github_url     TEXT,
  avatar_url     TEXT,
  resolved_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  source         TEXT NOT NULL DEFAULT 'commit-api',
  raw            JSONB
);

CREATE INDEX IF NOT EXISTS github_identities_login
  ON clickup_tracker.github_identities (github_login)
  WHERE github_login IS NOT NULL;
