# tools/measure/canvas

Answers the half of the 1080x1920 canvas-promotion question that does not need
a platform upload.

The hypothesis is two independent claims, and they fail independently:

- **Claim A** — platforms allocate more ingest bitrate to a 1080-labelled file.
  Empirical, about someone else's transcoder. `../ladder.sh` tests it.
- **Claim B** — burned captions rasterise sharper at `renderSize` 1080x1920.
  Deterministic, about our own pixels. This directory tests it.

## Build

```sh
clang -fobjc-arc -O2 -Wno-deprecated-declarations \
  -framework Foundation -framework AVFoundation -framework CoreMedia \
  -framework QuartzCore -framework AppKit -framework CoreText \
  -framework CoreGraphics -o canvas_probe canvas_probe.m
```

`canvas_probe.m` carries a verbatim copy of `CEPromotedRenderSize`, its
constants, `CEPixelSize` and `CESmallestCodedSize`, plus a line-for-line port of
`-addCaptionLayers:...`. If `CaptionEngine.m` changes, this stops describing the
shipping code — that is the maintenance cost of the tool, and it is the reason
the copies are verbatim rather than paraphrased.

## Commands

| Command | What it answers |
|---|---|
| `verify [720p.mp4 504p.mp4 rotated.mp4...]` | The promotion decision as a regression check. Asserts the whole table, prints ok/FAIL per case, exits non-zero on any failure. |
| `guard [720p.mp4 504p.mp4]` | What dimensions the four promotion guards see, per source shape — including a stitched mixed-resolution asset built the way `ClipStitcher` builds one. |
| `inspect <file.mp4>...` | The same, for real files, so the `preferredTransform` is the one the container carries rather than one this tool synthesised. |
| `render <in> <out> <0\|1> [font.ttf]` | The caption burn at the native or promoted canvas, using the shipping composition/transform math and `AVAssetExportPresetHighestQuality`. Reports wall clock, peak footprint, bytes, bitrate. |
| `still <out.png> <w> <h> <ss> <t> <dur> [font.ttf]` | The caption rasterisation at that canvas. `ss` 1 is what the burn produces; `ss` 8 is the reference an ideal rasteriser would have produced at the same geometry. |

## Checking the guard

```sh
./fixtures.sh
```

Builds the fixtures with ffmpeg and runs `verify` against them. The interesting
cases cannot be written as constants: the stsd case is a disagreement between a
track header and its sample descriptions, and the rotation cases turn on a
display matrix carrying exact fixed-point entries. Both need real files.

`ladder.sh prepare` runs `verify` (synthetic cases only, no fixtures needed)
before building its native arm.

## Scoring

Scoring lives in `caption_metrics.py` (numpy + Pillow, no scipy):

```sh
python3 caption_metrics.py out/nat720.png out/nat1080.png out/ide720.png out/ide1080.png
```

## Host limitation, and why it does not invalidate the result

`AVVideoCompositionCoreAnimationTool` composites plain `CALayer`s in this macOS
CLI, but a `CATextLayer` anywhere in the tree makes the whole overlay pass drop
out silently — captions absent, no error, byte-identical output. Ad-hoc
codesigning and pumping the main run loop do not change it. On device the same
code demonstrably works (VIDEO-QUALITY.md 4.1 measures real burned captions).

So `render` measures the **video** half of the export honestly — the upscale,
the encode, the file — and its cost numbers therefore *understate* the promoted
arm, because the Core Animation pass they omit is per-frame and would be running
over 2.25x the pixels.

Claim B itself is unaffected: it is a claim about glyph rasterisation, and
`still` exercises exactly the `CATextLayer` + Core Text path the animation tool
would, at exactly the canvas sizes in question, via `renderInContext:`.
