#import <AVFoundation/AVFoundation.h>
#import <React/RCTBridgeModule.h>
#import <UIKit/UIKit.h>

#import "CSDiagnostics.h"

// Also written to the diagnostics file: whether a clip was cut by passthrough
// or re-encoded is the quality question, and it is asked of a device in a
// pocket with no console attached.
#define JVSLog(fmt, ...) CSLog(@"ClipStitcher", fmt, ##__VA_ARGS__)

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

static BOOL JVSLoadAssetKeys(AVAsset *asset, NSArray<NSString *> *keys, NSError **error)
{
  dispatch_semaphore_t semaphore = dispatch_semaphore_create(0);
  [asset loadValuesAsynchronouslyForKeys:keys completionHandler:^{
    dispatch_semaphore_signal(semaphore);
  }];
  dispatch_semaphore_wait(semaphore, DISPATCH_TIME_FOREVER);

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

/**
 * What the container says about a video track's codec and colour. A segment
 * from the live stream is the glasses' HEVC in BT.709; a recording imported
 * from the photo library is 10-bit HEVC in BT.2020 with an HLG transfer
 * function. Only the format description tells them apart.
 *
 * The strings are `__unsafe_unretained` because a value-returned C struct
 * cannot own them under ARC. They belong to the track's format description,
 * so a struct must not outlive the asset it was read from.
 */
typedef struct {
  BOOL isHDR;
  BOOL isHEVC;
  NSString *__unsafe_unretained transferFunction;
} JVSVideoColor;

static JVSVideoColor JVSReadVideoColor(AVAssetTrack *track)
{
  JVSVideoColor info = {NO, NO, nil};
  CMFormatDescriptionRef description =
      (__bridge CMFormatDescriptionRef)track.formatDescriptions.firstObject;
  if (description == NULL) {
    return info;
  }
  info.isHEVC = CMFormatDescriptionGetMediaSubType(description) == kCMVideoCodecType_HEVC;
  info.transferFunction = (__bridge NSString *)CMFormatDescriptionGetExtension(
      description, kCMFormatDescriptionExtension_TransferFunction);
  NSString *const hlg =
      (__bridge NSString *)kCMFormatDescriptionTransferFunction_ITU_R_2100_HLG;
  NSString *const pq =
      (__bridge NSString *)kCMFormatDescriptionTransferFunction_SMPTE_ST_2084_PQ;
  info.isHDR = info.transferFunction != nil &&
               ([info.transferFunction isEqualToString:hlg] ||
                [info.transferFunction isEqualToString:pq]);
  return info;
}

/// One line describing a written clip: size, codec, colour and bit rate.
static NSString *JVSDescribeClip(NSString *path)
{
  AVURLAsset *asset = [AVURLAsset URLAssetWithURL:[NSURL fileURLWithPath:path] options:nil];
  if (!JVSLoadAssetKeys(asset, @[ @"tracks" ], NULL)) {
    return @"(unreadable)";
  }
  AVAssetTrack *video = [asset tracksWithMediaType:AVMediaTypeVideo].firstObject;
  if (video == nil) {
    return @"(no video track)";
  }
  JVSVideoColor const color = JVSReadVideoColor(video);
  CGSize const size = video.naturalSize;
  unsigned long long const bytes =
      [[[NSFileManager defaultManager] attributesOfItemAtPath:path error:NULL] fileSize];
  return [NSString stringWithFormat:@"%.0fx%.0f %@ %@ transfer=%@ rate=%.2fMbps %llu bytes",
                                    fabs(size.width), fabs(size.height),
                                    color.isHEVC ? @"hevc" : @"avc",
                                    color.isHDR ? @"HDR" : @"SDR",
                                    color.transferFunction ?: @"(untagged)",
                                    video.estimatedDataRate / 1000000.0, bytes];
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
    for (NSUInteger index = 0; index < segmentPaths.count; index++) {
      NSString *path = segmentPaths[index];
      NSURL *url = [NSURL fileURLWithPath:path];
      AVURLAsset *asset = [AVURLAsset URLAssetWithURL:url options:nil];

      NSError *loadError = nil;
      if (!JVSLoadAssetKeys(asset, @[ @"tracks", @"duration" ], &loadError)) {
        reject(@"stitch_load", loadError.localizedDescription, loadError);
        return;
      }

      CMTime take = asset.duration;
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

      NSError *error = nil;
      AVAssetTrack *srcVideo = [asset tracksWithMediaType:AVMediaTypeVideo].firstObject;
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
      AVAssetTrack *srcAudio = [asset tracksWithMediaType:AVMediaTypeAudio].firstObject;

      // The predicate is "has content", not "is non-nil". A zero-sample audio
      // track is present in the file but contributes no segments, and reading
      // it is exactly how an empty composition audio track gets created.
      if (!JVSTrackHasContent(srcAudio)) {
        if (srcAudio != nil) {
          JVSLog(@"skipping EMPTY audio track in %@ (duration=%.3fs) - "
                 @"no audio output will be created for it",
                 path.lastPathComponent,
                 CMTimeGetSeconds(srcAudio.timeRange.duration));
        } else {
          JVSLog(@"No audio track found in %@; continuing without audio.",
                 path.lastPathComponent);
        }
      } else {
        if (audioTrack == nil) {
          audioTrack = [composition addMutableTrackWithMediaType:AVMediaTypeAudio
                                               preferredTrackID:kCMPersistentTrackID_Invalid];
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

    JVSLog(@"composed %lu segment(s): audio=%@ duration=%.2fs",
           (unsigned long)segmentPaths.count, audioTrack != nil ? @"YES" : @"NO",
           CMTimeGetSeconds(cursor));

    // Segments are the glasses' own HEVC, written as-is by MWDATSegmentWriter,
    // and each one starts on a keyframe, so passthrough concatenates them with
    // no re-encode and no quality loss. It cannot join segments whose formats
    // differ (the SDK's ABR ladder can step resolution down mid-session); only
    // then does the transcode fallback run.
    [self exportComposition:composition
                     preset:AVAssetExportPresetPassthrough
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
 * Cuts `startSec`...`endSec` out of one recording, without re-encoding.
 *
 * The counterpart to `stitch` for footage the phone did not record: a
 * recording the glasses made themselves arrives whole (minutes of 1520x2032
 * HEVC in HLG colour) and the moment worth keeping is a window inside it.
 * Passthrough is the point, not an optimisation: re-encoding would spend a
 * generation of quality on the one file worth protecting.
 *
 * Passthrough cuts on the nearest sync samples, so the cut can start up to one
 * keyframe interval early; it never loses footage inside the window. Should it
 * fail, the HEVC preset is tried next, which keeps 10-bit HLG, and only then
 * the H.264 transcode, which flattens HDR. The log says which one ran.
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
             [NSString stringWithFormat:@"Nothing to cut: %.2f-%.2f in a %.2fs recording.",
                                        startSec, endSec, sourceSec],
             nil);
      return;
    }
    CMTimeRange const range =
        CMTimeRangeMake(CMTimeMakeWithSeconds(clampedStart, 600),
                        CMTimeMakeWithSeconds(clampedEnd - clampedStart, 600));

    AVAssetTrack *srcVideo = [asset tracksWithMediaType:AVMediaTypeVideo].firstObject;
    if (!JVSTrackHasContent(srcVideo)) {
      reject(@"no_video", @"That recording has no video track.", nil);
      return;
    }
    AVMutableComposition *composition = [AVMutableComposition composition];
    AVMutableCompositionTrack *videoTrack =
        [composition addMutableTrackWithMediaType:AVMediaTypeVideo
                                 preferredTrackID:kCMPersistentTrackID_Invalid];
    NSError *insertError = nil;
    if (![videoTrack insertTimeRange:range ofTrack:srcVideo atTime:kCMTimeZero error:&insertError]) {
      reject(@"insert_failed", insertError.localizedDescription, insertError);
      return;
    }
    // Carried over rather than assumed upright: the glasses write an identity
    // transform, but nothing guarantees every model does.
    videoTrack.preferredTransform = srcVideo.preferredTransform;

    AVAssetTrack *srcAudio = [asset tracksWithMediaType:AVMediaTypeAudio].firstObject;
    if (JVSTrackHasContent(srcAudio)) {
      AVMutableCompositionTrack *audioTrack =
          [composition addMutableTrackWithMediaType:AVMediaTypeAudio
                                   preferredTrackID:kCMPersistentTrackID_Invalid];
      if (![audioTrack insertTimeRange:range ofTrack:srcAudio atTime:kCMTimeZero error:&insertError]) {
        // Audio is worth losing to keep the moment; video is not.
        JVSLog(@"audio insert failed (%@) - cutting video only",
               insertError.localizedDescription);
        [composition removeTrack:audioTrack];
      }
    }

    JVSVideoColor const sourceColor = JVSReadVideoColor(srcVideo);
    CGSize const sourceSize = srcVideo.naturalSize;
    JVSLog(@"extracting %.2f-%.2fs from a %.2fs recording: %.0fx%.0f %@ %@ transfer=%@",
           clampedStart, clampedEnd, sourceSec, fabs(sourceSize.width),
           fabs(sourceSize.height), sourceColor.isHEVC ? @"hevc" : @"avc",
           sourceColor.isHDR ? @"HDR" : @"SDR",
           sourceColor.transferFunction ?: @"(untagged)");

    void (^finish)(NSString *) = ^(NSString *how) {
      JVSLog(@"cut by %@ - WROTE %@: %@", how, outputPath.lastPathComponent,
             JVSDescribeClip(outputPath));
      [self finishWithOutputPath:outputPath resolver:resolve rejecter:reject];
    };
    [self exportComposition:composition
                     preset:AVAssetExportPresetPassthrough
                 outputPath:outputPath
                 completion:^(BOOL ok, NSError *passthroughError) {
      if (ok) {
        finish(@"passthrough");
        return;
      }
      JVSLog(@"PASSTHROUGH FAILED for a single-source cut (%@) - trying the HEVC preset",
             passthroughError.localizedDescription);
      [self exportComposition:composition
                       preset:AVAssetExportPresetHEVCHighestQuality
                   outputPath:outputPath
                   completion:^(BOOL hevcOk, NSError *hevcError) {
        if (hevcOk) {
          finish(@"HEVC re-encode");
          return;
        }
        JVSLog(@"HEVC preset failed too (%@) - transcoding to H.264, which flattens HDR",
               hevcError.localizedDescription);
        [self transcodeComposition:composition
                        outputPath:outputPath
                          resolver:resolve
                          rejecter:reject];
      }];
    }];
  });
}

/**
 * Exports the composition with one preset (passthrough copies the encoded
 * samples untouched). Reports failure rather than rejecting, so the caller can
 * fall back.
 */
- (void)exportComposition:(AVComposition *)composition
                   preset:(NSString *)preset
               outputPath:(NSString *)outputPath
               completion:(void (^)(BOOL ok, NSError *error))completion
{
  [[NSFileManager defaultManager] removeItemAtPath:outputPath error:nil];

  AVAssetExportSession *export =
      [[AVAssetExportSession alloc] initWithAsset:composition presetName:preset];
  if (export == nil) {
    completion(NO, [NSError errorWithDomain:@"ClipStitcher"
                                       code:2
                                   userInfo:@{
                                     NSLocalizedDescriptionKey : [NSString
                                         stringWithFormat:@"Could not create a %@ export session.",
                                                          preset]
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
    // Match MWDATSegmentWriter's 0.3 bits/pixel/frame and High profile; left
    // unset, AVFoundation picks a far lower default bitrate.
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
            // Fail first: settling first could let the group's notify run
            // before `didFail` is set and finish a writer that has failed.
            failOnce(@"video_write", error.localizedDescription, error);
            finishOnce();
            return;
          }
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
              failOnce(@"audio_write", error.localizedDescription, error);
              finishOnce();
              return;
            }
            CFRelease(buffer);
          }
        }
      }];
    }

    dispatch_group_notify(writingGroup, dispatch_get_global_queue(QOS_CLASS_USER_INITIATED, 0), ^{
      // Claim the outcome: once `didFail` is set here, a late failOnce is a
      // no-op, so the promise settles exactly once.
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

  CGImageRef cgImage = [generator copyCGImageAtTime:CMTimeMakeWithSeconds(0.0, 600)
                                         actualTime:NULL
                                              error:NULL];
  if (cgImage != NULL) {
    UIImage *image = [UIImage imageWithCGImage:cgImage];
    CGImageRelease(cgImage);
    [UIImageJPEGRepresentation(image, 0.8) writeToFile:thumbnailPath atomically:YES];
  }

  resolve(@{
    @"outputPath" : outputPath,
    @"thumbnailPath" : thumbnailPath,
    @"durationSec" : @(CMTimeGetSeconds(clipAsset.duration)),
  });
}

@end
