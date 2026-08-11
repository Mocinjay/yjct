import Foundation

/// A rolling record of what the live stream was doing, second by second.
///
/// TEMPORARY INSTRUMENT. This exists to settle one question: can the glasses
/// serve a third-party MWDAT stream *and* record natively to their own storage
/// at the same time? Everything in Clypso's proxy-to-master story depends on
/// the answer, and nothing in the SDK answers it — MWDAT is never told that the
/// wearer pressed capture, so there is no event to listen for.
///
/// So the question is answered backwards. The native recording turns up in the
/// photo library hours later carrying its own capture timestamp, and the only
/// thing that can say what the link was doing during that window is a record
/// kept at the time. That is this.
///
/// Deliberately not persisted. It answers a question asked inside one session —
/// stream, record natively, force a sync — and an on-disk ring of link
/// telemetry is a thing to maintain forever in exchange for a question that
/// gets asked once. The diagnostics file already carries the same events as
/// text for the case where the app was restarted in between.
final class MWDATStreamTimeline {
  /// ~34 minutes at one sample a second. Long enough to cover a field run,
  /// small enough that the ring is not worth thinking about (each entry is a
  /// double, a short string and a double).
  private static let capacity = 2048

  struct Entry {
    let atMs: Double
    /// `fps` | `state` | `error` | `stalled` | `recovered`
    let kind: String
    let detail: String
    /// Frames per second observed over the preceding tick. Negative where the
    /// entry is an event rather than a sample — absent is not zero, and a
    /// reader that cannot tell them apart would score every state change as a
    /// dead link.
    let fps: Double

    var payload: [String: Any] {
      ["atMs": atMs, "kind": kind, "detail": detail, "fps": fps]
    }
  }

  private let queue = DispatchQueue(label: "com.mocinjay.clypso.mwdat.timeline")
  private var entries: [Entry] = []

  func record(kind: String, detail: String, fps: Double = -1) {
    let atMs = Date().timeIntervalSince1970 * 1000
    queue.async {
      self.entries.append(Entry(atMs: atMs, kind: kind, detail: detail, fps: fps))
      if self.entries.count > Self.capacity {
        self.entries.removeFirst(self.entries.count - Self.capacity)
      }
    }
  }

  /// Oldest first, which is the order the window scorer on the JS side expects.
  func snapshot() -> [[String: Any]] {
    queue.sync { entries.map(\.payload) }
  }

  func clear() {
    queue.async { self.entries.removeAll() }
  }
}
