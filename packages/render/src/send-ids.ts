// Request ids for message sends (M-1), shared by the extension and the web
// app. Every send carries a `clientId` (a create its `nonce`); a retry of a
// send that was never confirmed reuses it, so a send whose answer was lost
// after it landed is answered with the first instead of posting twice. A
// retry is an unconfirmed send from the same place with the very same
// payload. Each unconfirmed attempt keeps its own id until it is confirmed or
// is 10 minutes old (2-M3): sending something else from the same place in
// between never takes the first one's id away.
import { LIMITS } from "@onlay/protocol";

/** How long an unconfirmed attempt's id is kept for its retry. */
export const UNCONFIRMED_TTL_MS = 10 * 60_000;
/**
 * A safety bound only: attempts leave when confirmed or 10 minutes old, and
 * this many per place is far past anything a person sends in that time (3-M4).
 */
const MAX_PER_PLACE = 500;

export interface SendIds {
  /**
   * The request id for a send from `place` (a composer and what it writes
   * to) carrying `payload`: an unconfirmed attempt's id when this is its
   * retry, otherwise a new one, remembered until `confirmSend` or the TTL.
   */
  clientIdFor(place: string, payload: unknown): string;
  /** The send from `place` with this id was confirmed: a later send is a new one. */
  confirmSend(place: string, clientId: string): void;
}

/** One unconfirmed attempt: its id, the payload it carried (as JSON), when it was first sent. */
export interface SendAttempt {
  clientId: string;
  sig: string;
  at: number;
}

/**
 * Where the unconfirmed attempts are kept, per place. In memory by default;
 * the extension keeps them with the drafts, so a retry after a page reload
 * still reuses the id (2-D1). `set` with an empty list forgets the place.
 */
export interface SendAttemptStore {
  get(place: string): SendAttempt[] | undefined;
  set(place: string, attempts: SendAttempt[]): void;
}

function memoryStore(): SendAttemptStore {
  const m = new Map<string, SendAttempt[]>();
  return {
    get: (place) => m.get(place),
    set: (place, attempts) => {
      if (attempts.length > 0) m.set(place, attempts);
      else m.delete(place);
    },
  };
}

/** One client's request ids; `newId` makes a fresh opaque id. */
export function createSendIds(
  newId: () => string,
  now: () => number = Date.now,
  unconfirmed: SendAttemptStore = memoryStore(),
): SendIds {
  const live = (place: string): SendAttempt[] => {
    const t = now();
    const before = unconfirmed.get(place) ?? [];
    const list = before.filter((a) => t - a.at < UNCONFIRMED_TTL_MS);
    if (list.length !== before.length) unconfirmed.set(place, list);
    return list;
  };
  return {
    clientIdFor(place, payload) {
      const sig = JSON.stringify(payload);
      const list = live(place);
      const prior = list.find((a) => a.sig === sig);
      if (prior) return prior.clientId;
      const clientId = newId().slice(0, LIMITS.MAX_VARIANT_SET_ID);
      unconfirmed.set(place, [...list, { clientId, sig, at: now() }].slice(-MAX_PER_PLACE));
      return clientId;
    },
    confirmSend(place, clientId) {
      const before = live(place);
      const list = before.filter((a) => a.clientId !== clientId);
      if (list.length !== before.length) unconfirmed.set(place, list);
    },
  };
}
