// Access to a space changed (3b-C9).
import { expect, test } from "bun:test";
import { type AccessChangedDeps, onAccessChanged } from "./access-changed";

function rig(open: { id: string; spaceId: string } | null, answer: "ok" | "not_found") {
  const log: string[] = [];
  const deps: AccessChangedDeps = {
    cancelKept: (s) => log.push(`cancel:${s}`),
    openThread: () => open,
    readById: (s, id, gone) => {
      log.push(`read:${s}/${id}`);
      if (answer === "not_found") gone();
    },
    closeIfStill: (id) => log.push(`close:${id}`),
    resync: () => log.push("resync"),
  };
  return { deps, log };
}

test("the space's kept recovery stops, and an open thread that is now gone closes", () => {
  const { deps, log } = rig({ id: "t1", spaceId: "s1" }, "not_found");
  onAccessChanged("s1", deps);
  expect(log).toEqual(["cancel:s1", "read:s1/t1", "close:t1", "resync"]);
});

test("an open thread still readable stays open", () => {
  const { deps, log } = rig({ id: "t1", spaceId: "s1" }, "ok");
  onAccessChanged("s1", deps);
  expect(log).not.toContain("close:t1");
});

test("a thread of another space is not re-read", () => {
  const { deps, log } = rig({ id: "t2", spaceId: "s2" }, "not_found");
  onAccessChanged("s1", deps);
  expect(log).toEqual(["cancel:s1", "resync"]);
});
