// The command registry (ADR-0019 §3): completeness (every CommandId has
// meta + icon + handler), scope/hue grammar, and handler dispatch — one table
// drives the bar, the chord dispatcher, and the options page.
import { describe, expect, test } from "bun:test";
import { COMMAND_IDS, COMMAND_META, type CommandId } from "../prefs";
import { COMMANDS, type CommandCtx, commandById, PICK_HINTS } from "./commands";

function recordingCtx(): { ctx: CommandCtx; calls: string[] } {
  const calls: string[] = [];
  const ctx: CommandCtx = {
    enterPick: (kind) => calls.push(`pick:${kind}`),
    openPageComposer: (kind) => calls.push(`page:${kind}`),
    openInbox: () => calls.push("inbox"),
    openEditTray: () => calls.push("editTray"),
    openSettings: () => calls.push("settings"),
    toggleCommandBar: () => calls.push("bar"),
    toggleTheme: () => calls.push("theme"),
    switchSpace: () => calls.push("space"),
    openKeptEdits: () => calls.push("kept"),
    copyRound: () => calls.push("copyRound"),
  };
  return { ctx, calls };
}

describe("command registry completeness", () => {
  test("every CommandId appears exactly once, in display order", () => {
    expect(COMMANDS.map((c) => c.id)).toEqual([...COMMAND_IDS]);
  });

  test("labels and descriptions come from COMMAND_META (one copy source)", () => {
    for (const c of COMMANDS) {
      expect(c.label).toBe(COMMAND_META[c.id].label);
      expect(c.description).toBe(COMMAND_META[c.id].description);
    }
  });

  test("every command has a drawable, distinct-enough icon", () => {
    for (const c of COMMANDS) expect(c.icon.paths.length).toBeGreaterThan(0);
    // Kind commands intentionally share the kind glyph with their pins/chips;
    // beyond that, no two commands may wear the same glyph.
    const distinct = new Set(COMMANDS.map((c) => JSON.stringify(c.icon.paths)));
    expect(distinct.size).toBe(COMMANDS.length);
  });

  test("scope follows the block/page split of the id grammar", () => {
    const scopes = Object.fromEntries(COMMANDS.map((c) => [c.id, c.scope])) as Record<
      CommandId,
      string
    >;
    expect(scopes).toEqual({
      commandBar: "none",
      copyBlock: "block",
      editBlock: "block",
      editPage: "page",
      commentBlock: "block",
      commentPage: "page",
      inbox: "none",
      keptEdits: "none",
      copyForAgent: "none",
      switchSpace: "none",
      toggleTheme: "none",
      settings: "none",
    });
  });

  test("kind commands wear their kind hue; utilities stay neutral", () => {
    expect(commandById("commentBlock").cls).toBe("k-comment");
    expect(commandById("commentPage").cls).toBe("k-comment");
    expect(commandById("editBlock").cls).toBe("k-change");
    expect(commandById("editPage").cls).toBe("k-change");
    for (const id of [
      "commandBar",
      "copyBlock",
      "inbox",
      "keptEdits",
      "copyForAgent",
      "switchSpace",
      "toggleTheme",
      "settings",
    ] as CommandId[]) {
      expect(commandById(id).cls).toBe("");
    }
  });

  test("inbox is the only command that enters a bar search mode", () => {
    for (const c of COMMANDS) {
      if (c.id === "inbox") expect(c.searchMode).toBe("i");
      else expect(c.searchMode).toBeUndefined();
    }
  });
});

describe("command handlers", () => {
  test("every command dispatches to the right machinery", () => {
    const expected: Record<CommandId, string> = {
      commandBar: "bar",
      copyBlock: "pick:copy",
      editBlock: "pick:edit",
      editPage: "editTray",
      commentBlock: "pick:comment",
      commentPage: "page:comment",
      inbox: "inbox",
      keptEdits: "kept",
      copyForAgent: "copyRound",
      switchSpace: "space",
      toggleTheme: "theme",
      settings: "settings",
    };
    for (const id of COMMAND_IDS) {
      const { ctx, calls } = recordingCtx();
      commandById(id).run(ctx);
      expect(calls).toEqual([expected[id]]);
    }
  });

  test("Ask is hidden: no command, chord or pick kind creates one (spec §10)", () => {
    for (const c of COMMANDS) {
      expect(c.id.toLowerCase()).not.toContain("ask");
      expect(c.cls).not.toBe("k-ask");
      expect(c.label.toLowerCase()).not.toMatch(/\bask\b/);
    }
    expect(Object.keys(PICK_HINTS)).not.toContain("ask");
    expect(() => commandById("askBlock" as CommandId)).toThrow();
  });

  test("commandById throws on an unknown id (registry is closed)", () => {
    expect(() => commandById("nope" as CommandId)).toThrow();
  });

  test("every pick kind carries a hint", () => {
    for (const kind of ["comment", "edit", "copy"] as const) {
      expect(PICK_HINTS[kind]).toContain("click a block");
    }
  });
});
