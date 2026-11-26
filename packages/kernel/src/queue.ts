/**
 * Bounded outbound-queue policy — knows nothing about sessions. The queue
 * exists because the MV3 service-worker socket drops every few seconds
 * (Prototype 0: ~33 reconnects/5min): an agent→browser frame issued during a
 * gap MUST be buffered and flushed on reconnect, or it is silently lost.
 *
 * Overflow policy (maker decision): drop-oldest, surfaced to the caller so
 * the journal records a `queue-truncated` marker.
 */
import type { Work } from "@onlay/protocol";

export interface OutRecord {
  seq: number;
  frame: Work;
  /** JSON-encoded size, used for the byte cap. */
  bytes: number;
}

export interface QueueCaps {
  maxFrames: number;
  maxBytes: number;
}

export interface BoundedQueue {
  records: OutRecord[];
  queuedBytes: number;
}

export const emptyQueue = (): BoundedQueue => ({ records: [], queuedBytes: 0 });

/** Append a record, dropping oldest records until within caps. Never drops the new record. */
export function pushBounded(
  q: BoundedQueue,
  rec: OutRecord,
  caps: QueueCaps,
): { queue: BoundedQueue; dropped: OutRecord[] } {
  const records = [...q.records, rec];
  let queuedBytes = q.queuedBytes + rec.bytes;
  const dropped: OutRecord[] = [];
  while (records.length > 1 && (records.length > caps.maxFrames || queuedBytes > caps.maxBytes)) {
    // biome-ignore lint/style/noNonNullAssertion: length > 1 guarantees a head
    const oldest = records.shift()!;
    queuedBytes -= oldest.bytes;
    dropped.push(oldest);
  }
  return { queue: { records, queuedBytes }, dropped };
}

/** Drop every record with seq <= through (they are acknowledged). */
export function dropThrough(q: BoundedQueue, through: number): BoundedQueue {
  const records = q.records.filter((r) => r.seq > through);
  const queuedBytes = records.reduce((n, r) => n + r.bytes, 0);
  return { records, queuedBytes };
}

/** Records with seq > since, oldest first — the flush set for a reconnect. */
export function since(q: BoundedQueue, sinceSeq: number): OutRecord[] {
  return q.records.filter((r) => r.seq > sinceSeq);
}
