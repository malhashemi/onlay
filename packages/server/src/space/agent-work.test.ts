import { describe, expect, test } from "bun:test";
import { LIMITS } from "@onlay/protocol";
import { ADA, BEA, GUS, guest, makeHarness, member, PAGE, SID } from "./testing/harness";

/**
 * Agent work end to end (spec §7): a member's `@agent` asks for an agent, the
 * listing splits yours from teammates', take honours the requester and the
 * lease, an agent's write answers and is marked agent, and attention follows.
 */

async function seed() {
  const h = makeHarness();
  const ada = member(ADA);
  const created = await h.request(ada, "POST", "/interaction", {
    kind: "comment",
    url: PAGE,
    anchor: {
      level: "element",
      selector: "main > h1",
      sourcePointer: "src/Pricing.tsx:4:2",
      provenance: "github.com/acme/site@abc1234;main;clean",
    },
    body: { text: "can an agent tighten this?", tokens: [{ t: "agent" }] },
  });
  const id = created.body.interactionId as string;
  return { h, ada, id, adaAgent: member(ADA, "agent"), beaAgent: member(BEA, "agent") };
}

describe("agent work", () => {
  test("a member's @agent makes it pending; the listing splits yours from teammates'", async () => {
    const { h, id, adaAgent, beaAgent } = await seed();
    const mine = await h.request(adaAgent, "GET", "/agent-work");
    expect(mine.body.yours).toHaveLength(1);
    expect(mine.body.yours[0]).toMatchObject({
      ref: `${SID}/${id}`,
      kind: "comment",
      url: PAGE,
      spaceId: SID,
      spaceName: "acme",
      status: "pending",
      requestedBy: { id: ADA },
    });
    expect(mine.body.teammates).toEqual([]);
    const theirs = await h.request(beaAgent, "GET", "/agent-work");
    expect(theirs.body.yours).toEqual([]);
    expect(theirs.body.teammates).toHaveLength(1);
  });

  test("the listing filters by url, origin and repo", async () => {
    const { h, adaAgent } = await seed();
    const n = async (q: string) =>
      (await h.request(adaAgent, "GET", `/agent-work?${q}`)).body.yours.length;
    expect(await n(`url=${encodeURIComponent(PAGE)}`)).toBe(1);
    expect(await n(`url=${encodeURIComponent("https://example.com/other")}`)).toBe(0);
    expect(await n("origin=https%3A%2F%2Fexample.com")).toBe(1);
    expect(await n("origin=https%3A%2F%2Fevil.test")).toBe(0);
    expect(await n("repo=github.com%2Facme%2Fsite")).toBe(1);
    expect(await n("repo=github.com%2Facme%2Fother")).toBe(0);
  });

  test("take: the requester's agent, or a teammate's with onBehalf; a held lease refuses others", async () => {
    const { h, id, adaAgent, beaAgent } = await seed();
    const notYours = await h.request(beaAgent, "POST", `/interaction/${id}/agent/take`);
    expect(notYours.body.error).toMatchObject({ code: "forbidden", reason: "not-yours" });
    const onBehalf = await h.request(beaAgent, "POST", `/interaction/${id}/agent/take`, {
      onBehalf: true,
    });
    expect(onBehalf.status).toBe(200);
    expect(onBehalf.body.agentWork).toMatchObject({
      status: "taken",
      takenBy: BEA,
      requestedBy: ADA,
    });
    expect(onBehalf.body.agentWork.leaseUntil).toBe(h.clock.now() + LIMITS.AGENT_LEASE_MS);
    const held = await h.request(adaAgent, "POST", `/interaction/${id}/agent/take`);
    expect(held.body.error).toMatchObject({ code: "conflict", reason: "held" });
    // An expired lease reads as pending, and the requester's agent may take it.
    h.clock.advance(LIMITS.AGENT_LEASE_MS + 1);
    const listing = await h.request(adaAgent, "GET", "/agent-work");
    expect(listing.body.yours[0].status).toBe("pending");
    expect((await h.request(adaAgent, "POST", `/interaction/${id}/agent/take`)).status).toBe(200);
  });

  test("release returns a taken item to pending; only the holder may release", async () => {
    const { h, id, adaAgent, beaAgent } = await seed();
    await h.request(adaAgent, "POST", `/interaction/${id}/agent/take`);
    expect((await h.request(beaAgent, "POST", `/interaction/${id}/agent/release`)).status).toBe(
      409,
    );
    const released = await h.request(adaAgent, "POST", `/interaction/${id}/agent/release`);
    expect(released.body.agentWork.status).toBe("pending");
  });

  test("an agent's reply is agent-marked, answers the work, and lands in the requester's needs-you", async () => {
    const { h, ada, id, adaAgent } = await seed();
    const before = await h.request(ada, "GET", "/attention");
    expect(before.body.waiting.map((r: { interactionId: string }) => r.interactionId)).toContain(
      id,
    );
    expect(before.body.waiting[0].agentWork).toBe("pending");
    await h.request(adaAgent, "POST", `/interaction/${id}/agent/take`);
    const reply = await h.request(adaAgent, "POST", `/interaction/${id}/reply`, {
      body: { text: "done — tightened the heading" },
    });
    expect(reply.status).toBe(200);
    const read = await h.request(ada, "GET", `/interaction/${id}`);
    const last = read.body.interaction.thread.at(-1);
    expect(last).toMatchObject({ authorId: ADA, agent: true });
    expect(read.body.interaction.agentWork.status).toBe("answered");
    const after = await h.request(ada, "GET", "/attention");
    expect(after.body.needsYou.map((r: { interactionId: string }) => r.interactionId)).toEqual([
      id,
    ]);
    expect((await h.request(adaAgent, "GET", "/agent-work")).body.yours).toEqual([]);
  });

  test("agents may not resolve, react, or attach; a guest's agent only replies where shared", async () => {
    const { h, id, adaAgent } = await seed();
    expect(
      (await h.request(adaAgent, "POST", `/interaction/${id}/resolve`)).body.error.reason,
    ).toBe("agent");
    const react = await h.request(adaAgent, "POST", `/interaction/${id}/react`, {
      msgId: "m1",
      emoji: "👍",
    });
    expect(react.body.error.reason).toBe("agent");
    const guestAgent = guest(GUS, [id], "agent");
    expect(
      (await h.request(guestAgent, "POST", `/interaction/${id}/reply`, { body: { text: "hi" } }))
        .status,
    ).toBe(200);
    expect(
      (await h.request(guestAgent, "POST", `/interaction/${id}/agent/take`, { onBehalf: true }))
        .status,
    ).toBe(403);
  });

  test("a guest's @agent never asks for an agent", async () => {
    const h = makeHarness();
    const created = await h.request(member(ADA), "POST", "/interaction", {
      kind: "comment",
      url: PAGE,
      anchor: { level: "page" },
      body: { text: "hello" },
    });
    const id = created.body.interactionId;
    await h.request(guest(GUS, [id]), "POST", `/interaction/${id}/reply`, {
      body: { text: "agent please", tokens: [{ t: "agent" }] },
    });
    const read = await h.request(member(ADA), "GET", `/interaction/${id}`);
    expect(read.body.interaction.agentWork).toBeUndefined();
  });

  test("wait resolves at the next journal event, or times out", async () => {
    const { h, ada, id, adaAgent } = await seed();
    const { body } = await h.request(adaAgent, "GET", `/interaction/${id}`);
    const since = body.seq as number;
    const quiet = await h.request(
      adaAgent,
      "GET",
      `/interaction/${id}/wait?since=${since}&timeout=0.02`,
    );
    expect(quiet.body).toMatchObject({ ok: true, events: [], timedOut: true, seq: since });
    const pending = h.request(adaAgent, "GET", `/interaction/${id}/wait?since=${since}&timeout=5`);
    await h.request(ada, "POST", `/interaction/${id}/reply`, { body: { text: "any news?" } });
    const woke = await pending;
    expect(woke.body.events[0]).toMatchObject({ k: "int-msg" });
    expect(woke.body.seq).toBeGreaterThan(since);
    expect(woke.body.interaction.thread.at(-1).body.text).toBe("any news?");
    expect(
      (await h.request(adaAgent, "GET", `/interaction/${id}/wait?since=0&timeout=26`)).status,
    ).toBe(400);
  });
});

/* ── second review: findings 1, 2, 3, 7, 9, 15, 17, 18 and the guest pick ── */

const calm = [
  { op: "setStyle" as const, target: ":scope", props: [{ prop: "color", value: "slateblue" }] },
];
const block = (sourcePointer?: string) => ({
  selector: "main > h1",
  tag: "h1",
  classes: [],
  textSnippet: "Pricing",
  markup: "<h1>Pricing</h1>",
  ...(sourcePointer ? { sourcePointer } : {}),
});

function editWithSet(h: ReturnType<typeof makeHarness>, sourcePointer?: string) {
  const s = h.connect(member(ADA));
  h.send(s, {
    v: 1,
    type: "variant-create",
    nonce: "n1",
    frameUrl: PAGE,
    root: { kind: "block", element: block(sourcePointer) },
    command: "calmer",
    count: 1,
  });
  const frame = s.frames().find((f) => (f as { type?: string }).type === "variant-state") as {
    setId: string;
    changeInteractionId: string;
  };
  return { s, setId: frame.setId, editId: frame.changeInteractionId };
}

describe("a held item refuses other people's agents (finding 1)", () => {
  test("reply, variants and Edit state from another person's agent are refused as held", async () => {
    const h = makeHarness();
    const { setId, editId } = editWithSet(h, "src/Pricing.tsx:4:2");
    const adaAgent = member(ADA, "agent");
    const beaAgent = member(BEA, "agent");
    expect((await h.request(adaAgent, "POST", `/interaction/${editId}/agent/take`)).status).toBe(
      200,
    );
    const before = h.space.runtime.journal.lastSeq("interaction", editId);
    const refusals = [
      await h.request(beaAgent, "POST", `/interaction/${editId}/reply`, { body: { text: "mine" } }),
      await h.request(beaAgent, "POST", `/variant-set/${setId}/variants`, {
        variants: [{ label: "B", program: calm }],
      }),
      await h.request(beaAgent, "POST", `/interaction/${editId}/state`, { state: "working" }),
    ];
    for (const r of refusals) {
      expect(r.status).toBe(409);
      expect(r.body.error.reason).toBe("held");
    }
    expect(h.space.runtime.journal.lastSeq("interaction", editId)).toBe(before);
    expect(h.space.runtime.variantSets.get(setId)?.variants).toEqual([]);
    // The holder's own write goes through; a person still writes freely.
    expect(
      (
        await h.request(adaAgent, "POST", `/interaction/${editId}/reply`, {
          body: { text: "on it" },
        })
      ).status,
    ).toBe(200);
    expect(
      (
        await h.request(member(BEA), "POST", `/interaction/${editId}/reply`, {
          body: { text: "hi" },
        })
      ).status,
    ).toBe(200);
  });
});

describe("closing ends agent work (finding 2)", () => {
  test("a resolved item leaves the listing and stays out after reopening; a lapsed release is a no-op", async () => {
    const { h, ada, id, adaAgent } = await seed();
    await h.request(adaAgent, "POST", `/interaction/${id}/agent/take`);
    await h.request(ada, "POST", `/interaction/${id}/resolve`);
    expect((await h.request(adaAgent, "GET", "/agent-work")).body.yours).toEqual([]);
    await h.request(ada, "POST", `/interaction/${id}/reopen`);
    expect(h.space.runtime.interactions.get(id)?.agentWork).toBeUndefined();
    expect((await h.request(adaAgent, "GET", "/agent-work")).body.yours).toEqual([]);

    const again = await seed();
    await again.h.request(again.adaAgent, "POST", `/interaction/${again.id}/agent/take`);
    again.h.clock.advance(LIMITS.AGENT_LEASE_MS + 1);
    const seq = again.h.space.runtime.journal.lastSeq("interaction", again.id);
    const released = await again.h.request(
      member(BEA, "agent"),
      "POST",
      `/interaction/${again.id}/agent/release`,
    );
    expect(released.status).toBe(200);
    expect(released.body.agentWork.status).toBe("pending");
    expect(again.h.space.runtime.journal.lastSeq("interaction", again.id)).toBe(seq);
  });
});

describe("@agent added by an edit (finding 3)", () => {
  test("a member's edit asks for an agent; a guest's doesn't", async () => {
    const h = makeHarness();
    const ada = member(ADA);
    const id = (
      await h.request(ada, "POST", "/interaction", {
        kind: "comment",
        url: PAGE,
        anchor: { level: "page" },
        body: { text: "tighten this" },
      })
    ).body.interactionId as string;
    await h.request(ada, "POST", `/interaction/${id}/edit`, {
      msgId: "m1",
      body: { text: "@agent tighten this", tokens: [{ t: "agent" }] },
    });
    expect(h.space.runtime.interactions.get(id)?.agentWork).toMatchObject({
      status: "pending",
      requestedBy: ADA,
    });
    expect(h.space.runtime.interactionStore.replayFromEvents(id)?.agentWork?.status).toBe(
      "pending",
    );

    const other = (
      await h.request(ada, "POST", "/interaction", {
        kind: "comment",
        url: PAGE,
        anchor: { level: "page" },
        body: { text: "shared" },
      })
    ).body.interactionId as string;
    const gus = guest(GUS, [other]);
    const reply = await h.request(gus, "POST", `/interaction/${other}/reply`, {
      body: { text: "hm" },
    });
    await h.request(gus, "POST", `/interaction/${other}/edit`, {
      msgId: reply.body.msgId,
      body: { text: "@agent hm", tokens: [{ t: "agent" }] },
    });
    expect(h.space.runtime.interactions.get(other)?.agentWork).toBeUndefined();
  });
});

describe("an agent drives Edit state only where the source is known (finding 7)", () => {
  test("on an unowned kept Edit, set state is refused as no-source and the Edit stays kept", async () => {
    const h = makeHarness();
    const { s, setId, editId } = editWithSet(h);
    const agent = member(ADA, "agent");
    const posted = await h.request(agent, "POST", `/variant-set/${setId}/variants`, {
      variants: [{ label: "A", program: calm }],
    });
    const v = posted.body.set.variants[0];
    h.send(s, {
      v: 1,
      type: "variant-pick",
      setId,
      frameUrl: PAGE,
      variantId: v.variantId,
      version: v.version,
    });
    expect(h.space.runtime.interactions.get(editId)?.state).toBe("kept");
    for (const state of ["working", "implemented"]) {
      const r = await h.request(agent, "POST", `/interaction/${editId}/state`, { state });
      expect(r.status).toBe(403);
      expect(r.body.error.reason).toBe("no-source");
    }
    expect(h.space.runtime.interactions.get(editId)?.state).toBe("kept");
    // New variants are still the agent's way in: the Edit moves to working.
    await h.request(agent, "POST", `/variant-set/${setId}/variants`, {
      variants: [{ label: "B", program: calm }],
    });
    expect(h.space.runtime.interactions.get(editId)?.state).toBe("working");
  });
});

describe("a guest's pick on an owned Edit (admission table)", () => {
  test("the agent work goes to the Edit's author, not the guest", async () => {
    const h = makeHarness();
    const { setId, editId } = editWithSet(h, "src/Pricing.tsx:4:2");
    const posted = await h.request(member(ADA, "agent"), "POST", `/variant-set/${setId}/variants`, {
      variants: [{ label: "A", program: calm }],
    });
    const v = posted.body.set.variants[0];
    const picked = await h.request(guest(GUS, [editId]), "POST", `/variant-set/${setId}/pick`, {
      variantId: v.variantId,
      version: v.version,
    });
    expect(picked.body).toMatchObject({ ok: true, state: "working" });
    const edit = h.space.runtime.interactions.get(editId);
    expect(edit?.agentWork).toMatchObject({ status: "pending", requestedBy: ADA });
    expect(h.space.runtime.interactionStore.replayFromEvents(editId)?.agentWork?.requestedBy).toBe(
      ADA,
    );
    // The author's agent can take it.
    expect(
      (await h.request(member(ADA, "agent"), "POST", `/interaction/${editId}/agent/take`)).status,
    ).toBe(200);
  });
});

describe("URL binding guards page frames, not by-id HTTP (review 2, finding 9: by design)", () => {
  test("a socket frame from another page is refused; a member's by-id HTTP reply succeeds", async () => {
    const { h, id } = await seed();
    const s = h.connect(member(BEA));
    h.send(s, {
      v: 1,
      type: "interaction-reply",
      frameUrl: "https://elsewhere.test/",
      interactionId: id,
      body: { text: "from the wrong page" },
    });
    expect(s.frames().at(-1)).toMatchObject({ ok: false, reason: "url-mismatch" });
    const http = await h.request(member(BEA), "POST", `/interaction/${id}/reply`, {
      body: { text: "from the Inbox" },
    });
    expect(http.status).toBe(200);
  });
});

describe("programs are checked before they are stored (finding 15)", () => {
  test("page-root setText or replace at body/html/:root and malformed selectors are refused with their op", async () => {
    const h = makeHarness();
    const s = h.connect(member(ADA));
    h.send(s, {
      v: 1,
      type: "variant-create",
      nonce: "p1",
      frameUrl: PAGE,
      root: { kind: "page" },
      command: "x",
      count: 1,
    });
    const setId = (
      s.frames().find((f) => (f as { type?: string }).type === "variant-state") as {
        setId: string;
      }
    ).setId;
    const r = await h.request(member(ADA, "agent"), "POST", `/variant-set/${setId}/variants`, {
      variants: [
        { label: "ok", program: calm },
        { label: "body", program: [calm[0], { op: "setText", target: " BODY ", text: "x" }] },
        {
          label: "root",
          program: [{ op: "insertFragment", target: ":root", position: "replace", html: "<p/>" }],
        },
        { label: "bracket", program: [{ op: "setText", target: "div[data-x", text: "x" }] },
        { label: "quote", program: [{ op: "setText", target: 'a[title="x]', text: "x" }] },
        { label: "empty", program: [{ op: "setText", target: "  ", text: "x" }] },
        { label: "control", program: [{ op: "setText", target: "p\u0007", text: "x" }] },
      ],
    });
    expect(r.status).toBe(400);
    expect(r.body.results).toEqual([
      { ok: true },
      { ok: false, opIndex: 1, reason: "setText on the page root" },
      { ok: false, opIndex: 0, reason: "replace insert on the page root" },
      {
        ok: false,
        opIndex: 0,
        reason: "unbalanced brackets, parentheses or quotes in the selector",
      },
      {
        ok: false,
        opIndex: 0,
        reason: "unbalanced brackets, parentheses or quotes in the selector",
      },
      { ok: false, opIndex: 0, reason: "empty selector" },
      { ok: false, opIndex: 0, reason: "control characters in the selector" },
    ]);
    expect(h.space.runtime.variantSets.get(setId)?.variants).toEqual([]);
  });
});

describe("wait wakes on variant writes (finding 17)", () => {
  test("a second append on a working, answered Edit wakes a wait on it", async () => {
    const h = makeHarness();
    const { setId, editId } = editWithSet(h);
    const agent = member(ADA, "agent");
    await h.request(agent, "POST", `/variant-set/${setId}/variants`, {
      variants: [{ label: "A", program: calm }],
    });
    const since = h.space.runtime.journal.lastSeq("interaction", editId);
    const waiting = h.request(
      member(ADA),
      "GET",
      `/interaction/${editId}/wait?since=${since}&timeout=5`,
    );
    await h.request(agent, "POST", `/variant-set/${setId}/variants`, {
      variants: [{ label: "B", program: calm }],
    });
    const woke = await waiting;
    expect(woke.body.timedOut).toBeUndefined();
    expect(woke.body.events.map((e: { k: string }) => e.k)).toContain("int-variants");
  });
});

describe("repo filter compares the repository (finding 18)", () => {
  test("the same repository in another spelling matches; a longer name doesn't", async () => {
    const { h, adaAgent } = await seed();
    const n = async (repo: string) =>
      (await h.request(adaAgent, "GET", `/agent-work?repo=${encodeURIComponent(repo)}`)).body.yours
        .length;
    expect(await n("https://GitHub.com/acme/site.git")).toBe(1);
    expect(await n("git@github.com:acme/site.git")).toBe(1);
    expect(await n("github.com/acme/si")).toBe(0);
    expect(await n("github.com/acme/site-evil")).toBe(0);
  });
});

describe("row text: a person's preview, an agent's words as written", () => {
  test("a fenced block reads as its code for a person, before the cut; an agent reads the text", async () => {
    const h = makeHarness();
    const ada = member(ADA);
    // The opening fence sits right at the row cap: cut first, it would show.
    const lead = "x".repeat(LIMITS.MAX_ANCHOR_LABEL - 4);
    const text = `${lead}\n\`\`\`json\n{"a": 1}\n\`\`\``;
    const created = await h.request(ada, "POST", "/interaction", {
      kind: "comment",
      url: PAGE,
      anchor: { level: "page" },
      body: { text, tokens: [{ t: "agent" }] },
    });
    expect(created.status).toBe(200);
    const person = await h.request(ada, "GET", "/attention");
    const row = person.body.waiting[0].text as string;
    expect(row).not.toContain("```");
    expect(row).toBe(`${lead}\n{"a": 1}`.slice(0, LIMITS.MAX_ANCHOR_LABEL));

    const agent = member(ADA, "agent");
    const raw = text.slice(0, LIMITS.MAX_ANCHOR_LABEL);
    expect((await h.request(agent, "GET", "/attention")).body.waiting[0].text).toBe(raw);
    expect((await h.request(agent, "GET", "/agent-work")).body.yours[0].summary).toBe(raw);
    expect((await h.request(ada, "GET", "/agent-work")).body.yours[0].summary).not.toContain("```");
  });
});

describe("attention builds only the rows it sends", () => {
  test("each list is cut to the cap, the count stays whole, and the rows are previews", async () => {
    const h = makeHarness();
    const n = LIMITS.MAX_ATTENTION_ROWS + 5;
    for (let i = 0; i < n; i++) {
      await h.request(member(BEA), "POST", "/interaction", {
        kind: "comment",
        url: PAGE,
        anchor: { level: "page" },
        body: {
          text: `@Ada ${i}\n\`\`\`\ncode ${i}\n\`\`\``,
          tokens: [{ t: "actor", actorId: ADA }],
        },
      });
    }
    const got = await h.request(member(ADA), "GET", "/attention");
    expect(got.body.needsYou).toHaveLength(LIMITS.MAX_ATTENTION_ROWS);
    expect(got.body.needsYouCount).toBe(n);
    for (const r of got.body.needsYou as Array<{ text: string }>)
      expect(r.text).not.toContain("```");
  });
});

describe("an Ask answer keeps only the spans the server can vouch for", () => {
  test("an agent span over half an emoji is dropped", async () => {
    const h = makeHarness();
    const created = await h.request(member(ADA), "POST", "/interaction", {
      kind: "ask",
      url: PAGE,
      anchor: { level: "page" },
      ask: {
        question: "ok?",
        context: "c",
        options: [{ id: "y", label: "Yes" }],
        selection: { min: 1, max: 1, submit: "immediate" },
        waitingOn: [BEA],
      },
    });
    const id = created.body.interactionId as string;
    const text = "\u{1F600}@agent";
    const answered = await h.request(member(BEA), "POST", `/interaction/${id}/answer`, {
      optionIds: ["y"],
      comment: { text, tokens: [{ t: "agent", spans: [{ start: 1, length: 6 }] }] },
    });
    expect(answered.status).toBe(200);
    const comment = h.space.runtime.interactions.get(id)?.ask?.answers.at(-1)?.comment;
    expect(comment?.text).toBe(text);
    expect(comment?.tokens?.[0]).toEqual({ t: "agent" });
  });
});
