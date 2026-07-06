# Aura

[![CI](https://github.com/Alli1223/Aura/actions/workflows/ci.yml/badge.svg)](https://github.com/Alli1223/Aura/actions/workflows/ci.yml)

A self-hosted media server — organise your Movies, TV Shows, Anime, Personal
Recordings and other media into libraries, and stream them anywhere through a
web app with on-demand transcoding.

## Features (in progress — see [TODO.md](TODO.md))

- 📁 **Libraries** — point Aura at folders on your host; it scans, matches
  metadata and artwork, and keeps everything organised.
- 👥 **Users & access control** — anyone can register; admins grant each user
  access to specific libraries. No grant, no access — enforced server-side.
- ▶️ **Web player** — direct play when the browser supports the file,
  on-demand ffmpeg HLS transcoding when it doesn't. Subtitles, audio track
  selection, resume, quality selection.
- 🐳 **Docker-first** — one container, `/config` volume for state, read-only
  bind mounts for media.

## Quick start

```bash
# Create the state directory first so it's owned by your user —
# the container runs as a non-root user (uid 1000).
mkdir -p config
docker compose up --build
```

Edit `docker-compose.yml` to point the media mounts at your host folders
(they default to `./media/*` next to the compose file):

```yaml
volumes:
  - ./config:/config
  - /path/to/movies:/media/movies:ro
  - /path/to/tv:/media/tv:ro
  - /path/to/anime:/media/anime:ro
  - /path/to/recordings:/media/recordings:ro
  - /path/to/other:/media/other:ro
```

Then open `http://localhost:8096` — the first account you register becomes
the admin. `/config` holds all server state (database, cache, transcodes);
media mounts are read-only, and the container reports its own health via
`/api/health`. Database migrations run automatically on container start
(`prisma migrate deploy`), so upgrades need no manual migration step.

## Hardware acceleration

By default Aura transcodes in **software** (libx264) — it works everywhere and
needs no special host setup. That is the safe default and is all most setups
need.

If your host has a supported GPU you can offload transcoding to it. Set the
**Hardware acceleration** mode in Admin → Settings (`hwAccel`), which accepts:

| Mode    | Encoder       | Host GPU                     |
| ------- | ------------- | ---------------------------- |
| `none`  | libx264 (CPU) | — (default, always works)    |
| `vaapi` | `h264_vaapi`  | Intel / AMD (VA-API)         |
| `nvenc` | `h264_nvenc`  | NVIDIA (NVENC / CUDA)        |
| `qsv`   | `h264_qsv`    | Intel Quick Sync             |
| `auto`  | VAAPI-first   | prefers VAAPI, else software |

Enabling a hardware mode only takes effect once the GPU is **passed into the
container**. The relevant blocks are commented out in `docker-compose.yml`:

- **Intel/AMD (VAAPI) or Intel (QSV)** — pass the DRM render node:

  ```yaml
  devices:
    - /dev/dri:/dev/dri
  ```

  The default device is `/dev/dri/renderD128`; override it with the
  `HWACCEL_DEVICE` environment variable if your render node differs. (NVENC
  ignores this — CUDA selects the GPU by index.)

- **NVIDIA (NVENC)** — install the [NVIDIA Container
  Toolkit](https://docs.nvidia.com/datacenter/cloud-native/container-toolkit/latest/install-guide.html)
  on the host, then request the GPU via the `deploy.resources` block shown in
  `docker-compose.yml` (no `/dev/dri` mount is needed).

**Safety net:** hardware transcoding **automatically falls back to software**
whenever the selected device is missing or the driver rejects the pipeline, so a
wrong setting degrades gracefully instead of breaking playback. Burned-in
image subtitles (PGS/VOBSUB/DVB) always transcode in software regardless of the
mode. Because CI has no GPU, the hardware encoder arguments are verified at the
argument level and the fallback is unit-tested — the encode itself is not run in
CI.

## Development

- `server/` — Fastify + TypeScript + Prisma (SQLite) API, ffmpeg transcoding
- `web/` — React + Vite + TypeScript web app

```bash
cd server && npm install && npm run dev
cd web && npm install && npm run dev
```

Run tests with `npm test` in each package. All changes go through PRs with CI.
