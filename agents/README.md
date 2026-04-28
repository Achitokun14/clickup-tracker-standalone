# Per-agent integration shims

clickup-tracker is agent-agnostic. The daemon at `:4020` speaks plain HTTP, so any tool that can call HTTP can use it. This directory provides drop-in integrations for the most common AI coding agents.

## Which directory should I use?

| Your agent | Use | Why |
|---|---|---|
| Claude Code | `claude-code/` | Native slash commands + Stop / UserPromptSubmit hooks. |
| OpenClaw / ZeroClaw / ClawCode (Claude-Code forks) | `claude-compat/` | Same `~/.claude/` convention; `--target` flag picks the dir. |
| Goose | `goose/` | Recipes + MCP extension config. |
| OpenCode | `opencode/` | Slash commands + MCP config. |
| Cursor / Cline / Continue / generic MCP client | `generic-mcp/` | Drop-in MCP server snippet. |
| No MCP support | `http-direct/` | Raw HTTP examples (curl + TS / Python / Go). |

All MCP-based integrations point at the universal `mcp/` server in the repo root — there is **one** MCP implementation, not N. The directories here only contain config snippets and shell hooks that are agent-specific.

## Decision tree

```
Does your agent natively support MCP?
├── Yes (Claude Code, Goose, OpenCode, Cursor, Cline, Continue)
│   ├── Need shell hooks too? → use claude-code/ (or claude-compat/)
│   └── MCP only? → use generic-mcp/ + the mcp/ server
└── No → use http-direct/ (raw HTTP examples)
```
