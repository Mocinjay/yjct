"""Fade Away captioning service — the swappable infra behind the app's
CaptioningProvider seam.

POST /caption (multipart: file) -> {"id": ...}
GET  /caption/{id}/download     -> captioned MP4

Pipeline (technique informed by studying SamurAIGPT's shorts generator,
implemented clean-room):
  1. faster-whisper transcription with word timestamps + VAD filter
     (int8 on CPU, float16 on CUDA)
  2. words grouped into short pop-in caption chunks (Shorts style)
  3. ffmpeg burns an ASS subtitle track onto the clip (libx264 + copy audio)

Run:
  pip install -r requirements.txt   # needs ffmpeg on PATH
  uvicorn main:app --host 0.0.0.0 --port 8787
"""
import os
import subprocess
import tempfile
import uuid
from pathlib import Path

from fastapi import FastAPI, HTTPException, UploadFile
from fastapi.responses import FileResponse

WHISPER_MODEL = os.getenv("WHISPER_MODEL", "base")
WORK_DIR = Path(os.getenv("WORK_DIR", tempfile.gettempdir())) / "fadeaway-captioning"
MAX_WORDS_PER_CAPTION = 3
MAX_CAPTION_SECONDS = 1.6

app = FastAPI(title="Fade Away Captioning")
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


@app.post("/caption")
async def caption(file: UploadFile):
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
        return {"id": job_id, "captions": 0}

    ass_path = job_dir / "subs.ass"
    chunks = chunk_words(words)
    ass_path.write_text(build_ass(chunks), encoding="utf-8")
    burn(str(src), str(ass_path), str(out))
    return {"id": job_id, "captions": len(chunks)}


@app.get("/caption/{job_id}/download")
def download(job_id: str):
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


def chunk_words(words: list[dict]) -> list[dict]:
    """Group words into short, punchy captions (Shorts style)."""
    chunks: list[dict] = []
    current: list[dict] = []
    for w in words:
        if current and (
            len(current) >= MAX_WORDS_PER_CAPTION
            or w["end"] - current[0]["start"] > MAX_CAPTION_SECONDS
        ):
            chunks.append(flush(current))
            current = []
        current.append(w)
    if current:
        chunks.append(flush(current))
    return chunks


def flush(words: list[dict]) -> dict:
    return {
        "start": words[0]["start"],
        "end": words[-1]["end"],
        "text": " ".join(w["text"] for w in words).upper(),
    }


ASS_HEADER = """[Script Info]
ScriptType: v4.00+
PlayResX: 1080
PlayResY: 1920
WrapStyle: 0

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
Style: Pop,Arial,110,&H00FFFFFF,&H00FFFFFF,&H00000000,&H80000000,-1,0,0,0,100,100,0,0,1,8,0,2,60,60,340,1

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
"""


def build_ass(chunks: list[dict]) -> str:
    lines = [ASS_HEADER]
    for c in chunks:
        text = c["text"].replace("\\", "").replace("{", "").replace("}", "")
        lines.append(
            f"Dialogue: 0,{ass_ts(c['start'])},{ass_ts(c['end'])},Pop,,0,0,0,,"
            f"{{\\fad(60,40)}}{text}\n"
        )
    return "".join(lines)


def ass_ts(seconds: float) -> str:
    cs = max(0, int(round(seconds * 100)))
    h, rem = divmod(cs, 360000)
    m, rem = divmod(rem, 6000)
    s, cs = divmod(rem, 100)
    return f"{h}:{m:02d}:{s:02d}.{cs:02d}"


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
