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
#   ./ladder.sh prepare <source.mp4>      build the upload arms + reference
#   ./ladder.sh probe <file>              resolution / codec / bitrate table
#   ./ladder.sh compare <arm> <file>      probe a download + SSIM/PSNR vs reference
#   ./ladder.sh report                    everything measured so far, plus a verdict
#
# The measurement that decides claim A is the RETURNED resolution, not the
# bitrate: if the platform hands the 1080 arm back at 720 it never placed the
# clip on a higher rung, and a bitrate difference is then about the platform's
# own re-encode of an upscale, not about the ladder. `compare` records what was
# sent alongside what came back so `report` can say so.
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
# What `prepare` built, so `compare` can score a return against what was
# actually sent instead of against the arm's name.
readonly MANIFEST="$WORK/arms.tsv"
readonly RESULTS_HEADER=$'arm\tsent_w\tsent_h\tret_w\tret_h\treturned_as\tbitrate_bps\tssim\tpsnr_db\tmeasured_at'

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

# Remembers what an arm was when it left, so a return can be scored against
# what was actually uploaded. Without this the arm is only a label, and a 1080
# arm that comes back at 720 is indistinguishable in the results from a 1080
# arm that came back at 1080.
record_arm() {
  local arm="$1" file="$2"
  local w h
  w="$(probe_field "$file" width nothing)"
  h="$(probe_field "$file" height nothing)"
  printf '%s\t%s\t%s\t%s\n' "$arm" "$file" "$w" "$h" >> "$MANIFEST"
}

# The dimensions `prepare` recorded for an arm, or "unknown unknown".
sent_dimensions() {
  local arm="$1"
  if [ -f "$MANIFEST" ]; then
    awk -F'\t' -v a="$arm" '$1 == a { print $3, $4; found = 1; exit }
                            END { if (!found) print "unknown", "unknown" }' "$MANIFEST"
  else
    printf 'unknown unknown\n'
  fi
}

# ---------------------------------------------------------------------------
# prepare — build the reference and the upload arms
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
  : > "$MANIFEST"

  note "Arm 1 — source_720p.mp4 (passthrough, what ships today)"
  ffmpeg -y -v error -i "$REFERENCE" -c copy "$WORK/source_720p.mp4"
  probe "$WORK/source_720p.mp4"
  record_arm 720p "$WORK/source_720p.mp4"

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
  record_arm 1080p-ffmpeg "$WORK/upscaled_1080p.mp4"

  # Arm 3: the same canvas built the way CaptionEngine would build it.
  #
  # Arm 2 is a best-case upscale and a deliberately generous encode; it is the
  # right arm for asking whether the platform rewards 1080 *at all*. It is the
  # wrong arm for deciding whether to flip CECanvasPromotionEnabled, because
  # the shipping path resamples with AVFoundation's composition scaler off a
  # CGAffineTransform, encodes with AVAssetExportPresetHighestQuality, and
  # burns the captions at the promoted size. A result measured on arm 2 does
  # not transfer to code that does none of those things the same way.
  local probe_bin="$HERE/canvas/canvas_probe"
  if [ -x "$probe_bin" ]; then
    # The arm is only worth uploading if the guard that would build it in the
    # app still behaves. This is the same check as `canvas/fixtures.sh`, minus
    # the fixtures, and it is cheap.
    note "Arm 3 — checking the promotion guard first"
    "$probe_bin" verify | sed 's/^/  /' || \
      die "the promotion guard failed its own checks — fix that before measuring anything"

    note "Arm 3 — promoted_1080p.mp4 (CaptionEngine's own promotion path)"
    "$probe_bin" render "$WORK/source_720p.mp4" "$WORK/promoted_1080p.mp4" 1 \
      "$HERE/../../app/ios/Clypso/Montserrat-ExtraBold.ttf" || \
      die "canvas_probe render failed"
    probe "$WORK/promoted_1080p.mp4"
    record_arm 1080p-native "$WORK/promoted_1080p.mp4"
  else
    printf '\n  note: %s is not built, so the shipping-path arm is missing.\n' "$probe_bin"
    printf '        Build it (see canvas/README) before treating an arm-2 result\n'
    printf '        as a decision about CECanvasPromotionEnabled.\n'
  fi

  note "Next"
  cat <<EOF
  1. Upload every arm from the SAME account, same network, minutes apart:
$(sed 's/^/       /' "$MANIFEST" | cut -f1,2 | tr '\t' ' ')
  2. Download each back at the highest quality the platform offers.
  3. Measure each return, naming the arm exactly as listed above:
       ./ladder.sh compare 720p         <downloaded-720p-arm.mp4>
       ./ladder.sh compare 1080p-native <downloaded-1080p-arm.mp4>
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

  # The decisive measurement. A platform that re-encodes the 1080 arm back down
  # to 720 never put it on a higher rung, so whatever the bitrate did, claim A
  # did not happen — and the sharper caption rasterisation the 1080 canvas buys
  # has been resampled away on the way back.
  local sent_w sent_h returned_as
  read -r sent_w sent_h <<EOF
$(sent_dimensions "$arm")
EOF
  returned_as='unknown'
  if [ "$sent_w" != "unknown" ] && [ "$ret_w" != "unknown" ]; then
    if [ "$ret_w" -eq "$sent_w" ] && [ "$ret_h" -eq "$sent_h" ]; then
      returned_as='same'
    elif [ "$ret_w" -lt "$sent_w" ] || [ "$ret_h" -lt "$sent_h" ]; then
      returned_as='DOWNSCALED'
    else
      returned_as='upscaled'
    fi
  fi
  printf '  sent as       %sx%s\n' "$sent_w" "$sent_h"
  printf '  came back     %sx%s  [%s]\n' "$ret_w" "$ret_h" "$returned_as"
  if [ "$returned_as" = 'DOWNSCALED' ]; then
    printf '  ^ the platform did not keep this arm at the resolution it was sent.\n'
    printf '    For a 1080 arm that is claim A failing outright, whatever the\n'
    printf '    bitrate column says.\n'
  fi
  if [ "$sent_w" = 'unknown' ]; then
    printf '  ^ no manifest entry for arm "%s" — run prepare first, and name the\n' "$arm"
    printf '    arm exactly as prepare listed it, or the verdict cannot be formed.\n'
  fi

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
  # Results written under the old 7-column schema have no sent_* columns and
  # cannot be given one after the fact, so they are set aside rather than
  # appended to under a header that would misdescribe them.
  if [ -f "$RESULTS" ] && [ "$(head -1 "$RESULTS")" != "$RESULTS_HEADER" ]; then
    mv "$RESULTS" "$RESULTS.pre-resolution-columns"
    printf '\n  note: previous results used the old schema and were moved to\n'
    printf '        %s\n' "$RESULTS.pre-resolution-columns"
  fi
  if [ ! -f "$RESULTS" ]; then
    printf '%s\n' "$RESULTS_HEADER" > "$RESULTS"
  fi
  printf '%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\n' \
    "$arm" "$sent_w" "$sent_h" "$ret_w" "$ret_h" "$returned_as" "$ret_br" \
    "$ssim_all" "$psnr_all" "$(date -u +%Y-%m-%dT%H:%M:%SZ)" >> "$RESULTS"
  printf '\n  recorded in %s\n' "$RESULTS"
}

report() {
  [ -f "$RESULTS" ] || die "nothing measured yet — run 'ladder.sh compare' first"
  note "All measurements"
  column -t -s "$(printf '\t')" < "$RESULTS"

  note "Verdict"
  # Applied here rather than left to the reader. The rule was agreed before any
  # upload happened, and a rule that is only restated as prose next to the
  # numbers is a rule that gets re-litigated once the numbers are in.
  awk -F'\t' '
    NR == 1 { next }
    {
      arm = $1; sent_w = $2; ret_w = $4; ret_h = $5; how = $6;
      br = $7; ssim = $8;
      runs[arm]++;
      if (how == "DOWNSCALED") downscaled[arm]++;
      if (how == "unknown") unverified[arm]++;
      if (br + 0 > 0) { brsum[arm] += br; brn[arm]++ }
      if (ssim + 0 > 0) { ssum[arm] += ssim; sn[arm]++ }
      last[arm] = ret_w "x" ret_h;
      sentw[arm] = sent_w;
    }
    END {
      base = "720p";
      if (!(base in runs)) {
        print "  no 720p baseline measured — every comparison here is against nothing.";
        exit;
      }
      basebr = brn[base] ? brsum[base] / brn[base] : 0;
      basess = sn[base] ? ssum[base] / sn[base] : 0;
      printf "  baseline  %-16s %d run(s)  mean %.0f bps  mean SSIM %.5f  last return %s\n",
             base, runs[base], basebr, basess, last[base];
      for (arm in runs) {
        if (arm == base) continue;
        br = brn[arm] ? brsum[arm] / brn[arm] : 0;
        ss = sn[arm] ? ssum[arm] / sn[arm] : 0;
        printf "\n  arm       %-16s %d run(s)  mean %.0f bps  mean SSIM %.5f  last return %s\n",
               arm, runs[arm], br, ss, last[arm];
        fail = 0;
        if (downscaled[arm] > 0) {
          printf "    FAIL  returned DOWNSCALED on %d of %d run(s) — the platform did not\n",
                 downscaled[arm], runs[arm];
          printf "          keep the rung it was sent. Claim A is not happening.\n";
          fail = 1;
        }
        if (basebr > 0 && br <= basebr * 1.10) {
          printf "    FAIL  mean bitrate %.0f is not materially above the 720p arm %.0f\n",
                 br, basebr;
          fail = 1;
        }
        if (basess > 0 && ss < basess - 0.002) {
          printf "    FAIL  mean SSIM %.5f is below the 720p arm %.5f — the extra bits\n",
                 ss, basess;
          printf "          went into re-encoding invented pixels.\n";
          fail = 1;
        }
        if (unverified[arm] > 0) {
          printf "    FAIL  %d of %d run(s) have no sent-resolution on record, so it is\n",
                 unverified[arm], runs[arm];
          printf "          not established that the return kept the rung. Re-run those\n";
          printf "          arms after a prepare, naming the arm as prepare listed it.\n";
          fail = 1;
        }
        if (runs[arm] < 3) {
          printf "    HOLD  %d run(s); the rule asks for at least 3 per platform.\n", runs[arm];
          fail = 1;
        }
        if (!fail) printf "    PASS  on this platform, by the rule below.\n";
      }
    }
  ' "$RESULTS"

  cat <<'EOF'

  The decision rule agreed before running this:
    Promote to a 1080 canvas only if the 1080p arm comes back AT 1080, with
    BOTH a materially higher bitrate AND an SSIM no worse than the 720p arm, on
    at least three runs per platform. A return at 720 means the platform never
    used the rung, so there is nothing to buy. A bitrate win with an SSIM loss
    means the platform spent the extra bits re-encoding invented pixels, which
    is worse than shipping 720p.

    Judge the flag on the `1080p-native` arm, not `1080p-ffmpeg`: only the
    former is built by the code that would actually ship.
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
