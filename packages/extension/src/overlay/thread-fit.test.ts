/// <reference types="chrome" />
// A short window: the thread panel's least height gives way to the room below
// its top, so its controls stay on screen, and a resize fits it again.
// happy-dom has no layout, so the panel's top is faked.
import { afterEach, beforeEach, expect, test } from "bun:test";
import type { RawInteractionSnapshot } from "@onlay/protocol";
import { Window } from "happy-dom";
import { type AppInternals, createApp } from "./app";
import { scaled } from "./dom";
import { createThreadPanel } from "./thread";

const SPACE = "s_aaaaaaaaaaaaaaaaaaaa";

let win: Window | null = null;

beforeEach(() => {
  win = new Window({ url: "http://127.0.0.1:8124/page.html", width: 1000, height: 300 });
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
});
afterEach(() => {
  win?.happyDOM.cancelAsync();
  win?.close();
  win = null;
});

function snap(id: string): RawInteractionSnapshot {
  return {
    id,
    kind: "comment",
    url: "http://127.0.0.1:8124/page.html",
    anchor: { level: "page" },
    authorId: "someone",
    participants: ["someone"],
    waitingOn: [],
    state: "open",
    thread: [{ msgId: "m1", authorId: "someone", body: { text: "first" }, ts: 1 }],
    createdAt: 1,
  } as RawInteractionSnapshot;
}

const px = (v: string): number => Number.parseFloat(v);

test("on a 300px-tall window the panel's least height is the room below its top, and a resize fits it again", () => {
  const host = document.createElement("div");
  document.body.appendChild(host);
  const shadow = host.attachShadow({ mode: "open" });
  const app = createApp({ shadow, host, isTopFrame: true, toast: () => {} }) as ReturnType<
    typeof createApp
  > &
    AppInternals;
  const panel = createThreadPanel(app);
  shadow.appendChild(panel.element);
  let top = 54;
  panel.element.getBoundingClientRect = () =>
    ({ top, left: 0, right: 344, bottom: top + 260, width: 344, height: 260 }) as DOMRect;
  app._setInteractions(SPACE, [snap("c1")]);
  panel.open("c1");

  const style = panel.element.style;
  const min = px(style.minHeight);
  const max = px(style.maxHeight);
  // The sheet's 260px least would end below the window: it gives way.
  expect(min).toBeLessThanOrEqual(max);
  expect(top + max).toBeLessThanOrEqual(300);
  expect(min).toBe(300 - 54 - scaled(12));

  // A taller window: the least is the sheet's own again, the greatest grows.
  (win as Window).happyDOM.setWindowSize({ width: 1000, height: 800 });
  (win as Window).dispatchEvent(new (win as Window).Event("resize"));
  expect(px(style.minHeight)).toBe(scaled(260));
  expect(px(style.maxHeight)).toBe(Math.floor(800 * 0.88));

  // Moved low, then the window shrinks: the panel comes back up to show its head.
  top = 700;
  (win as Window).happyDOM.setWindowSize({ width: 1000, height: 300 });
  (win as Window).dispatchEvent(new (win as Window).Event("resize"));
  expect(px(style.top)).toBe(300 - scaled(48));
});
