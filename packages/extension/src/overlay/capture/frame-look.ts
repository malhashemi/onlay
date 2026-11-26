// The content side of a look of a block inside a child frame (round 3, F-6;
// the protocol is described in sw/frame-look.ts). Every frame runs both halves:
//
//   - as a frame on the path: it holds its overlay hidden while any frame of
//     the tab grabs (`frame-hold` / `frame-release`), and when a child frame
//     posts it a locate nonce it measures that child frame and reports to the
//     service worker;
//   - as the capturing frame (or a frame above it): when the service worker
//     hands it a nonce (`frame-locate-up`), it posts the nonce to its parent.
//
// A placement (phase `place`, once, for a composer card beside a block picked
// in a child frame) runs the same two halves with nothing of a look: the
// parent measures the frame element and reports its box and scale, holds
// nothing, scrolls nothing, looks for no other frames and keeps nothing.
import type { Box } from "../../sw/frame-look";
import {
  type ChildFrameHold,
  holdChildFramesHidden,
  holdHiddenForCapture,
  hostMounts,
} from "../host";

/** The key of the message a frame posts to its parent (the nonce, upward). */
const LOCATE_KEY = "onlay-locate";
/** The key of the parent's answer, posted only to the window it measured (2-F2). */
const CHALLENGE_KEY = "onlay-challenge";
/** A hold that is never released (its capture died) lets go by itself. */
const HOLD_MS = 10_000;
const FRAMES = "iframe, frame, object, embed";
/** How deep same-origin frames are searched for other origins' frames. */
const MAX_DEPTH = 3;

interface TabHold {
  release(): void;
  kids: ChildFrameHold;
  /** `hostMounts()` when it was taken: a host mounted since may not be hidden. */
  mounts: number;
  mark: number;
  timer: ReturnType<typeof setTimeout>;
  /** One frame watch per child window being located, from its pre-grab locate. */
  watches: Map<unknown, () => boolean>;
  /** What this frame scrolled to show a block for this hold; put back at the release (L-1). */
  scrolls: ScrollLog;
}

/** Nonces this frame posted upward, and nonces it measured: each heard once. */
const postedNonces = new Set<string>();
const measuredNonces = new Set<string>();
const remember = (set: Set<string>, v: string): void => {
  set.add(v);
  if (set.size > 64) set.delete(set.values().next().value as string);
};

const isBox = (v: unknown): v is Box =>
  !!v &&
  typeof v === "object" &&
  ["x", "y", "width", "height"].every(
    (k) =>
      typeof (v as Record<string, unknown>)[k] === "number" &&
      Number.isFinite((v as Record<string, number>)[k]),
  );

function challenge(): string {
  return crypto.randomUUID().replace(/-/g, "");
}

const holds = new Map<string, TabHold>();

function shadowOf(el: Element): ShadowRoot | null {
  const api = (
    globalThis as {
      chrome?: { dom?: { openOrClosedShadowRoot?(e: Element): ShadowRoot | null } };
    }
  ).chrome?.dom?.openOrClosedShadowRoot;
  try {
    return api ? api(el) : (el as HTMLElement).shadowRoot;
  } catch {
    return null;
  }
}

/** Frame-like elements in a document and every shadow root under it. */
function framesIn(root: Document | ShadowRoot): Element[] {
  const out = [...root.querySelectorAll(FRAMES)];
  for (const el of root.querySelectorAll("*")) {
    const shadow = shadowOf(el);
    if (shadow) out.push(...framesIn(shadow));
  }
  return out;
}

function readable(frame: Element): Document | null {
  if (frame.localName !== "iframe" && frame.localName !== "frame") return null;
  try {
    return (frame as HTMLIFrameElement).contentDocument ?? null;
  } catch {
    return null;
  }
}

function touches(a: Box, b: Box): boolean {
  return a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;
}

function intersect(a: Box, b: Box): Box {
  const x = Math.max(a.x, b.x);
  const y = Math.max(a.y, b.y);
  const r = Math.min(a.x + a.width, b.x + b.width);
  const btm = Math.min(a.y + a.height, b.y + b.height);
  return { x, y, width: Math.max(0, r - x), height: Math.max(0, btm - y) };
}

/**
 * Every frame of another (or an unknown) origin in `doc` other than `skip`,
 * in `doc`'s viewport coordinates: same-origin frames are searched inside,
 * a few levels deep. Its pixels are not this page's to record.
 */
function foreignBoxes(doc: Document, skip: Element): Box[] {
  const out: Box[] = [];
  const search = (d: Document | ShadowRoot, ox: number, oy: number, depth: number): void => {
    let frames: Element[];
    try {
      frames = framesIn(d);
    } catch {
      out.push({ x: -1e6, y: -1e6, width: 2e6, height: 2e6 }); // can't search: nothing is safe
      return;
    }
    for (const f of frames) {
      if (f === skip) continue;
      const r = f.getBoundingClientRect();
      if (r.width <= 0 || r.height <= 0) continue;
      const box = { x: r.left + ox, y: r.top + oy, width: r.width, height: r.height };
      const inner = readable(f);
      if (!inner || depth >= MAX_DEPTH) out.push(box);
      else search(inner, box.x, box.y, depth + 1);
    }
  };
  search(doc, 0, 0, 0);
  return out;
}

/** The frame element in `doc` (shadow roots included) whose window is `source`. */
function frameFor(doc: Document, source: unknown): HTMLIFrameElement | null {
  if (!source) return null;
  for (const f of framesIn(doc)) {
    if (f.localName !== "iframe" && f.localName !== "frame") continue;
    try {
      if ((f as HTMLIFrameElement).contentWindow === source) return f as HTMLIFrameElement;
    } catch {
      /* not this one */
    }
  }
  return null;
}

/** The element above `el`, through a shadow root to its host. */
function parentOf(el: Element): Element | null {
  if (el.parentElement) return el.parentElement;
  const root = el.getRootNode();
  return root && (root as ShadowRoot).host ? (root as ShadowRoot).host : null;
}

/** A frame or an element holding it that can't be mapped: rotated, skewed, flipped or 3D (L-2). */
const TILTED = "tilted" as const;

/**
 * The 2D scale one element's own transform applies (`transform` and the
 * `rotate`, `scale` and `translate` properties), or TILTED when it does
 * anything but translate and scale by positive factors. A `zoom` other than
 * 1, or a motion path, is TILTED too: its pixels are not where a box says.
 */
export function ownScale(cs: CSSStyleDeclaration): { x: number; y: number } | typeof TILTED {
  let x = 1;
  let y = 1;
  const read = (k: string): string =>
    String((cs as unknown as Record<string, unknown>)[k] ?? "").trim();
  const transform = read("transform");
  if (transform && transform !== "none") {
    const m = /^matrix\(([^)]*)\)$/.exec(transform);
    if (!m) return TILTED; // matrix3d(), or anything this can't read
    const n = (m[1] as string).split(",").map((v) => Number.parseFloat(v));
    const [a, b, c, d] = n as [number, number, number, number];
    if (n.length !== 6 || n.some((v) => !Number.isFinite(v))) return TILTED;
    if (Math.abs(b) > 1e-9 || Math.abs(c) > 1e-9 || !(a > 0) || !(d > 0)) return TILTED;
    x *= a;
    y *= d;
  }
  const rotate = read("rotate");
  if (rotate && rotate !== "none" && !/^0(deg|rad|grad|turn)?$/.test(rotate)) return TILTED;
  const scale = read("scale");
  if (scale && scale !== "none") {
    const n = scale.split(/\s+/).map((v) => Number.parseFloat(v));
    if (n.some((v) => !Number.isFinite(v) || v <= 0)) return TILTED;
    if (n.length > 2 && n[2] !== 1) return TILTED;
    x *= n[0] as number;
    y *= (n[1] ?? n[0]) as number;
  }
  const translate = read("translate");
  if (translate && translate !== "none") {
    const n = translate.split(/\s+/);
    if (n.length > 2 && Number.parseFloat(n[2] as string) !== 0) return TILTED;
  }
  const path = read("offsetPath");
  if (path && path !== "none") return TILTED;
  const zoom = read("zoom");
  if (zoom && zoom !== "1" && zoom !== "normal") return TILTED;
  return { x, y };
}

/** How big one of `el`'s CSS pixels is on screen, from its box against its layout size. */
function shownScale(el: Element): { x: number; y: number } | null {
  const h = el as HTMLElement;
  const r = el.getBoundingClientRect();
  if (typeof h.offsetWidth !== "number") return null;
  if (h.offsetWidth <= 0 || h.offsetHeight <= 0) return { x: 1, y: 1 };
  return { x: r.width / h.offsetWidth, y: r.height / h.offsetHeight };
}

type Measured = { box: Box; clip: Box; scale?: { x: number; y: number } } | typeof TILTED;

/**
 * Where a child frame's viewport sits in this frame's viewport, how big its
 * pixels are here, and what of this viewport shows it (L-2). The frame and
 * every element holding it may translate and scale by positive factors; the
 * scale is their product, and must match the frame's box against its layout
 * size, or nothing is told (null). Rotation, skew, flips and 3D are TILTED.
 */
function measureFrame(doc: Document, f: HTMLIFrameElement): Measured | null {
  const win = doc.defaultView;
  if (!win) return null;
  let sx = 1;
  let sy = 1;
  for (let el: Element | null = f; el; el = parentOf(el)) {
    let cs: CSSStyleDeclaration;
    try {
      cs = win.getComputedStyle(el);
    } catch {
      return null;
    }
    const s = ownScale(cs);
    if (s === TILTED) return TILTED;
    sx *= s.x;
    sy *= s.y;
  }
  const r = f.getBoundingClientRect();
  // The box must be exactly the layout size times the scale found: anything
  // else is drawn where this can't tell.
  if (Math.abs(r.width - f.offsetWidth * sx) > 1 || Math.abs(r.height - f.offsetHeight * sy) > 1)
    return null;
  const cs = win.getComputedStyle(f);
  const px = (v: string): number => Number.parseFloat(v) || 0;
  const pl = px(cs.paddingLeft);
  const pt = px(cs.paddingTop);
  const box = {
    x: r.left + (f.clientLeft + pl) * sx,
    y: r.top + (f.clientTop + pt) * sy,
    width: Math.max(0, f.clientWidth - pl - px(cs.paddingRight)) * sx,
    height: Math.max(0, f.clientHeight - pt - px(cs.paddingBottom)) * sy,
  };
  let clip: Box = {
    x: 0,
    y: 0,
    width: doc.documentElement.clientWidth || win.innerWidth,
    height: doc.documentElement.clientHeight || win.innerHeight,
  };
  for (let el = parentOf(f); el && el !== doc.documentElement; el = parentOf(el)) {
    const s = win.getComputedStyle(el);
    if (s.overflowX === "visible" && s.overflowY === "visible") continue;
    const ar = el.getBoundingClientRect();
    const k = shownScale(el);
    if (!k) return null;
    clip = intersect(clip, {
      x: ar.left + el.clientLeft * k.x,
      y: ar.top + el.clientTop * k.y,
      width: el.clientWidth * k.x,
      height: el.clientHeight * k.y,
    });
  }
  const unit = Math.abs(sx - 1) < 1e-9 && Math.abs(sy - 1) < 1e-9;
  return { box, clip, ...(unit ? {} : { scale: { x: sx, y: sy } }) };
}

/**
 * The block's frames without an address of their own, from its document up
 * to `owner`, can be mapped by plain offsets (what `rectInOwner` adds): no
 * frame element on the way, nor anything holding it, transforms, scales or
 * zooms, and each one's box is its layout size. Otherwise a box carried up
 * that way is somewhere else on screen.
 */
export function plainFramePath(el: Element, owner: Document): boolean {
  let doc = el.ownerDocument;
  for (let i = 0; doc !== owner; i += 1) {
    if (i > 8) return false;
    let f: Element | null = null;
    try {
      f = doc.defaultView?.frameElement ?? null;
    } catch {
      return false;
    }
    if (!f || (f.localName !== "iframe" && f.localName !== "frame")) return false;
    const m = measureFrame(f.ownerDocument, f as HTMLIFrameElement);
    if (!m || m === TILTED || m.scale) return false;
    doc = f.ownerDocument;
  }
  return true;
}

/* ── bringing a rect into view, and putting every scroll back (L-1) ───── */

type ScrollTarget = Element | Window;

/**
 * The position each scroller had before the first look that moved it, shared
 * by every look in this document (2-L2): looks that overlap keep one saved
 * position per scroller, and it is put back only when the last of them lets
 * go, so a later release never restores another look's passing position.
 */
const firstPositions = new Map<
  ScrollTarget,
  { left: number; top: number; owners: Set<ScrollLog> }
>();

/** Every scroll position one look changed; the first value is kept for all looks, put back by the last. */
export class ScrollLog {
  private readonly mine: ScrollTarget[] = [];
  save(t: ScrollTarget, left: number, top: number): void {
    if (this.mine.includes(t)) return;
    this.mine.push(t);
    const held = firstPositions.get(t);
    if (held) held.owners.add(this);
    else firstPositions.set(t, { left, top, owners: new Set([this]) });
  }
  get size(): number {
    return this.mine.length;
  }
  restore(): void {
    const all = this.mine.splice(0).reverse();
    for (const t of all) {
      const held = firstPositions.get(t);
      if (!held) continue;
      held.owners.delete(this);
      if (held.owners.size > 0) continue; // another look still holds it
      firstPositions.delete(t);
      scrollInstant(t, held.left, held.top);
    }
  }
}

/** Scroll at once, whatever the page's `scroll-behavior` says. */
function scrollInstant(t: ScrollTarget, left: number, top: number): void {
  try {
    t.scrollTo({ left, top, behavior: "instant" as ScrollBehavior });
  } catch {
    try {
      t.scrollTo(left, top);
    } catch {
      /* gone */
    }
  }
}

/**
 * How far to scroll so `[a, a + len]` shows inside `[lo, hi]`: not at all
 * when it does, else the nearest way, its start first when it can't all fit.
 */
export function nearestDelta(a: number, len: number, lo: number, hi: number): number {
  if (a >= lo - 0.5 && a + len <= hi + 0.5) return 0;
  if (len > hi - lo || a < lo) return a - lo;
  return a + len - hi;
}

const scrolls = (v: string): boolean => v === "auto" || v === "scroll";

/**
 * Scroll the scrollers holding `from` (inner first, then the document's
 * viewport) just enough to show `rect` (viewport coordinates of `from`'s
 * document), saving each first position in `log`. Only plain scrollers are
 * moved (`auto` or `scroll`, not transformed); a rect that still isn't shown
 * is found out by the checks that follow. Says whether anything moved, and
 * how far that moved `rect` in the viewport.
 */
export function revealRect(
  from: Element,
  rect: Box,
  log: ScrollLog,
): { moved: boolean; dx: number; dy: number } {
  const doc = from.ownerDocument;
  const win = doc.defaultView;
  if (!win) return { moved: false, dx: 0, dy: 0 };
  let r = { ...rect };
  let moved = false;
  const scroller = doc.scrollingElement;
  for (let el = parentOf(from); el && el !== doc.documentElement; el = parentOf(el)) {
    if (el === scroller) continue;
    let cs: CSSStyleDeclaration;
    try {
      cs = win.getComputedStyle(el);
    } catch {
      continue;
    }
    const sxOk = scrolls(cs.overflowX);
    const syOk = scrolls(cs.overflowY);
    if (!sxOk && !syOk) continue;
    if (el.scrollHeight <= el.clientHeight && el.scrollWidth <= el.clientWidth) continue;
    const k = shownScale(el);
    if (!k || Math.abs(k.x - 1) > 0.001 || Math.abs(k.y - 1) > 0.001) continue;
    const b = el.getBoundingClientRect();
    const left = b.left + el.clientLeft;
    const top = b.top + el.clientTop;
    const dx = sxOk ? nearestDelta(r.x, r.width, left, left + el.clientWidth) : 0;
    const dy = syOk ? nearestDelta(r.y, r.height, top, top + el.clientHeight) : 0;
    if (dx === 0 && dy === 0) continue;
    const L = el.scrollLeft;
    const T = el.scrollTop;
    log.save(el, L, T);
    scrollInstant(el, L + dx, T + dy);
    const ax = el.scrollLeft - L;
    const ay = el.scrollTop - T;
    if (ax !== 0 || ay !== 0) moved = true;
    r = { ...r, x: r.x - ax, y: r.y - ay };
  }
  const vw = doc.documentElement.clientWidth || win.innerWidth;
  const vh = doc.documentElement.clientHeight || win.innerHeight;
  const dx = nearestDelta(r.x, r.width, 0, vw);
  const dy = nearestDelta(r.y, r.height, 0, vh);
  if (dx !== 0 || dy !== 0) {
    const L = win.scrollX;
    const T = win.scrollY;
    log.save(win, L, T);
    scrollInstant(win, L + dx, T + dy);
    const ax = win.scrollX - L;
    const ay = win.scrollY - T;
    if (ax !== 0 || ay !== 0) moved = true;
    r = { ...r, x: r.x - ax, y: r.y - ay };
  }
  return { moved, dx: r.x - rect.x, dy: r.y - rect.y };
}

/**
 * The most of the block a single grab can show (L-1): the frame's viewport
 * cut by every ancestor of the block that clips it, in CSS px.
 */
export function clipLimits(block: Element): { width: number; height: number } {
  const doc = block.ownerDocument;
  const win = doc.defaultView;
  let width = doc.documentElement.clientWidth || win?.innerWidth || 0;
  let height = doc.documentElement.clientHeight || win?.innerHeight || 0;
  if (!win) return { width, height };
  for (let el = parentOf(block); el && el !== doc.documentElement; el = parentOf(el)) {
    if (el === doc.scrollingElement) continue;
    let cs: CSSStyleDeclaration;
    try {
      cs = win.getComputedStyle(el);
    } catch {
      continue;
    }
    if (cs.overflowX !== "visible" && el.clientWidth > 0) width = Math.min(width, el.clientWidth);
    if (cs.overflowY !== "visible" && el.clientHeight > 0)
      height = Math.min(height, el.clientHeight);
  }
  return { width, height };
}

export interface FrameLookDeps {
  /** To the service worker; never throws. */
  send(msg: Record<string, unknown>): void;
}

/**
 * Listen for the two messages of a locate (2-F2). Registered at
 * document_start, before any page script, and each stopped here, so the page
 * hears neither.
 *
 * - As a parent: a child posts its nonce and its block's rect (in its own
 *   viewport). Only a frame element of this document whose window sent it is
 *   measured; this frame answers with a fresh challenge posted to that window
 *   alone, and reports the measurement with the challenge.
 * - As a child: the challenge counts only from `window.parent`, for a nonce
 *   this frame posted; it is echoed to the service worker, which matches it
 *   with the parent's report and this document's identity.
 */
export function listenForLocates(win: Window, deps: FrameLookDeps): void {
  win.addEventListener(
    "message",
    (e: MessageEvent) => {
      // Only a message the browser delivered: a page can dispatch a made-up
      // event with any `source` it likes (3-F2).
      if (e.isTrusted !== true) return;
      const data = e.data as Record<string, unknown> | null;
      if (!data || typeof data !== "object") return;
      if (typeof data[CHALLENGE_KEY] === "string") {
        e.stopImmediatePropagation();
        onChallenge(win, e, data, deps);
        return;
      }
      if (typeof data[LOCATE_KEY] !== "string") return;
      // Ours: the page has no use for it.
      e.stopImmediatePropagation();
      onLocate(win, e, data, deps);
    },
    { capture: true },
  );
}

function onChallenge(
  win: Window,
  e: MessageEvent,
  data: Record<string, unknown>,
  deps: FrameLookDeps,
): void {
  const nonce = typeof data.nonce === "string" ? data.nonce : "";
  // Only from this frame's own parent window, for a nonce this frame posted.
  if (win.parent === win || e.source !== win.parent || !postedNonces.has(nonce)) return;
  postedNonces.delete(nonce);
  let parentIsTop = false;
  try {
    parentIsTop = win.parent === win.top;
  } catch {
    parentIsTop = false;
  }
  deps.send({ type: "frameEchoed", nonce, challenge: data[CHALLENGE_KEY], parentIsTop });
}

function onLocate(
  win: Window,
  e: MessageEvent,
  data: Record<string, unknown>,
  deps: FrameLookDeps,
): void {
  const nonce = data[LOCATE_KEY] as string;
  if (measuredNonces.has(nonce)) return;
  const holdId = typeof data.hold === "string" ? data.hold : "";
  const phase = data.phase === "post" ? "post" : data.phase === "place" ? "place" : "pre";
  const doc = win.document;
  const f = frameFor(doc, e.source);
  if (!f || !isBox(data.rect)) return; // not a frame of this document: the locate times out
  remember(measuredNonces, nonce);
  const rect = data.rect;
  const hold = holds.get(holdId);
  let m = measureFrame(doc, f);
  if (!m) return;
  const answer = challenge();
  const post = (report: Record<string, unknown>): void => {
    try {
      f.contentWindow?.postMessage({ [CHALLENGE_KEY]: answer, nonce }, "*");
    } catch {
      return;
    }
    deps.send({ type: "frameLocated", nonce, challenge: answer, ...report });
  };
  const none = { x: 0, y: 0, width: 0, height: 0 };
  // Rotated, skewed or 3D: said at once, so the look is refused for that (L-2).
  if (m === TILTED) {
    post({ box: none, clip: none, foreign: [], held: false, tilted: true });
    return;
  }
  // A placement: the frame's box and scale alone.
  if (phase === "place") {
    post({
      box: m.box,
      ...(m.scale ? { scale: m.scale } : {}),
      clip: m.clip,
      foreign: [],
      held: false,
    });
    return;
  }
  /** The block's rect in this frame's viewport, through the frame's box and scale. */
  const mapped = (at: { box: Box; scale?: { x: number; y: number } }): Box => {
    const s = at.scale ?? { x: 1, y: 1 };
    return {
      x: at.box.x + rect.x * s.x,
      y: at.box.y + rect.y * s.y,
      width: rect.width * s.x,
      height: rect.height * s.y,
    };
  };
  // Before a grab, a look may ask this frame to scroll what it must to show
  // the block, but only for a hold this frame holds; the release puts it back (L-1).
  if (
    phase === "pre" &&
    data.reveal === true &&
    hold &&
    revealRect(f, mapped(m), hold.scrolls).moved
  ) {
    m = measureFrame(doc, f);
    if (!m) return;
    if (m === TILTED) {
      post({ box: none, clip: none, foreign: [], held: false, tilted: true });
      return;
    }
  }
  // The block's rect, exactly, in this frame's viewport and document (2-F1).
  const exact = intersect(intersect(mapped(m), m.box), m.clip);
  const inDoc = { ...exact, x: exact.x + win.scrollX, y: exact.y + win.scrollY };
  // Held for this grab: the hold is taken, no host mounted since, and the
  // same-origin frames under this one held theirs over the block's rect.
  const held =
    exact.width > 0 &&
    exact.height > 0 &&
    !!hold &&
    hostMounts() === hold.mounts &&
    hold.kids.heldSince(inDoc, hold.mark);
  let steady: boolean | undefined;
  if (hold && phase === "pre") {
    // A second pre-grab locate replaces the first watch, which is ended (2-F6).
    hold.watches.get(e.source)?.();
    hold.watches.set(e.source, hold.kids.watch(inDoc, hold.kids.sweep()));
  }
  if (phase === "post") {
    const check = hold?.watches.get(e.source);
    hold?.watches.delete(e.source);
    steady = check ? check() : false;
  }
  post({
    box: m.box,
    ...(m.scale ? { scale: m.scale } : {}),
    clip: m.clip,
    // Other origins' frames over the block's exact rect.
    foreign: foreignBoxes(doc, f).filter((b) => touches(b, exact)),
    held,
    ...(steady !== undefined ? { steady } : {}),
  });
}

/**
 * A frame of the tab grabs: this frame's overlay stays hidden until the
 * release. The same hold again renews it (a look in many tiles outlasts one).
 */
export function onFrameHold(holdId: string): void {
  const held = holds.get(holdId);
  if (held) {
    clearTimeout(held.timer);
    held.timer = setTimeout(() => onFrameRelease(holdId), HOLD_MS);
    return;
  }
  if (typeof document === "undefined") return;
  const release = holdHiddenForCapture();
  const kids = holdChildFramesHidden(document);
  const entry: TabHold = {
    release: () => {
      release();
      kids.release();
    },
    kids,
    mounts: hostMounts(),
    mark: kids.sweep(),
    timer: setTimeout(() => onFrameRelease(holdId), HOLD_MS),
    watches: new Map(),
    scrolls: new ScrollLog(),
  };
  holds.set(holdId, entry);
}

export function onFrameRelease(holdId: string): void {
  const entry = holds.get(holdId);
  if (!entry) return;
  holds.delete(holdId);
  clearTimeout(entry.timer);
  // Every watch still running ends with the hold (2-F6).
  for (const end of entry.watches.values()) {
    try {
      end();
    } catch {
      /* ended */
    }
  }
  entry.watches.clear();
  // Every scroll this frame made for the look goes back where it was (L-1).
  entry.scrolls.restore();
  entry.release();
}

/** The service worker handed this frame a nonce: post it to the parent. */
export function onLocateUp(
  win: Window,
  nonce: string,
  holdId: string,
  phase: string,
  rect: unknown,
  reveal = false,
): void {
  if (win.parent === win || !isBox(rect)) return;
  remember(postedNonces, nonce);
  try {
    win.parent.postMessage(
      {
        [LOCATE_KEY]: nonce,
        hold: holdId,
        phase,
        rect,
        ...(reveal && phase === "pre" ? { reveal: true } : {}),
      },
      "*",
    );
  } catch {
    /* the locate times out */
  }
}

/* ── the block's own pixels (2-F1) ─────────────────────────────────── */

/** Alpha of a computed colour (`rgb()` is 1, `rgba(…, a)` is a, `transparent` is 0). */
function alphaOf(color: string): number {
  const c = color.trim();
  if (c === "transparent") return 0;
  const hex = /^#([0-9a-f]{3,8})$/i.exec(c)?.[1];
  if (hex) {
    if (hex.length === 3 || hex.length === 6) return 1;
    if (hex.length === 4) return Number.parseInt(hex.slice(3).repeat(2), 16) / 255;
    if (hex.length === 8) return Number.parseInt(hex.slice(6), 16) / 255;
    return 0;
  }
  const m = /^rgba?\(([^)]*)\)$/.exec(c);
  if (!m) return 0;
  const parts = (m[1] as string).split(/[\s,/]+/).filter(Boolean);
  if (parts.length < 4) return 1;
  const a = parts[3] as string;
  return a.endsWith("%") ? Number.parseFloat(a) / 100 : Number.parseFloat(a);
}

/**
 * Something in the block's own frame is known to paint an opaque background
 * under the whole of `rect` (this frame's viewport), 3-F1:
 * - the frame's canvas: the root's or the body's opaque background colour,
 *   which the browser paints across the whole viewport; or
 * - an ancestor-or-self of the block whose padding box contains the crop,
 *   with an opaque colour, `background-clip` of `border-box` or
 *   `padding-box`, and no border radius.
 * Anything else may let the embedding page show through: no screenshot.
 */
export function opaqueUnder(block: Element, rect: Box): boolean {
  const win = block.ownerDocument.defaultView;
  if (!win) return false;
  const style = (el: Element): CSSStyleDeclaration | null => {
    try {
      return win.getComputedStyle(el);
    } catch {
      return null;
    }
  };
  const opaque = (cs: CSSStyleDeclaration | null): boolean =>
    !!cs && alphaOf(cs.backgroundColor) >= 1;
  const doc = block.ownerDocument;
  if (doc.documentElement && opaque(style(doc.documentElement))) return true;
  if (doc.body && opaque(style(doc.body))) return true;
  const px = (v: string | undefined): number => Number.parseFloat(v ?? "") || 0;
  for (let el: Element | null = block; el; el = parentOf(el)) {
    const cs = style(el);
    if (!cs || !opaque(cs)) continue;
    const clip = (cs.backgroundClip || "border-box").trim();
    if (clip !== "border-box" && clip !== "padding-box") continue;
    const radii = [
      cs.borderTopLeftRadius,
      cs.borderTopRightRadius,
      cs.borderBottomRightRadius,
      cs.borderBottomLeftRadius,
    ];
    if (radii.some((r) => px(r) !== 0)) continue;
    // The padding box: inside the borders, without a scrollbar.
    const r = el.getBoundingClientRect();
    const left = r.left + el.clientLeft;
    const top = r.top + el.clientTop;
    if (
      left <= rect.x + 0.5 &&
      top <= rect.y + 0.5 &&
      left + el.clientWidth >= rect.x + rect.width - 0.5 &&
      top + el.clientHeight >= rect.y + rect.height - 0.5
    )
      return true;
  }
  return false;
}

/**
 * The browser's answer at one side of a grab (L-3 names each refusal): the
 * block's own pixels; something drawn over it, an effect on it, or no answer
 * (`covered`); no opaque background under it (`see-through`); or the block
 * no longer where the crop says (`moved`).
 */
export type OwnVerdict = "own" | "covered" | "see-through" | "moved";

/** The browser's own answer, at each side of a grab, to "are these the block's own pixels". */
export interface OwnPixels {
  /** Right before the grab: a fresh observation says so for `rect`. */
  start(): Promise<OwnVerdict>;
  /** Right after it: a fresh observation still says so, for `rect` where the block is now. */
  end(): Promise<OwnVerdict>;
  /** Stop watching (idempotent). */
  stop(): void;
}

/** How long the browser may take with an observation's first answer. */
const FIRST_ANSWER_MS = 1_500;
/** IntersectionObserver v2's least delay between answers. */
const VISIBILITY_DELAY_MS = 100;

type VisibleEntry = IntersectionObserverEntry & { isVisible?: boolean };

/**
 * The block's own pixels at one boundary of a grab, and across it (3-F1).
 * Each boundary starts a fresh IntersectionObserver that tracks visibility,
 * in the block's own frame, and takes its first answer (a bounded wait; none
 * means no screenshot): `isVisible` must be true (nothing from any document
 * drawn over the block, no effect on it; false in any doubt), its rectangle
 * must cover `rect`, the block must still be where the capture says (a block
 * that moved, however visible, is not), and an opaque background must lie
 * under `rect`. Between the two, one more observer watches every answer.
 * Without the API, no screenshot. Every observer is disconnected on every path.
 *
 * `rect` is what the grab keeps (all of the block in view, or one tile of
 * it, L-1); `placed` is where the whole block is, in this frame's viewport,
 * by the capture's own measure (`rect` when absent).
 */
export function watchOwnPixels(block: Element, rect: Box, placed: Box = rect): OwnPixels {
  const win = block.ownerDocument.defaultView as (Window & typeof globalThis) | null;
  const IO = win?.IntersectionObserver;
  const supported =
    !!IO &&
    typeof win?.IntersectionObserverEntry === "function" &&
    "isVisible" in win.IntersectionObserverEntry.prototype;
  const OPTIONS = {
    threshold: [0, 1],
    trackVisibility: true,
    delay: VISIBILITY_DELAY_MS,
  } as IntersectionObserverInit;
  const covers = (r: DOMRectReadOnly): boolean =>
    r.left <= rect.x + 1 &&
    r.top <= rect.y + 1 &&
    r.right >= rect.x + rect.width - 1 &&
    r.bottom >= rect.y + rect.height - 1;
  const fine = (e: IntersectionObserverEntry): boolean =>
    (e as VisibleEntry).isVisible === true && covers(e.intersectionRect);
  /** The viewport's part of a box. */
  const cut = (b: { x: number; y: number; width: number; height: number }): Box => {
    const vw = win?.innerWidth ?? 0;
    const vh = win?.innerHeight ?? 0;
    const x = Math.max(0, b.x);
    const y = Math.max(0, b.y);
    return {
      x,
      y,
      width: Math.min(b.x + b.width, vw) - x,
      height: Math.min(b.y + b.height, vh) - y,
    };
  };
  /** The block is still where the capture says: its box, cut to the viewport. */
  const inPlace = (): boolean => {
    if (!win || !block.isConnected) return false;
    const r = block.getBoundingClientRect();
    const now = cut({ x: r.left, y: r.top, width: r.width, height: r.height });
    const want = cut(placed);
    return (
      Math.abs(now.x - want.x) <= 0.5 &&
      Math.abs(now.y - want.y) <= 0.5 &&
      Math.abs(now.width - want.width) <= 0.5 &&
      Math.abs(now.height - want.height) <= 0.5
    );
  };

  const live = new Set<IntersectionObserver>();
  const open = (cb: IntersectionObserverCallback): IntersectionObserver | null => {
    if (!supported || !IO) return null;
    let io: IntersectionObserver | null = null;
    try {
      io = new IO(cb, OPTIONS);
      live.add(io);
      io.observe(block);
      return io;
    } catch {
      if (io) {
        io.disconnect();
        live.delete(io);
      }
      return null;
    }
  };
  const close = (io: IntersectionObserver | null): void => {
    if (!io) return;
    io.disconnect();
    live.delete(io);
  };
  /** A fresh observation's first answer, made now: nothing from before counts. */
  const observeNow = (): Promise<boolean> =>
    new Promise<boolean>((resolve) => {
      let io: IntersectionObserver | null = null;
      let timer: ReturnType<typeof setTimeout> | null = null;
      const finish = (ok: boolean): void => {
        if (timer !== null) clearTimeout(timer);
        timer = null;
        close(io);
        resolve(ok);
      };
      io = open((entries) => {
        const first = entries[0];
        if (first) finish(fine(first));
      });
      if (!io) {
        resolve(false);
        return;
      }
      timer = setTimeout(() => finish(false), FIRST_ANSWER_MS);
    });
  // The watch across the grab: any answer in doubt spoils it.
  let across: IntersectionObserver | null = null;
  let doubt: OwnVerdict | null = null;
  /** Not visible is a cover; visible but no longer over the crop is a move. */
  const judge = (e: IntersectionObserverEntry): void => {
    if ((e as VisibleEntry).isVisible !== true) doubt = "covered";
    else if (!covers(e.intersectionRect)) doubt ??= "moved";
  };
  const boundary = async (): Promise<OwnVerdict> => {
    if (!inPlace()) return "moved";
    if (!opaqueUnder(block, rect)) return "see-through";
    const ok = await observeNow();
    // Still in place once the answer came, and still on an opaque background.
    if (!inPlace()) return "moved";
    if (!opaqueUnder(block, rect)) return "see-through";
    return ok ? "own" : "covered";
  };
  const stop = (): void => {
    for (const io of [...live]) close(io);
    across = null;
  };
  return {
    start: async () => {
      const v = await boundary();
      if (v !== "own") return v;
      across = open((entries) => {
        for (const e of entries) judge(e);
      });
      return across !== null ? "own" : "covered";
    },
    end: async () => {
      if (!across) return "covered";
      // A change during the grab is told at most one delay later.
      await new Promise((r) => setTimeout(r, VISIBILITY_DELAY_MS + 50));
      for (const e of across.takeRecords()) judge(e);
      close(across);
      across = null;
      if (doubt) return doubt;
      return boundary();
    },
    stop,
  };
}

/* ── the block's content across a look in tiles (2-L1) ──────────────── */

/** Whether a block's content changed since the watch began. */
export interface BlockWatch {
  /** True once anything in the block changed (or the watch could not be kept). */
  changed(): boolean;
  /** Stop watching (idempotent). */
  stop(): void;
}

/** Every shadow tree under `block` the extension can see now (closed ones included). */
function shadowRootsUnder(block: Element): ShadowRoot[] {
  const found: ShadowRoot[] = [];
  const roots: Array<Element | ShadowRoot> = [block];
  while (roots.length > 0) {
    const at = roots.pop() as Element | ShadowRoot;
    const els =
      (at as Node).nodeType === 1
        ? [at as Element, ...at.querySelectorAll("*")]
        : [...at.querySelectorAll("*")];
    for (const el of els) {
      const shadow = shadowOf(el);
      if (!shadow) continue;
      found.push(shadow);
      roots.push(shadow);
    }
  }
  return found;
}

/**
 * Watch `block`'s subtree in its own document, and every shadow tree under it
 * that is known now (closed ones where the extension can see them), for any
 * change: child list, attributes, character data. Each read also looks for
 * shadow trees again: one attached or gone since the start is a change too
 * (3-L1). Tiles taken across a change would stitch two states of the block
 * into one picture. Without the API, or without a block, it reports a change.
 */
export function watchSubtree(block: Element | null): BlockWatch {
  const Observer = (
    block?.ownerDocument?.defaultView as (Window & typeof globalThis) | null | undefined
  )?.MutationObserver;
  if (!block || typeof Observer !== "function") return { changed: () => true, stop: () => {} };
  let changed = false;
  // One observer per root (the block, and each shadow tree under it): the
  // answer never depends on how one observer treats several targets.
  let observers: MutationObserver[] = [];
  const stop = (): void => {
    for (const mo of observers) mo.disconnect();
    observers = [];
  };
  let known: Set<ShadowRoot>;
  try {
    const options = { subtree: true, childList: true, attributes: true, characterData: true };
    const observe = (root: Element | ShadowRoot): void => {
      const mo = new Observer(() => {
        changed = true;
      });
      observers.push(mo);
      mo.observe(root, options);
    };
    observe(block);
    const shadows = shadowRootsUnder(block);
    for (const shadow of shadows) observe(shadow);
    known = new Set(shadows);
  } catch {
    stop();
    return { changed: () => true, stop: () => {} };
  }
  /** The shadow trees under the block now are exactly the ones found at the start. */
  const sameShadows = (): boolean => {
    try {
      const now = shadowRootsUnder(block);
      return now.length === known.size && now.every((s) => known.has(s));
    } catch {
      return false;
    }
  };
  return {
    changed: () => {
      for (const mo of observers) if (mo.takeRecords().length > 0) changed = true;
      if (!changed && !sameShadows()) changed = true;
      return changed;
    },
    stop,
  };
}
