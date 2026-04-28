#!/usr/bin/env bash
# clickup-stop-sync.sh — Stop hook installed by clickup-tracker.
# Reads the just-finished Claude Code session, resolves which tracked
# project it touched, and POSTs a prompt-event to the daemon.
#
# Triggered by ~/.claude/settings.json `hooks.Stop[]`. Receives a JSON
# payload on stdin; key fields used: `transcript_path`, `cwd`.
#
# Always exits 0 — never block Claude Code's exit on networking trouble.

set -uo pipefail

CONFIG_FILE="${HOME}/.config/clickup-tracker/config.json"
[[ -f "$CONFIG_FILE" ]] || exit 0

# base_url points at the standalone daemon (default :4020). No fallback —
# if it's missing or empty, the hook silently skips. This keeps user
# environments that haven't run /clickup-add yet from spamming curl errors.
BASE_URL=$(jq -r '.base_url // empty' "$CONFIG_FILE" 2>/dev/null || echo "")
ORG_ID=$(jq -r '.default_org_id // empty' "$CONFIG_FILE" 2>/dev/null || echo "")
AUTH=$(jq -r '.auth_token // empty' "$CONFIG_FILE" 2>/dev/null || echo "")
SECRETS_DIR="${HOME}/.config/clickup-tracker/projects"

[[ -z "$BASE_URL" || -z "$ORG_ID" ]] && exit 0

stdin_json=$(cat 2>/dev/null || echo "{}")
transcript=$(echo "$stdin_json" | jq -r '.transcript_path // empty' 2>/dev/null || echo "")
cwd=$(echo "$stdin_json" | jq -r '.cwd // empty' 2>/dev/null || echo "")
session_id=$(echo "$stdin_json" | jq -r '.session_id // empty' 2>/dev/null || echo "")

if [[ -z "$cwd" ]]; then cwd=$(pwd); fi

# Resolve which tracked project (if any) owns this CWD.
AUTH_HEADER=()
[[ -n "$AUTH" ]] && AUTH_HEADER=(-H "Authorization: Bearer ${AUTH}")

resolved=$(curl -fsS -m 5 \
  "${AUTH_HEADER[@]}" \
  -H "X-Organisation-Id: ${ORG_ID}" \
  "${BASE_URL%/}/projects/resolve?path=$(printf '%s' "$cwd" | jq -sRr @uri)" \
  2>/dev/null || echo '{"match":null}')

project_id=$(echo "$resolved" | jq -r '.match.id // empty' 2>/dev/null || echo "")
[[ -z "$project_id" ]] && exit 0

# Compute files-touched + outcome summary from the session transcript.
files_touched="[]"
outcome=""
if [[ -n "$transcript" && -f "$transcript" ]]; then
  files_touched=$(jq -sR '
    split("\n") | map(select(length > 0) | fromjson?) |
    [ .[] | (.. | objects | (.file_path? // .path?) // empty) ] |
    map(select(. != null and . != "")) | unique |
    map({path: ., status: "modified"}) | .[0:50]
  ' "$transcript" 2>/dev/null || echo "[]")

  outcome=$(jq -sR '
    split("\n") | map(select(length > 0) | fromjson?) |
    [ .[] | select(.message?.role == "assistant") | .message.content?[]?.text? // empty ] |
    last // ""
  ' "$transcript" 2>/dev/null || echo "")
  outcome="${outcome:0:1000}"
fi

body=$(jq -nc \
  --arg session "$session_id" \
  --arg outcome "$outcome" \
  --argjson files "$files_touched" \
  '{ session_id: $session, outcome_summary: $outcome, files_touched: $files }')

# Sign with the project's hook_secret (cached locally by install-git-hook.sh).
# The daemon's GitHmacGuard validates against the same column, so Stop-hook
# events authenticate the same way as post-commit events.
SECRET_FILE="${SECRETS_DIR}/${project_id}.secret"
if [[ ! -f "$SECRET_FILE" ]]; then
  # No cached secret means this project's git hook was never installed on this
  # machine — silently skip; the next /clickup-add will plant the secret.
  exit 0
fi
HOOK_SECRET=$(cat "$SECRET_FILE")
[[ -z "$HOOK_SECRET" ]] && exit 0

now=$(date +%s)
sig="sha256=$(printf '%s' "$body" | openssl dgst -sha256 -hmac "$HOOK_SECRET" -hex | awk '{print $2}')"

curl -fsS -m 8 \
  -H "Content-Type: application/json" \
  -H "X-CUP-Project-ID: ${project_id}" \
  -H "X-CUP-Timestamp: ${now}" \
  -H "X-CUP-Signature: ${sig}" \
  -H "X-CUP-Idempotency-Key: ${project_id}:${session_id}:${now}" \
  -d "$body" \
  "${BASE_URL%/}/public/prompt-events" > /dev/null 2>&1 || true

exit 0
