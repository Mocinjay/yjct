# Captioning service

The external infra behind the app's `CaptioningProvider` seam (Pro tier).
Self-hostable; the app only knows the HTTP contract below, so this can be
replaced by any vendor without app changes.

> **iOS does not use this.** Captioning runs on the phone there —
> `OnDeviceCaptioningProvider` plus the `CaptionEngine` native module. This
> service is the **Android** path, and the iOS fallback when a locale has no
> offline dictation. The timing rules here are mirrored in
> `app/src/captions/captionTimeline.ts`; `captionTimeline.test.ts` asserts the
> chunking constants match, so change one and change the other.

## Run

```bash
cd server/captioning
python3 -m venv .venv && source .venv/bin/activate
pip install -r requirements.txt      # ffmpeg + ffprobe must be on PATH
uvicorn main:app --host 0.0.0.0 --port 8787
```

Then in the app: Settings → Connections → **Captioning service URL** →
`http://<your-mac-ip>:8787` (phone and Mac on the same network).

## Contract

| Endpoint | In | Out |
|---|---|---|
| `GET /styles` | — | `{"default": "classic", "styles": [...]}` |
| `POST /caption` | multipart `file` (MP4) + `style` | `{"id", "captions", "style"}` |
| `GET /caption/{id}/download` | — | captioned MP4 |

An unknown `style` is a 400, never a silent fallback — the app has already
shown the wearer which style they picked.

## Styles

| Key | Look |
|---|---|
| `classic` | Arial Black, uppercase, heavy outline, **gold on the word being said** |
| `clean` | Arial, sentence case, soft shadow, whole phrase at once |
| `boxed` | Arial bold, uppercase, solid black bar, gold on the live word |

Defined in `captions.py` (`CAPTION_STYLES`). `app/src/captions/captionStyles.ts`
mirrors the keys and an approximation of each look for the Settings preview —
change one, change the other.

Fonts are resolved by fontconfig at burn time. If `Arial Black` is not
installed, libass silently substitutes; install the font or edit the style if
the result looks wrong.

## How it works

faster-whisper (word timestamps, VAD) → words grouped into captions →
ASS subtitles burned with ffmpeg (libx264, audio copied). Clips with no
speech come back unchanged.

Two things the timing depends on, both in `captions.py`:

- **Per-word events.** A highlighting style emits one ASS `Dialogue` line per
  word, each redrawing the whole caption with a different word recoloured. A
  word stays lit until the *next* word starts, not until it stops being
  spoken, so the highlight does not blink off in the gaps between words.
- **No overlap.** Each caption lingers `CAPTION_HOLD_SECONDS` past its last
  word, clamped to the next caption's entrance. Two overlapping `Dialogue`
  lines render stacked on top of each other, which is what a naive hold
  produces.

Caption size and position are fractions of the frame, and the frame is probed
with `ffprobe` — the same style looks right on landscape glasses footage and
on a vertical export, instead of assuming a 1080×1920 canvas.

## Tests

`captions.py` has no dependencies, so the timing logic is testable without a
model download:

```bash
cd server/captioning && python3 -m unittest
```

## Config

`WHISPER_MODEL` picks the model (`base` default; `small`/`medium` for better
accuracy, `tiny` for speed). `WORK_DIR` sets where jobs are staged.

## Not production

Single process, no auth, and job directories under `WORK_DIR` are never
cleaned up. Fine on a LAN; not something to expose to the internet as-is.
