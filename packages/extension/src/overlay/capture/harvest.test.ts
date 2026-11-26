import { afterEach, beforeEach, expect, test } from "bun:test";
import { Window } from "happy-dom";
import {
  absoluteUrl,
  buildFontsSheet,
  expandImports,
  extractFontFaces,
  type HarvestDeps,
  harvest,
  injectFontsSheet,
  originOf,
  parseImports,
  rewriteAssetUrls,
  stripFontFaces,
} from "./harvest";
import { fnv8 } from "./hash";
import type { CaptureDraft } from "./index";
import { ResidueLog } from "./residue";

const BASE = "http://localhost/";

let win: Window | null = null;
beforeEach(() => {
  win = new Window({ url: BASE });
  const g = globalThis as unknown as Record<string, unknown>;
  g.DOMParser = win.DOMParser;
});
afterEach(() => {
  win?.close?.();
  win = null;
});

function draftOf(over: Partial<CaptureDraft> = {}): CaptureDraft {
  return {
    interactionId: "int-1",
    kind: "edit-context",
    targetKeySource: "#hero",
    documentHtml:
      '<!doctype html><html><head><style id="oc-fonts"></style></head><body></body></html>',
    authorsheet: null,
    assetRefs: [],
    parts: [],
    residue: new ResidueLog(),
    meta: {
      viewport: { innerWidth: 800, innerHeight: 600, dpr: 1, layoutWidth: 800 },
      blockRect: { x: 0, y: 0, width: 10, height: 10 },
      habitatRect: { x: 0, y: 0, width: 10, height: 10 },
      quiescence: "settled",
    },
    block: null as unknown as Element,
    scope: null as unknown as Element,
    ...over,
  };
}

// ── pure helpers ───────────────────────────────────────────────────────────

test("absoluteUrl / originOf", () => {
  expect(absoluteUrl("/a/b.css", BASE)).toBe("http://localhost/a/b.css");
  expect(absoluteUrl(":::bad", "not a url")).toBeNull();
  expect(originOf("https://cdn.example.com:8443/x.css")).toBe("https://cdn.example.com:8443");
});

test("extractFontFaces pulls src url()s and preserves descriptors", () => {
  const css =
    '@font-face{font-family:"Inter";font-weight:400;src:url("/f/inter.woff2") format("woff2");unicode-range:U+0-FF}';
  const faces = extractFontFaces(css, BASE);
  expect(faces.length).toBe(1);
  expect(faces[0]?.urls).toEqual(["http://localhost/f/inter.woff2"]);
  expect(faces[0]?.css).toContain("unicode-range");
  expect(faces[0]?.css).toContain("font-weight:400");
});

test("extractFontFaces skips data: srcs (they inline; no fetch)", () => {
  const faces = extractFontFaces(
    '@font-face{font-family:X;src:url("data:font/woff2;base64,AA")}',
    BASE,
  );
  expect(faces[0]?.urls).toEqual([]);
});

test("buildFontsSheet rewrites src to {{font:<ref>}}; drops a face whose only src is unresolved", () => {
  const faces = extractFontFaces('@font-face{font-family:Y;src:url("/f/y.woff2")}', BASE);
  const sheet = buildFontsSheet(faces, () => "abc12345");
  expect(sheet).toContain("{{font:abc12345}}");
  expect(sheet).toContain("font-family:Y");
  expect(buildFontsSheet(faces, () => null)).toBe(""); // no src survived → dropped
});

test("buildFontsSheet resolves a face's src against ITS OWN base, not a global one", () => {
  // A face declared in a CDN sheet with a RELATIVE src must resolve against the
  // CDN, not the page — the real-webfont fidelity fix (gpt56-5).
  const faces = extractFontFaces(
    '@font-face{font-family:I;src:url("../f/i.woff2")}',
    "https://cdn.example.com/css/app.css",
  );
  expect(faces[0]?.urls).toEqual(["https://cdn.example.com/f/i.woff2"]);
  const seen: string[] = [];
  buildFontsSheet(faces, (abs) => {
    seen.push(abs);
    return "ref00000";
  });
  expect(seen).toEqual(["https://cdn.example.com/f/i.woff2"]);
});

test("stripFontFaces removes @font-face but keeps the rest", () => {
  const css = "@font-face{font-family:X;src:url(/a)}\n.btn{color:red}";
  expect(stripFontFaces(css)).not.toContain("@font-face");
  expect(stripFontFaces(css)).toContain(".btn{color:red}");
});

test("rewriteAssetUrls rewrites url() to {{asset}}, passes gradients + data:, records urls", () => {
  const css =
    ".a{background:url('/img/x.png')}.b{background:linear-gradient(red,blue)}.c{background:url(data:image/png;base64,AA)}";
  const seen: string[] = [];
  const out = rewriteAssetUrls(css, BASE, (abs) => {
    seen.push(abs);
    return "deadbeef";
  });
  expect(out).toContain("url({{asset:deadbeef}})");
  expect(out).toContain("linear-gradient(red,blue)");
  expect(out).toContain("url(data:image/png;base64,AA)");
  expect(seen).toEqual(["http://localhost/img/x.png"]);
});

test("rewriteAssetUrls leaves a declined (null) url verbatim for the render scrub", () => {
  const out = rewriteAssetUrls(".a{background:url('/img/x.png')}", BASE, () => null);
  expect(out).toContain("url('/img/x.png')");
});

test("parseImports lifts @import targets (url() + bare-string forms) with media, strips statements", () => {
  const css = '@import url("base.css");@import "theme.css" screen;.a{color:red}';
  const { imports, rest } = parseImports(css);
  expect(imports).toEqual([
    { url: "base.css", media: "" },
    { url: "theme.css", media: "screen" },
  ]);
  expect(rest).not.toContain("@import");
  expect(rest).toContain(".a{color:red}");
});

test("expandImports splices imports forward-ordered, per-base, media-wrapped (A18)", async () => {
  const fetched: Record<string, string> = {
    "http://localhost/a.css": ".a{color:red}",
    "http://localhost/b.css": ".b{color:blue}",
  };
  const segs = await expandImports(
    { text: '@import "a.css";@import "b.css" screen;.body{margin:0}', base: BASE },
    0,
    async (u) => fetched[u] ?? null,
    new Set(),
  );
  // FORWARD order — a, then b, then the importing sheet's own body (fable-4).
  expect(segs.map((s) => s.text)).toEqual([".a{color:red}", ".b{color:blue}", ".body{margin:0}"]);
  expect(segs[1]?.media).toBe("screen"); // conditional import carries its media
});

test("expandImports is cycle-guarded + depth-capped", async () => {
  let calls = 0;
  const segs = await expandImports(
    { text: '@import "self.css";', base: BASE },
    0,
    async () => {
      calls += 1;
      return '@import "self.css";.x{}'; // self-referential
    },
    new Set(),
  );
  expect(calls).toBe(1); // the cycle guard stops after the first fetch
  expect(segs.some((s) => s.text.includes(".x{}"))).toBe(true);
});

test("injectFontsSheet fills the empty #oc-fonts style, no-op on empty css", () => {
  const html =
    '<!doctype html><html><head><style id="oc-fonts"></style></head><body></body></html>';
  const out = injectFontsSheet(html, "@font-face{font-family:Y}");
  expect(out).toContain("@font-face{font-family:Y}");
  expect(injectFontsSheet(html, "")).toBe(html);
});

// ── orchestrator (injected transport) ───────────────────────────────────────

test("declined cross-origin grant meters declined-grant per origin (never silent)", async () => {
  const draft = draftOf();
  const deps: HarvestDeps = {
    doc: {} as Document,
    baseUrl: BASE,
    sheets: () => [{ href: "https://cdn.example.com/app.css" } as CSSStyleSheet],
    sheetText: () => null, // cross-origin → SecurityError path
    shadowSheets: () => 0,
    swFetch: async () => ({ ok: false, reason: "declined-grant" }),
  };
  await harvest(draft, deps);
  const residue = draft.residue.toArray();
  expect(
    residue.some((e) => e.class === "declined-grant" && e.origin === "https://cdn.example.com"),
  ).toBe(true);
});

// F32 — harvest admits parts by BYTE MAGIC (the server's 415 gate, mirrored),
// so fixtures must lead with real signatures: wOF2 for fonts, PNG for rasters.
const WOFF2_BYTES = new Uint8Array([0x77, 0x4f, 0x46, 0x32, 0, 1, 0, 0]);
const PNG_BYTES = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/** Images a node inside the chosen block uses, as the walker records them (3b-C7). */
const blockRefs = (...paths: string[]): CaptureDraft["assetRefs"] =>
  paths.map((p) => {
    const url = `http://localhost${p}`;
    return { ref: fnv8(url), url, origin: "http://localhost", kind: "background" as const };
  });

test("same-origin harvest builds authorsheet + font parts + fills #oc-fonts; a stylesheet-only image brings no bytes (3b-C7)", async () => {
  const draft = draftOf();
  const deps: HarvestDeps = {
    doc: {} as Document,
    baseUrl: BASE,
    sheets: () => [{} as CSSStyleSheet],
    sheetText: () =>
      '@font-face{font-family:I;src:url("/f/i.woff2")}\n.btn{background:url("/img/b.png")}',
    shadowSheets: () => 0,
    sameOriginFetch: async (url) => ({
      bytes: url.endsWith("woff2") ? WOFF2_BYTES : PNG_BYTES,
      mime: url.endsWith("woff2") ? "font/woff2" : "image/png",
    }),
  };
  await harvest(draft, deps);
  expect(draft.parts.some((p) => p.role === "font" && p.name.startsWith("font-"))).toBe(true);
  // `.btn`'s image is the page stylesheet's, not the block's: no part, and it points at nothing.
  expect(draft.parts.some((p) => p.role === "asset")).toBe(false);
  expect(draft.authorsheet).not.toContain("{{asset:");
  expect(draft.authorsheet).toContain(".btn{background:none}");
  expect(draft.authorsheet).not.toContain("@font-face"); // font-face lives in #oc-fonts
  expect(draft.documentHtml).toContain("{{font:");
});

test("a stylesheet's image-set(), image() and src() images, data ones included, bring no bytes unless the block uses them (C-3)", async () => {
  const DATA = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUg==";
  const used = fnv8("http://localhost/img/used.png");
  const draft = draftOf({ assetRefs: blockRefs("/img/used.png") });
  const fetched: string[] = [];
  await harvest(draft, {
    doc: {} as Document,
    baseUrl: BASE,
    sheets: () => [{} as CSSStyleSheet],
    sheetText: () =>
      [
        `:root{--secret:image-set("${DATA}" 1x)}`,
        `.a{background-image:-webkit-image-set('/img/other.png' 1x)}`,
        `.b{border-image-source:image("/img/b.png")}`,
        `.c{cursor:src("/img/c.cur"),auto}`,
        `.d{background-image:image-set("/img/used.png" 1x)}`,
      ].join("\n"),
    shadowSheets: () => 0,
    sameOriginFetch: async (url) => {
      fetched.push(url);
      return { bytes: PNG_BYTES, mime: "image/png" };
    },
  });
  const sheet = draft.authorsheet ?? "";
  expect(sheet).not.toContain("data:");
  expect(sheet).not.toContain("other.png");
  expect(sheet).not.toContain("b.png");
  expect(sheet).not.toContain("c.cur");
  expect(sheet).toContain(`image-set(url({{asset:${used}}}) 1x)`);
  expect(fetched).toEqual(["http://localhost/img/used.png"]);
  expect(draft.parts.map((p) => p.name)).toEqual([`asset-${used}`]);
});

test("a quoted URL holding ) is one reference in the stylesheet too, used or not (2-C2)", async () => {
  const used = fnv8("http://localhost/images/chart(1).png");
  const draft = draftOf({ assetRefs: blockRefs("/images/chart(1).png") });
  await harvest(draft, {
    doc: {} as Document,
    baseUrl: BASE,
    sheets: () => [{} as CSSStyleSheet],
    sheetText: () =>
      [
        `.a{background-image:image-set("/images/chart(1).png" 1x)}`,
        `.b{background-image:url("data:image/svg+xml,<svg>)</svg>")}`,
        `.c{background-image:url('/img/unused(3).png')}`,
      ].join("\n"),
    shadowSheets: () => 0,
    sameOriginFetch: async () => ({ bytes: PNG_BYTES, mime: "image/png" }),
  });
  const sheet = draft.authorsheet ?? "";
  expect(sheet).toContain(`.a{background-image:image-set(url({{asset:${used}}}) 1x)}`);
  expect(sheet).toContain(".b{background-image:none}");
  expect(sheet).toContain(".c{background-image:none}");
  expect(sheet).not.toContain("data:");
  expect(sheet).not.toContain("unused");
  expect(draft.parts.map((p) => p.name)).toEqual([`asset-${used}`]);
});

test("an empty URL in a stylesheet is never resolved to the page's own URL (3-C3)", async () => {
  // Not even when the page's own URL is one the block uses.
  const draft = draftOf({ assetRefs: blockRefs("/") });
  await harvest(draft, {
    doc: {} as Document,
    baseUrl: BASE,
    sheets: () => [{} as CSSStyleSheet],
    sheetText: () => `.a{background-image:url("")}\n.b{background-image:image-set('' 1x)}`,
    shadowSheets: () => 0,
    sameOriginFetch: async () => ({ bytes: PNG_BYTES, mime: "image/png" }),
  });
  expect(draft.authorsheet).toContain(".a{background-image:none}");
  expect(draft.authorsheet).toContain(".b{background-image:image-set(none 1x)}");
  expect(draft.authorsheet).not.toContain("{{asset:");
});

test("an asset referenced both inline (walker) and in author CSS collapses to ONE part (D11 dedup)", async () => {
  // fnv8(url) is shared with the walker, so a URL appearing as both a computed
  // background (walker assetRef) and an author-CSS url() addresses one part name.
  const ref = fnv8("http://localhost/img/shared.png");
  const draft = draftOf({
    assetRefs: [
      {
        ref,
        url: "http://localhost/img/shared.png",
        origin: "http://localhost",
        kind: "background",
      },
    ],
  });
  let fetches = 0;
  await harvest(draft, {
    doc: {} as Document,
    baseUrl: BASE,
    sheets: () => [{} as CSSStyleSheet],
    sheetText: () => '.x{background:url("/img/shared.png")}',
    shadowSheets: () => 0,
    sameOriginFetch: async () => {
      fetches += 1;
      return { bytes: PNG_BYTES, mime: "image/png" };
    },
  });
  const assetParts = draft.parts.filter((p) => p.name === `asset-${ref}`);
  expect(assetParts.length).toBe(1); // exactly one part, not two
  expect(fetches).toBe(1); // fetched once
  expect(draft.authorsheet).toContain(`{{asset:${ref}}}`); // author url rewritten to the shared ref
});

test("D13 budget bounds the fetch storm + data-part count and meters oversize-truncation", async () => {
  // 40 images used inside the block (3b-C7: only the block's images are fetched).
  const draft = draftOf({
    assetRefs: blockRefs(...Array.from({ length: 40 }, (_, i) => `/img/${i}.png`)),
  });
  const rules = "";
  let fetches = 0;
  await harvest(draft, {
    doc: {} as Document,
    baseUrl: BASE,
    sheets: () => [{} as CSSStyleSheet],
    sheetText: () => rules,
    shadowSheets: () => 0,
    sameOriginFetch: async () => {
      fetches += 1;
      return { bytes: PNG_BYTES, mime: "image/png" };
    },
  });
  const dataParts = draft.parts.filter((p) => p.role === "asset" || p.role === "font");
  // Reserve 2 slots (document + authorsheet); no witness staged → ≤ 14 admitted.
  expect(dataParts.length).toBeLessThanOrEqual(14);
  expect(fetches).toBeLessThanOrEqual(64); // the hard fetch-attempt cap bounds the storm
  expect(draft.residue.toArray().some((e) => e.class === "oversize-truncation")).toBe(true);
});

test("in-scope shadow constructed sheets meter shadow-scoped-rules (D14)", async () => {
  const draft = draftOf();
  await harvest(draft, {
    doc: {} as Document,
    baseUrl: BASE,
    sheets: () => [],
    sheetText: () => "",
    shadowSheets: () => 1,
  });
  expect(draft.residue.toArray().some((e) => e.class === "shadow-scoped-rules")).toBe(true);
});

test("F32 — a server-inadmissible asset (SVG bytes) is dropped + metered, never shipped", async () => {
  // The live webawesome.com failure: an SVG background rode the manifest as an
  // asset part, the server 415'd the PUT, and the WHOLE edit-context silently
  // died. The harvest now mirrors the server's byte-magic gate.
  const draft = draftOf({ assetRefs: blockRefs("/img/grid.svg", "/img/ok.png") });
  const svg = new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg"/>');
  await harvest(draft, {
    doc: {} as Document,
    baseUrl: BASE,
    sheets: () => [{} as CSSStyleSheet],
    sheetText: () => '.grid{background:url("/img/grid.svg")}\n.ok{background:url("/img/ok.png")}',
    shadowSheets: () => 0,
    sameOriginFetch: async (url) =>
      url.endsWith("grid.svg")
        ? { bytes: svg, mime: "image/svg+xml" }
        : { bytes: PNG_BYTES, mime: "image/png" },
  });
  // The admissible PNG became a part; the SVG did not — and it was metered.
  expect(draft.parts.filter((p) => p.role === "asset").length).toBe(1);
  expect(draft.parts.some((p) => p.mime === "image/svg+xml")).toBe(false);
  expect(draft.residue.toArray().some((e) => e.class === "unfetchable-asset")).toBe(true);
});

test("F32 — a font whose bytes are not a real font (an HTML error page) is dropped + metered", async () => {
  const draft = draftOf();
  const html = new TextEncoder().encode("<!doctype html><html>404</html>");
  await harvest(draft, {
    doc: {} as Document,
    baseUrl: BASE,
    sheets: () => [{} as CSSStyleSheet],
    sheetText: () => '@font-face{font-family:I;src:url("/f/i.woff2")}',
    shadowSheets: () => 0,
    sameOriginFetch: async () => ({ bytes: html, mime: "font/woff2" }),
  });
  expect(draft.parts.some((p) => p.role === "font")).toBe(false);
  expect(draft.residue.toArray().some((e) => e.class === "unfetchable-asset")).toBe(true);
});

test("F32 — an over-pixel-cap raster is dropped + metered (the server would 415 image-too-large)", async () => {
  // A real PNG signature with IHDR dims 10000×5000 = 50MP > MAX_CAPTURE_IMAGE_PIXELS.
  const huge = new Uint8Array(32);
  huge.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 0);
  const dv = new DataView(huge.buffer);
  dv.setUint32(16, 10_000); // width
  dv.setUint32(20, 5_000); // height
  const draft = draftOf({ assetRefs: blockRefs("/img/huge.png") });
  await harvest(draft, {
    doc: {} as Document,
    baseUrl: BASE,
    sheets: () => [{} as CSSStyleSheet],
    sheetText: () => '.big{background:url("/img/huge.png")}',
    shadowSheets: () => 0,
    sameOriginFetch: async () => ({ bytes: huge, mime: "image/png" }),
  });
  expect(draft.parts.some((p) => p.role === "asset")).toBe(false);
  expect(draft.residue.toArray().some((e) => e.class === "unfetchable-asset")).toBe(true);
});
