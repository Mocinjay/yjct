import CoreImage
import CoreMedia
import Foundation
import MWDATCamera
import MWDATCore
import MWDATMockDevice
import React
import UIKit
import VideoToolbox

/// React Native bridge for the Meta Wearables Device Access Toolkit.
///
/// Pipeline model: `startPreview()` opens the glasses session + camera stream
/// and emits throttled JPEG preview frames; `start(segmentSeconds)` attaches
/// the segment writer (and the phone-mic audio) to the same live stream. So the
/// Connect screen can show the wearer's view first, and arming upgrades the
/// running stream to recording without renegotiating the glasses link.
///
/// Threading: pipeline state (session, camera, stream, writer, openTask,
/// recovery, pipelineEpoch, arm tokens, activeSegmentSeconds) is written only
/// on the main actor, and RN methods that change it hop there. Elsewhere: the
/// SDK frame thread bumps `frameCount`/`lastFrameAt` and reads `writer` and the
/// preview flags to hand each frame on; `healthQueue` owns the watchdog
/// counters and sets `stallReported`/`pipelineStalled` (teardown resets them on
/// main); `previewDecodeQueue` owns the HEVC decoder; `previewQueue`
/// JPEG-encodes one frame at a time. Those cross-thread reads of flags and of
/// `writer` are deliberately unsynchronised.
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

  /// The glasses link can stop delivering frames without the stream ever
  /// leaving `.streaming` and without the SDK reporting an error — the wearer
  /// walks out of range, the glasses thermally throttle, or the BT link stalls.
  /// Nothing in the state machine notices, so the preview sits on its last
  /// frame, the rolling buffer stops filling and the wake word goes deaf, all
  /// while the UI still says LIVE. Frame arrival is the only honest signal.
  ///
  /// Long enough that a hiccup does not raise an error the wearer has to
  /// dismiss — the preview goes soft after ~2s off the health event's own
  /// numbers, which covers the honest-but-recoverable case. Reaching this means
  /// the link is gone and the session needs renegotiating.
  private static let stallSeconds: TimeInterval = 10

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
  /// Owns the glasses camera; `stream` is its child. Stopping it cascades.
  private var camera: MWDATCamera.Camera?
  private var stream: MWDATCamera.Stream?

  /// In-flight open: concurrent callers (startPreview, start, recovery,
  /// re-firing effects) coalesce onto it instead of each tearing the session
  /// down and rebuilding it, which loops the glasses' stop/start chime.
  private var openTask: Task<Void, Error>?
  /// Identifies the newest open, so only that open clears `openTask`.
  private var openGeneration = 0
  /// `pipelineEpoch` when `openTask` began. An open from an older epoch has
  /// been released and will throw; a new caller starts its own instead of
  /// joining it.
  private var openEpoch = 0
  /// The arm currently between start() and its writer attaching, if any.
  /// Only counted when the app backgrounds: a wearer who taps arm and pockets
  /// the phone wants that arm to finish, even though nothing records yet. A
  /// token, not a flag: an older arm that ends late must not clear a newer
  /// arm's claim.
  private var armInFlightToken: Int?
  /// Source of armInFlightToken values; bumped by every start().
  private var armToken = 0
  /// Bumped whenever the pipeline is released on purpose — stopPreview or an
  /// app-lifecycle release. An open checks it after every wait and abandons
  /// itself if it moved: cancelling a recovery does not stop the open the
  /// recovery is running, and without this the glasses would reopen behind a
  /// wearer who had left the screen or pocketed the phone.
  private var pipelineEpoch = 0

  /// Consumes the session state stream for the life of the session. Held so
  /// teardown can cancel it — an orphaned consumer from a previous attempt is
  /// one of the ways a dead session keeps driving live logic.
  private var sessionStateTask: Task<SessionStartOutcome, Never>?

  /// Per-stream SDK listeners; dropped in teardown().
  private var listenerTokens: [any AnyListenerToken] = []
  /// Registration/devices listeners, held while JS observes the emitter
  /// (startObserving → stopObserving).
  private var observerTokens: [any AnyListenerToken] = []
  /// Attached only while armed; nil in preview-only mode.
  private var writer: MWDATSegmentWriter?
  /// Set while our own teardown runs, so device-initiated state changes can be
  /// told apart from it.
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

  private let previewQueue = DispatchQueue(label: "com.mocinjay.clipso.mwdat.preview")
  /// The stream is compressed HEVC, so the preview has to decode it. Every frame
  /// is decoded while the preview is on, not just the ones shown — each depends
  /// on the one before. Decoder state is only touched on this queue.
  private let previewDecodeQueue = DispatchQueue(label: "com.mocinjay.clipso.mwdat.decode")
  private var previewDecoder: MWDATPreviewDecoder?
  /// No preview work while the app is in the background: nothing is on screen,
  /// and an armed capture keeps the stream (and its frames) running there.
  private var appInBackground = false
  /// At most one preview frame is being encoded; later frames are dropped, not
  /// queued, so the preview never lags the wearer. Set on the frame/decode
  /// thread, cleared on `previewQueue`, hence the lock.
  private let previewLock = NSLock()
  private var previewInFlight = false
  private var lastPreviewAt: TimeInterval = 0
  /// Host time of the last frame the glasses delivered, and the watchdog that
  /// decides the feed has stalled when that stops moving.
  private var lastFrameAt: TimeInterval = 0
  /// `frameCount` as of the previous health tick. Sampling the running total
  /// rather than resetting a per-tick counter keeps every mutation of the
  /// watchdog's own state on `healthQueue`; the SDK's frame thread only ever
  /// increments `frameCount` and stamps `lastFrameAt`.
  private var frameCountAtLastHealth = 0
  private var lastHealthAt: TimeInterval = 0
  private var stallReported = false
  /// Set once the watchdog has declared the feed stalled, cleared the moment
  /// frames come back. While it is set, `stream.state` is known to be lying —
  /// the SDK keeps reporting `.streaming` on a link that has delivered nothing
  /// for a minute — so `performOpenPipeline(epoch:)` must not take it at its word.
  private var pipelineStalled = false
  /// The segment length the user armed with, so a stall recovery can restore
  /// the writer instead of coming back with a live preview and no capture.
  /// This is the recording INTENT, not the writer: teardown() leaves it alone,
  /// because a recovery's own teardown must not erase what it is restoring.
  /// Only the wearer stopping (stopRecording) or recovery giving up
  /// clears it. Main actor only.
  private var activeSegmentSeconds: Double?
  /// Single-flight stall recovery, bounded. Glasses that are folded, flat, or
  /// out of range will not come back however often we ask, and each attempt
  /// renegotiates the link — so this gives up and tells the wearer instead of
  /// cycling the glasses for as long as the app is armed.
  private var recoveryTask: Task<Void, Never>?
  private var recoveryAttempts = 0
  /// True while stall recovery is opening a pipeline. Such a stream is opened
  /// on a link that just failed, so its frame rate says nothing about what the
  /// link carries when healthy; the resolution judge skips it.
  private var openingForRecovery = false
  private static let maxRecoveryAttempts = 3
  private var healthTimer: DispatchSourceTimer?
  private let healthQueue = DispatchQueue(label: "com.mocinjay.clipso.mwdat.health")
  /// Delivered fps over the stream's first seconds, to judge the requested
  /// resolution (see `judgeResolution`). healthQueue only.
  private var fpsSamples: [Double] = []
  private var resolutionJudged = false
  /// What the open stream asked for. Written before the health timer starts.
  private var streamResolution: StreamingResolution = .high
  /// `streamResolution` as copied onto healthQueue for the open stream.
  private var judgedResolution: StreamingResolution = .high
  private var healthTicks = 0
  /// Consecutive health ticks with frames flowing, for the open stream.
  private var healthyTicks = 0
  /// Seconds a rebuilt stream must run cleanly before recovery's attempt
  /// budget is given back. Not on open: an open alone proves nothing, and
  /// refilling there let a link that drops every minute cycle the glasses
  /// forever.
  private static let recoveryBudgetResetSeconds = 30

  /// Resolution the next stream asks for. `.high` (720x1280) needs the glasses'
  /// Wi-Fi link; over Bluetooth the SDK's ladder protects resolution by cutting
  /// frame rate, down to 15 fps. When a `.high` stream cannot hold its frame
  /// rate, later streams in this process ask for `.medium` instead — measured on
  /// a Bluetooth link the `.high` frames only carried ~504p of detail anyway
  /// (docs/VIDEO-QUALITY.md 4.3), so 30 fps at 504x896 loses nothing real. A
  /// relaunch tries `.high` again. Main actor only.
  private static var requestedResolution: StreamingResolution = .high
  /// Below this average, a `.high` stream is judged unable to hold 30 fps.
  private static let minimumHighFps = 26.0
  /// One shared CIContext: each one allocates a GPU context, and making one per
  /// frame exhausted memory.
  private static let ciContext = CIContext(options: [.useSoftwareRenderer: false])
  /// Preview work runs only while JS has a preview visible (setPreviewEnabled).
  /// startObserving/stopObserving cannot gate it: the always-attached
  /// segment/error listeners keep the emitter observed on every screen. Off
  /// until a view asks.
  private var previewEnabled = false
  /// Frames from the current stream; incremented on the SDK frame thread,
  /// reset in teardown().
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
    let center = NotificationCenter.default
    center.addObserver(
      self, selector: #selector(appDidEnterBackground),
      name: UIApplication.didEnterBackgroundNotification, object: nil
    )
    center.addObserver(
      self, selector: #selector(appWillEnterForeground),
      name: UIApplication.willEnterForegroundNotification, object: nil
    )
  }

  @objc private func appDidEnterBackground() {
    appInBackground = true
    resetPreviewDecoder()
  }

  @objc private func appWillEnterForeground() {
    appInBackground = false
    // An arm that finished while backgrounded could not start the mic — iOS
    // refuses to start audio capture from the background — and the writer has
    // been recording video only since.
    writer?.retryAudioIfNeeded()
  }

  /// Armed, whether or not a writer exists this instant: a stall recovery or
  /// a re-arm tears the writer down and brings it back only once the stream
  /// reopens. The intent outlives those teardowns and is cleared only when the
  /// wearer stops recording or recovery gives up.
  private var isCaptureIntended: Bool {
    writer != nil || activeSegmentSeconds != nil
  }

  @objc static func releaseGlassesForAppLifecycle(_ reason: String) {
    // A recovery or open between pipelines holds nothing yet, but will.
    guard let bridge = current,
          bridge.deviceSession != nil || bridge.stream != nil
            || bridge.recoveryTask != nil || bridge.openTask != nil
    else { return }
    // An armed capture survives backgrounding (clipping with the phone
    // pocketed is the product); preview-only sessions release, since they hold
    // the glasses' capture slot for nothing.
    if reason == "didEnterBackground", bridge.isCaptureIntended || bridge.armInFlightToken != nil {
      log("app lifecycle (\(reason)) — KEEPING glasses session, capture is armed")
      bridge.sendEvent(
        withName: Event.streamState,
        body: ["state": "streaming", "reason": "background-capture"]
      )
      return
    }
    log("app lifecycle (\(reason)) — releasing glasses session")
    // A recovery, or an open, still in flight would reopen the glasses in the
    // background.
    bridge.releasePipeline()
    // Tell JS the feed is gone so ConnectScreen can clear its "previewing"
    // latch and reopen when we return to the foreground. Without this, the
    // UI keeps showing a dead preview and never retries.
    bridge.sendEvent(
      withName: Event.streamState,
      body: ["state": "stopped", "reason": reason]
    )
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
      // No payload: JS answers by calling getDiagnostics(); building one here
      // would read pipeline state off the main actor.
      wearables.addDevicesListener { [weak self] _ in
        self?.sendEvent(withName: Event.devices, body: nil)
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

  /// `operation`'s result, or nil if `seconds` pass first.
  ///
  /// Deliberately not a task group: a group waits for every child before it
  /// returns, so an operation that ignores cancellation — an SDK call that never
  /// answers — would hold the "timeout" open for as long as it hangs. Here the
  /// loser is cancelled and abandoned.
  private static func withTimeout<T: Sendable>(
    seconds: UInt64,
    _ operation: @escaping @Sendable () async -> T?
  ) async -> T? {
    let (results, sink) = AsyncStream<T?>.makeStream()
    let work = Task {
      let value = await operation()
      sink.yield(value)
    }
    let timer = Task {
      try? await Task.sleep(nanoseconds: seconds * 1_000_000_000)
      sink.yield(nil)
    }
    // The first yield wins; once finished, the loser's yield is a no-op.
    var iterator = results.makeAsyncIterator()
    let result = await iterator.next() ?? nil
    sink.finish()
    work.cancel()
    timer.cancel()
    return result
  }

  // MARK: - Preview / recording

  /// Opens (or reuses) the glasses pipeline for the preview; no recording.
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
        // An abandoned open was already torn down by whatever released it,
        // and tearing down again here could stop a newer open's session.
        if self.writer == nil, !(error is CancellationError) { self.teardown() }
        reject("mwdat_preview", Self.describeOpenError(error), error)
      }
    }
  }

  @objc(stopPreview:reject:)
  func stopPreview(
    _ resolve: @escaping RCTPromiseResolveBlock,
    reject _: @escaping RCTPromiseRejectBlock
  ) {
    // Main actor, like the recovery loop it may have to stop: run from the
    // module queue it raced the loop's reads of the writer and the intent.
    Task { @MainActor in
      // Never kill the pipeline out from under an active recording —
      // including one a stall recovery is still rebuilding.
      if !isCaptureIntended { releasePipeline() }
      resolve(nil)
    }
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
    previewEnabled = enabled.boolValue
    if !enabled.boolValue { resetPreviewDecoder() }
    Self.log("preview emission \(enabled.boolValue ? "enabled" : "disabled")")
    resolve(nil)
  }

  /// Drops the preview's decode session. The next frame shown starts a fresh
  /// one at the next keyframe.
  private func resetPreviewDecoder() {
    previewDecodeQueue.async { [weak self] in self?.previewDecoder = nil }
  }

  /// Arms capture: opens or reuses the pipeline, then attaches the segment
  /// writer. A newer start() supersedes one still opening.
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
        // Arming by hand is a fresh start: give recovery its full budget back,
        // otherwise one bad session leaves the app unable to self-heal until
        // it is relaunched. Not mid-recovery, though: resetting a running loop
        // on every JS re-arm kept it from ever running out.
        if recoveryTask == nil { recoveryAttempts = 0 }
        armToken += 1
        let token = armToken
        armInFlightToken = token
        defer { if armInFlightToken == token { armInFlightToken = nil } }
        try await openPipelineIfNeeded()
        // stopRecording() while the open ran, or a newer arm that took
        // over: attaching now would record with nothing in JS listening.
        guard armInFlightToken == token else {
          Self.log("start() superseded while opening — not attaching a writer")
          throw CancellationError()
        }
        try attachWriter(segmentSeconds: segmentSeconds.doubleValue)
        resolve(nil)
      } catch {
        // The snapshot can say "open" for a pipeline that open then had to
        // rebuild; if the rebuild failed, nothing is watching what it left.
        // An abandoned open was already torn down by whatever released it.
        if !(error is CancellationError), !pipelineAlreadyOpen || healthTimer == nil {
          teardown()
        }
        reject("mwdat_start", Self.describeOpenError(error), error)
      }
    }
  }

  @objc(cut:reject:)
  func cut(
    _ resolve: @escaping RCTPromiseResolveBlock,
    reject _: @escaping RCTPromiseRejectBlock
  ) {
    // Main actor, where `writer` is assigned; cut() itself runs on the
    // writer's queue.
    Task { @MainActor in
      guard let writer else {
        resolve(nil)
        return
      }
      writer.cut { resolve(nil) }
    }
  }

  /// Detach the segment writer only. Keeps the glasses session + camera stream
  /// alive so Connect → Live (and React effect remounts) can re-arm without the
  /// glasses playing their stop/start chime and dropping the capture slot.
  @objc(stopRecording:reject:)
  func stopRecording(
    _ resolve: @escaping RCTPromiseResolveBlock,
    reject _: @escaping RCTPromiseRejectBlock
  ) {
    Task { @MainActor in
      if writer != nil {
        Self.log("stopRecording() — detaching writer, keeping stream")
        writer?.stopAndDiscard()
        writer = nil
      }
      // Recording is off by intent now: a stall recovery in flight, or a later
      // one, must bring the preview back without silently resuming capture.
      // On the main actor so a recovery mid-open reads this before it attaches.
      activeSegmentSeconds = nil
      armInFlightToken = nil
      resolve(nil)
    }
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
    // Main actor, where `stream` is assigned and cleared.
    Task { @MainActor in
      guard let stream, stream.state == .streaming else {
        Self.log("chime() — no streaming session, skipped")
        resolve(false)
        return
      }
      let issued = stream.capturePhoto(format: .jpeg)
      Self.log("chime() — capturePhoto \(issued ? "issued" : "refused by SDK")")
      resolve(issued)
    }
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
    if let existing = openTask, openEpoch == pipelineEpoch {
      Self.log("open already in flight — coalescing onto it")
      try await existing.value
      return
    }
    openGeneration += 1
    let generation = openGeneration
    // Captured here, not inside the open: a release between now and the
    // task's first run must abandon it, not be adopted as its baseline.
    let epoch = pipelineEpoch
    openEpoch = epoch
    let task = Task { @MainActor in
      // Cleared by the open itself the moment it ends. Its starter may resume
      // only after a newer open began, and clearing then dropped that one's
      // handle; a waiter that resumed first found this finished, failed
      // handle still set and coalesced onto it.
      defer { if openGeneration == generation { openTask = nil } }
      try await performOpenPipeline(epoch: epoch)
    }
    openTask = task
    try await task.value
  }

  /// What JS shows for a failed open. An open abandoned because the pipeline
  /// was released has no cause worth showing as Swift's raw CancellationError.
  private static func describeOpenError(_ error: Error) -> String {
    if error is CancellationError {
      return "The glasses connection was closed before it finished opening. Try again."
    }
    return error.localizedDescription
  }

  /// Throws if the pipeline was released on purpose while an open waited.
  @MainActor
  private func ensureOpenStillWanted(_ epoch: Int) throws {
    guard epoch == pipelineEpoch else {
      Self.log("open abandoned — the pipeline was released while it waited")
      throw CancellationError()
    }
  }

  @MainActor
  private func performOpenPipeline(epoch: Int) async throws {
    try ensureOpenStillWanted(epoch)
    // After a stall the SDK still reports a started session and a .streaming
    // stream, so the reuse checks below cannot be trusted: rebuild.
    if pipelineStalled {
      Self.log("pipeline claims open but the feed stalled — rebuilding it")
    } else {
      // Reuse a live, watched stream rather than renegotiating (which costs
      // the glasses' stop/start chime).
      if let stream, stream.state == .streaming || stream.state == .starting, healthTimer != nil {
        Self.log(
          "pipeline already open (stream \(stream.state), session=\(deviceSession.map { String(describing: $0.state) } ?? "nil"))"
        )
        return
      }
      // A stream that has stopped, or one nothing is watching, is not open:
      // since SDK 0.9 a stopped stream does not come back on its own.
      if let session = deviceSession, session.state == .started,
         let stream, stream.state != .stopped, healthTimer != nil {
        Self.log("pipeline already open (session started, stream \(stream.state))")
        return
      }
    }
    // Keep what the writer has, in case it is attached to the stream being
    // replaced.
    writer?.finishCurrentSegment()
    teardownQuietly()

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
      try ensureOpenStillWanted(epoch)
      Self.log("waitForDevice → \(appeared)")
      guard appeared else {
        throw NSError(
          domain: "MWDATBridge", code: 12,
          userInfo: [
            NSLocalizedDescriptionKey:
              "No glasses found. Unfold them, put them on, check they show "
              + "as Connected in Meta AI, and that Clipso is enabled under "
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
      try ensureOpenStillWanted(epoch)
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

    // Subscribe before start() so a prompt .started is not missed.
    let states = session.stateStream()
    let startedSignal = Self.watchSessionStates(states)
    sessionStateTask = startedSignal

    try session.start()
    Self.log("session.start() returned, state=\(String(describing: session.state))")

    if session.state != .started {
      Self.log("waiting for session to reach started (60s max)…")
      let outcome = await Self.waitForStarted(startedSignal, timeoutSeconds: 60)
      try ensureOpenStillWanted(epoch)
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

    // .hvc1: the glasses' own HEVC, written as-is by the segment writer, as in
    // Meta's CameraAccess sample. `.raw` would mean a phone-side decode and
    // H.264 re-encode: a generation of quality lost, and a realtime encoder
    // that drops frames under load. The preview decodes for itself
    // (MWDATPreviewDecoder), only while visible. 30 fps is the glasses'
    // maximum; see `requestedResolution` for the size.
    let resolution = Self.requestedResolution
    let config = StreamConfiguration(videoCodec: .hvc1, resolution: resolution, frameRate: 30)
    Self.log("addCamera(codec: hvc1, resolution: \(resolution), fps: 30)…")
    guard let newCamera = try session.addCamera(config: config) else {
      throw NSError(
        domain: "MWDATBridge", code: 11,
        userInfo: [NSLocalizedDescriptionKey: "Could not open the glasses camera stream."]
      )
    }
    camera = newCamera
    let newStream = newCamera.stream
    streamResolution = resolution
    stream = newStream
    lastStreamError = nil
    streamHasLeftStopped = false

    listenerTokens.append(
      newStream.videoFramePublisher.listen { [weak self] frame in
        guard let self else { return }
        self.frameCount += 1
        self.lastFrameAt = CACurrentMediaTime()
        // First frame only; the HEALTH line reports the rate after that.
        if self.frameCount == 1 {
          Self.logFrameDiagnostics(frame)
        }
        self.writer?.appendVideo(frame.sampleBuffer)
        self.emitPreviewFrame(frame)
      }
    )
    listenerTokens.append(
      newStream.statePublisher.listen { [weak self, weak newStream] state in
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
          // Since SDK 0.9 a stopped stream stays stopped (e.g. glasses taken
          // off → hingesClosed), so rebuild now rather than after the 10s
          // watchdog. Only for the bridge's current, watched stream: our own
          // teardown clears `stream` first, and a stream that never reached
          // .streaming (no health timer yet) fails its own open.
          Task { @MainActor [weak self, weak newStream] in
            guard let self, let newStream, self.stream === newStream,
                  !self.stopping, self.healthTimer != nil
            else { return }
            Self.log("stream stopped on its own — rebuilding now")
            self.pipelineStalled = true
            await self.attemptStallRecovery()
          }
        }
      }
    )
    listenerTokens.append(
      newStream.errorPublisher.listen { [weak self] error in
        Self.log("stream ERROR: \(error.description)")
        // A still capture that failed (the chime) leaves the video running. It
        // must not read as a dead stream: that aborts arming and puts the
        // capture screen into its error state.
        if error == .photoCaptureFailed { return }
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
        // SDK 1.0 documents this one as a non-blocking compatibility warning:
        // the session carries on. Surfacing it would put capture into its
        // error state over a working stream.
        if error == .dwaOutOfStuRange { return }
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
      let streaming = await waitForStreaming(newStream, epoch: epoch, timeoutSeconds: 45)
      try ensureOpenStillWanted(epoch)
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
              + "and that camera access is allowed for Clipso in Meta AI.",
          ]
        )
      }
    }
    Self.log("stream is .streaming — frames should follow")
    startHealthWatch()
  }

  /// Reports the feed's real frame rate to JS once a second while a preview is
  /// visible, and raises an error when frames stop arriving even though nothing
  /// else says anything is wrong. Without it a stalled link is
  /// indistinguishable from a quiet scene: the UI keeps claiming LIVE over a
  /// frozen picture.
  private func startHealthWatch() {
    guard healthTimer == nil else { return }
    // Host time (CACurrentMediaTime), not wall-clock: these are only compared
    // as intervals, and a wall-clock step would fake a stall.
    lastFrameAt = CACurrentMediaTime()
    lastHealthAt = lastFrameAt
    frameCountAtLastHealth = frameCount
    stallReported = false
    pipelineStalled = false
    let watchedResolution = streamResolution
    // Only a stream opened in ordinary conditions is judged: not one rebuilt
    // on a link that just failed, not one opened in the background, and not
    // MockDeviceKit's fixed-rate test feed.
    let skipJudging = openingForRecovery || appInBackground || mockActive
    healthQueue.async { [weak self] in
      guard let self else { return }
      self.fpsSamples = []
      self.resolutionJudged = skipJudging
      self.healthTicks = 0
      self.healthyTicks = 0
      self.judgedResolution = watchedResolution
    }

    let timer = DispatchSource.makeTimerSource(queue: healthQueue)
    timer.schedule(deadline: .now() + 1, repeating: 1)
    timer.setEventHandler { [weak self] in
      guard let self else { return }
      let now = CACurrentMediaTime()
      let elapsed = max(0.001, now - self.lastHealthAt)
      let delivered = self.frameCount - self.frameCountAtLastHealth
      let fps = Double(max(0, delivered)) / elapsed
      self.frameCountAtLastHealth = self.frameCount
      self.lastHealthAt = now

      let sinceFrame = now - self.lastFrameAt
      // Only GlassesPreview listens, and only while it is showing the feed.
      if self.previewEnabled, !self.appInBackground {
        self.sendEvent(
          withName: Event.streamHealth,
          body: [
            "fps": (fps * 10).rounded() / 10,
            "secondsSinceFrame": (sinceFrame * 10).rounded() / 10,
            "recording": self.writer != nil,
          ]
        )
      }
      // The delivered rate, in the diagnostics log: the only record of what
      // the link actually carried, as opposed to what was asked for.
      self.healthTicks += 1
      if self.healthTicks % 5 == 0 {
        Self.log(
          String(
            format: "HEALTH fps=%.1f sinceFrame=%.1fs resolution=%@ recording=%@",
            fps, sinceFrame, String(describing: self.judgedResolution),
            self.writer != nil ? "YES" : "NO"
          )
        )
      }
      if sinceFrame < 1 { self.judgeResolution(fps: fps) }
      self.healthyTicks = sinceFrame < 1 ? self.healthyTicks + 1 : 0
      if self.healthyTicks == Self.recoveryBudgetResetSeconds {
        // A stream that stays healthy earns back the full recovery budget.
        DispatchQueue.main.async { [weak self] in
          guard let self, self.recoveryTask == nil, self.recoveryAttempts > 0 else { return }
          Self.log("stream healthy for \(Self.recoveryBudgetResetSeconds)s — recovery budget restored")
          self.recoveryAttempts = 0
        }
      }

      guard sinceFrame > Self.stallSeconds else {
        if self.stallReported {
          self.stallReported = false
          self.pipelineStalled = false
          // Main-actor state; the recovery loop reads it there.
          DispatchQueue.main.async { [weak self] in self?.recoveryAttempts = 0 }
          Self.log("frames RESUMED after stall")
          self.sendEvent(
            withName: Event.streamState,
            body: ["state": "streaming", "reason": "recovered"]
          )
        }
        return
      }
      // Fire once per stall, not once per second: the UI shows one banner and
      // the wearer is not buried under a repeating error.
      guard !self.stallReported, !self.stopping else { return }
      self.stallReported = true
      // Latched separately from `stallReported` so it survives for the reopen:
      // the next open must rebuild the pipeline instead of trusting the SDK.
      self.pipelineStalled = true
      Self.log(String(format: "STALL — no glasses frame for %.1fs", sinceFrame))
      self.sendEvent(
        withName: Event.error,
        body: [
          "message": "The glasses feed stalled — no video for "
            + "\(Int(sinceFrame))s. Check they are unfolded, being worn and in range.",
        ]
      )
      // Nothing else will ever kick this: the SDK reports no error and leaves
      // `stream.state` at `.streaming`, so without a rebuild from here the feed
      // stays dead until the app is force-quit.
      Task { @MainActor [weak self] in await self?.attemptStallRecovery() }
    }
    timer.resume()
    healthTimer = timer
  }

  /// Decides once per `.high` stream whether the link holds 30 fps at that
  /// size, from ten seconds of delivered rate after a short settle. If it does
  /// not, later streams ask for `.medium`. The live stream is left alone:
  /// renegotiating it mid-capture costs the glasses' stop/start chime and a gap
  /// in the rolling buffer. healthQueue only.
  private func judgeResolution(fps: Double) {
    guard !resolutionJudged, judgedResolution == .high, healthTicks > 3 else { return }
    fpsSamples.append(fps)
    guard fpsSamples.count >= 10 else { return }
    resolutionJudged = true
    let average = fpsSamples.reduce(0, +) / Double(fpsSamples.count)
    if average >= Self.minimumHighFps {
      Self.log(String(format: "high held %.1f fps — keeping it", average))
      return
    }
    Self.log(String(format: "high averaged %.1f fps — the next stream asks for medium@30", average))
    DispatchQueue.main.async { Self.requestedResolution = .medium }
  }

  /// Rebuild the pipeline after the watchdog declares the feed stalled.
  ///
  /// Runs at most `maxRecoveryAttempts` times with a widening backoff, and only
  /// while the app still wants frames. Each attempt starts with a teardown, and
  /// running out of attempts ends with one, so nothing half-open is left for
  /// the reuse guards in `performOpenPipeline(epoch:)` to mistake for a live stream.
  @MainActor
  private func attemptStallRecovery() async {
    guard recoveryTask == nil, !stopping else { return }
    guard recoveryAttempts < Self.maxRecoveryAttempts else {
      Self.log("stall recovery exhausted — leaving the pipeline down for the wearer to retry")
      return
    }

    let task = Task { @MainActor in
      // Looped rather than one attempt per call, because a failed rebuild
      // leaves no health timer running — nothing would be left to fire the
      // next attempt, and the wearer would never hear why it went quiet.
      while recoveryAttempts < Self.maxRecoveryAttempts {
        recoveryAttempts += 1
        let attempt = recoveryAttempts
        let backoffSeconds = attempt * 2
        Self.log(
          "stall recovery \(attempt)/\(Self.maxRecoveryAttempts) in \(backoffSeconds)s "
            + "(recording=\(activeSegmentSeconds != nil))"
        )
        try? await Task.sleep(nanoseconds: UInt64(backoffSeconds) * 1_000_000_000)
        // A release (stopPreview, app lifecycle) during the backoff means the
        // wearer no longer wants frames; rebuilding here would restart the
        // glasses behind their back.
        guard !Task.isCancelled, !stopping else { return }

        // A JS re-arm may be rebuilding the pipeline, or have rebuilt it,
        // while this slept. Tearing that down would cost the glasses' stop and
        // start chimes and a hole in the buffer just as the feed came back.
        if let pending = openTask, openEpoch == pipelineEpoch { _ = try? await pending.value }
        guard !Task.isCancelled else { return }
        if let stream, stream.state == .streaming, healthTimer != nil, !pipelineStalled {
          Self.log("stall recovery \(attempt): the pipeline was already rebuilt — standing down")
          return
        }

        // The footage up to the dropout is kept, not discarded with the
        // writer: those seconds are the likeliest ones to be clipped.
        writer?.finishCurrentSegment()
        teardownQuietly()
        do {
          openingForRecovery = true
          defer { openingForRecovery = false }
          try await openPipelineIfNeeded()
          // Read now, not before the open: the wearer may have disarmed while
          // it ran, and then the feed comes back as preview only.
          guard !Task.isCancelled else { return }
          if let segmentSeconds = activeSegmentSeconds {
            try attachWriter(segmentSeconds: segmentSeconds)
          }
          // Open is not the same as live. The rebuilt pipeline gets a fresh
          // health timer, so if frames still never arrive it stalls again and
          // calls back in here with the attempt budget already spent down.
          Self.log("stall recovery \(attempt): pipeline rebuilt — waiting for frames")
          return
        } catch {
          Self.log("stall recovery \(attempt) FAILED: \(error.localizedDescription)")
        }
      }

      // Out of attempts: tear down what the failed attempts left (a session
      // and stopped stream with no health timer would pass the reuse checks
      // as open) and drop the recording intent; the next arm sets it again.
      activeSegmentSeconds = nil
      teardownQuietly()
      sendEvent(
        withName: Event.error,
        body: [
          "message": "The glasses feed stopped and could not be restarted after "
            + "\(Self.maxRecoveryAttempts) attempts. Check they are unfolded, charged, "
            + "being worn and in range, then arm again.",
        ]
      )
    }
    recoveryTask = task
    await task.value
    recoveryTask = nil
  }

  private func attachWriter(segmentSeconds: Double) throws {
    activeSegmentSeconds = segmentSeconds
    guard writer == nil else { return }
    let newWriter = MWDATSegmentWriter(
      segmentSeconds: segmentSeconds,
      // The writer logs each segment it writes; this only forwards it to JS.
      onSegment: { [weak self] segment in
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
    // Audio is best-effort and retries each rotation; a mic failure must not
    // abort arming or stop the video stream.
    newWriter.startAudio()
  }

  /// Our own teardown, not a device-initiated drop: `stopping` keeps the
  /// stream-state listener from reporting it as an error or recovering it.
  private func teardownQuietly() {
    stopping = true
    teardown()
    stopping = false
  }

  /// Releases the pipeline on purpose (stopPreview, app lifecycle): stops any
  /// recovery, abandons any in-flight open, and tears down.
  private func releasePipeline() {
    recoveryTask?.cancel()
    pipelineEpoch += 1
    teardownQuietly()
  }

  private func teardown() {
    // Cancelled before the session is released: an orphaned consumer left
    // running against a dead session is exactly how a previous attempt keeps
    // driving live retry logic.
    sessionStateTask?.cancel()
    sessionStateTask = nil
    healthTimer?.cancel()
    healthTimer = nil
    writer?.stopAndDiscard()
    writer = nil
    stream?.stop()
    stream = nil
    camera?.stop()
    camera = nil
    deviceSession?.stop()
    deviceSession = nil
    resetPreviewDecoder()
    // Released LAST: clearing these first would detach the state/error
    // listeners before stop(), silently swallowing whatever the SDK reports
    // on the way down — which is exactly the failure we need to see.
    listenerTokens = []
    frameCount = 0
    frameCountAtLastHealth = 0
    lastFrameAt = 0
    stallReported = false
    pipelineStalled = false
    // Deliberately NOT resetting recoveryAttempts or activeSegmentSeconds:
    // teardown runs inside the recovery itself, and clearing the count there
    // would retry forever, clearing the intent would bring capture back
    // without its writer.
    previewEmitCount = 0
    previewFailLogged = false
    streamHasLeftStopped = false
    lastStreamError = nil
  }

  /// One-shot dump of the first frame of each stream: codec fourCC, size,
  /// keyframe flag — what the glasses actually delivered.
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
    parts.append("keyframe=\(sample.isVideoKeyframe)")
    parts.append("samples=\(CMSampleBufferGetNumSamples(sample))")
    parts.append("dataReady=\(CMSampleBufferDataIsReady(sample))")

    log("FRAME ANATOMY — " + parts.joined(separator: " "))
  }

  /// Longest edge of a preview frame, in pixels. The feed is a ~1/3-screen
  /// viewfinder, so the stream's full 720x1280 (or 504x896) is far more detail
  /// than is ever displayed — and every extra pixel is paid for three times:
  /// CoreImage render, JPEG encode, and a base64 string across the bridge.
  /// Capping the edge cuts all three, which is what buys the frame rate below.
  private static let previewMaxEdge: CGFloat = 448
  /// Made once, like `ciContext`, rather than for every JPEG.
  private static let previewColorSpace = CGColorSpaceCreateDeviceRGB()

  /// ~8 fps JPEG preview of the wearer's view. Recording does not depend on
  /// any of this: segments are written from the compressed frames directly.
  private func emitPreviewFrame(_ frame: VideoFrame) {
    guard previewEnabled, !appInBackground else { return }
    let sample = frame.sampleBuffer
    if let pixelBuffer = CMSampleBufferGetImageBuffer(sample) {
      emitPreview(pixelBuffer)
      return
    }
    previewDecodeQueue.async { [weak self] in
      guard let self, self.previewEnabled, !self.appInBackground else { return }
      let decoder = self.previewDecoder ?? MWDATPreviewDecoder()
      self.previewDecoder = decoder
      guard let pixelBuffer = decoder.decode(sample) else { return }
      self.emitPreview(pixelBuffer)
    }
  }

  /// Throttles decoded frames down to the preview rate and JPEG-encodes one at
  /// a time on `previewQueue`.
  private func emitPreview(_ pixelBuffer: CVPixelBuffer) {
    let now = CACurrentMediaTime()
    guard now - lastPreviewAt > 0.12 else { return }

    previewLock.lock()
    let busy = previewInFlight
    if !busy { previewInFlight = true }
    previewLock.unlock()
    guard !busy else { return }
    lastPreviewAt = now

    previewQueue.async { [weak self] in
      guard let self else { return }
      defer {
        self.previewLock.lock()
        self.previewInFlight = false
        self.previewLock.unlock()
      }

      // Scale and encode on the GPU in one pass — `jpegRepresentation` skips
      // the CGImage → UIImage → jpegData round trip that allocated a full-size
      // bitmap per frame.
      var image = CIImage(cvPixelBuffer: pixelBuffer)
      let longestEdge = max(image.extent.width, image.extent.height)
      let scale = longestEdge > 0 ? min(1, Self.previewMaxEdge / longestEdge) : 1
      if scale < 1 {
        image = image.transformed(by: CGAffineTransform(scaleX: scale, y: scale))
      }
      let jpeg = Self.ciContext.jpegRepresentation(
        of: image,
        colorSpace: Self.previewColorSpace,
        options: [
          kCGImageDestinationLossyCompressionQuality as CIImageRepresentationOption: 0.4,
        ]
      )

      guard let jpeg else {
        if !self.previewFailLogged {
          self.previewFailLogged = true
          Self.log("preview JPEG encode FAILED — frames decode but cannot render")
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

  /// Polls stream.state (Stream has no async state sequence) until .streaming.
  /// A new stream sits in .stopped until the glasses answer, so .stopped means
  /// failure only after the stream has left it. An SDK error or a release of the
  /// pipeline (epoch change) ends the wait early; otherwise it gives up after
  /// `timeoutSeconds`.
  @MainActor
  private func waitForStreaming(
    _ stream: MWDATCamera.Stream,
    epoch: Int,
    timeoutSeconds: UInt64
  ) async -> Bool {
    let deadline = Date().addingTimeInterval(TimeInterval(timeoutSeconds))
    var loggedState: MWDATCamera.StreamState?
    var everLeftStopped = false

    while Date() < deadline {
      if epoch != pipelineEpoch {
        Self.log("waitForStreaming: pipeline released — abandoning the wait")
        return false
      }
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

  /// True once the auto-selector picks a device. On timeout, whether it has
  /// one by then.
  private static func waitForActiveDevice(
    _ selector: AutoDeviceSelector,
    timeoutSeconds: UInt64
  ) async -> Bool {
    let resolved: Bool? = await withTimeout(seconds: timeoutSeconds) {
      for await device in selector.activeDeviceStream() where device != nil {
        return true
      }
      return false
    }
    return resolved ?? (selector.activeDevice != nil)
  }

  /// True once the device list is non-empty. On timeout, whether it is by then.
  private static func waitForDevice(
    _ wearables: any WearablesInterface,
    timeoutSeconds: UInt64
  ) async -> Bool {
    let appeared: Bool? = await withTimeout(seconds: timeoutSeconds) {
      for await devices in wearables.devicesStream() where !devices.isEmpty {
        return true
      }
      return false
    }
    return appeared ?? !wearables.devices.isEmpty
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

  /// `signal`'s outcome, or `.timedOut`. Built on `withTimeout`, not a task
  /// group: `Task.value` ignores cancellation, so a group would wait for the
  /// session to start or stop however long that took. The abandoned waiter
  /// ends when teardown() cancels `sessionStateTask`.
  private static func waitForStarted(
    _ signal: Task<SessionStartOutcome, Never>,
    timeoutSeconds: UInt64
  ) async -> SessionStartOutcome {
    let outcome: SessionStartOutcome? = await withTimeout(seconds: timeoutSeconds) {
      await signal.value
    }
    return outcome ?? .timedOut
  }
}

/// Decodes the glasses' compressed HEVC stream for the on-screen preview.
///
/// Recording never goes through here — segments are written from the
/// compressed frames — so this only runs while a preview is visible. Decoding
/// has to start on a keyframe; until one arrives after a (re)start nothing is
/// shown, rather than the smeared frames a mid-GOP start produces. Not
/// thread-safe: call it from one serial queue.
final class MWDATPreviewDecoder {
  private var session: VTDecompressionSession?
  private var formatDescription: CMFormatDescription?
  private var awaitingKeyframe = true
  private var consecutiveFailures = 0

  /// Holds the decoder's output across the callback. The callback runs before
  /// `VTDecompressionSessionDecodeFrame` returns because no asynchronous flag is
  /// passed — do not add one.
  private final class Output: @unchecked Sendable {
    var pixelBuffer: CVPixelBuffer?
  }

  deinit {
    invalidate()
  }

  func decode(_ sample: CMSampleBuffer) -> CVPixelBuffer? {
    guard CMSampleBufferGetDataBuffer(sample) != nil,
          let format = CMSampleBufferGetFormatDescription(sample)
    else { return nil }

    // A format change (the quality ladder switching resolution) or a session
    // iOS invalidated needs a new session, starting again at a keyframe.
    if let current = formatDescription,
       !CMFormatDescriptionEqual(current, otherFormatDescription: format) {
      invalidate()
    }
    if let session, !VTDecompressionSessionCanAcceptFormatDescription(session, formatDescription: format) {
      invalidate()
    }
    if session == nil {
      var created: VTDecompressionSession?
      let attributes: [CFString: Any] = [
        kCVPixelBufferPixelFormatTypeKey: kCVPixelFormatType_420YpCbCr8BiPlanarVideoRange,
      ]
      let status = VTDecompressionSessionCreate(
        allocator: kCFAllocatorDefault,
        formatDescription: format,
        decoderSpecification: nil,
        imageBufferAttributes: attributes as CFDictionary,
        outputCallback: nil,
        decompressionSessionOut: &created
      )
      guard status == noErr, let created else { return nil }
      session = created
      formatDescription = format
      awaitingKeyframe = true
    }

    let keyframe = sample.isVideoKeyframe
    if awaitingKeyframe, !keyframe { return nil }
    guard let session else { return nil }

    let output = Output()
    let status = VTDecompressionSessionDecodeFrame(
      session,
      sampleBuffer: sample,
      flags: [],
      infoFlagsOut: nil
    ) { frameStatus, _, imageBuffer, _, _ in
      if frameStatus == noErr { output.pixelBuffer = imageBuffer }
    }
    guard status == noErr else {
      // Transient errors happen; three in a row means the session is gone.
      consecutiveFailures += 1
      if consecutiveFailures >= 3 { invalidate() }
      return nil
    }
    consecutiveFailures = 0
    if keyframe { awaitingKeyframe = false }
    return output.pixelBuffer
  }

  private func invalidate() {
    if let session {
      VTDecompressionSessionInvalidate(session)
    }
    session = nil
    formatDescription = nil
    awaitingKeyframe = true
    consecutiveFailures = 0
  }
}
