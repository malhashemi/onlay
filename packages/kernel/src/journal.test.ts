import { describe, expect, test } from "bun:test";
import { untrusted } from "@onlay/protocol";
import { decodeEntry, encodeEntry, type JournalEntry, replay } from "./journal";

const SID_A = "6f0d1b2a-3c4d-4e5f-8a9b-0c1d2e3f4a5b";
const SID_B = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
const T0 = 1_750_000_000_000;

const helloEntry = (sessionId: string, over: Partial<Extract<JournalEntry, { k: "hello" }>> = {}) =>
  ({
    k: "hello",
    ts: T0,
    sessionId,
    bootCount: 1,
    swRestarts: 0,
    connects: 1,
    lastAckSeq: 0,
    ...over,
  }) satisfies JournalEntry;

const enqueueEntry = (sessionId: string, seq: number): JournalEntry => {
  const frame = { v: 1 as const, type: "highlight" as const, seq, selector: "#x", color: "#fff" };
  return {
    k: "enqueue",
    ts: T0 + seq,
    sessionId,
    record: { seq, frame, bytes: JSON.stringify(frame).length },
  };
};

describe("codec", () => {
  test("encode/decode round-trips every entry kind", () => {
    const entries: JournalEntry[] = [
      helloEntry(SID_A),
      {
        k: "selection",
        ts: T0,
        sessionId: SID_A,
        sel: {
          v: 1,
          type: "selection",
          url: untrusted("https://example.com"),
          selector: untrusted("#hero"),
          tag: untrusted("div"),
          id: untrusted("hero"),
          classes: [untrusted("a")],
          textSnippet: untrusted("hi"),
          rect: { x: 0, y: 0, width: 10, height: 10 },
          devicePixelRatio: 2,
        },
      },
      enqueueEntry(SID_A, 1),
      { k: "ack", ts: T0, sessionId: SID_A, seq: 1 },
      { k: "queue-truncated", ts: T0, sessionId: SID_A, droppedSeqs: [1, 2] },
      { k: "disconnect", ts: T0, sessionId: SID_A },
    ];
    for (const e of entries) {
      expect(decodeEntry(encodeEntry(e))).toEqual(e);
    }
  });

  test("garbage line decodes to null", () => {
    expect(decodeEntry("{truncated")).toBeNull();
    expect(decodeEntry("42")).toBeNull();
    expect(decodeEntry(JSON.stringify({ k: "unknown-kind", sessionId: SID_A, ts: T0 }))).toBeNull();
    expect(decodeEntry(JSON.stringify({ k: "hello", ts: T0 }))).toBeNull();
  });
});

describe("replay", () => {
  test("reconstructs multi-session state", () => {
    const lines = [
      encodeEntry(helloEntry(SID_A)),
      encodeEntry(helloEntry(SID_B, { connects: 5 })),
      encodeEntry(enqueueEntry(SID_A, 1)),
      encodeEntry(enqueueEntry(SID_A, 2)),
      encodeEntry(enqueueEntry(SID_B, 1)),
      encodeEntry({ k: "ack", ts: T0 + 10, sessionId: SID_A, seq: 1 }),
      encodeEntry({ k: "disconnect", ts: T0 + 11, sessionId: SID_B }),
    ];
    const sessions = replay(lines);
    expect(sessions.size).toBe(2);

    const a = sessions.get(SID_A);
    expect(a?.lastSeq).toBe(2);
    expect(a?.lastAckSeq).toBe(1);
    expect(a?.outbound.records.map((r) => r.seq)).toEqual([2]);

    const b = sessions.get(SID_B);
    expect(b?.connects).toBe(5);
    expect(b?.outbound.records.map((r) => r.seq)).toEqual([1]);
    expect(b?.lastSeenAt).toBe(T0 + 11);
  });

  test("a resume hello mid-journal applies its implicit ack", () => {
    const lines = [
      encodeEntry(helloEntry(SID_A)),
      encodeEntry(enqueueEntry(SID_A, 1)),
      encodeEntry(enqueueEntry(SID_A, 2)),
      encodeEntry(helloEntry(SID_A, { connects: 2, lastAckSeq: 2 })),
    ];
    const a = replay(lines).get(SID_A);
    expect(a?.lastAckSeq).toBe(2);
    expect(a?.outbound.records).toEqual([]);
    expect(a?.connects).toBe(2);
  });

  test("applies queue-truncated drops", () => {
    const lines = [
      encodeEntry(helloEntry(SID_A)),
      encodeEntry(enqueueEntry(SID_A, 1)),
      encodeEntry(enqueueEntry(SID_A, 2)),
      encodeEntry(enqueueEntry(SID_A, 3)),
      encodeEntry({ k: "queue-truncated", ts: T0 + 5, sessionId: SID_A, droppedSeqs: [1, 2] }),
    ];
    const a = replay(lines).get(SID_A);
    expect(a?.outbound.records.map((r) => r.seq)).toEqual([3]);
    expect(a?.outbound.queuedBytes).toBe(a?.outbound.records[0]?.bytes);
    expect(a?.lastSeq).toBe(3);
  });

  test("tolerates a truncated final line (crash mid-append)", () => {
    const lines = [
      encodeEntry(helloEntry(SID_A)),
      encodeEntry(enqueueEntry(SID_A, 1)),
      '{"k":"enqueue","sessionId":"6f0d1b2a-3c4d-4e5f-8a9b-0c1d2e3f',
    ];
    const a = replay(lines).get(SID_A);
    expect(a?.lastSeq).toBe(1);
    expect(a?.outbound.records.map((r) => r.seq)).toEqual([1]);
  });

  test("skips blank lines and events for unknown sessions", () => {
    const lines = [
      "",
      encodeEntry({ k: "ack", ts: T0, sessionId: SID_B, seq: 3 }),
      encodeEntry(helloEntry(SID_A)),
      "   ",
    ];
    const sessions = replay(lines);
    expect(sessions.size).toBe(1);
    expect(sessions.has(SID_A)).toBe(true);
  });
});
