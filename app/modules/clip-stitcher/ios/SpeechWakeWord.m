#import <AVFoundation/AVFoundation.h>
#import <React/RCTBridgeModule.h>
#import <Speech/Speech.h>

// ASCII-only: a non-ASCII format string compiles to a UTF-16 CFString that
// `strings` cannot see, which makes it useless for verifying on-device builds.
#define SWWLog(fmt, ...)                                                       \
  NSLog(@"[SpeechWakeWord] %s:%d %s: " fmt,                                    \
        [[@(__FILE__) lastPathComponent] UTF8String], __LINE__, __func__,      \
        ##__VA_ARGS__)

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

/**
 * Keyless wake-phrase detection using Apple's on-device Speech framework.
 *
 * Instead of fighting the camera for the microphone, JS feeds each rolling
 * 5s segment file here as it is recorded; we transcribe it (on-device when
 * the model is available) and JS matches "jarvis" / "clip that" against the
 * text. No vendor, no API key, no audio-session conflict.
 */
@interface SpeechWakeWord : NSObject <RCTBridgeModule>
@property (nonatomic, strong) SFSpeechRecognizer *recognizer;
@property (nonatomic, strong) NSMutableSet<SFSpeechRecognitionTask *> *tasks;
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
        resolve(@(status == SFSpeechRecognizerAuthorizationStatusAuthorized));
      }];
}

RCT_EXPORT_METHOD(transcribeFile:(NSString *)path
                  resolver:(RCTPromiseResolveBlock)resolve
                  rejecter:(RCTPromiseRejectBlock)reject)
{
  SFSpeechRecognizer *recognizer = self.recognizer;
  if (recognizer == nil || !recognizer.isAvailable) {
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

  SFSpeechURLRecognitionRequest *request =
      [[SFSpeechURLRecognitionRequest alloc] initWithURL:url];
  request.shouldReportPartialResults = NO;
  if (recognizer.supportsOnDeviceRecognition) {
    // Keeps detection free, offline, and private.
    request.requiresOnDeviceRecognition = YES;
  }

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
                       // the normal quiet case, not a failure.
                       resolve(@"");
                     } else if (result != nil && result.isFinal) {
                       settled = YES;
                       resolve(result.bestTranscription.formattedString);
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
  }
}

@end
