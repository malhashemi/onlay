/// <reference types="chrome" />
// The follow-up round's client side: replies carry a request id that a retry
// reuses and only its own receipt settles (M-1), composers stay open with
// their text until the create lands (M-2), composer drafts survive a close
// and reopen on the same target (M-3), and the editor says where each pill
// sits (M-4). happy-dom; chrome.runtime is stubbed to capture frames.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { RawInteractionSnapshot, SpaceSummary } from "@onlay/protocol";
import { Window } from "happy-dom";
import { type AppInternals, createApp } from "./app";
import { createComposerWindow } from "./composer-window";
import { COMPOSER_NOT_SENT, changeComposer, commentComposer } from "./composers";
import { clearDraft, readRichDraft, setDraftScope, writeRichDraft } from "./drafts";
import { createInteractionModal } from "./interaction-modal";
import { createThreadPanel, REPLY_NOT_SENT } from "./thread";
import { tokenInput } from "./token-input";

const SPACE = "s_aaaaaaaaaaaaaaaaaaaa";
const PAGE = "http://127.0.0.1:8124/page.html";

let win: Window | null = null;
let sent: Array<Record<string, unknown>> = [];

function installDom(): void {
  win = new Window({ url: PAGE });
  const g = globalThis as unknown as Record<string, unknown>;
  for (const k of [
    "Element",
    "HTMLElement",
    "HTMLTextAreaElement",
    "HTMLInputElement",
    "Node",
    "Text",
    "Event",
    "KeyboardEvent",
    "MutationObserver",
  ])
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
}

beforeEach(installDom);
afterEach(() => {
  win?.happyDOM.cancelAsync();
  win?.close();
  win = null;
  delete (globalThis as unknown as Record<string, unknown>).chrome;
  setDraftScope(null);
});

const flush = () => new Promise((r) => setTimeout(r, 0));

function trustedClick(target: Element): void {
  const w = win as Window;
  const e = new w.Event("click", { bubbles: true, cancelable: true });
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
  return { app, shadow };
}

function snap(id: string): RawInteractionSnapshot {
  return {
    id,
    kind: "comment",
    url: PAGE,
    anchor: { level: "page" },
    authorId: "someone",
    participants: ["someone"],
    waitingOn: [],
    state: "open",
    thread: [{ msgId: "m1", authorId: "someone", body: { text: "root" }, ts: 0 }],
    createdAt: 0,
  } as RawInteractionSnapshot;
}

function type(box: HTMLElement, text: string): void {
  box.textContent = text;
  box.dispatchEvent(new Event("input", { bubbles: true }));
}

const button = (root: ParentNode, label: string) =>
  [...root.querySelectorAll("button")].find((b) => b.textContent === label) as HTMLElement;

describe("M-1: a reply's request id", () => {
  function mountThread() {
    const { app, shadow } = makeApp();
    const panel = createThreadPanel(app);
    shadow.appendChild(panel.element);
    app.onRender(() => panel.render());
    app._setInteractions(SPACE, [snap("c1")]);
    panel.open("c1");
    const box = () => panel.element.querySelector('[data-draft-key="reply:c1"]') as HTMLElement;
    const send = () => trustedClick(button(panel.element, "Reply"));
    const replies = () => sent.filter((f) => f.type === "interaction-reply");
    return { app, panel, box, send, replies };
  }

  test("a receipt for another tab's send never settles this one or clears its draft", async () => {
    const t = mountThread();
    type(t.box(), "mine");
    t.send();
    await flush();
    const clientId = String(t.replies()[0]?.clientId);
    expect(clientId.length).toBeGreaterThan(0);
    // Another tab sent on the same thread: its receipt reaches this tab too.
    t.app._onReceipt({ kind: "reply", interactionId: "c1", ok: true, clientId: "other-tab" });
    await flush();
    expect(t.box().textContent).toBe("mine");
    t.app._onReceipt({ kind: "reply", interactionId: "c1", ok: true, clientId });
    await flush();
    expect(t.box().textContent).toBe("");
  });

  test("a retry after a lost connection reuses the id; the next send gets a new one", async () => {
    const t = mountThread();
    type(t.box(), "hello");
    t.send();
    await flush();
    t.app._connectionLost(new Set([SPACE]));
    await flush();
    expect(t.panel.element.textContent).toContain(REPLY_NOT_SENT);
    t.send();
    await flush();
    const [first, retry] = t.replies();
    expect(retry?.clientId).toBe(first?.clientId);
    t.app._onReceipt({
      kind: "reply",
      interactionId: "c1",
      ok: true,
      clientId: String(retry?.clientId),
    });
    await flush();
    type(t.box(), "hello");
    t.send();
    await flush();
    expect(t.replies()[2]?.clientId).not.toBe(first?.clientId);
  });

  test("text typed after the send stays when its receipt lands", async () => {
    const t = mountThread();
    type(t.box(), "sent text");
    t.send();
    await flush();
    const clientId = String(t.replies()[0]?.clientId);
    type(t.box(), "sent text and more");
    t.app._onReceipt({ kind: "reply", interactionId: "c1", ok: true, clientId });
    await flush();
    expect(t.box().textContent).toBe("sent text and more");
  });
});

describe("D-2: the modal's reply keeps text written after the send", () => {
  function mountModal() {
    const { app, shadow } = makeApp();
    const modal = createInteractionModal(app, {
      load: (ref) => Promise.resolve(app.byId(ref.interactionId) ?? null),
      send: () => Promise.resolve({ ok: true }),
      onFullView: () => {},
    });
    shadow.appendChild(modal.element);
    app._setInteractions(SPACE, [snap("c1")]);
    modal.open({ interactionId: "c1", spaceId: SPACE, local: true });
    const box = () =>
      modal.element.querySelector('[data-draft-key="modal-reply:c1"]') as HTMLElement;
    const replies = () => sent.filter((f) => f.type === "interaction-reply");
    return { app, modal, box, replies };
  }

  test("a late receipt never clears newer text typed in a box rebuilt since the send", async () => {
    const t = mountModal();
    await flush();
    const first = t.box();
    type(first, "sent text");
    trustedClick(button(t.modal.element, "Reply"));
    await flush();
    const clientId = String(t.replies()[0]?.clientId);
    // Someone else posts: the modal rebuilds its reply box before the receipt.
    const next = snap("c1");
    next.thread = [
      ...next.thread,
      { msgId: "m2", authorId: "someone", body: { text: "hi" }, ts: 1 },
    ];
    t.app._setInteractions(SPACE, [next]);
    t.modal.refresh();
    await flush();
    await flush();
    const rebuilt = t.box();
    expect(rebuilt).not.toBe(first);
    type(rebuilt, "sent text and more");
    t.app._onReceipt({ kind: "reply", interactionId: "c1", ok: true, clientId });
    await flush();
    expect(readRichDraft("modal-reply:c1")?.text).toBe("sent text and more");
    expect(t.box().textContent).toBe("sent text and more");
    clearDraft("modal-reply:c1");
  });

  test("a receipt for unchanged text clears the box and its draft", async () => {
    const t = mountModal();
    await flush();
    type(t.box(), "only this");
    trustedClick(button(t.modal.element, "Reply"));
    await flush();
    const clientId = String(t.replies()[0]?.clientId);
    t.app._onReceipt({ kind: "reply", interactionId: "c1", ok: true, clientId });
    await flush();
    expect(readRichDraft("modal-reply:c1")).toBeUndefined();
    expect(t.box().textContent).toBe("");
  });
});

describe("M-2, M-3: composers keep their text until the create lands, and across a reopen", () => {
  const anchor = { level: "element" as const, selector: "main > h1" };
  const editor = (root: HTMLElement) => root.querySelector(".token-editor") as HTMLElement;

  test("a Comment stays open until its receipt; a closed socket leaves the text and the note", async () => {
    const { app } = makeApp();
    let closed = 0;
    const view = commentComposer(app, anchor, () => closed++);
    document.body.appendChild(view);
    type(editor(view), "looks off");
    trustedClick(button(view, "Comment"));
    await flush();
    expect(closed).toBe(0);
    expect(editor(view).textContent).toBe("looks off");
    app._connectionLost(new Set([SPACE]));
    await flush();
    expect(closed).toBe(0);
    expect(view.textContent).toContain(COMPOSER_NOT_SENT.comment);
    expect(editor(view).textContent).toBe("looks off");
    // Sending again is a retry of the same create: the same nonce.
    trustedClick(button(view, "Comment"));
    await flush();
    const creates = sent.filter((f) => f.type === "interaction-create");
    expect(creates).toHaveLength(2);
    expect(creates[1]?.nonce).toBe(creates[0]?.nonce);
    app._onReceipt({
      kind: "create",
      nonce: String(creates[1]?.nonce),
      interactionId: "11111111-1111-4111-8111-111111111111",
      ok: true,
    });
    await flush();
    expect(closed).toBe(1);
  });

  test("closing keeps the draft for the same target; a landed send clears it", async () => {
    const { app } = makeApp();
    const first = commentComposer(app, anchor, () => {});
    document.body.appendChild(first);
    type(editor(first), "half a thought");
    first.remove(); // closed (or the host was remounted) before sending
    const reopened = commentComposer(app, anchor, () => {});
    document.body.appendChild(reopened);
    expect(editor(reopened).textContent).toBe("half a thought");
    // Another target has its own draft.
    const elsewhere = commentComposer(app, { level: "page" }, () => {});
    expect(editor(elsewhere).textContent).toBe("");
    trustedClick(button(reopened, "Comment"));
    await flush();
    const create = sent.find((f) => f.type === "interaction-create");
    app._onReceipt({
      kind: "create",
      nonce: String(create?.nonce),
      interactionId: "11111111-1111-4111-8111-111111111111",
      ok: true,
    });
    await flush();
    const after = commentComposer(app, anchor, () => {});
    expect(editor(after).textContent).toBe("");
  });

  test("Cancel drops the draft", () => {
    const { app } = makeApp();
    const view = commentComposer(app, anchor, () => {});
    document.body.appendChild(view);
    type(editor(view), "never mind");
    trustedClick(button(view, "Cancel"));
    expect(editor(commentComposer(app, anchor, () => {})).textContent).toBe("");
  });

  test("an Edit's draft survives a reopen too", () => {
    const { app } = makeApp();
    const hooks = { startVariants: () => Promise.resolve({ ok: true }) };
    const view = changeComposer(app, anchor, () => {}, hooks);
    type(editor(view), "make it bigger");
    const again = changeComposer(app, anchor, () => {}, hooks);
    expect(editor(again).textContent).toBe("make it bigger");
  });

  test("Variants keeps the composer open until the set lands, and says so when it doesn't", async () => {
    const { app } = makeApp();
    let settle: (r: { ok: boolean; reason?: string }) => void = () => {};
    const hooks = {
      startVariants: () =>
        new Promise<{ ok: boolean; reason?: string }>((r) => {
          settle = r;
        }),
    };
    let closed = 0;
    const view = changeComposer(app, anchor, () => closed++, hooks);
    document.body.appendChild(view);
    trustedClick(button(view, "Variants"));
    type(editor(view), "three takes");
    trustedClick(button(view, "Generate variants"));
    await flush();
    expect(closed).toBe(0);
    settle({ ok: false, reason: "closed" });
    await flush();
    expect(closed).toBe(0);
    expect(view.textContent).toContain(COMPOSER_NOT_SENT.edit);
    expect(editor(view).textContent).toBe("three takes");
    trustedClick(button(view, "Generate variants"));
    await flush();
    settle({ ok: true });
    await flush();
    expect(closed).toBe(1);
  });
});

describe("M-4: the editor says where each pill sits", () => {
  test("spans count from the trimmed text", () => {
    const { app } = makeApp();
    app._setDirectory(SPACE, [{ id: "bea", name: "Bea", tint: "#111", initials: "BE" }]);
    // Pills as the editor mints them, restored through the draft store.
    writeRichDraft("lead", {
      text: "   hi @Bea and @agent",
      tokens: [{ t: "actor", actorId: "bea" }, { t: "agent" }],
    });
    const ti = tokenInput(app, "x", { draftKey: "lead" });
    document.body.appendChild(ti.wrap);
    const v = ti.value();
    expect(v.text).toBe("hi @Bea and @agent");
    expect(v.tokens).toEqual([
      { t: "actor", actorId: "bea", spans: [{ start: 3, length: 4 }] },
      { t: "agent", spans: [{ start: 12, length: 6 }] },
    ]);
    clearDraft("lead");
  });
});

/* ── second pass ─────────────────────────────────────────────────────── */

const anchorT = { level: "element" as const, selector: "main > h1" };
const editorIn = (root: HTMLElement) => root.querySelector(".token-editor") as HTMLElement;
const createsSent = () => sent.filter((f) => f.type === "interaction-create");

describe("2-M1: a draft belongs to an account", () => {
  test("the next account on the tab finds none of the last one's drafts, even back on the first", () => {
    const { app } = makeApp();
    setDraftScope(`alice|https://app.onlay.dev`);
    const view = commentComposer(app, anchorT, () => {});
    type(editorIn(view), "alice's unsent words");
    writeRichDraft("reply:c1", { text: "alice's reply" });
    setDraftScope(`bob|https://app.onlay.dev`);
    expect(editorIn(commentComposer(app, anchorT, () => {})).textContent).toBe("");
    expect(readRichDraft("reply:c1")).toBeUndefined();
    setDraftScope(`alice|https://app.onlay.dev`);
    expect(editorIn(commentComposer(app, anchorT, () => {})).textContent).toBe("");
  });

  test("another server origin is another account", () => {
    setDraftScope(`alice|https://app.onlay.dev`);
    writeRichDraft("reply:c1", { text: "on one server" });
    setDraftScope(`alice|http://localhost:8787`);
    expect(readRichDraft("reply:c1")).toBeUndefined();
  });
});

describe("2-M2: only the composer that sent may finish the send", () => {
  test("a landed send leaves a newer draft typed in a reopened composer", async () => {
    const { app } = makeApp();
    const first = commentComposer(app, anchorT, () => {});
    document.body.appendChild(first);
    type(editorIn(first), "sent words");
    trustedClick(button(first, "Comment"));
    await flush();
    first.remove(); // closed, or the host was remounted, before the receipt
    const again = commentComposer(app, anchorT, () => {});
    document.body.appendChild(again);
    type(editorIn(again), "sent words, and then some");
    app._onReceipt({
      kind: "create",
      nonce: String(createsSent()[0]?.nonce),
      interactionId: "11111111-1111-4111-8111-111111111111",
      ok: true,
    });
    await flush();
    expect(editorIn(again).textContent).toBe("sent words, and then some");
    expect(editorIn(commentComposer(app, anchorT, () => {})).textContent).toBe(
      "sent words, and then some",
    );
  });

  test("an unedited reopened composer's draft goes with the send that landed", async () => {
    const { app } = makeApp();
    const first = commentComposer(app, anchorT, () => {});
    document.body.appendChild(first);
    type(editorIn(first), "sent words");
    trustedClick(button(first, "Comment"));
    await flush();
    first.remove();
    app._onReceipt({
      kind: "create",
      nonce: String(createsSent()[0]?.nonce),
      interactionId: "11111111-1111-4111-8111-111111111111",
      ok: true,
    });
    await flush();
    expect(editorIn(commentComposer(app, anchorT, () => {})).textContent).toBe("");
  });

  test("an old send landing never closes the composer opened after it", async () => {
    const { app, shadow } = makeApp();
    const win = createComposerWindow(app, { startVariants: async () => ({ ok: true }) });
    shadow.appendChild(win.element);
    win.open("comment", anchorT, null);
    type(editorIn(win.element), "first");
    trustedClick(button(win.element, "Comment"));
    await flush();
    win.close();
    win.open("comment", { level: "page" }, null);
    app._onReceipt({
      kind: "create",
      nonce: String(createsSent()[0]?.nonce),
      interactionId: "11111111-1111-4111-8111-111111111111",
      ok: true,
    });
    await flush();
    expect(win.isOpen()).toBe(true);
  });
});

describe("2-M3: each unconfirmed create keeps its own nonce", () => {
  test("a different Comment sent in between never takes the first one's nonce", async () => {
    const { app } = makeApp();
    const send = async (anchor: typeof anchorT | { level: "page" }, text: string) => {
      const view = commentComposer(app, anchor, () => {});
      document.body.appendChild(view);
      type(editorIn(view), text);
      trustedClick(button(view, "Comment"));
      await flush();
      app._connectionLost(new Set([SPACE]));
      await flush();
      view.remove();
    };
    await send(anchorT, "first");
    await send({ level: "page" }, "second");
    await send(anchorT, "first, edited");
    await send(anchorT, "first");
    const nonces = createsSent().map((f) => f.nonce);
    expect(new Set(nonces.slice(0, 3)).size).toBe(3);
    expect(nonces[3]).toBe(nonces[0]);
  });
});

describe("2-M4: drafts keep pill positions", () => {
  test("a stored draft rebuilds its pill from the span, not from a copy of the name", () => {
    const { app } = makeApp();
    app._setDirectory(SPACE, [{ id: "bea", name: "Bea", tint: "#111", initials: "BE" }]);
    writeRichDraft("pos", {
      text: "mail a@Bea.example, @Bea-approved",
      tokens: [{ t: "actor", actorId: "bea", spans: [{ start: 20, length: 4 }] }],
    });
    const first = tokenInput(app, "x", { draftKey: "pos" });
    document.body.appendChild(first.wrap);
    expect(first.input.firstChild?.textContent).toBe("mail a@Bea.example, ");
    expect(first.value().tokens).toEqual([
      { t: "actor", actorId: "bea", spans: [{ start: 20, length: 4 }] },
    ]);
    // Typing re-persists the draft with the span; a rebuild finds the pill there again.
    first.input.append(document.createTextNode(" ok"));
    first.input.dispatchEvent(new Event("input", { bubbles: true }));
    expect(readRichDraft("pos")?.tokens).toEqual([
      { t: "actor", actorId: "bea", spans: [{ start: 20, length: 4 }] },
    ]);
    const second = tokenInput(app, "x", { draftKey: "pos" });
    expect(second.input.firstChild?.textContent).toBe("mail a@Bea.example, ");
    clearDraft("pos");
  });

  test("a message opened for editing places each of a token's pills from its spans", () => {
    const { app } = makeApp();
    app._setDirectory(SPACE, [{ id: "bea", name: "Bea", tint: "#111", initials: "BE" }]);
    // A sent message's shape: one token, a span per pill; the middle `@Bea` was typed.
    writeRichDraft("edit", {
      text: "@Bea said @Bea, ask @Bea",
      tokens: [
        {
          t: "actor",
          actorId: "bea",
          spans: [
            { start: 0, length: 4 },
            { start: 20, length: 4 },
          ],
        },
      ],
    });
    const ti = tokenInput(app, "x", { draftKey: "edit" });
    const pills = [...ti.input.querySelectorAll("[data-token]")];
    expect(pills).toHaveLength(2);
    expect(ti.input.childNodes[1]?.textContent).toBe(" said @Bea, ask ");
    clearDraft("edit");
  });
});

/* ── third pass ──────────────────────────────────────────────────────── */

describe("3-M1: the first account after a page load adopts what was typed before it", () => {
  test("a draft written before the first status stays; leaving that account drops it", () => {
    setDraftScope(null);
    writeRichDraft("reply:early", { text: "typed before the status came" });
    setDraftScope("alice|https://app.onlay.dev");
    expect(readRichDraft("reply:early")?.text).toBe("typed before the status came");
    setDraftScope("bob|https://app.onlay.dev");
    expect(readRichDraft("reply:early")).toBeUndefined();
  });
});

describe("3-M3: a thread reply's late receipt never clears newer text", () => {
  test("after a remount, text typed in the new reply box survives the old send's receipt", async () => {
    const { app, shadow } = makeApp();
    app._setInteractions(SPACE, [snap("c1")]);
    const before = createThreadPanel(app);
    shadow.appendChild(before.element);
    before.open("c1");
    const boxIn = (p: ReturnType<typeof createThreadPanel>) =>
      p.element.querySelector('[data-draft-key="reply:c1"]') as HTMLElement;
    type(boxIn(before), "sent words");
    trustedClick(button(before.element, "Reply"));
    await flush();
    const clientId = String(sent.find((f) => f.type === "interaction-reply")?.clientId);
    // The host moved: the panel is made afresh and the person keeps typing there.
    before.close();
    before.element.remove();
    const after = createThreadPanel(app);
    shadow.appendChild(after.element);
    after.open("c1");
    expect(boxIn(after).textContent).toBe("sent words");
    type(boxIn(after), "sent words, and more");
    app._onReceipt({ kind: "reply", interactionId: "c1", ok: true, clientId });
    await flush();
    expect(readRichDraft("reply:c1")?.text).toBe("sent words, and more");
    after.render();
    expect(boxIn(after).textContent).toBe("sent words, and more");
  });
});

describe("3-M5: a pill restored from a span reads what was there", () => {
  test("before the space's people load, the pill shows its own text, not a stand-in", () => {
    const { app } = makeApp();
    writeRichDraft("early-pill", {
      text: "ask @Bea Quinn now",
      tokens: [{ t: "actor", actorId: "p_unknown", spans: [{ start: 4, length: 10 }] }],
    });
    const ti = tokenInput(app, "x", { draftKey: "early-pill" });
    const pill = ti.input.querySelector("[data-token]");
    expect(pill?.textContent).toBe("@Bea Quinn");
    expect(ti.value()).toEqual({
      text: "ask @Bea Quinn now",
      tokens: [{ t: "actor", actorId: "p_unknown", spans: [{ start: 4, length: 10 }] }],
    });
    clearDraft("early-pill");
  });
});
