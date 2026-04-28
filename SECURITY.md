# Security Policy

## Reporting a vulnerability

**Do not open a public GitHub issue for security bugs.**

Use GitHub's private reporting channel:

1. Go to <https://github.com/Achitokun14/clickup-tracker-standalone/security/advisories/new>
2. File a private advisory with a description, reproducer, and impact assessment.

Reports go directly to the project owner ([@Achitokun14](https://github.com/Achitokun14)) and stay private until a fix is published.

## Response SLA

- Acknowledgement: best-effort within **7 days**.
- Patch / coordinated disclosure: depends on severity; we aim for 30 days for high-impact issues.

This is a solo-maintained project. SLAs are best-effort, not guaranteed.

## Scope

**In scope:**

- The NestJS daemon (`service/`)
- The webhook signature verification (`GitHmacGuard`, HMAC-SHA256)
- The `STANDALONE_API_TOKEN` and `METRICS_AUTH_TOKEN` bearer paths
- The post-commit and Stop/UserPromptSubmit shell hooks (`scripts/hooks/`)
- The MCP server (`mcp/`)
- Install scripts (`scripts/install-git-hook.sh`, `scripts/self-setup.sh`)

**Out of scope:**

- ClickUp's API itself — report to ClickUp.
- User-supplied `localPath` / `PROJECT_ID` / commit messages — these are user data, not attack surface.
- Vulnerabilities in third-party dependencies that have no exploit path through this project — file with the upstream maintainer (or open a regular issue with mitigation suggestions).
- Exposing the daemon publicly without setting `STANDALONE_API_TOKEN` — this is a user misconfiguration, documented in `CREDS.md` and `docs/deployment.md`.

## Credential rotation

- **`STANDALONE_API_TOKEN`** — change the value in `.env` and `docker compose up -d --force-recreate clickup-tracker`. Update any clients (CI, Prometheus, MCP launchers).
- **`METRICS_AUTH_TOKEN`** — same procedure.
- **`POSTGRES_PASSWORD`** — change in `.env`, then `docker compose down -v` (drops the data volume so Postgres re-initializes with the new password). Restore data from backup afterwards.
- **Per-project `hook_secret`** — no rotate-in-place endpoint in v0.1. To rotate: `DELETE /projects/<id>` (a `pre_remove` backup is taken automatically), then `POST /projects` to re-register.

## Recommended hardening for non-localhost deployments

1. Set `STANDALONE_API_TOKEN` to a 32-byte random hex string (`openssl rand -hex 32`).
2. Put the daemon behind TLS via reverse proxy (nginx/caddy snippets in `docs/deployment.md`).
3. Restrict ingress to known client IPs at the firewall.
4. Set `POSTGRES_PASSWORD` to a strong value before exposing port 5432.
5. Enable Docker's userns-remap if the host is shared.
