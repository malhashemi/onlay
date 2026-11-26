// A stand-in for WorkOS inside the test Worker (dossier's fake-provider
// idea). It replaces fetch for the `workos.test` host and serves
// `POST /user_management/authenticate`: the identity each test chooses
// travels inside the authorization code, so the real web flow runs end to end.
// It also keeps each user's authorized applications (list and delete, as
// https://workos.com/docs/reference/authkit/user documents them), and can be
// made to fail them for a while. Each sign-in starts an AuthKit session,
// named by the `sid` claim of the access token it returns, and the user's
// sessions can be listed and revoked (https://workos.com/docs/reference/authkit/session).

export const WORKOS_BASE = "https://workos.test";
export const WORKOS_CLIENT_ID = "client_test";
export const WORKOS_API_KEY = "sk_test_fake_workos_key";

export interface FakeUser {
  id: string;
  email: string;
  email_verified: boolean;
  first_name?: string;
  last_name?: string;
  profile_picture_url?: string;
}

/** Every authenticate body onlay sent, for assertions. */
export const workosLog: Record<string, unknown>[] = [];

export function codeFor(user: FakeUser): string {
  // Non-ASCII escaped, so any name survives btoa.
  const json = JSON.stringify(user).replace(
    /[\u0080-\uffff]/g,
    (ch) => `\\u${ch.charCodeAt(0).toString(16).padStart(4, "0")}`,
  );
  return btoa(json).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}

function userOf(code: string): FakeUser | null {
  try {
    return JSON.parse(atob(code.replaceAll("-", "+").replaceAll("_", "/"))) as FakeUser;
  } catch {
    return null;
  }
}

/** While `hold` is set, a code exchange tells `reached` and waits for it (a slow exchange). */
export const exchangeGate: { hold: Promise<void> | null; reached: () => void } = {
  hold: null,
  reached: () => {},
};

async function authenticate(request: Request): Promise<Response> {
  const body = (await request.json()) as Record<string, unknown>;
  workosLog.push(body);
  if (exchangeGate.hold !== null) {
    exchangeGate.reached();
    await exchangeGate.hold;
  }
  if (
    body.client_id !== WORKOS_CLIENT_ID ||
    body.client_secret !== WORKOS_API_KEY ||
    body.grant_type !== "authorization_code" ||
    typeof body.code !== "string"
  ) {
    return Response.json({ error: "invalid_client" }, { status: 401 });
  }
  const user = userOf(body.code);
  if (user === null) return Response.json({ error: "invalid_grant" }, { status: 400 });
  const sid = `session_${crypto.randomUUID().replaceAll("-", "")}`;
  const started = new Date().toISOString();
  authkitSessions.set(user.id, [
    ...(authkitSessions.get(user.id) ?? []),
    { id: sid, created_at: started },
  ]);
  return Response.json({
    user: { object: "user", ...user },
    access_token: noSid.has(user.id) ? "fake.access.token" : accessToken({ sub: user.id, sid }),
    refresh_token: "fake-refresh",
  });
}

/** An unsigned JWT carrying these claims, as onlay reads them (it never verifies this one). */
function accessToken(claims: Record<string, unknown>): string {
  const part = (value: unknown) =>
    btoa(JSON.stringify(value)).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
  return `${part({ alg: "RS256", typ: "JWT" })}.${part(claims)}.c2lnbmF0dXJl`;
}

/** WorkOS users whose code exchange returns an access token naming no session. */
export const noSid = new Set<string>();

export interface FakeSession {
  id: string;
  created_at: string;
}

/** Each WorkOS user's active AuthKit sessions, oldest first, by user id. */
export const authkitSessions = new Map<string, FakeSession[]>();

/** Every session call onlay made, as `METHOD path` (a revoke adds ` <session id>`). */
export const sessionsLog: string[] = [];

/**
 * Session calls answer 500 while `calls` is above zero (each call counts it
 * down); a listing waits for `hold` while it is set (or until the caller gives up).
 */
export const sessionsOutage: { calls: number; hold: Promise<void> | null } = {
  calls: 0,
  hold: null,
};

/** The active sessions (paged like the applications list) and revoking one. */
async function sessions(request: Request, url: URL): Promise<Response | null> {
  const listing = /^\/user_management\/users\/([^/]+)\/sessions$/.exec(url.pathname);
  const revoking = url.pathname === "/user_management/sessions/revoke";
  if (listing === null && !revoking) return null;
  if (request.headers.get("Authorization") !== `Bearer ${WORKOS_API_KEY}`) {
    sessionsLog.push(`${request.method} ${url.pathname}`);
    return Response.json({ message: "Unauthorized" }, { status: 401 });
  }
  if (revoking && request.method === "POST") {
    const body = (await request.json()) as { session_id?: unknown };
    sessionsLog.push(`POST ${url.pathname} ${String(body.session_id)}`);
    if (sessionsOutage.calls > 0) {
      sessionsOutage.calls -= 1;
      return Response.json({ message: "Internal error" }, { status: 500 });
    }
    for (const [userId, list] of authkitSessions) {
      if (list.some((session) => session.id === body.session_id)) {
        authkitSessions.set(
          userId,
          list.filter((session) => session.id !== body.session_id),
        );
        return Response.json({});
      }
    }
    return Response.json({ message: "Not found" }, { status: 404 });
  }
  if (listing === null || request.method !== "GET")
    return new Response("not found", { status: 404 });
  sessionsLog.push(`GET ${url.pathname}`);
  if (sessionsOutage.hold !== null) {
    const signal = request.signal;
    await Promise.race([
      sessionsOutage.hold,
      new Promise<void>((_resolve, reject) => {
        signal.addEventListener("abort", () => reject(signal.reason));
      }),
    ]);
  }
  if (sessionsOutage.calls > 0) {
    sessionsOutage.calls -= 1;
    return Response.json({ message: "Internal error" }, { status: 500 });
  }
  const userId = decodeURIComponent(listing[1] ?? "");
  const all = authkitSessions.get(userId) ?? [];
  const ordered = url.searchParams.get("order") === "asc" ? all : [...all].reverse();
  const limit = Number(url.searchParams.get("limit") ?? "10");
  const cursor = url.searchParams.get("after");
  const from = cursor === null ? 0 : ordered.findIndex((session) => session.id === cursor) + 1;
  if (from === 0 && cursor !== null) {
    return Response.json({ message: "Invalid cursor" }, { status: 400 });
  }
  const page = ordered.slice(from, from + limit);
  const more = from + limit < ordered.length;
  return Response.json({
    object: "list",
    data: page.map((session) => ({
      object: "session",
      id: session.id,
      user_id: userId,
      status: "active",
      auth_method: "password",
      created_at: session.created_at,
      updated_at: session.created_at,
      ended_at: null,
    })),
    list_metadata: { before: null, after: more ? (page[page.length - 1]?.id ?? null) : null },
  });
}

/** Each WorkOS user's authorized applications: application ids, by user id. */
export const authorizedApps = new Map<string, string[]>();

/**
 * Authorized-application calls answer 500 while `calls` is above zero (each
 * call counts it down), and wait for `hold` while it is set.
 */
export const workosOutage: { calls: number; hold: Promise<void> | null; laterPages404: boolean } = {
  calls: 0,
  hold: null,
  // A listing past its first page answers 404 (as if the user went away mid-list).
  laterPages404: false,
};

/** Every authorized-application call onlay made, as `METHOD path`. */
export const authorizedAppsLog: string[] = [];

/**
 * When each application was created (registered with WorkOS), by id. One not
 * named here was created long before any test, at `LONG_AGO`.
 */
export const applicationCreatedAt = new Map<string, Date>();
const LONG_AGO = "2026-01-15T12:00:00.000Z";

/**
 * Gives a user authorized applications, as an agent's OAuth consent does, in
 * the order they were authorized.
 */
export function authorize(userId: string, ...applicationIds: string[]): void {
  authorizedApps.set(userId, [...(authorizedApps.get(userId) ?? []), ...applicationIds]);
}

const AUTHORIZED = /^\/user_management\/users\/([^/]+)\/authorized_applications(?:\/([^/]+))?$/;

/** List (paged by `limit` and an `after` cursor, as WorkOS pages it) and delete. */
async function authorizedApplications(request: Request, url: URL): Promise<Response | null> {
  const match = AUTHORIZED.exec(url.pathname);
  if (match === null) return null;
  if (workosOutage.hold) await workosOutage.hold;
  authorizedAppsLog.push(`${request.method} ${url.pathname}`);
  if (request.headers.get("Authorization") !== `Bearer ${WORKOS_API_KEY}`) {
    return Response.json({ message: "Unauthorized" }, { status: 401 });
  }
  if (workosOutage.calls > 0) {
    workosOutage.calls -= 1;
    return Response.json({ message: "Internal error" }, { status: 500 });
  }
  const userId = decodeURIComponent(match[1] ?? "");
  const appId = match[2] === undefined ? undefined : decodeURIComponent(match[2]);
  const apps = authorizedApps.get(userId) ?? [];
  if (request.method === "GET" && appId === undefined) {
    const limit = Number(url.searchParams.get("limit") ?? "10");
    // Sorted by when each was authorized: `asc` oldest first; `normal` and `desc` newest first.
    const ordered = url.searchParams.get("order") === "asc" ? apps : [...apps].reverse();
    // `after` is a listed item's id: the page starts just past it (an unknown one is refused).
    const cursor = url.searchParams.get("after");
    if (cursor !== null && workosOutage.laterPages404) {
      return Response.json({ message: "Not found" }, { status: 404 });
    }
    const from = cursor === null ? 0 : ordered.findIndex((id) => `authorized_${id}` === cursor) + 1;
    if (from === 0 && cursor !== null) {
      return Response.json({ message: "Invalid cursor" }, { status: 400 });
    }
    const page = ordered.slice(from, from + limit);
    const more = from + limit < ordered.length;
    return Response.json({
      object: "list",
      data: page.map((id) => {
        const created = applicationCreatedAt.get(id)?.toISOString() ?? LONG_AGO;
        return {
          object: "authorized_connect_application",
          id: `authorized_${id}`,
          granted_scopes: ["openid", "profile", "email"],
          application: {
            object: "connect_application",
            id,
            client_id: `client_${id}`,
            name: id,
            created_at: created,
            updated_at: created,
          },
        };
      }),
      list_metadata: {
        before: from > 0 && page.length > 0 ? `authorized_${page[0]}` : null,
        after: more ? `authorized_${page[page.length - 1]}` : null,
      },
    });
  }
  if (request.method === "DELETE" && appId !== undefined) {
    if (!apps.includes(appId)) return Response.json({ message: "Not found" }, { status: 404 });
    authorizedApps.set(
      userId,
      apps.filter((id) => id !== appId),
    );
    return new Response(null, { status: 204 });
  }
  return new Response("not found", { status: 404 });
}

const realFetch = globalThis.fetch.bind(globalThis);

/**
 * Stand-ins for other hosts (a provider's picture host, say), by origin: a
 * test registers one and removes it after. Each gets the request and its signal.
 */
export const otherHosts = new Map<
  string,
  (request: Request, signal: AbortSignal | undefined) => Promise<Response>
>();

/** Installs the stand-in; requests to any other host go out unchanged. */
export function installFakeWorkos(): void {
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = new Request(input, init);
    const url = new URL(request.url);
    const other = otherHosts.get(url.origin);
    if (other) return other(request, init?.signal ?? request.signal);
    if (url.origin === WORKOS_BASE) {
      if (url.pathname === "/user_management/authenticate" && request.method === "POST") {
        return authenticate(request);
      }
      return (
        (await sessions(request, url)) ??
        (await authorizedApplications(request, url)) ??
        new Response("not found", { status: 404 })
      );
    }
    return realFetch(request);
  }) as typeof fetch;
}
