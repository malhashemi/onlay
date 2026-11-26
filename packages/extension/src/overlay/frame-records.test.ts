import { expect, test } from "bun:test";
import { acceptReported, silentDocuments } from "./frame-records";

const A = "s_aaaaaaaaaaaaaaaaaaaa";
const B = "s_bbbbbbbbbbbbbbbbbbbb";
const snap = (id: string, spaceId: string) => ({ id, spaceId, url: "https://f.example/" });

test("a space's snapshots taken before the newest access change told to the top frame are dropped (3-F5)", () => {
  const known = new Map([
    [A, 3],
    [B, 1],
  ]);
  const kept = acceptReported(
    [snap("1", A), snap("2", B), snap("3", A)],
    { [A]: 2, [B]: 1 },
    (sp) => known.get(sp) ?? 0,
    () => true,
  );
  // A's are from before revision 3 (a guest's share went): only B's stay.
  expect(kept.map((s) => s.id)).toEqual(["2"]);
  // Re-reported after the change: kept.
  expect(
    acceptReported(
      [snap("1", A)],
      { [A]: 3 },
      (sp) => known.get(sp) ?? 0,
      () => true,
    ).length,
  ).toBe(1);
});

test("a report without a revision for a space, or of an unknown space, keeps nothing of it", () => {
  expect(
    acceptReported(
      [snap("1", A)],
      {},
      () => 0,
      () => true,
    ),
  ).toEqual([]);
  expect(
    acceptReported(
      [snap("1", A)],
      { [A]: 0 },
      () => 0,
      () => false,
    ),
  ).toEqual([]);
  expect(
    acceptReported(
      [{ id: "x" }, null, 3],
      { [A]: 0 },
      () => 0,
      () => true,
    ),
  ).toEqual([]);
});

test("every record of a document silent past the limit goes: reports, opened threads, a pick (3-F5)", () => {
  const heard = new Map([
    ["reported", 100_000],
    ["picked", 40_000],
  ]);
  // "opened" was never heard from by report: its record expires like the rest.
  expect(
    silentDocuments(["reported", "picked", "opened", "picked"], heard, 110_000, 60_000),
  ).toEqual(["picked", "opened"]);
});
