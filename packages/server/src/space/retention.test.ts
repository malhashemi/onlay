import { afterEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { type CaptureStore, type CommitPart, makeCaptureStore } from "./capture-store";
import { sweepRetention } from "./retention";
import { ensureSchema } from "./schema";
import { SqliteDb } from "./testing/sqlite-db";

type Db = SqliteDb;

/**
 * Retention cascade (ADR-0022 §5.1): a resolved-past-window interaction drops
 * its captures + parts and decrements each blob's refcount PER-REFERENCING-PART
 * (Finding 2); the blob mark-sweep then reaps refcount-0 blobs. A blob shared by
 * two interactions survives the first purge and dies on the second. Open
 * interactions never purge.
 */

const dbs: Db[] = [];
afterEach(() => {
  for (const db of dbs.splice(0)) db.close();
});

const OLD = 1_000; // ancient timestamp — safely past every retention window

function fresh(): { db: Db; store: CaptureStore } {
  const db = new SqliteDb();
  ensureSchema(db);
  dbs.push(db);
  return { db, store: makeCaptureStore(db) };
}

const sha256 = (b: Uint8Array) => createHash("sha256").update(b).digest("hex");
function blob(text: string): { bytes: Uint8Array; sha: string } {
  const bytes = new TextEncoder().encode(text);
  return { bytes, sha: sha256(bytes) };
}
const part = (sha: string, byteLen: number, name = "file"): CommitPart => ({
  name,
  role: "file",
  mime: "application/octet-stream",
  byteLen,
  sha256: sha,
});

function commit(store: CaptureStore, interactionId: string, parts: CommitPart[]): void {
  const captureId = crypto.randomUUID();
  const r = store.commitCapture({
    captureId,
    interactionId,
    kind: "attachment",
    lineageId: captureId,
    capturedBy: "you",
    capturedFrom: "agent",
    format: "application/octet-stream",
    parts,
    totalBytes: parts.reduce((n, p) => n + p.byteLen, 0),
    now: OLD,
  });
  if (!r.ok) throw new Error(`commit failed: ${r.reason}`);
}

function insertInteraction(db: Db, id: string, resolvedAt: number | null): void {
  db.raw
    .query(
      "INSERT INTO interactions (id, kind, url, state, author_id, created_at, resolved_at, json) " +
        "VALUES (?, 'comment', 'http://x/p', 'open', 'you', ?, ?, '{}')",
    )
    .run(id, OLD, resolvedAt);
}

const refcountOf = (db: Db, sha: string): number | undefined =>
  (
    db.raw.query("SELECT refcount FROM capture_blobs WHERE hash = ?").get(sha) as {
      refcount: number;
    } | null
  )?.refcount;
const captureCount = (db: Db, interactionId: string): number =>
  (
    db.raw
      .query("SELECT COUNT(*) AS n FROM captures WHERE interaction_id = ?")
      .get(interactionId) as {
      n: number;
    }
  ).n;

const NOW = OLD + 400 * 86_400_000;
const sweep = (db: Db) => sweepRetention(db, NOW, { sessionDays: 0, retentionDays: 30 });

describe("retention: the capture cascade", () => {
  test("resolved-past-window interaction cascades captures/parts and sweeps its blob", () => {
    const { db, store } = fresh();
    const b = blob("evidence");
    store.putBlobStaged(b.sha, "text/plain", b.bytes, OLD);
    commit(store, "A", [part(b.sha, b.bytes.length)]);
    insertInteraction(db, "A", OLD);

    expect(captureCount(db, "A")).toBe(1);
    sweep(db);
    expect(captureCount(db, "A")).toBe(0);
    expect((db.raw.query("SELECT COUNT(*) AS n FROM capture_parts").get() as { n: number }).n).toBe(
      0,
    );
    expect(refcountOf(db, b.sha)).toBeUndefined(); // mark-swept
  });

  test("a blob shared by two interactions survives the first purge, dies on the second", () => {
    const { db, store } = fresh();
    const b = blob("shared");
    store.putBlobStaged(b.sha, "text/plain", b.bytes, OLD);
    commit(store, "A", [part(b.sha, b.bytes.length)]);
    commit(store, "B", [part(b.sha, b.bytes.length)]);
    expect(refcountOf(db, b.sha)).toBe(2);

    insertInteraction(db, "A", OLD); // A resolved-past-window
    insertInteraction(db, "B", null); // B still open
    sweep(db);
    expect(captureCount(db, "A")).toBe(0);
    expect(refcountOf(db, b.sha)).toBe(1); // survives — B still references it

    db.raw.query("UPDATE interactions SET resolved_at = ? WHERE id = 'B'").run(OLD);
    sweep(db);
    expect(captureCount(db, "B")).toBe(0);
    expect(refcountOf(db, b.sha)).toBeUndefined(); // last reference gone → swept
  });

  test("same bytes attached twice to ONE interaction → refcount drops by 2, blob swept (Finding 2)", () => {
    const { db, store } = fresh();
    const b = blob("twice");
    store.putBlobStaged(b.sha, "text/plain", b.bytes, OLD);
    commit(store, "C", [part(b.sha, b.bytes.length, "a"), part(b.sha, b.bytes.length, "b")]);
    expect(refcountOf(db, b.sha)).toBe(2);

    insertInteraction(db, "C", OLD);
    sweep(db);
    // Both references vanished → drop by 2, not stranded at refcount 1.
    expect(refcountOf(db, b.sha)).toBeUndefined();
  });

  test("reconcile-before-sweep: a corrupted stale-LOW refcount does not delete a still-referenced blob (Finding 7)", () => {
    const { db, store } = fresh();
    const b = blob("still-referenced");
    store.putBlobStaged(b.sha, "text/plain", b.bytes, OLD);
    commit(store, "E", [part(b.sha, b.bytes.length)]);
    insertInteraction(db, "E", null); // open — the capture (and its part) stays
    expect(refcountOf(db, b.sha)).toBe(1);

    // Simulate a crashed decrement: refcount is 0 though a part still references
    // it, and staged_at is ancient (past the TTL) — a sweep that ran BEFORE
    // reconciliation would delete these still-live bytes.
    db.raw.query("UPDATE capture_blobs SET refcount = 0 WHERE hash = ?").run(b.sha);
    sweep(db);
    // Reconciliation recomputed refcount = 1 from capture_parts first, so the
    // mark-sweep left the blob alone.
    expect(refcountOf(db, b.sha)).toBe(1);
    expect(captureCount(db, "E")).toBe(1);
  });

  test("an open interaction is never purged", () => {
    const { db, store } = fresh();
    const b = blob("open-evidence");
    store.putBlobStaged(b.sha, "text/plain", b.bytes, OLD);
    commit(store, "D", [part(b.sha, b.bytes.length)]);
    insertInteraction(db, "D", null); // open

    sweep(db);
    expect(captureCount(db, "D")).toBe(1);
    expect(refcountOf(db, b.sha)).toBe(1);
  });
});
