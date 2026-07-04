#!/bin/sh
# Production container entrypoint.
#
# Applies any pending database migrations before starting the server, so the
# process never runs against a database in an unknown schema state. A
# migration failure is fatal: the container exits non-zero and the server is
# never started.
set -eu

cd /app

echo "aura: applying database migrations (prisma migrate deploy)"
if ! node_modules/.bin/prisma migrate deploy --schema server/prisma/schema.prisma; then
  echo "aura: FATAL: database migration failed; refusing to start the server." >&2
  echo "aura: check DATABASE_URL (${DATABASE_URL:-unset}) and that the /config volume is writable by uid $(id -u)." >&2
  exit 1
fi

# Default command: the API server. `exec` replaces this shell so node runs as
# PID 1 and receives container stop signals directly.
[ "$#" -gt 0 ] || set -- node server/dist/index.js
exec "$@"
