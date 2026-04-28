#!/usr/bin/env bash
# install.sh — one-script multi-platform installer for clickup-tracker.
#
# Detects OS (Linux / macOS / Windows-via-Git-Bash-or-WSL) and runs an
# end-to-end setup:
#
#   1. Verify prerequisites (docker, git, jq, openssl).
#   2. Bring up the Docker stack (Postgres + Redis + daemon at :4020).
#   3. Wait for /health to return 200.
#   4. Build the universal MCP server (mcp/dist/server.js).
#   5. Write ~/.config/clickup-tracker/config.json (cross-platform path).
#   6. (Optional flags) install per-agent shims into the chosen agent dir.
#
# Idempotent. Safe to re-run.
#
# Usage:
#   bash install.sh                          # daemon + MCP server only
#   bash install.sh --agent claude-code      # also install Claude Code hooks
#   bash install.sh --agent claude-compat    # auto-detect ~/.openclaw etc.
#   bash install.sh --agent goose            # print Goose config snippet
#   bash install.sh --agent opencode         # copy OpenCode commands + mcp.json
#   bash install.sh --agent all              # install every available agent
#   bash install.sh --skip-docker            # skip step 2-3 (CI / dry-run)
#   bash install.sh --skip-mcp               # skip step 4 (no Node toolchain)
#
# On Windows: run from Git Bash (ships with Git for Windows) or WSL2.
# A PowerShell wrapper (scripts/windows/install.ps1) calls this script
# automatically.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

# ── Defaults ──────────────────────────────────────────────────────────────
AGENT=""
SKIP_DOCKER=0
SKIP_MCP=0
NONINTERACTIVE=0

# ── Args ──────────────────────────────────────────────────────────────────
while [[ $# -gt 0 ]]; do
  case "$1" in
    --agent) AGENT="$2"; shift 2 ;;
    --skip-docker) SKIP_DOCKER=1; shift ;;
    --skip-mcp) SKIP_MCP=1; shift ;;
    --noninteractive|-y) NONINTERACTIVE=1; shift ;;
    -h|--help) sed -n '2,30p' "${BASH_SOURCE[0]}"; exit 0 ;;
    *) echo "unknown arg: $1" >&2; exit 2 ;;
  esac
done

# ── OS detection ──────────────────────────────────────────────────────────
detect_os() {
  case "$(uname -s 2>/dev/null || echo unknown)" in
    Linux*)   echo linux ;;
    Darwin*)  echo macos ;;
    MINGW*|MSYS*|CYGWIN*) echo windows ;;
    *)        echo unknown ;;
  esac
}
OS="$(detect_os)"

# ── XDG config home (cross-platform) ──────────────────────────────────────
config_home() {
  if [[ "$OS" == "windows" && -n "${APPDATA:-}" ]]; then
    # Convert C:\Users\... to /c/Users/... so bash can use it.
    printf '%s' "$APPDATA" | sed -e 's|\\|/|g' -e 's|^\([A-Za-z]\):|/\L\1|'
  elif [[ -n "${XDG_CONFIG_HOME:-}" ]]; then
    printf '%s' "$XDG_CONFIG_HOME"
  else
    printf '%s' "$HOME/.config"
  fi
}
CONFIG_DIR="$(config_home)/clickup-tracker"

# ── Pretty output ─────────────────────────────────────────────────────────
say()  { printf '\033[1;36m→\033[0m %s\n' "$*"; }
ok()   { printf '\033[1;32m✓\033[0m %s\n' "$*"; }
warn() { printf '\033[1;33m!\033[0m %s\n' "$*"; }
err()  { printf '\033[1;31m✗\033[0m %s\n' "$*" >&2; }

say "clickup-tracker installer (os=$OS)"
say "config dir: $CONFIG_DIR"

# ── Prereqs ───────────────────────────────────────────────────────────────
require() {
  command -v "$1" >/dev/null 2>&1 || { err "missing prerequisite: $1"; return 1; }
}

PREREQ_OK=1
require git || PREREQ_OK=0
require jq || PREREQ_OK=0
require openssl || PREREQ_OK=0
require curl || PREREQ_OK=0
[[ $SKIP_DOCKER -eq 0 ]] && { require docker || PREREQ_OK=0; }
[[ $SKIP_MCP -eq 0 ]]    && { require node || PREREQ_OK=0; require npm || PREREQ_OK=0; }
if [[ $PREREQ_OK -eq 0 ]]; then
  cat >&2 <<EOF

Install missing prerequisites and re-run:
  Linux (Debian/Ubuntu):  sudo apt install git jq openssl curl docker.io nodejs npm
  macOS (Homebrew):       brew install git jq openssl curl docker node
  Windows (Git Bash):     install Git for Windows + Docker Desktop + Node.js LTS
EOF
  exit 1
fi
ok "prerequisites present"

# ── Step 1: .env ──────────────────────────────────────────────────────────
if [[ ! -f .env ]]; then
  cp .env.example .env
  ok "created .env from .env.example"
  if [[ $NONINTERACTIVE -eq 0 ]]; then
    cat <<EOF

⚠  .env is freshly created. Open it and fill in:
   - CLICKUP_API_TOKEN  (Personal Settings → Apps → Generate, format pk_…)
   - CLICKUP_TEAM_ID    (the integer in your ClickUp workspace URL)

Then re-run: bash install.sh
EOF
    exit 0
  fi
else
  ok ".env exists"
fi

TRACKER_PORT="$(grep -E '^TRACKER_PORT=' .env | cut -d= -f2 | tr -d ' ')"
TRACKER_PORT="${TRACKER_PORT:-4020}"
STANDALONE_TOKEN="$(grep -E '^STANDALONE_API_TOKEN=' .env | cut -d= -f2- | tr -d ' ')"

# ── Step 2-3: docker compose + /health ────────────────────────────────────
if [[ $SKIP_DOCKER -eq 0 ]]; then
  docker info >/dev/null 2>&1 || { err "docker daemon not running"; exit 1; }
  say "docker compose up -d --build"
  docker compose up -d --build

  URL="http://localhost:${TRACKER_PORT}/health"
  say "waiting for $URL"
  for i in $(seq 1 30); do
    if curl -fsS -m 2 "$URL" >/dev/null 2>&1; then
      ok "/health 200 (took ${i}s)"
      break
    fi
    sleep 1
    if [[ $i -eq 30 ]]; then
      err "/health did not respond after 30s"
      err "  check: docker compose logs clickup-tracker"
      exit 1
    fi
  done
fi

# ── Step 4: build MCP server ──────────────────────────────────────────────
if [[ $SKIP_MCP -eq 0 ]]; then
  if [[ ! -d mcp/node_modules ]]; then
    say "installing mcp/ deps"
    (cd mcp && npm install --no-audit --no-fund)
  fi
  if [[ ! -f mcp/dist/server.js ]]; then
    say "building mcp/ server"
    (cd mcp && npm run build)
  fi
  ok "mcp server: $SCRIPT_DIR/mcp/dist/server.js"
fi

# ── Step 5: write ~/.config/clickup-tracker/config.json ──────────────────
mkdir -p "$CONFIG_DIR/projects"
chmod 700 "$CONFIG_DIR/projects" 2>/dev/null || true
CONFIG_FILE="$CONFIG_DIR/config.json"
TMP="$CONFIG_FILE.tmp"
if [[ ! -f "$CONFIG_FILE" ]]; then
  echo '{}' > "$CONFIG_FILE"
fi
jq \
  --arg base "http://localhost:${TRACKER_PORT}" \
  --arg auth "${STANDALONE_TOKEN}" \
  --arg org  "00000000-0000-0000-0000-000000000000" \
  '. as $c |
   .base_url = $base |
   .default_org_id = $org |
   (if ($auth | length) > 0 then .auth_token = $auth else . end)' \
  "$CONFIG_FILE" > "$TMP" && mv "$TMP" "$CONFIG_FILE"
ok "wrote $CONFIG_FILE"

# ── Step 6: agent shims ───────────────────────────────────────────────────
install_agent() {
  local agent="$1"
  case "$agent" in
    claude-code)
      say "installing Claude Code shim"
      bash agents/claude-code/install.sh
      ;;
    claude-compat)
      say "installing Claude-compat shim (auto-detect)"
      bash agents/claude-compat/install.sh
      ;;
    goose)
      say "Goose: copy this stanza into ~/.config/goose/config.yaml under 'extensions:'"
      cat agents/goose/extension.json | jq -r '
        "  clickup-tracker:",
        "    type: " + .type,
        "    cmd: " + .cmd,
        "    args:",
        "      - '"$SCRIPT_DIR"'/mcp/dist/server.js",
        "    envs:",
        (.envs | to_entries[] | "      " + .key + ": " + .value),
        "    timeout: " + (.timeout | tostring),
        "    bundled: " + (.bundled | tostring)
      '
      cp -r agents/goose/recipes "$CONFIG_DIR/../goose-recipes" 2>/dev/null || true
      ;;
    opencode)
      say "installing OpenCode shim"
      OC="$HOME/.config/opencode"
      mkdir -p "$OC/commands"
      for f in agents/opencode/commands/*.md; do
        dst="$OC/commands/$(basename "$f")"
        [[ -f "$dst" ]] && echo "= $dst" || { cp "$f" "$dst"; echo "+ $dst"; }
      done
      MCP="$OC/mcp.json"
      if [[ ! -f "$MCP" ]]; then
        sed "s|/absolute/path/to/clickup-tracker-standalone|$SCRIPT_DIR|g" agents/opencode/mcp.json > "$MCP"
        ok "+ $MCP"
      else
        warn "$MCP exists — merge agents/opencode/mcp.json by hand"
      fi
      ;;
    all)
      install_agent claude-code
      [[ -d "$HOME/.openclaw" || -d "$HOME/.zeroclaw" || -d "$HOME/.clawcode" ]] && install_agent claude-compat
      command -v goose >/dev/null 2>&1 && install_agent goose
      command -v opencode >/dev/null 2>&1 && install_agent opencode
      ;;
    "")
      ;;
    *)
      err "unknown agent: $agent (valid: claude-code, claude-compat, goose, opencode, all)"
      exit 2
      ;;
  esac
}
install_agent "$AGENT"

# ── Done ──────────────────────────────────────────────────────────────────
cat <<EOF

✓ clickup-tracker is up.

  Health:  http://localhost:${TRACKER_PORT}/health
  OpenAPI: http://localhost:${TRACKER_PORT}/public/openapi.yaml
  Config:  $CONFIG_FILE
  MCP:     $SCRIPT_DIR/mcp/dist/server.js

Register your first repo:
  curl -X POST http://localhost:${TRACKER_PORT}/projects \\
    -H 'Content-Type: application/json' \\
    -d '{"localPath":"'"\$(pwd)"'","displayName":"My Project"}'

Then drop the post-commit hook in (replace IDs with the response values):
  bash scripts/install-git-hook.sh \\
    --repo "\$(pwd)" \\
    --project-id <projectId> \\
    --hook-secret <hookSecret> \\
    --base http://localhost:${TRACKER_PORT}

Per-agent shims (run any time):
  bash agents/claude-code/install.sh        # Claude Code
  bash agents/claude-compat/install.sh      # OpenClaw / ZeroClaw / ClawCode
  bash agents/opencode/...                  # OpenCode
  See agents/<name>/README.md for the rest.
EOF
