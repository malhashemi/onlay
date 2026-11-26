import { describe, expect, test } from "bun:test";
import type { ElementContext, MutationProgram } from "@onlay/protocol";
import {
  addMessage,
  attachVariantSet,
  createInteraction,
  encodeInteractionEntry,
  type InteractionCreateInput,
  type InteractionState,
  pickEdit,
  replayInteractions,
  resolveInteraction,
  sendBatch,
  setChangeState,
} from "./interaction";
import { keptProgramOf } from "./kept";
import {
  createVariantSet,
  discardSet,
  encodeVariantEntry,
  pickVariant,
  reopenSet,
  replayVariantSets,
  resolveSet,
  submitVariants,
  tuneVariant,
  type VariantSetState,
  variantSetRoot,
} from "./variant";

/** Picks the variant at `index` by its id and current version, as a person does. */
function pickIdx(s: VariantSetState, index: number, now: number) {
  const v = s.variants[index];
  return pickVariant(s, { variantId: v?.variantId ?? "", version: v?.version ?? 0 }, now);
}

const T0 = 1_750_000_000_000;
const URL_ = "https://example.com/pricing";
const MAX = 500;
const ADA = "p_adaadaadaadaadaadaad";

const element: ElementContext = {
  selector: "main > h1",
  tag: "h1",
  classes: [],
  textSnippet: "Pricing",
  markup: "<h1>Pricing</h1>",
};
const calm: MutationProgram = [{ op: "setText", target: ":scope", text: "Plans" }];
const loud: MutationProgram = [{ op: "setClass", target: ":scope", add: ["loud"], remove: [] }];

function edit(over: Partial<InteractionCreateInput> = {}): InteractionState {
  const r = createInteraction(
    {
      id: "e1",
      kind: "change",
      url: URL_,
      expectUrlPrefix: URL_,
      anchor: { level: "page" },
      authorId: ADA,
      change: { intent: "make it friendlier", method: "variant-set" },
      member: true,
      ...over,
    },
    T0,
  );
  if (!r.ok) throw new Error("create");
  return attachVariantSet(r.state, "vs-1");
}

/** The state without its agent work, as if no agent had been asked yet. */
function settled(s: InteractionState): InteractionState {
  const { agentWork: _work, ...rest } = s;
  return rest;
}

function setWithVariants(root?: VariantSetState["root"]): VariantSetState {
  const s = createVariantSet(
    {
      setId: "vs-1",
      expectUrlPrefix: URL_,
      command: "friendlier",
      count: 2,
      ...(root ? { root } : { element }),
      changeInteractionId: "e1",
    },
    T0,
  );
  return submitVariants(
    s,
    [
      { variantId: "a", label: "Calm", program: calm, version: 1, agent: true },
      { variantId: "b", label: "Loud", program: loud, version: 1, agent: true },
    ],
    T0 + 1,
  ).state;
}

describe("pick is keep", () => {
  test("on a page whose source is unknown, a pick keeps the Edit and its program", () => {
    const working = setChangeState(edit(), "working", T0 + 1).state;
    const picked = pickEdit(working, ADA, T0 + 2);
    expect(picked.changed && picked.state.state).toBe("kept");
    const set = pickIdx(setWithVariants(), 0, T0 + 2).state;
    expect(keptProgramOf(picked.state, set)).toEqual({
      interactionId: "e1",
      setId: "vs-1",
      variantId: "a",
      version: 1,
      root: { kind: "block", element },
      program: calm,
      by: ADA,
      at: T0 + 2,
      label: "Calm",
    });
  });

  test("on a page whose source is known, a pick sends the Edit to an agent", () => {
    const owned = edit({ change: { intent: "x", method: "variant-set", ownsSource: true } });
    const r = pickEdit(settled(owned), ADA, T0 + 2);
    expect(r.changed && r.state.state).toBe("working");
    expect(r.state.agentWork).toEqual({ status: "pending", requestedBy: ADA, requestedAt: T0 + 2 });
    // the pick applies while the agent works, and no longer once implemented
    const set = pickIdx(setWithVariants(), 1, T0 + 2).state;
    expect(keptProgramOf(r.state, set)?.program).toEqual(loud);
    const implemented = setChangeState(r.state, "implemented", T0 + 3).state;
    expect(keptProgramOf(implemented, set)).toBeNull();
  });

  test("a closed or finished Edit refuses a pick", () => {
    const resolved = resolveInteraction(edit(), ADA, "human", T0).state;
    expect(pickEdit(resolved, ADA, T0)).toMatchObject({ changed: false, reason: "closed" });
    const verifying = setChangeState(edit(), "verifying", T0).state;
    expect(pickEdit(verifying, ADA, T0)).toMatchObject({ changed: false, reason: "wrong-state" });
  });

  test("a kept Edit resolves (Remove), and its program stops applying", () => {
    const kept = pickEdit(edit(), ADA, T0 + 1).state;
    const set = pickIdx(setWithVariants(), 0, T0 + 1).state;
    const removed = resolveInteraction(kept, ADA, "human", T0 + 2);
    expect(removed.resolved && removed.state.state).toBe("resolved");
    expect(keptProgramOf(removed.state, set)).toBeNull();
  });

  test("@agent on a kept Edit asks for an agent and stays kept", () => {
    const kept = settled(pickEdit(edit(), ADA, T0 + 1).state);
    const r = addMessage(
      kept,
      { authorId: ADA, body: { text: "@agent more", tokens: [{ t: "agent" }] }, member: true },
      MAX,
      T0 + 2,
    );
    expect(r.state.state).toBe("kept");
    expect(r.state.agentWork?.status).toBe("pending");
  });

  test("new variants on a kept Edit: the set reopens, the Edit works, the old pick still shows", () => {
    const kept = pickEdit(edit(), ADA, T0 + 1).state;
    const picked = pickIdx(setWithVariants(), 0, T0 + 1).state;
    const reopened = reopenSet(picked, T0 + 2);
    expect(reopened.ok && reopened.state.status).toBe("previewing");
    const more = submitVariants(
      reopened.state,
      [{ variantId: "c", label: "Warm", program: loud, version: 1, agent: true }],
      T0 + 3,
    );
    expect(more.ok).toBe(true);
    const working = setChangeState(kept, "working", T0 + 3);
    expect(working.changed).toBe(true);
    expect(keptProgramOf(working.state, more.state)?.label).toBe("Calm");
    // a re-pick keeps the new program
    const repicked = pickEdit(working.state, ADA, T0 + 4).state;
    const set = pickIdx(more.state, 2, T0 + 4).state;
    expect(keptProgramOf(repicked, set)).toMatchObject({ label: "Warm", at: T0 + 4 });
  });

  test("only a picked set reopens", () => {
    expect(reopenSet(setWithVariants(), T0).ok).toBe(false);
    expect(reopenSet(discardSet(setWithVariants(), T0).state, T0).ok).toBe(false);
  });
});

describe("hand-made batches", () => {
  const batchEdit = (ownsSource: boolean) =>
    createInteraction(
      {
        id: "b1",
        kind: "change",
        url: URL_,
        expectUrlPrefix: URL_,
        anchor: { level: "page" },
        authorId: ADA,
        change: { intent: "tidy the header", method: "manual-batch", ownsSource },
        batch: calm,
        member: true,
      },
      T0,
    );

  test("on an unowned page the batch is kept at once, rooted at the page", () => {
    const r = batchEdit(false);
    if (!r.ok) throw new Error("create");
    expect(r.state.state).toBe("kept");
    expect(r.state.agentWork).toBeUndefined();
    expect(keptProgramOf(r.state, undefined)).toEqual({
      interactionId: "b1",
      root: { kind: "page" },
      program: calm,
      by: ADA,
      at: T0,
      label: "tidy the header",
    });
  });

  test("on an owned page the batch opens with agent work pending, applied once working", () => {
    const r = batchEdit(true);
    if (!r.ok) throw new Error("create");
    expect(r.state.state).toBe("open");
    expect(r.state.agentWork?.status).toBe("pending");
    expect(keptProgramOf(r.state, undefined)).toBeNull();
    const working = setChangeState(r.state, "working", T0 + 1).state;
    expect(keptProgramOf(working, undefined)?.program).toEqual(calm);
  });

  test("a batch outside a manual-batch Edit is refused", () => {
    const r = createInteraction(
      {
        id: "x",
        kind: "change",
        url: URL_,
        expectUrlPrefix: URL_,
        anchor: { level: "page" },
        authorId: ADA,
        change: { intent: "x", method: "direct" },
        batch: calm,
      },
      T0,
    );
    expect(r).toEqual({ ok: false, reason: "payload-mismatch" });
  });
});

describe("variant roots and coexistence", () => {
  test("a set may be rooted at the whole page", () => {
    const page = setWithVariants({ kind: "page" });
    expect(variantSetRoot(page)).toEqual({ kind: "page" });
    const kept = pickEdit(edit(), ADA, T0 + 1).state;
    expect(keptProgramOf(kept, pickIdx(page, 1, T0 + 1).state)?.root).toEqual({ kind: "page" });
  });

  test("legacy element-only sets read as block roots; pre-root sets have none", () => {
    expect(variantSetRoot(setWithVariants())).toEqual({ kind: "block", element });
    const bare = createVariantSet(
      { setId: "old", expectUrlPrefix: URL_, command: "x", count: 1 },
      T0,
    );
    expect(variantSetRoot(bare)).toBeNull();
  });

  test("two live sets on one page are independent", () => {
    const one = setWithVariants();
    const two = { ...setWithVariants({ kind: "page" }), setId: "vs-2" };
    const pickedOne = pickIdx(one, 0, T0 + 2).state;
    expect(two.status).toBe("previewing");
    expect(discardSet(two, T0 + 3).state.outcome).toBe("discarded");
    expect(pickedOne.outcome).toBe("picked");
  });

  test("the kept program ignores a set that is not the Edit's", () => {
    const kept = pickEdit(edit(), ADA, T0 + 1).state;
    const other = { ...pickIdx(setWithVariants(), 0, T0 + 1).state, setId: "vs-9" };
    expect(keptProgramOf(kept, other)).toBeNull();
  });
});

describe("journal replay", () => {
  test("a pick replays to the same kept Edit", () => {
    const input: InteractionCreateInput = {
      id: "e1",
      kind: "change",
      url: URL_,
      expectUrlPrefix: URL_,
      anchor: { level: "page" },
      authorId: ADA,
      change: { intent: "make it friendlier", method: "variant-set" },
      member: true,
    };
    const lines = [
      encodeInteractionEntry({ k: "int-create", ts: T0, ...input }),
      encodeInteractionEntry({ k: "int-attach-set", ts: T0, id: "e1", setId: "vs-1" }),
      encodeInteractionEntry({ k: "int-state", ts: T0 + 1, id: "e1", state: "working" }),
      encodeInteractionEntry({ k: "int-pick", ts: T0 + 2, id: "e1", actorId: ADA }),
    ];
    const live = pickEdit(setChangeState(edit(), "working", T0 + 1).state, ADA, T0 + 2).state;
    expect(replayInteractions(lines, MAX).get("e1")).toEqual(live);
  });

  test("a hand-made batch replays from its creation entry", () => {
    const input: InteractionCreateInput = {
      id: "b1",
      kind: "change",
      url: URL_,
      expectUrlPrefix: URL_,
      anchor: { level: "page" },
      authorId: ADA,
      change: { intent: "tidy", method: "manual-batch", ownsSource: false, provenance: "o@s;m;c" },
      batch: calm,
      member: true,
    };
    const r = createInteraction(input, T0);
    if (!r.ok) throw new Error("create");
    const lines = [encodeInteractionEntry({ k: "int-create", ts: T0, ...input })];
    expect(replayInteractions(lines, MAX).get("b1")).toEqual(r.state);
  });

  test("page roots, agent marks and reopened sets replay", () => {
    let s = createVariantSet(
      { setId: "vs-1", expectUrlPrefix: URL_, command: "c", count: 1, root: { kind: "page" } },
      T0,
    );
    const variants = [{ variantId: "a", label: "A", program: calm, version: 1, agent: true }];
    s = submitVariants(s, variants, T0 + 1).state;
    s = pickIdx(s, 0, T0 + 2).state;
    s = reopenSet(s, T0 + 3).state;
    const lines = [
      encodeVariantEntry({
        k: "variant-set-create",
        ts: T0,
        setId: "vs-1",
        expectUrlPrefix: URL_,
        command: "c",
        count: 1,
        root: { kind: "page" },
      }),
      encodeVariantEntry({ k: "variant-generated", ts: T0 + 1, setId: "vs-1", variants }),
      encodeVariantEntry({ k: "variant-picked", ts: T0 + 2, setId: "vs-1", index: 0 }),
      encodeVariantEntry({ k: "variant-reopened", ts: T0 + 3, setId: "vs-1" }),
    ];
    expect(replayVariantSets(lines).get("vs-1")).toEqual(s);
  });
});

describe("batches sent from the Edit page tray", () => {
  const trayEdit = (ownsSource: boolean) => {
    const r = createInteraction(
      {
        id: "t1",
        kind: "change",
        url: URL_,
        expectUrlPrefix: URL_,
        anchor: { level: "page" },
        authorId: ADA,
        change: { intent: "tidy", method: "manual-batch", ownsSource },
        member: true,
        requestAgent: false,
      },
      T0,
    );
    if (!r.ok) throw new Error("create");
    return r.state;
  };

  test("on an unowned page the sent batch keeps the Edit at once", () => {
    const r = sendBatch(trayEdit(false), { actorId: ADA, ops: calm, member: true }, T0 + 1);
    if (!r.sent) throw new Error("send");
    expect(r.state.state).toBe("kept");
    expect(r.state.agentWork).toBeUndefined();
    expect(keptProgramOf(r.state, undefined)?.program).toEqual(calm);
  });

  test("on an owned page the Edit stays open with agent work pending", () => {
    const r = sendBatch(trayEdit(true), { actorId: ADA, ops: calm, member: true }, T0 + 1);
    if (!r.sent) throw new Error("send");
    expect(r.state.state).toBe("open");
    expect(r.state.agentWork?.status).toBe("pending");
    expect(keptProgramOf(r.state, undefined)).toBeNull();
  });

  test("a guest's batch on an owned page asks for no agent; a closed Edit refuses", () => {
    expect(
      sendBatch(trayEdit(true), { actorId: ADA, ops: calm }, T0 + 1).state.agentWork,
    ).toBeUndefined();
    const closed = resolveInteraction(trayEdit(false), ADA, "human", T0 + 1).state;
    expect(sendBatch(closed, { actorId: ADA, ops: calm }, T0 + 2)).toMatchObject({
      sent: false,
      reason: "closed",
    });
  });

  test("a sent batch replays", () => {
    const live = sendBatch(trayEdit(false), { actorId: ADA, ops: loud, member: true }, T0 + 1);
    const lines = [
      encodeInteractionEntry({
        k: "int-create",
        ts: T0,
        id: "t1",
        kind: "change",
        url: URL_,
        expectUrlPrefix: URL_,
        anchor: { level: "page" },
        authorId: ADA,
        change: { intent: "tidy", method: "manual-batch", ownsSource: false },
        member: true,
        requestAgent: false,
      }),
      encodeInteractionEntry({
        k: "int-send-batch",
        ts: T0 + 1,
        id: "t1",
        actorId: ADA,
        ops: loud,
        member: true,
      }),
    ];
    expect(replayInteractions(lines, MAX).get("t1")).toEqual(live.state);
  });
});

describe("resolving a picked set", () => {
  const picked = () => {
    let s = createVariantSet(
      { setId: "vs-9", expectUrlPrefix: URL_, command: "c", count: 1, element },
      T0,
    );
    s = submitVariants(s, [{ variantId: "a", label: "A", program: calm, version: 1 }], T0).state;
    return pickIdx(s, 0, T0 + 1).state;
  };

  test("resolves keeping the picked outcome, and replays", () => {
    const r = resolveSet(picked(), T0 + 2);
    expect(r.ok).toBe(true);
    expect(r.state).toMatchObject({ status: "resolved", outcome: "picked", resolvedAt: T0 + 2 });
    const lines = [
      encodeVariantEntry({
        k: "variant-set-create",
        ts: T0,
        setId: "vs-9",
        expectUrlPrefix: URL_,
        command: "c",
        count: 1,
        element,
      }),
      encodeVariantEntry({
        k: "variant-generated",
        ts: T0,
        setId: "vs-9",
        variants: [{ variantId: "a", label: "A", program: calm, version: 1 }],
      }),
      encodeVariantEntry({ k: "variant-picked", ts: T0 + 1, setId: "vs-9", index: 0 }),
      encodeVariantEntry({ k: "variant-resolved", ts: T0 + 2, setId: "vs-9" }),
    ];
    expect(replayVariantSets(lines).get("vs-9")).toEqual(r.state);
  });

  test("an unpicked or resolved set refuses", () => {
    const fresh = createVariantSet(
      { setId: "vs-8", expectUrlPrefix: URL_, command: "c", count: 1, element },
      T0,
    );
    expect(resolveSet(fresh, T0).ok).toBe(false);
    expect(resolveSet(discardSet(fresh, T0).state, T0).ok).toBe(false);
  });
});

describe("the pick is pinned (review findings 4 and 5)", () => {
  test("a pick names the variant and version previewed; anything else changes nothing", () => {
    const set = setWithVariants();
    expect(pickVariant(set, { variantId: "zz", version: 1 }, T0 + 2)).toMatchObject({
      ok: false,
      reason: "variant-changed",
      state: set,
    });
    expect(pickVariant(set, { variantId: "b", version: 2 }, T0 + 2)).toMatchObject({
      ok: false,
      reason: "variant-changed",
      state: set,
    });
    const picked = pickVariant(set, { variantId: "b", version: 1 }, T0 + 2);
    expect(picked.ok && picked.state).toMatchObject({
      pickedVariantId: "b",
      pickedVersion: 1,
      pickedProgram: loud,
      pickedLabel: "Loud",
      activeIndex: 1,
    });
  });

  test("an agent revising the picked variant after the pick does not change the kept program", () => {
    const kept = pickEdit(edit(), ADA, T0 + 1).state;
    const picked = pickIdx(setWithVariants(), 0, T0 + 1).state;
    const reopened = reopenSet(picked, T0 + 2).state;
    const revised = tuneVariant(reopened, 0, loud, T0 + 3, true);
    expect(revised.ok).toBe(true);
    expect(revised.state.variants[0]).toMatchObject({ program: loud, version: 2 });
    const working = setChangeState(kept, "working", T0 + 3).state;
    expect(keptProgramOf(working, revised.state)).toMatchObject({ program: calm, label: "Calm" });
  });

  test("a revision by an agent marks the variant agent, even one a person made", () => {
    const manual = submitVariants(
      createVariantSet(
        { setId: "vs-1", expectUrlPrefix: URL_, command: "x", count: 1, element },
        T0,
      ),
      [{ variantId: "m", label: "Manual text edit", program: calm, version: 1 }],
      T0 + 1,
    ).state;
    const revised = tuneVariant(manual, 0, loud, T0 + 2, true).state;
    expect(revised.variants[0]?.agent).toBe(true);
    const replayed = replayVariantSets([
      encodeVariantEntry({
        k: "variant-set-create",
        ts: T0,
        setId: "vs-1",
        expectUrlPrefix: URL_,
        command: "x",
        count: 1,
        element,
      }),
      encodeVariantEntry({
        k: "variant-generated",
        ts: T0 + 1,
        setId: "vs-1",
        variants: [{ variantId: "m", label: "Manual text edit", program: calm, version: 1 }],
      }),
      encodeVariantEntry({
        k: "variant-tuned",
        ts: T0 + 2,
        setId: "vs-1",
        index: 0,
        program: loud,
        agent: true,
      }),
    ]).get("vs-1");
    expect(replayed?.variants[0]?.agent).toBe(true);
  });

  test("replay pins what was picked, from new and older journal shapes alike", () => {
    const head = [
      encodeVariantEntry({
        k: "variant-set-create",
        ts: T0,
        setId: "vs-1",
        expectUrlPrefix: URL_,
        command: "x",
        count: 2,
        element,
      }),
      encodeVariantEntry({
        k: "variant-generated",
        ts: T0 + 1,
        setId: "vs-1",
        variants: [
          { variantId: "a", label: "Calm", program: calm, version: 1 },
          { variantId: "b", label: "Loud", program: loud, version: 1 },
        ],
      }),
    ];
    const tail = [
      encodeVariantEntry({ k: "variant-reopened", ts: T0 + 3, setId: "vs-1" }),
      encodeVariantEntry({
        k: "variant-tuned",
        ts: T0 + 4,
        setId: "vs-1",
        index: 1,
        program: calm,
      }),
    ];
    for (const pick of [
      { k: "variant-picked" as const, ts: T0 + 2, setId: "vs-1", variantId: "b", version: 1 },
      { k: "variant-picked" as const, ts: T0 + 2, setId: "vs-1", index: 1 },
    ]) {
      const set = replayVariantSets([...head, encodeVariantEntry(pick), ...tail]).get("vs-1");
      expect(set).toMatchObject({ pickedVariantId: "b", pickedVersion: 1, pickedProgram: loud });
      expect(set?.variants[1]?.program).toEqual(calm);
    }
  });
});

describe("the kept entry names its revision (security audit, finding 4)", () => {
  test("a re-pick of a revised variant carries the new version; the old approval key no longer matches", () => {
    const kept = pickEdit(edit(), ADA, T0 + 1).state;
    const first = pickIdx(setWithVariants(), 0, T0 + 1).state;
    expect(keptProgramOf(kept, first)).toMatchObject({ variantId: "a", version: 1 });
    const revised = tuneVariant(reopenSet(first, T0 + 2).state, 0, loud, T0 + 2, true).state;
    // Until a person picks again, the approved revision stands.
    expect(keptProgramOf(kept, revised)).toMatchObject({
      variantId: "a",
      version: 1,
      program: calm,
    });
    const repicked = pickIdx(revised, 0, T0 + 3).state;
    expect(keptProgramOf(pickEdit(kept, ADA, T0 + 3).state, repicked)).toMatchObject({
      variantId: "a",
      version: 2,
      program: loud,
    });
  });
});

describe("a variant says who wrote it (round 2, S12)", () => {
  test("a revision records its writer, and replay agrees", () => {
    const set = setWithVariants();
    const revised = tuneVariant(set, 0, loud, T0 + 2, true, ADA).state;
    expect(revised.variants[0]?.by).toBe(ADA);
    const replayed = replayVariantSets([
      encodeVariantEntry({
        k: "variant-set-create",
        ts: T0,
        setId: "vs-1",
        expectUrlPrefix: URL_,
        command: "x",
        count: 1,
        element,
      }),
      encodeVariantEntry({
        k: "variant-generated",
        ts: T0 + 1,
        setId: "vs-1",
        variants: [{ variantId: "a", label: "Calm", program: calm, version: 1, by: ADA }],
      }),
      encodeVariantEntry({
        k: "variant-tuned",
        ts: T0 + 2,
        setId: "vs-1",
        index: 0,
        program: loud,
        agent: true,
        by: ADA,
      }),
    ]).get("vs-1");
    expect(replayed?.variants[0]).toMatchObject({ by: ADA, version: 2 });
  });
});
