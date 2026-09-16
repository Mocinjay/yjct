import { NativeEventEmitter, NativeModules } from 'react-native';
import RNFS from 'react-native-fs';
import { clipStore, newClip, newClipId } from '../core/ClipStore';
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
import { clipRangesForVideo, markerOffsetSec, markersWithin } from './markerMatching';
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
  /** True while the wake word holds a microphone. False while stood down. */
  private listening = false;

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

    const emitter = new NativeEventEmitter(NativeModules.GlassesMediaLibrary);
    this.subscription = emitter.addListener(GLASSES_LIBRARY_CHANGED_EVENT, () => {
      this.sync().catch(err =>
        log.expected('sync after library change failed', err, ErrorCode.StorageIndexUnreadable),
      );
    });
    await GlassesMediaLibraryNative.startWatching();

    this.started = true;
    log.info(
      this.listening
        ? 'listening for the trigger word and watching the library'
        : 'watching the library; the microphone is held elsewhere',
    );
  }

  async stop(): Promise<void> {
    this.subscription?.remove();
    this.subscription = null;
    await this.stopListening();
    await GlassesMediaLibraryNative.stopWatching().catch(err =>
      log.expected('stopWatching failed', err, ErrorCode.StorageIndexUnreadable),
    );
    this.started = false;
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
    this.listening = true;
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
      isPro: await entitlementStore.isPro(),
    });
  }
}
