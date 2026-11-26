// The quiescence protocol (Stage 1 capture spec §3).
//
// Before the walk and before the witness, settle the frame so the flattened
// document, its computed styles, and the witness raster all describe ONE frame:
// hide onlay's own chrome (so the block renders as if onlay weren't present),
// wait for webfonts to swap (`document.fonts.ready`) and in-scope images to
// decode, then settle two animation frames. Bounded by QUIESCE_DEADLINE_MS —
// on timeout the capture proceeds on the current (possibly mid-transition)
// frame and meters `quiescence-timeout`; it NEVER blocks the Edit-request.
//
// Runs in content.ts (DOM access). The caller keeps the returned outcome to
// stamp `meta.quiescence` and to feed the residue log, and calls `restore()`
// only AFTER the witness completes (§3 canonical order).

import {
  type ChildFrameHold,
  holdChildFramesHidden,
  holdHiddenForCapture,
  hostMounts,
} from "../host";
import { CAPTURE_LIMITS } from "./limits";

export interface QuiesceHandle {
  outcome: "settled" | "timeout";
  /** Reveal the overlay chrome hidden for the walk+witness frame. Idempotent. */
  restore(): void;
  /** `hostMounts()` when the overlay was hidden: a later value means the host was replaced. */
  hostMounts: number;
  /** The overlay in same-origin child frames, held hidden (absent with explicit `chrome`). */
  frames?: ChildFrameHold;
}

export interface QuiesceOptions {
  /** The picked block + its habitat — images decoded here. */
  scope: Element;
  /** Onlay's overlay host(s) to hide for the frame (default: the host this script mounted). */
  chrome?: Element[];
  deadlineMs?: number;
  /** Injected clock/raf/fonts for tests; default to the real globals. */
  now?: () => number;
  raf?: (cb: () => void) => void;
  fontsReady?: () => Promise<unknown>;
}

function twoFrames(raf: (cb: () => void) => void): Promise<void> {
  return new Promise((resolve) => raf(() => raf(() => resolve())));
}

function withTimeout<T>(p: Promise<T>, ms: number, now: () => number): Promise<"done" | "timeout"> {
  const start = now();
  return Promise.race([
    p.then(() => "done" as const).catch(() => "done" as const),
    new Promise<"timeout">((resolve) => {
      const remaining = Math.max(0, ms - (now() - start));
      setTimeout(() => resolve("timeout"), remaining);
    }),
  ]);
}

/**
 * Settle the frame and hide overlay chrome. Resolves with an outcome and a
 * `restore()` the caller invokes after the witness. Fail-soft: any sub-step
 * error degrades to `timeout`, never throws.
 */
export async function quiesce(options: QuiesceOptions): Promise<QuiesceHandle> {
  const deadline = options.deadlineMs ?? CAPTURE_LIMITS.QUIESCE_DEADLINE_MS;
  const now = options.now ?? (() => Date.now());
  const raf =
    options.raf ??
    ((cb: () => void) => {
      if (typeof requestAnimationFrame === "function") requestAnimationFrame(() => cb());
      else setTimeout(cb, 0);
    });
  const fontsReady =
    options.fontsReady ??
    (() =>
      typeof document !== "undefined" && (document as Document).fonts
        ? (document as Document).fonts.ready
        : Promise.resolve());

  // 1. Hide overlay chrome (visibility, not display — avoid reflow). Restored later.
  // By default through this script's own live handle (host.ts, 3b-C1): the
  // current host, any host mounted while the capture runs, and the overlay in
  // every same-origin child frame — never found by a selector.
  const mountsAtHide = hostMounts();
  const prior = new Map<Element, string>();
  const releases: Array<() => void> = [];
  let frames: ChildFrameHold | undefined;
  if (options.chrome) {
    for (const c of options.chrome) {
      const style = (c as HTMLElement).style;
      prior.set(c, style.visibility);
      style.visibility = "hidden";
    }
  } else {
    releases.push(holdHiddenForCapture());
    if (typeof document !== "undefined") {
      const hold = holdChildFramesHidden(document);
      frames = hold;
      releases.push(() => hold.release());
    }
  }
  let restored = false;
  const restore = (): void => {
    if (restored) return;
    restored = true;
    for (const [c, v] of prior) (c as HTMLElement).style.visibility = v;
    for (const r of releases) r();
  };

  const settle = async (): Promise<void> => {
    // 2. fonts.ready
    await fontsReady().catch(() => {});
    // 3. decode in-scope images (guarded per image)
    const imgs = Array.from(options.scope.querySelectorAll("img")) as HTMLImageElement[];
    await Promise.all(
      imgs.map((img) => {
        if (img.complete) return Promise.resolve();
        return typeof img.decode === "function" ? img.decode().catch(() => {}) : Promise.resolve();
      }),
    );
    // 4. two-frame settle
    await twoFrames(raf);
  };

  let outcome: "settled" | "timeout";
  try {
    const result = await withTimeout(settle(), deadline, now);
    outcome = result === "done" ? "settled" : "timeout";
  } catch {
    outcome = "timeout";
  }
  return { outcome, restore, hostMounts: mountsAtHide, ...(frames ? { frames } : {}) };
}
