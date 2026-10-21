import { NativeModules } from 'react-native';

/**
 * Bridge to the GlassesMediaLibrary native module (clip-stitcher local
 * package): how the glasses' own full-resolution recordings get in.
 *
 * The toolkit's stream tops out at 720x1280. What the glasses record to their
 * own storage is 1520x2032 HEVC in HLG colour, with the glasses' microphones.
 * No API reaches that file; Meta AI syncs it into the photo library, and the
 * library is where this finds it.
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
   * False for everything but full access. `limited` reads fine but only sees
   * hand-picked assets, and nobody hand-picks each recording as it syncs.
   */
  usable: boolean;
}

/** A video in the library, as Photos describes it without opening it. */
export interface LibraryVideo {
  localIdentifier: string;
  /** Epoch ms from the asset's creation date (approximately capture start). */
  startedAtMs: number;
  durationSec: number;
  width: number;
  height: number;
}

export interface GlassesConfirmation {
  isGlasses: boolean;
  /**
   * True when the asset could not be examined because it is still in iCloud.
   * Never a verdict: it resolves once the asset lands locally.
   */
  pendingDownload: boolean;
  /** Present only when `isGlasses`: the exact capture start and length. */
  startedAtMs?: number;
  durationSec?: number;
  width?: number;
  height?: number;
}

export interface GlassesExportResult {
  /** Absolute path of the copied original, in Caches; delete it once cut. */
  path: string;
  bytes: number;
}

interface GlassesMediaLibraryModule {
  requestAccess(): Promise<PhotoAccessResult>;
  /** The current verdict, without prompting. */
  currentAccess(): Promise<PhotoAccessResult>;
  /**
   * Every video created at or after `sinceMs`, newest first, glasses or not.
   * Opens nothing; the caller filters by marker before confirming any.
   */
  listRecentVideos(sinceMs: number, limit: number): Promise<{ videos: LibraryVideo[] }>;
  /** Opens one asset and decides whether the glasses recorded it. */
  confirmGlassesVideo(localIdentifier: string): Promise<GlassesConfirmation>;
  /** Copies the asset's original bytes, unre-encoded, into app storage. */
  exportOriginal(localIdentifier: string): Promise<GlassesExportResult>;
  startWatching(): Promise<boolean>;
  stopWatching(): Promise<boolean>;
  /** Appends a line to Documents/clypso-diagnostics.log. */
  log(message: string): void;
}

const native: GlassesMediaLibraryModule | undefined = NativeModules.GlassesMediaLibrary;

/** False on Android and in tests: there is no photo-library import there. */
export function glassesLibraryAvailable(): boolean {
  return native != null;
}

function requireNative(): GlassesMediaLibraryModule {
  if (!native) {
    throw new Error('GlassesMediaLibrary native module missing — rebuild the iOS app.');
  }
  return native;
}

export const GlassesMediaLibraryNative = {
  requestAccess: () => requireNative().requestAccess(),
  currentAccess: () => requireNative().currentAccess(),
  listRecentVideos: (sinceMs: number, limit: number) =>
    requireNative().listRecentVideos(sinceMs, limit),
  confirmGlassesVideo: (localIdentifier: string) =>
    requireNative().confirmGlassesVideo(localIdentifier),
  exportOriginal: (localIdentifier: string) => requireNative().exportOriginal(localIdentifier),
  startWatching: () => requireNative().startWatching(),
  stopWatching: () => requireNative().stopWatching(),
  log: (message: string) => native?.log(message),
};
