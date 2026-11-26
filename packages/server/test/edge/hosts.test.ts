// Two origins, one Worker (src/edge/hosts.ts): the service at PUBLIC_ORIGIN
// answers everything that involves a credential or a person, the public site
// at SITE_ORIGIN only its pages, and neither reads the other's routes. With
// one origin (SITE_ORIGIN unset or equal) everything is served as before.
import { env } from "cloudflare:workers";
import { CSRF_HEADER } from "@onlay/protocol";
import { describe, expect, test } from "vitest";
import { canonicalOrigin } from "../../src/edge/hosts";
import { safeReturnTo } from "../../src/edge/http";
import { handle } from "../../src/worker";
import { devSignIn, errorOf, personalSpaceOf } from "../support/client";

const SERVICE = "https://app.onlay.dev";
const SITE = "https://onlay.dev";
const TWO = { ...env, PUBLIC_ORIGIN: SERVICE, SITE_ORIGIN: SITE };

function at(url: string, init: RequestInit = {}, on: typeof env = TWO) {
  return handle(new Request(url, { redirect: "manual", ...init }), on);
}

/** A browser navigation carrying `cookie`. */
function navigation(cookie?: string): RequestInit {
  return {
    headers: {
      "Sec-Fetch-Mode": "navigate",
      "Sec-Fetch-Site": "none",
      ...(cookie ? { Cookie: cookie } : {}),
    },
  };
}

function expectNoCookieSet(res: Response): void {
  expect(res.headers.getSetCookie()).toEqual([]);
}

async function expectNotFound(res: Response): Promise<void> {
  expectNoCookieSet(res);
  expect(await errorOf(res)).toMatchObject({ status: 404, code: "not_found" });
}

describe("the service host", () => {
  test("/ goes on to the web app, which it serves under its own origin's policy", async () => {
    const home = await at(`${SERVICE}/`, navigation());
    expect(home.status).toBe(302);
    expect(home.headers.get("Location")).toBe("/app/");
    expect((await at(`${SERVICE}/`, { method: "POST" })).status).toBe(405);

    const app = await at(`${SERVICE}/app/`, navigation());
    expect(app.status).toBe(200);
    expect(app.headers.get("Content-Security-Policy")).toContain(
      "connect-src 'self' wss://app.onlay.dev",
    );
    expect((await at(`${SERVICE}/healthz`)).status).toBe(200);
  });

  test("the public pages live on the site: one copy of each, reached by a redirect", async () => {
    for (const path of ["/install", "/privacy", "/download/onlay-extension.zip", "/install?x=1"]) {
      const res = await at(`${SERVICE}${path}`, navigation());
      expect(res.status, path).toBe(302);
      expect(res.headers.get("Location"), path).toBe(`${SITE}${path}`);
      expectNoCookieSet(res);
    }
    expect((await at(`${SERVICE}/install`, { method: "POST" })).status).toBe(405);
  });

  test("sign-in, its callback and MCP all name the service", async () => {
    const login = await at(`${SERVICE}/auth/login?return_to=%2Fapp%2F`, navigation());
    expect(login.status).toBe(302);
    const authorize = new URL(login.headers.get("Location") ?? "");
    expect(authorize.searchParams.get("redirect_uri")).toBe(`${SERVICE}/auth/callback`);

    const resource = await at(`${SERVICE}/.well-known/oauth-protected-resource`);
    expect(await resource.json()).toMatchObject({ resource: `${SERVICE}/mcp` });
    const nested = await at(`${SERVICE}/.well-known/oauth-protected-resource/mcp`);
    expect(await nested.json()).toMatchObject({ resource: `${SERVICE}/mcp` });

    const mcp = await at(`${SERVICE}/mcp`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "ping" }),
    });
    expect(mcp.status).toBe(401);
    expect(mcp.headers.get("WWW-Authenticate")).toContain(
      `resource_metadata="${SERVICE}/.well-known/oauth-protected-resource"`,
    );
  });

  test("the cookie counts only from the service itself, never from the site", async () => {
    const who = await devSignIn();
    const read = (headers: Record<string, string>) =>
      at(`${SERVICE}/api/me`, { headers: { Cookie: who.cookie, ...headers } });
    const own = await read({ "Sec-Fetch-Site": "same-origin", "Sec-Fetch-Mode": "cors" });
    expect(own.status).toBe(200);
    expect(await own.json()).toMatchObject({ siteOrigin: SITE });

    // The site is same-site with the service, so a Lax cookie rides along: the
    // fetch-metadata and Origin rules are what refuse it, as for any other site.
    const fromSite = await read({
      "Sec-Fetch-Site": "same-site",
      "Sec-Fetch-Mode": "cors",
      Origin: SITE,
    });
    expect(await errorOf(fromSite)).toMatchObject({ status: 401, code: "sign_in_required" });
    // And no CORS allowance names the site.
    expect(fromSite.headers.get("Access-Control-Allow-Origin")).toBeNull();
    const preflight = await at(`${SERVICE}/api/me`, {
      method: "OPTIONS",
      headers: { Origin: SITE, "Access-Control-Request-Method": "GET" },
    });
    expect(preflight.headers.get("Access-Control-Allow-Origin")).toBeNull();
    expect(preflight.headers.get("Access-Control-Allow-Credentials")).toBeNull();

    const write = (origin: string, site: string) =>
      at(`${SERVICE}/api/me`, {
        method: "PATCH",
        headers: {
          Cookie: who.cookie,
          "Sec-Fetch-Site": site,
          "Sec-Fetch-Mode": "cors",
          Origin: origin,
          [CSRF_HEADER]: "1",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ name: "Ada" }),
      });
    expect((await write(SITE, "same-site")).status).toBe(401);
    // Even a site page that lied about its fetch metadata names its own Origin.
    expect((await write(SITE, "same-origin")).status).toBe(401);
    expect((await write(SERVICE, "same-origin")).status).toBe(200);
  });

  test("a WebSocket upgrade with the cookie needs the service's Origin, not the site's", async () => {
    const who = await devSignIn();
    const spaceId = await personalSpaceOf(who);
    const upgrade = (origin: string) =>
      at(`${SERVICE}/s/${spaceId}/ws`, {
        headers: {
          Upgrade: "websocket",
          "Sec-WebSocket-Protocol": "onlay.v1",
          Cookie: who.cookie,
          Origin: origin,
        },
      });
    expect((await upgrade(SITE)).status).toBe(401);
    expect((await upgrade(SERVICE)).status).toBe(101);
  });

  test("a return path is the service's own web app or hand-off: never the site, never a public alias", () => {
    expect(safeReturnTo("/app/#/t/s_a/i1", SERVICE)).toBe("/app/#/t/s_a/i1");
    expect(safeReturnTo("/auth/extension?ext=e&challenge=c&state=s", SERVICE)).toBe(
      "/auth/extension?ext=e&challenge=c&state=s",
    );
    for (const raw of [
      `${SITE}/`,
      `${SITE}/install`,
      "//onlay.dev/install",
      `${SERVICE}/app/`,
      "https://evil.test/",
      "/install",
      "/privacy",
      "/download/onlay-extension.zip",
      "/",
      "/app",
      "/api/me",
      "/auth/login",
      "/auth/extension/token",
      "/appx",
      "/app/app.abc123.js",
      "/app/sw.js",
      "/app/missing",
    ])
      expect(safeReturnTo(raw, SERVICE), raw).toBe("/app/");
    expect(safeReturnTo("/app?x=1#/t/y", SERVICE)).toBe("/app/?x=1#/t/y");
    expect(safeReturnTo("/app/index.html#/t/y", SERVICE)).toBe("/app/index.html#/t/y");
  });

  test("sign-in pages link to the site for the extension, and to the service to sign in again", async () => {
    const failed = await at(`${SERVICE}/auth/callback`, navigation());
    const html = await failed.text();
    expect(html).toContain(`<a href="${SITE}/install">Install the extension</a>`);
    expect(html).toContain('<a href="/auth/login">Sign in again</a>');
  });

  test("the dev stub does not exist for a public service origin", async () => {
    const res = await at(`${SERVICE}/auth/dev/session`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: "a@example.com" }),
    });
    expect(res.status).toBe(404);
  });
});

describe("the site host", () => {
  test("/ is the landing page for everyone: the same bytes, no cookie set (test/edge/landing.test.ts)", async () => {
    const who = await devSignIn();
    const bodies = new Set<string>();
    for (const cookie of [undefined, who.cookie, `${who.cookie}; ${who.cookie}`]) {
      const res = await at(`${SITE}/`, navigation(cookie));
      expect(res.status).toBe(200);
      expectNoCookieSet(res);
      bodies.add(await res.text());
    }
    expect(bodies.size).toBe(1);
    expect((await at(`${SITE}/`, { method: "POST" })).status).toBe(405);
  });

  test("serves the public pages and the downloads", async () => {
    const install = await at(`${SITE}/install`, navigation());
    expect(install.status).toBe(200);
    const html = await install.text();
    expect(html).toContain('href="/download/onlay-extension.zip"');
    expect(html).toContain(`<a href="${SERVICE}/app/">your Inbox</a>`);
    expect(html).toContain('<a href="/privacy">Privacy</a>');
    expect((await at(`${SITE}/privacy`)).status).toBe(200);
    const zip = await at(`${SITE}/download/onlay-extension.zip`);
    expect(zip.status).toBe(200);
    expect(zip.headers.get("Content-Type")).toBe("application/zip");
    expect((await at(`${SITE}/download/notes.txt`)).status).toBe(404);
    expect((await at(`${SITE}/healthz`)).status).toBe(200);
  });

  test("a browser going to the web app or to sign-in is sent on to the service", async () => {
    for (const path of [
      "/app",
      "/app/",
      "/app/app.abc123.js",
      "/auth/login",
      "/auth/login?return_to=%2Fapp%2F%23%2Fsettings",
    ]) {
      for (const method of ["GET", "HEAD"]) {
        const res = await at(`${SITE}${path}`, { ...navigation(), method });
        expect(res.status, `${method} ${path}`).toBe(302);
        expect(res.headers.get("Location"), path).toBe(`${SERVICE}${path}`);
        expectNoCookieSet(res);
      }
    }
  });

  test("the old web app's storage is retired under /app alone: / and everything else never clear it", async () => {
    const clears = (res: Response) => res.headers.get("Clear-Site-Data");
    // The old service worker's update fetch: a 404 that carries the header.
    for (const init of [{}, { headers: { "Service-Worker": "script" } }]) {
      const sw = await at(`${SITE}/app/sw.js`, init);
      expect(sw.status).toBe(404);
      expect(clears(sw)).toBe('"storage"');
      expectNoCookieSet(sw);
    }
    for (const [path, method] of [
      ["/app", "GET"],
      ["/app/", "GET"],
      ["/app/", "HEAD"],
      ["/app/", "POST"],
      ["/app/index.html", "DELETE"],
      ["/app/sw.js", "HEAD"],
      ["/app/anything/else", "GET"],
    ] as const) {
      const res = await at(`${SITE}${path}`, { method });
      expect(clears(res), `${method} ${path}`).toBe('"storage"');
      expectNoCookieSet(res);
    }
    // The home page, to any method, never carries it: it would wipe every visitor's storage.
    for (const method of ["GET", "HEAD", "POST"]) {
      const res = await at(`${SITE}/`, { method });
      expect(clears(res), `${method} /`).toBeNull();
      expectNoCookieSet(res);
    }
    // Nothing else on the site carries it, and nothing on the service ever does.
    for (const url of [
      `${SITE}/`,
      `${SITE}/site/main.abc12345.js`,
      `${SITE}/install`,
      `${SITE}/privacy`,
      `${SITE}/download/onlay-extension.zip`,
      `${SITE}/healthz`,
      `${SITE}/auth/login`,
      `${SITE}/api/me`,
      `${SITE}/apps`,
      `${SERVICE}/`,
      `${SERVICE}/app`,
      `${SERVICE}/app/`,
      `${SERVICE}/app/sw.js`,
      `${SERVICE}/install`,
      `${SERVICE}/auth/login`,
      `${SERVICE}/healthz`,
      `${env.PUBLIC_ORIGIN}/`,
    ]) {
      const res = await at(url, navigation(), url.startsWith(env.PUBLIC_ORIGIN) ? env : TWO);
      expect(clears(res), url).toBeNull();
    }
  });

  test("the edge's pages and the web app shell keep cross-origin openers out", async () => {
    for (const url of [`${SERVICE}/app/`, `${SERVICE}/auth/callback`, `${SITE}/install`]) {
      const res = await at(url, navigation());
      expect(res.headers.get("Cross-Origin-Opener-Policy"), url).toBe("same-origin");
    }
  });

  test("every other service route is not found, whatever credential the request carries", async () => {
    const who = await devSignIn();
    const cookieHeaders = {
      Cookie: who.cookie,
      "Sec-Fetch-Site": "same-origin",
      "Sec-Fetch-Mode": "cors",
      Origin: SITE,
      [CSRF_HEADER]: "1",
    };
    const spaceId = await personalSpaceOf(who);
    const requests: [string, RequestInit][] = [
      ["/app/", { method: "POST" }],
      ["/auth/callback?code=x&state=y", navigation(who.cookie)],
      [
        "/auth/extension?ext=abcdefghijklmnopabcdefghijklmnop&challenge=c&state=s",
        navigation(who.cookie),
      ],
      ["/auth/extension/token", { method: "POST", body: "{}" }],
      ["/auth/logout", { method: "POST", headers: cookieHeaders }],
      ["/auth/logout-everywhere", { method: "POST", headers: cookieHeaders }],
      ["/auth/dev/session", { method: "POST", body: JSON.stringify({ email: "a@example.com" }) }],
      ["/api/me", { headers: cookieHeaders }],
      ["/api/me", { headers: { Authorization: `Bearer ${who.token}` } }],
      // Not even read: a malformed credential is not found, never sign_in_required.
      ["/api/me", { headers: { Authorization: "Bearer a, Bearer b" } }],
      [`/s/${spaceId}/interactions`, { headers: { Authorization: `Bearer ${who.token}` } }],
      [
        `/s/${spaceId}/ws`,
        {
          headers: { Upgrade: "websocket", Cookie: who.cookie, Origin: SITE },
        },
      ],
      [
        `/s/${spaceId}/ws`,
        { headers: { Upgrade: "websocket", "Sec-WebSocket-Protocol": `bearer.${who.token}` } },
      ],
      ["/mcp", { method: "POST", headers: { Authorization: "Bearer dev:a@example.com" } }],
      ["/.well-known/oauth-protected-resource", {}],
      ["/.well-known/oauth-protected-resource/mcp", {}],
      ["/.well-known/oauth-authorization-server", {}],
    ];
    for (const [path, init] of requests) await expectNotFound(await at(`${SITE}${path}`, init));
    // The session those requests carried is untouched.
    const still = await at(`${SERVICE}/api/me`, {
      headers: { Cookie: who.cookie, "Sec-Fetch-Site": "same-origin" },
    });
    expect(still.status).toBe(200);
  });
});

describe("any other host, with two origins", () => {
  test("is neither: not found, never taken for the service", async () => {
    const who = await devSignIn();
    for (const url of [
      "https://www.onlay.dev/",
      "https://evil.test/api/me",
      "http://app.onlay.dev/api/me",
      "https://app.onlay.dev:8443/api/me",
      "http://onlay.dev/",
    ]) {
      const res = await at(url, { headers: { Authorization: `Bearer ${who.token}` } });
      await expectNotFound(res);
    }
    expect((await at("https://evil.test/healthz")).status).toBe(404);
  });

  test("a Host header that disagrees with the request's URL makes it neither", async () => {
    const who = await devSignIn();
    const res = await at(`${SERVICE}/api/me`, {
      headers: { Host: "evil.test", Authorization: `Bearer ${who.token}` },
    });
    await expectNotFound(res);
  });
});

describe("one origin", () => {
  test("answers only for exactly PUBLIC_ORIGIN, whether SITE_ORIGIN is unset, empty or the same", async () => {
    const local = env.PUBLIC_ORIGIN; // http://localhost:8787
    const who = await devSignIn();
    const { SITE_ORIGIN: _, ...base } = TWO;
    for (const site of [undefined, "", local, `${local}/`, " "]) {
      const one: typeof env =
        site === undefined
          ? { ...base, PUBLIC_ORIGIN: local }
          : { ...base, PUBLIC_ORIGIN: local, SITE_ORIGIN: site };
      for (const url of [
        "http://localhost:8788/api/me", // another port
        "https://localhost:8787/api/me", // another scheme
        "http://127.0.0.1:8787/api/me", // another name for the same machine
        "http://evil.test/api/me", // another host
        "https://onlay.dev/api/me", // the site, though SITE_ORIGIN doesn't name it
        "https://onlay.dev/",
        "http://localhost/healthz",
      ]) {
        const res = await at(url, { headers: { Authorization: `Bearer ${who.token}` } }, one);
        await expectNotFound(res);
      }
      // A Host header that disagrees with the URL.
      await expectNotFound(
        await at(
          `${local}/api/me`,
          { headers: { Host: "evil.test", Authorization: `Bearer ${who.token}` } },
          one,
        ),
      );
      const own = await at(
        `${local}/api/me`,
        { headers: { Authorization: `Bearer ${who.token}` } },
        one,
      );
      expect(own.status, String(site)).toBe(200);
    }
  });

  test("a production config without its SITE_ORIGIN takes the site's host offline, never opens it", async () => {
    const { SITE_ORIGIN: _, ...base } = TWO;
    const who = await devSignIn();
    for (const url of [`${SITE}/`, `${SITE}/app/`, `${SITE}/api/me`, `${SITE}/healthz`]) {
      await expectNotFound(
        await at(url, { headers: { Authorization: `Bearer ${who.token}` } }, base),
      );
    }
    expect((await at(`${SERVICE}/healthz`, {}, base)).status).toBe(200);
  });

  test("SITE_ORIGIN equal to PUBLIC_ORIGIN serves everything on it, as without one", async () => {
    const local = env.PUBLIC_ORIGIN;
    for (const site of [local, `${local}/`, undefined, ""]) {
      const { SITE_ORIGIN: _, ...base } = TWO;
      const one: typeof env =
        site === undefined
          ? { ...base, PUBLIC_ORIGIN: local }
          : { ...base, PUBLIC_ORIGIN: local, SITE_ORIGIN: site };
      const who = await devSignIn();
      const home = await at(`${local}/`, navigation(who.cookie), one);
      expect(home.status, String(site)).toBe(302);
      expect(home.headers.get("Location")).toBe("/app/");
      const landing = await at(`${local}/`, navigation(), one);
      expect(landing.status).toBe(200);
      expect(landing.headers.get("Content-Type")).toBe("text/html; charset=utf-8");
      await landing.text();
      expect((await at(`${local}/install`, {}, one)).status).toBe(200);
      expect((await at(`${local}/privacy`, {}, one)).status).toBe(200);
      const me = await at(
        `${local}/api/me`,
        { headers: { Cookie: who.cookie, "Sec-Fetch-Site": "same-origin" } },
        one,
      );
      expect(await me.json()).toMatchObject({ siteOrigin: local });
    }
  });
});

describe("the origin settings", () => {
  const INVALID = [
    "",
    " ",
    "app.onlay.dev",
    "//app.onlay.dev",
    "https:app.onlay.dev",
    "https://app.onlay.dev/app",
    "https://app.onlay.dev/app/",
    "https://app.onlay.dev/?",
    "https://app.onlay.dev/?x=1",
    "https://app.onlay.dev/#",
    "https://app.onlay.dev/#x",
    "https://user:pass@app.onlay.dev",
    "https://user@app.onlay.dev",
    "http://app.onlay.dev",
    "ftp://app.onlay.dev",
    "javascript:alert(1)",
    "https://app.onlay.dev\\",
    "not a url",
  ];

  test("only exactly an origin is one: https, or http for a loopback host", () => {
    for (const raw of INVALID) expect(canonicalOrigin(raw), raw).toBeNull();
    expect(canonicalOrigin("https://app.onlay.dev")).toBe(SERVICE);
    expect(canonicalOrigin("https://APP.Onlay.dev/")).toBe(SERVICE);
    expect(canonicalOrigin("HTTPS://app.onlay.dev:443")).toBe(SERVICE);
    expect(canonicalOrigin(" https://onlay.dev/ ")).toBe(SITE);
    expect(canonicalOrigin("http://localhost:8787")).toBe("http://localhost:8787");
    expect(canonicalOrigin("http://127.0.0.1:8787/")).toBe("http://127.0.0.1:8787");
    expect(canonicalOrigin("http://[::1]:8787")).toBe("http://[::1]:8787");
  });

  test("an invalid PUBLIC_ORIGIN fails every request closed, reading no credential", async () => {
    const who = await devSignIn();
    const credentials = {
      Cookie: who.cookie,
      "Sec-Fetch-Site": "same-origin",
      Authorization: `Bearer ${who.token}`,
    };
    for (const bad of INVALID) {
      const broken = { ...TWO, PUBLIC_ORIGIN: bad };
      for (const url of [
        `${SERVICE}/api/me`,
        `${SERVICE}/auth/login`,
        `${SERVICE}/healthz`,
        `${SERVICE}/mcp`,
        `${SITE}/install`,
        `${SITE}/api/me`,
        "https://evil.test/",
      ]) {
        const res = await at(url, { headers: credentials }, broken);
        expectNoCookieSet(res);
        expect(await errorOf(res), `${bad} ${url}`).toMatchObject({
          status: 503,
          code: "unavailable",
        });
        expect(res.headers.get("Clear-Site-Data")).toBeNull();
      }
      // The site's setting is still good: the old web app's storage is still retired there,
      // and the home page still clears nothing.
      for (const path of ["/", "/app/", "/app/sw.js"]) {
        const res = await at(`${SITE}${path}`, { method: "GET" }, broken);
        expect(res.status, `${bad} ${path}`).toBe(503);
        expect(res.headers.get("Clear-Site-Data"), `${bad} ${path}`).toBe(
          path === "/" ? null : '"storage"',
        );
        expectNoCookieSet(res);
      }
    }
  });

  test("an invalid SITE_ORIGIN fails every request closed, and nothing claims to be the site", async () => {
    const who = await devSignIn();
    for (const bad of INVALID.filter((raw) => raw.trim() !== "")) {
      const broken = { ...TWO, SITE_ORIGIN: bad.replace("app.", "") };
      for (const url of [`${SERVICE}/api/me`, `${SERVICE}/install`, `${SITE}/`, `${SITE}/app/`]) {
        const res = await at(url, { headers: { Authorization: `Bearer ${who.token}` } }, broken);
        expect(res.status, `${bad} ${url}`).toBe(503);
        expect(res.headers.get("Location")).toBeNull();
        expect(res.headers.get("Clear-Site-Data")).toBeNull();
        expectNoCookieSet(res);
      }
    }
  });

  test("settings that name an origin in another spelling work as their canonical origin everywhere", async () => {
    const spelled = {
      ...TWO,
      PUBLIC_ORIGIN: "https://APP.onlay.dev/",
      SITE_ORIGIN: "https://Onlay.dev/",
    };
    const login = await at(`${SERVICE}/auth/login`, navigation(), spelled);
    expect(
      new URL(login.headers.get("Location") ?? "").searchParams.getAll("redirect_uri"),
    ).toEqual([`${SERVICE}/auth/callback`]);
    const resource = await at(`${SERVICE}/.well-known/oauth-protected-resource`, {}, spelled);
    expect(await resource.json()).toMatchObject({ resource: `${SERVICE}/mcp` });
    expect((await at(`${SITE}/auth/login`, navigation(), spelled)).headers.get("Location")).toBe(
      `${SERVICE}/auth/login`,
    );
    expect((await at(`${SERVICE}/install`, navigation(), spelled)).headers.get("Location")).toBe(
      `${SITE}/install`,
    );
    // The cookie's Origin rule compares with the canonical origin.
    const who = await devSignIn();
    const write = await at(
      `${SERVICE}/api/me`,
      {
        method: "PATCH",
        headers: {
          Cookie: who.cookie,
          "Sec-Fetch-Site": "same-origin",
          "Sec-Fetch-Mode": "cors",
          Origin: SERVICE,
          [CSRF_HEADER]: "1",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ name: "Ada" }),
      },
      spelled,
    );
    expect(write.status).toBe(200);
    const me = await at(
      `${SERVICE}/api/me`,
      { headers: { Cookie: who.cookie, "Sec-Fetch-Site": "same-origin" } },
      spelled,
    );
    expect(await me.json()).toMatchObject({ siteOrigin: SITE });
  });
});
