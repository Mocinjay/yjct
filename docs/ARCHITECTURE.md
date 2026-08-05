# Architecture — Phase 1

```
┌────────────────────────────────────────────────────────────┐
│                     CaptureController                       │
│  orchestrates: source → segments → ring buffer → clip      │
└──────┬──────────────────┬─────────────────────┬────────────┘
       │                  │                     │
┌──────▼───────┐  ┌───────▼────────┐  ┌─────────▼──────────┐
│ DeviceVideo  │  │ WakeWord       │  │ SegmentRingBuffer  │
│ Source       │  │ Provider       │  │ (pure TS, tested)  │
│  • Mock      │  │  • Speech      │  └─────────┬──────────┘
│  • MWDAT ⛔  │  │  • Mock (tap)  │            │ flush(N s)
└──────────────┘  └────────────────┘  ┌─────────▼──────────┐
                                      │ ClipStitcher       │
                                      │ (native: AVFounda- │
                                      │ tion / MediaMuxer) │
                                      └─────────┬──────────┘
                                      ┌─────────▼──────────┐
                                      │ ClipStore (library)│
                                      │ index.json + files │
                                      └────────────────────┘
```

## Key decisions

**Segmented rolling buffer.** The source records fixed-length segments (default 5s) back-to-back. The ring buffer keeps just enough segments to cover the configured window (30–90s) and deletes evicted files immediately. On trigger, the in-flight segment is finalized, the covering segments are stitched natively into one MP4, and a thumbnail is generated. Rationale: works identically for the mock (phone camera) and future MWDAT stream, keeps memory flat, and survives app suspension better than an in-memory frame buffer.

**`DeviceVideoSource` interface.** `MockDeviceSource` drives `react-native-vision-camera` on the phone. `MWDATSource` is a typed stub that throws until the Meta Wearables Device Access Toolkit native bridge lands — no code path pretends glasses exist. Swapping sources is a Settings toggle.

**Wake word is our problem, not Meta's.** There is no third-party "Hey Meta" hook. `SpeechWakeWord` runs the OS's own speech recognition on-device — keyless, no vendor SDK — and `phraseMatch.ts` scores the transcript for "Clypso" and its common mis-hearings ("clip so", "clips o"). Detection trails the spoken word by up to one segment; the look-back window still contains the moment. `MockWakeWord` exposes a manual trigger button so the loop is testable with no microphone.

**Battery honesty.** Armed mode holds an open camera+mic session continuously. Onboarding states this before the user ever arms it.

## Phase 2 (implemented mock-first; credentials pending)

- `CaptioningProvider`: `(clipFile, {style}) → captionedClipFile`. Pluggable, and the seam is what let captioning move on-device without touching anything above it. Resolution order in `PublishService.getCaptioner()`:
  1. **`OnDeviceCaptioningProvider` (iOS)** — no server, no key, nothing uploaded. Apple's Speech framework transcribes the clip's own audio on-device with per-word timings; `captionTimeline.ts` turns those into timed cues; the `CaptionEngine` native module burns them in with AVFoundation.
  2. **`HttpCaptioningProvider`** — Android, or iOS where the locale has no offline dictation. Talks to `server/captioning`.
  3. **`MockCaptioningProvider`** — dev only. Reports `burnsCaptions: false` so its output is never badged as really captioned.
- **Caption timing lives in TypeScript** (`captionTimeline.ts`), not in the native module: the rules that are easy to get subtly wrong (chunking, per-word highlight spans, the non-overlap clamp, line layout) belong somewhere testable without a device. Native draws what it is told. `server/captioning/captions.py` is the same logic for the Android path, and `captionTimeline.test.ts` asserts the constants match so the two cannot drift silently.
- `CaptionEngine` (iOS): `transcribeClip` windows recognition at 45s with 1s overlap — Speech caps how much audio one request may carry, and clips run to `MAX_CLIP_RECORDING_SECONDS`. It deliberately does **not** reuse `SpeechWakeWord`: that path biases the recognizer toward "Clypso" via `contextualStrings` and falls back to Apple's servers, both wrong for captioning ordinary speech privately. `burnCaptions` composes one container layer per cue with two text layers per word (base + highlight), because a `CATextLayer`'s attributed string is not animatable — the highlight is a second copy faded in over the first.
- `CaptionQueue`: every captured clip is auto-captioned (Pro). One job at a time; progress is persisted **on the clip** (`captionState`) rather than in memory, so the library renders "Captioning…" from data it already reads and `resume()` can re-arm jobs that the app was killed mid-way through. `deliverablePath(clip)` is the single place that decides captioned-vs-raw, so play, share and publish cannot disagree.
- `ClipHosting`: presign-endpoint implementation (`PresignedUrlClipHosting`, vendor-neutral) + mock. IG/TikTok require a public HTTPS URL; a local path is never sufficient.
- `PublishTarget` connectors, one isolated module each (`src/phase2/targets/`):
  - **YouTube Shorts** — direct resumable upload, OAuth injected via `GoogleTokenProvider` (null until a Google OAuth client exists; needs Google API verification before release).
  - **Instagram Reels** — Graph API container flow (`media_type=REELS` → poll `status_code` → `media_publish`). Needs Business/Creator account + Meta App Review.
  - **Facebook** — `/{page-id}/videos` with `file_url`. Same Meta app, SAME App Review submission as Instagram (bundled, never filed separately).
  - **TikTok** — Content Posting API Direct Post (PULL_FROM_URL). Consent dialog gates every publish; until the manual audit is confirmed in writing (`auditCleared` flag), status reports posts as private — because the platform forces them private.
- `PublishService` pipeline: caption (Pro — reuses the auto-captioned cut when there is one instead of re-transcribing) → host (if the target requires it) → `uploadAndPublish` → status polling with requested-vs-actual visibility surfaced honestly.
- Sandbox/dev credentials live in `ConnectorConfigStore` (Settings → Connections); each connector reports `isConfigured()=false` until its fields exist, so the UI never pretends a platform works.

## Native modules

- `ClipStitcher` (iOS Swift / Android Kotlin): concatenates segment MP4s losslessly (`AVMutableComposition` / `MediaMuxer` track copy), writes the clip, and emits a poster-frame JPEG thumbnail.
- `CaptionEngine` (iOS, ObjC): on-device transcription (`Speech`) and rendering (`AVMutableComposition` + `AVAssetExportSession`, with `AVVideoCompositionCoreAnimationTool` only when there are captions to draw). No Android counterpart — that platform uses the HTTP service.
- `ClimaxEngine` (iOS, ObjC): audio features via Accelerate/vDSP (RMS, spectral flux, ZCR, onset peaks) and visual features via `AVAssetReader` (frame difference, histogram scene change), resampled onto one 20 Hz grid.

## Climax-first edit (Pro, iOS)

Rebuilds a clip as `[best 3-7s] -> [0.5s black] -> [complete original]`. Ported
on-device from `server/climax/`, which stays as the reference implementation.

- **Scoring is TypeScript** (`climaxScoring.ts`) — the same reasoning as the
  caption timing: it is arithmetic, and arithmetic belongs where it can be
  tested. `export_parity_fixture.py` dumps the Python scorer's output for a
  synthetic grid and `climaxScoring.test.ts` asserts agreement across every
  candidate window, so the two cannot drift silently.
- **Extraction is native**, and produces 6 of the reference's 7 signals.
  `visual.flow` (sparse Lucas-Kanade there) is skipped: dense optical flow on
  device is hundreds of GPU passes per clip for one signal. An absent signal is
  treated as absent rather than zero — the same redistribution the speech
  weight already used — which also covers video-only glasses capture, where
  there is no audio modality at all.
- **One export does both** the restructure and the caption burn. Cutting first
  and captioning after would cost two encode generations, and captions laid out
  on the chronological timeline would open the hook mid-phrase.
- **The black beat needs its own instruction.** An empty range in the
  composition is not enough: with no frames to composite the renderer holds the
  previous one, so the gap came out as a frozen frame. An instruction carrying
  no layer instructions paints its `backgroundColor`, which is what actually
  produces black.
