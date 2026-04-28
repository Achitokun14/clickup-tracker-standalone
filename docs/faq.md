# FAQ

## Why AGPL-3.0?

It is the strongest copyleft for network-served software. If someone runs a modified hosted version (SaaS), the license requires them to publish their changes back. That keeps the incentive for fixes and improvements to land upstream rather than fork-and-vanish.

If you are building a **proprietary** product on top of this daemon and don't want to share modifications, AGPL is not a fit — but you don't have to modify it. Calling the HTTP API from any other process is fine and creates no AGPL obligations on your code.

## What data does the daemon send to ClickUp?

For each commit:

- The commit SHA, message, author name + email (from `git log`).
- The list of files changed (paths only, not contents).
- For Conventional-Commits-shaped messages: the parsed `type`, `scope`, `breaking?` flag.
- An auto-derived task title (the commit subject, capped at 200 chars).

For each AI session (when hooks are installed):

- `session_id` from the agent.
- `outcome_summary` — the last assistant message in the transcript, capped at 1000 chars.
- `files_touched` — the list of file paths the assistant edited (extracted from the transcript), capped at 50.
- `cwd` and the project's `display_name`.

The daemon never sends:

- File **contents**.
- Environment variables.
- Untracked files.
- Anything from outside the registered repo's path.

The README and CHANGELOG (if present) are pulled into the "Overview & Docs" task on registration and refreshed when the drift cron runs. They are sent verbatim — if you put secrets in your README, those will be in ClickUp. Don't.

## Can I use this with Gitea / GitLab / Bitbucket?

Yes. The post-commit hook is git-server-agnostic — it runs in your local clone, not on the remote. Whatever git server you push to is irrelevant.

The drift cron uses `git -C <localPath>` commands and never talks to a remote, so a fully offline / air-gapped setup works.

## Does this require a paid ClickUp plan?

No. The free tier is enough — the daemon uses the standard public REST API. You'll hit Spaces / Folders / Lists limits faster on free, but functionally it works.

## Is there telemetry?

No. The daemon has zero outbound network calls except to:

- ClickUp's REST API (the whole point).
- Whatever DB / Redis you configured.

It does not phone home, check for updates, or send analytics. If you want to verify, audit `service/src/` for `fetch(` / `https.request(` / `axios` — every call should have a ClickUp URL.

## How do I rotate `STANDALONE_API_TOKEN`?

```bash
$EDITOR .env  # change STANDALONE_API_TOKEN=
docker compose up -d --force-recreate clickup-tracker
bash install.sh  # re-runs to mirror the new value into ~/.config/clickup-tracker/config.json
```

Then update any external clients (CI scripts, Prometheus, MCP launchers).

## How do I rotate a per-project `hook_secret`?

There is no rotate-in-place endpoint in v0.1. Workflow:

```bash
# 1. Snapshot current state
curl -X POST http://localhost:4020/projects/<id>/backup

# 2. Untrack (a pre_remove backup is also taken automatically)
curl -X DELETE http://localhost:4020/projects/<id>

# 3. Re-register (returns a fresh hook_secret)
curl -X POST http://localhost:4020/projects \
  -H 'Content-Type: application/json' \
  -d '{"localPath":"/path","displayName":"..."}'

# 4. Restore the previous tasks into the new tree (additive mode)
curl -X POST http://localhost:4020/projects/<new-id>/restore \
  -H 'Content-Type: application/json' \
  -d '{"backupId":"<snapshot-from-step-1>","mode":"additive"}'

# 5. Re-install the post-commit hook on the repo with the new secret
bash scripts/install-git-hook.sh --repo <path> \
  --project-id <new-id> --hook-secret <new-secret> --force
```

## Why a separate MCP server instead of the daemon being one?

Two reasons:

1. **Transport**. MCP wants stdio (or HTTP/SSE) on a per-client basis. The daemon wants a persistent HTTP server. Splitting them lets each layer use its native transport.
2. **Scope**. The MCP server is one of N clients of the daemon — same as the post-commit hook, the slash commands, and any future integration. Treating it as just-another-client keeps the daemon's surface clean.

## My agent isn't in the integration matrix. Can I still use this?

Yes — three options, in order of preference:

1. **MCP**: if the agent supports MCP, point it at `mcp/dist/server.js`. See [`integrations/generic-mcp.md`](./integrations/generic-mcp.md).
2. **HTTP**: call the daemon's REST API directly. See [`integrations/http-direct.md`](./integrations/http-direct.md).
3. **Slash commands**: many agents support markdown-with-frontmatter slash commands similar to Claude Code. The 7 in `agents/claude-code/commands/` are mostly portable — fork, adjust, PR.

## Is there a hosted version?

No, by design. The whole point is local-first. If you want a hosted variant, fork it and run it — just remember the AGPL obligations if you serve modifications publicly.

## How is this different from the [original monorepo build]?

This is the standalone spin-out:

- Own Postgres + Redis (no shared DB).
- Reads ClickUp creds from env (no JOIN against an internal `clickup.workspaces` table).
- Static `STANDALONE_API_TOKEN` bearer (no gateway-injected headers).
- Routes at `:4020/...` directly (no `/api/v1/clickup-tracker` prefix).
- Cross-agent (was Claude-Code-only).

Functionally identical for the user — same HTTP API shape, same ClickUp output.
