// The command bar: the one surface for actions and for the Inbox. Built after
// the extension's (overlay/command-bar.ts): a centered palette with modes, not
// windows. Root lists the commands; Inbox lists what was made on this page,
// by state; Kept edits lists each kept edit with its switch. Esc pops a mode,
// then closes; arrows move; Enter runs or opens; Ctrl+1–9 opens the nth row.
import { ageLabel, avatar, clear, el, GLYPHS, type Glyph, icon } from "./dom";
import {
  chipFor,
  type Directory,
  type Item,
  inboxOrder,
  isLive,
  matchesQuery,
  personOf,
  placeLabel,
  summaryOf,
} from "./model";
import {
  ACCEL_LABEL,
  AGENT_WORK_LABEL,
  BAR,
  CHIP_LABEL,
  COMMANDS,
  type CommandId,
  KIND_LABEL,
  THREAD,
} from "./strings";

export type BarMode = "root" | "inbox" | "kept";

const COMMAND_SHAPE: Record<CommandId, { icon: Glyph; cls: string }> = {
  copyBlock: { icon: GLYPHS.copy, cls: "" },
  editBlock: { icon: GLYPHS.change, cls: "k-change" },
  editPage: { icon: GLYPHS.editPage, cls: "k-change" },
  commentBlock: { icon: GLYPHS.comment, cls: "k-comment" },
  commentPage: { icon: GLYPHS.commentPage, cls: "k-comment" },
  inbox: { icon: GLYPHS.inbox, cls: "" },
  keptEdits: { icon: GLYPHS.kept, cls: "" },
  copyForAgent: { icon: GLYPHS.clipboard, cls: "" },
  switchSpace: { icon: GLYPHS.space, cls: "" },
  toggleTheme: { icon: GLYPHS.theme, cls: "" },
  settings: { icon: GLYPHS.settings, cls: "" },
};

const CHIP_CLASS = {
  "needs-you": "chip-needs",
  waiting: "chip-waiting",
  resolved: "chip-resolved",
} as const;

/** Commands for a query: label prefix, then label, then description; registry order within each. */
export function rankCommands<T extends { label: string; description: string }>(
  commands: readonly T[],
  query: string,
): T[] {
  const q = query.trim().toLowerCase();
  if (!q) return [...commands];
  const scored: Array<{ c: T; tier: number }> = [];
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

export interface BarDeps {
  people: Directory;
  now(): number;
  items(): readonly Item[];
  /** Commands this page can run; the rest are listed, marked, and say so. */
  canRun(id: CommandId): boolean;
  run(id: CommandId): void;
  /** A command the page lists and cannot run was chosen. */
  away(): void;
  openItem(id: string): void;
  setKept(id: string, on: boolean): void;
  /** What marks a command the page cannot run. */
  awayChip: string;
  /** Set in the page (a section fragment) instead of floating over it. */
  fixedMode?: BarMode;
  space?: string;
  /** Names this bar's list and options (ids); one per bar on a page. */
  idBase?: string;
  /** The bar opened, closed, changed mode or redrew its list. */
  onState?(): void;
}

export interface CommandBar {
  element: HTMLElement;
  open(mode?: BarMode): void;
  close(): void;
  toggle(): void;
  isOpen(): boolean;
  mode(): BarMode;
  escape(): void;
  refresh(): void;
  /**
   * Where the bar is while it shows an Inbox with nothing in it (the product's
   * "Nothing needs you." and no rows); null otherwise. The Inbox never lists
   * commands, so the page that hosts the demo says where they are.
   */
  emptyInbox(): DOMRect | null;
}

/** One thing the arrows can land on. */
interface Row {
  /** The option itself: what a screen reader hears as the active one. */
  option: HTMLElement;
  /** The row that lights up (the option, or the row an option sits in). */
  row: HTMLElement;
  run(): void;
}

/**
 * The bar is a combobox over a listbox: focus stays in the input, the arrows
 * move the active option, and the input names it (`aria-activedescendant`),
 * so what Enter will run is heard as well as seen.
 */
export function createCommandBar(deps: BarDeps): CommandBar {
  const still = deps.fixedMode !== undefined;
  const base = deps.idBase ?? "onlay-bar";
  const backdrop = el("div", still ? "bar-still" : "bar-backdrop");
  backdrop.hidden = !still;
  const bar = el("div", "command-bar");
  bar.setAttribute("role", still ? "group" : "dialog");
  bar.setAttribute("aria-label", BAR.inputLabel);
  backdrop.appendChild(bar);

  const inputRow = el("div", "bar-input-row");
  inputRow.appendChild(icon(GLYPHS.search, "icon bar-search-icon"));
  const modeChip = el("span", "chip chip-kind bar-mode-chip");
  modeChip.hidden = true;
  const input = el("input", "bar-input");
  input.type = "text";
  input.placeholder = BAR.rootPlaceholder;
  input.setAttribute("aria-label", BAR.inputLabel);
  input.setAttribute("role", "combobox");
  input.setAttribute("aria-expanded", "true");
  input.setAttribute("aria-autocomplete", "list");
  input.setAttribute("aria-controls", `${base}-list`);
  input.autocomplete = "off";
  input.spellcheck = false;
  const spaceChip = el("span", "chip chip-waiting bar-space-chip", deps.space ?? "");
  spaceChip.hidden = !deps.space;
  const hintKey = el("span", "kbd bar-hint", ACCEL_LABEL);
  inputRow.append(modeChip, input, spaceChip, hintKey);
  const list = el("div", "bar-list");
  list.id = `${base}-list`;
  list.setAttribute("role", "listbox");
  list.setAttribute("aria-label", BAR.inputLabel);
  // What a switch was just set to, for a reader who cannot see it flip.
  const said = el("div", "bar-said");
  said.setAttribute("role", "status");
  const footer = el("div", "bar-footer");
  bar.append(inputRow, list, said, footer);

  let mode: BarMode = deps.fixedMode ?? "root";
  let rows: Row[] = [];
  let sel = 0;
  let restoreFocus: HTMLElement | null = null;

  function paintFooter(): void {
    clear(footer);
    const keys =
      mode === "root" ? BAR.footer.root : mode === "kept" ? BAR.footer.kept : BAR.footer.data;
    for (const k of keys) footer.appendChild(el("span", undefined, k));
  }

  function paintSel(scroll = true): void {
    for (const r of rows) r.row.classList.remove("on");
    rows.forEach((r, i) => {
      const on = i === sel;
      if (on) r.row.classList.add("on");
      r.option.setAttribute("aria-selected", String(on));
      r.option.classList.toggle("active", on);
    });
    const active = rows[sel];
    if (active) input.setAttribute("aria-activedescendant", active.option.id);
    else input.removeAttribute("aria-activedescendant");
    if (scroll && !still) active?.row.scrollIntoView?.({ block: "nearest" });
  }

  /** Make `option` one of the things the arrows land on; `row` is what lights up with it. */
  function addOption(option: HTMLElement, run: () => void, row: HTMLElement = option): void {
    const i = rows.length;
    option.id = `${base}-opt-${i}`;
    option.setAttribute("role", "option");
    option.setAttribute("aria-selected", "false");
    option.addEventListener("mouseenter", () => {
      sel = i;
      paintSel(false);
    });
    option.addEventListener("click", (e) => {
      e.stopPropagation();
      run();
    });
    rows.push({ option, row, run });
  }

  function commandRow(c: (typeof COMMANDS)[number]): void {
    const shape = COMMAND_SHAPE[c.id];
    const able = deps.canRun(c.id);
    const node = el("div", `bar-row ${shape.cls}${able ? "" : " away"}`.trim());
    node.appendChild(icon(shape.icon, "icon"));
    node.appendChild(el("span", "label", c.label));
    node.appendChild(el("span", "desc", c.description));
    if (!able) node.appendChild(el("span", "chip chip-waiting", deps.awayChip));
    node.appendChild(el("span", "kbd", c.chord));
    addOption(node, () => (able ? deps.run(c.id) : deps.away()));
    list.appendChild(node);
  }

  function itemRow(item: Item): void {
    const quick = rows.length;
    const cls = item.kind === "comment" ? "k-comment" : "k-change";
    const node = el("div", `bar-row q-row ${cls}`);
    node.appendChild(icon(GLYPHS[item.kind], "icon"));
    const main = el("div", "q-main");
    const top = el("div", "q-top");
    top.appendChild(el("span", "q-text", summaryOf(item) || KIND_LABEL[item.kind]));
    const chip = chipFor(item);
    top.appendChild(el("span", `chip ${CHIP_CLASS[chip]}`, CHIP_LABEL[chip]));
    top.appendChild(el("span", "q-age", ageLabel(item.createdAt, deps.now())));
    if (quick < 9) top.appendChild(el("span", "kbd q-quick", `⌃${quick + 1}`));
    main.appendChild(top);
    const meta = el("div", "q-meta");
    const actor = personOf(deps.people, item.authorId);
    meta.append(avatar(actor, "sm"), el("span", "q-actor", actor.name));
    if (item.space) meta.appendChild(el("span", "q-away", item.space));
    meta.appendChild(el("span", "q-context", placeLabel(item, THREAD.pageLevel)));
    if (item.agentWork) meta.appendChild(el("span", "q-away", AGENT_WORK_LABEL[item.agentWork]));
    main.appendChild(meta);
    node.appendChild(main);
    addOption(node, () => {
      close();
      deps.openItem(item.id);
    });
    list.appendChild(node);
  }

  /**
   * A kept edit is two options in one row: the edit (Enter shows or hides it)
   * and, at its corner, "Open thread", which the arrows reach next.
   */
  function keptRow(item: Item): void {
    const on = item.keptOn !== false;
    const row = el("div", "bar-row q-row kept-row k-change");
    row.setAttribute("role", "presentation");
    const edit = el("div", "kept-main");
    edit.appendChild(icon(GLYPHS.change, "icon"));
    const main = el("div", "q-main");
    const top = el("div", "q-top");
    top.appendChild(el("span", "q-text", summaryOf(item) || KIND_LABEL.change));
    const toggle = el(
      "span",
      `pill-toggle${on ? " on" : ""}`,
      on ? BAR.kept.shown : BAR.kept.hidden,
    );
    toggle.title = on ? BAR.kept.hideTitle : BAR.kept.showTitle;
    top.appendChild(toggle);
    main.appendChild(top);
    const meta = el("div", "q-meta");
    const by = personOf(deps.people, item.authorId);
    meta.append(avatar(by, "sm"), el("span", "q-actor", BAR.kept.keptBy(by.name)));
    main.appendChild(meta);
    edit.appendChild(main);
    addOption(
      edit,
      () => {
        deps.setKept(item.id, !on);
        render();
        said.textContent = on ? BAR.kept.hidden : BAR.kept.shown;
      },
      row,
    );
    const open = el("div", "q-anchor-act", BAR.kept.openThread);
    addOption(
      open,
      () => {
        close();
        deps.openItem(item.id);
      },
      row,
    );
    row.append(edit, open);
    list.appendChild(row);
  }

  function emptyNote(text: string): void {
    const note = el("div", "bar-empty", text);
    note.setAttribute("role", "presentation");
    list.appendChild(note);
  }

  function groupLabel(text: string): void {
    const label = el("div", "micro bar-group", text);
    label.setAttribute("role", "presentation");
    list.appendChild(label);
  }

  function render(): void {
    clear(list);
    rows = [];
    said.textContent = "";
    const query = input.value;
    if (mode === "root") {
      const ranked = rankCommands(COMMANDS, query);
      if (ranked.length === 0) emptyNote(BAR.noCommand);
      for (const c of ranked) commandRow(c);
    } else if (mode === "kept") {
      const kept = deps
        .items()
        .filter((i) => i.state === "kept" && matchesQuery(i, deps.people, query));
      if (kept.length === 0) emptyNote(query.trim() ? BAR.nothingMatches : BAR.modes.kept.empty);
      for (const k of kept) keptRow(k);
    } else {
      const all = inboxOrder(deps.items()).filter((i) => matchesQuery(i, deps.people, query));
      if (all.length === 0) emptyNote(query.trim() ? BAR.nothingMatches : BAR.modes.inbox.empty);
      let group: string | null = null;
      for (const item of all) {
        const g = !isLive(item.state)
          ? BAR.groups.recent
          : item.anchor || !item.space
            ? BAR.groups.onpage
            : BAR.groups.elsewhere;
        if (g !== group) {
          group = g;
          groupLabel(g);
        }
        itemRow(item);
      }
    }
    sel = Math.min(sel, Math.max(0, rows.length - 1));
    paintSel(false);
    deps.onState?.();
  }

  function setMode(next: BarMode): void {
    mode = next;
    if (next === "root") {
      modeChip.hidden = true;
      input.placeholder = BAR.rootPlaceholder;
      list.setAttribute("aria-label", BAR.inputLabel);
    } else {
      const spec = BAR.modes[next];
      modeChip.className = `chip chip-kind bar-mode-chip${next === "kept" ? " k-change" : ""}`;
      modeChip.textContent = spec.label;
      modeChip.hidden = false;
      input.placeholder = spec.placeholder;
      list.setAttribute("aria-label", spec.label);
    }
    input.value = "";
    sel = 0;
    paintFooter();
    render();
  }

  function isOpen(): boolean {
    return !backdrop.hidden;
  }

  function open(start: BarMode = "root"): void {
    if (!isOpen()) {
      const root = backdrop.getRootNode() as Document | ShadowRoot;
      const active = root.activeElement ?? document.activeElement;
      restoreFocus = active instanceof HTMLElement ? active : null;
      backdrop.hidden = false;
    }
    setMode(start);
    input.focus();
  }

  function close(): void {
    if (!isOpen() || still) return;
    backdrop.hidden = true;
    mode = "root";
    input.value = "";
    const back = restoreFocus;
    restoreFocus = null;
    if (back?.isConnected) back.focus({ preventScroll: true });
    deps.onState?.();
  }

  function popOrClose(): void {
    if (still) return;
    if (mode !== "root") setMode("root");
    else close();
  }

  backdrop.addEventListener("click", (e) => {
    if (e.target === backdrop) close();
  });

  input.addEventListener("input", () => {
    // `<letter>+space` as the whole query enters a mode from the root.
    if (mode === "root" && !still && input.value === "i ") {
      setMode("inbox");
      return;
    }
    sel = 0;
    render();
  });

  input.addEventListener("keydown", (e) => {
    // The accelerator still toggles the bar; nothing else typed in the palette reaches the page.
    if (e.ctrlKey && e.key === ".") return;
    e.stopPropagation();
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      if (rows.length === 0) return;
      sel = (sel + (e.key === "ArrowDown" ? 1 : rows.length - 1)) % rows.length;
      paintSel();
      return;
    }
    if (e.key === "Enter") {
      e.preventDefault();
      rows[sel]?.run();
      return;
    }
    if (mode !== "root" && e.ctrlKey && !e.metaKey && !e.altKey && e.key >= "1" && e.key <= "9") {
      e.preventDefault();
      rows[Number(e.key) - 1]?.run();
      return;
    }
    if (still) return;
    if (e.key === "Escape") {
      e.preventDefault();
      popOrClose();
      return;
    }
    if (e.key === "Tab") {
      // Focus stays in the input: the arrows move the active option.
      e.preventDefault();
      return;
    }
    if (e.key === "Backspace" && input.value === "" && mode !== "root") {
      e.preventDefault();
      setMode("root");
    }
  });

  if (still) setMode(deps.fixedMode as BarMode);
  else paintFooter();

  return {
    element: backdrop,
    open,
    close,
    toggle: () => (isOpen() ? close() : open()),
    isOpen,
    mode: () => mode,
    escape: popOrClose,
    refresh: () => {
      if (isOpen()) render();
    },
    emptyInbox: () =>
      isOpen() && mode === "inbox" && rows.length === 0 && input.value.trim() === ""
        ? bar.getBoundingClientRect()
        : null,
  };
}
