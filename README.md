# clickup-tracker

[![License: AGPL-3.0](https://img.shields.io/badge/License-AGPL--3.0-blue.svg)](./LICENSE)
[![CI](https://github.com/Achitokun14/clickup-tracker-standalone/actions/workflows/ci.yml/badge.svg)](https://github.com/Achitokun14/clickup-tracker-standalone/actions/workflows/ci.yml)
[![Docker](https://img.shields.io/badge/Docker-ready-2496ed?logo=docker&logoColor=white)](./docker-compose.yml)
[![MCP](https://img.shields.io/badge/MCP-compatible-7c3aed)](./mcp/README.md)

> Self-hostable Docker daemon that mirrors local git repos into [ClickUp](https://clickup.com/) tasks. Every commit and every Claude Code / Goose / OpenCode session becomes a tracked event — automatically, with backups and one-command revert.

```
   git commit ─┐
               ├─→  clickup-tracker (:4020)  ─→  ClickUp
  agent turn ──┘                                 ├─ Folder per repo
                                                  ├─ List: Commits
                                                  ├─ List: Prompts
                                                  └─ List: Overview & Docs
```

## 30-second quickstart

```bash
git clone https://github.com/Achitokun14/clickup-tracker-standalone
cd clickup-tracker-standalone
cp .env.example .env       # fill in CLICKUP_API_TOKEN + CLICKUP_TEAM_ID
bash install.sh            # docker compose up + MCP build + config write
```

That's it. The daemon is now running at `http://localhost:4020`. To wire your AI coding agent in, run any of:

```bash
bash install.sh --agent claude-code     # Claude Code (~/.claude/)
bash install.sh --agent claude-compat   # OpenClaw / ZeroClaw / ClawCode
bash install.sh --agent opencode        # OpenCode
bash install.sh --agent all             # auto-detect installed agents
```

On Windows: `.\install.ps1 -Agent claude-code` (requires Git for Windows + Docker Desktop).

See [`docs/quickstart.md`](./docs/quickstart.md) for the full 5-minute walkthrough.

## Why use this

- **Stop writing tasks twice.** The daemon turns commits into ClickUp tasks with structured fields (changelog entries, TODOs, files touched).
- **AI sessions show up too.** Claude Code / Goose / OpenCode prompts and outcomes get mirrored alongside commits.
- **Self-hosted, AGPL.** Runs on your laptop or your server. No SaaS, no telemetry, no analytics.
- **Backups + revert.** Snapshot the ClickUp tree before risky operations. One command to restore.
- **Drift-resistant.** A 5-minute drift cron reconciles ClickUp ⟷ git automatically.

## Agent integration matrix

| Agent | Native support | Install command | Doc |
|---|---|---|---|
| Claude Code | slash commands + Stop/Prompt hooks + MCP | `bash install.sh --agent claude-code` | [docs/integrations/claude-code.md](./docs/integrations/claude-code.md) |
| OpenClaw / ZeroClaw / ClawCode | shares `~/.claude/` convention | `bash install.sh --agent claude-compat` | [docs/integrations/claude-compat.md](./docs/integrations/claude-compat.md) |
| Goose | recipes + MCP extension | `bash install.sh --agent goose` | [docs/integrations/goose.md](./docs/integrations/goose.md) |
| OpenCode | slash commands + MCP | `bash install.sh --agent opencode` | [docs/integrations/opencode.md](./docs/integrations/opencode.md) |
| Cursor / Cline / Continue / generic MCP | universal MCP server | manual JSON config | [docs/integrations/generic-mcp.md](./docs/integrations/generic-mcp.md) |
| No MCP support | raw HTTP | `curl` examples | [docs/integrations/http-direct.md](./docs/integrations/http-direct.md) |

## Architecture

```
┌──────────────┐   post-commit hook    ┌──────────────────────┐    ┌─────────┐
│ tracked repo │ ────HMAC-SHA256────▶  │  clickup-tracker     │ ─▶ │ ClickUp │
└──────────────┘                       │  (NestJS @ :4020)    │    │  REST   │
                                       │  ┌────────────────┐  │    └─────────┘
┌──────────────┐   Stop / Prompt       │  │ Postgres + Redis│ │
│ Claude Code  │ ────HMAC-SHA256────▶  │  │ (own volumes)   │ │
│ Goose        │                       │  └────────────────┘  │
│ OpenCode     │   MCP stdio           │  + 5-min drift cron  │
│ + any MCP    │ ─────────────────▶    │  + bulk planner       │
└──────────────┘                       └──────────────────────┘
```

Full diagrams: [`docs/architecture.md`](./docs/architecture.md).

## Endpoints

All exposed at `http://localhost:4020/` (override via `TRACKER_PORT`).

| Method | Path | Auth | Purpose |
|---|---|---|---|
| GET | `/health` | none | Liveness probe |
| GET | `/projects` | bearer (if `STANDALONE_API_TOKEN` set) | List tracked projects |
| POST | `/projects` | bearer | Register repo, returns `hookSecret` once |
| GET | `/projects/:id` | bearer | Detail |
| PATCH | `/projects/:id` | bearer | Update name / status |
| DELETE | `/projects/:id?wipe=true` | bearer | Untrack (auto pre-remove backup) |
| POST | `/projects/:id/sync` | bearer | Enqueue immediate drift sync |
| POST | `/projects/:id/backup` | bearer | Manual snapshot |
| GET | `/projects/:id/backups` | bearer | List snapshots |
| POST | `/projects/:id/restore` | bearer | Restore from backup |
| GET | `/projects/resolve?path=` | bearer | Longest-prefix path → project id |
| POST | `/public/git-events` | HMAC | Post-commit webhook |
| POST | `/public/prompt-events` | HMAC | Agent Stop-hook webhook |
| GET | `/public/metrics` | bearer (if `METRICS_AUTH_TOKEN` set) | Prometheus |
| GET | `/public/openapi.yaml` | none | Full OpenAPI 3.1 spec |

## Layout

```
clickup-tracker-standalone/
├── install.sh / install.ps1   # one-script multi-platform installer
├── docker-compose.yml         # postgres + redis + tracker, restart: always
├── .env.example               # CLICKUP_API_TOKEN, ports, optional knobs
├── CREDS.md                   # what credentials you need + where to get them
├── SECRETS.md.example         # template for your local secret bundle
├── service/                   # NestJS daemon (port 4020)
│   ├── Dockerfile
│   ├── prisma/schema.prisma
│   ├── openapi.yaml
│   └── src/                   # main, projects, events, bulk, sync, backup, clickup
├── mcp/                       # universal MCP server (Node, stdio)
│   └── src/server.ts
├── agents/                    # per-agent integration shims
│   ├── claude-code/           # 7 slash commands + 2 hooks + installer
│   ├── claude-compat/         # OpenClaw / ZeroClaw / ClawCode wrapper
│   ├── goose/                 # recipes + MCP extension
│   ├── opencode/              # commands + MCP config
│   ├── generic-mcp/           # any MCP client
│   └── http-direct/           # raw HTTP (TS/Python/Go snippets)
├── scripts/
│   ├── self-setup.sh          # legacy bootstrap (delegated to by install.sh)
│   ├── install-git-hook.sh    # drops post-commit hook into a tracked repo
│   └── windows/               # PowerShell wrappers for Win
├── schema/init.sql            # clickup_tracker schema
└── docs/                      # quickstart, architecture, deployment, …
```

## Cross-platform support

| Platform | Status | Notes |
|---|---|---|
| Linux (any modern distro) | ✅ first-class | Docker via `docker.io` package or Docker CE |
| macOS | ✅ first-class | Docker Desktop or Colima |
| Windows | ✅ via Git Bash or WSL2 | Docker Desktop required; `install.ps1` wraps `install.sh` |

Bash scripts target Bash 4+. Python is **not** required — only `bash`, `jq`, `openssl`, `curl`, `docker`, and (for the MCP server) `node`.

## Stopping / removing

```bash
docker compose down       # stop, keep data volumes
docker compose down -v    # nuke including data (cup_pgdata, cup_redisdata)
```

## Documentation

- [Quickstart](./docs/quickstart.md) — 5-minute end-to-end
- [Architecture](./docs/architecture.md) — sequence diagrams, queue model
- [API reference](./docs/api-reference.md) — full endpoint table + auth
- [Deployment](./docs/deployment.md) — Docker, reverse proxy, TLS
- [Troubleshooting](./docs/troubleshooting.md) — common failures
- [FAQ](./docs/faq.md) — license, privacy, agent compat
- [Windows](./docs/windows.md) — Git Bash vs WSL2, Docker Desktop notes
- [Credentials](./CREDS.md) — what to set up, where to get the tokens
- [Security policy](./SECURITY.md) — private reporting + rotation guidance
- [Contributing](./CONTRIBUTING.md) — dev setup + PR flow
- [Changelog](./CHANGELOG.md)

## License

[AGPL-3.0-or-later](./LICENSE). If you run a modified version as a network service (SaaS), you must publish your modifications under the same license.
