/**
 * The space runtime's ports (spec §7). Everything under `src/space/**` is
 * portable TypeScript over these three interfaces: no Bun, no Workers
 * imports. Two implementations exist: the Durable Object binds them to
 * `ctx.storage.sql`, `transactionSync` and hibernating WebSockets; tests bind
 * them in process (`./testing/`), over `bun:sqlite`.
 */

/* ── Db ───────────────────────────────────────────────────────────── */

/**
 * A value SQLite stores. Blobs are `Uint8Array` on both sides of the port:
 * an implementation whose driver speaks `ArrayBuffer` (Durable Object
 * storage) converts in both directions.
 */
export type SqlValue = string | number | null | Uint8Array;

/** One result row, keyed by column name. */
export type SqlRow = Record<string, SqlValue>;

/** What a write did. */
export interface RunResult {
  /** Rows inserted, updated or deleted by the statement. */
  changes: number;
}

/**
 * A statement prepared once and run many times. Implementations may cache
 * or re-parse; callers must not rely on either.
 */
export interface Statement<Row extends SqlRow = SqlRow> {
  /** The first row, or undefined when there is none. */
  get(...params: SqlValue[]): Row | undefined;
  /** Every row, in result order. */
  all(...params: SqlValue[]): Row[];
  /** Runs a write. */
  run(...params: SqlValue[]): RunResult;
}

/**
 * The space's SQLite database, synchronous like both drivers under it. A
 * space's stores use only this surface: one journal append and its snapshot,
 * or a capture commit with its refcounts, go in one `transaction`.
 */
export interface Db {
  prepare<Row extends SqlRow = SqlRow>(sql: string): Statement<Row>;
  /** Shorthand for `prepare(sql).get(...params)`. */
  get<Row extends SqlRow = SqlRow>(sql: string, ...params: SqlValue[]): Row | undefined;
  /** Shorthand for `prepare(sql).all(...params)`. */
  all<Row extends SqlRow = SqlRow>(sql: string, ...params: SqlValue[]): Row[];
  /** Shorthand for `prepare(sql).run(...params)`. */
  run(sql: string, ...params: SqlValue[]): RunResult;
  /** Runs one or more statements without parameters (schema setup, migrations). */
  exec(sql: string): void;
  /**
   * Runs `fn` atomically: every write inside commits together, or none does
   * when `fn` throws (the error propagates). `fn` must be synchronous. Nested
   * calls join the outer transaction.
   */
  transaction<T>(fn: () => T): T;
}

/* ── Sockets ──────────────────────────────────────────────────────── */

/**
 * One connected socket. `A` is the per-socket attachment: who the caller is
 * and which durable session the socket carries. It survives Durable Object
 * hibernation, so it must be structured-cloneable and small.
 */
export interface Socket<A> {
  /** Sends one frame. A closed socket drops it silently. */
  send(data: string): void;
  /** Closes with a code (e.g. `CLOSE_ACCESS_REVOKED`) and a short reason. */
  close(code: number, reason: string): void;
  /** The attachment, or null before the first `setAttachment`. */
  attachment(): A | null;
  setAttachment(attachment: A): void;
  /**
   * A stable identity for the socket across calls, when the host wraps it
   * afresh each time (the Durable Object's own WebSocket); else the wrapper.
   */
  key?: unknown;
}

/** The space's open sockets. */
export interface Sockets<A> {
  /** Every open socket, including those restored after hibernation. */
  all(): Socket<A>[];
}

/* ── Clock ────────────────────────────────────────────────────────── */

/**
 * Time, injected so reducers' `now` is testable. There are no timers that
 * must survive eviction: retention runs from the daily alarm, and waits or
 * pending uploads lost to eviction fail closed.
 */
export interface Clock {
  /** Epoch milliseconds. */
  now(): number;
}
