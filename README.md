# Fade Away — Smart Glasses Auto-Clip

Mobile companion app (iOS + Android) for Meta smart glasses (Ray-Ban Meta, Oakley Meta HSTN, Ray-Ban Display), built for clippers/streamers.

**Core loop:** wearer says a trigger phrase → the app flushes the last N seconds from a rolling video buffer → clip lands in a local library → share via the native OS share sheet (free tier). Auto-captioning + one-tap publishing are the paid tier and live behind Phase 2 gates.

## Phase gating (non-negotiable build order)

| Phase | Status | Contents |
|-------|--------|----------|
| **1** | 🚧 in progress | MWDAT camera+mic session, rolling buffer (30–90s), on-device wake word (Porcupine), local clip library, native share sheet, Mock Device support |
| **2** | ⛔ not started | `CaptioningProvider` interface, cloud clip hosting, `PublishTarget` connectors (YouTube → IG/FB → TikTok) |
| **3** | ⛔ gated on Meta | Public store listing — blocked until MWDAT distribution status is confirmed in writing |

Phase 1 has **zero** external review dependencies and is the entire free tier. No connector code, no captioning API calls, no Graph API exists in this repo yet — by design.

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
