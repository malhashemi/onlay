import { LIMITS } from "@onlay/protocol";
import { reconcileBlobRefcounts, sweepOrphanBlobs } from "./capture-store";
import type { Db } from "./ports";

/**
 * Retention sweeps over the space's SQLite, run by the daily Durable Object
 * alarm. Live interactions NEVER expire (attention debt must not rot away);
 * resolved and dropped ones purge 30 days after resolution, with their
 * journal, captured markup and captures. Idle sessions purge after 14 days;
 * resolved variant sets after 30. Blob refcounts are reconciled before the
 * orphan sweep, so a crashed decrement can never delete a referenced blob.
 */
export interface RetentionResult {
  sessionsRemoved: number;
  variantSetsRemoved: number;
  interactionsRemoved: number;
  blobsRemoved: number;
  /** The interactions removed, for the edge to drop their D1 shares. */
  removedInteractionIds: string[];
}

const DAY = 86_400_000;
/** How long the space remembers a revoked credential (generations it keeps). */
const REVOCATION_KEEP_DAYS = 31;

export interface RetentionOptions {
  sessionDays: number;
  retentionDays: number;
}

const DEFAULT_RETENTION: RetentionOptions = { sessionDays: 14, retentionDays: 30 };

export function sweepRetention(
  db: Db,
  now: number,
  opts: RetentionOptions = DEFAULT_RETENTION,
): RetentionResult {
  const result: RetentionResult = {
    sessionsRemoved: 0,
    variantSetsRemoved: 0,
    interactionsRemoved: 0,
    blobsRemoved: 0,
    removedInteractionIds: [],
  };
  const ids = (sql: string, ...args: number[]) =>
    db.all<{ id: string }>(sql, ...args).map((r) => r.id);

  db.transaction(() => {
    if (opts.sessionDays > 0) {
      const cutoff = now - opts.sessionDays * DAY;
      const stale = ids("SELECT id FROM sessions WHERE last_seen_at < ?", cutoff);
      for (const id of stale) {
        db.run("DELETE FROM events WHERE entity = 'session' AND entity_id = ?", id);
      }
      db.run("DELETE FROM sessions WHERE last_seen_at < ?", cutoff);
      result.sessionsRemoved = stale.length;
    }

    if (opts.retentionDays > 0) {
      const cutoff = now - opts.retentionDays * DAY;
      const gone = ids(
        "SELECT id FROM interactions WHERE resolved_at IS NOT NULL AND resolved_at < ?",
        cutoff,
      );
      for (const id of gone) {
        db.run("DELETE FROM events WHERE entity = 'interaction' AND entity_id = ?", id);
        db.run("DELETE FROM contents WHERE interaction_id = ?", id);
        // Capture cascade: decrement each blob by the number of THIS
        // interaction's parts that reference it — per part, not per hash.
        db.run(
          "UPDATE capture_blobs SET refcount = refcount - " +
            "(SELECT COUNT(*) FROM capture_parts p WHERE p.blob_hash = capture_blobs.hash " +
            "AND p.capture_id IN (SELECT id FROM captures WHERE interaction_id = ?)) " +
            "WHERE hash IN (SELECT blob_hash FROM capture_parts " +
            "WHERE capture_id IN (SELECT id FROM captures WHERE interaction_id = ?))",
          id,
          id,
        );
        db.run(
          "DELETE FROM capture_parts WHERE capture_id IN " +
            "(SELECT id FROM captures WHERE interaction_id = ?)",
          id,
        );
        db.run("DELETE FROM captures WHERE interaction_id = ?", id);
        db.run("DELETE FROM interactions WHERE id = ?", id);
        // Its D1 shares must go too, or they keep granting the space (finding 15).
        db.run("INSERT OR IGNORE INTO share_cleanup (interaction_id) VALUES (?)", id);
      }
      result.interactionsRemoved = gone.length;
      result.removedInteractionIds = gone;

      const sets = ids(
        "SELECT id FROM variant_sets WHERE resolved_at IS NOT NULL AND resolved_at < ?",
        cutoff,
      );
      for (const id of sets) {
        db.run("DELETE FROM events WHERE entity = 'variant' AND entity_id = ?", id);
        db.run("DELETE FROM variant_sets WHERE id = ?", id);
      }
      result.variantSetsRemoved = sets.length;
    }

    // Revocation records outlive every credential they could still matter for.
    const forgetBefore = now - REVOCATION_KEEP_DAYS * DAY;
    db.run("DELETE FROM revoked_credentials WHERE revoked_at < ?", forgetBefore);

    reconcileBlobRefcounts(db);
    result.blobsRemoved = sweepOrphanBlobs(db, now - LIMITS.STAGING_TTL_MS);
  });
  return result;
}

/** Everything the space holds, for `POST /internal/purge`. */
export function purgeAll(db: Db): void {
  db.transaction(() => {
    for (const table of [
      "events",
      "sessions",
      "contents",
      "variant_sets",
      "interactions",
      "people",
      "meta",
      "captures",
      "capture_parts",
      "capture_blob_chunks",
      "capture_blobs",
      "push_subscriptions",
      "control_epochs",
      "share_cleanup",
      "revoked_credentials",
      "credential_generations",
      "person_access",
    ]) {
      db.run(`DELETE FROM ${table}`);
    }
    // The tombstone: a deleted space stays deleted (nothing later recreates it).
    db.run("INSERT INTO meta (key, value) VALUES ('purged', '1')");
  });
}
