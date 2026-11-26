import { describe, expect, test } from "bun:test";
import { ADA, BEA, framesOf, makeHarness, member, PAGE } from "./testing/harness";

/**
 * The follow-up round's message paths: every send carries a request id and a
 * repeat answers with the first (M-1), a create's nonce does the same for a
 * retried create (M-2), and pill spans are checked when written (M-4).
 */

const anchored = (text: string) => ({
  kind: "comment",
  url: PAGE,
  anchor: { level: "element", selector: "main > h1", snippet: "Pricing" },
  body: { text },
});

async function seed() {
  const h = makeHarness();
  const ada = member(ADA);
  const made = await h.request(ada, "POST", "/interaction", anchored("first"));
  return { h, ada, id: made.body.interactionId as string };
}

const reply = (id: string, text: string, clientId?: string) => ({
  v: 1,
  type: "interaction-reply",
  frameUrl: PAGE,
  interactionId: id,
  body: { text },
  ...(clientId !== undefined ? { clientId } : {}),
});

describe("M-1: a repeated send answers with its first message", () => {
  test("a socket reply sent twice with one clientId adds one message; both receipts echo it", async () => {
    const { h, id } = await seed();
    const s = h.connect(member(ADA));
    h.send(s, reply(id, "hello", "c-1"));
    h.send(s, reply(id, "hello", "c-1"));
    const thread = h.space.runtime.interactions.get(id)?.thread ?? [];
    expect(thread.filter((m) => m.body.text === "hello")).toHaveLength(1);
    const receipts = framesOf(s, "interaction-receipt");
    expect(receipts).toHaveLength(2);
    for (const r of receipts) expect(r).toMatchObject({ kind: "reply", ok: true, clientId: "c-1" });
    // The repeat broadcast nothing new: one state push for the one message.
    expect(framesOf(s, "interactions-state")).toHaveLength(1);
  });

  test("the request id is per person: another person's same id is their own send", async () => {
    const { h, id } = await seed();
    const ada = h.connect(member(ADA));
    const bea = h.connect(member(BEA));
    h.send(ada, reply(id, "from ada", "same"));
    h.send(bea, reply(id, "from bea", "same"));
    const texts = (h.space.runtime.interactions.get(id)?.thread ?? []).map((m) => m.body.text);
    expect(texts).toEqual(["first", "from ada", "from bea"]);
  });

  test("a send without a clientId keeps working, and adds a message every time", async () => {
    const { h, id } = await seed();
    const s = h.connect(member(ADA));
    h.send(s, reply(id, "again"));
    h.send(s, reply(id, "again"));
    const thread = h.space.runtime.interactions.get(id)?.thread ?? [];
    expect(thread.filter((m) => m.body.text === "again")).toHaveLength(2);
    const receipts = framesOf(s, "interaction-receipt");
    expect(receipts.every((r) => !("clientId" in r))).toBe(true);
  });

  test("the HTTP reply route answers a repeat with the first msgId and echoes the clientId", async () => {
    const { h, ada, id } = await seed();
    const first = await h.request(ada, "POST", `/interaction/${id}/reply`, {
      body: { text: "over http" },
      clientId: "h-1",
    });
    const again = await h.request(ada, "POST", `/interaction/${id}/reply`, {
      body: { text: "over http" },
      clientId: "h-1",
    });
    expect(first.body).toMatchObject({ ok: true, clientId: "h-1" });
    expect(again.body).toEqual(first.body);
    const thread = h.space.runtime.interactions.get(id)?.thread ?? [];
    expect(thread.filter((m) => m.body.text === "over http")).toHaveLength(1);
  });

  test("the id survives an eviction (journaled), and never reaches a snapshot", async () => {
    const { h, ada, id } = await seed();
    await h.request(ada, "POST", `/interaction/${id}/reply`, {
      body: { text: "once" },
      clientId: "e-1",
    });
    h.evict();
    const again = await h.request(ada, "POST", `/interaction/${id}/reply`, {
      body: { text: "once" },
      clientId: "e-1",
    });
    expect(again.body).toMatchObject({ ok: true, msgId: "m2" });
    const read = await h.request(ada, "GET", `/interaction/${id}`);
    const thread = read.body.interaction.thread as Array<Record<string, unknown>>;
    expect(thread.map((m) => m.body)).toEqual([{ text: "first" }, { text: "once" }]);
    expect(thread.some((m) => "clientId" in m)).toBe(false);
    expect(JSON.stringify(read.body)).not.toContain("e-1");
  });

  test("a refused frame's receipt echoes the clientId, so its sender settles", async () => {
    const h = makeHarness();
    const made = await h.request(member(ADA), "POST", "/interaction", anchored("x"));
    const id = made.body.interactionId as string;
    const s = h.connect(member(ADA));
    h.send(s, { ...reply(id, "x", "bad-1"), frameUrl: "https://elsewhere.test/" });
    expect(framesOf(s, "interaction-receipt").at(-1)).toMatchObject({
      ok: false,
      reason: "url-mismatch",
      clientId: "bad-1",
    });
  });
});

describe("M-2: a retried create answers with the first", () => {
  test("interaction-create with a nonce already used by this person makes nothing new", async () => {
    const h = makeHarness();
    const s = h.connect(member(ADA));
    const create = {
      v: 1,
      type: "interaction-create",
      frameUrl: PAGE,
      nonce: "n-1",
      kind: "comment",
      anchor: { level: "page" },
      body: { text: "once" },
    };
    h.send(s, create);
    h.send(s, create);
    const receipts = framesOf(s, "interaction-receipt");
    expect(receipts).toHaveLength(2);
    expect(receipts[0]).toMatchObject({ ok: true, nonce: "n-1" });
    expect(receipts[1]).toEqual(receipts[0]);
    expect(h.space.runtime.interactions.size).toBe(1);
  });

  test("variant-create with a repeated nonce answers with the first set", async () => {
    const h = makeHarness();
    const s = h.connect(member(ADA));
    const create = {
      v: 1,
      type: "variant-create",
      nonce: "v-1",
      frameUrl: PAGE,
      root: { kind: "page" },
      command: "make it dark",
      count: 2,
    };
    h.send(s, create);
    h.send(s, create);
    const states = framesOf(s, "variant-state").filter((f) => f.nonce === "v-1");
    expect(states).toHaveLength(2);
    expect(states[1]?.setId).toBe(states[0]?.setId);
    expect(h.space.runtime.variantSets.size).toBe(1);
    expect(h.space.runtime.interactions.size).toBe(1);
  });
});

describe("M-4: pill spans are checked when written", () => {
  test("a span that holds its pill is kept; one that doesn't, or runs out of the text, is dropped", async () => {
    const { h, ada, id } = await seed();
    await h.request(ada, "POST", `/interaction/${id}/reply`, {
      body: {
        text: "ping @agent and #Pricing now",
        tokens: [
          { t: "agent", spans: [{ start: 5, length: 6 }] },
          {
            t: "anchor",
            anchor: { level: "page" },
            label: "Pricing",
            spans: [
              { start: 16, length: 8 },
              { start: 0, length: 4 },
              { start: 25, length: 40 },
            ],
          },
          { t: "actor", actorId: BEA, spans: [{ start: 0, length: 4 }] },
        ],
      },
    });
    const msg = h.space.runtime.interactions.get(id)?.thread.at(-1);
    expect(msg?.body.tokens).toEqual([
      { t: "agent", spans: [{ start: 5, length: 6 }] },
      {
        t: "anchor",
        anchor: { level: "page" },
        label: "Pricing",
        spans: [{ start: 16, length: 8 }],
      },
      { t: "actor", actorId: BEA },
    ]);
  });

  test("a span must be whole UTF-16 numbers inside the text's limit (the schema refuses others)", async () => {
    const { h, ada, id } = await seed();
    const r = await h.request(ada, "POST", `/interaction/${id}/reply`, {
      body: { text: "@agent", tokens: [{ t: "agent", spans: [{ start: -1, length: 6 }] }] },
    });
    expect(r.status).toBe(400);
  });
});
