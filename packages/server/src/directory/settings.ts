/**
 * Deployment administration (spec §6): who may create workspaces, the
 * creators list, and super admins. Super admins always may create.
 */
import {
  type AdminSettingsResponse,
  normalizeEmail,
  type WorkspaceCreationPolicy,
  type WorkspaceCreator,
} from "@onlay/protocol";
import { all, guard, IS_LIVE, PERSON_COLUMNS, type PersonRow, personOf } from "./db";
import { Failure, isGuard } from "./failure";
import { LAST_SUPER_ADMIN, personByEmail } from "./people";

const POLICIES: ReadonlySet<string> = new Set(["super_admins", "listed", "anyone"]);

export const CREATION_REFUSED = "Only the people this Onlay server allows can create workspaces.";

/**
 * The SQL rule "person ?1 with email ?2 (domain ?3) may create a workspace",
 * evaluated inside the creating batch so a policy change cannot race it.
 */
export const MAY_CREATE = `EXISTS (SELECT 1 FROM super_admins WHERE person_id = ?1)
  OR coalesce((SELECT value_json FROM deployment_settings WHERE key = 'workspace_creation'), '"listed"') = '"anyone"'
  OR (coalesce((SELECT value_json FROM deployment_settings WHERE key = 'workspace_creation'), '"listed"') = '"listed"'
      AND EXISTS (SELECT 1 FROM workspace_creators
        WHERE (kind = 'email' AND entry = ?2) OR (kind = 'domain' AND entry = ?3)))`;

export const domainOf = (email: string): string => email.slice(email.lastIndexOf("@") + 1);

export async function isSuperAdmin(db: D1Database, personId: string): Promise<boolean> {
  return (
    (await db
      .prepare("SELECT 1 AS ok FROM super_admins WHERE person_id = ?")
      .bind(personId)
      .first()) !== null
  );
}

export async function mayCreateWorkspace(
  db: D1Database,
  person: { id: string; email: string },
): Promise<boolean> {
  const row = await db
    .prepare(`SELECT (${MAY_CREATE}) AS ok`)
    .bind(person.id, person.email, domainOf(person.email))
    .first<{ ok: number }>();
  return row?.ok === 1;
}

async function policy(db: D1Database): Promise<WorkspaceCreationPolicy> {
  const row = await db
    .prepare("SELECT value_json FROM deployment_settings WHERE key = 'workspace_creation'")
    .first<{ value_json: string }>();
  try {
    const value: unknown = row ? JSON.parse(row.value_json) : "listed";
    return typeof value === "string" && POLICIES.has(value)
      ? (value as WorkspaceCreationPolicy)
      : "listed";
  } catch {
    return "listed";
  }
}

export async function readSettings(db: D1Database): Promise<AdminSettingsResponse> {
  const creators = await all<WorkspaceCreator>(
    db.prepare("SELECT entry, kind FROM workspace_creators ORDER BY kind, entry"),
  );
  const admins = await all<PersonRow>(
    db.prepare(
      `SELECT ${PERSON_COLUMNS} FROM super_admins a JOIN people p ON p.id = a.person_id
       WHERE p.deleted_at IS NULL ORDER BY p.name, p.email`,
    ),
  );
  return {
    workspaceCreation: await policy(db),
    creators: creators.map((row) => ({ entry: row.entry, kind: row.kind })),
    superAdmins: admins.map((row) => personOf(row)),
  };
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const DOMAIN_RE = /^(?!-)[a-z0-9-]{1,63}(\.(?!-)[a-z0-9-]{1,63})+$/;
const CREATOR_INVALID = "Enter an email like name@example.com, or a domain like example.com.";

function cleanCreator(creator: WorkspaceCreator): WorkspaceCreator {
  const entry = creator.entry.trim().toLowerCase().replace(/^@/, "");
  const ok = creator.kind === "email" ? EMAIL_RE.test(entry) : DOMAIN_RE.test(entry);
  if (!ok || entry.length > 254) throw new Failure("invalid", CREATOR_INVALID);
  return { entry, kind: creator.kind };
}

/** `PUT /api/admin/settings`: the policy and the whole creators list, replaced in one batch. */
export async function writeSettings(
  db: D1Database,
  actorId: string,
  workspaceCreation: WorkspaceCreationPolicy,
  creators: WorkspaceCreator[],
): Promise<void> {
  const clean = new Map<string, WorkspaceCreator>();
  for (const creator of creators.map(cleanCreator)) clean.set(creator.entry, creator);
  const now = Date.now();
  await db.batch([
    ...guard(db, "authority", "EXISTS (SELECT 1 FROM super_admins WHERE person_id = ?)", [actorId]),
    db
      .prepare(
        `INSERT INTO deployment_settings (key, value_json, updated_by, updated_at)
         VALUES ('workspace_creation', ?, ?, ?)
         ON CONFLICT (key) DO UPDATE SET value_json = excluded.value_json,
           updated_by = excluded.updated_by, updated_at = excluded.updated_at`,
      )
      .bind(JSON.stringify(workspaceCreation), actorId, now),
    db.prepare("DELETE FROM workspace_creators"),
    ...[...clean.values()].map((creator) =>
      db
        .prepare(
          "INSERT INTO workspace_creators (entry, kind, added_by, created_at) VALUES (?, ?, ?, ?)",
        )
        .bind(creator.entry, creator.kind, actorId, now),
    ),
  ]);
}

/** `POST /api/admin/super-admins`: only someone who has signed in can be named. */
export async function addSuperAdmin(db: D1Database, actorId: string, email: string): Promise<void> {
  const person = await personByEmail(db, normalizeEmail(email));
  if (person === null) {
    throw new Failure(
      "invalid",
      `${normalizeEmail(email)} hasn't signed in to Onlay yet. Have them sign in first.`,
    );
  }
  try {
    await db.batch([
      ...guard(db, "authority", "EXISTS (SELECT 1 FROM super_admins WHERE person_id = ?)", [
        actorId,
      ]),
      // An account deleted since the lookup above is never named.
      ...guard(db, "live", IS_LIVE, [person.id]),
      db
        .prepare(
          "INSERT INTO super_admins (person_id, added_by, created_at) VALUES (?, ?, ?) ON CONFLICT DO NOTHING",
        )
        .bind(person.id, actorId, Date.now()),
    ]);
  } catch (error) {
    if (isGuard(error, "live")) {
      throw new Failure("invalid", `${normalizeEmail(email)} hasn't signed in to onlay yet.`);
    }
    throw error;
  }
}

/** `DELETE /api/admin/super-admins/:personId`: never the last one. */
export async function removeSuperAdmin(db: D1Database, actorId: string, personId: string) {
  if (!(await isSuperAdmin(db, personId)))
    throw new Failure("not_found", "That person isn't a super admin.");
  try {
    await db.batch([
      ...guard(db, "authority", "EXISTS (SELECT 1 FROM super_admins WHERE person_id = ?)", [
        actorId,
      ]),
      db.prepare("DELETE FROM super_admins WHERE person_id = ?").bind(personId),
      ...guard(db, "super_admins", "(SELECT count(*) FROM super_admins) >= 1", []),
    ]);
  } catch (error) {
    if (isGuard(error, "super_admins")) throw new Failure("last_admin", LAST_SUPER_ADMIN);
    throw error;
  }
}
