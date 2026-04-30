#!/usr/bin/env bash
# install-git-hook.sh — drop a post-commit hook into a tracked repo so its
# commits POST to the clickup-tracker daemon.
#
# Usage:
#   install-git-hook.sh --repo <path> --project-id <uuid> \
#     --hook-secret <hex> [--base http://localhost:4020]
#
# --base defaults to $CLICKUP_TRACKER_BASE_URL or http://localhost:4020.
# Idempotent: if the hook already exists, refuses unless --force is passed.

set -euo pipefail

REPO=""
PROJECT_ID=""
HOOK_SECRET=""
# Standalone defaults to the locally-running daemon. If you also expose
# the daemon behind an API gateway, pass --base <gateway-prefix>
# (e.g. https://example.com/api/v1/clickup-tracker).
BASE="${CLICKUP_TRACKER_BASE_URL:-http://localhost:4020}"
FORCE=0
SCOPE_MODE="root"
# Comma-separated relative paths (e.g. "service/,mcp/"). Trailing slash optional.
SCOPE_PATHS=""

while [[ $# -gt 0 ]]; do
  case "$1" in
    --repo)         REPO="$2"; shift 2 ;;
    --project-id)   PROJECT_ID="$2"; shift 2 ;;
    --hook-secret)  HOOK_SECRET="$2"; shift 2 ;;
    --base)         BASE="$2"; shift 2 ;;
    --scope-mode)   SCOPE_MODE="$2"; shift 2 ;;
    --scope-paths)  SCOPE_PATHS="$2"; shift 2 ;;
    --force)        FORCE=1; shift ;;
    *) echo "unknown arg: $1" >&2; exit 2 ;;
  esac
done

if [[ -z "$REPO" || -z "$PROJECT_ID" || -z "$HOOK_SECRET" ]]; then
  echo "usage: $0 --repo <path> --project-id <uuid> --hook-secret <hex> [--base <url>] [--scope-mode root|subdir] [--scope-paths svc/,mcp/] [--force]" >&2
  echo "       --base defaults to \$CLICKUP_TRACKER_BASE_URL or http://localhost:4020" >&2
  echo "       --scope-mode subdir + --scope-paths skips the POST early when no changed file matches" >&2
  exit 2
fi

if [[ "$SCOPE_MODE" == "subdir" && -z "$SCOPE_PATHS" ]]; then
  echo "warning: --scope-mode subdir without --scope-paths is treated as pass-through (matches daemon behaviour)" >&2
fi

if [[ ! -d "$REPO/.git" ]]; then
  echo "not a git repo: $REPO" >&2
  exit 2
fi

HOOK_PATH="$REPO/.git/hooks/post-commit"
if [[ -f "$HOOK_PATH" && $FORCE -eq 0 ]]; then
  if grep -q 'clickup-tracker:managed' "$HOOK_PATH"; then
    echo "hook already managed by clickup-tracker; pass --force to overwrite" >&2
    exit 1
  fi
  echo "post-commit hook exists at $HOOK_PATH (not managed by clickup-tracker); pass --force to replace" >&2
  exit 1
fi

cat > "$HOOK_PATH" <<HOOK
#!/usr/bin/env bash
# clickup-tracker:managed
# Auto-installed by clickup-tracker. POSTs commit metadata to the daemon.
# Edit at your own risk; reinstall with: install-git-hook.sh --force.

set -euo pipefail

PROJECT_ID="${PROJECT_ID}"
HOOK_SECRET="${HOOK_SECRET}"
BASE="${BASE}"
SCOPE_MODE="${SCOPE_MODE}"
SCOPE_PATHS="${SCOPE_PATHS}"

sha=\$(git rev-parse HEAD)
parent=\$(git rev-parse "\${sha}^" 2>/dev/null || echo "")
branch=\$(git rev-parse --abbrev-ref HEAD 2>/dev/null)
# Detached HEAD or git-failure fallback — never POST an empty branch.
# Daemon also synthesises this server-side, but a populated value here is
# preferred (preserves the actual branch name when it exists).
if [ -z "\$branch" ] || [ "\$branch" = "HEAD" ]; then
  branch=\$(git config --get init.defaultBranch 2>/dev/null || echo "main")
fi
author=\$(git log -1 --format=%an)
email=\$(git log -1 --format=%ae)
ts=\$(git log -1 --format=%cI)
msg=\$(git log -1 --format=%B)
remote=\$(git remote get-url origin 2>/dev/null || echo "")

# Files changed in this commit (path + status, no diff).
files=\$(git diff-tree --no-commit-id --name-status -r "\${sha}" 2>/dev/null | awk '{ printf "{\"path\":\"%s\",\"status\":\"%s\"},\n", \$2, \$1 }' | sed 's/,\$//')

# Client-side scope_config subdir filter — early-out so the daemon doesn't
# even see commits that touch only out-of-scope paths. The daemon also
# enforces this server-side (authoritative); this is just an optimization.
if [[ "\$SCOPE_MODE" == "subdir" && -n "\$SCOPE_PATHS" ]]; then
  changed_paths=\$(git diff-tree --no-commit-id --name-only -r "\${sha}" 2>/dev/null || true)
  matched=0
  IFS=',' read -ra _SCOPE_ARR <<< "\$SCOPE_PATHS"
  for p in "\${_SCOPE_ARR[@]}"; do
    p="\${p%/}/"  # ensure trailing slash
    while IFS= read -r f; do
      [[ -z "\$f" ]] && continue
      if [[ "\$f/" == "\$p"* || "\$f" == "\${p%/}" ]]; then
        matched=1; break
      fi
    done <<< "\$changed_paths"
    [[ \$matched -eq 1 ]] && break
  done
  if [[ \$matched -eq 0 ]]; then
    exit 0
  fi
fi

# TODO/FIXME/XXX/HACK churn in this commit's diff.
# POSIX-awk only (mawk/nawk/gawk/macOS awk all OK). Failures swallowed
# so a malformed diff never fails the commit.
todos=\$(git show --unified=0 --pretty=format: "\${sha}" 2>/dev/null | awk '
  /^diff --git/ { sub(/^a\\//, "", \$3); file=\$3 }
  /^@@/ {
    if (match(\$0, /\\+[0-9]+/)) line = substr(\$0, RSTART+1, RLENGTH-1) - 1
  }
  /^[+-][^+-]/ {
    op = (substr(\$0, 1, 1) == "+") ? "add" : "remove"
    text = substr(\$0, 2)
    if (match(text, /(TODO|FIXME|XXX|HACK):[ \\t]*/)) {
      mpos = RSTART; mlen = RLENGTH
      head = substr(text, mpos, mlen)
      if (match(head, /[A-Z]+/)) marker = substr(head, RSTART, RLENGTH)
      msg = substr(text, mpos + mlen)
      gsub(/\\\\/, "\\\\\\\\", msg)
      gsub(/"/, "\\\\\"", msg)
      gsub(/\\\\/, "\\\\\\\\", file)
      gsub(/"/, "\\\\\"", file)
      printf "{\"file\":\"%s\",\"op\":\"%s\",\"line\":%d,\"marker\":\"%s\",\"text\":\"%s\"},\n", file, op, line, marker, msg
    }
    if (op == "add") line++
  }
' 2>/dev/null | sed 's/,\$//' || true)

body=\$(jq -n \\
  --arg sha "\$sha" \\
  --arg branch "\$branch" \\
  --arg author "\$author" \\
  --arg email "\$email" \\
  --arg ts "\$ts" \\
  --arg msg "\$msg" \\
  --arg remote "\$remote" \\
  --argjson files "[\${files}]" \\
  --argjson todos "[\${todos}]" '{
    commit_sha: \$sha,
    branch: \$branch,
    author: \$author,
    committer_email: \$email,
    committed_at: \$ts,
    message: \$msg,
    remote_url: \$remote,
    files_changed: \$files,
    todo_diffs: \$todos
  }')

now=\$(date +%s)
sig="sha256=\$(printf '%s' "\$body" | openssl dgst -sha256 -hmac "\$HOOK_SECRET" -hex | awk '{print \$2}')"

curl -fsS -m 10 \\
  -H "Content-Type: application/json" \\
  -H "X-CUP-Project-ID: \$PROJECT_ID" \\
  -H "X-CUP-Timestamp: \$now" \\
  -H "X-CUP-Signature: \$sig" \\
  -H "X-CUP-Idempotency-Key: \${PROJECT_ID}:\${sha}" \\
  -d "\$body" \\
  "\${BASE%/}/public/git-events" > /dev/null \\
  || {
    # Resilient: never fail the user's commit because of webhook trouble.
    mkdir -p "\${HOME}/.cache/cup-cli/buffer"
    echo "\$body" > "\${HOME}/.cache/cup-cli/buffer/\${sha}.json"
    echo "(clickup-tracker post-commit unreachable; buffered \$sha)" >&2
  }
HOOK

chmod +x "$HOOK_PATH"
echo "✓ installed clickup-tracker post-commit hook at $HOOK_PATH"

# Cache the project's hook_secret so the Stop hook (which doesn't run inside
# a git repo) can sign prompt-events with the same secret the daemon expects.
SECRETS_DIR="${HOME}/.config/clickup-tracker/projects"
mkdir -p "$SECRETS_DIR"
chmod 700 "$SECRETS_DIR"
SECRET_FILE="${SECRETS_DIR}/${PROJECT_ID}.secret"
printf '%s' "$HOOK_SECRET" > "$SECRET_FILE"
chmod 600 "$SECRET_FILE"
echo "✓ cached hook_secret at ${SECRET_FILE} (used by Stop hook for prompt-event signing)"
