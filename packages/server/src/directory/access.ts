/**
 * A person's standing in one space (spec §5.1): a member with a role, a guest
 * holding at least one share there, or nothing — which callers answer as
 * `not_found`.
 */
import { type CallerAccess, LIMITS, type SpaceKind } from "@onlay/protocol";
import { all } from "./db";

export interface SpaceRow {
  id: string;
  kind: SpaceKind;
  name: string;
  owner_id: string | null;
}

/** What a personal space is called wherever it is shown; D1 keeps storing `personal`. */
const PERSONAL_SPACE_NAME = "Personal";

/** A space's display name: its own for a workspace, `Personal` for a personal space. */
export function displayName(space: { kind: SpaceKind; name: string }): string {
  return space.kind === "personal" ? PERSONAL_SPACE_NAME : space.name;
}

export async function spaceById(db: D1Database, spaceId: string): Promise<SpaceRow | null> {
  return db
    .prepare("SELECT id, kind, name, owner_id FROM spaces WHERE id = ?")
    .bind(spaceId)
    .first<SpaceRow>();
}

export async function memberRole(
  db: D1Database,
  spaceId: string,
  personId: string,
): Promise<"admin" | "member" | null> {
  const row = await db
    .prepare("SELECT role FROM space_members WHERE space_id = ? AND person_id = ?")
    .bind(spaceId, personId)
    .first<{ role: "admin" | "member" }>();
  return row?.role ?? null;
}

/**
 * Every space a person can see, members' first, with the role they hold
 * there. The owner sees their personal space as `Personal`; a guest sees
 * someone else's personal space under its owner's name.
 */
export async function spacesOf(
  db: D1Database,
  person: { id: string; email: string },
): Promise<{ id: string; kind: SpaceKind; name: string; role: "admin" | "member" | "guest" }[]> {
  const rows = await all<{ id: string; kind: SpaceKind; name: string; role: string }>(
    db
      .prepare(
        `SELECT id, kind, name, role FROM (
           SELECT s.id, s.kind,
             CASE WHEN s.kind = 'personal' THEN ?3 ELSE s.name END AS name,
             m.role, 0 AS ord FROM space_members m
             JOIN spaces s ON s.id = m.space_id WHERE m.person_id = ?1
           UNION ALL
           SELECT s.id, s.kind,
             CASE WHEN s.kind = 'personal' THEN coalesce(o.name, s.name) ELSE s.name END,
             'guest', 1 FROM spaces s
             LEFT JOIN people o ON o.id = s.owner_id
             WHERE s.id IN (SELECT space_id FROM shares WHERE email = ?2)
               AND s.id NOT IN (SELECT space_id FROM space_members WHERE person_id = ?1)
         ) ORDER BY ord, kind = 'workspace', name`,
      )
      .bind(person.id, person.email, PERSONAL_SPACE_NAME),
  );
  return rows.map((row) => ({
    id: row.id,
    kind: row.kind,
    name: row.name,
    role: row.role as "admin" | "member" | "guest",
  }));
}

/** A space as the edge forwards to it: its facts, the caller's access there, and its epoch. */
export interface SpaceStanding {
  space: SpaceRow;
  access: CallerAccess;
  /** The space's access epoch, read with `access`. */
  epoch: number;
  /** The space still has outbox rows to deliver. */
  pending: boolean;
  /** The person's credential generation, read with the rest (an agent caller's `credentialGeneration`). */
  personGeneration: number;
}

interface StandingRow {
  id: string;
  kind: SpaceKind;
  name: string;
  owner_id: string | null;
  access_epoch: number;
  role: "admin" | "member" | null;
  shared: string | null;
  pending: number;
  person_generation: number;
}

/**
 * Who a standing is read for, as SQL selecting one row of `id, email` (a live
 * person with an email) from binds numbered from ?3: a person by id, or the
 * live credential a request presented (round 2, S1).
 */
export interface PersonSource {
  /** `SELECT p.id, p.email, p.credential_generation AS generation … FROM … people p …`, binds from ?3. */
  who: string;
  binds: unknown[];
}

/** A live person by id, with the email they hold now. */
function personSource(personId: string): PersonSource {
  return {
    who: "SELECT p.id, p.email, p.credential_generation AS generation FROM people p WHERE p.id = ?3 AND p.deleted_at IS NULL AND p.email IS NOT NULL",
    binds: [personId],
  };
}

/** The standings statement for `source`, all spaces or `only` these. */
export function standingsStatement(
  db: D1Database,
  source: PersonSource,
  only?: string[],
): D1PreparedStatement {
  return db
    .prepare(
      `WITH who AS (${source.who})
       SELECT s.id, s.kind, s.name, s.owner_id, s.access_epoch, m.role, who.generation AS person_generation,
         CASE WHEN m.role IS NULL THEN (
           SELECT json_group_array(interaction_id) FROM (
             SELECT interaction_id FROM shares sh WHERE sh.space_id = s.id AND sh.email = who.email
             ORDER BY sh.created_at, sh.interaction_id LIMIT ?1)
         ) END AS shared,
         EXISTS (SELECT 1 FROM space_outbox ob WHERE ob.space_id = s.id) AS pending
       FROM who CROSS JOIN spaces s
       LEFT JOIN space_members m ON m.space_id = s.id AND m.person_id = who.id
       WHERE (m.person_id IS NOT NULL OR s.id IN (SELECT space_id FROM shares WHERE email = who.email))
         AND (?2 IS NULL OR s.id IN (SELECT value FROM json_each(?2)))
       ORDER BY m.role IS NULL, s.kind = 'workspace', s.name`,
    )
    .bind(
      LIMITS.MAX_INTERACTIONS_PER_STATE,
      only === undefined ? null : JSON.stringify(only),
      ...source.binds,
    );
}

/** Standings from the rows `standingsStatement` returned (no standing: left out). */
export function standingsFrom(rows: StandingRow[]): SpaceStanding[] {
  const out: SpaceStanding[] = [];
  for (const row of rows) {
    let access: CallerAccess | null = null;
    if (row.role !== null) access = { kind: "member", role: row.role };
    else {
      const ids = row.shared ? (JSON.parse(row.shared) as string[]) : [];
      if (ids.length > 0) access = { kind: "guest", interactionIds: ids };
    }
    if (access === null) continue;
    out.push({
      space: { id: row.id, kind: row.kind, name: row.name, owner_id: row.owner_id },
      access,
      epoch: Number(row.access_epoch),
      pending: Number(row.pending) === 1,
      personGeneration: Number(row.person_generation),
    });
  }
  return out;
}

/**
 * The person's standing in each of these spaces (all they see when `only` is
 * absent), in ONE query that also re-reads the person: live, with the email
 * they hold now. Facts, role or shared interactions, the access epoch read
 * with them, and whether the space is owed an outbox delivery. Spaces where
 * they have no standing (or a person no longer live) give nothing.
 */
async function standingsOf(
  db: D1Database,
  person: { id: string },
  only?: string[],
): Promise<SpaceStanding[]> {
  return standingsFrom(
    await all<StandingRow>(standingsStatement(db, personSource(person.id), only)),
  );
}

/** The person's standing in one space, or null (no access: `not_found`). */
export async function standingIn(
  db: D1Database,
  person: { id: string },
  spaceId: string,
): Promise<SpaceStanding | null> {
  return (await standingsOf(db, person, [spaceId]))[0] ?? null;
}
