import {
  encodeInteractionEntry,
  type InteractionJournalEntry,
  type InteractionState,
  replayInteractions,
} from "@onlay/kernel";
import { LIMITS } from "@onlay/protocol";
import type { Db } from "./ports";
import type { Journal } from "./schema";

/**
 * Interaction substrate — the space's core store. Event + snapshot upsert in
 * one transaction; `loadAll` reads snapshots (the wake path),
 * `replayFromEvents` folds the kernel codec as the recovery/test oracle.
 */
export interface InteractionStore {
  loadAll(): Map<string, InteractionState>;
  /** Journals the entry with its resulting snapshot; returns the event's sequence number. */
  append(entry: InteractionJournalEntry, state: InteractionState): number;
  replayFromEvents(interactionId: string): InteractionState | undefined;
}

const SAFE_ID = /^[0-9a-f-]{1,64}$/i;

export function makeInteractionStore(db: Db, journal: Journal): InteractionStore {
  return {
    loadAll() {
      const out = new Map<string, InteractionState>();
      for (const row of db.all<{ json: string }>("SELECT json FROM interactions")) {
        const s = JSON.parse(row.json) as InteractionState;
        out.set(s.id, s);
      }
      return out;
    },
    append(entry, state) {
      if (!SAFE_ID.test(entry.id)) return 0;
      return db.transaction(() => {
        const seq = journal.append(
          "interaction",
          entry.id,
          entry.k,
          entry.ts,
          encodeInteractionEntry(entry),
        );
        db.run(
          "INSERT INTO interactions (id, kind, url, state, author_id, created_at, resolved_at, json) " +
            "VALUES (?, ?, ?, ?, ?, ?, ?, ?) " +
            "ON CONFLICT(id) DO UPDATE SET kind = excluded.kind, url = excluded.url, " +
            "state = excluded.state, author_id = excluded.author_id, " +
            "resolved_at = excluded.resolved_at, json = excluded.json",
          state.id,
          state.kind,
          state.url,
          state.state,
          state.authorId,
          state.createdAt,
          state.resolvedAt ?? null,
          JSON.stringify(state),
        );
        return seq;
      });
    },
    replayFromEvents(interactionId) {
      return replayInteractions(
        journal.eventsFor("interaction", interactionId),
        LIMITS.MAX_THREAD_MSGS,
      ).get(interactionId);
    },
  };
}
