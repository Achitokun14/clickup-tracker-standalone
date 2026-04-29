# Handoff — Session 4

**Date:** 2026-04-29
**Plan:** `~/.claude/plans/sleepy-crunching-ember.md`
**Branch / commits / PRs:**
- PR #18 — `feat(backfill): per-repo Space orchestrator + control endpoints + MCP tools (Session 4)` — open, CI in flight.

**CARL decisions logged this session:** see closing decision after merge.

## Verification steps passed

| # | Step | Result |
|---|------|--------|
| 1 | `npx tsc --noEmit` (service + mcp) | ✅ clean |
| 2 | `npx jest` | ✅ 12 suites, 137/137 pass (was 133/133) |
| 3 | BackfillService walks SpacePlan end-to-end on fresh project | ✅ unit-tested (mocked ClickUpDirectService) |
| 4 | BackfillService is idempotent — second run creates zero new tasks | ✅ unit-tested |
| 5 | Backfill checkpointing in projects.backfill_state after every Sprint List | ✅ implemented (verified via FakePrisma calls) |
| 6 | POST /projects with backfillMode=space INSERTs placeholder + enqueues, returns immediately | ✅ implemented |
| 7 | Legacy backfillMode=legacy preserves existing planRepo behavior | ✅ unchanged |
| 8 | New control endpoints: backfill, replan, approve, reopen, assign, comment | ✅ implemented |
| 9 | MCP server exposes 14 tools (8 original + 6 new); 3 modified for new shapes | ✅ implemented |
| 10 | 6 new slash commands mirrored in claude-code + opencode | ✅ implemented |
| 11 | wipe-and-rereg.sh: DELETE → POST → poll backfill_state | ✅ implemented |

## Architectural decisions

- **`backfillMode` DTO flag, not env switch.** Lets the same daemon serve old + new flows; users opt in per-registration. wipe-and-rereg.sh always sets `backfillMode=space`. Default of `space` for new registrations is kept; existing live project untouched until explicitly wiped + re-registered.
- **No circular module dep.** ProjectsService enqueues directly via QueueService (`addJob('cup-backfill', …)`), avoiding the obvious BackfillService injection that would create ProjectsModule ↔ BackfillModule cycle. BackfillService picks up the enqueued job in its `cup-backfill` worker.
- **Best-effort `Doc` + `Views` + `setSpaceStatuses`.** ClickUp v3 Doc parent type ints and v2 status PUT shapes have known sparse documentation; failures are logged at debug and don't abort the run. This trades partial-functionality risk for orchestrator robustness on first contact with the live API.
- **Members cache TTL = 24 h.** First run populates `workspace_settings.members_cache`; subsequent runs short-circuit. Refresh cadence acceptable since workspaces don't churn members hourly.
- **Idempotency key = `task_index[task.key]`.** Custom Task IDs aren't a body field on createTask (verified Session 1); DB-side index is the only reliable mechanism.
- **Checkpoint cadence = every Sprint List or every 25 tasks.** Mid-sprint crash loses ≤25 tasks of work (~30 s of API calls).

## What's now possible (consumed in later sessions)

- **Session 5** (lifecycle rewrite): `events.service` reuses `task_index['commit:<sha>']` from the orchestrator. New commits can land directly into the active sprint List using the same key scheme.
- **Session 5** (bidirectional webhook): `BackfillService.ensureMembers` already populates `workspace_settings.members_cache`; webhook handler can resolve task→project via reverse `task_index` lookup (cache to add).
- **Session 6** (Time Entries): orchestrator already calls `setTaskStatus`/`assignTask`/etc. — adding `createTimeEntry` per `task.timeEntries` is a 5-line addition.
- **Session 7** (docs): rate-limited orchestrator metrics flow through existing `cup_clickup_*` Prometheus counters once they're registered.

## Open questions for next session

- ClickUp Doc API v3 — `parent.type: 4` is my guess for "Space". If `createDoc` 4xx's in live smoke, swap to `7` (Workspace) and put the Doc at workspace level instead. The orchestrator's debug log will surface the error message.
- `setListStatuses` for Bugs override may collide with the Space-level cascade — need live test to confirm whether the override sticks or gets overwritten.
- `assignTask` needs verification that the `members_cache` keys lowercase correctly across all email cases (Workspaces sometimes return capitalised emails).

## Blocked on

- PR #18 admin-merge after CI green.
- Live smoke (§22 step 4: wipe-and-rereg standalone repo) deferred to Session 8.

## Files touched

**New:**
- `service/src/backfill/{module,service,controller,service.spec}.ts`
- `scripts/wipe-and-rereg.sh`
- `agents/{claude-code,opencode}/commands/clickup-{backfill-status,replan,approve,reopen,assign,comment}.md` (12 files)

**Modified:**
- `service/src/app.module.ts` (register BackfillModule)
- `service/src/projects/dto/register-project.dto.ts` (new `backfillMode` field)
- `service/src/projects/projects.module.ts` (import QueueModule)
- `service/src/projects/projects.service.ts` (new `registerSpaceMode` branch + QueueService injection)
- `mcp/src/server.ts` (6 new tools + 3 modified)
- `agents/{claude-code,opencode}/commands/clickup.md` (surface backfill state when ongoing)
- `agents/{claude-code,opencode}/commands/clickup-add.md` (new response shape + backfillMode)

## Next session entry condition (Session 5 — lifecycle rewrite + bidirectional webhook + scope_config)

1. PR #18 merged.
2. `BackfillService` accessible from anywhere via `BackfillModule`.
3. `cup-backfill` queue active; `task_index` keys (`commit:<sha>`, `bug:<sha>:<file>:<line>`, `adr:<slug>`, `session:<id>`) the canonical idempotency keys.
4. CARL closing decision logged with PR #18 link.
