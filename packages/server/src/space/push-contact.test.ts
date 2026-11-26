import { describe, expect, test } from "bun:test";
import { pushContactOf } from "./push-contact";

describe("pushContactOf", () => {
  test("a mailto: address or an https: URL is used as given", () => {
    expect(pushContactOf("mailto:ops@example.com", "https://app.example.com")).toBe(
      "mailto:ops@example.com",
    );
    expect(pushContactOf("  mailto:ops@example.com ", undefined)).toBe("mailto:ops@example.com");
    expect(pushContactOf("https://example.com/contact", "https://app.example.com")).toBe(
      "https://example.com/contact",
    );
  });

  test("without a usable contact, the deployment's own service origin", () => {
    for (const contact of [
      undefined,
      "",
      "ops@example.com",
      "mailto:",
      "mailto:not-an-address",
      "http://example.com/contact",
      "https://user:pass@example.com/",
      "javascript:alert(1)",
    ]) {
      expect(pushContactOf(contact, "https://app.example.com/")).toBe("https://app.example.com");
    }
    expect(pushContactOf(undefined, "http://localhost:8787")).toBe("http://localhost:8787");
  });

  test("with neither, there is no contact", () => {
    expect(pushContactOf(undefined, undefined)).toBeUndefined();
    expect(pushContactOf("", "not a url")).toBeUndefined();
    expect(pushContactOf("", "ftp://example.com")).toBeUndefined();
  });
});
