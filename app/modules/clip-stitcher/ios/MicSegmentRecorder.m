#import "MicSegmentRecorder.h"

#import <AVFoundation/AVFoundation.h>
#import <fcntl.h>
#import <unistd.h>

/// Mirror into Documents/clypso-diagnostics.log alongside the speech and video
/// halves, so one pull off the device reads as a single timeline.
///
/// This path matters more than most: always-on listening is exercised with the
/// phone in a pocket, where the live console is not attached and a run that
/// went deaf looks exactly like a wearer who never spoke.
static void MSRDiag(NSString *message)
{
  static NSString *path;
  static dispatch_queue_t queue;
  static dispatch_once_t once;
  dispatch_once(&once, ^{
    path = [NSSearchPathForDirectoriesInDomains(NSDocumentDirectory,
                                                NSUserDomainMask, YES).firstObject
        stringByAppendingPathComponent:@"clypso-diagnostics.log"];
    queue = dispatch_queue_create("com.mocinjay.clypso.msrdiag",
                                  DISPATCH_QUEUE_SERIAL);
  });
  if (path == nil) {
    return;
  }
  NSString *line = [NSString
      stringWithFormat:@"%@ [MicSegmentRecorder] %@\n",
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

// ASCII-only format strings: a non-ASCII literal compiles to a UTF-16 CFString
// that `strings` cannot see, which makes it useless for verifying a build that
// is already installed on a device.
#define MSRLog(fmt, ...)                                                       \
  do {                                                                         \
    NSLog(@"[MicSegmentRecorder] %s:%d %s: " fmt,                              \
          [[@(__FILE__) lastPathComponent] UTF8String], __LINE__, __func__,    \
          ##__VA_ARGS__);                                                      \
    MSRDiag([NSString stringWithFormat:fmt, ##__VA_ARGS__]);                   \
  } while (0)

/// Loudest normalized sample in a float32 buffer, or 0 for anything else.
static float MSRPeakLevel(AVAudioPCMBuffer *buffer)
{
  float *const *channels = buffer.floatChannelData;
  if (channels == NULL) {
    return 0.0f;
  }
  float peak = 0.0f;
  AVAudioFrameCount const frames = buffer.frameLength;
  for (AVAudioChannelCount channel = 0; channel < buffer.format.channelCount; channel++) {
    float const *samples = channels[channel];
    for (AVAudioFrameCount frame = 0; frame < frames; frame++) {
      float const magnitude = fabsf(samples[frame]);
      if (magnitude > peak) {
        peak = magnitude;
      }
    }
  }
  return peak;
}

/**
 * Deep-copy a tap buffer so it can outlive the callback.
 *
 * The buffer handed to an input tap is reused by the engine the moment the
 * callback returns, so anything that defers work — as this class does, to keep
 * every file write on one queue — has to take its own copy first. The copy is
 * a memcpy per channel, which is cheaper than the encode it is protecting.
 */
static AVAudioPCMBuffer *MSRCopyBuffer(AVAudioPCMBuffer *source)
{
  AVAudioPCMBuffer *copy =
      [[AVAudioPCMBuffer alloc] initWithPCMFormat:source.format
                                    frameCapacity:source.frameLength];
  if (copy == nil) {
    return nil;
  }
  copy.frameLength = source.frameLength;
  float *const *from = source.floatChannelData;
  float *const *to = copy.floatChannelData;
  if (from == NULL || to == NULL) {
    return nil;
  }
  size_t const bytes = (size_t)source.frameLength * sizeof(float);
  for (AVAudioChannelCount channel = 0; channel < source.format.channelCount; channel++) {
    memcpy(to[channel], from[channel], bytes);
  }
  return copy;
}

@interface MicSegmentRecorder ()
@property (nonatomic, strong) AVAudioEngine *engine;
@property (nonatomic, strong, nullable) AVAudioFile *file;
@property (nonatomic, strong, nullable) NSString *filePath;
@property (nonatomic, assign) double fileStartedAtMs;
@property (nonatomic, assign) AVAudioFramePosition fileFrames;
@property (nonatomic, assign) float filePeak;
@property (nonatomic, assign) BOOL running;
@property (nonatomic, assign) BOOL tapInstalled;
@property (nonatomic, assign) NSTimeInterval segmentSeconds;
@property (nonatomic, assign) NSTimeInterval retentionSeconds;
@property (nonatomic, strong) dispatch_queue_t queue;
@property (nonatomic, copy) NSString *directory;
@end

@implementation MicSegmentRecorder

- (instancetype)initWithSegmentSeconds:(NSTimeInterval)segmentSeconds
                      retentionSeconds:(NSTimeInterval)retentionSeconds
{
  self = [super init];
  if (self == nil) {
    return nil;
  }
  _segmentSeconds = segmentSeconds > 0 ? segmentSeconds : 5.0;
  _retentionSeconds = retentionSeconds > 0 ? retentionSeconds : 900.0;
  _silenceThreshold = 0.01f;
  _engine = [[AVAudioEngine alloc] init];
  _queue = dispatch_queue_create("com.mocinjay.clypso.mic", DISPATCH_QUEUE_SERIAL);

  // Caches, not Documents: these are transient by design, and a day of
  // always-on listening has no business inflating the user's iCloud backup.
  // A purge under storage pressure costs alignment audio, never a marker —
  // markers live in JS, keyed by wall clock, not by these files.
  NSString *caches = NSSearchPathForDirectoriesInDomains(
                         NSCachesDirectory, NSUserDomainMask, YES).firstObject;
  _directory = [caches stringByAppendingPathComponent:@"clypso-wake"];
  [[NSFileManager defaultManager] createDirectoryAtPath:_directory
                            withIntermediateDirectories:YES
                                             attributes:nil
                                                  error:NULL];
  return self;
}

- (void)dealloc
{
  [[NSNotificationCenter defaultCenter] removeObserver:self];
}

#pragma mark - Lifecycle

- (BOOL)start
{
  __block BOOL started = NO;
  dispatch_sync(self.queue, ^{
    if (self.running) {
      started = YES;
      return;
    }
    started = [self startEngineLocked];
    if (started) {
      self.running = YES;
      [self sweepExpiredLocked];
    }
  });
  if (started) {
    [self observeAudioNotifications];
  }
  return started;
}

- (void)stop
{
  [[NSNotificationCenter defaultCenter] removeObserver:self];
  dispatch_sync(self.queue, ^{
    if (!self.running) {
      return;
    }
    self.running = NO;
    [self teardownEngineLocked];
    [self closeSegmentLocked];
    MSRLog(@"stopped");
  });
}

- (BOOL)startEngineLocked
{
  AVAudioSession *session = [AVAudioSession sharedInstance];

  // `.record` rather than `.playAndRecord`: this recorder never plays
  // anything, and claiming the output is what makes a session activation lose
  // to whatever already holds it. `mixWithOthers` keeps someone else's music
  // playing — including music routed to the glasses over A2DP, which the
  // wearer is quite likely to have going.
  //
  // Bluetooth options are deliberately absent. Selecting the glasses' own
  // microphone renegotiates their link into narrowband HFP; the video writer
  // learned that the hard way when it starved the camera stream, and here the
  // risk is worse — HFP while the glasses are recording on-device may disturb
  // the recording we are trying to stay out of the way of.
  NSError *error = nil;
  if (![session setCategory:AVAudioSessionCategoryRecord
                       mode:AVAudioSessionModeDefault
                    options:AVAudioSessionCategoryOptionMixWithOthers
                      error:&error]) {
    MSRLog(@"set category FAILED - %@ [%@ %ld]", error.localizedDescription,
           error.domain, (long)error.code);
    [self reportError:@"Could not configure the audio session for listening."];
    return NO;
  }
  if (![session setActive:YES error:&error]) {
    MSRLog(@"session activation FAILED - %@ [%@ %ld]", error.localizedDescription,
           error.domain, (long)error.code);
    [self reportError:@"Could not activate the microphone."];
    return NO;
  }

  for (AVAudioSessionPortDescription *input in session.availableInputs) {
    if ([input.portType isEqualToString:AVAudioSessionPortBuiltInMic]) {
      [session setPreferredInput:input error:NULL];
      break;
    }
  }

  AVAudioInputNode *input = self.engine.inputNode;
  AVAudioFormat *format = [input outputFormatForBus:0];
  if (format.sampleRate <= 0 || format.channelCount == 0) {
    MSRLog(@"no usable input format (%.0fHz ch=%u)", format.sampleRate,
           (unsigned)format.channelCount);
    [self reportError:@"No microphone input is available."];
    return NO;
  }
  if (format.commonFormat != AVAudioPCMFormatFloat32) {
    // Every tap on inputNode delivers float32 in practice; bail loudly rather
    // than silently writing garbage if that ever stops being true.
    MSRLog(@"unexpected tap format %ld - refusing to record",
           (long)format.commonFormat);
    [self reportError:@"The microphone returned an unsupported audio format."];
    return NO;
  }

  __weak MicSegmentRecorder *weakSelf = self;
  [input removeTapOnBus:0];
  [input installTapOnBus:0
             bufferSize:1024
                 format:format
                  block:^(AVAudioPCMBuffer *buffer, AVAudioTime *when) {
                    MicSegmentRecorder *strongSelf = weakSelf;
                    if (strongSelf == nil) {
                      return;
                    }
                    float const peak = MSRPeakLevel(buffer);
                    AVAudioPCMBuffer *copy = MSRCopyBuffer(buffer);
                    if (copy == nil) {
                      return;
                    }
                    dispatch_async(strongSelf.queue, ^{
                      [strongSelf appendLocked:copy peak:peak];
                    });
                  }];
  self.tapInstalled = YES;

  [self.engine prepare];
  if (![self.engine startAndReturnError:&error]) {
    [input removeTapOnBus:0];
    self.tapInstalled = NO;
    MSRLog(@"engine start FAILED - %@ [%@ %ld]", error.localizedDescription,
           error.domain, (long)error.code);
    [self reportError:@"Could not start listening."];
    return NO;
  }

  NSMutableArray<NSString *> *routes = [NSMutableArray array];
  for (AVAudioSessionPortDescription *port in session.currentRoute.inputs) {
    [routes addObject:port.portType];
  }
  MSRLog(@"listening: %.0fHz ch=%u route=%@", format.sampleRate,
         (unsigned)format.channelCount, [routes componentsJoinedByString:@","]);
  return YES;
}

- (void)teardownEngineLocked
{
  if (self.tapInstalled) {
    [self.engine.inputNode removeTapOnBus:0];
    self.tapInstalled = NO;
  }
  if (self.engine.isRunning) {
    [self.engine stop];
  }
  [[AVAudioSession sharedInstance] setActive:NO
                                 withOptions:AVAudioSessionSetActiveOptionNotifyOthersOnDeactivation
                                       error:NULL];
}

#pragma mark - Recording

- (void)appendLocked:(AVAudioPCMBuffer *)buffer peak:(float)peak
{
  if (!self.running) {
    return;
  }
  if (self.file == nil && ![self openSegmentLocked:buffer.format]) {
    return;
  }

  NSError *error = nil;
  if (![self.file writeFromBuffer:buffer error:&error]) {
    MSRLog(@"write FAILED - %@ [%@ %ld]", error.localizedDescription,
           error.domain, (long)error.code);
    // Drop the partial file and start clean on the next buffer rather than
    // accumulating into a segment the recognizer will choke on.
    [self discardSegmentLocked];
    return;
  }

  self.fileFrames += buffer.frameLength;
  if (peak > self.filePeak) {
    self.filePeak = peak;
  }

  double const elapsed = (double)self.fileFrames / buffer.format.sampleRate;
  if (elapsed >= self.segmentSeconds) {
    [self closeSegmentLocked];
    [self sweepExpiredLocked];
  }
}

- (BOOL)openSegmentLocked:(AVAudioFormat *)format
{
  double const nowMs = [[NSDate date] timeIntervalSince1970] * 1000.0;
  NSString *name = [NSString stringWithFormat:@"wake-%.0f.m4a", nowMs];
  NSString *path = [self.directory stringByAppendingPathComponent:name];

  // AAC keeps a day of listening to a few hundred megabytes at worst, and the
  // recognizer is unbothered by it. Mono where the input allows: the trigger
  // word carries no stereo information worth twice the bytes.
  NSDictionary *settings = @{
    AVFormatIDKey : @(kAudioFormatMPEG4AAC),
    AVSampleRateKey : @(format.sampleRate),
    AVNumberOfChannelsKey : @(MIN(format.channelCount, 1u)),
    AVEncoderBitRateKey : @(32000),
  };

  NSError *error = nil;
  AVAudioFile *file = [[AVAudioFile alloc] initForWriting:[NSURL fileURLWithPath:path]
                                                 settings:settings
                                             commonFormat:AVAudioPCMFormatFloat32
                                              interleaved:NO
                                                    error:&error];
  if (file == nil) {
    MSRLog(@"could not open segment - %@ [%@ %ld]", error.localizedDescription,
           error.domain, (long)error.code);
    [self reportError:@"Could not write audio to disk."];
    return NO;
  }

  self.file = file;
  self.filePath = path;
  self.fileStartedAtMs = nowMs;
  self.fileFrames = 0;
  self.filePeak = 0.0f;
  return YES;
}

/**
 * Finalize the open segment and hand it to `onSegment`.
 *
 * AVAudioFile flushes and closes when it is released, so the reference is
 * cleared before the path is published — a consumer that opened the file the
 * instant it was told about it would otherwise race the encoder's last write.
 */
- (void)closeSegmentLocked
{
  if (self.file == nil) {
    return;
  }
  NSString *path = self.filePath;
  double const startedAtMs = self.fileStartedAtMs;
  double const sampleRate = self.file.fileFormat.sampleRate;
  double const duration =
      sampleRate > 0 ? (double)self.fileFrames / sampleRate : 0.0;
  float const peak = self.filePeak;

  self.file = nil;
  self.filePath = nil;
  self.fileFrames = 0;
  self.filePeak = 0.0f;

  if (path == nil || duration <= 0) {
    return;
  }

  // A segment of room tone cannot contain the trigger word, and transcription
  // is the expensive half of always-on listening. Dropping it here is what
  // makes a whole day of it affordable.
  if (peak < self.silenceThreshold) {
    [[NSFileManager defaultManager] removeItemAtPath:path error:NULL];
    return;
  }

  if (self.onSegment != nil) {
    self.onSegment(path, startedAtMs, duration, peak);
  }
}

- (void)discardSegmentLocked
{
  NSString *path = self.filePath;
  self.file = nil;
  self.filePath = nil;
  self.fileFrames = 0;
  self.filePeak = 0.0f;
  if (path != nil) {
    [[NSFileManager defaultManager] removeItemAtPath:path error:NULL];
  }
}

/// Delete delivered segments past the retention window.
- (void)sweepExpiredLocked
{
  NSFileManager *fm = [NSFileManager defaultManager];
  NSArray<NSString *> *names = [fm contentsOfDirectoryAtPath:self.directory error:NULL];
  if (names == nil) {
    return;
  }
  double const cutoffMs =
      ([[NSDate date] timeIntervalSince1970] - self.retentionSeconds) * 1000.0;
  for (NSString *name in names) {
    if (![name hasPrefix:@"wake-"]) {
      continue;
    }
    // The wall clock is in the filename, so expiry costs no stat() calls.
    double const stampedMs = [[name substringFromIndex:5] doubleValue];
    if (stampedMs > 0 && stampedMs < cutoffMs) {
      [fm removeItemAtPath:[self.directory stringByAppendingPathComponent:name]
                     error:NULL];
    }
  }
}

- (void)reportError:(NSString *)message
{
  if (self.onError != nil) {
    self.onError(message);
  }
}

#pragma mark - Staying alive

/**
 * Always-on listening spends most of its life backgrounded, where the things
 * that stop an audio engine are routine rather than exceptional: a phone call
 * arrives, headphones are unplugged, the system swaps the input out from under
 * the engine. None of these report themselves as errors — the tap simply stops
 * being called, and the trigger word goes unheard with nothing logged.
 */
- (void)observeAudioNotifications
{
  NSNotificationCenter *center = [NSNotificationCenter defaultCenter];
  [center removeObserver:self];
  [center addObserver:self
             selector:@selector(handleInterruption:)
                 name:AVAudioSessionInterruptionNotification
               object:nil];
  [center addObserver:self
             selector:@selector(handleRouteChange:)
                 name:AVAudioSessionRouteChangeNotification
               object:nil];
  [center addObserver:self
             selector:@selector(handleEngineConfigurationChange:)
                 name:AVAudioEngineConfigurationChangeNotification
               object:self.engine];
}

- (void)handleInterruption:(NSNotification *)note
{
  NSUInteger const type =
      [note.userInfo[AVAudioSessionInterruptionTypeKey] unsignedIntegerValue];
  if (type == AVAudioSessionInterruptionTypeBegan) {
    MSRLog(@"interrupted - listening paused");
    dispatch_async(self.queue, ^{
      // Close what we have rather than leaving a segment straddling the
      // interruption, which would put silence where the trigger might be.
      [self closeSegmentLocked];
    });
    return;
  }
  NSUInteger const options =
      [note.userInfo[AVAudioSessionInterruptionOptionKey] unsignedIntegerValue];
  if ((options & AVAudioSessionInterruptionOptionShouldResume) == 0) {
    MSRLog(@"interruption ended without a resume hint - restarting anyway");
  }
  [self restart];
}

- (void)handleRouteChange:(NSNotification *)note
{
  NSUInteger const reason =
      [note.userInfo[AVAudioSessionRouteChangeReasonKey] unsignedIntegerValue];
  if (reason != AVAudioSessionRouteChangeReasonOldDeviceUnavailable &&
      reason != AVAudioSessionRouteChangeReasonNewDeviceAvailable &&
      reason != AVAudioSessionRouteChangeReasonOverride) {
    return;
  }
  MSRLog(@"route changed (reason=%lu) - rebuilding the tap", (unsigned long)reason);
  [self restart];
}

- (void)handleEngineConfigurationChange:(NSNotification *)note
{
  MSRLog(@"engine configuration changed - rebuilding the tap");
  [self restart];
}

/// Bring the engine back on the same session, preserving `running`.
- (void)restart
{
  dispatch_async(self.queue, ^{
    if (!self.running) {
      return;
    }
    [self teardownEngineLocked];
    [self closeSegmentLocked];
    if (![self startEngineLocked]) {
      MSRLog(@"restart FAILED - the trigger word is not being heard");
      [self reportError:@"Listening stopped and could not be restarted."];
      self.running = NO;
    }
  });
}

@end
