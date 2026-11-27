import { afterEach, beforeEach, expect, test } from "bun:test";
import { Window } from "happy-dom";
import { reduceForTest, sanitizeElement, sanitizeMarkupForPreview, sanitizePage } from "./sanitize";

let win: Window | null = null;

function installDom(html: string): void {
  win = new Window({ url: "http://127.0.0.1:8124/page.html" });
  const g = globalThis as unknown as {
    window: unknown;
    document: Document;
    DOMParser: typeof DOMParser;
    Element: typeof Element;
    Node: typeof Node;
  };
  g.window = win;
  g.document = win.document as unknown as Document;
  g.DOMParser = win.DOMParser as unknown as typeof DOMParser;
  g.Element = win.Element as unknown as typeof Element;
  g.Node = win.Node as unknown as typeof Node;
  win.document.body.innerHTML = html;
}

function pick(id: string): Element {
  return document.getElementById(id) as Element;
}

beforeEach(() => installDom(""));
afterEach(() => {
  win?.happyDOM.cancelAsync();
  win?.close();
  win = null;
});

test("strips script/style/iframe/object/embed/link elements", () => {
  installDom(
    `<div id="x">keep<script>evil()</script><style>.a{}</style>` +
      `<iframe src="/f"></iframe><object></object><embed><link rel=x>done</div>`,
  );
  const { html } = sanitizeElement(pick("x"));
  expect(html).toContain("keep");
  expect(html).toContain("done");
  expect(html).not.toContain("<script");
  expect(html).not.toContain("<style");
  expect(html).not.toContain("<iframe");
  expect(html).not.toContain("<object");
  expect(html).not.toContain("<embed");
  expect(html).not.toContain("<link");
});

test("strips on* handlers and inline style, keeps allowlisted attrs", () => {
  installDom(
    `<a id="x" href="/go" title="t" onclick="bad()" style="color:red" class="c" data-x="1">go</a>`,
  );
  const { html } = sanitizeElement(pick("x"));
  // URLs leave as origin + path (resolved against the page).
  expect(html).toContain('href="http://127.0.0.1:8124/go"');
  expect(html).toContain('title="t"');
  expect(html).not.toContain("onclick");
  expect(html).not.toContain("style=");
  expect(html).not.toContain('class="c"');
  expect(html).not.toContain("data-x");
});

test("keeps data-onlay-* stamps and table-structural attrs", () => {
  installDom(`<table id="x"><tr><td colspan="2" data-onlay-source="a.tsx:1:1">c</td></tr></table>`);
  const { html } = sanitizeElement(pick("x"));
  expect(html).toContain('colspan="2"');
  expect(html).toContain("data-onlay-source");
});

test("SVG geometry survives; handlers still die (a captured logo is not a skeleton)", () => {
  installDom(
    `<svg id="x" viewBox="0 0 24 24" width="24" onclick="bad()">` +
      `<path d="M12 2l3 6" fill="#7c3aed" stroke-width="2"></path></svg>`,
  );
  const { html } = sanitizeElement(pick("x"));
  expect(html).toContain('viewBox="0 0 24 24"');
  expect(html).toContain('d="M12 2l3 6"');
  expect(html).toContain('fill="#7c3aed"');
  expect(html).toContain('stroke-width="2"');
  expect(html).not.toContain("onclick");
});

test("drops javascript: URLs on href/src (including obfuscated)", () => {
  installDom(`<a id="x" href="javascript:alert(1)">a</a>`);
  expect(sanitizeElement(pick("x")).html).not.toContain("javascript:");
  installDom(`<a id="y" href="  JavaScript:alert(1)">b</a>`);
  expect(sanitizeElement(pick("y")).html).not.toContain("avaScript:");
});

test("a block over the cap is reduced to fit, each cut marked", () => {
  const cells = Array.from({ length: 40 }, (_, i) => `<span>cell-${i}</span>`).join("");
  installDom(`<div id="x">${cells}</div>`);
  const { html, truncated, reduced } = sanitizeElement(pick("x"), 120);
  expect(truncated).toBe(false);
  expect(html.length).toBeLessThanOrEqual(120);
  expect(reduced).toEqual({ text: 0, repeats: 37, depth: 0 });
  expect(html).toContain("<span>cell-2</span><!-- onlay-cut: 37 more like the ones above -->");
});

test("caps at a tag boundary and flags truncated when even the skeleton is too large", () => {
  const cells = Array.from({ length: 40 }, (_, i) => `<span>cell-${i}</span>`).join("");
  installDom(`<div id="x">${cells}</div>`);
  const { html, truncated } = sanitizeElement(pick("x"), 30);
  expect(truncated).toBe(true);
  expect(html.length).toBeLessThanOrEqual(30);
  // Never cut mid-tag: last char is a tag close (or the string ends cleanly).
  expect(html.endsWith(">")).toBe(true);
});

test("a reduced block keeps its structure, ids and classes for selectors, and its redaction", () => {
  const long = "Lorem ipsum ".repeat(400);
  const card = (i: number) =>
    `<li class="product-card" id="p${i}" data-tracking="${"x".repeat(80)}"><a href="https://shop.example/p/${i}?ref=secret#top" class="title">Item ${i}</a><input type="hidden" name="csrf" value="tok"><p class="desc">${long}</p></li>`;
  const deep = `${'<div class="d">'.repeat(30)}deep${"</div>".repeat(30)}`;
  installDom(
    `<section id="product" class="pdp"><h1 id="name" class="pdp-title">Name</h1><ul id="grid" class="grid">${Array.from({ length: 60 }, (_, i) => card(i)).join("")}</ul>${deep}</section>`,
  );
  const limit = 6_000;
  const { html, truncated, reduced } = sanitizeElement(pick("product"), limit, {
    keepSelectors: true,
  });
  expect(truncated).toBe(false);
  expect(html.length).toBeLessThanOrEqual(limit);
  expect(reduced).toBeDefined();
  expect((reduced?.text ?? 0) + (reduced?.repeats ?? 0) + (reduced?.depth ?? 0)).toBeGreaterThan(0);
  // Structure, ids and classes stay for selectors.
  expect(html).toContain('<section id="product" class="pdp">');
  expect(html).toContain('id="name"');
  expect(html).toContain('class="product-card"');
  expect(html).toContain("onlay-cut");
  // The redaction policy still holds.
  expect(html).not.toContain("data-tracking");
  expect(html).not.toContain("secret");
  expect(html).not.toContain('type="hidden"');
  expect(html).not.toContain("tok");
});

test("under the cap is not truncated", () => {
  installDom(`<p id="x">short</p>`);
  const { html, truncated } = sanitizeElement(pick("x"), 4096);
  expect(truncated).toBe(false);
  expect(html).toBe("<p>short</p>"); // id is not allowlisted → stripped
});

/* ── sanitizeMarkupForPreview: the standalone stage's parse+sanitize path ── */

test("preview mode keeps class/id/inline style so the block reads visually", () => {
  const root = sanitizeMarkupForPreview(
    `<div id="card" class="hero" style="background:#eee;padding:12px">` +
      `<span style="color:red">Hi</span></div>`,
  );
  expect(root).not.toBeNull();
  expect(root?.getAttribute("id")).toBe("card");
  expect(root?.getAttribute("class")).toBe("hero");
  expect(root?.getAttribute("style")).toContain("background");
  expect(root?.querySelector("span")?.getAttribute("style")).toBe("color:red");
  expect(root?.textContent).toBe("Hi");
});

test("preview mode strips all active content — script/style/iframe elements, on*, javascript:", () => {
  const root = sanitizeMarkupForPreview(
    `<section class="k">keep` +
      `<script>evil()</script><style>.a{}</style><iframe src="/f"></iframe>` +
      `<button onclick="bad()" class="b">go</button>` +
      `<a href="javascript:alert(1)" style="x">link</a>done</section>`,
  );
  expect(root).not.toBeNull();
  expect(root?.querySelector("script")).toBeNull();
  expect(root?.querySelector("style")).toBeNull();
  expect(root?.querySelector("iframe")).toBeNull();
  expect(root?.querySelector("button")?.getAttribute("onclick")).toBeNull();
  expect(root?.querySelector("button")?.getAttribute("class")).toBe("b"); // class kept
  expect(root?.querySelector("a")?.getAttribute("href")).toBeNull(); // javascript: dropped
  expect(root?.textContent).toContain("keep");
  expect(root?.textContent).toContain("done");
});

test("preview mode returns null for empty or non-element markup", () => {
  expect(sanitizeMarkupForPreview("")).toBeNull();
  expect(sanitizeMarkupForPreview("just text")).toBeNull();
  expect(sanitizeMarkupForPreview("<script>evil()</script>")).toBeNull();
});

test("preview mode survives markup truncated mid-tag (DOMParser closes it)", () => {
  const root = sanitizeMarkupForPreview(`<div class="c"><p>half<span style="color:re`);
  expect(root).not.toBeNull();
  expect(root?.getAttribute("class")).toBe("c");
  expect(root?.textContent).toContain("half");
});

test("markup that leaves the browser drops hidden inputs, form values and textarea text", () => {
  installDom(
    `<form id="x"><input type="hidden" name="csrf_token" value="s3cr3t"><input name="q" value="typed"><select name="s" value="v"><option value="o1">One</option></select><button value="b">Go</button><textarea name="t">draft words</textarea></form>`,
  );
  const { html } = sanitizeElement(pick("x"));
  expect(html).not.toContain("s3cr3t");
  expect(html).not.toContain('type="hidden"');
  expect(html).not.toContain("typed");
  expect(html).not.toContain('value="b"');
  expect(html).not.toContain("draft words");
  expect(html).toContain('value="o1"'); // the page's own choices stay
});

test("credential-named attributes, autocomplete and long data-* go; onlay's own stamps stay", () => {
  const long = "x".repeat(65);
  installDom(
    `<div id="x"><span name="authToken" data-session-id="1" data-label="short" data-blob="${long}" data-onlay-provenance="github.com/acme/site@0123456789abcdef0123456789abcdef01234567;main;clean">t</span></div>`,
  );
  const { html } = sanitizeElement(pick("x"), undefined, { keepSelectors: true });
  expect(html).not.toContain("data-session-id");
  expect(html).not.toContain(long);
  expect(html).toContain("data-onlay-provenance");
  // name is allowlisted, and its VALUE is not a credential-named attribute
  expect(html).toContain('name="authToken"');
});

test("URLs keep origin and path; a dropped query or fragment reads ?…", () => {
  installDom(
    `<div id="x"><a href="https://bank.example/reset?token=abc#top">r</a><img src="/img/a.png"><a href="mailto:a@b.example?subject=hi">m</a></div>`,
  );
  const { html } = sanitizeElement(pick("x"));
  expect(html).toContain('href="https://bank.example/reset?…"');
  expect(html).not.toContain("token=abc");
  expect(html).toContain('src="http://127.0.0.1:8124/img/a.png"');
  // A non-web scheme keeps only the scheme: its "path" is the payload.
  expect(html).toContain('href="mailto:"');
  expect(html).not.toContain("a@b.example");
});

test("the variant request keeps class and id for selectors, and is redacted the same way", () => {
  installDom(`<div id="x" class="card"><input id="q" class="field" value="private"></div>`);
  const { html } = sanitizeElement(pick("x"), undefined, { keepSelectors: true });
  expect(html).toContain('class="card"');
  expect(html).toContain('id="q"');
  expect(html).not.toContain("private");
});

test("hidden contents and comments never travel; non-web URLs keep only their scheme", () => {
  installDom(
    `<div id="x"><p>Shown</p><p hidden>secret one</p><p style="display:none">secret two</p>` +
      `<p style="visibility:hidden">secret three<span style="visibility:visible">peek</span></p>` +
      `<!-- secret four --><img src="data:image/png;base64,SECRETPAYLOAD"></div>`,
  );
  const { html } = sanitizeElement(pick("x"));
  expect(html).toContain("Shown");
  expect(html).toContain("peek");
  for (const secret of ["secret one", "secret two", "secret three", "secret four", "SECRETPAYLOAD"])
    expect(html).not.toContain(secret);
  expect(html).toContain('src="data:"');
});

test("the page body keeps class and id for selectors and leaves the overlay host out", () => {
  installDom(
    `<main id="m" class="shell"><p class="lead">Hi</p></main><div id="host">overlay</div>`,
  );
  const host = document.getElementById("host");
  const { html } = sanitizePage(document.body, host);
  expect(html).toContain('class="shell"');
  expect(html).toContain('id="m"');
  expect(html).not.toContain("overlay");
});

test("a text run shortened in several passes is counted once, with one marker (audit 10)", () => {
  installDom(`<div id="x"><p>${"word ".repeat(2_000)}</p><p>${"more ".repeat(2_000)}</p></div>`);
  // Small enough that every shortening pass runs before it fits.
  const { html, reduced } = sanitizeElement(pick("x"), 150);
  expect(reduced?.text).toBe(2);
  expect(html.match(/onlay-cut: [0-9,]+ characters/g)?.length).toBe(2);
});

test("past its work budget the reducer sends the block's skeleton, and says so (audit 10)", () => {
  const items = Array.from({ length: 50 }, (_, i) => `<li class="i${i}">${"x".repeat(200)}</li>`);
  installDom(`<ul id="x" class="list">${items.join("")}</ul>`);
  const clone = pick("x").cloneNode(true) as Element;
  const r = reduceForTest(clone, 4_000, 100);
  expect(r?.cuts.skeleton).toBe(true);
  expect(r?.html.startsWith('<ul id="x" class="list"><li class="i0">')).toBe(true);
  expect(r?.html).not.toContain("xxxx");
  expect((r?.html.length ?? 0) <= 4_000).toBe(true);
});
