// 2-A2: a capture is pinned to the block's document from its start. A block
// moved into another document while the capture waits in the queue is not
// captured at all: nothing is walked, grabbed or uploaded, and no other path
// is taken instead.
import { afterEach, beforeEach, expect, test } from "bun:test";
import { Window } from "happy-dom";
import { captureFull, registerCapturePipeline } from "./index";

let win: Window | null = null;
const g = globalThis as unknown as Record<string, unknown>;
const saved: Record<string, unknown> = {};
const KEYS = ["document", "window", "location", "getComputedStyle"];

beforeEach(() => {
  win = new Window({ url: "http://localhost/" });
  Object.defineProperty(win, "origin", { value: "http://localhost", configurable: true });
  for (const key of KEYS) saved[key] = g[key];
  g.window = win;
  g.document = win.document;
  g.location = win.location;
  g.getComputedStyle = win.getComputedStyle.bind(win);
});

afterEach(async () => {
  registerCapturePipeline(null);
  for (const key of KEYS) g[key] = saved[key];
  await win?.happyDOM.close();
  win = null;
});

function counting() {
  const seen = { witness: 0, upload: 0 };
  registerCapturePipeline({
    witness: async () => {
      seen.witness += 1;
    },
    upload: async () => {
      seen.upload += 1;
      return { ok: true, captureId: "cap-1" };
    },
  });
  return seen;
}

function block(): Element {
  const doc = g.document as Document;
  const el = doc.createElement("p");
  el.textContent = "A block.";
  doc.body.appendChild(el);
  return el;
}

test("a block that stays where it was picked is captured", async () => {
  const seen = counting();
  const outcome = await captureFull(block(), "int-1", "snapshot");
  expect(outcome).toEqual({ ok: true, captureId: "cap-1" });
  expect(seen).toEqual({ witness: 1, upload: 1 });
});

test("a block moved into another document before the capture runs is not captured", async () => {
  const seen = counting();
  const el = block();
  const pending = captureFull(el, "int-1", "snapshot");
  // Still connected, now in another page's document (happy-dom cannot adopt
  // across documents: this is what the browser reports after the move).
  const other = new Window({ url: "https://other.example/" });
  other.document.body.appendChild(other.document.createElement("div"));
  Object.defineProperty(el, "ownerDocument", { value: other.document, configurable: true });
  expect(el.isConnected).toBe(true);
  expect(await pending).toBeNull();
  expect(seen).toEqual({ witness: 0, upload: 0 });
  await other.happyDOM.close();
});
