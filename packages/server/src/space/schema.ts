/**
 * The space's SQLite schema, created on first use (spec §7). One space = one
 * Durable Object = one database; nothing here names the space, because the
 * database IS the space.
 *
 * The event-sourced discipline is the broker's: every mutation appends one row
 * to `events` (the journal) AND upserts the entity's snapshot row, in one
 * transaction. Wake reads snapshots; `eventsFor` stays available as the
 * replay oracle, folding the kernel codecs over the stored payloads.
 */
import type { Db } from "./ports";

/** Logical entity buckets in the shared `events` journal. */
export type EventEntity = "session" | "variant" | "interaction";

const DDL = [
  `CREATE TABLE IF NOT EXISTS events (
    seq       INTEGER PRIMARY KEY AUTOINCREMENT,
    entity    TEXT    NOT NULL,
    entity_id TEXT    NOT NULL,
    k         TEXT    NOT NULL,
    ts        INTEGER NOT NULL,
    payload   TEXT    NOT NULL
  )`,
  "CREATE INDEX IF NOT EXISTS events_entity ON events(entity, entity_id, seq)",

  `CREATE TABLE IF NOT EXISTS sessions (
    id           TEXT PRIMARY KEY,
    json         TEXT NOT NULL,
    last_seen_at INTEGER NOT NULL
  )`,

  // Captured HTML sidecars: the block an anchor was placed on (`anchor`) and,
  // for a page edit, the sanitized page body (`page`). Write-once per slot.
  `CREATE TABLE IF NOT EXISTS contents (
    interaction_id TEXT    NOT NULL,
    slot           TEXT    NOT NULL,
    content        TEXT    NOT NULL,
    format         TEXT    NOT NULL,
    truncated      INTEGER NOT NULL DEFAULT 0,
    created_at     INTEGER NOT NULL,
    PRIMARY KEY (interaction_id, slot)
  )`,

  `CREATE TABLE IF NOT EXISTS variant_sets (
    id          TEXT PRIMARY KEY,
    json        TEXT NOT NULL,
    status      TEXT NOT NULL,
    created_at  INTEGER NOT NULL,
    resolved_at INTEGER
  )`,

  `CREATE TABLE IF NOT EXISTS interactions (
    id          TEXT PRIMARY KEY,
    kind        TEXT NOT NULL,
    url         TEXT NOT NULL,
    state       TEXT NOT NULL,
    author_id   TEXT NOT NULL,
    created_at  INTEGER NOT NULL,
    resolved_at INTEGER,
    json        TEXT NOT NULL
  )`,
  "CREATE INDEX IF NOT EXISTS interactions_url ON interactions(url)",
  "CREATE INDEX IF NOT EXISTS interactions_resolved ON interactions(resolved_at)",

  // The people cache (spec §5.1): the edge's full member list, plus guests
  // learned from share changes. Never the source of truth for access.
  `CREATE TABLE IF NOT EXISTS people (
    id         TEXT PRIMARY KEY,
    name       TEXT NOT NULL,
    initials   TEXT NOT NULL,
    tint       TEXT NOT NULL,
    avatar_url TEXT,
    member     INTEGER NOT NULL
  )`,

  // The newest access epoch each control call's subject was told at (spec
  // §5.1, review finding 1): a delivery older than this for the same key
  // (the people list, a person's access, an interaction's shares) is stale
  // and changes nothing.
  `CREATE TABLE IF NOT EXISTS control_epochs (
    key   TEXT PRIMARY KEY,
    epoch INTEGER NOT NULL
  )`,

  // Revoked credentials (a single sign-out; kept 31 days) and each person's
  // minimum credential generation (sign out everywhere, an email or subject
  // change, account deletion; kept, it only grows): admission and every
  // socket and push check refuse a credential listed, or stamped below it.
  `CREATE TABLE IF NOT EXISTS revoked_credentials (
    credential_id TEXT PRIMARY KEY,
    person_id     TEXT NOT NULL,
    revoked_at    INTEGER NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS credential_generations (
    person_id      TEXT PRIMARY KEY,
    min_generation INTEGER NOT NULL
  )`,

  // Each person's scope as last applied from the edge, with its epoch: an
  // access control replaces it whole; the share debt follows its guest ids.
  `CREATE TABLE IF NOT EXISTS person_access (
    person_id   TEXT PRIMARY KEY,
    access_json TEXT,
    epoch       INTEGER NOT NULL
  )`,

  // Interactions retention removed whose D1 shares the edge has not yet
  // dropped; reported through the host's port until it succeeds.
  `CREATE TABLE IF NOT EXISTS share_cleanup (
    interaction_id TEXT PRIMARY KEY
  )`,

  // Space facts the edge tells us (its kind and name), one row per key.
  `CREATE TABLE IF NOT EXISTS meta (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL
  )`,

  // ── captures (ADR-0022) ─────────────────────────────────────────────
  // Manifest rows (metadata + lineage; never bytes).
  `CREATE TABLE IF NOT EXISTS captures (
    id             TEXT PRIMARY KEY,
    interaction_id TEXT NOT NULL,
    kind           TEXT NOT NULL,
    lineage_id     TEXT NOT NULL,
    revision       INTEGER NOT NULL,
    captured_by    TEXT NOT NULL,
    captured_from  TEXT NOT NULL,
    format         TEXT NOT NULL,
    caption        TEXT,
    total_bytes    INTEGER NOT NULL,
    meta_json      TEXT NOT NULL,
    created_at     INTEGER NOT NULL
  )`,
  "CREATE INDEX IF NOT EXISTS captures_owner ON captures(interaction_id, lineage_id, revision)",
  "CREATE INDEX IF NOT EXISTS captures_actor ON captures(captured_by)",

  `CREATE TABLE IF NOT EXISTS capture_parts (
    capture_id TEXT NOT NULL,
    name       TEXT NOT NULL,
    role       TEXT NOT NULL,
    mime       TEXT NOT NULL,
    byte_len   INTEGER NOT NULL,
    blob_hash  TEXT NOT NULL,
    PRIMARY KEY (capture_id, name)
  )`,
  "CREATE INDEX IF NOT EXISTS capture_parts_blob ON capture_parts(blob_hash)",

  // Content-addressed, refcounted blobs. Refcount 0 = staged or orphaned.
  // The bytes live in `capture_blob_chunks`, at most MAX_BLOB_CHUNK per row,
  // so staging, commit, refcounts and pruning stay single-transaction.
  `CREATE TABLE IF NOT EXISTS capture_blobs (
    hash      TEXT PRIMARY KEY,
    mime      TEXT NOT NULL,
    byte_len  INTEGER NOT NULL,
    refcount  INTEGER NOT NULL,
    staged_at INTEGER NOT NULL
  )`,
  "CREATE INDEX IF NOT EXISTS capture_blobs_orphan ON capture_blobs(refcount, staged_at)",
  `CREATE TABLE IF NOT EXISTS capture_blob_chunks (
    hash  TEXT    NOT NULL,
    idx   INTEGER NOT NULL,
    bytes BLOB    NOT NULL,
    PRIMARY KEY (hash, idx)
  )`,

  // ── Web Push ────────────────────────────────────────────────────────
  // One subscription per credential (a web app session); upsert replaces.
  // `access_json` is the subscriber's access, kept current by the edge's
  // access and share notices, so a push never reveals what they can't see.
  `CREATE TABLE IF NOT EXISTS push_subscriptions (
    credential_id TEXT PRIMARY KEY,
    person_id     TEXT NOT NULL,
    access_json   TEXT NOT NULL,
    json          TEXT NOT NULL,
    created_at    INTEGER NOT NULL
  )`,
  "CREATE INDEX IF NOT EXISTS push_subscriptions_person ON push_subscriptions(person_id)",
];

/**
 * Columns added after a table first shipped: each runs once, and fails
 * harmlessly ("duplicate column") on a database that already has it.
 */
const ADDED_COLUMNS = [
  // A non-member who holds a share here now (the edge's people list says so).
  "ALTER TABLE people ADD COLUMN guest INTEGER NOT NULL DEFAULT 0",
  // When the subscribing credential was issued (round 2; no longer read).
  "ALTER TABLE push_subscriptions ADD COLUMN credential_issued_at INTEGER",
  // The subscribing credential's generation: a raised minimum removes only
  // subscriptions made with older credentials (R3-S1).
  "ALTER TABLE push_subscriptions ADD COLUMN credential_generation INTEGER",
  // A member's alias (their email's local part), which only members are shown.
  "ALTER TABLE people ADD COLUMN alias TEXT",
];

/** Creates every table, index and added column that does not exist yet. Idempotent. */
export function ensureSchema(db: Db): void {
  for (const statement of DDL) db.exec(statement);
  for (const statement of ADDED_COLUMNS) {
    try {
      db.exec(statement);
    } catch (error) {
      if (!String(error).includes("duplicate column")) throw error;
    }
  }
}

/** The journal: append-only events, read back as the replay oracle. */
export interface Journal {
  /** Appends one row and returns its sequence number. */
  append(entity: EventEntity, entityId: string, k: string, ts: number, payload: string): number;
  /** The stored codec payloads for an entity, oldest first. */
  eventsFor(entity: EventEntity, entityId: string): string[];
  /** The newest sequence number for an entity, or 0. */
  lastSeq(entity: EventEntity, entityId: string): number;
  /** Events for an entity after `since`, oldest first. */
  since(
    entity: EventEntity,
    entityId: string,
    since: number,
  ): Array<{ seq: number; k: string; ts: number }>;
}

export function makeJournal(db: Db): Journal {
  return {
    append(entity, entityId, k, ts, payload) {
      db.run(
        "INSERT INTO events (entity, entity_id, k, ts, payload) VALUES (?, ?, ?, ?, ?)",
        entity,
        entityId,
        k,
        ts,
        payload,
      );
      const row = db.get<{ seq: number }>("SELECT last_insert_rowid() AS seq");
      return Number(row?.seq ?? 0);
    },
    eventsFor(entity, entityId) {
      return db
        .all<{ payload: string }>(
          "SELECT payload FROM events WHERE entity = ? AND entity_id = ? ORDER BY seq ASC",
          entity,
          entityId,
        )
        .map((r) => r.payload);
    },
    lastSeq(entity, entityId) {
      const row = db.get<{ seq: number | null }>(
        "SELECT MAX(seq) AS seq FROM events WHERE entity = ? AND entity_id = ?",
        entity,
        entityId,
      );
      return Number(row?.seq ?? 0);
    },
    since(entity, entityId, since) {
      return db
        .all<{ seq: number; k: string; ts: number }>(
          "SELECT seq, k, ts FROM events WHERE entity = ? AND entity_id = ? AND seq > ? ORDER BY seq ASC",
          entity,
          entityId,
          since,
        )
        .map((r) => ({ seq: Number(r.seq), k: r.k, ts: Number(r.ts) }));
    },
  };
}
