import Foundation
import React

#if canImport(ActivityKit)
import ActivityKit
#endif

/// Drives the Lock Screen / Dynamic Island "LIVE" activity from JS.
///
/// The activity exists so the wearer can leave the app — which is the normal
/// case, phone pocketed, using something else — and still see that Clypso is
/// listening and how many clips have landed.
///
/// ActivityKit only permits a *start* while the app is in the foreground, so
/// `start()` is called when the capture session arms, not when the app is
/// backgrounded. Updates and `end()` work from either state.
@objc(LiveActivityBridge)
class LiveActivityBridge: NSObject {
  @objc static func requiresMainQueueSetup() -> Bool { false }

#if canImport(ActivityKit)
  /// The one activity we run. Typed `Any` because the stored-property type
  /// cannot itself carry an availability annotation.
  private var activityBox: Any?

  @available(iOS 16.2, *)
  private var activity: Activity<ClypsoActivityAttributes>? {
    get { activityBox as? Activity<ClypsoActivityAttributes> }
    set { activityBox = newValue }
  }

  /// ActivityKit budgets update frequency, and a rejected update is silently
  /// dropped. The buffer ticks every segment, so unchanged or too-frequent
  /// states are filtered here rather than spending the budget on them.
  private var lastPushedAt: TimeInterval = 0
  private var lastState: [String: Any]?
  private static let minUpdateInterval: TimeInterval = 2.0
#endif

  private static func log(_ message: String) {
    NSLog("[LiveActivity] %@", message)
    DiagnosticLog.write("[LiveActivity] \(message)")
  }

  /// Whether a Live Activity can actually be shown: the OS is new enough AND
  /// the user has not switched Live Activities off for Clypso in Settings.
  @objc func isSupported(
    _ resolve: @escaping RCTPromiseResolveBlock,
    reject: @escaping RCTPromiseRejectBlock
  ) {
#if canImport(ActivityKit)
    if #available(iOS 16.2, *) {
      resolve(ActivityAuthorizationInfo().areActivitiesEnabled)
      return
    }
#endif
    resolve(false)
  }

  @objc func start(
    _ deviceName: String,
    resolve: @escaping RCTPromiseResolveBlock,
    reject: @escaping RCTPromiseRejectBlock
  ) {
#if canImport(ActivityKit)
    guard #available(iOS 16.2, *) else {
      resolve(false)
      return
    }
    guard ActivityAuthorizationInfo().areActivitiesEnabled else {
      Self.log("not started — Live Activities are disabled for Clypso in Settings")
      resolve(false)
      return
    }
    // Re-arming must not stack activities: reuse whatever is already running.
    if activity != nil {
      resolve(true)
      return
    }
    let initial = ClypsoActivityAttributes.ContentState(
      bufferedSeconds: 0,
      clipCount: 0,
      recording: false,
      recordingSince: nil
    )
    do {
      activity = try Activity.request(
        attributes: ClypsoActivityAttributes(deviceName: deviceName),
        content: .init(state: initial, staleDate: nil)
      )
      lastPushedAt = 0
      lastState = nil
      Self.log("started for \(deviceName)")
      resolve(true)
    } catch {
      // Most common cause is starting while backgrounded, which ActivityKit
      // refuses. Never fatal — the app works without the activity.
      Self.log("start FAILED — \(error)")
      resolve(false)
    }
#else
    resolve(false)
#endif
  }

  @objc func update(
    _ bufferedSeconds: NSNumber,
    clipCount: NSNumber,
    recording: NSNumber,
    recordingSince: NSNumber,
    resolve: @escaping RCTPromiseResolveBlock,
    reject: @escaping RCTPromiseRejectBlock
  ) {
#if canImport(ActivityKit)
    guard #available(iOS 16.2, *), let activity = activity else {
      resolve(false)
      return
    }
    let isRecording = recording.boolValue
    // JS sends epoch milliseconds, 0 meaning "not recording".
    let since: Date? = recordingSince.doubleValue > 0
      ? Date(timeIntervalSince1970: recordingSince.doubleValue / 1000.0)
      : nil

    let state: [String: Any] = [
      "buffered": bufferedSeconds.intValue,
      "clips": clipCount.intValue,
      "rec": isRecording,
      "since": since?.timeIntervalSince1970 ?? 0,
    ]

    // A change in clip count or recording state is what the wearer is actually
    // waiting to see, so it bypasses the rate limit. A buffer tick does not.
    let structural = lastState?["clips"] as? Int != clipCount.intValue
      || lastState?["rec"] as? Bool != isRecording
    let now = Date().timeIntervalSince1970
    if !structural, now - lastPushedAt < Self.minUpdateInterval {
      resolve(false)
      return
    }
    lastPushedAt = now
    lastState = state

    let content = ClypsoActivityAttributes.ContentState(
      bufferedSeconds: bufferedSeconds.intValue,
      clipCount: clipCount.intValue,
      recording: isRecording,
      recordingSince: since
    )
    Task {
      await activity.update(.init(state: content, staleDate: nil))
    }
    resolve(true)
#else
    resolve(false)
#endif
  }

  @objc func end(
    _ resolve: @escaping RCTPromiseResolveBlock,
    reject: @escaping RCTPromiseRejectBlock
  ) {
#if canImport(ActivityKit)
    guard #available(iOS 16.2, *), let activity = activity else {
      resolve(false)
      return
    }
    self.activity = nil
    lastState = nil
    Self.log("ending")
    Task {
      // `.immediate` so disarming clears the Lock Screen right away; leaving a
      // stale "LIVE" banner up after capture stopped would be a lie.
      await activity.end(nil, dismissalPolicy: .immediate)
    }
    resolve(true)
#else
    resolve(false)
#endif
  }
}
