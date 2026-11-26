/**
 * The hosted onlay Worker (spec §5, §12): the edge in front of every space.
 * Sign-in, the caller, the directory API, routing into each space's Durable
 * Object, rate limits and static assets land here; each space's state lives
 * in its Durable Object.
 */
import { type HealthzResponse, PROTOCOL_HEADER, PROTOCOL_VERSION } from "@onlay/protocol";
import { type Later, laterOf, retryAgentAccessRemovals } from "./directory/agent-access";
import { renewSession, sweep } from "./directory/credentials";
import { Failure, failureResponse, isGuard, NOT_FOUND } from "./directory/failure";
import { deliverDue } from "./directory/notify";
import { handleApi } from "./edge/api";
import { serveApp } from "./edge/assets";
import { handleAuth } from "./edge/auth";
import { type Identity, resolveSessionCaller } from "./edge/caller";
import { canonicalOrigin, hostOf, originsOf } from "./edge/hosts";
import { redirect, sessionCookie, withHeader } from "./edge/http";
import { isLandingAsset, serveLanding, serveSiteAsset } from "./edge/landing";
import { handlePublicPage, isOldAppPath, isPublicPage, retireOldAppStorage } from "./edge/site";
import { handleSpace } from "./edge/space";
import type { Env } from "./env";
import { handleWellKnown } from "./mcp/auth";
import { handleMcp } from "./mcp/endpoint";

export { SpaceDO } from "./space-do";

/** `Onlay-Protocol` below `MIN_CLIENT_PROTOCOL` is `upgrade_required`; absent is allowed. */
function checkProtocol(request: Request, env: Env): void {
  const raw = request.headers.get(PROTOCOL_HEADER);
  if (raw === null) return;
  const min = Number.parseInt(env.MIN_CLIENT_PROTOCOL, 10) || PROTOCOL_VERSION;
  const n = /^\d{1,6}$/.test(raw.trim()) ? Number(raw.trim()) : Number.NaN;
  if (!(n >= min)) {
    throw new Failure(
      "upgrade_required",
      "This version of onlay is too old. Update it, then try again.",
    );
  }
}

/** Re-sends the session cookie when using it renewed the session. */
async function renewed(env: Env, identity: Identity | null, response: Response): Promise<Response> {
  if (!identity?.session || response.status === 101) return response;
  if (!(await renewSession(env.DB, identity.session))) return response;
  // Only the hash is stored; the browser's cookie is refreshed with the value it sent.
  return withHeader(response, "Set-Cookie", sessionCookie(identity.session.secret));
}

/**
 * `GET /` with one origin: a signed-in browser goes on to the web app; anyone
 * else (signing out of the web app lands here) gets the landing page.
 */
async function home(request: Request, env: Env, url: URL): Promise<Response> {
  if (request.method !== "GET" && request.method !== "HEAD") {
    return new Response(null, { status: 405, headers: { Allow: "GET, HEAD" } });
  }
  let signedIn = false;
  try {
    signedIn = (await resolveSessionCaller(request, env, "navigate")) !== null;
  } catch (error) {
    // Two session cookies: not signed in as anyone, so the landing page.
    if (!(error instanceof Failure)) throw error;
  }
  if (signedIn) {
    return new Response(null, {
      status: 302,
      headers: { Location: "/app/", "Cache-Control": "no-store" },
    });
  }
  return serveLanding(request, env, url);
}

const GET_OR_HEAD = { status: 405, headers: { Allow: "GET, HEAD" } } as const;

function isGetOrHead(request: Request): boolean {
  return request.method === "GET" || request.method === "HEAD";
}

function healthz(env: Env): Response {
  const body: HealthzResponse = { ok: true, sha: env.SHA ?? "dev", protocol: PROTOCOL_VERSION };
  // The newest extension on /download, so an unpacked install can tell it is behind.
  if (env.EXTENSION_VERSION) body.extension = env.EXTENSION_VERSION;
  return Response.json(body);
}

/**
 * The public site's host in two-origin mode: its pages, and nothing that
 * reads or sets a credential: the landing page at `/` and its files at
 * `/site/*`, the same for everyone. A browser navigating to the web app or to
 * sign-in is sent on to the service; every other path is `not_found`.
 * Everything under `/app` also retires the old web app's storage
 * (`retireOldAppStorage`); `/` never does.
 */
async function siteRoute(request: Request, env: Env, url: URL, service: string): Promise<Response> {
  const path = url.pathname;
  const page = await handlePublicPage(request, env, url);
  if (page !== null) return page;
  if (path === "/") return serveLanding(request, env, url);
  if (isLandingAsset(path)) return serveSiteAsset(request, env, url);
  if (isOldAppPath(path)) {
    // The old worker's update fetch: a 404 with the header is what removes it
    // (a script here would only be installed and run on the public site).
    if (path === "/app/sw.js" || !isGetOrHead(request)) {
      return retireOldAppStorage(failureResponse("not_found", NOT_FOUND));
    }
    return retireOldAppStorage(redirect(`${service}${path}${url.search}`));
  }
  if (path === "/auth/login" && isGetOrHead(request)) {
    return redirect(`${service}${path}${url.search}`);
  }
  return failureResponse("not_found", NOT_FOUND);
}

/**
 * `PUBLIC_ORIGIN` or `SITE_ORIGIN` is not exactly an origin: every request
 * gets a plain failure and no credential is read. The site's `/app` and
 * `/app/*` still retire the old web app's storage when `SITE_ORIGIN` itself
 * is valid, so a broken service setting never leaves that undone.
 */
function misconfigured(request: Request, env: Env): Response {
  console.error("PUBLIC_ORIGIN or SITE_ORIGIN is not a valid origin");
  const failure = failureResponse("unavailable", "Something went wrong.");
  const site = canonicalOrigin(env.SITE_ORIGIN ?? "");
  const url = new URL(request.url);
  if (site === null || url.origin !== site) return failure;
  if (!isOldAppPath(url.pathname)) return failure;
  return retireOldAppStorage(failure);
}

async function route(request: Request, env: Env, later: Later): Promise<Response> {
  const origins = originsOf(env);
  if (origins === null) return misconfigured(request, env);
  const url = new URL(request.url);
  const path = url.pathname;
  const host = hostOf(request, origins);
  // Not exactly a configured origin: never taken for the service, in either mode.
  if (host === "other") return failureResponse("not_found", NOT_FOUND);
  if (path === "/healthz") return healthz(env);
  if (host === "site") return siteRoute(request, env, url, origins.service);

  if (host === "service") {
    // One copy of each public page: the site's.
    if (isPublicPage(path)) {
      if (!isGetOrHead(request)) return new Response(null, GET_OR_HEAD);
      return redirect(`${origins.site ?? origins.service}${path}${url.search}`);
    }
    if (path === "/") {
      if (!isGetOrHead(request)) return new Response(null, GET_OR_HEAD);
      return redirect("/app/");
    }
  } else {
    const page = await handlePublicPage(request, env, url);
    if (page !== null) return page;
    if (path === "/") return home(request, env, url);
    if (isLandingAsset(path)) return serveSiteAsset(request, env, url);
  }

  if (path === "/app" || path.startsWith("/app/")) return serveApp(request, env, url);
  if (path.startsWith("/auth/")) {
    const res = await handleAuth(request, env, path, later);
    if (res !== null) return res;
  }
  if (path.startsWith("/api/")) {
    checkProtocol(request, env);
    const handled = await handleApi(request, env, path, later);
    if (handled !== null) return renewed(env, handled.identity, handled.response);
  }
  if (path.startsWith("/s/")) {
    checkProtocol(request, env);
    const handled = await handleSpace(request, env, url);
    if (handled !== null) return renewed(env, handled.identity, handled.response);
  }
  if (path === "/mcp") return handleMcp(request, env);
  if (path.startsWith("/.well-known/")) {
    const res = await handleWellKnown(request, env, path);
    if (res !== null) return res;
  }
  return failureResponse("not_found", NOT_FOUND);
}

/** One request; `ctx` (its `waitUntil`) runs the work that must not hold up the response. */
export async function handle(
  request: Request,
  env: Env,
  ctx?: { waitUntil(promise: Promise<unknown>): void },
): Promise<Response> {
  try {
    return await route(request, env, laterOf(ctx));
  } catch (error) {
    if (error instanceof Failure) return failureResponse(error.code, error.message, error.reason);
    // Authority lost between a check and its batch: the thing is no longer the caller's.
    if (isGuard(error, "authority")) return failureResponse("not_found", NOT_FOUND);
    console.error("unhandled", error);
    // The error table's `unavailable` row: 503, retryable.
    return failureResponse("unavailable", "Something went wrong.");
  }
}

/** The daily sweep's cron (wrangler.jsonc); every other tick retries the outbox only. */
// Not exported: the entry module may export only handlers and classes.
const DAILY_CRON = "17 4 * * *";

export default {
  fetch: (request, env, ctx) => handle(request, env, ctx),
  async scheduled(controller, env) {
    // Every minute: control calls the spaces are still owed (finding 1).
    await deliverDue(env);
    // Agent access still owed its removal at WorkOS (S-3).
    await retryAgentAccessRemovals(env);
    if (controller.cron === DAILY_CRON) await sweep(env);
  },
} satisfies ExportedHandler<Env>;
