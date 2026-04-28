#!/usr/bin/env bash
# clickup-prompt-context.sh — UserPromptSubmit hook installed by
# clickup-tracker. If the current CWD is a tracked project, prepends a
# one-line system note to the user's prompt so Claude knows about it.
#
# Stdin: JSON `{ "prompt": "...", "cwd": "..." }`.
# Stdout: JSON `{ "prompt": "<augmented>" }` to mutate the prompt, or
#         empty to leave it untouched.
#
# Always exits 0.

set -uo pipefail

CONFIG_FILE="${HOME}/.config/clickup-tracker/config.json"
[[ -f "$CONFIG_FILE" ]] || exit 0

BASE_URL=$(jq -r '.base_url // empty' "$CONFIG_FILE" 2>/dev/null || echo "")
ORG_ID=$(jq -r '.default_org_id // empty' "$CONFIG_FILE" 2>/dev/null || echo "")
AUTH=$(jq -r '.auth_token // empty' "$CONFIG_FILE" 2>/dev/null || echo "")

[[ -z "$BASE_URL" || -z "$ORG_ID" ]] && exit 0

stdin_json=$(cat 2>/dev/null || echo "{}")
prompt=$(echo "$stdin_json" | jq -r '.prompt // empty' 2>/dev/null || echo "")
cwd=$(echo "$stdin_json" | jq -r '.cwd // empty' 2>/dev/null || echo "")
[[ -z "$cwd" ]] && cwd=$(pwd)
[[ -z "$prompt" ]] && exit 0

AUTH_HEADER=()
[[ -n "$AUTH" ]] && AUTH_HEADER=(-H "Authorization: Bearer ${AUTH}")

resolved=$(curl -fsS -m 3 \
  "${AUTH_HEADER[@]}" \
  -H "X-Organisation-Id: ${ORG_ID}" \
  "${BASE_URL%/}/projects/resolve?path=$(printf '%s' "$cwd" | jq -sRr @uri)" \
  2>/dev/null || echo '{"match":null}')

display_name=$(echo "$resolved" | jq -r '.match.displayName // empty' 2>/dev/null || echo "")
project_id=$(echo "$resolved" | jq -r '.match.id // empty' 2>/dev/null || echo "")

[[ -z "$project_id" ]] && exit 0

note="[clickup-tracker] this repo is mirrored as ClickUp project \"${display_name}\" (id: ${project_id}). commits are auto-synced; use /clickup-status for details."
augmented=$(jq -nc --arg n "$note" --arg p "$prompt" '{prompt: ($n + "\n\n" + $p)}')
echo "$augmented"
exit 0
