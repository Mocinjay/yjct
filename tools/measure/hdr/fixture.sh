#!/bin/sh
# Builds a stand-in for a Path B master: 1520x2032 10-bit HEVC, BT.2020
# primaries, HLG transfer — the shape `GlassesMediaLibrary` copies out of the
# photo library.
#
# Synthetic on purpose. The question these fixtures answer is what AVFoundation
# does to a file with these tags, and that does not depend on what is in frame.
# What it cannot answer is bit rate on real content, which is scene-dependent —
# for that, use a real glasses recording as the input to hdr_probe instead.
set -e
OUT="${1:-$(dirname "$0")/../out}"
mkdir -p "$OUT"

# videotoolbox writes the samples but drops the colour signalling, so the tags
# are stamped on afterwards with the bitstream filter. Two steps, not one.
ffmpeg -hide_banner -loglevel error -y \
  -f lavfi -i "testsrc2=size=1520x2032:rate=30:duration=3" \
  -c:v hevc_videotoolbox -tag:v hvc1 -pix_fmt p010le -profile:v main10 \
  "$OUT/hlg_untagged.mov"

ffmpeg -hide_banner -loglevel error -y -i "$OUT/hlg_untagged.mov" \
  -c:v copy -tag:v hvc1 \
  -bsf:v hevc_metadata=colour_primaries=9:transfer_characteristics=18:matrix_coefficients=9 \
  "$OUT/hlg_master.mov"

rm -f "$OUT/hlg_untagged.mov"
echo "$OUT/hlg_master.mov"
ffprobe -hide_banner -v error -select_streams v:0 \
  -show_entries stream=codec_name,width,height,pix_fmt,color_transfer,color_primaries,color_space \
  -of default=nw=1 "$OUT/hlg_master.mov"
