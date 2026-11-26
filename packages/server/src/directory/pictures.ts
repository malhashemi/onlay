/**
 * People's pictures in the directory: Onlay's own copy of each person's
 * sign-in provider picture (fetched at sign-in) and of the one they upload,
 * in `person_pictures`, and which of them shows (`people.picture_choice`).
 * Clients load only Onlay's copy, from the service origin (see
 * `@onlay/protocol` `picture.ts`), never the provider's address.
 *
 * The provider's address is hostile input. It is fetched only when it is
 * `https:` on a host listed in `PROVIDER_PICTURE_HOSTS`, on the default port
 * and without credentials; a redirect is followed (at most twice) only to
 * another address that passes the same rules; the whole fetch has
 * `FETCH_DEADLINE_MS`; the body is read only up to `MAX_PICTURE_BYTES`; and
 * the bytes must be a PNG, JPEG or WebP by their own header
 * (`pictureTypeOf`). Any failure keeps what was there (the person's initials
 * when nothing was), and the next sign-in tries again.
 */
import { MAX_PICTURE_BYTES, type MeProfile, type PictureType } from "@onlay/protocol";
import type { Env } from "../env";
import { blobBytes, pictureTypeOf } from "../space/picture";
import { randomBytes } from "./crypto";
import { aliasOf, guard, IS_LIVE, type PersonRow } from "./db";
import { Failure, isGuard, notFound } from "./failure";
import { deliver, enqueueForPersonSpaces, returnedIds } from "./notify";

/**
 * Where WorkOS's providers' pictures live. Evidence: WorkOS's User object
 * reference and its Google OAuth guide both give `profile_picture_url` on
 * `workoscdn.com` (WorkOS serves the provider's picture itself). No other host
 * is documented; add one here only with evidence of WorkOS sending it.
 */
export const PROVIDER_PICTURE_HOSTS: readonly string[] = ["workoscdn.com"];

/** The whole provider fetch, redirects and body included. */
export const FETCH_DEADLINE_MS = 3_000;
const MAX_REDIRECTS = 2;

export interface Picture {
  type: PictureType;
  bytes: Uint8Array;
}

/** An address the Worker may fetch a provider's picture from, or null. */
function allowedPictureUrl(raw: string, base?: URL): URL | null {
  let url: URL;
  try {
    url = base ? new URL(raw, base) : new URL(raw);
  } catch {
    return null;
  }
  if (url.protocol !== "https:" || url.username !== "" || url.password !== "") return null;
  if (url.port !== "") return null;
  if (!PROVIDER_PICTURE_HOSTS.includes(url.hostname.toLowerCase())) return null;
  return url;
}

/** The host of an address, for a log line (never its path or query). */
function hostOf(raw: string): string {
  try {
    return new URL(raw).hostname || "(none)";
  } catch {
    return "(unparsable)";
  }
}

/**
 * The provider's picture at `raw`, checked, or null with the reason logged.
 * `fetcher` is the global fetch; tests pass a stand-in.
 */
export async function fetchProviderPicture(
  raw: string,
  fetcher: typeof fetch = fetch,
  deadlineMs = FETCH_DEADLINE_MS,
): Promise<Picture | null> {
  const first = allowedPictureUrl(raw);
  if (first === null) {
    console.warn(`picture: the provider's picture on ${hostOf(raw)} is not fetched (not allowed)`);
    return null;
  }
  let url: URL = first;
  const signal = AbortSignal.timeout(deadlineMs);
  try {
    for (let hop = 0; ; hop += 1) {
      const res = await fetcher(url.toString(), {
        redirect: "manual",
        signal,
        headers: { Accept: "image/webp,image/png,image/jpeg" },
      });
      if (res.status >= 300 && res.status < 400) {
        await res.body?.cancel();
        const location = res.headers.get("Location") ?? "";
        const next: URL | null = location.trim() === "" ? null : allowedPictureUrl(location, url);
        if (next === null || hop >= MAX_REDIRECTS) {
          console.warn(`picture: a redirect from ${url.hostname} is not followed`);
          return null;
        }
        url = next;
        continue;
      }
      if (!res.ok) {
        await res.body?.cancel();
        console.warn(`picture: ${url.hostname} answered ${res.status}`);
        return null;
      }
      const bytes = await readAtMost(res, MAX_PICTURE_BYTES);
      if (bytes === null) {
        console.warn(`picture: the picture on ${url.hostname} is over ${MAX_PICTURE_BYTES} bytes`);
        return null;
      }
      const type = pictureTypeOf(bytes);
      if (type === null) {
        console.warn(`picture: the picture on ${url.hostname} is not a PNG, JPEG or WebP`);
        return null;
      }
      return { type, bytes };
    }
  } catch (error) {
    console.warn(
      `picture: fetching from ${url.hostname} failed`,
      error instanceof Error ? error.name : "error",
    );
    return null;
  }
}

/** A response body up to `max` bytes (a declared length over it is refused unread), else null. */
async function readAtMost(res: Response, max: number): Promise<Uint8Array | null> {
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

const BASE32 = "abcdefghijklmnopqrstuvwxyz234567";

/** A fresh key for a stored copy: 16 base32 characters (80 bits). */
function newPictureKey(): string {
  let out = "";
  for (const byte of randomBytes(16)) out += BASE32[byte & 31];
  return out;
}

function upsert(
  db: D1Database,
  personId: string,
  source: "provider" | "own",
  picture: Picture,
  sourceUrl: string | null,
): D1PreparedStatement {
  return db
    .prepare(
      `INSERT INTO person_pictures (person_id, source, key, type, bytes, source_url, created_at)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)
       ON CONFLICT (person_id, source) DO UPDATE SET key = excluded.key, type = excluded.type,
         bytes = excluded.bytes, source_url = excluded.source_url, created_at = excluded.created_at`,
    )
    .bind(personId, source, newPictureKey(), picture.type, picture.bytes, sourceUrl, Date.now());
}

/**
 * At sign-in: Onlay's copy of the provider's picture follows the address
 * WorkOS gives. Fetched only when that address differs from the one the
 * copy came from; a failure keeps the copy there is. `guards` are the MCP
 * token's rules (`people.ts`), so a refused token writes nothing. Returns
 * the outbox rows to deliver (every space shows the person anew).
 */
export async function syncProviderPicture(
  env: Env,
  person: Pick<PersonRow, "id" | "email">,
  address: string | undefined,
  guards: D1PreparedStatement[] = [],
): Promise<string[]> {
  if (address === undefined || address === "" || person.email === null) return [];
  const db = env.DB;
  const held = await db
    .prepare("SELECT source_url FROM person_pictures WHERE person_id = ? AND source = 'provider'")
    .bind(person.id)
    .first<{ source_url: string | null }>();
  if (held !== null && held.source_url === address) return [];
  const picture = await fetchProviderPicture(address);
  if (picture === null) return [];
  // Written only for a live person (a late fetch never revives a deleted one).
  const results = await db.batch([
    ...guards,
    ...guard(db, "live", IS_LIVE, [person.id]),
    upsert(db, person.id, "provider", picture, address),
    enqueueForPersonSpaces(db, { id: person.id, email: person.email }, "person", {
      personId: person.id,
    }),
  ]);
  return returnedIds(results, [guards.length + 3]);
}

/* ── the person's own choice (Settings → Account) ─────────────────── */

const NOT_A_PICTURE = "Choose a PNG, JPEG or WebP image up to 64 KB and 1024×1024 pixels.";

/** `PUT /api/me/picture`: the person's own picture, shown from now on in every space. */
export async function uploadPicture(
  env: Env,
  person: PersonRow & { email: string },
  bytes: Uint8Array,
): Promise<void> {
  const type = pictureTypeOf(bytes);
  if (type === null) throw new Failure("invalid", NOT_A_PICTURE, "not-a-picture");
  const db = env.DB;
  let results: D1Result[];
  try {
    results = await db.batch([
      ...guard(db, "live", IS_LIVE, [person.id]),
      upsert(db, person.id, "own", { type, bytes }, null),
      db.prepare("UPDATE people SET picture_choice = 'own' WHERE id = ?").bind(person.id),
      enqueueForPersonSpaces(db, person, "person", { personId: person.id }),
    ]);
  } catch (error) {
    // The account was deleted while the upload was on its way.
    if (isGuard(error, "live")) throw notFound();
    throw error;
  }
  await deliver(env, returnedIds(results, [4]));
}

/**
 * `PATCH /api/me {picture}`: `provider` goes back to the sign-in provider's
 * picture (initials while Onlay holds none), `none` shows initials. Either
 * forgets the person's own upload.
 */
export async function choosePicture(
  env: Env,
  person: PersonRow & { email: string },
  choice: "provider" | "none",
): Promise<void> {
  const db = env.DB;
  let results: D1Result[];
  try {
    results = await db.batch([
      // Only a live person's choice: a deletion that won the race stays a tombstone.
      ...guard(db, "live", IS_LIVE, [person.id]),
      db
        .prepare("DELETE FROM person_pictures WHERE person_id = ? AND source = 'own'")
        .bind(person.id),
      db
        .prepare("UPDATE people SET picture_choice = ? WHERE id = ? AND deleted_at IS NULL")
        .bind(choice === "none" ? "none" : null, person.id),
      enqueueForPersonSpaces(db, person, "person", { personId: person.id }),
    ]);
  } catch (error) {
    if (isGuard(error, "live")) throw notFound();
    throw error;
  }
  await deliver(env, returnedIds(results, [4]));
}

/**
 * The picture this person shows now, by its key, type re-checked; null for
 * anything else: a deleted person, a key of a copy they no longer show (a
 * provider copy hidden by an upload or by initials, an upload put away), or
 * a key of nothing. Both picture routes read through it.
 */
export async function pictureByKey(
  db: D1Database,
  personId: string,
  key: string,
): Promise<Picture | null> {
  const row = await db
    .prepare(
      `SELECT pp.type, pp.bytes FROM person_pictures pp JOIN people p ON p.id = pp.person_id
       WHERE pp.person_id = ? AND pp.key = ? AND p.deleted_at IS NULL
         AND pp.source = coalesce(p.picture_choice, 'provider')`,
    )
    .bind(personId, key)
    .first<{ type: string; bytes: unknown }>();
  if (row === null) return null;
  const bytes = blobBytes(row.bytes);
  if (bytes === null) return null;
  const type = pictureTypeOf(bytes);
  return type !== null && type === row.type ? { type, bytes } : null;
}

/** Where the person's name and picture come from, for Settings. */
export async function profileOf(db: D1Database, person: PersonRow): Promise<MeProfile> {
  const provider = await db
    .prepare("SELECT 1 AS held FROM person_pictures WHERE person_id = ? AND source = 'provider'")
    .bind(person.id)
    .first<{ held: number }>();
  const choice = person.picture_choice;
  const nameSet = person.name_set_at != null;
  return {
    nameSet,
    nameFromEmail: !nameSet && person.name === aliasOf(person.email),
    picture: choice === "own" ? "own" : choice === "none" ? "none" : "provider",
    providerPicture: provider !== null,
  };
}
