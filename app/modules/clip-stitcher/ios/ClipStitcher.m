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
/// track contributes nothing, and the resulting empty composition track is what
/// trips the AVAssetReaderAudioMixOutput assertion.
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

@interface ClipStitcher : NSObject <RCTBridgeModule>
@end

@implementation ClipStitcher

RCT_EXPORT_MODULE();

+ (BOOL)requiresMainQueueSetup
{
  return NO;
}

RCT_EXPORT_METHOD(stitch:(NSArray<NSString *> *)segmentPaths
                  outputPath:(NSString *)outputPath
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
    // one. A composition track that is added but never written leaves an EMPTY
    // track in the asset, and AVAssetExportSession then builds its reader over
    // it — constructing an AVAssetReaderAudioMixOutput with zero audio tracks,
    // which trips the assertion "[audioTracks count] >= 1" and aborts the
    // process. Glasses clips are routinely video-only (the toolkit exposes no
    // microphone, so audio depends on the phone-side engine having captured
    // anything), so this is the normal path, not an edge case.
    AVMutableCompositionTrack *videoTrack = nil;
    AVMutableCompositionTrack *audioTrack = nil;

    CMTime cursor = kCMTimeZero;
    NSUInteger srcAudioTrackTotal = 0;   // audio tracks seen across all segments
    NSUInteger srcAudioUsableTotal = 0;  // ...of those, ones with real content
    NSUInteger skippedEmptyAudio = 0;    // ...of those, ones skipped as empty
    for (NSString *path in segmentPaths) {
      NSURL *url = [NSURL fileURLWithPath:path];
      AVURLAsset *asset = [AVURLAsset URLAssetWithURL:url options:nil];
      CMTimeRange range = CMTimeRangeMake(kCMTimeZero, asset.duration);

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
        }
      } else {
        srcAudioUsableTotal += 1;
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
      cursor = CMTimeAdd(cursor, asset.duration);
    }

    // Final safety net. Whatever the reason a track ended up with no segments,
    // it must not reach AVAssetExportSession: the export builds a reader over
    // every track in the asset, and an empty audio track means constructing an
    // AVAssetReaderAudioMixOutput over zero tracks, which is not a catchable
    // error but an assertion that aborts the process. Removing the track here
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

    [[NSFileManager defaultManager] removeItemAtPath:outputPath error:nil];
    AVAssetExportSession *export =
        [[AVAssetExportSession alloc] initWithAsset:composition
                                         presetName:AVAssetExportPresetPassthrough];
    export.outputURL = [NSURL fileURLWithPath:outputPath];
    export.outputFileType = AVFileTypeMPEG4;

    [export exportAsynchronouslyWithCompletionHandler:^{
      if (export.status != AVAssetExportSessionStatusCompleted) {
        NSError *error = export.error;
        NSLog(@"[ClipStitcher] export FAILED status=%ld domain=%@ code=%ld desc=%@ underlying=%@",
              (long)export.status, error.domain, (long)error.code,
              error.localizedDescription, error.userInfo[NSUnderlyingErrorKey]);
        NSString *detail =
            error != nil
                ? [NSString stringWithFormat:@"%@ [%@ %ld]", error.localizedDescription,
                                             error.domain, (long)error.code]
                : @"Export failed";
        reject(@"export", detail, error);
        return;
      }

      NSString *thumbnailPath =
          [[outputPath stringByDeletingPathExtension] stringByAppendingString:@".jpg"];
      AVURLAsset *clipAsset =
          [AVURLAsset URLAssetWithURL:[NSURL fileURLWithPath:outputPath] options:nil];
      AVAssetImageGenerator *generator =
          [[AVAssetImageGenerator alloc] initWithAsset:clipAsset];
      generator.appliesPreferredTrackTransform = YES;
      generator.maximumSize = CGSizeMake(640, 640);

      CGImageRef cgImage =
          [generator copyCGImageAtTime:CMTimeMakeWithSeconds(0.0, 600)
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
    }];
  });
}

@end
