import { describe, expect, test } from "bun:test";
import { computeAttention, needsActor } from "./attention";
import {
  addMessage,
  answerAsk,
  createInteraction,
  type InteractionState,
  react,
  resolveInteraction,
  setChangeState,
} from "./interaction";

const T0 = 1_750_000_000_000;
const WINDOW = 172_800_000;
const URL_ = "http://127.0.0.1:8125/p";

function make(kind: "comment" | "ask" | "change", id: string, authorId: string): InteractionState {
  const r = createInteraction(
    {
      id,
      kind,
      url: URL_,
      expectUrlPrefix: URL_,
      anchor: { level: "page" },
      authorId,
      ...(kind === "comment" ? { body: { text: "root" } } : {}),
      ...(kind === "ask"
        ? {
            ask: {
              question: "q",
              context: "c",
              waitingOn: ["you"],
              selection: { min: 1, max: 1, submit: "immediate" as const },
              options: [{ id: "yes", label: "Yes" }],
            },
          }
        : {}),
      ...(kind === "change" ? { change: { intent: "warmer", routesTo: "agent" } } : {}),
    },
    T0,
  );
  if (!r.ok) throw new Error("create");
  return r.state;
}

describe("needsActor", () => {
  test("open ask needs its addressee; answered ask needs its asker", () => {
    const a = make("ask", "a1", "archsmith");
    expect(needsActor(a, "you")).toBe("waiting-on");
    expect(needsActor(a, "archsmith")).toBeNull();
    const answered = answerAsk(a, { actorId: "you", optionIds: ["yes"] }, [], T0 + 1).state;
    expect(needsActor(answered, "you")).toBeNull();
    expect(needsActor(answered, "archsmith")).toBe("waiting-on");
  });

  test("change needs routesTo while working; requester while verifying", () => {
    let c = make("change", "c1", "you");
    expect(needsActor(c, "agent")).toBe("waiting-on");
    c = setChangeState(c, "working", T0 + 1).state;
    c = setChangeState(c, "verifying", T0 + 2).state;
    expect(needsActor(c, "you")).toBe("verify");
    expect(needsActor(c, "agent")).toBeNull();
  });

  test("comment needs its author when someone else spoke last; mention needs the mentioned", () => {
    let cm = make("comment", "m1", "sara");
    expect(needsActor(cm, "sara")).toBeNull(); // sara spoke last
    cm = addMessage(
      cm,
      {
        authorId: "you",
        body: { text: "ping {0}", tokens: [{ t: "actor", actorId: "archsmith" }] },
      },
      500,
      T0 + 1,
    ).state;
    expect(needsActor(cm, "sara")).toBe("thread-reply");
    expect(needsActor(cm, "archsmith")).toBe("mentioned");
    // a reaction from sara counts as having seen the thread
    const reacted = react(cm, { msgId: "m2", actorId: "sara", emoji: "👀", on: true });
    expect(needsActor(reacted, "sara")).toBeNull();
  });

  test("resolved interactions need nobody", () => {
    const done = resolveInteraction(make("comment", "d1", "sara"), "sara", "human", T0 + 5).state;
    expect(needsActor(done, "sara")).toBeNull();
  });
});

describe("computeAttention", () => {
  test("unanchored asks flow into needs-you like anchored asks", () => {
    const r = createInteraction(
      {
        id: "ua1",
        kind: "ask",
        url: "",
        expectUrlPrefix: "",
        anchor: { level: "unanchored" },
        authorId: "archsmith",
        ask: {
          question: "Pick a lane?",
          context: "No page yet.",
          waitingOn: ["you"],
          selection: { min: 1, max: 1, submit: "immediate" },
          options: [{ id: "foundation", label: "Foundation" }],
        },
      },
      T0,
    );
    if (!r.ok) throw new Error("create");
    const sets = computeAttention([r.state], "you", T0 + 1, WINDOW);
    expect(sets.needsYou.map((row) => row.interaction.id)).toEqual(["ua1"]);
  });

  test("buckets split needs-you / waiting / recent with correct ordering", () => {
    const askOld = make("ask", "old", "archsmith");
    const askNew = { ...make("ask", "new", "archsmith"), createdAt: T0 + 10 };
    const yourChange = setChangeState(make("change", "ch", "you"), "working", T0 + 1).state;
    const resolved = resolveInteraction(
      make("comment", "rc", "you"),
      "you",
      "human",
      T0 + 20,
    ).state;
    const ancient = {
      ...resolveInteraction(make("comment", "az", "you"), "you", "human", T0).state,
      resolvedAt: T0 - WINDOW - 1,
    };

    const sets = computeAttention(
      [askNew, askOld, yourChange, resolved, ancient],
      "you",
      T0 + 30,
      WINDOW,
    );
    expect(sets.needsYou.map((r) => r.interaction.id)).toEqual(["old", "new"]); // oldest debt first
    expect(sets.waiting.map((r) => r.interaction.id)).toEqual(["ch"]); // agent is needed, you wait
    expect(sets.recent.map((s) => s.id)).toEqual(["rc"]); // window filtered
  });

  test("an open interaction you authored stays in waiting even when nobody is needed (F7)", () => {
    // An untagged comment: author is the only participant, needsActor is null
    // for everyone — before F7 it appeared in NO bucket and vanished from its
    // own author's inbox the moment it was posted.
    const untagged = make("comment", "mine", "you");
    const sets = computeAttention([untagged], "you", T0 + 5, WINDOW);
    expect(sets.needsYou).toEqual([]);
    expect(sets.waiting.map((r) => r.interaction.id)).toEqual(["mine"]);
    // Other participants (none here) and strangers still see nothing.
    expect(computeAttention([untagged], "someone-else", T0 + 5, WINDOW).waiting).toEqual([]);
  });

  test("authored-only continuity rows sort AFTER genuine waited-on rows (cap eviction order)", () => {
    // The server slices waiting to MAX_ATTENTION_ROWS — authored-open filler
    // must never evict an interaction that actually waits on another actor,
    // no matter how much newer the filler is.
    const genuine = setChangeState(make("change", "ch-old", "you"), "working", T0 + 1).state;
    const fillers = Array.from({ length: 3 }, (_, i) => ({
      ...make("comment", `own-${i}`, "you"),
      createdAt: T0 + 100 + i,
    }));
    const sets = computeAttention([...fillers, genuine], "you", T0 + 200, WINDOW);
    expect(sets.waiting[0]?.interaction.id).toBe("ch-old"); // needed row leads despite age
    expect(sets.waiting.slice(1).map((r) => r.interaction.id)).toEqual(["own-2", "own-1", "own-0"]);
  });
});
