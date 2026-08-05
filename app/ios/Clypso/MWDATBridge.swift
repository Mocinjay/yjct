import CoreImage
import CoreMedia
import Foundation
import MWDATCamera
import MWDATCore
import MWDATMockDevice
import React
import UIKit

/// React Native bridge for the Meta Wearables Device Access Toolkit.
///
/// Pipeline model: `startPreview()` opens the glasses session + camera stream
/// and emits throttled JPEG preview frames; `start(segmentSeconds)` attaches
/// the segment writer (and glasses-mic audio) to the same live stream. So the
/// Connect screen can show the wearer's view first, and arming upgrades the
/// running stream to recording without renegotiating the glasses link.
@objc(MWDATBridge)
final class MWDATBridge: RCTEventEmitter {
  private enum Event {
    static let segment = "MWDATSegment"
    static let error = "MWDATError"
    static let streamState = "MWDATStreamState"
    static let registrationState = "MWDATRegistrationState"
    static let devices = "MWDATDevices"
    static let previewFrame = "MWDATPreviewFrame"
    static let streamHealth = "MWDATStreamHealth"
  }

  /// Wearables.configure() must run exactly once per process.
  private static let configureResult: Result<Void, Error> = Result {
    try Wearables.configure()
  }

  /// Long-lived selector: it resolves its active device *asynchronously*
  /// after creation, so it must outlive any single session attempt. Creating
  /// a fresh selector and using it immediately yields "no eligible device"
  /// even with connected, compatible glasses.
  private var deviceSelector: AutoDeviceSelector?

  private var deviceSession: DeviceSession?
  /// Internal, not private: read by the MWDATBridge+Setup extension, which
  /// Swift scopes to a different file.
  var stream: MWDATCamera.Stream?

  /// In-flight pipeline open so concurrent callers coalesce onto one attempt.
  /// `openPipelineIfNeeded()` is reachable from `startPreview()`, `start()`,
  /// the retry button, and any React effect that re-fires — and it tears the
  /// existing session down before rebuilding. A second caller mid-negotiation
  /// used to stop the first (stop chime), create another (start chime), then
  /// the first failure tore *that* one down: a self-sustaining restart loop.
  private var openTask: Task<Void, Error>?

  /// Consumes the session state stream for the life of the session. Held so
  /// teardown can cancel it — an orphaned consumer from a previous attempt is
  /// one of the ways a dead session keeps driving live logic.
  private var sessionStateTask: Task<SessionStartOutcome, Never>?

  private var listenerTokens: [any AnyListenerToken] = []
  private var observerTokens: [any AnyListenerToken] = []
  var writer: MWDATSegmentWriter?
  /// Set while stop() is tearing down, so device-initiated state changes can
  /// be told apart from our own.
  private var stopping = false

  /// Last error the stream reported, captured so a start failure can name the
  /// actual SDK cause (hingesClosed, permissionDenied, videoStreamingError…)
  /// instead of a generic timeout.
  private var lastStreamError: MWDATCamera.StreamError?

  /// `.stopped` is the state a freshly created stream sits in *before*
  /// `start()` has taken effect, and also the terminal state after a real
  /// stop. The two are indistinguishable from the value alone, so a `.stopped`
  /// reading only means "failed" once the stream has been seen to leave it.
  private var streamHasLeftStopped = false

  /// Dev-only MockDeviceKit glasses: exercises the real session/stream code
  /// paths without hardware or the Meta AI app. Skips the registration guard.
  var mockActive = false
  private var mockGlasses: (any MockGlasses)?

  /// Frame encoding and the stall watchdog, each owning its own queue and
  /// state. Built lazily so `self` can be captured in their callbacks.
  private lazy var preview = MWDATPreviewEncoder(
    onFrame: { [weak self] base64 in
      self?.sendEvent(withName: Event.previewFrame, body: ["base64": base64])
    },
    log: { Self.log($0) }
  )

  private lazy var health = MWDATStreamHealth(
    onSample: { [weak self] sample in
      guard let self else { return }
      self.sendEvent(
        withName: Event.streamHealth,
        body: [
          "fps": sample.fps,
          "secondsSinceFrame": sample.secondsSinceFrame,
          "recording": self.writer != nil,
        ]
      )
    },
    onTransition: { [weak self] transition in
      guard let self else { return }
      switch transition {
      case .recovered:
        Self.log("frames RESUMED after stall")
        self.sendEvent(
          withName: Event.streamState,
          body: ["state": "streaming", "reason": "recovered"]
        )
      case let .stalled(sinceFrame):
        Self.log(String(format: "STALL — no glasses frame for %.1fs", sinceFrame))
        self.sendEvent(
          withName: Event.error,
          body: [
            "message": "The glasses feed stalled — no video for "
              + "\(Int(sinceFrame))s. Check they are unfolded, being worn and in range.",
          ]
        )
      }
    },
    isStopping: { [weak self] in self?.stopping ?? true }
  )

  /// NSLog rather than print: it reaches the unified logging system, so
  /// `log stream --device` shows the glasses handshake live during field
  /// debugging without needing a console attached (the devicectl console
  /// drops the connection during long capture runs).
  static func log(_ message: String) {
    NSLog("[MWDAT] %@", message)
    DiagnosticLog.write("[MWDAT] \(message)")
  }

  /// Lets the JS logger append to the same on-device diagnostics file the
  /// native side writes.
  ///
  /// The two halves of a capture run — the glasses handshake below the bridge
  /// and the capture state machine above it — were previously in two places
  /// that could not be read together: one in a file pulled off the device, the
  /// other only in a Metro console that is not attached during field testing.
  /// A dropped link shows up on both sides, and correlating them meant guessing
  /// at the ordering.
  @objc(writeDiagnostic:)
  func writeDiagnostic(_ line: String) {
    DiagnosticLog.write(line)
  }

  // MARK: - App lifecycle

  /// Weak handle to the live bridge instance so the app delegate can release
  /// the glasses session on background/terminate. Without this the session and
  /// stream leak when the app is killed, and the glasses keep the capture slot
  /// held until they are power-cycled — every later start then fails.
  private static weak var current: MWDATBridge?

  override init() {
    super.init()
    MWDATBridge.current = self
  }

  /// True while segments are actually being written — i.e. the wearer is armed
  /// and the rolling buffer is live. A preview-only session has a stream but no
  /// writer, and nothing is lost by dropping that one on background.
  @objc static var isCapturing: Bool { current?.writer != nil }

  @objc static func releaseGlassesForAppLifecycle(_ reason: String) {
    guard let bridge = current, bridge.deviceSession != nil || bridge.stream != nil else { return }
    // Backgrounding while armed is the whole point of the product: the wearer
    // is out in the world with the phone in a pocket. Tearing down here is
    // what made "say Clypso while using another app" impossible, so an active
    // capture now keeps the session. Preview-only sessions still release —
    // they hold the glasses' capture slot for nothing.
    if reason == "didEnterBackground", bridge.writer != nil {
      log("app lifecycle (\(reason)) — KEEPING glasses session, capture is armed")
      bridge.sendEvent(
        withName: Event.streamState,
        body: ["state": "streaming", "reason": "background-capture"]
      )
      return
    }
    log("app lifecycle (\(reason)) — releasing glasses session")
    bridge.stopping = true
    bridge.teardown()
    bridge.stopping = false
    // Tell JS the feed is gone so ConnectScreen can clear its "previewing"
    // latch and reopen when we return to the foreground. Without this, the
    // UI keeps showing a dead preview and never retries.
    bridge.sendEvent(
      withName: Event.streamState,
      body: ["state": "stopped", "reason": reason]
    )
  }

  // MARK: - App-level URL callback (Meta AI hands control back via clypso://)

  @objc static func handleOpenURL(_ url: URL) -> Bool {
    // Query carries the registration authority key — keep it out of the log.
    let redacted = "\(url.scheme ?? "?")://\(url.host ?? "")\(url.path)"

    guard case .success = configureResult else {
      log("handleOpenURL(\(redacted)): MWDAT not configured — callback dropped")
      return false
    }
    guard url.scheme?.lowercased() == "clypso" else { return false }

    // Meta AI reports link failures back through this callback. Swallowing the
    // error leaves "internal error" on the Meta AI side as the only symptom,
    // with nothing on ours, so surface the typed error and the state it left.
    Task {
      do {
        let handled = try await Wearables.shared.handleUrl(url)
        log(
          "handleOpenURL(\(redacted)): handled=\(handled) "
            + "state=\(Wearables.shared.registrationState.description)"
        )
      } catch {
        log("handleOpenURL(\(redacted)) FAILED: \(error)")
      }
    }
    return true
  }

  // MARK: - RCTEventEmitter

  override static func requiresMainQueueSetup() -> Bool { false }

  override func supportedEvents() -> [String]! {
    [
      Event.segment, Event.error, Event.streamState,
      Event.registrationState, Event.devices, Event.previewFrame,
      Event.streamHealth,
    ]
  }

  override func startObserving() {
    guard case .success = Self.configureResult else { return }
    let wearables = Wearables.shared
    observerTokens.append(
      wearables.addRegistrationStateListener { [weak self] state in
        self?.sendEvent(withName: Event.registrationState, body: ["state": state.description])
      }
    )
    observerTokens.append(
      wearables.addDevicesListener { [weak self] _ in
        guard let self else { return }
        self.sendEvent(withName: Event.devices, body: self.diagnosticsPayload())
      }
    )
  }

  override func stopObserving() {
    observerTokens = []
  }

  func ensureConfigured() throws {
    try Self.configureResult.get()
  }

  override func constantsToExport() -> [AnyHashable: Any]! {
    #if targetEnvironment(simulator)
      return ["isSimulator": true]
    #else
      return ["isSimulator": false]
    #endif
  }

  // MARK: - Mock glasses (dev)

  @objc(mockEnable:reject:)
  func mockEnable(
    _ resolve: @escaping RCTPromiseResolveBlock,
    reject: @escaping RCTPromiseRejectBlock
  ) {
    Task { @MainActor in
      do {
        try ensureConfigured()
        if mockActive {
          resolve(nil)
          return
        }
        Self.log("mockEnable(): pairing MockDeviceKit glasses")
        MockDeviceKit.shared.enable()
        let glasses = try MockDeviceKit.shared.pairGlasses(model: .rayBanMeta)
        glasses.powerOn()
        glasses.unfold()
        glasses.don()
        if let feed = Bundle.main.url(forResource: "MockFeed", withExtension: "mp4") {
          glasses.services.camera.setCameraFeed(fileURL: feed)
          Self.log("mockEnable(): camera feed set (MockFeed.mp4)")
        } else {
          Self.log("mockEnable(): MockFeed.mp4 missing from bundle — no feed")
        }
        mockGlasses = glasses
        mockActive = true
        resolve(nil)
      } catch {
        Self.log("mockEnable() FAILED: \(error.localizedDescription)")
        reject("mwdat_mock", "Mock glasses failed: \(error.localizedDescription)", error)
      }
    }
  }

  // MARK: - Preview / recording

  @objc(startPreview:reject:)
  func startPreview(
    _ resolve: @escaping RCTPromiseResolveBlock,
    reject: @escaping RCTPromiseRejectBlock
  ) {
    Task { @MainActor in
      do {
        DiagnosticLog.reset()
        Self.log("startPreview() called")
        try ensureConfigured()
        try await openPipelineIfNeeded()
        Self.log("startPreview() succeeded")
        resolve(nil)
      } catch {
        Self.log("startPreview() FAILED: \(error.localizedDescription)")
        if self.writer == nil { self.teardown() }
        reject("mwdat_preview", error.localizedDescription, error)
      }
    }
  }

  @objc(stopPreview:reject:)
  func stopPreview(
    _ resolve: @escaping RCTPromiseResolveBlock,
    reject _: @escaping RCTPromiseRejectBlock
  ) {
    // Never kill the pipeline out from under an active recording.
    if writer == nil {
      stopping = true
      teardown()
      stopping = false
    }
    resolve(nil)
  }

  /// Gate preview encoding without tearing the glasses pipeline down. The UI
  /// calls this false when no view is showing the feed, so no frame is
  /// converted, JPEG-encoded, base64'd, or sent across the bridge while the
  /// user is somewhere else in the app. Recording is unaffected: segments are
  /// written from the same frames on a different path.
  @objc(setPreviewEnabled:resolve:reject:)
  func setPreviewEnabled(
    _ enabled: NSNumber,
    resolve: @escaping RCTPromiseResolveBlock,
    reject _: @escaping RCTPromiseRejectBlock
  ) {
    preview.setEnabled(enabled.boolValue)
    Self.log("preview emission \(enabled.boolValue ? "enabled" : "disabled")")
    resolve(nil)
  }

  @objc(start:resolve:reject:)
  func start(
    _ segmentSeconds: NSNumber,
    resolve: @escaping RCTPromiseResolveBlock,
    reject: @escaping RCTPromiseRejectBlock
  ) {
    Task { @MainActor in
      // Snapshot before any async work: if the preview pipeline is already
      // running (opened by startPreview()), a writer-attach failure must NOT
      // tear it down — the user still wants to see the glasses feed.
      let pipelineAlreadyOpen = deviceSession != nil
        && deviceSession?.state == .started
        && stream != nil
      do {
        try ensureConfigured()
        try await openPipelineIfNeeded()
        try attachWriter(segmentSeconds: segmentSeconds.doubleValue)
        resolve(nil)
      } catch {
        if !pipelineAlreadyOpen { teardown() }
        reject("mwdat_start", error.localizedDescription, error)
      }
    }
  }

  @objc(cut:reject:)
  func cut(
    _ resolve: @escaping RCTPromiseResolveBlock,
    reject _: @escaping RCTPromiseRejectBlock
  ) {
    guard let writer else {
      resolve(nil)
      return
    }
    writer.cut { resolve(nil) }
  }

  /// Detach the segment writer only. Keeps the glasses session + camera stream
  /// alive so Connect → Live (and React effect remounts) can re-arm without the
  /// glasses playing their stop/start chime and dropping the capture slot.
  @objc(stopRecording:reject:)
  func stopRecording(
    _ resolve: @escaping RCTPromiseResolveBlock,
    reject _: @escaping RCTPromiseRejectBlock
  ) {
    if writer != nil {
      Self.log("stopRecording() — detaching writer, keeping stream")
      writer?.stopAndDiscard()
      writer = nil
    }
    resolve(nil)
  }

  /// Make the glasses themselves sound a confirmation.
  ///
  /// MWDAT exposes no audio-output API — `MWDATCore`, `MWDATCamera` and
  /// `MWDATDisplay` have no speaker, tone or notification surface — and the
  /// glasses' speaker is not addressable as a route we can safely play into:
  /// selecting it renegotiates the same Bluetooth link that carries video down
  /// to narrowband HFP and starves the stream (see MWDATSegmentWriter). The
  /// connect/disconnect chime the wearer already knows is emitted by the
  /// glasses' firmware on session start/stop, so reproducing *that* one would
  /// mean tearing the session down and losing capture.
  ///
  /// A still capture is the one sound left: the firmware plays its capture
  /// tone, and it runs on the stream that is **already open**, so the link is
  /// never renegotiated. The photo is not collected — nothing subscribes to
  /// `photoDataPublisher` — because we are only here for the sound.
  ///
  /// Resolves whether the capture was actually issued, so JS can tell "the
  /// glasses chimed" from "there was no live stream to chime on".
  @objc(chime:reject:)
  func chime(
    _ resolve: @escaping RCTPromiseResolveBlock,
    reject _: @escaping RCTPromiseRejectBlock
  ) {
    guard let stream, stream.state == .streaming else {
      Self.log("chime() — no streaming session, skipped")
      resolve(false)
      return
    }
    let issued = stream.capturePhoto(format: .jpeg)
    Self.log("chime() — capturePhoto \(issued ? "issued" : "refused by SDK")")
    resolve(issued)
  }

  @objc(stop:reject:)
  func stop(
    _ resolve: @escaping RCTPromiseResolveBlock,
    reject _: @escaping RCTPromiseRejectBlock
  ) {
    stopping = true
    teardown()
    stopping = false
    resolve(nil)
  }

  // MARK: - Pipeline internals

  /// Why a session-start wait ended. A bare `Bool` conflated "the glasses said
  /// no" with "nobody ever answered".
  private enum SessionStartOutcome: CustomStringConvertible {
    case started
    case stopped
    case timedOut

    var description: String {
      switch self {
      case .started: return "started"
      case .stopped: return "stopped"
      case .timedOut: return "timedOut"
      }
    }
  }

  /// Single-flight entry point. Concurrent callers await the existing attempt
  /// instead of starting a competing one.
  @MainActor
  private func openPipelineIfNeeded() async throws {
    if let existing = openTask {
      Self.log("open already in flight — coalescing onto it")
      try await existing.value
      return
    }
    let task = Task { @MainActor in try await performOpenPipeline() }
    openTask = task
    defer { openTask = nil }
    try await task.value
  }

  @MainActor
  private func performOpenPipeline() async throws {
    // Reuse a live stream even if we only asked for preview earlier. Tearing
    // it down here is what made the glasses "shut off" on the way into Live.
    if let stream, stream.state == .streaming || stream.state == .starting {
      Self.log(
        "pipeline already open (stream \(stream.state), session=\(deviceSession.map { String(describing: $0.state) } ?? "nil"))"
      )
      return
    }
    if let session = deviceSession, session.state == .started, stream != nil {
      Self.log("pipeline already open (session started, stream present)")
      return
    }
    // Our own teardown, not a device-initiated drop — suppress the error event.
    stopping = true
    teardown()
    stopping = false

    let wearables = Wearables.shared
    Self.log(
      "openPipeline: registration=\(wearables.registrationState.description) devices=\(wearables.devices.count)"
    )

    // The glasses drop off the device list whenever they're folded, asleep,
    // or Meta AI loses them — give them a window to show up instead of
    // failing instantly with "no eligible device".
    if wearables.devices.isEmpty {
      Self.log("device list empty — waiting up to 20s…")
      let appeared = await Self.waitForDevice(wearables, timeoutSeconds: 20)
      Self.log("waitForDevice → \(appeared)")
      guard appeared else {
        throw NSError(
          domain: "MWDATBridge", code: 12,
          userInfo: [
            NSLocalizedDescriptionKey:
              "No glasses found. Unfold them, put them on, check they show "
              + "as Connected in Meta AI, and that Clypso is enabled under "
              + "Meta AI → Settings → App connections.",
          ]
        )
      }
    }

    // Surface incompatibility loudly — a firmware-outdated device sits in the
    // list but can never join a session.
    if let identifier = wearables.devices.first,
       let device = wearables.deviceForIdentifier(identifier),
       device.compatibility() == .deviceUpdateRequired || device.compatibility() == .sdkUpdateRequired {
      throw NSError(
        domain: "MWDATBridge", code: 13,
        userInfo: [
          NSLocalizedDescriptionKey:
            "\(device.nameOrId()): \(device.compatibility().displayString). "
            + "Update the glasses in Meta AI (Device settings → Software update), "
            + "then try again.",
        ]
      )
    }

    let selector: any DeviceSelector
    let auto = deviceSelector ?? AutoDeviceSelector(wearables: wearables)
    deviceSelector = auto
    if auto.activeDevice != nil {
      Self.log("auto-selector already resolved: \(String(describing: auto.activeDevice))")
      selector = auto
    } else {
      // Give the auto-selector a moment to lock onto the glasses; if it
      // stays undecided while the device list is non-empty, pin the session
      // to the first device explicitly.
      Self.log("auto-selector undecided — waiting up to 10s…")
      let resolved = await Self.waitForActiveDevice(auto, timeoutSeconds: 10)
      if resolved {
        Self.log("auto-selector resolved: \(String(describing: auto.activeDevice))")
        selector = auto
      } else if let first = wearables.devices.first {
        Self.log("auto-selector never resolved — pinning SpecificDeviceSelector(\(first))")
        selector = SpecificDeviceSelector(device: first)
      } else {
        Self.log("auto-selector never resolved and device list empty")
        selector = auto
      }
    }

    Self.log("createSession…")
    let session = try wearables.createSession(deviceSelector: selector)
    deviceSession = session
    Self.log("createSession OK — starting session")

    // Subscribed BEFORE start() so `.starting`/`.started` cannot land before
    // we are listening. Consuming only *after* start() missed a prompt
    // `.started`, burned the full 60s timeout, then tore down a live session
    // — which is the restart loop.
    let states = session.stateStream()
    let startedSignal = Self.watchSessionStates(states)
    sessionStateTask = startedSignal

    try session.start()
    Self.log("session.start() returned, state=\(String(describing: session.state))")

    if session.state != .started {
      Self.log("waiting for session to reach started (60s max)…")
      let outcome = await Self.waitForStarted(startedSignal, timeoutSeconds: 60)
      // The live property is authoritative. A missed stream event must not
      // fail a session that is demonstrably up.
      let liveState = session.state
      Self.log("waitForStarted → \(outcome), live state=\(liveState.description)")
      if liveState != .started {
        let reason: String
        switch outcome {
        case .stopped:
          reason = "Glasses session stopped during start (folded, out of range, or taken over)."
        case .timedOut where liveState == .paused:
          reason =
            "Glasses session paused and stayed paused. Do not restart while paused — "
            + "wait for the glasses to resume, or fold/unfold and try again."
        case .started, .timedOut:
          reason =
            "Glasses session did not start. Make sure the glasses are open, "
            + "connected in Meta AI, and this app is enabled under App connections."
        }
        throw NSError(
          domain: "MWDATBridge", code: 10,
          userInfo: [NSLocalizedDescriptionKey: reason]
        )
      }
    }

    // `.raw` delivers decoded CVPixelBuffers; `.hvc1` delivers compressed HEVC
    // that the SDK does NOT decode for us — a frame then carries a dataBuffer
    // and no imageBuffer, `makeUIImage()` returns nil, `CMSampleBufferGetImageBuffer`
    // returns nil, and every frame is dropped by both the preview converter and
    // the writer's H.264 encoder input (which expects uncompressed samples).
    // Verified on-device: hvc1 frames log `imageBuffer=false makeUIImage=NIL`.
    // `.raw` is also what Meta's own sample pairs with `makeUIImage()`; the SDK
    // applies an automatic quality ladder (resolution first, then frame rate,
    // never below 15 fps) to fit the Bluetooth link, so raw is safe to request.
    //
    // 30 fps is the glasses' top supported rate. Ask for `.high`: the SDK's
    // ABR ladder only ever steps DOWN from the requested rung, so `.medium`
    // was a hard ceiling of 504×896 even when the link could carry more.
    // MWDATCamera's own diagnostics say high "requires ... high (WiFi)
    // bandwidth link", so over Bluetooth Classic the ladder will still land on
    // medium — that is the floor we used to pin ourselves to, not a regression.
    // The delivered size per segment is logged by MWDATSegmentWriter
    // ("source video format: …"), which is where to check what we actually get.
    let config = StreamConfiguration(videoCodec: .raw, resolution: .high, frameRate: 30)
    Self.log("addStream(codec: raw, resolution: high, fps: 30)…")
    guard let newStream = try session.addStream(config: config) else {
      throw NSError(
        domain: "MWDATBridge", code: 11,
        userInfo: [NSLocalizedDescriptionKey: "Could not open the glasses camera stream."]
      )
    }
    stream = newStream
    lastStreamError = nil
    streamHasLeftStopped = false

    listenerTokens.append(
      newStream.videoFramePublisher.listen { [weak self] frame in
        guard let self else { return }
        self.health.recordFrame()
        let count = self.health.framesDelivered
        if count == 1 || count % 100 == 0 {
          Self.log("video frame #\(count)")
        }
        if count == 1 {
          Self.logFrameDiagnostics(frame)
        }
        self.writer?.appendVideo(frame.sampleBuffer)
        self.preview.submit(frame)
      }
    )
    listenerTokens.append(
      newStream.statePublisher.listen { [weak self] state in
        guard let self else { return }
        Self.log("stream state → \(state) (hasLeftStopped=\(self.streamHasLeftStopped), stopping=\(self.stopping))")
        self.sendEvent(withName: Event.streamState, body: ["state": String(describing: state)])
        if state != .stopped {
          self.streamHasLeftStopped = true
          return
        }
        // Only a stop that follows real progress is a stop; the `.stopped`
        // the SDK reports before `start()` lands is just the initial value.
        if self.streamHasLeftStopped, !self.stopping {
          self.sendEvent(
            withName: Event.error,
            body: ["message": "The glasses stream stopped (folded, out of range, or taken over)."]
          )
        }
      }
    )
    listenerTokens.append(
      newStream.errorPublisher.listen { [weak self] error in
        Self.log("stream ERROR: \(error.description)")
        self?.lastStreamError = error
        self?.sendEvent(withName: Event.error, body: ["message": error.description])
      }
    )
    listenerTokens.append(
      session.statePublisher.listen { state in
        // Session state during and after stream negotiation: a session that
        // drops back to .stopped underneath a starting stream explains an
        // otherwise silent stream failure.
        Self.log("session state → \(state.description)")
      }
    )
    listenerTokens.append(
      session.errorPublisher.listen { [weak self] error in
        Self.log("session ERROR: \(error.description)")
        self?.sendEvent(withName: Event.error, body: ["message": error.description])
      }
    )

    Self.log("session started (\(String(describing: session.state))); starting stream…")
    newStream.start()

    // `Stream.start()` is fire-and-forget and returns Void. Without this gate
    // the promise resolves on a stream that may already be dying, the UI mounts
    // the preview, and it sits on "Waiting for the glasses feed…" forever while
    // the real failure only ever surfaces as a stray error event. Resolve only
    // once the stream is genuinely `.streaming`, and name the cause otherwise.
    if newStream.state != .streaming {
      Self.log("waiting for stream to reach .streaming (45s max)…")
      let streaming = await waitForStreaming(newStream, timeoutSeconds: 45)
      Self.log("waitForStreaming → \(streaming), state=\(String(describing: newStream.state))")
      guard streaming else {
        let cause = lastStreamError.map { $0.description }
          ?? (streamHasLeftStopped
            ? "the stream started and then stopped without reporting an error"
            : "the glasses never acknowledged the start request")
        throw NSError(
          domain: "MWDATBridge", code: 14,
          userInfo: [
            NSLocalizedDescriptionKey:
              "Glasses camera stream never started (last state: "
              + "\(String(describing: newStream.state)); cause: \(cause)). "
              + "Check the glasses are unfolded and being worn, not overheating, "
              + "and that camera access is allowed for Clypso in Meta AI.",
          ]
        )
      }
    }
    Self.log("stream is .streaming — frames should follow")
    health.start()
  }

  private func attachWriter(segmentSeconds: Double) throws {
    guard writer == nil else { return }
    let newWriter = MWDATSegmentWriter(
      segmentSeconds: segmentSeconds,
      onSegment: { [weak self] segment in
        Self.log("segment written: \(segment.durationSec)s \(segment.path)")
        self?.sendEvent(
          withName: Event.segment,
          body: [
            "path": segment.path,
            "startedAt": segment.startedAtMs,
            "durationSec": segment.durationSec,
          ]
        )
      },
      onError: { [weak self] message in
        self?.sendEvent(withName: Event.error, body: ["message": message])
      }
    )
    writer = newWriter
    // Audio is best-effort and retries itself each rotation. A mic failure must
    // not abort arming or tear down the glasses video stream — that read as
    // "glasses shut off instead of recording".
    newWriter.startAudio()
  }

  private func teardown() {
    // Cancelled before the session is released: an orphaned consumer left
    // running against a dead session is exactly how a previous attempt keeps
    // driving live retry logic.
    sessionStateTask?.cancel()
    sessionStateTask = nil
    health.stop()
    writer?.stopAndDiscard()
    writer = nil
    stream?.stop()
    stream = nil
    deviceSession?.stop()
    deviceSession = nil
    // Released LAST: clearing these first would detach the state/error
    // listeners before stop(), silently swallowing whatever the SDK reports
    // on the way down — which is exactly the failure we need to see.
    listenerTokens = []
    health.reset()
    preview.resetCounters()
    streamHasLeftStopped = false
    lastStreamError = nil
  }

  /// One-shot anatomy dump of the first frame the glasses deliver. Whether the
  /// SDK hands us decoded pixel buffers or compressed HEVC decides whether the
  /// preview can render at all, and it is not knowable from the API surface.
  private static func logFrameDiagnostics(_ frame: VideoFrame) {
    let sample = frame.sampleBuffer
    var parts: [String] = []

    if let desc = CMSampleBufferGetFormatDescription(sample) {
      let subType = CMFormatDescriptionGetMediaSubType(desc)
      let fourCC = String(
        bytes: [
          UInt8((subType >> 24) & 0xFF), UInt8((subType >> 16) & 0xFF),
          UInt8((subType >> 8) & 0xFF), UInt8(subType & 0xFF),
        ],
        encoding: .ascii
      ) ?? "????"
      let dims = CMVideoFormatDescriptionGetDimensions(desc)
      parts.append("subtype='\(fourCC)' \(dims.width)x\(dims.height)")
    } else {
      parts.append("NO format description")
    }

    let imageBuffer = CMSampleBufferGetImageBuffer(sample)
    parts.append("imageBuffer=\(imageBuffer != nil)")
    if let imageBuffer {
      let pixelFormat = CVPixelBufferGetPixelFormatType(imageBuffer)
      let fourCC = String(
        bytes: [
          UInt8((pixelFormat >> 24) & 0xFF), UInt8((pixelFormat >> 16) & 0xFF),
          UInt8((pixelFormat >> 8) & 0xFF), UInt8(pixelFormat & 0xFF),
        ],
        encoding: .ascii
      ) ?? "????"
      parts.append("pixelFormat='\(fourCC)'")
    }
    parts.append("dataBuffer=\(CMSampleBufferGetDataBuffer(sample) != nil)")
    parts.append("samples=\(CMSampleBufferGetNumSamples(sample))")
    parts.append("dataReady=\(CMSampleBufferDataIsReady(sample))")

    if let image = frame.makeUIImage() {
      parts.append("makeUIImage=\(Int(image.size.width))x\(Int(image.size.height))")
    } else {
      parts.append("makeUIImage=NIL")
    }

    log("FRAME ANATOMY — " + parts.joined(separator: " "))
  }

  /// `Stream` exposes only an `Announcer` (no `stateStream()` like
  /// `DeviceSession`), and `state` is a plain synchronous property — so poll it
  /// rather than bridging a callback into a continuation. Polling also removes
  /// any chance of missing a terminal state that landed before we started
  /// watching.
  ///
  /// `.stopped` must NOT be treated as terminal on its own. As of SDK 0.8.0
  /// `Stream.start()` is synchronous and fire-and-forget, and a stream created
  /// by `addStream` sits in `.stopped` until the glasses answer and the SDK
  /// walks it through `.waitingForDevice` → `.starting` → `.streaming`. So the
  /// very first reading after `start()` is virtually always `.stopped`, and
  /// bailing on it aborts every stream ~0 ms after it is asked to start —
  /// before the SDK has had any chance to report an error, which is why the
  /// failure surfaced as "last state: stopped; cause: no error reported".
  /// A stop only means failure once the stream has been seen to leave
  /// `.stopped`; before that, keep waiting (or until an error, or timeout).
  private func waitForStreaming(
    _ stream: MWDATCamera.Stream,
    timeoutSeconds: UInt64
  ) async -> Bool {
    let deadline = Date().addingTimeInterval(TimeInterval(timeoutSeconds))
    var loggedState: MWDATCamera.StreamState?
    var everLeftStopped = false

    while Date() < deadline {
      let state = stream.state
      if state != loggedState {
        Self.log("waitForStreaming: \(String(describing: state))")
        loggedState = state
      }

      switch state {
      case .streaming:
        return true
      case .waitingForDevice, .starting, .paused, .stopping:
        everLeftStopped = true
        streamHasLeftStopped = true
      case .stopped:
        if everLeftStopped {
          Self.log("waitForStreaming: returned to .stopped after starting — terminal")
          return false
        }
      }

      // An error is terminal no matter what the state property says, and lets
      // a permissionDenied/hingesClosed fail fast instead of burning the
      // whole timeout.
      if let error = lastStreamError {
        Self.log("waitForStreaming: aborting on SDK error — \(error.description)")
        return false
      }

      try? await Task.sleep(nanoseconds: 100_000_000)
    }

    Self.log(
      "waitForStreaming: timed out after \(timeoutSeconds)s in "
        + "\(String(describing: stream.state)) (everLeftStopped=\(everLeftStopped))"
    )
    return stream.state == .streaming
  }

  private static func waitForActiveDevice(
    _ selector: AutoDeviceSelector,
    timeoutSeconds: UInt64
  ) async -> Bool {
    await withTaskGroup(of: Bool.self) { group in
      group.addTask {
        for await device in selector.activeDeviceStream() where device != nil {
          return true
        }
        return false
      }
      group.addTask {
        try? await Task.sleep(nanoseconds: timeoutSeconds * 1_000_000_000)
        return selector.activeDevice != nil
      }
      let result = await group.next() ?? false
      group.cancelAll()
      return result
    }
  }

  private static func waitForDevice(
    _ wearables: any WearablesInterface,
    timeoutSeconds: UInt64
  ) async -> Bool {
    await withTaskGroup(of: Bool.self) { group in
      group.addTask {
        for await devices in wearables.devicesStream() where !devices.isEmpty {
          return true
        }
        return false
      }
      group.addTask {
        try? await Task.sleep(nanoseconds: timeoutSeconds * 1_000_000_000)
        return !wearables.devices.isEmpty
      }
      let result = await group.next() ?? false
      group.cancelAll()
      return result
    }
  }

  /// Begins consuming the session state stream immediately, so transitions that
  /// land during `start()` are observed rather than missed. Resolves on the
  /// first terminal-for-startup state.
  ///
  /// Unlike the camera stream state machine, `.stopped` is genuinely terminal
  /// for a session: a freshly created session is `.idle`, not `.stopped`
  /// (SDK 0.8.0), and a stopped session cannot be restarted — it must be replaced.
  private static func watchSessionStates(
    _ states: AsyncStream<DeviceSessionState>
  ) -> Task<SessionStartOutcome, Never> {
    Task {
      for await state in states {
        log("session state (watch) → \(state.description)")
        if state == .started { return .started }
        if state == .stopped { return .stopped }
      }
      log("session state stream ended with no terminal state")
      return .timedOut
    }
  }

  private static func waitForStarted(
    _ signal: Task<SessionStartOutcome, Never>,
    timeoutSeconds: UInt64
  ) async -> SessionStartOutcome {
    await withTaskGroup(of: SessionStartOutcome.self) { group in
      group.addTask { await signal.value }
      group.addTask {
        try? await Task.sleep(nanoseconds: timeoutSeconds * 1_000_000_000)
        return .timedOut
      }
      let result = await group.next() ?? .timedOut
      group.cancelAll()
      return result
    }
  }
}
