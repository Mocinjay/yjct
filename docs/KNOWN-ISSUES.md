# Known issues

A register of failure modes that cost real time to diagnose, so they are
diagnosed once. One section per issue, newest first.

Each entry records the **symptom as reported**, what it actually was, what was
ruled out on the way (so the same dead ends are not walked twice), and the
general rule worth carrying forward. An entry stays here after it is fixed —
the value is in the diagnosis, not in the open/closed state.

**Flagged rules** are collected at the bottom. Read that list before adding an
error path, a native entry point, or a screen that reports device state.

---

## 0. Meta AI "Internal error": registration stalled in `registering`, with no way out — FIXED

**Status:** fixed 2026-08-29. `app/ios/Clypso/MWDATBridge+Setup.swift`,
`MWDATBridge.m`, `app/src/native/MWDATNative.ts`,
`app/src/ui/screens/ConnectScreen.tsx`.

### What it is

`RegistrationState` has four values: `unavailable`, `available`, `registering`,
`registered`. **`registering` is sticky.** The SDK enters it when Meta AI is
handed control and leaves it only when the callback comes back — so an approval
the wearer abandoned, or a hand-back that never arrived, parks the app there
with nothing that expires it.

Tapping "Connect through Meta AI" from that state calls `startRegistration()`
on top of a request that is already pending. Meta AI answers with its own

> **Internal error — The operation could not be completed**

instead of the approval page, and every further tap repeats it. The device log
is the whole story in two lines:

```
02:31:01 startRegistration(): scheme=… state=available
02:31:09 startRegistration(): scheme=… state=registering   <- second tap, already pending
```

`MWDATCore` has always shipped `startUnregistration()`. **Nothing in the app
called it**, and no screen offered it, so a stalled link had no exit short of
deleting the app.

### How it worked before

The first tap, from a clean `available`, works. It is the second and every
subsequent one that cannot — so the flow works right up until something
interrupts one attempt, and then never again.

### The fix

- **`startRegistration` refuses to re-enter.** `registered` resolves
  immediately (asking anyway throws `.alreadyRegistered`); `registering`
  rejects with a message naming the reset instead of launching a request that
  cannot succeed.
- **`unregister()` exposed** through the bridge, calling
  `Wearables.startUnregistration()`. `.alreadyUnregistered` resolves rather
  than rejects — that is the state the caller wanted.
- **"Reset the Meta AI link"** on the Connect screen while unregistered. Kept
  beside "Skip to library": it is a repair, not a step in the flow.
- **`RegistrationError` is a typed throw and is now read as one.** Each of
  `alreadyRegistered` / `configurationInvalid` / `metaAINotInstalled` /
  `networkUnavailable` / `timeout` / `unknown` gets its own advice. Previously
  all six produced `error.localizedDescription` followed by the same blanket
  "Is the Meta AI app installed with Developer Mode on?", which gave a dead
  network and a malformed Info.plist the same sentence.

### Two wrong diagnoses on the way, and why

Both were plausible, both had supporting evidence, and both were wrong. The
wrong turns are the reusable part.

**"The rename moved the URL scheme Meta has registered."** `5e25bfb` did change
`AppLinkURLScheme` from `jarvis://` to `clypso://`, and its own comment
predicted that would break registration until a matching change landed on the
Meta side. It reads as a confession. It is not one: with `MWDAT.MetaAppID = 0`
the scheme is only a callback target, not something pre-registered with Meta,
and the log showed `registration=registered` under `clypso://`. **Reverting to
`jarvis://` on the strength of that comment broke a registration that worked** —
it stalled at `registering` with no callback. Reverted; the plist now carries
the history so nobody restores it again. → rule R7.

**"A per-device permission asked with no device."** `prepare()` did call
`requestPermission(.camera)` without checking `devices`, and camera permission
is granted per glasses, so that request is unanswerable with none connected.
Real defect, guard kept. But it is not the reported symptom: `prepare()` only
runs once `ConnectScreen` has a device, so with `Glasses: none found` it is
never reached. The bounce the wearer was hitting was `startRegistration()`.
→ rule R10.

### Ruled out on the way

| Suspected | Verdict |
|---|---|
| Registration never starting | **No.** The log shows `available` → `registering`. It starts; it does not finish. |
| The `5e25bfb` URL-scheme change | **No** — and reverting it actively broke registration. |
| The `5e25bfb` bundle-id change | **Not implicated.** Registration succeeded under the new bundle id, which is what `MetaAppID = 0` is for. Left alone. |
| `MetaAppID` changed in the rename | **No.** `0` before and after. |
| Missing `Info.plist` keys, unwired `handleOpenURL`, a JS crash | **No.** All checked; see issue 1. |

### Reproducing it

Tap "Connect through Meta AI", then leave Meta AI without approving. The app is
now in `registering`. Every further tap returns Meta AI's internal error.
"Reset the Meta AI link" clears it.

---

## 1. "Internal error" in Meta AI during the camera-permission bounce — FIXED

**Status:** fixed, 2026-08-29. `app/ios/Clypso/MWDATBridge+Setup.swift`,
`app/ios/Clypso/MWDATBridge.swift`.

### Symptom as reported

> internal error in the connect meta screen page

Screenshotted: a dark modal reading **"Internal error / The operation could not
be completed"** with a single OK button.

**The dialog is Meta AI's, not ours.** The status bar carries the `◀ Clypso`
breadcrumb, which iOS shows in the app that was *launched by* Clypso — so the
foreground app is Meta AI, mid-handshake. Nothing in Clypso renders a modal
like this; `ConnectScreen` reports failures as inline text. That one detail is
what redirected the whole investigation, and it is worth checking first on any
report phrased as "error in <our screen>".

### What it actually was

Three defects stacked on one path, and the middle one is why it took two passes
to find.

**a. `prepare()` treated a failed permission request as success.**

`ConnectScreen` calls `prepare()` then `startPreview()`. `prepare()` checks
camera permission and, when it is not granted, calls
`Wearables.requestPermission(.camera)` — *this* is the call that leaves the app
and opens Meta AI, not `startRegistration()`. It was written as:

```swift
let granted = await Self.withTimeout(seconds: 120) {
  try? await wearables.requestPermission(.camera)   // throw -> nil
}
if granted == .denied { reject(...) } else { resolve(nil) }
```

`try?` flattened a thrown SDK error into the same `nil` as a timeout, and the
`else` resolved both as success. So Meta AI failing with "Internal error" and
the wearer simply being slow were indistinguishable, and both let the pipeline
continue as if permission had been granted.

**b. `startPreview()` truncated the log that held the evidence.**

`DiagnosticLog.reset()` sat at the top of `startPreview()` — one call after
`prepare()`. Since the two are always called in that order, every run erased
the entire Meta AI permission round trip immediately after it happened. The
device log therefore opened at `startPreview() called`, with no trace of the
step that actually failed:

```
2026-08-30T01:44:24Z [MWDAT] startPreview() called          <- log begins here
2026-08-30T01:44:24Z [MWDAT] openPipeline: registration=registered devices=1
2026-08-30T01:44:24Z [MWDAT] auto-selector undecided — waiting up to 10s…
2026-08-30T01:44:34Z [MWDAT] auto-selector never resolved and device list empty
2026-08-30T01:44:34Z [MWDAT] createSession…
2026-08-30T01:44:34Z [MWDAT] startPreview() FAILED: No eligible device available
```

That log is also what disproved the first diagnosis: `registration=registered`
means the link was already established and registration was never the problem.

**c. `openPipeline` created a session on a selector it knew was unresolved.**

Read the log above against the code: `devices=1` on entry, so the empty-list
guard (and its good error message) is skipped. Ten seconds later the
auto-selector has not resolved *and* the device list has gone empty — the
glasses dropped off mid-wait. The `else` branch logged exactly that and then
fell through to `selector = auto` and `createSession(...)` anyway. The SDK
answered with its own "No eligible device available", which names nothing the
wearer can act on, while the actionable message for that precise state was
already written thirty lines above.

### The fix

- `prepare()` maps the round trip onto a `PermissionOutcome`
  (`granted` / `denied` / `inconclusive` / `failed`) instead of `try?` plus a
  boolean. A **thrown** error now rejects and names Meta AI as the failing side;
  an inconclusive status or a timeout still continues, because a genuinely
  missing permission resurfaces later as `StreamError.permissionDenied`, which
  names itself properly.
- `DiagnosticLog.reset()` moved out of `startPreview()` entirely and into
  `MWDATBridge.init()` — once per app session. Moving it to `prepare()` was the
  first attempt and it was wrong for the same reason: `prepare()` is the start
  of a *capture* run but the middle of a *link* run, so it would then have
  erased `startRegistration()`'s output instead. There is no per-operation
  entry point that is not somebody else's middle. The 2 MB cap handles growth.
- Every log now opens with `bridge init: bundle=… appLinkScheme=…`. Working out
  which identity a build was actually carrying cost more than one debugging
  round; it is now the first line.
- `openPipeline` re-reads the device list after the selector wait, waits up to
  20s for the glasses to come back, and raises the existing "No glasses found"
  message rather than creating a doomed session. That wording now lives in one
  helper used by both places that can discover the condition.

### Ruled out on the way

Each looked plausible and cost time:

| Suspected | Verdict |
|---|---|
| `MWDAT.MetaAppID` is `"0"` — a placeholder? | **No.** `AGENTS.md:182` — *"Use `0` for `MetaAppID` during development with Developer Mode."* |
| `MWDAT.TeamID` is `$(DEVELOPMENT_TEAM)` and expands to empty | **No.** The built `Clypso.app/Info.plist` resolves it to `NWX6ZCX32V`. Always check the *built* plist, not the source one. |
| Missing `Info.plist` keys stopping callback delivery | **No.** URL scheme, `fb-viewapp`, accessory protocol, background modes and the Bluetooth description are all present. |
| `handleOpenURL` not wired to the app delegate | **No.** `AppDelegate.swift:60`. |
| A JS crash on the screen | **No.** `tsc`, `eslint` and 248 tests are clean, and `ConnectScreen` has no modal. |
| Registration failing | **No.** The device log says `registration=registered`. See issue 2 — a real gap on that path, but not this. |

### Reproducing it

The trigger is glasses that are registered but drop off `Wearables.devices`
during the handshake — folded, asleep, out of range, or claimed by another app.
Open Connect with the glasses paired in Meta AI but folded on the desk.

Pull the log; it now covers `prepare()` as well:

```bash
xcrun devicectl device copy from --device <UDID> --domain-type appDataContainer \
  --domain-identifier com.mocinjay.clypso \
  --source Documents/clypso-diagnostics.log --destination /tmp/
grep -E "prepare\(\)|openPipeline|waitForDevice" /tmp/clypso-diagnostics.log
```

---

## 2. Registration callback: a failed Meta AI *link* reported nothing — FIXED

**Status:** fixed, 2026-08-29. `app/ios/Clypso/MWDATBridge.swift`,
`app/src/ui/screens/ConnectScreen.tsx`.

> **This was not the bug in issue 1**, though it was found while chasing it and
> presents identically. The first diagnosis assumed the Meta AI bounce being
> reported was *registration*; the device log later showed
> `registration=registered` and put the failure in the *permission* bounce
> instead. This entry is a real gap on the registration path, fixed on its own
> merits, and the two are worth keeping apart: the app makes two different
> round trips into Meta AI and either can fail silently.

### Symptom

The wearer taps **Connect through Meta AI** on `ConnectScreen`, is bounced into
the Meta AI app, and Meta AI fails. Back in Clypso, the Connect screen looks
exactly as they left it: `Meta AI link: notRegistered`, the same button, no
message. Nothing says the link was attempted, let alone why it failed.

### What it actually was

`MWDATBridge.handleOpenURL(_:)` caught the failure and only logged it.

```swift
// before
} catch {
  log("handleOpenURL(\(redacted)) FAILED: \(error)")
}
```

The comment directly above that block already stated the intent — *"Swallowing
the error leaves 'internal error' on the Meta AI side as the only symptom, with
nothing on ours, so surface the typed error and the state it left"* — and the
surfacing was never written. The comment described the bug rather than the code.

Three things have to line up for this to be invisible, and they all did:

1. **`startRegistration()` cannot report it.** It resolves when Meta AI is handed
   control, not when Meta AI is done — `AGENTS.md` line 676: *"This opens the
   Meta AI app where the user approves your app. Meta AI then calls back via your
   URL scheme."* So the promise `ConnectScreen.connect()` awaits has already
   settled, successfully, before the outcome exists.
2. **No registration-state listener fires.** A registration that fails changes no
   state. `addRegistrationStateListener` is a *transition* callback, so the
   success path is covered and the failure path is not.
3. **The 2s poll reports the same thing it reported before the bounce.**
   `notRegistered` before, `notRegistered` after. Nothing distinguishes "not
   tried yet" from "tried and failed".

`handleOpenURL` is the only place that knows, and it threw the knowledge away.

### The fix

Surface it, using the `current` weak bridge handle that the app-lifecycle hooks
already use for exactly this kind of static-context reach-back:

- The `catch` now records the typed error, and a `handled == false` return is
  treated the same way — the SDK taking the callback without completing the link
  is just as silent.
- After the callback settles, if the registration state is still not
  `.registered`, `reportRegistrationFailure` emits `MWDATError` with the reason,
  the state it left, and where to look in Meta AI.
- `useGlassesDiagnostics` already routes `MWDATError` to `setError`, and
  `ConnectScreen` already renders it, so no new plumbing was needed on the JS
  side.
- `ConnectScreen` clears that message when registration transitions to
  registered — keyed on the transition, so a genuine failure raised *while*
  registered still stands.

### Ruled out on the way

Recorded because each looked plausible and cost time:

| Suspected | Verdict |
|---|---|
| `MWDAT.MetaAppID` is `"0"` in `Info.plist` — a placeholder? | **No.** `AGENTS.md` line 182: *"Use `0` for `MetaAppID` during development with Developer Mode."* Correct as-is. |
| Missing `Info.plist` keys stopping the callback being delivered | **No.** `CFBundleURLTypes` (`clypso`), `LSApplicationQueriesSchemes` (`fb-viewapp`), `UISupportedExternalAccessoryProtocols`, `UIBackgroundModes`, `NSBluetoothAlwaysUsageDescription` are all present and correct. |
| `handleOpenURL` not wired to the app delegate | **No.** `AppDelegate.swift:60` forwards `application(_:open:options:)`. |
| A JS crash on the screen (`device.compatibility.toLowerCase()` on a missing field) | **No.** `diagnosticsPayload()` always populates every device key. `tsc` and `eslint` are clean. |
| Another swallowed error path in the bridge | **No.** Every other `catch` in `MWDATBridge.swift` reaches `reject(...)`. `handleOpenURL` was the only one, for the reason in rule R1. |

### Reproducing it

Hard to force on purpose — it needs Meta AI to fail the approval. The reliable
route is to attempt the link with Clypso **disabled** under Meta AI → Settings →
App connections, or with Developer Mode off. Before the fix: silence. After:
the Connect screen shows what happened and what to check.

The diagnostics log carries it either way:

```bash
xcrun devicectl device copy from --device <UDID> --domain-type appDataContainer \
  --domain-identifier com.mocinjay.clypso \
  --source Documents/clypso-diagnostics.log --destination /tmp/
grep handleOpenURL /tmp/clypso-diagnostics.log
```

---

## Flagged rules

Carried forward from the entries above. These are the general shapes, not the
specific bugs.

### R1 — A native entry point that JS did not call has no promise to reject

The RN bridge's error reporting is promise-shaped: every `RCT_EXTERN_METHOD`
gets a `reject` block, and every failure inside one is covered for free. That
makes it easy to miss the entry points that **are not JS calls** — URL
callbacks, app-delegate lifecycle hooks, SDK listeners, background tasks. They
have no promise, so an error there reaches JS only if someone explicitly emits
an event.

Before merging a native `catch`, ask: *what called this?* If the answer is not
"JavaScript", `reject` is not available and logging is not reporting. Emit an
event, via the `current` weak instance handle if the context is static.

> Issue 1 is this rule. `handleOpenURL` was the single non-JS-initiated entry
> point in `MWDATBridge`, and the single one that lost its errors.

### R2 — Failure is not always a state change, so a state listener will not see it

`addRegistrationStateListener`, `registrationStateStream()` and the diagnostics
poll all report **state**. An operation that fails without moving the state
machine is invisible to every one of them: the "before" and the "after" read
identically, and no callback fires.

Any UI that infers "did my action work?" from polled state needs a separate
error channel for the attempts that leave no trace. `ConnectScreen`'s status
rows are state; the error line under them is that channel.

### R3 — A comment describing what should happen is not evidence that it does

The `handleOpenURL` comment stated the correct intent, in the right place, and
the code under it did the opposite. It had been read past more than once —
the comment is reassuring enough to stop the reader looking.

When a comment claims an error is surfaced, propagated, retried or cleaned up,
follow the value to the place it is supposed to arrive before believing it.

### R4 — Truncate a log at the start of the run, not in the middle of it

`DiagnosticLog.reset()` was one call too late in a fixed two-call sequence, so
it destroyed the output of the step before it — every single run, including the
one being debugged. The symptom is a log that opens partway into a flow with no
sign of what preceded it.

The first fix for this moved the reset one call earlier, to `prepare()` — and
that was still wrong, because `prepare()` starts a capture run but sits in the
middle of a link run, so it would have erased the registration step instead.

There is usually no per-operation entry point that is not some longer
operation's middle. Reset once per **session** — at construction, at launch —
and let a size cap handle growth. And if a log is the thing you debug with,
have it open by stating the configuration it is describing.

### R5 — `try?` is not error handling when the caller has to tell outcomes apart

`try? await requestPermission(.camera)` produced `nil` for a thrown SDK error
and `nil` for a timeout, and the caller then treated both as success. Three
distinct outcomes collapsed into one, and the one that mattered — a remote app
reporting failure — was the one lost.

Use `try?` only where every failure genuinely warrants the same response. If a
`nil` is about to be compared against a success value, that is the tell.

### R6 — Check which app the screenshot is actually of

The report said "error in the connect meta screen page" and the dialog was
Meta AI's. iOS's `◀ AppName` status-bar breadcrumb names the app that launched
the current one, so its presence means the foreground app is *not* the one it
names. Style is the other tell: this alert had a full-width gradient button,
which is not a `UIAlertController`.

### R7 — A comment predicting a failure is not evidence of that failure

`5e25bfb` left a comment saying the URL-scheme change **WILL** break
registration. It reads as a confession and it pointed straight at a plausible
culprit. Acting on it broke a registration that the log, in the same directory,
showed was working — because the comment described a production `MetaAppID`
setup and this is a Developer Mode one.

A comment is a claim about the code by someone who was not watching it run.
When a log can confirm or deny it, read the log first. This is R3 with the
sign flipped: R3 is a comment that promises something the code does not do,
R7 is a comment that promises a breakage the code does not have.

### R8 — "It worked before" does not always mean something in the repo changed

Two rounds went into bisecting config on the assumption that a regression must
have a commit behind it. This one did not. The environment changed: the glasses
stopped being connected, and a request that is only answerable with a device
attached stopped being answerable.

`git log` is the right first move, but when the diff yields a suspect, confirm
it against runtime state before acting. State the app already reports — here a
status row reading `Glasses: none found`, and a log line reading
`device list empty` — outranks a plausible-looking diff.

### R10 — Two bounces into the same app are two different failures

The app hands control to Meta AI twice — once to register, once to grant camera
permission — and both come back as the same alert in the same app. That made
one symptom look like one bug for three rounds. The permission path had a real
defect (asking for a per-device grant with no device) and fixing it changed
nothing, because with no device the screen never reaches that call.

When a flow leaves the app more than once, establish **which** departure failed
before fixing either. A log line at each exit, naming the call and the state it
left from, does it in one run — that is what `startRegistration(): state=…`
was added for, and it settled this immediately.

### R9 — Read the screen the user sent you

`Glasses: none found` was in the screenshot, in the status card, in the colour
the app uses for "bad". It was also in the log twice. It went unread through two
diagnoses because it looked like a consequence of the failure being chased
rather than its cause.

Before theorising, inventory every piece of state already visible and account
for each one. A row that contradicts the current theory is the cheapest
disproof available.
