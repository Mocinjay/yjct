# Captioning service

The external infra behind the app's `CaptioningProvider` seam (Pro tier).
Self-hostable; the app only knows the HTTP contract below, so this can be
replaced by any vendor without app changes.

## Run

```bash
cd server/captioning
python3 -m venv .venv && source .venv/bin/activate
pip install -r requirements.txt      # ffmpeg must be on PATH
uvicorn main:app --host 0.0.0.0 --port 8787
```

Then in the app: Settings → Connections → **Captioning service URL** →
`http://<your-mac-ip>:8787` (phone and Mac on the same network).

## Contract

| Endpoint | In | Out |
|---|---|---|
| `POST /caption` | multipart `file` (MP4) | `{"id": "...", "captions": N}` |
| `GET /caption/{id}/download` | — | captioned MP4 |

## How it works

faster-whisper (word timestamps, VAD) → words grouped into ≤3-word pop-in
chunks → ASS subtitles burned with ffmpeg (1080×1920 canvas, bold white,
heavy outline, lower-third). Clips with no speech come back unchanged.

`WHISPER_MODEL` env var picks the model (`base` default; `small`/`medium`
for better accuracy, `tiny` for speed).
