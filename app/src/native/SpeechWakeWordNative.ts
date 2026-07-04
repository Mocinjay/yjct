import { NativeModules } from 'react-native';

/**
 * Bridge to the SpeechWakeWord native module (lives in the clip-stitcher
 * local package). iOS exposes file transcription (Apple Speech framework);
 * Android exposes continuous mic recognition with transcript events.
 */
interface SpeechWakeWordModule {
  /** Resolves true when speech recognition is authorized/available. */
  requestPermission(): Promise<boolean>;
  /** iOS: transcribe a recorded segment file; "" when silent. */
  transcribeFile(path: string): Promise<string>;
  /** Android: begin continuous mic recognition (emits transcript events). */
  startListening(): Promise<boolean>;
  /** Android: stop continuous mic recognition. */
  stopListening(): Promise<boolean>;
}

export const SpeechWakeWordNative =
  NativeModules.SpeechWakeWord as SpeechWakeWordModule;
