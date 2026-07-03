import RNFS from 'react-native-fs';
import { MAX_CLIP_RECORDING_SECONDS } from '../config';
import type { DeviceVideoSource } from '../device/DeviceVideoSource';
import { stitchSegments } from '../native/ClipStitcher';
import type { Clip, Segment } from '../types';
import type { WakeWordProvider } from '../wakeword/WakeWordProvider';
import { clipStore } from './ClipStore';
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
  bufferedSeconds: number;
  /** Epoch ms of the trigger, set while state === 'recording'. */
  recordingSince?: number;
  lastError?: string;
  lastClip?: Clip;
}

/**
 * The core loop:
 *
 *   armed      — rolling buffer keeps the last N seconds, evicting old files
 *   "fade away" — the wake phrase AUTO-SAVES the look-back window as a clip
 *   extended   — the manual REC button instead pins the window and keeps
 *                recording until stopped (stop button / wake phrase /
 *                safety cap): [start − N seconds … stop]
 */
export class CaptureController {
  private buffer: SegmentRingBuffer;
  private status: CaptureStatus = { state: 'idle', bufferedSeconds: 0 };
  private listeners = new Set<(s: CaptureStatus) => void>();
  private saving = false;
  private maxRecordingTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(
    private source: DeviceVideoSource,
    private wakeWord: WakeWordProvider,
    private windowSeconds: number,
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
    this.setStatus({ state: 'arming', bufferedSeconds: 0 });
    try {
      await this.source.prepare();
      await this.source.start(
        seg => this.onSegment(seg),
        err => this.setStatus({ ...this.status, state: 'error', lastError: err.message }),
      );
      await this.wakeWord.start(() => {
        this.onWakePhrase().catch(err =>
          this.setStatus({ ...this.status, state: 'error', lastError: String(err) }),
        );
      });
      this.setStatus({ ...this.status, state: 'armed' });
    } catch (err) {
      await this.disarm();
      this.setStatus({
        state: 'error',
        bufferedSeconds: 0,
        lastError: err instanceof Error ? err.message : String(err),
      });
      throw err;
    }
  }

  async disarm(): Promise<void> {
    this.clearMaxRecordingTimer();
    await this.wakeWord.stop().catch(() => {});
    await this.source.stop().catch(() => {});
    this.buffer.clear();
    this.setStatus({ state: 'idle', bufferedSeconds: 0 });
  }

  /**
   * "fade away" heard: if an extended recording is running, stop & save it;
   * otherwise auto-save the look-back window as a clip right now.
   */
  async onWakePhrase(): Promise<void> {
    if (this.status.state === 'recording') {
      await this.stopClip();
    } else if (this.status.state === 'armed') {
      await this.captureNow();
    }
  }

  /** Auto-save the buffered look-back window as a clip. Capture keeps running. */
  async captureNow(): Promise<Clip | null> {
    if (this.status.state !== 'armed' || this.saving) {
      return null;
    }
    this.saving = true;
    this.setStatus({ ...this.status, state: 'saving' });
    try {
      await this.source.cut();
      const segments = this.buffer.flush();
      if (segments.length === 0) {
        throw new Error('Buffer is empty — nothing to clip yet.');
      }
      const clip = await this.stitch(segments);
      await clipStore.add(clip);
      await Promise.all(segments.map(s => RNFS.unlink(s.path).catch(() => {})));
      this.setStatus({ state: 'armed', bufferedSeconds: 0, lastClip: clip });
      return clip;
    } catch (err) {
      this.setStatus({
        ...this.status,
        state: 'armed',
        lastError: err instanceof Error ? err.message : String(err),
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
    this.clearMaxRecordingTimer();
    this.setStatus({ ...this.status, state: 'saving' });
    try {
      await this.source.cut();
      const segments = this.buffer.flushFromPin();
      if (segments.length === 0) {
        throw new Error('Nothing recorded — buffer was empty.');
      }
      const clip = await this.stitch(segments);
      await clipStore.add(clip);
      await Promise.all(segments.map(s => RNFS.unlink(s.path).catch(() => {})));
      this.setStatus({
        state: 'armed',
        bufferedSeconds: 0,
        lastClip: clip,
      });
      return clip;
    } catch (err) {
      this.setStatus({
        ...this.status,
        state: 'armed',
        recordingSince: undefined,
        lastError: err instanceof Error ? err.message : String(err),
      });
      return null;
    } finally {
      this.saving = false;
    }
  }

  private async stitch(segments: Segment[]): Promise<Clip> {
    const capturedAt = Date.now();
    const id = `clip_${capturedAt}_${Math.random().toString(36).slice(2, 8)}`;
    const dir = await clipStore.ensureDir();
    const outputPath = `${dir}/${id}.mp4`;
    const result = await stitchSegments(
      segments.map(s => s.path),
      outputPath,
    );
    return {
      id,
      name: defaultClipName(capturedAt),
      filePath: result.outputPath,
      thumbnailPath: result.thumbnailPath,
      capturedAt,
      durationSec: result.durationSec,
      sourceKind: this.source.kind,
    };
  }

  private onSegment(segment: Segment): void {
    this.buffer.push(segment);
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

  private setStatus(status: CaptureStatus): void {
    this.status = status;
    this.listeners.forEach(l => l(status));
  }
}

function defaultClipName(capturedAt: number): string {
  const d = new Date(capturedAt);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `Clip ${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}.${pad(d.getMinutes())}.${pad(d.getSeconds())}`;
}
