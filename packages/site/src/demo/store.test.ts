// The demo's local thread store: what a visitor's acts and the demo agent's
// answers do to an interaction, and that none of it leaves memory.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { BlockAnchor, Variant } from "../overlay/model";
import { createStore, type DemoStore, SELF } from "./store";

const HEADLINE: BlockAnchor = {
  selector: "#headline",
  label: "Put agent work where it belongs.",
  target: "h1#headline",
  prepared: "headline",
};
const PARA: BlockAnchor = { selector: "body > p:nth-of-type(1)", label: "A line", target: "p" };
const VARIANTS: Variant[] = [
  { id: "v1", label: "One", program: [{ op: "setText", target: ":scope", text: "One" }] },
  { id: "v2", label: "Two", program: [{ op: "setText", target: ":scope", text: "Two" }] },
];
const prefix = (i: number, n: number, label: string) => `Variant ${i}/${n} — ${label}:`;

let store: DemoStore;
let clock = 1_000;
let ids = 0;
beforeEach(() => {
  clock = 1_000;
  ids = 0;
  store = createStore({ now: () => clock, id: () => `id-${++ids}` });
});

describe("a Comment", () => {
  test("is the visitor's first message on the block, open and waiting on no one", () => {
    const item = store.comment(PARA, "Is this the right line?");
    expect(item.kind).toBe("comment");
    expect(item.state).toBe("open");
    expect(item.anchor).toEqual(PARA);
    expect(item.thread.map((m) => [m.authorId, m.text])).toEqual([
      [SELF, "Is this the right line?"],
    ]);
    expect(item.agentWork).toBeUndefined();
    expect(store.needsYou()).toBe(0);
  });

  test("replies, reactions, edits and deletes are the visitor's own", () => {
    const item = store.comment(PARA, "First");
    store.reply(item.id, "Second", (item.thread[0] as { id: string }).id);
    const [first, second] = store.get(item.id)?.thread ?? [];
    expect(second?.replyTo).toBe(first?.id as string);

    store.react(item.id, first?.id as string, "👍", true);
    expect(store.get(item.id)?.thread[0]?.reactions).toEqual({ "👍": [SELF] });
    store.react(item.id, first?.id as string, "👍", false);
    expect(store.get(item.id)?.thread[0]?.reactions).toEqual({});

    clock = 2_000;
    store.editMsg(item.id, first?.id as string, "First, revised");
    expect(store.get(item.id)?.thread[0]).toMatchObject({
      text: "First, revised",
      editedAt: 2_000,
    });
    store.deleteMsg(item.id, second?.id as string);
    expect(store.get(item.id)?.thread[1]).toMatchObject({ deleted: true, text: "" });
  });

  test("resolves and reopens: the thread outlives the resolution", () => {
    const item = store.comment(PARA, "Done?");
    store.resolve(item.id);
    expect(store.get(item.id)?.state).toBe("resolved");
    store.reply(item.id, "One more thing", null);
    expect(store.get(item.id)?.thread).toHaveLength(2);
    store.reopen(item.id);
    expect(store.get(item.id)?.state).toBe("open");
  });
});

describe("handing work to an agent", () => {
  test("@agent in a Comment makes agent work pending; a word that only contains it does not", () => {
    const handed: string[] = [];
    store.onHandOff((id, why) => handed.push(`${id}:${why}`));
    const a = store.comment(PARA, "@agent could this be shorter?");
    const b = store.comment(PARA, "mail me at someone@agents.example");
    const c = store.comment(PARA, "```\n@agent inside code\n```");
    expect(store.get(a.id)?.agentWork).toBe("pending");
    expect(store.get(b.id)?.agentWork).toBeUndefined();
    expect(store.get(c.id)?.agentWork).toBeUndefined();
    expect(handed).toEqual([`${a.id}:mention`]);
    expect(store.agentPending()).toBe(1);
  });

  test("an Edit goes to an agent on its own", () => {
    const handed: string[] = [];
    store.onHandOff((id, why) => handed.push(`${id}:${why}`));
    const item = store.edit(HEADLINE, { intent: "Plainer words", method: "direct", count: 3 });
    expect(item.kind).toBe("change");
    expect(item.state).toBe("open");
    expect(item.agentWork).toBe("pending");
    expect(handed).toEqual([`${item.id}:edit`]);
  });

  test("pending, then taken, then answered; an answer waits on the requester", () => {
    const item = store.comment(PARA, "@agent thoughts?");
    store.take(item.id);
    expect(store.get(item.id)?.agentWork).toBe("taken");
    expect(store.agentPending()).toBe(0);
    store.agentReply(item.id, "Here.");
    const now = store.get(item.id);
    expect(now?.agentWork).toBe("answered");
    expect(now?.needsYou).toBe(true);
    // The agent acts as its person: same author, marked.
    expect(now?.thread[1]).toMatchObject({ authorId: SELF, agent: true, text: "Here." });
    expect(store.needsYou()).toBe(1);
    // The visitor's own act pays the debt.
    store.reply(item.id, "Thanks.", null);
    expect(store.needsYou()).toBe(0);
  });

  test("an agent's message is never the visitor's to edit or delete", () => {
    const item = store.comment(PARA, "@agent hi");
    store.agentReply(item.id, "Answer");
    const reply = store.get(item.id)?.thread[1];
    store.editMsg(item.id, reply?.id as string, "tampered");
    store.deleteMsg(item.id, reply?.id as string);
    expect(store.get(item.id)?.thread[1]).toMatchObject({ text: "Answer", agent: true });
  });
});

describe("Variants", () => {
  function edit(): string {
    const item = store.edit(HEADLINE, { intent: "Plainer", method: "variant-set", count: 2 });
    store.take(item.id);
    store.postVariants(item.id, VARIANTS, true);
    return item.id;
  }

  test("posted variants put the Edit to work and show the first", () => {
    const id = edit();
    const item = store.get(id);
    expect(item?.state).toBe("working");
    expect(item?.change?.method).toBe("variant-set");
    expect(item?.variants).toMatchObject({ status: "previewing", shown: 0 });
    expect(item?.needsYou).toBe(true);
  });

  test("stepping goes through each variant, then the original, and round again", () => {
    const id = edit();
    const shown = (): number | null | undefined => store.get(id)?.variants?.shown;
    store.cycle(id, 1);
    expect(shown()).toBe(1);
    store.cycle(id, 1);
    expect(shown()).toBe(-1);
    store.cycle(id, 1);
    expect(shown()).toBe(0);
    store.cycle(id, -1);
    expect(shown()).toBe(-1);
    store.cycle(id, -1);
    expect(shown()).toBe(1);
  });

  test("a pick keeps that variant: the Edit is kept, and shown", () => {
    const id = edit();
    store.cycle(id, 1);
    store.pick(id);
    const item = store.get(id);
    expect(item?.state).toBe("kept");
    expect(item?.variants).toMatchObject({ status: "resolved", outcome: "picked", picked: 1 });
    expect(item?.needsYou).toBe(false);
    expect(store.keptShown()).toBe(1);
    store.setKept(id, false);
    expect(store.keptShown()).toBe(0);
    store.setKept(id, true);
    expect(store.keptShown()).toBe(1);
  });

  test("the original cannot be picked", () => {
    const id = edit();
    store.cycle(id, -1);
    store.pick(id);
    expect(store.get(id)?.variants?.status).toBe("previewing");
    expect(store.get(id)?.state).toBe("working");
  });

  test("a discard ends the set and leaves the Edit open", () => {
    const id = edit();
    store.discard(id);
    expect(store.get(id)?.variants).toMatchObject({ status: "resolved", outcome: "discarded" });
    expect(store.get(id)?.state).toBe("open");
    expect(store.keptShown()).toBe(0);
  });

  test("a comment on the showing variant is a reply that says which", () => {
    const id = edit();
    store.commentVariant(id, "tighter still?", prefix);
    expect(store.get(id)?.thread.at(-1)?.text).toBe("Variant 1/2 — One: tighter still?");
    store.commentVariant(id, "```css\na{}\n```", prefix);
    expect(store.get(id)?.thread.at(-1)?.text).toBe("Variant 1/2 — One:\n```css\na{}\n```");
  });

  test("resolving an Edit takes a set that is still on preview off the page", () => {
    const id = edit();
    store.resolve(id);
    expect(store.get(id)?.variants).toMatchObject({ status: "resolved", shown: null });
    expect(store.keptShown()).toBe(0);
  });

  test("a kept Edit that is resolved and reopened is kept again", () => {
    const id = edit();
    store.pick(id);
    store.resolve(id);
    expect(store.keptShown()).toBe(0);
    store.reopen(id);
    expect(store.get(id)?.state).toBe("kept");
    expect(store.keptShown()).toBe(1);
  });
});

describe("two Edits on one block", () => {
  const post = (anchor: BlockAnchor): string => {
    const item = store.edit(anchor, { intent: "x", method: "variant-set", count: 2 });
    store.postVariants(item.id, VARIANTS, true);
    return item.id;
  };
  const shown = (id: string): number | null | undefined => store.get(id)?.variants?.shown;

  test("only one set shows on a block: the one stepped last", () => {
    const a = post(HEADLINE);
    const b = post(HEADLINE);
    expect([shown(a), shown(b)]).toEqual([null, 0]);
    store.cycle(a, 1);
    expect([shown(a), shown(b)]).toEqual([0, null]);
    // stepping the one that let go takes the block back, from its first variant
    store.cycle(b, 1);
    expect([shown(a), shown(b)]).toEqual([null, 0]);
    store.cycle(a, 1);
    store.cycle(a, 1);
    store.cycle(a, 1);
    // even a set showing its original holds the block
    expect([shown(a), shown(b)]).toEqual([-1, null]);
  });

  test("a set that let go is still there to step, pick or discard", () => {
    const a = post(HEADLINE);
    const b = post(HEADLINE);
    expect(store.get(a)?.variants?.status).toBe("previewing");
    store.pick(a); // nothing showing: nothing to pick
    expect(store.get(a)?.state).toBe("working");
    store.cycle(a, 1);
    store.pick(a);
    expect(store.get(a)?.state).toBe("kept");
    expect(shown(b)).toBeNull();
  });

  test("a kept edit is not a preview: it stays when another Edit shows", () => {
    const a = post(HEADLINE);
    store.pick(a);
    const b = post(HEADLINE);
    expect(store.get(a)?.state).toBe("kept");
    expect(store.keptShown()).toBe(1);
    expect(shown(b)).toBe(0);
  });

  test("kept edits remember the order they were kept in", () => {
    const a = post(HEADLINE);
    const b = post(HEADLINE);
    store.pick(b);
    store.cycle(a, 1);
    store.pick(a);
    expect([store.get(b)?.keptAt, store.get(a)?.keptAt]).toEqual([1, 2]);
  });

  test("sets on different blocks do not take each other's place", () => {
    const a = post(HEADLINE);
    const b = post(PARA);
    expect([shown(a), shown(b)]).toEqual([0, 0]);
  });
});

describe("the rail's three steps", () => {
  test("tick as each is done, in any order", () => {
    expect(store.steps()).toEqual([false, false, false]);
    store.picked();
    expect(store.steps()).toEqual([true, false, false]);
    store.comment(PARA, "A thought");
    expect(store.steps()).toEqual([true, true, false]);
    expect(store.complete()).toBe(false);
    store.comment(PARA, "@agent and you?");
    expect(store.steps()).toEqual([true, true, true]);
    expect(store.complete()).toBe(true);
  });

  test("one Edit does the last two at once", () => {
    store.edit(HEADLINE, { intent: "x", method: "direct", count: 1 });
    expect(store.steps()).toEqual([false, true, true]);
  });

  test("Start over clears everything", () => {
    store.picked();
    store.edit(HEADLINE, { intent: "x", method: "direct", count: 1 });
    store.reset();
    expect(store.items()).toEqual([]);
    expect(store.steps()).toEqual([false, false, false]);
    expect(store.needsYou() + store.agentPending() + store.keptShown()).toBe(0);
  });
});

describe("subscribers", () => {
  test("hear every change, and stop when they ask", () => {
    let heard = 0;
    const off = store.subscribe(() => heard++);
    store.comment(PARA, "one");
    store.picked();
    expect(heard).toBe(2);
    off();
    store.comment(PARA, "two");
    expect(heard).toBe(2);
  });
});

describe("nothing is stored", () => {
  // The page says "Nothing is sent or stored": the store may not reach for
  // any storage or the network, whatever the visitor does.
  const touched: string[] = [];
  const trap = (name: string): object =>
    new Proxy(
      {},
      {
        get: (_t, key) => {
          touched.push(`${name}.${String(key)}`);
          return () => null;
        },
      },
    );
  const g = globalThis as Record<string, unknown>;
  const saved: Record<string, unknown> = {};
  beforeEach(() => {
    touched.length = 0;
    for (const name of ["localStorage", "sessionStorage", "indexedDB"]) {
      saved[name] = g[name];
      g[name] = trap(name);
    }
    saved.fetch = g.fetch;
    g.fetch = () => {
      touched.push("fetch");
      return Promise.reject(new Error("no network in the demo"));
    };
  });
  afterEach(() => {
    for (const [name, value] of Object.entries(saved)) {
      if (value === undefined) delete g[name];
      else g[name] = value;
    }
  });

  test("a whole visit touches no storage and makes no request", () => {
    const s = createStore({ now: () => 1, id: () => `n-${++ids}` });
    s.picked();
    const c = s.comment(PARA, "@agent hello");
    s.take(c.id);
    s.agentReply(c.id, "hi");
    const e = s.edit(HEADLINE, { intent: "x", method: "variant-set", count: 2 });
    s.postVariants(e.id, VARIANTS, true);
    s.cycle(e.id, 1);
    s.pick(e.id);
    s.setKept(e.id, false);
    s.resolve(c.id);
    s.reset();
    expect(touched).toEqual([]);
  });
});
