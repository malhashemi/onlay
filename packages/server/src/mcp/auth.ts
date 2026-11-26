/**
 * MCP sign-in (spec §4): the `agent`-class caller behind `POST /mcp`, and the
 * OAuth discovery documents an MCP client reads to get a token.
 *
 * An MCP client holds an AuthKit access token for the person who signed in.
 * It is verified against AuthKit's JWKS with the issuer and this server's
 * `/mcp` audience; a token minted for an AI agent profile is refused. The
 * token's `sub` is the WorkOS user: a known one maps to its person, an unknown
 * one is fetched from the WorkOS API and signed in the way the web signs a
 * person in (verified email, personal space, invitation claim).
 *
 * Revocation (3b-S1, S-1, S-2): AuthKit's tokens cannot be deleted, so each
 * is compared, by its `iat`, with the cutoffs for what it proves: its WorkOS
 * subject and verified email (kept apart from the person row, so they outlive
 * account deletion), checked BEFORE a person is created or relinked, and its
 * person's last revocation as a whole, checked once the person is known.
 */
import { EmailSchema } from "@onlay/protocol";
import { createRemoteJWKSet, type JWTPayload, type JWTVerifyGetKey, jwtVerify } from "jose";
import * as z from "zod/mini";
import { type AgentTokenFacts, agentTokenRevoked } from "../directory/credentials";
import { PERSON_COLUMNS, type PersonRow } from "../directory/db";
import { failureResponse, isGuard } from "../directory/failure";
import {
  afterSignIn,
  refreshFromProvider,
  type SignInProfile,
  signIn,
  verificationDue,
} from "../directory/people";
import { devStubAllowed } from "../edge/auth";
import { type AgentIdentity, bearerOf } from "../edge/caller";
import { serviceOrigin } from "../edge/hosts";
import type { Env } from "../env";
import { readBounded } from "./bounded";

/** Where verification keys come from; tests pass a local key set. */
export type AgentKeys = JWTVerifyGetKey;

const DEFAULT_WORKOS_BASE = "https://api.workos.com";
const DEV_BEARER = "dev:";

/**
 * The remote key set's fetch: 5 s to answer, then jose's default cooldown
 * (30 s between refetches for an unknown key) and cache age (10 min), set
 * explicitly so a dependency upgrade can't change them unseen.
 */
export const JWKS_OPTIONS = {
  timeoutDuration: 5_000,
  cooldownDuration: 30_000,
  cacheMaxAge: 600_000,
} as const;

/** One remote key set per issuer per isolate, so its cache and cooldown outlive a request. */
const remoteKeySets = new Map<string, AgentKeys>();

export function remoteKeys(env: Env): AgentKeys {
  const issuer = env.AUTHKIT_ISSUER.replace(/\/+$/, "");
  let keys = remoteKeySets.get(issuer);
  if (keys === undefined) {
    keys = createRemoteJWKSet(new URL(`${issuer}/oauth2/jwks`), JWKS_OPTIONS);
    remoteKeySets.set(issuer, keys);
  }
  return keys;
}

/** `<service origin>/mcp`: the audience a token must name. */
function mcpResource(env: Env): string {
  return `${serviceOrigin(env)}/mcp`;
}

function resourceMetadataUrl(env: Env): string {
  return `${serviceOrigin(env)}/.well-known/oauth-protected-resource`;
}

/** The 401 an MCP client reads to start its OAuth flow (spec §4). */
export function authorizationNeeded(env: Env): Response {
  const res = failureResponse("sign_in_required", "Sign in to onlay to use these tools.");
  res.headers.set(
    "WWW-Authenticate",
    `Bearer error="unauthorized", error_description="Authorization needed", resource_metadata="${resourceMetadataUrl(env)}"`,
  );
  return res;
}

/* ── the caller ───────────────────────────────────────────────────── */

/**
 * The person behind `Authorization: Bearer <token>`, as an agent; null when
 * the token is missing, malformed, or fails verification (answer with
 * `authorizationNeeded`). Throws a `Failure` when the token is good but no
 * person may come of it (an unverified email).
 */
export async function resolveAgentCaller(
  request: Request,
  env: Env,
  keys: AgentKeys = remoteKeys(env),
): Promise<AgentIdentity | null> {
  const bearer = bearerOf(request.headers.get("Authorization"));
  if (bearer.kind !== "token") return null;
  const secret = bearer.secret;
  if (secret.startsWith(DEV_BEARER)) {
    return devStubAllowed(env, request) ? devCaller(env, secret.slice(DEV_BEARER.length)) : null;
  }
  const claims = await verifiedClaims(env, secret, keys);
  if (claims === null || typeof claims.sub !== "string" || claims.sub.length === 0) return null;
  const token: AgentTokenFacts = { iat: claims.iat, jti: claims.jti, subject: claims.sub };
  const person = await personForWorkosUser(env, token);
  if (person === null) return null;
  // Issued before the person's credentials were revoked (3b-S1, S-2): re-authorize.
  if (await agentTokenRevoked(env.DB, { ...token, email: person.email, personId: person.id })) {
    return null;
  }
  const credentialId = typeof claims.jti === "string" ? claims.jti : `mcp:${claims.sub}`;
  return {
    person,
    class: "agent",
    credentialId,
  };
}

async function verifiedClaims(
  env: Env,
  token: string,
  keys: AgentKeys,
): Promise<JWTPayload | null> {
  try {
    const { payload } = await jwtVerify(token, keys, {
      issuer: env.AUTHKIT_ISSUER,
      audience: mcpResource(env),
      algorithms: ["RS256"],
    });
    // A token AuthKit minted for an AI agent profile is not a person's.
    if (payload.sub_profile === "ai_agent") return null;
    return payload;
  } catch {
    return null;
  }
}

/** `Bearer dev:<email>` (DEV_AUTH only): that email, signed in as verified. */
async function devCaller(env: Env, raw: string): Promise<AgentIdentity | null> {
  const parsed = z.safeParse(EmailSchema, raw.trim());
  if (!parsed.success) return null;
  const person = await signInProfile(env, { email: parsed.data, emailVerified: true });
  return {
    person,
    class: "agent",
    credentialId: `dev:${person.email}`,
  };
}

async function signInProfile(
  env: Env,
  profile: SignInProfile,
  token?: AgentTokenFacts,
): Promise<PersonRow & { email: string }> {
  const signedIn = await signIn(env, profile, token);
  await afterSignIn(env, signedIn);
  return signedIn.person;
}

/**
 * The person a verified token reaches; null (the caller answers 401) for a
 * token a cutoff refuses. A known person whose email is fresh is only read.
 * Every write from a token (creating, relinking or refreshing a person)
 * carries the token's acceptance as a guard inside its own batch (2-S2), so
 * a revocation that commits after any check made here still stops it; the
 * subject is also checked before WorkOS is asked, to spare the lookup.
 */
async function personForWorkosUser(
  env: Env,
  token: AgentTokenFacts,
): Promise<(PersonRow & { email: string }) | null> {
  // WorkOS is asked at most once per request; its answer serves a second decision.
  let profile: Promise<SignInProfile | null> | undefined;
  const lookup = () => {
    profile ??= fetchWorkosUser(env, token.subject);
    return profile;
  };
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      return await decide(env, token, lookup);
    } catch (error) {
      // A write's own guard refused it (2-S2: the token; 3-S1: the person row
      // changed since it was read): nothing was written. Read and decide once
      // more; a second refusal is the 401.
      if (!isGuard(error, "live")) throw error;
    }
  }
  return null;
}

/** One decision from the directory as it reads now. */
async function decide(
  env: Env,
  token: AgentTokenFacts,
  lookup: () => Promise<SignInProfile | null>,
): Promise<(PersonRow & { email: string }) | null> {
  const known = await env.DB.prepare(
    `SELECT ${PERSON_COLUMNS} FROM people p WHERE p.workos_user_id = ? AND p.deleted_at IS NULL`,
  )
    .bind(token.subject)
    .first<PersonRow>();
  if (known !== null && known.email !== null) {
    if (!verificationDue(known)) return known as PersonRow & { email: string };
    // WorkOS vouched for this email more than a day ago: ask again before acting on it.
    const fresh = await lookup();
    return fresh === null ? null : refreshFromProvider(env, known, fresh, token);
  }
  if (await agentTokenRevoked(env.DB, token)) return null;
  const profile = await lookup();
  return profile === null ? null : signInProfile(env, profile, token);
}

interface WorkosUser {
  id: string;
  email: string;
  email_verified: boolean;
  first_name?: string | null;
  last_name?: string | null;
  profile_picture_url?: string | null;
}

function isWorkosUser(value: unknown): value is WorkosUser {
  if (typeof value !== "object" || value === null) return false;
  const user = value as Record<string, unknown>;
  return (
    typeof user.id === "string" &&
    typeof user.email === "string" &&
    typeof user.email_verified === "boolean"
  );
}

/** `GET /user_management/users/<id>` with the API key; null when WorkOS has no such user. */
async function fetchWorkosUser(env: Env, userId: string): Promise<SignInProfile | null> {
  if (!env.WORKOS_API_KEY) throw new Error("WORKOS_API_KEY is not set");
  const base = (env.WORKOS_API_BASE ?? DEFAULT_WORKOS_BASE).replace(/\/+$/, "");
  const res = await fetch(`${base}/user_management/users/${encodeURIComponent(userId)}`, {
    headers: { Authorization: `Bearer ${env.WORKOS_API_KEY}`, Accept: "application/json" },
  });
  if (!res.ok) {
    console.error(`WorkOS user lookup answered ${res.status}`);
    await res.body?.cancel();
    return null;
  }
  const user: unknown = await res.json();
  if (!isWorkosUser(user) || user.id !== userId) return null;
  const name = [user.first_name, user.last_name].filter((part) => part?.trim()).join(" ");
  return {
    email: user.email,
    emailVerified: user.email_verified,
    name: name || undefined,
    avatarUrl: user.profile_picture_url ?? undefined,
    workosUserId: user.id,
  };
}

/* ── discovery ────────────────────────────────────────────────────── */

/** AuthKit's metadata: this long to answer, and at most this much of it. */
const METADATA_DEADLINE_MS = 5_000;
const MAX_METADATA_BYTES = 64 * 1024;

const DISCOVERY_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Cache-Control": "public, max-age=300",
};

/**
 * `/.well-known/oauth-protected-resource` (also under `/mcp`) and
 * `/.well-known/oauth-authorization-server` (AuthKit's, proxied); null for
 * any other path.
 */
export async function handleWellKnown(
  request: Request,
  env: Env,
  path: string,
): Promise<Response | null> {
  const resource =
    path === "/.well-known/oauth-protected-resource" ||
    path === "/.well-known/oauth-protected-resource/mcp";
  const server = path === "/.well-known/oauth-authorization-server";
  if (!resource && !server) return null;
  if (request.method !== "GET" && request.method !== "HEAD") {
    return new Response(null, { status: 405, headers: { Allow: "GET, HEAD" } });
  }
  if (resource) {
    return Response.json(
      {
        resource: mcpResource(env),
        authorization_servers: [env.AUTHKIT_ISSUER],
        bearer_methods_supported: ["header"],
      },
      { headers: DISCOVERY_HEADERS },
    );
  }
  const metadata = await authkitMetadata(env);
  if (metadata === null) {
    return failureResponse("unavailable", "The sign-in service didn't answer.");
  }
  return Response.json(metadata, { headers: DISCOVERY_HEADERS });
}

/** AuthKit's metadata document within the deadline and size; null on any failure. */
async function authkitMetadata(env: Env): Promise<unknown> {
  const issuer = env.AUTHKIT_ISSUER.replace(/\/+$/, "");
  try {
    const upstream = await fetch(`${issuer}/.well-known/oauth-authorization-server`, {
      headers: { Accept: "application/json" },
      signal: AbortSignal.timeout(METADATA_DEADLINE_MS),
    });
    if (!upstream.ok) {
      await upstream.body?.cancel();
      return null;
    }
    const raw = await readBounded(upstream.body, upstream.headers, MAX_METADATA_BYTES);
    if (raw === null) return null;
    const parsed: unknown = JSON.parse(new TextDecoder().decode(raw));
    return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed) ? parsed : null;
  } catch (error) {
    console.error("AuthKit metadata failed", error instanceof Error ? error.name : "error");
    return null;
  }
}
