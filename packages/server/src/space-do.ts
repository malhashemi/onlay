/**
 * The space's Durable Object: binds the space runtime's ports to DO SQLite
 * storage and hibernating WebSockets (spec §7). Reachable only through the
 * Worker, which forwards one trusted `X-Onlay-Caller` header.
 *
 * Nothing here depends on memory surviving eviction: the runtime hydrates
 * from SQLite in the constructor, socket attachments are restored from
 * storage, and retention runs from a daily alarm.
 */

import { DurableObject } from "cloudflare:workers";
import { PROTOCOL_VERSION } from "@onlay/protocol";
import { enqueueSelect } from "./directory/notify";
import { pictureByKey } from "./directory/pictures";
import { validateConnected } from "./directory/validate";
import type { Env } from "./env";
import type { Db, RunResult, SqlRow, SqlValue, Statement } from "./space/ports";
import { pushContactOf } from "./space/push-contact";
import { REVALIDATE_ALL_MS, type SocketAttachment, type SpaceSocket } from "./space/runtime";
import { createSpace, type Space } from "./space/space";
import type { VapidKeys } from "./space/webpush";

const DAY_MS = 86_400_000;
/** While sockets are open the alarm comes at least this often, to end expired ones. */
/** While sockets are open the alarm runs at most this far apart: lifetimes and re-validation (R3-S2). */
const SOCKET_SWEEP_MS = REVALIDATE_ALL_MS;
/** The ping a client may send verbatim to be answered without waking the object. */
const AUTO_PING = '{"v":1,"type":"ping","t":0}';
const AUTO_PONG = '{"v":1,"type":"pong","t":0}';

/* ── Db over ctx.storage.sql ──────────────────────────────────────── */

function toSql(v: SqlValue): SqlStorageValue {
  return v instanceof Uint8Array ? v.slice().buffer : v;
}

function fromSql(row: Record<string, SqlStorageValue>): SqlRow {
  const out: SqlRow = {};
  for (const [k, v] of Object.entries(row))
    out[k] = v instanceof ArrayBuffer ? new Uint8Array(v) : v;
  return out;
}

class DurableDb implements Db {
  private depth = 0;
  constructor(private readonly storage: DurableObjectStorage) {}

  prepare<Row extends SqlRow = SqlRow>(sql: string): Statement<Row> {
    return {
      get: (...params) => this.get<Row>(sql, ...params),
      all: (...params) => this.all<Row>(sql, ...params),
      run: (...params) => this.run(sql, ...params),
    };
  }
  get<Row extends SqlRow = SqlRow>(sql: string, ...params: SqlValue[]): Row | undefined {
    const cursor = this.storage.sql.exec(sql, ...params.map(toSql));
    const first = cursor.next();
    return first.done ? undefined : (fromSql(first.value) as Row);
  }
  all<Row extends SqlRow = SqlRow>(sql: string, ...params: SqlValue[]): Row[] {
    return this.storage.sql
      .exec(sql, ...params.map(toSql))
      .toArray()
      .map((r) => fromSql(r) as Row);
  }
  run(sql: string, ...params: SqlValue[]): RunResult {
    const cursor = this.storage.sql.exec(sql, ...params.map(toSql));
    cursor.toArray();
    return { changes: cursor.rowsWritten };
  }
  exec(sql: string): void {
    this.storage.sql.exec(sql);
  }
  transaction<T>(fn: () => T): T {
    if (this.depth > 0) return fn();
    this.depth++;
    try {
      return this.storage.transactionSync(fn);
    } finally {
      this.depth--;
    }
  }
}

/* ── Sockets over hibernating WebSockets ──────────────────────────── */

/**
 * A hibernation attachment is capped at 2 KiB, and a guest's caller (their
 * shared interaction ids) can outgrow it. So the attachment holds only a key
 * and the session id; the caller lives in `ws_attachments`, cached in memory.
 */
interface Slim {
  k: string;
  s?: string;
}

class SocketTable {
  private readonly cache = new Map<string, SocketAttachment>();
  constructor(private readonly db: Db) {
    db.exec(
      "CREATE TABLE IF NOT EXISTS ws_attachments (k TEXT PRIMARY KEY, caller_json TEXT NOT NULL)",
    );
  }
  read(ws: WebSocket): SocketAttachment | null {
    const slim = ws.deserializeAttachment() as Slim | null;
    if (!slim?.k) return null;
    let a = this.cache.get(slim.k);
    if (!a) {
      const row = this.db.get<{ caller_json: string }>(
        "SELECT caller_json FROM ws_attachments WHERE k = ?",
        slim.k,
      );
      if (!row) return null;
      a = storedAttachment(row.caller_json);
      this.cache.set(slim.k, a);
    }
    return slim.s !== undefined ? { ...a, sessionId: slim.s } : a;
  }
  write(ws: WebSocket, attachment: SocketAttachment): void {
    const prev = ws.deserializeAttachment() as Slim | null;
    const k = prev?.k ?? crypto.randomUUID();
    this.db.run(
      "INSERT INTO ws_attachments (k, caller_json) VALUES (?, ?) " +
        "ON CONFLICT(k) DO UPDATE SET caller_json = excluded.caller_json",
      k,
      JSON.stringify(stamped(attachment)),
    );
    this.cache.set(k, stamped(attachment));
    const slim: Slim = {
      k,
      ...(attachment.sessionId !== undefined ? { s: attachment.sessionId } : {}),
    };
    ws.serializeAttachment(slim);
  }
  forget(ws: WebSocket): void {
    const slim = ws.deserializeAttachment() as Slim | null;
    if (!slim?.k) return;
    this.cache.delete(slim.k);
    this.db.run("DELETE FROM ws_attachments WHERE k = ?", slim.k);
  }
  /** Rows whose socket is gone (closed while the object was evicted). */
  prune(open: WebSocket[]): void {
    const keys = new Set(open.map((ws) => (ws.deserializeAttachment() as Slim | null)?.k));
    for (const row of this.db.all<{ k: string }>("SELECT k FROM ws_attachments")) {
      if (!keys.has(row.k)) {
        this.db.run("DELETE FROM ws_attachments WHERE k = ?", row.k);
        this.cache.delete(row.k);
      }
    }
  }
}

/** What the table keeps for a socket: its caller and when the edge authorized it. */
function stamped(a: SocketAttachment): SocketAttachment {
  return {
    caller: a.caller,
    ...(a.authorizedAt !== undefined ? { authorizedAt: a.authorizedAt } : {}),
    ...(a.welcome !== undefined ? { welcome: a.welcome } : {}),
    ...(a.validatedAt !== undefined ? { validatedAt: a.validatedAt } : {}),
    ...(a.closedAt !== undefined ? { closedAt: a.closedAt } : {}),
  };
}

/** A stored attachment: `{caller, authorizedAt}`, or a bare caller written before the stamp. */
function storedAttachment(json: string): SocketAttachment {
  const parsed = JSON.parse(json) as
    | {
        caller: SocketAttachment["caller"];
        authorizedAt?: number;
        welcome?: string;
        validatedAt?: number;
        closedAt?: number;
      }
    | SocketAttachment["caller"];
  return "caller" in parsed ? stamped(parsed) : { caller: parsed };
}

function wrap(ws: WebSocket, table: SocketTable): SpaceSocket {
  return {
    send(data) {
      try {
        ws.send(data);
      } catch {
        // closing under us: the frame is dropped, the next sync heals it
      }
    },
    close(code, reason) {
      try {
        ws.close(code, reason);
      } catch {
        // already closed
      }
    },
    attachment: () => table.read(ws),
    setAttachment: (a) => table.write(ws, a),
    key: ws,
  };
}

/**
 * Retention removed these interactions (review finding 15): drop their
 * shares from the directory, so a stale share never keeps granting the
 * space, with the space's access epoch moved and a notice per share in the
 * same batch: an access and a person row for each holder with an account
 * (delivery reads their standing then; the edge's scheduled pass and its next
 * forward here deliver them). The SQL is the directory's own; it lives here
 * so the portable runtime never touches D1.
 */
export async function dropShares(db: D1Database, spaceId: string, ids: string[]): Promise<void> {
  const list = JSON.stringify(ids);
  const removed = "space_id = ?1 AND interaction_id IN (SELECT value FROM json_each(?2))";
  const holders = `SELECT DISTINCT sh.space_id, json_object('personId', p.id) AS body_json
    FROM shares sh JOIN people p ON p.email = sh.email AND p.deleted_at IS NULL
    WHERE sh.${removed.replace("interaction_id", "sh.interaction_id")}`;
  await db.batch([
    enqueueSelect(db, "access", holders, [spaceId, list]),
    enqueueSelect(db, "person", holders, [spaceId, list]),
    db
      .prepare(
        `UPDATE spaces SET access_epoch = access_epoch + 1
         WHERE id = ?1 AND EXISTS (SELECT 1 FROM shares WHERE ${removed})`,
      )
      .bind(spaceId, list),
    db.prepare(`DELETE FROM shares WHERE ${removed}`).bind(spaceId, list),
  ]);
}

/** The deployment's VAPID keys, when both secrets are set; without them web push is off. */
function vapidOf(env: Env): VapidKeys | undefined {
  return env.VAPID_PUBLIC_KEY && env.VAPID_PRIVATE_JWK
    ? { publicKey: env.VAPID_PUBLIC_KEY, privateJwk: env.VAPID_PRIVATE_JWK }
    : undefined;
}

export class SpaceDO extends DurableObject<Env> {
  private readonly space: Space;
  private readonly table: SocketTable;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    const db = new DurableDb(ctx.storage);
    this.table = new SocketTable(db);
    const table = this.table;
    const min = Number(env.MIN_CLIENT_PROTOCOL);
    const vapid = vapidOf(env);
    const pushContact = pushContactOf(env.PUSH_CONTACT, env.PUBLIC_ORIGIN);
    const spaceId = ctx.id.name;
    this.space = createSpace({
      db,
      sockets: { all: () => ctx.getWebSockets().map((ws) => wrap(ws, table)) },
      clock: { now: () => Date.now() },
      ...(spaceId ? { spaceId } : {}),
      ...(spaceId ? { sharesGone: (ids: string[]) => dropShares(env.DB, spaceId, ids) } : {}),
      ...(spaceId
        ? { directory: { validate: (entries) => validateConnected(env.DB, spaceId, entries) } }
        : {}),
      pictures: { read: (personId, key) => pictureByKey(env.DB, personId, key) },
      ...(Number.isInteger(min) && min > 0 ? { minClientProtocol: min } : {}),
      ...(vapid ? { vapid } : {}),
      ...(pushContact ? { pushContact } : {}),
      waitUntil: (p) => ctx.waitUntil(p),
      log: (event, data) => console.log(JSON.stringify({ event, ...data })),
    });
    ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair(AUTO_PING, AUTO_PONG));
    table.prune(ctx.getWebSockets());
    void ctx.blockConcurrencyWhile(async () => {
      if ((await ctx.storage.getAlarm()) === null) await ctx.storage.setAlarm(Date.now() + DAY_MS);
    });
  }

  override async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === "/healthz") {
      const row = this.ctx.storage.sql.exec<{ ok: number }>("SELECT 1 AS ok").one();
      return Response.json({ ok: row.ok === 1, protocol: PROTOCOL_VERSION });
    }
    if (url.pathname === "/ws" && request.headers.has("Upgrade")) {
      const admitted = this.space.admitSocket(request);
      if (!admitted.ok) return admitted.response;
      const pair = new WebSocketPair();
      const [client, server] = [pair[0], pair[1]];
      this.ctx.acceptWebSocket(server);
      this.table.write(server, admitted.attachment);
      // A socket's 24 hours end from an alarm, whether or not it ever sends a frame.
      const next = await this.ctx.storage.getAlarm();
      if (next === null || next > Date.now() + SOCKET_SWEEP_MS) {
        await this.ctx.storage.setAlarm(Date.now() + SOCKET_SWEEP_MS);
      }
      return new Response(null, {
        status: 101,
        webSocket: client,
        ...(admitted.protocol ? { headers: { "Sec-WebSocket-Protocol": admitted.protocol } } : {}),
      });
    }
    const res = await this.space.fetch(request);
    if (url.pathname === "/internal/purge" && res.ok) {
      this.table.prune([]);
      await this.ctx.storage.deleteAlarm();
    }
    return res;
  }

  override async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): Promise<void> {
    const raw = typeof message === "string" ? message : new TextDecoder().decode(message);
    await this.space.onMessage(wrap(ws, this.table), raw);
  }

  override webSocketClose(ws: WebSocket, code: number, reason: string): void {
    this.space.onClose(wrap(ws, this.table));
    this.table.forget(ws);
    try {
      ws.close(code, reason);
    } catch {
      // the runtime already completed the close handshake
    }
  }

  override webSocketError(ws: WebSocket): void {
    this.space.onClose(wrap(ws, this.table));
    this.table.forget(ws);
  }

  /**
   * Every five minutes while sockets are open (closing any past their 24
   * hours, then re-validating the rest against the directory in one batch),
   * and the daily retention pass once a day.
   */
  override async alarm(): Promise<void> {
    const now = Date.now();
    this.space.sweepSockets();
    await this.space.validateSockets();
    const last = (await this.ctx.storage.get<number>("retention-at")) ?? 0;
    let nextRetention = last + DAY_MS;
    if (now >= nextRetention) {
      this.space.alarm();
      await this.space.reportRemovedShares();
      await this.ctx.storage.put("retention-at", now);
      nextRetention = now + DAY_MS;
    }
    const open = this.ctx.getWebSockets().length > 0;
    await this.ctx.storage.setAlarm(
      open ? Math.min(now + SOCKET_SWEEP_MS, nextRetention) : nextRetention,
    );
  }
}
