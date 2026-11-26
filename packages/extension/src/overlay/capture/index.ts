// captureFull — the fail-soft capture orchestrator (Stage 1 capture spec §8).
//
// Fired fire-and-forget from the Edit-request flow once the Change interaction
// id is known (overlay/variants.ts). Runs the CANONICAL order (§3/F6):
//   quiesce → walk → witness → harvest → upload
// The witness precedes harvest so the screenshot matches the just-walked,
// chrome-hidden frame before harvest's network I/O lets the page drift; overlay
// chrome is restored right after the witness. Every step is fail-soft: the
// Edit-request has already succeeded, and the ABSENCE of a committed CaptureRef
// is itself the honest signal (D9) — the stage falls back to the legacy
// ElementContext renderer.
//
// The walk + quiescence are this engine's own (§1-§3). Harvest (§4), the
// witness (§5), and the two-phase SW upload (§8) live behind the injected
// `CapturePipeline` — the content entry registers the real pipeline (driven by
// the privileged SW message contract) via `registerCapturePipeline`. Without one
// (bare unit env), captureFull still quiesces + walks, then no-ops the rest.
import type { CaptureKind } from "@onlay/protocol";
import { pinBlock } from "../anchors";
import type { ChildFrameHold } from "../host";
import { frameWalkEnv } from "./frame-env";
import { quiesce } from "./quiescence";
import { RESIDUE_CLASSES, ResidueLog, type ScreenshotDrop } from "./residue";
import { type AssetRef, type WalkMeta, walk } from "./walker";

/** One assembled capture part (raw bytes); the SW hashes + base64s it at upload. */
export interface CaptureDraftPart {
  name: string;
  role: "document" | "font" | "asset" | "witness" | "thumbnail";
  mime: string;
  bytes: Uint8Array;
}

/** The manifest `meta` the walker + pipeline accumulate (capture §1.8). */
export interface DraftMeta extends WalkMeta {
  quiescence: "settled" | "timeout";
  captureMs?: number;
}

/**
 * The mutable capture draft threaded through the pipeline. The walker fills the
 * document + refs + meta; harvest fills the `#oc-fonts` sheet (into
 * `documentHtml`), the `authorsheet`, the font+asset parts, and appends residue;
 * the witness fills the witness+thumbnail parts; upload gzips the document +
 * authorsheet, hands raw part bytes to the SW (which computes each part's sha256
 * + `meta.targetKey` per A16), and runs the two-phase POST/PUT/commit.
 */
export interface CaptureDraft {
  interactionId: string;
  /**
   * The capture kind this draft becomes (Stage 2). `edit-context` is the Change
   * axis (client-derived `edit:<targetKey>` lineage); `snapshot` is an anchored
   * place's look history (server-derived `snap:<interactionId>` lineage — the
   * client never forks it, so a snapshot upload omits `meta.targetKey`).
   */
  kind: CaptureKind;
  /** The RAW, un-hashed `sourcePointer ?? selector` — the SW hashes it → meta.targetKey (A16/D8). */
  targetKeySource: string;
  /** The serialized scriptless document; harvest rewrites `#oc-fonts`, upload gzips. */
  documentHtml: string;
  /** The harvested author CSS (full text, D4); null until/unless harvest fills it. */
  authorsheet: string | null;
  assetRefs: AssetRef[];
  /** font/asset (harvest) + witness/thumbnail (witness) part bytes accumulate here. */
  parts: CaptureDraftPart[];
  /** The live residue accumulator; upload flattens it to `meta.residue`. */
  residue: ResidueLog;
  meta: DraftMeta;
  block: Element;
  scope: Element;
  /** F30: set for `variant-look` drafts only — the identity the server
   *  validates and derives the varlook lineage from. */
  variantMeta?: { variantSetId: string; variantId: string; variantVersion: number };
  /**
   * What this capture was started for still holds (the same document, page
   * key, interaction and account; binding.ts). Checked before the walk, before
   * every pixel grab and before upload; once false the capture is abandoned.
   */
  verify?: () => boolean;
  /** Set when a check failed mid-capture: nothing of this draft is uploaded. */
  aborted?: boolean;
  /** `hostMounts()` when the overlay was hidden; the raster goes if it changed (3b-C1). */
  hostMounts?: number;
  /** The overlay in same-origin child frames, held hidden; a tile they did not hold for goes (C-1). */
  frames?: ChildFrameHold;
  /** Why the witness took no raster, when it refused one (C-5). */
  dropped?: WitnessDrop;
}

/**
 * Why the witness refused a raster (C-5): another origin's frame was in it,
 * or the overlay may have shown in it (the host was replaced, or a same-origin
 * frame did not hold its hide for the whole grab), or (F-6) a block inside a
 * child frame was out of view or its frame could not be located in the tab,
 * or (2-F1) its pixels could not be shown to be its frame's own: something
 * drawn over it, an effect on it, or a frame that can be seen through.
 * A failed `verify` is `aborted` instead.
 */
export type WitnessDrop = "foreign-frame" | "overlay" | "unplaced" | "covered";

/** Why a variant look was refused (C-5): the witness's reason, too tall, or `verify` failed. */
export type LookDrop = WitnessDrop | "too-large" | "aborted";

/**
 * The committed-or-refused outcome of the upload leg. `ok` carries the committed
 * captureId — plus `witnessMissing` when the commit carried no screenshot (the
 * capture grant is off; F6 honesty). A refusal names WHY: the server's capacity
 * cap (quota / series cap → the "storage cap" copy, Stage 2 §3), a reloaded
 * extension orphaning this tab's runtime line (`stale-extension` — the fix is a
 * tab refresh, and saying so beats a generic shrug), or anything else — so a
 * caller (the one-action fresh-look, content.ts) can confirm or admit failure
 * without the duty ever silently vanishing.
 */
export type CaptureOutcome =
  | { ok: true; captureId: string; witnessMissing?: boolean }
  | { ok: false; refusal: "storage-cap" | "stale-extension" | "not-yours" | "other" };

/** The privileged legs (§4/§5/§8), owned by the SW-facing modules. Each is fail-soft. */
export interface CapturePipeline {
  /** §5 — MUST run right after the walk, before harvest, while chrome is hidden. */
  witness?(draft: CaptureDraft): Promise<void>;
  /** §4 — recover author CSS / fonts / assets; fills #oc-fonts + authorsheet. */
  harvest?(draft: CaptureDraft): Promise<void>;
  /** §8 — gzip + two-phase upload via the SW (bytes never ride WS); reports the outcome. */
  upload?(draft: CaptureDraft): Promise<CaptureOutcome>;
}

let pipeline: CapturePipeline | null = null;

/** Register the real harvest/witness/upload legs (called by the content entry). */
export function registerCapturePipeline(p: CapturePipeline | null): void {
  pipeline = p;
}

/* ── the module-wide capture queue (F30 sol-1) ──────────────────────────
 * EVERY capture shares one DOM, one scroll position, one hidden-chrome state
 * and one screenshot channel — so every capture serializes here, and while a
 * job runs the PREVIEW state is owned by the queue: ordinary jobs (edit-
 * context / snapshot) run with the original page in force (a fresh-look must
 * never walk a variant-mutated DOM), and preview re-application from arriving
 * state frames is DEFERRED until the queue drains. Variant-look jobs manage
 * the preview themselves. */

export interface PreviewGuard {
  /** Restore the pristine page before an ordinary capture job. */
  forceOriginal(): void;
  /**
   * Any capture job starts: take every preview the viewer has on (kept edits
   * included) off the page; only what the job itself applies is captured.
   */
  suspend?(): void;
  /** The queue drained: reapply the human's stop + replay a deferred frame. */
  settle(): void;
}

let previewGuard: PreviewGuard | null = null;
export function registerPreviewGuard(g: PreviewGuard | null): void {
  previewGuard = g;
}

let queueTail: Promise<unknown> = Promise.resolve();
let queueDepth = 0;

/** True while any capture job runs — variants.ts defers preview re-application. */
export function captureQueueBusy(): boolean {
  return queueDepth > 0;
}

export function enqueueCapture<T>(job: () => Promise<T>): Promise<T> {
  queueDepth += 1;
  const guarded = (): Promise<T> => {
    previewGuard?.suspend?.();
    return job();
  };
  const run = queueTail.then(guarded, guarded);
  queueTail = run
    .catch(() => {})
    .finally(() => {
      queueDepth -= 1;
      if (queueDepth === 0) previewGuard?.settle();
    });
  return run;
}

/** Ordinary captures run exclusively AND against the original page. */
function enqueueOriginalCapture<T>(job: () => Promise<T>): Promise<T> {
  return enqueueCapture(async () => {
    previewGuard?.forceOriginal();
    return job();
  });
}

/**
 * Capture the picked block into a structured capture bound to an interaction.
 * `kind` defaults to `edit-context` (the Change axis, the Stage-1 caller); a
 * `snapshot` records how an anchored place looked when its anchor was (re)placed
 * or a fresh look was requested (Stage 2 §1). Same canonical order + same walk
 * scope for both — the only wire difference is the manifest `kind` and, for a
 * snapshot, the omitted `meta.targetKey` (its lineage is server-derived, §1.3).
 * Never throws, never blocks the caller. Most callers fire-and-forget; the
 * one-action fresh-look awaits the returned `CaptureOutcome` to confirm or admit
 * failure (`null` when the capture never reached the commit — walk failed, no
 * pipeline installed — where the absent CaptureRef is itself the honest signal).
 */
export function captureFull(
  block: Element,
  interactionId: string,
  kind: CaptureKind = "edit-context",
  verify: () => boolean = () => true,
): Promise<CaptureOutcome | null> {
  // Serialized + original-page-in-force: a fresh-look or edit-context walk of
  // a variant-mutated DOM would poison the ORIGINAL every rung renders from.
  // Pinned where it is now (2-A2): a block whose document or frames change
  // while the capture waits or runs is not captured at all.
  const pinned = pinBlock(block);
  return enqueueOriginalCapture(() =>
    rawCaptureFull(block, interactionId, kind, () => pinned() && verify()),
  );
}

async function rawCaptureFull(
  block: Element,
  interactionId: string,
  kind: CaptureKind,
  verify: () => boolean,
): Promise<CaptureOutcome | null> {
  const started = now();
  // Whatever happens after the overlay is hidden, it is shown again (restore is idempotent).
  let reveal: (() => void) | undefined;
  try {
    // Queued work may run after the page moved on: check before anything is read.
    if (!verify() || !block.isConnected) return null;
    const handle = await quiesce({ scope: block });
    reveal = handle.restore;
    let result: ReturnType<typeof walk>;
    // Before the DOM walk.
    if (!verify() || !block.isConnected) {
      handle.restore();
      return null;
    }
    try {
      // A block inside a frame of this page is walked in its own document (A-3);
      // a block in any other document is not walked at all, never by default.
      const env = frameWalkEnv(block);
      if (!env && block.ownerDocument !== document) {
        handle.restore();
        return null;
      }
      result = walk({ block, ...(env ? { env } : {}) });
    } catch {
      handle.restore();
      return null;
    }
    const targetKeySource = readTargetKeySource(block);
    // A frozen mid-transition frame is metered as residue (§3/§6), not just
    // stamped on `meta.quiescence` — the runtime meter keys "Captured mid-change…"
    // off the residue class, so the copy is unreachable without this entry.
    const residue = new ResidueLog();
    residue.seed(result.residue);
    if (handle.outcome === "timeout") residue.add("quiescence-timeout");
    const draft: CaptureDraft = {
      interactionId,
      kind,
      targetKeySource,
      documentHtml: result.documentHtml,
      authorsheet: null,
      assetRefs: result.assetRefs,
      parts: [],
      residue,
      meta: { ...result.meta, quiescence: handle.outcome },
      block,
      scope: block,
      verify: () => verify() && block.isConnected,
      hostMounts: handle.hostMounts,
      ...(handle.frames ? { frames: handle.frames } : {}),
    };

    // Witness FIRST (settled, chrome-hidden frame) — before harvest network I/O.
    if (pipeline?.witness) await pipeline.witness(draft).catch(() => {});
    handle.restore(); // reveal overlay chrome only after the witness

    if (pipeline?.harvest) await pipeline.harvest(draft).catch(() => {});
    draft.meta.captureMs = Math.max(0, Math.round(now() - started));
    // Before upload: still the page, interaction and account it was taken for.
    if (draft.aborted || !draft.verify?.()) return null;
    if (pipeline?.upload) {
      return await pipeline
        .upload(draft)
        .catch((): CaptureOutcome => ({ ok: false, refusal: "other" }));
    }
    return null;
  } catch {
    // fully fail-soft — the Edit-request already succeeded (D9)
    return null;
  } finally {
    reveal?.();
  }
}

/**
 * Fire a `snapshot` capture for an anchored place (Stage 2 §1.2). The convenience
 * wrapper the anchor-placement + fresh-look hook sites call; fully fail-soft, like
 * `captureFull` — the absence of a committed snapshot is itself the honest signal
 * (the look history simply gains no new revision).
 */
export const captureSnapshot = (
  block: Element,
  interactionId: string,
  verify?: () => boolean,
): Promise<CaptureOutcome | null> => captureFull(block, interactionId, "snapshot", verify);

/** F30 — one variant-look grab: quiesce → verify the variant is STILL applied
 *  (the engine token — a clobbered/cycled preview aborts rather than committing
 *  someone else's pixels) → witness the given document-space rect → upload
 *  (witness+thumb only, no walk, no harvest). Runs INSIDE a queue job the
 *  variant pass owns — never enqueues itself. Fail-soft throughout. */
export async function captureVariantLook(input: {
  block: Element;
  interactionId: string;
  /** Evaluated AFTER quiescence — a reflow during settle must not stale the crop. */
  rect: () => { x: number; y: number; width: number; height: number };
  variantMeta: { variantSetId: string; variantId: string; variantVersion: number };
  /** Proves the exact application is live right before AND after the grab. */
  verify: () => boolean;
  /**
   * Told why no look was taken when it was refused rather than failed (C-5):
   * the witness's reason, a look too tall to raster whole, or `verify` failing.
   */
  dropped?: (why: LookDrop, screenshot?: ScreenshotDrop) => void;
}): Promise<CaptureOutcome | null> {
  const refuse = (why: LookDrop, screenshot?: ScreenshotDrop): null => {
    input.dropped?.(why, screenshot);
    return null;
  };
  const started = now();
  try {
    const handle = await quiesce({ scope: input.block });
    try {
      if (!input.verify()) return refuse("aborted"); // post-quiesce, pre-grab — the honest window
      const residue = new ResidueLog();
      if (handle.outcome === "timeout") residue.add("quiescence-timeout");
      const measured = input.rect(); // post-quiesce geometry, never a stale crop
      const rect = {
        x: measured.x,
        y: measured.y,
        width: Math.max(1, measured.width),
        height: Math.max(1, measured.height),
      };
      // A habitat past the tile ceiling would TRUNCATE mid-raster — a partial
      // "ground truth" is worse than none; skip before the first grab.
      if (rect.height > window.innerHeight * 10) return refuse("too-large");
      const draft: CaptureDraft = {
        interactionId: input.interactionId,
        kind: "variant-look",
        targetKeySource: "",
        documentHtml: "",
        authorsheet: null,
        assetRefs: [],
        parts: [],
        residue,
        meta: {
          viewport: {
            innerWidth: window.innerWidth,
            innerHeight: window.innerHeight,
            dpr: window.devicePixelRatio || 1,
            layoutWidth: document.documentElement.clientWidth || window.innerWidth,
          },
          blockRect: rect,
          habitatRect: rect, // the witness rasters meta.habitatRect
          quiescence: handle.outcome,
        },
        block: input.block,
        scope: input.block,
        variantMeta: input.variantMeta,
        verify: input.verify,
        hostMounts: handle.hostMounts,
        ...(handle.frames ? { frames: handle.frames } : {}),
      };
      if (pipeline?.witness) await pipeline.witness(draft).catch(() => {});
      handle.restore();
      // F31 — a variant-look IS its witness: a raster that stayed FLAT through
      // the nudge-and-regrab is no ground truth. Refuse the upload — absence
      // demotes the stop to the reconstruction rung honestly, and the unmarked
      // key means a later pass retries the grab afresh.
      if (draft.residue.has("flat-raster")) return null;
      // Another origin's frame was in the rect: the witness took no raster, and
      // a variant-look without one is no look at all.
      if (draft.residue.has("cross-origin-frame")) return refuse("foreign-frame");
      // The witness refused the raster (the overlay may be in it): say why.
      // The witness's exact reason rides beside it (the screenshot-* residue).
      if (draft.dropped) return refuse(draft.dropped, screenshotDropOf(draft.residue));
      // Re-verify AFTER the grabs: a clobber/cycle BETWEEN tiles invalidates
      // the token — discard rather than upload another state's pixels.
      if (draft.aborted || !input.verify()) return refuse("aborted");
      draft.meta.captureMs = Math.max(0, Math.round(now() - started));
      if (pipeline?.upload) {
        return await pipeline
          .upload(draft)
          .catch((): CaptureOutcome => ({ ok: false, refusal: "other" }));
      }
      return null;
    } finally {
      handle.restore(); // idempotent — the early-return paths reveal chrome too
    }
  } catch {
    return null;
  }
}

function now(): number {
  return typeof performance !== "undefined" ? performance.now() : Date.now();
}

/** The un-hashed lineage source: the source pointer if stamped, else the CSS selector (§1.8/D8). */
function readTargetKeySource(block: Element): string {
  const stamped = block.closest?.("[data-onlay-source]")?.getAttribute("data-onlay-source")?.trim();
  if (stamped) return stamped;
  return cssPathLite(block);
}

/** A minimal, dependency-free selector for the lineage key (the SW hashes it). */
function cssPathLite(el: Element): string {
  if (el.id) return `#${el.id}`;
  const parts: string[] = [];
  let node: Element | null = el;
  while (node && node.nodeType === 1 && parts.length < 8) {
    let seg = node.localName;
    if (node.classList?.length) seg += `.${Array.from(node.classList).join(".")}`;
    parts.unshift(seg);
    node = node.parentElement;
  }
  return parts.join(" > ");
}

/** The screenshot-* class the witness recorded when it dropped the raster, if any. */
function screenshotDropOf(residue: ResidueLog): ScreenshotDrop | undefined {
  return RESIDUE_CLASSES.find(
    (c): c is ScreenshotDrop => c.startsWith("screenshot-") && residue.has(c),
  );
}
