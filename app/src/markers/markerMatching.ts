/**
 * Placing spoken markers inside footage the phone never recorded.
 *
 * When the glasses capture to their own storage, nothing links what the phone
 * heard to what the glasses saw — there is no shared session, no shared clock
 * tick, not even a running connection. The only thing the two have in common is
 * the wall clock: the phone stamps the moment the trigger word finished, and
 * the recording carries the moment it began. Everything here is arithmetic on
 * those two numbers.
 *
 * Pure by design, so the cutting rules can be tested without a photo library,
 * a microphone, or a pair of glasses.
 */

/** A trigger word the phone heard, on the wall clock. */
export interface WakeMarker {
  id: string;
  /** Epoch ms at which the phrase finished being spoken. */
  atMs: number;
  /**
   * Audio segment the phrase was heard in, kept so alignment can later be
   * refined by correlating this audio against the video's own.
   */
  segmentPath?: string;
}

/** A recording the glasses made on their own. */
export interface GlassesVideo {
  localIdentifier: string;
  /** Epoch ms at which the glasses began recording. */
  startedAtMs: number;
  durationSec: number;
  width: number;
  height: number;
}

export interface MatchOptions {
  /**
   * How long before the recording starts a marker may still belong to it.
   *
   * Only ever meant to absorb clock skew between two devices that sync time
   * independently — a marker genuinely spoken before recording began has
   * nothing to point at.
   */
  graceBeforeSec?: number;
  /**
   * How long after the recording ends a marker may still belong to it.
   *
   * Much more generous than `graceBeforeSec`, and deliberately so: the trigger
   * is a reaction. The wearer sees something, registers it, and only then says
   * the word — routinely after they have already stopped recording. Treating
   * those as belonging to nothing would throw away the exact moments the
   * feature exists to catch.
   */
  graceAfterSec?: number;
}

export interface ClipRangeOptions {
  /** Seconds of footage to keep before the trigger. */
  lookbackSec: number;
  /**
   * Seconds to keep after the trigger finished being spoken.
   *
   * Zero by default because the clip is a look-back: the word marks the end of
   * the interesting part, and anything past it is the wearer talking to their
   * glasses.
   */
  leadOutSec?: number;
}

/** Seconds from the start of `video` at which `marker` was spoken. */
export function markerOffsetSec(marker: WakeMarker, video: GlassesVideo): number {
  return (marker.atMs - video.startedAtMs) / 1000;
}

/**
 * The markers that belong to this recording, oldest first.
 *
 * A marker can only belong to one recording because the glasses only record
 * one at a time; callers matching a batch should still expect a marker to be
 * claimed by at most one video.
 */
export function markersWithin(
  markers: readonly WakeMarker[],
  video: GlassesVideo,
  options: MatchOptions = {},
): WakeMarker[] {
  const graceBeforeSec = options.graceBeforeSec ?? 2;
  const graceAfterSec = options.graceAfterSec ?? 15;

  const startMs = video.startedAtMs - graceBeforeSec * 1000;
  const endMs = video.startedAtMs + video.durationSec * 1000 + graceAfterSec * 1000;

  return markers
    .filter(marker => marker.atMs >= startMs && marker.atMs <= endMs)
    .sort((a, b) => a.atMs - b.atMs);
}

/**
 * Drop markers that land on top of one another.
 *
 * Detection already debounces repeats within a few seconds, but that only
 * suppresses one utterance being recognized twice. Someone saying the word
 * again ten seconds later is a real second marker whose look-back window
 * almost entirely overlaps the first — two near-identical clips out of one
 * moment. Keeping the earlier of the pair keeps the clip that ends on the
 * first reaction rather than the afterthought.
 */
export function coalesceMarkers(
  markers: readonly WakeMarker[],
  minGapSec: number,
): WakeMarker[] {
  const sorted = [...markers].sort((a, b) => a.atMs - b.atMs);
  const kept: WakeMarker[] = [];
  for (const marker of sorted) {
    const previous = kept[kept.length - 1];
    if (previous && (marker.atMs - previous.atMs) / 1000 < minGapSec) {
      continue;
    }
    kept.push(marker);
  }
  return kept;
}

/** A cut to make in a recording, in seconds from its start. */
export interface ClipRange {
  startSec: number;
  endSec: number;
}

/**
 * Where to cut for a marker, clamped to the recording.
 *
 * Returns null when the marker leaves nothing to cut — which happens for real:
 * a marker inside `graceBeforeSec` of the start points at footage that does
 * not exist yet.
 */
export function clipRangeForMarker(
  marker: WakeMarker,
  video: GlassesVideo,
  options: ClipRangeOptions,
): ClipRange | null {
  const leadOutSec = options.leadOutSec ?? 0;
  const offsetSec = markerOffsetSec(marker, video);

  // A marker past the end is the normal reaction case, not an error: the
  // wearer stopped recording and then said the word. The clip still ends where
  // the footage does.
  const endSec = Math.min(offsetSec + leadOutSec, video.durationSec);
  const startSec = Math.max(endSec - options.lookbackSec, 0);

  if (endSec <= 0 || endSec - startSec <= 0) {
    return null;
  }
  return { startSec, endSec };
}

/**
 * Every cut to make in one recording.
 *
 * Coalescing uses the look-back window as the gap, because two markers closer
 * together than that produce clips that are mostly the same footage.
 */
export function clipRangesForVideo(
  markers: readonly WakeMarker[],
  video: GlassesVideo,
  options: ClipRangeOptions & MatchOptions,
): { marker: WakeMarker; range: ClipRange }[] {
  const mine = coalesceMarkers(
    markersWithin(markers, video, options),
    options.lookbackSec,
  );
  const cuts: { marker: WakeMarker; range: ClipRange }[] = [];
  for (const marker of mine) {
    const range = clipRangeForMarker(marker, video, options);
    if (range !== null) {
      cuts.push({ marker, range });
    }
  }
  return cuts;
}
