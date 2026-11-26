import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { Anchor } from "@onlay/protocol";
import { Window } from "happy-dom";
import {
  anchorForElement,
  anchorLabel,
  blockFor,
  boundedText,
  cssPath,
  forgetResolutions,
  isGeneratedClass,
  isGeneratedId,
  isUnique,
  resolveAnchor,
  searchBySnippet,
  segmentFor,
  tagOfSelector,
  textConsistent,
} from "./anchors";

let win: Window | null = null;

function installDom(html: string): void {
  win = new Window({ url: "http://127.0.0.1:8124/page.html" });
  const g = globalThis as unknown as {
    window: unknown;
    document: Document;
    Element: typeof Element;
    HTMLElement: typeof HTMLElement;
    Node: typeof Node;
  };
  g.window = win;
  g.document = win.document as unknown as Document;
  g.Element = win.Element as unknown as typeof Element;
  g.HTMLElement = win.HTMLElement as unknown as typeof HTMLElement;
  g.Node = win.Node as unknown as typeof Node;
  win.document.body.innerHTML = html;
}

beforeEach(() => {
  forgetResolutions();
  installDom("");
});
afterEach(() => {
  win?.happyDOM.cancelAsync();
  win?.close();
  win = null;
});

describe("anchorLabel (pure)", () => {
  test("page-level", () => {
    expect(anchorLabel({ level: "page" })).toBe("page-level");
  });
  test("blockId wins with a section marker", () => {
    const a: Anchor = { level: "element", selector: "#x", blockId: "decision-matrix" };
    expect(anchorLabel(a)).toBe("§decision-matrix");
  });
  test("selection quotes its text", () => {
    const a: Anchor = { level: "selection", selector: "p", text: "hello world" };
    expect(anchorLabel(a)).toBe("“hello world”");
  });
  test("element falls back to the selector tail", () => {
    const a: Anchor = { level: "element", selector: "div > button.cta" };
    expect(anchorLabel(a)).toBe("button.cta");
  });
});

describe("selectors + resolution (happy-dom)", () => {
  test("isUnique reflects match count", () => {
    installDom(`<div id="solo"></div><span class="dup"></span><span class="dup"></span>`);
    expect(isUnique("#solo")).toBe(true);
    expect(isUnique(".dup")).toBe(false);
  });

  test("cssPath prefers a unique id, tag-qualified", () => {
    installDom(`<main><button id="go">go</button></main>`);
    const btn = document.getElementById("go") as Element;
    expect(cssPath(btn)).toBe("button#go");
  });

  test("segmentFor adds nth-of-type for siblings", () => {
    installDom(`<ul><li>a</li><li>b</li></ul>`);
    const second = document.querySelectorAll("li")[1] as Element;
    expect(segmentFor(second)).toContain(":nth-of-type(2)");
  });

  test("anchorForElement carries a data-onlay-block id", () => {
    installDom(`<section data-onlay-block="b1"><p id="p">text</p></section>`);
    const p = document.getElementById("p") as Element;
    const anchor = anchorForElement(p);
    expect(anchor.level).toBe("element");
    if (anchor.level === "element") expect(anchor.blockId).toBe("b1");
  });

  test("blockFor climbs to the nearest onlay-block", () => {
    installDom(`<section data-onlay-block="b2"><span id="s">hi</span></section>`);
    const s = document.getElementById("s") as Element;
    const b = blockFor(s);
    expect(b.blockId).toBe("b2");
    expect(b.el.getAttribute("data-onlay-block")).toBe("b2");
  });

  test("resolveAnchor returns null when the element is gone", () => {
    installDom(`<div id="here"></div>`);
    const live: Anchor = { level: "element", selector: "#here" };
    expect(resolveAnchor(live)).not.toBeNull();
    const lost: Anchor = { level: "element", selector: "#nowhere" };
    expect(resolveAnchor(lost)).toBeNull();
    expect(resolveAnchor({ level: "page" })).toBeNull();
  });
});

describe("textConsistent (pure)", () => {
  const stored = "Welcome to our store. The summer sale ends Friday at midnight.";
  test("same text, ignoring whitespace and case", () => {
    expect(
      textConsistent(stored, "  welcome to OUR store.\n The summer sale ends Friday at midnight. "),
    ).toBe(true);
  });
  test("a trailing change still matches", () => {
    expect(
      textConsistent(stored, "Welcome to our store. The summer sale ends Monday at noon."),
    ).toBe(true);
    expect(textConsistent("Sale ends Friday", "Sale ends Monday")).toBe(true);
  });
  test("a block that grew still contains the stored start", () => {
    expect(textConsistent("Pricing", "Pricing plans for every team")).toBe(true);
  });
  test("a different block is rejected", () => {
    expect(textConsistent(stored, "Sign in to see your orders and saved items.")).toBe(false);
    expect(textConsistent("Second item: blue shoes", "First item: red hat")).toBe(false);
  });
  test("an empty block never matches a stored snippet", () => {
    expect(textConsistent("Hello", "   ")).toBe(false);
  });
  test("no stored snippet: anything is consistent", () => {
    expect(textConsistent(undefined, "whatever")).toBe(true);
    expect(textConsistent("", "")).toBe(true);
  });
  test("a short live text is not taken for a long stored one", () => {
    expect(textConsistent("Buy now and save twenty percent on every order", "Buy")).toBe(false);
  });
});

describe("anchor verification (happy-dom)", () => {
  test("a selector match with consistent text resolves", () => {
    installDom(`<ul><li>Red hat</li><li>Blue shoes</li></ul>`);
    const a: Anchor = {
      level: "element",
      selector: "ul > li:nth-of-type(2)",
      snippet: "Blue shoes",
    };
    expect(resolveAnchor(a)?.textContent).toBe("Blue shoes");
  });

  test("reordered siblings: the nth-of-type moved, the snippet finds the block", () => {
    installDom(`<ul><li>Blue shoes</li><li>Red hat</li></ul>`);
    const a: Anchor = {
      level: "element",
      selector: "ul > li:nth-of-type(2)",
      snippet: "Blue shoes",
    };
    expect(resolveAnchor(a)?.textContent).toBe("Blue shoes");
  });

  test("a different block with the same tag and no snippet match is lost", () => {
    installDom(`<ul><li>Green scarf</li><li>Red hat</li></ul>`);
    const a: Anchor = {
      level: "element",
      selector: "ul > li:nth-of-type(2)",
      snippet: "Blue shoes",
    };
    expect(resolveAnchor(a)).toBeNull();
  });

  test("an ambiguous snippet is lost rather than guessed", () => {
    installDom(`<p>Add to cart</p><p>Add to cart</p>`);
    const a: Anchor = { level: "element", selector: "#gone", snippet: "Add to cart" };
    expect(resolveAnchor(a)).toBeNull();
  });

  test("a wrapper and its only child tie: the innermost wins", () => {
    installDom(`<div class="w"><div class="in">Unique words here</div></div>`);
    const found = searchBySnippet(document, "div", "Unique words here", (e) => e.textContent ?? "");
    expect(found?.className).toBe("in");
  });

  test("an anchor with no stored snippet keeps the plain selector match", () => {
    installDom(`<p id="x">Anything</p>`);
    expect(resolveAnchor({ level: "element", selector: "#x" })?.id).toBe("x");
  });

  test("selection anchors verify against their selected text", () => {
    installDom(`<p id="a">The quick brown fox</p><p id="b">Lorem ipsum dolor</p>`);
    expect(resolveAnchor({ level: "selection", selector: "#a", text: "quick brown" })?.id).toBe(
      "a",
    );
    forgetResolutions();
    expect(resolveAnchor({ level: "selection", selector: "#a", text: "ipsum dolor" })?.id).toBe(
      "b",
    );
  });

  test("tagOfSelector reads the last segment's tag", () => {
    expect(tagOfSelector("main > p.intro:nth-of-type(2)")).toBe("p");
    expect(tagOfSelector("#go")).toBeNull();
    expect(tagOfSelector("section li")).toBe("li");
  });
});

describe("generated names", () => {
  test("hashed and atomic classes are generated", () => {
    for (const c of [
      "x1tgivj0",
      "css-1a2b3c",
      "sc-AbCdE",
      "Button_root__a1b2c",
      "jsx-2349872",
      "kHJgfD",
      "md:flex",
      "a1b2c3d4",
    ]) {
      expect(isGeneratedClass(c)).toBe(true);
    }
  });
  test("authored classes are kept", () => {
    for (const c of ["btn-primary", "card", "col-md-6", "mt-10", "hero-title", "h1", "navItem"]) {
      expect(isGeneratedClass(c)).toBe(false);
    }
  });
  test("framework ids are generated", () => {
    expect(isGeneratedId(":r1:")).toBe(true);
    expect(isGeneratedId("ember1234")).toBe(true);
    expect(isGeneratedId("checkout")).toBe(false);
  });
  test("selectors skip generated classes for stable attributes and position", () => {
    installDom(
      `<main><button class="x1tgivj0 css-9x8y7z">a</button><button class="x1tgivj0 primary">b</button><button data-testid="buy" class="x9q8w7e6">c</button></main>`,
    );
    const [first, second, third] = [...document.querySelectorAll("button")] as Element[];
    expect(segmentFor(first as Element)).toBe("button:nth-of-type(1)");
    expect(segmentFor(second as Element)).toBe("button.primary:nth-of-type(2)");
    expect(segmentFor(third as Element)).toBe('button[data-testid="buy"]');
    expect(cssPath(third as Element)).toBe('button[data-testid="buy"]');
    const generatedId = document.createElement("p");
    generatedId.id = ":r3:";
    document.body.appendChild(generatedId);
    expect(cssPath(generatedId)).not.toContain(":r3:");
  });
});

describe("anchors that outlive their id, and leads that are shared", () => {
  const LEAD = "Order 1042 shipped from the north warehouse on the second of May, ";

  test("a new anchor's id selector carries the tag, so a changed id still finds the block", () => {
    installDom(`<p id="intro">Welcome to the spring catalogue</p>`);
    const anchor = anchorForElement(document.getElementById("intro") as Element);
    if (anchor.level !== "element") throw new Error("element anchor expected");
    expect(anchor.selector).toBe("p#intro");
    installDom(`<p id="intro-v2">Welcome to the spring catalogue</p>`);
    expect(resolveAnchor(anchor)?.id).toBe("intro-v2");
  });

  test("a legacy id-only anchor whose id changed finds a unique strong match", () => {
    installDom(`<section><p id="renamed">Welcome to the spring catalogue</p></section>`);
    const legacy: Anchor = {
      level: "element",
      selector: "#intro",
      snippet: "Welcome to the spring catalogue",
    };
    expect(resolveAnchor(legacy)?.id).toBe("renamed");
  });

  test("a legacy id-only anchor with two strong matches stays lost", () => {
    installDom(`<p>Welcome to the spring catalogue</p><li>Welcome to the spring catalogue</li>`);
    const legacy: Anchor = {
      level: "element",
      selector: "#intro",
      snippet: "Welcome to the spring catalogue",
    };
    expect(resolveAnchor(legacy)).toBeNull();
  });

  test("a legacy id-only anchor never takes a weak (overlap-only) match", () => {
    installDom(`<p>The spring catalogue welcomes you</p>`);
    const legacy: Anchor = {
      level: "element",
      selector: "#intro",
      snippet: "Welcome to the spring catalogue",
    };
    expect(resolveAnchor(legacy)).toBeNull();
  });

  test("several blocks share the 60-character lead: the selector's block must pass the overlap rule", () => {
    installDom(
      `<ul><li>${LEAD}carrier pigeon, signed by Ada</li><li>${LEAD}parcel post, signed by Grace, left at the side door</li></ul>`,
    );
    // The anchor was on Grace's item; the list reordered and nth-of-type(2) is now Ada's.
    installDom(
      `<ul><li>${LEAD}parcel post, signed by Grace, left at the side door</li><li>${LEAD}carrier pigeon, signed by Ada</li></ul>`,
    );
    const a: Anchor = {
      level: "element",
      selector: "ul > li:nth-of-type(2)",
      snippet: `${LEAD}parcel post, signed by Grace, left at the side door`,
    };
    expect(resolveAnchor(a)?.textContent).toContain("Grace");
  });

  test("a lead nobody else shares still resolves on the selector", () => {
    installDom(`<ul><li>${LEAD}parcel post, signed by Grace</li><li>Something else</li></ul>`);
    const a: Anchor = {
      level: "element",
      selector: "ul > li:nth-of-type(1)",
      snippet: `${LEAD}parcel post, signed by Grace, and a much longer tail that changed`,
    };
    expect(resolveAnchor(a)?.textContent).toContain("Grace");
  });

  test("text is read only as far as the snippet needs, not the whole subtree", () => {
    installDom(`<div id="big"><p>start</p></div>`);
    const big = document.getElementById("big") as Element;
    for (let i = 0; i < 2000; i += 1) {
      const p = document.createElement("p");
      p.textContent = "x".repeat(100);
      big.append(p);
    }
    expect(boundedText(big, 500).length).toBe(500);
  });

  test("a result is reused until the document changes", () => {
    installDom(`<p id="x">Hello there</p>`);
    const a: Anchor = { level: "element", selector: "p#x", snippet: "Hello there" };
    const first = resolveAnchor(a);
    expect(first?.id).toBe("x");
    expect(resolveAnchor(a)).toBe(first);
    (document.getElementById("x") as Element).textContent = "Something unrelated";
    expect(resolveAnchor(a)).toBeNull();
  });
});

test("a snippet is read from rendered text only (R2-C5)", () => {
  installDom(
    `<section id="s"><p>Visible words</p><p hidden>private note</p><span style="display:none">token 123</span></section>`,
  );
  const a = anchorForElement(document.getElementById("s") as Element);
  if (a.level !== "element") throw new Error("element anchor expected");
  expect(a.snippet).toBe("Visible words");
});

test("two same-tag blocks the anchor rule cannot tell apart: the anchor is lost, never bound to one (R2-C14)", () => {
  const same = "Order 1042 shipped from the north warehouse on the second of May, signed by Ada";
  installDom(`<ul><li>${same}</li><li>${same}</li></ul>`);
  const a: Anchor = { level: "element", selector: "ul > li:nth-of-type(2)", snippet: same };
  expect(resolveAnchor(a)).toBeNull();
});
