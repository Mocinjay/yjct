"""Climax-First video editing pipeline.

    input video
      -> feature extraction (audio + visual)   [cached]
      -> transcription (word timestamps)       [cached]
      -> rolling-window hook scoring
      -> timestamp selection
      -> ffmpeg assembly
      -> climax_edited_output.mp4

Run:
    python3 -m venv .venv && source .venv/bin/activate
    pip install -r requirements.txt          # needs ffmpeg on PATH
    python main.py input.mp4

    python main.py input.mp4 --dry-run --top 5      # score only, no encode
    python main.py input.mp4 --weights 0.5,0.2,0.2,0.1

Caching is keyed on the content hash of the input plus the extractor
parameters, so re-running with different *weights* is instant — the expensive
stages (whisper, OpenCV) are skipped entirely. Change a window size, a
keyword, a weight: instant. Change the sample rate or grid, and only then does
extraction re-run.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import logging
import os
import sys
import time
from dataclasses import dataclass
from typing import Optional, Tuple

from audio_vision_engine import (
    AudioFeatureExtractor,
    DEFAULT_GRID_HZ,
    DEFAULT_SAMPLE_FPS,
    FeatureExtractionError,
    FeatureGrid,
    VisualFeatureExtractor,
    extract_features,
    probe_duration,
)
from editor import ClimaxEditor, EditError
from scoring_algorithm import (
    HookScorer,
    HookWindow,
    ScoringConfig,
    ScoringWeights,
)
from transcriber import NullTranscriber, Transcript, WhisperTranscriber

log = logging.getLogger("climax")

# Bump when an extractor changes in a way that invalidates cached features.
FEATURE_VERSION = "1"
DEFAULT_OUTPUT = "climax_edited_output.mp4"


@dataclass
class PipelineConfig:
    grid_hz: float = DEFAULT_GRID_HZ
    sample_fps: float = DEFAULT_SAMPLE_FPS
    whisper_model: str = "base"
    use_speech: bool = True
    cache_dir: Optional[str] = None
    use_cache: bool = True
    scoring: ScoringConfig = None  # type: ignore[assignment]

    def __post_init__(self) -> None:
        if self.scoring is None:
            self.scoring = ScoringConfig()


def content_key(path: str, config: PipelineConfig) -> str:
    """Cache key: what the file is, plus everything that shapes extraction.

    The file is hashed by content rather than path+mtime so a re-encode, a copy
    or a re-download is correctly treated as the same or different input.
    """
    h = hashlib.sha256()
    with open(path, "rb") as fh:
        for chunk in iter(lambda: fh.read(1024 * 1024), b""):
            h.update(chunk)
    h.update(
        "|".join([
            FEATURE_VERSION,
            f"{config.grid_hz}",
            f"{config.sample_fps}",
            config.whisper_model if config.use_speech else "nospeech",
        ]).encode()
    )
    return h.hexdigest()[:16]


class Pipeline:
    def __init__(self, config: Optional[PipelineConfig] = None) -> None:
        self.config = config or PipelineConfig()

    # -- cache ------------------------------------------------------------

    def _cache_paths(self, media_path: str, key: str) -> Tuple[str, str]:
        base = self.config.cache_dir or os.path.join(
            os.path.dirname(os.path.abspath(media_path)), ".climax-cache"
        )
        os.makedirs(base, exist_ok=True)
        return (
            os.path.join(base, f"{key}.features.npz"),
            os.path.join(base, f"{key}.transcript.json"),
        )

    def _load_features(self, path: str) -> Optional[FeatureGrid]:
        if not (self.config.use_cache and os.path.exists(path)):
            return None
        try:
            grid = FeatureGrid.load(path)
            log.info("features: cache hit (%d samples)", len(grid))
            return grid
        except Exception as exc:  # corrupt cache must never be fatal
            log.warning("features: ignoring unreadable cache (%s)", exc)
            return None

    def _load_transcript(self, path: str) -> Optional[Transcript]:
        if not (self.config.use_cache and os.path.exists(path)):
            return None
        try:
            with open(path, "r", encoding="utf-8") as fh:
                transcript = Transcript.from_dict(json.load(fh))
            log.info("transcript: cache hit (%d words)", len(transcript.words))
            return transcript
        except Exception as exc:
            log.warning("transcript: ignoring unreadable cache (%s)", exc)
            return None

    # -- stages -----------------------------------------------------------

    def analyse(self, media_path: str) -> Tuple[FeatureGrid, Transcript]:
        cfg = self.config
        key = content_key(media_path, cfg)
        feat_path, tx_path = self._cache_paths(media_path, key)

        grid = self._load_features(feat_path)
        if grid is None:
            started = time.perf_counter()
            duration = probe_duration(media_path)
            grid = extract_features(
                media_path,
                grid_hz=cfg.grid_hz,
                audio=AudioFeatureExtractor(),
                visual=VisualFeatureExtractor(sample_fps=cfg.sample_fps),
                duration=duration,
            )
            log.info("features: extracted in %.1fs", time.perf_counter() - started)
            if cfg.use_cache:
                grid.save(feat_path)

        transcript = self._load_transcript(tx_path)
        if transcript is None:
            started = time.perf_counter()
            transcriber = (
                WhisperTranscriber(model_size=cfg.whisper_model)
                if cfg.use_speech
                else NullTranscriber()
            )
            transcript = transcriber.transcribe(media_path)
            log.info("transcript: produced in %.1fs", time.perf_counter() - started)
            if cfg.use_cache:
                with open(tx_path, "w", encoding="utf-8") as fh:
                    json.dump(transcript.to_dict(), fh)

        return grid, transcript

    def score(self, grid: FeatureGrid, transcript: Transcript, top: int = 1):
        return HookScorer(self.config.scoring).rank(grid, transcript)[:top]

    def run(self, media_path: str, output_path: str = DEFAULT_OUTPUT,
            dry_run: bool = False, top: int = 1) -> HookWindow:
        if not os.path.exists(media_path):
            raise FileNotFoundError(media_path)

        started = time.perf_counter()
        grid, transcript = self.analyse(media_path)
        ranked = self.score(grid, transcript, top=max(top, 1))
        best = ranked[0]

        for i, window in enumerate(ranked):
            log.info("#%d %s", i + 1, json.dumps(window.to_dict()["reason"]))

        if not dry_run:
            ClimaxEditor().build(media_path, best.start, best.end, output_path)
            sidecar = os.path.splitext(output_path)[0] + ".hook.json"
            with open(sidecar, "w", encoding="utf-8") as fh:
                json.dump(best.to_dict(), fh, indent=2)
            log.info("breakdown written to %s", sidecar)

        log.info("pipeline finished in %.1fs", time.perf_counter() - started)
        return best


def parse_weights(raw: str) -> ScoringWeights:
    parts = [p.strip() for p in raw.split(",")]
    if len(parts) != 4:
        raise argparse.ArgumentTypeError(
            "weights must be four comma-separated numbers: audio,visual,speech,novelty"
        )
    try:
        a, v, s, n = (float(p) for p in parts)
    except ValueError as exc:
        raise argparse.ArgumentTypeError(f"weights must be numbers: {exc}") from exc
    return ScoringWeights(audio=a, visual=v, speech=s, novelty=n)


def build_parser() -> argparse.ArgumentParser:
    p = argparse.ArgumentParser(
        prog="climax",
        description="Restructure a video into a Climax-First (Auto-Hook) cut.",
    )
    p.add_argument("input", help="source video")
    p.add_argument("-o", "--output", default=DEFAULT_OUTPUT)
    p.add_argument("--weights", type=parse_weights, default=ScoringWeights(),
                   help="audio,visual,speech,novelty (default 0.35,0.25,0.25,0.15)")
    p.add_argument("--window-sizes", default="3,4,5,6,7",
                   help="candidate window lengths in seconds")
    p.add_argument("--preferred-size", type=float, default=4.0)
    p.add_argument("--stride", type=float, default=0.5)
    p.add_argument("--context", type=float, default=5.0,
                   help="seconds of preceding footage used for novelty")
    p.add_argument("--model", default=os.getenv("WHISPER_MODEL", "base"),
                   help="faster-whisper model size")
    p.add_argument("--no-speech", action="store_true",
                   help="skip transcription; speech weight is redistributed")
    p.add_argument("--sample-fps", type=float, default=DEFAULT_SAMPLE_FPS)
    p.add_argument("--grid-hz", type=float, default=DEFAULT_GRID_HZ)
    p.add_argument("--cache-dir", default=None)
    p.add_argument("--no-cache", action="store_true")
    p.add_argument("--dry-run", action="store_true",
                   help="score and report only; write no video")
    p.add_argument("--top", type=int, default=1, help="report the top N windows")
    p.add_argument("-v", "--verbose", action="store_true")
    return p


def main(argv: Optional[list] = None) -> int:
    args = build_parser().parse_args(argv)
    logging.basicConfig(
        level=logging.DEBUG if args.verbose else logging.INFO,
        format="%(asctime)s %(levelname)-7s %(name)s: %(message)s",
        datefmt="%H:%M:%S",
    )

    try:
        sizes = tuple(float(s) for s in args.window_sizes.split(","))
    except ValueError:
        log.error("--window-sizes must be comma-separated numbers")
        return 2

    config = PipelineConfig(
        grid_hz=args.grid_hz,
        sample_fps=args.sample_fps,
        whisper_model=args.model,
        use_speech=not args.no_speech,
        cache_dir=args.cache_dir,
        use_cache=not args.no_cache,
        scoring=ScoringConfig(
            window_sizes=sizes,
            preferred_size=args.preferred_size,
            stride=args.stride,
            weights=args.weights,
            context_seconds=args.context,
        ),
    )

    try:
        best = Pipeline(config).run(
            args.input, args.output, dry_run=args.dry_run, top=args.top
        )
    except FileNotFoundError as exc:
        log.error("input not found: %s", exc)
        return 2
    except (FeatureExtractionError, EditError) as exc:
        log.error("%s", exc)
        return 1
    except KeyboardInterrupt:
        log.warning("interrupted")
        return 130

    print(json.dumps(best.to_dict(), indent=2))
    return 0


if __name__ == "__main__":
    sys.exit(main())
