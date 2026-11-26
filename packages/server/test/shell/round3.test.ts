// Round 3 through the real edge, D1 and space Durable Object: the directory
// port the space validates its sockets with (R3-S2), the alarm that runs it
// at most 5 minutes apart while sockets are open, and an agent caller that
// carries its person's current generation (R3-S1).

import { runDurableObjectAlarm, runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { CLOSE_ACCESS_REVOKED, PROTOCOL_VERSION } from "@onlay/protocol";
import { describe, expect, test } from "vitest";
import { validateConnected } from "../../src/directory/validate";
import { REVALIDATE_ALL_MS } from "../../src/space/runtime";
import { call, devSignIn, edge, personalSpaceOf, seedWorkspace, type Who } from "../support/client";
import { agentOf, comment, tool } from "../support/mcp";

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
      if ((JSON.parse(String(e.data)) as { type?: string }).type === "welcome") resolve();
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

const tokenId = (personId: string) =>
  env.DB.prepare(
    "SELECT id FROM client_tokens WHERE person_id = ? ORDER BY created_at DESC LIMIT 1",
  )
    .bind(personId)
    .first<string>("id");
const sessionId = (personId: string) =>
  env.DB.prepare("SELECT id FROM sessions WHERE person_id = ? ORDER BY created_at DESC LIMIT 1")
    .bind(personId)
    .first<string>("id");

describe("the directory port (R3-S2)", () => {
  test("answers liveness, generation and whole scope for each connected credential in one batch", async () => {
    const ada = await devSignIn();
    const bea = await devSignIn();
    const gus = await devSignIn();
    const ws = await seedWorkspace([ada], [bea]);
    const iid = crypto.randomUUID();
    await env.DB.prepare(
      "INSERT INTO shares (space_id, interaction_id, email, shared_by, created_at) VALUES (?, ?, ?, ?, ?)",
    )
      .bind(ws.id, iid, gus.person.email, ada.person.id, Date.now())
      .run();
    const entries = [
      {
        personId: ada.person.id,
        credentialId: String(await sessionId(ada.person.id)),
        credentialClass: "interaction" as const,
      },
      {
        personId: bea.person.id,
        credentialId: String(await tokenId(bea.person.id)),
        credentialClass: "full" as const,
      },
      {
        personId: gus.person.id,
        credentialId: String(await tokenId(gus.person.id)),
        credentialClass: "full" as const,
      },
      { personId: bea.person.id, credentialId: "tok_unknown", credentialClass: "full" as const },
    ];
    // Bea is removed (no control call is made); Ada signs out everywhere.
    await env.DB.prepare("DELETE FROM space_members WHERE space_id = ? AND person_id = ?")
      .bind(ws.id, bea.person.id)
      .run();
    const results = await validateConnected(env.DB, ws.id, entries);
    expect(results.map((r) => [r.live, r.access])).toEqual([
      [true, { kind: "member", role: "admin" }],
      [true, null],
      [true, { kind: "guest", interactionIds: [iid] }],
      [false, null],
    ]);
    expect((await call(ada, "POST", "/auth/logout-everywhere")).status).toBe(204);
    const after = await validateConnected(env.DB, ws.id, entries.slice(0, 1));
    expect(after[0]).toMatchObject({ live: false, personGeneration: 1 });
    // A space gone from the directory: no access anywhere in it.
    const gone = await validateConnected(env.DB, "s_aaaaaaaaaaaaaaaaaaaa", entries.slice(2, 3));
    expect(gone[0]).toMatchObject({ access: null, epoch: null });
  });
});

describe("the alarm re-validates open sockets (R3-S2)", () => {
  test("set at most 5 minutes out while a socket is open; it closes a member removed with no control", async () => {
    const ada = await devSignIn();
    const bea = await devSignIn();
    const ws = await seedWorkspace([ada], [bea]);
    const sock = await open(bea, ws.id);
    const stub = env.SPACE.get(env.SPACE.idFromName(ws.id));
    const alarmAt = await runInDurableObject(stub, (_instance, state) => state.storage.getAlarm());
    expect(alarmAt).not.toBeNull();
    expect((alarmAt ?? 0) - Date.now()).toBeLessThanOrEqual(REVALIDATE_ALL_MS);
    // The directory removes Bea; the control call is never made.
    await env.DB.prepare("DELETE FROM space_members WHERE space_id = ? AND person_id = ?")
      .bind(ws.id, bea.person.id)
      .run();
    expect(await runDurableObjectAlarm(stub)).toBe(true);
    expect(await sock.closed).toBe(CLOSE_ACCESS_REVOKED);
  });
});

describe("an agent caller carries its person's current generation (R3-S1)", () => {
  test("after sign out everywhere, the person's agent still reads; their old extension token does not", async () => {
    const who = await devSignIn();
    const space = await personalSpaceOf(who);
    const id = await comment(who, space, "look at this", false);
    expect((await call(who, "POST", "/auth/logout-everywhere")).status).toBe(204);
    expect(
      (await call(who, "GET", `/s/${space}/interaction/${id}`, undefined, "extension")).status,
    ).toBe(401);
    const read = await tool(agentOf(who), "read", { ref: `${space}/${id}` });
    expect(read.isError).toBe(false);
    expect(read.text).toContain("look at this");
  });
});
