import { CAPTION_STYLES, captionStylePreset } from '../src/phase2/captionStyles';
import type { CaptionBurnStyle } from '../src/phase2/captionStyles';
import type { CaptionCue, TimedWord } from '../src/phase2/captionTimeline';
import {
  buildCaptionCues,
  chunkWords,
  layoutLines,
  splitPhrases,
  wordSpans,
} from '../src/phase2/captionTimeline';

/**
 * The on-device port of server/captioning/captions.py. These are the same
 * invariants as test_captions.py — if the two implementations ever drift, one
 * of the two suites fails.
 */

const CLASSIC = captionStylePreset('classic').burn;
const CLEAN = captionStylePreset('clean').burn;
const BOXED = captionStylePreset('boxed').burn;
const ALL: CaptionBurnStyle[] = CAPTION_STYLES.map(s => s.burn);
const TRACKING = [CLASSIC, BOXED];

function words(...spec: Array<[string, number, number]>): TimedWord[] {
  return spec.map(([text, start, end]) => ({ text, start, end }));
}

const SPEECH = words(
  ['this', 0.0, 0.3],
  ['happened', 0.32, 0.8],
  ['at', 0.84, 0.95],
  ['a', 0.97, 1.05],
  ['public', 1.08, 1.6],
  ['beach', 1.65, 2.1],
  // A pause long enough that the caption should not hang through it.
  ['unbelievable', 4.0, 4.9],
);

/** Every word of a cue, in reading order. */
function flat(cue: CaptionCue) {
  return cue.lines.flat();
}

describe('chunking', () => {
  it('never starts a caption before its first word', () => {
    for (const style of ALL) {
      for (const chunk of chunkWords(SPEECH, style)) {
        expect(chunk.start).toBeCloseTo(chunk.words[0].start);
      }
    }
  });

  it('never lets one caption outlive the next one', () => {
    for (const style of ALL) {
      const cues = buildCaptionCues(SPEECH, style);
      cues.slice(1).forEach((cue, i) => {
        expect(cues[i].endSec).toBeLessThanOrEqual(cue.startSec);
      });
    }
  });

  it('ends the caption on a long silence instead of hanging through it', () => {
    const cues = buildCaptionCues(SPEECH, CLASSIC);
    const last = cues[cues.length - 1];
    expect(flat(last).map(w => w.text)).toEqual(['UNBELIEVABLE']);
    expect(cues[cues.length - 2].endSec).toBeLessThan(4.0);
  });

  it('honours the per-style word limit', () => {
    for (const style of ALL) {
      for (const chunk of chunkWords(SPEECH, style)) {
        expect(chunk.words.length).toBeLessThanOrEqual(style.maxWords);
      }
    }
  });

  it('keeps a single fast word on screen long enough to read', () => {
    const [cue] = buildCaptionCues(words(['go', 0, 0.05]), CLASSIC);
    expect(cue.endSec - cue.startSec).toBeGreaterThanOrEqual(0.29);
  });

  it('cases the text according to the style', () => {
    expect(flat(buildCaptionCues(SPEECH, CLASSIC)[0])[0].text).toBe('THIS');
    expect(flat(buildCaptionCues(SPEECH, CLEAN)[0])[0].text).toBe('this');
  });

  it('produces nothing for silence', () => {
    expect(buildCaptionCues([], CLASSIC)).toEqual([]);
  });
});

describe('word sync', () => {
  it('lights the word that is being spoken', () => {
    for (const style of TRACKING) {
      for (const cue of buildCaptionCues(SPEECH, style)) {
        for (const word of flat(cue)) {
          expect(word.highlightStart).not.toBeNull();
        }
      }
      // Every original word's midpoint must fall inside its own span.
      for (const chunk of chunkWords(SPEECH, style)) {
        const spans = wordSpans(chunk);
        chunk.words.forEach((word, i) => {
          const midpoint = (word.start + word.end) / 2;
          expect(midpoint).toBeGreaterThanOrEqual(spans[i][0]);
          expect(midpoint).toBeLessThan(spans[i][1]);
        });
      }
    }
  });

  it('holds the highlight through the gap between words', () => {
    const chunk = chunkWords(SPEECH, CLASSIC)[0];
    const spans = wordSpans(chunk);
    spans.slice(1).forEach((span, i) => {
      // No dead air between one word's span and the next's.
      expect(spans[i][1]).toBe(span[0]);
    });
  });

  it('keeps the last word lit until the caption leaves', () => {
    const chunk = chunkWords(SPEECH, CLASSIC)[0];
    const spans = wordSpans(chunk);
    expect(spans[spans.length - 1][1]).toBe(chunk.end);
  });

  it('covers the caption with no gaps and no overlaps', () => {
    for (const style of TRACKING) {
      for (const cue of buildCaptionCues(SPEECH, style)) {
        const spans = flat(cue).map(w => [w.highlightStart!, w.highlightEnd!]);
        expect(spans[0][0]).toBe(cue.startSec);
        expect(spans[spans.length - 1][1]).toBe(cue.endSec);
        spans.slice(1).forEach((span, i) => {
          expect(spans[i][1]).toBe(span[0]);
        });
      }
    }
  });

  it('leaves words untracked for a style that does not highlight', () => {
    for (const cue of buildCaptionCues(SPEECH, CLEAN)) {
      for (const word of flat(cue)) {
        expect(word.highlightStart).toBeNull();
        expect(word.highlightEnd).toBeNull();
      }
    }
  });

  it('never shows a highlight outside its own caption', () => {
    for (const style of TRACKING) {
      for (const cue of buildCaptionCues(SPEECH, style)) {
        for (const word of flat(cue)) {
          expect(word.highlightStart!).toBeGreaterThanOrEqual(cue.startSec);
          expect(word.highlightEnd!).toBeLessThanOrEqual(cue.endSec);
        }
      }
    }
  });
});

describe('layout', () => {
  it('lays every word out exactly once', () => {
    for (const style of ALL) {
      for (const chunk of chunkWords(SPEECH, style)) {
        const indices = layoutLines(chunk, style).flat();
        expect(indices).toEqual(chunk.words.map((_, i) => i));
      }
    }
  });

  it('wraps a caption that is too wide for one line', () => {
    const cue = buildCaptionCues(
      words(['extraordinarily', 0, 0.5], ['complicated', 0.5, 1.0]),
      CLASSIC,
    )[0];
    expect(cue.lines.length).toBeGreaterThan(1);
  });

  it('keeps every cue non-empty', () => {
    for (const style of ALL) {
      for (const cue of buildCaptionCues(SPEECH, style)) {
        expect(cue.lines.length).toBeGreaterThan(0);
        expect(flat(cue).length).toBeGreaterThan(0);
        expect(cue.endSec).toBeGreaterThan(cue.startSec);
      }
    }
  });
});

describe('splitPhrases', () => {
  it('splits a multi-word recognizer segment across its own span', () => {
    // Speech returns whatever unit it settled on, not one word per segment.
    const split = splitPhrases([{ text: 'to listen and', start: 10, end: 10.9 }]);
    expect(split.map(w => w.text)).toEqual(['to', 'listen', 'and']);
    // Shares are proportional to length: 2/11, 6/11, 3/11 of 0.9s.
    expect(split[0].start).toBe(10);
    expect(split[1].start).toBeCloseTo(10 + 0.9 * (2 / 11));
    // The tail lands exactly on the segment's end, never a rounded-off sliver.
    expect(split[2].end).toBe(10.9);
  });

  it('leaves single words and their timings untouched', () => {
    const words: TimedWord[] = [{ text: 'hopefully', start: 1, end: 1.4 }];
    expect(splitPhrases(words)).toEqual(words);
  });

  it('makes maxWords count actual words', () => {
    // Two segments, four words. Without splitting this is one caption of
    // four; with it, maxWords: 3 breaks it where it should.
    const cues = buildCaptionCues(
      [
        { text: 'oh yeah', start: 0, end: 0.4 },
        { text: 'listen and', start: 0.4, end: 0.9 },
      ],
      CLASSIC,
    );
    expect(cues.flatMap(c => c.lines.flat()).map(w => w.text)).toEqual([
      'OH',
      'YEAH',
      'LISTEN',
      'AND',
    ]);
    expect(cues).toHaveLength(2);
  });
});

describe('parity with the server implementation', () => {
  it('uses the same chunking constants as captions.py', () => {
    // These four drive where captions break. server/captioning/captions.py
    // carries the same numbers; drift here is a silently different look
    // between the iOS burn and the Android fallback.
    expect([CLASSIC.maxWords, CLASSIC.maxSeconds, CLASSIC.maxGap, CLASSIC.maxChars])
      .toEqual([3, 1.2, 0.6, 12]);
    expect([CLEAN.maxWords, CLEAN.maxSeconds, CLEAN.maxGap, CLEAN.maxChars])
      .toEqual([5, 2.0, 0.8, 32]);
    expect([BOXED.maxWords, BOXED.maxSeconds, BOXED.maxGap, BOXED.maxChars])
      .toEqual([4, 1.6, 0.7, 26]);
  });

  it('only classic and boxed track the spoken word', () => {
    expect(CLASSIC.highlightColor).toBe('#FFD400');
    expect(BOXED.highlightColor).toBe('#FFD400');
    expect(CLEAN.highlightColor).toBeNull();
  });
});
