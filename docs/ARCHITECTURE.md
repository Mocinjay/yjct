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
│  • Mock      │  │  • Porcupine   │  └─────────┬──────────┘
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

**Wake word is our problem, not Meta's.** There is no third-party "Hey Meta" hook. `PorcupineWakeWord` runs Picovoice Porcupine fully on-device against the app's own mic stream (low latency, low battery). `MockWakeWord` exposes a manual trigger button so the loop is testable with no Picovoice key.

**Battery honesty.** Armed mode holds an open camera+mic session continuously. Onboarding states this before the user ever arms it.

## Phase 2 (implemented mock-first; credentials pending)

- `CaptioningProvider`: `(clipFile) → captionedClipFile`. Pluggable; the interface is the deliverable — real captioning is external infra. `MockCaptioningProvider` exercises the pipeline.
- `ClipHosting`: presign-endpoint implementation (`PresignedUrlClipHosting`, vendor-neutral) + mock. IG/TikTok require a public HTTPS URL; a local path is never sufficient.
- `PublishTarget` connectors, one isolated module each (`src/phase2/targets/`):
  - **YouTube Shorts** — direct resumable upload, OAuth injected via `GoogleTokenProvider` (null until a Google OAuth client exists; needs Google API verification before release).
  - **Instagram Reels** — Graph API container flow (`media_type=REELS` → poll `status_code` → `media_publish`). Needs Business/Creator account + Meta App Review.
  - **Facebook** — `/{page-id}/videos` with `file_url`. Same Meta app, SAME App Review submission as Instagram (bundled, never filed separately).
  - **TikTok** — Content Posting API Direct Post (PULL_FROM_URL). Consent dialog gates every publish; until the manual audit is confirmed in writing (`auditCleared` flag), status reports posts as private — because the platform forces them private.
- `PublishService` pipeline: caption (Pro) → host (if the target requires it) → `uploadAndPublish` → status polling with requested-vs-actual visibility surfaced honestly.
- Sandbox/dev credentials live in `ConnectorConfigStore` (Settings → Connections); each connector reports `isConfigured()=false` until its fields exist, so the UI never pretends a platform works.

## Native modules

- `ClipStitcher` (iOS Swift / Android Kotlin): concatenates segment MP4s losslessly (`AVMutableComposition` / `MediaMuxer` track copy), writes the clip, and emits a poster-frame JPEG thumbnail.
