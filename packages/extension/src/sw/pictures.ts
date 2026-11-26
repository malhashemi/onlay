// People's pictures for the extension's pages and overlay. A picture is
// Onlay's own copy, on the service (`@onlay/protocol` `picture.ts`): the
// service worker fetches it with the extension's token, checks it is one of
// those paths and that its bytes are a PNG, JPEG or WebP, and hands it on as
// base64. A page never loads a picture itself, so its Content-Security-Policy
// never decides whether a face shows, and nothing reaches a provider.
//
// What is kept is scoped to the account (its generation) and to the access
// revision of the picture's space: an account change or a change in this
// person's access to the space is a different scope, and the cache is also
// dropped outright on either. A scope that changed while a body was read is
// not answered from that body. A space's picture is answered only while the
// space is among the person's spaces, on every ask, cached or not, and a
// space's pictures go when it leaves the list (`retain`).
//
// Every answer names the scope it was given under, which is how each
// extension document keys what it decoded (picture-face.ts): a document that
// already holds the picture under the current scope says so (`held`) and is
// answered without the bytes.
import {
  MAX_PICTURE_BYTES,
  type PictureType,
  parsePictureUrl,
  pictureTypeOf,
} from "@onlay/protocol";
import { bytesToBase64 } from "../sw-capture";

export type PictureAnswer =
  | { ok: true; scope: string; type: PictureType; b64: string }
  | { ok: true; scope: string; held: true }
  | { ok: false };

/** What is kept per picture: its bytes, or a refusal. */
type Stored = { ok: true; type: PictureType; b64: string } | { ok: false };

export interface PicturePorts {
  /** A GET of a service path under the current account; null when it couldn't be made. */
  get(path: string): Promise<Response | null>;
  /**
   * The scope a picture is held under now: the account's generation and the
   * access revision of its space (`spaceId` null for one's own picture).
   */
  scope(spaceId: string | null): Promise<string>;
  /** The space is among the person's spaces now. */
  hasSpace(spaceId: string): boolean;
  now(): number;
}

/** How many pictures stay cached, and how long a refusal is remembered. */
const MAX_CACHED = 200;
const MISS_MS = 60_000;

/** A body read only up to `max` bytes (a declared length over it is refused unread); else null. */
export async function readCapped(res: Response, max: number): Promise<Uint8Array | null> {
  const declared = res.headers.get("Content-Length");
  if (declared !== null && (!/^\d+$/.test(declared) || Number(declared) > max)) {
    await res.body?.cancel();
    return null;
  }
  if (res.body === null) return new Uint8Array(0);
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    length += value.byteLength;
    if (length > max) {
      await reader.cancel();
      return null;
    }
    chunks.push(value);
  }
  const out = new Uint8Array(length);
  let at = 0;
  for (const chunk of chunks) {
    out.set(chunk, at);
    at += chunk.byteLength;
  }
  return out;
}

export function createPictures(ports: PicturePorts) {
  const cache = new Map<string, { stored: Stored; spaceId: string | null; at: number }>();
  const inFlight = new Map<string, { spaceId: string | null; done: Promise<Stored> }>();
  const NO: Stored = { ok: false };

  /** The space is still the person's (one's own picture has none). */
  const theirs = (spaceId: string | null): boolean => spaceId === null || ports.hasSpace(spaceId);

  async function fetchOne(path: string, spaceId: string | null, scope: string) {
    const res = await ports.get(path);
    if (!res?.ok) {
      await res?.body?.cancel();
      return { stored: NO, keep: true };
    }
    const bytes = await readCapped(res, MAX_PICTURE_BYTES);
    // The account or the access moved while the body was read, or the space
    // left the person's list: not this scope's.
    if ((await ports.scope(spaceId)) !== scope || !theirs(spaceId))
      return { stored: NO, keep: false };
    const type = bytes === null ? null : pictureTypeOf(bytes);
    if (bytes === null || type === null) return { stored: NO, keep: true };
    return { stored: { ok: true, type, b64: bytesToBase64(bytes) } as Stored, keep: true };
  }

  function answer(stored: Stored, scope: string, held: unknown): PictureAnswer {
    if (!stored.ok) return { ok: false };
    if (held === scope) return { ok: true, scope, held: true };
    return { ok: true, scope, type: stored.type, b64: stored.b64 };
  }

  return {
    /**
     * The picture at `url`, or `{ok: false}` for anything that is not one or
     * whose space is not the person's now. `held`: the scope the asking
     * document already decoded it under.
     */
    async get(url: unknown, held?: unknown): Promise<PictureAnswer> {
      if (typeof url !== "string") return { ok: false };
      const path = parsePictureUrl(url);
      if (path === null) return { ok: false };
      const spaceId = path.kind === "space" ? path.spaceId : null;
      if (!theirs(spaceId)) return { ok: false };
      const scope = await ports.scope(spaceId);
      if (!theirs(spaceId)) return { ok: false };
      const key = `${scope}|${url}`;
      const hit = cache.get(key);
      if (hit && (hit.stored.ok || ports.now() - hit.at < MISS_MS)) {
        // Most recently used last.
        cache.delete(key);
        cache.set(key, hit);
        return answer(hit.stored, scope, held);
      }
      let pending = inFlight.get(key)?.done;
      if (!pending) {
        const done = fetchOne(url, spaceId, scope)
          .then((r) => {
            // Not kept when the space left meanwhile (`retain` dropped the flight).
            if (r.keep && inFlight.get(key)?.done === done)
              cache.set(key, { stored: r.stored, spaceId, at: ports.now() });
            return r.stored;
          })
          .catch((): Stored => NO)
          .finally(() => {
            if (inFlight.get(key)?.done === done) inFlight.delete(key);
          });
        inFlight.set(key, { spaceId, done });
        pending = done;
      }
      const stored = await pending;
      while (cache.size > MAX_CACHED) {
        const oldest = cache.keys().next().value;
        if (oldest === undefined) break;
        cache.delete(oldest);
      }
      // The space may have left the person's list while it was fetched.
      if (!theirs(spaceId)) return { ok: false };
      return answer(stored, scope, held);
    },
    /** Keep only the pictures of these spaces (and one's own): the person's spaces now. */
    retain(spaceIds: Iterable<string>): void {
      const keep = new Set(spaceIds);
      for (const [key, v] of cache)
        if (v.spaceId !== null && !keep.has(v.spaceId)) cache.delete(key);
      for (const [key, v] of inFlight)
        if (v.spaceId !== null && !keep.has(v.spaceId)) inFlight.delete(key);
    },
    /** Forget every picture (sign-out, an account change, an access change). */
    clear(): void {
      cache.clear();
      inFlight.clear();
    },
  };
}
