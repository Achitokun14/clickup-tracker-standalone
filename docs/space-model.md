# Per-repo Space model

Every registered repository becomes its **own ClickUp Space**. The daemon's
backfill orchestrator (`service/src/backfill/backfill.service.ts`) walks the
output of `planSpace()` and creates the Space, four Folders, sprint-bucketed
Lists, a 5-page Doc, default Views, and one task per commit.

## Structure

```
Space: <repo-display-name>
  features: due_dates, time_tracking, tags, time_estimates, checklists,
            custom_fields, dependency_warning, sprints, points, milestones
  custom statuses (Space-level cascade):
    Backlog → To Do → In Progress → In Review → Blocked → Done → Archived

  📦 Backlog & Bugs
    └ Open Work          (TODOs from code; default view: Board grouped by status)
    └ Bugs               (FIXMEs + reported bugs; status override:
                          Reported → Triaged → Fixing → Verifying → Closed → Won't Fix)
  🚧 Active Work
    └ Active Sprint      (current ISO-week's commits; views: Board, Workload, Gantt)
    └ In Review          (commits on non-default branches; close-on-merge)
  📜 History (auto-backfilled)
    └ Sprint 1  — 2024-01-08 → 2024-01-14   (47 tasks)
    └ Sprint 2  — 2024-01-15 → 2024-01-21   (32 tasks)
    └ ...
    └ Sprint N  — current ISO week
  📚 Knowledge
    └ ADRs               (one task per ADR file; sorted by date)
    └ Agent Sessions     (one task per session_id, comments per turn;
                          grouped by Source tag)

  Doc (Space-attached, v3): "<repo> Handbook"
    Page: Overview            (README excerpt + stack + remote + space stats)
    Page: Setup               (extracted from README setup section)
    Page: Conventions         (CONTRIBUTING.md / CODE_OF_CONDUCT.md merged)
    Page: Changelog           (CHANGELOG.md mirrored, auto-updated on commit)
    Page: Agent Prompt Log    (rolling, last 50 sessions)
```

## Native fields populated for every commit task

| Field | Source | Notes |
|---|---|---|
| `name` | BGMT-format | `[YYYY-MM-DD] <Type>(<scope>): <subject>` (conventional prefix stripped) |
| `markdown_content` | BGMT description template | Contributor + impact + key files (Appendix B in plan) |
| `status` | branch + lifecycle | `Done` (merged on default), `In Review` (non-default), `Backlog` (TODO) |
| `priority` | BGMT `assign_priority` | 1=Urgent / 2=High / 3=Normal / 4=Low |
| `tags` | BGMT `derive_tags` | from TAG_KEYWORDS dict + namespaced `type:`, `source:`, `epic:` |
| `points` | LOC delta heuristic | `Math.max(1, Math.ceil((additions+deletions)/100))` |
| `time_estimate` (ms) | BGMT fallback | 30 min × locDelta+filesChanged bonuses, capped at 4 h |
| `start_date` (ms) | author date epoch | |
| `due_date` (ms) | commit date epoch | |
| `assignees` | author email → `members_cache` lookup | only if email maps to a workspace member |
| `parent` | for file-level subtasks | when commit touches >3 files (cap top 10 by churn) |

## Idempotency

Every entity write checks `projects.task_index[<key>]` first. If the key
already maps to a ClickUp id, the write is skipped. Keys:

- `commit:<sha>` → ClickUp task_id for the commit task
- `bug:<sha>:<file>:<line>` → bug task
- `adr:<slug>` → ADR task
- `session:<session_id>` → Agent Sessions task
- `todo:<file>:<line>` → Open Work task

## Resumability

`projects.backfill_state` is checkpointed after every Sprint List, or every
25 tasks (whichever first). Schema:

```jsonc
{
  "status":      "queued | running | done | failed",
  "processed":   1234,
  "total":       1500,
  "last_sha":    "abc1234…",
  "last_list":   "sprint:2026-W17",
  "started_at":  "2026-04-29T01:23:45Z",
  "finished_at": "2026-04-29T01:31:02Z",
  "space_url":   "https://app.clickup.com/<team>/v/s/<space>",
  "folder_url":  "https://app.clickup.com/<team>/v/li/<active_sprint_list>",
  "error_message": null
}
```

If the worker dies mid-import, the next backfill run picks up where it left
off. `task_index` lookups guarantee no duplicate creates even if the
checkpoint is stale.

## Tag taxonomy

Pre-created on the Space before any task lands:

- **Static**: `frontend`, `backend`, `infra`, `database`, `security`, `ai`,
  `i18n`, `api`, `docs`, `testing`, `general`, `adr`, `bug`
- **Type**: `type:feature`, `type:bug-fix`, `type:refactor`, `type:docs`,
  `type:chore`, `type:style`, `type:performance`, `type:test`, `type:build`,
  `type:ci-cd`, `type:revert`
- **Source**: `source:human`, `source:claude-code`, `source:goose`,
  `source:opencode`, `source:cursor`, `source:cline`, `source:continue`
- **Epic**: `epic:<auth-security|api-backend|…>` — added per-task by
  `classifyEpic()` scoring.

## Performance budget

For the standalone repo (~80 commits): backfill ≈ 250 calls ≈ 3 min on the
default 90 req/min token bucket. For 5000-commit repos the cap, ~12 000
calls ≈ 2.5 h on Free tier or ~14 min on Business Plus. Documented at
`docs/runbook.md#backfill-stuck-at-running`.

## Bidirectional sync

`POST /public/clickup-events` accepts ClickUp's outbound webhook deliveries.
HMAC-SHA256 of the raw body using `workspace_settings.webhook_secret`.
Persists into `clickup_inbound_events` (dedup on `(team_id,
webhook_event_id, history_item_id)`), then enqueues a `cup-sync` job. The
worker reverse-resolves task→project via `projects.task_index` and bumps
`projects.last_seen_status_changes` (capped at 100 entries).

For localhost-only setups, the daemon is reachable via tunnel — Cloudflare
Tunnel, ngrok, or Tailscale Funnel. Without a tunnel, register the webhook
anyway: deliveries fail-closed, but the rest of the system works.
