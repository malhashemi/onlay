// Typing isolation. A visited page can listen on `window` in the capture phase
// and so see every key, input, composition and clipboard event before the
// overlay does, even inside a closed shadow root (the event is merely
// retargeted to the host). The content script runs at `document_start`, so its
// listener on `window` is the first one registered for these events. When the
// event's target as seen there is the overlay host, it stops the event right
// there (`stopImmediatePropagation`, never `preventDefault`: the browser still
// inserts the text) and hands the ORIGINAL event to this router, which plays the
// overlay's own listeners in DOM order: the overlay's window-capture
// listeners, then capture and bubble listeners from the shadow root down to the
// focused element and back up, then the overlay's window-bubble listeners.
// The original event object keeps `isTrusted`, so trusted-input gates still
// hold. `stopPropagation` inside an overlay listener stops the routed walk.
//
// Overlay code registers these listeners with `onRouted` / `onWindowRouted`,
// which ALSO add an ordinary listener: unit tests and any event that never
// reaches the host keep the native path.

/** The events a page must never see when they come from the overlay. */
export const ROUTED_TYPES = [
  "keydown",
  "keyup",
  "keypress",
  "beforeinput",
  "input",
  "compositionstart",
  "compositionupdate",
  "compositionend",
  "paste",
  "cut",
  "copy",
  "drop",
] as const;

type Handler = (e: Event) => void;

interface Reg {
  fn: Handler;
  capture: boolean;
}

const routed = new Set<string>(ROUTED_TYPES);
const elementRegs = new WeakMap<EventTarget, Map<string, Reg[]>>();
const windowRegs = new WeakMap<Window, Map<string, Reg[]>>();

function push(map: Map<string, Reg[]>, type: string, reg: Reg): void {
  const list = map.get(type);
  if (list) list.push(reg);
  else map.set(type, [reg]);
}

/** An overlay element's listener for a routed event type (also added natively). */
export function onRouted<E extends Event>(
  target: EventTarget,
  type: string,
  fn: (e: E) => void,
  opts: { capture?: boolean } = {},
): void {
  target.addEventListener(type, fn as Handler, opts);
  if (!routed.has(type)) return;
  let map = elementRegs.get(target);
  if (!map) {
    map = new Map();
    elementRegs.set(target, map);
  }
  push(map, type, { fn: fn as Handler, capture: opts.capture === true });
}

/** The overlay's own window-level listener for a routed event type (also added natively). */
export function onWindowRouted<E extends Event>(
  win: Window,
  type: string,
  fn: (e: E) => void,
  opts: { capture?: boolean } = {},
): void {
  win.addEventListener(type, fn as Handler, opts);
  if (!routed.has(type)) return;
  let map = windowRegs.get(win);
  if (!map) {
    map = new Map();
    windowRegs.set(win, map);
  }
  push(map, type, { fn: fn as Handler, capture: opts.capture === true });
}

/**
 * The event as an overlay listener should see it: the original object (so
 * `isTrusted`, `key`, `clipboardData`, `preventDefault` are the real ones), with
 * the inner target and current target, and a propagation flag of its own.
 */
function view(
  e: Event,
  state: { stopped: boolean; immediate: boolean; target: EventTarget; current: EventTarget | null },
  path: EventTarget[],
): Event {
  return new Proxy(e, {
    get(obj, prop) {
      if (prop === "stopPropagation")
        return () => {
          state.stopped = true;
        };
      if (prop === "stopImmediatePropagation")
        return () => {
          state.stopped = true;
          state.immediate = true;
        };
      if (prop === "target" || prop === "srcElement") return state.target;
      if (prop === "currentTarget") return state.current;
      if (prop === "composedPath") return () => [...path];
      const value = Reflect.get(obj, prop, obj);
      return typeof value === "function" ? value.bind(obj) : value;
    },
  });
}

/** Run one node's listeners of one phase; false once a listener stopped the walk. */
function runList(
  list: Reg[] | undefined,
  capture: boolean,
  ev: Event,
  state: { stopped: boolean; immediate: boolean; current: EventTarget | null },
  current: EventTarget,
): void {
  if (!list) return;
  state.current = current;
  for (const reg of [...list]) {
    if (reg.capture !== capture) continue;
    try {
      reg.fn(ev);
    } catch (err) {
      console.error("[onlay] routed listener failed", err);
    }
    if (state.immediate) return;
  }
}

/** Where a routed event lands inside the root: the focused element, or under the pointer for a drop. */
function innerTarget(e: Event, root: ShadowRoot): EventTarget {
  if (e.type === "drop") {
    const m = e as MouseEvent;
    const hit = root.elementFromPoint?.(m.clientX, m.clientY);
    if (hit) return hit;
  }
  return root.activeElement ?? root;
}

/** Deliver an event that came from inside the overlay to the overlay's listeners only. */
function routeIntoOverlay(e: Event, root: ShadowRoot, win: Window): void {
  const target = innerTarget(e, root);
  const chain: EventTarget[] = [];
  for (let n: Node | null = target as Node; n; n = n.parentNode) {
    chain.push(n);
    if (n === root) break;
  }
  const path = [...chain, root.host, win];
  const state = { stopped: false, immediate: false, target, current: null as EventTarget | null };
  const ev = view(e, state, path);
  const type = e.type;
  const winList = windowRegs.get(win)?.get(type);
  // capture: window, then the root down to the target
  runList(winList, true, ev, state, win);
  for (let i = chain.length - 1; i >= 0 && !state.stopped; i -= 1) {
    const node = chain[i] as EventTarget;
    const list = elementRegs.get(node)?.get(type);
    // at the target, capture listeners run before bubble ones
    runList(list, true, ev, state, node);
  }
  // bubble: the target up to the root, then window
  for (let i = 0; i < chain.length && !state.stopped; i += 1) {
    const node = chain[i] as EventTarget;
    runList(elementRegs.get(node)?.get(type), false, ev, state, node);
  }
  if (!state.stopped) runList(winList, false, ev, state, win);
}

/**
 * The event comes from inside the overlay: seen from `window` its target is the
 * host (the browser retargets across the shadow boundary); a DOM without
 * retargeting shows the inner node itself, whose root is ours.
 */
function fromOverlay(target: EventTarget | null, m: { host: Element; root: ShadowRoot }): boolean {
  if (target === m.host) return true;
  const node = target as Node | null;
  return typeof node?.getRootNode === "function" && node.getRootNode() === m.root;
}

/**
 * Install the isolation on `win` (at `document_start`, before any page script).
 * `current` returns the mounted host and its root once the overlay exists.
 *
 * The decision is by FOCUS, not by target: a page can move the host inside a
 * shadow tree of its own, after which events at `window` are retargeted to the
 * page's outer host and a target test fails open. So whenever focus is inside
 * the root this script created (`activeElement` non-null), every routed event
 * reaching `window` is intercepted, whatever its target appears to be; the
 * target test stays as a second condition (a drop, a pointer-initiated paste).
 * A drop, and a clipboard event that did not come from the keyboard (a
 * context-menu paste, a file dragged onto the page's own uploader), is
 * intercepted ONLY when its own target is the overlay (3b-C3): it may be aimed
 * at the page while an overlay editor keeps focus.
 * Before routing, the host must still be where it was mounted (`inPlace`);
 * if it is not, the event is stopped, not routed, and `misplaced` takes the
 * private UI down and mounts a fresh host.
 */
export function installTypingIsolation(
  win: Window,
  current: () => { host: Element; root: ShadowRoot } | null,
  guard: { inPlace(m: { host: Element; root: ShadowRoot }): boolean; misplaced(): void } = {
    inPlace: () => true,
    misplaced: () => {},
  },
): void {
  // A clipboard chord typed into the overlay: the paste, cut or copy it
  // produces in the same task came from the keyboard.
  let keyboardClipboard = false;
  for (const type of ROUTED_TYPES) {
    win.addEventListener(
      type,
      (e) => {
        const mounted = current();
        if (!mounted) return;
        const focused = mounted.root.activeElement !== null;
        const targeted = fromOverlay(e.target, mounted);
        const clipboard = type === "paste" || type === "cut" || type === "copy";
        const byTarget = type === "drop" || (clipboard && !keyboardClipboard);
        if (byTarget ? !targeted : !focused && !targeted) return;
        if (type === "keydown" && isClipboardChord(e as KeyboardEvent)) {
          keyboardClipboard = true;
          setTimeout(() => {
            keyboardClipboard = false;
          }, 0);
        }
        e.stopImmediatePropagation();
        if (!guard.inPlace(mounted)) {
          guard.misplaced();
          return;
        }
        routeIntoOverlay(e, mounted.root, win);
      },
      { capture: true },
    );
  }
}

/** Ctrl/Cmd+V, C, X and the Insert/Delete variants: keys that make a clipboard event. */
function isClipboardChord(e: KeyboardEvent): boolean {
  const k = (e.key ?? "").toLowerCase();
  if ((e.ctrlKey || e.metaKey) && (k === "v" || k === "c" || k === "x" || k === "insert"))
    return true;
  return e.shiftKey && (k === "insert" || k === "delete");
}
