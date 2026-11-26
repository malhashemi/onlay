/// <reference types="chrome" />
// The universal token input (F-028): serialization round-trip (pills →
// RawRichText — textContent IS the wire format), trigger detection at the
// caret, menu-accept pill insertion, whole-pill backspace, protocol caps,
// the people + @agent mention list, emoji search ranking, and draft
// persist/restore including anchor-token JSON.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { RawInteractionSnapshot, Token } from "@onlay/protocol";
import { searchEmojis } from "@onlay/render/emoji";
import { Window } from "happy-dom";
import { type AppInternals, createApp } from "./app";
import { caretOffset, setCaretOffset } from "./caret";
import { clearDraft, readRichDraft, writeDraft, writeRichDraft } from "./drafts";
import type { PersonView } from "./people";
import {
  detectTrigger,
  pillBeforeCaret,
  serializeEditor,
  type TokenInputApp,
  tokenInput,
  tokensFor,
} from "./token-input";

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

const DIRECTORY: PersonView[] = [
  { id: "adel", name: "Adel", tint: "#0ea5e9", initials: "AD" },
  { id: "scout", name: "Scout Agent", tint: "#8b5cf6", initials: "SC" },
];

function makeApp(): ReturnType<typeof createApp> & AppInternals {
  const host = document.createElement("div");
  document.body.appendChild(host);
  const shadow = host.attachShadow({ mode: "open" });
  const app = createApp({ shadow, host, isTopFrame: true, toast: () => {} }) as ReturnType<
    typeof createApp
  > &
    AppInternals;
  app._setDirectory("s_aaaaaaaaaaaaaaaaaaaa", DIRECTORY);
  return app;
}

function mount(ti: ReturnType<typeof tokenInput>): HTMLElement {
  document.body.appendChild(ti.wrap);
  return ti.input;
}

function placeCaret(node: Node, offset: number): void {
  const range = document.createRange();
  range.setStart(node, offset);
  range.collapse(true);
  const sel = document.getSelection();
  sel?.removeAllRanges();
  sel?.addRange(range);
}

function key(el: HTMLElement, k: string, init: KeyboardEventInit = {}): void {
  el.dispatchEvent(new KeyboardEvent("keydown", { key: k, bubbles: true, ...init }));
}

const ANCHOR_TOKEN: Token = {
  t: "anchor",
  anchor: { level: "element", selector: "#hero" },
  label: "§hero",
};

/* ── trigger detection at the caret (pure) ─────────────────────────── */

describe("detectTrigger", () => {
  test("@ opens the actor menu, query lowercased", () => {
    expect(detectTrigger("hey @")).toEqual({ kind: "actor", query: "", length: 1 });
    expect(detectTrigger("hey @Ad")).toEqual({ kind: "actor", query: "ad", length: 3 });
  });

  test("# opens the anchor menu", () => {
    expect(detectTrigger("see #")).toEqual({ kind: "anchor", query: "", length: 1 });
    expect(detectTrigger("see #Nav")).toEqual({ kind: "anchor", query: "nav", length: 4 });
  });

  test(": needs two chars before the emoji menu opens", () => {
    expect(detectTrigger("nice :p")).toBeNull();
    expect(detectTrigger("nice :pa")).toEqual({ kind: "emoji", query: "pa", length: 3 });
  });

  test("plain text and mid-word boundaries stay quiet", () => {
    expect(detectTrigger("no trigger here")).toBeNull();
    expect(detectTrigger("ratio 1:2")).toBeNull(); // digits-only never looks like an emoji query...
  });

  test("the newest trigger wins", () => {
    expect(detectTrigger("@a #b")?.kind).toBe("anchor");
  });
});

/* ── serialization: pills → RawRichText and back ───────────────────── */

describe("serialization round-trip", () => {
  test("a rich draft rebuilds pills whose wire text serializes back to the same value", () => {
    const app = makeApp();
    writeRichDraft("rt", {
      text: "ping @Adel see #§hero after",
      tokens: [{ t: "actor", actorId: "adel" }, ANCHOR_TOKEN],
    });
    const ti = tokenInput(app, "x", { draftKey: "rt" });
    const input = mount(ti);

    const pills = input.querySelectorAll("[data-token]");
    expect(pills.length).toBe(2);
    expect(pills[0]?.textContent).toBe("@Adel");
    expect(pills[0]?.className).toContain("token-actor");
    expect(pills[1]?.textContent).toBe("#§hero");
    expect(pills[1]?.className).toContain("token-anchor");

    const v = ti.value();
    expect(v.text).toBe("ping @Adel see #§hero after");
    // Each token says where its pill sits (M-4).
    expect(v.tokens).toEqual([
      { t: "actor", actorId: "adel", spans: [{ start: 5, length: 5 }] },
      { ...ANCHOR_TOKEN, spans: [{ start: 15, length: 6 }] },
    ]);
    clearDraft("rt");
  });

  test("an @agent pill round-trips as the agent token, in the same round pill", () => {
    const app = makeApp();
    writeRichDraft("ag", { text: "@agent go", tokens: [{ t: "agent" }] });
    const ti = tokenInput(app, "x", { draftKey: "ag" });
    const input = mount(ti);
    const pill = input.querySelector("[data-token]");
    expect(pill?.getAttribute("data-token")).toBe("agent");
    expect(pill?.className).toBe("token-pill token-actor");
    expect(ti.value()).toEqual({
      text: "@agent go",
      tokens: [{ t: "agent", spans: [{ start: 0, length: 6 }] }],
    });
    clearDraft("ag");
  });

  test("serializeEditor walks text + pills in order", () => {
    const app = makeApp();
    writeRichDraft("sw", {
      text: "a @Adel b",
      tokens: [{ t: "actor", actorId: "adel" }],
    });
    const ti = tokenInput(app, "x", { draftKey: "sw" });
    const input = mount(ti);
    const raw = serializeEditor(input);
    expect(raw.text).toBe("a @Adel b");
    expect(raw.tokens).toEqual([{ t: "actor", actorId: "adel" }]);
    clearDraft("sw");
  });
});

/* ── the @ menu inserts live pills ─────────────────────────────────── */

describe("actor typeahead", () => {
  test("typing @ad and accepting inserts a pill and the token", () => {
    const app = makeApp();
    const ti = tokenInput(app, "x");
    const input = mount(ti);
    const tn = document.createTextNode("hi @ad");
    input.appendChild(tn);
    placeCaret(tn, 6);
    input.dispatchEvent(new Event("input", { bubbles: true }));

    const menu = ti.wrap.querySelector(".mention-menu") as HTMLElement;
    expect(menu.style.display).toBe("block");
    expect(menu.textContent).toContain("Adel");
    expect(menu.textContent).not.toContain("@agent"); // "ad" doesn't start "agent"

    key(input, "Enter");
    const pill = input.querySelector("[data-token]");
    expect(pill?.textContent).toBe("@Adel");
    expect(menu.style.display).toBe("none");
    const v = ti.value();
    expect(v.text).toBe("hi @Adel");
    expect(v.tokens).toEqual([{ t: "actor", actorId: "adel", spans: [{ start: 3, length: 5 }] }]);
  });

  test("people who arrive after @name was typed open the menu", async () => {
    const app = makeApp();
    app._setDirectory("s_aaaaaaaaaaaaaaaaaaaa", []);
    const ti = tokenInput(app, "x");
    const input = mount(ti);
    const tn = document.createTextNode("hi @ad");
    input.appendChild(tn);
    placeCaret(tn, 6);
    input.dispatchEvent(new Event("input", { bubbles: true }));
    const menu = ti.wrap.querySelector(".mention-menu") as HTMLElement;
    expect(menu.style.display).toBe("none");

    app._setDirectory("s_aaaaaaaaaaaaaaaaaaaa", DIRECTORY);
    await new Promise((r) => setTimeout(r, 400));
    expect(menu.style.display).toBe("block");
    expect(menu.textContent).toContain("Adel");
  });

  test("@a offers @agent first, and accepting it inserts the agent token", () => {
    const app = makeApp();
    const ti = tokenInput(app, "x");
    const input = mount(ti);
    const tn = document.createTextNode("over to @a");
    input.appendChild(tn);
    placeCaret(tn, 10);
    input.dispatchEvent(new Event("input", { bubbles: true }));
    const rows = [...ti.wrap.querySelectorAll(".mention-menu .pick-item")];
    expect(rows[0]?.textContent).toContain("@agent");
    key(input, "Enter");
    expect(ti.value()).toEqual({
      text: "over to @agent",
      tokens: [{ t: "agent", spans: [{ start: 8, length: 6 }] }],
    });
  });

  test("@ finds a person by any word of their name or their alias; the alias shows beside", () => {
    const app = makeApp();
    app._setDirectory("s_aaaaaaaaaaaaaaaaaaaa", [
      ...DIRECTORY,
      { id: "rov", name: "R. Odíle Varga", tint: "#111", initials: "RV", alias: "rvarga" },
    ]);
    const ti = tokenInput(app, "x");
    const input = mount(ti);
    for (const q of ["@varg", "@odile", "@rvar"]) {
      input.textContent = "";
      const tn = document.createTextNode(q);
      input.appendChild(tn);
      placeCaret(tn, q.length);
      input.dispatchEvent(new Event("input", { bubbles: true }));
      const rows = [...ti.wrap.querySelectorAll(".mention-menu .pick-item")];
      const row = rows.find((r) => r.textContent?.includes("Varga"));
      expect(row).toBeDefined();
      expect(row?.querySelector(".hint")?.textContent).toBe("rvarga");
    }
  });

  test("Shift+Enter keeps every line break, however fast: a break at the end stays drawn", () => {
    const app = makeApp();
    const ti = tokenInput(app, "x");
    const input = mount(ti);
    const tn = document.createTextNode("a");
    input.appendChild(tn);
    placeCaret(tn, 1);
    // Types at the caret, as the browser does with a key.
    const typeAtCaret = (text: string): void => {
      const range = document.getSelection()?.getRangeAt(0);
      const node = document.createTextNode(text);
      range?.insertNode(node);
      placeCaret(node, text.length);
    };
    key(input, "Enter", { shiftKey: true });
    // Nothing after the break: a placeholder <br> keeps it drawn, and the
    // caret sits between the two, not before the break.
    expect(input.innerHTML).toBe("a<br><br>");
    const sel = document.getSelection()?.getRangeAt(0);
    expect(sel?.startContainer).toBe(input);
    expect(sel?.startOffset).toBe(2);
    expect(ti.value().text).toBe("a");
    typeAtCaret("b");
    key(input, "Enter", { shiftKey: true });
    key(input, "Enter", { shiftKey: true });
    typeAtCaret("c");
    expect(ti.value().text).toBe("a\nb\n\nc");
    // A break typed into the middle of the text needs no placeholder.
    placeCaret(input.firstChild as Node, 1);
    key(input, "Enter", { shiftKey: true });
    expect(ti.value().text).toBe("a\n\nb\n\nc");
  });

  test("the open menu follows its field when the card around it moves (it rises at the bottom edge)", () => {
    const frames: FrameRequestCallback[] = [];
    const g = globalThis as unknown as Record<string, unknown>;
    const saved = [g.requestAnimationFrame, g.cancelAnimationFrame];
    g.requestAnimationFrame = (cb: FrameRequestCallback) => frames.push(cb);
    g.cancelAnimationFrame = () => {};
    try {
      const app = makeApp();
      const ti = tokenInput(app, "x");
      const input = mount(ti);
      let top = 600;
      ti.wrap.getBoundingClientRect = () =>
        ({
          left: 100,
          top,
          right: 400,
          bottom: top + 40,
          width: 300,
          height: 40,
          x: 100,
          y: top,
        }) as DOMRect;
      const tn = document.createTextNode("@ad");
      input.appendChild(tn);
      placeCaret(tn, 3);
      input.dispatchEvent(new Event("input", { bubbles: true }));
      const menu = ti.wrap.querySelector(".mention-menu") as HTMLElement;
      expect(menu.style.display).toBe("block");
      const before = menu.style.top;
      // The card lays itself out after the keystroke: the field rises by 120 px.
      top = 480;
      for (const cb of frames.splice(0)) cb(0);
      expect(menu.style.top).not.toBe(before);
      // Closed: it stops following.
      input.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
      for (const cb of frames.splice(0)) cb(0);
      expect(frames).toHaveLength(0);
    } finally {
      g.requestAnimationFrame = saved[0];
      g.cancelAnimationFrame = saved[1];
    }
  });

  test("the menu lists the composing space's people only", () => {
    const app = makeApp();
    app._setDirectory("s_bbbbbbbbbbbbbbbbbbbb", [
      { id: "zed", name: "Zed", tint: "#111", initials: "ZE" },
    ]);
    const ti = tokenInput(app, "x", { spaceId: () => "s_bbbbbbbbbbbbbbbbbbbb" });
    const input = mount(ti);
    const tn = document.createTextNode("@");
    input.appendChild(tn);
    placeCaret(tn, 1);
    input.dispatchEvent(new Event("input", { bubbles: true }));
    const menu = ti.wrap.querySelector(".mention-menu") as HTMLElement;
    expect(menu.textContent).toContain("Zed");
    expect(menu.textContent).not.toContain("Adel");
    expect(menu.textContent).toContain("@agent");
  });

  test("Escape closes the menu without touching the text", () => {
    const app = makeApp();
    const ti = tokenInput(app, "x");
    const input = mount(ti);
    const tn = document.createTextNode("@sc");
    input.appendChild(tn);
    placeCaret(tn, 3);
    input.dispatchEvent(new Event("input", { bubbles: true }));
    const menu = ti.wrap.querySelector(".mention-menu") as HTMLElement;
    expect(menu.style.display).toBe("block");
    key(input, "Escape");
    expect(menu.style.display).toBe("none");
    expect(ti.value().text).toBe("@sc");
  });
});

/* ── backspace at a pill boundary deletes the whole pill ───────────── */

describe("pill backspace", () => {
  function pillEditor(app: ReturnType<typeof makeApp>): ReturnType<typeof tokenInput> {
    writeRichDraft("bs", {
      text: "ping @Adel after",
      tokens: [{ t: "actor", actorId: "adel" }],
    });
    const ti = tokenInput(app, "x", { draftKey: "bs" });
    mount(ti);
    clearDraft("bs");
    return ti;
  }

  test("caret at the start of the node after a pill sees the pill", () => {
    const ti = pillEditor(makeApp());
    const after = ti.input.childNodes[2] as Text; // [text, pill, text]
    placeCaret(after, 0);
    expect(pillBeforeCaret(ti.input)?.textContent).toBe("@Adel");
  });

  test("caret inside text does not", () => {
    const ti = pillEditor(makeApp());
    const after = ti.input.childNodes[2] as Text;
    placeCaret(after, 2);
    expect(pillBeforeCaret(ti.input)).toBeNull();
  });

  test("Backspace removes the pill whole — text and token", () => {
    const ti = pillEditor(makeApp());
    const after = ti.input.childNodes[2] as Text;
    placeCaret(after, 0);
    key(ti.input, "Backspace");
    expect(ti.input.querySelector("[data-token]")).toBeNull();
    const v = ti.value();
    expect(v.text).toBe("ping  after");
    expect(v.tokens ?? []).toEqual([]);
  });
});

/* ── protocol caps + the transitional bare-@ fallback ──────────────── */

describe("value() discipline", () => {
  test("a typed @agent becomes the agent token; other @words stay text", () => {
    const app = makeApp();
    const ti = tokenInput(app, "x");
    mount(ti);
    ti.setText("ping @Adel and @agent please");
    expect(ti.value().tokens).toEqual([{ t: "agent" }]);
    ti.setText("mail me at x@agent.example or @agents");
    expect(ti.value().tokens).toBeUndefined();
  });

  test("tokensFor ships @agent once and people once, in order", () => {
    const person = (id: string): PersonView => ({ id, name: "Adel", tint: "#000", initials: "AD" });
    expect(
      tokensFor(
        "@Adel @agent @Adel @agent",
        [
          { t: "actor", actorId: "adel" },
          { t: "agent" },
          { t: "actor", actorId: "adel" },
          { t: "agent" },
        ],
        person,
      ),
    ).toEqual({
      text: "@Adel @agent @Adel @agent",
      tokens: [{ t: "actor", actorId: "adel" }, { t: "agent" }],
    });
  });

  test("text is trimmed and capped at the field's protocol limit", () => {
    const app = makeApp();
    const ti = tokenInput(app, "x", { cap: 10 });
    mount(ti);
    ti.setText(`  ${"a".repeat(50)}`);
    expect(ti.value().text).toBe("a".repeat(10));
  });

  test("a pill sliced past the text cap does NOT ship as a token", () => {
    // The @agent pill sits beyond the 10-char cap: capping the text cuts it off,
    // so it must not survive as a token (an out-of-view @agent would still hand off).
    const app = makeApp();
    writeRichDraft("beyond", {
      text: "@Adel filler @agent",
      tokens: [{ t: "actor", actorId: "adel" }, { t: "agent" }],
    });
    const ti = tokenInput(app, "x", { draftKey: "beyond", cap: 10 });
    mount(ti);
    const v = ti.value();
    expect(v.text).toBe("@Adel fill"); // capped at 10 — @agent is gone from the text
    // and gone from tokens
    expect(v.tokens).toEqual([{ t: "actor", actorId: "adel", spans: [{ start: 0, length: 5 }] }]);
    clearDraft("beyond");
  });

  test("tokens cap at MAX_TOKENS_PER_MSG", () => {
    const app = makeApp();
    const ids = Array.from({ length: 40 }, (_, i) => `t${i}`);
    writeRichDraft("caps", {
      text: ids.map((id) => `@${id}`).join(" "),
      tokens: ids.map((id) => ({ t: "actor", actorId: id }) as Token),
    });
    const ti = tokenInput(app, "x", { draftKey: "caps" });
    mount(ti);
    expect(ti.value().tokens?.length).toBe(32);
    clearDraft("caps");
  });

  test("duplicate actor pills dedupe to one token", () => {
    const app = makeApp();
    writeRichDraft("dup", {
      text: "@Adel @Adel",
      tokens: [
        { t: "actor", actorId: "adel" },
        { t: "actor", actorId: "adel" },
      ],
    });
    const ti = tokenInput(app, "x", { draftKey: "dup" });
    mount(ti);
    // One token, one span per pill (M-4).
    expect(ti.value().tokens).toEqual([
      {
        t: "actor",
        actorId: "adel",
        spans: [
          { start: 0, length: 5 },
          { start: 6, length: 5 },
        ],
      },
    ]);
    clearDraft("dup");
  });
});

/* ── drafts: persist/restore incl. anchor-token JSON ───────────────── */

describe("draft persistence", () => {
  test("typing persists the rich draft; clear() forgets it", () => {
    const app = makeApp();
    const ti = tokenInput(app, "x", { draftKey: "dp" });
    const input = mount(ti);
    input.appendChild(document.createTextNode("hello"));
    input.dispatchEvent(new Event("input", { bubbles: true }));
    expect(readRichDraft("dp")?.text).toBe("hello");
    ti.clear();
    expect(readRichDraft("dp")).toBeUndefined();
  });

  test("anchor tokens ride the draft as JSON and survive a rebuild", () => {
    const app = makeApp();
    writeRichDraft("aj", { text: "look #§hero", tokens: [ANCHOR_TOKEN] });
    const first = tokenInput(app, "x", { draftKey: "aj" });
    const input = mount(first);
    // an edit that keeps the pill alive re-persists the full token
    input.appendChild(document.createTextNode(" now"));
    input.dispatchEvent(new Event("input", { bubbles: true }));
    const stored = readRichDraft("aj");
    expect(stored?.text).toBe("look #§hero now");
    // …with where its pill sits (2-M4)
    expect(stored?.tokens).toEqual([{ ...ANCHOR_TOKEN, spans: [{ start: 5, length: 6 }] }]);
    // a second editor (the post-state-frame rebuild) restores the pill
    const second = tokenInput(app, "x", { draftKey: "aj" });
    mount(second);
    expect(second.input.querySelector("[data-token='anchor']")?.textContent).toBe("#§hero");
    expect(second.value().tokens).toEqual([{ ...ANCHOR_TOKEN, spans: [{ start: 5, length: 6 }] }]);
    clearDraft("aj");
  });

  test("legacy plain-string drafts restore as plain text and stay plain", () => {
    const app = makeApp();
    writeDraft("lg", "ping @Adel soon");
    const ti = tokenInput(app, "x", { draftKey: "lg" });
    mount(ti);
    expect(ti.input.querySelector("[data-token]")).toBeNull();
    const v = ti.value();
    expect(v.text).toBe("ping @Adel soon");
    expect(v.tokens).toBeUndefined();
    clearDraft("lg");
  });
});

/* ── keyboard discipline ───────────────────────────────────────────── */

describe("enter semantics", () => {
  test("synthetic Enter never sends (isTrusted gate)", () => {
    const app = makeApp();
    let sent = 0;
    const ti = tokenInput(app, "x", {
      onSend: () => {
        sent++;
      },
    });
    const input = mount(ti);
    input.appendChild(document.createTextNode("hello"));
    key(input, "Enter");
    expect(sent).toBe(0);
  });

  test("Shift+Enter inserts a newline in multi-line editors", () => {
    const app = makeApp();
    const ti = tokenInput(app, "x", { onSend: () => {} });
    const input = mount(ti);
    const tn = document.createTextNode("ab");
    input.appendChild(tn);
    placeCaret(tn, 1);
    key(input, "Enter", { shiftKey: true });
    expect(input.innerHTML).toBe("a<br>b");
    expect(ti.value().text).toBe("a\nb");
  });

  test("single-line editors never gain a newline", () => {
    const app = makeApp();
    const ti = tokenInput(app, "x", { multiline: false });
    const input = mount(ti);
    const tn = document.createTextNode("ab");
    input.appendChild(tn);
    placeCaret(tn, 2);
    key(input, "Enter");
    key(input, "Enter", { shiftKey: true });
    expect(input.textContent).toBe("ab");
  });
});

/* ── caret offsets (drafts.ts preserveFocus rides these) ───────────── */

describe("caret offsets across pills", () => {
  test("offset counts pill wire text as atomic width", () => {
    const app = makeApp();
    writeRichDraft("co", {
      text: "hi @Adel yo",
      tokens: [{ t: "actor", actorId: "adel" }],
    });
    const ti = tokenInput(app, "x", { draftKey: "co" });
    mount(ti);
    const tail = ti.input.childNodes[2] as Text; // " yo"
    placeCaret(tail, 1);
    expect(caretOffset(ti.input)).toBe(9); // "hi @Adel" (8) + 1
    setCaretOffset(ti.input, 5); // inside the pill → snaps to a boundary
    const sel = document.getSelection();
    expect(sel?.focusNode === ti.input || sel?.focusNode === tail).toBe(true);
    clearDraft("co");
  });
});

/* ── emoji search ──────────────────────────────────────────────────── */

describe("searchEmojis", () => {
  test("name-prefix beats keyword matches", () => {
    expect(searchEmojis("fire")[0]?.glyph).toBe("🔥");
    expect(searchEmojis("tada")[0]?.glyph).toBe("🎉");
    expect(searchEmojis("rocket")[0]?.glyph).toBe("🚀");
  });

  test("keywords still hit", () => {
    expect(searchEmojis("lgtm")[0]?.glyph).toBe("👍");
    expect(searchEmojis("shipped").some((m) => m.glyph === "🎉")).toBe(true);
  });

  test("short queries return nothing; results cap at 7", () => {
    expect(searchEmojis("x")).toEqual([]);
    expect(searchEmojis("re").length).toBeLessThanOrEqual(7);
  });
});

/* ── noAnchors: off-page surfaces (the full-page view) ─────────────── */

describe("noAnchors option", () => {
  // A live interaction that anchorRows WOULD surface — proving the # menu is
  // silenced by the flag, not by an empty page.
  const liveSnap = {
    id: "int-1",
    kind: "comment",
    state: "open",
    anchor: { level: "element", selector: "#hero", label: "Hero" },
  } as unknown as RawInteractionSnapshot;

  const app: TokenInputApp = {
    person: (id) => ({ id, name: id, tint: "#888", initials: id.slice(0, 2) }),
    people: () => DIRECTORY,
    interactions: () => [liveSnap],
  };

  function typeHash(ti: ReturnType<typeof tokenInput>): HTMLElement {
    const input = mount(ti);
    const tn = document.createTextNode("see #");
    input.appendChild(tn);
    placeCaret(tn, 5);
    input.dispatchEvent(new Event("input", { bubbles: true }));
    return ti.wrap.querySelector(".mention-menu") as HTMLElement;
  }

  test("by default the # menu opens on a live interaction", () => {
    expect(typeHash(tokenInput(app, "x")).style.display).toBe("block");
  });

  test("noAnchors keeps the # trigger inert — no menu, no 'pick on page…'", () => {
    const menu = typeHash(tokenInput(app, "x", { noAnchors: true }));
    expect(menu.style.display).toBe("none");
    expect(menu.textContent ?? "").not.toContain("pick on page");
  });

  test("noAnchors leaves @ mentions working", () => {
    const ti = tokenInput(app, "x", { noAnchors: true });
    const input = mount(ti);
    const tn = document.createTextNode("hi @ad");
    input.appendChild(tn);
    placeCaret(tn, 6);
    input.dispatchEvent(new Event("input", { bubbles: true }));
    const menu = ti.wrap.querySelector(".mention-menu") as HTMLElement;
    expect(menu.style.display).toBe("block");
    expect(menu.textContent).toContain("Adel");
  });
});

/* ── keyboard isolation (F-056) ────────────────────────────────────── */

describe("keyboard isolation", () => {
  test("keys typed in the editor never bubble to the page (YouTube space)", () => {
    const app = makeApp();
    const ti = tokenInput(app, "say…", {});
    const input = mount(ti);
    let pageSaw = 0;
    const listener = (): void => {
      pageSaw += 1;
    };
    document.addEventListener("keydown", listener);
    document.addEventListener("keyup", listener);
    key(input, " ");
    input.dispatchEvent(new KeyboardEvent("keyup", { key: " ", bubbles: true }));
    document.removeEventListener("keydown", listener);
    document.removeEventListener("keyup", listener);
    expect(pageSaw).toBe(0);
  });
});
