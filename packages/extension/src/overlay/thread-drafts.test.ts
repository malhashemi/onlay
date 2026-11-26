/// <reference types="chrome" />
// Regression: an incoming `interactions-state` frame re-renders the thread
// panel (full body teardown + rebuild). The in-progress reply draft — its
// text, caret, and focus — must survive that rebuild, while newly arrived
// messages still appear live. The reply box is a token editor
// (contenteditable, token-input.ts); the caret is a character offset.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { RawInteractionSnapshot, RawThreadMsg } from "@onlay/protocol";
import { Window } from "happy-dom";
import { type AppInternals, createApp } from "./app";
import { caretOffset, selectionIn, setCaretOffset } from "./caret";
import { preserveFocus } from "./drafts";
import { createThreadPanel } from "./thread";
import { serializeEditor } from "./token-input";

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

function mountThread(): {
  app: ReturnType<typeof createApp> & AppInternals;
  panel: ReturnType<typeof createThreadPanel>;
  shadow: ShadowRoot;
} {
  const host = document.createElement("div");
  document.body.appendChild(host);
  const shadow = host.attachShadow({ mode: "open" });
  const app = createApp({
    shadow,
    host,
    isTopFrame: true,
    toast: () => {},
  }) as ReturnType<typeof createApp> & AppInternals;
  const panel = createThreadPanel(app);
  shadow.appendChild(panel.element);
  // mirror content.ts's render dispatch, focus-preserving wrapper included
  app.onRender(() => preserveFocus(shadow, () => panel.render()));
  return { app, panel, shadow };
}

function replyBox(panel: ReturnType<typeof createThreadPanel>): HTMLElement {
  const box = panel.element.querySelector('[data-draft-key="reply:c1"]');
  if (!box) throw new Error("reply box missing");
  return box as HTMLElement;
}

function typeInto(box: HTMLElement, text: string): void {
  box.textContent = text;
  box.dispatchEvent(new Event("input", { bubbles: true }));
}

describe("thread reply draft survives state frames", () => {
  test("in-progress reply text and new messages both persist", () => {
    const { app, panel } = mountThread();
    app._setInteractions(SPACE, [snap("c1", [msg("m1", "first")])]);
    panel.open("c1");

    const box = replyBox(panel);
    typeInto(box, "my careful draft");
    box.focus();

    // an incoming frame carrying a brand-new message
    app._setInteractions(SPACE, [
      snap("c1", [msg("m1", "first"), msg("m2", "second live message")]),
    ]);

    const after = replyBox(panel);
    expect(after.textContent).toBe("my careful draft");
    expect(panel.element.textContent).toContain("second live message");
  });

  test("focus and caret return to the reply box after a rebuild", () => {
    const { app, panel, shadow } = mountThread();
    app._setInteractions(SPACE, [snap("c1", [msg("m1", "first")])]);
    panel.open("c1");

    const box = replyBox(panel);
    typeInto(box, "abcdef");
    box.focus();
    setCaretOffset(box, 3);

    app._setInteractions(SPACE, [snap("c1", [msg("m1", "first"), msg("m2", "second")])]);

    const after = replyBox(panel);
    expect(shadow.activeElement).toBe(after as unknown as Element);
    expect(caretOffset(after)).toBe(3);
  });

  test("a multi-line draft with pills keeps its caret through a rebuild", () => {
    const { app, panel, shadow } = mountThread();
    app._setInteractions(SPACE, [snap("c1", [msg("m1", "first")])]);
    panel.open("c1");

    // What the editor holds after typing "one", Shift+Enter, an @agent pill,
    // " two", Shift+Enter: each break a <br>, and the last one followed by the
    // placeholder <br> token-input keeps after a break that ends the text.
    const box = replyBox(panel);
    const pill = document.createElement("span");
    pill.setAttribute("data-token", "agent");
    pill.setAttribute("contenteditable", "false");
    pill.textContent = "@agent";
    box.replaceChildren(
      document.createTextNode("one"),
      document.createElement("br"),
      pill,
      document.createTextNode(" two"),
      document.createElement("br"),
      document.createElement("br"),
    );
    box.dispatchEvent(new Event("input", { bubbles: true }));
    box.focus();
    const wire = serializeEditor(box).text;
    expect(wire).toBe("one\n@agent two\n");

    // Each place a caret can be, text and element boundaries alike, comes back
    // at the same wire offset, and the text before it is what it was.
    const twoNode = box.childNodes[3] as Text;
    const places: Array<[Node, number, number]> = [
      [twoNode, 2, "one\n@agent t".length],
      [box, 2, "one\n".length], // just after the first break, before the pill
      [box, 5, wire.length], // between the last break and the placeholder
    ];
    for (const [node, off, expected] of places) {
      const sel = selectionIn(box);
      const range = document.createRange();
      range.setStart(node, off);
      range.collapse(true);
      sel?.removeAllRanges();
      sel?.addRange(range);
      expect(caretOffset(box)).toBe(expected);
    }

    for (const [, , expected] of places) {
      const before = replyBox(panel);
      before.focus();
      setCaretOffset(before, expected);
      app._setInteractions(SPACE, [
        snap("c1", [msg("m1", "first"), msg(`m-${expected}`, "incoming")]),
      ]);
      const after = replyBox(panel);
      expect(shadow.activeElement).toBe(after as unknown as Element);
      expect(serializeEditor(after).text).toBe(wire);
      expect(caretOffset(after)).toBe(expected);
    }
  });

  test("resolved-out-from-under keeps a live follow-through composer (F-047)", () => {
    const { app, panel } = mountThread();
    app._setInteractions(SPACE, [snap("c1", [msg("m1", "first")])]);
    panel.open("c1");

    const box = replyBox(panel);
    typeInto(box, "stranded thoughts");

    // the interaction resolves remotely mid-draft — the thread outlives the
    // resolution, so the composer stays and the draft rides along
    const resolved = { ...snap("c1", [msg("m1", "first")]), state: "resolved" };
    app._setInteractions(SPACE, [resolved as RawInteractionSnapshot]);

    const after = replyBox(panel);
    expect(after.textContent).toBe("stranded thoughts");
    // resolving is a live-state act: the Resolve button is gone, Follow up remains
    const labels = [...panel.element.querySelectorAll("button")].map((b) => b.textContent);
    expect(labels).toContain("Follow up");
    expect(labels.filter((l) => l === "Resolve")).toEqual([]);
  });

  test("terminal-out-from-under (dropped) strands the unsent draft visibly", () => {
    const { app, panel } = mountThread();
    app._setInteractions(SPACE, [snap("c1", [msg("m1", "first")])]);
    panel.open("c1");

    const box = replyBox(panel);
    typeInto(box, "stranded thoughts");

    // dropped/superseded ARE terminal: no composer, text survives read-only
    const dropped = { ...snap("c1", [msg("m1", "first")]), state: "dropped" };
    app._setInteractions(SPACE, [dropped as RawInteractionSnapshot]);

    expect(panel.element.querySelector('[data-draft-key="reply:c1"]')).toBeNull();
    expect(panel.element.textContent).toContain("This thread was closed");
    const kept = panel.element.querySelector("textarea");
    expect((kept as HTMLTextAreaElement | null)?.value).toBe("stranded thoughts");
  });
});
