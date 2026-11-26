/**
 * The Worker's calls into a space's internal control routes (spec §5.1),
 * made durable: every call the edge owes a space after a directory change
 * is an outbox row written in the SAME batch as the change (`enqueue*`),
 * delivered right after the commit (`deliver`), deleted once the space
 * accepts it, and retried until then by the scheduled handler (`deliverDue`)
 * and before the edge forwards anything to that space (`deliverPending`).
 *
 * Round 2: a row names only who or what changed ("person P in space S");
 * the call is built from the directory as it stands at delivery, with the
 * space's access epoch read in the same D1 batch, so a late, repeated or
 * reordered delivery carries current truth and the space skips one older
 * than what it holds. Per person, never a whole roster, and in a fixed
 * order: credential-revoked, then access, then purge, then person. A failed
 * row backs off (doubling, at most ten minutes) so it never holds the retry
 * window; each call has a five-second deadline; a row that keeps failing is
 * logged loudly with its id and kept.
 */
import {
  ACCESS_EPOCH_HEADER,
  type CallerAccess,
  encodeSpaceFacts,
  INTERNAL_HEADER,
  type InternalAccessChangedRequest,
  type InternalCredentialRevokedRequest,
  type InternalPersonRequest,
  LIMITS,
  type SpaceKind,
} from "@onlay/protocol";
import type { Env } from "../env";
import { displayName } from "./access";
import { newId } from "./crypto";
import { aliasOf, type PersonRow, PICTURE_KEY_COLUMN, summaryOf } from "./db";

/** The Durable Object named by the space id. */
export function spaceStub(env: Env, spaceId: string) {
  return env.SPACE.get(env.SPACE.idFromName(spaceId));
}

/** `X-Onlay-Space` for a space: its kind and its display name. */
export function spaceFactsHeader(space: { kind: SpaceKind; name: string }): string {
  return encodeSpaceFacts({ kind: space.kind, name: displayName(space) });
}

/* ── rows ─────────────────────────────────────────────────────────── */

/** What each row names. */
export interface OutboxBodies {
  /**
   * Credentials signed out: by id, or every one stamped below `minGeneration`
   * (R3-S1). A row written by an earlier Worker may carry a time `cutoff`, or
   * neither: delivered as "close all of this person's sockets and pushes".
   */
  "credential-revoked": {
    personId: string;
    credentialIds?: string[];
    minGeneration?: number;
    cutoff?: number;
  };
  /** The person's standing in the space changed: delivery sends their whole current scope. */
  access: { personId: string };
  /** The space is gone: delete everything. */
  purge: Record<never, never>;
  /** The person's display data or membership changed: delivery sends them, or their removal. */
  person: { personId: string };
}
export type OutboxKind = keyof OutboxBodies;

/** Delivery order inside a space (lower first). */
const PRIORITY: Record<OutboxKind, number> = {
  "credential-revoked": 0,
  access: 1,
  purge: 2,
  person: 3,
};

/** Kinds an older Worker may still write during a deploy (mapped at delivery). */
type LegacyKind = "standing" | "shares" | "people";

interface OutboxRow {
  id: string;
  space_id: string;
  kind: OutboxKind | LegacyKind;
  body_json: string;
  attempts: number;
}

const INSERT_COLUMNS = "(id, space_id, kind, body_json, created_at, priority)";

/** One row for one space, to run inside the change's batch; `id` is what to deliver after it. */
export function enqueue<K extends OutboxKind>(
  db: D1Database,
  spaceId: string,
  kind: K,
  body: OutboxBodies[K],
): { statement: D1PreparedStatement; id: string } {
  const id = newId("ob");
  return {
    id,
    statement: db
      .prepare(`INSERT INTO space_outbox ${INSERT_COLUMNS} VALUES (?, ?, ?, ?, ?, ?)`)
      .bind(id, spaceId, kind, JSON.stringify(body), Date.now(), PRIORITY[kind]),
  };
}

/**
 * Rows of `kind` from a SELECT yielding `space_id` and `body_json` columns,
 * inside the change's batch (place it before anything that removes what the
 * SELECT reads). Its result rows carry the ids to deliver (`returnedIds`).
 */
export function enqueueSelect(
  db: D1Database,
  kind: OutboxKind,
  select: string,
  binds: unknown[],
): D1PreparedStatement {
  return db
    .prepare(
      `INSERT INTO space_outbox ${INSERT_COLUMNS}
       SELECT 'ob_' || lower(hex(randomblob(16))), space_id, '${kind}', body_json,
         ${Date.now()}, ${PRIORITY[kind]}
       FROM (${select}) RETURNING id`,
    )
    .bind(...binds);
}

/** Every space the person sees: their memberships and the spaces sharing with their email. */
const SPACES_OF_PERSON = `SELECT id FROM spaces
  WHERE id IN (SELECT space_id FROM space_members WHERE person_id = ?1)
     OR id IN (SELECT space_id FROM shares WHERE email = ?2)`;

/** One row of `kind` for every space the person sees, inside the change's batch. */
export function enqueueForPersonSpaces<K extends OutboxKind>(
  db: D1Database,
  person: { id: string; email: string },
  kind: K,
  body: OutboxBodies[K],
): D1PreparedStatement {
  return enqueueSelect(
    db,
    kind,
    `SELECT id AS space_id, ?3 AS body_json FROM (${SPACES_OF_PERSON})`,
    [person.id, person.email, JSON.stringify(body)],
  );
}

/**
 * An `access` and a `person` row for the live person holding `email`, in one
 * space (a share added or removed), or none when nobody has that email yet.
 */
export function enqueueForEmail(
  db: D1Database,
  spaceId: string,
  email: string,
): D1PreparedStatement[] {
  const holder = `SELECT ?1 AS space_id, json_object('personId', id) AS body_json FROM people
    WHERE email = ?2 AND deleted_at IS NULL`;
  return [
    enqueueSelect(db, "access", holder, [spaceId, email]),
    enqueueSelect(db, "person", holder, [spaceId, email]),
  ];
}

/** An `access` and a `person` row for a known person in one space. */
export function enqueueStanding(
  db: D1Database,
  spaceId: string,
  personId: string,
): { statements: D1PreparedStatement[]; ids: string[] } {
  const access = enqueue(db, spaceId, "access", { personId });
  const person = enqueue(db, spaceId, "person", { personId });
  return { statements: [access.statement, person.statement], ids: [access.id, person.id] };
}

/** The space's access epoch moves on: forwards that read an older one are stale. */
export function bumpEpoch(db: D1Database, spaceId: string): D1PreparedStatement {
  return db.prepare("UPDATE spaces SET access_epoch = access_epoch + 1 WHERE id = ?").bind(spaceId);
}

/**
 * A `credential-revoked` row for every space the person sees naming the
 * person's generation as it stands at that point in the batch (place it after
 * the statement that advances it): `{personId, minGeneration}`.
 */
export function enqueueGenerationRevoked(
  db: D1Database,
  person: { id: string; email: string },
): D1PreparedStatement {
  return enqueueSelect(
    db,
    "credential-revoked",
    `SELECT id AS space_id, json_object('personId', ?1, 'minGeneration',
       (SELECT credential_generation FROM people WHERE id = ?1)) AS body_json
     FROM (${SPACES_OF_PERSON})`,
    [person.id, person.email],
  );
}

/** The access epoch of every space the person sees moves on. */
export function bumpEpochsForPerson(
  db: D1Database,
  person: { id: string; email: string },
): D1PreparedStatement {
  return db
    .prepare(`UPDATE spaces SET access_epoch = access_epoch + 1 WHERE id IN (${SPACES_OF_PERSON})`)
    .bind(person.id, person.email);
}

/** The outbox ids a batch's `RETURNING id` statements produced. */
export function returnedIds(results: D1Result[], indexes: number[]): string[] {
  return indexes.flatMap((i) =>
    ((results[i]?.results ?? []) as { id?: unknown }[]).flatMap((row) =>
      typeof row.id === "string" ? [row.id] : [],
    ),
  );
}

/* ── delivery ─────────────────────────────────────────────────────── */

const ROW_COLUMNS = "id, space_id, kind, body_json, attempts";
/** Order inside one selection: authorization first, then the oldest due. */
const DUE_ORDER = "ORDER BY priority, next_attempt_at, created_at, id";
/** Each control call's deadline. */
const CALL_DEADLINE_MS = 5_000;
/** The longest a failing row waits between attempts. */
const MAX_BACKOFF_MS = 600_000;
/** After this many failures a row is logged loudly on every attempt (and still kept). */
const STUCK_AFTER = 100;

/**
 * Delivers these rows now, in delivery order. A failure stays queued and is
 * logged; it never throws, so a request whose directory change already
 * committed never fails here.
 */
export async function deliver(env: Env, ids: string[]): Promise<void> {
  if (ids.length === 0) return;
  try {
    const rows = await env.DB.prepare(
      `SELECT ${ROW_COLUMNS} FROM space_outbox
       WHERE id IN (SELECT value FROM json_each(?)) ${DUE_ORDER}`,
    )
      .bind(JSON.stringify(ids))
      .all<OutboxRow>();
    for (const row of rows.results) await deliverRow(env, row);
  } catch (error) {
    console.error(
      `outbox: delivering ${ids.length} rows failed; the scheduled pass retries`,
      error,
    );
  }
}

/** How many rows, and how long, the delivery before a forward may take (R3-S6). */
const PENDING_ROWS = 10;
const PENDING_BUDGET_MS = 1_000;

/**
 * Delivers the space's authorization rows (`credential-revoked`, `access`)
 * before the edge forwards anything to it: at most 10, within 1 second in
 * all, stopping when the caller's `signal` aborts. Backoff does not apply
 * (the forward is about to reach the space anyway); `person` and `purge`
 * rows, and anything over the budget, wait for the scheduled retry (R3-S6).
 */
export async function deliverPending(
  env: Env,
  spaceId: string,
  signal?: AbortSignal,
): Promise<void> {
  const budget = AbortSignal.timeout(PENDING_BUDGET_MS);
  const stop = signal ? AbortSignal.any([signal, budget]) : budget;
  try {
    const rows = await env.DB.prepare(
      `SELECT ${ROW_COLUMNS} FROM space_outbox
       WHERE space_id = ? AND kind IN ('credential-revoked', 'access') ${DUE_ORDER} LIMIT ${PENDING_ROWS}`,
    )
      .bind(spaceId)
      .all<OutboxRow>();
    for (const row of rows.results) {
      if (stop.aborted) return;
      await deliverRow(env, row, stop);
    }
  } catch (error) {
    console.error(`outbox: pending rows for space ${spaceId} failed to load`, error);
  }
}

/** The scheduled retry: the rows due now, authorization first; rows backing off wait. */
export async function deliverDue(env: Env, limit = 200): Promise<void> {
  const rows = await env.DB.prepare(
    `SELECT ${ROW_COLUMNS} FROM space_outbox WHERE next_attempt_at <= ? ${DUE_ORDER} LIMIT ?`,
  )
    .bind(Date.now(), limit)
    .all<OutboxRow>();
  for (const row of rows.results) await deliverRow(env, row);
}

async function deliverRow(env: Env, row: OutboxRow, signal?: AbortSignal): Promise<boolean> {
  try {
    await send(env, row, signal);
    await env.DB.prepare("DELETE FROM space_outbox WHERE id = ?").bind(row.id).run();
    return true;
  } catch (error) {
    // Cut short by its caller's budget or abort: not the space's failure.
    if (signal?.aborted) return false;
    const attempts = row.attempts + 1;
    const wait = Math.min(MAX_BACKOFF_MS, 1_000 * 2 ** Math.min(attempts, 20));
    const what = `outbox ${row.id}: ${row.kind} for space ${row.space_id} not delivered (attempt ${attempts})`;
    if (attempts >= STUCK_AFTER) console.error(`STUCK ${what}: still kept, needs a look`, error);
    else console.error(what, error);
    try {
      await env.DB.prepare("UPDATE space_outbox SET attempts = ?, next_attempt_at = ? WHERE id = ?")
        .bind(attempts, Date.now() + wait, row.id)
        .run();
    } catch (counted) {
      console.error(`outbox ${row.id}: attempt not counted`, counted);
    }
    return false;
  }
}

/** One control call, within its deadline; anything but a 2xx throws, so the row stays. */
async function control(
  env: Env,
  spaceId: string,
  method: string,
  path: string,
  epoch: number | null,
  body?: unknown,
  signal?: AbortSignal,
): Promise<void> {
  // The marker the space requires on `/internal/*`; never sent on a forwarded request.
  const headers: Record<string, string> = { [INTERNAL_HEADER]: "1" };
  if (epoch !== null) headers[ACCESS_EPOCH_HEADER] = String(epoch);
  if (body !== undefined) headers["Content-Type"] = "application/json";
  const res = await spaceStub(env, spaceId).fetch(`https://space${path}`, {
    method,
    headers,
    signal: signal
      ? AbortSignal.any([signal, AbortSignal.timeout(CALL_DEADLINE_MS)])
      : AbortSignal.timeout(CALL_DEADLINE_MS),
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  await res.body?.cancel();
  if (!res.ok) throw new Error(`space ${spaceId} ${method} ${path} answered ${res.status}`);
}

const epochIn = (result: D1Result | undefined): number | undefined =>
  (result?.results[0] as { access_epoch?: number } | undefined)?.access_epoch;

async function send(env: Env, row: OutboxRow, signal?: AbortSignal): Promise<void> {
  const body = JSON.parse(row.body_json) as Record<string, unknown>;
  const spaceId = row.space_id;
  switch (row.kind) {
    case "purge":
      await control(env, spaceId, "POST", "/internal/purge", null, undefined, signal);
      return;
    case "credential-revoked": {
      const [space] = await env.DB.batch([epochStatement(env.DB, spaceId)]);
      const epoch = epochIn(space);
      if (epoch === undefined) return; // the space is gone: nothing to close there
      // A legacy time `cutoff` (or a bare person) maps to the bare form: the
      // space closes every socket and push of the person; the directory has
      // already deleted the credentials, so only live ones reconnect.
      const call: InternalCredentialRevokedRequest = {
        personId: String(body.personId),
        ...(Array.isArray(body.credentialIds)
          ? { credentialIds: body.credentialIds.map(String) }
          : {}),
        ...(typeof body.minGeneration === "number" ? { minGeneration: body.minGeneration } : {}),
      };
      await control(env, spaceId, "POST", "/internal/credential-revoked", epoch, call, signal);
      return;
    }
    case "access":
      await sendAccess(env, spaceId, String(body.personId), signal);
      return;
    case "person":
      await sendPerson(env, spaceId, String(body.personId), signal);
      return;
    // An older Worker's rows, mapped onto the per-person calls.
    case "standing":
      await sendAccess(env, spaceId, String(body.personId), signal);
      await sendPerson(env, spaceId, String(body.personId), signal);
      return;
    case "shares": {
      const holder = await env.DB.prepare(
        "SELECT id FROM people WHERE email = ? AND deleted_at IS NULL",
      )
        .bind(String(body.email))
        .first<string>("id");
      if (holder === null) return;
      await sendAccess(env, spaceId, holder, signal);
      await sendPerson(env, spaceId, holder, signal);
      return;
    }
    case "people": {
      const ids = await env.DB.prepare(
        `SELECT person_id AS id FROM space_members WHERE space_id = ?1
         UNION SELECT p.id FROM shares s JOIN people p ON p.email = s.email
           WHERE s.space_id = ?1 AND p.deleted_at IS NULL`,
      )
        .bind(spaceId)
        .all<{ id: string }>();
      for (const { id } of ids.results) await sendPerson(env, spaceId, id, signal);
      return;
    }
  }
}

function epochStatement(db: D1Database, spaceId: string): D1PreparedStatement {
  return db.prepare("SELECT access_epoch FROM spaces WHERE id = ?").bind(spaceId);
}

/** The person's whole current scope in the space (member, guest ids, or none), at one epoch. */
async function sendAccess(
  env: Env,
  spaceId: string,
  personId: string,
  signal?: AbortSignal,
): Promise<void> {
  const db = env.DB;
  const [space, person, role, shared] = await db.batch([
    epochStatement(db, spaceId),
    db.prepare("SELECT email FROM people WHERE id = ?").bind(personId),
    db
      .prepare("SELECT role FROM space_members WHERE space_id = ? AND person_id = ?")
      .bind(spaceId, personId),
    db
      .prepare(
        `SELECT s.interaction_id FROM shares s JOIN people p ON p.email = s.email
         WHERE s.space_id = ? AND p.id = ? AND p.deleted_at IS NULL
         ORDER BY s.created_at, s.interaction_id LIMIT ?`,
      )
      .bind(spaceId, personId, LIMITS.MAX_INTERACTIONS_PER_STATE),
  ]);
  const epoch = epochIn(space);
  if (epoch === undefined) return;
  const email = (person?.results[0] as { email?: string | null } | undefined)?.email ?? null;
  const memberRole = (role?.results[0] as { role?: "admin" | "member" } | undefined)?.role;
  const ids = ((shared?.results ?? []) as { interaction_id: string }[]).map(
    (r) => r.interaction_id,
  );
  const access: CallerAccess | null =
    email === null
      ? null
      : memberRole !== undefined
        ? { kind: "member", role: memberRole }
        : ids.length > 0
          ? { kind: "guest", interactionIds: ids }
          : null;
  const call: InternalAccessChangedRequest = { personId, access };
  await control(env, spaceId, "POST", "/internal/access-changed", epoch, call, signal);
}

type PersonFacts = Pick<PersonRow, "id" | "name" | "initials" | "tint" | "picture_key"> & {
  email: string | null;
  deleted_at: number | null;
  member: number;
  guest: number;
};

/** The person as the space should show them now: an upsert, or their removal. */
async function sendPerson(
  env: Env,
  spaceId: string,
  personId: string,
  signal?: AbortSignal,
): Promise<void> {
  const db = env.DB;
  const [space, facts] = await db.batch([
    epochStatement(db, spaceId),
    db
      .prepare(
        `SELECT p.id, p.name, p.initials, p.tint, ${PICTURE_KEY_COLUMN}, p.email, p.deleted_at,
           EXISTS (SELECT 1 FROM space_members m WHERE m.space_id = ?1 AND m.person_id = p.id) AS member,
           EXISTS (SELECT 1 FROM shares s WHERE s.space_id = ?1 AND s.email = p.email) AS guest
         FROM people p WHERE p.id = ?2`,
      )
      .bind(spaceId, personId),
  ]);
  const epoch = epochIn(space);
  if (epoch === undefined) return;
  const row = facts?.results[0] as PersonFacts | undefined;
  // A deleted person's tombstone ("Deleted person", both flags cleared), so
  // their past messages read as it everywhere (R3-S8).
  if (row && row.deleted_at !== null) {
    const tombstone: InternalPersonRequest = {
      person: { ...summaryOf({ ...row, picture_key: null }), member: false, guest: false },
    };
    await control(env, spaceId, "POST", "/internal/person", epoch, tombstone, signal);
    return;
  }
  const call: InternalPersonRequest =
    row && row.email !== null && (row.member === 1 || row.guest === 1)
      ? {
          person: {
            // Their picture through this space; a member's alias, which the
            // space shows only to its members.
            ...summaryOf(row, { spaceId }),
            ...(row.member === 1 && aliasOf(row.email) ? { alias: aliasOf(row.email) } : {}),
            member: row.member === 1,
            ...(row.member !== 1 && row.guest === 1 ? { guest: true } : {}),
          },
        }
      : { personId, removed: true };
  await control(env, spaceId, "POST", "/internal/person", epoch, call, signal);
}
