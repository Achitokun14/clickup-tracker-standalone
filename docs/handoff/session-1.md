# Handoff — Session 1

**Date:** 2026-04-28
**Plan:** `~/.claude/plans/sleepy-crunching-ember.md`
**Branch / commits / PRs:**
- PR #12 — `chore: add CODEOWNERS and stop drift cron from re-firing` — merged 2026-04-28T20:52Z
- PR #13 — `feat(schema): add per-repo Space tables and project columns` — merged 2026-04-28T20:56Z
- PR #14 — `fix(schema): move inbound-events dedup to a functional UNIQUE INDEX` — merged 2026-04-28T21:31Z

**CARL decisions logged (domain `CLICKUP_TRACKER_REWRITE`):**
- `clickup_tracker_rewrite-001` — adopted plan rev 3
- `clickup_tracker_rewrite-002` — idempotency model = DB `task_index`, not Custom Task IDs
- `clickup_tracker_rewrite-003` — default plan ships without custom fields; tags carry Type/Source/Epic
- `clickup_tracker_rewrite-004` — `archiveFolder()` is a no-op against ClickUp v2 (PUT silently drops `archived`)
- `clickup_tracker_rewrite-005` — drift cron stays no-op; daemon can't shell to `git log` from Docker
- `clickup_tracker_rewrite-006` — schema must be applied to live Postgres before merging the PR

## Verification steps passed

| # | Step | Result |
|---|------|--------|
| 1 | `npm test` (15 tests) | ✅ green |
| 2 | `npm run build` | ✅ clean |
| 3 | `archiveFolder` smoke against folder `901210785225` | ✅ confirmed no-op (use DELETE) |
| 4 | Schema applied to live Postgres `clickup_tracker_db` | ✅ all 8 columns + 2 tables + 4 indexes |
| 5 | Schema is idempotent (re-apply produces only "already exists" notices) | ✅ |

## Open questions for next session
- None blocking. PR #14 needs to land before Session 2 starts (it's an extra `CREATE UNIQUE INDEX` on top of the merged-but-broken `UNIQUE (...)` from PR #13).

## Blocked on
- Nothing. Session 1 complete.

## Files touched
- `.github/CODEOWNERS` (new)
- `service/src/sync/sync.service.ts` (semantic: 7-line replacement of `git_drift` branch in `handle()`; rest is formatter churn from PostToolUse hook)
- `schema/02_per_repo_space.sql` (new, then patched)
- `docker-compose.yml` (mount the new SQL file via initdb.d)

## Next session entry condition (Session 2 — ClickUp client extensions)
1. PR #14 merged.
2. Local Postgres has the corrected `clickup_inbound_events` table + `idx_inbound_dedup` UNIQUE index (already done).
3. CARL `CLICKUP_TRACKER_REWRITE` domain is `active` with the 7 plan rules + 6 decisions visible via `carl_v2_get_domain CLICKUP_TRACKER_REWRITE`.

## Notes for the next session author
- The PostToolUse:Edit hook reformats TS files (tabs + double quotes) on every Edit. The repo's existing code is mixed — `events.service.ts` is spaces+single, `projects.service.ts` is tabs+single. PRs touching TS files therefore carry a large whitespace+quote diff alongside the semantic change. Acknowledge in the PR body and move on; trying to fight the formatter wastes time.
- For schema changes: **always** `docker compose cp + psql -f` against the live local DB before pushing the PR. The PR-13 → PR-14 cycle exists because I didn't.
- CI required checks (set as branch protection): `service / node 20`, `service / node 22`, `docker compose build`. All three must pass before admin-merge is allowed.
- Self-approval is blocked by GitHub for the repo owner; use `gh pr merge --admin --squash --delete-branch` after CI is green.
