/**
 * Session state — the durable identity that survives page reloads, service-
 * worker deaths, socket churn, and server restarts. Pure reducer functions;
 * the server shell owns all I/O (journal appends, ws sends, timers).
 */
import type { Hello, Work, WorkInput } from "@onlay/protocol";
import {
  type BoundedQueue,
  dropThrough,
  emptyQueue,
  type OutRecord,
  pushBounded,
  type QueueCaps,
  since,
} from "./queue";

export interface SessionState {
  sessionId: string;
  /** Extension-authoritative counters (identity lives in chrome.storage). */
  bootCount: number;
  swRestarts: number;
  connects: number;
  /** Last outbound seq assigned by this session. */
  lastSeq: number;
  /** Highest seq the extension has acknowledged. */
  lastAckSeq: number;
  /** Un-acked outbound work frames, oldest first, bounded. */
  outbound: BoundedQueue;
  createdAt: number;
  lastSeenAt: number;
}

/**
 * Apply a hello: create the session or resume it. The hello's `lastAckSeq`
 * is an implicit ack — frames the extension processed before its socket
 * (or worker) died.
 */
export function applyHello(
  prev: SessionState | undefined,
  hello: Hello,
  now: number,
): SessionState {
  const base: SessionState = prev ?? {
    sessionId: hello.sessionId,
    bootCount: 0,
    swRestarts: 0,
    connects: 0,
    lastSeq: 0,
    lastAckSeq: 0,
    outbound: emptyQueue(),
    createdAt: now,
    lastSeenAt: now,
  };
  const acked = ackUpTo(base, hello.lastAckSeq ?? 0);
  return {
    ...acked,
    bootCount: hello.bootCount,
    swRestarts: hello.swRestarts,
    connects: hello.connects,
    lastSeenAt: now,
  };
}

/** Assign the next seq and enqueue a work frame; overflow drops oldest. */
export function enqueue(
  s: SessionState,
  input: WorkInput,
  caps: QueueCaps,
  now: number,
): { state: SessionState; record: OutRecord; dropped: OutRecord[] } {
  const seq = s.lastSeq + 1;
  const frame = { ...input, seq } as Work;
  const record: OutRecord = { seq, frame, bytes: JSON.stringify(frame).length };
  const { queue, dropped } = pushBounded(s.outbound, record, caps);
  return {
    state: { ...s, lastSeq: seq, outbound: queue, lastSeenAt: now },
    record,
    dropped,
  };
}

/** Acknowledge every work frame with seq <= seq (clamped to lastSeq). */
export function ackUpTo(s: SessionState, seq: number): SessionState {
  const through = Math.min(seq, s.lastSeq);
  if (through <= s.lastAckSeq) return s;
  return {
    ...s,
    lastAckSeq: through,
    outbound: dropThrough(s.outbound, through),
  };
}

/** The frames to (re)send for a connection resuming from sinceAckSeq. */
export function framesToFlush(s: SessionState, sinceAckSeq: number): OutRecord[] {
  return since(s.outbound, sinceAckSeq);
}

/** Record liveness without any other state change. */
export function touch(s: SessionState, now: number): SessionState {
  return { ...s, lastSeenAt: now };
}
