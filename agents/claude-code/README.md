# Claude Code integration

Drops 7 slash commands and 2 lifecycle hooks into your Claude Code config (`~/.claude/`).

| Component | Purpose |
|---|---|
| `commands/clickup.md` | `/clickup` — show status of current repo |
| `commands/clickup-add.md` | `/clickup-add` — register repo + create ClickUp Folder |
| `commands/clickup-status.md` | `/clickup-status` — list all tracked projects |
| `commands/clickup-sync.md` | `/clickup-sync` — trigger immediate drift sync |
| `commands/clickup-backup.md` | `/clickup-backup` — snapshot ClickUp tree |
| `commands/clickup-revert.md` | `/clickup-revert` — restore from backup |
| `commands/clickup-remove.md` | `/clickup-remove` — untrack repo |
| `hooks/clickup-stop-sync.sh` | Stop hook — POSTs prompt-event to `/public/prompt-events` after each turn |
| `hooks/clickup-prompt-context.sh` | UserPromptSubmit hook — annotates prompts in tracked repos |

## Install

```bash
bash agents/claude-code/install.sh
```

This:

1. Copies all 7 `.md` slash commands into `$HOME/.claude/commands/` (skips files that already exist).
2. Copies both shell hooks into `$HOME/.claude/hooks/` (chmod +x).
3. Patches `$HOME/.claude/settings.json` to wire the hooks under `hooks.Stop[]` and `hooks.UserPromptSubmit[]` (idempotent — re-runs are no-ops).
4. Registers the universal MCP server (`mcp/`) under `mcpServers.clickup-tracker` if `mcp/dist/server.js` exists.

### Custom target dir

Use `--target` to install into a different config dir (for Claude-Code forks like OpenClaw / ZeroClaw / ClawCode that use `~/.openclaw/`, `~/.zeroclaw/`, etc.):

```bash
bash agents/claude-code/install.sh --target $HOME/.openclaw
```

The `agents/claude-compat/install.sh` wrapper is a thin convenience that forwards to this script with the right `--target`.

### Uninstall

```bash
bash agents/claude-code/install.sh --uninstall
```

Removes the copied files and the settings.json hook entries. Does not touch `~/.config/clickup-tracker/`.

## Configure

The Stop and UserPromptSubmit hooks read `~/.config/clickup-tracker/config.json`. After running `bash scripts/self-setup.sh`, that file is auto-populated. The keys are:

```json
{
  "base_url": "http://localhost:4020",
  "default_org_id": "00000000-0000-0000-0000-000000000000",
  "auth_token": ""
}
```

`auth_token` is only needed if the daemon runs with `STANDALONE_API_TOKEN` set (i.e. exposed beyond localhost).

## Per-project hook secrets

When you `/clickup-add`, the daemon returns a one-time `hookSecret`. The `install-git-hook.sh` step caches it at `~/.config/clickup-tracker/projects/<project-id>.secret` (mode 600). The Stop hook reads the same file when signing prompt-event webhooks, so HMAC verification stays consistent between commit events and Claude Code session events.
