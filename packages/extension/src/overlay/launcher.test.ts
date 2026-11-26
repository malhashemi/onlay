/// <reference types="chrome" />
// The launcher (ADR-0019 §1): pure drag logic (movement threshold, viewport
// clamping, commit-on-release), position persistence through prefs.launcherPos
// (round-trip, reset, offscreen recovery), and the orb's click-vs-drag split —
// a sub-threshold press opens the command bar, a real drag only moves.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Window } from "happy-dom";
import { PREFS_KEY } from "../prefs";
import {
  type AppliedPos,
  clampPos,
  createDragController,
  createLauncherOrb,
  createLauncherPosition,
  createPrefsPosStore,
  type LauncherPos,
  type PosStore,
} from "./launcher";

/* ── geometry ── */

describe("clampPos", () => {
  test("keeps the orb fully inside the viewport with a margin", () => {
    expect(clampPos(-50, -50, 46, 46, 1280, 800)).toEqual({ x: 8, y: 8 });
    expect(clampPos(5000, 5000, 46, 46, 1280, 800)).toEqual({ x: 1226, y: 746 });
    expect(clampPos(300, 200, 46, 46, 1280, 800)).toEqual({ x: 300, y: 200 });
  });

  test("a viewport smaller than the orb pins to the margin", () => {
    expect(clampPos(40, 40, 500, 500, 300, 200)).toEqual({ x: 8, y: 8 });
  });
});

/* ── drag controller ── */

function dragRig() {
  const applied: LauncherPos[] = [];
  const committed: LauncherPos[] = [];
  const dragChanges: boolean[] = [];
  const d = createDragController({
    rect: () => ({ left: 100, top: 50, width: 46, height: 46 }),
    viewport: () => ({ w: 1280, h: 800 }),
    apply: (p) => applied.push(p),
    commit: (p) => committed.push(p),
    onDragChange: (on) => dragChanges.push(on),
  });
  return { d, applied, committed, dragChanges };
}

describe("launcher drag", () => {
  test("movement under the ~4px threshold never moves or commits (a click stays a click)", () => {
    const { d, applied, committed, dragChanges } = dragRig();
    d.down(200, 60);
    d.move(202, 62); // hypot ≈ 2.8 — under
    d.up();
    expect(applied).toEqual([]);
    expect(committed).toEqual([]);
    expect(dragChanges).toEqual([]);
  });

  test("beyond the threshold the orb follows the pointer and commits once on release", () => {
    const { d, applied, committed, dragChanges } = dragRig();
    d.down(200, 60);
    d.move(230, 100); // +30,+40 from origin (100,50)
    expect(applied).toEqual([{ x: 130, y: 90 }]);
    d.move(260, 160);
    d.up();
    expect(applied.at(-1)).toEqual({ x: 160, y: 150 });
    expect(committed).toEqual([{ x: 160, y: 150 }]);
    expect(dragChanges).toEqual([true, false]);
  });

  test("live positions clamp to the viewport", () => {
    const { d, applied } = dragRig();
    d.down(200, 60);
    d.move(-2000, -2000);
    expect(applied.at(-1)).toEqual({ x: 8, y: 8 });
    d.move(5000, 5000);
    expect(applied.at(-1)).toEqual({ x: 1280 - 46 - 8, y: 800 - 46 - 8 });
  });

  test("move/up without a down are ignored", () => {
    const { d, applied, committed } = dragRig();
    d.move(500, 500);
    d.up();
    expect(applied).toEqual([]);
    expect(committed).toEqual([]);
  });
});

/* ── persistence: prefs.launcherPos ── */

const savedChrome = Object.getOwnPropertyDescriptor(globalThis, "chrome");
let data: Record<string, unknown> = {};

function installChrome(initial: Record<string, unknown> = {}): void {
  data = { ...initial };
  (globalThis as Record<string, unknown>).chrome = {
    storage: {
      local: {
        get: (keys: string | string[]) => {
          const want = Array.isArray(keys) ? keys : [keys];
          const out: Record<string, unknown> = {};
          for (const k of want) if (k in data) out[k] = data[k];
          return Promise.resolve(out);
        },
        set: (items: Record<string, unknown>) => {
          Object.assign(data, items);
          return Promise.resolve();
        },
        remove: (key: string) => {
          delete data[key];
          return Promise.resolve();
        },
      },
      onChanged: { addListener: () => {}, removeListener: () => {} },
    },
  };
}

function restoreChrome(): void {
  if (savedChrome) Object.defineProperty(globalThis, "chrome", savedChrome);
  else delete (globalThis as Record<string, unknown>).chrome;
}

const flush = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

describe("prefs-backed position store", () => {
  afterEach(restoreChrome);

  test("round-trips prefs.launcherPos; save(null) clears the field", async () => {
    installChrome();
    const store = createPrefsPosStore();
    expect(await store.load()).toBeNull();
    store.save({ x: 42, y: 17 });
    await flush();
    expect((data[PREFS_KEY] as { launcherPos?: unknown }).launcherPos).toEqual({ x: 42, y: 17 });
    expect(await store.load()).toEqual({ x: 42, y: 17 });
    store.save(null);
    await flush();
    expect((data[PREFS_KEY] as { launcherPos?: unknown }).launcherPos).toBeUndefined();
    expect(await store.load()).toBeNull();
  });

  test("a legacy islandPos folds in once through getPrefs", async () => {
    installChrome({ islandPos: { x: 9, y: 12 } });
    const store = createPrefsPosStore();
    expect(await store.load()).toEqual({ x: 9, y: 12 });
  });

  test("a broken storage area fails soft", async () => {
    (globalThis as Record<string, unknown>).chrome = {
      storage: {
        local: {
          get: () => Promise.reject(new Error("gone")),
          set: () => Promise.reject(new Error("gone")),
          remove: () => Promise.reject(new Error("gone")),
        },
      },
    };
    const store = createPrefsPosStore();
    expect(await store.load()).toBeNull();
    store.save({ x: 1, y: 2 }); // must not throw
    store.save(null);
    await flush();
  });
});

/* ── position controller ── */

function stubStore(): PosStore & { pos: LauncherPos | null } {
  const s = {
    pos: null as LauncherPos | null,
    load: () => Promise.resolve(s.pos),
    save: (p: LauncherPos | null) => {
      s.pos = p;
    },
  };
  return s;
}

function positionRig(viewport = { w: 1280, h: 800 }) {
  const store = stubStore();
  const setCalls: AppliedPos[] = [];
  const pos = createLauncherPosition({
    store,
    rect: () => ({ width: 46, height: 46 }),
    viewport: () => viewport,
    setPos: (p) => setCalls.push(p),
  });
  return { store, setCalls, pos, viewport };
}

describe("launcher position controller", () => {
  test("commit persists, clamps, and anchors to the nearer edge", async () => {
    const { store, setCalls, pos } = positionRig();
    // left half → left-anchored
    pos.commit({ x: 100, y: 40 });
    expect(setCalls.at(-1)).toEqual({ top: 40, left: 100, right: null });
    // right half → right-anchored (hugs the right edge across resizes)
    pos.commit({ x: 1100, y: 40 });
    expect(setCalls.at(-1)).toEqual({ top: 40, left: null, right: 1280 - 1100 - 46 });
    expect(store.pos).toEqual({ x: 1100, y: 40 });
    // a fresh controller restores the same spot
    const second = createLauncherPosition({
      store,
      rect: () => ({ width: 46, height: 46 }),
      viewport: () => ({ w: 1280, h: 800 }),
      setPos: (p) => setCalls.push(p),
    });
    await second.restore();
    expect(setCalls.at(-1)).toEqual({ top: 40, left: null, right: 134 });
  });

  test("restore with nothing stored applies nothing (default corner)", async () => {
    const { setCalls, pos } = positionRig();
    await pos.restore();
    expect(setCalls).toEqual([]);
    expect(pos.current()).toBeNull();
  });

  test("double-click reset clears storage and returns to the default corner", () => {
    const { store, setCalls, pos } = positionRig();
    pos.commit({ x: 500, y: 300 });
    pos.reset();
    expect(setCalls.at(-1)).toBeNull();
    expect(store.pos).toBeNull();
    expect(pos.current()).toBeNull();
  });

  test("reclamp pulls an off-screen position back in after a resize", () => {
    const rig = positionRig({ w: 1280, h: 800 });
    rig.pos.commit({ x: 1100, y: 700 });
    rig.viewport.w = 600;
    rig.viewport.h = 400;
    rig.pos.reclamp();
    expect(rig.setCalls.at(-1)).toEqual({ top: 400 - 46 - 8, left: null, right: 8 });
    // reclamp with no stored position is a no-op
    rig.pos.reset();
    const n = rig.setCalls.length;
    rig.pos.reclamp();
    expect(rig.setCalls.length).toBe(n);
  });
});

/* ── the orb: click-vs-drag, badge, connection ── */

let win: Window | null = null;
const savedGlobals: Record<string, PropertyDescriptor | undefined> = {};
const DOM_GLOBALS = ["window", "document", "Element", "HTMLElement", "Node", "Event"] as const;

beforeEach(() => {
  win = new Window({ url: "http://127.0.0.1:8124/page.html" });
  const g = globalThis as unknown as Record<string, unknown>;
  for (const k of DOM_GLOBALS) savedGlobals[k] = Object.getOwnPropertyDescriptor(globalThis, k);
  g.window = win;
  g.document = win.document;
  g.Element = win.Element;
  g.HTMLElement = win.HTMLElement;
  g.Node = win.Node;
  g.Event = win.Event;
});

afterEach(() => {
  win?.happyDOM.cancelAsync();
  win?.close();
  win = null;
  const g = globalThis as unknown as Record<string, unknown>;
  for (const k of DOM_GLOBALS) {
    const desc = savedGlobals[k];
    if (desc) Object.defineProperty(globalThis, k, desc);
    else delete g[k];
  }
});

function currentWindow(): Window {
  if (!win) throw new Error("test window not initialized");
  return win;
}

function orbRig() {
  let opened = 0;
  const store = stubStore();
  const orb = createLauncherOrb({ onOpen: () => opened++, store });
  document.body.appendChild(orb.element);
  return { orb, store, opened: () => opened };
}

function fire(el: HTMLElement, type: string, x: number, y: number, trusted = true): void {
  const w = currentWindow();
  const e = new w.MouseEvent(type, {
    bubbles: true,
    cancelable: true,
    clientX: x,
    clientY: y,
  }) as unknown as Event;
  if (trusted) Object.defineProperty(e, "isTrusted", { value: true, configurable: true });
  Object.defineProperty(e, "button", { value: 0, configurable: true });
  el.dispatchEvent(e);
}

describe("launcher orb", () => {
  test("a sub-threshold press is a click — the command bar opens once", () => {
    const rig = orbRig();
    const btn = rig.orb.element;
    fire(btn, "pointerdown", 10, 10);
    fire(btn, "pointermove", 12, 11);
    fire(btn, "pointerup", 12, 11);
    fire(btn, "click", 12, 11);
    expect(rig.opened()).toBe(1);
    expect(rig.store.pos).toBeNull(); // nothing persisted for a mere click
  });

  test("a drag beyond the threshold moves + persists and swallows the click", () => {
    const rig = orbRig();
    const btn = rig.orb.element;
    fire(btn, "pointerdown", 10, 10);
    fire(btn, "pointermove", 80, 90);
    fire(btn, "pointerup", 80, 90);
    fire(btn, "click", 80, 90);
    expect(rig.opened()).toBe(0);
    expect(rig.store.pos).not.toBeNull(); // committed through the store
  });

  test("synthetic (untrusted) clicks never open; untrusted pointerdown never drags", () => {
    const rig = orbRig();
    const btn = rig.orb.element;
    fire(btn, "click", 10, 10, false);
    expect(rig.opened()).toBe(0);
    fire(btn, "pointerdown", 10, 10, false);
    fire(btn, "pointermove", 90, 90, false);
    fire(btn, "pointerup", 90, 90, false);
    expect(rig.store.pos).toBeNull();
  });

  test("badge shows the needs-you count, capped, and hides at zero", () => {
    const rig = orbRig();
    const badge = rig.orb.element.querySelector(".orb-badge") as HTMLElement;
    rig.orb.setBadge(3);
    expect(badge.textContent).toBe("3");
    expect(badge.style.display).toBe("inline-block");
    rig.orb.setBadge(120);
    expect(badge.textContent).toBe("99+");
    rig.orb.setBadge(0);
    expect(badge.style.display).toBe("none");
  });

  test("connection states map onto the status dot", () => {
    const rig = orbRig();
    const dot = rig.orb.element.querySelector(".orb-status") as HTMLElement;
    rig.orb.setConnection("connected");
    expect(dot.className).toBe("orb-status connected");
    rig.orb.setConnection("reconnecting");
    expect(dot.className).toBe("orb-status reconnecting");
    rig.orb.setConnection("offline");
    expect(dot.className).toBe("orb-status offline");
  });
});
