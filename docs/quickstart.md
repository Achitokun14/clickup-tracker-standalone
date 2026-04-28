# Quickstart — 5 minutes from clone to tracked commit

## 0. Prerequisites

- Docker 24+ (Linux: `docker.io` or Docker CE; macOS/Windows: Docker Desktop)
- `git`, `jq`, `openssl`, `curl`
- Node.js 20+ (only required if you want the MCP server — `--skip-mcp` to skip)
- A ClickUp account + API token (see [`../CREDS.md`](../CREDS.md))

## 1. Clone + configure

```bash
git clone https://github.com/Achitokun14/clickup-tracker-standalone
cd clickup-tracker-standalone
cp .env.example .env
$EDITOR .env
# fill in:
#   CLICKUP_API_TOKEN=pk_...
#   CLICKUP_TEAM_ID=12345678
```

## 2. Run the installer

```bash
bash install.sh
```

What this does:

1. Verifies prereqs.
2. `docker compose up -d --build` (Postgres + Redis + daemon).
3. Waits for `GET /health` to return 200.
4. Builds the universal MCP server (`mcp/dist/server.js`).
5. Writes `~/.config/clickup-tracker/config.json` with your `base_url` + (optional) `auth_token`.

End state: the daemon is up at `http://localhost:4020`.

```bash
curl -fsS http://localhost:4020/health
# {"status":"ok",...}
```

## 3. Register your first repo

Pick a repo on disk you want to mirror into ClickUp:

```bash
curl -fsS -X POST http://localhost:4020/projects \
  -H 'Content-Type: application/json' \
  -d '{"localPath":"/path/to/your/repo","displayName":"My Project"}' | jq
```

Save the `hookSecret` from the response — it is shown **once**.

The response also has a `folderUrl` that opens the freshly created ClickUp Folder in the browser.

## 4. Drop in the post-commit hook

```bash
bash scripts/install-git-hook.sh \
  --repo /path/to/your/repo \
  --project-id <projectId from step 3> \
  --hook-secret <hookSecret from step 3>
```

The script:

- Writes `<repo>/.git/hooks/post-commit` (refuses to overwrite without `--force`).
- Caches the hook secret at `~/.config/clickup-tracker/projects/<id>.secret` (mode 600).

Now make a commit:

```bash
cd /path/to/your/repo
git commit --allow-empty -m "feat: hello clickup-tracker"
```

Within seconds, a new task should appear in the project's "Commits" List.

## 5. (Optional) Wire your AI agent

```bash
# from the clickup-tracker-standalone clone
bash install.sh --agent claude-code     # Claude Code
bash install.sh --agent opencode        # OpenCode
bash install.sh --agent goose           # Goose (prints config snippet)
bash install.sh --agent all             # auto-detect installed agents
```

After this, your agent has the `clickup-tracker` MCP tools (or slash commands) and Claude Code has its Stop/UserPromptSubmit hooks wired up. Try `/clickup-status` in Claude Code, or ask Goose "list my clickup-tracker projects."

## 6. Verify everything

```bash
curl -fsS http://localhost:4020/health                                 # 200
curl -fsS http://localhost:4020/projects -H 'X-Organisation-Id: default' | jq
docker compose ps                                                      # 3 services Up
```

Per-project ClickUp Folder should now show:

- **Commits** — one task per commit
- **Prompts** — one task per agent session (if hooks installed)
- **Overview & Docs** — README, CHANGELOG, drift summary

## What's next

- [`./architecture.md`](./architecture.md) — how it works under the hood
- [`./deployment.md`](./deployment.md) — running beyond localhost
- [`./troubleshooting.md`](./troubleshooting.md) — when something goes wrong
