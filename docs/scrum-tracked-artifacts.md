# What the SCRUM operator surfaces in CU

The "everything that should be tracked" catalog. This doc is a reference for what kinds of artifacts the daemon surfaces in ClickUp, where they appear, and how they're classified.

If you're trying to understand *why* a particular file/event/change shows up (or doesn't), you're in the right place.

---

## Pipeline at a glance

```mermaid
flowchart LR
  subgraph sources["Event sources"]
    s1[git commit]
    s2[agent Stop hook]
    s3[CU outbound webhook]
    s4["Drift cron (5min)"]
    s5["Scrum crons (planner/<br/>groomer/standup/retro)"]
  end
  classify[classifyArtifact<br/>per file in commit]
  pipeline[events.service<br/>+ scrum services]
  surfaces["CU surfaces:<br/>tasks · comments · tags ·<br/>custom fields · doc pages ·<br/>goals · views · watchers"]

  s1 & s2 & s3 & s4 & s5 --> pipeline
  s1 --> classify
  classify --> pipeline
  pipeline --> surfaces
```

---

## Per-event-source artifact catalog

### git commit (post-commit hook)

```mermaid
graph TD
  c[git commit arrives] --> sprint[Sprint List task<br/>or In Review task]
  c --> changelog[Append to Doc 'Changelog' page<br/>if default branch]
  c --> watcher[addWatcher: commit author]
  c --> fields["Custom fields:<br/>commit_sha, author_email,<br/>author_github_url, source"]
  c --> identity[github_identities cache hydrate]
  c --> per_file[For each file_changed]

  per_file --> kind{classify}
  kind --> generated[(generated)<br/>suppress]
  kind --> code[(code)<br/>no extra action]
  kind --> adr[(ADR)<br/>bundled comment + future ADR task]
  kind --> doc["(doc · README/CHANGELOG/<br/>docs/*.md)<br/>bundled comment in commit task"]
  kind --> infra["(infra · Dockerfile, k8s,<br/>workflows, terraform)<br/>bundled comment + tag infra-change"]
  kind --> dep["(dependency · package.json,<br/>pyproject, Cargo, …)<br/>bundled comment"]
  kind --> cfg["(config-schema · .env.example,<br/>*.schema.json)<br/>bundled comment"]
  kind --> sub[(submodule)<br/>bundled comment]
  kind --> bin["(binary-resource ·<br/>>100KB or img/font/zip)<br/>size-only comment"]
  kind --> rename[("status=R (rename)")<br/>bundled rename annotation]
  kind --> delete[("status=D (delete)")<br/>close path-anchored task]

  c --> conv{conventional<br/>commit type}
  conv --> fix[fix scope=X →<br/>close bug task scope=X]
  conv --> feat[feat scope=X →<br/>close open-work task scope=X]
  conv --> ref[refactor old→new →<br/>cross-link old + new tasks]
  conv --> bug_word[message contains 'BUG-N' →<br/>cross-link to BUG-N task]
```

Source: `service/src/events/events.service.ts` + `service/src/util/classify.ts`.

### agent Stop hook (Claude Code, Goose, OpenCode, …)

```mermaid
graph TD
  s[Agent end-of-turn] --> resolve[GET /projects/resolve?path=cwd]
  resolve --> match{matched?}
  match -->|no| skip([no-op])
  match -->|yes| extract[Extract files-touched + outcome<br/>from transcript]
  extract --> task[createTask in Knowledge → Agent Sessions]
  task --> link[Cross-link to commit tasks for files<br/>touched in same window]
```

Source: `service/src/events/events.service.ts:ingestPrompt` + agent-side hook scripts in `scripts/install-claude-code.sh`.

### CU outbound webhook (taskCommentPosted, statusChanged, etc.)

```mermaid
graph TD
  in[CU webhook fires] --> hmac[HMAC-verify with<br/>workspace_settings.webhook_secret]
  hmac --> dedupe[INSERT clickup_inbound_events<br/>ON CONFLICT delivery_id]
  dedupe --> dispatch{event_type}
  dispatch -->|taskCommentPosted| pr_classify[classifyPrComment]
  pr_classify --> pr_open[matches 'PR opened' →<br/>tag commit task pr-open]
  pr_classify --> pr_merged[matches 'PR merged' →<br/>setStatus Done on commit task]
  dispatch -->|statusChanged| record[record in last_seen_status_changes]
  dispatch -->|taskDeleted| orphan[reverse-lookup project,<br/>flag if owned task]
```

Source: `service/src/sync/sync.service.ts:processInboundRow`.

### Drift cron (every 5 min)

For each active project:

1. `git -C <localPath> rev-parse HEAD`
2. Compare to `last_synced_commit` in DB
3. For each missed commit, enqueue `process_commit` (deduped by `commit_sha`)
4. Refresh Doc Overview if README/CHANGELOG changed since last sync

Source: `service/src/sync/drift.cron.ts`.

### Orphan detection cron (every 30 min)

For each active project, ping `getSpace(clickup_space_id)`. On 404 → flip `status = 'orphaned'` (one-way; manual re-register clears it).

Source: `service/src/projects/orphan-detection.cron.ts`.

### Scrum crons (planner / groomer / standup / retro)

See [`scrum-operator.md`](./scrum-operator.md). Each emits its own constellation of CU surfaces — tasks moved into sprint Lists, Daily Triage tasks, Doc pages for standup/retro, CU Goals + Key Results, audit rows.

---

## Surface taxonomy

What CU primitives the daemon writes to:

```mermaid
mindmap
  root((CU surfaces))
    Tasks
      Active Sprint
      In Review
      Open Work
      Bugs
      ADRs
      Agent Sessions
      Sprint history Lists
      Daily Triage (groomer)
      Hotspot Watch (singleton per file)
      Infra Watch (singleton)
      Auth Warning (when status=auth-needed)
    Comments
      Artifact Watch (per commit)
      Lifecycle annotations (PR open / merged / branch deleted)
      Scope rename cross-links
      Mentioned ones (E.6)
    Tags
      epic:* (blue)
      severity:* (red→orange→yellow→green)
      type:feat/fix/chore/docs/refactor (varied)
      source:* (gray)
      stale-bug carryover-overdue
      infra-change new-module dependency-review
      auto-archived needs-reassignment
      scope-renamed
      slow-review (Phase I, future)
    Custom fields (per List)
      commit_sha pr_url
      author_email author_github_url
      epic severity source milestone
    Doc handbook pages
      Overview Setup Conventions
      Changelog (auto-appended on each commit)
      Standups (one per day)
      Retros (one per sprint end)
      ADRs (cross-linked to ADRs List)
      Contributors (G.3 — auto)
      Architecture (G.3 — auto from dir creation)
      Dashboard (G.3 — view link panel)
    Goals + Key Results
      Sprint Goal per ISO week (E.4)
      Key Result type=automatic linked to sprint List
    Views per List
      Board by assignee/status/severity/epic
      Calendar
      Gantt
      Workload (tier-gated)
    Watchers
      Commit author
      Scope-rename peer assignees
```

---

## Classifier reference (`classifyArtifact`)

The single source of truth for "what kind of file is this" is `service/src/util/classify.ts`:

| Kind | Trigger pattern | Action in CU |
|---|---|---|
| `generated` | `^(dist\|build\|node_modules\|\.next\|coverage\|target\|__pycache__)/` or lockfiles | Suppressed entirely |
| `code` | Default | No special action |
| `adr` | `^(docs/(adr\|decisions)/.*\.md\|.*/adr/.*\.md\|ARCHITECTURE\.md)$` | Bundled comment + (future) ADR task |
| `doc` | `README\|CHANGELOG\|CONTRIBUTING\|CODE_OF_CONDUCT\|SECURITY` or `^docs/.*\.md$` | Bundled comment |
| `infra` | `Dockerfile`, `docker-compose*.yml`, `.github/workflows/*.yml`, `*.tf`, `kubernetes/` | Bundled comment + tag `infra-change` |
| `dependency` | `package.json`, `pyproject.toml`, `Cargo.toml`, `go.mod`, `requirements*.txt`, `Gemfile`, `composer.json` | Bundled comment + (Phase L) `[Deps] Review` task |
| `config-schema` | `.env.example`, `*.example`, `*.schema.json` | Bundled comment |
| `submodule` | `.gitmodules` | Bundled comment |
| `binary-resource` | size > 100KB, or `*.png/jpg/gif/webp/svg/pdf/zip/tar/gz/woff2?/ttf/eot/ico/mp[34]` | Bundled comment with size |
| `directory-creation` | (computed via `wasDirNewBeforeCommit`) | (Phase C.5/H.1) `[Module] New: <path>` task |

To add a new kind:
1. Add a regex branch to `classifyArtifact`
2. Add a handler `handleXChange` in `events.service`
3. Wire dispatch in `tryAppendArtifactWatch` or the per-handler dispatch

---

## What's NOT tracked (intentionally)

- **Generated files** (lockfiles, dist/, build/, node_modules/) — noise, not signal
- **Branch state changes** that aren't deletions (the daemon doesn't mirror every push)
- **Local-only state** (.vscode/, .idea/, .DS_Store)
- **Files outside the project's `scope_config.paths`** if scope is configured
- **Manually-created CU tasks without the auto-imported footer** — adoption explicitly never claims them

---

## Coming in v0.5.0

```mermaid
gantt
  title v0.5.0 SCRUM artifact tracking expansion
  dateFormat YYYY-MM-DD
  section Phase I
  PR review activity (review_events) :i1, 2026-05-10, 7d
  Co-author trailers + commit_authors :i2, after i1, 5d
  File ownership map :i3, after i2, 7d
  section Phase J
  Time tracking integration :j1, 2026-05-22, 5d
  Folder-level views :j2, after j1, 3d
  Whiteboard (architecture map) :j3, after j2, 4d
  CU Forms for bug intake :j4, after j3, 4d
  Recurring tasks for ceremonies :j5, after j4, 3d
  section Phase K
  Workspace rollup Doc :k1, 2026-06-08, 5d
  Daily DM via CU notifications :k2, after k1, 3d
  Slack bridge :k3, after k2, 3d
  section Phase L
  Coverage delta + lint regression :l1, 2026-06-22, 5d
  Risk score per file :l2, after l1, 5d
  section Phase M
  GitHub webhook ingestion :m1, 2026-07-04, 7d
  GitHub Actions status mirror :m2, after m1, 4d
  section Phase N
  Railway deployment tracking :n1, 2026-07-18, 10d
```

See [`roadmap.md`](./roadmap.md) for full Phase I-N details.
