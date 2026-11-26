// The service worker — secure contexts only (main.ts registers it iff
// `self.isSecureContext`). It caches the STATIC SHELL and nothing else: the
// precache array + SHELL_VERSION are INJECTED at build, so the SW never
// fetches a manifest at install. The shell holds nothing person-specific;
// the person's read cache + drafts live in the app's IndexedDB. API responses
// are never cached here: only in-scope `/app/` GETs are intercepted, and
// `/api/*`, `/s/*` and `/auth/*` go straight to the network. Signing out
// clears every cache this worker owns.
//
// Web Push: the `push`/`notificationclick`/`pushsubscriptionchange` handlers
// at the bottom show server-composed notifications, route taps to the thread,
// and heal push-service rotation — display and plumbing only, no judgment.
//
// Types: the WebWorker lib conflicts with DOM, so the SW scope is typed locally
// against the exact surface used here rather than pulling that lib in.

// Injected at build (scripts/build.ts Bun.build `define`); declared so tsc is
// satisfied and the values are inlined into the bundle.
declare const __ONLAY_PRECACHE__: string[];
declare const __ONLAY_SHELL_VERSION__: string;
/** `PROTOCOL_VERSION` from @onlay/protocol, as the header value. */
declare const __ONLAY_PROTOCOL__: string;

interface SwEvent {
  waitUntil(p: Promise<unknown>): void;
}
interface SwFetchEvent {
  request: Request;
  respondWith(r: Response | Promise<Response>): void;
}
interface SwPushEvent extends SwEvent {
  data: { json(): unknown } | null;
}
interface SwNotificationClickEvent extends SwEvent {
  notification: { close(): void; data?: { url?: unknown } };
}
interface SwMessageEvent extends SwEvent {
  data: unknown;
}
interface SwWindowClient {
  url: string;
  focus(): Promise<unknown>;
  postMessage(message: unknown): void;
}
interface SwPushManager {
  subscribe(options: {
    userVisibleOnly: boolean;
    applicationServerKey: Uint8Array;
  }): Promise<{ toJSON(): unknown }>;
}
interface SwScope {
  isSecureContext: boolean;
  registration: {
    scope: string;
    pushManager: SwPushManager;
    showNotification(
      title: string,
      options: {
        body: string;
        icon: string;
        badge: string;
        tag: string;
        data: { url: string };
      },
    ): Promise<void>;
  };
  addEventListener(type: "install", cb: (e: SwEvent) => void): void;
  addEventListener(type: "activate", cb: (e: SwEvent) => void): void;
  addEventListener(type: "fetch", cb: (e: SwFetchEvent) => void): void;
  addEventListener(type: "push", cb: (e: SwPushEvent) => void): void;
  addEventListener(type: "notificationclick", cb: (e: SwNotificationClickEvent) => void): void;
  addEventListener(type: "pushsubscriptionchange", cb: (e: SwEvent) => void): void;
  addEventListener(type: "message", cb: (e: SwMessageEvent) => void): void;
  skipWaiting(): Promise<void>;
  clients: {
    claim(): Promise<void>;
    matchAll(options: { type: "window"; includeUncontrolled: boolean }): Promise<SwWindowClient[]>;
    openWindow(url: string): Promise<unknown>;
  };
  location: { origin: string };
}

const sw = self as unknown as SwScope;

const SHELL_VERSION = __ONLAY_SHELL_VERSION__;
const CACHE = `onlay-shell-${SHELL_VERSION}`;
const PRECACHE = __ONLAY_PRECACHE__;
const SCOPE = "/app/";

sw.addEventListener("install", (event) => {
  event.waitUntil(
    (async () => {
      const cache = await caches.open(CACHE);
      // Icon/badge PNGs keep STABLE names but are served with revalidation
      // (http.ts), and a plain addAll rides the HTTP cache — which can still
      // hold a superseded icon under the same name. `cache: "reload"` makes
      // the precache capture the network's current bytes for those.
      await cache.addAll(
        PRECACHE.map((u) => (u.endsWith(".png") ? new Request(u, { cache: "reload" }) : u)),
      );
      await sw.skipWaiting();
    })(),
  );
});

sw.addEventListener("activate", (event) => {
  event.waitUntil(
    (async () => {
      // Drop superseded shell caches (a new deploy busts SHELL_VERSION).
      const keys = await caches.keys();
      await Promise.all(
        keys
          .filter((k) => k.startsWith("onlay-shell-") && k !== CACHE)
          .map((k) => caches.delete(k)),
      );
      await sw.clients.claim();
    })(),
  );
});

function inScope(url: URL): boolean {
  return url.origin === sw.location.origin && url.pathname.startsWith(SCOPE);
}

sw.addEventListener("fetch", (event) => {
  const req = event.request;
  if (req.method !== "GET") return; // never intercept a mutation
  const url = new URL(req.url);
  if (!inScope(url)) return; // /api/*, /s/*, /auth/* → straight to the network
  event.respondWith(cacheFirst(req, url));
});

function isShellNav(req: Request, url: URL): boolean {
  // Hash routes live in the URL FRAGMENT (D-ROUTER), so every real deep link is
  // `/app/#/…` → pathname `/app/`. Only the two shell pathnames boot the shell;
  // any OTHER `/app/x` navigation is NOT rewritten to the shell — that would be a
  // client-side wildcard route over the closed static allowlist (0021 amendment).
  return (
    req.mode === "navigate" && (url.pathname === SCOPE || url.pathname === `${SCOPE}index.html`)
  );
}

async function cacheFirst(req: Request, url: URL): Promise<Response> {
  const cache = await caches.open(CACHE);
  const key = isShellNav(req, url) ? `${SCOPE}index.html` : url.pathname;
  // The shell is the precache set and NOTHING else (no runtime caching): a
  // precache miss goes to the network, where an unknown `/app/x` gets the
  // broker's 404 — the SW never manufactures a route or caches a runtime error.
  const cached = (await cache.match(key)) ?? (await cache.match(req));
  if (cached) return cached;
  try {
    return await fetch(req);
  } catch {
    // Offline: a shell navigation still cold-boots from the precached document;
    // a missing asset returns a plain error, never the HTML shell (wrong type).
    if (isShellNav(req, url)) {
      const shell = await cache.match(`${SCOPE}index.html`);
      if (shell) return shell;
    }
    return new Response("offline", { status: 503, headers: { "Content-Type": "text/plain" } });
  }
}

// Signing out (main.ts posts this after the session ends): drop every cache.
sw.addEventListener("message", (event) => {
  const data = event.data as { type?: unknown } | null;
  if (data?.type !== "onlay-sign-out") return;
  event.waitUntil(
    (async () => {
      const keys = await caches.keys();
      await Promise.all(keys.map((k) => caches.delete(k)));
    })(),
  );
});

/* ── web push ──────────────────────────────────────────────────────────
 * The server pushes when an interaction ENTERS this person's needs-you set;
 * the payload arrives encrypted (RFC 8291) and decodes to the JSON below.
 * Title/body are precomposed server-side — the SW shows, routes taps, and
 * heals push-service rotation; it never re-derives judgment. */

// The decrypted payload — typed locally, like the SwScope.
interface PushPayload {
  interactionId: string;
  kind: "ask" | "change" | "comment";
  title: string;
  body: string;
  url: string; // relative "/app/#/t/<spaceId>/<interactionId>" — the thread
}

function asPayload(data: unknown): PushPayload | null {
  const p = data as Partial<PushPayload> | null;
  if (!p || typeof p.interactionId !== "string" || typeof p.title !== "string") return null;
  return {
    interactionId: p.interactionId,
    kind: p.kind === "change" || p.kind === "comment" ? p.kind : "ask",
    title: p.title,
    body: typeof p.body === "string" ? p.body : "",
    // A tap never leaves the app: anything but an in-scope relative url
    // degrades to the shell (the server sends "/app/#/t/<space>/<id>").
    url: typeof p.url === "string" && p.url.startsWith(SCOPE) ? p.url : SCOPE,
  };
}

sw.addEventListener("push", (event) => {
  let payload: PushPayload | null = null;
  try {
    payload = asPayload(event.data?.json());
  } catch {
    // an undecodable push shows nothing — the Inbox remains the truth
  }
  if (!payload) return;
  event.waitUntil(
    sw.registration.showNotification(payload.title, {
      body: payload.body,
      icon: "/app/icon-192.png",
      badge: "/app/badge-96.png",
      // One notification per interaction: a newer push for the same id
      // replaces the shown one instead of stacking.
      tag: payload.interactionId,
      data: { url: payload.url },
    }),
  );
});

sw.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const url =
    typeof event.notification.data?.url === "string" ? event.notification.data.url : SCOPE;
  event.waitUntil(
    (async () => {
      // Focus an existing app window and hand it the route (the app navigates
      // via the hash router, main.ts listens); only open a window when none is.
      const wins = await sw.clients.matchAll({ type: "window", includeUncontrolled: true });
      const app = wins.find((w) => new URL(w.url).pathname.startsWith(SCOPE));
      if (app) {
        await app.focus();
        app.postMessage({ type: "onlay-navigate", url });
        return;
      }
      await sw.clients.openWindow(url);
    })(),
  );
});

// Push-service rotation with no window alive: re-subscribe with the VAPID key
// the app stashed in IDB at subscribe time and hand the new subscription to
// every space the person sees — the session cookie authenticates, exactly as
// the window does. `event.oldSubscription` is unreliable — never consulted.
sw.addEventListener("pushsubscriptionchange", (event) => {
  event.waitUntil(resubscribe());
});

// store.ts literals, mirrored: the SW reads the `onlay-pwa` db directly (it
// has no window and no ApiClient — these raw fetches are the one sanctioned
// exception to the api.ts allowlist).
const IDB_NAME = "onlay-pwa";
const IDB_VAPID_KEY = "vapidKey";
// @onlay/protocol's PROTOCOL_HEADER / CSRF_HEADER, mirrored to keep the SW
// bundle free of the protocol package.
const PROTOCOL_HEADER = "Onlay-Protocol";
const CSRF_HEADER = "Onlay-CSRF";

function reqAsync<T>(req: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function readVapidKey(): Promise<string | null> {
  // Version-less open: never upgrade from the SW — the window owns the schema.
  const db = await new Promise<IDBDatabase>((resolve, reject) => {
    const open = indexedDB.open(IDB_NAME);
    open.onsuccess = () => resolve(open.result);
    open.onerror = () => reject(open.error);
  });
  try {
    if (!db.objectStoreNames.contains("meta")) return null;
    const store = db.transaction("meta", "readonly").objectStore("meta");
    const key = (await reqAsync(store.get(IDB_VAPID_KEY))) as string | undefined;
    return typeof key === "string" ? key : null;
  } finally {
    db.close();
  }
}

/** base64url → bytes (URL-safe chars, padding restored): the VAPID key is the
 *  raw 65-byte uncompressed P-256 point `pushManager.subscribe` wants. */
function serverKeyBytes(key: string): Uint8Array {
  const b64 = key.replaceAll("-", "+").replaceAll("_", "/");
  const bin = atob(b64.padEnd(Math.ceil(b64.length / 4) * 4, "="));
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}

async function resubscribe(): Promise<void> {
  try {
    const vapidKey = await readVapidKey();
    if (!vapidKey) return; // signed out or never subscribed — nothing to heal
    const meRes = await fetch("/api/me", {
      credentials: "same-origin",
      headers: { [PROTOCOL_HEADER]: __ONLAY_PROTOCOL__ },
    });
    if (!meRes.ok) return;
    const me = (await meRes.json()) as { person?: { id?: unknown }; spaces?: { id?: unknown }[] };
    // The subscriptions are made as the person /api/me just named, and say so.
    const personId = typeof me.person?.id === "string" ? me.person.id : "";
    const spaceIds = (me.spaces ?? [])
      .map((s) => s.id)
      .filter((id): id is string => typeof id === "string" && /^s_[a-z2-7]{20}$/.test(id));
    const sub = await sw.registration.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: serverKeyBytes(vapidKey),
    });
    const body = JSON.stringify(sub.toJSON());
    await Promise.all(
      spaceIds.map((id) =>
        fetch(`/s/${id}/push/subscribe`, {
          method: "POST",
          credentials: "same-origin",
          headers: {
            [PROTOCOL_HEADER]: __ONLAY_PROTOCOL__,
            [CSRF_HEADER]: "1",
            "Content-Type": "application/json",
            ...(personId ? { "Onlay-Person": personId } : {}),
          },
          body,
        }),
      ),
    );
  } catch {
    // best-effort: the boot resync (main.ts) re-POSTs on next app open
  }
}
