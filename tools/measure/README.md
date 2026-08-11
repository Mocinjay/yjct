# tools/measure

Harnesses that produce numbers. Nothing in here ships in the app.

## ladder.sh — platform ingestion ladder

Tests one claim: that uploading a 1080x1920 canvas instead of our native 720x1280
Path A proxy wins back bitrate on the platform's side.

```sh
./ladder.sh prepare ~/Desktop/proxy-sample.mp4
# upload both arms, download both back
./ladder.sh compare 720p  ~/Downloads/tiktok-720-arm.mp4
./ladder.sh compare 1080p ~/Downloads/tiktok-1080-arm.mp4
./ladder.sh report
```

Outputs land in `tools/measure/out/` (git-ignored).

### What the arms are

| Arm | Built by | Purpose |
|-----|----------|---------|
| `reference.mp4` | 20s stream-copy of the source | The control. Every SSIM is against this, including the 720p arm's. |
| `source_720p.mp4` | stream-copy of the reference | What ships today. Bit-for-bit the reference, so anything measured after the round trip is the platform's doing. |
| `upscaled_1080p.mp4` | lanczos → 1080x1920, x264 crf 16 preset slow | The hypothesis, given its best case so the resampler is not what loses. |

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

Promote to a 1080 canvas only if the 1080p arm returns with **both** a materially
higher bitrate **and** an SSIM no worse than the 720p arm, across at least three
runs. A bitrate win with an SSIM loss means the platform spent the extra bits
re-encoding invented pixels — strictly worse than shipping 720p.

If the rule is met, the switch is `CECanvasPromotionEnabled` in
`app/modules/clip-stitcher/ios/CaptionEngine.m`. It is `NO` until then.
