# App Review note — photo library access

Paste into the "Notes" field of the App Store Connect submission, alongside the
demo account.

---

**Why Clypso asks for full photo library access, and why "Selected Photos" cannot
work for this feature.**

Clypso clips moments from video recorded by Meta smart glasses. The glasses
record to their own onboard storage; the Meta AI app then syncs each finished
recording into the user's photo library. There is no API that reaches the
glasses' storage directly — the Meta Wearables Device Access Toolkit exposes a
live camera stream and nothing else — so the photo library is the only place
those recordings can be read from.

While the user is wearing the glasses, Clypso listens on-device for the trigger
word and writes down the wall-clock moment it was spoken. Nothing is recorded
and nothing is uploaded. Later, when a recording appears in the library, Clypso
matches those saved moments against the recording's capture time and copies out
only the seconds around them.

**Limited access is not a reduced version of this feature — it is a silent
failure.** Under "Selected Photos", an app sees only assets the user picked by
hand, at the moment they picked them. The recordings Clypso needs do not exist
yet at selection time: they are written by Meta AI hours later, in the
background, while the app is not running. There is no selection the user could
make that would include them.

Because that failure is invisible from inside the app — every API call succeeds,
the scan simply finds nothing, forever — Clypso **refuses to turn the feature on
under limited access** and explains why, rather than accepting the switch and
never producing a clip. If access is downgraded later, the feature stops and a
warning appears in Settings. The rest of the app works normally without any
photo access at all.

**Scope of use.** Clypso only ever reads, and only ever from videos a saved
trigger moment already points into. Recordings the user did not mark are never
opened. Nothing in the library is modified, moved, or deleted. `PHAccessLevel`
is `ReadWrite` because that is the only level iOS offers that permits reading;
`AddOnly` grants writes and no reads.

---

## Implementation

- Gate: `app/src/markers/photoAccess.ts` (`photoAccessBlocker`) — the single
  place that decides whether the feature can run, and the copy shown when it
  cannot.
- Enforcement: `app/src/services/glassesImport.ts` — refuses to enable, and
  re-checks on every foreground via `currentAccess()`, which never prompts.
- Native: `app/modules/clip-stitcher/ios/GlassesMediaLibrary.m`.
- Tests: `app/__tests__/glassesImport.test.ts`.
- Usage string: `NSPhotoLibraryUsageDescription` in `app/ios/Clypso/Info.plist`.
