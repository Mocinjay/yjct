# Open work

Status: 2026-09-02. Every item was verified against the tree at `4d93326`
before being listed. Each carries a `file:line` reference or an explicit
**unmeasured**; nothing here is inferred from a work-item description.

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

### O2 — What the caption burn does to an HLG master is asserted, not measured

`CaptionEngine.m:826` builds the composition with the bare
`[AVMutableVideoComposition videoComposition]` initialiser — no
`colorPrimaries`, no `colorTransferFunction`, no `colorYCbCrMatrix`, confirmed
by grep across the file. The export preset is
`AVAssetExportPresetHighestQuality` (`:854`), which is H.264/AAC and cannot
carry HLG.

**Unmeasured:** no path-B asset has been through the burn on device. Whether
the result is tone-mapped, clipped, or something worse is being claimed from
API semantics rather than from a file. Measure before building anything on top.

### O3 — Path B never starts a Live Activity

Path A wires it: `ArmedScreen.tsx:142` starts, `:155` updates, `:147` ends.
`LiveActivityBridge.swift` and the shared `ClypsoActivityAttributes.swift`
exist and work.

`src/services/glassesImport.ts` and `src/markers/` contain no `LiveActivity`
reference at all. So the glasses-import path can be listening — holding the
phone's microphone, which `SettingsScreen.tsx:199-203` warns the user about —
with nothing on the Lock Screen saying so. That warning is the argument for
fixing it: the app asks the user not to swipe it away and then gives them no
persistent sign it is running.

### O4 — Audio interruption is handled natively and tested nowhere

`MicSegmentRecorder.m:467` registers the observer, `:482-500` handles it,
including the `ShouldResume` check at `:494`. The session config it protects is
`:193-226`, and G4 found it already correct.

No test in `app/__tests__/` exercises an interruption. The 18 suites are all
TypeScript, and this logic is Objective-C, so covering it means either a native
test target or lifting the decision into TS. Worth deciding which before
writing anything.

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
