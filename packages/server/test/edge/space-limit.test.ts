// S-3: at most LIMITS.MAX_SPACES_PER_PERSON spaces per person, counting every
// space they reach as a member (the personal space included) or a guest,
// enforced inside the batch at every way in: creating a workspace, an
// invitation turning into membership (at once or at sign-in), and a share
// that would make someone a guest.
import { env } from "cloudflare:workers";
import { LIMITS, type MeResponse, type WorkspaceResponse } from "@onlay/protocol";
import { describe, expect, test } from "vitest";
import { call, devSignIn, seedWorkspace, uniqueEmail, type Who } from "../support/client";

const IID = "3f1c2d3e-4b5a-4c6d-8e7f-0a1b2c3d4e5f";
const MAX = LIMITS.MAX_SPACES_PER_PERSON;

function spaceId(): string {
  const letters = "abcdefghijklmnopqrstuvwxyz234567";
  return `s_${Array.from(crypto.getRandomValues(new Uint8Array(20)), (b) => letters[b & 31]).join("")}`;
}

/** `n` workspaces, each with `who` as a member, written straight into D1 in one batch. */
async function memberOf(who: Who, n: number): Promise<string[]> {
  const now = Date.now();
  const ids = Array.from({ length: n }, spaceId);
  await env.DB.batch(
    ids.flatMap((id) => [
      env.DB.prepare(
        "INSERT INTO spaces (id, kind, name, owner_id, created_by, created_at) VALUES (?, 'workspace', ?, NULL, ?, ?)",
      ).bind(id, `lim-${id.slice(2, 16)}`, who.person.id, now),
      env.DB.prepare(
        "INSERT INTO space_members (space_id, person_id, role, created_at) VALUES (?, ?, 'member', ?)",
      ).bind(id, who.person.id, now),
    ]),
  );
  return ids;
}

/** Someone reaching exactly `MAX` spaces: their personal space and `MAX - 1` workspaces. */
async function atLimit(): Promise<{ who: Who; spaces: string[] }> {
  const who = await devSignIn(uniqueEmail("full"));
  return { who, spaces: await memberOf(who, MAX - 1) };
}

async function failure(res: Response) {
  const body = (await res.json()) as { error: { code: string; message: string; reason?: string } };
  return { status: res.status, ...body.error };
}

/** Leaves a space (the workspaces written by `memberOf` have no admin to keep). */
const leave = (who: Who, id: string | undefined) =>
  env.DB.prepare("DELETE FROM space_members WHERE space_id = ? AND person_id = ?")
    .bind(id, who.person.id)
    .run();

const me = async (who: Who) => (await (await call(who, "GET", "/api/me")).json()) as MeResponse;

describe("S-3: the space limit", () => {
  test("creating a workspace at the limit is refused with space-limit; one below it works", async () => {
    const { who, spaces } = await atLimit();
    await env.DB.prepare(
      "INSERT INTO workspace_creators (entry, kind, added_by, created_at) VALUES (?, 'email', ?, ?)",
    )
      .bind(who.person.email, who.person.id, Date.now())
      .run();
    const name = () => `lim-${crypto.randomUUID().slice(0, 8)}`;
    expect(await failure(await call(who, "POST", "/api/workspaces", { name: name() }))).toEqual({
      status: 409,
      code: "conflict",
      reason: "space-limit",
      message: `You're already a member of ${MAX} spaces, the limit per person. Leave a space, then create this workspace.`,
    });
    expect((await me(who)).spaces).toHaveLength(MAX);
    // Leaving one makes room.
    await leave(who, spaces[0]);
    expect((await call(who, "POST", "/api/workspaces", { name: name() })).status).toBe(201);
    expect((await me(who)).spaces).toHaveLength(MAX);
  });

  test("an invitation to someone at the limit waits, marked, and is claimed at a sign-in with room", async () => {
    const admin = await devSignIn();
    const ws = await seedWorkspace([admin]);
    const { who, spaces } = await atLimit();
    const invited = await call(admin, "POST", `/api/workspaces/${ws.id}/invitations`, {
      email: who.person.email,
    });
    expect(invited.status).toBe(200);
    expect(await invited.json()).toEqual({ joined: false, waiting: "space-limit" });
    const read = (await (
      await call(admin, "GET", `/api/workspaces/${ws.id}`)
    ).json()) as WorkspaceResponse;
    expect(read.members.map((m) => m.person.id)).not.toContain(who.person.id);
    expect(read.invitations).toEqual([
      expect.objectContaining({ email: who.person.email, waiting: "space-limit" }),
    ]);

    // Still full at the next sign-in: it keeps waiting.
    await devSignIn(who.person.email);
    expect((await me(who)).spaces.map((s) => s.id)).not.toContain(ws.id);

    // They leave a space; the next sign-in claims it.
    await leave(who, spaces[0]);
    await devSignIn(who.person.email);
    expect((await me(who)).spaces.map((s) => s.id)).toContain(ws.id);
    const after = (await (
      await call(admin, "GET", `/api/workspaces/${ws.id}`)
    ).json()) as WorkspaceResponse;
    expect(after.invitations).toEqual([]);
  });

  test("a sign-in claims only as many invitations as there is room for, oldest first", async () => {
    const admin = await devSignIn();
    const who = await devSignIn(uniqueEmail("claim"));
    await memberOf(who, MAX - 2); // the personal space and 48 workspaces: room for one
    const older = await seedWorkspace([admin]);
    const newer = await seedWorkspace([admin]);
    const now = Date.now();
    await env.DB.batch([
      env.DB.prepare(
        "INSERT INTO invitations (space_id, email, invited_by, created_at) VALUES (?, ?, ?, ?)",
      ).bind(older.id, who.person.email, admin.person.id, now - 2_000),
      env.DB.prepare(
        "INSERT INTO invitations (space_id, email, invited_by, created_at) VALUES (?, ?, ?, ?)",
      ).bind(newer.id, who.person.email, admin.person.id, now - 1_000),
    ]);
    await devSignIn(who.person.email);
    const ids = (await me(who)).spaces.map((s) => s.id);
    expect(ids).toHaveLength(MAX);
    expect(ids).toContain(older.id);
    expect(ids).not.toContain(newer.id);
    const waiting = await env.DB.prepare(
      "SELECT space_id, waiting_since FROM invitations WHERE email = ?",
    )
      .bind(who.person.email)
      .all<{ space_id: string; waiting_since: number | null }>();
    expect(waiting.results).toEqual([{ space_id: newer.id, waiting_since: expect.any(Number) }]);
  });

  test("2-S3: shares others made never stop a person creating or joining a workspace", async () => {
    const sharer = await devSignIn();
    const who = await devSignIn(uniqueEmail("shared"));
    // The personal space and 49 guest spaces: reach 50, member of one.
    const guestSpaces = await Promise.all(
      Array.from({ length: MAX - 1 }, () => seedWorkspace([sharer])),
    );
    const now = Date.now();
    await env.DB.batch(
      guestSpaces.map((ws) =>
        env.DB.prepare(
          "INSERT INTO shares (space_id, interaction_id, email, shared_by, created_at) VALUES (?, ?, ?, ?, ?)",
        ).bind(ws.id, IID, who.person.email, sharer.person.id, now),
      ),
    );
    expect((await me(who)).spaces).toHaveLength(MAX);
    await env.DB.prepare(
      "INSERT INTO workspace_creators (entry, kind, added_by, created_at) VALUES (?, 'email', ?, ?)",
    )
      .bind(who.person.email, who.person.id, now)
      .run();
    const created = await call(who, "POST", "/api/workspaces", {
      name: `own-${crypto.randomUUID().slice(0, 8)}`,
    });
    expect(created.status).toBe(201);
    // Invited at once, and through a sign-in.
    const admin = await devSignIn();
    const atOnce = await seedWorkspace([admin]);
    const invited = await call(admin, "POST", `/api/workspaces/${atOnce.id}/invitations`, {
      email: who.person.email,
    });
    expect(await invited.json()).toEqual({ joined: true });
    const later = await seedWorkspace([admin]);
    await env.DB.prepare(
      "INSERT INTO invitations (space_id, email, invited_by, created_at) VALUES (?, ?, ?, ?)",
    )
      .bind(later.id, who.person.email, admin.person.id, now)
      .run();
    await devSignIn(who.person.email);
    const ids = (await me(who)).spaces.map((space) => space.id);
    expect(ids).toContain(atOnce.id);
    expect(ids).toContain(later.id);
    expect(ids).toHaveLength(MAX + 3);
    // Their reach is past the limit now: a share from yet another space is refused.
    const another = await seedWorkspace([sharer]);
    const refused = await call(
      sharer,
      "POST",
      `/api/spaces/${another.id}/interactions/${IID}/shares`,
      {
        email: who.person.email,
      },
    );
    expect((await failure(refused)).reason).toBe("space-limit");
  });

  test("a share with someone at the limit and no standing in the space is refused, naming them", async () => {
    const member = await devSignIn();
    const ws = await seedWorkspace([member]);
    const other = await seedWorkspace([member]);
    const { who } = await atLimit();
    const share = (spaceId: string, interactionId = IID) =>
      call(member, "POST", `/api/spaces/${spaceId}/interactions/${interactionId}/shares`, {
        email: who.person.email,
      });
    expect(await failure(await share(ws.id))).toEqual({
      status: 409,
      code: "conflict",
      reason: "space-limit",
      message: `${who.person.email} is already in ${MAX} spaces, the limit per person. Ask them to leave a space, then share this thread again.`,
    });
    expect((await me(who)).spaces.map((s) => s.id)).not.toContain(ws.id);

    // Shares count: a person one below the limit takes one share, then the next space is refused.
    const near = await devSignIn(uniqueEmail("near"));
    await memberOf(near, MAX - 2);
    const shareNear = (spaceId: string, interactionId = IID) =>
      call(member, "POST", `/api/spaces/${spaceId}/interactions/${interactionId}/shares`, {
        email: near.person.email,
      });
    expect((await shareNear(ws.id)).status).toBe(201);
    // A second thread in the same space costs nothing.
    expect((await shareNear(ws.id, "4f1c2d3e-4b5a-4c6d-8e7f-0a1b2c3d4e5f")).status).toBe(201);
    expect((await failure(await shareNear(other.id))).reason).toBe("space-limit");
  });

  test("a share with an email that has no account yet counts the personal space it will get", async () => {
    const member = await devSignIn();
    const email = uniqueEmail("future");
    const spaces = await Promise.all(Array.from({ length: MAX }, () => seedWorkspace([member])));
    for (const [i, ws] of spaces.entries()) {
      const res = await call(member, "POST", `/api/spaces/${ws.id}/interactions/${IID}/shares`, {
        email,
      });
      if (i < MAX - 1) expect(res.status, `share ${i}`).toBe(201);
      else expect((await failure(res)).reason).toBe("space-limit");
    }
    const newcomer = await devSignIn(email);
    expect((await me(newcomer)).spaces).toHaveLength(MAX);
  });
});
