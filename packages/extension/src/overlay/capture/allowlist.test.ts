import { expect, test } from "bun:test";
import { CAPTURE_STYLE_PROPS, INHERITED_STYLE_PROPS, URL_BEARING_PROPS } from "./allowlist";

test("CAPTURE_STYLE_PROPS is the pinned, deduplicated curated set", () => {
  expect(CAPTURE_STYLE_PROPS.length).toBe(134);
  expect(new Set(CAPTURE_STYLE_PROPS).size).toBe(CAPTURE_STYLE_PROPS.length);
});

test("membership: representative props from every group are present", () => {
  const has = (p: string): boolean => (CAPTURE_STYLE_PROPS as readonly string[]).includes(p);
  // box / layout
  expect(has("display")).toBe(true);
  expect(has("width")).toBe(true);
  expect(has("margin-top")).toBe(true);
  // flex / grid
  expect(has("gap")).toBe(true);
  expect(has("grid-template-columns")).toBe(true);
  // typography
  expect(has("color")).toBe(true);
  expect(has("font-family")).toBe(true);
  expect(has("-webkit-text-fill-color")).toBe(true);
  // backgrounds / borders / effects
  expect(has("background-image")).toBe(true);
  expect(has("border-top-left-radius")).toBe(true);
  expect(has("box-shadow")).toBe(true);
  // transform / misc
  expect(has("transform")).toBe(true);
  expect(has("aspect-ratio")).toBe(true);
  expect(has("content-visibility")).toBe(true);
});

test("no motion / interaction / scroll props leak in (they'd disagree with the witness)", () => {
  for (const p of CAPTURE_STYLE_PROPS) {
    expect(p.startsWith("transition")).toBe(false);
    expect(p.startsWith("animation")).toBe(false);
    expect(p.startsWith("scroll")).toBe(false);
  }
  const has = (p: string): boolean => (CAPTURE_STYLE_PROPS as readonly string[]).includes(p);
  expect(has("will-change")).toBe(false);
  expect(has("user-select")).toBe(false);
  expect(has("transition")).toBe(false);
  expect(has("animation")).toBe(false);
});

test("the inheritable subset is a subset of the allowlist and holds only inheritable props", () => {
  for (const p of INHERITED_STYLE_PROPS) {
    expect((CAPTURE_STYLE_PROPS as readonly string[]).includes(p)).toBe(true);
  }
  expect(INHERITED_STYLE_PROPS.has("color")).toBe(true);
  expect(INHERITED_STYLE_PROPS.has("font-size")).toBe(true);
  expect(INHERITED_STYLE_PROPS.has("visibility")).toBe(true);
  // non-inherited props must NOT be in the delta-suppression set
  expect(INHERITED_STYLE_PROPS.has("background-color")).toBe(false);
  expect(INHERITED_STYLE_PROPS.has("width")).toBe(false);
  expect(INHERITED_STYLE_PROPS.has("display")).toBe(false);
});

test("url-bearing props are a subset of the allowlist", () => {
  for (const p of URL_BEARING_PROPS) {
    expect((CAPTURE_STYLE_PROPS as readonly string[]).includes(p)).toBe(true);
  }
  expect(URL_BEARING_PROPS.has("background-image")).toBe(true);
});
