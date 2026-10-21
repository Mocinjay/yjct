/**
 * Scoring what the live stream did while the glasses recorded on their own.
 *
 * Answers whether live mode can produce a 720p clip and the glasses a
 * full-resolution recording of the same moment, which decides whether live
 * mode's 720p-then-full-res swap works or whether full resolution needs
 * glasses-only mode (docs/MAX-RESOLUTION.md). The timeline comes from
 * `MWDATStreamTimeline` in MWDATBridge.swift; the windowing and thresholds
 * live here, like the marker matching.
 */

export interface StreamTimelineEntry {
  atMs: number;
  kind: 'fps' | 'state' | 'error' | 'stalled' | 'recovered';
  detail: string;
  /** Frames per second over the preceding tick; negative on event entries. */
  fps: number;
}

export interface NativeRecordingWindow {
  startedAtMs: number;
  durationSec: number;
}

export type ConcurrencyOutcome =
  /** The stream was not being watched during the window; nothing to conclude. */
  | 'no-evidence'
  /** Frames kept arriving at a usable rate throughout. */
  | 'concurrent'
  /** Frames thinned but never stopped. */
  | 'degraded'
  /** Frames stopped, stalled or errored inside the window. */
  | 'exclusive';

export interface ConcurrencyVerdict {
  outcome: ConcurrencyOutcome;
  samplesInWindow: number;
  /** Lowest fps sample seen inside the window, or null when none were taken. */
  minFps: number | null;
  stalls: number;
  errors: string[];
  summary: string;
}

/**
 * Below this the 720p clip is not usable even if the link survived: half of
 * the 30fps the stream asks for.
 */
const DEGRADED_FPS = 15;

/**
 * A sample at or below this counts as no frames at all. Not zero, because the
 * watchdog samples on a one-second tick and a single frame straddling a tick
 * boundary reads as a fraction rather than a clean nought.
 */
const DEAD_FPS = 0.5;

export function concurrencyVerdict(
  timeline: readonly StreamTimelineEntry[],
  window: NativeRecordingWindow,
): ConcurrencyVerdict {
  const startMs = window.startedAtMs;
  const endMs = startMs + window.durationSec * 1000;
  const inWindow = timeline.filter(e => e.atMs >= startMs && e.atMs <= endMs);

  // Event entries carry fps -1 to mean "this is not a reading". Absent is not
  // zero: folding them in would score an ordinary state change as a dead link.
  const samples = inWindow.filter(e => e.kind === 'fps' && e.fps >= 0);
  const stalls = inWindow.filter(e => e.kind === 'stalled').length;
  const errors = inWindow.filter(e => e.kind === 'error').map(e => e.detail);

  const minFps =
    samples.length > 0 ? Math.min(...samples.map(s => s.fps)) : null;

  const outcome = decide(samples.length, minFps, stalls, errors.length);
  const duration = `${Math.round(window.durationSec)}s`;
  const fpsText = minFps === null ? 'no samples' : `min ${minFps.toFixed(1)}fps`;

  return {
    outcome,
    samplesInWindow: samples.length,
    minFps,
    stalls,
    errors,
    summary:
      `native recording of ${duration}: ${outcome} ` +
      `(${samples.length} samples, ${fpsText}, ${stalls} stalls, ${errors.length} errors)`,
  };
}

function decide(
  sampleCount: number,
  minFps: number | null,
  stalls: number,
  errorCount: number,
): ConcurrencyOutcome {
  // Nothing was watching. Saying "the stream died" here would answer an
  // architectural question with an artefact of when the app happened to run.
  if (sampleCount === 0 && stalls === 0 && errorCount === 0) {
    return 'no-evidence';
  }
  if (stalls > 0 || errorCount > 0) {
    return 'exclusive';
  }
  if (minFps === null) {
    return 'no-evidence';
  }
  if (minFps <= DEAD_FPS) {
    return 'exclusive';
  }
  return minFps < DEGRADED_FPS ? 'degraded' : 'concurrent';
}
