// The outbox and the access epoch against the real space Durable Object
// (review findings 1 and 2): a removal whose notice fails to reach the
// space leaves the removed person's socket open only until the scheduled
// retry delivers it; a sign-out closes the sockets of the credential it
// ends; and a forward the space knows to be stale is refused, not served.
import { createExecutionContext } from "cloudflare:test";
import { env } from "cloudflare:workers";
import {
  ACCESS_EPOCH_HEADER,
  CLOSE_ACCESS_REVOKED,
  INTERNAL_HEADER,
  PROTOCOL_VERSION,
} from "@onlay/protocol";
import { describe, expect, test } from "vitest";
import { dropShares } from "../../src/space-do";
import worker from "../../src/worker";
import { call, devSignIn, edge, ORIGIN, seedWorkspace, type Who } from "../support/client";

async function open(who: Who, spaceId: string) {
  const res = await edge(`/s/${spaceId}/ws`, {
    headers: { Upgrade: "websocket", "Sec-WebSocket-Protocol": `onlay.v1, bearer.${who.token}` },
  });
  expect(res.status).toBe(101);
  const ws = res.webSocket;
  if (!ws) throw new Error("no socket");
  ws.accept();
  let closedWith: number | null = null;
  const closed = new Promise<number>((resolve) =>
    ws.addEventListener("close", (e) => {
      closedWith = e.code;
      resolve(e.code);
    }),
  );
  const welcomed = new Promise<void>((resolve) =>
    ws.addEventListener("message", (e) => {
      if (JSON.parse(String(e.data)).type === "welcome") resolve();
    }),
  );
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
  await welcomed;
  return { ws, closed, closedWith: () => closedWith };
}

const settle = () => new Promise((r) => setTimeout(r, 200));

/** The real env, but every call into a space fails, as an unreachable space would. */
function unreachable(): typeof env {
  const space = {
    idFromName: (name: string) => env.SPACE.idFromName(name),
    get: () => ({
      fetch: async () => {
        throw new Error("space unreachable");
      },
    }),
  } as unknown as typeof env.SPACE;
  return { ...env, SPACE: space };
}

describe("a notice that fails is retried, never lost (finding 1a)", () => {
  test("a removed member's socket stays open only until the scheduled retry delivers", async () => {
    const admin = await devSignIn();
    const member = await devSignIn();
    const ws = await seedWorkspace([admin], [member]);
    const sock = await open(member, ws.id);
    const res = await worker.fetch(
      new Request(`${ORIGIN}/api/workspaces/${ws.id}/members/${member.person.id}`, {
        method: "DELETE",
        headers: { Authorization: `Bearer ${admin.token}` },
      }),
      unreachable(),
      createExecutionContext(),
    );
    expect(res.status).toBe(204);
    await settle();
    expect(sock.closedWith()).toBeNull();
    expect(
      await env.DB.prepare("SELECT attempts FROM space_outbox WHERE space_id = ? ORDER BY priority")
        .bind(ws.id)
        .first<number>("attempts"),
    ).toBe(1);
    // The rows back off (round 2, S4): a scheduled pass before then leaves them alone.
    await worker.scheduled(
      { cron: "* * * * *", scheduledTime: Date.now(), noRetry() {} } as ScheduledController,
      env,
    );
    await settle();
    expect(sock.closedWith()).toBeNull();
    // Once the backoff has run out, the next pass delivers.
    await env.DB.prepare("UPDATE space_outbox SET next_attempt_at = 0 WHERE space_id = ?")
      .bind(ws.id)
      .run();
    await worker.scheduled(
      { cron: "* * * * *", scheduledTime: Date.now(), noRetry() {} } as ScheduledController,
      env,
    );
    expect(await sock.closed).toBe(CLOSE_ACCESS_REVOKED);
    expect(
      await env.DB.prepare("SELECT count(*) AS n FROM space_outbox WHERE space_id = ?")
        .bind(ws.id)
        .first<number>("n"),
    ).toBe(0);
  });
});

describe("a stale grant is refused (finding 1b)", () => {
  test("a space told of a newer epoch refuses a forward read at an older one", async () => {
    const admin = await devSignIn();
    const ws = await seedWorkspace([admin]);
    const stub = env.SPACE.get(env.SPACE.idFromName(ws.id));
    const told = await stub.fetch("https://space/internal/access-changed", {
      method: "POST",
      headers: {
        [INTERNAL_HEADER]: "1",
        [ACCESS_EPOCH_HEADER]: "1000",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        personId: admin.person.id,
        access: { kind: "member", role: "admin" },
      }),
    });
    expect(told.status).toBe(200);
    const stale = await call(admin, "GET", `/s/${ws.id}/attention`);
    expect(stale.status).toBe(409);
    expect(((await stale.json()) as { error: { reason: string } }).error.reason).toBe(
      "stale-access",
    );
    await env.DB.prepare("UPDATE spaces SET access_epoch = 1000 WHERE id = ?").bind(ws.id).run();
    expect((await call(admin, "GET", `/s/${ws.id}/attention`)).status).toBe(200);
  });
});

describe("sign-out closes the sockets it ends (finding 2)", () => {
  test("logout-everywhere closes an extension socket that is still open", async () => {
    const who = await devSignIn();
    const ws = await seedWorkspace([who]);
    const sock = await open(who, ws.id);
    expect((await call(who, "POST", "/auth/logout-everywhere")).status).toBe(204);
    expect(await sock.closed).toBe(CLOSE_ACCESS_REVOKED);
  });
});

describe("retention drops the directory's shares (finding 15)", () => {
  test("a removed interaction's shares leave D1, the epoch moves, and holders are told", async () => {
    const owner = await devSignIn();
    const guest = await devSignIn();
    const ws = await seedWorkspace([owner]);
    const gone = crypto.randomUUID();
    const kept = crypto.randomUUID();
    const now = Date.now();
    await env.DB.batch(
      [gone, kept].map((iid) =>
        env.DB.prepare(
          "INSERT INTO shares (space_id, interaction_id, email, shared_by, created_at) VALUES (?, ?, ?, ?, ?)",
        ).bind(ws.id, iid, guest.person.email, owner.person.id, now),
      ),
    );
    const before =
      (await env.DB.prepare("SELECT access_epoch FROM spaces WHERE id = ?")
        .bind(ws.id)
        .first<number>("access_epoch")) ?? 0;
    await dropShares(env.DB, ws.id, [gone]);
    const left = await env.DB.prepare(
      "SELECT interaction_id FROM shares WHERE space_id = ? ORDER BY interaction_id",
    )
      .bind(ws.id)
      .all<{ interaction_id: string }>();
    expect(left.results.map((r) => r.interaction_id)).toEqual([kept]);
    expect(
      await env.DB.prepare("SELECT access_epoch FROM spaces WHERE id = ?")
        .bind(ws.id)
        .first<number>("access_epoch"),
    ).toBe(before + 1);
    const notices = await env.DB.prepare(
      "SELECT kind, body_json FROM space_outbox WHERE space_id = ? ORDER BY priority",
    )
      .bind(ws.id)
      .all<{ kind: string; body_json: string }>();
    // The holder's access and profile, read at delivery (round 2, S2, S3).
    expect(notices.results.map((n) => [n.kind, JSON.parse(n.body_json)])).toEqual([
      ["access", { personId: guest.person.id }],
      ["person", { personId: guest.person.id }],
    ]);
    await worker.scheduled(
      { cron: "* * * * *", scheduledTime: Date.now(), noRetry() {} } as ScheduledController,
      env,
    );
    expect(
      await env.DB.prepare("SELECT count(*) AS n FROM space_outbox WHERE space_id = ?")
        .bind(ws.id)
        .first<number>("n"),
    ).toBe(0);
  });
});
