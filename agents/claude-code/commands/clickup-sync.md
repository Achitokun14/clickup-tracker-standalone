---
description: Trigger an immediate sync for the current repo's tracked project (without waiting for the 5-min cron).
argument-hint: "[path/to/repo]"
---

```bash
BASE=$(jq -r .base_url ~/.config/clickup-tracker/config.json)
ORG=$(jq -r .default_org_id ~/.config/clickup-tracker/config.json)
AUTH=$(jq -r .auth_token ~/.config/clickup-tracker/config.json)
LOCAL_PATH="${1:-$(pwd)}"

PID=$(curl -fsS \
  -H "Authorization: Bearer $AUTH" -H "X-Organisation-Id: $ORG" \
  "${BASE%/}/projects/resolve?path=$(printf '%s' "$LOCAL_PATH" | jq -sRr @uri)" \
  | jq -r '.match.id // empty')

[[ -z "$PID" ]] && { echo "not tracked — run /clickup-add first"; exit 0; }

curl -fsS -X POST \
  -H "Authorization: Bearer $AUTH" -H "X-Organisation-Id: $ORG" \
  "${BASE%/}/projects/$PID/sync"
```

Response confirms the job was queued (`queued: true, kind: git_drift`). The cup-sync BullMQ worker will pick it up within seconds and post any deltas to the project's Overview & Docs task. Subsequent `lastSyncedAt` reads will reflect the sync.
