import { afterEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { type CaptureMeta, LIMITS } from "@onlay/protocol";
import { type CaptureStore, type CommitPart, makeCaptureStore } from "./capture-store";
import { ensureSchema } from "./schema";
import { SqliteDb } from "./testing/sqlite-db";

type Db = SqliteDb;

/**
 * Store-level substrate proofs (ADR-0022): content-address dedup, commit
 * write-ordering + atomicity, the orphan/staging sweep, series-cap prune-oldest
 * (incl. the per-referencing-part refcount rule, Finding 2), attachment-count
 * cap, quota accounting, refcount reconciliation, and blobs chunked into rows
 * of at most MAX_BLOB_CHUNK. The HTTP-observable guards live in captures.test.ts.
 */

const dbs: Db[] = [];
afterEach(() => {
  for (const db of dbs.splice(0)) db.close();
});

function freshStore(): { db: Db; store: CaptureStore } {
  const db = new SqliteDb();
  ensureSchema(db);
  dbs.push(db);
  return { db, store: makeCaptureStore(db) };
}

const sha256 = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
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

function commit(
  store: CaptureStore,
  over: {
    captureId?: string;
    interactionId?: string;
    kind?: "attachment" | "snapshot" | "edit-context";
    lineageId?: string;
    revision?: number;
    capturedBy?: string;
    parts: CommitPart[];
    totalBytes?: number;
    width?: number;
    height?: number;
    meta?: CaptureMeta;
    now?: number;
  },
) {
  const captureId = over.captureId ?? crypto.randomUUID();
  // `revision` is no longer a commit input — the store derives it in-tx as
  // `1 + MAX(revision)` over the lineage (F2). `over.revision` is accepted for
  // call-site readability but ignored here.
  return store.commitCapture({
    captureId,
    interactionId: over.interactionId ?? "int-A",
    kind: over.kind ?? "attachment",
    lineageId: over.lineageId ?? captureId,
    capturedBy: over.capturedBy ?? "you",
    capturedFrom: "agent",
    format: "application/octet-stream",
    parts: over.parts,
    totalBytes: over.totalBytes ?? over.parts.reduce((n, p) => n + p.byteLen, 0),
    ...(over.width !== undefined ? { width: over.width } : {}),
    ...(over.height !== undefined ? { height: over.height } : {}),
    ...(over.meta !== undefined ? { meta: over.meta } : {}),
    now: over.now ?? Date.now(),
  });
}

const refcountOf = (db: Db, sha: string): number | undefined =>
  (
    db.raw.query("SELECT refcount FROM capture_blobs WHERE hash = ?").get(sha) as {
      refcount: number;
    } | null
  )?.refcount;

describe("capture-store", () => {
  test("content-address dedup: same bytes → one blob at refcount 2", () => {
    const { db, store } = freshStore();
    const { bytes, sha } = blob("shared-evidence");
    const now = Date.now();

    expect(store.putBlobStaged(sha, "text/plain", bytes, now)).toBe(true);
    expect(store.putBlobStaged(sha, "text/plain", bytes, now)).toBe(false); // dedup no-op
    expect(commit(store, { interactionId: "A", parts: [part(sha, bytes.length)] }).ok).toBe(true);
    expect(commit(store, { interactionId: "B", parts: [part(sha, bytes.length)] }).ok).toBe(true);

    const rows = db.raw.query("SELECT hash, refcount FROM capture_blobs").all() as Array<{
      refcount: number;
    }>;
    expect(rows.length).toBe(1);
    expect(rows[0]?.refcount).toBe(2);
  });

  test("commit refuses a part whose blob was never staged (possession/presence)", () => {
    const { store } = freshStore();
    const { sha } = blob("never-uploaded");
    const r = commit(store, { parts: [part(sha, 12)] });
    expect(r).toEqual({ ok: false, reason: "incomplete" });
  });

  test("abandoned staged blob is swept only after the staging TTL", () => {
    const { db, store } = freshStore();
    const { bytes, sha } = blob("abandoned");
    const t0 = 1_000_000;
    store.putBlobStaged(sha, "text/plain", bytes, t0);

    expect(store.sweepOrphans(t0)).toBe(0); // staged_at == now, not past TTL
    expect(refcountOf(db, sha)).toBe(0);
    expect(store.sweepOrphans(t0 + LIMITS.STAGING_TTL_MS + 1)).toBe(1);
    expect(refcountOf(db, sha)).toBeUndefined();
  });

  test("orphan sweep restores staged global headroom (Finding 11)", () => {
    const { store } = freshStore();
    const t0 = 1_000_000;
    const { bytes, sha } = blob("headroom");
    store.putBlobStaged(sha, "text/plain", bytes, t0);
    expect(store.stagedGlobalBytes()).toBe(bytes.length); // counts against global staging
    store.sweepOrphans(t0 + LIMITS.STAGING_TTL_MS + 1);
    expect(store.stagedGlobalBytes()).toBe(0); // headroom freed once the orphan is reaped
  });

  test("series-cap prune-oldest drops the oldest revision, per-referencing-part (Finding 2)", () => {
    const { db, store } = freshStore();
    const now = Date.now();
    const lineage = "lin-1";
    // Revision 1 references ONE shared blob from TWO parts → refcount contribution 2.
    const shared = blob("rev1-shared");
    store.putBlobStaged(shared.sha, "text/plain", shared.bytes, now);
    expect(
      commit(store, {
        kind: "snapshot",
        interactionId: "S",
        lineageId: lineage,
        revision: 1,
        parts: [
          part(shared.sha, shared.bytes.length, "a"),
          part(shared.sha, shared.bytes.length, "b"),
        ],
      }).ok,
    ).toBe(true);
    expect(refcountOf(db, shared.sha)).toBe(2);

    // Fill the lineage up to the cap with unique-blob revisions.
    for (let r = 2; r <= LIMITS.MAX_CAPTURE_REVISIONS; r += 1) {
      const b = blob(`rev-${r}`);
      store.putBlobStaged(b.sha, "text/plain", b.bytes, now);
      expect(
        commit(store, {
          kind: "snapshot",
          interactionId: "S",
          lineageId: lineage,
          revision: r,
          parts: [part(b.sha, b.bytes.length)],
        }).ok,
      ).toBe(true);
    }
    // The (MAX+1)th revision prunes revision 1 before inserting.
    const last = blob("rev-last");
    store.putBlobStaged(last.sha, "text/plain", last.bytes, now);
    expect(
      commit(store, {
        kind: "snapshot",
        interactionId: "S",
        lineageId: lineage,
        revision: LIMITS.MAX_CAPTURE_REVISIONS + 1,
        parts: [part(last.sha, last.bytes.length)],
      }).ok,
    ).toBe(true);

    const count = (
      db.raw.query("SELECT COUNT(*) AS n FROM captures WHERE lineage_id = ?").get(lineage) as {
        n: number;
      }
    ).n;
    expect(count).toBe(LIMITS.MAX_CAPTURE_REVISIONS);
    // Both of revision 1's references vanished → refcount dropped by 2, not 1.
    expect(refcountOf(db, shared.sha)).toBe(0);
  });

  test("attachment-count cap REFUSES at MAX_CAPTURES_PER_INTERACTION (never prunes evidence)", () => {
    const { store } = freshStore();
    const now = Date.now();
    for (let i = 0; i < LIMITS.MAX_CAPTURES_PER_INTERACTION; i += 1) {
      const b = blob(`att-${i}`);
      store.putBlobStaged(b.sha, "text/plain", b.bytes, now);
      expect(commit(store, { interactionId: "C", parts: [part(b.sha, b.bytes.length)] }).ok).toBe(
        true,
      );
    }
    const over = blob("att-over");
    store.putBlobStaged(over.sha, "text/plain", over.bytes, now);
    expect(
      commit(store, { interactionId: "C", parts: [part(over.sha, over.bytes.length)] }),
    ).toEqual({ ok: false, reason: "too-many" });
  });

  test("per-actor + global quota accounting and 413 behavior", () => {
    const { db, store } = freshStore();
    const now = Date.now();
    const b = blob("quota-seed");
    store.putBlobStaged(b.sha, "text/plain", b.bytes, now);
    // Declared totalBytes drives quota (the API caps it; the store trusts it).
    const nearLimit = LIMITS.MAX_CAPTURE_QUOTA_ACTOR_BYTES - 10;
    expect(
      commit(store, {
        interactionId: "Q",
        capturedBy: "big",
        parts: [part(b.sha, b.bytes.length)],
        totalBytes: nearLimit,
      }).ok,
    ).toBe(true);
    expect(store.committedActorBytes("big")).toBe(nearLimit);
    expect(store.usage("big").actor.usedBytes).toBe(nearLimit);

    const b2 = blob("quota-over");
    store.putBlobStaged(b2.sha, "text/plain", b2.bytes, now);
    const r = commit(store, {
      interactionId: "Q",
      capturedBy: "big",
      parts: [part(b2.sha, b2.bytes.length)],
      totalBytes: 100,
    });
    expect(r.ok).toBe(false);
    if (!r.ok && r.reason === "quota") {
      expect(r.scope).toBe("actor");
      expect(r.limitBytes).toBe(LIMITS.MAX_CAPTURE_QUOTA_ACTOR_BYTES);
    } else {
      throw new Error(`expected actor quota refusal, got ${JSON.stringify(r)}`);
    }
    // The rejected capture left no row and did not bump the blob refcount.
    expect(store.committedActorBytes("big")).toBe(nearLimit);
    expect(refcountOf(db, b2.sha)).toBe(0);
  });

  test("commit over the GLOBAL quota → 413 quota scope global (Finding 11)", () => {
    const { store } = freshStore();
    const now = Date.now();
    // Fill the global ceiling with 8 actors each at their full 256 MiB actor cap
    // (8 × 256 MiB = 2 GiB = global limit) — declared totals, tiny real bytes.
    const perActor = LIMITS.MAX_CAPTURE_QUOTA_ACTOR_BYTES;
    const actors = LIMITS.MAX_CAPTURE_QUOTA_GLOBAL_BYTES / perActor;
    for (let i = 0; i < actors; i += 1) {
      const b = blob(`global-fill-${i}`);
      store.putBlobStaged(b.sha, "text/plain", b.bytes, now);
      expect(
        commit(store, {
          interactionId: `GF-${i}`,
          capturedBy: `filler-${i}`,
          parts: [part(b.sha, b.bytes.length)],
          totalBytes: perActor,
        }).ok,
      ).toBe(true);
    }
    // A fresh actor, far under their OWN actor quota, is refused on the global cap.
    const y = blob("global-over");
    store.putBlobStaged(y.sha, "text/plain", y.bytes, now);
    const r = commit(store, {
      interactionId: "GY",
      capturedBy: "latecomer",
      parts: [part(y.sha, y.bytes.length)],
      totalBytes: 1,
    });
    expect(r.ok).toBe(false);
    if (!r.ok && r.reason === "quota") {
      expect(r.scope).toBe("global");
      expect(r.limitBytes).toBe(LIMITS.MAX_CAPTURE_QUOTA_GLOBAL_BYTES);
    } else {
      throw new Error(`expected global quota refusal, got ${JSON.stringify(r)}`);
    }
  });

  test("boot refcount reconciliation repairs a corrupted count", () => {
    const { db, store } = freshStore();
    const { bytes, sha } = blob("reconcile");
    store.putBlobStaged(sha, "text/plain", bytes, Date.now());
    expect(commit(store, { parts: [part(sha, bytes.length)] }).ok).toBe(true);
    expect(refcountOf(db, sha)).toBe(1);

    db.raw.query("UPDATE capture_blobs SET refcount = 99 WHERE hash = ?").run(sha);
    store.reconcileRefcounts();
    expect(refcountOf(db, sha)).toBe(1);
  });

  test("listForInteraction is newest-first and thumbless; readPart is interaction-scoped", () => {
    const { store } = freshStore();
    const a = blob("older");
    const c = blob("newer");
    store.putBlobStaged(a.sha, "text/plain", a.bytes, 1);
    store.putBlobStaged(c.sha, "text/plain", c.bytes, 1);
    const older = crypto.randomUUID();
    const newer = crypto.randomUUID();
    commit(store, {
      captureId: older,
      interactionId: "L",
      parts: [part(a.sha, a.bytes.length)],
      now: 1_000,
    });
    commit(store, {
      captureId: newer,
      interactionId: "L",
      parts: [part(c.sha, c.bytes.length)],
      now: 2_000,
    });

    const refs = store.listForInteraction("L");
    expect(refs.map((r) => r.captureId)).toEqual([newer, older]);
    for (const r of refs) {
      expect(JSON.stringify(r)).not.toContain("bytes");
      expect(JSON.stringify(r)).not.toContain("thumb");
    }
    // A part is reachable through its OWNING interaction, and only that one.
    expect(store.readPart("L", newer, "file")?.byteLen).toBe(c.bytes.length);
    expect(store.readPart("OTHER", newer, "file")).toBeNull();
  });

  test("listForInteraction hard-caps at MAX_CAPTURES_PER_INTERACTION (Finding 11)", () => {
    const { db, store } = freshStore();
    // Insert MORE than the cap directly (the write-time count cap refuses at the
    // ceiling, so bypass it) to prove the read-side SQL LIMIT actually bounds the
    // derived array that rides every frame.
    const n = LIMITS.MAX_CAPTURES_PER_INTERACTION + 5;
    const insert = db.raw.query(
      "INSERT INTO captures (id, interaction_id, kind, lineage_id, revision, captured_by, " +
        "captured_from, format, caption, total_bytes, meta_json, created_at) " +
        "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
    );
    for (let i = 0; i < n; i += 1) {
      const id = crypto.randomUUID();
      insert.run(id, "CAP", "attachment", id, 1, "you", "agent", "text/plain", null, 0, "{}", i);
    }
    expect(store.listForInteraction("CAP").length).toBe(LIMITS.MAX_CAPTURES_PER_INTERACTION);
  });
});

describe("capture-store edit-context lineage + revision (D8/F2)", () => {
  const gz = (s: string) => {
    const { bytes, sha } = blob(s);
    return { bytes, sha, part: part(sha, bytes.length, "document") };
  };

  test("in-tx revision derives 1 + MAX(revision); same lineage increments, fresh lineage resets", () => {
    const { store } = freshStore();
    const now = Date.now();
    const lineage = "edit:target-abc";
    for (let i = 1; i <= 3; i += 1) {
      const b = gz(`edit-${i}`);
      store.putBlobStaged(b.sha, "application/gzip", b.bytes, now);
      const r = commit(store, {
        kind: "edit-context",
        interactionId: "E",
        lineageId: lineage,
        parts: [b.part],
        now,
      });
      expect(r.ok).toBe(true);
      if (r.ok) expect(r.ref.revision).toBe(i); // 1, 2, 3 — NOT count-based
    }
    // A different target key on the same interaction is a fresh lineage → rev 1.
    const other = gz("other");
    store.putBlobStaged(other.sha, "application/gzip", other.bytes, now);
    const r = commit(store, {
      kind: "edit-context",
      interactionId: "E",
      lineageId: "edit:target-xyz",
      parts: [other.part],
      now,
    });
    expect(r.ok && r.ref.revision).toBe(1);
  });

  test("revision keeps incrementing AFTER prune-oldest — no repeat (F2)", () => {
    const { store } = freshStore();
    const now = Date.now();
    const lineage = "edit:pruned";
    const revisions: number[] = [];
    // Push MAX + 3 revisions; prune-oldest keeps the row count at the cap but
    // the revision number must never re-use a value a count-based scheme would.
    for (let i = 0; i < LIMITS.MAX_CAPTURE_REVISIONS + 3; i += 1) {
      const b = gz(`prune-${i}`);
      store.putBlobStaged(b.sha, "application/gzip", b.bytes, now);
      const r = commit(store, {
        kind: "edit-context",
        interactionId: "P",
        lineageId: lineage,
        parts: [b.part],
        now: now + i,
      });
      expect(r.ok).toBe(true);
      if (r.ok) revisions.push(r.ref.revision);
    }
    // Strictly monotonic 1..MAX+3 — a count-based revision would have plateaued
    // at MAX and repeated numbers once prune stabilized the count.
    expect(revisions).toEqual(
      Array.from({ length: LIMITS.MAX_CAPTURE_REVISIONS + 3 }, (_, i) => i + 1),
    );
    // The surviving lineage is capped, and its newest revision is the last one.
    const live = store.listForInteraction("P").filter((c) => c.lineageId === lineage);
    expect(live.length).toBe(LIMITS.MAX_CAPTURE_REVISIONS);
    expect(Math.max(...live.map((c) => c.revision))).toBe(LIMITS.MAX_CAPTURE_REVISIONS + 3);
    // (lineage, revision) stays unique — no two survivors share a revision.
    expect(new Set(live.map((c) => c.revision)).size).toBe(live.length);
  });

  test("a snap:<id> lineage self-bounds at the cap, prune-oldest, monotonic revisions (Stage 2 / §6 test 5)", () => {
    const { db, store } = freshStore();
    const now = Date.now();
    const lineage = "snap:int-S";
    const revisions: number[] = [];
    const shas: string[] = [];
    // A snapshot lineage inherits the generic per-lineage prune untouched — the
    // ordered look history IS the revision series, capped at MAX_CAPTURE_REVISIONS.
    const extra = 4;
    for (let i = 0; i < LIMITS.MAX_CAPTURE_REVISIONS + extra; i += 1) {
      const b = gz(`snap-${i}`);
      shas.push(b.sha);
      store.putBlobStaged(b.sha, "application/gzip", b.bytes, now);
      const r = commit(store, {
        kind: "snapshot",
        interactionId: "int-S",
        lineageId: lineage,
        parts: [b.part],
        now: now + i,
      });
      expect(r.ok).toBe(true);
      if (r.ok) revisions.push(r.ref.revision);
    }
    // Strictly monotonic 1..MAX+extra — never a repeat (1 + MAX(revision), not count).
    expect(revisions).toEqual(
      Array.from({ length: LIMITS.MAX_CAPTURE_REVISIONS + extra }, (_, i) => i + 1),
    );
    const live = store.listForInteraction("int-S").filter((c) => c.lineageId === lineage);
    expect(live.length).toBe(LIMITS.MAX_CAPTURE_REVISIONS);
    // The most-recent 10 survive; the oldest `extra` (revisions 1..extra) were pruned.
    expect(Math.max(...live.map((c) => c.revision))).toBe(LIMITS.MAX_CAPTURE_REVISIONS + extra);
    expect(Math.min(...live.map((c) => c.revision))).toBe(extra + 1);
    // Pruned revisions' blobs decremented to refcount 0; survivors hold refcount 1.
    for (let i = 0; i < extra; i += 1) expect(refcountOf(db, shas[i] as string)).toBe(0);
    for (let i = extra; i < shas.length; i += 1) expect(refcountOf(db, shas[i] as string)).toBe(1);
    // The refcount-0 pruned blobs sweep once past the staging TTL.
    expect(store.sweepOrphans(now + LIMITS.STAGING_TTL_MS + 1)).toBe(extra);
  });

  test("meta persists into meta_json and derives residue/rects/width/height onto the ref", () => {
    const { store } = freshStore();
    const now = Date.now();
    const b = gz("flattened");
    store.putBlobStaged(b.sha, "application/gzip", b.bytes, now);
    const meta: CaptureMeta = {
      targetKey: "t".repeat(32),
      viewport: { innerWidth: 1280, innerHeight: 800, dpr: 2, layoutWidth: 1280 },
      blockRect: { x: 10, y: 20, width: 300, height: 150 },
      habitatRect: { x: 0, y: 0, width: 1280, height: 600 },
      residue: [
        { class: "declined-grant", origin: "https://cdn.example.com", detail: "cross-origin" },
        { class: "closed-shadow-root", count: 2 },
      ],
      captureMs: 321,
      quiescence: "settled",
    };
    const r = commit(store, {
      kind: "edit-context",
      interactionId: "M",
      lineageId: `edit:${meta.targetKey}`,
      parts: [b.part],
      width: meta.blockRect?.width ?? 0,
      height: meta.blockRect?.height ?? 0,
      meta,
      now,
    });
    expect(r.ok).toBe(true);
    const ref = store.listForInteraction("M")[0];
    if (!ref) throw new Error("no ref");
    expect(ref.viewport).toEqual(meta.viewport);
    expect(ref.blockRect).toEqual(meta.blockRect);
    expect(ref.habitatRect).toEqual(meta.habitatRect);
    // width/height derive from the block rect (block dims without a doc fetch).
    expect(ref.width).toBe(300);
    expect(ref.height).toBe(150);
    // The ref residue is the COMPACT summary — class + origin only, no detail/count.
    expect(ref.residue).toEqual([
      { class: "declined-grant", origin: "https://cdn.example.com" },
      { class: "closed-shadow-root" },
    ]);
    // The commit-returned ref agrees with the later listForInteraction ref.
    if (r.ok) expect(r.ref.residue).toEqual(ref.residue);
  });

  test("an attachment ref carries no viewport/residue and its lineage is single-revision", () => {
    const { store } = freshStore();
    const now = Date.now();
    const b = blob("attach");
    store.putBlobStaged(b.sha, "image/png", b.bytes, now);
    const r = commit(store, { parts: [part(b.sha, b.bytes.length)], width: 4, height: 4, now });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.ref.revision).toBe(1);
      expect(r.ref.viewport).toBeUndefined();
      expect(r.ref.residue).toBeUndefined();
      expect(r.ref.width).toBe(4);
    }
  });
});

describe("capture-store chunked blobs (spec §7)", () => {
  test("a blob above 1 MiB is stored in MAX_BLOB_CHUNK rows and reads back byte-exact", () => {
    const { db, store } = freshStore();
    const bytes = new Uint8Array(LIMITS.MAX_BLOB_CHUNK * 2 + 12_345);
    for (let i = 0; i < bytes.length; i++) bytes[i] = (i * 31 + 7) & 0xff;
    const sha = sha256(bytes);
    expect(store.putBlobStaged(sha, "application/octet-stream", bytes, 1)).toBe(true);
    const chunks = db.all<{ idx: number; n: number }>(
      "SELECT idx, length(bytes) AS n FROM capture_blob_chunks WHERE hash = ? ORDER BY idx",
      sha,
    );
    expect(chunks.map((c) => c.n)).toEqual([LIMITS.MAX_BLOB_CHUNK, LIMITS.MAX_BLOB_CHUNK, 12_345]);
    expect(commit(store, { interactionId: "int-A", parts: [part(sha, bytes.length)] }).ok).toBe(
      true,
    );
    const ref = store.listForInteraction("int-A")[0];
    const read = store.readPart("int-A", ref?.captureId ?? "", "file");
    expect(read?.byteLen).toBe(bytes.length);
    expect(sha256(read?.bytes ?? new Uint8Array())).toBe(sha);
  });

  test("staging twice stores one set of chunks; the orphan sweep removes chunks with the blob", () => {
    const { db, store } = freshStore();
    const bytes = new Uint8Array(LIMITS.MAX_BLOB_CHUNK + 1).fill(9);
    const sha = sha256(bytes);
    expect(store.putBlobStaged(sha, "application/octet-stream", bytes, 1)).toBe(true);
    expect(store.putBlobStaged(sha, "application/octet-stream", bytes, 2)).toBe(false);
    const count = () =>
      db.get<{ n: number }>("SELECT COUNT(*) AS n FROM capture_blob_chunks WHERE hash = ?", sha)?.n;
    expect(count()).toBe(2);
    expect(store.sweepOrphans(1 + LIMITS.STAGING_TTL_MS + 1)).toBe(1);
    expect(count()).toBe(0);
    expect(store.blobExists(sha)).toBe(false);
  });
});

describe("declared lengths (review finding 10)", () => {
  test("a part whose declared length differs from the stored blob does not commit", () => {
    const { store } = freshStore();
    const b = blob("witness bytes");
    store.putBlobStaged(b.sha, "image/png", b.bytes, 1);
    const r = commit(store, {
      parts: [part(b.sha, b.bytes.length, "witness"), part(b.sha, b.bytes.length + 9, "thumbnail")],
      totalBytes: b.bytes.length * 2 + 9,
    });
    expect(r).toEqual({ ok: false, reason: "length-mismatch" });
    expect(store.countForInteraction("int-A")).toBe(0);
  });
});
