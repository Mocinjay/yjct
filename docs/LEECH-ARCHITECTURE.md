# The leech architecture

Status: 2026-09-04. Design contract for the revamp that removes the phone
viewfinder, makes the library the app, and reduces capture to a single Arm
button. Every claim below carries a `file:line` or is marked **unmeasured**.

Read `docs/OPEN-WORK.md` first. This document supersedes the framing of O5 and
O7 — see §9 — but does not close them.

---

## 1. What the revamp is

Today the app is a camera that happens to keep a library. After this it is a
library that happens to hold a microphone.

- **No viewfinder.** The phone stops being a screen you look at. `GlassesPreview`
  and the preview half of `ArmedScreen` go.
- **Library is the root.** `Library` becomes the landing route; `Armed` stops
  being a destination and becomes a state the library is in.
- **One control.** Arm. It attaches to the glasses, listens continuously for
  "clypso", and produces clips. Disarm ends it. There is nothing else to press.
- **Continuous.** Arming is not a recording. It is a lease held for hours,
  across backgrounding, until explicitly released.
- **Highest quality available, not the quality that is convenient.** This is the
  constraint that shapes everything else, and §2 is why.

---

## 2. The constraint: 720x1280 is a wall, not a setting

The live MWDAT stream cannot exceed **720x1280**. This is the whole enum, not a
misconfiguration:

```swift
public enum StreamingResolution : Sendable, CaseIterable {
  case high     // 720x1280
  case medium   // 504x896
  case low
}
```
`MWDATCamera.xcframework/…/arm64-apple-ios.swiftinterface:271-287`

Three independent confirmations:

- SDK `CHANGELOG.md:174` — "High resolution (720x1280) video can now be
  requested."
- SDK `CHANGELOG.md:251` — "Updated `StreamingResolution.Medium` from 540x960 to
  504x896", matching exactly the `504x896` / `720x1280` rung pair the writer
  already tallies (O7).
- `MWDATBridge.swift:785` **already requests `.high`**, and the ABR ladder only
  ever steps down from the requested rung (`:777-782`).

Two apparent escape hatches that are not:

- **Wi-Fi transport** (SDK `CHANGELOG.md:54`, added 0.8.0) does not raise the
  ceiling. It makes `.high` *reachable* instead of the link dragging down to
  `.medium`. Best case remains 720x1280.
- **`.hvc1`** (O5) is a codec change. It removes the decode-and-re-encode
  generation loss, which is a real gain, but resolution stays 720x1280.

Meanwhile the glasses record **1520x2032 HDR** to their own storage
(`types.ts:88-99`). That is **3.4x the pixels** and a wider gamut than anything
the Bluetooth link will ever carry.

So "highest quality possible" and "the app streams the video" are mutually
exclusive. The native recording is the only good master that exists, and the
only route to it is the photo library after Meta AI syncs — which is Path B, and
which is already largely built (`services/glassesImport.ts`,
`markers/GlassesImportController.ts`, `markers/markerMatching.ts`,
`GlassesMediaLibrary.m`).

**The chosen design is therefore Hybrid:** Path A supplies immediacy, Path B
supplies the master, and the proxy is replaced by the master when it lands. The
720p artefact is a receipt, never the delivered clip.

---

## 3. Two gating unknowns

Hybrid requires both paths to be alive at the same moment. **No code should be
written against §5 until §4 answers U1.**

U2 is closed — it turned out not to be gated on U1 at all, because the collision
it describes stopped being hypothetical the moment Path B started defaulting on.
It is resolved below in a way that deliberately assumes nothing about U1's
verdict.

### U1 — Can the live stream survive while the glasses record natively?

A previous session anticipated exactly this question and built the instrument,
then never ran it. `markers/streamConcurrency.ts:1-11`:

> "It answers whether Path A and Path B can produce footage for the same moment,
> which decides whether a proxy-to-master swap is a feature or an impossibility."

The instrument is complete and wired: `MWDATStreamTimeline.swift` collects link
telemetry, `MWDATNative.getStreamTimeline()` exposes it,
`concurrencyVerdict()` scores it (`streamConcurrency.ts:61-115`), and
`GlassesImportController.probeConcurrency()` runs it on every Path B import
(`:287-305`). It is not behind a config flag — it is always on — and it is
observational only, so it cannot fail an import (`:279-286`).

It scores one of four outcomes (`streamConcurrency.ts:26-34`):

| Outcome | Meaning | Consequence for Hybrid |
|---|---|---|
| `concurrent` | frames kept arriving above 15fps throughout | Hybrid works as designed |
| `degraded` | frames thinned but never stopped | Hybrid works; proxy quality is unreliable |
| `exclusive` | frames stopped, stalled or errored inside the window | **Hybrid is impossible** |
| `no-evidence` | nothing was watching | inconclusive, re-run |

The question must be answered backwards, because the glasses never tell the
phone that a native recording began (`:281-283`). The file turns up later
carrying its own capture time, and the link telemetry from that window is the
only evidence.

**Unmeasured.** `grep` across `docs/` finds no recorded verdict.

### U2 — One microphone, two claimants — **RESOLVED**

`glassesImport.ts` constructs its wake word as
`new SpeechWakeWord({ ownMicrophone: true })`, and the comment there stated the
invariant precisely: Path B owned the mic *because* Path A was not running.

That stopped being true before Hybrid ever arrived. `glassesLibraryImport` began
defaulting on (`6f44a26`), so Path B now runs for everyone — including everyone
who also opens the Armed screen. Two `AVAudioEngine` input taps on the one
`AVAudioSession` a process gets is not sharing; it is a fight, and a silent one,
because both halves are written to survive losing the input. Each restarts, each
restart is itself a configuration change the other one sees, and
`MicSegmentRecorder` additionally called `setActive:NO` on every teardown —
pulling the session out from under `MWDATSegmentWriter` for a reason nothing in
the writer's own logs could explain.

**Resolved: `live-capture` holds it, `marker-listening` stands down.**
`src/core/microphone.ts` is the arbiter; `CaptureController.arm()` claims it and
`disarm()` releases it; `GlassesImportController.suspendListening()` /
`resumeListening()` are the yielding half.

The rule turns on which participant can function without a microphone at all,
**not** on which path produces better footage — U1 is still unanswered and this
deliberately does not presuppose it:

- Path A cannot. Its trigger is transcribed from the audio track of the segments
  the writer records (`services/capture.ts` builds `new SpeechWakeWord()` with
  no `ownMicrophone`), so with no microphone there is no trigger, and its clips
  are silent besides.
- Path B can wait. It writes wall-clock times and matches them against
  recordings that turn up minutes or hours later. Only the microphone stands
  down — the library observer, the pending markers and every import pass carry
  on, so nothing already written is stranded. What is lost is a trigger spoken
  *during* an arm, and during an arm Path A is already cutting a clip for that
  same moment off its own trigger.

`acquireExclusive()` resolves only once the other half reports itself closed, so
the capture path no longer reaches the audio session while something else is
still inside its teardown. The Settings screen reads the arbiter and says
"Paused while you're armed" rather than continuing to claim it is listening.

**This changed how U1 has to be measured**, and the change is easy to miss. A
"clypso" spoken while Path A is armed is now heard by Path A, not Path B — no
marker is written, so the native recording never becomes an import candidate and
`probeConcurrency` never runs. §4b carries the corrected sequence: the trigger
has to be spoken after disarming, inside the 15-second `graceAfterSec` window.

Covered by `__tests__/microphone.test.ts` and the listening group in
`__tests__/GlassesImportController.test.ts`.

---

## 4. Phase 0 — two experiments, run them separately

These are different sessions with different setups, and running them together
gets neither. §4a needs Path B alone and answers the quality question. §4b needs
both paths and answers U1. Do 4a first: it is simple, and if it fails there is
nothing for 4b to be a proxy *of*.

Pull the log the same way for both:

```bash
xcrun devicectl device copy from --device <UDID> --domain-type appDataContainer \
  --domain-identifier com.mocinjay.clypso \
  --source Documents/clypso-diagnostics.log --destination /tmp/
```

### 4a — Does a master survive the round trip? (O2)

Path B only. Do **not** open the Armed screen — see §4b for why that changes
what happens.

1. Leave `glassesLibraryImport` on (it defaults on) and grant photos,
   microphone and speech recognition.
2. Wear the glasses. Record natively — capture button or "Hey Meta" — and say
   "clypso" during the recording. Note roughly how far into it you spoke.
3. Let Meta AI sync. Foreground the app.
4. Read four lines, in this order:

```bash
grep "NOT glasses footage"  /tmp/clypso-diagnostics.log   # read this first
grep "extracting "          /tmp/clypso-diagnostics.log
grep -E "WROTE |burn:|burned " /tmp/clypso-diagnostics.log
grep "marker alignment"     /tmp/clypso-diagnostics.log
```

**`NOT glasses footage` first, always.** If it is there, nothing else in this
list will be, and the reason is `GMLIsGlassesAsset` — a hard AND of `Meta` and
`Glasses` in the model string, with copyright `Meta AI` as the only fallback.
The line prints the strings the file actually carried, so it says exactly which
literal to widen. A silent empty log with markers piling up used to be
indistinguishable from "Meta AI never synced" and from "the trigger was never
heard"; it no longer is.

Then, in order:

- **`extracting … hevc HDR transfer=…`** followed by **`cut by passthrough`** —
  the master reached the cutter and was cut without re-encoding. Anything but
  `passthrough` here means it was transcoded, and the `WROTE` line says what
  came out.
- **`WROTE <clip>.mp4: 1520x2032 hevc HDR transfer=… rate=…Mbps`** — what
  landed in the library. Resolution, colour and bit rate of the actual file.
- **`burn:` then `burned …`** (Pro only — captioning is gated on entitlement).
  Compare `inRate=` on the first against `outRate=` on the second, and check
  `transfer=` survived. A `WARNING: an HDR master came out of the burn as SDR`
  is the regression the colour tagging exists to prevent.
- **`marker alignment`** — `offsetSec` is where the trigger landed inside the
  recording. Play the clip: the gap between where "clypso" actually falls and
  the clip's end is the phone-to-glasses clock skew, which `graceBeforeSec = 2`
  has been absorbing without anyone measuring it.

Two failures were worth naming in advance because neither would be a parameter
fix. `tools/measure/hdr` has since put numbers on both, off-device, against a
synthetic file tagged the way the glasses tag theirs — and both came back clean:

- Captions burn through `AVVideoCompositionCoreAnimationTool`, and Core
  Animation is SDR sRGB, so the overlay could have dragged the whole composition
  back to BT.709. It does not — the captioned arm stays `hevc HDR
  ITU_R_2100_HLG`, and caption white lands around 72% of the video range, which
  is HLG diffuse white rather than clipped or crushed. **Still look at the
  captions.** A code value is not a judgement, and this is the one thing in §4a
  that no log line can answer.
- `AVAssetExportPreset*` chooses its own bit rate with no way to ask for one, so
  the burn could have come back correctly tagged and softer than it went in.
  Both HDR arms came back *above* the source rate. Bit rate is scene-dependent,
  so `outRate` against `inRate` is still worth reading on real footage; if it
  ever does land materially under, the answer is moving the burn off presets
  onto `AVAssetWriter` with explicit settings.

`AVAssetExportPresetPassthrough` was confirmed on the same harness to serve an
HLG HEVC cut into an MP4 container, so `cut by passthrough` is the expected
outcome rather than a hopeful one.

**Record what came back in `docs/OPEN-WORK.md` O2.**

### 4b — Can the stream survive a native recording? (U1)

Both paths, and the sequencing matters now in a way it did not when this was
written.

Arming Path A takes the microphone and stands Path B's listening down for the
duration (§3 U2). So a "clypso" spoken while armed is heard by Path A and
written to Path A's buffer — it does not become a Path B marker, the native
recording is never a candidate, `probeConcurrency` never runs, and U1 stays
unmeasured. The marker has to be spoken with the microphone back on Path B.

`markersWithin` accepts a marker up to `graceAfterSec` — **15 seconds** — after
a recording ends, which is the window this depends on:

1. Arm Path A on device with the glasses connected.
2. Record natively on the glasses for a realistic span, several times,
   including one long recording.
3. Stop the native recording, **disarm Path A, and say "clypso" within 15
   seconds.** Path B resumes its microphone on disarm and the marker attaches to
   the recording that just ended.
4. Let Meta AI sync. Foreground the app so `onForeground()` runs.
5. Read the verdicts:

```bash
grep "concurrency probe" /tmp/clypso-diagnostics.log
grep "session rungs"     /tmp/clypso-diagnostics.log
```

The second grep costs nothing extra and closes O7's population question at the
same time — how often `.high` is actually delivered, which determines whether
the proxy is 720x1280 or 504x896 in practice.

**Record the verdict in this file.** The instrument is documented as temporary
(`streamConcurrency.ts:5-7`, `GlassesImportController.probeConcurrency`); it is
deleted only once the answer is written down, not once it is observed.

### Decision

- **`concurrent` or `degraded`** → build §5. On `degraded`, the proxy is best-
  effort and the UI must not promise it.
- **`exclusive`** → Hybrid is dead on this SDK. Fall back to §6.
- **`no-evidence`** → the probe did not overlap a native recording. Re-run.

---

## 5. Target architecture, if U1 permits

### Arming starts both paths

Arm becomes one intent with two subscribers: the MWDAT stream (proxy, rolling
buffer) and the marker recorder (master, deferred). Today these are separate
switches — Path A is a screen you navigate to, Path B is a settings toggle
(`Settings.glassesLibraryImport`, `types.ts:88-99`). After this, Path B stops
being a user-facing setting and becomes half of Arm.

### The trigger writes twice

On a `clypso` match the app must do both, in this order:

1. **Persist the marker first.** `MarkerStore.add()` (`MarkerStore.ts:69-75`) is
   the durable half and the one that survives the app being killed
   (`MarkerStore.ts:26-32`). It must not be contingent on the proxy cut
   succeeding.
2. **Cut the proxy** from the ring buffer and show it immediately.

Ordering matters because the failure modes are asymmetric: a lost proxy costs a
few seconds of feedback, a lost marker costs the master permanently.

### The clip carries provenance

`Clip` (`types.ts:12-49`) has no way to say "this is a proxy awaiting its
master". `sourceKind` (`types.ts:59`) distinguishes `mwdat` from
`glasses-library` but is a fact about origin, not a lifecycle state. Hybrid
needs, at minimum:

- a quality state — `proxy` | `master` | `master-unavailable`
- the marker id(s) that produced the clip, so an arriving master can find the
  proxy it supersedes
- the proxy's path retained until the swap commits, so a failed swap degrades to
  the proxy rather than to nothing

`markerMatching.ts` already returns `Cut.markers` alongside each range
(`:141-146`), so the join key exists — it is simply not persisted today.

### The swap

When `GlassesImportController.sync()` imports a master whose markers match an
existing proxy, it replaces the proxy in place rather than adding a second clip.
The user must not end up with two clips of one moment; that is the failure
`clipRangesForVideo`'s union-merge already avoids within a single recording
(`markerMatching.ts:148-162`), and the same principle applies across paths.

**Captioning interacts here and is easy to get wrong.** A proxy that has already
been captioned (`captionState: 'ready'`, `captionedFilePath`, `types.ts:36-48`)
has its captions burned into 720p pixels. Those cannot be carried over. The swap
must reset caption state and re-enqueue, or the user keeps a 720p burn on a
1520x2032 master. Cheapest correct policy: do not caption proxies at all — only
masters — and accept that captions arrive with the master.

### Continuity and the background

Arming for hours across backgrounding is the part with the least evidence behind
it. Known, already written down, still unresolved: jetsam in the background
skips `applicationWillTerminate`, so the glasses capture slot stays held and the
glasses need a power cycle. Whether MWDAT 0.9.0 keeps streaming backgrounded at
all is unverified. `UIBackgroundModes` already carries `audio` because
`bluetooth-central` alone keeps the process alive but lets iOS kill the mic tap.

Path B is the half that is *designed* for this — it expects to be backgrounded
for the whole useful part of its life (`glassesImport.ts:31-33`) and its markers
are persisted precisely because the app will be killed
(`MarkerStore.ts:29-31`). Path A is not. **If continuity has to be traded, keep
Path B alive and let the proxy lapse** — that ordering follows directly from
§2's quality constraint.

### Live Activity

O3 records that Path B never starts a Live Activity, while Path A wires it
(`ArmedScreen.tsx:142/147/155`). Under Hybrid this stops being a gap and becomes
required: armed state is long-lived, backgrounded, and holds a microphone the
settings screen explicitly warns about (`SettingsScreen.tsx:199-203`). The Lock
Screen is the only honest place to say "still listening". O3 should be absorbed
into this work rather than done separately.

---

## 6. Fallback, if U1 says `exclusive`

Path A is deleted rather than demoted. Arm means listen-and-mark; clips arrive
at 1520x2032 when Meta AI syncs. The library shows a pending-marker affordance
so the user sees the trigger registered even though no video exists yet.

This is a smaller build than §5 — most of it already works — and it satisfies
the quality constraint outright. What it cannot offer is instant feedback, and
the pending-marker UI is doing all the work of making a delay feel intentional.

---

## 7. What gets deleted

Contingent on §4. Listed so the blast radius is visible up front.

- `ui/GlassesPreview.tsx` (163 lines) and its viewer-counting logic
- The preview half of `ArmedScreen.tsx` (503 lines) — the screen becomes a state
- `Armed` as a navigation destination (`ui/navigation.ts:6`, `App.tsx:175-179`)
- `Settings.glassesLibraryImport` as a user-facing toggle (`types.ts:88-99`) and
  its Settings UI — it becomes internal to Arm
- Under §6 only: `device/MWDATSource.ts`, `core/SegmentRingBuffer.ts`,
  `MWDATSegmentWriter.swift`, `MWDATPreviewEncoder.swift` and the rung tallying

`Connect` survives either way — the glasses still have to be paired.

---

## 8. Landmines this revamp must not trip

Carried forward from `docs/OPEN-WORK.md` §"Not open" and `KNOWN-ISSUES.md`.

- **The wake-word vocabulary stays spelled `clipso`.** `wakeword/phraseMatch.ts`
  and `SpeechWakeWord.m` `contextualStrings`. No recogniser has heard "Clypso".
  Touching this while renaming UI copy is the obvious accident.
- **`jarvis://` history stays in `Info.plist`.** `KNOWN-ISSUES.md` rule R7.
- **`GMLIsGlassesAsset` is a deliberate hard AND** of `"Meta"` and `"Glasses"`
  (`GlassesMediaLibrary.m:220-241`). Two string constants own the whole master
  path. Under Hybrid they own the quality guarantee too, so widening or
  loosening them silently downgrades every clip.
- **Bundle id lives in untracked `ios/Config/Signing.xcconfig`**, never the
  pbxproj — `setup.sh` greps for it and fails the build.
- **The widget target is edited only via `scripts/add-widget-target.rb`.** Never
  hand-edit `project.pbxproj`.

---

## 9. Relationship to OPEN-WORK.md

- **O5 (`.hvc1`)** is re-framed, not closed. It was filed as "the real quality
  lever"; §2 shows it is a codec lever, capped at 720x1280 regardless. Under
  Hybrid it improves the *proxy*, which is the disposable half — so its priority
  drops sharply. Under §6 it becomes moot.
- **O7 (rung/transport)** gets its field data for free in §4 step 4, and its
  population question directly sets proxy quality expectations.
- **O3 (Path B Live Activity)** is absorbed into §5, per the reasoning there.
- **O1, O2, O8** are untouched by this revamp.
- **O4 (audio interruption, untested)** gains weight: U2 makes the audio session
  contended, and the interruption path is the least tested code in it.

---

## 10. Open

- **U1 unmeasured.** The gating question. §4.
- ~~**U2 undecided.**~~ **Resolved** — `live-capture` owns the microphone and
  `marker-listening` stands down. §3.
- **Master latency unmeasured.** How long Meta AI actually takes to sync a
  recording is not known, and it sets the entire felt quality of the product.
  Worth capturing during §4, since the same session produces it.
- **HDR through the caption burn is now built for, and still unmeasured.** O2
  flagged a composition built with no colour properties exporting through an
  H.264 preset that cannot carry HLG. That was the last stage of the master
  path and the only lossy one: `exportOriginal` copies the glasses' own bytes,
  `extractRange` cuts them by passthrough, and then the burn re-encoded the
  result as 8-bit BT.709 — on every Pro clip.

  `CaptionEngine.m` now reads the source's format description, tags the
  composition with its own primaries / transfer function / matrix so the
  compositor works in the footage's colour space rather than sRGB, and exports
  through `AVAssetExportPresetHEVCHighestQuality` when the source is HDR and the
  preset is compatible with the composition. `ClipStitcher.m`'s transcode
  fallback was given the same treatment — 10-bit decode, HEVC out, source colour
  written through — so the one path documented as unreachable cannot silently
  destroy a master if it is ever reached.

  **No file has been through any of this on device.** The mechanism is in place;
  the measurement O2 asks for is not made, and nothing here should be read as
  saying it has been. What is in place is the instrumentation to settle it in
  one worn session without pulling a single file off the device: `extracting …`
  and `cut by passthrough` say the master reached the cutter intact, `WROTE …`
  reports the resolution, colour and bit rate of what actually landed, and
  `burn:` / `burned …` carry `inRate=` and `outRate=` either side of the caption
  stage. §4a is the procedure and names the two ways this can fail that are not
  parameter fixes.
