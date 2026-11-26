/**
 * The directory's answer to a space asking about the sockets it holds
 * (R3-S2): for each connected (person, credential), whether the credential
 * is still live and of its person's current generation, and the person's
 * whole current scope in the space with the space's epoch, in one batch.
 * Bound into the Durable Object as its `directory` port; the portable space
 * runtime never touches D1 itself.
 */
import { type CallerAccess, LIMITS } from "@onlay/protocol";
import type { ValidationEntry, ValidationResult } from "../space/runtime";

/** Entries per statement (each statement is one JSON bind). */
const PER_STATEMENT = 100;

interface Row {
  person_id: string;
  credential_id: string;
  email: string | null;
  person_generation: number | null;
  credential_generation: number | null;
  role: "admin" | "member" | null;
  shared: string | null;
  epoch: number | null;
}

const SQL = `WITH e AS (
    SELECT json_extract(value, '$.p') AS pid, json_extract(value, '$.c') AS cid,
      json_extract(value, '$.k') AS kind
    FROM json_each(?1))
  SELECT e.pid AS person_id, e.cid AS credential_id, p.email AS email,
    p.credential_generation AS person_generation,
    CASE WHEN e.kind = 'interaction'
      THEN (SELECT s.generation FROM sessions s
            WHERE s.id = e.cid AND s.person_id = e.pid AND s.expires_at > ?3)
      ELSE (SELECT t.generation FROM client_tokens t
            WHERE t.id = e.cid AND t.person_id = e.pid AND t.revoked_at IS NULL)
    END AS credential_generation,
    (SELECT m.role FROM space_members m WHERE m.space_id = ?2 AND m.person_id = e.pid) AS role,
    (SELECT json_group_array(interaction_id) FROM (
       SELECT sh.interaction_id FROM shares sh WHERE sh.space_id = ?2 AND sh.email = p.email
       ORDER BY sh.created_at, sh.interaction_id LIMIT ?4)) AS shared,
    (SELECT access_epoch FROM spaces WHERE id = ?2) AS epoch
  FROM e LEFT JOIN people p ON p.id = e.pid AND p.deleted_at IS NULL AND p.email IS NOT NULL`;

export async function validateConnected(
  db: D1Database,
  spaceId: string,
  entries: ValidationEntry[],
): Promise<ValidationResult[]> {
  if (entries.length === 0) return [];
  const now = Date.now();
  const statements: D1PreparedStatement[] = [];
  for (let i = 0; i < entries.length; i += PER_STATEMENT) {
    const chunk = entries.slice(i, i + PER_STATEMENT).map((e) => ({
      p: e.personId,
      c: e.credentialId,
      k: e.credentialClass,
    }));
    statements.push(
      db.prepare(SQL).bind(JSON.stringify(chunk), spaceId, now, LIMITS.MAX_INTERACTIONS_PER_STATE),
    );
  }
  const results = await db.batch(statements);
  return results.flatMap((result) => (result.results as unknown as Row[]).map(toResult));
}

function toResult(row: Row): ValidationResult {
  const gone = row.email === null || row.person_generation === null;
  let access: CallerAccess | null = null;
  if (!gone && row.epoch !== null) {
    if (row.role !== null) access = { kind: "member", role: row.role };
    else {
      const ids = row.shared ? (JSON.parse(row.shared) as string[]) : [];
      if (ids.length > 0) access = { kind: "guest", interactionIds: ids };
    }
  }
  return {
    personId: row.person_id,
    credentialId: row.credential_id,
    live:
      !gone &&
      row.credential_generation !== null &&
      Number(row.credential_generation) >= Number(row.person_generation),
    personGeneration: gone ? null : Number(row.person_generation),
    access,
    epoch: row.epoch === null ? null : Number(row.epoch),
  };
}
