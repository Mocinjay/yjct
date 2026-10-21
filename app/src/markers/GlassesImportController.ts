import { AppState, NativeEventEmitter, NativeModules } from 'react-native';
import type { NativeEventSubscription } from 'react-native';
import RNFS from 'react-native-fs';
import { MIN_MASTER_SHORT_EDGE_PX } from '../config';
import { clipStore, newClip, newClipId } from '../core/ClipStore';
import { entitlementStore } from '../core/EntitlementStore';
import { createLogger } from '../core/Logger';
import { emitTelemetry } from '../core/telemetry';
import { AppError, ErrorCode } from '../core/errors';
import { extractRange } from '../native/ClipStitcher';
import {
  GLASSES_LIBRARY_CHANGED_EVENT,
  GlassesMediaLibraryNative,
} from '../native/GlassesMediaLibraryNative';
import { MWDATNative } from '../native/MWDATNative';
import { MetaViewNudge } from '../native/MetaViewNudge';
import { settingsStore } from '../core/SettingsStore';
import type { Clip } from '../types';
import type { WakeWordProvider } from '../wakeword/WakeWordProvider';
import type { MarkerStore } from './MarkerStore';
import type { GlassesVideo } from './markerMatching';
import { clipRangesForVideo, markerOffsetSec, markersWithin } from './markerMatching';
import { ensurePreviewFrameCache, writeShadowThumbnail } from './shadowPreview';
import { concurrencyVerdict, findProxySwapCandidates, hybridSwapAllowed } from './streamConcurrency';

const log = createLogger('glasses-import');

/** How many recent videos to consider per pass. */
const SCAN_LIMIT = 200;

/** How often to re-scan Photos as a safety net if a change event is missed. */
const PHOTOS_POLL_MS = 60_000;

/**
 * Shadow cards stuck in MARKED_PENDING past this age trigger recovery:
 * force Photos observer rebaseline + aggressive sync. Meta thermal/sync
 * stalls can leave masters invisible indefinitely without this.
 *
 * Exported for unit tests that seed overdue shadow cards.
 */
export const MARKED_PENDING_TIMEOUT_MS = 45 * 60 * 1000;

/**
 * Clipping footage the glasses recorded on their own.
 *
 * The two halves of this never meet in real time. The phone listens and writes
 * down when it heard the trigger word; the glasses record to their own storage,
 * knowing nothing about any of it. Only later — once Meta AI has synced the
 * video into the photo library — can the two be put side by side, and that is
 * what a pass here does.
 *
 * The ordering is deliberate and is the whole privacy story: markers are
 * consulted first, against data the library gives away for free, so a recording
 * nobody marked is never opened, never copied, and never altered. It stays an
 * ordinary video in the library.
 */
export class GlassesImportController {
  private subscription: { remove: () => void } | null = null;
  private syncing = false;
  private started = false;
  /** True while the wake word holds a microphone. False while stood down. */
  private listening = false;
  /** Periodic Photos re-scan — Meta sync often arrives with no change event. */
  private pollTimer: ReturnType<typeof setInterval> | null = null;
  private markerListeners = new Set<(pending: number) => void>();
  /** Active after a Meta View nudge until the next foreground — mic health. */
  private nudgeInFlight: { runId: string; atMs: number } | null = null;
  private appStateSub: NativeEventSubscription | null = null;
  /** markerId → last SHADOW_TIMEOUT emit, so recovery does not spam. */
  private pendingTimeoutEmitted = new Set<string>();

  constructor(
    private readonly markerStore: MarkerStore,
    private readonly wakeWord: WakeWordProvider,
    private readonly options: {
      /** Seconds of footage to keep before the trigger word. */
      lookbackSec: number;
      /**
       * Longest single clip to cut, when two triggers merge into one window.
       * Undefined leaves the union uncapped.
       */
      maxWindowSec?: number;
      /** Called once per imported clip, for captioning and the hook-first edit. */
      onClipImported?: (clip: Clip) => void;
    },
  ) {}

  /**
   * Begin watching, and begin listening unless something else holds the mic.
   *
   * Photo access is requested up front rather than at the first sync: a wearer
   * who says the trigger word all afternoon and only then discovers the app
   * cannot read the library has lost the whole afternoon.
   *
   * `listen: false` starts the watching half only. It exists because the
   * alternative — open the microphone and let the arbiter close it a moment
   * later — reconfigures the shared `AVAudioSession` underneath a live-capture
   * session that is already using it, for no purpose. Nothing is lost by never
   * opening it: `resumeListening()` is what brings it up when the microphone is
   * free.
   */
  async start(options: { listen?: boolean } = {}): Promise<void> {
    if (this.started) {
      return;
    }

    const access = await GlassesMediaLibraryNative.requestAccess();
    if (!access.usable) {
      throw new AppError(
        ErrorCode.StorageIndexUnreadable,
        `photo library access is ${access.status}`,
        {
          userMessage:
            access.status === 'limited'
              ? 'Clypso needs access to all photos to find your glasses recordings — “Selected Photos” hides them.'
              : 'Clypso needs photo library access to import what your glasses recorded.',
        },
      );
    }

    if (options.listen ?? true) {
      await this.startListening();
    }

    ensurePreviewFrameCache();
    await this.attachPhotosObserver();

    this.pollTimer = setInterval(() => {
      this.sync().catch(err =>
        log.expected('poll sync failed', err, ErrorCode.StorageIndexUnreadable),
      );
    }, PHOTOS_POLL_MS);

    this.appStateSub = AppState.addEventListener('change', state => {
      this.onAppState(state);
    });

    this.started = true;
    log.info(
      this.listening
        ? 'listening for the trigger word and watching the library'
        : 'watching the library; the microphone is held elsewhere',
    );
  }

  /**
   * Cold-start / foreground: re-bind the Photos observer without creating a
   * second controller or duplicate shadow cards. Idempotent.
   */
  async reattachPhotosObserver(): Promise<void> {
    if (!this.started) {
      return;
    }
    await this.attachPhotosObserver();
    await this.recoverStuckPending();
    log.info('photos observer reattached');
  }

  private async attachPhotosObserver(): Promise<void> {
    this.subscription?.remove();
    this.subscription = null;

    const emitter = new NativeEventEmitter(NativeModules.GlassesMediaLibrary);
    this.subscription = emitter.addListener(
      GLASSES_LIBRARY_CHANGED_EVENT,
      (payload?: {
        reason?: string;
        inserted?: {
          meetsMasterFloor?: boolean;
          localIdentifier?: string;
          pixelWidth?: number;
          pixelHeight?: number;
        }[];
      }) => {
        if (payload?.reason === 'insert' && Array.isArray(payload.inserted)) {
          for (const asset of payload.inserted) {
            if (asset.meetsMasterFloor === false) {
              continue;
            }
            emitTelemetry('T_PHOTOS_INSERT', {
              runId: asset.localIdentifier ?? `insert_${Date.now()}`,
              localIdentifier: asset.localIdentifier ?? null,
              pixelWidth: asset.pixelWidth ?? null,
              pixelHeight: asset.pixelHeight ?? null,
            });
          }
          if (
            payload.inserted.length > 0 &&
            payload.inserted.every(i => i.meetsMasterFloor === false)
          ) {
            log.info('library insert ignored — below master floor');
            return;
          }
        }
        this.sync().catch(err =>
          log.expected(
            'sync after library change failed',
            err,
            ErrorCode.StorageIndexUnreadable,
          ),
        );
      },
    );
    // stop→start rebases PHFetchResult so inserts after a kill are not missed.
    await GlassesMediaLibraryNative.stopWatching().catch(() => undefined);
    await GlassesMediaLibraryNative.startWatching();
  }

  private onAppState(state: string): void {
    if (state === 'background' || state === 'inactive') {
      if (this.nudgeInFlight && this.listening) {
        emitTelemetry('MIC_SUSPEND', {
          runId: this.nudgeInFlight.runId,
          reason: 'url_scheme_bounce',
        });
      }
      return;
    }
    if (state === 'active' && this.nudgeInFlight) {
      const { runId } = this.nudgeInFlight;
      this.nudgeInFlight = null;
      emitTelemetry('MIC_RESUME', {
        runId,
        listening: this.listening,
      });
      // URL bounce can kill Speech recognition; resume if we still own the mic.
      if (!this.listening) {
        this.resumeListening().catch(err =>
          log.expected(
            'mic resume after nudge bounce failed',
            err,
            ErrorCode.WakeWordStartFailed,
          ),
        );
      }
    }
  }

  async stop(): Promise<void> {
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
    this.appStateSub?.remove();
    this.appStateSub = null;
    this.nudgeInFlight = null;
    this.subscription?.remove();
    this.subscription = null;
    await this.stopListening();
    await GlassesMediaLibraryNative.stopWatching().catch(err =>
      log.expected('stopWatching failed', err, ErrorCode.StorageIndexUnreadable),
    );
    this.started = false;
  }

  /** UI: pending marker count changes (wake heard / clip imported). */
  subscribeMarkers(listener: (pending: number) => void): () => void {
    this.markerListeners.add(listener);
    this.markerStore
      .all()
      .then(m => listener(m.length))
      .catch(() => listener(0));
    return () => {
      this.markerListeners.delete(listener);
    };
  }

  private async emitPendingMarkers(): Promise<void> {
    if (this.markerListeners.size === 0) {
      return;
    }
    const pending = (await this.markerStore.all()).length;
    this.markerListeners.forEach(l => l(pending));
  }
  /**
   * Close the microphone but stay watching the library.
   *
   * For the moment the live-capture path arms: one process, one audio session,
   * and two engines tapping the input is a fight neither half wins (see
   * `core/microphone.ts`). Only the listening half stands down. The library
   * observer, the pending markers and every import pass carry on, because the
   * recordings this matches against arrive long after the moment they contain —
   * standing down the whole controller would strand the markers already written
   * for footage that has not synced yet.
   */
  async suspendListening(): Promise<void> {
    if (!this.started || !this.listening) {
      return;
    }
    await this.stopListening();
    log.info('listening suspended - still watching the library');
  }

  /** Reopen the microphone after the live-capture path releases it. */
  async resumeListening(): Promise<void> {
    if (!this.started || this.listening) {
      return;
    }
    await this.startListening();
    log.info('listening resumed');
  }

  /** True while a microphone is held for the trigger word. */
  get isListening(): boolean {
    return this.listening;
  }

  private async startListening(): Promise<void> {
    await this.wakeWord.start(detection => {
      // Without a wall-clock stamp there is nothing to match against later.
      // That means the provider is not the self-listening one, which is a
      // wiring mistake rather than a runtime condition.
      if (detection?.atMs === undefined) {
        log.expected(
          'trigger heard with no wall-clock time — is the wake word owning a microphone?',
          new Error('detection without atMs'),
          ErrorCode.WakeWordTranscribeFailed,
        );
        return;
      }
      const markerId = `mark_${detection.atMs}_${Math.random().toString(36).slice(2, 8)}`;
      emitTelemetry('T_MARK', {
        runId: markerId,
        markerId,
        variant: 'control', // flipped to nudge inside maybeNudgeMetaView when armed
        atMs: detection.atMs,
      });
      // Never awaited: the wake-word callback must return promptly so the next
      // segment can be transcribed.
      this.markerStore
        .add({
          id: markerId,
          atMs: detection.atMs,
          segmentPath: detection.segmentPath,
        })
        .then(() => this.emitPendingMarkers())
        .catch(err =>
          log.error('could not record marker', err, ErrorCode.StorageWriteFailed),
        );
      // Shadow Proxy: library card now, master video later.
      this.createShadowClip(markerId, detection.atMs).catch(err =>
        log.expected('shadow clip failed', err, ErrorCode.StorageWriteFailed),
      );
      // Optional Meta View wake (experiment) — does not claim to force sync.
      this.maybeNudgeMetaView(markerId).catch(() => undefined);
      // Don't wait for Meta — keep scanning so the cut lands ASAP after sync.
      this.sync().catch(err =>
        log.expected('sync after marker failed', err, ErrorCode.StorageIndexUnreadable),
      );
    });
    this.listening = true;
  }

  private async maybeNudgeMetaView(markerId: string): Promise<void> {
    const { metaViewNudgeAfterMark } = await settingsStore.get();
    if (!metaViewNudgeAfterMark) {
      return;
    }
    this.nudgeInFlight = { runId: markerId, atMs: Date.now() };
    emitTelemetry('T_NUDGE', {
      runId: markerId,
      markerId,
      variant: 'nudge',
    });
    log.info('meta view nudge after mark (experiment)', { markerId });
    await MetaViewNudge.openCompanion();
  }

  /**
   * Instant UI feedback: a library card in MARKED_PENDING with an optional
   * live-stream still. Never a deliverable video (Quality non-negotiable).
   *
   * Cold starts must not invent a second card for the same marker — if a
   * shadow already exists for `markerId`, leave it alone.
   */
  private async createShadowClip(markerId: string, atMs: number): Promise<void> {
    const existing = (await clipStore.list()).find(
      c => c.sourceKind === 'shadow' && c.markerId === markerId,
    );
    if (existing) {
      log.info('shadow clip already exists — skip duplicate', {
        id: existing.id,
        markerId,
      });
      return;
    }
    const id = newClipId(atMs);
    const dir = await clipStore.ensureDir();
    const thumbPath = `${dir}/${id}.shadow.jpg`;
    const thumbnailPath = await writeShadowThumbnail(thumbPath);
    const clip = newClip({
      id,
      capturedAt: atMs,
      filePath: '',
      thumbnailPath,
      // Expected look-back length until the master cut replaces it.
      durationSec: this.options.lookbackSec,
      sourceKind: 'shadow',
      ingestState: 'MARKED_PENDING',
      markerId,
      isPro: await entitlementStore.isPro(),
    });
    await clipStore.add(clip);
    log.info('shadow clip marked pending', { id, markerId });
  }

  /**
   * Cards stuck in MARKED_PENDING past the Meta sync budget: rebaseline the
   * Photos observer and keep scanning. Does not delete the card — the master
   * may still arrive; UI stays honest about "waiting".
   */
  private async recoverStuckPending(): Promise<void> {
    const now = Date.now();
    const stuck = (await clipStore.list()).filter(
      c =>
        c.sourceKind === 'shadow' &&
        (c.ingestState === 'MARKED_PENDING' || !c.ingestState) &&
        now - c.capturedAt >= MARKED_PENDING_TIMEOUT_MS,
    );
    if (stuck.length === 0) {
      return;
    }
    let needsRebaseline = false;
    for (const clip of stuck) {
      const key = clip.markerId ?? clip.id;
      if (!this.pendingTimeoutEmitted.has(key)) {
        this.pendingTimeoutEmitted.add(key);
        needsRebaseline = true;
        emitTelemetry('SHADOW_TIMEOUT', {
          runId: key,
          clipId: clip.id,
          markerId: clip.markerId ?? null,
          ageMs: now - clip.capturedAt,
        });
        log.warn('shadow pending past Meta sync budget — recovering observer', {
          clipId: clip.id,
          ageMin: Math.round((now - clip.capturedAt) / 60_000),
        });
      }
    }
    if (!needsRebaseline) {
      return;
    }
    // Rebaseline fetch so a silent Meta insert is not invisible forever.
    await GlassesMediaLibraryNative.stopWatching().catch(() => undefined);
    await GlassesMediaLibraryNative.startWatching().catch(err =>
      log.expected('recovery startWatching failed', err, ErrorCode.StorageIndexUnreadable),
    );
  }

  /**
   * Marked closed whether or not the stop succeeded.
   *
   * A wake word that would not stop is not one we can treat as still ours: the
   * next `resumeListening` has to be free to start it again, and a `listening`
   * flag left true would make the resume a no-op and leave the trigger dead for
   * the rest of the session.
   */
  private async stopListening(): Promise<void> {
    this.listening = false;
    await this.wakeWord.stop().catch(err =>
      log.expected('wake word did not stop cleanly', err, ErrorCode.WakeWordStopFailed),
    );
  }

  /**
   * One import pass: match pending markers against the library, clip what fits.
   *
   * Safe to call repeatedly — after a library change, on foreground, or on a
   * timer. Consumed markers are forgotten, which is also what stops a video
   * being imported twice: with its markers gone it no longer matches anything.
   */
  async sync(): Promise<Clip[]> {
    if (this.syncing) {
      return [];
    }
    this.syncing = true;
    try {
      await this.recoverStuckPending();
      return await this.runSync();
    } finally {
      this.syncing = false;
    }
  }

  private async runSync(): Promise<Clip[]> {
    const markers = await this.markerStore.all();
    if (markers.length === 0) {
      return [];
    }

    // Nothing before the oldest pending marker can possibly be wanted.
    const earliest = Math.min(...markers.map(m => m.atMs));
    const { videos } = await GlassesMediaLibraryNative.listRecentVideos(
      earliest,
      SCAN_LIMIT,
    );

    // The filter that matters. Everything past this point has a marker
    // pointing into it; everything else is left completely alone.
    const candidates = videos.filter(
      video => markersWithin(markers, video).length > 0,
    );
    log.info('import pass', {
      pendingMarkers: markers.length,
      recentVideos: videos.length,
      candidates: candidates.length,
    });
    if (candidates.length === 0) {
      return [];
    }

    const imported: Clip[] = [];
    for (const candidate of candidates) {
      try {
        const clips = await this.importVideo(candidate.localIdentifier, markers);
        imported.push(...clips);
      } catch (err) {
        // One unreadable recording must not strand the others, and its markers
        // are deliberately kept so the next pass tries again.
        log.expected(
          `could not import ${candidate.localIdentifier}`,
          err,
          ErrorCode.CaptureStitchFailed,
        );
      }
    }
    return imported;
  }

  private async importVideo(
    localIdentifier: string,
    markers: Awaited<ReturnType<MarkerStore['all']>>,
  ): Promise<Clip[]> {
    const confirmation =
      await GlassesMediaLibraryNative.confirmGlassesVideo(localIdentifier);
    if (confirmation.pendingDownload) {
      // Still in iCloud. Markers stay pending; the next pass will find it.
      log.info('candidate is still in iCloud — leaving its markers pending', {
        localIdentifier,
      });
      return [];
    }
    if (
      !confirmation.isGlasses ||
      confirmation.startedAtMs === undefined ||
      confirmation.durationSec === undefined
    ) {
      // Someone else's video that happened to be recorded at the same time.
      return [];
    }

    const shortEdge = Math.min(confirmation.width ?? 0, confirmation.height ?? 0);
    if (shortEdge > 0 && shortEdge < MIN_MASTER_SHORT_EDGE_PX) {
      // Master-only product bar: never put a sub-1080 proxy/master in the library.
      log.info('skipping sub-1080 glasses video', {
        localIdentifier,
        width: confirmation.width,
        height: confirmation.height,
        minEdge: MIN_MASTER_SHORT_EDGE_PX,
      });
      return [];
    }

    // Re-matched against the container's own capture time, which is the exact
    // value the cut depends on — the library's is only approximately right.
    const video: GlassesVideo = {
      localIdentifier,
      startedAtMs: confirmation.startedAtMs,
      durationSec: confirmation.durationSec,
      width: confirmation.width ?? 0,
      height: confirmation.height ?? 0,
    };
    const cuts = clipRangesForVideo(markers, video, {
      lookbackSec: this.options.lookbackSec,
      maxWindowSec: this.options.maxWindowSec,
    });

    // Where each trigger landed inside the recording, and where that put the
    // cut. This is the only way clock skew between the two devices can ever be
    // measured: the phone stamps the wall clock and the glasses stamp theirs,
    // nothing reconciles them, and `graceBeforeSec` has been absorbing a
    // difference nobody has put a number on. Play an imported clip and see how
    // far from its end the trigger word actually falls — that gap, against
    // `offsetSec` here, is the skew.
    //
    // Markers listed with no cut are the silent case worth seeing: a trigger
    // inside the grace window but before the recording began points at footage
    // that does not exist, so it is dropped, and until now it was dropped
    // without a trace.
    const matched = markersWithin(markers, video);
    const cutMarkerIds = new Set(cuts.flatMap(cut => cut.markers.map(m => m.id)));
    log.info('marker alignment', {
      localIdentifier,
      videoDurationSec: Number(video.durationSec.toFixed(2)),
      markers: matched.map(marker => ({
        id: marker.id,
        offsetSec: Number(markerOffsetSec(marker, video).toFixed(2)),
        cut: cutMarkerIds.has(marker.id),
      })),
      cuts: cuts.map(cut => ({
        startSec: Number(cut.range.startSec.toFixed(2)),
        endSec: Number(cut.range.endSec.toFixed(2)),
        markers: cut.markers.length,
      })),
    });

    if (cuts.length === 0) {
      // Still score U1 even when nothing was cut — a native recording that
      // overlapped the stream is evidence regardless of markers.
      await this.scoreConcurrency(
        localIdentifier,
        confirmation.startedAtMs,
        confirmation.durationSec,
      );
      return [];
    }

    // Copied once and cut many times: the original is tens of megabytes, and
    // the export is the slow part of the whole pass.
    const original = await GlassesMediaLibraryNative.exportOriginal(localIdentifier);
    log.info('imported original', {
      localIdentifier,
      bytes: original.bytes,
      resolution: `${video.width}x${video.height}`,
      cuts: cuts.length,
    });

    // One timeline read per native recording — not per cut.
    const verdict = await this.scoreConcurrency(
      localIdentifier,
      confirmation.startedAtMs,
      confirmation.durationSec,
    );
    const window = {
      startedAtMs: confirmation.startedAtMs,
      durationSec: confirmation.durationSec,
    };

    const clips: Clip[] = [];
    const consumed: string[] = [];
    try {
      // Mark overlapping shadows as ingesting so the library shows progress.
      const shadows = (await clipStore.list()).filter(
        c =>
          c.sourceKind === 'shadow' &&
          (c.ingestState === 'MARKED_PENDING' || !c.ingestState),
      );
      for (const s of shadows) {
        await clipStore.setIngestState(s.id, 'INGESTING');
      }

      for (const cut of cuts) {
        const master = await this.cutClip(original.path, cut.range, video);
        const markerIds = cut.markers.map(marker => marker.id);
        consumed.push(...markerIds);

        // Promote Shadow Proxy card(s) for these markers — same id in the UI.
        let delivered: Clip = master;
        let swapped = false;
        const library = await clipStore.list();
        const shadow =
          library.find(
            c =>
              c.sourceKind === 'shadow' &&
              c.markerId &&
              markerIds.includes(c.markerId),
          ) ?? findProxySwapCandidates(library, window)[0];

        if (shadow) {
          const next = await clipStore.replaceProxyWithMaster(shadow.id, {
            filePath: master.filePath,
            thumbnailPath: master.thumbnailPath || shadow.thumbnailPath,
            durationSec: master.durationSec,
          });
          if (next) {
            swapped = true;
            delivered = next;
            const runId = shadow.markerId ?? shadow.id;
            if (this.pendingTimeoutEmitted.has(runId)) {
              emitTelemetry('SHADOW_RECOVERED', {
                runId,
                clipId: shadow.id,
                markerId: shadow.markerId ?? null,
              });
              this.pendingTimeoutEmitted.delete(runId);
            }
            emitTelemetry('T_MASTER_READY', {
              runId,
              clipId: shadow.id,
              markerId: shadow.markerId ?? null,
              resolution: `${video.width}x${video.height}`,
            });
            log.info('shadow/master promoted', {
              clipId: shadow.id,
              markerId: shadow.markerId,
              outcome: verdict?.outcome,
            });
          }
        }

        if (!swapped) {
          const withState = { ...master, ingestState: 'MASTER_READY' as const };
          await clipStore.add(withState);
          delivered = withState;
          emitTelemetry('T_MASTER_READY', {
            runId: markerIds[0] ?? withState.id,
            clipId: withState.id,
            resolution: `${video.width}x${video.height}`,
          });
        }
        clips.push(delivered);
        try {
          this.options.onClipImported?.(delivered);
        } catch (err) {
          // Captioning is best-effort; the clip is already in the library.
          log.error('post-import hook failed', err, ErrorCode.CaptionJobFailed);
        }
      }
    } finally {
      // The original is a copy of something the library still holds, so
      // keeping it around would double the storage for no benefit.
      await RNFS.unlink(original.path).catch(() => undefined);
      await this.markerStore.remove(consumed);
      await this.emitPendingMarkers();
    }
    return clips;
  }

  /**
   * Score what the live stream was doing while this native recording ran.
   *
   * MWDAT has no API to *start* a glasses-side capture, so U1 is answered
   * backwards: when a Photos master arrives, read the in-memory stream
   * timeline for that wall-clock window.
   */
  private async scoreConcurrency(
    localIdentifier: string,
    startedAtMs: number,
    durationSec: number,
  ): Promise<ReturnType<typeof concurrencyVerdict> | null> {
    try {
      const entries = await MWDATNative.getStreamTimeline();
      const verdict = concurrencyVerdict(entries, { startedAtMs, durationSec });
      log.info(`concurrency probe — ${verdict.summary}`, {
        localIdentifier,
        outcome: verdict.outcome,
        minFps: verdict.minFps,
        stalls: verdict.stalls,
        errors: verdict.errors,
        stsdLike: verdict.stsdLike,
        hybridSwapAllowed: hybridSwapAllowed(verdict.outcome),
      });
      return verdict;
    } catch (err) {
      log.expected('concurrency probe failed', err, ErrorCode.StorageIndexUnreadable);
      return null;
    }
  }

  private async cutClip(
    sourcePath: string,
    range: { startSec: number; endSec: number },
    video: GlassesVideo,
  ): Promise<Clip> {
    // Timestamped by when the moment happened, not when the import ran —
    // otherwise a day's worth of clips all land in the library at once,
    // labelled with the moment they were processed.
    const capturedAt = video.startedAtMs + range.endSec * 1000;
    const id = newClipId(capturedAt);
    const dir = await clipStore.ensureDir();
    const result = await extractRange(
      sourcePath,
      range.startSec,
      range.endSec,
      `${dir}/${id}.mp4`,
    );

    return newClip({
      id,
      capturedAt,
      filePath: result.outputPath,
      thumbnailPath: result.thumbnailPath,
      durationSec: result.durationSec,
      sourceKind: 'glasses-library',
      ingestState: 'MASTER_READY',
      isPro: await entitlementStore.isPro(),
    });
  }
}
