import { describe, expect, test } from "bun:test";
import type { Hello } from "@onlay/protocol";
import type { QueueCaps } from "./queue";
import { ackUpTo, applyHello, enqueue, framesToFlush, type SessionState } from "./session";

const CAPS: QueueCaps = { maxFrames: 4, maxBytes: 4_096 };
const SID = "6f0d1b2a-3c4d-4e5f-8a9b-0c1d2e3f4a5b";
const NOW = 1_750_000_000_000;

const hello = (over: Partial<Hello> = {}): Hello => ({
  v: 1,
  type: "hello",
  sessionId: SID,
  bootCount: 1,
  swRestarts: 0,
  connects: 1,
  lastAckSeq: 0,
  ...over,
});

const highlight = (label: string) => ({
  v: 1 as const,
  type: "highlight" as const,
  selector: `#${label}`,
  color: "#22c55e",
});

function seeded(n: number): SessionState {
  let s = applyHello(undefined, hello(), NOW);
  for (let i = 0; i < n; i++) {
    s = enqueue(s, highlight(`e${i + 1}`), CAPS, NOW).state;
  }
  return s;
}

describe("applyHello", () => {
  test("creates a fresh session", () => {
    const s = applyHello(undefined, hello(), NOW);
    expect(s.sessionId).toBe(SID);
    expect(s.lastSeq).toBe(0);
    expect(s.lastAckSeq).toBe(0);
    expect(s.outbound.records).toEqual([]);
    expect(s.createdAt).toBe(NOW);
  });

  test("resume preserves seq state and adopts extension counters", () => {
    const before = seeded(2);
    const resumed = applyHello(
      before,
      hello({ bootCount: 1, swRestarts: 3, connects: 9, lastAckSeq: 0 }),
      NOW + 60_000,
    );
    expect(resumed.lastSeq).toBe(2);
    expect(resumed.swRestarts).toBe(3);
    expect(resumed.connects).toBe(9);
    expect(resumed.outbound.records.length).toBe(2);
    expect(resumed.createdAt).toBe(NOW);
  });

  test("hello's lastAckSeq acts as an implicit ack", () => {
    const before = seeded(3);
    const resumed = applyHello(before, hello({ lastAckSeq: 2 }), NOW + 1);
    expect(resumed.lastAckSeq).toBe(2);
    expect(resumed.outbound.records.map((r) => r.seq)).toEqual([3]);
  });
});

describe("enqueue", () => {
  test("assigns monotonic seqs starting at 1", () => {
    let s = applyHello(undefined, hello(), NOW);
    const first = enqueue(s, highlight("a"), CAPS, NOW);
    s = first.state;
    const second = enqueue(s, highlight("b"), CAPS, NOW);
    expect(first.record.seq).toBe(1);
    expect(second.record.seq).toBe(2);
    expect(second.state.lastSeq).toBe(2);
  });

  test("frame-count overflow drops oldest, stays within cap", () => {
    let s = seeded(CAPS.maxFrames);
    const r = enqueue(s, highlight("overflow"), CAPS, NOW);
    s = r.state;
    expect(r.dropped.map((d) => d.seq)).toEqual([1]);
    expect(s.outbound.records.length).toBe(CAPS.maxFrames);
    expect(s.outbound.records[0]?.seq).toBe(2);
    expect(s.outbound.records.at(-1)?.seq).toBe(CAPS.maxFrames + 1);
  });

  test("byte overflow drops oldest until within cap", () => {
    const tinyCaps: QueueCaps = { maxFrames: 100, maxBytes: 200 };
    let s = applyHello(undefined, hello(), NOW);
    s = enqueue(s, highlight("first-frame"), tinyCaps, NOW).state;
    s = enqueue(s, highlight("second-frame"), tinyCaps, NOW).state;
    const r = enqueue(s, highlight("third-frame"), tinyCaps, NOW);
    expect(r.dropped.length).toBeGreaterThan(0);
    expect(r.state.outbound.queuedBytes).toBeLessThanOrEqual(tinyCaps.maxBytes);
  });

  test("never drops the newly added record even when alone over the byte cap", () => {
    const cruelCaps: QueueCaps = { maxFrames: 100, maxBytes: 10 };
    const s = applyHello(undefined, hello(), NOW);
    const r = enqueue(s, highlight("survivor"), cruelCaps, NOW);
    expect(r.state.outbound.records.map((x) => x.seq)).toEqual([1]);
  });

  test("queuedBytes tracks the JSON-encoded sizes", () => {
    const s = seeded(2);
    const expected = s.outbound.records.reduce((n, r) => n + r.bytes, 0);
    expect(s.outbound.queuedBytes).toBe(expected);
  });
});

describe("ackUpTo", () => {
  test("drops the acked prefix", () => {
    const s = ackUpTo(seeded(3), 2);
    expect(s.lastAckSeq).toBe(2);
    expect(s.outbound.records.map((r) => r.seq)).toEqual([3]);
  });

  test("clamps beyond lastSeq", () => {
    const s = ackUpTo(seeded(2), 99);
    expect(s.lastAckSeq).toBe(2);
    expect(s.outbound.records).toEqual([]);
  });

  test("stale ack is a no-op returning the same state", () => {
    const s = ackUpTo(seeded(3), 2);
    expect(ackUpTo(s, 1)).toBe(s);
  });
});

describe("framesToFlush", () => {
  test("returns the un-acked suffix after sinceAckSeq, oldest first", () => {
    const s = seeded(4);
    expect(framesToFlush(s, 2).map((r) => r.seq)).toEqual([3, 4]);
  });

  test("returns everything for a client that acked nothing", () => {
    const s = seeded(3);
    expect(framesToFlush(s, 0).map((r) => r.seq)).toEqual([1, 2, 3]);
  });

  test("returns nothing when fully acked", () => {
    const s = ackUpTo(seeded(2), 2);
    expect(framesToFlush(s, 2)).toEqual([]);
  });
});
