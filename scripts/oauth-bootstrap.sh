#!/usr/bin/env bash
# oauth-bootstrap.sh — one-shot ClickUp OAuth dance.
#
# For users whose ClickUp account doesn't allow personal API tokens
# (workspace-restricted accounts), or who'd rather authenticate via an
# OAuth app. Exchanges a ClickUp OAuth client_id+client_secret for an
# access_token, then writes the token into .env as CLICKUP_API_TOKEN.
#
# The daemon doesn't care how the token was obtained — ClickUp OAuth
# access tokens use the same `Authorization: <token>` header as personal
# tokens, so once the token is in .env the daemon works as-is.
#
# Prerequisites:
#   - python3 (no extra packages — uses stdlib http.server + urllib)
#   - A ClickUp OAuth app: https://app.clickup.com/settings/apps
#     - Redirect URL: http://localhost:8765 (or whatever you pick)
#     - You'll get a Client ID and Client Secret
#
# Usage:
#   bash scripts/oauth-bootstrap.sh
#
# Reads from .env (or env vars):
#   CLICKUP_CLIENT_ID, CLICKUP_CLIENT_SECRET, CLICKUP_REDIRECT_URI
#
# Writes to .env:
#   CLICKUP_API_TOKEN=<access_token>
#   CLICKUP_TEAM_ID=<workspace id, auto-detected from /api/v2/team>
#   CLICKUP_TEAM_NAME=<workspace name>

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
cd "$ROOT"

# Load .env into env so OAuth fields are picked up
if [ -f .env ]; then
  set -a; . ./.env; set +a
fi

: "${CLICKUP_CLIENT_ID:?Set CLICKUP_CLIENT_ID in .env or env (your OAuth app Client ID)}"
: "${CLICKUP_CLIENT_SECRET:?Set CLICKUP_CLIENT_SECRET in .env or env}"
REDIRECT="${CLICKUP_REDIRECT_URI:-http://localhost:8765}"

# Extract port from redirect URI (so users can use a non-default port if their app demands)
PORT=$(printf '%s' "$REDIRECT" | sed -nE 's|.*://[^/]+:([0-9]+).*|\1|p')
PORT="${PORT:-8765}"

if ! command -v python3 >/dev/null 2>&1; then
  echo "✗ python3 not found — required for the OAuth callback listener" >&2
  exit 1
fi

if ss -tln 2>/dev/null | grep -q ":${PORT} "; then
  echo "✗ port :${PORT} is already in use — close whatever is bound to it and retry" >&2
  exit 1
fi

TOKEN_FILE="$(mktemp -u /tmp/cup-oauth-token-XXXXXX)"
trap 'rm -f "$TOKEN_FILE"' EXIT

CUP_CLIENT_ID="$CLICKUP_CLIENT_ID" \
CUP_CLIENT_SECRET="$CLICKUP_CLIENT_SECRET" \
CUP_REDIRECT_URI="$REDIRECT" \
CUP_TOKEN_OUT="$TOKEN_FILE" \
python3 "$SCRIPT_DIR/oauth-bootstrap.py"

if [ ! -s "$TOKEN_FILE" ]; then
  echo "✗ no token captured — see error above" >&2
  exit 1
fi

TOKEN=$(cat "$TOKEN_FILE")

# Auto-detect team id (so users don't have to look it up)
echo "→ fetching workspace list from ClickUp"
TEAMS_JSON=$(curl -fsS -H "Authorization: $TOKEN" https://api.clickup.com/api/v2/team)
TEAM_COUNT=$(printf '%s' "$TEAMS_JSON" | jq '.teams | length')

if [ "$TEAM_COUNT" -eq 0 ]; then
  echo "✗ OAuth token has no workspace access — re-run authorization and pick a workspace" >&2
  exit 1
elif [ "$TEAM_COUNT" -eq 1 ]; then
  TEAM_ID=$(printf '%s' "$TEAMS_JSON" | jq -r '.teams[0].id')
  TEAM_NAME=$(printf '%s' "$TEAMS_JSON" | jq -r '.teams[0].name')
  echo "✓ single workspace found: \"$TEAM_NAME\" (id=$TEAM_ID)"
else
  echo "→ multiple workspaces accessible — pick one:"
  printf '%s' "$TEAMS_JSON" | jq -r '.teams | to_entries[] | "  [\(.key)] \(.value.name) (id=\(.value.id))"'
  read -r -p "Index: " IDX
  TEAM_ID=$(printf '%s' "$TEAMS_JSON" | jq -r --argjson i "$IDX" '.teams[$i].id')
  TEAM_NAME=$(printf '%s' "$TEAMS_JSON" | jq -r --argjson i "$IDX" '.teams[$i].name')
fi

# Update .env
[ -f .env ] || cp .env.example .env
cp .env ".env.bak.$(date +%Y%m%d%H%M%S)"
upsert() {
  local key="$1" val="$2"
  if grep -qE "^${key}=" .env; then
    awk -v k="$key" -v v="$val" 'BEGIN{FS=OFS="="} $1==k{print k "=" v; next} {print}' .env > .env.tmp && mv .env.tmp .env
  else
    printf '\n%s=%s\n' "$key" "$val" >> .env
  fi
}
upsert CLICKUP_API_TOKEN "$TOKEN"
upsert CLICKUP_TEAM_ID "$TEAM_ID"
upsert CLICKUP_TEAM_NAME "$TEAM_NAME"

echo
echo "✓ .env updated:"
grep -E '^CLICKUP_(API_TOKEN|TEAM_ID|TEAM_NAME)=' .env | sed 's/CLICKUP_API_TOKEN=.*/CLICKUP_API_TOKEN=<set>/'
echo
echo "Now restart the daemon so it picks up the new token:"
echo "  docker compose up -d --force-recreate clickup-tracker"
