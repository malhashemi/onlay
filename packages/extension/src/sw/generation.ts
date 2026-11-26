// The account generation (3b-C4): it moves on every sign-in, sign-out and
// server-origin change, pages carry it on every upload, and the service worker
// refuses an upload composed under another one. It is kept with the
// credentials, so a worker that restarts comes back with the same number and an
// upload a page prepared before the restart is not refused after it.
//
// A move that comes with a change of credentials (sign-in, sign-out, a server
// origin that discards the token) is stored in ONE write with them (C-4): a
// restart can never find the new token beside the old number, or the reverse.

/** Credential keys written in the same storage write as the generation. */
export type Alongside = Record<string, unknown>;

export interface GenerationStore {
  load(): Promise<{ generation?: unknown; origin?: unknown }>;
  /** Store the generation and `alongside` in one write. */
  save(generation: number, origin: string, alongside?: Alongside): Promise<void>;
}

export interface AccountGeneration {
  current(): number;
  /**
   * At start: take the stored number back; a different origin since then
   * moves it on, stored together with `alongside`.
   */
  restore(origin: string, alongside?: Alongside): Promise<void>;
  /** The origin is now `origin`: a change moves the generation on, stored with `alongside`. */
  originIs(origin: string, alongside?: Alongside): Promise<void>;
  /**
   * Move on (sign-out): in memory at once, then stored in one write with
   * `alongside` (the credentials that change with it). Never rejects:
   * resolves false when the write failed, so the caller can retry it later.
   */
  bump(origin: string, alongside?: Alongside): Promise<boolean>;
  /**
   * Move on only once stored (sign-in, 2-C3): the generation and `alongside`
   * are written in one write first, and only then does the number change in
   * memory. A failed write rejects and changes nothing.
   */
  commit(origin: string, alongside: Alongside): Promise<void>;
}

export function createAccountGeneration(store: GenerationStore): AccountGeneration {
  let value = 0;
  let at: string | null = null;
  const bump = (origin: string, alongside?: Alongside): Promise<boolean> => {
    value += 1;
    at = origin;
    return store.save(value, origin, alongside).then(
      () => true,
      () => false,
    );
  };
  return {
    current: () => value,
    async restore(origin, alongside) {
      try {
        const s = await store.load();
        if (typeof s.generation === "number" && Number.isInteger(s.generation) && s.generation >= 0)
          value = Math.max(value, s.generation);
        at = typeof s.origin === "string" ? s.origin : null;
      } catch {
        /* no stored generation: start from what is in memory */
      }
      if (at === null) {
        at = origin;
        await store.save(value, origin).catch(() => {});
      } else if (at !== origin) {
        await bump(origin, alongside);
      }
    },
    async originIs(origin, alongside) {
      if (at !== origin) await bump(origin, alongside);
    },
    bump,
    async commit(origin, alongside) {
      const next = value + 1;
      await store.save(next, origin, alongside);
      value = Math.max(value, next);
      at = origin;
    },
  };
}

/**
 * Sign-in (3-C4): store the credentials, then announce. The sign-in counts
 * once `store` resolved; whatever `announce` does after (tell the tabs,
 * refresh the profile) cannot fail it, and the normal status path retries.
 */
export async function storeThenAnnounce(
  store: () => Promise<void>,
  announce: () => Promise<void>,
): Promise<void> {
  await store();
  try {
    await announce();
  } catch {
    /* signed in all the same: the next status refresh catches up */
  }
}

/** The key of the marker that says a sign-out's storage write is still owed. */
export const SIGN_OUT_PENDING = "signOutPending";

/** A storage area the marker is kept in (chrome.storage.local, chrome.storage.session). */
export interface MarkerArea {
  get(key: string): Promise<Record<string, unknown>>;
  set(items: Record<string, unknown>): Promise<void>;
}

export interface SignOutMarker {
  /** A sign-out's write is still owed (any area says so). */
  pending(): Promise<boolean>;
  /** The write failed: say so in every area (each on its own; one may fail). */
  mark(): Promise<void>;
  /** The write landed, or a new sign-in was stored. */
  clear(): Promise<void>;
}

/**
 * The "sign-out pending" marker (2-C3, 3-C5): kept in local storage, which
 * survives a browser restart, and in session storage too, so a marker gets
 * through when one area refuses the write. Never rejects.
 */
export function createSignOutMarker(areas: MarkerArea[]): SignOutMarker {
  const setAll = async (value: true | null): Promise<void> => {
    for (const a of areas) await a.set({ [SIGN_OUT_PENDING]: value }).catch(() => {});
  };
  return {
    async pending() {
      for (const a of areas) {
        try {
          if ((await a.get(SIGN_OUT_PENDING))[SIGN_OUT_PENDING] === true) return true;
        } catch {
          /* unreadable: the other area may still tell */
        }
      }
      return false;
    },
    mark: () => setAll(true),
    clear: () => setAll(null),
  };
}
