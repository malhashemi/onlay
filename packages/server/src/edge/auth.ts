/**
 * Sign-in routes (spec §4): the web flow against WorkOS AuthKit, the
 * extension hand-off and token redemption, sign-out, and the dev stub.
 */
import {
  DevSessionRequestSchema,
  type DevSessionResponse,
  ExtensionAuthQuerySchema,
  ExtensionTokenRequestSchema,
  type ExtensionTokenResponse,
  type SignOutResponse,
} from "@onlay/protocol";
import * as z from "zod/mini";
import type { Later } from "../directory/agent-access";
import {
  createClientToken,
  createSession,
  deleteSession,
  mintAuthCode,
  redeemAuthCode,
  revokeClientToken,
  signOutEverywhere,
} from "../directory/credentials";
import { base64url, newSecret, randomBytes, signValue, verifyValue } from "../directory/crypto";
import { personOf } from "../directory/db";
import { Failure, notFound, signInRequired } from "../directory/failure";
import { afterSignIn, personById, signIn } from "../directory/people";
import type { Env } from "../env";
import { resolveCaller, resolveSessionCaller } from "./caller";
import { linksOf, publicSiteOrigin, serviceOrigin } from "./hosts";
import {
  clearSessionCookie,
  clientIp,
  cookiePairs,
  INVALID_EMAIL,
  json,
  noContent,
  readBody,
  readFormCapped,
  redirect,
  safeReturnTo,
  sessionCookie,
} from "./http";
import { devLoginPage, errorPage, handoffPage, htmlResponse } from "./pages";
import { limit, SIGN_IN_PER_MINUTE } from "./rate";
import { checkPersonHint } from "./space";
import { authenticate, authorizeUrl, logoutUrl, type WorkosSignIn } from "./workos";

/**
 * Each sign-in attempt keeps its nonce in a cookie of its own,
 * `__Host-onlay.state.<attempt>`, so attempts started in one browser (two
 * tabs, the web app beside the extension) don't cancel each other.
 */
const ATTEMPT_COOKIE = "__Host-onlay.state.";
const ATTEMPT_ID = /^[A-Za-z0-9_-]{11}$/;
const STATE_TTL = 10 * 60_000;
/** Pending attempts a browser keeps; starting another expires the oldest beyond it. */
const MAX_ATTEMPTS = 5;

const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1"]);

/**
 * The dev sign-in stub exists only on this machine (the security audit's
 * deployment finding): `DEV_AUTH` is "1", the configured `PUBLIC_ORIGIN` is a
 * loopback host, and the request itself arrived for that same host. The one
 * check behind the web stub, the dev login form and MCP's `dev:` bearer.
 */
export function devStubAllowed(env: Env, request: Request): boolean {
  if (env.DEV_AUTH !== "1") return false;
  let origin: string;
  try {
    origin = new URL(serviceOrigin(env)).hostname;
  } catch {
    return false;
  }
  if (!LOOPBACK_HOSTS.has(origin)) return false;
  const host = (request.headers.get("Host") ?? new URL(request.url).host).toLowerCase();
  const hostname = host.startsWith("[") ? host : (host.split(":")[0] ?? "");
  return hostname === origin && new URL(request.url).hostname === origin;
}

function secret(env: Env): string {
  if (!env.SESSION_SECRET) throw new Error("SESSION_SECRET is not set");
  return env.SESSION_SECRET;
}

/** An attempt's cookie; its value is `<started ms>.<nonce>`, empty to clear it. */
function attemptCookie(attempt: string, value: string, maxAge: number): string {
  return `${ATTEMPT_COOKIE}${attempt}=${value}; Max-Age=${maxAge}; Path=/; HttpOnly; Secure; SameSite=Lax`;
}

interface HeldAttempt {
  id: string;
  started: number;
  nonce: string;
}

/** The attempt cookies the request carries; a malformed value reads as the oldest. */
function heldAttempts(request: Request): HeldAttempt[] {
  const out: HeldAttempt[] = [];
  for (const [name, value] of cookiePairs(request)) {
    if (!name.startsWith(ATTEMPT_COOKIE)) continue;
    const id = name.slice(ATTEMPT_COOKIE.length);
    if (!ATTEMPT_ID.test(id)) continue;
    const parsed = /^(\d{1,16})\.([A-Za-z0-9_-]+)$/.exec(value);
    out.push({ id, started: parsed ? Number(parsed[1]) : 0, nonce: parsed?.[2] ?? "" });
  }
  return out;
}

/** The attempts to expire so that, with one more, at most MAX_ATTEMPTS are pending. */
function attemptsBeyondCap(request: Request): string[] {
  const ids = new Map<string, number>();
  for (const held of heldAttempts(request)) {
    ids.set(held.id, Math.min(held.started, ids.get(held.id) ?? Number.POSITIVE_INFINITY));
  }
  const oldestFirst = [...ids].sort((a, b) => a[1] - b[1]).map(([id]) => id);
  return oldestFirst.slice(0, Math.max(0, oldestFirst.length - (MAX_ATTEMPTS - 1)));
}

/** The browser holds exactly one cookie for this attempt, carrying the state's nonce. */
function holdsAttempt(request: Request, state: { a: string; n: string }): boolean {
  const held = heldAttempts(request).filter((attempt) => attempt.id === state.a);
  return held.length === 1 && held[0]?.nonce === state.n;
}

/**
 * Where a callback that can't finish sends the person on (`r` of a state this
 * server signed, which anyone can have signed through `/auth/login`): only the
 * web app or the extension hand-off (`safeReturnTo`), so recovery never bounces
 * back into the sign-in routes and never ends on a public page's alias, whose
 * redirect to the site would tell the site this browser is signed in.
 */
function onwardFrom(r: string, env: Env): string {
  return safeReturnTo(r, serviceOrigin(env));
}

/** A live browser session on this navigation, by the rule `/auth/extension` uses (never a Bearer). */
async function hasBrowserSession(request: Request, env: Env): Promise<boolean> {
  try {
    return (await resolveSessionCaller(request, env, "navigate"))?.session !== undefined;
  } catch (error) {
    if (error instanceof Failure) return false;
    throw error;
  }
}

const SIGN_IN_FAILED = "Sign-in didn't finish";

/** Routes under /auth/; null when the path is not one of them. */
export async function handleAuth(
  request: Request,
  env: Env,
  path: string,
  later: Later,
): Promise<Response | null> {
  const method = request.method;
  switch (path) {
    case "/auth/login":
      return method === "GET" ? login(request, env) : methodNotAllowed();
    case "/auth/callback":
      return method === "GET" ? callback(request, env) : methodNotAllowed();
    case "/auth/extension":
      return method === "GET" ? extensionStart(request, env) : methodNotAllowed();
    case "/auth/extension/token":
      return method === "POST" ? extensionToken(request, env) : methodNotAllowed();
    case "/auth/logout":
      return method === "POST" ? logout(request, env) : methodNotAllowed();
    case "/auth/logout-everywhere":
      return method === "POST" ? logoutEverywhere(request, env, later) : methodNotAllowed();
    case "/auth/dev/session":
      // The stub does not exist outside a loopback dev setup (devStubAllowed).
      if (!devStubAllowed(env, request)) throw notFound();
      return method === "POST" ? devSession(request, env) : methodNotAllowed();
    default:
      return null;
  }
}

function methodNotAllowed(): Response {
  return new Response(null, { status: 405 });
}

/** `GET /auth/login?return_to=<path>`: AuthKit, or in dev the one-field form. */
async function login(request: Request, env: Env): Promise<Response> {
  await limit(env.DB, `sign-in:${clientIp(request)}`, SIGN_IN_PER_MINUTE);
  const returnTo = safeReturnTo(
    new URL(request.url).searchParams.get("return_to"),
    serviceOrigin(env),
  );
  if (devStubAllowed(env, request)) return htmlResponse(devLoginPage(returnTo, linksOf(env)));
  const attempt = base64url(randomBytes(8));
  const nonce = newSecret();
  const started = Date.now();
  const state = await signValue(secret(env), {
    r: returnTo,
    n: nonce,
    e: started + STATE_TTL,
    a: attempt,
  });
  const headers = new Headers({ Location: authorizeUrl(env, state), "Cache-Control": "no-store" });
  for (const old of attemptsBeyondCap(request))
    headers.append("Set-Cookie", attemptCookie(old, "", 0));
  headers.append("Set-Cookie", attemptCookie(attempt, `${started}.${nonce}`, STATE_TTL / 1000));
  return new Response(null, { status: 302, headers });
}

const StateSchema = z.object({
  r: z.string(),
  n: z.string(),
  e: z.number(),
  a: z.string().check(z.regex(ATTEMPT_ID)),
});
/** What any state this server signed carries, whatever its version: the return path. */
const SignedReturnSchema = z.object({ r: z.string() });

/** `GET /auth/callback`: exchange the code, sign the person in, set the cookie, return. */
async function callback(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  const code = url.searchParams.get("code");
  const rawState = url.searchParams.get("state");
  const signed = rawState ? await verifyValue(secret(env), rawState) : null;
  const state = z.safeParse(StateSchema, signed);
  const signedReturn = z.safeParse(SignedReturnSchema, signed);
  // Only a state this server signed names a return path; a forged one gets plain sign-in.
  const onward = signedReturn.success ? onwardFrom(signedReturn.data.r, env) : undefined;
  // Whatever ends here ends this attempt, and only this one.
  const endAttempt: Record<string, string> = state.success
    ? { "Set-Cookie": attemptCookie(state.data.a, "", 0) }
    : {};
  const failed = (message: string) =>
    htmlResponse(errorPage(SIGN_IN_FAILED, message, onward, linksOf(env)), 400, endAttempt);
  // The browser must hold this very attempt's nonce (login CSRF). When it
  // doesn't, a browser already signed in goes on without exchanging a code,
  // whether or not one came back.
  const holds = state.success && state.data.e >= Date.now() && holdsAttempt(request, state.data);
  if (!holds && onward !== undefined && (await hasBrowserSession(request, env))) {
    return redirect(onward, { ...endAttempt, "Cache-Control": "no-store" });
  }
  if (!code || !rawState) return failed("The sign-in link is incomplete. Sign in again.");
  if (!state.success || !holds) {
    return failed("This sign-in expired or was started elsewhere. Sign in again.");
  }
  const profile = await authenticate(env, code);
  if (profile === null) return failed("Your sign-in provider refused this sign-in. Try again.");
  const returnTo = safeReturnTo(state.data.r, serviceOrigin(env));
  return finishSignIn(
    env,
    profile,
    returnTo,
    (location, cookie) => {
      const headers = new Headers({ Location: location, "Cache-Control": "no-store" });
      headers.append("Set-Cookie", cookie);
      headers.append("Set-Cookie", attemptCookie(state.data.a, "", 0));
      return new Response(null, { status: 302, headers });
    },
    endAttempt,
    // When this attempt began: its state's expiry less its life.
    state.data.e - STATE_TTL,
  );
}

const SIGNED_OUT_MEANWHILE =
  "You signed out everywhere before this sign-in finished. Sign in again.";

/** Signs the profile in, starts a session, and lets `respond` build the response. */
async function finishSignIn(
  env: Env,
  profile: WorkosSignIn,
  returnTo: string,
  respond: (location: string, cookie: string) => Response,
  failureHeaders: Record<string, string> = {},
  /** When the sign-in attempt began (epoch ms); absent for the dev form. */
  attemptStartedMs?: number,
): Promise<Response> {
  let signedIn: Awaited<ReturnType<typeof signIn>>;
  try {
    signedIn = await signIn(env, profile);
  } catch (error) {
    if (error instanceof Failure) {
      return htmlResponse(
        errorPage(SIGN_IN_FAILED, error.message, returnTo, linksOf(env)),
        error.code === "forbidden" ? 403 : error.code === "conflict" ? 409 : 400,
        failureHeaders,
      );
    }
    throw error;
  }
  await afterSignIn(env, signedIn);
  const session = await createSession(
    env.DB,
    signedIn.person.id,
    profile.workosSessionId,
    signedIn.generation,
    // A revocation at or after the attempt began wins, unless this sign-in caused it.
    attemptStartedMs === undefined || signedIn.advanced
      ? undefined
      : Math.floor(attemptStartedMs / 1000),
  );
  // A sign out everywhere (or account deletion) committed while this sign-in
  // finished: it wins, and this browser signs in again.
  if (session === null) {
    return htmlResponse(
      errorPage(SIGN_IN_FAILED, SIGNED_OUT_MEANWHILE, returnTo, linksOf(env)),
      409,
      failureHeaders,
    );
  }
  return respond(returnTo, sessionCookie(session.secret));
}

export function extensionIds(env: Env): Set<string> {
  return new Set(
    env.EXTENSION_IDS.split(",")
      .map((id) => id.trim())
      .filter((id) => id.length > 0),
  );
}

/**
 * `GET /auth/extension?ext&challenge&state`: signs the person in through the
 * web flow when needed, mints a one-time code bound to (person, challenge),
 * and hands it to the extension.
 */
async function extensionStart(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  const query = z.safeParse(ExtensionAuthQuerySchema, Object.fromEntries(url.searchParams));
  if (!query.success) {
    return htmlResponse(
      errorPage(
        SIGN_IN_FAILED,
        "The extension's sign-in link is incomplete. Sign in again from the extension.",
        undefined,
        linksOf(env),
      ),
      400,
    );
  }
  const { ext, challenge, state } = query.data;
  if (!extensionIds(env).has(ext)) {
    return htmlResponse(
      errorPage(
        SIGN_IN_FAILED,
        "This extension can't sign in to Onlay. Update or reinstall the extension, then try again.",
        undefined,
        linksOf(env),
      ),
      400,
    );
  }
  // Enrolling an extension needs a browser session: a Bearer credential never
  // counts here (a stolen token can't mint a second one), and without a
  // session the person signs in like any visitor.
  const caller = await resolveSessionCaller(request, env, "navigate");
  if (caller?.session === undefined) {
    return redirect(`/auth/login?return_to=${encodeURIComponent(url.pathname + url.search)}`, {
      "Cache-Control": "no-store",
    });
  }
  const code = await mintAuthCode(env.DB, caller.person.id, challenge, caller.session.id);
  return htmlResponse(handoffPage(ext, code, state, caller.person.email));
}

const CODE_REFUSED = "This sign-in code is invalid or expired. Sign in again from the extension.";

/** `POST /auth/extension/token {code, verifier}` → `{token, person}`. A code is single-use. */
async function extensionToken(request: Request, env: Env): Promise<Response> {
  await limit(env.DB, `sign-in:${clientIp(request)}`, SIGN_IN_PER_MINUTE);
  const body = await readBody(request, ExtensionTokenRequestSchema);
  const redeemed = await redeemAuthCode(env.DB, body.code, body.verifier);
  if (redeemed === "session-ended") {
    throw new Failure(
      "sign_in_required",
      "The browser session that started this sign-in has ended. Sign in again from the extension.",
    );
  }
  if (redeemed === null) throw new Failure("invalid", CODE_REFUSED);
  const person = await personById(env.DB, redeemed.personId);
  if (person === null || person.email === null) throw new Failure("invalid", CODE_REFUSED);
  const out: ExtensionTokenResponse = { token: redeemed.token, person: personOf(person) };
  return json(out, { headers: { "Cache-Control": "no-store" } });
}

/**
 * The answer to a sign-out that cleared the cookie: when the session came
 * from AuthKit, where the browser goes next to end that sign-in too (200
 * `{signOutUrl}`: AuthKit's logout for the session, returning to the public
 * site's home page); otherwise 204, and the sign-in AuthKit may hold stays.
 * The address is built here from the stored session id and fixed origins,
 * never from the request.
 */
function signedOut(env: Env, workosSessionId: string | null | undefined): Response {
  const headers = { "Set-Cookie": clearSessionCookie(), "Cache-Control": "no-store" };
  if (!workosSessionId) return noContent(headers);
  const out: SignOutResponse = {
    signOutUrl: logoutUrl(env, workosSessionId, `${publicSiteOrigin(env)}/`),
  };
  return json(out, { headers });
}

/** `POST /auth/logout`: ends this session (and its AuthKit sign-in), or revokes this client token. */
async function logout(request: Request, env: Env): Promise<Response> {
  const caller = await resolveCaller(request, env, "write");
  // Only a signed-in caller's logout clears the cookie: a cross-site post
  // (which fails the cookie rule) must not be able to sign the browser out.
  if (caller === null) return noContent();
  // A stale web app tab can't sign out the person who signed in after it (S16).
  checkPersonHint(request, caller, false);
  if (caller.session) await deleteSession(env, caller.person, caller.session.id);
  if (caller.tokenId) await revokeClientToken(env, caller.person, caller.tokenId);
  return signedOut(env, caller.session?.workosSessionId);
}

/**
 * `POST /auth/logout-everywhere`: every session deleted and every client
 * token revoked; after the response, every AuthKit session of the person
 * revoked (`signOutEverywhere`), and this browser sent to end its own.
 */
async function logoutEverywhere(request: Request, env: Env, later: Later): Promise<Response> {
  const caller = await resolveCaller(request, env, "write");
  if (caller === null) throw signInRequired();
  checkPersonHint(request, caller, false);
  const own = caller.session?.workosSessionId ?? undefined;
  await signOutEverywhere(env, caller.person, later, own);
  return signedOut(env, own);
}

/**
 * `POST /auth/dev/session {email, name?}` (DEV_AUTH only): JSON answers
 * `{person, token}` with the session cookie; the dev login form's post
 * answers with the cookie and a redirect to `return_to`.
 */
async function devSession(request: Request, env: Env): Promise<Response> {
  await limit(env.DB, `sign-in:${clientIp(request)}`, SIGN_IN_PER_MINUTE);
  const type = request.headers.get("Content-Type") ?? "";
  if (
    type.startsWith("application/x-www-form-urlencoded") ||
    type.startsWith("multipart/form-data")
  ) {
    const form = await readFormCapped(request);
    if (form === null) throw new Failure("invalid", "The request body is too large.");
    const email = String(form.get("email") ?? "");
    const parsed = z.safeParse(DevSessionRequestSchema, { email: email.trim() });
    if (!parsed.success)
      return htmlResponse(errorPage(SIGN_IN_FAILED, INVALID_EMAIL, undefined, linksOf(env)), 400);
    const returnTo = safeReturnTo(String(form.get("return_to") ?? ""), serviceOrigin(env));
    return finishSignIn(
      env,
      { email: parsed.data.email, emailVerified: true },
      returnTo,
      (location, cookie) =>
        redirect(location, { "Set-Cookie": cookie, "Cache-Control": "no-store" }, 303),
    );
  }
  const body = await readBody(request, DevSessionRequestSchema, { email: INVALID_EMAIL });
  const signedIn = await signIn(env, { email: body.email, emailVerified: true, name: body.name });
  await afterSignIn(env, signedIn);
  const session = await createSession(env.DB, signedIn.person.id, undefined, signedIn.generation);
  if (session === null) throw new Failure("conflict", SIGNED_OUT_MEANWHILE);
  const { token } = await createClientToken(env.DB, signedIn.person.id);
  const out: DevSessionResponse = { person: personOf(signedIn.person), token };
  return json(out, {
    headers: { "Set-Cookie": sessionCookie(session.secret), "Cache-Control": "no-store" },
  });
}
