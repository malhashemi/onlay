/// <reference types="chrome" />
// The thread panel (by its header and its resize grip) and the launcher drag
// through the same isolation as a composer card (drag-router.ts): a page's
// own window and document listeners see nothing of the gesture (its pointer,
// capture, mouse, touch and click events), a drag needs a trusted press and a
// captured pointer, and it ends on a cancel, the browser's own blur, the
// surface closing or the host being torn down.
import { afterEach, beforeEach, expect, test } from "bun:test";
import type { RawInteractionSnapshot } from "@onlay/protocol";
import { Window } from "happy-dom";
import { type AppInternals, createApp } from "./app";
import { cancelDrags, GESTURE_EVENTS, installDragIsolation } from "./drag-router";
import { createLauncherOrb } from "./launcher";
import { createThreadPanel } from "./thread";

const SPACE = "s_aaaaaaaaaaaaaaaaaaaa";

let win: Window | null = null;
const savedGlobals: Record<string, PropertyDescriptor | undefined> = {};
const DOM_GLOBALS = [
  "window",
  "document",
  "Element",
  "HTMLElement",
  "HTMLTextAreaElement",
  "HTMLInputElement",
  "Node",
  "Event",
  "KeyboardEvent",
  "chrome",
] as const;
/** What the panel saved to prefs (a stand-in `chrome.storage.local`). */
let stored: Array<Record<string, unknown>> = [];

beforeEach(() => {
  win = new Window({ url: "http://127.0.0.1:8124/page.html", width: 1000, height: 800 });
  const g = globalThis as unknown as Record<string, unknown>;
  const w = win as unknown as Record<string, unknown>;
  stored = [];
  for (const k of DOM_GLOBALS) {
    savedGlobals[k] = Object.getOwnPropertyDescriptor(globalThis, k);
    g[k] =
      k === "window"
        ? win
        : k === "chrome"
          ? {
              storage: {
                local: {
                  get: async () => ({}),
                  set: async (o: Record<string, unknown>) => {
                    stored.push(o);
                  },
                },
              },
            }
          : w[k];
  }
});
afterEach(() => {
  cancelDrags();
  win?.happyDOM.cancelAsync();
  win?.close();
  win = null;
  const g = globalThis as unknown as Record<string, unknown>;
  for (const k of DOM_GLOBALS) {
    const desc = savedGlobals[k];
    if (desc) Object.defineProperty(globalThis, k, desc);
    else delete g[k];
  }
});

function overlay() {
  const W = win as Window;
  const doc = W.document as unknown as Document;
  const host = doc.createElement("div");
  doc.documentElement.appendChild(host);
  const root = host.attachShadow({ mode: "open" });
  let clock = 1_000;
  installDragIsolation(
    W as unknown as globalThis.Window,
    () => ({ host, root }),
    () => clock,
  );
  // The page listens for every event of a gesture, on window and document, in both phases.
  const pageSaw: string[] = [];
  for (const type of GESTURE_EVENTS) {
    for (const capture of [true, false]) {
      W.addEventListener(type, () => pageSaw.push(type), { capture });
      W.document.addEventListener(type, () => pageSaw.push(`doc:${type}`), { capture });
    }
  }
  let under: Element | null = null;
  (root as unknown as { elementFromPoint: () => Element | null }).elementFromPoint = () => under;
  const trust = <E extends Event>(e: E, trusted: boolean): E => {
    if (trusted) Object.defineProperty(e, "isTrusted", { value: true, configurable: true });
    return e;
  };
  /** A pointer event; pointer 1, a mouse, trusted, unless `o` says otherwise. */
  const ptr = (
    type: string,
    target: EventTarget,
    x: number,
    y: number,
    trusted = true,
    o: { pointerId?: number; pointerType?: string } = {},
  ) => {
    const e = new W.PointerEvent(type, {
      bubbles: true,
      cancelable: true,
      composed: true,
      clientX: x,
      clientY: y,
      pointerId: o.pointerId ?? 1,
      pointerType: o.pointerType ?? "mouse",
      button: 0,
    }) as unknown as Event;
    target.dispatchEvent(trust(e, trusted));
  };
  /** Any other event of the gesture (mouse, touch, click); a touch event names its touches. */
  const fire = (
    type: string,
    target: EventTarget,
    o: { touches?: number[]; trusted?: boolean; pointerId?: number; closed?: boolean } = {},
  ) => {
    const e = new W.MouseEvent(type, { bubbles: true, cancelable: true, composed: true });
    // A click is a PointerEvent in the browser: it names its pointer.
    Object.defineProperty(e, "pointerId", { value: o.pointerId ?? 1 });
    // Under a closed root (the production build), a window listener's composed
    // path stops at the host: nothing inside the root is in it.
    if (o.closed)
      Object.defineProperty(e, "composedPath", {
        value: () => [host, W.document.documentElement, W.document, W],
      });
    if (o.touches)
      Object.defineProperty(e, "changedTouches", {
        value: o.touches.map((identifier) => ({ identifier })),
      });
    target.dispatchEvent(trust(e as unknown as Event, o.trusted ?? true));
  };
  /** A press on `target`, found there by the isolation's hit test. */
  const press = (
    target: Element,
    x: number,
    y: number,
    trusted = true,
    o: { pointerId?: number; pointerType?: string } = {},
  ) => {
    under = target;
    ptr("pointerdown", target, x, y, trusted, o);
  };
  const seen = (): string[] => pageSaw.splice(0);
  return {
    host,
    root,
    pageSaw,
    seen,
    ptr,
    fire,
    press,
    tick: (ms: number) => {
      clock += ms;
    },
  };
}

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

function threadRig() {
  const o = overlay();
  const app = createApp({
    shadow: o.root,
    host: o.host as HTMLElement,
    isTopFrame: true,
    toast: () => {},
  }) as ReturnType<typeof createApp> & AppInternals;
  const panel = createThreadPanel(app);
  o.root.appendChild(panel.element);
  const el = panel.element;
  // A hidden or detached panel has no box, as in a browser.
  el.getBoundingClientRect = () => {
    if (el.style.display === "none" || !el.isConnected)
      return { top: 0, left: 0, right: 0, bottom: 0, width: 0, height: 0 } as DOMRect;
    const top = Number.parseFloat(el.style.top || "60");
    const width = Number.parseFloat(el.style.width || "344");
    const height = Number.parseFloat(el.style.height || "400");
    const right = 1000 - Number.parseFloat(el.style.right || "16");
    return { top, left: right - width, right, bottom: top + height, width, height } as DOMRect;
  };
  app._setInteractions(SPACE, [snap("c1")]);
  panel.open("c1");
  const head = el.querySelector(".card-head") as HTMLElement;
  const title = head.querySelector(".title") as HTMLElement;
  const grip = el.querySelector(".panel-grip") as HTMLElement;
  return { ...o, panel, el, head, title, grip };
}

const flush = () => new Promise((r) => setTimeout(r, 0));

test("the page sees nothing of a finger's drag of the thread panel by its header, through its capture and its click", () => {
  const t = threadRig();
  const finger = { pointerType: "touch" };
  t.press(t.title, 600, 70, true, finger);
  t.ptr("gotpointercapture", t.head, 600, 70, true, finger);
  t.fire("touchstart", t.title, { touches: [7] });
  t.ptr("pointermove", t.head, 500, 170, true, finger);
  t.fire("touchmove", t.title, { touches: [7] });
  t.fire("mousemove", t.head);
  t.ptr("pointerup", t.head, 500, 170, true, finger);
  // What the release still brings: the capture let go, a finger lifted, the click.
  t.ptr("lostpointercapture", t.head, 500, 170, true, finger);
  t.fire("touchend", t.title, { touches: [7] });
  t.fire("mouseup", t.head);
  t.fire("click", t.head);
  expect(t.seen()).toEqual([]);
  expect(t.el.style.top).toBe("160px");
  expect(t.el.style.right).toBe("116px");
  // Once the gesture's trailing events are in, a move over the panel is the page's again.
  t.tick(600);
  t.ptr("pointermove", t.head, 400, 100);
  expect(t.seen()).toEqual(["pointermove", "doc:pointermove", "doc:pointermove", "pointermove"]);
  expect(t.el.style.top).toBe("160px");
});

test("a second finger, or a page's own made-up events, never change a drag that holds", () => {
  const t = threadRig();
  const first = { pointerType: "touch", pointerId: 1 };
  const second = { pointerType: "touch", pointerId: 2 };
  t.press(t.title, 600, 70, true, first);
  t.fire("touchstart", t.title, { touches: [7] });
  // A second finger on the panel: its press, moves and touches are the page's.
  t.press(t.title, 610, 80, true, second);
  t.ptr("pointermove", t.head, 700, 300, true, second);
  t.fire("touchstart", t.title, { touches: [8] });
  const saw = t.seen();
  expect(saw).toContain("pointerdown");
  expect(saw).toContain("pointermove");
  expect(saw).toContain("touchstart");
  // A page's made-up press and click reach the page and change nothing.
  t.press(t.title, 600, 70, false);
  t.fire("click", t.head, { trusted: false });
  expect(t.seen()).toEqual(expect.arrayContaining(["pointerdown", "click"]));
  // The first finger still drags, unseen, and its click after the release is still the drag's.
  t.ptr("pointermove", t.head, 500, 170, true, first);
  t.ptr("pointerup", t.head, 500, 170, true, first);
  t.fire("click", t.head);
  expect(t.seen()).toEqual([]);
  expect(t.el.style.top).toBe("160px");
});

test("while one finger drags the panel by its header, a second finger on the grip starts no resize", () => {
  const t = threadRig();
  const first = { pointerType: "touch", pointerId: 1 };
  const second = { pointerType: "touch", pointerId: 2 };
  t.press(t.title, 600, 70, true, first);
  // The second finger's press and move reach the page; the grip's own listener refuses them.
  t.press(t.grip, 640, 450, true, second);
  t.ptr("pointermove", t.grip, 600, 500, true, second);
  expect(t.seen()).toEqual(expect.arrayContaining(["pointerdown", "pointermove"]));
  expect(t.el.style.width).not.toBe("384px");
  // The first finger still drags, unseen.
  t.ptr("pointermove", t.head, 500, 170, true, first);
  expect(t.seen()).toEqual([]);
  expect(t.el.style.top).toBe("160px");
});

test("after a drag's release, a page's next press is the page's: its own lost capture and a click elsewhere reach it", () => {
  const W = win as Window;
  const t = threadRig();
  t.press(t.title, 600, 70);
  t.ptr("pointermove", t.head, 500, 170);
  t.ptr("pointerup", t.head, 500, 170);
  t.seen();
  // A click from another pointer, or one the keyboard made (no pointer), is not the drag's.
  t.fire("click", t.head, { pointerId: 2 });
  t.fire("click", t.head, { pointerId: -1 });
  // Each heard by the page's window listener in both phases.
  expect(t.seen().filter((x) => x === "click")).toHaveLength(4);
  // A page element takes the same pointer at once, then goes: its lost capture is sent to the document.
  t.ptr("pointerdown", W.document.body as unknown as EventTarget, 10, 10);
  t.seen();
  t.ptr("lostpointercapture", W.document as unknown as EventTarget, 10, 10);
  expect(t.seen()).toContain("doc:lostpointercapture");
});

test("a drag ended by a blur or by the panel closing, its release outside the overlay, leaves the router at once", () => {
  const W = win as Window;
  for (const end of ["blur", "close"] as const) {
    const t = threadRig();
    t.press(t.title, 600, 70);
    t.ptr("pointermove", t.head, 500, 170);
    if (end === "blur") {
      const blur = new W.Event("blur");
      Object.defineProperty(blur, "isTrusted", { value: true });
      W.dispatchEvent(blur);
    } else t.panel.close();
    // The release lands on the page, where the router never hears it.
    t.ptr("pointerup", W.document.body as unknown as EventTarget, 500, 170);
    t.seen();
    // The next event from the overlay is the page's: nothing of the drag is left.
    t.ptr("pointermove", t.head, 400, 100);
    expect(t.seen()).toContain("pointermove");
  }
});

test("a header button stays a button: its press goes on to the page, and nothing drags", () => {
  const t = threadRig();
  const close = [...t.head.querySelectorAll("button")].find((b) => b.textContent === "Close");
  t.press(close as Element, 600, 70);
  expect(t.seen()).toContain("pointerdown");
  t.ptr("pointermove", t.head, 500, 170);
  expect(t.el.style.top).not.toBe("160px");
});

test("the page never sees a resize by the panel's grip", () => {
  const t = threadRig();
  t.press(t.grip, 640, 450);
  t.ptr("pointermove", t.grip, 600, 500);
  t.ptr("pointerup", t.grip, 600, 500);
  t.ptr("lostpointercapture", t.grip, 600, 500);
  expect(t.seen()).toEqual([]);
  expect(t.el.style.width).toBe("384px");
  expect(t.el.style.height).toBe("450px");
});

test("an untrusted press, or one whose pointer the header cannot capture, drags nothing and reaches the page", () => {
  const t = threadRig();
  t.press(t.title, 600, 70, false);
  t.ptr("pointermove", t.head, 500, 170);
  expect(t.el.style.top).not.toBe("160px");
  expect(t.seen()).toContain("pointerdown");
  t.head.setPointerCapture = () => {
    throw new Error("NotFoundError");
  };
  t.press(t.title, 600, 70);
  t.ptr("pointermove", t.head, 500, 170);
  expect(t.el.style.top).not.toBe("160px");
  const saw = t.seen();
  expect(saw).toContain("pointerdown");
  expect(saw).toContain("pointermove");
});

test("closing the panel ends its drag; a page's made-up blur does not, the browser's does", () => {
  const t = threadRig();
  t.press(t.title, 600, 70);
  t.panel.close();
  // The finger or button is still down: the gesture is the overlay's until it is lifted.
  t.ptr("pointerup", t.head, 500, 170);
  t.tick(600);
  t.ptr("pointermove", t.head, 500, 170);
  expect(t.seen()).toContain("pointermove");
  expect(t.el.style.top).not.toBe("160px");

  t.panel.open("c1");
  t.press(t.grip, 640, 450);
  const W = win as Window;
  // A page dispatches a blur of its own: the resize goes on.
  W.dispatchEvent(new W.Event("blur"));
  t.ptr("pointermove", t.grip, 600, 500);
  expect(t.el.style.width).toBe("384px");
  // The browser's blur ends it.
  const blur = new W.Event("blur");
  Object.defineProperty(blur, "isTrusted", { value: true });
  W.dispatchEvent(blur);
  t.ptr("pointerup", t.grip, 600, 500);
  t.tick(600);
  t.ptr("pointermove", t.grip, 560, 560);
  expect(t.el.style.width).toBe("384px");
  expect(t.seen()).toContain("pointermove");
});

test("closing the panel during a resize saves the size it reached, never 0 × 0", async () => {
  const t = threadRig();
  t.press(t.grip, 640, 450);
  t.ptr("pointermove", t.grip, 600, 500);
  t.panel.close();
  await flush();
  await flush();
  const sizes = stored.map((o) => Object.values(o)[0] as { threadPanelSize?: unknown });
  expect(sizes[sizes.length - 1]?.threadPanelSize).toEqual({ w: 384, h: 450 });
});

test("a resize ended by tearing the host down saves no 0 × 0 size", async () => {
  const t = threadRig();
  t.press(t.grip, 640, 450);
  t.ptr("pointermove", t.grip, 600, 500);
  // The host is removed first, then the teardown ends the drag.
  t.host.remove();
  cancelDrags();
  await flush();
  await flush();
  const sizes = stored.map((o) => Object.values(o)[0] as { threadPanelSize?: unknown });
  expect(sizes.map((x) => x.threadPanelSize)).not.toContainEqual({ w: 0, h: 0 });
});

function launcherRig(o = overlay()) {
  let opened = 0;
  const notes: string[] = [];
  let saved: unknown = null;
  const orb = createLauncherOrb({
    onOpen: () => opened++,
    onKeptNote: () => notes.push("kept"),
    onAgentNote: () => notes.push("agent"),
    store: { load: async () => null, save: (p) => (saved = p) },
  });
  o.root.appendChild(orb.element);
  const btn = orb.element;
  btn.getBoundingClientRect = () =>
    ({ top: 700, left: 900, right: 948, bottom: 748, width: 48, height: 48 }) as DOMRect;
  return { ...o, orb, btn, opened: () => opened, notes, saved: () => saved };
}

test("the page never sees a drag of the launcher or its click, and the next plain click opens the Inbox", () => {
  const l = launcherRig();
  l.press(l.btn, 920, 720);
  l.ptr("pointermove", l.btn, 600, 400);
  l.ptr("pointerup", l.btn, 600, 400);
  l.ptr("lostpointercapture", l.btn, 600, 400);
  l.fire("click", l.btn);
  expect(l.seen()).toEqual([]);
  expect(l.saved()).not.toBeNull();
  expect(l.opened()).toBe(0);
  // A press that does not travel past the slop clicks the orb, as before.
  l.tick(600);
  l.press(l.btn, 920, 720);
  l.ptr("pointermove", l.btn, 922, 721);
  l.ptr("pointerup", l.btn, 922, 721);
  l.fire("click", l.btn);
  expect(l.opened()).toBe(1);
});

test("after a drag of the launcher, the next activation from the keyboard opens the Inbox; the drag never does", async () => {
  const l = launcherRig();
  l.press(l.btn, 920, 720);
  l.ptr("pointermove", l.btn, 600, 400);
  l.ptr("pointerup", l.btn, 600, 400);
  l.fire("click", l.btn);
  expect(l.opened()).toBe(0);
  await new Promise((r) => setTimeout(r, 0));
  // Enter or Space on the focused orb: a click no pointer made (pointer id -1).
  l.fire("click", l.btn, { pointerId: -1 });
  expect(l.opened()).toBe(1);
});

test("under a closed root, the drag's click is still the overlay's, and what it trailed ends there", () => {
  const l = launcherRig();
  l.press(l.btn, 920, 720);
  l.ptr("pointermove", l.btn, 600, 400);
  l.ptr("pointerup", l.btn, 600, 400);
  l.seen();
  // The composed path holds nothing inside the root: the click is the drag's all the same.
  l.fire("click", l.btn, { closed: true });
  expect(l.seen()).toEqual([]);
  expect(l.opened()).toBe(0);
  // That click ended the gesture: the overlay's next move is the page's again.
  l.ptr("pointermove", l.btn, 610, 410);
  expect(l.seen()).toContain("pointermove");
});

test("a press on a launcher marker is the marker's: no capture on the orb, and its click runs the marker", () => {
  const l = launcherRig();
  l.orb.setKeptShown(2);
  l.orb.setAgentPending(1);
  const [kept, agent] = [...l.btn.querySelectorAll(".orb-note")] as HTMLElement[];
  let captured = 0;
  l.btn.setPointerCapture = () => {
    captured++;
  };
  for (const note of [kept, agent] as HTMLElement[]) {
    l.press(note, 930, 720);
    l.ptr("pointerup", note, 930, 720);
    l.fire("click", note);
  }
  expect(captured).toBe(0);
  expect(l.notes).toEqual(["kept", "agent"]);
  expect(l.opened()).toBe(0);
});

test("a lost capture sent to the document, alone, ends the launcher's drag: the next press drags", () => {
  const l = launcherRig();
  l.press(l.btn, 920, 720);
  l.ptr("pointermove", l.btn, 600, 400);
  // The host went; its lost capture is sent to the document, where no handle hears it.
  l.ptr("lostpointercapture", (win as Window).document as unknown as EventTarget, 600, 400);
  l.tick(600);
  l.seen();
  l.press(l.btn, 900, 700);
  l.ptr("pointermove", l.btn, 500, 300);
  expect(l.seen()).toEqual([]);
  expect(l.saved()).not.toBeNull();
});

test("tearing the host down, alone, ends the launcher's drag: the next press drags", () => {
  const l = launcherRig();
  l.press(l.btn, 920, 720);
  l.ptr("pointermove", l.btn, 600, 400);
  // No lost capture arrives at all: the teardown ends it.
  cancelDrags();
  l.seen();
  l.press(l.btn, 900, 700);
  l.ptr("pointermove", l.btn, 500, 300);
  expect(l.seen()).toEqual([]);
  expect(l.saved()).not.toBeNull();
});
