// Store unit tests against fake-indexeddb. Exercises the partition contract:
// per-person isolation, the read-cache round-trip, draft persist/rehydrate,
// the 401-keeps-drafts rule, sign-out wiping the person, and a new sign-in
// wiping every other person's reads and drafts.
// NOTE: `fake-indexeddb/auto` installs onto `window` when one exists, and
// other tests in this process leak a closed happy-dom `Window` onto
// `globalThis.window`; install explicitly onto the real `globalThis`.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { IDBKeyRange, indexedDB } from "fake-indexeddb";
import { Store } from "./store";

Object.assign(globalThis, { indexedDB, IDBKeyRange });

let store: Store;

function wipeDb(): Promise<void> {
  return new Promise<void>((resolve) => {
    const del = indexedDB.deleteDatabase("onlay-pwa");
    del.onsuccess = () => resolve();
    del.onerror = () => resolve();
    del.onblocked = () => resolve();
  });
}

beforeEach(async () => {
  await wipeDb();
  store = await Store.open();
});

afterEach(async () => {
  store.close();
  await wipeDb();
});

const P1 = "p_aaaaaaaaaaaaaaaaaaaa";
const P2 = "p_bbbbbbbbbbbbbbbbbbbb";

describe("online-only flag", () => {
  test("defaults false; set/read round-trips", () => {
    expect(store.isOnlineOnly()).toBe(false);
    store.setOnlineOnly(true);
    expect(store.isOnlineOnly()).toBe(true);
  });
});

describe("partitions", () => {
  test("reads and drafts are per person", async () => {
    await store.putRead(P1, "/api/inbox", { n: 1 }, 10);
    await store.putDraft(P1, "reply:x", "hello");
    expect((await store.getRead(P1, "/api/inbox"))?.value).toEqual({ n: 1 });
    expect(await store.getRead(P2, "/api/inbox")).toBeNull();
    expect(await store.getDraft(P1, "reply:x")).toBe("hello");
    expect(await store.getDraft(P2, "reply:x")).toBeNull();
  });

  test("adopt remembers the person and wipes everyone else", async () => {
    await store.putRead(P1, "/a", 1, 1);
    await store.putDraft(P1, "d", "mine");
    await store.putRead(P2, "/a", 2, 1);
    await store.putDraft(P2, "d", "theirs");
    await store.adopt(P1);
    expect(await store.lastPerson()).toBe(P1);
    expect(await store.getRead(P1, "/a")).not.toBeNull();
    expect(await store.getDraft(P1, "d")).toBe("mine");
    expect(await store.getRead(P2, "/a")).toBeNull();
    expect(await store.getDraft(P2, "d")).toBeNull();
  });

  test("a 401 drops the person's reads but keeps their drafts", async () => {
    await store.putRead(P1, "/a", 1, 1);
    await store.putDraft(P1, "d", "unsent");
    await store.onSignInRequired(P1);
    expect(await store.getRead(P1, "/a")).toBeNull();
    expect(await store.getDraft(P1, "d")).toBe("unsent");
  });

  test("signing out drops everything of the person's", async () => {
    await store.adopt(P1);
    await store.putRead(P1, "/a", 1, 1);
    await store.putDraft(P1, "d", "unsent");
    await store.putVapidKey("key");
    await store.signOut(P1);
    expect(await store.getRead(P1, "/a")).toBeNull();
    expect(await store.getDraft(P1, "d")).toBeNull();
    expect(await store.lastPerson()).toBeNull();
  });

  test("deleteDraft removes one draft", async () => {
    await store.putDraft(P1, "a", "1");
    await store.putDraft(P1, "b", "2");
    await store.deleteDraft(P1, "a");
    expect(await store.getDraft(P1, "a")).toBeNull();
    expect(await store.getDraft(P1, "b")).toBe("2");
  });
});
