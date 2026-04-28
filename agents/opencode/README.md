# OpenCode integration

[OpenCode](https://opencode.ai/) supports both slash commands (`.md` files in `~/.config/opencode/commands/`) and MCP servers (`~/.config/opencode/mcp.json`).

## 1. MCP server

Copy `agents/opencode/mcp.json` into your OpenCode config:

```bash
mkdir -p ~/.config/opencode
# If you already have an mcp.json, merge the "clickup-tracker" entry into it.
cp agents/opencode/mcp.json ~/.config/opencode/mcp.json
```

Edit the absolute path to point at your clone:

```json
{
  "mcpServers": {
    "clickup-tracker": {
      "command": "node",
      "args": ["/absolute/path/to/clickup-tracker-standalone/mcp/dist/server.js"],
      "env": { "CUP_TRACKER_BASE_URL": "http://localhost:4020" }
    }
  }
}
```

Restart OpenCode. The 8 tools should appear in the tool list.

## 2. Slash commands

Drop the markdown files in `commands/` into `~/.config/opencode/commands/`:

```bash
mkdir -p ~/.config/opencode/commands
cp agents/opencode/commands/*.md ~/.config/opencode/commands/
```

OpenCode commands use a similar markdown-with-frontmatter convention as Claude Code, so the files share most of their structure with `agents/claude-code/commands/`.

| Command | What it does |
|---|---|
| `/clickup` | Status of current repo |
| `/clickup-add` | Register repo |
| `/clickup-status` | List all tracked projects |
| `/clickup-sync` | Trigger sync |
| `/clickup-backup` | Snapshot |
| `/clickup-revert` | Restore from backup |
| `/clickup-remove` | Untrack repo |

## Build the MCP server first

```bash
cd mcp && npm install && npm run build
```
