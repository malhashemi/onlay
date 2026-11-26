// The directory rules (spec §6): creation policy, names, invitations,
// last admin, shares, account deletion and super admins.
import { env } from "cloudflare:workers";
import type { MeResponse, WorkspaceResponse } from "@onlay/protocol";
import { describe, expect, test } from "vitest";
import {
  call,
  devSignIn,
  errorOf,
  personalSpaceOf,
  seedWorkspace,
  spaceLog,
  uniqueEmail,
  type Who,
} from "../support/client";
import { MISSING_INTERACTION } from "../support/echo-space";

const IID = "3f1c2d3e-4b5a-4c6d-8e7f-0a1b2c3d4e5f";
const REFUSED = "Only the people this Onlay server allows can create workspaces.";

async function me(who: Who): Promise<MeResponse> {
  return (await (await call(who, "GET", "/api/me")).json()) as MeResponse;
}

function wsName(prefix: string): string {
  return `${prefix}-${crypto.randomUUID().slice(0, 8)}`;
}

describe("workspace creation policy", () => {
  test("listed, super_admins and anyone, with super admins always allowed", async () => {
    const root = await devSignIn("root@example.com");
    expect((await me(root)).superAdmin).toBe(true);
    const listedPerson = await devSignIn(uniqueEmail("x").replace("@example.com", "@listed.test"));
    const emailListed = await devSignIn();
    const other = await devSignIn();
    const create = (who: Who) => call(who, "POST", "/api/workspaces", { name: wsName("p") });
    const setPolicy = async (
      workspaceCreation: string,
      creators: { entry: string; kind: string }[] = [],
    ) => {
      const res = await call(root, "PUT", "/api/admin/settings", { workspaceCreation, creators });
      expect(res.status).toBe(200);
    };

    // Missing means listed, with an empty list.
    await env.DB.prepare("DELETE FROM deployment_settings").run();
    expect(await errorOf(await create(other))).toEqual({
      status: 403,
      code: "forbidden",
      message: REFUSED,
    });

    await setPolicy("listed", [
      { entry: "@Listed.TEST", kind: "domain" },
      { entry: emailListed.person.email, kind: "email" },
    ]);
    expect(await call(root, "GET", "/api/admin/settings").then((r) => r.json())).toMatchObject({
      workspaceCreation: "listed",
      creators: expect.arrayContaining([{ entry: "listed.test", kind: "domain" }]),
    });
    expect((await create(listedPerson)).status).toBe(201);
    expect((await create(emailListed)).status).toBe(201);
    expect((await me(other)).canCreateWorkspace).toBe(false);
    expect((await create(other)).status).toBe(403);
    expect((await create(root)).status).toBe(201);

    await setPolicy("super_admins", [{ entry: "listed.test", kind: "domain" }]);
    expect((await create(listedPerson)).status).toBe(403);
    expect((await create(root)).status).toBe(201);

    await setPolicy("anyone");
    expect((await me(other)).canCreateWorkspace).toBe(true);
    const made = await create(other);
    expect(made.status).toBe(201);
    expect(((await made.json()) as { space: { role: string; kind: string } }).space).toMatchObject({
      kind: "workspace",
      role: "admin",
    });

    const badEntry = await call(root, "PUT", "/api/admin/settings", {
      workspaceCreation: "listed",
      creators: [{ entry: "not a domain", kind: "domain" }],
    });
    expect(await errorOf(badEntry)).toMatchObject({ status: 400, code: "invalid" });
    // Not a super admin.
    expect((await call(other, "GET", "/api/admin/settings")).status).toBe(403);
  });

  test("names: the rule, reserved names, and uniqueness", async () => {
    const root = await devSignIn("root@example.com");
    const create = (name: string) => call(root, "POST", "/api/workspaces", { name });
    for (const name of ["Bad_Name", "-lead", "", "a".repeat(64), "has space"]) {
      expect(await errorOf(await create(name))).toMatchObject({ status: 400, code: "invalid" });
    }
    expect(await errorOf(await create("api"))).toEqual({
      status: 400,
      code: "invalid",
      message: "The name api is reserved.",
    });
    const name = wsName("taken");
    expect((await create(name)).status).toBe(201);
    expect(await errorOf(await create(name))).toEqual({
      status: 409,
      code: "conflict",
      message: `The name ${name} is taken.`,
    });
  });
});

describe("invitations and members", () => {
  test("an existing person joins at once; an unknown email waits; a member is a conflict", async () => {
    const admin = await devSignIn();
    const member = await devSignIn();
    const existing = await devSignIn();
    const stranger = await devSignIn();
    const ws = await seedWorkspace([admin], [member]);
    const invite = (who: Who, email: string) =>
      call(who, "POST", `/api/workspaces/${ws.id}/invitations`, { email });

    expect(await (await invite(admin, existing.person.email.toUpperCase())).json()).toEqual({
      joined: true,
    });
    expect((await me(existing)).spaces).toContainEqual({
      id: ws.id,
      kind: "workspace",
      name: ws.name,
      role: "member",
    });
    const unknown = uniqueEmail("later");
    expect(await (await invite(admin, unknown)).json()).toEqual({ joined: false });
    expect(await errorOf(await invite(admin, member.person.email))).toEqual({
      status: 409,
      code: "conflict",
      message: `${member.person.email} is already a member.`,
    });
    expect(await errorOf(await invite(admin, "not-an-email"))).toMatchObject({
      status: 400,
      code: "invalid",
    });
    expect((await invite(member, uniqueEmail())).status).toBe(403);
    expect((await invite(stranger, uniqueEmail())).status).toBe(404);

    const asAdmin = (await (
      await call(admin, "GET", `/api/workspaces/${ws.id}`)
    ).json()) as WorkspaceResponse;
    expect(asAdmin.invitations?.map((i) => i.email)).toEqual([unknown]);
    expect(asAdmin.members).toHaveLength(3);
    const asMember = (await (
      await call(member, "GET", `/api/workspaces/${ws.id}`)
    ).json()) as WorkspaceResponse;
    expect(asMember.invitations).toBeUndefined();

    expect(
      (
        await call(
          admin,
          "DELETE",
          `/api/workspaces/${ws.id}/invitations/${encodeURIComponent(unknown)}`,
        )
      ).status,
    ).toBe(204);
    expect(
      (
        await call(
          admin,
          "DELETE",
          `/api/workspaces/${ws.id}/invitations/${encodeURIComponent(unknown)}`,
        )
      ).status,
    ).toBe(404);

    // A personal space is not a workspace.
    expect(
      (await call(admin, "GET", `/api/workspaces/${await personalSpaceOf(admin)}`)).status,
    ).toBe(404);
  });

  test("demoting, removing or leaving never leaves a workspace without an admin", async () => {
    const admin = await devSignIn();
    const member = await devSignIn();
    const ws = await seedWorkspace([admin], [member]);
    const lastAdmin = {
      status: 409,
      code: "last_admin",
      message: `You're the last admin of ${ws.name}. Make another member an admin first.`,
    };

    expect(
      await errorOf(
        await call(admin, "PATCH", `/api/workspaces/${ws.id}/members/${admin.person.id}`, {
          role: "member",
        }),
      ),
    ).toEqual(lastAdmin);
    expect(
      await errorOf(
        await call(admin, "DELETE", `/api/workspaces/${ws.id}/members/${admin.person.id}`),
      ),
    ).toEqual(lastAdmin);
    expect(
      (
        await call(member, "PATCH", `/api/workspaces/${ws.id}/members/${member.person.id}`, {
          role: "admin",
        })
      ).status,
    ).toBe(403);

    expect(
      (
        await call(admin, "PATCH", `/api/workspaces/${ws.id}/members/${member.person.id}`, {
          role: "admin",
        })
      ).status,
    ).toBe(204);
    expect(
      (await call(admin, "DELETE", `/api/workspaces/${ws.id}/members/${admin.person.id}`)).status,
    ).toBe(204);
    expect(
      await errorOf(
        await call(member, "DELETE", `/api/workspaces/${ws.id}/members/${member.person.id}`),
      ),
    ).toEqual(lastAdmin);

    // The space heard: the leaver's sockets close, and they stay known as a non-member.
    const log = await spaceLog(ws.id);
    expect(log.map((entry) => JSON.parse(entry.body))).toContainEqual({
      personId: admin.person.id,
      access: null,
    });
    // One person per people control (round 2, S3): the leaver removed, the member upserted.
    const people = log
      .filter((entry) => entry.path === "/internal/person")
      .map((entry) => JSON.parse(entry.body));
    expect(people).toContainEqual({ personId: admin.person.id, removed: true });
    expect(people).toContainEqual({
      person: expect.objectContaining({ id: member.person.id, member: true }),
    });
  });

  test("deleting a workspace needs its typed name and purges the space", async () => {
    const admin = await devSignIn();
    const ws = await seedWorkspace([admin]);
    expect(
      (await call(admin, "DELETE", `/api/workspaces/${ws.id}`, { confirm: "wrong" })).status,
    ).toBe(400);
    expect(
      (await call(admin, "DELETE", `/api/workspaces/${ws.id}`, { confirm: ws.name })).status,
    ).toBe(204);
    expect((await spaceLog(ws.id)).map((entry) => entry.path)).toContain("/internal/purge");
    expect((await call(admin, "GET", `/api/workspaces/${ws.id}`)).status).toBe(404);
  });
});

describe("shares", () => {
  test("members share; guests and strangers cannot; members' emails and repeats conflict", async () => {
    const admin = await devSignIn();
    const member = await devSignIn();
    const stranger = await devSignIn();
    const ws = await seedWorkspace([admin], [member]);
    const sharesPath = `/api/spaces/${ws.id}/interactions/${IID}/shares`;
    const guestEmail = uniqueEmail("guest");

    expect((await call(member, "POST", sharesPath, { email: guestEmail })).status).toBe(201);
    expect(
      await errorOf(await call(member, "POST", sharesPath, { email: guestEmail })),
    ).toMatchObject({ status: 409, code: "conflict" });
    expect(
      await errorOf(await call(member, "POST", sharesPath, { email: admin.person.email })),
    ).toEqual({
      status: 409,
      code: "conflict",
      message: `${admin.person.email} is already a member.`,
    });
    expect((await call(stranger, "POST", sharesPath, { email: uniqueEmail() })).status).toBe(404);
    expect(
      (
        await call(
          member,
          "POST",
          `/api/spaces/${ws.id}/interactions/${MISSING_INTERACTION}/shares`,
          { email: uniqueEmail() },
        )
      ).status,
    ).toBe(404);

    const guest = await devSignIn(guestEmail);
    expect((await me(guest)).spaces).toContainEqual({
      id: ws.id,
      kind: "workspace",
      name: ws.name,
      role: "guest",
    });
    expect((await call(guest, "POST", sharesPath, { email: uniqueEmail() })).status).toBe(403);
    expect((await call(guest, "GET", sharesPath)).status).toBe(403);

    const list = (await (await call(admin, "GET", sharesPath)).json()) as {
      email: string;
      sharedBy: { id: string };
    }[];
    expect(list).toEqual([
      expect.objectContaining({
        email: guestEmail,
        sharedBy: expect.objectContaining({ id: member.person.id }),
      }),
    ]);

    const log = await spaceLog(ws.id);
    // A share is the holder's whole scope, read at delivery (round 2, S2), and their profile.
    const granted = log.filter((entry) => entry.path === "/internal/access-changed").at(-1);
    expect(JSON.parse(granted?.body ?? "{}")).toEqual({
      personId: guest.person.id,
      access: { kind: "guest", interactionIds: [IID] },
    });
    const profile = log.filter((entry) => entry.path === "/internal/person").at(-1);
    expect(JSON.parse(profile?.body ?? "{}")).toEqual({
      person: expect.objectContaining({ id: guest.person.id, member: false, guest: true }),
    });

    expect(
      (await call(member, "DELETE", `${sharesPath}/${encodeURIComponent(guestEmail)}`)).status,
    ).toBe(204);
    expect((await me(guest)).spaces.some((space) => space.id === ws.id)).toBe(false);
    const access = (await spaceLog(ws.id))
      .filter((entry) => entry.path === "/internal/access-changed")
      .at(-1);
    expect(JSON.parse(access?.body ?? "{}")).toEqual({ personId: guest.person.id, access: null });
  });
});

describe("account deletion", () => {
  test("refused for the last admin of a workspace; otherwise it leaves a tombstone", async () => {
    const owner = await devSignIn();
    const other = await devSignIn();
    const ws = await seedWorkspace([owner], [other]);
    const personal = await personalSpaceOf(owner);

    expect(
      await errorOf(await call(owner, "DELETE", "/api/me", { confirm: "someone@else.test" })),
    ).toMatchObject({ status: 400, code: "invalid" });
    expect(
      await errorOf(await call(owner, "DELETE", "/api/me", { confirm: owner.person.email })),
    ).toEqual({
      status: 409,
      code: "last_admin",
      message: `You're the last admin of ${ws.name}. Make another member an admin first.`,
    });

    await call(owner, "PATCH", `/api/workspaces/${ws.id}/members/${other.person.id}`, {
      role: "admin",
    });
    const res = await call(owner, "DELETE", "/api/me", { confirm: owner.person.email });
    expect(res.status).toBe(204);
    expect(res.headers.get("Set-Cookie")).toMatch(/Max-Age=0/);
    expect((await call(owner, "GET", "/api/me")).status).toBe(401);
    expect((await call(owner, "GET", "/api/me", undefined, "extension")).status).toBe(401);

    const row = await env.DB.prepare("SELECT email, name, deleted_at FROM people WHERE id = ?")
      .bind(owner.person.id)
      .first();
    expect(row).toMatchObject({ email: null, name: "Deleted person" });
    expect(
      await env.DB.prepare("SELECT 1 FROM spaces WHERE id = ?").bind(personal).first(),
    ).toBeNull();
    expect((await spaceLog(personal)).map((entry) => entry.path)).toContain("/internal/purge");
    const wsLog = await spaceLog(ws.id);
    const paths = wsLog.map((e) => e.path);
    // Revocation first, then access, then the profile (round 2, S3).
    const revoked = paths.lastIndexOf("/internal/credential-revoked");
    const access = paths.lastIndexOf("/internal/access-changed");
    const person = paths.lastIndexOf("/internal/person");
    expect(revoked).toBeGreaterThanOrEqual(0);
    expect(revoked).toBeLessThan(access);
    expect(access).toBeLessThan(person);
    expect(JSON.parse(wsLog[access]?.body ?? "{}")).toEqual({
      personId: owner.person.id,
      access: null,
    });
    // The tombstone profile, flags cleared, so past messages read as it (R3-S8).
    expect(JSON.parse(wsLog[person]?.body ?? "{}")).toEqual({
      person: {
        id: owner.person.id,
        name: "Deleted person",
        initials: "?",
        tint: owner.person.tint,
        member: false,
        guest: false,
      },
    });
    expect(JSON.parse(wsLog[revoked]?.body ?? "{}")).toEqual({
      personId: owner.person.id,
      minGeneration: 1,
    });

    // The same email signing in again is a new person.
    const again = await devSignIn(owner.person.email);
    expect(again.person.id).not.toBe(owner.person.id);
  });
});

describe("super admins", () => {
  test("only signed-in people can be named, and the last one stays", async () => {
    const root = await devSignIn("root@example.com");
    const helper = await devSignIn();
    expect(
      (await call(root, "POST", "/api/admin/super-admins", { email: uniqueEmail("nobody") }))
        .status,
    ).toBe(400);
    expect(
      (await call(root, "POST", "/api/admin/super-admins", { email: helper.person.email })).status,
    ).toBe(200);
    expect((await me(helper)).superAdmin).toBe(true);

    // Remove everyone but root, then root cannot remove themselves.
    const settings = (await (await call(root, "GET", "/api/admin/settings")).json()) as {
      superAdmins: { id: string }[];
    };
    for (const admin of settings.superAdmins) {
      if (admin.id !== root.person.id) {
        expect((await call(root, "DELETE", `/api/admin/super-admins/${admin.id}`)).status).toBe(
          204,
        );
      }
    }
    expect(
      await errorOf(await call(root, "DELETE", `/api/admin/super-admins/${root.person.id}`)),
    ).toEqual({
      status: 409,
      code: "last_admin",
      message: "Name another super admin first.",
    });
    expect(
      await errorOf(await call(root, "DELETE", "/api/me", { confirm: "root@example.com" })),
    ).toMatchObject({
      status: 409,
      code: "last_admin",
    });
  });
});

describe("the web app's extension hint (S-3)", () => {
  test("/api/me names the extension ids allowed to sign in, for the web app to ping", async () => {
    const who = await devSignIn();
    expect((await me(who)).extensionIds).toEqual(["abcdefghijklmnopabcdefghijklmnop"]);
  });
});
