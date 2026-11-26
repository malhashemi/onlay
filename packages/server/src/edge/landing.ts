/**
 * The landing page (`@onlay/site`): `/` and its files at `/site/<name>`, on
 * the public site (and, with one origin, for a signed-out browser). The same
 * bytes for every visitor: nothing here reads a cookie or a credential, sets
 * a cookie or reaches a space.
 *
 * The site's build (`packages/site/dist`) reaches the Worker inside the
 * assets directory, under `landing/` (`bun run build:web` copies it there,
 * `packages/server/scripts/stage-site.ts`): `landing/index.html`,
 * `landing/site/<name>` and `landing/asset-manifest.json`. What is served is
 * exactly what that manifest lists, checked here (`landingEntries`); the
 * manifest itself, the folder's own paths and anything else are never served.
 * The web app's allowlist never names anything under `landing/`.
 */
import type { Env } from "../env";
import { LANDING_CSP, LANDING_DIR, type LandingFile, landingEntries } from "./landing-manifest";

const IMMUTABLE = "public, max-age=31536000, immutable";

/** Per assets binding (one per isolate when deployed). */
const loaded = new WeakMap<object, Promise<ReadonlyMap<string, LandingFile> | null>>();

/**
 * The deployed build's files, read once per isolate. Null when there is no
 * landing build (local `wrangler dev` before `bun run build:web`) or its
 * manifest is malformed; then the next request looks again.
 */
function landingFiles(env: Env, origin: string): Promise<ReadonlyMap<string, LandingFile> | null> {
  const known = loaded.get(env.ASSETS);
  if (known !== undefined) return known;
  const attempt = (async () => {
    try {
      const res = await env.ASSETS.fetch(
        new Request(`${origin}/${LANDING_DIR}/asset-manifest.json`),
      );
      if (!res.ok) {
        await res.body?.cancel();
        return null;
      }
      return landingEntries(await res.json());
    } catch {
      return null;
    }
  })();
  loaded.set(env.ASSETS, attempt);
  // Only a good build is kept: without one, the next request looks again.
  void attempt.then((files) => {
    if (files === null && loaded.get(env.ASSETS) === attempt) loaded.delete(env.ASSETS);
  });
  return attempt;
}

const notFound = () =>
  new Response("not found", {
    status: 404,
    headers: { "Content-Type": "text/plain; charset=utf-8", "X-Content-Type-Options": "nosniff" },
  });

const METHOD_NOT_ALLOWED = () =>
  new Response(null, { status: 405, headers: { Allow: "GET, HEAD" } });

/** Without a landing build: a plain answer, and a line in the log saying why. */
function notBuilt(): Response {
  console.error("the landing page is not in the assets: run `bun run build:web`");
  return new Response("Something went wrong.", {
    status: 503,
    headers: {
      "Content-Type": "text/plain; charset=utf-8",
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
    },
  });
}

/** The landing page's files' paths: `/site/*`. */
export function isLandingAsset(path: string): boolean {
  return path.startsWith("/site/");
}

/** `GET /`: the landing document, the same for everyone. Never throws. */
export async function serveLanding(request: Request, env: Env, url: URL): Promise<Response> {
  if (request.method !== "GET" && request.method !== "HEAD") return METHOD_NOT_ALLOWED();
  try {
    if ((await landingFiles(env, url.origin)) === null) return notBuilt();
    const res = await env.ASSETS.fetch(new Request(`${url.origin}/${LANDING_DIR}/index.html`));
    if (!res.ok) {
      await res.body?.cancel();
      return notBuilt();
    }
    const headers = new Headers({
      "Content-Type": "text/html; charset=utf-8",
      "Content-Security-Policy": LANDING_CSP,
      // A cross-origin opener keeps no handle on the page's window, as on the edge's own pages.
      "Cross-Origin-Opener-Policy": "same-origin",
      "Referrer-Policy": "strict-origin-when-cross-origin",
      "Cache-Control": "no-cache",
      "X-Content-Type-Options": "nosniff",
    });
    if (request.method === "HEAD") {
      await res.body?.cancel();
      return new Response(null, { headers });
    }
    return new Response(res.body, { headers });
  } catch (error) {
    // A binding that fails mid-request: the same plain answer, never an
    // unhandled error.
    console.error("the landing document could not be read", error);
    return notBuilt();
  }
}

/** One byte range of a file, as `[start, end]` inclusive. */
type Range = readonly [number, number];

/**
 * The strong validator of a landing file. Its name is content-hashed and it
 * is never rewritten in place, so name and length identify its bytes.
 */
export function etagOf(path: string, file: LandingFile): string {
  return `"${file.bytes}-${path.slice("/site/".length)}"`;
}

/** `If-None-Match` against `etag` (weak comparison, RFC 9110 §13.1.2). */
function noneMatch(header: string, etag: string): boolean {
  if (header.trim() === "*") return true;
  const opaque = etag.replace(/^W\//, "");
  return header.split(",").some((tag) => tag.trim().replace(/^W\//, "") === opaque);
}

/**
 * The request's `Range` for a `size`-byte file with validator `etag`
 * (RFC 9110 §14): one range, `"unsatisfiable"` (416), or null for the whole
 * file. Only GET has ranges; a HEAD's `Range` is ignored. Null too for no
 * header, another unit, several ranges, a malformed or reversed range, and an
 * `If-Range` that is not exactly this file's (strong) validator. The unit is
 * matched without regard to case.
 */
export function rangeOf(
  request: Request,
  size: number,
  etag: string,
): Range | null | "unsatisfiable" {
  if (request.method !== "GET") return null;
  const raw = request.headers.get("Range");
  if (raw === null) return null;
  const ifRange = request.headers.get("If-Range");
  if (ifRange !== null && ifRange.trim() !== etag) return null;
  const m = /^\s*bytes\s*=\s*(\d*)\s*-\s*(\d*)\s*$/i.exec(raw);
  if (m === null) return null;
  const [, from = "", to = ""] = m;
  if (from === "" && to === "") return null;
  if (from === "") {
    // The last `to` bytes.
    const n = Number(to);
    if (n === 0) return "unsatisfiable";
    return [Math.max(0, size - n), size - 1];
  }
  const start = Number(from);
  if (to !== "" && Number(to) < start) return null;
  if (start >= size) return "unsatisfiable";
  return [start, to === "" ? size - 1 : Math.min(Number(to), size - 1)];
}

/**
 * `length` bytes of `source` from `start` on, read as they are needed: the
 * bytes before `start` are dropped as they pass, and the source is cancelled
 * as soon as the last wanted byte is out. Nothing is held but one chunk.
 */
function slice(source: ReadableStream<Uint8Array>, start: number, length: number) {
  const reader = source.getReader();
  let skip = start;
  let left = length;
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) {
          controller.error(new Error("the asset ended before the range"));
          return;
        }
        let chunk = value;
        if (skip >= chunk.length) {
          skip -= chunk.length;
          continue;
        }
        chunk = chunk.subarray(skip, skip + left);
        skip = 0;
        left -= chunk.length;
        controller.enqueue(chunk);
        if (left === 0) {
          controller.close();
          await reader.cancel();
        }
        return;
      }
    },
    cancel(reason) {
      return reader.cancel(reason);
    },
  });
}

/** A body of exactly `length` bytes, so the response carries its `Content-Length`. */
function exactly(stream: ReadableStream<Uint8Array>, length: number): ReadableStream<Uint8Array> {
  const fixed = new FixedLengthStream(length);
  stream.pipeTo(fixed.writable).catch(() => undefined);
  return fixed.readable as ReadableStream<Uint8Array>;
}

/** The bytes `[start, end]` of a landing file, from the assets binding. */
async function readRange(
  env: Env,
  at: string,
  [start, end]: Range,
  size: number,
): Promise<ReadableStream<Uint8Array> | null> {
  const length = end - start + 1;
  // A binding that answers ranges reads only these bytes; take its answer
  // only when it is exactly the range asked for.
  const ranged = await env.ASSETS.fetch(
    new Request(at, { headers: { Range: `bytes=${start}-${end}` } }),
  );
  if (
    ranged.status === 206 &&
    ranged.body !== null &&
    ranged.headers.get("Content-Range") === `bytes ${start}-${end}/${size}`
  ) {
    return ranged.body;
  }
  if (ranged.status === 200 && ranged.body !== null && fits(ranged, size)) {
    return slice(ranged.body, start, length);
  }
  await ranged.body?.cancel();
  // Anything else: the whole file, sliced as it streams.
  const whole = await env.ASSETS.fetch(new Request(at));
  if (!whole.ok || whole.body === null || !fits(whole, size)) {
    await whole.body?.cancel();
    return null;
  }
  return slice(whole.body, start, length);
}

/** The binding's length, when it says one, is the manifest's (a stale staging is not served). */
function fits(res: Response, size: number): boolean {
  const declared = res.headers.get("Content-Length");
  return declared === null || Number(declared) === size;
}

/**
 * `/site/<name>`: exactly the files the build's manifest lists, immutable.
 * What to answer (304, 416, 206 or 200) is decided from the manifest's length
 * and the file's validator before any byte is read (RFC 9110 §13.2.2:
 * `If-None-Match` before `Range`); a range reads only up to its last byte.
 */
export async function serveSiteAsset(request: Request, env: Env, url: URL): Promise<Response> {
  const files = await landingFiles(env, url.origin);
  const file = files?.get(url.pathname);
  if (file === undefined) return notFound();
  if (request.method !== "GET" && request.method !== "HEAD") return METHOD_NOT_ALLOWED();
  const etag = etagOf(url.pathname, file);
  const headers = new Headers({
    "Content-Type": file.type,
    "Cache-Control": IMMUTABLE,
    "Accept-Ranges": "bytes",
    ETag: etag,
    "X-Content-Type-Options": "nosniff",
  });
  const ifNoneMatch = request.headers.get("If-None-Match");
  if (ifNoneMatch !== null && noneMatch(ifNoneMatch, etag)) {
    headers.delete("Content-Type");
    return new Response(null, { status: 304, headers });
  }
  const range = rangeOf(request, file.bytes, etag);
  if (range === "unsatisfiable") {
    headers.set("Content-Range", `bytes */${file.bytes}`);
    return new Response(null, { status: 416, headers });
  }
  const at = `${url.origin}/${LANDING_DIR}${url.pathname}`;
  if (range !== null) {
    const body = await readRange(env, at, range, file.bytes);
    if (body === null) return notFound();
    const [start, end] = range;
    headers.set("Content-Range", `bytes ${start}-${end}/${file.bytes}`);
    headers.set("Content-Length", String(end - start + 1));
    return new Response(exactly(body, end - start + 1), { status: 206, headers });
  }
  const res = await env.ASSETS.fetch(new Request(at));
  if (!res.ok || res.body === null || !fits(res, file.bytes)) {
    await res.body?.cancel();
    if (res.ok) console.error(`${url.pathname} is not the length its manifest says`);
    return notFound();
  }
  if (request.method === "HEAD") {
    await res.body.cancel();
    return new Response(null, { headers });
  }
  headers.set("Content-Length", String(file.bytes));
  return new Response(exactly(res.body, file.bytes), { headers });
}
