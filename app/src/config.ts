import type { Settings } from './types';

export const BUFFER_SECONDS_MIN = 30;
export const BUFFER_SECONDS_MAX = 90;

/** Length of each rolling segment. Shorter = tighter clip boundaries, more file churn. */
export const SEGMENT_SECONDS = 5;

export const DEFAULT_SETTINGS: Settings = {
  bufferSeconds: 60,
  deviceKind: 'mock',
  wakeWord: {
    provider: 'mock',
    keyword: 'jarvis',
  },
};
