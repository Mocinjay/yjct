#import <Foundation/Foundation.h>

NS_ASSUME_NONNULL_BEGIN

/**
 * Rolling microphone recorder that exists purely to feed the wake word.
 *
 * In live mode the wake word rides on the audio track of the video segments
 * `MWDATSegmentWriter` writes. In glasses-only mode nothing streams, so there
 * are no segments; this class owns a microphone and nothing else, so "listen
 * for Clypso" does not imply "stream video from the glasses".
 *
 * It writes short AAC/m4a files and hands each one back as it closes. A single
 * `SFSpeechRecognitionTask` is ended by the system after about a minute of
 * continuous audio, and a file per rotation sidesteps that ceiling.
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
 *                         longer means fewer passes. 5s matches the video
 *                         writer's segments.
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
