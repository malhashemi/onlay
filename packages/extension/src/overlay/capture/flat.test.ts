import { expect, test } from "bun:test";
import { scanFlat } from "./flat";

/** Build a row getter over a solid RGBA colour, with optional per-pixel overrides. */
function rowsOf(
  width: number,
  colour: [number, number, number, number],
  overrides: Map<string, [number, number, number, number]> = new Map(),
): (y: number) => Uint8ClampedArray {
  return (y: number) => {
    const row = new Uint8ClampedArray(width * 4);
    for (let x = 0; x < width; x += 1) {
      const px = overrides.get(`${x},${y}`) ?? colour;
      row.set(px, x * 4);
    }
    return row;
  };
}

test("a uniform raster scans flat", () => {
  expect(scanFlat(rowsOf(64, [17, 17, 17, 255]), 64, 24)).toBe(true);
});

test("one deviant pixel on a sampled coordinate breaks flatness", () => {
  // Small dims → the sample stride is 1, every pixel inspected.
  const overrides = new Map<string, [number, number, number, number]>([
    ["5,3", [200, 40, 40, 255]],
  ]);
  expect(scanFlat(rowsOf(16, [17, 17, 17, 255], overrides), 16, 8)).toBe(false);
});

test("an alpha-only difference also breaks flatness (transparent vs opaque black)", () => {
  const overrides = new Map<string, [number, number, number, number]>([["2,2", [0, 0, 0, 0]]]);
  expect(scanFlat(rowsOf(8, [0, 0, 0, 255], overrides), 8, 8)).toBe(false);
});

test("degenerate dimensions are not flat — they are nothing", () => {
  expect(scanFlat(rowsOf(8, [0, 0, 0, 255]), 0, 8)).toBe(false);
  expect(scanFlat(rowsOf(8, [0, 0, 0, 255]), 8, 0)).toBe(false);
});

test("large rasters are sampled, not exhaustively read (row getter called ≤ sample budget)", () => {
  let reads = 0;
  const getRow = (y: number): Uint8ClampedArray => {
    reads += 1;
    return rowsOf(4000, [9, 9, 9, 255])(y);
  };
  expect(scanFlat(getRow, 4000, 12_000)).toBe(true);
  expect(reads).toBeLessThanOrEqual(25);
});
