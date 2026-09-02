# tools/measure

Harnesses that produce numbers. Nothing in here ships in the app.

## ladder.sh — platform ingestion ladder

Tests one claim: that uploading a 1080x1920 canvas instead of our native 720x1280
Path A proxy wins back bitrate on the platform's side.

```sh
./ladder.sh prepare ~/Desktop/proxy-sample.mp4
# upload every arm, download each back
./ladder.sh compare 720p         ~/Downloads/tiktok-720-arm.mp4
./ladder.sh compare 1080p-native ~/Downloads/tiktok-1080-arm.mp4
./ladder.sh report
```

Name the arm exactly as `prepare` listed it. The name is how `compare` looks up
what was uploaded, and an unrecognised name loses the resolution check.

Outputs land in `tools/measure/out/` (git-ignored).

### What the arms are

| Arm | Built by | Purpose |
|-----|----------|---------|
| `reference.mp4` | 20s stream-copy of the source | The control. Every SSIM is against this, including the 720p arm's. |
| `source_720p.mp4` | stream-copy of the reference | What ships today. Bit-for-bit the reference, so anything measured after the round trip is the platform's doing. |
| `upscaled_1080p.mp4` | lanczos → 1080x1920, x264 crf 16 preset slow | Whether the platform rewards a 1080 label *at all*, given the upscale its best case so the resampler is not what loses. |
| `promoted_1080p.mp4` | `canvas/canvas_probe render` | The same canvas built by the code that would actually ship: AVFoundation's composition scaler off a `CGAffineTransform`, `AVAssetExportPresetHighestQuality`, captions laid out at the promoted size. |

### Why there are two 1080 arms

They answer different questions and only one of them decides the flag.

`upscaled_1080p.mp4` is lanczos plus x264 crf 16 preset slow. Nothing in the app
resamples with lanczos or encodes with x264, and the arm carries no captions at
all — so a win on it says the platform likes 1080, not that promoting our clips
would deliver that win. It is the sensitivity test.

`promoted_1080p.mp4` runs `CEPromotedRenderSize`, the same `canvasScale` concat
onto `preferredTransform`, the same `renderSize`, and the same export preset. It
is the artifact the flag would actually produce. **Judge `CECanvasPromotionEnabled`
on this arm.** It needs `canvas/canvas_probe` built; if it is missing, `prepare`
says so and skips it rather than quietly leaving you with only the sensitivity
test.

### Returned resolution is the decisive column

`compare` records what was sent alongside what came back and labels the return
`same` / `DOWNSCALED` / `upscaled`. A platform that hands the 1080 arm back at
720 never placed it on a higher rung — claim A did not happen, whatever the
bitrate says, and the sharper caption rasterisation the canvas bought has been
resampled away on the return trip. `report` fails the arm on that column alone.

Results written before these columns existed are moved aside to
`results.tsv.pre-resolution-columns` rather than appended to under a header that
would misdescribe them.

### Why SSIM is measured at 720p

Both returns are scaled down to the reference's geometry before scoring. The
question is how much of the original survived, not how convincing the platform's
own upscale looks at its own resolution. Scaling the reference *up* instead would
hand a free advantage to whichever arm came back larger, for reasons unrelated to
preserved detail.

### Caveats that decide whether this is a result or a coincidence

- **N=1 is not a result.** Platform ladders vary with account age, follower
  count, time of day, and A/B buckets you cannot see. Three runs per platform,
  minimum, and upload the two arms within minutes of each other.
- **Content decides bitrate too.** A static scene and a fast pan get different
  allocations at the same resolution. Use one source for all runs.
- **The download path matters.** A web-scraped download and an in-app "save
  video" often come from different rungs. Pick one method and keep it.
- **Audio is copied, not re-encoded,** so audio bitrate differences between arms
  are the platform's.

### The decision rule, agreed before running

Promote to a 1080 canvas only if the `1080p-native` arm returns **at 1080**, with
**both** a materially higher bitrate **and** an SSIM no worse than the 720p arm,
across at least three runs per platform. A return at 720 means the platform never
used the rung, so there is nothing to buy. A bitrate win with an SSIM loss means
the platform spent the extra bits re-encoding invented pixels — strictly worse
than shipping 720p.

`report` applies this rule and prints PASS/FAIL/HOLD per arm rather than leaving
it as prose beside the numbers.

If the rule is met, the switch is `CECanvasPromotionEnabled` in
`app/modules/clip-stitcher/ios/CaptionEngine.m`. It is `NO` until then, and
claim A is the only thing still holding it there — see `docs/VIDEO-QUALITY.md`
8.7. Run `canvas/fixtures.sh` before flipping; `prepare` runs the same guard
check before it builds the native arm.

## canvas/ — caption rasterisation

The other half of the hypothesis, which needs no upload. See `canvas/README.md`.
