import { AppState } from 'react-native';
import type { NativeEventSubscription } from 'react-native';
import { captionQueue } from '../captioning/CaptionQueue';
import { BUFFER_SECONDS_MAX, FREE_BUFFER_SECONDS_MAX } from '../config';
import { entitlementStore } from '../core/EntitlementStore';
import { createLogger } from '../core/Logger';
import { ErrorCode } from '../core/errors';
import { settingsStore } from '../core/SettingsStore';
import { GlassesImportController } from '../markers/GlassesImportController';
import { MarkerStore } from '../markers/MarkerStore';
import { photoAccessBlocker } from '../markers/photoAccess';
import { GlassesMediaLibraryNative } from '../native/GlassesMediaLibraryNative';
import { SpeechWakeWord } from '../wakeword/SpeechWakeWord';

const log = createLogger('glasses-import');

/**
 * Seconds of footage kept before the trigger word.
 *
 * Independent of the rolling-buffer setting on purpose: that number is a
 * promise about how much video the phone is holding in memory, and here the
 * phone is holding none. The recording already exists in full, so the only
 * question is how far back the interesting part started.
 */
const LOOKBACK_SECONDS = 20;

/**
 * The always-on half of the app: listen now, clip when the footage shows up.
 *
 * A singleton because it owns a microphone and a photo-library observer, and
 * because it has to outlive every screen — the wearer is out with the glasses,
 * and the app is backgrounded for the entire useful part of its life.
 */
class GlassesImportService {
  private controller: GlassesImportController | null = null;
  private appStateSub: NativeEventSubscription | null = null;
  private blocker: string | null = null;
  private listeners = new Set<(blocker: string | null) => void>();

  get running(): boolean {
    return this.controller !== null;
  }

  /**
   * Why importing is not running despite being switched on, or null.
   *
   * Read by the settings screen so the switch and the reality agree. Kept here
   * rather than thrown from `start()` because it outlives the call: the wearer
   * turns Photos down to Selected weeks later, and the screen has to be able to
   * say so whenever it is next opened.
   */
  get blockedBecause(): string | null {
    return this.blocker;
  }

  subscribe(listener: (blocker: string | null) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private setBlocker(next: string | null): void {
    if (this.blocker === next) {
      return;
    }
    this.blocker = next;
    for (const listener of this.listeners) {
      listener(next);
    }
  }

  /**
   * Ask for photo access, for the moment the wearer reaches for the switch.
   *
   * Returns the reason importing cannot run, or null when it can — the caller
   * is expected to leave the setting alone on a reason. Switching something on
   * that cannot work is the failure this whole feature is most exposed to.
   */
  async requestEnable(): Promise<string | null> {
    const access = await GlassesMediaLibraryNative.requestAccess();
    const blocker = photoAccessBlocker(access.status);
    this.setBlocker(blocker);
    return blocker;
  }

  /**
   * Start if the setting is on and access allows it; a no-op otherwise.
   *
   * Safe to call repeatedly, and called on every foreground — which is what
   * catches access being taken away in Settings after it was granted.
   */
  async syncWithSettings(): Promise<void> {
    const { glassesLibraryImport } = await settingsStore.get();
    if (!glassesLibraryImport) {
      this.setBlocker(null);
      await this.stop();
      return;
    }

    const access = await GlassesMediaLibraryNative.currentAccess();
    const blocker = photoAccessBlocker(access.status);
    this.setBlocker(blocker);
    if (blocker !== null) {
      // Switched on, but it cannot hear anything useful. Stopping is the honest
      // move: a microphone held open for markers that can never be matched
      // costs battery and buys nothing.
      if (this.controller) {
        log.info('photo access no longer usable — stopping', {
          status: access.status,
        });
      }
      await this.stop();
      return;
    }

    await this.start();
  }

  async start(): Promise<void> {
    if (this.controller) {
      return;
    }
    const controller = new GlassesImportController(
      new MarkerStore(),
      // The self-listening provider: with no stream running, nothing else is
      // recording audio, so the wake word has to hold its own microphone.
      new SpeechWakeWord({ ownMicrophone: true }),
      {
        lookbackSec: LOOKBACK_SECONDS,
        // Only reached when two triggers merge into one window, which tops out
        // at twice the look-back. That fits Pro; on free it gets trimmed to the
        // same ceiling the rolling buffer has.
        maxWindowSec: (await entitlementStore.isPro())
          ? BUFFER_SECONDS_MAX
          : FREE_BUFFER_SECONDS_MAX,
        onClipImported: clip =>
          captionQueue
            .enqueue(clip.id)
            .catch(err =>
              log.error('could not queue captioning', err, ErrorCode.CaptionJobFailed),
            ),
      },
    );
    await controller.start();
    this.controller = controller;

    // The library observer only fires while the app is running. Coming back to
    // the foreground is the other moment worth checking, because that is when
    // a sync that happened while the app was asleep becomes visible — and the
    // only moment photo access can be re-examined, since revoking it in
    // Settings notifies nobody.
    this.appStateSub = AppState.addEventListener('change', state => {
      if (state === 'active') {
        this.onForeground().catch(err =>
          log.expected('foreground sync failed', err, ErrorCode.StorageIndexUnreadable),
        );
      }
    });

    // Catch up on anything that synced while the app was closed entirely.
    const caught = await controller.sync().catch(err => {
      log.expected('initial sync failed', err, ErrorCode.StorageIndexUnreadable);
      return [];
    });
    log.info('glasses import started', { clipsOnStartup: caught.length });
  }

  /** Re-check access, then catch up. Order matters: a revoked grant stops it. */
  private async onForeground(): Promise<void> {
    await this.syncWithSettings();
    await this.controller?.sync();
  }

  async stop(): Promise<void> {
    this.appStateSub?.remove();
    this.appStateSub = null;
    if (!this.controller) {
      return;
    }
    await this.controller.stop();
    this.controller = null;
    log.info('glasses import stopped');
  }

  /** Force a pass now — for a pull-to-refresh or a debug button. */
  async syncNow(): Promise<number> {
    if (!this.controller) {
      return 0;
    }
    const clips = await this.controller.sync();
    return clips.length;
  }
}

export const glassesImport = new GlassesImportService();
