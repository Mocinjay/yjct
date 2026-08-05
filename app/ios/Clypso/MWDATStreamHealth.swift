import Foundation

/// What the glasses feed is actually delivering, once a second.
///
/// The stream's own state machine can sit in `.streaming` over a link that has
/// stopped delivering, so frame arrival is the only signal that says whether
/// the feed is alive. Without this a stalled link is indistinguishable from a
/// quiet scene: the UI keeps claiming LIVE over a frozen picture.
///
/// Split out of `MWDATBridge` because it is a self-contained watchdog — a
/// timer, two counters and an edge detector — and because its correctness
/// depends on which thread touches which field, which is far easier to see when
/// the fields are not mixed in with forty others.
final class MWDATStreamHealth {
  /// Seconds without a frame before the feed is called stalled.
  private static let stallSeconds: TimeInterval = 10

  struct Sample {
    let fps: Double
    let secondsSinceFrame: Double
  }

  enum Transition {
    case stalled(secondsSinceFrame: Double)
    case recovered
  }

  private let queue = DispatchQueue(label: "com.mocinjay.clypso.mwdat.health")
  private var timer: DispatchSourceTimer?

  /// Incremented on the SDK's frame thread; only ever read on `queue`.
  private var frameCount = 0
  private var lastFrameAt: TimeInterval = 0

  /// `frameCount` as of the previous tick. Sampling the running total rather
  /// than resetting a per-tick counter keeps every mutation of the watchdog's
  /// own state on `queue`; the frame thread only increments and stamps.
  private var frameCountAtLastTick = 0
  private var lastTickAt: TimeInterval = 0
  private var stallReported = false

  private let onSample: (Sample) -> Void
  private let onTransition: (Transition) -> Void
  /// Suppresses a stall report during a deliberate teardown.
  private let isStopping: () -> Bool

  init(
    onSample: @escaping (Sample) -> Void,
    onTransition: @escaping (Transition) -> Void,
    isStopping: @escaping () -> Bool
  ) {
    self.onSample = onSample
    self.onTransition = onTransition
    self.isStopping = isStopping
  }

  /// Called on the SDK's frame thread, once per delivered frame.
  func recordFrame() {
    frameCount += 1
    lastFrameAt = Date().timeIntervalSince1970
  }

  var framesDelivered: Int { frameCount }

  func start() {
    guard timer == nil else { return }
    let now = Date().timeIntervalSince1970
    lastFrameAt = now
    lastTickAt = now
    frameCountAtLastTick = frameCount
    stallReported = false

    let source = DispatchSource.makeTimerSource(queue: queue)
    source.schedule(deadline: .now() + 1, repeating: 1)
    source.setEventHandler { [weak self] in self?.tick() }
    source.resume()
    timer = source
  }

  /// The timer held a strong reference to the bridge for the life of the
  /// process because nothing ever cancelled it — the same shape as the memory
  /// sampler removed in the cleanup pass. Teardown must call this.
  func stop() {
    timer?.cancel()
    timer = nil
    stallReported = false
  }

  func reset() {
    frameCount = 0
    frameCountAtLastTick = 0
    stallReported = false
  }

  /// Queue-only.
  private func tick() {
    let now = Date().timeIntervalSince1970
    let elapsed = max(0.001, now - lastTickAt)
    let delivered = frameCount - frameCountAtLastTick
    let fps = Double(max(0, delivered)) / elapsed
    frameCountAtLastTick = frameCount
    lastTickAt = now

    let sinceFrame = now - lastFrameAt
    onSample(
      Sample(
        fps: (fps * 10).rounded() / 10,
        secondsSinceFrame: (sinceFrame * 10).rounded() / 10
      )
    )

    guard sinceFrame > Self.stallSeconds else {
      if stallReported {
        stallReported = false
        onTransition(.recovered)
      }
      return
    }
    // Fire once per stall, not once per second: the UI shows one banner and the
    // wearer is not buried under a repeating error.
    guard !stallReported, !isStopping() else { return }
    stallReported = true
    onTransition(.stalled(secondsSinceFrame: sinceFrame))
  }
}
