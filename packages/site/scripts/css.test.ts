// The build's CSS steps: the overlay sheet scoped under `.ov` and zoomed.
import { describe, expect, test } from "bun:test";
import { minifyCss, scopeCss, zoomCss } from "./css";

const flat = (css: string): string => minifyCss(css);

describe("scopeCss", () => {
  test("puts every selector of a list under the scope", () => {
    expect(flat(scopeCss(".btn, .chip:hover { color: red; }", ".ov"))).toBe(
      ".ov .btn,.ov .chip:hover{color:red}",
    );
  });

  test(":host is the scope itself, with or without a class", () => {
    expect(flat(scopeCss(":host { color: red; }", ".ov"))).toBe(".ov{color:red}");
    expect(flat(scopeCss(":host(.theme-light) { color: red; }", ".ov"))).toBe(
      ".ov.theme-light{color:red}",
    );
    expect(
      flat(scopeCss(":host(.ov-static) .card, :host(.ov-static) .pin { top: 0; }", ".ov")),
    ).toBe(".ov.ov-static .card,.ov.ov-static .pin{top:0}");
  });

  test("commas inside :not() and attribute selectors do not split a selector", () => {
    expect(flat(scopeCss('.a:not(.b, .c) [data-x="1,2"] { top: 0; }', ".ov"))).toBe(
      '.ov .a:not(.b,.c) [data-x="1,2"]{top:0}',
    );
  });

  test("scopes inside @media, and leaves @keyframes alone", () => {
    const css = `@media (max-width: 40em) { .card { top: 0; } }
      @keyframes ov-in { from { opacity: 0; } to { opacity: 1; } }`;
    expect(flat(scopeCss(css, ".ov"))).toBe(
      "@media (max-width:40em){.ov .card{top:0}}@keyframes ov-in{from{opacity:0}to{opacity:1}}",
    );
  });

  test("drops comments, braces in them included", () => {
    expect(flat(scopeCss("/* a { } */ .a { top: 0; }", ".ov"))).toBe(".ov .a{top:0}");
  });
});

describe("zoomCss", () => {
  test("multiplies px lengths and nothing else", () => {
    expect(
      zoomCss("a{padding:4px 10px;top:16vh;width:92vw;line-height:1.5;margin:-2px}", 1.25),
    ).toBe("a{padding:5px 12.5px;top:16vh;width:92vw;line-height:1.5;margin:-2.5px}");
    expect(zoomCss("a{font:600 9px/1.3 mono;border:1.5px solid}", 1.25)).toBe(
      "a{font:600 11.25px/1.3 mono;border:1.875px solid}",
    );
  });

  test("at 1× the sheet is untouched", () => {
    expect(zoomCss("a{top:3px}", 1)).toBe("a{top:3px}");
  });
});
