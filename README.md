# Aura

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
docker compose up --build
```

Edit `docker-compose.yml` to point the media mounts at your host folders:

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
the admin.

## Development

- `server/` — Fastify + TypeScript + Prisma (SQLite) API, ffmpeg transcoding
- `web/` — React + Vite + TypeScript web app

```bash
cd server && npm install && npm run dev
cd web && npm install && npm run dev
```

Run tests with `npm test` in each package. All changes go through PRs with CI.
