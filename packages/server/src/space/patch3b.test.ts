import { describe, expect, test } from "bun:test";
import type { Caller, CallerAccess } from "@onlay/protocol";
import type { DirectoryPort } from "./runtime";
import { ADA, GUS, guest, makeHarness, member, PAGE } from "./testing/harness";
import { makeUaKeys } from "./testing/webpush-receiver";

/**
 * Patch 3b in the space: a push renewal carrying a newer epoch replaces the
 * person's access record (3b-S2), only a real move grants the markup upload
 * (3b-S3), and a directory answer never widens a socket admitted with a
 * newer epoch (3b-S4).
 */

const anchored = (text: string) => ({
  kind: "comment",
  url: PAGE,
  anchor: { level: "element", selector: "h1" },
  body: { text },
});

describe("3b-S2: a subscribe with a newer epoch replaces the access record", () => {
  test("a renewal after the edge narrowed a member to a guest pushes only what the guest may see", async () => {
    const sent: string[] = [];
    const h = makeHarness({
      fetch: (async (url: string) => {
        sent.push(url);
        return new Response(null, { status: 201 });
      }) as unknown as typeof fetch,
    });
    const keys = makeUaKeys();
    const shared = (await h.request(member(ADA), "POST", "/interaction", anchored("shared"))).body
      .interactionId as string;
    const other = (await h.request(member(ADA), "POST", "/interaction", anchored("other"))).body
      .interactionId as string;
    const sub = (who: Caller) =>
      h.request(who, "POST", "/push/subscribe", {
        endpoint: "https://fcm.googleapis.com/fcm/send/gus",
        keys: { p256dh: keys.p256dh, auth: keys.auth },
      });
    // Gus subscribed as a member at epoch 3 ...
    expect((await sub({ ...member(GUS, "interaction"), accessEpoch: 3 })).status).toBe(200);
    // ... and renews at epoch 5, after the edge narrowed him to one shared thread.
    expect((await sub({ ...guest(GUS, [shared]), accessEpoch: 5 })).status).toBe(200);
    const row = h.db.get<{ access_json: string; epoch: number }>(
      "SELECT access_json, epoch FROM person_access WHERE person_id = ?",
      GUS,
    );
    expect(row?.epoch).toBe(5);
    expect(JSON.parse(row?.access_json ?? "null")).toEqual({
      kind: "guest",
      interactionIds: [shared],
    });
    const mention = { body: { text: "@Gus", tokens: [{ t: "actor", actorId: GUS }] } };
    await h.request(member(ADA), "POST", `/interaction/${other}/reply`, mention);
    await new Promise((r) => setTimeout(r, 20));
    expect(sent).toEqual([]);
    await h.request(member(ADA), "POST", `/interaction/${shared}/reply`, mention);
    await new Promise((r) => setTimeout(r, 20));
    expect(sent).toHaveLength(1);
    // An older renewal never rolls it back.
    expect((await sub({ ...member(GUS, "interaction"), accessEpoch: 5 })).status).toBe(200);
    expect(
      h.db.get<{ epoch: number }>("SELECT epoch FROM person_access WHERE person_id = ?", GUS)
        ?.epoch,
    ).toBe(5);
  });
});

describe("3b-S3: only a real move grants the markup upload", () => {
  const reanchor = (
    h: ReturnType<typeof makeHarness>,
    socket: ReturnType<ReturnType<typeof makeHarness>["connect"]>,
    id: string,
    anchor: Record<string, unknown>,
  ) =>
    h.send(socket, {
      v: 1,
      type: "interaction-reanchor",
      frameUrl: PAGE,
      interactionId: id,
      anchor,
    });
  const upload = (h: ReturnType<typeof makeHarness>, id: string) =>
    h.request(member(GUS), "POST", `/interaction/${id}/anchor-content`, {
      content: "<h1>Pricing</h1>",
      format: "html",
      truncated: false,
    });

  test("new snippet or source pointer on the same block grants nothing; a new block id does", async () => {
    const h = makeHarness();
    const ada = h.connect(member(ADA));
    const gus = h.connect(member(GUS));
    const id = (
      await h.request(member(ADA), "POST", "/interaction", {
        kind: "comment",
        url: PAGE,
        anchor: { level: "page" },
        body: { text: "this page" },
      })
    ).body.interactionId as string;
    const block = { level: "element", selector: "main > h1", blockId: "hero" };
    reanchor(h, ada, id, block);
    reanchor(h, gus, id, { ...block, snippet: "Pricing, renamed", sourcePointer: "src/a.tsx:3" });
    expect((await upload(h, id)).status).toBe(403);
    reanchor(h, gus, id, { ...block, blockId: "hero-2" });
    expect((await upload(h, id)).status).toBe(200);
  });
});

describe("3b-S4: a directory answer never widens a socket", () => {
  test("an answer older than a socket's epoch is ignored for it and applied to older ones", async () => {
    let answer: { access: CallerAccess; epoch: number } = {
      access: { kind: "member", role: "member" },
      epoch: 6,
    };
    const directory: DirectoryPort = {
      async validate(entries) {
        return entries.map((e) => ({
          personId: e.personId,
          credentialId: e.credentialId,
          live: true,
          personGeneration: 0,
          access: answer.access,
          epoch: answer.epoch,
        }));
      },
    };
    const h = makeHarness({ directory });
    const id = (await h.request(member(ADA), "POST", "/interaction", anchored("x"))).body
      .interactionId as string;
    const older = h.connect({
      ...guest(GUS, [id], "full"),
      credentialId: "tok_old",
      accessEpoch: 5,
    });
    const newer = h.connect({
      ...guest(GUS, [id], "full"),
      credentialId: "tok_new",
      accessEpoch: 7,
    });
    await h.space.validateSockets();
    expect(newer.attachment()?.caller.access).toEqual({ kind: "guest", interactionIds: [id] });
    expect(newer.attachment()?.caller.accessEpoch).toBe(7);
    expect(older.attachment()?.caller.access).toEqual({ kind: "member", role: "member" });
    // A newer answer applies to every socket it is at least as new as.
    answer = { access: { kind: "guest", interactionIds: [id] }, epoch: 8 };
    await h.space.validateSockets();
    expect(older.attachment()?.caller.access).toEqual({ kind: "guest", interactionIds: [id] });
    expect(newer.attachment()?.caller.accessEpoch).toBe(8);
  });
});
