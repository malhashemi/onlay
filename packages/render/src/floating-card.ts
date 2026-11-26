// A floating card: the composer the extension opens beside a picked block, and
// the landing page's copy of it. Where it sits, how tall its editor may grow,
// and how a person moves it. The rules:
//
// - The card stays inside the viewport with `margin` clear on every side.
// - Its editor grows with its content up to `editorMax`: the least of the
//   editor's own cap, a share of the viewport's height, and the room the rest
//   of the card leaves. Past that the editor scrolls inside itself, so growing
//   text never pushes the card's controls off screen, on a small window too.
// - The card would like its top-left at `want` (beside its block, or where the
//   person dragged it). When it is too tall to fit below that point, its
//   bottom edge holds at the viewport's and its top rises: it grows upward,
//   one pixel for each pixel of text, and settles back down as the text
//   shrinks. A card taller than the viewport (only on a tiny window) is cut to
//   it and scrolls inside.
//
// The placement is a pure function of sizes; `attachMover` is the one piece of
// DOM here: drag by the header (pointer and touch), arrow keys on the grip.

export interface Point {
  x: number;
  y: number;
}

export interface Size {
  w: number;
  h: number;
}

/** An editor's share of the viewport's height, at most. */
export const EDITOR_VIEWPORT_SHARE = 0.4;

export interface CardLayoutInput {
  /** The viewport (the fixed card's containing block). */
  view: Size;
  /** Kept clear between the card and each viewport edge. */
  margin: number;
  /** Where the card's top-left would like to be. */
  want: Point;
  /** The card's width as authored. */
  width: number;
  /** The card's natural height without its editor box (head, fields, buttons, borders). */
  chrome: number;
  /**
   * The editor, when the card has one: `content` is the height its text asks
   * for (padding and border included), `min` its least height, `cap` the most
   * it may take whatever the viewport.
   */
  editor?: { content: number; min: number; cap: number };
}

export interface CardLayout {
  left: number;
  top: number;
  width: number;
  /** The card's own max-height: the viewport less its margins. */
  maxHeight: number;
  /** The editor's max-height (0 without an editor). */
  editorMax: number;
  /** How tall the card is at this layout. */
  height: number;
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(v, Math.max(lo, hi)));
}

/** The most an editor may grow on a card whose other parts take `chrome`. */
export function editorMaxHeight(
  viewH: number,
  margin: number,
  chrome: number,
  min: number,
  cap: number,
): number {
  const room = viewH - 2 * margin - chrome;
  return Math.max(min, Math.floor(Math.min(cap, viewH * EDITOR_VIEWPORT_SHARE, room)));
}

/** Where the card sits and how tall its editor may be. */
export function layoutCard(i: CardLayoutInput): CardLayout {
  const availW = Math.max(0, i.view.w - 2 * i.margin);
  const availH = Math.max(0, i.view.h - 2 * i.margin);
  const width = Math.min(i.width, availW);
  const editorMax = i.editor
    ? editorMaxHeight(i.view.h, i.margin, i.chrome, i.editor.min, i.editor.cap)
    : 0;
  const editorH = i.editor ? Math.min(Math.max(i.editor.content, i.editor.min), editorMax) : 0;
  const height = Math.min(i.chrome + editorH, availH);
  return {
    left: Math.round(clamp(i.want.x, i.margin, i.view.w - i.margin - width)),
    top: Math.round(clamp(i.want.y, i.margin, i.view.h - i.margin - height)),
    width,
    maxHeight: availH,
    editorMax,
    height,
  };
}

/** Where an arrow key moves a card by: `step`, four times that with Shift. */
export function nudge(key: string, shift: boolean, step: number): Point | null {
  const d = shift ? step * 4 : step;
  switch (key) {
    case "ArrowLeft":
      return { x: -d, y: 0 };
    case "ArrowRight":
      return { x: d, y: 0 };
    case "ArrowUp":
      return { x: 0, y: -d };
    case "ArrowDown":
      return { x: 0, y: d };
    default:
      return null;
  }
}

/** What a header press must leave alone: its buttons, links and fields. */
const NOT_A_HANDLE = "button, a, input, textarea, select, [contenteditable], [role='textbox']";

export interface MoverOpts {
  /** Where a drag starts: the card's header. */
  handle: HTMLElement;
  /** The grip: a button inside the handle that also drags, and moves by arrow keys. */
  grip: HTMLElement;
  /** The card's top-left now. */
  position(): Point;
  /** Move the card's top-left here; the caller clamps it to the viewport. */
  moveTo(p: Point): void;
  /** A move started (drag or key): close menus that hang off the card. */
  onStart?(): void;
  /** px per arrow key press. */
  step(): number;
  /** Only input the browser made moves the card (default: `isTrusted`). */
  trusted?(e: Event): boolean;
  /** How key listeners are added (the overlay routes them inside its shadow root). */
  listen?(target: EventTarget, type: string, fn: (e: Event) => void): void;
  /**
   * How the handle's pointer listeners are added (default: `listenOnHandle`).
   * The overlay also takes them at the window, before the page sees them.
   */
  pointer?(handle: HTMLElement, on: MoverPointer): void;
}

/** A mover's pointer side, for whoever delivers the handle's pointer events. */
export interface MoverPointer {
  /** A press on the handle; true when it started a drag (the press is the card's). */
  down(e: PointerEvent): boolean;
  move(e: PointerEvent): void;
  /** `pointerup`, `pointercancel` or `lostpointercapture`. */
  end(e: PointerEvent): void;
  /** The pointer dragging the card now, or null. */
  dragging(): number | null;
}

/** The events a mover's handle hears, and which of its handlers each goes to. */
export const MOVER_POINTER_EVENTS = {
  pointerdown: "down",
  pointermove: "move",
  pointerup: "end",
  pointercancel: "end",
  lostpointercapture: "end",
} as const satisfies Record<string, "down" | "move" | "end">;

/** The default delivery: ordinary listeners on the handle. */
export function listenOnHandle(handle: HTMLElement, on: MoverPointer): void {
  for (const [type, which] of Object.entries(MOVER_POINTER_EVENTS)) {
    handle.addEventListener(type, (e) => {
      on[which](e as PointerEvent);
    });
  }
}

export interface Mover {
  /** End a drag now (the card closed): its pointer is released, the card stays put. */
  cancel(): void;
}

/**
 * Make a card movable by its header and its grip. A drag starts only from a
 * trusted press whose pointer the handle could capture, follows only trusted
 * moves of that pointer, and ends on its release, a cancel, a lost capture,
 * the window losing focus (the browser's own blur), or `cancel()`.
 */
export function attachMover(o: MoverOpts): Mover {
  const trusted = o.trusted ?? ((e: Event) => e.isTrusted === true);
  const listen =
    o.listen ??
    ((t: EventTarget, type: string, fn: (e: Event) => void) => t.addEventListener(type, fn));
  const win = o.handle.ownerDocument?.defaultView ?? null;
  let drag: { id: number; from: Point; at: Point } | null = null;
  // Only the browser's own blur ends a drag: a page can dispatch a made-up one.
  const onBlur = (e: Event): void => {
    if (trusted(e)) stop();
  };

  function stop(): void {
    if (!drag) return;
    const id = drag.id;
    drag = null;
    o.handle.classList.remove("is-dragging");
    win?.removeEventListener("blur", onBlur);
    try {
      if (o.handle.hasPointerCapture?.(id)) o.handle.releasePointerCapture(id);
    } catch {
      // the pointer is already gone
    }
  }

  const on: MoverPointer = {
    down(e) {
      if (!trusted(e) || e.button !== 0 || drag) return false;
      const t = e.target as Element | null;
      const hit = t?.closest?.(NOT_A_HANDLE) ?? null;
      if (hit && !o.grip.contains(hit)) return false;
      try {
        o.handle.setPointerCapture(e.pointerId);
      } catch {
        // a pointer that is already gone, or a handle that is not on screen: no drag
        return false;
      }
      e.preventDefault();
      drag = { id: e.pointerId, from: o.position(), at: { x: e.clientX, y: e.clientY } };
      o.handle.classList.add("is-dragging");
      win?.addEventListener("blur", onBlur);
      o.onStart?.();
      return true;
    },
    move(e) {
      if (!drag || e.pointerId !== drag.id || !trusted(e)) return;
      o.moveTo({ x: drag.from.x + e.clientX - drag.at.x, y: drag.from.y + e.clientY - drag.at.y });
    },
    end(e) {
      if (!drag || e.pointerId !== drag.id || !trusted(e)) return;
      stop();
    },
    dragging: () => drag?.id ?? null,
  };
  (o.pointer ?? listenOnHandle)(o.handle, on);

  listen(o.grip, "keydown", (ev) => {
    const e = ev as KeyboardEvent;
    if (!trusted(e) || e.altKey || e.ctrlKey || e.metaKey) return;
    const d = nudge(e.key, e.shiftKey, o.step());
    if (!d) return;
    e.preventDefault();
    e.stopPropagation();
    o.onStart?.();
    const p = o.position();
    o.moveTo({ x: p.x + d.x, y: p.y + d.y });
  });

  return { cancel: stop };
}
