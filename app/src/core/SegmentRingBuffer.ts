import type { Segment } from '../types';

/**
 * Tracks the rolling window of recorded segments and decides which files
 * cover the last N seconds when a trigger fires. Pure logic — file deletion
 * is delegated to the injected callback so this stays unit-testable.
 */
export class SegmentRingBuffer {
  private segments: Segment[] = [];
  /** Index of the first segment that belongs to an in-progress clip. */
  private pinnedFrom: number | null = null;

  constructor(
    private windowSeconds: number,
    private onEvict: (segment: Segment) => void,
  ) {}

  setWindowSeconds(seconds: number): void {
    this.windowSeconds = seconds;
    this.evict();
  }

  push(segment: Segment): void {
    this.segments.push(segment);
    this.evict();
  }

  /**
   * Trigger fired: freeze the segments covering the last `windowSeconds` and
   * stop evicting, so everything recorded from here on is part of the clip
   * until `flushFromPin()` is called.
   */
  pin(): void {
    if (this.pinnedFrom !== null) {
      return;
    }
    const covering = this.covering();
    this.pinnedFrom =
      covering.length > 0 ? this.segments.indexOf(covering[0]) : this.segments.length;
  }

  get isPinned(): boolean {
    return this.pinnedFrom !== null;
  }

  /**
   * Recording stopped: returns the pinned window plus everything recorded
   * since the pin, oldest first, and empties the buffer (ownership of the
   * files passes to the caller). Segments older than the pinned window are
   * evicted.
   */
  flushFromPin(): Segment[] {
    const start = this.pinnedFrom ?? 0;
    const out = this.segments.slice(start);
    for (const seg of this.segments.slice(0, start)) {
      this.onEvict(seg);
    }
    this.segments = [];
    this.pinnedFrom = null;
    return out;
  }

  /**
   * Returns the segments covering the last `windowSeconds`, oldest first,
   * and empties the buffer (ownership of the files passes to the caller).
   */
  flush(): Segment[] {
    const covering = this.covering();
    for (const seg of this.segments) {
      if (!covering.includes(seg)) {
        this.onEvict(seg);
      }
    }
    this.segments = [];
    this.pinnedFrom = null;
    return covering;
  }

  /** Drops everything, evicting all files. Used when disarming. */
  clear(): void {
    for (const seg of this.segments) {
      this.onEvict(seg);
    }
    this.segments = [];
    this.pinnedFrom = null;
  }

  get totalBufferedSeconds(): number {
    return this.segments.reduce((sum, s) => sum + s.durationSec, 0);
  }

  get size(): number {
    return this.segments.length;
  }

  private covering(): Segment[] {
    const out: Segment[] = [];
    let covered = 0;
    for (let i = this.segments.length - 1; i >= 0; i--) {
      out.unshift(this.segments[i]);
      covered += this.segments[i].durationSec;
      if (covered >= this.windowSeconds) {
        break;
      }
    }
    return out;
  }

  /**
   * Keep one segment beyond the window so a trigger right after a segment
   * boundary still covers the full window. Eviction is suspended while a
   * clip recording is pinned.
   */
  private evict(): void {
    if (this.pinnedFrom !== null) {
      return;
    }
    while (this.segments.length > 1) {
      const tail = this.segments.slice(1);
      const tailSeconds = tail.reduce((sum, s) => sum + s.durationSec, 0);
      if (tailSeconds >= this.windowSeconds) {
        this.onEvict(this.segments[0]);
        this.segments = tail;
      } else {
        break;
      }
    }
  }
}
