import { describe, expect, test } from "bun:test";
import { ADA, framesOf, type Json, makeHarness, member, PAGE } from "./testing/harness";

/**
 * A block inside a frame that has no address of its own (A-3): its anchor
 * carries `framePath`. The space validates it, stores and journals it, sends
 * it back in snapshots, and takes a loss only from a client that looked for
 * the block inside those frames.
 */

const FRAMED = {
  level: "element",
  selector: "p#blank-text",
  framePath: ["iframe#blank"],
  snippet: "In a blank frame.",
};

const create = (anchor: unknown, nonce = crypto.randomUUID()) => ({
  v: 1,
  type: "interaction-create",
  frameUrl: PAGE,
  kind: "comment",
  anchor,
  body: { text: "inside the frame" },
  nonce,
});

function snapshotOf(h: ReturnType<typeof makeHarness>, id: string): Json {
  const s = h.connect(member(ADA));
  h.send(s, { v: 1, type: "interaction-sync", frameUrl: PAGE });
  const [state] = framesOf(s, "interactions-state");
  return (state?.interactions as Json[]).find((i) => i.id === id);
}

describe("A-3: an anchor's framePath", () => {
  test("is stored, journaled and returned in snapshots", async () => {
    const h = makeHarness();
    const ada = h.connect(member(ADA));
    await h.send(ada, create(FRAMED));
    const [receipt] = framesOf(ada, "interaction-receipt");
    const id = receipt?.interactionId as string;
    expect(id).toBeTruthy();
    expect(snapshotOf(h, id).anchor).toEqual(FRAMED);
    // Replayed from the journal after an eviction.
    h.evict();
    expect(snapshotOf(h, id).anchor).toEqual(FRAMED);
    const read = await h.request(member(ADA), "GET", `/interaction/${id}`);
    expect(read.body.interaction.anchor.framePath).toEqual(["iframe#blank"]);
  });

  test("a malformed one refuses the create", async () => {
    const h = makeHarness();
    const ada = h.connect(member(ADA));
    for (const framePath of [[], ["a", "b", "c", "d", "e"], ["iframe\u0007"], ["x".repeat(1_025)]])
      await h.send(ada, create({ ...FRAMED, framePath }));
    expect(framesOf(ada, "interaction-receipt").filter((r) => r.ok === true)).toHaveLength(0);
    expect(h.space.runtime.interactions.size).toBe(0);
  });

  test("a loss counts only from a client that resolved the frames", async () => {
    const h = makeHarness();
    const ada = h.connect(member(ADA));
    await h.send(ada, create(FRAMED));
    const id = framesOf(ada, "interaction-receipt")[0]?.interactionId as string;
    const lost = (extra: Record<string, unknown>) =>
      h.send(ada, {
        v: 1,
        type: "interaction-anchor-lost",
        frameUrl: PAGE,
        interactionId: id,
        ...extra,
      });
    // A client that ignores framePath looked in the owner document: not taken.
    await lost({});
    expect(h.space.runtime.interactions.get(id)?.anchorLost).toBeUndefined();
    await lost({ framed: true });
    expect(h.space.runtime.interactions.get(id)?.anchorLost).toBe(true);
  });

  test("a loss of an anchor without frames needs no marker", async () => {
    const h = makeHarness();
    const ada = h.connect(member(ADA));
    await h.send(ada, create({ level: "element", selector: "h1" }));
    const id = framesOf(ada, "interaction-receipt")[0]?.interactionId as string;
    await h.send(ada, { v: 1, type: "interaction-anchor-lost", frameUrl: PAGE, interactionId: id });
    expect(h.space.runtime.interactions.get(id)?.anchorLost).toBe(true);
  });
});

describe("2-A4: only the page an anchor is on reports it lost", () => {
  test("a deeper route, a query or a fragment of the page is not the page", async () => {
    const h = makeHarness();
    const ada = h.connect(member(ADA));
    await h.send(ada, create({ level: "element", selector: "h1" }));
    const id = framesOf(ada, "interaction-receipt")[0]?.interactionId as string;
    for (const frameUrl of [`${PAGE}/details`, `${PAGE}?tab=2`, `${PAGE}#notes`]) {
      await h.send(ada, {
        v: 1,
        type: "interaction-anchor-lost",
        frameUrl,
        interactionId: id,
        framed: true,
      });
      expect(h.space.runtime.interactions.get(id)?.anchorLost).toBeUndefined();
    }
    await h.send(ada, {
      v: 1,
      type: "interaction-anchor-lost",
      frameUrl: PAGE,
      interactionId: id,
      framed: true,
    });
    expect(h.space.runtime.interactions.get(id)?.anchorLost).toBe(true);
  });
});

describe("3-A1: only the page a thread is on re-anchors it", () => {
  test("a deeper route, a query or a fragment is refused; the exact page moves the anchor", async () => {
    const h = makeHarness();
    const ada = h.connect(member(ADA));
    await h.send(ada, create({ level: "element", selector: "h1" }));
    const id = framesOf(ada, "interaction-receipt")[0]?.interactionId as string;
    const reanchor = (frameUrl: string) =>
      h.send(ada, {
        v: 1,
        type: "interaction-reanchor",
        frameUrl,
        interactionId: id,
        anchor: { level: "element", selector: "h2" },
      });
    for (const frameUrl of [`${PAGE}/details`, `${PAGE}?tab=2`, `${PAGE}#notes`]) {
      ada.sent.length = 0;
      await reanchor(frameUrl);
      expect(framesOf(ada, "interaction-receipt")).toMatchObject([
        { kind: "reanchor", ok: false, reason: "url-mismatch" },
      ]);
      expect(h.space.runtime.interactions.get(id)?.anchor).toEqual({
        level: "element",
        selector: "h1",
      });
    }
    ada.sent.length = 0;
    await reanchor(PAGE);
    expect(framesOf(ada, "interaction-receipt")).toMatchObject([{ kind: "reanchor", ok: true }]);
    expect(h.space.runtime.interactions.get(id)?.anchor).toEqual({
      level: "element",
      selector: "h2",
    });
  });
});
