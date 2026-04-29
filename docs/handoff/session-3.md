# Handoff — Session 3

**Date:** 2026-04-29
**Plan:** `~/.claude/plans/sleepy-crunching-ember.md`
**Branch / commits / PRs:**
- PR #16 — `feat(planner): SpacePlan + git-history/repo extractors + BGMT classifier (Session 3)` — open, CI in flight

**CARL decisions logged this session (domain `CLICKUP_TRACKER_REWRITE`):**
- (logged at session close — see below)

## Verification steps passed

| # | Step | Result |
|---|------|--------|
| 1 | `npx tsc --noEmit` | ✅ clean |
| 2 | `npx jest` | ✅ 11 suites, 133/133 pass (was 79/79) |
| 3 | ISO-week edge cases (year-rollover, W53 in 2020) | ✅ unit-tested |
| 4 | Git remote parse: GitHub HTTPS+SSH, GitLab nested groups, Bitbucket, Gitea, Codeberg | ✅ unit-tested |
| 5 | Commit URL formatter host-aware (GitHub `/commit/`, GitLab `/-/commit/`, Bitbucket `/commits/`, BB-Server `/projects/.../commits/`) | ✅ unit-tested |
| 6 | Classifier verbatim-port parity vs BGMT (PREFIX_MAP, KEYWORD_CLUSTERS, TAG_KEYWORDS, AUTHOR_MAP) | ✅ unit-tested |
| 7 | `git-history.extractor` reads numstat with `\x1e` SEP at start of format (header+numstat stay together) | ✅ unit-tested with real on-disk repo |
| 8 | `repo-extract.extractor` skips `node_modules` / `.git`, caps at 1MB/file, 200 TODOs total | ✅ unit-tested |
| 9 | `planSpace` emits 4-folder scaffold + 7-status + Bugs override + sprint Lists per ISO week | ✅ unit-tested |
| 10 | `planSpace` strips conventional prefix from name to avoid `Feature(api): feat(api): foo` doubling | ✅ unit-tested |
| 11 | `planSpace` routes non-default-branch commits to `In Review` List | ✅ unit-tested |
| 12 | `planSpace` emits ADR tasks + bug-marker triage + truncation warning | ✅ unit-tested |
| 13 | `planSpace` emits file-level subtasks for high-impact commits, sorted by churn | ✅ unit-tested |
| 14 | Default Views: Active Sprint gets Board+Workload+Gantt; Sprint Lists get Board+Calendar | ✅ unit-tested |

## What's now possible (consumed in later sessions)

- **Session 4 (backfill orchestrator)**: takes a `SpacePlan` and walks it via `ClickUpDirectService` calls. Resumable via `task_index` lookups (rule #1).
- **Session 5 (lifecycle rewrite)**: `events.service` calls `planCommitTask`-style logic on each new commit; `task_index['commit:<sha>']` keys are exactly what `planSpace` emits.
- **Doc page seeding** is already wired — backfill just calls `createDocPage` for each of the 5 pages with the seeded markdown.

## Architectural decisions

- **planSpace lands alongside planRepo, not replacing it.** Session 4 swaps the caller; this PR is a no-op for the running daemon. Reduces blast radius of Session 3 review.
- **Conventional prefix stripping** added to commit-task naming so the BGMT format `[date] Type(scope): subject` doesn't double the prefix when subjects already include it (which they always do from `git log %s`).
- **ADR detection is path-based, not content-based.** Cheaper; matches `docs/adr/*.md`, `docs/decisions/*.md`, `docs/architecture/*.md`, top-level `ARCHITECTURE.md` / `ADR-*.md`. The actual ADR markdown is not inlined (would explode `markdown_content` for monorepo ADR sets) — task body links the file path + first-seen commit.
- **Tags are dynamic + static.** Static set (frontend/backend/infra/security/api/docs/testing/ai/i18n/database/general/adr/bug + 11 type:* + 7 source:*) is always emitted so the Space has filterable tags from day one. Per-commit epic:* tags are added dynamically from BGMT KEYWORD_CLUSTERS scoring.
- **estimateMinutes augmentation.** BGMT's pure 30-min fallback is augmented with locDelta (cap +210 min) and filesChanged (cap +60 min) bonuses. Total cap = 4 hours. Stays within the spirit of the BGMT fallback while making big-diff commits feel less trivialised.

## Open questions for next session

- The `In Review` List currently has no link back to the original branch — I'd like Session 5 to add a `branch:<name>` tag automatically on every commit task so the Board view groups by branch.
- For sprints that span 12+ months of history, the History folder will hold 50+ Lists. ClickUp's UI handles this fine, but the default order is "newest List first." We may want to set `orderindex` explicitly to make oldest-first or pin Active Sprint at the top.
- Doc page `Conventions` is hard-coded to a placeholder; should Session 4 read `CONTRIBUTING.md` / `CODE_OF_CONDUCT.md` from the repo and merge them?

## Blocked on

- PR #16 admin-merge after CI green (procedural).

## Files touched

- `service/src/util/iso-week.ts` (+ spec) — new
- `service/src/util/git-remote-parse.ts` (+ spec) — new
- `service/src/util/commit-url.ts` (+ spec) — new
- `service/src/util/classify.ts` (+ spec) — new (BGMT verbatim port)
- `service/src/extractors/git-history.extractor.ts` (+ spec) — new
- `service/src/extractors/repo-extract.extractor.ts` (+ spec) — new
- `service/src/extractors/extractors.module.ts` — new
- `service/src/bulk/types.ts` — added Space-model types (Session 3 block)
- `service/src/bulk/hierarchy.ts` — added `planSpace`, `SPACE_STATUSES`, `BUG_STATUSES`, `SPACE_FOLDERS`, `SPACE_FEATURES`, `STATIC_TAGS`, helpers
- `service/src/bulk/hierarchy.planSpace.spec.ts` — new (11 tests)

## Next session entry condition (Session 4 — backfill orchestrator)

1. PR #16 merged.
2. `ExtractorsModule` exports importable into `BackfillModule`.
3. `planSpace(repo, extract, history)` callable from any orchestrator code.
4. CARL `CLICKUP_TRACKER_REWRITE` domain shows the Session 3 closing decision with link to PR #16.
