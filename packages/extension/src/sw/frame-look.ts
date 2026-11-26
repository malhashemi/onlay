// A look of a block inside a child frame F (round 3, F-6). The screenshot is
// the tab's, so the block's box must be known in TAB coordinates. Each grab
// re-establishes it, one frame at a time from F up to the top:
//
//   1. F asks for a locate (`frameLocate`); the service worker mints a nonce,
//      bound to F's tab and document, and hands it to F (`frame-locate-up`).
//   2. F posts the nonce to its parent window. The parent's content script
//      finds the frame element whose window sent it, measures that frame's
//      content box, the part of its own viewport that shows it, every frame
//      of another origin that could cover it, and whether its overlay has
//      held hidden for this grab, and reports that to the service worker
//      (`frameLocated`) with the nonce.
//   3. The service worker takes the first report for a nonce from a frame of
//      the same tab, other than the one it was minted for. Below the top
//      frame it mints the next nonce for the reporter, which posts it to its
//      own parent; the top frame's report closes the chain.
//
// The numbers come only from our content scripts' own measurements, carried
// by the service worker; the page-visible message carries nothing but the
// nonce and which hold and phase it is for. A page that copies the nonce is
// too late: the first report wins, and it comes from the content script that
// heard the real message first.
//
// The overlay is hidden in every frame of the tab for the grab
// (`frameHold` / `frameRelease`, relayed to every frame).
//
// The same chain, in its `place` phase, tells a child frame once where its
// own viewport sits in the tab (`composePlace`), so the top frame's composer
// card can open beside a block picked there. It proves nothing about pixels:
// no hold, no reveal, no foreign frames, and the page-visible message carries
// the nonce and an empty rect. A rotated, skewed or 3D frame on the path, a
// missing answer or any doubt places nothing.

export interface Box {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** One frame's report about the child frame on the path, in its own viewport's coordinates. */
export interface LocateReport {
  /** The child frame's content box (where its viewport sits), as it appears here. */
  box: Box;
  /**
   * How many of this frame's CSS pixels one of the child's is (L-2): a frame
   * under a translation and/or a positive scale, with no rotation, skew or 3D,
   * on itself or on any element holding it. Absent is 1 on both axes.
   */
  scale?: { x: number; y: number };
  /** The child frame, or an element holding it, is rotated, skewed or 3D: it can't be mapped (L-2). */
  tilted?: boolean;
  /** What part of this frame's viewport is shown (its viewport, cut by clipping ancestors). */
  clip: Box;
  /** Frames of another (or an unknown) origin here, other than the one on the path. */
  foreign: Box[];
  /** This frame's overlay held hidden for this grab, and same-origin frames under it too. */
  held: boolean;
  /** Post-grab only: no frame here came, went or moved over the path during the grab. */
  steady?: boolean;
}

/** Why the block's place in the tab could not be used for a screenshot. */
export type CropRefusal = "foreign-frame" | "overlay" | "unplaced" | "transformed";

export type CropResult =
  | {
      ok: true;
      /** The block's rect in the tab's viewport (CSS px of the top document). */
      crop: Box;
      clamped: boolean;
      /** Tab pixels per CSS pixel of the capturing frame, on each axis (L-2). */
      scale?: { x: number; y: number };
      /** The part of the capturing frame's viewport the tab shows, in that frame's viewport (L-1). */
      view?: Box;
    }
  | { ok: false; reason: CropRefusal };

function intersect(a: Box, b: Box): Box | null {
  const x = Math.max(a.x, b.x);
  const y = Math.max(a.y, b.y);
  const r = Math.min(a.x + a.width, b.x + b.width);
  const btm = Math.min(a.y + a.height, b.y + b.height);
  if (r - x <= 0 || btm - y <= 0) return null;
  return { x, y, width: r - x, height: btm - y };
}

const finite = (b: Box): boolean =>
  [b.x, b.y, b.width, b.height].every((n) => Number.isFinite(n)) && b.width >= 0 && b.height >= 0;

/** A scale a report may carry: positive, finite and not absurd. */
const MIN_SCALE = 0.01;
const MAX_SCALE = 100;
const fineScale = (s: { x: number; y: number }): boolean =>
  [s.x, s.y].every((n) => Number.isFinite(n) && n >= MIN_SCALE && n <= MAX_SCALE);

/**
 * The block's rect `inFrame` (F's viewport coordinates, already cut to F's
 * viewport) carried up the path: at each frame, mapped through the child
 * frame's box and scale, cut to that box and to the frame's visible part; any
 * foreign frame there that touches what is left drops the look, as does a
 * frame whose overlay did not hold, and a frame that is rotated, skewed or 3D
 * (its pixels are not where any box says). Reports run from F's parent to the
 * top frame. With F's viewport size, the part of F's viewport the tab shows
 * comes back too, in F's own coordinates.
 */
export function composeCrop(
  inFrame: Box,
  reports: readonly LocateReport[],
  viewport?: { width: number; height: number },
): CropResult {
  if (!finite(inFrame) || reports.length === 0) return { ok: false, reason: "unplaced" };
  let rect: Box | null = inFrame;
  let vis: Box | null =
    viewport && Number.isFinite(viewport.width) && Number.isFinite(viewport.height)
      ? { x: 0, y: 0, width: viewport.width, height: viewport.height }
      : null;
  // Where F's viewport origin is, and how big one of F's pixels is, in the frame reached so far.
  let origin = { x: 0, y: 0 };
  let scale = { x: 1, y: 1 };
  for (const r of reports) {
    if (!finite(r.box) || !finite(r.clip) || !r.foreign.every(finite))
      return { ok: false, reason: "unplaced" };
    if (r.tilted) return { ok: false, reason: "transformed" };
    const s = r.scale ?? { x: 1, y: 1 };
    if (!fineScale(s)) return { ok: false, reason: "unplaced" };
    if (!r.held || r.steady === false) return { ok: false, reason: "overlay" };
    const map = (b: Box): Box => ({
      x: r.box.x + b.x * s.x,
      y: r.box.y + b.y * s.y,
      width: b.width * s.x,
      height: b.height * s.y,
    });
    rect = intersect(map(rect), r.box);
    rect = rect && intersect(rect, r.clip);
    if (!rect) return { ok: false, reason: "unplaced" };
    const shown = rect;
    if (r.foreign.some((f) => intersect(f, shown) !== null))
      return { ok: false, reason: "foreign-frame" };
    if (vis) {
      vis = intersect(map(vis), r.box);
      vis = vis && intersect(vis, r.clip);
    }
    origin = { x: r.box.x + origin.x * s.x, y: r.box.y + origin.y * s.y };
    scale = { x: scale.x * s.x, y: scale.y * s.y };
  }
  const clamped =
    Math.abs(rect.width - inFrame.width * scale.x) > 0.5 ||
    Math.abs(rect.height - inFrame.height * scale.y) > 0.5;
  const view = vis
    ? {
        x: (vis.x - origin.x) / scale.x,
        y: (vis.y - origin.y) / scale.y,
        width: vis.width / scale.x,
        height: vis.height / scale.y,
      }
    : undefined;
  const unit = Math.abs(scale.x - 1) < 1e-9 && Math.abs(scale.y - 1) < 1e-9;
  return {
    ok: true,
    crop: rect,
    clamped,
    ...(unit ? {} : { scale }),
    ...(view ? { view } : {}),
  };
}

/**
 * Where the child frame's viewport origin is, and how big its pixels are, in
 * the frame the reports reach (F's parent first, the top frame last). Only
 * the boxes and scales count; clips, foreign frames and holds do not.
 */
export function composePlace(
  reports: readonly LocateReport[],
):
  | { ok: true; origin: { x: number; y: number }; scale: { x: number; y: number } }
  | { ok: false; reason: "unplaced" | "transformed" } {
  if (reports.length === 0) return { ok: false, reason: "unplaced" };
  let origin = { x: 0, y: 0 };
  let scale = { x: 1, y: 1 };
  for (const r of reports) {
    if (r.tilted) return { ok: false, reason: "transformed" };
    if (!finite(r.box)) return { ok: false, reason: "unplaced" };
    const s = r.scale ?? { x: 1, y: 1 };
    if (!fineScale(s)) return { ok: false, reason: "unplaced" };
    origin = { x: r.box.x + origin.x * s.x, y: r.box.y + origin.y * s.y };
    scale = { x: scale.x * s.x, y: scale.y * s.y };
  }
  return { ok: true, origin, scale };
}

/** Two crops are the same place (to half a CSS pixel). */
export function sameCrop(a: Box, b: Box): boolean {
  return (
    Math.abs(a.x - b.x) <= 0.5 &&
    Math.abs(a.y - b.y) <= 0.5 &&
    Math.abs(a.width - b.width) <= 0.5 &&
    Math.abs(a.height - b.height) <= 0.5
  );
}

interface Sender {
  tab?: { id?: number | undefined } | undefined;
  frameId?: number | undefined;
  documentId?: string | undefined;
  documentLifecycle?: string | undefined;
}

export interface LocatorPorts {
  send(tabId: number, msg: Record<string, unknown>, to?: { documentId?: string }): Promise<unknown>;
  nonce(): string;
  setTimer(fn: () => void, ms: number): unknown;
  clearTimer(h: unknown): void;
}

/** How long one hop of a locate may take. */
const LOCATE_MS = 2_000;
/** What a placement's hops carry for a rect: nothing of the block. */
const NO_RECT: Box = { x: 0, y: 0, width: 0, height: 0 };
/** How many frames a path may have above the capturing frame. */
const MAX_DEPTH = 8;
const ID_RE = /^[A-Za-z0-9_-]{1,64}$/;

type Phase = "pre" | "post" | "place";

interface Chain {
  tabId: number;
  holdId: string;
  phase: Phase;
  /** Pre-grab only: each frame on the path scrolls what it must to show the rect (L-1). */
  reveal: boolean;
  reports: LocateReport[];
  rect: Box;
  /** The capturing frame's viewport size, for the part of it the tab shows. */
  viewport?: { width: number; height: number };
  done(r: CropResult | ReturnType<typeof composePlace>): void;
}

const isBox = (v: unknown): v is Box =>
  !!v &&
  typeof v === "object" &&
  ["x", "y", "width", "height"].every((k) => typeof (v as Record<string, unknown>)[k] === "number");

function parseReport(m: Record<string, unknown>, phase: Phase): LocateReport | null {
  if (!isBox(m.box) || !isBox(m.clip) || !Array.isArray(m.foreign)) return null;
  if (m.foreign.length > 256 || !m.foreign.every(isBox)) return null;
  if (typeof m.held !== "boolean") return null;
  const report: LocateReport = {
    box: m.box,
    clip: m.clip,
    foreign: m.foreign as Box[],
    held: m.held,
  };
  if (m.scale !== undefined) {
    const s = m.scale as Record<string, unknown> | null;
    if (!s || typeof s.x !== "number" || typeof s.y !== "number") return null;
    report.scale = { x: s.x, y: s.y };
  }
  if (m.tilted === true) report.tilted = true;
  if (phase === "post") report.steady = m.steady === true;
  return report;
}

/** One hop of a chain, waiting for both halves of its binding (2-F2). */
interface Hop {
  chain: Chain;
  /** The document the nonce was handed to: the child being measured. */
  for: string;
  depth: number;
  timer: unknown;
  /** The first parent report for this nonce: who sent it, its challenge, its numbers. */
  report?: { frameId: number; documentId: string; challenge: string; data: LocateReport | null };
  /** The child's echo of the challenge its parent posted it, and whether its parent is the top. */
  echo?: { challenge: string; parentIsTop: boolean };
}

export function createFrameLocator(ports: LocatorPorts) {
  /** nonce → the hop it belongs to. */
  const pending = new Map<string, Hop>();

  const fail = (nonce: string, h: Hop): void => {
    pending.delete(nonce);
    ports.clearTimer(h.timer);
    h.chain.done({ ok: false, reason: "unplaced" });
  };

  function hop(chain: Chain, documentId: string, depth: number): void {
    if (depth > MAX_DEPTH) {
      chain.done({ ok: false, reason: "unplaced" });
      return;
    }
    // The block's rect in this document's viewport so far: its parent checks
    // exactly that rectangle, not the whole frame (2-F1).
    // A placement carries nothing of the block.
    const sofar =
      chain.phase === "place"
        ? NO_RECT
        : chain.reports.length === 0
          ? chain.rect
          : partialRect(chain);
    if (!sofar) {
      chain.done({ ok: false, reason: "unplaced" });
      return;
    }
    const nonce = ports.nonce();
    const timer = ports.setTimer(() => {
      const h = pending.get(nonce);
      if (h) fail(nonce, h);
    }, LOCATE_MS);
    pending.set(nonce, { chain, for: documentId, depth, timer });
    void ports
      .send(
        chain.tabId,
        {
          type: "frame-locate-up",
          nonce,
          holdId: chain.holdId,
          phase: chain.phase,
          rect: sofar,
          ...(chain.reveal ? { reveal: true } : {}),
        },
        { documentId },
      )
      .catch(() => {
        const h = pending.get(nonce);
        if (h) fail(nonce, h);
      });
  }

  /**
   * Both halves are in: the parent measured the frame element whose window
   * the challenge reached, and that window's document is the one the nonce
   * was handed to. A child whose parent is the top window must have been
   * measured by frame 0, and only then.
   */
  function settle(nonce: string, h: Hop): void {
    const { report, echo } = h;
    if (!report || !echo) return;
    pending.delete(nonce);
    ports.clearTimer(h.timer);
    if (report.challenge !== echo.challenge || !report.data) {
      h.chain.done({ ok: false, reason: "unplaced" });
      return;
    }
    if (echo.parentIsTop !== (report.frameId === 0)) {
      h.chain.done({ ok: false, reason: "unplaced" });
      return;
    }
    h.chain.reports.push(report.data);
    if (h.chain.phase === "place") {
      const placed = composePlace(h.chain.reports);
      if (!placed.ok || report.frameId === 0) h.chain.done(placed);
      else hop(h.chain, report.documentId, h.depth + 1);
      return;
    }
    const sofar = composeCrop(h.chain.rect, h.chain.reports, h.chain.viewport);
    // Done at the top, or refused already part of the way up (its reason kept).
    if (report.frameId === 0 || !sofar.ok) h.chain.done(sofar);
    else hop(h.chain, report.documentId, h.depth + 1);
  }

  const live = (s: Sender): { tabId: number; frameId: number; documentId: string } | null => {
    const tabId = s.tab?.id;
    if (tabId === undefined || tabId < 0 || s.frameId === undefined || !s.documentId) return null;
    if (s.documentLifecycle !== undefined && s.documentLifecycle !== "active") return null;
    return { tabId, frameId: s.frameId, documentId: s.documentId };
  };

  const CHALLENGE_RE = /^[A-Za-z0-9_-]{16,64}$/;

  return {
    /** A child frame asks where its block's rect is in the tab, for one phase of one grab. */
    locate(m: Record<string, unknown>, s: Sender): Promise<Record<string, unknown>> {
      const who = live(s);
      if (!who || who.frameId === 0) return Promise.resolve({ ok: false, reason: "sender" });
      const holdId = typeof m.holdId === "string" ? m.holdId : "";
      const phase: Phase | null =
        m.phase === "post" || m.phase === "pre" || m.phase === "place" ? m.phase : null;
      if (!ID_RE.test(holdId) || !phase || !isBox(m.rect))
        return Promise.resolve({ ok: false, reason: "invalid" });
      const rect = m.rect;
      const vp = m.viewport as Record<string, unknown> | undefined;
      const viewport =
        vp &&
        typeof vp.width === "number" &&
        typeof vp.height === "number" &&
        Number.isFinite(vp.width) &&
        Number.isFinite(vp.height) &&
        vp.width >= 0 &&
        vp.height >= 0
          ? { width: vp.width, height: vp.height }
          : undefined;
      return new Promise((resolve) => {
        let settled = false;
        const chain: Chain = {
          tabId: who.tabId,
          holdId,
          phase,
          reveal: phase === "pre" && m.reveal === true,
          reports: [],
          rect,
          ...(viewport ? { viewport } : {}),
          done: (r) => {
            if (settled) return;
            settled = true;
            resolve({ ...r });
          },
        };
        hop(chain, who.documentId, 0);
      });
    },
    /** A parent frame's measurement of the child that posted it this nonce, and its challenge. */
    located(m: Record<string, unknown>, s: Sender): Record<string, unknown> {
      const who = live(s);
      const nonce = typeof m.nonce === "string" ? m.nonce : "";
      const challenge = typeof m.challenge === "string" ? m.challenge : "";
      const h = pending.get(nonce);
      if (!who || !h || !CHALLENGE_RE.test(challenge)) return { ok: false };
      // Only a frame of the same tab, never the measured frame itself, and only the first.
      if (who.tabId !== h.chain.tabId || who.documentId === h.for || h.report) return { ok: false };
      h.report = {
        frameId: who.frameId,
        documentId: who.documentId,
        challenge,
        data: parseReport(m, h.chain.phase),
      };
      settle(nonce, h);
      return { ok: true };
    },
    /** The measured child echoes the challenge its parent posted it (2-F2). */
    echoed(m: Record<string, unknown>, s: Sender): Record<string, unknown> {
      const who = live(s);
      const nonce = typeof m.nonce === "string" ? m.nonce : "";
      const challenge = typeof m.challenge === "string" ? m.challenge : "";
      const h = pending.get(nonce);
      // Only the document the nonce was handed to, as the browser reports it; only once.
      if (!who || !h || who.tabId !== h.chain.tabId || who.documentId !== h.for || h.echo)
        return { ok: false };
      if (!CHALLENGE_RE.test(challenge)) return { ok: false };
      h.echo = { challenge, parentIsTop: m.parentIsTop === true };
      settle(nonce, h);
      return { ok: true };
    },
  };
}

/** The block's rect carried up through the reports so far, in the last reporter's coordinates. */
function partialRect(chain: Chain): Box | null {
  const r = composeCrop(chain.rect, chain.reports);
  return r.ok ? r.crop : null;
}

/**
 * Where one tile of a look inside a frame goes (L-1): exactly its proven crop
 * of the tab's screenshot (`crop`, tab CSS px), drawn at `at` (CSS px of the
 * output). Nothing else of the screenshot is drawn; null when the crop lies
 * outside the screenshot or the output.
 */
export function frameTileDraw(
  crop: Box,
  at: { x: number; y: number },
  dpr: number,
  bitmap: { width: number; height: number },
  out: { width: number; height: number },
): { sx: number; sy: number; sw: number; sh: number; dx: number; dy: number } | null {
  if (!finite(crop) || !Number.isFinite(at.x) || !Number.isFinite(at.y)) return null;
  const sx = Math.max(0, Math.round(crop.x * dpr));
  const sy = Math.max(0, Math.round(crop.y * dpr));
  const dx = Math.max(0, Math.round(at.x * dpr));
  const dy = Math.max(0, Math.round(at.y * dpr));
  const sw = Math.min(Math.round(crop.width * dpr), bitmap.width - sx, out.width - dx);
  const sh = Math.min(Math.round(crop.height * dpr), bitmap.height - sy, out.height - dy);
  if (sw <= 0 || sh <= 0) return null;
  return { sx, sy, sw, sh, dx, dy };
}
