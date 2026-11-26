import { describe, expect, test } from "bun:test";
import { agentWorkStatus, chipFor, isLiveState, KIND_LIST, KINDS } from "./kinds";

describe("kinds grammar", () => {
  test("every kind has a glyph and a hue class", () => {
    for (const spec of KIND_LIST) {
      expect(spec.glyph.paths.length).toBeGreaterThan(0);
      expect(spec.cls).toMatch(/^k-(comment|ask|change)$/);
    }
    expect(Object.keys(KINDS)).toEqual(["comment", "ask", "change"]);
  });

  test("isLiveState covers the live enum only", () => {
    for (const s of ["open", "answered", "kept", "working", "implemented", "verifying"]) {
      expect(isLiveState(s)).toBe(true);
    }
    for (const s of ["resolved", "dropped", "superseded"]) {
      expect(isLiveState(s)).toBe(false);
    }
  });

  test("chipFor prioritises needs-you, then resolved, then waiting", () => {
    expect(chipFor("open", true)).toBe("needs-you");
    expect(chipFor("open", false)).toBe("waiting");
    expect(chipFor("resolved", true)).toBe("resolved");
    expect(chipFor("dropped", false)).toBe("resolved");
  });

  test("agent work: an expired lease reads as pending; none reads as null", () => {
    const base = { requestedBy: "p_x", requestedAt: 1 };
    expect(agentWorkStatus(undefined)).toBeNull();
    expect(agentWorkStatus({ ...base, status: "pending" })).toBe("pending");
    expect(agentWorkStatus({ ...base, status: "taken", leaseUntil: 100 }, 50)).toBe("taken");
    expect(agentWorkStatus({ ...base, status: "taken", leaseUntil: 100 }, 150)).toBe("pending");
    expect(agentWorkStatus({ ...base, status: "answered" }, 150)).toBe("answered");
  });
});
