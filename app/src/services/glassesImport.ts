import { AppState } from 'react-native';
import type { NativeEventSubscription } from 'react-native';
import {
  BUFFER_SECONDS_MAX,
  FREE_BUFFER_SECONDS_MAX,
  MASTER_COVERAGE_TOLERANCE_SECONDS,
} from '../config';
import { entitlementStore } from '../core/EntitlementStore';
import { settingsStore } from '../core/SettingsStore';
import { GlassesImportController } from '../markers/GlassesImportController';
import { errorText, importLog } from '../markers/importLog';
import { markerStore } from '../markers/MarkerStore';
import { photoAccessBlocker } from '../markers/photoAccess';
import {
  GlassesMediaLibraryNative,
  glassesLibraryAvailable,
} from '../native/GlassesMediaLibraryNative';
import { captionQueue } from '../phase2/CaptionQueue';

/** Settles a burst of markers (and the library writes behind them) into one pass. */
const MARKER_SYNC_DELAY_MS = 2000;

/**
 * The full-resolution import, for the life of the app: watches the photo
 * library for the glasses' own recordings and cuts the marked moments from
 * them (see GlassesImportController). A singleton because it owns the library
 * observer and has to outlive every screen; the recordings it waits for sync
 * while the app is backgrounded or closed.
 */
class GlassesImportService {
  private controller: GlassesImportController | null = null;
  private appStateSub: NativeEventSubscription | null = null;
  private unsubscribeMarkers: (() => void) | null = null;
  private markerSyncTimer: ReturnType<typeof setTimeout> | null = null;
  private blocker: string | null = null;
  private listeners = new Set<(blocker: string | null) => void>();

  get running(): boolean {
    return this.controller !== null;
  }

  /**
   * Why importing is not running although it is switched on, or null. Read by
   * Settings, so the switch and the reality agree, including weeks later when
   * Photos access has been turned down to Selected Photos.
   */
  get blockedBecause(): string | null {
    return this.blocker;
  }

  subscribe(listener: (blocker: string | null) => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  private setBlocker(next: string | null): void {
    if (this.blocker !== next) {
      this.blocker = next;
      this.listeners.forEach(listener => listener(next));
    }
  }

  /**
   * Starts or stops to match the setting and Photos access. Safe to call
   * repeatedly; called at launch (once onboarding is done), on every
   * foreground, and when the setting changes. Prompts for Photos access only
   * when the wearer has never been asked.
   */
  async syncWithSettings(): Promise<void> {
    if (!glassesLibraryAvailable()) {
      return;
    }
    const { fullResolution, captureMode } = await settingsStore.get();
    if (!fullResolution && captureMode !== 'glasses') {
      this.setBlocker(null);
      await this.stop();
      return;
    }
    const access = await GlassesMediaLibraryNative.currentAccess();
    const status =
      access.status === 'undetermined'
        ? (await GlassesMediaLibraryNative.requestAccess()).status
        : access.status;
    const blocker = photoAccessBlocker(status);
    this.setBlocker(blocker);
    if (blocker !== null) {
      if (this.controller) {
        importLog('photo access no longer usable, stopping', { status });
      }
      await this.stop();
      return;
    }
    await this.start();
  }

  private async start(): Promise<void> {
    if (this.controller) {
      return;
    }
    const isPro = await entitlementStore.isPro();
    const controller = new GlassesImportController(markerStore, {
      lookbackSec: FREE_BUFFER_SECONDS_MAX,
      maxWindowSec: isPro ? BUFFER_SECONDS_MAX : FREE_BUFFER_SECONDS_MAX,
      coverageToleranceSec: MASTER_COVERAGE_TOLERANCE_SECONDS,
      onClipReady: clip => {
        captionQueue.enqueue(clip.id).catch(() => {});
      },
    });
    this.controller = controller;
    await controller.start();

    // The library observer only fires while the app runs. A recording that
    // synced while it slept shows up on the next foreground, which is also
    // the only moment revoked access can be noticed.
    this.appStateSub = AppState.addEventListener('change', state => {
      if (state === 'active') {
        this.onForeground().catch(err =>
          importLog('foreground pass failed', { error: errorText(err) }),
        );
      }
    });
    // A marker can arrive after its recording: the wearer stops recording,
    // Meta AI syncs, and only then is "Clipso" said.
    this.unsubscribeMarkers = markerStore.subscribe(() => this.scheduleSync());

    importLog('full-resolution import started');
    await this.syncNow();
  }

  private scheduleSync(): void {
    if (this.markerSyncTimer) {
      clearTimeout(this.markerSyncTimer);
    }
    this.markerSyncTimer = setTimeout(() => {
      this.markerSyncTimer = null;
      this.syncNow().catch(() => {});
    }, MARKER_SYNC_DELAY_MS);
  }

  private async onForeground(): Promise<void> {
    await this.syncWithSettings();
    await this.syncNow();
  }

  async stop(): Promise<void> {
    this.appStateSub?.remove();
    this.appStateSub = null;
    this.unsubscribeMarkers?.();
    this.unsubscribeMarkers = null;
    if (this.markerSyncTimer) {
      clearTimeout(this.markerSyncTimer);
      this.markerSyncTimer = null;
    }
    const controller = this.controller;
    this.controller = null;
    if (controller) {
      await controller.stop();
      importLog('full-resolution import stopped');
    }
  }

  /** Runs a pass now. Resolves with how many clips gained full resolution. */
  async syncNow(): Promise<number> {
    if (!this.controller) {
      return 0;
    }
    try {
      return (await this.controller.sync()).length;
    } catch (err) {
      importLog('import pass failed', { error: errorText(err) });
      return 0;
    }
  }
}

export const glassesImport = new GlassesImportService();
