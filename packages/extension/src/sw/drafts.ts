// Unsent text kept across page reloads (D-1). The overlay's draft store
// (overlay/drafts.ts) writes through here; the service worker keeps it in
// chrome.storage.session: memory only, so it survives reloads and worker
// restarts but not a browser restart, and never reaches the disk or the
// server. Content scripts have no access to that area of their own, so the
// service worker is the only reader and writer, and it decides what a sender
// may see:
// - one account on one server (`<person>|<server origin>`, the scope the
//   overlay uses): a message from another scope is refused, and a stored
//   record of another scope is wiped at the next touch;
// - one origin, as the browser reports the sender (never a claim in the
//   message): a frame reads and writes only the drafts typed on its own
//   origin, so a frame of one site never sees what was typed on another.
// Bounded: the newest 200 drafts, at most 64 KiB each and 4 MiB in all
// (session storage holds 10 MB for everything the worker keeps there).
//
// Beside each draft, the ids of its unconfirmed sends (2-D1): what was sent
// from a place and never confirmed keeps its id here for 10 minutes, so a
// retry of the restored text after a reload carries the same id and the space
// answers it once. They share the drafts' scope, origin, budget and fate.
// Each attempt is its own entry, added and removed one id at a time (3-D1):
// two tabs sending from the same place each keep their id, and one tab's
// confirmation removes only the id it confirmed.
import { type SendAttempt, UNCONFIRMED_TTL_MS } from "@onlay/render/send-ids";

export const DRAFTS_KEY = "drafts";
export const DRAFT_LIMITS = {
  count: 200,
  entryBytes: 64 * 1024,
  totalBytes: 4 * 1024 * 1024,
} as const;

/** A stored draft value: plain text, or rich text with its tokens. */
type DraftValue = string | { text: string; tokens?: unknown[] };

interface Entry {
  /** The sender's origin. */
  o: string;
  /** The overlay's draft key. */
  k: string;
  /** A draft's value; or, for one unconfirmed send from place `k`, `a`. */
  v?: DraftValue;
  a?: SendAttempt;
  /** Write order: the oldest go first. */
  n: number;
  /** Bytes it costs against the budget. */
  b: number;
}

interface DraftRecord {
  scope: string;
  seq: number;
  entries: Record<string, Entry>;
}

export interface DraftStorePorts {
  get(key: string): Promise<Record<string, unknown>>;
  set(items: Record<string, unknown>): Promise<void>;
  remove(key: string): Promise<void>;
  /** `<person id>|<server origin>` while signed in, else null. */
  scope(): Promise<string | null>;
  now?(): number;
}

export interface DraftSender {
  origin?: string | undefined;
  url?: string | undefined;
}

const MAX_KEY = 4096;
/** A request id is short (`LIMITS.MAX_VARIANT_SET_ID`); anything longer is not one. */
const MAX_CLIENT_ID = 128;

const isClientId = (v: unknown): v is string =>
  typeof v === "string" && v.length > 0 && v.length <= MAX_CLIENT_ID;

/** One unconfirmed attempt, when well-formed and still within its 10 minutes. */
function sendAttempt(v: unknown, now: number): SendAttempt | null {
  if (!v || typeof v !== "object") return null;
  const { clientId, sig, at } = v as Partial<SendAttempt>;
  if (!isClientId(clientId) || typeof sig !== "string") return null;
  if (typeof at !== "number" || !Number.isFinite(at)) return null;
  if (now - at >= UNCONFIRMED_TTL_MS || at > now + 60_000) return null;
  return { clientId, sig, at };
}

/** Where one attempt is stored: per origin, place and id. */
const attemptId = (origin: string, place: string, clientId: string): string =>
  `${origin}\u0000\u0001${place}\u0000${clientId}`;
const encoder = new TextEncoder();

/** The sender's origin as the browser reports it; null when it has none worth keeping. */
export function senderOrigin(sender: DraftSender | undefined): string | null {
  let o = sender?.origin;
  if (o === undefined && sender?.url) {
    try {
      o = new URL(sender.url).origin;
    } catch {
      return null;
    }
  }
  // An opaque origin (a sandboxed frame, a data: document) is no one's to share.
  if (!o || o === "null") return null;
  return o;
}

function draftValue(v: unknown): DraftValue | null {
  if (typeof v === "string") return v;
  if (!v || typeof v !== "object") return null;
  const r = v as { text?: unknown; tokens?: unknown };
  if (typeof r.text !== "string") return null;
  if (r.tokens !== undefined && !Array.isArray(r.tokens)) return null;
  return r.tokens !== undefined ? { text: r.text, tokens: r.tokens } : { text: r.text };
}

function sizeOf(key: string, v: DraftValue | SendAttempt): number {
  return encoder.encode(key).length + encoder.encode(JSON.stringify(v)).length;
}

function readRecord(raw: unknown, scope: string): DraftRecord | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Partial<DraftRecord>;
  if (r.scope !== scope || typeof r.seq !== "number" || !r.entries) return null;
  return r as DraftRecord;
}

/** Oldest out until both the count and the byte budget hold. */
function trim(rec: DraftRecord): void {
  const all = Object.entries(rec.entries).sort((a, b) => b[1].n - a[1].n);
  let bytes = 0;
  let kept = 0;
  for (const [id, e] of all) {
    if (kept < DRAFT_LIMITS.count && bytes + e.b <= DRAFT_LIMITS.totalBytes) {
      kept += 1;
      bytes += e.b;
    } else {
      delete rec.entries[id];
    }
  }
}

export interface DraftStore {
  /** Answer one `drafts` message from a content script or the full view. */
  handle(msg: Record<string, unknown>, sender: DraftSender | undefined): Promise<unknown>;
  /** Wipe what is stored when it belongs to an account that is no longer the signed-in one. */
  check(): Promise<void>;
}

export function createDraftStore(ports: DraftStorePorts): DraftStore {
  // One read-modify-write at a time: two tabs saving at once never lose either.
  let chain: Promise<unknown> = Promise.resolve();
  const serial = <T>(fn: () => Promise<T>): Promise<T> => {
    const run = chain.then(fn, fn);
    chain = run.catch(() => {});
    return run;
  };

  /** The record of the signed-in scope; one of another scope is wiped. */
  async function current(): Promise<{ scope: string | null; rec: DraftRecord | null }> {
    const scope = await ports.scope();
    const got = await ports.get(DRAFTS_KEY);
    const raw = got[DRAFTS_KEY];
    const rec = scope ? readRecord(raw, scope) : null;
    if (raw !== undefined && rec === null) await ports.remove(DRAFTS_KEY);
    return { scope, rec };
  }

  async function load(sender: DraftSender | undefined): Promise<unknown> {
    const origin = senderOrigin(sender);
    const { scope, rec } = await current();
    if (!scope || !origin) return { ok: false };
    const now = (ports.now ?? Date.now)();
    const mine = Object.values(rec?.entries ?? {})
      .filter((e) => e.o === origin)
      .sort((a, b) => a.n - b.n);
    const drafts = mine.flatMap((e) => (e.v !== undefined ? [{ key: e.k, value: e.v }] : []));
    // Every live attempt of a place, whichever tab sent it, oldest first.
    const byPlace = new Map<string, SendAttempt[]>();
    for (const e of mine) {
      const a = e.a !== undefined ? sendAttempt(e.a, now) : null;
      if (a) byPlace.set(e.k, [...(byPlace.get(e.k) ?? []), a]);
    }
    const sends = [...byPlace].map(([key, list]) => ({ key, sends: list }));
    return { ok: true, scope, drafts, sends };
  }

  async function save(
    msg: Record<string, unknown>,
    sender: DraftSender | undefined,
  ): Promise<unknown> {
    const origin = senderOrigin(sender);
    const { scope, rec: stored } = await current();
    // Composed under another account (or signed out since): nothing is kept.
    if (!scope || !origin || msg.scope !== scope) return { ok: false };
    if (!Array.isArray(msg.changes)) return { ok: false };
    const rec: DraftRecord = stored ?? { scope, seq: 0, entries: {} };
    const now = (ports.now ?? Date.now)();
    for (const c of msg.changes as unknown[]) {
      if (!c || typeof c !== "object") continue;
      const { key, value } = c as { key?: unknown; value?: unknown };
      if (typeof key !== "string" || !key || key.length > MAX_KEY) continue;
      // One attempt added, or one removed by its id: never a place's whole list.
      if ("add" in c) {
        const a = sendAttempt((c as { add?: unknown }).add, now);
        if (a === null) continue;
        const bytes = sizeOf(key, a);
        if (bytes > DRAFT_LIMITS.entryBytes) continue;
        rec.seq += 1;
        rec.entries[attemptId(origin, key, a.clientId)] = {
          o: origin,
          k: key,
          a,
          n: rec.seq,
          b: bytes,
        };
        continue;
      }
      if ("remove" in c) {
        const id = (c as { remove?: unknown }).remove;
        if (isClientId(id)) delete rec.entries[attemptId(origin, key, id)];
        continue;
      }
      const id = `${origin}\u0000${key}`;
      const v = value === null ? null : draftValue(value);
      const bytes = v === null ? 0 : sizeOf(key, v);
      // Gone, or too big to keep: an older, shorter version must not come back either.
      if (v === null || bytes > DRAFT_LIMITS.entryBytes) {
        delete rec.entries[id];
        continue;
      }
      rec.seq += 1;
      rec.entries[id] = { o: origin, k: key, v, n: rec.seq, b: bytes };
    }
    trim(rec);
    if (Object.keys(rec.entries).length === 0) await ports.remove(DRAFTS_KEY);
    else await ports.set({ [DRAFTS_KEY]: rec });
    return { ok: true };
  }

  return {
    handle: (msg, sender) =>
      serial(async () => {
        if (msg.op === "load") return load(sender);
        if (msg.op === "save") return save(msg, sender);
        return { ok: false };
      }),
    check: () =>
      serial(async () => {
        await current();
      }),
  };
}
