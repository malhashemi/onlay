// A look of a block inside a frame of this page that has no address of its
// own (A-3). The owner's content script takes it: the frame is same origin
// and part of the owner's page, so the walk and the harvest read the block's
// own document and window, with boxes carried into the owner's viewport
// through each frame element. Such a block gets no screenshot (2-A1,
// pipeline.ts): its structured capture is kept and the residue says why.
import { framePathTo } from "../anchors";
import { rectInOwner } from "../frame-path";
import type { WalkEnv } from "./walker";

/** The block sits in a frame of this page without an address of its own. */
export function inFrameOfPage(block: Element): boolean {
  const doc = block.ownerDocument;
  if (!doc || doc === document) return false;
  const path = framePathTo(doc);
  return path !== null && path.length > 0;
}

/**
 * What the walk reads for such a block: styles from the block's own window,
 * boxes in this page's viewport, links against the frame's own base. Null
 * for a block of this document (the walk's defaults).
 */
export function frameWalkEnv(block: Element): Partial<WalkEnv> | null {
  if (!inFrameOfPage(block)) return null;
  const doc = block.ownerDocument;
  const view = doc.defaultView;
  if (!view) return null;
  return {
    styleOf: (el, pseudo) =>
      view.getComputedStyle(el, pseudo ?? undefined) as unknown as CSSStyleDeclaration,
    rectOf: (el) => {
      const r = rectInOwner(el);
      return { x: r.left, y: r.top, width: r.width, height: r.height, top: r.top, left: r.left };
    },
    baseUrl: doc.baseURI,
  };
}
