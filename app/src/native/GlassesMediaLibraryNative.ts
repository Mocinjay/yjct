import { NativeModules } from 'react-native';

/**
 * Bridge to the GlassesMediaLibrary native module (clip-stitcher local
 * package).
 *
 * This is how footage gets in when there is no stream. The toolkit's camera API
 * tops out at 720x1280 over Bluetooth; what the glasses record to their own
 * storage is roughly three and a half times the pixels, in HEVC, with HDR
 * colour and the glasses' own stereo microphones. No API reaches that file —
 * Meta AI syncs it into the photo library, and the library is where we find it.
 */

/** Emitted when the photo library changes at all; the cue to rescan. */
export const GLASSES_LIBRARY_CHANGED_EVENT = 'GlassesMediaLibraryChanged';

export type PhotoAccessStatus =
  | 'authorized'
  | 'limited'
  | 'denied'
  | 'restricted'
  | 'undetermined';

export interface PhotoAccessResult {
  status: PhotoAccessStatus;
  /**
   * False for everything but full access.
   *
   * `limited` deserves the extra flag: reads succeed, so it looks healthy, but
   * only assets the wearer hand-picked are visible — and they will not be
   * hand-picking each glasses recording as it syncs. For this feature that is
   * functionally denied, and saying so beats looking like the glasses never
   * recorded anything.
   */
  usable: boolean;
}

/** A recording the glasses made on their own, as the library sees it. */
export interface GlassesVideoAsset {
  localIdentifier: string;
  /**
   * Epoch ms at which the glasses began recording, read from
   * `com.apple.quicktime.creationdate`.
   *
   * Not the file's own timestamp, which is set when Meta AI finishes muxing
   * and transferring — measured 56 seconds later on a 17-second clip. Only the
   * capture time can place a spoken marker inside the footage.
   */
  startedAtMs: number;
  durationSec: number;
  width: number;
  height: number;
}

export interface GlassesConfirmation {
  /** Whether the glasses recorded this. */
  isGlasses: boolean;
  /**
   * True when the asset could not be examined because it is still in iCloud.
   *
   * Never cached as a verdict: it will resolve itself once the asset lands
   * locally, and treating it as "not glasses" would hide it forever.
   */
  pendingDownload: boolean;
  /** Present only when `isGlasses` — the exact capture time and length. */
  startedAtMs?: number;
  durationSec?: number;
  width?: number;
  height?: number;
}

export interface GlassesExportResult {
  /** Absolute path to the copied original. */
  path: string;
  bytes: number;
}

interface GlassesMediaLibraryModule {
  requestAccess(): Promise<PhotoAccessResult>;
  /**
   * Every video created at or after `sinceMs`, newest first — glasses or not.
   *
   * Cheap by design: reads only what the library already knows, opening
   * nothing. The caller filters this by marker before paying for
   * `confirmGlassesVideo`, so footage nobody marked is never examined.
   */
  listRecentVideos(
    sinceMs: number,
    limit: number,
  ): Promise<{ videos: GlassesVideoAsset[] }>;
  /**
   * Open one asset and decide whether the glasses recorded it.
   *
   * The expensive half, reached only for videos a marker already points into.
   */
  confirmGlassesVideo(localIdentifier: string): Promise<GlassesConfirmation>;
  /**
   * Copy the asset's original bytes into app storage.
   *
   * The original, not an export: re-encoding would flatten the HDR colour and
   * spend a generation of quality to arrive somewhere no better than the
   * stream this path exists to replace.
   */
  exportOriginal(localIdentifier: string): Promise<GlassesExportResult>;
  startWatching(): Promise<boolean>;
  stopWatching(): Promise<boolean>;
}

export const GlassesMediaLibraryNative =
  NativeModules.GlassesMediaLibrary as GlassesMediaLibraryModule;
