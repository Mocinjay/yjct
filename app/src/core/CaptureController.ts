import RNFS from 'react-native-fs';
import type { DeviceVideoSource } from '../device/DeviceVideoSource';
import { stitchSegments } from '../native/ClipStitcher';
import type { Clip, Segment } from '../types';
import type { WakeWordProvider } from '../wakeword/WakeWordProvider';
import { clipStore } from './ClipStore';
import { SegmentRingBuffer } from './SegmentRingBuffer';

export type CaptureState = 'idle' | 'arming' | 'armed' | 'capturing' | 'error';

export interface CaptureStatus {
  state: CaptureState;
  bufferedSeconds: number;
  lastError?: string;
  lastClip?: Clip;
}

/**
 * The core loop: while armed, the device source streams segments into the
 * ring buffer; when the wake word fires, the in-flight segment is cut, the
 * covering segments are stitched into a clip, and the clip lands in the
 * library. Capture keeps running afterwards — back-to-back triggers are the
 * whole point.
 */
export class CaptureController {
  private buffer: SegmentRingBuffer;
  private status: CaptureStatus = { state: 'idle', bufferedSeconds: 0 };
  private listeners = new Set<(s: CaptureStatus) => void>();
  private capturing = false;

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
        this.captureClip().catch(err =>
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
    await this.wakeWord.stop().catch(() => {});
    await this.source.stop().catch(() => {});
    this.buffer.clear();
    this.setStatus({ state: 'idle', bufferedSeconds: 0 });
  }

  /** Trigger a capture manually (mock wake word / debug button). */
  async captureClip(): Promise<Clip | null> {
    if (this.capturing) {
      return null; // trigger fired while a flush is in progress; ignore
    }
    this.capturing = true;
    this.setStatus({ ...this.status, state: 'capturing' });
    try {
      await this.source.cut();
      const segments = this.buffer.flush();
      if (segments.length === 0) {
        throw new Error('Buffer is empty — nothing to clip yet.');
      }
      const clip = await this.stitch(segments);
      await clipStore.add(clip);
      // segment files are consumed by the stitch; clean them up
      await Promise.all(segments.map(s => RNFS.unlink(s.path).catch(() => {})));
      this.setStatus({ ...this.status, state: 'armed', lastClip: clip });
      return clip;
    } finally {
      this.capturing = false;
      if (this.status.state === 'capturing') {
        this.setStatus({ ...this.status, state: 'armed' });
      }
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
