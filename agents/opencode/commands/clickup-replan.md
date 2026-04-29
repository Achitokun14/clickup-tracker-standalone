---
description: Re-run the per-repo Space orchestrator on an existing project. Idempotent — picks up new ADRs, doc refresh, new sprint Lists for new ISO weeks.
argument-hint: "<projectId>"
---

Read `~/.config/clickup-tracker/config.json` for `base_url`, `default_org_id`, `auth_token`.

```bash
BASE=$(jq -r .base_url ~/.config/clickup-tracker/config.json)
ORG=$(jq -r .default_org_id ~/.config/clickup-tracker/config.json)
AUTH=$(jq -r .auth_token ~/.config/clickup-tracker/config.json)
PROJECT_ID="${1:?projectId required}"

curl -fsS -X POST \
  -H "Authorization: Bearer $AUTH" \
  -H "X-Organisation-Id: $ORG" \
  "${BASE%/}/projects/${PROJECT_ID}/replan" | jq .
```

Report the returned `jobId` and tell the user to poll with `/clickup-backfill-status <projectId>`.
