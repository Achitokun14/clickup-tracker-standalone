#!/usr/bin/env bash
# install.sh — drop clickup-tracker slash commands + hooks into a
# Claude-Code-compatible config dir (default $HOME/.claude). Idempotent.
#
# Usage:
#   bash agents/claude-code/install.sh
#   bash agents/claude-code/install.sh --target $HOME/.openclaw
#   bash agents/claude-code/install.sh --uninstall

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"

TARGET="${HOME}/.claude"
MODE=install

while [[ $# -gt 0 ]]; do
  case "$1" in
    --target) TARGET="$2"; shift 2 ;;
    --uninstall) MODE=uninstall; shift ;;
    -h|--help) sed -n '2,11p' "${BASH_SOURCE[0]}"; exit 0 ;;
    *) echo "unknown arg: $1" >&2; exit 2 ;;
  esac
done

CMDS_SRC="$SCRIPT_DIR/commands"
HOOKS_SRC="$SCRIPT_DIR/hooks"
CMDS_DST="$TARGET/commands"
HOOKS_DST="$TARGET/hooks"
SETTINGS="$TARGET/settings.json"

if [[ "$MODE" == "uninstall" ]]; then
  for f in "$CMDS_SRC"/*.md; do
    rm -f "$CMDS_DST/$(basename "$f")" && echo "− $CMDS_DST/$(basename "$f")"
  done
  for f in "$HOOKS_SRC"/*.sh; do
    rm -f "$HOOKS_DST/$(basename "$f")" && echo "− $HOOKS_DST/$(basename "$f")"
  done
  if [[ -f "$SETTINGS" ]] && command -v jq >/dev/null 2>&1; then
    TMP="$SETTINGS.cup-tracker.tmp"
    jq '
      if .hooks then
        .hooks.Stop = [(.hooks.Stop // [])[] | select((.command // "") | test("clickup-stop-sync.sh") | not)] |
        .hooks.UserPromptSubmit = [(.hooks.UserPromptSubmit // [])[] | select((.command // "") | test("clickup-prompt-context.sh") | not)] |
        if .mcpServers then .mcpServers |= del(.["clickup-tracker"]) else . end
      else . end
    ' "$SETTINGS" > "$TMP" && mv "$TMP" "$SETTINGS"
    echo "✓ unpatched $SETTINGS"
  fi
  exit 0
fi

mkdir -p "$CMDS_DST" "$HOOKS_DST"

for f in "$CMDS_SRC"/*.md; do
  name="$(basename "$f")"
  dst="$CMDS_DST/$name"
  if [[ -f "$dst" ]]; then
    echo "= $dst (exists, leaving as-is)"
  else
    cp "$f" "$dst"; echo "+ $dst"
  fi
done

for f in "$HOOKS_SRC"/*.sh; do
  name="$(basename "$f")"
  dst="$HOOKS_DST/$name"
  if [[ -f "$dst" ]]; then
    echo "= $dst (exists, leaving as-is)"
  else
    cp "$f" "$dst"; chmod +x "$dst"; echo "+ $dst"
  fi
done

# Patch settings.json — Stop + UserPromptSubmit hooks, plus MCP server entry.
if ! command -v jq >/dev/null 2>&1; then
  echo "× jq not installed — skipping settings.json patch (install jq and re-run to wire the hooks)"
  exit 0
fi

if [[ ! -f "$SETTINGS" ]]; then
  echo "{}" > "$SETTINGS"
fi

STOP_CMD="$HOOKS_DST/clickup-stop-sync.sh"
PROMPT_CMD="$HOOKS_DST/clickup-prompt-context.sh"
MCP_BIN="$ROOT/mcp/dist/server.js"

TMP="$SETTINGS.cup-tracker.tmp"
jq --arg stop "$STOP_CMD" --arg prompt "$PROMPT_CMD" --arg mcp "$MCP_BIN" '
  .hooks //= {} |
  .hooks.Stop //= [] |
  .hooks.UserPromptSubmit //= [] |
  (if any(.hooks.Stop[]; .command == $stop) then . else .hooks.Stop += [{command: $stop}] end) |
  (if any(.hooks.UserPromptSubmit[]; .command == $prompt) then . else .hooks.UserPromptSubmit += [{command: $prompt}] end) |
  .mcpServers //= {} |
  (if ($mcp | test("dist/server.js$")) and ((env.SKIP_MCP // "") == "")
    then .mcpServers["clickup-tracker"] = {
      command: "node",
      args: [$mcp],
      env: { CUP_TRACKER_BASE_URL: "http://localhost:4020" }
    }
    else . end)
' "$SETTINGS" > "$TMP" && mv "$TMP" "$SETTINGS"

echo "✓ patched $SETTINGS"
[[ -f "$MCP_BIN" ]] || echo "  (note: $MCP_BIN does not exist yet — run 'cd mcp && npm install && npm run build' to enable the MCP integration)"
