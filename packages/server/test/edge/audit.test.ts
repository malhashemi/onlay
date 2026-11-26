// The security audit's edge items: identity kept in step with WorkOS (S3),
// extension enrolment needing a browser session (S4), the dev stub only on
// this machine (S5), bounded bodies and fan-out (S6), and logout and the dev
// form's return path (S8).
import { env } from "cloudflare:workers";
import { describe, expect, test } from "vitest";
import { pkceChallenge } from "../../src/directory/crypto";
import { handle } from "../../src/worker";
import {
  call,
  devSignIn,
  edge,
  envWith,
  errorOf,
  ORIGIN,
  personalSpaceOf,
  seedWorkspace,
  sessionCookieOf,
  setSpace,
  uniqueEmail,
  type Who,
} from "../support/client";
import "../support/edge-worker";
import { codeFor, type FakeUser } from "../support/fake-workos";

const EXT = "abcdefghijklmnopabcdefghijklmnop";
let ip = 0;
const freshIp = () => `198.51.100.${++ip}`;

function production(path: string, init: RequestInit = {}): Promise<Response> {
  return handle(new Request(`${ORIGIN}${path}`, init), envWith(undefined));
}

async function webSignIn(user: FakeUser): Promise<Response> {
  const login = await production("/auth/login?return_to=%2Fapp%2F", {
    headers: { "CF-Connecting-IP": freshIp() },
  });
  const state = new URL(login.headers.get("Location") ?? "").searchParams.get("state") ?? "";
  const stateCookie = (login.headers.get("Set-Cookie") ?? "").split(";")[0] ?? "";
  return production(`/auth/callback?code=${codeFor(user)}&state=${encodeURIComponent(state)}`, {
    headers: { Cookie: stateCookie },
  });
}

async function spacesSeenBy(cookie: string): Promise<string[]> {
  const res = await production("/api/me", {
    headers: { Cookie: cookie, "Sec-Fetch-Site": "same-origin" },
  });
  return ((await res.json()) as { spaces: { id: string }[] }).spaces.map((s) => s.id);
}

const IID = "6f0d1b2a-3c4d-4e5f-8a9b-0c1d2e3f4a5b";

describe("a changed WorkOS email (S3)", () => {
  test("the stored email follows it; shares follow the current email", async () => {
    const oldEmail = uniqueEmail("old");
    const newEmail = uniqueEmail("new");
    const owner1 = await devSignIn();
    const owner2 = await devSignIn();
    const s1 = await personalSpaceOf(owner1);
    const s2 = await personalSpaceOf(owner2);
    expect(
      (
        await call(owner1, "POST", `/api/spaces/${s1}/interactions/${IID}/shares`, {
          email: oldEmail,
        })
      ).status,
    ).toBe(201);
    expect(
      (
        await call(owner2, "POST", `/api/spaces/${s2}/interactions/${IID}/shares`, {
          email: newEmail,
        })
      ).status,
    ).toBe(201);
    const user: FakeUser = {
      id: `user_${crypto.randomUUID()}`,
      email: oldEmail,
      email_verified: true,
    };
    const first = await webSignIn(user);
    expect(first.status).toBe(302);
    const before = await spacesSeenBy(sessionCookieOf(first));
    expect(before).toContain(s1);
    expect(before).not.toContain(s2);
    const second = await webSignIn({ ...user, email: newEmail });
    expect(second.status).toBe(302);
    const after = await spacesSeenBy(sessionCookieOf(second));
    expect(after).toContain(s2);
    expect(after).not.toContain(s1);
    const row = await env.DB.prepare(
      "SELECT email, verified_at FROM people WHERE workos_user_id = ?",
    )
      .bind(user.id)
      .first<{ email: string; verified_at: number }>();
    expect(row?.email).toBe(newEmail);
    expect(row?.verified_at).toBeGreaterThan(0);
  });

  test("an email another live person holds refuses the sign-in and changes nothing", async () => {
    const taken = await devSignIn();
    const email = uniqueEmail("mine");
    const user: FakeUser = { id: `user_${crypto.randomUUID()}`, email, email_verified: true };
    expect((await webSignIn(user)).status).toBe(302);
    const refused = await webSignIn({ ...user, email: taken.person.email });
    expect(refused.status).toBe(409);
    expect(await refused.text()).toContain("That email already belongs to another Onlay account.");
    const row = await env.DB.prepare("SELECT email FROM people WHERE workos_user_id = ?")
      .bind(user.id)
      .first<string>("email");
    expect(row).toBe(email);
  });
});

function verifier(): string {
  return btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(32))))
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/, "");
}

describe("enrolling an extension needs a browser session (S4)", () => {
  test("a Bearer token alone is sent through sign-in like a visitor", async () => {
    const who = await devSignIn();
    const res = await edge(
      `/auth/extension?ext=${EXT}&challenge=${await pkceChallenge(verifier())}&state=s`,
      { headers: { Authorization: `Bearer ${who.token}`, "Sec-Fetch-Mode": "navigate" } },
    );
    expect(res.status).toBe(302);
    expect(new URL(res.headers.get("Location") ?? "", ORIGIN).pathname).toBe("/auth/login");
  });

  test("a code whose issuing session has ended is refused as sign_in_required", async () => {
    const who: Who = await devSignIn();
    const v = verifier();
    const page = await edge(
      `/auth/extension?ext=${EXT}&challenge=${await pkceChallenge(v)}&state=nonce-1`,
      { headers: { Cookie: who.cookie, "Sec-Fetch-Mode": "navigate", "Sec-Fetch-Site": "none" } },
    );
    const code = /"code":"([A-Za-z0-9_-]+)"/.exec(await page.text())?.[1] ?? "";
    expect(code).not.toBe("");
    expect((await call(who, "POST", "/auth/logout")).status).toBe(204);
    const res = await edge("/auth/extension/token", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ code, verifier: v }),
    });
    expect(await errorOf(res)).toMatchObject({ status: 401, code: "sign_in_required" });
  });
});

describe("the dev stub only on this machine (S5)", () => {
  const stub = (origin: string, host: string) =>
    handle(
      new Request(`${host}/auth/dev/session`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: uniqueEmail("stub") }),
      }),
      { ...env, PUBLIC_ORIGIN: origin },
    );

  test("a public PUBLIC_ORIGIN refuses it, on the web and on MCP", async () => {
    expect((await stub("https://app.onlay.dev", "https://app.onlay.dev")).status).toBe(404);
    const mcp = await handle(
      new Request("https://app.onlay.dev/mcp", {
        method: "POST",
        headers: {
          Authorization: `Bearer dev:${uniqueEmail("mcp")}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "ping" }),
      }),
      { ...env, PUBLIC_ORIGIN: "https://app.onlay.dev" },
    );
    expect(mcp.status).toBe(401);
  });

  test("a loopback origin with a request for another host refuses it", async () => {
    expect((await stub("http://localhost:8787", "http://evil.test")).status).toBe(404);
    expect((await stub("http://localhost:8787", "http://localhost:8787")).status).toBe(200);
  });
});

describe("bounded bodies and fan-out (S6)", () => {
  test("an edge body over 64 KiB is refused before it is parsed", async () => {
    const who = await devSignIn();
    const res = await call(who, "POST", "/api/workspaces", { name: "x".repeat(70_000) });
    expect(await errorOf(res)).toMatchObject({ status: 400, code: "invalid" });
    const token = await edge("/auth/extension/token", {
      method: "POST",
      headers: { "Content-Type": "application/json", "Content-Length": "999999" },
      body: "{}",
    });
    expect(token.status).toBe(400);
  });

  test("a space slower than the deadline drops out of the inbox; the rest answer", async () => {
    const who = await devSignIn();
    const other = await devSignIn();
    const fast = await seedWorkspace([other], [who]);
    const slow = await seedWorkspace([other], [who]);
    const row = (spaceId: string) => ({
      interactionId: crypto.randomUUID(),
      kind: "comment",
      state: "open",
      anchorLabel: spaceId,
      text: spaceId,
      fromActorId: other.person.id,
      waitingOnIds: [who.person.id],
      ts: 1,
    });
    for (const ws of [fast, slow]) {
      await setSpace(ws.id, "/__test/attention", {
        needsYou: [row(ws.id)],
        waiting: [],
        recent: [],
      });
    }
    await setSpace(slow.id, "/__test/slow", { ms: 6_000 });
    const started = Date.now();
    const res = await call(who, "GET", "/api/inbox");
    expect(Date.now() - started).toBeLessThan(5_900);
    const ids = ((await res.json()) as { needsYou: { spaceId: string }[] }).needsYou.map(
      (r) => r.spaceId,
    );
    expect(ids).toContain(fast.id);
    expect(ids).not.toContain(slow.id);
  });
});

describe("an unexpected failure (the error table)", () => {
  test("answers 503 with code unavailable", async () => {
    const who = await devSignIn();
    const broken = { ...env, DB: undefined as unknown as D1Database };
    const res = await handle(
      new Request(`${ORIGIN}/api/me`, { headers: { Authorization: `Bearer ${who.token}` } }),
      broken,
    );
    expect(await errorOf(res)).toMatchObject({ status: 503, code: "unavailable" });
  });
});

describe("logout and the dev form's return path (S8)", () => {
  test("a cross-site logout neither ends the session nor clears the cookie", async () => {
    const who = await devSignIn();
    const res = await edge("/auth/logout", {
      method: "POST",
      headers: { Cookie: who.cookie, "Sec-Fetch-Site": "cross-site", Origin: "https://evil.test" },
    });
    expect(res.status).toBe(204);
    expect(res.headers.get("Set-Cookie")).toBeNull();
    expect((await call(who, "GET", "/api/me")).status).toBe(200);
  });

  test("the dev form validates the normalised return path", async () => {
    const res = await edge("/auth/dev/session", {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        "CF-Connecting-IP": freshIp(),
      },
      body: new URLSearchParams({
        email: uniqueEmail("form"),
        return_to: "/.//evil.test/x",
      }).toString(),
    });
    expect(res.status).toBe(303);
    expect(res.headers.get("Location")).toBe("/app/");
  });
});
