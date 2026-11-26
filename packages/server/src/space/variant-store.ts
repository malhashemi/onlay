import {
  encodeVariantEntry,
  replayVariantSets,
  type VariantJournalEntry,
  type VariantSetState,
} from "@onlay/kernel";
import type { Db } from "./ports";
import type { Journal } from "./schema";

/**
 * Variant-set substrate. Event + snapshot upsert in one transaction;
 * `loadAll` reads snapshots, `replayFromEvents` folds the kernel codec as the
 * recovery/test oracle.
 */
export interface VariantStore {
  loadAll(): Map<string, VariantSetState>;
  append(entry: VariantJournalEntry, state: VariantSetState): void;
  replayFromEvents(setId: string): VariantSetState | undefined;
}

const SAFE_VARIANT_SET_ID = /^[0-9a-f-]{1,64}$/i;

export function makeVariantStore(db: Db, journal: Journal): VariantStore {
  return {
    loadAll() {
      const out = new Map<string, VariantSetState>();
      for (const row of db.all<{ json: string }>("SELECT json FROM variant_sets")) {
        const s = JSON.parse(row.json) as VariantSetState;
        out.set(s.setId, s);
      }
      return out;
    },
    append(entry, state) {
      if (!SAFE_VARIANT_SET_ID.test(entry.setId)) return;
      db.transaction(() => {
        journal.append("variant", entry.setId, entry.k, entry.ts, encodeVariantEntry(entry));
        db.run(
          "INSERT INTO variant_sets (id, json, status, created_at, resolved_at) VALUES (?, ?, ?, ?, ?) " +
            "ON CONFLICT(id) DO UPDATE SET json = excluded.json, status = excluded.status, " +
            "resolved_at = excluded.resolved_at",
          state.setId,
          JSON.stringify(state),
          state.status,
          state.createdAt,
          state.resolvedAt ?? null,
        );
      });
    },
    replayFromEvents(setId) {
      return replayVariantSets(journal.eventsFor("variant", setId)).get(setId);
    },
  };
}
