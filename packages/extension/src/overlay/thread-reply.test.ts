/// <reference types="chrome" />
// ADR-0018 in the thread panel: reply-to quote chips (render · reveal ·
// cancel · send) and optimistic reaction toggles (instant paint, revert on a
// failed send). happy-dom; chrome.runtime is stubbed to capture frames.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { RawInteractionSnapshot, RawThreadMsg } from "@onlay/protocol";
import { Window } from "happy-dom";
import { type AppInternals, createApp } from "./app";
import { createThreadPanel } from "./thread";

const SPACE = "s_aaaaaaaaaaaaaaaaaaaa";

let win: Window | null = null;
let sent: Array<Record<string, unknown>> = [];
let sendResult: { ok: boolean; error?: string } = { ok: true };
let toasts: string[] = [];

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
  g.location = win.location; // app.send stamps frameUrl from location.href
  sent = [];
  sendResult = { ok: true };
  toasts = [];
  g.chrome = {
    runtime: {
      sendMessage: (m: Record<string, unknown>) => {
        sent.push(m);
        return Promise.resolve(sendResult);
      },
    },
  };
}

beforeEach(installDom);
afterEach(() => {
  win?.happyDOM.cancelAsync();
  win?.close();
  win = null;
  delete (globalThis as unknown as Record<string, unknown>).chrome;
});

const flush = () => new Promise((r) => setTimeout(r, 0));

function msg(msgId: string, text: string, over: Partial<RawThreadMsg> = {}): RawThreadMsg {
  return { msgId, authorId: "someone", body: { text }, ts: Date.now(), ...over };
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
    toast: (t) => toasts.push(t),
  }) as ReturnType<typeof createApp> & AppInternals;
  app._setSelf({ id: "me", name: "Me", tint: "#333", initials: "ME" });
  const panel = createThreadPanel(app);
  shadow.appendChild(panel.element);
  app.onRender(() => panel.render());
  return { app, panel };
}

/** happy-dom events carry no isTrusted; the send/react handlers gate on it. */
function trustedClick(target: Element): void {
  const w = win as Window;
  const e = new w.Event("click", { bubbles: true, cancelable: true });
  Object.defineProperty(e, "isTrusted", { value: true });
  target.dispatchEvent(e as unknown as Event);
}

function q(panel: ReturnType<typeof createThreadPanel>, sel: string): HTMLElement | null {
  return panel.element.querySelector(sel) as HTMLElement | null;
}
function qa(panel: ReturnType<typeof createThreadPanel>, sel: string): HTMLElement[] {
  return [...panel.element.querySelectorAll(sel)] as HTMLElement[];
}

describe("reply-to quote chips (ADR-0018 §1)", () => {
  test("a message with replyTo renders a derived quote: author + first line", () => {
    const { app, panel } = mountThread();
    app._setInteractions(SPACE, [
      snap("c1", [
        msg("m1", "the root question\nwith a second line"),
        msg("m2", "answering it", { authorId: "me", replyTo: { msgId: "m1" } }),
      ]),
    ]);
    panel.open("c1");
    const chip = q(panel, ".quote-chip");
    expect(chip).not.toBeNull();
    expect(chip?.textContent).toContain("Someone: the root question");
    expect(chip?.textContent).not.toContain("second line");
  });

  test("a deleted or missing target renders 'original message removed'", () => {
    const { app, panel } = mountThread();
    app._setInteractions(SPACE, [
      snap("c1", [
        msg("m1", "", { deleted: true }),
        msg("m2", "re: gone", { replyTo: { msgId: "m1" } }),
        msg("m3", "re: never-was", { replyTo: { msgId: "m0" } }),
      ]),
    ]);
    panel.open("c1");
    const missing = qa(panel, ".quote-chip.missing");
    expect(missing.length).toBe(2);
    expect(missing[0]?.textContent).toBe("original message removed");
  });

  test("clicking a quote chip flashes the target message", () => {
    const { app, panel } = mountThread();
    app._setInteractions(SPACE, [
      snap("c1", [msg("m1", "root"), msg("m2", "reply", { replyTo: { msgId: "m1" } })]),
    ]);
    panel.open("c1");
    q(panel, ".quote-chip")?.click();
    const target = q(panel, '[data-msg-id="m1"]');
    expect(target?.classList.contains("flash")).toBe(true);
  });

  test("the reply affordance pins a dismissible quote above the box; × cancels", () => {
    const { app, panel } = mountThread();
    app._setInteractions(SPACE, [snap("c1", [msg("m1", "root message")])]);
    panel.open("c1");
    expect(q(panel, ".quote-chip")).toBeNull();

    const replyAct = qa(panel, ".msg-act").find((b) => b.textContent === "reply");
    expect(replyAct).toBeDefined();
    replyAct?.click();
    const chip = q(panel, ".quote-chip");
    expect(chip?.textContent).toContain("Someone: root message");

    q(panel, ".quote-cancel")?.click();
    expect(q(panel, ".quote-chip")).toBeNull();
  });

  test("sending carries replyTo and clears the pending quote", async () => {
    const { app, panel } = mountThread();
    app._setInteractions(SPACE, [snap("c1", [msg("m1", "root message")])]);
    panel.open("c1");
    qa(panel, ".msg-act")
      .find((b) => b.textContent === "reply")
      ?.click();

    const box = q(panel, '[data-draft-key="reply:c1"]');
    if (!box) throw new Error("reply box missing");
    box.textContent = "my answer";
    box.dispatchEvent(new Event("input", { bubbles: true }));

    const send = qa(panel, "button").find((b) => b.textContent === "Reply");
    if (!send) throw new Error("send button missing");
    trustedClick(send);
    await flush();

    const frame = sent.find((f) => f.type === "interaction-reply");
    expect(frame).toMatchObject({
      type: "interaction-reply",
      interactionId: "c1",
      replyTo: { msgId: "m1" },
    });
    // The draft and the quote stay until the server's receipt (3b-C10)…
    expect(q(panel, ".quote-chip")).not.toBeNull();
    app._onReceipt({
      type: "interaction-receipt",
      kind: "reply",
      interactionId: "c1",
      ok: true,
    } as never);
    await flush();
    // …then both go.
    expect(q(panel, ".quote-chip")).toBeNull();
    expect(q(panel, '[data-draft-key="reply:c1"]')?.textContent).toBe("");
  });

  test("a reply whose socket closes before its receipt stays in the editor with a note (3b-C10)", async () => {
    const { app, panel } = mountThread();
    app._setInteractions(SPACE, [snap("c1", [msg("m1", "root message")])]);
    panel.open("c1");
    const box = q(panel, '[data-draft-key="reply:c1"]');
    if (!box) throw new Error("reply box missing");
    box.textContent = "keep me";
    box.dispatchEvent(new Event("input", { bubbles: true }));
    const send = qa(panel, "button").find((b) => b.textContent === "Reply");
    if (!send) throw new Error("send button missing");
    trustedClick(send);
    await flush();
    expect(sent.some((f) => f.type === "interaction-reply")).toBe(true);
    app._connectionLost(new Set([SPACE]));
    await flush();
    expect(q(panel, '[data-draft-key="reply:c1"]')?.textContent).toBe("keep me");
    expect(panel.element.textContent).toContain(
      "Your reply wasn't sent. Check your connection, then send it again.",
    );
  });
});

describe("optimistic reactions (ADR-0018 §4)", () => {
  test("a quick-add click paints immediately (chip on, pop) and sends the frame", async () => {
    const { app, panel } = mountThread();
    const m = msg("m1", "root");
    app._setInteractions(SPACE, [snap("c1", [m])]);
    panel.open("c1");
    expect(qa(panel, ".reactions > .react").length).toBe(0);

    const bar = qa(panel, ".react-bar .react");
    expect(bar[0]?.title).toBe("react — counts as seen");
    if (!bar[0]) throw new Error("quick-add bar missing");
    trustedClick(bar[0]); // 👍

    // painted BEFORE any server frame came back
    const chip = q(panel, ".reactions > .react.on");
    expect(chip?.textContent).toBe("👍1");
    expect(q(panel, ".react.pop")).not.toBeNull();
    expect(m.reactions?.["👍"]).toEqual(["me"]);

    await flush();
    const frame = sent.find((f) => f.type === "interaction-react");
    expect(frame).toMatchObject({ type: "interaction-react", msgId: "m1", emoji: "👍", on: true });
  });

  test("clicking an on-chip toggles off optimistically", () => {
    const { app, panel } = mountThread();
    const m = msg("m1", "root", { reactions: { "👍": ["me", "someone"] } });
    app._setInteractions(SPACE, [snap("c1", [m])]);
    panel.open("c1");
    const chip = q(panel, ".reactions > .react.on");
    if (!chip) throw new Error("on-chip missing");
    trustedClick(chip);
    // instantly repainted: count down, no longer own
    const after = q(panel, ".reactions > .react");
    expect(after?.classList.contains("on")).toBe(false);
    expect(after?.textContent).toBe("👍1");
  });

  test("a failed send reverts the paint and toasts", async () => {
    const { app, panel } = mountThread();
    sendResult = { ok: false, error: "sw-unreachable" };
    const m = msg("m1", "root");
    app._setInteractions(SPACE, [snap("c1", [m])]);
    panel.open("c1");

    const bar = qa(panel, ".react-bar .react");
    if (!bar[0]) throw new Error("quick-add bar missing");
    trustedClick(bar[0]);
    expect(q(panel, ".reactions > .react.on")).not.toBeNull(); // optimistic

    await flush();
    expect(q(panel, ".reactions > .react.on")).toBeNull(); // reverted
    expect(m.reactions).toBeUndefined();
    expect(toasts).toContain("reaction not sent");
  });
});
