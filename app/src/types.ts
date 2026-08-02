export interface Clip {
  id: string;
  name: string;
  /** Absolute path to the clip MP4. */
  filePath: string;
  /** Absolute path to the poster-frame JPEG. */
  thumbnailPath: string;
  /** Epoch ms when the trigger fired. */
  capturedAt: number;
  durationSec: number;
  sourceKind: DeviceKind;
  /**
   * Epoch ms when the user kept this clip, or null while it is still
   * temporary. Publishing counts as keeping it.
   */
  savedAt: number | null;
  /**
   * Epoch ms when an unsaved clip gets wiped, or null to keep it forever.
   * Free-tier clips get a 24h clock; Pro clips are born with null.
   */
  expiresAt: number | null;
  /** Platforms this clip has been published to, e.g. ['youtube']. */
  publishedTo?: string[];
}

export type DeviceKind = 'mock' | 'mwdat';

export interface Segment {
  /** Absolute file path of the recorded segment. */
  path: string;
  /** Epoch ms when recording of this segment started. */
  startedAt: number;
  durationSec: number;
}

export interface Settings {
  /** Rolling buffer window the user wants captured, 30–90s. */
  bufferSeconds: number;
  deviceKind: DeviceKind;
  wakeWord: WakeWordConfig;
}

export interface WakeWordConfig {
  /**
   * speech — OS built-in speech recognition, keyless (default)
   * mock   — manual on-screen trigger button (dev/simulator)
   */
  provider: 'speech' | 'mock';
}
