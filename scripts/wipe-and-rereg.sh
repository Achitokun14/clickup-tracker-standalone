#!/usr/bin/env bash
# Wipe an existing project (DELETE /projects/:id?wipe=true) and re-register it
# in per-repo Space mode (POST /projects with backfillMode=space). Then poll
# GET /projects/:id/backfill until status is done | failed.
#
# Usage:
#   bash scripts/wipe-and-rereg.sh <projectId> <localPath>
#
# Reads ${BASE} (or ~/.config/clickup-tracker/config.json), ${ORG}, ${AUTH}.

set -euo pipefail

PROJECT_ID="${1:?projectId required}"
LOCAL_PATH="${2:?localPath required}"

CONFIG="${HOME}/.config/clickup-tracker/config.json"
if [[ -z "${BASE:-}" || -z "${ORG:-}" || -z "${AUTH:-}" ]] && [[ -f "$CONFIG" ]]; then
  BASE="${BASE:-$(jq -r .base_url "$CONFIG")}"
  ORG="${ORG:-$(jq -r .default_org_id "$CONFIG")}"
  AUTH="${AUTH:-$(jq -r .auth_token "$CONFIG")}"
fi
: "${BASE:?BASE not set and no config.json}"
: "${ORG:?ORG not set and no config.json}"
: "${AUTH:?AUTH not set and no config.json}"

DISPLAY_NAME="$(basename "$LOCAL_PATH")"
HEADERS=( -H "Authorization: Bearer ${AUTH}" -H "X-Organisation-Id: ${ORG}" -H "Content-Type: application/json" )

echo "→ Wiping project ${PROJECT_ID} (cascades git_events, prompt_events, backups)"
curl -fsS -X DELETE "${HEADERS[@]}" "${BASE%/}/projects/${PROJECT_ID}?wipe=true" | jq .

echo "→ Re-registering ${LOCAL_PATH} as ${DISPLAY_NAME} in per-repo Space mode"
RESP=$(curl -fsS -X POST "${HEADERS[@]}" \
  -d "$(jq -nc --arg p "$LOCAL_PATH" --arg n "$DISPLAY_NAME" \
    '{ localPath: $p, displayName: $n, backfillMode: "space" }')" \
  "${BASE%/}/projects")
echo "$RESP" | jq .

NEW_ID=$(echo "$RESP" | jq -r '.projectId')
HOOK=$(echo "$RESP" | jq -r '.hookSecret')

echo "→ New project id: ${NEW_ID}"
echo "→ Hook secret (save now, never re-issued): ${HOOK}"
echo "→ Polling backfill state every 5 s (Ctrl+C to stop, the worker keeps running)"

while true; do
  STATE=$(curl -fsS "${HEADERS[@]}" "${BASE%/}/projects/${NEW_ID}/backfill" || echo '{"status":"unknown"}')
  STATUS=$(echo "$STATE" | jq -r '.status')
  PROCESSED=$(echo "$STATE" | jq -r '.processed // 0')
  TOTAL=$(echo "$STATE" | jq -r '.total // 0')
  printf "  %-9s  %d/%d\n" "$STATUS" "$PROCESSED" "$TOTAL"
  case "$STATUS" in
    done|failed) break ;;
  esac
  sleep 5
done

echo "→ Final state:"
echo "$STATE" | jq .
