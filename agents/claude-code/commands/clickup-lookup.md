---
description: List candidate ClickUp Spaces in the workspace that might already be tracking this repo (Plan §B.1). Use before /clickup-add to avoid creating duplicate Spaces in shared workspaces.
argument-hint: "[displayName] [gitRemoteUrl]"
---

Read `~/.config/clickup-tracker/config.json` for `base_url`, `default_org_id`, `auth_token`. If absent, tell the user to run `bash scripts/self-setup.sh` from the clickup-tracker-standalone repo first.

Default `displayName` to `$(basename "$(pwd)")` and `gitRemoteUrl` to `$(git -C "$(pwd)" config --get remote.origin.url)` if either is omitted.

```bash
BASE=$(jq -r .base_url ~/.config/clickup-tracker/config.json)
ORG=$(jq -r .default_org_id ~/.config/clickup-tracker/config.json)
AUTH=$(jq -r .auth_token ~/.config/clickup-tracker/config.json)
DISPLAY_NAME="${1:-$(basename "$(pwd)")}"
REMOTE="${2:-$(git -C "$(pwd)" config --get remote.origin.url 2>/dev/null)}"

QS="displayName=$(printf '%s' "$DISPLAY_NAME" | jq -sRr @uri)"
if [ -n "$REMOTE" ]; then
  QS="$QS&gitRemoteUrl=$(printf '%s' "$REMOTE" | jq -sRr @uri)"
fi

curl -fsS \
  -H "Authorization: Bearer $AUTH" \
  -H "X-Organisation-Id: $ORG" \
  "${BASE%/}/projects/lookup?${QS}"
```

Report:

- If `matches` is empty: no candidate Space found — safe to run `/clickup-add`.
- If a single **strong** match exists: suggest `/clickup-adopt <spaceId>`. The user almost certainly wants this.
- If multiple **strong** or **medium** matches: list them with `spaceName`, `strength`, `reason`. Ask the user which one to adopt (or `/clickup-add` to create a new one anyway).
- If only **weak** matches: lean toward `/clickup-add` but show the candidates in case the user wants to adopt by name.

Pass `?scanFooters=true` for the most reliable match (scans first-page task descriptions for `Remote: <url>` footer; one extra round-trip per candidate) — the default is shallow + 60s-cached.
