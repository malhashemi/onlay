// The quiet "Capture due" duty — pure decision model (Stage 2 §3, §6 test 7).
// No DOM: element/selection anchor + `s.resnap` present + live + on this page.
import { describe, expect, test } from "bun:test";
import type { RawInteractionSnapshot } from "@onlay/protocol";
import { captureDue, isCapturableAnchor, isCaptureDue, resnapOf } from "./resnap-model";

type Over = Partial<RawInteractionSnapshot> & {
  resnap?: { requestedBy: string; requestedAt: number };
};

const snap = (over: Over = {}): RawInteractionSnapshot => {
  const { resnap, ...rest } = over;
  const base: RawInteractionSnapshot = {
    id: "11111111-1111-4111-8111-111111111111",
    kind: "comment",
    url: "https://app.example.com/docs",
    anchor: { level: "element", selector: "main > p", blockId: "b1" },
    authorId: "adel",
    participants: ["adel"],
    waitingOn: [],
    state: "open",
    thread: [],
    createdAt: Date.now(),
    ...rest,
  };
  // `resnap` rides the frame in parallel (§2.4); attach it off-schema so the
  // model is pinned before/after the protocol field lands.
  return resnap ? ({ ...base, resnap } as RawInteractionSnapshot) : base;
};

const DUE = { requestedBy: "adel", requestedAt: 1_000 };

describe("resnapOf", () => {
  test("reads the pending duty, or undefined when none", () => {
    expect(resnapOf(snap({ resnap: DUE }))).toEqual(DUE);
    expect(resnapOf(snap())).toBeUndefined();
  });
});

describe("isCaptureDue", () => {
  test("true for a live element/selection anchor with a pending duty on this page", () => {
    expect(isCaptureDue(snap({ resnap: DUE }), "adel")).toBe(true);
    expect(
      isCaptureDue(
        snap({ anchor: { level: "selection", selector: "p", text: "x" }, resnap: DUE }),
        "adel",
      ),
    ).toBe(true);
  });

  test("false without a pending duty", () => {
    expect(isCaptureDue(snap(), "adel")).toBe(false);
  });

  test("false for a non-element/selection anchor (page / unanchored)", () => {
    expect(isCaptureDue(snap({ anchor: { level: "page" }, resnap: DUE }), "adel")).toBe(false);
    expect(isCaptureDue(snap({ anchor: { level: "unanchored" }, resnap: DUE }), "adel")).toBe(
      false,
    );
  });

  test("false when the interaction is closed (the duty is cleared server-side, §2.2)", () => {
    for (const state of ["resolved", "dropped", "superseded"]) {
      expect(isCaptureDue(snap({ state, resnap: DUE }), "adel")).toBe(false);
    }
  });

  test("URL match: due only on the interaction's exact page, fragment included", () => {
    const s = snap({ url: "https://app.example.com/docs", resnap: DUE });
    expect(isCaptureDue(s, "adel", "https://app.example.com/docs")).toBe(true);
    expect(isCaptureDue(s, "adel", "https://app.example.com/docs#top")).toBe(false);
    expect(isCaptureDue(s, "adel", "https://app.example.com/docs/adr")).toBe(false);
    // /docs-evil must never adopt /docs's duty (mirrors the kernel URL gate).
    expect(isCaptureDue(s, "adel", "https://app.example.com/docs-evil")).toBe(false);
    expect(isCaptureDue(s, "adel", "https://other.example.com/docs")).toBe(false);
  });
});

describe("isCapturableAnchor", () => {
  test("true only for element/selection anchors a Full client can re-capture", () => {
    expect(isCapturableAnchor(snap())).toBe(true); // element
    expect(
      isCapturableAnchor(snap({ anchor: { level: "selection", selector: "p", text: "x" } })),
    ).toBe(true);
  });

  test("false for page/unanchored places — no overlay capture path (fable-4)", () => {
    // The full-page request affordance keys off this so it never lights a duty no
    // §3 surface can discharge; the predicate ignores the pending-duty entirely.
    expect(isCapturableAnchor(snap({ anchor: { level: "page" } }))).toBe(false);
    expect(isCapturableAnchor(snap({ anchor: { level: "unanchored" } }))).toBe(false);
  });
});

describe("captureDue", () => {
  test("lists on-page due interactions, oldest request first", () => {
    const a = snap({ id: "a", resnap: { requestedBy: "x", requestedAt: 3_000 } });
    const b = snap({ id: "b", resnap: { requestedBy: "y", requestedAt: 1_000 } });
    const c = snap({ id: "c" }); // no duty
    const d = snap({ id: "d", anchor: { level: "page" }, resnap: DUE }); // page anchor
    expect(captureDue([a, b, c, d], "adel").map((s) => s.id)).toEqual(["b", "a"]);
  });

  test("empty when nothing is due", () => {
    expect(captureDue([snap(), snap({ state: "resolved", resnap: DUE })], "adel")).toEqual([]);
  });
});

describe("who takes a fresh look", () => {
  test("only the person who asked, or the author; every other viewer does nothing", () => {
    const s = snap({ authorId: "author", resnap: { requestedBy: "asker", requestedAt: 1 } });
    expect(isCaptureDue(s, "asker")).toBe(true);
    expect(isCaptureDue(s, "author")).toBe(true);
    expect(isCaptureDue(s, "bystander")).toBe(false);
    expect(isCaptureDue(s, null)).toBe(false);
    expect(captureDue([s], "bystander")).toEqual([]);
  });
});
