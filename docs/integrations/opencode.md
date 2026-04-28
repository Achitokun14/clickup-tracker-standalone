# OpenCode integration

[OpenCode](https://opencode.ai/) supports both slash commands (markdown files in `~/.config/opencode/commands/`) and MCP servers (`~/.config/opencode/mcp.json`).

## Install

```bash
bash install.sh --agent opencode
```

What this does:

1. Copies `agents/opencode/commands/*.md` → `~/.config/opencode/commands/` (skips files that already exist).
2. Writes `~/.config/opencode/mcp.json` with the `clickup-tracker` MCP server entry, with the absolute path to your clone of `mcp/dist/server.js`. If `mcp.json` already exists, the installer warns and asks you to merge by hand.

## Verify

Restart OpenCode. Then:

- The 7 slash commands should appear: `/clickup`, `/clickup-add`, `/clickup-status`, `/clickup-sync`, `/clickup-backup`, `/clickup-revert`, `/clickup-remove`.
- The 8 MCP tools should appear in the tool palette: `clickup_list_projects`, `clickup_register_project`, etc.

## Manual MCP config

If the installer's auto-write doesn't fit your setup, here's the snippet to merge into `~/.config/opencode/mcp.json`:

```json
{
  "mcpServers": {
    "clickup-tracker": {
      "command": "node",
      "args": ["/absolute/path/to/clickup-tracker-standalone/mcp/dist/server.js"],
      "env": {
        "CUP_TRACKER_BASE_URL": "http://localhost:4020",
        "CUP_TRACKER_ORG_ID": "00000000-0000-0000-0000-000000000000"
      }
    }
  }
}
```

Use the absolute path; relative paths often fail when OpenCode launches the server with a different cwd.

## Slash command format compatibility

OpenCode slash commands use the same markdown-with-YAML-frontmatter convention as Claude Code, so the bundled files (`agents/claude-code/commands/*.md` mirrored into `agents/opencode/commands/`) work with both. The frontmatter fields used:

- `description` — shown in the command palette
- `argument-hint` — autocomplete hint

Inside, the `.md` body is treated as the prompt template. The bash snippets are executed in OpenCode's tool-use loop the same way Claude Code handles them.

## Customize

- Edit `~/.config/opencode/commands/clickup-*.md` to change command behavior.
- Edit `~/.config/opencode/mcp.json` to change MCP server env vars (e.g. point at a remote daemon by changing `CUP_TRACKER_BASE_URL`).

## Troubleshooting

See [`../troubleshooting.md`](../troubleshooting.md). Most common issues:

- MCP server path wrong → use absolute path.
- MCP server not built yet → `cd mcp && npm install && npm run build`.
- Daemon down → `docker compose up -d`.
