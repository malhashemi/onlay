/// <reference types="chrome" />
// The manual batch tray's draft semantics: unsent edits apply as indicative
// previews, and DISMISSING the tray (the one Close action; Esc matches)
// discards them — the page comes back exactly as it was. Send remains the
// only way edits survive. happy-dom.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Window } from "happy-dom";
import type { App } from "./app";
import { BATCH_COPY, batchFits, createBatchTray } from "./batch";

let win: Window | null = null;

function installDom(): void {
  win = new Window({ url: "http://127.0.0.1:8124/page.html" });
  const g = globalThis as unknown as Record<string, unknown>;
  g.window = win;
  g.document = win.document;
  g.Element = win.Element;
  g.HTMLElement = win.HTMLElement;
  g.Node = win.Node;
  g.Event = win.Event;
  g.KeyboardEvent = win.KeyboardEvent;
}

beforeEach(installDom);
afterEach(() => {
  win?.happyDOM.cancelAsync();
  win?.close();
  win = null;
});

function stubApp(): App {
  return {
    toast: () => {},
    composeSpaces: () => [],
    currentSpaceId: () => "s_aaaaaaaaaaaaaaaaaaaa",
    setCurrentSpace: () => {},
    createInteraction: () => Promise.resolve({ ok: true, interactionId: "x" }),
    send: () => Promise.resolve({ ok: true }),
    frameUrl: () => "https://site.test/page",
  } as unknown as App;
}

function mountTray() {
  const tray = createBatchTray(stubApp());
  document.body.appendChild(tray.element);
  const target = document.createElement("p");
  target.textContent = "original words";
  document.body.appendChild(target);
  return { tray, target };
}

describe("batch tray — dismissal discards the draft", () => {
  test("a committed text edit previews on the page; dismiss restores it and closes", () => {
    const { tray, target } = mountTray();
    tray.setOpen(true);
    tray.beginTextEdit(target);
    target.textContent = "rewritten words";
    target.dispatchEvent(new (win as Window).Event("blur") as unknown as Event);
    expect(tray.opCount()).toBe(1);
    expect(target.textContent).toBe("rewritten words"); // indicative preview

    tray.dismiss();
    expect(target.textContent).toBe("original words"); // page restored
    expect(tray.opCount()).toBe(0);
    expect(tray.isOpen()).toBe(false);
  });

  test("a removal previews as display:none; dismiss brings the block back", () => {
    const { tray, target } = mountTray();
    tray.setOpen(true);
    tray.addRemoval(target);
    expect(target.style.display).toBe("none");

    tray.dismiss();
    expect(target.style.display).toBe("");
    expect(tray.opCount()).toBe(0);
  });

  test("one close control: a Close button, no competing Clear", () => {
    const { tray } = mountTray();
    tray.setOpen(true);
    const labels = [...tray.element.querySelectorAll("button")].map((b) => b.textContent);
    expect(labels).toContain("Close");
    expect(labels).not.toContain("Clear");
  });

  test("the Close button IS dismiss: it unwinds previews", () => {
    const { tray, target } = mountTray();
    tray.setOpen(true);
    tray.addRemoval(target);
    const close = [...tray.element.querySelectorAll("button")].find(
      (b) => b.textContent === "Close",
    );
    close?.click();
    expect(target.style.display).toBe("");
    expect(tray.isOpen()).toBe(false);
  });
});

describe("batch tray — exact restoration", () => {
  test("dismiss restores INLINE MARKUP, not just the text", () => {
    const { tray } = mountTray();
    const target = document.createElement("p");
    const strong = document.createElement("strong");
    strong.textContent = "bold";
    target.append("plain ", strong, " tail");
    document.body.appendChild(target);

    tray.setOpen(true);
    tray.beginTextEdit(target);
    target.textContent = "flattened rewrite";
    target.dispatchEvent(new (win as Window).Event("blur") as unknown as Event);
    expect(tray.opCount()).toBe(1);

    tray.dismiss();
    expect(target.textContent).toBe("plain bold tail");
    expect(target.querySelector("strong")?.textContent).toBe("bold"); // markup back
  });

  test("cancelling mid-edit restores markup even when the text is unchanged", () => {
    const { tray } = mountTray();
    const target = document.createElement("p");
    const link = document.createElement("a");
    link.textContent = "anchor";
    target.append(link);
    document.body.appendChild(target);

    tray.setOpen(true);
    tray.beginTextEdit(target);
    // simulate an edit session that flattened the DOM without changing text
    target.textContent = "anchor";
    tray.cancelEdit();
    expect(target.querySelector("a")?.textContent).toBe("anchor");
    expect(target.getAttribute("contenteditable")).toBeNull();
  });
});

describe("batch tray — sending", () => {
  function trustedClick(el: Element): void {
    const e = new (win as Window).MouseEvent("click", { bubbles: true }) as unknown as Event;
    Object.defineProperty(e, "isTrusted", { value: true });
    el.dispatchEvent(e);
  }
  const flushAll = () => new Promise((r) => setTimeout(r, 0));

  function rig(opts: { receipt: { ok: boolean; error?: string } }) {
    const creates: Array<Record<string, unknown>> = [];
    let resolveReceipt: (r: { ok: boolean; error?: string }) => void = () => {};
    const app = {
      ...stubApp(),
      createInteraction: (payload: Record<string, unknown>) => {
        creates.push(payload);
        return Promise.resolve({ ok: true, interactionId: "x" });
      },
      awaitReceipt: () =>
        new Promise<{ ok: boolean; error?: string }>((r) => {
          resolveReceipt = r;
        }),
    } as unknown as App;
    const tray = createBatchTray(app);
    document.body.appendChild(tray.element);
    const target = document.createElement("p");
    target.textContent = "original words";
    document.body.appendChild(target);
    tray.setOpen(true);
    tray.addRemoval(target);
    const send = [...tray.element.querySelectorAll("button")].find(
      (b) => b.textContent === "Send edits",
    ) as HTMLButtonElement;
    return {
      tray,
      target,
      creates,
      send,
      receipt: () => resolveReceipt(opts.receipt),
    };
  }

  test("a stamped page's batch carries the document's provenance", async () => {
    document.documentElement.setAttribute(
      "data-onlay-provenance",
      "github.com/acme/site@abc;main;clean",
    );
    const r = rig({ receipt: { ok: true } });
    trustedClick(r.send);
    await flushAll();
    expect((r.creates[0]?.change as { provenance?: string }).provenance).toBe(
      "github.com/acme/site@abc;main;clean",
    );
    document.documentElement.removeAttribute("data-onlay-provenance");
  });

  test("the undo records stay until the receipt; a refused batch keeps the draft", async () => {
    const r = rig({ receipt: { ok: false, error: "conflict" } });
    trustedClick(r.send);
    await flushAll();
    expect(r.tray.opCount()).toBe(1); // sent, not yet received
    r.receipt();
    await flushAll();
    expect(r.tray.opCount()).toBe(1);
    expect(r.target.style.display).toBe("none");
    r.tray.dismiss();
    expect(r.target.style.display).toBe("");
  });

  test("a batch that goes to an agent takes the tray's temporary edits off the page", async () => {
    document.documentElement.setAttribute(
      "data-onlay-provenance",
      "github.com/acme/site@abc;main;clean",
    );
    const r = rig({ receipt: { ok: true } });
    trustedClick(r.send);
    await flushAll();
    expect(r.target.style.display).toBe("none");
    r.receipt();
    await flushAll();
    expect(r.tray.opCount()).toBe(0);
    expect(r.target.style.display).toBe("");
    document.documentElement.removeAttribute("data-onlay-provenance");
  });
});

describe("batch tray — limits, retries, and a kept entry that never comes (R2-C12)", () => {
  function trusted(el: Element): void {
    const e = new (win as Window).MouseEvent("click", { bubbles: true }) as unknown as Event;
    Object.defineProperty(e, "isTrusted", { value: true });
    el.dispatchEvent(e);
  }
  const flushAll = () => new Promise((r) => setTimeout(r, 0));

  test("a batch too big for one frame is refused before any Edit is created", async () => {
    let creates = 0;
    const app = {
      ...stubApp(),
      createInteraction: () => {
        creates += 1;
        return Promise.resolve({ ok: true, interactionId: "x" });
      },
    } as unknown as App;
    const tray = createBatchTray(app);
    document.body.appendChild(tray.element);
    for (let i = 0; i < 40; i += 1) {
      const p = document.createElement("p");
      p.textContent = "original";
      document.body.appendChild(p);
      tray.beginTextEdit(p);
      p.textContent = "x".repeat(600);
      p.dispatchEvent(new (win as Window).Event("blur") as unknown as Event);
    }
    const send = [...tray.element.querySelectorAll("button")].find(
      (b) => b.textContent === "Send edits",
    );
    trusted(send as HTMLButtonElement);
    await flushAll();
    expect(creates).toBe(0);
    expect(tray.element.textContent).toContain(BATCH_COPY.tooMany);
  });

  test("batchFits measures the frame and the program", () => {
    expect(batchFits([{ op: "setText", target: "p", text: "hi" }], "https://a.test/", "s_x")).toBe(
      true,
    );
    const big = Array.from({ length: 30 }, () => ({
      op: "setText" as const,
      target: "p",
      text: "y".repeat(800),
    }));
    expect(batchFits(big, "https://a.test/", "s_x")).toBe(false);
  });

  test("a failed send retries into the same Edit", async () => {
    const created: string[] = [];
    const sentTo: string[] = [];
    let receipts = 0;
    const app = {
      ...stubApp(),
      createInteraction: () => {
        created.push("edit-1");
        return Promise.resolve({ ok: true, interactionId: "edit-1" });
      },
      send: (f: { interactionId: string }) => {
        sentTo.push(f.interactionId);
        return Promise.resolve({ ok: true });
      },
      awaitReceipt: () =>
        Promise.resolve(++receipts === 1 ? { ok: false, error: "timeout" } : { ok: true }),
    } as unknown as App;
    const tray = createBatchTray(app);
    document.body.appendChild(tray.element);
    const p = document.createElement("p");
    p.textContent = "original";
    document.body.appendChild(p);
    tray.addRemoval(p);
    const send = [...tray.element.querySelectorAll("button")].find(
      (b) => b.textContent === "Send edits",
    ) as HTMLButtonElement;
    trusted(send);
    await flushAll();
    trusted(send);
    await flushAll();
    expect(created).toEqual(["edit-1"]);
    expect(sentTo).toEqual(["edit-1", "edit-1"]);
  });

  test("raw edits come off with a note when the kept entry never arrives", async () => {
    const toasts: string[] = [];
    let fire: () => void = () => {};
    const layer = {
      whenKept: (_id: string, _fn: () => void, _ms: number, onTimeout?: () => void) => {
        fire = () => onTimeout?.();
      },
      lifted: (fn: () => void) => fn(),
    };
    const app = {
      ...stubApp(),
      toast: (t: string) => toasts.push(t),
      awaitReceipt: () => Promise.resolve({ ok: true }),
    } as unknown as App;
    const tray = createBatchTray(app, { layer: layer as never });
    document.body.appendChild(tray.element);
    const p = document.createElement("p");
    p.textContent = "original";
    document.body.appendChild(p);
    tray.addRemoval(p);
    const send = [...tray.element.querySelectorAll("button")].find(
      (b) => b.textContent === "Send edits",
    ) as HTMLButtonElement;
    trusted(send);
    await flushAll();
    expect(p.style.display).toBe("none");
    fire(); // 15 seconds pass with no kept entry
    expect(p.style.display).toBe("");
    expect(toasts).toContain(BATCH_COPY.notKept);
  });
});

describe("batch tray — edits in every frame of the tab (E-3)", () => {
  function trusted(target: Element): void {
    const e = new (win as Window).Event("click", { bubbles: true, cancelable: true });
    Object.defineProperty(e, "isTrusted", { value: true });
    target.dispatchEvent(e as unknown as Event);
  }
  const buttonIn = (root: ParentNode, label: string) =>
    [...root.querySelectorAll("button")].find((b) => b.textContent === label) as HTMLElement;

  function framedTray(sendResult: { ok: true } | { ok: false; error: string; note: string }) {
    const calls: string[] = [];
    let frameOps = [{ op: "setText", detail: "Hello from the frame" }];
    const sent: Array<Record<string, unknown>> = [];
    const app = {
      ...stubApp(),
      send: (f: Record<string, unknown>) => {
        sent.push(f);
        return Promise.resolve({ ok: true });
      },
      awaitReceipt: () => Promise.resolve({ ok: true }),
    } as unknown as App;
    const tray = createBatchTray(app, {
      remote: {
        settle: async () => {
          calls.push("settle");
        },
        lists: () => [{ documentId: "doc-1", host: "tree.content.example", ops: frameOps }],
        remove: (doc, i) => {
          calls.push(`remove ${doc} ${i}`);
          frameOps = [];
        },
        send: async (doc, spaceId) => {
          calls.push(`send ${doc} ${spaceId}`);
          return sendResult;
        },
        dismiss: (doc) => {
          calls.push(`dismiss ${doc}`);
        },
      },
    });
    document.body.appendChild(tray.element);
    return { tray, calls, sent };
  }

  test("the top frame's tray lists a frame's edits under its host and counts them", () => {
    const { tray } = framedTray({ ok: true });
    tray.setOpen(true);
    tray.remoteChanged();
    expect(tray.element.textContent).toContain("Edit set · 1");
    expect(tray.element.textContent).toContain("tree.content.example");
    expect(tray.element.textContent).toContain("Hello from the frame");
    expect(tray.opCount()).toBe(1);
    expect(tray.localOpCount()).toBe(0);
  });

  test("Send makes one Edit per document: here nothing, the frame's sent by that frame", async () => {
    const { tray, calls, sent } = framedTray({ ok: true });
    tray.setOpen(true);
    tray.remoteChanged();
    trusted(buttonIn(tray.element, "Send edits"));
    await new Promise((r) => setTimeout(r, 0));
    expect(calls).toEqual(["settle", "send doc-1 s_aaaaaaaaaaaaaaaaaaaa"]);
    // This document made no Edit and sent no batch of its own.
    expect(sent).toEqual([]);
    expect(tray.isOpen()).toBe(false);
  });

  test("a frame's send that failed keeps the tray open with its line", async () => {
    const { tray } = framedTray({ ok: false, error: "page-changed", note: BATCH_COPY.pageChanged });
    tray.setOpen(true);
    tray.remoteChanged();
    trusted(buttonIn(tray.element, "Send edits"));
    await new Promise((r) => setTimeout(r, 0));
    expect(tray.isOpen()).toBe(true);
    expect(tray.element.textContent).toContain(BATCH_COPY.pageChanged);
  });

  test("Close dismisses the frame's edits too, and × takes one out there", () => {
    const { tray, calls } = framedTray({ ok: true });
    tray.setOpen(true);
    tray.remoteChanged();
    trusted(tray.element.querySelector(".op-remove") as Element);
    expect(calls).toEqual(["remove doc-1 0"]);
    const second = framedTray({ ok: true });
    second.tray.setOpen(true);
    second.tray.dismiss();
    expect(second.calls).toEqual(["dismiss doc-1"]);
  });

  test("this document's edits made on another page than now send nothing (2-F3)", async () => {
    let page = "https://site.test/page";
    const created: unknown[] = [];
    const app = {
      ...stubApp(),
      createInteraction: (p: unknown) => {
        created.push(p);
        return Promise.resolve({ ok: true, interactionId: "x" });
      },
      awaitReceipt: () => Promise.resolve({ ok: true }),
    } as unknown as App;
    const tray = createBatchTray(app, { binding: () => ({ page, generation: 3 }) });
    document.body.appendChild(tray.element);
    const target = document.createElement("p");
    target.textContent = "words";
    document.body.appendChild(target);
    tray.setOpen(true);
    tray.addRemoval(target);
    expect(tray.listOps()).toEqual([{ op: "setStyle", detail: "display:none" }]);
    page = "https://site.test/other";
    expect(await tray.sendHere("s_aaaaaaaaaaaaaaaaaaaa")).toEqual({
      ok: false,
      error: "page-changed",
      note: BATCH_COPY.pageChanged,
    });
    expect(created).toEqual([]);
    // Back on the page it was made on: the create carries the generation it was made under.
    page = "https://site.test/page";
    await tray.sendHere("s_aaaaaaaaaaaaaaaaaaaa");
    expect(created[0]).toMatchObject({ kind: "change", pickGeneration: 3 });
  });
});

describe("batch tray — accounts and repeated sends (2-E2, 2-E5)", () => {
  function trusted(target: Element): void {
    const e = new (win as Window).Event("click", { bubbles: true, cancelable: true });
    Object.defineProperty(e, "isTrusted", { value: true });
    target.dispatchEvent(e as unknown as Event);
  }
  const sendButton = (tray: { element: HTMLElement }) =>
    [...tray.element.querySelectorAll("button")].find(
      (b) => b.textContent === "Send edits",
    ) as HTMLButtonElement;

  function tray(opts: { create?: (p: unknown, nonce?: string) => Promise<unknown> } = {}) {
    const binding = { page: "https://site.test/page", generation: 1 };
    const creates: Array<{ payload: unknown; nonce: string | undefined }> = [];
    const app = {
      ...stubApp(),
      createInteraction: (payload: unknown, _space: string, nonce?: string) => {
        creates.push({ payload, nonce });
        return (opts.create?.(payload, nonce) ??
          Promise.resolve({ ok: true, interactionId: "x" })) as never;
      },
      awaitReceipt: () => Promise.resolve({ ok: true }),
    } as unknown as App;
    const t = createBatchTray(app, { binding: () => ({ ...binding }) });
    document.body.appendChild(t.element);
    const target = document.createElement("p");
    target.textContent = "words";
    document.body.appendChild(target);
    return { t, target, binding, creates };
  }

  test("an account change drops every edit and its preview; the next account's tray is empty", () => {
    const { t, target, binding } = tray();
    t.setOpen(true);
    t.addRemoval(target);
    expect(target.style.display).toBe("none");
    t.reset();
    expect(t.opCount()).toBe(0);
    expect(t.listOps()).toEqual([]);
    expect(target.style.display).toBe("");
    expect(t.isOpen()).toBe(false);
    binding.generation = 2;
    expect(t.listOps()).toEqual([]);
  });

  test("edits made under another account are neither reported nor sent", async () => {
    const { t, target, binding, creates } = tray();
    t.addRemoval(target);
    binding.generation = 2;
    expect(t.listOps()).toEqual([]);
    expect((await t.sendHere("s_aaaaaaaaaaaaaaaaaaaa")).ok).toBe(false);
    expect(creates).toEqual([]);
  });

  test("a second Send while the first create is out sends nothing more; a retry reuses its nonce", async () => {
    let answer: (r: unknown) => void = () => {};
    let calls = 0;
    const { t, target, creates } = tray({
      create: () => {
        calls += 1;
        // The first try never hears back; the retry lands.
        return calls === 1
          ? new Promise((r) => {
              answer = r;
            })
          : Promise.resolve({ ok: true, interactionId: "x" });
      },
    });
    t.setOpen(true);
    t.addRemoval(target);
    trusted(sendButton(t));
    await new Promise((r) => setTimeout(r, 0));
    expect(sendButton(t).disabled).toBe(true);
    // Another click, and a refresh from a frame's report, while the create is out.
    t.remoteChanged();
    expect(sendButton(t).disabled).toBe(true);
    trusted(sendButton(t));
    expect(
      await Promise.race([t.sendHere("s_aaaaaaaaaaaaaaaaaaaa"), Promise.resolve("joined")]),
    ).toBe("joined");
    expect(creates).toHaveLength(1);
    answer({ ok: false, reason: "timeout" });
    await new Promise((r) => setTimeout(r, 0));
    expect(sendButton(t).disabled).toBe(false);
    // The retry: the same create nonce, so the space answers with the first Edit.
    expect((await t.sendHere("s_aaaaaaaaaaaaaaaaaaaa")).ok).toBe(true);
    expect(creates).toHaveLength(2);
    expect(creates[1]?.nonce).toBe(creates[0]?.nonce);
    expect(typeof creates[0]?.nonce).toBe("string");
  });
});

describe("batch tray — one create per batch (3-E3, 3-E6)", () => {
  function tray() {
    const creates: Array<{ nonce: string | undefined; spaceId: string }> = [];
    const sent: Array<Record<string, unknown>> = [];
    const app = {
      ...stubApp(),
      createInteraction: (_p: unknown, spaceId: string, nonce?: string) => {
        creates.push({ nonce, spaceId });
        return Promise.resolve({ ok: false, reason: "timeout" });
      },
      send: (f: Record<string, unknown>) => {
        sent.push(f);
        return Promise.resolve({ ok: true });
      },
      awaitReceipt: () => Promise.resolve({ ok: true }),
    } as unknown as App;
    const t = createBatchTray(app, {
      binding: () => ({ page: "https://site.test/page", generation: 7 }),
    });
    document.body.appendChild(t.element);
    const block = () => {
      const p = document.createElement("p");
      p.textContent = "words";
      document.body.appendChild(p);
      return p;
    };
    return { t, creates, sent, block };
  }

  test("dismissing a batch whose create timed out retires its nonce: the next batch is its own", async () => {
    const { t, creates, block } = tray();
    t.addRemoval(block());
    await t.sendHere("s_aaaaaaaaaaaaaaaaaaaa");
    t.dismiss();
    t.addRemoval(block());
    await t.sendHere("s_aaaaaaaaaaaaaaaaaaaa");
    expect(creates).toHaveLength(2);
    expect(creates[1]?.nonce).not.toBe(creates[0]?.nonce);
  });

  test("changing the batch, or its space, retires the nonce; an unchanged retry keeps it", async () => {
    const { t, creates, block } = tray();
    t.addRemoval(block());
    await t.sendHere("s_aaaaaaaaaaaaaaaaaaaa");
    await t.sendHere("s_aaaaaaaaaaaaaaaaaaaa");
    expect(creates[1]?.nonce).toBe(creates[0]?.nonce);
    await t.sendHere("s_bbbbbbbbbbbbbbbbbbbb");
    expect(creates[2]?.nonce).not.toBe(creates[1]?.nonce);
    t.addRemoval(block());
    await t.sendHere("s_bbbbbbbbbbbbbbbbbbbb");
    expect(creates[3]?.nonce).not.toBe(creates[2]?.nonce);
    t.removeAt(0);
    await t.sendHere("s_bbbbbbbbbbbbbbbbbbbb");
    expect(creates[4]?.nonce).not.toBe(creates[3]?.nonce);
  });

  test("a change-batch carries the account generation its edits were made under", async () => {
    const app = {
      ...stubApp(),
      createInteraction: () => Promise.resolve({ ok: true, interactionId: "x" }),
      awaitReceipt: () => Promise.resolve({ ok: true }),
      send: (f: Record<string, unknown>) => {
        sent.push(f);
        return Promise.resolve({ ok: true });
      },
    } as unknown as App;
    const sent: Array<Record<string, unknown>> = [];
    const t = createBatchTray(app, {
      binding: () => ({ page: "https://site.test/page", generation: 7 }),
    });
    const p = document.createElement("p");
    document.body.appendChild(p);
    t.addRemoval(p);
    await t.sendHere("s_aaaaaaaaaaaaaaaaaaaa");
    expect(sent.find((f) => f.type === "change-batch")).toMatchObject({ pickGeneration: 7 });
  });
});

describe("batch tray — Close puts the page's own nodes back", () => {
  /** A section holding a heading and a price, as the page made them. */
  function section() {
    const tray = createBatchTray(stubApp());
    document.body.appendChild(tray.element);
    const box = document.createElement("section");
    const heading = document.createElement("h2");
    heading.textContent = "Team";
    const price = document.createElement("p");
    price.textContent = "Twelve dollars a month.";
    box.append(heading, price);
    document.body.appendChild(box);
    tray.setOpen(true);
    return { tray, box, heading, price, words: price.firstChild as Text, before: box.outerHTML };
  }
  const blur = (t: Element) =>
    t.dispatchEvent(new (win as Window).Event("blur") as unknown as Event);

  test("a removed block comes back after the block around it was opened for text and left alone", () => {
    const { tray, box, price, before } = section();
    tray.addRemoval(price);
    tray.beginTextEdit(box);
    blur(box); // nothing typed
    expect(tray.opCount()).toBe(1);

    tray.dismiss();
    expect(price.isConnected).toBe(true);
    expect(price.style.display).toBe("");
    expect(price.hasAttribute("style")).toBe(false);
    expect(box.outerHTML).toBe(before);
  });

  test("a rewrite of a block, then of the block around it: both come off, onto the page's own nodes", () => {
    const { tray, box, heading, price, words, before } = section();
    tray.beginTextEdit(price);
    words.data = "Nine dollars."; // typed in place, as a browser does
    blur(price);
    tray.beginTextEdit(box);
    box.append(" More.");
    blur(box);
    expect(tray.opCount()).toBe(2);

    tray.dismiss();
    expect(box.outerHTML).toBe(before);
    expect([...box.childNodes]).toEqual([heading, price]);
    expect(price.firstChild).toBe(words);
  });

  test("a text session that changed nothing swaps no node", () => {
    const { tray, box, heading, price, words } = section();
    tray.beginTextEdit(box);
    blur(box);
    expect(tray.opCount()).toBe(0);
    expect([...box.childNodes]).toEqual([heading, price]);
    expect(price.firstChild).toBe(words);
  });

  test("taking out the first of two nested rewrites leaves nothing of it behind after Close", () => {
    const { tray, box, price, words, before } = section();
    tray.beginTextEdit(price);
    words.data = "Nine dollars.";
    blur(price);
    tray.beginTextEdit(box);
    box.append(" More.");
    blur(box);

    expect(tray.removeAt(0)).toBe(true);
    expect(box.textContent).toBe("TeamNine dollars. More."); // the rewrite that stays, as it will be sent
    tray.dismiss();
    expect(box.outerHTML).toBe(before);
    expect(price.isConnected).toBe(true);
  });

  test("a removal's undo keeps the block's own display and its priority", () => {
    const { tray, price } = section();
    price.setAttribute("style", "display: flex !important; color: red;");
    tray.addRemoval(price);
    expect(price.style.display).toBe("none");

    tray.dismiss();
    expect(price.style.getPropertyValue("display")).toBe("flex");
    expect(price.style.getPropertyPriority("display")).toBe("important");
    expect(price.style.color).toBe("red");
  });
});
