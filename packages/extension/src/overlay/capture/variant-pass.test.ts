// The automatic witness pass runs only for the viewer's own Edit (security
// audit finding 2): another member's variant arriving is a UI update, and
// this page is never rendered, rastered or uploaded for it.
import { afterEach, beforeEach, expect, test } from "bun:test";
import { Window } from "happy-dom";
import { type CaptureDraft, registerCapturePipeline, type WitnessDrop } from "./index";
import {
  boxedParent,
  cancelVariantPasses,
  grown,
  inside,
  lookOmission,
  lookRect,
  observeVariantState,
  type PassDeps,
} from "./variant-pass";

let win: Window | null = null;
beforeEach(() => {
  win = new Window({ url: "https://acme.test/page" });
  (globalThis as unknown as Record<string, unknown>).document = win.document;
});
afterEach(() => {
  cancelVariantPasses(() => true);
  win?.close();
  win = null;
  delete (globalThis as unknown as Record<string, unknown>).document;
});

function deps(owns: boolean, lines: string[], fetched: string[]): PassDeps {
  return {
    engine: {} as PassDeps["engine"],
    ownsEdit: () => owns,
    selfId: () => "p_author",
    account: () => "p_author|https://app.onlay.dev",
    eligible: async () => false,
    fetchSet: async (id) => {
      fetched.push(id);
      return null;
    },
    restoreDisplay: () => {},
    ownsBlocks: true,
    pageUrl: () => "https://acme.test/page",
    log: (l) => lines.push(l),
  };
}

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
const frame = (setId: string) => ({ setId, status: "previewing", changeInteractionId: "edit-1" });

test("someone else's variant schedules nothing", async () => {
  const lines: string[] = [];
  const fetched: string[] = [];
  observeVariantState(frame("set-other"), deps(false, lines, fetched));
  await wait(10);
  expect(lines).toEqual([]);
  expect(fetched).toEqual([]);
});

test("the author's own variant is considered (and then checked for eligibility)", async () => {
  const lines: string[] = [];
  observeVariantState(frame("set-mine"), deps(true, lines, []));
  await wait(10);
  expect(lines.some((l) => l.includes("set-mine"))).toBe(true);
});

test("a look shows the block and what touches it, never the span out to a distant node", () => {
  const root = { x: 100, y: 100, width: 200, height: 50 };
  const parent = { x: 0, y: 0, width: 1000, height: 1000 };
  // An inserted sibling right below (no gap) joins; one far down the page does not.
  const below = { x: 100, y: 150, width: 200, height: 40 };
  const far = { x: 100, y: 900, width: 200, height: 40 };
  expect(lookRect(root, [below, far], parent)).toEqual({ x: 100, y: 100, width: 200, height: 90 });
  // A 1 px gap still touches; 2 px does not.
  expect(lookRect(root, [{ x: 100, y: 151, width: 10, height: 10 }], parent).height).toBe(61);
  expect(lookRect(root, [{ x: 100, y: 152, width: 10, height: 10 }], parent).height).toBe(50);
  // Clamped to the parent's box.
  expect(
    lookRect({ x: -50, y: 10, width: 400, height: 20 }, [], {
      x: 0,
      y: 0,
      width: 300,
      height: 100,
    }),
  ).toEqual({ x: 0, y: 10, width: 300, height: 20 });
});

test("a variant's look stays within the original box grown by max(25%, 160 px) each way (3b-C5)", () => {
  // A small block: 160 px each way wins over a quarter.
  const original = { x: 200, y: 200, width: 200, height: 24 };
  expect(grown(original)).toEqual({ x: 40, y: 40, width: 520, height: 344 });
  const parent = { x: 0, y: 0, width: 2000, height: 2000 };
  // The ordinary case the old clamp refused: one more 24 px line below.
  const wrapped = lookRect({ x: 200, y: 200, width: 200, height: 48 }, [], parent);
  expect(inside(wrapped, grown(original))).toBe(true);
  // An inserted row 200 px tall below: past the 160 px allowance — no look.
  const big = lookRect(original, [{ x: 200, y: 224, width: 200, height: 200 }], parent);
  expect(inside(big, grown(original))).toBe(false);
  // A large block: a quarter of it wins over 160 px.
  const tall = { x: 0, y: 0, width: 2000, height: 1000 };
  expect(grown(tall)).toEqual({ x: -500, y: -250, width: 3000, height: 1500 });
});

test("the look clamps to the nearest ancestor that has a box, skipping display: contents (R3-C10)", () => {
  const doc = win?.document as unknown as Document;
  (globalThis as unknown as Record<string, unknown>).getComputedStyle = (el: Element) =>
    (win as unknown as { getComputedStyle(e: Element): CSSStyleDeclaration }).getComputedStyle(el);
  doc.body.innerHTML =
    '<section id="boxed"><div id="c1" style="display: contents"><div id="c2" style="display: contents"><p id="b">B</p></div></div></section>';
  try {
    expect(boxedParent(doc.getElementById("b") as Element)?.id).toBe("boxed");
    expect(boxedParent(doc.getElementById("boxed") as Element)?.localName).toBe("body");
  } finally {
    delete (globalThis as unknown as Record<string, unknown>).getComputedStyle;
  }
});

test("a variant skipped for a refused op says why, for its row (3b-C5)", async () => {
  const doc = win?.document as unknown as Document;
  doc.body.innerHTML = '<p id="b">B</p>';
  const lines: string[] = [];
  const d: PassDeps = {
    ...deps(true, lines, []),
    eligible: async () => true,
    engine: {
      restore() {},
      apply: () => ({
        ok: true,
        token: 1,
        applied: 0,
        refused: [{ index: 0, reason: "attr-denied" }],
      }),
      applied: () => true,
      insertedRects: () => [],
    } as unknown as PassDeps["engine"],
    fetchSet: async () => ({
      setId: "set-r",
      changeInteractionId: "edit-1",
      status: "previewing",
      expectUrlPrefix: "https://acme.test/page",
      selector: "#b",
      variants: [{ variantId: "v1", program: [], version: 2, by: "p_author" }],
    }),
  };
  const g = globalThis as unknown as Record<string, unknown>;
  g.window = win;
  try {
    observeVariantState(frame("set-r"), d);
    await wait(30);
  } finally {
    delete g.window;
  }
  expect(lookOmission("set-r", "v1", 2)).toBe("refused");
});

/** A page-root variant whose witness refuses the raster for `why` mid-grab (C-5). */
async function pageVariantDropped(
  setId: string,
  why: WitnessDrop,
  cls?: Parameters<CaptureDraft["residue"]["screenshotDropped"]>[0],
): Promise<void> {
  const doc = win?.document as unknown as Document;
  doc.body.innerHTML = '<p id="b">B</p>';
  const d: PassDeps = {
    ...deps(true, [], []),
    eligible: async () => true,
    engine: {
      restore() {},
      apply: () => ({ ok: true, token: 1, applied: 1, refused: [] }),
      applied: () => true,
      insertedRects: () => [],
    } as unknown as PassDeps["engine"],
    fetchSet: async () => ({
      setId,
      changeInteractionId: "edit-1",
      status: "previewing",
      expectUrlPrefix: "https://acme.test/page",
      page: true,
      variants: [{ variantId: "v1", program: [], version: 1, by: "p_author" }],
    }),
  };
  const g = globalThis as unknown as Record<string, unknown>;
  g.window = win;
  // Nothing on the page when the pass checks first: the frame comes in during the grab.
  registerCapturePipeline({
    witness: async (draft) => {
      if (why === "foreign-frame") draft.residue.add("cross-origin-frame");
      if (cls) draft.residue.screenshotDropped(cls);
      draft.dropped = why;
    },
    upload: async () => ({ ok: true, captureId: "c" }),
  });
  try {
    observeVariantState(frame(setId), d);
    for (let i = 0; i < 50 && !lookOmission(setId, "v1", 1); i += 1) await wait(10);
  } finally {
    registerCapturePipeline(null);
    delete g.window;
  }
}

test("a page variant's look dropped for another site's frame says so (C-5)", async () => {
  await pageVariantDropped("set-pf", "foreign-frame");
  expect(lookOmission("set-pf", "v1", 1)).toBe("frame");
});

test("a look dropped because the overlay may be in it says the page changed (C-1, C-5)", async () => {
  await pageVariantDropped("set-po", "overlay");
  expect(lookOmission("set-po", "v1", 1)).toBe("page");
});

test("a look inside a frame dropped because the crop isn't the frame's own pixels says so (E-4)", async () => {
  await pageVariantDropped("set-pc", "covered");
  expect(lookOmission("set-pc", "v1", 1)).toBe("covered");
});

test("a look inside a frame whose block couldn't be located says so (E-4)", async () => {
  await pageVariantDropped("set-pu", "unplaced");
  expect(lookOmission("set-pu", "v1", 1)).toBe("unplaced");
});

test("a child frame that owns its blocks runs the pass; one that owns none does not (E-4)", async () => {
  const lines: string[] = [];
  observeVariantState(frame("set-noblocks"), { ...deps(true, lines, []), ownsBlocks: false });
  await wait(20);
  expect(lines).toEqual([]);
  observeVariantState(frame("set-child"), deps(true, lines, []));
  await wait(20);
  expect(lines.some((l) => l.includes("set-child"))).toBe(true);
});

test("inside a frame, the witness's exact reason is the variant's note (E-4)", async () => {
  await pageVariantDropped("set-st", "covered", "screenshot-see-through");
  expect(lookOmission("set-st", "v1", 1)).toBe("see-through");
  await pageVariantDropped("set-sc", "covered", "screenshot-scaled");
  expect(lookOmission("set-sc", "v1", 1)).toBe("scaled");
  await pageVariantDropped("set-tr", "unplaced", "screenshot-transformed");
  expect(lookOmission("set-tr", "v1", 1)).toBe("transformed");
});

/** A block-root set on #b whose picked block is pinned as `pin` says (3-E1). */
async function pinnedPass(
  setId: string,
  pin: (root: Element) => { el: Element; held: () => boolean },
  duringGrab: () => void = () => {},
): Promise<{ grabs: number; uploads: number }> {
  const doc = win?.document as unknown as Document;
  doc.body.innerHTML = '<p id="b">B</p><p id="other">O</p>';
  const counts = { grabs: 0, uploads: 0 };
  const picked = pin(doc.getElementById("b") as Element);
  const d: PassDeps = {
    ...deps(true, [], []),
    eligible: async () => true,
    pinOf: (id) => (id === setId ? picked : undefined),
    engine: {
      restore() {},
      apply: () => ({ ok: true, token: 1, applied: 1, refused: [] }),
      applied: () => true,
      insertedRects: () => [],
    } as unknown as PassDeps["engine"],
    fetchSet: async () => ({
      setId,
      changeInteractionId: "edit-1",
      status: "previewing",
      expectUrlPrefix: "https://acme.test/page",
      selector: "#b",
      variants: [{ variantId: "v1", program: [], version: 1, by: "p_author" }],
    }),
  };
  const g = globalThis as unknown as Record<string, unknown>;
  g.window = win;
  g.getComputedStyle = (el: Element) => (win as Window).getComputedStyle(el as never);
  registerCapturePipeline({
    witness: async () => {
      counts.grabs += 1;
      duringGrab();
    },
    upload: async () => {
      counts.uploads += 1;
      return { ok: true, captureId: "c" };
    },
  });
  try {
    observeVariantState(frame(setId), d);
    // Until the pass is done: a grab and its upload, or a note saying why not.
    for (let i = 0; i < 100; i += 1) {
      if (counts.uploads > 0 || lookOmission(setId, "v1", 1) || (counts.grabs > 0 && i > 30)) break;
      await wait(10);
    }
  } finally {
    registerCapturePipeline(null);
    delete g.window;
    delete g.getComputedStyle;
  }
  return counts;
}

test("a variant look is of the block as it was picked: another block under its selector gets none (3-E1)", async () => {
  const doc = () => win?.document as unknown as Document;
  const r = await pinnedPass("set-pin-other", () => ({
    el: doc().getElementById("other") as Element,
    held: () => true,
  }));
  expect(r).toEqual({ grabs: 0, uploads: 0 });
  expect(lookOmission("set-pin-other", "v1", 1)).toBe("page");
});

test("a picked block that moves during the look never reaches upload (3-E1)", async () => {
  let held = true;
  const r = await pinnedPass(
    "set-pin-moved",
    (root) => ({ el: root, held: () => held }),
    () => {
      held = false;
    },
  );
  expect(r.grabs).toBe(1);
  expect(r.uploads).toBe(0);
});

test("a picked block whose pin holds gets its look (3-E1)", async () => {
  const r = await pinnedPass("set-pin-ok", (root) => ({ el: root, held: () => true }));
  expect(r).toEqual({ grabs: 1, uploads: 1 });
});
