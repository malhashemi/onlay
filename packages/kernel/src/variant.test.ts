import { describe, expect, test } from "bun:test";
import { LIMITS, type MutationProgram } from "@onlay/protocol";
import {
  createVariantSet,
  decodeVariantEntry,
  discardSet,
  encodeVariantEntry,
  markImplemented,
  markStale,
  pickVariant,
  replayVariantSets,
  revisionByClientId,
  setActive,
  submitVariants,
  tuneVariant,
  type Variant,
  type VariantCreateInput,
  type VariantJournalEntry,
  type VariantSetState,
} from "./variant";

/** Picks the variant at `index` by its id and current version, as a person does. */
function pickIdx(s: VariantSetState, index: number, now: number) {
  const v = s.variants[index];
  return pickVariant(s, { variantId: v?.variantId ?? "", version: v?.version ?? 0 }, now);
}

const SET_ID = "vs-1";
const T0 = 1_750_000_000_000;
const PREFIX = "http://127.0.0.1:8125/app";

const program = (text = "Buy now"): MutationProgram => [{ op: "setText", target: ":scope", text }];

const variant = (variantId: string, label = variantId): Variant => ({
  variantId,
  label,
  program: program(label),
  version: 1,
});

const input = (overrides: Partial<VariantCreateInput> = {}): VariantCreateInput => ({
  setId: SET_ID,
  expectUrlPrefix: PREFIX,
  command: "make the hero calmer",
  count: 2,
  ...overrides,
});

const fresh = (): VariantSetState => createVariantSet(input(), T0);
const previewing = (): VariantSetState => {
  const r = submitVariants(fresh(), [variant("v1"), variant("v2")], T0 + 1);
  if (!r.ok) throw new Error("setup failed");
  return r.state;
};

const ELEMENT = {
  selector: "article.card:nth-of-type(2)",
  tag: "article",
  classes: ["card"],
  textSnippet: "Beta",
  markup: '<article class="card">Beta</article>',
  sourcePointer: "src/App.tsx:32:11",
};

describe("variant-set reducer", () => {
  test("createVariantSet starts generating with no variants", () => {
    const s = fresh();
    expect(s.status).toBe("generating");
    expect(s.variants).toEqual([]);
    expect(s.createdAt).toBe(T0);
  });

  test("createVariantSet persists the picked-element context and intent", () => {
    const s = createVariantSet(input({ element: ELEMENT, intent: "insert-after" }), T0);
    expect(s.element).toEqual(ELEMENT);
    expect(s.intent).toBe("insert-after");
    // Absent on legacy input — never defaulted.
    expect(fresh().element).toBeUndefined();
    expect(fresh().intent).toBeUndefined();
  });

  test("submitVariants moves generating to previewing with active variant zero", () => {
    const r = submitVariants(fresh(), [variant("v1"), variant("v2")], T0 + 1);
    expect(r.ok).toBe(true);
    expect(r.state.status).toBe("previewing");
    expect(r.state.variants.map((v) => v.variantId)).toEqual(["v1", "v2"]);
    expect(r.state.activeIndex).toBe(0);
  });

  test("submitVariants guards resolved, wrong-status, and over-cap submissions", () => {
    const discarded = discardSet(fresh(), T0 + 1).state;
    const resolved = submitVariants(discarded, [variant("v1")], T0 + 2);
    expect(resolved.ok).toBe(false);
    if (!resolved.ok) expect(resolved.reason).toBe("resolved");

    const picked = pickIdx(previewing(), 0, T0 + 3).state;
    const postPick = submitVariants(picked, [variant("v3")], T0 + 4);
    expect(postPick.ok).toBe(false);
    if (!postPick.ok) expect(postPick.reason).toBe("wrong-status");

    const tooMany = Array.from({ length: LIMITS.MAX_VARIANTS_PER_SET + 1 }, (_, i) =>
      variant(`v${i + 1}`),
    );
    const overCap = submitVariants(fresh(), tooMany, T0 + 4);
    expect(overCap.ok).toBe(false);
    if (!overCap.ok) expect(overCap.reason).toBe("count");

    // Append cap: total across submissions never exceeds MAX_VARIANTS_PER_SET.
    const appendOverCap = submitVariants(
      previewing(), // already holds 2
      Array.from({ length: LIMITS.MAX_VARIANTS_PER_SET - 1 }, (_, i) => variant(`a${i + 1}`)),
      T0 + 5,
    );
    expect(appendOverCap.ok).toBe(false);
    if (!appendOverCap.ok) expect(appendOverCap.reason).toBe("count");
  });

  test("submitVariants streams: appends while previewing without yanking the active preview", () => {
    const cycled = setActive(previewing(), 1); // human is looking at v2
    const appended = submitVariants(cycled, [variant("v3")], T0 + 5);
    expect(appended.ok).toBe(true);
    expect(appended.state.status).toBe("previewing");
    expect(appended.state.variants.map((v) => v.variantId)).toEqual(["v1", "v2", "v3"]);
    expect(appended.state.activeIndex).toBe(1); // unmoved
  });

  test("setActive cycles only valid preview indexes", () => {
    const s = previewing();
    expect(setActive(s, 1).activeIndex).toBe(1);
    expect(setActive(s, 99)).toBe(s);
  });

  test("tuneVariant bumps one variant version in place", () => {
    const s = previewing();
    const tunedProgram = program("Start free");
    const r = tuneVariant(s, 1, tunedProgram, T0 + 2);
    expect(r.ok).toBe(true);
    expect(r.state.variants[0]).toBe(s.variants[0]);
    expect(r.state.variants[1]?.program).toEqual(tunedProgram);
    expect(r.state.variants[1]?.version).toBe(2);
    expect(r.state.activeIndex).toBe(1);
  });

  test("a revision with a client id is remembered per person, and replays from the journal", () => {
    const s = previewing();
    const r = tuneVariant(s, 1, program("Start free"), T0 + 2, true, "p_ada", "c-1");
    expect(revisionByClientId(r.state, "p_ada", "c-1")).toEqual({
      by: "p_ada",
      clientId: "c-1",
      variantId: "v2",
      version: 2,
      index: 1,
      ops: 1,
    });
    // Another person's id, or no id, is not that revision.
    expect(revisionByClientId(r.state, "p_bea", "c-1")).toBeUndefined();
    expect(tuneVariant(s, 1, program("x"), T0 + 2, true, "p_ada").state.revisions).toBeUndefined();
    // A later revision leaves the first one's record as it was.
    const later = tuneVariant(r.state, 1, program("Newer"), T0 + 3, true, "p_bea").state;
    expect(later.variants[1]?.version).toBe(3);
    expect(revisionByClientId(later, "p_ada", "c-1")?.version).toBe(2);

    const lines = [
      { k: "variant-set-create", ts: T0, ...input() },
      {
        k: "variant-generated",
        ts: T0 + 1,
        setId: SET_ID,
        variants: [variant("v1"), variant("v2")],
      },
      // An older journal's revision: no client id.
      {
        k: "variant-tuned",
        ts: T0 + 2,
        setId: SET_ID,
        index: 0,
        program: program("a"),
        agent: true,
        by: "p_ada",
      },
      {
        k: "variant-tuned",
        ts: T0 + 3,
        setId: SET_ID,
        index: 1,
        program: program("b"),
        agent: true,
        by: "p_ada",
        clientId: "c-1",
      },
    ].map((e) => encodeVariantEntry(e as VariantJournalEntry));
    const replayed = replayVariantSets(lines).get(SET_ID);
    expect(replayed?.revisions).toEqual([
      { by: "p_ada", clientId: "c-1", variantId: "v2", version: 2, index: 1, ops: 1 },
    ]);
  });

  test("a set remembers every revision by client id, however many come after", () => {
    let s = tuneVariant(previewing(), 0, program("first"), T0, true, "p_ada", "c-first").state;
    for (let i = 0; i < 500; i++) {
      s = tuneVariant(s, 1, program(`t${i}`), T0 + i, true, "p_ada", `c-${i}`).state;
    }
    expect(s.revisions).toHaveLength(501);
    expect(revisionByClientId(s, "p_ada", "c-first")).toEqual({
      by: "p_ada",
      clientId: "c-first",
      variantId: "v1",
      version: 2,
      index: 0,
      ops: 1,
    });
  });

  test("pickVariant is first-pick-wins and moves to implementing", () => {
    const picked = pickIdx(previewing(), 1, T0 + 2);
    expect(picked.ok).toBe(true);
    expect(picked.state.status).toBe("implementing");
    expect(picked.state.pickedVariantId).toBe("v2");
    expect(picked.state.activeIndex).toBe(1);
    expect(picked.state.outcome).toBe("picked");

    const second = pickIdx(picked.state, 0, T0 + 3);
    expect(second.ok).toBe(false);
    expect(second.state.pickedVariantId).toBe("v2");
  });

  test("implementing moves to verifying, then stale resolves", () => {
    const picked = pickIdx(previewing(), 0, T0 + 2).state;
    const implemented = markImplemented(picked, T0 + 3);
    expect(implemented.ok).toBe(true);
    expect(implemented.state.status).toBe("verifying");

    const stale = markStale(implemented.state, T0 + 4);
    expect(stale.status).toBe("resolved");
    expect(stale.outcome).toBe("stale");
    expect(stale.resolvedAt).toBe(T0 + 4);
  });

  test("discard resolves an unpicked set and is refused after pick", () => {
    const discarded = discardSet(previewing(), T0 + 2);
    expect(discarded.ok).toBe(true);
    expect(discarded.state.status).toBe("resolved");
    expect(discarded.state.outcome).toBe("discarded");

    const picked = pickIdx(previewing(), 0, T0 + 3).state;
    const lateDiscard = discardSet(picked, T0 + 4);
    expect(lateDiscard.ok).toBe(false);
    expect(lateDiscard.state.outcome).toBe("picked");
  });
});

describe("variant journal codec + replay", () => {
  const entries: VariantJournalEntry[] = [
    {
      k: "variant-set-create",
      ts: T0,
      setId: SET_ID,
      expectUrlPrefix: PREFIX,
      command: "make the hero calmer",
      count: 2,
    },
    { k: "variant-generated", ts: T0 + 1, setId: SET_ID, variants: [variant("v1"), variant("v2")] },
    { k: "variant-tuned", ts: T0 + 2, setId: SET_ID, index: 1, program: program("Start free") },
    { k: "variant-picked", ts: T0 + 3, setId: SET_ID, index: 1 },
    { k: "variant-implemented", ts: T0 + 4, setId: SET_ID },
  ];

  test("encode/decode round-trips every kind", () => {
    for (const e of entries) expect(decodeVariantEntry(encodeVariantEntry(e))).toEqual(e);
    const discarded: VariantJournalEntry = { k: "variant-discarded", ts: T0 + 5, setId: SET_ID };
    const steered: VariantJournalEntry = {
      k: "variant-steered",
      ts: T0 + 6,
      setId: SET_ID,
      instruction: "avoid layout shift",
    };
    const stale: VariantJournalEntry = { k: "variant-stale", ts: T0 + 7, setId: SET_ID };
    expect(decodeVariantEntry(encodeVariantEntry(discarded))).toEqual(discarded);
    expect(decodeVariantEntry(encodeVariantEntry(steered))).toEqual(steered);
    expect(decodeVariantEntry(encodeVariantEntry(stale))).toEqual(stale);
  });

  test("garbage and unknown kinds decode to null", () => {
    expect(decodeVariantEntry("{nope")).toBeNull();
    expect(
      decodeVariantEntry(JSON.stringify({ k: "variant-explode", setId: SET_ID, ts: T0 })),
    ).toBeNull();
  });

  test("replay reconstructs a mid-set state", () => {
    const s = replayVariantSets(entries.map(encodeVariantEntry)).get(SET_ID);
    expect(s?.status).toBe("verifying");
    expect(s?.pickedVariantId).toBe("v2");
    expect(s?.activeIndex).toBe(1);
    expect(s?.variants[1]?.version).toBe(2);
    expect(s?.variants[1]?.program).toEqual(program("Start free"));
  });

  test("replay skips non-create lines for unknown setIds", () => {
    const sets = replayVariantSets([
      encodeVariantEntry({
        k: "variant-generated",
        ts: T0 + 1,
        setId: "missing",
        variants: [variant("v1")],
      }),
      encodeVariantEntry(entries[0] as VariantJournalEntry),
    ]);
    expect(sets.size).toBe(1);
    expect(sets.has("missing")).toBe(false);
  });

  test("replay tolerates a truncated final line", () => {
    const lines = [
      encodeVariantEntry(entries[0] as VariantJournalEntry),
      encodeVariantEntry(entries[1] as VariantJournalEntry),
      '{"k":"variant-picked","setId":"vs-1',
    ];
    const s = replayVariantSets(lines).get(SET_ID);
    expect(s?.status).toBe("previewing");
    expect(s?.variants.length).toBe(2);
  });

  test("replay preserves stale resolution", () => {
    const lines = [
      encodeVariantEntry(entries[0] as VariantJournalEntry),
      encodeVariantEntry(entries[1] as VariantJournalEntry),
      encodeVariantEntry({ k: "variant-stale", ts: T0 + 2, setId: SET_ID }),
    ];
    const s = replayVariantSets(lines).get(SET_ID);
    expect(s?.status).toBe("resolved");
    expect(s?.outcome).toBe("stale");
    expect(s?.resolvedAt).toBe(T0 + 2);
  });

  test("replay rebuilds element context + intent; legacy lines stay rootless", () => {
    const withRoot: VariantJournalEntry = {
      k: "variant-set-create",
      ts: T0,
      setId: "vs-rooted",
      expectUrlPrefix: PREFIX,
      command: "insert a testimonial",
      count: 3,
      element: ELEMENT,
      intent: "insert-after",
    };
    const sets = replayVariantSets([
      encodeVariantEntry(withRoot),
      encodeVariantEntry(entries[0] as VariantJournalEntry), // legacy line: no element/intent
    ]);
    const rooted = sets.get("vs-rooted");
    expect(rooted?.element).toEqual(ELEMENT);
    expect(rooted?.intent).toBe("insert-after");
    const legacy = sets.get(SET_ID);
    expect(legacy?.element).toBeUndefined();
    expect(legacy?.intent).toBeUndefined();
  });
});
