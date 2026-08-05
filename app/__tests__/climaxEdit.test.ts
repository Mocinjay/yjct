import { captionStylePreset } from '../src/phase2/captionStyles';
import type { TimedWord } from '../src/phase2/captionTimeline';
import {
  TRANSITION_SECONDS,
  buildClimaxCaptionCues,
  mapWordsThroughEdit,
  outputDuration,
  planSegments,
} from '../src/phase2/climaxEdit';

const CLASSIC = captionStylePreset('classic').burn;

function w(text: string, start: number, end: number): TimedWord {
  return { text, start, end };
}

const PLAN = { hookStart: 4, hookEnd: 7, sourceDuration: 30 };

describe('edit plan', () => {
  const segments = planSegments(PLAN);

  it('is hook, black, then the complete original', () => {
    expect(segments).toHaveLength(3);
    expect(segments[0].source).toEqual({ start: 4, end: 7 });
    expect(segments[1].source).toBeNull();
    expect(segments[2].source).toEqual({ start: 0, end: 30 });
  });

  it('lays the segments end to end with no gap or overlap', () => {
    expect(segments[0].outputStart).toBe(0);
    segments.slice(1).forEach((segment, i) => {
      expect(segments[i].outputEnd).toBeCloseTo(segment.outputStart, 9);
    });
  });

  it('runs hook + transition + full original long', () => {
    expect(outputDuration(segments)).toBeCloseTo(3 + TRANSITION_SECONDS + 30, 9);
  });

  it('keeps the original whole — the body is never trimmed', () => {
    const body = segments[2].source!;
    expect(body.end - body.start).toBe(PLAN.sourceDuration);
  });

  it('ships the original untouched when there is no usable hook', () => {
    const flat = planSegments({ hookStart: 5, hookEnd: 5, sourceDuration: 30 });
    expect(flat).toHaveLength(1);
    expect(flat[0].source).toEqual({ start: 0, end: 30 });
    expect(outputDuration(flat)).toBe(30);
  });

  it('clamps a hook that runs past the end of the source', () => {
    const segments2 = planSegments({ hookStart: 28, hookEnd: 40, sourceDuration: 30 });
    expect(segments2[0].source).toEqual({ start: 28, end: 30 });
  });
});

describe('mapping words through the edit', () => {
  const segments = planSegments(PLAN);
  const words = [
    w('before', 1.0, 1.4),
    w('hook', 4.5, 4.9),
    w('moment', 5.2, 5.8),
    w('after', 12.0, 12.5),
  ];
  const mapped = mapWordsThroughEdit(words, segments);

  it('shows a word inside the hook twice — once in the hook, once in the body', () => {
    expect(mapped.filter(m => m.text === 'hook')).toHaveLength(2);
    expect(mapped.filter(m => m.text === 'before')).toHaveLength(1);
  });

  it('rebases the hook copy to the front of the output', () => {
    const [first] = mapped.filter(m => m.text === 'hook');
    expect(first.start).toBeCloseTo(0.5, 9); // 4.5 - 4.0
  });

  it('offsets the body by the hook plus the transition', () => {
    const body = mapped.filter(m => m.text === 'before')[0];
    expect(body.start).toBeCloseTo(1.0 + 3 + TRANSITION_SECONDS, 9);
  });

  it('returns words in output order', () => {
    mapped.slice(1).forEach((word, i) => {
      expect(mapped[i].start).toBeLessThanOrEqual(word.start);
    });
  });

  it('puts nothing on the black gap', () => {
    const gap = segments[1];
    for (const word of mapped) {
      const mid = (word.start + word.end) / 2;
      expect(mid >= gap.outputStart && mid < gap.outputEnd).toBe(false);
    }
  });

  it('never lets a word spill past its own segment', () => {
    for (const segment of segments) {
      if (segment.source === null) {
        continue;
      }
      for (const word of mapWordsThroughEdit(words, [segment])) {
        expect(word.start).toBeGreaterThanOrEqual(segment.outputStart);
        expect(word.end).toBeLessThanOrEqual(segment.outputEnd);
      }
    }
  });
});

describe('captions for the finished cut', () => {
  const segments = planSegments(PLAN);
  // Dense speech through the hook so a caption would naturally run over the cut.
  const words: TimedWord[] = [];
  for (let i = 0; i < 40; i++) {
    words.push(w(`word${i}`, 0.5 * i, 0.5 * i + 0.4));
  }
  const cues = buildClimaxCaptionCues(words, segments, CLASSIC);

  it('captions the hook as well as the body', () => {
    const hookCues = cues.filter(c => c.endSec <= 3.0001);
    expect(hookCues.length).toBeGreaterThan(0);
  });

  it('never lets a caption span a cut', () => {
    for (const cue of cues) {
      const segment = segments.find(
        s => cue.startSec >= s.outputStart && cue.startSec < s.outputEnd,
      );
      expect(segment).toBeDefined();
      expect(cue.endSec).toBeLessThanOrEqual(segment!.outputEnd + 1e-9);
    }
  });

  it('shows nothing during the black transition', () => {
    const gap = segments[1];
    for (const cue of cues) {
      const overlaps = cue.startSec < gap.outputEnd && cue.endSec > gap.outputStart;
      expect(overlaps).toBe(false);
    }
  });

  it('keeps every cue non-empty and ordered', () => {
    cues.forEach((cue, i) => {
      expect(cue.endSec).toBeGreaterThan(cue.startSec);
      expect(cue.lines.flat().length).toBeGreaterThan(0);
      if (i > 0) {
        expect(cues[i - 1].startSec).toBeLessThanOrEqual(cue.startSec);
      }
    });
  });

  it('keeps every highlight inside its own cue', () => {
    for (const cue of cues) {
      for (const word of cue.lines.flat()) {
        if (word.highlightStart === null || word.highlightEnd === null) {
          continue;
        }
        expect(word.highlightStart).toBeGreaterThanOrEqual(cue.startSec);
        expect(word.highlightEnd).toBeLessThanOrEqual(cue.endSec + 1e-9);
      }
    }
  });

  it('captions an unhooked clip exactly as the plain pipeline would', () => {
    const flat = planSegments({ hookStart: 0, hookEnd: 0, sourceDuration: 30 });
    const flatCues = buildClimaxCaptionCues(words, flat, CLASSIC);
    expect(flatCues[0].startSec).toBeCloseTo(0, 9);
    expect(flatCues.length).toBeGreaterThan(0);
  });
});
