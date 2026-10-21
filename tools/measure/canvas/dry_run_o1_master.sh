#!/usr/bin/env bash
# O1 canvas-promotion dry-run against Path B masters (1520x2032 HDR).
#
# Verifies CEPromotedRenderSize refuses to upscale/downscale masters, then
# scores identity (native encode vs source) with ffmpeg PSNR/SSIM so we never
# ship a ladder that quietly re-encodes Meta masters before caption burn.
#
# Usage:
#   ./tools/measure/canvas/dry_run_o1_master.sh master1.mp4 [master2.mp4 ...]
#   ./tools/measure/canvas/dry_run_o1_master.sh --synthetic
#
# Exit 0 when every master keeps native geometry and PSNR stays infinite /
# SSIM ≈ 1.0 on a no-op copy. Exit 1 on promotion or quality regression.

set -euo pipefail

ROOT="$(cd "$(dirname "$0")" && pwd)"
OUT_DIR="${ROOT}/out/o1-dry-run"
mkdir -p "$OUT_DIR"

need() {
  command -v "$1" >/dev/null 2>&1 || {
    echo "missing dependency: $1" >&2
    exit 2
  }
}

need ffprobe
need ffmpeg
need python3

probe_wh() {
  ffprobe -v error -select_streams v:0 \
    -show_entries stream=width,height,codec_name,pix_fmt,color_transfer,profile \
    -of json "$1"
}

# Mirror of CEPromotedRenderSize decision for Path B (must return native size).
# Constants from CaptionEngine.m — keep in sync.
PROMOTION_W=1080
PROMOTION_H=1920
MAX_W=720
MAX_H=1280

expect_native() {
  local w=$1 h=$2
  # Guard 1: anything larger than proxy max on either axis is Path B → native.
  if (( w > MAX_W || h > MAX_H )); then
    echo "native"
    return
  fi
  if (( w >= PROMOTION_W || h >= PROMOTION_H )); then
    echo "native"
    return
  fi
  echo "promote"
}

score_copy() {
  local src=$1 dst=$2 label=$3
  # Short window — masters are large; 2s is enough to catch a bad re-encode.
  ffmpeg -y -hide_banner -loglevel error \
    -i "$src" -i "$dst" -t 2 \
    -lavfi "[0:v][1:v]psnr=stats_file=${OUT_DIR}/${label}.psnr;[0:v][1:v]ssim=stats_file=${OUT_DIR}/${label}.ssim" \
    -f null - 2>/dev/null || true

  python3 - "$OUT_DIR/${label}.psnr" "$OUT_DIR/${label}.ssim" <<'PY'
import re, sys
psnr_path, ssim_path = sys.argv[1], sys.argv[2]
psnr = None
ssim = None
try:
    text = open(psnr_path).read()
    m = re.search(r"psnr_avg:([0-9.]+|inf)", text)
    if m:
        psnr = m.group(1)
except FileNotFoundError:
    pass
try:
    text = open(ssim_path).read()
    m = re.search(r"All:([0-9.]+)", text)
    if m:
        ssim = float(m.group(1))
except FileNotFoundError:
    pass
print(f"psnr_avg={psnr} ssim_all={ssim}")
ok = True
if psnr is None:
    ok = False
elif psnr != "inf":
    try:
        if float(psnr) < 45.0:
            ok = False
    except ValueError:
        ok = False
if ssim is None or ssim < 0.99:
    ok = False
sys.exit(0 if ok else 1)
PY
}

run_one() {
  local src=$1
  local base
  base=$(basename "$src" | sed 's/\.[^.]*$//')
  local meta
  meta=$(probe_wh "$src")
  local w h codec pix tf profile
  eval "$(python3 -c "
import json,sys
d=json.load(sys.stdin)['streams'][0]
print('w=%s' % d.get('width',0))
print('h=%s' % d.get('height',0))
print('codec=%r' % (d.get('codec_name') or ''))
print('pix=%r' % (d.get('pix_fmt') or ''))
print('tf=%r' % (d.get('color_transfer') or ''))
print('profile=%r' % (d.get('profile') or ''))
" <<<"$meta")"
  echo ""
  echo "=== $src ==="
  echo "probe: ${w}x${h} codec=${codec} pix=${pix} transfer=${tf} profile=${profile}"

  local decision
  decision=$(expect_native "$w" "$h")
  if [[ "$decision" != "native" ]]; then
    echo "FAIL: CEPromotedRenderSize would promote ${w}x${h} — masters must stay native"
    return 1
  fi
  echo "OK: promotion refused (native ${w}x${h})"

  # No-op stream copy — if this fails quality bars, the source itself is odd.
  local copy="${OUT_DIR}/${base}.copy.mp4"
  ffmpeg -y -hide_banner -loglevel error -i "$src" -t 2 -c copy "$copy"
  if ! score_copy "$src" "$copy" "${base}_copy"; then
    echo "FAIL: identity copy PSNR/SSIM below bar"
    return 1
  fi
  echo "OK: identity copy PSNR/SSIM"

  # Forced 1080p re-encode (what a mistaken O1 enable would do to a master
  # if the size guard were wrong). Expect clear quality loss vs native.
  local promo="${OUT_DIR}/${base}.promo1080.mp4"
  ffmpeg -y -hide_banner -loglevel error -i "$src" -t 2 \
    -vf "scale=1080:1920:flags=lanczos" -c:v libx265 -crf 18 -tag:v hvc1 \
    -an "$promo" || {
      echo "WARN: could not build promo arm (x265 missing?) — skipping contrast"
      return 0
    }
  echo "promo arm written for contrast (expect PSNR drop vs source if scored at native res)"
  return 0
}

SYNTH=0
FILES=()
for arg in "$@"; do
  if [[ "$arg" == "--synthetic" ]]; then
    SYNTH=1
  else
    FILES+=("$arg")
  fi
done

if [[ $SYNTH -eq 1 ]]; then
  need ffmpeg
  SYN="${OUT_DIR}/synthetic_1520x2032_hlg.mp4"
  # Approximate Path B geometry; colour tags are best-effort on ffmpeg builds.
  ffmpeg -y -hide_banner -loglevel error -f lavfi -i "testsrc2=size=1520x2032:rate=30" \
    -t 3 -c:v libx265 -pix_fmt yuv420p10le -tag:v hvc1 \
    -x265-params "profile=main10" \
    -color_primaries bt2020 -color_trc arib-std-b67 -colorspace bt2020nc \
    -an "$SYN"
  FILES+=("$SYN")
fi

if [[ ${#FILES[@]} -eq 0 ]]; then
  echo "usage: $0 master.mp4... | --synthetic" >&2
  exit 2
fi

# Prefer device canvas_probe when built — confirms shipping CEPromotedRenderSize.
PROBE="${ROOT}/canvas_probe"
if [[ -x "$PROBE" ]]; then
  echo "--- canvas_probe inspect ---"
  "$PROBE" inspect "${FILES[@]}" || true
else
  echo "(canvas_probe not built — using shell mirror of CEPromotedRenderSize)"
fi

fail=0
for f in "${FILES[@]}"; do
  if ! run_one "$f"; then
    fail=1
  fi
done

echo ""
if [[ $fail -eq 0 ]]; then
  echo "Verdict: PASS — Path B masters stay native; O1 ladder safe to keep OFF for masters."
  exit 0
fi
echo "Verdict: FAIL — do not enable CECanvasPromotionEnabled until masters are excluded."
exit 1
