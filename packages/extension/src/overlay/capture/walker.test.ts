import { afterEach, beforeEach, expect, test } from "bun:test";
import { Window } from "happy-dom";
import { type RectLike, slotTag, type WalkEnv, type WalkOptions, walk } from "./walker";

let win: Window | null = null;
let styles = new WeakMap<
  Element,
  { base?: Record<string, string>; before?: Record<string, string>; after?: Record<string, string> }
>();
let rects = new WeakMap<Element, RectLike>();

function install(html: string): void {
  win = new Window({ url: "http://127.0.0.1:8124/page.html" });
  const g = globalThis as unknown as Record<string, unknown>;
  g.window = win;
  g.document = win.document;
  g.DOMParser = win.DOMParser;
  g.Element = win.Element;
  g.Node = win.Node;
  g.customElements = win.customElements;
  styles = new WeakMap();
  rects = new WeakMap();
  win.document.body.innerHTML = html;
}

beforeEach(() => install("<div></div>"));
afterEach(() => {
  win?.happyDOM.cancelAsync();
  win?.close();
  win = null;
});

function pick(sel: string): Element {
  return document.querySelector(sel) as Element;
}
function setStyle(sel: string | Element, base: Record<string, string>): Element {
  const el = typeof sel === "string" ? pick(sel) : sel;
  const prev = styles.get(el) ?? {};
  styles.set(el, { ...prev, base });
  return el;
}
function setPseudo(sel: string, which: "before" | "after", props: Record<string, string>): void {
  const el = pick(sel);
  const prev = styles.get(el) ?? {};
  styles.set(el, { ...prev, [which]: props });
}
function setRect(sel: string, r: Partial<RectLike>): void {
  const el = pick(sel);
  rects.set(el, { x: 0, y: 0, width: 100, height: 20, top: 0, left: 0, ...r });
}

function decl(props: Record<string, string>): CSSStyleDeclaration {
  const merged: Record<string, string> = { display: "block", ...props };
  const names = Object.keys(merged);
  const obj: Record<string | symbol | number, unknown> = {
    getPropertyValue: (p: string) => merged[p] ?? "",
    length: names.length,
    [Symbol.iterator]: function* () {
      for (const n of names) yield n;
    },
  };
  names.forEach((n, i) => {
    obj[i] = n;
  });
  return obj as unknown as CSSStyleDeclaration;
}

function env(): Partial<WalkEnv> {
  return {
    styleOf: (el, pseudo) => {
      const s = styles.get(el);
      if (pseudo === "::before") return decl(s?.before ?? {});
      if (pseudo === "::after") return decl(s?.after ?? {});
      return decl(s?.base ?? {});
    },
    rectOf: (el) => rects.get(el) ?? { x: 0, y: 0, width: 100, height: 20, top: 0, left: 0 },
    viewport: () => ({
      innerWidth: 1200,
      innerHeight: 800,
      dpr: 2,
      scrollX: 0,
      scrollY: 0,
      layoutWidth: 1200,
    }),
    baseUrl: "http://127.0.0.1:8124/page.html",
  };
}

function run(block: string, extra: Partial<WalkOptions> = {}): ReturnType<typeof walk> {
  return walk({ block: pick(block), env: env(), ...extra });
}

/** data-oc of the first element matching `sel` inside a serialized document. */
function ocOf(html: string, sel: string): string {
  const doc = new DOMParser().parseFromString(html, "text/html");
  return doc.querySelector(sel)?.getAttribute("data-oc") ?? "";
}
/** The declaration body of a `[data-oc="N"]<pseudo>{…}` rule (one rule per line). */
function ruleFor(css: string, oc: string, pseudo = ""): string {
  const prefix = `[data-oc="${oc}"]${pseudo}{`;
  for (const line of css.split("\n")) {
    if (line.startsWith(prefix)) return line.slice(prefix.length, line.lastIndexOf("}"));
  }
  return "";
}

/* ── parent-delta suppression (§1.2) ── */

test("inheritable prop equal to parent is omitted; non-inheritable is always kept", () => {
  install(`<div id="p"><span id="c">t</span></div>`);
  setStyle("#p", {
    color: "rgb(255,0,0)",
    "font-size": "16px",
    width: "200px",
    "background-color": "rgb(0,0,255)",
  });
  setStyle("#c", { color: "rgb(255,0,0)", "font-size": "20px", width: "200px" });
  const r = run("#p");
  const oc = ocOf(r.documentHtml, "#c");
  const rule = ruleFor(r.ocBaseCss, oc);
  expect(rule).not.toContain("color:"); // inherited & equal → dropped
  expect(rule).toContain("font-size:20px"); // inherited & differs → kept
  expect(rule).toContain("width:200px"); // non-inherited → kept even when equal
});

test("custom props: :root emitted once; a scoped child override re-emitted, equal one dropped", () => {
  install(`<div id="p"><span id="c">t</span></div>`);
  setStyle(document.documentElement, { "--brand": "teal" });
  setStyle("#p", { "--x": "1px" });
  setStyle("#c", { "--x": "1px", "--y": "9px" });
  const r = run("#p");
  expect(r.ocBaseCss).toMatch(/:root\{[^}]*--brand:teal/);
  const oc = ocOf(r.documentHtml, "#c");
  const rule = ruleFor(r.ocBaseCss, oc);
  expect(rule).toContain("--y:9px"); // scoped override (parent unset) → emitted
  expect(rule).not.toContain("--x:"); // equal to serialized parent → dropped
});

/* ── serializer / naming (§1.1, D10) ── */

test("a custom element serializes under its real localName, not a <div>", () => {
  install(`<div id="host"><my-widget class="w">hi</my-widget></div>`);
  const r = run("#host");
  expect(r.documentHtml).toContain("<my-widget");
  expect(r.documentHtml).toContain('class="w"');
  // redundant real-tag metadata is present on the custom element
  expect(r.documentHtml).toMatch(/<my-widget[^>]*data-oc-tag="my-widget"/);
});

test("a closed-shadow host and a replaced <canvas> serialize as the reserved box", () => {
  install(`<div id="host"><x-closed></x-closed><canvas id="cv"></canvas></div>`);
  const r = run("#host", { closedShadow: (el) => el.localName === "x-closed" });
  expect(r.documentHtml).not.toContain("<x-closed");
  expect(r.documentHtml).not.toContain("<canvas");
  expect(r.documentHtml).toMatch(/data-oc-tag="x-closed"/);
  expect(r.documentHtml).toMatch(/data-oc-tag="canvas"/);
  const cls = r.residue.map((e) => e.class);
  expect(cls).toContain("closed-shadow-root");
  expect(cls).toContain("canvas-video-content");
});

test("<svg> keeps geometry/paint attrs and drops handlers + non-allowlisted attrs", () => {
  install(
    `<svg id="s" viewBox="0 0 24 24" role="img" data-k="v">` +
      `<path d="M12 2l3 6" fill="#7c3aed" stroke-width="2" onclick="bad()"></path></svg>`,
  );
  const r = run("#s");
  const lower = r.documentHtml.toLowerCase();
  expect(lower).toContain('viewbox="0 0 24 24"');
  expect(lower).toContain('d="m12 2l3 6"');
  expect(lower).toContain('fill="#7c3aed"');
  expect(lower).not.toContain("data-k"); // no page data-* travels (R2-C5)
  expect(lower).not.toContain("onclick");
  expect(lower).not.toContain('role="img"'); // non-allowlisted → dropped
});

test("ordered-list ordinal state survives: <ol start/reversed>, <li value> (D12)", () => {
  install(`<ol id="list" start="5" reversed type="a"><li>a</li><li value="9">b</li></ol>`);
  const r = run("#list");
  const lower = r.documentHtml.toLowerCase();
  expect(lower).toContain('start="5"'); // native markers render 5,4,… → faithful
  expect(lower).toContain("reversed");
  expect(lower).toContain('value="9"');
  expect(lower).not.toContain('type="a"'); // marker style comes from computed list-style-type
});

test("SVG <use> same-document #ref kept; cross-document href dropped + metered stripped-url", () => {
  install(
    `<svg id="s" viewBox="0 0 24 24">` +
      `<use id="local" href="#icon"></use>` +
      `<use id="remote" href="https://cdn.example.com/sprite.svg#x"></use></svg>`,
  );
  const r = run("#s");
  const lower = r.documentHtml.toLowerCase();
  expect(lower).toContain('href="#icon"'); // same-document fragment resolves in-frame
  expect(lower).not.toContain("cdn.example.com"); // live external ref dropped
  expect(r.residue.map((e) => e.class)).toContain("stripped-url");
});

test("class/id survive; data-* (data-theme too), data-onlay-*, on*, style stripped; script+link removed", () => {
  install(
    `<div id="root" class="hero" data-theme="dark" data-onlay-foo="x" ` +
      `style="color:red" onclick="bad()"><script>evil()</script><link rel="x">keep</div>`,
  );
  const r = run("#root");
  expect(r.documentHtml).toContain('class="hero"');
  expect(r.documentHtml).not.toContain("data-theme");
  expect(r.documentHtml).toContain("keep");
  expect(r.documentHtml).not.toContain("data-onlay-foo");
  expect(r.documentHtml).not.toContain("onclick");
  expect(r.documentHtml).not.toContain("<script");
  expect(r.documentHtml).not.toContain("<link");
  // baseline is a [data-oc] sheet, never inline style attributes (D1)
  expect(r.documentHtml).not.toContain('style="color:red"');
});

test("page-supplied data-oc* attrs never overwrite minted block identity", () => {
  // A page carrying `data-oc-block`/`data-oc` (e.g. an embedded prior Onlay
  // reconstruction) must not plant a decoy block root or re-key the sheet.
  install(
    `<section id="blk"><span id="imp" data-oc-block data-oc="99" data-oc-tag="fake">t</span></section>`,
  );
  const r = run("#blk");
  const doc = new DOMParser().parseFromString(r.documentHtml, "text/html");
  const blocks = doc.querySelectorAll("[data-oc-block]");
  expect(blocks.length).toBe(1); // exactly one, the real block
  expect(blocks[0]?.getAttribute("id")).toBe("blk");
  const imp = doc.querySelector("#imp");
  expect(imp?.hasAttribute("data-oc-block")).toBe(false);
  expect(imp?.getAttribute("data-oc")).not.toBe("99"); // minted, not page-supplied
  expect(imp?.getAttribute("data-oc-tag")).toBe(null); // fake tag dropped
});

test("-webkit-text-fill-color equal to color is suppressed; divergent is kept", () => {
  install(`<div id="eq">a</div>`);
  setStyle("#eq", { color: "rgb(0, 0, 0)", "-webkit-text-fill-color": "rgb(0, 0, 0)" });
  const eq = run("#eq");
  const eqRule = ruleFor(eq.ocBaseCss, ocOf(eq.documentHtml, "[data-oc-block]"));
  expect(eqRule).toContain("color:rgb(0, 0, 0)");
  expect(eqRule).not.toContain("text-fill-color"); // would shadow later color variants

  install(`<div id="div">b</div>`);
  setStyle("#div", { color: "rgb(0, 0, 0)", "-webkit-text-fill-color": "rgb(255, 0, 0)" });
  const dv = run("#div");
  const dvRule = ruleFor(dv.ocBaseCss, ocOf(dv.documentHtml, "[data-oc-block]"));
  expect(dvRule).toContain("-webkit-text-fill-color:rgb(255, 0, 0)"); // genuine stroke effect kept
});

/* ── pseudo-elements (§1.4) ── */

test("::before with content emits a resolved ::before rule; content:none emits nothing", () => {
  install(`<div id="a">x</div><div id="b">y</div>`);
  setPseudo("#a", "before", { content: '"★"', color: "rgb(0,128,0)" });
  const r = run("#a");
  const oc = ocOf(r.documentHtml, "[data-oc-block]");
  const rule = ruleFor(r.ocBaseCss, oc, "::before");
  expect(rule).toContain('content:"★"');
  expect(rule).toContain("color:rgb(0,128,0)");
  // a sibling without generated content emits no pseudo rule
  install(`<div id="b">y</div>`);
  const r2 = run("#b");
  expect(r2.ocBaseCss).not.toContain("::before");
});

test("::after content:url(...) resolves to an {{asset}} placeholder", () => {
  install(`<div id="a">x</div>`);
  setPseudo("#a", "after", { content: 'url("http://cdn.example.com/i.png")' });
  const r = run("#a");
  const oc = ocOf(r.documentHtml, "[data-oc-block]");
  const rule = ruleFor(r.ocBaseCss, oc, "::after");
  expect(rule).toMatch(/content:url\(\{\{asset:[0-9a-f]{8}\}\}\)/);
  expect(r.assetRefs.some((a) => a.url === "http://cdn.example.com/i.png")).toBe(true);
});

/* ── shadow / slot flattening (§2) ── */

test("open shadow root children flatten into the host, which keeps its real name", () => {
  install(`<div id="host"><x-card id="card"></x-card></div>`);
  const card = pick("#card");
  const sr = (card as unknown as { attachShadow(i: { mode: string }): ShadowRoot }).attachShadow({
    mode: "open",
  });
  const inner = document.createElement("div");
  inner.className = "inner";
  inner.textContent = "shadow";
  sr.append(inner);
  const r = run("#host");
  expect(r.documentHtml).toContain("<x-card");
  expect(r.documentHtml).toContain('class="inner"');
  expect(r.documentHtml).toContain("shadow");
});

test("a closed shadow root reserves a box and meters closed-shadow-root", () => {
  install(`<div id="host"><my-el id="m"></my-el></div>`);
  const r = run("#host", { closedShadow: (el) => el.id === "m" });
  expect(r.documentHtml).not.toContain("<my-el");
  expect(r.residue.map((e) => e.class)).toContain("closed-shadow-root");
});

/* ── visibility pruning (§2) ── */

test("display:none subtree skipped; opacity:0 kept; zero-area empty node pruned", () => {
  install(
    `<div id="p"><span id="gone">g</span><span id="ghost">o</span><span id="empty"></span></div>`,
  );
  setStyle("#gone", { display: "none" });
  setStyle("#ghost", { opacity: "0" });
  setRect("#empty", { width: 0, height: 0 });
  const r = run("#p");
  expect(r.documentHtml).not.toContain(">g<"); // display:none pruned
  expect(r.documentHtml).toContain(">o<"); // opacity:0 kept
  const doc = new DOMParser().parseFromString(r.documentHtml, "text/html");
  expect(doc.querySelectorAll("[data-oc]").length).toBe(4); // html, body, #p, #ghost
});

test("a visibility:hidden leaf is pruned, but a hidden ancestor of a visible node is kept", () => {
  install(`<div id="p"><span id="hleaf">h</span><div id="hwrap"><b id="vis">v</b></div></div>`);
  setStyle("#hleaf", { visibility: "hidden" });
  setStyle("#hwrap", { visibility: "hidden" });
  setStyle("#vis", { visibility: "visible" });
  const r = run("#p");
  expect(r.documentHtml).not.toContain(">h<"); // hidden leaf pruned
  expect(r.documentHtml).toContain(">v<"); // hidden wrapper kept for its visible child
});

/* ── habitat / spine bounds (§1.5) ── */

test("a capture shows the chosen block alone: siblings keep only an empty slot (R3-C3)", () => {
  install(
    `<div id="wrap"><p id="s2" class="row" data-x="1">secret s2</p><p id="s1">secret s1</p><p id="b">B</p>` +
      `<p id="n1">secret n1</p><p id="n2">secret n2</p><p id="far">far</p></div>`,
  );
  setRect("#b", { top: 100, left: 0, width: 100, height: 20 });
  setRect("#s1", { top: 78, left: 0, width: 100, height: 20 });
  setRect("#s2", { top: 64, left: 0, width: 100, height: 20 });
  setRect("#n1", { top: 122, left: 0, width: 100, height: 20 });
  setRect("#n2", { top: 138, left: 0, width: 100, height: 20 });
  setRect("#far", { top: 9000, left: 0, width: 100, height: 20 }); // way off — non-intersecting
  const r = run("#b");
  expect(r.documentHtml).toContain(">B<");
  // No sibling text, id or class travels…
  expect(r.documentHtml).not.toContain("secret");
  expect(r.documentHtml).not.toContain("far");
  expect(r.documentHtml).not.toContain('class="row"');
  // …only same-size empty slots, so the block lands where it did.
  expect(r.ocBaseCss).toContain("width:100px;height:20px");
  // The raster is the block's own box.
  expect(r.meta.habitatRect).toEqual(r.meta.blockRect);
});

test("sibling slots are valid for their parent: cells in a row, items in a list (3b-C6)", () => {
  install(
    `<table><tbody><tr id="row"><td id="c1" colspan="2">secret c1</td><td id="b">B</td><th id="c3">secret c3</th></tr></tbody></table>`,
  );
  for (const [sel, left] of [
    ["#c1", 0],
    ["#b", 100],
    ["#c3", 200],
  ] as const)
    setRect(sel, { top: 10, left, width: 100, height: 20 });
  const r = run("#b");
  const row = r.documentHtml.slice(r.documentHtml.indexOf("<tr"), r.documentHtml.indexOf("</tr>"));
  expect(row).not.toContain("<div");
  expect(row).toMatch(/<td data-oc="\d+" colspan="2"><\/td>/);
  expect(row).toMatch(/<th data-oc="\d+"><\/th>/);
  expect(r.documentHtml).not.toContain("secret");

  install(`<ul><li id="i1">secret one</li><li id="b">B</li></ul>`);
  setRect("#i1", { top: 0, left: 0, width: 100, height: 20 });
  setRect("#b", { top: 20, left: 0, width: 100, height: 20 });
  const l = run("#b");
  expect(l.documentHtml).toMatch(/<ul[^>]*><li data-oc="\d+"><\/li><li/);
  expect(l.documentHtml).not.toContain("secret");
});

test("slotTag picks an element the parent accepts", () => {
  const doc = document;
  const make = (parent: string, child: string): Element => {
    const p = doc.createElement(parent);
    const c = doc.createElement(child);
    p.appendChild(c);
    return c;
  };
  expect(slotTag(make("tr", "td"))).toBe("td");
  expect(slotTag(make("tbody", "tr"))).toBe("tr");
  expect(slotTag(make("table", "caption"))).toBe("caption");
  expect(slotTag(make("ol", "li"))).toBe("li");
  expect(slotTag(make("dl", "dt"))).toBe("dt");
  expect(slotTag(make("select", "option"))).toBe("option");
  expect(slotTag(make("p", "img"))).toBe("span");
  expect(slotTag(make("section", "article"))).toBe("div");
  // A shape's sibling inside an SVG stays in the SVG namespace; the svg itself is an HTML slot.
  const SVG = "http://www.w3.org/2000/svg";
  const svg = doc.createElementNS(SVG, "svg");
  const circle = doc.createElementNS(SVG, "circle");
  svg.appendChild(circle);
  doc.createElement("div").appendChild(svg);
  expect(slotTag(circle)).toBe("g");
  expect(slotTag(svg)).toBe("div");
});

test("the node ceiling truncates and meters oversize-truncation", () => {
  install(`<div id="p"><span>a</span><span>b</span><span>c</span><span>d</span></div>`);
  const r = run("#p", { limits: { MAX_CAPTURE_NODES: 4 } });
  expect(r.residue.map((e) => e.class)).toContain("oversize-truncation");
});

test("a spine deeper than MAX_SPINE_ANCESTORS collapses and meters oversize-truncation", () => {
  let html = "";
  for (let i = 0; i < 16; i += 1) html += `<div id="a${i}">`;
  html += `<p id="deep">x</p>`;
  for (let i = 0; i < 16; i += 1) html += "</div>";
  install(html);
  const r = run("#deep");
  expect(r.residue.map((e) => e.class)).toContain("oversize-truncation");
});

/* ── asset rewrite (§1.3) ── */

test("<img> resolves currentSrc to {{asset}}, drops srcset, keeps width/height", () => {
  install(
    `<div id="w"><img id="im" src="/a.png" srcset="/a-2x.png 2x" sizes="50vw" width="100" height="50"></div>`,
  );
  const r = run("#w");
  expect(r.documentHtml).toMatch(/src="\{\{asset:[0-9a-f]{8}\}\}"/);
  expect(r.documentHtml).not.toContain("srcset");
  expect(r.documentHtml).not.toContain("sizes");
  expect(r.documentHtml).toContain('width="100"');
  expect(r.assetRefs.some((a) => a.url === "http://127.0.0.1:8124/a.png" && a.kind === "img")).toBe(
    true,
  );
});

test("an ancestor gives style context but no image: its url()s and URL-holding custom properties go (3b-C7)", () => {
  install(
    `<section id="wrap"><div id="b"><img id="pic" src="http://cdn.example.com/in.png"></div></section>`,
  );
  setStyle("#wrap", {
    color: "rgb(10, 20, 30)",
    "background-image": 'url("http://cdn.example.com/ancestor.png"), linear-gradient(red, blue)',
    "--hero": 'url("http://cdn.example.com/var.png")',
    "--gap": "12px",
  });
  const r = run("#b");
  // The block's own image is kept and packaged…
  expect(r.assetRefs.map((a) => a.url)).toEqual(["http://cdn.example.com/in.png"]);
  // …the ancestor's is not, though its gradient and colour still frame the block.
  expect(r.ocBaseCss).not.toContain("ancestor.png");
  expect(r.ocBaseCss).toContain("linear-gradient(red, blue)");
  expect(r.ocBaseCss).not.toContain("var.png");
});

test("an unused root custom property holding a data image in a quoted image-set() never travels (C-3)", () => {
  install(`<div id="b">x</div>`);
  const DATA = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUg==";
  setStyle(document.documentElement, {
    "--secret": `image-set("${DATA}" 1x)`,
    "--webkit": `-webkit-image-set('${DATA}' 1x)`,
    "--fade":
      'cross-fade(url("http://cdn.example.com/x.png"), image("http://cdn.example.com/y.png"))',
    "--src": 'src("http://cdn.example.com/z.png")',
    "--gap": "12px",
  });
  const r = run("#b");
  expect(r.ocBaseCss).not.toContain("data:");
  expect(r.ocBaseCss).not.toContain("cdn.example.com");
  expect(r.ocBaseCss).toContain("--gap:12px");
  expect(r.assetRefs).toEqual([]);
});

test("an ancestor's image-set(), cross-fade(), image() and src() point at none (C-3)", () => {
  install(`<section id="wrap"><div id="b">x</div></section>`);
  setStyle("#wrap", {
    "background-image": 'image-set("http://cdn.example.com/a.png" 1x), linear-gradient(red, blue)',
    filter: 'cross-fade(url("http://cdn.example.com/b.png"), image("c.png"))',
    cursor: 'src("http://cdn.example.com/d.cur"), auto',
    "--hero": 'image-set("http://cdn.example.com/var.png" 1x)',
  });
  const r = run("#b");
  expect(r.ocBaseCss).not.toContain("cdn.example.com");
  expect(r.ocBaseCss).not.toContain("c.png");
  expect(r.ocBaseCss).toContain("linear-gradient(red, blue)");
  expect(r.assetRefs).toEqual([]);
});

test("a block node's image-set() strings become asset placeholders; its custom properties carry no image (C-3)", () => {
  install(`<div id="b">x</div>`);
  setStyle("#b", {
    "background-image": 'image-set("http://cdn.example.com/x.png" 1x)',
    "--unused": 'image-set("http://cdn.example.com/unused.png" 1x)',
    "clip-path": 'url("#clip")',
  });
  const r = run("#b");
  const oc = ocOf(r.documentHtml, "[data-oc-block]");
  expect(ruleFor(r.ocBaseCss, oc)).toMatch(
    /background-image:image-set\(url\(\{\{asset:[0-9a-f]{8}\}\}\) 1x\)/,
  );
  // Bytes only for what a node uses: never the custom property's own image.
  expect(r.assetRefs.map((a) => a.url)).toEqual(["http://cdn.example.com/x.png"]);
  expect(r.ocBaseCss).not.toContain("unused.png");
  // A same-document paint server is no resource: it stays as it is.
  expect(ruleFor(r.ocBaseCss, oc)).toContain('clip-path:url("#clip")');
});

test("a quoted image URL holding ) or a quote is one reference, rewritten whole (2-C2)", () => {
  install(`<div id="b">x</div>`);
  setStyle("#b", {
    "background-image":
      'image-set("/images/chart(1).png" 1x), url("http://cdn.example.com/it\'s (2).png")',
    "list-style-image": 'url("data:image/svg+xml,<svg>)</svg>")',
  });
  const r = run("#b");
  const rule = ruleFor(r.ocBaseCss, ocOf(r.documentHtml, "[data-oc-block]"));
  expect(rule).toMatch(
    /background-image:image-set\(url\(\{\{asset:[0-9a-f]{8}\}\}\) 1x\), url\(\{\{asset:[0-9a-f]{8}\}\}\)/,
  );
  expect(r.assetRefs.map((a) => a.url)).toEqual([
    "http://127.0.0.1:8124/images/chart(1).png",
    "http://cdn.example.com/it's%20(2).png",
  ]);
  // A data image the block uses travels as one quoted token the renderer reads whole.
  expect(rule).toContain('list-style-image:url("data:image/svg+xml,<svg>)</svg>")');
});

test("an empty URL names nothing: never the page's own URL, never an asset (3-C3)", () => {
  install(`<div id="b">x</div>`);
  setStyle("#b", {
    "background-image": 'url(""), image-set("" 1x), url()',
    "list-style-image": "url('')",
  });
  const r = run("#b");
  expect(r.assetRefs).toEqual([]);
  expect(r.ocBaseCss).not.toContain("page.html");
  expect(r.ocBaseCss).not.toContain("{{asset:");
});

test("background-image url() → url({{asset}}); a gradient passes through untouched", () => {
  install(`<div id="bg">x</div><div id="grad">y</div>`);
  setStyle("#bg", { "background-image": 'url("http://cdn.example.com/x.png")' });
  const rb = run("#bg");
  const ocb = ocOf(rb.documentHtml, "[data-oc-block]");
  expect(ruleFor(rb.ocBaseCss, ocb)).toMatch(/background-image:url\(\{\{asset:[0-9a-f]{8}\}\}\)/);
  expect(rb.assetRefs.some((a) => a.url === "http://cdn.example.com/x.png")).toBe(true);

  install(`<div id="grad">y</div>`);
  setStyle("#grad", { "background-image": "linear-gradient(90deg, red, blue)" });
  const rg = run("#grad");
  const ocg = ocOf(rg.documentHtml, "[data-oc-block]");
  const rule = ruleFor(rg.ocBaseCss, ocg);
  expect(rule).toContain("linear-gradient(90deg, red, blue)");
  expect(rule).not.toContain("{{asset:");
});

test("a data: background over the byte cap is stripped and metered oversize-truncation", () => {
  install(`<div id="big">x</div>`);
  const huge = `url("data:image/png;base64,${"A".repeat(5_300_000)}")`;
  setStyle("#big", { "background-image": huge });
  const r = run("#big");
  expect(r.residue.map((e) => e.class)).toContain("oversize-truncation");
  const oc = ocOf(r.documentHtml, "[data-oc-block]");
  expect(ruleFor(r.ocBaseCss, oc)).not.toContain("{{asset:");
});

/* ── document builder / D1 (§1.1) ── */

test("the document carries the meta CSP, an oc-base sheet, and empty oc-fonts", () => {
  install(`<div id="a">hi</div>`);
  const r = run("#a");
  expect(r.documentHtml).toContain("<!doctype html>");
  expect(r.documentHtml).toContain('http-equiv="Content-Security-Policy"');
  expect(r.documentHtml).toContain("default-src 'none'");
  expect(r.documentHtml).toContain('id="oc-fonts"');
  expect(r.documentHtml).toContain('id="oc-base"');
  expect(r.documentHtml).toMatch(/data-oc-root/);
  expect(r.documentHtml).toMatch(/data-oc-block/);
});

test("meta carries the viewport, block rect (document coords), and dpr", () => {
  install(`<div id="a">hi</div>`);
  setRect("#a", { top: 40, left: 10, width: 300, height: 120 });
  const r = run("#a");
  expect(r.meta.viewport.dpr).toBe(2);
  expect(r.meta.viewport.layoutWidth).toBe(1200);
  expect(r.meta.blockRect).toEqual({ x: 10, y: 40, width: 300, height: 120 });
});
