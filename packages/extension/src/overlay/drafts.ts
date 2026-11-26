// Draft preservation for the overlay's imperative rebuilds. The panels are a
// pure view — every `interactions-state` frame tears the thread body down and
// rebuilds it from the snapshot (thread.ts, content.ts render dispatch). That
// vaporizes any in-progress composer text and the caret. This
// module keeps unsent text alive across those rebuilds, keyed by a stable id
// (per interaction / per message), and restores focus + caret to whichever
// keyed input was active when the rebuild ran.
//
// Value shape: legacy drafts were plain strings; token editors persist a full
// RawRichText so anchor-token JSON survives a rebuild (actor tokens could
// re-derive from the directory, anchors could not). Both shapes coexist —
// readDraft returns just the text, readRichDraft normalizes either.
import type { RawRichText } from "@onlay/protocol";
import {
  type SendAttempt,
  type SendAttemptStore,
  UNCONFIRMED_TTL_MS,
} from "@onlay/render/send-ids";
import { caretOffset, setCaretOffset } from "./caret";

const store = new Map<string, string | RawRichText>();
/**
 * Unconfirmed sends' ids, per place (2-D1): kept, saved and restored with the
 * drafts, so a retry of the same text after a reload reuses the id. Their
 * revision keys start with SEND; their saves are per id (`sendOps`).
 */
const sends = new Map<string, SendAttempt[]>();
const SEND = "\u0001";
/** Every write to a key bumps its revision: a send's completion clears only the revision it sent. */
const revisions = new Map<string, number>();
let writes = 0;

/**
 * Whose drafts these are: `<person>|<server origin>` while signed in, else
 * null. Every key is stored under it, so a draft belongs to one account on
 * one server (2-M1).
 */
let scope: string | null = null;

const scoped = (key: string): string => `${scope ?? ""}\u0000${key}`;

/**
 * The signed-in account (or the server) is now `next`. Leaving a known
 * account (signing out, another person signing in, another server) drops
 * every draft of it: whoever comes next starts with none. Coming from no
 * account (the first status after a page load, or after a sign-out) drops
 * nothing: what was typed before it belongs to the account now known (3-M1).
 */
export function setDraftScope(next: string | null): void {
  if (next === scope) return;
  const prev = scope;
  const before = scoped("");
  scope = next;
  if (prev !== null) {
    store.clear();
    sends.clear();
    revisions.clear();
    // Nothing of the old account is saved; the service worker wipes its own copy.
    pending.clear();
    sendOps.clear();
    return;
  }
  const after = scoped("");
  const move = <V>(map: Map<string, V>, revKey: (k: string) => string): void => {
    for (const [k, v] of [...map]) {
      if (k.startsWith(after)) continue;
      map.delete(k);
      // Restored for an account that is not the one now known: not this one's.
      if (!k.startsWith(before)) {
        revisions.delete(revKey(k));
        continue;
      }
      const key = after + k.slice(before.length);
      map.set(key, v);
      revisions.set(revKey(key), revisions.get(revKey(k)) ?? 0);
      revisions.delete(revKey(k));
    }
  };
  move(store, (k) => k);
  move(sends, sendRevKey);
  // What was typed before the account was known is saved under it now.
  if (next !== null && (pending.size > 0 || sendOps.size > 0)) schedule(0);
}

function put(key: string, value: string | RawRichText | undefined): void {
  const k = scoped(key);
  if (value === undefined) store.delete(k);
  else store.set(k, value);
  writes += 1;
  revisions.set(k, writes);
  if (!port) return;
  pending.add(key);
  // A removal (sent, cancelled) is saved at once: a reload must never bring it back.
  schedule(value === undefined ? 0 : SAVE_DELAY_MS);
}

/** A scoped send key's revision key: the place behind SEND, beside the drafts'. */
function sendRevKey(k: string): string {
  const at = k.indexOf("\u0000");
  return `${k.slice(0, at + 1)}${SEND}${k.slice(at + 1)}`;
}

/**
 * The unconfirmed sends' store `send-ids.ts` uses: kept with the drafts, under
 * the same account, and saved at once (the send goes out right after). What
 * is saved is each id added or removed, never a place's whole list (3-D1):
 * another tab's attempts from the same place stay stored.
 */
export const draftSendStore: SendAttemptStore = {
  get: (place) => sends.get(scoped(place)),
  set: (place, attempts) => {
    const k = scoped(place);
    const before = sends.get(k) ?? [];
    if (attempts.length > 0) sends.set(k, attempts);
    else sends.delete(k);
    writes += 1;
    revisions.set(sendRevKey(k), writes);
    if (!port) return;
    const now = new Set(attempts.map((a) => a.clientId));
    const was = new Set(before.map((a) => a.clientId));
    for (const a of attempts) {
      if (!was.has(a.clientId)) sendOps.set(`${place}\u0000${a.clientId}`, { key: place, add: a });
    }
    for (const a of before) {
      if (!now.has(a.clientId))
        sendOps.set(`${place}\u0000${a.clientId}`, { key: place, remove: a.clientId });
    }
    flushDrafts();
  },
};

/* ── kept across page reloads (D-1) ─────────────────────────────────── */

/**
 * Where drafts are kept between page loads: the service worker's
 * chrome.storage.session (memory only, never the server). `load` answers with
 * the scope they belong to and this sender's drafts; `save` sends changed keys
 * (null: gone) under the scope they were written in.
 */
export interface DraftPort {
  load(): Promise<{
    scope: string;
    drafts: Array<{ key: string; value: unknown }>;
    sends?: Array<{ key: string; sends: unknown }>;
  } | null>;
  save(scope: string, changes: DraftChange[]): void;
}

/**
 * One saved change: a draft's value (null: gone), or one unconfirmed send
 * from place `key` added, or removed by its id.
 */
export type DraftChange =
  | { key: string; value: string | RawRichText | null }
  | { key: string; add: SendAttempt }
  | { key: string; remove: string };

/** Typing is saved this long after the last keystroke. */
const SAVE_DELAY_MS = 300;
let port: DraftPort | null = null;
/** Keys written since the last save, under the current scope. */
const pending = new Set<string>();
/** Send ids added or removed since the last save, per place and id (the last op wins). */
const sendOps = new Map<string, DraftChange>();
let saveTimer: ReturnType<typeof setTimeout> | undefined;
let saveDue = Number.POSITIVE_INFINITY;

function schedule(ms: number): void {
  const due = Date.now() + ms;
  if (saveTimer !== undefined && saveDue <= due) return;
  if (saveTimer !== undefined) clearTimeout(saveTimer);
  saveDue = due;
  saveTimer = setTimeout(flushDrafts, ms);
}

/** Save every changed draft now (also on pagehide: the page may be going away). */
export function flushDrafts(): void {
  if (saveTimer !== undefined) clearTimeout(saveTimer);
  saveTimer = undefined;
  saveDue = Number.POSITIVE_INFINITY;
  // Before the account is known nothing is saved: it is saved once it is.
  if (!port || scope === null || (pending.size === 0 && sendOps.size === 0)) return;
  const changes: DraftChange[] = [
    ...[...pending].map((key) => ({ key, value: store.get(scoped(key)) ?? null })),
    ...sendOps.values(),
  ];
  pending.clear();
  sendOps.clear();
  try {
    port.save(scope, changes);
  } catch {
    // stale extension context: the drafts stay in memory for this page
  }
}

function restoredSends(v: unknown): SendAttempt[] | null {
  if (!Array.isArray(v)) return null;
  const t = Date.now();
  const list = v.filter(
    (a): a is SendAttempt =>
      !!a &&
      typeof a.clientId === "string" &&
      typeof a.sig === "string" &&
      typeof a.at === "number" &&
      t - a.at < UNCONFIRMED_TTL_MS,
  );
  return list.length > 0 ? list.map(({ clientId, sig, at }) => ({ clientId, sig, at })) : null;
}

function restoredValue(v: unknown): string | RawRichText | null {
  if (typeof v === "string") return v || null;
  if (!v || typeof v !== "object") return null;
  const r = v as { text?: unknown; tokens?: unknown };
  if (typeof r.text !== "string") return null;
  if (r.tokens !== undefined && !Array.isArray(r.tokens)) return null;
  return v as RawRichText;
}

/**
 * Keep drafts across page reloads through `port`, and restore this page's
 * drafts from it. Resolves once they are restored, or after `timeoutMs` (a
 * late answer still restores what nothing was written to since).
 */
export function persistDrafts(next: DraftPort, timeoutMs = 1000): Promise<void> {
  stopPersistingDrafts();
  port = next;
  const since = writes;
  const restored = next.load().then(
    (got) => {
      if (!got || typeof got.scope !== "string" || !Array.isArray(got.drafts)) return;
      // Another account is known on this page by now: none of these are its.
      if (scope !== null && scope !== got.scope) return;
      for (const d of got.drafts) {
        if (typeof d?.key !== "string") continue;
        const v = restoredValue(d.value);
        if (v === null) continue;
        const k = `${got.scope}\u0000${d.key}`;
        const local = scope === null ? `\u0000${d.key}` : k;
        // Written (or cleared) on this page since the load began: that is newer.
        if ((revisions.get(local) ?? 0) > since || (revisions.get(k) ?? 0) > since) continue;
        store.set(k, v);
        writes += 1;
        revisions.set(k, writes);
      }
      for (const d of Array.isArray(got.sends) ? got.sends : []) {
        if (typeof d?.key !== "string") continue;
        const list = restoredSends(d.sends);
        if (list === null) continue;
        const k = `${got.scope}\u0000${d.key}`;
        const local = scope === null ? `\u0000${d.key}` : k;
        // Sent or confirmed on this page since the load began: that is newer.
        const touched = (rk: string) => (revisions.get(sendRevKey(rk)) ?? 0) > since;
        if (touched(local) || touched(k)) continue;
        sends.set(k, list);
        writes += 1;
        revisions.set(sendRevKey(k), writes);
      }
    },
    () => {},
  );
  return Promise.race([restored, new Promise<void>((resolve) => setTimeout(resolve, timeoutMs))]);
}

/** Stop keeping drafts across reloads (tests; the page's own drafts stay in memory). */
export function stopPersistingDrafts(): void {
  if (saveTimer !== undefined) clearTimeout(saveTimer);
  saveTimer = undefined;
  saveDue = Number.POSITIVE_INFINITY;
  pending.clear();
  sendOps.clear();
  port = null;
}

/** The extension's port: the service worker's `drafts` handler. */
function runtimeDraftPort(): DraftPort {
  return {
    load: async () => {
      try {
        const res = (await chrome.runtime.sendMessage({ type: "drafts", op: "load" })) as
          | {
              ok?: boolean;
              scope?: string;
              drafts?: Array<{ key: string; value: unknown }>;
              sends?: Array<{ key: string; sends: unknown }>;
            }
          | undefined;
        if (!res?.ok || typeof res.scope !== "string" || !Array.isArray(res.drafts)) return null;
        return {
          scope: res.scope,
          drafts: res.drafts,
          ...(Array.isArray(res.sends) ? { sends: res.sends } : {}),
        };
      } catch {
        return null;
      }
    },
    save: (s, changes) => {
      void chrome.runtime
        .sendMessage({ type: "drafts", op: "save", scope: s, changes })
        .catch(() => {});
    },
  };
}

/** Restore this page's drafts and keep them across reloads (one call at start). */
export function restoreDrafts(): Promise<void> {
  try {
    addEventListener("pagehide", flushDrafts);
    document.addEventListener("visibilitychange", () => {
      if (document.visibilityState === "hidden") flushDrafts();
    });
  } catch {
    /* no window */
  }
  return persistDrafts(runtimeDraftPort());
}

/** Current text for a keyed draft, if any (rich drafts yield their wire text). */
export function readDraft(key: string): string | undefined {
  const v = store.get(scoped(key));
  if (v === undefined) return undefined;
  return typeof v === "string" ? v : v.text;
}

/** Persist (or, when empty, forget) a keyed plain-text draft. */
export function writeDraft(key: string, text: string): void {
  put(key, text || undefined);
}

/**
 * Full rich draft — a legacy plain-string draft normalizes to `{text}`. A
 * token editor's draft keeps each pill's `spans` (2-M4).
 */
export function readRichDraft(key: string): RawRichText | undefined {
  const v = store.get(scoped(key));
  if (v === undefined) return undefined;
  return typeof v === "string" ? { text: v } : v;
}

/** Persist (or, when empty, forget) a keyed rich draft, tokens included. */
export function writeRichDraft(key: string, value: RawRichText): void {
  put(key, value.text || (value.tokens?.length ?? 0) > 0 ? value : undefined);
}

/** Forget a keyed draft (on send / cancel). */
export function clearDraft(key: string): void {
  put(key, undefined);
}

/**
 * Where the message a reply from `place` quotes is kept: beside the reply's
 * draft, in the same store, under the same account and bounds, saved and
 * restored with it (S-1). A retry after a reload then sends the identical
 * payload and reuses its send id.
 */
const quoteKey = (place: string): string => `${place}\u0002quote`;

/** A message of a thread, as much as a quote needs to know of it. */
interface QuotableMsg {
  msgId: string;
  deleted?: boolean | undefined;
  system?: boolean | undefined;
}

/**
 * The message a reply from `place` is quoting, or null. Given the thread, a
 * quote whose message is gone (deleted, or not in it) is dropped quietly.
 */
export function replyQuote(place: string, thread?: readonly QuotableMsg[]): string | null {
  const v = store.get(scoped(quoteKey(place)));
  const msgId = typeof v === "string" && v ? v : null;
  if (msgId === null || thread === undefined) return msgId;
  const target = thread.find((m) => m.msgId === msgId);
  if (target && !target.deleted && !target.system) return msgId;
  setReplyQuote(place, null);
  return null;
}

/** The reply from `place` now quotes `msgId` (null: no quote). */
export function setReplyQuote(place: string, msgId: string | null): void {
  if (replyQuote(place) === msgId) return;
  put(quoteKey(place), msgId ?? undefined);
}

/** The draft's revision now: compare it after a send to know whether it was written since. */
export function draftRevision(key: string): number {
  return revisions.get(scoped(key)) ?? 0;
}

/**
 * A send's completion: forget the draft only if nothing was written to it
 * since `revision` was read, so text typed later (in this composer or in one
 * reopened on the same target) stays (2-M2). True when it was forgotten.
 */
export function clearDraftIfUnchanged(key: string, revision: number): boolean {
  if (draftRevision(key) !== revision) return false;
  clearDraft(key);
  return true;
}

type FieldInput = HTMLTextAreaElement | HTMLInputElement;

function isField(node: Element): node is FieldInput {
  const tag = node.tagName;
  return tag === "TEXTAREA" || tag === "INPUT";
}

function keyedInput(node: Element | null): HTMLElement | null {
  if (node instanceof HTMLElement && node.dataset.draftKey) return node;
  return null;
}

/**
 * Run a synchronous DOM rebuild while keeping the focused keyed input focused.
 * Snapshots the active input's key/caret/scroll before `rebuild`, then finds
 * the freshly-built input carrying the same `data-draft-key` and restores
 * them. Handles both native fields (selectionStart) and contenteditable token
 * editors (character-offset caret via caret.ts). The text itself rides the
 * draft store (the token editor restores it on build).
 */
export function preserveFocus(root: ShadowRoot, rebuild: () => void): void {
  const active = keyedInput(root.activeElement);
  let key: string | null = null;
  let selStart = 0;
  let selEnd = 0;
  let caret: number | null = null;
  let scrollTop = 0;
  if (active) {
    key = active.dataset.draftKey ?? null;
    scrollTop = active.scrollTop;
    if (isField(active)) {
      selStart = active.selectionStart ?? active.value.length;
      selEnd = active.selectionEnd ?? active.value.length;
    } else {
      caret = caretOffset(active);
    }
  }
  rebuild();
  if (key === null) return;
  for (const n of root.querySelectorAll("[data-draft-key]")) {
    if ((n as HTMLElement).dataset.draftKey !== key) continue;
    const next = n as HTMLElement;
    next.focus();
    if (isField(next)) {
      try {
        next.setSelectionRange(selStart, selEnd);
      } catch {
        // non-text inputs reject setSelectionRange — focus alone is enough
      }
    } else if (caret !== null) {
      setCaretOffset(next, caret);
    }
    next.scrollTop = scrollTop;
    return;
  }
}
