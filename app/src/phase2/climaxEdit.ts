import type { CaptionBurnStyle } from './captionStyles';
import type { CaptionCue, TimedWord } from './captionTimeline';
import { buildCaptionCues } from './captionTimeline';

/**
 * The climax-first edit plan and, more importantly, what it does to the
 * caption timeline.
 *
 *     [best 3-7s] -> [0.5s black] -> [complete original]
 *
 * The hook is a *second* copy of a stretch that also appears later in the
 * body, so a word inside it is spoken twice on the output timeline. Captions
 * therefore cannot be burned before the edit: they would be laid out for the
 * chronological timeline, and copying a slice of that to the front opens the
 * hook mid-phrase on whatever cue happened to straddle the cut.
 *
 * Instead the words are mapped through the edit first and captions are built
 * on the output timeline, per segment, so a caption can never span a cut.
 */

/** Matches TRANSITION_SECONDS in server/climax/editor.py. */
export const TRANSITION_SECONDS = 0.5;

export interface ClimaxPlan {
  /** Winning window in the source, from the scorer. */
  hookStart: number;
  hookEnd: number;
  sourceDuration: number;
  transitionSeconds?: number;
}

export interface EditSegment {
  /** Source range, or null for the generated black gap. */
  source: { start: number; end: number } | null;
  outputStart: number;
  outputEnd: number;
}

/**
 * The output timeline as a list of segments. The native side inserts exactly
 * these into an AVMutableComposition — the black gap is an empty time range
 * rather than generated footage.
 */
export function planSegments(plan: ClimaxPlan): EditSegment[] {
  const transition = plan.transitionSeconds ?? TRANSITION_SECONDS;
  const hookStart = Math.max(0, Math.min(plan.hookStart, plan.sourceDuration));
  const hookEnd = Math.max(hookStart, Math.min(plan.hookEnd, plan.sourceDuration));
  const hookLength = hookEnd - hookStart;

  if (hookLength <= 0 || plan.sourceDuration <= 0) {
    // Nothing worth hooking: ship the original untouched rather than emitting
    // a zero-length cut and a black frame.
    return [
      {
        source: { start: 0, end: plan.sourceDuration },
        outputStart: 0,
        outputEnd: plan.sourceDuration,
      },
    ];
  }

  return [
    {
      source: { start: hookStart, end: hookEnd },
      outputStart: 0,
      outputEnd: hookLength,
    },
    {
      source: null,
      outputStart: hookLength,
      outputEnd: hookLength + transition,
    },
    {
      source: { start: 0, end: plan.sourceDuration },
      outputStart: hookLength + transition,
      outputEnd: hookLength + transition + plan.sourceDuration,
    },
  ];
}

export function outputDuration(segments: EditSegment[]): number {
  return segments.length === 0 ? 0 : segments[segments.length - 1].outputEnd;
}

/**
 * Words as they land on the output timeline.
 *
 * A word belongs to a segment when its midpoint falls inside that segment's
 * source range — the same half-open rule the scorer uses, so a word straddling
 * the hook boundary is counted once rather than shown clipped at both ends.
 * Words inside the hook legitimately appear twice, once per segment.
 */
export function mapWordsThroughEdit(
  words: TimedWord[],
  segments: EditSegment[],
): TimedWord[] {
  const mapped: TimedWord[] = [];
  for (const segment of segments) {
    if (segment.source === null) {
      continue; // black gap carries no captions
    }
    const shift = segment.outputStart - segment.source.start;
    for (const word of words) {
      const mid = (word.start + word.end) / 2;
      if (mid < segment.source.start || mid >= segment.source.end) {
        continue;
      }
      mapped.push({
        text: word.text,
        // Clamped so a word running past the cut cannot spill into the next
        // segment's captions.
        start: Math.max(segment.outputStart, word.start + shift),
        end: Math.min(segment.outputEnd, word.end + shift),
      });
    }
  }
  return mapped.sort((a, b) => a.start - b.start);
}

/**
 * Captions for the finished cut.
 *
 * Built per segment and concatenated, so a caption can never span a cut: a
 * chunk that ran across the hook boundary would appear half-finished in the
 * hook and half-started in the body.
 */
export function buildClimaxCaptionCues(
  words: TimedWord[],
  segments: EditSegment[],
  style: CaptionBurnStyle,
): CaptionCue[] {
  const cues: CaptionCue[] = [];
  for (const segment of segments) {
    if (segment.source === null) {
      continue;
    }
    const local = mapWordsThroughEdit(words, [segment]);
    for (const cue of buildCaptionCues(local, style)) {
      // The caption hold can push past the cut; clamp it back so nothing is
      // still on screen when the next segment starts.
      const endSec = Math.min(cue.endSec, segment.outputEnd);
      if (endSec <= cue.startSec) {
        continue;
      }
      cues.push({
        ...cue,
        endSec,
        lines: cue.lines.map(line =>
          line.map(word => ({
            ...word,
            highlightEnd:
              word.highlightEnd === null
                ? null
                : Math.min(word.highlightEnd, endSec),
          })),
        ),
      });
    }
  }
  return cues;
}
