#import "CEAudioNormalizer.h"

#import <Accelerate/Accelerate.h>
#import <AVFoundation/AVFoundation.h>

// ASCII-only on purpose - see ClipStitcher.m for why.
#define CELog(fmt, ...)                                                        \
  NSLog(@"[CEAudioNormalizer] %s:%d %s: " fmt,                                 \
        [[@(__FILE__) lastPathComponent] UTF8String], __LINE__, __func__,      \
        ##__VA_ARGS__)

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
void CERideGain(int16_t *samples, NSUInteger count)
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
NSData *CEReadNormalizedPCM(AVAsset *asset)
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
NSURL *CEWriteWavWindow(NSData *pcm, NSUInteger firstSample,
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

const double kCERecognitionSampleRate = 16000.0;
