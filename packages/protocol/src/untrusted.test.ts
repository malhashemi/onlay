import { describe, expect, test } from "bun:test";
import { LIMITS } from "./limits";
import { declassify, untrusted, unwrapForPage } from "./untrusted";

describe("UntrustedText", () => {
  test("declassify strips control characters", () => {
    const t = untrusted("hey\u0000there\u001b[31m general\u007f kenobi\n");
    expect(declassify(t)).toBe("hey there [31m general  kenobi ");
  });

  test("declassify turns Unicode line breaks into spaces, like ASCII ones", () => {
    const t = untrusted("a\u2028b\u2029c\u0085d\u000be\u000cf\r\ng");
    expect(declassify(t)).toBe("a b c d e f  g");
  });

  test("declassify removes bidirectional overrides and invisible marks", () => {
    const t = untrusted("\u202eevil\u202c \u2066x\u2069\u200b\u200f\ufeff\u061cy");
    expect(declassify(t)).toBe("evil xy");
  });

  test("declassify truncates to default MAX_TEXT_SNIPPET", () => {
    const t = untrusted("a".repeat(LIMITS.MAX_TEXT_SNIPPET * 2));
    expect(declassify(t).length).toBe(LIMITS.MAX_TEXT_SNIPPET);
  });

  test("declassify honors an explicit max", () => {
    const t = untrusted("abcdefgh");
    expect(declassify(t, 3)).toBe("abc");
  });

  test("unwrapForPage returns the raw string unchanged", () => {
    const raw = "div#player > .controls\u0000";
    expect(unwrapForPage(untrusted(raw))).toBe(raw);
  });

  test("brand is erased at runtime (JSON round-trip untouched)", () => {
    const t = untrusted("plain");
    expect(JSON.stringify({ t })).toBe('{"t":"plain"}');
  });
});
