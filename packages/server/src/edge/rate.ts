/**
 * Rate limits (spec §6): fixed one-minute windows in `rate_counters`,
 * dossier's pattern. One row per bucket; moving to a new window resets it.
 * Reads are never limited.
 */
import { Failure } from "../directory/failure";

/** Sign-in starts per IP per minute. */
export const SIGN_IN_PER_MINUTE = 10;
/** Writes per person per minute. */
export const WRITES_PER_MINUTE = 120;
/** MCP calls per person per minute. */
export const MCP_PER_MINUTE = 240;

const RATE_LIMITED = "Too many requests. Wait a minute, then try again.";

/** Counts one hit in `bucket`'s current window; `rate_limited` once it passes `max`. */
export async function limit(db: D1Database, bucket: string, max: number): Promise<void> {
  const window = Math.floor(Date.now() / 60_000) * 60_000;
  const row = await db
    .prepare(
      `INSERT INTO rate_counters (key, window_start, count) VALUES (?1, ?2, 1)
       ON CONFLICT (key) DO UPDATE SET
         count = CASE WHEN window_start = ?2 THEN count + 1 ELSE 1 END,
         window_start = ?2
       RETURNING count`,
    )
    .bind(bucket, window)
    .first<{ count: number }>();
  if ((row?.count ?? 0) > max) throw new Failure("rate_limited", RATE_LIMITED);
}
