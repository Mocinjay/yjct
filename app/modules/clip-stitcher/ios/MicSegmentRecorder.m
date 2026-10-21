#import "MicSegmentRecorder.h"

#import <AVFoundation/AVFoundation.h>

#import "CSDiagnostics.h"

// Glasses-only listening runs with the phone in a pocket and no console
// attached, where a recorder that went deaf looks exactly like a wearer who
// never spoke. Every line also goes to the diagnostics file.
#define MSRLog(fmt, ...) CSLog(@"MicSegmentRecorder", fmt, ##__VA_ARGS__)

/**
 * Restart budget for the self-healing path.
 *
 * Every recovery in this class ends in `restart`, and each restart tears the
 * engine down and brings it back — which is itself a configuration change. If
 * the cause is standing rather than transient (another process holding the
 * input, a route that keeps renegotiating), that is a loop that spins the CPU
 * for as long as the app is armed, in the background, on battery, and reports
 * nothing but its own churn.
 *
 * Five in ten seconds is far more than any real sequence of interruptions and
 * route changes produces, and far less than a loop sustains for even a second.
 * Past it the recorder stops and says so, which is the honest outcome: a
 * trigger word that is not being heard should look broken, not busy.
 */
static NSUInteger const kMSRMaxRestartsPerWindow = 5;
static NSTimeInterval const kMSRRestartWindowSeconds = 10.0;

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
/// The category the live session was actually brought up on, for the log.
@property (nonatomic, copy, nullable) NSString *activeCategory;
/// Restarts inside the current window, and when that window opened.
@property (nonatomic, assign) NSUInteger restartsInWindow;
@property (nonatomic, assign) NSTimeInterval restartWindowOpenedAt;
/// Set while a restart is already queued, so a burst collapses into one.
@property (nonatomic, assign) BOOL restartPending;
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
  // No engine yet — see `startEngineLocked` for why it cannot be built until
  // the audio session is active.
  _queue = dispatch_queue_create("com.mocinjay.clipso.mic", DISPATCH_QUEUE_SERIAL);

  // Caches, not Documents: these are transient, and a day of listening has no
  // business inflating the user's iCloud backup. A purge under storage
  // pressure costs alignment audio, never a marker: markers live in JS, keyed
  // by wall clock, not by these files.
  NSString *caches = NSSearchPathForDirectoriesInDomains(
                         NSCachesDirectory, NSUserDomainMask, YES).firstObject;
  _directory = [caches stringByAppendingPathComponent:@"clipso-wake"];
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
    } else {
      // The session may have activated even though the engine did not start,
      // and nothing else will ever come back for it: `SpeechWakeWord` drops the
      // recorder on a failed start, and `dealloc` only unhooks notifications.
      // Left active it holds the input route and keeps whatever it interrupted
      // from resuming, for the life of the process.
      [self deactivateSessionLocked];
    }
  });
  return started;
}

- (void)stop
{
  [[NSNotificationCenter defaultCenter] removeObserver:self];
  dispatch_sync(self.queue, ^{
    // Deliberately outside the `running` check: a recorder that gave up on its
    // own (restart budget spent) is already not running, and its session still
    // has to be handed back.
    BOOL const wasRunning = self.running;
    self.running = NO;
    [self teardownEngineLocked];
    [self closeSegmentLocked];
    [self deactivateSessionLocked];
    if (wasRunning) {
      MSRLog(@"stopped");
    }
  });
}

/**
 * Hand the session back, once.
 *
 * `NotifyOthersOnDeactivation` is what lets a music app that was ducked or
 * paused pick up again, and it is only honest at the points where this really
 * is finished with the microphone — never on a restart, where the field is not
 * actually clear. Keyed on `activeCategory` so it is idempotent and so a
 * session that was never brought up is not deactivated out from under whatever
 * else in the process may be holding one.
 */
- (void)deactivateSessionLocked
{
  if (self.activeCategory == nil) {
    return;
  }
  self.activeCategory = nil;
  [[AVAudioSession sharedInstance]
              setActive:NO
            withOptions:AVAudioSessionSetActiveOptionNotifyOthersOnDeactivation
                  error:NULL];
}

/**
 * Bring the session up with a microphone actually attached to it.
 *
 * Judged on whether the route ends up with an input, not on whether the calls
 * threw. `.record` with `mixWithOthers` (documented only for the playback
 * categories) sets the category and activates without an error, then routes no
 * input at all: on device that reads `available=1 routed=0 ch=0`.
 *
 * Bluetooth options are deliberately absent. Selecting the glasses' own
 * microphone renegotiates their link into narrowband HFP, which starves the
 * camera stream in live mode and may disturb an on-glasses recording here.
 */
- (BOOL)activateSessionLocked:(AVAudioSessionCategory)category
                      options:(AVAudioSessionCategoryOptions)options
{
  AVAudioSession *session = [AVAudioSession sharedInstance];
  NSError *error = nil;
  if (![session setCategory:category
                       mode:AVAudioSessionModeDefault
                    options:options
                      error:&error]) {
    MSRLog(@"%@: set category FAILED - %@ [%@ %ld]", category,
           error.localizedDescription, error.domain, (long)error.code);
    return NO;
  }
  if (![session setActive:YES error:&error]) {
    MSRLog(@"%@: activation FAILED - %@ [%@ %ld]", category,
           error.localizedDescription, error.domain, (long)error.code);
    return NO;
  }

  for (AVAudioSessionPortDescription *input in session.availableInputs) {
    if ([input.portType isEqualToString:AVAudioSessionPortBuiltInMic]) {
      [session setPreferredInput:input error:NULL];
      break;
    }
  }

  // Ask for one channel: the trigger word carries nothing stereo. A
  // preference, not a guarantee; `openSegmentLocked` follows the format the
  // tap actually delivers.
  [session setPreferredInputNumberOfChannels:1 error:NULL];

  if (session.currentRoute.inputs.count == 0) {
    MSRLog(@"%@: activated but no input was routed (available=%d ch=%ld)",
           category, session.isInputAvailable,
           (long)session.inputNumberOfChannels);
    return NO;
  }
  return YES;
}

- (BOOL)startEngineLocked
{
  AVAudioSession *session = [AVAudioSession sharedInstance];
  NSError *error = nil;

  // `.playAndRecord` first: it is the configuration `MWDATSegmentWriter` uses
  // in this process, and it reaches the built-in mic at 48kHz mono. It also
  // claims the output, which can lose to whatever already holds it, so
  // `.record` is a second rung that claims less. `mixWithOthers` keeps the
  // wearer's music playing (often routed to the glasses over A2DP); it is left
  // off the fallback because with `.record` it yields a session with no input.
  if ([self activateSessionLocked:AVAudioSessionCategoryPlayAndRecord
                          options:AVAudioSessionCategoryOptionMixWithOthers |
                                  AVAudioSessionCategoryOptionDefaultToSpeaker]) {
    self.activeCategory = AVAudioSessionCategoryPlayAndRecord;
  } else if ([self activateSessionLocked:AVAudioSessionCategoryRecord options:0]) {
    self.activeCategory = AVAudioSessionCategoryRecord;
  } else {
    self.activeCategory = nil;
    [self reportError:@"The microphone could not be opened for listening."];
    return NO;
  }

  // Built here, and rebuilt on every start, rather than once in `init`: the
  // engine's input node reads its format from the session as it stands when
  // the node is first materialised, and never refreshes it. Held across a
  // restart it would keep describing whatever route it was born on, which is
  // the wrong thing to be holding on a path whose whole job is to survive
  // route changes and interruptions.
  self.engine = [[AVAudioEngine alloc] init];

  AVAudioInputNode *input = self.engine.inputNode;
  AVAudioFormat *format = [input outputFormatForBus:0];
  if (format.sampleRate <= 0 || format.channelCount == 0) {
    // The session's view of the input alongside the node's: when they
    // disagree the fault is in the engine, when they agree (`0Hz ch=2` beside
    // `routed=0`) it is the session.
    MSRLog(@"no usable input format (%.0fHz ch=%u) - session available=%d "
           @"routed=%lu rate=%.0fHz ch=%ld",
           format.sampleRate, (unsigned)format.channelCount,
           session.isInputAvailable,
           (unsigned long)session.currentRoute.inputs.count, session.sampleRate,
           (long)session.inputNumberOfChannels);
    [self reportError:session.isInputAvailable
                   ? @"The microphone could not be opened for listening."
                   : @"No microphone input is available."];
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
  // The category is in the line: a session pulled out from under this
  // recorder later reads differently depending on which rung it came up on.
  MSRLog(@"listening: %.0fHz ch=%u category=%@ route=%@", format.sampleRate,
         (unsigned)format.channelCount, self.activeCategory,
         [routes componentsJoinedByString:@","]);
  // Re-observed on every start, not once in `start`, because the
  // configuration-change notification is scoped to a specific engine object
  // and a new one exists now. Registered after the engine is running so the
  // change that starting it provokes does not bounce straight back in here.
  [self observeAudioNotifications];
  return YES;
}

/**
 * Take the engine down and leave the session exactly as it is.
 *
 * Deactivating belongs to `stop`, not here. This runs on every restart, which
 * is followed immediately by an activation; deactivating in between would tell
 * every other audio client the field is clear, and, since `AVAudioSession` is
 * one object per process, pull the session from under anything else in the app
 * that holds it.
 */
- (void)teardownEngineLocked
{
  if (self.tapInstalled) {
    [self.engine.inputNode removeTapOnBus:0];
    self.tapInstalled = NO;
  }
  if (self.engine.isRunning) {
    [self.engine stop];
  }
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
  // recognizer is unbothered by it.
  //
  // The channel count follows the tap rather than being pinned to mono:
  // `writeFromBuffer:` raises when the buffer's channel count and the file's
  // processing format disagree, and the input route decides the buffer. The
  // bit rate scales so a stereo segment keeps its per-channel quality.
  AVAudioChannelCount const channels = MAX(format.channelCount, (AVAudioChannelCount)1);
  NSDictionary *settings = @{
    AVFormatIDKey : @(kAudioFormatMPEG4AAC),
    AVSampleRateKey : @(format.sampleRate),
    AVNumberOfChannelsKey : @(channels),
    AVEncoderBitRateKey : @(32000 * (NSInteger)channels),
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
  // is the expensive half of listening, so quiet segments are dropped here.
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
 * Listening spends most of its life backgrounded, where the things that stop
 * an audio engine are routine: a call arrives, headphones are unplugged, the
 * system swaps the input. None reports itself as an error; the tap simply
 * stops being called. Each is observed here and ends in a restart.
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
  // mediaserverd can be restarted under the process, leaving every object
  // above holding a dead handle: the tap stops, the engine still reports
  // running, and nothing else is posted. Apple's remedy is to rebuild
  // everything, which is what `restart` does.
  [center addObserver:self
             selector:@selector(handleMediaServicesReset:)
                 name:AVAudioSessionMediaServicesWereResetNotification
               object:nil];
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

- (void)handleMediaServicesReset:(NSNotification *)note
{
  MSRLog(@"media services were reset - rebuilding the session and the tap");
  // The session's own category is gone with the server, so the rung has to be
  // re-negotiated from scratch rather than assumed to still be held.
  dispatch_async(self.queue, ^{
    self.activeCategory = nil;
  });
  [self restart];
}

/**
 * Bring the engine back on the same session, preserving `running`.
 *
 * Coalesced and budgeted. Every recovery path in this class lands here, and
 * several of them can fire for one physical event — unplugging headphones
 * posts a route change, and the teardown that follows posts a configuration
 * change of its own. Without the coalescing that is a restart per notification
 * rebuilding an engine that the previous restart is still building; without the
 * budget, a cause that does not clear is an unbounded loop on battery.
 */
- (void)restart
{
  dispatch_async(self.queue, ^{
    if (!self.running || self.restartPending) {
      return;
    }
    self.restartPending = YES;
    // Deliberately a second hop: notifications for one physical event arrive
    // back to back, and letting them all land on the queue before any restart
    // runs is what turns a burst into a single rebuild.
    dispatch_async(self.queue, ^{
      self.restartPending = NO;
      if (!self.running) {
        return;
      }
      if (![self chargeRestartLocked]) {
        return;
      }
      [self teardownEngineLocked];
      [self closeSegmentLocked];
      if (![self startEngineLocked]) {
        MSRLog(@"restart FAILED - the trigger word is not being heard");
        self.running = NO;
        // Same reasoning as the failed first start: whatever the session got
        // as far as activating has to be handed back here, because there is no
        // longer anything in this object that intends to come back for it.
        [self deactivateSessionLocked];
        [self reportError:@"Listening stopped and could not be restarted."];
      }
    });
  });
}

/**
 * Spend one restart from the current window, or stop.
 *
 * Returns NO once the budget is gone, having already torn the recorder down —
 * the caller must not proceed. Stopping rather than throttling is deliberate:
 * a recorder restarting five times in ten seconds is not recovering, and the
 * wearer needs to be told the trigger word is not being heard rather than left
 * with something that looks alive.
 */
- (BOOL)chargeRestartLocked
{
  NSTimeInterval const now = [NSDate date].timeIntervalSince1970;
  if (now - self.restartWindowOpenedAt > kMSRRestartWindowSeconds) {
    self.restartWindowOpenedAt = now;
    self.restartsInWindow = 0;
  }
  self.restartsInWindow += 1;
  if (self.restartsInWindow <= kMSRMaxRestartsPerWindow) {
    return YES;
  }

  MSRLog(@"%lu restarts in %.0fs - giving up rather than looping",
         (unsigned long)self.restartsInWindow, kMSRRestartWindowSeconds);
  self.running = NO;
  [self teardownEngineLocked];
  [self closeSegmentLocked];
  [self deactivateSessionLocked];
  [self reportError:@"Listening kept failing and has stopped."];
  return NO;
}

@end
