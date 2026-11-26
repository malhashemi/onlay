// Flat-raster detection (F31). A transient compositor artifact can hand
// `captureVisibleTab` a degenerate frame — a uniform dark box where the page
// demonstrably paints content (seen live: a `background-clip: text` variant
// witnessed as one flat colour). A flat stitched raster is CHEAP to detect and
// almost never legitimate at habitat scale, so the witness leg samples the
// stitched canvas and, on a flat verdict, forces a repaint and regrabs once.
//
// The sampler is pure (rows in, verdict out) so it unit-pins without a canvas;
// the SW feeds it `getImageData` rows.

/** Sample budget: at most this many rows / columns are inspected. */
const FLAT_SAMPLE_ROWS = 24;
const FLAT_SAMPLE_COLS = 64;

/**
 * True when every sampled pixel of the raster is the SAME RGBA value.
 * `getRow(y)` returns the raster row as RGBA bytes (length = width × 4).
 * Degenerate dimensions (≤ 0) are not flat — they are nothing.
 */
export function scanFlat(
  getRow: (y: number) => Uint8ClampedArray,
  width: number,
  height: number,
): boolean {
  if (width <= 0 || height <= 0) return false;
  const yStep = Math.max(1, Math.floor(height / FLAT_SAMPLE_ROWS));
  const xStep = Math.max(1, Math.floor(width / FLAT_SAMPLE_COLS));
  let ref: [number, number, number, number] | null = null;
  for (let y = 0; y < height; y += yStep) {
    const row = getRow(y);
    for (let x = 0; x < width; x += xStep) {
      const i = x * 4;
      if (ref === null) ref = [row[i] ?? 0, row[i + 1] ?? 0, row[i + 2] ?? 0, row[i + 3] ?? 0];
      else if (
        row[i] !== ref[0] ||
        row[i + 1] !== ref[1] ||
        row[i + 2] !== ref[2] ||
        row[i + 3] !== ref[3]
      ) {
        return false;
      }
    }
  }
  return ref !== null;
}
