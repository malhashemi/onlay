import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { gzipSync } from "node:zlib";
import type { CaptureRef, MutationProgram } from "@onlay/protocol";
import { Window } from "happy-dom";
import { buildSrcdoc } from "./portable-renderer";

let win: Window | null = null;

function installDom(): void {
  win = new Window({ url: "http://127.0.0.1:8124/cap.html" });
  const g = globalThis as unknown as {
    document: Document;
    DOMParser: typeof DOMParser;
    Node: typeof Node;
    Element: typeof Element;
    HTMLElement: typeof HTMLElement;
    DocumentFragment: typeof DocumentFragment;
  };
  g.document = win.document as unknown as Document;
  g.DOMParser = win.DOMParser as unknown as typeof DOMParser;
  g.Node = win.Node as unknown as typeof Node;
  g.Element = win.Element as unknown as typeof Element;
  g.HTMLElement = win.HTMLElement as unknown as typeof HTMLElement;
  g.DocumentFragment = win.DocumentFragment as unknown as typeof DocumentFragment;
}

beforeEach(() => installDom());
afterEach(() => {
  win?.happyDOM.cancelAsync();
  win?.close();
  win = null;
});

const META_CSP = "default-src 'none'";

/** A minimal well-formed capture document (pre-gzip). */
function captureDoc(extraBody = ""): string {
  return (
    '<!doctype html><html data-oc-root lang="en"><head>' +
    '<meta charset="utf-8">' +
    `<meta http-equiv="Content-Security-Policy" content="${META_CSP}; style-src 'unsafe-inline'; img-src data:; font-src data:">` +
    '<style id="oc-fonts">@font-face{font-family:"X";src:url({{font:aabbccdd}})}</style>' +
    '<style id="oc-base">:root{--brand:#f60}' +
    '[data-oc="4"]{color:#111;background-image:url({{asset:11223344}})}</style>' +
    "</head><body>" +
    '<div data-oc="4" data-oc-block class="card">' +
    '<img data-oc="5" src="{{asset:11223344}}" alt="logo">hi' +
    extraBody +
    "</div></body></html>"
  );
}

interface CaptureBundle {
  ref: CaptureRef;
  fetchPart: (name: string) => Promise<Uint8Array | null>;
  calls: Map<string, number>;
}

function bundle(
  opts: {
    docHtml?: string;
    withFont?: boolean;
    withAsset?: boolean;
    authorsheet?: string | "declared-missing";
  } = {},
): CaptureBundle {
  const { docHtml = captureDoc(), withFont = true, withAsset = true, authorsheet } = opts;
  const store = new Map<string, Uint8Array>();
  store.set("document", new Uint8Array(gzipSync(Buffer.from(docHtml, "utf-8"))));
  if (withFont) store.set("font-aabbccdd", new Uint8Array([1, 2, 3]));
  if (withAsset) store.set("asset-11223344", new Uint8Array([1, 2, 3]));
  if (typeof authorsheet === "string") {
    store.set("authorsheet", new Uint8Array(gzipSync(Buffer.from(authorsheet, "utf-8"))));
  }

  const parts: CaptureRef["parts"] = [
    { name: "document", role: "document", mime: "application/gzip", byteLen: 1 },
  ];
  if (withFont) parts.push({ name: "font-aabbccdd", role: "font", mime: "font/woff2", byteLen: 3 });
  if (withAsset)
    parts.push({ name: "asset-11223344", role: "asset", mime: "image/png", byteLen: 3 });
  if (authorsheet !== undefined) {
    // Both a present sheet and the "declared-missing" case register a part; the
    // latter has no stored bytes to exercise a declined/absent fetch.
    parts.push({ name: "authorsheet", role: "document", mime: "application/gzip", byteLen: 1 });
  }

  const calls = new Map<string, number>();
  const fetchPart = async (name: string): Promise<Uint8Array | null> => {
    calls.set(name, (calls.get(name) ?? 0) + 1);
    return store.get(name) ?? null;
  };
  return { ref: { parts } as unknown as CaptureRef, fetchPart, calls };
}

const setClass = (add: string[]): MutationProgram => [
  { op: "setClass", target: ":scope", add, remove: [] },
];

describe("buildSrcdoc — the portable renderer", () => {
  test("throws only on a null ref (programmer contract)", async () => {
    // biome-ignore lint/suspicious/noExplicitAny: exercising the contract violation
    await expect(buildSrcdoc({ ref: null as any, fetchPart: async () => null })).rejects.toThrow();
  });

  test("builds a valid srcdoc: doctype, meta-CSP, oc-base, inlined font + asset", async () => {
    const b = bundle();
    const { srcdoc, residue } = await buildSrcdoc({ ref: b.ref, fetchPart: b.fetchPart });
    expect(srcdoc.startsWith("<!doctype html>")).toBe(true);
    expect(srcdoc).toContain(META_CSP);
    expect(srcdoc).toContain('id="oc-base"');
    expect(srcdoc).toContain("url(data:font/woff2;base64,AQID)");
    expect(srcdoc).toContain("url(data:image/png;base64,AQID)");
    expect(srcdoc).toContain('src="data:image/png;base64,AQID"');
    // no live external URL, no leftover placeholder, no script.
    expect(srcdoc).not.toContain("{{");
    expect(srcdoc).not.toContain("<script");
    expect(residue.strippedPlaceholders).toBe(0);
    expect(residue.strippedUrls).toBe(0);
    // the asset (css + img) fetched exactly once (per-part cache).
    expect(b.calls.get("asset-11223344")).toBe(1);
  });

  test("Original mode never appends the authorsheet even when the part exists", async () => {
    const b = bundle({ authorsheet: ".card{background:orange}" });
    const { srcdoc, residue } = await buildSrcdoc({ ref: b.ref, fetchPart: b.fetchPart });
    expect(srcdoc).not.toContain('id="oc-author"');
    expect(residue.authorRulesMissing).toBe(false);
    expect(b.calls.get("authorsheet")).toBeUndefined();
  });

  test("variant setClass + covering authorsheet → oc-author appended after oc-base; not missing", async () => {
    const b = bundle({ authorsheet: ".btn--brand{background:orange}" });
    const { srcdoc, residue } = await buildSrcdoc({
      ref: b.ref,
      fetchPart: b.fetchPart,
      program: setClass(["btn--brand"]),
    });
    expect(srcdoc).toContain('id="oc-author"');
    expect(srcdoc.indexOf('id="oc-author"')).toBeGreaterThan(srcdoc.indexOf('id="oc-base"'));
    expect(srcdoc).toContain("btn--brand");
    expect(residue.authorRulesMissing).toBe(false);
    expect(residue.applied).toBe(1);
  });

  test("variant setClass + NO authorsheet part → no author style; authorRulesMissing", async () => {
    const b = bundle(); // no authorsheet registered
    const { srcdoc, residue } = await buildSrcdoc({
      ref: b.ref,
      fetchPart: b.fetchPart,
      program: setClass(["btn--brand"]),
    });
    expect(srcdoc).not.toContain('id="oc-author"');
    expect(residue.authorRulesMissing).toBe(true);
  });

  test("variant setClass whose token is absent from a present authorsheet → missing (R12)", async () => {
    const b = bundle({ authorsheet: ".something-else{color:blue}" });
    const { srcdoc, residue } = await buildSrcdoc({
      ref: b.ref,
      fetchPart: b.fetchPart,
      program: setClass(["btn--brand"]),
    });
    expect(srcdoc).not.toContain('id="oc-author"');
    expect(residue.authorRulesMissing).toBe(true);
  });

  test("variant setStyle only → authorsheet never appended; inline style wins", async () => {
    const b = bundle({ authorsheet: ".btn--brand{background:orange}" });
    const program: MutationProgram = [
      { op: "setStyle", target: ":scope", props: [{ prop: "color", value: "rgb(255, 0, 0)" }] },
    ];
    const { srcdoc, residue } = await buildSrcdoc({ ref: b.ref, fetchPart: b.fetchPart, program });
    expect(srcdoc).not.toContain('id="oc-author"');
    expect(residue.authorRulesMissing).toBe(false);
    expect(residue.applied).toBe(1);
    // the block carries the inline style attribute (specificity beats oc-base).
    const doc = new DOMParser().parseFromString(srcdoc, "text/html");
    const block = doc.querySelector("[data-oc-block]") as HTMLElement;
    expect(block.style.getPropertyValue("color")).toBe("rgb(255, 0, 0)");
  });

  test("miss-tally surfaces: an op targeting outside the block increments misses", async () => {
    const b = bundle();
    const program: MutationProgram = [{ op: "setText", target: ".not-in-block", text: "x" }];
    const { residue } = await buildSrcdoc({ ref: b.ref, fetchPart: b.fetchPart, program });
    expect(residue.applied).toBe(0);
    expect(residue.misses).toBe(1);
  });

  test("missing asset bytes → declaration + attr stripped, no live external URL", async () => {
    const b = bundle({ withAsset: false }); // asset part absent
    const { srcdoc, residue } = await buildSrcdoc({ ref: b.ref, fetchPart: b.fetchPart });
    expect(srcdoc).not.toContain("{{asset");
    expect(srcdoc).not.toContain("background-image");
    expect(srcdoc).not.toContain('src="{{');
    expect(residue.strippedPlaceholders).toBeGreaterThanOrEqual(1);
    // the font still inlined.
    expect(srcdoc).toContain("url(data:font/woff2;base64,AQID)");
  });

  test("null document part → minimal honest srcdoc, never throws", async () => {
    const fetchPart = async () => null;
    const { srcdoc, residue } = await buildSrcdoc({
      ref: { parts: [] } as unknown as CaptureRef,
      fetchPart,
    });
    expect(srcdoc).toContain(META_CSP);
    expect(srcdoc).toContain("This capture couldn't be rendered");
    expect(residue.strippedPlaceholders).toBe(0);
  });

  test("gunzip failure → minimal honest srcdoc, never throws", async () => {
    const ref = {
      parts: [{ name: "document", role: "document", mime: "application/gzip", byteLen: 3 }],
    } as unknown as CaptureRef;
    const fetchPart = async (name: string) =>
      name === "document" ? new Uint8Array([9, 9, 9, 9]) : null;
    const { srcdoc } = await buildSrcdoc({ ref, fetchPart });
    expect(srcdoc).toContain(META_CSP);
    expect(srcdoc).toContain("compare with the captured screenshot");
  });

  test("defense-in-depth: a smuggled script / on* / javascript: is stripped before serialize", async () => {
    const hostile =
      '<script>fetch("http://canary.invalid/x")</script>' +
      '<a href="javascript:alert(1)" onclick="steal()">x</a>' +
      "<style>.leak{color:red}</style>";
    const b = bundle({ docHtml: captureDoc(hostile) });
    const { srcdoc } = await buildSrcdoc({ ref: b.ref, fetchPart: b.fetchPart });
    expect(srcdoc).not.toContain("<script");
    expect(srcdoc).not.toContain("canary.invalid");
    expect(srcdoc.toLowerCase()).not.toContain("javascript:");
    expect(srcdoc).not.toContain("onclick");
    expect(srcdoc).not.toContain(".leak"); // the non-oc <style> dropped
    expect(srcdoc).toContain('id="oc-base"'); // the capture's own sheet survives
  });

  test("hostile authorsheet '</style><script>' cannot break out — re-parse has no script", async () => {
    // `outerHTML` does not entity-escape raw-text bodies, so an un-neutralized
    // `</style>` in the harvested sheet would re-parse as a real element in the
    // srcdoc. The renderer neutralizes `</` in every <style> before serializing.
    const b = bundle({
      authorsheet:
        '.btn--brand{color:red}</style><script>fetch("http://canary.invalid/x")</script>',
    });
    const { srcdoc } = await buildSrcdoc({
      ref: b.ref,
      fetchPart: b.fetchPart,
      program: setClass(["btn--brand"]),
    });
    const reparsed = new DOMParser().parseFromString(srcdoc, "text/html");
    expect(reparsed.querySelectorAll("script").length).toBe(0);
    // the neutralized end-tag stays inert CSS text inside oc-author.
    expect(srcdoc).toContain("<\\/style>");
    expect(srcdoc).not.toContain("</style><script");
  });

  test("meta http-equiv=refresh is dropped and the canonical CSP is forced", async () => {
    const b = bundle({
      docHtml: captureDoc('<meta http-equiv="refresh" content="0;url=http://canary.invalid/">'),
    });
    const { srcdoc } = await buildSrcdoc({ ref: b.ref, fetchPart: b.fetchPart });
    expect(srcdoc.toLowerCase()).not.toContain("refresh");
    expect(srcdoc).not.toContain("canary.invalid");
    expect(srcdoc).toContain(META_CSP);
  });

  test("a document part lacking a CSP meta still gets the forced in-frame CSP", async () => {
    const noCsp =
      "<!doctype html><html data-oc-root><head>" +
      '<style id="oc-base">[data-oc="4"]{color:#111}</style></head><body>' +
      '<div data-oc="4" data-oc-block>hi</div></body></html>';
    const b = bundle({ docHtml: noCsp, withFont: false, withAsset: false });
    const { srcdoc } = await buildSrcdoc({ ref: b.ref, fetchPart: b.fetchPart });
    const reparsed = new DOMParser().parseFromString(srcdoc, "text/html");
    const csp = reparsed.querySelector('meta[http-equiv="Content-Security-Policy" i]');
    expect(csp?.getAttribute("content") ?? "").toContain("default-src 'none'");
  });
});
