# Lateral workarounds: Synthetic Master vs Meta View nudge

**Date:** 2026-09-17  
**Branch context:** `refactor/clypso-architecture`  
**Question:** Can we get instant ≥1080 deliverable clips without waiting on Meta→Photos sync?

---

## Verdict (read this first)

| Approach | Production viability | Why |
|---|---|---|
| **1. Synthetic Master (MetalFX / CoreML upscale)** | **Reject as product master** | Hits pixel count, not information. Violates Quality non‑negotiable. Already measured-rejected for Apple VT SR on our exact 720×1280 geometry (`docs/VIDEO-QUALITY.md` §5.1). |
| **2. Meta View URL nudge** | **Thin experiment only** | Cheap to try; **does not claim** to force glasses→Photos sync. Official scheme is `fb-viewapp://` (already in `LSApplicationQueriesSchemes`). UX bounce kills “stay live.” App Store OK for rare, user-visible opens — not aggressive loops. |

**Neither path bypasses the Meta wall for real masters.** Keep Shadow Proxy + Path B. Use Approach 2 only as an instrumented A/B: “does opening Meta View reduce median time-to-Photos?”

---

## Approach 1 — Synthetic Master (CoreML / MetalFX)

### Architecture

```text
DAT .hvc1 720×1280 CMSampleBuffer
        │
        ▼
 VTDecompressionSession (already in MWDATPreviewEncoder)
        │
        ▼
 Metal texture / CVPixelBuffer
        │
        ├─ MTLFXSpatialScaler / VT*SuperResolution* / CoreML SR
        │
        ▼
 1080×1920 (or larger) CVPixelBuffer
        │
        ▼
 AVAssetWriter (HEVC Main10) → “synthetic master” MP4
        │
        ▼
 existing CaptionEngine / publish path
```

### Feasibility

| Concern | Assessment |
|---|---|
| **Quality** | Upscale invents pixels. Glasses masters are ~1520×2032 **HDR** with real sensor detail. Synthetic SDR/HDR upscale will look soft next to Path B and fail honest “Meta quality” marketing. |
| **Apple VT Low-Latency SR** | **Blocked.** `maximumDimensions` 960×960; our frames are 720×**1280**. Temporal SR wants 4× only and rejects our height (`docs/VIDEO-QUALITY.md` §5.1). |
| **MetalFX Spatial** | Available on capable GPUs (`MTLFXSpatialScaler`). Still: 1.5× spatial upscale of BT compressed 720p ≠ master. Real-time 30 fps + encode is battery-heavy. |
| **Latency** | Per-frame: ms–tens of ms on Neural Engine. Full clip re-encode: seconds–tens of seconds — competes with Meta sync time for short takes. |
| **Pipeline fit** | Does **not** plug into `AVAssetExportPresetPassthrough`. You must **re-encode**. Passthrough is for real masters only. |
| **Publish ladders** | Platforms may give a 1080 upload more bitrate, but they re-encode again — spending battery to invent detail that TikTok/IG throw away (`VIDEO-QUALITY.md` §5.1). |

### PoC sketch (Swift) — spatial scale only, labeled synthetic

```swift
import Metal
import MetalFX
import CoreVideo

/// Experimental: bilinear/MetalFX spatial upscale. NOT a Meta master.
enum SyntheticUpscale {
  static func scale(
    _ pixelBuffer: CVPixelBuffer,
    toWidth outW: Int,
    outHeight outH: Int,
    device: MTLDevice
  ) throws -> CVPixelBuffer {
    // Prefer MTLFXSpatialScalerConfiguration when supported;
    // fall back to CIImage.transformed(by:) for the probe.
    // Output must be fed to AVAssetWriter — never ExportSession passthrough.
    fatalError("Probe only — see docs/LATERAL-WORKAROUNDS.md; do not ship as master")
  }
}
```

**Do not** wire this into `MASTER_READY` or publish. If ever shown in UI, label **“Enhanced preview”** and keep Path B as the only publishable asset.

### Why this fails our non‑negotiables

- **Quality:** false 1080.  
- **Speed:** may be slower than Meta sync for short clips once you decode+SR+encode.  
- **Automation:** requires Path A stream armed again (U1 concurrency unknown vs native record).

---

## Approach 2 — Meta View / Meta AI wake nudge

### Architecture

```text
Wake word → Shadow MARKED_PENDING + snap
                │
                ▼ (optional, gated)
     UIApplication.open(fb-viewapp://)
                │
                ▼
     User briefly in Meta View / Meta AI
                │
                ▼ (hoped, unproven)
     Faster glasses→Photos sync
                │
                ▼
     Existing PHPhotoLibraryChangeObserver → cut → MASTER_READY
                │
                ▼ (optional)
     open clypso://listening  (bounce-back)
```

### Known facts from this repo + DAT docs

- Documented query scheme for Meta AI / View: **`fb-viewapp`** (`Info.plist`, DAT getting-started).  
- GitHub issues also mention `fb-viewapp-deeplink`, `meta-view` in some apps — **not** guaranteed; probe with `canOpenURL`.  
- There is **no public API** that says “flush glasses library to Photos now.” Opening the companion app *may* wake its sync daemon; that is a **hypothesis**.

### Feasibility

| Concern | Assessment |
|---|---|
| **Does it force sync?** | **Unknown.** Measure median mark→Photos insert with nudge on vs off. |
| **UX** | Leaves Clypso mid-session — fights “stay live.” Prefer a single optional “Open Meta to sync” button, not auto-fire every mark. |
| **App Store** | One user-initiated or rare post-mark `openURL` is normal. Looping / silent background opens = review risk and iOS will not allow background open of other apps anyway. |
| **Bounce-back** | Meta will not reliably call `clypso://` after a plain open. Use a banner “Return to Clypso” or `UIApplication.shared.open(clypsoURL)` only after user returns (scene `active`). |

### PoC (shipped)

Native module `MetaViewNudge` + TS wrapper `app/src/native/MetaViewNudge.ts`.  
Opens candidate schemes in order; logs which worked; **never** loops.

---

## What to ship on this branch

1. **Keep** Shadow Proxy + Path B masters (source of truth).  
2. **Add** Meta View nudge as **opt-in Settings / debug** probe with timing logs.  
3. **Do not** integrate Synthetic Master into deliverable / `MASTER_READY`.  
4. Run 20 marks: 10 with nudge, 10 without; compare `mark.atMs` → first Photos insert.

If nudge does not move p50 sync time by a meaningful amount (e.g. >20%), delete the experiment and stop chasing URL tricks.

---

## Field decision gate (merge to main)

| Evidence | Call | Action |
|---|---|---|
| Real log, p50 drop **>20%**, zero unrecovered `MIC_SUSPEND` | **PROMOTE** | `./tools/measure/nudge/decide_nudge.sh <log> --apply` → `metaViewNudgeAfterMark: true` |
| Real log, p50 drop **≤20%** or mic fails after bounce | **STRIP** | same with `--apply` → `strip_nudge_experiment.sh` |
| No device log / `<5` timed runs per arm / fixture only | **HOLD** | Keep default **false**. Path B + Shadow Proxy are the merge deliverable. |

**Status (2026-09-18):** **HOLD** — no `clypso-diagnostics.log` from physical glasses on this machine; `~/masters` empty; no iPhone attached to `xcrun`. Do not promote from `--fixture`.

```sh
# After field session:
./tools/measure/nudge/pull_diagnostics.sh --from ~/Downloads/clypso-diagnostics.log
./tools/measure/nudge/decide_nudge.sh tools/measure/nudge/field/clypso-diagnostics.log
```
