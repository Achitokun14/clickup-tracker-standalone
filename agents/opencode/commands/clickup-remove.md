---
description: Untrack a repo. Takes a pre-remove backup, then archives the ClickUp Folder. Pass --wipe to delete instead.
argument-hint: "[path/to/repo] [--wipe]"
---

Confirm with the user before proceeding — this is destructive at the ClickUp side. Note in the confirmation:

- A `pre_remove` backup is taken automatically; can be restored with /clickup-revert.
- Default mode **archives** the ClickUp Folder (recoverable in ClickUp UI).
- `--wipe` **deletes** it (only recoverable via /clickup-revert + the snapshot).

Then resolve the project ID by `$(pwd)` (or arg path) via `GET /projects/resolve?path=...`, and DELETE it:

```bash
BASE=$(jq -r .base_url ~/.config/clickup-tracker/config.json)
ORG=$(jq -r .default_org_id ~/.config/clickup-tracker/config.json)
AUTH=$(jq -r .auth_token ~/.config/clickup-tracker/config.json)
LOCAL_PATH="${1:-$(pwd)}"
WIPE=""
[[ "$*" == *"--wipe"* ]] && WIPE="?wipe=true"

PID=$(curl -fsS \
  -H "Authorization: Bearer $AUTH" -H "X-Organisation-Id: $ORG" \
  "${BASE%/}/projects/resolve?path=$(printf '%s' "$LOCAL_PATH" | jq -sRr @uri)" \
  | jq -r '.match.id // empty')

[[ -z "$PID" ]] && { echo "not tracked"; exit 0; }

curl -fsS -X DELETE \
  -H "Authorization: Bearer $AUTH" -H "X-Organisation-Id: $ORG" \
  "${BASE%/}/projects/$PID$WIPE"
```

Print `preRemoveBackupId` from the response so the user knows how to /clickup-revert if they change their mind.
