import { describe, expect, test } from "bun:test";
import { type OutcomeDeps, outcomeLine, outcomeOf, reportVariantOutcome } from "./variant-outcome";

function deps(over: Partial<OutcomeDeps> = {}): OutcomeDeps & { sent: Record<string, unknown>[] } {
  const sent: Record<string, unknown>[] = [];
  return {
    sent,
    selfId: () => "p_ada",
    account: () => "p_ada|https://app.onlay.dev",
    ownsEdit: () => true,
    frameUrl: () => "https://shop.example/p/1",
    send: async (frame) => {
      sent.push(frame);
      return { ok: true };
    },
    ...over,
  };
}

const target = (variantId: string, by = "p_ada") => ({
  setId: "set-1",
  spaceId: "s_1",
  changeInteractionId: "edit-1",
  variant: { variantId, version: 1, by },
});

describe("the outcome report", () => {
  test("the author reports their own variant once per version, integers and codes only", () => {
    const d = deps();
    const outcome = outcomeOf(
      {
        ok: true,
        token: 1,
        applied: 9,
        refused: [
          { index: 0, reason: "fragment-empty" },
          { index: 4, reason: "target-missing" },
        ],
      },
      12,
    );
    expect(reportVariantOutcome(d, target("v-once"), outcome)).toBe(true);
    expect(reportVariantOutcome(d, target("v-once"), outcome)).toBe(false);
    expect(d.sent).toHaveLength(1);
    expect(d.sent[0]).toMatchObject({
      type: "variant-outcome",
      setId: "set-1",
      spaceId: "s_1",
      variantId: "v-once",
      version: 1,
      steps: 12,
      applied: 9,
      refused: [
        { index: 0, reason: "fragment-empty" },
        { index: 4, reason: "target-missing" },
      ],
    });
  });

  test("nobody else's variant, no Edit this tab doesn't hold, nothing while signed out", () => {
    const o = outcomeOf({ ok: false, reason: "target-missing" }, 3);
    expect(reportVariantOutcome(deps(), target("v-other", "p_bea"), o)).toBe(false);
    expect(reportVariantOutcome(deps({ ownsEdit: () => false }), target("v-notmine"), o)).toBe(
      false,
    );
    expect(reportVariantOutcome(deps({ account: () => null }), target("v-out"), o)).toBe(false);
    const d = deps();
    expect(reportVariantOutcome(d, target("v-root"), o)).toBe(true);
    expect(d.sent[0]).toMatchObject({ applied: 0, refused: [], rootMissing: true });
  });
});

describe("the panel's line", () => {
  test("says how many steps couldn't be applied, by kind, in plain words", () => {
    expect(
      outcomeLine({
        steps: 12,
        applied: 9,
        refused: [
          { index: 0, reason: "fragment-empty" },
          { index: 4, reason: "target-missing" },
          { index: 7, reason: "target-missing" },
        ],
      }),
    ).toBe(
      "3 of 12 steps couldn't be applied: 2 target parts of the block that aren't on this page; 1 inserts nothing that shows.",
    );
    expect(
      outcomeLine({ steps: 2, applied: 1, refused: [{ index: 1, reason: "url-origin" }] }),
    ).toBe("1 of 2 steps couldn't be applied: 1 isn't allowed on a live page.");
    expect(outcomeLine({ steps: 2, applied: 2, refused: [] })).toBe("");
    expect(outcomeLine({ steps: 2, applied: 0, refused: [], rootMissing: true })).toBe(
      "The block these variants change isn't on this page right now.",
    );
  });
});
