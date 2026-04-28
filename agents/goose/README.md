# Goose integration

[Goose](https://block.github.io/goose/) is an open-source AI agent that supports MCP extensions and recipes. clickup-tracker plugs in two ways:

1. **MCP extension** — register the universal MCP server (`mcp/`). Goose can then call any of the 8 tools.
2. **Recipes** — pre-baked YAML workflows for common operations (register, status, sync, backup, restore).

## 1. MCP extension

Add this stanza to `~/.config/goose/config.yaml` (under the existing `extensions:` key):

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

Then `goose configure` → enable the extension. Verify with `goose session --debug` and ask "list my clickup-tracker projects" — the agent should call `clickup_list_projects`.

The full machine-readable extension descriptor is in `extension.json` for tools that auto-import.

## 2. Recipes

Goose recipes are reusable conversation starters. Drop the files from `recipes/` into `~/.config/goose/recipes/`:

```bash
cp agents/goose/recipes/*.yaml ~/.config/goose/recipes/
```

Available recipes:

| Recipe | What it does |
|---|---|
| `clickup-register.yaml` | Register the current repo with clickup-tracker |
| `clickup-status.yaml` | Summarize tracked-project status |
| `clickup-sync.yaml` | Trigger an immediate sync |
| `clickup-backup.yaml` | Take a snapshot of the project's ClickUp tree |
| `clickup-restore.yaml` | Restore from a backup |

Run with `goose run --recipe clickup-status`.

## Build the MCP server first

If `mcp/dist/server.js` doesn't exist yet:

```bash
cd mcp && npm install && npm run build
```
