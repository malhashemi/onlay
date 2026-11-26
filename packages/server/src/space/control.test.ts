import { describe, expect, test } from "bun:test";
import {
  CALLER_HEADER,
  type Caller,
  CLOSE_ACCESS_REVOKED,
  encodeCaller,
  encodeSpaceFacts,
  SPACE_HEADER,
} from "@onlay/protocol";
import { ADA, BEA, framesOf, GUS, guest, makeHarness, member, PAGE } from "./testing/harness";
import { makeUaKeys } from "./testing/webpush-receiver";

/**
 * The edge's control calls as the space applies them (review findings 1, 2
 * and 15): the access epoch refuses stale forwards and upgrades, an older
 * delivery for the same subject changes nothing, sockets are re-scoped
 * before anything is broadcast, sign-out closes exactly the credentials it
 * names and drops their push, and interactions retention removes are offered
 * to the host until it confirms their shares are gone.
 */

const DAY = 86_400_000;
const at = (who: Caller, accessEpoch: number): Caller => ({ ...who, accessEpoch });

/** The edge's access control: the person's whole scope at `epoch` (guest ids, or none). */
function grant(h: ReturnType<typeof makeHarness>, personId: string, ids: string[], epoch?: number) {
  return h.internal(
    "POST",
    "/internal/access-changed",
    { personId, access: ids.length > 0 ? { kind: "guest", interactionIds: ids } : null },
    epoch,
  );
}

function anchored(text: string) {
  return {
    kind: "comment",
    url: PAGE,
    anchor: { level: "element", selector: "h1" },
    body: { text },
  };
}

describe("the access epoch (finding 1b)", () => {
  test("a request or upgrade read before a change the space was told of is stale and retryable", async () => {
    const h = makeHarness();
    await h.internal("POST", "/internal/access-changed", { personId: GUS, access: null }, 5);
    const stale = await h.request(at(member(ADA), 4), "GET", "/attention");
    expect(stale.status).toBe(409);
    expect(stale.body.error.reason).toBe("stale-access");
    expect((await h.request(at(member(ADA), 5), "GET", "/attention")).status).toBe(200);
    // No epoch at all is refused (round 2, S5): every forward carries one.
    const { accessEpoch: _none, ...noEpoch } = member(ADA);
    expect((await h.request(noEpoch as Caller, "GET", "/attention")).status).toBe(401);
    const upgrade = h.space.admitSocket(
      new Request("https://space/ws", {
        headers: {
          [CALLER_HEADER]: encodeCaller(at(member(ADA), 3)),
          [SPACE_HEADER]: encodeSpaceFacts({ kind: "workspace", name: "acme" }),
          Upgrade: "websocket",
        },
      }),
    );
    expect(upgrade.ok).toBe(false);
    if (!upgrade.ok) expect(upgrade.response.status).toBe(409);
  });

  test("a delayed upgrade from before a revocation can't open a socket with the old grant", async () => {
    const h = makeHarness();
    const ada = member(ADA);
    const r = await h.request(ada, "POST", "/interaction", anchored("shared"));
    const id = r.body.interactionId as string;
    // The share is removed at epoch 2; an upgrade read at epoch 1 arrives after.
    await grant(h, GUS, [], 2);
    expect(() => h.connect(at(guest(GUS, [id], "full"), 1))).toThrow("socket refused: 409");
  });

  test("an older delivery for the same subject is accepted and skipped", async () => {
    const h = makeHarness();
    const ada = member(ADA);
    const r = await h.request(ada, "POST", "/interaction", anchored("shared"));
    const id = r.body.interactionId as string;
    const gus = h.connect(at(guest(GUS, [id], "full"), 6));
    const removed = await h.internal(
      "POST",
      "/internal/access-changed",
      { personId: GUS, access: null },
      7,
    );
    expect(removed.body).toEqual({ ok: true });
    expect(gus.closed?.code).toBe(CLOSE_ACCESS_REVOKED);
    // The grant read at epoch 6 arrives late: it changes nothing.
    const late = await h.internal(
      "POST",
      "/internal/access-changed",
      { personId: GUS, access: { kind: "guest", interactionIds: [id] } },
      6,
    );
    expect(late.body).toEqual({ ok: true, stale: true });
    expect(h.space.runtime.accessUpdates.get(GUS)?.access).toBeNull();
    // A newer one for someone else still applies.
    expect(
      (await h.internal("POST", "/internal/access-changed", { personId: BEA, access: null }, 6))
        .body,
    ).toEqual({ ok: true });
  });

  test("a share change re-scopes every affected socket before anything is sent", async () => {
    const h = makeHarness();
    const ada = member(ADA);
    const a = (await h.request(ada, "POST", "/interaction", anchored("a"))).body.interactionId;
    const b = (await h.request(ada, "POST", "/interaction", anchored("b"))).body.interactionId;
    const one = h.connect(at(guest(GUS, [a, b], "full"), 1));
    const two = h.connect(at(guest(GUS, [a, b], "full"), 1));
    const seen: string[] = [];
    for (const s of [one, two]) {
      const send = s.send.bind(s);
      s.send = (data: string) => {
        // Whenever any frame leaves, neither socket may still hold the old grant.
        for (const other of [one, two]) {
          const access = other.attachment()?.caller.access;
          if (access?.kind === "guest" && access.interactionIds.includes(b)) seen.push(data);
        }
        send(data);
      };
    }
    await grant(h, GUS, [a, b], 1);
    seen.length = 0;
    await grant(h, GUS, [a], 2);
    expect(seen).toEqual([]);
    for (const s of [one, two]) {
      expect(s.attachment()?.caller).toMatchObject({
        access: { kind: "guest", interactionIds: [a] },
        accessEpoch: 2,
      });
      const attention = framesOf(s, "attention").at(-1);
      expect(JSON.stringify(attention)).not.toContain(b);
    }
  });
});

describe("sign-out reaches the space (finding 2)", () => {
  test("a revoked credential's sockets close and its push subscription goes; others stay", async () => {
    const h = makeHarness({ allowHttpPush: true });
    const tokenA: Caller = { ...member(ADA), credentialId: "tok_a" };
    const tokenB: Caller = { ...member(ADA), credentialId: "tok_b" };
    const web: Caller = { ...member(ADA, "interaction"), credentialId: "ses_1" };
    const a = h.connect(tokenA);
    const b = h.connect(tokenB);
    const ua = makeUaKeys();
    await h.request(web, "POST", "/push/subscribe", {
      endpoint: "https://fcm.googleapis.com/fcm/send/ada",
      keys: { p256dh: ua.p256dh, auth: ua.auth },
    });
    const revoked = await h.internal(
      "POST",
      "/internal/credential-revoked",
      { personId: ADA, credentialIds: ["tok_a", "ses_1"] },
      3,
    );
    expect(revoked.status).toBe(200);
    expect(a.closed?.code).toBe(CLOSE_ACCESS_REVOKED);
    expect(b.closed).toBeNull();
    expect(h.space.runtime.pushStore.listAll()).toEqual([]);
    // A socket the revoked token was still opening is refused, at any epoch.
    expect(() => h.connect(at(tokenA, 2))).toThrow("socket refused: 409");
    expect(() => h.connect(at(tokenA, 3))).toThrow("socket refused: 401");
    // Sign out everywhere: every credential of the person below the new generation.
    await h.internal(
      "POST",
      "/internal/credential-revoked",
      { personId: ADA, minGeneration: 1 },
      4,
    );
    expect(b.closed?.code).toBe(CLOSE_ACCESS_REVOKED);
  });

  test("a revocation applies even when it arrives after a newer call", async () => {
    const h = makeHarness();
    const s = h.connect({ ...member(ADA), credentialId: "tok_a" });
    await h.internal("POST", "/internal/access-changed", { personId: BEA, access: null }, 9);
    await h.internal(
      "POST",
      "/internal/credential-revoked",
      { personId: ADA, credentialIds: ["tok_a"] },
      8,
    );
    expect(s.closed?.code).toBe(CLOSE_ACCESS_REVOKED);
  });
});

describe("retention drops the directory's shares (finding 15)", () => {
  async function resolvedAndAged(h: ReturnType<typeof makeHarness>) {
    const ada = member(ADA);
    const id = (await h.request(ada, "POST", "/interaction", anchored("old"))).body
      .interactionId as string;
    await h.request(ada, "POST", `/interaction/${id}/resolve`);
    h.clock.advance(31 * DAY);
    return id;
  }

  test("the removed interactions reach the host's port, and are forgotten once it confirms", async () => {
    const reported: string[][] = [];
    const h = makeHarness({
      sharesGone: async (ids) => {
        reported.push(ids);
      },
    });
    const id = await resolvedAndAged(h);
    const result = h.space.alarm();
    expect(result.removedInteractionIds).toEqual([id]);
    await h.space.reportRemovedShares();
    expect(reported).toEqual([[id]]);
    await h.space.reportRemovedShares();
    expect(reported).toHaveLength(1);
  });

  test("a failed report is offered again at the next pass", async () => {
    let fail = true;
    const reported: string[][] = [];
    const h = makeHarness({
      sharesGone: async (ids) => {
        if (fail) throw new Error("d1 unavailable");
        reported.push(ids);
      },
    });
    const id = await resolvedAndAged(h);
    h.space.alarm();
    await h.space.reportRemovedShares();
    expect(reported).toEqual([]);
    fail = false;
    h.evict();
    await h.space.reportRemovedShares();
    expect(reported).toEqual([[id]]);
  });
});

describe("a share lands in the guest's Inbox (end-to-end finding)", () => {
  async function shared() {
    const h = makeHarness();
    const id = (await h.request(member(ADA), "POST", "/interaction", anchored("for Gus"))).body
      .interactionId as string;
    const added = await grant(h, GUS, [id]);
    expect(added.status).toBe(200);
    return { h, id, gus: guest(GUS, [id]) };
  }

  test("the guest becomes a participant and finds it under needs-you, because shared", async () => {
    const { h, id, gus } = await shared();
    const s = h.space.runtime.interactions.get(id);
    expect(s?.participants).toContain(GUS);
    expect(s?.shareUnseen).toEqual([GUS]);
    const attention = await h.request(gus, "GET", "/attention");
    expect(attention.body.needsYou).toEqual([
      expect.objectContaining({ interactionId: id, because: "shared" }),
    ]);
    expect(attention.body.needsYouCount).toBe(1);
    expect(h.space.runtime.interactionStore.replayFromEvents(id)).toEqual(s);
  });

  test("opening it by id pays the debt; then the ordinary rules apply", async () => {
    const { h, id, gus } = await shared();
    expect((await h.request(gus, "GET", `/interaction/${id}`)).status).toBe(200);
    expect(h.space.runtime.interactions.get(id)?.shareUnseen).toBeUndefined();
    expect((await h.request(gus, "GET", "/attention")).body.needsYou).toEqual([]);
    expect(h.space.runtime.interactionStore.replayFromEvents(id)).toEqual(
      h.space.runtime.interactions.get(id),
    );
  });

  test("a reply or a reaction pays it too", async () => {
    const first = await shared();
    await first.h.request(first.gus, "POST", `/interaction/${first.id}/reply`, {
      body: { text: "thanks" },
    });
    expect(first.h.space.runtime.interactions.get(first.id)?.shareUnseen).toBeUndefined();
    const second = await shared();
    await second.h.request(second.gus, "POST", `/interaction/${second.id}/react`, {
      msgId: "m1",
      emoji: "👍",
    });
    expect(second.h.space.runtime.interactions.get(second.id)?.shareUnseen).toBeUndefined();
  });

  test("removing the share removes the participant and the debt", async () => {
    const { h, id } = await shared();
    await grant(h, GUS, []);
    const s = h.space.runtime.interactions.get(id);
    expect(s?.participants).not.toContain(GUS);
    expect(s?.sharedWith).toBeUndefined();
    expect(s?.shareUnseen).toBeUndefined();
    expect(h.space.runtime.interactionStore.replayFromEvents(id)).toEqual(s);
  });

  test("the guest's open socket hears it in its attention frame", async () => {
    const h = makeHarness();
    const id = (await h.request(member(ADA), "POST", "/interaction", anchored("for Gus"))).body
      .interactionId as string;
    const other = (await h.request(member(ADA), "POST", "/interaction", anchored("other"))).body
      .interactionId as string;
    await grant(h, GUS, [other]);
    await h.request(guest(GUS, [other]), "GET", `/interaction/${other}`);
    const sock = h.connect(guest(GUS, [other], "interaction"));
    await grant(h, GUS, [other, id]);
    const frame = framesOf(sock, "attention").at(-1);
    expect(frame.needsYou.map((r: { interactionId: string }) => r.interactionId)).toEqual([id]);
    expect(frame.needsYou[0].because).toBe("shared");
  });
});
