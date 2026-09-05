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

Hybrid requires both paths to be alive at the same moment. Neither half of that
has been demonstrated. **No code should be written against §5 until §4 answers
both.**

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

### U2 — One microphone, two claimants

`glassesImport.ts:122-124` constructs its wake word as:

```ts
// The self-listening provider: with no stream running, nothing else is
// recording audio, so the wake word has to hold its own microphone.
new SpeechWakeWord({ ownMicrophone: true }),
```

That comment states the current invariant precisely: Path B owns the mic
*because* Path A is not running. Hybrid runs both, so `ownMicrophone: true`
collides with the writer's own `AVAudioSession` tap in `MicSegmentRecorder.m`
(session config at `:193-226`, interruption handling at `:467-500`).

There must be exactly one microphone owner and one audio session policy. Which
half owns it is a design choice; having two is a defect. This is not
speculative in the way U1 is — it is a known conflict visible in the source —
but the correct resolution depends on U1's verdict, so it is sequenced after it.

---

## 4. Phase 0 — run the experiment before designing further

No new code. Existing instruments only.

1. Enable `glassesLibraryImport` (Path B) **and** arm Path A on device, at once.
2. Wear the glasses. Record natively — the capture button or "Hey Meta" — for a
   realistic span, several times, including at least one long recording.
3. Let Meta AI sync. Foreground the app so `onForeground()` runs
   (`glassesImport.ts:166-169`).
4. Pull the log and read the verdicts:

```bash
xcrun devicectl device copy from --device <UDID> --domain-type appDataContainer \
  --domain-identifier com.mocinjay.clypso \
  --source Documents/clypso-diagnostics.log --destination /tmp/
grep "concurrency probe" /tmp/clypso-diagnostics.log
grep "session rungs"     /tmp/clypso-diagnostics.log
```

The second grep costs nothing extra and closes O7's population question at the
same time — how often `.high` is actually delivered, which determines whether
the proxy is 720x1280 or 504x896 in practice.

**Record the verdict in this file.** The instrument is documented as temporary
(`streamConcurrency.ts:5-7`, `GlassesImportController.ts:279`); it is deleted
only once the answer is written down, not once it is observed.

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
- **U2 undecided.** Which half owns the microphone, pending U1.
- **Master latency unmeasured.** How long Meta AI actually takes to sync a
  recording is not known, and it sets the entire felt quality of the product.
  Worth capturing during §4, since the same session produces it.
- **HDR through the caption burn is unmeasured** and now matters far more. O2
  already flags that the composition is built with no colour properties and
  exports through an H.264 preset that cannot carry HLG
  (`CaptionEngine.m:826/854`). At 720p that was a quality question; at
  1520x2032 HDR it is the difference between shipping the master and shipping a
  tone-mapped copy of it.
