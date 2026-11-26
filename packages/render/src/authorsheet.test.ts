import { describe, expect, test } from "bun:test";
import type { MutationProgram } from "@onlay/protocol";
import { classAttrTokens, gateAuthorsheet } from "./authorsheet";

const setClass = (add: string[], remove: string[] = []): MutationProgram => [
  { op: "setClass", target: ":scope", add, remove },
];
const setStyle: MutationProgram = [
  { op: "setStyle", target: ":scope", props: [{ prop: "color", value: "red" }] },
];
const setAttr = (name: string): MutationProgram => [
  { op: "setAttr", target: ":scope", name, value: "dark" },
];

describe("classAttrTokens", () => {
  test("collects added + removed class tokens and lowercased attr keys", () => {
    const program: MutationProgram = [
      { op: "setClass", target: ":scope", add: ["btn--brand"], remove: ["btn--muted"] },
      { op: "setAttr", target: ":scope", name: "Data-Theme", value: "dark" },
      { op: "setStyle", target: ":scope", props: [{ prop: "color", value: "red" }] },
    ];
    expect(classAttrTokens(program)).toEqual({
      classTokens: ["btn--brand", "btn--muted"],
      attrKeys: ["data-theme"],
    });
  });
});

describe("gateAuthorsheet — the honest-note law (R12 token-coverage)", () => {
  const author = ".btn--brand{background:orange}[data-theme=dark]{color:#fff}";

  test("no setClass/setAttr op → never append, nothing missing", () => {
    expect(gateAuthorsheet(setStyle, author)).toEqual({ append: false, authorRulesMissing: false });
  });

  test("setClass whose token APPEARS in the authorsheet → append, not missing", () => {
    expect(gateAuthorsheet(setClass(["btn--brand"]), author)).toEqual({
      append: true,
      authorRulesMissing: false,
    });
  });

  test("setClass whose token is ABSENT from an otherwise-present authorsheet → no append, MISSING", () => {
    // e.g. a shadow-scoped / un-harvested class laundered through a present sheet.
    expect(gateAuthorsheet(setClass(["shadow-only"]), author)).toEqual({
      append: false,
      authorRulesMissing: true,
    });
  });

  test("setClass with NO authorsheet part → no append, MISSING", () => {
    expect(gateAuthorsheet(setClass(["btn--brand"]), null)).toEqual({
      append: false,
      authorRulesMissing: true,
    });
  });

  test("removed-token coverage also counts", () => {
    expect(gateAuthorsheet(setClass([], ["btn--brand"]), author)).toEqual({
      append: true,
      authorRulesMissing: false,
    });
  });

  test("setAttr [data-* key coverage → append; absent → missing", () => {
    expect(gateAuthorsheet(setAttr("data-theme"), author)).toEqual({
      append: true,
      authorRulesMissing: false,
    });
    expect(gateAuthorsheet(setAttr("data-absent"), author)).toEqual({
      append: false,
      authorRulesMissing: true,
    });
  });

  test("token-boundary: a longer class is NOT covered by a prefix rule (.btnish ≠ .btn)", () => {
    // Raw substring coverage would set authorRulesMissing=false while the .btn
    // toggle silently no-ops — the exact honest-note laundering R12 forbids.
    expect(gateAuthorsheet(setClass(["btn"]), ".btnish{color:red}")).toEqual({
      append: false,
      authorRulesMissing: true,
    });
    // The real .btn rule (boundaried by `,`, `{`, `.`, `:`, ` `, `[`) IS covered.
    for (const sheet of [".btn{x:1}", ".btn.on{x:1}", ".btn:hover{x:1}", "a .btn ,b{x:1}"]) {
      expect(gateAuthorsheet(setClass(["btn"]), sheet).authorRulesMissing).toBe(false);
    }
  });

  test("coverage inspects SELECTOR preludes only — a token in a comment/value/url can't launder (gpt56-7)", () => {
    // Each sheet mentions `.brand` only in a non-selector position; none COVERS a
    // `.brand` toggle, so the honest note must fire (authorRulesMissing) rather
    // than be suppressed by a raw substring match.
    for (const sheet of [
      "/* .brand palette */ .other{color:red}", // comment
      '.other{content:".brand"}', // declaration-value string
      ".other{background:url(/img/brand-.brand.png)}", // url() inside a value
      "@import url('.brand.css');.other{x:1}", // at-rule payload
    ]) {
      expect(gateAuthorsheet(setClass(["brand"]), sheet).authorRulesMissing).toBe(true);
    }
    // A genuine selector prelude — even nested inside @media — DOES cover it.
    expect(
      gateAuthorsheet(setClass(["brand"]), "@media (min-width:1px){.brand{color:red}}")
        .authorRulesMissing,
    ).toBe(false);
  });

  test("token-boundary: a longer attr key is NOT covered ([data-theme-extra] ≠ data-theme)", () => {
    expect(gateAuthorsheet(setAttr("data-theme"), "[data-theme-extra]{color:red}")).toEqual({
      append: false,
      authorRulesMissing: true,
    });
    for (const sheet of ["[data-theme]{x:1}", "[data-theme=dark]{x:1}", "[data-theme~='a']{x:1}"]) {
      expect(gateAuthorsheet(setAttr("data-theme"), sheet).authorRulesMissing).toBe(false);
    }
  });
});
