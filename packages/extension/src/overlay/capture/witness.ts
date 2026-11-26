// The witness — content-side orchestrator (capture §5).
//
// The witness is the capture-TIME perceptual ground truth: a screenshot of the
// just-walked, chrome-hidden, settled frame, taken BEFORE harvest's network I/O
// lets the page drift (§3/F6). Only the content script can scroll the page, so
// it drives scrolling and hands each viewport tile to the SW, which rasters
// (`witnessGrab`) and composites first-write-wins (`witnessStitch`, F5). The
// grant is the broad `<all_urls>` (`captureVisibleTab` rejects the http+https
// pair — PINNED, BLOCKER-1); the SW's grab pre-checks it and returns
// `declined-grant`, which we meter per tab-origin and then proceed with NO
// witness (a declined capture legitimately has no ground truth). Fully fail-soft.

import { LIMITS } from "@onlay/protocol";
import { type CropResult, sameCrop } from "../../sw/frame-look";
import { hostMounts } from "../host";
import {
  type BlockWatch,
  clipLimits,
  type OwnPixels,
  type OwnVerdict,
  revealRect,
  ScrollLog,
  watchOwnPixels,
  watchSubtree,
} from "./frame-look";
import type { CaptureDraft, WitnessDrop } from "./index";
import { CAPTURE_LIMITS } from "./limits";
import type { ScreenshotDrop } from "./residue";

// ── pure helper (unit-pinned) ──────────────────────────────────────────────

/**
 * The document-space scroll positions to tile a habitat taller than the
 * viewport (§5). A habitat that fits returns one tile at its top. Otherwise
 * tiles step down by `innerHeight × (1 − OVERLAP)` until the last tile's bottom
 * reaches the habitat bottom, capped at `maxTiles` (taller → the stitch truncates
 * and the caller meters `oversize-truncation`). Returned positions are REQUESTED
 * scrollYs; the caller reports the browser's actual (possibly clamped) scrollY to
 * the stitch so placement stays correct.
 */
export function planTiles(
  habitat: { y: number; height: number },
  innerHeight: number,
  overlap: number,
  maxTiles: number,
): number[] {
  const top = habitat.y;
  const bottom = habitat.y + habitat.height;
  if (habitat.height <= innerHeight || innerHeight <= 0) return [top];
  const step = Math.max(1, innerHeight * (1 - overlap));
  const tiles = [top];
  let y = top;
  while (y + innerHeight < bottom && tiles.length < maxTiles) {
    y += step;
    tiles.push(y);
  }
  return tiles;
}

/** True when the tile plan could not cover the whole habitat (tile cap hit). */
export function tilesTruncated(
  habitat: { y: number; height: number },
  tiles: number[],
  innerHeight: number,
): boolean {
  const last = tiles[tiles.length - 1];
  if (last === undefined) return false;
  return last + innerHeight < habitat.y + habitat.height;
}

// ── the transport contract + orchestrator ──────────────────────────────────

export type GrabResult =
  | { ok: true; b64: string; w: number; h: number }
  | { ok: false; reason: "declined-grant" | "error" };
export type StitchResult =
  | {
      ok: true;
      b64: string;
      mime: string;
      width: number;
      height: number;
      /** F31 — every sampled pixel is one colour: a degenerate grab, almost never a real look. */
      flat?: boolean;
      thumb?: { b64: string; mime: string };
    }
  | { ok: false; reason: string };

export interface WitnessDeps {
  /** How many hosts the content script has mounted (host.ts; tests inject it). */
  hostMounts?: () => number;
  grab?: () => Promise<GrabResult>;
  stitch?: (req: {
    tiles: Array<{ scrollY: number; b64: string }>;
    rect: { x: number; y: number; width: number; height: number };
    dpr: number;
    scrollX: number;
  }) => Promise<StitchResult>;
  viewport?: () => {
    innerHeight: number;
    /** The viewport's width; read from the window when absent. */
    innerWidth?: number;
    dpr: number;
    scrollX: number;
    scrollY: number;
  };
  scrollTo?: (x: number, y: number) => void;
  currentScrollY?: () => number;
  /** rAF settle + capture rate-limit throttle before a grab. */
  settle?: () => Promise<void>;
  /** Hide intersecting position:fixed|sticky chrome for the pass; returns restore. */
  hideSticky?: (habitat: { y: number; height: number }) => () => void;
  /** F31 — force a repaint of the block's layer before the flat-frame regrab. */
  nudge?: (block: Element) => Promise<void>;
  /** A frame from another (or an unknown) origin inside the rect, or null. */
  foreignFrame?: (rect: Rect) => ForeignFrame | null;
  /** This document is a child frame of the tab (F-6); defaults to `window.top !== window`. */
  inChildFrame?: () => boolean;
  /** The tab-level hide and the per-grab locate a child frame's look needs (F-6). */
  frameLook?: FrameLookPort;
  /** A child frame's look scrolls its own document to show the block (L-1); tests inject it. */
  frameScroll?: (block: Element) => FrameScroll;
  /**
   * The window whose position a look in tiles saves and puts back through the
   * shared scroll log (3-L2); null scrolls back with `scrollTo` (tests).
   */
  windowScroll?: () => Window | null;
  /** Watches the block's content across a look in tiles (2-L1); tests inject it. */
  watchBlock?: (block: Element) => BlockWatch;
  /** The most of the block one grab in a child frame can show (L-1); tests inject it. */
  clipLimits?: (block: Element) => { width: number; height: number };
}

/** What a look inside a child frame asks of the service worker (sw/frame-look.ts). */
export interface FrameLookPort {
  /** Hide the overlay in every frame of the tab; the release shows it again, `renew` keeps it. */
  hold(): Promise<{ holdId: string; release(): void; renew?(): void } | null>;
  /**
   * Where `rect` (this frame's viewport) is in the tab now, for this grab's
   * phase. Before a grab, `reveal` asks every frame above to scroll what it
   * must to show it (put back at the release); with this frame's `viewport`
   * size, the part of it the tab shows comes back as `view` (L-1).
   */
  locate(
    rect: Rect,
    holdId: string,
    phase: "pre" | "post",
    opts?: { reveal?: boolean; viewport?: { width: number; height: number } },
  ): Promise<CropResult>;
  /** Whether the block's pixels in `rect` are its frame's own (2-F1); `placed` is the whole block. */
  ownPixels?(block: Element, rect: Rect, placed?: Rect): OwnPixels;
}

const defaultFrameLook: FrameLookPort = {
  async hold() {
    const holdId = crypto.randomUUID().replace(/-/g, "");
    try {
      const r = (await chrome.runtime.sendMessage({ type: "frameHold", holdId })) as
        | { ok?: boolean }
        | undefined;
      if (!r?.ok) return null;
    } catch {
      return null;
    }
    return {
      holdId,
      release: () => {
        try {
          void chrome.runtime.sendMessage({ type: "frameRelease", holdId }).catch(() => {});
        } catch {
          /* each frame lets go by itself */
        }
      },
      // The same hold again renews it in every frame (a look in tiles outlasts one).
      renew: () => {
        try {
          void chrome.runtime.sendMessage({ type: "frameHold", holdId }).catch(() => {});
        } catch {
          /* the hold lets go by itself */
        }
      },
    };
  },
  async locate(rect, holdId, phase, opts = {}) {
    try {
      const r = (await chrome.runtime.sendMessage({
        type: "frameLocate",
        rect,
        holdId,
        phase,
        ...(opts.reveal ? { reveal: true } : {}),
        ...(opts.viewport ? { viewport: opts.viewport } : {}),
      })) as CropResult | undefined;
      return r && typeof r.ok === "boolean" ? r : { ok: false, reason: "unplaced" };
    } catch {
      return { ok: false, reason: "unplaced" };
    }
  },
};

function topIsSelf(): boolean {
  try {
    return window.top === window;
  } catch {
    return false;
  }
}

interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** A frame whose pixels are not this page's to record; `origin` when it is known. */
export interface ForeignFrame {
  origin?: string;
}

const FRAME_SELECTOR = "iframe, frame, object, embed";
/** How deep same-origin frames are searched for foreign frames inside them. */
const MAX_FRAME_DEPTH = 3;

/** The frame's document when this page may read it (same origin), else null. */
function readableFrameDoc(frame: Element): Document | null {
  if (frame.localName === "object" || frame.localName === "embed") return null;
  try {
    return (frame as HTMLIFrameElement).contentDocument ?? null;
  } catch {
    return null;
  }
}

/** Where a foreign frame points, for the residue meter (never needed to refuse). */
function frameOrigin(frame: Element, base: string): string | undefined {
  const raw = frame.getAttribute("src") ?? frame.getAttribute("data");
  if (!raw) return undefined;
  try {
    const u = new URL(raw, base);
    return u.protocol === "http:" || u.protocol === "https:" ? u.origin : undefined;
  } catch {
    return undefined;
  }
}

/** Any element's shadow root, closed ones included where the extension API can see them. */
function shadowOf(el: Element): ShadowRoot | null {
  const api = (
    globalThis as {
      chrome?: { dom?: { openOrClosedShadowRoot?(e: Element): ShadowRoot | null } };
    }
  ).chrome?.dom?.openOrClosedShadowRoot;
  try {
    return api ? api(el) : (el as HTMLElement).shadowRoot;
  } catch {
    return (el as HTMLElement).shadowRoot;
  }
}

/** Frames in a document and in every shadow root under it, open or closed. */
function framesIn(root: Document | ShadowRoot): Element[] {
  const out = [...root.querySelectorAll(FRAME_SELECTOR)];
  for (const el of root.querySelectorAll("*")) {
    const shadow = shadowOf(el);
    if (shadow) out.push(...framesIn(shadow));
  }
  return out;
}

function intersects(a: Rect, b: Rect): boolean {
  return a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;
}

/**
 * Never record another origin's pixels (an embedded, signed-in report from
 * elsewhere would ride the screenshot). Any frame inside `rect` (document
 * space) whose document this page cannot read — another origin, a sandboxed
 * one, a plugin — makes the rect unrecordable. Same-origin frames are searched
 * for foreign frames of their own, a few levels deep.
 */
export function foreignFrameIn(rect: Rect, doc: Document = document): ForeignFrame | null {
  const search = (
    d: Document,
    offsetX: number,
    offsetY: number,
    depth: number,
  ): ForeignFrame | null => {
    let frames: Element[] = [];
    try {
      frames = framesIn(d);
    } catch {
      return {};
    }
    for (const frame of frames) {
      const r = frame.getBoundingClientRect();
      const box = { x: r.left + offsetX, y: r.top + offsetY, width: r.width, height: r.height };
      if (box.width <= 0 || box.height <= 0 || !intersects(box, rect)) continue;
      const inner = readableFrameDoc(frame);
      if (!inner) {
        const origin = frameOrigin(frame, d.baseURI);
        return origin ? { origin } : {};
      }
      if (depth >= MAX_FRAME_DEPTH) return {};
      const nested = search(inner, box.x, box.y, depth + 1);
      if (nested) return nested;
    }
    return null;
  };
  const win = doc.defaultView;
  return search(doc, win?.scrollX ?? 0, win?.scrollY ?? 0, 0);
}

function base64ToBytes(b64: string): Uint8Array {
  const binary = atob(b64);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) out[i] = binary.charCodeAt(i);
  return out;
}

const defaultViewport = (): {
  innerHeight: number;
  innerWidth: number;
  dpr: number;
  scrollX: number;
  scrollY: number;
} => ({
  innerHeight: window.innerHeight,
  innerWidth: window.innerWidth,
  dpr: window.devicePixelRatio || 1,
  scrollX: window.scrollX,
  scrollY: window.scrollY,
});

const defaultGrab = async (): Promise<GrabResult> => {
  try {
    const r = (await chrome.runtime.sendMessage({ type: "witnessGrab" })) as
      | { ok?: boolean; b64?: string; w?: number; h?: number; reason?: string }
      | undefined;
    if (r?.ok && typeof r.b64 === "string") {
      return { ok: true, b64: r.b64, w: r.w ?? 0, h: r.h ?? 0 };
    }
    return { ok: false, reason: r?.reason === "declined-grant" ? "declined-grant" : "error" };
  } catch {
    return { ok: false, reason: "error" };
  }
};

const defaultStitch = async (req: {
  tiles: Array<{ scrollY: number; b64: string }>;
  rect: { x: number; y: number; width: number; height: number };
  dpr: number;
  scrollX: number;
}): Promise<StitchResult> => {
  try {
    const r = (await chrome.runtime.sendMessage({ type: "witnessStitch", ...req })) as StitchResult;
    return r ?? { ok: false, reason: "error" };
  } catch {
    return { ok: false, reason: "error" };
  }
};

// Deadline-bounded (F30 fable-blocking): rAF is SUSPENDED in a hidden tab —
// an unbounded settle would park a multi-tile pass forever mid-scroll with
// sticky chrome hidden. The deadline resolves regardless; the SW's strict
// active-tab grab check is what refuses the actual raster in that state.
const rafSettle = (): Promise<void> =>
  new Promise((resolve) => {
    let done = false;
    const finish = (): void => {
      if (done) return;
      done = true;
      setTimeout(resolve, CAPTURE_LIMITS.WITNESS_STEP_MS);
    };
    const deadline = setTimeout(finish, CAPTURE_LIMITS.QUIESCE_DEADLINE_MS);
    requestAnimationFrame(() => {
      clearTimeout(deadline);
      finish();
    });
  });

// F31 — force the block's layer to re-rasterize before a flat-frame regrab.
// A transient compositor artifact (seen live: a `background-clip: text` variant
// grabbed as one uniform box) is STICKY: nothing repaints between grabs unless
// we invalidate. A momentary `will-change: transform` promotes + re-rasters the
// block's subtree with zero visual delta, then settles two frames.
async function defaultNudge(block: Element): Promise<void> {
  const el = block as HTMLElement;
  if (!el.style) return;
  const prior = el.style.getPropertyValue("will-change");
  const priority = el.style.getPropertyPriority("will-change");
  el.style.setProperty("will-change", "transform");
  await rafSettle();
  if (prior) el.style.setProperty("will-change", prior, priority);
  else el.style.removeProperty("will-change");
  await rafSettle();
}

/** Hide position:fixed|sticky elements intersecting the habitat; returns a restore fn (F5). */
function defaultHideSticky(habitat: { y: number; height: number }): () => void {
  const hidden: Array<{ el: HTMLElement; prev: string }> = [];
  try {
    for (const el of Array.from(document.body.querySelectorAll<HTMLElement>("*"))) {
      const pos = getComputedStyle(el).position;
      if (pos !== "fixed" && pos !== "sticky") continue;
      const r = el.getBoundingClientRect();
      const top = r.top + window.scrollY;
      if (top + r.height < habitat.y || top > habitat.y + habitat.height) continue;
      hidden.push({ el, prev: el.style.visibility });
      el.style.visibility = "hidden";
    }
  } catch {
    /* defensive */
  }
  return () => {
    for (const { el, prev } of hidden) el.style.visibility = prev;
  };
}

/**
 * Capture the witness raster into `witness` + `thumbnail` parts on the draft.
 * Scroll-and-stitch a tall habitat; single grab when it fits. Restores the
 * original scroll + any hidden sticky chrome. Any failure → metered residue
 * (`declined-grant` / `security-error`) + no witness, never an exception.
 */
export async function witness(draft: CaptureDraft, deps: WitnessDeps = {}): Promise<void> {
  const grab = deps.grab ?? defaultGrab;
  const stitch = deps.stitch ?? defaultStitch;
  const viewportNow = deps.viewport ?? defaultViewport;
  const vp = viewportNow();
  const scrollTo = deps.scrollTo ?? ((x: number, y: number) => window.scrollTo(x, y));
  const currentScrollY = deps.currentScrollY ?? (() => window.scrollY);
  const settle = deps.settle ?? rafSettle;
  const hideSticky = deps.hideSticky ?? defaultHideSticky;
  const nudge = deps.nudge ?? defaultNudge;
  const watchBlock = deps.watchBlock ?? watchSubtree;
  const windowScroll =
    deps.windowScroll ?? ((): Window | null => (typeof window !== "undefined" ? window : null));
  const currentMounts = deps.hostMounts ?? hostMounts;
  const foreignFrame =
    deps.foreignFrame ??
    ((r: Rect) => (typeof document === "undefined" ? null : foreignFrameIn(r)));

  const habitat = draft.meta.habitatRect;
  const rect = {
    x: habitat.x,
    y: habitat.y,
    width: Math.max(1, habitat.width),
    height: Math.max(1, habitat.height),
  };

  // Another origin's frame in the rect: no raster at all, said as residue.
  const foreign = foreignFrame(rect);
  if (foreign) {
    draft.residue.add("cross-origin-frame", foreign.origin ? { detail: foreign.origin } : {});
    draft.residue.screenshotDropped("screenshot-foreign-frame");
    draft.dropped = "foreign-frame";
    return;
  }

  // A block inside a child frame: the tab is grabbed and the crop found
  // through the frames above (F-6).
  const inChild = deps.inChildFrame ?? (() => typeof window !== "undefined" && !topIsSelf());
  if (inChild()) {
    const block = draft.block as Element | null;
    await frameWitness(draft, rect, {
      viewport: viewportNow,
      grab,
      stitch,
      settle,
      foreignFrame,
      currentMounts,
      look: deps.frameLook ?? defaultFrameLook,
      scroll: (deps.frameScroll ?? defaultFrameScroll)(draft.block),
      limits: block?.ownerDocument
        ? (deps.clipLimits ?? clipLimits)(block)
        : { width: Number.POSITIVE_INFINITY, height: Number.POSITIVE_INFINITY },
      hideSticky,
      watchBlock,
    });
    return;
  }

  const tiles = planTiles(
    rect,
    vp.innerHeight,
    CAPTURE_LIMITS.OVERLAP,
    CAPTURE_LIMITS.MAX_WITNESS_TILES,
  );
  if (tilesTruncated(rect, tiles, vp.innerHeight)) draft.residue.add("oversize-truncation");

  const originalX = vp.scrollX;
  const originalY = vp.scrollY;

  // Single-tile straddle honesty (§5/A21): the single-tile path grabs the CURRENT
  // viewport without scrolling, so a habitat that fits `innerHeight` but extends
  // past the current fold would leave an unpainted band. Meter it rather than
  // present a silently-blank witness stripe (gpt56-6 / fable-2 remaining half).
  if (
    tiles.length === 1 &&
    (rect.y < originalY || rect.y + rect.height > originalY + vp.innerHeight)
  ) {
    draft.residue.add("oversize-truncation");
  }
  const restoreSticky = tiles.length > 1 ? hideSticky(rect) : () => {};

  // One grab-all-tiles + stitch pass. `meter` is true only for the FIRST pass —
  // a failed flat-frame regrab falls back to the first result rather than
  // turning a witnessed capture into a metered no-witness one (F31).
  const grabAndStitch = async (meter: boolean): Promise<StitchResult | null> => {
    const grabbed: Array<{ scrollY: number; b64: string }> = [];
    // Why the raster goes (C-5); a failed regrab keeps the first pass's result.
    const drop = (why: WitnessDrop): null => {
      if (meter) {
        draft.dropped ??= why;
        draft.residue.screenshotDropped(
          why === "foreign-frame" ? "screenshot-foreign-frame" : "screenshot-page-changed",
        );
      }
      return null;
    };
    // Tiles of two states of the block are not one picture: its content is
    // watched from before the first tile to after the last (2-L1).
    const content = tiles.length > 1 ? watchBlock(draft.block) : null;
    // Where the window was goes in the scroll log every look shares (3-L2):
    // a look in a frame that scrolled this window too keeps one saved
    // position, put back by whichever of them lets go last.
    const win = tiles.length > 1 ? windowScroll() : null;
    const log = new ScrollLog();
    if (win) log.save(win, originalX, originalY);
    try {
      for (const targetY of tiles) {
        if (tiles.length > 1) {
          scrollTo(originalX, targetY);
          await settle();
        }
        // Immediately before EVERY grab, each tile included: still the page,
        // interaction and account this capture is for (binding.ts)…
        if (draft.verify && !draft.verify()) {
          draft.aborted = true;
          return null;
        }
        // …and no frame from another (or an unknown) origin has come into the
        // rect while the tile settled: then no raster at all.
        const late = foreignFrame(rect);
        if (late) {
          // The raster goes; the capture itself carries on with the residue.
          draft.residue.add("cross-origin-frame", late.origin ? { detail: late.origin } : {});
          return drop("foreign-frame");
        }
        // Every same-origin frame found by now has its overlay hidden (C-1),
        // and the frames are watched while the tile is taken (2-C1).
        const mark = draft.frames?.sweep();
        const steady = mark !== undefined ? draft.frames?.watch(rect, mark) : undefined;
        let g: GrabResult;
        let unsteady = false;
        try {
          g = await grab();
        } finally {
          // A frame came, went, moved or was pointed elsewhere during the grab,
          // or one in the rect left it: the overlay may be in these pixels.
          // Taken down whatever the grab did, a rejection included (3-C1).
          unsteady = steady ? !steady() : false;
        }
        if (!g.ok) {
          if (!meter) return null;
          if (g.reason === "declined-grant") draft.residue.declinedGrant(originOfDoc());
          else draft.residue.add("security-error");
          return null; // no witness; capture proceeds honestly
        }
        // …and again once the tile is back (R3-C5): a frame that came in while
        // the grab was in flight may be in its pixels, so the raster goes.
        const during = foreignFrame(rect);
        if (during) {
          draft.residue.add("cross-origin-frame", during.origin ? { detail: during.origin } : {});
          return drop("foreign-frame");
        }
        // …and every same-origin frame in the rect held its overlay hidden for
        // the whole grab (one that came in, or navigated, may show it).
        if (draft.frames && mark !== undefined && !draft.frames.heldSince(rect, mark)) {
          return drop("overlay");
        }
        if (unsteady) return drop("overlay");
        if (content?.changed()) return drop("overlay");
        grabbed.push({ scrollY: tiles.length > 1 ? currentScrollY() : originalY, b64: g.b64 });
      }
    } finally {
      content?.stop();
      if (win) log.restore();
      else if (tiles.length > 1) scrollTo(originalX, originalY);
    }
    // The host was replaced between hiding the overlay and the last tile
    // coming back: the raster may show the private UI, so it goes (3b-C1).
    if (draft.hostMounts !== undefined && currentMounts() !== draft.hostMounts) {
      return drop("overlay");
    }
    if (grabbed.length === 0) return null;
    // We only ever scroll vertically, so `scrollX` is the original viewport X for
    // every tile — thread it so the stitch crops `sx = (rect.x − scrollX)·dpr`
    // instead of assuming a zero horizontal scroll (gpt56-6).
    const stitched = await stitch({ tiles: grabbed, rect, dpr: vp.dpr, scrollX: originalX });
    if (!stitched.ok) {
      if (meter) draft.residue.add("security-error");
      return null;
    }
    return stitched;
  };

  let result: (StitchResult & { ok: true }) | null = null;
  try {
    const first = await grabAndStitch(true);
    if (!first?.ok) return;
    result = first;
    if (first.flat) {
      // F31 — a uniform frame at habitat scale is almost always a degenerate
      // grab (compositor raced the fresh paint). Invalidate the block's layer,
      // regrab once; a still-flat final raster is metered `flat-raster`.
      await nudge(draft.block).catch(() => {});
      const second = await grabAndStitch(false);
      if (second?.ok) result = second;
      if (result.flat) draft.residue.add("flat-raster");
    }
  } finally {
    restoreSticky();
  }
  if (!result) return;
  draft.parts.push({
    name: "witness",
    role: "witness",
    mime: result.mime || "image/webp",
    bytes: base64ToBytes(result.b64),
  });
  if (result.thumb?.b64) {
    draft.parts.push({
      name: "thumbnail",
      role: "thumbnail",
      mime: result.thumb.mime || "image/webp",
      bytes: base64ToBytes(result.thumb.b64),
    });
  }
}

/** CSS px each tile of a look inside a frame overlaps the one before; the earlier one owns it. */
const FRAME_SEAM = 2;

/**
 * The tiles of a look inside a frame (L-1): from the block's top down, each
 * at most `tileH` tall and overlapping the one before by `seam`, until the
 * block's bottom or `maxTiles`; `truncated` when the block is taller.
 */
export function planFrameTiles(
  top: number,
  height: number,
  tileH: number,
  seam: number,
  maxTiles: number,
): { tiles: Array<{ y: number; height: number }>; truncated: boolean } {
  const bottom = top + height;
  if (tileH <= 0 || maxTiles <= 0) return { tiles: [], truncated: true };
  if (height <= tileH) return { tiles: [{ y: top, height }], truncated: false };
  const step = Math.max(1, tileH - Math.max(0, seam));
  const tiles: Array<{ y: number; height: number }> = [];
  let y = top;
  for (;;) {
    tiles.push({ y, height: Math.min(tileH, bottom - y) });
    if (y + tileH >= bottom) return { tiles, truncated: false };
    if (tiles.length >= maxTiles) return { tiles, truncated: true };
    y += step;
  }
}

/** Scrolling done for a look inside a frame, in that frame's own document (L-1). */
export interface FrameScroll {
  /**
   * Show `rect` (this frame's viewport) by scrolling the block's scrollers
   * and the viewport; says how far that moved it in the viewport.
   */
  reveal(rect: Rect): { dx: number; dy: number };
  /** Put back every position `reveal` changed. */
  restore(): void;
}

function defaultFrameScroll(block: Element | null): FrameScroll {
  const log = new ScrollLog();
  return {
    reveal: (r) => (block?.ownerDocument ? revealRect(block, r, log) : { dx: 0, dy: 0 }),
    restore: () => log.restore(),
  };
}

type Viewport = {
  innerHeight: number;
  innerWidth?: number;
  dpr: number;
  scrollX: number;
  scrollY: number;
};

const sameScale = (a?: { x: number; y: number }, b?: { x: number; y: number }): boolean =>
  Math.abs((a?.x ?? 1) - (b?.x ?? 1)) < 1e-6 && Math.abs((a?.y ?? 1) - (b?.y ?? 1)) < 1e-6;

/** The browser's visibility answer is false for any scale but 1 or a uniform enlargement. */
const confirmable = (s?: { x: number; y: number }): boolean =>
  !s || (Math.abs(s.x - s.y) < 1e-6 && s.x >= 1 - 1e-6);

/**
 * The witness of a block inside a child frame (F-6, L-1, L-2). The block is
 * brought into view first: this frame scrolls its own scrollers and viewport,
 * and each frame above scrolls what it must to show the frame (each puts its
 * scrolls back at the hold's release; this frame puts its own back on every
 * path). A first locate tells what of this frame's viewport the tab shows; a
 * block taller than that is taken in tiles. Every tile is located, held,
 * proven and checked on its own exactly as a single grab: the block's rect in
 * this frame's viewport is carried up to the tab by the service worker's
 * locate, before and after the grab (through each frame's translation and
 * scale; a rotated, skewed or 3D frame is refused); the browser must say, at
 * each side of the grab, that the crop is the frame's own pixels; the
 * overlay is hidden in every frame of the tab for it. Only each tile's proven
 * crop is kept. Any refusal drops the screenshot, says why (L-3), and keeps
 * the structured capture.
 */
async function frameWitness(
  draft: CaptureDraft,
  rect: Rect,
  io: {
    viewport: () => Viewport;
    grab: () => Promise<GrabResult>;
    stitch: NonNullable<WitnessDeps["stitch"]>;
    settle: () => Promise<void>;
    foreignFrame: (r: Rect) => ForeignFrame | null;
    currentMounts: () => number;
    look: FrameLookPort;
    scroll: FrameScroll;
    limits: { width: number; height: number };
    hideSticky: (habitat: { y: number; height: number }) => () => void;
    watchBlock: (block: Element) => BlockWatch;
  },
): Promise<void> {
  const drop = (why: WitnessDrop, cls: ScreenshotDrop): void => {
    draft.dropped ??= why;
    draft.residue.screenshotDropped(cls);
  };
  const refuse = (r: CropResult & { ok: false }): void => {
    if (r.reason === "foreign-frame") {
      draft.residue.add("cross-origin-frame");
      drop("foreign-frame", "screenshot-foreign-frame");
    } else if (r.reason === "overlay") drop("overlay", "screenshot-page-changed");
    else if (r.reason === "transformed") drop("unplaced", "screenshot-transformed");
    else drop("unplaced", "screenshot-unplaced");
  };
  const notOwn = (v: OwnVerdict, scale?: { x: number; y: number }): void => {
    if (v === "see-through") drop("covered", "screenshot-see-through");
    else if (v === "moved") drop("overlay", "screenshot-page-changed");
    else if (!confirmable(scale)) drop("covered", "screenshot-scaled");
    else drop("covered", "screenshot-covered");
  };
  const v0 = io.viewport();
  const innerWidth = (): number => {
    const v = io.viewport();
    return v.innerWidth ?? (typeof window !== "undefined" ? window.innerWidth : 0);
  };
  let tileW = Math.min(rect.width, io.limits.width, innerWidth());
  let tileH = Math.min(rect.height, io.limits.height, v0.innerHeight);
  if (!(tileW > 0) || !(tileH > 0)) {
    drop("unplaced", "screenshot-unplaced");
    return;
  }
  // Where the capture measured the block, in this frame's viewport, moved only
  // by this look's own scrolling (L-1): a block anything else moved is refused.
  const shift = { x: 0, y: 0 };
  /** A part of the block (document coordinates at capture) in this frame's viewport now, uncut. */
  const viewOf = (t: Rect): Rect => ({
    x: t.x - v0.scrollX + shift.x,
    y: t.y - v0.scrollY + shift.y,
    width: t.width,
    height: t.height,
  });
  /** The same, cut to the viewport. */
  const shownOf = (t: Rect): Rect => {
    const u = viewOf(t);
    const x = Math.max(0, u.x);
    const y = Math.max(0, u.y);
    return {
      x,
      y,
      width: Math.min(u.x + u.width, innerWidth()) - x,
      height: Math.min(u.y + u.height, io.viewport().innerHeight) - y,
    };
  };
  /** The whole block in this frame's viewport now, by the capture's own measure. */
  const placedNow = (): Rect => viewOf(rect);
  /** The whole block in this frame's document now: where other frames are looked for. */
  const docNow = (): Rect => {
    const v = io.viewport();
    const p = placedNow();
    return { ...p, x: p.x + v.scrollX, y: p.y + v.scrollY };
  };
  const reveal = (t: Rect): void => {
    const d = io.scroll.reveal(viewOf(t));
    shift.x += d.dx;
    shift.y += d.dy;
  };
  const hold = await io.look.hold();
  if (!hold) {
    drop("unplaced", "screenshot-unplaced");
    return;
  }
  const viewportSize = (): { width: number; height: number } => ({
    width: innerWidth(),
    height: io.viewport().innerHeight,
  });
  /** A pre-grab locate that asks each frame above to show the tile; a frame late to the hold is asked once more. */
  const locatePre = async (shown: Rect): Promise<CropResult> => {
    let r = await io.look.locate(shown, hold.holdId, "pre", {
      reveal: true,
      viewport: viewportSize(),
    });
    if (!r.ok && r.reason === "overlay") {
      await io.settle();
      r = await io.look.locate(shown, hold.holdId, "pre", {
        reveal: true,
        viewport: viewportSize(),
      });
    }
    return r;
  };
  let own: OwnPixels | null = null;
  let restoreSticky = (): void => {};
  let content: BlockWatch | null = null;
  try {
    // The first tile, brought into view: its locate also tells how much of
    // this frame the tab shows, which sizes every tile.
    const first: Rect = { x: rect.x, y: rect.y, width: tileW, height: tileH };
    reveal(first);
    await io.settle();
    if (draft.verify && !draft.verify()) {
      draft.aborted = true;
      return;
    }
    const firstShown = shownOf(first);
    if (firstShown.width <= 0 || firstShown.height <= 0) {
      drop("unplaced", "screenshot-unplaced");
      return;
    }
    const probe = await locatePre(firstShown);
    if (!probe.ok) {
      refuse(probe);
      return;
    }
    const scale = probe.scale;
    if (probe.view) {
      tileW = Math.min(tileW, Math.floor(probe.view.width));
      tileH = Math.min(tileH, Math.floor(probe.view.height));
    }
    if (!(tileW > 0) || !(tileH > 0)) {
      drop("unplaced", "screenshot-unplaced");
      return;
    }
    // Within the pixel budget of one raster, and the tile cap.
    const dpr = v0.dpr || 1;
    const rowPixels = tileW * (scale?.x ?? 1) * dpr * dpr * (scale?.y ?? 1);
    const budgetH = Math.max(1, Math.floor(LIMITS.MAX_CAPTURE_IMAGE_PIXELS / rowPixels));
    const plan = planFrameTiles(
      rect.y,
      Math.min(rect.height, budgetH),
      tileH,
      FRAME_SEAM,
      CAPTURE_LIMITS.MAX_WITNESS_TILES,
    );
    const many = plan.tiles.length > 1;
    if (many) restoreSticky = io.hideSticky(rect);
    // Tiles of two states of the block are not one picture: its content is
    // watched from before the first tile to after the last (2-L1).
    if (many) content = io.watchBlock(draft.block);
    const grabbed: Array<{
      scrollY: number;
      b64: string;
      crop: Rect;
      at: { x: number; y: number };
    }> = [];
    let lastPre: (CropResult & { ok: true }) | null = null;
    let lastShown: Rect = firstShown;
    for (let i = 0; i < plan.tiles.length; i += 1) {
      const p = plan.tiles[i] as { y: number; height: number };
      const tile: Rect = { x: rect.x, y: p.y, width: tileW, height: p.height };
      hold.renew?.();
      const reuse = i === 0 && tileW === first.width && tileH === first.height;
      if (!reuse) {
        reveal(tile);
        await io.settle();
      }
      if (draft.verify && !draft.verify()) {
        draft.aborted = true;
        return;
      }
      const shown = shownOf(tile);
      if (shown.width <= 0 || shown.height <= 0) {
        drop("unplaced", "screenshot-unplaced");
        return;
      }
      const pre = reuse ? probe : await locatePre(shown);
      if (!pre.ok) {
        refuse(pre);
        return;
      }
      // Each tile whole, and every tile at one scale: anything else is not one picture.
      if (many && (pre.clamped || shown.height < tile.height - 0.5)) {
        drop("unplaced", "screenshot-unplaced");
        return;
      }
      if (!sameScale(pre.scale, scale)) {
        drop("overlay", "screenshot-page-changed");
        return;
      }
      // The screenshot is kept only when the frame can show the crop is its
      // own pixels, before and after the grab (2-F1): nothing from any
      // document drawn over the block, and an opaque background under it.
      own = (io.look.ownPixels ?? watchOwnPixels)(draft.block, shown, placedNow());
      const before = await own.start();
      if (before !== "own") {
        notOwn(before, scale);
        return;
      }
      const late = io.foreignFrame(docNow());
      if (late) {
        draft.residue.add("cross-origin-frame", late.origin ? { detail: late.origin } : {});
        drop("foreign-frame", "screenshot-foreign-frame");
        return;
      }
      const mark = draft.frames?.sweep();
      const steady = mark !== undefined ? draft.frames?.watch(docNow(), mark) : undefined;
      let g: GrabResult;
      let unsteady = false;
      try {
        g = await io.grab();
      } finally {
        unsteady = steady ? !steady() : false;
      }
      const post = await io.look.locate(shown, hold.holdId, "post", { viewport: viewportSize() });
      if (!g.ok) {
        if (g.reason === "declined-grant") draft.residue.declinedGrant(originOfDoc());
        else draft.residue.add("security-error");
        return;
      }
      if (!post.ok) {
        refuse(post);
        return;
      }
      // The frame moved between the two locates: these pixels may be elsewhere.
      if (!sameCrop(pre.crop, post.crop) || !sameScale(pre.scale, post.scale)) {
        drop("overlay", "screenshot-page-changed");
        return;
      }
      const after = await own.end();
      if (after !== "own") {
        notOwn(after, scale);
        return;
      }
      own.stop();
      own = null;
      if (draft.verify && !draft.verify()) {
        draft.aborted = true;
        return;
      }
      const during = io.foreignFrame(docNow());
      if (during) {
        draft.residue.add("cross-origin-frame", during.origin ? { detail: during.origin } : {});
        drop("foreign-frame", "screenshot-foreign-frame");
        return;
      }
      if (draft.frames && mark !== undefined && !draft.frames.heldSince(docNow(), mark)) {
        drop("overlay", "screenshot-page-changed");
        return;
      }
      if (unsteady) {
        drop("overlay", "screenshot-page-changed");
        return;
      }
      if (draft.hostMounts !== undefined && io.currentMounts() !== draft.hostMounts) {
        drop("overlay", "screenshot-page-changed");
        return;
      }
      if (content?.changed()) {
        drop("overlay", "screenshot-page-changed");
        return;
      }
      grabbed.push({
        scrollY: 0,
        b64: g.b64,
        crop: pre.crop,
        at: { x: 0, y: (tile.y - rect.y) * (scale?.y ?? 1) },
      });
      lastPre = pre;
      lastShown = shown;
    }
    if (!lastPre || grabbed.length === 0) return;
    // Only part of the block was taken: the look is of that part.
    const covered = plan.tiles.reduce((h, t) => Math.max(h, t.y + t.height - rect.y), 0);
    if (
      plan.truncated ||
      tileW < rect.width - 0.5 ||
      covered < rect.height - 0.5 ||
      (!many &&
        (lastPre.clamped ||
          lastShown.width < rect.width - 0.5 ||
          lastShown.height < rect.height - 0.5))
    )
      draft.residue.add("oversize-truncation");
    const stitched = many
      ? await io.stitch({
          tiles: grabbed,
          rect: {
            x: 0,
            y: 0,
            width: (grabbed[0] as { crop: Rect }).crop.width,
            height: covered * (scale?.y ?? 1),
          },
          dpr: v0.dpr,
          scrollX: 0,
        })
      : await io.stitch({
          tiles: [{ scrollY: 0, b64: (grabbed[0] as { b64: string }).b64 }],
          rect: lastPre.crop,
          dpr: v0.dpr,
          scrollX: 0,
        });
    if (!stitched.ok) {
      draft.residue.add("security-error");
      return;
    }
    if (stitched.flat) draft.residue.add("flat-raster");
    draft.parts.push({
      name: "witness",
      role: "witness",
      mime: stitched.mime || "image/webp",
      bytes: base64ToBytes(stitched.b64),
    });
    if (stitched.thumb?.b64) {
      draft.parts.push({
        name: "thumbnail",
        role: "thumbnail",
        mime: stitched.thumb.mime || "image/webp",
        bytes: base64ToBytes(stitched.thumb.b64),
      });
    }
  } finally {
    content?.stop();
    own?.stop();
    restoreSticky();
    // This frame's scrolls go back first; the release tells every frame above to put back theirs.
    io.scroll.restore();
    hold.release();
  }
}

/** The captured tab's own origin, for declined-grant meter copy (§5). */
function originOfDoc(): string {
  try {
    return typeof location !== "undefined" ? location.origin : "";
  } catch {
    return "";
  }
}
