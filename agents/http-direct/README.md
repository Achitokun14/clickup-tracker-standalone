# HTTP-direct integration

For agents (or scripts, or humans) that don't speak MCP. The clickup-tracker daemon's HTTP API is plain JSON — anything that can `curl` can use it.

Base URL: `http://localhost:4020/` (or whatever `TRACKER_PORT` you set).
Auth: `Authorization: Bearer $STANDALONE_API_TOKEN` if the daemon was started with that env var set; otherwise omit. Always send `X-Organisation-Id: default` (or your tenant id).

## Examples

### List projects

```bash
curl -fsS \
  -H "Authorization: Bearer $TOKEN" \
  -H "X-Organisation-Id: default" \
  http://localhost:4020/projects | jq
```

### Register a project

```bash
curl -fsS -X POST \
  -H "Authorization: Bearer $TOKEN" \
  -H "X-Organisation-Id: default" \
  -H "Content-Type: application/json" \
  -d '{"localPath":"/path/to/repo","displayName":"My Project"}' \
  http://localhost:4020/projects | jq
```

The response includes `hookSecret` — surfaced **once**. Save it.

### Resolve a path

```bash
curl -fsS \
  -H "Authorization: Bearer $TOKEN" \
  -H "X-Organisation-Id: default" \
  "http://localhost:4020/projects/resolve?path=$(printf '%s' "$(pwd)" | jq -sRr @uri)" | jq
```

### Trigger a sync / backup / restore

```bash
PID=<project-id>

curl -fsS -X POST \
  -H "Authorization: Bearer $TOKEN" -H "X-Organisation-Id: default" \
  http://localhost:4020/projects/$PID/sync

curl -fsS -X POST \
  -H "Authorization: Bearer $TOKEN" -H "X-Organisation-Id: default" \
  http://localhost:4020/projects/$PID/backup

curl -fsS -X POST \
  -H "Authorization: Bearer $TOKEN" -H "X-Organisation-Id: default" \
  -H "Content-Type: application/json" \
  -d '{"backupId":"<backup-id>","mode":"additive"}' \
  http://localhost:4020/projects/$PID/restore
```

## Language snippets

### TypeScript / Node

```ts
const BASE = "http://localhost:4020";
const ORG = "00000000-0000-0000-0000-000000000000";
const TOKEN = process.env.STANDALONE_API_TOKEN ?? "";

async function tracker<T>(method: string, path: string, body?: unknown): Promise<T> {
  const headers: Record<string, string> = { "X-Organisation-Id": ORG };
  if (TOKEN) headers.Authorization = `Bearer ${TOKEN}`;
  if (body !== undefined) headers["Content-Type"] = "application/json";
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) throw new Error(`HTTP ${res.status} ${await res.text()}`);
  return res.json() as Promise<T>;
}

const projects = await tracker("GET", "/projects");
```

### Python

```python
import os, requests

BASE = "http://localhost:4020"
HEADERS = {"X-Organisation-Id": "00000000-0000-0000-0000-000000000000"}
if (token := os.getenv("STANDALONE_API_TOKEN")):
    HEADERS["Authorization"] = f"Bearer {token}"

projects = requests.get(f"{BASE}/projects", headers=HEADERS).json()
```

### Go

```go
req, _ := http.NewRequest("GET", "http://localhost:4020/projects", nil)
req.Header.Set("X-Organisation-Id", "00000000-0000-0000-0000-000000000000")
if t := os.Getenv("STANDALONE_API_TOKEN"); t != "" {
    req.Header.Set("Authorization", "Bearer "+t)
}
resp, err := http.DefaultClient.Do(req)
```

## Full API reference

See [`service/openapi.yaml`](../../service/openapi.yaml) — also served at `http://localhost:4020/public/openapi.yaml` while the daemon is running.

## Webhook flow (for reference)

If you're building an agent that wants to *send* events (post-commit-style) rather than just pull state, see [`docs/architecture.md`](../../docs/architecture.md) for the HMAC signature scheme on `/public/git-events` and `/public/prompt-events`.
