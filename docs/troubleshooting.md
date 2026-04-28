# Troubleshooting

## `/health` doesn't respond

```bash
docker compose ps
```

If `clickup-tracker` is not `Up`, look at the logs:

```bash
docker compose logs --tail=100 clickup-tracker
```

Common causes:

- `CLICKUP_API_TOKEN` empty in `.env` — daemon refuses to start.
- `CLICKUP_TEAM_ID` not numeric.
- Port already taken on host (`bind: address already in use`) → change `TRACKER_PORT` in `.env`.
- Postgres init failure (volume permission) → `docker compose down -v && docker compose up -d`.

## Post-commit hook does nothing

```bash
# Reproduce the hook with full trace
bash -x .git/hooks/post-commit
```

What to check:

| Symptom | Cause | Fix |
|---|---|---|
| `command not found: jq` / `openssl` / `curl` | Missing prereq on this machine | Install with your package manager |
| `Connection refused` to `localhost:4020` | Daemon not running | `docker compose up -d` |
| `403 forbidden` from `/public/git-events` | HMAC mismatch — hook secret stale | Re-register: `DELETE /projects/:id` then `POST /projects` |
| Hook silently exits 0 | `~/.config/clickup-tracker/projects/<id>.secret` missing | Re-run `scripts/install-git-hook.sh` |
| Buffered to `~/.cache/cup-cli/buffer/` | Daemon was unreachable at commit time | Brought daemon back up; the buffer replay cron will drain |

## Claude Code hooks don't fire

```bash
# Test the Stop hook in isolation
echo '{"transcript_path":"/tmp/transcript.jsonl","cwd":"'"$(pwd)"'","session_id":"test"}' | \
  bash -x ~/.claude/hooks/clickup-stop-sync.sh
```

What to check:

- `~/.config/clickup-tracker/config.json` exists and has `base_url` set.
- `~/.claude/settings.json` has the hook wired under `hooks.Stop[]` (the installer should have done this — re-run `bash agents/claude-code/install.sh`).
- `jq` is installed.
- The CWD is a registered project (`curl ... /projects/resolve?path=...` returns a `match.id`).

## ClickUp 401 / 429

| Code | Cause | Action |
|---|---|---|
| 401 | `CLICKUP_API_TOKEN` is wrong, expired, or revoked | Generate a new one in ClickUp Personal Settings → Apps; update `.env`; restart daemon |
| 429 | Hit ClickUp's rate limit (≈100 req/min/team) | Lower `CLICKUP_RATE_LIMIT` in `.env` (default 90); the daemon already backs off, so this should self-resolve |

## Drift cron silent

`docker compose logs clickup-tracker | grep drift` — should show one line per `CUP_TRACKER_DRIFT_MINUTES` interval.

Common causes:

- `CUP_TRACKER_DRIFT_MINUTES` not set (defaults to 60 — check after the hour).
- All registered projects are `status=paused` (the cron skips paused ones).
- The daemon has no Redis (BullMQ-less mode skips the cron) — bring Redis up: `docker compose up -d redis`.

## Port collisions (5432 / 6379)

If your host already runs Postgres or Redis on the standard ports, the compose stack fails to bind. Override in `.env`:

```env
POSTGRES_PORT=5433
REDIS_PORT=6380
```

Then `docker compose up -d --force-recreate`. The daemon talks to Postgres/Redis over the compose network, not via the host port, so internal connectivity is unaffected.

## "MCP server not connecting" (any MCP client)

```bash
# Smoke-test the server directly
node mcp/dist/server.js
# Should print on stderr:
#   [clickup-tracker-mcp] connected (base=http://localhost:4020, org=default)
```

If the message appears but the agent still doesn't see the tools, check:

- The agent's MCP config points at the **absolute** path of `mcp/dist/server.js` (relative paths often fail under different cwds).
- The agent is restarted after the config change.
- `mcp/dist/` exists. If not: `cd mcp && npm install && npm run build`.

## "I changed `POSTGRES_PASSWORD` and now the daemon can't connect"

Postgres only reads `POSTGRES_PASSWORD` on **first** init. After data exists, the env var is informational. To change:

```bash
docker compose exec postgres \
  psql -U cup -d clickup_tracker -c "ALTER USER cup WITH PASSWORD 'newpass';"
```

Then update `.env` and `docker compose up -d --force-recreate clickup-tracker`.

If you don't need to keep data, the simpler path is:

```bash
docker compose down -v   # nukes cup_pgdata + cup_redisdata
docker compose up -d
```

## `/restore` reports `skipped: <huge>`

This is normal in `additive` mode — restore only re-creates tasks that were deleted since the snapshot. Existing tasks are skipped, not modified.

To force updates on drifted tasks: use `mode: "merge"`. To wipe and replay the snapshot wholesale: `mode: "replace"` with `confirm: true` (destructive — a `pre_revert` snapshot is taken first).

## Where to file unresolved issues

- Bug? [Open a bug report](https://github.com/Achitokun14/clickup-tracker-standalone/issues/new?template=bug_report.md).
- Question? [Discussion](https://github.com/Achitokun14/clickup-tracker-standalone/discussions).
- Security? [Private advisory](https://github.com/Achitokun14/clickup-tracker-standalone/security/advisories/new).
