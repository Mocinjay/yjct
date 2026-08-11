import { NativeModules } from 'react-native';

export interface StitchResult {
  /** Absolute path of the stitched MP4. */
  outputPath: string;
  /** Absolute path of the poster-frame JPEG. */
  thumbnailPath: string;
  durationSec: number;
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
