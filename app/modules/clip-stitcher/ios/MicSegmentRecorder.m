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
    // Deliberately outside the `running` check. A recorder that gave up on its
    // own — the restart budget ran out — is already not running, and returning
    // early on that would leave its session active with nobody left who intends
    // to close it.
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
 * threw, because those are different questions: asking for `.record` with
 * `mixWithOthers` — which is what this did, and which Apple documents only for
 * the playback categories — set the category and activated without an error
 * anywhere, then routed no input at all. On device that reads
 * `available=1 routed=0 ch=0`: the hardware is there, the session simply never
 * attached it, and the engine that follows has nothing to listen to.
 *
 * Bluetooth options are deliberately absent. Selecting the glasses' own
 * microphone renegotiates their link into narrowband HFP; the video writer
 * learned that the hard way when it starved the camera stream, and here the
 * risk is worse — HFP while the glasses are recording on-device may disturb
 * the recording we are trying to stay out of the way of.
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

  // Ask for one channel. The trigger word carries nothing stereo, and the
  // iPhone's built-in mic will hand back two on some routes — which used to
  // matter only as wasted bytes, until the segment file was pinned to mono and
  // `writeFromBuffer:` started raising on the mismatch. A preference, not a
  // guarantee: `openSegmentLocked` follows the format the tap actually
  // delivers, so this is an optimisation rather than the correctness fix.
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

  // `.playAndRecord` first because it is the configuration `MWDATSegmentWriter`
  // already proves works in this process — it reaches the built-in mic at 48kHz
  // mono while the glasses stream is running. It does claim the output, which
  // is what makes an activation lose to whatever already holds it, so `.record`
  // stays as a second rung that claims less. `mixWithOthers` keeps someone
  // else's music playing — including music routed to the glasses over A2DP,
  // which the wearer is quite likely to have going — and is dropped from the
  // fallback because paired with `.record` it is the very thing that silently
  // produced a session with no microphone in it.
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
    // The session's own view of the input alongside the node's. When these
    // disagree the fault is in the engine; when they agree — `0Hz ch=2` beside
    // `routed=0` — it is the session, which is what sent the first three
    // guesses at this bug in the wrong direction.
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
  // The rung is in the line because it is the difference between "the mic
  // opened" and "the mic opened on the configuration that claims the output
  // too", and a session pulled out from under this recorder later on reads
  // completely differently depending on which one it was.
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
 * Deactivating belongs to `stop`, not here. This runs on every restart, and a
 * restart is followed immediately by an activation, so deactivating in between
 * bought nothing and cost two things: it notified every other audio client in
 * the system that the field was clear, twice per recovery, and — because
 * `AVAudioSession` is one shared object per process, not one per owner — it
 * pulled the session out from under whatever else in this app happened to be
 * holding it. `MWDATSegmentWriter` holds the same session whenever the glasses
 * stream is running, and losing it there is a video session that dies for a
 * reason nothing in its own logs can explain.
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
  // The channel count follows the tap rather than being pinned to mono. It was
  // pinned, for a good reason — the trigger word carries no stereo information
  // worth twice the bytes — but `writeFromBuffer:` raises
  // NSInvalidArgumentException when the buffer's channel count and the file's
  // processing format disagree, and it is the input route that decides the
  // buffer, not us. A phone that hands back a two-channel built-in mic (which
  // `activateSessionLocked` asks it not to, and which it may do anyway) turned
  // always-on listening into a crash on the first buffer. The saving is asked
  // for at the session and accepted here if it is granted; the bit rate scales
  // so a stereo segment is not encoded at half the quality per channel.
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
  // mediaserverd can be restarted out from under the process. Every object
  // above is left holding a handle to a server that no longer exists: the tap
  // simply stops being called, the engine still reports itself as running, and
  // no interruption or route change is posted. On an always-on path that is the
  // worst failure shape there is — hours of listening to nothing, with a
  // healthy-looking recorder. Apple's documented remedy is to rebuild
  // everything, which is what `restart` already does.
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
