// The web sign-in against the WorkOS stand-in (spec §4), the people rules it
// carries, and the dev stub's gate.
import { createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { env } from "cloudflare:workers";
import type { MeResponse } from "@onlay/protocol";
import { describe, expect, test, vi } from "vitest";
import { retryAgentAccessRemovals } from "../../src/directory/agent-access";
import { signValue } from "../../src/directory/crypto";
import worker, { handle } from "../../src/worker";
import {
  call,
  devSignIn,
  edge,
  envWith,
  ORIGIN,
  personalSpaceOf,
  seedWorkspace,
  sessionCookieOf,
  spaceLog,
  uniqueEmail,
  type Who,
  webHeaders,
} from "../support/client";
import "../support/edge-worker";
import {
  applicationCreatedAt,
  authkitSessions,
  authorize,
  authorizedApps,
  authorizedAppsLog,
  codeFor,
  type FakeUser,
  noSid,
  sessionsLog,
  sessionsOutage,
  WORKOS_CLIENT_ID,
  workosLog,
  workosOutage,
} from "../support/fake-workos";

/** The Worker with DEV_AUTH off, as in production. */
function production(path: string, init: RequestInit = {}): Promise<Response> {
  return handle(new Request(`${ORIGIN}${path}`, init), envWith(undefined));
}

let ip = 0;
const freshIp = () => `203.0.113.${++ip}`;

/** Runs `/auth/login` → (WorkOS) → `/auth/callback` for this WorkOS user. */
async function webSignIn(user: FakeUser, returnTo = "/app/#/inbox") {
  const login = await production(`/auth/login?return_to=${encodeURIComponent(returnTo)}`, {
    headers: { "CF-Connecting-IP": freshIp() },
  });
  expect(login.status).toBe(302);
  const authorize = new URL(login.headers.get("Location") ?? "");
  expect(authorize.origin + authorize.pathname).toBe(
    "https://workos.test/user_management/authorize",
  );
  expect(authorize.searchParams.get("provider")).toBe("authkit");
  expect(authorize.searchParams.get("client_id")).toBe(WORKOS_CLIENT_ID);
  expect(authorize.searchParams.get("redirect_uri")).toBe(`${ORIGIN}/auth/callback`);
  const state = authorize.searchParams.get("state") ?? "";
  const stateCookie = (login.headers.get("Set-Cookie") ?? "").split(";")[0] ?? "";
  return production(`/auth/callback?code=${codeFor(user)}&state=${encodeURIComponent(state)}`, {
    headers: { Cookie: stateCookie },
  });
}

function user(email: string, verified = true): FakeUser {
  return {
    id: `user_${crypto.randomUUID()}`,
    email,
    email_verified: verified,
    first_name: "Lina",
    last_name: "Haddad",
  };
}

async function me(cookie: string): Promise<MeResponse> {
  const res = await call({ cookie } as Who, "GET", "/api/me");
  expect(res.status).toBe(200);
  return (await res.json()) as MeResponse;
}

describe("web sign-in through WorkOS", () => {
  test("a verified first sign-in creates the person and their personal space, then returns", async () => {
    const email = uniqueEmail("lina");
    const res = await webSignIn(user(email.toUpperCase()), "/app/#/t/x");
    expect(res.status).toBe(302);
    expect(res.headers.get("Location")).toBe("/app/#/t/x");
    const cookie = sessionCookieOf(res);
    const setCookie = res.headers.getSetCookie().find((c) => c.startsWith("__Host-onlay.session="));
    expect(setCookie).toMatch(/HttpOnly; Secure; SameSite=Lax/);
    expect(setCookie).toMatch(/Path=\//);

    const body = await me(cookie);
    expect(body.person.email).toBe(email);
    expect(body.person.name).toBe("Lina Haddad");
    expect(body.person.initials).toBe("LH");
    expect(body.spaces).toEqual([
      { id: expect.stringMatching(/^s_/), kind: "personal", name: "Personal", role: "admin" },
    ]);
    expect(body.superAdmin).toBe(false);
    expect(workosLog.at(-1)).toMatchObject({
      grant_type: "authorization_code",
      client_id: WORKOS_CLIENT_ID,
    });

    // The second sign-in finds the same person.
    const again = await webSignIn(user(email));
    expect((await me(sessionCookieOf(again))).person.id).toBe(body.person.id);
  });

  test("an unverified email is refused and creates nothing", async () => {
    const email = uniqueEmail("unverified");
    const res = await webSignIn(user(email, false));
    expect(res.status).toBe(403);
    expect(res.headers.getSetCookie().some((c) => c.startsWith("__Host-onlay.session="))).toBe(
      false,
    );
    expect(
      await env.DB.prepare("SELECT id FROM people WHERE email = ?").bind(email).first(),
    ).toBeNull();
  });

  test("SUPER_ADMINS emails become super admins at first sign-in", async () => {
    const res = await webSignIn(user("chief@example.com"));
    expect((await me(sessionCookieOf(res))).superAdmin).toBe(true);
  });

  test("a sign-in claims invitations to the person's email and tells the space", async () => {
    const admin = await devSignIn();
    const workspace = await seedWorkspace([admin]);
    const email = uniqueEmail("invited");
    const invited = await call(admin, "POST", `/api/workspaces/${workspace.id}/invitations`, {
      email,
    });
    expect(await invited.json()).toEqual({ joined: false });

    const body = await me(sessionCookieOf(await webSignIn(user(email))));
    expect(body.spaces).toContainEqual({
      id: workspace.id,
      kind: "workspace",
      name: workspace.name,
      role: "member",
    });
    expect(
      await env.DB.prepare("SELECT 1 FROM invitations WHERE email = ?").bind(email).first(),
    ).toBeNull();

    const log = await spaceLog(workspace.id);
    const person = log.filter((entry) => entry.path === "/internal/person").at(-1);
    expect(JSON.parse(person?.body ?? "{}")).toEqual({
      person: expect.objectContaining({ id: body.person.id, member: true }),
    });
    const access = log.filter((entry) => entry.path === "/internal/access-changed").at(-1);
    expect(JSON.parse(access?.body ?? "{}")).toEqual({
      personId: body.person.id,
      access: { kind: "member", role: "member" },
    });
  });

  test("a callback without its state cookie, or with a forged state, is refused", async () => {
    const forged = await production(
      `/auth/callback?code=${codeFor(user(uniqueEmail()))}&state=abc.def`,
    );
    expect(forged.status).toBe(400);
    const login = await production("/auth/login", { headers: { "CF-Connecting-IP": freshIp() } });
    const state = new URL(login.headers.get("Location") ?? "").searchParams.get("state") ?? "";
    const noCookie = await production(
      `/auth/callback?code=${codeFor(user(uniqueEmail()))}&state=${encodeURIComponent(state)}`,
    );
    expect(noCookie.status).toBe(400);
  });

  test("return_to must be a same-origin path", async () => {
    for (const evil of ["https://evil.test/x", "//evil.test/x", "/\\evil.test"]) {
      const res = await webSignIn(user(uniqueEmail()), evil);
      expect(res.headers.get("Location")).toBe("/app/");
    }
  });

  test("sign-in starts are limited to 10 a minute per IP", async () => {
    const address = "198.51.100.77";
    const statuses: number[] = [];
    for (let i = 0; i < 11; i++) {
      statuses.push(
        (await production("/auth/login", { headers: { "CF-Connecting-IP": address } })).status,
      );
    }
    expect(statuses.slice(0, 10).every((status) => status === 302)).toBe(true);
    expect(statuses[10]).toBe(429);
  });
});

describe("sign-in attempts in one browser", () => {
  const ATTEMPT = "__Host-onlay.state.";
  interface Attempt {
    state: string;
    /** `name=value`, as the browser sends it. */
    cookie: string;
    setCookies: string[];
  }
  const start = async (returnTo = "/app/", cookies: string[] = []): Promise<Attempt> => {
    const headers: Record<string, string> = { "CF-Connecting-IP": freshIp() };
    if (cookies.length > 0) headers.Cookie = cookies.join("; ");
    const login = await production(`/auth/login?return_to=${encodeURIComponent(returnTo)}`, {
      headers,
    });
    expect(login.status).toBe(302);
    const setCookies = login.headers.getSetCookie();
    const set = setCookies.filter((c) => c.startsWith(ATTEMPT) && !c.includes("Max-Age=0"));
    expect(set).toHaveLength(1);
    expect(set[0]).toMatch(/; Max-Age=600; Path=\/; HttpOnly; Secure; SameSite=Lax$/);
    return {
      state: new URL(login.headers.get("Location") ?? "").searchParams.get("state") ?? "",
      cookie: set[0]?.split(";")[0] ?? "",
      setCookies,
    };
  };
  const finish = (who: FakeUser, state: string, cookies: string[], navigate = false) => {
    const headers: Record<string, string> = {};
    if (cookies.length > 0) headers.Cookie = cookies.join("; ");
    if (navigate) headers["Sec-Fetch-Mode"] = "navigate";
    return production(`/auth/callback?code=${codeFor(who)}&state=${encodeURIComponent(state)}`, {
      headers,
    });
  };
  const nameOf = (cookie: string) => cookie.split("=")[0] ?? "";
  /** The attempt cookies a response's (or a login's) Set-Cookie headers clear. */
  const cleared = (from: Response | string[]) =>
    (Array.isArray(from) ? from : from.headers.getSetCookie())
      .filter((c) => c.startsWith(ATTEMPT) && c.includes("Max-Age=0"))
      .map(nameOf);
  const exchanges = () => workosLog.filter((body) => body.grant_type === "authorization_code");

  for (const order of ["first then second", "second then first"] as const) {
    test(`two attempts started side by side both complete (${order})`, async () => {
      const a = await start("/app/#/a");
      const b = await start("/app/#/b", [a.cookie]);
      // Starting the second leaves the first alone.
      expect(cleared(b.setCookies)).toEqual([]);
      expect(nameOf(a.cookie)).not.toBe(nameOf(b.cookie));
      const jar = [a.cookie, b.cookie];
      const [one, two] = order === "first then second" ? [a, b] : [b, a];
      const email = uniqueEmail("side");
      const firstDone = await finish(user(email), one.state, jar);
      expect(firstDone.status).toBe(302);
      // Success clears its own attempt's cookie and no other.
      expect(cleared(firstDone)).toEqual([nameOf(one.cookie)]);
      const left = jar.filter((c) => c !== one.cookie);
      const secondDone = await finish(user(email), two.state, [
        ...left,
        sessionCookieOf(firstDone),
      ]);
      expect(secondDone.status).toBe(302);
      expect(secondDone.headers.get("Location")).toBe(two === a ? "/app/#/a" : "/app/#/b");
      expect(cleared(secondDone)).toEqual([nameOf(two.cookie)]);
      expect((await me(sessionCookieOf(secondDone))).person.email).toBe(email);
    });
  }

  test("the callback still refuses a nonce the browser does not hold", async () => {
    const mine = await start();
    const theirs = await start();
    const before = exchanges().length;
    // Another attempt's cookie, and this attempt's name with another nonce.
    const otherNonce = `${nameOf(mine.cookie)}=${Date.now()}.${"x".repeat(43)}`;
    for (const cookies of [[theirs.cookie], [otherNonce], [mine.cookie, mine.cookie]]) {
      const res = await finish(user(uniqueEmail()), mine.state, cookies);
      expect(res.status).toBe(400);
      expect(res.headers.getSetCookie().some((c) => c.startsWith("__Host-onlay.session="))).toBe(
        false,
      );
    }
    expect(exchanges().length).toBe(before);
  });

  test("a verified state without its attempt goes on when the browser is signed in, exchanging no code", async () => {
    const session = sessionCookieOf(await webSignIn(user(uniqueEmail("signed"))));
    const target = "/auth/extension?ext=abc&challenge=c&state=s";
    const attempt = await start(target);
    const before = exchanges().length;
    const res = await finish(user(uniqueEmail("attacker")), attempt.state, [session], true);
    expect(res.status).toBe(302);
    expect(res.headers.get("Location")).toBe(target);
    expect(res.headers.getSetCookie().some((c) => c.startsWith("__Host-onlay.session="))).toBe(
      false,
    );
    expect(cleared(res)).toEqual([nameOf(attempt.cookie)]);
    expect(exchanges().length).toBe(before);
    // A Bearer never counts as the browser's session.
    const bearer = await production(
      `/auth/callback?code=${codeFor(user(uniqueEmail()))}&state=${encodeURIComponent(attempt.state)}`,
      { headers: { Authorization: "Bearer onl_x", "Sec-Fetch-Mode": "navigate" } },
    );
    expect(bearer.status).toBe(400);
  });

  test("a callback with no code recovers the same way, and is incomplete only for a signed-out browser", async () => {
    const session = sessionCookieOf(await webSignIn(user(uniqueEmail("nocode"))));
    const attempt = await start("/app/#/back");
    const noCode = (cookies: string[]) =>
      production(`/auth/callback?error=access_denied&state=${encodeURIComponent(attempt.state)}`, {
        headers: { Cookie: cookies.join("; "), "Sec-Fetch-Mode": "navigate" },
      });
    // The attempt is gone (another tab finished it) and the browser is signed in.
    const signedIn = await noCode([session]);
    expect(signedIn.status).toBe(302);
    expect(signedIn.headers.get("Location")).toBe("/app/#/back");
    // The attempt is still the browser's own: the link is incomplete, signed in or not.
    for (const cookies of [[attempt.cookie], [attempt.cookie, session]]) {
      const res = await noCode(cookies);
      expect(res.status).toBe(400);
      expect(await res.text()).toContain("The sign-in link is incomplete. Sign in again.");
    }
  });

  test("a cookie whose name only looks like a protected one after trimming does not count", async () => {
    const mine = await start("/app/#/nbsp");
    const before = exchanges().length;
    // U+00A0 is not the space or tab a Cookie header allows around a name.
    const lookalikeAttempt = `\u00a0${mine.cookie}`;
    const refused = await finish(user(uniqueEmail()), mine.state, [lookalikeAttempt], true);
    expect(refused.status).toBe(400);
    expect(exchanges().length).toBe(before);
    // Nor does a lookalike session cookie make the browser signed in.
    const session = sessionCookieOf(await webSignIn(user(uniqueEmail("nbsp"))));
    const lookalikeSession = await finish(
      user(uniqueEmail()),
      mine.state,
      [`\u00a0${session}`],
      true,
    );
    expect(lookalikeSession.status).toBe(400);
    // Plain spaces and tabs around a name are still its separators.
    const spaced = await finish(user(uniqueEmail("spaced")), mine.state, [` \t${mine.cookie}`]);
    expect(spaced.status).toBe(302);
  });

  test("a verified state without its attempt, signed out, links Sign in again back to where it was going", async () => {
    const attempt = await start("/app/#/t/x");
    const res = await finish(user(uniqueEmail()), attempt.state, [], true);
    expect(res.status).toBe(400);
    const html = await res.text();
    expect(html).toContain("This sign-in expired or was started elsewhere. Sign in again.");
    expect(html).toContain(
      '<a href="/auth/login?return_to=%2Fapp%2F%23%2Ft%2Fx">Sign in again</a>',
    );
  });

  test("a state signed long ago, or before attempts had cookies of their own, recovers the same way", async () => {
    const session = sessionCookieOf(await webSignIn(user(uniqueEmail("old"))));
    const secret = envWith(undefined).SESSION_SECRET ?? "";
    const states = [
      // Signed before this change: no attempt id, held in the one `__Host-onlay.state` cookie.
      await signValue(secret, { r: "/app/#/old", n: "n".repeat(43), e: Date.now() + 60_000 }),
      // Expired a year ago.
      await signValue(secret, {
        r: "/app/#/old",
        n: "n".repeat(43),
        e: Date.now() - 365 * 86_400_000,
        a: "attempt0000",
      }),
    ];
    const before = exchanges().length;
    for (const state of states) {
      const on = await finish(
        user(uniqueEmail()),
        state,
        [session, `__Host-onlay.state=${"n".repeat(43)}`],
        true,
      );
      expect(on.status).toBe(302);
      expect(on.headers.get("Location")).toBe("/app/#/old");
      const out = await finish(user(uniqueEmail()), state, [], true);
      expect(await out.text()).toContain('href="/auth/login?return_to=%2Fapp%2F%23%2Fold"');
    }
    expect(exchanges().length).toBe(before);
  });

  test("recovery never sends the person back into the sign-in routes", async () => {
    const session = sessionCookieOf(await webSignIn(user(uniqueEmail("loop"))));
    for (const target of ["/auth/callback?code=c&state=s", "/auth/login?return_to=%2Fapp%2F"]) {
      const attempt = await start(target);
      const res = await finish(user(uniqueEmail()), attempt.state, [session], true);
      expect(res.headers.get("Location")).toBe("/app/");
      const out = await finish(user(uniqueEmail()), attempt.state, [], true);
      expect(await out.text()).toContain('href="/auth/login?return_to=%2Fapp%2F"');
    }
  });

  test("recovery and sign-in end only in the web app or the extension hand-off", async () => {
    // A public page's alias on the service redirects to the site, so ending
    // there would tell the site this browser is signed in.
    const session = sessionCookieOf(await webSignIn(user(uniqueEmail("dest"))));
    const secret = envWith(undefined).SESSION_SECRET ?? "";
    const handoff = "/auth/extension?ext=abcdefghijklmnopabcdefghijklmnop&challenge=c&state=s";
    const cases: [string, string][] = [
      ["/install", "/app/"],
      ["/privacy", "/app/"],
      ["/download/onlay-extension.zip", "/app/"],
      ["/healthz", "/app/"],
      ["/api/me", "/app/"],
      ["/", "/app/"],
      ["/app", "/app/"],
      ["/app?x=1#/t/y", "/app/?x=1#/t/y"],
      ["/app/index.html#/t/y", "/app/index.html#/t/y"],
      // Under /app/ but not the shell: an asset, the worker, a missing path.
      ["/app/app.abc123.js", "/app/"],
      ["/app/sw.js", "/app/"],
      ["/app/missing", "/app/"],
      ["/app/missing/#/t/x", "/app/"],
      ["/auth/extension/token", "/app/"],
      ["/app/#/t/x", "/app/#/t/x"],
      ["/app/?q=1#/t/x", "/app/?q=1#/t/x"],
      [handoff, handoff],
    ];
    for (const [r, expected] of cases) {
      const state = await signValue(secret, { r, n: "n".repeat(43), e: Date.now() + 60_000 });
      const on = await finish(user(uniqueEmail()), state, [session], true);
      expect(on.status, r).toBe(302);
      expect(on.headers.get("Location"), r).toBe(expected);
    }
    for (const [r, expected] of cases) {
      const res = await webSignIn(user(uniqueEmail()), r);
      expect(res.headers.get("Location"), r).toBe(expected);
    }
  });

  test("a state whose signature fails behaves as before, signed in or not", async () => {
    const session = sessionCookieOf(await webSignIn(user(uniqueEmail("forged"))));
    const attempt = await start("/app/#/t/x");
    const [payload] = attempt.state.split(".");
    for (const state of ["abc.def", `${payload}.${"A".repeat(43)}`]) {
      for (const cookies of [[], [session, attempt.cookie]]) {
        const res = await finish(user(uniqueEmail()), state, cookies, true);
        expect(res.status).toBe(400);
        expect(cleared(res)).toEqual([]);
        expect(await res.text()).toContain('<a href="/auth/login">Sign in again</a>');
      }
    }
  });

  test("a browser keeps at most five pending attempts, expiring the oldest", async () => {
    const id = (n: number) => `attempt${String(n).padStart(4, "0")}`;
    const held = (count: number) =>
      Array.from(
        { length: count },
        // Sent newest first, so the cap goes by start time, not cookie order.
        (_, i) => `${ATTEMPT}${id(count - 1 - i)}=${1_000 + count - 1 - i}.${"n".repeat(43)}`,
      );
    expect(cleared((await start("/app/", held(4))).setCookies)).toEqual([]);
    expect(cleared((await start("/app/", held(5))).setCookies)).toEqual([`${ATTEMPT}${id(0)}`]);
    expect(cleared((await start("/app/", held(7))).setCookies).sort()).toEqual(
      [0, 1, 2].map((n) => `${ATTEMPT}${id(n)}`),
    );
  });
});

describe("email changes end old access (round 2, S6)", () => {
  const IID_A = "3f1c2d3e-4b5a-4c6d-8e7f-0a1b2c3d4e51";
  const IID_B = "3f1c2d3e-4b5a-4c6d-8e7f-0a1b2c3d4e52";
  const epochOf = async (spaceId: string) =>
    Number(
      await env.DB.prepare("SELECT access_epoch FROM spaces WHERE id = ?")
        .bind(spaceId)
        .first<number>("access_epoch"),
    );
  const lastBody = async (spaceId: string, path: string) =>
    JSON.parse(
      (await spaceLog(spaceId)).filter((e) => e.path === path).at(-1)?.body ?? "{}",
    ) as Record<string, unknown>;

  test("a verified email change cuts every earlier credential and re-scopes both addresses' shares", async () => {
    const oldEmail = uniqueEmail("before");
    const newEmail = uniqueEmail("after");
    const lina = user(oldEmail);
    const first = sessionCookieOf(await webSignIn(lina));
    const personId = (await me(first)).person.id;
    const personal = (await me(first)).spaces[0]?.id ?? "";
    const owner = await devSignIn();
    const owner2 = await devSignIn();
    const ownerSpace = await personalSpaceOf(owner);
    const owner2Space = await personalSpaceOf(owner2);
    for (const [who, space, iid, email] of [
      [owner, ownerSpace, IID_A, oldEmail],
      [owner2, owner2Space, IID_B, newEmail],
    ] as const) {
      const shared = await call(who, "POST", `/api/spaces/${space}/interactions/${iid}/shares`, {
        email,
      });
      expect(shared.status).toBe(201);
    }
    const before = [await epochOf(ownerSpace), await epochOf(owner2Space)];

    const second = sessionCookieOf(await webSignIn({ ...lina, email: newEmail }));
    expect((await call({ cookie: first } as Who, "GET", "/api/me")).status).toBe(401);
    const now = await me(second);
    expect(now.person).toMatchObject({ id: personId, email: newEmail });

    expect(await epochOf(ownerSpace)).toBeGreaterThan(before[0] ?? 0);
    expect(await epochOf(owner2Space)).toBeGreaterThan(before[1] ?? 0);
    // Delivered from D1 as it stands after the change.
    expect(await lastBody(ownerSpace, "/internal/access-changed")).toEqual({
      personId,
      access: null,
    });
    expect(await lastBody(owner2Space, "/internal/access-changed")).toEqual({
      personId,
      access: { kind: "guest", interactionIds: [IID_B] },
    });
    // Every space the old address reached heard the new generation, the person's own included.
    for (const space of [personal, ownerSpace]) {
      expect(await lastBody(space, "/internal/credential-revoked")).toEqual({
        personId,
        minGeneration: 1,
      });
    }
  });

  test("a new WorkOS subject with the same verified email continues the person, and ends earlier credentials", async () => {
    // Identity is the verified email (decided): whoever controls the mailbox signs in.
    const email = uniqueEmail("subject");
    const first = sessionCookieOf(await webSignIn(user(email)));
    const personId = (await me(first)).person.id;
    const warned = vi.spyOn(console, "warn").mockImplementation(() => {});
    const replacement = user(email);
    const second = sessionCookieOf(await webSignIn(replacement));
    expect((await me(second)).person.id).toBe(personId);
    expect(
      await env.DB.prepare("SELECT workos_user_id FROM people WHERE id = ?")
        .bind(personId)
        .first<string>("workos_user_id"),
    ).toBe(replacement.id);
    expect((await call({ cookie: first } as Who, "GET", "/api/me")).status).toBe(401);
    expect(warned.mock.calls.some((c) => String(c[0]).includes("new WorkOS subject"))).toBe(true);
    warned.mockRestore();
  });
});

describe("the dev stub", () => {
  test('is unreachable unless DEV_AUTH is exactly "1"', async () => {
    for (const devAuth of [undefined, "0", "true"]) {
      const res = await handle(
        new Request(`${ORIGIN}/auth/dev/session`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ email: uniqueEmail() }),
        }),
        envWith(devAuth),
      );
      expect(res.status).toBe(404);
    }
    // And /auth/login goes to AuthKit, not the dev form.
    expect(
      (await production("/auth/login", { headers: { "CF-Connecting-IP": freshIp() } })).status,
    ).toBe(302);
  });

  test("with DEV_AUTH=1, /auth/login is a one-field form posting to the stub", async () => {
    const form = await edge("/auth/login?return_to=/app/%23/x", {
      headers: { "CF-Connecting-IP": freshIp() },
    });
    expect(form.status).toBe(200);
    const html = await form.text();
    expect(html).toContain('action="/auth/dev/session"');
    expect(html).toContain('name="email"');

    const email = uniqueEmail("form");
    const posted = await edge("/auth/dev/session", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ email, return_to: "/app/#/x" }).toString(),
    });
    expect(posted.status).toBe(303);
    expect(posted.headers.get("Location")).toBe("/app/#/x");
    expect((await me(sessionCookieOf(posted))).person.email).toBe(email);
  });
});

describe("sign-out", () => {
  test("logout ends this session; logout-everywhere ends every session and token", async () => {
    const email = uniqueEmail("out");
    const first = await devSignIn(email);
    const second = await devSignIn(email);

    expect((await call(first, "POST", "/auth/logout")).status).toBe(204);
    expect((await call(first, "GET", "/api/me")).status).toBe(401);
    expect((await call(second, "GET", "/api/me")).status).toBe(200);

    expect((await call(second, "POST", "/auth/logout-everywhere")).status).toBe(204);
    expect((await call(second, "GET", "/api/me")).status).toBe(401);
    expect((await call(second, "GET", "/api/me", undefined, "extension")).status).toBe(401);
    expect((await call(first, "GET", "/api/me", undefined, "extension")).status).toBe(401);
  });
});

describe("ending agent access at WorkOS (S-3)", () => {
  interface Owed {
    attempts: number;
    next_attempt_at: number;
    requested_at: number;
  }
  const owed = (userId: string) =>
    env.DB.prepare(
      "SELECT attempts, next_attempt_at, requested_at FROM workos_access_removals WHERE workos_user_id = ?",
    )
      .bind(userId)
      .first<Owed>();
  const dueNow = (userId: string) =>
    env.DB.prepare("UPDATE workos_access_removals SET next_attempt_at = 0 WHERE workos_user_id = ?")
      .bind(userId)
      .run();
  /** A web app write with its own `waitUntil`, so the test can wait for what runs after it. */
  const webWrite = async (
    who: Who,
    method: string,
    path: string,
    body?: unknown,
    extra: Record<string, string> = {},
  ) => {
    const ctx = createExecutionContext();
    const headers = { ...webHeaders(who, method), ...extra };
    if (body !== undefined) headers["Content-Type"] = "application/json";
    const res = await handle(
      new Request(`${ORIGIN}${path}`, {
        method,
        headers,
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      }),
      env,
      ctx,
    );
    return { status: res.status, res, after: () => waitOnExecutionContext(ctx) };
  };
  const signOutEverywhere = async (who: Who) => {
    const out = await webWrite(who, "POST", "/auth/logout-everywhere");
    // 200 with AuthKit's logout for a WorkOS session, 204 for the dev stub's.
    expect([200, 204]).toContain(out.status);
    await out.after();
  };
  const signedIn = async (lina: FakeUser): Promise<Who> => {
    let res = await webSignIn(lina);
    // An attempt begun in the same second as a sign out everywhere is
    // cancelled (it may have straddled it); a browser starts another.
    if (res.status === 409) {
      await new Promise((r) => setTimeout(r, 1_100));
      res = await webSignIn(lina);
    }
    const cookie = sessionCookieOf(res);
    return { cookie, person: (await me(cookie)).person } as Who;
  };

  test("sign out everywhere removes every application the WorkOS user authorized", async () => {
    const lina = user(uniqueEmail("agents"));
    const who = await signedIn(lina);
    // More than one list page's worth, so the removal lists again until none are left.
    const many = Array.from({ length: 105 }, (_, i) => `conn_app_${i}`);
    authorize(lina.id, ...many);
    const bystander = user(uniqueEmail("bystander"));
    authorize(bystander.id, "conn_app_other");

    await signOutEverywhere(who);
    expect(authorizedApps.get(lina.id)).toEqual([]);
    expect(authorizedApps.get(bystander.id)).toEqual(["conn_app_other"]);
    expect(await owed(lina.id)).toBeNull();
    expect(authorizedAppsLog).toContain(
      `DELETE /user_management/users/${lina.id}/authorized_applications/conn_app_104`,
    );
  });

  test("account deletion removes them too, though the tombstone forgets the WorkOS user", async () => {
    const lina = user(uniqueEmail("leaving"));
    const who = await signedIn(lina);
    authorize(lina.id, "conn_app_claude", "conn_app_cursor");
    const gone = await webWrite(who, "DELETE", "/api/me", { confirm: who.person.email });
    expect(gone.status).toBe(204);
    await gone.after();
    expect(authorizedApps.get(lina.id)).toEqual([]);
    expect(await owed(lina.id)).toBeNull();
  });

  test("sign-out and deletion answer before WorkOS does; the removal finishes after", async () => {
    let release = () => {};
    workosOutage.hold = new Promise<void>((resolve) => {
      release = resolve;
    });
    try {
      const lina = user(uniqueEmail("waiting"));
      const who = await signedIn(lina);
      authorize(lina.id, "conn_app_a");
      const out = await webWrite(who, "POST", "/auth/logout-everywhere");
      expect(out.status).toBe(200);
      expect((await call(who, "GET", "/api/me")).status).toBe(401);
      // WorkOS has not answered yet: still authorized, still owed.
      expect(authorizedApps.get(lina.id)).toEqual(["conn_app_a"]);
      expect(await owed(lina.id)).not.toBeNull();

      const leaving = user(uniqueEmail("waiting-delete"));
      const gone = await signedIn(leaving);
      authorize(leaving.id, "conn_app_b");
      const deleted = await webWrite(gone, "DELETE", "/api/me", { confirm: gone.person.email });
      expect(deleted.status).toBe(204);
      expect(authorizedApps.get(leaving.id)).toEqual(["conn_app_b"]);

      release();
      await out.after();
      await deleted.after();
      expect(authorizedApps.get(lina.id)).toEqual([]);
      expect(authorizedApps.get(leaving.id)).toEqual([]);
      expect(await owed(lina.id)).toBeNull();
    } finally {
      workosOutage.hold = null;
      release();
    }
  });

  test("a person who never signed in through WorkOS asks WorkOS nothing", async () => {
    const who = await devSignIn();
    const before = authorizedAppsLog.length;
    await signOutEverywhere(who);
    expect(authorizedAppsLog.length).toBe(before);
  });

  test("with WorkOS down the sign-out still succeeds and the cron retries with backoff", async () => {
    const lina = user(uniqueEmail("outage"));
    const who = await signedIn(lina);
    authorize(lina.id, "conn_app_a");
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      workosOutage.calls = 1_000;
      await signOutEverywhere(who);
      expect((await call(who, "GET", "/api/me")).status).toBe(401);
      const first = await owed(lina.id);
      expect(first?.attempts).toBe(1);
      expect(first?.next_attempt_at).toBeGreaterThan(Date.now() + 20_000);

      // Backing off: the next tick leaves it alone.
      const calls = authorizedAppsLog.length;
      await retryAgentAccessRemovals(env);
      expect(authorizedAppsLog.length).toBe(calls);

      // Due, still failing: counted, and waiting longer.
      await dueNow(lina.id);
      await retryAgentAccessRemovals(env);
      const second = await owed(lina.id);
      expect(second?.attempts).toBe(2);
      expect(second?.next_attempt_at).toBeGreaterThan(Date.now() + 50_000);
      expect(authorizedApps.get(lina.id)).toEqual(["conn_app_a"]);

      // WorkOS is back: the every-minute cron finishes the removal.
      workosOutage.calls = 0;
      await dueNow(lina.id);
      await worker.scheduled(
        { cron: "* * * * *", scheduledTime: Date.now(), noRetry() {} } as ScheduledController,
        env,
      );
      expect(authorizedApps.get(lina.id)).toEqual([]);
      expect(await owed(lina.id)).toBeNull();
    } finally {
      workosOutage.calls = 0;
      logged.mockRestore();
    }
  });

  test("a retry spares an agent registered after the sign-out, and removes everything older", async () => {
    const lina = user(uniqueEmail("came-back"));
    const who = await signedIn(lina);
    authorize(lina.id, "conn_app_before");
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      workosOutage.calls = 1_000;
      await signOutEverywhere(who);
      const asked = Date.now() - 10 * 60_000;
      // Asked for ten minutes ago; WorkOS has been down since.
      await env.DB.prepare(
        "UPDATE workos_access_removals SET requested_at = ?, next_attempt_at = 0 WHERE workos_user_id = ?",
      )
        .bind(asked, lina.id)
        .run();
      // Since then Lina set up a new agent (registered and authorized now), an
      // agent registered a minute before the sign-out was authorized too, and
      // a long-registered one was authorized again.
      applicationCreatedAt.set("conn_app_new", new Date());
      applicationCreatedAt.set("conn_app_just_before", new Date(asked - 60_000));
      authorize(lina.id, "conn_app_just_before", "conn_app_new", "conn_app_static");
      workosOutage.calls = 0;
      await retryAgentAccessRemovals(env);
      expect(authorizedApps.get(lina.id)).toEqual(["conn_app_new"]);
      expect(await owed(lina.id)).toBeNull();
      expect(authorizedAppsLog).not.toContain(
        `DELETE /user_management/users/${lina.id}/authorized_applications/conn_app_new`,
      );
      expect(authorizedAppsLog).toContain(
        `GET /user_management/users/${lina.id}/authorized_applications`,
      );
    } finally {
      workosOutage.calls = 0;
      applicationCreatedAt.delete("conn_app_new");
      applicationCreatedAt.delete("conn_app_just_before");
      logged.mockRestore();
    }
  });

  /** Lina signed out everywhere ten minutes ago, with WorkOS down since; it is back now. */
  const owedSinceTenMinutes = async (lina: FakeUser): Promise<number> => {
    const who = await signedIn(lina);
    workosOutage.calls = 1_000;
    await signOutEverywhere(who);
    const asked = Date.now() - 10 * 60_000;
    await env.DB.prepare(
      "UPDATE workos_access_removals SET requested_at = ?, next_attempt_at = 0 WHERE workos_user_id = ?",
    )
      .bind(asked, lina.id)
      .run();
    workosOutage.calls = 0;
    return asked;
  };

  test("an older client listed after a full page of spared ones is still removed (2-S1)", async () => {
    const lina = user(uniqueEmail("full-page"));
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    const fresh = Array.from({ length: 100 }, (_, i) => `conn_app_fresh_${lina.id}_${i}`);
    try {
      await owedSinceTenMinutes(lina);
      // A hundred agents registered since fill the first page; then a
      // long-registered client was authorized again.
      for (const id of fresh) applicationCreatedAt.set(id, new Date());
      authorize(lina.id, ...fresh, "conn_app_static");
      const before = authorizedAppsLog.length;
      await retryAgentAccessRemovals(env);
      expect(authorizedApps.get(lina.id)).toEqual(fresh);
      expect(await owed(lina.id)).toBeNull();
      // Two pages read, one delete: the static client.
      expect(authorizedAppsLog.slice(before)).toEqual([
        `GET /user_management/users/${lina.id}/authorized_applications`,
        `GET /user_management/users/${lina.id}/authorized_applications`,
        `DELETE /user_management/users/${lina.id}/authorized_applications/conn_app_static`,
      ]);
    } finally {
      workosOutage.calls = 0;
      for (const id of fresh) applicationCreatedAt.delete(id);
      logged.mockRestore();
    }
  });

  test("a list longer than 20 pages removes what it read, and the retry finishes it (2-S1, 3-S1)", async () => {
    const lina = user(uniqueEmail("long-list"));
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    const fresh = Array.from({ length: 2_000 }, (_, i) => `conn_app_many_${lina.id}_${i}`);
    try {
      await owedSinceTenMinutes(lina);
      for (const id of fresh) applicationCreatedAt.set(id, new Date());
      // Old clients at both ends: one on the first page, one past the twentieth.
      authorize(lina.id, "conn_app_first", ...fresh, "conn_app_last");
      await retryAgentAccessRemovals(env);
      // What the twenty pages showed is gone; the rest waits for the retry.
      expect(authorizedApps.get(lina.id)).toEqual([...fresh, "conn_app_last"]);
      const left = await owed(lina.id);
      // The failed try during the outage, then this one.
      expect(left?.attempts).toBe(2);
      expect(left?.next_attempt_at).toBeGreaterThan(Date.now());
      expect(logged.mock.calls.some((args) => String(args[1]).includes("more than 20 pages"))).toBe(
        true,
      );
      // The retry continues where this one stopped and reaches the end.
      await dueNow(lina.id);
      await retryAgentAccessRemovals(env);
      expect(authorizedApps.get(lina.id)).toEqual(fresh);
      expect(await owed(lina.id)).toBeNull();
    } finally {
      workosOutage.calls = 0;
      for (const id of fresh) applicationCreatedAt.delete(id);
      logged.mockRestore();
    }
  });

  interface Cursor {
    list_after: string | null;
    list_after_for: number | null;
  }
  const cursorOf = (userId: string) =>
    env.DB.prepare(
      "SELECT list_after, list_after_for FROM workos_access_removals WHERE workos_user_id = ?",
    )
      .bind(userId)
      .first<Cursor>();

  test("an older authorization past 2,000 spared ones is removed by the next attempt, not missed by every one (3-S1)", async () => {
    const lina = user(uniqueEmail("page-21"));
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    const fresh = Array.from({ length: 2_000 }, (_, i) => `conn_app_p21_${lina.id}_${i}`);
    try {
      const asked = await owedSinceTenMinutes(lina);
      for (const id of fresh) applicationCreatedAt.set(id, new Date());
      authorize(lina.id, ...fresh, "conn_app_old");
      await retryAgentAccessRemovals(env);
      // Twenty pages, all spared: nothing removed yet, and the row keeps where it stopped.
      expect(authorizedApps.get(lina.id)).toEqual([...fresh, "conn_app_old"]);
      expect(await cursorOf(lina.id)).toEqual({
        list_after: `authorized_${fresh[1_999]}`,
        list_after_for: asked,
      });

      await dueNow(lina.id);
      const before = authorizedAppsLog.length;
      await retryAgentAccessRemovals(env);
      // One page from the cursor, not twenty from the first: page 21 is reached.
      expect(authorizedAppsLog.slice(before)).toEqual([
        `GET /user_management/users/${lina.id}/authorized_applications`,
        `DELETE /user_management/users/${lina.id}/authorized_applications/conn_app_old`,
      ]);
      expect(authorizedApps.get(lina.id)).toEqual(fresh);
      expect(await owed(lina.id)).toBeNull();
    } finally {
      workosOutage.calls = 0;
      for (const id of fresh) applicationCreatedAt.delete(id);
      logged.mockRestore();
    }
  });

  test("a cursor WorkOS refuses is dropped, and a repeat sign-out starts from page one (3-S1)", async () => {
    const lina = user(uniqueEmail("bad-cursor"));
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const asked = await owedSinceTenMinutes(lina);
      authorize(lina.id, "conn_app_old");
      const setCursor = (after: string, forRequest: number) =>
        env.DB.prepare(
          "UPDATE workos_access_removals SET list_after = ?, list_after_for = ? WHERE workos_user_id = ?",
        )
          .bind(after, forRequest, lina.id)
          .run();

      // A cursor kept under an earlier request is not this one's: page one is read.
      await setCursor("authorized_gone", asked - 1);
      await retryAgentAccessRemovals(env);
      expect(authorizedApps.get(lina.id)).toEqual([]);
      expect(await owed(lina.id)).toBeNull();

      // A cursor WorkOS no longer knows: the attempt fails and drops it; the next reads page one.
      authorize(lina.id, "conn_app_again");
      const again = await owedSinceTenMinutes(lina);
      await setCursor("authorized_gone", again);
      await retryAgentAccessRemovals(env);
      expect(authorizedApps.get(lina.id)).toEqual(["conn_app_again"]);
      expect(await cursorOf(lina.id)).toEqual({ list_after: null, list_after_for: again });
      await dueNow(lina.id);
      await retryAgentAccessRemovals(env);
      expect(authorizedApps.get(lina.id)).toEqual([]);
      expect(await owed(lina.id)).toBeNull();

      // A repeat sign-out while a cursor is kept restarts the row without it.
      authorize(lina.id, "conn_app_third");
      const third = await owedSinceTenMinutes(lina);
      await setCursor("authorized_somewhere", third);
      workosOutage.calls = 1_000;
      await signOutEverywhere(await signedIn(lina));
      expect(await cursorOf(lina.id)).toEqual({ list_after: null, list_after_for: null });
    } finally {
      workosOutage.calls = 0;
      logged.mockRestore();
    }
  });

  test("a removal still failing a day after it was asked for is given up with a log line", async () => {
    const lina = user(uniqueEmail("stuck"));
    const who = await signedIn(lina);
    authorize(lina.id, "conn_app_a");
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      workosOutage.calls = 1_000;
      await signOutEverywhere(who);
      await env.DB.prepare(
        "UPDATE workos_access_removals SET requested_at = ?, next_attempt_at = 0 WHERE workos_user_id = ?",
      )
        .bind(Date.now() - 24 * 60 * 60_000 - 1, lina.id)
        .run();
      await retryAgentAccessRemovals(env);
      expect(await owed(lina.id)).toBeNull();
      expect(
        logged.mock.calls.some((args) =>
          String(args[0]).startsWith(`GAVE UP workos access removal for ${lina.id}`),
        ),
      ).toBe(true);
    } finally {
      workosOutage.calls = 0;
      logged.mockRestore();
    }
  });

  describe("sign-out ends the sign-in at AuthKit", () => {
    /** The AuthKit session ids WorkOS holds for this user, oldest first. */
    const sids = (userId: string) => (authkitSessions.get(userId) ?? []).map((s) => s.id);
    const logoutOf = (sid: string, returnTo = `${ORIGIN}/`) =>
      `https://workos.test/user_management/sessions/logout?session_id=${sid}&return_to=${encodeURIComponent(returnTo)}`;
    const cleared = (res: Response) =>
      res.headers.getSetCookie().some((c) => /^__Host-onlay\.session=;.*Max-Age=0/.test(c));

    test("sign out ends this session and sends the browser to AuthKit's logout for its own sign-in", async () => {
      const lina = user(uniqueEmail("leaves"));
      const who = await signedIn(lina);
      const other = await signedIn(lina);
      const [mine, theirs] = sids(lina.id);
      const before = sessionsLog.length;
      const out = await webWrite(who, "POST", "/auth/logout");
      expect(out.status).toBe(200);
      expect(out.res.headers.get("Cache-Control")).toBe("no-store");
      expect(cleared(out.res)).toBe(true);
      expect(await out.res.json()).toEqual({ signOutUrl: logoutOf(mine ?? "") });
      expect((await call(who, "GET", "/api/me")).status).toBe(401);
      // Only this browser: the other session, at onlay and at AuthKit, is untouched.
      expect((await call(other, "GET", "/api/me")).status).toBe(200);
      await out.after();
      expect(sessionsLog.length).toBe(before);
      expect(sids(lina.id)).toEqual([mine, theirs]);
    });

    test("on two origins it returns to the public site's home page, from the service only", async () => {
      const lina = user(uniqueEmail("two-origins"));
      const who = await signedIn(lina);
      const SERVICE = "https://app.onlay.dev";
      const two = { ...env, PUBLIC_ORIGIN: SERVICE, SITE_ORIGIN: "https://onlay.dev" };
      const res = await handle(
        new Request(`${SERVICE}/auth/logout`, {
          method: "POST",
          headers: { ...webHeaders(who, "POST"), Origin: SERVICE },
        }),
        two,
      );
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({
        signOutUrl: logoutOf(sids(lina.id)[0] ?? "", "https://onlay.dev/"),
      });
    });

    test("a session from before AuthKit session ids, or from an exchange naming none, still signs out", async () => {
      const lina = user(uniqueEmail("older"));
      const who = await signedIn(lina);
      await env.DB.prepare("UPDATE sessions SET workos_session_id = NULL WHERE person_id = ?")
        .bind(who.person.id)
        .run();
      const out = await webWrite(who, "POST", "/auth/logout");
      expect(out.status).toBe(204);
      expect(cleared(out.res)).toBe(true);
      expect((await call(who, "GET", "/api/me")).status).toBe(401);

      const plain = user(uniqueEmail("no-sid"));
      noSid.add(plain.id);
      const unnamed = await signedIn(plain);
      const gone = await webWrite(unnamed, "POST", "/auth/logout");
      expect(gone.status).toBe(204);
      expect((await call(unnamed, "GET", "/api/me")).status).toBe(401);
    });

    test("the extension's sign-out revokes its token and names no AuthKit logout", async () => {
      const who = await devSignIn();
      const res = await call(who, "POST", "/auth/logout", undefined, "extension");
      expect(res.status).toBe(204);
      expect((await call(who, "GET", "/api/me", undefined, "extension")).status).toBe(401);
      expect((await call(who, "GET", "/api/me")).status).toBe(200);
    });

    test("a cross-site post, or a stale tab of someone else, neither signs out nor learns the logout", async () => {
      const lina = user(uniqueEmail("guarded"));
      const who = await signedIn(lina);
      for (const extra of [
        { "Sec-Fetch-Site": "cross-site", Origin: "https://evil.example" },
        { Origin: "https://evil.example" },
        { "Onlay-CSRF": "" },
      ]) {
        const out = await webWrite(who, "POST", "/auth/logout", undefined, extra);
        expect(out.status).toBe(204);
        expect(await out.res.text()).toBe("");
        expect(out.res.headers.getSetCookie()).toEqual([]);
      }
      const stale = await webWrite(who, "POST", "/auth/logout", undefined, {
        "Onlay-Person": "p_someoneelseentirely",
      });
      expect(stale.status).toBe(401);
      expect(await stale.res.text()).not.toContain("logout");
      const everywhere = await webWrite(who, "POST", "/auth/logout-everywhere", undefined, {
        "Onlay-Person": "p_someoneelseentirely",
      });
      expect(everywhere.status).toBe(401);
      expect((await call(who, "GET", "/api/me")).status).toBe(200);
      expect(sids(lina.id)).toHaveLength(1);
    });

    test("sign out everywhere revokes every AuthKit session of the person; this browser ends its own", async () => {
      const lina = user(uniqueEmail("everywhere"));
      const who = await signedIn(lina);
      await signedIn(lina);
      await signedIn(lina);
      const bystander = user(uniqueEmail("bystander-session"));
      await signedIn(bystander);
      const [mine, ...others] = sids(lina.id);
      const out = await webWrite(who, "POST", "/auth/logout-everywhere");
      expect(out.status).toBe(200);
      expect(cleared(out.res)).toBe(true);
      expect(await out.res.json()).toEqual({ signOutUrl: logoutOf(mine ?? "") });
      await out.after();
      // The others are revoked through the API; this browser's own is left to its logout.
      expect(sids(lina.id)).toEqual([mine]);
      for (const sid of others) {
        expect(sessionsLog).toContain(`POST /user_management/sessions/revoke ${sid}`);
      }
      expect(sessionsLog).not.toContain(`POST /user_management/sessions/revoke ${mine}`);
      expect(sids(bystander.id)).toHaveLength(1);
      expect(await owed(lina.id)).toBeNull();
    });

    test("with the session calls failing, the retry revokes them all, sparing only a later sign-in", async () => {
      const lina = user(uniqueEmail("sessions-down"));
      const who = await signedIn(lina);
      await signedIn(lina);
      const logged = vi.spyOn(console, "error").mockImplementation(() => {});
      try {
        sessionsOutage.calls = 1_000;
        await signOutEverywhere(who);
        expect((await call(who, "GET", "/api/me")).status).toBe(401);
        expect(sids(lina.id)).toHaveLength(2);
        expect((await owed(lina.id))?.attempts).toBe(1);

        // Back up; asked for ten minutes ago, and Lina has signed in again since.
        sessionsOutage.calls = 0;
        await env.DB.prepare(
          "UPDATE workos_access_removals SET requested_at = ?, next_attempt_at = 0 WHERE workos_user_id = ?",
        )
          .bind(Date.now() - 10 * 60_000, lina.id)
          .run();
        const earlier = new Date(Date.now() - 20 * 60_000).toISOString();
        for (const session of authkitSessions.get(lina.id) ?? []) session.created_at = earlier;
        const known = sids(lina.id);
        await signedIn(lina);
        const fresh = sids(lina.id).at(-1);
        await retryAgentAccessRemovals(env);
        // The retry spares no session the sign-out knew of, this browser's own
        // included; a later sign-in's is spared.
        for (const sid of known) expect(sids(lina.id)).not.toContain(sid);
        expect(sids(lina.id)).toContain(fresh);
        expect(await owed(lina.id)).toBeNull();
      } finally {
        sessionsOutage.calls = 0;
        logged.mockRestore();
      }
    });

    test("a session listing that eats its deadline still lets the applications go, and the rest stays owed", async () => {
      const lina = user(uniqueEmail("slow-sessions"));
      const who = await signedIn(lina);
      await signedIn(lina);
      authorize(lina.id, "conn_app_claude");
      const logged = vi.spyOn(console, "error").mockImplementation(() => {});
      let release: () => void = () => {};
      sessionsOutage.hold = new Promise<void>((r) => {
        release = r;
      });
      try {
        await signOutEverywhere(who);
        // The applications went, on their own deadline.
        expect(authorizedApps.get(lina.id)).toEqual([]);
        // The sessions did not: the row stays owed.
        expect(sids(lina.id)).toHaveLength(2);
        expect((await owed(lina.id))?.attempts).toBe(1);
        // WorkOS answers again: the retry revokes them and the row is done.
        sessionsOutage.hold = null;
        release();
        await env.DB.prepare(
          "UPDATE workos_access_removals SET next_attempt_at = 0 WHERE workos_user_id = ?",
        )
          .bind(lina.id)
          .run();
        await retryAgentAccessRemovals(env);
        expect(sids(lina.id)).toEqual([]);
        expect(await owed(lina.id)).toBeNull();
      } finally {
        sessionsOutage.hold = null;
        release();
        logged.mockRestore();
      }
    });

    test("a 404 on a later page of applications removes what earlier pages listed and stays owed", async () => {
      const lina = user(uniqueEmail("later-404"));
      const who = await signedIn(lina);
      const many = Array.from({ length: 150 }, (_, i) => `conn_app_${i}`);
      authorize(lina.id, ...many);
      const logged = vi.spyOn(console, "error").mockImplementation(() => {});
      workosOutage.laterPages404 = true;
      try {
        await signOutEverywhere(who);
        // The first page's hundred went; the rest is still owed.
        expect(authorizedApps.get(lina.id)).toHaveLength(50);
        expect((await owed(lina.id))?.attempts).toBe(1);
      } finally {
        workosOutage.laterPages404 = false;
        logged.mockRestore();
      }
    });

    test("the cron does not take a new removal while the inline try is still running", async () => {
      const lina = user(uniqueEmail("cron-wait"));
      const who = await signedIn(lina);
      await signedIn(lina);
      let release: () => void = () => {};
      sessionsOutage.hold = new Promise<void>((r) => {
        release = r;
      });
      try {
        const out = await webWrite(who, "POST", "/auth/logout-everywhere");
        const row = await owed(lina.id);
        expect(row?.next_attempt_at).toBeGreaterThanOrEqual(Date.now() + 25_000);
        const before = sessionsLog.length;
        // The cron runs now: the row is not due, so nothing is revoked under the inline try.
        await retryAgentAccessRemovals(env);
        expect(sessionsLog.slice(before).some((l) => l.startsWith("POST"))).toBe(false);
        sessionsOutage.hold = null;
        release();
        await out.after();
      } finally {
        sessionsOutage.hold = null;
        release();
      }
    });

    test("account deletion revokes every AuthKit session too", async () => {
      const lina = user(uniqueEmail("deleting"));
      const who = await signedIn(lina);
      await signedIn(lina);
      const gone = await webWrite(who, "DELETE", "/api/me", { confirm: who.person.email });
      expect(gone.status).toBe(204);
      await gone.after();
      expect(sids(lina.id)).toEqual([]);
    });
  });
});
