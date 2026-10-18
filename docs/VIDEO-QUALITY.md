# Video quality

Status: draft, 2026-08-04. Records what the clip pipeline does today, what was
changed, what was measured, what was rejected and why, and what is left.

Everything numeric below is measured on hardware (iPhone 16 Pro Max,
iOS 26.5.2), not estimated. Reproduction commands are at the bottom.

---

## 1. Project context

**Clipso** (repo `yjct`, local folder `~/Desktop/jarvis`) is a React Native
companion app for Meta smart glasses — Ray-Ban Meta, Oakley Meta HSTN, Ray-Ban
Display — aimed at clippers and streamers.

The core loop:

> wake word ("Clipso") → flush the last N seconds from a rolling video buffer →
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
| 2 | Segment encode | `ios/Clipso/MWDATSegmentWriter.swift` | Encodes rolling 5s MP4 segments. **This is the only place the glasses' pixels are encoded at full fidelity.** |
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

From `Documents/clipso-diagnostics.log`:

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

### 6.1 Render the caption pass at 1080x1920 — IN PROGRESS

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
  --domain-identifier com.mocinjay.clipso \
  --source Documents/clipso-diagnostics.log --destination /tmp/
```

Pull the whole clip library:

```bash
xcrun devicectl device copy from --device <UDID> --domain-type appDataContainer \
  --domain-identifier com.mocinjay.clipso \
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
xcrun devicectl device process launch --console --terminate-existing com.mocinjay.clipso
```

> The console connection reliably drops during long *capture* runs, which is why
> `MWDATSegmentWriter` also mirrors to `clipso-diagnostics.log`. A caption export
> is short enough that the live console is fine.

---

## 8. 2026-10-18 — capturing at the stream's ceiling

This section supersedes the parts of §2–§5 that describe segments as H.264
encoded on the phone.

**What cannot change.** MWDAT, up to and including 1.0.1 (2026-10-09), still
has no video-record API: the glasses' own 3K / 1080p60 capture is not
reachable. The best any app gets is the live stream, at most 720x1280 @ 30.
Everything below is about reaching that ceiling without losing anything on
the way.

| Change | Where | Why |
|---|---|---|
| Wi-Fi entitlements (`HotspotConfiguration`, `wifi-info`) | `ios/Clipso/Clipso.entitlements`, wired in `Config/Debug.xcconfig` / `Release.xcconfig` | The SDK joins the glasses' Wi-Fi with `NEHotspotConfigurationManager`. With no entitlements file the app could only ever stream over Bluetooth, where the ladder caps resolution and cuts frame rate. Same pair as Meta's CameraAccess sample. Needs the two capabilities on the App ID, which only paid teams get; a free Personal Team sets `CLIPSO_ENTITLEMENTS =` in `Signing.xcconfig` for a Bluetooth-only build. |
| `ClientToken` under `MWDAT`, `_meta-datax._tcp` in `NSBonjourServices` | `Info.plist` | Completes the attestation config (empty in Developer Mode, `MWDAT_CLIENT_TOKEN` otherwise); lets iOS allow the SDK's local-network browse. |
| SDK 0.8.0 → 1.0.1, iOS 17.2 minimum | project, `Package.resolved` | Adds the Wi-Fi Aware transport with SoftAP fallback. `addStream` → `addCamera(config:).stream`. |
| Stream `.raw` → `.hvc1`, segments written passthrough | `MWDATBridge.swift`, `MWDATSegmentWriter.swift` | The glasses' own HEVC is stored bit for bit — no phone-side decode and H.264 re-encode, so one fewer quality generation and no realtime encoder to drop frames (`notReady`) when other work holds the hardware. This is how Meta's sample records. |
| Segments start on keyframes | `MWDATSegmentWriter.swift` | Passthrough requires it. Rotation waits for the first keyframe after `segmentSeconds`, so segments abut with no lost frames; `cut()` waits up to 2s for one. Before a stall recovery or a rebuilt pipeline tears the stream down, the open segment is finished and kept (with up to 2s of sound past its last frame, and a duration that covers it), so a dropout's last seconds reach the buffer. Gaps that recover by themselves stay inside the open segment. A passthrough frame the writer cannot take makes it skip to the next keyframe rather than write a GOP of undecodable pictures. |
| Glasses timestamps kept | `MWDATSegmentWriter.swift` | Frames used to be stamped with phone arrival time, which wrote the link's burstiness into the file as judder. Now the glasses' spacing is kept, shifted onto the host clock by the lowest observed delay (re-measured per segment) so phone-mic audio stays in sync. A stall leaves the offset alone (late frames keep their capture times); only a jump in the glasses' own clock re-anchors it. A writer's first segment opens after ~0.5s of frames so its offset is not just the opening keyframe's. |
| Mic audio routed by timestamp | `MWDATSegmentWriter.swift` | Video arrives late by the link's delay, so audio appended as it came put the start of each segment's sound at the end of the previous one: a freeze then silence at every join. Audio now waits for the video it belongs under. |
| Terminal stream stops rebuilt at once | `MWDATBridge.swift` | Since SDK 0.9 taking the glasses off ends the stream instead of pausing it. The bridge rebuilds immediately (keeping the open segment) instead of after the 10s no-frame watchdog, and a stopped or unwatched stream no longer passes for an open pipeline on re-arm. A recovery restores the writer only if the wearer is still armed when the stream comes back, stands down if a re-arm already rebuilt the pipeline, keeps an armed session through backgrounding, and aborts its open if the pipeline is released meanwhile. A "Clipso" heard while capture was down is saved when it re-arms. |
| Preview decodes HEVC itself | `MWDATPreviewDecoder` in `MWDATBridge.swift` | `.hvc1` frames carry no pixel buffer. Decoding runs only while a preview is visible and never in the background. |
| `.medium` fallback | `MWDATBridge.requestedResolution` | If a `.high` stream averages under 26 fps over its first ~10s, later streams in the process ask for `.medium` @ 30 (§4.3: Bluetooth `.high` carried ~504p of detail anyway). The live stream is never renegotiated. Streams rebuilt by stall recovery, opened in the background, or from MockDeviceKit are not judged. |
| Caption export keeps source frame timing | `CaptionEngine.m` | `sourceTrackIDForFrameTiming` instead of resampling to `round(nominalFrameRate)`, which duplicated and dropped frames on variable-rate capture. |
| No captioning while armed | `CaptionQueue.setCaptureActive` | Caption exports competed with live capture for the media hardware. Clips queue and caption on disarm. |
| Glasses chime off by default | `config.ts`, one-time migration in `SettingsStore` | The chime is a still capture on the live stream, fired at the moment being clipped. |

**Codec of what is delivered.** Uncaptioned clips are now HEVC in MP4 (the
glasses' bitstream). Captioned clips are re-encoded by the caption export as
before. §5's HEVC concern for third-party share targets applies to the
uncaptioned ones.

**Verify on device** (`Documents/clipso-diagnostics.log`):

- `addCamera(codec: hvc1, resolution: high, fps: 30)` and
  `FRAME ANATOMY — subtype='hvc1' 720x1280 … keyframe=…`
- `video input: … 'hvc1' passthrough (no re-encode)`
- per segment: `rotating: … fps=… mode=passthrough keyframes=… worstGap=…`
- every 5s: `HEALTH fps=… resolution=…`, and once per stream `high held …` or
  `high averaged … — the next stream asks for medium@30`
- `timing: glasses pts=… arrival=…`, or `frames carry no capture timestamp`
  if the SDK sends none (arrival time is then used, as before)

`source video format: … 720x1280` with `HEALTH fps` holding near 30 means the
Wi-Fi link came up; 504x896, or `.high` with falling fps, means Bluetooth.
