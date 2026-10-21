# Architecture

Clipso is a React Native (TypeScript) app with two native layers:

- a Swift bridge to the Meta Wearables Device Access Toolkit (MWDAT 1.0.1) in
  `app/ios/Clipso/`, and
- a local native module, `app/modules/clip-stitcher/` (ObjC on iOS, Kotlin on
  Android), autolinked through `app/react-native.config.js`.

Glasses capture is iOS-only. The Android build compiles and has a stitcher and
a live-mic wake word, but no video source yet.

| `app/src/` | What lives there |
| --- | --- |
| `core/` | Capture loop (`CaptureController`), rolling buffer, clip library (`ClipStore`), settings, Pro entitlement |
| `device/` | The video source (`MWDATSource`) and the glasses-session lease |
| `wakeword/` | Trigger providers and the phrase matcher |
| `services/capture.ts` | Builds one capture session per Armed screen and holds captioning while it is live |
| `phase2/` | Everything after capture: captioning, the hook-first edit, publishing |
| `native/` | Typed wrappers over the native modules |
| `ui/` | Screens, components, theme |

## Boot and connection

`App.tsx` plays the splash, then opens Onboarding (first launch) or Connect. At
launch it runs the free-tier expiry sweep and `captionQueue.resume()` (for jobs
a killed app left unfinished), and an upgrade to Pro rescues clips that were
about to expire.

`ConnectScreen` is the gate. It polls `MWDATNative.getDiagnostics()` and listens
for bridge events until Meta AI registration and a device are present, opens
the glasses preview, and resets the stack to Armed once the stream reports
`streaming`. Registration is a one-time hand-off to the Meta AI app, which calls
back through the `jarvis://` URL scheme (`AppDelegate` forwards it to the SDK).

Two module-level reference counts keep the glasses from running when nothing
needs them:

- `glassesLease.ts`: screens hold a lease while focused. When the count stays
  at zero for 750 ms the session is closed. The grace period covers the
  Connect → Armed reset, which drops one lease before the next is taken. A
  release never stops an active recording; `MWDATSource.stop()` closes the
  session once recording ends.
- `GlassesPreview.tsx`: native preview frames (decode + JPEG + base64, about
  8 fps) are produced only while a preview is on screen.

## Capture

```
ArmedScreen ──(one per mount)──▶ buildCaptureSession()     services/capture.ts
                                         │
                                 CaptureController          core/
         ┌───────────────────────────────┼──────────────────────────┐
         ▼                               ▼                          ▼
   MWDATSource                    WakeWordProvider          SegmentRingBuffer
         │                         • SpeechWakeWord         (pure TS, tested)
   MWDATBridge (Swift)             • MockWakeWord (tap)             │ flush on trigger
   MWDATSegmentWriter                                               ▼
         │                                                  ClipStitcher (native)
         └─ ~5 s MP4 segments ─▶ ring buffer + wake word            ▼
                                                 ClipStore ─onClipSaved─▶ CaptionQueue
```

**States.** `idle → arming → armed ⇄ recording / saving`, plus `error`.
`isCaptureLive()` is true from arming until disarm, including an `error` that
interrupted a running session.

**Arming.** `ArmedScreen` arms on focus and disarms on blur. `arm()` runs
`source.prepare()`, `source.start(onSegment, onError)` and `wakeWord.start()`.
Each finished segment is pushed into the ring buffer, which evicts and deletes
files outside the look-back window (30 s free, up to 90 s Pro), and is handed to
the wake word to transcribe.

**Triggers.**

- *"Clipso"* (`captureNow`) saves the look-back window. With word timings the
  clip ends on the word: the buffer is flushed up to the segment the word was
  heard in, and the dead air after it is trimmed off that segment. Without
  timings (manual button, Android) the in-flight segment is cut and the whole
  window is saved. Capture keeps running.
- *Extended* (`startClip` / `stopClip`): the REC button pins the window and
  records until the stop button, the wake word, or the 180 s safety cap.
- *Save while down*: a "Clipso" transcribed while the feed is in `error` (or in
  the re-arm after it) is saved straight from the buffer. Stitching needs no
  live stream, and a failed re-arm would clear the buffer.

A save stitches the segments natively, adds the clip to `ClipStore`, deletes the
segment files whatever the outcome, and fires `onClipSaved`. `ClipStore` is a
JSON index under `Documents/clips` with a backup copy. Every change goes
through one serialized write queue, because captioning, UI edits and the
launch sweep write concurrently. Free-tier clips expire 24 h after capture
unless saved or published; Pro clips are kept.

**Recovery.** The bridge's 1 Hz watchdog reports a stream that stops delivering
frames (10 s) and rebuilds it, putting the segment writer back if the wearer is
still armed. Terminal stream stops (glasses taken off) are rebuilt at once.
`ArmedScreen` re-arms after an error at most 3 times, 4 s apart, and again on
return to the foreground. An extended recording interrupted by a drop carries
on after the re-arm. The pipeline details are in
[VIDEO-QUALITY.md §8](VIDEO-QUALITY.md#8-2026-10-18--capturing-at-the-streams-ceiling).

The Armed screen mirrors capture state to a Lock Screen / Dynamic Island Live
Activity, so a wearer with the phone pocketed can see that capture is live and
how many clips have landed.

## Key decisions

**Segmented rolling buffer.** The writer records ~5 s segments back-to-back and
the ring buffer keeps just enough to cover the window. Memory stays flat, the
buffer survives app suspension better than an in-memory frame buffer, and the
wake word gets finished files to transcribe. Segments start on glasses
keyframes and store the glasses' HEVC unchanged (no phone-side re-encode), with
phone-mic AAC audio placed by timestamp. The glasses' Bluetooth mic is avoided
on purpose: selecting it renegotiates the same link into voice mode and starves
the video.

**One source, behind an interface.** `DeviceVideoSource` has one app
implementation, `MWDATSource`, which drives the native `MWDATBridge`. Tests
drive `CaptureController` with in-memory fakes of the interface.
`MWDATSource.stop()` detaches only the segment writer. The stream stays up so a
re-arm does not renegotiate the link (the glasses chime on every stop/start).

**The wake word is ours, not Meta's.** There is no third-party "Hey Meta" hook.
`SpeechWakeWord` transcribes each segment with Apple's speech recognition. It
tries on-device first, and retries once on Apple's servers when the on-device
pass hears nothing: the on-device model largely ignores the "Clipso" vocabulary
hint. `phraseMatch.ts` scores the transcript for "Clipso" and its common
mis-hearings ("clip so", "clips o"). Detection trails the word by up to one
segment; the look-back window still contains the moment. `MockWakeWord`
(Settings → Voice trigger → Manual button) replaces it with a tap.

**Battery honesty.** Recording keeps the glasses camera and the phone mic open
continuously. Onboarding says so before the wearer ever arms.

## After capture: captioning

- **`CaptionQueue`** auto-captions every new clip (Pro), one job at a time.
  Progress is stored **on the clip** (`captionState`), so the library renders
  "Captioning…" from data it already reads and `resume()` can restart jobs a
  killed app left behind. New jobs are **held while any capture session is
  live** (`setCaptureActive`, driven by `services/capture.ts`): a caption
  export competes with live capture for the media hardware, which cost
  captured frames. Clips caption once the wearer disarms. Every render goes
  through the queue, publishing included (`captionNow`), because every
  captioner derives its output path from the clip and the current settings
  (`<clip>.captioned.[hook.]<style>.mp4`) and a second render would delete or
  overwrite the first.
- **`getCaptioner()`** (`phase2/captioner.ts`) picks the captioner per job:
  1. `OnDeviceCaptioningProvider` (iOS): Apple Speech with on-device
     recognition required, `captionTimeline.ts` cue layout, optionally the
     hook-first plan, then one `CaptionEngine.renderEdit` export.
  2. `HttpCaptioningProvider`: Android, or iOS when on-device recognition is
     unavailable (no Speech permission, or no offline dictation for the
     language). Talks to `server/captioning`.
  3. `MockCaptioningProvider`: dev builds only. Its clips are recorded with
     `captionProvider: 'mock'` and are never badged as captioned. A release
     build with neither of the above fails the job with a reason the player
     shows.
- **Caption timing lives in TypeScript** (`captionTimeline.ts`), not in the
  native module. Chunking, per-word highlight spans, the non-overlap clamp and
  line layout are easy to get subtly wrong and are tested without a device;
  native draws what it is told. `server/captioning/captions.py` is the same
  logic for the HTTP path, and `captionTimeline.test.ts` asserts the constants
  match.
- **`CaptionEngine`** (iOS): `transcribeClip` splits the audio into 45 s windows
  with 1 s overlap (Speech limits how much audio one request may carry) and
  merges them by splitting each overlap at its midpoint. PCM is placed by
  buffer timestamp, so word timings survive gaps in the audio. It does **not**
  reuse `SpeechWakeWord`, which biases toward "Clipso" and may use Apple's
  servers. `renderEdit` composes one container layer per cue with two text
  layers per word (base + highlight), because a `CATextLayer`'s attributed
  string is not animatable. It copies the file instead of exporting when there
  is nothing to draw or rearrange.
- **`captionStyles.ts`** holds the three looks (Hormozi, Clean, Boxed): the key,
  the in-app preview and the exact burn parameters.
- **`deliverablePath(clip)`** (`ClipStore`) is the one place that decides
  captioned vs raw, so play, share and publish cannot disagree.

## Hook-first edit (Pro, iOS)

Rebuilds a clip as `[best 3-7s] -> [0.5s black] -> [complete original]`. Ported
on-device from `server/climax/`, which stays as the reference implementation.
Off by default (Settings).

- **Scoring is TypeScript** (`climaxScoring.ts`), for the same reason as the
  caption timing. `export_parity_fixture.py` dumps the Python scorer's output
  for a synthetic grid, and `climaxScoring.test.ts` asserts agreement across
  every candidate window.
- **Extraction is native** (`ClimaxEngine`) and produces 6 of the reference's 7
  signals. `visual.flow` (sparse Lucas-Kanade there) is skipped: dense optical
  flow on device is hundreds of GPU passes per clip for one signal. An absent
  signal is treated as absent rather than zero, which also covers a clip with
  no audio track.
- **One export does both** the restructure and the caption burn. Cutting first
  and captioning after would cost two encode generations, and captions laid out
  on the chronological timeline would open the hook mid-phrase.
- **The black beat needs its own instruction.** An empty range in the
  composition renders as a frozen frame (the renderer holds the previous one).
  An instruction with no layer instructions paints its `backgroundColor`,
  which is what produces black.
- Analysis failure is not captioning failure: the clip is captioned
  chronologically instead.

## Publishing (credentials pending)

- `PublishService.publish()`: authenticate → resolve hosting (before any
  captioning, so a missing presign endpoint fails at once) → captioned cut
  via `CaptionQueue.captionNow` when captions are on (reuses an existing cut,
  joins a job already queued, refused while the glasses are recording) →
  upload to hosting if the target pulls from a URL → `uploadAndPublish`. The
  Publish screen asks for explicit consent per clip, then polls `checkStatus`
  and shows the visibility the platform actually applied.
- `PublishTarget` connectors, one module each in `phase2/targets/`:
  - **YouTube Shorts**: resumable upload, OAuth via `GoogleTokenProvider`
    (null until a Google OAuth client exists; needs Google API verification).
  - **Instagram Reels**: Graph API container flow (`media_type=REELS` → poll
    `status_code` → `media_publish`). Needs a Business/Creator account and
    Meta App Review.
  - **Facebook**: `/{page-id}/videos` with `file_url`. Same Meta app and the
    same App Review submission as Instagram.
  - **TikTok**: Content Posting API Direct Post (`PULL_FROM_URL`). Until the
    manual audit is confirmed (`auditCleared`), posts are private and reported
    as such.
- `ClipHosting`: `PresignedUrlClipHosting` (vendor-neutral presign endpoint).
  Instagram, Facebook and TikTok need a public HTTPS URL; without a presign
  endpoint, publishing to them fails up front.
- Sandbox credentials live in `ConnectorConfigStore` (Settings → Connections).
  A connector reports `isConfigured() = false` until its fields exist, so the
  UI never offers a platform that cannot work.

## Native modules

| Module | Platform | What it does |
| --- | --- | --- |
| `MWDATBridge` (`ios/Clipso/MWDATBridge.swift`) | iOS, Swift | Owns the glasses: registration, camera permission, MockDeviceKit pairing, one session and `.hvc1` 30 fps stream shared by preview and recording, the health watchdog and stall recovery, the `.high`/`.medium` choice, and the HEVC preview decoder. Emits `MWDATSegment`, `MWDATError`, `MWDATStreamState`, `MWDATRegistrationState`, `MWDATDevices`, `MWDATPreviewFrame` and `MWDATStreamHealth`. |
| `MWDATSegmentWriter` (same folder) | iOS, Swift | Writes the stream into keyframe-aligned MP4 segments (HEVC passthrough + phone-mic AAC), keeping the glasses' frame timing. Also holds `DiagnosticLog`, which mirrors native logs to `Documents/clipso-diagnostics.log`. |
| `ClipStitcher` | iOS ObjC / Android Kotlin | Joins segment MP4s into one clip (passthrough `AVMutableComposition` export, H.264 transcode only when segment formats differ; `MediaMuxer` remux on Android), trims the end for wake-word clips, writes a poster JPEG. |
| `SpeechWakeWord` | iOS ObjC / Android Kotlin | iOS: transcribes each finished segment (level-boosted copy, on-device then one server retry) and returns per-word end times. Android: continuous mic recognition that emits transcript events. |
| `CaptionEngine` | iOS ObjC | On-device transcription and the single caption/edit export described above. No Android counterpart; Android uses the HTTP service. |
| `ClimaxEngine` | iOS ObjC | Audio features (RMS, spectral flux, zero-crossing rate, onset peaks via vDSP) and visual features (frame difference, histogram scene change) on one 20 Hz grid. |
| `LiveActivityBridge` + `ClipsoWidgets` extension | iOS, Swift | The Lock Screen / Dynamic Island "LIVE" activity. Best-effort: ActivityKit only allows a start from the foreground. |

`AppDelegate` releases the glasses on terminate (otherwise the glasses keep the
capture slot until power-cycled), keeps an armed session through backgrounding
while releasing preview-only ones, and forwards the Meta AI callback URL.

## Dev-only stand-ins

These are gated on `__DEV__` and do nothing in a release build:

- **MockDeviceKit glasses**: a Debug build in the Simulator pairs them
  automatically on the Connect screen (`MWDATBridge.mockEnable`). They stream the
  bundled `ios/Clipso/MockFeed.mp4`.
- **`MockCaptioningProvider`**, the **mock publish target** and
  **`MockClipHosting`** (used only by the mock target).
- **Test render** (Settings): runs the on-device caption pipeline on
  `MockFeed.mp4`.
- **Pro**: Debug builds are always Pro (`EntitlementStore`), because captioning
  is Pro-gated and a free dev build would never create a caption job.

Not dev-gated, but placeholders: the Paywall's "Dev unlock" and Settings' "Dev:
clear entitlement" stand in for StoreKit / Play Billing, which has not landed.

## Tests

`app/__tests__/` runs under Jest (`npm test`). The capture loop, ring buffer,
clip store, caption queue, caption timing, hook scoring and publishing are
tested with fakes of the native modules. Native code has no XCTest target.
`server/captioning` has stdlib-only unit tests (`python3 -m unittest`).
