import { describe, expect, test } from "bun:test";
import { parseInbound } from "./parse";
import {
  fragmentRefusal,
  fragmentWorkBudget,
  readFragment,
  staticOpRefusal,
} from "./program-rules";
import { FRAGMENT_CASES, OP_CASES } from "./program-rules.cases";

describe("what a program may do, told without the page", () => {
  for (const c of FRAGMENT_CASES) {
    test(`fragment ${JSON.stringify(c.html)} → ${c.server ?? "the engine decides"}`, () => {
      expect(fragmentRefusal(c.html)).toBe(c.server);
    });
  }
  for (const c of OP_CASES) {
    test(`${c.op.op} ${JSON.stringify(c.op).slice(0, 90)} → ${c.server ?? "the page decides"}`, () => {
      expect(staticOpRefusal(c.op, c.page === true)).toBe(c.server as never);
    });
  }

  test("a fragment cut off inside a tag or a comment reads as the browser does", () => {
    expect(fragmentRefusal('<span title="never closed')).toBe("fragment-empty");
    expect(fragmentRefusal("<b>shown</b><!-- never closed <b>hidden</b>")).toBeNull();
    expect(fragmentRefusal("<!-- never closed <b>hidden</b>")).toBe("fragment-empty");
    expect(fragmentRefusal("<script>if (a < b) { x('</p>') }</script>")).toBe(
      "fragment-disallowed",
    );
  });
});

describe("the outcome report frame", () => {
  const frame = (extra: Record<string, unknown>) =>
    JSON.stringify({
      v: 1,
      type: "variant-outcome",
      setId: "s1",
      frameUrl: "https://shop.example/p/1",
      variantId: "v1",
      version: 2,
      steps: 12,
      applied: 9,
      refused: [
        { index: 0, reason: "fragment-empty" },
        { index: 4, reason: "target-missing" },
        { index: 7, reason: "target-missing" },
      ],
      ...extra,
    });

  test("integers and the closed reason set parse", () => {
    const r = parseInbound(frame({}));
    expect(r.ok).toBe(true);
    expect(parseInbound(frame({ applied: 0, refused: [], rootMissing: true })).ok).toBe(true);
  });

  test("free text, an unknown reason, a fractional or negative index are refused", () => {
    expect(parseInbound(frame({ refused: [{ index: 0, reason: "the page said so" }] })).ok).toBe(
      false,
    );
    expect(parseInbound(frame({ refused: [{ index: 1.5, reason: "target-missing" }] })).ok).toBe(
      false,
    );
    expect(parseInbound(frame({ refused: [{ index: -1, reason: "target-missing" }] })).ok).toBe(
      false,
    );
    expect(parseInbound(frame({ rootMissing: false })).ok).toBe(false);
    expect(parseInbound(frame({ steps: 9999 })).ok).toBe(false);
  });
});

describe("the fragment reading's work is linear and bounded (counted, not timed)", () => {
  const adversarial: Record<string, (n: number) => string> = {
    "deep nesting, then closing tags of names never opened": (n) =>
      "<div>".repeat(n) + "</span>".repeat(n),
    "closing tags of names open deep in the stack": (n) => "<b>".repeat(n) + "<i></b>".repeat(n),
    "many comments, none ending with --!>": (n) => "<!---->x".repeat(n),
    "raw text whose end tag never quite comes": (n) => `<script>${"</scriptx>".repeat(n)}`,
    "many raw-text elements": (n) => "<style>a</style>".repeat(n),
    "many bogus comments": (n) => "<!x>".repeat(n),
  };
  for (const [name, make] of Object.entries(adversarial)) {
    test(name, () => {
      const small = readFragment(make(400));
      const large = readFragment(make(1_600));
      // Within its budget, and four times the input costs about four times the work.
      expect(small.exhausted).toBe(false);
      expect(large.exhausted).toBe(false);
      expect(large.work).toBeLessThanOrEqual(fragmentWorkBudget(make(1_600).length));
      expect(large.work / small.work).toBeLessThan(5);
    });
  }

  test("a reading that reaches its budget lets the browser decide", () => {
    const r = readFragment('<span class="onlay-sink"></span>'.repeat(50), 64);
    expect(r).toMatchObject({ verdict: null, exhausted: true });
  });
});
