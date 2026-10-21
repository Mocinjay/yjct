import { NativeEventEmitter, NativeModules } from 'react-native';
import RNFS from 'react-native-fs';
import { FREE_RETENTION_HOURS } from '../config';
import { clipStore, defaultClipName, newClipId } from '../core/ClipStore';
import { entitlementStore } from '../core/EntitlementStore';
import { extractRange } from '../native/ClipStitcher';
import {
  GLASSES_LIBRARY_CHANGED_EVENT,
  GlassesMediaLibraryNative,
} from '../native/GlassesMediaLibraryNative';
import { MWDATNative } from '../native/MWDATNative';
import type { Clip } from '../types';
import { errorText, importLog } from './importLog';
import type { MarkerStore } from './MarkerStore';
import type { Cut, GlassesVideo, WakeMarker } from './markerMatching';
import {
  clipRangesForVideo,
  coversProxyWindow,
  markersWithin,
  offsetSec,
} from './markerMatching';
import { concurrencyVerdict } from './streamConcurrency';

/** How many recent videos to consider per pass. */
const SCAN_LIMIT = 200;

export interface ImportOptions {
  /** Seconds of footage to keep before a marker that carries no window. */
  lookbackSec: number;
  /** Longest clip to cut from merged default windows. */
  maxWindowSec?: number;
  /** See MASTER_COVERAGE_TOLERANCE_SECONDS. */
  coverageToleranceSec: number;
  /**
   * Called for every clip that gained full-resolution footage, new or
   * upgraded in place: the hook for captioning.
   */
  onClipReady?: (clip: Clip) => void;
}

/**
 * Cuts the marked moments out of recordings the glasses made on their own.
 *
 * The two halves never meet in real time. During capture, every trigger
 * writes a marker: the wall-clock span of the moment, and in live mode the id
 * of the 720p clip cut for it. The glasses record to their own storage,
 * knowing nothing about any of it. Once Meta AI syncs a recording into the
 * photo library, a pass here lines the two up, cuts each marked span out of
 * the original without re-encoding, and either upgrades the matching 720p
 * clip in place or adds a new clip.
 *
 * Markers are consulted first, against what Photos reports without opening
 * anything, so a recording nobody marked is never opened, copied or altered.
 */
export class GlassesImportController {
  private subscription: { remove: () => void } | null = null;
  private syncing: Promise<Clip[]> | null = null;
  private rerun = false;

  constructor(
    private readonly markerStore: MarkerStore,
    private readonly options: ImportOptions,
  ) {}

  /** Starts watching the library; each change triggers a pass. */
  async start(): Promise<void> {
    if (this.subscription) {
      return;
    }
    const emitter = new NativeEventEmitter(NativeModules.GlassesMediaLibrary);
    this.subscription = emitter.addListener(GLASSES_LIBRARY_CHANGED_EVENT, () => {
      this.sync().catch(err => importLog('pass after a library change failed', { error: errorText(err) }));
    });
    await GlassesMediaLibraryNative.startWatching();
  }

  async stop(): Promise<void> {
    this.subscription?.remove();
    this.subscription = null;
    await GlassesMediaLibraryNative.stopWatching().catch(() => {});
  }

  /**
   * One import pass. Safe to call at any time: a call that lands while a pass
   * runs is answered by one more pass afterwards, so a recording that synced
   * mid-pass is not missed. Consumed markers are forgotten, which is also what
   * stops a recording being cut twice.
   */
  sync(): Promise<Clip[]> {
    if (this.syncing) {
      this.rerun = true;
      return this.syncing;
    }
    const pass = (async () => {
      const imported: Clip[] = [];
      try {
        do {
          this.rerun = false;
          imported.push(...(await this.runSync()));
        } while (this.rerun);
      } finally {
        this.syncing = null;
      }
      return imported;
    })();
    this.syncing = pass;
    return pass;
  }

  private async runSync(): Promise<Clip[]> {
    const markers = await this.markerStore.all();
    if (markers.length === 0) {
      return [];
    }
    // Nothing older than the oldest pending marker's span can be wanted.
    const earliest = Math.min(...markers.map(m => m.startMs ?? m.atMs));
    const { videos } = await GlassesMediaLibraryNative.listRecentVideos(earliest, SCAN_LIMIT);
    const candidates = videos.filter(video => markersWithin(markers, video).length > 0);
    importLog('import pass', {
      pendingMarkers: markers.length,
      recentVideos: videos.length,
      candidates: candidates.length,
    });

    const imported: Clip[] = [];
    for (const candidate of candidates) {
      try {
        imported.push(...(await this.importVideo(candidate.localIdentifier, markers)));
      } catch (err) {
        // One unreadable recording must not strand the others. Its unconsumed
        // markers stay, so the next pass tries again.
        importLog('could not import', {
          localIdentifier: candidate.localIdentifier,
          error: errorText(err),
        });
      }
    }
    return imported;
  }

  private async importVideo(localIdentifier: string, markers: WakeMarker[]): Promise<Clip[]> {
    const confirmation = await GlassesMediaLibraryNative.confirmGlassesVideo(localIdentifier);
    if (confirmation.pendingDownload) {
      importLog('candidate is still in iCloud; its markers stay pending', { localIdentifier });
      return [];
    }
    if (
      !confirmation.isGlasses ||
      confirmation.startedAtMs === undefined ||
      confirmation.durationSec === undefined
    ) {
      // Someone else's video recorded at the same time.
      return [];
    }

    await this.probeConcurrency(
      localIdentifier,
      confirmation.startedAtMs,
      confirmation.durationSec,
    );

    // Matched again against the container's own capture time, the exact value
    // the cut depends on; the library's is only approximately right.
    const video: GlassesVideo = {
      localIdentifier,
      startedAtMs: confirmation.startedAtMs,
      durationSec: confirmation.durationSec,
      width: confirmation.width ?? 0,
      height: confirmation.height ?? 0,
    };
    const cuts = clipRangesForVideo(markers, video, this.options);

    // Where each marker landed in the recording. Playing a cut and seeing how
    // far the trigger word falls from its end, against `endOffsetSec` here,
    // measures the clock skew between the phone and the glasses.
    const cutMarkerIds = new Set(cuts.flatMap(cut => cut.markers.map(m => m.id)));
    importLog('marker alignment', {
      localIdentifier,
      videoDurationSec: round2(video.durationSec),
      markers: markersWithin(markers, video).map(marker => ({
        id: marker.id,
        endOffsetSec: round2(offsetSec(marker.atMs, video)),
        proxyClipId: marker.proxyClipId,
        cut: cutMarkerIds.has(marker.id),
      })),
      cuts: cuts.map(cut => ({
        startSec: round2(cut.range.startSec),
        endSec: round2(cut.range.endSec),
        markers: cut.markers.length,
        replaces: cut.proxyClipId,
      })),
    });
    if (cuts.length === 0) {
      return [];
    }

    // Copied once and cut many times: the original is tens of megabytes, and
    // the copy is the slow part of a pass.
    const original = await GlassesMediaLibraryNative.exportOriginal(localIdentifier);
    importLog('copied original', {
      localIdentifier,
      bytes: original.bytes,
      resolution: `${video.width}x${video.height}`,
      cuts: cuts.length,
    });

    const clips: Clip[] = [];
    const consumed: string[] = [];
    try {
      for (const cut of cuts) {
        let clip: Clip;
        try {
          clip = await this.landCut(original.path, cut, video);
        } catch (err) {
          // Its markers stay for the next pass; the other cuts go ahead.
          importLog('cut failed', {
            localIdentifier,
            startSec: round2(cut.range.startSec),
            endSec: round2(cut.range.endSec),
            error: errorText(err),
          });
          continue;
        }
        clips.push(clip);
        consumed.push(...cut.markers.map(marker => marker.id));
        try {
          this.options.onClipReady?.(clip);
        } catch (err) {
          // Captioning is best-effort; the clip is already in the library.
          importLog('post-import hook failed', { error: errorText(err) });
        }
      }
    } finally {
      await RNFS.unlink(original.path).catch(() => {});
      await this.markerStore.remove(consumed);
    }
    return clips;
  }

  /**
   * Cuts one span and puts it in the library: in place of the 720p clip cut
   * for the same moment when it covers that clip's span, as a new clip
   * otherwise (no 720p clip, the 720p clip is gone, or the glasses started
   * recording too late to cover it).
   */
  private async landCut(sourcePath: string, cut: Cut, video: GlassesVideo): Promise<Clip> {
    const capturedAt = Math.round(video.startedAtMs + cut.range.endSec * 1000);
    const id = newClipId(capturedAt);
    const dir = await clipStore.ensureDir();
    const result = await extractRange(
      sourcePath,
      cut.range.startSec,
      cut.range.endSec,
      `${dir}/${id}.mp4`,
    );

    const proxyId = cut.proxyClipId;
    const covers = coversProxyWindow(cut, video, this.options.coverageToleranceSec);
    if (proxyId !== undefined && covers) {
      const master = {
        filePath: result.outputPath,
        thumbnailPath: result.thumbnailPath,
        durationSec: result.durationSec,
      };
      if (await clipStore.replaceWithMaster(proxyId, master)) {
        importLog('upgraded clip to full resolution', {
          clipId: proxyId,
          durationSec: round2(result.durationSec),
        });
        const upgraded = (await clipStore.list()).find(c => c.id === proxyId);
        if (upgraded) {
          return upgraded;
        }
      }
    }

    // Named apart only when it lands beside the 720p clip it could not replace.
    const besideProxy =
      proxyId !== undefined && (await clipStore.list()).some(c => c.id === proxyId);
    const isPro = await entitlementStore.isPro();
    const now = Date.now();
    const clip: Clip = {
      id,
      name: besideProxy
        ? `${defaultClipName(capturedAt)} · full res`
        : defaultClipName(capturedAt),
      filePath: result.outputPath,
      thumbnailPath: result.thumbnailPath,
      capturedAt,
      durationSec: result.durationSec,
      sourceKind: 'glasses-library',
      quality: 'master',
      savedAt: isPro ? now : null,
      // The clock starts when the clip lands, not at the moment it shows:
      // a recording that synced a day late must not arrive already expired.
      expiresAt: isPro ? null : now + FREE_RETENTION_HOURS * 3600_000,
      captionState: 'none',
    };
    await clipStore.add(clip);
    importLog('added full-resolution clip', {
      clipId: id,
      reason:
        proxyId === undefined
          ? 'no 720p clip for this moment'
          : besideProxy
            ? 'the recording does not cover the whole 720p clip'
            : 'the 720p clip was gone',
    });
    return clip;
  }

  /**
   * Records what the live stream did while this was recorded. The glasses
   * never tell the phone that a native recording began, so whether live mode
   * can run alongside one is answered here, after the fact. Observational
   * only; it cannot fail an import.
   */
  private async probeConcurrency(
    localIdentifier: string,
    startedAtMs: number,
    durationSec: number,
  ): Promise<void> {
    try {
      const { entries } = await MWDATNative.getStreamTimeline();
      const verdict = concurrencyVerdict(entries, { startedAtMs, durationSec });
      importLog(`concurrency probe — ${verdict.summary}`, {
        localIdentifier,
        outcome: verdict.outcome,
      });
    } catch (err) {
      importLog('concurrency probe unavailable', { error: errorText(err) });
    }
  }
}

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}
