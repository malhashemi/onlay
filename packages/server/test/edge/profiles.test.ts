// People's names and pictures at the edge: the name a sign-in brings (taken
// unless the person set their own), Onlay's own copy of the provider's
// picture and the rules its address is held to, the person's own upload and
// choice, and what the spaces are told.
import { env } from "cloudflare:workers";
import type { MeResponse } from "@onlay/protocol";
import { afterEach, describe, expect, test } from "vitest";
import { personById } from "../../src/directory/people";
import {
  choosePicture,
  FETCH_DEADLINE_MS,
  fetchProviderPicture,
} from "../../src/directory/pictures";
import { handle } from "../../src/worker";
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
import { codeFor, exchangeGate, type FakeUser, otherHosts } from "../support/fake-workos";
import { GIF, jpegOf, pngOf, SVG, webpOf } from "../support/images";

const CDN = "https://workoscdn.com";

afterEach(() => {
  otherHosts.clear();
});

function production(path: string, init: RequestInit = {}): Promise<Response> {
  return handle(new Request(`${ORIGIN}${path}`, init), envWith(undefined));
}

let ip = 0;
async function webSignIn(user: FakeUser): Promise<Response> {
  const login = await production("/auth/login?return_to=%2Fapp%2F", {
    headers: { "CF-Connecting-IP": `198.51.100.${++ip % 250}` },
  });
  const state = new URL(login.headers.get("Location") ?? "").searchParams.get("state") ?? "";
  const stateCookie = (login.headers.get("Set-Cookie") ?? "").split(";")[0] ?? "";
  return production(`/auth/callback?code=${codeFor(user)}&state=${encodeURIComponent(state)}`, {
    headers: { Cookie: stateCookie },
  });
}

async function me(cookie: string): Promise<MeResponse> {
  const res = await call({ cookie } as Who, "GET", "/api/me");
  expect(res.status).toBe(200);
  return (await res.json()) as MeResponse;
}

/** A picture host that serves `bytes` at every path and counts its requests. */
function servePictures(bytes: Uint8Array, type = "image/png") {
  const served: string[] = [];
  otherHosts.set(CDN, async (request) => {
    served.push(new URL(request.url).pathname);
    return new Response(bytes, { headers: { "Content-Type": type } });
  });
  return served;
}

function fakeUser(email: string, over: Partial<FakeUser> = {}): FakeUser {
  return { id: `user_${crypto.randomUUID()}`, email, email_verified: true, ...over };
}

/* ── the provider's picture: the address is hostile input ─────────── */

describe("fetching a provider's picture", () => {
  const answer =
    (res: () => Response): typeof fetch =>
    async () =>
      res();

  test("PNG, JPEG and WebP are taken by their bytes", async () => {
    for (const [bytes, type] of [
      [pngOf(96, 96), "image/png"],
      [jpegOf(96, 96), "image/jpeg"],
      [webpOf(96, 96), "image/webp"],
    ] as const) {
      // The declared type is never trusted: a wrong one changes nothing.
      const got = await fetchProviderPicture(
        `${CDN}/images/v1/a`,
        answer(() => new Response(bytes, { headers: { "Content-Type": "text/plain" } })),
      );
      expect(got?.type).toBe(type);
      expect(got?.bytes).toEqual(bytes);
    }
  });

  test("SVG, GIF, HTML and an image over 1024 px a side are refused", async () => {
    const html = new TextEncoder().encode("<!doctype html><script>1</script>");
    for (const bytes of [SVG, GIF, html, pngOf(2048, 96), pngOf(0, 0), new Uint8Array()]) {
      const got = await fetchProviderPicture(
        `${CDN}/images/v1/a`,
        answer(() => new Response(bytes, { headers: { "Content-Type": "image/png" } })),
      );
      expect(got).toBeNull();
    }
  });

  test("a body over 64 KB is refused, declared or not", async () => {
    const big = pngOf(96, 96, 65_537);
    expect(
      await fetchProviderPicture(
        `${CDN}/a`,
        answer(() => new Response(big)),
      ),
    ).toBeNull();
    const streamed = () =>
      new Response(
        new ReadableStream({
          pull(controller) {
            controller.enqueue(new Uint8Array(16_384));
          },
        }),
      );
    expect(await fetchProviderPicture(`${CDN}/a`, answer(streamed))).toBeNull();
  });

  test("only https on an allowed host, its default port, no credentials, is fetched at all", async () => {
    let calls = 0;
    const counting: typeof fetch = async () => {
      calls += 1;
      return new Response(pngOf(10, 10));
    };
    for (const url of [
      "http://workoscdn.com/a",
      "https://evil.test/a",
      "https://workoscdn.com.evil.test/a",
      "https://lh3.googleusercontent.com/a",
      "https://workoscdn.com:8443/a",
      "https://user:pass@workoscdn.com/a",
      "javascript:alert(1)",
      "data:image/png;base64,iVBORw0KGgo=",
      "not a url",
    ]) {
      expect(await fetchProviderPicture(url, counting)).toBeNull();
    }
    expect(calls).toBe(0);
  });

  test("a redirect is followed only to an allowed address, at most twice", async () => {
    const hops = (locations: string[]): typeof fetch => {
      let at = 0;
      return async (input) => {
        const next = locations[at++];
        if (next === undefined) return new Response(pngOf(10, 10));
        expect(String(input)).toMatch(/^https:\/\/workoscdn\.com\//);
        return new Response(null, { status: 302, headers: { Location: next } });
      };
    };
    expect(await fetchProviderPicture(`${CDN}/a`, hops(["/b"]))).not.toBeNull();
    expect(await fetchProviderPicture(`${CDN}/a`, hops(["/b", `${CDN}/c`]))).not.toBeNull();
    expect(await fetchProviderPicture(`${CDN}/a`, hops(["/b", "/c", "/d"]))).toBeNull();
    expect(await fetchProviderPicture(`${CDN}/a`, hops(["https://evil.test/x"]))).toBeNull();
    expect(await fetchProviderPicture(`${CDN}/a`, hops(["http://workoscdn.com/x"]))).toBeNull();
    expect(await fetchProviderPicture(`${CDN}/a`, hops([""]))).toBeNull();
  });

  test("a host that does not answer in time gives nothing, within the deadline", async () => {
    const hanging: typeof fetch = (_input, init) =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(init.signal?.reason));
      });
    const started = Date.now();
    expect(await fetchProviderPicture(`${CDN}/a`, hanging, 150)).toBeNull();
    expect(Date.now() - started).toBeLessThan(FETCH_DEADLINE_MS);
    // A body that stalls after its headers is cut off by the same deadline.
    const stalling: typeof fetch = async (_input, init) =>
      new Response(
        new ReadableStream({
          start(controller) {
            controller.enqueue(pngOf(10, 10).slice(0, 8));
            init?.signal?.addEventListener("abort", () => controller.error(init.signal?.reason));
          },
        }),
      );
    expect(await fetchProviderPicture(`${CDN}/a`, stalling, 150)).toBeNull();
    // An error status gives nothing.
    expect(
      await fetchProviderPicture(
        `${CDN}/a`,
        answer(() => new Response("no", { status: 404 })),
      ),
    ).toBeNull();
  });
});

/* ── names and pictures through a web sign-in ─────────────────────── */

describe("names from the sign-in provider", () => {
  test("the email's local part until a provider gives a name, then the provider's name", async () => {
    const email = uniqueEmail("amira");
    const user = fakeUser(email);
    // An email code: no name.
    const first = await webSignIn(user);
    expect(first.status).toBe(302);
    const before = await me(sessionCookieOf(first));
    expect(before.person.name).toBe(email.split("@")[0]);
    expect(before.profile).toEqual({
      nameSet: false,
      nameFromEmail: true,
      picture: "provider",
      providerPicture: false,
    });

    // Google, later: the name it gives is taken, with its initials.
    const google = await webSignIn({ ...user, first_name: "Amira", last_name: "Nasser" });
    const after = await me(sessionCookieOf(google));
    expect(after.person).toMatchObject({
      id: before.person.id,
      name: "Amira Nasser",
      initials: "AN",
    });

    // A sign-in without a name keeps the one there is.
    const plain = await webSignIn(user);
    expect((await me(sessionCookieOf(plain))).person.name).toBe("Amira Nasser");

    // The provider's name changes: taken again.
    const changed = await webSignIn({ ...user, first_name: "Amira", last_name: "N." });
    expect((await me(sessionCookieOf(changed))).person.name).toBe("Amira N.");
  });

  test("a name the person set is never overwritten by a sign-in", async () => {
    const user = fakeUser(uniqueEmail("omar"), { first_name: "Omar", last_name: "Faris" });
    const cookie = sessionCookieOf(await webSignIn(user));
    expect((await me(cookie)).person.name).toBe("Omar Faris");
    const renamed = await call({ cookie } as Who, "PATCH", "/api/me", { name: "Omar F." });
    expect(renamed.status).toBe(200);
    expect(((await renamed.json()) as MeResponse).profile?.nameSet).toBe(true);
    const again = await webSignIn({ ...user, first_name: "Omar", last_name: "Al-Faris" });
    const body = await me(sessionCookieOf(again));
    expect(body.person.name).toBe("Omar F.");
    expect(body.profile?.nameSet).toBe(true);
  });

  test("saving the name unchanged pins it; names are cleaned of bidi overrides and controls, wherever they come from", async () => {
    const user = fakeUser(uniqueEmail("pin"), { first_name: "Nour", last_name: "Saad" });
    const cookie = sessionCookieOf(await webSignIn(user));
    const who = { cookie } as Who;
    const pinned = await call(who, "PATCH", "/api/me", { name: "Nour Saad" });
    expect(((await pinned.json()) as MeResponse).profile?.nameSet).toBe(true);
    const later = await webSignIn({ ...user, first_name: "Nour", last_name: "S." });
    expect((await me(sessionCookieOf(later))).person.name).toBe("Nour Saad");
    // Their own: a right-to-left override and a control character go, spaces collapse.
    const own = await call(who, "PATCH", "/api/me", { name: "Ev\u202eil  \u0007Name" });
    expect(((await own.json()) as MeResponse).person.name).toBe("Evil Name");
    // A provider's, the same way.
    const other = fakeUser(uniqueEmail("bidi"), {
      first_name: "Ma\u2066x",
      last_name: "\u202dPayne\u0000",
    });
    expect((await me(sessionCookieOf(await webSignIn(other)))).person.name).toBe("Max Payne");
  });

  test("a provider name the wire can't carry is not taken, and the sign-in still works", async () => {
    const email = uniqueEmail("long");
    const user = fakeUser(email, { first_name: "  ", last_name: "\t" });
    const res = await webSignIn(user);
    expect(res.status).toBe(302);
    expect((await me(sessionCookieOf(res))).person.name).toBe(email.split("@")[0]);
    // Over 80 units: cut, at a code point.
    const long = await webSignIn({ ...user, first_name: "é".repeat(100) });
    const name = (await me(sessionCookieOf(long))).person.name;
    expect(name.length).toBeLessThanOrEqual(80);
    expect(name.startsWith("éé")).toBe(true);
  });
});

describe("the provider's picture, Onlay's copy", () => {
  test("fetched at sign-in, served from the service, not fetched again for the same address", async () => {
    const served = servePictures(pngOf(96, 96));
    const user = fakeUser(uniqueEmail("pic"), {
      first_name: "Pia",
      profile_picture_url: `${CDN}/images/v1/one`,
    });
    const cookie = sessionCookieOf(await webSignIn(user));
    const body = await me(cookie);
    expect(body.person.avatarUrl).toMatch(/^\/api\/me\/picture\/[a-z2-7]{16}$/);
    expect(body.profile).toEqual({
      nameSet: false,
      nameFromEmail: false,
      picture: "provider",
      providerPicture: true,
    });
    expect(served).toEqual(["/images/v1/one"]);

    const res = await call({ cookie } as Who, "GET", body.person.avatarUrl ?? "");
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toBe("image/png");
    expect(res.headers.get("X-Content-Type-Options")).toBe("nosniff");
    expect(res.headers.get("Cross-Origin-Resource-Policy")).toBe("same-origin");
    expect(res.headers.get("Content-Security-Policy")).toContain("sandbox");
    expect(res.headers.get("Cache-Control")).toMatch(/^private/);
    expect(new Uint8Array(await res.arrayBuffer())).toEqual(pngOf(96, 96));

    // The same address: nothing fetched, the same copy.
    const again = await me(sessionCookieOf(await webSignIn(user)));
    expect(served).toHaveLength(1);
    expect(again.person.avatarUrl).toBe(body.person.avatarUrl);

    // A new address that fails keeps the copy there is.
    otherHosts.set(CDN, async () => new Response("gone", { status: 500 }));
    const failed = await me(
      sessionCookieOf(await webSignIn({ ...user, profile_picture_url: `${CDN}/images/v1/two` })),
    );
    expect(failed.person.avatarUrl).toBe(body.person.avatarUrl);

    // A new address that works replaces it under a new key.
    servePictures(jpegOf(64, 64));
    const replaced = await me(
      sessionCookieOf(await webSignIn({ ...user, profile_picture_url: `${CDN}/images/v1/three` })),
    );
    expect(replaced.person.avatarUrl).not.toBe(body.person.avatarUrl);
    expect((await call({ cookie } as Who, "GET", body.person.avatarUrl ?? "")).status).toBe(404);
  });

  test("an address on another host leaves the initials", async () => {
    let asked = 0;
    otherHosts.set("https://lh3.googleusercontent.com", async () => {
      asked += 1;
      return new Response(pngOf(10, 10));
    });
    const user = fakeUser(uniqueEmail("other"), {
      profile_picture_url: "https://lh3.googleusercontent.com/a/x=s96-c",
    });
    const body = await me(sessionCookieOf(await webSignIn(user)));
    expect(body.person.avatarUrl).toBeUndefined();
    expect(body.profile?.providerPicture).toBe(false);
    expect(asked).toBe(0);
  });
});

describe("a sign-in crossing a sign out everywhere", () => {
  test("a callback still finishing when sign out everywhere commits issues no session", async () => {
    const user = fakeUser(uniqueEmail("crossing"), { first_name: "Cora" });
    const first = sessionCookieOf(await webSignIn(user));
    // The next sign-in waits on its picture while the person signs out everywhere elsewhere.
    let release: () => void = () => {};
    const held = new Promise<void>((r) => {
      release = r;
    });
    let reached: () => void = () => {};
    const waiting = new Promise<void>((r) => {
      reached = r;
    });
    otherHosts.set(CDN, async () => {
      reached();
      await held;
      return new Response(pngOf(10, 10));
    });
    const second = webSignIn({ ...user, profile_picture_url: `${CDN}/images/v1/slow` });
    await waiting;
    const out = await call({ cookie: first } as Who, "POST", "/auth/logout-everywhere");
    expect(out.status === 200 || out.status === 204).toBe(true);
    release();
    const res = await second;
    expect(res.status).toBe(409);
    expect(res.headers.getSetCookie().some((c) => c.startsWith("__Host-onlay.session="))).toBe(
      false,
    );
    expect(await res.text()).toContain("You signed out everywhere before this sign-in finished.");
    const live = await env.DB.prepare(
      "SELECT count(*) AS n FROM sessions s JOIN people p ON p.id = s.person_id WHERE p.email = ?",
    )
      .bind(user.email)
      .first<number>("n");
    expect(live).toBe(0);
    // Signing in again works (an attempt begun after the revocation's second).
    await new Promise((r) => setTimeout(r, 1_100));
    expect((await webSignIn(user)).status).toBe(302);
  });
});

describe("a code exchange crossing a sign out everywhere", () => {
  test("a revocation that lands while the code is being exchanged cancels the sign-in", async () => {
    const user = fakeUser(uniqueEmail("exchange"), { first_name: "Ema" });
    const first = sessionCookieOf(await webSignIn(user));
    let release: () => void = () => {};
    exchangeGate.hold = new Promise<void>((r) => {
      release = r;
    });
    const reached = new Promise<void>((r) => {
      exchangeGate.reached = r;
    });
    try {
      // The attempt starts a second before; the exchange is slow.
      const second = webSignIn(user);
      await reached;
      await new Promise((r) => setTimeout(r, 1_100));
      const out = await call({ cookie: first } as Who, "POST", "/auth/logout-everywhere");
      expect([200, 204]).toContain(out.status);
      exchangeGate.hold = null;
      release();
      const res = await second;
      expect(res.status).toBe(409);
      expect(res.headers.getSetCookie().some((c) => c.startsWith("__Host-onlay.session="))).toBe(
        false,
      );
    } finally {
      exchangeGate.hold = null;
      release();
    }
    // A fresh attempt, begun after the revocation, signs in.
    await new Promise((r) => setTimeout(r, 1_100));
    expect((await webSignIn(user)).status).toBe(302);
  });
});

/* ── the person's own picture and choice ──────────────────────────── */

function putPicture(who: Who, bytes: BodyInit, headers: Record<string, string> = {}) {
  return edge("/api/me/picture", {
    method: "PUT",
    headers: { ...webHeaders(who, "PUT"), "Content-Type": "image/webp", ...headers },
    body: bytes,
  });
}

describe("Settings: the person's own picture", () => {
  test("upload, remove, and back to the provider's", async () => {
    servePictures(pngOf(96, 96));
    const user = fakeUser(uniqueEmail("own"), { profile_picture_url: `${CDN}/images/v1/p` });
    const cookie = sessionCookieOf(await webSignIn(user));
    const who = { cookie } as Who;
    const provider = (await me(cookie)).person.avatarUrl;
    expect(provider).toBeDefined();

    const up = await putPicture(who, webpOf(128, 128));
    expect(up.status).toBe(200);
    const own = (await up.json()) as MeResponse;
    expect(own.profile).toMatchObject({ picture: "own", providerPicture: true });
    expect(own.person.avatarUrl).not.toBe(provider);
    const got = await call(who, "GET", own.person.avatarUrl ?? "");
    expect(got.headers.get("Content-Type")).toBe("image/webp");

    // A sign-in never replaces the person's own choice.
    const after = await me(sessionCookieOf(await webSignIn(user)));
    expect(after.person.avatarUrl).toBe(own.person.avatarUrl);

    const none = await call(who, "PATCH", "/api/me", { picture: "none" });
    const noneBody = (await none.json()) as MeResponse;
    expect(noneBody.person.avatarUrl).toBeUndefined();
    expect(noneBody.profile?.picture).toBe("none");
    // The upload is forgotten.
    expect((await call(who, "GET", own.person.avatarUrl ?? "")).status).toBe(404);

    const back = await call(who, "PATCH", "/api/me", { picture: "provider" });
    expect(((await back.json()) as MeResponse).person.avatarUrl).toBe(provider);
  });

  test("a copy the person no longer shows is not_found under its old key; an unchanged one is a 304", async () => {
    servePictures(pngOf(96, 96));
    const user = fakeUser(uniqueEmail("hidden"), { profile_picture_url: `${CDN}/images/v1/h` });
    const cookie = sessionCookieOf(await webSignIn(user));
    const who = { cookie } as Who;
    const provider = (await me(cookie)).person.avatarUrl ?? "";
    const first = await call(who, "GET", provider);
    expect(first.status).toBe(200);
    expect(first.headers.get("Cache-Control")).toBe("private, no-cache");
    const etag = first.headers.get("ETag") ?? "";
    expect(etag).toBe(`"${provider.split("/").at(-1)}"`);
    // The browser asks again with its validator: a 304, no bytes.
    const again = await edge(provider, { headers: { ...webHeaders(who), "If-None-Match": etag } });
    expect(again.status).toBe(304);
    expect((await again.arrayBuffer()).byteLength).toBe(0);
    // Replaced by an upload: the provider's key is gone, though its copy is kept.
    await putPicture(who, webpOf(64, 64));
    expect((await call(who, "GET", provider)).status).toBe(404);
    // Back to the provider's, then initials: shown, then gone again.
    await call(who, "PATCH", "/api/me", { picture: "provider" });
    expect((await call(who, "GET", provider)).status).toBe(200);
    await call(who, "PATCH", "/api/me", { picture: "none" });
    const hidden = await edge(provider, { headers: { ...webHeaders(who), "If-None-Match": etag } });
    expect(hidden.status).toBe(404);
  });

  test("a provider picture still being fetched when the account is deleted writes nothing", async () => {
    const user = fakeUser(uniqueEmail("late"), { first_name: "Lee" });
    const cookie = sessionCookieOf(await webSignIn(user));
    const id = (await me(cookie)).person.id;
    let release: () => void = () => {};
    const held = new Promise<void>((r) => {
      release = r;
    });
    let reached: () => void = () => {};
    const waiting = new Promise<void>((r) => {
      reached = r;
    });
    otherHosts.set(CDN, async () => {
      reached();
      await held;
      return new Response(pngOf(10, 10));
    });
    const later = webSignIn({ ...user, profile_picture_url: `${CDN}/images/v1/late` });
    await waiting;
    const gone = await call({ cookie } as Who, "DELETE", "/api/me", { confirm: user.email });
    expect(gone.status).toBe(204);
    release();
    await later;
    const rows = await env.DB.prepare(
      "SELECT count(*) AS n FROM person_pictures WHERE person_id = ?",
    )
      .bind(id)
      .first<number>("n");
    expect(rows).toBe(0);
  });

  test("a picture choice that lands after the account was deleted changes nothing", async () => {
    const who = await devSignIn();
    const row = await personById(env.DB, who.person.id);
    expect(row).not.toBeNull();
    const gone = await call(who, "DELETE", "/api/me", { confirm: who.person.email });
    expect(gone.status).toBe(204);
    // The request that read the person before the deletion now writes.
    await expect(
      choosePicture(env, row as NonNullable<typeof row> & { email: string }, "none"),
    ).rejects.toMatchObject({ code: "not_found" });
    const after = await env.DB.prepare(
      "SELECT picture_choice, name, deleted_at FROM people WHERE id = ?",
    )
      .bind(who.person.id)
      .first<{ picture_choice: string | null; name: string; deleted_at: number | null }>();
    expect(after).toMatchObject({ picture_choice: null, name: "Deleted person" });
    expect(after?.deleted_at).not.toBeNull();
  });

  test("the bytes decide: SVG, GIF, HTML and a lie about the type are refused", async () => {
    const who = await devSignIn();
    for (const bytes of [SVG, GIF, new TextEncoder().encode("<html>"), pngOf(4096, 10)]) {
      const res = await putPicture(who, bytes, { "Content-Type": "image/png" });
      expect(res.status).toBe(400);
      expect(((await res.json()) as { error: { reason: string } }).error.reason).toBe(
        "not-a-picture",
      );
    }
    // A JPEG sent as WebP is stored as what it is.
    const ok = (await (await putPicture(who, jpegOf(40, 40))).json()) as MeResponse;
    const got = await call(who, "GET", ok.person.avatarUrl ?? "");
    expect(got.headers.get("Content-Type")).toBe("image/jpeg");
  });

  test("over 64 KB is refused before it is read, declared or streamed", async () => {
    const who = await devSignIn();
    const declared = await putPicture(who, pngOf(10, 10, 65_537));
    expect(declared.status).toBe(400);
    expect(((await declared.json()) as { error: { reason: string } }).error.reason).toBe(
      "too-large",
    );
    let pulled = 0;
    const stream = new ReadableStream({
      pull(controller) {
        pulled += 1;
        controller.enqueue(new Uint8Array(16_384));
        if (pulled > 64) controller.close();
      },
    });
    const streamed = await edge("/api/me/picture", {
      method: "PUT",
      headers: { ...webHeaders(who, "PUT"), "Content-Type": "image/png" },
      body: stream,
      // @ts-expect-error: workerd takes a streamed body with `duplex`
      duplex: "half",
    });
    expect(streamed.status).toBe(400);
    expect(pulled).toBeLessThan(64);
  });

  test("the write rules: no CSRF header or a foreign Origin is a visitor; the write limit counts it", async () => {
    const who = await devSignIn();
    const noCsrf = await edge("/api/me/picture", {
      method: "PUT",
      headers: { Cookie: who.cookie, "Sec-Fetch-Site": "same-origin", Origin: ORIGIN },
      body: pngOf(10, 10),
    });
    expect(noCsrf.status).toBe(401);
    const foreign = await putPicture(who, pngOf(10, 10), { Origin: "https://evil.test" });
    expect(foreign.status).toBe(401);
    // The extension's token may set it too.
    const asExtension = await edge("/api/me/picture", {
      method: "PUT",
      headers: { Authorization: `Bearer ${who.token}`, "Content-Type": "image/png" },
      body: pngOf(10, 10),
    });
    expect(asExtension.status).toBe(200);

    const window = Math.floor(Date.now() / 60_000) * 60_000;
    await env.DB.prepare(
      "INSERT INTO rate_counters (key, window_start, count) VALUES (?, ?, 120) ON CONFLICT (key) DO UPDATE SET window_start = excluded.window_start, count = 120",
    )
      .bind(`write:${who.person.id}`, window)
      .run();
    const limited = await putPicture(who, pngOf(10, 10));
    expect(limited.status).toBe(429);
  });

  test("another person's key, a malformed key, or a key of nothing: the same not_found", async () => {
    const a = await devSignIn();
    const b = await devSignIn();
    const mine = (await (await putPicture(a, pngOf(10, 10))).json()) as MeResponse;
    const key = (mine.person.avatarUrl ?? "").split("/").at(-1) ?? "";
    const answers = await Promise.all(
      [`/api/me/picture/${key}`, "/api/me/picture/aaaaaaaaaaaaaaaa", "/api/me/picture/..%2Fx"].map(
        async (path) => {
          const res = await call(b, "GET", path);
          return { status: res.status, body: await res.text() };
        },
      ),
    );
    expect(new Set(answers.map((a) => JSON.stringify(a))).size).toBe(1);
    expect(answers[0]?.status).toBe(404);
  });
});

/* ── what the spaces are told ─────────────────────────────────────── */

describe("the spaces hear of a new name or picture", () => {
  test("each space gets the person with their picture through it; only a member's carries the alias", async () => {
    const admin = await devSignIn();
    const member = await devSignIn(uniqueEmail("teammate"));
    const ws = await seedWorkspace([admin], [member]);
    const up = await putPicture(member, pngOf(32, 32));
    expect(up.status).toBe(200);
    const key = (((await up.json()) as MeResponse).person.avatarUrl ?? "").split("/").at(-1);

    const personCalls = (await spaceLog(ws.id)).filter((e) => e.path === "/internal/person");
    const last = JSON.parse(personCalls.at(-1)?.body ?? "{}") as {
      person?: { avatarUrl?: string; alias?: string };
    };
    expect(last.person?.avatarUrl).toBe(`/s/${ws.id}/people/${member.person.id}/picture/${key}`);
    expect(last.person?.alias).toBe(member.person.email.split("@")[0]);

    const personal = await personalSpaceOf(member);
    const own = (await spaceLog(personal)).filter((e) => e.path === "/internal/person").at(-1);
    expect(JSON.parse(own?.body ?? "{}").person.avatarUrl).toBe(
      `/s/${personal}/people/${member.person.id}/picture/${key}`,
    );

    // A rename too, in every space.
    await call(member, "PATCH", "/api/me", { name: "Tess Mate" });
    const renamed = (await spaceLog(ws.id)).filter((e) => e.path === "/internal/person").at(-1);
    expect(JSON.parse(renamed?.body ?? "{}").person.name).toBe("Tess Mate");
  });

  test("a guest's profile carries no alias", async () => {
    const owner = await devSignIn();
    const guest = await devSignIn(uniqueEmail("guest"));
    const space = await personalSpaceOf(owner);
    const shared = await call(
      owner,
      "POST",
      `/api/spaces/${space}/interactions/6f0d1b2a-3c4d-4e5f-8a9b-0c1d2e3f4a5b/shares`,
      { email: guest.person.email },
    );
    expect(shared.status).toBe(201);
    const toGuest = (await spaceLog(space))
      .filter((e) => e.path === "/internal/person")
      .map(
        (e) => JSON.parse(e.body) as { person?: { id: string; alias?: string; guest?: boolean } },
      )
      .filter((b) => b.person?.id === guest.person.id);
    expect(toGuest.length).toBeGreaterThan(0);
    for (const body of toGuest) expect(body.person?.alias).toBeUndefined();
  });
});
