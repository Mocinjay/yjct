"""Clipso captioning service — the swappable infra behind the app's
CaptioningProvider seam.

GET  /styles                    -> [{key, label, description, ...}]
POST /caption (file, style)     -> {"id": ..., "captions": N, "style": ...}
GET  /caption/{id}/download     -> captioned MP4

Pipeline:
  1. faster-whisper transcription with word timestamps + VAD filter
     (int8 on CPU, float16 on CUDA)
  2. words grouped into captions and timed per word (captions.py)
  3. ffmpeg burns an ASS subtitle track onto the clip (libx264 + copy audio)

This module is transport only. Everything about how a caption looks and when
each word lights up lives in captions.py, which has no dependencies and is
covered by test_captions.py.

Run:
  pip install -r requirements.txt   # needs ffmpeg (and ffprobe) on PATH
  uvicorn main:app --host 0.0.0.0 --port 8787
"""
import json
import os
import subprocess
import tempfile
import uuid
from pathlib import Path

from fastapi import FastAPI, Form, HTTPException, UploadFile
from fastapi.responses import FileResponse

from captions import (
    CAPTION_STYLES,
    DEFAULT_STYLE_KEY,
    build_ass,
    chunk_words,
    describe_styles,
    get_style,
)

WHISPER_MODEL = os.getenv("WHISPER_MODEL", "base")
WORK_DIR = Path(os.getenv("WORK_DIR", tempfile.gettempdir())) / "clipso-captioning"
DEFAULT_FRAME = (1080, 1920)

app = FastAPI(title="Clipso Captioning")
_model = None


def get_model():
    global _model
    if _model is None:
        from faster_whisper import WhisperModel

        device = "cpu"
        compute = "int8"
        try:
            import torch  # type: ignore

            if torch.cuda.is_available():
                device, compute = "cuda", "float16"
        except ImportError:
            pass
        _model = WhisperModel(WHISPER_MODEL, device=device, compute_type=compute)
    return _model


@app.get("/styles")
def styles():
    return {"default": DEFAULT_STYLE_KEY, "styles": describe_styles()}


@app.post("/caption")
async def caption(file: UploadFile, style: str = Form(DEFAULT_STYLE_KEY)):
    try:
        caption_style = get_style(style)
    except KeyError:
        # Refuse rather than fall back: the app shows the user a style name,
        # and burning in a different one would make that label a lie.
        raise HTTPException(
            400, f"unknown style {style!r}; known: {sorted(CAPTION_STYLES)}"
        )

    job_id = uuid.uuid4().hex
    job_dir = WORK_DIR / job_id
    job_dir.mkdir(parents=True, exist_ok=True)
    src = job_dir / "in.mp4"
    src.write_bytes(await file.read())

    words = transcribe_words(str(src))
    out = job_dir / "out.mp4"
    if not words:
        # No speech: return the clip unchanged rather than failing.
        out.write_bytes(src.read_bytes())
        return {"id": job_id, "captions": 0, "style": caption_style.key}

    width, height = probe_frame_size(str(src))
    chunks = chunk_words(words, caption_style)
    ass_path = job_dir / "subs.ass"
    ass_path.write_text(
        build_ass(chunks, caption_style, width, height), encoding="utf-8"
    )
    burn(str(src), str(ass_path), str(out))
    return {"id": job_id, "captions": len(chunks), "style": caption_style.key}


@app.get("/caption/{job_id}/download")
def download(job_id: str):
    # job_id comes off the wire; without this check it is a path traversal
    # into the rest of the filesystem.
    if not job_id.isalnum():
        raise HTTPException(400, "bad job id")
    out = WORK_DIR / job_id / "out.mp4"
    if not out.exists():
        raise HTTPException(404, "unknown job id")
    return FileResponse(out, media_type="video/mp4", filename="captioned.mp4")


def transcribe_words(path: str) -> list[dict]:
    segments, _info = get_model().transcribe(
        path,
        word_timestamps=True,
        vad_filter=True,
        beam_size=5,
        condition_on_previous_text=False,
    )
    words = []
    for seg in segments:
        for w in seg.words or []:
            text = (w.word or "").strip()
            if text:
                words.append({"start": float(w.start), "end": float(w.end), "text": text})
    return words


def probe_frame_size(path: str) -> tuple[int, int]:
    """Actual frame size, so caption sizing matches the clip instead of
    assuming a 1080x1920 export. Falls back to that on any probe failure."""
    try:
        result = subprocess.run(
            [
                "ffprobe", "-v", "error",
                "-select_streams", "v:0",
                "-show_entries", "stream=width,height",
                "-of", "json",
                path,
            ],
            check=True,
            capture_output=True,
            text=True,
        )
        stream = json.loads(result.stdout)["streams"][0]
        width, height = int(stream["width"]), int(stream["height"])
        return (width, height) if width > 0 and height > 0 else DEFAULT_FRAME
    except (subprocess.CalledProcessError, OSError, ValueError, KeyError, IndexError):
        return DEFAULT_FRAME


def burn(src: str, ass_path: str, out: str) -> None:
    escaped = ass_path.replace("\\", "/").replace(":", "\\:").replace("'", "\\'")
    subprocess.run(
        [
            "ffmpeg", "-y", "-loglevel", "error",
            "-i", src,
            "-vf", f"ass='{escaped}'",
            "-c:v", "libx264", "-preset", "veryfast", "-crf", "20",
            "-c:a", "copy",
            out,
        ],
        check=True,
    )
