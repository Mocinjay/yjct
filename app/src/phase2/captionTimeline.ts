import type { CaptionBurnStyle } from './captionStyles';

/**
 * Caption timing — when each caption is on screen and when each word inside it
 * lights up.
 *
 * This is the on-device port of `server/captioning/captions.py`. It lives in
 * TypeScript rather than in the native module on purpose: the rules below are
 * the part that is easy to get subtly wrong, so they belong somewhere testable
 * without a device, and the native side stays dumb — it draws what it is told.
 *
 * The server implementation is kept in step as the Android fallback. If you
 * change a rule here, change it there.
 */

/** How long a caption lingers after its last word finishes. */
export const CAPTION_HOLD_SECONDS = 0.12;
/** Floor for a caption that would otherwise flash by (one fast word). */
export const MIN_VISIBLE_SECONDS = 0.3;

/** One word as the recognizer heard it, in seconds from the start of the clip. */
export interface TimedWord {
  text: string;
  start: number;
  end: number;
}

/** A word as drawn, with the window during which it is the live one. */
export interface CaptionCueWord {
  text: string;
  /** Null for styles that do not track the spoken word. */
  highlightStart: number | null;
  highlightEnd: number | null;
}

/**
 * One caption on screen. Maps 1:1 onto a layer in the burner: the cue is a
 * container shown for [startSec, endSec), and each word that carries a
 * highlight window gets an overlay revealed for exactly that window.
 */
export interface CaptionCue {
  startSec: number;
  endSec: number;
  /** Pre-wrapped lines. The burner does no layout of its own. */
  lines: CaptionCueWord[][];
}

interface Chunk {
  start: number;
  end: number;
  words: TimedWord[];
}

/**
 * Split multi-word recognizer segments into one entry per word.
 *
 * Speech does not promise a segment per word — it returns whatever unit it
 * settled on, so "to listen and" arrives as a single timed entry. Chunking
 * counts entries, not words, so a `maxWords: 3` caption could come out five
 * words long and wrap onto a second line. Splitting first is what makes the
 * word count mean what it says.
 *
 * Timings inside a phrase are unknown, so each word gets a share of the span
 * proportional to its length. That is an estimate — but the highlight only has
 * to keep pace with the voice, and a phrase is short enough that the drift is
 * well under a syllable.
 */
export function splitPhrases(words: TimedWord[]): TimedWord[] {
  const out: TimedWord[] = [];
  for (const word of words) {
    const parts = word.text.split(/\s+/).filter(part => part.length > 0);
    if (parts.length <= 1) {
      // Preserve the original text: a zero-part entry is whitespace only and
      // has nothing to draw.
      if (parts.length === 1) {
        out.push({ ...word, text: parts[0] });
      }
      continue;
    }
    const total = parts.reduce((sum, part) => sum + part.length, 0);
    const span = Math.max(0, word.end - word.start);
    let at = word.start;
    parts.forEach((part, i) => {
      // The last word ends exactly on the phrase's end, so rounding never
      // leaves a sliver of dead time before the next caption.
      const end = i === parts.length - 1 ? word.end : at + (span * part.length) / total;
      out.push({ text: part, start: at, end });
      at = end;
    });
  }
  return out;
}

/** The whole pipeline: recognized words → drawable, timed captions. */
export function buildCaptionCues(
  words: TimedWord[],
  style: CaptionBurnStyle,
): CaptionCue[] {
  return chunkWords(splitPhrases(words), style).map(chunk => toCue(chunk, style));
}

/**
 * Group words into on-screen captions.
 *
 * Each chunk keeps its individual word timings — that is what the per-word
 * highlight is driven from.
 */
export function chunkWords(words: TimedWord[], style: CaptionBurnStyle): Chunk[] {
  const chunks: Chunk[] = [];
  let current: TimedWord[] = [];
  for (const word of words) {
    if (
      current.length > 0 &&
      (current.length >= style.maxWords ||
        word.end - current[0].start > style.maxSeconds ||
        // A silence this long ends the caption rather than leaving it hanging.
        word.start - current[current.length - 1].end > style.maxGap)
    ) {
      chunks.push(close(current, style));
      current = [];
    }
    current.push(word);
  }
  if (current.length > 0) {
    chunks.push(close(current, style));
  }
  return applyHold(chunks);
}

function close(words: TimedWord[], style: CaptionBurnStyle): Chunk {
  const cased = words.map(w => ({
    start: w.start,
    end: w.end,
    text: style.uppercase ? w.text.toUpperCase() : w.text,
  }));
  return {
    start: cased[0].start,
    end: cased[cased.length - 1].end,
    words: cased,
  };
}

function applyHold(chunks: Chunk[]): Chunk[] {
  return chunks.map((chunk, i) => {
    let end = chunk.end + CAPTION_HOLD_SECONDS;
    if (end - chunk.start < MIN_VISIBLE_SECONDS) {
      end = chunk.start + MIN_VISIBLE_SECONDS;
    }
    if (i + 1 < chunks.length) {
      // Never let a caption outlive the next one's entrance — two captions
      // on screen at once render on top of each other.
      end = Math.min(end, chunks[i + 1].start);
    }
    return { ...chunk, end: Math.max(end, chunk.start + 0.01) };
  });
}

/**
 * When each word of a chunk is the highlighted one.
 *
 * A word stays lit until the *next* word starts, not until it stops being
 * spoken — otherwise the highlight blinks off in every pause between words.
 * The last word holds to the end of the caption.
 */
export function wordSpans(chunk: Chunk): Array<[number, number]> {
  return chunk.words.map((word, i) => {
    const start = i === 0 ? chunk.start : word.start;
    const next = chunk.words[i + 1];
    const end = next ? next.start : chunk.end;
    return [start, Math.max(end, start)] as [number, number];
  });
}

/**
 * Break a chunk into display lines, as lists of word indices.
 *
 * Computed once per chunk. The burner reuses this layout for the whole time
 * the caption is up; re-wrapping per word is what makes highlighted captions
 * judder as the line reflows.
 */
export function layoutLines(chunk: Chunk, style: CaptionBurnStyle): number[][] {
  const lines: number[][] = [];
  let current: number[] = [];
  let width = 0;
  chunk.words.forEach((word, i) => {
    const length = word.text.length;
    if (current.length > 0 && width + 1 + length > style.maxChars) {
      lines.push(current);
      current = [];
      width = 0;
    }
    current.push(i);
    width += length + (width > 0 ? 1 : 0);
  });
  if (current.length > 0) {
    lines.push(current);
  }
  return lines;
}

function toCue(chunk: Chunk, style: CaptionBurnStyle): CaptionCue {
  const spans = wordSpans(chunk);
  const tracks = style.highlightColor !== null;
  return {
    startSec: chunk.start,
    endSec: chunk.end,
    lines: layoutLines(chunk, style).map(line =>
      line.map(index => ({
        text: chunk.words[index].text,
        highlightStart: tracks ? spans[index][0] : null,
        highlightEnd: tracks ? spans[index][1] : null,
      })),
    ),
  };
}
