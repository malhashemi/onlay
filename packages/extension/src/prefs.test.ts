// The prefs module (ADR-0019 §4): defaults merge, one-time legacy fold,
// patch round-trips, the onChanged relay, and the shortcut validation matrix.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  COMMAND_IDS,
  type CommandId,
  foldPrefs,
  getPrefs,
  KEYBOARD_DEFAULTS,
  onPrefsChanged,
  type Prefs,
  patchPrefs,
  UI_ZOOM_DEFAULT,
  UI_ZOOM_MAX,
  UI_ZOOM_MIN,
  validateKeyboard,
} from "./prefs";

type StorageChange = { oldValue?: unknown; newValue?: unknown };
type Listener = (changes: Record<string, StorageChange>, area: string) => void;

// In-memory chrome.storage.local + onChanged (same restore discipline as
// content.test.ts — bun runs every test file in one process).
let data: Record<string, unknown> = {};
let listeners = new Set<Listener>();
let localSet: (items: Record<string, unknown>) => Promise<void>;
const savedChrome = Object.getOwnPropertyDescriptor(globalThis, "chrome");

function installChrome(initial: Record<string, unknown> = {}): void {
  data = { ...initial };
  listeners = new Set();
  localSet = (items) => {
    const changes: Record<string, StorageChange> = {};
    for (const [k, v] of Object.entries(items)) {
      changes[k] = { oldValue: data[k], newValue: v };
      data[k] = v;
    }
    for (const l of listeners) l(changes, "local");
    return Promise.resolve();
  };
  (globalThis as Record<string, unknown>).chrome = {
    storage: {
      local: {
        get: (keys: string | string[]) => {
          const want = Array.isArray(keys) ? keys : [keys];
          const out: Record<string, unknown> = {};
          for (const k of want) if (k in data) out[k] = data[k];
          return Promise.resolve(out);
        },
        set: (items: Record<string, unknown>) => localSet(items),
        remove: (key: string) => {
          delete data[key];
          return Promise.resolve();
        },
      },
      onChanged: {
        addListener: (l: Listener) => listeners.add(l),
        removeListener: (l: Listener) => listeners.delete(l),
      },
    },
  };
}

beforeEach(() => installChrome());
afterEach(() => {
  if (savedChrome) Object.defineProperty(globalThis, "chrome", savedChrome);
  else delete (globalThis as Record<string, unknown>).chrome;
});

// ── pure: defaults merge + legacy fold ──

describe("foldPrefs", () => {
  test("v1→v2: a custom queue chord follows the Inbox rename; the old default upgrades", () => {
    const custom = foldPrefs({ keyboard: { queue: "zz" } });
    expect(custom.keyboard.inbox).toBe("zz");
    const wasDefault = foldPrefs({ keyboard: { queue: "qq" } });
    expect(wasDefault.keyboard.inbox).toBe("ii");
    const explicit = foldPrefs({ keyboard: { queue: "zz", inbox: "yy" } });
    expect(explicit.keyboard.inbox).toBe("yy");
  });

  test("empty storage → full defaults, no optional shapes", () => {
    const p = foldPrefs(undefined);
    expect(p.v).toBe(2);
    expect(p.keyboard).toEqual(KEYBOARD_DEFAULTS);
    expect(p.uiZoom).toBe(UI_ZOOM_DEFAULT);
    expect(p.launcherPos).toBeUndefined();
    expect(p.threadPanelSize).toBeUndefined();
  });

  test("uiZoom: honored clamped to bounds; junk falls to the default", () => {
    expect(foldPrefs({ uiZoom: 1.25 }).uiZoom).toBe(1.25);
    expect(foldPrefs({ uiZoom: 0.1 }).uiZoom).toBe(UI_ZOOM_MIN);
    expect(foldPrefs({ uiZoom: 99 }).uiZoom).toBe(UI_ZOOM_MAX);
    expect(foldPrefs({ uiZoom: Number.NaN }).uiZoom).toBe(UI_ZOOM_DEFAULT);
    expect(foldPrefs({ uiZoom: "big" }).uiZoom).toBe(UI_ZOOM_DEFAULT);
  });

  test("theme: light/dark/system pass; junk falls to system", () => {
    expect(foldPrefs({ theme: "light" }).theme).toBe("light");
    expect(foldPrefs({ theme: "dark" }).theme).toBe("dark");
    expect(foldPrefs({ theme: "system" }).theme).toBe("system");
    expect(foldPrefs({ theme: "sepia" }).theme).toBe("system");
    expect(foldPrefs({}).theme).toBe("system");
  });

  test("stored keyboard merges over defaults; non-strings and empties fall back", () => {
    const p = foldPrefs({ keyboard: { inbox: "zz", copyBlock: 7, switchSpace: "" } });
    expect(p.keyboard.inbox).toBe("zz");
    expect(p.keyboard.copyBlock).toBe(KEYBOARD_DEFAULTS.copyBlock);
    expect(p.keyboard.switchSpace).toBe(KEYBOARD_DEFAULTS.switchSpace);
    expect(p.keyboard.editBlock).toBe("ee");
  });

  test("stored chords for the removed Ask commands are dropped, never bound", () => {
    const p = foldPrefs({ v: 2, keyboard: { askBlock: "aa", askPage: "zx", inbox: "ii" } });
    expect(Object.keys(p.keyboard).sort()).toEqual([...COMMAND_IDS].sort());
    expect(p.keyboard).not.toHaveProperty("askBlock");
    expect(p.keyboard).not.toHaveProperty("askPage");
    expect(Object.values(p.keyboard)).not.toContain("zx");
    // the folded map validates: no leftover id can collide or fail the save
    expect(validateKeyboard(p.keyboard).ok).toBe(true);
  });

  test("legacy islandPos/threadPanelSize fold into the schema", () => {
    const p = foldPrefs(undefined, {
      islandPos: { x: 12, y: 34 },
      threadPanelSize: { w: 420, h: 380 },
    });
    expect(p.launcherPos).toEqual({ x: 12, y: 34 });
    expect(p.threadPanelSize).toEqual({ w: 420, h: 380 });
  });

  test("stored prefs beat legacy; malformed legacy is dropped", () => {
    const p = foldPrefs(
      { launcherPos: { x: 1, y: 2 } },
      { islandPos: { x: 9, y: 9 }, threadPanelSize: { w: "wide", h: 300 } },
    );
    expect(p.launcherPos).toEqual({ x: 1, y: 2 });
    expect(p.threadPanelSize).toBeUndefined();
    expect(
      foldPrefs(undefined, { islandPos: { x: Number.NaN, y: 3 } }).launcherPos,
    ).toBeUndefined();
  });
});

// ── storage: migration, patch, relay ──

describe("getPrefs", () => {
  test("first read folds legacy keys ONCE, materializes prefs, leaves old keys", async () => {
    installChrome({ islandPos: { x: 5, y: 7 }, threadPanelSize: { w: 400, h: 300 } });
    const p = await getPrefs();
    expect(p.launcherPos).toEqual({ x: 5, y: 7 });
    expect(p.threadPanelSize).toEqual({ w: 400, h: 300 });
    expect(data.prefs).toEqual(p); // materialized
    expect(data.islandPos).toEqual({ x: 5, y: 7 }); // old keys stay for their consumers

    // Later legacy writes never leak back in — the fold is one-time.
    data.islandPos = { x: 99, y: 99 };
    expect((await getPrefs()).launcherPos).toEqual({ x: 5, y: 7 });
  });

  test("no legacy state → plain defaults", async () => {
    const p = await getPrefs();
    expect(p).toEqual({
      v: 2,
      keyboard: { ...KEYBOARD_DEFAULTS },
      uiZoom: UI_ZOOM_DEFAULT,
      theme: "system",
    });
  });
});

describe("patchPrefs", () => {
  test("shallow top-level patch round-trips and preserves other fields", async () => {
    await patchPrefs({ keyboard: { ...KEYBOARD_DEFAULTS, inbox: "zz" } });
    await patchPrefs({ launcherPos: { x: 3, y: 4 } });
    const p = await getPrefs();
    expect(p.keyboard.inbox).toBe("zz");
    expect(p.launcherPos).toEqual({ x: 3, y: 4 });
  });

  test("keyboard is replaced WHOLE — missing ids backfill from defaults, not the old map", async () => {
    await patchPrefs({ keyboard: { ...KEYBOARD_DEFAULTS, inbox: "zz" } });
    await patchPrefs({
      keyboard: { copyBlock: "xy" } as unknown as Record<CommandId, string>,
    });
    const p = await getPrefs();
    expect(p.keyboard.copyBlock).toBe("xy");
    expect(p.keyboard.inbox).toBe(KEYBOARD_DEFAULTS.inbox); // "ii", not "zz"
  });

  test("explicit undefined clears an optional field", async () => {
    await patchPrefs({ launcherPos: { x: 3, y: 4 } });
    await patchPrefs({ launcherPos: undefined });
    expect((await getPrefs()).launcherPos).toBeUndefined();
  });
});

describe("onPrefsChanged", () => {
  test("relays merged prefs on writes; unsubscribe stops the relay", async () => {
    const seen: Prefs[] = [];
    const off = onPrefsChanged((p) => seen.push(p));
    await patchPrefs({ keyboard: { ...KEYBOARD_DEFAULTS, inbox: "zz" } });
    expect(seen.length).toBeGreaterThanOrEqual(1);
    expect(seen[seen.length - 1]?.keyboard.inbox).toBe("zz");

    const count = seen.length;
    // Other keys never trigger the relay.
    await localSet({ islandPos: { x: 1, y: 1 } });
    expect(seen.length).toBe(count);

    off();
    await patchPrefs({ keyboard: { ...KEYBOARD_DEFAULTS } });
    expect(seen.length).toBe(count);
  });
});

// ── validation matrix ──

describe("validateKeyboard", () => {
  test("the shipped defaults validate clean — no issues at all", () => {
    const r = validateKeyboard(KEYBOARD_DEFAULTS);
    expect(r.ok).toBe(true);
    expect(r.issues).toEqual([]);
  });

  test("duplicates flag every member of the group and fail", () => {
    const r = validateKeyboard({ ...KEYBOARD_DEFAULTS, switchSpace: "cc" }); // collides with commentBlock
    expect(r.ok).toBe(false);
    const dupes = r.issues.filter((i) => i.kind === "duplicate").map((i) => i.id);
    expect(dupes.sort()).toEqual(["commentBlock", "switchSpace"]);
  });

  test("empty and missing values are required-field failures", () => {
    const map: Record<string, string> = { ...KEYBOARD_DEFAULTS, inbox: "  " };
    delete map.settings;
    const r = validateKeyboard(map);
    expect(r.ok).toBe(false);
    const empty = r.issues.filter((i) => i.kind === "empty").map((i) => i.id);
    expect(empty.sort()).toEqual(["inbox", "settings"]);
  });

  test("chord format: 1–2 lowercase alphanumerics only", () => {
    for (const bad of ["abc", "C", "c-", "c c", "ctrl+c"]) {
      const r = validateKeyboard({ ...KEYBOARD_DEFAULTS, inbox: bad });
      expect(r.issues.some((i) => i.id === "inbox" && i.kind === "invalid")).toBe(true);
      expect(r.ok).toBe(false);
    }
  });

  test("vimium first keys warn but never fail", () => {
    for (const chord of ["ga", "j", "f1", "d"]) {
      const r = validateKeyboard({ ...KEYBOARD_DEFAULTS, inbox: chord });
      expect(r.ok).toBe(true);
      const warn = r.issues.find((i) => i.id === "inbox");
      expect(warn?.kind).toBe("vimium");
    }
    // second key never matters; "a" is not a vimium key
    const clean = validateKeyboard({ ...KEYBOARD_DEFAULTS, queue: "aj" });
    expect(clean.issues).toEqual([]);
  });

  test("commandBar is fixed-format ctrl+<single key>, case-insensitive", () => {
    expect(validateKeyboard({ ...KEYBOARD_DEFAULTS, commandBar: "CTRL+," }).ok).toBe(true);
    for (const bad of ["alt+.", "ctrl+", "ctrl+ab", "ctrl++", "."]) {
      const r = validateKeyboard({ ...KEYBOARD_DEFAULTS, commandBar: bad });
      expect(r.issues.some((i) => i.id === "commandBar" && i.kind === "invalid")).toBe(true);
    }
    const missing = validateKeyboard({ ...KEYBOARD_DEFAULTS, commandBar: "" });
    expect(missing.issues.some((i) => i.id === "commandBar" && i.kind === "empty")).toBe(true);
  });

  test("commandBar is excluded from chord duplicate checks and vimium advice", () => {
    // "ctrl+f" would trip the vimium set / dup logic if commandBar were a chord.
    const r = validateKeyboard({ ...KEYBOARD_DEFAULTS, commandBar: "ctrl+f" });
    expect(r.issues).toEqual([]);
  });
});

describe("keyboard defaults", () => {
  test("every command id has a default binding", () => {
    for (const id of COMMAND_IDS) expect(KEYBOARD_DEFAULTS[id]).toBeTruthy();
  });
});
