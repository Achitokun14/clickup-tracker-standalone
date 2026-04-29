#!/usr/bin/env bash
# self-setup.sh — bootstrap the standalone clickup-tracker stack.
#
# Idempotent. Safe to re-run.
#
# Steps:
#   1. Ensure .env exists (creates from .env.example if missing).
#   2. docker compose up -d.
#   3. Wait for /health.
#   4. (Optional --install-claude-hooks) drop slash commands + hooks
#      into ~/.claude/, idempotently.
#
# Usage:
#   bash scripts/self-setup.sh
#   bash scripts/self-setup.sh --install-claude-hooks
#   bash scripts/self-setup.sh --skip-docker

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
INSTALL_CLAUDE=0
SKIP_DOCKER=0

while [[ $# -gt 0 ]]; do
  case "$1" in
    --install-claude-hooks) INSTALL_CLAUDE=1; shift ;;
    --skip-docker)          SKIP_DOCKER=1; shift ;;
    -h|--help)
      sed -n '2,16p' "${BASH_SOURCE[0]}"
      exit 0 ;;
    *) echo "unknown arg: $1" >&2; exit 2 ;;
  esac
done

cd "$ROOT"

# 1. .env ----------------------------------------------------------------
if [[ ! -f .env ]]; then
  cp .env.example .env
  echo "✓ created .env from .env.example — open it and fill in CLICKUP_API_TOKEN + CLICKUP_TEAM_ID"
  echo "  then re-run this script."
  exit 0
fi

# 2. docker compose -------------------------------------------------------
TRACKER_PORT="$(grep -E '^TRACKER_PORT=' .env | cut -d= -f2 | tr -d ' ')"
TRACKER_PORT="${TRACKER_PORT:-4020}"

if [[ $SKIP_DOCKER -eq 0 ]]; then
  command -v docker >/dev/null 2>&1 || { echo "docker not found" >&2; exit 1; }
  docker info >/dev/null 2>&1 || { echo "docker daemon not running" >&2; exit 1; }
  echo "→ docker compose up -d --build"
  docker compose up -d --build

  URL="http://localhost:${TRACKER_PORT}/health"
  echo "→ waiting for ${URL}…"
  for i in $(seq 1 30); do
    if curl -fsS -m 2 "$URL" >/dev/null 2>&1; then
      echo "✓ /health 200 (took ${i}s)"
      break
    fi
    sleep 1
    [[ $i -eq 30 ]] && { echo "× /health did not respond after 30s — try: docker compose logs clickup-tracker" >&2; exit 1; }
  done
fi

# 4. Claude Code hooks (optional) ----------------------------------------
if [[ $INSTALL_CLAUDE -eq 1 ]]; then
  CLAUDE_HOME="${CLAUDE_HOME:-$HOME/.claude}"
  CMDS="$CLAUDE_HOME/commands"
  HOOKS="$CLAUDE_HOME/hooks"
  mkdir -p "$CMDS" "$HOOKS"

  for f in "$ROOT/agents/claude-code/commands/"*.md; do
    name="$(basename "$f")"
    dst="$CMDS/$name"
    if [[ -f "$dst" ]]; then
      echo "= $dst exists — leaving as-is"
    else
      cp "$f" "$dst"; echo "+ $dst"
    fi
  done
  for f in "$ROOT/agents/claude-code/hooks/"*.sh; do
    name="$(basename "$f")"
    dst="$HOOKS/$name"
    if [[ -f "$dst" ]]; then
      echo "= $dst exists — leaving as-is"
    else
      cp "$f" "$dst"; chmod +x "$dst"; echo "+ $dst"
    fi
  done

  SETTINGS="$CLAUDE_HOME/settings.json"
  if [[ -f "$SETTINGS" ]] && command -v jq >/dev/null 2>&1; then
    TMP="$SETTINGS.cup-tracker.tmp"
    STOP_CMD="$HOOKS/clickup-stop-sync.sh"
    PROMPT_CMD="$HOOKS/clickup-prompt-context.sh"
    jq --arg s "$STOP_CMD" --arg p "$PROMPT_CMD" '
      .hooks //= {} |
      .hooks.Stop //= [] |
      .hooks.UserPromptSubmit //= [] |
      (if any(.hooks.Stop[]?; (.hooks // []) | any(.command == $s))
         then . else .hooks.Stop += [{hooks: [{type: "command", command: $s}]}] end) |
      (if any(.hooks.UserPromptSubmit[]?; (.hooks // []) | any(.command == $p))
         then . else .hooks.UserPromptSubmit += [{hooks: [{type: "command", command: $p}]}] end)
    ' "$SETTINGS" > "$TMP" && mv "$TMP" "$SETTINGS"
    echo "✓ patched $SETTINGS (idempotent)"
  else
    echo "= skipping settings.json patch (no jq or no existing settings)"
  fi
fi

cat <<EOF

✓ standalone clickup-tracker is up.
  Health:  http://localhost:${TRACKER_PORT}/health
  OpenAPI: http://localhost:${TRACKER_PORT}/public/openapi.yaml

Register a repo:
  curl -X POST http://localhost:${TRACKER_PORT}/projects \\
    -H 'Content-Type: application/json' \\
    -d '{"localPath":"/path/to/repo","displayName":"My Project"}'

Then drop the post-commit hook into the repo:
  bash scripts/install-git-hook.sh \\
    --repo /path/to/repo \\
    --project-id <id-from-register> \\
    --hook-secret <secret-from-register>
EOF
