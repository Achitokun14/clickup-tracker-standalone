# Claude-Code-compatible agents (OpenClaw / ZeroClaw / ClawCode)

These agents are forks of Claude Code that share the `~/.claude/` config convention but live in different directories (e.g. `~/.openclaw/`, `~/.zeroclaw/`, `~/.clawcode/`). The `install.sh` here is a thin wrapper that forwards to `agents/claude-code/install.sh --target <dir>`.

## Install

```bash
# Auto-detect by scanning for known dirs in $HOME:
bash agents/claude-compat/install.sh

# Or explicitly pick one:
bash agents/claude-compat/install.sh --target $HOME/.openclaw
bash agents/claude-compat/install.sh --target $HOME/.zeroclaw
bash agents/claude-compat/install.sh --target $HOME/.clawcode
```

The wrapper installs the same 7 slash commands, both lifecycle hooks, and the MCP server entry as the Claude Code installer.

## Uninstall

```bash
bash agents/claude-compat/install.sh --target $HOME/.openclaw --uninstall
```

## If your Claude-Code fork uses a different config schema

If a fork has changed `settings.json` shape (e.g. renamed `hooks.Stop` to something else), the patch step won't work cleanly. Open an issue with the fork's settings schema and we'll add a per-fork branch to the patcher.
