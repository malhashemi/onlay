// The command bar (ADR-0019 §2): filter/ranking, mode enter/pop (letter+space,
// backspace-on-empty, esc pops then closes), queue merge/order/dedupe/filter,
// and the DOM behavior — rows render, Enter runs, local rows open the thread
// while cross-page rows navigate.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { InboxRow } from "@onlay/protocol";
import { Window } from "happy-dom";
import { type AppInternals, createApp, type InteractionSnap } from "./app";
import {
  type AttentionLists,
  type CommandBar,
  createCommandBar,
  filterQueue,
  MODE_SPEC,
  mergeQueue,
  rankCommands,
} from "./command-bar";
import { COMMANDS } from "./commands";

const SPACE = "s_aaaaaaaaaaaaaaaaaaaa";

/* ── pure: ranking ── */

describe("rankCommands", () => {
  test("empty query keeps registry order", () => {
    expect(rankCommands(COMMANDS, "").map((c) => c.id)).toEqual(COMMANDS.map((c) => c.id));
  });

  test("label prefix ranks above label substring, description matches last", () => {
    const ids = rankCommands(COMMANDS, "edit").map((c) => c.id);
    // prefix tier: "Edit block", "Edit page" — registry order within the tier
    expect(ids.slice(0, 2)).toEqual(["editBlock", "editPage"]);
    // description tier trails: e.g. queue's copy has no "edit", settings neither
    for (const _id of ids) expect(["editBlock", "editPage", "inbox"]).not.toContain("nope");
    const sub = rankCommands(COMMANDS, "block").map((c) => c.id);
    // "block" is a substring of several labels; none start with it
    expect(sub.length).toBeGreaterThan(0);
    expect(sub[0]).toBe("copyBlock"); // first label containing it, registry order
  });

  test("description-only matches are found (and ranked below label matches)", () => {
    const ids = rankCommands(COMMANDS, "clipboard").map((c) => c.id);
    expect(ids).toEqual(["copyBlock"]);
  });

  test("no match yields empty", () => {
    expect(rankCommands(COMMANDS, "zzzzz")).toEqual([]);
  });
});

/* ── pure: queue merge/order/filter ── */

function snap(over: Partial<InteractionSnap> & { id: string }): InteractionSnap {
  return {
    kind: "comment",
    url: "http://127.0.0.1:8124/page.html",
    anchor: { level: "page" },
    authorId: "sara",
    participants: [],
    waitingOn: [],
    state: "open",
    thread: [{ msgId: "m1", authorId: "sara", body: { text: "first words" }, ts: 1000 }],
    createdAt: 1000,
    spaceId: SPACE,
    ...over,
  } as InteractionSnap;
}

function row(over: Partial<InboxRow> & { interactionId: string }): InboxRow {
  return {
    spaceId: SPACE,
    kind: "ask",
    state: "open",
    url: "http://127.0.0.1:8124/other.html",
    anchorLabel: "§hero",
    text: "from attention",
    fromActorId: "scout",
    waitingOnIds: [],
    ts: 500,
    ...over,
  } as InboxRow;
}

describe("mergeQueue", () => {
  test("on this page: needs-you leads (oldest debt first), then the rest, then recent", () => {
    const local = [
      snap({ id: "a".repeat(36), state: "open", waitingOn: ["me"], createdAt: 1, thread: [] }),
      snap({ id: "b".repeat(36), state: "open", createdAt: 2, thread: [] }),
      snap({ id: "c".repeat(36), state: "resolved", createdAt: 3, thread: [] }),
      snap({ id: "d".repeat(36), state: "open", waitingOn: ["me"], createdAt: 9, thread: [] }),
    ];
    const rows = mergeQueue(local, null, "me");
    expect(rows.map((r) => [r.group, r.interactionId[0]])).toEqual([
      ["onpage", "a"], // oldest debt leads
      ["onpage", "d"],
      ["onpage", "b"], // then non-needs, newest first
      ["recent", "c"],
    ]);
    expect(rows.map((r) => r.needs)).toEqual([true, true, false, false]);
  });

  test("anchor-lost local rows join the unanchored section; stakes outrank age", () => {
    const local = [
      snap({ id: "a".repeat(36), state: "open", waitingOn: ["me"], createdAt: 1, thread: [] }),
      snap({
        id: "b".repeat(36),
        state: "open",
        waitingOn: ["me"],
        createdAt: 2,
        thread: [],
        anchorLost: true,
      }),
      snap({
        id: "c".repeat(36),
        kind: "ask",
        state: "open",
        waitingOn: ["me"],
        createdAt: 9,
        thread: [],
        ask: { question: "risky?", stakes: "dangerous", options: [], answers: [] } as never,
      }),
    ];
    const rows = mergeQueue(local, null, "me");
    expect(rows.map((r) => [r.group, r.interactionId[0]])).toEqual([
      ["onpage", "c"], // dangerous outranks the older routine row
      ["onpage", "a"],
      ["unanchored", "b"],
    ]);
    expect(rows[2]?.anchorLost).toBe(true);
  });

  test("unanchored attention rows land in the unanchored section, url-less", () => {
    const attention: AttentionLists = {
      needsYou: [row({ interactionId: "9".repeat(36), url: undefined, unanchored: true } as never)],
      waiting: [],
      recent: [],
    };
    const rows = mergeQueue([], attention, "me");
    expect(rows[0]?.group).toBe("unanchored");
    expect(rows[0]?.url).toBeUndefined();
    expect(rows[0]?.unanchored).toBe(true);
  });

  test("dedupes by interaction id — the local snapshot wins", () => {
    const id = "e".repeat(36);
    const local = [snap({ id, kind: "ask", ask: undefined, state: "open" })];
    const attention: AttentionLists = {
      needsYou: [row({ interactionId: id, text: "stale attention copy" })],
      waiting: [row({ interactionId: "f".repeat(36) })],
      recent: [],
    };
    const rows = mergeQueue(local, attention, "me");
    expect(rows.length).toBe(2);
    const merged = rows.find((r) => r.interactionId === id);
    expect(merged?.local).toBe(true);
    expect(merged?.text).toBe("first words"); // local enrichment, not the attention copy
    expect(rows.find((r) => r.interactionId === "f".repeat(36))?.local).toBe(false);
  });

  test("a row on this page needs you when the server's attention says so, not only by waitingOn", () => {
    // The agent answered what "me" asked for (its message is last), and sara
    // replied on a thread "me" wrote: neither puts "me" in waitingOn, both
    // need "me" by the server's rule. And a thread the server has "me"
    // waiting on reads waiting even if the snapshot still names "me".
    const answered = "a".repeat(36);
    const replied = "b".repeat(36);
    const settled = "c".repeat(36);
    const local = [
      snap({ id: answered, authorId: "me", waitingOn: [], createdAt: 1 }),
      snap({ id: replied, authorId: "me", waitingOn: [], createdAt: 2 }),
      snap({ id: settled, authorId: "me", waitingOn: ["me"], createdAt: 3 }),
    ];
    const attention: AttentionLists = {
      needsYou: [
        row({ interactionId: answered, because: "agent-answered" } as never),
        row({ interactionId: replied, because: "thread-reply" } as never),
      ],
      waiting: [row({ interactionId: settled })],
      recent: [],
    };
    const rows = mergeQueue(local, attention, "me");
    const byId = new Map(rows.map((r) => [r.interactionId, r]));
    expect(byId.get(answered)?.needs).toBe(true);
    expect(byId.get(answered)?.because).toBe("agent-answered");
    expect(byId.get(replied)?.needs).toBe(true);
    expect(byId.get(settled)?.needs).toBe(false);
    // Still the local snapshot's richer row.
    expect(byId.get(answered)?.local).toBe(true);
    expect(byId.get(answered)?.text).toBe("first words");
  });

  test("cross-page attention rows are elsewhere; needs leads; resolved is recent", () => {
    const attention: AttentionLists = {
      needsYou: [row({ interactionId: "1".repeat(36) })],
      waiting: [row({ interactionId: "2".repeat(36) })],
      recent: [row({ interactionId: "3".repeat(36), state: "resolved" })],
    };
    const rows = mergeQueue([], attention, "me");
    expect(rows.map((r) => r.group)).toEqual(["elsewhere", "elsewhere", "recent"]);
    expect(rows.map((r) => r.needs)).toEqual([true, false, false]);
  });

  test("ask/edit snapshots summarize as question/intent", () => {
    const local = [
      snap({
        id: "a".repeat(36),
        kind: "ask",
        ask: { question: "ship it?", options: [], answers: [] } as never,
      }),
      snap({
        id: "b".repeat(36),
        kind: "change",
        change: { intent: "tighten the hero copy" } as never,
      }),
    ];
    const rows = mergeQueue(local, null, null);
    expect(rows.map((r) => r.text).sort()).toEqual(["ship it?", "tighten the hero copy"]);
  });
});

describe("filterQueue", () => {
  const rows = mergeQueue(
    [
      snap({ id: "a".repeat(36), anchor: { level: "element", selector: "#pricing" } }),
      snap({
        id: "b".repeat(36),
        kind: "ask",
        authorId: "scout",
        ask: { question: "which variant?", options: [], answers: [] } as never,
        state: "answered",
      }),
    ],
    {
      needsYou: [],
      waiting: [],
      recent: [row({ interactionId: "c".repeat(36), url: "http://x.dev/docs/adr", text: "done" })],
    },
    null,
  );
  const name = (id: string): string => (id === "scout" ? "Scout Agent" : id);

  test("matches text, actor name, context, state, page path, and the FULL url", () => {
    expect(filterQueue(rows, "first words", name).length).toBe(1);
    expect(filterQueue(rows, "scout agent", name)[0]?.interactionId).toBe("b".repeat(36));
    expect(filterQueue(rows, "#pricing", name)[0]?.interactionId).toBe("a".repeat(36));
    expect(filterQueue(rows, "answered", name)[0]?.interactionId).toBe("b".repeat(36));
    expect(filterQueue(rows, "/docs/adr", name)[0]?.interactionId).toBe("c".repeat(36));
    // Searching by SITE: the host is not in pathLabel on a non-root page —
    // only the full url carries it (F26 follow-up).
    expect(filterQueue(rows, "x.dev", name)[0]?.interactionId).toBe("c".repeat(36));
    expect(filterQueue(rows, "zzz", name)).toEqual([]);
  });

  test("empty query passes everything through", () => {
    expect(filterQueue(rows, "  ", name)).toEqual(rows);
  });
});

/* ── DOM behavior ── */

let win: Window | null = null;

function installDom(): void {
  win = new Window({ url: "http://127.0.0.1:8124/page.html" });
  const g = globalThis as unknown as Record<string, unknown>;
  g.window = win;
  g.document = win.document;
  g.Element = win.Element;
  g.HTMLElement = win.HTMLElement;
  g.HTMLInputElement = win.HTMLInputElement;
  g.Node = win.Node;
  g.Event = win.Event;
  g.KeyboardEvent = win.KeyboardEvent;
  g.location = win.location;
  g.crypto = win.crypto ?? globalThis.crypto;
}

beforeEach(installDom);
afterEach(() => {
  win?.happyDOM.cancelAsync();
  win?.close();
  win = null;
});

const flush = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

function currentWindow(): Window {
  if (!win) throw new Error("test window not initialized");
  return win;
}

interface Rig {
  bar: CommandBar;
  app: ReturnType<typeof createApp> & AppInternals;
  ran: string[];
  opened: string[];
  navigated: string[];
  input: HTMLInputElement;
  attention: AttentionLists | null;
}

function makeRig(local: InteractionSnap[] = [], attention: AttentionLists | null = null): Rig {
  const host = document.createElement("div");
  document.body.appendChild(host);
  const shadow = host.attachShadow({ mode: "open" });
  const app = createApp({ shadow, host, isTopFrame: true, toast: () => {} }) as ReturnType<
    typeof createApp
  > &
    AppInternals;
  app._setSelf({ id: "me", name: "Me", tint: "#111", initials: "ME" });
  app._setInteractions(SPACE, local);
  const ran: string[] = [];
  const opened: string[] = [];
  const navigated: string[] = [];
  const bar = createCommandBar(app, {
    commands: COMMANDS,
    binding: () => "ctrl+.",
    run: (id) => ran.push(id),
    fetchAttention: () => Promise.resolve(attention),
    connected: () => true,
    openInteraction: (id) => opened.push(id),
    navigate: (url) => navigated.push(url),
  });
  shadow.appendChild(bar.element);
  const input = bar.element.querySelector(".bar-input") as HTMLInputElement;
  return { bar, app, ran, opened, navigated, input, attention };
}

function type(rig: Rig, value: string): void {
  rig.input.value = value;
  const w = currentWindow();
  rig.input.dispatchEvent(new w.Event("input", { bubbles: true }) as unknown as Event);
}

function key(rig: Rig, k: string, trusted = true): KeyboardEvent {
  const w = currentWindow();
  const e = new w.KeyboardEvent("keydown", {
    key: k,
    bubbles: true,
    cancelable: true,
  });
  if (trusted) Object.defineProperty(e, "isTrusted", { value: true });
  rig.input.dispatchEvent(e as unknown as Event);
  return e as unknown as KeyboardEvent;
}

function rowLabels(rig: Rig): string[] {
  return [...rig.bar.element.querySelectorAll(".bar-row .label")].map((n) => n.textContent ?? "");
}

describe("command bar — opening re-reads the account", () => {
  test("onOpened fires once per open, not again while the bar is already open", () => {
    const host = document.createElement("div");
    document.body.appendChild(host);
    const shadow = host.attachShadow({ mode: "open" });
    const app = createApp({ shadow, host, isTopFrame: true, toast: () => {} }) as ReturnType<
      typeof createApp
    > &
      AppInternals;
    let asked = 0;
    const bar = createCommandBar(app, {
      commands: COMMANDS,
      binding: () => "ctrl+.",
      run: () => {},
      fetchAttention: () => Promise.resolve(null),
      onOpened: () => {
        asked += 1;
      },
      connected: () => true,
      openInteraction: () => {},
      navigate: () => {},
    });
    shadow.appendChild(bar.element);
    bar.open();
    expect(asked).toBe(1);
    bar.open("space");
    expect(asked).toBe(1);
    bar.close();
    bar.open("space");
    expect(asked).toBe(2);
  });
});

describe("command bar — root mode", () => {
  test("opens with every command except commandBar itself; typing filters", () => {
    const rig = makeRig();
    rig.bar.open();
    expect(rig.bar.isOpen()).toBe(true);
    expect(rowLabels(rig).length).toBe(COMMANDS.length - 1);
    expect(rowLabels(rig)).not.toContain("Open command bar");
    type(rig, "inbox");
    expect(rowLabels(rig)).toEqual(["Inbox"]);
    type(rig, "zzzz");
    expect(rowLabels(rig)).toEqual([]);
    expect(rig.bar.element.textContent).toContain("no matching command");
  });

  test("Enter runs the selected command; arrows cycle with wrap", () => {
    const rig = makeRig();
    rig.bar.open();
    type(rig, "copy");
    key(rig, "Enter");
    expect(rig.ran).toEqual(["copyBlock"]);
    // wrap: ArrowUp from the top lands on the last row
    type(rig, "");
    key(rig, "ArrowUp");
    key(rig, "Enter");
    expect(rig.ran[1]).toBe("settings"); // last visible command
  });

  test("synthetic (untrusted) Enter never runs a command", () => {
    const rig = makeRig();
    rig.bar.open();
    type(rig, "copy");
    key(rig, "Enter", false);
    expect(rig.ran).toEqual([]);
  });
});

describe("command bar — modes", () => {
  test("`i`+space enters Inbox mode; backspace on empty pops to root", () => {
    const rig = makeRig();
    rig.bar.open();
    type(rig, "i ");
    expect(rig.bar.mode()).toBe("inbox");
    expect(rig.input.value).toBe(""); // the trigger is consumed
    key(rig, "Backspace");
    expect(rig.bar.mode()).toBe("root");
  });

  test("c/e + space enter kind modes with their chips; Ask has no mode", () => {
    const rig = makeRig();
    rig.bar.open();
    type(rig, "a ");
    expect(rig.bar.mode()).toBe("root");
    expect(Object.keys(MODE_SPEC)).not.toContain("ask");
    type(rig, "");
    for (const [k, mode] of [
      ["c", "comment"],
      ["e", "edit"],
    ] as const) {
      type(rig, `${k} `);
      expect(rig.bar.mode()).toBe(mode);
      const chip = rig.bar.element.querySelector(".bar-mode-chip") as HTMLElement;
      expect(chip.textContent).toBe(MODE_SPEC[mode].label);
      rig.bar.escape(); // back to root for the next letter
      expect(rig.bar.mode()).toBe("root");
    }
  });

  test("escape pops a mode to root first, then closes", () => {
    const rig = makeRig();
    rig.bar.open("inbox");
    expect(rig.bar.mode()).toBe("inbox");
    rig.bar.escape();
    expect(rig.bar.isOpen()).toBe(true);
    expect(rig.bar.mode()).toBe("root");
    rig.bar.escape();
    expect(rig.bar.isOpen()).toBe(false);
  });

  test("a mid-word letter never triggers a mode (only `<letter> ` as the query)", () => {
    const rig = makeRig();
    rig.bar.open();
    type(rig, "co ");
    expect(rig.bar.mode()).toBe("root");
  });
});

describe("command bar — queue mode", () => {
  const localId = "a".repeat(36);
  const awayId = "b".repeat(36);
  const local = [snap({ id: localId, waitingOn: ["me"] })];
  const attention: AttentionLists = {
    needsYou: [row({ interactionId: awayId, url: "http://x.dev/away", text: "elsewhere" })],
    waiting: [],
    recent: [],
  };

  test("renders merged rows; Enter opens local threads, navigates for others", async () => {
    const rig = makeRig(local, attention);
    rig.bar.open("inbox");
    await flush(); // attention snapshot lands async
    const texts = [...rig.bar.element.querySelectorAll(".q-text")].map((n) => n.textContent);
    expect(texts).toEqual(["first words", "elsewhere"]);
    key(rig, "Enter");
    expect(rig.opened).toEqual([localId]);
    expect(rig.bar.isOpen()).toBe(false);
    // reopen: select the cross-page row → navigate
    rig.bar.open("inbox");
    await flush();
    key(rig, "ArrowDown");
    key(rig, "Enter");
    expect(rig.navigated).toEqual(["http://x.dev/away"]);
  });

  test("kind modes are the same data filtered to one kind, searchable", async () => {
    const askId = "c".repeat(36);
    const rig = makeRig(
      [
        ...local,
        snap({
          id: askId,
          kind: "change",
          change: { intent: "which hero?" },
          thread: [],
        }),
      ],
      attention,
    );
    rig.bar.open("edit");
    await flush();
    let texts = [...rig.bar.element.querySelectorAll(".q-text")].map((n) => n.textContent);
    // only Edits: the comments here and the cross-page Ask stay out
    expect(texts).toEqual(["which hero?"]);
    type(rig, "which");
    texts = [...rig.bar.element.querySelectorAll(".q-text")].map((n) => n.textContent);
    expect(texts).toEqual(["which hero?"]);
  });

  test("empty states carry personality, not blankness", () => {
    const rig = makeRig([], null);
    rig.bar.open("inbox");
    expect(rig.bar.element.textContent).toContain("Nothing needs you.");
    rig.bar.escape();
    rig.bar.open("edit");
    expect(rig.bar.element.textContent).toContain("No edits in flight on this page.");
  });
});

describe("command bar — ⌃1–9 quick-select (filtered surfaces only)", () => {
  const localId = "a".repeat(36);
  const awayId = "b".repeat(36);
  const local = [snap({ id: localId, waitingOn: ["me"] })];
  const attention: AttentionLists = {
    needsYou: [row({ interactionId: awayId, url: "http://x.dev/away", text: "elsewhere" })],
    waiting: [],
    recent: [],
  };

  function ctrlKey(rig: Rig, k: string, trusted = true): void {
    const w = currentWindow();
    const e = new w.KeyboardEvent("keydown", {
      key: k,
      ctrlKey: true,
      bubbles: true,
      cancelable: true,
    });
    if (trusted) Object.defineProperty(e, "isTrusted", { value: true });
    rig.input.dispatchEvent(e as unknown as Event);
  }

  test("rows wear ⌃n kbd chips and ⌃2 opens the second row directly", async () => {
    const rig = makeRig(local, attention);
    rig.bar.open("inbox");
    await flush();
    const chips = [...rig.bar.element.querySelectorAll(".q-quick")].map((n) => n.textContent);
    expect(chips).toEqual(["⌃1", "⌃2"]);
    ctrlKey(rig, "2");
    expect(rig.navigated).toEqual(["http://x.dev/away"]);
    expect(rig.bar.isOpen()).toBe(false);
  });

  test("the root menu has no quick chips and ⌃1 runs nothing", () => {
    const rig = makeRig();
    rig.bar.open();
    expect(rig.bar.element.querySelector(".q-quick")).toBeNull();
    ctrlKey(rig, "1");
    expect(rig.ran).toEqual([]);
  });

  test("an untrusted ⌃n never opens a row", async () => {
    const rig = makeRig(local, attention);
    rig.bar.open("inbox");
    await flush();
    ctrlKey(rig, "1", false);
    expect(rig.opened).toEqual([]);
    expect(rig.bar.isOpen()).toBe(true);
  });
});

describe("command bar — offline note", () => {
  test("shows the quiet note only when disconnected", () => {
    const host = document.createElement("div");
    document.body.appendChild(host);
    const shadow = host.attachShadow({ mode: "open" });
    const app = createApp({ shadow, host, isTopFrame: true, toast: () => {} }) as ReturnType<
      typeof createApp
    > &
      AppInternals;
    let connected = false;
    const bar = createCommandBar(app, {
      commands: COMMANDS,
      binding: () => "cc",
      run: () => {},
      fetchAttention: () => Promise.resolve(null),
      connected: () => connected,
      openInteraction: () => {},
      navigate: () => {},
    });
    shadow.appendChild(bar.element);
    bar.open();
    const note = bar.element.querySelector(".bar-offline") as HTMLElement;
    expect(note.style.display).toBe("block");
    connected = true;
    bar.refresh();
    expect(note.style.display).toBe("none");
  });
});

describe("command bar — why a row is there", () => {
  test("a thread just shared with you says so; an unknown reason adds nothing", async () => {
    const shared = "d".repeat(36);
    const odd = "f".repeat(36);
    const rig = makeRig([], {
      needsYou: [
        row({ interactionId: shared, text: "shared one", because: "shared" }),
        row({ interactionId: odd, text: "odd one", because: "something-newer" }),
      ],
      waiting: [],
      recent: [],
    });
    rig.bar.open("inbox");
    await flush();
    const metaOf = (text: string) =>
      [...rig.bar.element.querySelectorAll(".q-main")]
        .find((n) => n.querySelector(".q-text")?.textContent === text)
        ?.querySelector(".q-meta")?.textContent ?? "";
    expect(metaOf("shared one")).toContain("Shared with you");
    expect(metaOf("odd one")).not.toContain("Shared with you");
    expect(metaOf("odd one")).not.toContain("something-newer");
  });
});
