#!/usr/bin/env bash
#
# Builds the segments `stitch_probe verify` needs, then runs it.
#
# The mismatch has to be real. `asset.duration` is read off the container's
# track headers, so a fixture that only claims a mismatch in a sidecar proves
# nothing — the audio and video tracks have to actually end at different times
# in the file. Muxing separately-generated tracks is the way to get that.
#
#   ./fixtures.sh          build fixtures and verify
#   ./fixtures.sh build    build fixtures only

set -euo pipefail

readonly HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
readonly OUT="$HERE/out"
readonly PROBE="$HERE/stitch_probe"

die() { printf 'fixtures: %s\n' "$*" >&2; exit 1; }

command -v ffmpeg >/dev/null 2>&1 || die "ffmpeg is not on PATH (brew install ffmpeg)"
mkdir -p "$OUT"

# Video at the shape path A actually writes, 30 fps. `$1` seconds, `$2` out.
video() {
  ffmpeg -y -v error -f lavfi -i "testsrc2=size=720x1280:rate=30" -t "$1" \
    -c:v libx264 -pix_fmt yuv420p -profile:v high -g 30 "$2"
}

# PCM in a MOV, not AAC: an AAC frame is 1024 samples, so an AAC track's
# duration quantises to 21.3 ms steps at 48 kHz and cannot land on the small
# mismatch we are trying to build. The probe measures whatever it gets, but
# the fixture should still be the shape it says it is.
audio() {
  ffmpeg -y -v error -f lavfi -i "sine=frequency=440:sample_rate=48000" -t "$1" \
    -c:a pcm_s16le "$2"
}

build() {
  # A dropped frame or a late buffer leaves audio (host clock) and video (frame
  # PTS) disagreeing by tens of milliseconds. 40 ms is a bit over one frame at
  # 30 fps: small enough to be the real thing, big enough to see.
  video 2.0  "$OUT/v2000.mp4"
  video 2.04 "$OUT/v2040.mp4"
  audio 2.0  "$OUT/a2000.mov"
  audio 2.04 "$OUT/a2040.mov"

  # The case the fix is about: audio OVERHANGS video, so `asset.duration` is
  # the audio's and anchoring on it asks the video track for picture it does
  # not have. This is the only fixture whose result changes.
  ffmpeg -y -v error -i "$OUT/v2000.mp4" -i "$OUT/a2040.mov" \
    -map 0:v -map 1:a -c:v copy -c:a pcm_s16le "$OUT/audio_long.mov"

  # The mirror: audio falls SHORT. `asset.duration` is the video's, so both
  # anchors agree and the hole is in the audio either way. The fix does not
  # claim this one, and the run says so.
  ffmpeg -y -v error -i "$OUT/v2040.mp4" -i "$OUT/a2000.mov" \
    -map 0:v -map 1:a -c:v copy -c:a pcm_s16le "$OUT/audio_short.mov"

  # Control. No mismatch, so no holes under either anchor.
  ffmpeg -y -v error -i "$OUT/v2000.mp4" -i "$OUT/a2000.mov" \
    -map 0:v -map 1:a -c:v copy -c:a pcm_s16le "$OUT/matched.mov"

  # Video-only, the normal glasses case: the toolkit exposes no microphone.
  cp "$OUT/v2000.mp4" "$OUT/video_only.mp4"

  printf 'fixtures in %s\n' "$OUT"
}

case "${1:-all}" in
  build) build ;;
  all)
    build
    [ -x "$PROBE" ] || die "$PROBE is not built - see README.md"
    printf '\n'
    exec "$PROBE" verify \
      "$OUT/matched.mov" "$OUT/audio_long.mov" "$OUT/audio_short.mov" \
      "$OUT/video_only.mp4"
    ;;
  *) die "usage: fixtures.sh [build|all]" ;;
esac
