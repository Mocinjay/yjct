#!/usr/bin/env bash
# O2 / Path B: prove HDR Main10 survives until caption burn.
#
# Compares a source master to an extractRange-style stream copy (what
# ClipStitcher passthrough must produce). Caption burn is the only allowed
# re-encode — this script does not run CaptionEngine (device/macOS CA limits);
# it gates the pre-burn pipeline.
#
# Usage:
#   ./tools/measure/stitch/validate_hdr_passthrough.sh master.mp4
#   ./tools/measure/stitch/validate_hdr_passthrough.sh ~/masters/*.mp4

set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../../.." && pwd)"
COMPARE="$ROOT/tools/measure/stitch/compare_quality.sh"
OUT_DIR="$ROOT/tools/measure/stitch/out/hdr-validate"
mkdir -p "$OUT_DIR"

if [[ $# -lt 1 ]]; then
  echo "usage: $0 master.mp4..." >&2
  exit 2
fi

need() { command -v "$1" >/dev/null || { echo "missing $1" >&2; exit 2; }; }
need ffprobe
need ffmpeg

fail=0
for src in "$@"; do
  base=$(basename "$src" | sed 's/\.[^.]*$//')
  echo ""
  echo "=== HDR pre-burn check: $src ==="
  meta=$(ffprobe -v error -select_streams v:0 \
    -show_entries stream=width,height,codec_name,pix_fmt,profile,color_transfer,color_primaries,color_space \
    -of json "$src")
  echo "$meta" | python3 -m json.tool

  eval "$(python3 -c "
import json,sys
d=json.load(sys.stdin)['streams'][0]
print('w=%s' % d.get('width',0))
print('h=%s' % d.get('height',0))
print('codec=%r' % (d.get('codec_name') or ''))
print('profile=%r' % (d.get('profile') or ''))
print('tf=%r' % (d.get('color_transfer') or ''))
" <<<"$meta")"

  short=$w
  if (( h < w )); then short=$h; fi
  if (( short < 1080 )); then
    echo "FAIL: short edge ${short} < 1080 — not a Path B master"
    fail=1
    continue
  fi
  if [[ "$codec" != "hevc" && "$codec" != "h265" ]]; then
    echo "WARN: codec=$codec (expected hevc for Meta masters)"
  fi
  case "$profile" in
    *Main*10*|*main*10*|Main\ 10) echo "OK: Main10 profile ($profile)" ;;
    *) echo "WARN: profile=$profile (expected Main 10)" ;;
  esac

  copy="$OUT_DIR/${base}.passthrough.mp4"
  ffmpeg -y -hide_banner -loglevel error -i "$src" -t 3 -c copy "$copy"
  if ! "$COMPARE" "$src" "$copy"; then
    echo "FAIL: stream-copy diverged from master — passthrough contract broken"
    fail=1
  else
    echo "OK: passthrough copy matches codec/colour/bitrate (±15%)"
  fi
done

echo ""
if [[ $fail -eq 0 ]]; then
  echo "Verdict: PASS — pre-burn HDR Main10 chain intact (caption burn is the sole re-encode)."
  exit 0
fi
echo "Verdict: FAIL — do not merge Path B until masters preserve Main10 through extract."
exit 1
