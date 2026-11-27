// The automatic variant-witness pass (F30). Variants arrive → this scheduler
// renders each on the LIVE page through the one preview engine, screenshots
// it, uploads a `variant-look` capture, and puts the page back on the human's
// stop. No clicks. The trust hierarchy's rung 2 is minted here.
//
// Discipline (spec §A2, both reviews folded in):
// - ELIGIBILITY: visible tab + active-in-window + last-focused window + the
//   broad capture grant (one SW probe) — a hidden tab must never trigger
//   captureVisibleTab (wrong tab's pixels), and multi-window dedups here.
// - OWNERSHIP: the set's page (expectUrlPrefix) must BE this page — same
//   origin, path and query (page-url.ts) — checked before the pass, again
//   before every apply, before every grab and before every upload: an SPA can
//   change route while the queue waits.
// - OTHER ORIGINS: a rect that holds a frame from another (or an unknown)
//   origin is never rastered (witness.ts); the variant is skipped.
// - THE QUEUE OWNS THE DOM: the whole pass is one capture-queue job, so it
//   never interleaves with edit-context/snapshot captures; human input aborts
//   (the current variant stays unmarked — a later trigger finishes the tail);
//   the engine token is verified post-quiesce pre-grab.
// - COOLDOWN: min PASS_COOLDOWN_MS between passes per set, TRAILING-EDGE
//   guaranteed — a revise storm coalesces to the latest version, always
//   captured eventually, never a flash-cycling page.
// - GEOMETRY: rect = the block joined with engine-inserted nodes that touch
//   it, measured post-apply, clamped to the nearest boxed ancestor and to the
//   original box grown by max(25%, 160 px) (more: no look, said on the
//   variant's row); and to the pixel budget
//   BEFORE any grab.
// - Fail-soft + observable: failures log to the console and lower a stop's
//   rung; they never surface UI or retry storms.

import { LIMITS, type MutationProgram } from "@onlay/protocol";
import type { ApplyResult, PreviewEngine } from "@onlay/render";
import { pinBlock } from "../anchors";
import { samePage } from "../page-url";
import { captureVariantLook, enqueueCapture, type LookDrop } from "./index";
import type { ScreenshotDrop } from "./residue";
import { foreignFrameIn } from "./witness";

const PASS_COOLDOWN_MS = 15_000;
/** Failed-capture reruns per stable set state — 3 tries total, then wait for a
 *  real trigger (new version, visibility return, human input). */
const MAX_FAIL_RETRIES = 2;
/** The server refuses rasters past MAX_CAPTURE_IMAGE_PIXELS — skip BEFORE the
 *  SW allocates a canvas that size (sol-10). */
const MAX_RECT_PIXELS = 40_000_000;

export interface PassSetInfo {
  setId: string;
  changeInteractionId: string;
  status: string;
  expectUrlPrefix?: string;
  selector?: string;
  /** The set's root is the whole page: its look is the viewport. */
  page?: boolean;
  /** `by`: the person whose agent wrote the variant (absent from older servers). */
  variants: Array<{ variantId: string; program: MutationProgram; version?: number; by?: string }>;
}

export interface PassDeps {
  engine: PreviewEngine;
  /**
   * This tab may capture for the Edit: its author is the signed-in person and
   * this tab's own snapshot holds it on this exact page (ownership.ts).
   */
  ownsEdit(changeInteractionId: string): boolean;
  /** The signed-in person: only a variant written for them gets a look. */
  selfId(): string | null;
  /** `<person>|<server origin>`: a pass that outlives its account stops. */
  account(): string | null;
  /** SW probe: visible + active tab of the last-focused window + grant. */
  eligible(): Promise<boolean>;
  /** Participant-scoped full-set fetch (SW getVariantSet) — the frame may be
   *  truncated and carries no selector/prefix (sol-5). */
  fetchSet(setId: string): Promise<PassSetInfo | null>;
  /**
   * The block a set was picked on here, pinned at the pick (3-E1): its looks
   * are of that block, only while the pin holds.
   */
  pinOf?(setId: string): { el: Element; held: () => boolean } | undefined;
  /** Reapply the human's LOCAL stop (displayIndex; -1 = Original). */
  restoreDisplay(): void;
  /**
   * This document owns its blocks: the top frame, or a child frame with an
   * address of its own (E-4). Its looks go through the frame look pipeline.
   */
  ownsBlocks: boolean;
  pageUrl(): string;
  log(line: string): void;
  /**
   * Tell the space how this variant applied here (`variant-outcome`): the
   * reporter checks it is this person's own variant and reports once per version.
   */
  reportOutcome?(
    set: { setId: string; changeInteractionId: string },
    variant: { variantId: string; version: number; by?: string },
    result: ApplyResult,
    steps: number,
  ): void;
}

interface SetSchedule {
  cooldownUntil: number;
  timer: ReturnType<typeof setTimeout> | null;
  marked: Set<string>;
  running: boolean;
  rerun: boolean;
  /** Parked (hidden tab) or aborted mid-pass — a visibility return resumes. */
  parked: boolean;
  /** Failed-capture reruns already spent on the CURRENT stable set state
   *  (codex-7) — without this a stable set whose grab failed stays uncaptured
   *  until an unrelated frame arrives; with no bound it would loop forever. */
  failRetries: number;
  /** The set's scope (account or space) was lost: nothing more runs for it. */
  cancelled: boolean;
  /** The server refused a look as not this person's: final for this set. */
  refused: boolean;
}

const schedules = new Map<string, SetSchedule>();

/** The witness's screenshot-* reason inside a frame, as the variant's note says it (E-4). */
const FRAME_OMISSION: Partial<Record<string, LookOmission>> = {
  "screenshot-covered": "covered",
  "screenshot-see-through": "see-through",
  "screenshot-transformed": "transformed",
  "screenshot-scaled": "scaled",
  "screenshot-unplaced": "unplaced",
  "screenshot-page-changed": "page",
  "screenshot-foreign-frame": "frame",
};

/** Why a variant got no automatic look (3b-C5): said on its row, not only in the console. */
export type LookOmission =
  | "too-large"
  | "refused"
  | "frame"
  | "page"
  | "covered"
  | "see-through"
  | "transformed"
  | "scaled"
  | "unplaced";
const omissions = new Map<string, LookOmission>();
const omissionListeners = new Set<(setId: string) => void>();
const omissionKey = (setId: string, variantId: string, version: number): string =>
  `${setId}|${variantId}@${version}`;

/** The reason this variant version got no automatic look, if the pass skipped it. */
export function lookOmission(
  setId: string,
  variantId: string,
  version: number,
): LookOmission | undefined {
  return omissions.get(omissionKey(setId, variantId, version));
}

/** Be told when a set's omissions change (the variant panel repaints its note). */
export function onLookOmission(cb: (setId: string) => void): () => void {
  omissionListeners.add(cb);
  return () => omissionListeners.delete(cb);
}

/** Record why a variant version got no automatic look (the pass; tests). */
export function noteLookOmission(
  setId: string,
  variantId: string,
  version: number,
  why: LookOmission,
): void {
  omissions.set(omissionKey(setId, variantId, version), why);
  for (const cb of [...omissionListeners]) cb(setId);
}
/** A later pass took the look after all: its note goes. */
function clearLookOmission(setId: string, variantId: string, version: number): void {
  if (!omissions.delete(omissionKey(setId, variantId, version))) return;
  for (const cb of [...omissionListeners]) cb(setId);
}
let humanAbort = 0; // bumped on trusted human variant input — running passes observe it

/** variants.ts calls this on every TRUSTED cycle/pick/discard: the human wins. */
export function noteHumanVariantInput(): void {
  humanAbort += 1;
}

function scheduleOf(setId: string): SetSchedule {
  let s = schedules.get(setId);
  if (!s) {
    s = {
      cooldownUntil: 0,
      timer: null,
      marked: new Set(),
      running: false,
      rerun: false,
      parked: false,
      failRetries: 0,
      cancelled: false,
      refused: false,
    };
    schedules.set(setId, s);
  }
  return s;
}

/**
 * Drop queued and running witness work for the sets `which` names (an account
 * change, a lost space): pending timers clear, a running pass stops before its
 * next apply, grab or upload.
 */
export function cancelVariantPasses(which: (setId: string) => boolean): void {
  for (const [setId, s] of [...schedules]) {
    if (!which(setId)) continue;
    s.cancelled = true;
    for (const k of [...omissions.keys()]) if (k.startsWith(`${setId}|`)) omissions.delete(k);
    if (s.timer) clearTimeout(s.timer);
    s.timer = null;
    s.rerun = false;
    schedules.delete(setId);
  }
}

/** Entry point — called for EVERY variant-state frame this page receives
 *  (not just the UI's active set, sol-5) and again on visibility return. */
export function observeVariantState(
  frame: { setId: string; status: string; changeInteractionId?: string },
  deps: PassDeps,
): void {
  if (!deps.ownsBlocks) return;
  if (frame.status !== "previewing" || !frame.changeInteractionId) return;
  // Someone else's Edit: the frame is a UI update, and nothing is captured.
  if (!deps.ownsEdit(frame.changeInteractionId)) return;
  if (schedules.get(frame.setId)?.refused) return;
  // A REAL trigger (new frame — submission, revise, sync) refreshes the
  // failed-capture rerun budget; only the auto-reruns themselves are bounded.
  scheduleOf(frame.setId).failRetries = 0;
  scheduleRun(frame.setId, deps);
}

function scheduleRun(setId: string, deps: PassDeps): void {
  const s = scheduleOf(setId);
  if (s.running) {
    s.rerun = true; // trailing edge: mid-pass arrivals coalesce into one re-run
    return;
  }
  const wait = Math.max(0, s.cooldownUntil - Date.now());
  if (s.timer) return; // one pending run; it will pick up the latest set state
  s.timer = setTimeout(() => {
    s.timer = null;
    void runPass(setId, deps);
  }, wait);
}

async function runPass(setId: string, deps: PassDeps): Promise<void> {
  const s = scheduleOf(setId);
  if (s.running) {
    s.rerun = true;
    return;
  }
  if (document.visibilityState !== "visible") {
    // Park: a return to visible re-triggers (content wires visibilitychange).
    deps.log(`variant-pass ${setId}: parked (hidden tab)`);
    s.parked = true;
    return;
  }
  s.running = true;
  s.parked = false;
  s.cooldownUntil = Date.now() + PASS_COOLDOWN_MS;
  try {
    if (!(await deps.eligible())) {
      deps.log(`variant-pass ${setId}: ineligible (inactive tab / no grant)`);
      s.parked = true; // a focus/visibility return retries the tail
      return;
    }
    // Full-set fetch: the frame may be truncated, carries no selector, and
    // ownership (expectUrlPrefix) is only on the read (sol-5).
    const set = await deps.fetchSet(setId);
    if (s.cancelled || s.refused || set?.status !== "previewing") return;
    const setPage = set.expectUrlPrefix;
    const onSetPage = (): boolean =>
      !s.cancelled &&
      deps.account() !== null &&
      !s.refused &&
      deps.ownsEdit(set.changeInteractionId) &&
      samePage(setPage, deps.pageUrl());
    if (!onSetPage()) {
      deps.log(`variant-pass ${setId}: not this page's set`);
      return;
    }
    const selector = set.selector;
    const page = set.page === true;
    if (!page && !selector) return;

    const abortGen = humanAbort;
    const boundAccount = deps.account();
    await enqueueCapture(async () => {
      const engine = deps.engine;
      let captured = 0;
      let failed = 0;
      for (const v of set.variants.slice(0, LIMITS.MAX_VARIANTS_PER_SET)) {
        if (deps.account() !== boundAccount) break; // signed out or switched mid-pass
        const version = v.version ?? 1;
        const key = `${v.variantId}@${version}`;
        if (s.marked.has(key)) continue;
        if (document.visibilityState !== "visible" || humanAbort !== abortGen) {
          deps.log(`variant-pass ${setId}: aborted (${captured} captured)`);
          s.parked = true;
          break;
        }
        // Revalidated before every apply: the route may have moved while queued.
        if (!onSetPage()) {
          deps.log(`variant-pass ${setId}: page changed — stopped`);
          noteLookOmission(setId, v.variantId, version, "page");
          break;
        }
        // The block as it is with no variant on it: the look's clamp is grown from this box.
        engine.restore();
        const root = page ? document.body : selector ? document.querySelector(selector) : null;
        if (!root) {
          deps.log(`variant-pass ${setId}: selector missing — skipped ${key}`);
          // The block is not on the page as it is now (C-5); not marked, so a
          // later pass retries once it is back.
          noteLookOmission(setId, v.variantId, version, "page");
          continue; // stale-set discipline: skip honestly, never guess
        }
        // Only a variant written by the signed-in person (the Edit's author,
        // `ownsEdit`) gets an automatic look; anyone else's, or one with no
        // `by`, gets none.
        const self = deps.selfId();
        if (self === null || v.by !== self) {
          deps.log(`variant-pass ${setId}: not written by this person — no look for ${key}`);
          s.marked.add(key);
          continue;
        }
        // The block as picked, pinned at the pick when it was picked here, else
        // pinned now (3-E1): moved into another document or frame, it gets no look.
        const picked = page ? undefined : deps.pinOf?.(setId);
        if (picked && (picked.el !== root || !picked.held())) {
          deps.log(`variant-pass ${setId}: the picked block moved — no look for ${key}`);
          noteLookOmission(setId, v.variantId, version, "page");
          s.marked.add(key);
          continue;
        }
        const held = picked?.held ?? pinBlock(root);
        const original = boxOf(root);
        const applied = engine.apply(v.program, page ? { kind: "page" } : selector);
        deps.reportOutcome?.(
          { setId, changeInteractionId: set.changeInteractionId },
          { variantId: v.variantId, version, ...(v.by !== undefined ? { by: v.by } : {}) },
          applied,
          v.program.length,
        );
        if (!applied.ok) {
          // Only the root block can fail a whole program: it isn't on the page now.
          deps.log(`variant-pass ${setId}: apply ${applied.reason} — skipped ${key}`);
          noteLookOmission(setId, v.variantId, version, "page");
          continue;
        }
        // Part of the program was refused: what is on the page is not this
        // variant, so no look of it is taken (R2-C7).
        if ((applied.refused?.length ?? 0) > 0 || applied.applied === 0) {
          deps.log(`variant-pass ${setId}: ops refused — no look for ${key}`);
          noteLookOmission(setId, v.variantId, version, "refused");
          s.marked.add(key);
          continue;
        }
        // A page variant's look is what the viewer sees: the viewport.
        const needed = (): Box => {
          const box = boxedParent(root);
          return lookRect(boxOf(root), engine.insertedRects(), box ? boxOf(box) : null);
        };
        // A block's look never passes its original box grown by
        // max(25%, 160 px) each way (3b-C5), judged on the SETTLED geometry:
        // `fits` runs inside the grab's own verify, after quiescence.
        const rectNow = page ? viewportRect : () => clampTo(needed(), grown(original));
        let tooLarge = false;
        const fits = (): boolean => {
          if (page || inside(needed(), grown(original))) return true;
          tooLarge = true;
          return false;
        };
        const dpr = window.devicePixelRatio || 1;
        {
          const r = rectNow();
          if (r.width * r.height * dpr * dpr > MAX_RECT_PIXELS) {
            deps.log(`variant-pass ${setId}: rect over pixel budget — skipped ${key}`);
            noteLookOmission(setId, v.variantId, version, "too-large");
            continue;
          }
          // Another origin's frame in the look: never rastered, and not retried
          // for this version (the frame is part of the page).
          if (foreignFrameIn(r)) {
            deps.log(`variant-pass ${setId}: another origin's frame in view — skipped ${key}`);
            noteLookOmission(setId, v.variantId, version, "frame");
            s.marked.add(key);
            continue;
          }
        }
        // The witness's own reason when it refused the raster (C-5), page
        // variants included: never re-guessed from the page afterwards.
        let dropped: LookDrop | null = null;
        let screenshot: ScreenshotDrop | undefined;
        const outcome = await captureVariantLook({
          block: root,
          interactionId: set.changeInteractionId,
          rect: rectNow,
          variantMeta: { variantSetId: setId, variantId: v.variantId, variantVersion: version },
          // Before the grab and again before the upload: still this variant, still this page.
          verify: () => engine.applied(applied.token) && onSetPage() && fits() && held(),
          dropped: (why, cls) => {
            dropped = why;
            screenshot = cls;
          },
        });
        const why = outcome ? null : (dropped as LookDrop | null);
        if (outcome?.ok) {
          s.marked.add(key);
          captured += 1;
          clearLookOmission(setId, v.variantId, version);
        } else if (tooLarge || why === "too-large") {
          deps.log(`variant-pass ${setId}: look larger than the block allows — no look for ${key}`);
          noteLookOmission(setId, v.variantId, version, "too-large");
          s.marked.add(key);
        } else if (why === "foreign-frame") {
          deps.log(`variant-pass ${setId}: another origin's frame in view — no look for ${key}`);
          noteLookOmission(setId, v.variantId, version, "frame");
          s.marked.add(key);
        } else if (why === "covered" || why === "unplaced") {
          // Inside a frame: the crop isn't shown to be the frame's own pixels,
          // or the frame couldn't be placed; the witness says exactly why (E-4).
          const omit = FRAME_OMISSION[screenshot ?? ""] ?? why;
          deps.log(`variant-pass ${setId}: ${omit} — no look for ${key}`);
          noteLookOmission(setId, v.variantId, version, omit);
          // Unplaced is retried by a later pass; the frame's shape and paint are not.
          if (omit === "unplaced") failed += 1;
          else s.marked.add(key);
        } else if (!outcome && !onSetPage()) {
          deps.log(`variant-pass ${setId}: page changed — no look for ${key}`);
          noteLookOmission(setId, v.variantId, version, "page");
          break;
        } else if (why === "overlay" || why === "aborted") {
          // Something on the page moved under the grab (a frame came in, the
          // preview was replaced): said, and left unmarked so a later pass retries.
          deps.log(`variant-pass ${setId}: page changed during the grab — no look for ${key}`);
          noteLookOmission(setId, v.variantId, version, "page");
          failed += 1;
        } else if (outcome?.refusal === "not-yours") {
          deps.log(`variant-pass ${setId}: refused as not this person's — stopped`);
          s.refused = true;
          break;
        } else {
          failed += 1;
          deps.log(`variant-pass ${setId}: capture failed for ${key}`);
        }
      }
      engine.restore();
      deps.restoreDisplay();
      if (captured > 0) deps.log(`variant-pass ${setId}: ${captured} witness(es) landed`);
      // Failed grabs (a flat raster, a refused upload) left their keys UNMARKED;
      // schedule a bounded rerun under the fresh cooldown rather than waiting on
      // an unrelated frame (codex-7). A clean pass resets the budget.
      if (s.refused) {
        s.rerun = false;
      } else if (failed > 0 && s.failRetries < MAX_FAIL_RETRIES) {
        s.failRetries += 1;
        s.rerun = true;
      } else if (failed === 0) {
        s.failRetries = 0;
      }
    });
  } catch {
    /* fail-soft — absent witnesses lower the rung, the PWA says so */
  } finally {
    s.running = false;
    if (s.rerun && !s.cancelled && !s.refused) {
      s.rerun = false;
      scheduleRun(setId, deps); // trailing edge, under the fresh cooldown
    }
  }
}

function viewportRect(): { x: number; y: number; width: number; height: number } {
  return {
    x: window.scrollX,
    y: window.scrollY,
    width: Math.max(1, window.innerWidth),
    height: Math.max(1, window.innerHeight),
  };
}

/** An element's document-space box. */
function boxOf(el: Element): Box {
  const b = el.getBoundingClientRect();
  return {
    x: b.left + window.scrollX,
    y: b.top + window.scrollY,
    width: b.width,
    height: b.height,
  };
}

/** Two boxes overlap or touch, within `gap` CSS pixels. */
function touches(a: Box, b: Box, gap: number): boolean {
  return (
    a.x - gap <= b.x + b.width &&
    b.x - gap <= a.x + a.width &&
    a.y - gap <= b.y + b.height &&
    b.y - gap <= a.y + a.height
  );
}

/**
 * What an automatic look may show (R2-C3): the root block's own box after the
 * variant is applied, joined ONLY with inserted boxes that touch it (a gap of
 * at most 1 CSS pixel), clamped to the nearest ancestor with a box (R3-C10),
 * then to the block's original box grown by max(25%, 160 px) (3b-C5). Never the span out
 * to a distant node: nothing unrelated between them is recorded.
 */
export function lookRect(root: Box, inserted: readonly Box[], parent: Box | null): Box {
  let x1 = root.x;
  let y1 = root.y;
  let x2 = root.x + root.width;
  let y2 = root.y + root.height;
  for (const r of inserted) {
    if (!touches(root, r, 1)) continue;
    x1 = Math.min(x1, r.x);
    y1 = Math.min(y1, r.y);
    x2 = Math.max(x2, r.x + r.width);
    y2 = Math.max(y2, r.y + r.height);
  }
  if (parent) {
    x1 = Math.max(x1, parent.x);
    y1 = Math.max(y1, parent.y);
    x2 = Math.min(x2, parent.x + parent.width);
    y2 = Math.min(y2, parent.y + parent.height);
  }
  return { x: x1, y: y1, width: Math.max(1, x2 - x1), height: Math.max(1, y2 - y1) };
}

/** The box grown by max(25% of that dimension, 160 CSS px) in each direction (3b-C5). */
export function grown(b: Box): Box {
  const dx = Math.max(b.width / 4, 160);
  const dy = Math.max(b.height / 4, 160);
  return { x: b.x - dx, y: b.y - dy, width: b.width + 2 * dx, height: b.height + 2 * dy };
}

/** `a` lies within `outer` (half a CSS pixel of rounding allowed). */
export function inside(a: Box, outer: Box): boolean {
  const e = 0.5;
  return (
    a.x >= outer.x - e &&
    a.y >= outer.y - e &&
    a.x + a.width <= outer.x + outer.width + e &&
    a.y + a.height <= outer.y + outer.height + e
  );
}

function clampTo(a: Box, outer: Box): Box {
  const x1 = Math.max(a.x, outer.x);
  const y1 = Math.max(a.y, outer.y);
  const x2 = Math.min(a.x + a.width, outer.x + outer.width);
  const y2 = Math.min(a.y + a.height, outer.y + outer.height);
  return { x: x1, y: y1, width: Math.max(1, x2 - x1), height: Math.max(1, y2 - y1) };
}

/**
 * The nearest ancestor that has a box of its own (R3-C10): a `display:
 * contents` element generates none, so its zero rect would clamp nothing.
 */
export function boxedParent(el: Element): Element | null {
  for (let p = el.parentElement; p; p = p.parentElement) {
    if (getComputedStyle(p).display !== "contents") return p;
  }
  return null;
}

interface Box {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** Visibility returned — finish parked/aborted tails (content wires the event). */
export function resumeVariantPasses(deps: PassDeps): void {
  for (const [setId, s] of schedules) {
    if (s.parked && !s.running && !s.timer) scheduleRun(setId, deps);
  }
}
