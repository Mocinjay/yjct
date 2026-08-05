import type { TimedWord } from '../captions/captionTimeline';

/**
 * Rolling-window hook scoring — the on-device port of
 * `server/climax/scoring_algorithm.py`.
 *
 * Turns a feature grid plus the words the recognizer already gave us into one
 * winning window and the breakdown of why it won.
 *
 * The maths, end to end
 * ---------------------
 * 1. CANDIDATES. Every (start, size) pair for size in `windowSizes` stepping by
 *    `stride`.
 * 2. RAW AGGREGATES. Each candidate reduces to means and *rates*, never sums —
 *    a 7s window must not out-score a 3s one merely by being longer.
 * 3. NORMALISATION. Min-max across the candidates *of this video*. The question
 *    is "which moment is the peak of this video", not "is this video loud". A
 *    constant signal maps to 0, never NaN.
 * 4. MODALITY SCORES. Normalised features averaged within each modality.
 * 5. HOOK SCORE. Weighted sum, times a mild size prior that breaks ties toward
 *    `preferredSize` without ever overriding a genuinely better window.
 * 6. CONFIDENCE. Not the score: `0.6*best + 0.4*margin`, where margin is how
 *    far the winner stands clear of the pack. Footage where nothing stands out
 *    reports low confidence even though some window still ranked first.
 *
 * Feature *extraction* is native (audio DSP, frame sampling); everything here
 * is arithmetic, which is why it lives in TS where it can be tested.
 */

/** Signals the native extractor produces, all on one uniform time grid. */
export const AUDIO_KEYS = [
  'audio.rms',
  'audio.flux',
  'audio.zcr',
  'audio.peaks',
] as const;
export const VISUAL_KEYS = [
  'visual.flow',
  'visual.frame_diff',
  'visual.scene_change',
] as const;
export const SPEECH_KEYS = [
  'speech.keyword_density',
  'speech.speaking_rate',
  'speech.repetition',
  'speech.emphasis',
] as const;

/**
 * Named signals on a uniform time grid. `times[i]` is the timestamp of sample
 * `i` for every signal, so all signals share length and alignment by
 * construction.
 */
export interface FeatureGrid {
  /** Seconds between samples. */
  hop: number;
  times: number[];
  duration: number;
  signals: Record<string, number[]>;
}

export interface ScoringWeights {
  audio: number;
  visual: number;
  speech: number;
  novelty: number;
}

export interface ScoringConfig {
  windowSizes: number[];
  preferredSize: number;
  stride: number;
  weights: ScoringWeights;
  /** Seconds of preceding footage a window is contrasted against. */
  contextSeconds: number;
  /**
   * How hard to favour `preferredSize`. 0.05 docks the least-preferred size by
   * 5% — enough to break ties, never enough to beat a real winner.
   */
  sizePreference: number;
}

export interface HookWindow {
  start: number;
  end: number;
  confidence: number;
  score: number;
  /** Per-modality breakdown. */
  reason: Record<string, number>;
  /** Per-signal breakdown, so a bad pick is diagnosable rather than guessed at. */
  detail: Record<string, number>;
}

export const DEFAULT_WEIGHTS: ScoringWeights = {
  audio: 0.35,
  visual: 0.25,
  speech: 0.25,
  novelty: 0.15,
};

export const DEFAULT_SCORING: ScoringConfig = {
  windowSizes: [3, 4, 5, 6, 7],
  preferredSize: 4,
  stride: 0.5,
  weights: DEFAULT_WEIGHTS,
  contextSeconds: 5,
  sizePreference: 0.05,
};

/**
 * Words that carry excitement across a lot of spoken content. Deliberately
 * short and general — this is a density signal, not classification, so recall
 * matters more than precision and a few false hits wash out in normalisation.
 */
export const DEFAULT_KEYWORDS = new Set(
  `wow whoa woah oh omg god damn holy insane crazy nuts wild sick
   yes yeah yo let go goes going come on
   no way what how did dude bro man
   look watch see there here now
   best worst first last finally actually literally
   huge massive biggest crazy unreal ridiculous perfect
   win won winning lost lose beat
   stop wait hold`.split(/\s+/).filter(Boolean),
);

/** Three or more of the same letter in a row: "yesss", "nooo", "ahhh". */
const ELONGATION = /(.)\1{2,}/i;

export function normaliseWeights(w: ScoringWeights): ScoringWeights {
  const total = w.audio + w.visual + w.speech + w.novelty;
  if (total <= 0) {
    throw new Error('scoring weights must sum to a positive number');
  }
  return {
    audio: w.audio / total,
    visual: w.visual / total,
    speech: w.speech / total,
    novelty: w.novelty / total,
  };
}

/**
 * Speech weight redistributed proportionally across the rest.
 *
 * Silent footage would otherwise have a quarter of every window's score pinned
 * to the same constant zero, which is not a measurement of anything.
 */
export function weightsWithoutSpeech(w: ScoringWeights): ScoringWeights {
  const rest = w.audio + w.visual + w.novelty;
  if (rest <= 0) {
    throw new Error('cannot drop speech weight: nothing left to carry it');
  }
  const share = w.speech / rest;
  return normaliseWeights({
    audio: w.audio * (1 + share),
    visual: w.visual * (1 + share),
    speech: 0,
    novelty: w.novelty * (1 + share),
  });
}

/**
 * Weights for whichever modalities this clip actually has.
 *
 * Glasses capture is routinely video-only — the toolkit exposes no microphone —
 * so "no audio at all" is a normal clip here, not an edge case. Zeroing an
 * absent modality and renormalising is exactly `weightsWithoutSpeech`
 * generalised (the algebra works out identical), and it is what stops a
 * missing modality from pinning a fixed fraction of every window's score to
 * the same zero.
 */
export function resolveWeights(
  w: ScoringWeights,
  present: { audio: boolean; visual: boolean; speech: boolean },
): ScoringWeights {
  return normaliseWeights({
    audio: present.audio ? w.audio : 0,
    visual: present.visual ? w.visual : 0,
    speech: present.speech ? w.speech : 0,
    novelty: w.novelty,
  });
}

/** Min-max to [0, 1]. A constant signal maps to all-zeros, not NaN. */
export function minmax(values: number[]): number[] {
  if (values.length === 0) {
    return [];
  }
  let lo = Infinity;
  let hi = -Infinity;
  for (const v of values) {
    if (v < lo) {
      lo = v;
    }
    if (v > hi) {
      hi = v;
    }
  }
  if (!isFinite(lo) || !isFinite(hi) || hi - lo < 1e-12) {
    return values.map(() => 0);
  }
  return values.map(v => (v - lo) / (hi - lo));
}

/** numpy's linear-interpolation percentile, so the confidence maths matches. */
export function percentile(values: number[], q: number): number {
  if (values.length === 0) {
    return 0;
  }
  const sorted = [...values].sort((a, b) => a - b);
  if (sorted.length === 1) {
    return sorted[0];
  }
  const pos = (q / 100) * (sorted.length - 1);
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  if (lo === hi) {
    return sorted[lo];
  }
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (pos - lo);
}

function mean(values: number[]): number {
  if (values.length === 0) {
    return 0;
  }
  let sum = 0;
  for (const v of values) {
    sum += v;
  }
  return sum / values.length;
}

/** First index whose time is >= `t` (numpy searchsorted, side="left"). */
function searchSorted(times: number[], t: number): number {
  let lo = 0;
  let hi = times.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (times[mid] < t) {
      lo = mid + 1;
    } else {
      hi = mid;
    }
  }
  return lo;
}

/** Half-open sample index range covering [start, end). */
export function indexRange(grid: FeatureGrid, start: number, end: number): [number, number] {
  const lo = searchSorted(grid.times, start);
  const hi = searchSorted(grid.times, end);
  return [lo, Math.max(hi, lo)];
}

/**
 * Mean of every signal over a window; 0 for an empty slice. Means rather than
 * sums so a 3s and a 7s window stay comparable.
 */
export function windowMeans(
  grid: FeatureGrid,
  start: number,
  end: number,
): Record<string, number> {
  const [lo, hi] = indexRange(grid, start, end);
  const out: Record<string, number> = {};
  for (const name of Object.keys(grid.signals)) {
    const sig = grid.signals[name];
    if (hi <= lo) {
      out[name] = 0;
      continue;
    }
    let sum = 0;
    for (let i = lo; i < hi; i++) {
      sum += sig[i];
    }
    out[name] = sum / (hi - lo);
  }
  return out;
}

/** Typical word length for this speaker, used as the emphasis baseline. */
export function medianWordDuration(words: TimedWord[]): number {
  const durations = words
    .map(w => Math.max(0, w.end - w.start))
    .filter(d => d > 0)
    .sort((a, b) => a - b);
  if (durations.length === 0) {
    return 0;
  }
  const mid = durations.length >> 1;
  return durations.length % 2
    ? durations[mid]
    : (durations[mid - 1] + durations[mid]) / 2;
}

/** Words whose midpoint falls inside [start, end). */
export function wordsBetween(
  words: TimedWord[],
  start: number,
  end: number,
): TimedWord[] {
  return words.filter(w => {
    const mid = (w.start + w.end) / 2;
    return mid >= start && mid < end;
  });
}

/**
 * Excitement components for one window.
 *
 * Sentiment is deliberately not used: "this is terrible" and "this is
 * unbelievable" are opposite sentiment and identical excitement. Delivery —
 * how fast, how repetitive, how emphatic — tracks highlights far better.
 */
export function speechFeatures(
  words: TimedWord[],
  start: number,
  end: number,
  medianDuration = 0,
): Record<string, number> {
  const span = Math.max(1e-6, end - start);
  const inWindow = wordsBetween(words, start, end);
  if (inWindow.length === 0) {
    return {
      'speech.keyword_density': 0,
      'speech.speaking_rate': 0,
      'speech.repetition': 0,
      'speech.emphasis': 0,
    };
  }

  const tokens = inWindow
    .map(w => w.text.toLowerCase().replace(/[^\w']/g, ''))
    .filter(t => t.length > 0);

  const keywordHits = tokens.filter(t => DEFAULT_KEYWORDS.has(t)).length;

  // Consecutive identical tokens ("go go go", "no no no") — a much stronger
  // highlight cue than a word simply recurring somewhere in the window.
  let runs = 0;
  for (let i = 1; i < tokens.length; i++) {
    if (tokens[i] === tokens[i - 1]) {
      runs += 1;
    }
  }

  // Emphasis. Stretched delivery is the load-bearing source: "nooo waaay"
  // arrives from the recognizer as ordinary tokens with long word-level
  // timings, so duration catches emphasis the text has already normalised
  // away. Elongated spelling fires on real speech and never on TTS.
  //
  // Exclamation marks are not available here at all — Apple's Speech
  // framework gives per-word substrings with no punctuation, so the third
  // source the Python has is simply absent on this path rather than close to
  // always-zero as it is there.
  let stretched = 0;
  if (medianDuration > 0) {
    stretched = inWindow.filter(
      w => Math.max(0, w.end - w.start) > 1.5 * medianDuration,
    ).length;
  }
  const elongated = tokens.filter(t => ELONGATION.test(t)).length;

  return {
    'speech.keyword_density': keywordHits / span,
    'speech.speaking_rate': tokens.length / span,
    'speech.repetition': runs / span,
    'speech.emphasis': (stretched + elongated) / span,
  };
}

function candidates(config: ScoringConfig, duration: number): Array<[number, number]> {
  const out: Array<[number, number]> = [];
  for (const size of config.windowSizes) {
    if (size > duration) {
      continue;
    }
    let start = 0;
    // Inclusive of the final aligned window; the epsilon stops float drift
    // from dropping a legitimate last candidate.
    while (start + size <= duration + 1e-9) {
      out.push([round6(start), round6(size)]);
      start += config.stride;
    }
  }
  if (out.length === 0 && duration > 0) {
    // Shorter than the smallest window: score it whole rather than failing.
    // A 2-second clip is trivially its own climax.
    out.push([0, round6(duration)]);
  }
  return out;
}

function round6(v: number): number {
  return Math.round(v * 1e6) / 1e6;
}

/**
 * Mean absolute change against the preceding `contextSeconds`.
 *
 * Zero when there is no preceding footage: the opening of a video has nothing
 * to be novel *against*, and inventing a value there would be a guess dressed
 * as a measurement.
 */
function novelty(
  grid: FeatureGrid,
  normedGrid: Record<string, number[]>,
  config: ScoringConfig,
  start: number,
  size: number,
): number {
  const ctxStart = Math.max(0, start - config.contextSeconds);
  if (start - ctxStart < 0.5) {
    return 0;
  }
  const [loW, hiW] = indexRange(grid, start, start + size);
  const [loC, hiC] = indexRange(grid, ctxStart, start);
  if (hiW <= loW || hiC <= loC) {
    return 0;
  }
  const deltas: number[] = [];
  for (const name of Object.keys(normedGrid)) {
    const sig = normedGrid[name];
    let wSum = 0;
    for (let i = loW; i < hiW; i++) {
      wSum += sig[i];
    }
    let cSum = 0;
    for (let i = loC; i < hiC; i++) {
      cSum += sig[i];
    }
    deltas.push(Math.abs(wSum / (hiW - loW) - cSum / (hiC - loC)));
  }
  return deltas.length > 0 ? mean(deltas) : 0;
}

/** Every candidate window, best first. */
export function rankHooks(
  grid: FeatureGrid,
  words: TimedWord[],
  config: ScoringConfig = DEFAULT_SCORING,
): HookWindow[] {
  const cands = candidates(config, grid.duration);
  if (cands.length === 0) {
    throw new Error('no scoring windows fit inside the video');
  }

  const hasSpeech = words.length > 0;
  // A signal the extractor did not produce is absent, not zero. Dense optical
  // flow is skipped on device, and a video-only clip has no audio at all;
  // either way the modality is scored from what exists.
  const presentAudio = AUDIO_KEYS.filter(k => k in grid.signals);
  const presentVisual = VISUAL_KEYS.filter(k => k in grid.signals);
  const weights = resolveWeights(config.weights, {
    audio: presentAudio.length > 0,
    visual: presentVisual.length > 0,
    speech: hasSpeech,
  });

  // Grid signals normalised once, globally, so a window and its context are
  // measured on the same scale.
  const normedGrid: Record<string, number[]> = {};
  for (const name of Object.keys(grid.signals)) {
    normedGrid[name] = minmax(grid.signals[name]);
  }
  // Computed over the whole transcript, not per window: emphasis is "long for
  // THIS speaker", and a per-window median would drift with whatever happens
  // to be inside the window.
  const medWord = medianWordDuration(words);

  const raw: Record<string, number[]> = {};
  const noveltyRaw: number[] = [];
  for (const [start, size] of cands) {
    const end = start + size;
    const means = windowMeans(grid, start, end);
    for (const key of [...presentAudio, ...presentVisual]) {
      (raw[key] ??= []).push(means[key] ?? 0);
    }
    if (hasSpeech) {
      const feats = speechFeatures(words, start, end, medWord);
      for (const key of Object.keys(feats)) {
        (raw[key] ??= []).push(feats[key]);
      }
    }
    noveltyRaw.push(novelty(grid, normedGrid, config, start, size));
  }

  const normed: Record<string, number[]> = {};
  for (const key of Object.keys(raw)) {
    normed[key] = minmax(raw[key]);
  }
  const noveltyN = minmax(noveltyRaw);

  const modality = (keys: readonly string[], i: number): number => {
    const vals = keys.filter(k => k in normed).map(k => normed[k][i]);
    return vals.length > 0 ? mean(vals) : 0;
  };

  const sizeSpan =
    Math.max(...config.windowSizes) - Math.min(...config.windowSizes) || 1;

  const results: HookWindow[] = cands.map(([start, size], i) => {
    const a = modality(AUDIO_KEYS, i);
    const v = modality(VISUAL_KEYS, i);
    const s = hasSpeech ? modality(SPEECH_KEYS, i) : 0;
    const n = noveltyN[i];

    let score =
      weights.audio * a +
      weights.visual * v +
      weights.speech * s +
      weights.novelty * n;
    score *= 1 - config.sizePreference * (Math.abs(size - config.preferredSize) / sizeSpan);

    const detail: Record<string, number> = {};
    for (const key of Object.keys(normed)) {
      detail[key] = normed[key][i];
    }
    return {
      start,
      end: start + size,
      confidence: 0, // needs the distribution, filled in below
      score,
      reason: { audio: a, visual: v, speech: s, novelty: n },
      detail,
    };
  });

  const scores = results.map(r => r.score);
  const p50 = percentile(scores, 50);
  const p95 = percentile(scores, 95);
  const spread = Math.max(p95 - p50, 1e-9);
  for (const r of results) {
    const margin = clamp01((r.score - p50) / spread);
    r.confidence = clamp01(0.6 * r.score + 0.4 * margin);
  }

  results.sort((a, b) => b.score - a.score);
  return results;
}

function clamp01(v: number): number {
  return Math.min(1, Math.max(0, v));
}

export function findHook(
  grid: FeatureGrid,
  words: TimedWord[],
  config: ScoringConfig = DEFAULT_SCORING,
): HookWindow {
  return rankHooks(grid, words, config)[0];
}
