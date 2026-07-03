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
    AVMutableCompositionTrack *videoTrack =
        [composition addMutableTrackWithMediaType:AVMediaTypeVideo
                                 preferredTrackID:kCMPersistentTrackID_Invalid];
    AVMutableCompositionTrack *audioTrack =
        [composition addMutableTrackWithMediaType:AVMediaTypeAudio
                                 preferredTrackID:kCMPersistentTrackID_Invalid];

    CMTime cursor = kCMTimeZero;
    for (NSString *path in segmentPaths) {
      NSURL *url = [NSURL fileURLWithPath:path];
      AVURLAsset *asset = [AVURLAsset URLAssetWithURL:url options:nil];
      CMTimeRange range = CMTimeRangeMake(kCMTimeZero, asset.duration);

      NSError *error = nil;
      AVAssetTrack *srcVideo = [asset tracksWithMediaType:AVMediaTypeVideo].firstObject;
      if (srcVideo != nil) {
        [videoTrack insertTimeRange:range ofTrack:srcVideo atTime:cursor error:&error];
        if (error != nil) {
          reject(@"stitch_video", error.localizedDescription, error);
          return;
        }
        videoTrack.preferredTransform = srcVideo.preferredTransform;
      }
      AVAssetTrack *srcAudio = [asset tracksWithMediaType:AVMediaTypeAudio].firstObject;
      if (srcAudio != nil) {
        [audioTrack insertTimeRange:range ofTrack:srcAudio atTime:cursor error:&error];
        if (error != nil) {
          reject(@"stitch_audio", error.localizedDescription, error);
          return;
        }
      }
      cursor = CMTimeAdd(cursor, asset.duration);
    }

    [[NSFileManager defaultManager] removeItemAtPath:outputPath error:nil];
    AVAssetExportSession *export =
        [[AVAssetExportSession alloc] initWithAsset:composition
                                         presetName:AVAssetExportPresetPassthrough];
    export.outputURL = [NSURL fileURLWithPath:outputPath];
    export.outputFileType = AVFileTypeMPEG4;

    [export exportAsynchronouslyWithCompletionHandler:^{
      if (export.status != AVAssetExportSessionStatusCompleted) {
        reject(@"export",
               export.error.localizedDescription ?: @"Export failed",
               export.error);
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
