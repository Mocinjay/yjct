"""Assembles the Climax-First cut with ffmpeg.

    [hook clip] -> [0.5s black transition] -> [complete original]

Quality strategy
----------------
The original recording is the bulk of the output and must never be re-encoded
just because we glued something onto the front of it. So the default path is:

  1. Cut the hook. Stream-copy it when the requested start lands on (or very
     near) a keyframe, otherwise re-encode just those few seconds. An arbitrary
     stream copy would silently snap the cut back to the previous keyframe,
     which is how you end up with a "hook" that starts two seconds early.
  2. Generate the transition to match the source's codec, resolution, frame
     rate, pixel format and audio layout exactly.
  3. Concatenate through MPEG-TS with `-c copy`. TS is the format that tolerates
     concatenation of independently produced H.264/HEVC segments; the MP4
     concat demuxer is far fussier about matching extradata.

If any of that is not applicable — an exotic codec, mismatched parameters, a
failure anywhere in the chain — it falls back to a single filter_complex
concat, re-encoding everything with the best available encoder. Correct output
beats a fast path that produces a broken file.

Hardware encoding is used when re-encoding is unavoidable: h264_videotoolbox on
macOS, h264_nvenc on NVIDIA, libx264 (CRF 18, veryslow-ish preset) otherwise.
"""
from __future__ import annotations

import logging
import os
import shutil
import subprocess
import tempfile
from dataclasses import dataclass
from typing import Any, Dict, List, Optional

import ffmpeg

log = logging.getLogger(__name__)

TRANSITION_SECONDS = 0.5
# A cut this close to a keyframe is treated as exact — one frame at 30fps is
# 33ms, so 50ms is "the nearest keyframe is the one we wanted".
KEYFRAME_TOLERANCE = 0.05


class EditError(RuntimeError):
    pass


@dataclass
class MediaInfo:
    width: int
    height: int
    fps: float
    pix_fmt: str
    video_codec: str
    duration: float
    has_audio: bool
    audio_codec: str = ""
    sample_rate: int = 48000
    channels: int = 1

    @property
    def annexb_filter(self) -> Optional[str]:
        """Bitstream filter needed to put this codec into MPEG-TS."""
        return {
            "h264": "h264_mp4toannexb",
            "hevc": "hevc_mp4toannexb",
        }.get(self.video_codec)


def probe(path: str) -> MediaInfo:
    try:
        meta = ffmpeg.probe(path)
    except ffmpeg.Error as exc:  # pragma: no cover - depends on ffmpeg build
        raise EditError(f"ffprobe failed for {path}: {_stderr(exc)}") from exc

    video = next(
        (s for s in meta["streams"] if s.get("codec_type") == "video"), None
    )
    if video is None:
        raise EditError(f"{path} has no video stream")
    audio = next(
        (s for s in meta["streams"] if s.get("codec_type") == "audio"), None
    )

    # avg_frame_rate is "num/den" and can be "0/0" on variable-frame-rate
    # captures — exactly what the glasses writer produces.
    fps = 30.0
    for key in ("avg_frame_rate", "r_frame_rate"):
        raw = video.get(key, "0/0")
        try:
            num, den = raw.split("/")
            value = float(num) / float(den)
            if value > 0:
                fps = value
                break
        except (ValueError, ZeroDivisionError):
            continue

    return MediaInfo(
        width=int(video["width"]),
        height=int(video["height"]),
        fps=fps,
        pix_fmt=video.get("pix_fmt", "yuv420p"),
        video_codec=video.get("codec_name", ""),
        duration=float(meta["format"].get("duration", 0.0) or 0.0),
        has_audio=audio is not None,
        audio_codec=(audio or {}).get("codec_name", ""),
        sample_rate=int((audio or {}).get("sample_rate", 48000) or 48000),
        channels=int((audio or {}).get("channels", 1) or 1),
    )


def _stderr(exc: Exception) -> str:
    err = getattr(exc, "stderr", None)
    if isinstance(err, bytes):
        return err.decode("utf-8", "replace").strip()[-500:]
    return str(exc)


def detect_video_encoder() -> Dict[str, Any]:
    """Pick the best available H.264 encoder and its quality settings."""
    try:
        listing = subprocess.run(
            ["ffmpeg", "-hide_banner", "-encoders"],
            capture_output=True, text=True, check=True,
        ).stdout
    except (subprocess.CalledProcessError, FileNotFoundError):
        listing = ""

    if "h264_videotoolbox" in listing:
        # VideoToolbox has no CRF; -q:v 65 is visually near-transparent and it
        # is an order of magnitude faster than libx264 at this quality.
        return {"vcodec": "h264_videotoolbox", "video_bitrate": None, "q:v": 65}
    if "h264_nvenc" in listing:
        return {"vcodec": "h264_nvenc", "preset": "p5", "cq": 19}
    return {"vcodec": "libx264", "preset": "slow", "crf": 18}


def keyframe_times(path: str, before: float) -> List[float]:
    """Keyframe timestamps up to `before`, for deciding copy vs re-encode."""
    try:
        out = subprocess.run(
            [
                "ffprobe", "-v", "error",
                "-select_streams", "v:0",
                "-show_entries", "packet=pts_time,flags",
                "-read_intervals", f"%{max(before, 0) + 1:.3f}",
                "-of", "csv=print_section=0",
                path,
            ],
            capture_output=True, text=True, check=True,
        ).stdout
    except subprocess.CalledProcessError as exc:
        log.warning("keyframe probe failed, assuming none: %s", exc)
        return []

    times = []
    for line in out.splitlines():
        parts = line.split(",")
        if len(parts) >= 2 and "K" in parts[1]:
            try:
                times.append(float(parts[0]))
            except ValueError:
                continue
    return times


class ClimaxEditor:
    """Builds `[hook][transition][original]`."""

    def __init__(
        self,
        transition_seconds: float = TRANSITION_SECONDS,
        encoder: Optional[Dict[str, Any]] = None,
    ) -> None:
        if not shutil.which("ffmpeg"):
            raise EditError("ffmpeg not found on PATH")
        self.transition_seconds = transition_seconds
        self._encoder = encoder

    @property
    def encoder(self) -> Dict[str, Any]:
        if self._encoder is None:
            self._encoder = detect_video_encoder()
            log.info("video encoder: %s", self._encoder["vcodec"])
        return self._encoder

    def _video_output_args(self, info: MediaInfo) -> Dict[str, Any]:
        args = {k: v for k, v in self.encoder.items() if v is not None}
        args.setdefault("pix_fmt", info.pix_fmt)
        return args

    # -- parts ------------------------------------------------------------

    def _cut_hook(self, src: str, info: MediaInfo, start: float, end: float,
                  out_path: str) -> None:
        duration = max(0.05, end - start)
        kf = keyframe_times(src, start)
        aligned = any(abs(k - start) <= KEYFRAME_TOLERANCE for k in kf)

        if aligned:
            log.info("hook cut: keyframe-aligned at %.3fs, stream copying", start)
            stream = ffmpeg.input(src, ss=start, t=duration)
            out = ffmpeg.output(stream, out_path, c="copy", avoid_negative_ts="make_zero")
            try:
                self._run(out)
                return
            except EditError as exc:
                log.warning("stream-copy cut failed, re-encoding: %s", exc)

        log.info("hook cut: re-encoding %.2fs from %.3fs", duration, start)
        # -ss AFTER -i is the accurate (decode-then-discard) seek. Slower, but
        # for a few seconds that is irrelevant and it lands on the right frame.
        stream = ffmpeg.input(src)
        video = stream.video.filter("trim", start=start, duration=duration).filter(
            "setpts", "PTS-STARTPTS"
        )
        args = self._video_output_args(info)
        if info.has_audio:
            audio = stream.audio.filter("atrim", start=start, duration=duration).filter(
                "asetpts", "PTS-STARTPTS"
            )
            out = ffmpeg.output(video, audio, out_path, acodec="aac",
                                audio_bitrate="192k", ar=info.sample_rate,
                                ac=info.channels, **args)
        else:
            out = ffmpeg.output(video, out_path, **args)
        self._run(out)

    def _make_transition(self, info: MediaInfo, out_path: str) -> None:
        """0.5s of black, matching the source exactly so concat can copy."""
        log.info("transition: %.2fs black at %dx%d @%.2ffps",
                 self.transition_seconds, info.width, info.height, info.fps)
        video = ffmpeg.input(
            f"color=c=black:s={info.width}x{info.height}:r={info.fps}",
            f="lavfi", t=self.transition_seconds,
        )
        args = self._video_output_args(info)
        if info.has_audio:
            # Silence, not "no audio": a part with no audio stream breaks
            # concatenation against parts that have one.
            audio = ffmpeg.input(
                f"anullsrc=channel_layout={'mono' if info.channels == 1 else 'stereo'}"
                f":sample_rate={info.sample_rate}",
                f="lavfi", t=self.transition_seconds,
            )
            out = ffmpeg.output(video, audio, out_path, acodec="aac",
                                audio_bitrate="192k", shortest=None, **args)
        else:
            out = ffmpeg.output(video, out_path, **args)
        self._run(out)

    # -- concatenation ----------------------------------------------------

    def _to_ts(self, src: str, info: MediaInfo, out_path: str) -> None:
        kwargs: Dict[str, Any] = {"c": "copy", "f": "mpegts"}
        bsf = info.annexb_filter
        if bsf:
            kwargs["bsf:v"] = bsf
        self._run(ffmpeg.output(ffmpeg.input(src), out_path, **kwargs))

    def _concat_copy(self, parts: List[str], info: MediaInfo, out_path: str) -> None:
        """Concat via MPEG-TS with no re-encode. The quality-preserving path."""
        if info.annexb_filter is None:
            raise EditError(f"codec {info.video_codec!r} cannot be muxed to TS")
        with tempfile.TemporaryDirectory(prefix="climax-ts-") as tmp:
            ts_parts = []
            for i, part in enumerate(parts):
                ts = os.path.join(tmp, f"part{i}.ts")
                self._to_ts(part, info, ts)
                ts_parts.append(ts)
            joined = "concat:" + "|".join(ts_parts)
            kwargs: Dict[str, Any] = {"c": "copy", "movflags": "+faststart"}
            if info.has_audio:
                # AAC in TS is ADTS-framed; MP4 needs it back in ASC form.
                kwargs["bsf:a"] = "aac_adtstoasc"
            self._run(ffmpeg.output(ffmpeg.input(joined, f="mpegts"), out_path, **kwargs))

    def _concat_reencode(self, parts: List[str], info: MediaInfo, out_path: str) -> None:
        """Fallback: one filter_complex concat, everything re-encoded."""
        log.info("concat: re-encoding fallback across %d parts", len(parts))
        inputs = [ffmpeg.input(p) for p in parts]
        if info.has_audio:
            streams: List[Any] = []
            for inp in inputs:
                streams.extend([
                    inp.video.filter("scale", info.width, info.height)
                             .filter("setsar", "1"),
                    inp.audio,
                ])
            joined = ffmpeg.concat(*streams, v=1, a=1).node
            out = ffmpeg.output(joined[0], joined[1], out_path,
                                acodec="aac", audio_bitrate="192k",
                                movflags="+faststart",
                                **self._video_output_args(info))
        else:
            streams = [
                inp.video.filter("scale", info.width, info.height).filter("setsar", "1")
                for inp in inputs
            ]
            joined = ffmpeg.concat(*streams, v=1, a=0).node
            out = ffmpeg.output(joined[0], out_path, movflags="+faststart",
                                **self._video_output_args(info))
        self._run(out)

    # -- driver -----------------------------------------------------------

    def build(self, src: str, hook_start: float, hook_end: float,
              out_path: str) -> str:
        info = probe(src)
        if hook_end <= hook_start:
            raise EditError(f"invalid hook window {hook_start}-{hook_end}")
        hook_end = min(hook_end, info.duration)
        log.info(
            "assembling: hook %.2f-%.2fs + %.1fs transition + %.2fs original",
            hook_start, hook_end, self.transition_seconds, info.duration,
        )

        os.makedirs(os.path.dirname(os.path.abspath(out_path)) or ".", exist_ok=True)
        with tempfile.TemporaryDirectory(prefix="climax-parts-") as tmp:
            hook = os.path.join(tmp, "hook.mp4")
            trans = os.path.join(tmp, "transition.mp4")
            self._cut_hook(src, info, hook_start, hook_end, hook)
            self._make_transition(info, trans)
            parts = [hook, trans, src]

            try:
                self._concat_copy(parts, info, out_path)
                log.info("assembled with stream copy (original never re-encoded)")
            except EditError as exc:
                log.warning("stream-copy concat failed (%s); re-encoding", exc)
                self._concat_reencode(parts, info, out_path)

        if not os.path.exists(out_path) or os.path.getsize(out_path) == 0:
            raise EditError(f"output {out_path} was not produced")
        log.info("wrote %s (%.1f MB)", out_path, os.path.getsize(out_path) / 1e6)
        return out_path

    # -- process ----------------------------------------------------------

    @staticmethod
    def _run(stream) -> None:
        cmd = ffmpeg.compile(stream, overwrite_output=True)
        log.debug("ffmpeg %s", " ".join(cmd[1:]))
        try:
            ffmpeg.run(stream, overwrite_output=True,
                       capture_stdout=True, capture_stderr=True)
        except ffmpeg.Error as exc:
            raise EditError(_stderr(exc)) from exc
