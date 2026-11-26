// Each space's durable session (sessionId + connect count) lives under its own
// chrome.storage.local key, `session:<spaceId>`. Two spaces opening at once
// each write only their own key, so neither can erase the other's session (a
// shared map written back by both would keep only the last writer's entry).
// The old shared `sessions` map is read once to carry a session id over, then
// removed.

const PREFIX = "session:";
const LEGACY_KEY = "sessions";

export interface SessionRecord {
  sessionId: string;
  connects: number;
}

/** The slice of chrome.storage.local this needs. */
export interface KeyValue {
  get(keys: string[] | null): Promise<Record<string, unknown>>;
  set(items: Record<string, unknown>): Promise<void>;
  remove(keys: string[]): Promise<void>;
}

export function sessionKey(spaceId: string): string {
  return `${PREFIX}${spaceId}`;
}

function asRecord(v: unknown): SessionRecord | null {
  const r = v as Partial<SessionRecord> | null | undefined;
  return r && typeof r.sessionId === "string" && typeof r.connects === "number"
    ? { sessionId: r.sessionId, connects: r.connects }
    : null;
}

/** Bump this space's session (minting one on first connect) and store it. */
export async function nextSession(
  kv: KeyValue,
  spaceId: string,
  mint: () => string,
): Promise<SessionRecord> {
  const key = sessionKey(spaceId);
  const got = await kv.get([key, LEGACY_KEY]);
  const legacy = got[LEGACY_KEY] as Record<string, unknown> | undefined;
  const prior = asRecord(got[key]) ?? asRecord(legacy?.[spaceId]);
  const next = { sessionId: prior?.sessionId ?? mint(), connects: (prior?.connects ?? 0) + 1 };
  await kv.set({ [key]: next });
  return next;
}

/** Forget the sessions of spaces not in `keep` (and the legacy map). */
export async function pruneSessions(kv: KeyValue, keep: ReadonlySet<string>): Promise<void> {
  const all = await kv.get(null);
  const gone = Object.keys(all).filter(
    (k) => k === LEGACY_KEY || (k.startsWith(PREFIX) && !keep.has(k.slice(PREFIX.length))),
  );
  if (gone.length > 0) await kv.remove(gone);
}
