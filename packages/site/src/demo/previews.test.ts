// The page under several Edits: one preview engine per block, the real one
// (@onlay/render's), so whatever a visitor does with two Edits on the
// headline, taking everything off puts the headline back exactly.
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { createPreviewEngine } from "@onlay/render";
import { Window } from "happy-dom";
import { COPY, OWN } from "../copy";
import type { BlockAnchor } from "../overlay/model";
import { createPreviews, layersFor, type Previews, pillFor } from "./previews";
import { HEADLINE_LIGHT_CLASS, preparedVariants } from "./programs";
import { createStore, type DemoStore } from "./store";

const GLOBALS = [
  "window",
  "document",
  "Document",
  "DOMParser",
  "DocumentFragment",
  "Element",
  "HTMLElement",
  "MutationObserver",
  "Node",
  "Text",
] as const;
const g = globalThis as unknown as Record<string, unknown>;
const saved: Record<string, unknown> = {};
let win: Window;

beforeAll(() => {
  win = new Window({ url: "https://onlay.dev/" });
  for (const name of GLOBALS) saved[name] = g[name];
  g.window = win;
  g.document = win.document;
  for (const name of GLOBALS.slice(2)) g[name] = (win as unknown as Record<string, unknown>)[name];
});
afterAll(() => {
  for (const name of GLOBALS) {
    if (saved[name] === undefined) delete g[name];
    else g[name] = saved[name];
  }
});

const HEADLINE: BlockAnchor = {
  selector: "#headline",
  label: COPY.hero.headline,
  target: "h1#headline",
  prepared: "headline",
};
const SUB: BlockAnchor = { selector: "#sub", label: "Sub", target: "p#sub" };
const [ALT_A, ALT_B] = COPY.hero.headlineAlternates;
const VARIANTS = preparedVariants("headline");

let doc: Document;
let store: DemoStore;
let previews: Previews;
let original: string;
let ids = 0;
const headline = (): Element => doc.querySelector("#headline") as Element;

beforeEach(() => {
  doc = win.document as unknown as Document;
  doc.body.innerHTML = `<main><h1 class="hero-title" id="headline" data-variants="headline">${COPY.hero.headline}</h1><p id="sub">Sub</p></main>`;
  original = doc.body.innerHTML;
  ids = 0;
  store = createStore({ now: () => 1, id: () => `id-${++ids}` });
  previews = createPreviews(() => createPreviewEngine(doc));
  store.subscribe(() => previews.sync(store.items()));
});

// Engines of one document share an observer: none may outlive its test.
afterEach(() => previews.clear());

/** An Edit on the headline with all three variants posted and the first showing. */
function edit(anchor: BlockAnchor = HEADLINE): string {
  const item = store.edit(anchor, { intent: "x", method: "variant-set", count: 3 });
  store.postVariants(item.id, VARIANTS, true);
  return item.id;
}

describe("one Edit", () => {
  test("stepping changes the real headline, and the original is the page as it was", () => {
    const a = edit();
    expect(headline().textContent).toBe(ALT_A);
    store.cycle(a, 1);
    expect(headline().textContent).toBe(ALT_B);
    store.cycle(a, 1);
    expect(headline().textContent).toBe(COPY.hero.headline);
    expect(headline().classList.contains(HEADLINE_LIGHT_CLASS)).toBe(true);
    store.cycle(a, 1);
    expect(doc.body.innerHTML).toBe(original);
    expect(pillFor(store.items())).toEqual({ kind: "original" });
  });

  test("a pick stays on, its switch takes it off and puts it back", () => {
    const a = edit();
    store.pick(a);
    expect(headline().textContent).toBe(ALT_A);
    expect(pillFor(store.items())).toBeNull();
    store.setKept(a, false);
    expect(doc.body.innerHTML).toBe(original);
    store.setKept(a, true);
    expect(headline().textContent).toBe(ALT_A);
    store.resolve(a);
    expect(doc.body.innerHTML).toBe(original);
  });

  test("a discard puts the headline back", () => {
    const a = edit();
    store.cycle(a, 1);
    store.discard(a);
    expect(doc.body.innerHTML).toBe(original);
    expect(previews.applied()).toBe(0);
  });
});

describe("two Edits on the headline", () => {
  test("only the last one stepped shows; the other's variants are ready again", () => {
    const a = edit();
    store.cycle(a, 1);
    expect(headline().textContent).toBe(ALT_B);
    const b = edit();
    expect(headline().textContent).toBe(ALT_A);
    expect(store.get(a)?.variants?.shown).toBeNull();
    expect(store.get(b)?.variants?.shown).toBe(0);
    expect(pillFor(store.items())).toEqual({ kind: "variant", label: OWN.demo.variantLabels[0] });
    // back to the first: it takes the block, the second lets go
    store.cycle(a, 1);
    expect(store.get(b)?.variants?.shown).toBeNull();
    expect(headline().textContent).toBe(ALT_A);
    expect(previews.applied()).toBe(1);
  });

  test("switching between them never loses the original", () => {
    const a = edit();
    const b = edit();
    for (let i = 0; i < 7; i++) {
      store.cycle(i % 2 ? a : b, 1);
      store.cycle(i % 3 ? b : a, -1);
    }
    store.discard(a);
    store.discard(b);
    expect(doc.body.innerHTML).toBe(original);
  });

  test("discarding the one that shows leaves the other ready, and the page as it was", () => {
    const a = edit();
    const b = edit();
    store.discard(b);
    expect(doc.body.innerHTML).toBe(original);
    store.cycle(a, 1);
    expect(headline().textContent).toBe(ALT_A);
  });

  test("a preview sits over a kept edit, and its original is the kept page", () => {
    const a = edit();
    store.pick(a); // kept: the first rewording
    const b = edit(); // shows the first rewording too
    store.cycle(b, 1);
    store.cycle(b, 1); // the lighter weight, over the kept words
    expect(headline().textContent).toBe(ALT_A);
    expect(headline().classList.contains(HEADLINE_LIGHT_CLASS)).toBe(true);
    store.cycle(b, 1); // B's original: the page with what is kept
    expect(headline().textContent).toBe(ALT_A);
    expect(headline().classList.contains(HEADLINE_LIGHT_CLASS)).toBe(false);
    // hiding the kept edit shows the page as it was
    store.setKept(a, false);
    expect(doc.body.innerHTML).toBe(original);
  });

  test("two kept edits apply in the order they were kept; hiding either leaves the other", () => {
    const a = edit();
    store.cycle(a, 1);
    store.pick(a); // kept first: the second rewording
    const b = edit();
    store.cycle(b, -1);
    store.cycle(b, -1); // the lighter weight
    store.pick(b);
    expect(headline().textContent).toBe(ALT_B);
    expect(headline().classList.contains(HEADLINE_LIGHT_CLASS)).toBe(true);
    expect(layersFor(store.items()).get("#headline")?.key).toBe(`${a}:headline-2|${b}:headline-3`);
    store.setKept(a, false);
    expect(headline().textContent).toBe(COPY.hero.headline);
    expect(headline().classList.contains(HEADLINE_LIGHT_CLASS)).toBe(true);
    store.setKept(b, false);
    expect(doc.body.innerHTML).toBe(original);
  });

  test("Start over puts the headline back exactly, whatever was on it", () => {
    const a = edit();
    store.cycle(a, 1);
    store.pick(a);
    const b = edit();
    store.cycle(b, 1);
    const c = edit();
    store.cycle(c, -1);
    expect(doc.body.innerHTML).not.toBe(original);
    store.reset();
    expect(doc.body.innerHTML).toBe(original);
    expect(previews.applied()).toBe(0);
    // and the page still takes a fresh Edit from its true original
    const d = edit();
    store.cycle(d, 1);
    store.cycle(d, 1);
    store.cycle(d, 1);
    expect(doc.body.innerHTML).toBe(original);
  });
});

describe("other blocks", () => {
  test("each block has its own engine; one block's Edits never touch another", () => {
    const a = edit();
    const item = store.edit(SUB, { intent: "y", method: "variant-set", count: 1 });
    store.postVariants(
      item.id,
      [{ id: "s1", label: "Shorter", program: [{ op: "setText", target: ":scope", text: "S" }] }],
      true,
    );
    // a set on another block does not take the headline from its Edit
    expect(store.get(a)?.variants?.shown).toBe(0);
    expect(headline().textContent).toBe(ALT_A);
    expect(doc.querySelector("#sub")?.textContent).toBe("S");
    expect(previews.applied()).toBe(2);
    previews.clear();
    expect(doc.body.innerHTML).toBe(original);
  });
});
