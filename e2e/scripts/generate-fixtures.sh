#!/usr/bin/env bash
# Generates the tiny scannable video fixture the "play" e2e flow needs.
#
# Produces a couple-of-seconds H.264 + AAC MP4 (tens of KB) under a
# Plex-style "Title (Year)" folder so Aura's filename parser recognises it as a
# movie. The tree this writes IS the media root mounted into the container at
# /media (read-only) in CI, and pointed at by MEDIA_ROOTS locally.
#
# Idempotent: does nothing if the fixture already exists. Fails loudly if
# ffmpeg is missing (the CI job installs it; the server unit tests already
# depend on it too).
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
MEDIA_ROOT="${1:-$SCRIPT_DIR/../fixtures/media}"
MOVIE_DIR="$MEDIA_ROOT/e2e-movies/Test Movie (2020)"
OUT="$MOVIE_DIR/Test.Movie.2020.mp4"

if [ -f "$OUT" ]; then
  echo "fixture already present: $OUT"
  exit 0
fi

if ! command -v ffmpeg >/dev/null 2>&1; then
  echo "ERROR: ffmpeg not found; cannot generate the test media fixture." >&2
  exit 1
fi

mkdir -p "$MOVIE_DIR"

# testsrc (colour bars) + a sine tone → a real, ffprobe-valid H.264/AAC MP4.
ffmpeg -nostdin -y -loglevel error \
  -f lavfi -i "testsrc=duration=2:size=160x120:rate=15" \
  -f lavfi -i "sine=frequency=440:duration=2" \
  -c:v libx264 -preset ultrafast -pix_fmt yuv420p \
  -c:a aac -shortest \
  -movflags +faststart \
  "$OUT"

echo "generated fixture: $OUT ($(du -h "$OUT" | cut -f1))"
