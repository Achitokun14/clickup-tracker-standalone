# Changelog

All notable changes to this project are documented here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

_(none — v0.5.0 shipped on 2026-05-03. Next planned milestone is the v0.6.0 cross-VCS surface (GitLab + Bitbucket identity bridges + webhook ingestion). See [`docs/roadmap.md`](./docs/roadmap.md).)_

## [0.5.0] - 2026-05-03

The *deep collaboration + quality + integrations* milestone. Twelve PRs across Phases I (collab), J (richer CU surfaces), K (cross-project rollup + notifications), L (quality signals), M (GitHub deep), N (Railway deployment tracking).

### Added — Phase I (Deeper collaborator tracking)

- **PR review activity ingestion** (I.1) — `github_review_events` table + `ReviewEventsService.record` (idempotent on `(project_id, pr_number, reviewer_login, submitted_at)`). Webhook → `pull_request_review.submitted` ingestion path.
- **Review SLA in retro** (I.2) — `slaForProject` + `renderReviewSlaMd` surface 30-day per-reviewer averages; reviewers averaging > 24h get a ⏰ marker.
- **Pair programming credit** (I.3) — `parseCoAuthors` extracts `Co-authored-by:` trailers from commit bodies, deduped on lowercased email; persisted to `commit_authors`. Co-authors auto-added as watchers on the commit task.
- **File ownership map** (I.4) — `OwnershipService.topOwnersForPath` / `topOwnersForProject` use recency-weighted SQL (`90d=1.0`, `180d=0.5`, older `0.25`) over `git_events.files_changed`. `GET /projects/:id/ownership[?path=…]` exposes both views; `renderOwnershipMd` powers an auto-managed `Ownership` Handbook page (I.5).

### Added — Phase J (Richer CU surfaces)

- **Time tracking** (J.1) — `estimateMinutesForSprintTask` heuristic auto-fills `time_estimate` on sprint planner finalisation; `summariseTimeEntries` + `listTimeEntriesForTask` wrapper feed retro variance.
- **Folder views** (J.2) — `createFolderView` / `getFolderViews` wrappers; `backfill.ensureFolderViews` seeds Board / Calendar / Gantt across the Active Work folder.
- **Whiteboards** (J.3) — `createWhiteboard` wrapper + `backfill.ensureWhiteboard` scaffolds an Architecture Map; URL persisted to `projects.whiteboard_url`. Tier-gated; 4xx silently skipped.
- **Bug intake Form** (J.4) — `createForm` wrapper + `backfill.ensureBugForm` attaches a public Form view to the Bugs List; URL persisted to `projects.bug_form_url`.
- **Recurring ceremony tasks** (J.5) — `createRecurringTask` wrapper + `ensureCeremonyRecurringTasks` creates a single recurring `Daily Triage` task on Open Work instead of duplicating one per tick.

### Added — Phase K (Cross-project rollup, notifications, automation)

- **Workspace overview** (K.1) — `WorkspaceRollupService.refreshForOrg` cron rebuilds a per-org rollup with three sections (active projects, cross-project hotspots, workspace contributors), each rendered to a Markdown payload.
- **Daily DMs + email digest** (K.2 + K.3) — `DigestService.sendDailyDmsForProject` posts per-author CU notifications honouring `scrum_config.members.notification_opt_out`. SMTP path stubbed behind `SMTP_HOST` env so opt-in is explicit.
- **Slack bridge** (K.4) — `SlackService` posts on sprint plan finalisation, critical bugs opened, and sprint retros. Activated only when `SLACK_WEBHOOK_URL` env is set.
- **Reviewer suggestions** (K.5) — `ReviewerSuggesterService.suggestForFiles` queries `file_ownership`, returns top-3 owners excluding PR author. Fed into PR-opened comments.
- **Issue cross-linking** (K.6) — `extractIssueRefs` parses `#N`, `GH-N`, `JIRA-XXX`, `<owner>/<repo>#N` from commit bodies; mapped via `task_index["issue:N"]` to call `addTaskLink` (or `addTaskUrlAttachment` for external).

### Added — Phase L (Quality signals)

- **Coverage delta + lint regression** (L.1 + L.2) — `parseCoverageReport` auto-sniffs LCOV / cobertura / istanbul. `QualityService.recordQuality` persists per-commit metrics in `commit_quality`; `previousQualityRow` comparison tags `coverage-regression` / `lint-regression` on the commit task.
- **Risk score** (L.3) — `computeRiskScore` formula = `log1p(churn_30d) × 0.4 + bugs × 1.5 + LOC/1000 × 0.2 + test_age/90 × 0.3`. `bandForScore` + `tagsForBand` drive `risk-high` / `risk-critical` task tags. `GET /projects/:id/risk` powers an auto-managed `Risk Register` Handbook page; `renderRiskRegisterMd` renderer.

### Added — Phase M (GitHub deep integration)

- **Webhook ingestion** (M.1) — `POST /github/webhooks/:projectId`. HMAC-SHA256 verification (X-Hub-Signature-256) using `projects.github_webhook_secret`; `timingSafeEqual` constant-time compare. Idempotency via `github_webhook_events.delivery_id` PK. `pull_request_review.submitted` dispatched to `ReviewEventsService`.
- **Actions status mirror** (M.2) — `ActionsMirrorService.recordRun` tags the linked commit task `ci-pass` / `ci-fail` / `ci-cancelled` (via `ciTagFor`) and posts a workflow-link comment. `recordPrOpened` / `recordPrClosed` tag `pr-open` / `pr-merged` / `pr-closed` on the head/merge_commit_sha task. Wired into the webhook dispatcher for `workflow_run.completed` + `pull_request.{opened,closed}`.
- **gh-cli polling fallback** (M.3) — `GithubPollCron` skeleton (every 5 min, no-op when `GITHUB_TOKEN` unset) selects active projects with `github.com` remote and `github_webhook_id IS NULL`, ready for the gh-api fetch path.

### Added — Phase N (Railway deployment tracking)

- **Railway API client** (N.1) — `RailwayApiService` wraps the GraphQL v2 endpoint (listProjects / listServices / listDeployments / getDeploymentLogs) with a defensive minimal field set so schema drift only breaks the one call that touched the missing field. `terminalStatus` + `statusEmoji` helpers.
- **Project ↔ Railway binding** (N.2) — `PATCH /projects/:id/railway` persists `railway_project_id` / `railway_service_ids` / `railway_environments`. Mapped through `ProjectRow` + `mapProjectRow`.
- **2-min poll cron** (N.3) — `RailwayPollCron` fires every 30s but throttles per-project to 2 min via `last_railway_poll_at`; advisory lock `railway:poll` per project; `staleness` returns 24h ago for cold starts and 60s before last poll for overlap safety.
- **Deployment mirror** (N.4 + N.5) — `DeploymentMirrorService.mirror` creates/updates one CU task per Railway deployment id (idempotent on the Railway id PK), cross-links the shipped commit task on terminal status via `addTaskLink`, and tags `deployed-to-<env>`.
- **Deployments List custom fields** (N.6) — `seedDeploymentFields` provisions `environment` / `deployment_status` / `commit_sha` / `build_duration_seconds` / `deploy_url`; `backfill.ensureDeploymentsList` scaffolds the 🚀 Deployments List under Active Work and persists IDs into `custom_field_ids.deployments`.
- **Deployment summary in standup + retro** (N.7) — `summariseDeployments` rolls up per-env counts + MTTR; `renderDeploySummaryMd` renderer; standup `## Deployments (last 24h)` + retro `## Deployment summary (this sprint)`.
- **Optional Railway webhook** (N.8) — `POST /railway/webhooks/:projectId` (HMAC-SHA256 when `RAILWAY_WEBHOOK_SECRET` set, open otherwise). Accepts shaped payloads via `parseRailwayWebhook` (snake_case + camelCase tolerant); unknown shapes accepted silently so upstream relay schema changes don't block the queue.
- **Deployments Doc page** (N.9) — auto-managed handbook page rendered by `renderDeploymentsPageMd` (last 30 deployments, 6-column table). Refreshed once per poll cycle when at least one deployment was mirrored.
- **`/clickup-deploy-status` slash command** (N.10) — Claude Code + opencode mirrors. Groups output as latest per env, in-flight builds, last failure per env. Auto-resolves project from `pwd` when no projectId argument supplied.

### Schema

- `schema/05_collab_quality_railway.sql` adds:
  - `github_review_events` (idempotency unique index on PR + reviewer + submitted_at)
  - `commit_authors` (pair programming pickup)
  - `commit_quality` (coverage / lint / test pass-fail)
  - `github_webhook_events` (delivery_id PK)
  - `railway_deployments` (Railway id PK)
  - 9 new `projects` columns: `railway_project_id` / `railway_service_ids` / `railway_environments` / `last_railway_poll_at` / `deployments_list_id` / `whiteboard_url` / `bug_form_url` / `github_webhook_id` / `github_webhook_secret`

### Operator surface

- `/health` reports `integrations.{github_token, smtp, slack_webhook, railway_token}` booleans so misconfigurations surface early.
- New env vars (all optional): `GITHUB_TOKEN`, `RAILWAY_API_TOKEN`, `RAILWAY_WEBHOOK_SECRET`, `SLACK_WEBHOOK_URL`, `SMTP_*`, `COVERAGE_REPORT_URL`. All integrations fail-soft when their env var is unset.

### Tests

- 534 passing (up from 422 at v0.4.0). +112 specs covering review SLA, ownership SQL composition, quality signals, webhook HMAC paths, GitHub Actions tag mapping, Railway helpers, deployment mirror renderers, deployments page renderer, deploy summary aggregation.

## [0.4.0] - 2026-05-02

The *native ClickUp UI richness* milestone. Five PRs across Phases E (CU primitives), F (GitHub identity), G (Doc redesign), H (visual lifecycle). Replaces the v0.3.0 plain-markdown surfaces with structured CU primitives: colored space tags, custom fields, multi-view seeds, sprint Goals, watchers, structured @-mentions, GitHub identity bridge, redesigned standup/retro Doc pages with Unicode progress bars + sparklines, emoji-prefixed task names, and collapsible commit bodies.

### Added — Phase E (Native CU UI primitives)

- **Colored space tags** (E.2) — new `tagPalette()` util maps each canonical tag (`epic:*` blue, `severity:critical` red, `severity:high` orange, `type:feat` violet, `type:fix` rose, `source:*` gray, …) to a fg/bg hex pair; `ensureTags` passes them through `createSpaceTag`. Idempotent: never PATCHes existing tags so user-edited colors stick.
- **Custom field schema** (E.1) — new `CustomFieldsService` seeds 8 canonical fields per List on Space scaffold (`commit_sha` / `pr_url` / `author_email` / `author_github_url` / `epic` / `severity` / `source` / `milestone`). Each List gets only the subset relevant to it; idempotent via case-insensitive name match. Field IDs persisted to `projects.custom_field_ids[listKey][fieldKey]`. Sprint history Lists share the active_sprint schema.
- **`createCustomField` wrapper** on `ClickUpDirectService` (POST `/list/{id}/field`) supports all v2 field types + `type_config.options` for dropdowns.
- **Multi-view seeding** (E.3) — new `ViewsService` seeds Board/Calendar/Gantt/Workload per List per the v0.4.0 schema. Board grouped by assignee/status/severity tag/epic tag depending on List. Workload is tier-gated (Business+); failures debug-logged. Idempotent via case-insensitive view name match.
- **Sprint Goals + Key Results** (E.4) — sprint planner creates one CU Goal per ISO week (name `Sprint <isoWeek>`) with velocity stats in description and one automatic Key Result linked to the sprint List, so CU rolls up "X of N done" as tasks close. Goal IDs persisted to `projects.scrum_goals[isoWeek]`; deduped on re-run; due-date = Sunday 23:59:59Z.
- **Watchers** (E.5) — `addWatcher` wrapper. After commit task creation, daemon resolves `committer_email` against `workspace_settings.members_cache` (case-insensitive) and adds the user as watcher.
- **Structured @-mentions** (E.6) — new `addStructuredComment` wrapper using v2's `comment` array form + new `buildMentionedComment(template, resolveMember)` helper. `{@email}` tokens become real `attributes.mention.user_id` segments when resolvable; fall through to plain `@email` text otherwise.

### Added — Phase F (GitHub collaborator identity)

- **`GithubIdentityService`** (F.1) — resolves commit author email → GitHub login/avatar/profile URL via `/repos/{owner}/{repo}/commits/{sha}`. Cached in new `github_identities` table (lowercase email PK).
- **Discriminated cache policy** — true 404/422 misses → 24h negative cache; transient errors (network/auth/5xx) → no cache write so operator-fixable issues recover next commit.
- **GitHub rate-limit guard** — `GITHUB_TOKEN` env unlocks authed 5000/h; when `X-RateLimit-Remaining < 5`, halts new fetches for 60s.
- **Author custom fields on commit task** (F.3) — events.service writes `commit_sha`, `author_email`, `author_github_url`, `source=commit` after `createTask` via `setFieldsOnTask`. Skips silently when project pre-dates field seeding.
- **`GET /projects/:id/contributors`** (F.4) — new endpoint backed by `ContributorService`. Aggregates per-author commit counts (30d + all-time, first/last seen) joined with cached identities.
- **Identity-aware standup** (F.2) — `renderStandupMd` accepts an `identities` Map keyed by lowercase email; per-author header upgrades from `## email` to `## ![avatar] [github_login](url)\n*email*` when known. ReportingService batch-loads from cache only (no on-demand GitHub API call from the standup path).

### Added — Phase G (Doc page redesign)

- **`util/progress-bar.ts`** — `bar(done,total,width)`, `sparkline(values[])`, `ratio(done,total)` Unicode helpers (block characters, no deps, safe in CU's Markdown viewer).
- **Standup template upgrade** (G.1) — Sprint Health blockquote with horizontal progress bar; per-author summary table (Yesterday count + top commit + identity-aware avatar/login when cache hit); detailed activity wrapped in `<details>` for noise control.
- **Retro template upgrade** (G.2) — Velocity sparkline from the project's `velocity_window` (last N sprints); compact metric tables for velocity + bug throughput; carryover spike warning preserved.
- **Auto-managed handbook pages** (G.3) — three new pages seeded by `hierarchy.planSpace`: Contributors (rendered by `ContributorService.renderContributorsMd` with avatar + login + commit counts), Architecture, Dashboard. Total Doc pages now 8 instead of 5.

### Added — Phase H (Visual lifecycle)

- **Emoji-prefixed task names** (H.1) — single source of truth in `util/emoji-map.ts`. Commit tasks: ✨ feat / 🐛 fix / 🔧 chore / 📝 docs / ♻️ refactor / 🧪 test / ⚡ perf / 🏗️ build / 🤖 ci / ⏪ revert / 🎨 style. Bugs by severity: 🚨 critical / 🟧 high / 🟨 medium / 🟢 low. Synthetic artifacts: 📂 module / 🔥 hotspot / 📦 deps / 🚀 deployment / 🏷️ release. Applied uniformly by both backfill (`planCommitTask`) and the live commit handler.
- **Collapsible markdown_content** (H.2) — `buildCommitDescription` rewritten with header line + `<details>` blocks for Files Changed (full list, not just top-10) and Commit Body. Reader sees the gist instantly; expands only what's interesting.
- **Artifact Watch as table** (H.3) — bundled per-commit comment listing non-code touched files now renders as a `| Kind | Count | Files |` Markdown table instead of a flat bullet list.
- **Attribution-aware Changelog** (H.4) — each Changelog Doc page line gets a UTC timestamp + commit-author identity (avatar + GitHub login when cache hit; plain email fallback) instead of just a bare task name.

### Schema

- `schema/04_visual_richness.sql` — adds `projects.scrum_goals` + `projects.view_ids` JSONB columns; creates `clickup_tracker.github_identities` table with lowercase-email PK + a partial index on `github_login`. Idempotent.

### Docs

- New deep-dive guides with mermaid diagrams: [`scrum-operator.md`](./docs/scrum-operator.md), [`scrum-tracked-artifacts.md`](./docs/scrum-tracked-artifacts.md), [`multi-developer.md`](./docs/multi-developer.md), [`github-identity.md`](./docs/github-identity.md), [`custom-fields-and-views.md`](./docs/custom-fields-and-views.md), [`roadmap.md`](./docs/roadmap.md).
- Rewritten [`architecture.md`](./docs/architecture.md) with mermaid component / sequence / ER / state diagrams reflecting v0.3.0 + v0.4.0 surfaces.

### Tests

- 422 passing across 36 suites (+57 from v0.3.0): tag-palette (7), custom-fields (16), views (8), mentions (7), sprint-planner Goal creation (2), GithubIdentityService (10), ContributorService (8 — +4 for `renderContributorsMd`), progress-bar (15), emoji-map (15).

## [0.3.0] - 2026-05-02

The autonomous-SCRUM release. Builds a multi-developer workspace adoption flow on top of the v0.2 per-repo Space model, then layers a heuristic-only autonomous SCRUM operator over it: sprint planner, daily groomer, weekday standups, end-of-sprint retros, artifact classifier, audit trail, and per-team advisory-lock leadership. Hardens production with branch-routing/Doc-atomicity/controller hotfixes, an orphan-Space detection cron, member-offboarding diff, an auth-needed state machine, and rate-limit priority queues so autonomous traffic never starves user actions.

### Added

#### Phase A — production hotfixes (PRs #35)

- **3-layer branch-routing fix (Bug 1)** — hook script falls back to `init.defaultBranch` on detached HEAD, daemon synthesises `git_default_branch` when DTO branch is empty, planner safety net treats null+empty refs as default. Branch-null commits no longer mis-route to In Review.
- **Atomic Doc creation (Bug 2)** — `ensureDoc` now persists `clickup_doc_id` *before* attempting page creates; per-page failures append to `backfill_state.errors` instead of crashing the whole try-block. Replan after partial failure only creates missing pages.
- **Controller exposes all 19 schema columns (Bug 3)** — `mapProjectRow` adds `clickupDocId`, `sprintLists`, `backfillState`, `templateStatus`, `gitDefaultBranch`, `gitRemoteHost`, `gitRemoteOwnerRepo`, `lastSeenStatusChanges` (previously dropped).
- **`POST /projects/:id/repair-routing?dryRun=true|false`** — cleans up duplicate commit tasks from prior wipe-and-rereg cycles + moves misrouted In-Review tasks to the current sprint List. Default `dryRun=true`; `?dryRun=false` mutates.
- **Wipe-aware `register` adoption gate (Bug 4)** — when an existing Space matches by displayName, register adopts it instead of creating a duplicate.

#### Phase B — multi-developer workspace adoption (PRs #36, #39, #44, #45, #46)

- **`GET /projects/lookup`** + **`POST /projects/adopt`** — find an existing Space (by `git_remote_url` footer match → strong, displayName/owner-repo slug → medium, kebab substring → weak) and hydrate `list_ids` + `task_index` from auto-imported task footers.
- **Tolerant Folder/List hydration** — emoji-prefix Folder match (📦 → backlog_bugs, 🚧 → active_work, 📜 → history, 📚 → knowledge); ad-hoc human Lists/Folders in the Space are persisted into `extra_lists` / `extra_folders` and never touched.
- **Team-level git_events uniqueness** (`schema/03_collab_and_scrum.sql`) — partial UNIQUE on `(clickup_team_id, commit_sha)` so the same SHA from two developers' daemons dedupes silently.
- **Webhook race coordination** — second daemon's backfill detects an existing `workspace_settings.webhook_id` + caches the secret instead of creating a duplicate webhook.
- **Worktree dedupe in register** — `(orgId, local_path) OR (orgId, git_remote_url)` lookup means a second clone of the same remote on one machine returns the existing project row.
- **Orphan-Space detection cron** (B.8) — every 30 min, ping each active project's Space; on 404 flip status `active → orphaned` so the daemon stops writing. `CUP_ORPHAN_DETECTION=off` disables.
- **Member-offboarding diff** (B.9) — when the 24h workspace-members cache refetches successfully, emails removed from the workspace get appended to every active project's `scrum_config.members_offboarded` (JSONB DISTINCT for idempotency).
- **Auth-needed state machine** (B.6) — 401 from CU writes flips status `active → auth-needed`; ingestGit early-returns on any non-active status; `POST /projects/:id/refresh-credentials` flips back after operator rotation.

#### Phase C — autonomous SCRUM operator (PRs #37, #38, #40, #41, #43, #47, #48)

- **Sprint planner** (`scrum/sprint-planner.service.ts`) — Mondays 08:00 UTC; velocity = mean of last 4 sprint Lists' Done counts (default 8 while warming up); selection in priority order: carryover → bug ceiling (round(velocity × 30%)) → top open work; idempotent on `iso_week`; goal inferred from mode of `epic:` tags.
- **Daily groomer** (`scrum/groomer.service.ts`) — 06:00 UTC; 4 rules (dedupe via Jaccard ≥ 0.8 + file overlap, stale-bug bump/shame, hotspot promote with 30d cooldown, zombie archive default-OFF). Posts a `[YYYY-MM-DD] Daily Triage` summary task.
- **Standup + retro reporting** (`scrum/reporting.service.ts`, C.4) — weekday 08:30 UTC standup pages grouped by author with sprint-progress + true blocker filter (priority=urgent OR tag=blocked), Sun 18:00 UTC retro with velocity actual-vs-committed + bug throughput diff + carryover spike call-out. Both posted under auto-managed Standups/Retros parent Doc pages; idempotent on UTC date / iso_week.
- **Master 5-minute scheduler** (`scrum/scrum.scheduler.ts`) — single tick decides which projects are due for plan/groom/standup/retro and dispatches under `LeadershipService.withLeadership(team_id, lock_name)` (Postgres `pg_try_advisory_xact_lock`) so only one daemon per workspace acts.
- **Audit trail** (`scrum/audit.service.ts` + `scrum_audit` table) — every autonomous action emits a row with before/after/reason/dry_run; browseable via `GET /projects/:id/scrum/audit`.
- **Artifact classifier** (`util/classify.ts:classifyArtifact`, C.5) — 9 kinds (adr/doc/infra/dependency/config-schema/binary-resource/submodule/generated/code); commit lifecycle posts ONE bundled `Artifact watch` comment per commit grouping non-code/non-generated files by kind.
- **Scope-rename detection** (`refactor(legacy→v2):`, C.3) — accepts unicode `→` or ASCII `->`, cross-links old + new tracked tasks via `scope-renamed` tag + stamped comments, leaves a breadcrumb on the commit task when neither side is tracked yet.
- **Branch-deletion close** (C.3) — `dto.branch_deleted=true` event closes commit tasks recorded for that branch; hook script auto-emits `prev_path` on renames via `git diff-tree -M`.
- **File rename + delete handlers** (C.3) — bundled `**Renames:**` comment on commit task; deletions close any `path:<file>`-anchored Open Work task.
- **PR-comment inbound hooks** (C.3) — `taskCommentPosted` matching GitHub/GitLab/Bitbucket bot phrasing auto-tags `pr-open` or closes on PR-merge. Heuristic regex; merged outranks open.
- **Three-tier rate limiter** (C.8) — `ClickUpRateLimiter.acquire(tokenKey, "urgent" | "normal" | "scrum")`; strict priority means autonomous SCRUM crons never starve user/lifecycle traffic. Propagated via `AsyncLocalStorage` so SCRUM service entry points are the only changed call sites.
- **Operator control surface** (C.7) — `POST :id/scrum/{plan-sprint,groom,standup,retro}?dryRun=true|false`, `GET :id/scrum/state`, `PATCH :id/scrum/config`, `GET :id/scrum/audit?since&kind&limit`. All gated by `CUP_AUTOSCRUM=off` env kill switch.

### Changed

- **Hook DTO grows** `prev_path` (file-level, on renames) + `branch_deleted` (event-level, for branch-delete events). Forward-compatible: older hooks keep working; new lifecycle code only fires when fields present.
- **Artifact comment supersedes per-file subtasks** — non-code commits now post one bundled comment rather than spinning up subtasks for every doc/infra/dep change.

### Fixed

- **Sprint List name format round-trip** — sprint planner emits `Sprint <N> — YYYY-MM-DD → YYYY-MM-DD` (was `Sprint ? — …` which broke the AdoptService regex on re-adoption).
- **Adoption footer regex** — `/Auto-imported by clickup-tracker\./` (was `/_Auto-imported…\._/` which never matched the actual emit).
- **Adoption SHA parsing** — anchored to the `**Commit:** \`<sha>\`` line rather than a loose 7-40-hex regex that grabbed unrelated hashes.

### Schema

- **`schema/03_collab_and_scrum.sql`** (new): adds `clickup_team_id` to `git_events` with partial UNIQUE; new `scrum_audit` table; new project columns `velocity_window`, `last_sprint_plan_at`, `last_groom_at`, `last_standup_at`, `last_retro_at`, `scrum_config`, `extra_lists`, `extra_folders`.

### Tests

- **344 tests passing** across 28 suites (was 100ish at v0.2.1). Notable adds: 16 reporting specs, 11 rate-limiter specs (5 priority-queue), 8 orphan-detection specs, 7 auth-rotation specs, 13 PR-comment specs, 10 scope-rename specs, 6 hook-extension specs.

## [0.2.1]

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

#### Sessions 6–8 follow-ups (PRs #21–#33)

- **Session 7 docs + observability** (#21) — `docs/runbook.md` operational recipes, `docs/space-model.md` per-repo Space reference, Pino redact list expanded for hookSecret/webhook_secret/Authorization, 3 Prometheus metrics on `/public/metrics`.
- **`POST /projects/:id/template-configured`** + `clickup_mark_template_configured` MCP tool + `/clickup-template-configured` slash command (#30) — flips `template_status` to `configured` after the manual ClickUp UI walkthrough so the daemon emits literal status names instead of mapping down to `to do`/`complete`. Walkthrough lives in `docs/clickup-template/README.md` (#27).
- **Doc Changelog page append on default-branch commits** (#28) — `events.service.tryAppendChangelogPage` looks up the page once via `listDocPages`, memoizes it in `task_index['doc_page:Changelog']`, and `updateDocPage(content_edit_mode='append')` per commit.
- **Client-side subdir-scope early-out in post-commit hook** (#31) — `install-git-hook.sh` accepts `--scope-mode subdir --scope-paths "svc/,mcp/"`; the generated hook walks `git diff-tree` and `exit 0`s silently when no match. Daemon-side filter remains authoritative; this skips HMAC + curl entirely. `clickup-add` slash command auto-passes the flags when `scopeConfig.mode='subdir'`.
- **Agent-Session ↔ commit dependency linkage** (#33) — when a prompt-event arrives with `files_touched`, the daemon links the resulting Agent-Session task to the most-recent commit task whose changed files overlap (`addDependency(commit, { dependency_of: session })`). One dependency per session-end; downstream commits add their own.
- **Empty-history repo coverage** (#32) — planner spec asserts that a `git init`-ed repo emits the full Space scaffold (4 folders, 5 Doc pages) but no commit tasks, no per-sprint Lists, no truncation warning. Runbook entry added.
- **Host bind-mount for server-side git extraction** (#27) — `docker-compose.yml` mounts `${CUP_HOST_MOUNT:-${HOME}}` read-only into the service container so `git-history.extractor` can reach repos by their host paths. Dockerfile installs `git` + sets `safe.directory='*'`.

### Fixed (Sessions 6–8)

- **Lifecycle status writes 400'd with "Status not found"** (#25) — ClickUp v2 silently ignores `statuses` on `createSpace`, `PUT /space`, and `PUT /list`, so freshly-created Spaces always have the default 2-status workflow regardless of what the planner emits. Added `mapInlineStatus(name)` that coerces the planned 7-status names down to `to do` / `complete` when `template_status='inline-fallback'`. Approve/reopen endpoints fixed in #26.
- **`Cannot read properties of null (reading 'toLowerCase')` on listSpaces** (#24) — ClickUp returns spaces with `name=null`; added defensive coalesce.
- **`createSpace` payload now includes `statuses`** (#23) — empirically confirmed CU silently ignores it but the field is preserved for the day they fix it; the same code path also `PUT`s the full Space payload on the post-create status replay so existing config isn't dropped.
- **`listDocPages` v3 response is an array, not `{pages: [...]}`** (#29) — wrapper now accepts both shapes; previously a silent no-op on the Changelog append path.
- **BullMQ rejects `:` in jobId** (#27) — sanitized in `QueueService.addJob` (replace `:` → `_`); upstream callers compose `backfill:<uuid>`.
- **`pre_remove` backup 404 noise on per-repo Spaces** (#30) — `BackupService.take` now skips the legacy `getFolder` probe when `project.clickup_folder_id` is null and stubs the snapshot's folder block with the project's display name.

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
