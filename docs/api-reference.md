# API reference

The daemon serves its own OpenAPI spec at `http://localhost:4020/public/openapi.yaml`. The same file lives at [`../service/openapi.yaml`](../service/openapi.yaml) — that is the **source of truth**. This page is a quick navigator.

## Routes by surface

### Internal — `STANDALONE_API_TOKEN` bearer (if set)

| Method | Path | Body | Returns |
|---|---|---|---|
| GET | `/projects` | — | `[ProjectRow]` |
| POST | `/projects` | `{localPath, displayName, scopeConfig?, extract?}` | `{projectId, folderUrl, taskCount, hookSecret, alreadyTracked}` |
| GET | `/projects/:id` | — | `ProjectRow` |
| PATCH | `/projects/:id` | `{displayName?, status?}` | `ProjectRow` |
| DELETE | `/projects/:id?wipe=true|false` | — | `{preRemoveBackupId, mode}` |
| POST | `/projects/:id/sync` | — | `{queued: true, kind: "git_drift"}` |
| POST | `/projects/:id/backup` | — | `{backup: {id, taskCount, listCount}}` |
| GET | `/projects/:id/backups` | — | `[Backup]` |
| POST | `/projects/:id/restore` | `{backupId, mode, confirm?}` | `{created, updated, skipped, preRevertBackupId}` |
| GET | `/projects/resolve?path=<urlencoded>` | — | `{match: ProjectRow \| null}` |

`hookSecret` is returned **once**, in the `POST /projects` response. There is no endpoint to re-read it. Rotate by `DELETE /projects/:id` (auto pre-remove backup) and re-`POST`.

### Public — HMAC-only

| Method | Path | Headers | Body |
|---|---|---|---|
| POST | `/public/git-events` | `X-CUP-Project-ID`, `X-CUP-Timestamp`, `X-CUP-Signature`, `X-CUP-Idempotency-Key` | `{commits: [...], extract?: {...}}` |
| POST | `/public/prompt-events` | same as above | `{session_id, outcome_summary, files_touched: [{path, status}]}` |

Signature: `sha256=hex(hmac_sha256(hook_secret, raw_request_body))`.

The `Idempotency-Key` lets the daemon dedupe replays. The post-commit hook uses `<projectId>:<sha>:<timestamp>`; the Stop hook uses `<projectId>:<sessionId>:<timestamp>`.

### Open

| Method | Path | Purpose |
|---|---|---|
| GET | `/health` | Liveness probe (no body validation, just 200). |
| GET | `/public/metrics` | Prometheus exposition (gated by optional `METRICS_AUTH_TOKEN`). |
| GET | `/public/openapi.yaml` | Self-served full spec. |

## Auth flow examples

### With `STANDALONE_API_TOKEN`

```bash
TOKEN=$(grep ^STANDALONE_API_TOKEN= .env | cut -d= -f2)

curl -fsS \
  -H "Authorization: Bearer $TOKEN" \
  -H "X-Organisation-Id: default" \
  http://localhost:4020/projects
```

### Without (localhost-only deployment)

```bash
curl -fsS \
  -H "X-Organisation-Id: default" \
  http://localhost:4020/projects
```

The `X-Organisation-Id` header is always required on internal routes — even in open mode — because the daemon partitions data by `organisation_id`. For single-tenant deployments, just use `default` everywhere.

### HMAC payload (public route)

```bash
SECRET=$(cat ~/.config/clickup-tracker/projects/<project-id>.secret)
BODY='{"session_id":"x","outcome_summary":"y","files_touched":[]}'
SIG="sha256=$(printf '%s' "$BODY" | openssl dgst -sha256 -hmac "$SECRET" -hex | awk '{print $2}')"

curl -fsS -X POST \
  -H "Content-Type: application/json" \
  -H "X-CUP-Project-ID: <project-id>" \
  -H "X-CUP-Timestamp: $(date +%s)" \
  -H "X-CUP-Signature: $SIG" \
  -H "X-CUP-Idempotency-Key: <project-id>:<session-id>:$(date +%s)" \
  -d "$BODY" \
  http://localhost:4020/public/prompt-events
```

## Status codes

| Code | When |
|---|---|
| 200 | Success. |
| 201 | Resource created (`POST /projects` first-time). |
| 400 | Bad request body / missing required field. |
| 401 | Bearer missing or wrong (internal routes with `STANDALONE_API_TOKEN` set). |
| 403 | HMAC signature invalid (public routes). |
| 404 | Project / backup not found. |
| 409 | Conflict — e.g. `localPath` already registered. |
| 422 | Validation failure with field-level detail. |
| 429 | Upstream ClickUp rate limit hit (the daemon backs off; client should retry with jitter). |
| 500 | Internal error (logged with request id; please file a bug). |

## Schemas

See the OpenAPI spec for full JSONSchema. Key shapes:

```ts
type ProjectRow = {
  id: string;
  organisation_id: string;
  local_path: string;
  display_name: string;
  status: "active" | "paused" | "removed";
  scope_config: { mode: "all" | "paths"; paths?: string[] };
  clickup_team_id: string;
  clickup_space_id: string;
  clickup_folder_id: string;
  list_ids: { commits: string; prompts: string; overview: string };
  task_count: number;
  last_synced_at: string | null;
  last_synced_commit: string | null;
  created_at: string;
  updated_at: string;
};
```

`hook_secret` is **never** returned in `GET /projects/:id` responses. It only appears in the `POST /projects` 201 response.
