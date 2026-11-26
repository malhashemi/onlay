import { afterEach, describe, expect, test } from "bun:test";
import { SqliteDb } from "./sqlite-db";

let db: SqliteDb;
afterEach(() => db?.close());

function open(): SqliteDb {
  db = new SqliteDb();
  db.exec(`
    CREATE TABLE events (seq INTEGER PRIMARY KEY AUTOINCREMENT, k TEXT NOT NULL, payload TEXT NOT NULL);
    CREATE TABLE blobs (hash TEXT PRIMARY KEY, bytes BLOB NOT NULL);
  `);
  return db;
}

describe("SqliteDb (the in-process Db port)", () => {
  test("prepare, get, all and run", () => {
    const d = open();
    const insert = d.prepare("INSERT INTO events (k, payload) VALUES (?, ?)");
    expect(insert.run("a", "{}")).toEqual({ changes: 1 });
    insert.run("b", "{}");
    expect(d.get("SELECT k FROM events WHERE seq = ?", 2)).toEqual({ k: "b" });
    expect(d.get("SELECT k FROM events WHERE seq = ?", 99)).toBeUndefined();
    expect(d.all("SELECT k FROM events ORDER BY seq").map((r) => r.k)).toEqual(["a", "b"]);
    expect(d.run("DELETE FROM events")).toEqual({ changes: 2 });
  });

  test("blobs round-trip as Uint8Array", () => {
    const d = open();
    d.run("INSERT INTO blobs (hash, bytes) VALUES (?, ?)", "h", new Uint8Array([1, 2, 3]));
    const row = d.get<{ bytes: Uint8Array }>("SELECT bytes FROM blobs WHERE hash = ?", "h");
    expect(row?.bytes).toBeInstanceOf(Uint8Array);
    expect([...(row?.bytes ?? [])]).toEqual([1, 2, 3]);
  });

  test("a throwing transaction writes nothing; nested calls join the outer one", () => {
    const d = open();
    expect(() =>
      d.transaction(() => {
        d.run("INSERT INTO events (k, payload) VALUES ('x', '{}')");
        d.transaction(() => d.run("INSERT INTO events (k, payload) VALUES ('y', '{}')"));
        throw new Error("boom");
      }),
    ).toThrow("boom");
    expect(d.all("SELECT * FROM events")).toEqual([]);
    const n = d.transaction(() => {
      d.run("INSERT INTO events (k, payload) VALUES ('x', '{}')");
      return d.transaction(() => d.run("INSERT INTO events (k, payload) VALUES ('y', '{}')"))
        .changes;
    });
    expect(n).toBe(1);
    expect(d.all("SELECT k FROM events ORDER BY seq").map((r) => r.k)).toEqual(["x", "y"]);
  });
});
