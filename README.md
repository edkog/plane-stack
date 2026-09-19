# plane-stack

Self-hosted [Plane](https://plane.so) (Community Edition) with **no outbound network
access**, deployed from this repository, plus Plane's official
[MCP server](https://github.com/makeplane/plane-mcp-server) so an AI assistant can work the
issue tracker — each person as themselves, with their own token.

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
| MCP server | `makeplane/plane-mcp-server`, built from its repo |
| Services | 14 containers |
| Deploy method | Portainer → Stacks → Repository |

---

## Architecture

Fourteen containers. Plane is not a small application, and this is worth knowing before
choosing it over something with a single binary and a SQLite file.

| Service | Image | Role |
|---|---|---|
| `web` | plane-frontend | The main UI |
| `space` | plane-space | Public/shared views |
| `admin` | plane-admin | Instance administration ("God Mode") |
| `live` | plane-live | WebSocket server for collaborative editing |
| `api` | plane-backend | Django REST API — everything the MCP server talks to |
| `worker` | plane-backend | Celery worker |
| `beat-worker` | plane-backend | Celery beat scheduler |
| `migrator` | plane-backend | Runs DB migrations on deploy, then exits |
| `proxy` | plane-proxy (Caddy) | Routes to the right service; the web UI's published port |
| `plane-db` | postgres:15.7 | Primary database |
| `plane-redis` | valkey:7.2.11 | Cache and Celery broker |
| `plane-mq` | rabbitmq:3.13.6 | Task queue |
| `plane-minio` | minio | S3-compatible storage for attachments |
| `plane-mcp` | built from `makeplane/plane-mcp-server` | MCP endpoint for AI assistants |

`migrator` exiting with code 0 is normal. A non-zero exit means the database did not
migrate — read its logs before assuming anything else is broken.

## Sealing the stack

Upstream ships **no `networks:` block at all**, so every service lands on the default
bridge with a route to the internet. That is the single thing this repo changes most.

```
                    ┌─────────────────────────────────────────┐
  browser ──► nginx │ proxy ──► web / api / space / admin /    │
                    │              live / minio                │
  AI      ──► nginx │ plane-mcp ──────────┘ (direct to api)    │
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
- **`mcp-edge`** — the MCP server only, also a fixed subnet, for the same reason.

### The firewall rule is not optional

`internal: true` seals the services behind it, but anything with a published port needs a
routable network — which means that container can still make outbound connections.
Compose alone cannot express "reachable from the LAN but unable to initiate outbound", so
the last step is a host rule per edge subnet:

```bash
# Deny egress from an edge subnet, leaving replies to inbound connections alone.
iptables -I DOCKER-USER -s 192.168.240.0/24 -m conntrack --ctstate NEW -j DROP
iptables -I DOCKER-USER -s 192.168.240.0/24 -m conntrack --ctstate ESTABLISHED,RELATED -j ACCEPT
```

Repeat for `MCP_EDGE_SUBNET` (default `192.168.241.0/24`) — see "Its egress" below before
you do. Persist the rules the way the host persists everything else (`iptables-persistent`,
or a systemd unit) or they disappear on reboot — which is exactly when nobody is watching.

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

## The MCP server

`plane-mcp` is Plane's **official** MCP server, built straight from
`https://github.com/makeplane/plane-mcp-server.git` — nothing is vendored here. It exposes
30 resource-style tools (work items, comments, states, labels, cycles, modules, pages, …)
and reaches Plane over the internal network at `http://api:8000`.

An earlier version of this repo carried its own 19-tool bridge. It was replaced because the
upstream server covers far more of Plane, is maintained by Plane, and handles per-person
auth more simply. The lesson is in the history: check whether the upstream project ships the
thing before building it.

### Auth: one token per person

The endpoint for token auth is **`/http/api-key/mcp`**. Each person creates their own
personal access token in Plane (profile settings → API tokens) and connects with it, so
everything their assistant does is recorded as them, and adding or revoking someone needs no
change to the stack.

Two things about the server are not what its README suggests:

- **The token route reads `x-api-key` and requires `x-workspace-slug`.** It ignores
  `Authorization`, and it ignores the `PLANE_WORKSPACE_SLUG` environment variable for
  per-request auth. Most MCP clients can only send `Authorization: Bearer <token>`.
- **It builds an OAuth app at startup even when you only use tokens**, and advertises it
  under `/.well-known/`. An MCP client that sees that metadata switches to OAuth instead of
  sending its token, and fails with an unhelpful "couldn't reach" error.

Both are fixed at the reverse proxy. For nginx (or Nginx Proxy Manager's *Advanced* tab):

```nginx
# Accept the token as "Authorization: Bearer <token>" (or bare), hand the server
# the headers it actually reads.
location /http/api-key/ {
    set $pat $http_authorization;
    if ($http_authorization ~* "^Bearer\s+(.+)$") { set $pat $1; }
    proxy_set_header Authorization     "Bearer $pat";
    proxy_set_header x-api-key         $pat;
    proxy_set_header x-workspace-slug  your-workspace-slug;
    proxy_set_header Host              $host;
    proxy_set_header X-Forwarded-Proto $scheme;
    proxy_http_version 1.1;
    proxy_set_header Connection "";
    proxy_buffering off;          # MCP streams responses
    proxy_read_timeout 3600s;
    proxy_pass http://<docker-host>:<MCP_PORT_HOST>;
}

# Hide the OAuth surface so clients use the token instead.
location /.well-known/ { return 404; }
location = /authorize  { return 404; }
location = /token      { return 404; }
location = /register   { return 404; }
location /http/mcp     { return 404; }
```

Then a client connects to `https://mcp.example.com/http/api-key/mcp` with
`Authorization: Bearer <their token>`. In Claude's custom connector that is *No sign-in*
plus a request header — the value is sent exactly as typed, so include `Bearer `.

### Startup requirements

The unconditional OAuth app refuses to start without `PLANE_OAUTH_PROVIDER_CLIENT_ID` and
`PLANE_OAUTH_PROVIDER_CLIENT_SECRET`, and interpolates `PLANE_OAUTH_PROVIDER_BASE_URL` into a
URL — unset, it becomes the literal string `None/http` and the container crash-loops. The
compose file sets the first two to the placeholder `unused` and the third from
`MCP_PUBLIC_URL`. The OAuth route is hidden at the proxy, so the placeholders are never used.

`LOG_PAYLOADS` is set to `false`. Upstream defaults it to `true`, which writes request bodies —
ticket contents — into the container log.

### No guardrails

The server will close tickets, archive them, and delete anything its token is allowed to.
Plane's API tokens cannot be scoped per route, so there is nowhere in this stack to refuse
those operations. If some actions should stay human-only, that is a rule for the people and
assistants using it, and it should be written down where they will read it.

### Version skew

The server targets current Plane; this stack pins `v1.4.2`. Core resources work. Newer ones
return 404 on 1.4.2 — confirmed for `release` and grouped `workitem count`, and expect the same
from customers, initiatives and similar. A 404 there means "not on this Plane version", not a
broken deploy. Upgrading Plane is the fix.

### Its egress

`plane-mcp` reaches Plane internally and validates tokens against `api`, so it should need no
outbound access and can take the same `DOCKER-USER` rule as the proxy. The exception is
`workitem_attachment upload_from_url`, which fetches a URL server-side — seal the subnet and
that one action stops working, which is usually the right trade. Run the verification
commands against `plane-mcp` after adding the rule.

### Diagnosing a client that won't connect

Split the layers before changing anything. On the Docker host, with a real token read into a
variable (`read -s PAT`) so it stays out of shell history:

1. `curl -H "x-api-key: $PAT" http://localhost:<LISTEN_HTTP_PORT>/api/v1/users/me/` → `200`
   means the token is valid.
2. POST an MCP `initialize` to `http://localhost:<MCP_PORT_HOST>/http/api-key/mcp` with
   `x-api-key` and `x-workspace-slug` → `200` means the server accepts it.
3. The same through the reverse proxy with only `Authorization` → `200` means the header
   translation works.

If all three pass, the problem is in the client. The API logs settle it: a real token check
appears as `GET /api/v1/users/me/` from `python-httpx`; if a client's attempts produce none,
its token never reached the server.

## Configuration

Set these as **stack environment variables** in Portainer. The compose file refuses to
start rather than fall back to a weak default for anything marked required — an empty
value produces a clear error instead of a publicly-reachable instance with the password
`plane`.

| Variable | Required | Notes |
|---|---|---|
| `APP_DOMAIN` | yes | Bare hostname, no scheme |
| `WEB_URL` | yes | Full URL, e.g. `https://plane.example.com`. Also the MCP server's `PLANE_BASE_URL` |
| `CORS_ALLOWED_ORIGINS` | yes | Same origin as `WEB_URL` |
| `SECRET_KEY` | yes | `openssl rand -hex 32` |
| `LIVE_SERVER_SECRET_KEY` | yes | `openssl rand -hex 32`, different value |
| `POSTGRES_PASSWORD` | yes | |
| `RABBITMQ_PASSWORD` | yes | |
| `AWS_ACCESS_KEY_ID` / `AWS_SECRET_ACCESS_KEY` | yes | MinIO's own credentials |
| `LISTEN_HTTP_PORT` | yes | What nginx points at for the web UI, e.g. `8080` |
| `PLANE_WORKSPACE_SLUG` | yes | The slug in `/api/v1/workspaces/<slug>/` |
| `MCP_PUBLIC_URL` | yes | The MCP server's public base URL, e.g. `https://mcp.example.com` |
| `MCP_PORT_HOST` | no | Host port for the MCP server; defaults to `8790` |
| `APP_RELEASE` | no | Defaults to the pinned `v1.4.2` |
| `MINIO_IMAGE` | no | Pin this to a dated tag; upstream uses `:latest` |
| `API_KEY_RATE_LIMIT` | no | See below |
| `PLANE_EDGE_SUBNET` / `MCP_EDGE_SUBNET` | no | Must match the firewall rules |

Use **hex-only values** for every secret. Compose interprets `$` in variable values, so a
token containing one silently differs inside the container from what was pasted.

`CERT_EMAIL`, `CERT_ACME_CA` and `CERT_ACME_DNS` are left blank on purpose. Setting any
of them makes Caddy attempt ACME, which is an outbound call to Let's Encrypt. TLS belongs
at nginx. Never set `CERT_ACME_CA` to an *empty string* either — Caddy's `{$VAR:default}`
only applies when a variable is unset, and a blank one crash-loops the proxy.

### Rate limits

Plane throttles API keys at **60 requests per minute** by default — and every MCP call is an
API-key call. That is fine for interactive use and far too low for a bulk import: a few
hundred issues, each needing a create plus labels plus comments, will exhaust it in seconds
and start returning 429.

Raise `API_KEY_RATE_LIMIT` for a migration run, redeploy, do the import, then put it
back. Do not leave it raised — it is a real protection for a public-facing instance.

## Deploy

1. Portainer → **Stacks** → **Add stack** → **Repository**, pointing at this repo.
2. Fill in the environment variables above.
3. Deploy. First run pulls ~13 images, builds `plane-mcp` from its git repo, and runs
   `migrator`; give it a few minutes.
4. Apply the `DOCKER-USER` rules and persist them.
5. Point nginx at `LISTEN_HTTP_PORT` on this host and terminate TLS there.
6. Add a second nginx host for the MCP server at `MCP_PORT_HOST`, with the header
   translation and OAuth blocks from "The MCP server" above.
7. Browse to the domain, create the instance admin (a **local** account — this is not a
   registration with Plane), then go to `/god-mode` and turn telemetry off.
8. Run the verification commands above and confirm every one says BLOCKED.

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

The MCP server is stateless — it keeps nothing worth backing up.

A restore has never been tested until it has been tested. Put it on the calendar.

## Upgrading

The compose file here is vendored from upstream with a small number of marked changes,
so an upgrade is a diff rather than a merge:

1. Fetch `deployments/cli/community/docker-compose.yml` at the new tag.
2. Diff it against this file, ignoring lines marked `# +`.
3. Apply real upstream changes, keep the `# +` ones, bump `APP_RELEASE`.
4. Redeploy, re-run the verification commands, re-check the telemetry toggle.

`plane-mcp` builds from the upstream repo's default branch, so a redeploy can pick up a
newer server. Upgrading Plane itself is also what closes the version-skew 404s above.

## What is not here

- The migration tooling that moved existing issues in.

## Licence

Plane and its MCP server are the work of their authors (Plane is AGPL v3). This repository
contains deployment configuration, not Plane itself.
