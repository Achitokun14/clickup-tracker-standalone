# Deployment

The daemon is designed to run anywhere Docker runs — laptop, VPS, NAS, K8s, anywhere. This page covers the common deployment shapes.

## Local-only (default)

```bash
cp .env.example .env
$EDITOR .env  # CLICKUP_API_TOKEN, CLICKUP_TEAM_ID
bash install.sh
```

`docker-compose.yml` declares `restart: always` on every service so the stack auto-recovers on host reboot, container crash, and `docker compose down/up` cycles.

## Customizing the port

Edit `.env`:

```env
TRACKER_PORT=8080
POSTGRES_PORT=5433     # if 5432 is taken by host postgres
REDIS_PORT=6380        # if 6379 is taken by host redis
```

Then `docker compose up -d --force-recreate`.

## Exposing beyond localhost

**Always set `STANDALONE_API_TOKEN` first** when binding to a non-localhost address.

```bash
echo "STANDALONE_API_TOKEN=$(openssl rand -hex 32)" >> .env
docker compose up -d --force-recreate clickup-tracker
```

Re-run `bash install.sh` so the new token is mirrored into `~/.config/clickup-tracker/config.json`.

### Reverse proxy: nginx

```nginx
server {
  listen 443 ssl http2;
  server_name tracker.example.com;

  ssl_certificate     /etc/letsencrypt/live/tracker.example.com/fullchain.pem;
  ssl_certificate_key /etc/letsencrypt/live/tracker.example.com/privkey.pem;

  client_max_body_size 8m;

  location / {
    proxy_pass         http://127.0.0.1:4020;
    proxy_http_version 1.1;
    proxy_set_header   Host $host;
    proxy_set_header   X-Real-IP $remote_addr;
    proxy_set_header   X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header   X-Forwarded-Proto https;
    proxy_read_timeout 60s;
  }
}
```

### Reverse proxy: caddy

```caddy
tracker.example.com {
  reverse_proxy 127.0.0.1:4020
}
```

Caddy auto-provisions Let's Encrypt — no extra config needed.

### Firewall

If the host runs `ufw` (Linux) or pf (macOS), restrict ingress to the proxy ports:

```bash
sudo ufw allow 443/tcp
sudo ufw deny 4020/tcp
sudo ufw deny 5432/tcp
sudo ufw deny 6379/tcp
```

The reverse proxy talks to `127.0.0.1:4020`; the host binding stays loopback.

## TLS notes

- The daemon does **not** terminate TLS itself. Use a reverse proxy.
- Webhooks from the post-commit hook respect the proxy's TLS — set `--base https://tracker.example.com` on `install-git-hook.sh`.
- HMAC payload signing happens regardless of TLS — TLS adds confidentiality, HMAC adds integrity + auth.

## Postgres durability

The `cup_pgdata` named volume holds all daemon state. Snapshot it for backup:

```bash
docker run --rm \
  -v cup_pgdata:/source:ro \
  -v "$PWD":/backup \
  alpine tar czf /backup/cup_pgdata-$(date +%F).tgz -C /source .
```

Restore:

```bash
docker compose down -v   # destructive — wipes existing volume
docker volume create cup_pgdata
docker run --rm \
  -v cup_pgdata:/target \
  -v "$PWD":/backup \
  alpine tar xzf /backup/cup_pgdata-2026-04-28.tgz -C /target
docker compose up -d
```

## Changing the Postgres password mid-life

Postgres only initializes credentials from env on **first** boot. To change them after data exists:

```bash
docker compose exec postgres \
  psql -U cup -d clickup_tracker -c "ALTER USER cup WITH PASSWORD 'newpass';"
```

Then update `POSTGRES_PASSWORD` in `.env` and `docker compose up -d --force-recreate clickup-tracker`. (No need to drop the volume.)

## Restart-on-boot

`docker-compose.yml` already sets `restart: always` on every service. The host's Docker daemon also needs to start at boot:

- Linux (systemd): `sudo systemctl enable docker`
- macOS: Docker Desktop → Settings → "Start Docker Desktop when you sign in"
- Windows: Docker Desktop has the same setting

## Multi-machine setup

The daemon is single-tenant per `organisation_id`. To run multiple "orgs" on one daemon, just pass different `X-Organisation-Id` values; the data partitions automatically.

For multiple **machines** mirroring into the same daemon, install the post-commit hook on each machine pointing at the shared `--base` URL. The drift cron handles cross-machine commits.

## Kubernetes (sketch)

A full Helm chart isn't shipped (yet). For a hand-rolled deployment:

- One Deployment for `clickup-tracker` (replicas: 1 — the BullMQ worker is in-process).
- One StatefulSet for Postgres + one for Redis (or external managed instances).
- Configure `DATABASE_URL` and `REDIS_URL` env vars to point at them.
- Mount `STANDALONE_API_TOKEN` and `CLICKUP_API_TOKEN` from a `Secret`.
- Expose the deployment behind an Ingress with TLS.

PRs welcome to add `deploy/k8s/` with a working manifest.

## Observability

- Logs: structured pino JSON on stdout. Aggregate via `docker logs` or any sidecar.
- Metrics: Prometheus at `/public/metrics` (gated by optional `METRICS_AUTH_TOKEN`).
- Tracing: not built in. The codebase doesn't pull `@opentelemetry/*`.
