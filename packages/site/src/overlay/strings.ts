// The product's own words, as the extension's overlay says them. Each group
// names the file it was read from (packages/extension/src/…): when the
// product's wording changes there, change it here, so what a visitor learns on
// this page stays true after they install. Nothing here is the copywriter's.

/** prefs.ts — COMMAND_META, KEYBOARD_DEFAULTS, in COMMAND_IDS order (the bar never lists itself). */
export const COMMANDS = [
  {
    id: "copyBlock",
    label: "Copy block HTML",
    description: "Copies the picked block's HTML to your clipboard — nothing is sent anywhere.",
    chord: "cs",
  },
  {
    id: "editBlock",
    label: "Edit block",
    description: "Pick a block and describe the edit an agent should make.",
    chord: "ee",
  },
  {
    id: "editPage",
    label: "Edit page",
    description: "Open the edit tray — click text to rewrite or delete, then send the batch.",
    chord: "ea",
  },
  {
    id: "commentBlock",
    label: "Comment on block",
    description: "Pick a block and start a comment thread anchored to it.",
    chord: "cc",
  },
  {
    id: "commentPage",
    label: "Comment on page",
    description: "Start a comment thread on the page as a whole.",
    chord: "ca",
  },
  {
    id: "inbox",
    label: "Inbox",
    description: "Everything that needs you, on this page and everywhere else.",
    chord: "ii",
  },
  {
    id: "keptEdits",
    label: "Kept edits",
    description: "See the edits kept on this page, and show or hide each one.",
    chord: "ek",
  },
  {
    id: "copyForAgent",
    label: "Copy for agent",
    description: "Copy a pointer to what's waiting for an agent on this page.",
    chord: "ag",
  },
  {
    id: "switchSpace",
    label: "Switch space",
    description: "Choose the space your new comments and edits go to.",
    chord: "ww",
  },
  {
    id: "toggleTheme",
    label: "Toggle light / dark",
    description: "Flip the overlay's look. Pick System in Settings → Appearance.",
    chord: "mm",
  },
  {
    id: "settings",
    label: "Settings",
    description: "Open this settings page.",
    chord: "ss",
  },
] as const;

export type CommandId = (typeof COMMANDS)[number]["id"];

/** prefs.ts — the command bar's accelerator, shown the same on every system (command-bar.ts `bindingLabel`). */
export const ACCEL_LABEL = "Ctrl+.";

/** command-bar.ts */
export const BAR = {
  inputLabel: "Onlay command bar",
  rootPlaceholder: "Type a command…",
  noCommand: "no matching command",
  nothingMatches: "nothing matches",
  footer: {
    root: ["↑↓ move", "↵ run", "esc close"],
    kept: ["↑↓ move", "↵ show or hide", "esc back"],
    // The product's line also has "⌃↵ full view"; this page has no full view, so it does not say so.
    data: ["↑↓ move", "↵ open", "⌃n open nth", "esc back"],
  },
  modes: {
    inbox: {
      label: "Inbox",
      placeholder: "Search your inbox…",
      empty: "Nothing needs you.",
    },
    kept: {
      label: "Kept edits",
      placeholder: "Search kept edits…",
      empty: "No kept edits on this page.",
    },
  },
  groups: { onpage: "on this page", elsewhere: "elsewhere", recent: "recent" },
  kept: {
    shown: "Shown",
    hidden: "Hidden",
    showTitle: "Show this edit on the page",
    hideTitle: "Hide this edit on the page",
    openThread: "Open thread",
    keptBy: (name: string) => `kept by ${name}`,
  },
} as const;

/** kinds.ts */
export const KIND_LABEL = { comment: "Comment", change: "Edit" } as const;
export const CHIP_LABEL = {
  "needs-you": "needs you",
  waiting: "waiting",
  resolved: "resolved",
} as const;
export const AGENT_WORK_LABEL = {
  pending: "for agent",
  taken: "taken",
  answered: "answered",
} as const;

/** commands.ts — PICK_HINTS */
export const PICK_HINTS = {
  comment: "comment — click a block (Esc cancels)",
  edit: "edit — click a block (Esc cancels)",
  copy: "copy — click a block (Esc cancels)",
} as const;

/** launcher.ts */
export const LAUNCHER = {
  label: "Onlay — open your Inbox",
  title: "Onlay · connected — click for your Inbox · drag to move · double-click resets",
  editsShown: (n: number) => (n === 1 ? "1 edit shown" : `${n} edits shown`),
  forAgent: (n: number) => `${n} for agent`,
  editsShownTitle: "Kept edits shown on this page — click to show or hide them",
  forAgentTitle: "Waiting for an agent on this page — click to copy",
} as const;

/** composers.ts, composer-window.ts */
export const COMPOSER = {
  close: "Close",
  move: "Move",
  moveTitle: "Drag to move, or use arrow keys.",
  cancel: "Cancel",
  page: "page",
  commentPlaceholder: "Comment on this spot… @mention to notify",
  commentSend: "Comment",
  commentPosted: "comment posted",
  action: "Action",
  actionEdit: "Edit",
  actionInsert: "Insert after",
  delivery: "Delivery",
  direct: "Direct",
  variants: "Variants",
  count: "Count",
  editPlaceholder: "Describe the edit for the agent…",
  insertPlaceholder: "Describe what to insert after this anchor…",
  requestEdit: "Request edit",
  requestInsert: "Request insert",
  generate: "Generate variants",
  describeFirst: "Describe the edit first.",
  editSent: "Edit sent for an agent.",
  insertPrefix: "Insert after this anchor: ",
} as const;

/** thread.ts, dom.ts */
export const THREAD = {
  copyForAgent: "Copy for agent",
  share: "Share",
  close: "Close",
  agentTag: "agent",
  agentTagTitle: "Written by an agent",
  reply: "reply",
  edit: "edit",
  del: "delete",
  confirm: "confirm?",
  edited: "· edited",
  deleted: "(deleted)",
  revise: "revise…",
  save: "Save",
  cancel: "Cancel",
  cancelReply: "cancel reply",
  quoteGone: "original message removed",
  replyPlaceholder: "Reply… @mention to notify",
  followPlaceholder: "Follow up — the thread outlives the resolution",
  replySend: "Reply",
  followSend: "Follow up",
  resolve: "Resolve",
  reopen: "Reopen",
  reactTitle: "react — counts as seen",
  method: (method: string, state: string) => `method: ${method} · ${state}`,
  pageLevel: "page-level",
  dragTitle: "drag to move",
  gripTitle: "drag to resize",
} as const;

/** variants.ts */
export const VARIANTS = {
  prev: "‹",
  next: "›",
  more: "+",
  moreTitle: "Ask for one more variant",
  pick: "Pick active",
  discard: "Discard",
  commentPlaceholder: "Comment on active variant… @mention to notify",
  commentSend: "Comment",
  commented: "Comment posted to the Edit thread.",
  original: "Original — unchanged",
  generating: "generating",
  ready: (n: number) => `${n} variant(s) ready`,
  current: (i: number, n: number, label: string) => `${i}/${n} — ${label}`,
  previewing: (i: number, n: number, label: string) =>
    `previewing ${i}/${n}: ${label} — indicative`,
  pill: (label: string) => `Indicative preview — ${label}`,
  editLine: (id: string, state: string) => `edit ${id.slice(0, 8)} · ${state}`,
  outcome: (status: string, outcome: string) => `${status} — ${outcome}`,
  askedMore: "asked the agent for one more variant",
  pickSent: "pick sent",
  discardSent: "discard sent",
  prefix: (i: number, n: number, label: string) => `Variant ${i}/${n} — ${label}:`,
} as const;

/** token-input.ts — the `@` menu's agent row. */
export const MENTION = {
  head: "@ actors",
  agent: "@agent",
  agentTitle: "Hand this to an agent",
} as const;

/** render/src/reactions.ts — the quick-react set. */
export const REACTIONS: readonly string[] = ["👍", "✅", "👀", "🎉", "❤️"];
