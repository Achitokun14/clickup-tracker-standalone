# Roadmap

Tracks released and planned milestones. Maintained alongside the deep plan at `~/.claude/plans/sleepy-crunching-ember.md` (architect-facing) and CHANGELOG.md (release-facing).

---

## Released

```mermaid
timeline
  title clickup-tracker release timeline
  v0.1.x : Single Folder model<br/>Commits + Prompts + Overview
  v0.2.x : Per-repo Spaces<br/>4-folder hierarchy<br/>Doc handbook<br/>Bulk extractors
  v0.3.0 : Autonomous SCRUM operator<br/>Multi-developer adoption<br/>Hotfix triple (branch routing,<br/>doc atomicity, controller fields)<br/>17 PRs · 365 tests
  v0.4.0 : Native CU UI richness<br/>(custom fields, colored tags,<br/>views, goals, watchers, mentions)<br/>GitHub identity bridge<br/>Doc redesign + visual lifecycle<br/>5 PRs · 422 tests
  v0.5.0 : Deep collaboration + integrations<br/>(PR review SLA, ownership map,<br/>time tracking, Forms, Whiteboards,<br/>workspace rollup, notifications,<br/>quality signals, GitHub deep,<br/>Railway deployments)<br/>12 PRs · 534 tests
  v0.6.0 : PMP / project-charter overlay<br/>(📘 Project Plan Folder + 19 PMI/PMBOK template tasks<br/>seeded on every Space; 3-status charter view)<br/>1 PR · 544 tests
  v0.7.0 (planned) : Cross-VCS surface<br/>(GitLab + Bitbucket identity,<br/>webhook ingestion, Heroku/Vercel/Fly mirrors)
```

### v0.4.0 ship list (released)

| PR | Phase | Status |
|---|---|---|
| #51 | E.1 + E.2 — Custom fields + colored space tags | merged |
| #52 | E.3-E.6 — Views + Goals + Watchers + structured mentions | merged |
| #53 | F.1-F.4 — GitHub identity + Contributors endpoint | merged |
| #55 | G.1-G.3 — Doc page redesign (standup with progress bars + per-author tables, retro with sparkline, new Handbook pages) | merged |
| #56 | H.1-H.4 — Visual lifecycle (emoji prefixes, collapsibles, table comments, attribution-aware Changelog) | merged |

---

## v0.5.0 — Deep collaboration + integrations (~12 PRs)

### Phase I — Deeper collaborator tracking

```mermaid
graph LR
  I1[I.1 PR review event ingestion<br/>github_review_events table] --> I2[I.2 Code-review turnaround<br/>retro 'Review SLA' section]
  I2 --> I3[I.3 Pair-programming detection<br/>Co-authored-by trailers<br/>commit_authors table]
  I3 --> I4[I.4 File ownership map<br/>recency-weighted line deltas]
  I4 --> I5[I.5 Ownership Doc page<br/>tree view with top-3 owners per file]
```

### Phase J — Richer CU surfaces

```mermaid
graph LR
  J1[J.1 Time tracking<br/>auto-fill estimate, roll-up actual] --> J2[J.2 Folder-level views<br/>cross-List Board/Calendar/Gantt]
  J2 --> J3[J.3 Whiteboard<br/>auto-populated architecture map]
  J3 --> J4[J.4 CU Forms<br/>structured bug intake]
  J4 --> J5[J.5 Recurring tasks<br/>for daily/weekly ceremonies]
```

### Phase K — Cross-project rollup + notifications + automation

```mermaid
graph LR
  K1[K.1 Workspace Overview Doc<br/>Active Projects, Hotspots,<br/>Contributors, Risk Register] --> K2[K.2 Daily DM<br/>per-author CU notifications]
  K2 --> K3[K.3 Email digest<br/>weekly SMTP for external contributors]
  K3 --> K4[K.4 Slack bridge<br/>opt-in webhook for sprint/bug events]
  K4 --> K5[K.5 Auto-suggest reviewers<br/>from file ownership map]
  K5 --> K6[K.6 Auto-link issues<br/>parse #N from commits]
```

### Phase L — Quality signals

```mermaid
graph LR
  L1[L.1 Coverage delta per commit<br/>commit_quality table<br/>tag coverage-regression] --> L2[L.2 Lint regression detection<br/>tag lint-regression]
  L2 --> L3[L.3 Risk score per file<br/>churn × bugs × LOC × test-age<br/>tag risk-high / risk-critical]
```

### Phase M — Deeper GitHub integration

```mermaid
graph LR
  M1["M.1 GitHub webhook ingestion<br/>POST /github/webhooks/:projectId<br/>events: PR open/merge/review,<br/>issues, releases, workflow_run"] --> M2[M.2 GitHub Actions status mirror<br/>ci_status field, badge prefix]
  M2 --> M3[M.3 gh-cli polling fallback<br/>5-min cron when webhook absent]
```

### Phase N — Railway deployment tracking

```mermaid
graph LR
  N1[N.1 Railway GraphQL client] --> N2[N.2 Project ↔ Railway service binding]
  N2 --> N3["N.3 Deployment polling cron<br/>2-min · creates 🚀 Deployments List"]
  N3 --> N4[N.4 Per-deployment task lifecycle<br/>status emoji, logs, mentions]
  N4 --> N5[N.5 Cross-link to commits<br/>tag deployed_to_<env>]
  N5 --> N6[N.6 Custom fields<br/>environment, deployment_status,<br/>commit_sha, build_duration, deploy_url]
  N6 --> N7[N.7 Standup + retro<br/>deployment frequency, MTTR]
  N7 --> N8[N.8 Optional Railway webhook]
  N8 --> N9[N.9 Deployments Doc page]
  N9 --> N10[N.10 /clickup-deploy-status slash command]
```

---

## v0.5.0 PR breakdown (released 2026-05-03)

| PR | Phase(s) | Status |
|---|---|---|
| PR-6 | I.1 + I.2 + I.3 | merged |
| PR-7 | I.4 + I.5 | merged |
| PR-8 | J.1 + J.2 + J.3 | merged |
| PR-9 | J.4 + J.5 | merged |
| PR-10 | K.1 + K.2 + K.3 | merged |
| PR-11 | K.4 + K.5 + K.6 | merged |
| PR-12 | L.1 + L.2 | merged |
| PR-13 | L.3 | merged |
| PR-14 | M.1 | merged |
| PR-15 | M.2 + M.3 | merged |
| PR-16 | N.1 + N.2 + N.3 + N.6 | merged |
| PR-17 | N.4 + N.5 + N.7 + N.8 + N.9 + N.10 | merged |

**Total:** 12 PRs · 534 tests passing.

---

## v0.6.0 — PMP / project-charter overlay (released 2026-05-05)

| PR | Phase(s) | Status |
|---|---|---|
| PR-18 | O — `📘 Project Plan` Folder + 19 PMI template tasks | merged |

**Total:** 1 PR · 544 tests passing.

Every per-repo Space now ships with a 5th `📘 Project Plan` Folder seeded with 19 charter sections (Scope Management, Risk Log, RACI Matrix, Communication Plan, …) on a dedicated 3-status List. Idempotent via `task_index["pmp:*"]`; existing Spaces upgrade lazily on the next backfill tick. No schema apply, no Space wipe.

---

## Out of scope (deferred)

- LLM-driven sprint planning / NLP standup commentary
- Cross-workspace federation
- GitLab / Bitbucket / Gitea identity bridges (Phase Q candidate)
- Heroku / Vercel / Fly deployment tracking (mirror Railway pattern when needed)
- Bundled holiday calendar (operator-curated `scrum_config.holidays[]`)
- PTO/vacation awareness
- Per-task SLA tracking with alerts
- Real-time co-presence
- PagerDuty / Opsgenie incident bridge
- Auto-rollback on deploy failure
- Cost telemetry per Railway service
- LLM standup generation
- Avatar caching to local CDN

---

## Versioning

- **Major bumps (v1.0.0+)** — breaking schema changes that require manual migration
- **Minor bumps (v0.4.0 → v0.5.0)** — new phase milestones; additive schema changes (auto-applied via `schema/0X_*.sql`)
- **Patch bumps (v0.4.1)** — bug fixes, no schema changes

Schema migrations are append-only. To go from v0.X to v0.Y, apply every `schema/0X_*.sql` ≤ Y in order. They're idempotent — safe to re-apply on existing volumes.
