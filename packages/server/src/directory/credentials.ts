/**
 * Credentials (spec §4): web sessions, extension client tokens, and one-time
 * extension sign-in codes. Only SHA-256 hashes are stored.
 */
import { CLIENT_TOKEN_PREFIX } from "@onlay/protocol";
import type { Env } from "../env";
import { type SpaceStanding, standingsFrom, standingsStatement } from "./access";
import { agentAccessRemoval, type Later, removalsIn, removeAgentAccess } from "./agent-access";
import { newId, newSecret, pkceChallenge, sha256Hex } from "./crypto";
import { PERSON_COLUMNS, type PersonRow } from "./db";
import {
  bumpEpochsForPerson,
  deliver,
  enqueueForPersonSpaces,
  enqueueGenerationRevoked,
  enqueueSelect,
  returnedIds,
} from "./notify";

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

export const SESSION_TTL = 30 * DAY;
/** A session is renewed (cookie and expiry) on use once this much has passed since the last renewal. */
const SESSION_RENEW_AFTER = HOUR;
const AUTH_CODE_TTL = 2 * MINUTE;
/** Token last-used writes happen at most this often. */
const TOKEN_TOUCH_EVERY = MINUTE;
/** How long an identity cutoff (S-1) is kept. */
const IDENTITY_CUTOFF_KEPT = 31 * DAY;

type LivePerson = PersonRow & { email: string };

/* ── one authorization decision (round 2, S1) ────────────────────── */

/** The credential a request presented, as stored: which table, and its hash. */
export interface CredentialRef {
  kind: "session" | "token";
  hash: string;
}

/** The credential's liveness rule, with its binds numbered from `?n`. */
function liveCredential(ref: CredentialRef, n: number): { from: string; binds: unknown[] } {
  const table = ref.kind === "session" ? "sessions" : "client_tokens";
  const alive = ref.kind === "session" ? `c.expires_at > ?${n + 1}` : "c.revoked_at IS NULL";
  return {
    // A credential stamped below its person's generation is dead (R3-S1): a
    // previous Worker's insert racing a sign-out everywhere carries 0.
    from: `${table} c JOIN people p ON p.id = c.person_id
      WHERE c.token_hash = ?${n} AND ${alive} AND p.deleted_at IS NULL AND p.email IS NOT NULL
        AND c.generation >= p.credential_generation`,
    binds: ref.kind === "session" ? [ref.hash, Date.now()] : [ref.hash],
  };
}

/** A live credential: its id, the generation it was stamped with, and its person as they are now. */
export interface LiveCredential {
  id: string;
  generation: number;
  person: LivePerson;
}

/**
 * One D1 batch (one transaction): is the credential live, who is its person
 * now (email included), and their standing and the epoch in these spaces
 * (all of them when `only` is absent). Null when the credential is gone.
 * Every forward, upgrade, fan-out and stale-access retry decides from this.
 */
export async function authorize(
  db: D1Database,
  ref: CredentialRef,
  only?: string[],
): Promise<{ credential: LiveCredential; standings: SpaceStanding[] } | null> {
  const row = liveCredential(ref, 1);
  const who = liveCredential(ref, 3);
  const [found, standings] = await db.batch([
    db
      .prepare(
        `SELECT ${PERSON_COLUMNS}, c.id AS credential_id, c.generation AS generation FROM ${row.from}`,
      )
      .bind(...row.binds),
    standingsStatement(
      db,
      {
        who: `SELECT p.id, p.email, p.credential_generation AS generation FROM ${who.from}`,
        binds: who.binds,
      },
      only,
    ),
  ]);
  const credential = found?.results[0] as
    | (PersonRow & { credential_id: string; generation: number })
    | undefined;
  if (credential === undefined || credential.email === null) return null;
  const { credential_id, generation, ...person } = credential;
  return {
    credential: { id: credential_id, generation: Number(generation), person: person as LivePerson },
    standings: standingsFrom((standings?.results ?? []) as Parameters<typeof standingsFrom>[0]),
  };
}

/* ── sessions ─────────────────────────────────────────────────────── */

export interface Session {
  id: string;
  person: LivePerson;
  renewedAt: number;
  /** The generation the session was stamped with (the caller header's `credentialGeneration`). */
  generation: number;
  /** The stored hash, to re-check the session in one batch with a standing. */
  hash: string;
  /** The cookie value the request carried, to re-send it on renewal. Never stored. */
  secret: string;
  /** The AuthKit session it came from (migrations/0010); null for the dev stub and older sessions. */
  workosSessionId: string | null;
}

export async function createSession(
  db: D1Database,
  personId: string,
  /** The AuthKit session this sign-in started, which signing out ends too. */
  workosSessionId?: string,
  /**
   * The generation the sign-in was authorized under (`SignedIn.generation`):
   * when the person's has moved on since (a sign out everywhere committed
   * while the sign-in finished), no session is issued and this is null.
   */
  generation?: number,
  /**
   * When the sign-in attempt began (Unix seconds): no session when the
   * person's credentials were revoked at or after it (a sign out everywhere
   * that committed while the code was still being exchanged). Undefined when
   * the sign-in's own change revoked them (it is exempt from it).
   */
  attemptStartedAt?: number,
): Promise<{ id: string; secret: string } | null> {
  const id = newId("ses");
  const secret = newSecret();
  const now = Date.now();
  // Stamped with the person's generation read in this very statement (R3-S1):
  // a sign-out everywhere either commits first (and this reads the new
  // generation) or after (and deletes this row).
  const inserted = await db
    .prepare(
      `INSERT INTO sessions (id, person_id, token_hash, created_at, renewed_at, expires_at, generation,
         workos_session_id)
       SELECT ?1, id, ?2, ?3, ?3, ?4, credential_generation, ?6 FROM people
       WHERE id = ?5 AND deleted_at IS NULL AND (?7 IS NULL OR credential_generation = ?7)
         AND (?8 IS NULL OR credentials_revoked_at IS NULL OR credentials_revoked_at < ?8)`,
    )
    .bind(
      id,
      await sha256Hex(secret),
      now,
      now + SESSION_TTL,
      personId,
      workosSessionId ?? null,
      generation ?? null,
      attemptStartedAt ?? null,
    )
    .run();
  return inserted.meta.changes === 1 ? { id, secret } : null;
}

export async function sessionBySecret(db: D1Database, secret: string): Promise<Session | null> {
  const hash = await sha256Hex(secret);
  const row = await db
    .prepare(
      `SELECT ${PERSON_COLUMNS}, s.id AS session_id, s.renewed_at, s.generation,
         s.workos_session_id FROM sessions s
       JOIN people p ON p.id = s.person_id
       WHERE s.token_hash = ? AND s.expires_at > ? AND p.deleted_at IS NULL
         AND s.generation >= p.credential_generation`,
    )
    .bind(hash, Date.now())
    .first<
      PersonRow & {
        session_id: string;
        renewed_at: number;
        generation: number;
        workos_session_id: string | null;
      }
    >();
  if (row === null || row.email === null) return null;
  const { session_id, renewed_at, generation, workos_session_id, ...person } = row;
  return {
    id: session_id,
    person: person as LivePerson,
    renewedAt: renewed_at,
    generation: Number(generation),
    hash,
    secret,
    workosSessionId: workos_session_id ?? null,
  };
}

/** Extends the session another 30 days; true when the cookie should be re-sent. */
export async function renewSession(db: D1Database, session: Session): Promise<boolean> {
  const now = Date.now();
  if (now - session.renewedAt < SESSION_RENEW_AFTER) return false;
  await db
    .prepare("UPDATE sessions SET renewed_at = ?, expires_at = ? WHERE id = ?")
    .bind(now, now + SESSION_TTL, session.id)
    .run();
  return true;
}

/**
 * Every space the person sees closes the sockets opened with these
 * credentials and drops their push subscriptions (finding 2): one
 * `credential-revoked` notice per space, and an epoch bump so an upgrade
 * already in flight with the old credential is refused and re-resolved.
 * The statements join the revoking batch; the first one's ids are delivered.
 */
function revocationNotices(
  db: D1Database,
  person: { id: string; email: string },
  credentialIds: string[],
): D1PreparedStatement[] {
  return [
    enqueueForPersonSpaces(db, person, "credential-revoked", {
      personId: person.id,
      credentialIds,
    }),
    bumpEpochsForPerson(db, person),
  ];
}

/** Sign out this session, and tell the person's spaces. */
export async function deleteSession(
  env: Env,
  person: { id: string; email: string },
  sessionId: string,
): Promise<void> {
  const db = env.DB;
  const results = await db.batch([
    ...revocationNotices(db, person, [sessionId]),
    db.prepare("DELETE FROM sessions WHERE id = ?").bind(sessionId),
  ]);
  await deliver(env, returnedIds(results, [0]));
}

/**
 * Every credential of the person ends, ordered by D1 rather than by a clock
 * (R3-S1): the person's generation advances, every session, client token and
 * sign-in code of theirs is deleted (no timestamp predicate), and each space
 * they see is told the new generation, read in this batch, as the minimum it
 * accepts. A sign-in or enrolment that commits after this batch reads the new
 * generation; one that committed before is deleted here. Statements for the
 * revoking batch; the first one's ids are delivered.
 */
export function generationStatements(
  db: D1Database,
  person: { id: string; email: string },
  /** The MCP access token (its `jti`) whose own sign-in caused this revocation: exempt from it (S-2). */
  causedBy?: string,
): D1PreparedStatement[] {
  return [
    // The generation ends every session and client token; the time (Unix
    // seconds, taken by SQLite in this batch) ends every MCP access token
    // AuthKit issued before it, which D1 cannot delete (3b-S1). The token
    // that caused it is named with that very time, so any later revocation
    // ends the exemption.
    db
      .prepare(
        `UPDATE people SET credential_generation = credential_generation + 1,
           credentials_revoked_at = CAST(strftime('%s', 'now') AS INTEGER),
           credentials_revoked_by = CASE WHEN ?2 IS NULL THEN NULL
             ELSE CAST(strftime('%s', 'now') AS INTEGER) || ':' || ?2 END
         WHERE id = ?1`,
      )
      .bind(person.id, causedBy ?? null),
    enqueueGenerationRevoked(db, person),
    bumpEpochsForPerson(db, person),
    db.prepare("DELETE FROM sessions WHERE person_id = ?").bind(person.id),
    db.prepare("DELETE FROM client_tokens WHERE person_id = ?").bind(person.id),
    db.prepare("DELETE FROM auth_codes WHERE person_id = ?").bind(person.id),
  ];
}

/**
 * A cutoff for one identity that outlives its person row (S-1): every MCP
 * access token proving it and issued at or before now is refused, whichever
 * person it would reach or create. For the revoking batch.
 */
export function identityCutoff(
  db: D1Database,
  kind: "workos" | "email",
  /** SQL selecting one column `v` (the subject or email), or no row (nothing written). */
  valueSql: string,
  binds: unknown[],
): D1PreparedStatement {
  return db
    .prepare(
      `INSERT INTO identity_cutoffs (kind, value, revoked_at)
       SELECT '${kind}', v, CAST(strftime('%s', 'now') AS INTEGER) FROM (${valueSql})
       WHERE v IS NOT NULL
       ON CONFLICT (kind, value) DO UPDATE SET revoked_at = max(revoked_at, excluded.revoked_at)`,
    )
    .bind(...binds);
}

/** The longest MCP token id an exemption names (AuthKit's are ULIDs). */
const MAX_TOKEN_ID = 256;

/** The token id an exemption may name, or undefined. */
export function agentTokenId(jti: unknown): string | undefined {
  return typeof jti === "string" && jti.length > 0 && jti.length <= MAX_TOKEN_ID ? jti : undefined;
}

/** What an MCP access token proves, for the revocation checks. */
export interface AgentTokenFacts {
  /** `iat`, Unix seconds (anything else cannot show when it was issued). */
  iat: unknown;
  jti: unknown;
  /** The WorkOS subject (`sub`). */
  subject: string;
  /** The verified email it reaches, once known. */
  email?: string | null | undefined;
  /** The person it reaches, once known. */
  personId?: string | undefined;
}

/**
 * The rule "this MCP access token is accepted", as SQL over `tokenBinds`,
 * evaluated where it is used (a read, or a guard inside the batch that
 * creates or relinks a person, 2-S2):
 *
 * - no identity cutoff (S-1: account deletion, a former subject) for its
 *   subject or either email stands at or after its issue second;
 * - the person's last revocation as a whole (3b-S1, S-2) does not lie after
 *   its whole issue second: `iat` and the cutoff are both Unix seconds, so a
 *   token issued in the revocation's own second is accepted. The token whose
 *   own sign-in caused that revocation is exempt from it.
 *
 * A token without a numeric `iat` is refused once any cutoff applies.
 */
export const TOKEN_ACCEPTED = `(NOT EXISTS (SELECT 1 FROM identity_cutoffs c
    WHERE ((c.kind = 'workos' AND c.value = ?3) OR (c.kind = 'email' AND c.value IN (?4, ?5)))
      AND (?1 IS NULL OR c.revoked_at >= ?1))
  AND NOT EXISTS (SELECT 1 FROM people r WHERE r.id = ?6 AND r.credentials_revoked_at IS NOT NULL
      AND (?2 IS NULL OR r.credentials_revoked_by IS NOT (r.credentials_revoked_at || ':' || ?2))
      AND (?1 IS NULL OR ?1 < r.credentials_revoked_at)))`;

/**
 * `TOKEN_ACCEPTED`'s binds: the token, the emails it may reach (the person's
 * current one, and the one WorkOS now reports; both default to `email`) and
 * the person.
 */
export function tokenBinds(
  token: AgentTokenFacts,
  current: string | null | undefined = token.email,
  reported: string | null | undefined = current,
): unknown[] {
  const iat = typeof token.iat === "number" && Number.isFinite(token.iat) ? token.iat : null;
  return [
    iat,
    agentTokenId(token.jti) ?? null,
    token.subject,
    current ?? null,
    reported ?? null,
    token.personId ?? null,
  ];
}

/** Whether a revocation refuses this MCP access token (`TOKEN_ACCEPTED`, read now). */
export async function agentTokenRevoked(db: D1Database, token: AgentTokenFacts): Promise<boolean> {
  const ok = await db
    .prepare(`SELECT ${TOKEN_ACCEPTED} AS ok`)
    .bind(...tokenBinds(token))
    .first<number>("ok");
  return Number(ok) !== 1;
}

/**
 * Sign out everywhere: one batch, its notices delivered after, and, after the
 * response (`later`), the person's authorized applications removed at WorkOS
 * (S-3), so an agent's refresh token stops working too, and their AuthKit
 * sessions revoked, so no browser of theirs is signed back in without being
 * asked. `ownSession` is the AuthKit session of the browser that asked, which
 * that browser ends itself through AuthKit's logout: the first try leaves it
 * to that, and a retry revokes it like the rest.
 */
export async function signOutEverywhere(
  env: Env,
  person: { id: string; email: string },
  later: Later,
  ownSession?: string,
): Promise<void> {
  const db = env.DB;
  const statements = generationStatements(db, person);
  const results = await db.batch([...statements, agentAccessRemoval(db, person.id)]);
  await deliver(env, returnedIds(results, [1]));
  later(removeAgentAccess(env, removalsIn(results[statements.length]), ownSession));
}

/* ── client tokens ────────────────────────────────────────────────── */

export interface ClientToken {
  id: string;
  person: LivePerson;
  generation: number;
  hash: string;
}

/** A client token for the dev stub's sign-in (the extension enrols through `redeemAuthCode`). */
export async function createClientToken(
  db: D1Database,
  personId: string,
): Promise<{ id: string; token: string }> {
  const id = newId("tok");
  const token = CLIENT_TOKEN_PREFIX + newSecret();
  await db
    .prepare(
      `INSERT INTO client_tokens (id, person_id, token_hash, created_at, generation)
       SELECT ?1, id, ?2, ?3, credential_generation FROM people WHERE id = ?4 AND deleted_at IS NULL`,
    )
    .bind(id, await sha256Hex(token), Date.now(), personId)
    .run();
  return { id, token };
}

/** The live token's person, touching `last_used_at` at most once a minute. */
export async function clientTokenBySecret(
  db: D1Database,
  token: string,
): Promise<ClientToken | null> {
  const hash = await sha256Hex(token);
  const row = await db
    .prepare(
      `SELECT ${PERSON_COLUMNS}, t.id AS token_id, t.last_used_at, t.generation FROM client_tokens t
       JOIN people p ON p.id = t.person_id
       WHERE t.token_hash = ? AND t.revoked_at IS NULL AND p.deleted_at IS NULL
         AND t.generation >= p.credential_generation`,
    )
    .bind(hash)
    .first<PersonRow & { token_id: string; last_used_at: number | null; generation: number }>();
  if (row === null || row.email === null) return null;
  const { token_id, last_used_at, generation, ...person } = row;
  const now = Date.now();
  if (last_used_at === null || now - last_used_at >= TOKEN_TOUCH_EVERY) {
    await db
      .prepare("UPDATE client_tokens SET last_used_at = ? WHERE id = ?")
      .bind(now, token_id)
      .run();
  }
  return { id: token_id, person: person as LivePerson, generation: Number(generation), hash };
}

/** Revokes one client token, and tells the person's spaces. */
export async function revokeClientToken(
  env: Env,
  person: { id: string; email: string },
  tokenId: string,
): Promise<void> {
  const db = env.DB;
  const results = await db.batch([
    ...revocationNotices(db, person, [tokenId]),
    db
      .prepare("UPDATE client_tokens SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL")
      .bind(Date.now(), tokenId),
  ]);
  await deliver(env, returnedIds(results, [0]));
}

/* ── extension sign-in codes ──────────────────────────────────────── */

/**
 * A one-time code bound to (person, challenge) and to the browser session
 * that issued it, valid for two minutes.
 */
export async function mintAuthCode(
  db: D1Database,
  personId: string,
  challenge: string,
  sessionId: string,
): Promise<string> {
  const code = newSecret();
  const now = Date.now();
  await db
    .prepare(
      "INSERT INTO auth_codes (code_hash, person_id, challenge, created_at, expires_at, session_id) VALUES (?, ?, ?, ?, ?, ?)",
    )
    .bind(await sha256Hex(code), personId, challenge, now, now + AUTH_CODE_TTL, sessionId)
    .run();
  return code;
}

/**
 * Spends the code and mints the client token in ONE batch (round 2, S7): the
 * token row is inserted only while the code is unexpired, its PKCE challenge
 * matches, its issuing session is live and its person is live, and the code
 * is deleted whatever happens. A sign-out everywhere that commits first
 * leaves the session gone and so no token. The token and its person; null
 * for a bad code; `session-ended` when its session (or person) is gone.
 */
export async function redeemAuthCode(
  db: D1Database,
  code: string,
  verifier: string,
): Promise<{ token: string; personId: string } | "session-ended" | null> {
  const codeHash = await sha256Hex(code);
  const challenge = await pkceChallenge(verifier);
  const id = newId("tok");
  const token = CLIENT_TOKEN_PREFIX + newSecret();
  const now = Date.now();
  const [minted, spent] = await db.batch([
    db
      .prepare(
        `INSERT INTO client_tokens (id, person_id, token_hash, created_at, generation)
         SELECT ?1, a.person_id, ?2, ?3, p.credential_generation FROM auth_codes a
           JOIN sessions s ON s.id = a.session_id AND s.person_id = a.person_id AND s.expires_at > ?3
           JOIN people p ON p.id = a.person_id AND p.deleted_at IS NULL AND p.email IS NOT NULL
         WHERE a.code_hash = ?4 AND a.expires_at > ?3 AND a.challenge = ?5
           AND s.generation >= p.credential_generation
         RETURNING person_id`,
      )
      .bind(id, await sha256Hex(token), now, codeHash, challenge),
    db
      .prepare("DELETE FROM auth_codes WHERE code_hash = ? RETURNING challenge, expires_at")
      .bind(codeHash),
  ]);
  const personId = (minted?.results[0] as { person_id?: string } | undefined)?.person_id;
  if (personId !== undefined) return { token, personId };
  const row = spent?.results[0] as { challenge: string; expires_at: number } | undefined;
  if (row === undefined || row.expires_at <= now || row.challenge !== challenge) return null;
  return "session-ended";
}

/** How many expired sessions one sweep ends (the next day's sweep takes the rest). */
const SWEEP_SESSIONS = 500;
/** How many credential ids one revocation notice names. */
const REVOKED_IDS_PER_NOTICE = 200;

/**
 * The daily sweep: expired sessions (each person's spaces told which ids
 * ended, round 2 S8, in the deleting batch), expired codes, and rate windows
 * long past, and identity cutoffs past their keep.
 */
export async function sweep(env: Env): Promise<void> {
  const db = env.DB;
  const now = Date.now();
  const expired = `SELECT id, person_id FROM sessions WHERE expires_at <= ?1 ORDER BY expires_at LIMIT ${SWEEP_SESSIONS}`;
  // Each expired session numbered within its person, so a notice names at most
  // REVOKED_IDS_PER_NOTICE of them (R3-S7; the space accepts 256).
  const numbered = `SELECT id, person_id,
      (ROW_NUMBER() OVER (PARTITION BY person_id ORDER BY id) - 1) / ${REVOKED_IDS_PER_NOTICE} AS chunk
    FROM (${expired})`;
  const results = await db.batch([
    // One credential-revoked row per (space, person, chunk) naming those expired sessions.
    enqueueSelect(
      db,
      "credential-revoked",
      `SELECT sp.space_id, json_object('personId', x.person_id,
           'credentialIds', json_group_array(DISTINCT x.id)) AS body_json
         FROM (${numbered}) x JOIN people p ON p.id = x.person_id
         JOIN (SELECT space_id, person_id, NULL AS email FROM space_members
               UNION SELECT space_id, NULL, email FROM shares) sp
           ON sp.person_id = x.person_id OR sp.email = p.email
         GROUP BY sp.space_id, x.person_id, x.chunk`,
      [now],
    ),
    db.prepare(`DELETE FROM sessions WHERE id IN (SELECT id FROM (${expired}))`).bind(now),
    db.prepare("DELETE FROM auth_codes WHERE expires_at <= ?").bind(now),
    db.prepare("DELETE FROM rate_counters WHERE window_start < ?").bind(now - HOUR),
    // An identity cutoff outlives every access token issued before it long before this.
    db
      .prepare("DELETE FROM identity_cutoffs WHERE revoked_at < ?")
      .bind(Math.floor((now - IDENTITY_CUTOFF_KEPT) / 1000)),
  ]);
  await deliver(env, returnedIds(results, [0]));
}
