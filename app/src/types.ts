import type { CaptionStyleKey } from './captions/captionStyles';

/**
 * Where a clip is in the auto-captioning pipeline.
 *
 * 'none' covers both "not started" and "not applicable" (free tier —
 * captioning is Pro). The library shows progress from this rather than
 * hiding the clip, so a clip is never missing while its captions cook.
 */
export type CaptionState = 'none' | 'queued' | 'processing' | 'ready' | 'failed';

/**
 * Shadow Proxy ingest lifecycle.
 *
 * MARKED_PENDING — wake word heard; UI card exists; master not in Photos yet.
 * INGESTING — Photos insert seen / cut running.
 * MASTER_READY — ≥1080p cut on disk; publish/share allowed.
 */
export type ClipIngestState = 'MARKED_PENDING' | 'INGESTING' | 'MASTER_READY';

export interface Clip {
  id: string;
  name: string;
  /** Absolute path to the clip MP4. Empty while MARKED_PENDING (no proxy video). */
  filePath: string;
  /** Absolute path to the poster-frame JPEG (often a live-stream still). */
  thumbnailPath: string;
  /** Epoch ms when the trigger fired. */
  capturedAt: number;
  durationSec: number;
  sourceKind: DeviceKind;
  /**
   * Shadow Proxy state. Absent on legacy clips → treat as MASTER_READY.
   */
  ingestState?: ClipIngestState;
  /** Marker that created this shadow card — used to promote when the master cuts. */
  markerId?: string;
  /**
   * Identifies the Path A armed session that produced this clip. Used to match
   * a Bluetooth proxy against a later Path B master of the same moment.
   */
  hardwareSessionId?: string;
  /**
   * Epoch ms when a Path B master silently replaced this clip's file on disk.
   * Absent until a successful Hybrid / Shadow promotion.
   */
  masterReplacedAt?: number | null;
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

/**
 * Where a clip's footage came from.
 *
 * `glasses-library` — Path B master cut from Photos.
 * `shadow` — wake-word placeholder until the master lands (Shadow Proxy).
 * `mwdat` — Path A stream clip (disabled for delivery under master-only).
 */
export type DeviceKind = 'mock' | 'mwdat' | 'glasses-library' | 'shadow';

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
  /**
   * Listen for "Clypso" continuously and clip from what the glasses recorded
   * themselves, rather than from the live stream.
   *
   * A different shape of capture, not a variation on it. Nothing streams, no
   * session is held, and the glasses are recording to their own storage the
   * way they would with no app installed — which is why the footage is
   * 1520x2032 HDR instead of the 720x1280 the Bluetooth link allows. The cost
   * is that clips appear only once Meta AI has synced the recording across,
   * and that the phone holds a microphone the whole time it is armed.
   */
  glassesLibraryImport: boolean;
  /**
   * Experimental: after a wake-word mark, open Meta View / Meta AI once via
   * `fb-viewapp://` to test whether that shortens Photos sync. Off by default
   * — leaves Clypso mid-session. See docs/LATERAL-WORKAROUNDS.md.
   */
  metaViewNudgeAfterMark: boolean;
}

export interface WakeWordConfig {
  /**
   * speech — OS built-in speech recognition, keyless (default)
   * mock   — manual on-screen trigger button (dev/simulator)
   */
  provider: 'speech' | 'mock';
}
