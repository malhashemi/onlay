// The command registry (ADR-0019 §3): ONE table drives the command bar's
// rows, the chord dispatcher, and — through COMMAND_META, which it shares —
// the options page. Ask is hidden (spec §10): no Ask command lives here, so
// no row, chord or shortcut setting can create one. Copy (labels/descriptions) lives in prefs.ts; this module
// adds the overlay-side grammar: glyph, kind hue, scope, and the handler.
//
// Handlers never touch machinery directly — they speak through CommandCtx,
// which the content script wires onto the real modes/panels. That keeps the
// table pure and unit-testable with a stub ctx.
import { COMMAND_IDS, COMMAND_META, type CommandId } from "../prefs";
import { type Glyph, KINDS } from "./kinds";

/** What a block-scoped command does once its block is picked. */
export type PickKind = "comment" | "edit" | "copy";

/**
 * The machinery a command may drive — content.ts provides the one real
 * implementation; tests provide recorders.
 */
export interface CommandCtx {
  /** Arm block-pick mode; the picked block continues into the command's flow. */
  enterPick(kind: PickKind): void;
  /** Open a composer window at page scope (centered — no block to sit near). */
  openPageComposer(kind: "comment" | "edit"): void;
  /** Put the command bar into Inbox mode (opens it if needed). */
  openInbox(): void;
  /** Enter page-edit mode with the edit tray open. */
  openEditTray(): void;
  /** Ask the service worker to open the extension options page. */
  openSettings(): void;
  /** Toggle the command bar (the `commandBar` command / Ctrl+.). */
  toggleCommandBar(): void;
  /** Flip light/dark from the current effective look (System lives in Settings). */
  toggleTheme(): void;
  /** Open the command bar's space mode: where new comments and edits go. */
  switchSpace(): void;
  /** Open the command bar's list of this page's kept edits. */
  openKeptEdits(): void;
  /** Copy this page's round for an agent (spec §9). */
  copyRound(): void;
}

export type CommandScope = "block" | "page" | "none";

/** Command-bar search modes — `<letter>+space` in the bar enters one. */
export type SearchMode = "i" | "c" | "e";

export interface Command {
  id: CommandId;
  label: string;
  description: string;
  icon: Glyph;
  /** Kind hue class (`k-comment`…) — empty string for neutral commands. */
  cls: string;
  scope: CommandScope;
  /** Running this command enters a command-bar mode instead of leaving it. */
  searchMode?: SearchMode;
  run(ctx: CommandCtx): void;
}

/* ── glyphs (24×24 path data, lucide-derived; kind commands reuse KINDS) ── */

/** Search — the bar's own mark (input row + the commandBar command). */
export const SEARCH_GLYPH: Glyph = {
  paths: ["M11 3a8 8 0 1 0 0 16 8 8 0 0 0 0-16z", "m21 21-4.3-4.3"],
};
const COPY_GLYPH: Glyph = {
  paths: [
    "M11 9h9a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2h-9a2 2 0 0 1-2-2v-9a2 2 0 0 1 2-2z",
    "M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1",
  ],
};
const EDIT_PAGE_GLYPH: Glyph = {
  paths: [
    "M12 3H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7",
    "M18.4 2.6a2.1 2.1 0 0 1 3 3L12 15l-4 1 1-4z",
  ],
};
const COMMENT_PAGE_GLYPH: Glyph = {
  paths: [
    "M14 9a2 2 0 0 1-2 2H6l-4 4V4a2 2 0 0 1 2-2h8a2 2 0 0 1 2 2z",
    "M18 9h2a2 2 0 0 1 2 2v11l-4-4h-6a2 2 0 0 1-2-2v-1",
  ],
};
/** Two stacked squares (lucide layers) — the spaces you work in. */
const SPACE_GLYPH: Glyph = {
  paths: ["m12 2 10 5-10 5L2 7z", "m2 17 10 5 10-5", "m2 12 10 5 10-5"],
};
/** Eye (lucide eye) — the edits kept on this page, shown or hidden. */
const KEPT_GLYPH: Glyph = {
  paths: [
    "M2 12s3.6-7 10-7 10 7 10 7-3.6 7-10 7S2 12 2 12z",
    "M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6z",
  ],
};
/** Clipboard (lucide clipboard) — a pointer for an agent. */
const CLIPBOARD_GLYPH: Glyph = {
  paths: [
    "M9 2h6a1 1 0 0 1 1 1v2a1 1 0 0 1-1 1H9a1 1 0 0 1-1-1V3a1 1 0 0 1 1-1z",
    "M16 4h2a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h2",
  ],
};
const INBOX_GLYPH: Glyph = {
  paths: [
    "M22 12h-6l-2 3h-4l-2-3H2",
    "M5.45 5.11 2 12v6a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-6l-3.45-6.89A2 2 0 0 0 16.76 4H7.24a2 2 0 0 0-1.79 1.11z",
  ],
};
/** Sun-and-moon (lucide sun-moon) — the light/dark flip. */
const THEME_GLYPH: Glyph = {
  paths: [
    "M12 8a2.83 2.83 0 0 0 4 4 4 4 0 1 1-4-4",
    "M12 2v2",
    "M12 20v2",
    "m4.9 4.9 1.4 1.4",
    "m17.7 17.7 1.4 1.4",
    "M2 12h2",
    "M20 12h2",
    "m6.3 17.7-1.4 1.4",
    "m19.1 4.9-1.4 1.4",
  ],
};
const SETTINGS_GLYPH: Glyph = {
  paths: [
    "M21 4h-7",
    "M10 4H3",
    "M14 2v4",
    "M21 12h-9",
    "M8 12H3",
    "M8 10v4",
    "M21 20h-5",
    "M12 20H3",
    "M16 18v4",
  ],
};

/* ── the table ── */

interface CommandShape {
  icon: Glyph;
  cls: string;
  scope: CommandScope;
  searchMode?: SearchMode;
  run(ctx: CommandCtx): void;
}

const SHAPES: Record<CommandId, CommandShape> = {
  commandBar: {
    icon: SEARCH_GLYPH,
    cls: "",
    scope: "none",
    run: (ctx) => ctx.toggleCommandBar(),
  },
  copyBlock: {
    icon: COPY_GLYPH,
    cls: "",
    scope: "block",
    run: (ctx) => ctx.enterPick("copy"),
  },
  editBlock: {
    icon: KINDS.change.glyph,
    cls: KINDS.change.cls,
    scope: "block",
    run: (ctx) => ctx.enterPick("edit"),
  },
  editPage: {
    icon: EDIT_PAGE_GLYPH,
    cls: KINDS.change.cls,
    scope: "page",
    run: (ctx) => ctx.openEditTray(),
  },
  commentBlock: {
    icon: KINDS.comment.glyph,
    cls: KINDS.comment.cls,
    scope: "block",
    run: (ctx) => ctx.enterPick("comment"),
  },
  commentPage: {
    icon: COMMENT_PAGE_GLYPH,
    cls: KINDS.comment.cls,
    scope: "page",
    run: (ctx) => ctx.openPageComposer("comment"),
  },
  inbox: {
    icon: INBOX_GLYPH,
    cls: "",
    scope: "none",
    searchMode: "i",
    run: (ctx) => ctx.openInbox(),
  },
  keptEdits: {
    icon: KEPT_GLYPH,
    cls: "",
    scope: "none",
    run: (ctx) => ctx.openKeptEdits(),
  },
  copyForAgent: {
    icon: CLIPBOARD_GLYPH,
    cls: "",
    scope: "none",
    run: (ctx) => ctx.copyRound(),
  },
  switchSpace: {
    icon: SPACE_GLYPH,
    cls: "",
    scope: "none",
    run: (ctx) => ctx.switchSpace(),
  },
  toggleTheme: {
    icon: THEME_GLYPH,
    cls: "",
    scope: "none",
    run: (ctx) => ctx.toggleTheme(),
  },
  settings: {
    icon: SETTINGS_GLYPH,
    cls: "",
    scope: "none",
    run: (ctx) => ctx.openSettings(),
  },
};

/** Every command, in COMMAND_IDS display order. */
export const COMMANDS: readonly Command[] = COMMAND_IDS.map((id) => ({
  id,
  label: COMMAND_META[id].label,
  description: COMMAND_META[id].description,
  ...SHAPES[id],
}));

export function commandById(id: CommandId): Command {
  const found = COMMANDS.find((c) => c.id === id);
  if (!found) throw new Error(`unknown command: ${id}`);
  return found;
}

/**
 * The block-pick hint per pick kind (lexicon: "block", never "element").
 * Lives beside the registry so the lexicon test pins it in one place.
 */
export const PICK_HINTS: Record<PickKind, string> = {
  comment: "comment — click a block (Esc cancels)",
  edit: "edit — click a block (Esc cancels)",
  copy: "copy — click a block (Esc cancels)",
};

/**
 * The hint line once a pick's pointer reaches a frame onlay can't anchor in
 * (a sandboxed frame, a `data:` frame, another origin's blank frame, A-3).
 */
export const SANDBOXED_FRAME_HINT = "This block is in a sandboxed frame. Onlay can't anchor to it.";

/** A re-anchor whose frame went away before it could start. */
export const REANCHOR_FRAME_GONE =
  "This block's frame isn't on the page anymore. Reload the page, then try again.";

/** The hint line while a re-anchor pick waits for the block's new place. */
export const REANCHOR_HINT = "Pick a new block to re-anchor (Esc to cancel)";
