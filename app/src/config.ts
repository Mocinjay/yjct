import { DEFAULT_CAPTION_STYLE } from './captions/captionStyles';
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
export const WAKE_PHRASE = 'Clypso';

/**
 * Padding kept after the trigger word finishes when ending a clip on it.
 * Word timings land on the last audible frame, so cutting exactly there
 * clips the tail of the word off; this leaves it intact without letting
 * dead air back in.
 */
export const WAKE_TRIM_PADDING_SECONDS = 0.3;

export const DEFAULT_SETTINGS: Settings = {
  bufferSeconds: 30,
  // Glasses-only: the phone-camera mock remains in the codebase for tests,
  // but the product records exclusively from Meta glasses.
  deviceKind: 'mwdat',
  wakeWord: {
    // Keyless OS speech recognition — say "Clypso" with zero setup, no
    // vendor key, no model download.
    provider: 'speech',
  },
  captionStyle: DEFAULT_CAPTION_STYLE,
  // Off by default: the product is clip + caption. The hook-first re-cut is a
  // second, opinionated transformation on top of that, so it is opt-in rather
  // than something every clip silently gets.
  climaxEdit: false,
  glassesChime: true,
  // On by default, because it is the only path that reaches the quality the
  // product promises: the glasses record 1520x2032 HDR to their own storage,
  // where the live stream is capped at 720x1280 by `StreamingResolution` and
  // cannot be raised (see docs/LEECH-ARCHITECTURE.md §2). Leaving this off
  // meant the app shipped with its best footage unreachable behind a switch
  // nobody found.
  //
  // It does hold a microphone whenever it is armed, which is why this was
  // originally off. That cost is now paid explicitly: turning it on prompts
  // for photo access at the moment of arming rather than silently at launch,
  // and the settings screen still says plainly what is being held.
  glassesLibraryImport: true,
};
