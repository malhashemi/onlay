/**
 * The caller — who the edge says is asking, as the space trusts it (spec §5.1).
 *
 * The Worker resolves the credential, checks access to the space, strips
 * every inbound `X-Onlay-*` header, and forwards exactly one: `X-Onlay-Caller`,
 * base64url of the caller's JSON. The space's Durable Object trusts this
 * header and nothing else. The client class is derived from the credential,
 * never claimed by the client.
 *
 * Also here: the wire constants every client and the edge share (headers,
 * cookie, subprotocols, socket close codes) and the one error table.
 */
import * as z from "zod/mini";
import { LIMITS } from "./limits";
import { bounded } from "./schema-helpers";
import { MemberRoleSchema, PersonIdSchema, SpaceKindSchema } from "./space";

/* ── client class ─────────────────────────────────────────────────── */

/**
 * full = the extension (holds a live page); interaction = the web app (no
 * page under it); agent = an MCP client acting as its person.
 */
export const CLIENT_CLASSES = ["full", "interaction", "agent"] as const;
export const ClientClassSchema = z.enum(CLIENT_CLASSES);
export type ClientClass = (typeof CLIENT_CLASSES)[number];

/* ── the caller header ────────────────────────────────────────────── */

/**
 * A member sees the whole space; a guest sees only the interactions shared
 * with them there.
 */
export const CallerAccessSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("member"), role: MemberRoleSchema }),
  z.object({
    kind: z.literal("guest"),
    /** A guest holds at least one share in the space, or has no access at all. */
    interactionIds: z
      .array(z.uuid())
      .check(z.minLength(1), z.maxLength(LIMITS.MAX_INTERACTIONS_PER_STATE)),
  }),
]);
export type CallerAccess = z.infer<typeof CallerAccessSchema>;

export const CallerSchema = z.object({
  personId: PersonIdSchema,
  name: bounded(LIMITS.MAX_ACTOR_NAME),
  initials: bounded(LIMITS.MAX_INITIALS),
  tint: bounded(LIMITS.MAX_COLOR),
  /** The caller's picture in this space (`spacePictureUrl`); absent: their initials. */
  avatarUrl: z.optional(bounded(LIMITS.MAX_URL)),
  /** The caller's alias (their email's local part), which the space shows only to members. */
  alias: z.optional(bounded(LIMITS.MAX_ALIAS)),
  class: ClientClassSchema,
  access: CallerAccessSchema,
  /** The session or client-token id: keys per-client state (durable sessions, push). */
  credentialId: z.string().check(z.minLength(1), z.maxLength(LIMITS.MAX_ID)),
  /**
   * The space's access epoch the edge read together with `access`. A space
   * that has been told of a newer epoch refuses the request as stale
   * (`conflict`, reason `stale-access`) and the edge re-reads and retries.
   */
  accessEpoch: z.optional(z.number().check(z.int(), z.gte(0))),
  /**
   * The person's credential generation the credential was stamped with when
   * it was issued (for an agent, the person's current generation, read in the
   * edge's authorization batch). Sign out everywhere, an email or WorkOS
   * subject change and account deletion advance the generation in the batch
   * that deletes the person's credentials; a space refuses a caller whose
   * generation is below the person's minimum it was told of.
   */
  credentialGeneration: z.optional(z.number().check(z.int(), z.gte(0))),
});
export type Caller = z.infer<typeof CallerSchema>;

/** Generous ceiling on the encoded header: a guest's id list dominates it. */
const MAX_CALLER_HEADER = 65_536;

const B64URL = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
const B64URL_RE = /^[A-Za-z0-9_-]*$/;

/** JSON with every non-ASCII code unit escaped, so the text is pure ASCII bytes. */
function asciiJson(value: unknown): string {
  return JSON.stringify(value).replace(
    /[\u0080-￿]/g,
    (ch) => `\\u${ch.charCodeAt(0).toString(16).padStart(4, "0")}`,
  );
}

function base64urlFromAscii(s: string): string {
  let out = "";
  for (let i = 0; i < s.length; i += 3) {
    const a = s.charCodeAt(i);
    const b = i + 1 < s.length ? s.charCodeAt(i + 1) : -1;
    const c = i + 2 < s.length ? s.charCodeAt(i + 2) : -1;
    const n = (a << 16) | ((b < 0 ? 0 : b) << 8) | (c < 0 ? 0 : c);
    out += B64URL[(n >> 18) & 63];
    out += B64URL[(n >> 12) & 63];
    if (b >= 0) out += B64URL[(n >> 6) & 63];
    if (c >= 0) out += B64URL[n & 63];
  }
  return out;
}

/** Decodes to an ASCII string, or null on a bad length or a non-ASCII byte. */
function asciiFromBase64url(s: string): string | null {
  if (!B64URL_RE.test(s) || s.length % 4 === 1) return null;
  let out = "";
  for (let i = 0; i < s.length; i += 4) {
    const chunk = s.slice(i, i + 4);
    let n = 0;
    for (let j = 0; j < 4; j++)
      n = (n << 6) | (j < chunk.length ? B64URL.indexOf(chunk[j] ?? "") : 0);
    const bytes = [(n >> 16) & 255, (n >> 8) & 255, n & 255].slice(0, chunk.length - 1);
    for (const byte of bytes) {
      if (byte > 127) return null;
      out += String.fromCharCode(byte);
    }
  }
  return out;
}

export function encodeCaller(caller: Caller): string {
  return base64urlFromAscii(asciiJson(caller));
}

/** The validated caller, or null for anything malformed. */
export function decodeCaller(header: string): Caller | null {
  if (header.length === 0 || header.length > MAX_CALLER_HEADER) return null;
  const text = asciiFromBase64url(header);
  if (text === null) return null;
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    return null;
  }
  const r = z.safeParse(CallerSchema, data);
  return r.success ? r.data : null;
}

/** What the edge tells a space about itself on every forward (`X-Onlay-Space`). */
export const SpaceFactsSchema = z.object({
  kind: SpaceKindSchema,
  name: z.string().check(z.minLength(1), z.maxLength(LIMITS.MAX_ACTOR_NAME)),
});
export type SpaceFacts = z.infer<typeof SpaceFactsSchema>;

export function encodeSpaceFacts(facts: SpaceFacts): string {
  return base64urlFromAscii(asciiJson({ kind: facts.kind, name: facts.name }));
}

/** The validated space facts, or null for anything malformed. */
export function decodeSpaceFacts(header: string | null): SpaceFacts | null {
  if (!header || header.length > 1_024) return null;
  const text = asciiFromBase64url(header);
  if (text === null) return null;
  try {
    const r = z.safeParse(SpaceFactsSchema, JSON.parse(text));
    return r.success ? r.data : null;
  } catch {
    return null;
  }
}

/* ── wire constants ───────────────────────────────────────────────── */

/** Edge → space: the only header the Durable Object trusts. */
export const CALLER_HEADER = "X-Onlay-Caller";
/** Edge → space: the space's kind and name (`encodeSpaceFacts`), on every forward. */
export const SPACE_HEADER = "X-Onlay-Space";
/** Edge → space: `1` marks a call to an internal control route, made by the Worker alone. */
export const INTERNAL_HEADER = "X-Onlay-Internal";
/**
 * Edge → space, on `/internal/*` only: the space's access epoch after the
 * directory change the control call reports.
 */
export const ACCESS_EPOCH_HEADER = "X-Onlay-Access-Epoch";
/**
 * Web app → edge: the person the tab believes is signed in. A cookie request
 * whose session belongs to someone else is `sign_in_required` (reason
 * `person-changed`). On a WebSocket upgrade it rides the `person` query
 * parameter instead.
 */
export const PERSON_HEADER = "Onlay-Person";
/** Every client names its protocol version on every HTTP request. */
export const PROTOCOL_HEADER = "Onlay-Protocol";
/** Required, with a same-origin `Origin`, for cookie-authenticated writes. */
export const CSRF_HEADER = "Onlay-CSRF";
/** The web app's session cookie. */
export const SESSION_COOKIE = "__Host-onlay.session";
/** First WebSocket subprotocol entry; the second carries the bearer token. */
export const WS_SUBPROTOCOL = "onlay.v1";
export const WS_BEARER_PREFIX = "bearer.";
/** Extension client tokens: `onl_` + 43 base64url chars. */
export const CLIENT_TOKEN_PREFIX = "onl_";
export const ClientTokenSchema = z.string().check(z.regex(/^onl_[A-Za-z0-9_-]{43}$/));

/** Socket close: the client's protocol is below `MIN_CLIENT_PROTOCOL`. */
export const CLOSE_UPGRADE_REQUIRED = 4426;
/** Socket close: the person lost access to this space (or the space is gone). */
export const CLOSE_ACCESS_REVOKED = 4403;

/* ── errors (spec §5) ─────────────────────────────────────────────── */

/**
 * One table for every edge and space error. Missing and unreadable are the
 * same answer: a signed-in caller gets `not_found`, a visitor `sign_in_required`.
 */
export const API_ERROR_STATUS = {
  invalid: 400,
  sign_in_required: 401,
  forbidden: 403,
  not_found: 404,
  conflict: 409,
  last_admin: 409,
  upgrade_required: 426,
  rate_limited: 429,
  unavailable: 503,
} as const;
export type ApiErrorCode = keyof typeof API_ERROR_STATUS;
export const API_ERROR_CODES = Object.keys(API_ERROR_STATUS) as ApiErrorCode[];

export const ApiErrorSchema = z.object({
  error: z.object({
    code: z.enum(API_ERROR_CODES as [ApiErrorCode, ...ApiErrorCode[]]),
    message: bounded(LIMITS.MAX_OPTION_DESC),
    /** A machine tag refining the code (e.g. `url-mismatch`, `quota`), when one helps a client. */
    reason: z.optional(bounded(LIMITS.MAX_TAG)),
  }),
});
export type ApiError = z.infer<typeof ApiErrorSchema>;

export function apiError(code: ApiErrorCode, message: string, reason?: string): ApiError {
  return { error: { code, message, ...(reason !== undefined ? { reason } : {}) } };
}
