---
description: Show all tracked projects for the active organisation, with last-sync times.
argument-hint: ""
---

```bash
BASE=$(jq -r .base_url ~/.config/clickup-tracker/config.json)
ORG=$(jq -r .default_org_id ~/.config/clickup-tracker/config.json)
AUTH=$(jq -r .auth_token ~/.config/clickup-tracker/config.json)

curl -fsS \
  -H "Authorization: Bearer $AUTH" -H "X-Organisation-Id: $ORG" \
  "${BASE%/}/projects" | jq -r '
    ["project", "status", "last_synced", "tasks", "url"],
    (.[] | [.displayName, .status, (.lastSyncedAt // "never"), (.taskCount|tostring), .folderUrl])
    | @tsv' | column -t -s $'\t'
```

Highlight projects with `status=paused` or `status=removed`. For any active project where `lastSyncedAt` is more than 30 min old, suggest `/clickup-sync` (or just wait for the 5-min drift cron).
