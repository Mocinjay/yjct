import RNFS from 'react-native-fs';
import {
  FREE_RETENTION_HOURS,
  MAX_CLIP_RECORDING_SECONDS,
  WAKE_TRIM_PADDING_SECONDS,
} from '../config';
import type { DeviceVideoSource } from '../device/DeviceVideoSource';
import { stitchSegments } from '../native/ClipStitcher';
import type { Clip, Segment } from '../types';
import type { WakeDetection, WakeWordProvider } from '../wakeword/WakeWordProvider';
import { clipStore } from './ClipStore';
import { entitlementStore } from './EntitlementStore';
import { SegmentRingBuffer } from './SegmentRingBuffer';

export type CaptureState =
  | 'idle'
  | 'arming'
  | 'armed'
  | 'recording'
  | 'saving'
  | 'error';

export interface CaptureStatus {
  state: CaptureState;
  /**
   * Seconds of look-back the buffer held when `bufferedAsOf` was stamped.
   *
   * This only moves when a segment finishes — every SEGMENT_SECONDS — and it
   * does not count the segment currently being written. Read on its own it is
   * therefore always behind, by up to a whole segment. Extrapolate from
   * `bufferedAsOf` to show the wearer what is really in the window.
   */
  bufferedSeconds: number;
  /** Epoch ms at which `bufferedSeconds` was measured. */
  bufferedAsOf: number;
  /** Epoch ms of the trigger, set while state === 'recording'. */
  recordingSince?: number;
  /**
   * Epoch ms of the last successful `arm()`: the session clock shown as LIVE
   * m:ss. Not capped at the look-back window, because the window bounds what a
   * trigger saves, not how long capture has been running.
   */
  armedSince?: number;
  lastError?: string;
  lastClip?: Clip;
  /**
   * How many clips have been saved since this armed session started, so the
   * wearer can hear "Clipso" land and see *which* one it was — "Save #3" —
   * without opening the library. Resets on every `arm()`.
   */
  sessionClipCount?: number;
}

/**
 * True from the start of arming until disarm — while the glasses may be
 * recording. `armedSince` is the marker rather than the state alone: a stream
 * error mid-session puts the state in 'error' while the glasses keep
 * recording, and a failed arm ends in 'error' with nothing recording at all.
 * Only the first has `armedSince` set.
 */
export function isCaptureLive(status: CaptureStatus): boolean {
  return status.state === 'arming' || status.armedSince !== undefined;
}

/**
 * The core loop:
 *
 *   armed      — rolling buffer keeps the last N seconds, evicting old files
 *   "clipso"   — the wake word AUTO-SAVES the look-back window as a clip
 *   extended   — the manual REC button instead pins the window and keeps
 *                recording until stopped (stop button / wake phrase /
 *                safety cap): [start − N seconds … stop]
 */
export class CaptureController {
  private buffer: SegmentRingBuffer;
  private status: CaptureStatus = {
    state: 'idle',
    bufferedSeconds: 0,
    bufferedAsOf: Date.now(),
  };
  private listeners = new Set<(s: CaptureStatus) => void>();
  private saving = false;
  private sessionClipCount = 0;
  private armedSince: number | null = null;
  private maxRecordingTimer: ReturnType<typeof setTimeout> | null = null;
  /**
   * Bumped by every arm() and disarm(). An arm that finds it changed after an
   * await has been superseded and must not touch the state (e.g. a stale arm
   * failing late must not disarm a newer arm that succeeded).
   */
  private armGeneration = 0;
  /**
   * `onClipSaved` fires once a clip is in the library. Post-capture work
   * (auto-captioning) hangs off this rather than being called from here, so
   * the capture loop keeps no dependency on Phase 2 — see services/capture.ts.
   */
  constructor(
    private source: DeviceVideoSource,
    private wakeWord: WakeWordProvider,
    private windowSeconds: number,
    private chimeEnabled: boolean,
    private onClipSaved?: (clip: Clip) => void,
  ) {
    this.buffer = new SegmentRingBuffer(windowSeconds, seg => {
      RNFS.unlink(seg.path).catch(() => {});
    });
  }

  subscribe(listener: (s: CaptureStatus) => void): () => void {
    this.listeners.add(listener);
    listener(this.status);
    return () => this.listeners.delete(listener);
  }

  async arm(): Promise<void> {
    const generation = ++this.armGeneration;
    this.sessionClipCount = 0;
    // A feed drop mid extended recording leaves the window pinned. The re-arm
    // carries on with that recording, so the stop word or button still saves
    // it from where it began, rather than arming over a stale pin that the
    // next stop would save from.
    const resumeSince = this.buffer.isPinned
      ? this.status.recordingSince ?? Date.now()
      : undefined;
    // Kept through 'arming' so a second re-arm still knows when it began.
    this.setStatus({ state: 'arming', bufferedSeconds: 0, recordingSince: resumeSince });
    try {
      await this.source.prepare();
      if (generation !== this.armGeneration) {
        return;
      }
      await this.source.start(
        seg => this.onSegment(seg),
        err => this.setStatus({ ...this.status, state: 'error', lastError: err.message }),
      );
      if (generation !== this.armGeneration) {
        return;
      }
      await this.wakeWord.start(detection => {
        this.onWakePhrase(detection).catch(err =>
          this.setStatus({ ...this.status, state: 'error', lastError: String(err) }),
        );
      });
      if (generation !== this.armGeneration) {
        return;
      }
      this.armedSince = Date.now();
      if (resumeSince !== undefined && this.buffer.isPinned) {
        this.setStatus({ ...this.status, state: 'recording', recordingSince: resumeSince });
        // The cap may have fired while the feed was down, when it could not
        // stop anything: what is left of it runs from now.
        this.scheduleMaxRecordingTimer(
          MAX_CLIP_RECORDING_SECONDS * 1000 - (Date.now() - resumeSince),
        );
      } else {
        this.setStatus({ ...this.status, state: 'armed', recordingSince: undefined });
      }
    } catch (err) {
      if (generation !== this.armGeneration) {
        return;
      }
      await this.disarm();
      this.setStatus({ state: 'error', bufferedSeconds: 0, lastError: errorMessage(err) });
      throw err;
    }
  }

  async disarm(): Promise<void> {
    this.armGeneration += 1;
    this.clearMaxRecordingTimer();
    // An extended recording still pinned here was cut short: a feed drop whose
    // re-arm failed, or the capture screen going away mid-recording. Clearing
    // the buffer would delete it, but its segments are on disk and stitching
    // needs no stream, so it is saved as it stands. Taken before the first
    // await so nothing can flush or clear it in between.
    const interrupted =
      this.buffer.isPinned && !this.saving ? this.buffer.flushFromPin() : [];
    if (interrupted.length > 0) {
      this.saving = true;
    }
    await this.wakeWord.stop().catch(() => {});
    await this.source.stop().catch(() => {});
    this.buffer.clear();
    this.armedSince = null;
    this.setStatus({ state: 'idle', bufferedSeconds: 0 });
    if (interrupted.length > 0) {
      // Not awaited: a failed arm reports its error without waiting on a
      // stitch. The state is left alone; only the clip is reported.
      this.saveClip(interrupted)
        .then(clip =>
          this.setStatus({
            ...this.status,
            lastClip: clip,
            sessionClipCount: this.sessionClipCount,
          }),
        )
        .catch(err => this.setStatus({ ...this.status, lastError: errorMessage(err) }))
        .finally(() => {
          this.saving = false;
        });
    }
  }

  /**
   * Wake word heard: if an extended recording is running, stop & save it;
   * otherwise auto-save the look-back window as a clip right now.
   */
  async onWakePhrase(detection?: WakeDetection): Promise<void> {
    if (this.status.state === 'recording') {
      await this.stopClip();
    } else if (this.status.state === 'armed') {
      await this.captureNow(detection);
    } else if (
      detection &&
      this.armedSince !== null &&
      (this.status.state === 'error' || this.status.state === 'arming')
    ) {
      await this.saveWhileDown(detection);
    }
  }

  /**
   * A wake word heard while capture is down mid-session. The segment open when
   * the glasses' feed drops is only finished once the native side rebuilds the
   * stream — after the error has already reached here — so its "Clipso" is
   * transcribed in 'error' (or in the 'arming' of the re-arm that follows).
   *
   * The footage is already in the buffer and saving it needs no live stream,
   * so it is saved now, and the state the capture screen is recovering from is
   * left alone. It is not left to the re-arm: that fails exactly when the
   * glasses were folded or taken off, and a failed arm clears the look-back.
   */
  private async saveWhileDown(detection: WakeDetection): Promise<void> {
    if (this.saving) {
      return;
    }
    this.saving = true;
    this.chime();
    try {
      let segments: Segment[];
      let trimEndSec = 0;
      if (this.buffer.isPinned) {
        // The error interrupted an extended recording: the word was its stop.
        this.clearMaxRecordingTimer();
        segments = this.buffer.flushFromPin();
      } else {
        ({ segments, trimEndSec } = this.windowEndingAt(detection));
      }
      if (segments.length === 0) {
        return;
      }
      const clip = await this.saveClip(segments, trimEndSec);
      // Whatever the state is now — still 'error', or 'armed' again if a
      // re-arm finished meanwhile — it stays, and so does the start of an
      // extended recording begun since.
      this.setStatus({
        ...this.status,
        recordingSince:
          this.status.state === 'recording' ? this.status.recordingSince : undefined,
        lastClip: clip,
        sessionClipCount: this.sessionClipCount,
      });
    } catch (err) {
      this.setStatus({ ...this.status, lastError: errorMessage(err) });
    } finally {
      this.saving = false;
    }
  }

  /**
   * Auto-save the buffered look-back window as a clip. Capture keeps running.
   *
   * With a `detection` the clip ends on the trigger word instead of at the
   * buffer boundary: the wake segment is already on disk, so there is nothing
   * to cut and the trailing dead air (0–5s of segment plus transcription time)
   * is trimmed off the last segment. Without one — the manual button, Android,
   * or a wake segment that has already been evicted — the in-flight segment is
   * cut and the whole window saved.
   */
  async captureNow(detection?: WakeDetection): Promise<Clip | null> {
    if (this.status.state !== 'armed' || this.saving) {
      return null;
    }
    this.saving = true;
    this.chime();
    this.setStatus({ ...this.status, state: 'saving' });
    try {
      let { segments, trimEndSec } = detection
        ? this.windowEndingAt(detection)
        : { segments: [] as Segment[], trimEndSec: 0 };
      if (segments.length === 0) {
        await this.source.cut();
        segments = this.buffer.flush();
        trimEndSec = 0;
      }
      if (segments.length === 0) {
        throw new Error('Buffer is empty — nothing to clip yet.');
      }
      const clip = await this.saveClip(segments, trimEndSec);
      this.setStatus({
        ...this.stateAfterSave(),
        // Segments recorded after the wake word are kept as the next clip's
        // look-back, so the counter does not necessarily fall back to zero.
        bufferedSeconds: this.buffer.totalBufferedSeconds,
        lastClip: clip,
        sessionClipCount: this.sessionClipCount,
      });
      return clip;
    } catch (err) {
      this.setStatus({ ...this.status, ...this.stateAfterSave(err) });
      return null;
    } finally {
      this.saving = false;
    }
  }

  /**
   * Manual extended clip: pin the buffered look-back window and keep
   * recording into the clip until `stopClip()`.
   */
  startClip(): void {
    // Not while a save-while-down is still flushing the buffer it would pin.
    if (this.status.state !== 'armed' || this.saving) {
      return;
    }
    this.buffer.pin();
    this.setStatus({
      ...this.status,
      state: 'recording',
      recordingSince: Date.now(),
    });
    this.scheduleMaxRecordingTimer(MAX_CLIP_RECORDING_SECONDS * 1000);
  }

  /** Stop recording and save [trigger − window … now] as one clip. */
  async stopClip(): Promise<Clip | null> {
    if (this.status.state !== 'recording' || this.saving) {
      return null;
    }
    this.saving = true;
    this.chime();
    this.clearMaxRecordingTimer();
    this.setStatus({ ...this.status, state: 'saving' });
    try {
      await this.source.cut();
      const segments = this.buffer.flushFromPin();
      if (segments.length === 0) {
        throw new Error('Nothing recorded — buffer was empty.');
      }
      const clip = await this.saveClip(segments);
      this.setStatus({
        ...this.stateAfterSave(),
        bufferedSeconds: 0,
        lastClip: clip,
        sessionClipCount: this.sessionClipCount,
      });
      return clip;
    } catch (err) {
      this.setStatus({
        ...this.status,
        ...this.stateAfterSave(err),
        recordingSince: undefined,
      });
      return null;
    } finally {
      this.saving = false;
    }
  }

  /**
   * Where a save leaves the capture state. From 'saving' it returns to
   * 'armed', carrying the save's own failure if it had one. Anything that
   * landed during the stitch stands instead: a stream error (overwriting it
   * would show LIVE over a dead feed and cancel the screen's recovery), the
   * re-arm the screen started from it, or a disarm.
   */
  private stateAfterSave(err?: unknown): Pick<CaptureStatus, 'state' | 'lastError'> {
    const { state, lastError } = this.status;
    if (state === 'error' || state === 'arming' || state === 'idle') {
      return { state, lastError };
    }
    return { state: 'armed', lastError: err === undefined ? undefined : errorMessage(err) };
  }

  /**
   * The look-back window ending on the wake word: the segments up to the one
   * it was heard in, with the dead air after the word trimmed off. Empty when
   * that segment has already been evicted.
   */
  private windowEndingAt(detection: WakeDetection): {
    segments: Segment[];
    trimEndSec: number;
  } {
    const segments = this.buffer.flushEndingAt(detection.segmentPath);
    const last = segments[segments.length - 1];
    const trimEndSec = last
      ? Math.max(0, last.durationSec - (detection.endOffsetSec + WAKE_TRIM_PADDING_SECONDS))
      : 0;
    return { segments, trimEndSec };
  }

  /**
   * Stitches flushed segments into a clip and adds it to the library. The
   * segment files are deleted whether or not that worked: they have already
   * left the buffer, so nothing else will. (The stitched clip is kept even if
   * the index write fails: it is already in memory and the next write saves
   * it.)
   */
  private async saveClip(segments: Segment[], trimEndSec = 0): Promise<Clip> {
    try {
      const clip = await this.stitch(segments, trimEndSec);
      await clipStore.add(clip);
      this.sessionClipCount += 1;
      this.announceSaved(clip);
      return clip;
    } finally {
      await Promise.all(segments.map(s => RNFS.unlink(s.path).catch(() => {})));
    }
  }

  private async stitch(segments: Segment[], trimEndSec = 0): Promise<Clip> {
    const capturedAt = Date.now();
    const id = `clip_${capturedAt}_${Math.random().toString(36).slice(2, 8)}`;
    const dir = await clipStore.ensureDir();
    const outputPath = `${dir}/${id}.mp4`;
    const result = await stitchSegments(
      segments.map(s => s.path),
      outputPath,
      trimEndSec,
    );
    // Free clips are temporary and start counting down immediately; Pro clips
    // are kept until the wearer deletes them.
    const isPro = await entitlementStore.isPro();
    return {
      id,
      name: defaultClipName(capturedAt),
      filePath: result.outputPath,
      thumbnailPath: result.thumbnailPath,
      capturedAt,
      durationSec: result.durationSec,
      sourceKind: this.source.kind,
      savedAt: isPro ? capturedAt : null,
      expiresAt: isPro ? null : capturedAt + FREE_RETENTION_HOURS * 3600_000,
    };
  }

  /**
   * Sound the glasses so the wearer knows a trigger landed without looking at
   * the phone. Fired twice per clip: once the instant the trigger registers,
   * and again once the clip is in the library. The gap between them is a
   * transcription plus a stitch — long enough that a single tone at either end
   * leaves the wearer unsure whether anything happened.
   */
  private chime(): void {
    if (!this.chimeEnabled) {
      return;
    }
    // Never awaited: the tone is confirmation, not part of saving the clip.
    this.source.chime?.().catch(() => {});
  }

  /**
   * Second tone (the clip is on disk and in the library, not merely heard),
   * then post-capture work, which is never allowed to fail a capture that
   * already succeeded.
   */
  private announceSaved(clip: Clip): void {
    this.chime();
    try {
      this.onClipSaved?.(clip);
    } catch {
      // captioning is best-effort; the clip is already safe
    }
  }

  private onSegment(segment: Segment): void {
    this.buffer.push(segment);
    // Segment-based wake detection (built-in speech recognition) listens to
    // the audio we already recorded — fire-and-forget, never blocks.
    this.wakeWord.feedSegment?.(segment.path);
    if (this.status.state === 'armed') {
      this.setStatus({ ...this.status, bufferedSeconds: this.buffer.totalBufferedSeconds });
    }
  }

  /** The safety cap on an extended recording, replacing any earlier one. */
  private scheduleMaxRecordingTimer(delayMs: number): void {
    this.clearMaxRecordingTimer();
    this.maxRecordingTimer = setTimeout(() => {
      this.stopClip().catch(err =>
        this.setStatus({ ...this.status, state: 'error', lastError: String(err) }),
      );
    }, Math.max(0, delayMs));
  }

  private clearMaxRecordingTimer(): void {
    if (this.maxRecordingTimer) {
      clearTimeout(this.maxRecordingTimer);
      this.maxRecordingTimer = null;
    }
  }

  /** The rolling look-back window, so the UI can cap what it displays. */
  get lookBackSeconds(): number {
    return this.windowSeconds;
  }

  private setStatus(status: Omit<CaptureStatus, 'bufferedAsOf'>): void {
    // Re-stamp only when the measurement itself changed. Stamping on every
    // transition (armed → saving → armed) would keep resetting the origin the
    // UI extrapolates from, and the counter would never leave its last
    // segment-boundary value.
    const measured =
      status.bufferedSeconds !== this.status.bufferedSeconds
        ? Date.now()
        : this.status.bufferedAsOf;
    // Stamped from the field rather than carried by callers: every state
    // transition rebuilds the status object, and one that forgot to copy it
    // would silently reset the session clock.
    this.status = {
      ...status,
      bufferedAsOf: measured,
      armedSince: this.armedSince ?? undefined,
    };
    this.listeners.forEach(l => l(this.status));
  }
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function defaultClipName(capturedAt: number): string {
  const d = new Date(capturedAt);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `Clip ${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}.${pad(d.getMinutes())}.${pad(d.getSeconds())}`;
}
