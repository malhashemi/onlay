// The space select, one component for the extension's composers and the web
// app's compose screen: a field that names the chosen space, and a menu it
// opens with a search box over the person's spaces (up to 50) as a scrolling
// listbox. The current space is marked; the Personal space keeps its "Just
// you" note. Keyboard: the field opens on a click, Enter, Space, an arrow or
// any letter typed (that letter starts the search); in the menu the arrows
// move, Page Up and Page Down jump, Enter chooses, Escape closes back to the
// field, Tab closes and moves on; while an IME is composing in the search,
// those keys are the IME's. The menu stays inside the viewport: below the
// field when it fits, above it otherwise (its search then sits at the bottom,
// next to the field, so it never moves while the list shrinks), and it keeps
// the side it opened on while a search shrinks the list. It closes when its
// field scrolls out of view, on a press outside it, and when the field leaves
// the document; `placeOpenSpaceMenus` re-places it after the card holding the
// field moved. Its spaces are read anew each time it opens (pass a function),
// and `refresh` closes an open menu when they change under it.
//
// Each client passes its own event plumbing (the overlay routes keys inside
// its shadow root) and its own words. Text reaches the DOM as text nodes only.

export interface SpaceOption {
  id: string;
  name: string;
  /** A quiet note after the name ("Just you" on the Personal space). */
  note?: string;
}

/** A name as the search compares it: case, accents and outer space ignored. */
function searchForm(s: string): string {
  return s
    .normalize("NFKD")
    .replace(/\p{M}+/gu, "")
    .toLowerCase()
    .trim();
}

/**
 * The spaces whose name holds the query, in the person's order within three
 * tiers: the name starts with it, a word in the name does, it is inside a word.
 */
export function filterSpaces<T extends { name: string }>(spaces: readonly T[], query: string): T[] {
  const q = searchForm(query);
  if (!q) return [...spaces];
  const starts: T[] = [];
  const words: T[] = [];
  const inside: T[] = [];
  for (const s of spaces) {
    const n = searchForm(s.name);
    const i = n.indexOf(q);
    if (i < 0) continue;
    if (i === 0) starts.push(s);
    else if (/[\s\-_.·/]/u.test(n.charAt(i - 1))) words.push(s);
    else inside.push(s);
  }
  return [...starts, ...words, ...inside];
}

/** What a key in the menu's search box does. */
export type MenuKeyAction =
  | { kind: "move"; active: number }
  | { kind: "choose"; index: number }
  | { kind: "close" }
  | { kind: "none" };

/** Rows a Page Up or Page Down jumps. */
const PAGE = 8;

/** The menu's keyboard: `active` is the highlighted row of `count`. */
export function menuKey(key: string, active: number, count: number): MenuKeyAction {
  if (key === "Escape") return { kind: "close" };
  if (count === 0) return { kind: "none" };
  const at = Math.min(Math.max(0, active), count - 1);
  switch (key) {
    case "ArrowDown":
      return { kind: "move", active: (at + 1) % count };
    case "ArrowUp":
      return { kind: "move", active: (at - 1 + count) % count };
    case "PageDown":
      return { kind: "move", active: Math.min(count - 1, at + PAGE) };
    case "PageUp":
      return { kind: "move", active: Math.max(0, at - PAGE) };
    case "Enter":
      return { kind: "choose", index: at };
    default:
      return { kind: "none" };
  }
}

export interface MenuPlacement {
  top: number;
  left: number;
  width: number;
  maxHeight: number;
  /** Opens above the field. */
  upward: boolean;
}

/**
 * Where the menu goes for a field at `field`: below it when its natural
 * height fits there or there is more room below than above; above it
 * otherwise, or on the side `upward` names. Always inside the viewport,
 * `margin` clear of each edge (a field partly off screen included).
 */
export function placeMenu(
  field: { top: number; bottom: number; left: number; width: number },
  view: { w: number; h: number },
  natural: number,
  o: { margin: number; gap: number; minWidth: number; upward?: boolean },
): MenuPlacement {
  const below = Math.max(0, view.h - o.margin - field.bottom - o.gap);
  const above = Math.max(0, field.top - o.gap - o.margin);
  const upward = o.upward ?? (below < natural && above > below);
  const maxHeight = Math.floor(Math.min(natural, upward ? above : below));
  const width = Math.max(0, Math.min(Math.max(field.width, o.minWidth), view.w - 2 * o.margin));
  const left = Math.max(o.margin, Math.min(field.left, view.w - o.margin - width));
  const want = upward ? field.top - o.gap - maxHeight : field.bottom + o.gap;
  const top = Math.max(o.margin, Math.min(want, view.h - o.margin - maxHeight));
  return { top: Math.round(top), left: Math.round(left), width, maxHeight, upward };
}

export interface SpaceSelectCopy {
  /** The field's visible label ("Space"). */
  label: string;
  /** The search box's placeholder. */
  search: string;
  /** The search box's accessible name (its placeholder when absent). */
  searchLabel?: string;
  /** The listbox's name. */
  list: string;
  /** Shown when no space matches the search. */
  empty: string;
}

export interface SpaceSelectOpts {
  doc: Document;
  /** The spaces to offer; a function is read each time the menu opens or repaints. */
  spaces: readonly SpaceOption[] | (() => readonly SpaceOption[]);
  value: string;
  copy: SpaceSelectCopy;
  onChange(id: string): void;
  /** Class names for the wrapper and the label, so each client dresses them its own way. */
  classes?: { wrap?: string; label?: string };
  /** Only input the browser made acts (default: `isTrusted`). */
  trusted?(e: Event): boolean;
  /** How key and input listeners are added (the overlay routes them inside its shadow root). */
  listen?(target: EventTarget, type: string, fn: (e: Event) => void): void;
  /** px kept clear of the viewport's edges, and the menu's least width. */
  metrics?(): { margin: number; gap: number; minWidth: number };
  /** While true the field does not open (a posted Comment's space is fixed). */
  locked?(): boolean;
}

export interface SpaceSelect {
  /** The labelled field with its menu. */
  element: HTMLElement;
  value(): string;
  isOpen(): boolean;
  /** Open the menu, its search holding `query`. */
  open(query?: string): void;
  /** Close the menu; with `focusField`, give the field the focus back. */
  close(focusField?: boolean): void;
  /**
   * The spaces changed (a membership or account change): an open menu closes,
   * its field taking the focus back, and the field and list are painted anew.
   */
  refresh(): void;
}

interface OpenMenu {
  close(focusField: boolean): boolean;
  shown(): boolean;
  place(): void;
}

/** Every open menu, so an Escape caught before the menu sees it can close the menu alone. */
const openMenus = new Set<OpenMenu>();

/**
 * Close every open space menu, its field taking the focus back unless
 * `focusField` is false. True if one was on screen (a menu whose card went
 * away is closed without counting).
 */
export function closeOpenSpaceMenus(focusField = true): boolean {
  let any = false;
  for (const m of [...openMenus]) {
    const shown = m.shown();
    if (m.close(focusField) && shown) any = true;
  }
  return any;
}

/** Close, without moving the focus, every open menu whose field left the document. */
export function closeDetachedSpaceMenus(): void {
  for (const m of [...openMenus]) if (!m.shown()) m.close(false);
}

/** Re-place every open menu against its field (the card holding it has finished moving). */
export function placeOpenSpaceMenus(): void {
  for (const m of [...openMenus]) m.place();
}

/** The node that holds `n` for clipping: its parent, or the host of the shadow root it is in. */
function holderOf(n: Node): Element | null {
  if (n.parentElement) return n.parentElement;
  const root = n.parentNode as (Node & { host?: Element }) | null;
  return root?.host ?? null;
}

/**
 * Any part of `node` the person can see: inside the viewport and inside every
 * ancestor that clips its overflow (across shadow roots).
 */
function inView(node: Element, win: Window): boolean {
  const r = node.getBoundingClientRect();
  let top = Math.max(r.top, 0);
  let bottom = Math.min(r.bottom, win.innerHeight);
  let left = Math.max(r.left, 0);
  let right = Math.min(r.right, win.innerWidth);
  for (let n = holderOf(node); n && bottom > top && right > left; n = holderOf(n)) {
    const st = win.getComputedStyle(n);
    const clips = (v: string): boolean => v !== "" && v !== "visible";
    if (!clips(st.overflowX) && !clips(st.overflowY)) continue;
    const c = n.getBoundingClientRect();
    top = Math.max(top, c.top);
    bottom = Math.min(bottom, c.bottom);
    left = Math.max(left, c.left);
    right = Math.min(right, c.right);
  }
  return bottom > top && right > left;
}

/** A key that belongs to an IME composing in the field, not to the menu. */
function composing(e: KeyboardEvent): boolean {
  return e.isComposing === true || e.keyCode === 229;
}

const SVG_NS = "http://www.w3.org/2000/svg";

function glyph(doc: Document, cls: string, paths: string[]): SVGSVGElement {
  const svg = doc.createElementNS(SVG_NS, "svg");
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("fill", "none");
  svg.setAttribute("stroke", "currentColor");
  svg.setAttribute("stroke-width", "2");
  svg.setAttribute("stroke-linecap", "round");
  svg.setAttribute("stroke-linejoin", "round");
  svg.setAttribute("aria-hidden", "true");
  svg.setAttribute("class", cls);
  for (const d of paths) {
    const p = doc.createElementNS(SVG_NS, "path");
    p.setAttribute("d", d);
    svg.appendChild(p);
  }
  return svg;
}

let ids = 0;

export function spaceSelect(o: SpaceSelectOpts): SpaceSelect {
  const doc = o.doc;
  const win = doc.defaultView;
  const trusted = o.trusted ?? ((e: Event) => e.isTrusted === true);
  const listen =
    o.listen ??
    ((t: EventTarget, type: string, fn: (e: Event) => void) => t.addEventListener(type, fn));
  const metrics = o.metrics ?? (() => ({ margin: 8, gap: 4, minWidth: 220 }));
  const id = `onlay-space-${++ids}`;
  const spacesNow = (): readonly SpaceOption[] =>
    typeof o.spaces === "function" ? o.spaces() : o.spaces;
  let value = o.value;
  /** The chosen space as last seen: a space gone since still names itself in the field. */
  let valueOption: SpaceOption | undefined;
  let shown: SpaceOption[] = [];
  let active = 0;
  /** The side the open menu opened on, kept while a search shrinks the list. */
  let upward: boolean | null = null;

  const make = <K extends keyof HTMLElementTagNameMap>(
    tag: K,
    cls: string,
    text?: string,
  ): HTMLElementTagNameMap[K] => {
    const n = doc.createElement(tag);
    n.className = cls;
    if (text !== undefined) n.textContent = text;
    return n;
  };

  const wrap = make("div", `space-select ${o.classes?.wrap ?? ""}`.trim());
  const label = make("span", o.classes?.label ?? "space-select-label", o.copy.label);
  label.id = `${id}-label`;
  const field = make("button", "space-select-field");
  field.type = "button";
  field.setAttribute("aria-haspopup", "listbox");
  field.setAttribute("aria-expanded", "false");
  field.setAttribute("aria-controls", `${id}-list`);
  const fieldName = make("span", "space-select-value");
  fieldName.id = `${id}-value`;
  field.setAttribute("aria-labelledby", `${label.id} ${fieldName.id}`);
  const fieldNote = make("span", "space-select-note");
  field.append(fieldName, fieldNote, glyph(doc, "space-select-chevron", ["m6 9 6 6 6-6"]));

  const menu = make("div", "space-select-menu");
  menu.style.display = "none";
  const search = make("input", "space-select-search");
  search.type = "text";
  search.autocomplete = "off";
  search.spellcheck = false;
  search.placeholder = o.copy.search;
  search.setAttribute("aria-label", o.copy.searchLabel ?? o.copy.search);
  search.setAttribute("role", "combobox");
  search.setAttribute("aria-autocomplete", "list");
  search.setAttribute("aria-expanded", "true");
  search.setAttribute("aria-controls", `${id}-list`);
  const list = make("div", "space-select-list");
  list.id = `${id}-list`;
  list.setAttribute("role", "listbox");
  list.setAttribute("aria-label", o.copy.list);
  const empty = make("div", "space-select-empty");
  empty.setAttribute("role", "status");
  menu.append(search, list, empty);
  wrap.append(label, field, menu);

  const spaceOf = (sid: string): SpaceOption | undefined => spacesNow().find((s) => s.id === sid);

  function paintField(): void {
    const found = spaceOf(value);
    if (found) valueOption = found;
    const s = found ?? (valueOption?.id === value ? valueOption : undefined);
    fieldName.textContent = s?.name ?? "";
    fieldNote.textContent = s?.note ?? "";
    fieldNote.style.display = s?.note ? "" : "none";
  }

  function paintActive(scroll: boolean): void {
    const rows = list.children;
    for (let i = 0; i < rows.length; i++) {
      const row = rows[i] as HTMLElement;
      const on = i === active;
      row.classList.toggle("on", on);
      row.setAttribute("aria-selected", on ? "true" : "false");
      if (on && scroll) {
        // Inside the list only: the page never scrolls for it.
        if (row.offsetTop < list.scrollTop) list.scrollTop = row.offsetTop;
        else if (row.offsetTop + row.offsetHeight > list.scrollTop + list.clientHeight)
          list.scrollTop = row.offsetTop + row.offsetHeight - list.clientHeight;
      }
    }
    const row = rows[active] as HTMLElement | undefined;
    if (row) search.setAttribute("aria-activedescendant", row.id);
    else search.removeAttribute("aria-activedescendant");
  }

  function paintList(): void {
    while (list.firstChild) list.removeChild(list.firstChild);
    shown = filterSpaces(spacesNow(), search.value);
    shown.forEach((s, i) => {
      const row = make("div", `space-select-option${s.id === value ? " current" : ""}`);
      row.id = `${id}-opt-${i}`;
      row.setAttribute("role", "option");
      row.append(make("span", "space-select-name", s.name));
      if (s.note) row.append(make("span", "space-select-note", s.note));
      if (s.id === value) row.append(glyph(doc, "space-select-check", ["M20 6 9 17l-5-5"]));
      row.addEventListener("pointermove", () => {
        if (active === i) return;
        active = i;
        paintActive(false);
      });
      row.addEventListener("click", (e) => {
        if (!trusted(e)) return;
        choose(i);
      });
      list.appendChild(row);
    });
    empty.textContent = shown.length === 0 ? o.copy.empty : "";
    empty.style.display = shown.length === 0 ? "" : "none";
    active = Math.min(active, Math.max(0, shown.length - 1));
    paintActive(true);
  }

  /**
   * Place the open menu by its field: `keepSide` holds the side it opened on;
   * `seen` first checks the field is still in view (after a scroll or a move),
   * and closes the menu when it is not, or when the field left the document.
   */
  function place(keepSide = false, seen = false): void {
    if (!win || !isOpen()) return;
    if (!wrap.isConnected) {
      close(false);
      return;
    }
    if (seen && !inView(field, win)) {
      close(true);
      return;
    }
    const m = metrics();
    const r = field.getBoundingClientRect();
    menu.style.maxHeight = "none";
    menu.style.left = "0px";
    menu.style.top = "0px";
    // A transformed ancestor re-bases fixed positioning onto itself: park the
    // menu at its containing block's origin, see where that lands, and offset.
    const origin = menu.getBoundingClientRect();
    const p = placeMenu(
      { top: r.top, bottom: r.bottom, left: r.left, width: r.width },
      { w: win.innerWidth, h: win.innerHeight },
      origin.height,
      keepSide && upward !== null ? { ...m, upward } : m,
    );
    upward = p.upward;
    menu.classList.toggle("up", p.upward);
    menu.style.width = `${p.width}px`;
    menu.style.maxHeight = `${p.maxHeight}px`;
    menu.style.left = `${p.left - origin.left}px`;
    menu.style.top = `${p.top - origin.top}px`;
  }

  const onViewChange = (e: Event): void => {
    const t = e.target as Node | null;
    if (e.type === "scroll" && typeof t?.nodeType === "number" && menu.contains(t)) return;
    place(false, e.type === "scroll");
  };

  /**
   * A press anywhere but the field and its menu closes the menu. Heard on the
   * document and, when the field is in a shadow root, on that root: from the
   * document a press inside the root shows only its host, so the root decides.
   */
  const onPress = (e: Event): void => {
    if (!trusted(e)) return;
    const path = e.composedPath();
    if (path.includes(wrap)) return;
    const root = wrap.getRootNode() as Node & { host?: Element };
    if (root.host && e.currentTarget !== root && path.includes(root.host)) return;
    close(false);
  };
  const pressTargets = (): EventTarget[] => {
    const root = wrap.getRootNode() as Node & { host?: Element };
    return root.host ? [doc, root] : [doc];
  };
  let pressHeard: EventTarget[] = [];

  function isOpen(): boolean {
    return menu.style.display !== "none";
  }
  const entry: OpenMenu = {
    close: (f) => close(f),
    shown: () => wrap.isConnected,
    place: () => place(false, true),
  };

  function close(focusField = false): boolean {
    if (!isOpen()) return false;
    menu.style.display = "none";
    field.setAttribute("aria-expanded", "false");
    openMenus.delete(entry);
    upward = null;
    win?.removeEventListener("resize", onViewChange);
    win?.removeEventListener("scroll", onViewChange, { capture: true });
    for (const t of pressHeard) t.removeEventListener("pointerdown", onPress, { capture: true });
    pressHeard = [];
    if (focusField && field.isConnected) field.focus({ preventScroll: true });
    return true;
  }

  function open(query = ""): void {
    if (o.locked?.()) return;
    search.value = query;
    menu.style.display = "flex";
    field.setAttribute("aria-expanded", "true");
    active = Math.max(
      0,
      filterSpaces(spacesNow(), query).findIndex((s) => s.id === value),
    );
    paintField();
    paintList();
    openMenus.add(entry);
    place();
    paintActive(true);
    win?.addEventListener("resize", onViewChange);
    win?.addEventListener("scroll", onViewChange, { capture: true, passive: true });
    pressHeard = pressTargets();
    for (const t of pressHeard) t.addEventListener("pointerdown", onPress, { capture: true });
    search.focus();
    const end = search.value.length;
    search.setSelectionRange(end, end);
  }

  function choose(i: number): void {
    const s = shown[i];
    if (!s) return;
    // Locked since it opened (a Comment posted from its card): the choice changes nothing.
    if (o.locked?.()) {
      close(true);
      return;
    }
    const changed = s.id !== value;
    value = s.id;
    paintField();
    close(true);
    if (changed) o.onChange(s.id);
  }

  field.addEventListener("click", (e) => {
    if (!trusted(e)) return;
    if (isOpen()) close(true);
    else open();
  });
  listen(field, "keydown", (ev) => {
    const e = ev as KeyboardEvent;
    if (!trusted(e) || e.ctrlKey || e.metaKey || e.altKey || isOpen() || composing(e)) return;
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      open();
    } else if (e.key.length === 1 && e.key !== " ") {
      // Type-ahead: the letter starts the search.
      e.preventDefault();
      open(e.key);
    }
  });
  listen(search, "input", () => {
    active = 0;
    paintList();
    place(true);
  });
  listen(search, "keydown", (ev) => {
    const e = ev as KeyboardEvent;
    if (!trusted(e) || composing(e)) return;
    if (e.key === "Tab") {
      close(false);
      return;
    }
    const a = menuKey(e.key, active, shown.length);
    if (a.kind === "none") return;
    e.preventDefault();
    e.stopPropagation();
    if (a.kind === "close") close(true);
    else if (a.kind === "choose") choose(a.index);
    else {
      active = a.active;
      paintActive(true);
    }
  });
  // A press in the menu keeps the focus in the search (its scrollbar too).
  menu.addEventListener("mousedown", (e) => {
    if (e.target !== search) e.preventDefault();
  });
  wrap.addEventListener("focusout", (e) => {
    const next = (e as FocusEvent).relatedTarget;
    if (next instanceof Node && wrap.contains(next)) return;
    close(false);
  });

  paintField();
  // The listbox the field controls exists from the start (hidden until opened).
  paintList();
  return {
    element: wrap,
    value: () => value,
    isOpen,
    open,
    close: (focusField = false) => {
      close(focusField);
    },
    refresh() {
      // Focus in the menu goes back to the field (in a shadow root the
      // document sees only the host as active, so ask the root).
      const root = wrap.getRootNode() as Node & { activeElement?: Element | null };
      const active = root.activeElement ?? null;
      close(active !== null && menu.contains(active));
      paintField();
      paintList();
    },
  };
}

/**
 * The component's look, from the design tokens both clients define. Sizes are
 * the overlay's (its sheet multiplies px by the overlay zoom); the web app
 * sets its own touch sizes over these.
 */
export const SPACE_SELECT_CSS = `
.space-select { display: flex; flex-direction: column; gap: 4px; min-width: 0; }
.space-select-field {
  display: flex; align-items: center; gap: 8px; width: 100%; min-width: 0;
  padding: 6px 8px; cursor: pointer; text-align: left;
  font: inherit; color: var(--foreground);
  background: color-mix(in oklch, var(--input) 46%, var(--card));
  border: 1px solid var(--border); border-radius: var(--radius-sm);
}
.space-select-field:hover { border-color: color-mix(in oklch, var(--ring) 35%, var(--border)); }
.space-select-field:focus-visible { outline: none; box-shadow: var(--ring-focus); }
.space-select-field[aria-expanded="true"] { border-color: color-mix(in oklch, var(--ring) 55%, var(--border)); box-shadow: var(--ring-hairline); }
.space-select-value { flex: 0 1 auto; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.space-select-note { flex: none; color: var(--muted-foreground); font-size: 0.85em; white-space: nowrap; }
.space-select-chevron { width: 14px; height: 14px; flex: none; margin-left: auto; color: var(--muted-foreground); }
.space-select-menu {
  position: fixed; z-index: 2147483647; display: flex; flex-direction: column;
  min-height: 0; overflow: hidden;
  background: var(--popover); color: var(--popover-foreground);
  border: 1px solid var(--border); border-radius: var(--radius); box-shadow: var(--shadow);
}
.space-select-menu.up { flex-direction: column-reverse; }
.space-select-search {
  flex: none; width: 100%; margin: 0; padding: 8px 10px;
  font: inherit; color: var(--foreground); background: transparent;
  border: 0; border-bottom: 1px solid var(--border); border-radius: 0; outline: none;
}
.space-select-menu.up .space-select-search { border-bottom: 0; border-top: 1px solid var(--border); }
.space-select-search::placeholder { color: var(--muted-foreground); }
.space-select-list {
  position: relative; flex: 0 1 auto; min-height: 0; max-height: 264px; overflow-y: auto;
  padding: 4px; display: flex; flex-direction: column; gap: 2px;
}
.space-select-option {
  display: flex; align-items: center; gap: 8px; padding: 6px 8px; min-height: 28px;
  border-radius: var(--radius-sm); cursor: pointer; flex: none;
}
.space-select-option.on { background: var(--input); }
.space-select-name { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.space-select-option.current .space-select-name { font-weight: var(--weight-semibold); }
.space-select-check { width: 14px; height: 14px; flex: none; margin-left: auto; color: var(--primary); }
.space-select-option .space-select-note + .space-select-check { margin-left: 0; }
.space-select-option .space-select-note { margin-left: auto; }
.space-select-empty { padding: 12px 10px; color: var(--muted-foreground); text-align: center; }
`;
