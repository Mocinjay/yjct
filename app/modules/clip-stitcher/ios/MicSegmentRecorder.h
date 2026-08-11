#import <Foundation/Foundation.h>

NS_ASSUME_NONNULL_BEGIN

/**
 * Rolling microphone recorder that exists purely to feed the wake word.
 *
 * Until now the only thing on iOS that opened a microphone was
 * `MWDATSegmentWriter`, and the wake word rode along on the audio track of the
 * video segments it wrote. That coupling is invisible until you remove the
 * glasses stream: with no DAT session there are no segments, and with no
 * segments the trigger word is never heard. This class is the other half of
 * that split — it owns a microphone and nothing else, so "listen for Clypso"
 * no longer implies "stream video from the glasses".
 *
 * It writes short AAC/m4a files and hands each one back as it closes. Short
 * files are not an accident of the old design worth discarding: a single
 * `SFSpeechRecognitionTask` is terminated by the system after roughly a
 * minute of continuous audio, and a file per rotation sidesteps that ceiling
 * without any task-juggling.
 *
 * Every segment is stamped with the wall-clock time its first sample landed.
 * That stamp is what later lets a detection be placed on the same timeline as
 * a video the glasses recorded independently, with no shared session between
 * them.
 */
@interface MicSegmentRecorder : NSObject

/**
 * A closed segment, ready to transcribe.
 *
 * `startedAtMs` is UNIX epoch milliseconds for the segment's first sample;
 * `peak` is the loudest normalized sample in it (0...1), which callers can use
 * to tell a quiet room from a broken microphone.
 *
 * Called on the recorder's private queue.
 */
@property (nonatomic, copy, nullable) void (^onSegment)
    (NSString *path, double startedAtMs, double durationSec, float peak);

/// Non-fatal problems worth surfacing. Called on the recorder's private queue.
@property (nonatomic, copy, nullable) void (^onError)(NSString *message);

/**
 * Segments whose peak never exceeds this are deleted instead of delivered.
 *
 * Transcription is the expensive part of always-on listening, and a segment of
 * room tone cannot contain the trigger word. Defaults to 0.01 (~-40 dBFS),
 * low enough to keep speech from across a room. Set to 0 to deliver every
 * segment.
 */
@property (nonatomic, assign) float silenceThreshold;

@property (nonatomic, readonly, getter=isRunning) BOOL running;

/**
 * @param segmentSeconds   How long each file covers. Shorter means the trigger
 *                         is heard sooner and each recognition pass is cheaper;
 *                         longer means fewer passes. 5s matches what the video
 *                         writer used.
 * @param retentionSeconds How long closed segments stay on disk after delivery.
 *                         They are the only recording of the room the phone
 *                         has, so keeping a window of them is what makes it
 *                         possible to align a detection against a video that
 *                         arrives later. Files older than this are swept.
 */
- (instancetype)initWithSegmentSeconds:(NSTimeInterval)segmentSeconds
                      retentionSeconds:(NSTimeInterval)retentionSeconds
    NS_DESIGNATED_INITIALIZER;

- (instancetype)init NS_UNAVAILABLE;

/// Returns NO when the microphone could not be brought up at all.
- (BOOL)start;

- (void)stop;

@end

NS_ASSUME_NONNULL_END
