/// <reference types="chrome" />
// Client preferences (ADR-0019 §4): ONE schema-versioned object under the
// chrome.storage.local key `prefs`, owned by this module and importable from
// the content script, the service worker, and the options page. This replaces
// the server-served `~/.config/onlay/extension.json` vertical — client UI
// preferences live client-side, edited on the extension options page.
//
// Contract notes for consumers:
//   · getPrefs() is always defaults-merged — every CommandId has a chord.
//   · patchPrefs() is shallow at the top level; `keyboard` is replaced as a
//     whole map (missing ids backfill from KEYBOARD_DEFAULTS, never from the
//     previous custom map).
//   · onPrefsChanged() relays chrome.storage.onChanged for the `prefs` key
//     and returns an unsubscribe.
//   · Pairing/identity truth (token, serverUrl, actor, …) stays in the SW's
//     own storage keys — prefs never duplicates it.

export type CommandId =
  | "commandBar"
  | "copyBlock"
  | "editBlock"
  | "editPage"
  | "commentBlock"
  | "commentPage"
  | "inbox"
  | "keptEdits"
  | "copyForAgent"
  | "switchSpace"
  | "toggleTheme"
  | "settings";

/** Display order — the options page and the command bar render in this order. */
export const COMMAND_IDS: readonly CommandId[] = [
  "commandBar",
  "copyBlock",
  "editBlock",
  "editPage",
  "commentBlock",
  "commentPage",
  "inbox",
  "keptEdits",
  "copyForAgent",
  "switchSpace",
  "toggleTheme",
  "settings",
];

/**
 * ADR-0019 §3 defaults. `commandBar` is a modifier accel (`ctrl+<key>`, all
 * platforms incl. macOS); everything else is a 1–2 key chord that only fires
 * outside editable contexts.
 */
export const KEYBOARD_DEFAULTS: Record<CommandId, string> = {
  commandBar: "ctrl+.",
  copyBlock: "cs",
  editBlock: "ee",
  editPage: "ea",
  commentBlock: "cc",
  commentPage: "ca",
  inbox: "ii",
  keptEdits: "ek",
  copyForAgent: "ag",
  switchSpace: "ww",
  toggleTheme: "mm",
  settings: "ss",
};

/**
 * Single source for command copy — the options page and the command bar rows
 * both read this. Lexicon (ADR-0019 §5): user-facing copy says "Block", never
 * "element", and "Edit", never "Change".
 */
export const COMMAND_META: Record<CommandId, { label: string; description: string }> = {
  commandBar: {
    label: "Open command bar",
    description: "The one entry point — search commands, run them, and read your Inbox.",
  },
  copyBlock: {
    label: "Copy block HTML",
    description: "Copies the picked block's HTML to your clipboard — nothing is sent anywhere.",
  },
  editBlock: {
    label: "Edit block",
    description: "Pick a block and describe the edit an agent should make.",
  },
  editPage: {
    label: "Edit page",
    description: "Open the edit tray — click text to rewrite or delete, then send the batch.",
  },
  commentBlock: {
    label: "Comment on block",
    description: "Pick a block and start a comment thread anchored to it.",
  },
  commentPage: {
    label: "Comment on page",
    description: "Start a comment thread on the page as a whole.",
  },
  inbox: {
    label: "Inbox",
    description: "Everything that needs you, on this page and everywhere else.",
  },
  keptEdits: {
    label: "Kept edits",
    description: "See the edits kept on this page, and show or hide each one.",
  },
  copyForAgent: {
    label: "Copy for agent",
    description: "Copy a pointer to what's waiting for an agent on this page.",
  },
  switchSpace: {
    label: "Switch space",
    description: "Choose the space your new comments and edits go to.",
  },
  toggleTheme: {
    label: "Toggle light / dark",
    description: "Flip the overlay's look. Pick System in Settings → Appearance.",
  },
  settings: {
    label: "Settings",
    description: "Open this settings page.",
  },
};

/**
 * Overlay zoom (Appearance): the whole overlay chrome — command bar, panels,
 * pins — scales by this factor. The sheet is authored at 1×; dom.ts multiplies
 * px values at adopt time.
 */
export const UI_ZOOM_MIN = 1;
export const UI_ZOOM_MAX = 2;
export const UI_ZOOM_DEFAULT = 1.25;

/**
 * Theme (Appearance): the overlay and the extension pages follow the OS by
 * default; light/dark are explicit commits.
 */
export type Theme = "light" | "dark" | "system";
export const THEME_DEFAULT: Theme = "system";

export interface Prefs {
  v: 2;
  keyboard: Record<CommandId, string>;
  uiZoom: number;
  theme: Theme;
  launcherPos?: { x: number; y: number };
  threadPanelSize?: { w: number; h: number };
}

/** The single chrome.storage.local key this module owns. */
export const PREFS_KEY = "prefs";

// ── pure logic: defaults merge + legacy fold ──

/**
 * Pre-prefs chrome.storage.local keys (`islandPos` from overlay/island.ts,
 * `threadPanelSize` from overlay/thread.ts). getPrefs() folds them in ONCE —
 * the first time the `prefs` object materializes — and leaves the old keys in
 * place for their current consumers until those migrate onto prefs.
 */
export interface LegacyUiState {
  islandPos?: unknown;
  threadPanelSize?: unknown;
}

function point(v: unknown): { x: number; y: number } | undefined {
  const p = v as { x?: unknown; y?: unknown } | null | undefined;
  if (p && typeof p.x === "number" && Number.isFinite(p.x)) {
    if (typeof p.y === "number" && Number.isFinite(p.y)) return { x: p.x, y: p.y };
  }
  return undefined;
}

function size(v: unknown): { w: number; h: number } | undefined {
  const s = v as { w?: unknown; h?: unknown } | null | undefined;
  if (s && typeof s.w === "number" && Number.isFinite(s.w)) {
    if (typeof s.h === "number" && Number.isFinite(s.h)) return { w: s.w, h: s.h };
  }
  return undefined;
}

/** A stored zoom is honored clamped to bounds; anything else falls to default. */
function zoom(v: unknown): number {
  if (typeof v !== "number" || !Number.isFinite(v)) return UI_ZOOM_DEFAULT;
  return Math.min(UI_ZOOM_MAX, Math.max(UI_ZOOM_MIN, v));
}

function theme(v: unknown): Theme {
  return v === "light" || v === "dark" || v === "system" ? v : THEME_DEFAULT;
}

/**
 * Defaults-merge a stored (possibly partial/foreign) value into a full Prefs,
 * optionally folding legacy UI state under it. Pure — exported for tests.
 */
export function foldPrefs(stored: unknown, legacy: LegacyUiState = {}): Prefs {
  const s = (typeof stored === "object" && stored !== null ? stored : {}) as {
    keyboard?: Record<string, unknown>;
    uiZoom?: unknown;
    theme?: unknown;
    launcherPos?: unknown;
    threadPanelSize?: unknown;
  };
  const keyboard = { ...KEYBOARD_DEFAULTS };
  for (const id of COMMAND_IDS) {
    const v = s.keyboard?.[id];
    if (typeof v === "string" && v.length > 0) keyboard[id] = v;
  }
  // Commands that no longer exist (the Ask commands, hidden by spec §10) are
  // ignored: only ids in COMMAND_IDS are read, so an old stored chord for one
  // is dropped on the next write instead of binding anything.
  // v1→v2: the queue command became Inbox. A saved custom chord follows the
  // rename; the old default (qq) upgrades to the new default (ii).
  if (s.keyboard?.inbox === undefined) {
    const legacy = s.keyboard?.queue;
    if (typeof legacy === "string" && legacy.length > 0 && legacy !== "qq") {
      keyboard.inbox = legacy;
    }
  }
  const launcherPos = point(s.launcherPos) ?? point(legacy.islandPos);
  const threadPanelSize = size(s.threadPanelSize) ?? size(legacy.threadPanelSize);
  return {
    v: 2,
    keyboard,
    uiZoom: zoom(s.uiZoom),
    theme: theme(s.theme),
    ...(launcherPos ? { launcherPos } : {}),
    ...(threadPanelSize ? { threadPanelSize } : {}),
  };
}

// ── storage API ──

/**
 * Read the defaults-merged prefs. The first call ever (no `prefs` key yet)
 * folds the legacy `islandPos`/`threadPanelSize` keys in and writes the
 * materialized object; later legacy writes never leak back in.
 */
export async function getPrefs(): Promise<Prefs> {
  const got = (await chrome.storage.local.get([
    PREFS_KEY,
    "islandPos",
    "threadPanelSize",
  ])) as Record<string, unknown>;
  const stored = got[PREFS_KEY];
  if (stored === undefined) {
    const folded = foldPrefs(undefined, {
      islandPos: got.islandPos,
      threadPanelSize: got.threadPanelSize,
    });
    await chrome.storage.local.set({ [PREFS_KEY]: folded });
    return folded;
  }
  return foldPrefs(stored);
}

/**
 * A shallow top-level patch: omitted keys are untouched; an explicit
 * `undefined` clears an optional field (e.g. reset the launcher position).
 */
export type PrefsPatch = { [K in keyof Prefs]?: Prefs[K] | undefined };

/**
 * Shallow top-level patch. `keyboard`, when present, replaces the whole map
 * (missing ids backfill from KEYBOARD_DEFAULTS). The write lands as one
 * defaults-merged object, so readers never see a partial shape.
 *
 * Writes are SERIALIZED per context and re-read fresh inside the chain:
 * read-modify-write over the whole object would otherwise let concurrent
 * writers (a launcher drag, a panel resize, an options save) clobber each
 * other's top-level fields.
 */
let writeChain: Promise<void> = Promise.resolve();

export function patchPrefs(patch: PrefsPatch): Promise<void> {
  const run = async (): Promise<void> => {
    const current = await getPrefs();
    const merged: Record<string, unknown> = { ...current };
    for (const [k, v] of Object.entries(patch)) {
      if (v === undefined) delete merged[k];
      else merged[k] = v;
    }
    if (patch.keyboard) merged.keyboard = { ...patch.keyboard };
    await chrome.storage.local.set({ [PREFS_KEY]: foldPrefs(merged) });
  };
  writeChain = writeChain.then(run, run);
  return writeChain;
}

/**
 * Subscribe to prefs changes (any context — options page edits, SW writes).
 * The callback receives the defaults-merged next value. Returns unsubscribe.
 */
export function onPrefsChanged(cb: (p: Prefs) => void): () => void {
  const listener = (changes: Record<string, chrome.storage.StorageChange>, area: string): void => {
    if (area !== "local") return;
    const change = changes[PREFS_KEY];
    if (!change) return;
    cb(foldPrefs(change.newValue));
  };
  chrome.storage.onChanged.addListener(listener);
  return () => chrome.storage.onChanged.removeListener(listener);
}

/**
 * Commit an extension page (popup/options/interaction view) to prefs.theme:
 * [data-theme] on the root wins over the OS preference in tokens.css; system
 * removes the commit so the media query decides.
 */
export function applyPageTheme(t: Theme): void {
  const root = document.documentElement;
  if (t === "system") delete root.dataset.theme;
  else root.dataset.theme = t;
}

// ── validation ──

export interface KeyboardIssue {
  id: CommandId;
  kind: "duplicate" | "empty" | "invalid" | "vimium";
  message: string;
}

/** `commandBar` is fixed-format: `ctrl+` plus exactly one non-space key. */
const COMMAND_BAR_RE = /^ctrl\+[^\s+]$/i;
/** Chord grammar (unchanged from F-031): 1–2 lowercase alphanumerics. */
const CHORD_RE = /^[a-z0-9]{1,2}$/;
/**
 * Well-known Vimium first keys — a chord starting on one of these collides
 * with Vimium's own bindings for users running it. Warning, never a failure.
 */
const VIMIUM_FIRST_KEYS = new Set([
  ..."fjkhlgtobdurxp".split(""),
  ..."JKHLGF".split(""),
  "/",
  "?",
  "n",
]);

/**
 * Validate a full keyboard map (every CommandId is required). `ok` is false
 * only on hard failures (duplicate/empty/invalid); `vimium` issues are
 * advisory — callers decide how to surface them.
 */
export function validateKeyboard(map: Record<string, string>): {
  ok: boolean;
  issues: KeyboardIssue[];
} {
  const issues: KeyboardIssue[] = [];

  const bar = typeof map.commandBar === "string" ? map.commandBar.trim() : "";
  if (bar === "") {
    issues.push({ id: "commandBar", kind: "empty", message: "A shortcut is required." });
  } else if (!COMMAND_BAR_RE.test(bar)) {
    issues.push({
      id: "commandBar",
      kind: "invalid",
      message: 'Must be "ctrl+" plus a single key, e.g. "ctrl+.".',
    });
  }

  // Chord commands: format first, then case-insensitive duplicate groups
  // (commandBar is excluded from chord-duplicate checks), then Vimium advice.
  const byValue = new Map<string, CommandId[]>();
  for (const id of COMMAND_IDS) {
    if (id === "commandBar") continue;
    const raw = map[id];
    const v = typeof raw === "string" ? raw.trim() : "";
    if (v === "") {
      issues.push({ id, kind: "empty", message: "A shortcut is required." });
      continue;
    }
    if (!CHORD_RE.test(v)) {
      issues.push({
        id,
        kind: "invalid",
        message: 'Use 1–2 lowercase letters or digits, e.g. "cc".',
      });
      continue;
    }
    const key = v.toLowerCase();
    const group = byValue.get(key);
    if (group) group.push(id);
    else byValue.set(key, [id]);
  }

  for (const [value, ids] of byValue) {
    if (ids.length > 1) {
      for (const id of ids) {
        const others = ids
          .filter((o) => o !== id)
          .map((o) => COMMAND_META[o].label)
          .join(", ");
        issues.push({
          id,
          kind: "duplicate",
          message: `"${value}" is already used by ${others}.`,
        });
      }
    }
    const first = value.charAt(0);
    if (VIMIUM_FIRST_KEYS.has(first)) {
      for (const id of ids) {
        issues.push({
          id,
          kind: "vimium",
          message: `"${first}" is a common Vimium key — this chord may collide for Vimium users.`,
        });
      }
    }
  }

  const ok = issues.every((i) => i.kind === "vimium");
  return { ok, issues };
}
