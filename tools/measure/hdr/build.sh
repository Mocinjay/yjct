#!/bin/sh
# hdr_probe carries a verbatim copy of `JVSReadVideoColor` from
# ClipStitcher.m. `sync.sh` is what keeps it verbatim; run that first if the
# shipping function has changed.
set -e
DIR=$(dirname "$0")
clang -fobjc-arc -Wno-deprecated-declarations \
  -framework Foundation -framework AVFoundation -framework CoreMedia \
  -framework CoreVideo -framework QuartzCore -framework AppKit \
  -o "$DIR/hdr_probe" "$DIR/hdr_probe.m"
echo "$DIR/hdr_probe"
