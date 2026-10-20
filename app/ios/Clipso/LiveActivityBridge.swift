import ActivityKit
import Foundation
import React

/// Drives the Lock Screen / Dynamic Island "LIVE" activity from JS.
///
/// The activity exists so the wearer can leave the app — which is the normal
/// case, phone pocketed, using something else — and still see that Clipso is
/// listening and how many clips have landed.
///
/// ActivityKit only permits a *start* while the app is in the foreground. JS
/// calls `start()` when the wearer arms capture (they are in the app then),
/// and keeps that one activity alive across automatic re-arms — stall recovery
/// usually runs with the phone pocketed, where a fresh `start()` would be
/// refused. `update()` and `end()` work from either state.
///
/// The app target's deployment floor (17.2) is above ActivityKit's (16.2), so
/// no availability checks are needed here.
@objc(LiveActivityBridge)
class LiveActivityBridge: NSObject {
  @objc static func requiresMainQueueSetup() -> Bool { false }

  /// The one activity we run.
  private var activity: Activity<ClipsoActivityAttributes>?

  /// ActivityKit budgets update frequency, and a rejected update is silently
  /// dropped. The buffer ticks every segment, so unchanged or too-frequent
  /// states are filtered here rather than spending the budget on them.
  private var lastPushedAt: TimeInterval = 0
  private var lastClipCount: Int?
  private var lastRecording: Bool?
  private static let minUpdateInterval: TimeInterval = 2.0

  private static func log(_ message: String) {
    NSLog("[LiveActivity] %@", message)
    DiagnosticLog.write("[LiveActivity] \(message)")
  }

  /// Ends every Clipso Live Activity that no bridge instance owns.
  ///
  /// An activity outlives the process that started it, so after a crash, a
  /// force-quit or a background memory kill the old "LIVE" banner stays on the
  /// Lock Screen with nothing capturing behind it, and the next arm would
  /// stack a second one beside it. AppDelegate calls this at launch, before JS
  /// can arm. `start()` calls it too, which covers a JS reload: the new bridge
  /// instance does not know the old instance's activity.
  static func endOrphanedActivities() {
    for orphan in Activity<ClipsoActivityAttributes>.activities {
      Self.log("ending orphaned activity \(orphan.id)")
      Task { await orphan.end(nil, dismissalPolicy: .immediate) }
    }
  }

  @objc func start(
    _ deviceName: String,
    resolve: @escaping RCTPromiseResolveBlock,
    reject: @escaping RCTPromiseRejectBlock
  ) {
    guard ActivityAuthorizationInfo().areActivitiesEnabled else {
      Self.log("not started — Live Activities are disabled for Clipso in Settings")
      resolve(false)
      return
    }
    // Re-arming must not stack activities: reuse whatever is already running.
    if activity != nil {
      resolve(true)
      return
    }
    // Nothing is owned here, so anything ActivityKit still lists is left over.
    Self.endOrphanedActivities()
    let initial = ClipsoActivityAttributes.ContentState(
      bufferedSeconds: 0,
      clipCount: 0,
      recording: false,
      recordingSince: nil
    )
    do {
      activity = try Activity.request(
        attributes: ClipsoActivityAttributes(deviceName: deviceName),
        content: .init(state: initial, staleDate: nil)
      )
      lastPushedAt = 0
      lastClipCount = nil
      lastRecording = nil
      Self.log("started for \(deviceName)")
      resolve(true)
    } catch {
      // Most common cause is starting while backgrounded, which ActivityKit
      // refuses. Never fatal — the app works without the activity.
      Self.log("start FAILED — \(error)")
      resolve(false)
    }
  }

  @objc func update(
    _ bufferedSeconds: NSNumber,
    clipCount: NSNumber,
    recording: NSNumber,
    recordingSince: NSNumber,
    resolve: @escaping RCTPromiseResolveBlock,
    reject: @escaping RCTPromiseRejectBlock
  ) {
    guard let activity else {
      resolve(false)
      return
    }
    let clips = clipCount.intValue
    let isRecording = recording.boolValue
    // JS sends epoch milliseconds, 0 meaning "not recording".
    let since: Date? = recordingSince.doubleValue > 0
      ? Date(timeIntervalSince1970: recordingSince.doubleValue / 1000.0)
      : nil

    // A change in clip count or recording state is what the wearer is actually
    // waiting to see, so it bypasses the rate limit. A buffer tick does not.
    // The first update after start() always counts (nil differs from any value).
    let structural = lastClipCount != clips || lastRecording != isRecording
    let now = Date().timeIntervalSince1970
    if !structural, now - lastPushedAt < Self.minUpdateInterval {
      resolve(false)
      return
    }
    lastPushedAt = now
    lastClipCount = clips
    lastRecording = isRecording

    let content = ClipsoActivityAttributes.ContentState(
      bufferedSeconds: bufferedSeconds.intValue,
      clipCount: clips,
      recording: isRecording,
      recordingSince: since
    )
    Task {
      await activity.update(.init(state: content, staleDate: nil))
    }
    resolve(true)
  }

  @objc func end(
    _ resolve: @escaping RCTPromiseResolveBlock,
    reject: @escaping RCTPromiseRejectBlock
  ) {
    guard let activity else {
      resolve(false)
      return
    }
    self.activity = nil
    lastClipCount = nil
    lastRecording = nil
    Self.log("ending")
    Task {
      // `.immediate` so disarming clears the Lock Screen right away; leaving a
      // stale "LIVE" banner up after capture stopped would be a lie.
      await activity.end(nil, dismissalPolicy: .immediate)
    }
    resolve(true)
  }
}
