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

/** The product's trigger phrase. Saying it auto-saves the look-back clip. */
export const WAKE_PHRASE = 'fade away';

export const DEFAULT_SETTINGS: Settings = {
  bufferSeconds: 30,
  deviceKind: 'mock',
  wakeWord: {
    provider: 'mock',
    keyword: WAKE_PHRASE,
  },
};
