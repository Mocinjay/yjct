# tools/measure/stitch

Measures the defect `ClipStitcher.m`'s `take` anchor was changed to fix, and
proves the change fixes it.

`take` is now the video track's own end, `CMTimeRangeGetEnd(srcVideo.timeRange)`,
falling back to `asset.duration` only when there is no video track. It used to
be `asset.duration` unconditionally — the LONGER of the two tracks. Audio is
stamped from the host clock and video from frame PTS, so a dropped frame or a
late buffer leaves them disagreeing by tens of milliseconds, and taking the
longer of the two asks the shorter track for content it does not have.

## Why this needs its own instrument

Two things make the defect invisible to the obvious tests.

**It does not accumulate.** `cursor` is shared by both tracks and advances by
`take`, so every segment is re-anchored to the correct wall position at its own
boundary. A/V drift is 0 ms under the broken anchor and 0 ms under the fixed
one — `verify` asserts this — so a test that measured drift at 30/60/90 s would
have passed the broken code while the glitches were there. What the mismatch
produces is a hole of its own size at *each* boundary, so gap POSITION and SIZE
are what has to be asserted.

**It is not visible in the composition structure.** Asking `insertTimeRange`
for more than the source track holds is not clamped and not marked empty: the
segment reports `source` and `target` durations both equal to what was asked
for, off a track that ends earlier. An empty segment only ever appears from
`insertEmptyTimeRange` or from inserting past a track's end, and the stitcher
does neither — its ranges are contiguous by construction, so the composition
always *claims* to be dense.

So the probe decodes. In the picture the hole is a run of black frames
AVFoundation synthesizes to cover the shortfall; in the sound it is a run of
silence.

## Build

```sh
clang -fobjc-arc -O2 -Wno-deprecated-declarations \
  -framework Foundation -framework AVFoundation -framework CoreMedia \
  -framework CoreVideo -o stitch_probe stitch_probe.m
```

`stitch_probe.m` carries a copy of the composition loop from `ClipStitcher.m`,
parameterised on the anchor so both can be run against the same fixture. If
that loop changes, this stops describing the shipping code — that is the
maintenance cost of the tool, and the reason the copy is verbatim rather than
paraphrased. Deliberately not copied: `JVSLoadAssetKeys` and the export.
Neither moves a sample in time.

## Run

```sh
./fixtures.sh
```

Builds the fixtures with ffmpeg and runs `verify` against them. The mismatch
has to be real — `asset.duration` is read off the container's track headers —
so the fixtures mux separately generated tracks that genuinely end at different
times, with PCM audio because an AAC frame is 1024 samples and quantises a
track's duration to 21.3 ms steps at 48 kHz.

| Command | What it answers |
|---|---|
| `verify <seg.mp4>...` | Each fixture, both anchors, three repeats. Asserts gap count, position and size, plus zero A/V drift. Exits non-zero on any failure. |
| `gaps <video-end\|asset-duration> <seg.mp4>...` | The segment table and the decoded holes for an arbitrary set of segments. |

`verify` also asserts that at least one fixture produced a picture hole on the
`asset-duration` anchor. Without that the run would not distinguish the two
anchors, and every other line in it would have passed before the fix too.

## What it found

| Fixture | Mismatch | `asset-duration` (before) | `video-end` (ships) |
|---|---|---|---|
| `matched` | none | clean | clean |
| `audio_long` | audio 40 ms long | **40.0 ms black frame at every boundary** | clean |
| `audio_short` | audio 34 ms short | 34.0 ms silence at every boundary | 34.0 ms silence at every boundary |
| `video_only` | no audio track | clean | clean |

`audio_long` is the case the change is about, and the holes land exactly where
the reasoning said: at `k * take + videoEnd`, sized `take - videoEnd`.

`audio_short` is unchanged by it. When audio is the short track, both anchors
pick the video's end and the silence is there either way — there are no samples
to put in the hole. `ClipStitcher.m` logs that shortfall rather than correcting
it, and the number in that log is what would tell us whether correcting it is
worth it.

## Limitation

A source that genuinely cuts to black, or to silence, reads as a hole. That is
acceptable for synthetic fixtures and is why this is a fixture harness rather
than something to point at real clips.
