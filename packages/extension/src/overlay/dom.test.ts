// The overlay zoom transform (Appearance pref): zoomCss multiplies
// 1×-authored px lengths — including negatives, decimals, and font-shorthand
// sizes — and leaves viewport units, unitless line-heights, and em tracking
// untouched, so vw/vh caps keep clamping to the real viewport at any zoom.
import { describe, expect, test } from "bun:test";
import { scaled, zoomCss } from "./dom";

describe("zoomCss", () => {
  test("multiplies px lengths: integers, decimals, negatives", () => {
    expect(zoomCss("width: 12px;", 1.5)).toBe("width: 18px;");
    expect(zoomCss("top: -6px;", 1.5)).toBe("top: -9px;");
    expect(zoomCss("box-shadow: 0 0 0 1.5px red;", 2)).toBe("box-shadow: 0 0 0 3px red;");
  });

  test("leaves vw/vh, unitless, and em values untouched", () => {
    const css = "max-width: 92vw; max-height: 46vh; line-height: 1.4; letter-spacing: 0.02em;";
    expect(zoomCss(css, 1.5)).toBe(css);
  });

  test("scales only the px part of a font shorthand", () => {
    expect(zoomCss("font: 600 10px/1.4 monospace;", 1.5)).toBe("font: 600 15px/1.4 monospace;");
  });

  test("zoom 1 is the identity", () => {
    const css = "width: 640px; padding: 6px 8px;";
    expect(zoomCss(css, 1)).toBe(css);
  });
});

describe("scaled", () => {
  test("mirrors the default zoom for JS-side sheet-coupled geometry", () => {
    // default uiZoom is UI_ZOOM_DEFAULT (1.25) until applyUiZoom runs
    expect(scaled(30)).toBe(38);
    expect(scaled(28)).toBe(35);
  });
});
