---
description: Flip a project's template_status to 'configured' after the manual ClickUp UI walkthrough adds the 7-status workflow. From now on the daemon emits literal status names ('Done' / 'In Review' / 'Backlog') instead of mapping down to 'to do' / 'complete'.
argument-hint: "<projectId>"
---

Prerequisite: complete the manual UI walkthrough in `docs/clickup-template/README.md` first (set Space-level statuses + Bugs List override). This endpoint is the daemon-side flip — it does NOT change ClickUp itself.

```bash
BASE=$(jq -r .base_url ~/.config/clickup-tracker/config.json)
ORG=$(jq -r .default_org_id ~/.config/clickup-tracker/config.json)
AUTH=$(jq -r .auth_token ~/.config/clickup-tracker/config.json)
PROJECT_ID="${1:?projectId required}"

curl -fsS -X POST \
  -H "Authorization: Bearer $AUTH" \
  -H "X-Organisation-Id: $ORG" \
  "${BASE%/}/projects/${PROJECT_ID}/template-configured" | jq .
```

Expected response: `{ "ok": true, "template_status": "configured" }`. Existing tasks are not migrated — only new writes pick up the change.
