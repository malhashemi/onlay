/// <reference types="chrome" />
// The composer's space field against the person's spaces as they are now:
// the menu offers only spaces they still belong to, a membership change closes
// an open menu, and a send to a space lost since it was chosen sends nothing,
// keeps the text and says so.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { SpaceSummary } from "@onlay/protocol";
import { Window } from "happy-dom";
import { type AppInternals, createApp } from "./app";
import { changeComposer, commentComposer } from "./composers";
import { setDraftScope } from "./drafts";
import { closeAnySpaceMenu, SPACE_PICKER_COPY, spacePicker } from "./space-picker";

const A = "s_aaaaaaaaaaaaaaaaaaaa";
const B = "s_bbbbbbbbbbbbbbbbbbbb";
const C = "s_cccccccccccccccccccc";
const SPACES: SpaceSummary[] = [
  { id: A, kind: "personal", name: "Me", role: "admin" },
  { id: B, kind: "workspace", name: "design", role: "member" },
  { id: C, kind: "workspace", name: "growth", role: "member" },
];

let win: Window | null = null;
let sent: Array<Record<string, unknown>> = [];

beforeEach(() => {
  win = new Window({ url: "https://app.example/page" });
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
  closeAnySpaceMenu();
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
  app._setSpaces(SPACES, C);
  return { app, shadow };
}

function type(box: HTMLElement, text: string): void {
  box.textContent = text;
  box.dispatchEvent(new Event("input", { bubbles: true }));
}
const editor = (root: ParentNode) => root.querySelector("[contenteditable]") as HTMLElement;
const button = (root: ParentNode, label: string) =>
  [...root.querySelectorAll("button")].find((b) => b.textContent === label) as HTMLElement;
const options = (root: ParentNode) =>
  [...root.querySelectorAll("[role=option] .space-select-name")].map((o) => o.textContent);
const menuOpen = (root: ParentNode) =>
  (root.querySelector(".space-select-menu") as HTMLElement).style.display !== "none";

describe("the composer's space field", () => {
  test("its menu offers the spaces there are when it opens, and closes on a membership change", () => {
    const { app, shadow } = makeApp();
    const picker = spacePicker(app);
    shadow.appendChild(picker.element as HTMLElement);
    const field = shadow.querySelector(".space-select-field") as HTMLElement;
    trustedClick(field);
    expect(options(shadow)).toEqual(["Me", "design", "growth"]);
    // Access to "design" ends while the menu is open: content.ts closes it.
    app._setSpaces(
      SPACES.filter((s) => s.id !== B),
      null,
    );
    expect(closeAnySpaceMenu()).toBe(true);
    expect(menuOpen(shadow)).toBe(false);
    trustedClick(field);
    expect(options(shadow)).toEqual(["Me", "growth"]);
  });

  test("a Comment to a space lost since it was chosen sends nothing, keeps its text and says so", async () => {
    const { app, shadow } = makeApp();
    const view = commentComposer(app, { level: "page" }, () => {});
    shadow.appendChild(view);
    type(editor(view), "ship it");
    app._setSpaces(
      SPACES.filter((s) => s.id !== C),
      null,
    );
    trustedClick(button(view, "Comment"));
    await flush();
    expect(sent.filter((m) => m.type === "interaction-create")).toEqual([]);
    expect(editor(view).textContent).toBe("ship it");
    expect(view.textContent).toContain(SPACE_PICKER_COPY.lost);
    // Another space chosen, the same text goes there.
    trustedClick(view.querySelector(".space-select-field") as HTMLElement);
    expect(options(shadow)).toEqual(["Me", "design"]);
    trustedClick(
      [...view.querySelectorAll("[role=option]")].find((o) =>
        o.textContent?.startsWith("design"),
      ) as HTMLElement,
    );
    trustedClick(button(view, "Comment"));
    await flush();
    expect(sent.filter((m) => m.type === "interaction-create")).toMatchObject([
      { spaceId: B, body: { text: "ship it" } },
    ]);
  });

  test("an Edit to a lost space sends nothing either", async () => {
    const { app, shadow } = makeApp();
    let variants = 0;
    const view = changeComposer(
      app,
      { level: "page" },
      () => {},
      {
        startVariants: () => {
          variants++;
          return Promise.resolve({ ok: true });
        },
      },
      { pageScope: true },
    );
    shadow.appendChild(view);
    type(editor(view), "make the title bigger");
    app._setSpaces(
      SPACES.filter((s) => s.id !== C),
      null,
    );
    trustedClick(button(view, "Request edit"));
    await flush();
    expect(sent.filter((m) => m.type === "interaction-create")).toEqual([]);
    expect(variants).toBe(0);
    expect(editor(view).textContent).toBe("make the title bigger");
    expect(view.textContent).toContain(SPACE_PICKER_COPY.lost);
  });
});
