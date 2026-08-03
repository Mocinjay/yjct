"""Rolling-window Hook Scoring.

Turns a `FeatureGrid` plus a `Transcript` into one winning window and a full
breakdown of why it won.

The maths, end to end
---------------------
1. CANDIDATES. Every (start, size) pair for size in `window_sizes` and start
   stepping by `stride` is a candidate. Defaults give 3/4/5/6/7-second windows
   every 0.5s.

2. RAW AGGREGATES. Each candidate reduces to a handful of scalars — mean RMS,
   mean flow, peak *rate*, words per second, and so on. Rates and means, never
   sums: a 7s window must not out-score a 3s window merely by being longer.

3. NORMALISATION. Each raw feature is min-max scaled across all candidates:

       norm = (x - min) / (max - min)

   This is deliberately *relative to this video*. A quiet vlog and a stadium
   crowd both yield a 1.0 top window, because the question is "which moment in
   THIS video is the peak", not "is this video loud". The cost is that a video
   with no real peak still produces a 1.0 — which is exactly what `confidence`
   exists to expose (step 6). Constant signals normalise to 0.0, never NaN.

4. MODALITY SCORES. Normalised features are averaged within each modality:

       audio    = mean(rms, flux, zcr, peak_rate)
       visual   = mean(flow, frame_diff, scene_change)
       speech   = mean(keyword_density, speaking_rate, repetition, emphasis)
       novelty  = mean |window_norm - preceding_context_norm| over all signals

5. HOOK SCORE. Weighted sum, weights summing to 1:

       hook = w_a*audio + w_v*visual + w_s*speech + w_n*novelty

   then multiplied by a mild size prior that nudges ties toward
   `preferred_size` without ever overriding a genuinely better window.

   With no speech at all, the speech weight is redistributed across the other
   three in proportion rather than scoring every window 0 — otherwise silent
   footage would have 25% of its score pinned to a constant.

6. CONFIDENCE. Not the same thing as the score:

       margin     = (best - p50) / (p95 - p50)      clipped to [0, 1]
       confidence = 0.6*best + 0.4*margin

   `best` says how strong the winner is; `margin` says how far it stands clear
   of the pack. A video where everything scores alike gives a high `best` but a
   low `margin`, so confidence drops — which is the honest answer.
"""
from __future__ import annotations

import logging
import math
import re
from dataclasses import asdict, dataclass, field
from typing import Any, Dict, List, Optional, Protocol, Sequence

import numpy as np

from audio_vision_engine import FeatureGrid
from transcriber import Transcript

log = logging.getLogger(__name__)

# Words that carry excitement across a lot of spoken content. Deliberately
# short and general — this is a density signal, not classification, so recall
# matters more than precision and a few false hits wash out in normalisation.
DEFAULT_KEYWORDS = frozenset("""
wow whoa woah oh omg god damn holy insane crazy nuts wild sick
yes yeah yo let go goes going come on
no way what how did dude bro man
look watch see there here now
best worst first last finally actually literally
huge massive biggest crazy unreal ridiculous perfect
win won winning lost lose beat
stop wait hold
""".split())

# Three or more of the same letter in a row: "yesss", "nooo", "ahhh".
ELONGATION_RE = re.compile(r"(.)\1{2,}", re.IGNORECASE)


@dataclass(frozen=True)
class ScoringWeights:
    """Modality weights. Need not sum to 1 — they are normalised on use."""

    audio: float = 0.35
    visual: float = 0.25
    speech: float = 0.25
    novelty: float = 0.15

    def normalised(self) -> "ScoringWeights":
        total = self.audio + self.visual + self.speech + self.novelty
        if total <= 0:
            raise ValueError("scoring weights must sum to a positive number")
        return ScoringWeights(
            audio=self.audio / total,
            visual=self.visual / total,
            speech=self.speech / total,
            novelty=self.novelty / total,
        )

    def without_speech(self) -> "ScoringWeights":
        """Speech weight redistributed proportionally across the rest."""
        rest = self.audio + self.visual + self.novelty
        if rest <= 0:
            raise ValueError("cannot drop speech weight: nothing left to carry it")
        share = self.speech / rest
        return ScoringWeights(
            audio=self.audio * (1 + share),
            visual=self.visual * (1 + share),
            speech=0.0,
            novelty=self.novelty * (1 + share),
        ).normalised()


@dataclass(frozen=True)
class ScoringConfig:
    window_sizes: Sequence[float] = (3.0, 4.0, 5.0, 6.0, 7.0)
    preferred_size: float = 4.0
    stride: float = 0.5
    weights: ScoringWeights = field(default_factory=ScoringWeights)
    # Seconds of preceding footage a window is contrasted against for novelty.
    context_seconds: float = 5.0
    # How hard to favour `preferred_size`. 0.05 means the least-preferred size
    # is docked 5% — enough to break ties, never enough to beat a real winner.
    size_preference: float = 0.05


@dataclass
class HookWindow:
    """The result, including the breakdown that makes tuning possible."""

    start: float
    end: float
    confidence: float
    score: float
    reason: Dict[str, float] = field(default_factory=dict)
    detail: Dict[str, float] = field(default_factory=dict)

    @property
    def duration(self) -> float:
        return self.end - self.start

    def to_dict(self) -> Dict[str, Any]:
        return {
            "start": round(self.start, 3),
            "end": round(self.end, 3),
            "confidence": round(self.confidence, 4),
            "score": round(self.score, 4),
            "reason": {k: round(v, 4) for k, v in self.reason.items()},
            "detail": {k: round(v, 4) for k, v in self.detail.items()},
        }


class Scorer(Protocol):
    """Swap point for an entirely different scoring engine."""

    def rank(self, grid: FeatureGrid, transcript: Transcript) -> List[HookWindow]: ...


def _minmax(values: np.ndarray) -> np.ndarray:
    """Min-max to [0, 1]. A constant signal maps to all-zeros, not NaN."""
    if values.size == 0:
        return values
    lo = float(np.min(values))
    hi = float(np.max(values))
    if not math.isfinite(lo) or not math.isfinite(hi) or hi - lo < 1e-12:
        return np.zeros_like(values)
    return (values - lo) / (hi - lo)


def median_word_duration(transcript: Transcript) -> float:
    """Typical word length for this speaker, used as the emphasis baseline."""
    durations = [w.duration for w in transcript.words if w.duration > 0]
    return float(np.median(durations)) if durations else 0.0


def speech_features(
    transcript: Transcript,
    start: float,
    end: float,
    median_duration: float = 0.0,
) -> Dict[str, float]:
    """Excitement components for one window.

    Sentiment is deliberately not used: "this is terrible" and "this is
    unbelievable" are opposite sentiment and identical excitement. Delivery —
    how fast, how repetitive, how emphatic — tracks highlights far better.
    """
    span = max(1e-6, end - start)
    words = transcript.words_between(start, end)
    if not words:
        return {
            "speech.keyword_density": 0.0,
            "speech.speaking_rate": 0.0,
            "speech.repetition": 0.0,
            "speech.emphasis": 0.0,
        }

    tokens = [re.sub(r"[^\w']", "", w.text.lower()) for w in words]
    tokens = [t for t in tokens if t]

    keyword_hits = sum(1 for t in tokens if t in DEFAULT_KEYWORDS)

    # Repetition: consecutive identical tokens ("go go go", "no no no"), which
    # is a much stronger highlight cue than a word simply recurring in a window.
    runs = 0
    for i in range(1, len(tokens)):
        if tokens[i] == tokens[i - 1]:
            runs += 1

    # Emphasis. Three sources, because no single one is reliable:
    #
    #  - Stretched delivery: words held longer than this speaker's median. This
    #    is the load-bearing one. "Nooo waaay" arrives from whisper as ordinary
    #    tokens with long word-level timings, so duration catches emphasis that
    #    the text has already normalised away.
    #  - Elongated spelling ("yesss") — fires on real speech, never on TTS.
    #  - Exclamation marks. Kept, but weak: whisper's smaller models punctuate
    #    almost entirely with periods, so on `base` this is close to always
    #    zero. Verified on a clip where "Oh my God!" transcribed as "Oh my God."
    #
    # Relying on the last two alone left this component permanently 0, which
    # silently removed a quarter of the speech score.
    stretched = 0
    if median_duration > 0:
        stretched = sum(1 for w in words if w.duration > 1.5 * median_duration)
    elongated = sum(1 for t in tokens if ELONGATION_RE.search(t))
    bangs = sum(
        s.text.count("!") for s in transcript.segments_overlapping(start, end)
    )

    return {
        "speech.keyword_density": keyword_hits / span,
        "speech.speaking_rate": len(tokens) / span,
        "speech.repetition": runs / span,
        "speech.emphasis": (stretched + elongated + bangs) / span,
    }


class HookScorer:
    """Default multimodal scorer."""

    AUDIO_KEYS = ("audio.rms", "audio.flux", "audio.zcr", "audio.peaks")
    VISUAL_KEYS = ("visual.flow", "visual.frame_diff", "visual.scene_change")
    SPEECH_KEYS = (
        "speech.keyword_density",
        "speech.speaking_rate",
        "speech.repetition",
        "speech.emphasis",
    )

    def __init__(self, config: Optional[ScoringConfig] = None) -> None:
        self.config = config or ScoringConfig()

    # -- candidate enumeration -------------------------------------------

    def _candidates(self, duration: float) -> List[tuple]:
        cfg = self.config
        out: List[tuple] = []
        for size in cfg.window_sizes:
            if size > duration:
                continue
            start = 0.0
            # Inclusive of the final aligned window; the epsilon stops float
            # drift from dropping a legitimate last candidate.
            while start + size <= duration + 1e-9:
                out.append((round(start, 6), round(size, 6)))
                start += cfg.stride
        if not out and duration > 0:
            # Video shorter than the smallest window: score it whole rather
            # than failing. A 2-second clip is trivially its own climax.
            out.append((0.0, round(duration, 6)))
        return out

    # -- novelty ----------------------------------------------------------

    def _novelty(
        self,
        grid: FeatureGrid,
        normed: Dict[str, np.ndarray],
        start: float,
        size: float,
    ) -> float:
        """Mean absolute change against the preceding `context_seconds`.

        Zero when there is no preceding footage: the opening of a video has
        nothing to be novel *against*, and inventing a value there would be a
        guess dressed as a measurement.
        """
        ctx_start = start - self.config.context_seconds
        if ctx_start < 0:
            ctx_start = 0.0
        if start - ctx_start < 0.5:
            return 0.0

        lo_w, hi_w = grid.index_range(start, start + size)
        lo_c, hi_c = grid.index_range(ctx_start, start)
        if hi_w <= lo_w or hi_c <= lo_c:
            return 0.0

        deltas = []
        for sig in normed.values():
            w = sig[lo_w:hi_w]
            c = sig[lo_c:hi_c]
            if w.size and c.size:
                deltas.append(abs(float(w.mean()) - float(c.mean())))
        return float(np.mean(deltas)) if deltas else 0.0

    # -- main entry -------------------------------------------------------

    def rank(self, grid: FeatureGrid, transcript: Transcript) -> List[HookWindow]:
        cfg = self.config
        candidates = self._candidates(grid.duration)
        if not candidates:
            raise ValueError("no scoring windows fit inside the video")

        has_speech = bool(transcript.words)
        weights = cfg.weights.normalised()
        if not has_speech:
            weights = cfg.weights.without_speech()
            log.info("no speech found; redistributing speech weight -> %s", weights)

        # Grid signals normalised once, globally. Used for novelty so that a
        # window and its context are measured on the same scale.
        normed_grid = {name: _minmax(sig) for name, sig in grid.signals.items()}
        # Computed once over the whole transcript, not per window: emphasis is
        # "long for THIS speaker", and a per-window median would drift with
        # whatever happens to be inside the window.
        med_word = median_word_duration(transcript)

        # --- raw per-candidate features ---
        raw: Dict[str, List[float]] = {}
        novelty_raw: List[float] = []
        for start, size in candidates:
            end = start + size
            means = grid.window_means(start, end)
            # Peaks are an impulse train: its mean over the window IS the peak
            # rate per sample, which is the density we want.
            for key in self.AUDIO_KEYS + self.VISUAL_KEYS:
                raw.setdefault(key, []).append(means.get(key, 0.0))
            if has_speech:
                feats = speech_features(transcript, start, end, med_word)
                for key, val in feats.items():
                    raw.setdefault(key, []).append(val)
            novelty_raw.append(self._novelty(grid, normed_grid, start, size))

        normed = {k: _minmax(np.asarray(v, dtype=np.float64)) for k, v in raw.items()}
        novelty_n = _minmax(np.asarray(novelty_raw, dtype=np.float64))

        # --- combine ---
        def modality(keys: Sequence[str], i: int) -> float:
            vals = [normed[k][i] for k in keys if k in normed]
            return float(np.mean(vals)) if vals else 0.0

        size_span = max(cfg.window_sizes) - min(cfg.window_sizes) or 1.0
        results: List[HookWindow] = []
        for i, (start, size) in enumerate(candidates):
            a = modality(self.AUDIO_KEYS, i)
            v = modality(self.VISUAL_KEYS, i)
            s = modality(self.SPEECH_KEYS, i) if has_speech else 0.0
            n = float(novelty_n[i])

            score = (
                weights.audio * a
                + weights.visual * v
                + weights.speech * s
                + weights.novelty * n
            )
            prior = 1.0 - cfg.size_preference * (
                abs(size - cfg.preferred_size) / size_span
            )
            score *= prior

            results.append(
                HookWindow(
                    start=start,
                    end=start + size,
                    confidence=0.0,  # filled in below, needs the distribution
                    score=score,
                    reason={"audio": a, "visual": v, "speech": s, "novelty": n},
                    detail={k: float(normed[k][i]) for k in normed},
                )
            )

        scores = np.asarray([r.score for r in results], dtype=np.float64)
        p50 = float(np.percentile(scores, 50))
        p95 = float(np.percentile(scores, 95))
        spread = max(p95 - p50, 1e-9)
        for r in results:
            margin = float(np.clip((r.score - p50) / spread, 0.0, 1.0))
            r.confidence = float(np.clip(0.6 * r.score + 0.4 * margin, 0.0, 1.0))

        results.sort(key=lambda r: r.score, reverse=True)
        log.info(
            "scored %d candidate windows; best %.2f-%.2fs score=%.3f confidence=%.3f",
            len(results), results[0].start, results[0].end,
            results[0].score, results[0].confidence,
        )
        return results

    def best(self, grid: FeatureGrid, transcript: Transcript) -> HookWindow:
        return self.rank(grid, transcript)[0]


def find_hook(
    grid: FeatureGrid,
    transcript: Transcript,
    config: Optional[ScoringConfig] = None,
) -> HookWindow:
    return HookScorer(config).best(grid, transcript)
