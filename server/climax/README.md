# Climax-First editor

Finds the most engaging moment in a chronological video and rebuilds it as a
hook-first cut:

```
[best 3-7s] -> [0.5s black] -> [complete original]
```

Offline CLI today. The scoring engine reads a rolling window over a feature
timeline, so moving to a live 30-second rolling buffer means changing where the
features come from, not how they are scored.

## Run

```bash
cd server/climax
python3 -m venv .venv && source .venv/bin/activate
pip install -r requirements.txt      # ffmpeg must be on PATH
python main.py input.mp4
```

Writes `climax_edited_output.mp4` plus `climax_edited_output.hook.json` with the
full score breakdown.

```bash
python main.py in.mp4 --dry-run --top 5        # score only, no encode
python main.py in.mp4 --weights 0.5,0.2,0.2,0.1
python main.py in.mp4 --no-speech              # skip whisper entirely
python main.py in.mp4 --window-sizes 2,3,4 --stride 0.25
```

## How it works

Four modalities are scored independently over every candidate window, then
combined:

| Modality | Default | Signals |
|---|---|---|
| Audio | 35% | RMS energy, spectral flux, zero-crossing rate, onset peaks |
| Visual | 25% | Sparse Lucas-Kanade optical flow, frame difference, scene change |
| Speech | 25% | Keyword density, speaking rate, repetition, emphasis |
| Novelty | 15% | Change against the preceding 5 seconds |

Every extractor resamples onto one shared 20 Hz grid, so scoring a window is
two array indices and never an alignment problem. Features are min-max
normalised **across the candidates of this video** — the question is "which
moment is the peak of this video", not "is this video loud".

Speech excitement deliberately avoids sentiment: "this is terrible" and "this is
unbelievable" are opposite sentiment and identical excitement. Delivery is the
signal — how fast, how repetitive, how stretched the words are.

`confidence` is not the score. It blends the winner's score with how far it
stands clear of the pack (`0.6*score + 0.4*margin`), so footage where nothing
stands out reports low confidence even though some window still ranked first.

Full derivation is in the `scoring_algorithm.py` module docstring.

## Output

```json
{
  "start": 4.0, "end": 7.0,
  "confidence": 0.803, "score": 0.6717,
  "reason": {"audio": 0.7028, "visual": 0.5817, "speech": 0.8646, "novelty": 0.4841},
  "detail": {"speech.speaking_rate": 1.0, "visual.scene_change": 0.9986, ...}
}
```

`reason` is per-modality, `detail` is per-signal. Both exist so a bad pick can
be diagnosed rather than guessed at.

## Caching

Features and transcripts are cached under `.climax-cache/`, keyed by the content
hash of the input plus the extraction parameters. Re-running with different
weights, window sizes or keywords is instant — whisper and OpenCV do not re-run.
Changing `--grid-hz`, `--sample-fps` or `--model` invalidates the cache, as it
should.

## Quality

The original is never re-encoded. Parts are concatenated through MPEG-TS with
`-c copy`; only the hook (when its start is not keyframe-aligned) and the
generated transition are encoded, using `h264_videotoolbox` / `h264_nvenc` /
`libx264 -crf 18` in that order of preference. If anything in that path is not
applicable — exotic codec, mismatched parameters — it falls back to a single
`filter_complex` concat and re-encodes, because a correct file beats a fast one.

## Modules

| File | Responsibility |
|---|---|
| `main.py` | Orchestration, caching, CLI |
| `audio_vision_engine.py` | Audio + visual features onto a shared grid |
| `transcriber.py` | faster-whisper wrapper, word-level timestamps |
| `scoring_algorithm.py` | Rolling-window hook scoring |
| `editor.py` | ffmpeg assembly |

Each is swappable behind a `Protocol` (`FeatureExtractor`, `Transcriber`,
`Scorer`). A different scoring engine only has to return `HookWindow`s.

## Notes

- Silent or speechless footage is handled: whisper's VAD returns nothing, and
  the speech weight is redistributed proportionally across the other three
  modalities rather than pinning 25% of every window's score to zero.
- Exclamation marks are a weak emphasis signal — whisper's smaller models
  punctuate almost entirely with periods. Word-duration stretch carries that
  component; see the comment in `speech_features`.
- `WHISPER_MODEL` env var picks the model (`base` default), same as
  `server/captioning`.
