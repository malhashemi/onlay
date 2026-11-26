/**
 * People (spec §4): who may become a person, first sign-in, invitation claim,
 * renaming, and account deletion. A person is their email, lower-cased and
 * trimmed; a WorkOS user joins or creates one only with a verified email.
 */
import { LIMITS, normalizeEmail, PersonSummarySchema } from "@onlay/protocol";
import * as z from "zod/mini";
import type { Env } from "../env";
import { spacesOf } from "./access";
import { agentAccessRemoval, type Later, removalsIn, removeAgentAccess } from "./agent-access";
import {
  type AgentTokenFacts,
  agentTokenId,
  generationStatements,
  identityCutoff,
  TOKEN_ACCEPTED,
  tokenBinds,
} from "./credentials";
import { newPersonId, newSpaceId } from "./crypto";
import { aliasOf, guard, memberSpaces, PERSON_COLUMNS, type PersonRow, summaryOf } from "./db";
import { Failure, isGuard, isUnique } from "./failure";
import { deliver, enqueue, enqueueForPersonSpaces, enqueueSelect, returnedIds } from "./notify";
import { syncProviderPicture } from "./pictures";

/** Tints assigned at first sign-in, picked by the person id. */
const TINTS = [
  "#0e7490",
  "#2563eb",
  "#7c3aed",
  "#c026d3",
  "#db2777",
  "#dc2626",
  "#ea580c",
  "#ca8a04",
  "#65a30d",
  "#059669",
  "#0d9488",
  "#4f46e5",
];

function tintOf(personId: string): string {
  let hash = 0;
  for (const ch of personId) hash = (hash * 31 + ch.charCodeAt(0)) >>> 0;
  return TINTS[hash % TINTS.length] ?? "#0e7490";
}

/**
 * At most `max` UTF-16 units (what the wire schemas count) and `maxPoints`
 * code points (what D1's CHECKs count), never splitting a code point (round
 * 2, S3: "ΐ".toUpperCase() is three units, an astral letter is two).
 */
function clampUnits(text: string, max: number, maxPoints = max): string {
  let out = "";
  let points = 0;
  for (const point of text) {
    if (out.length + point.length > max || points === maxPoints) break;
    out += point;
    points += 1;
  }
  return out;
}

/** D1's own rule for initials (migrations/0003): one to three characters (code points). */
const MAX_INITIALS_POINTS = 3;

function initialsOf(name: string): string {
  const words = name
    .split(/[\s._-]+/)
    .map((word) => word.replace(/[^\p{L}\p{N}]/gu, ""))
    .filter((word) => word.length > 0);
  const letters = words.length > 1 ? [words[0], words[words.length - 1]] : [words[0]];
  const out = clampUnits(
    letters
      .map((word) => [...(word ?? "")][0] ?? "")
      .join("")
      .toUpperCase(),
    LIMITS.MAX_INITIALS,
    MAX_INITIALS_POINTS,
  );
  return out.length > 0 ? out : "?";
}

/**
 * The one sanitiser for every display name stored, the person's own and a
 * provider's: bidirectional overrides and isolates and every other control
 * character go, whitespace collapses to single spaces, and the result keeps
 * at most 80 UTF-16 units (never splitting a code point). Empty when nothing
 * is left.
 */
export function cleanDisplayName(raw: string | undefined): string {
  const text = (raw ?? "")
    .replace(/[\u202a-\u202e\u2066-\u2069\u200e\u200f\u061c]/gu, "")
    .replace(/[\s\p{Cc}]+/gu, " ")
    .replace(/\p{Cc}/gu, "")
    .trim();
  return clampUnits(text, LIMITS.MAX_ACTOR_NAME).trim();
}

/** A display name: as given (cleaned), else the email's local part; at most 80 UTF-16 units. */
function displayName(name: string | undefined, email: string): string {
  const given = cleanDisplayName(name);
  const chosen = given.length > 0 ? given : cleanDisplayName(email.split("@")[0] ?? email);
  return chosen || "Someone";
}

/**
 * The name a sign-in brings, when it brings one the wire can carry
 * (trimmed, spaces collapsed, at most 80 units); else undefined.
 */
function providerName(name: string | undefined, person: Pick<PersonRow, "id" | "tint">) {
  const clean = cleanDisplayName(name);
  if (clean.length === 0) return undefined;
  const row = { ...person, name: clean, initials: initialsOf(clean), picture_key: null };
  return z.safeParse(PersonSummarySchema, summaryOf(row)).success ? clean : undefined;
}

const PROFILE_REFUSED = "That name can't be shown in Onlay. Try a shorter or plainer one.";

/** A profile is saved only when its wire form validates (round 2, S3). */
function requireWireSafe(row: Pick<PersonRow, "id" | "name" | "initials" | "tint">) {
  if (!z.safeParse(PersonSummarySchema, summaryOf(row)).success) {
    throw new Failure("invalid", PROFILE_REFUSED);
  }
}

function superAdminEmails(env: Env): Set<string> {
  return new Set(
    (env.SUPER_ADMINS ?? "")
      .split(",")
      .map(normalizeEmail)
      .filter((email) => email.length > 0),
  );
}

export async function personById(db: D1Database, id: string): Promise<PersonRow | null> {
  return db
    .prepare(`SELECT ${PERSON_COLUMNS} FROM people p WHERE p.id = ? AND p.deleted_at IS NULL`)
    .bind(id)
    .first<PersonRow>();
}

export async function personByEmail(db: D1Database, email: string): Promise<PersonRow | null> {
  return db
    .prepare(`SELECT ${PERSON_COLUMNS} FROM people p WHERE p.email = ? AND p.deleted_at IS NULL`)
    .bind(normalizeEmail(email))
    .first<PersonRow>();
}

/** What a sign-in provider (or the dev stub) says about who signed in. */
export interface SignInProfile {
  email: string;
  emailVerified: boolean;
  name?: string | undefined;
  avatarUrl?: string | undefined;
  /** The WorkOS user id; absent for the dev stub. */
  workosUserId?: string | undefined;
}

export interface SignedIn {
  person: PersonRow & { email: string };
  /** True when this sign-in created the person (and their personal space). */
  created: boolean;
  /** Workspaces joined by claiming invitations in this sign-in. */
  joined: string[];
  /** Outbox rows this sign-in wrote: the spaces it touched, to tell (`afterSignIn`). */
  notices: string[];
  /**
   * The credential generation this sign-in was authorized under, with the
   * advance it caused itself (an email or WorkOS subject change): a session
   * is issued only while the person still has it (`createSession`), so a sign
   * out everywhere that commits while the sign-in finishes wins.
   */
  generation: number;
  /** This sign-in advanced the generation itself (an email or WorkOS subject change). */
  advanced: boolean;
}

const UNVERIFIED =
  "Your sign-in provider hasn't verified this email address. Verify it there, then sign in again.";

/**
 * Finds or creates the person behind a verified sign-in, then claims their
 * invitations. Call `afterSignIn` once the response is decided, to tell the
 * spaces they joined.
 */
export async function signIn(
  env: Env,
  profile: SignInProfile,
  /** The MCP access token this sign-in comes from, if any (S-2, 2-S2). */
  token?: AgentTokenFacts,
): Promise<SignedIn> {
  if (!profile.emailVerified) throw new Failure("forbidden", UNVERIFIED);
  const email = normalizeEmail(profile.email);
  if (email.length < 3 || email.length > LIMITS.MAX_EMAIL || !email.includes("@")) {
    throw new Failure(
      "invalid",
      "Your sign-in provider sent an email address Onlay can't use. Check your email there and try again.",
    );
  }
  const db = env.DB;
  let person = await findPerson(db, email, profile.workosUserId);
  let created = false;
  const notices: string[] = [];
  let generation = 0;
  let advanced = false;
  if (person === null) {
    try {
      const made = await createPerson(env, email, profile, token);
      person = made.row;
      notices.push(...made.notices);
      created = true;
    } catch (error) {
      // Two first sign-ins raced: the other one created the person.
      if (!isUnique(error)) throw error;
      person = await findPerson(db, email, profile.workosUserId);
      if (person === null) throw error;
      generation = person.credential_generation ?? 0;
    }
  } else {
    generation = person.credential_generation ?? 0;
    const refreshed = await refreshPerson(db, person, email, profile, token);
    person = refreshed.row;
    notices.push(...refreshed.notices);
    if (refreshed.advanced) {
      generation += 1;
      advanced = true;
    }
  }
  let live = person as PersonRow & { email: string };
  const claimed = await claimInvitations(db, live.id);
  notices.push(...claimed.notices);
  const pictured = await pictureFromProvider(env, live, profile, token);
  notices.push(...pictured);
  if (pictured.length > 0) live = ((await personById(db, live.id)) as typeof live | null) ?? live;
  return { person: live, created, joined: claimed.joined, notices, generation, advanced };
}

/**
 * Onlay's copy of the provider's picture, kept in step at a sign-in
 * (`pictures.ts`); best effort: any failure leaves what was there. From an
 * MCP token the write carries the token's guard, as every write from one does.
 */
async function pictureFromProvider(
  env: Env,
  person: PersonRow & { email: string },
  profile: SignInProfile,
  token?: AgentTokenFacts,
): Promise<string[]> {
  try {
    const guards =
      token === undefined
        ? []
        : [
            ...rowUnchanged(env.DB, person),
            ...tokenGuard(env.DB, token, person.id, person.email, person.email),
          ];
    return await syncProviderPicture(env, person, profile.avatarUrl, guards);
  } catch (error) {
    console.warn(
      "picture: keeping the provider's picture in step failed",
      error instanceof Error ? error.name : "error",
    );
    return [];
  }
}

/**
 * The person a verified sign-in continues: by WorkOS subject, else by email.
 *
 * Identity is the verified email (round 2, S6; as in dossier, and as WorkOS's
 * own email-code sign-in already makes true: whoever controls the mailbox can
 * sign in). So a DIFFERENT WorkOS subject presenting a person's verified
 * email falls back here to that person and continues them. `refreshPerson`
 * then stores the new subject, ends every credential issued before it (a
 * cutoff) and logs it. There is deliberately no separate recovery flow.
 */
async function findPerson(
  db: D1Database,
  email: string,
  workosUserId: string | undefined,
): Promise<PersonRow | null> {
  if (workosUserId !== undefined) {
    const byWorkos = await db
      .prepare(
        `SELECT ${PERSON_COLUMNS} FROM people p WHERE p.workos_user_id = ? AND p.deleted_at IS NULL`,
      )
      .bind(workosUserId)
      .first<PersonRow>();
    if (byWorkos !== null) return byWorkos;
  }
  return personByEmail(db, email);
}

const EMAIL_TAKEN = "That email already belongs to another Onlay account.";

/**
 * A returning person (the security audit's finding 7): link the WorkOS id,
 * follow a verified email change, refresh the picture, and record when WorkOS
 * last vouched for the email, in one batch. Shares and invitations are
 * matched against the person's email at each access check, so a changed email
 * re-scopes them without rewriting rows. When another live person holds the
 * new email the sign-in is refused and nothing changes.
 *
 * Round 2, S6: when the email or the WorkOS subject changes, the same batch
 * moves the epoch of every space where the old or the new address holds a
 * share, queues the person's access (and profile) there, and advances the
 * person's credential generation (R3-S1): every session, token, socket and
 * push subscription issued before it ends. The sign-in's own session is
 * minted after the batch, so it carries the new generation.
 *
 * S-1, S-2: a subject change also writes a cutoff for the former subject, so
 * its older MCP tokens cannot continue (or flip back) the person; the MCP
 * token whose own sign-in this is (`token`) is exempt from the revocation it
 * causes. 2-S1, 2-S2: only when that token is accepted as the batch begins
 * (`tokenGuard`, the batch's first rule): otherwise nothing is written.
 * 3-S1: and only while the row still holds the email and subject this
 * request read (`rowUnchanged`); otherwise too nothing is written, and the
 * MCP caller reads the person again and decides once more.
 */
async function refreshPerson(
  db: D1Database,
  person: PersonRow,
  email: string,
  profile: SignInProfile,
  token?: AgentTokenFacts,
): Promise<{ row: PersonRow; notices: string[]; advanced: boolean }> {
  const avatar = profile.avatarUrl ?? person.avatar_url;
  const workos = profile.workosUserId ?? person.workos_user_id;
  const now = Date.now();
  // The provider's name, unless the person set their own (never overwritten).
  const offered = person.name_set_at == null ? providerName(profile.name, person) : undefined;
  const renamed = offered !== undefined && offered !== person.name ? offered : undefined;
  const name = renamed ?? person.name;
  const initials = renamed !== undefined ? initialsOf(renamed) : person.initials;
  const update = db
    .prepare(
      `UPDATE people SET email = ?, workos_user_id = ?, avatar_url = ?, verified_at = ?,
         name = CASE WHEN name_set_at IS NULL THEN ? ELSE name END,
         initials = CASE WHEN name_set_at IS NULL THEN ? ELSE initials END
       WHERE id = ? AND deleted_at IS NULL`,
    )
    .bind(email, workos, avatar, now, name, initials, person.id);
  const emailChanged = person.email !== null && person.email !== email;
  // A new name, or a new alias (the email's local part), is shown in every
  // space the person is in.
  const realiased = emailChanged && aliasOf(person.email) !== aliasOf(email);
  const renaming =
    renamed === undefined && !realiased
      ? []
      : [enqueueForPersonSpaces(db, { id: person.id, email }, "person", { personId: person.id })];
  const subjectChanged =
    person.workos_user_id !== null &&
    profile.workosUserId !== undefined &&
    profile.workosUserId !== person.workos_user_id;
  const row = {
    ...person,
    email,
    workos_user_id: workos,
    avatar_url: avatar,
    verified_at: now,
    name,
    initials,
  };
  const guarded =
    token === undefined
      ? []
      : [...rowUnchanged(db, person), ...tokenGuard(db, token, person.id, person.email, email)];
  if (!emailChanged && !subjectChanged) {
    if (guarded.length === 0 && renaming.length === 0) {
      await update.run();
      return { row, notices: [], advanced: false };
    }
    const results = await db.batch([...guarded, update, ...renaming]);
    return {
      row,
      notices: renaming.length > 0 ? returnedIds(results, [guarded.length + 1]) : [],
      advanced: false,
    };
  }
  if (subjectChanged) {
    console.warn(
      `sign-in: person ${person.id} continued by a new WorkOS subject with the same verified email; earlier credentials end`,
    );
  }
  const former = person.email ?? email;
  const shareSpaces = "SELECT DISTINCT space_id FROM shares WHERE email IN (?2, ?3)";
  let results: D1Result[];
  try {
    results = await db.batch([
      ...guarded,
      // Read with the former email, so the spaces it reached are told.
      ...generationStatements(
        db,
        { id: person.id, email: former },
        token === undefined ? undefined : agentTokenId(token.jti),
      ),
      enqueueSelect(
        db,
        "access",
        `SELECT space_id, json_object('personId', ?1) AS body_json FROM (${shareSpaces})`,
        [person.id, former, email],
      ),
      enqueueSelect(
        db,
        "person",
        `SELECT space_id, json_object('personId', ?1) AS body_json FROM (${shareSpaces})`,
        [person.id, former, email],
      ),
      db
        .prepare(
          `UPDATE spaces SET access_epoch = access_epoch + 1 WHERE id IN (${shareSpaces.replace("?2, ?3", "?1, ?2")})`,
        )
        .bind(former, email),
      update,
      ...(subjectChanged
        ? [identityCutoff(db, "workos", "SELECT ? AS v", [person.workos_user_id])]
        : []),
      ...renaming,
    ]);
  } catch (error) {
    // The new email belongs to another (live: tombstones hold no email) person.
    if (isUnique(error)) throw new Failure("conflict", EMAIL_TAKEN);
    throw error;
  }
  const at = guarded.length;
  const renamedAt = renaming.length > 0 ? [results.length - 1] : [];
  return {
    row,
    notices: returnedIds(results, [at + 1, at + 6, at + 7, ...renamedAt]),
    advanced: true,
  };
}

/**
 * The guard an MCP sign-in's write carries (2-S2): the token is accepted
 * (`TOKEN_ACCEPTED`) by the person it reaches, under the email they hold and
 * the one WorkOS reports, as the batch runs. Empty for a sign-in without a
 * token (the web). A failing guard rolls the batch back (`change_guard_live`:
 * the identity behind the token is not live for it).
 */
/**
 * The guard an MCP sign-in's relink or refresh carries (3-S1): the person row
 * still holds the email and WorkOS subject the request read, so the token
 * guard judged the identity that is really there.
 */
function rowUnchanged(db: D1Database, person: PersonRow): D1PreparedStatement[] {
  return guard(
    db,
    "live",
    `EXISTS (SELECT 1 FROM people WHERE id = ?1 AND deleted_at IS NULL
       AND email IS ?2 AND workos_user_id IS ?3)`,
    [person.id, person.email, person.workos_user_id],
  );
}

function tokenGuard(
  db: D1Database,
  token: AgentTokenFacts | undefined,
  personId: string | undefined,
  current: string | null,
  reported: string,
): D1PreparedStatement[] {
  if (token === undefined) return [];
  return guard(db, "live", TOKEN_ACCEPTED, tokenBinds({ ...token, personId }, current, reported));
}

/** How long WorkOS's word on a person's email stands before an MCP call checks again. */
const REVERIFY_AFTER_MS = 86_400_000;

/** WorkOS last vouched for this person's email more than a day ago (or never on record). */
export function verificationDue(person: PersonRow, now = Date.now()): boolean {
  return person.verified_at == null || now - person.verified_at > REVERIFY_AFTER_MS;
}

/**
 * A known MCP subject re-checked against WorkOS: an unverified email refuses
 * the request with the sign-in error; otherwise the same update rule as a web
 * sign-in (and the same refusal when the email is another person's).
 */
export async function refreshFromProvider(
  env: Env,
  person: PersonRow,
  profile: SignInProfile,
  token?: AgentTokenFacts,
): Promise<PersonRow & { email: string }> {
  if (!profile.emailVerified) throw new Failure("sign_in_required", UNVERIFIED);
  const email = normalizeEmail(profile.email);
  const refreshed = await refreshPerson(env.DB, person, email, profile, token);
  const row = refreshed.row as PersonRow & { email: string };
  const pictured = await pictureFromProvider(env, row, profile, token);
  await deliver(env, [...refreshed.notices, ...pictured]);
  if (pictured.length === 0) return row;
  return ((await personById(env.DB, row.id)) as (PersonRow & { email: string }) | null) ?? row;
}

/**
 * First sign-in: the person, their personal space, super admin when
 * configured, and a notice to each space already sharing with their email
 * (they are a guest there now), in one batch. From an MCP token, the batch
 * carries that token's guard (2-S2): no cutoff, no person.
 */
async function createPerson(
  env: Env,
  email: string,
  profile: SignInProfile,
  token?: AgentTokenFacts,
): Promise<{ row: PersonRow; notices: string[] }> {
  const db = env.DB;
  const now = Date.now();
  const id = newPersonId();
  const spaceId = newSpaceId();
  const name = displayName(profile.name, email);
  const row: PersonRow = {
    id,
    email,
    name,
    initials: initialsOf(name),
    tint: tintOf(id),
    avatar_url: profile.avatarUrl ?? null,
    workos_user_id: profile.workosUserId ?? null,
    deleted_at: null,
    verified_at: now,
    name_set_at: null,
    picture_choice: null,
    picture_key: null,
  };
  requireWireSafe(row);
  const statements = [
    ...tokenGuard(db, token, undefined, email, email),
    db
      .prepare(
        `INSERT INTO people (id, email, workos_user_id, name, initials, tint, avatar_url, created_at, verified_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind(id, email, row.workos_user_id, name, row.initials, row.tint, row.avatar_url, now, now),
    db
      .prepare(
        `INSERT INTO spaces (id, kind, name, owner_id, created_by, created_at)
         VALUES (?, 'personal', 'personal', ?, ?, ?)`,
      )
      .bind(spaceId, id, id, now),
    db
      .prepare(
        "INSERT INTO space_members (space_id, person_id, role, created_at) VALUES (?, ?, 'admin', ?)",
      )
      .bind(spaceId, id, now),
  ];
  if (superAdminEmails(env).has(email)) {
    statements.push(
      db
        .prepare("INSERT INTO super_admins (person_id, added_by, created_at) VALUES (?, NULL, ?)")
        .bind(id, now),
    );
  }
  // Each space already sharing with the email: their access (a guest now) and profile.
  const sharing = `SELECT DISTINCT space_id, json_object('personId', ?1) AS body_json
    FROM shares WHERE email = ?2`;
  const shareNotices = statements.length;
  statements.push(
    enqueueSelect(db, "access", sharing, [id, email]),
    enqueueSelect(db, "person", sharing, [id, email]),
  );
  const results = await db.batch(statements);
  return { row, notices: returnedIds(results, [shareNotices, shareNotices + 1]) };
}

/**
 * One batch: the invitations to the person's email become member rows and
 * are deleted; each workspace joined moves its access epoch and gets a
 * notice. Returns the workspaces joined and the notices to deliver.
 *
 * S-3, 2-S3: only as many as keep the person a member of at most
 * `LIMITS.MAX_SPACES_PER_PERSON` spaces (guest spaces do not count), oldest
 * invitation first, counted inside the batch. The rest stay invitations,
 * marked as waiting on the limit, and are claimed at a later sign-in.
 */
async function claimInvitations(
  db: D1Database,
  personId: string,
): Promise<{ joined: string[]; notices: string[] }> {
  const email = "(SELECT email FROM people WHERE id = ?1)";
  const fresh = `SELECT space_id, created_at FROM invitations i WHERE i.email = ${email}
    AND NOT EXISTS (SELECT 1 FROM space_members m WHERE m.space_id = i.space_id AND m.person_id = ?1)`;
  const room = `max(0, ${LIMITS.MAX_SPACES_PER_PERSON} - ${memberSpaces(email)})`;
  const chosen = `SELECT space_id FROM (SELECT space_id FROM (${fresh})
    ORDER BY created_at, space_id LIMIT ${room})`;
  const now = Date.now();
  const results = await db.batch([
    db.prepare(chosen).bind(personId),
    db
      .prepare(`UPDATE spaces SET access_epoch = access_epoch + 1 WHERE id IN (${chosen})`)
      .bind(personId),
    enqueueSelect(
      db,
      "access",
      `SELECT space_id, json_object('personId', ?1) AS body_json FROM (${chosen})`,
      [personId],
    ),
    enqueueSelect(
      db,
      "person",
      `SELECT space_id, json_object('personId', ?1) AS body_json FROM (${chosen})`,
      [personId],
    ),
    db
      .prepare(
        `INSERT INTO space_members (space_id, person_id, role, created_at)
         SELECT space_id, ?1, 'member', ?2 FROM (${chosen}) WHERE true
         ON CONFLICT DO NOTHING`,
      )
      .bind(personId, now),
    db
      .prepare(
        `DELETE FROM invitations WHERE email = ${email}
           AND space_id IN (SELECT space_id FROM space_members WHERE person_id = ?1)`,
      )
      .bind(personId),
    // What is left waits on the limit.
    db
      .prepare(
        `UPDATE invitations SET waiting_since = coalesce(waiting_since, ?2) WHERE email = ${email}`,
      )
      .bind(personId, now),
  ]);
  return {
    joined: ((results[0]?.results ?? []) as { space_id: string }[]).map((row) => row.space_id),
    notices: returnedIds(results, [2, 3]),
  };
}

/** Tell the spaces a sign-in touched: workspaces joined, and spaces holding shares for a new person. */
export async function afterSignIn(env: Env, signedIn: SignedIn): Promise<void> {
  await deliver(env, signedIn.notices);
}

/**
 * `PATCH /api/me {name}`: the name (and so the initials) change in every
 * space that shows the person, and it is theirs: no sign-in renames them.
 */
export async function rename(env: Env, person: PersonRow & { email: string }, name: string) {
  const clean = displayName(name, person.email);
  requireWireSafe({ ...person, name: clean, initials: initialsOf(clean) });
  const db = env.DB;
  const results = await db.batch([
    db
      .prepare("UPDATE people SET name = ?, initials = ?, name_set_at = ? WHERE id = ?")
      .bind(clean, initialsOf(clean), Date.now(), person.id),
    enqueueForPersonSpaces(db, person, "person", { personId: person.id }),
  ]);
  await deliver(env, returnedIds(results, [1]));
  return { ...person, name: clean, initials: initialsOf(clean), name_set_at: Date.now() };
}

export const lastAdminMessage = (name: string): string =>
  `You're the last admin of ${name}. Make another member an admin first.`;
export const LAST_SUPER_ADMIN = "Name another super admin first.";

/**
 * Account deletion (spec §4): refused while the person is the last admin of
 * a workspace or the last super admin, checked in the same batch. Otherwise
 * their sessions, tokens, memberships, shares and invitations addressed to
 * them, and their personal space go; the row stays as a "Deleted person"
 * tombstone so past messages in shared spaces stay attributed.
 */
export async function deleteAccount(
  env: Env,
  person: PersonRow & { email: string },
  confirm: string,
  /** Runs the WorkOS removal after the response (S-3, 2-S2). */
  later: Later,
): Promise<void> {
  if (normalizeEmail(confirm) !== person.email) {
    throw new Failure("invalid", `Type ${person.email} to confirm.`);
  }
  const db = env.DB;
  const lastAdminOf = await db
    .prepare(
      `SELECT s.name FROM space_members m JOIN spaces s ON s.id = m.space_id
       WHERE m.person_id = ?1 AND m.role = 'admin' AND s.kind = 'workspace'
         AND (SELECT count(*) FROM space_members a WHERE a.space_id = s.id AND a.role = 'admin') = 1
       ORDER BY s.name LIMIT 1`,
    )
    .bind(person.id)
    .first<{ name: string }>();
  if (lastAdminOf !== null) throw new Failure("last_admin", lastAdminMessage(lastAdminOf.name));

  const spaces = await spacesOf(db, person);
  const personal = spaces.filter((space) => space.kind === "personal" && space.role !== "guest");
  const personalIds = JSON.stringify(personal.map((space) => space.id));
  const purges = personal.map((space) => enqueue(db, space.id, "purge", {}));
  const now = Date.now();
  // Indexes of the statements whose RETURNING ids are notices to deliver.
  const NOTICES = [5, 10, 11];
  const removal = agentAccessRemoval(db, person.id);
  const statements = [
    ...guard(
      db,
      "admins",
      `NOT EXISTS (SELECT 1 FROM space_members m JOIN spaces s ON s.id = m.space_id
           WHERE m.person_id = ? AND m.role = 'admin' AND s.kind = 'workspace'
             AND (SELECT count(*) FROM space_members a WHERE a.space_id = s.id AND a.role = 'admin') = 1)`,
      [person.id],
    ),
    ...guard(
      db,
      "super_admins",
      `NOT EXISTS (SELECT 1 FROM super_admins WHERE person_id = ?)
           OR (SELECT count(*) FROM super_admins) > 1`,
      [person.id],
    ),
    // Before anything is removed: the generation advances, every credential
    // goes, every space they see moves its epoch and is told (R3-S1).
    ...generationStatements(db, person),
    // Delivered from the directory as it stands then: no access, and the
    // tombstone profile (R3-S8).
    enqueueForPersonSpaces(db, person, "access", { personId: person.id }),
    enqueueForPersonSpaces(db, person, "person", { personId: person.id }),
    ...purges.map((p) => p.statement),
    db.prepare("DELETE FROM super_admins WHERE person_id = ?").bind(person.id),
    db.prepare("DELETE FROM shares WHERE email = ?").bind(person.email),
    db.prepare("DELETE FROM invitations WHERE email = ?").bind(person.email),
    db.prepare("DELETE FROM spaces WHERE id IN (SELECT value FROM json_each(?))").bind(personalIds),
    db.prepare("DELETE FROM space_members WHERE person_id = ?").bind(person.id),
    // S-3: owed while the row still names the WorkOS user.
    removal,
    // S-1: the tombstone forgets the subject and email, so their cutoff is
    // kept apart from it: an MCP token issued until now can neither reach
    // nor create a person through either.
    identityCutoff(db, "workos", "SELECT workos_user_id AS v FROM people WHERE id = ?", [
      person.id,
    ]),
    identityCutoff(db, "email", "SELECT email AS v FROM people WHERE id = ?", [person.id]),
    db
      .prepare(
        `UPDATE people SET email = NULL, workos_user_id = NULL, name = 'Deleted person',
             initials = '?', avatar_url = NULL, name_set_at = NULL, picture_choice = NULL,
             deleted_at = ? WHERE id = ?`,
      )
      .bind(now, person.id),
    // The tombstone keeps no picture.
    db.prepare("DELETE FROM person_pictures WHERE person_id = ?").bind(person.id),
  ];
  let results: D1Result[];
  try {
    results = await db.batch(statements);
  } catch (error) {
    if (isGuard(error, "super_admins")) throw new Failure("last_admin", LAST_SUPER_ADMIN);
    if (isGuard(error, "admins")) {
      throw new Failure(
        "last_admin",
        "You're the last admin of a workspace. Make another member an admin first.",
      );
    }
    throw error;
  }

  await deliver(env, [...returnedIds(results, NOTICES), ...purges.map((p) => p.id)]);
  later(removeAgentAccess(env, removalsIn(results[statements.indexOf(removal)])));
}
