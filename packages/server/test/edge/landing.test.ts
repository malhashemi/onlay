// The landing page (src/edge/landing.ts): `/` and `/site/*` on the public
// site, the same bytes for every visitor and no credential read; exactly the
// files the build's manifest lists, immutable, with byte ranges for the film;
// refused on the service host; and, with one origin, the page a signed-out
// browser gets at `/`. The assets are vitest.config.ts's stand-in build.
import { env } from "cloudflare:workers";
import { describe, expect, test } from "vitest";
import { rangeOf } from "../../src/edge/landing";
import { LANDING_CSP, landingEntries } from "../../src/edge/landing-manifest";
import { handle } from "../../src/worker";
import { devSignIn } from "../support/client";

const SERVICE = "https://app.onlay.dev";
const SITE = "https://onlay.dev";
const TWO = { ...env, PUBLIC_ORIGIN: SERVICE, SITE_ORIGIN: SITE };
const ONE = env; // http://localhost:8787, SITE_ORIGIN empty (env.dev)
const LOCAL = env.PUBLIC_ORIGIN;

const DOC = "<!doctype html><title>Onlay landing stand-in</title>\n";
const JS = "/site/main.abc12345.js";
const FILM = "/site/film.abc12345.mp4";
const NOTICES = "/site/THIRD-PARTY-NOTICES.abc12345.txt";
const FILM_BYTES = Uint8Array.from({ length: 1000 }, (_, i) => i % 251);

const EXACT_CSP =
  "default-src 'none'; script-src 'self'; style-src 'self'; font-src 'self'; media-src 'self'; img-src 'self' data:; connect-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'";

/**
 * A request whose credentials must never be read: any look at `Cookie` or
 * `Authorization` (get, has, or walking every header) is recorded.
 */
function watched(url: string, init: RequestInit = {}): { request: Request; reads: string[] } {
  const request = new Request(url, { redirect: "manual", ...init });
  const reads: string[] = [];
  const real = request.headers;
  const secret = (name: unknown) =>
    typeof name === "string" && ["cookie", "authorization"].includes(name.toLowerCase());
  const headers = new Proxy(real, {
    get(target, prop) {
      if (prop === "get" || prop === "has" || prop === "getAll" || prop === "getSetCookie") {
        return (name: string) => {
          if (secret(name)) reads.push(`${String(prop)}(${name})`);
          return (target[prop as "get"] as (n: string) => unknown).call(target, name);
        };
      }
      if (prop === "entries" || prop === "forEach" || prop === "keys" || prop === "values") {
        reads.push(String(prop));
      }
      if (prop === Symbol.iterator) reads.push("iterate");
      const value = Reflect.get(target, prop, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  Object.defineProperty(request, "headers", { value: headers });
  return { request, reads };
}

const credentialed = async (): Promise<Record<string, string>> => {
  const who = await devSignIn();
  return {
    Cookie: who.cookie,
    Authorization: `Bearer ${who.token}`,
    "Sec-Fetch-Site": "same-origin",
    "Sec-Fetch-Mode": "navigate",
  };
};

async function bytesOf(res: Response): Promise<Uint8Array> {
  return new Uint8Array(await res.arrayBuffer());
}

describe("the site host's /", () => {
  test("is the landing document under its exact policy, the same for everyone, reading no credential", async () => {
    expect(LANDING_CSP).toBe(EXACT_CSP);
    const headers = await credentialed();
    for (const init of [
      {},
      { headers },
      { headers: { Cookie: `${headers.Cookie}; ${headers.Cookie}` } },
    ]) {
      const { request, reads } = watched(`${SITE}/`, init);
      const res = await handle(request, TWO);
      expect(res.status).toBe(200);
      expect(await res.text()).toBe(DOC);
      expect(res.headers.get("Content-Type")).toBe("text/html; charset=utf-8");
      expect(res.headers.get("Content-Security-Policy")).toBe(EXACT_CSP);
      expect(res.headers.get("Cache-Control")).toBe("no-cache");
      expect(res.headers.get("X-Content-Type-Options")).toBe("nosniff");
      expect(res.headers.get("Referrer-Policy")).toBe("strict-origin-when-cross-origin");
      expect(res.headers.get("Cross-Origin-Opener-Policy")).toBe("same-origin");
      // The home page never clears a visitor's storage.
      expect(res.headers.get("Clear-Site-Data")).toBeNull();
      expect(res.headers.getSetCookie()).toEqual([]);
      expect(reads).toEqual([]);
    }
  });

  test("HEAD has the headers and no body; other methods are 405; none clears storage", async () => {
    const head = await handle(new Request(`${SITE}/`, { method: "HEAD" }), TWO);
    expect(head.status).toBe(200);
    expect(head.headers.get("Content-Security-Policy")).toBe(EXACT_CSP);
    expect(head.headers.get("Clear-Site-Data")).toBeNull();
    expect(await head.text()).toBe("");
    for (const method of ["POST", "PUT", "DELETE"]) {
      const res = await handle(new Request(`${SITE}/`, { method }), TWO);
      expect(res.status, method).toBe(405);
      expect(res.headers.get("Allow")).toBe("GET, HEAD");
      expect(res.headers.get("Clear-Site-Data")).toBeNull();
    }
  });

  test("without a landing build, / answers plainly (clearing nothing) and /site/* is not found", async () => {
    const empty = {
      ...TWO,
      ASSETS: { fetch: async () => new Response("no", { status: 404 }) } as unknown as Fetcher,
    };
    const res = await handle(new Request(`${SITE}/`), empty);
    expect(res.status).toBe(503);
    expect(res.headers.get("Clear-Site-Data")).toBeNull();
    expect((await handle(new Request(`${SITE}${JS}`), empty)).status).toBe(404);
  });

  test("a binding that throws while reading the document still answers plainly", async () => {
    const manifest = {
      index: "index.html",
      base: "/site/",
      files: [{ path: "/", contentType: "text/html; charset=utf-8", cache: "no-cache", bytes: 1 }],
    };
    const failing = {
      ...TWO,
      ASSETS: {
        fetch: async (input: Request) => {
          if (new URL(input.url).pathname === "/landing/asset-manifest.json") {
            return Response.json(manifest);
          }
          throw new Error("the binding is down");
        },
      } as unknown as Fetcher,
    };
    for (const method of ["GET", "HEAD"]) {
      const res = await handle(new Request(`${SITE}/`, { method }), failing);
      expect(res.status, method).toBe(503);
      expect(res.headers.get("Clear-Site-Data")).toBeNull();
      expect(res.headers.getSetCookie()).toEqual([]);
    }
  });
});

describe("the site host's /site/*", () => {
  test("serves exactly the manifest's files: their type, immutable, nosniff, no cookie, nothing cleared", async () => {
    const headers = await credentialed();
    for (const [path, type] of [
      [JS, "text/javascript; charset=utf-8"],
      [FILM, "video/mp4"],
      [NOTICES, "text/plain; charset=utf-8"],
    ] as const) {
      const { request, reads } = watched(`${SITE}${path}`, { headers });
      const res = await handle(request, TWO);
      expect(res.status, path).toBe(200);
      expect(res.headers.get("Content-Type")).toBe(type);
      expect(res.headers.get("Cache-Control")).toBe("public, max-age=31536000, immutable");
      expect(res.headers.get("X-Content-Type-Options")).toBe("nosniff");
      expect(res.headers.get("Accept-Ranges")).toBe("bytes");
      expect(res.headers.get("Clear-Site-Data")).toBeNull();
      expect(res.headers.getSetCookie()).toEqual([]);
      expect(reads, path).toEqual([]);
      await res.arrayBuffer();
    }
    const film = await handle(new Request(`${SITE}${FILM}`), TWO);
    expect(await bytesOf(film)).toEqual(FILM_BYTES);
    const head = await handle(new Request(`${SITE}${JS}`, { method: "HEAD" }), TWO);
    expect(head.status).toBe(200);
    expect(await head.text()).toBe("");
    expect((await handle(new Request(`${SITE}${JS}`, { method: "POST" }), TWO)).status).toBe(405);
  });

  test("anything the manifest does not list is not found: the manifest, unlisted files, path tricks", async () => {
    for (const path of [
      "/site/",
      "/site",
      "/site/unlisted.abc12345.js",
      "/site/asset-manifest.json",
      "/asset-manifest.json",
      "/landing/asset-manifest.json",
      "/landing/index.html",
      "/landing/site/main.abc12345.js",
      "/landing/notes.txt",
      "/site/../landing/notes.txt",
      "/site/%2e%2e/landing/notes.txt",
      "/site/..%2Flanding%2Fnotes.txt",
      "/site%2Fmain.abc12345.js",
      "/site/main.abc12345.js/",
      "/site//main.abc12345.js",
      "/SITE/main.abc12345.js",
      "/site/MAIN.abc12345.js",
      "/site/main.ABC12345.js",
      "/site/main.abc12345.js%00",
      "/site/index.html",
      "/index.html",
    ]) {
      const res = await handle(new Request(`${SITE}${path}`, { redirect: "manual" }), TWO);
      expect(res.status, path).toBe(404);
      expect(res.headers.getSetCookie()).toEqual([]);
      await res.arrayBuffer();
    }
    // A query is not part of the name: the file, as listed.
    expect((await handle(new Request(`${SITE}${JS}?v=1`), TWO)).status).toBe(200);
  });

  test("the film answers byte ranges: 206 with Content-Range, suffixes, open ends, and 416 past the end", async () => {
    const ranged = (range: string, more: Record<string, string> = {}) =>
      handle(new Request(`${SITE}${FILM}`, { headers: { Range: range, ...more } }), TWO);

    const first = await ranged("bytes=0-1");
    expect(first.status).toBe(206);
    expect(first.headers.get("Content-Range")).toBe("bytes 0-1/1000");
    expect(first.headers.get("Content-Length")).toBe("2");
    expect(first.headers.get("Accept-Ranges")).toBe("bytes");
    expect(first.headers.get("Content-Type")).toBe("video/mp4");
    expect(first.headers.get("Cache-Control")).toBe("public, max-age=31536000, immutable");
    expect(first.headers.get("ETag")).toBe(FILM_ETAG);
    expect(await bytesOf(first)).toEqual(FILM_BYTES.subarray(0, 2));

    const middle = await ranged("bytes=300-599");
    expect(middle.headers.get("Content-Range")).toBe("bytes 300-599/1000");
    expect(await bytesOf(middle)).toEqual(FILM_BYTES.subarray(300, 600));

    const open = await ranged("bytes=990-");
    expect(open.headers.get("Content-Range")).toBe("bytes 990-999/1000");
    expect(await bytesOf(open)).toEqual(FILM_BYTES.subarray(990));

    const clipped = await ranged("bytes=900-5000");
    expect(clipped.headers.get("Content-Range")).toBe("bytes 900-999/1000");
    expect((await bytesOf(clipped)).length).toBe(100);

    const suffix = await ranged("bytes=-100");
    expect(suffix.headers.get("Content-Range")).toBe("bytes 900-999/1000");
    expect(await bytesOf(suffix)).toEqual(FILM_BYTES.subarray(900));
    const longer = await ranged("bytes=-5000");
    expect(longer.headers.get("Content-Range")).toBe("bytes 0-999/1000");
    await longer.arrayBuffer();

    // The unit is matched without regard to case (RFC 9110 §14.1).
    for (const range of ["BYTES=0-1", "Bytes=0-1", " bytes = 0 - 1 "]) {
      const res = await ranged(range);
      expect(res.status, range).toBe(206);
      expect(await bytesOf(res)).toEqual(FILM_BYTES.subarray(0, 2));
    }

    for (const range of ["bytes=1000-", "bytes=5000-6000", "bytes=-0"]) {
      const past = await ranged(range);
      expect(past.status, range).toBe(416);
      expect(past.headers.get("Content-Range")).toBe("bytes */1000");
      expect(past.headers.get("Accept-Ranges")).toBe("bytes");
      expect(await past.text()).toBe("");
    }

    // Not one byte range: the whole file.
    for (const range of ["bytes=0-1,5-6", "items=0-1", "bytes=5-2", "bytes=-", "bytes=a-b"]) {
      const whole = await ranged(range);
      expect(whole.status, range).toBe(200);
      expect(whole.headers.get("Content-Range")).toBeNull();
      expect((await bytesOf(whole)).length).toBe(1000);
    }
    // If-Range: the range only when it names this file's (strong) validator.
    const fresh = await ranged("bytes=0-1", { "If-Range": FILM_ETAG });
    expect(fresh.status).toBe(206);
    await fresh.arrayBuffer();
    for (const ifRange of ['"something-else"', `W/${FILM_ETAG}`, "Wed, 21 Oct 2015 07:28:00 GMT"]) {
      const stale = await ranged("bytes=0-1", { "If-Range": ifRange });
      expect(stale.status, ifRange).toBe(200);
      expect((await bytesOf(stale)).length).toBe(1000);
    }
  });

  test("HEAD ignores Range (only GET has ranges, RFC 9110 §14.2): the whole file's headers", async () => {
    const head = await handle(
      new Request(`${SITE}${FILM}`, { method: "HEAD", headers: { Range: "bytes=0-9" } }),
      TWO,
    );
    expect(head.status).toBe(200);
    expect(head.headers.get("Content-Range")).toBeNull();
    expect(head.headers.get("Accept-Ranges")).toBe("bytes");
    expect(head.headers.get("ETag")).toBe(FILM_ETAG);
    expect(await head.text()).toBe("");
  });

  test("a matching If-None-Match is 304 before any range is considered (RFC 9110 §13.2.2)", async () => {
    for (const [ifNoneMatch, more] of [
      [FILM_ETAG, {}],
      [`W/${FILM_ETAG}`, {}],
      [`"other", ${FILM_ETAG}`, {}],
      ["*", {}],
      [FILM_ETAG, { Range: "bytes=0-1" }],
      [FILM_ETAG, { Range: "bytes=5000-" }],
    ] as const) {
      for (const method of ["GET", "HEAD"]) {
        const res = await handle(
          new Request(`${SITE}${FILM}`, {
            method,
            headers: { "If-None-Match": ifNoneMatch, ...more },
          }),
          TWO,
        );
        expect(res.status, `${method} ${ifNoneMatch} ${JSON.stringify(more)}`).toBe(304);
        expect(res.headers.get("ETag")).toBe(FILM_ETAG);
        expect(res.headers.get("Cache-Control")).toBe("public, max-age=31536000, immutable");
        expect(res.headers.get("Content-Range")).toBeNull();
        expect(await res.text()).toBe("");
      }
    }
    const other = await handle(
      new Request(`${SITE}${FILM}`, {
        headers: { "If-None-Match": '"other"', Range: "bytes=0-1" },
      }),
      TWO,
    );
    expect(other.status).toBe(206);
    await other.arrayBuffer();
  });

  test("a range reads only up to its last byte, and 304, 416 and HEAD read no body", async () => {
    const assets = stubAssets({ honoursRange: false });
    const on = { ...TWO, ASSETS: assets.binding };
    const get = (headers: Record<string, string>, method = "GET") =>
      handle(new Request(`${SITE}${BIG}`, { method, headers }), on);

    const two = await get({ Range: "bytes=0-1" });
    expect(two.status).toBe(206);
    expect(two.headers.get("Content-Length")).toBe("2");
    expect(await bytesOf(two)).toEqual(bigBytes(0, 2));
    // One chunk of 1,000 bytes (and at most one more the stream asked ahead
    // for), never the file's 100,000.
    expect(assets.pulled()).toBeLessThanOrEqual(2_000);

    assets.reset();
    const mid = await get({ Range: "bytes=50000-50009" });
    expect(await bytesOf(mid)).toEqual(bigBytes(50_000, 10));
    expect(assets.pulled()).toBeGreaterThanOrEqual(51_000);
    expect(assets.pulled()).toBeLessThanOrEqual(52_000);

    for (const [headers, status] of [
      [{ "If-None-Match": assets.etag }, 304],
      [{ Range: "bytes=100000-" }, 416],
    ] as const) {
      assets.reset();
      const res = await get(headers);
      expect(res.status).toBe(status);
      await res.arrayBuffer();
      expect(assets.reads(), JSON.stringify(headers)).toEqual([]);
    }
    assets.reset();
    const head = await get({ Range: "bytes=0-1" }, "HEAD");
    expect(head.status).toBe(200);
    await head.arrayBuffer();
    expect(assets.pulled()).toBeLessThanOrEqual(2_000);

    // The whole file still streams in full.
    assets.reset();
    const whole = await get({});
    expect(whole.headers.get("Content-Length")).toBe("100000");
    expect(await bytesOf(whole)).toEqual(bigBytes(0, 100_000));
  });

  test("a binding that answers ranges is asked for exactly the range, and its answer is passed on", async () => {
    const assets = stubAssets({ honoursRange: true });
    const on = { ...TWO, ASSETS: assets.binding };
    const res = await handle(
      new Request(`${SITE}${BIG}`, { headers: { Range: "bytes=70000-70099" } }),
      on,
    );
    expect(res.status).toBe(206);
    expect(res.headers.get("Content-Range")).toBe("bytes 70000-70099/100000");
    expect(await bytesOf(res)).toEqual(bigBytes(70_000, 100));
    expect(assets.reads()).toEqual(["bytes=70000-70099"]);
    expect(assets.pulled()).toBe(100);
  });
});

/** The stand-in film's validator: its length and its content-hashed name. */
const FILM_ETAG = '"1000-film.abc12345.mp4"';

const BIG = "/site/big.abc12345.mp4";
const BIG_SIZE = 100_000;
function bigBytes(start: number, length: number): Uint8Array {
  return Uint8Array.from({ length }, (_, i) => (start + i) % 251);
}

/**
 * An assets binding holding a 100,000-byte file, served in 1,000-byte chunks
 * as they are pulled, that counts what is read; `honoursRange` makes it answer
 * a `Range` as a binding that supports ranges would.
 */
function stubAssets({ honoursRange }: { honoursRange: boolean }) {
  let pulled = 0;
  let reads: string[] = [];
  const manifest = {
    index: "index.html",
    base: "/site/",
    files: [
      { path: "/", contentType: "text/html; charset=utf-8", cache: "no-cache", bytes: DOC.length },
      { path: BIG, contentType: "video/mp4", cache: "immutable", bytes: BIG_SIZE },
    ],
  };
  const stream = (start: number, end: number) => {
    let at = start;
    return new ReadableStream<Uint8Array>(
      {
        pull(controller) {
          if (at > end) {
            controller.close();
            return;
          }
          const n = Math.min(1_000, end - at + 1);
          controller.enqueue(bigBytes(at, n));
          pulled += n;
          at += n;
        },
      },
      { highWaterMark: 0 },
    );
  };
  const binding = {
    async fetch(input: Request) {
      const path = new URL(input.url).pathname;
      if (path === "/landing/asset-manifest.json") return Response.json(manifest);
      if (path === "/landing/index.html") return new Response(DOC);
      if (path !== `/landing${BIG}`) return new Response("no", { status: 404 });
      const range = input.headers.get("Range");
      reads.push(range ?? "whole");
      const m = honoursRange ? /^bytes=(\d+)-(\d+)$/.exec(range ?? "") : null;
      if (m) {
        const [start, end] = [Number(m[1]), Number(m[2])];
        return new Response(stream(start, end), {
          status: 206,
          headers: { "Content-Range": `bytes ${start}-${end}/${BIG_SIZE}` },
        });
      }
      return new Response(stream(0, BIG_SIZE - 1));
    },
  };
  return {
    binding: binding as unknown as Fetcher,
    etag: `"${BIG_SIZE}-big.abc12345.mp4"`,
    pulled: () => pulled,
    reads: () => reads,
    reset() {
      pulled = 0;
      reads = [];
    },
  };
}

describe("the service host", () => {
  test("refuses /site/* and still sends / on to the web app", async () => {
    for (const path of [JS, FILM, "/site/"]) {
      const res = await handle(new Request(`${SERVICE}${path}`, { redirect: "manual" }), TWO);
      expect(res.status, path).toBe(404);
      expect(res.headers.get("Location")).toBeNull();
    }
    const home = await handle(new Request(`${SERVICE}/`, { redirect: "manual" }), TWO);
    expect(home.status).toBe(302);
    expect(home.headers.get("Location")).toBe("/app/");
  });

  test("the web app never serves the landing page's files, even when its manifest names one", async () => {
    for (const path of [
      "/app/landing/index.html",
      "/app/landing/asset-manifest.json",
      `/app${JS}`,
    ]) {
      const res = await handle(new Request(`${SERVICE}${path}`), TWO);
      expect(res.status, path).toBe(404);
    }
  });
});

describe("one origin", () => {
  test("/ sends a signed-in browser on to the web app and gives anyone else the landing page", async () => {
    const who = await devSignIn();
    const signedIn = await handle(
      new Request(`${LOCAL}/`, {
        redirect: "manual",
        headers: { Cookie: who.cookie, "Sec-Fetch-Mode": "navigate", "Sec-Fetch-Site": "none" },
      }),
      ONE,
    );
    expect(signedIn.status).toBe(302);
    expect(signedIn.headers.get("Location")).toBe("/app/");

    const signedOut = await handle(new Request(`${LOCAL}/`, { redirect: "manual" }), ONE);
    expect(signedOut.status).toBe(200);
    expect(await signedOut.text()).toBe(DOC);
    expect(signedOut.headers.get("Content-Security-Policy")).toBe(EXACT_CSP);
    expect(signedOut.headers.get("Cache-Control")).toBe("no-cache");
    // Nor does one origin's: the web app lives here.
    expect(signedOut.headers.get("Clear-Site-Data")).toBeNull();
    expect(signedOut.headers.getSetCookie()).toEqual([]);
  });

  test("serves the landing files at /site/*, and nothing unlisted", async () => {
    const js = await handle(new Request(`${LOCAL}${JS}`), ONE);
    expect(js.status).toBe(200);
    expect(js.headers.get("Cache-Control")).toBe("public, max-age=31536000, immutable");
    await js.arrayBuffer();
    const film = await handle(
      new Request(`${LOCAL}${FILM}`, { headers: { Range: "bytes=0-1" } }),
      ONE,
    );
    expect(film.status).toBe(206);
    await film.arrayBuffer();
    for (const path of [
      "/site/unlisted.abc12345.js",
      "/landing/index.html",
      "/site/asset-manifest.json",
    ]) {
      expect((await handle(new Request(`${LOCAL}${path}`), ONE)).status, path).toBe(404);
    }
  });
});

describe("the landing manifest", () => {
  interface Entry {
    path: string;
    contentType: string;
    cache: string;
    bytes: number;
  }
  const good = (): { index: string; base: string; files: Entry[] } => ({
    index: "index.html",
    base: "/site/",
    files: [
      { path: "/", contentType: "text/html; charset=utf-8", cache: "no-cache", bytes: 10 },
      {
        path: "/site/a.1234.js",
        contentType: "text/javascript; charset=utf-8",
        cache: "immutable",
        bytes: 20,
      },
      { path: "/site/film.1234.mp4", contentType: "video/mp4", cache: "immutable", bytes: 30 },
    ],
  });

  const at = (m: { files: Entry[] }, i: number): Entry => {
    const entry = m.files[i];
    if (entry === undefined) throw new Error(`no entry ${i}`);
    return entry;
  };

  test("is served only as a whole, each file a plain /site/<name> of a known type", () => {
    expect([...(landingEntries(good())?.keys() ?? [])]).toEqual([
      "/site/a.1234.js",
      "/site/film.1234.mp4",
    ]);
    const bad: Array<(m: { base: string; files: Entry[] }, f: Entry[]) => void> = [
      (m) => {
        m.files.shift(); // no document
      },
      (m) => {
        at(m, 1).path = "/site/../a.js";
      },
      (m) => {
        at(m, 1).path = "/site/sub/a.js";
      },
      (m) => {
        at(m, 1).path = "/app/a.js";
      },
      (m) => {
        at(m, 1).path = "/site/a.html";
        at(m, 1).contentType = "text/html; charset=utf-8";
      },
      (m) => {
        at(m, 1).contentType = "text/html; charset=utf-8"; // a script named as a page
      },
      (m) => {
        at(m, 1).cache = "no-cache";
      },
      (m) => {
        at(m, 2).path = at(m, 1).path;
        at(m, 2).contentType = at(m, 1).contentType;
      },
      (m) => {
        at(m, 0).contentType = "text/plain";
      },
      (m) => {
        m.base = "/";
      },
      (m) => {
        m.files.push({ ...at(m, 0) }); // the document twice
      },
      (m) => {
        m.files.push({ ...at(m, 1) }); // a file twice, identically
      },
      (m) => {
        at(m, 1).bytes = 0;
      },
      (m) => {
        at(m, 2).bytes = 1.5;
      },
      (m) => {
        delete (at(m, 0) as Partial<Entry>).bytes;
      },
    ];
    for (const [i, change] of bad.entries()) {
      const m = good();
      change(m, m.files);
      expect(landingEntries(m), String(i)).toBeNull();
    }
    expect(landingEntries(null)).toBeNull();
    expect(landingEntries([])).toBeNull();
  });

  test("a range is one byte range of the file, or the whole file", () => {
    const E = '"10-a.js"';
    const req = (range: string, more: Record<string, string> = {}, method = "GET") =>
      new Request("https://x.test/", { method, headers: { Range: range, ...more } });
    expect(rangeOf(req("bytes=0-0"), 10, E)).toEqual([0, 0]);
    expect(rangeOf(req("BYTES=2-3"), 10, E)).toEqual([2, 3]);
    expect(rangeOf(req("bytes=-20"), 10, E)).toEqual([0, 9]);
    expect(rangeOf(req("bytes=-0"), 10, E)).toBe("unsatisfiable");
    expect(rangeOf(req("bytes=10-"), 10, E)).toBe("unsatisfiable");
    expect(rangeOf(req("bytes=9-3"), 10, E)).toBeNull();
    expect(rangeOf(req("bytes=0-1", { "If-Range": E }), 10, E)).toEqual([0, 1]);
    expect(rangeOf(req("bytes=0-1", { "If-Range": `W/${E}` }), 10, E)).toBeNull();
    expect(rangeOf(req("bytes=0-1", {}, "HEAD"), 10, E)).toBeNull();
    expect(rangeOf(new Request("https://x.test/"), 10, E)).toBeNull();
  });
});
