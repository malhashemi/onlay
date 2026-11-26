import { expect, test } from "bun:test";
import {
  composeCrop,
  composePlace,
  createFrameLocator,
  frameTileDraw,
  type LocateReport,
  sameCrop,
} from "./frame-look";

const report = (over: Partial<LocateReport> = {}): LocateReport => ({
  box: { x: 100, y: 50, width: 400, height: 300 },
  clip: { x: 0, y: 0, width: 1280, height: 800 },
  foreign: [],
  held: true,
  ...over,
});

test("the block's rect is carried up by each frame's box", () => {
  const r = composeCrop({ x: 10, y: 20, width: 80, height: 30 }, [
    report(),
    report({ box: { x: 5, y: 7, width: 1000, height: 700 } }),
  ]);
  expect(r).toEqual({ ok: true, crop: { x: 115, y: 77, width: 80, height: 30 }, clamped: false });
});

test("the crop is cut to the visible part of the frame and said to be clamped", () => {
  // The frame is scrolled half out of its parent's clipping box.
  const r = composeCrop({ x: 0, y: 0, width: 100, height: 100 }, [
    report({ clip: { x: 0, y: 0, width: 1280, height: 100 } }),
  ]);
  expect(r).toEqual({ ok: true, crop: { x: 100, y: 50, width: 100, height: 50 }, clamped: true });
});

test("a block out of view gets no look", () => {
  expect(
    composeCrop({ x: 0, y: 0, width: 50, height: 50 }, [
      report({ clip: { x: 0, y: 400, width: 1280, height: 400 } }),
    ]),
  ).toEqual({ ok: false, reason: "unplaced" });
  expect(composeCrop({ x: 0, y: 0, width: 50, height: 50 }, [])).toEqual({
    ok: false,
    reason: "unplaced",
  });
});

test("another origin's frame over the crop in any frame on the path drops the look; one beside it does not", () => {
  const block = { x: 0, y: 0, width: 50, height: 50 };
  // In tab coordinates the crop is 100..150 × 50..100.
  expect(
    composeCrop(block, [report({ foreign: [{ x: 140, y: 90, width: 30, height: 30 }] })]),
  ).toEqual({ ok: false, reason: "foreign-frame" });
  expect(
    composeCrop(block, [report({ foreign: [{ x: 300, y: 300, width: 30, height: 30 }] })]).ok,
  ).toBe(true);
  // Higher up the path, in that frame's coordinates.
  expect(
    composeCrop(block, [
      report(),
      report({
        box: { x: 0, y: 0, width: 1280, height: 800 },
        foreign: [{ x: 120, y: 60, width: 5, height: 5 }],
      }),
    ]),
  ).toEqual({ ok: false, reason: "foreign-frame" });
});

test("a frame on the path whose overlay did not hold, or whose frames moved, drops the look", () => {
  const block = { x: 0, y: 0, width: 50, height: 50 };
  expect(composeCrop(block, [report({ held: false })])).toEqual({ ok: false, reason: "overlay" });
  expect(composeCrop(block, [report({ steady: false })])).toEqual({ ok: false, reason: "overlay" });
  expect(composeCrop(block, [report({ steady: true })]).ok).toBe(true);
});

test("numbers that are not numbers place nothing", () => {
  expect(composeCrop({ x: Number.NaN, y: 0, width: 1, height: 1 }, [report()])).toEqual({
    ok: false,
    reason: "unplaced",
  });
  expect(
    composeCrop({ x: 0, y: 0, width: 1, height: 1 }, [
      report({ box: { x: Number.POSITIVE_INFINITY, y: 0, width: 1, height: 1 } }),
    ]),
  ).toEqual({ ok: false, reason: "unplaced" });
});

test("two crops are the same place to half a pixel", () => {
  const a = { x: 1, y: 1, width: 10, height: 10 };
  expect(sameCrop(a, { x: 1.4, y: 1, width: 10, height: 10 })).toBe(true);
  expect(sameCrop(a, { x: 2, y: 1, width: 10, height: 10 })).toBe(false);
});

/* ── the locate chain ── */

const F = { tab: { id: 7 }, frameId: 4, documentId: "DOC-F", documentLifecycle: "active" };
const P = { tab: { id: 7 }, frameId: 2, documentId: "DOC-P", documentLifecycle: "active" };
const TOP = { tab: { id: 7 }, frameId: 0, documentId: "DOC-TOP", documentLifecycle: "active" };
const OTHER_TAB = { tab: { id: 9 }, frameId: 0, documentId: "DOC-X", documentLifecycle: "active" };

function locator() {
  const sent: Array<{ tabId: number; msg: Record<string, unknown>; to?: unknown }> = [];
  let n = 0;
  const timers: Array<() => void> = [];
  const l = createFrameLocator({
    send: async (tabId, msg, to) => {
      sent.push({ tabId, msg, to });
    },
    nonce: () => `n${++n}`,
    setTimer: (fn) => timers.push(fn),
    clearTimer: () => {},
  });
  return { l, sent, timers };
}

const wire = (r: LocateReport) => ({ ...r });
const rect = { x: 10, y: 10, width: 20, height: 20 };

const K1 = "challenge-one-0000";
const K2 = "challenge-two-0000";

test("a locate climbs frame by frame to the top, each hop bound both ways (2-F2)", async () => {
  const { l, sent } = locator();
  const result = l.locate({ holdId: "h1", phase: "pre", rect }, F);
  await Promise.resolve();
  expect(sent[0]).toEqual({
    tabId: 7,
    to: { documentId: "DOC-F" },
    msg: { type: "frame-locate-up", nonce: "n1", holdId: "h1", phase: "pre", rect },
  });
  // P measured the frame whose window it posted K1 to; F echoes K1 and says its parent isn't the top.
  expect(l.located({ nonce: "n1", challenge: K1, ...wire(report()) }, P)).toEqual({ ok: true });
  expect(sent).toHaveLength(1); // not yet: the echo is missing
  expect(l.echoed({ nonce: "n1", challenge: K1, parentIsTop: false }, F)).toEqual({ ok: true });
  await Promise.resolve();
  // The next nonce goes to P, with the block's rect in P's viewport.
  expect(sent[1]?.to).toEqual({ documentId: "DOC-P" });
  expect(sent[1]?.msg).toMatchObject({
    nonce: "n2",
    rect: { x: 110, y: 60, width: 20, height: 20 },
  });
  // The echo may come first.
  expect(l.echoed({ nonce: "n2", challenge: K2, parentIsTop: true }, P)).toEqual({ ok: true });
  l.located(
    {
      nonce: "n2",
      challenge: K2,
      ...wire(report({ box: { x: 0, y: 0, width: 1280, height: 800 } })),
    },
    TOP,
  );
  expect(await result).toEqual({
    ok: true,
    crop: { x: 110, y: 60, width: 20, height: 20 },
    clamped: false,
  });
});

test("an echo from any document but the measured one, or with another challenge, places nothing (2-F2)", async () => {
  {
    const { l } = locator();
    const result = l.locate({ holdId: "h1", phase: "pre", rect }, F);
    await Promise.resolve();
    l.located({ nonce: "n1", challenge: K1, ...wire(report()) }, TOP);
    // Another document of the tab can't echo for F.
    expect(l.echoed({ nonce: "n1", challenge: K1, parentIsTop: true }, P)).toEqual({ ok: false });
    // F's echo of another challenge: the parent measured some other window.
    l.echoed({ nonce: "n1", challenge: K2, parentIsTop: true }, F);
    expect(await result).toEqual({ ok: false, reason: "unplaced" });
  }
});

test("a child whose parent is the top must be measured by frame 0, and only then (2-F2)", async () => {
  {
    const { l } = locator();
    const result = l.locate({ holdId: "h1", phase: "pre", rect }, F);
    await Promise.resolve();
    l.located({ nonce: "n1", challenge: K1, ...wire(report()) }, P);
    l.echoed({ nonce: "n1", challenge: K1, parentIsTop: true }, F);
    expect(await result).toEqual({ ok: false, reason: "unplaced" });
  }
  {
    const { l } = locator();
    const result = l.locate({ holdId: "h1", phase: "pre", rect }, F);
    await Promise.resolve();
    l.located({ nonce: "n1", challenge: K1, ...wire(report()) }, TOP);
    l.echoed({ nonce: "n1", challenge: K1, parentIsTop: false }, F);
    expect(await result).toEqual({ ok: false, reason: "unplaced" });
  }
});

test("a report from another tab, from the frame itself, or a second report for a nonce is not taken", async () => {
  const { l } = locator();
  const result = l.locate({ holdId: "h1", phase: "pre", rect }, F);
  await Promise.resolve();
  const r = { nonce: "n1", challenge: K1, ...wire(report()) };
  expect(l.located(r, OTHER_TAB)).toEqual({ ok: false });
  expect(l.located(r, F)).toEqual({ ok: false });
  expect(l.located({ ...r, nonce: "nope" }, TOP)).toEqual({ ok: false });
  expect(l.located({ ...r, challenge: "short" }, TOP)).toEqual({ ok: false });
  // The first real report wins; a copy of the nonce after it changes nothing.
  l.located({ ...r, ...wire(report({ box: { x: 1, y: 1, width: 900, height: 900 } })) }, TOP);
  expect(l.located(r, TOP)).toEqual({ ok: false });
  l.echoed({ nonce: "n1", challenge: K1, parentIsTop: true }, F);
  expect(await result).toMatchObject({ ok: true, crop: { x: 11, y: 11 } });
});

test("only a child frame locates, and a locate nobody answers gives up", async () => {
  const { l, timers } = locator();
  expect(await l.locate({ holdId: "h1", phase: "pre", rect }, TOP)).toEqual({
    ok: false,
    reason: "sender",
  });
  expect(await l.locate({ holdId: "h 1", phase: "pre", rect }, F)).toEqual({
    ok: false,
    reason: "invalid",
  });
  const result = l.locate({ holdId: "h1", phase: "post", rect }, F);
  await Promise.resolve();
  for (const t of timers) t();
  expect(await result).toEqual({ ok: false, reason: "unplaced" });
});

test("a malformed report places nothing", async () => {
  const { l } = locator();
  const result = l.locate({ holdId: "h1", phase: "pre", rect }, F);
  await Promise.resolve();
  l.located({ nonce: "n1", challenge: K1, box: "x", clip: {}, foreign: [], held: true }, TOP);
  l.echoed({ nonce: "n1", challenge: K1, parentIsTop: true }, F);
  expect(await result).toEqual({ ok: false, reason: "unplaced" });
});

/* ── scaled and shifted frames (L-2), what of the frame the tab shows (L-1) ── */

test("a frame under a scale is mapped through it; frames above multiply theirs", () => {
  // The frame's content box at (100, 50) in its parent, drawn at 0.8.
  const r = composeCrop({ x: 10, y: 20, width: 80, height: 30 }, [
    report({ box: { x: 100, y: 50, width: 320, height: 240 }, scale: { x: 0.8, y: 0.8 } }),
  ]);
  expect(r).toEqual({
    ok: true,
    crop: { x: 108, y: 66, width: 64, height: 24 },
    clamped: false,
    scale: { x: 0.8, y: 0.8 },
  });
  // A non-uniform scale higher up the path, over a shift.
  const two = composeCrop({ x: 0, y: 0, width: 100, height: 100 }, [
    report({ box: { x: 10, y: 10, width: 400, height: 300 } }),
    report({ box: { x: 0, y: 0, width: 2000, height: 600 }, scale: { x: 2, y: 1 } }),
  ]);
  expect(two).toEqual({
    ok: true,
    crop: { x: 20, y: 10, width: 200, height: 100 },
    clamped: false,
    scale: { x: 2, y: 1 },
  });
});

test("a rotated, skewed or 3D frame on the path is refused for that, and a scale out of bounds places nothing", () => {
  const block = { x: 0, y: 0, width: 50, height: 50 };
  expect(composeCrop(block, [report({ tilted: true })])).toEqual({
    ok: false,
    reason: "transformed",
  });
  expect(composeCrop(block, [report(), report({ tilted: true, held: false })])).toEqual({
    ok: false,
    reason: "transformed",
  });
  expect(composeCrop(block, [report({ scale: { x: -1, y: 1 } })])).toEqual({
    ok: false,
    reason: "unplaced",
  });
  expect(composeCrop(block, [report({ scale: { x: Number.NaN, y: 1 } })])).toEqual({
    ok: false,
    reason: "unplaced",
  });
});

test("with the frame's viewport size, the part of it the tab shows comes back in the frame's own pixels", () => {
  // A 400×900 frame viewport whose content box shows from y 50; the parent shows only to y 650.
  const r = composeCrop(
    { x: 0, y: 0, width: 100, height: 100 },
    [
      report({
        box: { x: 100, y: 50, width: 400, height: 900 },
        clip: { x: 0, y: 0, width: 1280, height: 650 },
      }),
    ],
    { width: 400, height: 900 },
  );
  expect(r.ok && r.view).toEqual({ x: 0, y: 0, width: 400, height: 600 });
  // Through a scale of 0.5: 300 of the parent's pixels are 600 of the frame's.
  const half = composeCrop(
    { x: 0, y: 0, width: 100, height: 100 },
    [
      report({
        box: { x: 0, y: 0, width: 200, height: 450 },
        clip: { x: 0, y: 0, width: 1280, height: 300 },
        scale: { x: 0.5, y: 0.5 },
      }),
    ],
    { width: 400, height: 900 },
  );
  expect(half.ok && half.view).toEqual({ x: 0, y: 0, width: 400, height: 600 });
});

test("a pre-grab locate that asks to reveal carries it up every hop, with the frame's viewport (L-1)", async () => {
  const { l, sent } = locator();
  const result = l.locate(
    { holdId: "h1", phase: "pre", rect, reveal: true, viewport: { width: 400, height: 300 } },
    F,
  );
  await Promise.resolve();
  expect(sent[0]?.msg).toMatchObject({ type: "frame-locate-up", reveal: true });
  l.located({ nonce: "n1", challenge: K1, ...wire(report()) }, P);
  l.echoed({ nonce: "n1", challenge: K1, parentIsTop: false }, F);
  await Promise.resolve();
  expect(sent[1]?.msg).toMatchObject({ nonce: "n2", reveal: true });
  l.echoed({ nonce: "n2", challenge: K2, parentIsTop: true }, P);
  l.located(
    {
      nonce: "n2",
      challenge: K2,
      ...wire(report({ box: { x: 0, y: 0, width: 1280, height: 800 } })),
    },
    TOP,
  );
  const r = (await result) as { ok: boolean; view?: unknown };
  expect(r.ok).toBe(true);
  expect(r.view).toEqual({ x: 0, y: 0, width: 400, height: 300 });
  // A post-grab locate never reveals, whatever it asks.
  const { l: l2, sent: sent2 } = locator();
  void l2.locate({ holdId: "h1", phase: "post", rect, reveal: true }, F);
  await Promise.resolve();
  expect(sent2[0]?.msg.reveal).toBeUndefined();
});

test("a scale a parent reports is read; a malformed one places nothing", async () => {
  const { l } = locator();
  const result = l.locate({ holdId: "h1", phase: "pre", rect }, F);
  await Promise.resolve();
  l.echoed({ nonce: "n1", challenge: K1, parentIsTop: true }, F);
  l.located({ nonce: "n1", challenge: K1, ...wire(report()), scale: { x: "big", y: 1 } }, TOP);
  expect(await result).toEqual({ ok: false, reason: "unplaced" });
});

test("a tile draws exactly its proven crop, at its place, cut to the screenshot and the output", () => {
  expect(
    frameTileDraw(
      { x: 100, y: 50, width: 200, height: 300 },
      { x: 0, y: 598 },
      2,
      { width: 2560, height: 1600 },
      { width: 400, height: 2800 },
    ),
  ).toEqual({ sx: 200, sy: 100, sw: 400, sh: 600, dx: 0, dy: 1196 });
  // Past the output's bottom: cut there.
  expect(
    frameTileDraw(
      { x: 0, y: 0, width: 100, height: 100 },
      { x: 0, y: 50 },
      1,
      { width: 800, height: 600 },
      { width: 100, height: 120 },
    ),
  ).toEqual({ sx: 0, sy: 0, sw: 100, sh: 70, dx: 0, dy: 50 });
  // Outside the screenshot: nothing.
  expect(
    frameTileDraw(
      { x: 900, y: 0, width: 100, height: 100 },
      { x: 0, y: 0 },
      1,
      { width: 800, height: 600 },
      { width: 100, height: 100 },
    ),
  ).toBeNull();
});

/* ── a placement: where a child frame's viewport sits, once, for a composer card ── */

test("a placement climbs like a locate, carries no rect, and needs no hold or clear view", async () => {
  const { l, sent } = locator();
  const result = l.locate({ holdId: "p1", phase: "place", rect }, F);
  await Promise.resolve();
  // The page-visible hop carries the nonce and an empty rect: nothing of the block.
  expect(sent[0]?.msg).toEqual({
    type: "frame-locate-up",
    nonce: "n1",
    holdId: "p1",
    phase: "place",
    rect: { x: 0, y: 0, width: 0, height: 0 },
  });
  // P did not hold, and another origin's frame covers everything: still placed.
  const cover = { x: 0, y: 0, width: 5000, height: 5000 };
  l.located({ nonce: "n1", challenge: K1, ...wire(report({ held: false, foreign: [cover] })) }, P);
  l.echoed({ nonce: "n1", challenge: K1, parentIsTop: false }, F);
  await Promise.resolve();
  expect(sent[1]?.msg).toMatchObject({ nonce: "n2", phase: "place", rect: { width: 0 } });
  l.located(
    {
      nonce: "n2",
      challenge: K2,
      ...wire(
        report({
          held: false,
          box: { x: 30, y: 40, width: 800, height: 600 },
          scale: { x: 2, y: 2 },
        }),
      ),
    },
    TOP,
  );
  l.echoed({ nonce: "n2", challenge: K2, parentIsTop: true }, P);
  // F's origin: 30 + 100·2, 40 + 50·2; the top's hop is the ref the top frame keeps.
  expect(await result).toEqual({
    ok: true,
    origin: { x: 230, y: 140 },
    scale: { x: 2, y: 2 },
  });
});

test("a placement through a rotated frame, or with no answer, places nothing", async () => {
  const { l, timers } = locator();
  const tilted = l.locate({ holdId: "p1", phase: "place", rect }, F);
  await Promise.resolve();
  l.located({ nonce: "n1", challenge: K1, ...wire(report({ tilted: true })) }, TOP);
  l.echoed({ nonce: "n1", challenge: K1, parentIsTop: true }, F);
  expect(await tilted).toEqual({ ok: false, reason: "transformed" });

  const silent = l.locate({ holdId: "p2", phase: "place", rect }, F);
  await Promise.resolve();
  for (const t of timers) t();
  expect(await silent).toEqual({ ok: false, reason: "unplaced" });
  expect(composePlace([])).toEqual({ ok: false, reason: "unplaced" });
  expect(composePlace([report({ scale: { x: 0, y: 1 } })])).toEqual({
    ok: false,
    reason: "unplaced",
  });
});
