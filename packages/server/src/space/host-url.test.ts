import { describe, expect, test } from "bun:test";
import { ADA, framesOf, makeHarness, member } from "./testing/harness";

/**
 * Blocks inside a frame (round 3, F-3): a create from a child frame is bound
 * to the frame's own address, and carries the page the person shares
 * (`hostUrl`) for display. It is stored, journaled, and returned in
 * snapshots, by-id reads and attention rows; the binding never uses it.
 */

const FRAME = "https://tree.content.example/goals/ceo/";
const SHELL = "https://dossier.example/atlas42/goals/ceo/";

const create = (extra: Record<string, unknown> = {}) => ({
  v: 1,
  type: "interaction-create",
  frameUrl: FRAME,
  nonce: "n-1",
  kind: "comment",
  anchor: { level: "element", selector: "#goal > p", snippet: "Goal" },
  body: { text: "Is this the plan?" },
  ...extra,
});

describe("hostUrl", () => {
  test("is kept with the interaction and returned everywhere it is read", async () => {
    const h = makeHarness();
    const ada = member(ADA);
    const s = h.connect(ada);
    h.send(s, create({ hostUrl: SHELL }));
    const [receipt] = framesOf(s, "interaction-receipt");
    expect(receipt).toMatchObject({ kind: "create", ok: true });
    const id = receipt.interactionId as string;
    expect(h.space.runtime.interactions.get(id)).toMatchObject({ url: FRAME, hostUrl: SHELL });

    // The state push to the frame's page carries it.
    const state = framesOf(s, "interactions-state").at(-1);
    expect(state.interactions[0]).toMatchObject({ id, url: FRAME, hostUrl: SHELL });

    // The by-id read and the attention rows carry it.
    const read = await h.request(ada, "GET", `/interaction/${id}`);
    expect(read.body.interaction).toMatchObject({ url: FRAME, hostUrl: SHELL });
    const attention = await h.request(ada, "GET", "/attention");
    const rows = [
      ...attention.body.needsYou,
      ...attention.body.waiting,
      ...attention.body.recent,
    ].filter((r: { interactionId: string }) => r.interactionId === id);
    expect(rows.length).toBeGreaterThan(0);
    for (const r of rows) expect(r).toMatchObject({ url: FRAME, hostUrl: SHELL });

    // Journaled: a fresh runtime over the same database still has it.
    h.evict();
    expect(h.space.runtime.interactions.get(id)).toMatchObject({ url: FRAME, hostUrl: SHELL });
  });

  test("never binds: a frame on the shared page cannot act on the thread", async () => {
    const h = makeHarness();
    const s = h.connect(member(ADA));
    h.send(s, create({ hostUrl: SHELL }));
    const id = framesOf(s, "interaction-receipt")[0].interactionId as string;
    h.send(s, {
      v: 1,
      type: "interaction-reply",
      frameUrl: SHELL,
      interactionId: id,
      body: { text: "from the shell" },
    });
    expect(framesOf(s, "interaction-receipt").at(-1)).toMatchObject({
      kind: "reply",
      ok: false,
      reason: "url-mismatch",
    });
    // The frame's own address can.
    h.send(s, {
      v: 1,
      type: "interaction-reply",
      frameUrl: FRAME,
      interactionId: id,
      body: { text: "from the frame" },
    });
    expect(framesOf(s, "interaction-receipt").at(-1)).toMatchObject({ kind: "reply", ok: true });
  });

  test("is refused when it is not a web page's address (2-F7)", async () => {
    const h = makeHarness();
    const s = h.connect(member(ADA));
    for (const bad of ["javascript:alert(1)", "data:text/html,hi", "not a url"]) {
      h.send(s, create({ hostUrl: bad, nonce: `n-${bad.length}` }));
      expect(framesOf(s, "interaction-receipt").at(-1)).toMatchObject({
        kind: "create",
        ok: false,
        reason: "host-url",
      });
    }
    expect(h.space.runtime.interactions.size).toBe(0);
  });

  test("is kept as origin + path only, whatever a full client sends (2-F7)", async () => {
    const h = makeHarness();
    const s = h.connect(member(ADA));
    h.send(s, create({ hostUrl: "https://user:secret@dossier.example/goals/ceo/?token=abc#frag" }));
    const id = framesOf(s, "interaction-receipt")[0].interactionId as string;
    expect(h.space.runtime.interactions.get(id)?.hostUrl).toBe(
      "https://dossier.example/goals/ceo/?…",
    );
  });

  test("too long once percent-encoded is left out, and the create still succeeds (3-F6)", async () => {
    const h = makeHarness();
    const s = h.connect(member(ADA));
    // 1,000 characters as sent, each `é` three times longer encoded.
    const raw = `https://dossier.example/${"é".repeat(976)}`;
    expect(raw.length).toBeLessThanOrEqual(2048);
    h.send(s, create({ hostUrl: raw }));
    const [receipt] = framesOf(s, "interaction-receipt");
    expect(receipt).toMatchObject({ kind: "create", ok: true });
    const id = receipt.interactionId as string;
    expect(h.space.runtime.interactions.get(id)?.hostUrl).toBeUndefined();
    expect(framesOf(s, "interactions-state").at(-1).interactions[0].hostUrl).toBeUndefined();
  });

  test("is absent for a top-frame create", async () => {
    const h = makeHarness();
    const s = h.connect(member(ADA));
    h.send(s, create());
    const id = framesOf(s, "interaction-receipt")[0].interactionId as string;
    expect(h.space.runtime.interactions.get(id)?.hostUrl).toBeUndefined();
    expect(framesOf(s, "interactions-state").at(-1).interactions[0].hostUrl).toBeUndefined();
  });
});
