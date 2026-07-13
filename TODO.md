# Aura Roadmap — Plex Feature Parity

Work protocol: each unchecked item becomes its own `feature/<slug>` branch with
tests, goes through a PR, and is merged when CI passes. Phases are ordered;
items within a phase can be parallelised unless they list a dependency.

Legend: `[ ]` todo · `[x]` merged to main

---

## Phase 0 — Foundation

- [x] Repo bootstrap: README, .gitignore, roadmap
- [x] **scaffolding** — Monorepo skeleton: `server/` (Fastify + TS + Prisma/SQLite + Vitest + ESLint), `web/` (React + Vite + TS + Vitest + ESLint), shared tsconfig/prettier, root scripts
- [x] **ci-pipeline** — GitHub Actions: lint, typecheck, unit tests, build for server & web on every PR; branch protection-friendly status checks
- [x] **docker** — Multi-stage Dockerfile (non-root user, ffmpeg included), docker-compose.yml with `/config` volume + read-only `/media/{movies,tv,anime,recordings,other}` mounts, healthcheck, .dockerignore

## Phase 1 — Core Server & Auth

- [x] **db-schema** — Prisma schema + migrations: users, refresh sessions, libraries, library access grants, media items (movie/show/season/episode), media files/streams, watch state, settings, audit log
- [x] **auth-registration** — Open user registration (username/email/password, argon2id), first registered user becomes admin (first-run setup), login/logout, JWT access + rotating refresh tokens (httpOnly cookies)
- [x] **rbac-middleware** — Role/permission middleware: `admin` vs `user`, route guards, per-user library access enforcement helpers used by all media routes
- [x] **user-management** — Admin API + audit: list/disable/enable/delete users, force password reset, change roles; users can change own password/profile
- [x] **security-hardening** — Rate limiting (strict on auth), secure headers, CORS config, request validation (zod) on every route, structured logging with secret redaction, audit log for auth/admin events
- [x] **server-settings** — Persistent server settings store in `/config` (server name, transcode dir, registration open/closed toggle, base URL)

## Phase 2 — Libraries, Scanning & Metadata

- [x] **library-crud** — Admin CRUD for libraries with types (movies, tv, anime, recordings, other), each mapping to one or more folder paths; validation that paths exist inside `/media`; seed default five libraries
- [x] **library-access-grants** — Admin assigns users to libraries (grant/revoke, list per user & per library); server-side enforcement on browse/detail/image/stream routes; new users have zero access by default
- [x] **fs-scanner** — Recursive scanner over library roots: discover video files (extension + ffprobe validation), store files with size/mtime, detect added/removed/changed files, manual scan trigger endpoint, scan status reporting
- [x] **filename-parser** — Parse movie `Title (Year)` patterns, TV `SxxEyy`/`1x02` patterns, anime absolute-episode numbering & release-group tags, cleanup of scene naming noise; unit-test heavy
- [x] **ffprobe-analysis** — Extract container/codec/resolution/duration/bitrate/audio & subtitle streams per file; persist stream info for transcode decisions
- [x] **migrate-on-boot** — Container entrypoint runs `prisma migrate deploy` before starting the server (fail fast on migration errors); remove the fail-safe swallow in library seeding once boot order is guaranteed
- [x] **metadata-tmdb** — TMDB agent for movies & TV (title match + year, cast, synopsis, ratings, genres, posters/backdrops); API key via settings; graceful offline fallback to filename metadata
- [x] **metadata-anime** — AniList agent for anime libraries (absolute episode mapping, romaji/english titles); fallback chain anime→TMDB→filename
- [x] **local-metadata** — Local NFO file + local artwork (`poster.jpg`, `folder.jpg`) support; takes priority over online agents when present
- [x] **artwork-cache** — Download & cache posters/backdrops in `/config/cache`, image resize endpoint (thumbnail sizes), cache eviction
- [x] **artwork-cache-anilist** — Extend artwork-cache to resolve `anilist:<url>` URIs (written by the anime agent) by allowlisting the AniList CDN host `s4.anilist.co`; today it only fetches `image.tmdb.org`, so AniList posters/backdrops will not render until this lands
- [x] **library-watcher** — Filesystem watching (chokidar) for near-realtime library updates + scheduled periodic rescans
- [x] **watcher-crud-wiring** — Call `refreshLibraryWatcher()` from library create/update/delete routes so watchers track new/removed libraries immediately (today only the periodic scheduler picks them up)
- [x] **media-browse-api** — Read API the web app browses: `GET /api/libraries/:id/items` (paginated/sorted/filtered list with poster + watch-state overlays), `GET /api/items/:id` (movie detail, or show→seasons→episodes with files/streams/genres), recently-added & continue-watching feeds; all access-checked with the 404 cloak. Prerequisite for library-browse, media-detail, home-screen, search

## Phase 3 — Playback & Transcoding

- [x] **stream-tokens** — Short-lived signed streaming tokens so `<video>`/HLS requests are authenticated without exposing JWTs in URLs; per-user, per-media scope checks
- [x] **direct-play** — Range-request file streaming endpoint with library-access + path-safety enforcement; content-type mapping
- [x] **playback-decision** — Decision engine: client reports capabilities, server picks direct play vs transcode (container remux vs full transcode) per video/audio stream
- [x] **hls-transcoder** — ffmpeg HLS session manager: spawn with arg-array only, segment output to per-session scratch dir, playlist generation, session keepalive/timeout, cleanup on stop/disconnect, concurrent session limits
- [x] **transcode-seek** — Seeking within transcoded content (segment-window restarts at requested timestamp)
- [x] **quality-ladder** — User-selectable quality levels (e.g. original/1080p/720p/480p + bitrates); admin-configurable defaults & per-user max quality
- [x] **subtitles** — Extract embedded subtitle tracks, discover external .srt/.ass, convert to WebVTT for web playback, burn-in path for image-based subs (PGS/VOBSUB)
- [x] **subtitle-burn-in** — Burn image-based subtitle tracks (PGS/HDMV, VOBSUB/DVD, DVB) into the video via the HLS transcoder when a client selects one — these cannot be converted to WebVTT, so the subtitles module surfaces them with `kind: 'image'` and the player must request a burn-in transcode. Depends on `subtitles` + `hls-transcoder`
- [x] **audio-tracks** — Audio track listing & selection (transcode remaps chosen track), channel downmix for stereo clients
- [x] **hw-accel** — Optional hardware acceleration (VAAPI/NVENC/QSV) via settings + compose device passthrough docs; automatic software fallback
- [x] **watch-progress** — Playback progress reporting endpoint, resume positions, watched/unwatched state, per-user (writes gated by library access)

## Phase 4 — Web App

- [x] **web-shell** — App shell: routing, auth pages (login/register/first-run), session refresh handling, dark theme, responsive layout, sidebar with only-permitted libraries
- [x] **library-browse** — Poster-grid browse per library with sort (title/year/added/rating) and filter (genre/year/watched) + pagination/virtualised grid
- [x] **image-auth** — Make the `GET /api/items/:id/artwork/:kind` route authenticatable by a plain `<img src>` (which can't send a Bearer header): accept the httpOnly session cookie (verify the JWT from the cookie) and/or a short-lived signed image token, still access-checked with the 404 cloak. Without this, posters 401 in the browser and fall back to title tiles
- [x] **media-detail** — Movie detail page & show → seasons → episodes pages: artwork, synopsis, cast, stream/file info, play/resume buttons, mark (un)watched
- [x] **video-player** — hls.js player with custom controls: play/pause/seek/volume, quality selector, subtitle & audio track menus, fullscreen, keyboard shortcuts, auto-resume prompt, next-episode autoplay, progress reporting
- [x] **home-screen** — Home: Continue Watching, Recently Added per permitted library, On Deck (next unwatched episode)
- [x] **search** — Server search endpoint + UI (title/people/genre) scoped to permitted libraries; instant results dropdown + full results page
- [x] **admin-dashboard** — Admin area: user management UI, library management UI, **library access grant matrix (user × library)**, server settings, scan triggers & status
- [x] **activity-dashboard** — Admin view of active playback/transcode sessions (who/what/bandwidth/transcode reason) with kill-session action
- [x] **user-settings** — Profile page: change password, playback preferences (default quality, subtitle language, autoplay)

## Phase 5 — Plex-Parity Extras

- [x] **collections** — Manual collections (group movies), auto-collections from TMDB collection data
- [ ] **playlists** — Per-user playlists of arbitrary videos, ordering, continuous playback
- [x] **chapters-trickplay** — Chapter markers from ffprobe + scrub-preview thumbnails (BIF-style sprite generation during scan)
- [x] **web-trickplay-scrubber** — Player-side scrub-preview UI: consume the trickplay manifest + sprite endpoints (`/api/stream/trickplay/:mediaFileId/manifest` + `/:sprite`) to show a thumbnail preview on seek-bar hover, and render chapter markers (from the file serialization's `chapters`) on the timeline. Split out of chapters-trickplay (that item covers the server side only)
- [ ] **skip-markers** — Intro/credits skip buttons (chapter-based + configurable per-show offsets)
- [ ] **multi-version** — Multiple files per movie (1080p/4K/Director's Cut): grouping, version picker in player
- [x] **parental-controls** — Content-rating restrictions per user (e.g. max PG-13), enforced server-side alongside library grants
- [x] **watch-history** — Full per-user watch history page + admin server-wide stats (most watched, storage per library)
- [x] **scheduled-tasks** — Task scheduler: periodic scans, cache/transcode cleanup, DB backup to `/config/backups`; admin task status UI
- [x] **notifications-webhooks** — Outbound webhooks on events (media added, playback started) + admin API to manage them: webhook store, HMAC-signed fire-and-forget dispatcher, event emission from the scanner & playback-decision, admin CRUD + test endpoint
- [ ] **web-new-media-indicator** — In-app "new media" indicator in the web app (badge/toast for recently-added items). Split out of notifications-webhooks (that item covers the server-side webhooks only); consumes the recently-added feed
- [x] **api-tokens** — Personal API tokens for third-party clients/scripts, scoped read-only vs full, revocable; OpenAPI spec published at `/api/docs`
- [x] **logs-viewer** — Admin log viewer with level filtering + download
- [ ] **e2e-tests** — Playwright end-to-end suite: register→grant→browse→play happy path, access-control denial paths, admin flows; runs in CI against docker compose
- [ ] **remote-access-docs** — Production deployment docs: reverse proxy (Caddy/Traefik) TLS examples, security checklist

## Phase 6 — Beyond (optional, after parity)

- [ ] **music-library** — Music library type: tagging (ID3), album/artist browse, audio player
- [ ] **photos-library** — Photo library type: EXIF, timeline view
- [ ] **live-transcode-tuning** — Adaptive bitrate (multi-variant HLS) switching
- [ ] **mobile-pwa** — PWA manifest, offline shell, installable mobile experience
