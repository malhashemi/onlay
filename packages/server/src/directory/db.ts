/**
 * Row shapes and the small helpers every directory module shares: reading
 * rows, turning them into protocol shapes, and guard rows inside batches.
 */
import {
  LIMITS,
  ownPictureUrl,
  type Person,
  type PersonSummary,
  spacePictureUrl,
} from "@onlay/protocol";
import { newId } from "./crypto";

export interface PersonRow {
  id: string;
  email: string | null;
  name: string;
  initials: string;
  tint: string;
  /** The sign-in provider's picture address, as WorkOS last gave it (never sent to a client). */
  avatar_url: string | null;
  workos_user_id: string | null;
  deleted_at: number | null;
  /** When WorkOS last confirmed the verified email; null when never recorded. */
  verified_at?: number | null;
  /** When the person set their own name; null: the provider's (or the email's local part). */
  name_set_at?: number | null;
  /** Which picture shows: null the provider's, `own` their upload, `none` initials. */
  picture_choice?: string | null;
  /** The key of the picture that shows now (`person_pictures`), or null for initials. */
  picture_key?: string | null;
  /** The person's credential generation (migrations/0005) as this row was read. */
  credential_generation?: number;
}

/** The key of the picture a person shows, by their choice (read with the alias `p`). */
export const PICTURE_KEY_COLUMN = `CASE WHEN p.picture_choice = 'none' THEN NULL ELSE
  (SELECT pp.key FROM person_pictures pp WHERE pp.person_id = p.id
     AND pp.source = coalesce(p.picture_choice, 'provider')) END AS picture_key`;

export const PERSON_COLUMNS = `p.id, p.email, p.name, p.initials, p.tint, p.avatar_url, p.workos_user_id,
  p.deleted_at, p.verified_at, p.name_set_at, p.picture_choice, p.credential_generation,
  ${PICTURE_KEY_COLUMN}`;

/** A person's alias: their email's local part (what they were shown by before they had a name). */
export function aliasOf(email: string | null | undefined): string | undefined {
  if (!email) return undefined;
  const local = email.slice(0, email.lastIndexOf("@"));
  return local.length > 0 && local.length <= LIMITS.MAX_ALIAS ? local : undefined;
}

/**
 * Who a picture is drawn for: in a space (`spacePictureUrl`, which that space
 * answers only to a caller who may see the person there), or the person
 * themself (`ownPictureUrl`). Anywhere else, no picture: initials.
 */
export type PictureScope = { spaceId: string } | "self" | undefined;

function avatarFor(
  row: Pick<PersonRow, "id" | "picture_key">,
  scope: PictureScope,
): { avatarUrl?: string } {
  const key = row.picture_key;
  if (!key || scope === undefined) return {};
  return {
    avatarUrl: scope === "self" ? ownPictureUrl(key) : spacePictureUrl(scope.spaceId, row.id, key),
  };
}

/**
 * A live person with their email (as they see themselves, and as admins see
 * members); a tombstone has no email and is never a caller. Their picture is
 * drawn as `scope` allows.
 */
export function personOf(row: PersonRow, scope?: PictureScope): Person {
  return {
    id: row.id,
    email: row.email ?? "",
    name: row.name,
    initials: row.initials,
    tint: row.tint,
    ...avatarFor(row, scope),
  };
}

/** A person as others see them: no email, no alias; a picture as `scope` allows. */
export function summaryOf(
  row: Pick<PersonRow, "id" | "name" | "initials" | "tint"> & { picture_key?: string | null },
  scope?: PictureScope,
): PersonSummary {
  return {
    id: row.id,
    name: row.name,
    initials: row.initials,
    tint: row.tint,
    ...avatarFor(row, scope),
  };
}

export async function all<T>(statement: D1PreparedStatement): Promise<T[]> {
  return (await statement.all<T>()).results;
}

/**
 * A guard row: inserted where the rule must hold, deleted at once. When the
 * rule (a SQL boolean over `binds`) is false as the batch runs, the CHECK on
 * `change_guards` fails and the whole batch rolls back.
 */
export function guard(
  db: D1Database,
  reason:
    | "authority"
    | "admins"
    | "super_admins"
    | "not_member"
    | "policy"
    | "live"
    | "share_cap"
    | "space_limit",
  rule: string,
  binds: unknown[],
): D1PreparedStatement[] {
  // The id (base64url) and reason (a fixed word) are inlined so the rule may
  // use plain or numbered placeholders over `binds` alone.
  const id = newId("g");
  return [
    db
      .prepare(
        `INSERT INTO change_guards (id, reason, ok) SELECT '${id}', '${reason}', coalesce((${rule}), 0)`,
      )
      .bind(...binds),
    db.prepare("DELETE FROM change_guards WHERE id = ?").bind(id),
  ];
}

/** The rule "this workspace keeps at least one admin". */
export const KEEPS_ADMIN =
  "(SELECT count(*) FROM space_members WHERE space_id = ? AND role = 'admin') >= 1";

/** The rule "this person is an admin of this space". */
export const IS_ADMIN =
  "EXISTS (SELECT 1 FROM space_members WHERE space_id = ? AND person_id = ? AND role = 'admin')";

/** The rule "this person exists and is not deleted". */
export const IS_LIVE = "EXISTS (SELECT 1 FROM people WHERE id = ? AND deleted_at IS NULL)";

/** The rule "this person is a member (either role) of this space". */
export const IS_MEMBER =
  "EXISTS (SELECT 1 FROM space_members WHERE space_id = ? AND person_id = ?)";

/** The reason a refusal at the space limit carries (S-3). */
export const SPACE_LIMIT = "space-limit";

/**
 * How many spaces the live person holding an email is a MEMBER of, their
 * personal space included (2-S3): what a person's own acts (creating a
 * workspace, an invitation turning into membership) are limited by, so that
 * shares others make can never take the room they need. `email` is the
 * placeholder the caller binds to the lower-cased email.
 */
export function memberSpaces(email: string): string {
  return `(SELECT count(*) FROM space_members m JOIN people p ON p.id = m.person_id
    WHERE p.email = ${email} AND p.deleted_at IS NULL)`;
}

/**
 * How many spaces the holder of an email reaches (S-3): every space they are
 * a member of (the personal space included) and every space holding a share
 * for the email, counted once. An email without a live person counts the
 * personal space its first sign-in will make. `email` is the placeholder
 * (such as `?1`) the caller binds to the lower-cased email.
 */
function spacesReached(email: string): string {
  return `((SELECT count(*) FROM (
      SELECT m.space_id FROM space_members m JOIN people p ON p.id = m.person_id
        WHERE p.email = ${email} AND p.deleted_at IS NULL
      UNION SELECT space_id FROM shares WHERE email = ${email}))
    + CASE WHEN EXISTS (SELECT 1 FROM people WHERE email = ${email} AND deleted_at IS NULL)
        THEN 0 ELSE 1 END)`;
}

/**
 * The rule a share is held to: the holder of this email reaches fewer than
 * `LIMITS.MAX_SPACES_PER_PERSON` spaces in all (member and guest), or already
 * has standing in `space`. Placeholders as in `spacesReached`.
 */
export function hasRoomFor(email: string, space: string): string {
  return `(${spacesReached(email)} < ${LIMITS.MAX_SPACES_PER_PERSON}
    OR EXISTS (SELECT 1 FROM shares WHERE space_id = ${space} AND email = ${email})
    OR EXISTS (SELECT 1 FROM space_members m JOIN people p ON p.id = m.person_id
      WHERE m.space_id = ${space} AND p.email = ${email}))`;
}
