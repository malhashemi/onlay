// The content side of a look of a block inside a child frame (2-F1, 2-F2,
// 2-F6): the challenge goes to the measured window alone and counts only
// from the parent, every frame watch ends with its hold, and the block's own
// pixels need an opaque background and the browser's visibility answer.
import { afterEach, beforeEach, expect, test } from "bun:test";
import { Window as HappyWindow } from "happy-dom";
import {
  listenForLocates,
  nearestDelta,
  onFrameHold,
  onFrameRelease,
  onLocateUp,
  opaqueUnder,
  ownScale,
  plainFramePath,
  revealRect,
  ScrollLog,
  watchOwnPixels,
  watchSubtree,
} from "./frame-look";

let win: HappyWindow | null = null;
beforeEach(() => {
  win = new HappyWindow({ url: "https://shell.example/page" });
});
afterEach(async () => {
  await win?.happyDOM.abort();
  win?.close();
  win = null;
});

const w = (): Window => win as unknown as Window;

function box(el: Element, r: { x: number; y: number; width: number; height: number }): void {
  (el as unknown as { getBoundingClientRect: () => DOMRect }).getBoundingClientRect = () =>
    ({
      left: r.x,
      top: r.y,
      right: r.x + r.width,
      bottom: r.y + r.height,
      width: r.width,
      height: r.height,
    }) as DOMRect;
}

/** A message as the browser delivers one (trusted), or as a page could make one up. */
function message(target: Window, data: unknown, source: unknown, trusted = true): void {
  const Ctor = (w() as unknown as { MessageEvent: typeof MessageEvent }).MessageEvent;
  const e = new Ctor("message", { data });
  Object.defineProperty(e, "source", { value: source });
  Object.defineProperty(e, "isTrusted", { value: trusted });
  target.dispatchEvent(e);
}

test("a parent answers a locate with a challenge posted to the measured window alone, and reports it", () => {
  const doc = w().document;
  const frame = doc.createElement("iframe");
  doc.body.appendChild(frame);
  const child = frame.contentWindow as unknown as Window;
  const posted: unknown[] = [];
  (child as unknown as { postMessage: (m: unknown) => void }).postMessage = (m) => posted.push(m);
  const sent: Array<Record<string, unknown>> = [];
  listenForLocates(w(), { send: (m) => sent.push(m) });

  const rect = { x: 0, y: 0, width: 10, height: 10 };
  // A made-up event, whatever source it names, is not measured (3-F2).
  message(w(), { "onlay-locate": "n0", hold: "h1", phase: "pre", rect }, child, false);
  expect(sent).toEqual([]);
  expect(posted).toEqual([]);
  // A window that is no frame of this document is not measured.
  message(w(), { "onlay-locate": "n1", hold: "h1", phase: "pre", rect }, {});
  expect(sent).toEqual([]);
  message(w(), { "onlay-locate": "n2", hold: "h1", phase: "pre", rect }, child);
  expect(posted).toHaveLength(1);
  const challenge = (posted[0] as Record<string, unknown>)["onlay-challenge"];
  expect(typeof challenge).toBe("string");
  expect(sent[0]).toMatchObject({ type: "frameLocated", nonce: "n2", challenge, held: false });
  // The same nonce again is not measured twice.
  message(w(), { "onlay-locate": "n2", hold: "h1", phase: "pre", rect }, child);
  expect(sent).toHaveLength(1);
});

test("a child echoes a challenge only from its parent, and only for a nonce it posted", () => {
  const doc = w().document;
  const frame = doc.createElement("iframe");
  doc.body.appendChild(frame);
  const child = frame.contentWindow as unknown as Window;
  const top = w();
  (top as unknown as { postMessage: () => void }).postMessage = () => {};
  const sent: Array<Record<string, unknown>> = [];
  listenForLocates(child, { send: (m) => sent.push(m) });
  const K = "challenge-0000000000";
  // Not a nonce this frame posted.
  message(child, { "onlay-challenge": K, nonce: "n1" }, top);
  expect(sent).toEqual([]);
  onLocateUp(child, "n1", "h1", "pre", { x: 0, y: 0, width: 1, height: 1 });
  // A made-up challenge from the "parent" is not echoed (3-F2).
  message(child, { "onlay-challenge": K, nonce: "n1" }, top, false);
  expect(sent).toEqual([]);
  // Not from the parent.
  message(child, { "onlay-challenge": K, nonce: "n1" }, child);
  expect(sent).toEqual([]);
  message(child, { "onlay-challenge": K, nonce: "n1" }, top);
  expect(sent).toEqual([{ type: "frameEchoed", nonce: "n1", challenge: K, parentIsTop: true }]);
  // Once.
  message(child, { "onlay-challenge": K, nonce: "n1" }, top);
  expect(sent).toHaveLength(1);
});

test("every frame watch a locate starts ends on replacement and on release (2-F6)", () => {
  const g = globalThis as Record<string, unknown>;
  const saved = g.document;
  g.document = w().document;
  try {
    const doc = w().document;
    const frame = doc.createElement("iframe");
    doc.body.appendChild(frame);
    const child = frame.contentWindow as unknown as Window;
    (child as unknown as { postMessage: () => void }).postMessage = () => {};
    let started = 0;
    let ended = 0;
    const raf = w() as unknown as Record<string, unknown>;
    raf.requestAnimationFrame = () => {
      started += 1;
      return started;
    };
    raf.cancelAnimationFrame = () => {
      ended += 1;
    };
    listenForLocates(w(), { send: () => {} });
    onFrameHold("h1");
    const rect = { x: 0, y: 0, width: 10, height: 10 };
    message(w(), { "onlay-locate": "a", hold: "h1", phase: "pre", rect }, child);
    message(w(), { "onlay-locate": "b", hold: "h1", phase: "pre", rect }, child);
    // The first watch ended when the second replaced it.
    expect(ended).toBe(1);
    onFrameRelease("h1");
    expect(ended).toBe(2);
  } finally {
    g.document = saved;
  }
});

/** A box whose padding box (inside `border` px of border) is known. */
function paddingBox(
  el: HTMLElement,
  r: { x: number; y: number; width: number; height: number },
  border = 0,
): void {
  box(el, r);
  Object.defineProperty(el, "clientLeft", { value: border, configurable: true });
  Object.defineProperty(el, "clientTop", { value: border, configurable: true });
  Object.defineProperty(el, "clientWidth", { value: r.width - 2 * border, configurable: true });
  Object.defineProperty(el, "clientHeight", { value: r.height - 2 * border, configurable: true });
}

test("an opaque background known to paint the whole crop is needed (3-F1)", () => {
  const doc = w().document;
  const section = doc.createElement("section");
  const p = doc.createElement("p");
  section.appendChild(p);
  doc.body.appendChild(section);
  paddingBox(section, { x: 0, y: 0, width: 400, height: 100 });
  paddingBox(p, { x: 10, y: 10, width: 300, height: 20 });
  const crop = { x: 10, y: 10, width: 300, height: 20 };
  expect(opaqueUnder(p, crop)).toBe(false);
  section.style.backgroundColor = "rgba(255, 246, 224, 0.5)";
  expect(opaqueUnder(p, crop)).toBe(false);
  section.style.backgroundColor = "rgb(255, 246, 224)";
  expect(opaqueUnder(p, crop)).toBe(true);
  // An opaque ancestor whose padding box does not hold the crop is not enough.
  expect(opaqueUnder(p, { ...crop, width: 500 })).toBe(false);
  // Rounded corners, or a background clipped to the content box, may leave gaps.
  section.style.borderRadius = "8px";
  expect(opaqueUnder(p, crop)).toBe(false);
  section.style.borderRadius = "0px";
  section.style.backgroundClip = "content-box";
  expect(opaqueUnder(p, crop)).toBe(false);
  section.style.backgroundClip = "padding-box";
  expect(opaqueUnder(p, crop)).toBe(true);
  // The crop reaching into a border is outside the padding box.
  paddingBox(section, { x: 0, y: 0, width: 400, height: 100 }, 12);
  expect(opaqueUnder(p, crop)).toBe(false);
  // The frame's canvas: the body's opaque colour is painted across the viewport.
  doc.body.style.backgroundColor = "#fbfaf7";
  expect(opaqueUnder(p, { ...crop, width: 500 })).toBe(true);
});

test("without the browser's visibility answer there is no screenshot", async () => {
  const doc = w().document;
  const p = doc.createElement("p");
  doc.body.appendChild(p);
  doc.body.style.backgroundColor = "#fff";
  box(p, { x: 0, y: 0, width: 1, height: 1 });
  const own = watchOwnPixels(p, { x: 0, y: 0, width: 1, height: 1 });
  expect(await own.start()).toBe("covered");
  expect(await own.end()).toBe("covered");
  own.stop();
});

/** A stand-in for IntersectionObserver v2: each observe() answers once, with the block's box now. */
function fakeObserver(block: () => DOMRect, visible: () => boolean) {
  const made: Array<{ disconnected: boolean; observed: number }> = [];
  let throwOnObserve = false;
  class FakeIO {
    rec = { disconnected: false, observed: 0 };
    constructor(private cb: (e: unknown[]) => void) {
      made.push(this.rec);
    }
    observe(): void {
      if (throwOnObserve) throw new Error("observe failed");
      this.rec.observed += 1;
      setTimeout(() => {
        if (!this.rec.disconnected) this.cb([{ isVisible: visible(), intersectionRect: block() }]);
      }, 5);
    }
    disconnect(): void {
      this.rec.disconnected = true;
    }
    takeRecords(): unknown[] {
      return [];
    }
  }
  class FakeEntry {}
  Object.defineProperty(FakeEntry.prototype, "isVisible", { value: false });
  const g = w() as unknown as Record<string, unknown>;
  g.IntersectionObserver = FakeIO;
  g.IntersectionObserverEntry = FakeEntry;
  return {
    made,
    failObserve: () => {
      throwOnObserve = true;
    },
  };
}

test("a block that moves after the pre-grab check, still fully visible, gets no screenshot (3-F1)", async () => {
  const doc = w().document;
  doc.body.style.backgroundColor = "#fff";
  const p = doc.createElement("p");
  doc.body.appendChild(p);
  let at = { x: 10, y: 10, width: 100, height: 20 };
  const rectNow = () =>
    ({
      left: at.x,
      top: at.y,
      right: at.x + at.width,
      bottom: at.y + at.height,
      width: at.width,
      height: at.height,
    }) as DOMRect;
  (p as unknown as { getBoundingClientRect: () => DOMRect }).getBoundingClientRect = rectNow;
  const io = fakeObserver(rectNow, () => true);
  const crop = { x: 10, y: 10, width: 100, height: 20 };

  const own = watchOwnPixels(p, crop);
  expect(await own.start()).toBe("own");
  // It moves while the grab runs, and stays wholly visible where it went.
  at = { x: 10, y: 60, width: 100, height: 20 };
  expect(await own.end()).toBe("moved");
  own.stop();
  // A fresh observer before the grab and one across it (the end refused
  // before asking: the block is not where the crop is), all disconnected.
  expect(io.made.length).toBe(2);
  expect(io.made.every((m) => m.disconnected)).toBe(true);

  // Unmoved: a fresh answer at the end says yes.
  at = { ...crop };
  const before = io.made.length;
  const still = watchOwnPixels(p, crop);
  expect(await still.start()).toBe("own");
  expect(await still.end()).toBe("own");
  still.stop();
  // Fresh at each boundary, plus the one across: three, all disconnected.
  expect(io.made.length - before).toBe(3);
  expect(io.made.every((m) => m.disconnected)).toBe(true);
});

test("an observer whose observe() throws is disconnected, and there is no screenshot (3-F1)", async () => {
  const doc = w().document;
  doc.body.style.backgroundColor = "#fff";
  const p = doc.createElement("p");
  doc.body.appendChild(p);
  const r = { left: 0, top: 0, right: 10, bottom: 10, width: 10, height: 10 } as DOMRect;
  (p as unknown as { getBoundingClientRect: () => DOMRect }).getBoundingClientRect = () => r;
  const io = fakeObserver(
    () => r,
    () => true,
  );
  io.failObserve();
  const own = watchOwnPixels(p, { x: 0, y: 0, width: 10, height: 10 });
  expect(await own.start()).toBe("covered");
  expect(io.made.length).toBe(1);
  expect(io.made[0]?.disconnected).toBe(true);
  own.stop();
});

test("a covered block, by the fresh answer at either boundary, gets no screenshot (3-F1)", async () => {
  const doc = w().document;
  doc.body.style.backgroundColor = "#fff";
  const p = doc.createElement("p");
  doc.body.appendChild(p);
  const r = { left: 0, top: 0, right: 10, bottom: 10, width: 10, height: 10 } as DOMRect;
  (p as unknown as { getBoundingClientRect: () => DOMRect }).getBoundingClientRect = () => r;
  let visible = true;
  fakeObserver(
    () => r,
    () => visible,
  );
  const own = watchOwnPixels(p, { x: 0, y: 0, width: 10, height: 10 });
  expect(await own.start()).toBe("own");
  visible = false; // something is drawn over it by the end
  expect(await own.end()).toBe("covered");
  own.stop();
});

/* ── scaled, shifted and tilted frames (L-2) ── */

const style = (s: Record<string, string>): CSSStyleDeclaration =>
  s as unknown as CSSStyleDeclaration;

test("an element's own transform is read as a 2D scale, or refused when it tilts", () => {
  expect(ownScale(style({ transform: "none" }))).toEqual({ x: 1, y: 1 });
  expect(ownScale(style({ transform: "matrix(0.8, 0, 0, 0.8, 12, 4)" }))).toEqual({
    x: 0.8,
    y: 0.8,
  });
  expect(ownScale(style({ transform: "matrix(1.5, 0, 0, 0.5, 0, 0)", scale: "2" }))).toEqual({
    x: 3,
    y: 1,
  });
  expect(ownScale(style({ translate: "10px 20px" }))).toEqual({ x: 1, y: 1 });
  // Rotation, skew, a flip, 3D, a rotate or 3D translate property, a motion path, a zoom.
  for (const s of [
    { transform: "matrix(0.996, 0.087, -0.087, 0.996, 0, 0)" },
    { transform: "matrix(1, 0, 0.5, 1, 0, 0)" },
    { transform: "matrix(-1, 0, 0, 1, 0, 0)" },
    { transform: "matrix3d(1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1)" },
    { rotate: "5deg" },
    { scale: "-1 1" },
    { translate: "0px 0px 10px" },
    { offsetPath: "path('M 0 0 L 10 10')" },
    { zoom: "1.5" },
  ])
    expect(ownScale(style(s))).toBe("tilted");
  expect(ownScale(style({ rotate: "0deg" }))).toEqual({ x: 1, y: 1 });
});

test("a parent says at once that a rotated frame can't be mapped", () => {
  const doc = w().document;
  const frame = doc.createElement("iframe");
  frame.style.transform = "rotate(5deg)";
  doc.body.appendChild(frame);
  const child = frame.contentWindow as unknown as Window;
  (child as unknown as { postMessage: (m: unknown) => void }).postMessage = () => {};
  const sent: Array<Record<string, unknown>> = [];
  listenForLocates(w(), { send: (m) => sent.push(m) });
  const rect = { x: 0, y: 0, width: 10, height: 10 };
  message(w(), { "onlay-locate": "t1", hold: "h1", phase: "pre", rect }, child);
  expect(sent[0]).toMatchObject({ type: "frameLocated", nonce: "t1", tilted: true });
});

/* ── bringing a block into view, and putting it back (L-1) ── */

test("the nearest scroll shows a span: none when it shows, its start first when it can't fit", () => {
  expect(nearestDelta(100, 50, 0, 600)).toBe(0);
  expect(nearestDelta(700, 50, 0, 600)).toBe(150);
  expect(nearestDelta(-80, 50, 0, 600)).toBe(-80);
  expect(nearestDelta(300, 900, 0, 600)).toBe(300);
});

/** A scroller whose box and scroll are stood in for. */
function scroller(el: HTMLElement, r: { x: number; y: number; width: number; height: number }) {
  paddingBox(el, r);
  el.style.overflowY = "auto";
  Object.defineProperty(el, "scrollHeight", { value: 5000, configurable: true });
  Object.defineProperty(el, "scrollWidth", { value: r.width, configurable: true });
  Object.defineProperty(el, "offsetWidth", { value: r.width, configurable: true });
  Object.defineProperty(el, "offsetHeight", { value: r.height, configurable: true });
  const at = { left: 0, top: 0 };
  Object.defineProperty(el, "scrollTop", { get: () => at.top, configurable: true });
  Object.defineProperty(el, "scrollLeft", { get: () => at.left, configurable: true });
  (el as unknown as { scrollTo: (o: ScrollToOptions) => void }).scrollTo = (o) => {
    at.left = Math.max(0, o.left ?? at.left);
    at.top = Math.max(0, o.top ?? at.top);
  };
  return at;
}

test("a rect is shown by scrolling its scrollers, and every first position is put back", () => {
  const doc = w().document;
  const pane = doc.createElement("div");
  const p = doc.createElement("p");
  pane.appendChild(p);
  doc.body.appendChild(pane);
  const at = scroller(pane, { x: 0, y: 0, width: 400, height: 300 });
  const log = new ScrollLog();
  // 800 down the pane: scrolled so its bottom is the pane's.
  expect(revealRect(p, { x: 0, y: 800, width: 100, height: 50 }, log)).toEqual({
    moved: true,
    dx: 0,
    dy: -550,
  });
  expect(at.top).toBe(550);
  expect(revealRect(p, { x: 0, y: 1000, width: 100, height: 50 }, log).moved).toBe(true);
  expect(log.size).toBe(1);
  log.restore();
  expect(at.top).toBe(0);
});

test("a parent scrolls to show a frame's block only for a hold it holds, and puts it back at the release (L-1)", () => {
  const g = globalThis as unknown as { document?: unknown };
  const saved = g.document;
  g.document = w().document;
  try {
    const doc = w().document;
    const pane = doc.createElement("div");
    const frame = doc.createElement("iframe");
    pane.appendChild(frame);
    doc.body.appendChild(pane);
    const at = scroller(pane, { x: 0, y: 0, width: 800, height: 400 });
    box(frame, { x: 0, y: 900, width: 400, height: 300 });
    Object.defineProperty(frame, "clientWidth", { value: 400, configurable: true });
    Object.defineProperty(frame, "clientHeight", { value: 300, configurable: true });
    Object.defineProperty(frame, "offsetWidth", { value: 400, configurable: true });
    Object.defineProperty(frame, "offsetHeight", { value: 300, configurable: true });
    const child = frame.contentWindow as unknown as Window;
    (child as unknown as { postMessage: (m: unknown) => void }).postMessage = () => {};
    const sent: Array<Record<string, unknown>> = [];
    listenForLocates(w(), { send: (m) => sent.push(m) });
    const rect = { x: 0, y: 0, width: 100, height: 100 };
    // No hold here: nothing scrolls.
    message(w(), { "onlay-locate": "r0", hold: "h9", phase: "pre", rect, reveal: true }, child);
    expect(at.top).toBe(0);
    onFrameHold("h9");
    message(w(), { "onlay-locate": "r1", hold: "h9", phase: "pre", rect, reveal: true }, child);
    expect(at.top).toBe(600);
    // A post-grab locate never scrolls.
    message(w(), { "onlay-locate": "r2", hold: "h9", phase: "post", rect, reveal: true }, child);
    expect(at.top).toBe(600);
    // The same hold again renews it; the release puts the scroll back.
    onFrameHold("h9");
    onFrameRelease("h9");
    expect(at.top).toBe(0);
  } finally {
    g.document = saved;
  }
});

test("a child posts the reveal only before a grab", () => {
  const parent = { postMessage: (m: unknown) => got.push(m) };
  const got: unknown[] = [];
  const child = { parent } as unknown as Window;
  const rect = { x: 0, y: 0, width: 1, height: 1 };
  onLocateUp(child, "u1", "h1", "pre", rect, true);
  onLocateUp(child, "u2", "h1", "post", rect, true);
  expect(got[0]).toMatchObject({ "onlay-locate": "u1", reveal: true });
  expect((got[1] as Record<string, unknown>).reveal).toBeUndefined();
});

test("a tile is checked against where the whole block is, not against itself (L-1)", async () => {
  const doc = w().document;
  doc.body.style.backgroundColor = "#fff";
  const p = doc.createElement("p");
  doc.body.appendChild(p);
  // A block taller than the viewport: its top tile is 0..300 of it.
  const r = { left: 0, top: 0, right: 100, bottom: 2000, width: 100, height: 2000 } as DOMRect;
  (p as unknown as { getBoundingClientRect: () => DOMRect }).getBoundingClientRect = () => r;
  fakeObserver(
    () => ({ left: 0, top: 0, right: 100, bottom: 600, width: 100, height: 600 }) as DOMRect,
    () => true,
  );
  const tile = { x: 0, y: 0, width: 100, height: 300 };
  const placed = { x: 0, y: 0, width: 100, height: 2000 };
  const own = watchOwnPixels(p, tile, placed);
  expect(await own.start()).toBe("own");
  own.stop();
  // Checked against the tile alone, the block would seem to have moved.
  const wrong = watchOwnPixels(p, tile);
  expect(await wrong.start()).toBe("moved");
  wrong.stop();
});

test("looks that overlap share each scroller's first position, put back when the last lets go (2-L2)", () => {
  const doc = w().document;
  const pane = doc.createElement("div");
  doc.body.appendChild(pane);
  const at = scroller(pane, { x: 0, y: 0, width: 400, height: 300 });
  const first = new ScrollLog();
  const second = new ScrollLog();
  // The first look scrolls the pane; the second starts while it is moved.
  revealRect(
    pane.appendChild(doc.createElement("p")),
    { x: 0, y: 800, width: 10, height: 10 },
    first,
  );
  expect(at.top).toBe(510);
  revealRect(pane.lastElementChild as Element, { x: 0, y: 600, width: 10, height: 10 }, second);
  expect(at.top).toBe(820);
  // The first lets go first: the pane stays for the second.
  first.restore();
  expect(at.top).toBe(820);
  // The last puts it where it was before either.
  second.restore();
  expect(at.top).toBe(0);
});

/**
 * A MutationObserver the test drives itself. The test DOM holds an observer's
 * callback only through a WeakRef, so a real one can be collected mid-test and
 * go quiet; what a browser's observer reports is proven in the frames journey.
 */
class DrivenObserver {
  static all: DrivenObserver[] = [];
  private targets: Node[] = [];
  private pending = 0;
  constructor(_callback: () => void) {
    DrivenObserver.all.push(this);
  }
  observe(target: Node): void {
    this.targets.push(target);
  }
  takeRecords(): unknown[] {
    const n = this.pending;
    this.pending = 0;
    return Array.from({ length: n }, () => ({}));
  }
  disconnect(): void {
    this.targets = [];
  }
  /** A change at `node` reaches every observer watching a root that holds it. */
  static changeAt(node: Node): void {
    for (const o of DrivenObserver.all) {
      if (o.targets.some((t) => t === node || t.contains(node))) o.pending += 1;
    }
  }
  static watching(): number {
    return DrivenObserver.all.filter((o) => o.targets.length > 0).length;
  }
}

test("a block's content is watched for any change, its known shadow trees included (2-L1)", () => {
  const doc = w().document;
  const block = doc.createElement("section");
  const p = doc.createElement("p");
  p.textContent = "Q3";
  block.appendChild(p);
  const host = doc.createElement("div");
  block.appendChild(host);
  // A closed shadow tree, seen as the extension sees it.
  const shadow = host.attachShadow({ mode: "closed" });
  const inner = doc.createElement("span");
  shadow.appendChild(inner);
  doc.body.appendChild(block);
  const outside = doc.createElement("aside");
  doc.body.appendChild(outside);
  const g = globalThis as unknown as { chrome?: unknown };
  const savedChrome = g.chrome;
  g.chrome = { dom: { openOrClosedShadowRoot: (e: Element) => (e === host ? shadow : null) } };
  const view = w() as unknown as { MutationObserver: unknown };
  const savedObserver = view.MutationObserver;
  view.MutationObserver = DrivenObserver;
  DrivenObserver.all = [];
  try {
    // The block's own text, an attribute, its children, and its shadow tree.
    for (const [i, at] of [p.firstChild as Node, p, block, inner].entries()) {
      const watch = watchSubtree(block);
      expect(watch.changed(), `case ${i}`).toBe(false);
      DrivenObserver.changeAt(at);
      expect(watch.changed(), `case ${i}`).toBe(true);
      // Once seen, a change stays seen.
      expect(watch.changed(), `case ${i}`).toBe(true);
      watch.stop();
    }
    // The block and its one shadow tree are each watched, and let go on stop.
    const watch = watchSubtree(block);
    expect(DrivenObserver.watching()).toBe(2);
    // Outside the block: no change.
    DrivenObserver.changeAt(outside);
    expect(watch.changed()).toBe(false);
    watch.stop();
    expect(DrivenObserver.watching()).toBe(0);
    // No block to watch: counts as changed.
    expect(watchSubtree(null).changed()).toBe(true);
  } finally {
    g.chrome = savedChrome;
    view.MutationObserver = savedObserver;
  }
});

test("a shadow tree attached to a block's host during the look counts as a change (3-L1)", async () => {
  const doc = w().document;
  const block = doc.createElement("section");
  const host = doc.createElement("div");
  block.appendChild(host);
  doc.body.appendChild(block);
  const roots = new Map<Element, ShadowRoot>();
  const g = globalThis as unknown as { chrome?: unknown };
  const savedChrome = g.chrome;
  g.chrome = { dom: { openOrClosedShadowRoot: (e: Element) => roots.get(e) ?? null } };
  try {
    const watch = watchSubtree(block);
    expect(watch.changed()).toBe(false);
    // Attaching a shadow root makes no mutation record; the next read finds it.
    roots.set(host, host.attachShadow({ mode: "closed" }));
    expect(watch.changed()).toBe(true);
    watch.stop();
    // Watched with it from the start, then gone.
    const again = watchSubtree(block);
    expect(again.changed()).toBe(false);
    roots.delete(host);
    expect(again.changed()).toBe(true);
    again.stop();
  } finally {
    g.chrome = savedChrome;
  }
});

/* ── a placement, once, for a composer card beside a block in a child frame ── */

/** A frame element with a layout size that matches its box, as a browser lays it out. */
function laidOut(
  el: HTMLElement,
  r: { x: number; y: number; width: number; height: number },
): void {
  box(el, r);
  for (const [k, v] of [
    ["offsetWidth", r.width],
    ["offsetHeight", r.height],
    ["clientWidth", r.width],
    ["clientHeight", r.height],
  ] as const)
    Object.defineProperty(el, k, { value: v, configurable: true });
}

test("a parent answers a placement with the frame's box alone, and keeps nothing", () => {
  const doc = w().document;
  const frame = doc.createElement("iframe");
  doc.body.appendChild(frame);
  laidOut(frame, { x: 20, y: 600, width: 800, height: 400 });
  const child = frame.contentWindow as unknown as Window;
  (child as unknown as { postMessage: (m: unknown) => void }).postMessage = () => {};
  const sent: Array<Record<string, unknown>> = [];
  listenForLocates(w(), { send: (m) => sent.push(m) });
  const empty = { x: 0, y: 0, width: 0, height: 0 };
  message(w(), { "onlay-locate": "pl1", hold: "x1", phase: "place", rect: empty }, child);
  expect(sent[0]).toMatchObject({
    type: "frameLocated",
    nonce: "pl1",
    box: { x: 20, y: 600 },
    foreign: [],
    held: false,
  });
});

test("a block's frames without an address of their own map by plain offsets only when nothing transforms them", () => {
  const doc = w().document;
  const frame = doc.createElement("iframe");
  doc.body.appendChild(frame);
  laidOut(frame, { x: 0, y: 0, width: 300, height: 100 });
  const innerWin = frame.contentWindow as unknown as Window;
  // happy-dom has no `frameElement`: the browser's, stood in.
  Object.defineProperty(innerWin, "frameElement", { value: frame });
  const inner = innerWin.document;
  const block = inner.createElement("p");
  inner.body.appendChild(block);
  expect(plainFramePath(block, doc)).toBe(true);
  expect(plainFramePath(doc.body, doc)).toBe(true);
  frame.style.transform = "rotate(5deg)";
  expect(plainFramePath(block, doc)).toBe(false);
  frame.style.transform = "scale(1.5)";
  expect(plainFramePath(block, doc)).toBe(false);
});
