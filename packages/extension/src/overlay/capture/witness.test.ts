import { expect, test } from "bun:test";
import { type OwnVerdict, ScrollLog } from "./frame-look";
import type { CaptureDraft } from "./index";
import { ResidueLog } from "./residue";
import {
  foreignFrameIn,
  planFrameTiles,
  planTiles,
  tilesTruncated,
  type WitnessDeps,
  witness,
} from "./witness";

function draftOf(habitat: { x: number; y: number; width: number; height: number }): CaptureDraft {
  return {
    interactionId: "int-1",
    kind: "edit-context",
    targetKeySource: "#hero",
    documentHtml: "<!doctype html><html></html>",
    authorsheet: null,
    assetRefs: [],
    parts: [],
    residue: new ResidueLog(),
    meta: {
      viewport: { innerWidth: 800, innerHeight: 600, dpr: 1, layoutWidth: 800 },
      blockRect: { x: 0, y: 0, width: 10, height: 10 },
      habitatRect: habitat,
      quiescence: "settled",
    },
    block: null as unknown as Element,
    scope: null as unknown as Element,
  };
}

// ── pure planner ────────────────────────────────────────────────────────────

test("planTiles returns one tile when the habitat fits the viewport", () => {
  expect(planTiles({ y: 100, height: 80 }, 600, 0.1, 12)).toEqual([100]);
});

test("planTiles steps by innerHeight×(1−overlap) and covers the habitat bottom", () => {
  const tiles = planTiles({ y: 100, height: 2000 }, 600, 0.1, 12);
  expect(tiles).toEqual([100, 640, 1180, 1720]);
  const last = tiles[tiles.length - 1] ?? 0;
  expect(last + 600).toBeGreaterThanOrEqual(2100); // last tile covers the bottom
});

test("planTiles caps at maxTiles; tilesTruncated flags an uncovered habitat", () => {
  const tiles = planTiles({ y: 0, height: 100000 }, 600, 0.1, 3);
  expect(tiles.length).toBe(3);
  expect(tilesTruncated({ y: 0, height: 100000 }, tiles, 600)).toBe(true);
  const full = planTiles({ y: 0, height: 1000 }, 600, 0.1, 12);
  expect(tilesTruncated({ y: 0, height: 1000 }, full, 600)).toBe(false);
});

// ── orchestrator (injected transport) ───────────────────────────────────────

const baseDeps = (over: Partial<WitnessDeps> = {}): WitnessDeps => ({
  viewport: () => ({ innerHeight: 600, dpr: 1, scrollX: 0, scrollY: 0 }),
  watchBlock: () => ({ changed: () => false, stop: () => {} }),
  windowScroll: () => null,
  ...over,
});

test("declined grant → declined-grant residue, no witness part (proceeds honestly)", async () => {
  const draft = draftOf({ x: 0, y: 0, width: 200, height: 80 });
  await witness(draft, baseDeps({ grab: async () => ({ ok: false, reason: "declined-grant" }) }));
  expect(draft.parts.length).toBe(0);
  expect(draft.residue.toArray().some((e) => e.class === "declined-grant")).toBe(true);
});

test("a grab error meters security-error, no witness part", async () => {
  const draft = draftOf({ x: 0, y: 0, width: 200, height: 80 });
  await witness(draft, baseDeps({ grab: async () => ({ ok: false, reason: "error" }) }));
  expect(draft.parts.length).toBe(0);
  expect(draft.residue.toArray().some((e) => e.class === "security-error")).toBe(true);
});

test("single-tile success pushes witness + thumbnail parts", async () => {
  const draft = draftOf({ x: 0, y: 0, width: 200, height: 80 });
  const stitched: unknown[] = [];
  await witness(
    draft,
    baseDeps({
      grab: async () => ({ ok: true, b64: "AAAA", w: 800, h: 600 }),
      stitch: async (req) => {
        stitched.push(req);
        return {
          ok: true,
          b64: "AAAA",
          mime: "image/webp",
          width: 200,
          height: 80,
          thumb: { b64: "AAAA", mime: "image/webp" },
        };
      },
    }),
  );
  expect(draft.parts.map((p) => p.name).sort()).toEqual(["thumbnail", "witness"]);
  expect(draft.parts.find((p) => p.name === "witness")?.role).toBe("witness");
});

test("threads the viewport scrollX into the stitch (horizontal-crop correctness, gpt56-6)", async () => {
  const draft = draftOf({ x: 300, y: 0, width: 200, height: 80 });
  let req: { scrollX?: number } | null = null;
  await witness(
    draft,
    baseDeps({
      viewport: () => ({ innerHeight: 600, dpr: 1, scrollX: 120, scrollY: 0 }),
      grab: async () => ({ ok: true, b64: "AAAA", w: 800, h: 600 }),
      stitch: async (r) => {
        req = r;
        return { ok: true, b64: "AAAA", mime: "image/webp", width: 200, height: 80 };
      },
    }),
  );
  expect((req as unknown as { scrollX: number })?.scrollX).toBe(120);
});

test("a single-tile habitat straddling the fold meters oversize-truncation (§5/A21)", async () => {
  // Fits innerHeight (600) so planTiles → 1 tile, but extends below scrollY(0)+600.
  const draft = draftOf({ x: 0, y: 400, width: 200, height: 400 });
  await witness(
    draft,
    baseDeps({
      viewport: () => ({ innerHeight: 600, dpr: 1, scrollX: 0, scrollY: 0 }),
      grab: async () => ({ ok: true, b64: "AAAA", w: 800, h: 600 }),
      stitch: async () => ({ ok: true, b64: "AAAA", mime: "image/webp", width: 200, height: 400 }),
    }),
  );
  expect(draft.residue.toArray().some((e) => e.class === "oversize-truncation")).toBe(true);
});

test("tall habitat scrolls, reports actual scrollY per tile, and restores scroll", async () => {
  const draft = draftOf({ x: 0, y: 0, width: 200, height: 2000 });
  const scrolls: number[] = [];
  let cur = 0;
  let stitchReq: { tiles: Array<{ scrollY: number }> } | null = null;
  await witness(
    draft,
    baseDeps({
      grab: async () => ({ ok: true, b64: "AAAA", w: 800, h: 600 }),
      stitch: async (req) => {
        stitchReq = req;
        return { ok: true, b64: "AAAA", mime: "image/webp", width: 200, height: 2000 };
      },
      scrollTo: (_x, y) => {
        scrolls.push(y);
        cur = y;
      },
      currentScrollY: () => cur,
      settle: async () => {},
      hideSticky: () => () => {},
    }),
  );
  // multiple tiles were scrolled through and each tile carried its actual scrollY
  expect((stitchReq as unknown as { tiles: unknown[] })?.tiles.length).toBeGreaterThan(1);
  // the scroll was restored to the original position (0) at the end
  expect(scrolls[scrolls.length - 1]).toBe(0);
});

// ── F31: the flat-raster guard ──────────────────────────────────────────────

test("a flat first stitch nudges the block and regrabs; a clean second raster carries no residue", async () => {
  const draft = draftOf({ x: 0, y: 0, width: 200, height: 80 });
  let stitches = 0;
  let nudged = 0;
  await witness(
    draft,
    baseDeps({
      grab: async () => ({ ok: true, b64: "AAAA", w: 800, h: 600 }),
      stitch: async () => {
        stitches += 1;
        return {
          ok: true,
          b64: stitches === 1 ? "FLAT" : "R2VA",
          mime: "image/webp",
          width: 200,
          height: 80,
          flat: stitches === 1,
        };
      },
      nudge: async () => {
        nudged += 1;
      },
    }),
  );
  expect(stitches).toBe(2);
  expect(nudged).toBe(1);
  // the SECOND (clean) raster is the one committed
  expect(draft.parts.find((p) => p.name === "witness")?.bytes).toEqual(
    Uint8Array.from(atob("R2VA"), (c) => c.charCodeAt(0)),
  );
  expect(draft.residue.toArray().some((e) => e.class === "flat-raster")).toBe(false);
});

test("flat through the regrab → parts kept + flat-raster residue (honest, never silent)", async () => {
  const draft = draftOf({ x: 0, y: 0, width: 200, height: 80 });
  await witness(
    draft,
    baseDeps({
      grab: async () => ({ ok: true, b64: "AAAA", w: 800, h: 600 }),
      stitch: async () => ({
        ok: true,
        b64: "AAAA",
        mime: "image/webp",
        width: 200,
        height: 80,
        flat: true,
      }),
      nudge: async () => {},
    }),
  );
  expect(draft.parts.some((p) => p.name === "witness")).toBe(true);
  expect(draft.residue.toArray().some((e) => e.class === "flat-raster")).toBe(true);
});

test("a failed regrab falls back to the flat first raster (+ residue), never to no witness", async () => {
  const draft = draftOf({ x: 0, y: 0, width: 200, height: 80 });
  let grabs = 0;
  await witness(
    draft,
    baseDeps({
      grab: async () => {
        grabs += 1;
        return grabs === 1
          ? { ok: true, b64: "AAAA", w: 800, h: 600 }
          : { ok: false, reason: "error" };
      },
      stitch: async () => ({
        ok: true,
        b64: "AAAA",
        mime: "image/webp",
        width: 200,
        height: 80,
        flat: true,
      }),
      nudge: async () => {},
    }),
  );
  expect(grabs).toBe(2);
  expect(draft.parts.some((p) => p.name === "witness")).toBe(true);
  expect(draft.residue.toArray().some((e) => e.class === "flat-raster")).toBe(true);
  // the failed RETRY grab must not meter security-error — the capture has its witness
  expect(draft.residue.toArray().some((e) => e.class === "security-error")).toBe(false);
});

// ── other origins' frames are never recorded ────────────────────────────────

test("a foreign frame in the rect: no grab at all, cross-origin-frame residue", async () => {
  const draft = draftOf({ x: 0, y: 0, width: 800, height: 600 });
  let grabs = 0;
  await witness(
    draft,
    baseDeps({
      foreignFrame: () => ({ origin: "https://reports.example" }),
      grab: async () => {
        grabs += 1;
        return { ok: true, b64: "AAAA", w: 800, h: 600 };
      },
    }),
  );
  expect(grabs).toBe(0);
  expect(draft.parts).toEqual([]);
  const entry = draft.residue.toArray().find((e) => e.class === "cross-origin-frame");
  expect(entry?.detail).toBe("https://reports.example");
});

test("foreignFrameIn: frames this page cannot read count when they touch the rect", async () => {
  const { Window } = await import("happy-dom");
  const win = new Window({ url: "https://acme.test/page" });
  const doc = win.document as unknown as Document;
  const place = (el: Element, x: number, y: number, w: number, h: number) => {
    (el as unknown as { getBoundingClientRect: () => DOMRect }).getBoundingClientRect = () =>
      ({ left: x, top: y, width: w, height: h }) as DOMRect;
  };
  const report = doc.createElement("embed");
  report.setAttribute("src", "https://reports.example/q3");
  place(report, 0, 900, 400, 300);
  doc.body.append(report);
  try {
    expect(foreignFrameIn({ x: 0, y: 0, width: 800, height: 600 }, doc)).toBeNull();
    expect(foreignFrameIn({ x: 0, y: 800, width: 800, height: 600 }, doc)).toEqual({
      origin: "https://reports.example",
    });
    // An unknown origin (no src) still counts: it cannot be shown to be ours.
    const blank = doc.createElement("object");
    place(blank, 10, 10, 50, 50);
    doc.body.append(blank);
    expect(foreignFrameIn({ x: 0, y: 0, width: 800, height: 600 }, doc)).toEqual({});
  } finally {
    await win.happyDOM.abort();
    win.close();
  }
});

// ── bound to the page, checked before every tile (R2-C2, R2-C4) ─────────────

test("a page change between tiles abandons the capture before the next grab", async () => {
  const draft = draftOf({ x: 0, y: 0, width: 800, height: 2000 });
  let checks = 0;
  draft.verify = () => {
    checks += 1;
    return checks < 2; // holds for the first tile only
  };
  let grabs = 0;
  await witness(
    draft,
    baseDeps({
      foreignFrame: () => null,
      grab: async () => {
        grabs += 1;
        return { ok: true, b64: "AAAA", w: 800, h: 600 };
      },
      scrollTo: () => {},
      settle: async () => {},
      hideSticky: () => () => {},
    }),
  );
  expect(grabs).toBe(1);
  expect(draft.aborted).toBe(true);
  expect(draft.parts).toEqual([]);
});

test("a foreign frame that appears while a tile settles drops the whole raster", async () => {
  const draft = draftOf({ x: 0, y: 0, width: 800, height: 2000 });
  let scans = 0;
  let grabs = 0;
  await witness(
    draft,
    baseDeps({
      // Clear at the start and at the first tile; a frame shows up by the second.
      foreignFrame: () => (++scans >= 3 ? { origin: "https://ads.example" } : null),
      grab: async () => {
        grabs += 1;
        return { ok: true, b64: "AAAA", w: 800, h: 600 };
      },
      scrollTo: () => {},
      settle: async () => {},
      hideSticky: () => () => {},
    }),
  );
  expect(grabs).toBe(1);
  expect(draft.parts).toEqual([]);
  expect(draft.residue.has("cross-origin-frame")).toBe(true);
});

test("a foreign frame that arrives while a tile is being grabbed drops that raster (R3-C5)", async () => {
  const draft = draftOf({ x: 0, y: 0, width: 400, height: 300 });
  let inFlight = false;
  let grabbed = false;
  await witness(
    draft,
    baseDeps({
      // Clear before the grab; the frame lands while the tile is in flight.
      foreignFrame: () => (grabbed ? { origin: "https://ads.example" } : null),
      grab: async () => {
        inFlight = true;
        grabbed = true;
        return { ok: true, b64: "AAAA", w: 400, h: 300 };
      },
    }),
  );
  expect(inFlight).toBe(true);
  expect(draft.parts).toEqual([]);
  expect(draft.residue.has("cross-origin-frame")).toBe(true);
});

test("a host replaced between hiding and the last tile drops the raster (3b-C1)", async () => {
  const draft = draftOf({ x: 0, y: 0, width: 400, height: 300 });
  draft.hostMounts = 1;
  let mounts = 1;
  await witness(
    draft,
    baseDeps({
      foreignFrame: () => null,
      hostMounts: () => mounts,
      grab: async () => {
        mounts = 2; // the overlay remounted while the tile was in flight
        return { ok: true, b64: "AAAA", w: 400, h: 300 };
      },
    }),
  );
  expect(draft.parts).toEqual([]);
});

test("foreignFrameIn looks inside closed shadow roots the extension can see", async () => {
  const { Window } = await import("happy-dom");
  const win = new Window({ url: "https://acme.test/page" });
  const doc = win.document as unknown as Document;
  const host = doc.createElement("x-widget");
  const closed = host.attachShadow({ mode: "closed" });
  const frame = doc.createElement("embed");
  frame.setAttribute("src", "https://reports.example/q3");
  (frame as unknown as { getBoundingClientRect: () => DOMRect }).getBoundingClientRect = () =>
    ({ left: 0, top: 0, width: 300, height: 200 }) as DOMRect;
  closed.appendChild(frame);
  doc.body.appendChild(host);
  const g = globalThis as unknown as Record<string, unknown>;
  const saved = g.chrome;
  g.chrome = { dom: { openOrClosedShadowRoot: (el: Element) => (el === host ? closed : null) } };
  try {
    expect(foreignFrameIn({ x: 0, y: 0, width: 800, height: 600 }, doc)).toEqual({
      origin: "https://reports.example",
    });
  } finally {
    g.chrome = saved;
    await win.happyDOM.abort();
    win.close();
  }
});

test("a tile a same-origin frame did not hold its hide for is dropped (C-1)", async () => {
  const draft = draftOf({ x: 0, y: 0, width: 400, height: 300 });
  const marks: number[] = [];
  draft.frames = {
    sweep: () => {
      marks.push(marks.length + 1);
      return marks.length;
    },
    // A frame that came in during the grab hid only afterwards.
    heldSince: () => false,
    watch: () => () => true,
    release: () => {},
  };
  let stitched = false;
  await witness(
    draft,
    baseDeps({
      foreignFrame: () => null,
      grab: async () => ({ ok: true, b64: "AAAA", w: 400, h: 300 }),
      stitch: async () => {
        stitched = true;
        return { ok: true, b64: "AAAA", mime: "image/webp", width: 400, height: 300 };
      },
    }),
  );
  expect(marks.length).toBe(1); // one mark, taken right before the grab
  expect(stitched).toBe(false);
  expect(draft.parts).toEqual([]);
  expect(draft.dropped).toBe("overlay");
});

test("a tile every same-origin frame held its hide for is kept (C-1)", async () => {
  const draft = draftOf({ x: 0, y: 0, width: 400, height: 300 });
  const asked: Array<{ mark: number }> = [];
  draft.frames = {
    sweep: () => 7,
    heldSince: (_rect, mark) => {
      asked.push({ mark });
      return true;
    },
    watch: () => () => true,
    release: () => {},
  };
  await witness(
    draft,
    baseDeps({
      foreignFrame: () => null,
      grab: async () => ({ ok: true, b64: "AAAA", w: 400, h: 300 }),
      stitch: async () => ({ ok: true, b64: "AAAA", mime: "image/webp", width: 400, height: 300 }),
    }),
  );
  expect(asked).toEqual([{ mark: 7 }]);
  expect(draft.parts.map((p) => p.role)).toEqual(["witness"]);
  expect(draft.dropped).toBeUndefined();
});

test("a tile during which a frame came, went or moved is dropped (2-C1)", async () => {
  const draft = draftOf({ x: 0, y: 0, width: 400, height: 300 });
  const watched: number[] = [];
  let grabbed = false;
  draft.frames = {
    sweep: () => 3,
    heldSince: () => true,
    // Started before the grab; it saw a frame come and go while the tile was taken.
    watch: (_rect, mark) => {
      watched.push(mark);
      expect(grabbed).toBe(false);
      return () => !grabbed;
    },
    release: () => {},
  };
  await witness(
    draft,
    baseDeps({
      foreignFrame: () => null,
      grab: async () => {
        grabbed = true;
        return { ok: true, b64: "AAAA", w: 400, h: 300 };
      },
      stitch: async () => ({ ok: true, b64: "AAAA", mime: "image/webp", width: 400, height: 300 }),
    }),
  );
  expect(watched).toEqual([3]);
  expect(draft.parts).toEqual([]);
  expect(draft.dropped).toBe("overlay");
});

test("the frame watch is taken down when the grab rejects (3-C1)", async () => {
  const draft = draftOf({ x: 0, y: 0, width: 400, height: 300 });
  let started = 0;
  let ended = 0;
  draft.frames = {
    sweep: () => 1,
    heldSince: () => true,
    watch: () => {
      started += 1;
      return () => {
        ended += 1;
        return true;
      };
    },
    release: () => {},
  };
  await expect(
    witness(
      draft,
      baseDeps({
        foreignFrame: () => null,
        grab: async () => {
          throw new Error("worker gone");
        },
      }),
    ),
  ).rejects.toThrow("worker gone");
  expect([started, ended]).toEqual([1, 1]);
});

// ── a block inside a child frame (F-6, L-1, L-2, L-3) ────────────────────────

type Crop = import("../../sw/frame-look").CropResult;

/**
 * A child frame's look with every port stood in: the frame's viewport
 * (600 tall, scrolled by `scrollY`), its scrolling (moving the viewport the
 * nearest way, as the browser does), the locates, the grab and the stitch.
 */
function frameDeps(
  locates: Crop[] | ((rect: { x: number; y: number; width: number; height: number }) => Crop),
  over: Partial<WitnessDeps> = {},
  own: { start?: OwnVerdict; end?: OwnVerdict } = {},
  view: { scrollY?: number; innerHeight?: number } = {},
) {
  const calls: string[] = [];
  const stitched: unknown[] = [];
  const vp = { innerHeight: view.innerHeight ?? 600, scrollY: view.scrollY ?? 100 };
  const deps = baseDeps({
    inChildFrame: () => true,
    viewport: () => ({
      innerHeight: vp.innerHeight,
      innerWidth: 800,
      dpr: 1,
      scrollX: 0,
      scrollY: vp.scrollY,
    }),
    settle: async () => {},
    grab: async () => {
      calls.push("grab");
      return { ok: true, b64: "AAAA", w: 1280, h: 800 };
    },
    stitch: async (req) => {
      stitched.push(req);
      return { ok: true, b64: "AAAA", mime: "image/webp", width: 1, height: 1 };
    },
    hideSticky: () => {
      calls.push("sticky:hide");
      return () => calls.push("sticky:show");
    },
    frameScroll: () => {
      const start = vp.scrollY;
      return {
        reveal: (r) => {
          const lo = 0;
          const hi = vp.innerHeight;
          let d = 0;
          if (r.y < lo || r.height > hi - lo) d = r.y - lo;
          else if (r.y + r.height > hi) d = r.y + r.height - hi;
          if (d !== 0) {
            vp.scrollY += d;
            calls.push(`scroll:${vp.scrollY}`);
          }
          return { dx: 0, dy: -d };
        },
        restore: () => {
          vp.scrollY = start;
          calls.push(`restore:${vp.scrollY}`);
        },
      };
    },
    frameLook: {
      hold: async () => {
        calls.push("hold");
        return {
          holdId: "h1",
          release: () => calls.push("release"),
          renew: () => calls.push("renew"),
        };
      },
      locate: async (rect, holdId, phase, opts) => {
        calls.push(
          `${phase}${opts?.reveal ? "+reveal" : ""}:${holdId}:${rect.x},${rect.y},${rect.width},${rect.height}`,
        );
        if (typeof locates === "function") return locates(rect);
        return locates.shift() ?? { ok: false, reason: "unplaced" };
      },
      ownPixels: () => ({
        start: async () => {
          calls.push("own:start");
          return own.start ?? "own";
        },
        end: async () => {
          calls.push("own:end");
          return own.end ?? "own";
        },
        stop: () => calls.push("own:stop"),
      }),
    },
    ...over,
  });
  return { deps, calls, stitched, vp };
}

const CROP = { x: 344, y: 209, width: 200, height: 80 };
const classes = (d: CaptureDraft): string[] => d.residue.toArray().map((e) => e.class);

test("planFrameTiles: one tile when the block fits; else overlapping tiles to its bottom, capped", () => {
  expect(planFrameTiles(100, 80, 600, 2, 12)).toEqual({
    tiles: [{ y: 100, height: 80 }],
    truncated: false,
  });
  expect(planFrameTiles(0, 1400, 600, 2, 12)).toEqual({
    tiles: [
      { y: 0, height: 600 },
      { y: 598, height: 600 },
      { y: 1196, height: 204 },
    ],
    truncated: false,
  });
  expect(planFrameTiles(0, 10_000, 600, 2, 3)).toEqual({
    tiles: [
      { y: 0, height: 600 },
      { y: 598, height: 600 },
      { y: 1196, height: 600 },
    ],
    truncated: true,
  });
});

test("a child frame's look: hold, locate, grab, locate again, crop in the tab, release", async () => {
  // The block at document y 150 in a frame scrolled by 100: y 50 in the frame's viewport.
  const draft = draftOf({ x: 20, y: 150, width: 200, height: 80 });
  const { deps, calls, stitched } = frameDeps([
    { ok: true, crop: CROP, clamped: false },
    { ok: true, crop: CROP, clamped: false },
  ]);
  await witness(draft, deps);
  expect(calls).toEqual([
    "hold",
    "pre+reveal:h1:20,50,200,80",
    "renew",
    "own:start",
    "grab",
    "post:h1:20,50,200,80",
    "own:end",
    "own:stop",
    "restore:100",
    "release",
  ]);
  expect(stitched).toEqual([
    { tiles: [{ scrollY: 0, b64: "AAAA" }], rect: CROP, dpr: 1, scrollX: 0 },
  ]);
  expect(draft.parts.map((p) => p.role)).toEqual(["witness"]);
  expect(draft.dropped).toBeUndefined();
  expect(draft.residue.isEmpty()).toBe(true);
});

test("a block out of its frame's view is scrolled into it for the look, and the scroll is put back (L-1)", async () => {
  const draft = draftOf({ x: 20, y: 900, width: 200, height: 80 });
  const { deps, calls, stitched, vp } = frameDeps([
    { ok: true, crop: CROP, clamped: false },
    { ok: true, crop: CROP, clamped: false },
  ]);
  await witness(draft, deps);
  // Scrolled the nearest way (its bottom to the viewport's), measured there, put back.
  expect(calls.slice(0, 3)).toEqual(["hold", "scroll:380", "pre+reveal:h1:20,520,200,80"]);
  expect(calls.slice(-2)).toEqual(["restore:100", "release"]);
  expect(vp.scrollY).toBe(100);
  expect(stitched).toHaveLength(1);
  expect(draft.parts.map((p) => p.role)).toEqual(["witness"]);
});

test("every scroll is put back on a failed look too (L-1)", async () => {
  const draft = draftOf({ x: 20, y: 900, width: 200, height: 80 });
  const { deps, calls, vp } = frameDeps([{ ok: false, reason: "unplaced" }]);
  await witness(draft, deps);
  expect(calls).toEqual([
    "hold",
    "scroll:380",
    "pre+reveal:h1:20,520,200,80",
    "restore:100",
    "release",
  ]);
  expect(vp.scrollY).toBe(100);
  expect(draft.parts).toEqual([]);
  expect(draft.dropped).toBe("unplaced");
  expect(classes(draft)).toEqual(["screenshot-unplaced"]);
});

test("a block taller than its frame's view is taken in tiles, each one located and proven (L-1)", async () => {
  // 1400 tall in a viewport of 600: three tiles of the block.
  const draft = draftOf({ x: 20, y: 100, width: 200, height: 1400 });
  const crop = (r: { width: number; height: number }) => ({
    ok: true as const,
    crop: { x: 300, y: 0, width: r.width, height: r.height },
    clamped: false,
  });
  const { deps, calls, stitched, vp } = frameDeps(crop);
  await witness(draft, deps);
  const pres = calls.filter((c) => c.startsWith("pre"));
  expect(pres).toEqual([
    "pre+reveal:h1:20,0,200,600",
    "pre+reveal:h1:20,0,200,600",
    // The last tile, shown the nearest way: its bottom at the viewport's.
    "pre+reveal:h1:20,396,200,204",
  ]);
  // Each tile: its own fresh answers, grab and post-grab locate.
  expect(calls.filter((c) => c === "grab")).toHaveLength(3);
  expect(calls.filter((c) => c === "own:start")).toHaveLength(3);
  expect(calls.filter((c) => c === "own:end")).toHaveLength(3);
  expect(calls.filter((c) => c === "renew")).toHaveLength(3);
  expect(calls).toContain("sticky:hide");
  expect(calls.slice(-3)).toEqual(["sticky:show", "restore:100", "release"]);
  expect(vp.scrollY).toBe(100);
  // Only each tile's proven crop, at its place in the block.
  expect(stitched).toEqual([
    {
      tiles: [
        {
          scrollY: 0,
          b64: "AAAA",
          crop: { x: 300, y: 0, width: 200, height: 600 },
          at: { x: 0, y: 0 },
        },
        {
          scrollY: 0,
          b64: "AAAA",
          crop: { x: 300, y: 0, width: 200, height: 600 },
          at: { x: 0, y: 598 },
        },
        {
          scrollY: 0,
          b64: "AAAA",
          crop: { x: 300, y: 0, width: 200, height: 204 },
          at: { x: 0, y: 1196 },
        },
      ],
      rect: { x: 0, y: 0, width: 200, height: 1400 },
      dpr: 1,
      scrollX: 0,
    },
  ]);
  expect(draft.residue.isEmpty()).toBe(true);
});

test("tiles are as tall as the part of the frame the tab shows (L-1)", async () => {
  const draft = draftOf({ x: 20, y: 100, width: 200, height: 500 });
  let first = true;
  const { deps, stitched } = frameDeps((r) => {
    const view = first ? { view: { x: 0, y: 0, width: 800, height: 300 } } : {};
    first = false;
    return {
      ok: true,
      crop: { x: 0, y: 0, width: r.width, height: r.height },
      clamped: false,
      ...view,
    };
  });
  await witness(draft, deps);
  const tiles = (stitched[0] as { tiles: Array<{ crop: { height: number } }> }).tiles;
  expect(tiles.map((t) => t.crop.height)).toEqual([300, 202]);
});

test("a tile that comes back cut by a frame above drops the whole screenshot (L-1)", async () => {
  const draft = draftOf({ x: 20, y: 100, width: 200, height: 1400 });
  const { deps, calls } = frameDeps((r) => ({
    ok: true,
    crop: { x: 0, y: 0, width: r.width, height: r.height / 2 },
    clamped: true,
  }));
  await witness(draft, deps);
  expect(calls).not.toContain("grab");
  expect(draft.parts).toEqual([]);
  expect(classes(draft)).toEqual(["screenshot-unplaced"]);
});

test("a scaled frame's tiles land where the scale puts them (L-2)", async () => {
  const draft = draftOf({ x: 20, y: 100, width: 200, height: 1400 });
  const scale = { x: 1.25, y: 1.25 };
  const { deps, stitched } = frameDeps((r) => ({
    ok: true,
    crop: { x: 10, y: 20, width: r.width * 1.25, height: r.height * 1.25 },
    clamped: false,
    scale,
  }));
  await witness(draft, deps);
  const out = stitched[0] as {
    tiles: Array<{ at: { y: number } }>;
    rect: { x: number; y: number; width: number; height: number };
  };
  expect(out.tiles.map((t) => t.at.y)).toEqual([0, 598 * 1.25, 1196 * 1.25]);
  expect(out.rect).toEqual({ x: 0, y: 0, width: 250, height: 1750 });
});

test("a frame that can't be located, or that moved during the grab, gives no raster", async () => {
  const lost = draftOf({ x: 20, y: 150, width: 200, height: 80 });
  const a = frameDeps([{ ok: false, reason: "unplaced" }]);
  await witness(lost, a.deps);
  expect(a.calls).toEqual(["hold", "pre+reveal:h1:20,50,200,80", "restore:100", "release"]);
  expect(lost.dropped).toBe("unplaced");
  expect(classes(lost)).toEqual(["screenshot-unplaced"]);

  const moved = draftOf({ x: 20, y: 150, width: 200, height: 80 });
  const b = frameDeps([
    { ok: true, crop: CROP, clamped: false },
    { ok: true, crop: { ...CROP, y: CROP.y + 30 }, clamped: false },
  ]);
  await witness(moved, b.deps);
  expect(b.stitched).toEqual([]);
  expect(moved.parts).toEqual([]);
  expect(moved.dropped).toBe("overlay");
  expect(classes(moved)).toEqual(["screenshot-page-changed"]);
  expect(b.calls.at(-1)).toBe("release");
});

test("a rotated or skewed frame gets no screenshot, and says so (L-2, L-3)", async () => {
  const draft = draftOf({ x: 20, y: 150, width: 200, height: 80 });
  const { deps, calls } = frameDeps([{ ok: false, reason: "transformed" }]);
  await witness(draft, deps);
  expect(calls).not.toContain("grab");
  expect(draft.dropped).toBe("unplaced");
  expect(classes(draft)).toEqual(["screenshot-transformed"]);
});

test("another origin's frame over the crop above the frame drops the raster with its residue", async () => {
  const draft = draftOf({ x: 20, y: 150, width: 200, height: 80 });
  const { deps } = frameDeps([{ ok: false, reason: "foreign-frame" }]);
  await witness(draft, deps);
  expect(draft.parts).toEqual([]);
  expect(draft.dropped).toBe("foreign-frame");
  expect(classes(draft)).toEqual(["screenshot-foreign-frame", "cross-origin-frame"]);
});

test("a frame above that hasn't taken the hold yet is asked once more", async () => {
  const draft = draftOf({ x: 20, y: 150, width: 200, height: 80 });
  const { deps, calls } = frameDeps([
    { ok: false, reason: "overlay" },
    { ok: true, crop: CROP, clamped: true },
    { ok: true, crop: CROP, clamped: true },
  ]);
  await witness(draft, deps);
  expect(calls.filter((c) => c.startsWith("pre"))).toHaveLength(2);
  expect(draft.parts.map((p) => p.role)).toEqual(["witness"]);
  // Only part of the block was shown: said so.
  expect(classes(draft)).toContain("oversize-truncation");
});

test("a child frame's look checks this frame's own binding before the grab", async () => {
  const draft = draftOf({ x: 20, y: 150, width: 200, height: 80 });
  draft.verify = () => false;
  const { deps, calls } = frameDeps([{ ok: true, crop: CROP, clamped: false }]);
  await witness(draft, deps);
  expect(calls).toEqual(["hold", "restore:100", "release"]);
  expect(draft.aborted).toBe(true);
});

test("each reason the frame can't show the crop is its own pixels is said (2-F1, L-3)", async () => {
  const cases: Array<[OwnVerdict, "start" | "end", Crop, string, string]> = [
    ["covered", "start", { ok: true, crop: CROP, clamped: false }, "covered", "screenshot-covered"],
    ["covered", "end", { ok: true, crop: CROP, clamped: false }, "covered", "screenshot-covered"],
    [
      "see-through",
      "start",
      { ok: true, crop: CROP, clamped: false },
      "covered",
      "screenshot-see-through",
    ],
    [
      "moved",
      "end",
      { ok: true, crop: CROP, clamped: false },
      "overlay",
      "screenshot-page-changed",
    ],
    // The browser never confirms a shrunk or stretched frame's pixels: that is said, not "covered".
    [
      "covered",
      "start",
      { ok: true, crop: CROP, clamped: false, scale: { x: 0.8, y: 0.8 } },
      "covered",
      "screenshot-scaled",
    ],
  ];
  for (const [verdict, side, located, why, cls] of cases) {
    const draft = draftOf({ x: 20, y: 150, width: 200, height: 80 });
    const { deps, calls, stitched } = frameDeps([located, located], {}, { [side]: verdict });
    await witness(draft, deps);
    expect(calls.includes("grab")).toBe(side === "end");
    expect(stitched).toEqual([]);
    expect(draft.parts).toEqual([]);
    expect(draft.dropped).toBe(why as never);
    expect(classes(draft)).toEqual([cls]);
    expect(calls.slice(-2)).toEqual(["restore:100", "release"]);
  }
});

test("a block shown by scrolling a pane inside the frame is placed by how far the pane moved it (L-1)", async () => {
  // At document y 900; the pane (not the window) scrolls it up by 500.
  const draft = draftOf({ x: 20, y: 900, width: 200, height: 80 });
  const { deps, calls, stitched, vp } = frameDeps(
    [
      { ok: true, crop: CROP, clamped: false },
      { ok: true, crop: CROP, clamped: false },
    ],
    {
      frameScroll: () => ({
        reveal: () => {
          calls.push("pane:scroll");
          return { dx: 0, dy: -500 };
        },
        restore: () => calls.push("pane:restore"),
      }),
    },
  );
  await witness(draft, deps);
  expect(vp.scrollY).toBe(100);
  expect(calls.slice(0, 3)).toEqual(["hold", "pane:scroll", "pre+reveal:h1:20,300,200,80"]);
  expect(calls.slice(-2)).toEqual(["pane:restore", "release"]);
  expect(stitched).toHaveLength(1);
});

/** A block watch that reports a change once `after` checks have passed (2-L1). */
function changesAfter(after: number) {
  const seen = { checks: 0, started: 0, stopped: 0 };
  return {
    seen,
    watchBlock: () => {
      seen.started += 1;
      return {
        changed: () => {
          seen.checks += 1;
          return seen.checks > after;
        },
        stop: () => {
          seen.stopped += 1;
        },
      };
    },
  };
}

test("a tall block whose content changes between tiles keeps no screenshot (2-L1, top frame)", async () => {
  const draft = draftOf({ x: 0, y: 0, width: 800, height: 2000 });
  const w = changesAfter(1);
  const stitched: unknown[] = [];
  let grabs = 0;
  await witness(
    draft,
    baseDeps({
      foreignFrame: () => null,
      grab: async () => {
        grabs += 1;
        return { ok: true, b64: "AAAA", w: 800, h: 600 };
      },
      stitch: async (req) => {
        stitched.push(req);
        return { ok: true, b64: "AAAA", mime: "image/webp", width: 1, height: 1 };
      },
      scrollTo: () => {},
      currentScrollY: () => 0,
      settle: async () => {},
      hideSticky: () => () => {},
      watchBlock: w.watchBlock,
    }),
  );
  expect(grabs).toBe(2);
  expect(stitched).toEqual([]);
  expect(draft.parts).toEqual([]);
  expect(draft.dropped).toBe("overlay");
  expect(draft.residue.toArray().map((e) => e.class)).toContain("screenshot-page-changed");
  expect([w.seen.started, w.seen.stopped]).toEqual([1, 1]);
});

test("a single-tile look takes no content watch; a steady tall one stitches (2-L1, top frame)", async () => {
  const one = draftOf({ x: 0, y: 0, width: 200, height: 80 });
  const w1 = changesAfter(0);
  await witness(
    one,
    baseDeps({
      foreignFrame: () => null,
      grab: async () => ({ ok: true, b64: "AAAA", w: 800, h: 600 }),
      stitch: async () => ({ ok: true, b64: "AAAA", mime: "image/webp", width: 1, height: 1 }),
      watchBlock: w1.watchBlock,
    }),
  );
  expect(w1.seen.started).toBe(0);
  expect(one.parts.map((p) => p.role)).toEqual(["witness"]);
});

test("a tall block in a frame whose content changes between tiles keeps no screenshot (2-L1)", async () => {
  const draft = draftOf({ x: 20, y: 100, width: 200, height: 1400 });
  const w = changesAfter(1);
  const { deps, calls, stitched } = frameDeps(
    (r) => ({ ok: true, crop: { x: 300, y: 0, width: r.width, height: r.height }, clamped: false }),
    { watchBlock: w.watchBlock },
  );
  await witness(draft, deps);
  expect(calls.filter((c) => c === "grab")).toHaveLength(2);
  expect(stitched).toEqual([]);
  expect(draft.parts).toEqual([]);
  expect(draft.dropped).toBe("overlay");
  expect(classes(draft)).toEqual(["screenshot-page-changed"]);
  expect([w.seen.started, w.seen.stopped]).toEqual([1, 1]);
  expect(calls.slice(-2)).toEqual(["restore:100", "release"]);
});

test("a look in a frame that scrolls the window during a tall top-frame look leaves it where it was before both (3-L2)", async () => {
  // A stand-in window: where it is, and how it is scrolled.
  const at = { x: 0, y: 0 };
  const win = {
    get scrollX() {
      return at.x;
    },
    get scrollY() {
      return at.y;
    },
    scrollTo: (o: ScrollToOptions) => {
      at.x = o.left ?? at.x;
      at.y = o.top ?? at.y;
    },
  } as unknown as Window;
  // The child look's hold, which takes its first position mid-tiles.
  const hold = new ScrollLog();
  let grabs = 0;
  const draft = draftOf({ x: 0, y: 0, width: 200, height: 2000 });
  await witness(
    draft,
    baseDeps({
      foreignFrame: () => null,
      grab: async () => {
        grabs += 1;
        if (grabs === 2) hold.save(win, at.x, at.y);
        return { ok: true, b64: "AAAA", w: 800, h: 600 };
      },
      stitch: async () => ({ ok: true, b64: "AAAA", mime: "image/webp", width: 200, height: 2000 }),
      scrollTo: (x, y) => win.scrollTo({ left: x, top: y }),
      currentScrollY: () => at.y,
      settle: async () => {},
      hideSticky: () => () => {},
      windowScroll: () => win,
    }),
  );
  expect(grabs).toBeGreaterThan(2);
  // The hold still has the window: the tiler leaves it to the hold.
  expect(at.y).toBeGreaterThan(0);
  // The hold lets go last: back to where the window was before either.
  hold.restore();
  expect(at).toEqual({ x: 0, y: 0 });
});
