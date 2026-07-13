# Production deployment

This guide covers running Aura on a server you expose to other people — behind a
reverse proxy with TLS — and the settings and habits that keep it secure.

If you just want to try Aura on your LAN, the [README quick start](../README.md)
is enough. Read this before you put it on the public internet.

- [Overview](#overview)
- [Reverse proxy + TLS](#reverse-proxy--tls)
  - [Caddy](#caddy)
  - [Traefik](#traefik)
  - [nginx](#nginx)
- [Streaming considerations](#streaming-considerations)
- [Environment & settings reference](#environment--settings-reference)
- [Hardware acceleration](#hardware-acceleration)
- [Backups & restore](#backups--restore)
- [Security checklist](#security-checklist)
- [Updating](#updating)

---

## Overview

Aura ships as a **single container** that serves both the JSON API and the
bundled web app from the same origin on **port 8096** (HTTP). There is no
separate frontend service to run.

Key facts that shape a production deployment:

- **`/config` volume** — all mutable state lives here: the SQLite database
  (`/config/aura.db`), the artwork cache, HLS transcode scratch, the server
  secrets (`/config/secrets.json`), logs, and database backups
  (`/config/backups`). Persist this volume; everything else in the container is
  disposable. Create the host directory **before** first start so it is owned by
  your user (the container writes to it as uid 1000):

  ```bash
  mkdir -p config
  ```

- **Read-only media** — host media is bind-mounted under `/media/*` **read-only**
  (`:ro`). Aura only ever reads your files; it never writes into the media
  mounts. Keep them read-only.

- **Runs as non-root** — the image creates and runs as the `aura` user
  (uid 1000 / gid 1000). It needs no root privileges; don't add any.

- **Migrations run automatically** — the container entrypoint runs
  `prisma migrate deploy` before the server starts and **fails fast** (exits
  non-zero, server never starts) if a migration cannot be applied. Upgrades need
  no manual migration step — see [Updating](#updating).

- **First user becomes admin** — the very first account you register becomes the
  admin (the registration toggle is ignored while there are zero users). Register
  your own admin account immediately after first start, before anyone else can.

- **Health check** — the container reports readiness on `GET /api/health`
  (returns `{ "status": "ok", "version": "…" }`). The image already wires this
  into a Docker `HEALTHCHECK`; you can also point an external monitor at it.

### HTTPS is required in production

When `NODE_ENV=production` (the value the image sets), the authentication refresh
cookie is issued with the `Secure` flag (plus `HttpOnly` and `SameSite=Strict`).
Browsers only send `Secure` cookies over HTTPS, so **login/session refresh will
not work unless users reach Aura over `https://`.** Always put Aura behind a
TLS-terminating reverse proxy in production. Do not expose the raw `8096` port to
untrusted networks.

Because the session cookie is `SameSite=Strict` and the web app is served from
the same origin as the API, the bundled UI needs no CORS. Only set
[`CORS_ORIGINS`](#environment--settings-reference) if you build a _separate_
first-party client on another origin.

---

## Reverse proxy + TLS

Pick **one** of the proxies below. In every case:

1. Terminate TLS at the proxy and forward to Aura's `8096` over the internal
   Docker network (or `127.0.0.1:8096` if you publish the port only to
   localhost).
2. Forward the standard `X-Forwarded-For` / `X-Forwarded-Proto` headers so Aura
   sees the real client IP and scheme.
3. Set **`TRUST_PROXY=true`** on the Aura container so it trusts those headers
   for rate-limit keys and audit-log IPs. **Only** set this when Aura is actually
   behind a proxy you control — if it is directly reachable, a client can forge
   `X-Forwarded-For` and evade the per-IP rate limits.
4. Optionally set the **`baseUrl`** server setting (Admin → Settings) to the
   external URL, e.g. `https://media.example.com`.

The examples assume the proxy and Aura share a Docker network and that Aura is
reachable as `aura:8096`. Adjust `media.example.com` to your domain.

> Do **not** publish `ports: ['8096:8096']` on the Aura service once a proxy is
> in front of it — drop the `ports:` mapping (or bind it to `127.0.0.1:8096:8096`)
> so the only public entrypoint is the proxy on 443. Put both services on a
> shared user-defined network so the proxy can reach `aura:8096`.

### Caddy

Caddy provisions and renews TLS certificates automatically (Let's Encrypt / ZeroSSL)
and forwards `X-Forwarded-For` / `X-Forwarded-Proto` by default — the smallest
correct setup.

**`Caddyfile`:**

```caddyfile
media.example.com {
	# Automatic HTTPS: Caddy obtains and renews the certificate for this host.
	reverse_proxy aura:8096 {
		# Long transcodes: the first HLS segment can take a while to appear
		# on a cold start, so give upstream reads generous headroom and stream
		# responses straight through rather than buffering them.
		transport http {
			read_timeout 300s
			write_timeout 300s
		}
		flush_interval -1
	}
}
```

**`docker-compose.yml`** (Caddy + Aura on a shared network):

```yaml
services:
  aura:
    build: . # or image: your/aura:tag
    container_name: aura
    restart: unless-stopped
    environment:
      - TRUST_PROXY=true # Caddy is a trusted proxy; safe to trust XFF here
    volumes:
      - ./config:/config
      - /path/to/movies:/media/movies:ro
      - /path/to/tv:/media/tv:ro
      # …other libraries…
    networks: [web]
    # No `ports:` — only Caddy is published.

  caddy:
    image: caddy:2
    container_name: caddy
    restart: unless-stopped
    ports:
      - '80:80'
      - '443:443'
    volumes:
      - ./Caddyfile:/etc/caddy/Caddyfile:ro
      - caddy_data:/data
      - caddy_config:/config
    networks: [web]

networks:
  web:

volumes:
  caddy_data:
  caddy_config:
```

### Traefik

Traefik configures routers/services from container **labels** and can obtain
Let's Encrypt certificates via a certificate resolver.

**Minimal static config — `traefik.yml`:**

```yaml
entryPoints:
  web:
    address: ':80'
    # Redirect all plain HTTP to HTTPS.
    http:
      redirections:
        entryPoint:
          to: websecure
          scheme: https
  websecure:
    address: ':443'

providers:
  docker:
    exposedByDefault: false # only containers with traefik.enable=true are routed

certificatesResolvers:
  le:
    acme:
      email: you@example.com
      storage: /letsencrypt/acme.json
      httpChallenge:
        entryPoint: web
```

**`docker-compose.yml`** (labels on the Aura service):

```yaml
services:
  aura:
    build: . # or image: your/aura:tag
    container_name: aura
    restart: unless-stopped
    environment:
      - TRUST_PROXY=true # Traefik is the trusted proxy
    volumes:
      - ./config:/config
      - /path/to/movies:/media/movies:ro
      # …other libraries…
    networks: [web]
    labels:
      - 'traefik.enable=true'
      - 'traefik.http.routers.aura.rule=Host(`media.example.com`)'
      - 'traefik.http.routers.aura.entrypoints=websecure'
      - 'traefik.http.routers.aura.tls.certresolver=le'
      # Aura listens on 8096; tell Traefik which port to forward to.
      - 'traefik.http.services.aura.loadbalancer.server.port=8096'

  traefik:
    image: traefik:v3
    container_name: traefik
    restart: unless-stopped
    ports:
      - '80:80'
      - '443:443'
    volumes:
      - ./traefik.yml:/traefik.yml:ro
      - ./letsencrypt:/letsencrypt
      - /var/run/docker.sock:/var/run/docker.sock:ro
    networks: [web]

networks:
  web:
```

Traefik forwards `X-Forwarded-For` / `X-Forwarded-Proto` by default and does not
buffer responses, so HLS streaming works without extra tuning.

### nginx

If you terminate TLS with nginx (certificates from certbot / your own CA), use a
server block like the one below. The streaming-specific directives
(`proxy_buffering off`, long read timeouts, `Range` pass-through) matter — see
[Streaming considerations](#streaming-considerations).

```nginx
server {
    listen 443 ssl http2;
    server_name media.example.com;

    ssl_certificate     /etc/letsencrypt/live/media.example.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/media.example.com/privkey.pem;

    # Aura caps API request bodies at 1 MiB internally and never accepts media
    # uploads (media is bind-mounted read-only), so this is just comfortable
    # headroom rather than a hard requirement.
    client_max_body_size 50m;

    location / {
        proxy_pass http://aura:8096;
        proxy_http_version 1.1;

        # Real client IP + scheme so rate limiting, audit logs and Secure
        # cookies behave correctly (pair with TRUST_PROXY=true on Aura).
        proxy_set_header Host              $host;
        proxy_set_header X-Real-IP         $remote_addr;
        proxy_set_header X-Forwarded-For   $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;

        # Aura streams over plain HTTP (HLS segments + byte-range requests) and
        # does not use WebSockets, but forwarding Upgrade headers is harmless
        # and future-proof.
        proxy_set_header Upgrade    $http_upgrade;
        proxy_set_header Connection $connection_upgrade;
    }

    # Streaming endpoints: stream bytes straight through and allow for long
    # transcodes. See the note below.
    location /api/stream/ {
        proxy_pass http://aura:8096;
        proxy_http_version 1.1;

        proxy_set_header Host              $host;
        proxy_set_header X-Real-IP         $remote_addr;
        proxy_set_header X-Forwarded-For   $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;

        # Do NOT buffer — send HLS segments / video bytes to the client as they
        # arrive instead of spooling them in nginx first.
        proxy_buffering off;
        proxy_request_buffering off;

        # A cold transcode can take a while to emit its first segment; don't
        # time the upstream out mid-transcode.
        proxy_read_timeout    3600s;
        proxy_send_timeout    3600s;

        # nginx forwards the client's Range header by default so direct-play
        # seeking (HTTP 206) works; keep proxy caching off so ranges pass through.
        proxy_cache off;
    }
}

# Plain HTTP → HTTPS redirect.
server {
    listen 80;
    server_name media.example.com;
    return 301 https://$host$request_uri;
}
```

Add this `map` at the `http {}` level (needed for the `$connection_upgrade`
variable used above):

```nginx
map $http_upgrade $connection_upgrade {
    default upgrade;
    ''      close;
}
```

---

## Streaming considerations

Playback comes in two shapes, and both flow through `/api/stream/*`:

- **Direct play** — the raw file is streamed with full HTTP **range** support
  (Aura replies `Accept-Ranges: bytes` and `206 Partial Content`). Seeking relies
  on the client's `Range` request reaching Aura, so the proxy must pass it
  through (nginx does by default; keep proxy caching off on the stream path).

- **HLS transcode** — ffmpeg transcodes on demand and Aura serves the playlist +
  segments. A **cold start can take several seconds** to produce the first
  segment, and a session can run for the length of a film.

Tune the proxy accordingly:

- **Disable response buffering** on `/api/stream/*` (`proxy_buffering off` in
  nginx; `flush_interval -1` in Caddy). Traefik does not buffer by default.
- **Generous read/idle timeouts** on the stream path (minutes, not seconds) so a
  long transcode is never cut off.
- **Pass `Range` through** untouched — don't let the proxy cache or rewrite it.

Streaming URLs are authenticated with short-lived signed **stream tokens** (not
your JWT), so a leaked segment URL expires on its own (6 hours by default,
`STREAM_TOKEN_TTL_MS`). Concurrent transcodes are capped (`HLS_MAX_SESSIONS`,
default 3) and idle sessions are reaped (`HLS_SESSION_IDLE_MS`).

---

## Environment & settings reference

Aura is configured in two places:

1. **Environment variables** (container env / compose `environment:`) — process
   and infrastructure level. Full annotated list in
   [`server/.env.example`](../server/.env.example).
2. **Server settings** (Admin → Settings, stored in the database) — runtime
   behaviour an admin changes without a restart.

### Environment variables worth setting in production

| Variable                                                            | Default                                     | Set it for production?                                                                                       |
| ------------------------------------------------------------------- | ------------------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| `TRUST_PROXY`                                                       | `false`                                     | **`true`** — but only when behind a trusted reverse proxy (correct client IPs for rate limits & audit logs). |
| `CORS_ORIGINS`                                                      | _(empty = deny all cross-origin)_           | Leave empty unless you run a separate first-party client; then list its exact origin(s), comma-separated.    |
| `NODE_ENV`                                                          | `production` _(set by the image)_           | Leave as `production` — enables `Secure` session cookies.                                                    |
| `PORT`                                                              | `8096`                                      | Leave as-is; map/route to it from the proxy.                                                                 |
| `CONFIG_DIR`                                                        | `/config` _(set by the image)_              | Leave as-is; persist the `/config` volume.                                                                   |
| `DATABASE_URL`                                                      | `file:/config/aura.db` _(set by the image)_ | Leave as-is.                                                                                                 |
| `MEDIA_ROOTS`                                                       | `/media`                                    | Leave as-is unless you mount media somewhere other than `/media`. Every library path must live under a root. |
| `RATE_LIMIT_ENABLED`                                                | `true`                                      | Leave enabled.                                                                                               |
| `RATE_LIMIT_MAX` / `RATE_LIMIT_AUTH_MAX` / `RATE_LIMIT_REFRESH_MAX` | `300` / `10` / `30` per IP per minute       | Tune only if you hit false positives (e.g. many users behind one NAT).                                       |
| `LOG_LEVEL`                                                         | `info`                                      | `info` is fine; `warn` for quieter logs. Secrets are always redacted.                                        |
| `DB_BACKUP_INTERVAL_MS` / `BACKUP_RETENTION`                        | `86400000` (24h) / `7`                      | Keep automated backups on. See [Backups](#backups--restore).                                                 |
| `STREAM_TOKEN_TTL_MS`                                               | `21600000` (6h)                             | Lower to shrink the lifetime of a leaked stream URL.                                                         |
| `HLS_MAX_SESSIONS`                                                  | `3`                                         | Raise if your CPU/GPU can serve more concurrent transcodes.                                                  |
| `HWACCEL_DEVICE`                                                    | `/dev/dri/renderD128`                       | Override only if your DRM render node differs (VAAPI/QSV).                                                   |

See [`server/.env.example`](../server/.env.example) for the rest (watcher,
scan/cleanup intervals, artwork cache budget, trickplay, log rotation).

### Server settings (Admin → Settings)

| Setting                          | Values / default                                                | Notes                                                                                |
| -------------------------------- | --------------------------------------------------------------- | ------------------------------------------------------------------------------------ |
| `serverName`                     | text, default `Aura`                                            | Display name shown on login and to clients.                                          |
| `registrationEnabled`            | boolean, default `true`                                         | Turn **off** after creating your accounts to close public signup (see checklist).    |
| `baseUrl`                        | http(s) URL, default empty                                      | External URL of this server, e.g. `https://media.example.com`.                       |
| `tmdbApiKey`                     | secret, default empty                                           | TMDB v3 API key **or** v4 read token, for metadata. **Secret** — redacted from logs. |
| `defaultQuality`                 | `1080p` \| `720p` \| `480p` \| `360p`, default `720p`           | Default transcode rung when a client doesn't request one.                            |
| `maxQuality`                     | `1080p` \| `720p` \| `480p` \| `360p`, default `1080p`          | Server-wide ceiling; per-user caps can only go lower.                                |
| `hwAccel`                        | `none` \| `auto` \| `vaapi` \| `nvenc` \| `qsv`, default `none` | Hardware transcoding mode — see below.                                               |
| `blockUnratedForRestrictedUsers` | boolean, default `false`                                        | When on, users with a content-rating cap are also denied unrated items.              |
| `transcodeDir`                   | path, default `/config/transcodes`                              | HLS scratch directory; leave on the `/config` volume.                                |

---

## Hardware acceleration

Software transcoding (libx264) is the default and works everywhere. To offload
to a GPU, set the `hwAccel` server setting **and** pass the device into the
container. The mode table, the `/dev/dri` (VAAPI/QSV) and NVIDIA Container Toolkit
(NVENC) passthrough blocks, and the automatic software fallback are documented in
the [README "Hardware acceleration" section](../README.md#hardware-acceleration)
and the commented blocks in [`docker-compose.yml`](../docker-compose.yml).

Recap: VAAPI/QSV need `devices: [/dev/dri:/dev/dri]` (override the node with
`HWACCEL_DEVICE`); NVENC needs the NVIDIA Container Toolkit plus the
`deploy.resources` GPU reservation. A wrong choice degrades to software rather
than breaking playback.

---

## Backups & restore

Aura runs a scheduled **database backup** task that writes a consistent SQLite
snapshot (via `VACUUM INTO`, safe while the server is running) to
`/config/backups/aura-<timestamp>.db`. It runs every `DB_BACKUP_INTERVAL_MS`
(default 24h) and keeps the newest `BACKUP_RETENTION` snapshots (default 7).

**Back up the whole `/config` volume** on your own schedule — it contains the
live database, the server secrets, the artwork cache and these snapshots. A copy
of `/config` is a complete backup of the server's state (your media lives on the
read-only mounts and is not part of it).

### Restore

The database is a single SQLite file at `/config/aura.db`. To restore:

```bash
# 1. Stop the container so nothing is writing the database.
docker compose down            # or: docker compose stop aura

# 2. Replace the live database with a snapshot (back up the current file first).
cd config
mv aura.db aura.db.broken
cp backups/aura-2026-01-01T03-00-00-000Z.db aura.db

# 3. Start again. Migrations re-apply automatically if the snapshot is older.
docker compose up -d
```

If you restore from a full `/config` copy instead, keep `secrets.json` alongside
the database: it holds the JWT and stream-token signing keys. Restoring a
database with a _different_ `secrets.json` invalidates every issued session and
stream URL (users simply log in again) but is otherwise safe.

---

## Security checklist

- [ ] **Serve over HTTPS.** Terminate TLS at a reverse proxy (above). In
      production the session cookie is `Secure`, so plain HTTP login does not
      work anyway. Never expose the raw `8096` port to untrusted networks.
- [ ] **Register the admin first.** The first account created becomes the admin —
      do it immediately after first start so nobody else claims it.
- [ ] **Use a strong first-admin password.** It controls users, libraries, access
      grants and settings.
- [ ] **Close public registration** once your accounts exist: set
      `registrationEnabled = false` (Admin → Settings). New users get **no library
      access** until an admin grants it regardless, but closing signup stops
      account spam.
- [ ] **Set `TRUST_PROXY=true` only behind a proxy.** With it enabled while Aura
      is directly reachable, clients can spoof `X-Forwarded-For` and bypass
      per-IP rate limits and poison audit logs. Behind a proxy, enabling it is
      what makes rate limiting and audit IPs correct.
- [ ] **Keep `/media` read-only** (`:ro` on every mount). Aura never writes to
      your media; don't give it the chance.
- [ ] **Restrict CORS.** Leave `CORS_ORIGINS` empty (the default denies all
      cross-origin requests). Only add exact origins for a separate first-party
      client you control.
- [ ] **Protect and back up the secrets.** `/config/secrets.json` (mode `0600`)
      holds the JWT and stream-token signing keys. Back it up with `/config`, but
      **never commit it** or paste it anywhere. Losing it just logs everyone out;
      leaking it lets an attacker forge tokens.
- [ ] **Leave rate limiting on** (`RATE_LIMIT_ENABLED=true`, the default). Login
      and register are limited most strictly.
- [ ] **Trust the access model, it's server-side.** Per-user library access
      grants and parental content-rating caps are enforced on every media, image
      and stream route — not just hidden in the UI. New users start with zero
      library access.
- [ ] **Use scoped, revocable API tokens.** Personal API tokens come in `read`
      (GET/HEAD only) and `full` scopes and can be revoked at any time. Issue the
      narrowest scope a script needs; revoke tokens you no longer use.
- [ ] **Keep the container updated.** Track releases and update the image (below);
      the base image and ffmpeg get security fixes too.
- [ ] **Keep `/config` off public shares.** It contains the database, secrets and
      backups.

---

## Updating

Migrations apply automatically on start, so an upgrade is a normal image pull:

```bash
# 1. Back up first (a copy of /config, or rely on the latest snapshot in
#    /config/backups).
# 2. Pull the new image and recreate the container.
docker compose pull        # if you use a published image
docker compose up -d       # rebuilds/recreates; entrypoint runs `prisma migrate deploy`
```

On start the entrypoint runs `prisma migrate deploy` and **fails fast** if a
migration cannot be applied — the server never starts against a half-migrated
database, so a bad upgrade is loud rather than silently corrupting data. Check
`docker compose logs aura` if the container does not come healthy. Because the
database only moves forward, roll back by restoring a pre-upgrade `/config`
backup and pinning the previous image tag.
