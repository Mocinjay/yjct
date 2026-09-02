#import <AVFoundation/AVFoundation.h>
#import <React/RCTBridgeModule.h>
#import <UIKit/UIKit.h>

// ASCII-only on purpose: a format string containing non-ASCII is emitted as a
// UTF-16 CFString, which `strings` cannot see, making it useless as a
// build-provenance fingerprint when checking whether a device is running
// current code.
#define JVSLog(fmt, ...)                                                       \
  NSLog(@"[ClipStitcher] %s:%d %s: " fmt,                                      \
        [[@(__FILE__) lastPathComponent] UTF8String], __LINE__, __func__,      \
        ##__VA_ARGS__)

/// A track that exists is not a track that has content. MWDATSegmentWriter adds
/// its audio input up front and finishes a segment as long as video arrived, so
/// a segment can carry an audio track that received zero samples. Reading such a
/// track contributes nothing, so the stitcher skips those tracks entirely.
static BOOL JVSTrackHasContent(AVAssetTrack *track)
{
  if (track == nil) {
    return NO;
  }
  CMTimeRange range = track.timeRange;
  if (!CMTIMERANGE_IS_VALID(range) || CMTIMERANGE_IS_EMPTY(range)) {
    return NO;
  }
  return CMTimeCompare(range.duration, kCMTimeZero) > 0;
}

/// Ceiling on a local asset's key load. These are files in our own container,
/// so a load that has not landed by now is not slow, it is stuck — and waiting
/// FOREVER on it parks the calling thread for the life of the process.
static const int64_t kJVSAssetLoadTimeoutSec = 30;

static BOOL JVSLoadAssetKeys(AVAsset *asset, NSArray<NSString *> *keys, NSError **error)
{
  dispatch_semaphore_t semaphore = dispatch_semaphore_create(0);
  [asset loadValuesAsynchronouslyForKeys:keys completionHandler:^{
    dispatch_semaphore_signal(semaphore);
  }];
  if (dispatch_semaphore_wait(
          semaphore,
          dispatch_time(DISPATCH_TIME_NOW, kJVSAssetLoadTimeoutSec * NSEC_PER_SEC)) != 0) {
    // `cancelLoading` releases the callback, so the completion handler above
    // still fires and signals a semaphore nobody is waiting on. That is fine:
    // the block owns the only strong reference left to it.
    [asset cancelLoading];
    JVSLog(@"timed out after %llds loading asset keys %@",
           kJVSAssetLoadTimeoutSec, [keys componentsJoinedByString:@", "]);
    if (error != nil) {
      *error = [NSError errorWithDomain:@"ClipStitcher"
                                   code:2
                               userInfo:@{
                                 NSLocalizedDescriptionKey : [NSString
                                     stringWithFormat:@"Timed out loading asset keys after %llds",
                                                      kJVSAssetLoadTimeoutSec]
                               }];
    }
    return NO;
  }

  for (NSString *key in keys) {
    NSError *keyError = nil;
    AVKeyValueStatus status = [asset statusOfValueForKey:key error:&keyError];
    if (status != AVKeyValueStatusLoaded) {
      if (error != nil) {
        *error = keyError ?: [NSError errorWithDomain:@"ClipStitcher"
                                             code:1
                                         userInfo:@{
                                           NSLocalizedDescriptionKey :
                                               [NSString stringWithFormat:
                                                   @"Failed to load asset key '%@'", key]
                                         }];
      }
      return NO;
    }
  }

  return YES;
}

@interface ClipStitcher : NSObject <RCTBridgeModule>
@end

@implementation ClipStitcher

RCT_EXPORT_MODULE();

+ (BOOL)requiresMainQueueSetup
{
  return NO;
}

/**
 * `trimEndSec` drops that many seconds off the END of the last segment.
 *
 * Wake-word detection reads a segment only after it has been written, so the
 * clip would otherwise run past the trigger word by a variable amount — up to
 * a whole segment plus recognition time. The caller knows where the word
 * finished and asks for the remainder to be cut here, where the composition
 * time ranges are built, so no re-encode or second pass is involved.
 */
RCT_EXPORT_METHOD(stitch:(NSArray<NSString *> *)segmentPaths
                  outputPath:(NSString *)outputPath
                  trimEndSec:(double)trimEndSec
                  resolver:(RCTPromiseResolveBlock)resolve
                  rejecter:(RCTPromiseRejectBlock)reject)
{
  dispatch_async(dispatch_get_global_queue(QOS_CLASS_USER_INITIATED, 0), ^{
    if (segmentPaths.count == 0) {
      reject(@"empty", @"No segments to stitch", nil);
      return;
    }

    AVMutableComposition *composition = [AVMutableComposition composition];
    // Tracks are created lazily, on the first segment that actually carries
    // one. Glasses clips are routinely video-only (the toolkit exposes no
    // microphone, so audio depends on the phone-side engine having captured
    // anything), so this is the normal path, not an edge case.
    AVMutableCompositionTrack *videoTrack = nil;
    AVMutableCompositionTrack *audioTrack = nil;

    CMTime cursor = kCMTimeZero;
    NSUInteger srcAudioTrackTotal = 0;   // audio tracks seen across all segments
    NSUInteger srcAudioUsableTotal = 0;  // ...of those, ones with real content
    NSUInteger skippedEmptyAudio = 0;    // ...of those, ones skipped as empty
    for (NSUInteger index = 0; index < segmentPaths.count; index++) {
      NSString *path = segmentPaths[index];
      NSURL *url = [NSURL fileURLWithPath:path];
      AVURLAsset *asset = [AVURLAsset URLAssetWithURL:url options:nil];

      NSError *loadError = nil;
      if (!JVSLoadAssetKeys(asset, @[ @"tracks", @"duration" ], &loadError)) {
        reject(@"stitch_load", loadError.localizedDescription, loadError);
        return;
      }

      NSError *error = nil;
      AVAssetTrack *srcVideo = [asset tracksWithMediaType:AVMediaTypeVideo].firstObject;

      // The video track's own end, not the asset's — `asset.duration` is the
      // LONGER of the two tracks. Audio is stamped from the host clock and
      // video from frame PTS, so a dropped frame or a late buffer leaves them
      // disagreeing by tens of milliseconds, and taking the longer of the two
      // asks for content one of them does not have. `insertTimeRange` quietly
      // supplies what exists, which lands a hole of exactly that size at the
      // segment boundary. Anchoring on video means the composition's timeline
      // is the picture's timeline, which is the only one the viewer can see.
      CMTime take = srcVideo != nil ? CMTimeRangeGetEnd(srcVideo.timeRange)
                                    : asset.duration;
      if (index == segmentPaths.count - 1 && trimEndSec > 0) {
        CMTime trimmed = CMTimeSubtract(
            take, CMTimeMakeWithSeconds(trimEndSec, take.timescale));
        // A trim that would swallow the whole segment is a bug upstream, not
        // an instruction to emit a zero-length tail: keep the segment intact
        // and let the clip be a little long rather than truncated wrong.
        if (CMTimeCompare(trimmed, kCMTimeZero) > 0) {
          JVSLog(@"trimming %.3fs off %@ (%.3fs -> %.3fs)", trimEndSec,
                 path.lastPathComponent, CMTimeGetSeconds(take),
                 CMTimeGetSeconds(trimmed));
          take = trimmed;
        } else {
          JVSLog(@"ignoring trim of %.3fs: exceeds %@ duration %.3fs", trimEndSec,
                 path.lastPathComponent, CMTimeGetSeconds(take));
        }
      }
      CMTimeRange range = CMTimeRangeMake(kCMTimeZero, take);

      if (srcVideo != nil) {
        if (videoTrack == nil) {
          videoTrack = [composition addMutableTrackWithMediaType:AVMediaTypeVideo
                                               preferredTrackID:kCMPersistentTrackID_Invalid];
        }
        [videoTrack insertTimeRange:range ofTrack:srcVideo atTime:cursor error:&error];
        if (error != nil) {
          reject(@"stitch_video", error.localizedDescription, error);
          return;
        }
        videoTrack.preferredTransform = srcVideo.preferredTransform;
      }
      NSArray<AVAssetTrack *> *srcAudioTracks =
          [asset tracksWithMediaType:AVMediaTypeAudio];
      AVAssetTrack *srcAudio = srcAudioTracks.firstObject;
      srcAudioTrackTotal += srcAudioTracks.count;

      // The predicate is "has content", not "is non-nil". A zero-sample audio
      // track is present in the file but contributes no segments, and reading
      // it is exactly how an empty composition audio track gets created.
      if (!JVSTrackHasContent(srcAudio)) {
        if (srcAudio != nil) {
          skippedEmptyAudio += 1;
          JVSLog(@"skipping EMPTY audio track in %@ (duration=%.3fs) - "
                 @"no audio output will be created for it",
                 path.lastPathComponent,
                 CMTimeGetSeconds(srcAudio.timeRange.duration));
        } else {
          JVSLog(@"No audio track found in %@; continuing without audio.",
                 path.lastPathComponent);
        }
      } else {
        srcAudioUsableTotal += 1;
        if (audioTrack == nil) {
          audioTrack = [composition addMutableTrackWithMediaType:AVMediaTypeAudio
                                               preferredTrackID:kCMPersistentTrackID_Invalid];
        }
        // Anything the audio is short by is a hole at this boundary, and it is
        // the only remaining way the two tracks can disagree. Logged rather
        // than corrected because there are no samples to put there — the
        // number is what tells us whether it is worth correcting.
        double const audioShortfall =
            CMTimeGetSeconds(CMTimeSubtract(take, CMTimeRangeGetEnd(srcAudio.timeRange)));
        if (audioShortfall > 0.001) {
          JVSLog(@"A/V mismatch in %@: audio is %.0f ms short of video",
                 path.lastPathComponent, audioShortfall * 1000.0);
        }
        // Inserting at `cursor` keeps audio aligned when only some segments
        // carry it: the gap before it stays silent rather than shifting.
        [audioTrack insertTimeRange:range ofTrack:srcAudio atTime:cursor error:&error];
        if (error != nil) {
          reject(@"stitch_audio", error.localizedDescription, error);
          return;
        }
      }
      cursor = CMTimeAdd(cursor, take);
    }

    // Final safety net. Whatever the reason a track ended up with no segments,
    // it must not reach the reader/writer pipeline. Removing the track here
    // deletes that code path rather than defending against it.
    for (AVMutableCompositionTrack *track in [composition.tracks copy]) {
      if (track.segments.count == 0 ||
          CMTimeCompare(track.timeRange.duration, kCMTimeZero) <= 0) {
        JVSLog(@"removing EMPTY %@ track from composition (segments=%lu)",
               track.mediaType, (unsigned long)track.segments.count);
        [composition removeTrack:track];
        if (track == audioTrack) {
          audioTrack = nil;
        } else if (track == videoTrack) {
          videoTrack = nil;
        }
      }
    }

    if (videoTrack == nil) {
      reject(@"stitch_empty",
             @"None of the recorded segments contained a video track.",
             nil);
      return;
    }

    NSUInteger compositionAudioTracks =
        [composition tracksWithMediaType:AVMediaTypeAudio].count;
    JVSLog(@"composed %lu segment(s): srcAudioTracks=%lu usable=%lu "
           @"skippedEmpty=%lu compositionAudioTracks=%lu audioOutputSkipped=%@ "
           @"duration=%.2fs",
           (unsigned long)segmentPaths.count,
           (unsigned long)srcAudioTrackTotal,
           (unsigned long)srcAudioUsableTotal,
           (unsigned long)skippedEmptyAudio,
           (unsigned long)compositionAudioTracks,
           compositionAudioTracks == 0 ? @"YES (video-only export)" : @"NO",
           CMTimeGetSeconds(cursor));

    NSAssert(compositionAudioTracks != 1 || audioTrack != nil,
             @"composition audio track present without a usable source");

    // Every segment leaves MWDATSegmentWriter with identical encoder settings,
    // so concatenating them needs no re-encode at all: passthrough copies the
    // exact bits the segment writer produced. The previous path decoded every
    // frame to BGRA and re-encoded it with no bitrate specified, spending a
    // whole extra generation of quality on a pure concatenation.
    //
    // The one thing passthrough cannot do is join segments whose formats
    // differ, which the SDK's ABR ladder can produce by stepping resolution
    // down mid-session. That is what the transcode below is still here for.
    [self exportPassthrough:composition
                 outputPath:outputPath
                 completion:^(BOOL ok, NSError *passthroughError) {
      if (ok) {
        JVSLog(@"passthrough export succeeded (no re-encode)");
        [self finishWithOutputPath:outputPath resolver:resolve rejecter:reject];
        return;
      }
      JVSLog(@"passthrough export unavailable (%@); falling back to transcode",
             passthroughError.localizedDescription);
      [self transcodeComposition:composition
                      outputPath:outputPath
                        resolver:resolve
                        rejecter:reject];
    }];
  });
}

/**
 * Cuts `startSec`...`endSec` out of a single recording, without re-encoding.
 *
 * This is the counterpart to `stitch` for footage the phone did not record.
 * A recording the glasses made themselves arrives whole — minutes of HEVC at
 * 1520x2032 in HLG colour — and the moment worth keeping is a window inside
 * it. Passthrough is not an optimisation here but the entire point: decoding
 * and re-encoding would tone-map the HDR down to SDR and spend a generation of
 * quality, landing on a file no better than the Bluetooth stream this whole
 * path exists to avoid.
 *
 * The transcode fallback is kept for parity with `stitch`, but it should never
 * run for a single-source cut — there is no format change to defeat
 * passthrough. If it ever does, the log line below is the thing to notice,
 * because the clip that comes out of it will have lost its colour.
 */
RCT_EXPORT_METHOD(extractRange:(NSString *)sourcePath
                  startSec:(double)startSec
                  endSec:(double)endSec
                  outputPath:(NSString *)outputPath
                  resolver:(RCTPromiseResolveBlock)resolve
                  rejecter:(RCTPromiseRejectBlock)reject)
{
  dispatch_async(dispatch_get_global_queue(QOS_CLASS_USER_INITIATED, 0), ^{
    if (![[NSFileManager defaultManager] fileExistsAtPath:sourcePath]) {
      reject(@"source_missing", @"That recording is no longer on disk.", nil);
      return;
    }

    AVURLAsset *asset =
        [AVURLAsset URLAssetWithURL:[NSURL fileURLWithPath:sourcePath] options:nil];
    NSError *loadError = nil;
    if (!JVSLoadAssetKeys(asset, @[ @"tracks", @"duration" ], &loadError)) {
      reject(@"source_load", loadError.localizedDescription, loadError);
      return;
    }

    double const sourceSec = CMTimeGetSeconds(asset.duration);
    double const clampedStart = MAX(0.0, MIN(startSec, sourceSec));
    double const clampedEnd = MAX(clampedStart, MIN(endSec, sourceSec));
    if (clampedEnd - clampedStart <= 0.0) {
      reject(@"empty_range",
             [NSString stringWithFormat:
                 @"Nothing to cut: %.2f-%.2f in a %.2fs recording.",
                 startSec, endSec, sourceSec],
             nil);
      return;
    }

    CMTimeRange const range = CMTimeRangeMake(
        CMTimeMakeWithSeconds(clampedStart, 600),
        CMTimeMakeWithSeconds(clampedEnd - clampedStart, 600));

    AVMutableComposition *composition = [AVMutableComposition composition];
    AVAssetTrack *srcVideo =
        [asset tracksWithMediaType:AVMediaTypeVideo].firstObject;
    if (!JVSTrackHasContent(srcVideo)) {
      reject(@"no_video", @"That recording has no video track.", nil);
      return;
    }

    AVMutableCompositionTrack *videoTrack =
        [composition addMutableTrackWithMediaType:AVMediaTypeVideo
                                 preferredTrackID:kCMPersistentTrackID_Invalid];
    NSError *insertError = nil;
    if (![videoTrack insertTimeRange:range
                             ofTrack:srcVideo
                              atTime:kCMTimeZero
                               error:&insertError]) {
      reject(@"insert_failed", insertError.localizedDescription, insertError);
      return;
    }
    // Carried over rather than assumed upright: the glasses write 1520x2032
    // with an identity transform, but nothing guarantees every model does.
    videoTrack.preferredTransform = srcVideo.preferredTransform;

    AVAssetTrack *srcAudio =
        [asset tracksWithMediaType:AVMediaTypeAudio].firstObject;
    if (JVSTrackHasContent(srcAudio)) {
      AVMutableCompositionTrack *audioTrack =
          [composition addMutableTrackWithMediaType:AVMediaTypeAudio
                                   preferredTrackID:kCMPersistentTrackID_Invalid];
      if (![audioTrack insertTimeRange:range
                               ofTrack:srcAudio
                                atTime:kCMTimeZero
                                 error:&insertError]) {
        // Audio is worth losing to keep the moment; video is not.
        JVSLog(@"audio insert failed (%@) - cutting video only",
               insertError.localizedDescription);
        [composition removeTrack:audioTrack];
      }
    }

    JVSLog(@"extracting %.2f-%.2fs from a %.2fs recording", clampedStart,
           clampedEnd, sourceSec);

    [self exportPassthrough:composition
                 outputPath:outputPath
                 completion:^(BOOL ok, NSError *passthroughError) {
      if (ok) {
        [self finishWithOutputPath:outputPath resolver:resolve rejecter:reject];
        return;
      }
      JVSLog(@"PASSTHROUGH FAILED for a single-source cut (%@) - transcoding, "
             @"which will flatten HDR",
             passthroughError.localizedDescription);
      [self transcodeComposition:composition
                      outputPath:outputPath
                        resolver:resolve
                        rejecter:reject];
    }];
  });
}

/**
 * Copies the composition to `outputPath` without touching the encoded samples.
 * Reports failure rather than rejecting, so the caller can fall back.
 */
- (void)exportPassthrough:(AVComposition *)composition
               outputPath:(NSString *)outputPath
               completion:(void (^)(BOOL ok, NSError *error))completion
{
  [[NSFileManager defaultManager] removeItemAtPath:outputPath error:nil];

  AVAssetExportSession *export =
      [[AVAssetExportSession alloc] initWithAsset:composition
                                       presetName:AVAssetExportPresetPassthrough];
  if (export == nil) {
    completion(NO, [NSError errorWithDomain:@"ClipStitcher"
                                       code:2
                                   userInfo:@{
                                     NSLocalizedDescriptionKey :
                                         @"Could not create a passthrough export session."
                                   }]);
    return;
  }
  export.outputURL = [NSURL fileURLWithPath:outputPath];
  export.outputFileType = AVFileTypeMPEG4;
  export.shouldOptimizeForNetworkUse = YES;

  [export exportAsynchronouslyWithCompletionHandler:^{
    if (export.status == AVAssetExportSessionStatusCompleted) {
      completion(YES, nil);
      return;
    }
    // A half-written file would otherwise be handed to the caller as a
    // finished clip, or mistaken for the fallback's output.
    [[NSFileManager defaultManager] removeItemAtPath:outputPath error:nil];
    completion(NO, export.error);
  }];
}

/**
 * Fallback for compositions passthrough cannot serve: decodes and re-encodes.
 * Costs a generation of quality, so it must stay the exception.
 */
- (void)transcodeComposition:(AVComposition *)composition
                  outputPath:(NSString *)outputPath
                    resolver:(RCTPromiseResolveBlock)resolve
                    rejecter:(RCTPromiseRejectBlock)reject
{
  dispatch_async(dispatch_get_global_queue(QOS_CLASS_USER_INITIATED, 0), ^{
    NSError *readerLoadError = nil;
    AVAsset *readerAsset = composition;
    if (!JVSLoadAssetKeys(readerAsset, @[ @"tracks", @"duration" ], &readerLoadError)) {
      reject(@"reader_load", readerLoadError.localizedDescription, readerLoadError);
      return;
    }

    NSError *readerError = nil;
    AVAssetReader *reader = [[AVAssetReader alloc] initWithAsset:readerAsset error:&readerError];
    if (reader == nil) {
      reject(@"reader_failed", readerError.localizedDescription, readerError);
      return;
    }

    NSArray<AVAssetTrack *> *videoTracks = [readerAsset tracksWithMediaType:AVMediaTypeVideo];
    AVAssetTrack *readerVideoTrack = videoTracks.firstObject;
    if (readerVideoTrack == nil) {
      reject(@"missing_video_track", @"Missing video track.", nil);
      return;
    }

    AVAssetReaderTrackOutput *videoOutput = [[AVAssetReaderTrackOutput alloc]
        initWithTrack:readerVideoTrack
       outputSettings:@{
         (NSString *)kCVPixelBufferPixelFormatTypeKey : @(kCVPixelFormatType_32BGRA)
       }];
    if (![reader canAddOutput:videoOutput]) {
      reject(@"cannot_add_video_reader_output", @"Cannot add video reader output.", nil);
      return;
    }
    [reader addOutput:videoOutput];

    NSArray<AVAssetTrack *> *audioTracks = [readerAsset tracksWithMediaType:AVMediaTypeAudio];
    JVSLog(@"Reader asset audio track count: %lu", (unsigned long)audioTracks.count);
    JVSLog(@"Audio output type: AVAssetReaderTrackOutput");
    JVSLog(@"Processing as video-only: %@", audioTracks.count == 0 ? @"YES" : @"NO");

    AVAssetReaderTrackOutput *audioOutput = nil;
    if (audioTracks.firstObject != nil) {
      AVAssetTrack *readerAudioTrack = audioTracks.firstObject;
      AVAssetReaderTrackOutput *output = [[AVAssetReaderTrackOutput alloc]
          initWithTrack:readerAudioTrack
         outputSettings:@{
           AVFormatIDKey : @(kAudioFormatLinearPCM),
           AVLinearPCMIsFloatKey : @NO,
           AVLinearPCMBitDepthKey : @16,
           AVLinearPCMIsBigEndianKey : @NO,
           AVLinearPCMIsNonInterleaved : @NO,
         }];
      if (![reader canAddOutput:output]) {
        reject(@"cannot_add_audio_reader_output", @"Cannot add audio reader output.", nil);
        return;
      }
      [reader addOutput:output];
      audioOutput = output;
    } else {
      JVSLog(@"No audio track found. Continuing as video-only.");
    }

    [[NSFileManager defaultManager] removeItemAtPath:outputPath error:nil];
    NSURL *outputURL = [NSURL fileURLWithPath:outputPath];
    NSError *writerError = nil;
    AVAssetWriter *writer = [[AVAssetWriter alloc] initWithURL:outputURL
                                                      fileType:AVFileTypeMPEG4
                                                         error:&writerError];
    if (writer == nil) {
      reject(@"writer_failed", writerError.localizedDescription, writerError);
      return;
    }

    CGSize naturalSize = readerVideoTrack.naturalSize;
    CGFloat videoWidth = fabs(naturalSize.width);
    CGFloat videoHeight = fabs(naturalSize.height);
    if (videoWidth <= 0 || videoHeight <= 0) {
      videoWidth = 504;
      videoHeight = 896;
    }
    // Match MWDATSegmentWriter's 0.3 bits/pixel/frame and High profile.
    // Specifying nothing let AVFoundation pick its own conservative default,
    // which threw away most of what the segment writer had preserved.
    NSInteger bitRate = MAX(4000000, (NSInteger)(videoWidth * videoHeight * 30.0 * 0.3));
    JVSLog(@"transcode fallback: %.0fx%.0f h264-high bitRate=%ld",
           videoWidth, videoHeight, (long)bitRate);
    AVAssetWriterInput *videoWriterInput = [[AVAssetWriterInput alloc]
        initWithMediaType:AVMediaTypeVideo
           outputSettings:@{
             AVVideoCodecKey : AVVideoCodecTypeH264,
             AVVideoWidthKey : @(videoWidth),
             AVVideoHeightKey : @(videoHeight),
             AVVideoCompressionPropertiesKey : @{
               AVVideoAverageBitRateKey : @(bitRate),
               AVVideoExpectedSourceFrameRateKey : @30,
               AVVideoMaxKeyFrameIntervalKey : @30,
               AVVideoProfileLevelKey : AVVideoProfileLevelH264HighAutoLevel,
             },
           }];
    videoWriterInput.transform = readerVideoTrack.preferredTransform;
    if (![writer canAddInput:videoWriterInput]) {
      reject(@"cannot_add_video_writer_input", @"Cannot add video writer input.", nil);
      return;
    }
    [writer addInput:videoWriterInput];

    AVAssetWriterInput *audioWriterInput = nil;
    if (audioOutput != nil) {
      AVAssetWriterInput *input = [[AVAssetWriterInput alloc]
          initWithMediaType:AVMediaTypeAudio
             outputSettings:@{
               AVFormatIDKey : @(kAudioFormatMPEG4AAC),
               AVSampleRateKey : @44100,
               AVNumberOfChannelsKey : @2,
               AVEncoderBitRateKey : @128000,
             }];
      if (![writer canAddInput:input]) {
        reject(@"cannot_add_audio_writer_input", @"Cannot add audio writer input.", nil);
        return;
      }
      [writer addInput:input];
      audioWriterInput = input;
    }

    if (![writer startWriting]) {
      NSError *error = writer.error;
      reject(@"writer_failed", error.localizedDescription, error);
      return;
    }
    if (![reader startReading]) {
      NSError *error = reader.error;
      [writer cancelWriting];
      reject(@"reader_failed", error.localizedDescription, error);
      return;
    }
    [writer startSessionAtSourceTime:kCMTimeZero];

    dispatch_group_t writingGroup = dispatch_group_create();
    dispatch_queue_t videoQueue = dispatch_queue_create("com.mocinjay.clypso.clipstitcher.video", DISPATCH_QUEUE_SERIAL);
    dispatch_queue_t audioQueue = dispatch_queue_create("com.mocinjay.clypso.clipstitcher.audio", DISPATCH_QUEUE_SERIAL);
    __block BOOL didFail = NO;
    void (^failOnce)(NSString *, NSString *, NSError *) =
        ^(NSString *code, NSString *message, NSError *error) {
          @synchronized(writer) {
            if (didFail) { return; }
            didFail = YES;
            [reader cancelReading];
            [writer cancelWriting];
            reject(code, message, error);
          }
        };

    // Each input must leave the group exactly once, on every exit path
    // including cancellation. A missed leave hangs the export forever; a double
    // leave crashes. `finishOnce` makes both impossible.
    __block BOOL videoDone = NO;
    __block BOOL audioDone = NO;
    __block NSUInteger videoSamplesWritten = 0;
    __block NSUInteger audioSamplesWritten = 0;

    dispatch_group_enter(writingGroup);
    [videoWriterInput requestMediaDataWhenReadyOnQueue:videoQueue usingBlock:^{
      void (^finishOnce)(void) = ^{
        @synchronized(writer) {
          if (videoDone) { return; }
          videoDone = YES;
        }
        if (!didFail) { [videoWriterInput markAsFinished]; }
        dispatch_group_leave(writingGroup);
      };
      // Cancelled by the other track's failure: stop pulling and settle.
      if (didFail) {
        finishOnce();
        return;
      }
      while (videoWriterInput.isReadyForMoreMediaData) {
        // Each decoded frame is a full uncompressed BGRA buffer. Without a pool
        // scoped to one iteration, autoreleased temporaries pile up for the
        // whole clip and spike memory badly enough to get the app killed.
        @autoreleasepool {
          CMSampleBufferRef buffer = [videoOutput copyNextSampleBuffer];
          if (buffer == NULL) {
            finishOnce();
            return;
          }
          if (![videoWriterInput appendSampleBuffer:buffer]) {
            CFRelease(buffer);
            NSError *error = writer.error;
            finishOnce();
            failOnce(@"video_write", error.localizedDescription, error);
            return;
          }
          videoSamplesWritten += 1;
          CFRelease(buffer);
        }
      }
    }];

    // No audio output means no audio task is ever created, entered, or awaited:
    // the group holds only the video entry, so a video-only clip completes
    // rather than blocking on an audio task that does not exist.
    if (audioOutput != nil && audioWriterInput != nil) {
      dispatch_group_enter(writingGroup);
      [audioWriterInput requestMediaDataWhenReadyOnQueue:audioQueue usingBlock:^{
        void (^finishOnce)(void) = ^{
          @synchronized(writer) {
            if (audioDone) { return; }
            audioDone = YES;
          }
          if (!didFail) { [audioWriterInput markAsFinished]; }
          dispatch_group_leave(writingGroup);
        };
        if (didFail) {
          finishOnce();
          return;
        }
        while (audioWriterInput.isReadyForMoreMediaData) {
          @autoreleasepool {
            CMSampleBufferRef buffer = [audioOutput copyNextSampleBuffer];
            if (buffer == NULL) {
              finishOnce();
              return;
            }
            if (![audioWriterInput appendSampleBuffer:buffer]) {
              CFRelease(buffer);
              NSError *error = writer.error;
              finishOnce();
              failOnce(@"audio_write", error.localizedDescription, error);
              return;
            }
            audioSamplesWritten += 1;
            CFRelease(buffer);
          }
        }
      }];
    } else {
      JVSLog(@"video-only: no audio reader output and no audio writer input "
             @"were created; completion will not wait for audio");
    }

    dispatch_group_notify(writingGroup, dispatch_get_global_queue(QOS_CLASS_USER_INITIATED, 0), ^{
      @synchronized(writer) {
        if (didFail) { return; }
        didFail = YES;
      }
      if (reader.status == AVAssetReaderStatusFailed) {
        NSError *error = reader.error;
        [writer cancelWriting];
        reject(@"reader_failed", error.localizedDescription, error);
        return;
      }

      JVSLog(@"writing finished: videoSamples=%lu audioSamples=%lu",
             (unsigned long)videoSamplesWritten,
             (unsigned long)audioSamplesWritten);
      // An audio input that was added but received no samples writes an EMPTY
      // audio track into the output file - the exact shape that made the source
      // segments crash this stitcher in the first place. The composition-level
      // empty-track removal above should make this unreachable; log loudly if
      // it ever is not, so the clip is not quietly poisoned for downstream
      // readers.
      if (audioWriterInput != nil && audioSamplesWritten == 0) {
        JVSLog(@"WARNING: audio input received zero samples; output clip may "
               @"carry an empty audio track");
      }
      [writer finishWritingWithCompletionHandler:^{
        if (writer.status != AVAssetWriterStatusCompleted) {
          NSError *error = writer.error;
          reject(@"writer_failed", error.localizedDescription, error);
          return;
        }

        [self finishWithOutputPath:outputPath resolver:resolve rejecter:reject];
      }];
    });
  });
}

/// Generates the poster frame and resolves, whichever path wrote the clip.
- (void)finishWithOutputPath:(NSString *)outputPath
                    resolver:(RCTPromiseResolveBlock)resolve
                    rejecter:(RCTPromiseRejectBlock)reject
{
  NSString *thumbnailPath =
      [[outputPath stringByDeletingPathExtension] stringByAppendingString:@".jpg"];
  AVURLAsset *clipAsset =
      [AVURLAsset URLAssetWithURL:[NSURL fileURLWithPath:outputPath] options:nil];
  AVAssetImageGenerator *generator =
      [[AVAssetImageGenerator alloc] initWithAsset:clipAsset];
  generator.appliesPreferredTrackTransform = YES;
  generator.maximumSize = CGSizeMake(640, 640);

  // A missing poster frame is not worth failing a clip that was written
  // successfully over, so this still resolves. But it was resolving with a
  // thumbnailPath that named a file nothing had created, and with `error:NULL`
  // there was no record anywhere of why — the library just showed a blank
  // tile. Report the reason, and hand back a path only if there is a file at
  // the end of it.
  NSError *thumbnailError = nil;
  CGImageRef cgImage = [generator copyCGImageAtTime:CMTimeMakeWithSeconds(0.0, 600)
                                         actualTime:NULL
                                              error:&thumbnailError];
  BOOL wroteThumbnail = NO;
  if (cgImage != NULL) {
    UIImage *image = [UIImage imageWithCGImage:cgImage];
    CGImageRelease(cgImage);
    NSData *jpeg = UIImageJPEGRepresentation(image, 0.8);
    if (jpeg == nil) {
      JVSLog(@"could not encode the poster frame for %@ as JPEG",
             outputPath.lastPathComponent);
    } else {
      NSError *writeError = nil;
      wroteThumbnail = [jpeg writeToFile:thumbnailPath
                                 options:NSDataWritingAtomic
                                   error:&writeError];
      if (!wroteThumbnail) {
        JVSLog(@"could not write the thumbnail for %@ - %@",
               outputPath.lastPathComponent, writeError.localizedDescription);
      }
    }
  } else {
    JVSLog(@"could not generate a poster frame for %@ - %@",
           outputPath.lastPathComponent,
           thumbnailError.localizedDescription ?: @"no error reported");
  }

  resolve(@{
    @"outputPath" : outputPath,
    @"thumbnailPath" : wroteThumbnail ? thumbnailPath : @"",
    @"durationSec" : @(CMTimeGetSeconds(clipAsset.duration)),
  });
}

@end
