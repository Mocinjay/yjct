//
// canvas_probe — answers, locally and deterministically, the two questions the
// 1080x1920 canvas-promotion hypothesis rests on that do NOT require a
// platform upload:
//
//   * `guard`  — what dimensions CEPromotedRenderSize actually sees, for a
//                rotated asset and for a stitched mixed-resolution asset.
//   * `render` — the caption burn itself, at a chosen renderSize, using the
//                same composition/transform/layer math and the same export
//                preset as CaptionEngine.renderEdit.
//   * `still`  — the same caption layout rasterised at N-times supersampling
//                and box-downsampled, i.e. the reference an ideal (vector)
//                rasteriser would have produced at that geometry.
//
// This is a macOS host tool. UIKit is not available, so UIFont/UIColor become
// NSFont/NSColor; every geometry decision below is copied line for line from
// app/modules/clip-stitcher/ios/CaptionEngine.m. Divergences are marked HOST.
//
// clang -fobjc-arc -framework Foundation -framework AVFoundation \
//   -framework CoreMedia -framework QuartzCore -framework AppKit \
//   -framework CoreText -framework CoreGraphics -O2 \
//   -o canvas_probe canvas_probe.m

#import <AVFoundation/AVFoundation.h>
#import <AppKit/AppKit.h>
#import <CoreText/CoreText.h>
#import <QuartzCore/QuartzCore.h>
#import <mach/mach.h>
#import <pthread.h>

#define PLog(fmt, ...) fprintf(stdout, fmt "\n", ##__VA_ARGS__)

// ---------------------------------------------------------------------------
// Promotion guard — a verbatim copy of CEPromotedRenderSize's constants and
// control flow, with the flag forced by the caller instead of read from a
// compile-time constant. Keeping the copy verbatim is the point: if the two
// ever drift, this tool stops describing the shipping code.
// ---------------------------------------------------------------------------

static CGFloat const CECanvasPromotionWidth = 1080.0;
static CGFloat const CECanvasPromotionHeight = 1920.0;
static CGFloat const CECanvasPromotionMaxWidth = 720.0;
static CGFloat const CECanvasPromotionMaxHeight = 1280.0;
static CGFloat const CECanvasPromotionMinWidth = 720.0;
static CGFloat const CECanvasPromotionMinHeight = 1280.0;
static CGFloat const CECanvasPromotionAspectTolerance = 0.01;
static CGFloat const CECanvasPromotionNearMiss = 0.05;

/// Verbatim from CaptionEngine.m. Frame dimensions are counts of samples, and
/// both size guards compare against an exact boundary, so a size left at
/// 719.99999999992 by a transform decides them the wrong way round.
static CGSize CEPixelSize(CGSize size)
{
  return CGSizeMake(round(fabs(size.width)), round(fabs(size.height)));
}

/// Verbatim from CaptionEngine.m. The track header can be truthful about the
/// first frame and silent about the rest: a stitch across an ABR resolution
/// change carries two sample descriptions and a header describing only the
/// first. Every format description is consulted, and the minimum on each axis
/// returned. CGSizeZero on anything unreadable, which the caller refuses.
static CGSize CESmallestCodedSize(AVAssetTrack *track, CGAffineTransform transform)
{
  NSArray *descriptions = track.formatDescriptions;
  if (descriptions.count == 0) {
    return CGSizeZero;
  }
  CGSize smallest = CGSizeZero;
  for (id description in descriptions) {
    CMFormatDescriptionRef format = (__bridge CMFormatDescriptionRef)description;
    if (CMFormatDescriptionGetMediaType(format) != kCMMediaType_Video) {
      continue;
    }
    CMVideoDimensions coded = CMVideoFormatDescriptionGetDimensions(format);
    if (coded.width < 1 || coded.height < 1) {
      return CGSizeZero;
    }
    CGSize shown = CEPixelSize(
        CGSizeApplyAffineTransform(CGSizeMake(coded.width, coded.height), transform));
    if (smallest.width < 1 || shown.width < smallest.width) {
      smallest.width = shown.width;
    }
    if (smallest.height < 1 || shown.height < smallest.height) {
      smallest.height = shown.height;
    }
  }
  return smallest;
}

typedef struct {
  CGSize render;
  const char *verdict;
} CEPromotion;

static CEPromotion CEPromotedRenderSizeExplained(CGSize source, CGSize smallest,
                                                 BOOL enabled)
{
  CEPromotion out = {source, "unchanged"};
  if (source.width < 1 || source.height < 1) {
    out.verdict = "refused: degenerate size";
    return out;
  }
  if (source.width > CECanvasPromotionMaxWidth ||
      source.height > CECanvasPromotionMaxHeight) {
    out.verdict = "refused by guard 1 (larger than the proxy -> Path B)";
    return out;
  }
  if (source.width >= CECanvasPromotionWidth ||
      source.height >= CECanvasPromotionHeight) {
    out.verdict = "refused by guard 2 (would not be an upscale)";
    return out;
  }
  CGFloat const sourceAspect = source.width / source.height;
  CGFloat const canvasAspect = CECanvasPromotionWidth / CECanvasPromotionHeight;
  CGFloat const drift = fabs(sourceAspect - canvasAspect) / canvasAspect;
  if (drift > CECanvasPromotionAspectTolerance) {
    out.verdict = drift <= CECanvasPromotionNearMiss
                      ? "refused by guard 3 (NEAR MISS - warns)"
                      : "refused by guard 3 (aspect ratio)";
    return out;
  }
  if (smallest.width < CECanvasPromotionMinWidth ||
      smallest.height < CECanvasPromotionMinHeight) {
    out.verdict = "refused by guard 4 (a sample is smaller than the floor)";
    return out;
  }
  if (!enabled) {
    out.verdict = "PASSES all four guards; held only by CECanvasPromotionEnabled=NO";
    return out;
  }
  out.render = CGSizeMake(CECanvasPromotionWidth, CECanvasPromotionHeight);
  out.verdict = "PROMOTED";
  return out;
}

// ---------------------------------------------------------------------------
// Peak footprint sampler
// ---------------------------------------------------------------------------

static volatile uint64_t gPeakFootprint = 0;
static volatile BOOL gSampling = NO;

static uint64_t CurrentFootprint(void)
{
  task_vm_info_data_t info;
  mach_msg_type_number_t count = TASK_VM_INFO_COUNT;
  if (task_info(mach_task_self(), TASK_VM_INFO, (task_info_t)&info, &count) != KERN_SUCCESS) {
    return 0;
  }
  return (uint64_t)info.phys_footprint;
}

static void *SampleFootprint(void *unused)
{
  (void)unused;
  while (gSampling) {
    uint64_t now = CurrentFootprint();
    if (now > gPeakFootprint) {
      gPeakFootprint = now;
    }
    usleep(15000);
  }
  return NULL;
}

// ---------------------------------------------------------------------------
// Caption style + layout — copied from CaptionEngine.m / CECaptionStyle.m,
// with UIFont/UIColor swapped for their AppKit equivalents.
// ---------------------------------------------------------------------------

static double const kCEFadeInSeconds = 0.06;
static double const kCEFadeOutSeconds = 0.04;

// HOST: UIFont.lineHeight is documented as ascender - descender + leading.
// NSFont exposes the three parts but not the sum.
static double CEFontLineHeight(NSFont *font)
{
  return font.ascender - font.descender + font.leading;
}

static NSDictionary *CETextAttributes(NSFont *font, NSColor *color, double outlineScale,
                                      NSColor *outlineColor)
{
  NSMutableDictionary *attributes = [@{
    NSFontAttributeName : font,
    NSForegroundColorAttributeName : color,
  } mutableCopy];
  if (outlineScale > 0) {
    // Negative: a positive stroke width draws the outline INSTEAD of the fill.
    attributes[NSStrokeWidthAttributeName] = @(-outlineScale * 100.0);
    attributes[NSStrokeColorAttributeName] = outlineColor;
  }
  return attributes;
}

static NSColor *CEColorFromHex(NSString *hex, NSColor *fallback)
{
  if (![hex isKindOfClass:[NSString class]]) {
    return fallback;
  }
  NSString *clean = [hex hasPrefix:@"#"] ? [hex substringFromIndex:1] : hex;
  if (clean.length != 6) {
    return fallback;
  }
  unsigned int value = 0;
  if (![[NSScanner scannerWithString:clean] scanHexInt:&value]) {
    return fallback;
  }
  return [NSColor colorWithSRGBRed:((value >> 16) & 0xFF) / 255.0
                             green:((value >> 8) & 0xFF) / 255.0
                              blue:(value & 0xFF) / 255.0
                             alpha:1.0];
}

static CAKeyframeAnimation *CEOpacityAnimation(double start, double end, double total,
                                               double fadeIn, double fadeOut)
{
  NSMutableArray<NSNumber *> *times = [NSMutableArray array];
  NSMutableArray<NSNumber *> *values = [NSMutableArray array];
  __block double lastTime = -1.0;
  void (^add)(double, double) = ^(double time, double value) {
    double clamped = MAX(0.0, MIN(1.0, time));
    if (clamped <= lastTime) {
      return;
    }
    lastTime = clamped;
    [times addObject:@(clamped)];
    [values addObject:@(value)];
  };
  if (total <= 0) {
    total = 1.0;
  }
  add(0.0, 0.0);
  add((start - fadeIn) / total, 0.0);
  add(start / total, 1.0);
  add((end - fadeOut) / total, 1.0);
  add(end / total, 0.0);
  add(1.0, 0.0);

  CAKeyframeAnimation *animation = [CAKeyframeAnimation animationWithKeyPath:@"opacity"];
  animation.keyTimes = times;
  animation.values = values;
  animation.duration = total;
  animation.beginTime = AVCoreAnimationBeginTimeAtZero;
  animation.removedOnCompletion = NO;
  animation.fillMode = kCAFillModeBoth;
  animation.calculationMode = kCAAnimationLinear;
  return animation;
}

static CATextLayer *CETextLayerWith(NSString *text, NSDictionary *attributes, CGRect frame,
                                    NSColor *shadowColor, double shadowOffset)
{
  CATextLayer *layer = [CATextLayer layer];
  layer.string = [[NSAttributedString alloc] initWithString:text attributes:attributes];
  layer.frame = frame;
  layer.alignmentMode = kCAAlignmentLeft;
  layer.truncationMode = kCATruncationNone;
  layer.masksToBounds = NO;
  layer.contentsScale = 1.0;
  if (shadowColor != nil) {
    layer.shadowColor = shadowColor.CGColor;
    layer.shadowOpacity = 0.85f;
    layer.shadowRadius = (CGFloat)(shadowOffset * 0.6);
    layer.shadowOffset = CGSizeMake((CGFloat)shadowOffset, (CGFloat)(-shadowOffset));
  }
  return layer;
}

static double CEDouble(NSDictionary *d, NSString *key, double fallback)
{
  id value = d[key];
  return [value isKindOfClass:[NSNumber class]] ? [value doubleValue] : fallback;
}

/// The `classic` burn style from src/captions/captionStyles.ts — the Hormozi
/// look, which is the one whose edges this whole question is about.
static NSDictionary *CEClassicStyle(void)
{
  return @{
    @"fontName" : @"Montserrat-ExtraBold",
    @"fontScale" : @0.065,
    @"outlineScale" : @0.06,
    @"shadowScale" : @0.03,
    @"marginVScale" : @0.18,
    @"marginHScale" : @0.04,
    @"color" : @"#FFFFFF",
    @"highlightColor" : @"#FFD400",
    @"outlineColor" : @"#000000",
    @"shadowColor" : @"#000000",
    @"boxed" : @NO,
    @"boxColor" : @"#000000",
  };
}

/// Verbatim port of -[CaptionEngine addCaptionLayers:style:toLayer:size:total:].
/// `stillTime` < 0 renders the animated form used for export. >= 0 freezes the
/// tree at that moment on the clip's timeline, which is how the reference
/// rasterisation is made to match the frame it is scored against - including
/// which word is lit.
static void CEAddCaptionLayers(NSArray<NSDictionary *> *cues, NSDictionary *style,
                               CALayer *parent, CGSize size, double total,
                               double stillTime)
{
  double fontSize = MAX(12.0, size.height * CEDouble(style, @"fontScale", 0.055));
  double marginV = size.height * CEDouble(style, @"marginVScale", 0.18);
  double marginH = size.width * CEDouble(style, @"marginHScale", 0.06);
  double outlineScale = CEDouble(style, @"outlineScale", 0);
  double shadowScale = CEDouble(style, @"shadowScale", 0);
  BOOL boxed = [style[@"boxed"] boolValue];

  NSString *fontName = [style[@"fontName"] isKindOfClass:[NSString class]]
                           ? style[@"fontName"]
                           : @"Arial-BoldMT";
  NSFont *font = [NSFont fontWithName:fontName size:fontSize];
  if (font == nil) {
    fprintf(stderr, "canvas_probe: font '%s' unavailable, falling back\n",
            fontName.UTF8String);
    font = [NSFont fontWithName:@"HelveticaNeue-Bold" size:fontSize];
  }

  NSColor *color = CEColorFromHex(style[@"color"], [NSColor whiteColor]);
  NSColor *outlineColor = CEColorFromHex(style[@"outlineColor"], [NSColor blackColor]);
  NSColor *shadowColor = CEColorFromHex(style[@"shadowColor"], [NSColor blackColor]);
  NSColor *boxColor = CEColorFromHex(style[@"boxColor"], [NSColor blackColor]);
  id highlightHex = style[@"highlightColor"];
  NSColor *highlightColor =
      [highlightHex isKindOfClass:[NSString class]] ? CEColorFromHex(highlightHex, nil) : nil;

  NSDictionary *baseAttributes = CETextAttributes(font, color, outlineScale, outlineColor);
  NSDictionary *highlightAttributes =
      highlightColor != nil
          ? CETextAttributes(font, highlightColor, outlineScale, outlineColor)
          : nil;

  double lineHeight = CEFontLineHeight(font);

  for (NSDictionary *cue in cues) {
    NSArray<NSArray<NSDictionary *> *> *lines = cue[@"lines"];
    if (![lines isKindOfClass:[NSArray class]] || lines.count == 0) {
      continue;
    }
    double cueStart = CEDouble(cue, @"startSec", 0);
    double cueEnd = CEDouble(cue, @"endSec", 0);
    if (cueEnd <= cueStart) {
      continue;
    }

    CALayer *container = [CALayer layer];
    container.frame = CGRectMake(0, 0, size.width, size.height);
    if (stillTime >= 0) {
      container.opacity = (stillTime >= cueStart && stillTime < cueEnd) ? 1 : 0;
    } else if (getenv("CANVAS_PROBE_STATIC") != NULL) {
      // Diagnostic only: hold every cue visible so an empty export separates
      // "the animation did not run" from "nothing composited at all".
      container.opacity = 1;
    } else {
      container.opacity = 0;
      [container addAnimation:CEOpacityAnimation(cueStart, cueEnd, total, kCEFadeInSeconds,
                                                 kCEFadeOutSeconds)
                       forKey:@"opacity"];
    }

    for (NSUInteger lineIndex = 0; lineIndex < lines.count; lineIndex++) {
      NSArray<NSDictionary *> *words = lines[lineIndex];
      double y = marginV + (double)(lines.count - 1 - lineIndex) * lineHeight;

      double available = size.width - marginH * 2;
      NSFont *lineFont = font;
      NSDictionary *lineBase = baseAttributes;
      NSDictionary *lineLit = highlightAttributes;
      NSArray<NSValue *> *sizes = nil;
      double lineWidth = 0;
      double spacing = 0;

      for (int attempt = 0; attempt < 2; attempt++) {
        NSMutableArray<NSValue *> *measured = [NSMutableArray array];
        spacing = [@" " sizeWithAttributes:lineBase].width;
        lineWidth = 0;
        for (NSUInteger i = 0; i < words.count; i++) {
          NSString *text = words[i][@"text"] ?: @"";
          CGSize wordSize = [text sizeWithAttributes:lineBase];
          [measured addObject:[NSValue valueWithSize:NSSizeFromCGSize(wordSize)]];
          lineWidth += wordSize.width + (i > 0 ? spacing : 0);
        }
        sizes = measured;
        if (lineWidth <= available || lineWidth <= 0 || attempt == 1) {
          break;
        }
        double shrunk = MAX(8.0, lineFont.pointSize * (available / lineWidth));
        lineFont = [NSFont fontWithName:font.fontName size:shrunk]
                       ?: [NSFont boldSystemFontOfSize:shrunk];
        lineBase = CETextAttributes(lineFont, color, outlineScale, outlineColor);
        lineLit = highlightColor != nil
                      ? CETextAttributes(lineFont, highlightColor, outlineScale, outlineColor)
                      : nil;
      }

      double drawHeight = CEFontLineHeight(lineFont);
      double shadowOffset = shadowScale * lineFont.pointSize;
      double bleed = outlineScale * lineFont.pointSize + 2.0;
      double x = (size.width - lineWidth) / 2.0;

      if (boxed) {
        double padX = lineFont.pointSize * 0.28;
        double padY = lineFont.pointSize * 0.14;
        CALayer *box = [CALayer layer];
        box.frame = CGRectMake(x - padX, y - padY, lineWidth + padX * 2, drawHeight + padY * 2);
        box.backgroundColor = boxColor.CGColor;
        [container addSublayer:box];
      }

      for (NSUInteger i = 0; i < words.count; i++) {
        NSDictionary *word = words[i];
        NSString *text = word[@"text"] ?: @"";
        CGSize wordSize = NSSizeToCGSize([sizes[i] sizeValue]);
        CGRect frame = CGRectMake(x, y, wordSize.width + bleed, drawHeight);

        [container addSublayer:CETextLayerWith(text, lineBase, frame,
                                               shadowScale > 0 ? shadowColor : nil,
                                               shadowOffset)];

        id start = word[@"highlightStart"];
        id end = word[@"highlightEnd"];
        if (lineLit != nil && [start isKindOfClass:[NSNumber class]] &&
            [end isKindOfClass:[NSNumber class]]) {
          CALayer *lit = CETextLayerWith(text, lineLit, frame,
                                         shadowScale > 0 ? shadowColor : nil, shadowOffset);
          if (stillTime >= 0) {
            lit.opacity = (stillTime >= [start doubleValue] && stillTime < [end doubleValue])
                              ? 1
                              : 0;
          } else {
            lit.opacity = 0;
            [lit addAnimation:CEOpacityAnimation([start doubleValue], [end doubleValue],
                                                 total, 0, 0)
                       forKey:@"opacity"];
          }
          [container addSublayer:lit];
        }

        x += wordSize.width + spacing;
      }
    }
    [parent addSublayer:container];
  }
}

// ---------------------------------------------------------------------------
// Cues
// ---------------------------------------------------------------------------

/// Three-word uppercase cues at the style's own 1.2s cadence, which is what
/// buildCaptionCues produces for the classic style.
static NSArray<NSDictionary *> *CEBuildCues(double duration)
{
  NSArray<NSString *> *bank = @[
    @"THIS", @"IS", @"THE", @"PART", @"WHERE", @"EVERYTHING", @"ACTUALLY",
    @"CHANGES", @"AND", @"NOBODY", @"TELLS", @"YOU", @"WHY", @"IT", @"WORKS",
  ];
  NSMutableArray<NSDictionary *> *cues = [NSMutableArray array];
  NSUInteger cursor = 0;
  double t = 0.30;
  while (t + 1.2 <= duration) {
    NSMutableArray<NSDictionary *> *words = [NSMutableArray array];
    for (int i = 0; i < 3; i++) {
      NSString *text = bank[(cursor + (NSUInteger)i) % bank.count];
      [words addObject:@{
        @"text" : text,
        @"highlightStart" : @(t + 0.4 * i),
        @"highlightEnd" : @(t + 0.4 * (i + 1)),
      }];
    }
    cursor += 3;
    [cues addObject:@{
      @"startSec" : @(t),
      @"endSec" : @(t + 1.2),
      @"lines" : @[ words ],
    }];
    t += 1.35;
  }
  return cues;
}

// ---------------------------------------------------------------------------
// Shared asset helpers
// ---------------------------------------------------------------------------

static BOOL CELoadAssetKeys(AVAsset *asset, NSArray<NSString *> *keys)
{
  dispatch_semaphore_t semaphore = dispatch_semaphore_create(0);
  [asset loadValuesAsynchronouslyForKeys:keys
                       completionHandler:^{ dispatch_semaphore_signal(semaphore); }];
  dispatch_semaphore_wait(semaphore, DISPATCH_TIME_FOREVER);
  for (NSString *key in keys) {
    NSError *error = nil;
    if ([asset statusOfValueForKey:key error:&error] != AVKeyValueStatusLoaded) {
      fprintf(stderr, "canvas_probe: could not load '%s' - %s\n", key.UTF8String,
              error.localizedDescription.UTF8String);
      return NO;
    }
  }
  return YES;
}

static void RegisterBundledFont(NSString *path)
{
  if (path.length == 0) {
    return;
  }
  NSURL *url = [NSURL fileURLWithPath:path];
  CFErrorRef error = NULL;
  if (!CTFontManagerRegisterFontsForURL((__bridge CFURLRef)url,
                                        kCTFontManagerScopeProcess, &error)) {
    fprintf(stderr, "canvas_probe: could not register %s\n", path.UTF8String);
    if (error) {
      CFRelease(error);
    }
  }
}

// ---------------------------------------------------------------------------
// guard — what does the guard actually see?
// ---------------------------------------------------------------------------

/// `smallestCoded` is in the same pre-transform space as `natural`. Pass
/// CGSizeZero to mean "uniform", i.e. every sample is the natural size.
static CEPromotion ReportSource(const char *label, CGSize natural,
                                CGAffineTransform transform, CGSize smallestCoded)
{
  CGSize sourceSize = CEPixelSize(CGSizeApplyAffineTransform(natural, transform));
  if (sourceSize.width < 1 || sourceSize.height < 1) {
    sourceSize = CEPixelSize(natural);
  }
  if (smallestCoded.width < 1 || smallestCoded.height < 1) {
    smallestCoded = natural;
  }
  CGSize smallestShown = CEPixelSize(CGSizeApplyAffineTransform(smallestCoded, transform));

  CEPromotion off = CEPromotedRenderSizeExplained(sourceSize, smallestShown, NO);
  CEPromotion on = CEPromotedRenderSizeExplained(sourceSize, smallestShown, YES);
  PLog("  %-46s naturalSize %.0fx%.0f  transform [%.2f %.2f %.2f %.2f]",
       label, natural.width, natural.height, transform.a, transform.b, transform.c,
       transform.d);
  PLog("  %-46s header says %.0fx%.0f  smallest sample %.0fx%.0f", "", sourceSize.width,
       sourceSize.height, smallestShown.width, smallestShown.height);
  PLog("  %-46s flag NO  -> %.0fx%.0f  (%s)", "", off.render.width, off.render.height,
       off.verdict);
  PLog("  %-46s flag YES -> %.0fx%.0f  (%s)", "", on.render.width, on.render.height,
       on.verdict);
  PLog("");
  return on;
}

/// Builds the file ClipStitcher would build from segments that changed
/// resolution mid-session, and returns its video track. `verbose` prints the
/// trace; `verify` does not need it.
///
/// Exactly ClipStitcher's loop: one composition video track, every segment
/// inserted into it, preferredTransform reassigned from each segment, then a
/// passthrough export.
static AVAssetTrack *StitchMixedResolution(NSString *bigPath, NSString *smallPath,
                                           BOOL verbose)
{
  AVMutableComposition *composition = [AVMutableComposition composition];
  AVMutableCompositionTrack *videoTrack =
      [composition addMutableTrackWithMediaType:AVMediaTypeVideo
                               preferredTrackID:kCMPersistentTrackID_Invalid];
  CMTime cursor = kCMTimeZero;
  for (NSString *path in @[ bigPath, bigPath, smallPath, smallPath ]) {
    AVURLAsset *asset = [AVURLAsset URLAssetWithURL:[NSURL fileURLWithPath:path] options:nil];
    if (!CELoadAssetKeys(asset, @[ @"tracks", @"duration" ])) {
      return nil;
    }
    AVAssetTrack *srcVideo = [asset tracksWithMediaType:AVMediaTypeVideo].firstObject;
    CMTime take = CMTimeRangeGetEnd(srcVideo.timeRange);
    NSError *error = nil;
    [videoTrack insertTimeRange:CMTimeRangeMake(kCMTimeZero, take)
                        ofTrack:srcVideo
                         atTime:cursor
                          error:&error];
    if (error != nil) {
      fprintf(stderr, "insert failed: %s\n", error.localizedDescription.UTF8String);
      return nil;
    }
    videoTrack.preferredTransform = srcVideo.preferredTransform;
    cursor = CMTimeAdd(cursor, take);
    if (verbose) {
      PLog("  inserted %-28s (%.0fx%.0f) -> composition track naturalSize now %.0fx%.0f",
           path.lastPathComponent.UTF8String, srcVideo.naturalSize.width,
           srcVideo.naturalSize.height, videoTrack.naturalSize.width,
           videoTrack.naturalSize.height);
    }
  }
  if (verbose) {
    PLog("");
    PLog("  composition video track segments: %lu",
         (unsigned long)videoTrack.segments.count);
    PLog("  composition video track naturalSize: %.0fx%.0f", videoTrack.naturalSize.width,
         videoTrack.naturalSize.height);
    PLog("");
  }

  NSString *stitched = [NSTemporaryDirectory()
      stringByAppendingPathComponent:@"canvas_probe_stitched.mp4"];
  [[NSFileManager defaultManager] removeItemAtPath:stitched error:nil];
  AVAssetExportSession *pass =
      [[AVAssetExportSession alloc] initWithAsset:composition
                                       presetName:AVAssetExportPresetPassthrough];
  pass.outputURL = [NSURL fileURLWithPath:stitched];
  pass.outputFileType = AVFileTypeMPEG4;
  __block BOOL passDone = NO;
  [pass exportAsynchronouslyWithCompletionHandler:^{ passDone = YES; }];
  while (!passDone) {
    @autoreleasepool {
      [[NSRunLoop mainRunLoop] runMode:NSDefaultRunLoopMode
                            beforeDate:[NSDate dateWithTimeIntervalSinceNow:0.02]];
    }
  }
  if (pass.status != AVAssetExportSessionStatusCompleted) {
    if (verbose) {
      PLog("  passthrough refused the format change (%s) -> ClipStitcher transcodes.",
           pass.error.localizedDescription.UTF8String);
      PLog("  the transcode fallback sizes its writer from");
      PLog("  readerVideoTrack.naturalSize = %.0fx%.0f, so that is the stitched file's size.",
           videoTrack.naturalSize.width, videoTrack.naturalSize.height);
    }
    return videoTrack;
  }
  AVURLAsset *out = [AVURLAsset URLAssetWithURL:[NSURL fileURLWithPath:stitched] options:nil];
  if (!CELoadAssetKeys(out, @[ @"tracks" ])) {
    return nil;
  }
  AVAssetTrack *t = [out tracksWithMediaType:AVMediaTypeVideo].firstObject;
  if (verbose) {
    PLog("  PASSTHROUGH SUCCEEDED across the resolution change.");
    PLog("  stitched file's video track naturalSize: %.0fx%.0f  (%lu sample description(s))",
         t.naturalSize.width, t.naturalSize.height,
         (unsigned long)t.formatDescriptions.count);
  }
  return t;
}

/// Reports what the guard computes for real files, so the transform is the one
/// the container actually carries rather than one this tool synthesised.
static int RunInspect(NSArray<NSString *> *args)
{
  for (NSString *path in args) {
    AVURLAsset *asset = [AVURLAsset URLAssetWithURL:[NSURL fileURLWithPath:path] options:nil];
    if (!CELoadAssetKeys(asset, @[ @"tracks" ])) {
      return 1;
    }
    AVAssetTrack *track = [asset tracksWithMediaType:AVMediaTypeVideo].firstObject;
    if (track == nil) {
      PLog("  %s: no video track", path.lastPathComponent.UTF8String);
      continue;
    }
    CGAffineTransform t = track.preferredTransform;
    PLog("  %-46s transform exactly [%a %a %a %a]  formatDescriptions=%lu",
         path.lastPathComponent.UTF8String, t.a, t.b, t.c, t.d,
         (unsigned long)track.formatDescriptions.count);
    // Undo the transform: ReportSource re-applies it, and CESmallestCodedSize
    // has already returned a display-space size.
    CGSize shown = CESmallestCodedSize(track, t);
    CGSize coded = CGSizeApplyAffineTransform(shown, CGAffineTransformInvert(t));
    ReportSource(path.lastPathComponent.UTF8String, track.naturalSize, t,
                 CGSizeMake(fabs(coded.width), fabs(coded.height)));
  }
  return 0;
}

static int RunGuard(NSArray<NSString *> *args)
{
  PLog("== 1. What CEPromotedRenderSize computes, per source shape ==");
  PLog("");
  ReportSource("upright 720x1280 proxy", CGSizeMake(720, 1280), CGAffineTransformIdentity,
               CGSizeZero);
  ReportSource("rotated 1280x720 (portrait after transform)", CGSizeMake(1280, 720),
               CGAffineTransformMakeRotation(M_PI_2), CGSizeZero);
  ReportSource("rotated 1280x720 (-90 deg)", CGSizeMake(1280, 720),
               CGAffineTransformMakeRotation(-M_PI_2), CGSizeZero);
  ReportSource("ABR-dropped 504x896 segment, raw", CGSizeMake(504, 896),
               CGAffineTransformIdentity, CGSizeZero);
  ReportSource("720x1280 header over 504x896 samples", CGSizeMake(720, 1280),
               CGAffineTransformIdentity, CGSizeMake(504, 896));
  ReportSource("Path B master 1520x2032", CGSizeMake(1520, 2032),
               CGAffineTransformIdentity, CGSizeZero);
  ReportSource("drifted sensor mode 700x1280", CGSizeMake(700, 1280),
               CGAffineTransformIdentity, CGSizeZero);

  if (args.count < 2) {
    PLog("(pass <720p.mp4> <504p.mp4> to also trace the stitched mixed-resolution case)");
    return 0;
  }

  PLog("== 2. The stitched mixed-resolution asset ==");
  PLog("");
  NSString *bigPath = args[0];
  NSString *smallPath = args[1];

  AVAssetTrack *stitchedTrack = StitchMixedResolution(bigPath, smallPath, YES);
  if (stitchedTrack == nil) {
    return 1;
  }
  {
    CGAffineTransform t = stitchedTrack.preferredTransform;
    CGSize shown = CESmallestCodedSize(stitchedTrack, t);
    CGSize coded = CGSizeApplyAffineTransform(shown, CGAffineTransformInvert(t));
    ReportSource("=> what CaptionEngine then sees", stitchedTrack.naturalSize, t,
                 CGSizeMake(fabs(coded.width), fabs(coded.height)));
  }
  return 0;
}

// ---------------------------------------------------------------------------
// verify — the guard as a regression check
// ---------------------------------------------------------------------------

static int gFailures = 0;

static void Expect(const char *what, CGSize source, CGSize smallest, BOOL enabled,
                   CGSize want)
{
  CEPromotion got = CEPromotedRenderSizeExplained(source, smallest, enabled);
  BOOL ok = fabs(got.render.width - want.width) < 0.5 &&
            fabs(got.render.height - want.height) < 0.5;
  if (!ok) {
    gFailures++;
  }
  PLog("  %-4s %-52s want %.0fx%.0f  got %.0fx%.0f", ok ? "ok" : "FAIL", what, want.width,
       want.height, got.render.width, got.render.height);
  if (!ok) {
    PLog("       %s", got.verdict);
  }
}

/// Asserts the guard against a real file rather than a constructed pair of
/// sizes: the point of the stsd case is that the header and the samples
/// disagree in a file, and only a file can demonstrate that.
static void ExpectTrack(const char *what, AVAssetTrack *track, BOOL enabled, CGSize want)
{
  if (track == nil) {
    gFailures++;
    PLog("  FAIL %-52s no track", what);
    return;
  }
  CGAffineTransform transform = track.preferredTransform;
  CGSize source = CEPixelSize(CGSizeApplyAffineTransform(track.naturalSize, transform));
  if (source.width < 1 || source.height < 1) {
    source = CEPixelSize(track.naturalSize);
  }
  CGSize smallest = CESmallestCodedSize(track, transform);
  CEPromotion got = CEPromotedRenderSizeExplained(source, smallest, enabled);
  BOOL ok = fabs(got.render.width - want.width) < 0.5 &&
            fabs(got.render.height - want.height) < 0.5;
  if (!ok) {
    gFailures++;
  }
  PLog("  %-4s %-52s want %.0fx%.0f  got %.0fx%.0f", ok ? "ok" : "FAIL", what, want.width,
       want.height, got.render.width, got.render.height);
  PLog("       header %.0fx%.0f  smallest sample %.0fx%.0f  (%lu sample description(s))",
       source.width, source.height, smallest.width, smallest.height,
       (unsigned long)track.formatDescriptions.count);
}

static AVAssetTrack *TrackAt(NSString *path)
{
  AVURLAsset *asset = [AVURLAsset URLAssetWithURL:[NSURL fileURLWithPath:path] options:nil];
  if (!CELoadAssetKeys(asset, @[ @"tracks" ])) {
    return nil;
  }
  return [asset tracksWithMediaType:AVMediaTypeVideo].firstObject;
}

static int RunVerify(NSArray<NSString *> *args)
{
  CGSize const proxy = CGSizeMake(720, 1280);
  CGSize const canvas = CGSizeMake(1080, 1920);
  CGSize const abr = CGSizeMake(504, 896);
  CGSize const master = CGSizeMake(1520, 2032);
  CGSize const drifted = CGSizeMake(700, 1280);

  PLog("== promotion decision, flag ON ==");
  Expect("720x1280 proxy, uniform", proxy, proxy, YES, canvas);
  Expect("504x896 throughout", abr, abr, YES, abr);
  Expect("720x1280 header over 504x896 samples", proxy, abr, YES, proxy);
  Expect("Path B master 1520x2032", master, master, YES, master);
  Expect("drifted sensor mode 700x1280", drifted, drifted, YES, drifted);
  Expect("unreadable sample sizes (fail closed)", proxy, CGSizeZero, YES, proxy);
  Expect("one pixel under the floor", proxy, CGSizeMake(720, 1279), YES, proxy);

  PLog("");
  PLog("== the flag still gates, flag OFF ==");
  Expect("720x1280 proxy, uniform", proxy, proxy, NO, proxy);

  if (args.count >= 2) {
    PLog("");
    PLog("== real files ==");
    ExpectTrack("clean 720x1280 segment", TrackAt(args[0]), YES, canvas);
    ExpectTrack("clean 504x896 segment", TrackAt(args[1]), YES, abr);
    ExpectTrack("stitched 720+504 (the stsd case)",
                StitchMixedResolution(args[0], args[1], NO), YES, proxy);
    for (NSUInteger i = 2; i < args.count; i++) {
      ExpectTrack([NSString stringWithFormat:@"rotated %s",
                                             args[i].lastPathComponent.UTF8String]
                      .UTF8String,
                  TrackAt(args[i]), YES, canvas);
    }
  } else {
    PLog("");
    PLog("  (pass <720p.mp4> <504p.mp4> [rotated.mp4...] to also check real files)");
  }

  PLog("");
  if (gFailures > 0) {
    PLog("%d FAILURE(S)", gFailures);
    return 1;
  }
  PLog("all checks passed");
  return 0;
}

// ---------------------------------------------------------------------------
// render — the caption burn at a chosen canvas
// ---------------------------------------------------------------------------

static int RunRender(NSString *inPath, NSString *outPath, BOOL promote)
{
  AVURLAsset *asset = [AVURLAsset URLAssetWithURL:[NSURL fileURLWithPath:inPath] options:nil];
  if (!CELoadAssetKeys(asset, @[ @"tracks", @"duration" ])) {
    return 1;
  }
  AVAssetTrack *videoTrack = [asset tracksWithMediaType:AVMediaTypeVideo].firstObject;
  if (videoTrack == nil) {
    fprintf(stderr, "canvas_probe: no video track\n");
    return 1;
  }
  double sourceDuration = CMTimeGetSeconds(asset.duration);

  AVMutableComposition *composition = [AVMutableComposition composition];
  AVMutableCompositionTrack *videoComp =
      [composition addMutableTrackWithMediaType:AVMediaTypeVideo
                               preferredTrackID:kCMPersistentTrackID_Invalid];

  CGAffineTransform transform = videoTrack.preferredTransform;
  CGSize natural = videoTrack.naturalSize;
  CGSize sourceSize = CEPixelSize(CGSizeApplyAffineTransform(natural, transform));
  if (sourceSize.width < 1 || sourceSize.height < 1) {
    sourceSize = CEPixelSize(natural);
  }

  CEPromotion promotion = CEPromotedRenderSizeExplained(
      sourceSize, CESmallestCodedSize(videoTrack, videoTrack.preferredTransform), promote);
  CGSize const render = promotion.render;

  CGFloat const canvasScale =
      MIN(render.width / sourceSize.width, render.height / sourceSize.height);
  if (canvasScale != 1.0) {
    transform = CGAffineTransformConcat(transform,
                                        CGAffineTransformMakeScale(canvasScale, canvasScale));
  }

  NSError *insertError = nil;
  if (![videoComp insertTimeRange:CMTimeRangeMake(kCMTimeZero, asset.duration)
                          ofTrack:videoTrack
                           atTime:kCMTimeZero
                            error:&insertError]) {
    fprintf(stderr, "canvas_probe: compose failed - %s\n",
            insertError.localizedDescription.UTF8String);
    return 1;
  }

  AVMutableVideoCompositionInstruction *instruction =
      [AVMutableVideoCompositionInstruction videoCompositionInstruction];
  instruction.timeRange = CMTimeRangeMake(kCMTimeZero, composition.duration);
  AVMutableVideoCompositionLayerInstruction *layerInstruction =
      [AVMutableVideoCompositionLayerInstruction
          videoCompositionLayerInstructionWithAssetTrack:videoComp];
  [layerInstruction setTransform:transform atTime:kCMTimeZero];
  instruction.layerInstructions = @[ layerInstruction ];

  double total = CMTimeGetSeconds(composition.duration);
  NSArray<NSDictionary *> *cues = CEBuildCues(sourceDuration);

  AVMutableVideoComposition *videoComposition = [AVMutableVideoComposition videoComposition];
  videoComposition.renderSize = render;
  float fps = videoTrack.nominalFrameRate > 1 ? videoTrack.nominalFrameRate : 30.0f;
  videoComposition.frameDuration = CMTimeMake(1, (int32_t)lround(fps));
  videoComposition.instructions = @[ instruction ];

  CALayer *videoLayer = [CALayer layer];
  videoLayer.frame = CGRectMake(0, 0, render.width, render.height);
  CALayer *parentLayer = [CALayer layer];
  parentLayer.frame = videoLayer.frame;
  parentLayer.geometryFlipped = NO;
  [parentLayer addSublayer:videoLayer];
  CEAddCaptionLayers(cues, CEClassicStyle(), parentLayer, render, total, -1.0);
  videoComposition.animationTool = [AVVideoCompositionCoreAnimationTool
      videoCompositionCoreAnimationToolWithPostProcessingAsVideoLayer:videoLayer
                                                              inLayer:parentLayer];

  [[NSFileManager defaultManager] removeItemAtPath:outPath error:nil];
  AVAssetExportSession *export =
      [[AVAssetExportSession alloc] initWithAsset:composition
                                       presetName:AVAssetExportPresetHighestQuality];
  if (export == nil) {
    fprintf(stderr, "canvas_probe: could not create an export session\n");
    return 1;
  }
  export.outputURL = [NSURL fileURLWithPath:outPath];
  export.outputFileType = AVFileTypeMPEG4;
  export.videoComposition = videoComposition;
  export.shouldOptimizeForNetworkUse = YES;

  gSampling = YES;
  gPeakFootprint = CurrentFootprint();
  pthread_t sampler;
  pthread_create(&sampler, NULL, SampleFootprint, NULL);

  // AVVideoCompositionCoreAnimationTool drives CoreAnimation's offline
  // renderer, which services work on the main run loop. On device this is a
  // non-issue because renderEdit runs on CaptionEngine's own serial queue and
  // main is free; here, blocking main on a semaphore starves the renderer and
  // every caption layer exports empty. Pump the run loop instead of blocking.
  NSDate *started = [NSDate date];
  __block BOOL finished = NO;
  [export exportAsynchronouslyWithCompletionHandler:^{ finished = YES; }];
  while (!finished) {
    @autoreleasepool {
      [[NSRunLoop mainRunLoop] runMode:NSDefaultRunLoopMode
                            beforeDate:[NSDate dateWithTimeIntervalSinceNow:0.02]];
    }
  }
  double wall = -[started timeIntervalSinceNow];

  gSampling = NO;
  pthread_join(sampler, NULL);

  if (export.status != AVAssetExportSessionStatusCompleted) {
    fprintf(stderr, "canvas_probe: export failed (%ld) - %s\n", (long)export.status,
            export.error.localizedDescription.UTF8String);
    return 1;
  }

  NSDictionary *attrs = [[NSFileManager defaultManager] attributesOfItemAtPath:outPath
                                                                        error:NULL];
  unsigned long long bytes = [attrs fileSize];

  AVURLAsset *written = [AVURLAsset URLAssetWithURL:[NSURL fileURLWithPath:outPath] options:nil];
  CELoadAssetKeys(written, @[ @"tracks" ]);
  AVAssetTrack *writtenTrack = [written tracksWithMediaType:AVMediaTypeVideo].firstObject;

  PLog("arm_source_size\t%.0fx%.0f", sourceSize.width, sourceSize.height);
  PLog("arm_render_size\t%.0fx%.0f", render.width, render.height);
  PLog("arm_promotion\t%s", promotion.verdict);
  PLog("arm_canvas_scale\t%.4f", canvasScale);
  PLog("arm_written_size\t%.0fx%.0f", writtenTrack.naturalSize.width,
       writtenTrack.naturalSize.height);
  PLog("arm_cues\t%lu", (unsigned long)cues.count);
  PLog("arm_duration_s\t%.3f", total);
  PLog("arm_export_wall_s\t%.3f", wall);
  PLog("arm_peak_footprint_mb\t%.1f", (double)gPeakFootprint / (1024.0 * 1024.0));
  PLog("arm_bytes\t%llu", bytes);
  PLog("arm_bitrate_bps\t%.0f", total > 0 ? (double)bytes * 8.0 / total : 0.0);
  return 0;
}

// ---------------------------------------------------------------------------
// still — the supersampled reference rasterisation
// ---------------------------------------------------------------------------

/// Rasterises the caption layer tree at `width`x`height`.
///
/// `ss` = 1 is the rasterisation the burn actually produces at that canvas:
/// the same CATextLayer, the same Core Text attributes, the same
/// contentsScale 1.0. `ss` > 1 renders the identical geometry at that multiple
/// and area-averages back down, which is the reference an ideal (resolution
/// independent) rasteriser would have produced at the same canvas.
///
/// The background is left transparent so the result can be composited over
/// real footage; that is also what isolates the glyphs for scoring.
static int RunStill(NSString *outPath, int width, int height, int ss, double atTime,
                    double duration)
{
  CGSize size = CGSizeMake(width * (CGFloat)ss, height * (CGFloat)ss);
  CALayer *root = [CALayer layer];
  root.frame = CGRectMake(0, 0, size.width, size.height);

  // The same cue list the arms were exported with, frozen at `atTime`, so the
  // reference is this frame's glyphs rasterised ideally - not a different
  // frame's, and not a different word lit.
  NSArray<NSDictionary *> *cues = CEBuildCues(duration);
  CEAddCaptionLayers(cues, CEClassicStyle(), root, size, duration, atTime);

  CGColorSpaceRef space = CGColorSpaceCreateWithName(kCGColorSpaceSRGB);
  CGContextRef ctx = CGBitmapContextCreate(NULL, (size_t)size.width, (size_t)size.height, 8, 0,
                                           space, kCGImageAlphaPremultipliedFirst |
                                                      kCGBitmapByteOrder32Little);
  if (ctx == NULL) {
    fprintf(stderr, "canvas_probe: could not create the bitmap context\n");
    return 1;
  }
  CGContextClearRect(ctx, CGRectMake(0, 0, size.width, size.height));
  [root renderInContext:ctx];

  CGImageRef big = CGBitmapContextCreateImage(ctx);
  if (ss == 1) {
    // No downsample step at all when there is nothing to downsample: routing
    // the native raster through a 1:1 redraw would resample it for no reason.
    NSBitmapImageRep *direct = [[NSBitmapImageRep alloc] initWithCGImage:big];
    NSData *directPNG = [direct representationUsingType:NSBitmapImageFileTypePNG properties:@{}];
    BOOL directOK = [directPNG writeToFile:outPath atomically:YES];
    CGImageRelease(big);
    CGContextRelease(ctx);
    CGColorSpaceRelease(space);
    if (!directOK) {
      fprintf(stderr, "canvas_probe: could not write %s\n", outPath.UTF8String);
      return 1;
    }
    PLog("still\t%s\t%dx%d\tnative raster\tt=%.3fs", outPath.lastPathComponent.UTF8String,
         width, height, atTime);
    return 0;
  }

  // Box-downsample to the target geometry. `CGContextSetInterpolationQuality`
  // high over an exact integer factor is an area average, which is the
  // reference we want: every output pixel is the mean coverage of the glyph
  // outline over that pixel's footprint.
  CGContextRef small = CGBitmapContextCreate(NULL, (size_t)width, (size_t)height, 8, 0, space,
                                             kCGImageAlphaPremultipliedFirst |
                                                 kCGBitmapByteOrder32Little);
  CGContextClearRect(small, CGRectMake(0, 0, width, height));
  CGContextSetInterpolationQuality(small, kCGInterpolationHigh);
  CGContextDrawImage(small, CGRectMake(0, 0, width, height), big);
  CGImageRef result = CGBitmapContextCreateImage(small);

  NSBitmapImageRep *rep = [[NSBitmapImageRep alloc] initWithCGImage:result];
  NSData *png = [rep representationUsingType:NSBitmapImageFileTypePNG properties:@{}];
  BOOL ok = [png writeToFile:outPath atomically:YES];

  CGImageRelease(result);
  CGImageRelease(big);
  CGContextRelease(small);
  CGContextRelease(ctx);
  CGColorSpaceRelease(space);

  if (!ok) {
    fprintf(stderr, "canvas_probe: could not write %s\n", outPath.UTF8String);
    return 1;
  }
  PLog("still\t%s\t%dx%d\tsupersample %dx\tt=%.3fs", outPath.lastPathComponent.UTF8String,
       width, height, ss, atTime);
  return 0;
}

// ---------------------------------------------------------------------------

int main(int argc, const char *argv[])
{
  @autoreleasepool {
    // Enough of an app for CoreAnimation's offline renderer; no UI is shown.
    [NSApplication sharedApplication];
    [NSApp setActivationPolicy:NSApplicationActivationPolicyProhibited];

    NSMutableArray<NSString *> *args = [NSMutableArray array];
    for (int i = 1; i < argc; i++) {
      [args addObject:@(argv[i])];
    }
    if (args.count == 0) {
      fprintf(stderr,
              "usage:\n"
              "  canvas_probe guard [720p.mp4 504p.mp4]\n"
              "  canvas_probe inspect <file.mp4>...\n"
              "  canvas_probe verify [720p.mp4 504p.mp4 rotated.mp4...]\n"
              "  canvas_probe render <in.mp4> <out.mp4> <0|1 promote> [font.ttf]\n"
              "  canvas_probe still <out.png> <w> <h> <supersample> <atTime> <duration> [font.ttf]\n");
      return 2;
    }
    NSString *command = args[0];
    [args removeObjectAtIndex:0];

    if ([command isEqualToString:@"verify"]) {
      return RunVerify(args);
    }
    if ([command isEqualToString:@"inspect"]) {
      return RunInspect(args);
    }
    if ([command isEqualToString:@"guard"]) {
      return RunGuard(args);
    }
    if ([command isEqualToString:@"render"]) {
      if (args.count < 3) {
        fprintf(stderr, "canvas_probe: render needs <in> <out> <promote>\n");
        return 2;
      }
      RegisterBundledFont(args.count > 3 ? args[3] : nil);
      return RunRender(args[0], args[1], [args[2] intValue] != 0);
    }
    if ([command isEqualToString:@"still"]) {
      if (args.count < 6) {
        fprintf(stderr, "canvas_probe: still needs <out> <w> <h> <ss> <atTime> <duration>\n");
        return 2;
      }
      RegisterBundledFont(args.count > 6 ? args[6] : nil);
      return RunStill(args[0], args[1].intValue, args[2].intValue, args[3].intValue,
                      args[4].doubleValue, args[5].doubleValue);
    }
    fprintf(stderr, "canvas_probe: unknown command '%s'\n", command.UTF8String);
    return 2;
  }
}
