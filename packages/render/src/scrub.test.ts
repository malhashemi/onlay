import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Window } from "happy-dom";
import { scrubExternalUrls } from "./scrub";

let win: Window | null = null;

function installDom(): void {
  win = new Window({ url: "http://127.0.0.1:8124/cap.html" });
  const g = globalThis as unknown as { document: Document; DOMParser: typeof DOMParser };
  g.document = win.document as unknown as Document;
  g.DOMParser = win.DOMParser as unknown as typeof DOMParser;
}

beforeEach(() => installDom());
afterEach(() => {
  win?.happyDOM.cancelAsync();
  win?.close();
  win = null;
});

function parse(html: string): Document {
  return new DOMParser().parseFromString(html, "text/html");
}

describe("scrubExternalUrls — the egress belt", () => {
  test("strips a residual https url() declaration and counts it", () => {
    const doc = parse(
      '<html><head><style id="oc-base">a{color:red;background-image:url(https://cdn.example.com/x.png);margin:0}</style></head><body></body></html>',
    );
    const count = scrubExternalUrls(doc);
    const css = doc.getElementById("oc-base")?.textContent ?? "";
    expect(css).toContain("color:red");
    expect(css).toContain("margin:0");
    expect(css).not.toContain("background-image");
    expect(count).toBe(1);
  });

  test("drops @import and strips a protocol-relative //host url()", () => {
    const doc = parse(
      '<html><head><style id="oc-base">@import url(https://x.test/a.css);a{background:url(//evil.test/b.png)}</style></head><body></body></html>',
    );
    const count = scrubExternalUrls(doc);
    const css = doc.getElementById("oc-base")?.textContent ?? "";
    expect(css).not.toContain("@import");
    expect(css).not.toContain("evil.test");
    expect(count).toBe(2);
  });

  test("preserves data: url() and fragment url(#id)", () => {
    const doc = parse(
      '<html><head><style id="oc-base">a{background-image:url(data:image/png;base64,AQID)}b{fill:url(#grad)}</style></head><body></body></html>',
    );
    const count = scrubExternalUrls(doc);
    const css = doc.getElementById("oc-base")?.textContent ?? "";
    expect(css).toContain("data:image/png;base64,AQID");
    expect(css).toContain("url(#grad)");
    expect(count).toBe(0);
  });

  test("strips a QUOTED url() whose payload contains a )", () => {
    // The old `[^'")]*` class terminated at the first `)` and left the external
    // reference behind unmetered — a real egress hole.
    const doc = parse(
      '<html><head><style id="oc-base">a{background:url("https://cdn.example.com/a)b.png")}b{color:red}</style></head><body></body></html>',
    );
    const count = scrubExternalUrls(doc);
    const css = doc.getElementById("oc-base")?.textContent ?? "";
    expect(css).not.toContain("cdn.example.com");
    expect(css).toContain("color:red");
    expect(count).toBe(1);
  });

  test("strips a srcset that LEADS with data: but carries external candidates", () => {
    // `isInertUrl` only inspects the head; a data:-leading srcset with external
    // candidates must not survive.
    const doc = parse(
      "<html><head></head><body>" +
        '<img id="mix" srcset="data:image/gif;base64,AA 1x, https://canary.invalid/x-2x.png 2x">' +
        "</body></html>",
    );
    const count = scrubExternalUrls(doc);
    expect(doc.getElementById("mix")?.hasAttribute("srcset")).toBe(false);
    expect(count).toBe(1);
  });

  test("removes an element src=http… and a srcset, keeps a data: src", () => {
    const doc = parse(
      "<html><head></head><body>" +
        '<img id="ext" src="http://canary.invalid/x.png" srcset="http://canary.invalid/x-2x.png 2x">' +
        '<img id="ok" src="data:image/png;base64,AQID">' +
        "</body></html>",
    );
    const count = scrubExternalUrls(doc);
    expect(doc.getElementById("ext")?.hasAttribute("src")).toBe(false);
    expect(doc.getElementById("ext")?.hasAttribute("srcset")).toBe(false);
    expect(doc.getElementById("ok")?.getAttribute("src")).toBe("data:image/png;base64,AQID");
    expect(count).toBe(2);
  });
});
