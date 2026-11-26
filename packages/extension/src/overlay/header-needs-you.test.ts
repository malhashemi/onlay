/// <reference types="chrome" />
// A thread's header says what the Inbox says: whether it needs you is the
// server's attention (an agent's answer to what you asked, a mention, a
// reply on your thread, shared with you), not waitingOn alone. Where the
// person's Inbox lists the thread it decides; a thread it does not list yet
// falls back to waitingOn, and the chip moves when the Inbox arrives. The
// same decision (`app.needsYou`) draws the pins and the orb's count.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { RawInteractionSnapshot } from "@onlay/protocol";
import { Window } from "happy-dom";
import { type AppInternals, createApp } from "./app";
import { createInteractionModal } from "./interaction-modal";
import { createThreadPanel } from "./thread";

const SPACE = "s_aaaaaaaaaaaaaaaaaaaa";
const PAGE = "http://127.0.0.1:8124/page.html";

let win: Window | null = null;

beforeEach(() => {
  win = new Window({ url: PAGE });
  const g = globalThis as unknown as Record<string, unknown>;
  for (const k of ["Element", "HTMLElement", "Node", "Text", "Event", "MutationObserver"])
    g[k] = (win as unknown as Record<string, unknown>)[k];
  g.window = win;
  g.document = win.document;
  g.crypto = win.crypto ?? globalThis.crypto;
  g.location = win.location;
  g.chrome = {
    runtime: { sendMessage: () => Promise.resolve({ ok: false }) },
    storage: { local: { set: () => Promise.resolve() } },
  };
});
afterEach(() => {
  win?.happyDOM.cancelAsync();
  win?.close();
  win = null;
  delete (globalThis as unknown as Record<string, unknown>).chrome;
});

const flush = () => new Promise((r) => setTimeout(r, 0));

function makeApp() {
  const host = document.createElement("div");
  document.body.appendChild(host);
  const shadow = host.attachShadow({ mode: "open" });
  const app = createApp({ shadow, host, isTopFrame: true, toast: () => {} }) as ReturnType<
    typeof createApp
  > &
    AppInternals;
  app._setSelf({ id: "me", name: "Me", tint: "#333", initials: "ME" });
  app._setDirectory(SPACE, [{ id: "bea", name: "Bea", tint: "#222", initials: "BE" }]);
  return { app, shadow };
}

/** My Comment that my agent answered: it waits on nobody. */
function answered(over: Partial<RawInteractionSnapshot> = {}): RawInteractionSnapshot {
  return {
    id: "c1",
    kind: "comment",
    url: PAGE,
    anchor: { level: "page" },
    authorId: "me",
    participants: ["me"],
    waitingOn: [],
    state: "open",
    agentWork: { status: "answered", requestedBy: "me", requestedAt: 1, answeredAt: 2 },
    thread: [
      { msgId: "m1", authorId: "me", body: { text: "@agent tighten this" }, ts: 1 },
      { msgId: "m2", authorId: "me", body: { text: "Done." }, ts: 2, agent: true },
    ],
    createdAt: 1,
    ...over,
  } as RawInteractionSnapshot;
}

const NEEDS = { needsYou: [{ interactionId: "c1", because: "agent-answered" }], waiting: [] };
const WAITS = { needsYou: [], waiting: [{ interactionId: "c1" }] };

function chipOf(root: HTMLElement): string {
  const chip = root.querySelector(".chip-needs, .chip-waiting, .chip-resolved");
  return chip?.classList.contains("chip-needs")
    ? "needs-you"
    : chip?.classList.contains("chip-waiting")
      ? "waiting"
      : "none";
}

describe("app.needsYou: the one decision behind headers, pins and the orb", () => {
  test("the Inbox decides where it lists the thread; waitingOn until then", () => {
    const { app } = makeApp();
    expect(app.needsYou(answered())).toBe(false);
    expect(app.needsYou(answered({ waitingOn: ["me"] }))).toBe(true);
    app._setAttention(NEEDS, "me");
    expect(app.needsYou(answered())).toBe(true);
    app._setAttention(WAITS, "me");
    expect(app.needsYou(answered({ waitingOn: ["me"] }))).toBe(false);
    // Not listed: the fallback again.
    expect(app.needsYou(answered({ id: "c2", waitingOn: ["me"] }))).toBe(true);
  });

  test("another person's Inbox is never taken, and a new person starts from none", () => {
    const { app } = makeApp();
    app._setAttention(NEEDS, "someone-else");
    expect(app.needsYou(answered())).toBe(false);
    app._setAttention(NEEDS, "me");
    app._setSelf({ id: "you", name: "You", tint: "#444", initials: "YO" });
    expect(app.needsYou(answered())).toBe(false);
  });
});

describe("the thread panel's header", () => {
  function open() {
    const { app, shadow } = makeApp();
    const panel = createThreadPanel(app);
    shadow.appendChild(panel.element);
    app.onRender(() => panel.render());
    app._setInteractions(SPACE, [answered()]);
    panel.open("c1");
    return { app, panel };
  }

  test("an agent-answered thread the server lists under needs-you says needs you", () => {
    const { app, panel } = open();
    app._setAttention(NEEDS, "me");
    app.requestRender();
    expect(chipOf(panel.element)).toBe("needs-you");
  });

  test("one the server lists under waiting says waiting, whatever waitingOn holds", () => {
    const { app, panel } = open();
    app._setInteractions(SPACE, [answered({ waitingOn: ["me"] })]);
    expect(chipOf(panel.element)).toBe("needs-you");
    app._setAttention(WAITS, "me");
    app.requestRender();
    expect(chipOf(panel.element)).toBe("waiting");
  });

  test("before the Inbox knows it, waitingOn decides; the chip moves when it arrives", () => {
    const { app, panel } = open();
    expect(chipOf(panel.element)).toBe("waiting");
    const message = panel.element.querySelector(".msg");
    expect(message).not.toBeNull();
    app._setAttention(NEEDS, "me");
    app.requestRender();
    expect(chipOf(panel.element)).toBe("needs-you");
    // Only the chip moved: the thread was not rebuilt under the reader.
    expect(panel.element.querySelector(".msg")).toBe(message);
  });
});

describe("the interaction modal's header", () => {
  function open(local: boolean, over: Partial<RawInteractionSnapshot> = {}) {
    const { app, shadow } = makeApp();
    const off = { ...answered(over), spaceId: SPACE };
    const modal = createInteractionModal(app, {
      load: (ref) => Promise.resolve(local ? (app.byId(ref.interactionId) ?? null) : off),
      send: () => Promise.resolve({ ok: true }),
    });
    shadow.appendChild(modal.element);
    app.onRender(() => modal.refresh());
    if (local) app._setInteractions(SPACE, [off]);
    modal.open({ interactionId: "c1", spaceId: SPACE, local });
    return { app, modal };
  }

  test("an agent-answered thread the server lists under needs-you says needs you", async () => {
    const { app, modal } = open(true);
    app._setAttention(NEEDS, "me");
    await flush();
    expect(chipOf(modal.element)).toBe("needs-you");
  });

  test("one the server lists under waiting says waiting", async () => {
    const { app, modal } = open(true, { waitingOn: ["me"] });
    app._setAttention(WAITS, "me");
    await flush();
    expect(chipOf(modal.element)).toBe("waiting");
  });

  test("an open thread's chip follows the Inbox when it arrives, on this page or off it", async () => {
    for (const local of [true, false]) {
      const { app, modal } = open(local);
      await flush();
      expect(chipOf(modal.element)).toBe("waiting");
      const message = modal.element.querySelector(".msg");
      expect(message).not.toBeNull();
      app._setAttention(NEEDS, "me");
      app.requestRender();
      await flush();
      expect(chipOf(modal.element)).toBe("needs-you");
      expect(modal.element.querySelector(".msg")).toBe(message);
    }
  });
});
