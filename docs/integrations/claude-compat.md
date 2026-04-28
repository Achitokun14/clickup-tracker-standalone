# Claude-Code-compatible agents

[OpenClaw](https://github.com/openclaw), [ZeroClaw](https://github.com/zeroclaw), [ClawCode](https://github.com/clawcode), and other Claude-Code-derived agents share the same `~/.claude/`-style config convention but live in different directories (`~/.openclaw/`, `~/.zeroclaw/`, `~/.clawcode/`, etc.).

The `agents/claude-compat/` shim is a thin wrapper that auto-detects the right directory and forwards to the Claude Code installer with `--target`.

## Install

Auto-detect:

```bash
bash install.sh --agent claude-compat
# or directly:
bash agents/claude-compat/install.sh
```

Explicit target:

```bash
bash agents/claude-compat/install.sh --target $HOME/.openclaw
bash agents/claude-compat/install.sh --target $HOME/.zeroclaw
bash agents/claude-compat/install.sh --target $HOME/.clawcode
```

The installer scans `$HOME` for known dirs (`.openclaw`, `.zeroclaw`, `.clawcode`, `.claw`, `.claude`) in that order and uses the first one that exists.

## What gets installed

Same as `agents/claude-code/`:

- 7 slash commands → `<target>/commands/`
- 2 hooks → `<target>/hooks/`
- `<target>/settings.json` patched with hook entries + MCP server

## When the wrapper might not work

If a fork has changed the `settings.json` schema (e.g. renamed `hooks.Stop` → `hooks.onStop`), the patch step won't find anything to patch and will silently no-op the hook wiring. The slash commands and the MCP server entry will still install correctly — only the lifecycle hooks need manual wiring.

If you hit this, please [open an issue](https://github.com/Achitokun14/clickup-tracker-standalone/issues/new?template=bug_report.md) with the fork name and its settings schema. We'll add a per-fork branch in the patcher.

## Uninstall

```bash
bash agents/claude-compat/install.sh --target $HOME/.openclaw --uninstall
```
