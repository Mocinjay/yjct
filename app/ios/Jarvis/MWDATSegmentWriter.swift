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
  private static let queue = DispatchQueue(label: "com.mocinjay.jarvis.diaglog")
  private static let url: URL? = FileManager.default
    .urls(for: .documentDirectory, in: .userDomainMask).first?
    .appendingPathComponent("jarvis-diagnostics.log")

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

  private let queue = DispatchQueue(label: "com.mocinjay.jarvis.mwdat.writer")
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

  private var running = true
  private var current: Segment?
  private var rotateTimer: DispatchSourceTimer?

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
    var droppedNotReady = 0
    /// Last PTS actually handed to the video input, for the monotonicity guard.
    var lastVideoPTS: CMTime = .invalid

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

  func startAudio() throws {
    let session = AVAudioSession.sharedInstance()
    try session.setCategory(
      .playAndRecord,
      mode: .default,
      options: [.allowBluetooth, .mixWithOthers]
    )
    try session.setActive(true)

    // Glasses-first audio: pin the input to the glasses' Bluetooth mic. The
    // glasses' voice pickup beats the phone lying on a table, and it keeps
    // audio and video from the same point of view.
    if let glassesMic = session.availableInputs?.first(where: {
      $0.portType == .bluetoothHFP
    }) {
      try? session.setPreferredInput(glassesMic)
    }

    let input = audioEngine.inputNode
    let format = input.outputFormat(forBus: 0)
    guard format.sampleRate > 0, format.channelCount > 0 else {
      throw NSError(
        domain: "MWDATSegmentWriter", code: 1,
        userInfo: [NSLocalizedDescriptionKey: "No usable microphone input"]
      )
    }
    input.installTap(onBus: 0, bufferSize: 1024, format: format) { [weak self] buffer, time in
      self?.appendAudio(buffer, at: time)
    }
    try audioEngine.start()
    audioRunning = true
    Self.log(
      "audio engine started: \(format.sampleRate)Hz ch=\(format.channelCount) "
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
    guard let sample = Self.makeAudioSampleBuffer(from: buffer, at: time) else {
      return
    }
    queue.async { [weak self] in
      guard let self, self.running else { return }
      self.hasReceivedAudioSample = true
      guard let segment = self.current else { return }
      guard let audioInput = segment.audioInput else { return }
      guard audioInput.isReadyForMoreMediaData else { return }
      let pts = CMSampleBufferGetPresentationTimeStamp(sample)
      // Never write media that predates the writer session — AVAssetWriter drops the segment otherwise.
      guard pts >= segment.firstPTS else { return }
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

    // Frames are re-stamped onto the host clock at arrival, so two frames
    // delivered in the same burst can land on an identical (or inverted)
    // timestamp. AVAssetWriter requires strictly increasing PTS and fails the
    // whole segment otherwise, so nudge duplicates forward by one frame slot.
    var pts = arrival
    if let segment = current, segment.lastVideoPTS.isValid, pts <= segment.lastVideoPTS {
      pts = CMTimeAdd(segment.lastVideoPTS, CMTime(value: 1, timescale: 600))
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
    if audioRunning {
      audioEngine.inputNode.removeTap(onBus: 0)
      audioEngine.stop()
      audioRunning = false
    }
    queue.async { [weak self] in
      guard let self else { return }
      self.running = false
      self.rotateTimer?.cancel()
      self.rotateTimer = nil
      if let segment = self.current {
        self.current = nil
        segment.writer.cancelWriting()
        try? FileManager.default.removeItem(atPath: segment.path)
      }
    }
  }

  // MARK: - Segment lifecycle (queue-only)

  private func startSegment(firstSample: CMSampleBuffer, firstPTS: CMTime) throws -> Segment {
    let dir = NSTemporaryDirectory()
    let path = (dir as NSString).appendingPathComponent("jarvis-mwdat-\(UUID().uuidString).mp4")
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

    let videoInput = AVAssetWriterInput(
      mediaType: .video,
      outputSettings: [
        AVVideoCodecKey: AVVideoCodecType.h264,
        AVVideoWidthKey: width,
        AVVideoHeightKey: height,
      ]
    )
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
        + "audio=\(segment.audioSamples) samples (failed=\(segment.audioAppendFailures)) "
        + "span=\(finished.durationSec)s status=\(Self.describeStatus(segment.writer.status))"
    )

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
