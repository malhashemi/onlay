/// <reference types="chrome" />
// The interaction modal's keyboard posture: opening focuses the scrollable
// body (arrows scroll the modal, Tab walks inward), refresh re-renders never
// steal focus, the header wears a maximize icon in place of a "Full view"
// actions button, and ⌃↵ reaches the full view from ANY child — capture
// phase, so the reply editor's propagation stop can't eat it. happy-dom.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { RawInteractionSnapshot, RawThreadMsg } from "@onlay/protocol";
import { Window } from "happy-dom";
import { type AppInternals, createApp } from "./app";
import { holdHiddenForCapture } from "./host";
import { createInteractionModal } from "./interaction-modal";

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

const flush = () => new Promise((r) => setTimeout(r, 0));

function msg(msgId: string, text: string): RawThreadMsg {
  return { msgId, authorId: "someone", body: { text }, ts: Date.now() };
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
    thread: [msg("m1", "hello")],
    createdAt: Date.now(),
  } as RawInteractionSnapshot;
}

function mountModal() {
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
  const fullViews: string[] = [];
  const modal = createInteractionModal(app, {
    load: (ref) => Promise.resolve(app.byId(ref.interactionId) ?? null),
    send: () => Promise.resolve({ ok: true }),
    onFullView: (id) => fullViews.push(id),
  });
  shadow.appendChild(modal.element);
  return { app, shadow, modal, fullViews };
}

function trustedClick(target: Element): void {
  const w = win as Window;
  const e = new w.Event("click", { bubbles: true, cancelable: true });
  Object.defineProperty(e, "isTrusted", { value: true });
  target.dispatchEvent(e as unknown as Event);
}

describe("interaction modal — keyboard posture", () => {
  test("opening focuses the scrollable body; a refresh re-render never re-steals focus", async () => {
    const { app, shadow, modal } = mountModal();
    app._setInteractions(SPACE, [snap("c1")]);
    modal.open({ interactionId: "c1", spaceId: SPACE, local: true });
    await flush();
    const body = modal.element.querySelector(".im-body") as HTMLElement;
    expect(body.tabIndex).toBe(0);
    expect(shadow.activeElement).toBe(body);

    // Identical truth → the F23 skip-key elides the rebuild entirely: the
    // SAME body stays mounted and simply KEEPS its focus (never re-stolen,
    // never dropped).
    modal.refresh();
    await flush();
    const same = modal.element.querySelector(".im-body") as HTMLElement;
    expect(same).toBe(body);
    expect(shadow.activeElement).toBe(body);

    // Changed truth → a real rebuild — which must not re-steal focus into
    // the fresh body (pendingFocus is spent on open, not on refresh).
    app._setInteractions(SPACE, [
      { ...snap("c1"), thread: [msg("m1", "hello"), msg("m2", "more")] },
    ]);
    modal.refresh();
    await flush();
    const rebuilt = modal.element.querySelector(".im-body") as HTMLElement;
    expect(rebuilt).not.toBe(body);
    expect(shadow.activeElement).not.toBe(rebuilt);
  });

  test("opened while a look holds the overlay hidden, it takes focus once the overlay shows, unless focus moved", async () => {
    const { app, shadow, modal } = mountModal();
    app._setInteractions(SPACE, [snap("c1")]);
    // A look's grab hides the overlay: nothing in it can take focus now.
    let release = holdHiddenForCapture();
    modal.open({ interactionId: "c1", spaceId: SPACE, local: true });
    await flush();
    const body = modal.element.querySelector(".im-body") as HTMLElement;
    expect(shadow.activeElement).not.toBe(body);
    release();
    expect(shadow.activeElement).toBe(modal.element.querySelector(".im-body"));

    // Focus moved somewhere else during the hold: it is left there.
    modal.close();
    const field = document.createElement("input");
    document.body.appendChild(field);
    release = holdHiddenForCapture();
    modal.open({ interactionId: "c1", spaceId: SPACE, local: true });
    await flush();
    field.focus();
    release();
    expect(document.activeElement).toBe(field);
  });

  test("the header wears a maximize icon; the actions row has no Full view button", async () => {
    const { app, modal, fullViews } = mountModal();
    app._setInteractions(SPACE, [snap("c1")]);
    modal.open({ interactionId: "c1", spaceId: SPACE, local: true });
    await flush();
    const max = modal.element.querySelector(".im-head .im-max") as HTMLElement;
    expect(max).not.toBeNull();
    expect(max.title).toContain("Full view");
    const actionTexts = [...modal.element.querySelectorAll(".im-actions button")].map(
      (b) => b.textContent,
    );
    expect(actionTexts).not.toContain("Full view");

    trustedClick(max);
    expect(fullViews).toEqual(["c1"]);
    expect(modal.isOpen()).toBe(false);
  });

  test("⌃↵ opens the full view even from a child that stops bubbling", async () => {
    const { app, modal, fullViews } = mountModal();
    app._setInteractions(SPACE, [snap("c1")]);
    modal.open({ interactionId: "c1", spaceId: SPACE, local: true });
    await flush();
    const body = modal.element.querySelector(".im-body") as HTMLElement;
    // simulate the reply editor's isolation: bubble-phase stopPropagation
    body.addEventListener("keydown", (e) => e.stopPropagation());
    const w = win as Window;
    const e = new w.KeyboardEvent("keydown", {
      key: "Enter",
      ctrlKey: true,
      bubbles: true,
      cancelable: true,
    });
    // A page-synthesized combo does nothing.
    body.dispatchEvent(e as unknown as Event);
    expect(fullViews).toEqual([]);
    const real = new w.KeyboardEvent("keydown", {
      key: "Enter",
      ctrlKey: true,
      bubbles: true,
      cancelable: true,
    });
    Object.defineProperty(real, "isTrusted", { value: true });
    body.dispatchEvent(real as unknown as Event);
    expect(fullViews).toEqual(["c1"]);
    expect(modal.isOpen()).toBe(false);
  });
});

describe("interaction modal — share", () => {
  function shareRig(role: "member" | "guest", listOk = true) {
    const calls: Array<Record<string, unknown>> = [];
    const copied: string[] = [];
    const host = document.createElement("div");
    document.body.appendChild(host);
    const shadow = host.attachShadow({ mode: "open" });
    const app = createApp({ shadow, host, isTopFrame: true, toast: () => {} }) as ReturnType<
      typeof createApp
    > &
      AppInternals;
    app._setSelf({ id: "me", name: "Me", tint: "#333", initials: "ME" });
    app._setSpaces([{ id: SPACE, kind: "workspace", name: "acme", role }], SPACE);
    app._setInteractions(SPACE, [snap("c1"), snap("c9")]);
    const modal = createInteractionModal(app, {
      load: (ref) => Promise.resolve(app.byId(ref.interactionId) ?? null),
      send: () => Promise.resolve({ ok: true }),
      share: {
        call: async (m) => {
          calls.push(m);
          if (!listOk) return { ok: false };
          return {
            ok: true,
            shares: [
              {
                email: "guest@x.test",
                sharedBy: { id: "me", name: "Me", initials: "ME", tint: "#333333" },
                createdAt: 1,
              },
            ],
          };
        },
        copy: async (t) => {
          copied.push(t);
          return true;
        },
      },
    });
    shadow.appendChild(modal.element);
    const buttons = () => [...modal.element.querySelectorAll("button")];
    const button = (label: string) => buttons().find((b) => b.textContent === label);
    return { modal, calls, copied, button };
  }

  test("a member shares the thread from the modal: the list, Share and Copy link", async () => {
    const r = shareRig("member");
    r.modal.open({ interactionId: "c1", spaceId: SPACE, local: true });
    await flush();
    const share = r.button("Share") as HTMLButtonElement;
    expect(share).toBeDefined();
    trustedClick(share);
    await flush();
    expect(r.calls[0]).toMatchObject({ op: "list", spaceId: SPACE, id: "c1" });
    expect(r.modal.element.querySelector(".share-section")?.textContent).toContain("guest@x.test");
    trustedClick(r.button("Copy link") as HTMLButtonElement);
    await flush();
    expect(r.copied[0]).toContain(`/app/#/t/${SPACE}/c1`);
  });

  test("a guest gets no Share in the modal", async () => {
    const r = shareRig("guest");
    r.modal.open({ interactionId: "c1", spaceId: SPACE, local: true });
    await flush();
    expect(r.button("Share")).toBeUndefined();
    expect(r.modal.element.querySelector(".share-section")).toBeNull();
  });

  test("a synthesized click opens nothing", async () => {
    const r = shareRig("member");
    r.modal.open({ interactionId: "c1", spaceId: SPACE, local: true });
    await flush();
    (r.button("Share") as HTMLButtonElement).click();
    await flush();
    expect(r.modal.element.querySelector(".share-section")).toBeNull();
  });

  test("a failed share-list read never reads as 'only people in this space'", async () => {
    const r = shareRig("member", false);
    r.modal.open({ interactionId: "c9", spaceId: SPACE, local: true });
    await flush();
    trustedClick(r.button("Share") as HTMLButtonElement);
    await flush();
    const text = r.modal.element.querySelector(".share-section")?.textContent ?? "";
    expect(text).not.toContain("Only people in this space.");
    expect(text).toContain("Couldn't load");
  });
});

test("opening a thread in the modal tells the server it was opened; a refresh does not", async () => {
  const opened: string[] = [];
  const host = document.createElement("div");
  document.body.appendChild(host);
  const shadow = host.attachShadow({ mode: "open" });
  const app = createApp({ shadow, host, isTopFrame: true, toast: () => {} }) as ReturnType<
    typeof createApp
  > &
    AppInternals;
  app._setInteractions(SPACE, [snap("c1")]);
  const modal = createInteractionModal(app, {
    load: (ref) => Promise.resolve(app.byId(ref.interactionId) ?? null),
    send: () => Promise.resolve({ ok: true }),
    onOpened: (ref) => opened.push(ref.interactionId),
  });
  shadow.appendChild(modal.element);
  modal.open({ interactionId: "c1", spaceId: SPACE, local: true });
  await flush();
  modal.refresh();
  await flush();
  expect(opened).toEqual(["c1"]);
});

test("a thread whose by-id read answers not_found closes with a short note (R3-C8)", async () => {
  const toasts: string[] = [];
  const host = document.createElement("div");
  document.body.appendChild(host);
  const shadow = host.attachShadow({ mode: "open" });
  const app = createApp({
    shadow,
    host,
    isTopFrame: true,
    toast: (t: string) => toasts.push(t),
  }) as ReturnType<typeof createApp> & AppInternals;
  let gone = false;
  const modal = createInteractionModal(app, {
    load: () => Promise.resolve(gone ? "not_found" : { ...snap("off1"), spaceId: SPACE }),
    send: () => Promise.resolve({ ok: true }),
  });
  shadow.appendChild(modal.element);
  modal.open({ interactionId: "off1", spaceId: SPACE, url: "https://elsewhere.test/" });
  await flush();
  expect(modal.isOpen()).toBe(true);
  expect(modal.currentId()).toBe("off1");
  // Access is removed; the next read (a remote tick) says the thread is gone.
  gone = true;
  modal.remoteTick();
  await flush();
  expect(modal.isOpen()).toBe(false);
  expect(toasts).toEqual(["This thread isn't available to you anymore, so it was closed."]);
});

test("a modal reply keeps its draft until the receipt, and says so when the socket drops first (3b-C10)", async () => {
  const g = globalThis as unknown as Record<string, unknown>;
  const msgs: unknown[] = [];
  g.location = (win as Window).location;
  g.chrome = {
    runtime: {
      sendMessage: (m: unknown) => {
        msgs.push(m);
        return Promise.resolve({ ok: true });
      },
    },
  };
  try {
    const { app, modal } = mountModal();
    app._setInteractions(SPACE, [snap("c1")]);
    modal.open({ interactionId: "c1", spaceId: SPACE, local: true });
    await flush();
    const box = modal.element.querySelector('[data-draft-key="modal-reply:c1"]') as HTMLElement;
    box.textContent = "still here";
    box.dispatchEvent(new Event("input", { bubbles: true }));
    const send = [...modal.element.querySelectorAll("button")].find(
      (b) => b.textContent === "Reply",
    ) as HTMLElement;
    trustedClick(send);
    await flush();
    expect(
      (modal.element.querySelector('[data-draft-key="modal-reply:c1"]') as HTMLElement).textContent,
    ).toBe("still here");
    expect(msgs.some((m) => (m as { type?: string }).type === "interaction-reply")).toBe(true);
    app._connectionLost(new Set([SPACE]));
    await flush();
    expect(
      (modal.element.querySelector('[data-draft-key="modal-reply:c1"]') as HTMLElement).textContent,
    ).toBe("still here");
    expect(modal.element.textContent).toContain(
      "Your reply wasn't sent. Check your connection, then send it again.",
    );
  } finally {
    delete g.chrome;
    delete g.location;
  }
});
