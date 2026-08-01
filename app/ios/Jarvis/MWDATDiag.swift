import Foundation
import MWDATCamera
import MWDATCore

/// Stable, individually diagnosable failure codes for the glasses pipeline.
///
/// Every SDK error case gets its own code. The point is that a field report can
/// name one cause — "307 stream_never_started" is a different investigation from
/// "103 session_already_exists" — instead of collapsing into the single generic
/// timeout that made this bug invisible for so long.
///
/// Blocks: 1xx session (`DeviceSessionError`), 2xx stream (`StreamError`),
/// 3xx our own pipeline logic. Codes are append-only; never renumber, because
/// they show up in user-pasted traces.
enum MWDATCode: Int {
  // 1xx — DeviceSessionError, exhaustive over SDK 0.8.0
  case sessionNoEligibleDevice = 101
  case sessionAlreadyStopped = 102
  /// Two `createSession` calls raced. Only one session may exist per device,
  /// so this is the direct signature of a re-entrant pipeline open.
  case sessionAlreadyExists = 103
  case sessionIdle = 104
  case sessionCapabilityAlreadyActive = 105
  case sessionCapabilityNotFound = 106
  case sessionUnexpected = 107
  case sessionThermalCritical = 108
  case sessionThermalEmergency = 109
  case sessionPeakPowerShutdown = 110
  case sessionBatteryCritical = 111
  /// The DAT app *on the glasses* is too old. Note this is reachable even when
  /// `device.compatibility()` reports `.compatible` — they are separate checks.
  case sessionDatAppUpdateRequired = 112
  case sessionDwaUnavailable = 113

  // 2xx — StreamError, exhaustive over SDK 0.8.0
  case streamInternal = 201
  case streamDeviceNotFound = 202
  case streamDeviceNotConnected = 203
  case streamTimeout = 204
  case streamVideoError = 205
  case streamPermissionDenied = 206
  case streamHingesClosed = 207
  case streamThermalCritical = 208
  case streamThermalEmergency = 209
  case streamPeakPowerShutdown = 210
  case streamBatteryCritical = 211

  // 3xx — pipeline logic in this bridge
  case pipelineNoDevice = 301
  case pipelineIncompatible = 302
  /// Session never reported `.started` and was not `.started` when we rechecked.
  case pipelineSessionStartTimeout = 303
  /// Session reached the terminal `.stopped` while we were waiting for it.
  case pipelineSessionStoppedDuringStart = 304
  /// Session sat in `.paused` past the deadline. Per the SDK we must not
  /// restart while paused, so this is surfaced rather than retried.
  case pipelineSessionPausedStall = 305
  case pipelineAddStreamReturnedNil = 306
  case pipelineStreamNeverStarted = 307
  /// `AutoDeviceSelector` never emitted an active device.
  case pipelineSelectorUnresolved = 308

  /// Short machine-readable slug. Kept in sync with `mwdatCodes` in
  /// `src/native/mwdatCodes.ts`.
  var slug: String {
    switch self {
    case .sessionNoEligibleDevice: return "session_no_eligible_device"
    case .sessionAlreadyStopped: return "session_already_stopped"
    case .sessionAlreadyExists: return "session_already_exists"
    case .sessionIdle: return "session_idle"
    case .sessionCapabilityAlreadyActive: return "session_capability_already_active"
    case .sessionCapabilityNotFound: return "session_capability_not_found"
    case .sessionUnexpected: return "session_unexpected"
    case .sessionThermalCritical: return "session_thermal_critical"
    case .sessionThermalEmergency: return "session_thermal_emergency"
    case .sessionPeakPowerShutdown: return "session_peak_power_shutdown"
    case .sessionBatteryCritical: return "session_battery_critical"
    case .sessionDatAppUpdateRequired: return "session_dat_app_update_required"
    case .sessionDwaUnavailable: return "session_dwa_unavailable"
    case .streamInternal: return "stream_internal"
    case .streamDeviceNotFound: return "stream_device_not_found"
    case .streamDeviceNotConnected: return "stream_device_not_connected"
    case .streamTimeout: return "stream_timeout"
    case .streamVideoError: return "stream_video_error"
    case .streamPermissionDenied: return "stream_permission_denied"
    case .streamHingesClosed: return "stream_hinges_closed"
    case .streamThermalCritical: return "stream_thermal_critical"
    case .streamThermalEmergency: return "stream_thermal_emergency"
    case .streamPeakPowerShutdown: return "stream_peak_power_shutdown"
    case .streamBatteryCritical: return "stream_battery_critical"
    case .pipelineNoDevice: return "pipeline_no_device"
    case .pipelineIncompatible: return "pipeline_incompatible"
    case .pipelineSessionStartTimeout: return "pipeline_session_start_timeout"
    case .pipelineSessionStoppedDuringStart: return "pipeline_session_stopped_during_start"
    case .pipelineSessionPausedStall: return "pipeline_session_paused_stall"
    case .pipelineAddStreamReturnedNil: return "pipeline_addstream_returned_nil"
    case .pipelineStreamNeverStarted: return "pipeline_stream_never_started"
    case .pipelineSelectorUnresolved: return "pipeline_selector_unresolved"
    }
  }

  /// What the wearer should actually do about it.
  var guidance: String {
    switch self {
    case .sessionNoEligibleDevice, .pipelineNoDevice, .streamDeviceNotFound:
      return "No glasses available. Unfold them, put them on, and check they show as "
        + "Connected in Meta AI with Jarvis enabled under App connections."
    case .sessionAlreadyExists:
      return "A glasses session is already open. This is a Jarvis bug — please report "
        + "code 103 with the diagnostic trace."
    case .sessionAlreadyStopped, .sessionIdle, .pipelineSessionStoppedDuringStart:
      return "The glasses ended the session. Unfold the glasses and try again."
    case .sessionCapabilityAlreadyActive, .sessionCapabilityNotFound, .sessionUnexpected,
         .streamInternal, .pipelineAddStreamReturnedNil:
      return "The glasses toolkit reported an internal error. Try again; if it repeats, "
        + "restart the Meta AI app."
    case .sessionThermalCritical, .sessionThermalEmergency,
         .streamThermalCritical, .streamThermalEmergency:
      return "The glasses are too hot to stream. Let them cool down and try again."
    case .sessionPeakPowerShutdown, .streamPeakPowerShutdown,
         .sessionBatteryCritical, .streamBatteryCritical:
      return "The glasses battery is too low to stream. Charge them and try again."
    case .sessionDatAppUpdateRequired:
      return "The glasses need a software update before Jarvis can use the camera. "
        + "Update them in Meta AI → Device settings → Software update."
    case .sessionDwaUnavailable:
      return "Meta AI is not reachable. Open the Meta AI app, confirm the glasses are "
        + "connected, and try again."
    case .streamDeviceNotConnected:
      return "The glasses disconnected. Check the Bluetooth link in Meta AI."
    case .streamTimeout, .pipelineSessionStartTimeout, .pipelineStreamNeverStarted:
      return "The glasses never answered the camera request. Make sure they are unfolded, "
        + "being worn, and in range."
    case .streamVideoError:
      return "The glasses camera failed to encode video. Try again."
    case .streamPermissionDenied:
      return "Camera access on the glasses is not allowed for Jarvis. Enable it in Meta AI."
    case .streamHingesClosed:
      return "The glasses are folded. Unfold them and try again."
    case .pipelineIncompatible:
      return "These glasses need a software update. Update them in Meta AI → "
        + "Device settings → Software update."
    case .pipelineSessionPausedStall:
      return "The glasses paused the session, usually because another experience took "
        + "over. Finish or dismiss it, then try again."
    case .pipelineSelectorUnresolved:
      return "Jarvis could not decide which glasses to use. Disconnect any glasses you "
        + "are not using in Meta AI, then try again."
    }
  }

  /// Exhaustive — the compiler enforces coverage, so a new SDK case cannot be
  /// silently collapsed into a generic error the way it was before.
  static func from(_ error: DeviceSessionError) -> MWDATCode {
    switch error {
    case .noEligibleDevice: return .sessionNoEligibleDevice
    case .sessionAlreadyStopped: return .sessionAlreadyStopped
    case .sessionAlreadyExists: return .sessionAlreadyExists
    case .sessionIdle: return .sessionIdle
    case .capabilityAlreadyActive: return .sessionCapabilityAlreadyActive
    case .capabilityNotFound: return .sessionCapabilityNotFound
    case .unexpectedError: return .sessionUnexpected
    case .thermalCritical: return .sessionThermalCritical
    case .thermalEmergency: return .sessionThermalEmergency
    case .peakPowerShutdown: return .sessionPeakPowerShutdown
    case .batteryCritical: return .sessionBatteryCritical
    case .datAppOnTheGlassesUpdateRequired: return .sessionDatAppUpdateRequired
    case .dwaUnavailable: return .sessionDwaUnavailable
    }
  }

  static func from(_ error: StreamError) -> MWDATCode {
    switch error {
    case .internalError: return .streamInternal
    case .deviceNotFound: return .streamDeviceNotFound
    case .deviceNotConnected: return .streamDeviceNotConnected
    case .timeout: return .streamTimeout
    case .videoStreamingError: return .streamVideoError
    case .permissionDenied: return .streamPermissionDenied
    case .hingesClosed: return .streamHingesClosed
    case .thermalCritical: return .streamThermalCritical
    case .thermalEmergency: return .streamThermalEmergency
    case .peakPowerShutdown: return .streamPeakPowerShutdown
    case .batteryCritical: return .streamBatteryCritical
    // `StreamError` is not `@frozen` (unlike `DeviceSessionError`), so the SDK
    // can add cases in a point release. Land on the generic stream code rather
    // than failing to build against a newer toolkit.
    @unknown default: return .streamInternal
    }
  }

  /// Best-effort classification of an untyped `Error` coming back out of the
  /// SDK, so a thrown `createSession` failure still lands on a real code.
  static func classify(_ error: Error) -> MWDATCode? {
    if let sessionError = error as? DeviceSessionError { return from(sessionError) }
    if let streamError = error as? StreamError { return from(streamError) }
    return nil
  }
}

/// A failure that carries a code, so the RN layer and the diagnostic trace
/// agree on what went wrong.
struct MWDATFailure: LocalizedError {
  let code: MWDATCode
  /// Extra machine context (last state, object id…) for the trace, not the user.
  let detail: String

  init(_ code: MWDATCode, detail: String = "") {
    self.code = code
    self.detail = detail
  }

  var errorDescription: String? {
    "[\(code.rawValue) \(code.slug)] \(code.guidance)"
  }
}

/// In-memory ring buffer of pipeline events, dumpable to JS without Xcode
/// attached. The failure reproduces while walking around, which is exactly when
/// a debugger is not available.
///
/// Entries carry a monotonic sequence number and a millisecond timestamp so a
/// restart loop can be read off directly, and session/stream events are tagged
/// with the owning object's identity — two distinct identities in one trace
/// means the pipeline was re-entered.
enum MWDATTrace {
  struct Entry {
    let seq: Int
    let atMs: Double
    let category: String
    let message: String
  }

  private static let queue = DispatchQueue(label: "com.mocinjay.jarvis.mwdat.trace")
  private static let capacity = 500
  private static var entries: [Entry] = []
  private static var nextSeq = 0

  /// Stable short identity for a session/stream object. `ObjectIdentifier`'s
  /// full value is noisy in a log; the low 16 bits are enough to tell two live
  /// objects apart within one run.
  static func tag(_ object: AnyObject) -> String {
    String(format: "%04x", UInt(bitPattern: ObjectIdentifier(object).hashValue) & 0xFFFF)
  }

  static func record(_ category: String, _ message: String) {
    let atMs = Date().timeIntervalSince1970 * 1000
    queue.async {
      let entry = Entry(seq: nextSeq, atMs: atMs, category: category, message: message)
      nextSeq += 1
      entries.append(entry)
      if entries.count > capacity {
        entries.removeFirst(entries.count - capacity)
      }
    }
  }

  static func reset() {
    queue.async {
      entries.removeAll()
      nextSeq = 0
    }
  }

  /// Snapshot for the debug screen / `getDiagnosticTrace`.
  static func dump() -> [[String: Any]] {
    queue.sync {
      entries.map { ["seq": $0.seq, "atMs": $0.atMs, "category": $0.category, "message": $0.message] }
    }
  }
}
