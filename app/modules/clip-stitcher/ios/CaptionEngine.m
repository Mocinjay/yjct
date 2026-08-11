#import "CEAudioNormalizer.h"
#import "CECaptionStyle.h"

#import <AVFoundation/AVFoundation.h>
#import <QuartzCore/QuartzCore.h>
#import <React/RCTBridgeModule.h>
#import <Speech/Speech.h>
#import <UIKit/UIKit.h>

// ASCII-only on purpose - see ClipStitcher.m for why.
#define CELog(fmt, ...)                                                        \
  NSLog(@"[CaptionEngine] %s:%d %s: " fmt,                                     \
        [[@(__FILE__) lastPathComponent] UTF8String], __LINE__, __func__,      \
        ##__VA_ARGS__)

/// Speech caps how much audio a single recognition request may carry (roughly
/// a minute). Clips run to MAX_CLIP_RECORDING_SECONDS, so recognition is
/// windowed and the word timings are shifted back onto the clip's timeline.
static const double kCEWindowSeconds = 45.0;
/// Windows overlap so a word straddling a seam is heard whole by one of them.
/// The duplicate is dropped when the results are merged.
static const double kCEWindowOverlapSeconds = 1.0;
/// Caption fade, matching the ASS `\fad(60,40)` the server burns.
static const double kCEFadeInSeconds = 0.06;
static const double kCEFadeOutSeconds = 0.04;

#pragma mark - Asset helpers

#pragma mark - Canvas promotion (Path A only, disabled pending measurement)

/**
 * Whether a Path A proxy may be promoted to a 1080x1920 canvas before the
 * caption burn.
 *
 * OFF until `tools/measure/ladder.sh` says otherwise. The claim it would rest
 * on — that handing a platform 1080p wins back bitrate on the far side — is
 * about someone else's transcoder, not about our pixels: upscaling invents
 * every added sample and cannot add detail. Turning this on without the
 * measurement would cost a slower export and a larger upload for a benefit
 * nobody has observed.
 *
 * The decision rule is written down in tools/measure/README.md. Flip this to
 * YES only when the 1080p arm has come back with both a higher bitrate and no
 * SSIM loss, three runs per platform.
 */
static BOOL const CECanvasPromotionEnabled = NO;

static CGFloat const CECanvasPromotionWidth = 1080.0;
static CGFloat const CECanvasPromotionHeight = 1920.0;

/**
 * The largest source this may touch: the MWDAT proxy, which the SDK caps at
 * 720x1280. Path B masters are 1520x2032 and fail this on both axes, which is
 * the point — they are the footage worth protecting, and nothing here is
 * allowed to resample them.
 */
static CGFloat const CECanvasPromotionMaxWidth = 720.0;
static CGFloat const CECanvasPromotionMaxHeight = 1280.0;

/**
 * The promoted render size for a source, or the source's own size unchanged.
 *
 * Four things have to hold before a frame is resampled, and all four are
 * checked against the asset itself rather than against a flag passed down from
 * JS. A flag can be wrong; the pixels cannot. The failure this guards against
 * is silently downscaling a 1520x2032 master, which would take the one path
 * that can actually ship and make it worse.
 */
static CGSize CEPromotedRenderSize(CGSize source)
{
  if (!CECanvasPromotionEnabled) {
    return source;
  }
  if (source.width < 1 || source.height < 1) {
    return source;
  }
  // 1. Only the proxy. Anything larger on either axis is Path B.
  if (source.width > CECanvasPromotionMaxWidth ||
      source.height > CECanvasPromotionMaxHeight) {
    return source;
  }
  // 2. Only an upscale. A "promotion" that shrinks the picture is a bug.
  if (source.width >= CECanvasPromotionWidth ||
      source.height >= CECanvasPromotionHeight) {
    return source;
  }
  // 3. Only a uniform scale. Promoting a source whose aspect ratio differs
  //    from the canvas would mean cropping or pillarboxing, and neither is
  //    worth a bitrate experiment. 1% covers 720x1280 vs 1080x1920 exactly
  //    while rejecting anything genuinely differently shaped.
  CGFloat const sourceAspect = source.width / source.height;
  CGFloat const canvasAspect = CECanvasPromotionWidth / CECanvasPromotionHeight;
  if (fabs(sourceAspect - canvasAspect) > canvasAspect * 0.01) {
    return source;
  }
  return CGSizeMake(CECanvasPromotionWidth, CECanvasPromotionHeight);
}

static BOOL CETrackHasContent(AVAssetTrack *track)
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

static BOOL CELoadAssetKeys(AVAsset *asset, NSArray<NSString *> *keys)
{
  dispatch_semaphore_t semaphore = dispatch_semaphore_create(0);
  [asset loadValuesAsynchronouslyForKeys:keys
                       completionHandler:^{ dispatch_semaphore_signal(semaphore); }];
  dispatch_semaphore_wait(semaphore, DISPATCH_TIME_FOREVER);
  for (NSString *key in keys) {
    NSError *error = nil;
    if ([asset statusOfValueForKey:key error:&error] != AVKeyValueStatusLoaded) {
      CELog(@"failed to load asset key '%@' - %@", key, error.localizedDescription);
      return NO;
    }
  }
  return YES;
}

#pragma mark - Module

#pragma mark - Recognition collector

/**
 * Collects a whole window's worth of recognition.
 *
 * The block form of `recognitionTaskWithRequest:` hands back one result and is
 * finished. Speech finalises per *utterance*, so on a clip with any pause in it
 * that first result is the opening utterance and the rest of the audio is
 * thrown away - which is why captions used to stop a second or two in. The
 * delegate form is the only one that reports every recognition plus a real
 * end-of-task, so it is what we use.
 */
@interface CERecognitionCollector : NSObject <SFSpeechRecognitionTaskDelegate>
@property(nonatomic, strong) NSMutableArray<SFTranscription *> *finals;
@property(nonatomic, strong) SFTranscription *lastHypothesis;
@property(nonatomic, strong) dispatch_semaphore_t done;
@end

@implementation CERecognitionCollector {
  BOOL _settled;
}

- (instancetype)init
{
  self = [super init];
  if (self != nil) {
    _finals = [NSMutableArray array];
    _done = dispatch_semaphore_create(0);
  }
  return self;
}

- (void)finish
{
  if (_settled) {
    return;
  }
  _settled = YES;
  dispatch_semaphore_signal(self.done);
}

- (void)speechRecognitionTask:(SFSpeechRecognitionTask *)task
         didFinishRecognition:(SFSpeechRecognitionResult *)result
{
  if (result.bestTranscription != nil) {
    [self.finals addObject:result.bestTranscription];
  }
}

- (void)speechRecognitionTask:(SFSpeechRecognitionTask *)task
  didHypothesizeTranscription:(SFTranscription *)transcription
{
  self.lastHypothesis = transcription;
}

- (void)speechRecognitionTask:(SFSpeechRecognitionTask *)task
        didFinishSuccessfully:(BOOL)successfully
{
  if (!successfully && task.error != nil) {
    // Silence reports as an error; that is the quiet case, not a failure.
    CELog(@"window ended without a transcript - %@ [%@ %ld]",
          task.error.localizedDescription, task.error.domain,
          (long)task.error.code);
  }
  [self finish];
}

- (void)speechRecognitionTaskWasCancelled:(SFSpeechRecognitionTask *)task
{
  [self finish];
}

@end

@interface CaptionEngine : NSObject <RCTBridgeModule>
@property(nonatomic, strong) SFSpeechRecognizer *recognizer;
@end

@implementation CaptionEngine

RCT_EXPORT_MODULE();

- (dispatch_queue_t)methodQueue
{
  // Serial and off the main thread: transcription and export are both long,
  // and two of them at once would fight over the same hardware encoder.
  static dispatch_queue_t queue;
  static dispatch_once_t once;
  dispatch_once(&once, ^{
    queue = dispatch_queue_create("com.clypso.captionengine", DISPATCH_QUEUE_SERIAL);
  });
  return queue;
}

- (SFSpeechRecognizer *)recognizer
{
  if (_recognizer == nil) {
    _recognizer = [[SFSpeechRecognizer alloc]
        initWithLocale:[NSLocale localeWithLocaleIdentifier:@"en-US"]];
  }
  return _recognizer;
}

RCT_EXPORT_METHOD(isAvailable:(RCTPromiseResolveBlock)resolve
                  rejecter:(RCTPromiseRejectBlock)reject)
{
  SFSpeechRecognizer *recognizer = self.recognizer;
  BOOL authorized =
      [SFSpeechRecognizer authorizationStatus] == SFSpeechRecognizerAuthorizationStatusAuthorized;
  resolve(@(recognizer != nil && recognizer.isAvailable &&
            recognizer.supportsOnDeviceRecognition && authorized));
}

#pragma mark Transcription

RCT_EXPORT_METHOD(transcribeClip:(NSString *)path
                  resolver:(RCTPromiseResolveBlock)resolve
                  rejecter:(RCTPromiseRejectBlock)reject)
{
  if (![[NSFileManager defaultManager] fileExistsAtPath:path]) {
    reject(@"missing_clip", @"Clip file does not exist.", nil);
    return;
  }
  AVURLAsset *asset = [AVURLAsset URLAssetWithURL:[NSURL fileURLWithPath:path] options:nil];
  if (!CELoadAssetKeys(asset, @[ @"tracks", @"duration" ])) {
    reject(@"unreadable_clip", @"Could not read the clip.", nil);
    return;
  }

  // Checked before the recogniser, not after: video-only is normal for glasses
  // capture, and a clip with no audio needs no speech recognition at all. The
  // other order made a silent clip fail on devices that merely lack offline
  // dictation, for a transcript that was always going to be empty.
  BOOL hasAudio = NO;
  for (AVAssetTrack *track in [asset tracksWithMediaType:AVMediaTypeAudio]) {
    hasAudio = hasAudio || CETrackHasContent(track);
  }
  if (!hasAudio) {
    CELog(@"no usable audio track in %@ - no captions", path.lastPathComponent);
    resolve(@{@"transcript" : @"", @"words" : @[]});
    return;
  }

  SFSpeechRecognizer *recognizer = self.recognizer;
  if (recognizer == nil || !recognizer.isAvailable) {
    reject(@"speech_unavailable", @"Speech recognition is not available.", nil);
    return;
  }
  if (!recognizer.supportsOnDeviceRecognition) {
    // Refuse rather than quietly falling back to Apple's servers. Captioning
    // was moved onto the phone so the wearer's audio stays there.
    reject(@"on_device_unavailable",
           @"On-device speech recognition is unavailable for this locale. "
           @"Install the offline dictation language in Settings > General > Keyboard.",
           nil);
    return;
  }

  NSData *pcm = CEReadNormalizedPCM(asset);
  if (pcm == nil) {
    resolve(@{@"transcript" : @"", @"words" : @[]});
    return;
  }

  NSUInteger totalSamples = pcm.length / sizeof(int16_t);
  NSUInteger windowSamples = (NSUInteger)(kCEWindowSeconds * kCERecognitionSampleRate);
  NSUInteger strideSamples =
      (NSUInteger)((kCEWindowSeconds - kCEWindowOverlapSeconds) * kCERecognitionSampleRate);

  NSMutableArray<NSDictionary *> *words = [NSMutableArray array];
  NSMutableArray<NSString *> *transcripts = [NSMutableArray array];
  NSUInteger index = 0;

  for (NSUInteger first = 0; first < totalSamples; first += strideSamples) {
    NSUInteger count = MIN(windowSamples, totalSamples - first);
    if (count < kCERecognitionSampleRate / 10) {
      break;  // under 100ms of tail, nothing to hear
    }
    double offset = (double)first / kCERecognitionSampleRate;
    NSURL *wav = CEWriteWavWindow(pcm, first, count,
                                  [NSString stringWithFormat:@"w%lu", (unsigned long)index]);
    index += 1;
    if (wav == nil) {
      continue;
    }

    NSString *text = nil;
    NSArray<NSDictionary *> *windowWords = [self recognizeURL:wav offset:offset text:&text];
    [[NSFileManager defaultManager] removeItemAtURL:wav error:NULL];

    if (text.length > 0) {
      [transcripts addObject:text];
    }
    for (NSDictionary *word in windowWords) {
      // Drop what the previous window already heard in the overlap.
      NSDictionary *last = words.lastObject;
      if (last != nil &&
          [word[@"start"] doubleValue] < [last[@"end"] doubleValue] - 0.02) {
        continue;
      }
      [words addObject:word];
    }
    if (count < windowSamples) {
      break;
    }
  }

  CELog(@"transcribed %@ into %lu words across %lu windows",
        path.lastPathComponent, (unsigned long)words.count, (unsigned long)index);
  // Timings only, never the words themselves. Captioning was moved on-device
  // so the wearer's speech stays there, and NSLog goes to the shared system
  // log that any attached tooling can read. The spans are what caption bugs
  // are actually diagnosed from.
  if (words.count > 0) {
    NSMutableString *spans = [NSMutableString string];
    for (NSDictionary *word in words) {
      [spans appendFormat:@"%.2f-%.2f ", [word[@"start"] doubleValue],
                          [word[@"end"] doubleValue]];
    }
    CELog(@"  spans: %@", spans);
  }
  resolve(@{
    @"transcript" : [transcripts componentsJoinedByString:@" "],
    @"words" : words,
  });
}

/// One on-device recognition pass over a window, with timings shifted onto the
/// clip's timeline. Returns an empty array for a silent window.
- (NSArray<NSDictionary *> *)recognizeURL:(NSURL *)url
                                   offset:(double)offset
                                     text:(NSString **)outText
{
  SFSpeechURLRecognitionRequest *request =
      [[SFSpeechURLRecognitionRequest alloc] initWithURL:url];
  // On, so that a window Speech never marks final still yields its hypothesis
  // rather than nothing. The hypotheses are only read if no final arrives.
  request.shouldReportPartialResults = YES;
  request.requiresOnDeviceRecognition = YES;
  request.taskHint = SFSpeechRecognitionTaskHintDictation;
  // Deliberately no contextualStrings. The wake word biases toward "Clypso";
  // doing that here would bend ordinary speech toward the brand name.

  CERecognitionCollector *collector = [[CERecognitionCollector alloc] init];
  SFSpeechRecognitionTask *task = [self.recognizer recognitionTaskWithRequest:request
                                                                     delegate:collector];
  dispatch_semaphore_wait(collector.done, DISPATCH_TIME_FOREVER);
  (void)task;  // held only so it outlives the wait

  NSArray<SFTranscription *> *transcriptions = collector.finals;
  if (transcriptions.count == 0 && collector.lastHypothesis != nil) {
    transcriptions = @[ collector.lastHypothesis ];
  }

  NSMutableArray<NSDictionary *> *words = [NSMutableArray array];
  NSMutableArray<NSString *> *spoken = [NSMutableArray array];
  // Speech may report each utterance on its own or cumulatively, and we cannot
  // tell which from the outside. Taking only what starts after everything kept
  // so far reads both the same way. Applied between results, never within one,
  // so an odd duration inside a single transcription cannot eat a word.
  double covered = -1.0;
  for (SFTranscription *transcription in transcriptions) {
    double mark = covered;
    for (SFTranscriptionSegment *segment in transcription.segments) {
      NSString *word = segment.substring ?: @"";
      if (word.length == 0 || segment.timestamp < covered - 0.02) {
        continue;
      }
      [words addObject:@{
        @"text" : word,
        @"start" : @(segment.timestamp + offset),
        @"end" : @(segment.timestamp + segment.duration + offset),
      }];
      [spoken addObject:word];
      mark = MAX(mark, segment.timestamp + segment.duration);
    }
    covered = mark;
  }

  CELog(@"window at %.1fs: %lu recognitions -> %lu words", offset,
        (unsigned long)transcriptions.count, (unsigned long)words.count);
  // Built from the words we kept rather than joining formattedString, which
  // would repeat itself whenever Speech reported cumulatively.
  if (outText != NULL) {
    *outText = [spoken componentsJoinedByString:@" "];
  }
  return words;
}

#pragma mark Burn-in

/**
 * Renders an edit: a list of segments, with captions burned over the output
 * timeline. One export does the restructuring and the burn together, so the
 * hook-first cut costs the same single encode generation that captioning alone
 * would — concatenating first and captioning after would cost two.
 *
 * `segments` is `[{source: {start, end} | null, outputStart, outputEnd}]`, as
 * produced by climaxEdit.ts. A null source is a black gap (an empty range in
 * the composition, which needs no generated footage). Plain captioning passes
 * a single full-length segment, so both features share this one path.
 */
RCT_EXPORT_METHOD(renderEdit:(NSString *)sourcePath
                  outputPath:(NSString *)outputPath
                  segments:(NSArray<NSDictionary *> *)segments
                  cues:(NSArray<NSDictionary *> *)cues
                  style:(NSDictionary *)style
                  resolver:(RCTPromiseResolveBlock)resolve
                  rejecter:(RCTPromiseRejectBlock)reject)
{
  NSFileManager *files = [NSFileManager defaultManager];
  if (![files fileExistsAtPath:sourcePath]) {
    reject(@"missing_clip", @"Clip file does not exist.", nil);
    return;
  }
  [files removeItemAtPath:outputPath error:NULL];

  AVURLAsset *asset = [AVURLAsset URLAssetWithURL:[NSURL fileURLWithPath:sourcePath]
                                          options:nil];
  if (!CELoadAssetKeys(asset, @[ @"tracks", @"duration" ])) {
    reject(@"unreadable_clip", @"Could not read the clip.", nil);
    return;
  }
  double sourceDuration = CMTimeGetSeconds(asset.duration);
  // An empty list means "the whole source, unchanged" — the plain captioning
  // path, which does not need to know the duration to ask for it.
  if (segments.count == 0) {
    segments = @[ @{
      @"source" : @{@"start" : @0, @"end" : @(sourceDuration)},
      @"outputStart" : @0,
      @"outputEnd" : @(sourceDuration),
    } ];
  }
  BOOL restructures = [self segmentsRestructure:segments duration:sourceDuration];

  if (cues.count == 0 && !restructures) {
    // Nothing was said and nothing is being rearranged. Copying beats a
    // pointless re-encode that would cost a generation of quality for nothing.
    NSError *copyError = nil;
    if (![files copyItemAtPath:sourcePath toPath:outputPath error:&copyError]) {
      reject(@"copy_failed", copyError.localizedDescription, copyError);
      return;
    }
    resolve(@{
      @"outputPath" : outputPath,
      @"durationSec" : @(sourceDuration),
      @"cues" : @0,
    });
    return;
  }

  AVAssetTrack *videoTrack = [asset tracksWithMediaType:AVMediaTypeVideo].firstObject;
  if (videoTrack == nil) {
    reject(@"no_video_track", @"The clip has no video track.", nil);
    return;
  }
  AVAssetTrack *audioTrack = nil;
  for (AVAssetTrack *candidate in [asset tracksWithMediaType:AVMediaTypeAudio]) {
    if (CETrackHasContent(candidate)) {
      audioTrack = candidate;
      break;
    }
  }

  AVMutableComposition *composition = [AVMutableComposition composition];
  AVMutableCompositionTrack *videoComp =
      [composition addMutableTrackWithMediaType:AVMediaTypeVideo
                               preferredTrackID:kCMPersistentTrackID_Invalid];
  AVMutableCompositionTrack *audioComp =
      audioTrack != nil
          ? [composition addMutableTrackWithMediaType:AVMediaTypeAudio
                                     preferredTrackID:kCMPersistentTrackID_Invalid]
          : nil;

  // Render at the orientation the viewer sees, not the raw buffer orientation:
  // a portrait clip stored as landscape-plus-transform would otherwise get
  // captions laid out along the wrong axis.
  CGAffineTransform transform = videoTrack.preferredTransform;
  CGSize natural = videoTrack.naturalSize;
  CGSize sourceSize = CGSizeApplyAffineTransform(natural, transform);
  sourceSize = CGSizeMake(fabs(sourceSize.width), fabs(sourceSize.height));
  if (sourceSize.width < 1 || sourceSize.height < 1) {
    sourceSize = natural;
  }

  // Normally identical to the source. Larger only for a Path A proxy, and only
  // once the ladder measurement has justified it — see CEPromotedRenderSize.
  CGSize const render = CEPromotedRenderSize(sourceSize);

  // The scale that carries the source into the promoted canvas. Uniform by
  // construction: promotion refuses any source whose aspect ratio does not
  // match, so this is 1.0 in every case except a 720x1280 proxy, where it is
  // exactly 1.5. Without it the frames would sit in the bottom-left corner of
  // a larger canvas with the rest painted black.
  CGFloat const canvasScale =
      MIN(render.width / sourceSize.width, render.height / sourceSize.height);
  if (canvasScale != 1.0) {
    transform = CGAffineTransformConcat(
        transform, CGAffineTransformMakeScale(canvasScale, canvasScale));
    CELog(@"canvas promoted %.0fx%.0f -> %.0fx%.0f (scale %.3f)", sourceSize.width,
          sourceSize.height, render.width, render.height, canvasScale);
  }

  // Boundaries are converted once and shared, so instruction N's end is bit
  // for bit instruction N+1's start. Converting each range's duration
  // separately leaves single-tick holes, and a video composition whose
  // instructions are not contiguous is rejected outright.
  NSMutableArray<NSValue *> *starts = [NSMutableArray array];
  for (NSDictionary *segment in segments) {
    [starts addObject:[NSValue valueWithCMTime:
                                   CMTimeMakeWithSeconds(
                                       CEDouble(segment, @"outputStart", 0),
                                       NSEC_PER_SEC)]];
  }
  [starts addObject:[NSValue valueWithCMTime:
                                 CMTimeMakeWithSeconds(
                                     CEDouble(segments.lastObject, @"outputEnd", 0),
                                     NSEC_PER_SEC)]];

  NSError *insertError = nil;
  NSMutableArray<AVMutableVideoCompositionInstruction *> *instructions =
      [NSMutableArray array];

  for (NSUInteger i = 0; i < segments.count; i++) {
    NSDictionary *segment = segments[i];
    id source = segment[@"source"];
    CMTime at = [starts[i] CMTimeValue];
    CMTime until = [starts[i + 1] CMTimeValue];
    if (CMTimeCompare(until, at) <= 0) {
      continue;
    }
    CMTimeRange outRange = CMTimeRangeFromTimeToTime(at, until);

    AVMutableVideoCompositionInstruction *instruction =
        [AVMutableVideoCompositionInstruction videoCompositionInstruction];
    instruction.timeRange = outRange;

    if (![source isKindOfClass:[NSDictionary class]]) {
      // The black beat. An empty range alone is not enough: with no frames to
      // composite the renderer holds the previous one, so the "black" gap came
      // out as a frozen frame. An instruction carrying no layers paints its
      // backgroundColor instead, which is what actually produces black.
      [videoComp insertEmptyTimeRange:outRange];
      [audioComp insertEmptyTimeRange:outRange];
      instruction.backgroundColor = [UIColor blackColor].CGColor;
      instruction.layerInstructions = @[];
      [instructions addObject:instruction];
      continue;
    }

    double srcStart = CEDouble(source, @"start", 0);
    double srcEnd = CEDouble(source, @"end", sourceDuration);
    CMTimeRange range = CMTimeRangeMake(
        CMTimeMakeWithSeconds(srcStart, NSEC_PER_SEC),
        CMTimeMakeWithSeconds(MAX(0.0, srcEnd - srcStart), NSEC_PER_SEC));
    if (![videoComp insertTimeRange:range ofTrack:videoTrack atTime:at
                              error:&insertError]) {
      reject(@"compose_failed", insertError.localizedDescription, insertError);
      return;
    }
    if (audioComp != nil) {
      [audioComp insertTimeRange:range ofTrack:audioTrack atTime:at error:NULL];
    }

    AVMutableVideoCompositionLayerInstruction *layerInstruction =
        [AVMutableVideoCompositionLayerInstruction
            videoCompositionLayerInstructionWithAssetTrack:videoComp];
    [layerInstruction setTransform:transform atTime:kCMTimeZero];
    instruction.layerInstructions = @[ layerInstruction ];
    [instructions addObject:instruction];
  }

  double total = CMTimeGetSeconds(composition.duration);
  if (!isfinite(total) || total <= 0 || instructions.count == 0) {
    reject(@"empty_edit", @"The edit produced no timeline.", nil);
    return;
  }

  AVMutableVideoComposition *videoComposition = [AVMutableVideoComposition videoComposition];
  videoComposition.renderSize = render;
  float fps = videoTrack.nominalFrameRate > 1 ? videoTrack.nominalFrameRate : 30.0f;
  videoComposition.frameDuration = CMTimeMake(1, (int32_t)lround(fps));
  videoComposition.instructions = instructions;

  // Only attach the Core Animation overlay when there is something to draw.
  // It forces every frame through CoreAnimation's offline renderer, which is
  // the most expensive part of the export — pointless for a silent clip, and
  // the renderer is unavailable altogether on the Simulator, where it takes
  // the process down rather than failing the export.
  if (cues.count > 0) {
    CALayer *videoLayer = [CALayer layer];
    videoLayer.frame = CGRectMake(0, 0, render.width, render.height);
    CALayer *parentLayer = [CALayer layer];
    parentLayer.frame = videoLayer.frame;
    parentLayer.geometryFlipped = NO;
    [parentLayer addSublayer:videoLayer];
    [self addCaptionLayers:cues style:style toLayer:parentLayer size:render total:total];

    videoComposition.animationTool =
        [AVVideoCompositionCoreAnimationTool
            videoCompositionCoreAnimationToolWithPostProcessingAsVideoLayer:videoLayer
                                                                    inLayer:parentLayer];
  }

  AVAssetExportSession *export =
      [[AVAssetExportSession alloc] initWithAsset:composition
                                       presetName:AVAssetExportPresetHighestQuality];
  if (export == nil) {
    reject(@"export_unavailable", @"Could not create an export session.", nil);
    return;
  }
  export.outputURL = [NSURL fileURLWithPath:outputPath];
  export.outputFileType = AVFileTypeMPEG4;
  export.videoComposition = videoComposition;
  export.shouldOptimizeForNetworkUse = YES;

  dispatch_semaphore_t done = dispatch_semaphore_create(0);
  [export exportAsynchronouslyWithCompletionHandler:^{ dispatch_semaphore_signal(done); }];
  dispatch_semaphore_wait(done, DISPATCH_TIME_FOREVER);

  if (export.status != AVAssetExportSessionStatusCompleted) {
    CELog(@"export failed (status=%ld) - %@", (long)export.status,
          export.error.localizedDescription);
    [files removeItemAtPath:outputPath error:NULL];
    reject(@"export_failed",
           export.error.localizedDescription ?: @"Caption export failed.", export.error);
    return;
  }
  CELog(@"burned %lu cues into %@", (unsigned long)cues.count,
        outputPath.lastPathComponent);
  resolve(@{
    @"outputPath" : outputPath,
    @"durationSec" : @(total),
    @"cues" : @(cues.count),
  });
}

/// True when the segments do anything other than play the source straight
/// through. A pass-through edit with no captions can be served by copying the
/// file instead of re-encoding it.
- (BOOL)segmentsRestructure:(NSArray<NSDictionary *> *)segments duration:(double)duration
{
  if (segments.count != 1) {
    return YES;
  }
  NSDictionary *only = segments.firstObject;
  id source = only[@"source"];
  if (![source isKindOfClass:[NSDictionary class]]) {
    return YES;
  }
  return !(fabs(CEDouble(source, @"start", -1)) < 0.001 &&
           fabs(CEDouble(source, @"end", -1) - duration) < 0.05 &&
           fabs(CEDouble(only, @"outputStart", -1)) < 0.001);
}

/// One container layer per cue, one text layer per word, plus a second text
/// layer in the highlight colour revealed for exactly the span JS computed.
///
/// Two layers per word rather than recolouring one: a CATextLayer's attributed
/// string is not animatable, so the highlight is done by fading a second copy
/// in over the first.
- (void)addCaptionLayers:(NSArray<NSDictionary *> *)cues
                   style:(NSDictionary *)style
                 toLayer:(CALayer *)parent
                    size:(CGSize)size
                   total:(double)total
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
  UIFont *font = [UIFont fontWithName:fontName size:fontSize];
  if (font == nil) {
    // NOT boldSystemFont. Its PostScript name is the private ".SFUI-Bold",
    // which the offline Core Animation renderer behind
    // AVVideoCompositionCoreAnimationTool cannot resolve - Core Text then
    // falls back a second time, to Times, and the captions come out serif.
    // A concrete family name survives the trip.
    CELog(@"font '%@' unavailable, falling back to Helvetica Neue Bold", fontName);
    font = [UIFont fontWithName:@"HelveticaNeue-Bold" size:fontSize];
  }

  UIColor *color = CEColorFromHex(style[@"color"], [UIColor whiteColor]);
  UIColor *outlineColor = CEColorFromHex(style[@"outlineColor"], [UIColor blackColor]);
  UIColor *shadowColor = CEColorFromHex(style[@"shadowColor"], [UIColor blackColor]);
  UIColor *boxColor = CEColorFromHex(style[@"boxColor"], [UIColor blackColor]);
  id highlightHex = style[@"highlightColor"];
  UIColor *highlightColor =
      [highlightHex isKindOfClass:[NSString class]] ? CEColorFromHex(highlightHex, nil) : nil;

  NSDictionary *baseAttributes =
      CETextAttributes(font, color, outlineScale, outlineColor);
  NSDictionary *highlightAttributes =
      highlightColor != nil
          ? CETextAttributes(font, highlightColor, outlineScale, outlineColor)
          : nil;

  double lineHeight = font.lineHeight;

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
    container.opacity = 0;
    [container addAnimation:CEOpacityAnimation(cueStart, cueEnd, total,
                                               kCEFadeInSeconds, kCEFadeOutSeconds)
                     forKey:@"opacity"];

    for (NSUInteger lineIndex = 0; lineIndex < lines.count; lineIndex++) {
      NSArray<NSDictionary *> *words = lines[lineIndex];
      // Layers are y-up here, and lines[0] is the top line.
      double y = marginV + (double)(lines.count - 1 - lineIndex) * lineHeight;

      // A line wider than the frame is re-laid at a smaller font, not squeezed.
      // Scaling the positions alone would leave the glyphs at full size, so the
      // words would overlap each other instead of fitting.
      double available = size.width - marginH * 2;
      UIFont *lineFont = font;
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
          [measured addObject:[NSValue valueWithCGSize:wordSize]];
          lineWidth += wordSize.width + (i > 0 ? spacing : 0);
        }
        sizes = measured;
        if (lineWidth <= available || lineWidth <= 0 || attempt == 1) {
          break;
        }
        double shrunk = MAX(8.0, lineFont.pointSize * (available / lineWidth));
        lineFont = [UIFont fontWithName:font.fontName size:shrunk]
                       ?: [UIFont boldSystemFontOfSize:shrunk];
        lineBase = CETextAttributes(lineFont, color, outlineScale, outlineColor);
        lineLit = highlightColor != nil ? CETextAttributes(lineFont, highlightColor,
                                                           outlineScale, outlineColor)
                                        : nil;
      }

      double drawHeight = lineFont.lineHeight;
      double shadowOffset = shadowScale * lineFont.pointSize;
      // The stroke draws outside the glyph box; without room for it the layer
      // reports a width that stops short of the outline.
      double bleed = outlineScale * lineFont.pointSize + 2.0;
      double x = (size.width - lineWidth) / 2.0;

      if (boxed) {
        double padX = lineFont.pointSize * 0.28;
        double padY = lineFont.pointSize * 0.14;
        CALayer *box = [CALayer layer];
        box.frame = CGRectMake(x - padX, y - padY, lineWidth + padX * 2,
                               drawHeight + padY * 2);
        box.backgroundColor = boxColor.CGColor;
        [container addSublayer:box];
      }

      for (NSUInteger i = 0; i < words.count; i++) {
        NSDictionary *word = words[i];
        NSString *text = word[@"text"] ?: @"";
        CGSize wordSize = [sizes[i] CGSizeValue];
        CGRect frame = CGRectMake(x, y, wordSize.width + bleed, drawHeight);

        [container addSublayer:[self textLayerWithString:text
                                              attributes:lineBase
                                                   frame:frame
                                             shadowColor:shadowScale > 0 ? shadowColor : nil
                                            shadowOffset:shadowOffset]];

        id start = word[@"highlightStart"];
        id end = word[@"highlightEnd"];
        if (lineLit != nil && [start isKindOfClass:[NSNumber class]] &&
            [end isKindOfClass:[NSNumber class]]) {
          CALayer *lit = [self textLayerWithString:text
                                        attributes:lineLit
                                             frame:frame
                                       shadowColor:shadowScale > 0 ? shadowColor : nil
                                      shadowOffset:shadowOffset];
          lit.opacity = 0;
          // Hard switch, no fade: the word lights up on the syllable, and a
          // ramp reads as the highlight lagging the voice.
          [lit addAnimation:CEOpacityAnimation([start doubleValue], [end doubleValue],
                                               total, 0, 0)
                     forKey:@"opacity"];
          [container addSublayer:lit];
        }

        x += wordSize.width + spacing;
      }
    }
    [parent addSublayer:container];
  }
}

- (CATextLayer *)textLayerWithString:(NSString *)text
                          attributes:(NSDictionary *)attributes
                               frame:(CGRect)frame
                         shadowColor:(UIColor *)shadowColor
                        shadowOffset:(double)shadowOffset
{
  CATextLayer *layer = [CATextLayer layer];
  layer.string = [[NSAttributedString alloc] initWithString:text attributes:attributes];
  layer.frame = frame;
  layer.alignmentMode = kCAAlignmentLeft;
  layer.truncationMode = kCATruncationNone;
  // The stroke and shadow both draw beyond the glyph box, so the layer must
  // not clip to its own bounds.
  layer.masksToBounds = NO;
  // The render size is already in pixels; the screen's scale would double it.
  layer.contentsScale = 1.0;
  if (shadowColor != nil) {
    layer.shadowColor = shadowColor.CGColor;
    layer.shadowOpacity = 0.85f;
    layer.shadowRadius = (CGFloat)(shadowOffset * 0.6);
    // y-up space, so a downward shadow is a negative offset.
    layer.shadowOffset = CGSizeMake((CGFloat)shadowOffset, (CGFloat)(-shadowOffset));
  }
  return layer;
}

+ (BOOL)requiresMainQueueSetup
{
  return NO;
}

@end
