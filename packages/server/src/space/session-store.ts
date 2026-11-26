import { encodeEntry, type JournalEntry, replay, type SessionState } from "@onlay/kernel";
import type { Db } from "./ports";
import type { Journal } from "./schema";

/**
 * Durable sessions (one per extension or web app socket identity). Each
 * change appends a journal event AND upserts the session snapshot; the
 * welcome's `resumedFromSeq` reads it back. Nothing produces sequenced work
 * any more, so the session carries counters and its ack watermark only.
 */
export interface SessionStore {
  get(sessionId: string): SessionState | undefined;
  append(entry: JournalEntry, state: SessionState | undefined): void;
  replayFromEvents(sessionId: string): SessionState | undefined;
}

const SAFE_SESSION_ID = /^[0-9a-f-]{1,64}$/i;

export function makeSessionStore(db: Db, journal: Journal): SessionStore {
  return {
    get(sessionId) {
      if (!SAFE_SESSION_ID.test(sessionId)) return undefined;
      const row = db.get<{ json: string }>("SELECT json FROM sessions WHERE id = ?", sessionId);
      return row ? (JSON.parse(row.json) as SessionState) : undefined;
    },
    append(entry, state) {
      if (!SAFE_SESSION_ID.test(entry.sessionId)) return;
      db.transaction(() => {
        journal.append("session", entry.sessionId, entry.k, entry.ts, encodeEntry(entry));
        if (state) {
          db.run(
            "INSERT INTO sessions (id, json, last_seen_at) VALUES (?, ?, ?) " +
              "ON CONFLICT(id) DO UPDATE SET json = excluded.json, last_seen_at = excluded.last_seen_at",
            state.sessionId,
            JSON.stringify(state),
            state.lastSeenAt,
          );
        }
      });
    },
    replayFromEvents(sessionId) {
      return replay(journal.eventsFor("session", sessionId)).get(sessionId);
    },
  };
}
