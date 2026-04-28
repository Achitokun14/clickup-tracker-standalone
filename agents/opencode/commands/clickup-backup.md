---
description: Take a snapshot of the ClickUp Folder/Lists/Tasks tree for this project.
argument-hint: "[path/to/repo]"
---

Resolve the project id from `$(pwd)`, then POST to `/projects/:id/backup`:

```bash
BASE=$(jq -r .base_url ~/.config/clickup-tracker/config.json)
ORG=$(jq -r .default_org_id ~/.config/clickup-tracker/config.json)
AUTH=$(jq -r .auth_token ~/.config/clickup-tracker/config.json)
LOCAL_PATH="${1:-$(pwd)}"

PID=$(curl -fsS \
  -H "Authorization: Bearer $AUTH" -H "X-Organisation-Id: $ORG" \
  "${BASE%/}/projects/resolve?path=$(printf '%s' "$LOCAL_PATH" | jq -sRr @uri)" \
  | jq -r '.match.id // empty')

[[ -z "$PID" ]] && { echo "not tracked"; exit 0; }

curl -fsS -X POST \
  -H "Authorization: Bearer $AUTH" -H "X-Organisation-Id: $ORG" \
  "${BASE%/}/projects/$PID/backup"
```

Print the response's `backup.id`, `backup.task_count`, `backup.list_count`. Note that backups are kept indefinitely; restore via `/clickup-revert <backup-id>`.
