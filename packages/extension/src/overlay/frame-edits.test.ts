// What the top frame takes from a child frame's report about its Edits (E-1 … E-3).
import { expect, test } from "bun:test";
import {
  acceptKept,
  acceptOps,
  acceptSets,
  documentsToForget,
  keptSwitchTarget,
  parseRemoteAct,
  spaceGate,
  trayAnswer,
  trayCallAllowed,
} from "./frame-edits";

const SPACE = "s_aaaaaaaaaaaaaaaaaaaa";
const OTHER = "s_bbbbbbbbbbbbbbbbbbbb";
const gate = spaceGate(
  { [SPACE]: 2, [OTHER]: 0 },
  (sp) => (sp === OTHER ? 1 : 2),
  (sp) => sp === SPACE || sp === OTHER,
);

const set = (over: Record<string, unknown> = {}) => ({
  setId: "set-1",
  spaceId: SPACE,
  status: "previewing",
  variants: [{ variantId: "v1", label: "Calm", version: 1 }],
  displayIndex: 0,
  full: true,
  nothingApplied: false,
  statusText: "previewing 1/1: Calm — indicative",
  lookNote: "",
  ...over,
});

test("sets are kept only when well formed, in a known space, as of its newest revision", () => {
  expect(acceptSets([set()], gate)).toHaveLength(1);
  // A space whose revision in the report is older than the one told here.
  expect(acceptSets([set({ spaceId: OTHER })], gate)).toEqual([]);
  expect(acceptSets([set({ spaceId: "s_unknownunknownunkn" })], gate)).toEqual([]);
  expect(acceptSets([set({ status: "nope" })], gate)).toEqual([]);
  expect(acceptSets([set({ displayIndex: 99 })], gate)).toEqual([]);
  expect(
    acceptSets([set({ variants: [{ variantId: "v1", label: 3, version: 1 }] })], gate),
  ).toEqual([]);
  expect(acceptSets("nope", gate)).toEqual([]);
  // Programs never ride a mirror: an extra field is dropped.
  const [m] = acceptSets(
    [set({ variants: [{ variantId: "v", label: "L", version: 2, program: [1] }] })],
    gate,
  );
  expect(m?.variants).toEqual([{ variantId: "v", label: "L", version: 2 }]);
});

const row = (over: Record<string, unknown> = {}) => ({
  interactionId: "11111111-1111-4111-8111-111111111111",
  spaceId: SPACE,
  label: "Calm",
  by: "p_me",
  at: 5,
  on: true,
  unresolved: false,
  refused: 0,
  ...over,
});

test("kept rows are checked one by one, and the shown count never passes what is on", () => {
  const k = acceptKept({ rows: [row(), row({ spaceId: OTHER }), { bad: 1 }], shown: 9 }, gate);
  expect(k.rows).toHaveLength(1);
  expect(k.shown).toBe(1);
  expect(acceptKept({ rows: [row({ on: false })], shown: 1 }, gate).shown).toBe(0);
  expect(acceptKept(null, gate)).toEqual({ rows: [], shown: 0 });
});

test("tray edits are the tray's two kinds only; anything else drops the list", () => {
  expect(
    acceptOps([
      { op: "setText", detail: "Hi" },
      { op: "setStyle", detail: "#a" },
    ]),
  ).toHaveLength(2);
  expect(
    acceptOps([
      { op: "setText", detail: "Hi" },
      { op: "insertFragment", detail: "x" },
    ]),
  ).toEqual([]);
  expect(acceptOps({})).toEqual([]);
});

test("a panel act is taken only when well formed", () => {
  expect(parseRemoteAct({ act: "cycle", delta: 1 })).toEqual({ act: "cycle", delta: 1 });
  expect(parseRemoteAct({ act: "cycle", delta: 2 })).toBeNull();
  expect(parseRemoteAct({ act: "pick", variantId: "v1", version: 2 })).toEqual({
    act: "pick",
    variantId: "v1",
    version: 2,
  });
  expect(parseRemoteAct({ act: "pick", variantId: "v1", version: 0 })).toBeNull();
  expect(parseRemoteAct({ act: "open" })).toBeNull();
  expect(parseRemoteAct({ act: "steer" })).toBeNull();
});

test("a document that reported only variant sets is forgotten once silent too (3-E4)", () => {
  const heard = new Map([
    ["sets-only", 1_000],
    ["fresh", 70_000],
  ]);
  // "sets-only" is in no other collection: it is still swept.
  expect(documentsToForget(heard, ["held-unheard"], 70_500, 60_000).sort()).toEqual([
    "held-unheard",
    "sets-only",
  ]);
});

test("a kept switch naming a frame acts there or nowhere, never in this document (3-E5)", () => {
  const known = new Map([["doc-1", {}]]);
  expect(keptSwitchTarget(undefined, known)).toEqual({ here: true });
  expect(keptSwitchTarget("doc-1", known)).toEqual({ documentId: "doc-1" });
  expect(keptSwitchTarget("doc-gone", known)).toBeNull();
});

test("a tray call and its answer count only under the generation they were made under (3-E3)", () => {
  const answer = { ok: true, ops: [{ op: "setText", detail: "Ada's" }], generation: 4 };
  expect(trayAnswer(answer, 4, 4)).toBe(answer);
  // The account changed while the call was out: the late answer is not taken.
  expect(trayAnswer(answer, 4, 5)).toEqual({ ok: false, error: "page-changed" });
  // Answered under another generation than it was asked under.
  expect(trayAnswer({ ...answer, generation: 3 }, 4, 4)).toEqual({
    ok: false,
    error: "page-changed",
  });
  expect(trayAnswer(answer, null, null)).toEqual({ ok: false, error: "page-changed" });
  expect(trayCallAllowed({ op: "batchSend", generation: 4 }, 4)).toBe(true);
  expect(trayCallAllowed({ op: "batchSend", generation: 3 }, 4)).toBe(false);
  expect(trayCallAllowed({ op: "batchSend" }, 4)).toBe(false);
});
