// What the caption burn does to a Path B master, measured rather than argued.
//
// Reproduces `CaptionEngine.renderEdit`'s composition and export three ways so
// the two things that could go wrong are separated from each other:
//
//   untagged+h264          what shipped before — the composite reads HLG
//                          through an sRGB transfer function and the preset
//                          cannot carry 10-bit
//   tagged+hevc            what ships now, without captions
//   tagged+hevc+captions   the same with an AVVideoCompositionCoreAnimationTool
//                          overlay, because Core Animation is SDR sRGB and it
//                          was not obvious the composition would survive it
//
// Read two columns. `transfer=` says whether the colour survived; `rate=`
// against the source says whether the picture did, which matters because
// AVAssetExportPreset* picks its own bit rate and offers no way to ask for
// another.
//
// macOS AVFoundation, not iOS, and synthetic content. It settles the API
// questions; it does not replace the on-device run in
// docs/LEECH-ARCHITECTURE.md §4a.
#import <AVFoundation/AVFoundation.h>
#import <Foundation/Foundation.h>
#import <QuartzCore/QuartzCore.h>
#import <AppKit/AppKit.h>

// Verbatim from ClipStitcher.m — regenerate with ./sync.sh.
#include "lifted.h"

static void report(const char *label, NSString *path)
{
  AVURLAsset *a = [AVURLAsset URLAssetWithURL:[NSURL fileURLWithPath:path] options:nil];
  AVAssetTrack *t = [a tracksWithMediaType:AVMediaTypeVideo].firstObject;
  if (t == nil) { printf("%-22s (no video track)\n", label); return; }
  JVSVideoColor const c = JVSReadVideoColor(t);
  CGSize s = t.naturalSize;
  printf("%-22s %.0fx%.0f %-4s %-3s transfer=%-22s rate=%6.2fMbps\n", label,
         fabs(s.width), fabs(s.height), c.isHEVC ? "hevc" : "avc",
         c.isHDR ? "HDR" : "SDR", (c.transferFunction ?: @"(none)").UTF8String,
         t.estimatedDataRate / 1000000.0);
}

static void runExport(NSString *src, NSString *out, BOOL tag, BOOL overlay,
                      NSString *preset, const char *label)
{
  AVURLAsset *asset = [AVURLAsset URLAssetWithURL:[NSURL fileURLWithPath:src] options:nil];
  AVAssetTrack *v = [asset tracksWithMediaType:AVMediaTypeVideo].firstObject;
  JVSVideoColor const color = JVSReadVideoColor(v);

  AVMutableComposition *comp = [AVMutableComposition composition];
  AVMutableCompositionTrack *ct =
      [comp addMutableTrackWithMediaType:AVMediaTypeVideo
                        preferredTrackID:kCMPersistentTrackID_Invalid];
  [ct insertTimeRange:CMTimeRangeMake(kCMTimeZero, CMTimeMakeWithSeconds(2.0, 600))
              ofTrack:v atTime:kCMTimeZero error:NULL];
  ct.preferredTransform = v.preferredTransform;

  CGSize render = v.naturalSize;
  AVMutableVideoCompositionInstruction *inst =
      [AVMutableVideoCompositionInstruction videoCompositionInstruction];
  inst.timeRange = CMTimeRangeMake(kCMTimeZero, comp.duration);
  AVMutableVideoCompositionLayerInstruction *li =
      [AVMutableVideoCompositionLayerInstruction videoCompositionLayerInstructionWithAssetTrack:ct];
  [li setTransform:v.preferredTransform atTime:kCMTimeZero];
  inst.layerInstructions = @[ li ];

  AVMutableVideoComposition *vc = [AVMutableVideoComposition videoComposition];
  vc.renderSize = render;
  vc.frameDuration = CMTimeMake(1, 30);
  vc.instructions = @[ inst ];
  if (tag && color.primaries && color.transferFunction && color.matrix) {
    vc.colorPrimaries = color.primaries;
    vc.colorTransferFunction = color.transferFunction;
    vc.colorYCbCrMatrix = color.matrix;
  }
  if (overlay) {
    CALayer *videoLayer = [CALayer layer];
    videoLayer.frame = CGRectMake(0, 0, render.width, render.height);
    CALayer *parent = [CALayer layer];
    parent.frame = videoLayer.frame;
    [parent addSublayer:videoLayer];
    CATextLayer *text = [CATextLayer layer];
    text.string = @"CLYPSO";
    text.fontSize = 120;
    text.foregroundColor = CGColorGetConstantColor(kCGColorWhite);
    text.alignmentMode = kCAAlignmentCenter;
    text.frame = CGRectMake(0, render.height * 0.15, render.width, 200);
    [parent addSublayer:text];
    vc.animationTool = [AVVideoCompositionCoreAnimationTool
        videoCompositionCoreAnimationToolWithPostProcessingAsVideoLayer:videoLayer
                                                                inLayer:parent];
  }

  [[NSFileManager defaultManager] removeItemAtPath:out error:NULL];
  AVAssetExportSession *ex =
      [[AVAssetExportSession alloc] initWithAsset:comp presetName:preset];
  ex.outputURL = [NSURL fileURLWithPath:out];
  ex.outputFileType = AVFileTypeMPEG4;
  ex.videoComposition = vc;
  dispatch_semaphore_t d = dispatch_semaphore_create(0);
  [ex exportAsynchronouslyWithCompletionHandler:^{ dispatch_semaphore_signal(d); }];
  dispatch_semaphore_wait(d, dispatch_time(DISPATCH_TIME_NOW, 300 * NSEC_PER_SEC));
  if (ex.status != AVAssetExportSessionStatusCompleted) {
    printf("%-22s EXPORT FAILED: %s\n", label,
           ex.error.localizedDescription.UTF8String ?: "unknown");
    return;
  }
  report(label, out);
}

int main(int argc, const char *argv[])
{
  @autoreleasepool {
    NSString *src = @(argv[1]);
    report("SOURCE", src);
    runExport(src, @"/tmp/b_untagged_h264.mp4", NO,  NO,  AVAssetExportPresetHighestQuality,     "untagged+h264 (old)");
    runExport(src, @"/tmp/b_tagged_hevc.mp4",   YES, NO,  AVAssetExportPresetHEVCHighestQuality, "tagged+hevc (new)");
    runExport(src, @"/tmp/b_tagged_overlay.mp4",YES, YES, AVAssetExportPresetHEVCHighestQuality, "tagged+hevc+captions");
  }
  return 0;
}
