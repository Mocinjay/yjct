# Clypso

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
open ios/Clypso.xcworkspace
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
put your team ID back into `Clypso.xcodeproj/project.pbxproj` — that is exactly
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

---

The rest of this file is the stock React Native template documentation.

# Getting Started

> **Note**: Make sure you have completed the [Set Up Your Environment](https://reactnative.dev/docs/set-up-your-environment) guide before proceeding.

## Step 1: Start Metro

First, you will need to run **Metro**, the JavaScript build tool for React Native.

To start the Metro dev server, run the following command from the root of your React Native project:

```sh
# Using npm
npm start

# OR using Yarn
yarn start
```

## Step 2: Build and run your app

With Metro running, open a new terminal window/pane from the root of your React Native project, and use one of the following commands to build and run your Android or iOS app:

### Android

```sh
# Using npm
npm run android

# OR using Yarn
yarn android
```

### iOS

For iOS, remember to install CocoaPods dependencies (this only needs to be run on first clone or after updating native deps).

The first time you create a new project, run the Ruby bundler to install CocoaPods itself:

```sh
bundle install
```

Then, and every time you update your native dependencies, run:

```sh
bundle exec pod install
```

For more information, please visit [CocoaPods Getting Started guide](https://guides.cocoapods.org/using/getting-started.html).

```sh
# Using npm
npm run ios

# OR using Yarn
yarn ios
```

If everything is set up correctly, you should see your new app running in the Android Emulator, iOS Simulator, or your connected device.

This is one way to run your app — you can also build it directly from Android Studio or Xcode.

## Step 3: Modify your app

Now that you have successfully run the app, let's make changes!

Open `App.tsx` in your text editor of choice and make some changes. When you save, your app will automatically update and reflect these changes — this is powered by [Fast Refresh](https://reactnative.dev/docs/fast-refresh).

When you want to forcefully reload, for example to reset the state of your app, you can perform a full reload:

- **Android**: Press the <kbd>R</kbd> key twice or select **"Reload"** from the **Dev Menu**, accessed via <kbd>Ctrl</kbd> + <kbd>M</kbd> (Windows/Linux) or <kbd>Cmd ⌘</kbd> + <kbd>M</kbd> (macOS).
- **iOS**: Press <kbd>R</kbd> in iOS Simulator.

## Congratulations! :tada:

You've successfully run and modified your React Native App. :partying_face:

### Now what?

- If you want to add this new React Native code to an existing application, check out the [Integration guide](https://reactnative.dev/docs/integration-with-existing-apps).
- If you're curious to learn more about React Native, check out the [docs](https://reactnative.dev/docs/getting-started).

# Troubleshooting

If you're having issues getting the above steps to work, see the [Troubleshooting](https://reactnative.dev/docs/troubleshooting) page.

# Learn More

To learn more about React Native, take a look at the following resources:

- [React Native Website](https://reactnative.dev) - learn more about React Native.
- [Getting Started](https://reactnative.dev/docs/environment-setup) - an **overview** of React Native and how setup your environment.
- [Learn the Basics](https://reactnative.dev/docs/getting-started) - a **guided tour** of the React Native **basics**.
- [Blog](https://reactnative.dev/blog) - read the latest official React Native **Blog** posts.
- [`@facebook/react-native`](https://github.com/facebook/react-native) - the Open Source; GitHub **repository** for React Native.
