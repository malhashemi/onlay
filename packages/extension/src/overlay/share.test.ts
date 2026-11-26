// The share field lives inside the thread panel and the modal, which build
// their body afresh on every render (a state frame, a picture arriving). What
// the person typed there, and the caret, outlive that rebuild; a share that
// went through clears it.
import { afterEach, beforeEach, expect, test } from "bun:test";
import { Window } from "happy-dom";
import { type AppInternals, createApp } from "./app";
import { shareSection } from "./share";

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
] as const;

beforeEach(() => {
  win = new Window({ url: "http://127.0.0.1:8124/page.html" });
  const g = globalThis as unknown as Record<string, unknown>;
  const w = win as unknown as Record<string, unknown>;
  for (const k of DOM_GLOBALS) {
    savedGlobals[k] = Object.getOwnPropertyDescriptor(globalThis, k);
    g[k] = k === "window" ? win : w[k];
  }
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

const SPACE = "s_bbbbbbbbbbbbbbbbbbbb";
const flush = () => new Promise((r) => setTimeout(r, 0));

function rig() {
  const host = document.createElement("div");
  document.body.appendChild(host);
  const shadow = host.attachShadow({ mode: "open" });
  const app = createApp({ shadow, host, isTopFrame: true, toast: () => {} }) as ReturnType<
    typeof createApp
  > &
    AppInternals;
  const calls: Array<Record<string, unknown>> = [];
  const deps = {
    call: (m: Record<string, unknown>) => {
      calls.push(m);
      return Promise.resolve({ ok: true, shares: [] });
    },
    copy: () => Promise.resolve(true),
  };
  /** The section as a render builds it, in place of the last one. */
  const build = (id: string): HTMLInputElement => {
    while (shadow.firstChild) shadow.removeChild(shadow.firstChild);
    shadow.appendChild(shareSection(app, SPACE, id, deps as never));
    return shadow.querySelector("input") as HTMLInputElement;
  };
  return { shadow, build, calls };
}

function type(input: HTMLInputElement, text: string): void {
  input.focus();
  input.value = text;
  input.dispatchEvent(new (win as Window).Event("input", { bubbles: true }) as unknown as Event);
}

test("what is typed in the share field, and the caret, outlive a rebuild of the panel", async () => {
  const r = rig();
  type(r.build("i1"), "dee@example.test");
  // A state frame arrives: the panel builds its body again.
  const again = r.build("i1");
  await flush();
  expect(again.value).toBe("dee@example.test");
  expect(r.shadow.activeElement).toBe(again);
  // Another thread's field starts empty.
  expect(r.build("i2").value).toBe("");
});

test("a share that went through clears what was typed", async () => {
  const r = rig();
  const input = r.build("i3");
  type(input, "dee@example.test");
  const share = [...r.shadow.querySelectorAll("button")].find((b) => b.textContent === "Share");
  const click = new (win as Window).MouseEvent("click", { bubbles: true }) as unknown as Event;
  Object.defineProperty(click, "isTrusted", { value: true });
  share?.dispatchEvent(click);
  await flush();
  expect(r.calls).toContainEqual(expect.objectContaining({ op: "add", email: "dee@example.test" }));
  expect(r.build("i3").value).toBe("");
});

test("an address typed while a share is on its way stays when the share lands", async () => {
  const r = rig();
  const input = r.build("i4");
  type(input, "dee@example.test");
  const share = [...r.shadow.querySelectorAll("button")].find((b) => b.textContent === "Share");
  const click = new (win as Window).MouseEvent("click", { bubbles: true }) as unknown as Event;
  Object.defineProperty(click, "isTrusted", { value: true });
  share?.dispatchEvent(click);
  // Before the answer: the panel rebuilds, and the person types the next address.
  const again = r.build("i4");
  type(again, "eve@example.test");
  await flush();
  expect(again.value).toBe("eve@example.test");
  expect(r.build("i4").value).toBe("eve@example.test");
});

test("a share that lands after a rebuild clears the field the person sees", async () => {
  const r = rig();
  type(r.build("i5"), "dee@example.test");
  const share = [...r.shadow.querySelectorAll("button")].find((b) => b.textContent === "Share");
  const click = new (win as Window).MouseEvent("click", { bubbles: true }) as unknown as Event;
  Object.defineProperty(click, "isTrusted", { value: true });
  share?.dispatchEvent(click);
  const again = r.build("i5");
  expect(again.value).toBe("dee@example.test");
  await flush();
  expect(again.value).toBe("");
});
