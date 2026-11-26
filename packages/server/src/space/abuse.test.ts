import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { type InteractionState, isLive } from "@onlay/kernel";
import { LIMITS } from "@onlay/protocol";
import { SOCKET_AUTHORIZATION_MS } from "./runtime";
import { ADA, BEA, framesOf, makeHarness, member, PAGE } from "./testing/harness";

/**
 * The security audit's server items in a space: automatic captures only from
 * the person who started the work (S1), bounded socket and push
 * authorization (S2), one hello per socket, a cap on live interactions,
 * bounded bodies and waits (S6), and push only to browser push services (S7).
 */

const sha256 = (b: Uint8Array) => createHash("sha256").update(b).digest("hex");
const DAY = 86_400_000;

function gzip(): Uint8Array {
  const b = new Uint8Array(12);
  b.set([0x1f, 0x8b], 0);
  return b;
}

const snapshot = (doc: Uint8Array) => ({
  kind: "snapshot",
  format: "onlay-cap/1",
  parts: [
    {
      name: "document",
      role: "document",
      mime: "application/gzip",
      byteLen: doc.length,
      sha256: sha256(doc),
    },
  ],
});

async function seed(kind: "comment" | "change" = "comment") {
  const h = makeHarness();
  const r = await h.request(member(ADA), "POST", "/interaction", {
    kind,
    url: PAGE,
    anchor: { level: "element", selector: "main > h1" },
    ...(kind === "comment" ? { body: { text: "look" } } : { change: { intent: "calmer" } }),
  });
  return { h, id: r.body.interactionId as string };
}

describe("automatic captures come from the person who started the work (S1)", () => {
  test("an Edit's context is captured only by its author", async () => {
    const { h, id } = await seed("change");
    const doc = gzip();
    const manifest = {
      kind: "edit-context",
      format: "onlay-cap/1",
      parts: snapshot(doc).parts,
    };
    const bea = await h.request(member(BEA), "POST", `/interaction/${id}/capture`, manifest);
    expect(bea.status).toBe(403);
    expect(bea.body.error.reason).toBe("not-yours");
    expect(
      (await h.request(member(ADA), "POST", `/interaction/${id}/capture`, manifest)).status,
    ).toBe(200);
  });

  test("a snapshot comes from the author, or from whoever asked for this fresh look", async () => {
    const { h, id } = await seed();
    const manifest = snapshot(gzip());
    const early = await h.request(member(BEA), "POST", `/interaction/${id}/capture`, manifest);
    expect(early.body.error.reason).toBe("not-yours");
    await h.request(member(BEA, "interaction"), "POST", `/interaction/${id}/resnap`);
    expect(
      (await h.request(member(BEA), "POST", `/interaction/${id}/capture`, manifest)).status,
    ).toBe(200);
    expect(
      (await h.request(member(ADA), "POST", `/interaction/${id}/capture`, manifest)).status,
    ).toBe(200);
  });

  test("an attachment stays open to every participant", async () => {
    const { h, id } = await seed();
    const bytes = new TextEncoder().encode("note");
    const r = await h.request(member(BEA, "interaction"), "POST", `/interaction/${id}/capture`, {
      kind: "attachment",
      format: "text/plain",
      parts: [
        { name: "file", role: "file", mime: "text/plain", byteLen: 4, sha256: sha256(bytes) },
      ],
    });
    expect(r.status).toBe(200);
  });
});

describe("authorization has a lifetime (S2)", () => {
  test("a socket authorized more than a day ago is closed normally on its next frame or broadcast", async () => {
    const { h, id } = await seed();
    const idle = h.connect(member(BEA));
    const busy = h.connect(member(ADA));
    h.clock.advance(SOCKET_AUTHORIZATION_MS + 1);
    h.send(busy, { v: 1, type: "attention-sync" });
    expect(busy.closed).toEqual({ code: 1000, reason: "re-authorize" });
    await h.request(member(ADA, "interaction"), "POST", `/interaction/${id}/reply`, {
      body: { text: "hello" },
    });
    expect(idle.closed?.code).toBe(1000);
    expect(framesOf(idle, "attention")).toEqual([]);
  });

  test("a re-scope never renews a socket's lifetime; the hourly sweep ends it (round 2, S8)", async () => {
    const h = makeHarness();
    const s = h.connect(member(BEA));
    h.clock.advance(SOCKET_AUTHORIZATION_MS - 1_000);
    await h.internal("POST", "/internal/access-changed", {
      personId: BEA,
      access: { kind: "member", role: "member" },
    });
    h.clock.advance(2_000);
    // No frame arrives: the host's hourly sweep closes it.
    h.space.sweepSockets();
    expect(s.closed).toEqual({ code: 1000, reason: "re-authorize" });
  });

  test("a socket with no upgrade time is closed at the next wake", () => {
    const h = makeHarness();
    const s = h.connect(member(BEA));
    const a = s.attachment();
    if (!a) throw new Error("no attachment");
    const { authorizedAt: _gone, ...legacy } = a;
    s.setAttachment(legacy);
    h.space.sweepSockets();
    expect(s.closed?.code).toBe(1000);
  });

  test("a push subscription not renewed for 30 days is dropped, not delivered to", async () => {
    const sent: string[] = [];
    const h = makeHarness({
      fetch: (async (url: string) => {
        sent.push(url);
        return new Response(null, { status: 201 });
      }) as unknown as typeof fetch,
    });
    const web = member(ADA, "interaction");
    const { makeUaKeys } = await import("./testing/webpush-receiver");
    const ua = makeUaKeys();
    expect(
      (
        await h.request(web, "POST", "/push/subscribe", {
          endpoint: "https://fcm.googleapis.com/fcm/send/ada",
          keys: { p256dh: ua.p256dh, auth: ua.auth },
        })
      ).status,
    ).toBe(200);
    h.clock.advance(31 * DAY);
    const id = (
      await h.request(member(BEA), "POST", "/interaction", {
        kind: "comment",
        url: PAGE,
        anchor: { level: "page" },
        body: { text: "@Ada", tokens: [{ t: "actor", actorId: ADA }] },
      })
    ).body.interactionId;
    expect(id).toBeTruthy();
    await new Promise((r) => setTimeout(r, 20));
    expect(sent).toEqual([]);
    expect(h.space.runtime.pushStore.listAll()).toEqual([]);
  });
});

describe("abuse limits (S6)", () => {
  test("a second hello hears the same welcome and journals nothing", () => {
    const h = makeHarness();
    const s = h.connect(member(ADA));
    const sessionId = s.attachment()?.sessionId as string;
    const events = () => h.space.runtime.journal.eventsFor("session", sessionId).length;
    const before = events();
    h.send(s, {
      v: 1,
      type: "hello",
      sessionId: crypto.randomUUID(),
      bootCount: 9,
      swRestarts: 9,
      connects: 9,
      protocol: 2,
    });
    const welcome = framesOf(s, "welcome");
    expect(welcome).toHaveLength(1);
    expect(welcome[0].sessionId).toBe(sessionId);
    expect(events()).toBe(before);
    expect(framesOf(s, "attention")).toEqual([]);
  });

  test("a space at MAX_LIVE_INTERACTIONS refuses new threads with space-full", async () => {
    const { h, id } = await seed();
    const rt = h.space.runtime;
    const base = rt.interactions.get(id) as InteractionState;
    for (let i = 0; i < LIMITS.MAX_LIVE_INTERACTIONS; i++) {
      const fake = { ...base, id: `00000000-0000-4000-8000-${String(i).padStart(12, "0")}` };
      rt.interactions.set(fake.id, fake);
    }
    expect([...rt.interactions.values()].filter(isLive).length).toBeGreaterThan(
      LIMITS.MAX_LIVE_INTERACTIONS,
    );
    const r = await h.request(member(ADA), "POST", "/interaction", {
      kind: "comment",
      url: PAGE,
      anchor: { level: "page" },
      body: { text: "one more" },
    });
    expect(r.status).toBe(409);
    expect(r.body.error.reason).toBe("space-full");
  });

  test("a body over the route's limit is refused before it is parsed", async () => {
    const { h, id } = await seed();
    const big = { body: { text: "x".repeat(70_000) } };
    const r = await h.request(member(ADA), "POST", `/interaction/${id}/reply`, big);
    expect(r.status).toBe(400);
    expect(r.body.error.reason).toBe("too-large");
    const declared = await h.request(
      member(ADA),
      "POST",
      `/interaction/${id}/react`,
      { msgId: "m1", emoji: "👍" },
      { "Content-Length": "999999" },
    );
    expect(declared.body.error.reason).toBe("too-large");
  });

  test("a fifth outstanding wait is rate_limited; finished waits free their slots", async () => {
    const { h, id } = await seed();
    const ada = member(ADA);
    const seq = h.space.runtime.journal.lastSeq("interaction", id);
    const waits = [1, 2, 3, 4].map(() =>
      h.request(ada, "GET", `/interaction/${id}/wait?since=${seq}&timeout=20`),
    );
    const fifth = await h.request(ada, "GET", `/interaction/${id}/wait?since=${seq}&timeout=20`);
    expect(fifth.status).toBe(429);
    expect(fifth.body.error.reason).toBe("too-many-waits");
    // Someone else still waits.
    const bea = h.request(member(BEA), "GET", `/interaction/${id}/wait?since=${seq}&timeout=20`);
    await h.request(member(BEA), "POST", `/interaction/${id}/reply`, { body: { text: "wake" } });
    for (const w of await Promise.all([...waits, bea])) expect(w.status).toBe(200);
    expect(h.space.runtime.waitsByPerson.size).toBe(0);
  });
});

describe("push goes only to browser push services (S7)", () => {
  test("endpoints off the list, on another port or without https are refused", async () => {
    const h = makeHarness();
    const web = member(ADA, "interaction");
    const keys = { p256dh: "B".repeat(87), auth: "a".repeat(22) };
    const sub = (endpoint: string) => h.request(web, "POST", "/push/subscribe", { endpoint, keys });
    for (const [endpoint, reason] of [
      ["https://internal.example.com/hook", "endpoint-not-push-service"],
      ["https://fcm.googleapis.com:8443/x", "endpoint-port"],
      ["http://fcm.googleapis.com/x", "endpoint-not-https"],
      ["https://push.apple.com.evil.test/x", "endpoint-not-push-service"],
    ] as const) {
      const r = await sub(endpoint);
      expect(r.status).toBe(400);
      expect(r.body.error.reason).toBe(reason);
    }
    for (const ok of [
      "https://fcm.googleapis.com/fcm/send/x",
      "https://updates.push.services.mozilla.com/wpush/v2/x",
      "https://web.push.apple.com/x",
      "https://wns2-db5p.notify.windows.com/w/?token=x",
    ]) {
      expect((await sub(ok)).status).toBe(200);
    }
  });
});
