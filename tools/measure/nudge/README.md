# Meta View nudge — 10v10 telemetry

Field analyzer for Approach 2 (`metaViewNudgeAfterMark` / `fb-viewapp://`).

## Capture

On device, pull the diagnostics file after a 10v10 session:

```text
Documents/clypso-diagnostics.log
```

The app writes machine lines:

```text
2026-09-17T18:00:00.000Z [TELEMETRY] {"event":"T_MARK","runId":"mark_…","variant":"control",…}
```

Events: `T_MARK`, `T_NUDGE`, `T_PHOTOS_INSERT`, `T_MASTER_READY`, `MIC_SUSPEND`, `MIC_RESUME`.

## Analyze

```sh
node --experimental-strip-types tools/measure/nudge/analyze_10v10.ts /path/to/clypso-diagnostics.log
node --experimental-strip-types tools/measure/nudge/analyze_10v10.ts --fixture   # sanity check
./tools/measure/nudge/decide_nudge.sh tools/measure/nudge/field/clypso-diagnostics.log
./tools/measure/nudge/decide_nudge.sh <log> --apply   # only after real PASS or FAIL
```

Pull from device:

```sh
./tools/measure/nudge/pull_diagnostics.sh --from ~/Downloads/clypso-diagnostics.log
```

**PASS** requires p50 mark→Photos (or mark→master) latency reduction **> 20%** and no unrecovered `MIC_SUSPEND` after a nudge bounce.

Control arm: Settings → Meta View nudge **off**.  
Variant arm: same setting **on**.
