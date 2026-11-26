import pixelmatch from "pixelmatch";
import { PNG } from "pngjs";
import { ssim } from "ssim.js";

export interface CompareResult {
  /** Mismatched-pixel ratio over the compared box, ignoring a 2px AA gutter. */
  mismatchRatio: number;
  /** Mean structural similarity (ssim.js), 1.0 = identical. */
  ssim: number;
  width: number;
  height: number;
  diffPixels: number;
  /** The rendered diff image (PNG) for artifact attachment on failure. */
  diffPng: Buffer;
}

/** Crop an RGBA buffer to `w×h` from the top-left (screenshots share origin). */
function cropTo(png: PNG, w: number, h: number): PNG {
  if (png.width === w && png.height === h) return png;
  const out = new PNG({ width: w, height: h });
  PNG.bitblt(png, out, 0, 0, w, h, 0, 0);
  return out;
}

/**
 * Region-aligned perceptual compare of two block screenshots (render spec §4.3
 * step 4). Both are rasterized by one Chromium at a pinned DPR, so this is a
 * device-consistent diff. Dimensions are aligned to the common top-left box
 * (a ±1px layout drift between live block and reconstruction block collapses to
 * the AA gutter rather than aborting the compare).
 */
export function comparePngs(aBuf: Buffer, bBuf: Buffer): CompareResult {
  const a = PNG.sync.read(aBuf);
  const b = PNG.sync.read(bBuf);
  // The two block regions MUST be dimensionally equal within the AA gutter
  // (F11/R10) — otherwise min-cropping to the common top-left box would hide a
  // layout collapse (a reconstruction that lost half its height would diff only
  // the overlapping top and pass at ~0%). A real size mismatch is a failed
  // compare (mismatchRatio 1.0), so the per-fixture threshold fails loudly.
  const GUTTER = 2;
  if (Math.abs(a.width - b.width) > GUTTER || Math.abs(a.height - b.height) > GUTTER) {
    const w = Math.min(a.width, b.width);
    const h = Math.min(a.height, b.height);
    return {
      mismatchRatio: 1,
      ssim: 0,
      width: w,
      height: h,
      diffPixels: w * h,
      diffPng: PNG.sync.write(new PNG({ width: Math.max(w, 1), height: Math.max(h, 1) })),
    };
  }
  const w = Math.min(a.width, b.width);
  const h = Math.min(a.height, b.height);
  const ca = cropTo(a, w, h);
  const cb = cropTo(b, w, h);

  const diff = new PNG({ width: w, height: h });
  const diffPixels = pixelmatch(ca.data, cb.data, diff.data, w, h, {
    threshold: 0.1,
    includeAA: false, // ignore antialiasing-only differences (the 2px gutter)
    alpha: 0.5,
  });

  const structural = ssim(
    { data: new Uint8ClampedArray(ca.data), width: w, height: h },
    { data: new Uint8ClampedArray(cb.data), width: w, height: h },
  );

  return {
    mismatchRatio: diffPixels / (w * h),
    ssim: structural.mssim,
    width: w,
    height: h,
    diffPixels,
    diffPng: PNG.sync.write(diff),
  };
}
