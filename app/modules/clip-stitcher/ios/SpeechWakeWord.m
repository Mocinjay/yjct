#import <AVFoundation/AVFoundation.h>
#import <AudioToolbox/AudioToolbox.h>
#import <React/RCTBridgeModule.h>
#import <Speech/Speech.h>
#import <fcntl.h>
#import <math.h>
#import <unistd.h>

/// Mirror into Documents/clipso-diagnostics.log, the same file MWDATSegmentWriter
/// appends to. A capture run can then be pulled off the device with one
/// `devicectl device copy from --domain-type appDataContainer`, and the video
/// and speech halves of the wake-word path read as a single timeline. The live
/// console drops its connection partway through a long run, which loses exactly
/// the part that matters.
///
/// O_APPEND writes are atomic for line-sized payloads, so interleaving with the
/// Swift writer's own appends cannot tear a line.
static void SWWDiag(NSString *message)
{
  static NSString *path;
  static dispatch_queue_t queue;
  static dispatch_once_t once;
  dispatch_once(&once, ^{
    path = [NSSearchPathForDirectoriesInDomains(NSDocumentDirectory,
                                                NSUserDomainMask, YES).firstObject
        stringByAppendingPathComponent:@"clipso-diagnostics.log"];
    queue = dispatch_queue_create("com.mocinjay.clipso.swwdiag",
                                  DISPATCH_QUEUE_SERIAL);
  });
  if (path == nil) {
    return;
  }
  NSString *line = [NSString
      stringWithFormat:@"%@ [SpeechWakeWord] %@\n",
                       [[NSISO8601DateFormatter new] stringFromDate:[NSDate date]],
                       message];
  dispatch_async(queue, ^{
    NSData *data = [line dataUsingEncoding:NSUTF8StringEncoding];
    int fd = open(path.fileSystemRepresentation, O_WRONLY | O_APPEND | O_CREAT, 0644);
    if (fd < 0) {
      return;
    }
    write(fd, data.bytes, data.length);
    close(fd);
  });
}

// ASCII-only: a non-ASCII format string compiles to a UTF-16 CFString that
// `strings` cannot see, which makes it useless for verifying on-device builds.
#define SWWLog(fmt, ...)                                                       \
  do {                                                                         \
    NSLog(@"[SpeechWakeWord] %s:%d %s: " fmt,                                  \
          [[@(__FILE__) lastPathComponent] UTF8String], __LINE__, __func__,    \
          ##__VA_ARGS__);                                                      \
    SWWDiag([NSString stringWithFormat:fmt, ##__VA_ARGS__]);                   \
  } while (0)

/// A track that exists is not a track that has content: a writer input that
/// received no samples still leaves a track in the file.
static BOOL SWWTrackHasContent(AVAssetTrack *track)
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

/// Synchronously load `keys`; returns NO if any fails to load.
static BOOL SWWLoadAssetKeys(AVAsset *asset, NSArray<NSString *> *keys)
{
  dispatch_semaphore_t semaphore = dispatch_semaphore_create(0);
  [asset loadValuesAsynchronouslyForKeys:keys completionHandler:^{
    dispatch_semaphore_signal(semaphore);
  }];
  dispatch_semaphore_wait(semaphore, DISPATCH_TIME_FOREVER);

  for (NSString *key in keys) {
    if ([asset statusOfValueForKey:key error:NULL] != AVKeyValueStatusLoaded) {
      return NO;
    }
  }
  return YES;
}

/// Recognition sample rate. Speech downsamples to 16 kHz internally anyway, and
/// a 5s mono segment at this rate is ~160 KB, so the boosted copy is cheap.
static const double kSWWRecognitionSampleRate = 16000.0;
/// Target RMS for the boosted copy, ~-20 dBFS. Apple's voice-activity gate
/// rejects anything much quieter than this as silence.
static const float kSWWTargetRMS = 0.1f;
/// Never amplify beyond this. A segment of pure room tone has a tiny RMS, and
/// without a ceiling the gain would blow the noise floor up into something the
/// recognizer tries — and fails — to read as speech.
static const float kSWWMaxGain = 40.0f;
/// Leave headroom so the boost cannot clip.
static const float kSWWPeakCeiling = 0.95f;

/// Minimal 16-bit mono WAV container around already-scaled PCM.
static BOOL SWWWriteWAV(NSData *pcm, double sampleRate, NSURL *url)
{
  uint32_t dataBytes = (uint32_t)pcm.length;
  uint32_t sr = (uint32_t)sampleRate;
  uint16_t channels = 1, bitsPerSample = 16;
  uint32_t byteRate = sr * channels * bitsPerSample / 8;
  uint16_t blockAlign = channels * bitsPerSample / 8;
  uint32_t chunkSize = 36 + dataBytes;
  uint32_t fmtSize = 16;
  uint16_t audioFormat = 1;

  NSMutableData *out = [NSMutableData dataWithCapacity:44 + dataBytes];
  [out appendBytes:"RIFF" length:4];
  [out appendBytes:&chunkSize length:4];
  [out appendBytes:"WAVEfmt " length:8];
  [out appendBytes:&fmtSize length:4];
  [out appendBytes:&audioFormat length:2];
  [out appendBytes:&channels length:2];
  [out appendBytes:&sr length:4];
  [out appendBytes:&byteRate length:4];
  [out appendBytes:&blockAlign length:2];
  [out appendBytes:&bitsPerSample length:2];
  [out appendBytes:"data" length:4];
  [out appendBytes:&dataBytes length:4];
  [out appendData:pcm];
  return [out writeToURL:url atomically:YES];
}

/**
 * Renders a level-normalized 16 kHz mono copy of `asset`'s audio.
 *
 * The glasses expose no microphone, so wake-word audio comes from the phone —
 * typically in a pocket or on a table, several feet from the wearer's mouth.
 * Measured on real captures that lands around -34 LUFS, roughly 15 dB below
 * ordinary speech, and Apple's VAD front-end discards the whole segment with
 * kAFAssistantErrorDomain 1110 "No speech detected" before any transcription
 * happens. Boosting only this throwaway copy fixes detection while leaving the
 * audio muxed into the user's saved clip untouched.
 *
 * Normalizes on RMS rather than peak so a single cough or door slam cannot
 * swallow the gain that quiet speech needs, then backs the gain off if that
 * would push the peak into clipping.
 *
 * Returns nil if the asset has no readable audio; caller treats that as silence.
 */
static NSURL *SWWRenderBoostedAudio(AVAsset *asset, NSString *label)
{
  NSError *error = nil;
  AVAssetReader *reader = [[AVAssetReader alloc] initWithAsset:asset error:&error];
  if (reader == nil) {
    SWWLog(@"boost: reader init failed for %@ - %@", label, error.localizedDescription);
    return nil;
  }

  AVAssetTrack *track = [asset tracksWithMediaType:AVMediaTypeAudio].firstObject;
  if (track == nil) {
    return nil;
  }

  NSDictionary *settings = @{
    AVFormatIDKey : @(kAudioFormatLinearPCM),
    AVSampleRateKey : @(kSWWRecognitionSampleRate),
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
    SWWLog(@"boost: startReading failed for %@ - %@", label,
           reader.error.localizedDescription);
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

  if (reader.status == AVAssetReaderStatusFailed || pcm.length < 2) {
    SWWLog(@"boost: no PCM read for %@ (status=%ld)", label, (long)reader.status);
    return nil;
  }

  int16_t *samples = (int16_t *)pcm.mutableBytes;
  NSUInteger count = pcm.length / sizeof(int16_t);

  double sumSquares = 0.0;
  float peak = 0.0f;
  for (NSUInteger i = 0; i < count; i++) {
    float v = samples[i] / 32768.0f;
    sumSquares += (double)v * v;
    float a = fabsf(v);
    if (a > peak) {
      peak = a;
    }
  }
  float rms = (float)sqrt(sumSquares / (double)count);
  if (rms <= 0.0f || peak <= 0.0f) {
    return nil;
  }

  float gain = kSWWTargetRMS / rms;
  if (gain * peak > kSWWPeakCeiling) {
    gain = kSWWPeakCeiling / peak;
  }
  gain = MIN(gain, kSWWMaxGain);
  // Only ever amplify. Attenuating a segment that is already healthy would
  // just walk it back toward the VAD threshold.
  gain = MAX(gain, 1.0f);

  for (NSUInteger i = 0; i < count; i++) {
    float v = (samples[i] / 32768.0f) * gain;
    v = MAX(-1.0f, MIN(1.0f, v));
    samples[i] = (int16_t)lrintf(v * 32767.0f);
  }

  SWWLog(@"boost: %@ rms=%.5f peak=%.5f gain=%.2fx samples=%lu", label, rms, peak,
         gain, (unsigned long)count);

  NSURL *url = [NSURL fileURLWithPath:
                          [NSTemporaryDirectory()
                              stringByAppendingPathComponent:
                                  [NSString stringWithFormat:@"swwboost-%@.wav",
                                                             [[NSUUID UUID] UUIDString]]]];
  if (!SWWWriteWAV(pcm, kSWWRecognitionSampleRate, url)) {
    SWWLog(@"boost: WAV write failed for %@", label);
    return nil;
  }
  return url;
}

/**
 * Keyless wake-phrase detection using Apple's on-device Speech framework.
 *
 * Instead of fighting the camera for the microphone, JS feeds each rolling
 * 5s segment file here as it is recorded; we transcribe it (on-device when
 * the model is available) and JS matches "clipso" / "clip that" against the
 * text. No vendor, no API key, no audio-session conflict.
 */
@interface SpeechWakeWord : NSObject <RCTBridgeModule>
@property (nonatomic, strong) SFSpeechRecognizer *recognizer;
@property (nonatomic, strong) NSMutableSet<SFSpeechRecognitionTask *> *tasks;
- (void)recognizeURL:(NSURL *)url
            onDevice:(BOOL)onDevice
               label:(NSString *)label
          completion:(void (^)(NSString *text, NSError *error))completion;
@end

@implementation SpeechWakeWord

RCT_EXPORT_MODULE();

+ (BOOL)requiresMainQueueSetup
{
  return NO;
}

- (SFSpeechRecognizer *)recognizer
{
  if (_recognizer == nil) {
    _recognizer = [[SFSpeechRecognizer alloc]
        initWithLocale:[NSLocale localeWithLocaleIdentifier:@"en-US"]];
  }
  return _recognizer;
}

- (NSMutableSet<SFSpeechRecognitionTask *> *)tasks
{
  if (_tasks == nil) {
    _tasks = [NSMutableSet set];
  }
  return _tasks;
}

RCT_EXPORT_METHOD(requestPermission:(RCTPromiseResolveBlock)resolve
                  rejecter:(RCTPromiseRejectBlock)reject)
{
  [SFSpeechRecognizer
      requestAuthorization:^(SFSpeechRecognizerAuthorizationStatus status) {
        BOOL authorized = status == SFSpeechRecognizerAuthorizationStatusAuthorized;
        SFSpeechRecognizer *recognizer = self.recognizer;
        SWWLog(@"authorization status=%ld authorized=%d available=%d onDevice=%d",
               (long)status, authorized, recognizer.isAvailable,
               recognizer.supportsOnDeviceRecognition);
        resolve(@(authorized));
      }];
}

RCT_EXPORT_METHOD(transcribeFile:(NSString *)path
                  resolver:(RCTPromiseResolveBlock)resolve
                  rejecter:(RCTPromiseRejectBlock)reject)
{
  SFSpeechRecognizer *recognizer = self.recognizer;
  if (recognizer == nil || !recognizer.isAvailable) {
    SWWLog(@"recognizer unavailable (nil=%d) - cannot transcribe %@",
           recognizer == nil, path.lastPathComponent);
    reject(@"speech_unavailable",
           @"Speech recognition is not available on this device.", nil);
    return;
  }

  NSURL *url = [NSURL fileURLWithPath:path];

  // SFSpeechURLRecognitionRequest opens this file with its own AVAssetReader and
  // constructs an AVAssetReaderAudioMixOutput over whatever audio tracks it
  // finds. Handed a file with none, that initializer trips
  //     [audioTracks count] >= 1
  // which is an assertion, not a catchable error: it aborts the process from
  // Speech's own worker thread, so the crash appears on a different thread each
  // time and names no frame of ours. JS feeds every rolling segment through
  // here, and glasses segments are routinely video-only (the toolkit exposes no
  // microphone), so this is the normal path, not an edge case.
  //
  // The guard is "has content", not "exists": a writer input that received zero
  // samples still leaves a track behind, and reading it is equally invalid.
  if (![[NSFileManager defaultManager] fileExistsAtPath:path]) {
    SWWLog(@"file does not exist: %@ - treating as no speech", path.lastPathComponent);
    resolve(@"");
    return;
  }

  AVURLAsset *asset = [AVURLAsset URLAssetWithURL:url options:nil];
  if (!SWWLoadAssetKeys(asset, @[ @"tracks" ])) {
    SWWLog(@"could not load tracks for %@ - treating as no speech",
           path.lastPathComponent);
    resolve(@"");
    return;
  }

  NSArray<AVAssetTrack *> *audioTracks = [asset tracksWithMediaType:AVMediaTypeAudio];
  NSUInteger usableAudioTracks = 0;
  for (AVAssetTrack *track in audioTracks) {
    if (SWWTrackHasContent(track)) {
      usableAudioTracks += 1;
    }
  }
  SWWLog(@"source asset audio track count: %lu (usable=%lu) file=%@",
         (unsigned long)audioTracks.count, (unsigned long)usableAudioTracks,
         path.lastPathComponent);

  if (usableAudioTracks == 0) {
    SWWLog(@"skipping speech recognition: no usable audio track, so no "
           @"recognition request is created (video-only segment)");
    // No audio means no speech. Resolving empty matches the existing contract
    // for a silent segment, so JS keeps polling instead of seeing an error.
    resolve(@"");
    return;
  }

  NSString *label = path.lastPathComponent;
  // Recognize from a level-normalized copy, never the segment itself — the
  // saved clip must keep the audio the wearer actually recorded.
  NSURL *boosted = SWWRenderBoostedAudio(asset, label);
  NSURL *recognitionURL = boosted ?: url;

  void (^cleanup)(void) = ^{
    if (boosted != nil) {
      [[NSFileManager defaultManager] removeItemAtURL:boosted error:NULL];
    }
  };

  BOOL canRunOnDevice = recognizer.supportsOnDeviceRecognition;
  __weak SpeechWakeWord *weakSelf = self;
  [self recognizeURL:recognitionURL
            onDevice:canRunOnDevice
               label:label
          completion:^(NSString *text, NSError *error) {
            BOOL emptyResult = (error != nil || text.length == 0);
            // On-device is tried first because it is free, offline and private,
            // but its acoustic model is the stricter of the two and it largely
            // ignores contextualStrings — so "Clipso" gets no vocabulary help
            // there. When it comes back with nothing, one server retry gets
            // both a more forgiving model and real biasing toward the trigger.
            if (emptyResult && canRunOnDevice) {
              SWWLog(@"on-device found nothing for %@ - retrying server-side", label);
              SpeechWakeWord *strongSelf = weakSelf;
              if (strongSelf == nil) {
                cleanup();
                resolve(@"");
                return;
              }
              [strongSelf recognizeURL:recognitionURL
                              onDevice:NO
                                 label:label
                            completion:^(NSString *retryText, NSError *retryError) {
                              cleanup();
                              resolve(retryError != nil ? @"" : (retryText ?: @""));
                            }];
              return;
            }
            cleanup();
            resolve(error != nil ? @"" : (text ?: @""));
          }];
}

/// One recognition pass. Always calls `completion` exactly once.
- (void)recognizeURL:(NSURL *)url
            onDevice:(BOOL)onDevice
               label:(NSString *)label
          completion:(void (^)(NSString *text, NSError *error))completion
{
  SFSpeechRecognizer *recognizer = self.recognizer;
  SFSpeechURLRecognitionRequest *request =
      [[SFSpeechURLRecognitionRequest alloc] initWithURL:url];
  request.shouldReportPartialResults = NO;
  // Bias the recognizer toward our brand / trigger — "Clipso" is not in the
  // default vocabulary, so without hints it becomes "clip so" / "calypso" /
  // garbage. contextualStrings heavily favor these tokens in the lattice.
  // Brand only — biasing toward "clip that" would just make the recognizer
  // more likely to hear a phrase the matcher deliberately no longer acts on.
  request.contextualStrings = @[
    @"Clipso", @"clipso", @"yo Clipso", @"yo clipso", @"hey Clipso",
  ];
  request.taskHint = SFSpeechRecognitionTaskHintDictation;
  request.requiresOnDeviceRecognition = onDevice;

  __block BOOL settled = NO;
  __block SFSpeechRecognitionTask *task = nil;
  __weak SpeechWakeWord *weakSelf = self;
  task = [recognizer
      recognitionTaskWithRequest:request
                   resultHandler:^(SFSpeechRecognitionResult *result,
                                   NSError *error) {
                     if (settled) {
                       return;
                     }
                     if (error != nil) {
                       settled = YES;
                       // Silence / no-speech segments error out — that is
                       // the normal quiet case, not a failure. Log the code
                       // anyway: a recognizer that is failing for a real
                       // reason is otherwise indistinguishable from a quiet
                       // room, and both go silently unheard.
                       SWWLog(@"no transcript for %@ (onDevice=%d) - %@ [%@ %ld]",
                              label, onDevice, error.localizedDescription,
                              error.domain, (long)error.code);
                       completion(nil, error);
                     } else if (result != nil && result.isFinal) {
                       settled = YES;
                       NSString *text = result.bestTranscription.formattedString;
                       SWWLog(@"transcript for %@ (onDevice=%d): \"%@\"", label,
                              onDevice, text);
                       completion(text, nil);
                     } else {
                       return;
                     }
                     SpeechWakeWord *strongSelf = weakSelf;
                     if (strongSelf != nil && task != nil) {
                       @synchronized(strongSelf.tasks) {
                         [strongSelf.tasks removeObject:task];
                       }
                     }
                   }];
  if (task != nil) {
    // Retain the task for the duration of recognition.
    @synchronized(self.tasks) {
      [self.tasks addObject:task];
    }
  } else {
    // recognitionTaskWithRequest can return nil (e.g. server path with no
    // network). Without this the promise would never settle and the segment
    // would leak a pending JS promise on every rotation.
    if (!settled) {
      settled = YES;
      SWWLog(@"could not create recognition task for %@ (onDevice=%d)", label,
             onDevice);
      completion(nil, [NSError errorWithDomain:@"SpeechWakeWord" code:-1 userInfo:nil]);
    }
  }
}

@end
