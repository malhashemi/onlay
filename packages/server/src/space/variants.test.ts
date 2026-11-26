import { describe, expect, test } from "bun:test";
import { submitVariants, type Variant, type VariantSetState } from "@onlay/kernel";
import { LIMITS, type MutationProgram, parseOutbound, programBytes } from "@onlay/protocol";
import { buildInteractionsState, buildVariantState } from "./runtime";
import { batchOp, commitSet } from "./service";
import {
  ADA,
  BEA,
  framesOf,
  GUS,
  guest,
  type Harness,
  makeHarness,
  member,
  PAGE,
  type TestSocket,
} from "./testing/harness";
import { checkProgram } from "./variants";

/**
 * Edits (spec §8): several sets per page, page roots, pick is keep (kept on an
 * unowned page, working with agent work on an owned one), agents appending to
 * a kept Edit, `implemented` retiring the kept program, resolving a picked
 * set's Edit resolving the set, and hand-made batches.
 */

const T0 = 1_750_000_000_000;
const element = (sourcePointer?: string) => ({
  selector: "main > h1",
  tag: "h1",
  classes: [],
  textSnippet: "Pricing",
  markup: "<h1>Pricing</h1>",
  ...(sourcePointer ? { sourcePointer } : {}),
});
const calm: MutationProgram = [
  { op: "setStyle", target: ":scope", props: [{ prop: "color", value: "slateblue" }] },
];

function createSet(
  h: Harness,
  s: TestSocket,
  over: Record<string, unknown> = {},
): { setId: string; editId: string } {
  const nonce = crypto.randomUUID().slice(0, 8);
  // `element` in `over` names the block root (a shorthand for these tests).
  const { element: block, ...rest } = over as { element?: ReturnType<typeof element> };
  h.send(s, {
    v: 1,
    type: "variant-create",
    nonce,
    frameUrl: PAGE,
    root: { kind: "block", element: block ?? element() },
    command: "make it calmer",
    count: 2,
    ...rest,
  });
  const state = framesOf(s, "variant-state").find((f) => f.nonce === nonce);
  if (!state) throw new Error(`no set: ${JSON.stringify(s.frames().at(-1))}`);
  return { setId: state.setId, editId: state.changeInteractionId };
}

/** The `variant-pick` frame for the variant at `index`, as the overlay sends it after previewing. */
function pickFrame(h: Harness, setId: string, index: number) {
  const v = h.space.runtime.variantSets.get(setId)?.variants[index];
  return {
    v: 1,
    type: "variant-pick",
    setId,
    frameUrl: PAGE,
    variantId: v?.variantId ?? "missing",
    version: v?.version ?? 1,
  };
}

/** The pick body for the variant at `index`. */
function pickBody(h: Harness, setId: string, index: number) {
  const v = h.space.runtime.variantSets.get(setId)?.variants[index];
  return { variantId: v?.variantId ?? "missing", version: v?.version ?? 1 };
}

async function postVariants(h: Harness, setId: string, programs: MutationProgram[]) {
  return h.request(member(ADA, "agent"), "POST", `/variant-set/${setId}/variants`, {
    variants: programs.map((program, i) => ({ label: `V${i + 1}`, program })),
  });
}

describe("several sets on one page", () => {
  test("creating a set leaves every other live set alone", () => {
    const h = makeHarness();
    const s = h.connect(member(ADA));
    const a = createSet(h, s);
    const b = createSet(h, s, { command: "make it louder" });
    const rt = h.space.runtime;
    expect(rt.variantSets.get(a.setId)?.status).toBe("generating");
    expect(rt.variantSets.get(b.setId)?.status).toBe("generating");
    expect(rt.interactions.get(a.editId)?.state).toBe("open");
    expect(rt.interactions.get(a.editId)?.agentWork?.status).toBe("pending");
  });
});

describe("a set for a block inside a frame", () => {
  test("its Edit keeps the page the person shares, redacted, beside the frame's own address", () => {
    const h = makeHarness();
    const s = h.connect(member(ADA));
    const { editId } = createSet(h, s, { hostUrl: "https://shell.example/doc?id=7#top" });
    const edit = h.space.runtime.interactions.get(editId);
    expect(edit?.url).toBe(PAGE);
    expect(edit?.hostUrl).toBe("https://shell.example/doc?…");
  });

  test("a shared page that isn't a web address is refused and makes nothing", () => {
    const h = makeHarness();
    const s = h.connect(member(ADA));
    const before = h.space.runtime.variantSets.size;
    h.send(s, {
      v: 1,
      type: "variant-create",
      nonce: "n-host",
      frameUrl: PAGE,
      hostUrl: "javascript:alert(1)",
      root: { kind: "block", element: element() },
      command: "make it calmer",
      count: 2,
    });
    expect(h.space.runtime.variantSets.size).toBe(before);
    expect(framesOf(s, "interaction-receipt").at(-1)).toMatchObject({ ok: false });
  });
});

describe("pick is keep", () => {
  test("on an unowned page the Edit is kept and its program rides the page snapshot", async () => {
    const h = makeHarness();
    const s = h.connect(member(ADA));
    const { setId, editId } = createSet(h, s);
    expect((await postVariants(h, setId, [calm, calm])).status).toBe(200);
    s.sent.length = 0;
    h.send(s, pickFrame(h, setId, 0));
    expect(framesOf(s, "variant-receipt")[0]).toMatchObject({ kind: "pick", ok: true });
    const edit = h.space.runtime.interactions.get(editId);
    expect(edit?.state).toBe("kept");
    const page = framesOf(s, "interactions-state").at(-1);
    expect(page.kept).toEqual([
      {
        interactionId: editId,
        setId,
        variantId: h.space.runtime.variantSets.get(setId)?.pickedVariantId,
        version: 1,
        root: { kind: "block", element: element() },
        program: calm,
        by: ADA,
        at: h.clock.now(),
        label: "V1",
      },
    ]);
    const read = await h.request(member(BEA), "GET", `/interaction/${editId}`);
    expect(read.body.kept.program).toEqual(calm);
    // The by-id read names the picked variant and version, as the snapshot does.
    expect(read.body.kept).toMatchObject({
      variantId: h.space.runtime.variantSets.get(setId)?.pickedVariantId,
      version: 1,
    });
    expect(read.body.interaction.state).toBe("kept");
  });

  test("on an owned page the Edit goes to working with agent work pending", async () => {
    const h = makeHarness();
    const s = h.connect(member(BEA));
    const { setId, editId } = createSet(h, s, { element: element("src/Pricing.tsx:4:2") });
    await postVariants(h, setId, [calm]);
    const picked = await h.request(
      member(BEA, "interaction"),
      "POST",
      `/variant-set/${setId}/pick`,
      pickBody(h, setId, 0),
    );
    expect(picked.body).toMatchObject({ ok: true, interactionId: editId, state: "working" });
    const edit = h.space.runtime.interactions.get(editId);
    expect(edit?.agentWork).toMatchObject({ status: "pending", requestedBy: BEA });
    expect(edit?.change?.ownsSource).toBe(true);
  });

  test("an agent implementing retires the kept program and hands the Edit back to verify", async () => {
    const h = makeHarness();
    const s = h.connect(member(ADA));
    const { setId, editId } = createSet(h, s, { element: element("src/Pricing.tsx:4:2") });
    await postVariants(h, setId, [calm]);
    h.send(s, pickFrame(h, setId, 0));
    const agent = member(ADA, "agent");
    expect(
      (await h.request(member(ADA), "POST", `/interaction/${editId}/state`, { state: "working" }))
        .status,
    ).toBe(403);
    const done = await h.request(agent, "POST", `/interaction/${editId}/state`, {
      state: "implemented",
    });
    expect(done.body).toMatchObject({ ok: true, state: "verifying" });
    const rt = h.space.runtime;
    expect(rt.variantSets.get(setId)?.status).toBe("verifying");
    const read = await h.request(member(ADA), "GET", `/interaction/${editId}`);
    expect(read.body.kept).toBeUndefined();
    const states = read.body.interaction.thread.filter((m: { system?: boolean }) => m.system);
    expect(states.at(-1).body.text).toBe("Edit ready to verify");
    // The requester's closing act resolves the Edit, and the picked set with it.
    await h.request(member(ADA), "POST", `/interaction/${editId}/resolve`);
    expect(rt.variantSets.get(setId)).toMatchObject({ status: "resolved", outcome: "picked" });
  });

  test("an agent posting new variants on a kept Edit reopens the set; the pick holds until re-picked", async () => {
    const h = makeHarness();
    const s = h.connect(member(ADA));
    const { setId, editId } = createSet(h, s);
    await postVariants(h, setId, [calm]);
    h.send(s, pickFrame(h, setId, 0));
    // The member asks again; the Edit stays kept until an agent answers.
    await h.request(member(ADA), "POST", `/interaction/${editId}/reply`, {
      body: { text: "try warmer", tokens: [{ t: "agent" }] },
    });
    expect(h.space.runtime.interactions.get(editId)?.state).toBe("kept");
    const warm: MutationProgram = [{ op: "setClass", target: ":scope", add: ["warm"], remove: [] }];
    const posted = await postVariants(h, setId, [warm]);
    expect(posted.body.set.status).toBe("previewing");
    expect(posted.body.set.variants.at(-1)).toMatchObject({ agent: true });
    const edit = h.space.runtime.interactions.get(editId);
    expect(edit?.state).toBe("working");
    expect(edit?.agentWork?.status).toBe("answered");
    expect(edit?.waitingOn).toEqual([ADA]);
    const read = await h.request(member(ADA), "GET", `/interaction/${editId}`);
    expect(read.body.kept.program).toEqual(calm);
    h.send(s, pickFrame(h, setId, 1));
    expect(h.space.runtime.interactions.get(editId)?.state).toBe("kept");
    expect(
      (await h.request(member(ADA), "GET", `/interaction/${editId}`)).body.kept.program,
    ).toEqual(warm);
  });

  test("resolving a kept Edit (Remove) resolves its picked set", async () => {
    const h = makeHarness();
    const s = h.connect(member(ADA));
    const { setId, editId } = createSet(h, s);
    await postVariants(h, setId, [calm]);
    h.send(s, pickFrame(h, setId, 0));
    h.send(s, { v: 1, type: "interaction-resolve", frameUrl: PAGE, interactionId: editId });
    expect(h.space.runtime.variantSets.get(setId)).toMatchObject({
      status: "resolved",
      outcome: "picked",
    });
    expect(h.space.runtime.variantStore.replayFromEvents(setId)).toEqual(
      h.space.runtime.variantSets.get(setId),
    );
  });

  test("discard drops the Edit", async () => {
    const h = makeHarness();
    const s = h.connect(member(ADA));
    const a = createSet(h, s);
    await postVariants(h, a.setId, [calm]);
    h.send(s, { v: 1, type: "variant-discard", setId: a.setId, frameUrl: PAGE });
    expect(h.space.runtime.interactions.get(a.editId)?.state).toBe("dropped");
  });
});

describe("page-root sets", () => {
  test("a page root anchors the Edit to the page; provenance makes it owned", () => {
    const h = makeHarness();
    const s = h.connect(member(ADA));
    const { setId, editId } = createSet(h, s, {
      element: undefined,
      root: { kind: "page" },
      provenance: "github.com/acme/site@abc;main;clean",
    });
    const edit = h.space.runtime.interactions.get(editId);
    expect(edit?.anchor).toEqual({ level: "page" });
    expect(edit?.change?.ownsSource).toBe(true);
    const frame = framesOf(s, "variant-state").at(-1);
    expect(frame.rootKind).toBe("page");
    expect(frame.selector).toBeUndefined();
    expect(h.space.runtime.variantSets.get(setId)?.root).toEqual({ kind: "page" });
  });

  test("a page root takes up to 256 ops and refuses setText or a replace aimed at :scope", async () => {
    const h = makeHarness();
    const s = h.connect(member(ADA));
    const { setId } = createSet(h, s, { element: undefined, root: { kind: "page" } });
    const refused = await postVariants(h, setId, [
      calm,
      [{ op: "setText", target: ":scope", text: "gone" }],
    ]);
    expect(refused.status).toBe(400);
    expect(refused.body.error.reason).toBe("program-invalid");
    expect(refused.body.results).toEqual([
      { ok: true },
      { ok: false, opIndex: 0, reason: "setText on the page root" },
    ]);
    const many: MutationProgram = Array.from({ length: 100 }, (_, i) => ({
      op: "setStyle" as const,
      target: `section:nth-of-type(${i + 1})`,
      props: [{ prop: "color", value: "red" }],
    }));
    expect((await postVariants(h, setId, [many])).status).toBe(200);
  });

  test("a block root keeps the 64-op budget", async () => {
    const h = makeHarness();
    const s = h.connect(member(ADA));
    const { setId } = createSet(h, s);
    const many: MutationProgram = Array.from(
      { length: 65 },
      () => calm[0] as MutationProgram[number],
    );
    const r = await postVariants(h, setId, [many]);
    expect(r.body.results[0]).toMatchObject({ ok: false });
  });
});

describe("checkProgram", () => {
  test("names the refused op and why, per root", () => {
    expect(checkProgram({ kind: "page" }, [calm[0] as MutationProgram[number]])).toEqual({
      ok: true,
    });
    expect(
      checkProgram({ kind: "page" }, [
        calm[0] as MutationProgram[number],
        { op: "insertFragment", target: " :scope ", position: "replace", html: "<p/>" },
      ]),
    ).toEqual({ ok: false, opIndex: 1, reason: "replace insert on the page root" });
    expect(
      checkProgram({ kind: "block", element: element() }, [
        { op: "setText", target: ":scope", text: "ok" },
      ]),
    ).toEqual({ ok: true });
  });
});

describe("steer, tune and hand-made batches", () => {
  test("a steer journals the instruction on the Edit as the person's system note and asks for an agent", async () => {
    const h = makeHarness();
    const s = h.connect(member(ADA));
    const { setId, editId } = createSet(h, s);
    await postVariants(h, setId, [calm]);
    h.send(s, { v: 1, type: "variant-steer", setId, frameUrl: PAGE, instruction: "less blue" });
    expect(framesOf(s, "variant-receipt").at(-1)).toMatchObject({ kind: "steer", ok: true });
    const edit = h.space.runtime.interactions.get(editId);
    expect(edit?.thread.at(-1)).toMatchObject({
      authorId: ADA,
      system: true,
      body: { text: "Steer: less blue" },
    });
    expect(edit?.agentWork).toMatchObject({ status: "pending", requestedBy: ADA });
    h.send(s, {
      v: 1,
      type: "variant-tune",
      setId,
      frameUrl: PAGE,
      index: 0,
      instruction: "bolder",
    });
    expect(h.space.runtime.interactions.get(editId)?.thread.at(-1)?.body.text).toBe(
      "Tune “V1”: bolder",
    );
  });

  test("a batch sent on an unowned page keeps the Edit at once, rooted at the page", () => {
    const h = makeHarness();
    const s = h.connect(member(ADA));
    h.send(s, {
      v: 1,
      type: "interaction-create",
      frameUrl: PAGE,
      nonce: "n1",
      kind: "change",
      anchor: { level: "page" },
      change: { intent: "Manual batch of 1 edit(s)", method: "manual-batch" },
    });
    const id = framesOf(s, "interaction-receipt")[0].interactionId as string;
    expect(h.space.runtime.interactions.get(id)?.agentWork).toBeUndefined();
    h.send(s, { v: 1, type: "change-batch", frameUrl: PAGE, interactionId: id, ops: calm });
    expect(framesOf(s, "interaction-receipt").at(-1)).toMatchObject({ kind: "batch", ok: true });
    expect(h.space.runtime.interactions.get(id)?.state).toBe("kept");
    expect(framesOf(s, "interactions-state").at(-1).kept[0]).toMatchObject({
      interactionId: id,
      root: { kind: "page" },
      program: calm,
      by: ADA,
    });
  });

  test("a batch sent on an owned page stays open with agent work pending", () => {
    const h = makeHarness();
    const s = h.connect(member(ADA));
    h.send(s, {
      v: 1,
      type: "interaction-create",
      frameUrl: PAGE,
      nonce: "n1",
      kind: "change",
      anchor: { level: "page" },
      change: {
        intent: "batch",
        method: "manual-batch",
        provenance: "github.com/acme/site@abc;main;clean",
      },
    });
    const id = framesOf(s, "interaction-receipt")[0].interactionId as string;
    h.send(s, { v: 1, type: "change-batch", frameUrl: PAGE, interactionId: id, ops: calm });
    const edit = h.space.runtime.interactions.get(id);
    expect(edit?.state).toBe("open");
    expect(edit?.agentWork?.status).toBe("pending");
  });
});

describe("variant state survives a restart", () => {
  test("a fresh runtime over the same database rebuilds the set and its Edit", async () => {
    const h = makeHarness();
    const s = h.connect(member(ADA));
    const { setId, editId } = createSet(h, s);
    await postVariants(h, setId, [calm]);
    const before = h.space.runtime.variantSets.get(setId);
    h.evict();
    expect(h.space.runtime.variantSets.get(setId)).toEqual(before);
    expect(h.space.runtime.variantStore.replayFromEvents(setId)).toEqual(before);
    expect(h.space.runtime.interactions.get(editId)?.change?.variantSetId).toBe(setId);
  });
});

describe("variant-state outbound budget", () => {
  test("buildVariantState truncates oldest variants first under the 1 MiB cap", () => {
    const hugeOp = {
      op: "insertFragment" as const,
      target: ":scope",
      position: "append" as const,
      html: "x".repeat(LIMITS.MAX_FRAGMENT_CHARS),
    };
    const hugeProgram: MutationProgram = Array.from({ length: 12 }, () => hugeOp);
    const variants = [1, 2, 3, 4].map(
      (n): Variant => ({
        variantId: `v${n}`,
        label: `Variant ${n}`,
        program: hugeProgram,
        version: 1,
      }),
    );
    const set: VariantSetState = {
      setId: "set-1",
      expectUrlPrefix: PAGE,
      command: "make it calmer",
      count: 4,
      status: "previewing",
      variants,
      activeIndex: 3,
      createdAt: T0,
    };
    const frame = buildVariantState(set);
    expect(frame.truncated).toBe(true);
    expect(JSON.stringify(frame).length).toBeLessThanOrEqual(LIMITS.MAX_OUTBOUND_FRAME_CHARS);
    expect(frame.variants.map((v) => v.variantId)).toEqual(["v3", "v4"]);
    expect(frame.activeIndex).toBe(1);
  });
});

/* ── review findings: picks, pinning, sizes, atomic commits ───────── */

/** A block program of about `kib` KiB (inserted fragments of the fragment cap). */
function bigProgram(kib: number): MutationProgram {
  const chunk = 32 * 1024;
  const ops = Math.ceil((kib * 1024) / chunk);
  return Array.from({ length: ops }, (_, i) => ({
    op: "insertFragment" as const,
    target: ":scope",
    position: "append" as const,
    html: `<p>${String(i).padEnd(chunk - 16, "x")}</p>`,
  }));
}

const variantEvents = (h: Harness, setId: string) =>
  h.space.runtime.journal.eventsFor("variant", setId).length;
const editEvents = (h: Harness, id: string) =>
  h.space.runtime.journal.eventsFor("interaction", id).length;

describe("an invalid pick changes nothing (finding 3)", () => {
  test("a member's pick of an unknown variant is refused and leaves the set and the Edit alone", async () => {
    const h = makeHarness();
    const s = h.connect(member(ADA));
    const { setId, editId } = createSet(h, s);
    await postVariants(h, setId, [calm]);
    const before = { set: variantEvents(h, setId), edit: editEvents(h, editId) };
    s.sent.length = 0;
    h.send(s, { ...pickFrame(h, setId, 0), variantId: "no-such-variant" });
    expect(framesOf(s, "variant-receipt")[0]).toMatchObject({
      kind: "pick",
      ok: false,
      reason: "variant-changed",
    });
    expect(h.space.runtime.variantSets.get(setId)?.status).toBe("previewing");
    expect(h.space.runtime.interactions.get(editId)?.state).toBe("working");
    expect({ set: variantEvents(h, setId), edit: editEvents(h, editId) }).toEqual(before);
  });

  test("a guest's bad pick on a shared Edit is refused with no side effect", async () => {
    const h = makeHarness();
    const s = h.connect(member(ADA));
    const { setId, editId } = createSet(h, s);
    await postVariants(h, setId, [calm]);
    const before = { set: variantEvents(h, setId), edit: editEvents(h, editId) };
    const r = await h.request(guest(GUS, [editId]), "POST", `/variant-set/${setId}/pick`, {
      variantId: "no-such-variant",
      version: 1,
      index: 9,
    });
    expect(r.status).toBe(409);
    expect(r.body.error.reason).toBe("variant-changed");
    expect(h.space.runtime.variantSets.get(setId)?.status).toBe("previewing");
    expect(h.space.runtime.interactions.get(editId)?.state).toBe("working");
    expect({ set: variantEvents(h, setId), edit: editEvents(h, editId) }).toEqual(before);
  });
});

describe("a pick names the variant previewed (finding 4)", () => {
  test("from a truncated frame, the variant previewed is the one kept", async () => {
    const h = makeHarness();
    const s = h.connect(member(ADA));
    const { setId, editId } = createSet(h, s);
    // A set from before the program limits, too big for one frame: the frame
    // carries only its last variants, so frame index 0 is not set index 0.
    const rt = h.space.runtime;
    const huge = Array.from({ length: 12 }, () => ({
      op: "insertFragment" as const,
      target: ":scope",
      position: "append" as const,
      html: "x".repeat(LIMITS.MAX_FRAGMENT_CHARS),
    }));
    const legacy = [1, 2, 3, 4].map(
      (n): Variant => ({ variantId: `v${n}`, label: `V${n}`, program: huge, version: 1 }),
    );
    const seeded = submitVariants(rt.variantSets.get(setId) as VariantSetState, legacy, 0);
    if (!seeded.ok) throw new Error("seed");
    commitSet(rt, { k: "variant-generated", ts: 0, setId, variants: legacy }, seeded.state);
    const frame = buildVariantState(h.space.runtime.variantSets.get(setId) as VariantSetState);
    expect(frame.truncated).toBe(true);
    const shown = frame.variants[0];
    if (!shown) throw new Error("no variant in the frame");
    expect(shown.variantId).not.toBe(
      h.space.runtime.variantSets.get(setId)?.variants[0]?.variantId,
    );
    s.sent.length = 0;
    h.send(s, {
      v: 1,
      type: "variant-pick",
      setId,
      frameUrl: PAGE,
      variantId: shown.variantId,
      version: shown.version,
      index: 0,
    });
    // The index hint (0 in the frame) disagrees with the set: refused, nothing kept.
    expect(framesOf(s, "variant-receipt").at(-1)).toMatchObject({
      ok: false,
      reason: "variant-changed",
    });
    h.send(s, {
      v: 1,
      type: "variant-pick",
      setId,
      frameUrl: PAGE,
      variantId: shown.variantId,
      version: shown.version,
    });
    expect(framesOf(s, "variant-receipt").at(-1)).toMatchObject({ ok: true });
    expect(h.space.runtime.variantSets.get(setId)?.pickedVariantId).toBe(shown.variantId);
    const read = await h.request(member(ADA), "GET", `/interaction/${editId}`);
    expect(read.body.kept.program).toEqual(shown.program);
  });

  test("a pick of a version the agent has since revised is refused", async () => {
    const h = makeHarness();
    const s = h.connect(member(ADA));
    const { setId } = createSet(h, s);
    await postVariants(h, setId, [calm]);
    const seen = pickBody(h, setId, 0);
    const warm: MutationProgram = [{ op: "setClass", target: ":scope", add: ["warm"], remove: [] }];
    await h.request(member(ADA, "agent"), "POST", `/variant-set/${setId}/variants/0`, {
      program: warm,
    });
    const r = await h.request(
      member(ADA, "interaction"),
      "POST",
      `/variant-set/${setId}/pick`,
      seen,
    );
    expect(r.status).toBe(409);
    expect(r.body.error.reason).toBe("variant-changed");
    expect(h.space.runtime.variantSets.get(setId)?.status).toBe("previewing");
  });
});

describe("the kept program is the one picked (finding 5)", () => {
  test("an agent revising the picked variant reopens the set; the kept program stays the pick", async () => {
    const h = makeHarness();
    const s = h.connect(member(ADA));
    const { setId, editId } = createSet(h, s);
    await postVariants(h, setId, [calm]);
    h.send(s, pickFrame(h, setId, 0));
    const warm: MutationProgram = [{ op: "setClass", target: ":scope", add: ["warm"], remove: [] }];
    const revised = await h.request(
      member(ADA, "agent"),
      "POST",
      `/variant-set/${setId}/variants/0`,
      { program: warm },
    );
    expect(revised.body).toMatchObject({ ok: true, version: 2 });
    const rt = h.space.runtime;
    expect(rt.variantSets.get(setId)?.status).toBe("previewing");
    expect(rt.interactions.get(editId)?.state).toBe("working");
    const read = await h.request(member(BEA), "GET", `/interaction/${editId}`);
    expect(read.body.kept).toMatchObject({ program: calm, by: ADA, label: "V1" });
    // Durable: the pin survives a restart and a replay of the journal.
    h.evict();
    expect(h.space.runtime.variantStore.replayFromEvents(setId)).toEqual(
      h.space.runtime.variantSets.get(setId),
    );
    const again = await h.request(member(BEA), "GET", `/interaction/${editId}`);
    expect(again.body.kept.program).toEqual(calm);
  });

  test("an agent's revision of a manual variant is marked agent, durably", async () => {
    const h = makeHarness();
    const s = h.connect(member(ADA));
    const { setId } = createSet(h, s, { manual: calm });
    expect(h.space.runtime.variantSets.get(setId)?.variants[0]?.agent).toBeUndefined();
    await h.request(member(ADA, "agent"), "POST", `/variant-set/${setId}/variants/0`, {
      program: calm,
    });
    expect(h.space.runtime.variantSets.get(setId)?.variants[0]?.agent).toBe(true);
    h.evict();
    expect(h.space.runtime.variantSets.get(setId)?.variants[0]?.agent).toBe(true);
    expect(h.space.runtime.variantStore.replayFromEvents(setId)?.variants[0]?.agent).toBe(true);
  });
});

describe("program sizes (findings 6 and 7)", () => {
  test("one program over MAX_PROGRAM_BYTES is refused with its measured size", async () => {
    const h = makeHarness();
    const s = h.connect(member(ADA));
    const { setId } = createSet(h, s);
    const tooBig = bigProgram(300);
    const r = await postVariants(h, setId, [tooBig]);
    expect(r.status).toBe(400);
    expect(r.body.error.reason).toBe("program-too-large");
    expect(r.body.results[0]).toMatchObject({
      ok: false,
      measured: programBytes(tooBig),
      allowed: LIMITS.MAX_PROGRAM_BYTES,
    });
    expect(r.body.error.message).toContain("262,144");
    const revise = await h.request(
      member(ADA, "agent"),
      "POST",
      `/variant-set/${setId}/variants/0`,
      { program: tooBig },
    );
    expect(revise.status).toBe(400);
  });

  test("a set's programs together stop at MAX_SET_PROGRAM_BYTES", async () => {
    const h = makeHarness();
    const s = h.connect(member(ADA));
    const { setId } = createSet(h, s);
    for (let i = 0; i < 4; i++)
      expect((await postVariants(h, setId, [bigProgram(224)])).status).toBe(200);
    const r = await postVariants(h, setId, [bigProgram(224)]);
    expect(r.status).toBe(400);
    expect(r.body.error.reason).toBe("set-too-large");
    expect(r.body.error.message).toContain("1,048,576");
    // What `post_variants` reads to tell the agent how far over it is.
    expect(r.body.measured).toBeGreaterThan(LIMITS.MAX_SET_PROGRAM_BYTES);
    expect(r.body.allowed).toBe(LIMITS.MAX_SET_PROGRAM_BYTES);
    expect(h.space.runtime.variantSets.get(setId)?.variants).toHaveLength(4);
  });

  test("a hand-made batch over the program limit is refused", () => {
    const h = makeHarness();
    const s = h.connect(member(ADA));
    h.send(s, {
      v: 1,
      type: "interaction-create",
      frameUrl: PAGE,
      nonce: "n1",
      kind: "change",
      anchor: { level: "page" },
      change: { intent: "batch", method: "manual-batch" },
    });
    const id = framesOf(s, "interaction-receipt")[0].interactionId as string;
    // A frame can't carry this much; the operation still refuses it on its own.
    const out = batchOp(h.space.runtime, member(ADA), id, bigProgram(300));
    expect(out).toMatchObject({ ok: false, code: "invalid", reason: "program-too-large" });
  });

  test("kept programs that would overflow the page frame are dropped oldest first; the frame parses", async () => {
    const h = makeHarness();
    const s = h.connect(member(ADA));
    const edits: string[] = [];
    for (let i = 0; i < 5; i++) {
      const { setId, editId } = createSet(h, s);
      await postVariants(h, setId, [bigProgram(224)]);
      h.clock.advance(1_000);
      h.send(s, pickFrame(h, setId, 0));
      edits.push(editId);
    }
    const frame = buildInteractionsState(h.space.runtime, PAGE, { kind: "member", role: "member" });
    const raw = JSON.stringify(frame);
    expect(raw.length).toBeLessThanOrEqual(LIMITS.MAX_OUTBOUND_FRAME_CHARS);
    expect(parseOutbound(raw).ok).toBe(true);
    expect(frame.truncated).toBe(true);
    expect(frame.interactions).toHaveLength(5);
    const kept = (frame.kept ?? []).map((k) => k.interactionId);
    expect(kept.length).toBeGreaterThan(0);
    expect(kept.length).toBeLessThan(5);
    expect(kept).toEqual(edits.slice(-kept.length));
  });
});

describe("storage before memory (finding 7) and atomic submissions (finding 8)", () => {
  test("a pick whose write fails leaves memory and storage as they were", async () => {
    const h = makeHarness();
    const s = h.connect(member(ADA));
    const { setId, editId } = createSet(h, s);
    await postVariants(h, setId, [calm]);
    const rt = h.space.runtime;
    const append = rt.interactionStore.append;
    rt.interactionStore.append = (entry, state) => {
      if (entry.k === "int-pick") throw new Error("row too big");
      return append(entry, state);
    };
    expect(() => h.send(s, pickFrame(h, setId, 0))).toThrow("row too big");
    rt.interactionStore.append = append;
    expect(rt.variantSets.get(setId)?.status).toBe("previewing");
    expect(rt.interactions.get(editId)?.state).toBe("working");
    h.evict();
    expect(h.space.runtime.variantSets.get(setId)?.status).toBe("previewing");
  });

  test("a refused submission on a picked set does not reopen it", async () => {
    const h = makeHarness();
    const s = h.connect(member(ADA));
    const { setId, editId } = createSet(h, s);
    await postVariants(h, setId, [calm]);
    h.send(s, pickFrame(h, setId, 0));
    const before = { set: variantEvents(h, setId), edit: editEvents(h, editId) };
    const dup = h.space.runtime.variantSets.get(setId)?.variants[0]?.variantId;
    const r = await h.request(member(ADA, "agent"), "POST", `/variant-set/${setId}/variants`, {
      variants: [{ variantId: dup, label: "again", program: calm }],
    });
    expect(r.status).toBe(409);
    const out = await h.request(member(ADA, "agent"), "POST", `/variant-set/${setId}/variants/7`, {
      program: calm,
    });
    expect(out.status).toBe(409);
    expect(h.space.runtime.variantSets.get(setId)?.status).toBe("implementing");
    expect(h.space.runtime.interactions.get(editId)?.state).toBe("kept");
    expect({ set: variantEvents(h, setId), edit: editEvents(h, editId) }).toEqual(before);
  });
});

describe("the block's text rides the Edit's anchor (minor)", () => {
  test("a block variant set copies the block's snippet onto the Edit's anchor", () => {
    const h = makeHarness();
    const s = h.connect(member(ADA));
    const { editId } = createSet(h, s);
    expect(h.space.runtime.interactions.get(editId)?.anchor).toMatchObject({
      level: "element",
      selector: "main > h1",
      snippet: "Pricing",
    });
  });
});

describe("a full picked set refuses an append without reopening (review 2, finding 5)", () => {
  test("the count refusal leaves the set picked, in memory, in storage and in replay", async () => {
    const h = makeHarness();
    const s = h.connect(member(ADA));
    const { setId } = createSet(h, s);
    for (let i = 0; i < LIMITS.MAX_VARIANTS_PER_SET; i += 5) {
      await postVariants(h, setId, [calm, calm, calm, calm, calm]);
    }
    h.send(s, pickFrame(h, setId, 0));
    expect(h.space.runtime.variantSets.get(setId)?.status).toBe("implementing");
    const r = await postVariants(h, setId, [calm]);
    expect(r.status).toBe(400);
    expect(r.body.error.reason).toBe("count");
    h.evict();
    const set = h.space.runtime.variantSets.get(setId);
    expect(set?.status).toBe("implementing");
    expect(h.space.runtime.variantStore.replayFromEvents(setId)).toEqual(set);
  });
});

describe("the Ready to verify notification is a preview", () => {
  test("an intent that opens with a fence reaches the requester as its code, no markers", async () => {
    const h = makeHarness();
    const s = h.connect(member(ADA));
    const { setId, editId } = createSet(h, s, {
      element: element("src/Pricing.tsx:4:2"),
      command: "```css\na { color: teal }\n```\nmake it calmer",
    });
    await postVariants(h, setId, [calm]);
    h.send(s, pickFrame(h, setId, 0));
    const agent = member(ADA, "agent");
    await h.request(agent, "POST", `/interaction/${editId}/state`, { state: "implemented" });
    const told = framesOf(s, "notify").at(-1);
    expect(told).toMatchObject({ interactionId: editId, body: "Ready to verify" });
    expect(told.title).toBe("a { color: teal }\nmake it calmer");
    // What the agent reads stays as written.
    expect(h.space.runtime.interactions.get(editId)?.change?.intent).toContain("```css");
  });
});
