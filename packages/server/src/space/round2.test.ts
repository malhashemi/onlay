import { describe, expect, test } from "bun:test";
import { type InteractionState, isLive } from "@onlay/kernel";
import {
  CALLER_HEADER,
  type Caller,
  CLOSE_ACCESS_REVOKED,
  encodeCaller,
  KeptEditSchema,
  LIMITS,
  parseOutbound,
} from "@onlay/protocol";
import { buildInteractionsState } from "./runtime";
import { ADA, BEA, framesOf, GUS, guest, makeHarness, member, PAGE } from "./testing/harness";
import { makeUaKeys } from "./testing/webpush-receiver";

/**
 * The space's side of the round-2 server list: revocation records and the
 * minimum generation at admission (S1), whole-scope access controls (S2), per-person
 * people controls (S3), the purge tombstone and the required epoch (S5), the
 * lifetime of waits (S8), the share debt (S10), capture init on current
 * standing (S11), variants naming their writer (S12), author-only markup
 * (S13), omitted kept entries (S14), the live cap on reopen, the first
 * welcome, push re-validation (S16) and filtered attention (S17).
 */

const anchored = (text: string) => ({
  kind: "comment",
  url: PAGE,
  anchor: { level: "element", selector: "h1" },
  body: { text },
});

async function thread(h: ReturnType<typeof makeHarness>, text = "x") {
  return (await h.request(member(ADA), "POST", "/interaction", anchored(text))).body
    .interactionId as string;
}

describe("revocation at admission (S1)", () => {
  test("a revoked credential is refused however its request arrives; others are not", async () => {
    const h = makeHarness();
    const tok: Caller = { ...member(ADA), credentialId: "tok_gone" };
    await h.internal("POST", "/internal/credential-revoked", {
      personId: ADA,
      credentialIds: ["tok_gone"],
    });
    const r = await h.request(tok, "GET", "/attention");
    expect(r.status).toBe(401);
    expect(r.body.error.reason).toBe("credential-revoked");
    expect(() => h.connect(tok)).toThrow("socket refused: 401");
    expect((await h.request(member(ADA), "GET", "/attention")).status).toBe(200);
  });

  test("a raised minimum generation never cuts a credential stamped with it (R3-S1)", async () => {
    const h = makeHarness();
    const before: Caller = { ...member(ADA), credentialId: "ses_old", credentialGeneration: 0 };
    const old = h.connect(before);
    // Signed in again after the change: stamped with the new generation.
    const after: Caller = { ...member(ADA), credentialId: "ses_new", credentialGeneration: 1 };
    const fresh = h.connect(after);
    await h.internal("POST", "/internal/credential-revoked", { personId: ADA, minGeneration: 1 });
    expect(old.closed?.code).toBe(CLOSE_ACCESS_REVOKED);
    expect(fresh.closed).toBeNull();
    // A retried or late notice is harmless to the newer credential, and the
    // minimum never goes back down.
    await h.internal("POST", "/internal/credential-revoked", { personId: ADA, minGeneration: 1 });
    await h.internal("POST", "/internal/credential-revoked", { personId: ADA, minGeneration: 0 });
    expect(fresh.closed).toBeNull();
    expect((await h.request(after, "GET", "/attention")).status).toBe(200);
    expect((await h.request(before, "GET", "/attention")).status).toBe(401);
    // A credential that doesn't say its generation counts as 0.
    const { credentialGeneration: _x, ...unsaid } = before;
    expect((await h.request(unsaid as Caller, "GET", "/attention")).status).toBe(401);
  });

  test("a raised minimum removes only push subscriptions of older generations", async () => {
    const h = makeHarness();
    const keys = makeUaKeys();
    const sub = (credentialId: string, generation: number) =>
      h.request(
        { ...member(ADA, "interaction"), credentialId, credentialGeneration: generation },
        "POST",
        "/push/subscribe",
        {
          endpoint: `https://fcm.googleapis.com/fcm/send/${credentialId}`,
          keys: { p256dh: keys.p256dh, auth: keys.auth },
        },
      );
    await sub("ses_old", 0);
    await sub("ses_new", 1);
    await h.internal("POST", "/internal/credential-revoked", { personId: ADA, minGeneration: 1 });
    expect(h.space.runtime.pushStore.listAll().map((r) => r.credentialId)).toEqual(["ses_new"]);
  });

  test("a bare notice from an earlier Worker closes every socket and push of the person", async () => {
    const h = makeHarness();
    const a = h.connect({ ...member(ADA), credentialId: "tok_a" });
    const b = h.connect({ ...member(ADA), credentialId: "tok_b" });
    const bea = h.connect(member(BEA));
    await h.internal("POST", "/internal/credential-revoked", { personId: ADA });
    expect(a.closed?.code).toBe(CLOSE_ACCESS_REVOKED);
    expect(b.closed?.code).toBe(CLOSE_ACCESS_REVOKED);
    expect(bea.closed).toBeNull();
    // Nothing recorded: a live credential reconnects.
    expect(
      (await h.request({ ...member(ADA), credentialId: "tok_c" }, "GET", "/attention")).status,
    ).toBe(200);
  });
});

describe("whole-scope access controls (S2)", () => {
  test("an older control for a person changes nothing; a newer one replaces the whole scope", async () => {
    const h = makeHarness();
    const a = await thread(h, "a");
    const b = await thread(h, "b");
    const gus = { ...guest(GUS, [a, b], "full"), accessEpoch: 5 };
    await h.internal(
      "POST",
      "/internal/access-changed",
      { personId: GUS, access: { kind: "guest", interactionIds: [a, b] } },
      5,
    );
    const s = h.connect(gus);
    await h.internal(
      "POST",
      "/internal/access-changed",
      { personId: GUS, access: { kind: "guest", interactionIds: [a] } },
      7,
    );
    const late = await h.internal(
      "POST",
      "/internal/access-changed",
      { personId: GUS, access: { kind: "guest", interactionIds: [a, b] } },
      6,
    );
    expect(late.body).toEqual({ ok: true, stale: true });
    expect(s.attachment()?.caller.access).toEqual({ kind: "guest", interactionIds: [a] });
    expect(h.space.runtime.interactions.get(b)?.sharedWith).toBeUndefined();
  });
});

describe("one person per people control (S3)", () => {
  test("upsert and removal change only that person", async () => {
    const h = makeHarness();
    await h.internal("POST", "/internal/person", {
      person: { id: BEA, name: "Bea", initials: "B", tint: "#222", member: true },
    });
    await h.internal("POST", "/internal/person", {
      person: { id: GUS, name: "Gus", initials: "G", tint: "#333", member: false, guest: true },
    });
    expect(h.space.runtime.people.get(BEA)?.member).toBe(true);
    await h.internal("POST", "/internal/person", { personId: BEA, removed: true });
    expect(h.space.runtime.people.get(BEA)).toMatchObject({ member: false, guest: false });
    expect(h.space.runtime.people.get(GUS)).toMatchObject({ guest: true });
    const bad = await h.internal("POST", "/internal/person", {
      person: { id: GUS, name: "Gus", initials: "ABCDE", tint: "#333", member: false },
    });
    expect(bad.status).toBe(400);
  });
});

describe("deleted spaces stay deleted (S5)", () => {
  test("after a purge every request, upgrade and control is not_found and writes nothing", async () => {
    const h = makeHarness();
    await thread(h);
    expect((await h.internal("POST", "/internal/purge")).status).toBe(200);
    expect((await h.request(member(ADA), "POST", "/interaction", anchored("again"))).status).toBe(
      404,
    );
    expect(() => h.connect(member(ADA))).toThrow("socket refused: 404");
    expect(
      (await h.internal("POST", "/internal/access-changed", { personId: ADA, access: null }))
        .status,
    ).toBe(404);
    expect((await h.internal("POST", "/internal/purge")).status).toBe(200);
    h.evict();
    expect(h.space.runtime.interactions.size).toBe(0);
    expect(h.space.runtime.people.all()).toEqual([]);
  });

  test("a refused caller writes nothing to the people cache", async () => {
    const h = makeHarness();
    await h.internal("POST", "/internal/access-changed", { personId: GUS, access: null }, 3);
    const stale = { ...member(BEA), accessEpoch: 2 };
    expect((await h.request(stale, "GET", "/attention")).status).toBe(409);
    expect(h.space.runtime.people.get(BEA)).toBeUndefined();
  });
});

describe("a parked wait ends with its credential (S8)", () => {
  test("revoking the credential answers the wait as not_found at once", async () => {
    const h = makeHarness();
    const id = await thread(h);
    const seq = h.space.runtime.journal.lastSeq("interaction", id);
    const waiting = h.request(
      member(ADA),
      "GET",
      `/interaction/${id}/wait?since=${seq}&timeout=20`,
    );
    await new Promise((r) => setTimeout(r, 5));
    await h.internal("POST", "/internal/credential-revoked", {
      personId: ADA,
      credentialIds: [member(ADA).credentialId],
    });
    expect((await waiting).status).toBe(404);
  });

  test("losing access to the interaction ends the wait too", async () => {
    const h = makeHarness();
    const id = await thread(h);
    const seq = h.space.runtime.journal.lastSeq("interaction", id);
    const waiting = h.request(
      guest(GUS, [id]),
      "GET",
      `/interaction/${id}/wait?since=${seq}&timeout=20`,
    );
    await new Promise((r) => setTimeout(r, 5));
    await h.internal("POST", "/internal/access-changed", { personId: GUS, access: null });
    expect((await waiting).status).toBe(404);
  });
});

describe("the share debt (S10)", () => {
  test("a share owes a look even to someone already in the thread; their agent's read doesn't pay it", async () => {
    const h = makeHarness();
    const id = (
      await h.request(member(ADA), "POST", "/interaction", {
        ...anchored("@Gus look"),
        body: { text: "@Gus look", tokens: [{ t: "actor", actorId: GUS }] },
      })
    ).body.interactionId as string;
    await h.internal("POST", "/internal/access-changed", {
      personId: GUS,
      access: { kind: "guest", interactionIds: [id] },
    });
    expect(h.space.runtime.interactions.get(id)?.shareUnseen).toEqual([GUS]);
    await h.request(guest(GUS, [id], "agent"), "GET", `/interaction/${id}`);
    expect(h.space.runtime.interactions.get(id)?.shareUnseen).toEqual([GUS]);
    await h.request(guest(GUS, [id], "full"), "GET", `/interaction/${id}`);
    expect(h.space.runtime.interactions.get(id)?.shareUnseen).toBeUndefined();
  });
});

describe("capture init on current standing (S11)", () => {
  test("a member downgraded to guest while the manifest uploads gets the guest's answer", async () => {
    const h = makeHarness();
    const id = await thread(h);
    const doc = new Uint8Array([0x1f, 0x8b, 1, 2]);
    const { createHash } = await import("node:crypto");
    const manifest = {
      kind: "snapshot",
      format: "onlay-cap/1",
      parts: [
        {
          name: "document",
          role: "document",
          mime: "application/gzip",
          byteLen: doc.length,
          sha256: createHash("sha256").update(doc).digest("hex"),
        },
      ],
    };
    // The manifest arrives slowly; the downgrade lands while it streams.
    let release: () => void = () => {};
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const body = new ReadableStream<Uint8Array>({
      async start(controller) {
        await gate;
        controller.enqueue(new TextEncoder().encode(JSON.stringify(manifest)));
        controller.close();
      },
    });
    const pending = h.space.fetch(
      new Request(`https://space/interaction/${id}/capture`, {
        method: "POST",
        headers: {
          [CALLER_HEADER]: encodeCaller(member(ADA)),
          "Content-Type": "application/json",
        },
        body,
        // @ts-expect-error -- Bun's Request needs it for a stream body
        duplex: "half",
      }),
    );
    await new Promise((r) => setTimeout(r, 5));
    await h.internal("POST", "/internal/access-changed", {
      personId: ADA,
      access: { kind: "guest", interactionIds: [id] },
    });
    release();
    expect((await pending).status).toBe(404);
  });
});

describe("variants name who wrote them (S12)", () => {
  test("by rides the set read and the variant-state frame", async () => {
    const h = makeHarness();
    const s = h.connect(member(ADA));
    h.send(s, {
      v: 1,
      type: "variant-create",
      nonce: "n1",
      frameUrl: PAGE,
      root: { kind: "page" },
      command: "x",
      count: 1,
    });
    const setId = framesOf(s, "variant-state")[0].setId as string;
    await h.request(member(BEA, "agent"), "POST", `/variant-set/${setId}/variants`, {
      variants: [{ label: "A", program: [] }],
    });
    const read = await h.request(member(ADA), "GET", `/variant-set/${setId}`);
    expect(read.body.set.variants[0].by).toBe(BEA);
    expect(framesOf(s, "variant-state").at(-1).variants[0].by).toBe(BEA);
  });
});

describe("only the author supplies markup (S13)", () => {
  test("another member's upload is forbidden not-yours; the author's is accepted", async () => {
    const h = makeHarness();
    const id = await thread(h);
    const bea = await h.request(member(BEA), "POST", `/interaction/${id}/anchor-content`, {
      content: "<h1>theirs</h1>",
    });
    expect(bea.status).toBe(403);
    expect(bea.body.error.reason).toBe("not-yours");
    const ada = await h.request(member(ADA), "POST", `/interaction/${id}/anchor-content`, {
      content: "<h1>mine</h1>",
    });
    expect(ada.status).toBe(200);
  });
});

describe("kept entries that did not fit are named (S14)", () => {
  test("the frame lists the omitted kept Edits by id", async () => {
    const h = makeHarness();
    const s = h.connect(member(ADA));
    const big = Array.from({ length: 7 }, (_, i) => ({
      op: "insertFragment" as const,
      target: ":scope",
      position: "append" as const,
      html: `<p>${String(i).padEnd(32_752, "x")}</p>`,
    }));
    const edits: string[] = [];
    for (let i = 0; i < 5; i++) {
      const nonce = `n${i}`;
      h.send(s, {
        v: 1,
        type: "variant-create",
        nonce,
        frameUrl: PAGE,
        root: {
          kind: "block",
          element: { selector: "h1", tag: "h1", classes: [], textSnippet: "x", markup: "<h1/>" },
        },
        command: "x",
        count: 1,
      });
      const frame = framesOf(s, "variant-state").find((f) => f.nonce === nonce);
      const posted = await h.request(
        member(ADA, "agent"),
        "POST",
        `/variant-set/${frame.setId}/variants`,
        {
          variants: [{ label: "big", program: big }],
        },
      );
      const v = posted.body.set.variants[0];
      h.clock.advance(1_000);
      h.send(s, {
        v: 1,
        type: "variant-pick",
        setId: frame.setId,
        frameUrl: PAGE,
        variantId: v.variantId,
        version: v.version,
      });
      edits.push(frame.changeInteractionId);
    }
    const page = buildInteractionsState(h.space.runtime, PAGE, { kind: "member", role: "member" });
    expect(parseOutbound(JSON.stringify(page)).ok).toBe(true);
    const shown = new Set((page.kept ?? []).map((k) => k.interactionId));
    expect(page.keptOmitted?.length).toBeGreaterThan(0);
    expect([...shown, ...(page.keptOmitted ?? [])].sort()).toEqual([...edits].sort());
  });
});

describe("bounds (S16)", () => {
  test("reopening counts against the live cap", async () => {
    const h = makeHarness();
    const id = await thread(h);
    await h.request(member(ADA), "POST", `/interaction/${id}/resolve`);
    const rt = h.space.runtime;
    const base = rt.interactions.get(id) as InteractionState;
    for (let i = 0; i < LIMITS.MAX_LIVE_INTERACTIONS; i++) {
      const fake = {
        ...base,
        id: `00000000-0000-4000-8000-${String(i).padStart(12, "0")}`,
        state: "open",
      };
      delete (fake as { resolvedAt?: number }).resolvedAt;
      rt.interactions.set(fake.id, fake);
    }
    expect([...rt.interactions.values()].filter(isLive).length).toBe(LIMITS.MAX_LIVE_INTERACTIONS);
    const r = await h.request(member(ADA), "POST", `/interaction/${id}/reopen`);
    expect(r.status).toBe(409);
    expect(r.body.error.reason).toBe("space-full");
  });

  test("a repeated hello hears the first welcome byte for byte", () => {
    const h = makeHarness();
    const s = h.connect(member(ADA));
    const first = s.attachment()?.welcome;
    h.space.runtime.interactions.clear();
    h.send(s, {
      v: 1,
      type: "hello",
      sessionId: crypto.randomUUID(),
      bootCount: 2,
      swRestarts: 0,
      connects: 2,
      protocol: 2,
    });
    expect(first).toBeDefined();
    expect(s.sent).toEqual([first as string]);
  });

  test("a stored push destination off the allowlist is deleted at delivery, not sent to", async () => {
    const sent: string[] = [];
    const h = makeHarness({
      fetch: (async (url: string) => {
        sent.push(url);
        return new Response(null, { status: 201 });
      }) as unknown as typeof fetch,
    });
    const keys = makeUaKeys();
    h.space.runtime.pushStore.upsert(
      "ses_x",
      ADA,
      { kind: "member", role: "member" },
      {
        endpoint: "https://internal.example.com/hook",
        keys: { p256dh: keys.p256dh, auth: keys.auth },
      },
      h.clock.now(),
    );
    await h.request(member(BEA), "POST", "/interaction", {
      ...anchored("@Ada"),
      body: { text: "@Ada", tokens: [{ t: "actor", actorId: ADA }] },
    });
    await new Promise((r) => setTimeout(r, 20));
    expect(sent).toEqual([]);
    expect(h.space.runtime.pushStore.listAll()).toEqual([]);
  });
});

describe("filtered attention (S17)", () => {
  test("url and origin narrow the rows before the cap", async () => {
    const h = makeHarness();
    for (let i = 0; i < LIMITS.MAX_ATTENTION_ROWS + 5; i++) {
      await h.request(member(BEA), "POST", "/interaction", {
        kind: "comment",
        url: "https://busy.test/page",
        anchor: { level: "page" },
        body: { text: `@Ada ${i}`, tokens: [{ t: "actor", actorId: ADA }] },
      });
    }
    await h.request(member(BEA), "POST", "/interaction", {
      kind: "comment",
      url: PAGE,
      anchor: { level: "page" },
      body: { text: "@Ada quiet", tokens: [{ t: "actor", actorId: ADA }] },
    });
    const all = await h.request(member(ADA), "GET", "/attention");
    expect(all.body.needsYou).toHaveLength(LIMITS.MAX_ATTENTION_ROWS);
    const page = await h.request(member(ADA), "GET", `/attention?url=${encodeURIComponent(PAGE)}`);
    expect(page.body.needsYou.map((r: { text: string }) => r.text)).toEqual(["@Ada quiet"]);
    expect(page.body.needsYouCount).toBe(1);
    const site = await h.request(member(ADA), "GET", "/attention?origin=https%3A%2F%2Fbusy.test");
    expect(site.body.needsYouCount).toBe(LIMITS.MAX_ATTENTION_ROWS + 5);
  });
});

/* ── seams with the clients and MCP seats' round 2 ─────────────────── */

const block = {
  selector: "main > h1",
  tag: "h1",
  classes: [],
  textSnippet: "Pricing",
  markup: "<h1>Pricing</h1>",
};
const calm = [{ op: "setStyle", target: ":scope", props: [{ prop: "color", value: "slateblue" }] }];

function makeSet(
  h: ReturnType<typeof makeHarness>,
  s: ReturnType<ReturnType<typeof makeHarness>["connect"]>,
  root: Record<string, unknown>,
  extra: Record<string, unknown> = {},
) {
  const nonce = crypto.randomUUID().slice(0, 8);
  h.send(s, {
    v: 1,
    type: "variant-create",
    nonce,
    frameUrl: PAGE,
    root,
    command: "make it calmer",
    count: 1,
    ...extra,
  });
  const frame = framesOf(s, "variant-state").find((f) => f.nonce === nonce);
  if (!frame) throw new Error("no set");
  return { setId: frame.setId as string, editId: frame.changeInteractionId as string };
}

describe("seam: the extension's look keys on `by` (S12 × clients)", () => {
  test("an in-place manual variant says its author, on the frame and in the set read", async () => {
    const h = makeHarness();
    const s = h.connect(member(ADA));
    const { setId } = makeSet(h, s, { kind: "block", element: block }, { manual: calm });
    const frame = framesOf(s, "variant-state").find((f) => f.setId === setId);
    expect(frame.variants[0].by).toBe(ADA);
    const read = await h.request(member(ADA), "GET", `/variant-set/${setId}`);
    expect(read.body.set.variants[0].by).toBe(ADA);
    // Durable: a restart replays it from the journal.
    h.evict();
    expect(h.space.runtime.variantSets.get(setId)?.variants[0]?.by).toBe(ADA);
    expect(h.space.runtime.variantStore.replayFromEvents(setId)?.variants[0]?.by).toBe(ADA);
  });

  test("an agent's revision of the author's variant says the person it acts as", async () => {
    const h = makeHarness();
    const s = h.connect(member(ADA));
    const { setId } = makeSet(h, s, { kind: "block", element: block }, { manual: calm });
    await h.request(member(BEA, "agent"), "POST", `/variant-set/${setId}/variants/0`, {
      program: calm,
    });
    const read = await h.request(member(ADA), "GET", `/variant-set/${setId}`);
    expect(read.body.set.variants[0].by).toBe(BEA);
    expect(framesOf(s, "variant-state").at(-1).variants[0].by).toBe(BEA);
  });
});

describe("seam: an omitted kept entry reads by id (S14 × clients)", () => {
  test("GET /interaction/:id returns the kept entry the frame left out", async () => {
    const h = makeHarness();
    const s = h.connect(member(ADA));
    const big = Array.from({ length: 7 }, (_, i) => ({
      op: "insertFragment" as const,
      target: ":scope",
      position: "append" as const,
      html: `<p>${String(i).padEnd(32_752, "x")}</p>`,
    }));
    for (let i = 0; i < 5; i++) {
      const { setId } = makeSet(h, s, { kind: "block", element: block });
      const posted = await h.request(
        member(ADA, "agent"),
        "POST",
        `/variant-set/${setId}/variants`,
        {
          variants: [{ label: "big", program: big }],
        },
      );
      const v = posted.body.set.variants[0];
      h.clock.advance(1_000);
      h.send(s, {
        v: 1,
        type: "variant-pick",
        setId,
        frameUrl: PAGE,
        variantId: v.variantId,
        version: v.version,
      });
    }
    const page = buildInteractionsState(h.space.runtime, PAGE, { kind: "member", role: "member" });
    const omitted = page.keptOmitted ?? [];
    expect(omitted.length).toBeGreaterThan(0);
    for (const id of omitted) {
      const read = await h.request(member(ADA), "GET", `/interaction/${id}`);
      expect(read.status).toBe(200);
      expect(read.body.kept?.interactionId).toBe(id);
      expect(read.body.kept?.program.length).toBe(big.length);
      // What the extension's readKept accepts.
      expect(KeptEditSchema.safeParse(read.body.kept).success).toBe(true);
    }
  });
});

describe("seam: no legitimate upload is not-yours (S13 × clients)", () => {
  test("the author's block Comment, block Edit and page Edit uploads are accepted", async () => {
    const h = makeHarness();
    const s = h.connect(member(ADA));
    const comment = await thread(h, "on a block");
    const blockEdit = makeSet(h, s, { kind: "block", element: block }).editId;
    const pageEdit = makeSet(h, s, { kind: "page" }).editId;
    for (const [id, slot] of [
      [comment, "anchor-content"],
      [blockEdit, "anchor-content"],
      [pageEdit, "page-content"],
    ] as const) {
      const res = await h.request(member(ADA), "POST", `/interaction/${id}/${slot}`, {
        content: "<main><h1>Pricing</h1></main>",
        format: "html",
        truncated: false,
      });
      expect([id, slot, res.status]).toEqual([id, slot, 200]);
    }
  });

  test("someone else re-anchoring or anchoring a thread may upload its block, even after a restart", async () => {
    const h = makeHarness();
    const bea = h.connect(member(BEA));
    // Ada's unanchored thread (from the web app): Bea anchors it on this page.
    const loose = (
      await h.request(member(ADA, "interaction"), "POST", "/interaction", {
        kind: "comment",
        body: { text: "where?" },
      })
    ).body.interactionId as string;
    h.send(bea, {
      v: 1,
      type: "interaction-anchor",
      frameUrl: PAGE,
      interactionId: loose,
      anchor: { level: "element", selector: "h1" },
    });
    // Ada's page-level thread: Bea re-anchors it onto a block.
    const page = (
      await h.request(member(ADA), "POST", "/interaction", {
        kind: "comment",
        url: PAGE,
        anchor: { level: "page" },
        body: { text: "this page" },
      })
    ).body.interactionId as string;
    h.send(bea, {
      v: 1,
      type: "interaction-reanchor",
      frameUrl: PAGE,
      interactionId: page,
      anchor: { level: "element", selector: "h1" },
    });
    h.evict();
    for (const id of [loose, page]) {
      const res = await h.request(member(BEA), "POST", `/interaction/${id}/anchor-content`, {
        content: "<h1>Pricing</h1>",
        format: "html",
        truncated: false,
      });
      expect([id, res.status]).toEqual([id, 200]);
    }
    // Gus, a third member, still may not.
    const third = await h.request(member(GUS), "POST", `/interaction/${page}/anchor-content`, {
      content: "<h1>x</h1>",
    });
    expect(third.status).toBe(403);
  });
});
