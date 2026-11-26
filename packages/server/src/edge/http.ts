/**
 * HTTP plumbing for the edge: cookies, JSON bodies, and redirects.
 */
import { SESSION_COOKIE } from "@onlay/protocol";
import * as z from "zod/mini";
import { SESSION_TTL } from "../directory/credentials";
import { Failure } from "../directory/failure";
import { readCappedBody, readJsonCapped } from "../space/body";

/**
 * Strips only the space and tab a Cookie header allows around a name or value.
 * `trim()` would also strip other Unicode whitespace, and a cookie whose name
 * differs from a `__Host-` name by such a character would then read as it.
 */
function stripOws(text: string): string {
  return text.replace(/^[ \t]+|[ \t]+$/g, "");
}

/** Every cookie the request carries, as `[name, value]`, in the order sent. */
export function cookiePairs(request: Request): [string, string][] {
  const out: [string, string][] = [];
  for (const part of (request.headers.get("Cookie") ?? "").split(";")) {
    const at = part.indexOf("=");
    if (at < 0) continue;
    out.push([stripOws(part.slice(0, at)), stripOws(part.slice(at + 1))]);
  }
  return out;
}

/** Every value the request carries for a cookie name (more than one is malformed). */
export function cookieValues(request: Request, name: string): string[] {
  return cookiePairs(request)
    .filter(([cookie]) => cookie === name)
    .map(([, value]) => value);
}

export function sessionCookie(secret: string): string {
  return `${SESSION_COOKIE}=${secret}; Max-Age=${SESSION_TTL / 1000}; Path=/; HttpOnly; Secure; SameSite=Lax`;
}

export function clearSessionCookie(): string {
  return `${SESSION_COOKIE}=; Max-Age=0; Path=/; HttpOnly; Secure; SameSite=Lax`;
}

export function json(body: unknown, init: ResponseInit = {}): Response {
  return Response.json(body, init);
}

export function noContent(headers: HeadersInit = {}): Response {
  return new Response(null, { status: 204, headers });
}

export function redirect(
  location: string,
  headers: Record<string, string> = {},
  status = 302,
): Response {
  return new Response(null, { status, headers: { Location: location, ...headers } });
}

/** A response with mutable headers, keeping status, body and (for 101) the socket. */
export function withHeader(res: Response, name: string, value: string): Response {
  if (res.status === 101) return res;
  const copy = new Response(res.body, res);
  copy.headers.append(name, value);
  return copy;
}

const INVALID_BODY = "The request body isn't valid.";
export const INVALID_EMAIL = "Enter an email address like name@example.com.";

/** Every JSON body the edge reads (the API and sign-in routes): checked while it streams. */
const EDGE_BODY_MAX_BYTES = 65_536;

/**
 * The body (at most `EDGE_BODY_MAX_BYTES`, read with the space's bounded
 * reader) parsed against `schema`, or an `invalid` refusal; `messages` name a
 * field's refusal.
 */
export async function readBody<T>(
  request: Request,
  schema: z.ZodMiniType<T>,
  messages: Record<string, string> = {},
): Promise<T> {
  const read = await readJsonCapped(request, EDGE_BODY_MAX_BYTES);
  if (!read.ok) {
    throw new Failure(
      "invalid",
      read.reason === "too-large"
        ? `The body is larger than ${EDGE_BODY_MAX_BYTES} bytes.`
        : INVALID_BODY,
    );
  }
  const data = read.data;
  const result = z.safeParse(schema, data);
  if (result.success) return result.data;
  for (const issue of result.error.issues) {
    const field = String(issue.path[0] ?? "");
    const message = messages[field];
    if (message !== undefined) throw new Failure("invalid", message);
  }
  throw new Failure("invalid", INVALID_BODY);
}

/**
 * Where sign-in may return to: the paths that serve the web app's shell
 * document (`serveApp`: `/app/` and `/app/index.html`) and the extension
 * hand-off (`/auth/extension`), each with its query and fragment. They all
 * answer an HTML page under the same headers (`Cross-Origin-Opener-Policy`
 * included), like the signed-out outcome, so where sign-in ends shows nothing.
 */
const SIGN_IN_DESTINATIONS = new Set(["/app/", "/app/index.html", "/auth/extension"]);

/**
 * A same-origin path to return to after sign-in: the web app's shell or the
 * extension hand-off, keeping the query and fragment (`/app` becomes `/app/`
 * with them); anything else becomes `/app/`. A public page's alias only
 * redirects to the site, and an asset or a missing path answers differently
 * from a page, so letting sign-in end there would tell another origin
 * whether a browser is signed in.
 */
export function safeReturnTo(raw: string | null | undefined, publicOrigin: string): string {
  const fallback = "/app/";
  if (typeof raw !== "string" || !raw.startsWith("/") || raw.startsWith("//") || raw.includes("\\"))
    return fallback;
  try {
    const url = new URL(raw, publicOrigin);
    if (url.origin !== new URL(publicOrigin).origin) return fallback;
    // Validate what is returned, not only what came in: normalising can turn
    // `/.//evil.test` into `//evil.test`, which a browser reads as another host.
    const out = url.pathname + url.search + url.hash;
    if (!out.startsWith("/") || out.startsWith("//") || out.includes("\\")) return fallback;
    const resolved = new URL(out, publicOrigin);
    if (resolved.origin !== new URL(publicOrigin).origin) return fallback;
    if (resolved.pathname === "/app") return `/app/${resolved.search}${resolved.hash}`;
    if (!SIGN_IN_DESTINATIONS.has(resolved.pathname)) return fallback;
    return out;
  } catch {
    return fallback;
  }
}

/** A form post's fields, read with the same byte limit as JSON bodies; null when too large. */
export async function readFormCapped(request: Request): Promise<URLSearchParams | null> {
  const declared = request.headers.get("content-length");
  if (declared !== null && Number(declared) > EDGE_BODY_MAX_BYTES) return null;
  const bytes = await readCappedBody(request, EDGE_BODY_MAX_BYTES);
  if (bytes === null) return null;
  const type = request.headers.get("Content-Type") ?? "";
  if (type.startsWith("multipart/form-data")) {
    const form = await new Request("https://form.invalid/", {
      method: "POST",
      headers: { "Content-Type": type },
      body: bytes,
    }).formData();
    const out = new URLSearchParams();
    for (const [name, value] of form) if (typeof value === "string") out.append(name, value);
    return out;
  }
  return new URLSearchParams(new TextDecoder().decode(bytes));
}

export function clientIp(request: Request): string {
  return request.headers.get("CF-Connecting-IP") ?? "unknown";
}
