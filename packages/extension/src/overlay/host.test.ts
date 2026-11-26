// The overlay is out of every look (C-1): hidden as a whole in this frame, and
// in every same-origin child frame, closed shadow roots and late frames included.
import { afterEach, beforeEach, expect, test } from "bun:test";
import { Window } from "happy-dom";
import { holdChildFramesHidden, holdHiddenForCapture, mountHost } from "./host";

const HIDER = Symbol.for("onlay.overlay.hideForCapture");
let win: Window | null = null;
let savedChrome: unknown;

beforeEach(() => {
  win = new Window({ url: "http://127.0.0.1:8124/page.html" });
  savedChrome = (globalThis as Record<string, unknown>).chrome;
});
afterEach(async () => {
  (globalThis as Record<string, unknown>).chrome = savedChrome;
  await win?.happyDOM.abort();
  win?.close();
  win = null;
});

const doc = (): Document => win?.document as unknown as Document;

/** A same-origin frame at a box, with a hider that records whether it is held. */
function frameAt(
  parent: ParentNode,
  box: { x: number; y: number; width: number; height: number },
  opts: { hider?: boolean } = {},
): { frame: HTMLIFrameElement; held: () => number; publish: () => void } {
  const frame = doc().createElement("iframe");
  (frame as unknown as { getBoundingClientRect: () => DOMRect }).getBoundingClientRect = () =>
    ({ left: box.x, top: box.y, width: box.width, height: box.height }) as DOMRect;
  parent.appendChild(frame);
  let holds = 0;
  const publish = (): void => {
    Object.defineProperty(frame.contentWindow as unknown as object, HIDER, {
      configurable: true,
      value: () => {
        holds += 1;
        let done = false;
        return () => {
          if (done) return;
          done = true;
          holds -= 1;
        };
      },
    });
  };
  if (opts.hider !== false) publish();
  return { frame, held: () => holds, publish };
}

const ALL = { x: 0, y: 0, width: 800, height: 600 };

test("the host is hidden as a whole: opacity 0 and visibility hidden, both important", () => {
  const { host } = mountHost(doc(), "open");
  const release = holdHiddenForCapture();
  expect(host.style.getPropertyValue("opacity")).toBe("0");
  expect(host.style.getPropertyPriority("opacity")).toBe("important");
  expect(host.style.getPropertyValue("visibility")).toBe("hidden");
  expect(host.style.getPropertyPriority("visibility")).toBe("important");
  // A host mounted while the capture runs is hidden the same way.
  const late = mountHost(doc(), "open").host;
  expect(late.style.getPropertyValue("opacity")).toBe("0");
  release();
  expect(late.style.getPropertyValue("opacity")).toBe("");
  expect(late.style.getPropertyValue("visibility")).toBe("visible");
});

test("frames in the page, in closed shadow roots and nested frames are all hidden, then shown", () => {
  const top = frameAt(doc().body, { x: 0, y: 0, width: 100, height: 100 });
  const widget = doc().createElement("x-widget");
  const closed = widget.attachShadow({ mode: "closed" });
  doc().body.appendChild(widget);
  const inShadow = frameAt(closed, { x: 200, y: 0, width: 100, height: 100 });
  (globalThis as Record<string, unknown>).chrome = {
    dom: { openOrClosedShadowRoot: (el: Element) => (el === widget ? closed : null) },
  };
  const hold = holdChildFramesHidden(doc());
  expect(top.held()).toBe(1);
  expect(inShadow.held()).toBe(1);
  hold.release();
  hold.release();
  expect(top.held()).toBe(0);
  expect(inShadow.held()).toBe(0);
});

test("a frame that arrives after hiding began is hidden when found, and fails the tile it touches", () => {
  const early = frameAt(doc().body, { x: 0, y: 0, width: 100, height: 100 });
  const hold = holdChildFramesHidden(doc());
  const mark = hold.sweep();
  // Held from before the grab: the tile stands.
  expect(hold.heldSince(ALL, mark)).toBe(true);
  const mark2 = hold.sweep();
  const late = frameAt(doc().body, { x: 50, y: 50, width: 100, height: 100 });
  // Found after the grab began: hidden now, but the tile it touches goes…
  expect(hold.heldSince(ALL, mark2)).toBe(false);
  expect(late.held()).toBe(1);
  // …while a tile it does not touch is still good.
  expect(hold.heldSince({ x: 400, y: 400, width: 100, height: 100 }, mark2)).toBe(true);
  // And from the next grab on it has held for the whole grab.
  expect(hold.heldSince(ALL, hold.sweep())).toBe(true);
  hold.release();
  expect(early.held()).toBe(0);
  expect(late.held()).toBe(0);
});

test("a frame whose overlay starts during the grab fails the tile; one with no overlay does not", () => {
  const quiet = frameAt(doc().body, { x: 0, y: 0, width: 100, height: 100 }, { hider: false });
  const hold = holdChildFramesHidden(doc());
  const mark = hold.sweep();
  expect(hold.heldSince(ALL, mark)).toBe(true); // no content script there: no overlay
  const mark2 = hold.sweep();
  quiet.publish(); // its content script came up while the tile was in flight
  expect(hold.heldSince(ALL, mark2)).toBe(false);
  expect(quiet.held()).toBe(1);
  hold.release();
  expect(quiet.held()).toBe(0);
});

/** A grab: the watch starts after the mark's sweep, `during` runs while the tile is taken. */
async function grabWith(
  hold: ReturnType<typeof holdChildFramesHidden>,
  rect: { x: number; y: number; width: number; height: number },
  during: () => void,
): Promise<boolean> {
  const mark = hold.sweep();
  const steady = hold.watch(rect, mark);
  during();
  await Promise.resolve(); // the grab is a round trip to the worker
  return steady();
}

test("a grab with no frame change keeps its tile (2-C1)", async () => {
  frameAt(doc().body, { x: 0, y: 0, width: 100, height: 100 });
  const hold = holdChildFramesHidden(doc());
  expect(await grabWith(hold, ALL, () => {})).toBe(true);
  hold.release();
});

test("a frame that comes and goes within one grab drops the tile, though no sweep saw it (2-C1)", async () => {
  const hold = holdChildFramesHidden(doc());
  const passing = await grabWith(hold, ALL, () => {
    const f = frameAt(doc().body, { x: 0, y: 0, width: 100, height: 100 });
    f.frame.remove();
  });
  expect(passing).toBe(false);
  hold.release();
});

test("a frame removed, re-parented or pointed elsewhere during a grab drops the tile (2-C1)", async () => {
  const a = frameAt(doc().body, { x: 0, y: 0, width: 100, height: 100 });
  const hold = holdChildFramesHidden(doc());
  expect(await grabWith(hold, ALL, () => a.frame.setAttribute("src", "about:blank#next"))).toBe(
    false,
  );
  const box = doc().createElement("div");
  doc().body.appendChild(box);
  expect(await grabWith(hold, ALL, () => box.appendChild(a.frame))).toBe(false);
  expect(await grabWith(hold, ALL, () => a.frame.remove())).toBe(false);
  hold.release();
});

test("a frame added inside a closed shadow root the hold knows drops the tile (2-C1)", async () => {
  const widget = doc().createElement("x-widget");
  const closed = widget.attachShadow({ mode: "closed" });
  doc().body.appendChild(widget);
  (globalThis as Record<string, unknown>).chrome = {
    dom: { openOrClosedShadowRoot: (el: Element) => (el === widget ? closed : null) },
  };
  const hold = holdChildFramesHidden(doc());
  const passing = await grabWith(hold, ALL, () => {
    frameAt(closed, { x: 0, y: 0, width: 100, height: 100 });
  });
  expect(passing).toBe(false);
  hold.release();
});

test("a frame that was in the rect before the grab and is out of it after drops the tile (2-C1)", async () => {
  const f = frameAt(doc().body, { x: 0, y: 0, width: 100, height: 100 });
  const hold = holdChildFramesHidden(doc());
  const passing = await grabWith(hold, { x: 0, y: 0, width: 200, height: 200 }, () => {
    (f.frame as unknown as { getBoundingClientRect: () => DOMRect }).getBoundingClientRect = () =>
      ({ left: 500, top: 500, width: 100, height: 100 }) as DOMRect;
  });
  expect(passing).toBe(false);
  hold.release();
});

test("a shadow host holding a frame that is removed, put back or moved during a grab drops the tile (3-C2)", async () => {
  const widget = doc().createElement("x-widget");
  const closed = widget.attachShadow({ mode: "closed" });
  doc().body.appendChild(widget);
  frameAt(closed, { x: 0, y: 0, width: 100, height: 100 }, { hider: false });
  (globalThis as Record<string, unknown>).chrome = {
    dom: { openOrClosedShadowRoot: (el: Element) => (el === widget ? closed : null) },
  };
  const box = doc().createElement("div");
  doc().body.appendChild(box);
  const hold = holdChildFramesHidden(doc());
  // The mutation names only the host (or its ancestor); the frame sits in its closed tree.
  expect(await grabWith(hold, ALL, () => widget.remove())).toBe(false);
  expect(await grabWith(hold, ALL, () => doc().body.appendChild(widget))).toBe(false);
  expect(await grabWith(hold, ALL, () => box.appendChild(widget))).toBe(false);
  expect(await grabWith(hold, ALL, () => box.remove())).toBe(false);
  // A host with no frame in its tree moving is no frame change.
  const plain = doc().createElement("x-plain");
  plain.attachShadow({ mode: "open" });
  doc().body.appendChild(plain);
  expect(await grabWith(hold, ALL, () => plain.remove())).toBe(true);
  hold.release();
});

/** A grab that lasts a few animation frames: `during` runs at its start, `later` midway. */
async function longGrab(
  hold: ReturnType<typeof holdChildFramesHidden>,
  rect: { x: number; y: number; width: number; height: number },
  during: () => void,
  later: () => void = () => {},
): Promise<boolean> {
  const mark = hold.sweep();
  const steady = hold.watch(rect, mark);
  during();
  await new Promise((r) => setTimeout(r, 60)); // several animation frames
  later();
  await new Promise((r) => setTimeout(r, 10));
  return steady();
}

const moveTo = (frame: Element, x: number, y: number): void => {
  (frame as unknown as { getBoundingClientRect: () => DOMRect }).getBoundingClientRect = () =>
    ({ left: x, top: y, width: 100, height: 100 }) as DOMRect;
};

test("a frame moved into the rect and back out by CSS alone during a grab drops the tile (F-7)", async () => {
  const f = frameAt(doc().body, { x: 500, y: 500, width: 100, height: 100 });
  const hold = holdChildFramesHidden(doc());
  const rect = { x: 0, y: 0, width: 200, height: 200 };
  expect(await longGrab(hold, rect, () => {})).toBe(true);
  // No mutation at all: only its box changes, and is back where it was by the end.
  expect(
    await longGrab(
      hold,
      rect,
      () => moveTo(f.frame, 0, 0),
      () => moveTo(f.frame, 500, 500),
    ),
  ).toBe(false);
  hold.release();
});

test("another origin's frame moved through the rect during a grab drops the tile too (F-7)", async () => {
  const frame = doc().createElement("iframe");
  moveTo(frame, 500, 500);
  doc().body.appendChild(frame);
  // Its document can't be read: another origin.
  Object.defineProperty(frame, "contentDocument", {
    get() {
      throw new Error("cross-origin");
    },
  });
  const hold = holdChildFramesHidden(doc());
  const rect = { x: 0, y: 0, width: 200, height: 200 };
  expect(
    await longGrab(
      hold,
      rect,
      () => moveTo(frame, 0, 0),
      () => moveTo(frame, 500, 500),
    ),
  ).toBe(false);
  hold.release();
});

test("a shadow root made during a grab that holds a frame drops the tile, though no mutation named it (F-7)", async () => {
  const widget = doc().createElement("x-widget");
  doc().body.appendChild(widget);
  let closed: ShadowRoot | null = null;
  (globalThis as Record<string, unknown>).chrome = {
    dom: { openOrClosedShadowRoot: (el: Element) => (el === widget ? closed : null) },
  };
  const hold = holdChildFramesHidden(doc());
  expect(
    await grabWith(hold, ALL, () => {
      // attachShadow on an element already in the page fires no mutation.
      closed = widget.attachShadow({ mode: "closed" }) as unknown as ShadowRoot;
      frameAt(closed as unknown as ParentNode, { x: 0, y: 0, width: 100, height: 100 });
    }),
  ).toBe(false);
  hold.release();
});

test("an element added during a grab is looked at for a shadow root as it is seen (F-7)", async () => {
  const hold = holdChildFramesHidden(doc());
  // Built off the page: its closed root already holds a frame when it goes in.
  const widget = doc().createElement("x-widget");
  const closed = widget.attachShadow({ mode: "closed" });
  frameAt(closed, { x: 0, y: 0, width: 100, height: 100 }, { hider: false });
  (globalThis as Record<string, unknown>).chrome = {
    dom: { openOrClosedShadowRoot: (el: Element) => (el === widget ? closed : null) },
  };
  const box = doc().createElement("div");
  box.appendChild(widget);
  // The mutation names only `box`; the frame is two levels down, in a closed tree.
  expect(await grabWith(hold, ALL, () => doc().body.appendChild(box))).toBe(false);
  hold.release();
});

test("a shadow root made during a grab with no frame in it keeps the tile (F-7)", async () => {
  const widget = doc().createElement("x-widget");
  doc().body.appendChild(widget);
  let open: ShadowRoot | null = null;
  (globalThis as Record<string, unknown>).chrome = {
    dom: { openOrClosedShadowRoot: (el: Element) => (el === widget ? open : null) },
  };
  const hold = holdChildFramesHidden(doc());
  expect(
    await longGrab(hold, ALL, () => {
      open = widget.attachShadow({ mode: "open" }) as unknown as ShadowRoot;
    }),
  ).toBe(true);
  hold.release();
});
