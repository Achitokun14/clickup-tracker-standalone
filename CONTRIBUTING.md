# Contributing to clickup-tracker-standalone

Thanks for considering a contribution. This project follows a **PR-only, owner-merge** model: anyone can fork, file issues, and open pull requests; only the repository owner ([@Achitokun14](https://github.com/Achitokun14)) merges into `main`.

## TL;DR

1. **Discuss first for non-trivial changes** — open a GitHub Discussion or Issue before sinking time into a large patch.
2. **Fork → feature branch → PR against `main`**. Direct pushes to `main` are blocked by branch protection.
3. **Conventional Commits** for commit messages (`feat:`, `fix:`, `docs:`, `chore:`, `refactor:`, `test:`, optional scope).
4. **Lint + tests must pass** locally and in CI before review.
5. **Update docs in the same PR** — if you change a service or interface, update its docs.
6. **No secrets in diffs** — `.env`, `SECRETS.md`, hook secrets, API tokens.

---

## Development setup

Requires: Docker 24+, Node 20 or 22, `git`, `bash`, `jq`, `openssl`.

```bash
# 1. Clone your fork
git clone https://github.com/<your-handle>/clickup-tracker-standalone
cd clickup-tracker-standalone

# 2. Bring up the stack (Postgres + Redis + daemon)
cp .env.example .env
$EDITOR .env             # fill in CLICKUP_API_TOKEN + CLICKUP_TEAM_ID
bash scripts/self-setup.sh

# 3. Verify
curl -fsS http://localhost:4020/health
```

For a code-only loop (no Docker), run the service directly:

```bash
cd service
npm install
npm run build
npm run dev              # nest start --watch
```

You'll need a Postgres + Redis running somewhere reachable; export `DATABASE_URL` and `REDIS_URL` accordingly.

---

## Branch model

- `main` is always deployable. Direct pushes are blocked.
- Feature branches: `feat/<short-name>`, `fix/<short-name>`, `docs/<short-name>`, `chore/<short-name>`.
- One PR per logical change. Stack PRs if a change naturally splits.
- Rebase on `main` before requesting review; the repo enforces linear history (no merge commits).

---

## Commit messages — Conventional Commits

The codebase parses commit messages with [Conventional Commits](https://www.conventionalcommits.org/) (see [`service/src/events/conventional.ts`](./service/src/events/conventional.ts) — the same parser the daemon uses to drive ClickUp actions).

```
<type>(<optional-scope>): <imperative subject>

<optional body — explain WHY, not WHAT>

<optional footers>
BREAKING CHANGE: <description>
```

Types: `feat`, `fix`, `docs`, `chore`, `refactor`, `test`, `perf`, `style`, `ci`, `build`.

Add `clickup-skip` anywhere in the body or footers if you do **not** want a tracked deployment of the daemon to mirror this commit into ClickUp.

---

## Pull request process

1. **Open the PR against `main`.** Fill in the PR template (Summary / Why / Test plan).
2. **CI runs automatically** — `lint` + `build` + `test` on Node 20 and 22, plus a `docker compose build` job.
3. **Request review** from `@Achitokun14`. The `CODEOWNERS` file does this automatically.
4. **Address review feedback** by pushing additional commits; do not force-push during review unless asked.
5. **Owner merges.** Squash-merge is the default; the PR title becomes the squashed commit message, so make it Conventional-Commits-shaped.

Expected review cadence: **best-effort 1–3 business days**. If a PR sits longer, ping the issue/PR — it's fine.

### What gets merged quickly

- Bug fixes with a regression test.
- Doc improvements that don't change behavior.
- New `agents/<name>/` integration shims that call the existing daemon API or the existing MCP server (no daemon-side changes needed).

### What needs discussion first

- New daemon endpoints or schema changes.
- Replacing or removing existing public behavior.
- New hard dependencies (extra services, new SDKs).
- Cross-cutting refactors (>5 files).

---

## Code style

- TypeScript: ESLint config in [`service/.eslintrc`](./service); run `cd service && npm run lint`.
- Bash: target Bash 4+ syntax (Linux + macOS Git Bash + WSL2). Always `set -euo pipefail`.
- Markdown: GitHub-flavored; one sentence per line is fine but not required.
- No comments explaining *what* the code does — name things well. Comments for *why* (non-obvious constraints, workarounds) are encouraged.

---

## Testing

```bash
cd service
npm test                  # all jest tests
npm test -- hierarchy     # filter by name
```

New features should ship with at least one test. Pure functions (like the planner in `service/src/bulk/hierarchy.ts` and the parser in `service/src/events/conventional.ts`) are easiest — please add cases there when extending them.

---

## Licensing

This repository is licensed under [AGPL-3.0](./LICENSE). By submitting a PR you agree your contribution is licensed under the same terms. There is no separate CLA — AGPL covers it.

If your contribution depends on third-party code, make sure that code is AGPL-compatible (most permissive licenses are; copyleft licenses other than GPL/AGPL are not).

---

## Reporting security issues

Don't open a public issue for security bugs — see [SECURITY.md](./SECURITY.md) for the private disclosure process.

---

## Code of conduct

This project adopts the [Contributor Covenant 2.1](./CODE_OF_CONDUCT.md). All interactions on issues, PRs, and Discussions are subject to it.

---

## Questions?

Open a [GitHub Discussion](https://github.com/Achitokun14/clickup-tracker-standalone/discussions) — it's the right place for "how do I…", "what's the right way to…", and "should I PR this?" conversations.
