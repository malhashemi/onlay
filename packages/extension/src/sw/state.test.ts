import { expect, test } from "bun:test";
import {
  applyOriginsAnswer,
  applyOriginsFrame,
  badgeCount,
  connectedSpaces,
  createGenerationQueue,
  upgradeApplies,
  useSpace,
} from "./state";

const ids = (n: number) => Array.from({ length: n }, (_, i) => `s_${i}`);

test("the capped sockets go to the most recently used spaces, ties in /api/me order", () => {
  expect(connectedSpaces(ids(4), {}, 2)).toEqual(["s_0", "s_1"]);
  expect(connectedSpaces(ids(4), { s_3: 5 }, 2)).toEqual(["s_3", "s_0"]);
});

test("picking a space past the cap connects it and drops the least recently used free one", () => {
  const all = ids(4);
  const used = { s_0: 30, s_1: 20 };
  const r = useSpace(all, used, "s_3", new Set(), 100, 2);
  expect(r.ok).toBe(true);
  expect(connectedSpaces(all, r.used, 2)).toEqual(["s_3", "s_0"]);
});

test("a space with an open composer keeps its socket; all busy refuses", () => {
  const all = ids(4);
  const used = { s_0: 30, s_1: 20 };
  const r = useSpace(all, used, "s_3", new Set(["s_1"]), 100, 2);
  expect(connectedSpaces(all, r.used, 2).sort()).toEqual(["s_1", "s_3"]);
  expect(useSpace(all, used, "s_3", new Set(["s_0", "s_1"]), 100, 2).ok).toBe(false);
  expect(useSpace(all, used, "s_nope", new Set(), 100, 2).ok).toBe(false);
});

test("the badge sums absolute counts and never a capped row list", () => {
  expect(badgeCount({ a: 3, b: 250 }, ["a", "b"], undefined)).toBe(253);
  // An attention frame without a count: the inbox's full count stands in.
  expect(badgeCount({ a: 3, b: null }, ["a", "b"], 260)).toBe(260);
  expect(badgeCount({ a: 3, gone: 9 }, ["a"], undefined)).toBe(3);
});

test("an older /api/origins answer never overwrites a newer origins frame", () => {
  // The socket removed acme after its last thread resolved (seq 1 → 2)…
  const afterFrame = applyOriginsFrame({ s_a: ["https://acme.test"] }, "s_a", []).next;
  // …then an HTTP answer started at seq 1 lands, still listing acme.
  const r = applyOriginsAnswer(
    afterFrame,
    { s_a: ["https://acme.test"], s_b: ["https://b.test"] },
    ["s_a", "s_b"],
    { s_a: 1 },
    { s_a: 2 },
  );
  expect(r.next.s_a).toEqual([]);
  expect(r.next.s_b).toEqual(["https://b.test"]);
  expect(r.added).toEqual({ s_b: ["https://b.test"] });
});

test("an origins frame reports what it newly includes", () => {
  expect(
    applyOriginsFrame({ s_a: ["https://x.test"] }, "s_a", ["https://x.test", "https://y.test"])
      .added,
  ).toEqual({ s_a: ["https://y.test"] });
});

test("the update refusal applies only to the origin and protocol that got it", () => {
  const mark = { origin: "https://app.onlay.dev", protocol: 2 };
  expect(upgradeApplies(mark, "https://app.onlay.dev", 2)).toBe(true);
  expect(upgradeApplies(mark, "https://app.onlay.dev", 3)).toBe(false); // updated since
  expect(upgradeApplies(mark, "http://localhost:8787", 2)).toBe(false);
  expect(upgradeApplies(true, "https://app.onlay.dev", 2)).toBe(false); // the old unscoped flag
});

test("a frame queued under one account never runs after the account changed", async () => {
  let gen = 1;
  const ran: string[] = [];
  let release: () => void = () => {};
  const gate = new Promise<void>((r) => {
    release = r;
  });
  const push = createGenerationQueue<string>(
    () => gen,
    async (item, current) => {
      if (item === "slow") await gate;
      if (current()) ran.push(item);
    },
  );
  push("first");
  push("slow"); // arrives under account 1, still running when the account changes
  push("queued"); // arrives under account 1, runs after the change
  await Promise.resolve();
  gen = 2; // signed out, someone else signs in
  push("new");
  release();
  await new Promise((r) => setTimeout(r, 0));
  expect(ran).toEqual(["first", "new"]);
});
