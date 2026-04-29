---
description: Register the current repo with the clickup-tracker daemon. Creates a per-repo ClickUp Space asynchronously (full agency-style structure with sprints, ADRs, Doc, native fields).
argument-hint: "[path/to/repo]"
---

Read `~/.config/clickup-tracker/config.json` for `base_url`, `default_org_id`, `auth_token`. If absent, tell the user to run `bash scripts/self-setup.sh` from the clickup-tracker-standalone repo first.

Use `${1:-$(pwd)}` as `LOCAL_PATH`. Send a per-repo Space registration; the daemon runs the backfill orchestrator asynchronously.

```bash
BASE=$(jq -r .base_url ~/.config/clickup-tracker/config.json)
ORG=$(jq -r .default_org_id ~/.config/clickup-tracker/config.json)
AUTH=$(jq -r .auth_token ~/.config/clickup-tracker/config.json)
LOCAL_PATH="${1:-$(pwd)}"
DISPLAY_NAME=$(basename "$LOCAL_PATH")

BODY=$(jq -nc --arg p "$LOCAL_PATH" --arg n "$DISPLAY_NAME" \
  '{ localPath: $p, displayName: $n, backfillMode: "space" }')

curl -fsS -X POST \
  -H "Authorization: Bearer $AUTH" \
  -H "X-Organisation-Id: $ORG" \
  -H "Content-Type: application/json" \
  -d "$BODY" \
  "${BASE%/}/projects"
```

Report from the JSON response:

1. `projectId` — save it.
2. `hookSecret` — surface ONCE, must be saved by the user; not re-readable.
3. `folderUrl` and `spaceUrl` may be empty initially — they're populated when the backfill finishes.
4. If `alreadyTracked: true`, just print the existing `folderUrl` (no new project created).

After the response lands, suggest the user run `/clickup-backfill-status` to watch the orchestrator complete.

If `hookSecret` is non-empty, also install the post-commit hook. `$CUP_REPO_ROOT` should point at the local clickup-tracker-standalone clone (set in your shell rc, or pass the absolute path inline):

```bash
bash "${CUP_REPO_ROOT:?set CUP_REPO_ROOT to the clickup-tracker-standalone repo path}/scripts/install-git-hook.sh" \
  --repo "$LOCAL_PATH" \
  --project-id "<projectId from response>" \
  --hook-secret "<hookSecret from response>" \
  --base "$BASE"
```

If the response's `scopeConfig.mode == "subdir"`, also pass `--scope-mode subdir --scope-paths "<comma-joined scopeConfig.paths>"` so the hook skips the POST entirely on commits that don't touch any tracked path. The daemon enforces the same filter authoritatively; the hook flag is just a faster early-out.
