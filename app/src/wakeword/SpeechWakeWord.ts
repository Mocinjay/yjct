import { NativeEventEmitter, NativeModules, Platform } from 'react-native';
import type { TranscriptWord, WakeSegmentEvent } from '../native/SpeechWakeWordNative';
import {
  SpeechWakeWordNative,
  WAKE_ERROR_EVENT,
  WAKE_SEGMENT_EVENT,
  WAKE_TRANSCRIPT_EVENT,
} from '../native/SpeechWakeWordNative';
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
 * iOS, live mode: the capture controller feeds each recorded video segment
 * in (`feedSegment`); the audio is already ours, so there is no microphone
 * contention with the camera. iOS, glasses-only mode (`ownMicrophone`): the
 * native recorder owns the phone microphone and pushes wall-clock-stamped
 * segments, and detections carry `atMs`. Either way detection trails the
 * phrase by one segment (~2–6s); the look-back still contains the moment.
 *
 * Android: continuous mic recognition with transcript events.
 */
export class SpeechWakeWord implements WakeWordProvider {
  private onDetected: ((detection?: WakeDetection) => void) | null = null;
  private lastFiredAt = 0;
  private subscriptions: Array<{ remove: () => void }> = [];

  constructor(
    private readonly options: {
      /** Record from the phone microphone instead of being fed segments. */
      ownMicrophone?: boolean;
      /** Listening stopped on its own (microphone lost and not restartable). */
      onListeningError?: (message: string) => void;
    } = {},
  ) {}

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
    if (!this.ownsListening) {
      return;
    }
    const emitter = new NativeEventEmitter(NativeModules.SpeechWakeWord);
    if (Platform.OS === 'android') {
      this.subscriptions.push(
        emitter.addListener(WAKE_TRANSCRIPT_EVENT, (transcript: string) =>
          this.handleTranscript(transcript),
        ),
      );
    } else {
      this.subscriptions.push(
        emitter.addListener(WAKE_SEGMENT_EVENT, (event: WakeSegmentEvent) =>
          this.transcribe(event.path, event.startedAtMs),
        ),
        emitter.addListener(WAKE_ERROR_EVENT, ({ message }: { message: string }) =>
          this.options.onListeningError?.(message),
        ),
      );
    }
    // Listeners first, because native can emit before this resolves; taken
    // down again if it will not start, since a throwing start() gets no stop().
    try {
      await SpeechWakeWordNative.startListening();
    } catch (err) {
      this.clearSubscriptions();
      this.onDetected = null;
      throw err;
    }
  }

  async stop(): Promise<void> {
    this.onDetected = null;
    this.clearSubscriptions();
    if (this.ownsListening) {
      await SpeechWakeWordNative.stopListening().catch(() => {});
    }
  }

  /** Android always listens live; iOS only in glasses-only mode. */
  private get ownsListening(): boolean {
    return Platform.OS === 'android' || this.options.ownMicrophone === true;
  }

  private clearSubscriptions(): void {
    this.subscriptions.forEach(subscription => subscription.remove());
    this.subscriptions = [];
  }

  /**
   * iOS path: the capture controller feeds each recorded segment file here.
   * Fire-and-forget — transcription latency must never block the buffer.
   */
  feedSegment(path: string): void {
    if (Platform.OS !== 'ios') {
      return;
    }
    this.transcribe(path);
  }

  /** Transcribes one closed segment and acts on what it says. */
  private transcribe(path: string, startedAtMs?: number): void {
    if (!this.onDetected) {
      return;
    }
    SpeechWakeWordNative.transcribeFile(path)
      .then(({ transcript, words }) => {
        if (transcript) {
          this.handleTranscript(transcript, words, path, startedAtMs);
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
    segmentStartedAtMs?: number,
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
    // there is no segment and no timing to hand back — the clip ends at the
    // buffer boundary. The same applies when the recognizer gave no timings.
    const endOffsetSec = words ? findPhraseEndSec(words) : null;
    if (segmentPath === undefined || endOffsetSec === null) {
      this.onDetected();
      return;
    }
    console.log(`[wakeword] phrase ends ${endOffsetSec.toFixed(2)}s into segment`);
    const atMs =
      segmentStartedAtMs === undefined ? undefined : segmentStartedAtMs + endOffsetSec * 1000;
    this.onDetected({ segmentPath, endOffsetSec, atMs });
  }
}
