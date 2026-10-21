# Clipso

React Native app for capturing clips from Meta glasses via the Meta Wearables
Device Access Toolkit (MWDAT).

## Setup — run this after every fetch

```bash
cd app
./scripts/setup.sh
```

It is idempotent, and it stops with an explanation instead of guessing whenever
something needs you. Then open the **workspace**, never the project:

```bash
open ios/Clipso.xcworkspace
```

### Why a fetch can break your build

Three things are deliberately not in git, so a fresh checkout is never complete
on its own:

| Missing | Symptom | Fix |
| --- | --- | --- |
| `ios/Config/Signing.xcconfig` | `Bundle identifier is missing` | `setup.sh` creates it from the example; fill in your own team + bundle ID |
| `ios/Pods` out of sync | `The sandbox is not in sync with the Podfile.lock` | `setup.sh` runs `pod install` |
| `ios/.xcode.env.local` | script phase can't find `node` | `setup.sh` writes it |

**Signing is per-developer on purpose.** A bundle identifier registered to one
Apple Developer team cannot be signed by another, so committing a team ID breaks
every other developer with `No profiles for '<bundle id>' were found`. Do not
put your team ID back into `Clipso.xcodeproj/project.pbxproj` — that is exactly
what `Signing.xcconfig` exists to prevent.

**`Podfile.lock` churn is expected.** Several React Native pods
(`hermes-engine`, `React-Core-prebuilt`, `Yoga`) are prebuilt artifacts whose
checksums differ per machine, so the lockfile changes whenever either of us runs
`pod install`. That is why the fix is re-running `pod install` after a pull, not
reverting the lockfile.

### Toolchain

Mismatched versions are the usual cause of "works on mine, not on yours":

| | Version |
| --- | --- |
| React Native | 0.86.0 |
| Node | >= 22.11.0 (`engines` in `package.json`) |
| Xcode | 26.x |
| Ruby | system Ruby 2.6 is **too old** for this Gemfile — install a modern Ruby via Homebrew |

### Day to day

```bash
npm start                  # Metro (Debug builds started from Xcode open it for you)
npm test                   # Jest
npx tsc --noEmit -p .      # type check
npm run lint
```

Build and run from Xcode (the workspace). With no glasses, a Debug build in the
iOS Simulator pairs MockDeviceKit glasses automatically and streams the bundled
`ios/Clipso/MockFeed.mp4`; Settings → Voice trigger → **Manual button** gives a
tap trigger. Android builds, but glasses capture is iOS-only for now.

The Python reference implementations in `../server` have their own tests:
`cd ../server/captioning && python3 -m unittest`.
