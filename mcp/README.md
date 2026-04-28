# clickup-tracker MCP server

A stdio-mode [Model Context Protocol](https://modelcontextprotocol.io/) server that wraps the clickup-tracker daemon's HTTP API. Any MCP-capable agent can use this — Claude Code, Goose, OpenCode, Cursor, Cline, Continue, etc.

## Build

```bash
cd mcp
npm install
npm run build
```

This produces `dist/server.js`. Test it:

```bash
node dist/server.js
# stderr: [clickup-tracker-mcp] connected (base=http://localhost:4020, org=default)
# (it will wait on stdio for an MCP client)
```

## Configuration

The server reads three environment variables:

| Var | Default | Purpose |
|---|---|---|
| `CUP_TRACKER_BASE_URL` | `http://localhost:4020` | Daemon URL. |
| `CUP_TRACKER_API_TOKEN` | (empty) | `STANDALONE_API_TOKEN` value, if the daemon requires one. |
| `CUP_TRACKER_ORG_ID` | `default` | Organisation tag. |

## Tools

| Tool | What it does | Daemon endpoint |
|---|---|---|
| `clickup_list_projects` | List tracked projects | `GET /projects` |
| `clickup_register_project` | Register a local repo | `POST /projects` |
| `clickup_resolve_project` | Find which project owns a path | `GET /projects/resolve?path=` |
| `clickup_sync_project` | Trigger immediate sync | `POST /projects/:id/sync` |
| `clickup_backup_project` | Snapshot ClickUp tree | `POST /projects/:id/backup` |
| `clickup_list_backups` | List backups | `GET /projects/:id/backups` |
| `clickup_restore_project` | Restore from backup | `POST /projects/:id/restore` |
| `clickup_get_status` | Composite: `/health` + `/projects` + optional CWD resolve | (multiple) |

Resource: `clickup://projects` — browsable JSON list of all projects.

## Wiring into agents

### Claude Code (`~/.claude/settings.json`)

```json
{
  "mcpServers": {
    "clickup-tracker": {
      "command": "node",
      "args": ["/absolute/path/to/clickup-tracker-standalone/mcp/dist/server.js"],
      "env": {
        "CUP_TRACKER_BASE_URL": "http://localhost:4020"
      }
    }
  }
}
```

### Goose (`~/.config/goose/config.yaml`)

```yaml
extensions:
  clickup-tracker:
    type: stdio
    cmd: node
    args:
      - /absolute/path/to/clickup-tracker-standalone/mcp/dist/server.js
    envs:
      CUP_TRACKER_BASE_URL: http://localhost:4020
```

### OpenCode (`~/.config/opencode/mcp.json`)

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

### Cursor / Cline / Continue / generic MCP

Same JSON shape as Claude Code above. See `agents/generic-mcp/README.md`.

## Containerized

```bash
cd mcp
docker build -t clickup-tracker-mcp .
docker run -i --rm \
  --network host \
  -e CUP_TRACKER_BASE_URL=http://localhost:4020 \
  clickup-tracker-mcp
```

(`-i` keeps stdin open for the stdio transport. `--network host` lets the container reach the daemon at `localhost:4020`; on Docker Desktop, use `host.docker.internal`.)
