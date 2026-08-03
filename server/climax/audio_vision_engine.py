"""Audio and visual feature extraction onto one shared timebase.

Every extractor here returns a `FeatureGrid`: named 1-D signals sampled on a
uniform grid (default 20 Hz). That shared grid is the load-bearing idea in this
module. Audio features naturally fall on librosa's STFT hop, visual features on
sampled video frames, and the two rates have nothing to do with each other —
resampling both onto one grid at extraction time means the scorer can slice a
window with a pair of array indices and never think about alignment again.

Signals produced
----------------
audio.rms            Short-time RMS energy. Loudness — shouting, impacts.
audio.flux           Spectral flux. Positive frame-to-frame change in the
                     magnitude spectrum: timbre *changes*, so it fires on
                     onsets (a hit, a laugh starting) and not on steady noise.
audio.zcr            Zero-crossing rate. High for fricatives/noise, low for
                     tonal sound — separates a scream from a bass rumble.
audio.peaks          Onset-strength peaks, as a 0/1 impulse train. Counting
                     these in a window gives "how many distinct events".
visual.flow          Sparse Lucas-Kanade optical flow magnitude. Real motion,
                     at a fraction of the cost of dense Farneback.
visual.frame_diff    Mean absolute grayscale difference between samples.
visual.scene_change  1 - HSV histogram correlation with the previous sample.
                     Spikes at cuts; near zero within a continuous shot.

Performance
-----------
Audio decodes through one ffmpeg pipe straight into a numpy array — no temp
file. Video is sampled at `sample_fps` (default 10) rather than every frame,
and each sampled frame is downscaled to `analysis_width` (default 320) before
any CV runs. `cap.grab()` skips undecoded frames, so we only pay full decode
cost on frames we actually analyse. On a 13s 504x896 clip that is ~130 decoded
frames instead of ~310, each processed at 320px.
"""
from __future__ import annotations

import logging
import shutil
import subprocess
from dataclasses import dataclass, field
from typing import Dict, List, Optional, Protocol

import numpy as np

log = logging.getLogger(__name__)

# Sampling grid shared by every signal. 20 Hz (0.05s) is comfortably finer than
# the 0.5s scoring stride, so no window boundary lands mid-sample, and it keeps
# a 10-minute video's feature set to a few MB.
DEFAULT_GRID_HZ = 20.0

# Audio is analysed mono at 22.05 kHz. Everything we extract is envelope- or
# onset-shaped; nothing needs the top octave, and halving the rate roughly
# halves librosa's cost.
AUDIO_SAMPLE_RATE = 22050
AUDIO_HOP = 512

DEFAULT_SAMPLE_FPS = 10.0
DEFAULT_ANALYSIS_WIDTH = 320


class FeatureExtractionError(RuntimeError):
    pass


@dataclass
class FeatureGrid:
    """Named signals on a uniform time grid.

    `times[i]` is the timestamp of sample `i` for every signal, so all signals
    share length and alignment by construction.
    """

    hop: float
    times: np.ndarray
    duration: float
    signals: Dict[str, np.ndarray] = field(default_factory=dict)

    @property
    def names(self) -> List[str]:
        return sorted(self.signals)

    def __len__(self) -> int:
        return int(self.times.shape[0])

    def index_range(self, start: float, end: float) -> tuple:
        """Half-open sample index range covering [start, end)."""
        lo = int(np.searchsorted(self.times, start, side="left"))
        hi = int(np.searchsorted(self.times, end, side="left"))
        return lo, max(hi, lo)

    def window(self, start: float, end: float) -> Dict[str, np.ndarray]:
        lo, hi = self.index_range(start, end)
        return {name: sig[lo:hi] for name, sig in self.signals.items()}

    def window_means(self, start: float, end: float) -> Dict[str, float]:
        """Mean of every signal over a window; 0.0 for an empty slice.

        Means rather than sums so a 3s and a 7s window stay comparable — window
        length must not by itself make a window score higher.
        """
        out = {}
        for name, seg in self.window(start, end).items():
            out[name] = float(seg.mean()) if seg.size else 0.0
        return out

    def merge(self, other: "FeatureGrid") -> "FeatureGrid":
        if other is None:
            return self
        if len(other) != len(self):
            raise FeatureExtractionError(
                f"grid length mismatch: {len(self)} vs {len(other)}"
            )
        merged = dict(self.signals)
        merged.update(other.signals)
        return FeatureGrid(
            hop=self.hop,
            times=self.times,
            duration=max(self.duration, other.duration),
            signals=merged,
        )

    # --- caching ---------------------------------------------------------

    def save(self, path: str) -> None:
        np.savez_compressed(
            path,
            _hop=np.array([self.hop]),
            _duration=np.array([self.duration]),
            _times=self.times,
            **self.signals,
        )

    @classmethod
    def load(cls, path: str) -> "FeatureGrid":
        with np.load(path) as data:
            signals = {
                k: data[k] for k in data.files if not k.startswith("_")
            }
            return cls(
                hop=float(data["_hop"][0]),
                times=data["_times"],
                duration=float(data["_duration"][0]),
                signals=signals,
            )


def make_grid(duration: float, hz: float = DEFAULT_GRID_HZ) -> FeatureGrid:
    hop = 1.0 / hz
    n = max(1, int(np.floor(duration / hop)))
    return FeatureGrid(
        hop=hop, times=np.arange(n, dtype=np.float64) * hop, duration=duration
    )


def resample_to(
    src_times: np.ndarray, values: np.ndarray, dst_times: np.ndarray
) -> np.ndarray:
    """Linear resample onto the shared grid, holding the end values flat.

    np.interp clamps outside the source range, which is what we want: a signal
    should not fall to zero in the tail just because its own sampling stopped a
    fraction of a second early.
    """
    if src_times.size == 0 or values.size == 0:
        return np.zeros_like(dst_times)
    n = min(src_times.size, values.size)
    return np.interp(dst_times, src_times[:n], values[:n]).astype(np.float64)


class FeatureExtractor(Protocol):
    """Swap point for any feature source."""

    def extract(self, media_path: str, grid: FeatureGrid) -> FeatureGrid: ...


# --------------------------------------------------------------------------
# Audio
# --------------------------------------------------------------------------


def probe_duration(media_path: str) -> float:
    """Container duration via ffprobe. Used to size the grid before decoding."""
    if not shutil.which("ffprobe"):
        raise FeatureExtractionError("ffprobe not found on PATH")
    try:
        out = subprocess.run(
            [
                "ffprobe", "-v", "error",
                "-show_entries", "format=duration",
                "-of", "default=noprint_wrappers=1:nokey=1",
                media_path,
            ],
            capture_output=True, text=True, check=True,
        ).stdout.strip()
        return float(out)
    except (subprocess.CalledProcessError, ValueError) as exc:
        raise FeatureExtractionError(
            f"could not read duration from {media_path}: {exc}"
        ) from exc


def decode_audio(media_path: str, sample_rate: int = AUDIO_SAMPLE_RATE) -> np.ndarray:
    """Decode to mono float32 through an ffmpeg pipe.

    Deliberately not librosa.load: on an MP4 it would fall back to audioread and
    shell out to ffmpeg anyway, via a temp file. ffmpeg is already a hard
    dependency of the editor, so we use it directly and keep the samples in
    memory. Returns an empty array for video with no audio track, which the
    caller turns into zeroed audio signals rather than an error.
    """
    if not shutil.which("ffmpeg"):
        raise FeatureExtractionError("ffmpeg not found on PATH")
    proc = subprocess.run(
        [
            "ffmpeg", "-v", "error", "-nostdin",
            "-i", media_path,
            "-vn", "-ac", "1", "-ar", str(sample_rate),
            "-f", "f32le", "-",
        ],
        capture_output=True,
    )
    if proc.returncode != 0 or not proc.stdout:
        log.warning(
            "no decodable audio in %s (%s)",
            media_path,
            proc.stderr.decode("utf-8", "replace").strip()[:200] or "empty stream",
        )
        return np.zeros(0, dtype=np.float32)
    return np.frombuffer(proc.stdout, dtype=np.float32)


class AudioFeatureExtractor:
    """RMS energy, spectral flux, zero-crossing rate and onset peaks."""

    def __init__(
        self, sample_rate: int = AUDIO_SAMPLE_RATE, hop_length: int = AUDIO_HOP
    ) -> None:
        self.sample_rate = sample_rate
        self.hop_length = hop_length

    def extract(self, media_path: str, grid: FeatureGrid) -> FeatureGrid:
        import librosa

        y = decode_audio(media_path, self.sample_rate)
        names = ("audio.rms", "audio.flux", "audio.zcr", "audio.peaks")
        if y.size == 0:
            log.info("audio: silent/absent track, emitting zeros")
            return FeatureGrid(
                hop=grid.hop, times=grid.times, duration=grid.duration,
                signals={n: np.zeros_like(grid.times) for n in names},
            )

        y = np.ascontiguousarray(y, dtype=np.float32)
        hop = self.hop_length

        # One STFT, reused for flux — recomputing it per feature is the single
        # most expensive mistake available here.
        stft = np.abs(librosa.stft(y, hop_length=hop))
        frame_times = librosa.frames_to_time(
            np.arange(stft.shape[1]), sr=self.sample_rate, hop_length=hop
        )

        rms = librosa.feature.rms(S=stft, hop_length=hop)[0]

        # Spectral flux: sum of POSITIVE bin-to-bin change only. Negative change
        # is sound decaying, which is not an event; half-wave rectifying is what
        # makes this an onset detector rather than a change detector.
        diff = np.diff(stft, axis=1, prepend=stft[:, :1])
        flux = np.sum(np.maximum(diff, 0.0), axis=0)

        zcr = librosa.feature.zero_crossing_rate(
            y, frame_length=hop * 2, hop_length=hop
        )[0]

        # onset_strength expects a LOG-POWER spectrogram. Feeding it the linear
        # magnitude STFT yields an envelope on the wrong scale, against which a
        # fixed delta silently rejects every peak — verified on a real clip
        # where this produced 0 peaks across the whole timeline.
        mel_db = librosa.power_to_db(
            librosa.feature.melspectrogram(S=stft ** 2, sr=self.sample_rate),
            ref=np.max,
        )
        onset_env = librosa.onset.onset_strength(S=mel_db, sr=self.sample_rate)
        # Threshold relative to the envelope's own spread rather than absolute,
        # so quiet footage and a stadium both yield sensible peak counts.
        delta = max(0.1, 0.5 * float(np.std(onset_env)))
        peak_idx = librosa.util.peak_pick(
            onset_env, pre_max=3, post_max=3, pre_avg=3,
            post_avg=5, delta=delta, wait=5,
        )
        peaks = np.zeros_like(onset_env)
        if len(peak_idx):
            peaks[np.asarray(peak_idx, dtype=int)] = 1.0

        signals = {}
        for name, values in (
            ("audio.rms", rms),
            ("audio.flux", flux),
            ("audio.zcr", zcr),
            ("audio.peaks", peaks),
        ):
            signals[name] = resample_to(frame_times, values, grid.times)

        log.info(
            "audio: %.1fs decoded, %d frames, %d onset peaks",
            y.size / self.sample_rate, stft.shape[1], len(peak_idx),
        )
        return FeatureGrid(
            hop=grid.hop, times=grid.times, duration=grid.duration, signals=signals
        )


# --------------------------------------------------------------------------
# Visual
# --------------------------------------------------------------------------


class VisualFeatureExtractor:
    """Sparse optical flow, frame difference and scene-change detection.

    Sparse Lucas-Kanade over ~200 tracked corners rather than dense Farneback:
    for "how much is moving", the median displacement of good corners is a
    comparable signal at a small fraction of the cost.
    """

    def __init__(
        self,
        sample_fps: float = DEFAULT_SAMPLE_FPS,
        analysis_width: int = DEFAULT_ANALYSIS_WIDTH,
        max_corners: int = 200,
        redetect_every: int = 10,
    ) -> None:
        self.sample_fps = sample_fps
        self.analysis_width = analysis_width
        self.max_corners = max_corners
        self.redetect_every = redetect_every

    def extract(self, media_path: str, grid: FeatureGrid) -> FeatureGrid:
        import cv2

        cap = cv2.VideoCapture(media_path)
        if not cap.isOpened():
            raise FeatureExtractionError(f"OpenCV could not open {media_path}")

        try:
            src_fps = cap.get(cv2.CAP_PROP_FPS) or 0.0
            if src_fps <= 0 or not np.isfinite(src_fps):
                # Variable-frame-rate captures sometimes report 0. Fall back to
                # the sample rate so stepping degrades to "every frame".
                log.warning("video reports fps=%s; assuming %s", src_fps, self.sample_fps)
                src_fps = self.sample_fps
            step = max(1, int(round(src_fps / self.sample_fps)))

            times: List[float] = []
            flow_mag: List[float] = []
            frame_diff: List[float] = []
            scene_change: List[float] = []

            prev_gray = None
            prev_hist = None
            prev_pts = None
            since_detect = 0
            frame_no = 0

            lk_params = dict(
                winSize=(21, 21),
                maxLevel=2,
                criteria=(cv2.TERM_CRITERIA_EPS | cv2.TERM_CRITERIA_COUNT, 20, 0.03),
            )
            feature_params = dict(
                maxCorners=self.max_corners, qualityLevel=0.01,
                minDistance=8, blockSize=7,
            )

            while True:
                # grab() advances without decoding; only sampled frames pay the
                # full retrieve() cost.
                ok = cap.grab()
                if not ok:
                    break
                if frame_no % step != 0:
                    frame_no += 1
                    continue
                ok, frame = cap.retrieve()
                if not ok or frame is None:
                    frame_no += 1
                    continue

                t = frame_no / src_fps
                h, w = frame.shape[:2]
                if w > self.analysis_width:
                    scale = self.analysis_width / float(w)
                    frame = cv2.resize(
                        frame, (self.analysis_width, max(1, int(h * scale))),
                        interpolation=cv2.INTER_AREA,
                    )
                gray = cv2.cvtColor(frame, cv2.COLOR_BGR2GRAY)
                hist = cv2.calcHist([cv2.cvtColor(frame, cv2.COLOR_BGR2HSV)],
                                    [0, 1], None, [32, 32], [0, 180, 0, 256])
                cv2.normalize(hist, hist)

                if prev_gray is None:
                    times.append(t)
                    flow_mag.append(0.0)
                    frame_diff.append(0.0)
                    scene_change.append(0.0)
                else:
                    diff = float(np.mean(cv2.absdiff(gray, prev_gray))) / 255.0

                    corr = float(cv2.compareHist(hist, prev_hist, cv2.HISTCMP_CORREL))
                    # Correlation runs [-1, 1]; clamp so a wild cut cannot push
                    # the signal above 1 and distort later normalisation.
                    change = float(np.clip(1.0 - corr, 0.0, 1.0))

                    mag = 0.0
                    if prev_pts is not None and len(prev_pts):
                        nxt, status, _ = cv2.calcOpticalFlowPyrLK(
                            prev_gray, gray, prev_pts, None, **lk_params
                        )
                        if nxt is not None and status is not None:
                            good_new = nxt[status.flatten() == 1]
                            good_old = prev_pts[status.flatten() == 1]
                            if len(good_new):
                                d = np.linalg.norm(good_new - good_old, axis=1)
                                # Median, not mean: a handful of mistracked
                                # corners on a repeating texture would otherwise
                                # dominate. Normalised by width so the signal is
                                # resolution-independent.
                                mag = float(np.median(d)) / float(gray.shape[1])
                                prev_pts = good_new.reshape(-1, 1, 2)
                            else:
                                prev_pts = None
                    times.append(t)
                    flow_mag.append(mag)
                    frame_diff.append(diff)
                    scene_change.append(change)

                since_detect += 1
                if prev_pts is None or since_detect >= self.redetect_every:
                    pts = cv2.goodFeaturesToTrack(gray, mask=None, **feature_params)
                    prev_pts = pts if pts is not None else None
                    since_detect = 0

                prev_gray = gray
                prev_hist = hist
                frame_no += 1
        finally:
            cap.release()

        if not times:
            raise FeatureExtractionError(f"no frames decoded from {media_path}")

        t_arr = np.asarray(times, dtype=np.float64)
        signals = {
            "visual.flow": resample_to(t_arr, np.asarray(flow_mag), grid.times),
            "visual.frame_diff": resample_to(t_arr, np.asarray(frame_diff), grid.times),
            "visual.scene_change": resample_to(
                t_arr, np.asarray(scene_change), grid.times
            ),
        }
        log.info(
            "visual: %d frames analysed at %.1f fps (step=%d, width=%d)",
            len(times), self.sample_fps, step, self.analysis_width,
        )
        return FeatureGrid(
            hop=grid.hop, times=grid.times, duration=grid.duration, signals=signals
        )


def extract_features(
    media_path: str,
    grid_hz: float = DEFAULT_GRID_HZ,
    audio: Optional[AudioFeatureExtractor] = None,
    visual: Optional[VisualFeatureExtractor] = None,
    duration: Optional[float] = None,
) -> FeatureGrid:
    """Run every extractor and merge onto one grid."""
    duration = duration if duration is not None else probe_duration(media_path)
    if duration <= 0:
        raise FeatureExtractionError(f"{media_path} has zero duration")

    grid = make_grid(duration, grid_hz)
    log.info(
        "feature grid: %.2fs at %.1f Hz -> %d samples", duration, grid_hz, len(grid)
    )
    audio_grid = (audio or AudioFeatureExtractor()).extract(media_path, grid)
    visual_grid = (visual or VisualFeatureExtractor()).extract(media_path, grid)
    return grid.merge(audio_grid).merge(visual_grid)
