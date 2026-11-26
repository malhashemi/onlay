// Raster helpers for the fidelity gate's region diffs.

import { PNG } from "pngjs";

/** Paint `rect` opaque black in a PNG buffer (mask the op's target for A25). */
export function maskRect(
  buf: Buffer,
  rect: { x: number; y: number; width: number; height: number },
): Buffer {
  const png = PNG.sync.read(buf);
  const x0 = Math.max(0, Math.floor(rect.x));
  const y0 = Math.max(0, Math.floor(rect.y));
  const x1 = Math.min(png.width, Math.ceil(rect.x + rect.width));
  const y1 = Math.min(png.height, Math.ceil(rect.y + rect.height));
  for (let y = y0; y < y1; y += 1) {
    for (let x = x0; x < x1; x += 1) {
      const i = (y * png.width + x) * 4;
      png.data[i] = 0;
      png.data[i + 1] = 0;
      png.data[i + 2] = 0;
      png.data[i + 3] = 255;
    }
  }
  return PNG.sync.write(png);
}
