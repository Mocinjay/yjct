"""Speech transcription with word-level timestamps.

Wraps faster-whisper behind a narrow interface so the rest of the pipeline
never imports it directly. Anything that can produce `Transcript` — a cloud
ASR, a cached JSON, a different local model — can be dropped in by satisfying
the `Transcriber` protocol.

Word-level timing is the point. Segment-level timestamps are too coarse for a
4-second scoring window: a 10-second segment tells you nothing about which
2 seconds inside it were the shouting.
"""
from __future__ import annotations

import logging
import os
from dataclasses import asdict, dataclass, field
from typing import Any, Dict, List, Optional, Protocol

log = logging.getLogger(__name__)

# `base` matches the captioning service's default. `small`/`medium` are more
# accurate, `tiny` is roughly 3x faster — the scorer only needs rough word
# timings and rough text, so `base` is a deliberate accuracy/speed trade.
DEFAULT_MODEL = os.getenv("WHISPER_MODEL", "base")


@dataclass(frozen=True)
class Word:
    """One recognised word and where it lands on the timeline."""

    text: str
    start: float
    end: float
    probability: float = 1.0

    @property
    def duration(self) -> float:
        return max(0.0, self.end - self.start)


@dataclass(frozen=True)
class Segment:
    """A whisper segment — a phrase or sentence. Kept for punctuation, which
    is the only place exclamation marks survive; individual words don't carry
    them, and they're a useful emphasis signal."""

    text: str
    start: float
    end: float
    words: List[Word] = field(default_factory=list)


@dataclass
class Transcript:
    words: List[Word] = field(default_factory=list)
    segments: List[Segment] = field(default_factory=list)
    language: str = ""
    duration: float = 0.0

    def words_between(self, start: float, end: float) -> List[Word]:
        """Words whose midpoint falls inside [start, end).

        Midpoint rather than full containment: a word straddling the window
        edge belongs to whichever side holds most of it, and every word is
        counted exactly once across adjacent windows.
        """
        out = []
        for w in self.words:
            mid = (w.start + w.end) / 2.0
            if start <= mid < end:
                out.append(w)
        return out

    def text_between(self, start: float, end: float) -> str:
        return " ".join(w.text for w in self.words_between(start, end)).strip()

    def segments_overlapping(self, start: float, end: float) -> List[Segment]:
        return [s for s in self.segments if s.end > start and s.start < end]

    # --- serialisation, so main.py can cache a transcript and skip whisper ---

    def to_dict(self) -> Dict[str, Any]:
        return {
            "language": self.language,
            "duration": self.duration,
            "words": [asdict(w) for w in self.words],
            "segments": [
                {
                    "text": s.text,
                    "start": s.start,
                    "end": s.end,
                    "words": [asdict(w) for w in s.words],
                }
                for s in self.segments
            ],
        }

    @classmethod
    def from_dict(cls, data: Dict[str, Any]) -> "Transcript":
        words = [Word(**w) for w in data.get("words", [])]
        segments = [
            Segment(
                text=s["text"],
                start=s["start"],
                end=s["end"],
                words=[Word(**w) for w in s.get("words", [])],
            )
            for s in data.get("segments", [])
        ]
        return cls(
            words=words,
            segments=segments,
            language=data.get("language", ""),
            duration=float(data.get("duration", 0.0)),
        )


class Transcriber(Protocol):
    """Swap point. Implement this and the scorer neither knows nor cares."""

    def transcribe(self, media_path: str) -> Transcript: ...


class WhisperTranscriber:
    """faster-whisper with word timestamps and VAD.

    The model is loaded lazily and reused: construction costs seconds and
    hundreds of MB, so a long-lived process should build one of these and keep
    it, not one per video.
    """

    def __init__(
        self,
        model_size: str = DEFAULT_MODEL,
        device: Optional[str] = None,
        compute_type: Optional[str] = None,
        vad_filter: bool = True,
    ) -> None:
        self.model_size = model_size
        self.vad_filter = vad_filter
        self._device = device
        self._compute_type = compute_type
        self._model = None

    def _resolve_device(self) -> tuple:
        if self._device and self._compute_type:
            return self._device, self._compute_type
        # int8 on CPU is the difference between usable and not; float16 on CUDA
        # is both faster and lower memory. Mirrors server/captioning/main.py.
        device, compute = "cpu", "int8"
        try:
            import torch  # type: ignore

            if torch.cuda.is_available():
                device, compute = "cuda", "float16"
        except ImportError:
            pass
        return self._device or device, self._compute_type or compute

    @property
    def model(self):
        if self._model is None:
            from faster_whisper import WhisperModel

            device, compute = self._resolve_device()
            log.info(
                "loading whisper model=%s device=%s compute=%s",
                self.model_size,
                device,
                compute,
            )
            self._model = WhisperModel(
                self.model_size, device=device, compute_type=compute
            )
        return self._model

    def transcribe(self, media_path: str) -> Transcript:
        log.info("transcribing %s", media_path)
        segments_iter, info = self.model.transcribe(
            media_path,
            word_timestamps=True,
            vad_filter=self.vad_filter,
        )

        words: List[Word] = []
        segments: List[Segment] = []
        # faster-whisper returns a generator; consuming it is what actually
        # runs inference, so this loop is the expensive part.
        for seg in segments_iter:
            seg_words = [
                Word(
                    text=w.word.strip(),
                    start=float(w.start),
                    end=float(w.end),
                    probability=float(getattr(w, "probability", 1.0) or 1.0),
                )
                for w in (seg.words or [])
                if w.word and w.word.strip()
            ]
            words.extend(seg_words)
            segments.append(
                Segment(
                    text=(seg.text or "").strip(),
                    start=float(seg.start),
                    end=float(seg.end),
                    words=seg_words,
                )
            )

        duration = float(getattr(info, "duration", 0.0) or 0.0)
        transcript = Transcript(
            words=words,
            segments=segments,
            language=getattr(info, "language", "") or "",
            duration=duration,
        )
        log.info(
            "transcribed %d words in %d segments (language=%s)",
            len(words),
            len(segments),
            transcript.language,
        )
        return transcript


class NullTranscriber:
    """No-op transcriber for silent footage or `--no-speech` runs.

    The scorer handles an empty transcript by redistributing the speech weight
    across the other modalities, so this degrades cleanly rather than scoring
    every window's speech component as zero and biasing the result.
    """

    def transcribe(self, media_path: str) -> Transcript:  # noqa: ARG002
        return Transcript()
