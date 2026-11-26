// Calling the edge as browsers, the extension and people do: realistic fetch
// metadata, Origin and CSRF headers, and people signed in through the dev stub.
import { env, exports } from "cloudflare:workers";
import { CSRF_HEADER, type Person, SESSION_COOKIE } from "@onlay/protocol";
import type { Echo } from "./echo-space";

export const ORIGIN = "http://localhost:8787";

export function edge(path: string, init: RequestInit = {}): Promise<Response> {
  return exports.default.fetch(new Request(`${ORIGIN}${path}`, { redirect: "manual", ...init }));
}

/** The test env with DEV_AUTH set to `devAuth`, or removed as in production. */
export function envWith(devAuth: string | undefined): typeof env {
  const { DEV_AUTH: _, ...rest } = env;
  return devAuth === undefined ? rest : { ...rest, DEV_AUTH: devAuth };
}

export interface Who {
  person: Person;
  /** An extension-class client token. */
  token: string;
  /** `__Host-onlay.session=<value>`, ready for a Cookie header. */
  cookie: string;
}

let counter = 0;
/** A fresh email per call, so test files never collide in shared storage. */
export function uniqueEmail(prefix = "person"): string {
  counter += 1;
  return `${prefix}-${Date.now().toString(36)}-${counter}-${Math.random().toString(36).slice(2, 7)}@example.com`;
}

export function sessionCookieOf(res: Response): string {
  for (const value of res.headers.getSetCookie()) {
    if (value.startsWith(`${SESSION_COOKIE}=`)) return value.split(";")[0] ?? "";
  }
  throw new Error("no session cookie set");
}

export async function devSignIn(email = uniqueEmail(), name?: string): Promise<Who> {
  const res = await edge("/auth/dev/session", {
    method: "POST",
    // Each sign-in from its own address, so the per-IP sign-in limit stays out of the way.
    headers: { "Content-Type": "application/json", "CF-Connecting-IP": `dev-${counter}-${email}` },
    body: JSON.stringify(name ? { email, name } : { email }),
  });
  if (res.status !== 200) throw new Error(`dev sign-in failed: ${res.status} ${await res.text()}`);
  const body = (await res.json()) as { person: Person; token: string };
  return { ...body, cookie: sessionCookieOf(res) };
}

/** The web app's headers: same-origin fetch metadata, Origin and the CSRF header on writes. */
export function webHeaders(who: Who, method = "GET"): Record<string, string> {
  const headers: Record<string, string> = {
    Cookie: who.cookie,
    "Sec-Fetch-Site": "same-origin",
    "Sec-Fetch-Mode": "cors",
  };
  if (method !== "GET" && method !== "HEAD") {
    headers.Origin = ORIGIN;
    headers[CSRF_HEADER] = "1";
  }
  return headers;
}

/** A call as the web app (cookie) or as the extension (`token`). */
export function call(
  who: Who,
  method: string,
  path: string,
  body?: unknown,
  as: "web" | "extension" = "web",
): Promise<Response> {
  const headers: Record<string, string> =
    as === "web" ? webHeaders(who, method) : { Authorization: `Bearer ${who.token}` };
  if (body !== undefined) headers["Content-Type"] = "application/json";
  return edge(path, {
    method,
    headers,
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
}

/** A workspace written straight into D1, independent of the creation policy. */
export async function seedWorkspace(
  admins: Who[],
  members: Who[] = [],
): Promise<{ id: string; name: string }> {
  const id = `s_${Array.from(crypto.getRandomValues(new Uint8Array(20)), (b) => "abcdefghijklmnopqrstuvwxyz234567"[b & 31]).join("")}`;
  const name = `ws-${id.slice(2, 14)}`;
  const creator = admins[0];
  if (creator === undefined) throw new Error("a workspace needs an admin");
  const now = Date.now();
  await env.DB.batch([
    env.DB.prepare(
      "INSERT INTO spaces (id, kind, name, owner_id, created_by, created_at) VALUES (?, 'workspace', ?, NULL, ?, ?)",
    ).bind(id, name, creator.person.id, now),
    ...admins.map((who) =>
      env.DB.prepare(
        "INSERT INTO space_members (space_id, person_id, role, created_at) VALUES (?, ?, 'admin', ?)",
      ).bind(id, who.person.id, now),
    ),
    ...members.map((who) =>
      env.DB.prepare(
        "INSERT INTO space_members (space_id, person_id, role, created_at) VALUES (?, ?, 'member', ?)",
      ).bind(id, who.person.id, now),
    ),
  ]);
  return { id, name };
}

export async function personalSpaceOf(who: Who): Promise<string> {
  const id = await env.DB.prepare("SELECT id FROM spaces WHERE kind = 'personal' AND owner_id = ?")
    .bind(who.person.id)
    .first<string>("id");
  if (id === null) throw new Error("no personal space");
  return id;
}

/** What the echoing space received on its internal control routes. */
export async function spaceLog(spaceId: string): Promise<Echo[]> {
  const stub = env.SPACE.get(env.SPACE.idFromName(spaceId));
  return (await (await stub.fetch("https://space/__test/log")).json()) as Echo[];
}

export async function setSpace(
  spaceId: string,
  path: "/__test/attention" | "/__test/origins" | "/__test/fail" | "/__test/slow",
  body: unknown,
) {
  const stub = env.SPACE.get(env.SPACE.idFromName(spaceId));
  await stub.fetch(`https://space${path}`, { method: "PUT", body: JSON.stringify(body) });
}

export async function errorOf(
  res: Response,
): Promise<{ status: number; code: string; message: string }> {
  const body = (await res.json()) as { error: { code: string; message: string } };
  return { status: res.status, code: body.error.code, message: body.error.message };
}
