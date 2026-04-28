## Summary

<!-- One or two sentences: what does this PR do? -->

## Why

<!-- The problem this solves, or the user-facing reason for the change. -->

## Test plan

<!-- Bulleted checklist of how the reviewer can verify this. -->

- [ ] `cd service && npm run lint` passes
- [ ] `cd service && npm run build` passes
- [ ] `cd service && npm test` passes
- [ ] `docker compose build` succeeds
- [ ] Manual verification (describe steps):

## Screenshots / output

<!-- Optional: paste relevant terminal output, screenshots, or curl examples. -->

## Linked issues

<!-- Closes #123, Refs #456. -->

## Checklist

- [ ] Conventional Commit message (`feat:`, `fix:`, `docs:`, `chore:`, …)
- [ ] Docs updated (README, `docs/`, `CREDS.md`, etc.) if behavior or interface changed
- [ ] `CHANGELOG.md` entry added under `[Unreleased]`
- [ ] No secrets in the diff (`.env`, `SECRETS.md`, hook secrets, API tokens)
- [ ] Relevant tests added or updated
