/**
 * Edge → space (spec §5.1). `/s/<spaceId><path>` reaches the space's Durable
 * Object as `<path>` after the access check, with every inbound `X-Onlay-*`
 * header stripped and two added: `X-Onlay-Caller` (who asks) and
 * `X-Onlay-Space` (the space's kind and name, for `welcome` and listings).
 * Credentials (cookie, Authorization, the bearer subprotocol entry) stop
 * here; `Onlay-Protocol` and the `onlay.v1` subprotocol pass through. A
 * client request never reaches `/internal/*`: only `directory/notify.ts`
 * calls those, with `X-Onlay-Internal: 1`.
 */
import {
  CALLER_HEADER,
  type Caller,
  type CallerAccess,
  type ClientClass,
  encodeCaller,
  isSpaceId,
  LIMITS,
  PERSON_HEADER,
  SPACE_HEADER,
  spacePictureUrl,
  WS_BEARER_PREFIX,
  WS_SUBPROTOCOL,
} from "@onlay/protocol";
import type { SpaceStanding } from "../directory/access";
import { authorize } from "../directory/credentials";
import { aliasOf, type PersonRow } from "../directory/db";
import { Failure, notFound, signInRequired } from "../directory/failure";
import { deliverPending, spaceFactsHeader, spaceStub } from "../directory/notify";
import type { Env } from "../env";
import { type Identity, kindOf, resolveCaller, subprotocolsOf } from "./caller";
import { serviceOrigin } from "./hosts";
import { limit, WRITES_PER_MINUTE } from "./rate";

/**
 * The caller header's value for this person, class, access and credential in
 * one space: their picture through that space, and (a member's) their alias.
 */
export function callerFor(
  person: Pick<PersonRow, "id" | "name" | "initials" | "tint" | "email" | "picture_key">,
  clientClass: ClientClass,
  access: CallerAccess,
  credentialId: string,
  accessEpoch: number | undefined,
  credentialGeneration: number | undefined,
  spaceId: string,
): Caller {
  const alias = access.kind === "member" ? aliasOf(person.email) : undefined;
  return {
    personId: person.id,
    name: person.name,
    initials: person.initials,
    tint: person.tint,
    ...(person.picture_key
      ? { avatarUrl: spacePictureUrl(spaceId, person.id, person.picture_key) }
      : {}),
    ...(alias !== undefined ? { alias } : {}),
    class: clientClass,
    access,
    credentialId,
    ...(accessEpoch !== undefined ? { accessEpoch } : {}),
    ...(credentialGeneration !== undefined ? { credentialGeneration } : {}),
  };
}

/**
 * The one authorization decision (round 2, S1): the credential still live,
 * its person as they are now, and their standing and the epoch in these
 * spaces (all when `only` is absent), from one D1 batch. A dead credential
 * is `sign_in_required`.
 */
export async function authorizeIn(
  env: Env,
  identity: Identity,
  only?: string[],
): Promise<{ who: Identity; standings: SpaceStanding[] }> {
  const decided = await authorize(env.DB, identity.credential, only);
  if (decided === null) throw signInRequired();
  return {
    who: {
      ...identity,
      person: decided.credential.person,
      credentialGeneration: decided.credential.generation,
    },
    standings: decided.standings,
  };
}

/** The caller header for `who` in a space, from the standing `authorizeIn` read. */
function callerIn(who: Identity, standing: SpaceStanding): Caller {
  return callerFor(
    who.person,
    who.class,
    standing.access,
    who.credentialId,
    standing.epoch,
    who.credentialGeneration,
    standing.space.id,
  );
}

/** Headers forwarded to the space: inbound minus credentials and every `X-Onlay-*`. */
function forwardHeaders(
  request: Request,
  caller: Caller,
  facts: string,
  upgrade: boolean,
): Headers {
  const headers = new Headers();
  for (const [name, value] of request.headers) {
    const lower = name.toLowerCase();
    if (lower.startsWith("x-onlay-") || lower === "cookie" || lower === "authorization") continue;
    if (lower === "sec-websocket-protocol" || lower === PERSON_HEADER.toLowerCase()) continue;
    headers.set(name, value);
  }
  if (upgrade) {
    const offered = subprotocolsOf(request).filter((entry) => !entry.startsWith(WS_BEARER_PREFIX));
    if (offered.includes(WS_SUBPROTOCOL)) headers.set("Sec-WebSocket-Protocol", WS_SUBPROTOCOL);
  }
  headers.set(CALLER_HEADER, encodeCaller(caller));
  headers.set(SPACE_HEADER, facts);
  return headers;
}

const SPACE_PATH = /^\/s\/([^/]+)(\/.*)?$/;

/** The web app's `person` query parameter on a WebSocket upgrade. */
const PERSON_PARAM = "person";

const PERSON_CHANGED =
  "Someone else signed in on this browser. Reload to continue as them, or sign in again.";

/**
 * A stale web app tab acting under the next person's cookie (addition B):
 * when a cookie-signed request names, by `Onlay-Person` (or `?person=` on an
 * upgrade), someone other than the session's person, it is refused and
 * nothing else happens. No hint: as before.
 */
export function checkPersonHint(request: Request, identity: Identity, upgrade: boolean): void {
  if (!identity.session) return;
  const hint = upgrade
    ? new URL(request.url).searchParams.get(PERSON_PARAM)
    : request.headers.get(PERSON_HEADER);
  if (hint === null || hint === identity.person.id) return;
  throw new Failure("sign_in_required", PERSON_CHANGED, "person-changed");
}

/** The space said the caller's access epoch is behind what it has been told. */
async function isStale(response: Response): Promise<boolean> {
  if (response.status !== 409) return false;
  try {
    const body = (await response.clone().json()) as { error?: { reason?: string } };
    return body.error?.reason === "stale-access";
  } catch {
    return false;
  }
}

/** `ANY /s/:spaceId/*` and `GET /s/:spaceId/ws`; null when the path is not a space path. */
export async function handleSpace(
  request: Request,
  env: Env,
  url: URL,
): Promise<{ response: Response; identity: Identity | null } | null> {
  const match = SPACE_PATH.exec(url.pathname);
  if (match === null) return null;
  const spaceId = match[1] ?? "";
  const rest = match[2] ?? "/";
  const upgrade = (request.headers.get("Upgrade") ?? "").toLowerCase() === "websocket";
  const kind = upgrade ? "upgrade" : kindOf(request);
  const identity = await resolveCaller(request, env, kind);
  if (identity === null) throw signInRequired();
  checkPersonHint(request, identity, upgrade);
  // The path is set, never resolved: `//host/…` stays a path, not a new origin.
  const target = new URL(url.origin);
  target.pathname = rest;
  target.search = url.search;
  // The person hint stops here, like the credentials.
  if (upgrade) target.searchParams.delete(PERSON_PARAM);
  // The control routes are the Worker's alone; no space route starts with `//`.
  const inner = target.pathname;
  if (
    !isSpaceId(spaceId) ||
    inner.startsWith("//") ||
    inner === "/internal" ||
    inner.startsWith("/internal/")
  )
    throw notFound();
  const hasBody = request.method !== "GET" && request.method !== "HEAD";
  // Size-checked BEFORE anything is buffered (round 2, S15), then buffered
  // once so a forward refused as stale can be sent again.
  const body = hasBody
    ? await boundedBody(request, bodyLimitFor(request.method, inner))
    : undefined;
  const forward = async (): Promise<Response> => {
    const { who, standings } = await authorizeIn(env, identity, [spaceId]);
    const standing = standings[0];
    if (standing === undefined) throw notFound();
    // The space is owed control calls: deliver them before it sees this caller.
    if (standing.pending) await deliverPending(env, spaceId, request.signal);
    const forwarded = new Request(target, {
      method: request.method,
      headers: forwardHeaders(
        request,
        callerIn(who, standing),
        spaceFactsHeader(standing.space),
        upgrade,
      ),
      ...(body !== undefined ? { body } : {}),
      redirect: "manual",
    });
    return spaceStub(env, spaceId).fetch(forwarded);
  };
  if (!upgrade && kindOf(request) === "write") {
    await limit(env.DB, `write:${identity.person.id}`, WRITES_PER_MINUTE);
  }
  let response = await forward();
  if (await isStale(response)) {
    // The space knows of a newer access epoch: decide again from one batch
    // (a revoked credential now fails here) and try once more.
    await response.body?.cancel();
    response = await forward();
  }
  return { response, identity };
}

/**
 * One GET into a space as this caller (the inbox and origins fan-outs, share
 * checks), with the standing `authorizeIn` decided. `signal` aborts the call
 * itself at the caller's deadline (round 2, S16).
 */
export async function getFromSpace(
  env: Env,
  who: Identity,
  standing: SpaceStanding,
  path: string,
  signal?: AbortSignal,
): Promise<Response> {
  const spaceId = standing.space.id;
  if (standing.pending) await deliverPending(env, spaceId, signal);
  const send = (as: Identity, facts: SpaceStanding) =>
    spaceStub(env, spaceId).fetch(
      new Request(`${serviceOrigin(env)}${path}`, {
        headers: {
          [CALLER_HEADER]: encodeCaller(callerIn(as, facts)),
          [SPACE_HEADER]: spaceFactsHeader(facts.space),
        },
        ...(signal ? { signal } : {}),
      }),
    );
  const response = await send(who, standing);
  if (!(await isStale(response))) return response;
  await response.body?.cancel();
  const again = await authorizeIn(env, who, [spaceId]);
  const fresh = again.standings[0];
  if (fresh === undefined) throw notFound();
  return send(again.who, fresh);
}

/* ── the bounded body (round 2, S15) ──────────────────────────────── */

/** JSON routes: a full variant set fits with its envelope. */
const JSON_MAX_BYTES = 1_572_864;
/** A capture part PUT: the part limit and room for the request's own framing. */
const PART_MAX_BYTES = LIMITS.MAX_CAPTURE_PART_BYTES + 65_536;
/** Markup uploads: the space's own limits for them (`BODY_LIMITS` in space/routes.ts). */
const ANCHOR_MARKUP_MAX_BYTES = 6 * LIMITS.MAX_ANCHOR_CONTENT + 4_096;
const PAGE_MARKUP_MAX_BYTES = 6 * LIMITS.MAX_PAGE_CONTENT + 4_096;

const CAPTURE_PART = /^\/interaction\/[^/]+\/capture\/[^/]+\/part\/[^/]+$/;
const MARKUP = /^\/interaction\/[^/]+\/(anchor|page)-content$/;

/** How many bytes a forwarded body may carry on this route. */
function bodyLimitFor(method: string, path: string): number {
  if (method === "PUT" && CAPTURE_PART.test(path)) return PART_MAX_BYTES;
  const markup = MARKUP.exec(path);
  if (markup) return markup[1] === "page" ? PAGE_MARKUP_MAX_BYTES : ANCHOR_MARKUP_MAX_BYTES;
  return JSON_MAX_BYTES;
}

const TOO_LARGE = "This request is larger than Onlay accepts for it.";

/**
 * The body, read with one bounded reader: a declared length over `max`, or a
 * stream that passes it, is `invalid`/`too-large` and nothing is forwarded.
 */
async function boundedBody(request: Request, max: number): Promise<ArrayBuffer | undefined> {
  const declared = Number(request.headers.get("Content-Length") ?? Number.NaN);
  if (Number.isFinite(declared) && declared > max)
    throw new Failure("invalid", TOO_LARGE, "too-large");
  if (request.body === null) return undefined;
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > max) {
      await reader.cancel();
      throw new Failure("invalid", TOO_LARGE, "too-large");
    }
    chunks.push(value);
  }
  const out = new Uint8Array(size);
  let at = 0;
  for (const chunk of chunks) {
    out.set(chunk, at);
    at += chunk.byteLength;
  }
  return out.buffer;
}
