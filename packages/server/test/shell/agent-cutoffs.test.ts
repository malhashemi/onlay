// MCP access tokens and revocation after the hosted merge, through the real
// MCP endpoint and D1: a deleted account's old token cannot start a new
// account (S-1); a token issued in the revocation's own second is accepted,
// and the token whose sign-in caused a revocation is not refused by it (S-2).
import { env } from "cloudflare:workers";
import { describe, expect, test } from "vitest";
import { sweep } from "../../src/directory/credentials";
import { signIn } from "../../src/directory/people";
import { call, devSignIn, uniqueEmail } from "../support/client";
import { accessToken, addWorkosUser, mcpFetch, upstreams, userLookups } from "../support/mcp";

const ping = { jsonrpc: "2.0", id: 1, method: "ping" };
const DAY = 86_400_000;

function workosUser(email = uniqueEmail("cut")) {
  const user = {
    id: `user_${crypto.randomUUID().replaceAll("-", "").slice(0, 20)}`,
    email,
    email_verified: true,
    first_name: "Mia",
    last_name: "Tester",
  };
  addWorkosUser(user);
  return user;
}

const status = async (bearer: string) => (await mcpFetch({ bearer, body: ping })).status;

const personOf = (userId: string) =>
  env.DB.prepare("SELECT id, email FROM people WHERE workos_user_id = ? AND deleted_at IS NULL")
    .bind(userId)
    .first<{ id: string; email: string }>();

const livePeopleWith = (email: string) =>
  env.DB.prepare("SELECT count(*) AS n FROM people WHERE email = ?").bind(email).first<number>("n");

/** Moves these identities' cutoffs a minute back: tokens issued now are "after" them. */
async function ageCutoffs(...values: string[]): Promise<void> {
  await env.DB.prepare(
    "UPDATE identity_cutoffs SET revoked_at = ? WHERE value IN (SELECT value FROM json_each(?))",
  )
    .bind(Math.floor(Date.now() / 1000) - 60, JSON.stringify(values))
    .run();
}

describe("S-1: a deleted account's old agent token cannot start a new account", () => {
  test("by its WorkOS subject: 401, no person made and WorkOS not even asked", async () => {
    const user = workosUser();
    const old = await accessToken(user.id); // iat: 5 s ago
    expect(await status(old)).toBe(200);
    const was = await personOf(user.id);
    // The person deletes their account from the web app.
    const web = await devSignIn(user.email);
    expect(web.person.id).toBe(was?.id);
    expect((await call(web, "DELETE", "/api/me", { confirm: user.email })).status).toBe(204);

    const lookups = userLookups.length;
    const refused = await mcpFetch({ bearer: old, body: ping });
    expect(refused.status).toBe(401);
    expect(refused.headers.get("WWW-Authenticate")).toContain('error="unauthorized"');
    expect(await personOf(user.id)).toBeNull();
    expect(await livePeopleWith(user.email)).toBe(0);
    expect(userLookups.length).toBe(lookups);

    // A token from a new authorization (issued after the cutoff) makes a fresh account.
    await ageCutoffs(user.id, user.email);
    expect(await status(await accessToken(user.id))).toBe(200);
    const fresh = await personOf(user.id);
    expect(fresh?.id).toMatch(/^p_/);
    expect(fresh?.id).not.toBe(was?.id);
  });

  test("by its verified email: a new WorkOS subject's older token is refused too", async () => {
    // An account made on the web (no WorkOS subject on record), then deleted.
    const email = uniqueEmail("cutmail");
    const web = await devSignIn(email);
    const other = workosUser(email);
    const old = await accessToken(other.id);
    expect((await call(web, "DELETE", "/api/me", { confirm: email })).status).toBe(204);
    expect(await status(old)).toBe(401);
    expect(await livePeopleWith(email)).toBe(0);
  });

  test("a browser sign-in after deletion still makes a fresh account", async () => {
    const user = workosUser();
    expect(await status(await accessToken(user.id))).toBe(200);
    const web = await devSignIn(user.email);
    expect((await call(web, "DELETE", "/api/me", { confirm: user.email })).status).toBe(204);
    const again = await devSignIn(user.email);
    expect(again.person.id).not.toBe(web.person.id);
    expect((await call(again, "GET", "/api/me")).status).toBe(200);
  });

  test("the daily sweep drops cutoffs older than 31 days and keeps newer ones", async () => {
    const now = Math.floor(Date.now() / 1000);
    const old = `user_old_${crypto.randomUUID()}`;
    const recent = `user_recent_${crypto.randomUUID()}`;
    await env.DB.batch([
      env.DB.prepare(
        "INSERT INTO identity_cutoffs (kind, value, revoked_at) VALUES ('workos', ?, ?)",
      ).bind(old, now - 32 * 86_400),
      env.DB.prepare(
        "INSERT INTO identity_cutoffs (kind, value, revoked_at) VALUES ('workos', ?, ?)",
      ).bind(recent, now - 30 * 86_400),
    ]);
    await sweep(env);
    const left = await env.DB.prepare("SELECT value FROM identity_cutoffs WHERE value IN (?, ?)")
      .bind(old, recent)
      .all<{ value: string }>();
    expect(left.results.map((r) => r.value)).toEqual([recent]);
  });

  test("a former subject's older token cannot take the person back", async () => {
    const email = uniqueEmail("flip");
    const first = workosUser(email);
    const firstToken = await accessToken(first.id);
    expect(await status(firstToken)).toBe(200);
    const person = await personOf(first.id);
    // A different WorkOS subject presents the same verified email: it continues the person.
    const second = workosUser(email);
    const secondToken = await accessToken(second.id);
    // The token whose sign-in moved the subject is not refused by the cutoff it caused (S-2).
    expect(await status(secondToken)).toBe(200);
    expect((await personOf(second.id))?.id).toBe(person?.id);
    // The former subject's token, issued before the change: refused, and nothing moves back.
    expect(await status(firstToken)).toBe(401);
    expect((await personOf(second.id))?.id).toBe(person?.id);
    expect(await personOf(first.id)).toBeNull();
  });
});

describe("S-2: revocation by issue second, and the token that caused it", () => {
  test("through the endpoint: a token issued in the very second of a sign out everywhere works", async () => {
    const user = workosUser();
    expect(await status(await accessToken(user.id))).toBe(200);
    const web = await devSignIn(user.email);
    expect((await call(web, "POST", "/auth/logout-everywhere")).status).toBe(204);
    const at = await env.DB.prepare("SELECT credentials_revoked_at FROM people WHERE id = ?")
      .bind(web.person.id)
      .first<number>("credentials_revoked_at");
    // Re-authorized at once: iat in the revocation's own second.
    const same = await accessToken(user.id, { issuedAt: Number(at) });
    expect(await status(same)).toBe(200);
    const before = await accessToken(user.id, { issuedAt: Number(at) - 1 });
    expect(await status(before)).toBe(401);
  });

  test("an email change spares the token that brought it, not its siblings, and not for long", async () => {
    const user = workosUser();
    const trigger = await accessToken(user.id);
    const sibling = await accessToken(user.id);
    expect(await status(trigger)).toBe(200);
    // WorkOS vouched more than a day ago, and now reports a new verified email.
    addWorkosUser({ ...user, email: uniqueEmail("moved") });
    await env.DB.prepare("UPDATE people SET verified_at = ? WHERE workos_user_id = ?")
      .bind(Date.now() - DAY - 1_000, user.id)
      .run();
    expect(await status(trigger)).toBe(200);
    expect(await status(trigger)).toBe(200);
    expect(await status(sibling)).toBe(401);
    // A later revocation (sign out everywhere) ends the exemption.
    const person = await personOf(user.id);
    expect(person).not.toBeNull();
    const web = await devSignIn(person?.email ?? "");
    expect((await call(web, "POST", "/auth/logout-everywhere")).status).toBe(204);
    expect(await status(trigger)).toBe(401);
  });
});

const emailOfPerson = (id: string | undefined) =>
  env.DB.prepare("SELECT email, workos_user_id FROM people WHERE id = ?")
    .bind(id)
    .first<{ email: string | null; workos_user_id: string | null }>();

const WORKOS_ORIGIN = new URL(env.WORKOS_API_BASE ?? "https://workos.test").origin;

let lookupCount = 0;
const lookups = () => lookupCount;

/** While WorkOS is asked about `user`, `meanwhile` runs; then WorkOS answers with `user`. */
async function duringLookup<T>(
  user: ReturnType<typeof workosUser>,
  meanwhile: () => Promise<unknown>,
  run: () => Promise<T>,
): Promise<T> {
  lookupCount = 0;
  upstreams.set(WORKOS_ORIGIN, async (request) => {
    // Only the user lookup: a sign-out's removal at WorkOS (sessions,
    // authorized applications) still running after its response is not one.
    if (!/^\/user_management\/users\/[^/]+$/.test(new URL(request.url).pathname)) {
      return new Response("not found", { status: 404 });
    }
    lookupCount += 1;
    await meanwhile();
    return Response.json({ object: "user", ...user });
  });
  try {
    return await run();
  } finally {
    upstreams.delete(WORKOS_ORIGIN);
  }
}

describe("2-S1: an exemption goes only to a token accepted just before the change", () => {
  test("a token from before a sign out everywhere stays refused when WorkOS then reports a new email", async () => {
    const user = workosUser();
    const old = await accessToken(user.id);
    expect(await status(old)).toBe(200);
    const person = await personOf(user.id);
    const web = await devSignIn(user.email);
    expect((await call(web, "POST", "/auth/logout-everywhere")).status).toBe(204);
    expect(await status(old)).toBe(401);
    // Re-verification is due, and WorkOS reports a changed verified email.
    addWorkosUser({ ...user, email: uniqueEmail("moved") });
    await env.DB.prepare("UPDATE people SET verified_at = ? WHERE id = ?")
      .bind(Date.now() - DAY - 1_000, person?.id)
      .run();
    expect(await status(old)).toBe(401);
    expect(await status(old)).toBe(401);
    expect((await emailOfPerson(person?.id))?.email).toBe(user.email);
  });

  test("an unfamiliar subject with the person's email is refused by the person's cutoff", async () => {
    const email = uniqueEmail("unfam");
    const first = workosUser(email);
    expect(await status(await accessToken(first.id))).toBe(200);
    const person = await personOf(first.id);
    const second = workosUser(email);
    const early = await accessToken(second.id); // issued before the sign out below
    const web = await devSignIn(email);
    expect((await call(web, "POST", "/auth/logout-everywhere")).status).toBe(204);
    expect(await status(early)).toBe(401);
    expect(await status(early)).toBe(401);
    expect(await emailOfPerson(person?.id)).toEqual({ email, workos_user_id: first.id });
  });
});

describe("2-S2: the cutoff and the account write are one decision", () => {
  const tokenFor = (subject: string, iat: number) => ({ iat, jti: crypto.randomUUID(), subject });
  const profileOf = (user: ReturnType<typeof workosUser>) => ({
    email: user.email,
    emailVerified: true,
    workosUserId: user.id,
  });

  test("the creating batch itself refuses a token at or before an email cutoff", async () => {
    const email = uniqueEmail("guard");
    const web = await devSignIn(email);
    expect((await call(web, "DELETE", "/api/me", { confirm: email })).status).toBe(204);
    const user = workosUser(email);
    const at = await env.DB.prepare(
      "SELECT revoked_at FROM identity_cutoffs WHERE kind = 'email' AND value = ?",
    )
      .bind(email)
      .first<number>("revoked_at");
    await expect(signIn(env, profileOf(user), tokenFor(user.id, Number(at)))).rejects.toThrow(
      /change_guard_live/,
    );
    expect(await livePeopleWith(email)).toBe(0);
    // A web sign-in (no token) still makes a fresh account.
    expect((await signIn(env, profileOf(user))).created).toBe(true);
  });

  test("the relinking batch itself refuses a token from before the person's revocation", async () => {
    const email = uniqueEmail("guard2");
    const first = workosUser(email);
    expect(await status(await accessToken(first.id))).toBe(200);
    const person = await personOf(first.id);
    const web = await devSignIn(email);
    expect((await call(web, "POST", "/auth/logout-everywhere")).status).toBe(204);
    const second = workosUser(email);
    const at = Number(
      await env.DB.prepare("SELECT credentials_revoked_at FROM people WHERE id = ?")
        .bind(person?.id)
        .first<number>("credentials_revoked_at"),
    );
    await expect(signIn(env, profileOf(second), tokenFor(second.id, at - 1))).rejects.toThrow(
      /change_guard_live/,
    );
    expect(await emailOfPerson(person?.id)).toEqual({ email, workos_user_id: first.id });
    // Issued in the revocation's own second: accepted, and it relinks.
    const ok = await signIn(env, profileOf(second), tokenFor(second.id, at));
    expect(ok.person.id).toBe(person?.id);
  });

  test("an account deleted while WorkOS is asked: the old token makes no replacement person", async () => {
    const email = uniqueEmail("race");
    const web = await devSignIn(email);
    const user = workosUser(email);
    const token = await accessToken(user.id);
    const res = await duringLookup(
      user,
      async () => {
        const deleted = await call(web, "DELETE", "/api/me", { confirm: email });
        expect(deleted.status).toBe(204);
      },
      () => mcpFetch({ bearer: token, body: ping }),
    );
    expect(res.status).toBe(401);
    expect(lookups()).toBe(1);
    expect(await livePeopleWith(email)).toBe(0);
    expect(await personOf(user.id)).toBeNull();
  });

  test("a sign out everywhere while WorkOS is asked: the old token relinks nothing", async () => {
    const email = uniqueEmail("race2");
    const first = workosUser(email);
    expect(await status(await accessToken(first.id))).toBe(200);
    const person = await personOf(first.id);
    const web = await devSignIn(email);
    const second = workosUser(email);
    const token = await accessToken(second.id);
    const res = await duringLookup(
      second,
      async () => {
        expect((await call(web, "POST", "/auth/logout-everywhere")).status).toBe(204);
      },
      () => mcpFetch({ bearer: token, body: ping }),
    );
    expect(res.status).toBe(401);
    expect(await emailOfPerson(person?.id)).toEqual({ email, workos_user_id: first.id });
  });
});

describe("3-S1: a relink or refresh writes only over the row it read", () => {
  async function dueRefresh() {
    const user = workosUser();
    const iat = Math.floor(Date.now() / 1000) - 5;
    const token = await accessToken(user.id, { issuedAt: iat });
    expect(await status(token)).toBe(200);
    const person = await personOf(user.id);
    await env.DB.prepare("UPDATE people SET verified_at = ? WHERE id = ?")
      .bind(Date.now() - DAY - 1_000, person?.id)
      .run();
    // WorkOS now reports a third address, C.
    const reported = { ...user, email: uniqueEmail("c") };
    addWorkosUser(reported);
    return { user, token, iat, person, reported };
  }

  test("the email moved to one with a cutoff in the token's second: re-read, refused, nothing written", async () => {
    const { token, iat, person, reported } = await dueRefresh();
    const moved = uniqueEmail("b");
    const res = await duringLookup(
      reported,
      () =>
        env.DB.batch([
          // A browser sign-in moves the row to B while WorkOS is asked…
          env.DB.prepare("UPDATE people SET email = ? WHERE id = ?").bind(moved, person?.id),
          // …and B carries a cutoff from the token's own issue second.
          env.DB.prepare(
            "INSERT INTO identity_cutoffs (kind, value, revoked_at) VALUES ('email', ?, ?)",
          ).bind(moved, iat),
        ]),
      () => mcpFetch({ bearer: token, body: ping }),
    );
    expect(res.status).toBe(401);
    expect(lookups()).toBe(1);
    expect((await emailOfPerson(person?.id))?.email).toBe(moved);
    const exempt = await env.DB.prepare("SELECT credentials_revoked_by FROM people WHERE id = ?")
      .bind(person?.id)
      .first<string | null>("credentials_revoked_by");
    expect(exempt).toBeNull();
  });

  test("the row changed with nothing against the token: decided again once, and it goes through", async () => {
    const { token, person, reported } = await dueRefresh();
    const res = await duringLookup(
      reported,
      () =>
        env.DB.prepare("UPDATE people SET email = ? WHERE id = ?")
          .bind(uniqueEmail("b2"), person?.id)
          .run(),
      () => mcpFetch({ bearer: token, body: ping }),
    );
    expect(res.status).toBe(200);
    expect(lookups()).toBe(1);
    expect((await emailOfPerson(person?.id))?.email).toBe(reported.email);
  });
});
