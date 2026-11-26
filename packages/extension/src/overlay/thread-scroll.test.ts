/// <reference types="chrome" />
// Stick-to-bottom (F-051 refinement): a same-thread re-render keeps the
// reader's scroll position — EXCEPT when new messages arrived and the reader
// was already at the bottom, in which case the body follows them. A reader
// scrolled up into history is never yanked. happy-dom has no layout, so
// scrollHeight/clientHeight are faked per test.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { RawInteractionSnapshot, RawThreadMsg } from "@onlay/protocol";
import { Window } from "happy-dom";
import { type AppInternals, createApp } from "./app";
import { createThreadPanel } from "./thread";

const SPACE = "s_aaaaaaaaaaaaaaaaaaaa";

let win: Window | null = null;

function installDom(): void {
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
}

beforeEach(installDom);
afterEach(() => {
  win?.happyDOM.cancelAsync();
  win?.close();
  win = null;
});

function msg(msgId: string, text: string): RawThreadMsg {
  return { msgId, authorId: "someone", body: { text }, ts: Date.now() };
}

function snap(id: string, thread: RawThreadMsg[]): RawInteractionSnapshot {
  return {
    id,
    kind: "comment",
    url: "http://127.0.0.1:8124/page.html",
    anchor: { level: "page" },
    authorId: "someone",
    participants: ["someone"],
    waitingOn: [],
    state: "open",
    thread,
    createdAt: Date.now(),
  } as RawInteractionSnapshot;
}

function mountThread() {
  const host = document.createElement("div");
  document.body.appendChild(host);
  const shadow = host.attachShadow({ mode: "open" });
  const app = createApp({
    shadow,
    host,
    isTopFrame: true,
    toast: () => {},
  }) as ReturnType<typeof createApp> & AppInternals;
  app._setSelf({ id: "me", name: "Me", tint: "#333", initials: "ME" });
  const panel = createThreadPanel(app);
  shadow.appendChild(panel.element);
  app.onRender(() => panel.render());
  const body = panel.element.querySelector(".thread-body") as HTMLElement;
  return { app, panel, body };
}

/** Fake the layout metrics happy-dom doesn't compute. */
function fakeMetrics(body: HTMLElement, scrollHeight: number, clientHeight: number): void {
  Object.defineProperty(body, "scrollHeight", { value: scrollHeight, configurable: true });
  Object.defineProperty(body, "clientHeight", { value: clientHeight, configurable: true });
}

describe("thread panel stick-to-bottom", () => {
  test("a reader at the bottom follows a newly arrived message", () => {
    const { app, panel, body } = mountThread();
    app._setInteractions(SPACE, [snap("c1", [msg("m1", "one"), msg("m2", "two")])]);
    panel.open("c1");
    fakeMetrics(body, 1000, 300);
    body.scrollTop = 700; // exactly at the bottom

    app._setInteractions(SPACE, [
      snap("c1", [msg("m1", "one"), msg("m2", "two"), msg("m3", "new")]),
    ]);
    expect(body.scrollTop).toBe(1000);
  });

  test("a reader scrolled up into history is never yanked by a new message", () => {
    const { app, panel, body } = mountThread();
    app._setInteractions(SPACE, [snap("c1", [msg("m1", "one"), msg("m2", "two")])]);
    panel.open("c1");
    fakeMetrics(body, 1000, 300);
    body.scrollTop = 100; // reading history, far from the bottom

    app._setInteractions(SPACE, [
      snap("c1", [msg("m1", "one"), msg("m2", "two"), msg("m3", "new")]),
    ]);
    expect(body.scrollTop).toBe(100);
  });

  test("a re-render without new messages keeps the position even at the bottom", () => {
    const { app, panel, body } = mountThread();
    const thread = [msg("m1", "one"), msg("m2", "two")];
    app._setInteractions(SPACE, [snap("c1", thread)]);
    panel.open("c1");
    fakeMetrics(body, 1000, 300);
    body.scrollTop = 700;

    app._setInteractions(SPACE, [snap("c1", thread)]); // e.g. a reaction-only frame
    expect(body.scrollTop).toBe(700);
  });

  test("a fresh open still starts at the top (F-051)", () => {
    const { app, panel, body } = mountThread();
    app._setInteractions(SPACE, [snap("c1", [msg("m1", "one")]), snap("c2", [msg("m2", "two")])]);
    panel.open("c1");
    fakeMetrics(body, 1000, 300);
    body.scrollTop = 700;

    panel.open("c2");
    expect(body.scrollTop).toBe(0);
  });
});
