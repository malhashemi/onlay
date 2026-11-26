// Key chords: two keys in a row run a command; nothing else is the dispatcher's.
import { beforeEach, describe, expect, test } from "bun:test";
import { type Chords, createChords, isEditable } from "./chords";

let ran: string[];
let chords: Chords;
let lapse: (() => void) | null;
beforeEach(() => {
  ran = [];
  lapse = null;
  chords = createChords({
    bindings: {
      cc: () => ran.push("commentBlock"),
      ca: () => ran.push("commentPage"),
      ee: () => ran.push("editBlock"),
      ii: () => ran.push("inbox"),
    },
    setTimeout: (fn) => {
      lapse = fn;
      return 1;
    },
    clearTimeout: () => {
      lapse = null;
    },
  });
});

describe("chords", () => {
  test("two keys in a row run their command; both keys are the dispatcher's", () => {
    expect(chords.key("c")).toBe(true);
    expect(ran).toEqual([]);
    expect(chords.key("c")).toBe(true);
    expect(ran).toEqual(["commentBlock"]);
    chords.key("e");
    chords.key("e");
    expect(ran).toEqual(["commentBlock", "editBlock"]);
  });

  test("the same first key leads to different commands", () => {
    chords.key("c");
    chords.key("a");
    expect(ran).toEqual(["commentPage"]);
  });

  test("a key that starts no chord is left to the page", () => {
    expect(chords.key("x")).toBe(false);
    expect(chords.key("Enter")).toBe(false);
    expect(chords.key("C")).toBe(false);
    expect(ran).toEqual([]);
  });

  test("an unfinished chord falls through: the second key may start its own", () => {
    chords.key("c");
    expect(chords.key("i")).toBe(true);
    chords.key("i");
    expect(ran).toEqual(["inbox"]);
  });

  test("the window lapses: a slow second key is a new first key", () => {
    chords.key("c");
    lapse?.();
    chords.key("c");
    expect(ran).toEqual([]);
    chords.key("c");
    expect(ran).toEqual(["commentBlock"]);
  });

  test("a non-character key drops an armed chord", () => {
    chords.key("e");
    chords.key("Shift");
    chords.key("e");
    expect(ran).toEqual([]);
  });
});

describe("where chords never fire", () => {
  test("anything the visitor types into", () => {
    expect(isEditable({ localName: "textarea" })).toBe(true);
    expect(isEditable({ localName: "input", type: "text" })).toBe(true);
    expect(isEditable({ localName: "select" })).toBe(true);
    expect(isEditable({ localName: "div", isContentEditable: true })).toBe(true);
  });

  test("but not a button, a radio, or the page itself", () => {
    expect(isEditable({ localName: "button" })).toBe(false);
    expect(isEditable({ localName: "input", type: "radio" })).toBe(false);
    expect(isEditable({ localName: "body" })).toBe(false);
    expect(isEditable(null)).toBe(false);
  });
});
