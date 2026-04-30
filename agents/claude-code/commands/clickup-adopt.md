---
description: Explicitly adopt an existing ClickUp Space as a tracked project (Plan §B.2). Hydrates list_ids/sprint_lists/task_index from the Space's contents — does NOT recreate tasks. Use when /clickup-lookup found a strong match, or when the operator already knows the Space ID.
argument-hint: "<spaceId> [path/to/repo]"
---

Read `~/.config/clickup-tracker/config.json` for `base_url`, `default_org_id`, `auth_token`. If absent, run `bash scripts/self-setup.sh` first.

`$1` is the ClickUp Space ID. `$2` defaults to `$(pwd)`.

```bash
BASE=$(jq -r .base_url ~/.config/clickup-tracker/config.json)
ORG=$(jq -r .default_org_id ~/.config/clickup-tracker/config.json)
AUTH=$(jq -r .auth_token ~/.config/clickup-tracker/config.json)
SPACE_ID="$1"
LOCAL_PATH="${2:-$(pwd)}"
DISPLAY_NAME=$(basename "$LOCAL_PATH")
REMOTE=$(git -C "$LOCAL_PATH" config --get remote.origin.url 2>/dev/null)

BODY=$(jq -nc \
  --arg p "$LOCAL_PATH" \
  --arg n "$DISPLAY_NAME" \
  --arg s "$SPACE_ID" \
  --arg r "$REMOTE" \
  '{ localPath: $p, displayName: $n, clickupSpaceId: $s }
   + (if $r != "" then { gitRemoteUrl: $r } else {} end)')

curl -fsS -X POST \
  -H "Authorization: Bearer $AUTH" \
  -H "X-Organisation-Id: $ORG" \
  -H "Content-Type: application/json" \
  -d "$BODY" \
  "${BASE%/}/projects/adopt"
```

Report from the JSON response:

1. `projectId` — save it.
2. `hookSecret` — surface ONCE; user must save (not re-readable).
3. `taskIndexCount` — number of existing auto-imported tasks claimed.
4. `extraLists` / `extraFolders` — anything in the Space the daemon will leave alone.
5. `folderUrl` and `spaceUrl` for navigation.

Then install the post-commit hook (same as /clickup-add):

```bash
bash "${CUP_REPO_ROOT:?set CUP_REPO_ROOT}/scripts/install-git-hook.sh" \
  --repo "$LOCAL_PATH" \
  --project-id "<projectId>" \
  --hook-secret "<hookSecret>" \
  --base "$BASE"
```
