/**
 * Shares (spec §6): a member grants one interaction of their space to one
 * email. The holder, signed in and not a member, is a guest who sees only
 * what is shared with them. A guest never shares; a member's email is never
 * shared to (they already see everything).
 */
import { LIMITS, normalizeEmail, type Share } from "@onlay/protocol";
import type { Env } from "../env";
import { memberRole, spaceById } from "./access";
import {
  all,
  guard,
  hasRoomFor,
  IS_MEMBER,
  type PersonRow,
  PICTURE_KEY_COLUMN,
  SPACE_LIMIT,
  summaryOf,
} from "./db";
import { Failure, isGuard, isUnique, notFound } from "./failure";
import { bumpEpoch, deliver, enqueueForEmail, returnedIds } from "./notify";

type Caller = PersonRow & { email: string };

const GUEST_REFUSED = "Only members of this space can share its threads.";

/**
 * The caller must be a member of the space: a stranger gets `not_found`, a
 * guest (who holds a share there) gets `forbidden`.
 */
export async function requireMember(db: D1Database, caller: Caller, spaceId: string) {
  const space = await spaceById(db, spaceId);
  if (space === null) throw notFound();
  if ((await memberRole(db, spaceId, caller.id)) !== null) return space;
  const held = await db
    .prepare("SELECT 1 AS ok FROM shares WHERE space_id = ? AND email = ? LIMIT 1")
    .bind(spaceId, caller.email)
    .first();
  throw held === null ? notFound() : new Failure("forbidden", GUEST_REFUSED);
}

export async function listShares(
  db: D1Database,
  caller: Caller,
  spaceId: string,
  interactionId: string,
): Promise<Share[]> {
  await requireMember(db, caller, spaceId);
  const rows = await all<
    { email: string; created_at: number } & Pick<
      PersonRow,
      "id" | "name" | "initials" | "tint" | "picture_key"
    >
  >(
    db
      .prepare(
        `SELECT s.email, s.created_at, p.id, p.name, p.initials, p.tint, ${PICTURE_KEY_COLUMN}
         FROM shares s JOIN people p ON p.id = s.shared_by
         WHERE s.space_id = ? AND s.interaction_id = ? ORDER BY s.created_at, s.email`,
      )
      .bind(spaceId, interactionId),
  );
  return rows.map((row) => ({
    email: row.email,
    sharedBy: summaryOf(row, { spaceId }),
    createdAt: row.created_at,
  }));
}

const CAP_REACHED = `A thread can be shared with at most ${LIMITS.MAX_SHARES_PER_INTERACTION} people.`;

/** The other person is at the space limit (S-3), refused with reason `space-limit`. */
const holderAtLimit = (email: string) =>
  `${email} is already in ${LIMITS.MAX_SPACES_PER_PERSON} spaces, the limit per person. Ask them to leave a space, then share this thread again.`;

/**
 * Call after `requireMember` and after the space confirmed the interaction
 * exists. The cap, the caller's membership and "not a member's email" are
 * rules inside the inserting batch, with the epoch bump and the space's
 * outbox row, so racing shares can't pass the cap. So is the space limit
 * (S-3): a share that would make its holder a guest of one more space than
 * one person may reach is refused.
 */
export async function createShare(
  env: Env,
  caller: Caller,
  spaceId: string,
  interactionId: string,
  rawEmail: string,
): Promise<void> {
  const db = env.DB;
  const email = normalizeEmail(rawEmail);
  let results: D1Result[];
  try {
    results = await db.batch([
      ...guard(db, "authority", IS_MEMBER, [spaceId, caller.id]),
      ...guard(
        db,
        "not_member",
        `NOT EXISTS (SELECT 1 FROM space_members m JOIN people p ON p.id = m.person_id
           WHERE m.space_id = ? AND p.email = ?)`,
        [spaceId, email],
      ),
      ...guard(
        db,
        "share_cap",
        "(SELECT count(*) FROM shares WHERE space_id = ? AND interaction_id = ?) < ?",
        [spaceId, interactionId, LIMITS.MAX_SHARES_PER_INTERACTION],
      ),
      ...guard(db, "space_limit", hasRoomFor("?1", "?2"), [email, spaceId]),
      db
        .prepare(
          "INSERT INTO shares (space_id, interaction_id, email, shared_by, created_at) VALUES (?, ?, ?, ?, ?)",
        )
        .bind(spaceId, interactionId, email, caller.id, Date.now()),
      bumpEpoch(db, spaceId),
      // The holder, when they have an account: their whole scope and their profile here.
      ...enqueueForEmail(db, spaceId, email),
    ]);
  } catch (error) {
    if (isGuard(error, "share_cap")) throw new Failure("invalid", CAP_REACHED);
    if (isGuard(error, "space_limit")) {
      throw new Failure("conflict", holderAtLimit(email), SPACE_LIMIT);
    }
    if (isGuard(error, "not_member"))
      throw new Failure("conflict", `${email} is already a member.`);
    if (isUnique(error))
      throw new Failure("conflict", `This thread is already shared with ${email}.`);
    if (isGuard(error, "authority")) throw notFound();
    throw error;
  }
  await deliver(env, returnedIds(results, [10, 11]));
}

export async function deleteShare(
  env: Env,
  caller: Caller,
  spaceId: string,
  interactionId: string,
  rawEmail: string,
): Promise<void> {
  const db = env.DB;
  await requireMember(db, caller, spaceId);
  const email = normalizeEmail(rawEmail);
  const exists =
    "EXISTS (SELECT 1 FROM shares WHERE space_id = ?1 AND interaction_id = ?2 AND email = ?3)";
  let removed: unknown[];
  let results: D1Result[];
  try {
    results = await db.batch([
      ...guard(db, "authority", IS_MEMBER, [spaceId, caller.id]),
      // The epoch moves only when a share is really removed.
      db
        .prepare(`UPDATE spaces SET access_epoch = access_epoch + 1 WHERE id = ?1 AND ${exists}`)
        .bind(spaceId, interactionId, email),
      // Notices carry current truth, so a share that wasn't there costs one harmless delivery.
      ...enqueueForEmail(db, spaceId, email),
      db
        .prepare(
          "DELETE FROM shares WHERE space_id = ? AND interaction_id = ? AND email = ? RETURNING email",
        )
        .bind(spaceId, interactionId, email),
    ]);
    removed = results[5]?.results ?? [];
  } catch (error) {
    if (isGuard(error, "authority")) throw notFound();
    throw error;
  }
  if (removed.length === 0) throw notFound();
  await deliver(env, returnedIds(results, [3, 4]));
}
