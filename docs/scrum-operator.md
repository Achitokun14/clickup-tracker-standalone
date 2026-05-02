# Autonomous SCRUM Operator

The daemon runs four autonomous scrum ceremonies on a schedule, plus a continuous lifecycle layer that reacts to every commit and webhook. All actions are **reversible**, **audited**, **dry-runnable**, and **killable**.

This doc covers the v0.3.0+ SCRUM operator. For what makes it into CU as a result, see [`scrum-tracked-artifacts.md`](./scrum-tracked-artifacts.md).

---

## Ceremony schedule (default)

```mermaid
gantt
  title Scrum operator weekly cadence (UTC)
  dateFormat HH:mm
  axisFormat %H:%M
  section Daily
  Groomer (06:00)            :done, g1, 06:00, 5m
  Standup (08:30 Tue–Fri / 09:00 Mon) :done, s1, 08:30, 10m
  section Sprint cycle
  Sprint plan (Mon 08:00)    :done, p1, 08:00, 15m
  Retro (Sun 18:00)          :done, r1, 18:00, 15m
```

Override via `scrum_config` per project (POST `/projects/:id/scrum/config`):

```json
{
  "tz": "Europe/London",
  "plan_cron": "0 8 * * 1",
  "groom_cron": "0 6 * * *",
  "standup_cron_weekdays": "30 8 * * 2-5",
  "standup_cron_monday": "0 9 * * 1",
  "retro_cron": "0 18 * * 0",
  "skip_weekends": true,
  "holidays": ["2026-12-25"]
}
```

Master poll runs every 5 min via `ScrumScheduler` (`service/src/scrum/scrum.scheduler.ts`); per-project crons fire when their UTC-aware "next time" has passed and idempotency check confirms not-yet-run.

---

## The 7 autonomy invariants

```mermaid
graph LR
  A([Reversible]) --- B([Audited])
  B --- C([Dry-runnable])
  C --- D([Killable<br/>CUP_AUTOSCRUM=off])
  D --- E([Idempotent within window])
  E --- F([Rate-limit-aware<br/>'scrum' priority])
  F --- G([Single-leader<br/>per workspace])
```

- **Reversible** — no `delete` / hard archive. Status='Closed' + tag instead.
- **Audited** — every action emits a `scrum_audit` row.
- **Dry-runnable** — every endpoint accepts `?dryRun=true`.
- **Killable** — `CUP_AUTOSCRUM=off` env disables ALL crons.
- **Idempotent within window** — `last_*_at` + idempotency key (sprint=isoWeek, standup=date).
- **Rate-limit-aware** — every cron call uses `'scrum'` priority on the limiter, so lifecycle traffic preempts under contention.
- **Single-leader per workspace** — `pg_try_advisory_xact_lock(team_id_hash, ceremony_hash)`; followers skip silently.

---

## C.1 — Sprint planner

```mermaid
flowchart TD
  start([Mon 08:00 tick]) --> idem{last_sprint_plan_at<br/>this iso_week?}
  idem -->|yes| skip([skipped: already_planned_this_week])
  idem -->|no| velocity[Compute velocity<br/>= mean of last 4 closed sprints]
  velocity --> warm{enough history?}
  warm -->|no| seed[Use default_velocity_points = 8]
  warm -->|yes| budget[budget = velocity points + count]
  seed --> carry
  budget --> carry[Add carryover from current sprint List]
  carry --> bug["Add up to bug_ceiling_pct × velocity bugs<br/>sorted by severity desc, age desc"]
  bug --> open["Add top open work by priority + churn"]
  open --> goal[Infer goal = mode of selected epics]
  goal --> dryrun{dryRun?}
  dryrun -->|true| return_plan([Return plan, no mutations])
  dryrun -->|false| sprint_list[ensureSprintList<br/>Sprint N — YYYY-MM-DD → YYYY-MM-DD]
  sprint_list --> move[Move each selected task → sprint List]
  move --> goal_create["createGoal + createKeyResult<br/>(automatic, linked to sprint List)"]
  goal_create --> persist[Persist last_sprint_plan_at,<br/>velocity_window, scrum_goals]
  persist --> audit[scrum_audit row<br/>kind=plan_sprint]
```

Source: `service/src/scrum/sprint-planner.service.ts`. Goal creation (E.4) is best-effort — failures don't block planning.

---

## C.2 — Daily groomer

```mermaid
flowchart LR
  tick([Daily 06:00]) --> rules{Per-rule<br/>scrum_config.groom.*}
  rules --> dedupe["Dedupe<br/>jaccard ≥ 0.8 + files overlap<br/>→ tag duplicate-of"]
  rules --> bump["Stale-bug bump<br/>age > 7d → priority +1"]
  rules --> shame["Stale-bug shame<br/>age > 30d → tag stale-bug"]
  rules --> churn["Churn re-prioritise<br/>≥3 events / 14d on file"]
  rules --> hotspot["Hotspot promote<br/>file ≥3 changes / 7d<br/>→ new Open Work task"]
  rules --> zombie["Zombie archive (off by default)<br/>no activity 90d → setStatus('Closed')"]
  dedupe & bump & shame & churn & hotspot & zombie --> triage[Daily Triage task<br/>posted in Open Work]
  triage --> audit[scrum_audit row<br/>kind=groom + per-rule]
```

Source: `service/src/scrum/groomer.service.ts`. Each rule is independently togglable in `scrum_config.groom.{dedupe,stale_bug_bump,…}`.

---

## C.4 — Standup + Retro reporter

```mermaid
sequenceDiagram
  participant Cron as ScrumScheduler
  participant R as ReportingService
  participant DB as Postgres
  participant CU as ClickUp

  Cron->>R: tryStandup(project)
  R->>DB: idempotency check<br/>(last_standup_at = today UTC?)
  DB-->>R: false
  R->>DB: SELECT git_events last 24h, group by author
  R->>DB: SELECT github_identities WHERE email = ANY(...)
  Note right of R: F.2 — identity-aware headers
  R->>CU: fetchTasks(active sprint List)
  R->>CU: fetchTasks(bugs List, filter blockers)
  R->>R: renderStandupMd<br/>(per-author + sprint progress + blockers)
  R->>CU: createDocPage("Standup — YYYY-MM-DD")
  R->>DB: UPDATE last_standup_at = NOW()
  R->>DB: INSERT scrum_audit kind=standup
```

Source: `service/src/scrum/reporting.service.ts`. Retro mirrors this on Sunday 18:00 — pulls velocity_window for sparkline (Phase G.2), bug throughput, carryover analysis.

---

## C.3 — Continuous lifecycle layer (real-time, not cron)

Triggered by `POST /public/git-events` (post-commit hook) and `POST /public/clickup-webhook` (CU outbound). Runs *inline* per event.

```mermaid
flowchart TD
  in([git event]) --> route{branch?}
  route -->|default| sprint[Add to current sprint List]
  route -->|feature| review[Add to In Review]
  sprint --> dispatch
  review --> dispatch{cc.type}
  dispatch -->|fix scope=X| close_bug[Close bug task scope=X]
  dispatch -->|feat scope=X| close_open[Close open-work task scope=X]
  dispatch -->|refactor old→new| rename[Cross-link old + new tasks<br/>tag scope-renamed]
  in --> file_loop[For each file_changed]
  file_loop --> classify{classify path}
  classify -->|adr/doc/infra/dep| watch[Bundled comment on commit task]
  classify -->|generated| skip([skip])
  classify -->|status=R| rename_anno[Bundled rename annotation]
  classify -->|status=D| close_anchored[Close path-anchored task]
  in --> branch_del{branch_deleted?}
  branch_del -->|yes| close_review[Close all In-Review tasks for branch]
  in --> author[Resolve commit author]
  author --> watcher[addWatcher on new task]
  author --> id_resolve[GithubIdentity.resolve<br/>F.1]
  id_resolve --> custom_fields[setCustomFieldValue ×<br/>commit_sha, author_email,<br/>author_github_url, source]
```

Source: `service/src/events/events.service.ts`.

---

## Audit trail

Every autonomous action writes a row to `clickup_tracker.scrum_audit`. Operator-readable via:

```bash
curl -fsS -H "Authorization: Bearer $AUTH" -H "X-Organisation-Id: $ORG" \
  "$BASE/projects/$PID/scrum/audit?since=$(date -d '7 days ago' -Iseconds)&limit=100"
```

Schema:

| Column | Purpose |
|---|---|
| `kind` | `plan_sprint`, `plan_sprint:move`, `groom`, `groom:dedupe`, `standup`, `retro`, … |
| `target` | task_id, list_id, or null for cross-cutting |
| `before` / `after` | JSONB diffs |
| `reason` | Human-readable (e.g. `"carryover"`, `"warming up — no history"`) |
| `dry_run` | True for `?dryRun=true` invocations |

---

## Single-leader concurrency

When two daemons run against the same workspace (multi-developer mode — see [`multi-developer.md`](./multi-developer.md)), only one runs each scrum tick:

```mermaid
sequenceDiagram
  participant D1 as Daemon A
  participant D2 as Daemon B
  participant PG as Postgres

  par 06:00 tick
    D1->>PG: pg_try_advisory_xact_lock(team_hash, 'scrum:groom')
    D2->>PG: pg_try_advisory_xact_lock(team_hash, 'scrum:groom')
  end
  PG-->>D1: true (lock acquired)
  PG-->>D2: false
  D1->>D1: run groomer logic
  D2->>D2: log "skipped: not_leader"
  D1->>PG: COMMIT (lock auto-released)
```

Lock is **transaction-scoped** for short ceremonies (groom, standup, retro) so a crashed leader's lock auto-releases. Sprint planner uses session-scoped lock with explicit unlock on completion (its long ClickUp API window would hold the txn open too long otherwise).

Source: `service/src/scrum/leadership.service.ts`.

---

## Tunables (full `scrum_config` shape)

```json
{
  "enabled": true,
  "tz": "Europe/London",
  "plan_cron": "0 8 * * 1",
  "groom_cron": "0 6 * * *",
  "standup_cron_weekdays": "30 8 * * 2-5",
  "standup_cron_monday": "0 9 * * 1",
  "retro_cron": "0 18 * * 0",
  "skip_weekends": true,
  "holidays": [],
  "bug_ceiling_pct": 0.30,
  "velocity_window_size": 8,
  "velocity_window_recent": 4,
  "default_velocity_points": 8,
  "groom": {
    "dedupe": true,
    "stale_bug_bump": true,
    "stale_bug_shame": true,
    "churn_reprioritise": true,
    "hotspot_promote": true,
    "zombie_archive": false
  },
  "members_offboarded": []
}
```

PATCH any subset via `PATCH /projects/:id/scrum/config` — deep-merged.

---

## Killing the operator

| Scope | How |
|---|---|
| All projects, all daemons | `export CUP_AUTOSCRUM=off` then `docker compose restart clickup-tracker` |
| One project | `PATCH /projects/:id/scrum/config` with `{ "enabled": false }` |
| One ceremony, one project | `PATCH /projects/:id/scrum/config` with e.g. `{ "groom": { "hotspot_promote": false } }` |
| Manual override (dry-run) | `POST /projects/:id/scrum/{plan-sprint,groom,standup,retro}?dryRun=true` |
