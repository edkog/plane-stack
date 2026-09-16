# plane-stack

Self-hosted [Plane](https://plane.so) (Community Edition) with **no outbound network
access**, deployed from this repository, plus an MCP bridge that lets an AI assistant
work the issue tracker as a first-class user.

Plane's own Community Edition is AGPL v3 and needs no licence key, account or signup.
What it *does* do out of the box is send telemetry home — instance id, workspace and
issue counts, anonymised usage, machine and OS details, stack traces, and the instance
admin's name and email. This repository exists to run it and have that be impossible
rather than merely switched off.

| | |
|---|---|
| Upstream | `makeplane/plane`, Community Edition |
| Pinned release | `v1.4.2` |
| Vendored from | `deployments/cli/community/docker-compose.yml` |
| Services | 13 containers |
| Deploy method | Portainer → Stacks → Repository |

---

## Architecture

Thirteen containers. Plane is not a small application, and this is worth knowing before
choosing it over something with a single binary and a SQLite file.

| Service | Image | Role |
|---|---|---|
| `web` | plane-frontend | The main UI |
| `space` | plane-space | Public/shared views |
| `admin` | plane-admin | Instance administration ("God Mode") |
| `live` | plane-live | WebSocket server for collaborative editing |
| `api` | plane-backend | Django REST API — everything the bridge talks to |
| `worker` | plane-backend | Celery worker |
| `beat-worker` | plane-backend | Celery beat scheduler |
| `migrator` | plane-backend | Runs DB migrations on deploy, then exits |
| `proxy` | plane-proxy (Caddy) | Routes to the right service; the only published port |
| `plane-db` | postgres:15.7 | Primary database |
| `plane-redis` | valkey:7.2.11 | Cache and Celery broker |
| `plane-mq` | rabbitmq:3.13.6 | Task queue |
| `plane-minio` | minio | S3-compatible storage for attachments |

`migrator` exiting with code 0 is normal, the same way `vikunja-init` is in the sibling
repo. A non-zero exit means the database did not migrate — read its logs before assuming
anything else is broken.

## Sealing the stack

Upstream ships **no `networks:` block at all**, so every service lands on the default
bridge with a route to the internet. That is the single thing this repo changes most.

```
                    ┌─────────────────────────────────────────┐
  browser ──► nginx │ proxy ──► web / api / space / admin /    │
                    │              live / minio                │
  Claude  ──► nginx │ plane-mcp ──────────┘ (direct to api)    │
                    │                                          │
                    │  plane-internal: internal: true,         │
                    │  no gateway, nothing reaches out         │
                    └─────────────────────────────────────────┘
```

Three networks:

- **`plane-internal`** — `internal: true`. No gateway, so no service on it can reach
  anything off the host. Every container sits here. Image pulls still work: those are
  done by the Docker daemon, not by the containers.
- **`plane-edge`** — the proxy only, with a fixed subnet, so nginx on the other VM can
  reach it. A published port requires a routable network, so this one is *not* internal.
- **`mcp-edge`** — the MCP bridge only, also a fixed subnet. Deliberately not sealed;
  see "The bridge's egress" below.

### The firewall rule is not optional

`internal: true` seals the twelve services behind it, but the proxy needs a published
port and therefore a routable network — which means the proxy container itself can still
make outbound connections. Compose alone cannot express "reachable from the LAN but
unable to initiate outbound", so the last step is a host rule:

```bash
# Deny egress from the proxy's subnet, leaving replies to inbound connections alone.
iptables -I DOCKER-USER -s 172.31.240.0/24 -m conntrack --ctstate NEW -j DROP
iptables -I DOCKER-USER -s 172.31.240.0/24 -m conntrack --ctstate ESTABLISHED,RELATED -j ACCEPT
```

Persist it the way the host persists everything else (`iptables-persistent`, or a
systemd unit) or it disappears on reboot — which is exactly when nobody is watching.

### Verify it, don't trust it

A sealed stack that was never tested is a belief, not a control. From the host:

```bash
# Should fail, every one of them.
docker compose exec proxy sh -c 'wget -qO- -T5 https://example.com || echo BLOCKED'
docker compose exec api    sh -c 'python -c "import socket;socket.create_connection((\"1.1.1.1\",443),5)" || echo BLOCKED'
docker compose exec api    sh -c 'getent hosts plane.so || echo "NO DNS (expected)"'

# And the rule is actually being hit:
iptables -L DOCKER-USER -v -n --line-numbers
```

The packet counter on the DROP rule going up over a few days is the real evidence:
something in there is still trying, and now it can't.

### Turn telemetry off as well

Belt and braces. The network rule means it cannot phone home; this means it does not
try, and it switches off the in-app chat widget at the same time.

1. Browse to `https://<your-domain>/god-mode`
2. General Settings → **Telemetry** → off → Save

Re-check this after every upgrade. It is a row in the database, and nothing guarantees a
future migration leaves it alone.

### The bridge's egress

The MCP bridge sits on `mcp-edge` and **is** allowed out. That is a deliberate exception,
not an oversight: `attach_from_url` fetches a URL the caller hands it and pushes the
bytes into Plane, which is how screenshots move without passing base64 through a model.
It sends nothing about the instance — it is a download, not a report.

The cost is an SSRF surface: anyone holding a bridge token could aim it at an internal
address. The bridge therefore refuses non-`https` URLs and any address in a private,
loopback or link-local range, and honours an optional `MCP_FETCH_ALLOW_HOSTS` allowlist.

If you would rather have no exception at all, put `plane-mcp` on `plane-internal` only
and drop `attach_from_url`. Everything else in the bridge works sealed.

## Configuration

Set these as **stack environment variables** in Portainer. The compose file refuses to
start rather than fall back to a weak default for anything marked required — an empty
value produces a clear error instead of a publicly-reachable instance with the password
`plane`.

| Variable | Required | Notes |
|---|---|---|
| `APP_DOMAIN` | yes | Bare hostname, no scheme |
| `WEB_URL` | yes | Full URL, e.g. `https://example.com` |
| `CORS_ALLOWED_ORIGINS` | yes | Same origin as `WEB_URL` |
| `SECRET_KEY` | yes | `openssl rand -hex 32` |
| `LIVE_SERVER_SECRET_KEY` | yes | `openssl rand -hex 32`, different value |
| `POSTGRES_PASSWORD` | yes | |
| `RABBITMQ_PASSWORD` | yes | |
| `AWS_ACCESS_KEY_ID` / `AWS_SECRET_ACCESS_KEY` | yes | MinIO's own credentials |
| `LISTEN_HTTP_PORT` | yes | What nginx points at, e.g. `8080` |
| `APP_RELEASE` | no | Defaults to the pinned `v1.4.2` |
| `MINIO_IMAGE` | no | Pin this to a dated tag; upstream uses `:latest` |
| `API_KEY_RATE_LIMIT` | no | See below |
| `PLANE_EDGE_SUBNET` / `MCP_EDGE_SUBNET` | no | Must match the firewall rules |

Use **hex-only values** for every secret. Compose interprets `$` in variable values, so a
token containing one silently differs inside the container from what was pasted — the
same trap documented in the sibling Vikunja repo, and it costs an afternoon every time.

`CERT_EMAIL`, `CERT_ACME_CA` and `CERT_ACME_DNS` are left blank on purpose. Setting any
of them makes Caddy attempt ACME, which is an outbound call to Let's Encrypt. TLS belongs
at nginx.

### Rate limits

Plane throttles API keys at **60 requests per minute** by default. That is fine for
interactive use and far too low for a bulk import: a few hundred issues, each needing a
create plus labels plus comments, will exhaust it in seconds and start returning 429.

Raise `API_KEY_RATE_LIMIT` for a migration run, redeploy, do the import, then put it
back. Do not leave it raised — it is a real protection for a public-facing instance.

## Deploy

1. Portainer → **Stacks** → **Add stack** → **Repository**, pointing at this repo.
2. Fill in the environment variables above.
3. Deploy. First run pulls ~13 images and runs `migrator`; give it a few minutes.
4. Apply the `DOCKER-USER` rules and persist them.
5. Point nginx at `LISTEN_HTTP_PORT` on this host and terminate TLS there.
6. Browse to the domain, create the instance admin (a **local** account — this is not a
   registration with Plane), then go to `/god-mode` and turn telemetry off.
7. Run the verification commands above and confirm every one says BLOCKED.

**Environment changes need the container recreated, not restarted.** A container's
environment is fixed when it is created; editing a stack variable and restarting leaves
the old value in place, and the symptom is a setting that visibly refuses to take effect.
Use Portainer's "Pull and redeploy", or `docker compose up -d --force-recreate`, and
confirm the container id actually changed.

## Backups

This is the part that is genuinely harder than the stack it replaces. There are three
things to back up and all three are required to restore:

1. **Postgres** — `pg_dump`, not a volume copy of a running database.
2. **MinIO** — the `uploads` volume, or a mirror to somewhere else.
3. **`SECRET_KEY`** — kept with the backup. Without it the restored instance cannot read
   what it encrypted, and no amount of data recovers from that.

A restore has never been tested until it has been tested. Put it on the calendar.

## Upgrading

The compose file here is vendored from upstream with a small number of marked changes,
so an upgrade is a diff rather than a merge:

1. Fetch `deployments/cli/community/docker-compose.yml` at the new tag.
2. Diff it against this file, ignoring lines marked `# +`.
3. Apply real upstream changes, keep the `# +` ones, bump `APP_RELEASE`.
4. Redeploy, re-run the verification commands, re-check the telemetry toggle.

## What is not here yet

- `mcp/` — the MCP bridge. The service is present in `docker-compose.yml` but commented
  out; enable it in the same commit that adds the source, or the build fails.
- The migration tooling that moves existing issues in.

## Licence

Plane is AGPL v3 and belongs to its authors. This repository contains deployment
configuration and a bridge, not Plane itself.
