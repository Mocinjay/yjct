import { NativeEventEmitter, NativeModules, Platform } from 'react-native';
import { createLogger } from '../core/Logger';
import { AppError, ErrorCode } from '../core/errors';
import type {
  TranscriptWord,
  WakeSegmentEvent,
} from '../native/SpeechWakeWordNative';
import {
  SpeechWakeWordNative,
  WAKE_ERROR_EVENT,
  WAKE_SEGMENT_EVENT,
  WAKE_TRANSCRIPT_EVENT,
} from '../native/SpeechWakeWordNative';
import { matchesWakePhrase } from './phraseMatch';
import type { WakeDetection, WakeWordProvider } from './WakeWordProvider';

const log = createLogger('wakeword');

/** Ignore repeat detections for this long after one fires. */
const DEBOUNCE_MS = 3500;

/**
 * Consecutive transcription failures before the recognizer is treated as
 * broken rather than unlucky.
 *
 * A single failure is routine — the segment may have been evicted mid-request,
 * or the audio may be silent. But every failure looks exactly like a quiet room
 * from the outside, so without a counter a recognizer that rejects *every*
 * segment presents as a wearer who simply never said the word. Three segments
 * is ~15s of the trigger silently not working.
 */
const FAILURE_STREAK_ALARM = 3;

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

/** How the provider gets audio to listen to. */
export interface SpeechWakeWordOptions {
  /**
   * Own a microphone instead of waiting to be fed segments.
   *
   * The fed path (the default) exists because the glasses stream already had
   * the phone recording, so taking a second microphone would have been a
   * conflict for no gain. It has one consequence that is easy to miss: with no
   * stream there are no segments, and with no segments the trigger word is
   * never heard.
   *
   * Set this when the wearer is recording on the glasses themselves — Meta's
   * own capture never involves the phone, which leaves the microphone free and
   * makes this the only way to hear anything at all. Detections then carry an
   * absolute `atMs`, because a rolling buffer is no longer the thing being cut.
   */
  ownMicrophone?: boolean;
}

/**
 * Keyless "Clypso" detection with the OS's own speech
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
  private subscriptions: { remove: () => void }[] = [];
  private failureStreak = 0;
  private readonly ownMicrophone: boolean;

  constructor(options: SpeechWakeWordOptions = {}) {
    this.ownMicrophone = options.ownMicrophone ?? false;
  }

  async start(onDetected: (detection?: WakeDetection) => void): Promise<void> {
    const ok = await SpeechWakeWordNative.requestPermission();
    log.info('starting', {
      permissionGranted: ok,
      platform: Platform.OS,
      ownMicrophone: this.ownMicrophone,
    });
    if (!ok) {
      throw new AppError(
        ErrorCode.WakeWordPermissionDenied,
        'speech recognition permission denied',
        {
          userMessage:
            Platform.OS === 'ios'
              ? 'Speech recognition permission denied — enable it in iOS Settings → Clypso.'
              : 'Speech recognition is not available on this device.',
        },
      );
    }
    this.failureStreak = 0;
    this.onDetected = onDetected;

    const emitter = new NativeEventEmitter(NativeModules.SpeechWakeWord);

    if (Platform.OS === 'android') {
      this.subscriptions.push(
        emitter.addListener(WAKE_TRANSCRIPT_EVENT, (transcript: string) =>
          this.handleTranscript(transcript),
        ),
      );
      await this.startNative();
      return;
    }

    if (!this.ownMicrophone) {
      return;
    }

    this.subscriptions.push(
      // Self-listening: the segment arrives with a wall-clock stamp, so a hit
      // can be reported as a moment in time rather than an offset into a
      // buffer this provider does not own.
      emitter.addListener(WAKE_SEGMENT_EVENT, (event: WakeSegmentEvent) =>
        this.transcribe(event.path, event.startedAtMs),
      ),
      // A recorder that stopped is indistinguishable from a silent room, so
      // the failure has to announce itself or the trigger just quietly ends.
      emitter.addListener(WAKE_ERROR_EVENT, ({ message }: { message: string }) =>
        log.error(
          'listening stopped',
          new Error(message),
          ErrorCode.WakeWordTranscribeFailed,
        ),
      ),
    );
    await this.startNative();
  }

  /**
   * Starts the recognizer, releasing the listeners if it will not start.
   *
   * The listeners are attached first because the native side can emit before
   * `startListening()` resolves. That ordering means a failure leaves them
   * attached to a recognizer that is not running — and since `start()` throws,
   * nobody calls `stop()` to take them down, so the next arm adds a second set
   * and every event fires twice.
   */
  private async startNative(): Promise<void> {
    try {
      await SpeechWakeWordNative.startListening();
    } catch (err) {
      this.clearSubscriptions();
      this.onDetected = null;
      throw AppError.from(err, ErrorCode.WakeWordStartFailed);
    }
  }

  private clearSubscriptions(): void {
    for (const subscription of this.subscriptions) {
      subscription.remove();
    }
    this.subscriptions = [];
  }

  async stop(): Promise<void> {
    this.onDetected = null;
    this.clearSubscriptions();
    if (Platform.OS === 'android' || this.ownMicrophone) {
      await SpeechWakeWordNative.stopListening().catch(err =>
        log.expected('stopListening failed', err, ErrorCode.WakeWordStopFailed),
      );
    }
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

  /**
   * Transcribe one closed segment and act on what it says.
   *
   * Both paths do exactly this; they differ only in whether a wall-clock start
   * time came with the file. Fire-and-forget on purpose — transcription
   * latency must never hold up the buffer that produced the segment.
   */
  private transcribe(path: string, startedAtMs?: number): void {
    if (!this.onDetected) {
      return;
    }
    SpeechWakeWordNative.transcribeFile(path)
      .then(({ transcript, words }) => {
        this.failureStreak = 0;
        if (transcript) {
          this.handleTranscript(transcript, words, path, startedAtMs);
        }
      })
      .catch(err => this.noteTranscribeFailure(err));
  }

  /**
   * One failure is routine: the segment may have been evicted
   * mid-transcription, and quiet segments resolve empty. A streak is not — it
   * means the trigger has silently stopped working, which from the outside is
   * indistinguishable from nobody speaking.
   */
  private noteTranscribeFailure(err: unknown): void {
    this.failureStreak += 1;
    if (this.failureStreak >= FAILURE_STREAK_ALARM) {
      // The streak count belongs in the context, not the message: it climbs by
      // one every 5s, so interpolating it makes every line a distinct dedupe
      // key and the alarm out-spams the failure it is reporting.
      log.error(
        'recognizer is rejecting every segment — the wake word is not working',
        err,
        ErrorCode.WakeWordTranscribeFailed,
      );
    } else {
      log.expected(
        'transcription failed for one segment',
        err,
        ErrorCode.WakeWordTranscribeFailed,
      );
    }
  }

  private handleTranscript(
    transcript: string,
    words?: TranscriptWord[],
    segmentPath?: string,
    segmentStartedAtMs?: number,
  ): void {
    const matched = matchesWakePhrase(transcript);
    // The transcript goes in the context. In the message it made every 5s
    // segment a new dedupe key, which is what let this one line grow the
    // logger's key set without bound across a long armed session.
    log.debug(matched ? 'transcript HIT' : 'transcript miss', { transcript });
    if (!this.onDetected || !matched) {
      return;
    }
    const now = Date.now();
    if (now - this.lastFiredAt < DEBOUNCE_MS) {
      log.debug('HIT ignored — inside debounce window');
      return;
    }
    this.lastFiredAt = now;

    // Android recognizes live from the mic and reports a bare transcript, so
    // there is no segment and no timing to hand back — the clip just ends at
    // the buffer boundary as before.
    const endOffsetSec = words ? findPhraseEndSec(words) : null;
    if (segmentPath === undefined || endOffsetSec === null) {
      log.info('wake phrase detected');
      this.onDetected();
      return;
    }
    // Where the phrase landed on the wall clock, for consumers that have to
    // find it in footage recorded somewhere other than this phone. Undefined
    // on the fed path, where the segment's own start time is not ours to know.
    const atMs =
      segmentStartedAtMs === undefined
        ? undefined
        : segmentStartedAtMs + endOffsetSec * 1000;
    log.info('wake phrase detected', {
      endOffsetSec: Number(endOffsetSec.toFixed(2)),
      atMs,
    });
    this.onDetected({ segmentPath, endOffsetSec, atMs });
  }
}
