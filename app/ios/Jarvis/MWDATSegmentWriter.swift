import AVFoundation
import CoreMedia
import Foundation

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

  private var running = true
  private var current: Segment?
  private var rotateTimer: DispatchSourceTimer?

  private final class Segment {
    let writer: AVAssetWriter
    let videoInput: AVAssetWriterInput
    let audioInput: AVAssetWriterInput
    let path: String
    let startedAtMs: Double
    let firstPTS: CMTime
    var lastPTS: CMTime

    init(
      writer: AVAssetWriter,
      videoInput: AVAssetWriterInput,
      audioInput: AVAssetWriterInput,
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
      guard let self, self.running, let segment = self.current else { return }
      guard segment.audioInput.isReadyForMoreMediaData else { return }
      let pts = CMSampleBufferGetPresentationTimeStamp(sample)
      // Never write media that predates the writer session — AVAssetWriter drops the segment otherwise.
      guard pts >= segment.firstPTS else { return }
      segment.audioInput.append(sample)
    }
  }

  private func appendVideoOnQueue(_ sample: CMSampleBuffer, at arrival: CMTime) {
    guard running else { return }

    guard let retimed = Self.retimed(sample, to: arrival) else { return }

    if current == nil {
      do {
        current = try startSegment(firstSample: retimed, firstPTS: arrival)
        scheduleRotation()
      } catch {
        running = false
        onError("Could not start segment writer: \(error.localizedDescription)")
        return
      }
    }

    guard let segment = current else { return }
    if segment.videoInput.isReadyForMoreMediaData {
      segment.videoInput.append(retimed)
      let duration = CMSampleBufferGetDuration(sample)
      segment.lastPTS = duration.isValid && duration.value > 0
        ? CMTimeAdd(arrival, duration)
        : arrival
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

    let writer = try AVAssetWriter(outputURL: url, fileType: .mp4)

    var width = 504
    var height = 896
    if let desc = CMSampleBufferGetFormatDescription(firstSample) {
      let dims = CMVideoFormatDescriptionGetDimensions(desc)
      if dims.width > 0, dims.height > 0 {
        width = Int(dims.width)
        height = Int(dims.height)
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

    let audioFormat = audioEngine.inputNode.outputFormat(forBus: 0)
    let audioInput = AVAssetWriterInput(
      mediaType: .audio,
      outputSettings: [
        AVFormatIDKey: kAudioFormatMPEG4AAC,
        AVSampleRateKey: audioFormat.sampleRate > 0 ? audioFormat.sampleRate : 44_100,
        AVNumberOfChannelsKey: max(1, min(2, Int(audioFormat.channelCount))),
        AVEncoderBitRateKey: 96_000,
      ]
    )
    audioInput.expectsMediaDataInRealTime = true

    guard writer.canAdd(videoInput), writer.canAdd(audioInput) else {
      throw NSError(
        domain: "MWDATSegmentWriter", code: 2,
        userInfo: [NSLocalizedDescriptionKey: "Writer rejected inputs"]
      )
    }
    writer.add(videoInput)
    writer.add(audioInput)

    guard writer.startWriting() else {
      throw writer.error ?? NSError(
        domain: "MWDATSegmentWriter", code: 3,
        userInfo: [NSLocalizedDescriptionKey: "Writer failed to start"]
      )
    }
    writer.startSession(atSourceTime: firstPTS)

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

    segment.videoInput.markAsFinished()
    segment.audioInput.markAsFinished()
    segment.writer.finishWriting { [weak self] in
      guard let self else { return }
      if segment.writer.status == .completed {
        self.onSegment(finished)
      } else {
        try? FileManager.default.removeItem(atPath: finished.path)
        self.onError(
          "Segment failed: \(segment.writer.error?.localizedDescription ?? "unknown writer error")"
        )
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
