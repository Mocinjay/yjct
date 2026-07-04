import { NativeEventEmitter, NativeModules, Platform } from 'react-native';
import { SpeechWakeWordNative } from '../native/SpeechWakeWordNative';
import { matchesWakePhrase } from './phraseMatch';
import type { WakeWordProvider } from './WakeWordProvider';

/** Ignore repeat detections for this long after one fires. */
const DEBOUNCE_MS = 5000;

/**
 * Keyless "yo Jarvis, clip that" detection with the OS's own speech
 * recognition — no vendor, no API key, on-device where supported.
 *
 * iOS: rolling segment files are transcribed as they land (the audio is
 * already ours, so there is no microphone contention with the camera).
 * Detection trails the spoken phrase by one segment (~2–6s); the look-back
 * window still contains the moment, so nothing is lost.
 *
 * Android: continuous mic recognition with transcript events.
 */
export class SpeechWakeWord implements WakeWordProvider {
  readonly name = 'speech';

  private onDetected: (() => void) | null = null;
  private lastFiredAt = 0;
  private subscription: { remove: () => void } | null = null;

  async start(onDetected: () => void): Promise<void> {
    const ok = await SpeechWakeWordNative.requestPermission();
    if (!ok) {
      throw new Error(
        Platform.OS === 'ios'
          ? 'Speech recognition permission denied — enable it in iOS Settings → Jarvis.'
          : 'Speech recognition is not available on this device.',
      );
    }
    this.onDetected = onDetected;
    if (Platform.OS === 'android') {
      const emitter = new NativeEventEmitter(NativeModules.SpeechWakeWord);
      this.subscription = emitter.addListener(
        'SpeechWakeWordTranscript',
        (transcript: string) => this.handleTranscript(transcript),
      );
      await SpeechWakeWordNative.startListening();
    }
  }

  async stop(): Promise<void> {
    this.onDetected = null;
    if (Platform.OS === 'android') {
      this.subscription?.remove();
      this.subscription = null;
      await SpeechWakeWordNative.stopListening().catch(() => {});
    }
  }

  /**
   * iOS path: the capture controller feeds each recorded segment file here.
   * Fire-and-forget — transcription latency must never block the buffer.
   */
  feedSegment(path: string): void {
    if (Platform.OS !== 'ios' || !this.onDetected) {
      return;
    }
    SpeechWakeWordNative.transcribeFile(path)
      .then(transcript => {
        if (transcript) {
          this.handleTranscript(transcript);
        }
      })
      .catch(() => {
        // Segment may have been evicted mid-transcription; quiet segments
        // resolve empty. Either way: not an error worth surfacing.
      });
  }

  private handleTranscript(transcript: string): void {
    if (!this.onDetected || !matchesWakePhrase(transcript)) {
      return;
    }
    const now = Date.now();
    if (now - this.lastFiredAt < DEBOUNCE_MS) {
      return;
    }
    this.lastFiredAt = now;
    this.onDetected();
  }
}
