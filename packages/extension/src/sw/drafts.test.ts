// D-1: the service worker's draft store. Drafts live in session storage under
// one account on one server, partitioned by the origin the browser reports
// for the sender, bounded, and wiped when the account changes.
import { describe, expect, test } from "bun:test";
import { createDraftStore, DRAFT_LIMITS, DRAFTS_KEY, senderOrigin } from "./drafts";

function harness(initialScope: string | null = "alice|https://app.onlay.dev") {
  const area: Record<string, unknown> = {};
  let scope = initialScope;
  let clock = 1_000_000;
  const store = createDraftStore({
    get: async (k) => (k in area ? { [k]: structuredClone(area[k]) } : {}),
    set: async (items) => {
      for (const [k, v] of Object.entries(items)) area[k] = structuredClone(v);
    },
    remove: async (k) => {
      delete area[k];
    },
    scope: async () => scope,
    now: () => clock,
  });
  const A = { origin: "https://a.example", url: "https://a.example/page" };
  const B = { origin: "https://b.example", url: "https://b.example/" };
  const save = (changes: unknown[], sender = A, s: string | null = scope) =>
    store.handle({ op: "save", scope: s, changes }, sender) as Promise<{ ok: boolean }>;
  const load = (sender = A) =>
    store.handle({ op: "load" }, sender) as Promise<{
      ok: boolean;
      scope?: string;
      drafts?: Array<{ key: string; value: unknown }>;
      sends?: Array<{ key: string; sends: unknown }>;
    }>;
  return {
    area,
    store,
    A,
    B,
    save,
    load,
    setScope: (s: string | null) => {
      scope = s;
    },
    advance: (ms: number) => {
      clock += ms;
    },
    now: () => clock,
  };
}

describe("D-1: drafts kept in the service worker", () => {
  test("a saved draft comes back to the same origin, pills and all", async () => {
    const h = harness();
    const rich = {
      text: "hi @Bob",
      tokens: [{ t: "actor", actorId: "b", spans: [{ start: 3, length: 4 }] }],
    };
    expect((await h.save([{ key: "reply:c1", value: rich }])).ok).toBe(true);
    const got = await h.load();
    expect(got).toEqual({
      ok: true,
      scope: "alice|https://app.onlay.dev",
      drafts: [{ key: "reply:c1", value: rich }],
      sends: [],
    });
  });

  test("a frame of another site never sees them", async () => {
    const h = harness();
    await h.save([{ key: "reply:c1", value: "typed on a" }]);
    expect((await h.load(h.B)).drafts).toEqual([]);
    // The origin is the browser's: a URL claimed in the message changes nothing.
    await h.store.handle(
      {
        op: "save",
        scope: "alice|https://app.onlay.dev",
        changes: [],
        origin: "https://a.example",
      },
      h.B,
    );
    expect((await h.load(h.B)).drafts).toEqual([]);
  });

  test("an opaque origin keeps nothing", async () => {
    const h = harness();
    expect(senderOrigin({ origin: "null", url: "https://a.example/" })).toBeNull();
    expect((await h.save([{ key: "k", value: "x" }], { origin: "null", url: "" })).ok).toBe(false);
    expect(h.area[DRAFTS_KEY]).toBeUndefined();
  });

  test("a save under another account, or signed out, is refused", async () => {
    const h = harness();
    expect((await h.save([{ key: "k", value: "x" }], h.A, "bob|https://app.onlay.dev")).ok).toBe(
      false,
    );
    h.setScope(null);
    expect((await h.save([{ key: "k", value: "x" }], h.A, null)).ok).toBe(false);
    expect((await h.load()).ok).toBe(false);
    expect(h.area[DRAFTS_KEY]).toBeUndefined();
  });

  test("another account (or server) signed in wipes what the last one kept", async () => {
    const h = harness();
    await h.save([{ key: "reply:c1", value: "alice's" }]);
    h.setScope("bob|https://app.onlay.dev");
    await h.store.check();
    expect(h.area[DRAFTS_KEY]).toBeUndefined();
    h.setScope("alice|https://app.onlay.dev");
    expect((await h.load()).drafts).toEqual([]);
  });

  test("a sent or cancelled draft (null) is removed", async () => {
    const h = harness();
    await h.save([
      { key: "a", value: "one" },
      { key: "b", value: "two" },
    ]);
    await h.save([{ key: "a", value: null }]);
    expect((await h.load()).drafts?.map((d) => d.key)).toEqual(["b"]);
    await h.save([{ key: "b", value: null }]);
    expect(h.area[DRAFTS_KEY]).toBeUndefined();
  });

  test("the newest 200 are kept; the oldest go first", async () => {
    const h = harness();
    const changes = Array.from({ length: DRAFT_LIMITS.count + 5 }, (_, i) => ({
      key: `k${i}`,
      value: `v${i}`,
    }));
    await h.save(changes);
    const keys = (await h.load()).drafts?.map((d) => d.key) ?? [];
    expect(keys.length).toBe(DRAFT_LIMITS.count);
    expect(keys[0]).toBe("k5");
    expect(keys[keys.length - 1]).toBe(`k${DRAFT_LIMITS.count + 4}`);
    // Writing an old one again makes it the newest.
    await h.save([{ key: "k5", value: "again" }]);
    await h.save([{ key: "fresh", value: "x" }]);
    const after = (await h.load()).drafts?.map((d) => d.key) ?? [];
    expect(after).toContain("k5");
    expect(after).not.toContain("k6");
  });

  test("a draft over 64 KiB is not kept, and its older version goes with it", async () => {
    const h = harness();
    await h.save([{ key: "big", value: "short" }]);
    await h.save([{ key: "big", value: "x".repeat(DRAFT_LIMITS.entryBytes) }]);
    expect((await h.load()).drafts).toEqual([]);
  });

  test("the whole store stays within its byte budget", async () => {
    const h = harness();
    const each = "y".repeat(DRAFT_LIMITS.entryBytes - 100);
    const n = Math.ceil(DRAFT_LIMITS.totalBytes / DRAFT_LIMITS.entryBytes) + 3;
    await h.save(Array.from({ length: n }, (_, i) => ({ key: `p${i}`, value: each })));
    const drafts = (await h.load()).drafts ?? [];
    expect(drafts.length).toBeLessThan(n);
    expect(JSON.stringify(h.area[DRAFTS_KEY]).length).toBeLessThan(
      DRAFT_LIMITS.totalBytes + 64_000,
    );
    expect(drafts[drafts.length - 1]?.key).toBe(`p${n - 1}`);
  });

  test("malformed changes are skipped", async () => {
    const h = harness();
    await h.save([
      { key: "", value: "x" },
      { key: 7, value: "x" },
      { key: "bad", value: { text: 3 } },
      { key: "bad2", value: { text: "x", tokens: "no" } },
      { key: "good", value: { text: "ok" } },
    ]);
    expect((await h.load()).drafts).toEqual([{ key: "good", value: { text: "ok" } }]);
  });
});

describe("2-D1: an unconfirmed send's id is kept with its draft", () => {
  const attempt = (h: ReturnType<typeof harness>, clientId = "id-1") => ({
    clientId,
    sig: JSON.stringify({ body: { text: "hello" } }),
    at: h.now(),
  });

  test("it comes back with the draft, to the same origin only", async () => {
    const h = harness();
    const a = attempt(h);
    await h.save([
      { key: "reply:c1", value: { text: "hello" } },
      { key: "reply:c1", add: a },
    ]);
    const got = await h.load();
    expect(got.drafts).toEqual([{ key: "reply:c1", value: { text: "hello" } }]);
    expect(got.sends).toEqual([{ key: "reply:c1", sends: [a] }]);
    expect((await h.load(h.B)).sends).toEqual([]);
  });

  test("a confirmed send (none left) is removed; the draft stays", async () => {
    const h = harness();
    await h.save([
      { key: "reply:c1", value: "hello" },
      { key: "reply:c1", add: attempt(h) },
    ]);
    await h.save([{ key: "reply:c1", remove: "id-1" }]);
    const got = await h.load();
    expect(got.sends).toEqual([]);
    expect(got.drafts).toEqual([{ key: "reply:c1", value: "hello" }]);
  });

  test("it lives 10 minutes, as in memory", async () => {
    const h = harness();
    await h.save([{ key: "create:T", add: attempt(h) }]);
    h.advance(9 * 60_000);
    expect((await h.load()).sends?.length).toBe(1);
    h.advance(60_000);
    expect((await h.load()).sends).toEqual([]);
  });

  test("it goes with the account", async () => {
    const h = harness();
    await h.save([{ key: "reply:c1", add: attempt(h) }]);
    h.setScope("bob|https://app.onlay.dev");
    await h.store.check();
    h.setScope("alice|https://app.onlay.dev");
    expect((await h.load()).sends).toEqual([]);
  });

  test("malformed attempts are skipped", async () => {
    const h = harness();
    await h.save([
      { key: "p", add: { clientId: "", sig: "x", at: h.now() } },
      { key: "p", add: { clientId: "x".repeat(200), sig: "x", at: h.now() } },
      { key: "p", add: { clientId: "ok", sig: 3, at: h.now() } },
      { key: "p", add: { clientId: "ok", sig: "x", at: h.now() + 3_600_000 } },
      { key: "p", add: { clientId: "good", sig: "x", at: h.now() } },
      { key: "p", remove: 7 },
      // The old whole-list shape replaces nothing any more.
      { key: "p", sends: null },
    ]);
    expect((await h.load()).sends).toEqual([
      { key: "p", sends: [{ clientId: "good", sig: "x", at: h.now() }] },
    ]);
  });
});

describe("3-D1: two tabs sending from one place keep each other's ids", () => {
  const attempt = (h: ReturnType<typeof harness>, clientId: string, text: string) => ({
    clientId,
    sig: JSON.stringify({ body: { text } }),
    at: h.now(),
  });

  test("one tab's send never replaces another's, and one's confirmation removes only its id", async () => {
    const h = harness();
    // Two tabs on the same page, each with its own unconfirmed reply in thread c1.
    await h.save([{ key: "reply:c1", add: attempt(h, "tab-a", "from a") }]);
    await h.save([{ key: "reply:c1", add: attempt(h, "tab-b", "from b") }]);
    expect((await h.load()).sends).toEqual([
      {
        key: "reply:c1",
        sends: [attempt(h, "tab-a", "from a"), attempt(h, "tab-b", "from b")],
      },
    ]);
    // Tab B's receipt arrives: only its id goes; tab A's stays for its retry.
    await h.save([{ key: "reply:c1", remove: "tab-b" }]);
    expect((await h.load()).sends).toEqual([
      { key: "reply:c1", sends: [attempt(h, "tab-a", "from a")] },
    ]);
  });
});
