import { describe, expect, test } from "bun:test";
import {
  CALLER_HEADER,
  type Caller,
  type CallerAccess,
  CLOSE_ACCESS_REVOKED,
  encodeCaller,
} from "@onlay/protocol";
import {
  type DirectoryPort,
  REVALIDATE_ALL_MS,
  REVALIDATE_WRITES_MS,
  type ValidationEntry,
  type ValidationResult,
} from "./runtime";
import { ADA, BEA, framesOf, GUS, guest, makeHarness, member, PAGE } from "./testing/harness";
import { makeUaKeys } from "./testing/webpush-receiver";

/**
 * Round 3 in the space: re-validation against the directory with every
 * control call failing (R3-S2), push on current access (R3-S3), nothing
 * written after a purge (R3-S4), the one-shot markup permission (R3-S5) and
 * `?peek=1` (R3-S9).
 */

/** A directory the test edits; every control call to the space is simply never made. */
function fakeDirectory() {
  const access = new Map<string, CallerAccess | null>();
  const generation = new Map<string, number>();
  const dead = new Set<string>();
  const asked: ValidationEntry[][] = [];
  let failing = false;
  const port: DirectoryPort = {
    async validate(entries) {
      asked.push(entries);
      if (failing) throw new Error("D1 unreachable");
      return entries.map(
        (e): ValidationResult => ({
          personId: e.personId,
          credentialId: e.credentialId,
          live: !dead.has(e.credentialId),
          personGeneration: generation.get(e.personId) ?? 0,
          access: access.has(e.personId)
            ? (access.get(e.personId) ?? null)
            : { kind: "member", role: "member" },
          epoch: 0,
        }),
      );
    },
  };
  return {
    port,
    access,
    generation,
    dead,
    asked,
    fail: () => {
      failing = true;
    },
  };
}

const anchored = (text: string) => ({
  kind: "comment",
  url: PAGE,
  anchor: { level: "element", selector: "h1" },
  body: { text },
});

const replyFrame = (interactionId: string, text: string) => ({
  v: 1,
  type: "interaction-reply",
  frameUrl: PAGE,
  interactionId,
  body: { text },
  msgId: crypto.randomUUID(),
});

const texts = (h: ReturnType<typeof makeHarness>, id: string) =>
  (h.space.runtime.interactions.get(id)?.thread ?? []).map((m) => m.body.text);

describe("R3-S2: a removed member's socket, with every control failing", () => {
  test("writes for at most 60 s after the last validation; the next mutating frame closes it", async () => {
    const dir = fakeDirectory();
    const h = makeHarness({ directory: dir.port });
    const id = (await h.request(member(ADA), "POST", "/interaction", anchored("x"))).body
      .interactionId as string;
    const bea = h.connect(member(BEA)); // validated at the upgrade
    // Bea is removed in the directory right after; the control never arrives.
    dir.access.set(BEA, null);
    h.clock.advance(REVALIDATE_WRITES_MS); // exactly 60 s: still inside the window
    expect(h.send(bea, replyFrame(id, "at 60 s"))).toBeUndefined();
    expect(texts(h, id)).toContain("at 60 s");
    expect(dir.asked).toHaveLength(0);
    h.clock.advance(1); // 60.001 s
    await h.send(bea, replyFrame(id, "at 60.001 s"));
    expect(dir.asked).toHaveLength(1);
    expect(bea.closed?.code).toBe(CLOSE_ACCESS_REVOKED);
    expect(texts(h, id)).not.toContain("at 60.001 s");
  });

  test("frames queued behind a re-validation run in order, or not at all when it closes the socket", async () => {
    const dir = fakeDirectory();
    const h = makeHarness({ directory: dir.port });
    const id = (await h.request(member(ADA), "POST", "/interaction", anchored("x"))).body
      .interactionId as string;
    const bea = h.connect(member(BEA));
    h.clock.advance(REVALIDATE_WRITES_MS + 1);
    const first = h.send(bea, replyFrame(id, "one"));
    const second = h.send(bea, replyFrame(id, "two"));
    expect(first).toBeDefined();
    expect(second).toBeDefined();
    await second;
    expect(texts(h, id).slice(-2)).toEqual(["one", "two"]);
    // Validated just now: the next frame runs at once.
    expect(h.send(bea, replyFrame(id, "three"))).toBeUndefined();
    dir.access.set(BEA, null);
    h.clock.advance(REVALIDATE_WRITES_MS + 1);
    const a = h.send(bea, replyFrame(id, "four"));
    const b = h.send(bea, replyFrame(id, "five"));
    await b;
    await a;
    expect(texts(h, id)).not.toContain("four");
    expect(texts(h, id)).not.toContain("five");
  });

  test("receives broadcasts until the host's pass, at most 5 minutes later, then nothing", async () => {
    const dir = fakeDirectory();
    const h = makeHarness({ directory: dir.port });
    const id = (await h.request(member(ADA), "POST", "/interaction", anchored("x"))).body
      .interactionId as string;
    const bea = h.connect(member(BEA));
    dir.access.set(BEA, null);
    h.clock.advance(REVALIDATE_ALL_MS - 1);
    await h.request(member(ADA), "POST", `/interaction/${id}/reply`, { body: { text: "heard" } });
    expect(framesOf(bea, "interactions-state").length).toBeGreaterThan(0);
    // The host's alarm runs at most REVALIDATE_ALL_MS apart while sockets are open.
    h.clock.advance(1);
    await h.space.validateSockets();
    expect(bea.closed?.code).toBe(CLOSE_ACCESS_REVOKED);
    bea.sent.length = 0;
    await h.request(member(ADA), "POST", `/interaction/${id}/reply`, { body: { text: "unheard" } });
    expect(bea.sent).toEqual([]);
  });

  test("a guest who lost one share keeps the socket, hears access-changed, and stops hearing that thread", async () => {
    const dir = fakeDirectory();
    const h = makeHarness({ directory: dir.port });
    const keep = (await h.request(member(ADA), "POST", "/interaction", anchored("keep"))).body
      .interactionId as string;
    const lose = (await h.request(member(ADA), "POST", "/interaction", anchored("lose"))).body
      .interactionId as string;
    const gus = h.connect(guest(GUS, [keep, lose], "full"));
    dir.access.set(GUS, { kind: "guest", interactionIds: [keep] });
    h.clock.advance(REVALIDATE_ALL_MS);
    await h.space.validateSockets();
    expect(gus.closed).toBeNull();
    expect(framesOf(gus, "access-changed")).toHaveLength(1);
    gus.sent.length = 0;
    await h.request(member(ADA), "POST", `/interaction/${lose}/reply`, { body: { text: "x" } });
    expect(gus.sent).toEqual([]);
    // And a write to the lost thread after 60 s is refused like any other.
    h.clock.advance(REVALIDATE_WRITES_MS + 1);
    await h.send(gus, replyFrame(lose, "still here?"));
    expect(texts(h, lose)).not.toContain("still here?");
  });

  test("a credential the directory no longer knows, or of an older generation, closes and stays refused", async () => {
    const dir = fakeDirectory();
    const h = makeHarness({ directory: dir.port });
    const gone: Caller = { ...member(BEA), credentialId: "tok_gone" };
    const old: Caller = { ...member(ADA), credentialId: "tok_old", credentialGeneration: 0 };
    const a = h.connect(gone);
    const b = h.connect(old);
    dir.dead.add("tok_gone");
    dir.generation.set(ADA, 1);
    dir.dead.add("tok_old"); // the directory deleted it with the generation change
    await h.space.validateSockets();
    expect(a.closed?.code).toBe(CLOSE_ACCESS_REVOKED);
    expect(b.closed?.code).toBe(CLOSE_ACCESS_REVOKED);
    expect((await h.request(gone, "GET", "/attention")).status).toBe(401);
    expect((await h.request(old, "GET", "/attention")).status).toBe(401);
    // A credential stamped with the new generation is welcome.
    expect(
      (
        await h.request(
          { ...member(ADA), credentialId: "tok_new", credentialGeneration: 1 },
          "GET",
          "/attention",
        )
      ).status,
    ).toBe(200);
  });

  test("when the directory can't be asked, the socket closes normally so its client re-authorizes", async () => {
    const dir = fakeDirectory();
    const h = makeHarness({ directory: dir.port });
    const id = (await h.request(member(ADA), "POST", "/interaction", anchored("x"))).body
      .interactionId as string;
    const bea = h.connect(member(BEA));
    dir.fail();
    h.clock.advance(REVALIDATE_WRITES_MS + 1);
    await h.send(bea, replyFrame(id, "unvouched"));
    expect(bea.closed).toEqual({ code: 1000, reason: "re-authorize" });
    expect(texts(h, id)).not.toContain("unvouched");
  });
});

describe("R3-S3: push follows current access", () => {
  const keys = makeUaKeys();
  const subscribe = (h: ReturnType<typeof makeHarness>, who: Caller) =>
    h.request(who, "POST", "/push/subscribe", {
      endpoint: `https://fcm.googleapis.com/fcm/send/${who.credentialId}`,
      keys: { p256dh: keys.p256dh, auth: keys.auth },
    });

  test("delivery reads the person's current access, never the scope stored with the subscription", async () => {
    const sent: string[] = [];
    const h = makeHarness({
      fetch: (async (url: string) => {
        sent.push(url);
        return new Response(null, { status: 201 });
      }) as unknown as typeof fetch,
    });
    const shared = (await h.request(member(ADA), "POST", "/interaction", anchored("shared"))).body
      .interactionId as string;
    const other = (await h.request(member(ADA), "POST", "/interaction", anchored("other"))).body
      .interactionId as string;
    const gus = guest(GUS, [shared]);
    expect((await subscribe(h, gus)).status).toBe(200);
    // A stale row claims more than Gus has now.
    h.space.runtime.db.run(
      "UPDATE push_subscriptions SET access_json = ? WHERE credential_id = ?",
      JSON.stringify({ kind: "member", role: "member" }),
      gus.credentialId,
    );
    await h.request(member(ADA), "POST", `/interaction/${other}/reply`, {
      body: { text: "@Gus", tokens: [{ t: "actor", actorId: GUS }] },
    });
    await new Promise((r) => setTimeout(r, 20));
    expect(sent).toEqual([]);
    await h.request(member(ADA), "POST", `/interaction/${shared}/reply`, {
      body: { text: "@Gus", tokens: [{ t: "actor", actorId: GUS }] },
    });
    await new Promise((r) => setTimeout(r, 20));
    expect(sent).toHaveLength(1);
  });

  test("a subscription of a revoked credential or an older generation is skipped and dropped", async () => {
    const sent: string[] = [];
    const h = makeHarness({
      fetch: (async (url: string) => {
        sent.push(url);
        return new Response(null, { status: 201 });
      }) as unknown as typeof fetch,
    });
    const ada = { ...member(ADA, "interaction"), credentialId: "ses_ada", credentialGeneration: 0 };
    expect((await subscribe(h, ada)).status).toBe(200);
    // The minimum moved without the row being swept (say, a row restored by a race).
    h.space.runtime.db.run(
      "INSERT INTO credential_generations (person_id, min_generation) VALUES (?, 1)",
      ADA,
    );
    await h.request(member(BEA), "POST", "/interaction", {
      ...anchored("@Ada"),
      body: { text: "@Ada", tokens: [{ t: "actor", actorId: ADA }] },
    });
    await new Promise((r) => setTimeout(r, 20));
    expect(sent).toEqual([]);
    expect(h.space.runtime.pushStore.listAll()).toEqual([]);
  });

  test("subscribe re-checks after its body: a revocation that landed meanwhile wins", async () => {
    const h = makeHarness();
    const ada = { ...member(ADA, "interaction"), credentialId: "ses_ada" };
    let release: () => void = () => {};
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const body = new ReadableStream<Uint8Array>({
      async start(controller) {
        await gate;
        controller.enqueue(
          new TextEncoder().encode(
            JSON.stringify({
              endpoint: "https://fcm.googleapis.com/fcm/send/x",
              keys: { p256dh: keys.p256dh, auth: keys.auth },
            }),
          ),
        );
        controller.close();
      },
    });
    const pending = h.space.fetch(
      new Request("https://space/push/subscribe", {
        method: "POST",
        headers: { [CALLER_HEADER]: encodeCaller(ada), "Content-Type": "application/json" },
        body,
        // @ts-expect-error -- Bun's Request needs it for a stream body
        duplex: "half",
      }),
    );
    await new Promise((r) => setTimeout(r, 5));
    await h.internal("POST", "/internal/credential-revoked", {
      personId: ADA,
      credentialIds: ["ses_ada"],
    });
    release();
    expect((await pending).status).toBe(401);
    expect(h.space.runtime.pushStore.listAll()).toEqual([]);
  });
});

describe("R3-S4: nothing is written after a purge", () => {
  test("a create admitted before the purge, whose body arrives after it, writes nothing", async () => {
    const h = makeHarness();
    let release: () => void = () => {};
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const body = new ReadableStream<Uint8Array>({
      async start(controller) {
        await gate;
        controller.enqueue(new TextEncoder().encode(JSON.stringify(anchored("late"))));
        controller.close();
      },
    });
    const pending = h.space.fetch(
      new Request("https://space/interaction", {
        method: "POST",
        headers: { [CALLER_HEADER]: encodeCaller(member(ADA)), "Content-Type": "application/json" },
        body,
        // @ts-expect-error -- Bun's Request needs it for a stream body
        duplex: "half",
      }),
    );
    await new Promise((r) => setTimeout(r, 5));
    expect((await h.internal("POST", "/internal/purge")).status).toBe(200);
    release();
    expect((await pending).status).toBe(404);
    expect(h.db.get("SELECT count(*) AS n FROM interactions")?.n).toBe(0);
    expect(h.db.get("SELECT count(*) AS n FROM events")?.n).toBe(0);
    h.evict();
    expect(h.space.runtime.interactions.size).toBe(0);
  });
});

describe("R3-S5: the markup permission is one shot, per anchor revision", () => {
  const upload = (h: ReturnType<typeof makeHarness>, who: Caller, id: string) =>
    h.request(who, "POST", `/interaction/${id}/anchor-content`, {
      content: "<h1>Pricing</h1>",
      format: "html",
      truncated: false,
    });
  const reanchor = (
    h: ReturnType<typeof makeHarness>,
    socket: ReturnType<ReturnType<typeof makeHarness>["connect"]>,
    id: string,
    selector: string,
  ) =>
    h.send(socket, {
      v: 1,
      type: "interaction-reanchor",
      frameUrl: PAGE,
      interactionId: id,
      anchor: { level: "element", selector },
    });
  const pageThread = async (h: ReturnType<typeof makeHarness>) =>
    (
      await h.request(member(ADA), "POST", "/interaction", {
        kind: "comment",
        url: PAGE,
        anchor: { level: "page" },
        body: { text: "this page" },
      })
    ).body.interactionId as string;

  test("re-anchoring onto the same place grants nothing", async () => {
    const h = makeHarness();
    const ada = h.connect(member(ADA));
    const bea = h.connect(member(BEA));
    const id = await pageThread(h);
    reanchor(h, ada, id, "h1"); // the author moves it onto h1
    reanchor(h, bea, id, "h1"); // Bea "moves" it onto the same h1
    expect((await upload(h, member(BEA), id)).status).toBe(403);
  });

  test("a real move grants one upload; the first one consumes it", async () => {
    const h = makeHarness();
    const bea = h.connect(member(BEA));
    const id = await pageThread(h);
    reanchor(h, bea, id, "h1");
    expect((await upload(h, member(BEA), id)).status).toBe(200);
    const again = await upload(h, member(BEA), id);
    expect(again.status).toBe(409);
    expect(again.body.error.reason).toBe("exists");
  });

  test("the next move replaces it", async () => {
    const h = makeHarness();
    const ada = h.connect(member(ADA));
    const bea = h.connect(member(BEA));
    const id = await pageThread(h);
    reanchor(h, bea, id, "h1");
    reanchor(h, ada, id, "h2"); // the author moves it again
    const res = await upload(h, member(BEA), id);
    expect(res.status).toBe(403);
    expect(res.body.error.reason).toBe("not-yours");
  });
});

describe("R3-S9: ?peek=1 never pays the share debt", () => {
  test("a peek leaves `shared`; opening the thread pays it", async () => {
    const h = makeHarness();
    const id = (await h.request(member(ADA), "POST", "/interaction", anchored("for Gus"))).body
      .interactionId as string;
    await h.internal("POST", "/internal/access-changed", {
      personId: GUS,
      access: { kind: "guest", interactionIds: [id] },
    });
    const gus = guest(GUS, [id], "full");
    const peek = await h.request(gus, "GET", `/interaction/${id}?peek=1`);
    expect(peek.status).toBe(200);
    expect(h.space.runtime.interactions.get(id)?.shareUnseen).toEqual([GUS]);
    await h.request(gus, "GET", `/interaction/${id}`);
    expect(h.space.runtime.interactions.get(id)?.shareUnseen).toBeUndefined();
  });
});
