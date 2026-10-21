# Clypso — *"Clypso."*

Mobile companion app for Meta smart glasses (Ray-Ban Meta, Oakley Meta HSTN, Ray-Ban Display), built for clippers/streamers. iOS records from the glasses; the Android build has no glasses support yet.

**The goal: every clip at the best resolution the glasses can record.** The glasses record **1520x2032 HEVC in HLG HDR** to their own storage; the live stream the Meta toolkit allows tops out at **720x1280**. Clypso cuts your moments out of the glasses' own recordings once Meta AI syncs them to your photos, and uses the live stream only for the instant clip it then replaces. How and why: [docs/MAX-RESOLUTION.md](docs/MAX-RESOLUTION.md).

**Core loop:** wearer says “Clypso” → the moment is marked, and (live mode) a 720p clip of the last N seconds lands in the library at once → when the glasses' own recording of that moment syncs, the clip is replaced in place by the full-resolution cut → share via the native OS share sheet (free tier). In glasses-only mode nothing streams: the wearer records on the glasses and the full-resolution clip arrives after the sync. Auto-captioning + one-tap publishing are the paid tier and live behind Phase 2 gates.

## Phase gating (non-negotiable build order)

| Phase | Status | Contents |
|-------|--------|----------|
| **1** | ✅ working on-device (real and MockDeviceKit glasses) | Rolling buffer (30s free / up to 90s Pro) recorded from the glasses through the Meta Wearables Device Access Toolkit (MWDAT 1.0.1), "Clypso" wake word auto-saves the look-back clip, extended record-until-stop mode, local clip library, native share sheet. |
| **1b** | 🟡 built, not yet run on hardware | Full resolution: markers for every moment, import of the glasses' own 1520x2032 HDR recordings from Photos, passthrough cut, in-place upgrade of the 720p clip, glasses-only listening mode, HDR-preserving caption burn. Device procedure in [docs/MAX-RESOLUTION.md](docs/MAX-RESOLUTION.md). |
| **2** | 🟡 code-complete, credentials pending | All four connectors implemented behind `PublishTarget`: **YouTube Shorts** (Data API resumable upload; needs Google OAuth client + API verification), **Instagram Reels** (container flow; needs Business account + Meta App Review), **Facebook** (Page videos; same bundled Meta review — one submission), **TikTok** (Direct Post; sandbox-only until manual audit, posts reported private until then). `ClipHosting` seam has a vendor-neutral presigned-URL implementation (plus a dev-only mock). **Auto-captioning** runs every new clip through `CaptioningProvider` once capture stops — three styles (Hormozi / Clean / Boxed, picked in Settings), word-synced highlighting, progress shown on the library card. **On iOS this normally happens entirely on the phone** — Apple's Speech framework (on-device recognition) for word timings, AVFoundation for the burn — so there is no server, no API key and no audio leaving the device. Android, or an iOS device without on-device recognition, uses the self-hostable `server/captioning`; with neither available, dev builds use a mock captioner (labelled as such) and release builds mark the clip's captioning as failed, with the reason. **Hook-first edit** (`climaxScoring.ts` + `ClimaxEngine`) optionally rebuilds each clip so its strongest moment plays first — scored on loudness, motion and delivery, never sentiment. Toggle in Settings. Sandbox credentials paste into Settings → Connections. |
| **3** | ⛔ gated on Meta | Public store listing — blocked until MWDAT distribution status is confirmed in writing |

The publish flow enforces a per-clip preview + explicit consent step before anything leaves the device, and always surfaces the platform's **actual** post visibility (TikTok forces private during audit — the UI never lies about it).

## Repo layout

- `app/` — React Native (TypeScript) app, its iOS/Android projects, and the local `modules/clip-stitcher` native module. See [app/README.md](app/README.md) for setup and [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) for how it fits together.
- `server/` — Python reference implementations: `captioning/` (the HTTP captioning service) and `climax/` (the hook-first scorer the TypeScript port is parity-tested against).
- `docs/` — the full-resolution design ([MAX-RESOLUTION.md](docs/MAX-RESOLUTION.md)), architecture and video-quality notes.
- `brand/` — icon, wordmark and splash line-art sources.

## Running

```bash
cd app
./scripts/setup.sh          # JS deps, signing config, pods — re-run after every pull
open ios/Clypso.xcworkspace
```

No glasses? Run a Debug build in the iOS Simulator: the Connect screen pairs MockDeviceKit glasses that stream the bundled `MockFeed.mp4`. Settings → Voice trigger → **Manual button** replaces the spoken trigger with a tap. The real trigger uses Apple's speech recognition — keyless, nothing to configure. It runs on the phone first; a segment the on-device pass hears nothing in is retried on Apple's servers (`SpeechWakeWord.m`).
