# Credentials Reference

This file documents **what** credentials clickup-tracker needs and **where to obtain them**. It is committed to the repository so anyone can read it.

The actual secret *values* go into a local `SECRETS.md` (gitignored) and the daemon's `.env` (also gitignored). Never paste real credentials into this file.

| File | Committed? | Purpose |
|---|---|---|
| `CREDS.md` (this file) | ✅ yes | Human-readable docs: what + where to get each credential. |
| `SECRETS.md.example` | ✅ yes | Template with placeholder values. Copy → `SECRETS.md` and fill in. |
| `SECRETS.md` | ❌ gitignored | Your filled-in credential bundle. Never leaves your machine. |
| `.env` | ❌ gitignored | What the daemon actually reads at runtime. Mirror your `SECRETS.md` values into here. |
| `.env.example` | ✅ yes | Template `.env` with placeholders. Copy → `.env` and fill in. |

---

## 1. ClickUp API token (required)

The daemon uses one ClickUp API token to authenticate every request to ClickUp's REST API.

**Format:** `pk_XXXXXXXXXXXXXXXXXXXXXXXXX` (string starting with `pk_`).

**How to obtain:**
1. Sign in to ClickUp.
2. Open your avatar menu → **Settings** → **Apps**.
3. Under **API Token**, click **Generate** (or **Regenerate**).
4. Copy the value immediately — ClickUp only displays it once.

**Where it goes:**
- `SECRETS.md` → `CLICKUP_API_TOKEN` row
- `.env` → `CLICKUP_API_TOKEN=pk_...`

**Permissions implied:** the token inherits your ClickUp account's permissions. Use a service account if you don't want the tracker to act as your personal user.

---

## 2. ClickUp team (workspace) ID (required)

Every API call needs the numeric ID of the ClickUp Team (a.k.a. Workspace) you want the tracker to write into.

**Format:** integer, e.g. `12345678`.

**How to obtain:**
1. Open the workspace you want to use in ClickUp.
2. Look at the URL — it's the integer right after `app.clickup.com/`, e.g. `https://app.clickup.com/12345678/v/...`.
3. Copy the integer.

**Where it goes:**
- `SECRETS.md` → `CLICKUP_TEAM_ID` row
- `.env` → `CLICKUP_TEAM_ID=12345678`

You can also set `CLICKUP_TEAM_NAME` to a human-friendly label (only used for display in logs).

---

## 3. `STANDALONE_API_TOKEN` (optional)

A static bearer token that protects the daemon's **internal** routes (`POST/PATCH/DELETE /projects/*`). Public webhook routes (`/public/*`) remain HMAC-only and ignore this token.

**When you need it:**
- ✅ The daemon is exposed beyond `localhost` (reverse proxy, public IP, tunnel).
- ❌ The daemon is bound to localhost on a single-user machine.

**Format:** any opaque string. Recommended: 32 hex bytes (`openssl rand -hex 32`).

**How to generate:**
```bash
openssl rand -hex 32
# or
python3 -c 'import secrets; print(secrets.token_hex(32))'
```

**Where it goes:**
- `SECRETS.md` → `STANDALONE_API_TOKEN` row
- `.env` → `STANDALONE_API_TOKEN=<hex>`

Clients pass it as `Authorization: Bearer <hex>` on internal route requests.

---

## 4. `METRICS_AUTH_TOKEN` (optional)

A separate bearer for `GET /public/metrics` (Prometheus scrape endpoint). Independent from `STANDALONE_API_TOKEN` so you can give Prometheus a read-only credential.

**When you need it:** if Prometheus scrapes the metrics endpoint over an untrusted network. For localhost-only Prometheus, leave it empty.

**Format and generation:** same as `STANDALONE_API_TOKEN` (32 hex bytes via `openssl rand -hex 32`).

**Where it goes:**
- `SECRETS.md` → `METRICS_AUTH_TOKEN` row
- `.env` → `METRICS_AUTH_TOKEN=<hex>`

Prometheus scrape config example:
```yaml
scrape_configs:
  - job_name: clickup_tracker
    static_configs:
      - targets: ['localhost:4020']
    metrics_path: /public/metrics
    bearer_token: <the same hex>
```

---

## 5. Postgres credentials (defaults are fine for localhost)

The Docker stack ships its own Postgres at `postgres:5432` inside the compose network. By default the credentials are `cup` / `cup` / `clickup_tracker`. **Change these if you expose Postgres beyond the compose network.**

**Where they go:**
- `.env` → `POSTGRES_USER`, `POSTGRES_PASSWORD`, `POSTGRES_DB`

If you change them after first boot, you must drop the `cup_pgdata` named volume (`docker compose down -v`) so Postgres re-initializes — otherwise the new password won't apply to the existing data directory.

---

## 6. Per-project hook secrets (auto-generated, not user-supplied)

Each tracked repo gets its own `hook_secret` (32 random hex bytes), generated server-side when you call `POST /projects` and returned **once** in the response.

The post-commit hook signs every webhook payload with this secret using HMAC-SHA256, and the daemon verifies the signature via `GitHmacGuard`. Different projects have different secrets → compromise of one secret only affects one project.

**How they're cached:**
- The `install-git-hook.sh` script writes the secret to `~/.config/clickup-tracker/projects/<project-id>.secret` (mode `600`).
- The Claude Code Stop hook reads the same file when signing prompt-event webhooks.

**Rotation:** delete and re-register the project. There is currently no rotate-in-place endpoint (planned for v0.2).

**Where they go in `SECRETS.md`:** there's a "Per-project hook secrets" section at the bottom of the template — fill it in only if you want a manual backup outside `~/.config/`.

---

## Quick checklist for first-time setup

1. `cp .env.example .env`
2. `cp SECRETS.md.example SECRETS.md`
3. Generate ClickUp API token (§1) and team ID (§2). Paste both into `.env` and `SECRETS.md`.
4. (Optional) Generate `STANDALONE_API_TOKEN` (§3) if exposing beyond localhost.
5. (Optional) Generate `METRICS_AUTH_TOKEN` (§4) if exposing metrics scrape.
6. (Optional) Change Postgres password (§5) if exposing the DB port.
7. `bash scripts/self-setup.sh` → daemon comes up, `/health` returns 200.
8. `POST /projects` to register your first repo (see `docs/quickstart.md`).
