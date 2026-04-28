# HTTP-direct integration

For agents (or scripts, or humans, or CI) that don't speak MCP. The clickup-tracker daemon's HTTP API is plain JSON — anything that can `curl` can use it.

This is also the right path for:

- CI jobs that want to trigger backups before deploys.
- Cron jobs that want to force `/sync` on schedule.
- Bots / one-off scripts that don't run in an agent environment.
- Custom dashboards.

## Base setup

```bash
BASE=http://localhost:4020
ORG=00000000-0000-0000-0000-000000000000
TOKEN=$(grep ^STANDALONE_API_TOKEN= .env | cut -d= -f2)   # may be empty for localhost-only
```

Always send `X-Organisation-Id: $ORG`. Send `Authorization: Bearer $TOKEN` only when the daemon was started with `STANDALONE_API_TOKEN` set.

## Bash recipes

### List projects

```bash
curl -fsS \
  ${TOKEN:+-H "Authorization: Bearer $TOKEN"} \
  -H "X-Organisation-Id: $ORG" \
  "$BASE/projects" | jq
```

### Register a project

```bash
curl -fsS -X POST \
  ${TOKEN:+-H "Authorization: Bearer $TOKEN"} \
  -H "X-Organisation-Id: $ORG" \
  -H "Content-Type: application/json" \
  -d '{"localPath":"/path/to/repo","displayName":"My Project"}' \
  "$BASE/projects" | jq
```

Save the response's `hookSecret` — it appears once.

### Resolve a CWD to a project

```bash
curl -fsS \
  ${TOKEN:+-H "Authorization: Bearer $TOKEN"} \
  -H "X-Organisation-Id: $ORG" \
  "$BASE/projects/resolve?path=$(printf '%s' "$(pwd)" | jq -sRr @uri)" | jq
```

### Trigger sync / backup / list backups / restore

```bash
PID=<project-id>

curl -fsS -X POST -H "Authorization: Bearer $TOKEN" -H "X-Organisation-Id: $ORG" \
  "$BASE/projects/$PID/sync"

curl -fsS -X POST -H "Authorization: Bearer $TOKEN" -H "X-Organisation-Id: $ORG" \
  "$BASE/projects/$PID/backup" | jq

curl -fsS -H "Authorization: Bearer $TOKEN" -H "X-Organisation-Id: $ORG" \
  "$BASE/projects/$PID/backups" | jq

curl -fsS -X POST -H "Authorization: Bearer $TOKEN" -H "X-Organisation-Id: $ORG" \
  -H "Content-Type: application/json" \
  -d '{"backupId":"<bk-id>","mode":"additive"}' \
  "$BASE/projects/$PID/restore" | jq
```

## TypeScript / Node

```ts
const BASE = process.env.CUP_TRACKER_BASE_URL ?? "http://localhost:4020";
const ORG  = process.env.CUP_TRACKER_ORG_ID  ?? "00000000-0000-0000-0000-000000000000";
const TOKEN = process.env.CUP_TRACKER_API_TOKEN ?? "";

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

const projects = await tracker<unknown[]>("GET", "/projects");
const reg = await tracker<{ projectId: string; hookSecret: string }>(
  "POST", "/projects",
  { localPath: "/path/to/repo", displayName: "My Project" },
);
console.log("Save this:", reg.hookSecret);
```

## Python

```python
import os, requests

BASE  = os.getenv("CUP_TRACKER_BASE_URL", "http://localhost:4020")
ORG   = os.getenv("CUP_TRACKER_ORG_ID", "00000000-0000-0000-0000-000000000000")
TOKEN = os.getenv("CUP_TRACKER_API_TOKEN", "")

def tracker(method: str, path: str, *, json=None):
    headers = {"X-Organisation-Id": ORG}
    if TOKEN:
        headers["Authorization"] = f"Bearer {TOKEN}"
    r = requests.request(method, f"{BASE}{path}", headers=headers, json=json, timeout=30)
    r.raise_for_status()
    return r.json() if r.content else None

projects = tracker("GET", "/projects")
reg = tracker("POST", "/projects",
              json={"localPath": "/path/to/repo", "displayName": "My Project"})
print("Save this:", reg["hookSecret"])
```

## Go

```go
package main

import (
    "bytes"
    "encoding/json"
    "fmt"
    "io"
    "net/http"
    "os"
)

func tracker(method, path string, body any) ([]byte, error) {
    base := getenv("CUP_TRACKER_BASE_URL", "http://localhost:4020")
    org  := getenv("CUP_TRACKER_ORG_ID", "00000000-0000-0000-0000-000000000000")
    tok  := os.Getenv("CUP_TRACKER_API_TOKEN")

    var buf io.Reader
    if body != nil {
        b, _ := json.Marshal(body)
        buf = bytes.NewReader(b)
    }
    req, _ := http.NewRequest(method, base+path, buf)
    req.Header.Set("X-Organisation-Id", org)
    if tok != "" {
        req.Header.Set("Authorization", "Bearer "+tok)
    }
    if body != nil {
        req.Header.Set("Content-Type", "application/json")
    }
    resp, err := http.DefaultClient.Do(req)
    if err != nil { return nil, err }
    defer resp.Body.Close()
    out, _ := io.ReadAll(resp.Body)
    if resp.StatusCode >= 400 {
        return nil, fmt.Errorf("HTTP %d: %s", resp.StatusCode, out)
    }
    return out, nil
}

func getenv(k, d string) string {
    if v := os.Getenv(k); v != "" { return v }
    return d
}
```

## Sending webhook events (advanced)

If you're building a tool that wants to *send* events (post-commit-style or Stop-hook-style), see [`../architecture.md`](../architecture.md) for the HMAC scheme. Required headers:

- `Content-Type: application/json`
- `X-CUP-Project-ID: <project-id>`
- `X-CUP-Timestamp: <unix-seconds>`
- `X-CUP-Signature: sha256=<hex(hmac_sha256(hook_secret, raw_body))>`
- `X-CUP-Idempotency-Key: <unique-key-for-replay-dedup>`

Reference implementation: `agents/claude-code/hooks/clickup-stop-sync.sh` (lines that build `body`, `sig`, and `curl` to `/public/prompt-events`).

## Full API spec

Live: `http://localhost:4020/public/openapi.yaml` while the daemon is running.

Source: [`../../service/openapi.yaml`](../../service/openapi.yaml).
