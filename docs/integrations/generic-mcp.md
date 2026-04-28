# Generic MCP integration

For any MCP-capable agent that doesn't have a dedicated `agents/<name>/` directory:

- [Cursor](https://cursor.sh/)
- [Cline](https://github.com/cline/cline) (VS Code extension)
- [Continue](https://continue.dev/)
- [Zed AI assistant](https://zed.dev/)
- Any future MCP client

## Build the MCP server

```bash
cd mcp
npm install
npm run build
```

This produces `mcp/dist/server.js`. Note its **absolute path** — most MCP clients resolve the path from a different cwd, so relative paths break.

## Configuration shape

Almost every MCP client uses this JSON shape (sometimes nested under a different top-level key):

```json
{
  "mcpServers": {
    "clickup-tracker": {
      "command": "node",
      "args": ["/absolute/path/to/clickup-tracker-standalone/mcp/dist/server.js"],
      "env": {
        "CUP_TRACKER_BASE_URL": "http://localhost:4020",
        "CUP_TRACKER_ORG_ID": "00000000-0000-0000-0000-000000000000",
        "CUP_TRACKER_API_TOKEN": ""
      }
    }
  }
}
```

Set `CUP_TRACKER_API_TOKEN` only if your daemon is started with `STANDALONE_API_TOKEN` set in `.env`.

## Per-client config locations

| Agent | Config file | Notes |
|---|---|---|
| Cursor | `~/.cursor/mcp.json` (global) or `<project>/.cursor/mcp.json` (per-project) | Restart Cursor after editing. |
| Cline | VS Code `settings.json` → `cline.mcpServers` | Reload window. |
| Continue | `~/.continue/config.json` → `mcpServers` array | Use `continue.continueServerUrl` if remote. |
| Zed | `~/.config/zed/settings.json` → `assistant.mcp_servers` | Restart Zed. |

For anything not listed here, check the agent's own MCP docs — the JSON shape above almost always works.

## Containerized alternative

If you'd rather not have Node installed locally:

```bash
cd mcp
docker build -t clickup-tracker-mcp .
```

Then in your MCP config:

```json
{
  "mcpServers": {
    "clickup-tracker": {
      "command": "docker",
      "args": [
        "run", "-i", "--rm",
        "--network", "host",
        "-e", "CUP_TRACKER_BASE_URL=http://localhost:4020",
        "clickup-tracker-mcp"
      ]
    }
  }
}
```

Notes:

- `-i` keeps stdin open for the stdio transport.
- `--network host` lets the container reach `localhost:4020`. On Docker Desktop (macOS/Windows), use `host.docker.internal` in `CUP_TRACKER_BASE_URL` instead.
- `--rm` so containers don't pile up.

## Tools and resources

Same set for every MCP client:

| Tool | Purpose |
|---|---|
| `clickup_list_projects` | List tracked projects |
| `clickup_register_project` | Register a local repo |
| `clickup_resolve_project` | Path → project id |
| `clickup_sync_project` | Trigger drift sync |
| `clickup_backup_project` | Snapshot |
| `clickup_list_backups` | List snapshots |
| `clickup_restore_project` | Restore from snapshot |
| `clickup_get_status` | Composite: `/health` + `/projects` + optional CWD resolve |

Resource: `clickup://projects` — browsable JSON list of all tracked projects.

## Troubleshooting

`Cannot find module '@modelcontextprotocol/sdk'` → run `cd mcp && npm install && npm run build` first.

`Connection refused` → the daemon isn't running. `docker compose ps`.

Tools appear but every call fails with `HTTP 401` → set `CUP_TRACKER_API_TOKEN` in the MCP env to match `STANDALONE_API_TOKEN` from `.env`.
