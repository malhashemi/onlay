// The quiet "Capture due" duty — pure decision model (Stage 2 §3).
//
// A fresh-look request rides the interactions-state frame as `s.resnap` (§2.4).
// The overlay surfaces the duty ONLY to a Full client whose current page holds
// the anchored interaction, and ONLY for an element/selection anchor a Full
// client can actually re-capture. This module isolates that decision so the
// thread header + command-bar surfaces stay thin and the logic is unit-tested
// without a DOM (§6 test 7). No chrome, no DOM.
import type { RawInteractionSnapshot } from "@onlay/protocol";
import { anchorIsCapturable } from "@onlay/render/interaction-view";
import { samePage } from "./page-url";

/**
 * The pending fresh-look duty shape — the protocol's own `resnap` field (§2.4,
 * now landed on `InteractionSnapshotSchema`), named here so the surfaces depend
 * on one explicit type rather than an inline shape.
 */
export type ResnapPending = NonNullable<RawInteractionSnapshot["resnap"]>;

/** The pending duty on a snapshot, or undefined when none is outstanding. */
export function resnapOf(s: RawInteractionSnapshot): ResnapPending | undefined {
  return s.resnap;
}

/** Live states still carry a dischargeable duty; a closed place clears it (§2.2). */
const LIVE = new Set(["open", "answered", "working", "implemented", "verifying"]);

/**
 * A fresh look is the requester's or the author's to take: anyone else who
 * happens to view the same page is never asked to capture it.
 */
export function mayFulfilFreshLook(s: RawInteractionSnapshot, selfId: string | null): boolean {
  if (selfId === null) return false;
  return s.resnap?.requestedBy === selfId || s.authorId === selfId;
}

/**
 * Whether this interaction's anchor is one a Full client can actually re-capture
 * (element/selection). Page-level and unanchored places have NO in-overlay
 * capture path, so no §3 duty surface (thread chip, "Capture due" group) will
 * ever show or discharge a duty lit on them — the request affordance must mirror
 * this so it never offers a duty no capture surface can honour (fable-4).
 */
export function isCapturableAnchor(s: RawInteractionSnapshot): boolean {
  return anchorIsCapturable(s.anchor);
}

/**
 * Is this interaction capture-due on the given page? A fresh-look duty surfaces
 * only for a LIVE, element/selection-anchored interaction the current frame
 * holds — the three conditions a Full client needs to resolve the anchor and
 * capture a fresh look (§3). `frameHref` omitted skips the page test (callers
 * whose snapshot list is already page-scoped, e.g. the overlay's `interactions()`).
 */
export function isCaptureDue(
  s: RawInteractionSnapshot,
  selfId: string | null,
  frameHref?: string,
): boolean {
  if (resnapOf(s) === undefined) return false;
  if (!mayFulfilFreshLook(s, selfId)) return false;
  if (!LIVE.has(s.state)) return false;
  if (!isCapturableAnchor(s)) return false;
  if (frameHref !== undefined && !samePage(s.url, frameHref)) return false;
  return true;
}

/** The on-page interactions with an outstanding fresh-look duty (the command-bar
 *  "Capture due" group / any list surface), oldest request first — the longest-
 *  waiting duty leads. */
export function captureDue<S extends RawInteractionSnapshot>(
  snaps: readonly S[],
  selfId: string | null,
  frameHref?: string,
): S[] {
  return snaps
    .filter((s) => isCaptureDue(s, selfId, frameHref))
    .sort((a, b) => (resnapOf(a)?.requestedAt ?? 0) - (resnapOf(b)?.requestedAt ?? 0));
}
