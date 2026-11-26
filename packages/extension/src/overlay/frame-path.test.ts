import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Window } from "happy-dom";
import {
  anchorForElement,
  forgetResolutions,
  framePathTo,
  pinBlock,
  resolveAnchor,
} from "./anchors";
import {
  frameDocument,
  ownedFrameDocuments,
  reachableByOwner,
  rectInOwner,
  resolveFramePath,
} from "./frame-path";

// happy-dom gives frames no `origin` and no `frameElement`: each frame's
// window is told both, as a browser reports them.
const ORIGIN = "http://127.0.0.1:8124";
let win: Window | null = null;

function frameIn(
  doc: Document,
  id: string,
  opts: { protocol?: string; origin?: string; html?: string } = {},
): { frame: HTMLIFrameElement; doc: Document } {
  const frame = doc.createElement("iframe");
  frame.id = id;
  doc.body.appendChild(frame);
  const child = frame.contentWindow as unknown as Window & Record<string, unknown>;
  Object.defineProperty(child, "origin", { value: opts.origin ?? ORIGIN, configurable: true });
  Object.defineProperty(child, "frameElement", { value: frame, configurable: true });
  if (opts.protocol)
    Object.defineProperty(child, "location", {
      value: { protocol: opts.protocol, href: `${opts.protocol}//x/`, origin: opts.origin },
      configurable: true,
    });
  const cd = frame.contentDocument as Document;
  if (opts.html) cd.body.innerHTML = opts.html;
  return { frame, doc: cd };
}

beforeEach(() => {
  forgetResolutions();
  win = new Window({ url: `${ORIGIN}/page.html` });
  Object.defineProperty(win, "origin", { value: ORIGIN, configurable: true });
  const g = globalThis as unknown as Record<string, unknown>;
  g.window = win;
  g.document = win.document;
  g.Element = win.Element;
  g.HTMLElement = win.HTMLElement;
  g.Node = win.Node;
});
afterEach(async () => {
  await win?.happyDOM.close();
  win = null;
});

const top = (): Document => (win as unknown as Window).document as unknown as Document;

describe("A-3: a frame without an address of its own is part of the page that made it", () => {
  test("the path names the frames from the owner down, and leads back to the block", () => {
    const outer = frameIn(top(), "outer", { html: "<p>outer</p>" });
    const inner = frameIn(outer.doc, "inner", { html: '<p id="x">In a blank frame.</p>' });
    const block = inner.doc.querySelector("#x") as Element;
    expect(framePathTo(top())).toEqual([]);
    const path = framePathTo(inner.doc) as string[];
    expect(path).toEqual(["iframe#outer", "iframe#inner"]);
    expect(resolveFramePath(top(), path)).toBe(inner.doc);
    expect(anchorForElement(block, path)).toMatchObject({
      level: "element",
      selector: "p#x",
      framePath: ["iframe#outer", "iframe#inner"],
    });
    // The owner resolves it through those frames only.
    expect(resolveAnchor({ level: "element", selector: "p#x", framePath: path })).toBe(block);
    expect(resolveAnchor({ level: "element", selector: "p#x" })).toBeNull();
    // An anchor in the owner document carries no frame path.
    expect("framePath" in anchorForElement(top().body, [])).toBe(false);
    expect(ownedFrameDocuments(top())).toEqual([outer.doc, inner.doc]);
  });

  test("an opaque origin, another origin or a page with an address of its own is not part of it", () => {
    const opaque = frameIn(top(), "sandboxed", { origin: "null", html: "<p>s</p>" });
    const other = frameIn(top(), "other", { origin: "http://localhost:9", html: "<p>o</p>" });
    const web = frameIn(top(), "web", { protocol: "http:", origin: ORIGIN, html: "<p>w</p>" });
    const data = frameIn(top(), "data", { protocol: "data:", origin: "null", html: "<p>d</p>" });
    for (const f of [opaque, other, web, data]) {
      expect(framePathTo(f.doc)).toBeNull();
      expect(frameDocument(f.frame, ORIGIN)).toBeNull();
    }
    expect(ownedFrameDocuments(top())).toEqual([]);
    expect(resolveFramePath(top(), ["iframe#sandboxed"])).toBeNull();
    expect(
      resolveAnchor({ level: "element", selector: "p", framePath: ["iframe#web"] }),
    ).toBeNull();
  });

  test("a document under a page with its own address belongs to that page, not to the top", () => {
    const web = frameIn(top(), "web", { protocol: "http:", html: "<p>w</p>" });
    const blank = frameIn(web.doc, "blank", { html: '<p id="b">b</p>' });
    expect(framePathTo(blank.doc)).toBeNull();
    expect(framePathTo(blank.doc, web.doc)).toEqual(["iframe#blank"]);
  });

  test("a path resolves only through frame elements, at most four deep", () => {
    const f = frameIn(top(), "f", { html: '<p id="x">x</p>' });
    expect(resolveFramePath(top(), ["iframe#f"])).toBe(f.doc);
    expect(resolveFramePath(top(), ["body"])).toBeNull();
    expect(resolveFramePath(top(), ["iframe#nope"])).toBeNull();
    expect(resolveFramePath(top(), ["::bad("])).toBeNull();
    expect(resolveFramePath(top(), [])).toBeNull();
    let doc = top();
    for (let i = 0; i < 5; i += 1) doc = frameIn(doc, `d${i}`, { html: "<p>deep</p>" }).doc;
    expect(framePathTo(doc)).toBeNull();
    expect(
      resolveFramePath(top(), ["iframe#d0", "iframe#d1", "iframe#d2", "iframe#d3", "iframe#d4"]),
    ).toBeNull();
  });

  test("a box inside a frame is placed by the frame's own box", () => {
    const f = frameIn(top(), "f", { html: '<p id="x">x</p>' });
    const block = f.doc.querySelector("#x") as Element;
    f.frame.getBoundingClientRect = () => ({ left: 100, top: 50 }) as DOMRect;
    block.getBoundingClientRect = () => ({ left: 10, top: 5, width: 30, height: 20 }) as DOMRect;
    const r = rectInOwner(block, top());
    expect([r.left, r.top, r.right, r.bottom]).toEqual([110, 55, 140, 75]);
  });

  test("a frame only hints when no same-origin page above can take it in", () => {
    const blank = frameIn(top(), "blank", { html: "<p>b</p>" });
    const blankWin = blank.frame.contentWindow as unknown as Window & Record<string, unknown>;
    Object.defineProperty(blankWin, "parent", { value: win, configurable: true });
    Object.defineProperty(win as Window, "location", {
      value: { protocol: "http:", origin: ORIGIN, href: `${ORIGIN}/page.html` },
      configurable: true,
    });
    expect(reachableByOwner(blankWin as unknown as globalThis.Window)).toBe(true);
    const opaque = frameIn(top(), "op", { origin: "null" });
    expect(reachableByOwner(opaque.frame.contentWindow as unknown as globalThis.Window)).toBe(
      false,
    );
  });
});

describe("2-A2: a picked block is pinned to its document and frames", () => {
  test("holds while nothing moves; a block moved into another document fails for good", () => {
    const f = frameIn(top(), "f", { html: '<p id="x">x</p>' });
    const block = f.doc.querySelector("#x") as Element;
    const pin = pinBlock(block);
    expect(pin()).toBe(true);
    // Moved into a document of another page (still connected): not the same block.
    const other = frameIn(top(), "web", { protocol: "https:", html: "<div></div>" });
    // (happy-dom cannot adopt a node across documents: the move is what the
    // browser reports after one, a connected node with another owner.)
    Object.defineProperty(block, "ownerDocument", { value: other.doc, configurable: true });
    expect(block.isConnected).toBe(true);
    expect(pin()).toBe(false);
    Object.defineProperty(block, "ownerDocument", { value: f.doc, configurable: true });
    expect(pin()).toBe(false);
  });

  test("a frame replaced, moved or pointed at another document fails it", () => {
    const f = frameIn(top(), "f", { html: '<p id="x">x</p>' });
    const block = f.doc.querySelector("#x") as Element;
    const pin = pinBlock(block);
    // Another frame now answers the path from the owner.
    const twin = top().createElement("iframe");
    twin.id = "f";
    top().body.insertBefore(twin, f.frame);
    expect(pin()).toBe(false);

    const g = frameIn(top(), "g", { html: '<p id="y">y</p>' });
    const other = g.doc.querySelector("#y") as Element;
    const pinG = pinBlock(other);
    g.frame.remove();
    expect(pinG()).toBe(false);
  });

  test("a block in this document is pinned to it; one no owner reaches never holds", () => {
    const p = top().createElement("p");
    top().body.appendChild(p);
    const pin = pinBlock(p);
    expect(pin()).toBe(true);
    p.remove();
    expect(pin()).toBe(false);
    const opaque = frameIn(top(), "op", { origin: "null", html: '<p id="z">z</p>' });
    expect(pinBlock(opaque.doc.querySelector("#z") as Element)()).toBe(false);
  });
});
