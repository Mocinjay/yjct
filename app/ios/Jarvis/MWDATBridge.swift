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
  private var previewFailLogged = false

  /// stdout logging so `devicectl device process launch --console` shows the
  /// glasses handshake live during field debugging.
  private static func log(_ message: String) {
    print("[MWDAT] \(message)")
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

  private func openPipelineIfNeeded() async throws {
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
              + "as Connected in Meta AI, and that Jarvis is enabled under "
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

    let states = session.stateStream()
    try session.start()
    Self.log("session.start() returned, state=\(String(describing: session.state))")

    if session.state != .started {
      Self.log("waiting for session to reach started (60s max)…")
      let started = await Self.waitForStarted(states, timeoutSeconds: 60)
      Self.log("waitForStarted → \(started), state=\(String(describing: session.state))")
      guard started, session.state == .started else {
        throw NSError(
          domain: "MWDATBridge", code: 10,
          userInfo: [
            NSLocalizedDescriptionKey:
              "Glasses session did not start. Make sure the glasses are open, "
              + "connected in Meta AI, and this app is enabled under App connections.",
          ]
        )
      }
    }

    // `.raw` is uncompressed YCbCr. Even `.medium` at 24 fps is ~33 MB/s,
    // orders of magnitude past the glasses link budget, so the stream
    // negotiates and dies before it ever reaches `.streaming`. `.hvc1` is the
    // only compressed codec the SDK exposes — and it is also the one
    // `VideoFrame.makeUIImage()` can actually decode (raw frames return nil).
    let config = StreamConfiguration(videoCodec: .hvc1, resolution: .medium, frameRate: 24)
    Self.log("addStream(codec: hvc1, resolution: medium, fps: 24)…")
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
        self.frameCount += 1
        if self.frameCount == 1 || self.frameCount % 100 == 0 {
          Self.log("video frame #\(self.frameCount)")
        }
        self.writer?.appendVideo(frame.sampleBuffer)
        self.emitPreviewFrame(frame)
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
              + "and that camera access is allowed for Jarvis in Meta AI.",
          ]
        )
      }
    }
    Self.log("stream is .streaming — frames should follow")
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

  private func teardown() {
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
    previewFailLogged = false
    streamHasLeftStopped = false
    lastStreamError = nil
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

  private static func waitForStarted(
    _ states: AsyncStream<DeviceSessionState>,
    timeoutSeconds: UInt64
  ) async -> Bool {
    await withTaskGroup(of: Bool.self) { group in
      group.addTask {
        for await state in states {
          if state == .started { return true }
          if state == .stopped { return false }
        }
        return false
      }
      group.addTask {
        try? await Task.sleep(nanoseconds: timeoutSeconds * 1_000_000_000)
        return false
      }
      let result = await group.next() ?? false
      group.cancelAll()
      return result
    }
  }
}
