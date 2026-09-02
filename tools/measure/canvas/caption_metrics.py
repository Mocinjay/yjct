#!/usr/bin/env python3
"""
Scores caption rasterisations against an ideal reference.

Claim B is "burned captions rasterise sharper at renderSize 1080x1920". That is
a statement about glyph rasterisation, so it is scored on the glyph band only:
whole-frame SSIM is dominated by the soft footage, which is exactly what
docs/VIDEO-QUALITY.md 4.3 says carries almost no detail, and it would bury the
effect.

Two delivery scenarios, because they answer different questions:

  native  the viewer is served each arm at its own resolution. Scored at 1080.
  return720
          the platform hands the 1080 arm back at 720 - the case that decides
          whether claim B survives claim A failing. Scored at 720.

Both arms are resampled to the scenario's geometry before scoring, so neither
is flattered by simply having more pixels.
"""

import sys
import numpy as np
from PIL import Image


def load_luma(path, size=None, resample=Image.LANCZOS):
    """Composite over black and return luma in [0,1] at `size`."""
    im = Image.open(path).convert("RGBA")
    if size is not None and im.size != size:
        im = im.resize(size, resample)
    a = np.asarray(im).astype(np.float64) / 255.0
    rgb, alpha = a[:, :, :3], a[:, :, 3:4]
    over_black = rgb * alpha
    return 0.2126 * over_black[:, :, 0] + 0.7152 * over_black[:, :, 1] + 0.0722 * over_black[:, :, 2]


def gaussian_kernel(sigma=1.5, radius=5):
    x = np.arange(-radius, radius + 1, dtype=np.float64)
    k = np.exp(-(x ** 2) / (2 * sigma ** 2))
    return k / k.sum()


def blur(img, k):
    pad = len(k) // 2
    p = np.pad(img, pad, mode="reflect")
    out = np.zeros_like(img)
    for i, w in enumerate(k):
        out += w * p[i:i + img.shape[0], pad:pad + img.shape[1]]
    p2 = np.pad(out, pad, mode="reflect")
    out2 = np.zeros_like(img)
    for i, w in enumerate(k):
        out2 += w * p2[pad:pad + img.shape[0], i:i + img.shape[1]]
    return out2


def ssim_map(a, b):
    """Standard gaussian-windowed SSIM, 11x11 sigma 1.5, on [0,1] data."""
    k = gaussian_kernel()
    C1, C2 = 0.01 ** 2, 0.03 ** 2
    mu_a, mu_b = blur(a, k), blur(b, k)
    saa = blur(a * a, k) - mu_a ** 2
    sbb = blur(b * b, k) - mu_b ** 2
    sab = blur(a * b, k) - mu_a * mu_b
    num = (2 * mu_a * mu_b + C1) * (2 * sab + C2)
    den = (mu_a ** 2 + mu_b ** 2 + C1) * (saa + sbb + C2)
    return num / den


def sobel(img):
    p = np.pad(img, 1, mode="edge")
    gx = (p[:-2, 2:] + 2 * p[1:-1, 2:] + p[2:, 2:]) - (p[:-2, :-2] + 2 * p[1:-1, :-2] + p[2:, :-2])
    gy = (p[2:, :-2] + 2 * p[2:, 1:-1] + p[2:, 2:]) - (p[:-2, :-2] + 2 * p[:-2, 1:-1] + p[:-2, 2:])
    return np.hypot(gx, gy)


def glyph_mask(reference, dilate=3):
    """Glyph fill plus a few pixels of its surround.

    Built from the reference, not from an arm, so both arms are scored over
    exactly the same pixels. The style draws a black outline at 6% of the font
    size, so this band is caption, not footage - which is what makes gradient
    magnitude here a measure of the text and not of what is behind it.
    """
    m = reference > 0.5
    out = m.copy()
    for _ in range(dilate):
        p = np.pad(out, 1, mode="constant", constant_values=False)
        out = (p[:-2, 1:-1] | p[2:, 1:-1] | p[1:-1, :-2] | p[1:-1, 2:] | out)
    return out


def edge_rise_width(img, reference, height):
    """Mean 10-90% transition width across glyph edges, as a fraction of frame height.

    Resolution independent on purpose: a 1080 canvas has more pixels across the
    same glyph, so a width in pixels would say the 1080 arm is *softer* purely
    for having more samples. What matters is how much of the picture the
    transition smears across.
    """
    edge = (sobel(reference) > 0.5) & glyph_mask(reference, dilate=2)
    if edge.sum() == 0:
        return float("nan")
    grad = sobel(img)
    # For a step of amplitude A resolved over w pixels, peak |grad| ~ A/w. The
    # 10-90% width is 0.8*A/peak. Amplitude is taken locally as the span of the
    # 5x5 neighbourhood so a grey glyph is not scored as a soft white one.
    p = np.pad(img, 2, mode="edge")
    stack = np.stack([p[i:i + img.shape[0], j:j + img.shape[1]]
                      for i in range(5) for j in range(5)])
    amp = stack.max(axis=0) - stack.min(axis=0)
    # sobel's kernel sums to 8 for a unit step across one pixel
    peak = grad / 8.0
    valid = edge & (peak > 1e-6) & (amp > 0.15)
    if valid.sum() == 0:
        return float("nan")
    width_px = 0.8 * amp[valid] / peak[valid]
    return float(np.mean(width_px) / height)


def score(arm_path, ref_path, geometry, label):
    w, h = geometry
    arm = load_luma(arm_path, (w, h))
    ref = load_luma(ref_path, (w, h))
    mask = glyph_mask(ref)

    s = ssim_map(arm, ref)[mask].mean()
    mse = ((arm - ref) ** 2)[mask].mean()
    psnr = 10 * np.log10(1.0 / mse) if mse > 0 else float("inf")
    grad = sobel(arm)[mask].mean()
    grad_ref = sobel(ref)[mask].mean()
    rise = edge_rise_width(arm, ref, h)

    return {
        "label": label,
        "ssim": s,
        "psnr": psnr,
        "grad": grad,
        "grad_ref": grad_ref,
        "grad_ratio": grad / grad_ref if grad_ref else float("nan"),
        "rise": rise,
        "mask_px": int(mask.sum()),
    }


def table(rows, geometry, title):
    w, h = geometry
    print(f"\n{title}  (scored at {w}x{h}, glyph band only, {rows[0]['mask_px']} px)")
    print(f"  {'arm':<26} {'SSIM':>8} {'PSNR dB':>9} {'edge |grad|':>12} "
          f"{'vs ideal':>9} {'10-90% rise':>12}")
    for r in rows:
        print(f"  {r['label']:<26} {r['ssim']:>8.5f} {r['psnr']:>9.3f} "
              f"{r['grad']:>12.5f} {r['grad_ratio']:>8.3f}x {r['rise']*100:>11.4f}%")
    print(f"  {'(ideal reference)':<26} {1.0:>8.5f} {'inf':>9} "
          f"{rows[0]['grad_ref']:>12.5f} {1.0:>8.3f}x")


def main():
    nat720, nat1080, ide720, ide1080 = sys.argv[1:5]

    # Decisive scenario: the platform hands both arms back at 720.
    rows = [
        score(nat720, ide720, (720, 1280), "720 render (ships today)"),
        score(nat1080, ide720, (720, 1280), "1080 render -> 720"),
    ]
    table(rows, (720, 1280), "SCENARIO return720 - platform delivers 720")
    d = rows[1]["ssim"] - rows[0]["ssim"]
    print(f"  delta SSIM (1080 arm - 720 arm): {d:+.5f}")
    print(f"  delta edge acuity:               {rows[1]['grad']/rows[0]['grad']:.4f}x")

    # The other scenario: each arm is served at its own resolution.
    rows = [
        score(nat720, ide1080, (1080, 1920), "720 render -> 1080"),
        score(nat1080, ide1080, (1080, 1920), "1080 render (native)"),
    ]
    table(rows, (1080, 1920), "SCENARIO native - platform delivers each arm as sent")
    d = rows[1]["ssim"] - rows[0]["ssim"]
    print(f"  delta SSIM (1080 arm - 720 arm): {d:+.5f}")
    print(f"  delta edge acuity:               {rows[1]['grad']/rows[0]['grad']:.4f}x")


if __name__ == "__main__":
    main()
