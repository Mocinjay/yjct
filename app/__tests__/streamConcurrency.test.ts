/**
 * The one question this instrument exists to answer: while the glasses were
 * recording natively, was the live stream still delivering frames?
 *
 * The failure mode worth guarding against is not a wrong answer but a
 * confident one. If the stream was never running, or the app was restarted
 * between the recording and the sync, there is no evidence either way — and a
 * scorer that reports "the stream died" when it simply was not watching would
 * settle an architectural question with an artefact.
 */

import {
  concurrencyVerdict,
  type StreamTimelineEntry,
} from '../src/markers/streamConcurrency';

const RECORDING_START = Date.parse('2026-08-05T20:36:39Z');

/** An fps sample `atSec` seconds into the native recording. */
function sample(atSec: number, fps: number): StreamTimelineEntry {
  return {
    atMs: RECORDING_START + atSec * 1000,
    kind: 'fps',
    detail: '',
    fps,
  };
}

function event(
  atSec: number,
  kind: StreamTimelineEntry['kind'],
  detail = '',
): StreamTimelineEntry {
  return { atMs: RECORDING_START + atSec * 1000, kind, detail, fps: -1 };
}

/** The window a native recording occupied. */
const window = { startedAtMs: RECORDING_START, durationSec: 20 };

describe('concurrencyVerdict', () => {
  it('reports no evidence when the timeline is empty', () => {
    const verdict = concurrencyVerdict([], window);
    expect(verdict.outcome).toBe('no-evidence');
    expect(verdict.samplesInWindow).toBe(0);
  });

  it('reports no evidence when the stream was only running outside the window', () => {
    // Streaming stopped a full minute before the wearer recorded natively.
    const verdict = concurrencyVerdict([sample(-90, 30), sample(-70, 30)], window);
    expect(verdict.outcome).toBe('no-evidence');
  });

  it('calls it concurrent when frames kept arriving throughout', () => {
    const timeline = [sample(1, 30), sample(8, 29), sample(15, 30), sample(19, 30)];
    const verdict = concurrencyVerdict(timeline, window);
    expect(verdict.outcome).toBe('concurrent');
    expect(verdict.minFps).toBeCloseTo(29);
    expect(verdict.samplesInWindow).toBe(4);
  });

  it('calls it exclusive when frames stopped inside the window', () => {
    // The signature of the camera being taken over: healthy, then zero.
    const timeline = [sample(1, 30), sample(5, 30), sample(9, 0), sample(14, 0)];
    const verdict = concurrencyVerdict(timeline, window);
    expect(verdict.outcome).toBe('exclusive');
    expect(verdict.minFps).toBe(0);
  });

  it('calls it exclusive when the stream stalled inside the window', () => {
    const timeline = [sample(2, 30), event(9, 'stalled', 'no frame for 10.0s')];
    expect(concurrencyVerdict(timeline, window).outcome).toBe('exclusive');
  });

  it('calls it exclusive when the stream errored inside the window', () => {
    const timeline = [sample(2, 30), event(6, 'error', 'videoStreamingError')];
    const verdict = concurrencyVerdict(timeline, window);
    expect(verdict.outcome).toBe('exclusive');
    expect(verdict.errors).toEqual(['videoStreamingError']);
  });

  it('ignores a stall that happened after the recording ended', () => {
    const timeline = [sample(2, 30), sample(18, 30), event(45, 'stalled')];
    expect(concurrencyVerdict(timeline, window).outcome).toBe('concurrent');
  });

  it('does not count event entries as zero-fps samples', () => {
    // Events carry fps -1 to mean "not a sample". Treating that as a reading
    // would score every ordinary state change as a dead link.
    const timeline = [sample(2, 30), event(5, 'state', 'streaming'), sample(9, 30)];
    const verdict = concurrencyVerdict(timeline, window);
    expect(verdict.outcome).toBe('concurrent');
    expect(verdict.minFps).toBeCloseTo(30);
    expect(verdict.samplesInWindow).toBe(2);
  });

  it('calls it degraded when frames thinned but never stopped', () => {
    // Neither answer: the link survived, but not well enough to call the
    // proxy usable. Worth telling apart from a clean pass.
    const timeline = [sample(2, 30), sample(8, 4), sample(16, 30)];
    const verdict = concurrencyVerdict(timeline, window);
    expect(verdict.outcome).toBe('degraded');
    expect(verdict.minFps).toBeCloseTo(4);
  });

  it('describes itself in one line for the diagnostics log', () => {
    const verdict = concurrencyVerdict([sample(1, 30), sample(9, 0)], window);
    expect(verdict.summary).toContain('exclusive');
    expect(verdict.summary).toContain('20s');
  });
});
