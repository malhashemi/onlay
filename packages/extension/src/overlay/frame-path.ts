// A frame without an address of its own is part of the page that made it
// (A-3). An `about:blank`, `about:srcdoc` or same-origin `blob:` child frame
// is owned by its nearest ancestor document that has an http(s) address and
// the same origin. Only that owner's content script decides it: it reaches the
// frame's document as `contentDocument` through an iframe element of its own
// document chain, and checks the origin itself; nothing the frame says counts.
// An opaque origin (a sandbox without allow-same-origin), a `data:` frame or
// another origin's document gives the owner no `contentDocument` and stays
// out. Anchors name such a frame by `framePath`: the selectors of the iframe
// elements from the owner document down to the block's document.
import { LIMITS } from "@onlay/protocol";
import { isWebDocument } from "./frame-owner";

const FRAME_TAGS = new Set(["iframe", "frame"]);
// biome-ignore lint/suspicious/noControlCharactersInRegex: control characters are what it refuses
const CONTROL = /[\u0000-\u001f\u007f]/;

/** `win` holds a document without an address of its own, of origin `origin`. */
export function isAddressless(win: Window, origin: string): boolean {
  try {
    const protocol = win.location.protocol;
    if (protocol !== "about:" && protocol !== "blob:") return false;
    // `origin` is the document's own; an opaque one reads "null".
    return origin !== "null" && win.origin === origin;
  } catch {
    return false;
  }
}

/** The origin of a document's window; null when opaque or unreadable. */
function originOf(doc: Document): string | null {
  try {
    const o = doc.defaultView?.origin;
    return o && o !== "null" ? o : null;
  } catch {
    return null;
  }
}

/**
 * The document behind one frame element, when it is part of the document
 * that holds the element: an addressless document of `origin`. Null for
 * anything else (no frame element, another origin, an opaque origin, a page
 * with an address of its own).
 */
export function frameDocument(frame: Element | null, origin: string): Document | null {
  if (!frame || !FRAME_TAGS.has(frame.localName)) return null;
  try {
    const f = frame as HTMLIFrameElement;
    const win = f.contentWindow;
    const doc = f.contentDocument;
    if (!win || !doc || !isAddressless(win, origin)) return null;
    return doc;
  } catch {
    return null;
  }
}

/**
 * Follow a frame path from `owner`: each selector must name a frame element
 * of the current document whose document is part of the owner. Null when any
 * step leads nowhere.
 */
export function resolveFramePath(owner: Document, path: readonly string[]): Document | null {
  if (path.length === 0 || path.length > LIMITS.MAX_FRAME_PATH) return null;
  const origin = originOf(owner);
  if (!origin) return null;
  let doc = owner;
  for (const selector of path) {
    let frame: Element | null = null;
    try {
      frame = doc.querySelector(selector);
    } catch {
      return null;
    }
    const next = frameDocument(frame, origin);
    if (!next) return null;
    doc = next;
  }
  return doc;
}

/**
 * The frame path from `owner` down to `doc`: [] for the owner itself, null
 * when `doc` is not part of the owner (another origin, an opaque origin, an
 * ancestor with an address of its own on the way, or deeper than the limit).
 * The path is checked by following it back from the owner.
 */
export function framePathFor(
  doc: Document,
  owner: Document,
  selectorOf: (el: Element) => string,
): string[] | null {
  if (doc === owner) return [];
  const origin = originOf(owner);
  if (!origin) return null;
  const path: string[] = [];
  let d: Document = doc;
  while (d !== owner) {
    if (path.length >= LIMITS.MAX_FRAME_PATH) return null;
    const win = d.defaultView;
    if (!win || !isAddressless(win, origin)) return null;
    let frame: Element | null = null;
    try {
      frame = win.frameElement;
    } catch {
      return null;
    }
    if (!frame || !FRAME_TAGS.has(frame.localName)) return null;
    const selector = selectorOf(frame);
    if (!selector || selector.length > LIMITS.MAX_SELECTOR || CONTROL.test(selector)) return null;
    path.unshift(selector);
    d = frame.ownerDocument;
  }
  return resolveFramePath(owner, path) === doc ? path : null;
}

/**
 * Every document part of `owner` through its frames (not the owner itself),
 * outermost first, at most the frame path's depth down.
 */
export function ownedFrameDocuments(owner: Document): Document[] {
  const origin = originOf(owner);
  if (!origin) return [];
  const out: Document[] = [];
  const visit = (doc: Document, depth: number): void => {
    if (depth >= LIMITS.MAX_FRAME_PATH) return;
    for (const frame of doc.querySelectorAll("iframe, frame")) {
      const child = frameDocument(frame, origin);
      if (!child || out.includes(child)) continue;
      out.push(child);
      visit(child, depth + 1);
    }
  };
  visit(owner, 0);
  return out;
}

/** A box in the owner's viewport, and whether any of it shows through its frames. */
export interface OwnerRect {
  left: number;
  top: number;
  right: number;
  bottom: number;
  width: number;
  height: number;
  /** Some of it lies inside every frame's box on the way up. */
  inFrames: boolean;
}

/**
 * An element's box in the owner document's viewport: its own box moved by
 * the content box of each frame element on the way up to `owner`.
 */
export function rectInOwner(el: Element, owner: Document = document): OwnerRect {
  const r = el.getBoundingClientRect();
  let left = r.left;
  let top = r.top;
  let inFrames = true;
  let doc = el.ownerDocument;
  for (let i = 0; doc !== owner && i < LIMITS.MAX_FRAME_PATH; i += 1) {
    let frame: Element | null = null;
    try {
      frame = doc.defaultView?.frameElement ?? null;
    } catch {
      frame = null;
    }
    if (!frame) break;
    const view = doc.defaultView;
    // Outside this frame's own viewport: it does not show here.
    if (
      view &&
      (left + r.width < 0 || top + r.height < 0 || left > view.innerWidth || top > view.innerHeight)
    )
      inFrames = false;
    const fr = frame.getBoundingClientRect();
    const style = frame.ownerDocument.defaultView?.getComputedStyle(frame);
    left += fr.left + frame.clientLeft + (Number.parseFloat(style?.paddingLeft ?? "") || 0);
    top += fr.top + frame.clientTop + (Number.parseFloat(style?.paddingTop ?? "") || 0);
    doc = frame.ownerDocument;
  }
  return {
    left,
    top,
    right: left + r.width,
    bottom: top + r.height,
    width: r.width,
    height: r.height,
    inFrames,
  };
}

/**
 * Whether an owner page could take this addressless frame in: an ancestor
 * with an http(s) address and this frame's origin is reachable through
 * same-origin addressless parents. It only chooses the frame's own hint; the
 * owner checks for itself.
 */
export function reachableByOwner(win: Window): boolean {
  let origin: string;
  try {
    origin = win.origin;
  } catch {
    return false;
  }
  let w = win;
  for (let i = 0; i < LIMITS.MAX_FRAME_PATH; i += 1) {
    if (!isAddressless(w, origin)) return false;
    let parent: Window;
    try {
      parent = w.parent;
      if (parent === w) return false;
      void parent.document; // another origin's parent throws
    } catch {
      return false;
    }
    if (isWebDocument(parent)) return parent.origin === origin;
    w = parent;
  }
  return false;
}
