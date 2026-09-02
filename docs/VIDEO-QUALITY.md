# Video quality

Status: draft, 2026-08-04. Records what the clip pipeline does today, what was
changed, what was measured, what was rejected and why, and what is left.

Everything numeric below is measured on hardware (iPhone 16 Pro Max,
iOS 26.5.2), not estimated. Reproduction commands are at the bottom.

---

## 1. Project context

**Clypso** (repo `yjct`, local folder `~/Desktop/jarvis`) is a React Native
companion app for Meta smart glasses — Ray-Ban Meta, Oakley Meta HSTN, Ray-Ban
Display — aimed at clippers and streamers.

The core loop:

> wake word ("Clypso") → flush the last N seconds from a rolling video buffer →
> clip lands in the local library → captions burn in → share via the native OS
> share sheet

Two facts shape every decision about picture quality:

- **MWDAT 0.8.0 has no native recording API.** `MWDATCamera.Stream`'s entire
  surface is `start()`, `stop()`, `capturePhoto(format:)`. "Ask the glasses to
  record at full quality onto their own flash and fetch the file" is not
  possible. Everything we ship is re-encoded from a live stream.
- **The app is in Phase 1/2.** Phase 2 publish targets (YouTube Shorts,
  Instagram Reels, Facebook, TikTok) are code-complete behind `PublishTarget`
  but credentials are pending. That matters here because every one of those
  targets runs its own transcode on upload, which caps how much any local
  quality work can matter.

---

## 2. The pipeline — where pixels actually flow

| # | Stage | File | What it does to the pixels |
|---|-------|------|---------------------------|
| 1 | Glasses → phone | MWDAT SDK | Compressed over the link, decoded by the SDK. Hands us **raw `420v` CVPixelBuffers**. |
| 2 | Segment encode | `ios/Clypso/MWDATSegmentWriter.swift` | Encodes rolling 5s MP4 segments. **This is the only place the glasses' pixels are encoded at full fidelity.** |
| 3 | Ring buffer | `src/core/SegmentRingBuffer.ts` | Holds segments, evicts old ones. No transcode. |
| 4 | Stitch | `modules/clip-stitcher/ios/ClipStitcher.m` | Concatenates the covering window. **Passthrough — no re-encode.** |
| 5 | Caption burn | `modules/clip-stitcher/ios/CaptionEngine.m` | Composition + Core Animation caption overlay, then one `AVAssetExportSession`. **One encode generation.** |
| 6 | Share | `src/ui/screens/LibraryScreen.tsx:362` | Hands the `.mp4` path to `Share.open`. We do nothing to it. |

Stage 2 is the fidelity ceiling we control. Stage 1 is the fidelity ceiling we
do not.

---

## 3. What landed

Three changes, all verified live on device this session.

### 3.1 `4348099` — segment writer bitrate and profile

`MWDATSegmentWriter.swift` was writing H.264 **Baseline** at `width * height * 2`
bps. That is 0.067 bits/pixel/frame — the code comment claimed "~0.2 bpp" and was
wrong by 3x — and it always landed on the 1.5 Mbit floor.

Now **0.3 bpp, 4 Mbit floor, H.264 High profile**. High buys CABAC and B-frames
over Baseline for roughly 20% better quality at the same bitrate, at no cost on a
hardware encoder.

### 3.2 `10eeb95` — stitcher stops re-encoding

`ClipStitcher.m` was decoding every frame to BGRA and re-encoding **with no
bitrate key at all**, so AVFoundation picked a default. Now
`AVAssetExportPresetPassthrough` over the existing composition. The transcode
survives only as a fallback for mixed-format segments, which is a real case — the
SDK's ABR ladder can change resolution mid-session.

### 3.3 Stream resolution `.medium` → `.high` (UNCOMMITTED)

`MWDATBridge.swift:942`. `.medium` was a hard 504x896 ceiling. The SDK's
`VideoLadderedScaler` only ever steps *down* from the requested rung, so asking
for `.high` is strictly better even when the link cannot sustain it.

Confirmed working: clips now arrive at 720x1280.

> **Not yet committed.** That file also holds ~33 lines of unrelated `chime()`
> work, so it needs a hunk-level commit.

### 3.4 Verification that all three landed

From `Documents/clypso-diagnostics.log`:

```
source video format: subtype='420v' 720x1280 compressed=false
video input: 720x1280 h264-high bitRate=8294400
```

And the stitched output measures **8,303,793 bps** against the segment writer's
**8,294,400** target — i.e. passthrough carries the segment bitrate through
essentially bit for bit.

---

## 4. What was measured

### 4.1 The caption stage is not lossy

This was the headline suspicion going in: that `AVAssetExportPresetHighestQuality`
in `CaptionEngine.m` gives no bitrate control and was crushing every upstream
gain. **It is not.** All 21 files in `Documents/clips/` were probed:

| clip | source | captioned |
|---|---|---|
| `bf1b6m` | h264 High 720x1280 **5.05 M** | h264 High 720x1280 **6.86 M** |
| `bfbmt4` | h264 High 720x1280 **6.22 M** | h264 High 720x1280 **8.12 M** |
| `cn1rbe` | h264 High 720x1280 **8.30 M** | h264 High 720x1280 **10.63 M** |
| `g3pu23` | h264 High 720x1280 **8.30 M** | h264 High 720x1280 **10.48 M** |

Same codec, same profile, same resolution, and **25–30% more bitrate than the
source** in every case.

Fidelity of that generation, SSIM over the whole clip measured on the top half of
the frame where no captions are drawn:

```
SSIM Y: 0.990634   All: 0.993036
```

That is a visually transparent re-encode.

### 4.2 The HEVC `.mov` was not ours

A `720x1280 hevc Main 1,800,803 bps` file named `.captioned.classic.mov` was the
original evidence that the pipeline was crushing clips. **There is no `.mov` and
no HEVC anywhere in the app container.** Every file we write is `.mp4` / H.264.

`shareClip` hands the raw `.mp4` to `Share.open`. That HEVC `.mov` was produced
*downstream* — the iOS share sheet, Photos, or AirDrop transcoding on the way
out. It is a delivery-channel artifact, not a pipeline artifact.

**This reframes the whole problem.** The measured loss is not in production.

### 4.3 The glasses feed is the real ceiling

Round-tripping the 720x1280 source down to 504x896 and back up:

```
SSIM Y: 0.997806
```

The `.high` stream carries **almost no detail above 504p**. It is a soft
~504p image delivered in a 720p frame.

Control, to prove the test is actually sensitive — same region, comparing the
captioned file (which contains genuinely sharp 720p burned text) against the
source (which does not):

| region content | SSIM Y after 720→504→720 round trip |
|---|---|
| with burned caption text | 0.994615 |
| footage only | 0.996370 |

Our own text loses *more* in the round trip than the footage does. The test
detects real high-frequency detail; the footage has little.

**At 8.3 Mbit we are spending roughly 3x the bits the content actually
contains.**

---

## 5. Rejected, with reasons

Each of these was proposed seriously and dropped on evidence. They are recorded
so they do not get re-proposed.

| Proposal | Verdict | Why |
|---|---|---|
| Rewrite `CaptionEngine` as `AVAssetReader`/`AVAssetWriter` with explicit encoder settings | **No** | Premise was that the export crushes the clip. Measured SSIM 0.9906 and *higher* bitrate than source. Large rewrite of the one component that must keep working, for ~1%. |
| Raise 0.3 → 0.5 bpp | **No** | 30s clips do saturate the 8.3 Mbit cap, so the bits would be consumed — but §4.3 says they would be spent encoding noise, not detail. |
| `AVVideoMaxKeyFrameIntervalKey` 30 → 60 | **No** | Worth ~1–3% on its own, but passthrough trimming snaps to GOP boundaries. A 60-frame GOP doubles worst-case cut error from 1s to 2s — on the exact `trimEndSec` wake-word cut that is specced to be precise. |
| Switch to HEVC | **No** | H.264 High is universally accepted by the Phase 2 publish targets; HEVC-in-MP4 is historically flaky for TikTok and third-party share-sheet consumers. The efficiency gain is moot this far above the source's information content. |
| `VTSuperResolutionScaler` (neural SR, new in iOS 26) | **No** | See below. |
| `VTLowLatencySuperResolutionScaler` | **No** | `maximumDimensions` is 960x960. Our 720x1280 does not fit. (It *would* have fit the old 504x896 at 2x.) |

### 5.1 Why neural super-resolution loses

iOS 26.5 does ship first-party temporal SR, and the device supports it
(`isSupported: true`). It still loses:

- **Only 4x is supported.** `supportedScaleFactors` returns `[4]`. 720x1280 →
  2880x5120, which then has to be scaled back down.
- **Video mode rejects our frames outright on iOS.** The height cap is 1080 and
  we are 1280 tall — the configuration initializer returns `nil` with *"Invalid
  input height"*. Using it means rotating every frame to landscape, running SR,
  rotating back, then downscaling: three extra full-frame resamples per frame on
  top of the neural pass, ~900 frames per clip.
- **Requires a model download** before first use
  (`VTSuperResolutionScalerConfigurationModelStatusDownloadRequired`).
- **The platform re-encodes anyway.** Detail synthesized locally that survives
  neither TikTok's nor Instagram's transcode ladder is battery spent for nothing.

The decisive point is the last one, and it applies regardless of how fast the
model turns out to be.

---

## 6. What is left to do

Ranked by (visible gain) / (cost + risk).

### 6.1 Render the caption pass at 1080x1920 — SUPERSEDED BY 8

> Kept as written, because 8 is a response to it. Two things below have since
> been settled and one has been contradicted: the two wins listed here are
> independent claims and only the second is measured (8.4); the "open risk"
> about an oversized `renderSize` does not reproduce on the host (8.8); and the
> guard admits a stitched asset whose real samples are 504x896 (8.2), which is
> a prerequisite to fix before any of this ships.


Change `CaptionEngine.renderEdit` to set `videoComposition.renderSize` to a
1080 short edge when the source is smaller, concat the scale onto the layer
instruction transform, and lay the caption layers out at the new size.

Wins twice:

1. Publish targets allocate a better transcode ladder to a 1080p upload than to
   a 720p one. Viewers are served more bits even though the source is soft. This
   is the only lever we have on stage 6, and it is well established.
2. **Captions are rasterized at the render size.** Today the Hormozi text — the
   sharpest, highest-contrast, most-looked-at thing in frame — is drawn at 720p.
   At 1080p it is genuinely sharper, because unlike the footage, the text really
   does carry full detail at that resolution.

Layout risk is low: `fontScale`, `marginVScale`, `marginHScale` are all fractions
of the render height, so the composition scales exactly.

**Open risk:** it is not confirmed that `AVAssetExportPresetHighestQuality`
honours a `renderSize` *larger* than the source. If it clamps, the fallback is an
explicit preset, or the reader/writer path rejected in §5 — which would move this
from "small change" to "significant rewrite".

**Blocked:** `CaptionEngine.m` is currently open and being edited in Xcode
(whisper.cpp transcription work). Applying edits against a moving file risks
clobbering it.

**Verification must include a frame grab, not just `ffprobe`.** Resolution alone
does not prove the captions still render correctly at the new size.

### 6.2 Get more real detail out of the glasses link — HIGHEST VALUE

This is the only remaining change that would add **actual information** rather
than re-packaging what we have. Everything else in this document is cosmetics on
a ~504p source.

`.high` is gated on the WiFi Direct transport, new in MWDAT 0.8.0, which has no
public API and is negotiated internally. Prior investigation found no lever.
Worth one focused re-check of the 0.8.0 binaries, because the payoff dwarfs
everything else here.

Relevant strings already found in `MWDATCamera`:
`" requires medium (BTC) or high (WiFi) bandwidth link"`, `stepUpLadder`,
`stepDownLadder`, `update resolution to %dx%d`.

### 6.3 Investigate the share channel

§4.2 showed the only measured heavy loss happens *after* the app hands the file
off. Worth establishing: which share destinations transcode, whether a different
UTI/type on `Share.open` avoids it, and whether writing to Photos first changes
the outcome. Potentially the largest real-world win in this document, and it
costs nothing to measure.

### 6.4 Sharpen / denoise before the caption encode

The footage is soft and probably noisy (small sensor, often low light). A modest
unsharp mask genuinely helps perceived quality on soft material, and iOS 26 also
ships `VTTemporalNoiseFilter`. Real but small, and it must not be applied *after*
captions are burned or it will halo the text.

### 6.5 Commit the `.high` hunk

`MWDATBridge.swift:942` is confirmed working but uncommitted, in a file that also
holds unrelated `chime()` work. Needs a hunk-level commit, attributed to the user
only.

---

## 7. Reproducing the measurements

Pull the diagnostics log (note: `--destination` must be a FILE path, not a
directory, and `--username` is not a valid flag):

```bash
xcrun devicectl device copy from --device <UDID> --domain-type appDataContainer \
  --domain-identifier com.mocinjay.clypso \
  --source Documents/clypso-diagnostics.log --destination /tmp/
```

Pull the whole clip library:

```bash
xcrun devicectl device copy from --device <UDID> --domain-type appDataContainer \
  --domain-identifier com.mocinjay.clypso \
  --source Documents/clips --destination /tmp/clipsdir
```

Probe every clip:

```bash
cd /tmp/clipsdir && for f in *.mp4; do echo -n "$f  "; \
  ffprobe -v error -select_streams v:0 \
  -show_entries stream=codec_name,profile,width,height,bit_rate -of csv=p=0 "$f"; done
```

Cost of the caption generation (crop avoids the caption region; `fps`+`setpts`
align the variable-rate source against the CFR output):

```bash
ffmpeg -i captioned.mp4 -i source.mp4 -lavfi \
  "[0:v]crop=720:640:0:0,fps=30,setpts=PTS-STARTPTS[a];\
   [1:v]crop=720:640:0:0,fps=30,setpts=PTS-STARTPTS[b];[a][b]ssim" -f null - 2>&1 | grep SSIM
```

How much real detail the source carries:

```bash
ffmpeg -i source.mp4 -lavfi \
  "[0:v]split=2[o][d];[d]scale=504:896,scale=720:1280[r];[o][r]ssim" -f null - 2>&1 | grep SSIM
```

> **Gotcha:** `ffmpeg -v error` *suppresses* the SSIM summary line. Drop it and
> `grep SSIM` instead.

Live console for the caption stage — `CELog` writes `[CaptionEngine]` lines to
NSLog, alongside the `[MWDAT]` lines:

```bash
xcrun devicectl device process launch --console --terminate-existing com.mocinjay.clypso
```

> The console connection reliably drops during long *capture* runs, which is why
> `MWDATSegmentWriter` also mirrors to `clypso-diagnostics.log`. A caption export
> is short enough that the live console is fine.

---

## 8. Canvas promotion: claim A and claim B, separated

Status: 2026-08-29. `CECanvasPromotionEnabled` is still `NO`. The hypothesis in
§6.1 has been split into its two independent claims, one of them has been
measured, the harness has been fixed so the other one can be, and the guard
defect this audit found has been closed — so the flag is now safe to flip the
day claim A comes back positive, and unsafe to flip before then only because
claim A is still unmeasured.

§6.1 argued for promotion on two grounds at once. They are not one argument:

- **Claim A** — publish targets allocate a better transcode ladder to a
  1080-labelled upload. This is about someone else's transcoder. It can only be
  settled by uploading. It is **not measured**.
- **Claim B** — captions rasterise sharper at `renderSize` 1080x1920, because
  unlike the footage the text genuinely carries detail at that resolution. This
  is about our own pixels and is deterministic. It is **measured below**.

They fail independently, and claim B is worth much less if claim A fails —
see §8.5.

### 8.1 The guard: what it actually reads

`CEPromotedRenderSize` (`CaptionEngine.m:92`) is fed from `CaptionEngine.m:549`:

```objc
CGAffineTransform transform = videoTrack.preferredTransform;
CGSize natural = videoTrack.naturalSize;
CGSize sourceSize = CGSizeApplyAffineTransform(natural, transform);
sourceSize = CGSizeMake(fabs(sourceSize.width), fabs(sourceSize.height));
```

**It applies `preferredTransform`; it does not read `naturalSize` raw.** A
rotated 1280x720 asset is measured as portrait 720x1280 and passes, in both
rotation directions. Verified on real files rather than on synthetic transforms
— an MP4's display matrix is stored as exact fixed-point, so `preferredTransform`
comes back with exact `0.0`/`±1.0` components and the product is exactly
720x1280:

```
rotA.mp4  transform exactly [0x0p+0 -0x1p+0 0x1p+0 0x0p+0]  guard sees 720x1280  -> PROMOTED
rotB.mp4  transform exactly [0x0p+0  0x1p+0 -0x1p+0 0x0p+0] guard sees 720x1280  -> PROMOTED
```

The size guards compare against exact boundaries — 720 is now the ceiling and
the floor at once (§8.2) — so they were sensitive to a size arriving as
`719.99999999992`. A display matrix read from a container carries exact
`0`/`±1` entries and never does that, but a transform composed in code does:
`CGAffineTransformMakeRotation(-M_PI_2)` leaves a `6.1e-17` cosine, which was
enough to flip a rotated proxy's verdict. Sizes are now normalised through
`CEPixelSize` before any comparison. Frame dimensions are counts of samples, so
rounding is not a tolerance — it restores the type the numbers always had.

### 8.2 The stitched mixed-resolution case — the worst case, found and closed

**It was real: a 504x896-sourced stitch passed all three guards, and promotion
would have scaled those frames 2.14x. There is now a fourth guard that refuses
it.** The code path, traced and then run:

1. The SDK's ABR ladder steps down mid-session, so the ring buffer holds
   720x1280 segments and 504x896 segments.
2. `ClipStitcher` inserts them all into one `AVMutableCompositionTrack`
   (`ClipStitcher.m:147–155`). The composition track takes its `naturalSize`
   from the **first** segment inserted and never revises it:

   ```
   inserted seg720.mp4  (720x1280) -> composition track naturalSize now 720x1280
   inserted seg504.mp4  (504x896)  -> composition track naturalSize now 720x1280
   ```

3. `AVAssetExportPresetPassthrough` **succeeds** across the resolution change on
   iOS 26 / macOS 26. The comment at `ClipStitcher.m:246` — "the one thing
   passthrough cannot do is join segments whose formats differ" — no longer
   holds. The written file carries **two `stsd` sample descriptions**:

   ```
   stsd entry count: 2
     entry 0: avc1 720x1280
     entry 1: avc1 504x896
   ```

   with the track header reporting 720x1280 and 180 of 240 frames actually coded
   at 504x896.
4. `CaptionEngine` opens that file and reads `naturalSize` = **720x1280**. Every
   guard passes.

The stitched container has laundered the resolution drop, and promotion would
have taken genuinely 504p frames to a 1080x1920 canvas: **2.14x on footage §4.3
already showed carries almost nothing above 504p.**

The transcode fallback reaches the same place by a different road: it sizes its
writer from `readerVideoTrack.naturalSize` (`ClipStitcher.m:502`), which is the
same 720x1280.

#### The fix

The guard was not wrong about what it read — `naturalSize` is the only thing the
track header offers. It was wrong to ask the header. `CESmallestCodedSize` now
walks **every** `formatDescription` on the track, takes
`CMVideoFormatDescriptionGetDimensions` from each, applies `preferredTransform`,
and returns the componentwise minimum: the resolution the softest part of the
clip was actually coded at. Coded dimensions rather than presentation
dimensions, because the question is how many samples the encoder was given.

A fourth guard compares that against a floor of `720x1280` — the same numbers as
the ceiling, so the window is exactly one rung wide. Promotion was argued for
the proxy at its top rung, where the resample is 1.5x; every other rung the
ladder delivers is a bigger resample on softer footage for the same caption
benefit.

That one line closes two holes at once, and the second was not in the original
report:

| source | before | after |
|---|---|---|
| 720x1280 throughout | promoted | **promoted** — unchanged |
| rotated 1280x720 + display matrix | promoted | **promoted** — unchanged |
| 720x1280 header over 504x896 samples | promoted (2.14x) | **refused** |
| 504x896 throughout | promoted (2.14x) | **refused** |
| 700x1280 drifted sensor mode | refused, warns | refused, warns — unchanged |
| Path B 1520x2032 | refused | refused — unchanged |

The floor is checked **last**, after the aspect guard, on purpose: `700x1280` and
`504x896` both fail a size floor, but only the first is a changed sensor mode,
and the near-miss warning added in `86f841c` says so in those words. A size check
running first would have swallowed that message.

Unreadable format descriptions return `CGSizeZero`, which fails the floor. A
guard whose failure mode is degrading footage fails closed.

The refusal is logged whether or not the flag is on, matching the near-miss
warning's rationale — and since G6 in `ground-truth.md` records that nothing in
the app tracks which rung a session negotiated, this line is currently the only
field evidence of how often the ladder drops.

> **Adjacent finding, not fixed here and not part of this task.** The
> two-`stsd` file decodes cleanly in AVFoundation and produces 32 decode errors
> in libavcodec — `Reference 2 >= 2`, `left block unavailable` — because
> non-Apple decoders bind one `avcC` for the track. Every publish target ingests
> with something ffmpeg-shaped. This is worth its own investigation and is
> unrelated to the canvas question.

### 8.3 The invocation path: promotion is Pro-only

**The free-tier share flow does not route through `CaptionEngine` at all.**

- `CaptionQueue.enqueue()` returns immediately for non-Pro
  (`CaptionQueue.ts:43–48`); so do `retry()` and `resume()`.
- With nothing queued, `captionState` stays `'none'`.
- `deliverablePath()` returns `captionedFilePath` only when `captionState` is
  `'ready'` (`ClipStore.ts:228`), so it returns the raw stitched `filePath`.
- `LibraryScreen.tsx:347` hands that path to `Share.open`.

Stage 5 is skipped entirely. Promotion is a **Pro-only** change, and since Phase
2 credentials are still pending, no clip shipping today would be affected by
flipping the flag.

There is a second skip inside the Pro path. `renderEdit` copies the file instead
of composing when there is nothing to draw and nothing to rearrange
(`CaptionEngine.m:505–521`): `cues.count == 0 && !restructures`. A silent clip
reaches `captionState: 'ready'` having been byte-copied, never promoted. So even
for a Pro user, promotion applies to *captioned* clips only — which is
consistent with claim B being the real motivation, and leaves claim A's
population smaller than §6.1 implied.

### 8.4 Claim B, measured

Measured with `tools/measure/canvas/` — a host tool carrying a verbatim copy of
`CEPromotedRenderSize` and a line-for-line port of `-addCaptionLayers:`, using
the shipping `Montserrat-ExtraBold` and the shipping `classic` burn style.

Source: a 20s 720x1280 H.264 High clip at 8.5 Mbit built to match §4.3's
finding — detail generated at 720, resampled through 504x896, and returned to
720. Its 504 round-trip SSIM Y is **0.9930**, i.e. slightly *sharper* than the
real feed's 0.9978, which biases the test conservatively: a crisper source is a
better case for the 720 arm, so it cannot inflate a 1080 win.

Scoring is on the **glyph band only** — the mask is built from the reference, so
both arms are scored over identical pixels. Whole-frame SSIM was not used, for
the reason §4.3 gives: the soft footage dominates it and would bury the effect.
Each arm is compared against an **8x-supersampled rasterisation of the same
glyphs at the same geometry** — the reference an ideal, resolution-independent
rasteriser would have produced.

**Scenario `return720` — the platform hands both arms back at 720:**

| arm | SSIM vs ideal | PSNR | edge \|grad\| | 10–90% rise (of frame height) |
|---|---|---|---|---|
| 720 render (ships today) | 0.96616 | 23.35 dB | 1.00618 | 0.3052% |
| 1080 render → 720 | **0.99099** | **29.78 dB** | 1.00794 | 0.2864% |

Δ SSIM **+0.0248**, Δ PSNR **+6.4 dB**.

**Scenario `native` — each arm served at the resolution it was sent:**

| arm | SSIM vs ideal | PSNR | edge \|grad\| | 10–90% rise |
|---|---|---|---|---|
| 720 render → 1080 | 0.88886 | 18.90 dB | 0.78159 | 0.1866% |
| 1080 render (native) | **0.99463** | **32.34 dB** | 0.77969 | 0.1921% |

Δ SSIM **+0.1058**, Δ PSNR **+13.4 dB**.

**Claim B is true, in both scenarios, and it is much larger when the platform
keeps the 1080.** Three readings worth keeping:

- **The gain is edge *accuracy*, not edge *contrast*.** Mean gradient magnitude
  is within 0.3% across every arm; it is SSIM and PSNR against the ideal that
  move. Rendering at 1.5x and downsampling is supersampling, and it lands the
  glyph edges closer to the true outline than direct rasterisation at 720 does.
  An edge-acuity number on its own would have said nothing — in the `native`
  scenario it points the *wrong* way, because Lanczos-upscaling the 720 render
  adds ringing that steepens edges while being far less accurate.
- **The `return720` gain is filter-dependent and small.** Re-run with three
  downsamplers: Lanczos +0.0248 SSIM / +6.4 dB, Bicubic +0.0247 / +6.2 dB,
  Box/area **+0.0134 / +2.7 dB**. Direction is consistent; take +0.013 SSIM as
  the floor.
- **"Closer to the geometric ideal" is not the same as "a viewer prefers it."**
  Ink is equal to within 0.2% (9214 vs 9199), so the 720 raster is not fatter or
  thinner — it is grid-fit differently. Hinting at these sizes exists to make
  small text crisper on-grid, and a supersampled glyph can measure closer to the
  outline while reading marginally softer. At 720 delivery the difference is
  visible only under magnification.

### 8.5 Why claim A being false erases most of claim B

If the platform returns the 1080 arm at 720, the promoted render is downsampled
back and the whole benefit collapses from +0.106 SSIM to at best +0.025 —
bought at the costs in §8.6. That is why returned resolution, not bitrate, is
the decisive measurement, and why the harness now records and judges it.

### 8.6 The cost side

Measured on the same 20s clip, both arms exported through
`AVAssetExportPresetHighestQuality`:

| | 720x1280 | 1080x1920 | delta |
|---|---|---|---|
| export wall clock | 1.40 s | 2.85 s | **+104%** |
| peak footprint | 169 MB | 286 MB | **+69%** |
| output size | 18.37 MB | 26.26 MB | **+43%** |
| output bitrate | 7.35 Mbit | 10.51 Mbit | +43% |

> These are host numbers on an Apple Silicon Mac, and they **understate** the
> promoted arm. `AVVideoCompositionCoreAnimationTool` drops any tree containing
> a `CATextLayer` in this macOS CLI (see `canvas/README.md`), so the measured
> exports carry the upscale and the encode but not the Core Animation pass —
> which is per-frame and would be running over 2.25x the pixels. Ratios
> transfer; absolute times do not. Confirm on device before deciding.

Upload cost, from the measured sizes:

| clip | 720p | 1080p | on 8 Mbit LTE up | on 3 Mbit LTE up |
|---|---|---|---|---|
| 20 s | 18.4 MB | 26.3 MB | 18 s → 26 s | 49 s → 70 s |
| 30 s | 27.6 MB | 39.4 MB | 28 s → 39 s | 73 s → **105 s** |

A 30s clip on a weak cellular uplink goes from 73 to 105 seconds. For an app
whose loop is "clip it and send it," that is the number to weigh against
+0.013 SSIM on the glyph band.

### 8.7 Exact criteria for flipping `CECanvasPromotionEnabled`

All of the following, or it stays `NO`.

**Prerequisite — DONE.** The laundering hole in §8.2 is closed: promotion now
refuses any clip whose smallest sample description falls below 720x1280.
Re-check it before flipping, with one command:

```bash
tools/measure/canvas/fixtures.sh
```

It builds the fixtures and runs `canvas_probe verify`, which asserts the whole
decision table in §8.2 — including the stsd case against a real stitched file —
and exits non-zero on any regression. `ladder.sh prepare` runs the same check
before it builds the native arm, on the grounds that an arm built by a
misbehaving guard is not worth uploading.

**Claim A — from `tools/measure/ladder.sh`, per platform:**

1. The `1080p-native` arm returns **at 1080x1920** (`returned_as` = `same`).
   Any `DOWNSCALED` return fails the platform outright.
2. Mean returned bitrate at least **10% above** the 720p arm's.
3. Mean returned SSIM **no worse** than the 720p arm's (tolerance 0.002).
4. At least **three runs per platform**, same account, same network, arms
   uploaded within minutes of each other.

`ladder.sh report` applies exactly these and prints PASS / FAIL / HOLD. Judge on
`1080p-native`, not `1080p-ffmpeg` — only the former is built by shipping code.

**Claim B — already met, recorded here so it is not re-measured:** +0.0134 SSIM
floor at 720 delivery, +0.1058 at 1080 delivery, on the glyph band.

**Cost gate:** on-device export wall clock for a 30s clip must stay inside
whatever the capture loop can absorb, measured on device rather than inferred
from §8.6.

**Verification after flipping**, per §6.1 and unchanged: a frame grab, not just
`ffprobe`. Resolution alone does not prove the captions still render correctly
at the new size.

### 8.8 What this did not settle

- Claim A. Nothing here uploaded anything. The harness is ready; the runs are not
  done. This is now the **only** thing standing between the flag and `YES`.
- Whether `AVAssetExportPresetHighestQuality` honours an oversized `renderSize`
  **on iOS**. §6.1 listed this as the open risk. On the macOS host it does — the
  promoted arm was written at 1080x1920 — which is evidence, not proof, for the
  device.
- Whether a viewer prefers the supersampled glyph to the hinted one at 720
  delivery. The measurement says "closer to the ideal outline"; it does not say
  "looks better."
- How often the ladder actually drops in the field. The new refusal log is the
  instrument; no session has been read back through it yet. If it turns out most
  sessions are mixed-resolution, promotion applies to far fewer clips than
  claim A's population assumes, and the whole question shrinks.
- The two-`stsd` decode errors noted in §8.2. Still unexamined, still
  unrelated to the canvas question, and still the more alarming of the two
  findings — every publish target ingests with something ffmpeg-shaped.
