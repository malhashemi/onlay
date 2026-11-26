// Typing isolation (R2-C1): events from inside the overlay stop at `window`
// before any page listener, and the overlay's own listeners still run, in DOM
// order, with the original event (isTrusted intact).
import { afterEach, beforeEach, expect, test } from "bun:test";
import { Window } from "happy-dom";
import { hostInPlace, mountHost } from "./host";
import { installTypingIsolation, onRouted, onWindowRouted, ROUTED_TYPES } from "./typing-router";

let win: Window | null = null;
beforeEach(() => {
  win = new Window({ url: "https://site.test/page" });
  (globalThis as unknown as Record<string, unknown>).document = win.document;
});
afterEach(() => {
  win?.close();
  win = null;
  delete (globalThis as unknown as Record<string, unknown>).document;
});

function rig() {
  const w = win as Window;
  const doc = w.document as unknown as Document;
  const window = w as unknown as Window & typeof globalThis;
  let mounted: { host: Element; root: ShadowRoot } | null = null;
  installTypingIsolation(window as unknown as globalThis.Window, () => mounted);
  // The page registers afterwards, in both phases, on window and document.
  const page: string[] = [];
  for (const type of ROUTED_TYPES) {
    for (const t of [window, doc] as EventTarget[]) {
      t.addEventListener(type, (e) => page.push(`${type}:${(e as KeyboardEvent).key ?? ""}`), true);
      t.addEventListener(type, (e) => page.push(`${type}:${(e as KeyboardEvent).key ?? ""}`));
    }
  }
  const m = mountHost(doc, "closed");
  mounted = m;
  const input = doc.createElement("textarea");
  m.root.appendChild(input);
  input.focus();
  return { w, doc, window, m, input, page };
}

function key(r: ReturnType<typeof rig>, type: string, k: string, trusted = true): Event {
  const e = new r.w.KeyboardEvent(type, {
    key: k,
    bubbles: true,
    composed: true,
    cancelable: true,
  });
  if (trusted) Object.defineProperty(e, "isTrusted", { value: true });
  return e as unknown as Event;
}

test("a key typed in the overlay never reaches the page's window or document listeners", () => {
  const r = rig();
  const seen: string[] = [];
  onRouted<KeyboardEvent>(r.input, "keydown", (e) => seen.push(e.key));
  r.input.dispatchEvent(key(r, "keydown", "s"));
  expect(r.page).toEqual([]);
  expect(seen).toEqual(["s"]);
});

test("routed listeners see the original event: isTrusted, preventDefault, the inner target", () => {
  const r = rig();
  let trusted: boolean | null = null;
  let target: unknown = null;
  onRouted<KeyboardEvent>(r.input, "keydown", (e) => {
    trusted = e.isTrusted;
    target = e.target;
    e.preventDefault();
  });
  const ev = key(r, "keydown", "Enter");
  r.input.dispatchEvent(ev);
  expect(trusted as boolean | null).toBe(true);
  expect(target).toBe(r.input);
  expect(ev.defaultPrevented).toBe(true);
});

test("overlay window listeners run first (capture), and stopPropagation stops the routed walk", () => {
  const r = rig();
  const order: string[] = [];
  onWindowRouted<KeyboardEvent>(
    r.window as unknown as globalThis.Window,
    "keydown",
    () => order.push("window-capture"),
    {
      capture: true,
    },
  );
  onRouted(r.m.root, "keydown", () => order.push("root-bubble"));
  onRouted<KeyboardEvent>(r.input, "keydown", (e) => {
    order.push("input");
    e.stopPropagation();
  });
  r.input.dispatchEvent(key(r, "keydown", "Escape"));
  expect(order).toEqual(["window-capture", "input"]);
  expect(r.page).toEqual([]);
});

test("input, composition and clipboard events stay inside too", () => {
  const r = rig();
  for (const type of [
    "beforeinput",
    "input",
    "compositionstart",
    "compositionend",
    "paste",
    "copy",
    "cut",
  ]) {
    const e = new r.w.Event(type, { bubbles: true, composed: true });
    r.input.dispatchEvent(e as unknown as Event);
  }
  expect(r.page).toEqual([]);
});

test("the page still hears its own typing", () => {
  const r = rig();
  const field = r.doc.createElement("input");
  r.doc.body.appendChild(field);
  field.focus(); // the person is typing on the page, not in onlay
  field.dispatchEvent(key(r, "keydown", "p"));
  expect(r.page.filter((x) => x === "keydown:p").length).toBe(4);
});

test("the host is a plain div that says only that it is onlay's", () => {
  const w = win as Window;
  const m = mountHost(w.document as unknown as Document, "closed");
  expect(m.host.localName).toBe("div");
  expect(m.host.getAttributeNames().sort()).toEqual(["data-onlay-root", "style"]);
  expect(m.host.parentNode).toBe((w.document as unknown as Document).documentElement);
  expect(hostInPlace(m)).toBe(true);
});

test("a host whose root Chrome reports differently is never used", () => {
  const w = win as Window;
  const g = globalThis as unknown as Record<string, unknown>;
  const saved = g.chrome;
  g.chrome = { dom: { openOrClosedShadowRoot: () => ({}) as ShadowRoot } };
  try {
    expect(() => mountHost(w.document as unknown as Document, "closed")).toThrow();
    expect((w.document as unknown as Document).querySelector("[data-onlay-root]")).toBeNull();
  } finally {
    g.chrome = saved;
  }
});

test("a host moved into a page's shadow tree, or anywhere else, is out of place", () => {
  const w = win as Window;
  const doc = w.document as unknown as Document;
  const m = mountHost(doc, "closed");
  const outer = doc.createElement("page-widget");
  doc.body.appendChild(outer);
  const pageRoot = outer.attachShadow({ mode: "closed" });
  pageRoot.appendChild(m.host);
  expect(hostInPlace(m)).toBe(false);
  doc.body.appendChild(m.host);
  expect(hostInPlace(m)).toBe(false);
});

test("a host adopted into another document is out of place, even at that document's top level (3b-C2)", () => {
  const w = win as Window;
  const doc = w.document as unknown as Document;
  const m = mountHost(doc, "closed");
  const other = doc.implementation.createHTMLDocument("elsewhere");
  other.documentElement.appendChild(other.adoptNode(m.host));
  expect(m.host.parentNode).toBe(other.documentElement);
  expect(hostInPlace(m)).toBe(false);
});

test("while focus is inside the overlay, events are stopped whatever their target appears to be", () => {
  const r = rig();
  const seen: string[] = [];
  onRouted<KeyboardEvent>(r.input, "keydown", (e) => seen.push(e.key));
  // Retargeted to some page element (as when the page moved the host into its
  // own shadow tree): the focus rule still catches it.
  r.window.dispatchEvent(key(r, "keydown", "q"));
  expect(r.page).toEqual([]);
  expect(seen).toEqual(["q"]);
});

test("a host the page moved is not routed into: the event stops and the guard remounts", () => {
  const w = win as Window;
  const doc = w.document as unknown as Document;
  const window = w as unknown as Window & typeof globalThis;
  const m = mountHost(doc, "closed");
  let misplaced = 0;
  installTypingIsolation(window as unknown as globalThis.Window, () => m, {
    inPlace: hostInPlace,
    misplaced: () => {
      misplaced += 1;
    },
  });
  const page: string[] = [];
  window.addEventListener("keydown", (e) => page.push((e as unknown as KeyboardEvent).key), true);
  const input = doc.createElement("textarea");
  m.root.appendChild(input);
  input.focus();
  const routed: string[] = [];
  onRouted<KeyboardEvent>(input, "keydown", (e) => routed.push(e.key));
  const outer = doc.createElement("page-widget");
  doc.body.appendChild(outer);
  outer.attachShadow({ mode: "open" }).appendChild(m.host);
  input.dispatchEvent(key({ w } as never, "keydown", "z"));
  expect(page).toEqual([]);
  expect(routed).toEqual([]);
  expect(misplaced).toBe(1);
});

test("a drop or a non-keyboard paste aimed at the page reaches it while an overlay editor has focus (3b-C3)", () => {
  const r = rig();
  const uploader = r.doc.createElement("div");
  r.doc.body.appendChild(uploader);
  expect(r.m.root.activeElement).toBe(r.input);
  uploader.dispatchEvent(new r.w.Event("drop", { bubbles: true }) as unknown as Event);
  uploader.dispatchEvent(new r.w.Event("paste", { bubbles: true }) as unknown as Event);
  expect(r.page.filter((p) => p.startsWith("drop") || p.startsWith("paste")).length).toBe(8);
});

test("a paste made by a keyboard chord typed into the overlay is still routed, whatever its target (3b-C3)", () => {
  const r = rig();
  const seen: string[] = [];
  onRouted(r.input, "paste", () => seen.push("paste"));
  const elsewhere = r.doc.createElement("div");
  r.doc.body.appendChild(elsewhere);
  const chord = new r.w.KeyboardEvent("keydown", { key: "v", ctrlKey: true, bubbles: true });
  elsewhere.dispatchEvent(chord as unknown as Event);
  elsewhere.dispatchEvent(new r.w.Event("paste", { bubbles: true }) as unknown as Event);
  expect(r.page).toEqual([]);
  expect(seen).toEqual(["paste"]);
});

test("a drop on the overlay itself is still routed (3b-C3)", () => {
  const r = rig();
  r.input.dispatchEvent(
    new r.w.Event("drop", { bubbles: true, composed: true }) as unknown as Event,
  );
  expect(r.page).toEqual([]);
});
