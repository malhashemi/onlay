import { describe, expect, test } from "bun:test";
import { LIMITS } from "./limits";
import { parseInbound, parseOutbound } from "./parse";

/** A retired frame (the hosted server has no selection stream): refused now. */
const validSelection = {
  v: 1,
  type: "selection",
  url: "https://example.com/watch",
  selector: "div#player > .controls",
  tag: "div",
  id: "player",
  classes: ["controls", "visible"],
  textSnippet: "Play",
  rect: { x: 10, y: 20, width: 300, height: 40 },
  devicePixelRatio: 2,
  tabId: 7,
};

const validHello = {
  v: 1,
  type: "hello",
  sessionId: "6f0d1b2a-3c4d-4e5f-8a9b-0c1d2e3f4a5b",
  bootCount: 1,
  swRestarts: 0,
  connects: 1,
  lastAckSeq: 0,
};

describe("parseInbound", () => {
  test("valid hello parses", () => {
    const r = parseInbound(JSON.stringify(validHello));
    expect(r.ok).toBe(true);
    if (r.ok && r.msg.type === "hello") expect(r.msg.sessionId).toBe(validHello.sessionId);
  });

  test("hello without lastAckSeq parses (optional resume anchor)", () => {
    const { lastAckSeq: _omit, ...rest } = validHello;
    const r = parseInbound(JSON.stringify(rest));
    expect(r.ok).toBe(true);
  });

  test("hello with non-uuid sessionId rejected", () => {
    const r = parseInbound(JSON.stringify({ ...validHello, sessionId: "not-a-uuid" }));
    expect(r.ok).toBe(false);
  });

  test("the retired selection frame is refused", () => {
    expect(parseInbound(JSON.stringify(validSelection)).ok).toBe(false);
  });

  test("frame over MAX_FRAME_CHARS rejected before JSON.parse", () => {
    const raw = `{"pad":"${"x".repeat(LIMITS.MAX_FRAME_CHARS)}"}`;
    const r = parseInbound(raw);
    expect(r).toEqual({ ok: false, reason: "frame-too-large" });
  });

  test("junk JSON rejected", () => {
    expect(parseInbound("{nope")).toEqual({ ok: false, reason: "invalid-json" });
  });

  test("non-string frame rejected", () => {
    expect(parseInbound(new Uint8Array([1, 2, 3]))).toEqual({
      ok: false,
      reason: "non-string-frame",
    });
  });

  test("non-object payload rejected", () => {
    expect(parseInbound('"hello"').ok).toBe(false);
  });

  test("unknown type rejected", () => {
    expect(parseInbound(JSON.stringify({ v: 1, type: "teleport" })).ok).toBe(false);
  });

  test("ping parses; the retired ack is refused", () => {
    expect(parseInbound(JSON.stringify({ v: 1, type: "ping", t: 123 })).ok).toBe(true);
    expect(parseInbound(JSON.stringify({ v: 1, type: "ack", seq: 4 })).ok).toBe(false);
  });

  test("wrong protocol version rejected", () => {
    expect(parseInbound(JSON.stringify({ ...validHello, v: 2 })).ok).toBe(false);
  });
});

describe("parseOutbound", () => {
  test("the retired highlight and command frames are refused", () => {
    const highlight = { v: 1, type: "highlight", seq: 1, selector: "#a", color: "#22c55e" };
    expect(parseOutbound(JSON.stringify(highlight)).ok).toBe(false);
    expect(parseOutbound(JSON.stringify({ v: 1, type: "command", seq: 2, text: "hi" })).ok).toBe(
      false,
    );
  });

  test("welcome parses", () => {
    const r = parseOutbound(
      JSON.stringify({
        v: 1,
        type: "welcome",
        sessionId: validHello.sessionId,
        resumedFromSeq: 0,
        serverTime: Date.now(),
      }),
    );
    expect(r.ok).toBe(true);
  });

  test("inbound frame is not valid outbound", () => {
    expect(parseOutbound(JSON.stringify(validSelection)).ok).toBe(false);
  });
});
