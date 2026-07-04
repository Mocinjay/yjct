#import <React/RCTBridgeModule.h>
#import <Speech/Speech.h>

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

  SFSpeechURLRecognitionRequest *request =
      [[SFSpeechURLRecognitionRequest alloc]
          initWithURL:[NSURL fileURLWithPath:path]];
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
