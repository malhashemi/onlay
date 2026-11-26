/// <reference types="chrome" />
// A block picked inside a child frame (round 3, F-2, F-5): the composer is the
// top frame's, but the create goes through the frame that owns the block (the
// composer's `via`), the draft is keyed by the frame's own address, nothing is
// sent on this frame's socket, and Variants are asked for through that frame (E-1).
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { SpaceSummary } from "@onlay/protocol";
import { Window } from "happy-dom";
import { type AppInternals, type CreateResult, createApp } from "./app";
import {
  type ComposerVia,
  changeComposer,
  commentComposer,
  FRAME_PAGE_CHANGED,
  FRAME_VARIANTS_NOTE,
} from "./composers";
import { setDraftScope } from "./drafts";

const SPACE = "s_aaaaaaaaaaaaaaaaaaaa";
const TOP = "https://dossier.example/goals/ceo/";
const FRAME = "https://tree.content.example/goals/ceo/";

let win: Window | null = null;
let sent: Array<Record<string, unknown>> = [];

beforeEach(() => {
  win = new Window({ url: TOP });
  const g = globalThis as unknown as Record<string, unknown>;
  for (const k of ["Element", "HTMLElement", "Node", "Text", "Event", "KeyboardEvent"])
    g[k] = (win as unknown as Record<string, unknown>)[k];
  g.window = win;
  g.document = win.document;
  g.crypto = win.crypto ?? globalThis.crypto;
  g.location = win.location;
  sent = [];
  g.chrome = {
    runtime: {
      sendMessage: (m: Record<string, unknown>) => {
        sent.push(m);
        return Promise.resolve({ ok: true });
      },
    },
    storage: { local: { set: () => Promise.resolve() } },
  };
});
afterEach(() => {
  win?.happyDOM.cancelAsync();
  win?.close();
  win = null;
  delete (globalThis as unknown as Record<string, unknown>).chrome;
  setDraftScope(null);
});

const flush = () => new Promise((r) => setTimeout(r, 0));

function trustedClick(target: Element): void {
  const e = new (win as Window).Event("click", { bubbles: true, cancelable: true });
  Object.defineProperty(e, "isTrusted", { value: true });
  target.dispatchEvent(e as unknown as Event);
}

function makeApp() {
  const host = document.createElement("div");
  document.body.appendChild(host);
  const shadow = host.attachShadow({ mode: "open" });
  const app = createApp({ shadow, host, isTopFrame: true, toast: () => {} }) as ReturnType<
    typeof createApp
  > &
    AppInternals;
  app._setSelf({ id: "me", name: "Me", tint: "#333", initials: "ME" });
  app._setSpaces(
    [{ id: SPACE, kind: "personal", name: "Me", role: "admin" } as SpaceSummary],
    SPACE,
  );
  return app;
}

function type(box: HTMLElement, text: string): void {
  box.textContent = text;
  box.dispatchEvent(new Event("input", { bubbles: true }));
}
const editor = (root: ParentNode) => root.querySelector("[contenteditable]") as HTMLElement;
const button = (root: ParentNode, label: string) =>
  [...root.querySelectorAll("button")].find((b) => b.textContent === label) as HTMLElement;

const anchor = { level: "element" as const, selector: "#goal > p" };

function via(): ComposerVia & { calls: Array<Record<string, unknown>> } {
  const calls: Array<Record<string, unknown>> = [];
  return {
    calls,
    pageUrl: FRAME,
    host: "tree.content.example",
    create: (payload, spaceId, nonce): Promise<CreateResult> => {
      calls.push({ payload, spaceId, nonce });
      return Promise.resolve({ ok: true, interactionId: "11111111-1111-4111-8111-111111111111" });
    },
  };
}

describe("a composer for a block in a child frame", () => {
  test("a comment is created through the owning frame, never on this frame's socket", async () => {
    const app = makeApp();
    const v = via();
    let done = 0;
    const view = commentComposer(app, anchor, () => done++, v);
    document.body.appendChild(view);
    type(editor(view), "Is this the plan?");
    trustedClick(button(view, "Comment"));
    await flush();
    expect(v.calls).toHaveLength(1);
    expect(v.calls[0]).toMatchObject({
      spaceId: SPACE,
      payload: { kind: "comment", anchor, body: { text: "Is this the plan?" } },
    });
    expect(typeof v.calls[0]?.nonce).toBe("string");
    expect(sent.filter((m) => m.type === "interaction-create")).toEqual([]);
    expect(done).toBe(1);
    // The draft belongs to the frame's own address: none is left under it.
    expect(editor(commentComposer(app, anchor, () => {}, v)).textContent).toBe("");
  });

  test("a Direct Edit goes the same way", async () => {
    const app = makeApp();
    const v = via();
    const view = changeComposer(
      app,
      anchor,
      () => {},
      { startVariants: () => Promise.reject(new Error("never")) },
      { via: v },
    );
    document.body.appendChild(view);
    // The block's action row is offered: the frame's block is a block, not the page.
    expect(button(view, "Insert after")).toBeTruthy();
    type(editor(view), "Shorter, please");
    trustedClick(button(view, "Request edit"));
    await flush();
    expect(v.calls[0]).toMatchObject({
      payload: { kind: "change", anchor, change: { intent: "Shorter, please", method: "direct" } },
    });
    expect(sent.filter((m) => m.type === "interaction-create")).toEqual([]);
  });

  test("Variants are asked for through the owning frame, never on this frame's socket (E-1)", async () => {
    const app = makeApp();
    const v = via();
    const asked: unknown[][] = [];
    v.startVariants = (...args) => {
      asked.push(args);
      return Promise.resolve({ ok: true, interactionId: "22222222-2222-4222-8222-222222222222" });
    };
    let done = 0;
    const view = changeComposer(
      app,
      anchor,
      () => done++,
      { startVariants: () => Promise.reject(new Error("never")) },
      { via: v },
    );
    document.body.appendChild(view);
    trustedClick(button(view, "Variants"));
    const generate = button(view, "Generate variants") as HTMLButtonElement;
    expect(generate.disabled).toBe(false);
    type(editor(view), "Calmer, please");
    trustedClick(generate);
    await flush();
    expect(asked).toEqual([["Calmer, please", 3, "change", SPACE]]);
    expect(sent.filter((m) => m.type === "variant-create")).toEqual([]);
    expect(done).toBe(1);
  });

  test("a frame's variants that didn't land keep the text and say to pick again", async () => {
    const app = makeApp();
    const v = via();
    v.startVariants = () => Promise.resolve({ ok: false, reason: "page-changed" });
    let done = 0;
    const view = changeComposer(
      app,
      anchor,
      () => done++,
      { startVariants: () => Promise.reject(new Error("never")) },
      { via: v },
    );
    document.body.appendChild(view);
    trustedClick(button(view, "Variants"));
    type(editor(view), "Calmer, please");
    trustedClick(button(view, "Generate variants"));
    await flush();
    expect(done).toBe(0);
    expect(view.textContent).toContain(FRAME_PAGE_CHANGED);
    expect(editor(view).textContent).toBe("Calmer, please");
  });
});

test("a pick whose frame changed page sends nothing, keeps the text and says to pick again (2-F3)", async () => {
  const app = makeApp();
  const v = via();
  v.create = (payload, spaceId, nonce) => {
    v.calls.push({ payload, spaceId, nonce });
    return Promise.resolve({ ok: false, reason: "page-changed" });
  };
  let done = 0;
  const view = commentComposer(app, anchor, () => done++, v);
  document.body.appendChild(view);
  type(editor(view), "Is this still the plan?");
  trustedClick(button(view, "Comment"));
  await flush();
  expect(done).toBe(0);
  expect(view.textContent).toContain(FRAME_PAGE_CHANGED);
  expect(editor(view).textContent).toBe("Is this still the plan?");
  expect(FRAME_PAGE_CHANGED).toMatch(/\.$/);
});

test("the composer for a block in a frame names the frame's host beside the block label (2-F3)", async () => {
  const app = makeApp();
  const { createComposerWindow } = await import("./composer-window");
  const win2 = createComposerWindow(app, {
    startVariants: () => Promise.resolve({ ok: false }),
  });
  document.body.appendChild(win2.element);
  win2.open(
    "comment",
    { level: "element", selector: "#goal > p", snippet: "Goal" },
    null,
    undefined,
    via(),
  );
  const chips = [...win2.element.querySelectorAll(".anchor-chip")].map((c) => c.textContent);
  expect(chips).toEqual(["Goal", "tree.content.example"]);
});

test("a card beside a block inside a frame this page took in follows it when that frame scrolls (A-3)", async () => {
  const app = makeApp();
  const g = globalThis as unknown as Record<string, unknown>;
  const raf = g.requestAnimationFrame;
  const caf = g.cancelAnimationFrame;
  g.requestAnimationFrame = (cb: () => void) => setTimeout(cb, 0) as unknown as number;
  g.cancelAnimationFrame = (h: number) => clearTimeout(h);
  try {
    const { createComposerWindow } = await import("./composer-window");
    // Where the block is in this document's viewport, as `rectInOwner` gives it
    // for a block inside a srcdoc frame: the frame's own scroll moves it.
    let top = 300;
    const block = document.createElement("p");
    document.body.appendChild(block);
    const card = createComposerWindow(app, {
      startVariants: () => Promise.resolve({ ok: false }),
      blockRect: () => ({ left: 100, top }),
    });
    document.body.appendChild(card.element);
    card.open("comment", anchor, block, { x: 110, y: 310 });
    expect(card.element.style.top).toBe("310px");
    // The frame scrolled by 120px: no scroll reaches this window, content.ts says so.
    top = 180;
    card.blockMoved();
    await flush();
    expect(card.element.style.top).toBe("190px");
    expect(card.element.style.left).toBe("110px");
  } finally {
    g.requestAnimationFrame = raf;
    g.cancelAnimationFrame = caf;
  }
});

test("a pick whose frame is gone gets the same pick-again sentence and keeps the text (3-F3)", async () => {
  const app = makeApp();
  const v = via();
  v.create = () => Promise.resolve({ ok: false, reason: "no-frame" });
  let done = 0;
  const view = commentComposer(app, anchor, () => done++, v);
  document.body.appendChild(view);
  type(editor(view), "Still here?");
  trustedClick(button(view, "Comment"));
  await flush();
  expect(done).toBe(0);
  expect(view.textContent).toContain(FRAME_PAGE_CHANGED);
  expect(editor(view).textContent).toBe("Still here?");
});

test("a block in a frame without an address of its own gets Direct only, with one sentence (A-3)", async () => {
  const app = makeApp();
  const asked: unknown[] = [];
  const view = changeComposer(
    app,
    { level: "element", selector: "p#x", framePath: ["iframe#blank"] } as never,
    () => {},
    {
      startVariants: (...a) => {
        asked.push(a);
        return Promise.resolve({ ok: true });
      },
    },
  );
  document.body.appendChild(view);
  trustedClick(button(view, "Variants"));
  expect(view.textContent).toContain(FRAME_VARIANTS_NOTE);
  expect((button(view, "Generate variants") as HTMLButtonElement).disabled).toBe(true);
  type(editor(view), "Calmer");
  trustedClick(button(view, "Generate variants"));
  await flush();
  expect(asked).toEqual([]);
  trustedClick(button(view, "Direct"));
  expect(view.textContent).not.toContain(FRAME_VARIANTS_NOTE);
  expect(FRAME_VARIANTS_NOTE).toBe(
    "Variants aren't available for a block inside this frame. Choose Direct instead.",
  );
});
