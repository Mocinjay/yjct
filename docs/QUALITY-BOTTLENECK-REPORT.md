# Clypso quality bottleneck report

**Date:** 2026-09-16  
**Audience:** product / eng / anyone evaluating “why isn’t live Meta-quality instant?”  
**Status:** Current product ships **master-only** (`MASTER_ONLY_CAPTURE = true`). Path A (live Bluetooth stream) is disabled for delivery.

---

## 0. Non‑negotiables (product law)

These three are **not tradeoffs**. Shipping something that fails any of them is a failed build for Clypso’s target experience.

| Non‑negotiable | Meaning | Hard line |
|---|---|---|
| **Quality** | Delivered clips must be Meta-class masters | Short edge **≥ 1080**; target **~1520×2032 HDR**. **Never** ship the Bluetooth 720p stream as the library clip. |
| **Speed** | From “Clypso” to usable clip must feel as fast as the platform allows | Mark **instantly** (snap). Ingest/cut/caption **as soon as** Photos has the file — no manual sync/import taps as the happy path. |
| **Automation** | Wearer stays live; app does the work | Say the word → mark → (stop when done) → Meta sync → Clypso finds, cuts, captions **without** a gallery workflow. Zero posting requirement for this loop. |

**Conflict Meta forces on us:** Quality lives only on Path B (native record → Photos). Instant mid-take delivery of that master is **not** exposed to third parties. So:

- We **never** sacrifice Quality to fake Speed (no 720p “good enough” clips).
- We **max Speed and Automation** on everything we *can* control: listen, snap, poll Photos, cut, caption.
- The **only** delay we accept is Meta’s own stop → sync → Photos — and we attack that with aggressive watching/polling, not with user chores.

---

## 1. Executive summary

**Goal:** Wearer stays live, says **“Clypso,”** and a **Meta-quality** clip lands in Clypso with **minimal / no interaction**.

Two walls block “stream Meta masters into the app and cut mid-take”:

1. **Live DAT stream caps at 720×1280** — violates **Quality** non‑negotiable.
2. **No API to start/stop/export native recording while it rolls** — so we cannot auto-segment or pull masters until Meta AI syncs a **finished** file. That is the only Speed limit we cannot code away.

Everything we build (wake word, snap, markers, Photos watch/poll, passthrough cut, ≥1080 gate, auto captions) is aimed at **Quality + Speed + Automation** *inside* those walls — never around shipping 720p or asking the user to babysit the library.

---

## 2. What “good” looks like vs what Meta allows

| | Native Meta recording (Path B) | Live DAT stream (Path A) |
|---|---|---|
| Typical resolution | **~1520×2032** | **Max 720×1280** (often less via ABR) |
| HDR / colour | HLG / Rec.2020 masters in practice | Stream path; not the Photos master |
| Who owns the file | Glasses → Meta AI → **iOS Photos** | App Bluetooth session → phone segments |
| App can start/stop record? | **No** (button / Hey Meta / Meta AI) | Yes — but only the low-res stream |
| Available while “still rolling”? | File incomplete until stop + sync | Frames live, but ≤720p |
| Meets **Quality** non‑negotiable? | **Yes** | **No** |
| Meets **Speed** for mid-take master? | **Blocked by Meta** | Fast, but wrong quality |
| Meets **Automation** for masters? | **Yes** once file lands | Would automate the wrong asset |

Pixels: 1520×2032 ≈ **3.4×** the pixels of 720×1280. That is not a codec tweak; it is a different pipeline.

---

## 3. Why we refuse the app’s 720p stream (Path A)

**Quality is non‑negotiable.** Path A is therefore disqualified as a delivered clip — full stop.

### 3.1 Hard SDK ceiling

Meta Wearables DAT (`MWDATCamera`) exposes a fixed resolution enum:

```text
StreamingResolution.high    → 720×1280
StreamingResolution.medium  → 504×896
StreamingResolution.low     → 360×640
```

There is no 1080p / 1520p option. Requesting `.high` is already the maximum. Wi‑Fi transport (when available) only makes `.high` *reachable*; it does **not** raise the ceiling.

### 3.2 Not a “temporary compromise”

Even if we:

- switch codec to `.hvc1` and mux without re-encode,
- decode only for preview,
- maximize bitrate within the stream,

we still ship **720p**. That breaks the Quality law. We will not “buy” Speed by publishing soft proxies.

### 3.3 What we did instead (master-only)

`MASTER_ONLY_CAPTURE = true`:

- Never arm the Bluetooth segment writer / preview buffer for library clips.
- Keep the phone mic on **marker listening** only (**Automation** + real-time **Speed** of the mark).
- Import only Photos assets whose short edge is ≥ `MIN_MASTER_SHORT_EDGE_PX` (1080) (**Quality** gate).
- Captions run on those masters after import (**Automation**).

---

## 4. Why we can’t “just use the Meta API” for live masters

### 4.1 Two different Meta surfaces

| Surface | What it is | What Clypso can do |
|---|---|---|
| **DAT (Device Access Toolkit)** | Official 3P SDK: registration, device session, **live camera stream**, still `capturePhoto` | Stream ≤720p; still shutter; **no** native video record control |
| **Native glasses capture + Meta AI** | First‑party record to glasses storage, sync into Photos | Wearer / Meta controls recording; app reads **Photos after sync** |

Third‑party apps are a **stream consumer**, not a full high‑res camera app for the glasses.

### 4.2 Restrictions that hit Speed / Automation

1. **No start/stop native video API** — cannot auto end→restart to force Photos chunks while “staying live.”
2. **No mid-recording export** — cannot splice an unfinished master.
3. **No command to drive Meta → Photos** — sync is Meta’s; we only watch/poll after assets appear.
4. **`capturePhoto` ≠ video segment** — still shutter is not record control.
5. **Privacy model** — unmarked footage is never opened; we only cut marker‑matched glasses videos.

### 4.3 “Trick recording” (auto stop/start) — rejected

Would help **Speed** of masters landing while feeling continuous — but needs the missing record API. Not available; not something we fake with unsupported hacks.

---

## 5. The core issue

**Quality demands Path B. Live Speed of masters demands APIs Meta does not give 3P apps. Automation of everything else is fully on us.**

So the architecture is forced:

| Phase | Non‑negotiable focus | Reality |
|---|---|---|
| While recording | **Speed** of feedback + **Automation** of marking | Snap + marker **now** |
| After stop + Meta sync | **Quality** + **Speed** of ingest + **Automation** of cut/caption | Poll/watch Photos → cut ≥1080 HDR → caption |

We do **not** invent Instant Master Delivery. We **do** make Mark Instant and Ingest Autonomous.

---

## 6b. Shadow Proxy (how we buy Speed without breaking Quality)

| Layer | Behaviour |
|---|---|
| Wake word | Snap + `MARKED_PENDING` library card immediately |
| Poster | Last DAT JPEG if a preview frame exists (optional); never a 720p video publish |
| Photos | `PHPhotoLibraryChangeObserver` + insert payload; 60s poll fallback |
| Cut | Passthrough master ≥1080 → same clip id → `MASTER_READY` |
| Publish | Blocked until `MASTER_READY` |

This is the robust bridge: **UI feels instant; delivered bytes stay Meta masters.**

---

### Quality
- Master-only library path; reject short edge &lt; 1080.
- Passthrough cut when possible; HDR Main10 + colour tags on forced re-encode.
- No captioning of 720p proxies as the product output.

### Speed
- Wake-word → **snap** immediately (heard confirmation).
- Marker persisted at once (survives delayed sync / app kill).
- Photos **watched** + **polled ~every 12s** + sync on mark + foreground catch-up.
- Manual “Check Photos now” only as a boost — not required for the happy path.

### Automation
- Listening runs without Armed stream / preview buffer.
- Say word → mark; stop when ready; Meta syncs; Clypso finds → cuts → captions.
- Unmarked recordings left alone.
- No publish step required for this loop.

### Still blocked (Meta wall only)
- Mid-take master file in Photos.
- Programmatic native record start/stop / micro-segments.
- Raising live stream above 720×1280.

---

## 7. Honest UX contract (aligned to the three laws)

1. Start **native** glasses recording.  
2. Say **“Clypso”** → **snap** (**Speed** of feedback).  
3. Stay live as long as you want (**Automation** of marking).  
4. **Stop** when ready.  
5. Meta AI → Photos (external delay).  
6. Clypso auto-cuts **≥1080p HDR** and captions (**Quality** + **Automation** + remaining **Speed**).

---

## 8. What would unlock all three at once

Meta must give at least one of:

1. Native record start/stop (or auto-segment) for approved 3P apps, and/or  
2. Live stream **≥1080**, and/or  
3. Progressive export of an in-progress recording.

Until then: **Quality never yields; Speed and Automation absorb every millisecond we control.**

---

## 9. Bottom line

| Non‑negotiable | Stance |
|---|---|
| **Quality** | No 720p delivery. Masters only. |
| **Speed** | Instant mark + snap; fastest possible ingest after Photos; never make the user dig through a gallery. |
| **Automation** | Word → mark → sync → cut → caption without babysitting. |

| Question | Answer |
|---|---|
| Why not app 720p? | Breaks **Quality**. |
| Why not Meta API for live masters? | No record/export-while-rolling API — blocks **Speed** of masters, not our willingness to automate. |
| What’s the issue? | Meta separates the quality path from the live path. |
| What are we doing? | Enforce Quality; maximize Speed + Automation on mark + Photos ingest + cut + caption. |

**References:** `docs/LEECH-ARCHITECTURE.md` §2, `docs/VIDEO-QUALITY.md`, `docs/ENGINEERING-SUMMARY-VIDEO-QUALITY.md`, `app/src/config.ts`, `app/src/markers/GlassesImportController.ts`, `app/src/services/glassesImport.ts`.
