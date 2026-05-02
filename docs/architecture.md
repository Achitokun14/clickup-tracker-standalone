# Architecture

clickup-tracker is a self-hosted Docker daemon (NestJS + Postgres + Redis) that turns local git activity into structured ClickUp output. As of v0.4.0 it ships:

- **Per-repo CU Spaces** with a 4-folder hierarchy + a Doc handbook
- **Autonomous SCRUM operator** — Sprint planner, daily groomer, standup/retro reporter
- **Multi-developer adoption** — multiple developers' daemons can share one workspace without duplicating tasks
- **Native CU surfaces** — colored space tags, custom fields, multi-view seeds, sprint Goals, watchers, structured @-mentions
- **GitHub identity bridge** — commit author email → cached GitHub login/avatar/profile, surfaced on tasks + standup pages

This doc covers the system layout. For per-feature deep-dives see:

- [`scrum-operator.md`](./scrum-operator.md) — Sprint planner, groomer, reporting
- [`multi-developer.md`](./multi-developer.md) — adoption + per-dev secret model
- [`github-identity.md`](./github-identity.md) — Phase F bridge
- [`custom-fields-and-views.md`](./custom-fields-and-views.md) — Phase E schema + view set
- [`scrum-tracked-artifacts.md`](./scrum-tracked-artifacts.md) — what makes it into CU
- [`roadmap.md`](./roadmap.md) — v0.5.0 (Phases I-N) preview

---

## High-level component diagram

```mermaid
graph TB
  subgraph host["Developer host (Linux / macOS / Windows)"]
    repo[("tracked repo<br/>.git/hooks/post-commit<br/>.git/hooks/pre-push")]
    agent["Coding agent<br/>(Claude Code / Goose / OpenCode)"]
    mcp["MCP shim<br/>mcp/dist/server.js<br/>(stdio)"]
  end

  subgraph compose["docker compose"]
    daemon["clickup-tracker daemon<br/>NestJS · port 4020<br/>BullMQ · @Cron schedulers"]
    pg[("postgres<br/>cup_pgdata")]
    redis[("redis<br/>cup_redisdata")]
  end

  cu["ClickUp REST API<br/>v2 + v3"]
  gh["GitHub REST API<br/>(F.1)"]

  repo -->|"HMAC POST<br/>/public/git-events"| daemon
  agent -->|"Stop hook<br/>/public/prompt-events"| daemon
  agent -->|"slash commands"| mcp
  mcp -->|"HTTP"| daemon
  daemon <-->|"queues + idempotency"| redis
  daemon <-->|"projects, git_events,<br/>scrum_audit, github_identities"| pg
  daemon -->|"createTask, addComment,<br/>createGoal, …"| cu
  daemon -->|"author resolve"| gh
  cu -.->|"webhooks (status_changed,<br/>taskCommentPosted)"| daemon
```

---

## Three event sources

```mermaid
graph LR
  git_hook["post-commit hook<br/>(per-repo)"] -->|"HMAC<br/>/public/git-events"| daemon
  agent_hook["agent Stop hook"] -->|"HMAC<br/>/public/prompt-events"| daemon
  cu_webhook["CU webhook<br/>(per-team)"] -->|"HMAC verified by<br/>WorkspaceSettings.webhook_secret"| daemon
  drift["drift cron<br/>5min"] -.->|"reconciles missed events"| daemon
  daemon["clickup-tracker"]
```

Every entry-point returns `200 OK` within ~50ms. Heavy work is enqueued and processed by BullMQ workers — the request never blocks on the ClickUp API.

---

## Sequence: git commit → CU task (full v0.4.0 path)

```mermaid
sequenceDiagram
  autonumber
  participant Dev as Developer
  participant Git as git
  participant Hook as post-commit hook
  participant Daemon as clickup-tracker
  participant Q as BullMQ
  participant DB as Postgres
  participant Limiter as RateLimiter (3-tier)
  participant CU as ClickUp
  participant GH as GitHub API

  Dev->>Git: git commit
  Git->>Hook: synchronous fire
  Hook->>Daemon: POST /public/git-events (HMAC)
  Daemon->>DB: INSERT git_events ON CONFLICT (clickup_team_id, sha)
  Note right of DB: Multi-dev dedupe<br/>(B.4 partial unique)
  Daemon-->>Hook: 200 OK
  Hook-->>Git: exit 0
  Git-->>Dev: commit complete

  Daemon->>Q: enqueue commit-handler
  Q->>Daemon: dequeue
  Daemon->>Limiter: acquire(token, 'normal')
  Daemon->>CU: createTask in sprint List
  CU-->>Daemon: 201 + taskId

  par Custom fields (E.1 + F.3)
    Daemon->>GH: GET /repos/.../commits/{sha}
    GH-->>Daemon: { author.login, avatar_url }
    Daemon->>DB: UPSERT github_identities
    Daemon->>CU: setCustomFieldValue × {commit_sha, author_email,<br/>author_github_url, source}
  and Watcher (E.5)
    Daemon->>DB: SELECT members_cache
    Daemon->>CU: addWatcher(taskId, userId)
  and Artifact watch (C.5)
    Daemon->>CU: addComment listing<br/>infra/dep/doc/ADR files
  end

  alt cc.type == "fix" with scope match
    Daemon->>CU: setStatus('Done') on linked bug task
  else cc.type == "feat" with scope match
    Daemon->>CU: setStatus('Done') on linked open-work task
  end

  Daemon->>CU: append commit to Doc Changelog page
```

---

## Sequence: AI agent Stop hook → prompt task

```mermaid
sequenceDiagram
  participant Agent as Coding agent
  participant Stop as Stop hook
  participant Daemon as clickup-tracker
  participant CU as ClickUp

  Agent->>Stop: end-of-turn (transcript path, cwd, session id)
  Stop->>Daemon: GET /projects/resolve?path=<cwd>
  Daemon-->>Stop: { match: { id, displayName, … } }
  alt match is null
    Stop-->>Agent: exit 0 (no-op)
  else match
    Stop->>Stop: extract files-touched + outcome from transcript
    Stop->>Daemon: POST /public/prompt-events (HMAC)
    Daemon->>CU: createTask under Knowledge → Agent Sessions
  end
```

---

## Per-repo CU Space layout (since v0.2.x)

Each registered project owns one ClickUp Space. The Space is auto-scaffolded with 4 emoji-prefixed folders, a Doc handbook, and (since v0.4.0) seeded views + custom fields.

```mermaid
graph TD
  Space["📁 Space: <repo-name>"]
  subgraph BACKLOG["📦 Backlog & Bugs"]
    OW["Open Work"]
    BUGS["Bugs"]
  end
  subgraph ACTIVE["🚧 Active Work"]
    AS["Active Sprint"]
    IR["In Review"]
  end
  subgraph HISTORY["📜 History"]
    HO["Overview"]
    SP1["Sprint 2026-W17"]
    SP2["Sprint 2026-W18"]
  end
  subgraph KNOWLEDGE["📚 Knowledge"]
    ADR["ADRs"]
    AGENT["Agent Sessions"]
  end
  Doc["📓 Doc: <repo> Handbook<br/>(Overview · Setup · Conventions ·<br/>Changelog · Standups · Retros)"]

  Space --> BACKLOG
  Space --> ACTIVE
  Space --> HISTORY
  Space --> KNOWLEDGE
  Space --> Doc
```

Sprint history Lists accumulate week-over-week (one List per ISO week). The Doc handbook is the long-form companion: standup notes, retros, ADRs.

---

## Schema overview (current)

```mermaid
erDiagram
  organisations ||--o{ projects : owns
  organisations ||--|| organisation_credentials : "1 token per workspace"
  projects ||--o{ git_events : "post-commit"
  projects ||--o{ prompt_events : "agent Stop"
  projects ||--o{ scrum_audit : "every autonomous action"
  projects ||--o{ backups : "pre-risky-op snapshots"
  workspace_settings ||--o{ projects : "members_cache + webhook"
  github_identities ||--o{ git_events : "joined by lower(email)"

  projects {
    uuid id PK
    text local_path
    text display_name
    text clickup_space_id
    jsonb list_ids
    jsonb sprint_lists
    jsonb task_index
    jsonb custom_field_ids
    jsonb scrum_goals
    jsonb scrum_config
    text status "active|paused|orphaned|auth-needed"
    timestamptz last_sprint_plan_at
    timestamptz last_groom_at
    timestamptz last_standup_at
    timestamptz last_retro_at
  }
  github_identities {
    text email PK
    text github_login
    text github_url
    text avatar_url
    timestamptz resolved_at
    text source
  }
  scrum_audit {
    uuid id PK
    uuid project_id FK
    text kind "plan_sprint|groom|standup|retro|…"
    text target
    jsonb before
    jsonb after
    text reason
    bool dry_run
  }
```

See `schema/init.sql`, `schema/02_per_repo_space.sql`, `schema/03_collab_and_scrum.sql`, `schema/04_visual_richness.sql`.

---

## Rate limiting (3-tier priority queue)

ClickUp hard-limits at 100 req/min/token. The in-house token-bucket limiter (`service/src/clickup/rate-limiter.ts`) enforces this with three priority levels:

```mermaid
graph LR
  urgent["urgent<br/>(operator-triggered)"] --> bucket{token bucket}
  normal["normal<br/>(lifecycle: commits, agents)"] --> bucket
  scrum["scrum<br/>(sprint planner, groomer,<br/>reporting crons)"] --> bucket
  bucket -->|"strict priority<br/>urgent > normal > scrum"| api[ClickUp API]
```

Priority is propagated via `AsyncLocalStorage` (`service/src/clickup/priority-context.ts`) so HTTP handlers can wrap a callable in `runWithPriority('urgent', fn)` without threading the priority through every wrapper signature.

---

## Auth model

| Surface | Auth | Notes |
|---|---|---|
| Internal `/projects/*`, `/scrum/*` | Static bearer (`STANDALONE_API_TOKEN`) | Required when exposed beyond localhost |
| Public `/public/git-events`, `/public/prompt-events` | Per-project HMAC-SHA256 (`hook_secret`) | One secret per project; cached client-side at `~/.config/clickup-tracker/projects/<id>.secret` |
| Public `/public/clickup-webhook` | HMAC verified by `workspace_settings.webhook_secret` | One per CU workspace (multi-dev share) |
| `/public/metrics` | Optional bearer (`METRICS_AUTO_TOKEN`) | Independent rotation; for Prometheus |
| `/health`, `/public/openapi.yaml` | Open | Liveness + self-doc |
| GitHub fetch (F.1) | `GITHUB_TOKEN` env (optional) | Lifts unauth 60/h to authed 5000/h |

---

## Degradation modes

```mermaid
graph TD
  start([daemon boot]) --> redis_check{Redis<br/>reachable?}
  redis_check -->|yes| async[BullMQ async mode]
  redis_check -->|no| inline[Inline-degraded mode<br/>cup_inline_processed_total++]
  async --> ratelimit_check{ClickUp 5xx /<br/>rate-limit storm?}
  ratelimit_check -->|burst| backoff[Exponential backoff<br/>1s → 16s, 5 attempts]
  ratelimit_check -->|persistent| persist[Job stays queued;<br/>retried on restart]
  inline --> still_works[Throughput drops<br/>but no events lost]
  daemon_401[ClickUp 401 from a project] --> auth_needed[Status flip → auth-needed<br/>Warning task posted]
  github_429[GitHub rate-limit nearly out] --> halt[Halt new fetches 60s<br/>Cache hits still served]
```

---

## What's next

v0.5.0 (Phases I-N) brings deeper collaboration tracking, quality signals, full GitHub webhook ingestion, and Railway deployment mirroring. See [`roadmap.md`](./roadmap.md).
