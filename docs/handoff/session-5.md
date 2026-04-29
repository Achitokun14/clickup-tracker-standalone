# Handoff — Session 5

**Date:** 2026-04-29
**Plan:** `~/.claude/plans/sleepy-crunching-ember.md`
**Branch / commits / PRs:**
- PR #19 — `feat(events): per-repo Space lifecycle + ClickUp inbound webhook + scope_config` — open, CI in flight.

## Verification steps passed

| # | Step | Result |
|---|------|--------|
| 1 | `npx tsc --noEmit` | ✅ clean |
| 2 | `npx jest` | ✅ 14 suites, 152/152 pass (was 137/137) |
| 3 | New commit on default branch → sprint List + Done with native fields | ✅ unit-tested |
| 4 | Non-default branch → In Review List + In Review status | ✅ unit-tested |
| 5 | Sprint List missing → falls back to active_sprint List | ✅ unit-tested |
| 6 | TODO removal → real `setTaskStatus('Done')` (not comment-only) | ✅ unit-tested |
| 7 | scope_config subdir filter rejects non-tracked-path commits | ✅ unit-tested |
| 8 | scope_config subdir accepts commits touching tracked paths | ✅ unit-tested |
| 9 | Replay (same dedupe key) is idempotent | ✅ unit-tested |
| 10 | clickup-skip marker short-circuits emission | ✅ unit-tested |
| 11 | task_index['commit:<sha>'] blocks duplicate creates | ✅ unit-tested |
| 12 | ClickUpHmacGuard accepts valid HMAC, rejects missing/mismatch/no-secret/no-team | ✅ unit-tested (6 cases) |
| 13 | Backfilled commits and live commits go through identical planSpaceCommitTask | ✅ implemented (shared helper exported from hierarchy.ts) |
| 14 | Legacy 3-list projects fall back to comment-on-overview path | ✅ implemented |

## Architectural decisions

- **Single shared single-commit planner.** `planSpaceCommitTask()` is the public entry point; both `BackfillService` (Session 4) and `EventsService` (this session) use it. Live commits and backfilled commits look identical in ClickUp.
- **Lifecycle handler is self-contained — no tunnel needed for the outbound flow.** Bidirectional webhook (CU → daemon) is registered but only required if you want UI edits to flow back; the orchestrator and lifecycle work locally without any tunnel.
- **scope_config enforcement on the daemon side, not just the post-commit hook.** Plan §9 says BOTH layers should filter. The hook-side filter (early-out for cheap) is deferred to a follow-up — the authoritative filter runs on the daemon now, so security/correctness is uncompromised.
- **No webhook handler logic yet** — `clickup_inbound_events` rows are persisted and a `cup-sync` job is enqueued, but the worker doesn't yet do anything with the inbound payload. Deferred to Session 6 because the most useful side-effect (echoing UI status back to git as a comment) needs design discussion (loop avoidance, comment author attribution).
- **Merge-into-default heuristic is replan-bound.** The post-commit DTO doesn't carry parent SHAs, so we can't reliably resolve "which branch task to advance" from a merge commit alone. Logged at debug; the next replan reconciles. Session 6 can add a parents field to the DTO if needed.

## What's now possible (consumed in later sessions)

- **Session 6** (Time Entries + Dependencies + Views polish) can add `createTimeEntry` calls per `task.timeEntries` since the orchestrator already iterates planSpace tasks; lifecycle gets the same plumbing for free via `planSpaceCommitTask`.
- **Session 6** webhook handler: read `clickup_inbound_events`, resolve task→project via `task_index` reverse lookup (cache in memory), apply the inverse of taskStatusUpdated (e.g. UI moves task to Blocked → record + flag in `last_seen_status_changes`).
- **Session 7** (docs/runbook): `/public/clickup-events` endpoint is documented + tunnel guidance for localhost setups.

## Open questions for next session

- Webhook handler concrete behaviour: should UI status changes back-feed into a git-side artifact (e.g. open a `.todo` line in CHANGELOG) or stay read-only? Read-only is the safer default; user signal-out would be a bigger design call.
- `members_cache` lowercasing: ClickUp returns `User.email` mixed-case; `lower()` everywhere is fine but worth a smoke test.
- Should `last_seen_status_changes` cap at the last 100 (current implementation) or fold into a per-event-day rollup?

## Blocked on

- PR #19 admin-merge after CI green.
- Live smoke deferred to Session 8.

## Files touched

**New:**
- `service/src/clickup-webhooks/{module,controller,clickup-hmac.guard,clickup-hmac.guard.spec}.ts` (4 files)
- `service/src/events/events.service.spec.ts`

**Modified:**
- `service/src/bulk/hierarchy.ts` (export `planSpaceCommitTask`)
- `service/src/events/events.service.ts` (full rewrite of `ingestGit`)
- `service/src/events/events.controller.ts` (thread `X-CUP-Source` header)
- `service/src/app.module.ts` (register `ClickUpWebhooksModule`)

## Next session entry condition (Session 6 — Time Entries + Dependencies + Views polish + webhook handler)

1. PR #19 merged.
2. ClickUpHmacGuard available for the inbound worker handler.
3. Lifecycle handler routes to per-repo Space Lists; live commits land in their ISO-week sprint List.
4. CARL closing decision logged with PR #19 link.
