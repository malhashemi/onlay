// Copy for agent (spec §9): the pointer a person pastes into the agent
// session of their choice. It carries no thread content, so the agent always
// reads current state through its MCP tools. Two forms — a round (every item
// pending for agents on one page) and a single item — byte-for-byte the
// spec's text, shared by the extension and the web app. Each viewer's last
// copy time per interaction is kept in their browser so a thread updated since
// shows "changed since copied".
import type { InteractionKind, RawInteractionSnapshot } from "@onlay/protocol";
import { makeRef } from "@onlay/protocol";

/** UI label for a wire kind: `change` on the wire reads Edit to the human. */
function kindLabel(kind: InteractionKind): string {
  if (kind === "comment") return "Comment";
  if (kind === "ask") return "Ask";
  return "Edit";
}

/** The thread's web link: `<origin>/app/#/t/<spaceId>/<interactionId>`. */
export function threadLink(origin: string, spaceId: string, interactionId: string): string {
  return `${origin}/app/#/t/${spaceId}/${interactionId}`;
}

/** The round view's web link. */
function roundLink(origin: string, spaceId: string, url: string): string {
  return `${origin}/app/#/round/${spaceId}?url=${encodeURIComponent(url)}`;
}

export interface RoundCopy {
  origin: string;
  spaceId: string;
  spaceName: string;
  /** The page the round covers. */
  url: string;
  count: number;
  /**
   * Every page of one tab with items in the round (A-2): the top page first,
   * then its frames' addresses. With two or more, the round names each.
   */
  pages?: readonly string[];
}

/** The round form:
 *  `Onlay: <N> item(s) for an agent on <page URL> (<space name>)`, the round
 *  link, and the `inbox` call. A round over several pages of one tab (A-2)
 *  says how many, gives one round link per page, top page first, and one
 *  `inbox` call per page. */
export function roundCopyText(r: RoundCopy): string {
  const pages = r.pages && r.pages.length > 1 ? r.pages : null;
  if (pages) {
    const calls = pages.map(
      (url) => `inbox {"space": ${JSON.stringify(r.spaceId)}, "url": ${JSON.stringify(url)}}`,
    );
    return [
      `Onlay: ${r.count === 1 ? "1 item" : `${r.count} items`} for an agent on ${pages.length} pages (${r.spaceName})`,
      ...pages.map((url) => roundLink(r.origin, r.spaceId, url)),
      "With the onlay MCP tools, call:",
      ...calls,
      "Then for each item, take, read, and answer.",
    ].join("\n");
  }
  return [
    `Onlay: ${r.count} item(s) for an agent on ${r.url} (${r.spaceName})`,
    roundLink(r.origin, r.spaceId, r.url),
    `With the onlay MCP tools: inbox {"space": ${JSON.stringify(r.spaceId)}, "url": ${JSON.stringify(r.url)}}, then for each item take, read, and answer.`,
  ].join("\n");
}

export interface ItemCopy {
  origin: string;
  spaceId: string;
  spaceName: string;
  interactionId: string;
  kind: InteractionKind;
  /** The page; absent for an unanchored interaction. */
  url?: string;
}

/** The single-item form: `Onlay: <kind> on <page URL> (<space name>)`, the
 *  thread link, and the `read` call. An unanchored item has no page, so its
 *  first line drops the ` on <page URL>` part. */
export function itemCopyText(i: ItemCopy): string {
  const where = i.url ? ` on ${i.url}` : "";
  return [
    `Onlay: ${kindLabel(i.kind)}${where} (${i.spaceName})`,
    threadLink(i.origin, i.spaceId, i.interactionId),
    `read {"ref": ${JSON.stringify(makeRef(i.spaceId, i.interactionId))}}`,
  ].join("\n");
}

/* ── changed since copied ──────────────────────────────────────────── */

/** The slice of Storage this needs (tests pass a Map-backed stub). */
export interface KeyValue {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

const MAX_REMEMBERED = 200;

function storageKey(personId: string): string {
  return `onlay-copied:${personId}`;
}

function readCopies(kv: KeyValue, personId: string): Record<string, number> {
  try {
    const parsed = JSON.parse(kv.getItem(storageKey(personId)) ?? "{}") as unknown;
    return parsed && typeof parsed === "object" ? (parsed as Record<string, number>) : {};
  } catch {
    return {};
  }
}

/** Remember that this person copied these refs at `at`. Keeps the newest. */
export function markCopied(
  kv: KeyValue,
  personId: string,
  refs: readonly string[],
  at: number,
): void {
  try {
    const copies = readCopies(kv, personId);
    for (const ref of refs) copies[ref] = at;
    const kept = Object.entries(copies)
      .sort(([, a], [, b]) => b - a)
      .slice(0, MAX_REMEMBERED);
    kv.setItem(storageKey(personId), JSON.stringify(Object.fromEntries(kept)));
  } catch {
    // storage may be denied — the marker is a convenience
  }
}

/**
 * When an interaction last changed, from what its snapshot carries: created,
 * any message posted or edited, agent work requested, taken or answered,
 * resolved. Both clients read "changed since copied" against this one time.
 */
export function interactionUpdatedAt(s: RawInteractionSnapshot): number {
  let t = s.createdAt;
  for (const m of s.thread) t = Math.max(t, m.ts, m.editedAt ?? 0);
  const w = s.agentWork;
  if (w) t = Math.max(t, w.requestedAt, w.takenAt ?? 0, w.answeredAt ?? 0);
  return Math.max(t, s.resolvedAt ?? 0);
}

/** True when the item was copied before and has changed since. */
export function changedSinceCopied(
  kv: KeyValue,
  personId: string,
  ref: string,
  updatedAt: number,
): boolean {
  const at = readCopies(kv, personId)[ref];
  return typeof at === "number" && updatedAt > at;
}
