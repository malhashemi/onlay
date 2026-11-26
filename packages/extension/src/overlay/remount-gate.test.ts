// Remounting a moved host is bounded and runs outside the observer (3b-C2).
import { expect, test } from "bun:test";
import { createRemountGate } from "./remount-gate";

test("remounts run deferred, once per burst, and stop for good past 3 in 10 seconds", () => {
  let t = 0;
  const deferred: Array<() => void> = [];
  let runs = 0;
  let allowed = 0;
  const gate = createRemountGate({
    now: () => t,
    defer: (fn) => deferred.push(fn),
    run: () => {
      runs += 1;
      if (gate.allow()) allowed += 1;
    },
  });
  // A page that wraps every new top-level element: each mount is noticed again.
  for (let i = 0; i < 10; i += 1) {
    gate.schedule();
    gate.schedule(); // the same burst asks twice: one run
    expect(runs).toBe(i < 4 ? i : 4);
    deferred.shift()?.();
    t += 100;
  }
  expect(allowed).toBe(3);
  expect(gate.down()).toBe(true);
  // Down for the page load: no more runs, even long after.
  t += 60_000;
  gate.schedule();
  expect(deferred).toEqual([]);
});

test("remounts spaced out over time are each allowed", () => {
  let t = 0;
  const gate = createRemountGate({ now: () => t, defer: (fn) => fn(), run: () => {} });
  for (let i = 0; i < 6; i += 1) {
    expect(gate.allow()).toBe(true);
    t += 4_000;
  }
  expect(gate.down()).toBe(false);
});
