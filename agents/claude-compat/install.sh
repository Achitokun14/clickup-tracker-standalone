#!/usr/bin/env bash
# Wrapper that auto-detects (or accepts --target) a Claude-Code-compatible
# config dir, then forwards to agents/claude-code/install.sh.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
INNER="$SCRIPT_DIR/../claude-code/install.sh"

TARGET=""
EXTRA_ARGS=()

while [[ $# -gt 0 ]]; do
  case "$1" in
    --target) TARGET="$2"; shift 2 ;;
    --uninstall|-h|--help) EXTRA_ARGS+=("$1"); shift ;;
    *) EXTRA_ARGS+=("$1"); shift ;;
  esac
done

if [[ -z "$TARGET" ]]; then
  for candidate in "$HOME/.openclaw" "$HOME/.zeroclaw" "$HOME/.clawcode" "$HOME/.claw" "$HOME/.claude"; do
    if [[ -d "$candidate" ]]; then
      TARGET="$candidate"
      echo "→ auto-detected $TARGET"
      break
    fi
  done
fi

if [[ -z "$TARGET" ]]; then
  echo "× no compatible config dir found in \$HOME" >&2
  echo "  pass --target <dir> explicitly (e.g. --target \$HOME/.openclaw)" >&2
  exit 2
fi

exec bash "$INNER" --target "$TARGET" "${EXTRA_ARGS[@]}"
