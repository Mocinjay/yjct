import type { CaptionStyleKey } from './phase2/captionStyles';

/**
 * Where a clip is in the auto-captioning pipeline.
 *
 * 'none' covers both "not started" and "not applicable" (free tier —
 * captioning is Pro). The library shows progress from this rather than
 * hiding the clip, so a clip is never missing while its captions cook.
 */
export type CaptionState = 'none' | 'queued' | 'processing' | 'ready' | 'failed';

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

  /** Captioning progress. Absent on clips captured before auto-captioning. */
  captionState?: CaptionState;
  /** The burned-in copy, once `captionState` is 'ready'. */
  captionedFilePath?: string | null;
  /** Which style the ready file was burned with. */
  captionStyle?: CaptionStyleKey;
  /**
   * Which provider produced it. The mock captioner copies the clip untouched,
   * so the UI must not show those as really captioned.
   */
  captionProvider?: string;
  /** Why the last attempt failed — surfaced, never swallowed. */
  captionError?: string | null;
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
  /** Look applied to auto-captions. Applies to clips captured from now on. */
  captionStyle: CaptionStyleKey;
  /**
   * Rebuild each clip hook-first: the strongest 3-7s moment, a beat of black,
   * then the complete original. iOS only for now.
   */
  climaxEdit: boolean;
  /**
   * Sound the glasses when a trigger lands and again when the clip is saved.
   * Behind a flag because the only sound MWDAT can make the glasses play is
   * their still-capture tone, and whether firing it disturbs the live video
   * stream is not yet confirmed on hardware.
   */
  glassesChime: boolean;
}

export interface WakeWordConfig {
  /**
   * speech — OS built-in speech recognition, keyless (default)
   * mock   — manual on-screen trigger button (dev/simulator)
   */
  provider: 'speech' | 'mock';
}
