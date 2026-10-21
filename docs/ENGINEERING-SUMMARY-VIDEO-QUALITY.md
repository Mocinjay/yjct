# Engineering Summary — Master-only Path B

Date: 2026-09-16 (updated: master-only product mode)  
Scope: ship ≥1080p Meta masters only; Clypso listens live while glasses record natively.

---

## Shadow Proxy (UI feedback ≠ delivered video)

Separates **Speed/Automation of feedback** from **Quality of delivery**:

1. **Mark** → library card `MARKED_PENDING` (+ optional DAT still as poster) + snap.
2. **PHPhotoLibraryChangeObserver** with fetch baseline → insert events the moment Meta drops a video into Photos (60s poll is safety only).
3. **Cut** passthrough master ≥1080 → promote same clip id to `MASTER_READY`.
4. **Publish/share disabled** until `MASTER_READY`.

Timecode: phone wall-clock `marker.atMs` vs glasses QT `creationdate` (`startedAtMs`), with `graceBeforeSec` / `graceAfterSec` for skew — not DAT PTS (no live stream required for masters).

---

`MASTER_ONLY_CAPTURE = true` in `app/src/config.ts`.

| Path A (Bluetooth stream / preview buffer) | **Disabled** — never arms, no segment writer, no preview lease |
| Path B (native Meta → Photos → Clypso) | **Only clip source** — wake word overlay + import + captions |
| Quality gate | Short edge must be ≥ `MIN_MASTER_SHORT_EDGE_PX` (1080) |

### Test loop
1. Link Meta AI on Connect (no live preview).
2. Armed = listening screen (mic open).
3. Start native glasses recording; say “Clypso”.
4. Wait for Meta AI → Photos sync (or tap “Check Photos now”).
5. Clip appears ≥1080p HDR; captions enqueue automatically.

---

## Prior work (dormant while master-only)

- Path A `.hvc1` passthrough + VT preview decode remain in native code for when
  `MASTER_ONLY_CAPTURE` is flipped to `false`.
- ClipStitcher passthrough + HDR Main10 fallback unchanged.
- U1 concurrency probe/swap remains; not required for master-only delivery.

---

## Files changed (master-only refactor)

- `app/src/config.ts` — `MASTER_ONLY_CAPTURE`, `MIN_MASTER_SHORT_EDGE_PX`
- `app/src/core/CaptureSessionManager.ts` — never arms Path A when master-only
- `app/src/device/glassesLease.ts` — no Bluetooth session lease
- `app/src/markers/GlassesImportController.ts` — ≥1080 gate
- `app/src/services/glassesImport.ts` — force Path B on; expose `listening`
- `app/src/ui/screens/ArmedScreen.tsx` — listening UI (no viewfinder)
- `app/src/ui/screens/ConnectScreen.tsx` — skip preview; advance to listening
- `app/src/ui/screens/SettingsScreen.tsx` — master-only copy
- Tests updated (`CaptureSessionManager`, `GlassesImportController`)
