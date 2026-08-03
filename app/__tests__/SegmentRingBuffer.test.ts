import { SegmentRingBuffer } from '../src/core/SegmentRingBuffer';
import type { Segment } from '../src/types';

function seg(n: number, durationSec = 5): Segment {
  return { path: `/tmp/seg_${n}.mp4`, startedAt: n * durationSec * 1000, durationSec };
}

describe('SegmentRingBuffer', () => {
  it('keeps only enough segments to cover the window (plus one)', () => {
    const evicted: Segment[] = [];
    const buf = new SegmentRingBuffer(30, s => evicted.push(s));

    // 10 x 5s segments = 50s pushed; window is 30s.
    for (let i = 0; i < 10; i++) {
      buf.push(seg(i));
    }

    // tail must cover >= 30s; head kept only while tail alone can't cover it
    expect(buf.totalBufferedSeconds).toBeLessThanOrEqual(35);
    expect(buf.totalBufferedSeconds).toBeGreaterThanOrEqual(30);
    expect(evicted.map(s => s.path)).toEqual([
      '/tmp/seg_0.mp4',
      '/tmp/seg_1.mp4',
      '/tmp/seg_2.mp4',
      '/tmp/seg_3.mp4',
    ]);
  });

  it('flush returns segments covering the window, oldest first, and empties the buffer', () => {
    const buf = new SegmentRingBuffer(10, () => {});
    buf.push(seg(0));
    buf.push(seg(1));
    buf.push(seg(2));

    const flushed = buf.flush();
    expect(flushed.map(s => s.path)).toEqual(['/tmp/seg_1.mp4', '/tmp/seg_2.mp4']);
    expect(buf.size).toBe(0);
    expect(buf.totalBufferedSeconds).toBe(0);
  });

  it('flush evicts segments outside the window', () => {
    const evicted: Segment[] = [];
    const buf = new SegmentRingBuffer(10, s => evicted.push(s));
    buf.push(seg(0));
    buf.push(seg(1));
    buf.push(seg(2));

    buf.flush();
    expect(evicted.map(s => s.path)).toEqual(['/tmp/seg_0.mp4']);
  });

  it('returns everything when the buffer does not yet cover the window', () => {
    const buf = new SegmentRingBuffer(60, () => {});
    buf.push(seg(0));
    buf.push(seg(1));

    const flushed = buf.flush();
    expect(flushed).toHaveLength(2);
  });

  it('clear evicts all segments', () => {
    const evicted: Segment[] = [];
    const buf = new SegmentRingBuffer(30, s => evicted.push(s));
    buf.push(seg(0));
    buf.push(seg(1));

    buf.clear();
    expect(buf.size).toBe(0);
    expect(evicted).toHaveLength(2);
  });

  it('pin freezes the look-back window and keeps everything after it', () => {
    const evicted: Segment[] = [];
    const buf = new SegmentRingBuffer(10, s => evicted.push(s));
    // 25s buffered before the trigger; window is 10s
    for (let i = 0; i < 5; i++) {
      buf.push(seg(i));
    }
    buf.pin();
    // recording continues after the trigger
    buf.push(seg(5));
    buf.push(seg(6));
    // pinned: nothing evicted while recording
    const evictedDuringRecording = evicted.length;

    const flushed = buf.flushFromPin();
    // look-back (segs 3,4 cover 10s) + everything after the pin (5,6)
    expect(flushed.map(s => s.path)).toEqual([
      '/tmp/seg_3.mp4',
      '/tmp/seg_4.mp4',
      '/tmp/seg_5.mp4',
      '/tmp/seg_6.mp4',
    ]);
    expect(buf.size).toBe(0);
    expect(buf.isPinned).toBe(false);
    expect(evicted.length).toBeGreaterThanOrEqual(evictedDuringRecording);
  });

  it('pin on an empty buffer still collects everything recorded afterwards', () => {
    const buf = new SegmentRingBuffer(30, () => {});
    buf.pin();
    buf.push(seg(0));
    buf.push(seg(1));
    expect(buf.flushFromPin().map(s => s.path)).toEqual([
      '/tmp/seg_0.mp4',
      '/tmp/seg_1.mp4',
    ]);
  });

  it('long recordings are never evicted while pinned', () => {
    const evicted: Segment[] = [];
    const buf = new SegmentRingBuffer(10, s => evicted.push(s));
    buf.push(seg(0));
    buf.pin();
    // 60s of recording after the trigger — far beyond the 10s window
    for (let i = 1; i <= 12; i++) {
      buf.push(seg(i));
    }
    expect(evicted).toHaveLength(0);
    expect(buf.flushFromPin()).toHaveLength(13);
  });

  it('flushEndingAt covers the window when the named segment is the newest', () => {
    const buf = new SegmentRingBuffer(10, () => {});
    for (let i = 0; i < 5; i++) {
      buf.push(seg(i));
    }

    // The usual case: transcription finishes before the next segment does.
    const flushed = buf.flushEndingAt('/tmp/seg_4.mp4');
    expect(flushed.map(s => s.path)).toEqual(['/tmp/seg_3.mp4', '/tmp/seg_4.mp4']);
    expect(buf.size).toBe(0);
  });

  it('flushEndingAt keeps segments recorded after the named one', () => {
    const evicted: Segment[] = [];
    const buf = new SegmentRingBuffer(10, s => evicted.push(s));
    for (let i = 0; i < 5; i++) {
      buf.push(seg(i));
    }

    // Slow transcription: seg_4 landed before the wake in seg_3 was reported.
    const flushed = buf.flushEndingAt('/tmp/seg_3.mp4');
    expect(flushed.map(s => s.path)).toEqual(['/tmp/seg_3.mp4']);
    expect(evicted.map(s => s.path)).not.toContain('/tmp/seg_4.mp4');
    // seg_4 stays behind as the next clip's look-back
    expect(buf.size).toBe(1);
    expect(buf.totalBufferedSeconds).toBe(5);
  });

  it('flushEndingAt returns nothing when the segment was already evicted', () => {
    const buf = new SegmentRingBuffer(10, () => {});
    buf.push(seg(0));
    buf.push(seg(1));

    expect(buf.flushEndingAt('/tmp/seg_99.mp4')).toEqual([]);
    expect(buf.size).toBe(2);
  });

  it('shrinking the window evicts immediately', () => {
    const evicted: Segment[] = [];
    const buf = new SegmentRingBuffer(90, s => evicted.push(s));
    for (let i = 0; i < 8; i++) {
      buf.push(seg(i)); // 40s buffered, window 90 → nothing evicted
    }
    expect(evicted).toHaveLength(0);

    buf.setWindowSeconds(10);
    expect(buf.totalBufferedSeconds).toBeLessThanOrEqual(15);
    expect(evicted.length).toBeGreaterThan(0);
  });
});
