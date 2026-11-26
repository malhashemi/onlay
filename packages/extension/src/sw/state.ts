// The service worker's small decisions, kept pure so they are tested without
// a browser: which spaces hold a socket under the cap, what the badge says,
// whether an origins answer may still be applied, and whether the "update
// onlay" refusal still applies.

/* ── which spaces get one of the capped sockets ── */

/**
 * The spaces that hold a socket: the `cap` most recently used (by the time
 * the person last picked or posted to them), ties in `/api/me` order.
 */
export function connectedSpaces(
  all: readonly string[],
  used: Readonly<Record<string, number>>,
  cap: number,
): string[] {
  return all
    .map((id, order) => ({ id, order, at: used[id] ?? 0 }))
    .sort((a, b) => b.at - a.at || a.order - b.order)
    .slice(0, cap)
    .map((x) => x.id);
}

/**
 * The person picked `id`. Already connected: it becomes the most recent.
 * Otherwise it takes the socket of the least recently used connected space
 * that has no open composer (`busy`); refused when every one has.
 */
export function useSpace(
  all: readonly string[],
  used: Readonly<Record<string, number>>,
  id: string,
  busy: ReadonlySet<string>,
  now: number,
  cap: number,
): { ok: boolean; used: Record<string, number> } {
  if (!all.includes(id)) return { ok: false, used: { ...used } };
  const connected = connectedSpaces(all, used, cap);
  if (connected.includes(id)) return { ok: true, used: { ...used, [id]: now } };
  const free = connected.filter((c) => !busy.has(c));
  if (free.length === 0) return { ok: false, used: { ...used } };
  // The least recently used free one: the last of them in connected order.
  const victim = free[free.length - 1] as string;
  const next: Record<string, number> = { ...used, [id]: now, [victim]: -1 };
  // The others keep their sockets ahead of spaces that never held one.
  for (const c of connected) if (c !== victim && (next[c] ?? 0) <= 0) next[c] = 1;
  return { ok: true, used: next };
}

/* ── the badge ── */

/**
 * The badge's absolute needs-you count: the sum of each connected space's
 * count from `welcome` and `attention` frames; when a space's count is
 * unknown (an attention frame without one), `/api/inbox`'s full count.
 * Never the length of a capped row list.
 */
export function badgeCount(
  needs: Readonly<Record<string, number | null>>,
  spaceIds: readonly string[],
  inboxCount: number | undefined,
): number {
  let total = 0;
  for (const id of spaceIds) {
    const n = needs[id];
    if (n === null) return inboxCount ?? total;
    total += n ?? 0;
  }
  return total;
}

/* ── origins: an older HTTP answer never reopens the gate ── */

export interface OriginsApply {
  next: Record<string, string[]>;
  /** Per space, origins this answer newly included (open tabs there re-sync). */
  added: Record<string, string[]>;
}

/**
 * Apply an `/api/origins` answer: per space, only when no `origins` frame for
 * that space arrived since the request started (`seqAtStart` vs `seqNow`).
 */
export function applyOriginsAnswer(
  current: Readonly<Record<string, string[]>>,
  answer: Readonly<Record<string, string[]>>,
  spaceIds: readonly string[],
  seqAtStart: Readonly<Record<string, number>>,
  seqNow: Readonly<Record<string, number>>,
): OriginsApply {
  const next: Record<string, string[]> = {};
  const added: Record<string, string[]> = {};
  for (const id of spaceIds) {
    const before = current[id] ?? [];
    if ((seqNow[id] ?? 0) !== (seqAtStart[id] ?? 0)) {
      next[id] = [...before]; // a newer frame owns this space
      continue;
    }
    const fresh = [...(answer[id] ?? [])];
    next[id] = fresh;
    const gained = fresh.filter((o) => !before.includes(o));
    if (gained.length > 0) added[id] = gained;
  }
  return { next, added };
}

/** An `origins` frame for one space: authoritative; returns what it newly included. */
export function applyOriginsFrame(
  current: Readonly<Record<string, string[]>>,
  spaceId: string,
  origins: readonly string[],
): OriginsApply {
  const before = current[spaceId] ?? [];
  const gained = origins.filter((o) => !before.includes(o));
  return {
    next: { ...current, [spaceId]: [...origins] },
    added: gained.length > 0 ? { [spaceId]: gained } : {},
  };
}

/* ── "update onlay": scoped to the server and the protocol that refused ── */

export interface UpgradeMark {
  origin: string;
  protocol: number;
}

/** The stored refusal still applies: same server origin, same client protocol. */
export function upgradeApplies(stored: unknown, origin: string, protocol: number): boolean {
  const m = stored as Partial<UpgradeMark> | null | undefined;
  return typeof m === "object" && m !== null && m.origin === origin && m.protocol === protocol;
}

/* ── frames are handled in order, and only for the account they arrived under ── */

/**
 * A serial queue whose items are stamped with the account generation when
 * they arrive: an item whose generation has moved on by the time it runs is
 * dropped, and the handler gets `current()` to re-check before each side
 * effect (a frame from the old account never writes storage or broadcasts).
 */
export function createGenerationQueue<T>(
  generation: () => number,
  handle: (item: T, current: () => boolean) => Promise<void>,
): (item: T) => void {
  let chain: Promise<void> = Promise.resolve();
  return (item) => {
    const stamped = generation();
    const current = (): boolean => generation() === stamped;
    const run = async (): Promise<void> => {
      if (!current()) return;
      await handle(item, current);
    };
    chain = chain.then(run, run);
  };
}
