// Drag isolation: what typing-router.ts does for keys, for the pointer events
// of every drag in the overlay: a composer card moved by its header, the
// thread panel moved by its header or resized by its grip, and the launcher
// (`routePointerDrag` for the last three). A page can listen on `window` in the
// capture phase and see every pointer, mouse and touch event the overlay gets,
// retargeted to the host: it could take the pointer for a drag of its own,
// cancel the gesture, or simply watch it. The content script's listener on
// `window`, registered at `document_start` before any page script, takes the
// overlay's drag gesture there instead (`stopImmediatePropagation`) and hands
// the ORIGINAL event (so `isTrusted` holds) to the mover:
//
// - a press, when the point is on a registered handle (found through the root
//   the content script holds) and the mover starts a drag from it; a press it
//   does not take (a header button, a launcher marker, an untrusted event)
//   goes on as before;
// - from that press on, the gesture is the overlay's: every pointer, mouse,
//   touch and capture event of it (moves, the release, a cancel, the capture
//   taken and lost, the compatibility mouse events, the touch events of a
//   finger) is stopped at the window, and the mover hears its pointer's moves
//   and its end. A lost capture the browser sends to the document (the host
//   was removed) ends the drag too.
// - a finger's arrival over a handle (its `pointerover` and `pointerenter`,
//   which come before its press, the document's and its root element's
//   included) and its leaving at the end are the gesture's too;
// - the gesture stays the overlay's a short while after the release (until
//   its trailing events are in), and a click the drag made (the pointer
//   travelled past the handle's slop) is stopped with it; a press that did not
//   move clicks as a press does.
//
// Handles register with `routeDrag`, which ALSO adds ordinary listeners on the
// handle: unit tests and any event that never reaches the window listener keep
// the native path.
import {
  listenOnHandle,
  MOVER_POINTER_EVENTS,
  type MoverPointer,
} from "@onlay/render/floating-card";

interface Grab {
  handle: HTMLElement;
  on: MoverPointer;
  /** How far (CSS px) the pointer may travel and still click (the launcher's 4). */
  slop: number;
}

const grabs = new Set<Grab>();

/** Every drag `routePointerDrag` made, by its cancel: `cancelDrags` ends them all. */
const cancels = new Set<() => void>();

/**
 * A mover's pointer delivery in the overlay: natively on the handle, and
 * through the isolation. `slop` is how far a press may travel and still be a
 * click (default 0: any move makes it a drag, whose click is the overlay's).
 */
export function routeDrag(
  handle: HTMLElement,
  on: MoverPointer,
  opts: { slop?: number } = {},
): void {
  // The native path honours a routed drag that holds: no second drag starts beside it.
  listenOnHandle(handle, { ...on, down: (e) => !dragHolds() && on.down(e) });
  grabs.add({ handle, on, slop: opts.slop ?? 0 });
}

/** A routed drag holds now: while it does, no other drag in the overlay may start. */
function dragHolds(): boolean {
  const g = gesture;
  return g !== null && g.until === null && g.grab.on.dragging() === g.pointerId;
}

/** End every drag in progress (the host is torn down or remounted). */
export function cancelDrags(): void {
  for (const cancel of [...cancels]) cancel();
  gesture = null;
}

/** What a drag that is not a card's mover (the thread panel, its resize grip, the launcher) does. */
export interface PointerDrag {
  /** Whether a press here may start a drag (a header button stays a button). Default: any. */
  accept?(e: PointerEvent): boolean;
  /** The drag started, from this press. */
  begin(e: PointerEvent): void;
  /** A trusted move of the dragging pointer. */
  move(e: PointerEvent): void;
  /** The drag is over: its release, a cancel, a lost capture, the window's blur or `cancel()`. */
  end(): void;
  /** How far the pointer may travel and still click (default 0). */
  slop?: number;
}

/**
 * Make `handle` drag by the same rules and through the same isolation as a
 * card's mover: only a trusted primary press whose pointer the handle could
 * capture starts it, only trusted moves of that pointer follow, and it ends on
 * its release, a cancel, a lost capture, the window losing focus, or
 * `cancel()` (the surface closed). The press is taken (`preventDefault`), so
 * no compatibility mouse events follow it.
 */
export function routePointerDrag(
  handle: HTMLElement,
  d: PointerDrag,
  trusted: (e: Event) => boolean = (e) => e.isTrusted === true,
): { cancel(): void } {
  const win = handle.ownerDocument?.defaultView ?? null;
  let drag: { id: number } | null = null;
  // Only the browser's own blur ends a drag: a page can dispatch a made-up one.
  const onBlur = (e: Event): void => {
    if (trusted(e)) stop();
  };

  function stop(): void {
    if (!drag) return;
    const id = drag.id;
    drag = null;
    win?.removeEventListener("blur", onBlur);
    try {
      if (handle.hasPointerCapture?.(id)) handle.releasePointerCapture(id);
    } catch {
      // the pointer is already gone
    }
    d.end();
  }

  routeDrag(
    handle,
    {
      down(e) {
        if (!trusted(e) || e.button !== 0 || drag) return false;
        if (d.accept && !d.accept(e)) return false;
        try {
          handle.setPointerCapture(e.pointerId);
        } catch {
          // a pointer that is already gone, or a handle that is not on screen: no drag
          return false;
        }
        e.preventDefault();
        drag = { id: e.pointerId };
        win?.addEventListener("blur", onBlur);
        d.begin(e);
        return true;
      },
      move(e) {
        if (!drag || e.pointerId !== drag.id || !trusted(e)) return;
        d.move(e);
      },
      end(e) {
        if (!drag || e.pointerId !== drag.id || !trusted(e)) return;
        stop();
      },
      dragging: () => drag?.id ?? null,
    },
    d.slop === undefined ? {} : { slop: d.slop },
  );
  cancels.add(stop);
  return { cancel: stop };
}

/** The event as the mover should see it: the original object, with the inner target. */
function withTarget(e: Event, target: EventTarget): Event {
  return new Proxy(e, {
    get(obj, prop) {
      if (prop === "target" || prop === "srcElement") return target;
      const value = Reflect.get(obj, prop, obj);
      return typeof value === "function" ? value.bind(obj) : value;
    },
  });
}

function fromOverlay(target: EventTarget | null, m: { host: Element; root: ShadowRoot }): boolean {
  if (target === m.host) return true;
  const node = target as Node | null;
  return typeof node?.getRootNode === "function" && node.getRootNode() === m.root;
}

/**
 * Every event a page can watch of a pointer gesture: the pointer's own
 * (capture taken and lost included), the compatibility mouse events, a
 * finger's touch events, and the clicks a release makes.
 */
export const GESTURE_EVENTS = [
  "pointerdown",
  "pointermove",
  "pointerrawupdate",
  "pointerup",
  "pointercancel",
  "gotpointercapture",
  "lostpointercapture",
  "pointerover",
  "pointerout",
  "pointerenter",
  "pointerleave",
  "mousedown",
  "mousemove",
  "mouseup",
  "mouseover",
  "mouseout",
  "mouseenter",
  "mouseleave",
  "touchstart",
  "touchmove",
  "touchend",
  "touchcancel",
  "click",
  "auxclick",
  "dblclick",
  "contextmenu",
] as const;

/** The clicks a release makes: the drag's own when it moved, the page's press otherwise. */
const CLICKS = new Set(["click", "auxclick", "dblclick", "contextmenu"]);
/** How long after its mover stops a gesture keeps its trailing events (compatibility, touch end, click). */
const TRAIL_MS = 500;

/**
 * The drag gesture the overlay took. It holds while its mover drags. A
 * release, cancel or lost capture this router delivers leaves its trailing
 * events until its first click, the next trusted press anywhere, or `until`,
 * whichever comes first (a click is the drag's only from its own pointer); a mover that stops any other way (blur, the surface
 * closing, `cancelDrags`) ends it at once.
 */
let gesture: {
  grab: Grab;
  pointerId: number;
  at: { x: number; y: number };
  /** The pointer travelled past the handle's slop: its click is the drag's. */
  moved: boolean;
  /** A finger's drag: the identifier of its touch, once its touchstart came. */
  touch: boolean;
  touchId: number | null;
  /** When the gesture is over; null while its mover drags. */
  until: number | null;
} | null = null;

/** The point is on a registered handle of the mounted root. */
function onHandle(m: { root: ShadowRoot }, e: PointerEvent): boolean {
  const hit = m.root.elementFromPoint?.(e.clientX, e.clientY) ?? null;
  if (!hit) return false;
  for (const g of grabs) if (g.handle.isConnected && g.handle.contains(hit)) return true;
  return false;
}

/** The touch identifiers an event changed (none for anything but a touch event). */
function touchesOf(ev: Event): number[] {
  const list = (ev as TouchEvent).changedTouches;
  if (!list) return [];
  const ids: number[] = [];
  for (let i = 0; i < list.length; i += 1) {
    const t = list[i];
    if (t) ids.push(t.identifier);
  }
  return ids;
}

/** Install the isolation on `win` (at `document_start`). `current` is the mounted host and its root. */
export function installDragIsolation(
  win: Window,
  current: () => { host: Element; root: ShadowRoot } | null,
  now: () => number = () => Date.now(),
): void {
  const doc = win.document;
  const handle = (ev: Event): void => {
    // A page's own events are the page's: they never touch a drag.
    if (ev.isTrusted !== true) return;
    const m = current();
    if (!m) return;
    const t = now();
    let gs = gesture;
    // Its mover stopped without a release this router saw (blur, the surface
    // closing, teardown): the gesture is over. One released here is over at
    // its deadline.
    if (
      gs &&
      ((gs.until === null && gs.grab.on.dragging() !== gs.pointerId) ||
        (gs.until !== null && t > gs.until))
    )
      gesture = gs = null;
    const type = ev.type;
    const e = ev as PointerEvent;
    const pointerEvent = type.startsWith("pointer") || type.endsWith("pointercapture");
    const same = gs !== null && e.pointerId === gs.pointerId;
    const ours = fromOverlay(ev.target, m);
    // Any trusted press, anywhere, ends what a released drag still trailed:
    // what comes next is that press's, not the drag's.
    if (type === "pointerdown" && gs && gs.until !== null) gesture = gs = null;
    // The drag's lost capture sent to the document (the handle left it): it
    // ends. Only while it holds: after its release, one there is the page's.
    if (type === "lostpointercapture" && !ours && (ev.target === doc || ev.target === win)) {
      if (!gs || !same || gs.until !== null) return;
      ev.stopImmediatePropagation();
      if (gs.grab.on.dragging() === e.pointerId) gs.grab.on.end(e);
      gs.until ??= t + TRAIL_MS;
      return;
    }
    // A finger entering and leaving the document around a drag of a handle:
    // the host's ancestors (the document and its root element) each hear it
    // with themselves as target. The arrival is over a handle, the leaving is
    // the drag's own pointer.
    /** No drag holds now: a finger arriving over a handle may be the start of one. */
    const free = gs === null || gs.until !== null;
    if (
      (type === "pointerenter" || type === "pointerleave") &&
      e.pointerType === "touch" &&
      (ev.target === doc || ev.target === doc.documentElement)
    ) {
      if (type === "pointerenter" ? free && onHandle(m, e) : same) ev.stopImmediatePropagation();
      return;
    }
    if (!ours) return;
    // A finger is over the page only while it touches it: its arrival over a
    // handle (before its press) is the drag's start, and the page's never.
    if (
      (type === "pointerover" || type === "pointerenter") &&
      e.pointerType === "touch" &&
      free &&
      onHandle(m, e)
    ) {
      ev.stopImmediatePropagation();
      return;
    }
    if (type === "pointerdown") {
      // While a drag holds, another pointer's press is not the drag's (its mover refuses it).
      if (!free) return;
      gesture = null;
      for (const g of grabs) {
        if (!g.handle.isConnected || g.handle.getRootNode() !== m.root) {
          if (!g.handle.isConnected && g.on.dragging() === null) grabs.delete(g);
          continue;
        }
        const hit = m.root.elementFromPoint?.(e.clientX, e.clientY) ?? null;
        if (!hit || !g.handle.contains(hit)) continue;
        if (g.on.down(withTarget(e, hit) as PointerEvent)) {
          e.stopImmediatePropagation();
          gesture = {
            grab: g,
            pointerId: e.pointerId,
            at: { x: e.clientX, y: e.clientY },
            moved: false,
            touch: e.pointerType === "touch",
            touchId: null,
            until: null,
          };
        }
        return;
      }
      return;
    }
    if (!gs) return;
    // Only the accepted pointer, and only its finger's touch, is the drag's.
    if (pointerEvent && !same) return;
    if (type.startsWith("touch")) {
      if (!gs.touch) return;
      const ids = touchesOf(ev);
      if (gs.touchId === null && type === "touchstart" && ids.length > 0)
        gs.touchId = ids[0] ?? null;
      if (gs.touchId === null || !ids.includes(gs.touchId)) return;
      ev.stopImmediatePropagation();
      return;
    }
    if (CLICKS.has(type)) {
      // Only the drag's own pointer clicks for it. Every other click needs a
      // press first, and any press ends what the drag trailed; a click the
      // keyboard makes names no pointer (-1). The event comes from the
      // overlay (its target is the host), which is all a window listener
      // can know: with a closed root, its composed path stops at the host.
      if (!same) return;
      // A drag's click is ours; a press that did not travel clicks as a press does.
      if (gs.moved) ev.stopImmediatePropagation();
      // Its click is the last of a gesture: what trailed is over.
      if (type === "click") gesture = null;
      return;
    }
    ev.stopImmediatePropagation();
    const which = (MOVER_POINTER_EVENTS as Record<string, "down" | "move" | "end">)[type];
    if (!which || which === "down") return;
    if (which === "move" && gs.until === null) {
      const d = Math.hypot(e.clientX - gs.at.x, e.clientY - gs.at.y);
      if (d > gs.grab.slop) gs.moved = true;
    }
    if (gs.grab.on.dragging() === e.pointerId) gs.grab.on[which](e);
    if (which === "end") gs.until ??= t + TRAIL_MS;
  };
  for (const type of GESTURE_EVENTS) win.addEventListener(type, handle, { capture: true });
}
