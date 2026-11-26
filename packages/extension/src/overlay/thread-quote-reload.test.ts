/// <reference types="chrome" />
// S-1: the message a reply quotes is kept with the reply's draft. A reply
// whose receipt is lost, sent again after a reload, carries the same quote and
// the same send id, so the space answers it once. A restored quote whose
// message is gone by then is dropped quietly. The thread panel runs in
// happy-dom over a real service-worker draft store.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { RawInteractionSnapshot, RawThreadMsg } from "@onlay/protocol";
import { Window } from "happy-dom";
import { createDraftStore } from "../sw/drafts";
import { type AppInternals, createApp } from "./app";
import {
  type DraftPort,
  flushDrafts,
  persistDrafts,
  replyQuote,
  setDraftScope,
  stopPersistingDrafts,
} from "./drafts";
import { createThreadPanel } from "./thread";

const SPACE = "s_aaaaaaaaaaaaaaaaaaaa";
const ALICE = "me|https://app.onlay.dev";
const BOB = "bob|https://app.onlay.dev";

let win: Window | null = null;
let sent: Array<Record<string, unknown>> = [];

function installDom(): void {
  win?.happyDOM.cancelAsync();
  win?.close();
  win = new Window({ url: "http://127.0.0.1:8124/page.html" });
  const g = globalThis as unknown as Record<string, unknown>;
  g.window = win;
  g.document = win.document;
  g.Element = win.Element;
  g.HTMLElement = win.HTMLElement;
  g.HTMLTextAreaElement = win.HTMLTextAreaElement;
  g.HTMLInputElement = win.HTMLInputElement;
  g.Node = win.Node;
  g.Event = win.Event;
  g.KeyboardEvent = win.KeyboardEvent;
  g.crypto = win.crypto ?? globalThis.crypto;
  g.location = win.location;
  g.chrome = {
    runtime: {
      sendMessage: (m: Record<string, unknown>) => {
        sent.push(m);
        return Promise.resolve({ ok: true });
      },
    },
  };
}

beforeEach(() => {
  sent = [];
  installDom();
});
afterEach(() => {
  stopPersistingDrafts();
  setDraftScope(BOB);
  setDraftScope(null);
  win?.happyDOM.cancelAsync();
  win?.close();
  win = null;
  delete (globalThis as unknown as Record<string, unknown>).chrome;
});

const flush = () => new Promise((r) => setTimeout(r, 0));

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
  const sender = { origin: "http://127.0.0.1:8124", url: "http://127.0.0.1:8124/page.html" };
  let last: Promise<unknown> = Promise.resolve();
  const port: DraftPort = {
    load: () => sw.handle({ op: "load" }, sender) as ReturnType<DraftPort["load"]>,
    save: (scope, changes) => {
      last = sw.handle({ op: "save", scope, changes }, sender);
    },
  };
  return {
    port,
    stored: async () => {
      flushDrafts();
      await last;
      return JSON.stringify(area);
    },
  };
}

function msg(msgId: string, text: string, over: Partial<RawThreadMsg> = {}): RawThreadMsg {
  return { msgId, authorId: "someone", body: { text }, ts: 1, ...over };
}

function snap(thread: RawThreadMsg[]): RawInteractionSnapshot {
  return {
    id: "c1",
    kind: "comment",
    url: "http://127.0.0.1:8124/page.html",
    anchor: { level: "page" },
    authorId: "someone",
    participants: ["someone"],
    waitingOn: [],
    state: "open",
    thread,
    createdAt: 1,
  } as RawInteractionSnapshot;
}

/** A page load: nothing of the last page in memory, a fresh panel, the restore, the status. */
async function load(port: DraftPort, thread: RawThreadMsg[]) {
  stopPersistingDrafts();
  setDraftScope(BOB);
  setDraftScope(null);
  installDom();
  await persistDrafts(port);
  setDraftScope(ALICE);
  const host = document.createElement("div");
  document.body.appendChild(host);
  const shadow = host.attachShadow({ mode: "open" });
  const app = createApp({ shadow, host, isTopFrame: true, toast: () => {} }) as ReturnType<
    typeof createApp
  > &
    AppInternals;
  app._setSelf({ id: "me", name: "Me", tint: "#333", initials: "ME" });
  const panel = createThreadPanel(app);
  shadow.appendChild(panel.element);
  app.onRender(() => panel.render());
  app._setInteractions(SPACE, [snap(thread)]);
  panel.open("c1");
  const q = (sel: string) => panel.element.querySelector(sel) as HTMLElement | null;
  const button = (label: string) =>
    [...panel.element.querySelectorAll("button")].find((b) => b.textContent === label) as
      | HTMLElement
      | undefined;
  return { app, panel, q, button };
}

function trustedClick(target: Element | undefined): void {
  if (!target) throw new Error("no such button");
  const w = win as Window;
  const e = new w.Event("click", { bubbles: true, cancelable: true });
  Object.defineProperty(e, "isTrusted", { value: true });
  target.dispatchEvent(e as unknown as Event);
}

const replies = () => sent.filter((f) => f.type === "interaction-reply");

describe("S-1: a reply's quote survives a reload", () => {
  test("a quoted reply whose receipt was lost is sent again identically after a reload", async () => {
    const w = worker();
    const thread = [msg("m1", "the root question"), msg("m2", "a later aside")];
    const first = await load(w.port, thread);
    trustedClick(first.button("reply"));
    const box = first.q('[data-draft-key="reply:c1"]');
    if (!box) throw new Error("reply box missing");
    box.textContent = "my answer";
    box.dispatchEvent(new Event("input", { bubbles: true }));
    trustedClick(first.button("Reply"));
    await flush();
    // The reply went out; its receipt never comes back.
    first.app._connectionLost(new Set([SPACE]));
    await flush();
    expect(replies()).toHaveLength(1);
    const before = replies()[0];
    expect(before).toMatchObject({ replyTo: { msgId: "m1" }, body: { text: "my answer" } });
    expect(await w.stored()).toContain("m1");

    // The page reloads: the reply box, its quote chip and the send id come back.
    sent = [];
    const second = await load(w.port, thread);
    expect(second.q('[data-draft-key="reply:c1"]')?.textContent).toBe("my answer");
    expect(second.q(".quote-chip")?.textContent).toContain("the root question");
    trustedClick(second.button("Reply"));
    await flush();
    expect(replies()).toHaveLength(1);
    expect(replies()[0]).toEqual(before as Record<string, unknown>);
  });

  test("a restored quote whose message is gone is dropped quietly", async () => {
    const w = worker();
    const first = await load(w.port, [msg("m1", "soon deleted")]);
    trustedClick(first.button("reply"));
    const box = first.q('[data-draft-key="reply:c1"]');
    if (!box) throw new Error("reply box missing");
    box.textContent = "still worth saying";
    box.dispatchEvent(new Event("input", { bubbles: true }));
    expect(await w.stored()).toContain("m1");

    const second = await load(w.port, [msg("m1", "", { deleted: true })]);
    expect(second.q('[data-draft-key="reply:c1"]')?.textContent).toBe("still worth saying");
    expect(second.q(".quote-chip")).toBeNull();
    expect(replyQuote("reply:c1")).toBeNull();
    trustedClick(second.button("Reply"));
    await flush();
    expect(replies()).toHaveLength(1);
    expect(replies()[0]?.replyTo).toBeUndefined();
    // Gone from storage too: the next load has no quote to restore.
    expect(await w.stored()).not.toContain("quote");
  });

  test("the × drops the quote from storage at once", async () => {
    const w = worker();
    const first = await load(w.port, [msg("m1", "root")]);
    trustedClick(first.button("reply"));
    expect(await w.stored()).toContain("m1");
    first.q(".quote-cancel")?.click();
    expect(first.q(".quote-chip")).toBeNull();
    expect(await w.stored()).not.toContain("m1");
  });
});

describe("a quote of a message that opens with code", () => {
  test("shows the code's first line, not the fence marker", async () => {
    const w = worker();
    const first = await load(w.port, [msg("m1", '```json\n{"a": 1}\n```\nthat one')]);
    trustedClick(first.button("reply"));
    const chip = first.q(".quote-chip .quote-text")?.textContent ?? "";
    expect(chip).toContain('{"a": 1}');
    expect(chip).not.toContain("```");
  });
});
