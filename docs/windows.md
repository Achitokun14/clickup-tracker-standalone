# Windows guide

clickup-tracker runs on Windows in three flavors. Pick the one that fits your environment.

## Option A — Git Bash (recommended for most)

Git for Windows ships with `bash.exe`, `jq`, `openssl`, `curl`, and a POSIX-ish environment. Combined with Docker Desktop, this is the simplest path.

### Install prereqs

1. **Git for Windows** — <https://git-scm.com/download/win>. Default options. Includes Git Bash.
2. **Docker Desktop** — <https://www.docker.com/products/docker-desktop>. Make sure WSL2 backend is enabled.
3. **Node.js LTS** (only if you want the MCP server) — <https://nodejs.org/>.

### Run

Open Git Bash, then:

```bash
git clone https://github.com/Achitokun14/clickup-tracker-standalone
cd clickup-tracker-standalone
cp .env.example .env
# edit .env in your favorite editor
bash install.sh
```

The same script that runs on Linux/macOS runs here — `install.sh` detects MSYS via `uname -s` and adapts paths automatically.

### Or use the PowerShell wrapper

If you prefer PowerShell (no extra Git Bash invocation):

```powershell
.\install.ps1
.\install.ps1 -Agent claude-code
```

The `.ps1` wrapper locates `bash.exe` and delegates to `install.sh`. Same end state.

## Option B — WSL2

WSL2 gives you a full Linux userland inside Windows. Many users prefer this because Linux tooling "just works."

```bash
# inside Ubuntu (or whatever distro) under WSL2
sudo apt update && sudo apt install -y git jq openssl curl docker.io nodejs npm
git clone https://github.com/Achitokun14/clickup-tracker-standalone
cd clickup-tracker-standalone
cp .env.example .env
bash install.sh
```

Notes:

- Docker can be either WSL2-native (`apt install docker.io`) or Docker Desktop with the WSL2 integration enabled (Settings → Resources → WSL Integration → toggle your distro).
- Filesystem performance is best inside the WSL2 filesystem (`/home/...`), not the Windows mount (`/mnt/c/...`).

## Option C — pure Docker Desktop, no scripts

If you don't want to run the helper scripts, just use compose directly:

```cmd
copy .env.example .env
notepad .env
docker compose up -d
```

Caveats:

- The `~/.config/clickup-tracker/config.json` writer in `install.sh` is skipped — Claude Code hooks won't auto-configure. You can write the file by hand:
  ```json
  { "base_url": "http://localhost:4020", "default_org_id": "00000000-0000-0000-0000-000000000000", "auth_token": "" }
  ```
  Place it at `%APPDATA%\clickup-tracker\config.json`.
- The MCP server build is skipped — run `cd mcp && npm install && npm run build` manually.

## Path conventions

| Location | Linux / macOS | Windows |
|---|---|---|
| User config | `~/.config/clickup-tracker/` | `%APPDATA%\clickup-tracker\` |
| Per-project hook secrets | `~/.config/clickup-tracker/projects/` | `%APPDATA%\clickup-tracker\projects\` |
| Buffered post-commit payloads | `~/.cache/cup-cli/buffer/` | `%LOCALAPPDATA%\cup-cli\buffer\` |

`install.sh` translates between MSYS-style (`/c/Users/...`) and Windows (`C:\Users\...`) paths automatically.

## Post-commit hooks on Windows

Git for Windows runs `.git/hooks/post-commit` through its bundled `sh.exe` (MSYS), so the bash hook script works as-is — no need to rewrite it as `.bat` or `.ps1`.

If you have aggressive antivirus, allowlist:

- `bash.exe` (Git for Windows)
- `docker.exe`
- `~/.cache/cup-cli/buffer/` (the post-commit retry buffer)

## Known gotchas

- **Line endings.** Hook scripts are `LF`. If your editor or `.gitattributes` rewrites them to `CRLF`, the hook fails with `bad interpreter`. Add `* text=auto eol=lf` to a root `.gitattributes` or run `git config core.autocrlf input`.
- **Docker Desktop file sharing.** If your repo lives outside the Docker Desktop file-sharing roots, the daemon can't read it for drift checks. Add the drive (Settings → Resources → File sharing).
- **Defender realtime scan.** Building the MCP server and the daemon image both write a lot of small files. Excluding `node_modules\` from realtime scan speeds installs by 5-10×.
