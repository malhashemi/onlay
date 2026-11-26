/**
 * The caller: one function that turns a Request into who is asking, or a
 * refusal (spec §4).
 *
 * - One well-formed Bearer credential (`Authorization: Bearer <token>`, or on
 *   a WebSocket upgrade the `bearer.<token>` subprotocol entry) takes
 *   precedence over the cookie. Malformed or multiple credentials are
 *   `sign_in_required`, never read past for the cookie.
 * - The session cookie counts for API reads only with `Sec-Fetch-Site:
 *   same-origin`; for writes also with `Onlay-CSRF: 1` and `Origin` equal to
 *   `PUBLIC_ORIGIN`; for a WebSocket upgrade with that `Origin`; for a page
 *   navigation (the sign-in pages) on a GET navigation. A cookie that fails
 *   its rule is ignored: the caller is a visitor.
 *
 * The client class comes from the credential: a client token is `full` (the
 * extension), a session is `interaction` (the web app). MCP's `agent` class is
 * resolved by `resolveAgentCaller` (mcp/auth.ts), not here.
 */
import {
  CLIENT_TOKEN_PREFIX,
  ClientTokenSchema,
  CSRF_HEADER,
  SESSION_COOKIE,
  WS_BEARER_PREFIX,
} from "@onlay/protocol";
import * as z from "zod/mini";
import {
  type CredentialRef,
  clientTokenBySecret,
  type Session,
  sessionBySecret,
} from "../directory/credentials";
import type { PersonRow } from "../directory/db";
import { Failure } from "../directory/failure";
import type { Env } from "../env";
import { serviceOrigin } from "./hosts";
import { cookieValues } from "./http";

/** How the request may present the cookie. */
export type RequestKind = "read" | "write" | "upgrade" | "navigate";

export interface Identity {
  person: PersonRow & { email: string };
  class: "full" | "interaction";
  /** The session or client-token id. */
  credentialId: string;
  /** The generation the credential was stamped with: the caller header's `credentialGeneration`. */
  credentialGeneration: number;
  /** The stored credential, to re-check it in one batch with a standing (round 2, S1). */
  credential: CredentialRef;
  /** Present when the cookie signed the caller in. */
  session?: Session;
  /** Present when a client token signed the caller in. */
  tokenId?: string;
}

/* ── Authorization ────────────────────────────────────────────────── */

type BearerHeader = { kind: "none" } | { kind: "token"; secret: string } | { kind: "malformed" };

const ONE_BEARER = /^bearer[\t ]+([^\t ,]+)$/i;

/**
 * Dossier's reading of `Authorization`: nothing, or exactly one Bearer
 * token. Anything else (two credentials, a Bearer with no token, another
 * scheme) fails closed and is never read past for the cookie. Duplicate
 * headers arrive comma-joined, so a comma never belongs to a token.
 */
export function bearerOf(header: string | null): BearerHeader {
  const value = (header ?? "").trim();
  if (value === "") return { kind: "none" };
  const one = ONE_BEARER.exec(value);
  if (one?.[1] !== undefined) return { kind: "token", secret: one[1] };
  return { kind: "malformed" };
}

/** The subprotocol entries a WebSocket upgrade offers. */
export function subprotocolsOf(request: Request): string[] {
  return (request.headers.get("Sec-WebSocket-Protocol") ?? "")
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
}

/** The bearer credential, from the header or (upgrades) the subprotocol; at most one. */
function credentialOf(request: Request, kind: RequestKind): BearerHeader {
  const header = bearerOf(request.headers.get("Authorization"));
  if (header.kind === "malformed") return header;
  const offered =
    kind === "upgrade"
      ? subprotocolsOf(request).filter((entry) => entry.startsWith(WS_BEARER_PREFIX))
      : [];
  if (offered.length > 1) return { kind: "malformed" };
  const fromProtocol = offered[0]?.slice(WS_BEARER_PREFIX.length);
  if (fromProtocol !== undefined) {
    if (header.kind === "token" || fromProtocol.length === 0) return { kind: "malformed" };
    return { kind: "token", secret: fromProtocol };
  }
  return header;
}

/* ── the cookie rule ──────────────────────────────────────────────── */

function cookieRuleHolds(kind: RequestKind, request: Request, publicOrigin: string): boolean {
  const headers = request.headers;
  const site = headers.get("Sec-Fetch-Site");
  const mode = headers.get("Sec-Fetch-Mode");
  const ownOrigin = headers.get("Origin") === publicOrigin;
  switch (kind) {
    case "read":
      return site === "same-origin";
    case "write":
      return site === "same-origin" && headers.get(CSRF_HEADER) === "1" && ownOrigin;
    case "upgrade":
      return ownOrigin;
    case "navigate":
      return (
        (request.method === "GET" || request.method === "HEAD") &&
        (mode === "navigate" || (site === null && mode === null))
      );
  }
}

const SESSION_VALUE = /^[A-Za-z0-9_-]{43}$/;

const MALFORMED_CREDENTIAL =
  "Send one credential: a session cookie, or Authorization: Bearer <token>.";
const UNKNOWN_TOKEN = "This token is unknown or revoked. Sign in again.";

/** The caller, `null` for a visitor; throws `sign_in_required` for malformed or unknown credentials. */
export async function resolveCaller(
  request: Request,
  env: Env,
  kind: RequestKind,
): Promise<Identity | null> {
  const credential = credentialOf(request, kind);
  if (credential.kind === "malformed") throw new Failure("sign_in_required", MALFORMED_CREDENTIAL);
  if (credential.kind === "token") {
    if (!credential.secret.startsWith(CLIENT_TOKEN_PREFIX)) {
      // AuthKit access tokens and `dev:` bearers belong to MCP (resolveAgentCaller).
      throw new Failure("sign_in_required", UNKNOWN_TOKEN);
    }
    if (!z.safeParse(ClientTokenSchema, credential.secret).success) {
      throw new Failure("sign_in_required", MALFORMED_CREDENTIAL);
    }
    const token = await clientTokenBySecret(env.DB, credential.secret);
    if (token === null) throw new Failure("sign_in_required", UNKNOWN_TOKEN);
    return {
      person: token.person,
      class: "full",
      credentialId: token.id,
      credentialGeneration: token.generation,
      credential: { kind: "token", hash: token.hash },
      tokenId: token.id,
    };
  }
  return resolveSessionCaller(request, env, kind);
}

/**
 * The caller from the session cookie alone, ignoring any Bearer credential:
 * `null` for a visitor (no cookie, or one that fails its rule).
 */
export async function resolveSessionCaller(
  request: Request,
  env: Env,
  kind: RequestKind,
): Promise<Identity | null> {
  const values = cookieValues(request, SESSION_COOKIE);
  if (values.length === 0) return null;
  if (values.length > 1) throw new Failure("sign_in_required", MALFORMED_CREDENTIAL);
  if (!cookieRuleHolds(kind, request, serviceOrigin(env))) return null;
  const secret = values[0] ?? "";
  if (!SESSION_VALUE.test(secret)) return null;
  const session = await sessionBySecret(env.DB, secret);
  if (session === null) return null;
  return {
    person: session.person,
    class: "interaction",
    credentialId: session.id,
    credentialGeneration: session.generation,
    credential: { kind: "session", hash: session.hash },
    session,
  };
}

/** The cookie kind for an API request by its method. */
export function kindOf(request: Request): RequestKind {
  return request.method === "GET" || request.method === "HEAD" ? "read" : "write";
}

/* ── the MCP seam ─────────────────────────────────────────────────── */

/**
 * The `agent`-class caller for `POST /mcp` (spec §4, §9), resolved by
 * `resolveAgentCaller` in mcp/auth.ts from exactly one `Authorization:
 * Bearer` (read with `bearerOf`; no cookie counts on `/mcp`): an AuthKit
 * access token, or `dev:<email>` when the dev stub is on. `credentialId`
 * names the token (its `jti`, else `mcp:<sub>`; `dev:<email>` for the stub).
 */
export interface AgentIdentity {
  person: PersonRow & { email: string };
  class: "agent";
  credentialId: string;
}
