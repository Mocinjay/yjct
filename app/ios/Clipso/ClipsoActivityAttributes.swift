import Foundation

#if canImport(ActivityKit)
import ActivityKit

/// The contract between the app and the ClipsoWidgets extension.
///
/// This file is compiled into BOTH targets — the app starts and updates the
/// activity, the widget extension renders it — and ActivityKit matches the two
/// sides by type name. Any change here has to land in both, which is exactly
/// why it is one shared file rather than two declarations.
@available(iOS 16.2, *)
struct ClipsoActivityAttributes: ActivityAttributes {
  /// Everything that changes while the wearer is out clipping. Kept small on
  /// purpose: every update crosses to the system process, and ActivityKit
  /// budgets how often that may happen.
  public struct ContentState: Codable, Hashable {
    /// Seconds currently held in the rolling look-back buffer.
    public var bufferedSeconds: Int

    /// Clips saved since this armed session started — the same number the
    /// in-app toast shows as "Save #3".
    public var clipCount: Int

    /// True while an extended recording is running (as opposed to armed and
    /// merely buffering).
    public var recording: Bool

    /// When the extended recording began, so the Lock Screen can run its own
    /// timer instead of us pushing an update every second.
    public var recordingSince: Date?

    public init(
      bufferedSeconds: Int,
      clipCount: Int,
      recording: Bool,
      recordingSince: Date?
    ) {
      self.bufferedSeconds = bufferedSeconds
      self.clipCount = clipCount
      self.recording = recording
      self.recordingSince = recordingSince
    }
  }

  /// Shown so the wearer can tell which glasses are feeding the buffer.
  public var deviceName: String

  public init(deviceName: String) {
    self.deviceName = deviceName
  }
}
#endif
