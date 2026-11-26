import { describe, expect, test } from "bun:test";
import { ANCHOR_LOSS_THRESHOLD, stepLossCounters } from "./anchor-loss";

const set = (...ids: string[]) => new Set(ids);

describe("stepLossCounters", () => {
  test("fires exactly once, after THRESHOLD consecutive misses", () => {
    let counts = new Map<string, number>();
    const present = set("a");
    for (let i = 1; i < ANCHOR_LOSS_THRESHOLD; i++) {
      const step = stepLossCounters(counts, set("a"), present);
      expect(step.fire).toEqual([]);
      counts = step.next;
    }
    const final = stepLossCounters(counts, set("a"), present);
    expect(final.fire).toEqual(["a"]);
  });

  test("a resolving pass resets the counter (no fire)", () => {
    let counts = new Map<string, number>();
    counts = stepLossCounters(counts, set("a"), set("a")).next; // miss 1
    counts = stepLossCounters(counts, set(), set("a")).next; // resolved → reset
    const step = stepLossCounters(counts, set("a"), set("a")); // miss 1 again
    expect(step.fire).toEqual([]);
    expect(step.next.get("a")).toBe(1);
  });

  test("ids that leave the present set are dropped", () => {
    const counts = new Map([["gone", 2]]);
    const step = stepLossCounters(counts, set(), set("here"));
    expect(step.next.has("gone")).toBe(false);
    expect(step.next.get("here")).toBe(0);
  });

  test("only fires the ids that crossed the threshold this pass", () => {
    const counts = new Map([
      ["a", ANCHOR_LOSS_THRESHOLD - 1],
      ["b", 0],
    ]);
    const step = stepLossCounters(counts, set("a", "b"), set("a", "b"));
    expect(step.fire).toEqual(["a"]);
  });
});
