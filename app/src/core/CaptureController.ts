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
import { createLogger } from './Logger';
import { AppError, ErrorCode } from './errors';
import { SegmentRingBuffer } from './SegmentRingBuffer';

const log = createLogger('capture');

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
   * Epoch ms of the last successful `arm()` — how long this session has been
   * listening. Deliberately NOT capped at the look-back window: the window
   * bounds what a trigger clips, not how long the wearer has been live, and
   * showing the capped number as the session clock made it look like capture
   * stopped at 30s.
   */
  armedSince?: number;
  lastError?: string;
  lastClip?: Clip;
  /**
   * How many clips have been saved since this armed session started, so the
   * wearer can hear "Clypso" land and see *which* one it was — "Save #3" —
   * without opening the library. Resets on every `arm()`.
   */
  sessionClipCount?: number;
}

/**
 * The core loop:
 *
 *   armed      — rolling buffer keeps the last N seconds, evicting old files
 *   "clypso"   — the wake word AUTO-SAVES the look-back window as a clip
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
      // Routine: the file is often already gone because a save took ownership
      // of it. Worth a debug line only — but a storm of these means eviction is
      // racing the stitcher, which is not routine at all.
      RNFS.unlink(seg.path).catch(err =>
        log.expected('could not delete evicted segment', err, ErrorCode.CaptureSegmentCleanupFailed),
      );
    });
  }

  subscribe(listener: (s: CaptureStatus) => void): () => void {
    this.listeners.add(listener);
    listener(this.status);
    return () => this.listeners.delete(listener);
  }

  async arm(): Promise<void> {
    this.sessionClipCount = 0;
    this.setStatus({ state: 'arming', bufferedSeconds: 0 });
    try {
      await this.source.prepare();
      await this.source.start(
        seg => this.onSegment(seg),
        // The source's own error channel: this is how a glasses link that drops
        // mid-session reports itself, so it is the single most important log
        // line in the app.
        err => this.fail('glasses feed failed', err, ErrorCode.GlassesSessionFailed),
      );
      await this.wakeWord.start(detection => {
        this.onWakePhrase(detection).catch(err =>
          this.fail('wake phrase handling failed', err, ErrorCode.CaptureSaveFailed),
        );
      });
      this.armedSince = Date.now();
      log.info('armed', {
        source: this.source.kind,
        wakeWord: this.wakeWord.name,
        windowSeconds: this.windowSeconds,
      });
      this.setStatus({ ...this.status, state: 'armed' });
    } catch (err) {
      const wrapped = log.error('could not arm', err, ErrorCode.CaptureArmFailed);
      await this.disarm();
      this.setStatus({
        state: 'error',
        bufferedSeconds: 0,
        lastError: wrapped.userMessage,
      });
      throw wrapped;
    }
  }

  async disarm(): Promise<void> {
    this.clearMaxRecordingTimer();
    // Both teardowns are attempted even if the first fails: leaving the camera
    // or the recognizer running because its sibling threw is how a "disarmed"
    // session kept draining the battery.
    await this.wakeWord
      .stop()
      .catch(err =>
        log.expected('wake word did not stop cleanly', err, ErrorCode.WakeWordStopFailed),
      );
    await this.source
      .stop()
      .catch(err =>
        log.expected('source did not stop cleanly', err, ErrorCode.GlassesTeardownFailed),
      );
    this.buffer.clear();
    this.armedSince = null;
    log.info('disarmed');
    this.setStatus({ state: 'idle', bufferedSeconds: 0 });
  }

  /**
   * Push the controller into `error` and record it once, in one place. Every
   * asynchronous failure path used to inline its own `setStatus`, and each
   * inlined a slightly different shape — one used `err.message`, one
   * `String(err)`, and neither logged.
   */
  private fail(message: string, cause: unknown, code: ErrorCode): void {
    const wrapped = log.error(message, cause, code);
    this.setStatus({
      ...this.status,
      state: 'error',
      lastError: wrapped.userMessage,
    });
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
   * cut and the whole window saved, as before.
   */
  async captureNow(detection?: WakeDetection): Promise<Clip | null> {
    if (this.status.state !== 'armed' || this.saving) {
      return null;
    }
    this.saving = true;
    this.chime();
    this.setStatus({ ...this.status, state: 'saving' });
    try {
      let segments: Segment[] = [];
      let trimEndSec = 0;
      if (detection) {
        segments = this.buffer.flushEndingAt(detection.segmentPath);
        if (segments.length > 0) {
          const last = segments[segments.length - 1];
          trimEndSec = Math.max(
            0,
            last.durationSec - (detection.endOffsetSec + WAKE_TRIM_PADDING_SECONDS),
          );
        }
      }
      if (segments.length === 0) {
        await this.source.cut();
        segments = this.buffer.flush();
      }
      if (segments.length === 0) {
        throw new AppError(
          ErrorCode.CaptureBufferEmpty,
          'buffer empty at trigger — nothing to clip yet',
          { context: { triggeredBy: detection ? 'wake-word' : 'manual' } },
        );
      }
      const clip = await this.stitch(segments, trimEndSec);
      await clipStore.add(clip);
      this.announceSaved(clip);
      await this.releaseSegments(segments);
      this.sessionClipCount += 1;
      log.info('clip saved', {
        id: clip.id,
        durationSec: clip.durationSec,
        segments: segments.length,
        endedOnWakeWord: trimEndSec > 0,
      });
      this.setStatus({
        state: 'armed',
        // Segments recorded after the wake word are kept as the next clip's
        // look-back, so the counter does not necessarily fall back to zero.
        bufferedSeconds: this.buffer.totalBufferedSeconds,
        lastClip: clip,
        sessionClipCount: this.sessionClipCount,
      });
      return clip;
    } catch (err) {
      // Back to `armed`, not `error`: capture is still running and the next
      // trigger will work. Only the save that just failed is lost.
      const wrapped = log.error('could not save clip', err, ErrorCode.CaptureStitchFailed);
      this.setStatus({
        ...this.status,
        state: 'armed',
        lastError: wrapped.userMessage,
      });
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
    if (this.status.state !== 'armed') {
      return;
    }
    this.buffer.pin();
    this.setStatus({
      ...this.status,
      state: 'recording',
      recordingSince: Date.now(),
    });
    this.maxRecordingTimer = setTimeout(() => {
      this.stopClip().catch(err =>
        this.setStatus({ ...this.status, state: 'error', lastError: String(err) }),
      );
    }, MAX_CLIP_RECORDING_SECONDS * 1000);
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
        throw new AppError(
          ErrorCode.CaptureBufferEmpty,
          'extended recording ended with an empty buffer',
        );
      }
      const clip = await this.stitch(segments);
      await clipStore.add(clip);
      this.announceSaved(clip);
      await this.releaseSegments(segments);
      this.sessionClipCount += 1;
      log.info('extended clip saved', {
        id: clip.id,
        durationSec: clip.durationSec,
        segments: segments.length,
      });
      this.setStatus({
        state: 'armed',
        bufferedSeconds: 0,
        lastClip: clip,
        sessionClipCount: this.sessionClipCount,
      });
      return clip;
    } catch (err) {
      const wrapped = log.error(
        'could not save extended clip',
        err,
        ErrorCode.CaptureStitchFailed,
      );
      this.setStatus({
        ...this.status,
        state: 'armed',
        recordingSince: undefined,
        lastError: wrapped.userMessage,
      });
      return null;
    } finally {
      this.saving = false;
    }
  }

  /**
   * The clip owns these frames now, so the segment files are redundant. Failing
   * to delete one wastes disk but breaks nothing, and it must never fail the
   * save that already succeeded.
   */
  private async releaseSegments(segments: Segment[]): Promise<void> {
    await Promise.all(
      segments.map(s =>
        RNFS.unlink(s.path).catch(err =>
          log.expected(
            'could not delete consumed segment',
            err,
            ErrorCode.CaptureSegmentCleanupFailed,
          ),
        ),
      ),
    );
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
   * Post-capture work is never allowed to fail a capture that already
   * succeeded — the clip is on disk and in the library either way.
   */
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
    this.source
      .chime?.()
      .catch(err => log.expected('chime failed', err, ErrorCode.GlassesSessionFailed));
  }

  private announceSaved(clip: Clip): void {
    // Second tone: the clip is on disk and in the library, not merely heard.
    this.chime();
    try {
      this.onClipSaved?.(clip);
    } catch (err) {
      // Captioning is best-effort and the clip is already safe — but a hook
      // that throws every time is a broken pipeline, not a quirk.
      log.error('post-capture hook failed', err, ErrorCode.CaptionJobFailed);
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

export function defaultClipName(capturedAt: number): string {
  const d = new Date(capturedAt);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `Clip ${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}.${pad(d.getMinutes())}.${pad(d.getSeconds())}`;
}
