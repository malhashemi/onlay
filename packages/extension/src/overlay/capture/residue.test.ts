import { expect, test } from "bun:test";
import { CAPTURE_LIMITS } from "./limits";
import { RESIDUE_CLASSES, type ResidueClass, type ResidueEntry, ResidueLog } from "./residue";

test("seed absorbs pre-deduped entries preserving counts/origins, then keeps accumulating", () => {
  const walker: ResidueEntry[] = [
    { class: "canvas-video-content", count: 2 },
    { class: "declined-grant", origin: "https://a.example" },
  ];
  const log = new ResidueLog();
  log.seed(walker);
  // a later pipeline leg keeps accumulating onto the same log
  log.add("canvas-video-content"); // → count 3
  log.declinedGrant("https://a.example"); // dup origin — no new entry
  log.declinedGrant("https://b.example"); // new origin
  const out = log.toArray();
  expect(out.find((e) => e.class === "canvas-video-content")?.count).toBe(3);
  const declined = out.filter((e) => e.class === "declined-grant");
  expect(declined.map((e) => e.origin).sort()).toEqual(["https://a.example", "https://b.example"]);
});

test("the closed enum is exactly the 12 spec §6 classes and the 8 reasons a screenshot was dropped", () => {
  expect(RESIDUE_CLASSES.length).toBe(20);
  expect(new Set(RESIDUE_CLASSES).size).toBe(20);
  const expected: ResidueClass[] = [
    "closed-shadow-root",
    "shadow-scoped-rules",
    "declined-grant",
    "security-error",
    "stripped-url",
    "unfetchable-asset",
    "generated-content-lost",
    "quiescence-timeout",
    "oversize-truncation",
    "canvas-video-content",
    "cross-origin-frame",
    "flat-raster",
    "screenshot-covered",
    "screenshot-see-through",
    "screenshot-foreign-frame",
    "screenshot-page-changed",
    "screenshot-unplaced",
    "screenshot-transformed",
    "screenshot-scaled",
    "screenshot-inner-frame",
  ];
  expect([...RESIDUE_CLASSES].sort()).toEqual(expected.sort());
});

test("declined-grant is deduped per origin, keeping one entry each", () => {
  const log = new ResidueLog();
  log.declinedGrant("https://cdn.example.com");
  log.declinedGrant("https://cdn.example.com"); // dup — dropped
  log.declinedGrant("https://fonts.example.net");
  const out = log.toArray();
  const declined = out.filter((e) => e.class === "declined-grant");
  expect(declined.length).toBe(2);
  expect(declined.map((e) => e.origin).sort()).toEqual([
    "https://cdn.example.com",
    "https://fonts.example.net",
  ]);
});

test("non-declined classes dedup by class with a running count", () => {
  const log = new ResidueLog();
  log.add("stripped-url");
  log.add("stripped-url");
  log.add("stripped-url");
  log.add("closed-shadow-root");
  const out = log.toArray();
  const stripped = out.find((e) => e.class === "stripped-url");
  expect(stripped?.count).toBe(3);
  expect(out.find((e) => e.class === "closed-shadow-root")?.count).toBe(1);
});

test("excess declined origins collapse into one counted, origin-less entry", () => {
  const log = new ResidueLog();
  const n = CAPTURE_LIMITS.MAX_RESIDUE_ORIGINS + 3;
  for (let i = 0; i < n; i += 1) log.declinedGrant(`https://o${i}.example.com`);
  const out = log.toArray();
  const declined = out.filter((e) => e.class === "declined-grant");
  const withOrigin = declined.filter((e) => e.origin);
  const collapsed = declined.filter((e) => !e.origin);
  expect(withOrigin.length).toBe(CAPTURE_LIMITS.MAX_RESIDUE_ORIGINS);
  expect(collapsed.length).toBe(1);
  expect(collapsed[0]?.count).toBe(3);
});

test("the entry list is bounded to MAX_RESIDUE_ENTRIES and detail is clamped", () => {
  const log = new ResidueLog();
  log.add("oversize-truncation", { detail: "x".repeat(200) });
  for (let i = 0; i < CAPTURE_LIMITS.MAX_RESIDUE_ENTRIES + 5; i += 1) {
    log.declinedGrant(`https://o${i}.example.com`);
  }
  const out = log.toArray();
  expect(out.length).toBeLessThanOrEqual(CAPTURE_LIMITS.MAX_RESIDUE_ENTRIES);
  const detail = out.find((e) => e.class === "oversize-truncation")?.detail;
  expect(detail?.length).toBe(CAPTURE_LIMITS.MAX_RESIDUE_DETAIL);
});

test("isEmpty reflects the 'Captured from the live page.' state", () => {
  const log = new ResidueLog();
  expect(log.isEmpty()).toBe(true);
  log.add("quiescence-timeout");
  expect(log.isEmpty()).toBe(false);
});

test("has() reads a recorded class, including declined-grant's origin family (F31)", () => {
  const log = new ResidueLog();
  expect(log.has("flat-raster")).toBe(false);
  log.add("flat-raster");
  expect(log.has("flat-raster")).toBe(true);
  expect(log.has("security-error")).toBe(false);
  log.declinedGrant("https://a.example");
  expect(log.has("declined-grant")).toBe(true);
});

test("why a screenshot was dropped is said once, first reason kept, and never cut by the entry cap (L-3)", () => {
  const log = new ResidueLog();
  // Every other class first: the cap would cut whatever came last.
  for (const c of RESIDUE_CLASSES)
    if (!c.startsWith("screenshot-") && c !== "declined-grant") log.add(c);
  log.declinedGrant("https://a.example");
  log.screenshotDropped("screenshot-see-through");
  log.screenshotDropped("screenshot-covered");
  const out = log.toArray();
  expect(out.length).toBe(CAPTURE_LIMITS.MAX_RESIDUE_ENTRIES);
  expect(out[0]).toEqual({ class: "screenshot-see-through", count: 1 });
  expect(out.filter((e) => e.class.startsWith("screenshot-"))).toHaveLength(1);
});
