# Generic MCP integration

For any MCP-capable agent that isn't covered by a dedicated `agents/<name>/` directory — this includes Cursor, Cline, Continue, and any future MCP client.

## Configuration

Most MCP clients use a JSON config that looks like this:

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

The exact file location depends on the agent:

| Agent | Config file |
|---|---|
| Cursor | `~/.cursor/mcp.json` (or per-project `.cursor/mcp.json`) |
| Cline (VS Code) | VS Code settings → `cline.mcpServers` |
| Continue | `~/.continue/config.json` → `mcpServers` array |
| Generic | Whatever the agent documents |

## Build the MCP server first

```bash
cd mcp && npm install && npm run build
```

## What's exposed

8 tools and 1 resource. See [`mcp/README.md`](../../mcp/README.md) for the full table.

## Containerized alternative

If you'd rather not install Node locally, run the MCP server in Docker:

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

(Build the image first: `cd mcp && docker build -t clickup-tracker-mcp .`)
