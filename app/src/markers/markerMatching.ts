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
  /**
   * Longest single clip this tier allows.
   *
   * Only ever bites on a merged window, which can reach twice the look-back
   * when two triggers sit exactly a look-back apart. Trimming comes off the
   * front: the clip is a look-back, so the end is the moment and the start is
   * the negotiable part.
   */
  maxWindowSec?: number;
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

/** A cut, and every marker that asked for it. */
export interface Cut {
  /** Oldest first. All of them are spent when the cut is made. */
  markers: WakeMarker[];
  range: ClipRange;
}

/**
 * Every cut to make in one recording.
 *
 * Two triggers close together do not mean two clips. Their look-back windows
 * overlap almost entirely, so cutting both produces a pair of near-identical
 * videos out of one moment. What they actually describe is one longer moment —
 * the wearer reacted, and then reacted again — so overlapping windows are
 * merged into their union rather than one of them being thrown away. Discarding
 * the later marker, which is what this used to do, silently cut the second
 * reaction out of the clip that was supposed to contain it.
 *
 * The union has a bound: two markers exactly a look-back apart give twice the
 * look-back, and no more, because any further apart and the windows no longer
 * touch. `maxWindowSec` is what keeps that inside a tier's limit.
 */
export function clipRangesForVideo(
  markers: readonly WakeMarker[],
  video: GlassesVideo,
  options: ClipRangeOptions & MatchOptions,
): Cut[] {
  // Sorted by marker time, and both ends of a range move with it, so ranges
  // arrive in order and a single forward pass is enough to merge them.
  const cuts: Cut[] = [];
  for (const marker of markersWithin(markers, video, options)) {
    const range = clipRangeForMarker(marker, video, options);
    if (range === null) {
      continue;
    }
    const previous = cuts[cuts.length - 1];
    if (previous && range.startSec <= previous.range.endSec) {
      previous.range = {
        startSec: previous.range.startSec,
        endSec: Math.max(previous.range.endSec, range.endSec),
      };
      previous.markers.push(marker);
    } else {
      cuts.push({ markers: [marker], range });
    }
  }

  const { maxWindowSec } = options;
  if (maxWindowSec !== undefined) {
    for (const cut of cuts) {
      if (cut.range.endSec - cut.range.startSec > maxWindowSec) {
        cut.range = {
          startSec: cut.range.endSec - maxWindowSec,
          endSec: cut.range.endSec,
        };
      }
    }
  }
  return cuts;
}
