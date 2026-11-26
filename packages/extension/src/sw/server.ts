// The hosted service's address and the HTTP conventions every call shares
// (spec §5, §10). The origin is a build-time constant (`https://app.onlay.dev`
// unless the build sets ONLAY_SERVER_ORIGIN) that dev and e2e override through
// `chrome.storage.local.serverOrigin`. The public site (`/install`, the
// landing page) is a second constant, `https://onlay.dev` unless the build
// sets ONLAY_SITE_ORIGIN. Pure helpers; the service worker owns the storage
// reads.
import { PROTOCOL_HEADER, PROTOCOL_VERSION } from "@onlay/protocol";

declare const __ONLAY_SERVER_ORIGIN__: string | undefined;
declare const __ONLAY_SITE_ORIGIN__: string | undefined;
declare const __ONLAY_PRODUCTION__: boolean | undefined;

const FALLBACK_ORIGIN = "https://app.onlay.dev";
const FALLBACK_SITE_ORIGIN = "https://onlay.dev";

/** The origin baked into this build. */
export const BUILD_SERVER_ORIGIN: string =
  typeof __ONLAY_SERVER_ORIGIN__ === "string" && __ONLAY_SERVER_ORIGIN__
    ? __ONLAY_SERVER_ORIGIN__
    : FALLBACK_ORIGIN;

/** The public site's origin baked into this build. */
export const BUILD_SITE_ORIGIN: string =
  typeof __ONLAY_SITE_ORIGIN__ === "string" && __ONLAY_SITE_ORIGIN__
    ? __ONLAY_SITE_ORIGIN__
    : FALLBACK_SITE_ORIGIN;

/**
 * A production build (NODE_ENV=production) talks to its compiled origin only:
 * nothing written to storage can point it — and its token — anywhere else.
 */
const PRODUCTION_BUILD: boolean = typeof __ONLAY_PRODUCTION__ === "boolean" && __ONLAY_PRODUCTION__;

/** The chrome.storage.local key dev and e2e write to point the extension elsewhere. */
export const SERVER_ORIGIN_KEY = "serverOrigin";

/** An http(s) origin with no path, or null for anything else. */
export function normalizeOrigin(value: unknown): string | null {
  if (typeof value !== "string" || value.trim() === "") return null;
  try {
    const u = new URL(value.trim());
    if (u.protocol !== "https:" && u.protocol !== "http:") return null;
    return u.origin;
  } catch {
    return null;
  }
}

/**
 * The stored override when it is a valid origin, else the build's. A
 * production build ignores the override entirely.
 */
export function resolveOrigin(stored: unknown, production: boolean = PRODUCTION_BUILD): string {
  if (production) return BUILD_SERVER_ORIGIN;
  return normalizeOrigin(stored) ?? BUILD_SERVER_ORIGIN;
}

/**
 * The public site's origin. A stored server override (dev and e2e, never a
 * production build) is a server that serves everything on one origin, so its
 * site is itself.
 */
export function resolveSiteOrigin(stored: unknown, production: boolean = PRODUCTION_BUILD): string {
  if (production) return BUILD_SITE_ORIGIN;
  return normalizeOrigin(stored) ?? BUILD_SITE_ORIGIN;
}

/**
 * A stored token is used only with the origin that issued it: one with no
 * recorded issuer (an older or tampered store) or from another server is not.
 */
export function storedTokenUsable(
  token: unknown,
  tokenOrigin: unknown,
  origin: string,
): token is string {
  return typeof token === "string" && token !== "" && tokenOrigin === origin;
}

/** `/s/<spaceId><path>` on the server: every space route goes through the edge. */
export function spaceUrl(origin: string, spaceId: string, path: string): string {
  return `${origin}/s/${encodeURIComponent(spaceId)}${path}`;
}

/** The space's WebSocket: `ws(s)://<host>/s/<spaceId>/ws`. */
export function spaceSocketUrl(origin: string, spaceId: string): string {
  const u = new URL(origin);
  const scheme = u.protocol === "https:" ? "wss:" : "ws:";
  return `${scheme}//${u.host}/s/${encodeURIComponent(spaceId)}/ws`;
}

/** The web app's link to one thread (spec §4). */
export function threadLink(origin: string, spaceId: string, interactionId: string): string {
  return `${origin}/app/#/t/${spaceId}/${interactionId}`;
}

/** Headers for an authenticated call: the bearer token and the protocol version. */
export function authHeaders(token: string | null, json = false): Record<string, string> {
  const h: Record<string, string> = { [PROTOCOL_HEADER]: String(PROTOCOL_VERSION) };
  if (token) h.authorization = `Bearer ${token}`;
  if (json) h["content-type"] = "application/json";
  return h;
}
