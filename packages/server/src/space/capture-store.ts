import { type CaptureMeta, type CaptureRef, LIMITS } from "@onlay/protocol";
import type { Db, SqlValue } from "./ports";

/**
 * The capture substrate store (ADR-0022): content-addressed, refcounted blobs
 * plus capture manifest rows and their parts, all in the space's SQLite. Blob
 * bytes are split into `capture_blob_chunks` rows of at most
 * `LIMITS.MAX_BLOB_CHUNK` bytes (spec §7), so a blob and its chunks are staged,
 * counted and pruned inside the same single transactions as before. Bytes
 * NEVER inflate the snapshot JSON or wake frames — frames carry thumbless
 * `CaptureRef` descriptors (§9) derived here at frame-build time.
 *
 * Refcount discipline (the atomicity + orphan story ADR-0022 §Consequences
 * demands): a blob lands at refcount 0 (staged) on part upload; commit bumps it
 * to >=1 in one transaction; retention/prune decrements per-referencing-part;
 * the daily retention alarm reaps refcount-0 blobs past the staging TTL, and
 * reconciles refcounts first so a crashed decrement can never permanently
 * leak or over-delete.
 */

export type CaptureSourceKind = CaptureRef["capturedFrom"];

/** One part of a capture at commit time — mime is the SNIFFED mime (§3.4). */
export interface CommitPart {
  name: string;
  role: CaptureRef["parts"][number]["role"];
  mime: string;
  byteLen: number;
  sha256: string;
}

export interface CommitInput {
  captureId: string;
  interactionId: string;
  kind: CaptureRef["kind"];
  /** The D8 lineage: `captureId` (attachment / single-revision) or `edit:<targetKey>`. */
  lineageId: string;
  capturedBy: string;
  capturedFrom: CaptureSourceKind;
  format: string;
  caption?: string;
  parts: CommitPart[];
  totalBytes: number;
  width?: number;
  height?: number;
  /** Validated manifest `meta` (§1.8) — persisted into `meta_json`, derived onto the ref. */
  meta?: CaptureMeta;
  now: number;
}

export type CommitResult =
  | { ok: true; ref: CaptureRef }
  | { ok: false; reason: "incomplete" }
  | { ok: false; reason: "too-many" }
  | { ok: false; reason: "length-mismatch" }
  | {
      ok: false;
      reason: "quota";
      scope: "actor" | "global";
      usedBytes: number;
      limitBytes: number;
    };

export interface CaptureUsage {
  actor: { usedBytes: number; limitBytes: number };
  global: { usedBytes: number; limitBytes: number };
}

export interface CaptureStore {
  /** Stage a blob at refcount 0, chunked (idempotent). Returns true if newly stored. */
  putBlobStaged(hash: string, mime: string, bytes: Uint8Array, now: number): boolean;
  /** test oracle — no production caller; commit uses its own prepared statements. */
  blobExists(hash: string): boolean;
  /** Sum of refcount-0 (staged/orphan) blob bytes — the global staged footprint. */
  stagedGlobalBytes(): number;
  committedActorBytes(personId: string): number;
  committedGlobalBytes(): number;
  /** test oracle — no production caller; commit uses its own prepared statements. */
  countForInteraction(interactionId: string): number;
  commitCapture(input: CommitInput): CommitResult;
  /** One committed capture's ref, reachable only through its interaction. */
  refById(interactionId: string, captureId: string): CaptureRef | null;
  /** Newest-first CaptureRefs for an interaction (thumbless, capped). */
  listForInteraction(interactionId: string): CaptureRef[];
  /** One part's bytes, reachable ONLY through the owning interaction (§4). */
  readPart(
    interactionId: string,
    captureId: string,
    name: string,
  ): { mime: string; byteLen: number; bytes: Uint8Array<ArrayBuffer> } | null;
  usage(personId: string): CaptureUsage;
  /** Reap refcount-0 blobs (and their chunks) older than the staging TTL. Returns blobs removed. */
  sweepOrphans(now: number): number;
  /** Integrity: recompute every blob's refcount from capture_parts. */
  reconcileRefcounts(): void;
}

/** Thrown inside the commit tx to force a rollback with a typed reason. */
class CommitAbort extends Error {
  constructor(readonly result: Exclude<CommitResult, { ok: true }>) {
    super(result.reason);
  }
}

type CaptureRow = {
  id: string;
  interaction_id: string;
  kind: string;
  lineage_id: string;
  revision: number;
  captured_by: string;
  captured_from: string;
  format: string;
  caption: string | null;
  total_bytes: number;
  meta_json: string;
  created_at: number;
};

type PartRow = {
  name: string;
  role: string;
  mime: string;
  byte_len: number;
  blob_hash: string;
};

export function makeCaptureStore(db: Db): CaptureStore {
  const num = (sql: string, ...args: SqlValue[]): number =>
    Number(db.get<{ n: number }>(sql, ...args)?.n ?? 0);
  const blobPresent = (hash: string) =>
    db.get("SELECT 1 AS present FROM capture_blobs WHERE hash = ?", hash) !== undefined;
  const actorBytes = (personId: string) =>
    num("SELECT COALESCE(SUM(total_bytes), 0) AS n FROM captures WHERE captured_by = ?", personId);
  const globalBytes = () => num("SELECT COALESCE(SUM(total_bytes), 0) AS n FROM captures");
  const countByInteraction = (interactionId: string) =>
    num("SELECT COUNT(*) AS n FROM captures WHERE interaction_id = ?", interactionId);
  const oldestId = (sql: string, ...args: SqlValue[]): string | undefined =>
    db.get<{ id: string }>(sql, ...args)?.id;
  const partsOf = (captureId: string) =>
    db.all<PartRow>(
      "SELECT name, role, mime, byte_len, blob_hash FROM capture_parts WHERE capture_id = ?",
      captureId,
    );

  /** Delete one capture: refcount-- per referencing PART (Finding 2), then rows. */
  function purgeCapture(captureId: string): void {
    for (const p of partsOf(captureId)) {
      db.run("UPDATE capture_blobs SET refcount = refcount - 1 WHERE hash = ?", p.blob_hash);
    }
    db.run("DELETE FROM capture_parts WHERE capture_id = ?", captureId);
    db.run("DELETE FROM captures WHERE id = ?", captureId);
  }

  /** What `meta_json` may hold: the derived width/height plus the §1.8 meta. */
  type StoredMeta = {
    width?: number;
    height?: number;
  } & Pick<
    CaptureMeta,
    | "viewport"
    | "blockRect"
    | "habitatRect"
    | "residue"
    | "variantSetId"
    | "variantId"
    | "variantVersion"
  >;

  /**
   * Parse the persisted `meta_json` and derive the compact fields the ref
   * carries: width/height, viewport, block/habitat rects, the closed-enum
   * residue summary and the variant-look identity. Everything here comes from
   * our own commit-time JSON; a corrupt row degrades to an empty derivation.
   */
  function derivedRefFields(
    metaJson: string,
  ): Pick<
    CaptureRef,
    | "width"
    | "height"
    | "viewport"
    | "blockRect"
    | "habitatRect"
    | "residue"
    | "variantSetId"
    | "variantId"
    | "variantVersion"
  > {
    let m: StoredMeta;
    try {
      m = JSON.parse(metaJson) as StoredMeta;
    } catch {
      return {};
    }
    const residue = Array.isArray(m.residue)
      ? m.residue
          .slice(0, LIMITS.MAX_RESIDUE_ENTRIES)
          .map((e) => ({ class: e.class, ...(e.origin ? { origin: e.origin } : {}) }))
      : undefined;
    return {
      ...(typeof m.width === "number" ? { width: m.width } : {}),
      ...(typeof m.height === "number" ? { height: m.height } : {}),
      ...(m.viewport ? { viewport: m.viewport } : {}),
      ...(m.blockRect ? { blockRect: m.blockRect } : {}),
      ...(m.habitatRect ? { habitatRect: m.habitatRect } : {}),
      ...(residue && residue.length > 0 ? { residue } : {}),
      ...(typeof m.variantSetId === "string" ? { variantSetId: m.variantSetId } : {}),
      ...(typeof m.variantId === "string" ? { variantId: m.variantId } : {}),
      ...(typeof m.variantVersion === "number" ? { variantVersion: m.variantVersion } : {}),
    };
  }

  function refOf(row: CaptureRow): CaptureRef {
    const parts = partsOf(row.id).map((p) => ({
      name: p.name,
      role: p.role as CaptureRef["parts"][number]["role"],
      mime: p.mime,
      byteLen: Number(p.byte_len),
    }));
    return {
      captureId: row.id,
      interactionId: row.interaction_id,
      kind: row.kind as CaptureRef["kind"],
      lineageId: row.lineage_id,
      revision: Number(row.revision),
      capturedAt: Number(row.created_at),
      capturedBy: row.captured_by,
      capturedFrom: row.captured_from as CaptureSourceKind,
      format: row.format,
      totalBytes: Number(row.total_bytes),
      parts,
      ...derivedRefFields(row.meta_json),
      ...(row.caption != null ? { caption: row.caption } : {}),
    };
  }

  /** Reassemble a blob from its chunks, in order. */
  function blobBytes(hash: string, byteLen: number): Uint8Array<ArrayBuffer> | null {
    const chunks = db.all<{ bytes: Uint8Array }>(
      "SELECT bytes FROM capture_blob_chunks WHERE hash = ? ORDER BY idx ASC",
      hash,
    );
    const out = new Uint8Array(byteLen);
    let offset = 0;
    for (const c of chunks) {
      if (offset + c.bytes.byteLength > byteLen) return null;
      out.set(c.bytes, offset);
      offset += c.bytes.byteLength;
    }
    return offset === byteLen ? out : null;
  }

  return {
    putBlobStaged(hash, mime, bytes, now) {
      return db.transaction(() => {
        if (blobPresent(hash)) return false;
        db.run(
          "INSERT INTO capture_blobs (hash, mime, byte_len, refcount, staged_at) VALUES (?, ?, ?, 0, ?)",
          hash,
          mime,
          bytes.byteLength,
          now,
        );
        let idx = 0;
        for (let off = 0; off < bytes.byteLength; off += LIMITS.MAX_BLOB_CHUNK) {
          db.run(
            "INSERT INTO capture_blob_chunks (hash, idx, bytes) VALUES (?, ?, ?)",
            hash,
            idx++,
            bytes.slice(off, off + LIMITS.MAX_BLOB_CHUNK),
          );
        }
        return true;
      });
    },
    blobExists(hash) {
      return blobPresent(hash);
    },
    stagedGlobalBytes() {
      return num("SELECT COALESCE(SUM(byte_len), 0) AS n FROM capture_blobs WHERE refcount = 0");
    },
    committedActorBytes(personId) {
      return actorBytes(personId);
    },
    committedGlobalBytes() {
      return globalBytes();
    },
    countForInteraction(interactionId) {
      return countByInteraction(interactionId);
    },
    commitCapture(input) {
      try {
        const ref = db.transaction((): CaptureRef => {
          // (a) Possession/presence: every part's blob must actually be stored
          //     (the caller PUT+hash-verified it). A swept/never-uploaded blob
          //     leaves the commit incomplete — nothing persists.
          for (const p of input.parts) {
            const stored = db.get<{ byte_len: number }>(
              "SELECT byte_len FROM capture_blobs WHERE hash = ?",
              p.sha256,
            );
            if (!stored) throw new CommitAbort({ ok: false, reason: "incomplete" });
            // The declared length is charged and served: it must be the stored blob's.
            if (Number(stored.byte_len) !== p.byteLen) {
              throw new CommitAbort({ ok: false, reason: "length-mismatch" });
            }
          }
          // (b) Per-person + space byte quota on committed bytes. A
          // variant-look at the ceiling first reclaims its own kind on THIS
          // interaction (oldest varlook revisions) before refusing — automatic
          // witnesses must never permanently starve human-authored evidence.
          let usedActor = actorBytes(input.capturedBy);
          if (
            input.kind === "variant-look" &&
            usedActor + input.totalBytes > LIMITS.MAX_CAPTURE_QUOTA_ACTOR_BYTES
          ) {
            const oldest = oldestId(
              "SELECT id FROM captures WHERE interaction_id = ? AND kind = 'variant-look' " +
                "AND captured_by = ? ORDER BY created_at ASC, id ASC LIMIT 1",
              input.interactionId,
              input.capturedBy,
            );
            if (oldest) {
              purgeCapture(oldest);
              usedActor = actorBytes(input.capturedBy);
            }
          }
          if (usedActor + input.totalBytes > LIMITS.MAX_CAPTURE_QUOTA_ACTOR_BYTES) {
            throw new CommitAbort({
              ok: false,
              reason: "quota",
              scope: "actor",
              usedBytes: usedActor,
              limitBytes: LIMITS.MAX_CAPTURE_QUOTA_ACTOR_BYTES,
            });
          }
          const usedGlobal = globalBytes();
          if (usedGlobal + input.totalBytes > LIMITS.MAX_CAPTURE_QUOTA_GLOBAL_BYTES) {
            throw new CommitAbort({
              ok: false,
              reason: "quota",
              scope: "global",
              usedBytes: usedGlobal,
              limitBytes: LIMITS.MAX_CAPTURE_QUOTA_GLOBAL_BYTES,
            });
          }
          // (c) Series-cap prune-oldest for revisioned lineages.
          const lineageCount = num(
            "SELECT COUNT(*) AS n FROM captures WHERE interaction_id = ? AND lineage_id = ?",
            input.interactionId,
            input.lineageId,
          );
          if (lineageCount >= LIMITS.MAX_CAPTURE_REVISIONS) {
            const oldest = oldestId(
              "SELECT id FROM captures WHERE interaction_id = ? AND lineage_id = ? " +
                "ORDER BY revision ASC LIMIT 1",
              input.interactionId,
              input.lineageId,
            );
            if (oldest) purgeCapture(oldest);
          }
          // Interaction-wide count cap: attachments are evidence (refuse, never
          // prune); a variant-look is a freshness product, so at the cap it
          // prunes the oldest variant-look interaction-wide first (F30).
          let count = countByInteraction(input.interactionId);
          if (count >= LIMITS.MAX_CAPTURES_PER_INTERACTION && input.kind === "variant-look") {
            const oldest = oldestId(
              "SELECT id FROM captures WHERE interaction_id = ? AND kind = 'variant-look' " +
                "ORDER BY created_at ASC, id ASC LIMIT 1",
              input.interactionId,
            );
            if (oldest) {
              purgeCapture(oldest);
              count = countByInteraction(input.interactionId);
            }
          }
          if (count >= LIMITS.MAX_CAPTURES_PER_INTERACTION) {
            throw new CommitAbort({ ok: false, reason: "too-many" });
          }
          // Revision is derived HERE, inside the tx and AFTER prune-oldest (F2):
          // `1 + MAX(revision)` over the lineage.
          const revision =
            num(
              "SELECT COALESCE(MAX(revision), 0) AS n FROM captures WHERE interaction_id = ? AND lineage_id = ?",
              input.interactionId,
              input.lineageId,
            ) + 1;
          // (d) refcount++ then insert the capture row and its parts.
          for (const p of input.parts) {
            db.run("UPDATE capture_blobs SET refcount = refcount + 1 WHERE hash = ?", p.sha256);
          }
          const m = input.meta;
          const meta = JSON.stringify({
            ...(input.width !== undefined ? { width: input.width } : {}),
            ...(input.height !== undefined ? { height: input.height } : {}),
            ...(m?.viewport ? { viewport: m.viewport } : {}),
            ...(m?.blockRect ? { blockRect: m.blockRect } : {}),
            ...(m?.habitatRect ? { habitatRect: m.habitatRect } : {}),
            ...(m?.residue && m.residue.length > 0 ? { residue: m.residue } : {}),
            ...(m?.targetKey ? { targetKey: m.targetKey } : {}),
            ...(m?.captureMs !== undefined ? { captureMs: m.captureMs } : {}),
            ...(m?.quiescence ? { quiescence: m.quiescence } : {}),
            ...(m?.variantSetId ? { variantSetId: m.variantSetId } : {}),
            ...(m?.variantId ? { variantId: m.variantId } : {}),
            ...(m?.variantVersion !== undefined ? { variantVersion: m.variantVersion } : {}),
          });
          db.run(
            "INSERT INTO captures (id, interaction_id, kind, lineage_id, revision, captured_by, " +
              "captured_from, format, caption, total_bytes, meta_json, created_at) " +
              "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
            input.captureId,
            input.interactionId,
            input.kind,
            input.lineageId,
            revision,
            input.capturedBy,
            input.capturedFrom,
            input.format,
            input.caption ?? null,
            input.totalBytes,
            meta,
            input.now,
          );
          for (const p of input.parts) {
            db.run(
              "INSERT INTO capture_parts (capture_id, name, role, mime, byte_len, blob_hash) " +
                "VALUES (?, ?, ?, ?, ?, ?)",
              input.captureId,
              p.name,
              p.role,
              p.mime,
              p.byteLen,
              p.sha256,
            );
          }
          return {
            captureId: input.captureId,
            interactionId: input.interactionId,
            kind: input.kind,
            lineageId: input.lineageId,
            revision,
            capturedAt: input.now,
            capturedBy: input.capturedBy,
            capturedFrom: input.capturedFrom,
            format: input.format,
            totalBytes: input.totalBytes,
            parts: input.parts.map((p) => ({
              name: p.name,
              role: p.role,
              mime: p.mime,
              byteLen: p.byteLen,
            })),
            ...derivedRefFields(meta),
            ...(input.caption !== undefined ? { caption: input.caption } : {}),
          };
        });
        return { ok: true, ref };
      } catch (err) {
        if (err instanceof CommitAbort) return err.result;
        throw err;
      }
    },
    refById(interactionId, captureId) {
      const row = db.get<CaptureRow>(
        "SELECT id, interaction_id, kind, lineage_id, revision, captured_by, captured_from, format, " +
          "caption, total_bytes, meta_json, created_at FROM captures WHERE interaction_id = ? AND id = ?",
        interactionId,
        captureId,
      );
      return row ? refOf(row) : null;
    },
    listForInteraction(interactionId) {
      return db
        .all<CaptureRow>(
          "SELECT id, interaction_id, kind, lineage_id, revision, captured_by, captured_from, format, " +
            "caption, total_bytes, meta_json, created_at FROM captures WHERE interaction_id = ? " +
            "ORDER BY created_at DESC, id DESC LIMIT ?",
          interactionId,
          LIMITS.MAX_CAPTURES_PER_INTERACTION,
        )
        .map(refOf);
    },
    readPart(interactionId, captureId, name) {
      const row = db.get<{ mime: string; byte_len: number; blob_hash: string }>(
        "SELECT p.mime AS mime, p.byte_len AS byte_len, p.blob_hash AS blob_hash " +
          "FROM capture_parts p JOIN captures c ON c.id = p.capture_id " +
          "WHERE c.interaction_id = ? AND p.capture_id = ? AND p.name = ?",
        interactionId,
        captureId,
        name,
      );
      if (!row) return null;
      const bytes = blobBytes(row.blob_hash, Number(row.byte_len));
      if (!bytes) return null;
      return { mime: row.mime, byteLen: Number(row.byte_len), bytes };
    },
    usage(personId) {
      return {
        actor: {
          usedBytes: actorBytes(personId),
          limitBytes: LIMITS.MAX_CAPTURE_QUOTA_ACTOR_BYTES,
        },
        global: { usedBytes: globalBytes(), limitBytes: LIMITS.MAX_CAPTURE_QUOTA_GLOBAL_BYTES },
      };
    },
    sweepOrphans(now) {
      return db.transaction(() => sweepOrphanBlobs(db, now - LIMITS.STAGING_TTL_MS));
    },
    reconcileRefcounts() {
      reconcileBlobRefcounts(db);
    },
  };
}

/** Recompute every blob's refcount from the parts that reference it. */
export function reconcileBlobRefcounts(db: Db): void {
  db.run(
    "UPDATE capture_blobs SET refcount = " +
      "(SELECT COUNT(*) FROM capture_parts WHERE blob_hash = capture_blobs.hash)",
  );
}

/** Delete refcount-0 blobs staged before `cutoff`, chunks first. Returns blobs removed. */
export function sweepOrphanBlobs(db: Db, cutoff: number): number {
  const n = Number(
    db.get<{ n: number }>(
      "SELECT COUNT(*) AS n FROM capture_blobs WHERE refcount <= 0 AND staged_at < ?",
      cutoff,
    )?.n ?? 0,
  );
  if (n === 0) return 0;
  db.run(
    "DELETE FROM capture_blob_chunks WHERE hash IN " +
      "(SELECT hash FROM capture_blobs WHERE refcount <= 0 AND staged_at < ?)",
    cutoff,
  );
  db.run("DELETE FROM capture_blobs WHERE refcount <= 0 AND staged_at < ?", cutoff);
  return n;
}

/**
 * Derived, thumbless CaptureRefs for one interaction — the `anchorExcerpt`
 * pattern (§6): read at frame-build time, never journaled, never bytes. The
 * three frame-build sites (WS state, wake digest, by-id read) call this.
 */
export function captureRefsFor(store: CaptureStore, interactionId: string): CaptureRef[] {
  return store.listForInteraction(interactionId);
}
