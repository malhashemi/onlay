/**
 * The WorkOS calls of the web sign-in (spec §4): the AuthKit authorize
 * redirect, and the code exchange at `POST /user_management/authenticate`
 * with the API key as `client_secret`; and the AuthKit logout a browser is
 * sent to at sign-out. The API base comes from the
 * `WORKOS_API_BASE` var so tests point it at a stand-in.
 */
import type { SignInProfile } from "../directory/people";
import type { Env } from "../env";
import { serviceOrigin } from "./hosts";

const DEFAULT_BASE = "https://api.workos.com";

function base(env: Env): string {
  return (env.WORKOS_API_BASE ?? DEFAULT_BASE).replace(/\/+$/, "");
}

function callbackUrl(env: Env): string {
  return `${serviceOrigin(env)}/auth/callback`;
}

export function authorizeUrl(env: Env, state: string): string {
  const url = new URL(`${base(env)}/user_management/authorize`);
  url.searchParams.set("client_id", env.WORKOS_CLIENT_ID);
  url.searchParams.set("redirect_uri", callbackUrl(env));
  url.searchParams.set("response_type", "code");
  url.searchParams.set("provider", "authkit");
  url.searchParams.set("state", state);
  return url.toString();
}

interface WorkosUser {
  id: string;
  email: string;
  email_verified: boolean;
  first_name?: string | null;
  last_name?: string | null;
  profile_picture_url?: string | null;
}

function isUser(value: unknown): value is WorkosUser {
  if (typeof value !== "object" || value === null) return false;
  const user = value as Record<string, unknown>;
  return (
    typeof user.id === "string" &&
    typeof user.email === "string" &&
    typeof user.email_verified === "boolean"
  );
}

/** An AuthKit session id as onlay keeps it (migrations/0010 bounds its length). */
const SESSION_ID = /^[A-Za-z0-9_-]{1,254}$/;

/**
 * The AuthKit session the exchange's access token belongs to: its `sid`
 * claim, which WorkOS documents as the id sign-out ends. The token came
 * straight from WorkOS over TLS in answer to our own API key, so its payload
 * is read, not verified. Undefined when it names none.
 */
function sessionIdOf(accessToken: unknown): string | undefined {
  if (typeof accessToken !== "string") return undefined;
  const payload = accessToken.split(".")[1];
  if (payload === undefined || payload.length === 0) return undefined;
  try {
    const padded = payload.replaceAll("-", "+").replaceAll("_", "/");
    const claims = JSON.parse(atob(padded)) as { sid?: unknown } | null;
    const sid = claims?.sid;
    return typeof sid === "string" && SESSION_ID.test(sid) ? sid : undefined;
  } catch {
    return undefined;
  }
}

/**
 * AuthKit's logout for one session (`GET /user_management/sessions/logout`):
 * it ends that session at WorkOS, so the browser is asked who it is at the
 * next sign-in, then sends the browser to `return_to`, which must be one of
 * the environment's registered sign-out URIs (the public site's home page).
 */
export function logoutUrl(env: Env, sessionId: string, returnTo: string): string {
  const url = new URL(logoutEndpoint(env));
  url.searchParams.set("session_id", sessionId);
  url.searchParams.set("return_to", returnTo);
  return url.toString();
}

/** AuthKit's logout endpoint, without a query: the one address the web app follows at sign-out. */
export function logoutEndpoint(env: Env): string {
  return `${base(env)}/user_management/sessions/logout`;
}

/** What a code exchange proves: the profile, and the AuthKit session it started. */
export type WorkosSignIn = SignInProfile & { workosSessionId?: string | undefined };

/** The profile behind an authorization code, or null when WorkOS refuses it. */
export async function authenticate(env: Env, code: string): Promise<WorkosSignIn | null> {
  if (!env.WORKOS_API_KEY) throw new Error("WORKOS_API_KEY is not set");
  const res = await fetch(`${base(env)}/user_management/authenticate`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify({
      client_id: env.WORKOS_CLIENT_ID,
      client_secret: env.WORKOS_API_KEY,
      grant_type: "authorization_code",
      code,
    }),
  });
  if (!res.ok) {
    console.error(`WorkOS authenticate answered ${res.status}`);
    await res.body?.cancel();
    return null;
  }
  const body = (await res.json()) as { user?: unknown; access_token?: unknown };
  if (!isUser(body.user)) return null;
  const user = body.user;
  const name = [user.first_name, user.last_name].filter((part) => part?.trim()).join(" ");
  return {
    email: user.email,
    emailVerified: user.email_verified,
    name: name || undefined,
    avatarUrl: user.profile_picture_url ?? undefined,
    workosUserId: user.id,
    workosSessionId: sessionIdOf(body.access_token),
  };
}
