/**
 * Ending agent access at WorkOS (round 3, S-3). An agent's AuthKit refresh
 * token outlives every credential onlay can revoke, so sign out everywhere
 * and account deletion also remove the WorkOS user's authorized applications
 * (their Connect authorizations). WorkOS documents that deleting one "removes
 * all authorizations and refresh tokens for that user and client", after
 * which the client must authorize again; access tokens already issued stay
 * valid until they expire, and onlay already refuses those by issue time.
 *
 * The request is a row written in the revoking batch itself, so a Worker that
 * stops right after the commit still leaves it owed. It is first tried after
 * the response has gone, through the request's `waitUntil` (2-S2), within a
 * short deadline; whatever fails waits for the every-minute cron, with
 * backoff, and is given up with a log line a day after it was requested.
 * Nothing here can fail or hold up the sign-out.
 *
 * Only what may have been authorized when the removal was asked for (round 4,
 * S-2): an authorization carries no time of its own in the API, but each
 * listed one names its application, whose `created_at` is documented. An
 * application created after the request (a new agent registering itself, as
 * MCP clients do) cannot have been authorized at that time, so it is spared
 * (beyond a minute's allowance for the two clocks).
 * Every other one is removed, an unreadable time included. The whole list is
 * read, page by page through its cursor, before anything counts as done
 * (2-S1): spared ones may come first, and an older client authorized after
 * them comes later. An attempt reads at most `MAX_PAGES` pages: what it read is
 * removed, and when it stopped short of the end the row keeps the cursor it
 * reached (the last spared one, which still exists), so the next attempt
 * continues from there (3-S1). The row is done only when a pass reaches the
 * end of the list. The cursor counts only for the request it was reached
 * under (`list_after_for`); a cursor WorkOS refuses is dropped, and the next
 * attempt starts from page one.
 *
 * The same row ends the WorkOS user's AuthKit sessions too (migrations/0010):
 * a browser AuthKit still knows would sign its person back in without asking.
 * Each try lists the user's active sessions and revokes every one that may
 * have existed when the removal was asked for (one created more than the
 * clock allowance after it is a new sign-in, spared). The first try, right
 * after a sign out everywhere, spares the asking browser's own session, which
 * that browser ends through AuthKit's logout; a retry revokes it like the
 * rest. The row is done only when both the applications and the sessions are.
 * A revoked session leaves the active list, so each pass starts from page one.
 *
 * API: GET  /user_management/users/:user_id/authorized_applications
 *      DELETE /user_management/users/:user_id/authorized_applications/:application_id
 * (https://workos.com/docs/reference/authkit/user, with the API key as Bearer.)
 *      GET  /user_management/users/:user_id/sessions
 *      POST /user_management/sessions/revoke {session_id}
 * (https://workos.com/docs/reference/authkit/session.)
 */
import type { Env } from "../env";

const DEFAULT_BASE = "https://api.workos.com";

/** The one try right after the revoking batch, for all of its removals together. */
const INLINE_DEADLINE_MS = 3_000;
/** Each cron try, per WorkOS user. */
const RETRY_DEADLINE_MS = 5_000;
/** How many owed removals one cron tick tries. */
const RETRIES_PER_TICK = 25;
const FIRST_BACKOFF_MS = 30_000;
const MAX_BACKOFF_MS = 10 * 60_000;
/** A removal still failing this long after it was requested is given up, loudly. */
const GIVE_UP_AFTER_MS = 24 * 60 * 60_000;
/** One list page (WorkOS allows 1 to 100). */
const PAGE_LIMIT = 100;
/**
 * How far WorkOS's clock may run ahead of ours: an application is spared only
 * when it was created more than this after the request, so one made just
 * before it is never spared on a clock difference.
 */
const CLOCK_SKEW_MS = 60_000;
/** List pages read per try (2,000 authorizations); a longer list is retried. */
const MAX_PAGES = 20;

/**
 * Work that runs after the response has gone (the request's `waitUntil`), so
 * the person never waits for it.
 */
export type Later = (work: Promise<void>) => void;

/** `waitUntil` of the request, or, without one, work left to finish on its own. */
export function laterOf(ctx?: { waitUntil(promise: Promise<unknown>): void }): Later {
  return ctx ? (work) => ctx.waitUntil(work) : (work) => void work;
}

export interface AccessRemoval {
  workos_user_id: string;
  requested_at: number;
  attempts: number;
  /** Where the last attempt stopped in the list, for the request `list_after_for` (3-S1). */
  list_after?: string | null;
  list_after_for?: number | null;
}

/** The columns an attempt reads. */
const REMOVAL_COLUMNS = "workos_user_id, requested_at, attempts, list_after, list_after_for";

/**
 * For the revoking batch, before anything forgets the person's WorkOS user:
 * one owed removal for it (none for a person who never signed in through
 * WorkOS). A repeat restarts the row. RETURNING the row, for `removeAgentAccess`.
 */
export function agentAccessRemoval(db: D1Database, personId: string): D1PreparedStatement {
  // Not due for the cron until the inline try (`removeAgentAccess`, right
  // after the response) has had its time: the cron must not revoke the asking
  // browser's AuthKit session while that browser is still on its way through
  // AuthKit's logout.
  const now = Date.now();
  return db
    .prepare(
      `INSERT INTO workos_access_removals (workos_user_id, requested_at, attempts, next_attempt_at)
       SELECT workos_user_id, ?2, 0, ?3 FROM people WHERE id = ?1 AND workos_user_id IS NOT NULL
       ON CONFLICT (workos_user_id) DO UPDATE SET requested_at = excluded.requested_at,
         attempts = 0, next_attempt_at = excluded.next_attempt_at,
         list_after = NULL, list_after_for = NULL
       RETURNING ${REMOVAL_COLUMNS}`,
    )
    .bind(personId, now, now + INLINE_TRY_HOLD_MS);
}

/** How long a new removal waits before the cron may take it (the inline try runs first). */
export const INLINE_TRY_HOLD_MS = 30_000;

/** The removals `agentAccessRemoval` wrote, from its result. */
export function removalsIn(result: D1Result | undefined): AccessRemoval[] {
  return ((result?.results ?? []) as AccessRemoval[]).filter(
    (row) => typeof row.workos_user_id === "string",
  );
}

/**
 * After the revoking batch commits (through `Later`): one try, within a short
 * deadline, sparing `ownSession` (the asking browser's AuthKit session, which
 * it ends itself). Never throws.
 */
export async function removeAgentAccess(
  env: Env,
  removals: AccessRemoval[],
  ownSession?: string,
): Promise<void> {
  if (removals.length === 0) return;
  for (const removal of removals) await attempt(env, removal, INLINE_DEADLINE_MS, ownSession);
}

/** The cron's retry of the removals due now. Never throws. */
export async function retryAgentAccessRemovals(env: Env): Promise<void> {
  let due: AccessRemoval[];
  try {
    due = (
      await env.DB.prepare(
        `SELECT ${REMOVAL_COLUMNS} FROM workos_access_removals
         WHERE next_attempt_at <= ? ORDER BY next_attempt_at LIMIT ?`,
      )
        .bind(Date.now(), RETRIES_PER_TICK)
        .all<AccessRemoval>()
    ).results;
  } catch (error) {
    console.error("workos access removals failed to load", error);
    return;
  }
  for (const removal of due) await attempt(env, removal, RETRY_DEADLINE_MS);
}

/**
 * One try; the row goes once both passes are done, or backs off, or is given
 * up after a day. The two passes (the sessions, then the applications) each
 * have `deadlineMs` of their own, so a slow one never starves the other.
 */
async function attempt(
  env: Env,
  removal: AccessRemoval,
  deadlineMs: number,
  ownSession?: string,
): Promise<void> {
  const user = removal.workos_user_id;
  // Only the row this try was for: a newer revocation's row stays owed.
  const mine = "workos_user_id = ? AND requested_at = ?";
  let failure: unknown = "WorkOS refused";
  // A cursor reached under an earlier request (or by a Worker that kept none) is not this one's.
  const resume =
    removal.list_after_for === removal.requested_at ? (removal.list_after ?? null) : null;
  // The sessions first, on their own: a failure there still lets the applications go.
  let sessionsDone = false;
  let sessionsFailure: unknown = null;
  try {
    sessionsDone = await revokeSessions(
      env,
      user,
      removal.requested_at,
      ownSession,
      AbortSignal.timeout(deadlineMs),
    );
    if (!sessionsDone) {
      sessionsFailure = new Error(
        "WorkOS sessions not all revoked in this attempt; the next attempt revokes the rest",
      );
    }
  } catch (error) {
    sessionsFailure = error;
  }
  try {
    const pass = await removeAuthorizedApplications(
      env,
      user,
      removal.requested_at,
      resume,
      AbortSignal.timeout(deadlineMs),
    );
    if (pass.complete && sessionsDone) {
      await env.DB.prepare(`DELETE FROM workos_access_removals WHERE ${mine}`)
        .bind(user, removal.requested_at)
        .run();
      return;
    }
    if (pass.complete) {
      failure = sessionsFailure;
    } else {
      // Stopped at its page cap: the next attempt continues where this one stopped.
      await keepCursor(env, removal, pass.resumeAfter);
      failure = new Error(
        `WorkOS listed more than ${MAX_PAGES} pages of authorized applications; the next attempt continues from there`,
      );
    }
  } catch (error) {
    failure = error;
    if (error instanceof CursorRefused) await keepCursor(env, removal, null).catch(() => {});
  }
  try {
    const attempts = removal.attempts + 1;
    const now = Date.now();
    if (now - removal.requested_at >= GIVE_UP_AFTER_MS) {
      console.error(
        `GAVE UP workos access removal for ${user} after ${attempts} attempts over a day: its agents can still refresh, and its browsers stay signed in to AuthKit, until its authorized applications are removed and its sessions revoked in WorkOS`,
        failure,
      );
      await env.DB.prepare(`DELETE FROM workos_access_removals WHERE ${mine}`)
        .bind(user, removal.requested_at)
        .run();
      return;
    }
    console.error(`workos access removal for ${user} failed (attempt ${attempts})`, failure);
    const wait = Math.min(MAX_BACKOFF_MS, FIRST_BACKOFF_MS * 2 ** Math.min(attempts - 1, 20));
    await env.DB.prepare(
      `UPDATE workos_access_removals SET attempts = ?, next_attempt_at = ? WHERE ${mine}`,
    )
      .bind(attempts, now + wait, user, removal.requested_at)
      .run();
  } catch (counted) {
    console.error(`workos access removal for ${user}: attempt not counted`, counted);
  }
}

/** The row remembers where in the list the next attempt starts (null: page one). */
async function keepCursor(env: Env, removal: AccessRemoval, after: string | null): Promise<void> {
  await env.DB.prepare(
    `UPDATE workos_access_removals SET list_after = ?, list_after_for = requested_at
     WHERE workos_user_id = ? AND requested_at = ?`,
  )
    .bind(after, removal.workos_user_id, removal.requested_at)
    .run();
}

/** WorkOS would not list from the cursor a past attempt kept. */
class CursorRefused extends Error {}

function base(env: Env): string {
  return (env.WORKOS_API_BASE ?? DEFAULT_BASE).replace(/\/+$/, "");
}

/**
 * One page of the user's authorized applications: the ids of those that may
 * have been authorized at `since` (epoch ms), all but those whose application
 * was created after it; the list id of the last one spared (it stays, so it
 * can be a cursor); and the cursor of the next page (null: the last). Null if
 * the page is malformed.
 */
function applicationsToRemove(
  body: unknown,
  since: number,
): { remove: string[]; lastKept: string | null; after: string | null } | null {
  const page = body as { data?: unknown; list_metadata?: { after?: unknown } } | null;
  const data = page?.data;
  if (!Array.isArray(data)) return null;
  const after = page?.list_metadata?.after ?? null;
  if (after !== null && (typeof after !== "string" || after.length === 0)) return null;
  const remove: string[] = [];
  let lastKept: string | null = null;
  for (const item of data) {
    const listed = item as {
      id?: unknown;
      application?: { id?: unknown; created_at?: unknown };
    } | null;
    const app = listed?.application;
    const id = app?.id;
    if (typeof id !== "string" || id.length === 0) return null;
    const created = typeof app?.created_at === "string" ? Date.parse(app.created_at) : Number.NaN;
    // Created after the request: not authorized at it. Unknown: it may have been.
    if (Number.isFinite(created) && created > since + CLOCK_SKEW_MS) {
      if (typeof listed?.id !== "string" || listed.id.length === 0) return null;
      lastKept = listed.id;
      continue;
    }
    remove.push(id);
  }
  return { remove, lastKept, after };
}

/** One pass over the list: done, or stopped at the page cap with where to continue. */
type Pass = { complete: true } | { complete: false; resumeAfter: string | null };

/**
 * Deletes the applications the WorkOS user may have authorized at `since`
 * that one pass reads, from `resume` (null: the first page) on. Complete once
 * the pass reached the end of the list and deleted those on it (or WorkOS no
 * longer knows the user, which removes its authorizations too); otherwise,
 * after `MAX_PAGES` pages, where the next pass continues. Throws when WorkOS
 * refuses or answers oddly (`CursorRefused` for the kept cursor).
 */
async function removeAuthorizedApplications(
  env: Env,
  workosUserId: string,
  since: number,
  resume: string | null,
  signal: AbortSignal,
): Promise<Pass> {
  if (!env.WORKOS_API_KEY) throw new Error("WORKOS_API_KEY is not set");
  const headers = { Authorization: `Bearer ${env.WORKOS_API_KEY}`, Accept: "application/json" };
  const userPath = `${base(env)}/user_management/users/${encodeURIComponent(workosUserId)}/authorized_applications`;
  // The whole list first, then the deletes: a cursor never names a deleted item.
  const remove: string[] = [];
  let after: string | null = resume;
  let lastKept: string | null = resume;
  let complete = false;
  for (let page = 0; page < MAX_PAGES; page++) {
    const query = new URLSearchParams({ limit: String(PAGE_LIMIT), order: "asc" });
    if (after !== null) query.set("after", after);
    const listed = await fetch(`${userPath}?${query}`, { headers, signal });
    // From the kept cursor, any refusal (a 404 too) is about the cursor, not the user.
    if (page === 0 && resume !== null && !listed.ok) {
      await listed.body?.cancel();
      throw new CursorRefused(`WorkOS refused the kept list cursor with ${listed.status}`);
    }
    // Only the first, cursorless page can say WorkOS has no such user.
    if (listed.status === 404 && page === 0 && after === null) {
      await listed.body?.cancel();
      return { complete: true };
    }
    if (!listed.ok) {
      await listed.body?.cancel();
      // A later page refused: what earlier pages listed is still removed below,
      // and the rest stays owed.
      if (page > 0) break;
      throw new Error(`WorkOS listed authorized applications with ${listed.status}`);
    }
    const read = applicationsToRemove(await listed.json(), since);
    if (read === null) throw new Error("WorkOS listed authorized applications in an unknown shape");
    remove.push(...read.remove);
    if (read.lastKept !== null) lastKept = read.lastKept;
    after = read.after;
    if (after === null) {
      complete = true;
      break;
    }
  }
  for (const id of remove) {
    const deleted = await fetch(`${userPath}/${encodeURIComponent(id)}`, {
      method: "DELETE",
      headers,
      signal,
    });
    await deleted.body?.cancel();
    // 404: already gone (another try got there first).
    if (!deleted.ok && deleted.status !== 404) {
      throw new Error(`WorkOS deleted an authorized application with ${deleted.status}`);
    }
  }
  // Removed what was read. The next pass starts past the last one spared, or,
  // with none spared, from page one: everything this pass read is gone.
  return complete ? { complete: true } : { complete: false, resumeAfter: lastKept };
}

/**
 * Revokes the WorkOS user's AuthKit sessions that may have existed at `since`
 * (epoch ms): every listed one but `spare` and those created more than the
 * clock allowance after it. Page by page: each page's sessions are revoked as
 * soon as it is read, so a deadline or a refusal never loses what was done.
 * Revoked sessions leave the active list, so the next page is read past the
 * last one kept on this page (from page one when none was). True once the
 * list was read to its end (or WorkOS no longer knows the user, at the first
 * page); false when it stopped at the page cap or a later page was refused,
 * for the next pass, which starts from page one. Throws when WorkOS refuses
 * a revocation, answers the first page oddly, or the deadline passes.
 */
async function revokeSessions(
  env: Env,
  workosUserId: string,
  since: number,
  spare: string | undefined,
  signal: AbortSignal,
): Promise<boolean> {
  if (!env.WORKOS_API_KEY) throw new Error("WORKOS_API_KEY is not set");
  const auth = { Authorization: `Bearer ${env.WORKOS_API_KEY}`, Accept: "application/json" };
  const listPath = `${base(env)}/user_management/users/${encodeURIComponent(workosUserId)}/sessions`;
  let after: string | null = null;
  for (let page = 0; page < MAX_PAGES; page++) {
    const query = new URLSearchParams({ limit: String(PAGE_LIMIT), order: "asc" });
    if (after !== null) query.set("after", after);
    const listed = await fetch(`${listPath}?${query}`, { headers: auth, signal });
    if (!listed.ok) {
      await listed.body?.cancel();
      // The user is unknown only when the very first page says so; a refused
      // later page leaves the rest for the next pass.
      if (listed.status === 404 && page === 0 && after === null) return true;
      if (page > 0) return false;
      throw new Error(`WorkOS listed sessions with ${listed.status}`);
    }
    const read = sessionsToRevoke(await listed.json(), since, spare);
    if (read === null) throw new Error("WorkOS listed sessions in an unknown shape");
    for (const id of read.revoke) {
      const revoked = await fetch(`${base(env)}/user_management/sessions/revoke`, {
        method: "POST",
        headers: { ...auth, "Content-Type": "application/json" },
        body: JSON.stringify({ session_id: id }),
        signal,
      });
      await revoked.body?.cancel();
      // 404: already gone (it ended, or another try got there first).
      if (!revoked.ok && revoked.status !== 404) {
        throw new Error(`WorkOS revoked a session with ${revoked.status}`);
      }
    }
    if (read.after === null) return true;
    after = read.lastKept;
  }
  return false;
}

/**
 * One page of the user's sessions: the ids to revoke (all but `spare` and
 * those created after `since`, beyond the clock allowance; an unreadable time
 * may have been before it) and the next page's cursor (null: the last). Null
 * if the page is malformed.
 */
function sessionsToRevoke(
  body: unknown,
  since: number,
  spare: string | undefined,
): { revoke: string[]; lastKept: string | null; after: string | null } | null {
  const page = body as { data?: unknown; list_metadata?: { after?: unknown } } | null;
  const data = page?.data;
  if (!Array.isArray(data)) return null;
  const after = page?.list_metadata?.after ?? null;
  if (after !== null && (typeof after !== "string" || after.length === 0)) return null;
  const revoke: string[] = [];
  // The last one left in the list (spared, ended or newer): the next page's cursor.
  let lastKept: string | null = null;
  for (const item of data) {
    const session = item as { id?: unknown; created_at?: unknown; ended_at?: unknown } | null;
    const id = session?.id;
    if (typeof id !== "string" || id.length === 0) return null;
    const created =
      typeof session?.created_at === "string" ? Date.parse(session.created_at) : Number.NaN;
    const ended = typeof session?.ended_at === "string" && session.ended_at.length > 0;
    if (id === spare || ended || (Number.isFinite(created) && created > since + CLOCK_SKEW_MS)) {
      lastKept = id;
      continue;
    }
    revoke.push(id);
  }
  return { revoke, lastKept, after };
}
