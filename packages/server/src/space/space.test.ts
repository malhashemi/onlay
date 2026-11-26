import { describe, expect, test } from "bun:test";
import {
  CALLER_HEADER,
  CLOSE_ACCESS_REVOKED,
  CLOSE_UPGRADE_REQUIRED,
  encodeCaller,
  encodeSpaceFacts,
  LIMITS,
} from "@onlay/protocol";
import { ADA, BEA, framesOf, GUS, guest, makeHarness, member, PAGE } from "./testing/harness";

/** A thread shared with Gus elsewhere in the space: a guest always holds at least one share. */
const OTHER_THREAD = "0f0f0f0f-0000-4000-8000-000000000001";
/**
 * The space's doors (spec §5.1, §7, §7.1): the caller header is the only
 * identity, member and guest see different spaces, admission runs on every
 * route and frame, and broadcasts are filtered per socket.
 */

const anchored = (text: string, url = PAGE) => ({
  kind: "comment",
  url,
  anchor: { level: "element", selector: "main > h1", snippet: "Pricing" },
  body: { text },
});

async function seed() {
  const h = makeHarness();
  const ada = member(ADA);
  const shared = await h.request(ada, "POST", "/interaction", anchored("shared with Gus"));
  const secret = await h.request(ada, "POST", "/interaction", anchored("members only"));
  expect(shared.status).toBe(200);
  const sharedId = shared.body.interactionId as string;
  const secretId = secret.body.interactionId as string;
  return { h, ada, sharedId, secretId, gus: guest(GUS, [sharedId]) };
}

describe("the caller gate", () => {
  test("no caller or a malformed one is sign_in_required; the error has the one shape", async () => {
    const h = makeHarness();
    const none = await h.request(null, "GET", "/attention");
    expect(none.status).toBe(401);
    expect(none.body).toEqual({
      error: { code: "sign_in_required", message: "Sign in to continue.", reason: "caller" },
    });
    const bad = await h.space.fetch(
      new Request("https://space/attention", { headers: { [CALLER_HEADER]: "not-a-caller" } }),
    );
    expect(bad.status).toBe(401);
  });

  test("internal routes need the Worker's marker and no caller; a forwarded one is not_found", async () => {
    const h = makeHarness();
    const forwarded = await h.request(member(ADA), "POST", "/internal/purge");
    expect(forwarded.status).toBe(404);
    const bare = await h.space.fetch(
      new Request("https://space/internal/purge", { method: "POST" }),
    );
    expect(bare.status).toBe(404);
    expect((await h.internal("POST", "/internal/purge")).status).toBe(200);
  });

  test("every route enforces its method", async () => {
    const { h, ada, sharedId } = await seed();
    const r = await h.request(ada, "GET", `/interaction/${sharedId}/resolve`);
    expect(r.status).toBe(405);
    expect((await h.request(ada, "DELETE", "/attention")).status).toBe(405);
    expect((await h.request(ada, "GET", "/nowhere")).status).toBe(404);
  });
});

describe("the protocol version", () => {
  test("HTTP below MIN_CLIENT_PROTOCOL is upgrade_required (426)", async () => {
    const h = makeHarness();
    const r = await h.request(member(ADA), "GET", "/attention", undefined, {
      "Onlay-Protocol": "1",
    });
    expect(r.status).toBe(426);
    expect(r.body.error.code).toBe("upgrade_required");
  });

  test("a hello below MIN_CLIENT_PROTOCOL, or without one, closes 4426", () => {
    const h = makeHarness();
    expect(h.connect(member(ADA), { protocol: 1 }).closed?.code).toBe(CLOSE_UPGRADE_REQUIRED);
    const s = h.sockets.connect();
    const admitted = h.space.admitSocket(
      new Request("https://space/ws", {
        headers: { [CALLER_HEADER]: encodeCaller(member(ADA)), Upgrade: "websocket" },
      }),
    );
    if (!admitted.ok) throw new Error("refused");
    s.setAttachment(admitted.attachment);
    h.send(s, {
      v: 1,
      type: "hello",
      sessionId: crypto.randomUUID(),
      bootCount: 0,
      swRestarts: 0,
      connects: 0,
    });
    expect(s.closed?.code).toBe(CLOSE_UPGRADE_REQUIRED);
  });

  test("welcome carries the person, the space and needs-you; agents can't open a socket", () => {
    const h = makeHarness();
    const s = h.sockets.connect();
    const admitted = h.space.admitSocket(
      new Request("https://space/ws", {
        headers: {
          [CALLER_HEADER]: encodeCaller(member(ADA)),
          Upgrade: "websocket",
          "Sec-WebSocket-Protocol": "onlay.v1, bearer.onl_x",
          "X-Onlay-Space": encodeSpaceFacts({ kind: "workspace", name: "acme" }),
        },
      }),
    );
    if (!admitted.ok) throw new Error("refused");
    expect(admitted.protocol).toBe("onlay.v1");
    s.setAttachment(admitted.attachment);
    h.send(s, {
      v: 1,
      type: "hello",
      sessionId: crypto.randomUUID(),
      bootCount: 0,
      swRestarts: 0,
      connects: 0,
      protocol: 2,
    });
    const welcome = framesOf(s, "welcome")[0];
    expect(welcome.person.id).toBe(ADA);
    expect(welcome.space).toEqual({
      id: "s_aaaaaaaaaaaaaaaaaaaa",
      kind: "workspace",
      name: "acme",
      role: "member",
    });
    expect(welcome.needsYouCount).toBe(0);
    expect(framesOf(s, "attention")).toHaveLength(1);
    expect(framesOf(s, "origins")).toEqual([{ v: 1, type: "origins", origins: [] }]);
    const agent = h.space.admitSocket(
      new Request("https://space/ws", {
        headers: { [CALLER_HEADER]: encodeCaller(member(ADA, "agent")), Upgrade: "websocket" },
      }),
    );
    expect(agent.ok).toBe(false);
  });
});

describe("member, guest and stranger on the routes", () => {
  test("a guest reads and talks on a shared interaction; anything else reads as missing", async () => {
    const { h, sharedId, secretId, gus } = await seed();
    expect((await h.request(gus, "GET", `/interaction/${sharedId}`)).status).toBe(200);
    expect((await h.request(gus, "GET", `/interaction/${secretId}`)).body.error.code).toBe(
      "not_found",
    );
    const listed = await h.request(gus, "GET", "/interaction");
    expect(listed.body.interactions.map((i: { id: string }) => i.id)).toEqual([sharedId]);
    const reply = await h.request(gus, "POST", `/interaction/${sharedId}/reply`, {
      body: { text: "hi" },
    });
    expect(reply.status).toBe(200);
    expect(
      (await h.request(gus, "POST", `/interaction/${secretId}/reply`, { body: { text: "x" } }))
        .status,
    ).toBe(404);
    expect((await h.request(gus, "GET", `/interaction/${secretId}/captures`)).status).toBe(404);
  });

  test("a guest may not resolve, create, or set state; a member may", async () => {
    const { h, ada, sharedId, gus } = await seed();
    const resolve = await h.request(gus, "POST", `/interaction/${sharedId}/resolve`);
    expect(resolve.status).toBe(403);
    expect(resolve.body.error).toMatchObject({ code: "forbidden", reason: "guest" });
    const create = await h.request(gus, "POST", "/interaction", {
      kind: "comment",
      body: { text: "x" },
    });
    expect(create.status).toBe(403);
    expect((await h.request(ada, "POST", `/interaction/${sharedId}/resolve`)).status).toBe(200);
  });

  test("the web app creates unanchored Comments only; agents create nothing", async () => {
    const h = makeHarness();
    const web = member(BEA, "interaction");
    const ok = await h.request(web, "POST", "/interaction", {
      kind: "comment",
      body: { text: "note" },
    });
    expect(ok.status).toBe(200);
    expect(ok.body.url).toBeUndefined();
    const anchoredTry = await h.request(web, "POST", "/interaction", anchored("on a page"));
    expect(anchoredTry.body.error).toMatchObject({ code: "forbidden", reason: "needs-page" });
    const edit = await h.request(web, "POST", "/interaction", {
      kind: "change",
      change: { intent: "x" },
    });
    expect(edit.body.error.reason).toBe("edit-needs-page");
    const agent = await h.request(member(ADA, "agent"), "POST", "/interaction", {
      kind: "comment",
      body: { text: "x" },
    });
    expect(agent.body.error).toMatchObject({ code: "forbidden", reason: "agent" });
  });

  test("the directory: members for a member, only shared participants for a guest", async () => {
    const { h, sharedId, gus } = await seed();
    for (const person of [
      { id: ADA, name: "Ada", initials: "A", tint: "#111111", member: true },
      { id: BEA, name: "Bea", initials: "B", tint: "#222222", member: true },
    ]) {
      expect((await h.internal("POST", "/internal/person", { person })).status).toBe(200);
    }
    const forMember = await h.request(member(BEA), "GET", "/directory");
    expect(forMember.body.people.map((p: { id: string }) => p.id).sort()).toEqual(
      [ADA, BEA].sort(),
    );
    const forGuest = await h.request(gus, "GET", "/directory");
    expect(forGuest.body.people.map((p: { id: string }) => p.id).sort()).toEqual([ADA, GUS].sort());
    expect(sharedId).toBeTruthy();
  });
});

describe("frames and broadcasts per socket", () => {
  test("a guest's socket hears only its shared interaction", async () => {
    const { h, ada, sharedId, secretId, gus } = await seed();
    const memberSocket = h.connect(member(BEA));
    const guestSocket = h.connect(guest(GUS, [sharedId], "full"));
    const webGuest = h.connect(gus);

    await h.request(ada, "POST", `/interaction/${secretId}/reply`, { body: { text: "secret" } });
    expect(framesOf(memberSocket, "interactions-state")).toHaveLength(1);
    expect(guestSocket.sent).toEqual([]);
    expect(webGuest.sent).toEqual([]);

    await h.request(ada, "POST", `/interaction/${sharedId}/reply`, { body: { text: "shared" } });
    const states = framesOf(guestSocket, "interactions-state");
    expect(states).toHaveLength(1);
    expect(states[0].interactions.map((i: { id: string }) => i.id)).toEqual([sharedId]);
    expect(framesOf(webGuest, "tick")).toHaveLength(1);
    expect(framesOf(webGuest, "interactions-state")).toHaveLength(0);
  });

  test("a guest's sync and frames are scoped; strangers' frames read as unknown", async () => {
    const { h, sharedId, secretId } = await seed();
    const s = h.connect(guest(GUS, [sharedId], "full"));
    h.send(s, { v: 1, type: "interaction-sync", frameUrl: PAGE });
    expect(
      framesOf(s, "interactions-state")[0].interactions.map((i: { id: string }) => i.id),
    ).toEqual([sharedId]);
    h.send(s, {
      v: 1,
      type: "interaction-reply",
      frameUrl: PAGE,
      interactionId: secretId,
      body: { text: "x" },
    });
    expect(framesOf(s, "interaction-receipt").at(-1)).toMatchObject({
      ok: false,
      reason: "unknown",
    });
    h.send(s, { v: 1, type: "interaction-resolve", frameUrl: PAGE, interactionId: sharedId });
    expect(framesOf(s, "interaction-receipt").at(-1)).toMatchObject({ ok: false, reason: "guest" });
    h.send(s, {
      v: 1,
      type: "interaction-reply",
      frameUrl: "https://elsewhere.test/",
      interactionId: sharedId,
      body: { text: "x" },
    });
    expect(framesOf(s, "interaction-receipt").at(-1)).toMatchObject({
      ok: false,
      reason: "url-mismatch",
    });
    h.send(s, {
      v: 1,
      type: "interaction-reply",
      frameUrl: PAGE,
      interactionId: sharedId,
      body: { text: "ok" },
    });
    expect(framesOf(s, "interaction-receipt").at(-1)).toMatchObject({ ok: true });
  });

  test("a web app socket only listens: its mutation frames are ignored", async () => {
    const { h, sharedId } = await seed();
    const web = h.connect(member(BEA, "interaction"));
    h.send(web, { v: 1, type: "interaction-resolve", frameUrl: PAGE, interactionId: sharedId });
    expect(web.sent).toEqual([]);
    expect(h.space.runtime.interactions.get(sharedId)?.state).toBe("open");
    h.send(web, { v: 1, type: "attention-sync" });
    expect(framesOf(web, "attention")).toHaveLength(1);
  });

  test("frames before hello don't run; a read is dropped, a change hears not-ready", async () => {
    const h = makeHarness();
    const s = h.sockets.connect();
    const admitted = h.space.admitSocket(
      new Request("https://space/ws", {
        headers: { [CALLER_HEADER]: encodeCaller(member(ADA)), Upgrade: "websocket" },
      }),
    );
    if (!admitted.ok) throw new Error("refused");
    s.setAttachment(admitted.attachment);
    h.send(s, { v: 1, type: "attention-sync" });
    expect(s.sent).toEqual([]);
    h.send(s, { v: 1, type: "ping", t: 7 });
    expect(s.frames()).toEqual([{ v: 1, type: "pong", t: 7 }]);
    h.send(s, {
      v: 1,
      type: "interaction-create",
      nonce: "n1",
      frameUrl: PAGE,
      kind: "comment",
      anchor: { level: "page" },
      body: { text: "too early" },
    });
    expect(framesOf(s, "interaction-receipt")).toEqual([
      expect.objectContaining({ kind: "create", ok: false, nonce: "n1", reason: "not-ready" }),
    ]);
    expect(h.space.runtime.interactions.size).toBe(0);
    expect(s.closed).toBeNull();
  });
});

describe("origins", () => {
  test("GET /origins lists live anchored origins the caller may see; sockets hear changes", async () => {
    const h = makeHarness();
    const ada = member(ADA);
    const watcher = h.connect(member(BEA));
    const first = await h.request(ada, "POST", "/interaction", anchored("a"));
    expect(framesOf(watcher, "origins")).toEqual([
      { v: 1, type: "origins", origins: ["https://example.com"] },
    ]);
    await h.request(ada, "POST", "/interaction", anchored("b"));
    expect(framesOf(watcher, "origins")).toHaveLength(1); // unchanged set → no frame
    await h.request(ada, "POST", "/interaction", anchored("c", "https://other.test/x"));
    expect(framesOf(watcher, "origins").at(-1).origins).toEqual([
      "https://example.com",
      "https://other.test",
    ]);
    const asGuest = await h.request(guest(GUS, [first.body.interactionId]), "GET", "/origins");
    expect(asGuest.body).toEqual({ origins: ["https://example.com"] });
  });
});

describe("edge notices", () => {
  test("access-changed null closes the person's sockets; a re-scope resyncs them", async () => {
    const { h, sharedId } = await seed();
    const bea = h.connect(member(BEA));
    const gus = h.connect(guest(GUS, [sharedId], "full"));
    // Re-scoped to another share (a guest's access always names at least one).
    await h.internal("POST", "/internal/access-changed", {
      personId: GUS,
      access: { kind: "guest", interactionIds: [OTHER_THREAD] },
    });
    expect(framesOf(gus, "attention").length).toBeGreaterThan(0);
    await h.internal("POST", "/internal/access-changed", { personId: BEA, access: null });
    expect(bea.closed?.code).toBe(CLOSE_ACCESS_REVOKED);
  });

  test("an access control adds the share to a guest's live socket and removes it again", async () => {
    const { h, ada, secretId } = await seed();
    const elsewhere = "00000000-0000-4000-8000-000000000000";
    const gus = h.connect(guest(GUS, [elsewhere], "full"));
    await h.internal("POST", "/internal/access-changed", {
      personId: GUS,
      access: { kind: "guest", interactionIds: [elsewhere, secretId] },
    });
    gus.sent.length = 0;
    await h.request(ada, "POST", `/interaction/${secretId}/reply`, {
      body: { text: "now shared" },
    });
    expect(framesOf(gus, "interactions-state")).toHaveLength(1);
    await h.internal("POST", "/internal/access-changed", {
      personId: GUS,
      access: { kind: "guest", interactionIds: [elsewhere] },
    });
    // The socket stays, with less to see: it hears access-changed (round 2, S9).
    expect(framesOf(gus, "access-changed")).toHaveLength(1);
    expect(gus.closed).toBeNull();
    gus.sent.length = 0;
    await h.request(ada, "POST", `/interaction/${secretId}/reply`, { body: { text: "unshared" } });
    expect(gus.sent).toEqual([]);
  });

  test("purge drops everything and closes every socket", async () => {
    const { h, sharedId } = await seed();
    const s = h.connect(member(BEA));
    expect((await h.internal("POST", "/internal/purge")).body).toEqual({ ok: true });
    expect(s.closed?.code).toBe(CLOSE_ACCESS_REVOKED);
    expect((await h.request(member(ADA), "GET", `/interaction/${sharedId}`)).status).toBe(404);
    h.evict();
    expect(h.space.runtime.interactions.size).toBe(0);
  });
});

/* ── review findings 11, 12, 14 and the attention count ────────────── */

describe("guests and the directory (finding 11)", () => {
  test("a guest's mention of someone outside the thread is dropped; the words stay", async () => {
    const { h, sharedId, gus } = await seed();
    const r = await h.request(gus, "POST", `/interaction/${sharedId}/reply`, {
      body: {
        text: "@Bea and @Ada please look",
        tokens: [
          { t: "actor", actorId: BEA },
          { t: "actor", actorId: ADA },
        ],
      },
    });
    expect(r.status).toBe(200);
    const s = h.space.runtime.interactions.get(sharedId);
    const msg = s?.thread.at(-1);
    expect(msg?.body.text).toBe("@Bea and @Ada please look");
    expect(msg?.body.tokens).toEqual([{ t: "actor", actorId: ADA }]);
    expect(s?.participants).not.toContain(BEA);
    const dir = await h.request(gus, "GET", "/directory");
    expect(dir.body.people.map((p: { id: string }) => p.id)).not.toContain(BEA);
    // A member's mention still pulls a teammate in.
    await h.request(member(ADA), "POST", `/interaction/${sharedId}/reply`, {
      body: { text: "@Bea", tokens: [{ t: "actor", actorId: BEA }] },
    });
    expect(h.space.runtime.interactions.get(sharedId)?.participants).toContain(BEA);
  });

  test("a guest editing a message can't add a stranger either", async () => {
    const { h, sharedId, gus } = await seed();
    const r = await h.request(gus, "POST", `/interaction/${sharedId}/reply`, {
      body: { text: "hi" },
    });
    await h.request(gus, "POST", `/interaction/${sharedId}/edit`, {
      msgId: r.body.msgId,
      body: { text: "hi @Bea", tokens: [{ t: "actor", actorId: BEA }] },
    });
    expect(h.space.runtime.interactions.get(sharedId)?.participants).not.toContain(BEA);
  });

  test("a member's directory is the current members and share holders, not past participants", async () => {
    const { h, sharedId } = await seed();
    // Bea took part, then left the space; Gus holds a share.
    await h.request(member(BEA), "POST", `/interaction/${sharedId}/reply`, {
      body: { text: "before I left" },
    });
    for (const person of [
      { id: ADA, name: "Ada", initials: "A", tint: "#111111", member: true },
      { id: GUS, name: "Gus", initials: "G", tint: "#333333", member: false, guest: true },
    ]) {
      await h.internal("POST", "/internal/person", { person });
    }
    await h.internal("POST", "/internal/person", { personId: BEA, removed: true });
    const dir = await h.request(member(ADA), "GET", "/directory");
    expect(dir.body.people.map((p: { id: string }) => p.id).sort()).toEqual([ADA, GUS].sort());
  });
});

describe("guests can't probe private interactions (finding 12)", () => {
  test("a private interaction from another URL answers exactly as a missing one", async () => {
    const { h, secretId } = await seed();
    const s = h.connect(guest(GUS, [OTHER_THREAD], "full"));
    for (const interactionId of [secretId, crypto.randomUUID()]) {
      for (const type of ["interaction-reply", "interaction-react", "interaction-resolve"]) {
        h.send(s, {
          v: 1,
          type,
          frameUrl: "https://elsewhere.test/",
          interactionId,
          body: { text: "x" },
          msgId: "m1",
          emoji: "👍",
          on: true,
        });
        expect(framesOf(s, "interaction-receipt").at(-1)).toMatchObject({
          ok: false,
          reason: "unknown",
        });
      }
    }
  });
});

describe("socket writes are rate-limited per person (finding 14)", () => {
  test("the 121st change in a minute is refused with rate-limited; the socket stays open", async () => {
    const { h, sharedId } = await seed();
    const one = h.connect(member(BEA));
    const two = h.connect(member(BEA));
    for (let i = 0; i < 120; i++) {
      h.send(i % 2 === 0 ? one : two, {
        v: 1,
        type: "interaction-reply",
        frameUrl: PAGE,
        interactionId: sharedId,
        body: { text: `n${i}` },
      });
    }
    const before = h.space.runtime.interactions.get(sharedId)?.thread.length;
    h.send(one, {
      v: 1,
      type: "interaction-reply",
      frameUrl: PAGE,
      interactionId: sharedId,
      body: { text: "one too many" },
    });
    expect(framesOf(one, "interaction-receipt").at(-1)).toMatchObject({
      ok: false,
      reason: "rate-limited",
    });
    expect(h.space.runtime.interactions.get(sharedId)?.thread.length).toBe(before);
    expect(one.closed).toBeNull();
    // Reads still answer, and someone else still writes.
    h.send(one, { v: 1, type: "interaction-sync", frameUrl: PAGE });
    expect(framesOf(one, "interactions-state").length).toBeGreaterThan(0);
    const ada = h.connect(member(ADA));
    h.send(ada, {
      v: 1,
      type: "interaction-reply",
      frameUrl: PAGE,
      interactionId: sharedId,
      body: { text: "mine" },
    });
    expect(framesOf(ada, "interaction-receipt").at(-1)).toMatchObject({ ok: true });
    // The next minute opens a new window.
    h.clock.advance(60_000);
    h.send(one, {
      v: 1,
      type: "interaction-reply",
      frameUrl: PAGE,
      interactionId: sharedId,
      body: { text: "later" },
    });
    expect(framesOf(one, "interaction-receipt").at(-1)).toMatchObject({ ok: true });
  });
});

describe("attention carries the full needs-you count (addition A)", () => {
  test("the frame's count is the uncapped total, on the socket and over HTTP", async () => {
    const h = makeHarness();
    const ada = member(ADA);
    for (let i = 0; i < 55; i++) {
      await h.request(ada, "POST", "/interaction", {
        kind: "ask",
        url: PAGE,
        anchor: { level: "page" },
        ask: {
          question: `q${i}`,
          context: "c",
          options: [{ id: "y", label: "Yes" }],
          selection: { min: 1, max: 1, submit: "immediate" },
          waitingOn: [BEA],
        },
      });
    }
    const s = h.connect(member(BEA));
    h.send(s, { v: 1, type: "attention-sync" });
    const frame = framesOf(s, "attention").at(-1);
    expect(frame.needsYou).toHaveLength(LIMITS.MAX_ATTENTION_ROWS);
    expect(frame.needsYouCount).toBe(55);
    const http = await h.request(member(BEA), "GET", "/attention");
    expect(http.body.needsYouCount).toBe(55);
  });
});

describe("write-once markup (minor)", () => {
  test("two uploads race for one slot: one wins, the other hears exists", async () => {
    const h = makeHarness();
    const ada = member(ADA);
    const r = await h.request(ada, "POST", "/interaction", {
      kind: "comment",
      url: PAGE,
      anchor: { level: "element", selector: "main > h1" },
      body: { text: "x" },
    });
    const id = r.body.interactionId as string;
    const [a, b] = await Promise.all([
      h.request(ada, "POST", `/interaction/${id}/anchor-content`, { content: "<h1>a</h1>" }),
      h.request(ada, "POST", `/interaction/${id}/anchor-content`, { content: "<h1>b</h1>" }),
    ]);
    expect([a.status, b.status].sort()).toEqual([200, 409]);
    expect((a.status === 409 ? a : b).body.error.reason).toBe("exists");
  });
});
