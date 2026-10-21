import { NativeModules } from 'react-native';

/**
 * Bridge to the SpeechWakeWord native module (lives in the clip-stitcher
 * local package). iOS exposes file transcription (Apple Speech framework) and
 * a microphone recorder for glasses-only mode; Android exposes continuous mic
 * recognition with transcript events.
 */
/** One recognized word and when it finished, in seconds from segment start. */
export interface TranscriptWord {
  text: string;
  end: number;
}

export interface TranscriptResult {
  /** Full recognized text; "" when the segment was silent. */
  transcript: string;
  /** Per-word timings; empty when the recognizer reported none. */
  words: TranscriptWord[];
}

/**
 * A closed microphone segment, pushed by iOS while `startListening` is active.
 * `startedAtMs` puts the audio on the wall clock, so a phrase heard inside it
 * can be located in a recording the phone took no part in.
 */
export interface WakeSegmentEvent {
  path: string;
  startedAtMs: number;
  durationSec: number;
  /** Loudest normalized sample (0…1): a quiet room versus a dead mic. */
  peak: number;
}

/** iOS: a closed microphone segment (see `WakeSegmentEvent`). */
export const WAKE_SEGMENT_EVENT = 'SpeechWakeWordSegment';
/** iOS: listening stopped for a reason the wearer did not ask for. */
export const WAKE_ERROR_EVENT = 'SpeechWakeWordError';
/** Android: a live transcript. */
export const WAKE_TRANSCRIPT_EVENT = 'SpeechWakeWordTranscript';

interface SpeechWakeWordModule {
  /** Resolves true when speech recognition is authorized/available. */
  requestPermission(): Promise<boolean>;
  /** iOS: transcribe a recorded segment file; empty transcript when silent. */
  transcribeFile(path: string): Promise<TranscriptResult>;
  /**
   * Begin owning a microphone. Android recognizes live and emits transcripts;
   * iOS records rolling segments and emits `SpeechWakeWordSegment`, leaving
   * transcription to `transcribeFile`.
   */
  startListening(): Promise<boolean>;
  stopListening(): Promise<boolean>;
}

export const SpeechWakeWordNative =
  NativeModules.SpeechWakeWord as SpeechWakeWordModule;
