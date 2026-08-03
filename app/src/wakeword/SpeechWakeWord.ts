import { NativeEventEmitter, NativeModules, Platform } from 'react-native';
import type { TranscriptWord } from '../native/SpeechWakeWordNative';
import { SpeechWakeWordNative } from '../native/SpeechWakeWordNative';
import { matchesWakePhrase } from './phraseMatch';
import type { WakeDetection, WakeWordProvider } from './WakeWordProvider';

/** Ignore repeat detections for this long after one fires. */
const DEBOUNCE_MS = 3500;

/**
 * Seconds into the segment where the trigger phrase finishes, or null when the
 * recognizer gave no timings or none of the prefixes match.
 *
 * Works by replaying the transcript one word at a time through the SAME
 * matcher the detection itself used, so there is exactly one definition of
 * what counts as the wake phrase. The first prefix that matches is the first
 * utterance of it, and that word's end is where the clip should stop.
 */
function findPhraseEndSec(words: TranscriptWord[]): number | null {
  for (let i = 0; i < words.length; i++) {
    const prefix = words
      .slice(0, i + 1)
      .map(w => w.text)
      .join(' ');
    if (matchesWakePhrase(prefix)) {
      return words[i].end;
    }
  }
  return null;
}

/**
 * Keyless "Clipso" detection with the OS's own speech
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

  private onDetected: ((detection?: WakeDetection) => void) | null = null;
  private lastFiredAt = 0;
  private subscription: { remove: () => void } | null = null;

  async start(onDetected: (detection?: WakeDetection) => void): Promise<void> {
    const ok = await SpeechWakeWordNative.requestPermission();
    console.log('[wakeword] start — speech permission granted:', ok);
    if (!ok) {
      throw new Error(
        Platform.OS === 'ios'
          ? 'Speech recognition permission denied — enable it in iOS Settings → Clipso.'
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
      .then(({ transcript, words }) => {
        if (transcript) {
          this.handleTranscript(transcript, words, path);
        }
      })
      .catch(err => {
        // Segment may have been evicted mid-transcription; quiet segments
        // resolve empty. Not worth surfacing in the UI, but a recognizer that
        // is rejecting every segment must not look like a quiet room.
        console.log('[wakeword] transcribe failed:', String(err));
      });
  }

  private handleTranscript(
    transcript: string,
    words?: TranscriptWord[],
    segmentPath?: string,
  ): void {
    const matched = matchesWakePhrase(transcript);
    console.log(
      `[wakeword] transcript "${transcript}" → ${matched ? 'HIT' : 'miss'}`,
    );
    if (!this.onDetected || !matched) {
      return;
    }
    const now = Date.now();
    if (now - this.lastFiredAt < DEBOUNCE_MS) {
      console.log('[wakeword] HIT ignored — inside debounce window');
      return;
    }
    this.lastFiredAt = now;

    // Android recognizes live from the mic and reports a bare transcript, so
    // there is no segment and no timing to hand back — the clip just ends at
    // the buffer boundary as before.
    const endOffsetSec = words ? findPhraseEndSec(words) : null;
    if (segmentPath === undefined || endOffsetSec === null) {
      this.onDetected();
      return;
    }
    console.log(`[wakeword] phrase ends ${endOffsetSec.toFixed(2)}s into segment`);
    this.onDetected({ segmentPath, endOffsetSec });
  }
}
