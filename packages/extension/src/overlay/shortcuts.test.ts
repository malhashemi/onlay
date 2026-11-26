// Chord dispatcher (F-031, rebound to CommandIds by ADR-0019): two-key chords
// fire on the second key; a single-key binding that shares a prefix with a
// chord fires only when the window lapses; guards (modifiers, editable
// targets via isBlocked) reset; the Ctrl+. accelerator has its own path and
// guard.
import { beforeEach, describe, expect, test } from "bun:test";
import { createChordDispatcher } from "./shortcuts";

const WINDOW_MS = 20;

interface FakeKeyEvent {
  isTrusted: boolean;
  key: string;
  metaKey: boolean;
  ctrlKey: boolean;
  altKey: boolean;
  shiftKey: boolean;
  repeat: boolean;
  defaultPrevented: boolean;
  propagationStopped: boolean;
  preventDefault(): void;
  stopImmediatePropagation(): void;
}

function key(k: string, over: Partial<FakeKeyEvent> = {}): FakeKeyEvent {
  const e: FakeKeyEvent = {
    isTrusted: true,
    key: k,
    metaKey: false,
    ctrlKey: false,
    altKey: false,
    shiftKey: false,
    repeat: false,
    defaultPrevented: false,
    propagationStopped: false,
    preventDefault() {
      e.defaultPrevented = true;
    },
    stopImmediatePropagation() {
      e.propagationStopped = true;
    },
    ...over,
  };
  return e;
}

// CommandId → chord, as content.ts binds from prefs.keyboard (ADR-0019 §3).
// `askBlock` is deliberately a single key and `queue` a `g`-chord here to
// exercise the prefix/lapse machinery beyond the shipped defaults.
const BINDINGS = {
  commentPage: "ca",
  commentBlock: "cc",
  askBlock: "a",
  editPage: "ea",
  editBlock: "ee",
  queue: "ga",
};

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

let fired: string[] = [];
let blocked = false;

function dispatcher() {
  fired = [];
  blocked = false;
  const d = createChordDispatcher({
    fire: (a) => fired.push(a),
    isBlocked: () => blocked,
    windowMs: WINDOW_MS,
  });
  d.setBindings(BINDINGS);
  return d;
}

const press = (d: ReturnType<typeof dispatcher>, k: FakeKeyEvent) =>
  d.handleKeydown(k as unknown as KeyboardEvent);

beforeEach(() => {
  fired = [];
});

describe("chord dispatcher", () => {
  test("keys the page synthesized never fire a chord or the accelerator", () => {
    const fired: string[] = [];
    let accel = 0;
    const d = createChordDispatcher({
      fire: (a) => fired.push(a),
      isBlocked: () => false,
      onAccel: () => {
        accel += 1;
      },
    });
    d.setBindings({ commandBar: "k", pickComment: "cc" });
    d.setAccel("ctrl+.");
    const fake = (k: string, over: Partial<FakeKeyEvent> = {}) =>
      key(k, { isTrusted: false, ...over }) as unknown as KeyboardEvent;
    d.handleKeydown(fake("k"));
    d.handleKeydown(fake("c"));
    d.handleKeydown(fake("c"));
    d.handleKeydown(fake(".", { ctrlKey: true }));
    expect(fired).toEqual([]);
    expect(accel).toBe(0);
  });

  test("a two-key chord fires immediately on its second key", () => {
    const d = dispatcher();
    press(d, key("c"));
    expect(fired).toEqual([]);
    const second = key("a");
    press(d, second);
    expect(fired).toEqual(["commentPage"]);
    expect(second.defaultPrevented).toBe(true); // consumed
  });

  test("arming a chord prefix consumes the key so the page never sees it", () => {
    // `c` prefixes ca/cc — while we wait for the second key it must be swallowed
    // (else the page's own `c` shortcut fires). Fires nothing yet.
    const d = dispatcher();
    const e = key("c");
    press(d, e);
    expect(fired).toEqual([]);
    expect(e.defaultPrevented).toBe(true);
    expect(e.propagationStopped).toBe(true);
  });

  test("an unbound key that is neither a binding nor a prefix passes through untouched", () => {
    const d = dispatcher();
    const e = key("z"); // no binding, no chord starts with `z`
    press(d, e);
    expect(fired).toEqual([]);
    expect(e.defaultPrevented).toBe(false);
    expect(e.propagationStopped).toBe(false);
  });

  test("a lone single-key binding with no chord prefix fires immediately", () => {
    const d = dispatcher();
    const e = key("a"); // no chord starts with `a`
    press(d, e);
    expect(fired).toEqual(["askBlock"]);
    expect(e.defaultPrevented).toBe(true);
  });

  test("a single that IS a chord prefix fires on window lapse", async () => {
    const d = dispatcher();
    d.setBindings({ ...BINDINGS, askBlock: "e" }); // `e` prefixes ea/ee AND binds alone
    press(d, key("e"));
    expect(fired).toEqual([]);
    await sleep(WINDOW_MS * 3);
    expect(fired).toEqual(["askBlock"]);
  });

  test("an armed prefix followed by an unbound key discards, then re-evaluates the key", () => {
    const d = dispatcher();
    press(d, key("c"));
    press(d, key("a")); // completes ca — sanity
    expect(fired).toEqual(["commentPage"]);
    press(d, key("g")); // arm ga
    press(d, key("x")); // no gx chord, no x binding → nothing
    expect(fired).toEqual(["commentPage"]);
    press(d, key("g")); // fresh chord still works after the miss
    press(d, key("a"));
    expect(fired).toEqual(["commentPage", "queue"]);
  });

  test("a lapsed prefix with no single binding fires nothing", async () => {
    const d = dispatcher();
    press(d, key("g")); // ga exists; `g` alone binds nothing
    await sleep(WINDOW_MS * 3);
    expect(fired).toEqual([]);
  });

  test("modifier keys reset and never fire", () => {
    const d = dispatcher();
    press(d, key("c"));
    press(d, key("a", { ctrlKey: true })); // ctrl+a mid-chord → reset
    expect(fired).toEqual([]);
    press(d, key("a", { metaKey: true }));
    press(d, key("a", { shiftKey: true }));
    expect(fired).toEqual([]);
  });

  test("blocked contexts (editable target, open panel) reset the chord", () => {
    const d = dispatcher();
    press(d, key("c"));
    blocked = true;
    press(d, key("a")); // typing into a composer — never a chord
    expect(fired).toEqual([]);
    blocked = false;
    const e = key("a");
    press(d, e);
    expect(fired).toEqual(["askBlock"]); // chord state was dropped, not resumed
  });

  test("non-character keys reset a pending chord", () => {
    const d = dispatcher();
    press(d, key("c"));
    press(d, key("Escape"));
    press(d, key("a"));
    expect(fired).toEqual(["askBlock"]); // `ca` did NOT complete
  });

  test("key repeat never fires twice", () => {
    const d = dispatcher();
    press(d, key("a"));
    press(d, key("a", { repeat: true }));
    expect(fired).toEqual(["askBlock"]);
  });

  test("setBindings replaces the map and validates chords", () => {
    const d = dispatcher();
    d.setBindings({ queue: "q", broken: "way-too-long" });
    press(d, key("q"));
    expect(fired).toEqual(["queue"]);
    press(d, key("a")); // old bindings gone
    expect(fired).toEqual(["queue"]);
  });
});

// ── the modifier accelerator (Ctrl+., ADR-0019 §3) ──

function accelDispatcher(opts: { accelBlocked?: () => boolean } = {}) {
  fired = [];
  blocked = false;
  let toggles = 0;
  const accelBlocked = opts.accelBlocked;
  const d = createChordDispatcher({
    fire: (a) => fired.push(a),
    isBlocked: () => blocked,
    ...(accelBlocked ? { isAccelBlocked: () => accelBlocked() } : {}),
    onAccel: () => toggles++,
    windowMs: WINDOW_MS,
  });
  d.setBindings(BINDINGS);
  d.setAccel("ctrl+.");
  return { d, toggles: () => toggles };
}

describe("ctrl+. accelerator", () => {
  test("ctrl+. fires the accelerator and consumes the key", () => {
    const { d, toggles } = accelDispatcher();
    const e = key(".", { ctrlKey: true });
    press(d, e);
    expect(toggles()).toBe(1);
    expect(fired).toEqual([]); // never a chord
    expect(e.defaultPrevented).toBe(true);
    expect(e.propagationStopped).toBe(true);
  });

  test("extra modifiers (meta/shift/alt) never fire it", () => {
    const { d, toggles } = accelDispatcher();
    press(d, key(".", { ctrlKey: true, metaKey: true }));
    press(d, key(".", { ctrlKey: true, shiftKey: true }));
    press(d, key(".", { ctrlKey: true, altKey: true }));
    press(d, key(".", { metaKey: true })); // meta alone is not ctrl
    press(d, key(".")); // a bare `.` is just a key
    expect(toggles()).toBe(0);
  });

  test("the accelerator guard blocks it in editable contexts", () => {
    let editable = true;
    const { d, toggles } = accelDispatcher({ accelBlocked: () => editable });
    const e = key(".", { ctrlKey: true });
    press(d, e);
    expect(toggles()).toBe(0);
    expect(e.defaultPrevented).toBe(false); // the page keeps its key
    editable = false;
    press(d, key(".", { ctrlKey: true }));
    expect(toggles()).toBe(1);
  });

  test("without its own guard the accelerator obeys isBlocked", () => {
    const { d, toggles } = accelDispatcher();
    blocked = true;
    press(d, key(".", { ctrlKey: true }));
    expect(toggles()).toBe(0);
    blocked = false;
    press(d, key(".", { ctrlKey: true }));
    expect(toggles()).toBe(1);
  });

  test("ctrl+. mid-chord resets the pending prefix", async () => {
    const { d, toggles } = accelDispatcher();
    press(d, key("c")); // arm ca/cc
    press(d, key(".", { ctrlKey: true }));
    expect(toggles()).toBe(1);
    press(d, key("a")); // NOT `ca` — the chord state was dropped
    expect(fired).toEqual(["askBlock"]);
    await sleep(WINDOW_MS * 2);
  });

  test("setAccel follows prefs remaps and rejects garbage", () => {
    const { d, toggles } = accelDispatcher();
    d.setAccel("ctrl+k");
    press(d, key(".", { ctrlKey: true }));
    expect(toggles()).toBe(0);
    press(d, key("K", { ctrlKey: true })); // case-insensitive key match
    expect(toggles()).toBe(1);
    d.setAccel("not-a-binding");
    press(d, key("k", { ctrlKey: true }));
    expect(toggles()).toBe(1);
    d.setAccel(null);
    press(d, key("k", { ctrlKey: true }));
    expect(toggles()).toBe(1);
  });
});
