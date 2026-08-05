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
static const double kCERecognitionSampleRate = 16000.0;
/// Caption fade, matching the ASS `\fad(60,40)` the server burns.
static const double kCEFadeInSeconds = 0.06;
static const double kCEFadeOutSeconds = 0.04;

#pragma mark - Asset helpers

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

#pragma mark - Audio extraction

/// Target short-term level, ~-20 dBFS. Apple's voice-activity gate treats
/// anything much quieter than this as silence.
static const float kCETargetRMS = 0.1f;
/// How much a second of audio must swing, in dB, to be speech rather than room
/// tone. NOTHING that thresholds on loudness can make this call: measured on a
/// real two-person clip, the far talker sat at -50.5 dBFS and the silence
/// between the wearer's words at -49.5. What tells them apart is movement -
/// that same silence swings 1.9 dB across a second where her speech swings
/// 17.7 and the wearer's 10-26.
static const float kCEModulationDb = 6.0f;
/// Half-window for that judgement, 0.5 s either side. Long enough to hold a
/// syllable and the gap after it, short enough to change speaker inside.
static const NSUInteger kCEGainWindowFrames = 25;
/// Hard floor, for a clip that is digitally silent and has no noise to measure.
static const float kCESilenceRMS = 0.0003f;
/// ~40x. Enough to carry -50 dBFS up to the gate.
static const float kCEMaxGainDb = 32.0f;
static const float kCEPeakCeiling = 0.95f;
/// 20 ms at 16 kHz. Short enough to follow a change of speaker, long enough
/// not to ride the syllables of one.
static const NSUInteger kCEGainFrameSamples = 320;
/// Envelope smoothing, ~130 ms per pass. Gain is worked out in dB, where a
/// change of speaker is a fixed step regardless of how loud either one is.
static const float kCEGainSmoothing = 0.85f;

static int CECompareLevels(const void *a, const void *b)
{
  float x = *(const float *)a;
  float y = *(const float *)b;
  return (x > y) - (x < y);
}

/**
 * Rides the gain so a quiet talker is audible next to a loud one.
 *
 * The wearer's own voice is inches from the mic and everyone else is across
 * a table, which is 20-30 dB down. One gain for the whole clip cannot serve
 * both: peak normalization takes its gain from the wearer's loudest syllable
 * and lifts nothing, and even whole-clip RMS is dominated by the wearer, so
 * the other person stays under the voice-activity gate and goes uncaptioned.
 *
 * So the gain follows the audio instead, per 20 ms frame, smoothed and
 * interpolated so the recognizer never hears it step. Loud frames already sit
 * near the target and come through untouched; quiet speech is brought up to
 * meet them. Gain is never below 1.0 - this is here to rescue quiet speech,
 * not to flatten the wearer.
 */
static void CERideGain(int16_t *samples, NSUInteger count)
{
  if (count == 0) {
    return;
  }
  NSUInteger frames = (count + kCEGainFrameSamples - 1) / kCEGainFrameSamples;
  float *gainDb = malloc(frames * sizeof(float));
  float *peaks = malloc(frames * sizeof(float));
  float *levels = malloc(frames * sizeof(float));
  if (gainDb == NULL || peaks == NULL || levels == NULL) {
    free(gainDb);
    free(peaks);
    free(levels);
    return;
  }

  for (NSUInteger f = 0; f < frames; f++) {
    NSUInteger first = f * kCEGainFrameSamples;
    NSUInteger n = MIN(kCEGainFrameSamples, count - first);
    double energy = 0.0;
    float peak = 0.0f;
    for (NSUInteger i = 0; i < n; i++) {
      float v = samples[first + i] / 32768.0f;
      energy += (double)v * (double)v;
      peak = MAX(peak, fabsf(v));
    }
    peaks[f] = peak;
    levels[f] = (float)sqrt(energy / (double)n);
  }

  // Each frame is judged on the second of audio around it: if that second
  // moves like speech it is brought up, and the level it is brought up to is
  // that second's loud end rather than the frame's own. Taking the loud end is
  // what keeps the gaps between words from being inflated along with the
  // words, without needing a separate rule for them.
  float *window = malloc((2 * kCEGainWindowFrames + 1) * sizeof(float));
  float held = 0.0f;
  for (NSUInteger f = 0; f < frames && window != NULL; f++) {
    NSUInteger first = f > kCEGainWindowFrames ? f - kCEGainWindowFrames : 0;
    NSUInteger last = MIN(f + kCEGainWindowFrames, frames - 1);
    NSUInteger n = last - first + 1;

    double sum = 0.0;
    double sumOfSquares = 0.0;
    for (NSUInteger i = 0; i < n; i++) {
      window[i] = levels[first + i];
      double db = 20.0 * log10(MAX(levels[first + i], 1e-6f));
      sum += db;
      sumOfSquares += db * db;
    }
    double mean = sum / (double)n;
    float spread = (float)sqrt(MAX(sumOfSquares / (double)n - mean * mean, 0.0));

    if (spread >= kCEModulationDb) {
      qsort(window, n, sizeof(float), CECompareLevels);
      float loud = window[n * 3 / 4];
      if (loud > kCESilenceRMS) {
        float wanted = 20.0f * log10f(kCETargetRMS / loud);
        held = MIN(MAX(wanted, 0.0f), kCEMaxGainDb);
      }
    }
    // Otherwise room tone, which keeps the gain speech last needed rather than
    // asking for more - so a pause is not lifted into a wall of hiss.
    gainDb[f] = held;
  }
  free(window);

  // Smoothed forward and then backward. A recorded clip does not have to be
  // processed causally, and a symmetric pass leaves the gain sitting on the
  // speech instead of lagging a syllable behind it the way attack/release
  // would - which matters most at the moment one speaker hands over to the
  // other, exactly where a word would otherwise be lost.
  for (NSUInteger f = 1; f < frames; f++) {
    gainDb[f] += (gainDb[f - 1] - gainDb[f]) * kCEGainSmoothing;
  }
  for (NSUInteger f = frames - 1; f-- > 0;) {
    gainDb[f] += (gainDb[f + 1] - gainDb[f]) * kCEGainSmoothing;
  }

  // Smoothing can carry a quiet stretch's gain into a loud one. Pull any frame
  // back to what its peak can take, counting its neighbours' peaks too since
  // the applied gain is interpolated across the seam between them.
  for (NSUInteger f = 0; f < frames; f++) {
    float peak = peaks[f];
    if (f > 0) {
      peak = MAX(peak, peaks[f - 1]);
    }
    if (f + 1 < frames) {
      peak = MAX(peak, peaks[f + 1]);
    }
    if (peak > 0.0f) {
      float ceiling = 20.0f * log10f(kCEPeakCeiling / peak);
      gainDb[f] = MIN(gainDb[f], MAX(ceiling, 0.0f));
    }
  }

  for (NSUInteger i = 0; i < count; i++) {
    // Interpolate between frame centres, so no sample sees a step in gain.
    double position = (double)i / (double)kCEGainFrameSamples - 0.5;
    NSInteger low = (NSInteger)floor(position);
    NSInteger high = low + 1;
    double t = position - (double)low;
    low = MIN(MAX(low, (NSInteger)0), (NSInteger)frames - 1);
    high = MIN(MAX(high, (NSInteger)0), (NSInteger)frames - 1);
    double db = gainDb[low] + (gainDb[high] - gainDb[low]) * t;
    double scaled = samples[i] * pow(10.0, db / 20.0);
    samples[i] = (int16_t)MAX(INT16_MIN, MIN(INT16_MAX, scaled));
  }
  free(gainDb);
  free(peaks);
}

/// Reads the whole audio track as 16 kHz mono 16-bit PCM and rides its level.
/// Glasses audio is quiet and far-field; recognition on the raw track misses
/// words that a levelled copy hears. The clip's own audio is never touched -
/// this is a throwaway copy for the recognizer.
static NSData *CEReadNormalizedPCM(AVAsset *asset)
{
  NSError *error = nil;
  AVAssetReader *reader = [[AVAssetReader alloc] initWithAsset:asset error:&error];
  AVAssetTrack *track = [asset tracksWithMediaType:AVMediaTypeAudio].firstObject;
  if (reader == nil || track == nil) {
    CELog(@"pcm: no reader/track - %@", error.localizedDescription);
    return nil;
  }

  NSDictionary *settings = @{
    AVFormatIDKey : @(kAudioFormatLinearPCM),
    AVSampleRateKey : @(kCERecognitionSampleRate),
    AVNumberOfChannelsKey : @1,
    AVLinearPCMBitDepthKey : @16,
    AVLinearPCMIsFloatKey : @NO,
    AVLinearPCMIsBigEndianKey : @NO,
    AVLinearPCMIsNonInterleaved : @NO,
  };
  AVAssetReaderTrackOutput *output =
      [[AVAssetReaderTrackOutput alloc] initWithTrack:track outputSettings:settings];
  if (![reader canAddOutput:output]) {
    return nil;
  }
  [reader addOutput:output];
  if (![reader startReading]) {
    CELog(@"pcm: startReading failed - %@", reader.error.localizedDescription);
    return nil;
  }

  NSMutableData *pcm = [NSMutableData data];
  CMSampleBufferRef sample = NULL;
  while ((sample = [output copyNextSampleBuffer])) {
    CMBlockBufferRef block = CMSampleBufferGetDataBuffer(sample);
    if (block != NULL) {
      size_t length = CMBlockBufferGetDataLength(block);
      void *bytes = malloc(length);
      if (bytes != NULL) {
        if (CMBlockBufferCopyDataBytes(block, 0, length, bytes) == kCMBlockBufferNoErr) {
          [pcm appendBytes:bytes length:length];
        }
        free(bytes);
      }
    }
    CFRelease(sample);
  }
  if (reader.status == AVAssetReaderStatusFailed || pcm.length < sizeof(int16_t) * 2) {
    CELog(@"pcm: nothing read (status=%ld)", (long)reader.status);
    return nil;
  }

  CERideGain((int16_t *)pcm.mutableBytes, pcm.length / sizeof(int16_t));
  return pcm;
}

static void CEAppendLE32(NSMutableData *data, uint32_t value)
{
  uint8_t bytes[4] = {(uint8_t)(value & 0xFF), (uint8_t)((value >> 8) & 0xFF),
                      (uint8_t)((value >> 16) & 0xFF), (uint8_t)((value >> 24) & 0xFF)};
  [data appendBytes:bytes length:4];
}

static void CEAppendLE16(NSMutableData *data, uint16_t value)
{
  uint8_t bytes[2] = {(uint8_t)(value & 0xFF), (uint8_t)((value >> 8) & 0xFF)};
  [data appendBytes:bytes length:2];
}

/// A window of PCM written as a WAV file.
///
/// Recognition runs from files rather than streamed buffers because
/// SFSpeechURLRecognitionRequest is the path already proven in this app (the
/// wake word runs on it), and a format mismatch on the buffer API fails at
/// runtime on device rather than at build time here.
static NSURL *CEWriteWavWindow(NSData *pcm, NSUInteger firstSample,
                               NSUInteger sampleCount, NSString *label)
{
  const uint32_t byteCount = (uint32_t)(sampleCount * sizeof(int16_t));
  NSMutableData *wav = [NSMutableData dataWithCapacity:byteCount + 44];
  [wav appendBytes:"RIFF" length:4];
  CEAppendLE32(wav, 36 + byteCount);
  [wav appendBytes:"WAVEfmt " length:8];
  CEAppendLE32(wav, 16);                                  // PCM chunk size
  CEAppendLE16(wav, 1);                                   // PCM
  CEAppendLE16(wav, 1);                                   // mono
  CEAppendLE32(wav, (uint32_t)kCERecognitionSampleRate);  // sample rate
  CEAppendLE32(wav, (uint32_t)kCERecognitionSampleRate * 2);  // byte rate
  CEAppendLE16(wav, 2);                                   // block align
  CEAppendLE16(wav, 16);                                  // bits per sample
  [wav appendBytes:"data" length:4];
  CEAppendLE32(wav, byteCount);
  [wav appendBytes:((const int16_t *)pcm.bytes) + firstSample length:byteCount];

  NSURL *url = [NSURL fileURLWithPath:
                         [NSTemporaryDirectory()
                             stringByAppendingPathComponent:
                                 [NSString stringWithFormat:@"caption-%@-%@.wav", label,
                                                            [[NSUUID UUID] UUIDString]]]];
  NSError *error = nil;
  if (![wav writeToURL:url options:NSDataWritingAtomic error:&error]) {
    CELog(@"wav: write failed - %@", error.localizedDescription);
    return nil;
  }
  return url;
}

#pragma mark - Style helpers

static UIColor *CEColorFromHex(NSString *hex, UIColor *fallback)
{
  if (![hex isKindOfClass:[NSString class]]) {
    return fallback;
  }
  NSString *cleaned = [hex stringByReplacingOccurrencesOfString:@"#" withString:@""];
  if (cleaned.length != 6) {
    return fallback;
  }
  unsigned int value = 0;
  if (![[NSScanner scannerWithString:cleaned] scanHexInt:&value]) {
    return fallback;
  }
  return [UIColor colorWithRed:((value >> 16) & 0xFF) / 255.0
                         green:((value >> 8) & 0xFF) / 255.0
                          blue:(value & 0xFF) / 255.0
                         alpha:1.0];
}

static double CEDouble(NSDictionary *dict, NSString *key, double fallback)
{
  id value = dict[key];
  return [value isKindOfClass:[NSNumber class]] ? [value doubleValue] : fallback;
}

/// Text attributes for one word.
///
/// The heavy outline is NSStrokeWidth, which Core Text expresses as a
/// percentage of the font size - the same relationship the ASS styles use, so
/// `outlineScale` carries over unchanged. It must be negative: a positive
/// stroke width draws the outline *instead of* the fill, which renders the
/// captions as hollow letters.
static NSDictionary *CETextAttributes(UIFont *font, UIColor *color, double outlineScale,
                                      UIColor *outlineColor)
{
  NSMutableDictionary *attributes = [@{
    NSFontAttributeName : font,
    NSForegroundColorAttributeName : color,
  } mutableCopy];
  if (outlineScale > 0) {
    attributes[NSStrokeWidthAttributeName] = @(-outlineScale * 100.0);
    attributes[NSStrokeColorAttributeName] = outlineColor;
  }
  return attributes;
}

/// Opacity keyframes covering the whole export, since a layer added to the
/// animation tool has no timeline of its own.
///
/// `beginTime` must be AVCoreAnimationBeginTimeAtZero, not 0: Core Animation
/// reads a zero begin time as "now", which on an export timeline means the
/// animation is already over before the first frame is written.
static CAKeyframeAnimation *CEOpacityAnimation(double start, double end, double total,
                                               double fadeIn, double fadeOut)
{
  NSMutableArray<NSNumber *> *times = [NSMutableArray array];
  NSMutableArray<NSNumber *> *values = [NSMutableArray array];
  __block double lastTime = -1.0;
  void (^add)(double, double) = ^(double time, double value) {
    double clamped = MAX(0.0, MIN(1.0, time));
    // Keyframe times must strictly increase; a caption shorter than the fade
    // would otherwise emit a duplicate and the animation is dropped whole.
    if (clamped <= lastTime) {
      clamped = MIN(1.0, lastTime + 1e-6);
    }
    lastTime = clamped;
    [times addObject:@(clamped)];
    [values addObject:@(value)];
  };

  double span = MAX(end - start, 1e-3);
  double in = MIN(fadeIn, span * 0.4);
  double out = MIN(fadeOut, span * 0.4);
  // With no fade the layer must snap on, so the keyframes are stepped rather
  // than interpolated. Interpolating instead would ramp the value from the
  // previous keyframe, which for a highlight means it starts glowing seconds
  // before its word is spoken.
  BOOL stepped = (in <= 0 && out <= 0);

  if (start > 0) {
    add(0.0, 0.0);
    // Stepped holds this value until the next key, so the visible window opens
    // here. Interpolated has to stay dark and ramp up over the fade instead.
    add(start / total, stepped ? 1.0 : 0.0);
  } else {
    add(0.0, 1.0);
  }
  if (in > 0) {
    add((start + in) / total, 1.0);
  }
  if (out > 0) {
    add((end - out) / total, 1.0);
  }
  add(end / total, 0.0);
  if (end < total) {
    add(1.0, 0.0);
  }

  CAKeyframeAnimation *animation = [CAKeyframeAnimation animationWithKeyPath:@"opacity"];
  animation.keyTimes = times;
  animation.values = values;
  animation.calculationMode = stepped ? kCAAnimationDiscrete : kCAAnimationLinear;
  animation.beginTime = AVCoreAnimationBeginTimeAtZero;
  animation.duration = total;
  animation.removedOnCompletion = NO;
  animation.fillMode = kCAFillModeBoth;
  return animation;
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
    queue = dispatch_queue_create("com.clipso.captionengine", DISPATCH_QUEUE_SERIAL);
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
  // Deliberately no contextualStrings. The wake word biases toward "Clipso";
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
  CGSize render = CGSizeApplyAffineTransform(natural, transform);
  render = CGSizeMake(fabs(render.width), fabs(render.height));
  if (render.width < 1 || render.height < 1) {
    render = natural;
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
