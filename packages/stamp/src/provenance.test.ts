import { describe, expect, test } from "bun:test";
import { injectProvenanceIntoHtml, normalizeOrigin, provenanceHtmlAttr } from "./provenance";

describe("normalizeOrigin", () => {
  test("https URL → host/owner/repo, .git dropped", () => {
    expect(normalizeOrigin("https://github.com/o/r.git")).toBe("github.com/o/r");
  });
  test("https with credentials strips the user", () => {
    expect(normalizeOrigin("https://user@github.com/o/r")).toBe("github.com/o/r");
  });
  test("scp-like SSH shorthand normalizes", () => {
    expect(normalizeOrigin("git@github.com:o/r.git")).toBe("github.com/o/r");
  });
  test("trailing slash trimmed", () => {
    expect(normalizeOrigin("https://gitlab.com/o/r/")).toBe("gitlab.com/o/r");
  });
});

describe("provenance HTML injection", () => {
  const value = "github.com/o/r@abc1234;main;dirty";

  test("provenanceHtmlAttr escapes the value into a quoted attribute", () => {
    expect(provenanceHtmlAttr(value)).toBe(`data-onlay-provenance="${value}"`);
    expect(provenanceHtmlAttr('a"<&>')).toBe('data-onlay-provenance="a&quot;&lt;&amp;&gt;"');
  });

  test("injects onto the <html> tag", () => {
    const out = injectProvenanceIntoHtml(
      "<!doctype html><html lang=en><body></body></html>",
      value,
    );
    expect(out).toContain(`<html data-onlay-provenance="${value}" lang=en>`);
  });

  test("is idempotent — never double-stamps", () => {
    const once = injectProvenanceIntoHtml("<html><body></body></html>", value);
    expect(injectProvenanceIntoHtml(once, "other@x;y;clean")).toBe(once);
  });

  test("no <html> tag → unchanged", () => {
    expect(injectProvenanceIntoHtml("<body>x</body>", value)).toBe("<body>x</body>");
  });
});
