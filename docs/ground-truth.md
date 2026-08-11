# Ground truth — Phase 0

Answers to G1–G10, established by reading the tree at
`refactor/clypso-architecture` (`5e25bfb` + uncommitted path-B work). Every row is
either a file:line reference or an explicit "unmeasured". Nothing here was
inferred from a work-item description.

Paths are relative to `app/` unless noted.

## Repository state at the time of this audit

- Branch `refactor/clypso-architecture`, HEAD `5e25bfb`.
- **14 modified files and the entire path-B implementation are uncommitted**:
  `src/markers/` (3 files), `modules/clip-stitcher/ios/GlassesMediaLibrary.m`,
  `MicSegmentRecorder.{h,m}`, plus `__tests__/markerMatching.test.ts` and
  `__tests__/GlassesImportController.test.ts`. Everything below describes the
  working tree, not `HEAD`.
- Local checkout moved from `~/Desktop/jarvis` to `~/Desktop/clypso`.

## Table

| # | Question | Answer | Evidence |
|---|---|---|---|
| G1 | Which `VideoCodec` does `StreamConfiguration` request? Does the writer mux or re-encode? | **`.raw`**, and the writer **re-encodes** — H.264 High from decoded `CVPixelBuffer`s. `.hvc1` was tried and abandoned. | `ios/Clypso/MWDATBridge.swift:632`; codec choice rationale `:614–631`; encoder settings `ios/Clypso/MWDATSegmentWriter.swift:639`; the writer's own diagnostic `"…segment writer encodes raw frames. Set the stream's videoCodec to .raw."` at `MWDATSegmentWriter.swift:618` |
| G2 | If `.hvc1` is available, what keyframe interval does the sender use? | **Unanswerable without implementing `.hvc1` capture.** No `.hvc1` sample has ever been written to a file, so no GOP has ever been observed. See the G1/G2 note below — the premise of W8 is materially different from what W8 assumes. | — |
| G3 | Does the caption-burn composition set colour tags? What happens to an HLG asset? | **No colour tags anywhere.** The composition is built with the bare `[AVMutableVideoComposition videoComposition]` initialiser — no `colorPrimaries`, no `colorTransferFunction`, no `colorYCbCrMatrix`. Export preset is `AVAssetExportPresetHighestQuality`, which is H.264/AAC and cannot carry HLG. What an HLG master actually looks like afterwards is **unmeasured** — no path-B asset has been through the burn on device. | `modules/clip-stitcher/ios/CaptionEngine.m:519–523`, `:545–555`. `renderSize` is the source's natural size (`:440–442`), so a 1520×2032 master stays 1520×2032 |
| G4 | `AVAudioSession` category/options in `MicSegmentRecorder`? Bluetooth? `preferredInput`? | **Already correct.** Category `.record`, mode `.default`, options `mixWithOthers` only. **No Bluetooth option is set** — deliberately, with the HFP/link-renegotiation reasoning written down. `preferredInput` **is** pinned to `AVAudioSessionPortBuiltInMic`. Interruption and route-change observers both exist. | `modules/clip-stitcher/ios/MicSegmentRecorder.m:193–226`; observers `:467–472`; interruption handler `:482–500`; route-change handler `:503–506` |
| G5 | Wake-word false-positive / false-negative rate on real worn audio? | **Unmeasured.** There is no corpus, no harness, and no `tools/measure/` directory in the repo. `__tests__/phraseMatch.test.ts` tests the regexes against hand-written strings, which says nothing about recogniser behaviour on worn audio. | absence of `tools/`; `__tests__/phraseMatch.test.ts` |
| G6 | Which transport and resolution rung do real sessions negotiate? | **Not instrumented.** The only rung-adjacent evidence in the whole app is a per-segment log line of the *delivered* format; transport is never queried, never logged, and there is no aggregation anywhere. No field distribution exists. | request site `MWDATBridge.swift:632–633`; delivered-format logs `MWDATSegmentWriter.swift:606` and `:653` |
| G7 | Marker after end-of-recording — anchored to the marker, or clamped to file end? | **Anchored to the file end, correctly, already.** `endSec = min(offset + leadOut, durationSec)` then `startSec = max(endSec - lookback, 0)`. A marker 15 s past the end of a recording yields the **full** lookback window ending at the file end, not a 5 s stub. **This contradicts W3's first bullet.** | `src/markers/markerMatching.ts:149–150` |
| G8 | Marker lifetime, and is it coupled to clip expiry? | **7 days, and already decoupled.** `MarkerStore` owns its own `DEFAULT_RETENTION_MS = 7 days`, applied on `add()` and `all()`. Free-tier clip expiry is a separate `FREE_RETENTION_HOURS = 24`, used only when building a `Clip`. The two never reference each other. W3's "decouple" is already true; only the duration is short of the 30 days W3 asks for. | `src/markers/MarkerStore.ts:19`, `:66`, `:74`; `src/config.ts:27`; use site `src/markers/GlassesImportController.ts:294` |
| G9 | Is `PHAuthorizationStatus.limited` detected, and does it gate the toggle? | **Detected, not gating.** Native returns `usable = (status == Authorized)`, so `.limited` is correctly reported as unusable, and `GlassesImportController.start()` throws an `AppError` with the right user message. But **the toggle is not gated**: `SettingsScreen` writes `glassesLibraryImport: true` unconditionally, `App.tsx` calls `syncWithSettings()` from a `.catch(log.error)`, and nothing writes the setting back. The switch stays on, the app is not listening, and the UI does not say so. There is also no re-check for a downgrade made in Settings later. | native `modules/clip-stitcher/ios/GlassesMediaLibrary.m:140–159`; throw site `src/markers/GlassesImportController.ts:67–79`; ungated toggle `src/ui/screens/SettingsScreen.tsx:166–177`; swallowed failure `App.tsx:97–108` |
| G10 | MWDAT version pinned? | **0.8.0, `exactVersion`**, from `github.com/facebook/meta-wearables-dat-ios`. 0.9 (DAM-only) is not adopted. | `ios/Clypso.xcodeproj/project.pbxproj:757–761` |

## Findings that contradict a work item's premise

Three, reported rather than implemented around.

### 1. W3's marker-after-end bullet is already done (G7)

W3 asks to change the anchoring to `end = min(marker, video.end); start = end - lookback`.
That is character-for-character what `clipRangeForMarker` already computes, and the
comment above it states the reaction case explicitly. The worked example in W3 — 15 s
grace-after, 20 s lookback, "yields only the last 5 s" — does not describe this code;
it describes an implementation that anchors `start` to the marker rather than to the
clamped end. There is no such code path. `GlassesImportController` calls
`clipRangesForVideo`, which calls this function, and there is no second range
calculation anywhere.

**The other two W3 bullets stand.** `coalesceMarkers` does keep the earlier marker and
discard the later one (`markerMatching.ts:109–123`), so union-clamped-to-tier is a real
change. And marker retention is 7 days where W3 wants ≥30 — a one-constant change, but
a real one, and `GlassesImportController` never passes a retention override so the
default is what ships.

### 2. W4's cumulative-drift mechanism is not what the code does

W4's premise is that a per-segment A/V duration mismatch accumulates across a 60–90 s
window. Reading `ClipStitcher.m:114–180`: `take = asset.duration` (the **max** of the
two track durations), the *same* `CMTimeRange` is handed to both the video insert
(`:140`) and the audio insert (`:174`), and — critically — `cursor` advances by `take`
for both tracks (`:180`).

Because `cursor` is shared, every segment is re-anchored to the correct wall position at
its own boundary. A mismatch therefore does **not** accumulate. What it produces instead
is a **gap of the mismatch size at each segment boundary**, in whichever track is
shorter, with the next segment landing back on time. Twelve segments with a 40 ms
mismatch is twelve 40 ms holes, not 480 ms of drift.

That is still a real defect and still worth fixing, and the fix is close to what W4
proposes — but it is `take` that is wrong, not just the audio range. Clamping only the
audio range to the video duration fixes the audio-longer case and does nothing for the
video-longer case, which is the one this pipeline is more likely to hit: audio is
host-clock stamped and video is PTS-stamped, and the PTS upper clamp was removed
precisely so real gaps stay honest.

I have not measured this. W4's synthetic-fixture test is the right instrument to settle
it, and it should assert **gap position and size**, not only cumulative drift at 30/60/90 s
— a test that only measures end-to-end drift will pass on this code while the glitches
are still there.

### 3. W8's `.hvc1` premise is right about the cost and wrong about the obstacle (G1, G2)

W8 correctly identifies three generations of loss on path A. But the reason the writer
consumes `.raw` is not that nobody tried `.hvc1` — it is that `.hvc1` was tried on device
and the SDK hands back frames with a `dataBuffer` and **no `imageBuffer`**
(`MWDATBridge.swift:614–619`, recording `imageBuffer=false makeUIImage=NIL`).

That does not kill W8 — muxing compressed samples is exactly what you do with a
`dataBuffer`, and it is the right idea. But it surfaces a cost W8 does not account for:
**`GlassesPreview` also loses its frames.** `MWDATPreviewEncoder` needs an uncompressed
buffer (`MWDATPreviewEncoder.swift:131`), so switching the stream to `.hvc1` blacks out
the live viewfinder unless a decode path is added back for preview only — at which point
some of the CPU saving goes away. Any W8 estimate has to include that.

G2 cannot be answered before this is built, so W8 cannot be costed yet: the cut-precision
trade-off depends on a GOP cadence that has never been observed.

## Things worth knowing that Phase 0 did not ask about

- **W2's Live Activity already exists.** `ios/Clypso/LiveActivityBridge.swift` (181 lines)
  with `isSupported` / `start` / `update` / `end`, and `ClypsoActivityAttributes.swift`
  is shared between targets. W2's remaining work is the audio-route hardening (already
  done, per G4), the interruption *test*, and wiring the Live Activity to path-B armed
  state — not building it.
- **W10's 1080×1920 canvas is a path-A-only change.** `renderSize` follows the source's
  natural size, so path A renders 720×1280 and path B renders 1520×2032. Forcing
  1080×1920 would *downscale* every path-B clip.
- **W14's "hard AND" is confirmed**: `GMLIsGlassesAsset` requires the model string to
  contain both `"Meta"` and `"Glasses"`, with copyright `"Meta AI"` as the only fallback
  (`GlassesMediaLibrary.m:75–77`, `:199–216`). Two string constants own the entire path-B
  feature.
- **Path B is not gated on Pro** and its lookback is a hard-coded 20 s
  (`src/services/glassesImport.ts:21`), independent of the rolling-buffer tier. W3's
  "clamp to tier length" has nothing to clamp against on this path today.

## What I am less sure about than when I started

- Whether the `.limited` gap (G9) is actually reachable in the product — the toggle can
  be turned on, but I have not run it, and it is possible some flow re-prompts. The code
  path says no.
- Whether G3's HLG asset is tone-mapped or something worse. `AVAssetExportPresetHighestQuality`
  on an untagged composition over an HLG source is behaviour I am asserting from API
  semantics, not from a file. W6 must measure it before anything is built on top.
- Whether the ClipStitcher gap analysis (finding 2) survives contact with
  `insertTimeRange`'s real clamping behaviour. I read the code; I did not run it.
