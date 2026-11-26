// The shared app context handed to every screen: the allowlist client, the
// offline store, the router, who is signed in and the spaces they see, and a
// per-space people cache (so avatars and mentions resolve names). Screens
// render pure DOM from this — they never reach for globals.
import type { MeResponse, PersonSummary, SpaceRole, SpaceSummary } from "@onlay/protocol";
import type { ApiClient } from "./api";
import type { Face } from "./components/avatar";
import type { Router } from "./router";
import type { Store } from "./store";

export interface AppCtx {
  client: ApiClient;
  store: Store;
  router: Router;
  /** `/api/me` as last loaded. Replaced, never mutated, on every reload. */
  me: MeResponse;
  /** The service's origin (`https://app.onlay.dev`), for links into the web app and the MCP URL. */
  origin: string;
  /** Re-pull `/api/me` (and re-sync the live sockets to its spaces). */
  reloadMe(): Promise<boolean>;
  /** Space id → its people, filled on demand. */
  people: Map<string, Map<string, PersonSummary>>;
  /** Re-pull one space's `/directory`; true when live server truth landed. */
  loadPeople(spaceId: string): Promise<boolean>;
  /** End the session and leave: `this` signs out here, `everywhere` ends
   *  every session and extension sign-in, `gone` follows an account deletion
   *  (the server already ended everything). Local data is wiped either way. */
  signOut(how?: "this" | "everywhere" | "gone"): Promise<boolean>;
}

/**
 * The public site's origin (`https://onlay.dev`): the welcome page, `/install`
 * and `/privacy`. The service's own origin from a server that doesn't name one.
 */
export function siteOrigin(ctx: AppCtx): string {
  try {
    const url = new URL(ctx.me.siteOrigin ?? "");
    if (url.protocol === "https:" || url.protocol === "http:") return url.origin;
  } catch {
    // not a URL: the service's own
  }
  return ctx.origin;
}

export function selfId(ctx: AppCtx): string {
  return ctx.me.person.id;
}

export function spaceOf(ctx: AppCtx, spaceId: string): SpaceSummary | undefined {
  return ctx.me.spaces.find((s) => s.id === spaceId);
}

export function roleIn(ctx: AppCtx, spaceId: string): SpaceRole | undefined {
  return spaceOf(ctx, spaceId)?.role;
}

const UNKNOWN_TINT = "#94a3b8";

/** Who a person id is, as far as this space's people know (self always). */
/** The stand-ins made for people not (yet) in the space's directory. */
const STAND_INS = new WeakSet<object>();

export function personFor(ctx: AppCtx, spaceId: string, id: string): Face & { id: string } {
  if (id === ctx.me.person.id) return ctx.me.person;
  const p = ctx.people.get(spaceId)?.get(id);
  if (p) return p;
  const standIn = { id, name: "Someone", initials: "?", tint: UNKNOWN_TINT };
  STAND_INS.add(standIn);
  return standIn;
}

/** A person's name as the web app knows it; undefined for a stand-in. */
export function knownNameFor(ctx: AppCtx, spaceId: string, id: string): string | undefined {
  const p = personFor(ctx, spaceId, id);
  return STAND_INS.has(p) ? undefined : p.name;
}

/** A person's alias as this space's people give it (only to members), else undefined. */
export function aliasFor(ctx: AppCtx, spaceId: string, id: string): string | undefined {
  return ctx.people.get(spaceId)?.get(id)?.alias;
}

/** A mounted screen. `refresh` re-pulls live server truth (tick / focus /
 *  fallback); an explicit `false` (or a promise of one) means live truth was
 *  NOT reached, so the fallback interval stays armed. `dispose` releases
 *  timers and object URLs on navigation away. */
export interface Screen {
  node: HTMLElement;
  refresh?(): void | boolean | Promise<boolean | undefined>;
  dispose?(): void;
}
