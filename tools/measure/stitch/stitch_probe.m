// Measures where the stitched composition has holes, and how big they are.
//
// `ClipStitcher.m` anchors each segment on the video track's own end
// (`CMTimeRangeGetEnd(srcVideo.timeRange)`). It used to anchor on
// `asset.duration`, which is the LONGER of the two tracks. The difference is
// this: `cursor` is shared by both tracks and advances by `take`, so every
// segment is re-anchored to the correct wall position at its own boundary and
// a per-segment A/V mismatch does NOT accumulate into drift. What it produces
// is a HOLE OF THE MISMATCH SIZE AT EACH BOUNDARY, in whichever track is
// short, with the next segment landing back on time.
//
// So a test that measures end-to-end drift at 30/60/90s proves nothing: it
// passes on both anchors while the glitches are there. This measures gap
// POSITION and gap SIZE, and it runs both anchors so the shipping one has
// something to be better than.
//
// No export is needed. A hole between two inserts is an EMPTY segment in
// `AVCompositionTrack.segments`, and `timeMapping.target` carries its exact
// position and duration.
//
// Build:
//   clang -fobjc-arc -O2 -framework Foundation -framework AVFoundation \
//     -framework CoreMedia -o stitch_probe stitch_probe.m

#import <AVFoundation/AVFoundation.h>
#import <Foundation/Foundation.h>

// How close two CMTimes must be to count as the same instant. Composition
// arithmetic is exact, so this is only absorbing the timescale conversion
// between the fixture's clock and the composition's.
static double const kSPEpsilon = 0.0005;

typedef NS_ENUM(NSInteger, SPAnchor) {
  /// What ships: the video track's own end.
  SPAnchorVideoEnd,
  /// What shipped before: `asset.duration`, the longer of the two tracks.
  SPAnchorAssetDuration,
};

static NSString *SPAnchorName(SPAnchor anchor)
{
  return anchor == SPAnchorVideoEnd ? @"video-end" : @"asset-duration";
}

#pragma mark - Copied from ClipStitcher.m

/// Verbatim from `ClipStitcher.m`. A track that exists is not a track that has
/// content: a segment can carry an audio track that received zero samples.
static BOOL JVSTrackHasContent(AVAssetTrack *track)
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

#pragma mark - Composition

/// The composition loop from `ClipStitcher.m`, with `take` switched on
/// `anchor` and the React bridge stripped. Everything that decides where
/// content lands — the shared `cursor`, the single `range` handed to both
/// inserts, the empty-audio skip, the empty-track sweep — is as it ships.
///
/// Deliberately NOT copied: `JVSLoadAssetKeys` (these are local files loaded
/// synchronously here) and the export. Neither moves a sample in time.
static AVMutableComposition *SPCompose(NSArray<NSString *> *segmentPaths,
                                       SPAnchor anchor,
                                       double trimEndSec,
                                       AVMutableCompositionTrack **outVideo,
                                       AVMutableCompositionTrack **outAudio,
                                       CMTime *outCursor,
                                       NSError **outError)
{
  AVMutableComposition *composition = [AVMutableComposition composition];
  AVMutableCompositionTrack *videoTrack = nil;
  AVMutableCompositionTrack *audioTrack = nil;

  CMTime cursor = kCMTimeZero;
  for (NSUInteger index = 0; index < segmentPaths.count; index++) {
    NSString *path = segmentPaths[index];
    AVURLAsset *asset =
        [AVURLAsset URLAssetWithURL:[NSURL fileURLWithPath:path] options:nil];

    NSError *error = nil;
    AVAssetTrack *srcVideo = [asset tracksWithMediaType:AVMediaTypeVideo].firstObject;

    CMTime take;
    if (anchor == SPAnchorVideoEnd) {
      take = srcVideo != nil ? CMTimeRangeGetEnd(srcVideo.timeRange) : asset.duration;
    } else {
      take = asset.duration;
    }

    if (index == segmentPaths.count - 1 && trimEndSec > 0) {
      CMTime trimmed =
          CMTimeSubtract(take, CMTimeMakeWithSeconds(trimEndSec, take.timescale));
      if (CMTimeCompare(trimmed, kCMTimeZero) > 0) {
        take = trimmed;
      }
    }
    CMTimeRange range = CMTimeRangeMake(kCMTimeZero, take);

    if (srcVideo != nil) {
      if (videoTrack == nil) {
        videoTrack = [composition addMutableTrackWithMediaType:AVMediaTypeVideo
                                             preferredTrackID:kCMPersistentTrackID_Invalid];
      }
      [videoTrack insertTimeRange:range ofTrack:srcVideo atTime:cursor error:&error];
      if (error != nil) {
        if (outError != nil) {
          *outError = error;
        }
        return nil;
      }
      videoTrack.preferredTransform = srcVideo.preferredTransform;
    }

    AVAssetTrack *srcAudio = [asset tracksWithMediaType:AVMediaTypeAudio].firstObject;
    if (JVSTrackHasContent(srcAudio)) {
      if (audioTrack == nil) {
        audioTrack = [composition addMutableTrackWithMediaType:AVMediaTypeAudio
                                             preferredTrackID:kCMPersistentTrackID_Invalid];
      }
      [audioTrack insertTimeRange:range ofTrack:srcAudio atTime:cursor error:&error];
      if (error != nil) {
        if (outError != nil) {
          *outError = error;
        }
        return nil;
      }
    }
    cursor = CMTimeAdd(cursor, take);
  }

  for (AVMutableCompositionTrack *track in [composition.tracks copy]) {
    if (track.segments.count == 0 ||
        CMTimeCompare(track.timeRange.duration, kCMTimeZero) <= 0) {
      [composition removeTrack:track];
      if (track == audioTrack) {
        audioTrack = nil;
      } else if (track == videoTrack) {
        videoTrack = nil;
      }
    }
  }

  if (outVideo != nil) {
    *outVideo = videoTrack;
  }
  if (outAudio != nil) {
    *outAudio = audioTrack;
  }
  if (outCursor != nil) {
    *outCursor = cursor;
  }
  return composition;
}

#pragma mark - Reading gaps back

/// The holes are NOT visible in the segment structure. Asking
/// `insertTimeRange` for more than the source track holds is not clamped and
/// not marked empty: the segment reports `source` and `target` durations both
/// equal to what was asked for, off a track that ends earlier. An empty
/// segment only ever appears from `insertEmptyTimeRange` or from inserting at
/// a cursor past the track's end, and the stitcher does neither — its ranges
/// are contiguous by construction, so the composition always *claims* to be
/// dense.
///
/// So the measurement has to go a level down, to the samples. Everything
/// below decodes the composition and finds where the content actually stops.

/// Brightest sampled channel byte in the frame. Every 16th row is enough to
/// tell a picture from a blank and keeps a 3-segment read well under a
/// second.
static uint8_t SPFramePeak(CVPixelBufferRef pixels)
{
  CVPixelBufferLockBaseAddress(pixels, kCVPixelBufferLock_ReadOnly);
  uint8_t const *base = CVPixelBufferGetBaseAddress(pixels);
  size_t const stride = CVPixelBufferGetBytesPerRow(pixels);
  size_t const height = CVPixelBufferGetHeight(pixels);
  size_t const width = CVPixelBufferGetWidth(pixels) * 4;

  uint8_t peak = 0;
  if (base != NULL) {
    for (size_t y = 0; y < height && peak == 0; y += 16) {
      uint8_t const *row = base + y * stride;
      for (size_t x = 0; x < width; x += 4) {
        if (row[x] > peak) {
          peak = row[x];
        }
      }
    }
  }
  CVPixelBufferUnlockBaseAddress(pixels, kCVPixelBufferLock_ReadOnly);
  return peak;
}

/// A frame this dark everywhere is not picture. The synthesized frames are
/// exactly 0; the margin is for a source that has been through an encoder.
///
/// A source that genuinely cuts to black would read as a hole here. That is
/// acceptable for synthetic fixtures and is the reason this is a fixture
/// harness rather than something pointed at real clips.
static uint8_t const kSPBlankPeak = 4;

/// Presentation timestamps of every frame the composition yields, and
/// whether each one is blank.
///
/// Both are needed because the picture defect is not a MISSING frame. Asked
/// for more picture than the source holds, AVFoundation makes up the
/// difference with black, so the timestamps stay perfectly cadenced and a
/// timing-only check sees nothing at all.
static NSArray<NSNumber *> *SPFramePTS(AVComposition *composition,
                                       AVCompositionTrack *track,
                                       NSMutableArray<NSNumber *> *outBlank,
                                       NSError **outError)
{
  NSMutableArray<NSNumber *> *stamps = [NSMutableArray array];
  AVAssetReader *reader = [AVAssetReader assetReaderWithAsset:composition error:outError];
  if (reader == nil) {
    return nil;
  }
  // Decompressed, not passthrough. A passthrough output hands back each
  // segment's SOURCE timestamps — three segments all report 0 -> 2.0 — and
  // the composition timeline is exactly what is being measured here.
  AVAssetReaderTrackOutput *output = [AVAssetReaderTrackOutput
      assetReaderTrackOutputWithTrack:track
                       outputSettings:@{
                         (id)kCVPixelBufferPixelFormatTypeKey :
                             @(kCVPixelFormatType_32BGRA)
                       }];
  output.alwaysCopiesSampleData = NO;
  [reader addOutput:output];
  if (![reader startReading]) {
    if (outError != nil) {
      *outError = reader.error;
    }
    return nil;
  }

  CMSampleBufferRef sample = NULL;
  while ((sample = [output copyNextSampleBuffer]) != NULL) {
    CMTime pts = CMSampleBufferGetPresentationTimeStamp(sample);
    CVImageBufferRef pixels = CMSampleBufferGetImageBuffer(sample);
    if (CMTIME_IS_NUMERIC(pts) && pixels != NULL) {
      [stamps addObject:@(CMTimeGetSeconds(pts))];
      [outBlank addObject:@(SPFramePeak(pixels) <= kSPBlankPeak)];
    }
    CFRelease(sample);
  }
  if (reader.status == AVAssetReaderStatusFailed) {
    if (outError != nil) {
      *outError = reader.error;
    }
    return nil;
  }
  return stamps;
}

/// Runs of blank picture, in composition time. A run is reported from the
/// first blank frame to the frame that brings the picture back, which makes
/// its start the source's video end and its length the shortfall — the claim
/// being tested.
///
/// A run still open at the end of the track is trailing, not a hole between
/// two pieces of content, and is excluded for the same reason the audio side
/// excludes trailing silence. In shipping use `trimEndSec` cuts into the last
/// segment anyway.
static NSArray<NSValue *> *SPVideoGaps(AVComposition *composition,
                                       AVCompositionTrack *track,
                                       NSError **outError)
{
  if (track == nil) {
    return @[];
  }
  NSMutableArray<NSNumber *> *blank = [NSMutableArray array];
  NSArray<NSNumber *> *stamps = SPFramePTS(composition, track, blank, outError);
  if (stamps == nil) {
    return nil;
  }

  NSMutableArray<NSValue *> *gaps = [NSMutableArray array];
  NSUInteger i = 0;
  while (i < stamps.count) {
    if (!blank[i].boolValue) {
      i++;
      continue;
    }
    NSUInteger const runStart = i;
    while (i < stamps.count && blank[i].boolValue) {
      i++;
    }
    if (i >= stamps.count) {
      break;  // trailing blank, nothing after it to notice it against
    }
    double const start = stamps[runStart].doubleValue;
    CMTimeRange range =
        CMTimeRangeMake(CMTimeMakeWithSeconds(start, 1000000),
                        CMTimeMakeWithSeconds(stamps[i].doubleValue - start, 1000000));
    [gaps addObject:[NSValue valueWithBytes:&range objCType:@encode(CMTimeRange)]];
  }
  return gaps;
}

/// A run has to be longer than this to be a hole rather than a zero crossing.
/// The fixtures are a 440 Hz sine, whose consecutive exact zeros number in the
/// ones; the holes being looked for are tens of milliseconds.
static double const kSPMinSilenceSec = 0.005;

/// Runs of silence in the decoded audio, in composition time.
///
/// Decoding rather than trusting the timestamps is deliberate: a reader is
/// free to paper over a hole with silence and hand back an unbroken PTS
/// sequence, which is exactly what makes the defect invisible from above. A
/// silent stretch is what the listener gets either way.
static NSArray<NSValue *> *SPAudioGaps(AVComposition *composition,
                                       AVCompositionTrack *track,
                                       NSError **outError)
{
  if (track == nil) {
    return @[];
  }
  double const rate = 48000.0;
  AVAssetReader *reader = [AVAssetReader assetReaderWithAsset:composition error:outError];
  if (reader == nil) {
    return nil;
  }
  AVAssetReaderTrackOutput *output = [AVAssetReaderTrackOutput
      assetReaderTrackOutputWithTrack:track
                       outputSettings:@{
                         AVFormatIDKey : @(kAudioFormatLinearPCM),
                         AVSampleRateKey : @(rate),
                         AVNumberOfChannelsKey : @1,
                         AVLinearPCMBitDepthKey : @16,
                         AVLinearPCMIsFloatKey : @NO,
                         AVLinearPCMIsBigEndianKey : @NO,
                         AVLinearPCMIsNonInterleaved : @NO,
                       }];
  output.alwaysCopiesSampleData = NO;
  [reader addOutput:output];
  if (![reader startReading]) {
    if (outError != nil) {
      *outError = reader.error;
    }
    return nil;
  }

  NSMutableArray<NSValue *> *gaps = [NSMutableArray array];
  int64_t frameIndex = 0;      // frames emitted so far
  int64_t silenceStart = -1;   // frame index the current silent run began at
  NSMutableData *scratch = [NSMutableData data];

  CMSampleBufferRef sample = NULL;
  while ((sample = [output copyNextSampleBuffer]) != NULL) {
    CMBlockBufferRef block = CMSampleBufferGetDataBuffer(sample);
    size_t const length = block != NULL ? CMBlockBufferGetDataLength(block) : 0;
    if (length > 0) {
      scratch.length = length;
      CMBlockBufferCopyDataBytes(block, 0, length, scratch.mutableBytes);
      int16_t const *frames = scratch.bytes;
      size_t const count = length / sizeof(int16_t);
      for (size_t i = 0; i < count; i++, frameIndex++) {
        if (frames[i] == 0) {
          if (silenceStart < 0) {
            silenceStart = frameIndex;
          }
          continue;
        }
        if (silenceStart >= 0) {
          double const start = silenceStart / rate;
          double const duration = (frameIndex - silenceStart) / rate;
          if (duration >= kSPMinSilenceSec) {
            CMTimeRange range = CMTimeRangeMake(CMTimeMakeWithSeconds(start, 1000000),
                                                CMTimeMakeWithSeconds(duration, 1000000));
            [gaps addObject:[NSValue valueWithBytes:&range objCType:@encode(CMTimeRange)]];
          }
          silenceStart = -1;
        }
      }
    }
    CFRelease(sample);
  }
  if (reader.status == AVAssetReaderStatusFailed) {
    if (outError != nil) {
      *outError = reader.error;
    }
    return nil;
  }
  // A silent run still open at the end is trailing silence, not a hole
  // between two pieces of content, and is deliberately not reported: there is
  // nothing after it for the listener to notice it against.
  return gaps;
}

static CMTimeRange SPRangeAt(NSArray<NSValue *> *gaps, NSUInteger index)
{
  CMTimeRange range = kCMTimeRangeInvalid;
  [gaps[index] getValue:&range];
  return range;
}

/// Where the holes must be, given a track that runs out at `trackEnd` while
/// the cursor advances by `take`, repeated `count` times. This is the whole
/// claim in one function: position `k * take + trackEnd`, size `take -
/// trackEnd`, for every boundary except the last.
static NSArray<NSValue *> *SPExpectedGaps(double trackEnd, double take, NSUInteger count)
{
  NSMutableArray<NSValue *> *expected = [NSMutableArray array];
  double const shortfall = take - trackEnd;
  if (shortfall <= kSPEpsilon || count < 2) {
    return expected;
  }
  for (NSUInteger k = 0; k + 1 < count; k++) {
    CMTimeRange range = CMTimeRangeMake(CMTimeMakeWithSeconds(k * take + trackEnd, 1000000),
                                        CMTimeMakeWithSeconds(shortfall, 1000000));
    [expected addObject:[NSValue valueWithBytes:&range objCType:@encode(CMTimeRange)]];
  }
  return expected;
}

#pragma mark - Fixture measurement

typedef struct {
  double videoEnd;
  double audioEnd;  // 0 when the segment carries no usable audio
  double assetDuration;
  BOOL hasAudio;
} SPSegmentShape;

static BOOL SPMeasure(NSString *path, SPSegmentShape *out)
{
  AVURLAsset *asset =
      [AVURLAsset URLAssetWithURL:[NSURL fileURLWithPath:path] options:nil];
  AVAssetTrack *video = [asset tracksWithMediaType:AVMediaTypeVideo].firstObject;
  if (video == nil) {
    fprintf(stderr, "stitch_probe: %s has no video track\n", path.UTF8String);
    return NO;
  }
  AVAssetTrack *audio = [asset tracksWithMediaType:AVMediaTypeAudio].firstObject;
  out->videoEnd = CMTimeGetSeconds(CMTimeRangeGetEnd(video.timeRange));
  out->hasAudio = JVSTrackHasContent(audio);
  out->audioEnd = out->hasAudio ? CMTimeGetSeconds(CMTimeRangeGetEnd(audio.timeRange)) : 0;
  out->assetDuration = CMTimeGetSeconds(asset.duration);
  return YES;
}

#pragma mark - Commands

static void SPPrintGaps(NSString *label, NSArray<NSValue *> *gaps)
{
  if (gaps.count == 0) {
    printf("    %-5s none\n", label.UTF8String);
    return;
  }
  for (NSUInteger i = 0; i < gaps.count; i++) {
    CMTimeRange range = SPRangeAt(gaps, i);
    printf("    %-5s at %8.4fs  %7.1f ms\n", i == 0 ? label.UTF8String : "",
           CMTimeGetSeconds(range.start), CMTimeGetSeconds(range.duration) * 1000.0);
  }
}

/// Every segment, source range against target range. `empty` is a hole;
/// source duration != target duration is a time-stretched segment, which is a
/// different defect from a hole and has to be told apart from one.
static void SPPrintSegments(NSString *label, AVMutableCompositionTrack *track)
{
  if (track == nil) {
    printf("  %s track: absent\n", label.UTF8String);
    return;
  }
  printf("  %s track %.4fs, %lu segment(s)\n", label.UTF8String,
         CMTimeGetSeconds(track.timeRange.duration),
         (unsigned long)track.segments.count);
  for (AVCompositionTrackSegment *segment in track.segments) {
    CMTimeRange source = segment.timeMapping.source;
    CMTimeRange target = segment.timeMapping.target;
    if (segment.isEmpty) {
      printf("    EMPTY  target %8.4f +%8.4f\n", CMTimeGetSeconds(target.start),
             CMTimeGetSeconds(target.duration));
      continue;
    }
    double const stretch =
        CMTimeGetSeconds(target.duration) - CMTimeGetSeconds(source.duration);
    printf("    src %8.4f +%8.4f -> tgt %8.4f +%8.4f%s\n",
           CMTimeGetSeconds(source.start), CMTimeGetSeconds(source.duration),
           CMTimeGetSeconds(target.start), CMTimeGetSeconds(target.duration),
           fabs(stretch) > kSPEpsilon ? "   STRETCHED" : "");
  }
}

static int SPCommandGaps(SPAnchor anchor, NSArray<NSString *> *paths)
{
  AVMutableCompositionTrack *video = nil;
  AVMutableCompositionTrack *audio = nil;
  CMTime cursor = kCMTimeZero;
  NSError *error = nil;
  AVMutableComposition *composition =
      SPCompose(paths, anchor, 0, &video, &audio, &cursor, &error);
  if (composition == nil) {
    fprintf(stderr, "stitch_probe: compose failed: %s\n",
            error.localizedDescription.UTF8String);
    return 1;
  }

  printf("anchor %s, %lu segment(s)\n", SPAnchorName(anchor).UTF8String,
         (unsigned long)paths.count);
  printf("  cursor      %8.4fs\n", CMTimeGetSeconds(cursor));
  SPPrintSegments(@"video", video);
  SPPrintSegments(@"audio", audio);

  NSArray<NSValue *> *videoGaps = SPVideoGaps(composition, video, &error);
  NSArray<NSValue *> *audioGaps = SPAudioGaps(composition, audio, &error);
  if (videoGaps == nil || audioGaps == nil) {
    fprintf(stderr, "stitch_probe: read failed: %s\n",
            error.localizedDescription.UTF8String);
    return 1;
  }
  printf("  gaps in decoded output (video = repeated picture, audio = silence)\n");
  SPPrintGaps(@"video", videoGaps);
  SPPrintGaps(@"audio", audioGaps);
  return 0;
}

/// Asserts the actual gaps against `expected`, printing one line per case.
static BOOL SPCheck(NSString *caseName,
                    NSString *trackName,
                    NSArray<NSValue *> *actual,
                    NSArray<NSValue *> *expected)
{
  NSString *label =
      [NSString stringWithFormat:@"%@ %@", caseName, trackName];
  if (actual.count != expected.count) {
    printf("FAIL %-34s %lu gap(s), expected %lu\n", label.UTF8String,
           (unsigned long)actual.count, (unsigned long)expected.count);
    return NO;
  }
  for (NSUInteger i = 0; i < actual.count; i++) {
    CMTimeRange got = SPRangeAt(actual, i);
    CMTimeRange want = SPRangeAt(expected, i);
    double const startDelta =
        fabs(CMTimeGetSeconds(got.start) - CMTimeGetSeconds(want.start));
    double const sizeDelta =
        fabs(CMTimeGetSeconds(got.duration) - CMTimeGetSeconds(want.duration));
    if (startDelta > kSPEpsilon || sizeDelta > kSPEpsilon) {
      printf("FAIL %-34s gap %lu at %.4fs/%.1fms, expected %.4fs/%.1fms\n",
             label.UTF8String, (unsigned long)i, CMTimeGetSeconds(got.start),
             CMTimeGetSeconds(got.duration) * 1000.0, CMTimeGetSeconds(want.start),
             CMTimeGetSeconds(want.duration) * 1000.0);
      return NO;
    }
  }
  if (expected.count == 0) {
    printf("ok   %-34s no gaps\n", label.UTF8String);
  } else {
    CMTimeRange first = SPRangeAt(expected, 0);
    printf("ok   %-34s %lu gap(s), %.1f ms each, first at %.4fs\n", label.UTF8String,
           (unsigned long)expected.count, CMTimeGetSeconds(first.duration) * 1000.0,
           CMTimeGetSeconds(first.start));
  }
  return YES;
}

/// One fixture, both anchors, three repeats.
static BOOL SPVerifyFixture(NSString *path, NSUInteger repeats, BOOL *outSawVideoGapOnOldAnchor)
{
  SPSegmentShape shape;
  if (!SPMeasure(path, &shape)) {
    return NO;
  }

  NSMutableArray<NSString *> *paths = [NSMutableArray array];
  for (NSUInteger i = 0; i < repeats; i++) {
    [paths addObject:path];
  }

  NSString *name = path.lastPathComponent.stringByDeletingPathExtension;
  printf("\n%s  video %.4fs  audio %.4fs  asset %.4fs  (audio %+.1f ms vs video)\n",
         name.UTF8String, shape.videoEnd, shape.audioEnd, shape.assetDuration,
         shape.hasAudio ? (shape.audioEnd - shape.videoEnd) * 1000.0 : 0.0);

  BOOL passed = YES;
  SPAnchor const anchors[] = {SPAnchorVideoEnd, SPAnchorAssetDuration};
  for (int a = 0; a < 2; a++) {
    SPAnchor anchor = anchors[a];
    AVMutableCompositionTrack *video = nil;
    AVMutableCompositionTrack *audio = nil;
    NSError *error = nil;
    AVMutableComposition *composition =
        SPCompose(paths, anchor, 0, &video, &audio, NULL, &error);
    if (composition == nil) {
      printf("FAIL %s %s: compose failed: %s\n", name.UTF8String,
             SPAnchorName(anchor).UTF8String, error.localizedDescription.UTF8String);
      return NO;
    }

    double const take =
        anchor == SPAnchorVideoEnd ? shape.videoEnd : shape.assetDuration;
    NSString *caseName =
        [NSString stringWithFormat:@"%@/%@", name, SPAnchorName(anchor)];

    NSArray<NSValue *> *videoGaps = SPVideoGaps(composition, video, &error);
    NSArray<NSValue *> *audioGaps = SPAudioGaps(composition, audio, &error);
    if (videoGaps == nil || audioGaps == nil) {
      printf("FAIL %s: read failed: %s\n", caseName.UTF8String,
             error.localizedDescription.UTF8String);
      return NO;
    }

    passed &= SPCheck(caseName, @"video", videoGaps,
                      SPExpectedGaps(shape.videoEnd, take, repeats));
    // Audio is inserted over the same range, so it can only fill up to
    // whichever of the two ends first.
    double const audioReach = MIN(shape.audioEnd, take);
    passed &= SPCheck(caseName, @"audio", audioGaps,
                      shape.hasAudio ? SPExpectedGaps(audioReach, take, repeats)
                                     : @[]);

    // The other half of the claim: `cursor` is shared, so both tracks are
    // re-anchored at every boundary and NOTHING accumulates. If the two track
    // lengths agree under both anchors, then a test that measured A/V drift
    // at 30/60/90s would have read zero on the broken anchor too, and passed
    // it while the holes above were there.
    if (shape.hasAudio) {
      double const drift = fabs(CMTimeGetSeconds(video.timeRange.duration) -
                                CMTimeGetSeconds(audio.timeRange.duration));
      NSString *label =
          [NSString stringWithFormat:@"%@ drift", caseName];
      if (drift > kSPEpsilon) {
        printf("FAIL %-34s tracks differ by %.1f ms\n", label.UTF8String, drift * 1000.0);
        passed = NO;
      } else {
        printf("ok   %-34s tracks agree, so A/V drift is 0 ms here\n", label.UTF8String);
      }
    }

    if (anchor == SPAnchorAssetDuration && videoGaps.count > 0) {
      *outSawVideoGapOnOldAnchor = YES;
    }
  }
  return passed;
}

static int SPCommandVerify(NSArray<NSString *> *paths)
{
  NSUInteger const kRepeats = 3;
  BOOL passed = YES;
  BOOL sawVideoGapOnOldAnchor = NO;
  for (NSString *path in paths) {
    passed &= SPVerifyFixture(path, kRepeats, &sawVideoGapOnOldAnchor);
  }

  // The test has to be able to fail. If no fixture made the old anchor drop a
  // frame of picture, then every case above would also have passed before the
  // fix and this run proved nothing about it.
  printf("\n");
  if (!sawVideoGapOnOldAnchor) {
    printf("FAIL discrimination                     no fixture produced a video gap "
           "on the asset-duration anchor;\n"
           "                                        this run does not distinguish the "
           "two anchors\n");
    passed = NO;
  } else {
    printf("ok   discrimination                     asset-duration anchor holes the "
           "picture where video-end does not\n");
  }

  printf("\n%s\n", passed ? "PASS" : "FAILED");
  return passed ? 0 : 1;
}

#pragma mark - main

static int SPUsage(void)
{
  fprintf(stderr,
          "usage:\n"
          "  stitch_probe verify <seg.mp4>...\n"
          "  stitch_probe gaps <video-end|asset-duration> <seg.mp4>...\n");
  return 2;
}

int main(int argc, const char *argv[])
{
  @autoreleasepool {
    if (argc < 3) {
      return SPUsage();
    }
    NSString *command = @(argv[1]);

    if ([command isEqualToString:@"verify"]) {
      NSMutableArray<NSString *> *paths = [NSMutableArray array];
      for (int i = 2; i < argc; i++) {
        [paths addObject:@(argv[i])];
      }
      return SPCommandVerify(paths);
    }

    if ([command isEqualToString:@"gaps"]) {
      if (argc < 4) {
        return SPUsage();
      }
      NSString *mode = @(argv[2]);
      SPAnchor anchor;
      if ([mode isEqualToString:@"video-end"]) {
        anchor = SPAnchorVideoEnd;
      } else if ([mode isEqualToString:@"asset-duration"]) {
        anchor = SPAnchorAssetDuration;
      } else {
        return SPUsage();
      }
      NSMutableArray<NSString *> *paths = [NSMutableArray array];
      for (int i = 3; i < argc; i++) {
        [paths addObject:@(argv[i])];
      }
      return SPCommandGaps(anchor, paths);
    }

    return SPUsage();
  }
}
