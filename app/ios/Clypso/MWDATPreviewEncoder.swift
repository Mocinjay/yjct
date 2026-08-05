import CoreImage
import CoreMedia
import Foundation
import MWDATCamera
import UIKit

/// Turns glasses video frames into the throttled JPEG stream the viewfinder
/// renders.
///
/// Split out of `MWDATBridge` because none of it is about the bridge: it is a
/// frame pipeline with its own queue, its own backpressure and its own
/// throttle, and every one of those had already been the cause of a production
/// bug — a per-frame `CIContext` that got the app memory-killed, an unbounded
/// serial queue that ran the preview further and further behind the wearer, and
/// encoding that never stopped when nothing was on screen.
///
/// Emits through a callback rather than calling `sendEvent` itself, so it has
/// no dependency on React Native and the throttling can be reasoned about
/// without one.
final class MWDATPreviewEncoder {
  /// Longest edge of a preview frame, in pixels. The feed is a ~1/3-screen
  /// viewfinder, so the glasses' native 504×896 is far more detail than is ever
  /// displayed — and every extra pixel is paid for three times: CoreImage
  /// render, JPEG encode, and a base64 string across the bridge. Halving the
  /// edge quarters all three, which is what buys the higher frame rate.
  private static let maxEdge: CGFloat = 448

  /// ~8 fps. Kept below the clip encode rate so CoreImage/JPEG work does not
  /// starve the segment writer, which is what makes recorded clips look laggy.
  private static let minInterval: TimeInterval = 0.12

  private static let quality = 0.4

  /// Creating a CIContext allocates a GPU context and is documented as
  /// expensive; it must be made once and reused. Building one per frame (~7/s)
  /// churned enough memory for the OS to terminate the app with
  /// "Terminated due to memory issue".
  private static let ciContext = CIContext(options: [.useSoftwareRenderer: false])

  private let queue = DispatchQueue(label: "com.mocinjay.clypso.mwdat.preview")

  /// Backpressure. `queue` is serial, so an encode that runs longer than the
  /// emit interval used to build a backlog of frames that were already stale by
  /// the time they crossed the bridge. Never keep more than one frame in
  /// flight; drop the rest. Guarded by a lock because the flag is set on the
  /// SDK's frame thread and cleared on `queue`.
  private let lock = NSLock()
  private var inFlight = false
  private var lastEmitAt: TimeInterval = 0

  /// Encoding is skipped entirely while nothing is displaying the feed.
  /// `startObserving`/`stopObserving` cannot express this: they fire for the
  /// emitter as a whole, and segment/error listeners are always attached, so
  /// preview kept encoding and crossing the bridge on every screen — including
  /// while a clip was playing, which starved the JS thread and froze the UI.
  ///
  /// Off until a view asks for frames. Defaulting to on meant every frame was
  /// converted, encoded and sent from app launch until something mounted, which
  /// RN reports as "Sending `MWDATPreviewFrame` with no listeners registered".
  private var enabled = false

  private var emitCount = 0
  private var failureLogged = false

  /// Called on the encoder's own queue with a base64 JPEG.
  private let onFrame: (String) -> Void
  private let log: (String) -> Void

  init(onFrame: @escaping (String) -> Void, log: @escaping (String) -> Void) {
    self.onFrame = onFrame
    self.log = log
  }

  var isEnabled: Bool {
    lock.lock()
    defer { lock.unlock() }
    return enabled
  }

  func setEnabled(_ value: Bool) {
    lock.lock()
    enabled = value
    lock.unlock()
  }

  /// Counters only — the enabled flag survives, because whether a view wants
  /// frames is independent of whether the stream restarted.
  func resetCounters() {
    lock.lock()
    emitCount = 0
    failureLogged = false
    lastEmitAt = 0
    lock.unlock()
  }

  var framesEmitted: Int {
    lock.lock()
    defer { lock.unlock() }
    return emitCount
  }

  /// Called on the SDK's frame thread. Returns immediately; the encode happens
  /// on `queue`, and frames arriving while one is in flight are dropped.
  func submit(_ frame: VideoFrame) {
    let now = Date().timeIntervalSince1970

    lock.lock()
    let shouldEncode =
      enabled && !inFlight && now - lastEmitAt > Self.minInterval
    if shouldEncode {
      inFlight = true
      lastEmitAt = now
    }
    lock.unlock()

    guard shouldEncode else { return }

    queue.async { [weak self] in
      guard let self else { return }
      defer {
        self.lock.lock()
        self.inFlight = false
        self.lock.unlock()
      }
      self.encode(frame)
    }
  }

  /// Queue-only.
  private func encode(_ frame: VideoFrame) {
    // Raw YCbCr frames (what `.raw` delivers, and what the writer needs) come
    // through as CVPixelBuffers, so scale and encode them on the GPU in one
    // pass — `jpegRepresentation` skips the CGImage → UIImage → jpegData round
    // trip that allocated a full-size bitmap per frame. `makeUIImage()` is the
    // fallback for compressed/HVC1 frames, which it does decode.
    let jpeg: Data?
    if let pixelBuffer = CMSampleBufferGetImageBuffer(frame.sampleBuffer) {
      var image = CIImage(cvPixelBuffer: pixelBuffer)
      let longestEdge = max(image.extent.width, image.extent.height)
      let scale = longestEdge > 0 ? min(1, Self.maxEdge / longestEdge) : 1
      if scale < 1 {
        image = image.transformed(by: CGAffineTransform(scaleX: scale, y: scale))
      }
      jpeg = Self.ciContext.jpegRepresentation(
        of: image,
        colorSpace: CGColorSpaceCreateDeviceRGB(),
        options: [
          kCGImageDestinationLossyCompressionQuality as CIImageRepresentationOption:
            Self.quality,
        ]
      )
    } else {
      jpeg = frame.makeUIImage()?.jpegData(compressionQuality: Self.quality)
    }

    guard let jpeg else {
      lock.lock()
      let alreadyLogged = failureLogged
      failureLogged = true
      lock.unlock()
      if !alreadyLogged {
        log(
          "preview conversion FAILED (makeUIImage and CoreImage both nil) — frames arrive but cannot render"
        )
      }
      return
    }

    lock.lock()
    emitCount += 1
    let count = emitCount
    lock.unlock()

    if count == 1 || count % 50 == 0 {
      log("preview emit #\(count) — \(jpeg.count) bytes JPEG")
    }
    onFrame(jpeg.base64EncodedString())
  }
}
