// The account generation survives a worker restart (3b-C4).
import { expect, test } from "bun:test";
import {
  createAccountGeneration,
  createSignOutMarker,
  type GenerationStore,
  type MarkerArea,
  SIGN_OUT_PENDING,
  storeThenAnnounce,
} from "./generation";

function memoryStore(): GenerationStore & { saved: { generation?: unknown; origin?: unknown } } {
  const saved: { generation?: unknown; origin?: unknown } = {};
  return {
    saved,
    load: async () => ({ ...saved }),
    save: async (g, o) => {
      saved.generation = g;
      saved.origin = o;
    },
  };
}

const ORIGIN = "https://app.onlay.dev";

test("a restarted worker comes back with the generation the page was given", async () => {
  const store = memoryStore();
  const before = createAccountGeneration(store);
  await before.restore(ORIGIN);
  await before.bump(ORIGIN); // signed in: the page learns 1
  expect(before.current()).toBe(1);
  // The worker restarts: a fresh instance over the same storage.
  const after = createAccountGeneration(store);
  await after.restore(ORIGIN);
  expect(after.current()).toBe(1);
});

test("a server origin that changed while the worker was down moves the generation on", async () => {
  const store = memoryStore();
  const g = createAccountGeneration(store);
  await g.restore(ORIGIN);
  await g.bump(ORIGIN);
  const restarted = createAccountGeneration(store);
  await restarted.restore("http://localhost:8787");
  expect(restarted.current()).toBe(2);
  await restarted.originIs("http://localhost:8787");
  expect(restarted.current()).toBe(2);
  await restarted.originIs(ORIGIN);
  expect(restarted.current()).toBe(3);
});

test("a bump is visible at once, before the store has written it", () => {
  const g = createAccountGeneration({
    load: async () => ({}),
    save: () => new Promise(() => {}),
  });
  void g.bump(ORIGIN);
  expect(g.current()).toBe(1);
});

/** A store that keeps exactly what each single write carried, and can refuse writes. */
function writeLog(): GenerationStore & { writes: Array<Record<string, unknown>>; fail: boolean } {
  const state: Record<string, unknown> = {};
  const log = {
    writes: [] as Array<Record<string, unknown>>,
    fail: false,
    load: async () => ({ generation: state.generation, origin: state.origin }),
    save: async (g: number, o: string, alongside?: Record<string, unknown>) => {
      if (log.fail) throw new Error("quota");
      const write = { ...alongside, generation: g, origin: o };
      log.writes.push(write);
      Object.assign(state, write);
    },
  };
  return log;
}

test("a sign-in stores its token and its generation in one write (C-4)", async () => {
  const store = writeLog();
  const g = createAccountGeneration(store);
  await g.restore(ORIGIN);
  store.writes.length = 0;
  await g.bump(ORIGIN, { token: "onl_new", tokenOrigin: ORIGIN });
  expect(store.writes).toEqual([
    { token: "onl_new", tokenOrigin: ORIGIN, generation: 1, origin: ORIGIN },
  ]);
});

test("a write that fails stores neither: the old token never meets the new number (C-4)", async () => {
  const store = writeLog();
  const g = createAccountGeneration(store);
  await g.restore(ORIGIN);
  await g.bump(ORIGIN, { token: "onl_old", tokenOrigin: ORIGIN });
  store.fail = true;
  // Signing out: the write is refused, so the stored token stays with ITS generation.
  await g.bump(ORIGIN, { token: null, tokenOrigin: null });
  expect(g.current()).toBe(2);
  const last = store.writes.at(-1);
  expect(last).toEqual({ token: "onl_old", tokenOrigin: ORIGIN, generation: 1, origin: ORIGIN });
});

test("a new server origin moves the generation on in the same write that drops the token (C-4)", async () => {
  const store = writeLog();
  const g = createAccountGeneration(store);
  await g.restore(ORIGIN);
  store.writes.length = 0;
  await g.originIs("http://localhost:8787", { token: null, tokenOrigin: null });
  expect(store.writes).toEqual([
    { token: null, tokenOrigin: null, generation: 1, origin: "http://localhost:8787" },
  ]);
  // A worker that restarted with the origin already moved does the same.
  const restarted = createAccountGeneration(store);
  store.writes.length = 0;
  await restarted.restore(ORIGIN, { token: null });
  expect(store.writes).toEqual([{ token: null, generation: 2, origin: ORIGIN }]);
});

test("a sign-in whose write fails changes nothing: no new number, nothing stored (2-C3)", async () => {
  const store = writeLog();
  const g = createAccountGeneration(store);
  await g.restore(ORIGIN);
  store.fail = true;
  await expect(g.commit(ORIGIN, { token: "onl_new", tokenOrigin: ORIGIN })).rejects.toThrow();
  expect(g.current()).toBe(0);
  expect(store.writes.some((w) => w.token === "onl_new")).toBe(false);
  // Once the write works, the sign-in moves the number on only after it is stored.
  store.fail = false;
  let stored = false;
  const pending = g.commit(ORIGIN, { token: "onl_new", tokenOrigin: ORIGIN }).then(() => {
    stored = true;
  });
  expect(g.current()).toBe(0);
  await pending;
  expect(stored).toBe(true);
  expect(g.current()).toBe(1);
  expect(store.writes.at(-1)).toEqual({
    token: "onl_new",
    tokenOrigin: ORIGIN,
    generation: 1,
    origin: ORIGIN,
  });
});

test("a sign-out takes effect in memory even when its write fails, and says it failed (2-C3)", async () => {
  const store = writeLog();
  const g = createAccountGeneration(store);
  await g.restore(ORIGIN);
  store.fail = true;
  expect(await g.bump(ORIGIN, { token: null })).toBe(false);
  expect(g.current()).toBe(1);
  store.fail = false;
  expect(await g.bump(ORIGIN, { token: null })).toBe(true);
});

test("once the credentials are stored, a failing announcement does not fail the sign-in (3-C4)", async () => {
  const done: string[] = [];
  await storeThenAnnounce(
    async () => {
      done.push("stored");
    },
    async () => {
      done.push("announced");
      throw new Error("/api/me unreachable");
    },
  );
  expect(done).toEqual(["stored", "announced"]);
  // A failed write still fails it, and nothing is announced.
  await expect(
    storeThenAnnounce(
      async () => {
        throw new Error("quota");
      },
      async () => {
        done.push("announced again");
      },
    ),
  ).rejects.toThrow("quota");
  expect(done).toEqual(["stored", "announced"]);
});

/** An area that keeps its items; `wipe` is what a browser restart does to session storage. */
function area(): MarkerArea & { items: Record<string, unknown>; fail: boolean; wipe(): void } {
  const a = {
    items: {} as Record<string, unknown>,
    fail: false,
    get: async (k: string) => ({ [k]: a.items[k] }),
    set: async (i: Record<string, unknown>) => {
      if (a.fail) throw new Error("quota");
      Object.assign(a.items, i);
    },
    wipe: () => {
      a.items = {};
    },
  };
  return a;
}

test("a sign-out still owed survives a browser restart, and clears once written (3-C5)", async () => {
  const local = area();
  const session = area();
  const marker = createSignOutMarker([local, session]);
  await marker.mark();
  session.wipe(); // the browser restarted: session storage is gone, local is not
  expect(await createSignOutMarker([local, session]).pending()).toBe(true);
  await marker.clear();
  expect(await marker.pending()).toBe(false);
  expect(local.items[SIGN_OUT_PENDING]).toBeNull();
});

test("the marker gets through when one area refuses the write, and never rejects (3-C5)", async () => {
  const local = area();
  const session = area();
  local.fail = true;
  const marker = createSignOutMarker([local, session]);
  await marker.mark();
  expect(await marker.pending()).toBe(true);
  session.fail = true;
  await marker.clear(); // both refuse: no throw
  expect(await marker.pending()).toBe(true);
});
