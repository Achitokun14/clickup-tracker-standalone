---
name: Bug report
about: Something isn't working as documented
title: "bug: <short description>"
labels: bug
assignees: ''
---

## Reproducer

Minimal steps that show the bug:

1.
2.
3.

## Expected

<!-- What did you expect to happen? -->

## Actual

<!-- What actually happened? Include full error message if any. -->

## Daemon logs

```text
# paste relevant lines from:
# docker compose logs --tail=200 clickup-tracker
```

## Environment

- OS: <!-- e.g. Ubuntu 24.04, macOS 15.3, Windows 11 + WSL2 -->
- Docker version: <!-- `docker --version` -->
- Docker Compose version: <!-- `docker compose version` -->
- Node version (only if running outside Docker): <!-- `node --version` -->
- clickup-tracker version / commit: <!-- git rev-parse HEAD or release tag -->
- Agent (if applicable): <!-- Claude Code, Goose, OpenCode, Cursor, none -->

## Additional context

<!-- Anything else useful — relevant `.env` values (redact secrets), recent config changes, network topology. -->
