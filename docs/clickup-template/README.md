# Workspace template walkthrough

ClickUp v2 silently ignores `statuses` on `createSpace`, `PUT /space`, and `PUT /list`. Custom Space statuses cannot be set programmatically — they require a manual UI walkthrough.

By default every per-repo Space ships with `template_status='inline-fallback'`, which makes the daemon coerce the planned 7-status workflow down to ClickUp's default 2-status set (`to do` | `complete`). This works, but the UI looks bare.

This walkthrough flips the workspace to the full 7-status cascade and tells the daemon to use the literal status names from then on.

---

## Prerequisites

- You're a Workspace owner or admin in the ClickUp workspace.
- The standalone daemon is running.
- One per-repo Space already exists (run `bash scripts/wipe-and-rereg.sh <projectId> <localPath>` if not).

## Step 1 — Set Space-level statuses

Open the Space sidebar in ClickUp → click the **⋯** next to the Space name → **Statuses**.

Replace the default `to do | complete` with:

| Order | Status | Type |
|---|---|---|
| 0 | Backlog | Open |
| 1 | To Do | Open |
| 2 | In Progress | Custom |
| 3 | In Review | Custom |
| 4 | Blocked | Custom |
| 5 | Done | Done |
| 6 | Archived | Closed |

Recommended colours: `#87909e`, `#3397dd`, `#ffb84d`, `#a875ff`, `#e50000`, `#2ecd6f`, `#6f7782`.

When you save, ClickUp asks whether to apply the new set to **all child Folders/Lists** — say yes.

## Step 2 — Override the Bugs List

Open `📦 Backlog & Bugs › Bugs` → ⋯ → **Statuses → Use custom** → set:

| Order | Status | Type |
|---|---|---|
| 0 | Reported | Open |
| 1 | Triaged | Custom |
| 2 | Fixing | Custom |
| 3 | Verifying | Custom |
| 4 | Closed | Done |
| 5 | Won't Fix | Closed |

## Step 3 — Tell the daemon

```bash
BASE=$(jq -r .base_url ~/.config/clickup-tracker/config.json)
ORG=$(jq -r .default_org_id ~/.config/clickup-tracker/config.json)
AUTH=$(jq -r .auth_token ~/.config/clickup-tracker/config.json)
PROJECT_ID="<your-project-id>"

curl -fsS -X POST \
  -H "Authorization: Bearer $AUTH" \
  -H "X-Organisation-Id: $ORG" \
  "${BASE%/}/projects/${PROJECT_ID}/template-configured"
```

Response:
```json
{ "ok": true, "template_status": "configured" }
```

From the next commit onwards the daemon emits `Done` / `In Review` / `Backlog` literally instead of mapping to `complete` / `to do`. Existing tasks are not migrated — only new writes pick up the change.

## Verifying

Make an empty commit and watch:

```bash
git commit --allow-empty -m "feat(verify): template upgrade"
sleep 3
curl -fsS -H "Authorization: $AUTH_TOK" \
  "https://api.clickup.com/api/v2/list/<active-sprint-list-id>" \
  | jq '.statuses[] | .status'
```

You should see all 7 names. The new commit task lands at `Done` (not `complete`).

## Reverting

If you ever revert the workspace to the default 2-status set, also flip the daemon back:

```sql
UPDATE clickup_tracker.projects SET template_status = 'inline-fallback' WHERE id = '<projectId>';
```

(There's no `template-unconfigured` endpoint by design — it's a one-way upgrade in normal operation.)

## Per-workspace, not per-project

ClickUp statuses cascade at Space level, but the daemon stores `template_status` per project. If you upgrade once and re-register the same repo later, the new project row defaults back to `inline-fallback` — re-run Step 3 against the new `projectId`.
