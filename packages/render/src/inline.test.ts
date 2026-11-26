import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { gzipSync } from "node:zlib";
import type { CaptureRef } from "@onlay/protocol";
import { Window } from "happy-dom";
import { bytesToDataUri, gunzip, inlinePlaceholders, partNameForToken } from "./inline";

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

function refWith(parts: CaptureRef["parts"]): CaptureRef {
  return { parts } as unknown as CaptureRef;
}

describe("gunzip", () => {
  test("round-trips a gzipped string via DecompressionStream", async () => {
    const original = "<!doctype html><html><head></head><body>café ☕ & <> stuff</body></html>";
    const bytes = new Uint8Array(gzipSync(Buffer.from(original, "utf-8")));
    expect(await gunzip(bytes)).toBe(original);
  });

  test("rejects on non-gzip bytes", async () => {
    await expect(gunzip(new Uint8Array([1, 2, 3, 4]))).rejects.toBeDefined();
  });

  test("rejects a decompression bomb — output past the cap aborts (gpt56-3)", async () => {
    // A highly-compressible payload gzips tiny but expands large; the streaming
    // output cap must abort instead of buffering the whole expansion.
    const bomb = new Uint8Array(gzipSync(Buffer.from("A".repeat(2_000_000), "utf-8")));
    expect(bomb.byteLength).toBeLessThan(10_000); // tiny compressed
    await expect(gunzip(bomb, 4096)).rejects.toBeDefined(); // over a 4 KiB cap → aborts
    // A payload within the cap still decompresses.
    const ok = new Uint8Array(gzipSync(Buffer.from("hello", "utf-8")));
    expect(await gunzip(ok, 4096)).toBe("hello");
  });
});

describe("bytesToDataUri", () => {
  test("base64-assembles with the declared mime", () => {
    expect(bytesToDataUri(new Uint8Array([1, 2, 3]), "font/woff2")).toBe(
      "data:font/woff2;base64,AQID",
    );
  });
});

describe("partNameForToken — exact suffix, no fallback (F1/D11)", () => {
  test("sha8 / sha12 / sha16 tokens map to matching part names", () => {
    expect(partNameForToken("{{font:aabbccdd}}")).toBe("font-aabbccdd");
    expect(partNameForToken("{{asset:aabbccdd11ff}}")).toBe("asset-aabbccdd11ff");
    expect(partNameForToken("{{font:aabbccdd11ff2233}}")).toBe("font-aabbccdd11ff2233");
  });
  test("malformed token → null", () => {
    expect(partNameForToken("{{font:XYZ}}")).toBeNull();
    expect(partNameForToken("font-aabbccdd")).toBeNull();
  });
});

describe("inlinePlaceholders", () => {
  test("resolves a font/asset placeholder to a data: URI from the fetched part's mime", async () => {
    const doc = parse(
      '<html><head><style id="oc-base">[data-oc="0"]{background-image:url({{asset:11223344}})}</style></head>' +
        '<body><img src="{{asset:11223344}}"></body></html>',
    );
    const ref = refWith([{ name: "asset-11223344", role: "asset", mime: "image/png", byteLen: 3 }]);
    let calls = 0;
    const fetchPart = async (name: string) => {
      calls += 1;
      return name === "asset-11223344" ? new Uint8Array([1, 2, 3]) : null;
    };
    const { stripped } = await inlinePlaceholders(doc, ref, fetchPart);
    expect(stripped).toBe(0);
    const html = doc.documentElement.outerHTML;
    expect(html).toContain("url(data:image/png;base64,AQID)");
    expect(html).toContain('src="data:image/png;base64,AQID"');
    // shared sha fetched once across the css + the <img>.
    expect(calls).toBe(1);
  });

  test("exact-name only: a sha12 token resolves to its sha12 part, an sha8 token does not prefix-match it", async () => {
    const doc = parse(
      '<html><head><style id="oc-base">a{background-image:url({{font:aabbccdd11ff}})}' +
        "b{background-image:url({{font:aabbccdd}})}</style></head><body></body></html>",
    );
    const ref = refWith([
      { name: "font-aabbccdd11ff", role: "font", mime: "font/woff2", byteLen: 3 },
    ]);
    const fetchPart = async (name: string) =>
      name === "font-aabbccdd11ff" ? new Uint8Array([1, 2, 3]) : null;
    const { stripped } = await inlinePlaceholders(doc, ref, fetchPart);
    const css = doc.getElementById("oc-base")?.textContent ?? "";
    // the sha12 token inlined; the sha8 token (no exact part) stripped, not prefix-matched.
    expect(css).toContain("url(data:font/woff2;base64,AQID)");
    expect(css).not.toContain("{{font:aabbccdd}}");
    expect(css).not.toContain("aabbccdd)"); // no live/empty url() left behind
    expect(stripped).toBe(1);
  });

  test("missing bytes → declaration removed (no empty url()), attribute removed", async () => {
    const doc = parse(
      '<html><head><style id="oc-base">[data-oc="0"]{color:red;background-image:url({{asset:deadbeef}});margin:0}</style></head>' +
        '<body><img src="{{asset:deadbeef}}"></body></html>',
    );
    const ref = refWith([{ name: "asset-deadbeef", role: "asset", mime: "image/png", byteLen: 0 }]);
    const fetchPart = async () => null; // declined grant / fetch failure
    const { stripped } = await inlinePlaceholders(doc, ref, fetchPart);
    const css = doc.getElementById("oc-base")?.textContent ?? "";
    expect(css).toContain("color:red");
    expect(css).toContain("margin:0");
    expect(css).not.toContain("background-image");
    expect(css).not.toContain("url(");
    expect(doc.querySelector("img")?.hasAttribute("src")).toBe(false);
    expect(stripped).toBe(2); // the css decl + the img attr
  });
});
