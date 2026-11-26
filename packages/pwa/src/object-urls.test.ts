// The cache contract that kills the refresh flicker: the SAME capture revision
// yields the SAME blob: URL across repaints; a new revision mints anew; the
// LRU revokes what it evicts. URL.createObjectURL is stubbed — these tests run
// without a DOM.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { cachedPartUrl, partUrlKey } from "./object-urls";

const g = globalThis as unknown as { URL: typeof URL };
const realCreate = g.URL.createObjectURL;
const realRevoke = g.URL.revokeObjectURL;

let minted = 0;
let revoked: string[] = [];

beforeEach(() => {
  minted = 0;
  revoked = [];
  g.URL.createObjectURL = (() => `blob:test-${++minted}`) as typeof URL.createObjectURL;
  g.URL.revokeObjectURL = ((u: string) => {
    revoked.push(u);
  }) as typeof URL.revokeObjectURL;
});

afterEach(() => {
  g.URL.createObjectURL = realCreate;
  g.URL.revokeObjectURL = realRevoke;
});

const bytes = new Uint8Array([1, 2, 3]);
// Unique per test run — the cache is module-lifetime, keys must not collide
// across tests (that longevity is the feature under test).
let seq = 0;
const freshId = (): string => `cap-${Date.now()}-${++seq}`;

describe("cachedPartUrl", () => {
  test("same key → same URL, minted once (a repaint never re-decodes)", () => {
    const key = partUrlKey("i1", { captureId: freshId(), revision: 1 }, "witness");
    const first = cachedPartUrl(key, bytes, "image/webp");
    const again = cachedPartUrl(key, bytes, "image/webp");
    expect(again).toBe(first);
    expect(minted).toBe(1);
  });

  test("a new revision is a new key → a new URL (resnap still swaps in)", () => {
    const capA = { captureId: freshId(), revision: 1 };
    const capB = { captureId: freshId(), revision: 1 }; // new lineage row = new captureId
    const a = cachedPartUrl(partUrlKey("i1", capA, "witness"), bytes, "image/webp");
    const b = cachedPartUrl(partUrlKey("i1", capB, "witness"), bytes, "image/webp");
    expect(a).not.toBe(b);
  });

  test("LRU eviction revokes the coldest URL; a re-request re-mints", () => {
    const cold = partUrlKey("evict", { captureId: freshId(), revision: 1 }, "witness");
    const coldUrl = cachedPartUrl(cold, bytes, "image/webp");
    // Flood past the 48-entry bound so `cold` (untouched since) must evict.
    for (let i = 0; i < 60; i++) {
      cachedPartUrl(partUrlKey("evict", { captureId: freshId(), revision: 1 }, "w"), bytes, "x");
    }
    expect(revoked).toContain(coldUrl);
    const reminted = cachedPartUrl(cold, bytes, "image/webp");
    expect(reminted).not.toBe(coldUrl);
  });
});
