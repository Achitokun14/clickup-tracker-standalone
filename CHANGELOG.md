# Changelog

All notable changes to this project are documented here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

#### Per-repo Space rewrite (PRs #12–#20)

- **Per-repo Space registration**: every registered repo now becomes its own ClickUp Space with four Folders (📦 Backlog & Bugs, 🚧 Active Work, 📜 History, 📚 Knowledge), 7-status workflow + 6-status Bugs override, ISO-week Sprint Lists, a 5-page Doc, and one task per commit with native fields populated (priority, points, time_estimate, dates, tags, assignees). Opt in via `POST /projects` body `{ backfillMode: 'space' }`; `backfillMode: 'legacy'` keeps the old 3-list path for back-compat.
- **`scripts/wipe-and-rereg.sh`**: convenience to wipe + re-register an existing project in Space mode and poll the backfill state.
- **6 new control endpoints** on `/projects/:id`: `GET /backfill`, `POST /replan`, `POST /tasks/:taskId/{approve,reopen,assign,comment}`. Guarded by the existing `StandaloneAuthGuard`.
- **6 new MCP tools** (`clickup_get_backfill_status`, `clickup_replan_project`, `clickup_approve_task`, `clickup_reopen_task`, `clickup_assign_task`, `clickup_comment_task`); 3 modified for the new response shape.
- **6 new slash commands** mirrored into `agents/claude-code/commands/` and `agents/opencode/commands/`.
- **Bidirectional ClickUp webhook**: `POST /public/clickup-events` guarded by `ClickUpHmacGuard` (HMAC-SHA256 of the raw body using `workspace_settings.webhook_secret`). Persists to `clickup_inbound_events`; the `cup-sync` worker drains rows, reverse-resolves task→project via `task_index`, and bumps `projects.last_seen_status_changes`.
- **In-house token-bucket rate limiter** for ClickUp writes (default 90 req/min per token, env `CLICKUP_RATE_LIMIT_PER_MIN`). Retry on 429 (honours `X-RateLimit-Reset`) and 5xx (exponential 1/2/4/8/16 s, max 5).
- **~25 new ClickUp client wrappers** including v3 `moveTaskToList`, `createDoc`/`createDocPage`, `createListView`, `createWebhook`, `createTimeEntry` (backdateable), `addDependency`, `assignTask`, `setTaskStatus`.
- **`X-CUP-Source` header** on `/public/git-events` and `/public/prompt-events` (defaults to `human`). Becomes a `source:<kebab>` tag on every created task.
- **Time Entries opt-in** (env `CUP_BACKFILL_TIME_ENTRIES=on`) — per-commit `createTimeEntry` using the planner's `estimateMinutes` fallback. Off by default because of the API budget.
- **Dependency linking** (default ON, env `CUP_BACKFILL_DEPENDENCIES=off` toggles) — when an Agent Sessions task and a commit task share a `(scope)`, link them via `addDependency`.
- **Per-repo Space planner** (`bulk/hierarchy.ts:planSpace`) — pure function returning a `SpacePlan`. Both backfill and lifecycle use the same `planSpaceCommitTask()` helper, so backfilled and live commits look identical.
- **Server-side extractors**: `git-history.extractor.ts` (numstat-aware, ISO-week sprint bucketing, capped at `MAX_BACKFILL_COMMITS=5000`) and `repo-extract.extractor.ts` (README/CHANGELOG/package metadata + TODO/FIXME scan with 1MB/file and 200-marker caps). Daemon now owns canonical extraction.
- **BGMT classifier** (`util/classify.ts`) — verbatim port of the upstream Python `KEYWORD_CLUSTERS`, `TAG_KEYWORDS`, `AUTHOR_MAP`, `classifyType`, `classifyEpic`, `deriveTags`, `assignPriority`, `estimateMinutes`.
- **ISO 8601 week util** + **git remote parser** + **commit URL formatter** (host-aware GitHub/GitLab/Bitbucket/Gitea/Codeberg).
- **scope_config subdir filter** is finally enforced on the daemon — when `project.scope_config.mode='subdir'` and zero files match a tracked path, the `git_event` row persists but ClickUp emission is skipped.
- **3 new Prometheus metrics**: `cup_backfill_state{project_id, status}`, `cup_backfill_tasks_processed_total{project_id, outcome}`, `cup_inbound_webhooks_total{event_type, processed}`.
- **Pino redact list** expanded to mask `Authorization` headers and `*.token`/`*.hookSecret`/`*.webhook_secret`.
- **2 new docs**: `docs/space-model.md` (per-repo Space structure, idempotency, performance budget) and `docs/runbook.md` (operational recipes).
- **Per-repo Space schema delta** (`schema/02_per_repo_space.sql`): 8 new project columns, 2 new tables (`workspace_settings`, `clickup_inbound_events`), 4 new indexes including a functional UNIQUE on inbound dedup.
- **`.github/CODEOWNERS`** so branch-protection's `require_code_owner_reviews` is satisfiable.

#### Earlier work

- **OAuth bootstrap** (`scripts/oauth-bootstrap.sh` + `oauth-bootstrap.py`) — one-shot browser flow that exchanges a ClickUp OAuth `client_id` + `client_secret` for an access token and writes it into `.env`. Lets users whose accounts disallow personal API tokens still run the tracker. Auto-detects the workspace ID via `/api/v2/team`.
- `.env.example` documents both the personal-token path and the OAuth path; `CREDS.md` explains both with end-to-end instructions.

### Changed

- `POST /projects` now ignores soft-removed (`status='removed'`) rows when checking for existing registrations — re-registering a previously untracked path now resurrects it cleanly with a fresh `hookSecret` instead of returning `alreadyTracked: true` with an empty secret.
- Daemon defensively merges incoming `extract` payloads with safe defaults — partial extracts (e.g. `{readme, changelog}` only, missing the `todos` array) no longer 500 with `ext.todos is not iterable`.

### Fixed

- **Post-commit hook on Debian/Ubuntu (`mawk`)** — the TODO/FIXME scanner used GNU-awk-only syntax (3-arg `match()`), which silently failed on every system where `awk = mawk` (the default on most Debian-derived distros). Rewritten in POSIX-only awk (`RSTART`/`RLENGTH`). Hook now works on `mawk`, `gawk`, `nawk`, and macOS BSD awk. Caught during end-to-end testing where commits weren't reaching the daemon.
- `.gitignore` now covers `.env.bak*` and `.env.backup*` (used by `oauth-bootstrap.sh` when it rewrites `.env`).

### Removed

- `zod` dropped from `mcp/package.json` top-level dependencies — it was a phantom dep, never imported by `server.ts` (the MCP SDK pulls it transitively where actually needed).

## [0.1.0] - 2026-04-28

### Added

- Initial public release as `clickup-tracker-standalone`.
- AGPL-3.0 license.
- Self-contained Docker stack: Postgres + Redis + NestJS daemon, `restart: always`.
- HTTP API at `:4020/` — internal `/projects/*`, public `/public/{git,prompt}-events`, `/health`, `/public/metrics`.
- Universal MCP server (`mcp/`) wrapping the daemon — works with any MCP-capable agent (Claude Code, Goose, OpenCode, Cursor, Cline, Continue).
- Per-agent integration shims under `agents/`:
  - `claude-code/` — slash commands + Stop/UserPromptSubmit hooks + installer.
  - `claude-compat/` — wrapper for OpenClaw / ZeroClaw / ClawCode (share the `~/.claude/` convention).
  - `goose/` — recipes + MCP extension.
  - `opencode/` — slash commands + MCP config.
  - `generic-mcp/` — config snippet for any MCP agent.
  - `http-direct/` — raw HTTP examples for non-MCP agents.
- Cross-platform: Linux, macOS, and Windows (via Git Bash / WSL2 / Docker Desktop).
- Unified one-script installer that detects OS and runs end-to-end setup.
- Documentation under `docs/` — quickstart, architecture, API reference, deployment, troubleshooting, FAQ, Windows guide, integrations.
- Contributor scaffolding: `CONTRIBUTING.md`, `CODE_OF_CONDUCT.md`, `SECURITY.md`, `CODEOWNERS`, PR + issue templates, GitHub Actions CI, Dependabot.

### Changed

- Routes are exposed at the daemon root (`:4020/...`) with no `/api/v1/clickup-tracker` prefix. The seven slash commands and the two Claude Code hooks were updated to match.
- Default ClickUp space name reset from the org-specific `BGMTech` to `Default` (override via `DEFAULT_CLICKUP_SPACE_NAME`).
- Source headers and comments stripped of monorepo / personal-path references.
- Hook config key `gateway_url` renamed to `base_url` consistently across hooks and slash commands.

### Security

- `STANDALONE_API_TOKEN` and `METRICS_AUTH_TOKEN` documented as required when exposing the daemon beyond localhost.
- Per-project HMAC `hook_secret` model documented in `CREDS.md` and `SECURITY.md`.
- Private security reporting via GitHub Security Advisories.

[Unreleased]: https://github.com/Achitokun14/clickup-tracker-standalone/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/Achitokun14/clickup-tracker-standalone/releases/tag/v0.1.0
