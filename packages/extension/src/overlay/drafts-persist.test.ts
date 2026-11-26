// D-1: the overlay's draft store writes through to the service worker and is
// restored from it when a page loads. Typing is saved shortly after; a sent or
// cancelled draft is removed at once; what is typed before the account is
// known is saved under it once it is; an account change saves nothing more of
// the old one and ignores a late restore of it.
import { afterEach, describe, expect, test } from "bun:test";
import { createSendIds } from "@onlay/render/send-ids";
import { createDraftStore } from "../sw/drafts";
import {
  clearDraft,
  clearDraftIfUnchanged,
  type DraftChange,
  type DraftPort,
  draftRevision,
  draftSendStore,
  flushDrafts,
  persistDrafts,
  readRichDraft,
  setDraftScope,
  stopPersistingDrafts,
  writeRichDraft,
} from "./drafts";

const ALICE = "alice|https://app.onlay.dev";
const BOB = "bob|https://app.onlay.dev";

type Change = DraftChange;

function fakePort(answer: Awaited<ReturnType<DraftPort["load"]>> = null) {
  const saves: Array<{ scope: string; changes: Change[] }> = [];
  let release: () => void = () => {};
  const gate = new Promise<void>((r) => {
    release = r;
  });
  const port: DraftPort = {
    load: () => gate.then(() => answer),
    save: (scope, changes) => saves.push({ scope, changes }),
  };
  return { port, saves, release };
}

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

afterEach(() => {
  stopPersistingDrafts();
  setDraftScope(null);
  for (const k of ["reply:c1", "reply:c2", "composer:x"]) clearDraft(k);
});

describe("D-1: drafts kept across a page reload", () => {
  test("typing is saved shortly after, under the account it was typed in", async () => {
    const f = fakePort();
    f.release();
    await persistDrafts(f.port);
    setDraftScope(ALICE);
    writeRichDraft("reply:c1", { text: "h" });
    writeRichDraft("reply:c1", { text: "hello" });
    expect(f.saves).toEqual([]);
    await wait(350);
    expect(f.saves).toEqual([
      { scope: ALICE, changes: [{ key: "reply:c1", value: { text: "hello" } }] },
    ]);
  });

  test("a sent draft is removed from storage at once", async () => {
    const f = fakePort();
    f.release();
    await persistDrafts(f.port);
    setDraftScope(ALICE);
    writeRichDraft("reply:c1", { text: "sent words" });
    const rev = draftRevision("reply:c1");
    expect(clearDraftIfUnchanged("reply:c1", rev)).toBe(true);
    await wait(5);
    expect(f.saves[f.saves.length - 1]).toEqual({
      scope: ALICE,
      changes: [{ key: "reply:c1", value: null }],
    });
  });

  test("a page load restores its drafts, pills included, before the composer reads them", async () => {
    const rich = {
      text: "see @Bob",
      tokens: [{ t: "actor" as const, actorId: "b", spans: [{ start: 4, length: 4 }] }],
    };
    const f = fakePort({ scope: ALICE, drafts: [{ key: "reply:c1", value: rich }] });
    const restored = persistDrafts(f.port);
    f.release();
    await restored;
    // The status (and so the account) comes after the restore on a real page.
    setDraftScope(ALICE);
    expect(readRichDraft("reply:c1")).toEqual(rich);
    // Restored text is not saved back.
    await wait(350);
    expect(f.saves).toEqual([]);
  });

  test("text typed while the restore was on its way wins over the restored copy", async () => {
    const f = fakePort({
      scope: ALICE,
      drafts: [
        { key: "reply:c1", value: { text: "old" } },
        { key: "reply:c2", value: { text: "kept" } },
      ],
    });
    const restored = persistDrafts(f.port);
    writeRichDraft("reply:c1", { text: "newer" });
    f.release();
    await restored;
    setDraftScope(ALICE);
    expect(readRichDraft("reply:c1")?.text).toBe("newer");
    expect(readRichDraft("reply:c2")?.text).toBe("kept");
    // Typed before the account was known: saved under it once it is.
    await wait(5);
    expect(f.saves).toEqual([
      { scope: ALICE, changes: [{ key: "reply:c1", value: { text: "newer" } }] },
    ]);
  });

  test("a restore for another account than the one now known restores nothing", async () => {
    const f = fakePort({ scope: ALICE, drafts: [{ key: "reply:c1", value: { text: "alice's" } }] });
    const restored = persistDrafts(f.port);
    setDraftScope(BOB);
    f.release();
    await restored;
    expect(readRichDraft("reply:c1")).toBeUndefined();
  });

  test("a restore that lands before the account is known, for another account, is dropped then", async () => {
    const f = fakePort({ scope: ALICE, drafts: [{ key: "reply:c1", value: { text: "alice's" } }] });
    const restored = persistDrafts(f.port);
    f.release();
    await restored;
    setDraftScope(BOB);
    expect(readRichDraft("reply:c1")).toBeUndefined();
    setDraftScope(null);
    setDraftScope(ALICE);
    expect(readRichDraft("reply:c1")).toBeUndefined();
  });

  test("an account change saves nothing more of the old account", async () => {
    const f = fakePort();
    f.release();
    await persistDrafts(f.port);
    setDraftScope(ALICE);
    writeRichDraft("reply:c1", { text: "alice typing" });
    setDraftScope(BOB);
    flushDrafts();
    await wait(350);
    expect(f.saves).toEqual([]);
  });

  test("a service worker that never answers holds the page up for one second at most", async () => {
    const port: DraftPort = { load: () => new Promise(() => {}), save: () => {} };
    const t0 = Date.now();
    await persistDrafts(port, 50);
    expect(Date.now() - t0).toBeLessThan(500);
  });
});

describe("2-D1: a retry after a reload reuses the lost send's id", () => {
  /** A page's port onto a real service-worker store, as one origin. */
  function worker() {
    const area: Record<string, unknown> = {};
    const sw = createDraftStore({
      get: async (k) => (k in area ? { [k]: structuredClone(area[k]) } : {}),
      set: async (items) => {
        Object.assign(area, structuredClone(items));
      },
      remove: async (k) => {
        delete area[k];
      },
      scope: async () => ALICE,
    });
    const sender = { origin: "https://a.example", url: "https://a.example/page" };
    let last: Promise<unknown> = Promise.resolve();
    const port: DraftPort = {
      load: () => sw.handle({ op: "load" }, sender) as ReturnType<DraftPort["load"]>,
      save: (scope, changes) => {
        last = sw.handle({ op: "save", scope, changes }, sender);
      },
    };
    return { port, saved: () => last };
  }

  /** A page load: nothing of the last page in memory, then the restore and the status. */
  async function reload(port: DraftPort): Promise<void> {
    setDraftScope(BOB);
    setDraftScope(null);
    await persistDrafts(port);
    setDraftScope(ALICE);
  }

  test("the restored draft, sent again with the same text, carries the same id", async () => {
    const w = worker();
    await persistDrafts(w.port);
    setDraftScope(ALICE);
    let n = 0;
    const first = createSendIds(() => `first-${++n}`, Date.now, draftSendStore);
    const body = { text: "hello" };
    writeRichDraft("reply:c1", body);
    const sent = first.clientIdFor("reply:c1", { body });
    // The send landed, but its receipt never came back: the page reloads.
    await w.saved();
    await reload(w.port);
    expect(readRichDraft("reply:c1")).toEqual(body);
    const after = createSendIds(() => `after-${++n}`, Date.now, draftSendStore);
    expect(after.clientIdFor("reply:c1", { body })).toBe(sent);
    // Other text is another send.
    expect(after.clientIdFor("reply:c1", { body: { text: "else" } })).not.toBe(sent);
    // Confirmed: gone from storage, so the next load starts a new send.
    after.confirmSend("reply:c1", sent);
    await w.saved();
    await reload(w.port);
    const third = createSendIds(() => `third-${++n}`, Date.now, draftSendStore);
    expect(third.clientIdFor("reply:c1", { body })).toBe(`third-${n}`);
  });

  test("an unconfirmed send's id is saved at once, not after the typing delay", async () => {
    const f = fakePort();
    f.release();
    await persistDrafts(f.port);
    setDraftScope(ALICE);
    const ids = createSendIds(() => "id-now", Date.now, draftSendStore);
    ids.clientIdFor("create:T", { a: 1 });
    expect(f.saves).toHaveLength(1);
    const change = f.saves[0]?.changes[0] as { key: string; add: { clientId: string } };
    expect(change.key).toBe("create:T");
    expect(change.add.clientId).toBe("id-now");
  });

  test("another account's restored ids are not this one's", async () => {
    const f = fakePort({
      scope: ALICE,
      drafts: [],
      sends: [{ key: "reply:c1", sends: [{ clientId: "alice-id", sig: "{}", at: Date.now() }] }],
    });
    const restored = persistDrafts(f.port);
    f.release();
    await restored;
    setDraftScope(BOB);
    expect(draftSendStore.get("reply:c1")).toBeUndefined();
  });
});

describe("3-D1: this tab saves only its own send ids", () => {
  test("confirming this tab's send leaves another tab's unconfirmed id stored", async () => {
    const area: Record<string, unknown> = {};
    const sw = createDraftStore({
      get: async (k) => (k in area ? { [k]: structuredClone(area[k]) } : {}),
      set: async (items) => {
        Object.assign(area, structuredClone(items));
      },
      remove: async (k) => {
        delete area[k];
      },
      scope: async () => ALICE,
    });
    const sender = { origin: "https://a.example", url: "https://a.example/page" };
    let last: Promise<unknown> = Promise.resolve();
    const port: DraftPort = {
      load: () => sw.handle({ op: "load" }, sender) as ReturnType<DraftPort["load"]>,
      save: (scope, changes) => {
        last = sw.handle({ op: "save", scope, changes }, sender);
      },
    };
    await persistDrafts(port);
    setDraftScope(ALICE);
    // Another tab of the same page sent a reply in c1 that is still unconfirmed.
    const theirs = { clientId: "other-tab", sig: '{"body":{"text":"theirs"}}', at: Date.now() };
    await sw.handle(
      { op: "save", scope: ALICE, changes: [{ key: "reply:c1", add: theirs }] },
      sender,
    );
    // This tab sends its own reply in c1 and gets its receipt.
    const ids = createSendIds(() => "this-tab", Date.now, draftSendStore);
    const mine = ids.clientIdFor("reply:c1", { body: { text: "mine" } });
    await last;
    ids.confirmSend("reply:c1", mine);
    await last;
    const got = (await sw.handle({ op: "load" }, sender)) as {
      sends: Array<{ key: string; sends: Array<{ clientId: string }> }>;
    };
    expect(got.sends.map((p) => [p.key, p.sends.map((a) => a.clientId)])).toEqual([
      ["reply:c1", ["other-tab"]],
    ]);
  });
});
