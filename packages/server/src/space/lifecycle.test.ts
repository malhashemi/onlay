import { describe, expect, test } from "bun:test";
import { LIMITS } from "@onlay/protocol";
import { ADA, BEA, framesOf, GUS, guest, makeHarness, member, PAGE } from "./testing/harness";
import { decryptAes128Gcm, makeUaKeys } from "./testing/webpush-receiver";

/** A thread shared with Gus elsewhere in the space: a guest always holds at least one share. */
const OTHER_THREAD = "0f0f0f0f-0000-4000-8000-000000000001";
/**
 * An interaction's life in a space: threads (own-message edit and delete,
 * reactions), resolve and reopen, captured markup, state that survives an
 * eviction, the retention alarm, and web push on entering needs-you.
 */

const comment = (text: string) => ({
  kind: "comment",
  url: PAGE,
  anchor: { level: "element", selector: "main > h1" },
  body: { text },
});

async function seed() {
  const h = makeHarness();
  const ada = member(ADA);
  const r = await h.request(ada, "POST", "/interaction", comment("first"));
  return { h, ada, id: r.body.interactionId as string };
}

describe("threads", () => {
  test("edit and delete are own-message only; a re-delete is idempotent", async () => {
    const { h, ada, id } = await seed();
    const bea = member(BEA, "interaction");
    const reply = await h.request(bea, "POST", `/interaction/${id}/reply`, {
      body: { text: "hi" },
    });
    expect(reply.body.msgId).toBe("m2");
    expect(
      (
        await h.request(ada, "POST", `/interaction/${id}/edit`, {
          msgId: "m2",
          body: { text: "x" },
        })
      ).body.error.reason,
    ).toBe("not-editable");
    expect(
      (
        await h.request(bea, "POST", `/interaction/${id}/edit`, {
          msgId: "m2",
          body: { text: "hello" },
        })
      ).status,
    ).toBe(200);
    expect(
      (await h.request(bea, "POST", `/interaction/${id}/delete`, { msgId: "m2" })).status,
    ).toBe(200);
    expect(
      (await h.request(bea, "POST", `/interaction/${id}/delete`, { msgId: "m2" })).status,
    ).toBe(200);
    const thread = (await h.request(ada, "GET", `/interaction/${id}`)).body.interaction.thread;
    expect(thread[1]).toMatchObject({ deleted: true, body: { text: "" } });
  });

  test("a reaction on a phantom message is refused and never journaled", async () => {
    const { h, ada, id } = await seed();
    const before = h.space.runtime.journal.lastSeq("interaction", id);
    const r = await h.request(ada, "POST", `/interaction/${id}/react`, {
      msgId: "m9",
      emoji: "👍",
    });
    expect(r.body.error.reason).toBe("unknown-message");
    expect(h.space.runtime.journal.lastSeq("interaction", id)).toBe(before);
    expect(
      (await h.request(ada, "POST", `/interaction/${id}/react`, { msgId: "m1", emoji: "👍" })).body
        .on,
    ).toBe(true);
  });

  test("resolve and reopen; the snapshot always matches the journal's replay", async () => {
    const { h, ada, id } = await seed();
    expect((await h.request(ada, "POST", `/interaction/${id}/resolve`)).body.changed).toBe(true);
    expect((await h.request(ada, "POST", `/interaction/${id}/resolve`)).body.changed).toBe(false);
    expect(
      (await h.request(member(BEA, "interaction"), "POST", `/interaction/${id}/reopen`)).body
        .changed,
    ).toBe(true);
    const rt = h.space.runtime;
    expect(rt.interactionStore.replayFromEvents(id)).toEqual(rt.interactions.get(id));
  });
});

describe("captured markup", () => {
  test("anchor content: a member's extension writes once; everyone who may read it, reads", async () => {
    const { h, ada, id } = await seed();
    const html = "<h1>Pricing</h1>";
    const web = await h.request(
      member(BEA, "interaction"),
      "POST",
      `/interaction/${id}/anchor-content`,
      { content: html },
    );
    expect(web.status).toBe(403);
    const guestTry = await h.request(
      guest(GUS, [id], "full"),
      "POST",
      `/interaction/${id}/anchor-content`,
      { content: html },
    );
    expect(guestTry.status).toBe(403);
    expect(
      (await h.request(ada, "POST", `/interaction/${id}/anchor-content`, { content: html })).status,
    ).toBe(200);
    expect(
      (await h.request(ada, "POST", `/interaction/${id}/anchor-content`, { content: html })).body
        .error.reason,
    ).toBe("exists");
    const read = await h.request(guest(GUS, [id]), "GET", `/interaction/${id}/anchor-content`);
    expect(read.body).toMatchObject({ ok: true, format: "html", content: html, truncated: false });
    expect(
      (await h.request(guest(GUS, [OTHER_THREAD]), "GET", `/interaction/${id}/anchor-content`))
        .status,
    ).toBe(404);
  });

  test("page content belongs to a page edit and is capped at MAX_PAGE_CONTENT", async () => {
    const h = makeHarness();
    const ada = member(ADA);
    const edit = await h.request(ada, "POST", "/interaction", {
      kind: "change",
      url: PAGE,
      anchor: { level: "page" },
      change: { intent: "rework the page", method: "variant-set" },
    });
    const id = edit.body.interactionId;
    const big = "x".repeat(LIMITS.MAX_PAGE_CONTENT + 1);
    expect(
      (await h.request(ada, "POST", `/interaction/${id}/page-content`, { content: big })).status,
    ).toBe(400);
    const body = "<main>…</main>".repeat(10_000);
    expect(
      (await h.request(ada, "POST", `/interaction/${id}/page-content`, { content: body })).status,
    ).toBe(200);
    expect((await h.request(ada, "GET", `/interaction/${id}/page-content`)).body.content).toBe(
      body,
    );
    const c = await h.request(ada, "POST", "/interaction", comment("not an edit"));
    const refused = await h.request(
      ada,
      "POST",
      `/interaction/${c.body.interactionId}/page-content`,
      { content: "<p/>" },
    );
    expect(refused.body.error.reason).toBe("not-page");
  });
});

describe("eviction and retention", () => {
  test("state, sessions and attention survive an eviction; sockets keep their attachments", async () => {
    const { h, ada, id } = await seed();
    const socket = h.connect(member(BEA));
    await h.request(ada, "POST", `/interaction/${id}/reply`, { body: { text: "ping" } });
    h.evict();
    expect(
      (await h.request(member(BEA), "GET", `/interaction/${id}`)).body.interaction.thread,
    ).toHaveLength(2);
    socket.sent.length = 0;
    await h.request(ada, "POST", `/interaction/${id}/reply`, { body: { text: "after wake" } });
    expect(framesOf(socket, "interactions-state")).toHaveLength(1);
  });

  test("the alarm purges interactions resolved past the window, from storage and memory", async () => {
    const { h, ada, id } = await seed();
    const live = await h.request(ada, "POST", "/interaction", comment("still open"));
    await h.request(ada, "POST", `/interaction/${id}/resolve`);
    h.clock.advance(31 * 86_400_000);
    const result = h.space.alarm();
    expect(result.interactionsRemoved).toBe(1);
    expect((await h.request(ada, "GET", `/interaction/${id}`)).status).toBe(404);
    expect((await h.request(ada, "GET", `/interaction/${live.body.interactionId}`)).status).toBe(
      200,
    );
    h.evict();
    expect(h.space.runtime.interactions.has(id)).toBe(false);
  });
});

describe("web push", () => {
  test("entering needs-you pushes an encrypted payload; a guest hears only what is shared", async () => {
    const sent: Array<{ url: string; body: Uint8Array }> = [];
    const h = makeHarness({
      allowHttpPush: true,
      fetch: (async (url: string, init: RequestInit) => {
        sent.push({ url, body: new Uint8Array(init.body as ArrayBuffer) });
        return new Response(null, { status: 201 });
      }) as unknown as typeof fetch,
    });
    const ada = member(ADA);
    const ua = makeUaKeys();
    const web = member(ADA, "interaction");
    expect(
      (
        await h.request(member(ADA), "POST", "/push/subscribe", {
          endpoint: "https://fcm.googleapis.com/fcm/send/x",
          keys: { p256dh: ua.p256dh, auth: ua.auth },
        })
      ).status,
    ).toBe(403);
    expect(
      (
        await h.request(web, "POST", "/push/subscribe", {
          endpoint: "https://fcm.googleapis.com/fcm/send/ada",
          keys: { p256dh: ua.p256dh, auth: ua.auth },
        })
      ).status,
    ).toBe(200);
    const gusKeys = makeUaKeys();
    const created = await h.request(ada, "POST", "/interaction", comment("hello"));
    const id = created.body.interactionId;
    await h.request(guest(GUS, [OTHER_THREAD], "interaction"), "POST", "/push/subscribe", {
      endpoint: "https://fcm.googleapis.com/fcm/send/gus",
      keys: { p256dh: gusKeys.p256dh, auth: gusKeys.auth },
    });

    await h.request(member(BEA, "interaction"), "POST", `/interaction/${id}/reply`, {
      body: {
        text: "your call",
        tokens: [
          { t: "actor", actorId: ADA },
          { t: "actor", actorId: GUS },
        ],
      },
    });
    await Promise.resolve();
    await new Promise((r) => setTimeout(r, 30));
    expect(sent.map((s) => s.url)).toEqual(["https://fcm.googleapis.com/fcm/send/ada"]);
    const payload = JSON.parse(
      new TextDecoder().decode(
        decryptAes128Gcm(ua.uaPrivate, ua.authSecret, Buffer.from(sent[0]?.body ?? [])),
      ),
    );
    expect(payload).toMatchObject({
      interactionId: id,
      title: "Bea · mentioned you",
      body: "your call",
    });
    expect(payload.url).toBe(`/app/#/t/s_aaaaaaaaaaaaaaaaaaaa/${id}`);
    const config = await h.request(web, "GET", "/push/config");
    expect(config.body.vapidPublicKey).toMatch(/^B[A-Za-z0-9_-]{86}$/);
  });
});
