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

## Phase 2 seams (interfaces only — no implementations in Phase 1)

- `CaptioningProvider`: `(clipFile) → captionedClipFile`. Pluggable; the interface is the deliverable, never a hardcoded vendor.
- `PublishTarget`: `authenticate()`, `uploadAndPublish(clip, caption, privacy)`, `checkStatus()`. One isolated module per platform. TikTok additionally requires a per-clip preview + explicit consent step before anything leaves the device, and must surface *actual* post visibility (private during audit) back to the UI.

## Native modules

- `ClipStitcher` (iOS Swift / Android Kotlin): concatenates segment MP4s losslessly (`AVMutableComposition` / `MediaMuxer` track copy), writes the clip, and emits a poster-frame JPEG thumbnail.
