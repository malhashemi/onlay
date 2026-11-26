// The demo agent: it takes what is handed to it, answers with Variants where
// it has them (the headline), and says honestly that it has none elsewhere.
import { beforeEach, describe, expect, test } from "bun:test";
import type { BlockAnchor } from "../overlay/model";
import { createAgent, type DemoAgent } from "./agent";
import { preparedVariants } from "./programs";
import { createStore, type DemoStore } from "./store";

const HEADLINE: BlockAnchor = {
  selector: "#headline",
  label: "Put agent work where it belongs.",
  target: "h1#headline",
  prepared: "headline",
};
const OTHER: BlockAnchor = { selector: "body > p:nth-of-type(2)", label: "A line", target: "p" };
const WORDS = { variants: "Posted Variants.", other: "Only the headline has Variants here." };

/** Timers the test runs by hand. */
function fakeTimers() {
  let at = 0;
  let seq = 0;
  const due = new Map<number, { when: number; fn: () => void }>();
  return {
    setTimeout(fn: () => void, ms: number): unknown {
      due.set(++seq, { when: at + ms, fn });
      return seq;
    },
    clearTimeout(handle: unknown): void {
      due.delete(handle as number);
    },
    advance(ms: number): void {
      const until = at + ms;
      for (;;) {
        const next = [...due]
          .filter(([, t]) => t.when <= until)
          .sort((x, y) => x[1].when - y[1].when)[0];
        if (!next) break;
        due.delete(next[0]);
        at = next[1].when;
        next[1].fn();
      }
      at = until;
    },
    pending: () => due.size,
  };
}

let store: DemoStore;
let agent: DemoAgent;
let timers: ReturnType<typeof fakeTimers>;
let ids = 0;
let inView = true;
beforeEach(() => {
  ids = 0;
  inView = true;
  timers = fakeTimers();
  store = createStore({ now: () => 1, id: () => `id-${++ids}` });
  agent = createAgent({
    store,
    prepared: preparedVariants,
    words: WORDS,
    previewNow: () => inView,
    setTimeout: timers.setTimeout,
    clearTimeout: timers.clearTimeout,
    takeMs: 100,
    workMs: 300,
  });
});

describe("an Edit on the headline", () => {
  test("is taken, then answered with Variants and one tagged message", () => {
    const item = store.edit(HEADLINE, { intent: "Plainer", method: "variant-set", count: 3 });
    expect(store.get(item.id)?.agentWork).toBe("pending");
    timers.advance(100);
    expect(store.get(item.id)?.agentWork).toBe("taken");
    timers.advance(300);
    const now = store.get(item.id);
    expect(now?.agentWork).toBe("answered");
    expect(now?.variants?.variants.map((v) => v.id)).toEqual([
      "headline-1",
      "headline-2",
      "headline-3",
    ]);
    expect(now?.variants?.shown).toBe(0);
    expect(now?.thread).toHaveLength(1);
    expect(now?.thread[0]).toMatchObject({ agent: true, text: WORDS.variants });
  });

  test("answers a Direct request with Variants too, and honors the count", () => {
    const one = store.edit(HEADLINE, { intent: "x", method: "direct", count: 1 });
    timers.advance(400);
    expect(store.get(one.id)?.variants?.variants).toHaveLength(1);
    expect(store.get(one.id)?.change?.method).toBe("variant-set");
    const five = store.edit(HEADLINE, { intent: "x", method: "variant-set", count: 5 });
    timers.advance(400);
    expect(store.get(five.id)?.variants?.variants).toHaveLength(3);
  });

  test("leaves the page alone when the headline is out of view", () => {
    inView = false;
    const item = store.edit(HEADLINE, { intent: "x", method: "variant-set", count: 3 });
    timers.advance(400);
    expect(store.get(item.id)?.variants?.shown).toBeNull();
  });

  test("one more variant can be asked for until the prepared ones run out", () => {
    const item = store.edit(HEADLINE, { intent: "x", method: "variant-set", count: 1 });
    timers.advance(400);
    expect(agent.hasMore(item.id)).toBe(true);
    store.askMore(item.id);
    expect(agent.hasMore(item.id)).toBe(false);
    timers.advance(400);
    expect(store.get(item.id)?.variants?.variants).toHaveLength(2);
    expect(store.get(item.id)?.variants?.shown).toBe(1);
    store.askMore(item.id);
    timers.advance(400);
    expect(store.get(item.id)?.variants?.variants).toHaveLength(3);
    expect(agent.hasMore(item.id)).toBe(false);
  });
});

describe("everything else", () => {
  test("an Edit on another block gets the honest line, and no Variants", () => {
    const item = store.edit(OTHER, { intent: "x", method: "variant-set", count: 3 });
    timers.advance(400);
    const now = store.get(item.id);
    expect(now?.variants).toBeUndefined();
    expect(now?.state).toBe("open");
    expect(now?.thread[0]).toMatchObject({ agent: true, text: WORDS.other });
    expect(now?.needsYou).toBe(true);
  });

  test("@agent in a Comment gets the honest line, on the headline too", () => {
    const a = store.comment(OTHER, "@agent thoughts?");
    const b = store.comment(HEADLINE, "@agent thoughts?");
    timers.advance(400);
    for (const id of [a.id, b.id]) {
      expect(store.get(id)?.thread.at(-1)).toMatchObject({ agent: true, text: WORDS.other });
      expect(store.get(id)?.variants).toBeUndefined();
    }
  });

  test("a thread resolved before the agent answers gets no answer", () => {
    const item = store.comment(OTHER, "@agent thoughts?");
    timers.advance(100);
    store.resolve(item.id);
    timers.advance(300);
    expect(store.get(item.id)?.thread).toHaveLength(1);
  });

  test("Start over drops what was in flight", () => {
    store.comment(OTHER, "@agent thoughts?");
    agent.stop();
    store.reset();
    expect(timers.pending()).toBe(0);
    timers.advance(1_000);
    expect(store.items()).toEqual([]);
  });
});
