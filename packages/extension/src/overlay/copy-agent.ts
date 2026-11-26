// Copy for agent in the overlay (spec §9): the text comes from the formatter
// the web app shares (`@onlay/render/copy-for-agent`); this module picks what
// to copy — one interaction, or this page's round per space — and remembers
// when this viewer last copied each interaction (chrome.storage.local), so a
// row or thread header can say "changed since copied".
import type { RawInteractionSnapshot } from "@onlay/protocol";
import { makeRef } from "@onlay/protocol";
import {
  changedSinceCopied,
  interactionUpdatedAt,
  itemCopyText,
  type KeyValue,
  markCopied,
  roundCopyText,
} from "@onlay/render/copy-for-agent";
import type { App, InteractionSnap } from "./app";
import { agentWorkStatus, isLiveState } from "./kinds";

/** The chrome.storage.local key mirroring the web app's per-person copy times. */
const COPIED_KEY = "onlayCopied";

/** The marker a row or thread header shows. */
export const CHANGED_SINCE_COPIED = "changed since copied";

/**
 * A synchronous KeyValue over chrome.storage.local: read once at start, then
 * written through. The formatter's memory helpers stay shared and pure.
 */
function createCopiedStore(onLoaded: () => void = () => {}): KeyValue {
  const cache = new Map<string, string>();
  try {
    void chrome.storage.local.get(COPIED_KEY).then(
      (got: Record<string, unknown>) => {
        const raw = got[COPIED_KEY];
        if (raw && typeof raw === "object") {
          for (const [k, v] of Object.entries(raw)) if (typeof v === "string") cache.set(k, v);
        }
        onLoaded();
      },
      () => {},
    );
  } catch {
    /* stale context: the marker is a convenience */
  }
  return {
    getItem: (k) => cache.get(k) ?? null,
    setItem: (k, v) => {
      cache.set(k, v);
      try {
        void chrome.storage.local.set({ [COPIED_KEY]: Object.fromEntries(cache) }).catch(() => {});
      } catch {
        /* stale context */
      }
    },
  };
}

let shared: KeyValue | null = null;

/** The one copy-time store for this page (tests swap in their own). */
export function copiedStore(onLoaded?: () => void): KeyValue {
  if (!shared) shared = createCopiedStore(onLoaded);
  return shared;
}

export function setCopiedStore(kv: KeyValue | null): void {
  shared = kv;
}

function originOf(app: App): string {
  return app.serverOrigin();
}

/** The single-item text for one interaction (no page for an unanchored one). */
export function itemText(
  app: App,
  s: {
    id: string;
    spaceId: string;
    kind: RawInteractionSnapshot["kind"];
    url?: string | undefined;
    anchor?: { level: string };
  },
): string {
  // An unanchored item has no page to name, whatever URL it was raised from.
  const url = s.anchor?.level === "unanchored" ? undefined : s.url;
  return itemCopyText({
    origin: originOf(app),
    spaceId: s.spaceId,
    spaceName: app.space(s.spaceId)?.name ?? "",
    interactionId: s.id,
    kind: s.kind,
    ...(url !== undefined ? { url } : {}),
  });
}

/** This page's items pending for an agent, live only (an expired lease counts). */
export function pendingForAgent(items: readonly InteractionSnap[], now = Date.now()) {
  return items.filter(
    (s) => isLiveState(s.state) && agentWorkStatus(s.agentWork, now) === "pending",
  );
}

/** A child frame of the tab: its own address and the threads bound to it. */
export interface FramePage {
  url: string;
  interactions: readonly InteractionSnap[];
}

/**
 * This tab's round: one block per space with pending items, in the order of
 * the person's spaces, separated by a blank line. A space whose pending items
 * sit on several pages of the tab (the top page and its frames' addresses,
 * A-2) names each page, the top page first. Empty when nothing waits.
 */
export function roundText(
  app: App,
  pageUrl: string,
  frames: readonly FramePage[] = [],
): { text: string; ids: InteractionSnap[] } {
  const pages: Array<{ url: string; items: InteractionSnap[] }> = [
    { url: pageUrl, items: pendingForAgent(app.interactions()) },
  ];
  const seen = new Set(pages[0]?.items.map((s) => s.id));
  for (const f of frames) {
    const items = pendingForAgent(f.interactions).filter((s) => !seen.has(s.id));
    for (const s of items) seen.add(s.id);
    if (items.length === 0) continue;
    const same = pages.find((p) => p.url === f.url);
    if (same) same.items.push(...items);
    else pages.push({ url: f.url, items });
  }
  const pending = pages.flatMap((p) => p.items);
  const blocks: string[] = [];
  const order = app.spaces().map((s) => s.id);
  const spaces = [...new Set(pending.map((s) => s.spaceId))].sort(
    (a, b) => order.indexOf(a) - order.indexOf(b),
  );
  for (const spaceId of spaces) {
    const urls = pages.filter((p) => p.items.some((s) => s.spaceId === spaceId)).map((p) => p.url);
    blocks.push(
      roundCopyText({
        origin: originOf(app),
        spaceId,
        spaceName: app.space(spaceId)?.name ?? "",
        url: urls[0] ?? pageUrl,
        count: pending.filter((s) => s.spaceId === spaceId).length,
        pages: urls,
      }),
    );
  }
  return { text: blocks.join("\n\n"), ids: pending };
}

/** Remember that this viewer copied these interactions now. */
export function rememberCopied(
  kv: KeyValue,
  app: App,
  items: ReadonlyArray<{ id: string; spaceId: string }>,
  at = Date.now(),
): void {
  const self = app.selfId();
  if (!self || items.length === 0) return;
  markCopied(
    kv,
    self,
    items.map((s) => makeRef(s.spaceId, s.id)),
    at,
  );
}

/** Copied before, and changed since. */
export function changedSince(kv: KeyValue, app: App, s: InteractionSnap): boolean {
  const self = app.selfId();
  if (!self) return false;
  return changedSinceCopied(kv, self, makeRef(s.spaceId, s.id), interactionUpdatedAt(s));
}

/** What the copy actions say. */
export const COPY_COPY = {
  action: "Copy for agent",
  copied: "Copied. Paste it into your agent's session.",
  failed: "Couldn't copy. Try again.",
  nothingPending: "Nothing on this page is waiting for an agent.",
} as const;

/**
 * Copy `text`, remember the copy for `items`, and say so. Runs inside the
 * click that asked for it (the clipboard needs that gesture).
 */
export function copyAndRemember(
  app: App,
  text: string,
  items: ReadonlyArray<{ id: string; spaceId: string }>,
): Promise<boolean> {
  return writeClipboard(text).then((ok) => {
    if (ok) {
      rememberCopied(copiedStore(), app, items);
      app.requestRender();
    }
    app.toast(ok ? COPY_COPY.copied : COPY_COPY.failed);
    return ok;
  });
}

/** Copy this tab's round (its frames' pages too, A-2), or say there is nothing to copy. */
export function copyRound(app: App, frames: readonly FramePage[] = []): Promise<boolean> {
  const round = roundText(app, app.frameUrl(), frames);
  if (round.ids.length === 0) {
    app.toast(COPY_COPY.nothingPending);
    return Promise.resolve(false);
  }
  return copyAndRemember(app, round.text, round.ids);
}

/** Put text on the clipboard; false when the page or browser refuses. */
function writeClipboard(text: string): Promise<boolean> {
  try {
    return navigator.clipboard.writeText(text).then(
      () => true,
      () => false,
    );
  } catch {
    return Promise.resolve(false);
  }
}
