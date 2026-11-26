// A block picked in a child frame with its own address: the frame maps the
// click through where the placement says its viewport sits; the top frame
// opens the card there only for a point inside its own viewport.
import { expect, test } from "bun:test";
import { parsePlacement, placePoint, pointInView } from "./frame-place";

const ok = { ok: true, origin: { x: 230, y: 140 }, scale: { x: 2, y: 2 } };

test("only a whole answer is a placement", () => {
  expect(parsePlacement(ok)).toEqual({ origin: ok.origin, scale: ok.scale });
  expect(parsePlacement({ ok: false, reason: "transformed" })).toBeNull();
  expect(parsePlacement({ ...ok, scale: { x: 0, y: 1 } })).toBeNull();
  expect(parsePlacement({ ...ok, origin: { x: Number.NaN, y: 0 } })).toBeNull();
  expect(parsePlacement(undefined)).toBeNull();
});

test("the click maps into the tab's viewport", () => {
  const p = parsePlacement(ok);
  if (!p) throw new Error("no placement");
  expect(placePoint(p, { x: 5, y: 5 })).toEqual({ x: 240, y: 150 });
});

test("a card opens at a point only when it lies inside the top frame's viewport", () => {
  const view = { width: 1000, height: 800 };
  expect(pointInView({ x: 10, y: 20 }, view)).toBe(true);
  expect(pointInView({ x: -1, y: 20 }, view)).toBe(false);
  expect(pointInView({ x: 10, y: 900 }, view)).toBe(false);
  expect(pointInView({ x: "10", y: 20 }, view)).toBe(false);
  expect(pointInView(undefined, view)).toBe(false);
});
