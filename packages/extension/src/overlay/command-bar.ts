// The command bar (ADR-0019 §2, amended by ADR-0020): THE surface for
// actions and for your Inbox. A centered, searchable, keyboard-first palette
// with MODES, not windows — root mode lists commands; Inbox mode (`i`+space,
// the Inbox command, or a click on the orb) organizes everything that needs
// you: on this page → unanchored (anchor-lost strays and old unplaced Asks)
// → elsewhere → a dimmed recent tail, merged across every space. `c`/`e`+space
// are the same data filtered to one kind; the space mode picks where new
// comments and edits go (the chip beside the input shows it). Esc pops the
// mode, then closes; arrows navigate; Enter opens (interaction modal for inbox
// rows); Ctrl+Enter opens the full-page view; `a` Anchors an unanchored row.
import type { AgentWorkStatus, InboxRow, InteractionKind } from "@onlay/protocol";
import {
  becauseLabel,
  indexAttention,
  matchesQuery,
  needsReader,
  pathLabel,
  shownUrl,
  snapshotSummary,
} from "@onlay/render/interaction-view";
import { filterSpaces } from "@onlay/render/space-select";
import type { CommandId } from "../prefs";
import { anchorLabel } from "./anchors";
import type { App, InteractionSnap as Snapshot } from "./app";
import { type Command, SEARCH_GLYPH, type SearchMode } from "./commands";
import { CHANGED_SINCE_COPIED, changedSince, copiedStore } from "./copy-agent";
import { avatar, el, icon } from "./dom";
import type { KeptRow } from "./kept-layer";
import {
  AGENT_WORK_LABEL,
  agentWorkStatus,
  CHIP_STATES,
  chipFor,
  isLiveState,
  KINDS,
} from "./kinds";
import { captureDue } from "./resnap-model";
import { onRouted } from "./typing-router";

/* ── pure: command ranking ───────────────────────────────────────────── */

/**
 * Filter + rank commands for a query: label-prefix matches first, then
 * label-substring, then description matches — registry order within a tier
 * (sort is stable). Empty query returns the registry order untouched.
 */
export function rankCommands(commands: readonly Command[], query: string): Command[] {
  const q = query.trim().toLowerCase();
  if (!q) return [...commands];
  const scored: Array<{ c: Command; tier: number }> = [];
  for (const c of commands) {
    const label = c.label.toLowerCase();
    const tier = label.startsWith(q)
      ? 0
      : label.includes(q)
        ? 1
        : c.description.toLowerCase().includes(q)
          ? 2
          : null;
    if (tier !== null) scored.push({ c, tier });
  }
  scored.sort((a, b) => a.tier - b.tier);
  return scored.map((s) => s.c);
}

/* ── pure: the Inbox (server attention truth ⊕ local page snapshots) ── */

export type QueueGroup = "onpage" | "unanchored" | "elsewhere" | "recent";

export interface QueueRow {
  interactionId: string;
  /** The space the interaction lives in. */
  spaceId: string;
  kind: InteractionKind;
  state: string;
  group: QueueGroup;
  /** One-line summary: ask question / edit intent / first thread words. */
  text: string;
  actorId: string;
  /** Absent on unanchored rows — they have no page (ADR-0020). */
  url?: string;
  /** The page the person shares, when the block is inside a frame of it (F-3). */
  hostUrl?: string;
  /** True when this page's snapshot backs the row (thread opens in place). */
  local: boolean;
  /** Anchor label for local rows; the attention row's label otherwise. */
  context: string;
  ts: number;
  /** This row waits on YOU right now (ordering + chip). */
  needs: boolean;
  /** Never anchored (agent Ask awaiting judgment or placement). */
  unanchored?: boolean;
  /** Was placed, lost its spot — re-anchor or resolve. */
  anchorLost?: boolean;
  stakes?: "routine" | "careful" | "dangerous";
  /** The interaction's agent work, when it has any (spec §7). */
  agentWork?: AgentWorkStatus;
  /** Why the server put it in the Inbox (`shared`, …). */
  because?: string;
}

/** The Inbox lists, merged across spaces (`/api/inbox`). */
export interface AttentionLists {
  needsYou: InboxRow[];
  waiting: InboxRow[];
  recent: InboxRow[];
}

function snapTs(s: Snapshot): number {
  const last = s.thread[s.thread.length - 1];
  return last?.ts ?? s.createdAt;
}

const STAKES_RANK: Record<string, number> = { dangerous: 0, careful: 1, routine: 2 };

/**
 * Merge the cross-page attention snapshot with this page's live snapshots,
 * deduped by interaction id — the local snapshot wins (it is fresher and
 * richer). Inbox organization (ADR-0020): on this page → unanchored (never
 * placed, or anchor-lost) → elsewhere → recent. Within a section: what needs
 * you first (dangerous > careful > routine, then oldest debt); the rest
 * newest-first.
 */
export function mergeQueue(
  local: Snapshot[],
  attention: AttentionLists | null,
  self: string | null,
): QueueRow[] {
  const rows = new Map<string, QueueRow>();
  // Whether a thread needs you is the server's attention rule, shared with the
  // thread's header and pins (`needsReader`): where attention knows a thread,
  // it decides; waitingOn is the fallback.
  const serverNeeds = indexAttention(attention);
  for (const s of local) {
    const live = isLiveState(s.state);
    const group: QueueGroup = !live ? "recent" : s.anchorLost ? "unanchored" : "onpage";
    const work = agentWorkStatus(s.agentWork);
    const known = serverNeeds.get(s.id);
    const needs = live && needsReader(s, self, serverNeeds);
    rows.set(s.id, {
      interactionId: s.id,
      spaceId: s.spaceId,
      kind: s.kind,
      state: s.state,
      group,
      text: snapshotSummary(s),
      actorId: s.authorId,
      ...(s.url !== undefined ? { url: s.url } : {}),
      ...(s.hostUrl !== undefined ? { hostUrl: s.hostUrl } : {}),
      local: true,
      context: anchorLabel(s.anchor),
      ts: snapTs(s),
      needs,
      ...(known?.because ? { because: known.because } : {}),
      ...(s.anchorLost ? { anchorLost: true } : {}),
      ...(s.kind === "ask" && s.ask?.stakes ? { stakes: s.ask.stakes } : {}),
      ...(work ? { agentWork: work } : {}),
    });
  }
  const adopt = (needs: boolean, recent: boolean, list: InboxRow[]): void => {
    for (const r of list) {
      if (rows.has(r.interactionId)) continue;
      const loose = r.unanchored === true || r.anchorLost === true;
      const group: QueueGroup = recent ? "recent" : loose ? "unanchored" : "elsewhere";
      rows.set(r.interactionId, {
        interactionId: r.interactionId,
        spaceId: r.spaceId,
        kind: r.kind,
        state: r.state,
        group,
        text: r.text,
        actorId: r.fromActorId,
        ...(r.url !== undefined ? { url: r.url } : {}),
        ...(r.hostUrl !== undefined ? { hostUrl: r.hostUrl } : {}),
        local: false,
        context: r.anchorLabel,
        ts: r.ts,
        needs,
        ...(r.unanchored ? { unanchored: true } : {}),
        ...(r.anchorLost ? { anchorLost: true } : {}),
        ...(r.stakes ? { stakes: r.stakes } : {}),
        ...(r.agentWork ? { agentWork: r.agentWork } : {}),
        ...(r.because ? { because: r.because } : {}),
      });
    }
  };
  if (attention) {
    adopt(true, false, attention.needsYou);
    adopt(false, false, attention.waiting);
    adopt(false, true, attention.recent);
  }
  const order: Record<QueueGroup, number> = { onpage: 0, unanchored: 1, elsewhere: 2, recent: 3 };
  return [...rows.values()].sort((a, b) => {
    if (order[a.group] !== order[b.group]) return order[a.group] - order[b.group];
    if (a.needs !== b.needs) return a.needs ? -1 : 1;
    if (a.needs && b.needs) {
      const sr =
        (STAKES_RANK[a.stakes ?? "routine"] ?? 2) - (STAKES_RANK[b.stakes ?? "routine"] ?? 2);
      if (sr !== 0) return sr;
      return a.ts - b.ts; // oldest debt first
    }
    return b.ts - a.ts;
  });
}

/** Search across text, actor (id and display name), context, state, page —
 *  the ONE shared matcher (`matchesQuery`), so the PWA search bar and this
 *  bar can never drift apart in what a query means. */
export function filterQueue(
  rows: QueueRow[],
  query: string,
  actorName: (id: string) => string,
): QueueRow[] {
  if (!query.trim()) return rows;
  return rows.filter((r) =>
    matchesQuery(
      {
        text: r.text,
        actorId: r.actorId,
        actorName: actorName(r.actorId),
        context: r.context,
        state: r.state,
        place: pathLabel(shownUrl(r)),
        ...(r.url !== undefined ? { url: r.url } : {}),
      },
      query,
    ),
  );
}

/* ── modes ───────────────────────────────────────────────────────────── */

/**
 * `space`: choose where new comments and edits go; `kept`: this page's kept
 * edits, each with a switch. Ask has no mode (spec §10).
 */
export type BarMode = "root" | "inbox" | "comment" | "edit" | "space" | "kept";

/** `<letter>+space` typed at the root enters a mode (i/c/e). */
const MODE_BY_KEY: Record<SearchMode, Exclude<BarMode, "root" | "space" | "kept">> = {
  i: "inbox",
  c: "comment",
  e: "edit",
};

interface ModeSpec {
  label: string;
  cls: string;
  kind: InteractionKind | null;
  placeholder: string;
  /** Empty state with personality — never a blank pane. */
  empty: string;
}

export const MODE_SPEC: Record<Exclude<BarMode, "root">, ModeSpec> = {
  inbox: {
    label: "Inbox",
    cls: "",
    kind: null,
    placeholder: "Search your inbox…",
    empty: "Nothing needs you.",
  },
  comment: {
    label: "Comments",
    cls: "k-comment",
    kind: "comment",
    placeholder: "Search comments…",
    empty: "No comment threads on this page.",
  },
  edit: {
    label: "Edits",
    cls: "k-change",
    kind: "change",
    placeholder: "Search edits…",
    empty: "No edits in flight on this page.",
  },
  space: {
    label: "Space",
    cls: "",
    kind: null,
    placeholder: "Search spaces…",
    empty: "No matching spaces.",
  },
  kept: {
    label: "Kept edits",
    cls: "k-change",
    kind: null,
    placeholder: "Search kept edits…",
    empty: "No kept edits on this page.",
  },
};

/** The kept edits list's words (spec §8). */
export const KEPT_COPY = {
  shown: "Shown",
  hidden: "Hidden",
  showTitle: "Show this edit on the page",
  hideTitle: "Hide this edit on the page",
  openThread: "Open thread",
  unresolved: "can't be shown on this page",
  refused: (n: number) => `${n} couldn't be applied`,
  keptBy: (name: string) => `kept by ${name}`,
} as const;

/* ── the bar ─────────────────────────────────────────────────────────── */

export interface CommandBarDeps {
  commands: readonly Command[];
  /** Live chord/accelerator binding for a command id (kbd chips). */
  binding(id: CommandId): string;
  /** Dispatch a command (content.ts routes through the registry ctx). */
  run(id: CommandId): void;
  /** Cross-page attention snapshot from the SW cache (fail-soft null). */
  fetchAttention(): Promise<AttentionLists | null>;
  /** Socket truth for the quiet offline note. */
  connected(): boolean;
  /** What the offline note says (signed out, update needed, unreachable). */
  offlineNote?(): string;
  /** Open a local interaction's thread panel. */
  openInteraction(id: string): void;
  /** Open a thread bound to the child frame `documentId` (2-E4). */
  openInFrame?(id: string, documentId: string): void;
  /** Threads on the other frames of this tab: on this page too (F-3). */
  frameInteractions?(): Snapshot[];
  /** Leave for another page's row. */
  navigate(url: string): void;
  /** Open the centered interaction modal for an inbox row (ADR-0020). */
  openModal?(row: QueueRow): void;
  /** Open the full-page interaction view (Ctrl+Enter — works page-less). */
  openFullView?(interactionId: string): void;
  /** Anchor an unanchored Ask here / re-anchor a lost one (block pick). */
  anchorRow?(row: QueueRow): void;
  /** Fulfill a "Capture due" duty on this page — resolve the anchor + capture (§3). */
  onFreshLook?(interactionId: string): void;
  /** The bar just opened: a moment to re-read the account, so a space made
   *  or joined elsewhere is offered without waiting for the next refresh. */
  onOpened?(): void;
  /** This page's kept edits (the `kept` mode). */
  keptRows?(): KeptRow[];
  /** The viewer's switch for one kept edit. */
  setKeptOn?(interactionId: string, on: boolean, documentId?: string): void;
}

export interface CommandBar {
  element: HTMLElement;
  open(mode?: BarMode): void;
  close(): void;
  toggle(): void;
  isOpen(): boolean;
  mode(): BarMode;
  /** Esc rung: pop a mode back to root, or close from the root. */
  escape(): void;
  /** True while the bar's own input holds focus (Ctrl+. must still toggle). */
  ownsFocus(): boolean;
  /** Re-render the open bar from fresh state (interactions-state frames). */
  refresh(): void;
  /** Re-pull attention truth (storage updated after open) + re-render. */
  refreshAttention(): void;
}

/** Display form of a stored binding: "ctrl+." → "Ctrl+·"-style "Ctrl+."; chords stay lowercase. */
function bindingLabel(binding: string): string {
  return binding.replace(/^ctrl\+/i, "Ctrl+");
}

interface Row {
  node: HTMLElement;
  run(): void;
}

export function createCommandBar(app: App, deps: CommandBarDeps): CommandBar {
  const backdrop = el("div", "bar-backdrop");
  const bar = el("div", "command-bar");
  backdrop.appendChild(bar);

  const inputRow = el("div", "bar-input-row");
  inputRow.appendChild(icon(SEARCH_GLYPH, "icon bar-search-icon"));
  const modeChip = el("span", "chip chip-kind bar-mode-chip");
  modeChip.style.display = "none";
  inputRow.appendChild(modeChip);
  const input = document.createElement("input");
  input.className = "bar-input";
  input.type = "text";
  input.placeholder = "Type a command…";
  input.setAttribute("aria-label", "Onlay command bar");
  inputRow.appendChild(input);
  // The space new comments and edits go to — shown only when there's a choice.
  const spaceChip = el("button", "chip chip-waiting bar-space-chip") as HTMLButtonElement;
  spaceChip.type = "button";
  spaceChip.title = "Switch space";
  spaceChip.style.display = "none";
  spaceChip.addEventListener("click", (e) => {
    if (!e.isTrusted) return;
    setMode("space");
    input.focus();
  });
  inputRow.appendChild(spaceChip);
  const hintKey = el("span", "kbd bar-hint");
  inputRow.appendChild(hintKey);
  bar.appendChild(inputRow);

  const offline = el("div", "bar-offline", "Can't reach the Onlay server. Reconnecting…");
  offline.style.display = "none";
  bar.appendChild(offline);

  const list = el("div", "bar-list");
  bar.appendChild(list);

  const footer = el("div", "bar-footer");
  bar.appendChild(footer);
  function paintFooter(): void {
    while (footer.firstChild) footer.removeChild(footer.firstChild);
    const keys =
      mode === "root"
        ? ["↑↓ move", "↵ run", "esc close"]
        : mode === "space"
          ? ["↑↓ move", "↵ choose", "esc back"]
          : mode === "kept"
            ? ["↑↓ move", "↵ show or hide", "esc back"]
            : ["↑↓ move", "↵ open", "⌃n open nth", "⌃↵ full view", "esc back"];
    for (const k of keys) footer.appendChild(el("span", undefined, k));
  }

  let mode: BarMode = "root";
  let rows: Row[] = [];
  let dataRows: Array<QueueRow | null> = [];
  let sel = 0;
  let attention: AttentionLists | null = null;
  let restoreFocus: HTMLElement | null = null;

  /* ── attention refresh (fail-soft; re-render if still in a data mode) ── */
  function refreshAttention(): void {
    void deps.fetchAttention().then(
      (a) => {
        attention = a;
        if (isOpen() && mode !== "root") render();
      },
      () => {},
    );
  }

  /* ── rendering ── */

  function paintSel(): void {
    for (let i = 0; i < rows.length; i++) {
      rows[i]?.node.classList.toggle("on", i === sel);
    }
    rows[sel]?.node.scrollIntoView?.({ block: "nearest" });
  }

  function addRow(node: HTMLElement, run: () => void): void {
    const i = rows.length;
    node.addEventListener("mouseenter", () => {
      sel = i;
      paintSel();
    });
    node.addEventListener("click", (e) => {
      if (!e.isTrusted) return;
      run();
    });
    rows.push({ node, run });
    dataRows.push(null);
    list.appendChild(node);
  }

  function commandRow(c: Command): void {
    const node = el("button", `bar-row ${c.cls}`.trim());
    (node as HTMLButtonElement).type = "button";
    node.appendChild(icon(c.icon, "icon"));
    node.appendChild(el("span", "label", c.label));
    node.appendChild(el("span", "desc", c.description));
    const b = deps.binding(c.id);
    if (b) node.appendChild(el("span", "kbd", bindingLabel(b)));
    addRow(node, () => deps.run(c.id));
  }

  function ageLabel(ts: number): string {
    const d = Date.now() - ts;
    if (d < 60_000) return "now";
    if (d < 3_600_000) return `${Math.floor(d / 60_000)}m`;
    if (d < 86_400_000) return `${Math.floor(d / 3_600_000)}h`;
    return `${Math.floor(d / 86_400_000)}d`;
  }

  /** Place line for a row: anchor label on-page, path elsewhere, honest words when loose. */
  function placeLabel(r: QueueRow): string {
    if (r.unanchored) return "unanchored";
    if (r.anchorLost) return `anchor lost · ${r.local ? "this page" : pathLabel(shownUrl(r))}`;
    return r.local ? r.context : pathLabel(shownUrl(r));
  }

  function canAnchor(r: QueueRow): boolean {
    if (app.isGuest(r.spaceId)) return false;
    return r.unanchored === true || (r.anchorLost === true && r.local);
  }

  function spaceName(id: string): string {
    return app.space(id)?.name ?? "";
  }

  function paintSpaceChip(): void {
    const current = app.currentSpaceId();
    const show = app.composeSpaces().length > 1 && current !== null;
    spaceChip.style.display = show ? "inline-flex" : "none";
    if (show && current) spaceChip.textContent = spaceName(current);
  }

  /** The space mode: every space the person can post in, the current one marked. */
  function renderSpaces(query: string): void {
    const current = app.currentSpaceId();
    // The same search as the composer's space menu (@onlay/render/space-select).
    const spaces = filterSpaces(app.composeSpaces(), query);
    if (spaces.length === 0) emptyNote(MODE_SPEC.space.empty);
    for (const s of spaces) {
      const node = el("button", "bar-row");
      (node as HTMLButtonElement).type = "button";
      node.appendChild(el("span", "label", s.name));
      node.appendChild(
        el("span", "desc", s.kind === "personal" ? "Just you" : s.role === "admin" ? "Admin" : ""),
      );
      if (s.id === current) node.appendChild(el("span", "chip chip-waiting", "current"));
      addRow(node, () => {
        app.setCurrentSpace(s.id);
        close();
        app.toast(`New comments and edits go to ${s.name}.`);
      });
    }
  }

  function openRow(r: QueueRow): void {
    if (deps.openModal) {
      close();
      deps.openModal(r);
      return;
    }
    close();
    if (r.local) deps.openInteraction(r.interactionId);
    else if (shownUrl(r)) deps.navigate(shownUrl(r) as string);
    else if (deps.openFullView) deps.openFullView(r.interactionId);
  }

  function anchorRow(r: QueueRow): void {
    if (!deps.anchorRow) return;
    close();
    deps.anchorRow(r);
  }

  function queueRow(r: QueueRow): void {
    const spec = KINDS[r.kind];
    // Quick-select (F-054 family): the first nine rows of a filtered surface
    // answer ⌃1–⌃9 and wear the binding as their kbd chip.
    const quickIdx = rows.length;
    const node = el("button", `bar-row q-row ${spec.cls}`);
    (node as HTMLButtonElement).type = "button";
    node.appendChild(icon(spec.glyph, "icon"));
    const main = el("div", "q-main");
    const top = el("div", "q-top");
    top.appendChild(el("span", "q-text", r.text || spec.label));
    const self = app.selfId();
    const chip = chipFor(r.state, r.needs && self !== null);
    top.appendChild(el("span", `chip ${CHIP_STATES[chip].cls}`, CHIP_STATES[chip].label));
    if (r.stakes === "careful" || r.stakes === "dangerous") {
      top.appendChild(el("span", `chip chip-stakes-${r.stakes}`, r.stakes));
    }
    top.appendChild(el("span", "q-age", ageLabel(r.ts)));
    if (quickIdx < 9) top.appendChild(el("span", "kbd q-quick", `⌃${quickIdx + 1}`));
    main.appendChild(top);
    const meta = el("div", "q-meta");
    const actor = app.person(r.actorId);
    meta.append(avatar(actor, "sm"), el("span", "q-actor", actor.name));
    if (app.multiSpace()) meta.appendChild(el("span", "q-away", spaceName(r.spaceId)));
    meta.appendChild(el("span", "q-context", placeLabel(r)));
    if (r.agentWork) meta.appendChild(el("span", "q-away", AGENT_WORK_LABEL[r.agentWork]));
    const reason = becauseLabel(r.because);
    if (reason) meta.appendChild(el("span", "q-away", reason));
    const snapshot = r.local ? app.byId(r.interactionId) : undefined;
    if (snapshot && changedSince(copiedStore(), app, snapshot))
      meta.appendChild(el("span", "q-away", CHANGED_SINCE_COPIED));
    if (!r.local && r.url) meta.appendChild(el("span", "q-away", "↗"));
    if (canAnchor(r) && deps.anchorRow) {
      const act = el("button", "q-anchor-act", "Anchor") as HTMLButtonElement;
      act.type = "button";
      act.title = r.unanchored ? "Anchor to this page" : "Re-anchor on this page";
      act.addEventListener("click", (e) => {
        if (!e.isTrusted) return;
        e.stopPropagation();
        anchorRow(r);
      });
      meta.appendChild(act);
    } else if (r.anchorLost && !r.local) {
      const hint = el("span", "q-anchor-act", "Anchor");
      hint.title = `on ${pathLabel(shownUrl(r))} — open to re-anchor`;
      hint.style.opacity = "0.4";
      meta.appendChild(hint);
    }
    main.appendChild(meta);
    node.appendChild(main);
    addRow(node, () => openRow(r));
    dataRows[dataRows.length - 1] = r;
  }

  /** The kept mode: each kept edit with who kept it, a switch, and its thread. */
  function renderKept(query: string): void {
    const q = query.trim().toLowerCase();
    const all = deps.keptRows?.() ?? [];
    const rowsShown = all.filter(
      (k) =>
        !q || k.label.toLowerCase().includes(q) || app.person(k.by).name.toLowerCase().includes(q),
    );
    if (rowsShown.length === 0) emptyNote(q ? "Nothing matches." : MODE_SPEC.kept.empty);
    for (const k of rowsShown) {
      const node = el("button", "bar-row q-row k-change");
      (node as HTMLButtonElement).type = "button";
      node.appendChild(icon(KINDS.change.glyph, "icon"));
      const main = el("div", "q-main");
      const top = el("div", "q-top");
      top.appendChild(el("span", "q-text", k.label || KINDS.change.label));
      const toggle = el(
        "span",
        `pill-toggle${k.on ? " on" : ""}`,
        k.on ? KEPT_COPY.shown : KEPT_COPY.hidden,
      );
      toggle.setAttribute("role", "switch");
      toggle.setAttribute("aria-checked", String(k.on));
      toggle.title = k.on ? KEPT_COPY.hideTitle : KEPT_COPY.showTitle;
      top.appendChild(toggle);
      main.appendChild(top);
      const meta = el("div", "q-meta");
      const by = app.person(k.by);
      meta.append(avatar(by, "sm"), el("span", "q-actor", KEPT_COPY.keptBy(by.name)));
      if (app.multiSpace()) meta.appendChild(el("span", "q-away", spaceName(k.spaceId)));
      if (k.unresolved) meta.appendChild(el("span", "q-away", KEPT_COPY.unresolved));
      else if (k.refused > 0) meta.appendChild(el("span", "q-away", KEPT_COPY.refused(k.refused)));
      const open = el("span", "q-anchor-act", KEPT_COPY.openThread);
      open.addEventListener("click", (e) => {
        if (!e.isTrusted) return;
        e.stopPropagation();
        close();
        if (k.documentId && deps.openInFrame) deps.openInFrame(k.interactionId, k.documentId);
        else deps.openInteraction(k.interactionId);
      });
      meta.appendChild(open);
      main.appendChild(meta);
      node.appendChild(main);
      addRow(node, () => {
        deps.setKeptOn?.(k.interactionId, !k.on, k.documentId);
        render();
      });
    }
  }

  function emptyNote(text: string): void {
    list.appendChild(el("div", "bar-empty", text));
  }

  /**
   * The quiet "Capture due" group (§3): element/selection-anchored interactions
   * on this page whose snapshot's fresh-look duty is outstanding. Each row's
   * single action captures a fresh look. No count on the launcher, no amber —
   * a duty, not attention (ADR-0006). Rendered only in the Inbox (the on-this-page
   * surface), above the queue, and only with an empty query.
   */
  function renderCaptureDue(): void {
    if (mode !== "inbox" || input.value.trim() || !deps.onFreshLook) return;
    const due = captureDue(app.interactions(), app.selfId());
    if (due.length === 0) return;
    list.appendChild(el("div", "micro bar-group", "capture due"));
    const runFreshLook = deps.onFreshLook;
    for (const s of due) {
      const spec = KINDS[s.kind];
      const node = el("button", `bar-row q-row ${spec.cls}`);
      (node as HTMLButtonElement).type = "button";
      node.appendChild(icon(spec.glyph, "icon"));
      const main = el("div", "q-main");
      const top = el("div", "q-top");
      top.appendChild(el("span", "q-text", snapshotSummary(s) || spec.label));
      top.appendChild(el("span", "chip capture-due", "Capture due"));
      main.appendChild(top);
      const meta = el("div", "q-meta");
      meta.appendChild(el("span", "q-context", anchorLabel(s.anchor)));
      meta.appendChild(el("span", "q-anchor-act", "Capture a fresh look"));
      main.appendChild(meta);
      node.appendChild(main);
      addRow(node, () => {
        close();
        runFreshLook(s.id);
      });
    }
  }

  function render(): void {
    while (list.firstChild) list.removeChild(list.firstChild);
    rows = [];
    dataRows = [];
    offline.style.display = deps.connected() ? "none" : "block";
    if (deps.offlineNote) offline.textContent = deps.offlineNote();
    paintSpaceChip();
    const query = input.value;

    if (mode === "space") {
      renderSpaces(query);
    } else if (mode === "kept") {
      renderKept(query);
    } else if (mode === "root") {
      // The bar never lists itself — commandBar is the door, not a room.
      const visible = deps.commands.filter((c) => c.id !== "commandBar");
      const ranked = rankCommands(visible, query);
      if (ranked.length === 0) emptyNote("no matching command");
      for (const c of ranked) commandRow(c);
    } else {
      const spec = MODE_SPEC[mode];
      // The capture-due duty leads the Inbox — quiet, on-this-page, above the queue.
      renderCaptureDue();
      let all = mergeQueue(
        [...app.interactions(), ...(deps.frameInteractions?.() ?? [])],
        attention,
        app.selfId(),
      );
      if (spec.kind !== null) all = all.filter((r) => r.kind === spec.kind);
      const filtered = filterQueue(all, query, (id) => app.person(id).name);
      if (filtered.length === 0 && rows.length === 0) {
        emptyNote(query.trim() ? "nothing matches" : spec.empty);
      }
      let lastGroup: QueueGroup | null = null;
      const GROUP_LABEL: Record<QueueGroup, string> = {
        onpage: "on this page",
        unanchored: "unanchored",
        elsewhere: "elsewhere",
        recent: "recent",
      };
      let recentShown = 0;
      for (const r of filtered) {
        if (r.group === "recent" && ++recentShown > 5) break;
        if (r.group !== lastGroup) {
          lastGroup = r.group;
          list.appendChild(el("div", "micro bar-group", GROUP_LABEL[r.group]));
        }
        queueRow(r);
      }
    }
    sel = 0;
    paintSel();
  }

  function setMode(next: BarMode): void {
    mode = next;
    if (next === "root") {
      modeChip.style.display = "none";
      input.placeholder = "Type a command…";
    } else {
      const spec = MODE_SPEC[next];
      modeChip.className = `chip chip-kind bar-mode-chip ${spec.cls}`.trim();
      modeChip.textContent = spec.label;
      modeChip.style.display = "inline-flex";
      input.placeholder = spec.placeholder;
      if (next !== "space" && next !== "kept") refreshAttention();
    }
    input.value = "";
    paintFooter();
    render();
  }

  /* ── open/close ── */

  function isOpen(): boolean {
    return backdrop.style.display === "block";
  }

  function open(startMode: BarMode = "root"): void {
    if (!isOpen()) {
      const active = document.activeElement;
      restoreFocus = active instanceof HTMLElement ? active : null;
      backdrop.style.display = "block";
      hintKey.textContent = bindingLabel(deps.binding("commandBar"));
      deps.onOpened?.();
    }
    setMode(startMode);
    input.focus();
  }

  function close(): void {
    if (!isOpen()) return;
    backdrop.style.display = "none";
    mode = "root";
    input.value = "";
    const back = restoreFocus;
    restoreFocus = null;
    if (back?.isConnected) back.focus();
  }

  function popOrClose(): void {
    if (mode !== "root") setMode("root");
    else close();
  }

  /* ── events ── */

  backdrop.addEventListener("click", (e) => {
    if (e.target === backdrop) close();
  });
  bar.addEventListener("click", (e) => e.stopPropagation());

  onRouted(input, "input", () => {
    // `<letter>+space` as the whole query enters a mode from the root.
    if (mode === "root") {
      const m = /^([ice]) $/.exec(input.value);
      if (m) {
        setMode(MODE_BY_KEY[m[1] as SearchMode]);
        return;
      }
    }
    render();
  });

  // Keyboard isolation (F-056): nothing typed in the palette reaches the
  // page (YouTube's space/k shortcuts, GitHub's slash, …). Our own window
  // listeners are capture-phase and unaffected.
  for (const type of ["keypress", "keyup"] as const) {
    input.addEventListener(type, (e) => e.stopPropagation());
  }

  onRouted<KeyboardEvent>(input, "keydown", (e) => {
    e.stopPropagation();
    // Handled keys stop here: pages listen for Enter/arrows/Escape globally
    // (GitHub, Linear, …) and must never react while the palette is up.
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      e.stopPropagation();
      if (rows.length === 0) return;
      sel = (sel + (e.key === "ArrowDown" ? 1 : rows.length - 1)) % rows.length;
      paintSel();
      return;
    }
    if (e.key === "Enter") {
      e.preventDefault();
      e.stopPropagation();
      if (!e.isTrusted) return;
      if ((e.ctrlKey || e.metaKey) && mode !== "root") {
        const row = dataRows[sel];
        if (row && deps.openFullView) {
          close();
          deps.openFullView(row.interactionId);
        }
        return;
      }
      rows[sel]?.run();
      return;
    }
    if (
      mode !== "root" &&
      e.ctrlKey &&
      !e.metaKey &&
      !e.altKey &&
      !e.shiftKey &&
      e.key >= "1" &&
      e.key <= "9"
    ) {
      // ⌃1–⌃9 opens the nth visible row of a filtered surface directly.
      e.preventDefault();
      e.stopPropagation();
      if (!e.isTrusted) return;
      rows[Number(e.key) - 1]?.run();
      return;
    }
    if (e.key === "a" && mode === "inbox" && input.value === "") {
      const row = dataRows[sel];
      if (row && canAnchor(row) && deps.anchorRow) {
        e.preventDefault();
        e.stopPropagation();
        anchorRow(row);
        return;
      }
    }
    if (e.key === "Tab") {
      // Focus stays in the bar — arrows are the navigation, not tab stops.
      e.preventDefault();
      e.stopPropagation();
      return;
    }
    if (e.key === "Backspace" && input.value === "" && mode !== "root") {
      e.preventDefault();
      e.stopPropagation();
      setMode("root");
    }
  });

  return {
    element: backdrop,
    open,
    close,
    toggle: () => (isOpen() ? close() : open()),
    isOpen,
    mode: () => mode,
    escape: popOrClose,
    ownsFocus: () => app.shadow.activeElement === input,
    refresh: () => {
      if (isOpen()) render();
    },
    // The SW's fresh attention sync lands in storage AFTER the bar opened on
    // the cached snapshot — callers relay that update here so an open queue
    // never shows a stale "nothing needs you".
    refreshAttention,
  };
}
