# Refactor handoff

Status of the whole-codebase refactor on branch `claude/laughing-curie-4r4s4g`, and the work still open.

## State

- The refactor (native, capture core, captioning/publishing, UI and repo) is in, and every review finding from the earlier passes is fixed: `git log --oneline 97b8d6a..HEAD`.
- Full resolution is the product goal and is built: markers for every moment, the import of the glasses' own 1520x2032 HDR recordings from Photos, the in-place upgrade of 720p clips, glasses-only mode and the HDR-preserving caption burn ([MAX-RESOLUTION.md](MAX-RESOLUTION.md)). Not yet run on hardware.
- JS: `npx tsc --noEmit -p .` clean, `npx jest` 318/318 (cold and warm cache), `npx eslint src __tests__ App.tsx` 0 errors and 6 warnings (listed below).
- `server/captioning`: `python3 -m unittest` 21/21.
- iOS: `pod install` (CocoaPods 1.16.2) is in sync with the lockfile, with no VisionCamera. The Clipso scheme builds with Xcode 27 for the Simulator (Debug) and for a generic iOS device (Release, unsigned), with no errors or warnings in `ios/Clipso`, `ios/ClipsoWidgets` or `modules/clip-stitcher/ios`. The Podfile lifts pod targets below the app's iOS 16.0 floor, because Xcode 27 rejects anything below 15.0.
- Simulator run (Debug, MockDeviceKit glasses, Mac microphone): Connect pairs the mock glasses and hands off to Armed. Capture arms and `Documents/clipso-diagnostics.log` shows `video input: 504x896 'hvc1' passthrough (no re-encode)`, `HEALTH fps=24.0 … resolution=high recording=YES`, and `rotating: … fps=24.0 mode=passthrough keyframes=11` every ~5.5 s. No `MEM footprint` lines. MockDeviceKit delivers compressed `hvc1`, so the Simulator exercises the passthrough writer. A failed arm runs 1 + 3 recovery attempts 4 s apart, then ends the Live Activity.

## Open work, in order

### 1. Run on a device with the glasses

Not done: the phone was offline. Build and run the Clipso scheme on the iPhone. First the full-resolution procedure in [MAX-RESOLUTION.md](MAX-RESOLUTION.md) ("Verifying on a device"), glasses-only mode then live mode, recording the concurrency-probe verdict there. Then:

- Arm, say "Clipso": a clip lands in the Library and the glasses chime twice.
- `Documents/clipso-diagnostics.log` has `'hvc1' passthrough`, `HEALTH fps=` and `rotating: … fps=`, and no `MEM footprint` lines.
- Fold the glasses briefly while armed: the Live Activity stays up through the automatic re-arm, and its clip count carries on (it does not reset to 0).
- Start an extended recording, go to the Library and play a clip, then stop the recording: the clip has sound to the end. While capture is live, the Player sets `disableAudioSessionManagement`, so playback runs in the writer's `playAndRecord` session; check it plays from the speaker. react-native-video still deactivates the session when the Player unmounts; the writer logs `audio engine stopped underneath the writer` and restarts the mic at the next rotation, so expect at most one segment without sound.

Signing: `ios/Config/Signing.xcconfig` is per-developer and untracked (see `Signing.xcconfig.example`). On a free Personal Team set `CLIPSO_ENTITLEMENTS =`; the Wi-Fi entitlements need a paid team.

### 2. Known capture race (not fixed)

`MWDATNative.stopRecording()` carries no session token. Every `CaptureController.disarm()` calls it, including the unmount disarm of an Armed screen that is already idle (Library "Go live" resets the stack). If that call reached the bridge after a newer session's `start()`, it would detach the new writer while JS reports 'armed'. In practice the old stop is issued first (the new session still has to read settings, render and call `prepare()`), so this has not been observed. The robust fix is a token from `start()` that `stopRecording()` must match, in `MWDATBridge.swift` and `MWDATSource.ts`.

Full Photos access ("All Photos") and Meta AI saving to Photos are prerequisites for the import. In the Simulator the import starts and raises the full-access prompt, but `simctl` cannot grant full Photos access and there is no Simulator.app GUI here to tap it, so the import was not exercised end to end outside the unit tests.

Build note: a Release build switches React Native's prebuilt core in `ios/Pods` to its release flavour, and a following Debug build then fails to link (missing `facebook::react` debug symbols). Reset with `printf Release > Pods/React-Core-prebuilt/.last_build_configuration` (same for `Pods/ReactNativeDependencies`) and run `node ../node_modules/react-native/scripts/replace-rncore-version.js -c Debug -r 0.86.0 -p "$PWD"` and `node ../node_modules/react-native/third-party-podspecs/replace_dependencies_version.js -c Debug -r 0.86.0 -p "$PWD"` from `ios/Pods`.

### 3. Android

`ClipStitcherModule.kt` changed since `be0c37c` and has not been compiled in this pass. Run `cd app/android && ./gradlew assembleDebug`.

### 4. Lint warnings left

- `src/phase2/CaptionQueue.ts`: `void` on the drain loop (no-void).
- `src/phase2/climaxScoring.ts`: two `>>` (no-bitwise). They mirror the Python scorer the port is parity-tested against.
- `src/ui/components.tsx`: three inline styles that carry Animated values or one-off geometry.

### 5. Optional, deliberately skipped

- The Live Activity starts at the first 'arming', so a first arm that never succeeds shows the banner for the ~12 s of recovery attempts. Starting it only once capture is live would lose it whenever that first arm completes in the background.
- One shared ObjC header for the `TrackHasContent`/`LoadAssetKeys` helpers duplicated across `ClipStitcher.m`, `SpeechWakeWord.m`, `CaptionEngine.m`, `ClimaxEngine.m`.
- Wake word: the possessive strip makes "that clip's so good" match "clip so" (product decision, see `phraseMatch.ts`).
- PlayerScreen labels `sourceKind: 'mock'` as "phone camera"; new mock clips come from the dev test render.
- `NSCameraUsageDescription` and the Android `CAMERA` permission stay until it is confirmed that no linked framework requests iPhone camera access.
