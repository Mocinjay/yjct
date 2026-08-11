#!/usr/bin/env bash
#
# Does handing a platform 1080p instead of 720p buy a better ingestion ladder?
#
# The claim under test is that TikTok/Instagram/YouTube allocate bitrate partly
# on the resolution they are handed, so upscaling our 720p Path A proxy to a
# 1080x1920 canvas before upload wins back bitrate on the far side. Upscaling
# adds no information — every pixel is invented by the resampler — so the only
# thing that could possibly make it worth doing is the platform's own
# behaviour. That is not something to reason about. It is something to upload.
#
# Usage:
#   ./ladder.sh prepare <source.mp4>      build the two upload arms + reference
#   ./ladder.sh probe <file>              resolution / codec / bitrate table
#   ./ladder.sh compare <arm> <file>      probe a download + SSIM/PSNR vs reference
#   ./ladder.sh report                    everything measured so far, as TSV
#
# Between `prepare` and `compare` there is a manual step that cannot be
# automated honestly: upload both arms from the same account, on the same
# network, as close together in time as you can manage, then download each one
# back at the highest quality the platform offers.

set -euo pipefail

readonly HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
readonly WORK="${LADDER_WORK:-$HERE/out}"
readonly REFERENCE="$WORK/reference.mp4"
readonly RESULTS="$WORK/results.tsv"

# 20s is long enough that the platform's encoder settles past its opening
# ramp, and short enough to upload twice without the network becoming the
# variable under test.
readonly CLIP_SECONDS="${LADDER_SECONDS:-20}"

readonly PROXY_W=720 PROXY_H=1280
readonly CANVAS_W=1080 CANVAS_H=1920

die() { printf 'ladder: %s\n' "$*" >&2; exit 1; }
note() { printf '\n\033[1m%s\033[0m\n' "$*"; }

require_tools() {
  for tool in ffmpeg ffprobe; do
    command -v "$tool" >/dev/null 2>&1 || die "$tool is not on PATH (brew install ffmpeg)"
  done
}

# ---------------------------------------------------------------------------
# Probing
# ---------------------------------------------------------------------------

# Stream-level bitrate where the container reports it, falling back to the
# format-level number. A platform's returned file often carries only one of the
# two, and silently reporting "0" for the other reads as a measurement rather
# than a gap.
probe_field() {
  local file="$1" stream_entry="$2" format_entry="$3" value
  value="$(ffprobe -v error -select_streams v:0 -show_entries "stream=$stream_entry" \
             -of default=nw=1:nk=1 "$file" 2>/dev/null | head -1)"
  if [ -z "$value" ] || [ "$value" = "N/A" ]; then
    value="$(ffprobe -v error -show_entries "format=$format_entry" \
               -of default=nw=1:nk=1 "$file" 2>/dev/null | head -1)"
  fi
  [ -n "$value" ] && [ "$value" != "N/A" ] && printf '%s' "$value" || printf 'unknown'
}

probe() {
  local file="$1"
  [ -f "$file" ] || die "no such file: $file"

  local width height codec profile level fps duration bitrate bytes
  width="$(probe_field "$file" width nothing)"
  height="$(probe_field "$file" height nothing)"
  codec="$(probe_field "$file" codec_name nothing)"
  profile="$(probe_field "$file" profile nothing)"
  level="$(probe_field "$file" level nothing)"
  fps="$(probe_field "$file" r_frame_rate nothing)"
  duration="$(probe_field "$file" duration duration)"
  bitrate="$(probe_field "$file" bit_rate bit_rate)"
  bytes="$(wc -c < "$file" | tr -d ' ')"

  # The container's declared bitrate is frequently absent on a platform
  # download. Size over duration is always available and is what the viewer's
  # connection actually carries, so it is reported alongside rather than
  # instead — they disagree when the file has a large moov or audio track.
  local effective='unknown'
  if [ "$duration" != "unknown" ]; then
    effective="$(awk -v b="$bytes" -v d="$duration" \
      'BEGIN { if (d > 0) printf "%.0f", (b * 8) / d; else print "unknown" }')"
  fi

  printf '  file          %s\n' "$(basename "$file")"
  printf '  resolution    %sx%s\n' "$width" "$height"
  printf '  codec         %s (profile %s, level %s)\n' "$codec" "$profile" "$level"
  printf '  frame rate    %s\n' "$fps"
  printf '  duration      %s s\n' "$duration"
  printf '  declared      %s bps\n' "$bitrate"
  printf '  size/duration %s bps  (%s bytes)\n' "$effective" "$bytes"

  LADDER_W="$width" LADDER_H="$height" LADDER_BR="$effective" LADDER_BYTES="$bytes"
  export LADDER_W LADDER_H LADDER_BR LADDER_BYTES
}

# ---------------------------------------------------------------------------
# prepare — build the reference and the two upload arms
# ---------------------------------------------------------------------------

prepare() {
  local source="${1:-}"
  [ -n "$source" ] || die "usage: ladder.sh prepare <source.mp4>"
  [ -f "$source" ] || die "no such file: $source"

  mkdir -p "$WORK"

  # The reference is the untouched source, trimmed only in time. Every quality
  # number in this harness is measured against it, including the 720p arm's —
  # otherwise the 720p arm is being compared against itself and will score
  # perfectly no matter what the platform does to it.
  note "Reference (control, ${CLIP_SECONDS}s of the source, no re-encode)"
  ffmpeg -y -v error -i "$source" -t "$CLIP_SECONDS" -c copy "$REFERENCE"
  probe "$REFERENCE"

  local ref_h
  ref_h="$LADDER_H"
  if [ "$ref_h" != "unknown" ] && [ "$ref_h" -gt "$PROXY_H" ] 2>/dev/null; then
    printf '\n  note: source is taller than %sp — this harness tests the Path A\n' "$PROXY_H"
    printf '        proxy hypothesis, so feed it a 720x1280 proxy clip.\n'
  fi

  # Arm 1: what we upload today. Stream-copied, so the arm is bit-for-bit the
  # reference and any difference measured after the round trip belongs
  # entirely to the platform.
  note "Arm 1 — source_720p.mp4 (passthrough, what ships today)"
  ffmpeg -y -v error -i "$REFERENCE" -c copy "$WORK/source_720p.mp4"
  probe "$WORK/source_720p.mp4"

  # Arm 2: the hypothesis. Lanczos because it is the sharpest of ffmpeg's
  # general-purpose kernels and this test should give the upscale its best
  # case; a soft upscale that loses would not tell us whether the idea or the
  # resampler was at fault.
  #
  # Encoded at a deliberately high bitrate and slow preset so that arm 2's own
  # encode is not the bottleneck. We are measuring what the platform does with
  # 1080p input, not how well x264 upscales.
  note "Arm 2 — upscaled_1080p.mp4 (lanczos to ${CANVAS_W}x${CANVAS_H})"
  ffmpeg -y -v error -i "$REFERENCE" \
    -vf "scale=${CANVAS_W}:${CANVAS_H}:flags=lanczos,format=yuv420p" \
    -c:v libx264 -preset slow -crf 16 -profile:v high -level 4.1 \
    -x264-params "keyint=60:min-keyint=60:scenecut=0" \
    -c:a copy -movflags +faststart \
    "$WORK/upscaled_1080p.mp4"
  probe "$WORK/upscaled_1080p.mp4"

  note "Next"
  cat <<EOF
  1. Upload both arms from the SAME account, same network, minutes apart:
       $WORK/source_720p.mp4
       $WORK/upscaled_1080p.mp4
  2. Download each back at the highest quality the platform offers.
  3. Measure each return:
       ./ladder.sh compare 720p    <downloaded-720p-arm.mp4>
       ./ladder.sh compare 1080p   <downloaded-1080p-arm.mp4>
  4. ./ladder.sh report

  Read the caveats in README.md before treating one run as an answer.
EOF
}

# ---------------------------------------------------------------------------
# compare — probe a platform return and score it against the reference
# ---------------------------------------------------------------------------

# SSIM needs both inputs on one geometry. The return is scaled to the
# reference rather than the reference up to the return, because the question
# is how much of the original survived the round trip — not how convincing the
# platform's own upscale looks at its own resolution. Scaling the reference up
# would flatter whichever arm was delivered at the higher resolution for
# reasons that have nothing to do with preserved detail.
#
# The whole-clip summary comes from the filter's own log line, not from
# `stats_file`. stats_file emits one row per frame, so reading its last row
# reports the final frame's score as though it were the clip's — which on a
# clip that ends on a static shot reads far better than the clip deserves.
score_against_reference() {
  local distorted="$1" metric="$2"
  local ref_w ref_h
  ref_w="$(probe_field "$REFERENCE" width nothing)"
  ref_h="$(probe_field "$REFERENCE" height nothing)"

  ffmpeg -hide_banner -v info -i "$distorted" -i "$REFERENCE" -lavfi \
    "[0:v]scale=${ref_w}:${ref_h}:flags=lanczos,format=yuv420p[d];[1:v]format=yuv420p[r];[d][r]${metric}" \
    -f null - 2>&1 | grep -F "Parsed_${metric}" | tail -1
}

compare() {
  local arm="${1:-}" file="${2:-}"
  [ -n "$arm" ] && [ -n "$file" ] || die "usage: ladder.sh compare <arm> <downloaded.mp4>"
  [ -f "$REFERENCE" ] || die "no reference — run 'ladder.sh prepare' first"
  [ -f "$file" ] || die "no such file: $file"

  note "Platform return — arm '$arm'"
  probe "$file"
  local ret_w="$LADDER_W" ret_h="$LADDER_H" ret_br="$LADDER_BR"

  note "Quality preserved vs reference (both sampled at reference geometry)"
  local ssim psnr ssim_all psnr_all
  ssim="$(score_against_reference "$file" ssim)"
  psnr="$(score_against_reference "$file" psnr)"
  ssim_all="$(printf '%s' "$ssim" | sed -n 's/.*All:\([0-9.]*\).*/\1/p')"
  psnr_all="$(printf '%s' "$psnr" | sed -n 's/.*average:\([0-9.a-z]*\).*/\1/p')"
  [ -n "$ssim_all" ] || ssim_all='unknown'
  [ -n "$psnr_all" ] || psnr_all='unknown'
  printf '  SSIM (Y+U+V)  %s\n' "$ssim_all"
  printf '  PSNR average  %s dB\n' "$psnr_all"

  mkdir -p "$WORK"
  if [ ! -f "$RESULTS" ]; then
    printf 'arm\twidth\theight\tbitrate_bps\tssim\tpsnr_db\tmeasured_at\n' > "$RESULTS"
  fi
  printf '%s\t%s\t%s\t%s\t%s\t%s\t%s\n' \
    "$arm" "$ret_w" "$ret_h" "$ret_br" "$ssim_all" "$psnr_all" \
    "$(date -u +%Y-%m-%dT%H:%M:%SZ)" >> "$RESULTS"
  printf '\n  recorded in %s\n' "$RESULTS"
}

report() {
  [ -f "$RESULTS" ] || die "nothing measured yet — run 'ladder.sh compare' first"
  note "All measurements"
  column -t -s "$(printf '\t')" < "$RESULTS"
  cat <<'EOF'

  The decision rule agreed before running this:
    Promote to a 1080 canvas only if the 1080p arm comes back with BOTH a
    materially higher bitrate AND an SSIM no worse than the 720p arm, on at
    least three runs per platform. A bitrate win with an SSIM loss means the
    platform spent the extra bits re-encoding invented pixels, which is worse
    than shipping 720p.
EOF
}

require_tools
case "${1:-}" in
  prepare) shift; prepare "$@" ;;
  probe)   shift; note "Probe"; probe "${1:-}" ;;
  compare) shift; compare "$@" ;;
  report)  report ;;
  *) sed -n '2,30p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//' ;;
esac
