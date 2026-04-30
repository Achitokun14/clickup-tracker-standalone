---
description: One-shot cleanup of duplicate commit-task entries + misrouted In-Review tasks (Plan §A.4). Defaults to dryRun=true — pass `mutate` as the second arg to actually archive + move.
argument-hint: "<projectId> [mutate]"
---

Read `~/.config/clickup-tracker/config.json` for `base_url`, `default_org_id`, `auth_token`.

```bash
BASE=$(jq -r .base_url ~/.config/clickup-tracker/config.json)
ORG=$(jq -r .default_org_id ~/.config/clickup-tracker/config.json)
AUTH=$(jq -r .auth_token ~/.config/clickup-tracker/config.json)
PID="$1"
DRY_RUN="true"
[ "$2" = "mutate" ] && DRY_RUN="false"

curl -fsS -X POST \
  -H "Authorization: Bearer $AUTH" \
  -H "X-Organisation-Id: $ORG" \
  "${BASE%/}/projects/${PID}/repair-routing?dryRun=${DRY_RUN}"
```

Report from the response:

- `dryRun` — whether the call mutated.
- `candidatesScanned` / `groupsScanned` — how much surface was inspected.
- `archive[]` — non-canonical commit-task duplicates (those NOT in `task_index`).
- `move[]` — default-branch In-Review survivors that should land in the current sprint List + Done.
- `errors[]` — anything that failed (non-fatal during scan).

**Always run with `dryRun=true` first** so the user reviews the plan. Only re-run with `mutate` after they confirm.
