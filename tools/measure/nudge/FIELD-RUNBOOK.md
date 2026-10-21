# Hardware 10v10 + HDR field runbook

**Machine gate (this Mac):** plug in / wireless-debug an unlocked, trusted iPhone with Meta glasses paired in Meta AI (Developer Mode on). Then run the checklist top to bottom.

## 0. Preconditions

```sh
# Must list an iPhone, not only MacBook Pro
xcrun xctrace list devices

# Bundle id (from Signing.xcconfig)
# com.mocinjay.clypso
```

| Need | Check |
|---|---|
| iPhone trusted | Xcode → Devices shows green |
| Meta AI | Glasses connected, Developer Mode ON |
| Photos | Clypso → All Photos |
| Build | TELEMETRY present (`app/src/core/telemetry.ts` in the binary) |

## 1. Deploy

Open `app/ios/Clypso.xcworkspace`, select the physical iPhone, Run (⌘R).  
Confirm Settings shows **Experiment — Meta View nudge** (Off by default).

## 2. Control (10 marks) — nudge OFF

1. Settings → Meta View nudge → **Off**
2. Armed / listening (master-only Path B)
3. Say **“Clypso”** → glasses record a short take → stop
4. Wait until Photos shows the new video (or until Clypso card → MASTER_READY)
5. Repeat to **10** marks
6. Do not toggle nudge mid-arm

## 3. Variant (10 marks) — nudge ON

1. Settings → Meta View nudge → **Nudge on mark**
2. Same wake protocol × **10**
3. Confirm Meta View / Meta AI opens (`fb-viewapp://`); return via status bar
4. Confirm listening resumes (no dead mic)

## 4. Pull log + decision gate

```sh
cd /Users/mocin/Desktop/clypso

# Xcode → Devices → Clypso → Download Container → copy:
#   AppData/Documents/clypso-diagnostics.log
./tools/measure/nudge/pull_diagnostics.sh --from ~/Downloads/clypso-diagnostics.log

# Must show [TELEMETRY] lines (T_MARK, T_PHOTOS_INSERT, …)
grep -c '\[TELEMETRY\]' tools/measure/nudge/field/clypso-diagnostics.log

./tools/measure/nudge/decide_nudge.sh \
  tools/measure/nudge/field/clypso-diagnostics.log --apply
```

| Verdict | `--apply` does |
|---|---|
| **PASS** | `metaViewNudgeAfterMark: true` |
| **FAIL** | `strip_nudge_experiment.sh` |
| **HOLD** | nothing (need ≥5 timed runs/arm) |

## 5. Real HDR masters

```sh
mkdir -p ~/masters
# Export ~1520×2032 HEVC HLG clips from Photos → ~/masters/

./tools/measure/canvas/dry_run_o1_master.sh ~/masters/*.mp4
./tools/measure/stitch/validate_hdr_passthrough.sh ~/masters/*.mp4
```

Expect: promotion refused (native size), Main10 preserved, stream-copy bitrate Δ ≤15%.

## 6. Commit after gate

Only after `--apply` mutates the tree:

```sh
git status
# PASS → commit "promote Meta View nudge after 10v10 PASS"
# FAIL → commit "strip Meta View nudge after 10v10 FAIL"
```
