# Runbook

Operational recipes for the most common failure modes.

## Backfill stuck at `running`

```bash
curl -fsS -H "Authorization: Bearer $AUTH" -H "X-Organisation-Id: $ORG" \
  "http://localhost:4020/projects/<id>/backfill"
```

If `processed` is increasing every 30s, the worker is fine — just rate-limited. ClickUp Free/Unlimited/Business is capped at 100 req/min; for a 5000-commit cap, expect ~2.5 h.

If `processed` is unchanged for >5 min:

1. `docker logs clickup-tracker-clickup-tracker-1 | tail -50` — look for
   429s, 5xx exhaustion, or panics.
2. If the container is silent, restart it:
   `docker compose restart clickup-tracker`. The worker resumes from the
   `backfill_state.last_list` checkpoint.

## Backfill `failed`

```bash
curl -fsS … "http://localhost:4020/projects/<id>/backfill" | jq .error_message
```

Common causes:

- **Invalid `CLICKUP_API_TOKEN`** — rotate via `bash scripts/oauth-bootstrap.sh`
  or paste a fresh personal token into `.env`.
- **Workspace member quota** — extremely rare; documented for completeness.
- **Space deleted out from under us** — re-register via
  `bash scripts/wipe-and-rereg.sh <projectId> <localPath>`.

After fixing the underlying issue, `POST /projects/:id/replan` retries from
the last checkpoint.

## ClickUp UI shows duplicated tasks

Likely `task_index` corruption (e.g. a manual SQL edit dropped a key).
Manually delete the duplicates in ClickUp, then
`POST /projects/:id/replan` — replan rebuilds the index from CU state via
`task_index` lookups (idempotent: skips entities already mapped).

## Webhook deliveries failing

```bash
gh api -X GET "https://api.clickup.com/api/v2/team/<team_id>/webhook" \
  -H "Authorization: $CLICKUP_API_TOKEN"
```

`failure_count > 5` auto-disables the webhook on the ClickUp side.
`POST /projects/:id/replan` re-creates it.

For **localhost-only** setups the webhook will always fail until you expose
the daemon via a tunnel:

```bash
# Cloudflare Tunnel (free)
cloudflared tunnel --url http://localhost:4020

# ngrok
ngrok http 4020

# Tailscale Funnel
tailscale funnel 4020
```

Then re-create the webhook via `replan` so ClickUp gets the new URL.

## Sprint List for the current week missing

Every Monday at 00:00 UTC, the drift cron creates the new Sprint List if
absent. If still missing after 24 h, manually `POST /projects/:id/replan`.

## Live commits aren't landing in the right Sprint List

The lifecycle handler in `events.service` resolves the List by:

1. `project.sprint_lists[isoWeekKey]` — exact week match.
2. `project.list_ids['active_sprint']` — fallback.
3. `project.list_ids['open_work']` — legacy fallback.

If commits are landing in `Open Work` instead of the Sprint List, the
project hasn't been re-registered in Space mode (it's still the legacy
3-list shape). Run `bash scripts/wipe-and-rereg.sh`.

## Re-register a project from scratch

```bash
bash scripts/wipe-and-rereg.sh <projectId> /absolute/path/to/repo
```

The script:

1. `DELETE /projects/<id>?wipe=true` — cascades to git_events,
   prompt_events, backups. Deletes the ClickUp Folder via `DELETE
   /folder/<id>` (PUT `{archived: true}` is a verified no-op — see CARL
   decision `clickup_tracker_rewrite-004`).
2. `POST /projects` with `backfillMode: 'space'` — INSERTs a placeholder
   row, enqueues `cup-backfill`.
3. Polls `/backfill` every 5 s until `done | failed`.

## Daemon won't start

```bash
docker compose logs clickup-tracker | tail -50
```

Most common: schema not applied. The `service/scripts/db-init.sh` script
mounts `schema/init.sql` and `schema/02_per_repo_space.sql` into Postgres'
`docker-entrypoint-initdb.d/`, but these only run on **first** volume init.
For an existing DB with a missing schema:

```bash
docker compose exec postgres psql -U clickup -d clickup -f /docker-entrypoint-initdb.d/02-per-repo-space.sql
```

## Secrets visible in logs

`pino` redacts `Authorization` headers and `*.token`/`*.hookSecret`/
`*.webhook_secret` paths. If you spot a secret in a log line, it's likely
in a custom `this.log.warn(\`token: ${tok}\`)` call somewhere — search and
remove the literal interpolation.
