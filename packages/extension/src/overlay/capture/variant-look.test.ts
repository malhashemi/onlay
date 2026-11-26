// captureVariantLook — the F31 gate: a variant-look IS its witness, so a
// raster that stayed flat through the nudge-and-regrab must never upload
// (absence demotes the stop honestly; the unmarked key retries later).
import { afterEach, beforeEach, expect, test } from "bun:test";
import { Window } from "happy-dom";
import { type CaptureDraft, captureVariantLook, registerCapturePipeline } from "./index";

let win: Window | null = null;
const g = globalThis as unknown as Record<string, unknown>;
const saved: Record<string, unknown> = {};

beforeEach(() => {
  win = new Window({ url: "http://localhost/" });
  for (const key of ["document", "window", "location"]) {
    saved[key] = g[key];
    g[key] = (win as unknown as Record<string, unknown>)[key === "window" ? "window" : key];
  }
  g.window = win;
});

afterEach(() => {
  registerCapturePipeline(null);
  for (const key of ["document", "window", "location"]) g[key] = saved[key];
  win?.close?.();
  win = null;
});

const input = (block: Element) => ({
  block,
  interactionId: "int-1",
  rect: () => ({ x: 0, y: 0, width: 10, height: 10 }),
  variantMeta: { variantSetId: "set-1", variantId: "v-1", variantVersion: 1 },
  verify: () => true,
});

function blockEl(): Element {
  const doc = (g.document as Document | undefined) ?? document;
  const el = doc.createElement("div");
  doc.body.appendChild(el);
  return el;
}

test("a flat-through-retry witness refuses the upload (returns null, upload never called)", async () => {
  let uploads = 0;
  registerCapturePipeline({
    witness: async (draft: CaptureDraft) => {
      draft.residue.add("flat-raster");
      draft.parts.push({
        name: "witness",
        role: "witness",
        mime: "image/webp",
        bytes: new Uint8Array([1]),
      });
    },
    upload: async () => {
      uploads += 1;
      return { ok: true, captureId: "cap-1" };
    },
  });
  const outcome = await captureVariantLook(input(blockEl()));
  expect(outcome).toBeNull();
  expect(uploads).toBe(0);
});

test("a clean witness uploads and returns the committed outcome", async () => {
  let uploads = 0;
  registerCapturePipeline({
    witness: async (draft: CaptureDraft) => {
      draft.parts.push({
        name: "witness",
        role: "witness",
        mime: "image/webp",
        bytes: new Uint8Array([1]),
      });
    },
    upload: async () => {
      uploads += 1;
      return { ok: true, captureId: "cap-1" };
    },
  });
  const outcome = await captureVariantLook(input(blockEl()));
  expect(outcome).toEqual({ ok: true, captureId: "cap-1" });
  expect(uploads).toBe(1);
});

test("a verify that fails after the grabs discards without uploading (clobbered preview)", async () => {
  const verdicts = [true, false]; // pre-grab passes, post-grab fails
  let uploads = 0;
  registerCapturePipeline({
    witness: async (draft: CaptureDraft) => {
      draft.parts.push({
        name: "witness",
        role: "witness",
        mime: "image/webp",
        bytes: new Uint8Array([1]),
      });
    },
    upload: async () => {
      uploads += 1;
      return { ok: true, captureId: "cap-1" };
    },
  });
  const outcome = await captureVariantLook({
    ...input(blockEl()),
    verify: () => verdicts.shift() ?? false,
  });
  expect(outcome).toBeNull();
  expect(uploads).toBe(0);
});
