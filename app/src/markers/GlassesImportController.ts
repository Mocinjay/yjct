import { NativeEventEmitter, NativeModules } from 'react-native';
import RNFS from 'react-native-fs';
import { FREE_RETENTION_HOURS } from '../config';
import { clipStore } from '../core/ClipStore';
import { defaultClipName } from '../core/CaptureController';
import { entitlementStore } from '../core/EntitlementStore';
import { createLogger } from '../core/Logger';
import { AppError, ErrorCode } from '../core/errors';
import { extractRange } from '../native/ClipStitcher';
import {
  GLASSES_LIBRARY_CHANGED_EVENT,
  GlassesMediaLibraryNative,
} from '../native/GlassesMediaLibraryNative';
import { MWDATNative } from '../native/MWDATNative';
import type { Clip } from '../types';
import type { WakeWordProvider } from '../wakeword/WakeWordProvider';
import type { MarkerStore } from './MarkerStore';
import type { GlassesVideo } from './markerMatching';
import { clipRangesForVideo, markersWithin } from './markerMatching';
import { concurrencyVerdict } from './streamConcurrency';

const log = createLogger('glasses-import');

/** How many recent videos to consider per pass. */
const SCAN_LIMIT = 200;

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
   * Begin listening and watching.
   *
   * Photo access is requested up front rather than at the first sync: a wearer
   * who says the trigger word all afternoon and only then discovers the app
   * cannot read the library has lost the whole afternoon.
   */
  async start(): Promise<void> {
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
      // Never awaited: the wake-word callback must return promptly so the next
      // segment can be transcribed.
      this.markerStore
        .add({
          id: `mark_${detection.atMs}_${Math.random().toString(36).slice(2, 8)}`,
          atMs: detection.atMs,
          segmentPath: detection.segmentPath,
        })
        .catch(err =>
          log.error('could not record marker', err, ErrorCode.StorageWriteFailed),
        );
    });

    const emitter = new NativeEventEmitter(NativeModules.GlassesMediaLibrary);
    this.subscription = emitter.addListener(GLASSES_LIBRARY_CHANGED_EVENT, () => {
      this.sync().catch(err =>
        log.expected('sync after library change failed', err, ErrorCode.StorageIndexUnreadable),
      );
    });
    await GlassesMediaLibraryNative.startWatching();

    this.started = true;
    log.info('listening for the trigger word and watching the library');
  }

  async stop(): Promise<void> {
    this.subscription?.remove();
    this.subscription = null;
    await this.wakeWord.stop().catch(err =>
      log.expected('wake word did not stop cleanly', err, ErrorCode.WakeWordStopFailed),
    );
    await GlassesMediaLibraryNative.stopWatching().catch(err =>
      log.expected('stopWatching failed', err, ErrorCode.StorageIndexUnreadable),
    );
    this.started = false;
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

    await this.probeConcurrency(
      localIdentifier,
      confirmation.startedAtMs,
      confirmation.durationSec,
    );

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
    if (cuts.length === 0) {
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

    const clips: Clip[] = [];
    const consumed: string[] = [];
    try {
      for (const cut of cuts) {
        const clip = await this.cutClip(original.path, cut.range, video);
        await clipStore.add(clip);
        clips.push(clip);
        consumed.push(...cut.markers.map(marker => marker.id));
        try {
          this.options.onClipImported?.(clip);
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
    }
    return clips;
  }

  /**
   * TEMPORARY: record what the live stream was doing while this was recorded.
   *
   * The glasses never tell the phone that a native recording started, so the
   * question can only be answered backwards — the file turns up later carrying
   * its own capture time, and the link telemetry from that window is the only
   * evidence of whether Path A was alive at the same moment. Purely
   * observational; it cannot fail an import.
   */
  private async probeConcurrency(
    localIdentifier: string,
    startedAtMs: number,
    durationSec: number,
  ): Promise<void> {
    try {
      const entries = await MWDATNative.getStreamTimeline();
      const verdict = concurrencyVerdict(entries, { startedAtMs, durationSec });
      log.info(`concurrency probe — ${verdict.summary}`, {
        localIdentifier,
        outcome: verdict.outcome,
        minFps: verdict.minFps,
        stalls: verdict.stalls,
        errors: verdict.errors,
      });
    } catch (err) {
      log.expected('concurrency probe failed', err, ErrorCode.StorageIndexUnreadable);
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
    const id = `clip_${capturedAt}_${Math.random().toString(36).slice(2, 8)}`;
    const dir = await clipStore.ensureDir();
    const result = await extractRange(
      sourcePath,
      range.startSec,
      range.endSec,
      `${dir}/${id}.mp4`,
    );

    const isPro = await entitlementStore.isPro();
    return {
      id,
      name: defaultClipName(capturedAt),
      filePath: result.outputPath,
      thumbnailPath: result.thumbnailPath,
      capturedAt,
      durationSec: result.durationSec,
      sourceKind: 'glasses-library',
      savedAt: isPro ? capturedAt : null,
      expiresAt: isPro ? null : capturedAt + FREE_RETENTION_HOURS * 3600_000,
    };
  }
}
