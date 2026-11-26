// The space select: search by name, the keyboard model, a menu that stays on
// screen (upward when there's no room below), and a field a screen reader can
// name and operate.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Window } from "happy-dom";
import {
  closeOpenSpaceMenus,
  filterSpaces,
  menuKey,
  placeMenu,
  placeOpenSpaceMenus,
  type SpaceOption,
  spaceSelect,
} from "./space-select";

const many = (n: number): SpaceOption[] => [
  { id: "p", name: "Personal", note: "Just you" },
  ...Array.from({ length: n - 1 }, (_, i) => ({ id: `w${i + 1}`, name: `Workspace ${i + 1}` })),
];

describe("filterSpaces", () => {
  const spaces = [
    { name: "Personal" },
    { name: "atlas42" },
    { name: "tech42" },
    { name: "Design team" },
    { name: "Café crew" },
    { name: "hardware-lab" },
  ];
  test("an empty query keeps every space in order", () => {
    expect(filterSpaces(spaces, "  ")).toEqual(spaces);
  });
  test("case and accents are ignored", () => {
    expect(filterSpaces(spaces, "CAFE").map((s) => s.name)).toEqual(["Café crew"]);
  });
  test("names that start with the query come first, then word starts, then the rest", () => {
    expect(filterSpaces(spaces, "te").map((s) => s.name)).toEqual(["tech42", "Design team"]);
    expect(filterSpaces(spaces, "a").map((s) => s.name)).toEqual([
      "atlas42",
      "Personal",
      "Design team",
      "Café crew",
      "hardware-lab",
    ]);
    expect(filterSpaces(spaces, "lab").map((s) => s.name)).toEqual(["hardware-lab"]);
  });
  test("nothing matches: nothing", () => {
    expect(filterSpaces(spaces, "zzz")).toEqual([]);
  });
});

describe("menuKey", () => {
  test("arrows wrap, pages jump and stop at the ends", () => {
    expect(menuKey("ArrowDown", 0, 3)).toEqual({ kind: "move", active: 1 });
    expect(menuKey("ArrowDown", 2, 3)).toEqual({ kind: "move", active: 0 });
    expect(menuKey("ArrowUp", 0, 3)).toEqual({ kind: "move", active: 2 });
    expect(menuKey("PageDown", 45, 50)).toEqual({ kind: "move", active: 49 });
    expect(menuKey("PageUp", 3, 50)).toEqual({ kind: "move", active: 0 });
  });
  test("Enter chooses the active row, Escape closes, other keys are the search's", () => {
    expect(menuKey("Enter", 4, 10)).toEqual({ kind: "choose", index: 4 });
    expect(menuKey("Escape", 0, 0)).toEqual({ kind: "close" });
    expect(menuKey("Enter", 0, 0)).toEqual({ kind: "none" });
    expect(menuKey("a", 0, 3)).toEqual({ kind: "none" });
    expect(menuKey("Home", 2, 3)).toEqual({ kind: "none" });
  });
});

describe("placeMenu", () => {
  const view = { w: 1000, h: 800 };
  const o = { margin: 8, gap: 4, minWidth: 220 };
  test("below the field when it fits", () => {
    const p = placeMenu({ top: 100, bottom: 130, left: 50, width: 300 }, view, 300, o);
    expect(p).toEqual({ top: 134, left: 50, width: 300, maxHeight: 300, upward: false });
  });
  test("above the field when there's no room below and more above", () => {
    const p = placeMenu({ top: 700, bottom: 730, left: 50, width: 300 }, view, 300, o);
    expect(p).toMatchObject({ upward: true, maxHeight: 300, top: 396 });
  });
  test("capped to the larger side's room, so it never leaves the viewport", () => {
    const p = placeMenu(
      { top: 150, bottom: 180, left: 50, width: 300 },
      { w: 1000, h: 420 },
      400,
      o,
    );
    expect(p.upward).toBe(false);
    expect(p.maxHeight).toBe(420 - 8 - 180 - 4);
    const up = placeMenu(
      { top: 300, bottom: 330, left: 50, width: 300 },
      { w: 1000, h: 420 },
      400,
      o,
    );
    expect(up.upward).toBe(true);
    expect(up.top).toBe(8);
    expect(up.maxHeight).toBe(300 - 4 - 8);
  });
  test("a side it is told to keep holds, and a field partly off screen never puts it there", () => {
    // The list shrank during a search: it would now fit below, but stays above.
    const kept = placeMenu({ top: 700, bottom: 730, left: 50, width: 300 }, view, 60, {
      ...o,
      upward: true,
    });
    expect(kept).toMatchObject({ upward: true, maxHeight: 60, top: 636 });
    // A field scrolled partly above the viewport: the menu is not at a negative top.
    const high = placeMenu({ top: -20, bottom: 10, left: 50, width: 300 }, view, 300, {
      ...o,
      upward: true,
    });
    expect(high.top).toBeGreaterThanOrEqual(8);
  });
  test("at least its least width, inside the viewport's sides", () => {
    const p = placeMenu({ top: 10, bottom: 40, left: 900, width: 90 }, view, 200, o);
    expect(p.width).toBe(220);
    expect(p.left).toBe(1000 - 8 - 220);
    const narrow = placeMenu(
      { top: 10, bottom: 40, left: 0, width: 400 },
      { w: 300, h: 800 },
      200,
      o,
    );
    expect(narrow).toMatchObject({ width: 284, left: 8 });
  });
});

describe("spaceSelect", () => {
  let win: Window | null = null;
  beforeEach(() => {
    win = new Window({ url: "http://127.0.0.1:8123/", width: 1000, height: 800 });
  });
  afterEach(() => {
    closeOpenSpaceMenus();
    win?.happyDOM.cancelAsync();
    win?.close();
    win = null;
  });

  const copy = {
    label: "Space",
    search: "Search spaces…",
    list: "Spaces",
    empty: "No matching spaces.",
  };

  function setup(
    spaces: SpaceOption[] | (() => SpaceOption[]) = many(50),
    value = "p",
    extra: { locked?: () => boolean } = {},
  ) {
    const W = win as Window;
    const doc = W.document as unknown as Document;
    const changes: string[] = [];
    const s = spaceSelect({
      doc,
      spaces,
      value,
      copy,
      onChange: (id) => changes.push(id),
      // happy-dom marks every dispatched event untrusted; the gate itself is tested below.
      trusted: () => true,
      ...extra,
    });
    doc.body.append(s.element);
    const field = s.element.querySelector(".space-select-field") as HTMLButtonElement;
    const search = s.element.querySelector(".space-select-search") as HTMLInputElement;
    const list = s.element.querySelector("[role=listbox]") as HTMLElement;
    const key = (target: Element, k: string) =>
      target.dispatchEvent(
        new W.KeyboardEvent("keydown", {
          key: k,
          bubbles: true,
          cancelable: true,
        }) as unknown as Event,
      );
    const type = (text: string) => {
      search.value = text;
      search.dispatchEvent(new W.Event("input", { bubbles: true }) as unknown as Event);
    };
    const options = () => [...list.querySelectorAll("[role=option]")] as HTMLElement[];
    return { s, doc, field, search, list, key, type, options, changes };
  }

  test("the field names the chosen space, with the Personal space's note", () => {
    const t = setup();
    expect(t.field.textContent).toBe("PersonalJust you");
    expect(t.field.getAttribute("aria-haspopup")).toBe("listbox");
    expect(t.field.getAttribute("aria-expanded")).toBe("false");
    const [labelId, valueId] = (t.field.getAttribute("aria-labelledby") ?? "").split(" ");
    expect(t.doc.getElementById(labelId as string)?.textContent).toBe("Space");
    expect(t.doc.getElementById(valueId as string)?.textContent).toBe("Personal");
  });

  test("opening lists every space, the current one marked and active, focus in the search", () => {
    const t = setup(many(50), "w7");
    t.s.open();
    expect(t.field.getAttribute("aria-expanded")).toBe("true");
    expect(t.options()).toHaveLength(50);
    const current = t.list.querySelector(".current") as HTMLElement;
    expect(current.textContent).toBe("Workspace 7");
    expect(current.getAttribute("aria-selected")).toBe("true");
    expect(t.search.getAttribute("aria-activedescendant")).toBe(current.id);
    expect(t.search.getAttribute("role")).toBe("combobox");
    expect(t.search.getAttribute("aria-controls")).toBe(t.list.id);
    expect(t.doc.activeElement).toBe(t.search);
  });

  test("typing filters as you type; Enter chooses; the field and onChange follow", () => {
    const t = setup();
    t.s.open();
    t.type("space 4");
    expect(t.options().map((o) => o.textContent)).toEqual([
      "Workspace 4",
      "Workspace 40",
      "Workspace 41",
      "Workspace 42",
      "Workspace 43",
      "Workspace 44",
      "Workspace 45",
      "Workspace 46",
      "Workspace 47",
      "Workspace 48",
      "Workspace 49",
    ]);
    t.key(t.search, "ArrowDown");
    t.key(t.search, "Enter");
    expect(t.changes).toEqual(["w40"]);
    expect(t.s.isOpen()).toBe(false);
    expect(t.field.textContent).toBe("Workspace 40");
    expect(t.doc.activeElement).toBe(t.field);
  });

  test("no match says so and Enter does nothing", () => {
    const t = setup();
    t.s.open();
    t.type("nothing like it");
    expect(t.options()).toHaveLength(0);
    const empty = t.s.element.querySelector(".space-select-empty") as HTMLElement;
    expect(empty.textContent).toBe("No matching spaces.");
    t.key(t.search, "Enter");
    expect(t.changes).toEqual([]);
    expect(t.s.isOpen()).toBe(true);
  });

  test("Escape closes back to the field without a change; choosing the current space changes nothing", () => {
    const t = setup();
    t.s.open();
    t.key(t.search, "Escape");
    expect(t.s.isOpen()).toBe(false);
    expect(t.doc.activeElement).toBe(t.field);
    t.s.open();
    t.key(t.search, "Enter");
    expect(t.changes).toEqual([]);
  });

  test("a letter typed on the field opens the menu with the search started", () => {
    const t = setup();
    t.field.focus();
    t.key(t.field, "w");
    expect(t.s.isOpen()).toBe(true);
    expect(t.search.value).toBe("w");
    expect(t.options()).toHaveLength(49);
  });

  test("an arrow on the field opens it; a click on an option chooses it", () => {
    const t = setup(many(3));
    t.key(t.field, "ArrowDown");
    expect(t.s.isOpen()).toBe(true);
    (t.options()[2] as HTMLElement).click();
    expect(t.changes).toEqual(["w2"]);
  });

  test("an untrusted click does nothing", () => {
    const W = win as Window;
    const doc = W.document as unknown as Document;
    const s = spaceSelect({
      doc,
      spaces: many(3),
      value: "p",
      copy,
      onChange: () => {},
      trusted: () => false,
    });
    doc.body.append(s.element);
    (s.element.querySelector(".space-select-field") as HTMLElement).click();
    expect(s.isOpen()).toBe(false);
  });

  test("a locked field does not open", () => {
    const W = win as Window;
    const doc = W.document as unknown as Document;
    const s = spaceSelect({
      doc,
      spaces: many(3),
      value: "p",
      copy,
      onChange: () => {},
      locked: () => true,
    });
    doc.body.append(s.element);
    s.open();
    expect(s.isOpen()).toBe(false);
  });

  test("closeOpenSpaceMenus closes an open menu and says so; one whose card went away does not count", () => {
    const t = setup();
    expect(closeOpenSpaceMenus()).toBe(false);
    t.s.open();
    expect(closeOpenSpaceMenus()).toBe(true);
    expect(t.s.isOpen()).toBe(false);
    t.s.open();
    t.s.element.remove();
    expect(closeOpenSpaceMenus()).toBe(false);
    expect(t.s.isOpen()).toBe(false);
  });

  test("while an IME is composing in the search, Enter, the arrows and Escape are the IME's", () => {
    const t = setup(many(5));
    t.s.open();
    const W = win as Window;
    const ime = (k: string) => {
      const e = new W.KeyboardEvent("keydown", {
        key: k,
        isComposing: true,
        bubbles: true,
        cancelable: true,
      }) as unknown as Event;
      t.search.dispatchEvent(e);
      return e.defaultPrevented;
    };
    for (const k of ["ArrowDown", "ArrowUp", "Enter", "Escape"]) expect(ime(k)).toBe(false);
    expect(t.s.isOpen()).toBe(true);
    expect(t.changes).toEqual([]);
    expect(t.list.querySelector(".on")?.textContent).toBe("PersonalJust you");
    // The composition over, the same keys are the menu's again.
    t.key(t.search, "ArrowDown");
    t.key(t.search, "Enter");
    expect(t.changes).toEqual(["w1"]);
  });

  test("a menu whose field scrolls out of view closes; one still in view follows it", () => {
    const t = setup(many(5));
    let top = 100;
    t.field.getBoundingClientRect = () =>
      ({ top, bottom: top + 30, left: 50, right: 350, width: 300, height: 30 }) as DOMRect;
    t.s.open();
    const W = win as Window;
    const scroll = () => W.dispatchEvent(new W.Event("scroll"));
    top = 60;
    scroll();
    expect(t.s.isOpen()).toBe(true);
    top = -40;
    scroll();
    expect(t.s.isOpen()).toBe(false);
    expect(t.doc.activeElement).toBe(t.field);
  });

  test("a menu whose card moves is re-placed by its field, or closes once the field is gone", () => {
    const t = setup(many(5));
    let top = 100;
    t.field.getBoundingClientRect = () =>
      ({ top, bottom: top + 30, left: 50, right: 350, width: 300, height: 30 }) as DOMRect;
    t.s.open();
    const menu = t.s.element.querySelector(".space-select-menu") as HTMLElement;
    expect(menu.style.top).toBe("134px");
    top = 300;
    placeOpenSpaceMenus();
    expect(menu.style.top).toBe("334px");
    t.s.element.remove();
    placeOpenSpaceMenus();
    expect(t.s.isOpen()).toBe(false);
  });

  test("a press outside the field and its menu closes the menu; one inside keeps it", () => {
    const t = setup(many(5));
    const W = win as Window;
    const press = (target: Element) =>
      target.dispatchEvent(
        new W.PointerEvent("pointerdown", { bubbles: true, composed: true }) as unknown as Event,
      );
    t.s.open();
    press(t.search);
    press(t.options()[1] as HTMLElement);
    expect(t.s.isOpen()).toBe(true);
    const elsewhere = t.doc.createElement("div");
    t.doc.body.append(elsewhere);
    press(elsewhere);
    expect(t.s.isOpen()).toBe(false);
  });

  test("in a shadow root, a press elsewhere in the root or on the page closes it; one in the menu does not", () => {
    const W = win as Window;
    const doc = W.document as unknown as Document;
    const host = doc.createElement("div");
    doc.body.append(host);
    const root = host.attachShadow({ mode: "open" });
    const s = spaceSelect({
      doc,
      spaces: many(5),
      value: "p",
      copy,
      onChange: () => {},
      trusted: () => true,
    });
    const other = doc.createElement("button");
    root.append(s.element, other);
    const press = (target: Element) =>
      target.dispatchEvent(
        new W.PointerEvent("pointerdown", { bubbles: true, composed: true }) as unknown as Event,
      );
    s.open();
    press(s.element.querySelector(".space-select-search") as HTMLElement);
    expect(s.isOpen()).toBe(true);
    press(other);
    expect(s.isOpen()).toBe(false);
    s.open();
    press(doc.body);
    expect(s.isOpen()).toBe(false);
  });

  test("its spaces are read when it opens, and a change closes an open menu and repaints", () => {
    let spaces = many(4);
    const t = setup(() => spaces, "w3");
    t.s.open();
    expect(t.options()).toHaveLength(4);
    // Access to Workspace 3 is gone: the menu closes, its field takes the focus.
    spaces = many(3);
    t.s.refresh();
    expect(t.s.isOpen()).toBe(false);
    expect(t.doc.activeElement).toBe(t.field);
    // The field still names what was chosen, so its card can say what happened.
    expect(t.field.textContent).toBe("Workspace 3");
    t.s.open();
    expect(t.options().map((o) => o.textContent)).toEqual([
      "PersonalJust you",
      "Workspace 1",
      "Workspace 2",
    ]);
  });

  test("a choice made after the field locked changes nothing", () => {
    let locked = false;
    const t = setup(many(5), "p", { locked: () => locked });
    t.s.open();
    locked = true;
    t.key(t.search, "ArrowDown");
    t.key(t.search, "Enter");
    expect(t.changes).toEqual([]);
    expect(t.s.value()).toBe("p");
    expect(t.field.textContent).toBe("PersonalJust you");
    expect(t.s.isOpen()).toBe(false);
  });

  test("keys and input go through the client's own listener plumbing", () => {
    const W = win as Window;
    const doc = W.document as unknown as Document;
    const seen: string[] = [];
    const s = spaceSelect({
      doc,
      spaces: many(3),
      value: "p",
      copy,
      onChange: () => {},
      listen: (t, type, fn) => {
        seen.push(`${(t as HTMLElement).className}:${type}`);
        t.addEventListener(type, fn);
      },
    });
    expect(seen).toEqual([
      "space-select-field:keydown",
      "space-select-search:input",
      "space-select-search:keydown",
    ]);
    expect(s.value()).toBe("p");
  });
});
