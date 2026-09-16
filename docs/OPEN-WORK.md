# Open work

Status: 2026-09-02, with O2 and O4 rewritten 2026-09-09. Every item was
verified against the tree at `4d93326` before being listed. Each carries a
`file:line` reference or an explicit **unmeasured**; nothing here is inferred
from a work-item description.

**2026-09-09.** O2 and O4 both moved, and neither closed. The mechanisms they
describe were built; the measurements they ask for are still not made, and the
rewritten entries say which is which. `docs/LEECH-ARCHITECTURE.md` §3 U2 closed
in the same pass — the microphone now has exactly one owner. Line numbers in
the untouched entries below predate that work and may have drifted by a few
lines in `SettingsScreen.tsx`, `MicSegmentRecorder.m`, `CaptionEngine.m` and
`ClipStitcher.m`; the symbol names are the durable half.

**What this is not.** An earlier plan numbered W1–W14 and `docs/ground-truth.md`
answers questions about it, but that plan's text was never committed and is not
recoverable from this machine. Reconstructing it would mean inventing the seven
items nothing references. So this file is numbered O1–O8 on its own terms,
built from what the repository can actually evidence. If the W-plan resurfaces,
reconcile against it rather than assuming these are the same list.

Read `docs/ground-truth.md` alongside this, but read §"Corrections" below
first — four of its rows have gone stale.

---

## Open

### O1 — Claim A has never been run, and it is the only thing holding `CECanvasPromotionEnabled` at `NO`

`CaptionEngine.m:56`. The flag is `NO`; the guard that reads it is `:259`.

§8.7 lists the criteria and §8.8 names this as the sole remaining blocker: the
harness exists, the uploads do not. `tools/measure/ladder.sh report` already
applies the pass/fail rule, so this is an execution task, not a design one —
three runs per platform, same account, same network, judged on the
`1080p-native` arm.

The prerequisite is done (the §8.2 laundering hole is closed) and
`tools/measure/canvas/fixtures.sh` re-asserts it in one command. Run that
before the ladder; an arm built by a misbehaving guard is not worth uploading.

### O2 — The caption burn now carries HLG; whether it does so correctly is still unmeasured

**Was:** `CaptionEngine.m` built the composition with the bare
`[AVMutableVideoComposition videoComposition]` initialiser — no
`colorPrimaries`, no `colorTransferFunction`, no `colorYCbCrMatrix` — and
exported through `AVAssetExportPresetHighestQuality`, which is 8-bit H.264/AAC
and cannot carry HLG. Two separate losses on the same stage: the compositor
read HLG-encoded samples through an sRGB transfer function, and the encoder
could not have represented the result if it had read them correctly.

That mattered more than it read. It was the *only* lossy stage left on the
master path — `exportOriginal` copies the glasses' own bytes out of the photo
library and `extractRange` cuts them by passthrough — so a Pro clip arrived at
the last step as an intact 1520x2032 HLG master and left it as a flat 8-bit
BT.709 copy.

**Now:** `CEReadVideoColor()` reads the source's format description; when the
transfer function is HLG or PQ the composition is tagged with the source's own
primaries / transfer function / matrix (all three or none — AVFoundation raises
on a partial set), and the export runs through
`AVAssetExportPresetHEVCHighestQuality` when
`determineCompatibilityOfExportPreset:` says the composition can take it.
`ClipStitcher.m`'s transcode fallback got the matching treatment: 10-bit
`x420` decode instead of 32BGRA, HEVC out, and `AVVideoColorPropertiesKey` set
from the source. That path is documented as unreachable for a single-source
cut; it is now unable to destroy a master if the documentation is wrong.

**Measured off-device, 2026-09-09.** `tools/measure/hdr` runs the same
composition and export against a synthetic 1520x2032 10-bit HEVC / BT.2020 / HLG
file, using `JVSReadVideoColor` lifted verbatim out of `ClipStitcher.m`:

| Arm | Result | Rate (source 10.62 Mbps) |
|---|---|---|
| `untagged+h264` — what shipped before | **avc SDR `ITU_R_709_2`** | 14.11 Mbps |
| `tagged+hevc` — what ships now | hevc HDR `ITU_R_2100_HLG` | 14.91 Mbps |
| `tagged+hevc+captions` | hevc HDR `ITU_R_2100_HLG` | 12.05 Mbps |

So the defect was real and is reproduced, not merely argued: the old path hands
back a file tagged BT.709 SDR. The fix holds, and it holds *with the caption
overlay attached* — which was the likeliest way it could have been undone, since
`AVVideoCompositionCoreAnimationTool` draws sRGB layers. Both HDR arms come back
above the source rate, so the "a preset picks its own bit rate and you cannot
ask for another" worry does not bite on this content. Separately,
`AVAssetExportPresetPassthrough` was confirmed to serve an HLG HEVC cut into an
MP4 container, which is what keeps `extractRange` off the transcode fallback.

**Still unmeasured on device, and that is a real gap, not a formality.** The
above is macOS AVFoundation against synthetic content. It settles what the APIs
do with these tags; it does not prove the glasses tag their files the way the
fixture does, it does not carry iOS's encoder behaviour, and bit rate on real
footage is scene-dependent. Nor does any of it say how the captions *look* —
white lands around 72% of the video range, which is HLG diffuse white rather
than clipped or crushed, but a code value is not a judgement and somebody has to
watch a clip on an HDR display. The log says what happened per clip, so one worn
session settles the rest:

```bash
grep "NOT glasses footage"     /tmp/clypso-diagnostics.log   # read this first
grep -E "extracting |WROTE |burn:|burned " /tmp/clypso-diagnostics.log
```

`extracting … hevc HDR transfer=…` followed by `cut by passthrough` means the
master reached the cutter intact. `WROTE …` reports the resolution, colour and
bit rate of the file that landed. `burn:` carries `inRate=` and `burned …`
carries `outRate=`, so the caption stage is judged on both colour and bits —
a preset picks its own bit rate and cannot be asked for a different one, so an
HDR clip can come back correctly tagged and still be softer than it went in.
`WARNING: an HDR master came out of the burn as SDR` is the flat regression.

`docs/LEECH-ARCHITECTURE.md` §4a is the full procedure, including the two
failures that would not be parameter fixes: Core Animation renders captions in
SDR sRGB regardless of the composition's colour, and the export runs on a preset
with no bit-rate control.

### O3 — Path B never starts a Live Activity

Path A wires it: `ArmedScreen.tsx:142` starts, `:155` updates, `:147` ends.
`LiveActivityBridge.swift` and the shared `ClypsoActivityAttributes.swift`
exist and work.

`src/services/glassesImport.ts` and `src/markers/` contain no `LiveActivity`
reference at all. So the glasses-import path can be listening — holding the
phone's microphone, which `SettingsScreen.tsx:209-211` warns the user about —
with nothing on the Lock Screen saying so. That warning is the argument for
fixing it: the app asks the user not to swipe it away and then gives them no
persistent sign it is running.

Sharper since 2026-09-09 in two ways. The setting now defaults on, so this is
the state a fresh install is in rather than one somebody opted into. And there
is now a second thing the Lock Screen would have to say, because listening can
be *paused* — the live-capture path takes the microphone for the length of an
armed session (`core/microphone.ts`). The Settings screen says so; nothing else
does.

### O4 — Audio interruption is handled natively and tested nowhere — still true, and the surface grew

`MicSegmentRecorder.m` registers observers for interruption, route change,
engine configuration change and — new — `AVAudioSessionMediaServicesWereReset`,
which is the failure shape that matters most on an always-on path: mediaserverd
restarts, the tap simply stops being called, the engine still reports itself
running, and nothing is posted. Hours of listening to nothing, with a
healthy-looking recorder.

Every one of those handlers ends in `restart`, which is why it is now coalesced
and budgeted (`kMSRMaxRestartsPerWindow` / `kMSRRestartWindowSeconds`): one
physical event posts several notifications, and a cause that does not clear was
an unbounded rebuild loop in the background on battery. Past the budget the
recorder stops, releases the session and says so, because a trigger that is not
being heard should look broken rather than busy.

Three defects were fixed in that pass, all of them invisible from JS:

- The segment file pinned itself to mono while the tap format decided the
  buffer, so a two-channel input route raised `NSInvalidArgumentException` out
  of `writeFromBuffer:` on the first buffer. Mono is now asked for at the
  session and the file follows what actually arrives.
- `teardownEngineLocked` called `setActive:NO` on every restart, on a session
  object that is shared process-wide — taking it out from under
  `MWDATSegmentWriter` whenever the glasses stream was up.
- A session that activated while the engine failed to start was never
  deactivated by anybody, holding the input route for the life of the process.

**Still no test.** The suites are TypeScript and this is Objective-C; covering
it means a native test target or lifting the decision into TS, and that choice
is still unmade. The arbitration half of the same problem *is* covered —
`__tests__/microphone.test.ts` — because it was deliberately written in TS for
that reason.

### O5 — `.hvc1` capture is the real quality lever and is blocked on the preview path

`MWDATBridge.swift:785` requests `StreamConfiguration(videoCodec: .raw, ...)`,
so the writer re-encodes decoded pixel buffers. That is three generations of
loss on path A.

`.hvc1` was tried on device and is not a simple swap: the SDK hands back frames
with a `dataBuffer` and no `imageBuffer`, logging
`imageBuffer=false makeUIImage=NIL` (reasoning at `:767-773`, the log at
`:983-986`). Muxing those compressed samples is the right idea, but
`MWDATPreviewEncoder.swift:137` needs `CMSampleBufferGetImageBuffer` for the
live viewfinder, so switching the stream blacks out the preview unless a decode
path is added back for preview only — which returns some of the CPU saving.

**Cannot be costed yet.** The cut-precision trade-off depends on a GOP cadence
that has never been observed, and no `.hvc1` sample has ever been written to a
file, so there is nothing to measure it on.

### O6 — Wake-word accuracy on worn audio is unmeasured

No corpus, no harness. `__tests__/phraseMatch.test.ts` tests the regexes against
hand-written strings, which says nothing about recogniser behaviour on real
far-field audio. `tools/measure/` holds the canvas and stitch work; none of it
takes audio in.

This matters more than it looks: the 2026-08-02 diagnosis found the failure was
audio level, not the regex, and the fix (`SpeechWakeWord.m`
`SWWRenderBoostedAudio()`) is tuned by constants — `kSWWTargetRMS`,
`kSWWPeakCeiling`, `kSWWMaxGain` — that nothing currently validates.

### O7 — Rung instrumented; transport is not observable at all — INSTRUMENT BUILT, NO FIELD DATA

**Transport cannot be answered.** `MWDATCore.swiftinterface` (SDK 0.9.0,
`exactVersion`) exposes no transport, bandwidth or link-quality surface —
searching it for those terms returns only `noDeviceWithConnection` and
`connectionError`, both error cases. Whether a session ran over Bluetooth
Classic or Wi-Fi is therefore not readable from the app, and the sentence in
`MWDATBridge.swift:779-782` reasoning about which link the ladder will land on
is inference from MWDATCamera's documentation, not something the code can
confirm. Do not go looking again without a new SDK version.

**The rung is now tallied per session.** `MWDATSegmentWriter` counts segments
by delivered resolution (`rungSegments` / `rungOrder`, recorded at the existing
format-detection site) and emits one line per session from both stop paths:

```
[MWDATWriter] session rungs: 504x896=11 720x1280=3 segments=14 path=504x896>720x1280
```

Two decisions worth keeping:

- **The 504x896 fallback is never counted.** It is a guess that keeps the
  encoder configurable when `CMVideoFormatDescriptionGetDimensions` returns
  nothing; tallying it would put invented rungs in the distribution this exists
  to measure. That case counts as `unknown` instead.
- **The summary is emitted on the discard path too**, not only on a clean stop.
  A session that dropped a rung and was then abandoned is the case most worth
  seeing, and it is the one most likely to end by discarding.

**Still unmeasured: everything.** No session has been read back through this.
The point of §8.8's concern is the population question — if most sessions are
mixed-resolution, promotion applies to far fewer clips than O1's claim-A
population assumes, and the canvas question shrinks. Answering that needs
worn-session logs, which needs hardware:

```bash
xcrun devicectl device copy from --device <UDID> --domain-type appDataContainer \
  --domain-identifier com.mocinjay.clypso \
  --source Documents/clypso-diagnostics.log --destination /tmp/
grep "session rungs" /tmp/clypso-diagnostics.log
```

### O8 — Two `stsd` decode errors, still unexamined

Recorded in §8.2, unresolved in §8.8, and unrelated to the canvas question. §8.8
calls them the more alarming of the two findings, on the grounds that every
publish target ingests with something ffmpeg-shaped. Nothing has looked at them
since.

---

## Corrections to `docs/ground-truth.md`

That file describes the tree at `5e25bfb` plus uncommitted work. Four of its
rows have since been overtaken. Left in place there as a record of the audit;
corrected here so neither is read alone.

| Row | Said | Now |
|---|---|---|
| G8 / W3 retention | 7 days, short of the 30 asked for | **30 days.** `MarkerStore.ts:24` |
| W3 coalescing | `coalesceMarkers` keeps the earlier marker and discards the later | **Done, and the function is gone.** `clipRangesForVideo` merges overlapping windows into their union and clamps to `maxWindowSec` (`markerMatching.ts:163-196`) |
| G9 photo permission | `.limited` detected but the toggle is not gated | **Gated.** `SettingsScreen.tsx:63-68` only writes the setting when `requestEnable()` returns no blocker; the blocker renders at `:195-197` and deselects "Listening" at `:186` |
| Path B tiering | not gated on Pro, nothing to clamp against | **Tier-aware.** `glassesImport.ts:130` picks `maxWindowSec` from `entitlementStore.isPro()`. The 20 s lookback is still fixed, deliberately, with the reasoning at `:17-24` |

Two smaller drifts, noted so the references are not trusted blind: G7's citation
is now `markerMatching.ts:132-133`, and the preview-encoder line in the W8 note
is now `MWDATPreviewEncoder.swift:137`.

---

## Not open, recorded so it is not reopened

- **W4's A/V gap is measured and fixed.** `take` is the video track's own end
  (`ClipStitcher.m:163-164`, with `cursor` advanced by it at `:263`);
  `tools/measure/stitch` asserts gap position and
  size against synthetic fixtures. Full reasoning in `ground-truth.md`
  finding 2 — including why a drift-only test would have passed the broken code.
- **The wake-word vocabulary stays spelled `clipso`.** `phraseMatch.ts` and
  `SpeechWakeWord.m`'s `contextualStrings`. No recogniser has heard "Clypso".
- **`jarvis://` history stays in `Info.plist`.** Reverting the scheme on the
  strength of a comment broke a registration that worked. See `KNOWN-ISSUES.md`
  rule R7.
- **`GMLIsGlassesAsset` is a deliberate hard AND** of `"Meta"` and `"Glasses"`
  on the model string, with copyright `"Meta AI"` as the only fallback
  (`GlassesMediaLibrary.m:220-241`). Two string constants own the whole path-B
  feature — though note `"Glasses"` at `:229` is a bare literal while its
  partner at `:75` is a named constant.
