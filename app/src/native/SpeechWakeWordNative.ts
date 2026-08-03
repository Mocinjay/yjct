import { NativeModules } from 'react-native';

/**
 * Bridge to the SpeechWakeWord native module (lives in the clip-stitcher
 * local package). iOS exposes file transcription (Apple Speech framework);
 * Android exposes continuous mic recognition with transcript events.
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

interface SpeechWakeWordModule {
  /** Resolves true when speech recognition is authorized/available. */
  requestPermission(): Promise<boolean>;
  /** iOS: transcribe a recorded segment file; empty transcript when silent. */
  transcribeFile(path: string): Promise<TranscriptResult>;
  /** Android: begin continuous mic recognition (emits transcript events). */
  startListening(): Promise<boolean>;
  /** Android: stop continuous mic recognition. */
  stopListening(): Promise<boolean>;
}

export const SpeechWakeWordNative =
  NativeModules.SpeechWakeWord as SpeechWakeWordModule;
