// The web app's offline substrate: IndexedDB partitioned per signed-in person.
// Three object stores —
//   `meta`   — the last signed-in person's id (so an offline cold boot can find
//              its partition) and the push key the service worker re-subscribes
//              with. Public values only: the session lives in an HttpOnly
//              cookie this code never sees.
//   `reads`  — a read cache of server truth, keyed `<personId>:<URL>` with a
//              `syncedAt` stamp (non-authoritative, never a local source of
//              truth);
//   `drafts` — unsent words, keyed `<personId>:<route>:<interactionId>`.
//
// The partition contract: a sign-in as person P wipes every OTHER person's
// reads and drafts (a shared device must not hand one person's data or unsent
// words to the next); a 401 drops P's reads but keeps P's drafts (they come
// back after signing in again); signing out drops everything of P's. No
// mutation queue lives here — drafts are never auto-sent.

const DB_NAME = "onlay-pwa";
// v1 held paired-client auth records keyed by client id; v2 drops that store
// and every v1 partition (their keys name clients, not people).
const DB_VERSION = 2;
const PERSON_KEY = "person";
// The service worker's `pushsubscriptionchange` handler has no window, so it
// opens this db directly (sw.ts mirrors these literals) to find the key.
const VAPID_KEY = "vapidKey";

export interface CachedRead {
  value: unknown;
  syncedAt: number;
}

/** IndexedDB may be absent (private mode / hostile embedding) — the app then
 *  runs fully online with no read cache or draft persistence, never crashing. */
function idbAvailable(): boolean {
  try {
    return typeof indexedDB !== "undefined" && indexedDB !== null;
  } catch {
    return false;
  }
}

function reqAsync<T>(req: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function txDone(tx: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error);
  });
}

/** Every key under a person's partition sorts inside [`<id>:`, `<id>:￿`]. */
function prefixRange(personId: string): IDBKeyRange {
  return IDBKeyRange.bound(`${personId}:`, `${personId}:￿`);
}

function partitionOf(key: IDBValidKey): string {
  const s = String(key);
  const at = s.indexOf(":");
  return at < 0 ? s : s.slice(0, at);
}

export class Store {
  private db: IDBDatabase | null = null;
  private onlineOnly = false;

  private constructor(db: IDBDatabase | null) {
    this.db = db;
  }

  static async open(): Promise<Store> {
    if (!idbAvailable()) return new Store(null);
    try {
      const db = await new Promise<IDBDatabase>((resolve, reject) => {
        const open = indexedDB.open(DB_NAME, DB_VERSION);
        open.onupgradeneeded = (e) => {
          const d = open.result;
          if (d.objectStoreNames.contains("auth")) d.deleteObjectStore("auth");
          if (e.oldVersion > 0 && e.oldVersion < 2) {
            // v1 partitions were per paired client — nothing in them is a person's.
            for (const name of ["reads", "drafts"]) {
              if (d.objectStoreNames.contains(name)) d.deleteObjectStore(name);
            }
          }
          for (const name of ["meta", "reads", "drafts"]) {
            if (!d.objectStoreNames.contains(name)) d.createObjectStore(name);
          }
        };
        open.onsuccess = () => resolve(open.result);
        open.onerror = () => reject(open.error);
      });
      return new Store(db);
    } catch {
      return new Store(null);
    }
  }

  /** No secure context → no SW cold boot; the caller flags online-only so the
   *  UI can state it honestly. Read cache + drafts still work in-session. */
  setOnlineOnly(v: boolean): void {
    this.onlineOnly = v;
  }
  isOnlineOnly(): boolean {
    return this.onlineOnly;
  }

  /** Release the underlying connection (tests). */
  close(): void {
    this.db?.close();
    this.db = null;
  }

  /* ── the signed-in person ──────────────────────────────────────────── */

  /** The person the last sign-in belonged to, for an offline cold boot. */
  async lastPerson(): Promise<string | null> {
    if (!this.db) return null;
    const tx = this.db.transaction("meta", "readonly");
    const v = (await reqAsync(tx.objectStore("meta").get(PERSON_KEY))) as string | undefined;
    return v ?? null;
  }

  /** `/api/me` named this person: remember them and wipe every other
   *  person's partition, reads and drafts both. */
  async adopt(personId: string): Promise<void> {
    if (!this.db) return;
    const tx = this.db.transaction(["meta", "reads", "drafts"], "readwrite");
    tx.objectStore("meta").put(personId, PERSON_KEY);
    for (const name of ["reads", "drafts"] as const) {
      const s = tx.objectStore(name);
      const keys = (await reqAsync(s.getAllKeys())) as IDBValidKey[];
      for (const key of keys) if (partitionOf(key) !== personId) s.delete(key);
    }
    await txDone(tx);
  }

  /** A 401: the session ended. Drop this person's reads, keep their drafts. */
  async onSignInRequired(personId: string): Promise<void> {
    if (!this.db) return;
    const tx = this.db.transaction("reads", "readwrite");
    tx.objectStore("reads").delete(prefixRange(personId));
    await txDone(tx);
  }

  /** Signing out: everything of this person's goes, and the push key too. */
  async signOut(personId: string): Promise<void> {
    if (!this.db) return;
    const tx = this.db.transaction(["meta", "reads", "drafts"], "readwrite");
    const meta = tx.objectStore("meta");
    meta.delete(PERSON_KEY);
    meta.delete(VAPID_KEY);
    tx.objectStore("reads").delete(prefixRange(personId));
    tx.objectStore("drafts").delete(prefixRange(personId));
    await txDone(tx);
  }

  /** Persist the push key for the SW's window-less re-subscribe (public). */
  async putVapidKey(key: string): Promise<void> {
    if (!this.db) return;
    const tx = this.db.transaction("meta", "readwrite");
    tx.objectStore("meta").put(key, VAPID_KEY);
    await txDone(tx);
  }

  /* ── read cache ────────────────────────────────────────────────────── */

  async putRead(personId: string, urlKey: string, value: unknown, syncedAt: number): Promise<void> {
    if (!this.db) return;
    const tx = this.db.transaction("reads", "readwrite");
    tx.objectStore("reads").put({ value, syncedAt } satisfies CachedRead, `${personId}:${urlKey}`);
    await txDone(tx);
  }

  async getRead(personId: string, urlKey: string): Promise<CachedRead | null> {
    if (!this.db) return null;
    const tx = this.db.transaction("reads", "readonly");
    const rec = (await reqAsync(tx.objectStore("reads").get(`${personId}:${urlKey}`))) as
      | CachedRead
      | undefined;
    return rec ?? null;
  }

  /* ── drafts ────────────────────────────────────────────────────────── */

  async putDraft(personId: string, key: string, value: string): Promise<void> {
    if (!this.db) return;
    const tx = this.db.transaction("drafts", "readwrite");
    tx.objectStore("drafts").put(value, `${personId}:${key}`);
    await txDone(tx);
  }

  async getDraft(personId: string, key: string): Promise<string | null> {
    if (!this.db) return null;
    const tx = this.db.transaction("drafts", "readonly");
    const v = (await reqAsync(tx.objectStore("drafts").get(`${personId}:${key}`))) as
      | string
      | undefined;
    return v ?? null;
  }

  async deleteDraft(personId: string, key: string): Promise<void> {
    if (!this.db) return;
    const tx = this.db.transaction("drafts", "readwrite");
    tx.objectStore("drafts").delete(`${personId}:${key}`);
    await txDone(tx);
  }
}
