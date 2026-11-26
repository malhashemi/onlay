// Web-app glue over `@onlay/render/interaction-view`. Every PURE fact the
// screens draw already lives in the shared view-model (age, chipState, anchor
// labels, capture selectors, …); this file adds only what the web app alone
// needs: the hash-route grammar, draft keys, the merged Inbox across spaces
// and its space filter, the agent-work row labels, search rows, and what a
// person's role in a space lets them do. It re-authors none of the render
// logic — the shared-not-forked invariant.
import type {
  AgentWorkStatus,
  AttentionRow,
  InboxResponse,
  InboxRow,
  InteractionKind,
  RawInteractionSnapshot,
  SpaceRole,
  SpaceSummary,
} from "@onlay/protocol";
import { isSpaceId, validateWorkspaceName } from "@onlay/protocol";
import {
  anchorLabel,
  matchesQuery,
  pathLabel,
  shownUrl,
  snapshotSummary,
  snapshotTs,
} from "@onlay/render/interaction-view";

/* ── hash router grammar ──────────────────────────────────────────────
 * Ids live in the URL *fragment*, never a served route, so the served route
 * space stays the closed `/app/` + fixed asset list. */

export type SettingsPage = "index" | "account" | "spaces" | "deployment" | "agent";

export type Route =
  | { name: "inbox" }
  | { name: "thread"; spaceId: string; id: string }
  | { name: "compose" }
  | { name: "round"; spaceId: string; url: string }
  | { name: "settings"; page: SettingsPage }
  | { name: "workspace"; spaceId: string };

/** Interaction ids are UUIDs: reject anything else so a hostile fragment
 *  cannot smuggle a path segment into `/s/<space>/interaction/<id>`. */
const ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const SETTINGS_PAGES: readonly SettingsPage[] = ["account", "spaces", "deployment", "agent"];

/**
 * A page URL the app may fetch for or link to: `http:` and `https:` only,
 * normalized; null for anything else (`javascript:`, `data:`, junk). The round
 * route, the round's page link and every source link go through this.
 */
export function webUrl(url: unknown): string | null {
  if (typeof url !== "string" || url === "") return null;
  try {
    const u = new URL(url);
    return u.protocol === "http:" || u.protocol === "https:" ? u.href : null;
  } catch {
    return null;
  }
}

/** Parse `location.hash` into a Route. Unknown/empty → Inbox (the home). */
export function parseHash(hash: string): Route {
  const raw = hash.replace(/^#/, "");
  const q = raw.indexOf("?");
  const pathPart = q < 0 ? raw : raw.slice(0, q);
  const query = new URLSearchParams(q < 0 ? "" : raw.slice(q + 1));
  const seg = pathPart.split("/").filter(Boolean);
  const [head, a, b] = seg;
  if (seg.length === 0 || head === "inbox") return { name: "inbox" };
  if (head === "compose") return { name: "compose" };
  if (head === "t" && a && b && isSpaceId(a) && ID_RE.test(b)) {
    return { name: "thread", spaceId: a, id: b.toLowerCase() };
  }
  if (head === "round" && a && isSpaceId(a)) {
    const url = webUrl(query.get("url"));
    if (url) return { name: "round", spaceId: a, url };
  }
  if (head === "settings") {
    if (a === "workspace" && b && isSpaceId(b)) return { name: "workspace", spaceId: b };
    const page = SETTINGS_PAGES.find((p) => p === a);
    return { name: "settings", page: page ?? "index" };
  }
  return { name: "inbox" };
}

/** Build the fragment for a route (single source of truth for links). */
export function hashFor(route: Route): string {
  switch (route.name) {
    case "inbox":
      return "#/inbox";
    case "compose":
      return "#/compose";
    case "thread":
      return `#/t/${route.spaceId}/${route.id}`;
    case "round":
      return `#/round/${route.spaceId}?url=${encodeURIComponent(route.url)}`;
    case "settings":
      return route.page === "index" ? "#/settings" : `#/settings/${route.page}`;
    case "workspace":
      return `#/settings/workspace/${route.spaceId}`;
  }
}

/** Where a signed-out visitor goes: sign-in, then back to this exact place. */
export function signInUrl(loc: { pathname: string; search: string; hash: string }): string {
  return `/auth/login?return_to=${encodeURIComponent(loc.pathname + loc.search + loc.hash)}`;
}

/* ── draft keys ────────────────────────────────────────────────────────
 * `<route>:<interactionId>` under the person's partition (the store adds the
 * person id), so a reply draft and a variant-comment draft never collide. */

export type DraftRoute = "reply" | "compose" | "variant-comment";

export function draftKey(route: DraftRoute, interactionId: string): string {
  return `${route}:${interactionId}`;
}

/** The compose draft has no interaction id yet — a stable sentinel. */
export const COMPOSE_DRAFT_ID = "new-comment";

/* ── the merged Inbox ──────────────────────────────────────────────────
 * The server merges attention across the person's spaces and partitions it
 * into needs-you / waiting / recent; the web app only filters by space,
 * labels and draws. It never invents membership. */

export type InboxSection = "needsYou" | "waiting" | "recent";

export const INBOX_SECTIONS: readonly InboxSection[] = ["needsYou", "waiting", "recent"];

export interface SectionMeta {
  title: string;
  tone: "needs-you" | "waiting" | "resolved";
}

export const SECTION_META: Record<InboxSection, SectionMeta> = {
  needsYou: { title: "needs you", tone: "needs-you" },
  waiting: { title: "waiting", tone: "waiting" },
  recent: { title: "recent", tone: "resolved" },
};

export type InboxSections = Record<InboxSection, InboxRow[]>;

/** The Inbox's three sections, narrowed to one space when a filter is set. */
export function filterInbox(inbox: InboxResponse, spaceId: string | null): InboxSections {
  const keep = (rows: InboxRow[]): InboxRow[] =>
    spaceId === null ? rows : rows.filter((r) => r.spaceId === spaceId);
  return {
    needsYou: keep(inbox.needsYou),
    waiting: keep(inbox.waiting),
    recent: keep(inbox.recent),
  };
}

/** The space filter chip row and per-row space names show only when the
 *  person sees more than one space. */
export function showsSpaces(spaces: readonly SpaceSummary[]): boolean {
  return spaces.length > 1;
}

/** The space name a row wears, or null when spaces aren't shown. */
export function rowSpaceName(
  row: { spaceId: string },
  spaces: readonly SpaceSummary[],
): string | null {
  if (!showsSpaces(spaces)) return null;
  return spaces.find((s) => s.id === row.spaceId)?.name ?? null;
}

/** A filter that names a space the person no longer sees falls back to all. */
export function validFilter(
  spaceId: string | null,
  spaces: readonly SpaceSummary[],
): string | null {
  if (spaceId === null || !showsSpaces(spaces)) return null;
  return spaces.some((s) => s.id === spaceId) ? spaceId : null;
}

/** Count copy: "1 needs you" / "2 need you" (lowercase, personal — lexicon). */
export function needsYouCopy(n: number): string {
  return n === 1 ? "1 needs you" : `${n} need you`;
}

/** What a row says about its agent work. */
export const AGENT_WORK_LABEL: Record<AgentWorkStatus, string> = {
  pending: "for agent",
  taken: "taken",
  answered: "answered",
};

/** UI label for a wire kind — the lexicon split (`change` on the wire reads
 *  Edit to the human). Never surfaces "change" as user copy. */
export function kindLabel(kind: InteractionKind): string {
  if (kind === "comment") return "Comment";
  if (kind === "ask") return "Ask";
  return "Edit";
}

/** The one-line row text. `row.text` is the server's summary, already a preview. */
export function rowText(row: AttentionRow): string {
  return row.text.trim() || kindLabel(row.kind);
}

/** The row's secondary meta line — where it lives, in the anchor lexicon. */
export function rowLocation(row: AttentionRow): string {
  if (row.unanchored) return "Inbox · unanchored";
  if (row.anchorLost) return `${row.anchorLabel} · anchor lost`;
  return row.anchorLabel;
}

/* ── search ────────────────────────────────────────────────────────────
 * The corpus is every interaction the person may see in each space, adapted
 * into the Inbox row shape so results reuse the row grammar. Matching rides
 * the ONE shared matcher (`matchesQuery` in @onlay/render). */

export function searchRowOf(spaceId: string, s: RawInteractionSnapshot): InboxRow {
  return {
    spaceId,
    interactionId: s.id,
    kind: s.kind,
    state: s.state,
    ...(s.url !== undefined ? { url: s.url } : {}),
    ...(s.hostUrl !== undefined ? { hostUrl: s.hostUrl } : {}),
    anchorLabel: anchorLabel(s.anchor),
    text: snapshotSummary(s),
    fromActorId: s.authorId,
    waitingOnIds: s.waitingOn,
    ts: snapshotTs(s),
    ...(s.anchor.level === "unanchored" ? { unanchored: true } : {}),
    ...(s.anchorLost ? { anchorLost: true } : {}),
    ...(s.agentWork ? { agentWork: s.agentWork.status } : {}),
  };
}

/** Filter + order search rows: the shared matcher, then needs-you first
 *  (server truth — the Inbox's needs-you membership), then newest. */
export function filterSearchRows(
  rows: InboxRow[],
  query: string,
  needsIds: ReadonlySet<string>,
  personName: (id: string) => string,
): InboxRow[] {
  const matched = rows.filter((r) =>
    matchesQuery(
      {
        text: r.text,
        actorId: r.fromActorId,
        actorName: personName(r.fromActorId),
        context: r.anchorLabel,
        state: r.state,
        place: pathLabel(shownUrl(r)),
        ...(r.url !== undefined ? { url: r.url } : {}),
      },
      query,
    ),
  );
  return matched.sort((a, b) => {
    const an = needsIds.has(a.interactionId);
    if (an !== needsIds.has(b.interactionId)) return an ? -1 : 1;
    return b.ts - a.ts;
  });
}

/* ── what a role lets a person do (spec §7 admission) ─────────────────
 * The server is the gate; this only decides what the web app offers, so a
 * guest is never shown a control the server would refuse. */

export interface Capabilities {
  reply: boolean;
  react: boolean;
  attach: boolean;
  pick: boolean;
  /** Edit or delete your own messages. */
  editOwn: boolean;
  /** Answer an existing Ask (Asks are hidden from creation). */
  answer: boolean;
  resolve: boolean;
  discard: boolean;
  freshLook: boolean;
  share: boolean;
  copyForAgent: boolean;
  /** `@agent` in the mention list. */
  mentionAgent: boolean;
  /** People in the mention list and on the who-line. */
  seePeople: boolean;
}

export function capabilitiesFor(role: SpaceRole | undefined): Capabilities {
  const member = role === "admin" || role === "member";
  return {
    reply: true,
    react: true,
    attach: true,
    pick: true,
    editOwn: member,
    answer: member,
    resolve: member,
    discard: member,
    freshLook: member,
    share: member,
    copyForAgent: member,
    mentionAgent: member,
    seePeople: member,
  };
}

/** The spaces a person is a member of: where they may compose, and what
 *  settings lists. A guest sees nothing of a workspace there. */
export function memberSpaces(spaces: readonly SpaceSummary[]): SpaceSummary[] {
  return spaces.filter((s) => s.role !== "guest");
}

/* ── workspace names (spec §6) ────────────────────────────────────────
 * Live feedback while typing, from the protocol's own rule; uniqueness is
 * the server's answer (`conflict`, shown as it says). */

export interface NameHint {
  ok: boolean;
  /** Empty while the field is empty — no nagging before the first keystroke. */
  message: string;
}

export function workspaceNameHint(name: string): NameHint {
  if (name === "") return { ok: false, message: "" };
  const check = validateWorkspaceName(name);
  return check.ok ? { ok: true, message: "" } : { ok: false, message: check.message };
}

/** The deployment's workspace-creation choices, in the order shown. */
export const CREATION_POLICY_LABEL = {
  super_admins: "Super admins only",
  listed: "Listed people",
  anyone: "Anyone signed in",
} as const;

/** An entry for the creators list: an email, or a domain (no `@`). */
export function creatorOf(raw: string): { entry: string; kind: "email" | "domain" } | null {
  const entry = raw.trim().toLowerCase().replace(/^@/, "");
  if (!entry) return null;
  if (entry.includes("@")) {
    return /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(entry) ? { entry, kind: "email" } : null;
  }
  return /^[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(entry) ? { entry, kind: "domain" } : null;
}
