# Fade Away — Smart Glasses Auto-Clip

Mobile companion app (iOS + Android) for Meta smart glasses (Ray-Ban Meta, Oakley Meta HSTN, Ray-Ban Display), built for clippers/streamers.

**Core loop:** wearer says a trigger phrase → the app flushes the last N seconds from a rolling video buffer → clip lands in a local library → share via the native OS share sheet (free tier). Auto-captioning + one-tap publishing are the paid tier and live behind Phase 2 gates.

## Phase gating (non-negotiable build order)

| Phase | Status | Contents |
|-------|--------|----------|
| **1** | ✅ working on-device (mock glasses) | Rolling buffer (30s free / 60–90s Pro), "fade away" wake phrase auto-saves the look-back clip, extended record-until-stop mode, local clip library, native share sheet, Mock Device support. MWDAT bridge still stubbed pending Meta toolkit access. |
| **2** | 🟡 code-complete, credentials pending | All four connectors implemented behind `PublishTarget`: **YouTube Shorts** (Data API resumable upload; needs Google OAuth client + API verification), **Instagram Reels** (container flow; needs Business account + Meta App Review), **Facebook** (Page videos; same bundled Meta review — one submission), **TikTok** (Direct Post; sandbox-only until manual audit, posts reported private until then). `ClipHosting` seam has a vendor-neutral presigned-URL implementation + mock. Captioning remains a mock behind `CaptioningProvider` (real infra is external). Sandbox credentials paste into Settings → Connections. |
| **3** | ⛔ gated on Meta | Public store listing — blocked until MWDAT distribution status is confirmed in writing |

The publish flow enforces a per-clip preview + explicit consent step before anything leaves the device, and always surfaces the platform's **actual** post visibility (TikTok forces private during audit — the UI never lies about it).

## Repo layout

- `app/` — React Native (TypeScript) app. See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).
- `docs/` — architecture + phase notes.

## Running (Phase 1, mock device)

```bash
cd app
npm install
# iOS
cd ios && bundle install && bundle exec pod install && cd ..
npx react-native run-ios
# Android
npx react-native run-android
```

The app runs end-to-end with **no glasses hardware**: the mock device source uses the phone camera as the stand-in glasses feed, and the mock wake-word provider gives you a manual trigger button. Set a Picovoice access key in Settings to enable the real on-device wake word.
