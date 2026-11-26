// The overlay's small pure rules: command ranking, the mention trigger, the
// launcher's clamp, and how an Inbox orders and searches what it lists.
import { describe, expect, test } from "bun:test";
import { rankCommands } from "./bar";
import { agentSpans, mentionTrigger } from "./editor";
import { clampPos } from "./launcher";
import {
  chipFor,
  type Item,
  inboxOrder,
  matchesQuery,
  mentionsAgent,
  placeLabel,
  summaryOf,
} from "./model";
import { COMMANDS } from "./strings";

const item = (over: Partial<Item>): Item => ({
  id: "i",
  kind: "comment",
  state: "open",
  authorId: "you",
  anchor: null,
  thread: [],
  needsYou: false,
  createdAt: 0,
  ...over,
});
const msg = (text: string, ts = 0) => ({ id: `m${ts}`, authorId: "you", text, ts, reactions: {} });

describe("command ranking", () => {
  test("an empty query keeps the product's order", () => {
    expect(rankCommands(COMMANDS, "").map((c) => c.id)).toEqual(COMMANDS.map((c) => c.id));
  });

  test("a label that starts with the query comes before one that contains it, then descriptions", () => {
    expect(rankCommands(COMMANDS, "edit").map((c) => c.id)).toEqual([
      "editBlock",
      "editPage",
      "keptEdits",
      "switchSpace",
    ]);
    expect(rankCommands(COMMANDS, "zzz")).toEqual([]);
  });
});

describe("the mention trigger", () => {
  test("opens on an @ that starts a word, with what follows it", () => {
    expect(mentionTrigger("@")).toEqual({ query: "", length: 1 });
    expect(mentionTrigger("hello @ag")).toEqual({ query: "ag", length: 3 });
    expect(mentionTrigger("line\n@A")).toEqual({ query: "a", length: 2 });
  });

  test("not inside a word, and not once the word has ended", () => {
    expect(mentionTrigger("mail@ag")).toBeNull();
    expect(mentionTrigger("@agent ")).toBeNull();
    expect(mentionTrigger("no mention")).toBeNull();
  });
});

describe("the pill @agent wears while it is typed", () => {
  test("sits exactly on each @agent that is a word of its own", () => {
    const text = "@agent first, then @Agent\nand x@agent and @agents";
    expect(agentSpans(text).map((s) => text.slice(s.start, s.end))).toEqual(["@agent", "@Agent"]);
    expect(agentSpans("nothing here")).toEqual([]);
  });
});

describe("the launcher's place", () => {
  test("stays inside the viewport, a margin from each edge", () => {
    expect(clampPos(-50, -50, 46, 46, 1000, 800)).toEqual({ x: 8, y: 8 });
    expect(clampPos(5000, 5000, 46, 46, 1000, 800)).toEqual({ x: 946, y: 746 });
    expect(clampPos(300, 200, 46, 46, 1000, 800)).toEqual({ x: 300, y: 200 });
  });
});

describe("an interaction as a row", () => {
  test("reads as its Edit's intent, or its first words, code without its fences", () => {
    expect(
      summaryOf(
        item({ kind: "change", change: { intent: "Plainer", method: "direct", count: 1 } }),
      ),
    ).toBe("Plainer");
    expect(summaryOf(item({ thread: [msg("\n  First line\nsecond")] }))).toBe("First line");
    expect(summaryOf(item({ thread: [msg("```json\n{}\n```")] }))).toBe("{}");
    expect(summaryOf(item({}))).toBe("");
  });

  test("its chip is resolved, needs you, or waiting", () => {
    expect(chipFor({ state: "resolved", needsYou: true })).toBe("resolved");
    expect(chipFor({ state: "working", needsYou: true })).toBe("needs-you");
    expect(chipFor({ state: "kept", needsYou: false })).toBe("waiting");
  });

  test("its place is its block's label, or the page", () => {
    const anchor = { selector: "#a", label: "A block", target: "p" };
    expect(placeLabel(item({ anchor }), "page-level")).toBe("A block");
    expect(placeLabel(item({}), "page-level")).toBe("page-level");
  });

  test("@agent hands over only as a word of its own, outside code", () => {
    expect(mentionsAgent("@agent please")).toBe(true);
    expect(mentionsAgent("please\n@Agent")).toBe(true);
    expect(mentionsAgent("see @agents")).toBe(false);
    expect(mentionsAgent("x@agent")).toBe(false);
    expect(mentionsAgent("```\n@agent\n```")).toBe(false);
  });
});

describe("the Inbox", () => {
  const rows = [
    item({ id: "resolved", state: "resolved", thread: [msg("done", 50)] }),
    item({ id: "waiting-old", thread: [msg("old", 10)] }),
    item({ id: "needs-new", needsYou: true, thread: [msg("new debt", 40)] }),
    item({ id: "waiting-new", thread: [msg("new", 30)] }),
    item({ id: "needs-old", needsYou: true, thread: [msg("old debt", 20)] }),
  ];

  test("what needs you first, oldest debt first; then the rest, newest first; resolved last", () => {
    expect(inboxOrder(rows).map((r) => r.id)).toEqual([
      "needs-old",
      "needs-new",
      "waiting-new",
      "waiting-old",
      "resolved",
    ]);
  });

  test("search matches every word against the text, the person, the place and the state", () => {
    const people = { you: { name: "Maya Chen", initials: "MC", tint: "" } };
    const row = item({
      thread: [msg("Is forty right?")],
      anchor: { selector: "#s", label: "Studio plan", target: "p" },
    });
    expect(matchesQuery(row, people, "")).toBe(true);
    expect(matchesQuery(row, people, "forty studio")).toBe(true);
    expect(matchesQuery(row, people, "maya open")).toBe(true);
    expect(matchesQuery(row, people, "forty team")).toBe(false);
  });
});
