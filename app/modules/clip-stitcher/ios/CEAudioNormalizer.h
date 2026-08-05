#import <AVFoundation/AVFoundation.h>
#import <Foundation/Foundation.h>

NS_ASSUME_NONNULL_BEGIN

/// Getting a clip's audio into the shape Apple's recognizer wants.
///
/// Split out of CaptionEngine.m because it is signal processing, not a bridge
/// module: an automatic-gain stage, a PCM extractor and a WAV writer, none of
/// which know anything about React Native, captions or rendering. They were
/// ~270 lines of C statics sitting above an Objective-C class that never
/// referenced them except through two entry points.
///
/// The gain stage is the part that matters. Glasses audio arrives quiet and
/// uneven — a Bluetooth mic on someone's face, in the open air — and the
/// recognizer's accuracy falls off a cliff below roughly -30 dBFS. Riding the
/// level up before recognition is worth more to caption quality than any
/// change to the recognizer's own settings.

/// Reads the asset's audio as 16-bit mono PCM at the recognition sample rate,
/// with automatic gain applied. Returns nil when the asset has no usable audio.
NSData *_Nullable CEReadNormalizedPCM(AVAsset *asset);

/// Writes `[firstSample, firstSample + sampleCount)` of `pcm` to a temporary
/// WAV file at `kCERecognitionSampleRate`. Returns nil on failure.
///
/// Speech caps how much audio one request may carry, so recognition is
/// windowed and each window is handed over as its own file. `label` names the
/// window in the log so a failing window can be identified.
NSURL *_Nullable CEWriteWavWindow(NSData *pcm, NSUInteger firstSample,
                                  NSUInteger sampleCount, NSString *label);

/// Applies the automatic-gain stage in place. Exposed for the extractor above;
/// separate so the gain curve can be reasoned about on its own.
void CERideGain(int16_t *samples, NSUInteger count);

/// Apple's recognizer wants 16 kHz mono; anything else is resampled internally
/// and costs accuracy on the way. Shared because the caller does the windowing
/// arithmetic in samples and must agree with the WAV header written here.
extern const double kCERecognitionSampleRate;

NS_ASSUME_NONNULL_END
