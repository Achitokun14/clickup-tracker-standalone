---
description: Restore the ClickUp Folder/Lists/Tasks tree from a backup. Default mode is additive.
argument-hint: "<backup-id> [additive|merge|replace]"
---

`$1` is the backup ID, `$2` (optional) is the mode (default `additive`).

Modes:

- **additive** (default): re-create deleted tasks; leave existing ones alone.
- **merge**: re-create deleted + update tasks whose name/description drifted.
- **replace**: destructive — wipe and recreate from snapshot. Requires `confirm: true`.

A `pre_revert` snapshot is taken automatically before the restore.

```bash
BASE=$(jq -r .base_url ~/.config/clickup-tracker/config.json)
ORG=$(jq -r .default_org_id ~/.config/clickup-tracker/config.json)
AUTH=$(jq -r .auth_token ~/.config/clickup-tracker/config.json)

BACKUP_ID="$1"
MODE="${2:-additive}"
LOCAL_PATH="$(pwd)"

PID=$(curl -fsS \
  -H "Authorization: Bearer $AUTH" -H "X-Organisation-Id: $ORG" \
  "${BASE%/}/projects/resolve?path=$(printf '%s' "$LOCAL_PATH" | jq -sRr @uri)" \
  | jq -r '.match.id // empty')

[[ -z "$PID" ]] && { echo "not tracked"; exit 0; }

CONFIRM=""
[[ "$MODE" == "replace" ]] && CONFIRM=", \"confirm\": true"
BODY="{ \"backupId\": \"$BACKUP_ID\", \"mode\": \"$MODE\"$CONFIRM }"

curl -fsS -X POST \
  -H "Authorization: Bearer $AUTH" -H "X-Organisation-Id: $ORG" \
  -H "Content-Type: application/json" \
  -d "$BODY" \
  "${BASE%/}/projects/$PID/restore"
```

Surface `created`, `updated`, `skipped` counts and the new `preRevertBackupId` so the user can revert the revert if needed.
