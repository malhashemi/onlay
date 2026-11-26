// The overlay's host: always a plain `div` carrying `data-onlay-root` and
// nothing else that names content. A hyphenated custom tag can be defined by
// the page later and the mounted host upgraded, so there is none. The overlay
// only ever renders into a root this script created itself, and the host must
// stay where it was mounted: a direct child of the document's root element, in
// the light DOM (`hostInPlace`). Everything that has to find the host (the
// capture pipeline's hide list, the page-body serializer) asks `overlayHost()`
// for the reference this script holds, never a selector.

export interface MountedHost {
  host: HTMLElement;
  root: ShadowRoot;
  /** The document this script was injected into and mounted the host in. */
  doc?: Document;
}

let current: HTMLElement | null = null;
/** Bumped on every mount: a capture compares it to see whether the host changed. */
let mounts = 0;
/** Captures in flight: while above zero, every host this script mounts is hidden. */
let captureHolds = 0;
/** What waits for the overlay to show again (`whenShown`). */
const shownWaiters = new Set<() => void>();

/**
 * Run `fn` once the overlay is no longer held hidden for a capture: now, when
 * it is not. Nothing inside a hidden host can take focus, so focus waits here.
 */
export function whenShown(fn: () => void): void {
  if (captureHolds === 0) fn();
  else shownWaiters.add(fn);
}

/** The host this content script mounted, or null before it has. */
export function overlayHost(): HTMLElement | null {
  return current;
}

/** Style the host: fixed, zero-size, topmost, and visible whatever the page's styles say. */
function style(host: HTMLElement): void {
  host.style.position = "fixed";
  host.style.top = "0";
  host.style.left = "0";
  host.style.width = "0";
  host.style.height = "0";
  host.style.zIndex = "2147483647";
  setCaptureHidden(host, captureHolds > 0);
}

/**
 * Hide or show the whole overlay for a capture (C-1). `visibility` alone is
 * inherited, so any descendant that says `visibility: visible` would still
 * paint; `opacity: 0` on the host takes every descendant with it and none can
 * opt out (the overlay puts nothing in the top layer). Both are `!important`
 * inline, so no page rule outranks them.
 */
function setCaptureHidden(host: HTMLElement, hidden: boolean): void {
  if (hidden) {
    host.style.setProperty("visibility", "hidden", "important");
    host.style.setProperty("opacity", "0", "important");
  } else {
    host.style.setProperty("visibility", "visible");
    host.style.removeProperty("opacity");
  }
}

/** The root Chrome says the element has, open or closed (undefined when it can't tell). */
function actualRoot(el: Element): ShadowRoot | null | undefined {
  const api = (
    globalThis as {
      chrome?: { dom?: { openOrClosedShadowRoot?(e: Element): ShadowRoot | null } };
    }
  ).chrome?.dom?.openOrClosedShadowRoot;
  return api ? api(el) : undefined;
}

/** Create and insert a fresh host and its root. Throws when it can't be ours. */
export function mountHost(doc: Document, mode: ShadowRootMode): MountedHost {
  const host = doc.createElement("div");
  host.setAttribute("data-onlay-root", "");
  const root = host.attachShadow({ mode });
  style(host);
  doc.documentElement.appendChild(host);
  const seen = actualRoot(host);
  if (seen !== undefined && seen !== root) {
    host.remove();
    throw new Error("onlay: the host's root is not ours");
  }
  current = host;
  mounts += 1;
  return { host, root, doc };
}

/**
 * The host is where it was mounted: a direct light-DOM child of the root
 * element of the document this script mounted it in (an adopted host has
 * another `ownerDocument`, and is out of place).
 */
export function hostInPlace(m: MountedHost): boolean {
  const doc = m.doc ?? m.host.ownerDocument;
  return (
    m.host.ownerDocument === doc &&
    m.host.isConnected &&
    m.host.getRootNode() === doc &&
    m.host.parentNode === doc.documentElement
  );
}

/** How many hosts this script has mounted: changes whenever the host is replaced. */
export function hostMounts(): number {
  return mounts;
}

/** Forget the current host (the overlay stays down): nothing is hidden or found by reference. */
export function dropHost(): void {
  current = null;
}

/**
 * Hide the overlay for a capture (3b-C1), through this script's own live
 * handle: whatever host is current now, and any host mounted before the
 * returned release runs, stays hidden. Releases nest; the last one shows the
 * current host again.
 */
export function holdHiddenForCapture(): () => void {
  captureHolds += 1;
  if (current) setCaptureHidden(current, true);
  let released = false;
  return () => {
    if (released) return;
    released = true;
    captureHolds -= 1;
    if (captureHolds > 0) return;
    if (current) setCaptureHidden(current, false);
    const waiting = [...shownWaiters];
    shownWaiters.clear();
    for (const fn of waiting) fn();
  };
}

/** The key under which a frame's content script publishes its hider on its own window. */
const HIDER = Symbol.for("onlay.overlay.hideForCapture");

/**
 * Publish this frame's hider on the content script's own (isolated-world)
 * window, so a capture in a same-origin parent can hide this frame's overlay
 * (its pins) through this script's handle. The page's own scripts cannot see
 * or replace it.
 */
export function publishHider(win: Window): void {
  try {
    Object.defineProperty(win, HIDER, { value: holdHiddenForCapture, configurable: false });
  } catch {
    /* already published */
  }
}

interface Box {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** The overlay in a capture's same-origin child frames, held hidden (C-1). */
export interface ChildFrameHold {
  /**
   * Look for same-origin frames again (inside open and closed shadow roots
   * too) and hide the overlay in every one not hidden yet. Returns a mark: the
   * witness takes one right before each grab.
   */
  sweep(): number;
  /**
   * Sweep again, then: every same-origin frame whose box touches `rect`
   * (document space of the captured page) either has no overlay or has held
   * its hide since `mark`, in the same document. False means the tile may show
   * the overlay of some frame, so its raster must go.
   */
  heldSince(rect: Box, mark: number): boolean;
  /**
   * Watch frames for one grab (2-C1), from right after the sweep that made
   * `mark`: the captured document, every shadow root and same-origin frame
   * document the hold knows, for frame elements added, removed, moved to
   * another parent, or given a new `src` / `srcdoc`. The returned check
   * (called once, after the grab) is false when any of that happened, or when
   * a frame that touched `rect` before the grab no longer does after it.
   * Also false (F-7) when a shadow root that no sweep before the grab knew
   * holds a frame after it (an element added during the grab is looked at
   * for a shadow root, and that root watched, as it is seen), or when any
   * frame's box, of any origin, moved into or out of `rect` at any animation
   * frame during the grab, by CSS alone included.
   */
  watch(rect: Box, mark: number): () => boolean;
  /** Show every frame's overlay again. Idempotent. */
  release(): void;
}

/** One same-origin frame the hold has seen. */
interface HeldFrame {
  doc: Document;
  /** The frame's own release, once its overlay is hidden (no hider yet: no overlay there). */
  release: (() => void) | null;
  /** The sweep that hid it. */
  since: number;
  /** Its box in the captured page's document space, as of the last sweep. */
  box: Box;
  /** Found by the last sweep (still in the page). */
  seen: number;
}

/** How deep same-origin frames are followed. */
const MAX_FRAME_DEPTH = 8;

/** The element's shadow root, open or closed where Chrome can tell; null when none. */
function rootOf(el: Element): ShadowRoot | null {
  try {
    const seen = actualRoot(el);
    return seen === undefined ? el.shadowRoot : seen;
  } catch {
    return null;
  }
}

const FRAMES = "iframe, frame";

/**
 * Frames in a document and in every shadow root under it, open or closed;
 * `roots` collects those roots, `hosts` every shadow host whose tree holds a
 * frame (a mutation can only see such a host, never the frame inside it).
 */
function framesIn(root: Document | ShadowRoot, roots?: Set<Node>, hosts?: Set<Element>): Element[] {
  roots?.add(root);
  const out = [...root.querySelectorAll(FRAMES)];
  for (const el of root.querySelectorAll("*")) {
    const shadow = rootOf(el);
    if (!shadow) continue;
    const inside = framesIn(shadow, roots, hosts);
    if (inside.length > 0) hosts?.add(el);
    out.push(...inside);
  }
  return out;
}

/** A frame element, or a shadow host known to hold one (3-C2), is or is inside `node`. */
function holdsFrame(node: Node, hosts: ReadonlySet<Element>): boolean {
  if (node.nodeType !== 1) return false;
  const el = node as Element;
  if (el.localName === "iframe" || el.localName === "frame") return true;
  try {
    if (el.querySelector(FRAMES) !== null) return true;
    for (const h of hosts) if (h === el || el.contains(h)) return true;
    return false;
  } catch {
    return true;
  }
}

/** One batch of mutations touched a frame: one came, went, moved or was pointed elsewhere. */
function framesMutated(records: MutationRecord[], hosts: ReadonlySet<Element>): boolean {
  for (const r of records) {
    if (r.type === "attributes") {
      const name = (r.target as Element).localName;
      if (name === "iframe" || name === "frame") return true;
      continue;
    }
    for (const n of r.addedNodes) if (holdsFrame(n, hosts)) return true;
    for (const n of r.removedNodes) if (holdsFrame(n, hosts)) return true;
  }
  return false;
}

/**
 * A frame element's box in `doc`'s document space now: its own client box,
 * plus the boxes of the same-origin frames it sits inside, plus `doc`'s
 * scroll. Null when the chain can't be read.
 */
function boxInDoc(doc: Document, f: Element): Box | null {
  try {
    const r = f.getBoundingClientRect();
    let x = r.left;
    let y = r.top;
    let w = f.ownerDocument.defaultView;
    for (let depth = 0; w && w.document !== doc && depth <= MAX_FRAME_DEPTH; depth += 1) {
      const outer = w.frameElement;
      if (!outer) return null;
      const o = outer.getBoundingClientRect();
      x += o.left;
      y += o.top;
      w = outer.ownerDocument.defaultView;
    }
    const top = doc.defaultView;
    return {
      x: x + (top?.scrollX ?? 0),
      y: y + (top?.scrollY ?? 0),
      width: r.width,
      height: r.height,
    };
  } catch {
    return null;
  }
}

function touches(a: Box, b: Box): boolean {
  return a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;
}

/**
 * Hide the overlay in every same-origin child frame of `doc`, recursively and
 * through shadow roots, via each frame's published hider. A frame that turns
 * up later (or whose content script publishes its hider later) is hidden by
 * the next sweep; `heldSince` tells the witness whether a tile can be trusted.
 */
export function holdChildFramesHidden(doc: Document): ChildFrameHold {
  const held = new Map<Element, HeldFrame>();
  /**
   * Every frame element any sweep found, of any origin, with the offset of
   * the document it sits in (the captured page's document space) as of the
   * sweep that last saw it: what a grab samples on animation frames (F-7).
   */
  const everyFrame = new Map<Element, { seen: number }>();
  /** Every document and shadow root the last sweep searched: what a grab watches. */
  let roots = new Set<Node>();
  /**
   * Every shadow host any sweep of this hold found holding a frame: kept, so
   * one taken out of the page is still known when it is put back (3-C2).
   */
  const hosts = new Set<Element>();
  let sweeps = 0;
  let released = false;

  const visit = (d: Document, offsetX: number, offsetY: number, depth: number): void => {
    if (depth > MAX_FRAME_DEPTH) return;
    let frames: Element[] = [];
    try {
      frames = framesIn(d, roots, hosts);
    } catch {
      return;
    }
    for (const f of frames) {
      everyFrame.set(f, { seen: sweeps });
      let child: Window | null = null;
      let childDoc: Document | null = null;
      try {
        child = (f as HTMLIFrameElement).contentWindow;
        childDoc = (f as HTMLIFrameElement).contentDocument;
      } catch {
        continue; // another origin: never rastered (witness.ts)
      }
      if (!child || !childDoc) continue;
      const r = f.getBoundingClientRect();
      const box = { x: r.left + offsetX, y: r.top + offsetY, width: r.width, height: r.height };
      let entry = held.get(f);
      if (entry && entry.doc !== childDoc) {
        // The frame navigated: the old document's hide says nothing about this one.
        entry.release?.();
        entry = undefined;
      }
      if (!entry) {
        entry = { doc: childDoc, release: null, since: sweeps, box, seen: sweeps };
        held.set(f, entry);
      }
      entry.box = box;
      entry.seen = sweeps;
      if (!entry.release && !released) {
        try {
          const hide = (child as unknown as Record<symbol, unknown>)[HIDER];
          if (typeof hide === "function") {
            entry.release = (hide as () => () => void)();
            entry.since = sweeps;
          }
        } catch {
          /* not reachable */
        }
      }
      visit(childDoc, box.x, box.y, depth + 1);
    }
  };

  const sweep = (): number => {
    sweeps += 1;
    roots = new Set();
    const win = doc.defaultView;
    visit(doc, win?.scrollX ?? 0, win?.scrollY ?? 0, 0);
    return sweeps;
  };
  sweep();

  return {
    sweep,
    heldSince(rect, mark) {
      const now = sweep();
      for (const entry of held.values()) {
        if (entry.seen !== now || !touches(entry.box, rect)) continue;
        // No hider: no overlay there. A hider is held from before the grab.
        if (entry.release && entry.since > mark) return false;
      }
      return true;
    },
    watch(rect, mark) {
      // The frames in the rect as the grab starts (found by the sweep that made `mark`).
      const before = [...held.entries()]
        .filter(([, e]) => e.seen === mark && touches(e.box, rect))
        .map(([f]) => f);
      let changed = false;
      const known = new Set(hosts);
      /** Every root the sweep before the grab searched: a root not among them is new (F-7). */
      const rootsBefore = new Set(roots);
      const win = doc.defaultView as (Window & typeof globalThis) | null;
      const Observer = win?.MutationObserver;
      let observer: MutationObserver | null = null;
      const OPTIONS: MutationObserverInit = {
        childList: true,
        subtree: true,
        attributes: true,
        attributeFilter: ["src", "srcdoc"],
      };
      const observe = (root: Node): void => {
        try {
          observer?.observe(root, OPTIONS);
        } catch {
          changed = true; // a root that cannot be watched cannot be trusted
        }
      };
      /** An element added during the grab: any shadow root in it is looked at now, and watched. */
      const lookInside = (node: Node): void => {
        if (node.nodeType !== 1) return;
        const el = node as Element;
        let all: Element[];
        try {
          all = [el, ...el.querySelectorAll("*")];
        } catch {
          changed = true;
          return;
        }
        for (const e of all) {
          const shadow = rootOf(e);
          if (!shadow) continue;
          if (framesIn(shadow).length > 0) changed = true;
          observe(shadow);
          lookInside(shadow as unknown as Node);
        }
      };
      if (Observer) {
        observer = new Observer((records) => {
          if (framesMutated(records, known)) changed = true;
          for (const r of records) for (const n of r.addedNodes) lookInside(n);
        });
        for (const root of roots) observe(root);
      }
      // Every frame's "in the rect" as the grab starts, of any origin; sampled
      // on every animation frame of the grab (F-7): a frame moved by CSS alone
      // fires no mutation.
      const inRect = (f: Element): boolean => {
        const b = boxInDoc(doc, f);
        return b !== null && touches(b, rect);
      };
      const sampled = [...everyFrame.entries()]
        .filter(([, e]) => e.seen === mark)
        .map(([f]): [Element, boolean] => [f, inRect(f)]);
      const sample = (): void => {
        for (const [f, was] of sampled) if (inRect(f) !== was) changed = true;
      };
      let raf: number | null = null;
      const tick = (): void => {
        sample();
        raf = win?.requestAnimationFrame ? win.requestAnimationFrame(tick) : null;
      };
      if (win?.requestAnimationFrame) raf = win.requestAnimationFrame(tick);
      return () => {
        if (raf !== null) win?.cancelAnimationFrame?.(raf);
        sample();
        if (observer) {
          const late = observer.takeRecords();
          if (framesMutated(late, known)) changed = true;
          for (const r of late) for (const n of r.addedNodes) lookInside(n);
          observer.disconnect();
        }
        if (changed) return false;
        const now = sweep();
        // A shadow root no sweep before the grab knew, holding a frame now (F-7).
        for (const root of roots) {
          if (rootsBefore.has(root) || root.nodeType === 9) continue;
          try {
            if ((root as ShadowRoot).querySelector(FRAMES) !== null) return false;
          } catch {
            return false;
          }
        }
        return before.every((f) => {
          const e = held.get(f);
          return !!e && e.seen === now && touches(e.box, rect);
        });
      };
    },
    release() {
      if (released) return;
      released = true;
      for (const entry of held.values()) entry.release?.();
    },
  };
}
