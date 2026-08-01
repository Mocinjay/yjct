#import <AVFoundation/AVFoundation.h>
#import <React/RCTBridgeModule.h>
#import <UIKit/UIKit.h>

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
      AVAssetTrack *srcAudio = [asset tracksWithMediaType:AVMediaTypeAudio].firstObject;
      if (srcAudio != nil) {
        if (audioTrack == nil) {
          audioTrack = [composition addMutableTrackWithMediaType:AVMediaTypeAudio
                                               preferredTrackID:kCMPersistentTrackID_Invalid];
        }
        // Inserting at `cursor` keeps audio aligned when only some segments
        // carry it — the gap before it stays silent rather than shifting.
        [audioTrack insertTimeRange:range ofTrack:srcAudio atTime:cursor error:&error];
        if (error != nil) {
          reject(@"stitch_audio", error.localizedDescription, error);
          return;
        }
      }
      cursor = CMTimeAdd(cursor, asset.duration);
    }

    if (videoTrack == nil) {
      reject(@"stitch_empty",
             @"None of the recorded segments contained a video track.",
             nil);
      return;
    }
    NSLog(@"[ClipStitcher] composed %lu segment(s) — video=YES audio=%@ duration=%.2fs",
          (unsigned long)segmentPaths.count,
          audioTrack != nil ? @"YES" : @"NO",
          CMTimeGetSeconds(cursor));

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
