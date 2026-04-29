---
description: Append a markdown comment to a ClickUp task.
argument-hint: "<projectId> <taskId> <markdown>"
---

Read `~/.config/clickup-tracker/config.json` for `base_url`, `default_org_id`, `auth_token`.

```bash
BASE=$(jq -r .base_url ~/.config/clickup-tracker/config.json)
ORG=$(jq -r .default_org_id ~/.config/clickup-tracker/config.json)
AUTH=$(jq -r .auth_token ~/.config/clickup-tracker/config.json)
PROJECT_ID="${1:?projectId required}"
TASK_ID="${2:?taskId required}"
MARKDOWN="${3:?markdown required}"

BODY=$(jq -nc --arg m "$MARKDOWN" '{ markdown: $m }')

curl -fsS -X POST \
  -H "Authorization: Bearer $AUTH" \
  -H "X-Organisation-Id: $ORG" \
  -H "Content-Type: application/json" \
  -d "$BODY" \
  "${BASE%/}/projects/${PROJECT_ID}/tasks/${TASK_ID}/comment" | jq .
```
