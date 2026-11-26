// Boot: theme, store, secure-context SW registration, who is signed in
// (`/api/me`; a 401 at boot goes to sign-in, a 401 once signed in shows the
// signed-out screen: sign-out.ts), and the router → screen lifecycle with
// live refresh. Freshness: one WebSocket per space sends payload-less ticks
// (live.ts); focus/visibility fire unconditionally, and a 30 s interval runs
// only as the fallback while a socket is down or the last round failed. Ids
// live in the fragment; there is no per-thread server route.
import type { MeResponse, PersonSummary } from "@onlay/protocol";
import type { ApiClient } from "./api";
import * as api from "./api";
import { emptyState, errorState, screenBody, signedOutState } from "./chrome";
import { showUpgradePrompt } from "./components/banner";
import { type AppCtx, type Screen, siteOrigin } from "./context";
import { el } from "./dom";
import { createLive, type Live } from "./live";
import { disablePush, resyncPush } from "./push";
import { Router } from "./router";
import { composeScreen } from "./screens/compose";
import { inboxScreen } from "./screens/inbox";
import { roundScreen } from "./screens/round";
import { settingsScreen } from "./screens/settings";
import { threadScreen } from "./screens/thread";
import { workspaceScreen } from "./screens/workspace";
import { browserChannel, createSessionEnd, runSignOut, type SessionEnd } from "./sign-out";
import { Store } from "./store";
import { initTheme } from "./theme";
import { type Route, signInUrl } from "./view-model";

const REFRESH_MS = 30_000;

/** Tears the mounted app down (sockets, routes, in-memory state). */
let teardown: () => void = () => {};

/** Navigate away to sign in (a reads-only cleanup first, drafts kept). */
function goSignIn(client: ApiClient): void {
  const who = client.personId;
  const go = (): void => window.location.assign(signInUrl(window.location));
  if (who) void client.store.onSignInRequired(who).finally(go);
  else go();
}

/** The app comes down and the signed-out screen takes its place; its button starts sign-in. */
function showSignedOut(root: HTMLElement, client: ApiClient, session: SessionEnd): void {
  const who = client.personId;
  teardown();
  teardown = () => {};
  if (who) void client.store.onSignInRequired(who);
  const body = screenBody();
  body.append(
    signedOutState(() => {
      session.leave();
      goSignIn(client);
    }),
  );
  const screen = el("div", "screen");
  screen.append(body);
  swap(root, { node: screen });
}

async function clearShellCaches(): Promise<void> {
  try {
    const keys = await caches.keys();
    await Promise.all(keys.filter((k) => k.startsWith("onlay-")).map((k) => caches.delete(k)));
    navigator.serviceWorker?.controller?.postMessage({ type: "onlay-sign-out" });
  } catch {
    // best-effort
  }
}

async function main(): Promise<void> {
  initTheme();
  const root = document.getElementById("root");
  if (!root) return;
  const store = await Store.open();

  // Secure contexts only get a service worker; elsewhere the app runs
  // online-only and says so once.
  const secure = self.isSecureContext && "serviceWorker" in navigator;
  if (secure) {
    navigator.serviceWorker.register("/app/sw.js", { scope: "/app/" }).catch(() => {
      /* registration is best-effort; the app runs online regardless */
    });
  } else {
    store.setOnlineOnly(true);
  }

  const client: ApiClient = {
    store,
    personId: "",
    onSignInRequired: () => session.signInRequired(),
    onUpgradeRequired: showUpgradePrompt,
    // Another person's cookie now: nothing in this tab is theirs to see or act
    // on. Drop the in-flight results (the client refuses them from here on),
    // clear this tab's state and start over as whoever is signed in.
    onPersonChanged: () => {
      if (session.leaving()) return;
      session.leave();
      client.personChanged = true;
      teardown();
      window.location.reload();
    },
  };
  const session: SessionEnd = createSessionEnd({
    personId: () => client.personId,
    channel: browserChannel(),
    goSignIn: () => goSignIn(client),
    showSignedOut: () => showSignedOut(root, client, session),
  });

  await boot(root, client, session);
}

/** Load who is signed in, then mount. Offline, fall back to the last
 *  person's cached `/api/me`; with nothing cached, say so with Retry. */
async function boot(root: HTMLElement, client: ApiClient, session: SessionEnd): Promise<void> {
  let me = await api.me(client);
  if (!me.ok && me.verdict === "offline") {
    const last = await client.store.lastPerson();
    if (last) {
      client.personId = last;
      me = await api.me(client);
    }
  }
  if (!me.ok) {
    if (session.leaving()) return; // a 401 is already on its way to sign-in
    const body = screenBody();
    body.append(
      me.verdict === "offline"
        ? emptyState("You're offline.", "Onlay needs a connection the first time you open it.")
        : errorState("Couldn't reach the server.", () => void boot(root, client, session)),
    );
    const screen = el("div", "screen");
    screen.append(body);
    swap(root, { node: screen });
    return;
  }
  client.personId = me.data.person.id;
  if (!me.fromCache) await client.store.adopt(me.data.person.id);
  mountApp(root, client, me.data, session);
  session.shown();
}

function mountApp(
  root: HTMLElement,
  client: ApiClient,
  initial: MeResponse,
  session: SessionEnd,
): void {
  const router = new Router();
  let live: Live | null = null;

  const ctx: AppCtx = {
    client,
    store: client.store,
    router,
    me: initial,
    origin: window.location.origin,
    people: new Map(),
    async reloadMe() {
      const res = await api.me(client);
      if (!res.ok || res.fromCache) return false;
      if (res.data.person.id !== ctx.me.person.id) {
        // A different person signed in on another tab: start over cleanly.
        client.onPersonChanged?.();
        return false;
      }
      ctx.me = res.data;
      live?.setSpaces(res.data.spaces.map((s) => s.id));
      return true;
    },
    async loadPeople(spaceId) {
      const res = await api.directory(client, spaceId);
      if (!res.ok) return false;
      // Atomic replace: someone removed from the space must drop out.
      const map = new Map<string, PersonSummary>();
      for (const p of res.data.people) map.set(p.id, p);
      ctx.people.set(spaceId, map);
      return !res.fromCache;
    },
    signOut(how = "this") {
      const spaces = ctx.me.spaces.map((s) => s.id);
      // Marked before anything is asked (sign-out.ts): the server revokes this
      // session before it answers, and this tab's 401s meanwhile are expected.
      return runSignOut({
        how,
        session,
        disablePush: () => disablePush(client, spaces),
        pause: () => live?.pause(),
        resume: () => live?.resume(),
        logout: async (which) => {
          const res =
            which === "everywhere" ? await api.logoutEverywhere(client) : await api.logout(client);
          return {
            ok: res.ok,
            status: res.ok ? 200 : res.status,
            signOutUrl: api.signOutUrlOf(res),
          };
        },
        signOutEndpoint: ctx.me.signOutEndpoint,
        finish: async (next) => {
          try {
            live?.dispose();
            await client.store.signOut(ctx.me.person.id);
            await clearShellCaches();
          } catch {
            // Clearing is best-effort; the navigation below happens regardless.
          } finally {
            // AuthKit's logout when the server named one: it ends the sign-in
            // itself, in this same window (an installed app's too, whose sign-in
            // lives in its own storage), then returns to the public site. Otherwise
            // straight to the welcome page, on the public site.
            window.location.assign(next ?? `${siteOrigin(ctx)}/`);
          }
        },
      });
    },
  };

  let current: Screen | null = null;
  const mount = (route: Route): void => {
    current?.dispose?.();
    current = screenFor(ctx, route);
    swap(root, current);
  };

  // One refresh round: who-am-I (spaces joined or left, renames) once, then
  // the mounted screen once. `true` only when both reached live truth, which
  // lets the fallback interval stand down.
  const round = async (): Promise<boolean> => {
    const meOk = await ctx.reloadMe();
    let screenOk = true;
    try {
      screenOk = (await current?.refresh?.()) !== false;
    } catch {
      screenOk = false;
    }
    return meOk && screenOk;
  };

  live = createLive({
    spaceIds: initial.spaces.map((s) => s.id),
    personId: initial.person.id,
    refresh: round,
    onUpgradeRequired: showUpgradePrompt,
    onAccessChanged: () => live?.requestRefresh(),
  });
  const liveRef = live;

  const fire = (): void => {
    if (document.visibilityState === "visible") liveRef.requestRefresh();
  };
  window.addEventListener("focus", fire);
  document.addEventListener("visibilitychange", fire);
  const fallback = setInterval(() => {
    if (document.visibilityState !== "visible") return;
    if (!liveRef.healthy() || !liveRef.lastRoundOk()) liveRef.requestRefresh();
  }, REFRESH_MS);

  // Notification taps while a window is open arrive as SW messages (the SW
  // focuses this window and posts the route instead of opening a second one).
  if ("serviceWorker" in navigator) {
    navigator.serviceWorker.addEventListener("message", (e) => {
      const data = e.data as { type?: unknown; url?: unknown } | null;
      if (data?.type !== "onlay-navigate" || typeof data.url !== "string") return;
      // Only the fragment routes; parseHash re-validates it before mounting.
      const hash = data.url.split("#")[1];
      if (hash) router.go(`#${hash}`);
    });
  }

  // Re-POST a live push subscription to every space (rotation, new spaces).
  void resyncPush(
    client,
    initial.spaces.map((s) => s.id),
  );

  teardown = () => {
    router.stop();
    window.removeEventListener("focus", fire);
    document.removeEventListener("visibilitychange", fire);
    clearInterval(fallback);
    live?.dispose();
    current?.dispose?.();
    current = null;
    ctx.people.clear();
    while (root.firstChild) root.removeChild(root.firstChild);
  };

  router.start(mount);
}

function screenFor(ctx: AppCtx, route: Route): Screen {
  switch (route.name) {
    case "inbox":
      return inboxScreen(ctx);
    case "thread":
      return threadScreen(ctx, route.spaceId, route.id);
    case "compose":
      return composeScreen(ctx);
    case "round":
      return roundScreen(ctx, route.spaceId, route.url);
    case "settings":
      return settingsScreen(ctx, route.page);
    case "workspace":
      return workspaceScreen(ctx, route.spaceId);
  }
}

function swap(root: HTMLElement, screen: Screen): void {
  while (root.firstChild) root.removeChild(root.firstChild);
  root.appendChild(screen.node);
}

void main();
