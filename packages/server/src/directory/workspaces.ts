/**
 * Workspaces (spec §6, dossier's model): creation by policy, names, members
 * and roles, invitations by email, and deletion. Every write that a rule
 * protects carries that rule as a guard row in its own batch, so a race
 * between the check and the write cannot break last-admin, authority or
 * uniqueness.
 */
import {
  INVITATION_WAITING_SPACE_LIMIT,
  type Invitation,
  LIMITS,
  type MemberRole,
  normalizeEmail,
  type SpaceSummary,
  validateWorkspaceName,
  type WorkspaceResponse,
} from "@onlay/protocol";
import type { Env } from "../env";
import { memberRole, type SpaceRow, spaceById } from "./access";
import { newSpaceId } from "./crypto";
import {
  all,
  guard,
  IS_ADMIN,
  IS_LIVE,
  KEEPS_ADMIN,
  memberSpaces,
  PERSON_COLUMNS,
  type PersonRow,
  PICTURE_KEY_COLUMN,
  personOf,
  SPACE_LIMIT,
  summaryOf,
} from "./db";
import { Failure, isGuard, isUnique, notFound } from "./failure";
import {
  bumpEpoch,
  deliver,
  enqueue,
  enqueueForEmail,
  enqueueStanding,
  returnedIds,
} from "./notify";
import { lastAdminMessage } from "./people";
import { CREATION_REFUSED, domainOf, MAY_CREATE, mayCreateWorkspace } from "./settings";

type Caller = PersonRow & { email: string };

const taken = (name: string) => new Failure("conflict", `The name ${name} is taken.`);

const AT_SPACE_LIMIT = `You're already a member of ${LIMITS.MAX_SPACES_PER_PERSON} spaces, the limit per person. Leave a space, then create this workspace.`;

function checkName(raw: string): string {
  const name = raw.trim();
  const check = validateWorkspaceName(name);
  if (!check.ok) {
    throw new Failure(
      "invalid",
      check.reason === "reserved"
        ? check.message
        : "Use 1 to 63 lowercase letters, digits, and hyphens, without a leading hyphen.",
    );
  }
  return name;
}

/** A workspace the caller is a member of; a personal space or a stranger's workspace is `not_found`. */
async function workspaceFor(
  db: D1Database,
  caller: Caller,
  spaceId: string,
): Promise<{ space: SpaceRow; role: MemberRole }> {
  const space = await spaceById(db, spaceId);
  if (space === null || space.kind !== "workspace") throw notFound();
  const role = await memberRole(db, spaceId, caller.id);
  if (role === null) throw notFound();
  return { space, role };
}

async function adminWorkspace(db: D1Database, caller: Caller, spaceId: string): Promise<SpaceRow> {
  const { space, role } = await workspaceFor(db, caller, spaceId);
  if (role !== "admin") throw new Failure("forbidden", `Only admins of ${space.name} can do that.`);
  return space;
}

/** Turns a guard failure from a batch into the rule's refusal. */
function refusal(error: unknown, space: { name: string }): unknown {
  if (isGuard(error, "admins")) return new Failure("last_admin", lastAdminMessage(space.name));
  if (isGuard(error, "authority")) return notFound();
  return error;
}

/** `POST /api/workspaces`: the workspace and its creator's admin membership, in one batch. */
export async function createWorkspace(
  env: Env,
  caller: Caller,
  rawName: string,
): Promise<SpaceSummary> {
  const db = env.DB;
  const name = checkName(rawName);
  if (!(await mayCreateWorkspace(db, caller))) throw new Failure("forbidden", CREATION_REFUSED);
  const id = newSpaceId();
  const now = Date.now();
  const notice = enqueueStanding(db, id, caller.id);
  try {
    await db.batch([
      // A creator deleted since this request authenticated can't strand a workspace.
      ...guard(db, "live", IS_LIVE, [caller.id]),
      ...guard(db, "policy", MAY_CREATE, [caller.id, caller.email, domainOf(caller.email)]),
      // Member spaces only (2-S3): shares others made never block a person's own workspace.
      ...guard(db, "space_limit", `${memberSpaces("?1")} < ?2`, [
        caller.email,
        LIMITS.MAX_SPACES_PER_PERSON,
      ]),
      db
        .prepare(
          `INSERT INTO spaces (id, kind, name, owner_id, created_by, created_at)
           VALUES (?, 'workspace', ?, NULL, ?, ?)`,
        )
        .bind(id, name, caller.id, now),
      db
        .prepare(
          "INSERT INTO space_members (space_id, person_id, role, created_at) VALUES (?, ?, 'admin', ?)",
        )
        .bind(id, caller.id, now),
      ...notice.statements,
    ]);
  } catch (error) {
    if (isGuard(error, "live")) throw new Failure("sign_in_required", "Sign in to continue.");
    if (isGuard(error, "policy")) throw new Failure("forbidden", CREATION_REFUSED);
    if (isGuard(error, "space_limit")) throw new Failure("conflict", AT_SPACE_LIMIT, SPACE_LIMIT);
    if (isUnique(error)) throw taken(name);
    throw error;
  }
  await deliver(env, notice.ids);
  return { id, kind: "workspace", name, role: "admin" };
}

/** `GET /api/workspaces/:id`: members for any member; pending invitations for admins. */
export async function readWorkspace(
  db: D1Database,
  caller: Caller,
  spaceId: string,
): Promise<WorkspaceResponse> {
  const { space, role } = await workspaceFor(db, caller, spaceId);
  const members = await all<PersonRow & { role: MemberRole }>(
    db
      .prepare(
        `SELECT ${PERSON_COLUMNS}, m.role FROM space_members m JOIN people p ON p.id = m.person_id
         WHERE m.space_id = ? ORDER BY m.role = 'member', p.name, p.email`,
      )
      .bind(spaceId),
  );
  const out: WorkspaceResponse = {
    space: { id: space.id, kind: space.kind, name: space.name, role },
    members: members.map((row) => ({ person: personOf(row, { spaceId }), role: row.role })),
  };
  if (role === "admin") {
    const rows = await all<
      { email: string; created_at: number; waiting_since: number | null } & Pick<
        PersonRow,
        "id" | "name" | "initials" | "tint" | "picture_key"
      >
    >(
      db
        .prepare(
          `SELECT i.email, i.created_at, i.waiting_since, p.id, p.name, p.initials, p.tint, ${PICTURE_KEY_COLUMN}
           FROM invitations i JOIN people p ON p.id = i.invited_by
           WHERE i.space_id = ? ORDER BY i.created_at, i.email`,
        )
        .bind(spaceId),
    );
    out.invitations = rows.map(
      (row): Invitation => ({
        email: row.email,
        invitedBy: summaryOf(row, { spaceId }),
        createdAt: row.created_at,
        ...(row.waiting_since !== null ? { waiting: INVITATION_WAITING_SPACE_LIMIT } : {}),
      }),
    );
  }
  return out;
}

/** `PATCH /api/workspaces/:id`: rename (admin). */
export async function renameWorkspace(env: Env, caller: Caller, spaceId: string, rawName: string) {
  const db = env.DB;
  const space = await adminWorkspace(db, caller, spaceId);
  const name = checkName(rawName);
  if (name === space.name) return;
  try {
    await db.batch([
      ...guard(db, "authority", IS_ADMIN, [spaceId, caller.id]),
      db.prepare("UPDATE spaces SET name = ? WHERE id = ?").bind(name, spaceId),
    ]);
  } catch (error) {
    if (isUnique(error)) throw taken(name);
    throw refusal(error, space);
  }
}

/** `DELETE /api/workspaces/:id`: typed name to confirm (admin); the space's data is purged. */
export async function deleteWorkspace(env: Env, caller: Caller, spaceId: string, confirm: string) {
  const db = env.DB;
  const space = await adminWorkspace(db, caller, spaceId);
  if (confirm.trim() !== space.name) throw new Failure("invalid", `Type ${space.name} to confirm.`);
  const notice = enqueue(db, spaceId, "purge", {});
  try {
    await db.batch([
      ...guard(db, "authority", IS_ADMIN, [spaceId, caller.id]),
      db.prepare("DELETE FROM spaces WHERE id = ?").bind(spaceId),
      notice.statement,
    ]);
  } catch (error) {
    throw refusal(error, space);
  }
  await deliver(env, [notice.id]);
}

/**
 * `POST /api/workspaces/:id/invitations`: a person joins at once; an unknown
 * email waits. Which of the two happens is decided inside the one batch, so
 * a sign-in racing the invite can't leave the invitation unclaimed. A person
 * who is already a member of the most spaces one person may join (S-3,
 * 2-S3: guest spaces do not count) is not joined:
 * the invitation waits, marked, and is claimed at a later sign-in with room.
 */
export async function invite(
  env: Env,
  caller: Caller,
  spaceId: string,
  rawEmail: string,
): Promise<{ joined: boolean; waiting?: string }> {
  const db = env.DB;
  const space = await adminWorkspace(db, caller, spaceId);
  const email = normalizeEmail(rawEmail);
  const now = Date.now();
  const live = "SELECT id FROM people WHERE email = ?1 AND deleted_at IS NULL";
  // A live person who is a member of fewer than the most spaces (2-S3; evaluated before they join).
  const roomy = `${live} AND ${memberSpaces("?1")} < ${LIMITS.MAX_SPACES_PER_PERSON}`;
  // Joined by this batch: the guard above ruled out an earlier membership.
  const joinedNow = `SELECT 1 FROM space_members m JOIN people p ON p.id = m.person_id
    WHERE m.space_id = ?2 AND p.email = ?1`;
  let results: D1Result[];
  try {
    results = await db.batch([
      ...guard(db, "authority", IS_ADMIN, [spaceId, caller.id]),
      ...guard(
        db,
        "not_member",
        `NOT EXISTS (SELECT 1 FROM space_members m JOIN people p ON p.id = m.person_id
           WHERE m.space_id = ? AND p.email = ?)`,
        [spaceId, email],
      ),
      // A live person with this email and room: a member row now (live is part of the rule).
      db
        .prepare(
          `INSERT INTO space_members (space_id, person_id, role, created_at)
           SELECT ?2, id, 'member', ?3 FROM (${roomy}) RETURNING person_id`,
        )
        .bind(email, spaceId, now),
      db
        .prepare(
          `UPDATE spaces SET access_epoch = access_epoch + 1
           WHERE id = ?2 AND EXISTS (${joinedNow})`,
        )
        .bind(email, spaceId),
      ...enqueueForEmail(db, spaceId, email),
      // Nobody yet, or a person at the space limit (marked): the invitation waits.
      db
        .prepare(
          `INSERT INTO invitations (space_id, email, invited_by, created_at, waiting_since)
           SELECT ?2, ?1, ?3, ?4, CASE WHEN EXISTS (${live}) THEN ?4 END
           WHERE NOT EXISTS (${joinedNow})
           ON CONFLICT (space_id, email) DO UPDATE SET invited_by = excluded.invited_by,
             created_at = excluded.created_at,
             waiting_since = CASE WHEN excluded.waiting_since IS NULL THEN NULL
               ELSE coalesce(waiting_since, excluded.waiting_since) END
           RETURNING waiting_since`,
        )
        .bind(email, spaceId, caller.id, now),
      db
        .prepare(
          `DELETE FROM invitations WHERE space_id = ?2 AND email = ?1 AND EXISTS (${joinedNow})`,
        )
        .bind(email, spaceId),
    ]);
  } catch (error) {
    if (isGuard(error, "not_member") || isUnique(error)) {
      throw new Failure("conflict", `${email} is already a member.`);
    }
    throw refusal(error, space);
  }
  const joined = (results[4]?.results ?? []).length > 0;
  const held = results[8]?.results[0] as { waiting_since: number | null } | undefined;
  await deliver(env, returnedIds(results, [6, 7]));
  if (!joined && held?.waiting_since != null) {
    return { joined, waiting: INVITATION_WAITING_SPACE_LIMIT };
  }
  return { joined };
}

/** `DELETE /api/workspaces/:id/invitations/:email` (admin). */
export async function uninvite(env: Env, caller: Caller, spaceId: string, rawEmail: string) {
  const db = env.DB;
  const space = await adminWorkspace(db, caller, spaceId);
  const email = normalizeEmail(rawEmail);
  let removed: unknown[];
  try {
    const results = await db.batch([
      ...guard(db, "authority", IS_ADMIN, [spaceId, caller.id]),
      db
        .prepare("DELETE FROM invitations WHERE space_id = ? AND email = ? RETURNING email")
        .bind(spaceId, email),
    ]);
    removed = results[2]?.results ?? [];
  } catch (error) {
    throw refusal(error, space);
  }
  if (removed.length === 0) throw notFound();
}

/** `PATCH /api/workspaces/:id/members/:personId`: change a role (admin); never the last admin away. */
export async function setRole(
  env: Env,
  caller: Caller,
  spaceId: string,
  personId: string,
  role: MemberRole,
) {
  const db = env.DB;
  const space = await adminWorkspace(db, caller, spaceId);
  const current = await memberRole(db, spaceId, personId);
  if (current === null) throw notFound();
  if (current === role) return;
  const notice = enqueueStanding(db, spaceId, personId);
  try {
    await db.batch([
      ...guard(db, "authority", IS_ADMIN, [spaceId, caller.id]),
      db
        .prepare("UPDATE space_members SET role = ? WHERE space_id = ? AND person_id = ?")
        .bind(role, spaceId, personId),
      ...guard(db, "admins", KEEPS_ADMIN, [spaceId]),
      bumpEpoch(db, spaceId),
      ...notice.statements,
    ]);
  } catch (error) {
    throw refusal(error, space);
  }
  await deliver(env, notice.ids);
}

/**
 * `DELETE /api/workspaces/:id/members/:personId`: an admin removes a member,
 * or a member leaves. The workspace keeps at least one admin.
 */
export async function removeMember(env: Env, caller: Caller, spaceId: string, personId: string) {
  const db = env.DB;
  const leaving = personId === caller.id;
  const { space, role } = await workspaceFor(db, caller, spaceId);
  if (!leaving && role !== "admin") {
    throw new Failure("forbidden", `Only admins of ${space.name} can do that.`);
  }
  if ((await memberRole(db, spaceId, personId)) === null) throw notFound();
  const notice = enqueueStanding(db, spaceId, personId);
  try {
    await db.batch([
      ...(leaving ? [] : guard(db, "authority", IS_ADMIN, [spaceId, caller.id])),
      db
        .prepare("DELETE FROM space_members WHERE space_id = ? AND person_id = ?")
        .bind(spaceId, personId),
      ...guard(db, "admins", KEEPS_ADMIN, [spaceId]),
      bumpEpoch(db, spaceId),
      ...notice.statements,
    ]);
  } catch (error) {
    throw refusal(error, space);
  }
  await deliver(env, notice.ids);
}
