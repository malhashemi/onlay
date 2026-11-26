/**
 * Journal codec — the durable substrate. One JSONL line per state-changing
 * event; `replay` folds lines back into session state on boot. Decode
 * returns null for an undecodable line (a crash mid-append truncates the
 * final line; durability means tolerating that, not preventing it).
 *
 * Pure codec only — file I/O lives in the server shell.
 */
import type { OutRecord } from "./queue";
import { ackUpTo, applyHello, type SessionState, touch } from "./session";

export type JournalEntry =
  | {
      k: "hello";
      ts: number;
      sessionId: string;
      bootCount: number;
      swRestarts: number;
      connects: number;
      lastAckSeq: number;
    }
  /** Written by the local broker's selection stream; still decoded, never written now. */
  | { k: "selection"; ts: number; sessionId: string; sel: unknown }
  | { k: "enqueue"; ts: number; sessionId: string; record: OutRecord }
  | { k: "ack"; ts: number; sessionId: string; seq: number }
  | { k: "queue-truncated"; ts: number; sessionId: string; droppedSeqs: number[] }
  | { k: "disconnect"; ts: number; sessionId: string };

const KINDS = new Set(["hello", "selection", "enqueue", "ack", "queue-truncated", "disconnect"]);

export function encodeEntry(e: JournalEntry): string {
  return JSON.stringify(e);
}

export function decodeEntry(line: string): JournalEntry | null {
  let data: unknown;
  try {
    data = JSON.parse(line);
  } catch {
    return null;
  }
  if (typeof data !== "object" || data === null) return null;
  const e = data as Record<string, unknown>;
  if (typeof e.k !== "string" || !KINDS.has(e.k)) return null;
  if (typeof e.sessionId !== "string" || typeof e.ts !== "number") return null;
  return data as JournalEntry;
}

/** Fold journal lines into session state. Skips undecodable lines. */
export function replay(lines: Iterable<string>): Map<string, SessionState> {
  const sessions = new Map<string, SessionState>();
  for (const line of lines) {
    if (line.trim() === "") continue;
    const e = decodeEntry(line);
    if (e === null) continue;
    const prev = sessions.get(e.sessionId);
    switch (e.k) {
      case "hello": {
        sessions.set(
          e.sessionId,
          applyHello(
            prev,
            {
              v: 1,
              type: "hello",
              sessionId: e.sessionId,
              bootCount: e.bootCount,
              swRestarts: e.swRestarts,
              connects: e.connects,
              lastAckSeq: e.lastAckSeq,
            },
            e.ts,
          ),
        );
        break;
      }
      case "selection": {
        if (prev) sessions.set(e.sessionId, touch(prev, e.ts));
        break;
      }
      case "enqueue": {
        if (!prev) break;
        // Direct re-append: caps were already applied at write time and any
        // drops were journaled as queue-truncated entries.
        sessions.set(e.sessionId, {
          ...prev,
          lastSeq: Math.max(prev.lastSeq, e.record.seq),
          outbound: {
            records: [...prev.outbound.records, e.record],
            queuedBytes: prev.outbound.queuedBytes + e.record.bytes,
          },
          lastSeenAt: e.ts,
        });
        break;
      }
      case "queue-truncated": {
        if (!prev) break;
        const drop = new Set(e.droppedSeqs);
        const records = prev.outbound.records.filter((r) => !drop.has(r.seq));
        sessions.set(e.sessionId, {
          ...prev,
          outbound: { records, queuedBytes: records.reduce((n, r) => n + r.bytes, 0) },
          lastSeenAt: e.ts,
        });
        break;
      }
      case "ack": {
        if (prev) sessions.set(e.sessionId, touch(ackUpTo(prev, e.seq), e.ts));
        break;
      }
      case "disconnect": {
        if (prev) sessions.set(e.sessionId, touch(prev, e.ts));
        break;
      }
    }
  }
  return sessions;
}
