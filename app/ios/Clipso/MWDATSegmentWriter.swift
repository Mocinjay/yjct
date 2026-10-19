import AVFoundation
import AudioToolbox
import CoreMedia
import Foundation

/// Appends diagnostics to a file inside the app container, so a capture run can
/// be pulled off the device afterwards with
/// `devicectl device copy from --domain-type appDataContainer`.
///
/// The live console (`devicectl device process launch --console`) reliably drops
/// its connection partway through a long capture run, which loses exactly the
/// tail that matters — the segment rotation and its writer error.
enum DiagnosticLog {
  private static let queue = DispatchQueue(label: "com.mocinjay.clipso.diaglog")
  private static let url: URL? = FileManager.default
    .urls(for: .documentDirectory, in: .userDomainMask).first?
    .appendingPathComponent("clipso-diagnostics.log")

  /// Truncate at the start of a capture run so each run reads cleanly.
  static func reset() {
    guard let url else { return }
    queue.async { try? Data().write(to: url) }
  }

  static func write(_ message: String) {
    guard let url else { return }
    let stamp = ISO8601DateFormatter().string(from: Date())
    let line = "\(stamp) \(message)\n"
    queue.async {
      guard let data = line.data(using: .utf8) else { return }
      if let handle = try? FileHandle(forWritingTo: url) {
        defer { try? handle.close() }
        _ = try? handle.seekToEnd()
        try? handle.write(contentsOf: data)
      } else {
        try? data.write(to: url)
      }
    }
  }
}

/// Writes the MWDAT glasses stream as back-to-back MP4 segments of roughly
/// `segmentSeconds` each — the same rolling-segment contract MockDeviceSource
/// fulfils with the phone camera.
///
/// The stream is requested as `.hvc1`, so frames arrive as the glasses' own
/// HEVC encode and are written untouched (passthrough), the way Meta's
/// CameraAccess sample records. The phone never decodes or re-encodes them,
/// which removes a whole generation of quality loss and the realtime encoder
/// that used to drop frames whenever captioning or transcription held the
/// hardware. Decoded pixel buffers, if a stream ever delivers them, still go
/// through an H.264 encoder.
///
/// A compressed segment can only begin on a keyframe, so rotation waits for
/// the first keyframe after the segment's time is up: segments run a little
/// over `segmentSeconds` and abut exactly, with no frame lost between them.
///
/// Audio is captured phone-side with AVAudioEngine on the host clock. Video
/// keeps the glasses' own frame spacing and is shifted onto that same clock
/// (see `mapped(_:offset:arrival:)`), so one AVAssetWriter timeline holds both.
final class MWDATSegmentWriter {
  struct FinishedSegment {
    let path: String
    let startedAtMs: Double
    let durationSec: Double
  }

  private let queue = DispatchQueue(label: "com.mocinjay.clipso.mwdat.writer")
  private let segmentSeconds: Double
  private let onSegment: (FinishedSegment) -> Void
  private let onError: (String) -> Void

  private let audioEngine = AVAudioEngine()
  private var audioRunning = false
  private var hasReceivedAudioSample = false
  /// Set when a segment carrying an audio track fails to finish. Video is the
  /// point of the feature, so subsequent segments drop audio rather than keep
  /// losing whole clips to the encoder.
  private var audioEncodingDisabled = false
  private var audioStartAttempts = 0
  private var loggedFirstAudioSample = false
  private var audioConversionFailures = 0

  /// Audio start is retried once per segment rotation. Six attempts covers the
  /// ~30s a wearer needs to answer the microphone permission prompt without
  /// retrying forever on a device that will never grant it.
  private static let maxAudioStartAttempts = 6

  private var running = true
  private var current: Segment?
  private var rotateTimer: DispatchSourceTimer?

  /// Set when a passthrough segment's time is up. It ends on the next keyframe,
  /// because that keyframe is the only frame the next segment can start with.
  private var rotateDue = false
  private var loggedLongSegment = false
  /// `cut()` callers waiting for a passthrough segment to end on a keyframe.
  private var pendingCuts: [() -> Void] = []
  private var cutDeadline: DispatchSourceTimer?
  /// Frames thrown away because no segment was open and they were not
  /// keyframes. Only nonzero after a stream (re)start or a forced cut.
  private var droppedAwaitingKeyframe = 0

  /// Lowest arrival-minus-capture delay seen since the current segment opened.
  /// The next segment shifts glasses time onto the host clock by this amount.
  private var recentMinDelay: CMTime?
  private var loggedTimingSource = false
  /// The previous frame's capture time and arrival. A link stall delays
  /// arrival while capture times stay continuous; only the glasses' clock
  /// itself jumping moves capture time out of step with the wall clock.
  private var lastSourceTime: CMTime?
  private var lastSourceArrival: CMTime?

  /// Segments opened by this writer. The first one is primed (see
  /// `primingFrames`) because nothing has been measured yet.
  private var segmentsOpened = 0
  /// Frames held while the first segment's clock offset is measured.
  private var priming: [(sample: CMSampleBuffer, arrival: CMTime, keyframe: Bool)] = []

  /// Mic buffers waiting for the video they belong under. Audio is assigned to
  /// a segment by timestamp, not by when it happens to be processed: video
  /// arrives late by the link's delay, so appending audio as it came would put
  /// the first moments of every segment's sound at the end of the previous one.
  private var pendingAudio: [(sample: CMSampleBuffer, pts: CMTime, peak: Float)] = []
  private var pendingAudioDrops = 0


  /// How long a cut waits for the next keyframe before ending the segment
  /// anyway. Waiting keeps the rolling buffer gap-free; the cap keeps a cut
  /// from hanging on a stream whose keyframes have stopped.
  private static let cutKeyframeWaitSeconds = 2.0
  /// A jump in the glasses' clock larger than this is a restart, not jitter.
  private static let clockResyncSeconds = 1.0
  /// The first segment of a writer opens only after this many frames, or
  /// `primingSeconds` of them, have been seen. Its offset onto the host clock
  /// is the lowest delay among them; taken from the opening keyframe alone —
  /// the largest frame, and the first after a link start — it would leave the
  /// whole segment's video late against its audio.
  private static let primingFrames = 15
  private static let primingSeconds = 0.6
  /// Mic audio older than this with no video to go under is dropped. Longer
  /// than a stalled segment can stay open — the bridge's 10s stall watchdog,
  /// a recovery backoff of up to 6s, a JS re-arm — so the sound right after a
  /// freeze is still queued when the segment is finally finished.
  private static let maxPendingAudioSeconds = 30.0
  /// How much sound past its last frame a segment finished on its way into a
  /// teardown keeps. What follows went unseen, and a long tail would only be a
  /// frozen picture filling the look-back window.
  private static let finishTailSeconds = 2.0
  /// Duration given to a passthrough frame the SDK did not stamp with one.
  /// Only the last frame of a segment relies on it; the rest are spaced by
  /// their timestamps.
  private static let fallbackFrameDuration = CMTime(value: 1, timescale: 30)

  private final class Segment {
    let writer: AVAssetWriter
    let videoInput: AVAssetWriterInput
    /// nil when the segment was opened with no live audio source — an
    /// AVAssetWriter input that never receives a sample yields an empty track,
    /// which finishWriting can reject.
    let audioInput: AVAssetWriterInput?
    let path: String
    let startedAtMs: Double
    let firstPTS: CMTime
    var lastPTS: CMTime
    /// True when the glasses' compressed frames are written as-is.
    let passthrough: Bool
    /// What the segment was opened with. A passthrough input is bound to its
    /// source format, so a format change (the SDK's quality ladder switching
    /// resolution) ends the segment at the keyframe that carries it.
    let formatDescription: CMFormatDescription?
    /// Host clock minus glasses clock, fixed for the life of the segment so
    /// the frame spacing inside it is exactly the glasses' own.
    var clockOffset: CMTime

    var videoSamples = 0
    var keyframes = 0
    var lastVideoDTS: CMTime = .invalid
    /// End of the last mic buffer written. A segment finished on its way into
    /// a teardown keeps the sound past its last frame, so its file — and the
    /// duration the stitcher trims from — runs to here, not to `lastPTS`.
    var audioEnd: CMTime = .invalid
    /// Set when a passthrough frame could not be written. Every frame up to
    /// the next keyframe references it, so they are skipped rather than
    /// written as a smear of undecodable pictures.
    var awaitingKeyframe = false
    var skippedToKeyframe = 0
    var audioSamples = 0
    var videoAppendFailures = 0
    var audioAppendFailures = 0
    var audioPreSessionDrops = 0
    /// Loudest mic sample in the segment. Distinguishes "no audio track" from
    /// "audio track full of digital silence", which look identical downstream
    /// but have completely different causes.
    var audioPeak: Float = 0
    var droppedNotReady = 0
    /// Last PTS actually handed to the video input, for the monotonicity guard.
    var lastVideoPTS: CMTime = .invalid
    /// Longest gap between two consecutive frames. A segment whose worst gap is
    /// far above the frame interval is a stalled link, not a slow encoder, and
    /// that difference is the whole diagnosis when a wearer reports a freeze.
    var longestGapSec: Double = 0

    init(
      writer: AVAssetWriter,
      videoInput: AVAssetWriterInput,
      audioInput: AVAssetWriterInput?,
      path: String,
      startedAtMs: Double,
      firstPTS: CMTime,
      passthrough: Bool,
      formatDescription: CMFormatDescription?,
      clockOffset: CMTime
    ) {
      self.writer = writer
      self.videoInput = videoInput
      self.audioInput = audioInput
      self.path = path
      self.startedAtMs = startedAtMs
      self.firstPTS = firstPTS
      self.lastPTS = firstPTS
      self.passthrough = passthrough
      self.formatDescription = formatDescription
      self.clockOffset = clockOffset
    }
  }

  // MARK: - Diagnostics

  /// NSLog rather than print: it reaches the unified logging system, so
  /// `log stream --device` picks it up without a console attached (the
  /// devicectl console drops the connection during long capture runs).
  private static func log(_ message: String) {
    NSLog("[MWDATWriter] %@", message)
    DiagnosticLog.write("[MWDATWriter] \(message)")
  }

  /// Full NSError anatomy. `localizedDescription` alone collapses every
  /// AVFoundation failure into a phrase like "Cannot Encode Media", which
  /// names neither the track nor the reason; the domain/code and the
  /// AVErrorMediaType/underlying-error userInfo keys are what identify it.
  static func describe(_ error: Error?) -> String {
    guard let error else { return "nil" }
    let ns = error as NSError
    var parts = ["domain=\(ns.domain)", "code=\(ns.code)", "desc=\"\(ns.localizedDescription)\""]
    if let reason = ns.localizedFailureReason { parts.append("reason=\"\(reason)\"") }
    if let recovery = ns.localizedRecoverySuggestion { parts.append("recovery=\"\(recovery)\"") }
    if let underlying = ns.userInfo[NSUnderlyingErrorKey] as? NSError {
      parts.append(
        "underlying=[domain=\(underlying.domain) code=\(underlying.code) "
          + "desc=\"\(underlying.localizedDescription)\"]"
      )
    }
    let rest = ns.userInfo.filter {
      $0.key != NSUnderlyingErrorKey && $0.key != NSLocalizedDescriptionKey
        && $0.key != NSLocalizedFailureReasonErrorKey
        && $0.key != NSLocalizedRecoverySuggestionErrorKey
    }
    if !rest.isEmpty { parts.append("userInfo=\(rest)") }
    return parts.joined(separator: " ")
  }

  private static func describeStatus(_ status: AVAssetWriter.Status) -> String {
    switch status {
    case .unknown: return "unknown"
    case .writing: return "writing"
    case .completed: return "completed"
    case .failed: return "failed"
    case .cancelled: return "cancelled"
    @unknown default: return "unhandled(\(status.rawValue))"
    }
  }

  /// A valid AAC bitrate for this input format.
  ///
  /// AAC's encodable bitrate range depends on sample rate and channel count,
  /// and AVAssetWriter does not clamp: ask for one outside the range and the
  /// whole segment fails at `finishWriting` with the opaque "Cannot Encode
  /// Media", taking the video track down with it. The glasses microphone
  /// arrives over Bluetooth HFP at 16 kHz mono, where AAC tops out at 48 kbps
  /// — so the previously hardcoded 96 kbps was simply unencodable. (The phone's
  /// own mic runs at 44.1/48 kHz, where 96 kbps is fine, which is why this only
  /// ever failed with the glasses connected.)
  ///
  /// Rather than hardcode another guess, ask the encoder what it accepts and
  /// clamp into range.
  static func aacBitRate(sampleRate: Double, channels: UInt32) -> Int {
    let preferred = 96_000.0
    // Scaled fallback if the encoder cannot be interrogated: stays inside the
    // valid range at both 16 kHz (32k) and 44.1/48 kHz (96k).
    let fallback = Int(min(preferred, max(32_000, sampleRate * 2)))

    var source = AudioStreamBasicDescription(
      mSampleRate: sampleRate, mFormatID: kAudioFormatLinearPCM,
      mFormatFlags: kAudioFormatFlagIsFloat | kAudioFormatFlagIsPacked,
      mBytesPerPacket: 4 * channels, mFramesPerPacket: 1, mBytesPerFrame: 4 * channels,
      mChannelsPerFrame: channels, mBitsPerChannel: 32, mReserved: 0
    )
    var destination = AudioStreamBasicDescription(
      mSampleRate: sampleRate, mFormatID: kAudioFormatMPEG4AAC, mFormatFlags: 0,
      mBytesPerPacket: 0, mFramesPerPacket: 1024, mBytesPerFrame: 0,
      mChannelsPerFrame: channels, mBitsPerChannel: 0, mReserved: 0
    )

    var converter: AudioConverterRef?
    guard AudioConverterNew(&source, &destination, &converter) == noErr,
          let converter
    else { return fallback }
    defer { AudioConverterDispose(converter) }

    var size: UInt32 = 0
    guard
      AudioConverterGetPropertyInfo(
        converter, kAudioConverterApplicableEncodeBitRates, &size, nil
      ) == noErr, size > 0
    else { return fallback }

    let count = Int(size) / MemoryLayout<AudioValueRange>.size
    var ranges = [AudioValueRange](
      repeating: AudioValueRange(mMinimum: 0, mMaximum: 0), count: count
    )
    guard
      AudioConverterGetProperty(
        converter, kAudioConverterApplicableEncodeBitRates, &size, &ranges
      ) == noErr
    else { return fallback }

    let valid = ranges.filter { $0.mMaximum > 0 }
    guard !valid.isEmpty else { return fallback }
    if valid.contains(where: { preferred >= $0.mMinimum && preferred <= $0.mMaximum }) {
      return Int(preferred)
    }
    let lowest = valid.map(\.mMinimum).min() ?? preferred
    let highest = valid.map(\.mMaximum).max() ?? preferred
    return Int(min(max(preferred, lowest), highest))
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

  init(
    segmentSeconds: Double,
    onSegment: @escaping (FinishedSegment) -> Void,
    onError: @escaping (String) -> Void
  ) {
    self.segmentSeconds = segmentSeconds
    self.onSegment = onSegment
    self.onError = onError
  }

  // MARK: - Audio

  /// Bring up the phone microphone. Best-effort and never throws: losing the
  /// mic must not tear down the glasses video stream. It is retried once per
  /// segment rotation, because a session that comes up deaf stays deaf for its
  /// whole life otherwise — and audio is the ONLY thing the wake word hears.
  func startAudio() {
    queue.async { [weak self] in
      guard let self, self.running, !self.audioRunning else { return }
      guard self.audioStartAttempts < Self.maxAudioStartAttempts else { return }
      self.audioStartAttempts += 1
      let attempt = self.audioStartAttempts

      // Ask for the microphone explicitly. Nothing in the app ever did, and
      // activating a recording session while the permission is still
      // undetermined fails outright ("Session activation failed") — which is
      // how every segment ended up video-only and the wake word went deaf.
      Self.requestRecordPermission { granted in
        guard granted else {
          Self.log(
            "audio attempt \(attempt): microphone permission NOT granted — "
              + "voice trigger cannot hear anything"
          )
          return
        }
        self.queue.async { self.startAudioEngine(attempt: attempt) }
      }
    }
  }

  /// A fresh audio budget for a writer still running deaf. The rotation retries
  /// spend theirs while the app is backgrounded, where iOS refuses to start a
  /// recording session; the bridge calls this on return to the foreground.
  func retryAudioIfNeeded() {
    queue.async { [weak self] in
      guard let self, self.running, !self.audioRunning else { return }
      self.audioStartAttempts = 0
      self.startAudio()
    }
  }

  private static func requestRecordPermission(_ completion: @escaping (Bool) -> Void) {
    if #available(iOS 17.0, *) {
      switch AVAudioApplication.shared.recordPermission {
      case .granted: completion(true)
      case .denied: completion(false)
      default: AVAudioApplication.requestRecordPermission(completionHandler: completion)
      }
    } else {
      let session = AVAudioSession.sharedInstance()
      switch session.recordPermission {
      case .granted: completion(true)
      case .denied: completion(false)
      default: session.requestRecordPermission(completion)
      }
    }
  }

  private func startAudioEngine(attempt: Int) {
    guard running, !audioRunning else { return }
    let session = AVAudioSession.sharedInstance()

    // The glasses' mic is a Bluetooth HFP device on the SAME link that carries
    // the camera stream. Selecting it renegotiates that link into narrowband
    // voice mode, which starves the video: measured on-device, frames stop
    // within ~5s of the audio engine starting, the segment after that captures
    // a fraction of a second, and capture dies. The HFP mic also delivered no
    // samples at all, so the trade was losing video to gain nothing.
    //
    // Record on the phone instead and leave the Bluetooth link to the camera.
    // `.allowBluetooth` is deliberately NOT set: with it, the route can fall
    // back onto HFP on its own and take the video stream down with it.
    do {
      try session.setCategory(
        .playAndRecord,
        mode: .default,
        options: [.mixWithOthers, .defaultToSpeaker]
      )
      try session.setActive(true)
    } catch {
      // Full anatomy, not localizedDescription: every AVAudioSession failure
      // collapses to "Session activation failed", which names no cause.
      Self.log("audio session activation FAILED (attempt \(attempt)) — \(Self.describe(error))")
      // `.playAndRecord` also claims the output; a session we cannot get is
      // usually one someone else holds. `.record` claims less and often wins.
      do {
        try session.setCategory(.record, mode: .default, options: [.mixWithOthers])
        try session.setActive(true)
        Self.log("audio session activated on the .record fallback")
      } catch {
        Self.log("audio session .record fallback FAILED too — \(Self.describe(error))")
        return
      }
    }

    if let builtInMic = session.availableInputs?.first(where: {
      $0.portType == .builtInMic
    }) {
      try? session.setPreferredInput(builtInMic)
    }

    let input = audioEngine.inputNode
    let format = input.outputFormat(forBus: 0)
    guard format.sampleRate > 0, format.channelCount > 0 else {
      Self.log(
        "audio attempt \(attempt): no usable microphone input "
          + "(\(format.sampleRate)Hz ch=\(format.channelCount))"
      )
      return
    }
    input.removeTap(onBus: 0)
    input.installTap(onBus: 0, bufferSize: 1024, format: format) { [weak self] buffer, time in
      self?.appendAudio(buffer, at: time)
    }
    do {
      try audioEngine.start()
    } catch {
      input.removeTap(onBus: 0)
      Self.log("audio engine start FAILED (attempt \(attempt)) — \(Self.describe(error))")
      return
    }
    audioRunning = true
    Self.log(
      "audio engine started (attempt \(attempt)): \(format.sampleRate)Hz ch=\(format.channelCount) "
        + "route=\(session.currentRoute.inputs.map { $0.portType.rawValue }.joined(separator: ","))"
    )
  }

  // MARK: - Appending (called from SDK / audio threads)

  func appendVideo(_ sample: CMSampleBuffer) {
    let arrival = CMClockGetTime(CMClockGetHostTimeClock())
    queue.async { [weak self] in
      self?.appendVideoOnQueue(sample, at: arrival)
    }
  }

  private func appendAudio(_ buffer: AVAudioPCMBuffer, at time: AVAudioTime) {
    let peak = Self.peakLevel(of: buffer)
    guard let sample = Self.makeAudioSampleBuffer(from: buffer, at: time) else {
      queue.async { [weak self] in
        guard let self else { return }
        self.audioConversionFailures += 1
        if self.audioConversionFailures == 1 {
          Self.log("mic buffer could not be converted to a CMSampleBuffer — audio is dropped")
        }
      }
      return
    }
    queue.async { [weak self] in
      guard let self, self.running else { return }
      self.hasReceivedAudioSample = true
      let pts = CMSampleBufferGetPresentationTimeStamp(sample)
      if !self.loggedFirstAudioSample {
        self.loggedFirstAudioSample = true
        Self.log("first mic sample: frames=\(buffer.frameLength) peak=\(peak) pts=\(pts.seconds)")
      }
      self.pendingAudio.append((sample, pts, peak))
      while let oldest = self.pendingAudio.first,
            CMTimeSubtract(pts, oldest.pts).seconds > Self.maxPendingAudioSeconds {
        self.pendingAudio.removeFirst()
        self.pendingAudioDrops += 1
        if self.pendingAudioDrops == 1 {
          Self.log("mic audio waited over \(Self.maxPendingAudioSeconds)s with no video to go under — dropping it")
        }
      }
      if let segment = self.current {
        self.drainAudio(into: segment, before: segment.lastPTS)
      }
    }
  }

  /// Writes the waiting mic buffers stamped before `limit` into `segment`.
  /// A momentarily busy input leaves the rest queued for the next drain.
  private func drainAudio(into segment: Segment, before limit: CMTime) {
    while let entry = pendingAudio.first, entry.pts < limit {
      if let audioInput = segment.audioInput, !audioInput.isReadyForMoreMediaData {
        return
      }
      pendingAudio.removeFirst()
      segment.audioPeak = max(segment.audioPeak, entry.peak)
      guard let audioInput = segment.audioInput else { continue }
      // Never write media that predates the writer session — AVAssetWriter drops the segment otherwise.
      guard entry.pts >= segment.firstPTS else {
        segment.audioPreSessionDrops += 1
        continue
      }
      if audioInput.append(entry.sample) {
        segment.audioSamples += 1
        let duration = CMSampleBufferGetDuration(entry.sample)
        segment.audioEnd = duration.isNumeric ? CMTimeAdd(entry.pts, duration) : entry.pts
      } else {
        segment.audioAppendFailures += 1
        if segment.audioAppendFailures == 1 {
          Self.log(
            "AUDIO append FAILED (first) at pts=\(entry.pts.seconds) "
              + "status=\(Self.describeStatus(segment.writer.status)) "
              + "error=\(Self.describe(segment.writer.error))"
          )
        }
      }
    }
  }

  private func appendVideoOnQueue(_ sample: CMSampleBuffer, at arrival: CMTime) {
    guard running else { return }

    let passthrough = CMSampleBufferGetImageBuffer(sample) == nil
    let keyframe = sample.isVideoKeyframe
    let observed = observeDelay(of: sample, arrival: arrival)

    // A passthrough segment can only end where the next one can begin: on a
    // keyframe. Its time being up, a cut, or a new stream format all wait here.
    if let segment = current, segment.passthrough, keyframe {
      var formatChanged = false
      if let opened = segment.formatDescription,
         let incoming = CMSampleBufferGetFormatDescription(sample) {
        formatChanged = !CMFormatDescriptionEqual(opened, otherFormatDescription: incoming)
      }
      if formatChanged {
        Self.log("stream format changed at a keyframe — ending the segment there")
      }
      if rotateDue || formatChanged || !pendingCuts.isEmpty {
        // Sound up to the instant the next segment starts belongs to this one.
        let nextStart = Self.mapped(sample, offset: nextSegmentOffset(observed.delay), arrival: arrival).pts
        drainAudio(into: segment, before: nextStart)
        rotate(completion: takePendingCuts())
      }
    }

    guard let segment = current else {
      openSegment(sample, arrival: arrival, keyframe: keyframe, passthrough: passthrough, delay: observed.delay)
      return
    }

    // Inside a segment the offset is fixed, so frames keep the glasses' own
    // spacing — a stall shows as the gap it was, with the late frames still
    // at their capture times. Only the glasses' clock itself jumping moves it.
    if observed.restarted, let delay = observed.delay {
      Self.log("glasses clock jumped — re-anchoring the segment")
      segment.clockOffset = delay
    }
    appendInSegment(sample, arrival: arrival, keyframe: keyframe, to: segment)
  }

  /// The offset the next segment opens with: the lowest delay seen over the
  /// current one, which is the link's real latency. Re-measured per segment,
  /// so drift between the glasses' clock and the phone's is followed.
  private func nextSegmentOffset(_ delay: CMTime?) -> CMTime {
    recentMinDelay ?? delay ?? .zero
  }

  /// Opens a segment at this frame, which must be able to start one. The
  /// first segment of a writer is primed first: frames are held until enough
  /// delays have been seen to place them on the host clock (`primingFrames`).
  private func openSegment(
    _ sample: CMSampleBuffer,
    arrival: CMTime,
    keyframe: Bool,
    passthrough: Bool,
    delay: CMTime?
  ) {
    if passthrough, segmentsOpened == 0 {
      guard keyframe || !priming.isEmpty else {
        droppedAwaitingKeyframe += 1
        return
      }
      // The quality ladder often settles in the first moments of a stream. A
      // new format starts over from its own keyframe, since one segment holds
      // one format.
      if keyframe, let first = priming.first,
         let opened = CMSampleBufferGetFormatDescription(first.sample),
         let incoming = CMSampleBufferGetFormatDescription(sample),
         !CMFormatDescriptionEqual(opened, otherFormatDescription: incoming) {
        droppedAwaitingKeyframe += priming.count
        priming = []
      }
      priming.append((sample, arrival, keyframe))
      let span = CMTimeSubtract(arrival, priming[0].arrival).seconds
      guard priming.count >= Self.primingFrames || span >= Self.primingSeconds else { return }
      let frames = priming
      priming = []
      guard let segment = beginSegment(
        with: frames[0].sample, arrival: frames[0].arrival, offset: nextSegmentOffset(delay)
      ) else { return }
      for frame in frames.dropFirst() {
        appendInSegment(frame.sample, arrival: frame.arrival, keyframe: frame.keyframe, to: segment)
      }
      return
    }

    guard keyframe else {
      droppedAwaitingKeyframe += 1
      return
    }
    let offset = nextSegmentOffset(delay)
    // A new measuring window for the segment after this one.
    recentMinDelay = delay
    _ = beginSegment(with: sample, arrival: arrival, offset: offset)
  }

  /// Creates the segment, writes its first frame and starts its clock.
  private func beginSegment(with sample: CMSampleBuffer, arrival: CMTime, offset: CMTime) -> Segment? {
    let passthrough = CMSampleBufferGetImageBuffer(sample) == nil
    let timing = Self.mapped(sample, offset: offset, arrival: arrival)
    guard let retimed = Self.retimed(
      sample, pts: timing.pts, dts: timing.dts, keyframe: true, passthrough: passthrough
    ) else {
      Self.log("retiming failed — dropping frame")
      return nil
    }
    let segment: Segment
    do {
      segment = try startSegment(
        firstSample: retimed, firstPTS: timing.pts, passthrough: passthrough, clockOffset: offset
      )
    } catch {
      running = false
      Self.log("could not start segment writer — \(Self.describe(error))")
      onError("Could not start segment writer: \(error.localizedDescription)")
      return nil
    }
    current = segment
    segmentsOpened += 1
    scheduleRotation()
    if droppedAwaitingKeyframe > 0 {
      Self.log("segment opened after dropping \(droppedAwaitingKeyframe) frames waiting for a keyframe")
      droppedAwaitingKeyframe = 0
    }
    append(retimed, to: segment, pts: timing.pts, dts: timing.dts, keyframe: true, original: sample)
    return segment
  }

  /// Places a frame on the segment's timeline and writes it.
  private func appendInSegment(
    _ sample: CMSampleBuffer,
    arrival: CMTime,
    keyframe: Bool,
    to segment: Segment
  ) {
    var timing = Self.mapped(sample, offset: segment.clockOffset, arrival: arrival)
    // Monotonic only. There used to be an upper clamp too — no more than ~2
    // frames past the previous PTS — and it rewrote every real gap as 66 ms, so
    // the file ran faster than real time, under-reported its duration and
    // drifted ahead of the (unclamped) audio. A real gap is a real freeze.
    if segment.lastVideoDTS.isValid {
      let floor = CMTimeAdd(segment.lastVideoDTS, CMTime(value: 1, timescale: 30_000))
      if timing.dts < floor { timing.dts = floor }
    }
    if timing.pts < timing.dts { timing.pts = timing.dts }
    if segment.lastVideoPTS.isValid {
      let gap = CMTimeSubtract(timing.pts, segment.lastVideoPTS).seconds
      if gap > segment.longestGapSec { segment.longestGapSec = gap }
    }

    if rotateDue, !loggedLongSegment,
       CMTimeSubtract(timing.pts, segment.firstPTS).seconds > segmentSeconds * 3 {
      loggedLongSegment = true
      Self.log(
        "no keyframe for \(Int(segmentSeconds * 2))s past the segment's end — "
          + "it keeps growing until one arrives"
      )
    }

    guard let retimed = Self.retimed(
      sample, pts: timing.pts, dts: timing.dts, keyframe: keyframe, passthrough: segment.passthrough
    ) else {
      Self.log("retiming failed — dropping frame")
      if segment.passthrough { segment.awaitingKeyframe = true }
      return
    }
    append(retimed, to: segment, pts: timing.pts, dts: timing.dts, keyframe: keyframe, original: sample)
  }

  /// Arrival minus capture time for one frame, folded into the running
  /// minimum. `delay` is nil when the SDK gave the frame no usable timestamp;
  /// `restarted` is true when the glasses' clock jumped.
  private func observeDelay(of sample: CMSampleBuffer, arrival: CMTime) -> (delay: CMTime?, restarted: Bool) {
    let source = CMSampleBufferGetPresentationTimeStamp(sample)
    guard source.isNumeric else {
      if !loggedTimingSource {
        loggedTimingSource = true
        Self.log("frames carry no capture timestamp — stamping arrival time instead")
      }
      return (nil, false)
    }
    let delay = CMTimeSubtract(arrival, source)
    if !loggedTimingSource {
      loggedTimingSource = true
      Self.log(
        String(
          format: "timing: glasses pts=%.3f arrival=%.3f — keeping the glasses' frame spacing",
          source.seconds, arrival.seconds
        )
      )
    }

    // Decode order is what arrives in order, so step on the decode time when
    // there is one; presentation time can step back across reordered frames.
    let decode = CMSampleBufferGetDecodeTimeStamp(sample)
    let stepTime = decode.isNumeric ? decode : source
    var restarted = false
    if let lastTime = lastSourceTime, let lastArrival = lastSourceArrival {
      let captureStep = CMTimeSubtract(stepTime, lastTime).seconds
      let arrivalStep = CMTimeSubtract(arrival, lastArrival).seconds
      // A stall: arrival jumps, capture does not. A restart: capture jumps
      // back, or forward by far more than the time that actually passed.
      restarted = captureStep < -Self.clockResyncSeconds / 2
        || captureStep - arrivalStep > Self.clockResyncSeconds
    }
    lastSourceTime = stepTime
    lastSourceArrival = arrival

    if restarted || recentMinDelay == nil {
      recentMinDelay = delay
    } else if let lowest = recentMinDelay, delay < lowest {
      recentMinDelay = delay
    }
    return (delay, restarted)
  }

  /// Where on the host clock a frame belongs.
  ///
  /// Each frame carries the glasses' capture time. Arrival time on the phone is
  /// that plus a transport delay that changes frame to frame, because the link
  /// delivers in bursts. This writer used to stamp arrival time, which wrote the
  /// burstiness straight into the file as uneven frame spacing — judder on top of
  /// whatever the link really dropped. Now the glasses' spacing is kept and only
  /// the offset onto the host clock comes from arrival, since the audio is from
  /// the phone mic on the host clock and both tracks share one timeline.
  private static func mapped(
    _ sample: CMSampleBuffer,
    offset: CMTime,
    arrival: CMTime
  ) -> (pts: CMTime, dts: CMTime) {
    let source = CMSampleBufferGetPresentationTimeStamp(sample)
    guard source.isNumeric else { return (arrival, arrival) }
    let pts = CMTimeAdd(source, offset)
    let sourceDTS = CMSampleBufferGetDecodeTimeStamp(sample)
    let dts = sourceDTS.isNumeric ? CMTimeAdd(sourceDTS, offset) : pts
    return (pts, dts)
  }

  private func append(
    _ retimed: CMSampleBuffer,
    to segment: Segment,
    pts: CMTime,
    dts: CMTime,
    keyframe: Bool,
    original sample: CMSampleBuffer
  ) {
    if segment.passthrough, segment.awaitingKeyframe, !keyframe {
      segment.skippedToKeyframe += 1
      return
    }
    guard segment.videoInput.isReadyForMoreMediaData else {
      segment.droppedNotReady += 1
      if segment.passthrough { segment.awaitingKeyframe = true }
      return
    }

    if segment.videoInput.append(retimed) {
      segment.videoSamples += 1
      if keyframe {
        segment.awaitingKeyframe = false
        if segment.passthrough { segment.keyframes += 1 }
      }
      segment.lastVideoPTS = pts
      segment.lastVideoDTS = dts
      let duration = CMSampleBufferGetDuration(sample)
      segment.lastPTS = duration.isNumeric && duration.value > 0
        ? CMTimeAdd(pts, duration)
        : CMTimeAdd(pts, Self.fallbackFrameDuration)
      drainAudio(into: segment, before: segment.lastPTS)
    } else {
      segment.videoAppendFailures += 1
      if segment.passthrough { segment.awaitingKeyframe = true }
      if segment.videoAppendFailures == 1 {
        Self.log(
          "VIDEO append FAILED (first) at pts=\(pts.seconds) "
            + "status=\(Self.describeStatus(segment.writer.status)) "
            + "error=\(Self.describe(segment.writer.error))"
        )
      }
    }
  }

  // MARK: - Cut / stop (called from the bridge)

  /// Finalize the in-flight segment; `completion` fires after the file is
  /// written and reported through `onSegment`.
  ///
  /// A passthrough segment ends on the next keyframe rather than this instant:
  /// ending it mid-GOP would leave the frames up to that keyframe with nowhere
  /// to go, a hole in the rolling buffer. The wait is at most one keyframe
  /// interval, and `cutKeyframeWaitSeconds` caps it on a stream that has
  /// stopped sending them.
  func cut(completion: @escaping () -> Void) {
    queue.async { [weak self] in
      guard let self, self.running, let segment = self.current else {
        completion()
        return
      }
      guard segment.passthrough else {
        self.rotate(completion: completion)
        return
      }
      self.pendingCuts.append(completion)
      self.armCutDeadline()
    }
  }

  private func armCutDeadline() {
    guard cutDeadline == nil else { return }
    let timer = DispatchSource.makeTimerSource(queue: queue)
    timer.schedule(deadline: .now() + Self.cutKeyframeWaitSeconds)
    timer.setEventHandler { [weak self] in
      guard let self else { return }
      self.cutDeadline = nil
      guard let cuts = self.takePendingCuts() else { return }
      Self.log(
        "no keyframe within \(Self.cutKeyframeWaitSeconds)s of a cut — ending the segment now; "
          + "frames until the next keyframe are dropped"
      )
      self.rotate(completion: cuts)
    }
    timer.resume()
    cutDeadline = timer
  }

  /// Every waiting `cut()` completion, folded into one, and the deadline
  /// cancelled. nil when nothing is waiting.
  private func takePendingCuts() -> (() -> Void)? {
    cutDeadline?.cancel()
    cutDeadline = nil
    guard !pendingCuts.isEmpty else { return nil }
    let cuts = pendingCuts
    pendingCuts = []
    return { cuts.forEach { $0() } }
  }

  /// Finish and report the in-flight segment now, keeping its footage — for
  /// when the stream is about to be torn down underneath it (stall recovery, a
  /// rebuilt pipeline). Call before `stopAndDiscard()`, which then finds
  /// nothing left to throw away.
  ///
  /// Holds `self` strongly: the bridge drops its reference straight after, and
  /// a weak capture would let the writer go before this ever ran.
  func finishCurrentSegment() {
    queue.async { [self] in
      guard let segment = current else { return }
      drainAudio(
        into: segment,
        before: CMTimeAdd(segment.lastPTS, CMTime(seconds: Self.finishTailSeconds, preferredTimescale: 600))
      )
      rotate(completion: takePendingCuts())
    }
  }

  /// Stop everything and discard the in-flight segment.
  ///
  /// Holds `self` strongly for the same reason as `finishCurrentSegment()`:
  /// with a weak capture the writer was usually gone by the time this ran, so
  /// nothing was cancelled and the half-written file stayed in tmp.
  func stopAndDiscard() {
    queue.async { [self] in
      if self.audioRunning {
        self.audioEngine.inputNode.removeTap(onBus: 0)
        self.audioEngine.stop()
        self.audioRunning = false
      }
      self.running = false
      self.rotateTimer?.cancel()
      self.rotateTimer = nil
      self.rotateDue = false
      self.priming = []
      self.pendingAudio = []
      // Nothing will ever end the segment these were waiting on. Settle them
      // so the JS promises behind them do not hang.
      self.takePendingCuts()?()
      if let segment = self.current {
        self.current = nil
        segment.writer.cancelWriting()
        try? FileManager.default.removeItem(atPath: segment.path)
      }
    }
  }

  // MARK: - Segment lifecycle (queue-only)

  private func startSegment(
    firstSample: CMSampleBuffer,
    firstPTS: CMTime,
    passthrough: Bool,
    clockOffset: CMTime
  ) throws -> Segment {
    let dir = NSTemporaryDirectory()
    let path = (dir as NSString).appendingPathComponent("clipso-mwdat-\(UUID().uuidString).mp4")
    let url = URL(fileURLWithPath: path)
    // AVAssetWriter refuses to initialize onto an existing file.
    if FileManager.default.fileExists(atPath: path) {
      try? FileManager.default.removeItem(at: url)
    }

    let writer = try AVAssetWriter(outputURL: url, fileType: .mp4)

    let formatDescription = CMSampleBufferGetFormatDescription(firstSample)
    var width = 504
    var height = 896
    var subType = "????"
    if let desc = formatDescription {
      let dims = CMVideoFormatDescriptionGetDimensions(desc)
      if dims.width > 0, dims.height > 0 {
        width = Int(dims.width)
        height = Int(dims.height)
      }
      subType = Self.fourCC(CMFormatDescriptionGetMediaSubType(desc))
      Self.log(
        "source video format: subtype='\(subType)' \(dims.width)x\(dims.height) "
          + "compressed=\(passthrough)"
      )
    }

    let videoInput: AVAssetWriterInput
    if passthrough {
      guard let formatDescription else {
        throw NSError(
          domain: "MWDATSegmentWriter", code: 4,
          userInfo: [
            NSLocalizedDescriptionKey: "Glasses frame has no format description to write it with.",
          ]
        )
      }
      // nil output settings: the glasses' own HEVC is written bit for bit. The
      // format hint is what the track's sample description is built from.
      videoInput = AVAssetWriterInput(
        mediaType: .video, outputSettings: nil, sourceFormatHint: formatDescription
      )
      Self.log("video input: \(width)x\(height) '\(subType)' passthrough (no re-encode)")
    } else {
      // Decoded pixels only reach here if the stream delivers them instead of
      // HEVC. 0.3 bits/pixel/frame at 30 fps, High profile: generous, because
      // this is the only encode those frames get before the stitcher passes
      // them through.
      let bitRate = max(4_000_000, Int(Double(width * height) * 30.0 * 0.3))
      videoInput = AVAssetWriterInput(
        mediaType: .video,
        outputSettings: [
          AVVideoCodecKey: AVVideoCodecType.h264,
          AVVideoWidthKey: width,
          AVVideoHeightKey: height,
          AVVideoCompressionPropertiesKey: [
            AVVideoAverageBitRateKey: bitRate,
            AVVideoExpectedSourceFrameRateKey: 30,
            AVVideoMaxKeyFrameIntervalKey: 30,
            // High profile buys CABAC and B-frames over Baseline — roughly 20%
            // better quality at the same bitrate, at no cost on a HW encoder.
            AVVideoProfileLevelKey: AVVideoProfileLevelH264HighAutoLevel,
          ],
        ]
      )
      Self.log("video input: \(width)x\(height) h264-high bitRate=\(bitRate) (raw frames)")
    }
    videoInput.expectsMediaDataInRealTime = true

    // Audio is optional: it is captured phone-side via AVAudioEngine and can be
    // absent entirely (engine never started, no route, permission). Adding an
    // input that then receives zero samples leaves an empty AAC track, and
    // finishWriting fails the whole segment over it — losing the video too.
    // Inputs cannot be added after startWriting, so decide here.
    var audioInput: AVAssetWriterInput?
    if audioRunning, hasReceivedAudioSample, !audioEncodingDisabled {
      let audioFormat = audioEngine.inputNode.outputFormat(forBus: 0)
      let sampleRate = audioFormat.sampleRate > 0 ? audioFormat.sampleRate : 44_100
      let channels = max(1, min(2, Int(audioFormat.channelCount)))
      let bitRate = Self.aacBitRate(sampleRate: sampleRate, channels: UInt32(channels))
      let input = AVAssetWriterInput(
        mediaType: .audio,
        outputSettings: [
          AVFormatIDKey: kAudioFormatMPEG4AAC,
          AVSampleRateKey: sampleRate,
          AVNumberOfChannelsKey: channels,
          AVEncoderBitRateKey: bitRate,
        ]
      )
      input.expectsMediaDataInRealTime = true
      audioInput = input
      Self.log(
        "audio input: \(sampleRate)Hz ch=\(channels) bitRate=\(bitRate) "
          + "commonFormat=\(audioFormat.commonFormat.rawValue) "
          + "interleaved=\(audioFormat.isInterleaved)"
      )
    } else if audioEncodingDisabled {
      Self.log("audio encoding previously failed — writing a video-only segment")
    } else if audioRunning {
      Self.log("audio engine has not produced samples yet — writing a video-only segment")
    } else {
      Self.log("audio not running — writing a video-only segment")
    }

    guard writer.canAdd(videoInput) else {
      throw NSError(
        domain: "MWDATSegmentWriter", code: 2,
        userInfo: [NSLocalizedDescriptionKey: "Writer rejected the video input"]
      )
    }
    writer.add(videoInput)
    if let audioInput {
      guard writer.canAdd(audioInput) else {
        throw NSError(
          domain: "MWDATSegmentWriter", code: 2,
          userInfo: [NSLocalizedDescriptionKey: "Writer rejected the audio input"]
        )
      }
      writer.add(audioInput)
    }

    guard writer.startWriting() else {
      Self.log("startWriting FAILED — \(Self.describe(writer.error))")
      throw writer.error ?? NSError(
        domain: "MWDATSegmentWriter", code: 3,
        userInfo: [NSLocalizedDescriptionKey: "Writer failed to start"]
      )
    }
    writer.startSession(atSourceTime: firstPTS)
    Self.log(
      "segment opened \(width)x\(height) audio=\(audioInput != nil) "
        + "sessionStart=\(firstPTS.seconds) status=\(Self.describeStatus(writer.status))"
    )

    return Segment(
      writer: writer,
      videoInput: videoInput,
      audioInput: audioInput,
      path: path,
      startedAtMs: Date().timeIntervalSince1970 * 1000,
      firstPTS: firstPTS,
      passthrough: passthrough,
      formatDescription: formatDescription,
      clockOffset: clockOffset
    )
  }

  private func scheduleRotation() {
    rotateTimer?.cancel()
    let timer = DispatchSource.makeTimerSource(queue: queue)
    timer.schedule(deadline: .now() + segmentSeconds)
    timer.setEventHandler { [weak self] in
      guard let self, let segment = self.current else { return }
      if segment.passthrough {
        // Ended by the next keyframe in appendVideoOnQueue.
        self.rotateDue = true
      } else {
        self.rotate(completion: nil)
      }
    }
    timer.resume()
    rotateTimer = timer
  }

  /// Finish the current segment and report it. The next arriving video frame
  /// (the next keyframe, for a passthrough stream) opens the next segment, so
  /// the loop keeps running until stopAndDiscard().
  private func rotate(completion: (() -> Void)?) {
    rotateTimer?.cancel()
    rotateTimer = nil
    rotateDue = false
    loggedLongSegment = false

    guard let segment = current else {
      completion?()
      return
    }
    current = nil

    // The file ends at its last sample of either kind, and JS trims the wake
    // word against this duration, so it must be the file's, not the video's.
    let end = segment.audioEnd.isNumeric && segment.audioEnd > segment.lastPTS
      ? segment.audioEnd
      : segment.lastPTS
    let finished = FinishedSegment(
      path: segment.path,
      startedAtMs: segment.startedAtMs,
      durationSec: max(0, CMTimeSubtract(end, segment.firstPTS).seconds)
    )
    let fps = finished.durationSec > 0 ? Double(segment.videoSamples) / finished.durationSec : 0

    Self.log(
      "rotating: video=\(segment.videoSamples) samples "
        + "(failed=\(segment.videoAppendFailures), notReady=\(segment.droppedNotReady)) "
        + "fps=\(String(format: "%.1f", fps)) "
        + "mode=\(segment.passthrough ? "passthrough keyframes=\(segment.keyframes) skippedToKeyframe=\(segment.skippedToKeyframe)" : "encode") "
        + "audio=\(segment.audioSamples) samples (failed=\(segment.audioAppendFailures), "
        + "preSession=\(segment.audioPreSessionDrops), peak=\(segment.audioPeak)) "
        + "span=\(finished.durationSec)s worstGap=\(String(format: "%.2f", segment.longestGapSec))s "
        + "status=\(Self.describeStatus(segment.writer.status))"
    )

    // Audio is the only thing the wake word hears. If the mic never came up —
    // permission prompt still unanswered when we armed, transient session
    // conflict — retry now rather than run the whole session deaf.
    if !audioRunning { startAudio() }

    // Nothing was written: finishing would either fail or emit an unplayable
    // zero-sample file. Discard it and say so plainly.
    guard segment.videoSamples > 0 else {
      segment.writer.cancelWriting()
      try? FileManager.default.removeItem(atPath: segment.path)
      Self.log("segment had no video samples — discarded")
      onError("Segment produced no video frames.")
      completion?()
      return
    }

    segment.videoInput.markAsFinished()
    segment.audioInput?.markAsFinished()
    // Strong: a segment finished on the way into a teardown still has to be
    // reported, after the bridge has already let go of this writer.
    segment.writer.finishWriting { [self] in
      if segment.writer.status == .completed {
        let size = (try? FileManager.default.attributesOfItem(atPath: finished.path)[.size]) as? Int ?? -1
        Self.log("segment WROTE \(finished.durationSec)s \(size) bytes → \(finished.path)")
        self.onSegment(finished)
      } else {
        Self.log(
          "segment FAILED status=\(Self.describeStatus(segment.writer.status)) "
            + "— \(Self.describe(segment.writer.error))"
        )
        try? FileManager.default.removeItem(atPath: finished.path)
        // The video encoded fine (samples were accepted); if the segment still
        // failed to finish while an audio track was attached, audio is the
        // culprit. Drop it rather than keep losing clips.
        if segment.audioInput != nil {
          self.queue.async { self.audioEncodingDisabled = true }
          Self.log("disabling audio for subsequent segments after this failure")
        }
        // Surface domain/code too: "Cannot Encode Media" on its own names
        // neither the track nor the reason.
        let detail = segment.writer.error.map { error -> String in
          let ns = error as NSError
          return "\(ns.localizedDescription) [\(ns.domain) \(ns.code)]"
        } ?? "unknown writer error"
        self.onError("Segment failed: \(detail)")
      }
      completion?()
    }
  }

  // MARK: - Sample-buffer helpers

  /// A copy of `sample` at the given timeline position. Passthrough frames also
  /// get explicit sync flags: SDK buffers can omit them, and without them the
  /// writer builds no keyframe index, so the file plays but cannot be seeked,
  /// trimmed on a keyframe, or imported to Photos.
  private static func retimed(
    _ sample: CMSampleBuffer,
    pts: CMTime,
    dts: CMTime,
    keyframe: Bool,
    passthrough: Bool
  ) -> CMSampleBuffer? {
    let duration = CMSampleBufferGetDuration(sample)
    var timing = CMSampleTimingInfo(
      duration: duration.isNumeric && duration.value > 0
        ? duration
        : (passthrough ? fallbackFrameDuration : .invalid),
      presentationTimeStamp: pts,
      decodeTimeStamp: passthrough ? dts : .invalid
    )
    var out: CMSampleBuffer?
    let status = CMSampleBufferCreateCopyWithNewTiming(
      allocator: kCFAllocatorDefault,
      sampleBuffer: sample,
      sampleTimingEntryCount: 1,
      sampleTimingArray: &timing,
      sampleBufferOut: &out
    )
    guard status == noErr, let out else { return nil }
    if passthrough,
       let attachments = CMSampleBufferGetSampleAttachmentsArray(out, createIfNecessary: true)
         as? [NSMutableDictionary],
       let first = attachments.first {
      first[kCMSampleAttachmentKey_NotSync] = !keyframe
      first[kCMSampleAttachmentKey_DependsOnOthers] = !keyframe
    }
    return out
  }

  /// Loudest absolute sample, 0…1. A granted-but-muted microphone delivers
  /// buffers of exact zeros, which is otherwise indistinguishable from a
  /// working mic in a quiet room until the wake word silently never fires.
  private static func peakLevel(of buffer: AVAudioPCMBuffer) -> Float {
    guard let channels = buffer.floatChannelData, buffer.frameLength > 0 else { return 0 }
    var peak: Float = 0
    for channel in 0..<Int(buffer.format.channelCount) {
      let samples = channels[channel]
      for frame in 0..<Int(buffer.frameLength) {
        peak = max(peak, abs(samples[frame]))
      }
    }
    return peak
  }

  private static func makeAudioSampleBuffer(
    from buffer: AVAudioPCMBuffer,
    at time: AVAudioTime
  ) -> CMSampleBuffer? {
    let format = buffer.format
    var formatDescription: CMAudioFormatDescription?
    var status = CMAudioFormatDescriptionCreate(
      allocator: kCFAllocatorDefault,
      asbd: format.streamDescription,
      layoutSize: 0,
      layout: nil,
      magicCookieSize: 0,
      magicCookie: nil,
      extensions: nil,
      formatDescriptionOut: &formatDescription
    )
    guard status == noErr, let description = formatDescription else { return nil }

    let pts = time.isHostTimeValid
      ? CMClockMakeHostTimeFromSystemUnits(time.hostTime)
      : CMClockGetTime(CMClockGetHostTimeClock())

    var timing = CMSampleTimingInfo(
      duration: CMTime(value: 1, timescale: CMTimeScale(format.sampleRate)),
      presentationTimeStamp: pts,
      decodeTimeStamp: .invalid
    )

    var sample: CMSampleBuffer?
    status = CMSampleBufferCreate(
      allocator: kCFAllocatorDefault,
      dataBuffer: nil,
      dataReady: false,
      makeDataReadyCallback: nil,
      refcon: nil,
      formatDescription: description,
      sampleCount: CMItemCount(buffer.frameLength),
      sampleTimingEntryCount: 1,
      sampleTimingArray: &timing,
      sampleSizeEntryCount: 0,
      sampleSizeArray: nil,
      sampleBufferOut: &sample
    )
    guard status == noErr, let sampleBuffer = sample else { return nil }

    status = CMSampleBufferSetDataBufferFromAudioBufferList(
      sampleBuffer,
      blockBufferAllocator: kCFAllocatorDefault,
      blockBufferMemoryAllocator: kCFAllocatorDefault,
      flags: 0,
      bufferList: buffer.audioBufferList
    )
    return status == noErr ? sampleBuffer : nil
  }
}

// MARK: - Keyframes

extension CMSampleBuffer {
  /// Whether a file, or a decoder, can start at this frame.
  ///
  /// Raw pixel buffers stand alone, so every one qualifies. A compressed frame
  /// qualifies only if it holds an HEVC random-access picture (BLA/IDR/CRA, NAL
  /// types 16-21) or an H.264 IDR (type 5). An explicit `NotSync` attachment is
  /// trusted when present, but its absence is not: CoreMedia reads a missing
  /// flag as "sync", and SDK buffers omit it, so every frame would pass.
  var isVideoKeyframe: Bool {
    if CMSampleBufferGetImageBuffer(self) != nil { return true }
    if let attachments = CMSampleBufferGetSampleAttachmentsArray(self, createIfNecessary: false)
      as? [[String: Any]],
      let notSync = attachments.first?[kCMSampleAttachmentKey_NotSync as String] as? Bool {
      return !notSync
    }
    guard let format = CMSampleBufferGetFormatDescription(self),
          let data = CMSampleBufferGetDataBuffer(self)
    else { return false }

    let codec = CMFormatDescriptionGetMediaSubType(format)
    // 'hev1' carries its parameter sets in-band; CoreMedia names only 'hvc1'.
    let hev1: FourCharCode = 0x6865_7631
    let hevc = codec == kCMVideoCodecType_HEVC || codec == hev1
    var lengthSize: Int32 = 4
    if hevc {
      _ = CMVideoFormatDescriptionGetHEVCParameterSetAtIndex(
        format, parameterSetIndex: 0, parameterSetPointerOut: nil,
        parameterSetSizeOut: nil, parameterSetCountOut: nil, nalUnitHeaderLengthOut: &lengthSize
      )
    } else if codec == kCMVideoCodecType_H264 {
      _ = CMVideoFormatDescriptionGetH264ParameterSetAtIndex(
        format, parameterSetIndex: 0, parameterSetPointerOut: nil,
        parameterSetSizeOut: nil, parameterSetCountOut: nil, nalUnitHeaderLengthOut: &lengthSize
      )
    } else {
      return false
    }
    let headerLength = [1, 2, 4].contains(Int(lengthSize)) ? Int(lengthSize) : 4

    // Length-prefixed NAL units; an access unit can open with parameter sets
    // or a delimiter before the picture, so walk all of them.
    let total = CMBlockBufferGetDataLength(data)
    var offset = 0
    var lengthBytes = [UInt8](repeating: 0, count: headerLength)
    while offset + headerLength < total {
      guard CMBlockBufferCopyDataBytes(
        data, atOffset: offset, dataLength: headerLength, destination: &lengthBytes
      ) == kCMBlockBufferNoErr else { return false }
      let nalLength = lengthBytes.reduce(0) { ($0 << 8) | Int($1) }
      offset += headerLength
      guard nalLength > 0, offset + nalLength <= total else { return false }

      var header: UInt8 = 0
      guard CMBlockBufferCopyDataBytes(
        data, atOffset: offset, dataLength: 1, destination: &header
      ) == kCMBlockBufferNoErr else { return false }
      if hevc {
        if (16...21).contains((header >> 1) & 0x3F) { return true }
      } else if header & 0x1F == 5 {
        return true
      }
      offset += nalLength
    }
    return false
  }
}
