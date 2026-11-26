// Recovery of kept entries dropped from a snapshot (R3-C6).
import { expect, test } from "bun:test";
import { recoverKept } from "./kept-recovery";

const ids = (n: number) => Array.from({ length: n }, (_, i) => `k${i}`);

test("every listed id is read, page by page, past the old cap of 50", async () => {
  const read: string[] = [];
  const merges: number[] = [];
  await recoverKept(
    ids(120),
    async (id) => {
      read.push(id);
      return id;
    },
    () => true,
    (found) => merges.push(found.length),
  );
  expect(new Set(read).size).toBe(120);
  // Each page merges everything found so far.
  expect(merges).toEqual([50, 100, 120]);
});

test("a batch that loses its pin stops before the next read and merges nothing more", async () => {
  let pinned = true;
  const read: string[] = [];
  const merges: number[] = [];
  await recoverKept(
    ids(10),
    async (id) => {
      read.push(id);
      // The account changes (or the space is lost, or the page moves) mid-batch.
      if (read.length === 2) pinned = false;
      return id;
    },
    () => pinned,
    (found) => merges.push(found.length),
    { workers: 1 },
  );
  expect(read).toEqual(["k0", "k1"]);
  expect(merges).toEqual([]);
});

test("the pin is checked once more after the last read, before the merge", async () => {
  let reads = 0;
  let pinned = true;
  const merges: number[] = [];
  await recoverKept(
    ["a"],
    async (id) => {
      reads += 1;
      pinned = false; // lost while the read was in flight
      return id;
    },
    () => pinned,
    (found) => merges.push(found.length),
  );
  expect(reads).toBe(1);
  expect(merges).toEqual([]);
});
