// Block picking: what a pointer over the page picks, how the block is named,
// and that its selector finds it again.
import { beforeEach, describe, expect, test } from "bun:test";
import { Window } from "happy-dom";
import {
  blockLabel,
  blockTarget,
  describeBlock,
  keyboardBlocks,
  pickTarget,
  resolveBlock,
  selectorFor,
} from "./blocks";

let doc: Document;
const q = (sel: string): Element => doc.querySelector(sel) as Element;
const none = (): boolean => false;

beforeEach(() => {
  const win = new Window({ url: "https://onlay.dev/" });
  doc = win.document as unknown as Document;
  doc.body.innerHTML = `
    <header><a class="brand" href="/"><svg viewBox="0 0 8 8"><path d="M0 0"/></svg><span>Onlay</span></a></header>
    <main>
      <section>
        <h1 id="headline" data-variants="headline">Put agent work where it belongs.</h1>
        <p class="hero-sub">Onlay is a <strong>Chrome extension</strong> that anchors Comments and Edits to any live web page.</p>
        <p>Press <kbd>Ctrl+.</kbd> to begin.</p>
        <a class="cta" href="/install">Install the extension</a>
        <figure><video aria-label="The Onlay film"></video></figure>
      </section>
      <section><ul><li>One</li><li>Two</li></ul></section>
    </main>
    <aside data-demo-chrome><ol><li>Pick a block</li></ol></aside>
    <div data-onlay-demo></div>`;
});

describe("what a pointer picks", () => {
  test("the block under it", () => {
    expect(pickTarget(q("#headline"), none)).toBe(q("#headline"));
    expect(pickTarget(q("a.cta"), none)).toBe(q("a.cta"));
    expect(pickTarget(q("li"), none)).toBe(q("li"));
  });

  test("a word inside a line picks the line", () => {
    expect(pickTarget(q("strong"), none)).toBe(q(".hero-sub"));
    expect(pickTarget(q("kbd"), none)).toBe(q("kbd").parentElement);
    expect(pickTarget(q(".brand span"), none)).toBe(q(".brand"));
  });

  test("a stroke of a drawing picks the drawing", () => {
    expect(pickTarget(q("path"), none)).toBe(q("svg"));
  });

  test("the document's shell is not a block", () => {
    expect(pickTarget(doc.body, none)).toBeNull();
    expect(pickTarget(doc.documentElement, none)).toBeNull();
    expect(pickTarget(q("main"), none)).toBeNull();
    expect(pickTarget(null, none)).toBeNull();
  });

  test("the overlay and the page's own guide pick nothing", () => {
    const host = q("[data-onlay-demo]");
    expect(pickTarget(host, (el) => el === host)).toBeNull();
    expect(pickTarget(q("[data-demo-chrome] li"), none)).toBeNull();
    expect(pickTarget(q("[data-demo-chrome]"), none)).toBeNull();
  });
});

describe("how a block is named", () => {
  test("by its first forty characters", () => {
    expect(blockLabel(q("#headline"))).toBe("Put agent work where it belongs.");
    expect(blockLabel(q(".hero-sub"))).toBe("Onlay is a Chrome extension that anchors");
    expect(blockLabel(q(".hero-sub")).length).toBe(40);
  });

  test("by what names it when it has no text, else by its tag", () => {
    expect(blockLabel(q("video"))).toBe("The Onlay film");
    expect(blockLabel(q("svg"))).toBe("svg");
  });

  test("the variant panel's target is the tag with its id or first class", () => {
    expect(blockTarget(q("#headline"))).toBe("h1#headline");
    expect(blockTarget(q(".hero-sub"))).toBe("p.hero-sub");
    expect(blockTarget(q("li"))).toBe("li");
  });
});

describe("finding a block again", () => {
  test("every block's selector resolves to exactly that block", () => {
    for (const el of doc.querySelectorAll("main *, header *")) {
      const sel = selectorFor(el);
      expect(doc.querySelectorAll(sel)).toHaveLength(1);
      expect(doc.querySelector(sel)).toBe(el);
    }
  });

  test("an id is the whole selector; siblings are told apart by position", () => {
    expect(selectorFor(q("#headline"))).toBe("#headline");
    const [one, two] = [...doc.querySelectorAll("li")] as unknown as [Element, Element];
    expect(selectorFor(one)).not.toBe(selectorFor(two));
    expect(selectorFor(two)).toContain("li:nth-of-type(2)");
  });

  test("an anchor carries the block's Variants name only where the block has one", () => {
    const head = describeBlock(q("#headline"));
    expect(head).toEqual({
      selector: "#headline",
      label: "Put agent work where it belongs.",
      target: "h1#headline",
      prepared: "headline",
    });
    expect(resolveBlock(doc, head)).toBe(q("#headline"));
    expect(describeBlock(q(".hero-sub")).prepared).toBeUndefined();
    expect(resolveBlock(doc, { selector: "::nope(", label: "", target: "" })).toBeNull();
  });
});

describe("a pick without a pointer", () => {
  test("steps through the page's blocks, never the guide's", () => {
    const blocks = keyboardBlocks(doc);
    expect(blocks[0]).toBe(q("#headline"));
    expect(blocks).toContain(q("a.cta"));
    expect(blocks).toContain(q("figure"));
    expect(blocks.some((b) => b.closest("[data-demo-chrome]"))).toBe(false);
  });
});
