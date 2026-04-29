---
description: Show clickup-tracker status for the current repo (registered? last sync? recent commits ingested?).
argument-hint: ""
---

Read `~/.config/clickup-tracker/config.json` for `base_url`, `default_org_id`, and `auth_token`. If the file doesn't exist, tell the user to run `bash scripts/self-setup.sh` from the clickup-tracker-standalone repo first.

Then run, with `$(pwd)` as the candidate path:

```bash
BASE=$(jq -r .base_url ~/.config/clickup-tracker/config.json)
ORG=$(jq -r .default_org_id ~/.config/clickup-tracker/config.json)
AUTH=$(jq -r .auth_token ~/.config/clickup-tracker/config.json)
curl -fsS -H "Authorization: Bearer $AUTH" -H "X-Organisation-Id: $ORG" \
  "${BASE%/}/projects/resolve?path=$(printf '%s' "$(pwd)" | jq -sRr @uri)"
```

Report:

- If `match` is null: this directory is not registered. Suggest `/clickup-add`.
- If `match.id` is set: the ClickUp Folder URL (look up with `GET /projects/<id>`), `lastSyncedAt`, and the project status (`active` / `paused`). Also fetch `GET /projects/<id>/backfill` — if `status` is `queued` or `running`, surface the `processed/total` and remind the user that `/clickup-backfill-status <id>` polls live progress.
