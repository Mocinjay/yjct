#!/usr/bin/env bash
# Compare codec / colour / bitrate of a Path A segment (or any source MP4)
# against a stitch/extract output. They must match for passthrough to be real.
#
# Usage:
#   ./tools/measure/stitch/compare_quality.sh segment.mp4 stitched.mp4
#
# Exit 0 when codec family + colour tags agree and bitrate is within 15%.
# Exit 1 on mismatch or missing ffprobe.

set -euo pipefail

if [[ $# -ne 2 ]]; then
  echo "usage: $0 <segment-or-source.mp4> <stitched-or-cut.mp4>" >&2
  exit 2
fi

SRC=$1
OUT=$2

if ! command -v ffprobe >/dev/null 2>&1; then
  echo "ffprobe not on PATH" >&2
  exit 1
fi

probe() {
  local file=$1
  ffprobe -v error -select_streams v:0 \
    -show_entries stream=codec_name,profile,pix_fmt,width,height,bit_rate,color_primaries,color_transfer,color_space \
    -of json "$file"
}

src_json=$(probe "$SRC")
out_json=$(probe "$OUT")

echo "=== SOURCE ==="
echo "$src_json" | python3 -m json.tool
echo "=== OUTPUT ==="
echo "$out_json" | python3 -m json.tool

python3 - "$src_json" "$out_json" <<'PY'
import json, sys

def stream(blob):
    data = json.loads(blob)
    return data["streams"][0]

a, b = stream(sys.argv[1]), stream(sys.argv[2])
keys = ("codec_name", "color_primaries", "color_transfer", "color_space", "width", "height")
ok = True
for k in keys:
    av, bv = a.get(k), b.get(k)
    if av != bv:
        print(f"MISMATCH {k}: source={av!r} output={bv!r}")
        ok = False
    else:
        print(f"OK {k}={av!r}")

def bitrate(s):
    try:
        return int(s.get("bit_rate") or 0)
    except (TypeError, ValueError):
        return 0

ba, bb = bitrate(a), bitrate(b)
if ba > 0 and bb > 0:
    ratio = abs(ba - bb) / ba
    print(f"bitrate source={ba} output={bb} delta={ratio:.1%}")
    if ratio > 0.15:
        print("MISMATCH bitrate delta > 15% (suggests re-encode, not passthrough)")
        ok = False
else:
    print(f"bitrate source={ba} output={bb} (one missing — skipped ratio check)")

sys.exit(0 if ok else 1)
PY
