-- Plan v0.5.0 — Phases I (collab) + L (quality) + M (GitHub deep) + N (Railway).
-- Append-only. Idempotent. Apply after schema/04_visual_richness.sql.

SET search_path = clickup_tracker, public;

-- ── Phase I.1 — PR review activity ingestion ──────────────────────
CREATE TABLE IF NOT EXISTS clickup_tracker.github_review_events (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id      UUID NOT NULL REFERENCES clickup_tracker.projects(id) ON DELETE CASCADE,
  pr_number       INT NOT NULL,
  reviewer_login  TEXT NOT NULL,
  state           TEXT NOT NULL,           -- approved / changes_requested / commented
  submitted_at    TIMESTAMPTZ NOT NULL,
  pr_opened_at    TIMESTAMPTZ NOT NULL,
  pr_author_login TEXT NOT NULL,
  raw             JSONB
);
CREATE INDEX IF NOT EXISTS gre_project_reviewer
  ON clickup_tracker.github_review_events (project_id, reviewer_login);
CREATE INDEX IF NOT EXISTS gre_project_submitted
  ON clickup_tracker.github_review_events (project_id, submitted_at DESC);
-- Idempotency: same (project, pr, reviewer, submitted_at) only counted once.
CREATE UNIQUE INDEX IF NOT EXISTS gre_unique_review
  ON clickup_tracker.github_review_events
  (project_id, pr_number, reviewer_login, submitted_at);

-- ── Phase I.3 — Co-author trailers (pair programming) ─────────────
CREATE TABLE IF NOT EXISTS clickup_tracker.commit_authors (
  project_id  UUID NOT NULL REFERENCES clickup_tracker.projects(id) ON DELETE CASCADE,
  commit_sha  TEXT NOT NULL,
  email       TEXT NOT NULL,
  role        TEXT NOT NULL,  -- 'primary' | 'co-author'
  PRIMARY KEY (project_id, commit_sha, email)
);
CREATE INDEX IF NOT EXISTS commit_authors_email
  ON clickup_tracker.commit_authors (email);

-- ── Phase L — Quality signals ─────────────────────────────────────
CREATE TABLE IF NOT EXISTS clickup_tracker.commit_quality (
  project_id    UUID NOT NULL REFERENCES clickup_tracker.projects(id) ON DELETE CASCADE,
  commit_sha    TEXT NOT NULL,
  coverage_pct  NUMERIC(5,2),
  lint_errors   INT,
  lint_warnings INT,
  test_count    INT,
  test_failed   INT,
  computed_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (project_id, commit_sha)
);

-- ── Phase M.1 — GitHub webhook idempotency ────────────────────────
CREATE TABLE IF NOT EXISTS clickup_tracker.github_webhook_events (
  delivery_id  TEXT PRIMARY KEY,
  project_id   UUID NOT NULL REFERENCES clickup_tracker.projects(id) ON DELETE CASCADE,
  event_type   TEXT NOT NULL,
  received_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  raw          JSONB
);
CREATE INDEX IF NOT EXISTS ghwh_project_received
  ON clickup_tracker.github_webhook_events (project_id, received_at DESC);

-- ── Phase N — Railway deployment tracking ─────────────────────────
ALTER TABLE clickup_tracker.projects
  ADD COLUMN IF NOT EXISTS railway_project_id    TEXT,
  ADD COLUMN IF NOT EXISTS railway_service_ids   JSONB DEFAULT '[]'::jsonb,
  ADD COLUMN IF NOT EXISTS railway_environments  JSONB DEFAULT '{}'::jsonb,
  ADD COLUMN IF NOT EXISTS last_railway_poll_at  TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS deployments_list_id   TEXT,
  ADD COLUMN IF NOT EXISTS whiteboard_url        TEXT,
  ADD COLUMN IF NOT EXISTS bug_form_url          TEXT,
  ADD COLUMN IF NOT EXISTS github_webhook_id     TEXT,
  ADD COLUMN IF NOT EXISTS github_webhook_secret TEXT;

CREATE TABLE IF NOT EXISTS clickup_tracker.railway_deployments (
  id            TEXT PRIMARY KEY,           -- Railway deployment id
  project_id    UUID NOT NULL REFERENCES clickup_tracker.projects(id) ON DELETE CASCADE,
  service_id    TEXT NOT NULL,
  environment   TEXT NOT NULL,
  commit_sha    TEXT,
  status        TEXT NOT NULL,
  started_at    TIMESTAMPTZ,
  finished_at   TIMESTAMPTZ,
  cu_task_id    TEXT,                        -- mirrored CU task
  raw           JSONB,
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS railway_deployments_project
  ON clickup_tracker.railway_deployments (project_id, started_at DESC);
