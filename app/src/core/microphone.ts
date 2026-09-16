import { Emitter } from './Emitter';
import { createLogger } from './Logger';
import { ErrorCode } from './errors';

const log = createLogger('microphone');

/**
 * The two things in this app that can open the phone's microphone.
 *
 * `live-capture` is the glasses stream: `MWDATSegmentWriter` runs an
 * `AVAudioEngine` tap so every rolling segment carries sound, and the wake word
 * is transcribed from that same audio.
 *
 * `marker-listening` is the glasses-library path: `MicSegmentRecorder` runs its
 * own tap, because nothing streams and there are no segments to ride on.
 */
export type MicrophoneUser = 'live-capture' | 'marker-listening';

/** What `marker-listening` has to be able to do to yield. */
export interface YieldingMicrophoneUser {
  /** Close the microphone. Must resolve only once it is actually closed. */
  standDown: () => Promise<void>;
  /** Open it again. Called when the exclusive holder releases. */
  standUp: () => Promise<void>;
}

/**
 * One microphone, one owner.
 *
 * `AVAudioSession` is a single object per process, not one per claimant, so two
 * halves of this app each configuring it and each running an `AVAudioEngine`
 * input tap do not politely share it — they fight. Both were written to survive
 * losing the input, which means the fight is silent: each one restarts, the
 * restart is itself a configuration change the other one sees, and the pair can
 * spend a whole armed session rebuilding each other's engines while the wearer
 * gets a trigger word that is heard occasionally or not at all.
 *
 * That collision was theoretical until `glassesLibraryImport` began defaulting
 * on. Before it, `marker-listening` only ran for someone who had found a switch
 * buried in Settings; now it is running for everyone, including everyone who
 * also opens the Armed screen.
 *
 * **`live-capture` wins, and `marker-listening` stands down for the duration.**
 * The rule is not about which path produces better footage — that question is
 * still open (see `docs/LEECH-ARCHITECTURE.md` §3) and this deliberately does
 * not answer it. It is about which participant can function without a
 * microphone at all:
 *
 * - `live-capture` cannot. Its trigger word is transcribed from the audio track
 *   of the segments the writer records, so with no microphone there is no
 *   trigger, and its clips are silent besides.
 * - `marker-listening` can wait. It writes down wall-clock times and matches
 *   them against recordings that turn up minutes or hours later. What it loses
 *   while stood down is a trigger spoken during an arm — and during an arm
 *   `live-capture` is already cutting a clip for that same moment off its own
 *   trigger. Two clips of one moment is the outcome the union-merge in
 *   `markerMatching` exists to prevent within one recording, and it is no more
 *   wanted across the two paths.
 *
 * Nothing here opens or closes a microphone itself. It decides who may, and
 * makes the handover something a caller can wait for — which is the part that
 * matters, because `arm()` used to reach the audio session while the other half
 * was still inside its own teardown.
 */
class MicrophoneArbiter {
  private holder: MicrophoneUser | null = null;
  private yielding: YieldingMicrophoneUser | null = null;
  /** True while `marker-listening` is stood down and owed a resume. */
  private yielded = false;
  private changes = new Emitter<MicrophoneUser | null>();

  /** Who holds it, or null when nothing does. */
  get heldBy(): MicrophoneUser | null {
    return this.holder;
  }

  /** True while `marker-listening` is stood down for an exclusive holder. */
  get standingDown(): boolean {
    return this.yielded;
  }

  subscribe(listener: (holder: MicrophoneUser | null) => void): () => void {
    return this.changes.subscribe(listener);
  }

  /**
   * Register the yielding half, and stand it down immediately if the exclusive
   * holder is already armed.
   *
   * The immediate stand-down is not an edge case: the import service starts on
   * launch and on every foreground, and a foreground while armed is exactly
   * what happens when the wearer opens the app to check on a session.
   */
  async register(user: YieldingMicrophoneUser): Promise<void> {
    this.yielding = user;
    if (this.holder === null) {
      return;
    }
    this.yielded = true;
    await user.standDown();
    log.info('marker listening stood down on registration — capture holds the mic');
  }

  /** Forget the yielding half. It is responsible for its own teardown. */
  unregister(): void {
    this.yielding = null;
    this.yielded = false;
  }

  /**
   * Take the microphone for `live-capture`, waiting for the other half to let go.
   *
   * Resolves only once the yielding half reports itself closed, so the caller
   * can configure an audio session knowing nothing else in the process is
   * about to reconfigure it.
   */
  async acquireExclusive(): Promise<void> {
    this.holder = 'live-capture';
    const yielding = this.yielding;
    if (yielding !== null && !this.yielded) {
      this.yielded = true;
      try {
        await yielding.standDown();
        log.info('marker listening stood down — capture has the mic');
      } catch (err) {
        // The claim still stands. A stand-down that failed leaves two taps
        // fighting, which is bad, but refusing to arm because of it would make
        // a recoverable audio problem look like broken glasses.
        log.expected(
          'marker listening would not stand down',
          err,
          ErrorCode.WakeWordStopFailed,
        );
      }
    }
    this.changes.emit(this.holder);
  }

  /**
   * Give it back, and bring `marker-listening` up again.
   *
   * Idempotent, because `disarm()` runs both on the way out of a session and
   * inside `arm()`'s own failure path.
   */
  async releaseExclusive(): Promise<void> {
    if (this.holder !== 'live-capture' && !this.yielded) {
      return;
    }
    this.holder = null;
    const yielding = this.yielding;
    if (yielding !== null && this.yielded) {
      this.yielded = false;
      try {
        await yielding.standUp();
        log.info('marker listening resumed — capture released the mic');
      } catch (err) {
        // Logged, not thrown: the arm that is ending must finish ending. The
        // import service re-checks on every foreground, so a failed resume is
        // picked back up rather than being permanent.
        log.expected(
          'marker listening did not resume',
          err,
          ErrorCode.WakeWordStartFailed,
        );
      }
    }
    this.changes.emit(this.holder);
  }

  /** Tests only: forget every claim and every registration. */
  reset(): void {
    this.holder = null;
    this.yielding = null;
    this.yielded = false;
  }
}

export const microphone = new MicrophoneArbiter();
