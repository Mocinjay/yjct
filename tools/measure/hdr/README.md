# tools/measure/hdr — does a master survive the caption burn?

Answers the API half of `docs/OPEN-WORK.md` O2 without hardware: given a file
tagged the way the glasses tag theirs, what does `CaptionEngine`'s composition
and export actually produce?

```sh
./sync.sh      # lift JVSReadVideoColor out of ClipStitcher.m, verbatim
./build.sh     # compile the probe
./fixture.sh   # synthesise a 1520x2032 10-bit HEVC / BT.2020 / HLG master
./hdr_probe ../out/hlg_master.mov
```

Point `hdr_probe` at a real glasses recording instead of the fixture when one is
available — the fixture settles what AVFoundation does with the tags, but bit
rate depends on what is in frame, and only real footage answers that.

## What it measured, 2026-09-09

Source: the synthetic fixture, 1520x2032 hevc HLG, 10.75 Mbps.

| Arm | Result | Rate |
|---|---|---|
| `untagged+h264` (what shipped before) | **avc SDR `ITU_R_709_2`** | 14.11 Mbps |
| `tagged+hevc` (what ships now) | hevc HDR `ITU_R_2100_HLG` | 14.71 Mbps |
| `tagged+hevc+captions` | hevc HDR `ITU_R_2100_HLG` | 12.24 Mbps |

Three things fall out of that:

- **The old path really was flattening masters.** Not inferred from API
  semantics — the file comes back tagged BT.709 SDR. That is O2's defect,
  reproduced.
- **The Core Animation overlay does not force the composition to SDR.** This was
  the likeliest way the fix could have been undone, since `CATextLayer` and
  friends are sRGB. The output stays HLG with captions burned in.
- **The preset is not starving the master.** Both HDR arms come back *above* the
  source rate, so the "a preset picks its own bit rate" worry does not bite
  here. It is still content-dependent; re-run against real footage.

`AVAssetExportPresetPassthrough` was also confirmed to serve an HLG HEVC cut
into an MP4 container, which is what keeps `extractRange` off the transcode
fallback. See §4a.

## What this does not answer

- **How the captions look.** White lands around 72% of the video range — HLG
  diffuse white, neither clipped at peak nor crushed grey — but a code value is
  not a judgement. Somebody has to watch a real clip on an HDR display.
- **iOS.** This is macOS AVFoundation. The encoders available differ.
- **Real glasses tags.** The fixture is tagged the way the glasses are
  *documented* to tag; only a real recording proves they match.
