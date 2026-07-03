# ---------------------------------------------------------------------------
# Stage 1: build — install all deps, generate Prisma client, compile server+web
# ---------------------------------------------------------------------------
FROM node:22-bookworm-slim AS build

WORKDIR /app

# Install dependencies first so source changes don't bust the npm cache layer.
# --ignore-scripts: the server postinstall (prisma generate) can't run before
# the schema is copied in; the client is generated explicitly below instead.
COPY package.json package-lock.json ./
COPY server/package.json server/package.json
COPY web/package.json web/package.json
RUN npm ci --ignore-scripts

COPY tsconfig.base.json ./
COPY server ./server
COPY web ./web

# Generate the Prisma client (into node_modules/.prisma) before building so
# the query engine for this platform exists, then compile server and web.
RUN npx prisma generate --schema server/prisma/schema.prisma \
  && npm run build

# ---------------------------------------------------------------------------
# Stage 2: prod-deps — clean production-only install for the server workspace
# ---------------------------------------------------------------------------
FROM node:22-bookworm-slim AS prod-deps

WORKDIR /app

COPY package.json package-lock.json ./
COPY server/package.json server/package.json
COPY web/package.json web/package.json
# --ignore-scripts: no schema in this stage for the prisma generate
# postinstall; the generated client is copied from the build stage below.
# Native deps that ship prebuilds (node-gyp-build style) still work at
# runtime without their install scripts; the CI smoke test guards this.
RUN npm ci --omit=dev --workspace server --ignore-scripts

# Bring over the generated Prisma client (query engine + typed client) so it
# survives the production reinstall. Note: the `prisma` CLI itself remains in
# this tree (optional peer dep of @prisma/client) and is kept deliberately —
# it is needed for `prisma migrate deploy` once migrations land.
COPY --from=build /app/node_modules/.prisma node_modules/.prisma

# ---------------------------------------------------------------------------
# Stage 3: runtime — ffmpeg, non-root user, built artefacts only
# ---------------------------------------------------------------------------
FROM node:22-bookworm-slim

RUN apt-get update \
  && apt-get install -y --no-install-recommends ffmpeg \
  && rm -rf /var/lib/apt/lists/* \
  # Replace the base image's `node` user (uid 1000) with `aura` (uid 1000).
  && userdel -r node \
  && groupadd --gid 1000 aura \
  && useradd --uid 1000 --gid aura --create-home --shell /usr/sbin/nologin aura \
  # Persistent state (DB, cache, transcodes) lives in /config.
  && mkdir -p /config \
  && chown aura:aura /config

WORKDIR /app

COPY --from=prod-deps --chown=aura:aura /app/node_modules ./node_modules
COPY --chown=aura:aura package.json ./
COPY --chown=aura:aura server/package.json server/package.json
COPY --chown=aura:aura server/prisma server/prisma
COPY --from=build --chown=aura:aura /app/server/dist server/dist
COPY --from=build --chown=aura:aura /app/web/dist web/dist

ENV NODE_ENV=production \
    PORT=8096 \
    CONFIG_DIR=/config \
    DATABASE_URL=file:/config/aura.db \
    WEB_DIST=/app/web/dist

EXPOSE 8096
VOLUME /config

HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD ["node", "-e", "fetch(`http://127.0.0.1:${process.env.PORT ?? 8096}/api/health`).then((r) => process.exit(r.ok ? 0 : 1), () => process.exit(1))"]

USER aura

CMD ["node", "server/dist/index.js"]
