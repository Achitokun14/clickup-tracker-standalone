---
description: Register the current repo with the clickup-tracker daemon. Creates Folder + 3 Lists in ClickUp.
argument-hint: "[path/to/repo]"
---

Read `~/.config/clickup-tracker/config.json` for `base_url`, `default_org_id`, `auth_token`. If absent, tell the user to run `bash scripts/self-setup.sh` from the clickup-tracker-standalone repo first.

Use `${1:-$(pwd)}` as `LOCAL_PATH`. Compose a registration body — extract the repo's display name from the path basename, optionally pull README/CHANGELOG content as the `extract` field. Then:

```bash
BASE=$(jq -r .base_url ~/.config/clickup-tracker/config.json)
ORG=$(jq -r .default_org_id ~/.config/clickup-tracker/config.json)
AUTH=$(jq -r .auth_token ~/.config/clickup-tracker/config.json)
LOCAL_PATH="${1:-$(pwd)}"
DISPLAY_NAME=$(basename "$LOCAL_PATH")

BODY=$(jq -nc --arg p "$LOCAL_PATH" --arg n "$DISPLAY_NAME" \
  '{ localPath: $p, displayName: $n }')

curl -fsS -X POST \
  -H "Authorization: Bearer $AUTH" \
  -H "X-Organisation-Id: $ORG" \
  -H "Content-Type: application/json" \
  -d "$BODY" \
  "${BASE%/}/projects"
```

Report from the JSON response:

1. `folderUrl`
2. `taskCount`
3. `hookSecret` — surface ONCE, must be saved by the user; not re-readable.
4. If `alreadyTracked: true`, just print the existing folderUrl (no bulk-create happened).

If `hookSecret` is non-empty, also install the post-commit hook. `$CUP_REPO_ROOT` should point at the local clickup-tracker-standalone clone (set in your shell rc, or pass the absolute path inline):

```bash
bash "${CUP_REPO_ROOT:?set CUP_REPO_ROOT to the clickup-tracker-standalone repo path}/scripts/install-git-hook.sh" \
  --repo "$LOCAL_PATH" \
  --project-id "<projectId from response>" \
  --hook-secret "<hookSecret from response>" \
  --base "$BASE"
```
