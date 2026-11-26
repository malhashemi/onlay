// The full view follows the account (3-M2): when the signed-in person or the
// server changes under an open page, the thread it shows and its reply editor
// go, its drafts are dropped, and it reads the thread again as the new
// account, which here may not see it. happy-dom with the page's #root, so the
// module boots as the real page does; chrome is stubbed per account.
import { afterAll, beforeAll, expect, test } from "bun:test";
import type { RawInteractionSnapshot } from "@onlay/protocol";
import { Window } from "happy-dom";

const ID = "11111111-1111-4111-8111-111111111111";
const GLOBALS = [
  "window",
  "document",
  "location",
  "Element",
  "HTMLElement",
  "HTMLTextAreaElement",
  "HTMLInputElement",
  "Node",
  "Text",
  "Event",
  "KeyboardEvent",
  "MouseEvent",
  "MutationObserver",
  "CSSStyleSheet",
  "DOMParser",
  "crypto",
  "chrome",
  "navigator",
  "requestAnimationFrame",
] as const;
const saved: Record<string, PropertyDescriptor | undefined> = {};

const thread: RawInteractionSnapshot = {
  id: ID,
  kind: "comment",
  anchor: { level: "unanchored" },
  authorId: "p_alice",
  participants: ["p_alice"],
  waitingOn: [],
  state: "open",
  thread: [{ msgId: "m1", authorId: "p_alice", body: { text: "Alice's private note" }, ts: 0 }],
  createdAt: 0,
};

let account: "alice" | "bob" = "alice";
const storageListeners: Array<(changes: Record<string, unknown>, area: string) => void> = [];
let win: Window | null = null;

function chromeStub(): unknown {
  return {
    runtime: {
      sendMessage: (msg: { type?: string }) => {
        switch (msg?.type) {
          case "getStatus":
            return Promise.resolve({
              person: { id: `p_${account}`, name: account, initials: "X", tint: "#333" },
              serverOrigin: "https://app.onlay.dev",
            });
          case "getDirectory":
            return Promise.resolve({ ok: true, people: [] });
          case "getInteraction":
            return Promise.resolve(
              account === "alice" ? { ok: true, interaction: thread } : { ok: false },
            );
          default:
            return Promise.resolve({ ok: false });
        }
      },
      onMessage: { addListener: () => {} },
    },
    storage: {
      local: { get: () => Promise.resolve({}), set: () => Promise.resolve() },
      onChanged: {
        addListener: (fn: (changes: Record<string, unknown>, area: string) => void) =>
          storageListeners.push(fn),
        removeListener: () => {},
      },
    },
  };
}

const settle = () => new Promise((r) => setTimeout(r, 20));

beforeAll(() => {
  win = new Window({ url: `chrome-extension://x/interaction.html?id=${ID}` });
  win.document.body.innerHTML = `<div id="root"></div>`;
  const g = globalThis as unknown as Record<string, unknown>;
  for (const k of GLOBALS) saved[k] = Object.getOwnPropertyDescriptor(globalThis, k);
  g.window = win;
  g.document = win.document;
  g.location = win.location;
  for (const k of GLOBALS.slice(3)) {
    const v = (win as unknown as Record<string, unknown>)[k];
    if (v !== undefined) g[k] = v;
  }
  g.crypto = win.crypto ?? globalThis.crypto;
  g.requestAnimationFrame = (fn: () => void) => setTimeout(fn, 0);
  g.chrome = chromeStub();
});

afterAll(() => {
  win?.happyDOM.cancelAsync();
  win?.close();
  for (const k of GLOBALS) {
    const d = saved[k];
    if (d) Object.defineProperty(globalThis, k, d);
    else delete (globalThis as unknown as Record<string, unknown>)[k];
  }
});

test("another account on the page clears the thread, its reply editor and drafts, and reads again", async () => {
  // A fresh instance of the page module, booted on this page's #root.
  // (the query keeps it apart from the instance other tests import without a #root).
  const page = "./interaction.ts?account-follow";
  await import(page);
  await settle();
  const root = () => (win as Window).document.getElementById("root") as unknown as HTMLElement;
  expect(root().textContent).toContain("Alice's private note");
  const editor = root().querySelector('[data-draft-key^="fullview-reply"]') as HTMLElement;
  expect(editor).not.toBeNull();
  const { readRichDraft, writeRichDraft } = await import("./overlay/drafts");
  writeRichDraft(`fullview-reply:${ID}`, { text: "Alice's unsent reply" });

  // Bob signs in on this browser: the account generation moves.
  account = "bob";
  for (const fn of storageListeners) fn({ accountGeneration: { newValue: 2 } }, "local");
  await settle();
  expect(root().textContent).not.toContain("Alice's private note");
  expect(root().querySelector('[data-draft-key^="fullview-reply"]')).toBeNull();
  expect(root().textContent).toContain("isn't yours to see");
  expect(readRichDraft(`fullview-reply:${ID}`)).toBeUndefined();
});
