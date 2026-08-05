#import <Accelerate/Accelerate.h>
#import <AVFoundation/AVFoundation.h>
#import <React/RCTBridgeModule.h>

// ASCII-only on purpose - see ClipStitcher.m for why.
#define CXLog(fmt, ...)                                                        \
  NSLog(@"[ClimaxEngine] %s:%d %s: " fmt,                                      \
        [[@(__FILE__) lastPathComponent] UTF8String], __LINE__, __func__,      \
        ##__VA_ARGS__)

/// Shared analysis grid. Every signal is resampled onto this, so scoring a
/// window is two array indices rather than an alignment problem.
static const double kCXGridHz = 20.0;
/// Frames per second sampled for the visual signals. Higher costs decode time
/// for detail the 20 Hz grid throws away again.
static const double kCXSampleFps = 10.0;
static const double kCXAudioSampleRate = 16000.0;
/// 2048-point FFT: ~128ms at 16 kHz, enough frequency resolution for flux
/// without smearing a transient across several grid samples.
static const vDSP_Length kCXLog2N = 11;
static const vDSP_Length kCXFFTSize = 1 << kCXLog2N;
/// Longest edge the frames are subsampled to before differencing. The visual
/// signals are whole-frame statistics; full resolution buys nothing and costs
/// a lot.
static const int kCXVisualMaxEdge = 160;
static const int kCXHistogramBins = 64;

#pragma mark - Helpers

static BOOL CXLoadAssetKeys(AVAsset *asset, NSArray<NSString *> *keys)
{
  dispatch_semaphore_t semaphore = dispatch_semaphore_create(0);
  [asset loadValuesAsynchronouslyForKeys:keys
                       completionHandler:^{ dispatch_semaphore_signal(semaphore); }];
  dispatch_semaphore_wait(semaphore, DISPATCH_TIME_FOREVER);
  for (NSString *key in keys) {
    NSError *error = nil;
    if ([asset statusOfValueForKey:key error:&error] != AVKeyValueStatusLoaded) {
      CXLog(@"failed to load asset key '%@' - %@", key, error.localizedDescription);
      return NO;
    }
  }
  return YES;
}

static BOOL CXTrackHasContent(AVAssetTrack *track)
{
  if (track == nil) {
    return NO;
  }
  CMTimeRange range = track.timeRange;
  return CMTIMERANGE_IS_VALID(range) && !CMTIMERANGE_IS_EMPTY(range) &&
         CMTimeCompare(range.duration, kCMTimeZero) > 0;
}

/// Linear resample of an irregular (time, value) series onto the uniform grid.
/// Values before the first sample or after the last are held, not extrapolated.
static void CXResampleOnto(const double *srcTimes, const double *srcValues,
                           NSUInteger srcCount, double *dst, NSUInteger dstCount,
                           double hop)
{
  if (srcCount == 0) {
    memset(dst, 0, dstCount * sizeof(double));
    return;
  }
  NSUInteger cursor = 0;
  for (NSUInteger i = 0; i < dstCount; i++) {
    double t = i * hop;
    while (cursor + 1 < srcCount && srcTimes[cursor + 1] < t) {
      cursor += 1;
    }
    if (t <= srcTimes[0]) {
      dst[i] = srcValues[0];
    } else if (t >= srcTimes[srcCount - 1]) {
      dst[i] = srcValues[srcCount - 1];
    } else {
      double t0 = srcTimes[cursor], t1 = srcTimes[cursor + 1];
      double span = t1 - t0;
      double frac = span > 1e-9 ? (t - t0) / span : 0.0;
      dst[i] = srcValues[cursor] + (srcValues[cursor + 1] - srcValues[cursor]) * frac;
    }
  }
}

/// Pearson correlation between two histograms — OpenCV's HISTCMP_CORREL, which
/// is what the reference implementation compares frames with. Identical
/// histograms give 1, so `1 - correlation` is "how much the shot changed".
static double CXHistogramCorrelation(const double *a, const double *b, NSUInteger bins)
{
  double meanA = 0, meanB = 0;
  for (NSUInteger i = 0; i < bins; i++) {
    meanA += a[i];
    meanB += b[i];
  }
  meanA /= (double)bins;
  meanB /= (double)bins;

  double num = 0, devA = 0, devB = 0;
  for (NSUInteger i = 0; i < bins; i++) {
    double da = a[i] - meanA;
    double db = b[i] - meanB;
    num += da * db;
    devA += da * da;
    devB += db * db;
  }
  double denom = sqrt(devA * devB);
  // Two flat histograms are perfectly alike, not undefined.
  return denom < 1e-12 ? 1.0 : num / denom;
}

static NSArray<NSNumber *> *CXToArray(const double *values, NSUInteger count)
{
  NSMutableArray<NSNumber *> *out = [NSMutableArray arrayWithCapacity:count];
  for (NSUInteger i = 0; i < count; i++) {
    double v = values[i];
    [out addObject:@(isfinite(v) ? v : 0.0)];
  }
  return out;
}

#pragma mark - Module

@interface ClimaxEngine : NSObject <RCTBridgeModule>
@end

@implementation ClimaxEngine

RCT_EXPORT_MODULE();

- (dispatch_queue_t)methodQueue
{
  static dispatch_queue_t queue;
  static dispatch_once_t once;
  dispatch_once(&once, ^{
    queue = dispatch_queue_create("com.clipso.climaxengine", DISPATCH_QUEUE_SERIAL);
  });
  return queue;
}

+ (BOOL)requiresMainQueueSetup
{
  return NO;
}

/**
 * Audio + visual features for the hook scorer, on one uniform grid.
 *
 * Deliberately NOT the recogniser's audio path: that one normalises level so
 * quiet far-field speech is heard, which would destroy exactly the loudness
 * differences the audio modality is measuring. Raw levels are the signal here.
 *
 * `visual.flow` (sparse optical flow in the reference implementation) is not
 * produced. Dense flow on device is hundreds of GPU passes per clip for one of
 * seven signals, and the scorer treats an absent signal as absent rather than
 * zero, so frame difference and scene change carry the visual modality.
 */
RCT_EXPORT_METHOD(extractFeatures:(NSString *)path
                  resolver:(RCTPromiseResolveBlock)resolve
                  rejecter:(RCTPromiseRejectBlock)reject)
{
  if (![[NSFileManager defaultManager] fileExistsAtPath:path]) {
    reject(@"missing_clip", @"Clip file does not exist.", nil);
    return;
  }
  AVURLAsset *asset = [AVURLAsset URLAssetWithURL:[NSURL fileURLWithPath:path] options:nil];
  if (!CXLoadAssetKeys(asset, @[ @"tracks", @"duration" ])) {
    reject(@"unreadable_clip", @"Could not read the clip.", nil);
    return;
  }

  double duration = CMTimeGetSeconds(asset.duration);
  if (!isfinite(duration) || duration <= 0) {
    reject(@"empty_clip", @"The clip has no duration.", nil);
    return;
  }

  double hop = 1.0 / kCXGridHz;
  NSUInteger n = (NSUInteger)floor(duration * kCXGridHz);
  if (n < 2) {
    reject(@"clip_too_short", @"The clip is too short to analyse.", nil);
    return;
  }

  NSMutableDictionary<NSString *, NSArray<NSNumber *> *> *signals =
      [NSMutableDictionary dictionary];
  [self addAudioSignals:asset into:signals samples:n hop:hop];
  [self addVisualSignals:asset into:signals samples:n hop:hop duration:duration];

  NSMutableArray<NSNumber *> *times = [NSMutableArray arrayWithCapacity:n];
  for (NSUInteger i = 0; i < n; i++) {
    [times addObject:@(i * hop)];
  }

  CXLog(@"extracted %lu signals over %lu samples (%.1fs) from %@",
        (unsigned long)signals.count, (unsigned long)n, duration,
        path.lastPathComponent);
  resolve(@{
    @"hop" : @(hop),
    @"duration" : @(duration),
    @"times" : times,
    @"signals" : signals,
  });
}

#pragma mark Audio

- (void)addAudioSignals:(AVAsset *)asset
                   into:(NSMutableDictionary *)signals
                samples:(NSUInteger)n
                    hop:(double)hop
{
  AVAssetTrack *track = nil;
  for (AVAssetTrack *candidate in [asset tracksWithMediaType:AVMediaTypeAudio]) {
    if (CXTrackHasContent(candidate)) {
      track = candidate;
      break;
    }
  }
  if (track == nil) {
    // Video-only is the normal case for glasses capture. Emitting four
    // constant-zero signals would tell the scorer "measured, and flat"; saying
    // nothing tells it the truth, which is "not measured".
    CXLog(@"no usable audio track - audio modality omitted");
    return;
  }

  NSError *error = nil;
  AVAssetReader *reader = [[AVAssetReader alloc] initWithAsset:asset error:&error];
  if (reader == nil) {
    CXLog(@"audio: reader init failed - %@", error.localizedDescription);
    return;
  }
  AVAssetReaderTrackOutput *output = [[AVAssetReaderTrackOutput alloc]
      initWithTrack:track
     outputSettings:@{
       AVFormatIDKey : @(kAudioFormatLinearPCM),
       AVSampleRateKey : @(kCXAudioSampleRate),
       AVNumberOfChannelsKey : @1,
       AVLinearPCMBitDepthKey : @16,
       AVLinearPCMIsFloatKey : @NO,
       AVLinearPCMIsBigEndianKey : @NO,
       AVLinearPCMIsNonInterleaved : @NO,
     }];
  if (![reader canAddOutput:output]) {
    return;
  }
  [reader addOutput:output];
  if (![reader startReading]) {
    CXLog(@"audio: startReading failed - %@", reader.error.localizedDescription);
    return;
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
  NSUInteger sampleCount = pcm.length / sizeof(int16_t);
  if (sampleCount < kCXFFTSize) {
    CXLog(@"audio: only %lu samples, too short to analyse",
          (unsigned long)sampleCount);
    return;
  }

  const int16_t *pcm16 = (const int16_t *)pcm.bytes;
  NSUInteger hopSamples = (NSUInteger)llround(kCXAudioSampleRate * hop);

  double *rms = calloc(n, sizeof(double));
  double *zcr = calloc(n, sizeof(double));
  double *flux = calloc(n, sizeof(double));
  double *peaks = calloc(n, sizeof(double));

  FFTSetup fft = vDSP_create_fftsetup(kCXLog2N, kFFTRadix2);
  float *windowFn = malloc(kCXFFTSize * sizeof(float));
  float *frame = malloc(kCXFFTSize * sizeof(float));
  float *realp = malloc((kCXFFTSize / 2) * sizeof(float));
  float *imagp = malloc((kCXFFTSize / 2) * sizeof(float));
  float *mag = calloc(kCXFFTSize / 2, sizeof(float));
  float *prevMag = calloc(kCXFFTSize / 2, sizeof(float));
  // Declared before the bail-out below so the jump crosses no initialisation.
  DSPSplitComplex split;

  if (fft == NULL || !windowFn || !frame || !realp || !imagp || !mag || !prevMag ||
      !rms || !zcr || !flux || !peaks) {
    CXLog(@"audio: allocation failed");
    goto cleanup;
  }
  split.realp = realp;
  split.imagp = imagp;
  vDSP_hann_window(windowFn, kCXFFTSize, vDSP_HANN_NORM);

  for (NSUInteger i = 0; i < n; i++) {
    NSUInteger offset = i * hopSamples;
    if (offset >= sampleCount) {
      break;
    }
    NSUInteger available = MIN((NSUInteger)kCXFFTSize, sampleCount - offset);

    // Raw level and zero crossings straight off the PCM.
    double sumSquares = 0;
    NSUInteger crossings = 0;
    for (NSUInteger k = 0; k < available; k++) {
      double v = pcm16[offset + k] / 32768.0;
      sumSquares += v * v;
      if (k > 0) {
        int16_t a = pcm16[offset + k - 1];
        int16_t b = pcm16[offset + k];
        if ((a >= 0) != (b >= 0)) {
          crossings += 1;
        }
      }
      frame[k] = (float)v;
    }
    for (NSUInteger k = available; k < kCXFFTSize; k++) {
      frame[k] = 0.0f;
    }
    rms[i] = sqrt(sumSquares / (double)available);
    zcr[i] = available > 1 ? (double)crossings / (double)(available - 1) : 0.0;

    vDSP_vmul(frame, 1, windowFn, 1, frame, 1, kCXFFTSize);
    vDSP_ctoz((DSPComplex *)frame, 2, &split, 1, kCXFFTSize / 2);
    vDSP_fft_zrip(fft, &split, 1, kCXLog2N, FFT_FORWARD);
    vDSP_zvabs(&split, 1, mag, 1, kCXFFTSize / 2);

    // Spectral flux: only the positive change, which is what an onset is.
    // Falling energy is a decay, not an event.
    double positive = 0;
    for (NSUInteger k = 0; k < kCXFFTSize / 2; k++) {
      float delta = mag[k] - prevMag[k];
      if (delta > 0) {
        positive += delta;
      }
    }
    flux[i] = i == 0 ? 0.0 : positive;
    memcpy(prevMag, mag, (kCXFFTSize / 2) * sizeof(float));
  }

  // Onset peaks as a 0/1 impulse train. Its mean over a window is the peak
  // rate, which is the density the scorer wants.
  {
    double sum = 0, sumSq = 0;
    for (NSUInteger i = 0; i < n; i++) {
      sum += flux[i];
      sumSq += flux[i] * flux[i];
    }
    double meanFlux = sum / (double)n;
    double variance = MAX(0.0, sumSq / (double)n - meanFlux * meanFlux);
    double threshold = meanFlux + 0.5 * sqrt(variance);
    for (NSUInteger i = 1; i + 1 < n; i++) {
      if (flux[i] > threshold && flux[i] >= flux[i - 1] && flux[i] >= flux[i + 1]) {
        peaks[i] = 1.0;
      }
    }
  }

  signals[@"audio.rms"] = CXToArray(rms, n);
  signals[@"audio.zcr"] = CXToArray(zcr, n);
  signals[@"audio.flux"] = CXToArray(flux, n);
  signals[@"audio.peaks"] = CXToArray(peaks, n);

cleanup:
  if (fft != NULL) {
    vDSP_destroy_fftsetup(fft);
  }
  free(windowFn);
  free(frame);
  free(realp);
  free(imagp);
  free(mag);
  free(prevMag);
  free(rms);
  free(zcr);
  free(flux);
  free(peaks);
}

#pragma mark Visual

- (void)addVisualSignals:(AVAsset *)asset
                    into:(NSMutableDictionary *)signals
                 samples:(NSUInteger)n
                     hop:(double)hop
                duration:(double)duration
{
  AVAssetTrack *track = [asset tracksWithMediaType:AVMediaTypeVideo].firstObject;
  if (!CXTrackHasContent(track)) {
    CXLog(@"no usable video track - visual modality omitted");
    return;
  }

  NSError *error = nil;
  AVAssetReader *reader = [[AVAssetReader alloc] initWithAsset:asset error:&error];
  if (reader == nil) {
    CXLog(@"visual: reader init failed - %@", error.localizedDescription);
    return;
  }
  AVAssetReaderTrackOutput *output = [[AVAssetReaderTrackOutput alloc]
      initWithTrack:track
     outputSettings:@{
       (id)kCVPixelBufferPixelFormatTypeKey : @(kCVPixelFormatType_32BGRA),
     }];
  output.alwaysCopiesSampleData = NO;
  if (![reader canAddOutput:output]) {
    return;
  }
  [reader addOutput:output];
  if (![reader startReading]) {
    CXLog(@"visual: startReading failed - %@", reader.error.localizedDescription);
    return;
  }

  NSUInteger capacity = (NSUInteger)(duration * kCXSampleFps) + 8;
  double *times = calloc(capacity, sizeof(double));
  double *diffs = calloc(capacity, sizeof(double));
  double *scenes = calloc(capacity, sizeof(double));
  uint8_t *gray = NULL;
  uint8_t *prevGray = NULL;
  double *hist = calloc(kCXHistogramBins, sizeof(double));
  double *prevHist = calloc(kCXHistogramBins, sizeof(double));
  NSUInteger grayCount = 0;
  NSUInteger count = 0;
  double minInterval = 1.0 / kCXSampleFps;
  double lastSampled = -1e9;

  CMSampleBufferRef sample = NULL;
  while (count < capacity && (sample = [output copyNextSampleBuffer])) {
    double t = CMTimeGetSeconds(CMSampleBufferGetPresentationTimeStamp(sample));
    if (!isfinite(t) || t - lastSampled < minInterval) {
      CFRelease(sample);
      continue;
    }
    lastSampled = t;

    CVImageBufferRef pixels = CMSampleBufferGetImageBuffer(sample);
    if (pixels == NULL) {
      CFRelease(sample);
      continue;
    }
    CVPixelBufferLockBaseAddress(pixels, kCVPixelBufferLock_ReadOnly);
    size_t width = CVPixelBufferGetWidth(pixels);
    size_t height = CVPixelBufferGetHeight(pixels);
    size_t stride = CVPixelBufferGetBytesPerRow(pixels);
    const uint8_t *base = CVPixelBufferGetBaseAddress(pixels);

    // Subsample by striding rather than scaling: these are whole-frame
    // statistics, so every Nth pixel carries the same information far cheaper.
    int step = (int)MAX(1, (long)(MAX(width, height) / kCXVisualMaxEdge));
    NSUInteger outW = (NSUInteger)((width + step - 1) / step);
    NSUInteger outH = (NSUInteger)((height + step - 1) / step);
    NSUInteger needed = outW * outH;
    if (base != NULL && needed > 0) {
      if (needed != grayCount) {
        free(gray);
        free(prevGray);
        gray = malloc(needed);
        prevGray = NULL;  // geometry changed; nothing to difference against
        grayCount = needed;
      }
      if (gray != NULL) {
        memset(hist, 0, kCXHistogramBins * sizeof(double));
        NSUInteger idx = 0;
        for (size_t y = 0; y < height; y += step) {
          const uint8_t *row = base + y * stride;
          for (size_t x = 0; x < width && idx < needed; x += step) {
            const uint8_t *px = row + x * 4;  // BGRA
            // Rec.601 luma, integer weights.
            uint8_t luma = (uint8_t)((px[2] * 77 + px[1] * 150 + px[0] * 29) >> 8);
            gray[idx++] = luma;
            hist[(luma * kCXHistogramBins) / 256] += 1.0;
          }
        }
        for (NSUInteger b = 0; b < kCXHistogramBins; b++) {
          hist[b] /= (double)MAX((NSUInteger)1, idx);
        }

        double diff = 0;
        double scene = 0;
        if (prevGray != NULL) {
          long total = 0;
          for (NSUInteger i = 0; i < needed; i++) {
            total += abs((int)gray[i] - (int)prevGray[i]);
          }
          diff = (double)total / (double)needed / 255.0;
          scene = 1.0 - CXHistogramCorrelation(hist, prevHist, kCXHistogramBins);
        }
        times[count] = t;
        diffs[count] = diff;
        scenes[count] = MAX(0.0, MIN(1.0, scene));
        count += 1;

        if (prevGray == NULL) {
          prevGray = malloc(needed);
        }
        if (prevGray != NULL) {
          memcpy(prevGray, gray, needed);
        }
        memcpy(prevHist, hist, kCXHistogramBins * sizeof(double));
      }
    }
    CVPixelBufferUnlockBaseAddress(pixels, kCVPixelBufferLock_ReadOnly);
    CFRelease(sample);
  }

  if (count >= 2) {
    double *resampled = calloc(n, sizeof(double));
    CXResampleOnto(times, diffs, count, resampled, n, hop);
    signals[@"visual.frame_diff"] = CXToArray(resampled, n);
    CXResampleOnto(times, scenes, count, resampled, n, hop);
    signals[@"visual.scene_change"] = CXToArray(resampled, n);
    free(resampled);
    CXLog(@"visual: %lu frames sampled", (unsigned long)count);
  } else {
    CXLog(@"visual: only %lu frames sampled - modality omitted",
          (unsigned long)count);
  }

  free(times);
  free(diffs);
  free(scenes);
  free(gray);
  free(prevGray);
  free(hist);
  free(prevHist);
}

@end
