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
  private var stream: MWDATCamera.Stream?

  /// In-flight pipeline open, so concurrent callers coalesce onto one attempt.
  /// `openPipelineIfNeeded()` is reachable from `startPreview()`, `start()`, the
  /// retry button and any React effect that re-fires, and it tears the existing
  /// session down before rebuilding — so a second caller arriving mid-negotiation
  /// used to stop the first caller's session (stop chime) and create a new one
  /// (start chime), while the first caller then failed and tore *that* one down.
  /// That is a self-sustaining restart loop. Coalesced, not queued: queueing only
  /// delays the collision.
  private var openTask: Task<Void, Error>?

  /// Consumes the session state stream for the life of the session. Held so
  /// teardown can cancel it — an orphaned consumer from a previous attempt is
  /// one of the ways a dead session keeps driving live logic.
  private var sessionStateTask: Task<SessionStartOutcome, Never>?
  private var listenerTokens: [any AnyListenerToken] = []
  private var observerTokens: [any AnyListenerToken] = []
  private var writer: MWDATSegmentWriter?
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
  private var mockActive = false
  private var mockGlasses: (any MockGlasses)?

  private let previewQueue = DispatchQueue(label: "com.mocinjay.jarvis.mwdat.preview")
  private var previewBusy = false
  private var lastPreviewAt: TimeInterval = 0
  private var frameCount = 0
  private var previewEmitCount = 0
  private var previewFailLogged = false

  /// NSLog rather than print: it reaches the unified logging system, so
  /// `log stream --device` shows the glasses handshake live during field
  /// debugging without needing a console attached (the devicectl console
  /// drops the connection during long capture runs).
  private static func log(_ message: String) {
    NSLog("[MWDAT] %@", message)
    DiagnosticLog.write("[MWDAT] \(message)")
    MWDATTrace.record("log", message)
  }

  /// Short identity for a session/stream. Two different tags in one trace mean
  /// the pipeline was re-entered and a second object was built.
  private static func tagOf(_ object: AnyObject) -> String { MWDATTrace.tag(object) }

  /// Categorised trace entry. Unlike `log()` these are the events the restart
  /// loop is read from, so they carry the owning object's identity.
  private static func trace(_ category: String, _ message: String) {
    NSLog("[MWDAT/%@] %@", category, message)
    DiagnosticLog.write("[MWDAT/\(category)] \(message)")
    MWDATTrace.record(category, message)
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

  @objc static func releaseGlassesForAppLifecycle(_ reason: String) {
    guard let bridge = current, bridge.deviceSession != nil || bridge.stream != nil else { return }
    log("app lifecycle (\(reason)) — releasing glasses session")
    bridge.stopping = true
    bridge.teardown()
    bridge.stopping = false
  }

  // MARK: - App-level URL callback (Meta AI hands control back via jarvis://)

  @objc static func handleOpenURL(_ url: URL) -> Bool {
    // Query carries the registration authority key — keep it out of the log.
    let redacted = "\(url.scheme ?? "?")://\(url.host ?? "")\(url.path)"

    guard case .success = configureResult else {
      log("handleOpenURL(\(redacted)): MWDAT not configured — callback dropped")
      return false
    }
    guard url.scheme?.lowercased() == "jarvis" else { return false }

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

  private func ensureConfigured() throws {
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

  // MARK: - Diagnostics

  private func diagnosticsPayload() -> [String: Any] {
    let wearables = Wearables.shared
    let devices: [[String: Any]] = wearables.devices.compactMap { identifier in
      guard let device = wearables.deviceForIdentifier(identifier) else { return nil }
      return [
        "name": device.nameOrId(),
        "linkState": String(describing: device.linkState),
        "compatibility": device.compatibility().displayString,
        "type": String(describing: device.deviceType()),
      ]
    }
    return [
      "registration": wearables.registrationState.description,
      "devices": devices,
      "streamState": stream.map { String(describing: $0.state) } ?? "none",
      "recording": writer != nil,
    ]
  }

  /// Dump of the pipeline trace ring buffer. Read on-device from the debug
  /// screen — the failure reproduces while walking around, where Xcode is not
  /// attached and `devicectl --console` drops the connection.
  @objc(getDiagnosticTrace:reject:)
  func getDiagnosticTrace(
    _ resolve: @escaping RCTPromiseResolveBlock,
    reject _: @escaping RCTPromiseRejectBlock
  ) {
    resolve(MWDATTrace.dump())
  }

  @objc(getDiagnostics:reject:)
  func getDiagnostics(
    _ resolve: @escaping RCTPromiseResolveBlock,
    reject: @escaping RCTPromiseRejectBlock
  ) {
    do {
      try ensureConfigured()
    } catch {
      reject("mwdat_configure", "MWDAT not configured: \(error.localizedDescription)", error)
      return
    }
    Task { @MainActor in
      var payload = self.diagnosticsPayload()
      if Wearables.shared.registrationState == .registered {
        let status = await Self.withTimeout(seconds: 3) {
          try? await Wearables.shared.checkPermissionStatus(.camera)
        }
        payload["cameraPermission"] = status.map { String(describing: $0) } ?? "unknown"
      } else {
        payload["cameraPermission"] = "unknown"
      }
      resolve(payload)
    }
  }

  // MARK: - Registration

  @objc(getRegistrationState:reject:)
  func getRegistrationState(
    _ resolve: @escaping RCTPromiseResolveBlock,
    reject: @escaping RCTPromiseRejectBlock
  ) {
    do {
      try ensureConfigured()
      resolve(Wearables.shared.registrationState.description)
    } catch {
      reject("mwdat_configure", "MWDAT not configured: \(error.localizedDescription)", error)
    }
  }

  @objc(startRegistration:reject:)
  func startRegistration(
    _ resolve: @escaping RCTPromiseResolveBlock,
    reject: @escaping RCTPromiseRejectBlock
  ) {
    do {
      try ensureConfigured()
    } catch {
      reject("mwdat_configure", "MWDAT not configured: \(error.localizedDescription)", error)
      return
    }
    Task { @MainActor in
      do {
        try await Wearables.shared.startRegistration()
        resolve(Wearables.shared.registrationState.description)
      } catch {
        reject(
          "mwdat_registration",
          "Registration with Meta AI failed: \(error.localizedDescription). "
            + "Is the Meta AI app installed with Developer Mode on?",
          error
        )
      }
    }
  }

  // MARK: - Permission

  @objc(prepare:reject:)
  func prepare(
    _ resolve: @escaping RCTPromiseResolveBlock,
    reject: @escaping RCTPromiseRejectBlock
  ) {
    do {
      try ensureConfigured()
    } catch {
      reject("mwdat_configure", "MWDAT not configured: \(error.localizedDescription)", error)
      return
    }
    let wearables = Wearables.shared
    guard mockActive || wearables.registrationState == .registered else {
      reject(
        "mwdat_not_registered",
        "Glasses are not linked yet. Tap “Connect through Meta AI” first.",
        nil
      )
      return
    }
    Task { @MainActor in
      Self.log("prepare(): checking glasses camera permission…")
      // checkPermissionStatus can hang indefinitely (observed in the field);
      // never block the pipeline on it — a missing permission surfaces later
      // as a definitive StreamError.permissionDenied.
      let status = await Self.withTimeout(seconds: 8) {
        try? await wearables.checkPermissionStatus(.camera)
      }
      Self.log("prepare(): permission check → \(status.map { String(describing: $0) } ?? "TIMED OUT")")

      guard let status else {
        Self.log("prepare(): continuing despite timeout — stream will report permissionDenied if needed")
        resolve(nil)
        return
      }
      if status == .granted {
        resolve(nil)
        return
      }
      Self.log("prepare(): requesting permission via Meta AI…")
      let granted = await Self.withTimeout(seconds: 120) {
        try? await wearables.requestPermission(.camera)
      }
      Self.log("prepare(): request → \(granted.map { String(describing: $0) } ?? "TIMED OUT")")
      if granted == .denied {
        reject("mwdat_permission", "Camera access on the glasses was denied in Meta AI.", nil)
      } else {
        resolve(nil)
      }
    }
  }

  private static func withTimeout<T: Sendable>(
    seconds: UInt64,
    _ operation: @escaping @Sendable () async -> T?
  ) async -> T? {
    await withTaskGroup(of: T?.self) { group in
      group.addTask { await operation() }
      group.addTask {
        try? await Task.sleep(nanoseconds: seconds * 1_000_000_000)
        return nil
      }
      let result = await group.next() ?? nil
      group.cancelAll()
      return result
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
        MWDATTrace.reset()
        Self.trace("pipeline", "startPreview() called")
        try ensureConfigured()
        try await openPipelineIfNeeded()
        Self.trace("pipeline", "startPreview() succeeded")
        resolve(nil)
      } catch {
        Self.trace("pipeline", "startPreview() FAILED: \(error.localizedDescription)")
        if self.writer == nil { self.teardown() }
        Self.reject(reject, error)
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
        Self.reject(reject, error)
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

  /// Single-flight entry point. Concurrent callers await the existing attempt
  /// instead of starting a competing one.
  @MainActor
  private func openPipelineIfNeeded() async throws {
    if let existing = openTask {
      Self.trace("pipeline", "open already in flight — coalescing onto it")
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
    if let session = deviceSession, session.state == .started, stream != nil {
      Self.trace("pipeline", "already open (session \(Self.tagOf(session)) started, stream present)")
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
        throw MWDATFailure(.pipelineNoDevice, detail: "device list empty after 20s")
      }
    }

    // Surface incompatibility loudly — a firmware-outdated device sits in the
    // list but can never join a session.
    if let identifier = wearables.devices.first,
       let device = wearables.deviceForIdentifier(identifier),
       device.compatibility() == .deviceUpdateRequired || device.compatibility() == .sdkUpdateRequired {
      throw MWDATFailure(
        .pipelineIncompatible,
        detail: "\(device.nameOrId()): \(device.compatibility().displayString)"
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

    Self.trace("session", "createSession…")
    let session: DeviceSession
    do {
      session = try wearables.createSession(deviceSelector: selector)
    } catch {
      // `sessionAlreadyExists` here means a previous session outlived our
      // teardown — name it rather than reporting a generic start failure.
      let code = MWDATCode.classify(error) ?? .sessionUnexpected
      Self.trace("session", "createSession FAILED → \(code.rawValue) \(code.slug): \(error)")
      throw MWDATFailure(code, detail: "createSession: \(error)")
    }
    deviceSession = session
    let sessionTag = Self.tagOf(session)
    Self.trace("session", "\(sessionTag) created (selector=\(type(of: selector)))")

    // Subscribed BEFORE start() so the `.starting`/`.started` transitions cannot
    // land before we are listening. The previous code only began consuming
    // `stateStream()` after start(), so a session that came up promptly emitted
    // `.started` into the void and then sat out the full 60s timeout.
    let states = session.stateStream()
    let startedSignal = Self.watchSessionStates(states, tag: sessionTag)
    sessionStateTask = startedSignal

    do {
      try session.start()
    } catch {
      let code = MWDATCode.classify(error) ?? .sessionUnexpected
      Self.trace("session", "\(sessionTag) start() FAILED → \(code.rawValue) \(code.slug): \(error)")
      throw MWDATFailure(code, detail: "session.start(): \(error)")
    }
    Self.trace("session", "\(sessionTag) start() returned, state=\(session.state.description)")

    if session.state != .started {
      Self.trace("session", "\(sessionTag) waiting to reach .started (60s max)…")
      let outcome = await Self.waitForStarted(startedSignal, timeoutSeconds: 60)
      // The live property is authoritative. A missed stream event must not fail
      // a session that is demonstrably up.
      let liveState = session.state
      Self.trace("session", "\(sessionTag) waitForStarted → \(outcome), live state=\(liveState.description)")
      if liveState != .started {
        let code: MWDATCode
        switch outcome {
        case .started: code = .pipelineSessionStartTimeout
        case .stopped: code = .pipelineSessionStoppedDuringStart
        case .timedOut where liveState == .paused: code = .pipelineSessionPausedStall
        case .timedOut: code = .pipelineSessionStartTimeout
        }
        throw MWDATFailure(code, detail: "session \(sessionTag) outcome=\(outcome) live=\(liveState.description)")
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
    let config = StreamConfiguration(videoCodec: .raw, resolution: .medium, frameRate: 24)
    Self.log("addStream(codec: raw, resolution: medium, fps: 24)…")
    let opened: MWDATCamera.Stream?
    do {
      opened = try session.addStream(config: config)
    } catch {
      let code = MWDATCode.classify(error) ?? .streamInternal
      Self.trace("stream", "addStream FAILED → \(code.rawValue) \(code.slug): \(error)")
      throw MWDATFailure(code, detail: "addStream: \(error)")
    }
    guard let newStream = opened else {
      throw MWDATFailure(.pipelineAddStreamReturnedNil, detail: "session \(sessionTag)")
    }
    stream = newStream
    let streamTag = Self.tagOf(newStream)
    Self.trace("stream", "\(streamTag) created on session \(sessionTag)")
    lastStreamError = nil
    streamHasLeftStopped = false

    listenerTokens.append(
      newStream.videoFramePublisher.listen { [weak self] frame in
        guard let self else { return }
        self.frameCount += 1
        if self.frameCount == 1 || self.frameCount % 100 == 0 {
          Self.log("video frame #\(self.frameCount)")
        }
        if self.frameCount == 1 {
          Self.logFrameDiagnostics(frame)
        }
        self.writer?.appendVideo(frame.sampleBuffer)
        self.emitPreviewFrame(frame)
      }
    )
    listenerTokens.append(
      newStream.statePublisher.listen { [weak self] state in
        guard let self else { return }
        Self.trace(
          "stream",
          "\(streamTag) state → \(state) (hasLeftStopped=\(self.streamHasLeftStopped), stopping=\(self.stopping))"
        )
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
        let code = MWDATCode.from(error)
        Self.trace("stream", "\(streamTag) ERROR → \(code.rawValue) \(code.slug): \(error.description)")
        self?.lastStreamError = error
        self?.emitFailure(code, detail: error.description)
      }
    )
    listenerTokens.append(
      session.statePublisher.listen { state in
        // Session state during and after stream negotiation: a session that
        // drops back to .stopped underneath a starting stream explains an
        // otherwise silent stream failure.
        Self.trace("session", "\(sessionTag) state → \(state.description)")
      }
    )
    listenerTokens.append(
      session.errorPublisher.listen { [weak self] error in
        let code = MWDATCode.from(error)
        Self.trace("session", "\(sessionTag) ERROR → \(code.rawValue) \(code.slug): \(error.description)")
        self?.emitFailure(code, detail: error.description)
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
      Self.trace("stream", "\(streamTag) waiting to reach .streaming (45s max)…")
      let streaming = await waitForStreaming(newStream, timeoutSeconds: 45)
      Self.trace(
        "stream",
        "\(streamTag) waitForStreaming → \(streaming), state=\(String(describing: newStream.state))"
      )
      guard streaming else {
        // Prefer the SDK's own reason. Only fall back to the generic
        // "never started" when the glasses genuinely reported nothing —
        // that distinction is the whole point of the code taxonomy.
        let code = lastStreamError.map { MWDATCode.from($0) } ?? .pipelineStreamNeverStarted
        let detail = "stream \(streamTag) last state=\(String(describing: newStream.state)) "
          + "hasLeftStopped=\(streamHasLeftStopped) "
          + "sdkError=\(lastStreamError.map { $0.description } ?? "none")"
        Self.trace("stream", "\(streamTag) FAILED → \(code.rawValue) \(code.slug): \(detail)")
        throw MWDATFailure(code, detail: detail)
      }
    }
    Self.trace("stream", "\(streamTag) is .streaming — frames should follow")
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
    try newWriter.startAudio()
  }

  /// Rejects an RN promise using the failure's code as the promise code, so JS
  /// can branch on the specific cause. Untyped errors keep the generic code
  /// rather than being silently assigned a misleading one.
  private static func reject(_ reject: RCTPromiseRejectBlock, _ error: Error) {
    if let failure = error as? MWDATFailure {
      reject(String(failure.code.rawValue), failure.errorDescription, error)
    } else if let code = MWDATCode.classify(error) {
      reject(String(code.rawValue), "[\(code.rawValue) \(code.slug)] \(code.guidance)", error)
    } else {
      reject("mwdat_unknown", error.localizedDescription, error)
    }
  }

  /// Emits an error to JS carrying the code, so the UI (and a pasted trace) can
  /// name one cause instead of showing an undifferentiated message.
  private func emitFailure(_ code: MWDATCode, detail: String) {
    sendEvent(
      withName: Event.error,
      body: [
        "code": code.rawValue,
        "slug": code.slug,
        "message": code.guidance,
        "detail": detail,
      ]
    )
  }

  private func teardown() {
    if let session = deviceSession {
      Self.trace("pipeline", "teardown of session \(Self.tagOf(session)) (stopping=\(stopping))")
    }
    // Cancelled before the session is released: an orphaned consumer left
    // running against a dead session is exactly how a previous attempt keeps
    // driving live retry logic.
    sessionStateTask?.cancel()
    sessionStateTask = nil
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
    frameCount = 0
    previewEmitCount = 0
    previewFailLogged = false
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

  /// ~6 fps JPEG preview of the wearer's view, dropped when the encoder is
  /// behind. Heavy enough to be useful, light enough for the RN bridge.
  private func emitPreviewFrame(_ frame: VideoFrame) {
    let now = Date().timeIntervalSince1970
    guard now - lastPreviewAt > 0.15 else { return }
    lastPreviewAt = now

    previewQueue.async { [weak self] in
      guard let self, !self.previewBusy else { return }
      self.previewBusy = true
      defer { self.previewBusy = false }

      // Try the SDK's own conversion first (works for HVC1/compressed frames).
      // For raw YCbCr frames the SDK returns nil, so fall back to CoreImage
      // which handles any CVPixelBuffer format the glasses camera can produce.
      let uiImage: UIImage?
      if let img = frame.makeUIImage() {
        uiImage = img
      } else if let pixelBuffer = CMSampleBufferGetImageBuffer(frame.sampleBuffer) {
        let ciImage = CIImage(cvPixelBuffer: pixelBuffer)
        let ciCtx = CIContext(options: [.useSoftwareRenderer: false])
        uiImage = ciCtx.createCGImage(ciImage, from: ciImage.extent).map(UIImage.init)
      } else {
        uiImage = nil
      }

      guard let image = uiImage,
            let jpeg = image.jpegData(compressionQuality: 0.35)
      else {
        if !self.previewFailLogged {
          self.previewFailLogged = true
          Self.log("preview conversion FAILED (makeUIImage and CoreImage both nil) — frames arrive but cannot render")
        }
        return
      }
      self.previewEmitCount += 1
      if self.previewEmitCount == 1 || self.previewEmitCount % 50 == 0 {
        Self.log("preview emit #\(self.previewEmitCount) — \(jpeg.count) bytes JPEG")
      }
      self.sendEvent(
        withName: Event.previewFrame,
        body: ["base64": jpeg.base64EncodedString()]
      )
    }
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

  /// Why a session-start wait ended. A bare `Bool` conflated "the glasses said
  /// no" with "nobody ever answered", which is precisely the ambiguity that made
  /// every failure look like the same generic 60s timeout.
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

  /// Begins consuming the session state stream immediately, so transitions that
  /// land during `start()` are observed rather than missed. Resolves on the
  /// first terminal-for-startup state.
  ///
  /// Unlike the stream state machine, `.stopped` genuinely is terminal for a
  /// session: a freshly created session is `.idle`, not `.stopped` (SDK 0.8.0
  /// `DeviceSessionState` = idle/starting/started/paused/stopping/stopped), and
  /// a stopped session cannot be restarted — it must be replaced.
  private static func watchSessionStates(
    _ states: AsyncStream<DeviceSessionState>,
    tag: String
  ) -> Task<SessionStartOutcome, Never> {
    Task {
      for await state in states {
        trace("session", "\(tag) state → \(state.description)")
        if state == .started { return .started }
        if state == .stopped { return .stopped }
      }
      trace("session", "\(tag) state stream ended with no terminal state")
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
