# Changelog

All notable changes to this project are documented here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.1.0] - 2026-04-28

### Added

- Initial public release as `clickup-tracker-standalone`.
- AGPL-3.0 license.
- Self-contained Docker stack: Postgres + Redis + NestJS daemon, `restart: always`.
- HTTP API at `:4020/` — internal `/projects/*`, public `/public/{git,prompt}-events`, `/health`, `/public/metrics`.
- Universal MCP server (`mcp/`) wrapping the daemon — works with any MCP-capable agent (Claude Code, Goose, OpenCode, Cursor, Cline, Continue).
- Per-agent integration shims under `agents/`:
  - `claude-code/` — slash commands + Stop/UserPromptSubmit hooks + installer.
  - `claude-compat/` — wrapper for OpenClaw / ZeroClaw / ClawCode (share the `~/.claude/` convention).
  - `goose/` — recipes + MCP extension.
  - `opencode/` — slash commands + MCP config.
  - `generic-mcp/` — config snippet for any MCP agent.
  - `http-direct/` — raw HTTP examples for non-MCP agents.
- Cross-platform: Linux, macOS, and Windows (via Git Bash / WSL2 / Docker Desktop).
- Unified one-script installer that detects OS and runs end-to-end setup.
- Documentation under `docs/` — quickstart, architecture, API reference, deployment, troubleshooting, FAQ, Windows guide, integrations.
- Contributor scaffolding: `CONTRIBUTING.md`, `CODE_OF_CONDUCT.md`, `SECURITY.md`, `CODEOWNERS`, PR + issue templates, GitHub Actions CI, Dependabot.

### Changed

- Routes are exposed at the daemon root (`:4020/...`) with no `/api/v1/clickup-tracker` prefix. The seven slash commands and the two Claude Code hooks were updated to match.
- Default ClickUp space name reset from the org-specific `BGMTech` to `Default` (override via `DEFAULT_CLICKUP_SPACE_NAME`).
- Source headers and comments stripped of monorepo / personal-path references.
- Hook config key `gateway_url` renamed to `base_url` consistently across hooks and slash commands.

### Security

- `STANDALONE_API_TOKEN` and `METRICS_AUTH_TOKEN` documented as required when exposing the daemon beyond localhost.
- Per-project HMAC `hook_secret` model documented in `CREDS.md` and `SECURITY.md`.
- Private security reporting via GitHub Security Advisories.

[Unreleased]: https://github.com/Achitokun14/clickup-tracker-standalone/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/Achitokun14/clickup-tracker-standalone/releases/tag/v0.1.0
