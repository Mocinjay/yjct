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
   * `outputPath` and writes a poster-frame JPEG next to it.
   */
  stitch(segmentPaths: string[], outputPath: string): Promise<StitchResult>;
}

const native: ClipStitcherModule | undefined = NativeModules.ClipStitcher;

export function stitchSegments(
  segmentPaths: string[],
  outputPath: string,
): Promise<StitchResult> {
  if (!native) {
    return Promise.reject(
      new Error(
        'ClipStitcher native module not linked — rebuild the app (pod install / gradle sync).',
      ),
    );
  }
  return native.stitch(segmentPaths, outputPath);
}
