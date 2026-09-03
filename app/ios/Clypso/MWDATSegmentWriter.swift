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
  /// Master switch. The file log is a field-debugging aid for the glasses
  /// handshake, not telemetry, so it must be possible to turn off without
  /// hunting down call sites — every `write` goes through here.
  static var isEnabled = true

  /// Hard ceiling for the file. It previously grew without bound for the life
  /// of an install: an armed session logs continuously, and nothing ever
  /// truncated except an explicit `reset()` at the start of a capture run.
  private static let maxBytes: off_t = 2 * 1024 * 1024

  /// Checking the size costs an `lseek`, which is cheap but not free on the
  /// hot path of every bridge event. Amortise it — the slack between the cap
  /// and any plausible burst is far more than 64 lines.
  private static let sizeCheckInterval = 64

  private static let queue = DispatchQueue(label: "com.mocinjay.clypso.diaglog")
  private static let path: String? = FileManager.default
    .urls(for: .documentDirectory, in: .userDomainMask).first?
    .appendingPathComponent("clypso-diagnostics.log").path

  /// Opened once and retained. The previous implementation opened, seeked and
  /// closed a `FileHandle` for every single line.
  ///
  /// `O_APPEND` rather than seek-to-end deliberately: SpeechWakeWord.m appends
  /// to this same file from its own queue, and append-mode writes of
  /// line-sized payloads are atomic, so the two writers cannot tear a line.
  private static var fd: Int32 = -1
  private static var writesSinceSizeCheck = 0

  /// Serial-queue only. Returns -1 if the log is unusable, and does not retry
  /// on every line once it is.
  private static func handle() -> Int32 {
    if fd >= 0 { return fd }
    guard let path else { return -1 }
    fd = open(path, O_WRONLY | O_APPEND | O_CREAT, 0o644)
    return fd
  }

  /// Truncate at the start of a capture run so each run reads cleanly.
  static func reset() {
    queue.async {
      let descriptor = handle()
      guard descriptor >= 0 else { return }
      ftruncate(descriptor, 0)
      writesSinceSizeCheck = 0
    }
  }

  static func write(_ message: String) {
    guard isEnabled else { return }
    let stamp = ISO8601DateFormatter().string(from: Date())
    let line = "\(stamp) \(message)\n"
    queue.async {
      let descriptor = handle()
      guard descriptor >= 0, let data = line.data(using: .utf8) else { return }
      _ = data.withUnsafeBytes { buffer in
        Darwin.write(descriptor, buffer.baseAddress, buffer.count)
      }

      writesSinceSizeCheck += 1
      guard writesSinceSizeCheck >= sizeCheckInterval else { return }
      writesSinceSizeCheck = 0
      // Measured rather than counted: the ObjC wake-word path appends to this
      // file too, so a byte tally kept here alone would under-read the truth.
      // Truncating (rather than rolling to a .1) keeps the other writer's
      // O_APPEND descriptor valid — its offset is recomputed per write.
      if lseek(descriptor, 0, SEEK_END) > maxBytes {
        ftruncate(descriptor, 0)
      }
    }
  }
}

/// Writes the MWDAT glasses stream as back-to-back fixed-length MP4 segments —
/// the same rolling-segment contract MockDeviceSource fulfils with the phone
/// camera.
///
/// Video frames arrive as CMSampleBuffers from the SDK on the glasses' own
/// timeline; the toolkit exposes no microphone API, so audio is captured
/// phone-side with AVAudioEngine (iOS routes input from the glasses' Bluetooth
/// mic while they are the active audio device). Both tracks are re-stamped
/// onto the host clock at arrival so a single AVAssetWriter timeline can hold
/// them; segment-level drift over a few seconds is imperceptible.
final class MWDATSegmentWriter {
  struct FinishedSegment {
    let path: String
    let startedAtMs: Double
    let durationSec: Double
  }

  private let queue = DispatchQueue(label: "com.mocinjay.clypso.mwdat.writer")
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

  /// Segments delivered at each resolution, keyed "WxH", plus the order the
  /// rungs were first seen.
  ///
  /// The SDK's quality ladder is not observable directly: MWDATCore exposes no
  /// transport, bandwidth or link-quality API, so which physical link a session
  /// negotiated cannot be read at all. What it does expose is the consequence —
  /// the size of the frames it hands us. Tallying those per session is the only
  /// honest answer available to "which rung do real sessions actually get", and
  /// one session can hold several, because the ladder steps down mid-stream.
  ///
  /// The per-segment format is already logged in `startSegment`. That line says
  /// what a segment was, never what a session was, and nothing reads a whole
  /// log back to count. This is the aggregate that line could not be.
  private var rungSegments: [String: Int] = [:]
  private var rungOrder: [String] = []

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

    var videoSamples = 0
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
      firstPTS: CMTime
    ) {
      self.writer = writer
      self.videoInput = videoInput
      self.audioInput = audioInput
      self.path = path
      self.startedAtMs = startedAtMs
      self.firstPTS = firstPTS
      self.lastPTS = firstPTS
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
      guard let segment = self.current else { return }
      segment.audioPeak = max(segment.audioPeak, peak)
      guard let audioInput = segment.audioInput else { return }
      guard audioInput.isReadyForMoreMediaData else { return }
      // Never write media that predates the writer session — AVAssetWriter drops the segment otherwise.
      guard pts >= segment.firstPTS else {
        segment.audioPreSessionDrops += 1
        return
      }
      if audioInput.append(sample) {
        segment.audioSamples += 1
      } else {
        segment.audioAppendFailures += 1
        if segment.audioAppendFailures == 1 {
          Self.log(
            "AUDIO append FAILED (first) at pts=\(pts.seconds) "
              + "status=\(Self.describeStatus(segment.writer.status)) "
              + "error=\(Self.describe(segment.writer.error))"
          )
        }
      }
    }
  }

  private func appendVideoOnQueue(_ sample: CMSampleBuffer, at arrival: CMTime) {
    guard running else { return }

    // Video and audio share the host clock (audio is phone-mic), so a frame is
    // stamped with the moment it arrived. Only monotonicity is enforced.
    //
    // There used to be an upper clamp here too — no more than ~2 frames (66 ms)
    // past the previous PTS — meant to smooth over dropped frames. It did the
    // opposite of what a rolling buffer needs: any gap longer than 66 ms (a
    // Bluetooth hiccup, or simply the SDK's quality ladder dropping below
    // 15 fps) was rewritten as 66 ms, so the file's timeline ran FASTER than
    // real time. Three consequences, all of them things this app promises not
    // to get wrong:
    //   1. `durationSec` is the PTS span, so every segment under-reported how
    //      much wall time it covered — that is why the buffered-seconds counter
    //      was always low and the look-back window held more than it claimed.
    //   2. Audio is NOT clamped (it is stamped from the host clock), so video
    //      drifted ahead of audio by the whole accumulated gap — progressive
    //      A/V desync inside a single segment.
    //   3. Playback was time-compressed: the clip ran fast.
    // A real gap in the feed is a real freeze; recording it honestly keeps the
    // clip, its duration and its audio aligned.
    var pts = arrival
    if let segment = current, segment.lastVideoPTS.isValid {
      let minNext = CMTimeAdd(segment.lastVideoPTS, CMTime(value: 1, timescale: 30_000))
      if pts < minNext { pts = minNext }
      let gap = CMTimeSubtract(pts, segment.lastVideoPTS).seconds
      if gap > segment.longestGapSec { segment.longestGapSec = gap }
    }

    guard let retimed = Self.retimed(sample, to: pts) else {
      Self.log("retiming failed — dropping frame")
      return
    }

    if current == nil {
      do {
        current = try startSegment(firstSample: retimed, firstPTS: pts)
        scheduleRotation()
      } catch {
        running = false
        Self.log("could not start segment writer — \(Self.describe(error))")
        logRungSummary()
        onError("Could not start segment writer: \(error.localizedDescription)")
        return
      }
    }

    guard let segment = current else { return }
    guard segment.videoInput.isReadyForMoreMediaData else {
      segment.droppedNotReady += 1
      return
    }

    if segment.videoInput.append(retimed) {
      segment.videoSamples += 1
      segment.lastVideoPTS = pts
      let duration = CMSampleBufferGetDuration(sample)
      segment.lastPTS = duration.isValid && duration.value > 0
        ? CMTimeAdd(pts, duration)
        : pts
    } else {
      segment.videoAppendFailures += 1
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

  /// Finalize the in-flight segment immediately; `completion` fires after the
  /// file is written and reported through `onSegment`.
  func cut(completion: @escaping () -> Void) {
    queue.async { [weak self] in
      guard let self, self.running, self.current != nil else {
        completion()
        return
      }
      self.rotate(completion: completion)
    }
  }

  /// Stop everything and discard the in-flight segment.
  func stopAndDiscard() {
    queue.async { [weak self] in
      guard let self else { return }
      if self.audioRunning {
        self.audioEngine.inputNode.removeTap(onBus: 0)
        self.audioEngine.stop()
        self.audioRunning = false
      }
      self.running = false
      self.rotateTimer?.cancel()
      self.rotateTimer = nil
      if let segment = self.current {
        self.current = nil
        segment.writer.cancelWriting()
        try? FileManager.default.removeItem(atPath: segment.path)
      }
      self.logRungSummary()
    }
  }

  // MARK: - Rung tally (queue-only)

  private func recordRung(_ rung: String) {
    if rungSegments[rung] == nil {
      rungOrder.append(rung)
    }
    rungSegments[rung, default: 0] += 1
  }

  /// One line per session naming every rung it ran at, in the order they
  /// appeared. Emitted from both stop paths so an abandoned session is counted
  /// the same as a clean one — a session that dropped a rung and was then given
  /// up on is precisely the case worth seeing, and it is the one most likely to
  /// end by discarding.
  private func logRungSummary() {
    guard !rungOrder.isEmpty else { return }
    let total = rungSegments.values.reduce(0, +)
    let tally = rungOrder.map { "\($0)=\(rungSegments[$0] ?? 0)" }.joined(separator: " ")
    let path = rungOrder.count > 1 ? " path=\(rungOrder.joined(separator: ">"))" : ""
    Self.log("session rungs: \(tally) segments=\(total)\(path)")
    rungSegments.removeAll()
    rungOrder.removeAll()
  }

  // MARK: - Segment lifecycle (queue-only)

  private func startSegment(firstSample: CMSampleBuffer, firstPTS: CMTime) throws -> Segment {
    let dir = NSTemporaryDirectory()
    let path = (dir as NSString).appendingPathComponent("clypso-mwdat-\(UUID().uuidString).mp4")
    let url = URL(fileURLWithPath: path)
    // AVAssetWriter refuses to initialize onto an existing file.
    if FileManager.default.fileExists(atPath: path) {
      try? FileManager.default.removeItem(at: url)
    }

    let writer = try AVAssetWriter(outputURL: url, fileType: .mp4)

    var width = 504
    var height = 896
    if let desc = CMSampleBufferGetFormatDescription(firstSample) {
      let dims = CMVideoFormatDescriptionGetDimensions(desc)
      if dims.width > 0, dims.height > 0 {
        width = Int(dims.width)
        height = Int(dims.height)
      }
      let subType = CMFormatDescriptionGetMediaSubType(desc)
      let isCompressed = CMSampleBufferGetImageBuffer(firstSample) == nil
      Self.log(
        "source video format: subtype='\(Self.fourCC(subType))' \(dims.width)x\(dims.height) "
          + "compressed=\(isCompressed)"
      )
      // Tally what the SDK actually delivered, never the 504x896 fallback
      // above — that is a guess used to keep the encoder configurable, and
      // counting it as an observation would put invented rungs in the
      // distribution this exists to measure.
      if dims.width > 0, dims.height > 0 {
        recordRung("\(dims.width)x\(dims.height)")
      } else {
        recordRung("unknown")
      }
      if isCompressed {
        // The H.264 output settings below configure an ENCODER input, which
        // only accepts uncompressed samples. Fail loudly rather than let
        // AVFoundation report it as an opaque "Cannot Encode Media".
        throw NSError(
          domain: "MWDATSegmentWriter", code: 4,
          userInfo: [
            NSLocalizedDescriptionKey:
              "Glasses are delivering compressed '\(Self.fourCC(subType))' frames, but the "
              + "segment writer encodes raw frames. Set the stream's videoCodec to .raw.",
          ]
        )
      }
    }

    // 0.3 bits/pixel/frame at 30 fps. The previous `width * height * 2` was
    // 0.067 bpp (its "~0.2" comment was off by 3x) and only ever hit the
    // 1.5 Mbit floor, which is what made clips look soft next to a native
    // Meta recording. This is the LAST place the glasses' pixels are encoded
    // at full fidelity — the stitcher passes these segments through untouched —
    // so it is the one that has to be generous.
    //
    // Encode cost is not the constraint it was assumed to be: this is a
    // hardware VideoToolbox encode, and 720x1280@30 is a small fraction of
    // what the SoC sustains. Disk is not either — 30s at 8 Mbit is ~30 MB of
    // temporary files that the ring buffer deletes as it evicts them.
    let bitRate = max(4_000_000, Int(Double(width * height) * 30.0 * 0.3))
    let videoInput = AVAssetWriterInput(
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
    videoInput.expectsMediaDataInRealTime = true
    Self.log("video input: \(width)x\(height) h264-high bitRate=\(bitRate)")

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
      firstPTS: firstPTS
    )
  }

  private func scheduleRotation() {
    rotateTimer?.cancel()
    let timer = DispatchSource.makeTimerSource(queue: queue)
    timer.schedule(deadline: .now() + segmentSeconds)
    timer.setEventHandler { [weak self] in
      self?.rotate(completion: nil)
    }
    timer.resume()
    rotateTimer = timer
  }

  /// Finish the current segment and report it. The next arriving video frame
  /// opens the next segment, so the loop keeps running until stopAndDiscard().
  private func rotate(completion: (() -> Void)?) {
    rotateTimer?.cancel()
    rotateTimer = nil

    guard let segment = current else {
      completion?()
      return
    }
    current = nil

    let finished = FinishedSegment(
      path: segment.path,
      startedAtMs: segment.startedAtMs,
      durationSec: max(0, CMTimeSubtract(segment.lastPTS, segment.firstPTS).seconds)
    )

    Self.log(
      "rotating: video=\(segment.videoSamples) samples "
        + "(failed=\(segment.videoAppendFailures), notReady=\(segment.droppedNotReady)) "
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
    segment.writer.finishWriting { [weak self] in
      guard let self else { return }
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

  private static func retimed(_ sample: CMSampleBuffer, to pts: CMTime) -> CMSampleBuffer? {
    var timing = CMSampleTimingInfo(
      duration: CMSampleBufferGetDuration(sample),
      presentationTimeStamp: pts,
      decodeTimeStamp: .invalid
    )
    var out: CMSampleBuffer?
    let status = CMSampleBufferCreateCopyWithNewTiming(
      allocator: kCFAllocatorDefault,
      sampleBuffer: sample,
      sampleTimingEntryCount: 1,
      sampleTimingArray: &timing,
      sampleBufferOut: &out
    )
    return status == noErr ? out : nil
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
