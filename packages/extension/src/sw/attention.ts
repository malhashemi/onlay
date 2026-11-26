// The Inbox the service worker last read (`/api/inbox`), kept in session
// storage for the popup, the command bar's fallback and every thread header
// and pin (`getAttention`). It is kept with the account it was read for
// (`attentionFor`: the account generation at the start of the read and that
// person's id), in the same write as the lists. A read that finishes after
// the account moved on (a sign-out, another person, another server) is not
// kept, and a kept copy is answered only while its generation is the current
// one, under the person it names: nothing of one account is ever served to
// another, whatever happens between two reads.

interface RowLike {
  interactionId: string;
}

/** Whose Inbox the kept lists are. */
export interface InboxOwner {
  /** The account generation the read began under. */
  generation: number;
  personId: string;
}

/** The session-storage keys: the lists (as the popup reads them) and their owner. */
export const INBOX_KEY = "attention";
export const INBOX_OWNER_KEY = "attentionFor";

/** The owner to write beside a read that began under `read`, or null when the account has moved on since. */
export function inboxOwner(
  read: { generation: number; personId: string | null },
  currentGeneration: number,
): InboxOwner | null {
  if (read.personId === null || read.generation !== currentGeneration) return null;
  return { generation: read.generation, personId: read.personId };
}

/** The kept lists, if they are still the current account's. */
export function keptLists<Lists>(
  stored: Record<string, unknown>,
  currentGeneration: number,
): { lists: Lists; personId: string } | null {
  const owner = stored[INBOX_OWNER_KEY] as Partial<InboxOwner> | null | undefined;
  const lists = stored[INBOX_KEY] as Lists | null | undefined;
  if (!owner || typeof owner !== "object" || lists == null) return null;
  if (owner.generation !== currentGeneration || typeof owner.personId !== "string") return null;
  return { lists, personId: owner.personId };
}

/**
 * The `getAttention` answer: which threads need the person and which wait,
 * ids alone (every frame of every tab may ask), under the person the Inbox
 * was read for. Nothing when the kept copy is another account's.
 */
export function attentionAnswer(
  stored: Record<string, unknown>,
  currentGeneration: number,
): {
  personId: string | null;
  attention: { needsYou: RowLike[]; waiting: RowLike[] } | null;
} {
  const kept = keptLists<{ needsYou?: RowLike[]; waiting?: RowLike[] }>(stored, currentGeneration);
  if (!kept) return { personId: null, attention: null };
  const ids = (rows: RowLike[] | undefined) =>
    (rows ?? []).map((r) => ({ interactionId: r.interactionId }));
  return {
    personId: kept.personId,
    attention: { needsYou: ids(kept.lists.needsYou), waiting: ids(kept.lists.waiting) },
  };
}
