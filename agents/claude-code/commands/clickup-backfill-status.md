---
description: Show the current backfill_state for a tracked project (queued / running / done / failed + processed/total).
argument-hint: "<projectId>"
---

Read `~/.config/clickup-tracker/config.json` for `base_url`, `default_org_id`, `auth_token`.

```bash
BASE=$(jq -r .base_url ~/.config/clickup-tracker/config.json)
ORG=$(jq -r .default_org_id ~/.config/clickup-tracker/config.json)
AUTH=$(jq -r .auth_token ~/.config/clickup-tracker/config.json)
PROJECT_ID="${1:?projectId required}"

curl -fsS \
  -H "Authorization: Bearer $AUTH" \
  -H "X-Organisation-Id: $ORG" \
  "${BASE%/}/projects/${PROJECT_ID}/backfill" | jq .
```

Report:

- `status`: `queued | running | done | failed`
- `processed / total`: backfill progress
- `last_sha` and `last_list`: most recent checkpoint
- `space_url` and `folder_url`: only set after `done`
- `error_message`: only set on `failed`

If `status === "running"`, tell the user the orchestrator is still walking the SpacePlan and to re-run this command in ~30 s. If `done`, surface `space_url` and tell them to open it. If `failed`, show `error_message` and suggest `/clickup-replan` after fixing the underlying issue.
