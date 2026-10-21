import CoreImage
import CoreMedia
import Foundation
import MWDATCamera
import UIKit
import VideoToolbox

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
/// Path A records compressed HEVC (`.hvc1`) by muxing `CMSampleBuffer`s
/// straight into the segment writer. Those samples carry a `dataBuffer` and
/// **no** `imageBuffer`, so the preview cannot read pixels without decoding.
/// Decoding lives here only — the writer never sees a decompressed frame —
/// via `VTDecompressionSession`. Raw / already-decoded frames still take the
/// cheap CoreImage path.
///
/// Emits through a callback rather than calling `sendEvent` itself, so it has
/// no dependency on React Native and the throttling can be reasoned about
/// without one.
final class MWDATPreviewEncoder {
  /// Longest edge of a preview frame, in pixels. The feed is a ~1/3-screen
  /// viewfinder, so the glasses' native resolution is far more detail than is
  /// ever displayed — and every extra pixel is paid for three times: CoreImage
  /// render, JPEG encode, and a base64 string across the bridge. Halving the
  /// edge quarters all three, which is what buys the higher frame rate.
  private static let maxEdge: CGFloat = 448

  /// ~8 fps. Kept below the clip encode/mux rate so CoreImage/JPEG (and the
  /// occasional VT decode) do not starve the segment writer.
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
  /// Off until a view asks for frames.
  private var enabled = false

  private var emitCount = 0
  private var failureLogged = false
  private var decodePathLogged = false

  /// Held across frames that share a format description. Recreated when the
  /// SDK's ABR ladder changes resolution mid-session.
  private var decompressionSession: VTDecompressionSession?
  private var decompressionFormat: CMFormatDescription?

  /// Called on the encoder's own queue with a base64 JPEG.
  private let onFrame: (String) -> Void
  private let log: (String) -> Void

  init(onFrame: @escaping (String) -> Void, log: @escaping (String) -> Void) {
    self.onFrame = onFrame
    self.log = log
  }

  deinit {
    tearDownDecompression()
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
    decodePathLogged = false
    lastEmitAt = 0
    lock.unlock()
    queue.async { [weak self] in
      self?.tearDownDecompression()
    }
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
    let sample = frame.sampleBuffer
    let pixelBuffer: CVPixelBuffer?
    var usedDecoder = false

    if let imageBuffer = CMSampleBufferGetImageBuffer(sample) {
      pixelBuffer = imageBuffer
    } else if let decoded = decodeCompressed(sample) {
      pixelBuffer = decoded
      usedDecoder = true
    } else {
      // Last resort: SDK helper. Documented to return nil for `.hvc1` frames,
      // but kept so a future SDK that fills imageBuffer again still works.
      pixelBuffer = nil
      if let image = frame.makeUIImage(),
         let jpeg = image.jpegData(compressionQuality: Self.quality)
      {
        emit(jpeg: jpeg)
        return
      }
    }

    guard let pixelBuffer else {
      lock.lock()
      let alreadyLogged = failureLogged
      failureLogged = true
      lock.unlock()
      if !alreadyLogged {
        log(
          "preview conversion FAILED — no imageBuffer, VT decode nil, makeUIImage nil"
        )
      }
      return
    }

    if usedDecoder {
      lock.lock()
      let first = !decodePathLogged
      decodePathLogged = true
      lock.unlock()
      if first {
        log("preview path: VTDecompressionSession (compressed HEVC → JPEG)")
      }
    }

    var image = CIImage(cvPixelBuffer: pixelBuffer)
    let longestEdge = max(image.extent.width, image.extent.height)
    let scale = longestEdge > 0 ? min(1, Self.maxEdge / longestEdge) : 1
    if scale < 1 {
      image = image.transformed(by: CGAffineTransform(scaleX: scale, y: scale))
    }
    guard
      let jpeg = Self.ciContext.jpegRepresentation(
        of: image,
        colorSpace: CGColorSpaceCreateDeviceRGB(),
        options: [
          kCGImageDestinationLossyCompressionQuality as CIImageRepresentationOption:
            Self.quality,
        ]
      )
    else {
      lock.lock()
      let alreadyLogged = failureLogged
      failureLogged = true
      lock.unlock()
      if !alreadyLogged {
        log("preview JPEG encode FAILED after successful pixel buffer")
      }
      return
    }

    emit(jpeg: jpeg)
  }

  private func emit(jpeg: Data) {
    lock.lock()
    emitCount += 1
    let count = emitCount
    lock.unlock()

    if count == 1 || count % 50 == 0 {
      log("preview emit #\(count) — \(jpeg.count) bytes JPEG")
    }
    onFrame(jpeg.base64EncodedString())
  }

  // MARK: - HEVC decode (preview only)

  private func decodeCompressed(_ sample: CMSampleBuffer) -> CVPixelBuffer? {
    guard let format = CMSampleBufferGetFormatDescription(sample) else { return nil }
    guard let session = ensureDecompressionSession(for: format) else { return nil }

    var output: CVPixelBuffer?
    var infoFlags = VTDecodeInfoFlags()
    // Synchronous decode: the output handler runs before this call returns, so
    // `output` is populated without racing the preview queue.
    let status = VTDecompressionSessionDecodeFrame(
      session,
      sampleBuffer: sample,
      flags: [],
      infoFlagsOut: &infoFlags
    ) { status, _, imageBuffer, _, _ in
      if status == noErr {
        output = imageBuffer
      }
    }

    if status != noErr {
      lock.lock()
      let alreadyLogged = failureLogged
      failureLogged = true
      lock.unlock()
      if !alreadyLogged {
        log("VTDecompressionSessionDecodeFrame failed status=\(status)")
      }
      return nil
    }

    return output
  }

  private func ensureDecompressionSession(
    for format: CMFormatDescription
  ) -> VTDecompressionSession? {
    if let session = decompressionSession,
       let existing = decompressionFormat,
       CMFormatDescriptionEqual(existing, otherFormatDescription: format)
    {
      return session
    }
    tearDownDecompression()

    let attrs: [CFString: Any] = [
      kCVPixelBufferPixelFormatTypeKey: kCVPixelFormatType_420YpCbCr8BiPlanarVideoRange,
      kCVPixelBufferIOSurfacePropertiesKey: [:] as CFDictionary,
    ]
    var session: VTDecompressionSession?
    let status = VTDecompressionSessionCreate(
      allocator: kCFAllocatorDefault,
      formatDescription: format,
      decoderSpecification: nil,
      imageBufferAttributes: attrs as CFDictionary,
      decompressionSessionOut: &session
    )
    guard status == noErr, let session else {
      log("VTDecompressionSessionCreate failed status=\(status)")
      return nil
    }
    decompressionSession = session
    decompressionFormat = format
    let subType = CMFormatDescriptionGetMediaSubType(format)
    let dims = CMVideoFormatDescriptionGetDimensions(format)
    log(
      "preview decoder ready subtype='\(Self.fourCC(subType))' "
        + "\(dims.width)x\(dims.height)"
    )
    return session
  }

  private func tearDownDecompression() {
    if let session = decompressionSession {
      VTDecompressionSessionInvalidate(session)
    }
    decompressionSession = nil
    decompressionFormat = nil
  }

  private static func fourCC(_ value: FourCharCode) -> String {
    String(
      bytes: [
        UInt8((value >> 24) & 0xFF), UInt8((value >> 16) & 0xFF),
        UInt8((value >> 8) & 0xFF), UInt8(value & 0xFF),
      ],
      encoding: .ascii
    ) ?? "????"
  }
}
