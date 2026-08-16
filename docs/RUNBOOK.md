# Runbook

> **Superseded.** This runbook describes a single VPS running the API under
> systemd with Docker-based execution. Docker was removed from the project,
> and the supported deployment is now Vercel (web) + a container host (API) +
> MongoDB Atlas — see **[DEPLOY.md](DEPLOY.md)**.
>
> Kept because the operational material below — backup, restore, the incident
> checklist, the metric names — still applies wherever the API runs. Ignore
> every `docker` command in it.

Deploying and operating Codexa on a single VPS.

---

## Why a VPS and not a PaaS

The API needs a Docker daemon to spawn runners. Railway, Render and Fly either
forbid that or require privileged Docker-in-Docker, which is both more fragile
and _less_ secure than a plain VPS. Take the VPS.

A 4 vCPU / 8 GB box (Hetzner CX32, ~€8/mo) comfortably handles the targets in
[PLAN.md §13](PLAN.md).

---

## First deploy

```bash
# ── On the server, as root ────────────────────────────────────────────────────
apt update && apt install -y docker.io docker-compose-plugin nodejs npm ufw
ufw allow 22,80,443/tcp && ufw --force enable

# A dedicated unprivileged user. Its only privilege is the docker group —
# see docs/SECURITY.md §4.1 for why the API is NOT containerised.
useradd --system --home /opt/codexa --shell /usr/sbin/nologin codexa
usermod -aG docker codexa
mkdir -p /opt/codexa/workspaces && chown -R codexa:codexa /opt/codexa

# ── Application ───────────────────────────────────────────────────────────────
cd /opt/codexa
git clone <repo> .
npm ci
npm run build -w @codexa/shared && npm run build -w @codexa/api
npm run runners:build          # must succeed, or execution stays disabled

cp .env.example .env && chmod 600 .env && chown codexa:codexa .env
$EDITOR .env                   # MONGODB_URI, METRICS_PASSWORD, CORS_ORIGINS

# ── Stateful services and TLS ─────────────────────────────────────────────────
cd infra
export CODEXA_API_DOMAIN=api.yourdomain.com CODEXA_ACME_EMAIL=you@example.com
docker compose up -d

# ── The API itself ────────────────────────────────────────────────────────────
cp codexa-api.service /etc/systemd/system/
systemctl daemon-reload && systemctl enable --now codexa-api
```

Frontend: deploy `apps/web` to Vercel with `VITE_API_URL=https://api.yourdomain.com`
— the only variable it needs. Add the Vercel URL to `CORS_ORIGINS` on the API and
restart it.

Authentication needs no setup: accounts and sessions are collections in the same
Mongo the rest of the app uses, so the first person to visit `/sign-up` creates
the first account. Nothing outside the box holds anyone's identity, which is why
the backups below are not optional.

### Verify

```bash
curl -s https://api.yourdomain.com/health          # {"status":"ok"}
curl -s https://api.yourdomain.com/ready | jq      # mongo up, execution enabled
journalctl -u codexa-api -n 50 --no-pager          # "docker execution engine ready"
```

If `/ready` reports execution disabled, the log line above it says exactly why —
almost always missing runner images.

---

## Routine operations

| Task            | Command                                                               |
| --------------- | --------------------------------------------------------------------- |
| Logs, live      | `journalctl -u codexa-api -f`                                         |
| Restart API     | `systemctl restart codexa-api`                                        |
| Deploy          | `git pull && npm ci && npm run build && systemctl restart codexa-api` |
| Rebuild runners | `npm run runners:build && systemctl restart codexa-api`               |
| Metrics         | `curl -u codexa:$METRICS_PASSWORD localhost:4000/metrics`             |
| Disk            | `df -h && docker system df`                                           |

**Restarts are safe.** `SIGTERM` triggers a graceful shutdown that stops
accepting work, kills in-flight runs, and flushes every dirty document to Mongo
before exiting. Skipping that flush would discard up to two seconds of everyone's
unsaved edits on every deploy.

---

## Maintenance

Add to root's crontab:

```cron
# Runner images accumulate layers, and a full disk is the most likely way this
# service dies.
0 4 * * 0  docker system prune -af --filter until=168h

# Belt and braces — the API already sweeps abandoned run workspaces every 60s.
0 * * * *  find /opt/codexa/workspaces -maxdepth 1 -type d -mmin +30 -exec rm -rf {} +
```

Backups run in the `backup` compose service: nightly `mongodump`, 14-day
retention, into `infra/backups`. Ship those off-box to something like Backblaze
B2 — a backup on the same disk is not a backup.

**Rehearse the restore once, before you need it:**

```bash
docker compose exec -T mongo mongorestore --archive --gzip --drop \
  < infra/backups/codexa-YYYYMMDD-HHMMSS.gz
```

---

## Troubleshooting

| Symptom                                  | Likely cause                                                        | Check                                                       |
| ---------------------------------------- | ------------------------------------------------------------------- | ----------------------------------------------------------- |
| Run button says execution is unavailable | Runner images missing, or daemon unreachable                        | `/ready`, then `journalctl -u codexa-api \| grep execution` |
| Sockets connect then immediately drop    | `CORS_ORIGINS` does not include the web origin                      | Browser console; `.env`                                     |
| Every socket fails auth                  | Stored sessions are gone — expired, revoked, or the DB was restored | Sign out and in again; handshake error `data.reason`        |
| Edits don't sync but the page loads      | Client connected to `/collab` but not joined                        | Network tab: `room:join` ack                                |
| Runs queue and never start               | Concurrency saturated, or a wedged container                        | `codexa_queue_depth`, `docker ps`                           |
| Disk full                                | Leaked workspaces or image layers                                   | `du -sh /opt/codexa/workspaces`, `docker system df`         |
| A viewer can edit                        | Would be a serious bug — do not patch around it                     | `collab.test.ts`; open a security advisory                  |

### Metrics worth alerting on

| Metric                                              | Alert when                                               |
| --------------------------------------------------- | -------------------------------------------------------- |
| `codexa_queue_depth`                                | > 10 sustained for 5 min                                 |
| `codexa_runs_total{status="timeout"}`               | rate climbs sharply — usually abuse                      |
| `codexa_ydoc_cache_size`                            | pinned at 200 (the LRU cap) — docs are being evicted hot |
| `codexa_rejected_updates_total{reason="forbidden"}` | a spike means someone is probing                         |
| disk free                                           | < 20%                                                    |

---

## Incident: suspected container escape

1. `systemctl stop codexa-api` — stops accepting new runs.
2. `docker ps -a --filter name=codexa-run` — capture before removing.
3. Preserve `journalctl -u codexa-api --since "2 hours ago"` off-box.
4. Treat the host as compromised: rebuild it rather than cleaning it.
5. Rotate every secret in `.env`, and invalidate every session —
   `db.sessions.deleteMany({})` signs everyone out and cannot be undone by a
   stolen token, since the token is only ever stored as its SHA-256.
6. Before redeploying, switch runners to gVisor (`--runtime=runsc`) or move
   execution to a dedicated host — see [SECURITY.md §4.1](SECURITY.md).
