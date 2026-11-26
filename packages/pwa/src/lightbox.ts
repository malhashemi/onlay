// The fullscreen look viewer (F29): tapping the hero look opens it IN PLACE —
// no separate screen — with pinch / wheel / double-tap zoom, drag pan, the
// revision scrub, the honesty residue line, and the witness ↔ reconstruction
// toggle the old Looks screen carried. Closes on ×, backdrop tap, Esc, or the
// platform back gesture (one pushState entry so mobile back never leaves the
// interaction). All buttons ride dom.ts `button` (isTrusted-gated).
//
// Two media, two contracts (F29.1): the WITNESS is a raster — the stage owns
// every gesture and zoom/pan applies. The RECONSTRUCTION is a live document
// (sandbox="" srcdoc, no scripts) — the gesture layer stands down and the
// frame keeps its native scroll and text selection; zooming a DOM you can
// scroll is the screenshot's contract, not this one's.

import type { CaptureRef } from "@onlay/protocol";
import { buildSrcdoc } from "@onlay/render";
import { age, captureResidueLine, lookStagePart } from "@onlay/render/interaction-view";
import { button, clear, el } from "./dom";

export interface LightboxOpts {
  /** Ordered newest-first — the same list the hero scrubs. */
  looks: CaptureRef[];
  index: number;
  /** Part bytes over the participant route (detail wires api.part). */
  fetchPart: (ref: CaptureRef, part: string) => Promise<Uint8Array | null>;
  /** Cache-stable blob URL minting (detail wires its urlPool). */
  partUrl: (ref: CaptureRef, part: string, bytes: Uint8Array, mime: string) => string;
}

const SCALE_MIN = 1;
const SCALE_MAX = 5;
const DBL_ZOOM = 2.5;

/** One lightbox at a time; opening while open replaces the content. */
let active: { teardown: () => void; update: (looks: CaptureRef[]) => void } | null = null;

export function openLightbox(opts: LightboxOpts): void {
  // Replace-in-place: plain teardown, NO history.back() — this call pushes its
  // own marker synchronously, and an async back() would then pop the wrong one.
  active?.teardown();
  active = null;
  const box = el("div", "lightbox");

  let looks = opts.looks;
  let cursor = Math.max(0, Math.min(looks.length - 1, opts.index));
  let reconstructed = false;
  // True while the stage shows the live reconstruction document — the zoom/
  // pan gesture layer is off and the frame scrolls/selects natively (F29.1).
  let native = false;

  // ── transform state: translate(tx,ty) scale(s), origin 0 0 ──
  let scale = 1;
  let tx = 0;
  let ty = 0;
  const media = el("div", "lb-media");
  const apply = (): void => {
    media.style.transform = `translate(${tx}px, ${ty}px) scale(${scale})`;
    media.classList.toggle("zoomed", scale > 1);
  };
  const reset = (): void => {
    scale = 1;
    tx = 0;
    ty = 0;
    apply();
  };
  /** Zoom keeping the stage point (px,py) fixed: t' = p − (p − t)·k. */
  const zoomAt = (px: number, py: number, next: number): void => {
    const s = Math.max(SCALE_MIN, Math.min(SCALE_MAX, next));
    const k = s / scale;
    tx = px - (px - tx) * k;
    ty = py - (py - ty) * k;
    scale = s;
    if (scale === 1) {
      tx = 0;
      ty = 0;
    }
    apply();
  };

  const stage = el("div", "lb-stage");
  stage.append(media);

  // ── gestures: wheel zoom, double-tap toggle, one-pointer pan, two-pointer
  // pinch. touch-action: none (CSS) hands raw pointer moves to us. ──
  const pointers = new Map<number, { x: number; y: number }>();
  // Pinch anchors to the FULL transform at pinch start (dist + scale + pan +
  // midpoint), and every move derives absolutely from that base — path-
  // independent, so sequential per-finger events can't drift the image, and
  // a constant-distance two-finger drag pans (the midpoint moves the image).
  let pinchBase: {
    dist: number;
    scale: number;
    tx: number;
    ty: number;
    mid: { x: number; y: number };
  } | null = null;
  const stagePoint = (e: { clientX: number; clientY: number }): { x: number; y: number } => {
    const r = stage.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  };
  stage.addEventListener("wheel", (e) => {
    if (!e.isTrusted || native) return;
    e.preventDefault();
    const p = stagePoint(e);
    zoomAt(p.x, p.y, scale * (e.deltaY < 0 ? 1.2 : 1 / 1.2));
  });
  stage.addEventListener("dblclick", (e) => {
    if (!e.isTrusted || native) return;
    e.preventDefault();
    const p = stagePoint(e);
    if (scale > 1) reset();
    else zoomAt(p.x, p.y, DBL_ZOOM);
  });
  stage.addEventListener("pointerdown", (e) => {
    if (!e.isTrusted || native) return;
    stage.setPointerCapture(e.pointerId);
    pointers.set(e.pointerId, stagePoint(e));
    if (pointers.size === 2) {
      const [a, b] = [...pointers.values()];
      if (a && b)
        pinchBase = {
          dist: Math.hypot(a.x - b.x, a.y - b.y),
          scale,
          tx,
          ty,
          mid: { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 },
        };
    }
  });
  stage.addEventListener("pointermove", (e) => {
    if (!e.isTrusted || native || !pointers.has(e.pointerId)) return;
    const prev = pointers.get(e.pointerId);
    const now = stagePoint(e);
    pointers.set(e.pointerId, now);
    if (pointers.size === 2 && pinchBase) {
      const [a, b] = [...pointers.values()];
      if (!a || !b) return;
      const dist = Math.hypot(a.x - b.x, a.y - b.y);
      if (dist > 0 && pinchBase.dist > 0) {
        // Absolute from the base: scale by the distance ratio, and carry the
        // base midpoint's image point to the CURRENT midpoint (pan rides in).
        const next = Math.max(
          SCALE_MIN,
          Math.min(SCALE_MAX, pinchBase.scale * (dist / pinchBase.dist)),
        );
        const k = next / pinchBase.scale;
        const mid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
        tx = mid.x - (pinchBase.mid.x - pinchBase.tx) * k;
        ty = mid.y - (pinchBase.mid.y - pinchBase.ty) * k;
        scale = next;
        apply();
      }
    } else if (pointers.size === 1 && prev && scale > 1) {
      tx += now.x - prev.x;
      ty += now.y - prev.y;
      apply();
    }
  });
  const endPointer = (e: PointerEvent): void => {
    pointers.delete(e.pointerId);
    if (pointers.size < 2) pinchBase = null;
    // A gesture that lands back at 1× snaps home — a two-finger pan at base
    // zoom must not strand a displaced image with no zoom to pan back with.
    if (pointers.size === 0 && scale === 1) reset();
  };
  stage.addEventListener("pointerup", endPointer);
  stage.addEventListener("pointercancel", endPointer);
  // An unzoomed tap on the BACKDROP closes — the familiar lightbox exit; a
  // zoomed tap is a pan, never an exit. `.lb-media` blankets the stage, so
  // the backdrop is the stage OR the media wrapper — anything but the image/
  // frame itself.
  stage.addEventListener("click", (e) => {
    if (!e.isTrusted) return;
    if ((e.target === stage || e.target === media) && scale === 1) close();
  });

  // ── chrome: top bar (label + close), bottom bar (scrub, toggle, residue) ──
  const label = el("span", "lb-label");
  const closeBtn = button("icon-btn lb-close", "×", () => close());
  closeBtn.setAttribute("aria-label", "Close");
  const top = el("div", "lb-top");
  top.append(label, closeBtn);

  const residue = el("p", "cap-residue lb-residue");
  const bottom = el("div", "lb-bottom");

  function renderChrome(): void {
    const look = looks[cursor];
    if (!look) return;
    label.textContent = `${cursor === 0 ? "latest" : `${cursor} back`} · captured ${age(look.capturedAt)} ago`;
    residue.textContent = captureResidueLine(look) ?? "";
    residue.hidden = residue.textContent === "";
    clear(bottom);
    if (looks.length > 1) {
      const older = button("icon-btn", "‹", () => move(cursor + 1));
      older.setAttribute("aria-label", "Older look");
      older.disabled = cursor >= looks.length - 1;
      const newer = button("icon-btn", "›", () => move(cursor - 1));
      newer.setAttribute("aria-label", "Newer look");
      newer.disabled = cursor <= 0;
      bottom.append(older, newer);
    }
    // A rasterless revision (document-only — a legal capture) has ONLY the
    // reconstruction: no toggle to a screenshot that doesn't exist.
    if (lookStagePart(look)) {
      bottom.append(
        button(
          "btn btn-secondary lb-toggle",
          reconstructed ? "Screenshot" : "Reconstruction",
          () => {
            reconstructed = !reconstructed;
            renderMedia();
            renderChrome();
          },
        ),
      );
    }
  }

  function renderMedia(): void {
    const look = looks[cursor];
    if (!look) return;
    reset();
    clear(media);
    const part = lookStagePart(look);
    native = reconstructed || !part;
    stage.classList.toggle("native", native);
    if (native) {
      const iframe = document.createElement("iframe");
      iframe.setAttribute("sandbox", "");
      iframe.className = "cap-frame lb-frame";
      media.append(iframe);
      void buildSrcdoc({ ref: look, fetchPart: (n) => opts.fetchPart(look, n) }).then((r) => {
        iframe.srcdoc = r.srcdoc;
      });
      return;
    }
    if (!part) return; // unreachable (native covers it) — narrows the type
    const img = el("img", "lb-img") as HTMLImageElement;
    img.alt = "captured look";
    img.draggable = false;
    const mime = look.parts.find((p) => p.name === part || p.role === part)?.mime ?? "image/webp";
    void opts.fetchPart(look, part).then((bytes) => {
      if (bytes) img.src = opts.partUrl(look, part, bytes, mime);
    });
    media.append(img);
  }

  function move(i: number): void {
    cursor = Math.max(0, Math.min(looks.length - 1, i));
    renderMedia();
    renderChrome();
  }

  /** Live truth reaching an OPEN viewer (F24 through F29): a landed fresh
   *  look joins the scrubber; "latest" follows the new latest, a scrubbed-
   *  back viewer keeps the look it's on (captureId-anchored, the old Looks
   *  screen's contract); a look pruned out from under the cursor falls to
   *  the new latest instead of fetching blanks. */
  function update(next: CaptureRef[]): void {
    const current = looks[cursor];
    const sameList =
      next.length === looks.length && next.every((l, i) => l.captureId === looks[i]?.captureId);
    if (sameList) return;
    const kept = current ? next.findIndex((l) => l.captureId === current.captureId) : -1;
    looks = next;
    if (cursor !== 0 && kept >= 0) {
      cursor = kept;
      renderChrome(); // same media, new scrub bounds/label
      return;
    }
    cursor = 0;
    const stillCurrent = current && kept === 0;
    if (!stillCurrent) renderMedia();
    renderChrome();
  }

  // ── lifecycle: Esc + the platform back gesture both close. One history
  // entry is pushed so mobile back closes the viewer, not the detail screen;
  // an explicit close consumes that entry (history.back) so the stack never
  // grows. The router only hears hashchange — same-URL pushState is silent. ──
  const onKey = (e: KeyboardEvent): void => {
    if (!e.isTrusted) return;
    if (e.key === "Escape") close();
    else if (e.key === "ArrowLeft") move(cursor + 1);
    else if (e.key === "ArrowRight") move(cursor - 1);
  };
  const onPop = (): void => teardown();
  let closed = false;
  function teardown(): void {
    if (closed) return;
    closed = true;
    window.removeEventListener("keydown", onKey);
    window.removeEventListener("popstate", onPop);
    box.remove();
    if (active?.teardown === teardown) active = null;
  }
  function close(): void {
    if (closed) return;
    teardown();
    history.back(); // consume the lightbox history entry
  }
  window.addEventListener("keydown", onKey);
  history.pushState({ lightbox: true }, "", location.href);
  window.addEventListener("popstate", onPop);
  active = { teardown, update };

  box.append(top, stage, bottom, residue);
  document.body.append(box);
  renderMedia();
  renderChrome();
}

/** Programmatic close (screen dispose / replace): full listener cleanup, and
 *  — when the history's CURRENT entry is still the viewer's own marker — a
 *  history.back() to consume it, so no inert entry is left for the next back
 *  press. When a navigation already stacked a new entry on top (dispose via
 *  route change), the marker stays sandwiched in history: backing onto it
 *  re-renders the detail via hashchange; one silent press remains beneath —
 *  accepted, never a stranded UI. */
export function closeLightbox(): void {
  if (!active) return;
  const onOwnEntry = (history.state as { lightbox?: boolean } | null)?.lightbox === true;
  active.teardown();
  active = null;
  if (onOwnEntry) history.back();
}

/** Push fresh look truth into an open viewer (no-op when closed). */
export function updateLightbox(looks: CaptureRef[]): void {
  active?.update(looks);
}
