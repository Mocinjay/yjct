# Maximum resolution

Clipso's goal is that every clip is the best footage the glasses can record: **1520x2032 HEVC in HLG HDR, from the glasses' own camera recording**, not the 720x1280 the live stream carries. Everything below serves that goal; the live stream is the fallback and the instant preview, never the target.

## Why the live stream cannot get there

- The Meta Wearables Device Access Toolkit (MWDAT) streams at most **720x1280**. `StreamingResolution` has three cases and `.high` is 720x1280; `MWDATBridge` already asks for it. There is no higher setting, flag or private API.
- The glasses' Wi-Fi link (paid Apple team entitlements) makes `.high` *reachable* instead of falling back to 504x896. It does not raise the ceiling.
- `.hvc1` passthrough removes the phone's re-encode, so a live clip loses nothing between the glasses and the file. It changes the codec, not the resolution.
- The glasses write **1520x2032 HEVC, HLG colour, their own microphones** to their storage: about 3.4x the pixels. No toolkit API reaches that file. Meta AI syncs it into the iPhone's photo library like any camera would, and that is where Clipso picks it up. Nothing is jailbroken or bypassed: it is the user's own video, read with Photos access they grant.

## How it works

```
"Clipso" (or the Clip / Mark button)
   │
   ├─▶ marker: the moment's wall-clock span (+ the 720p clip's id in live mode)   MarkerStore, persisted first
   │
   ├─▶ live mode only: 720p clip cut from the rolling buffer, shown at once       CaptureController
   │
   ⋮   … the glasses' own recording syncs to Photos (minutes to hours later) …
   │
   └─▶ GlassesImportController: match markers to the recording, copy the original once,
       cut each span by passthrough (ClipStitcher.extractRange), then
         • the cut covers the 720p clip's span  → replace that clip in place (same id, name, saved state)
         • no 720p clip / it is gone             → add a new full-resolution clip
         • the recording started too late        → add the cut beside the 720p clip ("· full res")
       and queue captioning (the HDR-aware burn keeps 10-bit HLG).
```

### Capture modes (Settings → Full resolution)

| | Live (default) | Glasses only |
|---|---|---|
| Stream from the glasses | yes, 720x1280 at best | no |
| Clip when "Clipso" is heard | 720p clip at once from the rolling buffer | none yet; the moment is marked |
| Full resolution | replaces the 720p clip if the glasses were recording that moment too | always, from the recording the wearer made on the glasses |
| Who hears "Clipso" | speech recognition on the stream segments' audio | the phone microphone (`MicSegmentRecorder`) |
| What the wearer does | arm and talk | start a video on the glasses (button or "Hey Meta"), then say "Clipso" |

Live mode always produces a clip and upgrades it when it can. Glasses-only mode is for wearers who record on the glasses anyway: nothing streams, the glasses' battery is spared, and every clip arrives at full resolution.

### The rules that make the swap safe

- **Marker first.** `CaptureController` writes the marker before it stitches the 720p clip. A failed stitch loses the instant clip; a lost marker would lose the full-resolution cut for good.
- **Wall clock is the join.** Live segments carry the wall-clock time they opened; microphone segments carry the time of their first sample; the recording carries its QuickTime creation date. A marker belongs to a recording if it ends within 2 s before to 15 s after it (the trigger is a reaction, often said after recording stopped).
- **Replace only what is covered.** A cut replaces its 720p clip only when it spans that clip within 1.5 s at each end (`MASTER_COVERAGE_TOLERANCE_SECONDS`, for keyframe placement and clock skew). Otherwise both are kept, so no footage the wearer already has disappears.
- **Captions follow the file.** Replacing a clip resets its captions; a caption render that finishes on the old 720p file is discarded and redone on the new one (`CaptionQueue`).
- **Never re-encode the master.** The original is copied with `PHAssetResourceManager`, cut by passthrough (HEVC preset as the fallback, H.264 only if both fail), and the caption burn composites in the source's BT.2020/HLG colour space and exports HEVC.
- **Only marked footage is touched.** Photos is filtered by marker time before anything is opened; a recording nobody marked is never opened, copied or changed. Clipso never writes to the photo library.
- **Markers wait 30 days.** Syncs happen when Meta AI gets to them.

### Requirements

- Full Photos access ("All Photos"). "Selected Photos" never contains Meta AI's syncs, so the import cannot see them; Settings says so.
- Meta AI set to save the glasses' media to the iPhone's photo library.
- Microphone and speech recognition (both modes), Bluetooth and the Meta AI registration (live mode).

## Code map

| Piece | Where |
|---|---|
| Marker model, matching, coverage | `src/markers/markerMatching.ts` |
| Marker persistence | `src/markers/MarkerStore.ts` |
| Import pass and swap | `src/markers/GlassesImportController.ts` |
| Import lifecycle (setting, Photos access, foreground, new markers) | `src/services/glassesImport.ts` |
| Live markers | `CaptureController.markMoment` |
| Glasses-only listening | `src/core/ListeningController.ts`, `SpeechWakeWord({ ownMicrophone: true })`, `MicSegmentRecorder.m` |
| In-place replacement | `ClipStore.replaceWithMaster` |
| Photos access, recognition, original copy | `modules/clip-stitcher/ios/GlassesMediaLibrary.m` |
| Passthrough cut | `ClipStitcher.m` `extractRange` |
| HDR-preserving caption burn | `CaptionEngine.m` (colour tagging, HEVC preset, read-back) |
| Stream-during-recording probe | `MWDATStreamTimeline` (MWDATBridge.swift) + `src/markers/streamConcurrency.ts` |

## Verifying on a device

Pull the log after a worn session:

```bash
xcrun devicectl device copy from --device <UDID> --domain-type appDataContainer \
  --domain-identifier <bundle id> --source Documents/clipso-diagnostics.log --destination /tmp/
```

1. **Glasses only** (Settings → Full resolution → Glasses only). Start a video on the glasses, say "Clipso" during it, stop, let Meta AI sync, open Clipso.
2. **Live**: arm, start a video on the glasses as well, say "Clipso", stop, let Meta AI sync, open Clipso. The 720p clip should turn into a full-resolution one (Library card shows FULL RES).

Read, in order:

```bash
grep "marker recorded"            /tmp/clipso-diagnostics.log   # the trigger was written down
grep "import pass"                /tmp/clipso-diagnostics.log   # pendingMarkers / recentVideos / candidates
grep "NOT glasses footage"        /tmp/clipso-diagnostics.log   # identity test failed: shows the metadata it saw
grep "marker alignment"           /tmp/clipso-diagnostics.log   # where each marker landed; clock skew
grep -E "extracting|cut by"       /tmp/clipso-diagnostics.log   # "cut by passthrough - WROTE …: 1520x2032 hevc HDR"
grep -E "upgraded clip|added full-resolution clip" /tmp/clipso-diagnostics.log
grep -E "burn:|burned|WARNING"    /tmp/clipso-diagnostics.log   # HDR through the caption burn (Pro)
grep "concurrency probe"          /tmp/clipso-diagnostics.log   # live mode: did the stream survive?
```

- `candidates: 0` with markers pending: the recording has not synced, Photos access is limited, or Meta AI is not saving to Photos.
- `NOT glasses footage`: the model/copyright strings in the line say which literal in `GMLIsGlassesAsset` to widen.
- Anything other than `cut by passthrough`: the master was re-encoded; the `WROTE` line says what came out.

## Open questions

1. **Can the stream survive a native recording?** The concurrency probe scores it per recording: `concurrent`, `degraded`, `exclusive` or `no-evidence`. If `exclusive`, live mode cannot have a 720p clip and a full-resolution recording of the same moment, and glasses-only mode is the way to full resolution. Record the verdict here.
2. **Clock skew between phone and glasses.** `marker alignment` gives where the trigger landed; play the clip to see where the word actually is.
3. **Sync latency.** How long Meta AI takes to put a recording in Photos sets how soon the full-resolution clip appears.
4. **HDR through captions on real footage.** Compare `inRate` and `outRate`, check `transfer=` survived, and look at the captions.
