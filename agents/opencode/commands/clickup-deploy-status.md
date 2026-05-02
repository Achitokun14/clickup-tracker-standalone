---
description: Show recent Railway deployments for the current project — latest per env, in-flight builds, and last failure.
argument-hint: "[projectId]"
---

```bash
BASE=$(jq -r .base_url ~/.config/clickup-tracker/config.json)
ORG=$(jq -r .default_org_id ~/.config/clickup-tracker/config.json)
AUTH=$(jq -r .auth_token ~/.config/clickup-tracker/config.json)

PROJECT_ID="${1:-}"
if [ -z "$PROJECT_ID" ]; then
  PROJECT_ID=$(curl -fsS \
    -H "Authorization: Bearer $AUTH" -H "X-Organisation-Id: $ORG" \
    "${BASE%/}/projects/resolve?path=$(printf '%s' "$(pwd)" | jq -sRr @uri)" \
    | jq -r '.match.id // empty')
fi

if [ -z "$PROJECT_ID" ]; then
  echo "No tracked project for $(pwd). Pass a projectId or run /clickup-add."
  exit 1
fi

curl -fsS \
  -H "Authorization: Bearer $AUTH" -H "X-Organisation-Id: $ORG" \
  "${BASE%/}/projects/${PROJECT_ID}/deployments?limit=30" \
  | jq -r '
      def emoji: . as $s
        | if   $s == "SUCCESS"   then "✅"
        elif $s == "FAILED"      then "❌"
        elif $s == "CRASHED"     then "❌"
        elif $s == "CANCELLED"   then "⏸"
        elif $s == "DEPLOYING"   then "🟪"
        elif $s == "BUILDING"    then "🟦"
        elif $s == "QUEUED"      then "⏳"
        else "•" end;

      "## Latest per env",
      (group_by(.environment) | .[]
        | sort_by(.startedAt) | reverse | .[0]
        | "- \(.environment | tostring): \(emoji(.status)) \(.status) · \(.commitSha[0:7] // "no-sha") · \(.startedAt // "—")"),

      "",
      "## In flight",
      (map(select(.status == "BUILDING" or .status == "DEPLOYING" or .status == "QUEUED"))
        | if length == 0 then "_none_"
          else (.[] | "- \(.environment): \(emoji(.status)) \(.status) · \(.commitSha[0:7] // "no-sha")")
          end),

      "",
      "## Last failure per env",
      (map(select(.status == "FAILED" or .status == "CRASHED"))
        | group_by(.environment) | .[]
        | sort_by(.startedAt) | reverse | .[0]
        | "- \(.environment): ❌ \(.commitSha[0:7] // "no-sha") at \(.startedAt // "—")")
    '
```

Output groups deployments three ways: latest per environment, anything currently in flight, and the most recent failure per env. If the table is empty, the project has no Railway binding yet — bind one with:

```bash
curl -fsS -X PATCH \
  -H "Authorization: Bearer $AUTH" -H "X-Organisation-Id: $ORG" \
  -H "Content-Type: application/json" \
  -d '{"railwayProjectId":"<id>","railwayServiceIds":["<svc-id>"]}' \
  "${BASE%/}/projects/${PROJECT_ID}/railway"
```

Then wait up to 2 minutes for the next poll cycle.
