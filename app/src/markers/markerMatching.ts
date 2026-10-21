/**
 * Placing trigger moments inside footage the phone never recorded.
 *
 * When the glasses record to their own storage, nothing links what the phone
 * heard to what the glasses saw: no shared session, no shared clock tick. The
 * only thing the two have in common is the wall clock. The phone stamps the
 * moment, and the recording carries the time it began. Everything here is
 * arithmetic on those numbers, kept pure so the cutting rules can be tested
 * without a photo library, a microphone or a pair of glasses.
 */

/** A moment the wearer asked for, on the wall clock. */
export interface WakeMarker {
  id: string;
  /**
   * Epoch ms at which the moment ended: the trigger word finished, the Clip
   * button was pressed, or an extended recording was stopped.
   */
  atMs: number;
  /**
   * Epoch ms at which the wanted footage starts. Set when a 720p clip was cut
   * for this moment in live mode, so the full-resolution cut spans the same
   * footage. Absent means the default look-back before `atMs`.
   */
  startMs?: number;
  /**
   * The 720p clip cut for this moment from the live stream. The
   * full-resolution cut replaces it once the glasses' own recording arrives.
   */
  proxyClipId?: string;
  /** Audio segment the phrase was heard in, when one exists. */
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
   * How long before a recording starts a marker may still belong to it. Only
   * absorbs clock skew between two devices that keep time independently.
   */
  graceBeforeSec?: number;
  /**
   * How long after a recording ends a marker may still belong to it. Generous
   * because the trigger is a reaction: the wearer often says the word after
   * they have already stopped recording.
   */
  graceAfterSec?: number;
}

export interface ClipRangeOptions {
  /** Seconds of footage to keep before a marker that carries no `startMs`. */
  lookbackSec: number;
  /**
   * Seconds to keep after the moment ended. Zero by default: the clip is a
   * look-back, and anything past the word is the wearer talking to the phone.
   */
  leadOutSec?: number;
  /**
   * Longest clip this tier allows, applied to cuts built only from default
   * look-backs (two close triggers merge into up to twice the look-back).
   * Cuts that match a 720p clip keep that clip's span. Trimming comes off the
   * front: the end is the moment.
   */
  maxWindowSec?: number;
}

/** Seconds from the start of `video` at which `atMs` falls. */
export function offsetSec(atMs: number, video: GlassesVideo): number {
  return (atMs - video.startedAtMs) / 1000;
}

/**
 * The markers that belong to this recording, oldest first. The glasses record
 * one video at a time, so a marker belongs to at most one recording.
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
 * Where to cut for one marker, clamped to the recording. Null when nothing is
 * left to cut: a marker inside `graceBeforeSec` of the start points at footage
 * that does not exist.
 */
export function clipRangeForMarker(
  marker: WakeMarker,
  video: GlassesVideo,
  options: ClipRangeOptions,
): ClipRange | null {
  const leadOutSec = options.leadOutSec ?? 0;
  // A marker past the end is the normal reaction case: the clip still ends
  // where the footage does.
  const endSec = Math.min(offsetSec(marker.atMs, video) + leadOutSec, video.durationSec);
  const startSec = Math.max(
    marker.startMs !== undefined
      ? offsetSec(marker.startMs, video)
      : endSec - options.lookbackSec,
    0,
  );
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
  /** The 720p clip this cut replaces, when one was cut for the same moment. */
  proxyClipId?: string;
}

/**
 * Every cut to make in one recording.
 *
 * Two triggers close together describe one longer moment, not two clips:
 * their windows overlap almost entirely. Overlapping windows merge into their
 * union, except two that each back a different 720p clip, which stay separate
 * so each clip gets its own replacement.
 */
export function clipRangesForVideo(
  markers: readonly WakeMarker[],
  video: GlassesVideo,
  options: ClipRangeOptions & MatchOptions,
): Cut[] {
  // Sorted by marker end, so a single forward pass merges.
  const cuts: Cut[] = [];
  for (const marker of markersWithin(markers, video, options)) {
    const range = clipRangeForMarker(marker, video, options);
    if (range === null) {
      continue;
    }
    const previous = cuts[cuts.length - 1];
    const distinctProxies =
      previous?.proxyClipId !== undefined &&
      marker.proxyClipId !== undefined &&
      previous.proxyClipId !== marker.proxyClipId;
    if (previous && range.startSec <= previous.range.endSec && !distinctProxies) {
      previous.range = {
        startSec: Math.min(previous.range.startSec, range.startSec),
        endSec: Math.max(previous.range.endSec, range.endSec),
      };
      previous.markers.push(marker);
      previous.proxyClipId ??= marker.proxyClipId;
    } else {
      cuts.push({ markers: [marker], range, proxyClipId: marker.proxyClipId });
    }
  }

  const { maxWindowSec } = options;
  if (maxWindowSec !== undefined) {
    for (const cut of cuts) {
      const implicit = cut.markers.every(marker => marker.startMs === undefined);
      if (implicit && cut.range.endSec - cut.range.startSec > maxWindowSec) {
        cut.range = { startSec: cut.range.endSec - maxWindowSec, endSec: cut.range.endSec };
      }
    }
  }
  return cuts;
}

/**
 * Whether a cut covers the span of the 720p clip it would replace, within
 * `toleranceSec` at either end (keyframe placement and clock skew). A cut that
 * falls short, because the glasses started recording after the moment began,
 * would lose footage the wearer already has, so it is kept alongside the 720p
 * clip instead of replacing it.
 */
export function coversProxyWindow(
  cut: Cut,
  video: GlassesVideo,
  toleranceSec = 1.5,
): boolean {
  const backing = cut.markers.filter(marker => marker.proxyClipId === cut.proxyClipId);
  if (cut.proxyClipId === undefined || backing.length === 0) {
    return false;
  }
  const wantedStartMs = Math.min(
    ...backing.map(marker => marker.startMs ?? marker.atMs),
  );
  const wantedEndMs = Math.max(...backing.map(marker => marker.atMs));
  const cutStartMs = video.startedAtMs + cut.range.startSec * 1000;
  const cutEndMs = video.startedAtMs + cut.range.endSec * 1000;
  const slackMs = toleranceSec * 1000;
  return cutStartMs <= wantedStartMs + slackMs && cutEndMs >= wantedEndMs - slackMs;
}
