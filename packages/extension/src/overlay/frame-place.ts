// A composer card that opens beside a block picked in a child frame with an
// address of its own. The card is the top frame's; the block is the frame's.
// Once, when the pick completes, the frame asks where its viewport sits in
// the tab (the look's locate chain in its `place` phase, sw/frame-look.ts),
// maps the click there into the tab itself, and tells the top frame
// (`framePlaced`, relayed by the service worker and stamped with the frame's
// document). The top frame opens the card beside the click when that comes in
// time and lands in its viewport, otherwise centred; either way the card then
// stays where it is, tied to nothing, like a card the person moved.
//
// Nothing here is trusted from a page, and a wrong number is harmless: it is
// only where a card is first drawn.

/** How long the top frame waits for a placement before it opens the card centred. */
export const PLACE_WAIT_MS = 500;

/** Where a child frame's viewport sits in the tab. */
export interface Placement {
  origin: { x: number; y: number };
  scale: { x: number; y: number };
}

const num = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);

/** The service worker's answer to a `place` locate, or null when it placed nothing. */
export function parsePlacement(r: unknown): Placement | null {
  const o = r as Record<string, unknown> | null;
  if (!o || typeof o !== "object" || o.ok !== true) return null;
  const origin = o.origin as Record<string, unknown> | null;
  const scale = o.scale as Record<string, unknown> | null;
  if (!origin || !num(origin.x) || !num(origin.y)) return null;
  if (!scale || !num(scale.x) || !num(scale.y) || !(scale.x > 0) || !(scale.y > 0)) return null;
  return { origin: { x: origin.x, y: origin.y }, scale: { x: scale.x, y: scale.y } };
}

/** A point of the frame's viewport, in the tab's. */
export function placePoint(p: Placement, at: { x: number; y: number }): { x: number; y: number } {
  return { x: p.origin.x + at.x * p.scale.x, y: p.origin.y + at.y * p.scale.y };
}

/** A point the top frame may open a card at: finite, and inside its viewport. */
export function pointInView(v: unknown, view: { width: number; height: number }): boolean {
  const p = v as Record<string, unknown> | null;
  if (!p || typeof p !== "object" || !num(p.x) || !num(p.y)) return false;
  return p.x >= 0 && p.y >= 0 && p.x <= view.width && p.y <= view.height;
}
