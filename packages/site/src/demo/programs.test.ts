// The demo agent's Variants are real mutation programs: valid by the
// protocol's schema, and applied by the product's own engine.
import { describe, expect, test } from "bun:test";
import { MutationProgramSchema } from "@onlay/protocol";
import { applyProgramToRoot } from "@onlay/render";
import { Window } from "happy-dom";
import { COPY } from "../copy";
import { HEADLINE_LIGHT_CLASS, preparedVariants, sampleVariants } from "./programs";

describe("the headline's Variants", () => {
  const variants = preparedVariants("headline");

  test("three of them, each a valid block program", () => {
    expect(variants).toHaveLength(3);
    for (const v of variants) {
      expect(MutationProgramSchema.safeParse(v.program).success).toBe(true);
      expect(v.label.length).toBeGreaterThan(0);
    }
    expect(new Set(variants.map((v) => v.id)).size).toBe(3);
  });

  test("the two rewordings are the copywriter's other headlines, verbatim", () => {
    const texts = variants.flatMap((v) =>
      v.program.flatMap((op) => (op.op === "setText" ? [op.text] : [])),
    );
    expect(texts).toEqual([...COPY.hero.headlineAlternates]);
  });

  test("the engine applies each to the headline, and only to it", () => {
    const win = new Window({ url: "https://onlay.dev/" });
    const doc = win.document as unknown as Document;
    for (const v of variants) {
      doc.body.innerHTML = `<h1 id="headline">${COPY.hero.headline}</h1><p id="sub">Sub</p>`;
      const h1 = doc.querySelector("#headline") as Element;
      const result = applyProgramToRoot(h1, v.program);
      expect(result).toEqual({ applied: v.program.length, misses: 0, rejected: 0, refused: [] });
      expect(doc.querySelector("#sub")?.textContent).toBe("Sub");
    }
    doc.body.innerHTML = `<h1 id="headline">${COPY.hero.headline}</h1>`;
    const h1 = doc.querySelector("#headline") as Element;
    applyProgramToRoot(h1, variants[2]?.program ?? []);
    expect(h1.classList.contains(HEADLINE_LIGHT_CLASS)).toBe(true);
    expect(h1.textContent).toBe(COPY.hero.headline);
  });

  test("no other block has any", () => {
    expect(preparedVariants(undefined)).toEqual([]);
    expect(preparedVariants("lede")).toEqual([]);
  });
});

describe("the sample page's Variants", () => {
  test("are valid programs; the one that inserts nothing applies outside a browser too", () => {
    const win = new Window({ url: "https://onlay.dev/" });
    const doc = win.document as unknown as Document;
    const [highlighted, badge] = sampleVariants();
    for (const v of [highlighted, badge]) {
      expect(MutationProgramSchema.safeParse(v?.program).success).toBe(true);
    }
    doc.body.innerHTML = `<div id="plan"><p class="mini-plan-name">Team</p><p>Twelve dollars</p></div>`;
    const plan = doc.querySelector("#plan") as Element;
    const result = applyProgramToRoot(plan, highlighted?.program ?? []);
    expect(result).toEqual({ applied: 2, misses: 0, rejected: 0, refused: [] });
    expect(plan.classList.contains("is-highlighted")).toBe(true);
    expect(plan.querySelector(".mini-plan-name")?.textContent).toBe("Team · most popular");
    // The other inserts a fragment into the plan's name (parsed by the page's own parser).
    expect(badge?.program).toEqual([
      {
        op: "insertFragment",
        target: ".mini-plan-name",
        position: "append",
        html: '<span class="mini-badge">Most popular</span>',
      },
    ]);
  });
});
