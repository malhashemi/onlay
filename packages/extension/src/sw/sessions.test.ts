import { expect, test } from "bun:test";
import { type KeyValue, nextSession, pruneSessions, sessionKey } from "./sessions";

/** A storage whose reads and writes interleave like chrome.storage under two sockets. */
function slowStore(initial: Record<string, unknown> = {}) {
  const data: Record<string, unknown> = { ...initial };
  const later = () => new Promise((r) => setTimeout(r, 0));
  const kv: KeyValue = {
    get: async (keys) => {
      await later();
      if (keys === null) return { ...data };
      return Object.fromEntries(keys.filter((k) => k in data).map((k) => [k, data[k]]));
    },
    set: async (items) => {
      await later();
      Object.assign(data, items);
    },
    remove: async (keys) => {
      for (const k of keys) delete data[k];
    },
  };
  return { kv, data };
}

test("two spaces opening at once both keep their sessions", async () => {
  const { kv, data } = slowStore();
  let n = 0;
  const mint = () => `sess-${++n}`;
  await Promise.all([nextSession(kv, "s_a", mint), nextSession(kv, "s_b", mint)]);
  expect(data[sessionKey("s_a")]).toBeDefined();
  expect(data[sessionKey("s_b")]).toBeDefined();
  const again = await nextSession(kv, "s_a", mint);
  expect(again.connects).toBe(2);
  expect(again.sessionId).toBe((data[sessionKey("s_a")] as { sessionId: string }).sessionId);
});

test("a session from the old shared map carries over; pruning drops gone spaces and the map", async () => {
  const { kv, data } = slowStore({ sessions: { s_a: { sessionId: "kept", connects: 4 } } });
  const s = await nextSession(kv, "s_a", () => "new");
  expect(s).toEqual({ sessionId: "kept", connects: 5 });
  await nextSession(kv, "s_b", () => "b");
  await pruneSessions(kv, new Set(["s_a"]));
  expect(Object.keys(data).sort()).toEqual([sessionKey("s_a")]);
});
