/**
 * Scoring the live stream's behaviour during a native glasses recording.
 *
 * Answers whether Path A and Path B can produce footage for the same moment,
 * which decides whether a proxy-to-master swap is a feature or an impossibility.
 *
 * The glasses never expose an API to *start* a native recording from a third-
 * party app (MWDAT has stream + still capture only). U1 is therefore answered
 * backwards: the wearer records on the glasses while Path A is armed; when the
 * file later appears in Photos, this scorer reads the in-memory stream timeline
 * for that wall-clock window.
 *
 * The arithmetic lives here rather than in Swift because it is windowing and
 * thresholds — the same reason the marker matching does.
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
  /**
   * True when an error detail looks like CoreMedia sample-description / stsd
   * corruption or device-unavailable — the O8 class that motivated this probe.
   */
  stsdLike: boolean;
}

/**
 * Below this the proxy is not a usable clip even if the link technically
 * survived. Half of the 30fps the stream is configured for — a link losing
 * more than half its frames has stopped being a second camera and started
 * being a slideshow.
 */
const DEGRADED_FPS = 15;

/**
 * A sample at or below this counts as no frames at all. Not zero, because the
 * watchdog samples on a one-second tick and a single frame straddling a tick
 * boundary reads as a fraction rather than a clean nought.
 */
const DEAD_FPS = 0.5;

/** Outcomes that still allow Hybrid proxy→master swap. */
export function hybridSwapAllowed(outcome: ConcurrencyOutcome): boolean {
  return outcome === 'concurrent' || outcome === 'degraded';
}

/**
 * Path A proxies whose capture time falls inside the native recording window
 * (plus a small skew pad). Prefer the closest timestamp; callers swap one.
 */
export function findProxySwapCandidates<
  T extends {
    sourceKind: string;
    capturedAt: number;
    masterReplacedAt?: number | null;
  },
>(clips: readonly T[], window: NativeRecordingWindow, skewPadSec = 20): T[] {
  const start = window.startedAtMs - skewPadSec * 1000;
  const end = window.startedAtMs + window.durationSec * 1000 + skewPadSec * 1000;
  const mid = window.startedAtMs + (window.durationSec * 1000) / 2;
  return clips
    .filter(
      c =>
        (c.sourceKind === 'mwdat' || c.sourceKind === 'shadow') &&
        !c.masterReplacedAt &&
        c.capturedAt >= start &&
        c.capturedAt <= end,
    )
    .sort((a, b) => Math.abs(a.capturedAt - mid) - Math.abs(b.capturedAt - mid));
}

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
  const stsdLike = errors.some(isStsdLikeError);

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
    stsdLike,
    summary:
      `native recording of ${duration}: ${outcome} ` +
      `(${samples.length} samples, ${fpsText}, ${stalls} stalls, ${errors.length} errors` +
      `${stsdLike ? ', stsd-like' : ''})`,
  };
}

/** Heuristic for O8-class CoreMedia / format failures in timeline error text. */
export function isStsdLikeError(detail: string): boolean {
  const d = detail.toLowerCase();
  return (
    d.includes('stsd') ||
    d.includes('sample description') ||
    d.includes('format description') ||
    d.includes('deviceisnotavailable') ||
    d.includes('averrdeviceisnotavailable') ||
    d.includes('-11814') // AVErrorDeviceIsNotAvailable
  );
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
