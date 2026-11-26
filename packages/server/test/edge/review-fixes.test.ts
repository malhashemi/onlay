// The edge's side of the server review fixes: the outbox (finding 1),
// sign-out reaching the spaces (2), the share list for a missing thread
// (15), the share cap and invitations decided inside their batch (16), a
// live person behind every new membership (17), the bounded inbox fan-out
// (18), and the web app's person hint (addition B). The space here is the
// echoing stand-in; test/shell/outbox.test.ts drives the real one.
import { env } from "cloudflare:workers";
import { PERSON_HEADER } from "@onlay/protocol";
import { describe, expect, test } from "vitest";
import { createWorkspace } from "../../src/directory/workspaces";
import {
  call,
  devSignIn,
  edge,
  errorOf,
  ORIGIN,
  personalSpaceOf,
  seedWorkspace,
  setSpace,
  spaceLog,
  uniqueEmail,
  webHeaders,
} from "../support/client";
import { MISSING_INTERACTION } from "../support/echo-space";

const IID = "6f0d1b2a-3c4d-4e5f-8a9b-0c1d2e3f4a5b";

async function outboxRows(spaceId: string): Promise<number> {
  return (
    (await env.DB.prepare("SELECT count(*) AS n FROM space_outbox WHERE space_id = ?")
      .bind(spaceId)
      .first<number>("n")) ?? 0
  );
}

async function epochOf(spaceId: string): Promise<number> {
  return (
    (await env.DB.prepare("SELECT access_epoch FROM spaces WHERE id = ?")
      .bind(spaceId)
      .first<number>("access_epoch")) ?? -1
  );
}

describe("the outbox (finding 1a)", () => {
  test("a membership change moves the epoch and its delivered notice leaves no row behind", async () => {
    const admin = await devSignIn();
    const member = await devSignIn();
    const ws = await seedWorkspace([admin], [member]);
    const before = await epochOf(ws.id);
    expect(
      (await call(admin, "DELETE", `/api/workspaces/${ws.id}/members/${member.person.id}`)).status,
    ).toBe(204);
    expect(await epochOf(ws.id)).toBe(before + 1);
    expect(await outboxRows(ws.id)).toBe(0);
    const access = (await spaceLog(ws.id)).filter((e) => e.path === "/internal/access-changed");
    expect(JSON.parse(access.at(-1)?.body ?? "{}")).toEqual({
      personId: member.person.id,
      access: null,
    });
    expect(access.at(-1)?.headers["x-onlay-access-epoch"]).toBe(String(before + 1));
  });

  test("a delivery that fails stays queued, is logged, and is delivered before the next forward", async () => {
    const admin = await devSignIn();
    const member = await devSignIn();
    const ws = await seedWorkspace([admin], [member]);
    await setSpace(ws.id, "/__test/fail", {});
    expect(
      (await call(admin, "DELETE", `/api/workspaces/${ws.id}/members/${member.person.id}`)).status,
    ).toBe(204);
    const rows = await env.DB.prepare(
      "SELECT kind, attempts, priority, next_attempt_at FROM space_outbox WHERE space_id = ? ORDER BY priority",
    )
      .bind(ws.id)
      .all<{ kind: string; attempts: number; priority: number; next_attempt_at: number }>();
    // Per person, in order (round 2, S3), each backing off after its failure (S4).
    expect(rows.results.map((r) => [r.kind, r.attempts, r.priority])).toEqual([
      ["access", 1, 1],
      ["person", 1, 3],
    ]);
    for (const r of rows.results) expect(r.next_attempt_at).toBeGreaterThan(Date.now());
    // The next forward to the space tries again first (the space is still down).
    expect((await call(admin, "GET", `/s/${ws.id}/attention`)).status).toBe(500);
    expect(
      await env.DB.prepare("SELECT attempts FROM space_outbox WHERE space_id = ? ORDER BY priority")
        .bind(ws.id)
        .first<number>("attempts"),
    ).toBe(2);
  });
});

describe("sign-out reaches the spaces (finding 2)", () => {
  test("logout names the session; logout-everywhere names the person, in every space they see", async () => {
    const email = uniqueEmail("out");
    const first = await devSignIn(email);
    const second = await devSignIn(email);
    const personal = await personalSpaceOf(first);
    const other = await devSignIn();
    const ws = await seedWorkspace([other], [first]);
    const session = await env.DB.prepare(
      "SELECT id FROM sessions WHERE person_id = ? ORDER BY created_at LIMIT 1",
    )
      .bind(first.person.id)
      .first<string>("id");
    const before = await epochOf(ws.id);
    expect((await call(first, "POST", "/auth/logout")).status).toBe(204);
    for (const spaceId of [personal, ws.id]) {
      const revoked = (await spaceLog(spaceId)).filter(
        (e) => e.path === "/internal/credential-revoked",
      );
      expect(JSON.parse(revoked.at(-1)?.body ?? "{}")).toEqual({
        personId: first.person.id,
        credentialIds: [session],
      });
    }
    expect(await epochOf(ws.id)).toBe(before + 1);
    expect((await call(second, "POST", "/auth/logout-everywhere")).status).toBe(204);
    const everywhere = (await spaceLog(ws.id)).filter(
      (e) => e.path === "/internal/credential-revoked",
    );
    // Everywhere is the person's new generation, advanced in the revoking batch (R3-S1).
    expect(JSON.parse(everywhere.at(-1)?.body ?? "{}")).toEqual({
      personId: first.person.id,
      minGeneration: 1,
    });
    expect(await outboxRows(ws.id)).toBe(0);
  });
});

describe("shares (findings 15 and 16)", () => {
  test("the share list of a thread that doesn't exist is not_found", async () => {
    const owner = await devSignIn();
    const personal = await personalSpaceOf(owner);
    const res = await call(
      owner,
      "GET",
      `/api/spaces/${personal}/interactions/${MISSING_INTERACTION}/shares`,
    );
    expect((await errorOf(res)).code).toBe("not_found");
    expect(
      (await call(owner, "GET", `/api/spaces/${personal}/interactions/${IID}/shares`)).status,
    ).toBe(200);
  });

  test("racing shares stop at the cap", async () => {
    const owner = await devSignIn();
    const personal = await personalSpaceOf(owner);
    const now = Date.now();
    await env.DB.batch(
      Array.from({ length: 49 }, (_, i) =>
        env.DB.prepare(
          "INSERT INTO shares (space_id, interaction_id, email, shared_by, created_at) VALUES (?, ?, ?, ?, ?)",
        ).bind(personal, IID, `seed-${i}-${now}@example.com`, owner.person.id, now),
      ),
    );
    const results = await Promise.all(
      [0, 1, 2].map((i) =>
        call(owner, "POST", `/api/spaces/${personal}/interactions/${IID}/shares`, {
          email: `racer-${i}-${now}@example.com`,
        }),
      ),
    );
    expect(results.filter((r) => r.status === 201)).toHaveLength(1);
    const count = await env.DB.prepare(
      "SELECT count(*) AS n FROM shares WHERE space_id = ? AND interaction_id = ?",
    )
      .bind(personal, IID)
      .first<number>("n");
    expect(count).toBe(50);
  });
});

describe("invitations racing a first sign-in (finding 16)", () => {
  test("whichever lands first, the invited person ends up a member", async () => {
    const admin = await devSignIn();
    const ws = await seedWorkspace([admin]);
    for (let i = 0; i < 4; i++) {
      const email = uniqueEmail("racer");
      const [invited, joined] = await Promise.all([
        call(admin, "POST", `/api/workspaces/${ws.id}/invitations`, { email }),
        devSignIn(email),
      ]);
      expect(invited.status).toBe(200);
      const member = await env.DB.prepare(
        "SELECT role FROM space_members WHERE space_id = ? AND person_id = ?",
      )
        .bind(ws.id, joined.person.id)
        .first<string>("role");
      expect(member).toBe("member");
      const left = await env.DB.prepare(
        "SELECT count(*) AS n FROM invitations WHERE space_id = ? AND email = ?",
      )
        .bind(ws.id, email)
        .first<number>("n");
      expect(left).toBe(0);
    }
  });
});

describe("a live person behind every new membership (finding 17)", () => {
  test("a workspace created for a person deleted mid-request is refused and never exists", async () => {
    const who = await devSignIn();
    const stale = await env.DB.prepare("SELECT * FROM people WHERE id = ?")
      .bind(who.person.id)
      .first<Parameters<typeof createWorkspace>[1]>();
    if (stale === null) throw new Error("no person");
    expect((await call(who, "DELETE", "/api/me", { confirm: who.person.email })).status).toBe(204);
    const name = `gone-${Date.now().toString(36)}`;
    await env.DB.prepare(
      "INSERT INTO deployment_settings (key, value_json, updated_at) VALUES ('workspace_creation', '\"anyone\"', 0) ON CONFLICT (key) DO UPDATE SET value_json = excluded.value_json",
    ).run();
    try {
      await expect(createWorkspace(env, stale, name)).rejects.toMatchObject({
        code: "sign_in_required",
      });
    } finally {
      await env.DB.prepare(
        "DELETE FROM deployment_settings WHERE key = 'workspace_creation'",
      ).run();
    }
    expect(
      await env.DB.prepare("SELECT id FROM spaces WHERE name = ?").bind(name).first(),
    ).toBeNull();
  });
});

describe("the inbox fan-out (finding 18)", () => {
  test("more spaces than one batch all answer; a failing space drops out alone", async () => {
    const who = await devSignIn();
    const others = await devSignIn();
    const spaces = [];
    for (let i = 0; i < 14; i++) spaces.push(await seedWorkspace([others], [who]));
    const row = (spaceId: string) => ({
      interactionId: crypto.randomUUID(),
      kind: "comment",
      state: "open",
      anchorLabel: spaceId,
      text: spaceId,
      fromActorId: others.person.id,
      waitingOnIds: [who.person.id],
      ts: 1,
    });
    for (const ws of spaces) {
      await setSpace(ws.id, "/__test/attention", {
        needsYou: [row(ws.id)],
        waiting: [],
        recent: [],
        needsYouCount: 1,
      });
    }
    const down = spaces[0];
    if (!down) throw new Error("no space");
    await setSpace(down.id, "/__test/fail", {});
    const res = await call(who, "GET", "/api/inbox");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { needsYou: { spaceId: string }[] };
    const answered = new Set(body.needsYou.map((r) => r.spaceId));
    for (const ws of spaces.slice(1)) expect(answered.has(ws.id)).toBe(true);
    expect(answered.has(down.id)).toBe(false);
  });
});

describe("the web app's person hint (addition B)", () => {
  test("a cookie request naming someone else is refused as person-changed; nothing reaches the space", async () => {
    const ada = await devSignIn();
    const bea = await devSignIn();
    const personal = await personalSpaceOf(ada);
    const stale = await edge("/api/me", {
      headers: { ...webHeaders(ada), [PERSON_HEADER]: bea.person.id },
    });
    expect(stale.status).toBe(401);
    expect(((await stale.json()) as { error: { reason?: string } }).error.reason).toBe(
      "person-changed",
    );
    const before = (await spaceLog(personal)).length;
    const write = await edge(`/s/${personal}/interaction/${IID}/reply`, {
      method: "POST",
      headers: {
        ...webHeaders(ada, "POST"),
        [PERSON_HEADER]: bea.person.id,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ body: { text: "x" } }),
    });
    expect((await errorOf(write)).code).toBe("sign_in_required");
    expect((await spaceLog(personal)).length).toBe(before);
    // The right person, or no hint at all: as before.
    const ok = await edge("/api/me", {
      headers: { ...webHeaders(ada), [PERSON_HEADER]: ada.person.id },
    });
    expect(ok.status).toBe(200);
    expect((await edge("/api/me", { headers: webHeaders(ada) })).status).toBe(200);
    // A bearer credential is not a cookie: the hint doesn't apply.
    const bearer = await edge("/api/me", {
      headers: { Authorization: `Bearer ${ada.token}`, [PERSON_HEADER]: bea.person.id },
    });
    expect(bearer.status).toBe(200);
  });

  test("on an upgrade the hint rides ?person= and never reaches the space", async () => {
    const ada = await devSignIn();
    const bea = await devSignIn();
    const personal = await personalSpaceOf(ada);
    const headers = {
      Upgrade: "websocket",
      "Sec-WebSocket-Protocol": "onlay.v1",
      Cookie: ada.cookie,
      Origin: ORIGIN,
    };
    const refused = await edge(`/s/${personal}/ws?person=${bea.person.id}`, { headers });
    expect(refused.status).toBe(401);
    const opened = await edge(`/s/${personal}/ws?person=${ada.person.id}`, { headers });
    expect(opened.status).toBe(101);
    const ws = opened.webSocket;
    if (!ws) throw new Error("no socket");
    ws.accept();
    const echo = await new Promise<{ search: string }>((resolve) =>
      ws.addEventListener("message", (e) => resolve(JSON.parse(String(e.data)))),
    );
    expect(echo.search).toBe("");
    ws.close(1000);
  });
});
