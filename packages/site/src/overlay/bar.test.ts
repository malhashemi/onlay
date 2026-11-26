// The command bar as the product has it: the launcher's Inbox lists what was
// made and nothing else, an empty one says so and offers no commands, and Esc
// goes back to the root, where the commands are.
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { Window } from "happy-dom";
import { type CommandBar, createCommandBar } from "./bar";
import { useDocument } from "./dom";
import type { Item } from "./model";
import { BAR, COMMANDS } from "./strings";

const g = globalThis as unknown as Record<string, unknown>;
const saved: Record<string, unknown> = {};
let win: Window;
beforeAll(() => {
  win = new Window({ url: "https://onlay.dev/" });
  for (const name of ["document", "HTMLElement"]) saved[name] = g[name];
  g.document = win.document;
  g.HTMLElement = win.HTMLElement;
  useDocument(win.document as unknown as Document);
});
afterAll(() => {
  for (const [name, value] of Object.entries(saved)) {
    if (value === undefined) delete g[name];
    else g[name] = value;
  }
});

let items: Item[];
let ran: string[];
let states: number;
let bar: CommandBar;
const options = (): Element[] => [...bar.element.querySelectorAll("[role=option]")];
const key = (k: string): void => {
  const input = bar.element.querySelector("input") as HTMLInputElement;
  input.dispatchEvent(
    new (win as unknown as { KeyboardEvent: typeof KeyboardEvent }).KeyboardEvent("keydown", {
      key: k,
      bubbles: true,
      cancelable: true,
    }),
  );
};
const thread = (text: string): Item => ({
  id: "t1",
  kind: "comment",
  state: "open",
  authorId: "you",
  anchor: { selector: "#a", label: "A block", target: "p" },
  thread: [{ id: "m1", authorId: "you", text, ts: 1, reactions: {} }],
  needsYou: false,
  createdAt: 1,
});

beforeEach(() => {
  items = [];
  ran = [];
  states = 0;
  bar = createCommandBar({
    people: { you: { name: "You", initials: "Y", tint: "tint-you" } },
    now: () => 1,
    items: () => items,
    canRun: (id) => id !== "settings",
    run: (id) => ran.push(id),
    away: () => ran.push("away"),
    openItem: (id) => ran.push(`open:${id}`),
    setKept: () => {},
    awayChip: "extension",
    onState: () => {
      states += 1;
    },
  });
  (win.document.body as unknown as HTMLElement).appendChild(bar.element);
});

describe("the launcher's Inbox", () => {
  test("empty, it says so and lists nothing: no commands, ever", () => {
    bar.open("inbox");
    expect(bar.mode()).toBe("inbox");
    expect(options()).toHaveLength(0);
    expect(bar.element.querySelector(".bar-empty")?.textContent).toBe(BAR.modes.inbox.empty);
    expect(bar.element.querySelector(".label")).toBeNull();
    expect([...bar.element.querySelectorAll(".bar-footer span")].map((n) => n.textContent)).toEqual(
      [...BAR.footer.data],
    );
    const input = bar.element.querySelector("input") as HTMLInputElement;
    expect(input.hasAttribute("aria-activedescendant")).toBe(false);
    // The page that hosts the demo is told, so it can say where the commands are.
    expect(bar.emptyInbox()).not.toBeNull();
  });

  test("Enter in an empty Inbox runs nothing", () => {
    bar.open("inbox");
    key("Enter");
    expect(ran).toEqual([]);
    expect(bar.isOpen()).toBe(true);
  });

  test("with something made, it lists that and only that", () => {
    items = [thread("Is this the right line?")];
    bar.open("inbox");
    expect(options().map((o) => o.querySelector(".q-text")?.textContent)).toEqual([
      "Is this the right line?",
    ]);
    expect(bar.emptyInbox()).toBeNull();
    key("Enter");
    expect(ran).toEqual(["open:t1"]);
  });

  test("a search that matches nothing is not an empty Inbox", () => {
    items = [thread("Is this the right line?")];
    bar.open("inbox");
    const input = bar.element.querySelector("input") as HTMLInputElement;
    input.value = "zzz";
    input.dispatchEvent(new (win as unknown as { Event: typeof Event }).Event("input"));
    expect(bar.element.querySelector(".bar-empty")?.textContent).toBe(BAR.nothingMatches);
    expect(bar.emptyInbox()).toBeNull();
  });
});

describe("Esc, and the root", () => {
  test("Esc from the Inbox goes back to the root, where the commands are; again, it closes", () => {
    bar.open("inbox");
    key("Escape");
    expect(bar.isOpen()).toBe(true);
    expect(bar.mode()).toBe("root");
    expect(options().map((o) => o.querySelector(".label")?.textContent)).toEqual(
      COMMANDS.map((c) => c.label),
    );
    expect(bar.emptyInbox()).toBeNull();
    key("Escape");
    expect(bar.isOpen()).toBe(false);
  });

  test("Backspace on an empty search does the same as Esc from a mode", () => {
    bar.open("inbox");
    key("Backspace");
    expect(bar.mode()).toBe("root");
  });

  test("the bar's own toggle opens at the root: the commands", () => {
    bar.toggle();
    expect(bar.mode()).toBe("root");
    expect(options()).toHaveLength(COMMANDS.length);
    key("ArrowDown");
    key("Enter");
    expect(ran).toEqual(["editBlock"]);
    bar.toggle();
    expect(bar.isOpen()).toBe(false);
  });

  test("the page hears every change of what the bar shows", () => {
    const before = states;
    bar.open("inbox");
    key("Escape");
    key("Escape");
    expect(states - before).toBeGreaterThanOrEqual(3);
  });
});
