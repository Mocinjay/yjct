#!/usr/bin/env bash
#
# Builds the fixtures `canvas_probe verify` needs, then runs it.
#
# The interesting cases cannot be written as constants: the stsd case is a
# disagreement between a track header and its sample descriptions, and the
# rotation cases turn on a display matrix carrying exact fixed-point entries.
# Both need real files.
#
#   ./fixtures.sh          build fixtures and verify
#   ./fixtures.sh build    build fixtures only

set -euo pipefail

readonly HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
readonly OUT="$HERE/out"
readonly PROBE="$HERE/canvas_probe"

die() { printf 'fixtures: %s\n' "$*" >&2; exit 1; }

command -v ffmpeg >/dev/null 2>&1 || die "ffmpeg is not on PATH (brew install ffmpeg)"
mkdir -p "$OUT"

build() {
  # The two rungs the SDK's ladder actually delivers.
  ffmpeg -y -v error -f lavfi -i "testsrc2=size=720x1280:rate=30:duration=2" \
    -c:v libx264 -pix_fmt yuv420p -profile:v high "$OUT/seg720.mp4"
  ffmpeg -y -v error -f lavfi -i "testsrc2=size=504x896:rate=30:duration=2" \
    -c:v libx264 -pix_fmt yuv420p -profile:v high "$OUT/seg504.mp4"

  # A landscape-coded portrait clip, in both rotation directions. `-c copy`
  # keeps the samples and writes only the display matrix, which is the point:
  # the guard has to read the transform, not the coded size.
  ffmpeg -y -v error -f lavfi -i "testsrc2=size=1280x720:rate=30:duration=2" \
    -c:v libx264 -pix_fmt yuv420p -profile:v high "$OUT/landscape.mp4"
  ffmpeg -y -v error -display_rotation 90 -i "$OUT/landscape.mp4" -c copy "$OUT/rotA.mp4"
  ffmpeg -y -v error -display_rotation -90 -i "$OUT/landscape.mp4" -c copy "$OUT/rotB.mp4"

  # A soft 720 source shaped like the real feed: detail generated at 720,
  # resampled through the 504 rung and back, per VIDEO-QUALITY.md 4.3. This is
  # what the claim B arms and ladder.sh's native arm are built from.
  ffmpeg -y -v error -f lavfi -i "mandelbrot=size=720x1280:rate=30:maxiter=400" -t 20 \
    -vf "scale=504:896:flags=bicubic,scale=720:1280:flags=bilinear,noise=alls=6:allf=t+u,format=yuv420p" \
    -c:v libx264 -preset medium -profile:v high -b:v 8294400 -maxrate 8294400 \
    -bufsize 16588800 -g 30 "$OUT/soft720.mp4"

  printf 'fixtures in %s\n' "$OUT"
}

case "${1:-all}" in
  build) build ;;
  all)
    build
    [ -x "$PROBE" ] || die "$PROBE is not built — see README.md"
    printf '\n'
    exec "$PROBE" verify "$OUT/seg720.mp4" "$OUT/seg504.mp4" "$OUT/rotA.mp4" "$OUT/rotB.mp4"
    ;;
  *) die "usage: fixtures.sh [build|all]" ;;
esac
