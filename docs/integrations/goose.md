# Goose integration

[Goose](https://block.github.io/goose/) is an open-source AI agent that supports MCP extensions and YAML "recipes" (reusable conversation starters).

clickup-tracker plugs in two ways:

1. **MCP extension** — register the universal MCP server. Goose can then call any of the 8 tools.
2. **Recipes** — pre-baked YAML workflows for common operations.

## 1. MCP extension

Run the installer:

```bash
bash install.sh --agent goose
```

It prints a YAML stanza to add to `~/.config/goose/config.yaml`:

```yaml
extensions:
  clickup-tracker:
    type: stdio
    cmd: node
    args:
      - /absolute/path/to/clickup-tracker-standalone/mcp/dist/server.js
    envs:
      CUP_TRACKER_BASE_URL: http://localhost:4020
      CUP_TRACKER_ORG_ID: default
    timeout: 30
    bundled: false
```

Then `goose configure` → enable the `clickup-tracker` extension.

Verify with `goose session --debug` and ask:

> List my clickup-tracker projects.

The agent should call `clickup_list_projects`. If you see `[clickup-tracker] error connecting`, see [`../troubleshooting.md`](../troubleshooting.md#mcp-server-not-connecting-any-mcp-client).

## 2. Recipes

Recipes are reusable prompt templates with parameters. The installer copies the bundled ones into `~/.config/goose/recipes/`:

| Recipe | What it does |
|---|---|
| `clickup-register` | Register the current repo with clickup-tracker |
| `clickup-status` | Summarize tracked-project status |
| `clickup-sync` | Trigger an immediate sync |
| `clickup-backup` | Take a snapshot of the project's ClickUp tree |
| `clickup-restore` | Restore from a backup |

Run them:

```bash
goose run --recipe clickup-status
goose run --recipe clickup-register --params local_path=/path/to/repo
goose run --recipe clickup-sync
goose run --recipe clickup-backup
goose run --recipe clickup-restore --params backup_id=<id> mode=additive
```

## Tools available via MCP

| Tool | Purpose |
|---|---|
| `clickup_list_projects` | List all tracked projects |
| `clickup_register_project` | Register a local repo |
| `clickup_resolve_project` | Path → project id |
| `clickup_sync_project` | Trigger drift sync |
| `clickup_backup_project` | Snapshot |
| `clickup_list_backups` | List snapshots |
| `clickup_restore_project` | Restore from snapshot |
| `clickup_get_status` | Composite health + project list |

Plus one resource: `clickup://projects` (browsable JSON list).

## Troubleshooting

- `extension fails to start: Cannot find module '@modelcontextprotocol/sdk'` → you need to build the MCP server first: `cd mcp && npm install && npm run build`.
- Goose says "no tools available" → check `goose session --debug` output. Most commonly the path in `args[0]` is wrong; it must be **absolute**.
- Tools fail with "Connection refused" → the daemon isn't running. `docker compose ps`, then `docker compose up -d` if needed.
