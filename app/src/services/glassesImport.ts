import { AppState } from 'react-native';
import type { NativeEventSubscription } from 'react-native';
import { captionQueue } from '../captioning/CaptionQueue';
import { createLogger } from '../core/Logger';
import { ErrorCode } from '../core/errors';
import { settingsStore } from '../core/SettingsStore';
import { GlassesImportController } from '../markers/GlassesImportController';
import { MarkerStore } from '../markers/MarkerStore';
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

  get running(): boolean {
    return this.controller !== null;
  }

  /** Start if the setting is on; a no-op otherwise. Safe to call repeatedly. */
  async syncWithSettings(): Promise<void> {
    const { glassesLibraryImport } = await settingsStore.get();
    if (glassesLibraryImport) {
      await this.start();
    } else {
      await this.stop();
    }
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
    // a sync that happened while the app was asleep becomes visible.
    this.appStateSub = AppState.addEventListener('change', state => {
      if (state === 'active') {
        controller
          .sync()
          .catch(err =>
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
