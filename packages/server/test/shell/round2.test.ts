// Round 2 through the real edge, outbox and space Durable Object: a sign-out
// never cuts a credential minted after it (S1), and a guest who loses one of
// two shares keeps their socket and hears `access-changed` (S2, S9).
import { CLOSE_ACCESS_REVOKED, PROTOCOL_VERSION } from "@onlay/protocol";
import { describe, expect, test } from "vitest";
import { call, devSignIn, edge, personalSpaceOf, seedWorkspace, type Who } from "../support/client";

type Frame = { type?: string };

async function open(who: Who, spaceId: string) {
  const res = await edge(`/s/${spaceId}/ws`, {
    headers: { Upgrade: "websocket", "Sec-WebSocket-Protocol": `onlay.v1, bearer.${who.token}` },
  });
  expect(res.status).toBe(101);
  const ws = res.webSocket;
  if (!ws) throw new Error("no socket");
  ws.accept();
  const frames: Frame[] = [];
  let closedWith: number | null = null;
  const closed = new Promise<number>((resolve) =>
    ws.addEventListener("close", (e) => {
      closedWith = e.code;
      resolve(e.code);
    }),
  );
  ws.addEventListener("message", (e) => frames.push(JSON.parse(String(e.data)) as Frame));
  ws.send(
    JSON.stringify({
      v: 1,
      type: "hello",
      sessionId: crypto.randomUUID(),
      bootCount: 1,
      swRestarts: 0,
      connects: 1,
      protocol: PROTOCOL_VERSION,
    }),
  );
  await until(() => frames.some((f) => f.type === "welcome"));
  return { ws, frames, closed, closedWith: () => closedWith };
}

async function until(check: () => boolean, ms = 5_000) {
  const start = Date.now();
  while (!check()) {
    if (Date.now() - start > ms) throw new Error("timed out");
    await new Promise((r) => setTimeout(r, 10));
  }
}

describe("a sign-out everywhere and what comes after it (R3-S1)", () => {
  test("sign out everywhere closes the old socket; signing in again opens a new one in the same space", async () => {
    const first = await devSignIn();
    const ws = await seedWorkspace([first]);
    const old = await open(first, ws.id);
    expect((await call(first, "POST", "/auth/logout-everywhere")).status).toBe(204);
    expect(await old.closed).toBe(CLOSE_ACCESS_REVOKED);
    // At once: generations, not clocks, order it (no same-millisecond rule).
    const again = await devSignIn(first.person.email);
    expect(again.person.id).toBe(first.person.id);
    const fresh = await open(again, ws.id);
    expect((await call(again, "GET", `/s/${ws.id}/attention`, undefined, "extension")).status).toBe(
      200,
    );
    expect(fresh.closedWith()).toBeNull();
    expect((await call(first, "GET", `/s/${ws.id}/attention`, undefined, "extension")).status).toBe(
      401,
    );
    fresh.ws.close();
  });
});

describe("losing one share of two (S2, S9)", () => {
  test("the guest's socket stays and hears access-changed; the other share still answers", async () => {
    const owner = await devSignIn();
    const guest = await devSignIn();
    const space = await personalSpaceOf(owner);
    const ids: string[] = [];
    for (const text of ["one", "two"]) {
      const created = await call(owner, "POST", `/s/${space}/interaction`, {
        kind: "comment",
        body: { text },
      });
      const id = ((await created.json()) as { interactionId: string }).interactionId;
      ids.push(id);
      const shared = await call(owner, "POST", `/api/spaces/${space}/interactions/${id}/shares`, {
        email: guest.person.email,
      });
      expect(shared.status).toBe(201);
    }
    const [keep, drop] = ids as [string, string];
    const sock = await open(guest, space);
    const removed = await call(
      owner,
      "DELETE",
      `/api/spaces/${space}/interactions/${drop}/shares/${encodeURIComponent(guest.person.email)}`,
    );
    expect(removed.status).toBe(204);
    await until(() => sock.frames.some((f) => f.type === "access-changed"));
    expect(sock.closedWith()).toBeNull();
    expect((await call(guest, "GET", `/s/${space}/interaction/${drop}`)).status).toBe(404);
    expect((await call(guest, "GET", `/s/${space}/interaction/${keep}`)).status).toBe(200);
    sock.ws.close();
  });
});
