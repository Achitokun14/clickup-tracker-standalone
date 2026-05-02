# Documentation

## Foundations

| Page | Read this if you want to… |
|---|---|
| [quickstart.md](./quickstart.md) | Get from `git clone` to a tracked commit in 5 minutes. |
| [architecture.md](./architecture.md) | System overview with mermaid component / sequence / ER diagrams. |
| [api-reference.md](./api-reference.md) | Look up every endpoint, parameter, and auth requirement. |
| [deployment.md](./deployment.md) | Run the daemon beyond localhost (reverse proxy, TLS, public IP). |
| [troubleshooting.md](./troubleshooting.md) | Diagnose common failure modes. |
| [faq.md](./faq.md) | Answer license / privacy / compat questions. |
| [windows.md](./windows.md) | Run on Windows (Git Bash vs WSL2 vs PowerShell). |

## Feature deep-dives (v0.3.0+)

| Page | Read this if you want to… |
|---|---|
| [scrum-operator.md](./scrum-operator.md) | Understand the autonomous SCRUM operator (planner, groomer, reporting) + the 7 autonomy invariants. |
| [scrum-tracked-artifacts.md](./scrum-tracked-artifacts.md) | See the full catalog of what gets surfaced in CU (tasks, comments, tags, fields, doc pages, …). |
| [multi-developer.md](./multi-developer.md) | Adopt an existing Space, share one workspace across N developer daemons, handle token rotation. |
| [github-identity.md](./github-identity.md) | Phase F — how the daemon resolves commit emails to GitHub profiles + caches them. |
| [custom-fields-and-views.md](./custom-fields-and-views.md) | Phase E reference — what fields/views/goals get seeded per List, and how to extend. |
| [space-model.md](./space-model.md) | Per-repo CU Space layout (4 folders + Doc handbook). |
| [runbook.md](./runbook.md) | Operator runbook: backups, restore, troubleshooting flows. |
| [roadmap.md](./roadmap.md) | Released milestones + the v0.5.0 (Phases I–N) plan. |
| [integrations/claude-code.md](./integrations/claude-code.md) | Wire into Claude Code (slash commands + lifecycle hooks). |
| [integrations/claude-compat.md](./integrations/claude-compat.md) | Wire into OpenClaw / ZeroClaw / ClawCode. |
| [integrations/goose.md](./integrations/goose.md) | Wire into Goose (recipes + MCP extension). |
| [integrations/opencode.md](./integrations/opencode.md) | Wire into OpenCode (commands + MCP). |
| [integrations/generic-mcp.md](./integrations/generic-mcp.md) | Wire into any MCP-capable client (Cursor, Cline, Continue, …). |
| [integrations/http-direct.md](./integrations/http-direct.md) | Use the API from a script or unsupported agent. |

Repo-root docs that complement these:

- [`../README.md`](../README.md) — overview + integration matrix
- [`../CREDS.md`](../CREDS.md) — what credentials are needed and where to obtain them
- [`../SECURITY.md`](../SECURITY.md) — private vulnerability reporting + rotation
- [`../CONTRIBUTING.md`](../CONTRIBUTING.md) — dev loop, branch model, PR process
