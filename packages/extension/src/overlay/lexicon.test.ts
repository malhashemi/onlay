// The user-facing lexicon (ADR-0019 §5): UI copy says Block (never
// "element") and Edit (never "Change") — wire/protocol names keep `change`
// and `element`. Curated assertions against the real display strings, not a
// blind grep: kind labels, command copy, the change composer's buttons and
// toast, the copy toast, and the pick hints.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Window } from "happy-dom";
import { HOSTED_COPY } from "../hosted-copy";
import { COMMAND_IDS, COMMAND_META } from "../prefs";
import { type AppInternals, createApp } from "./app";
import { BATCH_COPY } from "./batch";
import { KEPT_COPY, MODE_SPEC } from "./command-bar";
import { PICK_HINTS } from "./commands";
import { COMPOSER_WINDOW_COPY } from "./composer-window";
import {
  changeComposer,
  commentComposer,
  EDIT_SENT_COPY,
  FRAME_PAGE_CHANGED,
  FRAME_VARIANTS_NOTE,
} from "./composers";
import { CHANGED_SINCE_COPIED, COPY_COPY } from "./copy-agent";
import { copyElement } from "./copy-element";
import { agentTag } from "./dom";
import { AGENT_WORK_LABEL, CHIP_STATES, KINDS } from "./kinds";
import { LAUNCHER_COPY } from "./launcher";
import { shareSection } from "./share";
import { SPACE_PICKER_COPY } from "./space-picker";
import { KEPT_UNRESOLVED } from "./thread";
import { VARIANT_COPY } from "./variants";

/** Every string a copy table renders, functions sampled with real values. */
function rendered(table: Record<string, string | ((...a: never[]) => string)>): string[] {
  return Object.values(table).map((v) =>
    typeof v === "function" ? (v as (...a: unknown[]) => string)(2, "Dana") : v,
  );
}

describe("kind labels", () => {
  test("the change kind reads Edit; no kind label says Change", () => {
    expect(KINDS.comment.label).toBe("Comment");
    expect(KINDS.ask.label).toBe("Ask");
    expect(KINDS.change.label).toBe("Edit");
    for (const spec of Object.values(KINDS)) {
      expect(spec.label).not.toMatch(/change/i);
      expect(spec.label).not.toMatch(/element/i);
    }
  });
});

describe("brand lexicon gate (ADR-0020)", () => {
  // Rendered user-visible strings only — CSS token names and wire values are
  // exempt (UX-7). The brand bans: membrane, queue-as-surface, element,
  // Change-as-kind, popover, notification-for-attention, exclamation marks.
  const BANNED = [/membrane/i, /\bqueue\b/i, /element/i, /\bChange\b/, /popover/i, /!/];
  const RENDERED: string[] = [
    ...COMMAND_IDS.flatMap((id) => [COMMAND_META[id].label, COMMAND_META[id].description]),
    ...Object.values(MODE_SPEC).flatMap((m) => [m.label, m.placeholder, m.empty]),
    ...Object.values(PICK_HINTS),
    ...Object.values(KINDS).map((k) => k.label),
    ...Object.values(CHIP_STATES).map((c) => c.label),
    ...Object.values(AGENT_WORK_LABEL),
    ...Object.values(HOSTED_COPY),
    ...rendered(KEPT_COPY),
    ...rendered(LAUNCHER_COPY),
    LAUNCHER_COPY.editsShown(1),
    ...rendered(COPY_COPY),
    CHANGED_SINCE_COPIED,
    KEPT_UNRESOLVED,
    ...rendered(EDIT_SENT_COPY),
    FRAME_PAGE_CHANGED,
    FRAME_VARIANTS_NOTE,
    ...rendered(BATCH_COPY),
    ...rendered(VARIANT_COPY),
    ...rendered(COMPOSER_WINDOW_COPY),
    ...rendered(SPACE_PICKER_COPY),
  ];

  test("no banned vocabulary in rendered overlay copy", () => {
    for (const text of RENDERED) {
      for (const re of BANNED) {
        expect(text).not.toMatch(re);
      }
    }
  });

  test("agent work reads as plain words: for agent, taken, answered", () => {
    expect(AGENT_WORK_LABEL).toEqual({
      pending: "for agent",
      taken: "taken",
      answered: "answered",
    });
  });

  test("the concept is a space; Ask has no command, mode or pick hint", () => {
    expect(COMMAND_META.switchSpace.label).toBe("Switch space");
    expect(MODE_SPEC.space.label).toBe("Space");
    for (const id of COMMAND_IDS) expect(COMMAND_META[id].label).not.toMatch(/\bask\b/i);
    expect(Object.keys(MODE_SPEC)).not.toContain("ask");
    expect(Object.keys(PICK_HINTS)).not.toContain("ask");
  });

  test("kept edits and copy for agent say what the spec says", () => {
    expect(COMMAND_META.keptEdits.label).toBe("Kept edits");
    expect(MODE_SPEC.kept.label).toBe("Kept edits");
    expect(COMMAND_META.copyForAgent.label).toBe("Copy for agent");
    expect(COPY_COPY.action).toBe("Copy for agent");
    expect(LAUNCHER_COPY.editsShown(3)).toBe("3 edits shown");
    expect(LAUNCHER_COPY.editsShown(1)).toBe("1 edit shown");
    expect(KEPT_COPY.unresolved).toBe("can't be shown on this page");
    expect(KEPT_UNRESOLVED).toBe("can't be shown on this page");
    expect(CHANGED_SINCE_COPIED).toBe("changed since copied");
  });

  test("the Inbox is named Inbox", () => {
    expect(COMMAND_META.inbox.label).toBe("Inbox");
    expect(MODE_SPEC.inbox.label).toBe("Inbox");
    expect(MODE_SPEC.inbox.empty).toBe("Nothing needs you.");
  });
});

describe("command copy", () => {
  test("labels and descriptions never say element or Change", () => {
    for (const id of COMMAND_IDS) {
      const { label, description } = COMMAND_META[id];
      expect(label).not.toMatch(/element/i);
      expect(label).not.toMatch(/\bchange\b/i);
      expect(description).not.toMatch(/element/i);
      expect(description).not.toMatch(/\bchange\b/i);
    }
  });

  test("pick hints ask for a block", () => {
    for (const hint of Object.values(PICK_HINTS)) {
      expect(hint).toContain("block");
      expect(hint).not.toMatch(/element/i);
    }
  });
});

describe("copy block HTML", () => {
  test("the toast reads block HTML, never element", async () => {
    const toasts: string[] = [];
    let written = "";
    copyElement(
      { outerHTML: "<p>hello</p>" } as Element,
      {
        writeText: (t: string) => {
          written = t;
          return Promise.resolve();
        },
      },
      (t) => toasts.push(t),
    );
    await new Promise((r) => setTimeout(r, 0));
    expect(written).toBe("<p>hello</p>");
    expect(toasts).toEqual(["block HTML copied (12 chars)"]);
    expect(toasts[0]).not.toMatch(/element/i);
  });
});

/* ── the change composer's visible copy (happy-dom) ── */

let win: Window | null = null;
const savedGlobals: Record<string, PropertyDescriptor | undefined> = {};
const DOM_GLOBALS = [
  "window",
  "document",
  "Element",
  "HTMLElement",
  "HTMLInputElement",
  "Node",
  "Event",
  "KeyboardEvent",
  "location",
  "crypto",
] as const;

beforeEach(() => {
  win = new Window({ url: "http://127.0.0.1:8124/page.html" });
  const g = globalThis as unknown as Record<string, unknown>;
  for (const k of DOM_GLOBALS) savedGlobals[k] = Object.getOwnPropertyDescriptor(globalThis, k);
  g.window = win;
  g.document = win.document;
  g.Element = win.Element;
  g.HTMLElement = win.HTMLElement;
  g.HTMLInputElement = win.HTMLInputElement;
  g.Node = win.Node;
  g.Event = win.Event;
  g.KeyboardEvent = win.KeyboardEvent;
  g.location = win.location;
  g.crypto = win.crypto ?? globalThis.crypto;
});

afterEach(() => {
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

function currentWindow(): Window {
  if (!win) throw new Error("test window not initialized");
  return win;
}

function makeApp(): {
  app: ReturnType<typeof createApp> & AppInternals & { createInteraction: never };
  toasts: string[];
} {
  const host = document.createElement("div");
  document.body.appendChild(host);
  const shadow = host.attachShadow({ mode: "open" });
  const toasts: string[] = [];
  const app = createApp({
    shadow,
    host,
    isTopFrame: true,
    toast: (t) => toasts.push(t),
  }) as ReturnType<typeof createApp> & AppInternals & { createInteraction: never };
  app._setSelf({ id: "me", name: "Me", tint: "#111", initials: "ME" });
  app._setSpaces(
    [
      { id: "s_aaaaaaaaaaaaaaaaaaaa", kind: "personal", name: "Me", role: "admin" },
      { id: "s_bbbbbbbbbbbbbbbbbbbb", kind: "workspace", name: "design", role: "member" },
      { id: "s_cccccccccccccccccccc", kind: "workspace", name: "client", role: "guest" },
    ],
    null,
  );
  return { app, toasts };
}

describe("change composer copy", () => {
  test("send button reads Request edit; variants keeps Generate variants; action seg says Edit", () => {
    const { app } = makeApp();
    const node = changeComposer(
      app,
      { level: "element", selector: "#x" },
      () => {},
      { startVariants: async () => ({ ok: true }) },
      {},
    );
    document.body.appendChild(node);
    const send = node.querySelector(".btn.primary") as HTMLElement;
    expect(send.textContent).toBe("Request edit");
    // the action segment offers Edit / Insert after — never "Change"
    const segLabels = [...node.querySelectorAll(".seg button")].map((b) => b.textContent);
    expect(segLabels).toContain("Edit");
    expect(segLabels).not.toContain("Change");
    // Delivery → Variants flips the send button
    const variantsBtn = [...node.querySelectorAll(".seg button")].find(
      (b) => b.textContent === "Variants",
    ) as HTMLElement;
    variantsBtn.dispatchEvent(trustedClick());
    expect(send.textContent).toBe("Generate variants");
    // placeholder speaks of an edit
    const editor = node.querySelector("[data-placeholder]") as HTMLElement;
    expect(editor.getAttribute("data-placeholder")).toContain("edit");
    expect(editor.getAttribute("data-placeholder")).not.toMatch(/\bchange\b/i);
  });

  test("a sent edit toasts 'edit sent for an agent'", async () => {
    const { app, toasts } = makeApp();
    (app as { createInteraction: unknown }).createInteraction = () => Promise.resolve({ ok: true });
    const node = changeComposer(
      app,
      { level: "page" },
      () => {},
      { startVariants: async () => ({ ok: true }) },
      { pageScope: true },
    );
    document.body.appendChild(node);
    const editor = node.querySelector("[data-placeholder]") as HTMLElement;
    editor.textContent = "tighten the intro";
    const send = node.querySelector(".btn.primary") as HTMLElement;
    const w = currentWindow();
    const e = new w.MouseEvent("click", { bubbles: true }) as unknown as Event;
    Object.defineProperty(e, "isTrusted", { value: true });
    send.dispatchEvent(e);
    await new Promise((r) => setTimeout(r, 0));
    expect(toasts).toEqual(["Edit sent for an agent."]);
  });
});

/* ── change composer keys (§7 — Enter sends, same as the comment composer) ── */

function trustedClick(): Event {
  const w = currentWindow();
  const e = new w.MouseEvent("click", { bubbles: true });
  Object.defineProperty(e, "isTrusted", { value: true });
  return e as unknown as Event;
}

function trustedEnter(shiftKey = false): Event {
  const w = currentWindow();
  const e = new w.KeyboardEvent("keydown", { key: "Enter", bubbles: true, shiftKey });
  Object.defineProperty(e, "isTrusted", { value: true });
  return e as unknown as Event;
}

describe("change composer keys", () => {
  test("Enter submits — runs the same request the Request edit button does", async () => {
    const { app, toasts } = makeApp();
    let calls = 0;
    (app as { createInteraction: unknown }).createInteraction = () => {
      calls++;
      return Promise.resolve({ ok: true });
    };
    const node = changeComposer(
      app,
      { level: "page" },
      () => {},
      { startVariants: async () => ({ ok: true }) },
      { pageScope: true },
    );
    document.body.appendChild(node);
    const editor = node.querySelector("[data-placeholder]") as HTMLElement;
    editor.textContent = "tighten the intro";
    editor.dispatchEvent(trustedEnter());
    await new Promise((r) => setTimeout(r, 0));
    expect(calls).toBe(1);
    expect(toasts).toEqual(["Edit sent for an agent."]);
  });

  test("Enter in the Insert after action routes an insert, not a plain edit", async () => {
    const { app } = makeApp();
    let intent = "";
    (app as { createInteraction: unknown }).createInteraction = (req: {
      change?: { intent?: string };
    }) => {
      intent = req.change?.intent ?? "";
      return Promise.resolve({ ok: true });
    };
    const node = changeComposer(
      app,
      { level: "element", selector: "#x" },
      () => {},
      { startVariants: async () => ({ ok: true }) },
      {},
    );
    document.body.appendChild(node);
    const insertBtn = [...node.querySelectorAll(".seg button")].find(
      (b) => b.textContent === "Insert after",
    ) as HTMLElement;
    insertBtn.dispatchEvent(trustedClick());
    const editor = node.querySelector("[data-placeholder]") as HTMLElement;
    editor.textContent = "a footer";
    editor.dispatchEvent(trustedEnter());
    await new Promise((r) => setTimeout(r, 0));
    expect(intent).toBe("Insert after this anchor: a footer");
  });

  test("Enter in the Variants delivery generates variants (never a direct create)", () => {
    const { app } = makeApp();
    let started = 0;
    let created = 0;
    (app as { createInteraction: unknown }).createInteraction = () => {
      created++;
      return Promise.resolve({ ok: true });
    };
    const node = changeComposer(
      app,
      { level: "element", selector: "#x" },
      () => {},
      {
        startVariants: async () => {
          started++;
          return { ok: true };
        },
      },
      {},
    );
    document.body.appendChild(node);
    const variantsBtn = [...node.querySelectorAll(".seg button")].find(
      (b) => b.textContent === "Variants",
    ) as HTMLElement;
    variantsBtn.dispatchEvent(trustedClick());
    const editor = node.querySelector("[data-placeholder]") as HTMLElement;
    editor.textContent = "three ways";
    editor.dispatchEvent(trustedEnter());
    expect(started).toBe(1);
    expect(created).toBe(0);
  });

  test("synthetic Enter never sends (isTrusted gate)", async () => {
    const { app } = makeApp();
    let calls = 0;
    (app as { createInteraction: unknown }).createInteraction = () => {
      calls++;
      return Promise.resolve({ ok: true });
    };
    const node = changeComposer(
      app,
      { level: "page" },
      () => {},
      { startVariants: async () => ({ ok: true }) },
      { pageScope: true },
    );
    document.body.appendChild(node);
    const editor = node.querySelector("[data-placeholder]") as HTMLElement;
    editor.textContent = "tighten the intro";
    const w = currentWindow();
    // isTrusted defaults false — a page-scripted Enter must never submit.
    editor.dispatchEvent(
      new w.KeyboardEvent("keydown", { key: "Enter", bubbles: true }) as unknown as Event,
    );
    await new Promise((r) => setTimeout(r, 0));
    expect(calls).toBe(0);
  });

  test("Shift+Enter is a newline, not a submit", async () => {
    const { app } = makeApp();
    let calls = 0;
    (app as { createInteraction: unknown }).createInteraction = () => {
      calls++;
      return Promise.resolve({ ok: true });
    };
    const node = changeComposer(
      app,
      { level: "page" },
      () => {},
      { startVariants: async () => ({ ok: true }) },
      { pageScope: true },
    );
    document.body.appendChild(node);
    const editor = node.querySelector("[data-placeholder]") as HTMLElement;
    editor.textContent = "line one";
    editor.dispatchEvent(trustedEnter(true));
    await new Promise((r) => setTimeout(r, 0));
    expect(calls).toBe(0);
  });
});

/* ── hosted surfaces: spaces, sharing, the agent tag ── */

const BANNED_HOSTED = [
  /membrane/i,
  /\bqueue\b/i,
  /element/i,
  /\bChange\b/,
  /popover/i,
  /!/,
  /actor/i,
];

describe("hosted copy", () => {
  test("composers offer the person's spaces, never a guest space or an agent route", () => {
    const { app } = makeApp();
    const node = commentComposer(app, { level: "page" }, () => {});
    document.body.appendChild(node);
    const text = node.textContent ?? "";
    expect(text).toContain("Space");
    expect(text).toContain("Me");
    expect(text).toContain("design");
    expect(text).not.toContain("client");
    const edit = changeComposer(app, { level: "page" }, () => {}, {
      startVariants: async () => ({ ok: true }),
    });
    expect(edit.textContent).not.toMatch(/default agent|send to/i);
    for (const re of BANNED_HOSTED) expect(text).not.toMatch(re);
  });

  test("one space: no space field at all", () => {
    const { app } = makeApp();
    app._setSpaces(
      [{ id: "s_aaaaaaaaaaaaaaaaaaaa", kind: "personal", name: "Me", role: "admin" }],
      null,
    );
    const node = commentComposer(app, { level: "page" }, () => {});
    expect(node.textContent).not.toContain("Space");
  });

  test("the share section and the agent tag speak plainly", () => {
    const { app } = makeApp();
    const node = shareSection(app, "s_bbbbbbbbbbbbbbbbbbbb", "i1", {
      call: () => Promise.resolve({ ok: true, shares: [] }),
      copy: () => Promise.resolve(true),
    });
    document.body.appendChild(node);
    const text = `${node.textContent ?? ""} ${(node.querySelector("input") as HTMLInputElement).placeholder} ${agentTag().textContent}`;
    expect(text).toContain("Shared with");
    expect(text).toContain("Copy link");
    expect(text).toContain("agent");
    for (const re of BANNED_HOSTED) expect(text).not.toMatch(re);
  });
});

describe("the Edit composer at page scope (spec §8, §9)", () => {
  function click(node: Element): void {
    const w = currentWindow();
    const e = new w.MouseEvent("click", { bubbles: true }) as unknown as Event;
    Object.defineProperty(e, "isTrusted", { value: true });
    node.dispatchEvent(e);
  }

  test("offers Variants for the whole page and hands them to the engine", () => {
    const { app } = makeApp();
    const started: string[] = [];
    const node = changeComposer(
      app,
      { level: "page" },
      () => {},
      {
        startVariants: async (cmd) => {
          started.push(cmd);
          return { ok: true };
        },
      },
      { pageScope: true },
    );
    document.body.appendChild(node);
    const variants = [...node.querySelectorAll(".seg button")].find(
      (b) => b.textContent === "Variants",
    ) as HTMLElement;
    expect(variants).toBeDefined();
    // Insert after needs a block; the page has none to insert after.
    expect(
      [...node.querySelectorAll(".seg button")].some((b) => b.textContent === "Insert after"),
    ).toBe(false);
    click(variants);
    (node.querySelector("[data-placeholder]") as HTMLElement).textContent = "darker page";
    click(node.querySelector(".btn.primary") as HTMLElement);
    expect(started).toEqual(["darker page"]);
  });

  test("a sent Edit's confirmation offers Copy for agent", async () => {
    const { app } = makeApp();
    (app as { createInteraction: unknown }).createInteraction = () =>
      Promise.resolve({ ok: true, interactionId: "11111111-2222-4333-8444-555555555555" });
    const node = changeComposer(
      app,
      { level: "page" },
      () => {},
      { startVariants: async () => ({ ok: true }) },
      { pageScope: true },
    );
    document.body.appendChild(node);
    (node.querySelector("[data-placeholder]") as HTMLElement).textContent = "tighten the intro";
    click(node.querySelector(".btn.primary") as HTMLElement);
    await new Promise((r) => setTimeout(r, 0));
    const labels = [...node.querySelectorAll("button")].map((b) => b.textContent);
    expect(labels).toEqual(["Copy for agent", "Done"]);
  });
});
