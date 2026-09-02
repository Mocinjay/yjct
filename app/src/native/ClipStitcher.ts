import { NativeModules } from 'react-native';

/**
 * Per-segment audio-vs-video end skew, aggregated over one stitch.
 *
 * Signed: audio end minus video end, in milliseconds. Positive means audio
 * overhung the picture and its tail was dropped; negative means audio fell
 * short and that much silence landed at the boundary.
 *
 * `MWDATSegmentWriter` closes both writer inputs on the same wall-clock timer
 * while video carries frame PTS and audio carries the host clock, so a ragged
 * edge is structural. Its size on real hardware has never been measured, and
 * that number is what decides whether the silence is worth correcting at the
 * writer rather than logged at the stitcher.
 *
 * Absent on `extractRange`, which stitches nothing.
 */
export interface AvSkew {
  /** Segments carrying both a video track and a usable audio track. */
  segments: number;
  meanMs: number;
  /** Most positive skew seen (audio overhang). */
  maxMs: number;
  /** Most negative skew seen (audio shortfall). */
  minMs: number;
}

export interface StitchResult {
  /** Absolute path of the stitched MP4. */
  outputPath: string;
  /** Absolute path of the poster-frame JPEG. */
  thumbnailPath: string;
  durationSec: number;
  avSkew?: AvSkew;
}

interface ClipStitcherModule {
  /**
   * Losslessly concatenates the given segment MP4s (oldest first) into
   * `outputPath` and writes a poster-frame JPEG next to it, dropping
   * `trimEndSec` seconds off the end of the LAST segment.
   */
  stitch(
    segmentPaths: string[],
    outputPath: string,
    trimEndSec: number,
  ): Promise<StitchResult>;
  /**
   * Cuts `startSec`…`endSec` out of one recording without re-encoding, and
   * writes a poster frame next to it.
   */
  extractRange(
    sourcePath: string,
    startSec: number,
    endSec: number,
    outputPath: string,
  ): Promise<StitchResult>;
}

const native: ClipStitcherModule | undefined = NativeModules.ClipStitcher;

/**
 * @param trimEndSec seconds to cut off the end of the final segment — used to
 *   end a wake-word clip on the trigger word rather than at the segment
 *   boundary. 0 keeps the whole thing.
 */
export function stitchSegments(
  segmentPaths: string[],
  outputPath: string,
  trimEndSec = 0,
): Promise<StitchResult> {
  if (!native) {
    return Promise.reject(
      new Error(
        'ClipStitcher native module not linked — rebuild the app (pod install / gradle sync).',
      ),
    );
  }
  return native.stitch(segmentPaths, outputPath, trimEndSec);
}

/**
 * Cuts one window out of a recording the glasses made themselves.
 *
 * Passthrough, so the HEVC and its HDR colour survive: re-encoding here would
 * undo the entire reason for importing the original rather than using the
 * Bluetooth stream.
 */
export function extractRange(
  sourcePath: string,
  startSec: number,
  endSec: number,
  outputPath: string,
): Promise<StitchResult> {
  if (!native) {
    return Promise.reject(
      new Error(
        'ClipStitcher native module not linked — rebuild the app (pod install / gradle sync).',
      ),
    );
  }
  return native.extractRange(sourcePath, startSec, endSec, outputPath);
}
