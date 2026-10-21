import { DEFAULT_CAPTION_STYLE } from './phase2/captionStyles';
import type { Settings } from './types';

export const BUFFER_SECONDS_MIN = 30;
export const BUFFER_SECONDS_MAX = 90;

/** Free tier caps the look-back window; longer windows are Pro ($15/mo). */
export const FREE_BUFFER_SECONDS_MAX = 30;

/** Length of each rolling segment. Shorter = tighter clip boundaries, more file churn. */
export const SEGMENT_SECONDS = 5;

/**
 * Safety cap for a single clip recording after the trigger — protects
 * storage/battery if the wearer forgets to say stop.
 */
export const MAX_CLIP_RECORDING_SECONDS = 180;

/**
 * Free-tier clips are temporary: unless the wearer saves or publishes one,
 * it is wiped this many hours after capture. Pro clips never expire.
 *
 * Expiry is evaluated lazily on app launch and on Library focus — iOS gives
 * no dependable background execution, so a clip outlives its deadline until
 * the user next opens the app.
 */
export const FREE_RETENTION_HOURS = 24;

/**
 * The product's trigger word, as shown to the wearer. Say it and the
 * look-back window is saved. Detection lives in wakeword/phraseMatch.ts.
 */
export const WAKE_PHRASE = 'Clipso';

/**
 * Padding kept after the trigger word finishes when ending a clip on it.
 * Word timings land on the last audible frame, so cutting exactly there
 * clips the tail of the word off; this leaves it intact without letting
 * dead air back in.
 */
export const WAKE_TRIM_PADDING_SECONDS = 0.3;

/**
 * How far either end of a full-resolution cut may fall short of the 720p clip
 * it would replace and still replace it. Absorbs keyframe placement and clock
 * skew between the phone and the glasses; a cut shorter than that is kept as
 * a separate clip so no footage the wearer already has is lost.
 */
export const MASTER_COVERAGE_TOLERANCE_SECONDS = 1.5;

export const DEFAULT_SETTINGS: Settings = {
  bufferSeconds: 30,
  wakeWord: {
    // Keyless OS speech recognition — say "Clipso" with zero setup, no
    // vendor key, no model download.
    provider: 'speech',
  },
  captionStyle: DEFAULT_CAPTION_STYLE,
  // Off by default: the product is clip + caption. The hook-first re-cut is a
  // second, opinionated transformation on top of that, so it is opt-in rather
  // than something every clip silently gets.
  climaxEdit: false,
  // Off by default: the tone is a still capture fired on the live stream, at
  // the exact moment being clipped, and a still capture can interrupt the
  // video. Wearers who want the audible confirmation can turn it on.
  glassesChime: false,
  // Live by default: it always produces a clip, and upgrades it to full
  // resolution whenever the glasses recorded the same moment themselves.
  captureMode: 'live',
  fullResolution: true,
};
