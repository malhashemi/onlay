/**
 * The in-process `Db` port over `bun:sqlite`, for `bun test` of the space
 * runtime. Behaves as the Durable Object binding does: synchronous, blobs as
 * `Uint8Array`, and nested transactions joining the outer one.
 */
import { Database } from "bun:sqlite";
import type { Db, RunResult, SqlRow, SqlValue, Statement } from "../ports";

/** Bun returns blobs as `Uint8Array` (a `Buffer` subclass under Node APIs); normalize to plain views. */
function normalizeRow<Row extends SqlRow>(row: unknown): Row {
  const out: Record<string, SqlValue> = {};
  for (const [k, v] of Object.entries(row as Record<string, unknown>)) {
    out[k] =
      v instanceof Uint8Array
        ? new Uint8Array(v.buffer, v.byteOffset, v.byteLength)
        : (v as SqlValue);
  }
  return out as Row;
}

export class SqliteDb implements Db {
  readonly raw: Database;
  private depth = 0;

  /** An in-memory database by default; pass a path for a file. */
  constructor(path = ":memory:") {
    this.raw = new Database(path, { strict: true });
    this.raw.run("PRAGMA foreign_keys = ON");
  }

  prepare<Row extends SqlRow = SqlRow>(sql: string): Statement<Row> {
    const stmt = this.raw.query(sql);
    return {
      get: (...params) => {
        const row = stmt.get(...params);
        return row === null || row === undefined ? undefined : normalizeRow<Row>(row);
      },
      all: (...params) => stmt.all(...params).map((row) => normalizeRow<Row>(row)),
      run: (...params): RunResult => ({ changes: stmt.run(...params).changes }),
    };
  }

  get<Row extends SqlRow = SqlRow>(sql: string, ...params: SqlValue[]): Row | undefined {
    return this.prepare<Row>(sql).get(...params);
  }

  all<Row extends SqlRow = SqlRow>(sql: string, ...params: SqlValue[]): Row[] {
    return this.prepare<Row>(sql).all(...params);
  }

  run(sql: string, ...params: SqlValue[]): RunResult {
    return this.prepare(sql).run(...params);
  }

  exec(sql: string): void {
    this.raw.run(sql);
  }

  transaction<T>(fn: () => T): T {
    if (this.depth > 0) return fn();
    this.depth++;
    try {
      return this.raw.transaction(fn)();
    } finally {
      this.depth--;
    }
  }

  close(): void {
    this.raw.close();
  }
}
