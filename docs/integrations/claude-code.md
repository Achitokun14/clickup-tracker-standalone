# Claude Code integration

[Claude Code](https://docs.claude.com/en/docs/claude-code/overview) is Anthropic's CLI coding agent. The clickup-tracker integration adds:

- **7 slash commands** (`/clickup`, `/clickup-add`, `/clickup-status`, `/clickup-sync`, `/clickup-backup`, `/clickup-revert`, `/clickup-remove`)
- **2 lifecycle hooks** (Stop hook → posts session outcome; UserPromptSubmit hook → annotates prompts in tracked repos)
- **MCP server entry** for the universal MCP tools

## Install

Easiest:

```bash
bash install.sh --agent claude-code
```

Manual:

```bash
bash agents/claude-code/install.sh
```

What this does (idempotent — safe to re-run):

1. Copies `agents/claude-code/commands/*.md` → `~/.claude/commands/`.
2. Copies `agents/claude-code/hooks/*.sh` → `~/.claude/hooks/` (chmod +x).
3. Patches `~/.claude/settings.json`:
   - Adds the Stop and UserPromptSubmit hook entries (deduped).
   - Adds the `clickup-tracker` MCP server (if `mcp/dist/server.js` exists).

## Verify

Open a Claude Code session and try:

```
/clickup-status
```

You should see a table of tracked projects (or "no projects yet — try `/clickup-add`").

## How the slash commands work

Each `agents/claude-code/commands/*.md` is a markdown file with YAML frontmatter and an inline bash snippet. Claude Code reads it as a "macro" — when you type the command, Claude follows the markdown's instructions. The commands all read `~/.config/clickup-tracker/config.json` for `base_url` + `auth_token`, then `curl` against the daemon.

This means:

- The slash commands are **runtime-customizable** — edit the `.md` files and Claude follows the new behavior on next invocation.
- Auth changes (e.g. setting `STANDALONE_API_TOKEN`) require updating the config file once; all 7 commands pick it up automatically.

## How the hooks work

### Stop hook (`clickup-stop-sync.sh`)

Runs after every Claude Code turn. It:

1. Reads `transcript_path`, `cwd`, `session_id` from the JSON Claude Code passes on stdin.
2. Calls `GET /projects/resolve?path=<cwd>` to find which project (if any) owns the CWD.
3. If matched, extracts files-touched and the last assistant message from the transcript.
4. Signs the body with the project's cached `hook_secret` (HMAC-SHA256).
5. POSTs to `/public/prompt-events`.
6. Always exits 0 — never blocks Claude Code.

### UserPromptSubmit hook (`clickup-prompt-context.sh`)

Runs on every user message before Claude sees it. It:

1. Reads `prompt`, `cwd` from stdin.
2. Resolves the project for the CWD.
3. If matched, prepends a one-line context note: `[clickup-tracker] this repo is mirrored as ClickUp project "<name>" (id: <id>). commits are auto-synced; use /clickup-status for details.`
4. Returns the augmented prompt as JSON.

This is purely informational — it doesn't change behavior, just gives Claude the context that it's working in a mirrored project.

## Customize

- **Stop hook**: edit `~/.claude/hooks/clickup-stop-sync.sh` to filter sessions (e.g. only post if files were touched).
- **UserPromptSubmit hook**: edit the note text or skip it entirely for certain projects.
- **Slash commands**: edit any of `~/.claude/commands/clickup-*.md` to change behavior.

If you customize the in-`~/.claude/` copies, the next `bash agents/claude-code/install.sh` re-run will skip them (idempotent — only copies if the dst doesn't already exist).

## Uninstall

```bash
bash agents/claude-code/install.sh --uninstall
```

Removes the copied files and unpatches `~/.claude/settings.json`. Does not touch `~/.config/clickup-tracker/`.

## Settings.json shape after install

```json
{
  "hooks": {
    "Stop": [
      { "command": "/home/you/.claude/hooks/clickup-stop-sync.sh" }
    ],
    "UserPromptSubmit": [
      { "command": "/home/you/.claude/hooks/clickup-prompt-context.sh" }
    ]
  },
  "mcpServers": {
    "clickup-tracker": {
      "command": "node",
      "args": ["/path/to/clickup-tracker-standalone/mcp/dist/server.js"],
      "env": { "CUP_TRACKER_BASE_URL": "http://localhost:4020" }
    }
  }
}
```
