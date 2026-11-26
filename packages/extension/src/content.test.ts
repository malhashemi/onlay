/// <reference types="chrome" />
// The content script's entry surface (ADR-0019), mounted for real under
// happy-dom: Ctrl+. toggles the command bar (and is guarded in inputs), the
// `cs` chord arms the copy-block pick, and the global mode-click handler
// stays isTrusted-gated — page JS can synthesize clicks, so an untrusted
// click must never drive a privileged pick while a trusted one is honored.
import { afterEach, beforeEach, expect, test } from "bun:test";
import { Window } from "happy-dom";

let win: Window | null = null;
let writes: string[] = [];
// bun runs every test file in ONE process — restore each global we stub so we
// never strip `navigator`/`document` out from under other suites (react-dom et al).
const GLOBALS = [
  "window",
  "document",
  "location",
  "Element",
  "HTMLElement",
  "HTMLInputElement",
  "Node",
  "Event",
  "MouseEvent",
  "KeyboardEvent",
  "CSSStyleSheet",
  "MutationObserver",
  "Document",
  "ShadowRoot",
  "getSelection",
  "crypto",
  "chrome",
  "navigator",
] as const;
const saved: Record<string, PropertyDescriptor | undefined> = {};

function chromeMock(): unknown {
  return {
    runtime: {
      // Every mount-time probe (getStatus/getDirectory/getAttention) + app.send.
      sendMessage: () => Promise.resolve({ ok: false }),
      onMessage: { addListener: () => {} },
    },
    // prefs (keyboard map + launcher position) ride chrome.storage.local.
    storage: {
      local: {
        get: () => Promise.resolve({}),
        set: () => Promise.resolve(),
        remove: () => Promise.resolve(),
      },
      onChanged: { addListener: () => {}, removeListener: () => {} },
    },
  };
}

beforeEach(() => {
  win = new Window({ url: "http://127.0.0.1:8124/page.html" });
  writes = [];
  const g = globalThis as unknown as Record<string, unknown>;
  for (const k of GLOBALS) saved[k] = Object.getOwnPropertyDescriptor(globalThis, k);
  g.window = win;
  g.document = win.document;
  g.location = win.location;
  g.Element = win.Element;
  g.HTMLElement = win.HTMLElement;
  g.HTMLInputElement = win.HTMLInputElement;
  g.Node = win.Node;
  g.Event = win.Event;
  g.MouseEvent = win.MouseEvent;
  g.KeyboardEvent = win.KeyboardEvent;
  g.CSSStyleSheet = win.CSSStyleSheet;
  g.MutationObserver = win.MutationObserver;
  g.Document = win.Document;
  g.ShadowRoot = win.ShadowRoot;
  g.getSelection = () => win?.document.getSelection() ?? null;
  g.crypto = win.crypto ?? globalThis.crypto;
  g.chrome = chromeMock();
  g.navigator = {
    clipboard: {
      writeText: (t: string) => {
        writes.push(t);
        return Promise.resolve();
      },
    },
  };
});

afterEach(() => {
  win?.happyDOM.cancelAsync();
  win?.close();
  win = null;
  const g = globalThis as unknown as Record<string, unknown>;
  for (const k of GLOBALS) {
    const desc = saved[k];
    if (desc) Object.defineProperty(globalThis, k, desc);
    else delete g[k];
  }
});

const flush = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

function currentWindow(): Window {
  if (!win) throw new Error("test window not initialized");
  return win;
}

/** A person's key (trusted), unless `trusted: false` says the page made it up. */
function pressKey(key: string, over: Record<string, unknown> = {}, trusted = true): void {
  const w = currentWindow();
  const e = new w.KeyboardEvent("keydown", {
    key,
    bubbles: true,
    cancelable: true,
    ...over,
  }) as unknown as Event;
  if (trusted) Object.defineProperty(e, "isTrusted", { value: true });
  (w.window as unknown as Window & typeof globalThis).dispatchEvent(e);
}

test("Ctrl+. toggles the command bar; chords arm picks; only trusted clicks drive them", async () => {
  const w = currentWindow();
  const doc = w.document as unknown as Document;
  // A real page element the pick handler will target (happy-dom's
  // elementFromPoint returns null, so pin it to our target).
  const target = doc.createElement("p");
  target.textContent = "victim";
  doc.body.appendChild(target);
  (doc as unknown as { elementFromPoint: () => Element }).elementFromPoint = () => target;

  // The overlay's root is closed: record the one reference the script keeps.
  const proto = w.HTMLElement.prototype as unknown as {
    attachShadow(init: { mode: string }): ShadowRoot;
  };
  const realAttach = proto.attachShadow;
  let captured: ShadowRoot | null = null;
  let mode = "";
  proto.attachShadow = function (this: unknown, init: { mode: string }) {
    mode = init.mode;
    captured = realAttach.call(this, init);
    return captured;
  };

  // Mount the real content script (runs its IIFE against the installed globals).
  await import("./content");
  await flush(); // prefs land async → chords + accelerator bind
  await flush();
  proto.attachShadow = realAttach;

  // The page sees a host and nothing inside it.
  expect(mode).toBe("closed");
  expect((doc.querySelector("[data-onlay-root]") as HTMLElement).shadowRoot).toBeNull();
  const shadow = captured as unknown as ShadowRoot;
  const backdrop = shadow.querySelector(".bar-backdrop") as HTMLElement;
  const toast = shadow.querySelector(".toast") as HTMLElement;
  expect(backdrop).toBeTruthy();
  expect(shadow.querySelector(".orb")).toBeTruthy(); // the launcher renders

  // ── a key the page synthesized opens nothing ──
  pressKey(".", { ctrlKey: true }, false);
  expect(backdrop.style.display).not.toBe("block");

  // ── Ctrl+. opens the bar; Ctrl+. again closes it ──
  pressKey(".", { ctrlKey: true });
  expect(backdrop.style.display).toBe("block");
  pressKey(".", { ctrlKey: true });
  expect(backdrop.style.display).toBe("none");

  // ── Ctrl+. in a page input does nothing (editable guard) ──
  const pageInput = doc.createElement("input");
  doc.body.appendChild(pageInput);
  pageInput.focus();
  pressKey(".", { ctrlKey: true });
  expect(backdrop.style.display).toBe("none");
  pageInput.blur();
  pageInput.remove();

  // ── the `cs` chord arms the copy-block pick ──
  pressKey("c");
  pressKey("s");
  expect(toast.textContent).toBe("copy — click a block (Esc cancels)");

  const clickAt = (trusted: boolean): Event => {
    const e = new w.MouseEvent("click", {
      bubbles: true,
      cancelable: true,
      clientX: 5,
      clientY: 5,
    }) as unknown as Event;
    if (trusted) Object.defineProperty(e, "isTrusted", { value: true, configurable: true });
    try {
      (w.window as unknown as Window & typeof globalThis).dispatchEvent(e);
    } catch {
      // downstream mode work may throw under happy-dom — the gate already ran
    }
    return e;
  };

  // Synthetic (untrusted) click: the gate rejects it — no preventDefault, no
  // clipboard write, the pick stays armed.
  const synthetic = clickAt(false);
  expect(synthetic.defaultPrevented).toBe(false);
  expect(writes.length).toBe(0);

  // A made-up pointer move over another block steers nothing: the pick acts
  // on what is under the trusted click itself.
  const decoy = doc.createElement("p");
  decoy.textContent = "decoy";
  doc.body.appendChild(decoy);
  (doc as unknown as { elementFromPoint: () => Element }).elementFromPoint = () => decoy;
  (w.window as unknown as Window & typeof globalThis).dispatchEvent(
    new w.MouseEvent("mousemove", { bubbles: true, clientX: 9, clientY: 9 }) as unknown as Event,
  );
  (doc as unknown as { elementFromPoint: () => Element }).elementFromPoint = () => target;

  // Trusted click: honored — the handler claims the event and copies.
  const trusted = clickAt(true);
  expect(trusted.defaultPrevented).toBe(true);
  expect(writes.length).toBe(1);
  expect(writes[0]).toContain("victim");
  expect(writes[0]).not.toContain("decoy");
  await flush();
  expect(toast.textContent).toContain("block HTML copied");
});
