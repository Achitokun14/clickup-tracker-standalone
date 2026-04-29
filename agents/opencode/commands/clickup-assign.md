---
description: Assign a ClickUp task to a workspace member by email (resolved via the cached members map).
argument-hint: "<projectId> <taskId> <email>"
---

Read `~/.config/clickup-tracker/config.json` for `base_url`, `default_org_id`, `auth_token`.

```bash
BASE=$(jq -r .base_url ~/.config/clickup-tracker/config.json)
ORG=$(jq -r .default_org_id ~/.config/clickup-tracker/config.json)
AUTH=$(jq -r .auth_token ~/.config/clickup-tracker/config.json)
PROJECT_ID="${1:?projectId required}"
TASK_ID="${2:?taskId required}"
EMAIL="${3:?email required}"

BODY=$(jq -nc --arg e "$EMAIL" '{ email: $e }')

curl -fsS -X POST \
  -H "Authorization: Bearer $AUTH" \
  -H "X-Organisation-Id: $ORG" \
  -H "Content-Type: application/json" \
  -d "$BODY" \
  "${BASE%/}/projects/${PROJECT_ID}/tasks/${TASK_ID}/assign" | jq .
```

If the response is `{ "ok": false, "reason": "email_not_in_workspace" }`, the email isn't in the cached members map — confirm the user is a workspace member, then `/clickup-replan <projectId>` to refresh the cache.
